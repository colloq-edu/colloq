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
  state: Omit<LectureState, 'page' | 'blank'>,
): LectureState {
  const room: Room = {
    state: { ...state, page: 1, blank: false },
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

export function turnTo(sessionId: string, page: number): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room) return null
  const wanted = Math.max(1, Math.floor(page))
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
  const page = Math.max(1, Math.floor(patch.page))
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
