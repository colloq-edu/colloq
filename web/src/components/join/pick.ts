/**
 * The mark you knock on the room's door with — and the MOMENT it is chosen.
 *
 * The join screen promises: "Picked from the ones nobody in this room has
 * taken". The promise was kept exactly once — on mount — while a class opens
 * the link within the same minute: all thirty have an empty roster, all pick
 * from the full list independently, and identical marks come not from bad
 * luck but by construction. With forty marks for thirty people the
 * expectation is about eleven pairs with the same animal, that is, with the
 * same cursor in the notebook.
 *
 * Here is the part of this that can be cured on the client: the roster is
 * re-read BEFORE joining and when the picker opens, and the mark is
 * recomputed from it. That narrows the race to a network round trip (two
 * tabs knocking in the same second) but does not close it: the only judge of
 * uniqueness is the server, and it has the last word too (routes/sessions.ts
 * · `markToHand`). The rule below is what the client comes to it with: a
 * mark we handed out it is free to replace, while a hand-picked one it
 * learns about from the `picked` field in the /join body and leaves alone.
 *
 * The functions are pure and live apart from the form: both break silently —
 * a hand-picked mark cancelled by a roster update reads as "the screen
 * changed its mind by itself", and one that was not recomputed reads as bad
 * luck.
 */
import type { Participant } from '@shared/protocol'
import { freeMark } from '../../lib/marks'

/**
 * Mark → the colour of whoever wears it now.
 *
 * Only those IN THE ROOM: the participants table remembers everyone who ever
 * joined, and the mark of someone who left a week ago is in nobody's way.
 * `exceptId` is one's own previous seat: joining through it is the very thing
 * it is taken by.
 */
export function takenMarks(
  roster: readonly Participant[],
  online: ReadonlySet<string>,
  exceptId: string | null,
): Map<string, string> {
  const taken = new Map<string, string>()
  for (const person of roster) {
    if (!person.avatar || !online.has(person.id) || person.id === exceptId) continue
    taken.set(person.avatar, person.color)
  }
  return taken
}

/**
 * Which mark to knock with, knowing who is in the room right now.
 *
 * A hand-picked mark is never touched: the person tapped a particular animal,
 * and swapping it silently is the worse of two evils (the room will have two
 * hedgehogs, but nobody will conclude the screen did not listen to them). One
 * we handed out ourselves is recomputed.
 *
 * `pickedByHand` goes to the server too (`picked` in /join): without it both
 * kinds would be swapped, and someone who tapped the hedgehog would join as
 * an otter — with nowhere left to tell them, since the join card is gone by
 * then.
 */
export function markToClaim(
  chosen: string,
  pickedByHand: boolean,
  taken: ReadonlyMap<string, string>,
  prefer: string | null,
): string {
  if (pickedByHand || !taken.has(chosen)) return chosen
  return freeMark(taken, prefer)
}
