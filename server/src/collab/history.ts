import { tr } from '@shared/i18n'
/**
 * Turning a stream of CRDT updates into a history a person can read.
 *
 * Yjs hands us an update per keystroke. A history made of those is not a
 * history — it is a log, and nobody scrolls a log of four thousand rows looking
 * for the moment before the cell broke. So updates are grouped into bursts: one
 * burst is one thing one person did, and one burst is one row in the timeline.
 *
 * A burst closes when the person stops typing (BURST_IDLE_MS), when somebody
 * else starts (a different author is a different thing done), when it has grown
 * past BURST_MAX_CHARS, or when it has simply run too long (BURST_MAX_MS) —
 * that last one exists so a teacher writing one long cell for four minutes
 * still leaves a point to come back to in the middle of it.
 *
 * Cost. The merge happens in memory and touches SQLite once per burst, which
 * for a ninety-minute seminar is a few dozen writes. Reading is the mirror
 * image: a keyframe every KEYFRAME_EVERY rows means rebuilding any version
 * replays a bounded number of updates rather than the whole seminar, and the
 * result is cached, so scrubbing the timeline costs one rebuild per version
 * visited rather than one per render.
 */
import * as Y from 'yjs'
import {
  BURST_IDLE_MS,
  BURST_MAX_CHARS,
  BURST_MAX_MS,
  KEYFRAME_EVERY,
  KEYFRAME_MIN_BYTES,
  type HistoricCell,
  type VersionKind,
} from '@shared/history'
import {
  addBook,
  allCellArrays,
  bookList,
  BOOKS_KEY,
  cloneCell,
  CELLS_KEY,
  createCell,
  defaultBookName,
  getMeta,
  replaceText,
  type YCell,
} from '@shared/notebook'
import { plural } from '@shared/plural'
import { appendVersion, hasHistoryBase, trimHistory, updatesUpTo, versionCount } from '../db.js'

/** Marks writes this module makes into a live doc, so they are not re-recorded twice. */
export const RESTORE_ORIGIN = 'history-restore'

interface Burst {
  sessionId: string
  /**
   * Кто печатал. Множество, а не один: см. `record`. Только люди — сервер
   * (ядро, оракул) во всплеск пишет, но автором не становится.
   *
   * Пока это был один человек, смена автора закрывала всплеск — и два студента,
   * печатающие в одной комнате одновременно, давали по версии на каждое
   * нажатие. Сорок нажатий — сорок строк истории и шесть мегабайт байтов, а
   * чекпоинт «до упражнения» вылетал из окна на четыреста строк за десятки
   * секунд. Всплеск, в который писали двое, так и записывается — «the room».
   */
  authors: Set<string>
  updates: Uint8Array[]
  /** State of the document when the burst opened, for the summary and the counts. */
  before: Uint8Array
  openedAt: number
  lastAt: number
  chars: number
  timer: NodeJS.Timeout | null
  /** Which cells existed, and in what order, when the burst opened. */
  shape: string
}

const bursts = new Map<string, Burst>()

/*
 * The state each session's next version will be measured against.
 *
 * It cannot be read off the document when a burst opens: `doc.on('update')`
 * fires *after* the update has been applied, so by then the change we are about
 * to describe is already in there and the comparison finds nothing. That was
 * not a subtle bug — it silently dropped the first version of every burst,
 * which is most of them.
 *
 * So the baseline is carried forward instead: set when the room is bound (to
 * whatever was on disk), and advanced to the new state every time a version is
 * written. A version is then exactly "the difference between the last thing we
 * recorded and now", which is what it claims to be.
 */
const baselines = new Map<string, Uint8Array>()

/*
 * The notebook's shape as of each baseline: which cells existed, in what order.
 *
 * Carried forward with the baseline for the same reason the baseline is: the
 * update handler runs *after* the change has landed, so reading the shape off
 * the live document when a burst opens reads the shape the burst just produced,
 * and the comparison below can never be true.
 */
const shapes = new Map<string, string>()

/**
 * Тексты ячеек на момент последнего закрытия — то, с чем сравнивают следующий
 * всплеск.
 *
 * Раньше каждое закрытие разворачивало документ дважды: один раз «до», один
 * «после». На трёхмегабайтной тетради это семь миллисекунд блокировки цикла
 * событий на нажатие клавиши — при том, что «до» мы уже разворачивали в прошлый
 * раз и могли запомнить. Здесь и запоминаем; если записи нет (сервер только
 * поднялся), разворачиваем, как раньше.
 */
const digests = new Map<string, Map<string, string>>()

/**
 * Комнаты, у которых в цепочке истории не хватает строки.
 *
 * В памяти, потому что и лечение в памяти: следующее удачное закрытие всплеска
 * пишет полный снимок. Перезапуск сервера снимает пометку сам — `beginHistory`
 * сверяет живой документ с историей и пишет тот же снимок.
 */
const gaps = new Set<string>()

/**
 * Start recording a room, measuring from the state it currently holds.
 *
 * Called once the document is hydrated and before it is seeded, so a brand-new
 * seminar records its starter cells as its first version and a restarted one
 * does not record its whole notebook as somebody's edit.
 */
export function beginHistory(sessionId: string, doc: Y.Doc): void {
  baselines.set(sessionId, Y.encodeStateAsUpdate(doc))
  shapes.set(sessionId, shapeOf(doc))
  // Запомненные тексты идут в ногу с базовой точкой: сравнивать следующий
  // всплеск с чужим слепком — это приписать ему всё, что было до него.
  digests.set(sessionId, new Map(cellsOf(doc).map((c) => [c.id, c.source])))

  /*
   * A room with no history yet gets a first row carrying the whole document.
   *
   * It is the timeline's "opened the seminar", and it is also the thing every
   * replay starts from. Without it the oldest row is a delta with nothing
   * underneath, and rebuilding any version means applying a change to a
   * document that was never there — which produces an empty notebook, silently.
   *
   * The test is for a base specifically, not for an empty history. A room
   * recorded by a build that predates this row has deltas and nothing to apply
   * them to, and would rebuild to an empty notebook for ever; giving it a base
   * now costs one row and makes everything from this moment on readable.
   */
  if (hasHistoryBase(sessionId)) {
    repairHistory(sessionId, doc)
    return
  }
  appendVersion({
    sessionId,
    update: Y.encodeStateAsUpdate(doc),
    kind: 'opened',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: versionCount(sessionId) > 0 ? tr("server.notebookAtThisPoint.ccc077") : tr("server.opened.e716b0"),
    added: 0,
    removed: 0,
    cells: [],
  })
}

/** «Всё, что записано»: адрес у `updatesUpTo` — потолок, а не точная строка. */
const LATEST = Number.MAX_SAFE_INTEGER

/**
 * Починить историю, которая разошлась с тетрадью комнаты.
 *
 * Разойтись она может двумя способами, и оба кончаются одинаково молча.
 *
 * Первый: комнаты, записанные до того, как порядок «сначала засев, потом
 * история» был исправлен, имеют базовую строку, снятую с ПУСТОГО документа.
 * Строка есть, `hasHistoryBase` довольна, а разворачивается всё в ноль ячеек.
 *
 * Второй: жёсткий конец процесса — kill -9, OOM, обесточивание. Снимок
 * документа пишется через 4–15 секунд, а строка истории — по закрытию всплеска
 * (до девяноста секунд); штатный выход дописывает открытый всплеск сам
 * (flushAllHistory), внезапный не успевает. На диске остаётся текст, которого
 * в истории нет, и все последующие дельты ссылаются на такты, которых в
 * цепочке не будет: Yjs кладёт их в pending и молча не применяет. Лента
 * замирает на предкрахном состоянии, а «Restore» пишет его поверх живой
 * тетради — всей комнате и без возврата.
 *
 * Прошлое этим не восстановить: тех байтов не существует нигде. Но будущее
 * спасается одной строкой — снимком того, что в комнате есть сейчас. С неё
 * начнутся все последующие проигрывания.
 *
 * Цена: одна сборка последней версии на открытие комнаты — та же работа, что
 * и один клик по ленте, потому что повтор идёт от свежайшего снимка, а не от
 * начала семинара.
 */
function repairHistory(sessionId: string, doc: Y.Doc): void {
  // Живой документ пуст — сравнивать не с чем, и починка была бы записью
  // пустоты поверх пустоты.
  if (cellsOf(doc).length === 0) return

  const replay = new Y.Doc()
  let damage: 'unreadable' | 'behind' | null = null
  try {
    replay.transact(() => {
      for (const update of updatesUpTo(sessionId, LATEST)) Y.applyUpdate(replay, update, 'history')
    })
    if (replay.getArray(CELLS_KEY).length === 0) damage = 'unreadable'
    else if (behind(replay, doc)) damage = 'behind'
  } catch {
    damage = 'unreadable'
  }
  replay.destroy()
  if (damage === null) return

  appendVersion({
    sessionId,
    update: Y.encodeStateAsUpdate(doc),
    kind: 'keyframe',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: tr("server.notebookAtThisPoint.ccc077"),
    added: 0,
    removed: 0,
    cells: [],
  })
  forgetCache(sessionId)
  console.warn(
    damage === 'unreadable'
      ? `[history] ${sessionId}: база истории была снята с пустого документа — ` +
          `ни одна версия не разворачивалась. Записан снимок текущей тетради; ` +
          `версии до него остаются нечитаемыми.`
      : `[history] ${sessionId}: история отстала от тетради на диске — процесс ` +
          `оборвался с незакрытым всплеском. Записан снимок текущей тетради; ` +
          `правки, не попавшие в историю, восстановить неоткуда.`,
  )
}

/**
 * Есть ли в живом документе то, чего в истории нет.
 *
 * Два вопроса, потому что Yjs отвечает «что изменилось» в двух местах.
 * Написанное поднимает счётчик своего клиента, так что счётчик выше — это
 * байты, до которых история не дошла. Удаление тактов не двигает — оно живёт в
 * множестве удалений, — поэтому состав тетради сверяется отдельно.
 */
function behind(replay: Y.Doc, doc: Y.Doc): boolean {
  const known = Y.decodeStateVector(Y.encodeStateVector(replay))
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
    if ((known.get(client) ?? 0) < clock) return true
  }
  const live = cellsOf(doc)
  const stored = cellsOf(replay)
  if (live.length !== stored.length) return true
  return live.some(
    (cell, i) =>
      cell.id !== stored[i].id || cell.type !== stored[i].type || cell.source !== stored[i].source,
  )
}

/**
 * What a version did, in the words the timeline shows.
 *
 * Computed by comparing the document before the burst with the document after
 * it — not by inspecting the update bytes. The bytes say which items changed;
 * the reader wants to know that cell 04 was edited, and only the two documents
 * can say that.
 */
function describe(
  was: Map<string, string>,
  now: Map<string, string>,
): {
  summary: string
  added: number
  removed: number
  cells: string[]
} {
  const created: string[] = []
  const deleted: string[] = []
  const changed: string[] = []
  let added = 0
  let removed = 0

  for (const [id, source] of now) {
    const old = was.get(id)
    if (old === undefined) {
      created.push(id)
      added += source.length
    } else if (old !== source) {
      changed.push(id)
      const gain = source.length - old.length
      // Net, not a real diff: a burst that replaces a word both adds and
      // removes, and counting only the balance would report it as nothing.
      if (gain >= 0) added += gain
      else removed += -gain
      if (gain === 0 && old !== source) added += source.length
    }
  }
  for (const [id, source] of was) {
    if (!now.has(id)) {
      deleted.push(id)
      removed += source.length
    }
  }

  const order = [...now.keys()]
  const number = (id: string) => String(order.indexOf(id) + 1).padStart(2, '0')

  /*
   * Слова версии — по-русски, потому что их никто не разбирает: сервер сочиняет
   * строку, лента (web/src/components/panels/HistoryTab.svelte · saying) её
   * печатает как есть. Панель говорит с классом по-русски, и английская
   * подпись стояла в ней рядом с русским именем автора.
   *
   * Число — через общее правило числительного, а не «N ячеек» подстановкой:
   * «21 ячеек» и «2 ячеек» — ровно та ошибка, ради которой `plural` и лежит в
   * shared.
   */
  const cells = (n: number): string => tr('server.historyCells', { count: n })

  let summary: string
  if (created.length > 0 && changed.length === 0 && deleted.length === 0) {
    summary = created.length === 1 ? tr("server.addedACell.b6ba53") : tr("server.added.f985c7", { p0: cells(created.length) })
  } else if (deleted.length > 0 && created.length === 0 && changed.length === 0) {
    summary = deleted.length === 1 ? tr("server.deletedACell.e08aef") : tr("server.deleted.9e3b01", { p0: cells(deleted.length) })
  } else if (changed.length === 1 && created.length === 0 && deleted.length === 0) {
    summary = tr("server.editedCell.58cff0", { p0: number(changed[0]) })
  } else if (changed.length > 1 && created.length === 0 && deleted.length === 0) {
    summary = tr("server.edited.50f36f", { p0: cells(changed.length) })
  } else if (created.length + changed.length + deleted.length === 0) {
    // Nothing anybody wrote changed. The caller drops these — see close().
    summary = ''
  } else {
    summary = tr("server.reworkedTheNotebook.c8708b")
  }

  return { summary, added, removed, cells: [...new Set([...created, ...changed, ...deleted])] }
}

/**
 * Свободное имя для возвращаемой тетради комнаты.
 *
 * Её прежний путь история не хранит — она хранит ячейки, — а имя по умолчанию
 * могло за это время достаться кому-то ещё.
 */
function freeBookName(doc: Y.Doc): string {
  const taken = new Set(bookList(doc).map((book) => book.path))
  const preferred = defaultBookName()
  if (!taken.has(preferred)) return preferred
  for (let n = 2; n < 100; n++) {
    const candidate = tr("server.notebookIpynb.9616a7", { p0: n })
    if (!taken.has(candidate)) return candidate
  }
  return preferred
}

/** The cells of a document, flattened to what the history cares about. */
export function cellsOf(doc: Y.Doc): HistoricCell[] {
  const cells = doc.getArray<Y.Map<unknown>>(CELLS_KEY)
  const out: HistoricCell[] = []
  for (const cell of cells.toArray()) {
    const id = cell.get('id')
    if (typeof id !== 'string') continue
    const source = cell.get('source')
    out.push({
      id,
      type: cell.get('type') === 'code' ? 'code' : 'markdown',
      source: source instanceof Y.Text ? source.toString() : String(source ?? ''),
    })
  }
  return out
}

/**
 * Which cells exist and in what order — the notebook's shape, not its text.
 *
 * По ВСЕМ тетрадям комнаты, а не по одной. Смотрело только в `CELLS_KEY`, и
 * перестановка ячейки во второй тетради всплеск не закрывала: строка «двигали
 * ячейку» приезжала в ленту через двенадцать секунд молчания или не приезжала
 * вовсе, слитая с чужим набором.
 *
 * Разделитель между тетрадями обязателен: без него перенос ячейки из одной
 * тетради в соседнюю давал ту же самую строку и выглядел как «ничего не
 * менялось».
 */
function shapeOf(doc: Y.Doc): string {
  const parts: string[] = []
  for (const cells of allCellArrays(doc)) {
    for (const cell of cells.toArray()) parts.push(String(cell.get('id') ?? ''))
    parts.push('|')
  }
  return parts.join(',')
}

/**
 * Массивы, из-за которых форму тетради надо пересчитывать.
 *
 * Сами листы ячеек и список тетрадей. Терминал и лента оракула — тоже `Y.Array`
 * в том же документе, и по ним форма измениться не может: ячейки в них не
 * лежат. Без этого различия поток вывода ядра пересобирал бы форму на каждый
 * сброс буфера.
 */
function shapingArrays(doc: Y.Doc): Y.AbstractType<any>[] {
  const arrays: Y.AbstractType<any>[] = [...allCellArrays(doc)]
  const books = getMeta(doc).get(BOOKS_KEY)
  if (books instanceof Y.Array) arrays.push(books)
  return arrays
}

function docFrom(updates: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc()
  // One transaction for the whole replay: applying twenty updates separately
  // fires twenty rounds of observers on a document nobody is watching.
  doc.transact(() => {
    for (const update of updates) Y.applyUpdate(doc, update, 'history')
  })
  return doc
}

/** Close a burst and write it as one version. */
function close(key: string): void {
  const burst = bursts.get(key)
  if (!burst) return
  bursts.delete(key)
  if (burst.timer) clearTimeout(burst.timer)
  if (burst.updates.length === 0) return

  const merged = Y.mergeUpdates(burst.updates)
  const after = docFrom([burst.before, merged])
  /*
   * «До» берётся из памяти, а не разворачивается заново.
   *
   * Это тот же документ, который в прошлый раз был «после»: его тексты уже
   * посчитали и положили сюда. Разворачивать его второй раз — семь
   * миллисекунд блокировки цикла событий на нажатие клавиши в трёхмегабайтной
   * тетради. Запись пропадает только при перезапуске сервера, и тогда
   * разворачиваем, как раньше.
   */
  let was = digests.get(burst.sessionId)
  if (!was) {
    const before = docFrom([burst.before])
    was = new Map(cellsOf(before).map((c) => [c.id, c.source]))
    before.destroy()
  }
  const now = new Map(cellsOf(after).map((c) => [c.id, c.source]))
  const facts = describe(was, now)

  /*
   * A burst that changed no text is not a version.
   *
   * The document carries far more than what people write: every line a cell
   * prints, every run-state flip, every token the oracle streams. Recording
   * those would bury the timeline under "ran the notebook" — dozens of rows an
   * hour that nobody would ever want to go back to — and the one row that
   * matters, the edit before the cell broke, would be lost among them.
   *
   * So the filter is the whole point rather than an optimisation: history here
   * means the history of what the room wrote.
   */
  /*
   * Filtered from the TIMELINE, never from the RECORD.
   *
   * These are different things and they used to be one. The bytes of a burst
   * that changed no text were thrown away with its row, and Yjs does not
   * forgive that: every later update names the clocks it was built on, so a
   * replay that skips a burst reaches an update whose predecessor is missing
   * and quietly applies nothing from there on. Rebuilding any version after
   * the gap gave a document with the old cell order and none of the typing
   * since — and restoring it wrote that document over the live one, for
   * everybody. The row was invisible; the hole it left was not.
   *
   * So a burst with nothing to say still writes its bytes, as a `quiet` row
   * the list does not show. Same trick as the keyframe: present for replay,
   * absent from the story.
   *
   * Two things land here that describe() cannot see and that are not noise:
   * moving a cell (a clone with the same id and text — Y.Array has no move)
   * and changing its type. Both are structural facts the timeline should tell,
   * and one day will; today the important thing is that they no longer
   * corrupt everything recorded after them.
   */
  const quiet = facts.cells.length === 0

  let wrote = false
  try {
    appendVersion({
      sessionId: burst.sessionId,
      update: merged,
      kind: quiet ? 'quiet' : 'edit',
      // Один автор — его имя; двое и больше — «the room», что и есть правда.
      // Пустое множество — писал только сервер, и это тоже комната.
      authorId: burst.authors.size === 1 ? [...burst.authors][0] : null,
      createdAt: burst.lastAt,
      label: null,
      ...facts,
    })
    wrote = true
  } catch (err) {
    // A history that cannot be written must not stop the seminar being taught.
    console.error(`[history] could not record a version for ${burst.sessionId}`, err)
    gaps.add(burst.sessionId)
  }
  // The next version is measured from here, not from wherever the document
  // happens to be when somebody next presses a key. Двигается и после
  // неудачи: байтов всплеска всё равно больше нет, а следующая версия обязана
  // описывать разницу с тем, что в комнате на самом деле.
  /*
   * Один разворот документа в байты на закрытие, а не три.
   *
   * Те же самые байты нужны трижды — базовой точке, оценке «пора ли снимок» и
   * самому снимку, — и каждый раз кодировались заново. На трёхмегабайтной
   * тетради это по семь миллисекунд цикла событий за штуку, а закрытий на
   * оживлённой паре десятки.
   */
  const snapshot = Y.encodeStateAsUpdate(after)
  baselines.set(burst.sessionId, snapshot)
  shapes.set(burst.sessionId, shapeOf(after))
  digests.set(burst.sessionId, now)
  if (gaps.has(burst.sessionId)) {
    /*
     * Незаписанная строка — дыра в цепочке.
     *
     * Её байты уже не существуют, а следующая дельта сошлётся на такты,
     * которых в истории нет: повтор молча положит её в pending, лента замрёт
     * на состоянии до сбоя, и «Restore» любой строки после дыры запишет это
     * состояние поверх живой тетради. Закрывает дыру только целый документ,
     * поэтому комната помечена до первого удачного снимка — обычный keyframe
     * сюда не годится, он приходит по счёту байтов и может не прийти вовсе.
     */
    if (writeKeyframe(burst.sessionId, snapshot)) gaps.delete(burst.sessionId)
  } else if (wrote) {
    // Quiet rows count toward the keyframe interval too: they are replayed
    // like any other, so they are exactly what the interval is bounding.
    maybeKeyframe(burst.sessionId, snapshot, merged.byteLength)
  }
  after.destroy()
}

/**
 * Байты, накопленные с прошлого полного снимка, по комнатам.
 *
 * Живёт в памяти и переживает не всё: после перезапуска сервера счётчик
 * начинается заново, и первый снимок в комнате придёт по счёту строк. Это
 * дешевле, чем хранить его в базе ради оценки, которая всё равно приблизительна.
 */
const sinceKeyframe = new Map<string, number>()

/**
 * Полный снимок документа — когда дельты уже стоят как он сам.
 *
 * Правило было «каждые двадцать пять строк», и на трёхмегабайтной тетради оно
 * означало три мегабайта каждые двадцать пять нажатий: за пару такой семинар
 * писал сотни мегабайт снимков, между которыми лежало по сотне килобайт
 * настоящих правок. Считать надо не строки, а байты: полная копия имеет смысл
 * ровно тогда, когда дельт с прошлой копии накопилось столько же — тогда
 * история занимает вдвое больше документа, а не во сколько попало раз.
 *
 * Порог по строкам остаётся сверху: он ограничивает не место, а длину
 * повтора, и без него крошечная тетрадь с тысячей мелких правок собиралась бы
 * из тысячи кусков.
 */
function maybeKeyframe(sessionId: string, snapshot: Uint8Array, wrote: number): void {
  const size = snapshot.byteLength
  const grown = (sinceKeyframe.get(sessionId) ?? 0) + wrote
  sinceKeyframe.set(sessionId, grown)

  const byBytes = grown >= Math.max(size, KEYFRAME_MIN_BYTES)
  const byRows = versionCount(sessionId) % KEYFRAME_EVERY === 0
  if (!byBytes && !byRows) return

  writeKeyframe(sessionId, snapshot)
}

/**
 * Полный снимок документа отдельной строкой. Говорит, удалось ли записать.
 *
 * Байтами, а не документом: их уже посчитал тот, кто зовёт, и второй
 * `encodeStateAsUpdate` подряд — это ровно та же работа второй раз.
 */
function writeKeyframe(sessionId: string, snapshot: Uint8Array): boolean {
  try {
    appendVersion({
      sessionId,
      update: snapshot,
      kind: 'keyframe',
      authorId: null,
      createdAt: Date.now(),
      label: null,
      summary: '',
      added: 0,
      removed: 0,
      cells: [],
    })
  } catch (err) {
    console.error(`[history] could not write a keyframe for ${sessionId}`, err)
    return false
  }
  sinceKeyframe.set(sessionId, 0)
  /*
   * Потолок истории — здесь и только здесь.
   *
   * Единственный момент, когда обрезать безопасно: снимок только что лёг, и
   * повтор всего, что после него, ни на одну выброшенную строку не смотрит.
   * `trimHistory` режет целыми отрезками между снимками — почему именно так,
   * подробно сказано у неё; сама база ничего не убирает, потому что «когда
   * можно» знает эта сторона, а не она.
   */
  try {
    const dropped = trimHistory(sessionId)
    if (dropped > 0) {
      console.log(`[history ${sessionId}] история упёрлась в потолок: убрано ${dropped} строк`)
    }
  } catch (err) {
    // Не убралось — не беда семинара: место кончится позже, а версия записана.
    console.error(`[history] could not trim history for ${sessionId}`, err)
  }
  return true
}

/**
 * Могло ли это обновление изменить состав или порядок ячеек.
 *
 * Без транзакции ответ «могло»: не знать — не то же самое, что «нет».
 */
function mayHaveReshaped(doc: Y.Doc, transaction: Y.Transaction | undefined): boolean {
  if (!transaction) return true
  let arrays = false
  transaction.changed.forEach((_keys, type) => {
    if (type instanceof Y.Array) arrays = true
  })
  if (!arrays) return false
  return shapingArrays(doc).some((array) => transaction.changed.has(array))
}

/**
 * Record one update against a session.
 *
 * Called from the document's own update handler, so it sees every change the
 * room makes — including ones that arrive from a client the server never asked.
 */
export function record(
  sessionId: string,
  doc: Y.Doc,
  update: Uint8Array,
  authorId: string | null,
  /*
   * Транзакция, породившая обновление, — если её знает тот, кто зовёт.
   *
   * Нужна ровно для одного: понять, могла ли форма тетради измениться, не
   * пересобирая её. Форма — это строка из имён всех ячеек, и раньше её
   * склеивали на КАЖДОЕ обновление: на каждое нажатие любого из участников и
   * на каждый сброс буфера вывода. На тетради в пятьсот ячеек это шесть
   * килобайт мусора на кадр там, где кадров больше всего.
   *
   * Форму меняет только запись в лист ячеек или в список тетрадей; набор текста
   * идёт в `Y.Text` внутри ячейки и трогать её не может. Не сказали, что
   * менялось (так зовут тесты), — считаем, как раньше.
   */
  transaction?: Y.Transaction,
): void {
  const key = sessionId
  const existing = bursts.get(key)
  const now = Date.now()

  /*
   * Второй человек присоединяется ко всплеску, а не закрывает его.
   *
   * «Другой человек — другое дело» звучит правильно и стоит дорого: двое,
   * печатающих одновременно, чередуют нажатия, каждое закрывает предыдущий
   * всплеск, и получается версия на нажатие — сорок строк истории за минуту
   * работы, из которых чекпоинт «до упражнения» вылетает за окно.
   *
   * Всплеск, в который писали двое, записывается без автора и читается как
   * «the room» — это честнее, чем приписать его тому, кто нажал последним, и
   * ровно так же честно, как строка, которую пишет сам сервер.
   *
   * Сервер в этот счёт не входит. Ядро пишет outputs, состояние и номер
   * запуска, оракул стримит ответ — всё это приходит сюда без автора, и всплеск
   * с ними становился двухавторным: студентка правит ячейку, рядом крутится
   * чужой цикл, и в ленте «the room · edited cell 03» без имени и цвета. Двоих
   * не было. Комната — это когда людей двое, а не когда рядом работала ячейка.
   */
  if (existing && authorId !== null) existing.authors.add(authorId)

  let burst = bursts.get(key)
  if (!burst) {
    burst = {
      sessionId,
      authors: authorId === null ? new Set() : new Set([authorId]),
      updates: [],
      before: baselines.get(key) ?? Y.encodeStateAsUpdate(new Y.Doc()),
      openedAt: now,
      lastAt: now,
      chars: 0,
      timer: null,
      shape: shapes.get(key) ?? '',
    }
    bursts.set(key, burst)
  }

  burst.updates.push(update)
  burst.lastAt = now
  // Байты сервера всплеск не растят: поток вывода резал чужой набор на строки
  // по четыре килобайта, а «человек написал много» — это про то, что написал
  // человек. Сверху всё равно стоит BURST_MAX_MS.
  if (authorId !== null) burst.chars += update.byteLength

  /*
   * Adding, deleting or moving a cell closes the burst at once.
   *
   * Typing is a stream and wants grouping; changing the shape of the notebook
   * is a discrete act, and it is the act people come to this panel to undo. A
   * deleted cell that takes twelve seconds of silence to appear in the history
   * is missing exactly when it is being looked for — and the silence is not
   * even likely, because the person who deleted it usually keeps working.
   */
  if (mayHaveReshaped(doc, transaction) && shapeOf(doc) !== burst.shape) {
    close(key)
    return
  }

  /*
   * Потолок всплеска — на КАЖДОГО, кто в него пишет.
   *
   * Всплеск один на комнату, и порог в четыре килобайта человеческих байтов —
   * это примерно сто тридцать нажатий. Один печатающий закрывает всплеск раз в
   * полминуты; пятьсот печатающих одновременно набирают эти сто тридцать
   * нажатий за долю секунды — и комната платила бы `mergeUpdates` + полный
   * разворот документа + запись в SQLite по десятку раз в секунду, а лента
   * версий заполнялась бы строками «the room» быстрее, чем её можно читать.
   *
   * Строка истории — это «одно дело одного человека»; когда людей в ней N,
   * столько же и дел, поэтому порог растёт вместе с ними. Сверху по-прежнему
   * стоит `BURST_MAX_MS`, так что дольше своей минуты всплеск не живёт при
   * любом числе авторов.
   */
  const room = Math.max(1, burst.authors.size)
  if (burst.chars >= BURST_MAX_CHARS * room || now - burst.openedAt >= BURST_MAX_MS) {
    close(key)
    return
  }

  if (burst.timer) clearTimeout(burst.timer)
  /*
   * Хвост всплеска — под своим перехватом.
   *
   * Это единственный путь, по которому `close` вызывается из таймера: он
   * склеивает обновления, разворачивает документ и пишет в SQLite, и всё это
   * без вызывающего, который поймал бы бросок. Из колбэка `setTimeout` он
   * уходит в `uncaughtException` (server/src/index.ts), а тот уводит процесс
   * со ВСЕМИ комнатами инстанса — из-за одной ленты одной комнаты.
   *
   * Закрытым всплеск считается в любом случае: `close` снимает его с карты
   * первой же строкой, до всякой работы, — иначе неудачная запись заперла бы
   * ленту комнаты навсегда, и следующие правки копились бы в мёртвом всплеске
   * до перезапуска.
   */
  burst.timer = setTimeout(() => {
    try {
      close(key)
    } catch (err) {
      console.error(`[history] could not close the burst for ${key}`, err)
    }
  }, BURST_IDLE_MS)
  // A pending burst must not be the reason the process stays alive; shutdown
  // flushes them all on the way out.
  burst.timer.unref?.()
}

/** Close whatever is open for one session — before a read, or on shutdown. */
export function flushHistory(sessionId: string): void {
  close(sessionId)
}

export function flushAllHistory(): void {
  for (const key of [...bursts.keys()]) close(key)
}

/**
 * Отпустить память об истории комнаты, ничего не потеряв.
 *
 * Не то же, что `discardBurst`: тот выбрасывает начатую строку вместе с
 * семинаром, а здесь семинар остаётся — уходит только комната из памяти
 * процесса (collab/index.ts · выселение простаивающих). Поэтому открытый
 * всплеск сперва дописывается строкой: это чья-то работа.
 *
 * Всё, что снимается, комната отстроит сама при следующем входе: `beginHistory`
 * заново снимает базовую точку, форму и тексты с поднятого из снимка документа
 * — ровно так же, как после перезапуска сервера.
 */
export function forgetHistory(sessionId: string): void {
  close(sessionId)
  baselines.delete(sessionId)
  shapes.delete(sessionId)
  digests.delete(sessionId)
  sinceKeyframe.delete(sessionId)
  gaps.delete(sessionId)
  forgetCache(sessionId)
}

/** Drop a session's open burst without writing it. Used when a seminar is deleted. */
export function discardBurst(sessionId: string): void {
  baselines.delete(sessionId)
  shapes.delete(sessionId)
  digests.delete(sessionId)
  sinceKeyframe.delete(sessionId)
  gaps.delete(sessionId)
  const burst = bursts.get(sessionId)
  if (!burst) return
  bursts.delete(sessionId)
  if (burst.timer) clearTimeout(burst.timer)
}

/* ------------------------------------------------------------------ reading */

/**
 * The notebook as of one version.
 *
 * Cached by (session, seq) because the timeline is scrubbed: a person clicking
 * down the list would otherwise pay a rebuild per click, and clicking back up
 * would pay again for versions already visited. Entries are dropped when the
 * session's history grows, since a new version cannot change an old one but a
 * restore can add rows that shift what "latest" means.
 */
const rebuilt = new Map<string, { cells: HistoricCell[]; at: number }>()
const CACHE_MAX = 64

export function cellsAt(sessionId: string, seq: number): HistoricCell[] {
  const key = `${sessionId}:${seq}`
  const hit = rebuilt.get(key)
  if (hit) return hit.cells

  const doc = docFrom(updatesUpTo(sessionId, seq))
  const cells = cellsOf(doc)
  doc.destroy()

  if (rebuilt.size >= CACHE_MAX) {
    // Oldest first. A seminar visits versions in bursts of interest, so the
    // ones worth keeping are the ones touched most recently.
    let oldestKey: string | null = null
    let oldest = Infinity
    for (const [k, v] of rebuilt) {
      if (v.at < oldest) {
        oldest = v.at
        oldestKey = k
      }
    }
    if (oldestKey) rebuilt.delete(oldestKey)
  }
  rebuilt.set(key, { cells, at: Date.now() })
  return cells
}

/** Forget everything cached for a session — after a restore, or a delete. */
export function forgetCache(sessionId: string): void {
  for (const key of [...rebuilt.keys()]) {
    if (key.startsWith(`${sessionId}:`)) rebuilt.delete(key)
  }
}

/* -------------------------------------------------------------------- diff */

/** Record a version that is not a burst: a checkpoint, a restore, the first state. */
export function mark(
  sessionId: string,
  doc: Y.Doc,
  kind: VersionKind,
  authorId: string | null,
  label: string | null,
  summary: string,
  targetSeq: number | null = null,
): number {
  flushHistory(sessionId)
  /*
   * У возврата версии есть что показать, и он это показывал как «ничего».
   *
   * `added: 0, removed: 0, cells: []` — правда для чекпоинта: его ставят
   * поверх текста, ничего не меняя. Для возврата это неправда: он переписывает
   * ячейки, и панель, у которой список изменений пуст, честно печатала «This
   * moment was marked, not edited» — над строкой, которая только что заменила
   * половину тетради. Ровно ту правку, ради которой в историю и лезут.
   *
   * Считается так же, как для всплеска: что было до, что стало после.
   */
  const now = new Map(cellsOf(doc).map((c) => [c.id, c.source]))
  const facts =
    kind === 'restore'
      ? describe(digests.get(sessionId) ?? new Map(), now)
      : { summary: '', added: 0, removed: 0, cells: [] as string[] }

  const snapshot = Y.encodeStateAsUpdate(doc)
  const seq = appendVersion({
    sessionId,
    update: snapshot,
    kind,
    authorId,
    createdAt: Date.now(),
    label,
    // Слова возврата — свои («restored the version»), а не те, что
    // сочинил describe: важно, что это возврат, а не что «отредактировали 3».
    summary,
    added: facts.added,
    removed: facts.removed,
    cells: facts.cells,
    targetSeq,
  })
  // Строка с целым документом закрывает дыру не хуже снимка: с неё повтор
  // начинается заново.
  gaps.delete(sessionId)
  baselines.set(sessionId, snapshot)
  shapes.set(sessionId, shapeOf(doc))
  digests.set(sessionId, now)
  forgetCache(sessionId)
  return seq
}

/**
 * Put a version's text back into the live document.
 *
 * The CRDT is not rewound. Rewinding means rolling back state vectors that
 * every browser in the room is holding, and the next keystroke from any of them
 * would arrive against a document that no longer matches — the room would tear.
 * So the old content is written as an ordinary edit: it merges the way every
 * edit merges, everybody sees it at once, and because it is an edit it becomes
 * a version itself, which is what makes a restore undoable.
 *
 * Returns how many cells actually changed, so a restore that would do nothing
 * does not leave a row in the timeline claiming it did something.
 */
/**
 * Put the cells named by `order` back in that order, in place.
 *
 * Cells the version did not have keep their relative places at the end: they
 * were written after it, and a restore is not a reason to throw them away.
 * Returns how many cells actually moved, so a restore that only reorders is
 * still recorded as having changed something.
 */
function reorder(cells: Y.Array<YCell>, order: string[], busy: ReadonlySet<string>): number {
  const wanted = new Map(order.map((id, i) => [id, i]))
  const current = cells.toArray()
  const target = [...current].sort((a, b) => {
    const ai = wanted.get(a.get('id') as string)
    const bi = wanted.get(b.get('id') as string)
    if (ai === undefined && bi === undefined) return current.indexOf(a) - current.indexOf(b)
    if (ai === undefined) return 1
    if (bi === undefined) return -1
    return ai - bi
  })
  const same = target.every((cell, i) => cell === current[i])
  if (same) return 0

  /*
   * Клон уносит с собой чужие нажатия.
   *
   * У `Y.Array` нет перемещения, поэтому переставить ячейку можно только
   * пересоздав её клоном, — а нажатия, ушедшие в старый `Y.Text` за круг до
   * сервера, адресованы удалённой структуре: гейт их пропускает (запись в
   * надгробие никому не видна), и символы пропадают у печатающего молча,
   * Ctrl+Z их не вернёт. Пересобирать клонами ВЕСЬ лист значило обокрасть на
   * это всех, кто печатал в ту секунду, — хотя возврат версии обычно двигает
   * одну-две ячейки.
   *
   * Поэтому на месте остаётся самая длинная цепочка ячеек, уже стоящих в
   * нужном порядке друг относительно друга (наибольшая возрастающая
   * подпоследовательность по целевому месту), а клонами пересоздаются только
   * остальные. Ячейка с чьим-то курсором весит больше всего листа: где выбор
   * есть — как при перестановке двух соседок местами, — остаётся та, в которой
   * сейчас печатают. Лист короткий (десятки ячеек), так что квадратичный
   * перебор здесь дешевле одного лишнего клона.
   */
  const place = new Map(target.map((cell, i) => [cell, i]))
  const weigh = (cell: YCell) => (busy.has(cell.get('id') as string) ? current.length + 1 : 1)
  const best = current.map((cell) => weigh(cell))
  const prev = current.map(() => -1)
  let tail = 0
  for (let i = 0; i < current.length; i++) {
    for (let j = 0; j < i; j++) {
      if (place.get(current[j])! > place.get(current[i])!) continue
      if (best[j] + weigh(current[i]) <= best[i]) continue
      best[i] = best[j] + weigh(current[i])
      prev[i] = j
    }
    if (best[i] > best[tail]) tail = i
  }
  const keep = new Set<YCell>()
  for (let i = tail; i >= 0; i = prev[i]) keep.add(current[i])

  // Клоны — до удаления: у вычеркнутой ячейки читать уже нечего.
  const moving = target.filter((cell) => !keep.has(cell))
  const clones = new Map(moving.map((cell) => [cell, cloneCell(cell)]))
  for (let i = current.length - 1; i >= 0; i--) if (!keep.has(current[i])) cells.delete(i, 1)
  // Сверху вниз: к своему целевому месту ячейка приезжает, когда все, кому
  // стоять левее, уже стоят, — значит место и есть индекс вставки.
  for (const cell of moving) cells.insert(place.get(cell)!, [clones.get(cell)!])
  return moving.length
}

/**
 * Куда вернуть ячейку, которой в тетради больше нет.
 *
 * По соседям из версии: сразу за ближайшей предшествующей, которая ещё жива, а
 * если таких нет — перед ближайшей следующей. Не нашлось ни одной — в конец.
 */
function placeFor(wanted: HistoricCell[], id: string, live: Map<string, number>): number {
  const at = wanted.findIndex((cell) => cell.id === id)
  for (let i = at - 1; i >= 0; i--) {
    const index = live.get(wanted[i].id)
    if (index !== undefined) return index + 1
  }
  for (let i = at + 1; i < wanted.length; i++) {
    const index = live.get(wanted[i].id)
    if (index !== undefined) return index
  }
  return live.size
}

export function restoreInto(
  sessionId: string,
  doc: Y.Doc,
  seq: number,
  authorId: string | null,
  onlyCell: string | null,
  /*
   * В каких ячейках сейчас стоят курсоры — чтобы перестановка (`reorder`)
   * оставила на месте те, в которых печатают. Параметром, а не импортом из
   * `collab/index.ts`: присутствие живёт в сокетах, а этот модуль зовут и тесты,
   * и маршрут; не сказали — считаем, что курсоров нет, и выбор решает длина.
   */
  busy: ReadonlySet<string> = new Set(),
): number {
  const wanted = cellsAt(sessionId, seq)
  let changed = 0

  doc.transact(() => {
    /*
     * История — про ТЕТРАДЬ КОМНАТЫ, и это её корень, а не «первая по списку».
     *
     * Разница видна ровно в одном случае и стоит дорого: тетрадь комнаты убрали,
     * первой стала другая — и возврат версии вписал бы в неё ячейки чужого
     * листа. Корень тут прибит намеренно; всё, что этот модуль читает и пишет,
     * читает и пишет его.
     *
     * Если тетради комнаты в списке больше нет, возврат версии её и
     * возвращает: это и есть то, о чём просят, нажимая «вернуть».
     */
    if (!bookList(doc).some((book) => book.root === CELLS_KEY)) {
      addBook(doc, freeBookName(doc), CELLS_KEY)
    }
    const cells = doc.getArray<YCell>(CELLS_KEY)
    const live = new Map(cells.toArray().map((cell, index) => [cell.get('id') as string, index]))

    for (const want of wanted) {
      if (onlyCell && want.id !== onlyCell) continue
      const index = live.get(want.id)
      if (index === undefined) {
        /*
         * The cell was deleted after this version, so it is recreated — with
         * its own id, not a fresh one. A new id made the restore
         * unrepeatable: press it twice and the notebook had two copies,
         * because the second pass could not find what the first had put back.
         *
         * Место при полном откате решает reorder ниже, когда все ячейки уже
         * есть. Одну ячейку reorder намеренно не трогает, поэтому её место
         * считается здесь: «Restore this cell» на третьей из двадцати клала её
         * двадцатой, под все остальные, и поднимать её приходилось руками.
         */
        const revived = createCell(want.type, want.source, want.id)
        if (onlyCell) cells.insert(placeFor(wanted, want.id, live), [revived])
        else cells.push([revived])
        changed++
        continue
      }
      const cell = cells.get(index) as YCell
      const source = cell.get('source') as Y.Text | undefined
      let touched = false
      /*
       * Тип ячейки — тоже часть версии.
       *
       * Ячейку с рабочим кодом переключили в markdown, откат возвращал текст —
       * и оставлял markdown: Run по ней не работает, «Run All» её пропускает.
       * А если менялся ровно тип, откат выходил отсюда, не сделав ничего и не
       * оставив строки, — кнопка «вернуть» молчала.
       */
      if (cell.get('type') !== want.type) {
        cell.set('type', want.type)
        touched = true
      }
      if (source && source.toString() !== want.source) {
        // Не «весь текст исчез, появился другой»: у всех, кто стоит в этой
        // ячейке, курсор уехал бы в начало. Меняется только то, что отличается.
        replaceText(source, want.source)
        /*
         * Возврат версии снимает с результата его номер.
         *
         * Это самое несогласованное место, какое было: запуск, который вполне
         * может дать тот же самый результат, стирал вывод целиком, а возврат
         * версии — событие, которое результат недвусмысленно обесценивает, —
         * не трогал ничего. Теперь оба говорят одно: вывод остаётся как
         * свидетельство того, что ячейка показывала, и перестаёт числиться за
         * кодом, которого в ней больше нет.
         *
         * `state` тоже: «ok», записанное про исчезнувший код, — не исход этой
         * ячейки.
         */
        cell.set('execCount', null)
        cell.set('ranMs', null)
        cell.set('state', 'idle')
        touched = true
      }
      if (touched) changed++
    }

    /*
     * Order is part of the version too.
     *
     * "Restore the whole notebook" put every text back and left the cells
     * wherever they had since been dragged, which is not the notebook anybody
     * pressed the button for. Only for a whole restore: putting one cell back
     * is about that cell, and shuffling the sheet around it would be a
     * surprise nobody asked for.
     */
    if (!onlyCell)
      changed += reorder(
        cells,
        wanted.map((w) => w.id),
        busy,
      )
  }, RESTORE_ORIGIN)

  if (changed > 0) {
    /*
     * Без времени в словах: его собирал сервер по своему часовому поясу (в
     * контейнере это UTC), а строки ленты рисует браузер по своему — подпись
     * «restored the version from 15:04» указывала на строку, которой в списке
     * нет. Что именно вернули, говорит `targetSeq`; часы рисует тот, кто
     * смотрит.
     */
    mark(
      sessionId,
      doc,
      'restore',
      authorId,
      null,
      onlyCell ? tr("server.restoredACell.0f74d0") : tr("server.restoredAVersion.80c38a"),
      seq,
    )
  }
  return changed
}
