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
  cellId,
  cloneCell,
  readCell,
  writeOutput,
  type CellSnapshot,
  type YCell,
  findCell,
} from '@shared/notebook'

const EMPTY: ReadonlySet<string> = new Set()

/**
 * В каких ячейках сейчас стоят курсоры. Источник регистрирует `collab/index.ts`.
 *
 * Через регистрацию, а не импортом: присутствие живёт в сокетах, а этот модуль
 * — тот, куда ходит тест, и тащить за собой базу и сокеты ему незачем. Никто не
 * зарегистрировался — считаем, что курсоров нет.
 */
let carets: ((doc: Y.Doc) => ReadonlySet<string>) | null = null

export function onCarets(source: (doc: Y.Doc) => ReadonlySet<string>): void {
  carets = source
}

/**
 * Записать ключ ячейки, только если он и правда меняется.
 *
 * `Y.Map.set` заводит новый элемент даже под тем же значением: это такт в
 * документе, лишний элемент в снимке и серверный update — а серверный update
 * открывает всплеск истории без автора, и правка человека, попавшая в тот же
 * всплеск, подписывалась «the room». Шесть таких записей уходило на каждую
 * добавленную ячейку, которой и менять-то было нечего.
 */
function put(cell: YCell, key: string, value: unknown): void {
  if (cell.get(key) === value) return
  cell.set(key, value)
}

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
   *
   * Но у клона цена дороже курсора, и платит её не нажавший. Нажатия, ушедшие
   * в старый `Y.Text` за круг до сервера, адресованы удалённой структуре: гейт
   * их пропускает (запись в надгробие никому не видна), и символы пропадают у
   * печатающего молча — Ctrl+Z их не вернёт, они лежат в надгробии. Поэтому
   * если в соседке стоит чей-то курсор, пересоздаётся та, которую двигают: у
   * неё курсор нажавшего, а нажавший в этот момент нажимает, а не печатает.
   */
  const busy = carets?.(doc) ?? EMPTY
  if (busy.has(cellId(cells.get(to)))) {
    const moved = cloneCell(cells.get(from))
    cells.delete(from, 1)
    cells.insert(to, [moved])
    return true
  }

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
  for (const id of cellIds) {
    const found = findCell(doc, id)
    if (!found) continue
    const cell = found.cell
    if (cell.get('type') !== 'markdown') continue
    put(cell, 'state', 'idle')
    put(cell, 'execCount', null)
    put(cell, 'startedAt', null)
    put(cell, 'ranMs', null)
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
  let room = graves.get(sessionId)
  if (!room) graves.set(sessionId, (room = new Map()))
  const now = Date.now()
  for (const id of cellIds) {
    // По имени, во всех тетрадях комнаты, — как ищет гейт, который эти имена и
    // назвал. Пока здесь стоял корень `cells`, во второй тетради сервер не
    // помнил ни одного удаления, и Ctrl+Z по посчитавшей ячейке упирался в
    // отказ «новая ячейка объявляет себя выполнявшейся».
    const found = findCell(doc, id)
    if (!found) continue
    const snapshot = readCell(found.cell)
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
  const now = Date.now()
  for (const id of cellIds) {
    const found = findCell(doc, id)
    if (!found) continue
    const cell = found.cell
    const grave = room?.get(id)
    const remembered = grave && now - grave.at <= GRAVE_TTL_MS ? grave.cell : null

    const outputs = cell.get('outputs')
    if (outputs instanceof Y.Array) {
      if (outputs.length > 0) outputs.delete(0, outputs.length)
      if (remembered) for (const out of remembered.outputs) outputs.push([writeOutput(out)])
    }
    put(
      cell,
      'state',
      remembered?.state === 'ok' || remembered?.state === 'error' ? remembered.state : 'idle',
    )
    put(cell, 'execCount', remembered?.execCount ?? null)
    put(cell, 'runBy', remembered?.runBy ?? null)
    put(cell, 'runById', remembered?.runById ?? null)
    put(cell, 'ranMs', remembered?.ranMs ?? null)
    // Секундомер и приглашение ко вводу не возвращаются никогда: ядро не
    // считает эту ячейку и ничего у неё не спрашивает.
    put(cell, 'startedAt', null)
    if (cell.get('stdin') != null) cell.set('stdin', null)
    if (remembered) room?.delete(id)
  }
}
