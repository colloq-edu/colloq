import { tr, getLocale } from '@shared/i18n'
/**
 * The teacher panel's decisions, taken out of the components.
 *
 * No Svelte and no browser — as in `lib/bans.ts` and for the same reason:
 * these are words the teacher reads once and then goes off to act on
 * (looking for cookie settings instead of a new link, picking an oracle mode
 * that will not switch on in the room, adding a file that will not arrive,
 * looking for a step that is not on the page), and a mistake in them only
 * shows during a live class.
 *
 * They all share one rule: do not pass a guess off as a fact. "Don't know"
 * and "no" are different answers, and where the instance ceiling has not
 * been read yet the panel stays silent instead of drawing a limit out of
 * nothing.
 */
import {
  isKeylessProvider,
  PROVIDER_PRESETS,
  providerConfigured,
  type AdminErrorReason,
  type OracleMode,
  type OracleSettings,
} from '@shared/admin'
import { SKIP_REASON_TEXT, type SkippedStep } from '@shared/publish'
import { OPEN_ROOM, oracleModeIn, type RoomRules } from '@shared/rules'

/* ------------------------------------------------------------- sign-in */

/**
 * Why the panel asks "who are you" again.
 *
 * `no-cookie` — signing in had succeeded in this tab, but the cookie did not
 * come back; `revoked` — the cookie arrived and was rejected (the link was
 * rotated, the person was removed from the staff); `removed-self` — the
 * person deleted their own account and the server erased the cookie itself.
 */
export type SignedOutReason = 'no-cookie' | 'revoked' | 'removed-self'

/**
 * What to say on the sign-in screen.
 *
 * All three cases used to say the same thing: "this browser sent no session
 * back — allow cookies". A teacher whose link was rotated in the middle of a
 * class went off to allow cookies instead of asking the owner for a new
 * link, and someone who had just deleted themselves read about browser
 * settings in response to their own deliberate act.
 */
export function signedOutNotice(reason: SignedOutReason): string {
  switch (reason) {
    case 'revoked':
      return (
        (tr("admin.your.sign.in.is.no.longer.valid.the.link.may.have.been.replaced.o") + " ") +
        tr("admin.removed.ask.an.owner.for.a.new.sign.in.link")
      )
    case 'removed-self':
      return tr("admin.you.removed.your.own.account.so.this.browser.is.signed.out.an.own")
    default:
      return (
        (tr("admin.no.sign.in.session.was.received.from.this.browser.allow.cookies.f") + " ") +
        tr("admin.address.or.open.the.panel.over.the.address.the.server.publishes.a")
      )
  }
}

/* ---------------------------------------------------------- room rules */

/**
 * A refusal as the panel client names it: the reason as a word and the
 * response code.
 *
 * Exactly what `AdminApiError` carries (lib/adminApi.ts), but without the
 * class itself — no Svelte and no browser here, and `body` is needed only to
 * tell a response from OUR route apart from someone else's page with the
 * same code.
 */
export interface AdminRefusal {
  reason: AdminErrorReason
  status: number
  /** The parsed body of the refusal, or null if the response was not JSON. */
  body?: unknown
}

/**
 * Why a rule was not saved — in Russian, like the whole rules window.
 *
 * This window is the only one in the English panel that speaks Russian
 * throughout: the rule labels live in the ROOM's language
 * (web/src/lib/rule-rows.ts), and the frame around them cannot be in a
 * different one. The refusal reason used to be brought in by the shared
 * `explain()`, which is English across the whole panel — and the footer read
 * "The rule was not saved" in Russian followed by "— The server did not
 * respond" in English: the very half-and-half bilingualism the window was
 * made Russian to avoid (admin-17).
 *
 * The server's tail is left out on purpose. Its phrases are English and come
 * over the network (statusText, "The request failed (500)", the route's
 * text), there is nothing to translate them with on the fly, and
 * paraphrasing at random is worse than not paraphrasing: what gets
 * translated is not the phrase but the REASON, which the server names in a
 * separate `reason` field. Anything that field does not name is more
 * honestly ended with "try again".
 */
export function ruleRefusal(refusal: AdminRefusal | null): string {
  switch (refusal?.reason) {
    case 'network':
      return tr("admin.could.not.save.the.rule.the.server.did.not.respond.try.again")
    case 'unauthenticated':
      return tr("admin.could.not.save.the.rule.your.sign.in.session.is.no.longer.valid.s")
    case 'forbidden':
      return tr("admin.could.not.save.the.rule.you.do.not.have.access.to.this.seminar")
    default:
      /*
       * "The seminar no longer exists" is a fact, not a guess from the code.
       *
       * The route returns 404 with `reason: 'invalid'`
       * (routes/admin-instance.ts · notFound), the same as for a rejected
       * body, so the two can only be told apart by the response code. But a
       * proxy in front of the server, or a tunnel that forgot about /api,
       * will return a 404 with the same number too — and on "the seminar no
       * longer exists" the teacher will go and create a second one. So we
       * need a response from the route ITSELF: a parsed body, which a
       * stranger's page will not have.
       */
      if (refusal?.status === 404 && refusal.body != null) {
        return tr("admin.could.not.save.the.rule.seminar.not.found")
      }
      return tr("admin.could.not.save.the.rule.try.again")
  }
}

/* -------------------------------------------------------------- oracle */

/**
 * The instance ceiling: a room gets no freer than this, whatever is chosen
 * in it.
 *
 * `mode` is the freest mode the instance will give at all; `why` is why it
 * is so, in words, or null when there is no ceiling and the choice in the
 * room is real.
 *
 * It is computed from three conditions, and on the server all three meet in
 * one line (routes/ai.ts · `enabled = aiReady() && defaultMode !== 'off' &&
 * questionsPerHour > 0`): nobody to answer, `off` switches the oracle off,
 * zero questions an hour is the same thing in other words.
 *
 * The first of the three is not "is there a key". `aiReady()` comes down to
 * `providerReady()` (ai/provider.ts): a key OR a local runtime, which has no
 * notion of a key. The panel used to count by the key alone here and, on a
 * configured Ollama, invented an `off` ceiling — greying out "Hints only"
 * and "Full answers" and declaring the oracle nonexistent while it was
 * answering. Now there is one rule for both sides (`providerConfigured` in
 * shared/admin.ts), and the `provider` and `baseUrl` it needs sit in the
 * same `OracleSettings` that have already been read.
 */
export interface OracleCeiling {
  mode: OracleMode
  why: string | null
}

export function oracleCeiling(settings: OracleSettings): OracleCeiling {
  const hasKey = settings.apiKeyMasked !== null || settings.keyFromEnvironment
  if (!providerConfigured({ provider: settings.provider, baseUrl: settings.baseUrl, hasKey })) {
    // Two different kinds of "nobody to answer", and they are fixed
    // differently: one lacks a key, the other the address of a runtime that
    // will not ask for a key.
    return {
      mode: 'off',
      why: isKeylessProvider(settings.provider)
        ? tr("admin.the.runtime.has.no.address.set", { p0: PROVIDER_PRESETS[settings.provider].label })
        : tr("admin.no.model.key.is.set.for.this.instance"),
    }
  }
  if (settings.defaultMode === 'off') return { mode: 'off', why: tr("admin.the.instance.has.the.oracle.off") }
  if (settings.questionsPerHour === 0) {
    return { mode: 'off', why: tr("admin.the.instance.allows.zero.questions.an.hour") }
  }
  if (settings.defaultMode === 'hints') {
    return { mode: 'hints', why: tr("admin.the.instance.allows.hints.only") }
  }
  return { mode: 'full', why: null }
}

/**
 * What a room will actually get when it asks for `want`.
 *
 * By the same rule as on the server: `oracleModeIn` from shared is the only
 * copy of "a room tightens and never loosens".
 */
export function oracleUnder(want: RoomRules['oracle'], ceiling: OracleMode): OracleMode {
  return oracleModeIn({ ...OPEN_ROOM, oracle: want }, ceiling)
}

/**
 * A choice that looks like a setting but will not be one.
 *
 * `inherit` is never ineffective: it means exactly "as much as the instance
 * gives". The other three take effect exactly when the ceiling lets them
 * through in full.
 */
export function oracleOverCeiling(want: RoomRules['oracle'], ceiling: OracleMode): boolean {
  if (want === 'inherit') return false
  return oracleUnder(want, ceiling) !== want
}

/* --------------------------------------------------------------- files */

/** The megabytes a limit is spoken of in: 52428800 → 50. */
export function uploadMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

/**
 * What will go through and what will not.
 *
 * The check comes before Create is pressed, not in the upload after it: by
 * then the room already exists, and "the seminar was created but the dataset
 * did not arrive" means a trip into the room to add the file by hand instead
 * of one line on the screen where it can still be replaced.
 */
export function splitBySize<T extends { name: string; size: number }>(
  files: T[],
  maxBytes: number,
): { taken: T[]; refused: T[] } {
  const taken: T[] = []
  const refused: T[] = []
  for (const file of files) {
    if (maxBytes > 0 && file.size > maxBytes) refused.push(file)
    else taken.push(file)
  }
  return { taken, refused }
}

/* --------------------------------------------------- publication steps */

/**
 * A moment that did not become a step — in one line.
 *
 * The fifth place of the same rule: do not pass silence off as consent. A
 * marked moment that failed to build vanished without a trace — the teacher
 * marked seven, got a page with six and counted them by eye, guessing which
 * one went missing.
 *
 * The reason comes from the single copy in shared (SKIP_REASON_TEXT) — the
 * same one the server names it with. Only one thing is decided here: what to
 * call the moment itself. By its name if it has one; by its time if it has
 * no name (an unnamed moment is one of the reasons, in fact); by the version
 * number if even the candidate is no longer visible. In Russian, because the
 * whole publishing screen is in Russian.
 */
export function skippedStepLine(step: SkippedStep, moment?: string): string {
  const named = step.label.trim() || moment?.trim() || tr("admin.version", { p0: step.seq })
  return tr("admin.version.skipped", { p0: named, p1: SKIP_REASON_TEXT[step.reason] })
}

/* ------------------------------------------------------- "running now" */

/** How much time has passed — in words, for the banner and the list row. */
export function ago(from: number, at: number): string {
  const minutes = Math.max(0, Math.round((at - from) / 60_000))
  if (minutes < 1) return tr("admin.just.now")
  if (minutes < 60) return tr("admin.min.ago", { p0: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return tr("admin.h.ago", { p0: hours })
  const days = Math.floor(hours / 24)
  return days === 1 ? tr("admin.yesterday") : tr("admin.days.ago", { p0: days })
}

export const people = (n: number): string => tr("admin.count.people", { count: n })

/**
 * The line of the "Running now" banner.
 *
 * There are two different clocks here, and they go by different words.
 * `liveSince` is when the first of those now sitting in the room came in;
 * that is what "the class has been running for so long" means. `createdAt`
 * is when the room was set up, and rooms are set up a week before the class
 * and reused for a second one, so "started 6 days ago" under "Running now"
 * was always untrue, except in the "created it and started right away" case.
 *
 * Until the server sends `liveSince`, the clock goes by its own name —
 * "created". Lying in the most visible spot of the panel costs more than not
 * knowing.
 */
export function runningLine(
  seminar: { liveCount: number; liveSince?: number | null; createdAt: number },
  now: number,
): string {
  const since = seminar.liveSince ?? null
  const clock = since === null ? tr("admin.created", { p0: ago(seminar.createdAt, now) }) : tr("admin.started", { p0: ago(since, now) })
  return tr("admin.in.the.room", { p0: people(seminar.liveCount), p1: clock })
}
