import type { SessionInfo } from '@shared/protocol'

/**
 * The seminar's identity card, remembered so a return visit can mount the room
 * before the network confirms it exists. Small, so localStorage is the right
 * shape: it is readable synchronously, during the first render.
 *
 * This is a cache, never a source of truth — the name shown in the header comes
 * from the CRDT the moment the document replays.
 */
const ROOM_KEY = 'colloq.room.v1'

type RoomMap = Record<string, SessionInfo>

function readRooms(): RoomMap {
  try {
    const raw = localStorage.getItem(ROOM_KEY)
    return raw ? (JSON.parse(raw) as RoomMap) : {}
  } catch {
    return {}
  }
}

function writeRooms(rooms: RoomMap): void {
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify(rooms))
  } catch {
    /* private browsing; the next visit just waits for the fetch again */
  }
}

export function recallSessionInfo(sessionId: string): SessionInfo | null {
  const room = readRooms()[sessionId]
  if (!room || room.id !== sessionId) return null
  /*
   * Конец занятия хранится вместе с остальной карточкой — она пишется целиком,
   * — но карточка могла лечь сюда ещё до того, как занятие стало кончаться, и
   * тогда поля в ней просто нет. `undefined` — это не `null`, то есть комната
   * прочитала бы старую карточку как законченное занятие и на секунду показала
   * бы погашенной каждую комнату, куда человек возвращается.
   *
   * Незнание — это «занятие идёт». Угадать строже значит соврать: запуск
   * ячейки, который на самом деле разрешён, всё равно уйдёт на сервер и там
   * решится, а погашенная кнопка не спрашивает никого.
   */
  /*
   * Название организации нормализуется тем же приёмом и по той же причине:
   * карточка могла лечь сюда до того, как строка вообще появилась. Разница
   * только в том, что здесь незнание безобидно — `undefined` вместо строки
   * убрал бы линейку на один кадр, а не зажёг бы чужое имя.
   */
  return { ...room, finishedAt: room.finishedAt ?? null, institution: room.institution ?? '' }
}

export function rememberSessionInfo(session: SessionInfo): void {
  const rooms = readRooms()
  const known = rooms[session.id]
  /*
   * Карточка сравнивается целиком, а не по имени с датой.
   *
   * В ней лежат ещё правила комнаты и указатель на публикацию, а меняются они
   * чаще имени: преподаватель закрыл тетрадь на запись — и следующий заход
   * по-прежнему рисовал первый кадр по правилам полугодовой давности, пока не
   * ответит сервер. Лишняя запись в хранилище стоит микросекунды.
   */
  if (known && JSON.stringify(known) === JSON.stringify(session)) return
  rooms[session.id] = session
  writeRooms(rooms)
}

export function forgetSessionInfo(sessionId: string): void {
  const rooms = readRooms()
  if (!(sessionId in rooms)) return
  delete rooms[sessionId]
  writeRooms(rooms)
}
