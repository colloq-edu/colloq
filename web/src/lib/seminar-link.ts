/**
 * The link a teacher copies out of the panel and gives to a room.
 *
 * It used to be exactly `PUBLIC_URL + /s/<id>`, built on the server. That is one
 * setting away from being wrong, and being wrong here is expensive in a
 * particular way: the link opens for the person who copied it — they are on the
 * machine PUBLIC_URL points at — and for nobody else. It also silently costs the
 * teacher their own seat, because a link on another origin carries neither the
 * staff cookie nor the "this browser is staff" hint, so the panel's own author
 * arrives at their seminar as an anonymous participant.
 *
 * Measured, twice, through a Cloudflare tunnel: the seminar was live on
 * https://seminar.sleep3r.ru, PUBLIC_URL still said http://localhost:3000, and
 * every link in the panel pointed at a machine only one person in the world
 * could reach.
 *
 * So the rule is: believe PUBLIC_URL when it says something a room could
 * actually open, and otherwise believe the address bar. The page the teacher is
 * reading is, by construction, reachable from where they are — it cannot go
 * stale the way a setting can.
 */

/**
 * Hosts that mean "this machine and nobody else". A PUBLIC_URL left on one of
 * these is the default nobody changed, not a decision — the operator who really
 * does serve on localhost is also reading the panel there, so the fallback
 * lands on the same answer anyway.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

function originIfUsable(candidate: string): string | null {
  try {
    const url = new URL(candidate)
    if (LOCAL_HOSTS.has(url.hostname)) return null
    return url.origin
  } catch {
    // PUBLIC_URL is operator-configured and can be anything at all.
    return null
  }
}

/**
 * @param configured what the server built the link from — its `PUBLIC_URL`.
 * @param pageOrigin the origin the panel itself is open on.
 * @param id the seminar's id, which is the only part that is never in doubt.
 */
export function seminarLink(configured: string, pageOrigin: string, id: string): string {
  const base = originIfUsable(configured) ?? originIfUsable(pageOrigin) ?? pageOrigin
  // No slash-joining games: an origin never ends in one, and the id is minted
  // from an alphabet with no separators in it.
  return `${base.replace(/\/+$/, '')}/s/${id}`
}
