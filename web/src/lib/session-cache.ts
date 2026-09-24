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
   * The end of class is stored together with the rest of the card — the card
   * is written whole — but the card may have been stored here before classes
   * could end at all, and then the field is simply missing. `undefined` is not
   * `null`, that is, the room would read the old card as a finished class and
   * for a second show every room a person returns to as dimmed.
   *
   * Not knowing means "the class is on". Guessing more strictly would be a
   * lie: a cell run that is actually allowed still goes to the server and is
   * decided there, while a dimmed button asks nobody.
   */
  /*
   * The organisation name is normalised the same way and for the same reason:
   * the card may have been stored here before the field existed at all. The
   * only difference is that not knowing is harmless here — `undefined` instead
   * of a string would remove the rule line for one frame, not light up someone
   * else's name.
   */
  return { ...room, finishedAt: room.finishedAt ?? null, institution: room.institution ?? '' }
}

export function rememberSessionInfo(session: SessionInfo): void {
  const rooms = readRooms()
  const known = rooms[session.id]
  /*
   * The card is compared whole, not by name and date.
   *
   * It also holds the room's rules and a pointer to the publication, and those
   * change more often than the name: the teacher made the notebook read-only —
   * and the next visit still drew the first frame by half-year-old rules until
   * the server answered. An extra write to storage costs microseconds.
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
