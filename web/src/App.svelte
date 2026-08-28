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
  const SESSION_PATH = /^\/s\/([A-Za-z0-9_-]{1,64})\/?$/

  let path = $state(location.pathname)
  const sessionId = $derived(SESSION_PATH.exec(path)?.[1] ?? null)
  // The teaching side. It routes its own sub-paths; this only has to get out of
  // the way, and to do so before the seminar route touches localStorage.
  const isAdmin = $derived(path === '/admin' || path.startsWith('/admin/'))

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

  let session = $state<SessionInfo | null>(null)
  let identity = $state<StoredIdentity | null>(null)
  let failure = $state<{ missing: boolean; message: string } | null>(null)
  let attempt = $state(0)

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
        published: null,
        course: null,
      }
    )
  }

  function enter(id: string | null): void {
    failure = null
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

  // The join screen's poster half does not depend on the seminar name, so it
  // paints immediately; a non-breaking space holds the line the name lands on so
  // its arrival never pushes the form down.
  const poster = $derived(session ? { ...session, name: session.name || '\u00a0' } : null)
</script>

{#if isAdmin}
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
      <Workspace session={room} identity={me} />
    {/await}
  {/key}
{:else if poster}
  <JoinScreen session={poster} onjoined={(next) => (identity = next)} />
{/if}
