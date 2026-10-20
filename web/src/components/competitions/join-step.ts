/**
 * The way into a competition, as decisions without a page: where
 * «Участвовать» leads, what the join step hands the focus to, and what the
 * page keeps of a join's answer. CompetitionsScreen and JoinStep read them
 * here, and so do the tests.
 *
 * «Участвовать» used to lead to the general list, where the name was asked
 * for in a form unfolding under the competition's card — below the fold
 * whenever the card was not first, and with nothing focused. A visitor who
 * pressed it on the leaderboard or the packages tab landed at the top of a
 * list of other competitions and did not see where to go on (the owner, 20
 * Oct 2026). The way in is now the competition's own: the first step of its
 * «Посылки» tab, where the send box stands for those who have joined.
 */
import { acceptsUploads } from '@shared/competitions'
import type { Accepting, EntrantMe } from '@shared/competitions-entrant'

/** The join step's address: the top of the competition's «Посылки» tab. */
export function joinStepPath(slug: string): string {
  return `/k/${slug}/submissions`
}

export type JoinFocus = 'name' | 'action' | 'key' | null

/**
 * What the step takes the focus to once «Участвовать» brought the visitor to
 * it: the name field, or the one action when the name is already filled in (a
 * signed-in person joins under the name they carry), or the key field when
 * the door takes nobody now and only someone who joined before can get in.
 * Nothing when there is no way in at all.
 */
export function joinFocusTarget(input: { accepting: Accepting; signedIn: boolean; name: string }): JoinFocus {
  if (acceptsUploads(input.accepting)) return input.signedIn && input.name.trim() ? 'action' : 'name'
  return input.signedIn ? null : 'key'
}

/**
 * The person after a join.
 *
 * A signed-in person's answer carries no key: they already have it
 * (routes/competitions.ts · join). Taken as it is, it turned the key card into
 * «Ключ появится, когда вы вступите в первое соревнование» for the very person
 * who had just joined their second one. The key in hand stays.
 */
export function joinedMe(before: EntrantMe | null, answer: EntrantMe): EntrantMe {
  const same = !!before?.entrant && !!answer.entrant && before.entrant.id === answer.entrant.id
  return same && answer.key === null ? { ...answer, key: before!.key, link: before!.link } : answer
}

/**
 * Whether the visitor takes part here, so the send box stands where the join
 * step would. The same rule the server answers with (routes/competitions.ts ·
 * mineIn): joined, or has a submission here. "My submissions" decides once it
 * has arrived; until then the page's own `mine` does, so a signed-in person
 * does not see the wrong step while their list is on its way.
 *
 * The only thing the screen asks before it shows the send box: what the
 * server said about this person, never a mark the page keeps of its own. A
 * mark of "joined here" once outlived the person who made it — another one
 * signed in with their key on the same tab got the send box, and the door
 * refused every notebook with «Сначала вступите в соревнование».
 */
export function takesPartHere(
  page: { mine: { joined: boolean } | null } | null,
  mine: { joined: boolean; submissions: readonly unknown[] } | null,
): boolean {
  if (mine) return mine.joined || mine.submissions.length > 0
  return page?.mine?.joined === true
}

/**
 * The page's copy of a standing once the door has said yes to joining.
 *
 * A person who already carried an identity joins without the page being
 * reset (the same person on the same page), so its copies keep saying "not
 * joined" until they are read again, a round trip later, and the join step
 * stood that long under a name already in. They learn the door's answer
 * here; the reads that follow say the same.
 */
export function markJoined<T extends { joined: boolean }>(standing: T | null): T | null {
  return standing === null || standing.joined ? standing : { ...standing, joined: true }
}

/**
 * A visit: this competition (or the list, '') seen by this person (or a
 * stranger, ''). The screen keys its loads by it, and the mark a join leaves
 * for the key card is one, so it belongs to the person who joined: another
 * person signing in on the same tab never inherits it.
 */
export function visitKey(slug: string | null, personId: string | null | undefined): string {
  return `${slug ?? ''}:${personId ?? ''}`
}
