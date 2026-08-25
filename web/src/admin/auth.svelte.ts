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

  /** Idempotent: the shell and the home screen both ask, and one request answers both. */
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

  async signOut(): Promise<void> {
    try {
      await adminApi.signOut()
    } catch {
      // The cookie may already be gone or expired; either way this browser is
      // done with it, and refusing to leave the panel would be absurd.
    }
    this.me = null
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
      this.state = await adminApi.state()
      return true
    } catch (cause: unknown) {
      this.me = null
      this.error = messageFor(cause)
      return false
    } finally {
      this.loading = false
      this.ready = true
    }
  }
}

export const adminAuth = new AdminAuth()
