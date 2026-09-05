<script lang="ts">
  import { OPEN_ROOM } from '@shared/rules'
  import { onMount } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import JoinScreen from '@/screens/JoinScreen.svelte'
  import { api, ApiError } from '@/lib/api'
  import {
    clearStaffMark,
    loadIdentity,
    mightBeStaff,
    saveIdentity,
    type StoredIdentity,
  } from '@/lib/identity'
  import {
    forgetLocalStore,
    recallSessionInfo,
    rememberSessionInfo,
  } from '@/lib/persistence.svelte'
  import { isAdminPath, readCourseId, readPublicRoute, readRoomRoute } from '@/lib/routes'
  import type { SessionInfo } from '@shared/protocol'

  /**
   * The whole router. Two routes — '/' and '/s/:id' — is not enough surface to
   * justify a routing dependency, and the seminar link must stay a plain URL a
   * teacher can paste into any chat window.
   *
   * It renders first and validates afterwards. A student who has been in this
   * room before has the room on disk: waiting for the server to confirm what
   * the browser already knows would buy nothing but a spinner.
   */
  /*
   * Адреса и их разбор живут в `lib/routes.ts` — там же, где их проверяют
   * тесты: регулярка, тихо переставшая совпадать, сборку не уронит, а высадит
   * планшет с живым ключом в адресной строке на экран входа.
   */
  let path = $state(location.pathname)
  /**
   * Комната и то, каким из трёх её экранов её открыли.
   *
   * Режим одним значением, а не двумя флагами: экранов ровно три и они
   * взаимоисключающие, а пара `projection` + `pult` умеет быть включённой
   * одновременно — то есть умеет означать то, чего не бывает.
   */
  const roomRoute = $derived(readRoomRoute(path))
  const sessionId = $derived(roomRoute?.id ?? null)
  const mode = $derived(roomRoute?.mode ?? 'room')
  /** Ключ из ссылки на пульт: планшет меняет его на обычный вход. */
  const handoffKey = $derived(roomRoute?.handoffKey ?? null)
  // The teaching side. It routes its own sub-paths; this only has to get out of
  // the way, and to do so before the seminar route touches localStorage.
  const isAdmin = $derived(isAdminPath(path))
  const courseId = $derived(readCourseId(path))
  const publicSeminar = $derived(readPublicRoute(path))

  /*
   * The admin panel arrives on demand, for the same reason the notebook's
   * renderers do (lib/render.svelte.ts): thirty students hit the join screen at
   * the same moment on the same wifi, and the staff list, the settings form and
   * the seminar table are bytes none of them can use. A dynamic import is the
   * only thing that actually defers a payload — moving a static import into
   * another chunk just moves it.
   *
   * Memoised, so the await block below is handed the same promise on every
   * re-render and the panel is not torn down and rebuilt under the teacher.
   */
  let adminChunk: Promise<typeof import('@/screens/AdminScreen.svelte').default> | null = null
  const adminScreen = () =>
    (adminChunk ??= import('@/screens/AdminScreen.svelte').then((m) => m.default))

  /*
   * The workspace goes the same way, and for a sharper version of the same
   * reason: the notebook, the terminal, the oracle and the two rails are the
   * bulk of this app, and the screen thirty students are looking at is a name
   * field. Statically imported, those bytes had to be fetched, parsed and run
   * before the join form could exist at all.
   *
   * Warmed below the moment a seminar route is on screen, so the chunk is on
   * the wire while the student is still typing — a returning student, who goes
   * straight through, never waits on a request that has not already started.
   */
  let workspaceChunk: Promise<typeof import('@/screens/SessionScreen.svelte').default> | null =
    null
  const workspace = () =>
    (workspaceChunk ??= import('@/screens/SessionScreen.svelte').then((m) => m.default))

  /*
   * Публичные страницы — тоже отдельным куском, и по более резкому поводу, чем
   * панель: это единственные адреса Colloq, которые открывают с телефона, из
   * дома, через неделю после занятия. Тащить туда редактор, терминал и оракула
   * значит платить за них тем, кто пришёл прочитать тетрадь.
   */
  let readerChunk: Promise<typeof import('@/screens/ReaderScreen.svelte').default> | null = null
  const reader = () =>
    (readerChunk ??= import('@/screens/ReaderScreen.svelte').then((m) => m.default))

  let session = $state<SessionInfo | null>(null)
  let identity = $state<StoredIdentity | null>(null)
  let failure = $state<{ missing: boolean; message: string } | null>(null)
  let attempt = $state(0)
  /** Что сказать на экране входа тому, кого туда вернули не по его воле. */
  let notice = $state<string | null>(null)

  /**
   * Место в комнате перестало действовать — назваться придётся заново.
   *
   * Ключ участника живёт тридцать дней и перестаёт проверяться сразу после
   * смены SESSION_SECRET; оба сокета тогда отвергаются на рукопожатии, и
   * комната крутит «Reconnecting» вечно. Починить это молча нельзя — имя
   * выбирает человек, — поэтому сохранённая личность стирается (SessionState
   * это уже сделала), и App возвращается к форме имени с этой строкой.
   * Тетрадь при этом на сервере цела, и сказать об этом важнее всего.
   */
  const EXPIRED_NOTICE =
    'Your place in this seminar expired, so the room asked for your name again. The notebook is unchanged.'

  function navigate(next: string): void {
    if (next !== location.pathname) history.pushState({}, '', next)
    path = next
  }

  /** What this browser already knows about a room, with no request at all. */
  function knownRoom(id: string): SessionInfo {
    const cached =
      recallSessionInfo(id)
    // An unknown name stays empty rather than becoming a guess: it is only a
    // display fallback for the document's own title, and anything written here
    // could end up seeded into the shared document as the seminar's name.
    /*
     * The open room until the server says otherwise. This value only paints the
     * first frame before the real one arrives, and guessing *stricter* rules
     * here would grey out controls that are in fact allowed — a lie that
     * corrects itself a second later, which is the worst kind.
     */
    // published/course пусты до ответа сервера: указатель на опубликованную
    // версию — это утверждение о факте, а первый кадр его не знает.
    return (
      cached ?? {
        id,
        name: '',
        createdAt: Date.now(),
        rules: { ...OPEN_ROOM },
        // И «занятие идёт» — по тому же доводу, что и открытые правила рядом:
        // угадать строже значит погасить кнопки, которые на самом деле живые.
        finishedAt: null,
        published: null,
        course: null,
        // Организация — свойство инстанса, но узнать его до ответа сервера
        // неоткуда. Пусто значит «линейки нет»: надпись, появившаяся вторым
        // кадром, лучше чужой надписи, угаданной первым.
        institution: '',
      }
    )
  }

  function enter(id: string | null): void {
    failure = null
    notice = null
    identity = id ? loadIdentity(id) : null
    session = id ? knownRoom(id) : null
  }

  // Seeded during initialisation rather than from the effect below, so the very
  // first render already contains the room and the document starts loading a
  // paint earlier.
  enter(sessionId)
  let entered = sessionId
  let entryAttempt = 0

  // After the first paint, not during it: the join screen owes nothing to this.
  $effect(() => {
    if (sessionId) void workspace()
  })

  onMount(() => {
    // replaceState, not push: the bare root should not sit in the back stack as
    // a place you can return to, because there is nothing there any more.
    if (location.pathname === '/') {
      history.replaceState({}, '', '/admin')
      path = '/admin'
    }
    const onPop = () => (path = location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  })

  // Background validation. `cancelled` keeps a slow response for a link the user
  // already navigated away from out of the screen they are looking at now.
  $effect(() => {
    const id = sessionId
    const tries = attempt
    if (id !== entered || tries !== entryAttempt) {
      entered = id
      entryAttempt = tries
      enter(id)
    }
    if (!id) return

    let cancelled = false
    api
      .getSession(id)
      .then((info) => {
        if (cancelled) return
        rememberSessionInfo(info)
        session = info
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 404) {
          // The one case where the cache is a liar. Tear the room down and drop
          // its local copy: nobody may be left working inside a room that the
          // server no longer has.
          session = null
          identity = null
          void forgetLocalStore(id)
          failure = { missing: true, message: 'This seminar link is not valid' }
          return
        }
        // Offline, or the server blinked. Anyone already in the room keeps
        // working against the local document and the sockets reconnect on their
        // own; only a visitor with nothing to show needs to hear about this.
        if (!identity) {
          failure = {
            missing: false,
            message: error instanceof Error ? error.message : 'The server did not respond',
          }
        }
      })

    return () => {
      cancelled = true
    }
  })

  /**
   * Catching up with a role that changed after this browser stored one.
   *
   * The stored identity is a cache of a decision the server made once, at join
   * time — and there is one way for it to go out of date that matters. A teacher
   * opens the seminar link first, types their name like everybody else, and gets
   * a participant's identity; later they sign in to the teaching panel and open
   * the same seminar from the list. Nothing re-joins: App sees a stored identity
   * and goes straight to the workspace, so the badge, the kernel controls and
   * every host-only rule stayed with the student they arrived as, in the one
   * browser they will be teaching from.
   *
   * JoinScreen has always asked the server about this — it is the screen that
   * knows a visitor might be staff. It simply never runs for somebody who has
   * been here before.
   *
   * The local mark is a trigger, not a credential: it says only that this
   * browser has signed in to the teaching side at some point, so it is worth
   * ASKING. The answer is the server's, and it comes from the same join route
   * with the same rules, reading the same HttpOnly cookie. A stale mark is worth
   * exactly one refused request, after which it is dropped.
   */
  $effect(() => {
    const id = sessionId
    const me = identity
    if (!id || !me || me.role === 'host' || !mightBeStaff()) return

    let cancelled = false
    void api
      .join(id, { name: me.name, avatar: me.avatar, participantId: me.participantId, token: me.token })
      .then((res) => {
        if (cancelled) return
        if (res.participant.role !== 'host') {
          // Signed out since, or never staff in the first place. Stop asking.
          clearStaffMark()
          return
        }
        const next: StoredIdentity = {
          sessionId: id,
          participantId: res.participant.id,
          token: res.token,
          name: res.participant.name,
          avatar: res.participant.avatar,
          color: res.participant.color,
          role: res.participant.role,
        }
        saveIdentity(next)
        identity = next
      })
      .catch(() => {
        // Offline, or the server blinked. Whoever is here keeps working as
        // whoever they already were; the next load asks again.
      })

    return () => {
      cancelled = true
    }
  })

  /**
   * Ссылка на пульт: обменять ключ на вход и стереть его из адреса.
   *
   * Планшет открывает `/s/:id/t/<ключ>` и должен оказаться в комнате ТЕМ ЖЕ
   * человеком, что и ноутбук, — без формы имени и без второго участника в
   * списке. Ключ одноразовый и живёт минуты, но адрес переживает и то и
   * другое: он остаётся в истории, во вкладках и на снимке экрана, который
   * преподаватель потом покажет классу. Поэтому сразу после обмена адрес
   * заменяется — replaceState, чтобы «назад» не возвращало на мёртвый ключ.
   *
   * Заменяется на `/s/:id/pult`, а не на комнату: этой ссылкой открывают
   * планшет, чтобы ВЕСТИ, и раньше он приезжал в ту же комнату, что и ноутбук —
   * с вкладками, панелью файлов и оракулом, из которых на паре не нужно ничего.
   * Комната остаётся в одном нажатии («В комнату» в «Ещё»), а пульт больше не
   * надо искать.
   *
   * Не сработавший ключ — исключение: там пульта не будет (право на него —
   * `role === 'host'`), и адрес пульта, оставшийся в строке после отказа, был
   * бы обещанием, которого никто не сдержит.
   */
  let claiming = $state(false)
  let claimedKey: string | null = null
  $effect(() => {
    const id = sessionId
    const key = handoffKey
    if (!id || !key || claimedKey === key) return
    claimedKey = key
    claiming = true
    let landing = `/s/${id}/pult`
    void api
      .claimHandoff(id, key)
      .then((res) => {
        const next: StoredIdentity = {
          sessionId: id,
          participantId: res.participant.id,
          token: res.token,
          name: res.participant.name,
          avatar: res.participant.avatar,
          color: res.participant.color,
          role: res.participant.role,
        }
        saveIdentity(next)
        session = res.session
        identity = next
      })
      .catch((cause: unknown) => {
        /*
         * Ключ протух — это обычный ход дела, а не поломка: ссылку открыли
         * через час. Показываем причину и оставляем экран входа: войти по
         * имени по-прежнему можно, просто без чужих прав.
         */
        failure = {
          missing: false,
          message:
            cause instanceof ApiError
              ? cause.message
              : 'Ссылка на пульт не сработала — попросите новую.',
        }
        landing = `/s/${id}`
      })
      .finally(() => {
        claiming = false
        history.replaceState({}, '', landing)
        path = landing
      })
  })

  // The join screen's poster half does not depend on the seminar name, so it
  // paints immediately; a non-breaking space holds the line the name lands on so
  // its arrival never pushes the form down.
  const poster = $derived(session ? { ...session, name: session.name || '\u00a0' } : null)
</script>

{#if courseId || publicSeminar}
  <!-- Ни токена, ни личности, ни сокетов: эти страницы читают и всё. -->
  <!--
    По ключу страницы, а не по одному условию на обе: `/c/…` и `/p/…` — один и
    тот же компонент, и переход между ними (нажатие на семинар в списке курса)
    менял только пропсы. Экран при этом оставался прежним: загруженный курс
    никто не гасил, и студент, ткнув в занятие, видел тот же список.

    Ключ без шага: `/p/:id/3` → `/p/:id/4` — это перелистывание внутри одной
    публикации, и пересобирать её ради него значило бы загружать семинар
    заново на каждый шаг.
  -->
  {#key courseId ?? publicSeminar?.id}
    {#await reader() then Reader}
      <Reader
        course={courseId}
        publication={publicSeminar}
        onnavigate={(next) => navigate(next)}
      />
    {/await}
  {/key}
{:else if isAdmin}
  <!-- No pending branch: the chunk is one request on a local network and the
       panel itself paints an empty canvas until the server answers, so a
       spinner here would only add a second flash to the same wait. -->
  {#await adminScreen() then AdminScreen}
    <AdminScreen />
  {/await}
{:else if sessionId === null}
  <!--
    The root is not a screen any more. Students never arrive here — they open a
    seminar link — so the only person who ever types the bare address is staff,
    and what they want is the panel. AdminScreen shows the sign-in when there is
    no session, which is the "or the sign-in" half of it.
  -->
  {#await adminScreen() then AdminScreen}
    <AdminScreen />
  {/await}
{:else if failure}
  <div class="flex h-full items-center justify-center px-6">
    <div class="w-full max-w-sm animate-fade-up text-center">
      <span
        class="mx-auto flex h-10 w-10 items-center justify-center border border-line bg-surface text-faint"
      >
        <Icon name={failure.missing ? 'link' : 'bolt'} size={16} />
      </span>
      <h1 class="mt-4 text-title font-semibold tracking-tight text-ink">
        {failure.missing ? 'This seminar link is not valid' : 'Could not open this seminar'}
      </h1>
      <p class="mt-1.5 text-ui-lg leading-relaxed text-muted">
        {failure.missing
          ? 'The seminar may have ended, or the link was copied only halfway. Ask whoever shared it for a fresh one.'
          : failure.message}
      </p>
      <div class="mt-5 flex items-center justify-center gap-2">
        {#if !failure.missing}
          <button class="btn-primary" onclick={() => (attempt += 1)}>Try again</button>
        {/if}
        <button
          class={failure.missing ? 'btn-outline' : 'btn-ghost'}
          onclick={() => navigate('/')}
        >
          Back to Colloq
        </button>
      </div>
    </div>
  </div>
{:else if claiming || handoffKey}
  <!--
    Обмен ключа на вход. Занимает один запрос, но экран входа мигнуть за это
    время успевает — а человек, который только что открыл ссылку «свой пульт»,
    увидел бы форму «как вас зовут» и решил бы, что ссылка не сработала.
  -->
  <div class="flex h-full items-center justify-center bg-canvas">
    <div class="flex items-center gap-2 text-ui text-muted">
      <Icon name="spinner" size={14} class="animate-spin" />
      Входим в комнату…
    </div>
  </div>
{:else if session && identity}
  {@const room = session}
  {@const me = identity}
  <!--
    Keyed on the token, not on the person. A different participant is obviously
    a different room to be in, but so is the same participant holding a new
    credential: SessionState reads the token once and opens both sockets with
    it, so a role upgraded in place would have painted a host's controls over a
    connection the server still answers as a student's.
  -->
  {#key me.token}
    <!-- No pending branch, as with the admin panel above: the workspace paints
         its own empty room while the document loads, and a spinner in front of
         it would only be a second thing to wait through. -->
    {#await workspace() then Workspace}
      <Workspace
        session={room}
        identity={me}
        {mode}
        onnavigate={(next) => navigate(next)}
        onexpired={() => {
          identity = null
          notice = EXPIRED_NOTICE
        }}
      />
    {/await}
  {/key}
{:else if poster}
  <JoinScreen session={poster} {notice} onjoined={(next) => (identity = next)} />
{/if}
