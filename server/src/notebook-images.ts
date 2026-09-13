/**
 * Картинки заметок — с полки комнаты, а не из документа.
 *
 * Разбор текста живёт в `shared/images.ts` (его читают обе стороны), а здесь —
 * диск: положить байты на полку (`blobs.ts`) при внесении тетради в комнату,
 * достать их обратно при выгрузке файла и один раз разгрузить документ комнаты,
 * который успел набрать картинок до появления этой машины.
 *
 * ЗАЧЕМ. Документ комнаты едет целиком каждому вошедшему и целиком ложится в
 * каждый снимок. Тетрадь лекции, где условия задач нарисованы картинками, —
 * это 9.4 МБ base64 в исходниках markdown-ячеек (замер по снимку живой комнаты
 * `pvhu2h7f`: 10.5 МБ документа, из них 9.09 МБ — картинки в тексте одной
 * тетради). На этом весе сервер закрывал отставшие сокеты, и студент на
 * медленном канале не догонял комнату вовсе.
 *
 * ЦЕНА. Ссылка вместо картинки — это второй запрос за байтами и ключ на полку
 * (routes/blobs.ts), то есть комната обязана уметь их показать. Поэтому же
 * выгрузка обязана класть их обратно вложениями: файл, унесённый к себе,
 * открывается без нашего сервера.
 */
import { Buffer } from 'node:buffer'
import * as Y from 'yjs'
import {
  applyEdits,
  attachmentName,
  findAttachmentRefs,
  findInlineImages,
  INLINE_IMAGE_FROM_CHARS,
  shaOfAttachment,
  type TextEdit,
} from '@shared/images'
import type { FlatCell } from '@shared/ipynb'
import { allCellArrays } from '@shared/notebook'
import { putBlob, readBlob } from './blobs.js'
import { seldom } from './log.js'

/** Тип содержимого по хвосту имени вложения — обратное `extForMime`. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

function mimeOfName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Положить картинки этой ячейки на полку, оставив в тексте ссылки.
 *
 * Обе формы разом, потому что в одном файле встречаются обе: вложение nbformat
 * (`attachments` + `![](attachment:имя.png)`) и картинка прямо в тексте
 * (`![](data:image/png;base64,…)`). На полке они становятся одним и тем же:
 * байты по своему хэшу.
 *
 * Возвращает ячейку без `attachments`: байты уже на полке, и второй их копии в
 * документе быть не должно — ради этого всё и затевалось.
 */
export function shelveCellImages(sessionId: string, cell: FlatCell): FlatCell {
  if (cell.type !== 'markdown') return cell
  let source = cell.source
  source = shelveAttachments(sessionId, source, cell.attachments)
  source = shelveInline(sessionId, source)
  const out: FlatCell = { ...cell, source }
  delete out.attachments
  return out
}

/** Вложения nbformat: байты — на полку, ссылка — на её имя. */
function shelveAttachments(
  sessionId: string,
  source: string,
  attachments: FlatCell['attachments'],
): string {
  if (!attachments) return source
  const edits: TextEdit[] = []
  for (const ref of findAttachmentRefs(source)) {
    // Уже наше имя: файл пришёл из нашей же выгрузки, и байты на полке лежат.
    if (shaOfAttachment(ref.name)) continue
    const bundle = attachments[ref.name]
    if (!bundle) continue
    const picked = Object.entries(bundle).find(([mime]) => mime.startsWith('image/'))
    if (!picked) continue
    const [mime, base64] = picked
    const body = Buffer.from(base64, 'base64')
    if (body.length === 0) continue
    const stored = putBlob(sessionId, body)
    // Не легло на диск — пусть ссылка останется как была: битая картинка лучше
    // потерянного текста вокруг неё, а вложение мы всё равно донесём файлом.
    if (!stored) continue
    edits.push({
      start: ref.start,
      end: ref.end,
      text: `attachment:${attachmentName(stored.sha, mime)}`,
    })
  }
  return applyEdits(source, edits)
}

/** Картинка, лежащая в тексте содержимым, — на полку. */
function shelveInline(sessionId: string, source: string): string {
  const edits: TextEdit[] = []
  for (const image of findInlineImages(source, INLINE_IMAGE_FROM_CHARS)) {
    const body = Buffer.from(image.base64, 'base64')
    if (body.length === 0) continue
    const stored = putBlob(sessionId, body)
    if (!stored) continue
    edits.push({
      start: image.start,
      end: image.end,
      text: `attachment:${attachmentName(stored.sha, image.mime)}`,
    })
  }
  return applyEdits(source, edits)
}

/**
 * Вернуть картинки в ячейку — вложениями, как их держит nbformat.
 *
 * Это ровно то, что делает файл переносимым: ссылку `attachment:<sha>.png`
 * Jupyter понимает сам, если рядом лежит вложение с тем же именем. Ссылка, для
 * которой на полке ничего нет (картинку положила другая комната, из которой
 * тетрадь принесли файлом), остаётся в тексте как есть: её видно, и это
 * честнее, чем стереть её молча.
 */
export function inlineCellImages(sessionId: string, cell: FlatCell): FlatCell {
  if (cell.type !== 'markdown') return cell
  const attachments: Record<string, Record<string, string>> = { ...(cell.attachments ?? {}) }
  let found = false
  for (const ref of findAttachmentRefs(cell.source)) {
    if (attachments[ref.name]) continue
    const sha = shaOfAttachment(ref.name)
    if (!sha) continue
    const body = readBlob(sessionId, sha)
    if (!body) continue
    attachments[ref.name] = { [mimeOfName(ref.name)]: body.toString('base64') }
    found = true
  }
  if (!found && !cell.attachments) return cell
  return { ...cell, attachments }
}

/* ------------------------------------------------------- разгрузка комнаты */

/**
 * Разгрузить документ комнаты один раз при открытии.
 *
 * Импорт кладёт картинки на полку с этого дня, но комнаты, заведённые раньше,
 * носят их в себе и будут носить до конца семестра: документ живёт в базе, а не
 * в файле. Поэтому — при подъёме комнаты, до начала истории (collab/index.ts),
 * чтобы правка легла в базовую точку, а не показалась комнате чужой версией.
 *
 * Идемпотентно по построению: после первого прохода в тексте стоят ссылки, и
 * `findInlineImages` не находит ничего — второй проход не пишет в документ
 * вовсе, а значит не будит ни снимок, ни проекцию тетради на диск.
 *
 * Молча, если менять нечего, и один раз в журнал, если было что: строка на
 * каждое открытие комнаты — это шум, по которому перестают читать журнал.
 */
export function shelveRoomImages(sessionId: string, doc: Y.Doc): number {
  let moved = 0
  let bytes = 0
  doc.transact(() => {
    for (const cells of allCellArrays(doc)) {
      cells.forEach((cell: Y.Map<any>) => {
        if (cell.get('type') !== 'markdown') return
        const text = cell.get('source')
        if (!(text instanceof Y.Text)) return
        const source = text.toString()
        const images = findInlineImages(source, INLINE_IMAGE_FROM_CHARS)
        if (images.length === 0) return
        /*
         * С конца: правка меняет длину текста, и границы, посчитанные по
         * исходнику, поехали бы после первой же замены.
         */
        for (const image of [...images].reverse()) {
          const body = Buffer.from(image.base64, 'base64')
          if (body.length === 0) continue
          const stored = putBlob(sessionId, body)
          if (!stored) continue
          text.delete(image.start, image.end - image.start)
          text.insert(image.start, `attachment:${attachmentName(stored.sha, image.mime)}`)
          moved += 1
          bytes += image.base64.length
        }
      })
    }
  }, 'server')
  if (moved > 0 && seldom(`shelve-images-${sessionId}`, 60 * 60_000)) {
    console.log(
      `[blobs ${sessionId}] картинок из текста ячеек вынесено на полку: ${moved}, ` +
        `документ легче на ${Math.round(bytes / 1024)} КБ`,
    )
  }
  return moved
}

/** Ячейки тетради со ссылками, развёрнутыми во вложения, — для выгрузки файлом. */
export function withInlinedImages(sessionId: string, cells: readonly FlatCell[]): FlatCell[] {
  return cells.map((cell) => inlineCellImages(sessionId, cell))
}
