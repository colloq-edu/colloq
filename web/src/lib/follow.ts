/**
 * Whom to follow and where they are.
 *
 * There are four traps here, and all of them are quiet — the screen just
 * behaves strangely, with no explanation.
 *
 * TWO TABS OF ONE PERSON. `peopleInRoom` merges tabs into one person and, when
 * merging, prefers the one that has an active cell — that is, quite possibly
 * the one where the PDF is not open. So here the raw presence list is read,
 * and the tab is chosen by having a position in the RIGHT file.
 *
 * TWO TEACHERS. `host` is not one person: the teacher cookie makes any staff
 * member a host, and the server will honestly assign the role to both. Two of
 * them on different pages means the whole room's screen jitters. The leader
 * is chosen stably and sticks until they disappear.
 *
 * SOMEONE ELSE'S FILE. Page twelve of another document is not the same place.
 * The position carries the file name, and following into another file does
 * not count.
 *
 * GONE. Presence is cleaned up instantly, and "nobody to follow" must be told
 * apart from "following, but they are quiet for now": in the first case the
 * screen stays where it was and says why.
 */
import { mayBeFollowed } from '@shared/rules'
import type { Peer } from './session.svelte'

export interface Lead {
  clientId: number
  name: string
  color: string
  page: number
  /** Share of page height, not pixels: each viewer has their own width and zoom. */
  y: number
}

/**
 * Who is leading through this file right now.
 *
 * `sticky` — the one followed so far: while they are in place, the leader must
 * not change, even if another teacher with a smaller clientId has come.
 * Otherwise the room's screen will start darting between the two.
 */
export function leaderFor(
  peers: readonly Peer[],
  file: string | null,
  sticky: number | null,
): Lead | null {
  if (!file) return null
  const able = peers
    .filter((peer) => !peer.isSelf)
    // The "who is followed" rule is one for both sides and lives in shared: the
    // same predicate decides in the reader whether to publish one's position at
    // all. A copy of our own here would one day drift silently — a relaxation on
    // that side would leave the leader without a published position.
    .filter((peer) => mayBeFollowed(peer.user.role))
    .filter((peer) => peer.user.viewing?.file === file)
  if (able.length === 0) return null

  const chosen =
    able.find((peer) => peer.clientId === sticky) ??
    // A stable choice, not "whichever comes first": the order of the presence
    // list changes with the arrival of any frame.
    able.reduce((a, b) => (a.clientId <= b.clientId ? a : b))

  const viewing = chosen.user.viewing!
  return {
    clientId: chosen.clientId,
    name: chosen.user.name,
    color: chosen.user.color,
    page: viewing.page,
    y: typeof viewing.y === 'number' ? viewing.y : 0,
  }
}

/**
 * Whether this is the same leader at the same place.
 *
 * `leaderFor` builds a NEW object every time, and writing it into a bound
 * property without this check is an infinite loop: the parent redraws, the
 * property comes back, the effect recomputes. It only shows up for someone who
 * has a leader: for the teacher themselves it is `null`, and `null` does not
 * change.
 */
export function sameLead(a: Lead | null, b: Lead | null): boolean {
  if (a === null || b === null) return a === b
  return a.clientId === b.clientId && a.page === b.page && Math.abs(a.y - b.y) < 0.01
}

/*
 * THERE IS NO DRIFT THRESHOLD HERE.
 *
 * There used to be `adrift` — "the same page, but drifted apart by more than a
 * quarter of the height". Nobody called it: the "look for yourself" badge in
 * the reader lights up on following being off (`!following`), and any gesture
 * of one's own turns following off. The function with its three tests guarded
 * a model that does not exist in the product — that is, three green tests that
 * no breakage can bring down. Should a threshold be needed, it will come back
 * together with the following model that applies it.
 */
