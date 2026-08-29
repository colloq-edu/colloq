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
import type { InkStroke, LectureState } from '@shared/lecture'

interface Room {
  state: LectureState
  /** Штрихи по страницам. Страница без чернил в карте не заводится. */
  ink: Map<number, InkStroke[]>
}

const rooms = new Map<string, Room>()

/**
 * Потолки. Ни один из них не про злой умысел — все про палец, забытый на
 * экране, и про лекцию, которая идёт третий час.
 */
const MAX_STROKES_PER_PAGE = 600
const MAX_POINTS_PER_STROKE = 4_000
const MAX_POINTS_PER_MESSAGE = 512
/*
 * Потолок на число исписанных страниц. Он тут не ради памяти — ради
 * приветственной пачки: `inkOf` отдаёт опоздавшему ВСЕ чернила лекции одним
 * кадром, и трёхсотстраничная методичка, размеченная от корки до корки, стала
 * бы мегабайтом, который каждый вошедший ждёт до первой страницы.
 */
const MAX_INKED_PAGES = 200

export function lectureOf(sessionId: string): LectureState | null {
  return rooms.get(sessionId)?.state ?? null
}

/** Все чернила комнаты — тому, кто только что подключился. */
export function inkOf(sessionId: string): InkStroke[] {
  const room = rooms.get(sessionId)
  if (!room) return []
  return [...room.ink.values()].flat()
}

export function startLecture(
  sessionId: string,
  state: Omit<LectureState, 'page' | 'blank' | 'startedAt'>,
): LectureState {
  const room: Room = {
    state: { ...state, page: 1, blank: false, startedAt: Date.now() },
    ink: new Map(),
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
 */
export function addInk(
  sessionId: string,
  patch: { id: string; page: number; color: string; width: number; points: number[] },
): InkStroke | null {
  const room = rooms.get(sessionId)
  if (!room) return null
  // Чистый лист — такая же страница, только с отрицательным номером.
  const page = Math.trunc(patch.page)
  if (page === 0 || !Number.isFinite(page)) return null
  const points = patch.points.slice(0, MAX_POINTS_PER_MESSAGE).filter(Number.isFinite)
  if (points.length < 2) return null

  const strokes = room.ink.get(page) ?? []
  if (!room.ink.has(page)) {
    if (room.ink.size >= MAX_INKED_PAGES) return null
    room.ink.set(page, strokes)
  }

  const existing = strokes.find((stroke) => stroke.id === patch.id)
  if (existing) {
    if (existing.points.length >= MAX_POINTS_PER_STROKE) return null
    existing.points.push(...points)
    return { ...existing, points }
  }
  if (strokes.length >= MAX_STROKES_PER_PAGE) return null
  const made: InkStroke = {
    id: patch.id,
    page,
    color: patch.color,
    width: patch.width,
    points: [...points],
  }
  strokes.push(made)
  return made
}

/** Убрать последний штрих на этой странице. Возвращает его имя, если было что убирать. */
export function undoInk(sessionId: string, page: number): string | null {
  const strokes = rooms.get(sessionId)?.ink.get(page)
  if (!strokes || strokes.length === 0) return null
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
  const strokes = rooms.get(sessionId)?.ink.get(page)
  if (!strokes) return false
  const at = strokes.findIndex((stroke) => stroke.id === id)
  if (at === -1) return false
  strokes.splice(at, 1)
  return true
}

/** Стереть страницу целиком, или всю лекцию, если страница не названа. */
export function clearInk(sessionId: string, page?: number): void {
  const room = rooms.get(sessionId)
  if (!room) return
  if (page === undefined) room.ink.clear()
  else room.ink.delete(page)
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
