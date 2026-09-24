/**
 * A question that has already been sent but has not yet come back from the
 * document.
 *
 * Between Enter and the question appearing in the shared feed lies a whole
 * round trip: HTTP to the server through the relay, a write into the room's
 * document, a broadcast back over the socket. At a seminar that is a fraction
 * of a second, and it is plainly visible — the field has emptied, the feed is
 * empty, and the person presses Enter a second time. So the question goes into
 * the feed at once, as a row of its own, and the real entry takes its place
 * later.
 *
 * The module is pure: a test comes here, and there are no sockets and no
 * document in it.
 */
import type { ChatSnapshot } from '@shared/notebook'

export interface Outgoing {
  /** Server acknowledgement identifies the row even when it supplies the question text. */
  entryId?: string
  /** The row drawn by this tab. In shape — the same feed entry. */
  row: ChatSnapshot
  /**
   * The entries that were in the feed when the question went out.
   *
   * They tell "my question arrived" from "my identical question, asked ten
   * minutes ago". Without this, Retry on one's own question would remove the
   * fresh row in the same frame it was placed in — and the person would again
   * see emptiness, exactly the one all this was set up against.
   */
  before: ReadonlySet<string>
}

/**
 * Build the row for a question that is about to go out.
 *
 * The shape is that of a real feed entry, down to `state: 'streaming'`: the
 * row must look like what it will become, otherwise the swap shows as a jerk.
 * Everything it cannot have yet (the answer, reasoning, steps, a proposal) is
 * empty, and that is the truth: the server has not said a word yet.
 */
export function outgoingRow(input: {
  id: string
  me: { id: string; name: string; color: string }
  question: string
  action?: string | null
  cellId?: string | null
  cellIds?: string[]
  mode?: 'ask' | 'agent'
  at: number
}): ChatSnapshot {
  return {
    id: input.id,
    participantId: input.me.id,
    name: input.me.name,
    color: input.me.color,
    question: input.question,
    action: input.action ?? null,
    cellId: input.cellId ?? input.cellIds?.[0] ?? null,
    cellIds: input.cellIds ?? [],
    createdAt: input.at,
    answer: '',
    state: 'streaming',
    patch: null,
    patchBase: null,
    patchState: 'open',
    patchBy: null,
    reasoning: '',
    thoughtMs: null,
    mode: input.mode === 'agent' ? 'agent' : 'ask',
    steps: [],
    undo: 'none',
    undoBy: null,
  }
}

/**
 * Remove the rows whose entries have already arrived.
 *
 * After the HTTP acknowledgement the entry is recognised by entryId: the server
 * may fill in the text for actions like "fix". Before the acknowledgement — by
 * author and text, but only among entries that did not exist yet when it was
 * sent. Identical questions are matched in turn: the first entry to arrive goes
 * to the first one sent, otherwise one entry would remove both rows and the
 * second question would again fall into the void.
 */
export function settleOutbox(
  pending: readonly Outgoing[],
  fresh: readonly ChatSnapshot[],
): Outgoing[] {
  if (pending.length === 0) return pending as Outgoing[]
  const taken = new Set<string>()
  const left = pending.filter((mine) => {
    const landed = fresh.find(
      (entry) =>
        !taken.has(entry.id) &&
        !mine.before.has(entry.id) &&
        entry.participantId === mine.row.participantId &&
        (mine.entryId !== undefined
          ? entry.id === mine.entryId
          : entry.question === mine.row.question),
    )
    if (!landed) return true
    taken.add(landed.id)
    return false
  })
  /*
   * Nothing removed — return THE SAME array, not a copy of it.
   *
   * `filter` always allocates a new one, and the caller, comparing by
   * reference, would write a new value on every frame of the feed. Once this
   * already cost the room an infinite effect loop, and the guard costs one line.
   */
  return left.length === pending.length ? (pending as Outgoing[]) : left
}
