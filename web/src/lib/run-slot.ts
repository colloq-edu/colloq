import { tr } from '@shared/i18n'
/**
 * One button for all of a cell's execution states.
 *
 * The first slot in the toolbar above a cell always drew "run" — on a running
 * cell and on a queued one alike. A press at that moment went to the server
 * and was silently thrown away there: `requestRun` skips a cell that is
 * already executing and a cell that is already queued. So the button was
 * enabled, promised an action and did nothing — while "stop" lived at the
 * bottom of the cell, in another place and in another shape. Hence the
 * complaint: it's made strangely.
 *
 * Now it is one slot with three faces: run on a settled cell, cancel on a
 * queued one, stop on a running one. The decision is moved here because six
 * outcomes and three access rules in the middle of markup are exactly the way
 * the original untruth was written.
 *
 * Only `@shared/notebook` and the neighbouring `./controls` are imported: the
 * bundler knows the `@/` path but tsx does not, and this module must stay
 * testable.
 */
import type { CellState } from '@shared/notebook'
import { controlDisabled, controlTitle } from './controls'

export interface RunSlotGates {
  connected: boolean
  /** The room's rules allow this person to run cells. */
  mayRun: boolean
  /** They queued it themselves, or they are the host. */
  canCancel: boolean
  /** They ran it themselves, or they are the host. */
  canInterrupt: boolean
}

export interface RunSlot {
  action: 'run' | 'cancel' | 'interrupt'
  icon: 'play' | 'x' | 'stop'
  size: 11 | 12 | 13
  /** The colour class for the icon itself. */
  tint: string
  label: string
  disabled: boolean
  title: string
}

export function runSlot(state: CellState, gates: RunSlotGates): RunSlot {
  const { connected } = gates

  if (state === 'running') {
    return {
      action: 'interrupt',
      icon: 'stop',
      size: 11,
      // Not the accent: on a running cell everything else glows in the accent —
      // the bar, the number, the word RUNNING. A stop button painted the same
      // colour would argue with the very state that colour speaks of.
      tint: 'text-ink',
      get label() { return tr('room.ui.1163') },
      disabled: controlDisabled(connected, gates.canInterrupt),
      title: controlTitle(
        connected,
        gates.canInterrupt
          ? tr('room.ui.1163')
          : tr('room.ui.1164'),
      ),
    }
  }

  if (state === 'queued') {
    return {
      action: 'cancel',
      icon: 'x',
      size: 13,
      tint: 'text-ink',
      get label() { return tr('room.ui.1165') },
      disabled: controlDisabled(connected, gates.canCancel),
      /*
       * The refusal phrase here is new, and it was needed precisely because of
       * this slot.
       *
       * At the bottom of the cell "cancel" is simply hidden when not allowed —
       * there it is the last button in the row, and its disappearance moves
       * nothing. In the toolbar, hiding the first slot would shift "up" and
       * "down" under a cursor that was aiming at one of them. So here it is
       * dimmed, and a dimmed button must be able to explain itself.
       */
      title: controlTitle(
        connected,
        gates.canCancel
          ? tr('room.ui.1166')
          : tr('room.ui.1167'),
      ),
    }
  }

  return {
    action: 'run',
    icon: 'play',
    size: 12,
    tint: 'text-accent-text',
    get label() { return tr('room.ui.1168') },
    disabled: controlDisabled(connected, gates.mayRun),
    title: controlTitle(
      connected,
      gates.mayRun ? tr('room.ui.1168') : tr('room.ui.1169'),
    ),
  }
}
