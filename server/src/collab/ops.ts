/**
 * Правки состава тетради, которые делает сервер, а не браузер.
 *
 * Здесь ровно то, что не помещается в правило «вывод пишет только сервер».
 * Перестановка ячейки — единственная клиентская операция, которая по своей
 * природе смешанная: у Y.Array нет перемещения, так что одну из двух соседних
 * ячеек приходится пересоздать клоном, а клон несёт с собой всё, что ячейка
 * напечатала. Переупорядочить тетрадь — не повод выбрасывать вывод; писать
 * чужой вывод из браузера — нельзя. Примирить это в браузере невозможно, и
 * операция переезжает сюда целиком.
 *
 * Три следствия, и все три нужны: вывод переживает перестановку, ни разу не
 * будучи написанным клиентом; правило «только дописывать» нельзя обойти,
 * переставив чужую ячейку в небытие; и единственная смешанная клиентская
 * транзакция в продукте перестаёт существовать, так что «кадр судится целиком»
 * ничего не стоит.
 */
import * as Y from 'yjs'
import {
  CELLS_KEY,
  cellId,
  cloneCell,
  readCell,
  writeOutput,
  type CellSnapshot,
  type YCell,
  findCell,
} from '@shared/notebook'

/**
 * Поменять ячейку местами с соседом.
 *
 * Своей транзакции не заводит: оборачивает вызывающий — в `applyOnBehalf`, —
 * потому что у версии в истории должен быть автор, иначе перестановка читается
 * как «комната» и Ctrl+Z у нажавшего до неё не достаёт.
 *
 * `false` — не ошибка, а гонка: кнопку нарисовали по документу, который
 * отстаёт от сервера на круг.
 */
export function moveInCells(doc: Y.Doc, id: string, direction: -1 | 1): boolean {
  // В той тетради, где ячейка лежит: комнате их несколько, а «выше» и «ниже»
  // имеет смысл только внутри одной.
  const found = findCell(doc, id)
  if (!found) return false
  const cells = found.cells
  const from = found.index
  const to = from + direction
  if (to < 0 || to >= cells.length) return false

  /*
   * Переезжает сосед, а не та ячейка, которую двигают: пересоздание убивает
   * редактор вместе с курсором, а курсор стоит в той ячейке, на кнопку которой
   * нажали. Результат перестановки от выбора не зависит.
   */
  const neighbour = cloneCell(cells.get(to))
  cells.delete(to, 1)
  cells.insert(from, [neighbour])
  return true
}

/**
 * Погасить состояние выполнения у ячеек, ставших текстом.
 *
 * «Превратить в текст» стоит в том же тулбаре, что и «стоп», — одно нажатие от
 * работающей ячейки, и не погасить секундомер значит оставить его идти на
 * ячейке, которая больше не ячейка с кодом. Раньше это писал браузер, и это
 * было единственное место, где он писал состояние выполнения; пока оно
 * существовало, правило «вывод и состояние пишет только сервер» имело
 * исключение — то есть не было правилом.
 */
export function resetRetyped(doc: Y.Doc, cellIds: string[]): void {
  const cells = doc.getArray<YCell>(CELLS_KEY)
  const wanted = new Set(cellIds)
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells.get(i)
    if (!wanted.has(cellId(cell))) continue
    if (cell.get('type') !== 'markdown') continue
    cell.set('state', 'idle')
    cell.set('execCount', null)
    cell.set('startedAt', null)
    cell.set('ranMs', null)
    const outputs = cell.get('outputs')
    if (outputs instanceof Y.Array && outputs.length > 0) outputs.delete(0, outputs.length)
  }
}

/**
 * Что сервер помнит об удалённых ячейках — чтобы отмена удаления вернула их
 * целиком.
 *
 * Иначе Ctrl+Z после удаления посчитавшей ячейки ломался в любой комнате и при
 * любых правилах, и ломался бы молча-и-громко сразу: Yjs отменяет удаление
 * КОПИЕЙ, то есть браузер предлагает серверу новую ячейку, несущую готовый
 * вывод, — а пол комнаты запрещает браузеру писать вывод. Отказать значило бы
 * заставить человека пересобрать документ за обычное Ctrl+Z.
 *
 * Поэтому вывод возвращает сервер, из своей записи, а не из того, что прислал
 * браузер: пол остаётся целым — вывод, которого сервер не производил, в
 * документ по-прежнему не попадает, — а жест работает.
 */
interface Remembered {
  at: number
  cell: CellSnapshot
}

/** По семинару: имя ячейки → чем она была в момент удаления. */
const graves = new Map<string, Map<string, Remembered>>()

/**
 * Сколько удалений семинар помнит и как долго.
 *
 * Отмена — жест немедленный: не вспомнил за десять минут — не вспомнит. Потолок
 * в тридцать ячеек держит память конечной на семинаре, где чистят тетрадь.
 */
const GRAVE_TTL_MS = 10 * 60 * 1000
const GRAVE_MAX = 30

/** Запомнить ячейку перед тем, как принять её удаление. */
export function rememberDeleted(sessionId: string, doc: Y.Doc, cellIds: string[]): void {
  if (cellIds.length === 0) return
  const cells = doc.getArray<YCell>(CELLS_KEY)
  let room = graves.get(sessionId)
  if (!room) graves.set(sessionId, (room = new Map()))
  const now = Date.now()
  const wanted = new Set(cellIds)
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells.get(i)
    const id = cellId(cell)
    if (!wanted.has(id)) continue
    const snapshot = readCell(cell)
    // Пустую ячейку помнить незачем — возвращать нечего.
    if (snapshot.outputs.length === 0 && snapshot.execCount === null) continue
    room.set(id, { at: now, cell: snapshot })
  }
  for (const [id, grave] of room) {
    if (now - grave.at > GRAVE_TTL_MS) room.delete(id)
  }
  while (room.size > GRAVE_MAX) room.delete(room.keys().next().value as string)
}

export function forgetSession(sessionId: string): void {
  graves.delete(sessionId)
}

/** Какие удаления семинар ещё помнит — классификатору, чтобы узнать отмену. */
export function rememberedIn(sessionId: string): ReadonlySet<string> {
  const room = graves.get(sessionId)
  if (!room || room.size === 0) return EMPTY
  const now = Date.now()
  const live = new Set<string>()
  for (const [id, grave] of room) if (now - grave.at <= GRAVE_TTL_MS) live.add(id)
  return live
}

const EMPTY: ReadonlySet<string> = new Set()

/**
 * Привести только что созданные ячейки в согласие с тем, что знает сервер.
 *
 * Две ветки, и обе обязательны. Ячейка, которую сервер помнит удалённой, —
 * отмена: ей возвращается вывод и состояние ИЗ ЗАПИСИ СЕРВЕРА, а не из кадра.
 * Всякая другая новая ячейка чиста: вывод, который браузер приложил к ней сам,
 * стирается — это ровно та ячейка с готовым `text/html`, которая гасит экран
 * всему семинару, и ровно то поддельное «In [7]», которое незаметнее.
 */
export function settleFresh(sessionId: string, doc: Y.Doc, cellIds: string[]): void {
  if (cellIds.length === 0) return
  const room = graves.get(sessionId)
  const cells = doc.getArray<YCell>(CELLS_KEY)
  const wanted = new Set(cellIds)
  const now = Date.now()
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells.get(i)
    const id = cellId(cell)
    if (!wanted.has(id)) continue
    const grave = room?.get(id)
    const remembered = grave && now - grave.at <= GRAVE_TTL_MS ? grave.cell : null

    const outputs = cell.get('outputs')
    if (outputs instanceof Y.Array) {
      if (outputs.length > 0) outputs.delete(0, outputs.length)
      if (remembered) for (const out of remembered.outputs) outputs.push([writeOutput(out)])
    }
    cell.set(
      'state',
      remembered?.state === 'ok' || remembered?.state === 'error' ? remembered.state : 'idle',
    )
    cell.set('execCount', remembered?.execCount ?? null)
    cell.set('runBy', remembered?.runBy ?? null)
    cell.set('runById', remembered?.runById ?? null)
    cell.set('ranMs', remembered?.ranMs ?? null)
    // Секундомер и приглашение ко вводу не возвращаются никогда: ядро не
    // считает эту ячейку и ничего у неё не спрашивает.
    cell.set('startedAt', null)
    if (cell.get('stdin') != null) cell.set('stdin', null)
    if (remembered) room?.delete(id)
  }
}
