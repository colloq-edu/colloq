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
   * Почему не пустили. 'unclaimed' — не ошибка, а состояние инстанса, и
   * маршрутизатору важно отличать его от отозванного токена: одно приглашает
   * заполнить форму, другое надо сказать словами.
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
   * Вход в этой вкладке уже удавался.
   *
   * Нужен, чтобы отличить обычного посетителя без печенья от того, у кого
   * печенье не сохранилось: 401 у них один и тот же, а сказать им надо разное.
   */
  #signedIn = false
  /**
   * Что случилось прямо перед этим перечитыванием, если экран это знает.
   *
   * Экран, получивший 401 на действие, знает больше, чем `#read`: печенье
   * доехало и его отвергли — ссылку ротировали или человека сняли из штата. Без
   * этой подсказки все три исхода говорили одно и то же — «браузер не прислал
   * сессию, разрешите печенья», — и снятый из штата преподаватель шёл в
   * настройки браузера вместо того, чтобы попросить у владельца новую ссылку.
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
    // Причина сильнее отсутствия причины: перечитывание, начатое рядовым
    // экраном, не должно проглотить «вас только что отвергли».
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
       * Вход был — и его больше нет. Почему именно, зависит от того, кто
       * спрашивал.
       *
       * `#readMe` глотает 401 намеренно: посетитель без печенья — обычное дело,
       * а не отказ. Но если вход в этой вкладке уже удавался или экран пришёл
       * сюда с 401 на действие, тот же 401 значит, что человека надо
       * предупредить. Молчать тут нельзя — ключ из адресной строки к этому
       * моменту уже потрачен, и человек оставался перед формой входа без
       * единого слова о том, что произошло.
       *
       * И три случая говорят разное: печенье не доехало (чинится настройками
       * браузера), печенье отвергли (чинится новой ссылкой у владельца), сам
       * удалил свой аккаунт (не чинится вовсе). Одно сообщение на всех отправляло
       * снятого из штата разбираться с cookies.
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
    // Уход по своей воле — не отказ: причина, оставленная прошлым экраном, не
    // должна дописаться к «вы вышли».
    this.#reason = null
    clearStaffMark()
    this.error = null
    this.errorReason = null
    /*
     * И забыть токен установки.
     *
     * Он живёт здесь, чтобы форма первого запуска не просила переписывать
     * тридцать два символа, — но это ключ владельца, а не черновик. Оставленный
     * в памяти, он подставлялся в поле входа после «Sign out»: на проекторе, при
     * полном зале. Свою работу он к этому моменту уже сделал.
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
      // Токен свою работу сделал — дальше он только лежит в памяти вкладки и
      // ждёт, когда его подставят в поле входа на общем экране.
      this.offeredSetupToken = null
      this.state = await adminApi.state()
      return true
    } catch (cause: unknown) {
      this.me = null
      clearStaffMark()
      this.#error = () => messageFor(cause)
      this.errorReason = cause instanceof AdminApiError ? cause.reason : null
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
