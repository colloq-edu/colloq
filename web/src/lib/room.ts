/**
 * Who is in the room, counted once each.
 *
 * Awareness is a list of *sockets*, not of people: a second tab, a reload whose
 * old connection has not timed out yet, a phone on the same link — each is its
 * own entry with its own client id. The room does not care about any of that.
 * It cares how many people are here and what each of them is doing.
 *
 * This exists because the two places that answer that question disagreed. The
 * People panel deduplicated by participant and the header's avatar row keyed on
 * the client id, so the same bar could read "4 in the room" beside a list of
 * three — the same person, twice, once with a cell badge and once without.
 *
 * Kept out of a `.svelte.ts` so it can be tested without a browser: what it
 * returns is a number people read off the screen and believe.
 */
import type { AwarenessUser } from '@shared/protocol'
import { plural } from './plural'

export interface RoomPeer {
  clientId: number
  user: AwarenessUser
  isSelf: boolean
}

export interface Person {
  user: AwarenessUser
  isSelf: boolean
  /** Open tabs for this human; two tabs are still one person in the room. */
  tabs: number
}

export function peopleInRoom(peers: readonly RoomPeer[]): Person[] {
  const byId = new Map<string, Person>()
  for (const peer of peers) {
    // A socket with no identity yet is a page still joining, not a person.
    if (!peer.user?.id) continue
    const existing = byId.get(peer.user.id)
    if (!existing) {
      byId.set(peer.user.id, { user: peer.user, isSelf: peer.isSelf, tabs: 1 })
      continue
    }
    existing.tabs += 1
    existing.isSelf ||= peer.isSelf
    // Whichever tab is actually doing something is the one worth reporting.
    if (!existing.user.activeCellId && peer.user.activeCellId) existing.user = peer.user
  }
  return [...byId.values()]
}

/* ------------------------------------------------------- где человек сейчас */

/** Место в комнате, к которому можно отвести. */
export type RevealTarget =
  | { where: 'cell'; cellId: string }
  | { where: 'terminal' }
  | { where: 'oracle' }

/** Что видно про человека: фраза для строки и место, к которому она ведёт. */
export interface Whereabouts {
  /** Одно предложение, или null — про этого человека сказать нечего. */
  line: string | null
  /** Куда отвести по нажатию, или null — вести некуда. */
  place: RevealTarget | null
}

/** Состояние комнаты, из которого считается «где кто». */
export interface RoomView {
  /**
   * Номер каждой ячейки — тот же, что нарисован у неё в поле слева.
   *
   * Карта, а не список в порядке документа: тетрадей в комнате несколько, счёт
   * в каждой свой, и «ячейка 04» должна означать ту самую четвёртую, которую
   * человек видит, — в какой бы тетради она ни лежала. Заодно отсюда же видно,
   * что ячейка ещё существует.
   */
  numbers: ReadonlyMap<string, number>
  runningCellId: string | null
  /** Отображаемое имя того, кто нажал Run. */
  runBy: string | null
}

/** Номера ячеек читаются так же, как в поле у края: 01, 02, 03. */
function cellNumber(view: RoomView, id: string | null | undefined): string | null {
  if (!id) return null
  const number = view.numbers.get(id)
  return number === undefined ? null : String(number).padStart(2, '0')
}

/**
 * Одна фраза про человека и одно место, к которому она ведёт.
 *
 * Считаются вместе намеренно. Это были две одинаковые лестницы условий — одна
 * складывала предложение, другая выбирала место, — и разойтись им достаточно
 * было в одном шаге: строка сказала бы «правит ячейку 04», а привела бы в
 * терминал. Строка, которая врёт про то, куда ведёт, хуже строки, которая
 * никуда не ведёт.
 *
 * Порядок — по тому, что что перебивает. Запуск важнее места курсора: пока
 * ячейка считается, человек занят именно ею. «N вкладок» стоит говорить только
 * когда ни в одной из них ничего не происходит, и вести туда, понятно, некуда.
 *
 * Фразы по-русски, потому что рисуются они второй строкой человека в панели —
 * рядом с «Преподаватель · вы» и подсказкой «К Нине в терминал». Панель
 * переведена целиком, и одна английская строка посреди неё читается как чужая
 * заплатка, а не как выбор.
 */
export function whereabouts(person: Person, view: RoomView): Whereabouts {
  const runningNo = cellNumber(view, view.runningCellId)
  /*
   * И нажавший Run, и стоящий в ячейке, пока она считается, одинаково честно
   * её запускают. runBy — отображаемое имя, поэтому два студента с одинаковым
   * именем оба заявили бы права на запуск; обычно спор решает курсор, а
   * неверная догадка здесь стоит слова, а не состояния.
   */
  const runs =
    runningNo !== null &&
    (view.runBy === person.user.name || person.user.activeCellId === view.runningCellId)
  if (runs && view.runningCellId) {
    return {
      line: `запускает ячейку ${runningNo}`,
      place: { where: 'cell', cellId: view.runningCellId },
    }
  }

  if (person.user.inTerminal) return { line: 'в терминале', place: { where: 'terminal' } }
  if (person.user.composing) return { line: 'спрашивает оракула', place: { where: 'oracle' } }

  const at = person.user.activeCellId
  const atNo = cellNumber(view, at)
  // Ячейку могли удалить с тех пор, как человек в ней стоял: вести к тому,
  // чего нет, хуже, чем не вести никуда — и говорить про это тоже нечего.
  if (at && atNo) return { line: `правит ячейку ${atNo}`, place: { where: 'cell', cellId: at } }

  if (person.tabs > 1) {
    const word = plural(person.tabs, 'вкладка', 'вкладки', 'вкладок')
    return { line: `${person.tabs} ${word}`, place: null }
  }
  return { line: null, place: null }
}
