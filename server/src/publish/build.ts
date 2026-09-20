/**
 * Сборка публичной страницы из того, что записала комната.
 *
 * Здесь два обещания, и оба держатся перечислением, а не вычитанием.
 *
 * ЧТО ПОПАДАЕТ НАРУЖУ — белый список полей. У документа четыре корня, и
 * тетрадь только один из них: `chat` несёт имена всех, кто спрашивал оракула,
 * `terminal` — всё, что кто-нибудь напечатал в оболочку. Внутри ячейки то же
 * самое: `runBy` и `runById` стоят на каждой запущенной. Поле, добавленное в
 * тетрадь завтра, не должно оказаться на публичной странице само собой —
 * поэтому список полей здесь написан буквами.
 *
 * ЧТО МОЖЕТ БЫТЬ ШАГОМ — только версия, которая разворачивается хотя бы в одну
 * ячейку. Это не осторожность: у комнат, записанных старой сборкой, база
 * истории снята с пустого документа, и всё до починки разворачивается в ноль.
 * Пустая страница у студента невозможна не потому, что о ней позаботились, а
 * потому, что такой шаг не собирается.
 */
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import { readNotebook, type CellOutput, type CellSnapshot } from '@shared/notebook'
import {
  BLOB_MIN_BYTES,
  BLOB_PREFIX,
  SPILL_MIMES,
  spillEncoding,
  type PublicCell,
  type SkipReason,
} from '@shared/publish'
import { readBlob, roomOfDoc } from '../blobs.js'
import {
  applyEdits,
  findAttachmentRefs,
  findWorkspaceImages,
  shaOfAttachment,
  type TextEdit,
} from '@shared/images'
import { readBytes } from '../workspace.js'
import { openReplay } from './replay.js'

/** Крупные куски выводов, вынесенные по хэшу. Наполняется по ходу сборки. */
export interface BlobBag {
  /**
   * Кусок набора вывода — в том виде, в каком его прислало ядро.
   *
   * Кодировку спрашивает `spillEncoding`: картинка приходит base64, фигура
   * plotly — текстом JSON. Разбирать текст как base64 — это мусор в записи и
   * пустая рамка на странице, ровно та беда, из-за которой SVG сюда не кладут.
   */
  put(mime: string, value: string): string
  /** То же самое, но байтами: у комнаты картинка уже раскодирована. */
  putBytes(mime: string, body: Buffer): string
  all(): { hash: string; mime: string; body: Buffer }[]
}

export function newBlobBag(): BlobBag {
  const seen = new Map<string, { mime: string; body: Buffer }>()
  const keep = (mime: string, body: Buffer): string => {
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 32)
    if (!seen.has(hash)) seen.set(hash, { mime, body })
    return `${BLOB_PREFIX}${hash}`
  }
  return {
    put(mime, value) {
      return keep(mime, Buffer.from(value, spillEncoding(mime)))
    },
    putBytes: keep,
    all() {
      return [...seen].map(([hash, v]) => ({
        hash,
        mime: v.mime,
        body: v.body,
      }))
    },
  }
}

/**
 * Вывод в том виде, в каком он ляжет на страницу.
 *
 * Крупное содержимое уезжает в отдельную запись: график matplotlib — это
 * base64 на сотни килобайт, одинаковый во всех шагах, где его ячейка не
 * менялась. Шесть шагов давали бы шесть копий одной картинки.
 *
 * Уезжает только то, что перечислено в `SPILL_MIMES`: растровые картинки и
 * фигура plotly. `image/svg+xml` в этом списке нет намеренно — он и так весит
 * меньше картинки, ради которой вынос заводился.
 */
function projectOutput(output: CellOutput, blobs: BlobBag, sessionId: string | null): CellOutput {
  if (output.kind === 'stream') return { kind: 'stream', name: output.name, text: output.text }
  if (output.kind === 'error') {
    return {
      kind: 'error',
      ename: output.ename,
      evalue: output.evalue,
      traceback: output.traceback,
    }
  }
  const data: Record<string, string> = {}
  for (const [mime, value] of Object.entries(output.data)) {
    data[mime] =
      typeof value === 'string' && value.length >= BLOB_MIN_BYTES && SPILL_MIMES.has(mime)
        ? blobs.put(mime, value)
        : value
  }
  /*
   * Картинка, вынесенная из документа комнаты, переезжает в публикацию сама.
   *
   * Публикация — отдельный предмет с собственным сроком жизни: она переживает
   * и удаление семинара (`orphanPublication`), и выгрузку на статический
   * хостинг, где полки комнаты нет вовсе. Поэтому байты не остаются лежать
   * там, откуда их взяли, а копируются в записи публикации — ровно так же, как
   * копировалась бы base64-картинка, лежавшая в документе.
   *
   * Не нашлись (комнату удалили между ссылкой и сборкой) — записи в наборе
   * просто не будет: страница покажет `text/plain`, а не битую рамку.
   */
  for (const blob of output.blobs ?? []) {
    if (data[blob.mime] !== undefined) continue
    const body = sessionId ? readBlob(sessionId, blob.sha) : null
    if (body) data[blob.mime] = blobs.putBytes(blob.mime, body)
  }
  /*
   * Перечислением, а не спредом: у вывода поля тоже добавляются со временем —
   * кто его получил, из какой попытки консилиума он пришёл, — и `{ ...output }`
   * увёз бы на публичную страницу каждое из них молча, ровно вопреки шапке
   * файла. Список здесь написан буквами по той же причине, что и у ячейки.
   */
  return { kind: 'data', data, execCount: output.execCount }
}

/**
 * Заметка на публичной странице: картинки из неё — в записи публикации.
 *
 * В документе комнаты картинка заметки стоит ссылкой на полку комнаты
 * (`attachment:<sha>.<ext>`, см. shared/images.ts), а полка комнаты публичной
 * странице недоступна и переживёт её не обязательно. Поэтому байты копируются
 * в записи публикации — ровно так же, как копируется картинка вывода строкой
 * ниже, — а в тексте остаётся её адрес там.
 *
 * Расширение в адресе — из mime, а не из имени ссылки: по нему выгрузка
 * каталога называет файл на диске (`render.ts · blobHref`), и разойтись этим
 * двум нельзя.
 */
function projectNote(source: string, blobs: BlobBag, sessionId: string | null): string {
  const edits: TextEdit[] = []
  for (const ref of findAttachmentRefs(source)) {
    const sha = shaOfAttachment(ref.name)
    if (!sha) continue
    const body = sessionId ? readBlob(sessionId, sha) : null
    if (!body) continue
    const mime = mimeOfAttachment(ref.name)
    const value = blobs.putBytes(mime, body)
    edits.push({ start: ref.start, end: ref.end, text: `${value}.${extOfMime(mime)}` })
  }
  /*
   * И картинка, лежащая ФАЙЛОМ в папке семинара: `![схема](assets/fig01.png)`.
   *
   * Уезжает она сюда по той же причине, по какой сюда уезжает всё остальное:
   * страница обязана открываться в среду вечером, когда ноутбук преподавателя
   * закрыт, — а папка семинара живёт ровно столько, сколько живёт комната.
   * Оставить путь как есть значило бы выгрузить страницу с мёртвой ссылкой на
   * `assets/fig01.png`, которой рядом с ней нет и не будет.
   *
   * Читается только то, что заведомо картинка (`NOTE_MIMES`) и влезает в
   * потолок: `![](data/train.csv.gz)` в заметке — это не картинка, а полтора
   * гигабайта в память посреди сборки публикации. Что не прочиталось, остаётся
   * путём — так же, как было до этой правки.
   */
  for (const ref of findWorkspaceImages(source)) {
    const mime = mimeOfNotePath(ref.path)
    if (!mime) continue
    const body = sessionId ? readBytes(sessionId, ref.path, MAX_NOTE_IMAGE_BYTES) : null
    if (!body) continue
    const value = blobs.putBytes(mime, body)
    edits.push({ start: ref.start, end: ref.end, text: `${value}.${extOfMime(mime)}` })
  }
  return applyEdits(source, edits)
}

const NOTE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

function mimeOfAttachment(name: string): string {
  return NOTE_MIMES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'image/png'
}

/**
 * Тип файла из папки семинара — или `null`, если он вообще не картинка.
 *
 * Отличается от `mimeOfAttachment` умолчанием, и отличается намеренно: имя
 * вложения выдал сам продукт, и «не знаю расширение — значит png» там верная
 * догадка. Путь в заметке пишет человек, и там незнакомое расширение означает
 * ровно то, что написано: это не картинка, забирать её в публикацию незачем.
 */
function mimeOfNotePath(path: string): string | null {
  return NOTE_MIMES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? null
}

/**
 * Потолок картинки заметки. Восьми мегабайт хватает на любую схему; всё, что
 * больше, — это уже не иллюстрация, а датасет, которому в странице не место.
 */
const MAX_NOTE_IMAGE_BYTES = 8 * 1024 * 1024

const extOfMime = (mime: string): string => mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'

/** Ячейка на публичной странице. Белый список — см. шапку файла. */
function projectCell(cell: CellSnapshot, blobs: BlobBag, sessionId: string | null): PublicCell {
  return {
    id: cell.id,
    type: cell.type,
    source: cell.type === 'markdown' ? projectNote(cell.source, blobs, sessionId) : cell.source,
    outputs: cell.outputs.map((o) => projectOutput(o, blobs, sessionId)),
    /*
     * Номер выполнения переносится как есть, включая `null` при непустом
     * выводе. Это не пропуск данных, а факт: результат на экране есть, а
     * выполнения, которое за него отвечает, уже нет — перезапускали ядро или
     * возвращали версию. Страница говорит про это «Out [—]», и врать здесь
     * хуже, чем промолчать.
     */
    execCount: cell.execCount,
    ranMs: cell.ranMs,
  }
}

/**
 * Тетрадь на момент версии `seq` — или причина, по которой её нет.
 *
 * Причин две, и они разные. «Пусто» — это факт о занятии: в тетради на тот
 * момент не было ни одной ячейки, шага из этого не выйдет. «Не читается» — это
 * поломка: строка истории есть, а развернуть её нечем. Раньше обе давали `null`,
 * маршрут молча пропускал шаг, и преподаватель, отметивший семь моментов,
 * получал страницу с шестью — без слова о том, какой пропал и почему, и без
 * следа в журнале сервера.
 */
export type BuiltPage = { ok: true; cells: PublicCell[] } | { ok: false; reason: SkipReason }

function* walkPages(
  sessionId: string,
  seqs: number[],
  blobs: BlobBag,
): Generator<[number, BuiltPage]> {
  const replay = openReplay(sessionId)
  try {
    // По возрастанию: только так проход идёт одним документом. Порядок рельсы
    // выбирает преподаватель, и складывает её обратно тот, кто просил.
    for (const seq of [...new Set(seqs)].sort((a, b) => a - b)) {
      let page: BuiltPage
      try {
        const cells = readNotebook(replay.at(seq))
        page =
          cells.length === 0
            ? { ok: false, reason: 'empty' }
            : { ok: true, cells: cells.map((c) => projectCell(c, blobs, sessionId)) }
      } catch (err) {
        // В журнал, а не в тишину: испорченная строка истории неотличима от
        // пустой тетради только до тех пор, пока о ней никто не сказал вслух.
        console.error(`publish: шаг ${sessionId}#${seq} не собрался`, err)
        page = { ok: false, reason: 'broken' }
      }
      yield [seq, page]
    }
  } finally {
    replay.close()
  }
}

/**
 * Страницы нескольких версий разом — одним документом на всю публикацию.
 *
 * Публикация — до сорока шагов (`MAX_STEPS`), и каждый разворачивался своим
 * `Y.Doc` от ближайшего кейфрейма: тетрадь с картинками — мегабайты на шаг, то
 * есть до сорока полных повторов истории подряд. Синхронно и в том же
 * процессе, где у коллеги в эту минуту идёт пара: её нажатия ждали.
 *
 * Здесь история проигрывается один раз (`replay.ts`), а к состоянию
 * предыдущего шага доприменяются только строки между ним и следующим. Ответ —
 * страница на каждый спрошенный `seq`, включая те, что шагом не станут:
 * причину пропуска называет `BuiltPage`, а не молчание.
 */
export function pagesAt(sessionId: string, seqs: number[], blobs: BlobBag): Map<number, BuiltPage> {
  return new Map(walkPages(sessionId, seqs, blobs))
}

/**
 * То же, с уступкой цикла событий между шагами.
 *
 * Повтор истории после этой правки один, но проекция страниц осталась своя на
 * каждый шаг: хэш каждой картинки, base64 в байты, обход всех выводов. На
 * сорока шагах это само по себе держит цикл секундами — а рядом идёт занятие.
 * База при этом читается ровно так же: проход спрашивает её сам, по строке за
 * шаг, и подрезанную на ходу историю замечает по кейфрейму (см. `replay.ts`).
 */
export async function pagesAtAsync(
  sessionId: string,
  seqs: number[],
  blobs: BlobBag,
): Promise<Map<number, BuiltPage>> {
  const pages = new Map<number, BuiltPage>()
  for (const [seq, page] of walkPages(sessionId, seqs, blobs)) {
    pages.set(seq, page)
    await new Promise<void>((resume) => setImmediate(resume))
  }
  return pages
}

/** Одна страница. Тот же проход, что и у публикации, длиной в один шаг. */
export function buildPageAt(sessionId: string, seq: number, blobs: BlobBag): BuiltPage {
  return pagesAt(sessionId, [seq], blobs).get(seq) ?? { ok: false, reason: 'broken' }
}

/** То же, коротко: страница или ничего. */
export function pageAt(sessionId: string, seq: number, blobs: BlobBag): PublicCell[] | null {
  const built = buildPageAt(sessionId, seq, blobs)
  return built.ok ? built.cells : null
}

/** Тетрадь как она есть прямо сейчас — последняя страница публикации. */
export function pageOfDoc(doc: Y.Doc, blobs: BlobBag): PublicCell[] {
  /*
   * Комната — у документа, а не в параметре.
   *
   * Картинки лежат на полке комнаты (server/blobs.ts), и чтобы вложить их в
   * публикацию, надо знать, чьи они. Спрашивать это вызывающего значило бы
   * протащить идентификатор через каждый вызов ради одной ветки; документ
   * комнаты знает своё имя сам с момента привязки к диску.
   */
  return readNotebook(doc).map((c) => projectCell(c, blobs, roomOfDoc(doc)))
}
