import { tr } from '@shared/i18n'
/**
 * The lock on a cell — what a click does and what the hint promises.
 *
 * A click stays a click: closed ↔ open, without a menu and without a dialog,
 * because a cell is opened in the middle of a sentence, without taking one's
 * eyes off the audience, and a mistake is fixed by the same press. But WHERE
 * a click opens to is decided by the room rule (shared/rules.ts · `opens`): in
 * a lecture — shared text for everyone, in a council — a sheet of one's own
 * for each. The server reads this rule in control.ts on `cell:open`; here the
 * same rule is read for the hint and for the second press — otherwise the
 * button would promise "open to the room" but open a council, and after the
 * first click in a council room the second would unfold the menu instead of
 * closing the cell.
 *
 * The menu stays behind a long press, the right button and — in a room where
 * a click opens to everyone — a click on the lock in the "council" position:
 * a click never got there, and a single press does not know where to return.
 */
import type { CellLock } from '@shared/notebook'
import type { RoomRules } from '@shared/rules'

export type Opens = RoomRules['opens']

/** What one press on the lock does: sends `cell:open` or unfolds the menu. */
export type LockPress = { kind: 'open'; open: boolean } | { kind: 'menu' }

export function lockPress(state: CellLock, opens: Opens): LockPress {
  if (state === 'closed') return { kind: 'open', open: true }
  // A position that a click does not lead to is not cleared by a click either:
  // there a single press does not know whether to close or open to everyone.
  if (state === 'council' && opens !== 'council') return { kind: 'menu' }
  return { kind: 'open', open: false }
}

/** The button's aria-label: briefly, what will happen on a press. */
export function lockLabel(state: CellLock, opens: Opens): string {
  if (state === 'closed') {
    return opens === 'council'
      ? tr('room.ui.1078')
      : tr('room.ui.1079')
  }
  if (state === 'council' && opens !== 'council') return tr('room.ui.1080')
  return tr('room.ui.1081')
}

/** The button's hint: what a click does and what a long press does. */
export function lockHint(state: CellLock, opens: Opens): string {
  if (opens === 'council') {
    // A long press leads to the menu, which has shared text too: a click
    // cannot get it here.
    if (state === 'closed') return tr('room.ui.1082')
    if (state === 'council') return tr('room.ui.1083')
    return tr('room.ui.1083')
  }
  if (state === 'closed') return tr('room.ui.1084')
  if (state === 'council') return tr('room.ui.1085')
  return tr('room.ui.1083')
}
