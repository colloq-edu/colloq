import { tr } from '@shared/i18n'
/**
 * The council on the client — the console's pure arithmetic, with no Svelte and
 * no socket.
 *
 * What stays here is what BOTH remaining places read: the console window
 * (components/council/pult) and the badge of what is shown. Grouping, the word
 * in the status chip, the group name and the oracle state — one copy each per
 * client: whatever is put together in two places sooner or later comes out
 * differently.
 *
 * The stack order, the segments of the group strip, the arrow neighbours and
 * the "rare groups" lived here while the console sat under the cell as a card
 * with "‹ ›". The console moved into a separate window and became a feed
 * (council-pult.ts), and nobody is left to compute the stack — those functions
 * left with it rather than staying "for the future": uncalled code with a test
 * reads as a working feature.
 *
 * The server sets the attempts' group key with the same `normalizeAttempt`
 * that is re-exported from here: the console only groups by it and never
 * recomputes it.
 */
import type { CouncilAttempt, CouncilGroup, CouncilOracle } from '@shared/protocol'
import { groupAttempts } from '@shared/protocol'
export { normalizeAttempt } from '@shared/notebook'

/*
 * Grouping is shared, from shared/protocol.ts.
 *
 * Here lived our own `bySubmission` and `groupAttempts`, a third copy of the
 * same rule: the server stack had its own, the oracle its own, the console its
 * own — and they had already diverged in how they break ties. The tie-break
 * decides who represents the group, that is, whose code comes first in the
 * feed and which group a reply draft lands on; with the divergence, "311 others
 * answered the same" and the group size were counted from different sets.
 * `CouncilAttempt` fits `GroupMember` as it is — the server sets its
 * `groupKey` with the same `normalizeAttempt`.
 */
export { groupAttempts }

/**
 * The word in the status chip. For a failed one — the exception name, because
 * "error" says nothing, while `TypeError` in the chip immediately answers what
 * to show the class.
 */
export function statusLabel(attempt: Pick<CouncilAttempt, 'status' | 'run'>): string {
  switch (attempt.status) {
    case 'correct':
      return tr('room.ui.1046')
    case 'wrong':
      return tr('room.ui.1047')
    case 'failed': {
      const error = attempt.run?.outputs.find((o) => o.kind === 'error')
      return error && error.kind === 'error' && error.ename ? error.ename : tr('room.ui.1048')
    }
    case 'ran':
      return tr('room.ui.1049')
    default:
      return tr('room.ui.1050')
  }
}

/** The group name: from the oracle, and until then — the first non-empty code line. */
export function groupTitle(group: Pick<CouncilGroup, 'label' | 'sample'>): string {
  if (group.label) return group.label
  const line = group.sample.split('\n').find((l) => l.trim())
  return line?.trim() ?? tr('room.ui.1051')
}

export type OracleView = 'idle' | 'reading' | 'ready' | 'stale'

/**
 * Which state to draw the oracle tab in. "Stale" is counted on the spot, by
 * the number of submissions against `basedOn`: the summary is refreshed only
 * by hand, and the server tells it nothing about other people's submissions —
 * `council:oracle` deliberately does not fire on "Submit". The server has no
 * `stale` of its own and never had: only the other three states arrive in the
 * frame.
 */
export function oracleState(oracle: CouncilOracle | null, submitted: number): OracleView {
  if (!oracle) return 'idle'
  if (oracle.state === 'idle' || oracle.state === 'reading') return oracle.state
  return submitted > oracle.basedOn ? 'stale' : 'ready'
}

/** "N more submitted since" — the difference from how many attempts the model read. */
export function staleBy(oracle: CouncilOracle, submitted: number): number {
  return Math.max(submitted - oracle.basedOn, 0)
}
