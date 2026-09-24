import { tr } from '@shared/i18n'
/**
 * Why a rule was not saved — in Russian, like the whole rules console in the
 * room.
 *
 * The console stands inside a seminar, and the seminar is Russian throughout —
 * from "Submit" to "The class is over". The refusal reason used to be brought
 * there by `err.message` from ApiError (lib/api.ts), and it is English on both
 * sides: both the request's own fallback phrases ("Could not reach the server
 * — check the connection and try again.", "Not found (404)") and the route's
 * body ("join the session first"). On a dropped Wi-Fi an English line popped
 * up over the Russian console — exactly the half-and-half the rules window in
 * the panel was already translated to avoid (admin-17).
 *
 * The server's tail is deliberately absent here, and it is the same decision
 * as its twin in the panel (web/src/admin/panel.ts · `ruleRefusal`): what is
 * translated is not the phrase but the REASON. There are two twins, not one,
 * because their refusals have different shapes — the panel judges by the
 * `reason` field its route returns, the room by the response code and the ban
 * deadline — and importing from the panel into the room would drag a piece of
 * the admin screen into the seminar chunk for the sake of five lines.
 *
 * What counts here as proof and what as a guess:
 *
 *  • `status === 0` is set by lib/api.ts on a rejected fetch — that is "no
 *    connection", not "the server refused";
 *  • a 403 with a deadline is a ban (JoinScreen.svelte and lib/identity.ts ·
 *    `verdictOnFailure` read the same sign), a 403 without a deadline is "not
 *    the teacher", the only other refusal of this door (routes/sessions.ts ·
 *    PATCH /api/sessions/:id/rules);
 *  • "the seminar no longer exists" — only from our own words in the response
 *    body (shared/protocol.ts · `saysSessionMissing`): a bare 404 comes from a
 *    relay without a connected frpc and from static hosting that answers
 *    index.html to everything, and on this phrase a teacher in the middle of a
 *    class would go and create a second seminar instead of waiting for the
 *    connection.
 *
 * Everything not named by these signs ends in "try again": a guess from a
 * bare code is worse than honest silence.
 */
import { saysSessionMissing } from '@shared/protocol'

export function ruleRefusal(cause: unknown): string {
  const { status, until } = (cause ?? {}) as { status?: unknown; until?: unknown }
  if (status === 0) return tr('room.ui.1119')
  if (status === 403) {
    return typeof until === 'number' && Number.isFinite(until)
      ? tr('room.ui.1120')
      : tr('room.ui.1121')
  }
  if (status === 401) {
    return tr('room.ui.1122')
  }
  if (saysSessionMissing(cause)) return tr('room.ui.1123')
  return tr('room.ui.1124')
}
