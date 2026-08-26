/**
 * The rules of one room.
 *
 * A seminar is not always the same shape. A lecture wants a notebook the class
 * can read and nobody can rearrange; a lab wants everyone typing at once; an
 * exam wants the oracle switched off and the terminal shut. Today the product
 * has one shape — everybody can do everything — and the teacher's only recourse
 * is asking the room nicely.
 *
 * Two things this file is careful about.
 *
 * **A rule is a promise, so it has to be kept by the server.** The client uses
 * these to decide what to grey out, but greying out is decoration: the document
 * is a CRDT and the control channel is a socket, and anything not checked on
 * the server is a request away from being ignored. Every rule here says, in its
 * own comment, where it is enforced — and the ones that are not enforced yet
 * say so, because a rule the product cannot keep must not be presented as one.
 *
 * **Defaults are what the product is today.** Every field defaults to the
 * permissive value, so a seminar created before rules existed, or by somebody
 * who never opened the settings, behaves exactly as it always has.
 */

/** Who a rule lets act. `room` is everyone in it, `host` is whoever is teaching. */
export type Who = 'room' | 'host'

export interface RoomRules {
  /**
   * Who may run cells.
   *
   * Enforced in server/src/control.ts on the `run` message. The kernel is one
   * process shared by everyone, so this is also the only protection a lecture
   * has against twenty people queueing the same cell at once.
   */
  run: Who

  /**
   * Who may change what is written in the notebook.
   *
   * NOT ENFORCED YET, and the interface says so. The notebook is a CRDT: every
   * browser holds the whole document and syncs it through the server, so making
   * this real means the server refusing update messages from people the rule
   * excludes — which it can do, since it is the hub, but which it does not do
   * today.
   */
  edit: Who

  /**
   * Who may add and remove cells.
   *
   * NOT ENFORCED YET, same reason as `edit` and the same fix. Kept separate
   * because the two are genuinely different in a seminar: a class that may fill
   * in a prepared exercise but not restructure the sheet is the common case,
   * and the common case deserves its own switch.
   */
  structure: Who

  /**
   * Who may type in the shared terminal.
   *
   * NOT ENFORCED YET for input; `term:clear` and `term:close` are already
   * host-only in control.ts.
   */
  terminal: Who

  /**
   * Who may put files into the room's folder.
   *
   * NOT ENFORCED YET — the upload route checks that you belong to the seminar,
   * not what you may do in it.
   */
  files: Who

  /**
   * Whether the room's oracle answers at all, and how much it gives away.
   *
   * `inherit` means the instance decides, which is what every seminar does
   * today. The other three override it for this room only — one class is an
   * exercise and the next is a demonstration, and they should not have to share
   * a setting.
   *
   * Enforced: server/src/routes/ai.ts already reads a mode; the per-seminar
   * override is the new part.
   */
  oracle: 'inherit' | 'off' | 'hints' | 'full'

  /**
   * A model for this room only, or null to use the instance's.
   *
   * NOT ENFORCED YET. Worth having because a seminar that will ask two hundred
   * questions and one that will ask five do not want the same model, and the
   * teacher knows which is which before the class starts.
   */
  model: string | null
}

/**
 * What a room is when nobody has said otherwise: exactly what Colloq has always
 * been. Every existing seminar reads as this, and so does every new one whose
 * teacher never opens the settings.
 */
export const OPEN_ROOM: RoomRules = {
  run: 'room',
  edit: 'room',
  structure: 'room',
  terminal: 'room',
  files: 'room',
  oracle: 'inherit',
  model: null,
}

const WHO = new Set<Who>(['room', 'host'])
const ORACLE = new Set<RoomRules['oracle']>(['inherit', 'off', 'hints', 'full'])

/**
 * Read rules off whatever was stored, filling in anything absent.
 *
 * Deliberately total: a row written by an older build, a hand-edited database,
 * a field added after this seminar was created. None of those should be able to
 * open a room with no rules at all, so every unreadable field falls back to the
 * permissive default rather than to an error.
 */
export function readRules(raw: unknown): RoomRules {
  const source = (typeof raw === 'string' ? safeParse(raw) : raw) as Partial<RoomRules> | null
  if (!source || typeof source !== 'object') return { ...OPEN_ROOM }
  const who = (value: unknown, fallback: Who): Who => (WHO.has(value as Who) ? (value as Who) : fallback)
  return {
    run: who(source.run, OPEN_ROOM.run),
    edit: who(source.edit, OPEN_ROOM.edit),
    structure: who(source.structure, OPEN_ROOM.structure),
    terminal: who(source.terminal, OPEN_ROOM.terminal),
    files: who(source.files, OPEN_ROOM.files),
    oracle: ORACLE.has(source.oracle as RoomRules['oracle'])
      ? (source.oracle as RoomRules['oracle'])
      : OPEN_ROOM.oracle,
    model: typeof source.model === 'string' && source.model.trim() ? source.model.trim().slice(0, 80) : null,
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** True when this room is the product's own default — nothing to show, nothing to explain. */
export function isOpenRoom(rules: RoomRules): boolean {
  return (Object.keys(OPEN_ROOM) as (keyof RoomRules)[]).every((key) => rules[key] === OPEN_ROOM[key])
}
