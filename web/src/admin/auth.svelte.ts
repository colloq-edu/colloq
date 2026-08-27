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
import { AdminApiError, adminApi } from '@/lib/adminApi'

function messageFor(cause: unknown): string {
  if (cause instanceof AdminApiError) return cause.message
  if (cause instanceof Error) return cause.message
  return 'The server did not respond'
}

class AdminAuth {
  me = $state<AdminMe | null>(null)
  state = $state<InstanceState | null>(null)
  loading = $state(false)
  error = $state<string | null>(null)
  /**
   * The server has answered at least once. Distinct from `!loading`, which is
   * also true before the first request — and "not signed in" must never be
   * inferred from "have not asked yet".
   */
  ready = $state(false)

  #inflight: Promise<void> | null = null

  get isOwner(): boolean {
    return this.me?.teacher.role === 'owner'
  }

  /** Idempotent: the shell and every screen inside it ask, and one request answers all. */
  load(): Promise<void> {
    if (this.ready && !this.#inflight) return Promise.resolve()
    return this.refresh()
  }

  refresh(): Promise<void> {
    this.#inflight ??= this.#read().finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  async #read(): Promise<void> {
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
    } catch (cause: unknown) {
      this.error = messageFor(cause)
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
    clearStaffMark()
    this.error = null
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
    try {
      this.me = await exchange()
      // The seminar side reads this to know whether to ask the server who you are.
      markStaff()
      this.state = await adminApi.state()
      return true
    } catch (cause: unknown) {
      this.me = null
      clearStaffMark()
      this.error = messageFor(cause)
      /*
       * Состояние инстанса нужно и при отказе.
       *
       * Ключ из ссылки тратится один раз: адресную строку уже переписали, а
       * `state` в этой ветке никогда не читался — и экран входа, у которого
       * весь правый столбец висит на `{#if instance}`, оказывался пустым. Так
       * выглядел отозванный ключ: белая страница без единого слова.
       */
      if (!this.state) {
        try {
          this.state = await adminApi.state()
        } catch {
          // Сервер недоступен целиком — об этом расскажет ветка ниже на экране.
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
