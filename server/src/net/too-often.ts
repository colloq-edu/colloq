/**
 * How many times from one address, the same way as for entering a room and
 * for the Oracle (routes/sessions.ts, routes/ai.ts).
 *
 * Counted by address, not by person, and that is the whole point: a script
 * has no person, it creates one. A class behind one NAT comes in all at once,
 * so the windows are long and the numbers leave room for a cohort; a loop
 * hits this in the first seconds. An address the operator named in
 * SHARED_ADDRESSES arrives here as null and is not counted: a campus NAT is
 * hundreds of people, and the per-person ceilings still hold
 * (net/inbound.ts · addressForLimits).
 *
 * Shared by the competition doors and the room door of class pages: one
 * sliding window, so the two cannot drift into different notions of "too
 * often".
 */
export function tooOften(
  bucket: Map<string, number[]>,
  address: string | null,
  windowMs: number,
  max: number,
): boolean {
  if (!address) return false
  const now = Date.now()
  const recent = (bucket.get(address) ?? []).filter((at) => now - at < windowMs)
  if (recent.length >= max) {
    bucket.set(address, recent)
    return true
  }
  recent.push(now)
  bucket.set(address, recent)
  // Otherwise the map grows all semester: a lesson brings more addresses than people.
  if (bucket.size > 5000) {
    for (const [key, hits] of bucket) {
      if (hits.every((at) => now - at >= windowMs)) bucket.delete(key)
    }
  }
  return false
}
