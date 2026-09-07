/**
 * Состояние лекции комнаты. Словарь — в shared/lecture.ts, здесь только память.
 *
 * В памяти процесса, рядом с общим экраном и очередью запуска, а не в документе
 * комнаты: лекция — это час жизни комнаты, а не её содержимое. Штрих
 * карандашом, попавший в общий документ, стал бы версией в истории, поехал бы в
 * снимок и вернулся бы по Ctrl+Z — три способа испортить то, ради чего лекцию
 * ведут. Цена названа вслух: перезапуск сервера гасит проекцию и стирает
 * чернила, ровно как гасит общий экран и очередь.
 */
import {
  MAX_INKED_PAGES,
  MAX_POINTS_PER_MESSAGE,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_PAGE,
  type InkFull,
  type InkStroke,
  type LectureState,
} from '@shared/lecture'

interface Room {
  state: LectureState
  /** Штрихи по страницам. Страница без чернил в карте не заводится. */
  ink: Map<number, InkStroke[]>
  /**
   * Номер последней перемены в чернилах — на весь процесс, а не на комнату.
   *
   * Приветственная пачка везёт опоздавшему показываемую страницу, и собирается
   * она `inkPageOf` + `JSON.stringify`. Пока зал подключается по одному, цена
   * незаметна; после сбоя сети пятьсот вкладок возвращаются в одну секунду —
   * и смотрят все одну и ту же страницу, ту, что показывает ведущий, так что
   * пятьсот одинаковых сборок ложатся в цикл событий там, где хватило бы
   * одной. Кадр кэширует control.ts по паре «этот номер + страница»; сквозной
   * счётчик (а не «версия комнаты») нужен затем, чтобы начатая заново лекция
   * не совпала номером с прошлой.
   */
  rev: number
}

const rooms = new Map<string, Room>()

let revisions = 0

/*
 * Потолки чернил лежат в shared/lecture.ts — все четыре, теми же числами.
 *
 * Это не переезд ради порядка: знать их обязан и тот, кто рисует. Пока они
 * стояли здесь единственной копией, пульт не мог отличить отказ от потерянного
 * кадра — восемь раз досылал штрих целиком и через четыре секунды убирал его с
 * листа молча, а у зала линии не было вовсе.
 */

export function lectureOf(sessionId: string): LectureState | null {
  return rooms.get(sessionId)?.state ?? null
}

/** Все чернила комнаты — целиком, всеми страницами сразу. */
export function inkOf(sessionId: string): InkStroke[] {
  const room = rooms.get(sessionId)
  if (!room) return []
  return [...room.ink.values()].flat()
}

/**
 * Чернила ОДНОЙ страницы — тому, кто на неё смотрит.
 *
 * Мера приветственной пачки и ответа на вопрос вкладки (`ink:page`): страниц у
 * лекции до двухсот, а смотрят в каждый момент одну, и возить все — это около
 * мегабайта на сокет там, где нужны килобайты. Кто вошёл не на ту страницу или
 * открыл ленту эскизов, спрашивает недостающие сам.
 *
 * Копия списка, а не сама память комнаты: он уезжает в кадр, и перо, дописавшее
 * точку в тот же миг, не должно менять уже отданное.
 */
export function inkPageOf(sessionId: string, page: number): InkStroke[] {
  const strokes = rooms.get(sessionId)?.ink.get(Math.trunc(page))
  return strokes ? [...strokes] : []
}

/**
 * ОПИСЬ исписанных страниц: их номера, без единого штриха.
 *
 * Едет рядом с каждым полным кадром чернил и стоит десятки байт там, где сами
 * чернила стоят мегабайт. Без неё вкладка, получившая одну страницу, не
 * отличает «на остальных пусто» от «остальные не приехали»: пульт считает по
 * чернилам, сколько чистых листов заведено, и лента эскизов по ним же знает,
 * что просить.
 *
 * Правило одно на оба конца — «есть хоть один штрих» (shared/lecture.ts ·
 * `inkPagesOf`, оно же считает опись на вкладке). Ключи карты сами по себе
 * мерой не годятся: страница заводится под первый штрих, а ластик, снявший
 * последний, ключ оставляет — и такая страница, оставшись в описи, заставила
 * бы пульт держать лишний лист и раз за разом спрашивать чернила, которых нет.
 * Отсюда `strokes.length > 0`, а не `[...room.ink.keys()]`.
 *
 * По возрастанию: опись читается человеком в журнале, а порядок ключей карты —
 * порядок первых штрихов, а не страниц.
 */
export function inkedPagesOf(sessionId: string): number[] {
  const room = rooms.get(sessionId)
  if (!room) return []
  const pages: number[] = []
  for (const [page, strokes] of room.ink) if (strokes.length > 0) pages.push(page)
  return pages.sort((a, b) => a - b)
}

/**
 * Номер последней перемены в чернилах. Меняется — прошлый кадр устарел.
 *
 * Ноль — чернил нет вовсе (лекции нет): кэшировать нечего.
 */
export function inkRevision(sessionId: string): number {
  return rooms.get(sessionId)?.rev ?? 0
}

export function startLecture(
  sessionId: string,
  state: Omit<LectureState, 'page' | 'blank' | 'startedAt'>,
): LectureState {
  const room: Room = {
    state: { ...state, page: 1, blank: false, startedAt: Date.now() },
    ink: new Map(),
    rev: ++revisions,
  }
  rooms.set(sessionId, room)
  return room.state
}

/** Лекция кончилась: гаснет проекция, стираются чернила. */
export function stopLecture(sessionId: string): void {
  rooms.delete(sessionId)
}

/**
 * Ведёт ли этот человек лекцию.
 *
 * Не право, а факт: право проверяется отдельно (правило `board`), а это про то,
 * что страницу двигает ТОТ, кто её ведёт, — иначе двое преподавателей в одной
 * комнате будут перелистывать друг друга.
 */
export function isPresenter(sessionId: string, participantId: string): boolean {
  return rooms.get(sessionId)?.state.by === participantId
}

/**
 * Передать пульт другому преподавателю, НЕ начиная лекцию заново.
 *
 * Второй ведущий берёт управление тем же `lecture:start` по тому же файлу —
 * другого сообщения у него нет. Без этой развилки такое нажатие уходило бы в
 * `startLecture`, а он заводит комнату с нуля: страница возвращается на первую,
 * чернила стираются все до одного, часы лекции начинают отсчёт сначала. То
 * есть нажатие «взять пульт» на сороковой минуте стирало бы сорок минут
 * разметки — и делало бы это на проекторе, при всех.
 *
 * Меняется поэтому ровно то, что значит «кто ведёт»: имя, подпись и цвет
 * указки. Страница, чернила, пауза и отметка начала — не наши: они про лекцию,
 * а не про руки, которые её ведут.
 *
 * По ТОМУ ЖЕ файлу: другой документ — это уже другая лекция, и начинать её
 * надо начисто. Возвращает новое состояние или `null`, если передавать нечего,
 * — как и остальные правки состояния в этом файле.
 */
export function handOver(
  sessionId: string,
  file: string,
  by: string,
  byName: string,
  color: string,
): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room || room.state.file !== file) return null
  room.state = { ...room.state, by, byName, color }
  return room.state
}

/**
 * Сколько чистых листов разрешено завести.
 *
 * Их номера отрицательные и заводятся нажатием — то есть их количество это то,
 * сколько раз преподаватель нажал кнопку. Потолок здесь не про злой умысел, а
 * про заевшую кнопку: страницы с чернилами держатся в памяти, и уходить она
 * должна конечно.
 */
const MAX_BOARDS = 50

export function turnTo(sessionId: string, page: number): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room) return null
  // Ноль — не страница: это мусор из вкладки. Минус — чистый лист (см. словарь).
  const asked = Math.trunc(page)
  if (asked === 0 || !Number.isFinite(asked)) return null
  const wanted = asked < 0 ? Math.max(-MAX_BOARDS, asked) : asked
  if (room.state.page === wanted) return null
  room.state = { ...room.state, page: wanted }
  return room.state
}

export function setBlank(sessionId: string, blank: boolean): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room || room.state.blank === blank) return null
  room.state = { ...room.state, blank }
  return room.state
}

/**
 * Дописать штрих.
 *
 * Точки приезжают пачками по мере рисования, а не целым штрихом в конце: зал
 * должен видеть линию, пока её ведут, — иначе указка на слайде появляется
 * через секунду после того, как о ней сказали вслух.
 *
 * Возвращает то, что надо разослать: только НОВЫЕ точки, а не весь штрих.
 * Штрих в тысячу точек, рассылаемый на каждую двадцатую, — это гигабайты
 * трафика на лекцию.
 *
 * И различает два «нет». `null` — добавлять нечего: лекции нет, страницы нет,
 * точек меньше двух. `full` — упёрлись в потолок, и об этом надо СКАЗАТЬ:
 * раньше оба случая возвращали `null`, сервер молчал, а пульт восемь раз
 * досылал штрих целиком и через четыре секунды убирал его с листа без единого
 * слова. Кто именно скажет — дело зовущего (control.ts · `case 'ink'`).
 */
export type InkAdded =
  | { stroke: InkStroke; full?: undefined }
  | { stroke?: undefined; full: InkFull }

export function addInk(
  sessionId: string,
  patch: { id: string; page: number; color: string; width: number; points: number[] },
): InkAdded | null {
  const room = rooms.get(sessionId)
  if (!room) return null
  // Чистый лист — такая же страница, только с отрицательным номером.
  const page = Math.trunc(patch.page)
  if (page === 0 || !Number.isFinite(page)) return null
  const points = patch.points.slice(0, MAX_POINTS_PER_MESSAGE).filter(Number.isFinite)
  if (points.length < 2) return null

  const strokes = room.ink.get(page) ?? []
  if (!room.ink.has(page)) {
    if (room.ink.size >= MAX_INKED_PAGES) return { full: 'too-many-pages' }
    room.ink.set(page, strokes)
  }

  const existing = strokes.find((stroke) => stroke.id === patch.id)
  if (existing) {
    if (existing.points.length >= MAX_POINTS_PER_STROKE) return { full: 'stroke-full' }
    existing.points.push(...points)
    room.rev = ++revisions
    return { stroke: { ...existing, points } }
  }
  if (strokes.length >= MAX_STROKES_PER_PAGE) return { full: 'page-full' }
  const made: InkStroke = {
    id: patch.id,
    page,
    color: patch.color,
    width: patch.width,
    points: [...points],
  }
  strokes.push(made)
  room.rev = ++revisions
  return { stroke: made }
}

/** Убрать последний штрих на этой странице. Возвращает его имя, если было что убирать. */
export function undoInk(sessionId: string, page: number): string | null {
  const room = rooms.get(sessionId)
  const strokes = room?.ink.get(page)
  if (!room || !strokes || strokes.length === 0) return null
  room.rev = ++revisions
  return strokes.pop()?.id ?? null
}

/**
 * Стереть один штрих — тот, по которому провели ластиком.
 *
 * Отдельно от `undoInk`: отмена снимает ПОСЛЕДНИЙ, а ластик — тот, до которого
 * дотронулись, и это разные жесты. Возвращает, был ли он там: рассылать
 * «сотрите штрих, которого нет» значит заставлять двадцать браузеров
 * перерисовывать страницу на пустом месте.
 */
export function eraseInk(sessionId: string, page: number, id: string): boolean {
  const room = rooms.get(sessionId)
  const strokes = room?.ink.get(page)
  if (!room || !strokes) return false
  const at = strokes.findIndex((stroke) => stroke.id === id)
  if (at === -1) return false
  strokes.splice(at, 1)
  room.rev = ++revisions
  return true
}

/** Стереть страницу целиком, или всю лекцию, если страница не названа. */
export function clearInk(sessionId: string, page?: number): void {
  const room = rooms.get(sessionId)
  if (!room) return
  if (page === undefined) room.ink.clear()
  else room.ink.delete(page)
  room.rev = ++revisions
}

/**
 * Файл лекции переехал.
 *
 * Переименование — обычный ход дела: преподаватель правит имя в дереве, а
 * лекция идёт. Без этой строки проекция осталась бы показывать путь, которого
 * на диске уже нет, — то есть погасла бы у всех, кроме того, у кого документ
 * уже открыт.
 */
export function moveLecture(sessionId: string, from: string, to: string): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room || room.state.file !== from) return null
  room.state = { ...room.state, file: to }
  return room.state
}

/** Комнату удалили или процесс останавливается. */
export function forgetLecture(sessionId: string): void {
  rooms.delete(sessionId)
}
