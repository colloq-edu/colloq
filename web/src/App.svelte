<script lang="ts">
  import { tr } from '@shared/i18n'
  import { OPEN_ROOM } from '@shared/rules'
  import { onMount } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Splash from '@/components/ui/Splash.svelte'
  import JoinScreen from '@/screens/JoinScreen.svelte'
  import { firstScreenReady } from '@/lib/boot'
  import { api, ApiError } from '@/lib/api'
  import {
    loadIdentity,
    mightBeStaff,
    saveIdentity,
    type StoredIdentity,
  } from '@/lib/identity'
  import {
    forgetSessionInfo,
    recallSessionInfo,
    rememberSessionInfo,
  } from '@/lib/session-cache'
  import {
    handoffLanding,
    isAdminPath,
    readCompetitionRoute,
    readCourseId,
    readPublicRoute,
    readRoomRoute,
  } from '@/lib/routes'
  import { upgradeIfStaff } from '@/screens/staff'
  import { loadLocalizedScreen, reloadAreaMessages } from '@/lib/screen-language'
  import { language, messagesChanged } from '@/lib/i18n.svelte'
  import { saysSessionMissing, type SessionInfo } from '@shared/protocol'

  // Removing a deleted room is the only entry-screen operation that needs
  // IndexedDB; normal cold entry must not download the notebook CRDT for it.
  const forgetLocalStore = (id: string) => {
    forgetSessionInfo(id)
    return import('@/lib/persistence.svelte')
      .then((store) => store.forgetLocalStore(id))
      .catch(() => {})
  }

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
   * Addresses and their parsing live in `lib/routes.ts` — the same place where
   * the tests check them: a regex that quietly stopped matching will not break
   * the build, but it will drop a tablet with a live key in the address bar
   * onto the entry screen.
   */
  let path = $state(location.pathname)
  /**
   * The room and which of its screens it was opened with.
   *
   * The mode is one value, not a set of flags: there are exactly four screens
   * and they are mutually exclusive, while a `projection` + `pult` pair can be
   * switched on at the same time — that is, it can mean something that does
   * not happen.
   */
  const roomRoute = $derived(readRoomRoute(path))
  const sessionId = $derived(roomRoute?.id ?? null)
  const mode = $derived(roomRoute?.mode ?? 'room')
  /** The council console's cell — only in the `council` mode. */
  const councilCell = $derived(roomRoute?.cellId ?? null)
  /** The key from the console link: the tablet exchanges it for an ordinary entry. */
  const handoffKey = $derived(roomRoute?.handoffKey ?? null)
  // The teaching side. It routes its own sub-paths; this only has to get out of
  // the way, and to do so before the seminar route touches localStorage.
  const isAdmin = $derived(isAdminPath(path))
  const courseId = $derived(readCourseId(path))
  const publicSeminar = $derived(readPublicRoute(path))
  /*
   * Competitions are the product's fourth public door, next to the course and
   * the publication: there is no room and no participant token here, and the
   * identity is its own, instance-level, and lives in a cookie, not in
   * localStorage.
   */
  const competition = $derived(readCompetitionRoute(path))

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
    (adminChunk ??= loadLocalizedScreen(
      () => import('@/screens/AdminScreen.svelte').then((m) => m.default), 'admin', language.current))

  /*
   * The workspace goes the same way, and for a sharper version of the same
   * reason: the notebook, the terminal, the oracle and the two rails are the
   * bulk of this app, and the screen thirty students are looking at is a name
   * field. Statically imported, those bytes had to be fetched, parsed and run
   * before the join form could exist at all.
   *
   * Evaluation starts alongside the join request. The build preloads room
   * bytes after the form paints, so neither phase holds up the name field.
   */
  let workspaceChunk: Promise<typeof import('@/screens/SessionScreen.svelte').default> | null =
    null
  const workspace = () =>
    (workspaceChunk ??= loadLocalizedScreen(
      () => import('@/screens/SessionScreen.svelte').then((m) => m.default), 'room', language.current))

  /*
   * Public pages are a separate chunk too, and for a sharper reason than the
   * panel: they are the only Colloq addresses people open from a phone, from
   * home, a week after the class. Dragging the editor, the terminal and the
   * Oracle there means making those who came to read a notebook pay for them.
   */
  let readerChunk: Promise<typeof import('@/screens/ReaderScreen.svelte').default> | null = null
  const reader = () =>
    (readerChunk ??= loadLocalizedScreen(
      () => import('@/screens/ReaderScreen.svelte').then((m) => m.default), 'reader', language.current))

  /*
   * And competitions — in the same kind of chunk and for the same reason: `/k`
   * is opened at home from a phone an hour before the deadline, and the
   * editor, the terminal and the Oracle are not needed there by a single line.
   * They have their own dictionary (lib/screen-language.ts · competitions).
   */
  let competitionsChunk:
    | Promise<typeof import('@/screens/CompetitionsScreen.svelte').default>
    | null = null
  const competitions = () =>
    (competitionsChunk ??= loadLocalizedScreen(
      () => import('@/screens/CompetitionsScreen.svelte').then((m) => m.default),
      'competitions',
      language.current,
    ))

  let session = $state<SessionInfo | null>(null)
  let identity = $state<StoredIdentity | null>(null)
  let failure = $state<{ missing: boolean; message: string } | null>(null)
  /** The room is known, not guessed: see `enter`. */
  let confirmed = $state(false)
  let attempt = $state(0)
  /** What to say on the entry screen to someone who was sent back there against their will. */
  let notice = $state<string | null>(null)

  /**
   * The seat in the room stopped being valid — one has to introduce oneself
   * again.
   *
   * A participant key lives thirty days and stops verifying right after
   * SESSION_SECRET changes; both sockets are then refused at the handshake,
   * and the room spins "Reconnecting" forever. This cannot be fixed silently —
   * the person chooses the name — so the saved identity is erased
   * (SessionState has already done that), and App returns to the name form
   * with this line. The notebook on the server is intact, and saying so
   * matters most.
   */
  const EXPIRED_NOTICE =
    tr('room.ui.1219')

  function navigate(next: string): void {
    if (next !== location.pathname) history.pushState({}, '', next)
    /*
     * Public pages are the only ones in the whole product where the document
     * itself scrolls: the room is pinned to the window height. A transition
     * inside them is a new page, not a panel change, and it must open at the
     * top: a student who had scrolled the course down to the fifteenth row and
     * clicked a seminar landed in the middle of someone else's notebook,
     * without the header and without the steps rail, and decided they had
     * clicked the wrong thing.
     *
     * Only for forward navigation. `popstate` does not come here (it has its
     * own listener), and this is on purpose: the position on the page one
     * left is the browser's business, and the browser restores it.
     */
    if (next.startsWith('/c/') || next.startsWith('/p/')) window.scrollTo({ top: 0 })
    path = next
  }

  /** What this browser already knows about a room, with no request at all. */
  function knownRoom(id: string, cached: SessionInfo | null): SessionInfo {
    // An unknown name stays empty rather than becoming a guess: it is only a
    // display fallback for the document's own title, and anything written here
    // could end up seeded into the shared document as the seminar's name.
    /*
     * The open room until the server says otherwise. This value only paints the
     * first frame before the real one arrives, and guessing *stricter* rules
     * here would grey out controls that are in fact allowed — a lie that
     * corrects itself a second later, which is the worst kind.
     */
    // published/course are empty until the server answers: a pointer to the
    // published version is a statement of fact, and the first frame does not
    // know it.
    return (
      cached ?? {
        id,
        name: '',
        createdAt: Date.now(),
        rules: { ...OPEN_ROOM },
        // And "class in progress" — by the same argument as the open rules
        // next to it: guessing stricter means putting out buttons that are in
        // fact live.
        finishedAt: null,
        published: null,
        course: null,
        // The organization is a property of the instance, but there is no way
        // to learn it before the server answers. Empty means "no separator": a
        // label that appears on the second frame is better than a wrong label
        // guessed on the first.
        institution: '',
      }
    )
  }

  function enter(id: string | null): void {
    failure = null
    notice = null
    identity = id ? loadIdentity(id) : null
    const cached = id ? recallSessionInfo(id) : null
    /*
     * "Something is known about the room" means the server's answer or the
     * browser's memory, but NOT the placeholder from `knownRoom`: it has an
     * empty name and guessed rules, and removing the splash on it means showing
     * an entry form with a grey bar in place of the class name. Exactly the
     * frame the splash is held for (lib/boot.ts).
     */
    confirmed = cached !== null
    session = id ? knownRoom(id, cached) : null
  }

  // Seeded during initialisation rather than from the effect below, so the very
  // first render already contains the room and the document starts loading a
  // paint earlier.
  enter(sessionId)
  let entered = sessionId
  let entryAttempt = 0

  // A returning visitor goes straight to the room; a new visitor joins first.
  $effect(() => {
    if (sessionId && identity) void workspace()
  })

  /*
   * The language was changed — fetch the dictionary for the screen that is
   * already open.
   *
   * A screen dictionary carries one language (lib/screen-language.ts), so a
   * language change is also a download. Until it finishes, `translate` gives
   * the previous language, not a bare key; `messagesChanged` redraws what was
   * translated once the dictionary has arrived. The screen chunks are not
   * touched: no memory of the room is rebuilt because of the language switch.
   */
  let localeShown = language.current
  $effect(() => {
    const locale = language.current
    if (locale === localeShown) return
    localeShown = locale
    void reloadAreaMessages(locale).then(messagesChanged, () => {})
  })

  /**
   * When to remove the splash from index.html — on the screens App draws
   * itself (lib/boot.ts · who reports).
   *
   * There are two. The failure screen is already a screen: there is nothing
   * left to wait for under the splash, and it must hang no longer than there
   * is hope. The entry form is a screen as soon as it is known WHERE people
   * are entering: its header has the class name, and until the server answers
   * a placeholder stands there.
   *
   * The other branches report for themselves when they arrive: the panel, the
   * reader, the room. Exchanging the key for an entry (`claiming`) stays
   * silent on purpose — it is one request, and the splash over it is more
   * honest than an "Opening the console…" line flickering under it.
   */
  $effect(() => {
    if (failure || (session && !identity && confirmed)) firstScreenReady()
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
        confirmed = true
      })
      .catch((error: unknown) => {
        if (cancelled) return
        /*
         * OUR 404, not just any.
         *
         * This is where the local copy of the notebook is wiped — that is,
         * everything the person managed to type without a connection — and
         * this must not be done on a bare status code: a 404 also comes from a
         * relay whose frpc has dropped, and from static hosting that serves
         * index.html for everything. Then a connection glitch turned into
         * "this seminar has been deleted" for the whole class at once. The sign
         * is the server's words in the response body (shared/protocol.ts ·
         * saysSessionMissing); a foreign 404 is handled below as an ordinary
         * dropped connection.
         */
        if (saysSessionMissing(error)) {
          // The one case where the cache is a liar. Tear the room down and drop
          // its local copy: nobody may be left working inside a room that the
          // server no longer has.
          session = null
          identity = null
          void forgetLocalStore(id)
          failure = { missing: true, get message() { return tr('room.ui.1210') } }
          return
        }
        // Offline, or the server blinked. Anyone already in the room keeps
        // working against the local document and the sockets reconnect on their
        // own; only a visitor with nothing to show needs to hear about this.
        if (!identity) {
          failure = {
            missing: false,
            message: error instanceof Error ? error.message : tr('room.ui.1220'),
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
    // One helper for both screens — see screens/staff.ts: removing the mark
    // and parsing the "no"/"don't know" answer lived here and in JoinScreen,
    // each in its own way.
    void upgradeIfStaff(id, me)
      .then((next) => {
        if (!cancelled && next) identity = next
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
   * The console link: exchange the key for an entry and erase it from the
   * address.
   *
   * The tablet opens `/s/:id/t/<key>` and must end up in the room as THE SAME
   * person as the laptop — without the name form and without a second
   * participant in the list. The key is single-use and lives for minutes, but
   * the address outlives both: it stays in the history, in tabs and on the
   * screenshot the teacher will later show the class. So right after the
   * exchange the address is replaced — replaceState, so that "back" does not
   * return to a dead key.
   *
   * It is replaced with THE SCREEN THE LINK NAMED (`handoffLanding`), not with
   * the room: this link opens the tablet in order to LEAD, and it used to
   * arrive in the same room as the laptop — with tabs, the files panel and the
   * Oracle, none of which is needed in class. The room stays one tap away
   * ("Go to room" in "More"), and the console no longer has to be searched
   * for.
   *
   * The screen is taken from the parse BEFORE the exchange and remembered:
   * `path` changes right here, and reading it afterwards would be reading our
   * own trace. The council console lives by this — a link with a key leads to
   * a specific cell, not "somewhere into the console"; a bare `/s/:id/t/<key>`
   * still means the lecture console.
   *
   * A key that did not work is the exception: there will be no console there
   * (the right to it is `role === 'host'`), and a console address left in the
   * bar after a refusal would be a promise nobody will keep.
   */
  let claiming = $state(false)
  let claimedKey: string | null = null
  $effect(() => {
    const id = sessionId
    const key = handoffKey
    if (!id || !key || claimedKey === key) return
    claimedKey = key
    claiming = true
    let landing = handoffLanding({ id, mode, cellId: councilCell })
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
        confirmed = true
        identity = next
      })
      .catch((cause: unknown) => {
        /*
         * An expired key is the ordinary course of things, not a breakage: the
         * link was opened an hour later. So the reason travels as a note to
         * the entry screen, not as a failure screen.
         *
         * Previously `failure` was set here, and the `failure` branch in the
         * markup stands before both the room and the form: the comment
         * promised "we keep the entry screen", but in fact the person saw
         * "Could not open this seminar" — even one who already had an identity
         * saved for this room. The teacher's laptop, having opened yesterday's
         * console link, got thrown out of a live room until "Try again" was
         * pressed.
         *
         * The note is drawn by JoinScreen; whoever has an identity simply
         * enters the room, and there is nothing to tell them: they will open
         * the console from "More".
         */
        notice =
          cause instanceof ApiError
            ? cause.message
            : tr('room.ui.1221')
        landing = `/s/${id}`
      })
      .finally(() => {
        claiming = false
        history.replaceState({}, '', landing)
        path = landing
      })
  })
</script>

{#if courseId || publicSeminar}
  <!-- No token, no identity, no sockets: these pages are read, and that is all. -->
  <!--
    By the page key, not by one condition for both: `/c/…` and `/p/…` are one
    and the same component, and a transition between them (clicking a seminar
    in the course list) changed only the props. The screen stayed the same:
    nobody put out the loaded course, and a student who clicked a class saw
    the same list.

    The key without the step: `/p/:id/3` → `/p/:id/4` is paging within one
    publication, and rebuilding it for that would mean loading the seminar
    again on every step.

    AND WITH A KIND PREFIX. A slug is unique within its kind, not globally:
    course and publication addresses are checked against different tables (the
    PK is the kind+slug pair), so `/c/ml-2026` and `/p/ml-2026` exist at the
    same time perfectly legitimately. A bare handle gave them the same key, the
    screen was not rebuilt, nobody put out the loaded course — and a click on a
    seminar in the list changed the address, leaving the same list on the
    screen.
  -->
  {#key courseId ? `c:${courseId}` : `p:${publicSeminar?.id ?? ''}`}
    {#await reader()}
      <Splash />
    {:then Reader}
      <Reader
        course={courseId}
        publication={publicSeminar}
        onnavigate={(next) => navigate(next)}
      />
    {/await}
  {/key}
{:else if competition}
  <!--
    Competition pages. They stand before the panel and before the room because
    `/k/…` overlaps with neither, and the sign-in link (`/k/t/<key>`) must
    reach its screen before anything decides the address is unfamiliar and
    sends the person to the panel.

    Without a key: `#key` is not needed here — moving between the tabs of one
    competition is the same page, and rebuilding it would mean loading the task
    again on every click.
  -->
  {#await competitions()}
    <Splash />
  {:then Competitions}
    <Competitions route={competition} onnavigate={(next) => navigate(next)} />
  {/await}
{:else if isAdmin}
  {#await adminScreen()}
    <Splash />
  {:then AdminScreen}
    <AdminScreen />
  {/await}
{:else if sessionId === null}
  <!--
    The root is not a screen any more. A student has no reason to type the bare
    address — they open a seminar link — so whoever lands here is staff, and
    what they want is the panel. AdminScreen shows the sign-in when there is no
    session, which is the "or the sign-in" half of it.

    "Has no reason" is not the same as "cannot": every exit from the room used
    to bring a student here, because both the mark in the header and the button
    on the failure screen led to `/`. Both now lead only staff there — see
    above and SessionScreen.
  -->
  {#await adminScreen()}
    <Splash />
  {:then AdminScreen}
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
        {failure.missing ? tr('room.ui.1210') : tr('room.ui.1211')}
      </h1>
      <p class="mt-1.5 text-ui-lg leading-relaxed text-muted">
        {failure.missing
          ? tr('room.ui.1212')
          : tr(failure.message)}
      </p>
      <!--
        "Back to Colloq" — only for those who have somewhere to go there.

        The root is the teacher's panel (below), and on it is the "paste the
        setup token" form. A student who clicked here from a wrong seminar link
        ended up on the staff sign-in screen and lost the last thing they had —
        the room address in the browser bar. The `mightBeStaff` mark permits
        nothing and asks the server nothing: it only says that this browser
        once signed in to the panel — and that is exactly enough to decide
        whether to show the way there.
      -->
      <div class="mt-5 flex items-center justify-center gap-2">
        {#if !failure.missing}
          <button class="btn-primary" onclick={() => (attempt += 1)}>{tr('room.ui.1027')}</button>
        {/if}
        {#if mightBeStaff()}
          <button
            class={failure.missing ? 'btn-outline' : 'btn-ghost'}
            onclick={() => navigate('/')}
          > {tr('room.ui.1213')} </button>
        {/if}
      </div>
    </div>
  </div>
{:else if claiming || handoffKey}
  <!--
    Exchanging the key for an entry. It takes one request, but the entry screen
    has time to flash during it — and a person who has just opened the "your
    console" link would see the "what is your name" form and decide the link
    did not work.
  -->
  <div class="flex h-full items-center justify-center bg-canvas">
    <div class="flex items-center gap-2 text-ui text-muted">
      <Icon name="spinner" size={14} class="animate-spin" /> {tr('room.ui.1214')} </div>
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
    {#await workspace()}
      <Splash />
    {:then Workspace}
      <Workspace
        session={room}
        identity={me}
        {mode}
        {councilCell}
        onnavigate={(next) => navigate(next)}
        onexpired={() => {
          identity = null
          notice = EXPIRED_NOTICE
        }}
      />
    {/await}
  {/key}
{:else if session}
  <JoinScreen
    {session}
    {notice}
    onjoining={() => { void workspace().catch(() => {}) }}
    onjoined={(next) => (identity = next)}
  />
{/if}
