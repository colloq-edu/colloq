/**
 * Credentials that arrive as a URL, and the rule for reading them.
 *
 * Two doors open this way. A teacher's personal sign-in link, `/admin/k/<key>`,
 * is the only way back into the panel — no password exists to reset. And the
 * server's setup token, `/admin/t/<token>`, which claims a fresh instance and
 * afterwards is the owner's way back in.
 *
 * The second one exists because of the tunnel. `make host` publishes the
 * seminar on a new Cloudflare address every run, the staff cookie is bound to
 * an origin, and so the teacher arrives signed out at the start of every
 * seminar. Retyping thirty-two characters while a room waits is not a workflow,
 * so the printed link carries the token — the same trade Jupyter makes.
 *
 * Whatever is read here is spent immediately and erased from the address bar
 * with replaceState. That is not decoration: the address bar is the one place a
 * projector shows to a whole room.
 *
 * Kept out of the component so the shapes can be tested. A pattern that quietly
 * stops matching would not break a build — it would land somebody on an empty
 * panel with a credential still in their URL.
 */

export type EntryCredential =
  | { kind: 'key'; value: string }
  /** The server's setup token: claims an unowned instance, signs in an owner. */
  | { kind: 'token'; value: string }

/*
 * Both credentials are base64url — the alphabet crypto.randomBytes().toString
 * ('base64url') produces, which is what mints them on the server. The bound is
 * generous rather than exact: a length check here would be a second, quieter
 * definition of the token format, and the server verifies the real one anyway.
 */
const KEY_PATH = /^\/admin\/k\/([A-Za-z0-9_-]{1,128})\/?$/
const TOKEN_PATH = /^\/admin\/t\/([A-Za-z0-9_-]{1,128})\/?$/

/**
 * What, if anything, this path is offering. `null` for every ordinary URL —
 * including `/admin` itself and the panel's own tabs.
 */
export function readEntryCredential(pathname: string): EntryCredential | null {
  const key = KEY_PATH.exec(pathname)?.[1]
  if (key) return { kind: 'key', value: key }
  const token = TOKEN_PATH.exec(pathname)?.[1]
  if (token) return { kind: 'token', value: token }
  return null
}

/** Where the address bar is rewritten to once a credential has been spent. */
export const SPENT_PATH = '/admin'
