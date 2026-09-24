import { tr, getLocale } from '@shared/i18n'
/**
 * Who is signed in to the teaching side, and whether this instance has an owner
 * at all.
 *
 * Nothing here is cached across visits, and that is deliberate: the credential
 * is an HttpOnly cookie the page cannot read, so "am I signed in" is a question
 * only the server can answer. `loading` is therefore honest rather than
 * decorative — but the answer arrives in a few milliseconds, so screens render
 * their frame and let the content land instead of drawing a spinner over it.
 */
import type { AdminMe, ClaimRequest, InstanceState } from '@shared/admin'
import { clearStaffMark, markStaff } from '@/lib/identity'
import { AdminApiError, adminApi, type AdminErrorReason } from '@/lib/adminApi'
import { signedOutNotice, type SignedOutReason } from '@/admin/panel'

function messageFor(cause: unknown): string {
  if (cause instanceof AdminApiError) return cause.message
  if (cause instanceof Error) return cause.message
  return tr("admin.the.server.did.not.respond")
}

class AdminAuth {
  me = $state<AdminMe | null>(null)
  state = $state<InstanceState | null>(null)
  loading = $state(false)
  #error = $state<(() => string) | null>(null)
  get error(): string | null { return this.#error?.() ?? null }
  set error(value: string | null) { this.#error = value === null ? null : () => value }
  setError(render: () => string): void { this.#error = render }
  /**
   * Why we were not let in. 'unclaimed' is not an error but a state of the
   * instance, and the router must tell it apart from a revoked token: one
   * invites you to fill in a form, the other has to be said in words.
   */
  errorReason = $state<AdminErrorReason | null>(null)
  /**
   * The server has answered at least once. Distinct from `!loading`, which is
   * also true before the first request — and "not signed in" must never be
   * inferred from "have not asked yet".
   */
  ready = $state(false)

  #inflight: Promise<void> | null = null
  /**
   * Signing in has already succeeded in this tab.
   *
   * Needed to tell an ordinary visitor without a cookie from someone whose
   * cookie was not kept: both get the same 401, but they need to be told
   * different things.
   */
  #signedIn = false
  /**
   * What happened right before this re-read, if the screen knows.
   *
   * A screen that got a 401 on an action knows more than `#read` does: the
   * cookie arrived and was rejected — the link was rotated or the person was
   * removed from the staff. Without this hint all three outcomes said the same
   * thing — "the browser did not send a session, allow cookies" — and a
   * teacher removed from the staff went to the browser settings instead of
   * asking the owner for a new link.
   */
  #reason: SignedOutReason | null = null

  get isOwner(): boolean {
    return this.me?.teacher.role === 'owner'
  }

  /** Idempotent: the shell and every screen inside it ask, and one request answers all. */
  load(): Promise<void> {
    if (this.ready && !this.#inflight) return Promise.resolve()
    return this.refresh()
  }

  refresh(reason?: SignedOutReason): Promise<void> {
    // A reason beats the absence of one: a re-read started by an ordinary
    // screen must not swallow "you were just rejected".
    if (reason) this.#reason = reason
    this.#inflight ??= this.#read().finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  async #read(): Promise<void> {
    const reason = this.#reason
    this.#reason = null
    this.loading = true
    try {
      const [state, me] = await Promise.all([adminApi.state(), this.#readMe()])
      this.state = state
      this.me = me
      // Every path that establishes who you are keeps the hint in step, not just
      // the explicit sign-in: a teacher who comes back tomorrow restores their
      // session through here, and the seminar screen would otherwise stop
      // recognising them.
      if (me) markStaff()
      else clearStaffMark()
      this.error = null
      this.errorReason = null
      /*
       * There was a session — and now there is none. Why exactly depends on
       * who was asking.
       *
       * `#readMe` swallows a 401 on purpose: a visitor without a cookie is the
       * normal case, not a refusal. But if signing in has already succeeded in
       * this tab, or a screen came here with a 401 on an action, the same 401
       * means the person has to be warned. Staying silent is not an option —
       * the key from the address bar has already been spent by now, and the
       * person was left in front of the sign-in form without a single word
       * about what happened.
       *
       * And the three cases say different things: the cookie did not arrive
       * (fixed in the browser settings), the cookie was rejected (fixed with a
       * new link from the owner), the person deleted their own account (not
       * fixable at all). One message for everyone sent a teacher removed from
       * the staff off to deal with cookies.
       */
      if (!me && (this.#signedIn || reason !== null)) {
        this.#signedIn = false
        this.#error = () => signedOutNotice(reason ?? 'no-cookie')
        this.errorReason = 'unauthenticated'
      }
    } catch (cause: unknown) {
      this.#error = () => messageFor(cause)
      this.errorReason = cause instanceof AdminApiError ? cause.reason : null
    } finally {
      this.loading = false
      this.ready = true
    }
  }

  /** A visitor with no cookie is the normal case, not a failure to report. */
  async #readMe(): Promise<AdminMe | null> {
    try {
      return await adminApi.me()
    } catch (cause: unknown) {
      if (
        cause instanceof AdminApiError &&
        (cause.reason === 'unauthenticated' || cause.reason === 'unclaimed')
      ) {
        return null
      }
      throw cause
    }
  }

  claim(input: ClaimRequest): Promise<boolean> {
    return this.#authenticate(() => adminApi.claim(input))
  }

  signInWithToken(token: string): Promise<boolean> {
    return this.#authenticate(() => adminApi.signInWithToken(token))
  }

  signInWithKey(key: string): Promise<boolean> {
    return this.#authenticate(() => adminApi.signInWithKey(key))
  }

  /**
   * A setup token that arrived in the URL but could not be spent yet, because
   * the instance has no owner and claiming needs a name and an email.
   *
   * Held here rather than passed as a prop: the screen that needs it is chosen
   * by the router two levels up, and threading a value through a branch that
   * exists for one first-run case would put it in every other path too.
   */
  offeredSetupToken = $state<string | null>(null)

  offerSetupToken(token: string): void {
    this.offeredSetupToken = token
  }

  async signOut(): Promise<void> {
    try {
      await adminApi.signOut()
    } catch {
      // The cookie may already be gone or expired; either way this browser is
      // done with it, and refusing to leave the panel would be absurd.
    }
    this.me = null
    this.#signedIn = false
    // Leaving of one's own accord is not a refusal: a reason left by the
    // previous screen must not be appended to "you signed out".
    this.#reason = null
    clearStaffMark()
    this.error = null
    this.errorReason = null
    /*
     * And forget the setup token.
     *
     * It lives here so the first-run form does not ask you to retype thirty-two
     * characters — but it is the owner's key, not a draft. Left in memory, it
     * was filled into the sign-in field after "Sign out": on the projector, in
     * front of a full room. By then it has already done its job.
     */
    this.offeredSetupToken = null
    await this.refresh()
  }

  /**
   * Every credential exchange ends with the same two facts changing, so they
   * are re-read together: claiming an instance also flips `claimed`, and a
   * rotated link can change the role that came back last time.
   */
  async #authenticate(exchange: () => Promise<AdminMe>): Promise<boolean> {
    this.loading = true
    this.error = null
    this.errorReason = null
    try {
      this.me = await exchange()
      this.#signedIn = true
      // The seminar side reads this to know whether to ask the server who you are.
      markStaff()
      // The token has done its job — from here on it only sits in the tab's
      // memory waiting to be filled into the sign-in field on a shared screen.
      this.offeredSetupToken = null
      this.state = await adminApi.state()
      return true
    } catch (cause: unknown) {
      this.me = null
      clearStaffMark()
      this.#error = () => messageFor(cause)
      this.errorReason = cause instanceof AdminApiError ? cause.reason : null
      /*
       * The instance state is needed on a refusal too.
       *
       * The key from the link is spent once: the address bar has already been
       * rewritten, and `state` was never read in this branch — so the sign-in
       * screen, whose whole right column hangs on `{#if instance}`, came out
       * empty. That is what a revoked key looked like: a white page without a
       * single word.
       */
      if (!this.state) {
        try {
          this.state = await adminApi.state()
        } catch {
          // The server is down entirely — a branch further down the screen
          // will say so.
        }
      }
      return false
    } finally {
      this.loading = false
      this.ready = true
    }
  }
}

export const adminAuth = new AdminAuth()
