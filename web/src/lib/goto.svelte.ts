/**
 * Переход к определению: спросить, доехать, а если некуда — сказать.
 *
 * Жест живёт в редакторе (components/notebook/CodeEditor.svelte), поиск — на
 * сервере (server/src/definitions.ts), а между ними стоит это: один модуль,
 * который знает, что делать с ответом. Держать эту работу в редакторе нельзя —
 * он про текст ячейки и ничего не знает ни про вкладки, ни про соседние
 * тетради; держать в экране комнаты — значит связать редактор кода с
 * устройством всей рабочей области.
 *
 * ПРИЗЕМЛЕНИЕ — не событие, а состояние, и это несущее решение. Ячейка, к
 * которой ведут, может быть ещё не построена: тетрадь строит `CellView` только
 * рядом с экраном, а вместо далёких ставит заглушку в 240 px
 * (Notebook.svelte · data-cell-deferred). Событие, посланное такой ячейке,
 * слушать некому — оно уходит в никуда, и переход молча не доезжает. Метка
 * лежит здесь и ждёт: ячейка, построенная через кадр после прокрутки, читает
 * её сама и подсвечивает строку, будто ждали её.
 */

import { tr } from '@shared/i18n'
import type { DefinitionHit, DefinitionMiss } from '@shared/protocol'
import { reveal, revealCell } from './reveal'
import type { SessionState } from './session.svelte'

/** Куда смотреть внутри документа, к которому привели. */
export interface Landing {
  /** Строка, считая с единицы. */
  line: number
  /** Колонка, считая с нуля. */
  column: number
  /**
   * Номер перехода.
   *
   * Без него второй переход НА ТУ ЖЕ строку не виден: поля те же, значение
   * `$derived` не меняется, и подсветка не мигает. А повторный переход — это
   * обычное дело: человек ушёл читать, вернулся и щёлкнул снова.
   */
  seq: number
}

let seq = 0
let inCell = $state<(Landing & { cellId: string }) | null>(null)
let inFile = $state<(Landing & { path: string }) | null>(null)
let stale: ReturnType<typeof setTimeout> | null = null

/**
 * Сколько метка ждёт своего документа — и почему она вообще перестаёт ждать.
 *
 * Ждать её заставляет виртуализация: ячейка, к которой ведут, строится через
 * кадр после прокрутки, и событие, посланное до этого, слушать было бы некому.
 * Но метка — это состояние, и, оставшись висеть, она срабатывает СНОВА при
 * каждой новой постройке той же ячейки: человек через полчаса прокручивает
 * мимо неё, а каретка сама прыгает внутрь и уводит фокус из того места, где он
 * работал. Четыре секунды — заведомо больше кадра и заведомо меньше, чем живёт
 * внимание к переходу.
 */
const WAITS_MS = 4000

function expire(): void {
  if (stale !== null) clearTimeout(stale)
  stale = setTimeout(() => {
    stale = null
    inCell = null
    inFile = null
  }, WAITS_MS)
}

/** Метка для этой ячейки — или ничего. Читается из `$derived` в CellView. */
export function landingInCell(cellId: string): Landing | null {
  const now = inCell
  return now && now.cellId === cellId ? now : null
}

/** То же для файла: читается там, где строится редактор файла. */
export function landingInFile(path: string): Landing | null {
  const now = inFile
  return now && now.path === path ? now : null
}

/**
 * Снять метки.
 *
 * Зовётся, когда человек сам поставил каретку или начал печатать: подсветка —
 * это «вот куда я тебя привёл», и после первого же собственного движения она
 * превращается в непонятную полосу посреди кода.
 */
export function clearLanding(): void {
  if (stale !== null) clearTimeout(stale)
  stale = null
  inCell = null
  inFile = null
}

/** Слова, которыми объясняется «некуда». */
function words(miss: DefinitionMiss): string | null {
  switch (miss.why) {
    /*
     * Под указателем не было имени — значит и подчёркивания не было, и жеста
     * человек не делал: щёлкнул с зажатым модификатором по пробелу или по
     * строке. Сказать тут нечего, и говорить не надо.
     */
    case 'nothing':
      return null
    case 'unknown':
      return tr('room.goto.unknown', { name: miss.name })
    case 'outside':
      /*
       * Щёлкнули по самому названию модуля — говорим про модуль, а не про имя
       * в нём. Иначе выходит «pandas приходит из pandas»: формально верно и
       * читается как сбой.
       */
      return miss.name === miss.module
        ? tr('room.goto.outsideModule', { module: miss.module })
        : tr('room.goto.outside', { name: miss.name, module: miss.module })
    case 'opaque':
      /*
       * Пустой `owner` — цепочка от ВЫРАЖЕНИЯ: `df[["a"]].head`, `f(x).head`.
       * Имени, о котором можно говорить, там нет вовсе, и назвать его нечем.
       */
      return miss.owner
        ? tr('room.goto.opaque', { owner: miss.owner })
        : tr('room.goto.opaqueThing')
  }
}

/** Привести туда, где это определено. */
function land(session: SessionState, hit: DefinitionHit): void {
  seq += 1
  const landing = { line: hit.line, column: hit.column, seq }
  if (hit.where === 'cell' && hit.cellId) {
    inFile = null
    inCell = { ...landing, cellId: hit.cellId }
    /*
     * Экран ведёт `revealCell`, а не сам редактор.
     *
     * У ячейки нет своего скроллера (`.cm-scroller { overflow: visible }` в
     * CodeEditor.svelte), поэтому `EditorView.scrollIntoView` пошёл бы вверх по
     * предкам и подвинул `<main>` — то есть оборвал бы плавный ход тетради на
     * полпути: браузер считает правку `scrollTop` посреди прокрутки чужим
     * вмешательством (Notebook.svelte · steering). Ячейку везёт тетрадь, а
     * редактор только подсвечивает строку.
     */
    expire()
    revealCell(session, hit.cellId)
    return
  }
  if (hit.where === 'file' && hit.path) {
    inCell = null
    inFile = { ...landing, path: hit.path }
    expire()
    // Вкладки знает только экран комнаты — туда и уходит просьба открыть файл.
    reveal({ where: 'file', path: hit.path })
  }
}

/**
 * Спросить, где определено то, что под указателем, и уйти туда.
 *
 * `from` — откуда спрашивают: имя ячейки или путь файла. Сервер по нему считает
 * и порядок поиска (своя тетрадь раньше чужих), и относительные импорты
 * (`from . import util` — рядом с ЭТИМ файлом).
 */
export async function jumpToDefinition(
  session: SessionState,
  code: string,
  cursor: number,
  from: { cellId?: string; path?: string },
): Promise<void> {
  const reply = await session.define(code, cursor, from.cellId, from.path)
  /*
   * Ответа нет вовсе — сокет закрыт или сервер не успел. Молчание здесь
   * законно и об этом же говорит вся комната: рядом уже висит строка «нет
   * связи», и второй тост про то же самое ничего не добавит.
   */
  if (!reply) return
  if (reply.hit) {
    land(session, reply.hit)
    return
  }
  const said = reply.miss ? words(reply.miss) : null
  if (said) session.showError(said)
}
