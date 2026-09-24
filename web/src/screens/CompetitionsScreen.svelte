<script lang="ts">
  /**
   * The competition pages under `/k` — list, competition, submissions,
   * leaderboard.
   *
   * One screen for all four addresses on purpose: the tabs of one competition
   * are one page, and moving between them must not reload the task, drop the
   * timer or break the live stream. The address is parsed by `lib/routes.ts`,
   * data goes through `lib/entrantApi.ts`, words and numbers come from
   * `lib/competition-words.ts`; what stays here is only what cannot be
   * computed in advance: what is on screen now, what has already arrived and
   * what broke.
   *
   * LIVE UPDATES — `EventSource`, the same way as the environment build log
   * and the teacher's competition screen. The room socket does not fit here at
   * all: these pages have no room, no document, no presence, and they need
   * exactly one direction — the server saying that a submission moved on. The
   * stream is open only while the person has something RUNNING, and closes as
   * soon as everything has been scored: thirty open leaderboard tabs, each
   * with its own connection, are thirty connections for a page where nothing
   * changes.
   */
  import { tr } from '@shared/i18n'
  import { isTerminal, placeShift } from '@shared/competitions'
  import type {
    EntrantCompetitionList,
    EntrantCompetitionView,
    EntrantLeaderboard,
    EntrantMe,
    EntrantSubmissions,
  } from '@shared/competitions-entrant'
  import Splash from '@/components/ui/Splash.svelte'
  import DependenciesView from '@/components/competitions/DependenciesView.svelte'
  import BoardView from '@/components/competitions/BoardView.svelte'
  import CompetitionsList from '@/components/competitions/CompetitionsList.svelte'
  import KeyPanel from '@/components/competitions/KeyPanel.svelte'
  import PageHeader from '@/components/competitions/PageHeader.svelte'
  import SubmissionsView from '@/components/competitions/SubmissionsView.svelte'
  import TaskView from '@/components/competitions/TaskView.svelte'
  import TopBar from '@/components/competitions/TopBar.svelte'
  import { firstScreenReady } from '@/lib/boot'
  import { entrantApi, EntrantApiError } from '@/lib/entrantApi'
  import { COMPETITIONS_LANDING, type CompetitionRoute, type CompetitionView } from '@/lib/routes'

  interface Props {
    route: CompetitionRoute
    onnavigate: (path: string) => void
  }

  const { route, onnavigate }: Props = $props()

  /* -------------------------------------------------------------- width */

  /*
   * A phone is not "the same thing, only narrower": it has its own layout of
   * the submission row, its own labels and no stage strip (P4). So the width
   * is read here, not only through classes: the difference is structural, and
   * drawing both trees at once means shipping the extra to everyone.
   */
  const PHONE = '(max-width: 700px)'
  let phone = $state(typeof window === 'undefined' ? false : window.matchMedia(PHONE).matches)
  $effect(() => {
    const media = window.matchMedia(PHONE)
    const sync = (): void => {
      phone = media.matches
    }
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  })

  /* ------------------------------------------------------------- state */

  let now = $state(Date.now())
  let me = $state<EntrantMe | null>(null)
  let list = $state<EntrantCompetitionList | null>(null)
  let page = $state<EntrantCompetitionView | null>(null)
  let mine = $state<EntrantSubmissions | null>(null)
  let board = $state<EntrantLeaderboard | null>(null)
  let failure = $state<string | null>(null)
  let ready = $state(false)

  let joining = $state<string | null>(null)
  let joinBusy = $state(false)
  let joinRefusal = $state<string | null>(null)
  let signInBusy = $state(false)
  let signInRefusal = $state<string | null>(null)
  let sending = $state(false)
  let sendRefusal = $state<string | null>(null)
  let busy = $state(false)
  let streamLost = $state(false)
  let final = $state(false)

  const name = $derived(me?.entrant?.name ?? null)
  const tab: CompetitionView = $derived(route.view === 'list' ? 'task' : route.view)

  // Each completion belongs to the route and identity that started it.
  // The generation also protects alpha → list → alpha transitions.
  let generation = 0
  let identityRequest = 0
  function requestContext() {
    return { generation, slug: route.slug, identity: me?.entrant?.id ?? null }
  }
  function currentContext(context: ReturnType<typeof requestContext>): boolean {
    return context.generation === generation && context.slug === route.slug
      && context.identity === (me?.entrant?.id ?? null)
  }
  function actionSlug(): string | null {
    const slug = page?.competition.slug
    return slug && slug === route.slug && carried === `${slug}:${me?.entrant?.id ?? ''}` ? slug : null
  }

  /* ------------------------------------------------------------ clock */

  /*
   * ONE boolean, not a read of the whole `mine`, and this is not about style.
   *
   * A live frame arrives once a second and replaces `mine` wholesale. An
   * effect that reads `mine` right in its body re-runs on every frame — that
   * is, every second it recreates the timer (which never gets to tick) and
   * CLOSES-AND-REOPENS the stream. The latter was measured on the test bench:
   * the proxy between the browser and the server ran out of local ports
   * (EADDRNOTAVAIL) after half a minute of this. A `$derived` from a boolean
   * recomputes quietly, and only its CHANGE wakes the effect.
   */
  const running = $derived((mine?.submissions ?? []).some((it) => !isTerminal(it.state)))

  $effect(() => {
    // A second while something is running (the run timer shows seconds in its
    // label), and half a minute otherwise: the countdown to the deadline
    // changes once a minute.
    const step = running ? 1000 : 30_000
    const timer = setInterval(() => (now = Date.now()), step)
    return () => clearInterval(timer)
  })

  /* --------------------------------------------------- key from the link */

  /**
   * The key from the link goes into a cookie, and straight out of the address
   * bar.
   *
   * The address outlives both the tab and the screenshot a student sends a
   * classmate along with their place; a key in it puts the student's
   * submissions in someone else's hands. The same rule for the same reason as
   * the console link (App.svelte · claiming).
   */
  let claiming = $state(false)
  let claimed: string | null = null
  $effect(() => {
    const key = route.signInKey
    if (!key || claimed === key) return
    claimed = key
    claiming = true
    const request = ++identityRequest
    generation += 1
    void entrantApi
      .signIn(key)
      .then((answer) => {
        if (request !== identityRequest) return
        me = answer
      })
      .catch((error: unknown) => {
        if (request !== identityRequest) return
        if (error instanceof EntrantApiError) signInRefusal = error.message
      })
      .finally(() => {
        if (request !== identityRequest || route.signInKey !== key) return
        claiming = false
        history.replaceState({}, '', COMPETITIONS_LANDING)
        onnavigate(COMPETITIONS_LANDING)
      })
  })

  /* ---------------------------------------------------------- loading */

  function say(error: unknown): string {
    return error instanceof EntrantApiError ? error.message : tr('common.networkError')
  }

  async function loadMe(): Promise<void> {
    const request = ++identityRequest
    try {
      const answer = await entrantApi.me()
      if (request === identityRequest) me = answer
    } catch {
      if (request === identityRequest) me = { entrant: null, key: null, link: null }
    }
  }

  async function loadList(): Promise<void> {
    const context = requestContext()
    try {
      const fresh = await entrantApi.list()
      if (!currentContext(context)) return
      list = fresh
      failure = null
    } catch (error: unknown) {
      if (currentContext(context)) failure = say(error)
    } finally {
      if (currentContext(context)) ready = true
    }
  }

  async function loadPage(slug: string): Promise<void> {
    const context = requestContext()
    try {
      const fresh = await entrantApi.competition(slug)
      if (!currentContext(context)) return
      page = fresh
      failure = null
    } catch (error: unknown) {
      if (!currentContext(context)) return
      failure = say(error)
      page = null
    } finally {
      if (currentContext(context)) ready = true
    }
  }

  async function loadBoard(slug: string): Promise<void> {
    const context = requestContext()
    try {
      const fresh = await entrantApi.leaderboard(slug)
      if (currentContext(context)) board = fresh
    } catch (error: unknown) {
      if (currentContext(context)) failure = say(error)
    }
  }

  async function loadMine(slug: string): Promise<void> {
    const context = requestContext()
    try {
      const fresh = await entrantApi.submissions(slug)
      if (currentContext(context)) mine = fresh
    } catch (error: unknown) {
      if (!currentContext(context)) return
      if (error instanceof EntrantApiError && error.status === 401) mine = null
      else failure = say(error)
    }
  }

  let carried: string | null = null
  $effect(() => {
    const slug = route.slug
    const view = route.view
    const person = me?.entrant?.id ?? null
    const key = `${slug ?? ''}:${person ?? ''}`
    if (carried !== key) {
      generation += 1
      carried = key
      page = null
      mine = null
      board = null
      list = null
      final = false
      ready = false
      failure = null
      sendRefusal = null
      busy = false
      sending = false
      streamLost = false
    }
    if (claiming || route.signInKey) return
    if (me === null) {
      void loadMe()
      return
    }
    if (slug === null) {
      void loadList()
      return
    }
    void loadPage(slug)
    /*
     * The leaderboard loads on ANY tab, including "Task": the "YOUR PLACE" in
     * the header is computed from it — the place among people, without the
     * baseline. Without it the header takes the place the server computed over
     * the whole table, and says "4 of 3" in a competition where the baseline
     * comes first.
     */
    void loadBoard(slug)
    if (view === 'submissions' && person !== null) void loadMine(slug)
  })

  /*
   * The final table selects itself once it has been opened: a person who
   * comes to the leaderboard after the deadline came for the result, not for
   * the public part.
   */
  let switched: string | null = null
  $effect(() => {
    if (!board?.privateOpen || board.private === null) return
    if (switched === route.slug) return
    switched = route.slug
    final = true
  })

  /* ------------------------------------------------------- live stream */

  $effect(() => {
    const slug = route.slug
    if (!slug || route.view !== 'submissions' || !running) return
    const context = requestContext()
    const stream = new EventSource(entrantApi.streamUrl(slug))
    stream.addEventListener('state', (event) => {
      if (!currentContext(context)) return
      streamLost = false
      try {
        const fresh = JSON.parse((event as MessageEvent<string>).data) as EntrantSubmissions
        /*
         * A submission FINISHED scoring — which means everything else nearby
         * is stale: the place in the header, the mini leaderboard, the "best
         * result" under the file name. The stream does not know about them
         * (it is about my submissions), so the end of a run is the only moment
         * the page asks the neighboring doors again.
         */
        const was = new Map((mine?.submissions ?? []).map((it) => [it.id, it.state]))
        const landed = fresh.submissions.some(
          (it) => isTerminal(it.state) && was.has(it.id) && was.get(it.id) !== it.state,
        )
        mine = fresh
        if (landed) {
          void loadBoard(slug)
          void loadPage(slug)
        }
      } catch {
        /* the frame did not parse — the next one arrives in a second */
      }
    })
    /*
     * The stream broke — and that has to be said: a server restart, a proxy, a
     * laptop gone to sleep. The timer and the bar simply freeze, and without a
     * word the page looks alive while being dead. The poll below will catch
     * up with the numbers.
     */
    stream.addEventListener('error', () => {
      if (!currentContext(context)) return
      streamLost = true
    })
    return () => stream.close()
  })

  /*
   * A fallback poll — for when the stream never got through at all (a
   * buffering proxy, a corporate network, EventSource turned off). Five
   * seconds, not one: this is the fallback path, and there is no reason to
   * pay as much for it as for the live one.
   */
  $effect(() => {
    const slug = route.slug
    if (!slug || !streamLost || route.view !== 'submissions') return
    const timer = setInterval(() => void loadMine(slug), 5000)
    return () => clearInterval(timer)
  })

  /*
   * The shell from index.html is removed on the first screen, not on mount
   * (lib/boot.ts). Exchanging the key under the splash is more honest than a
   * blank page flashing under it, so the report waits for the exchange to
   * finish.
   */
  $effect(() => {
    if (!claiming && (ready || failure)) firstScreenReady()
  })

  /* ---------------------------------------------------------- actions */

  async function join(slug: string, wanted: string): Promise<void> {
    if (joinBusy) return
    const request = ++identityRequest
    generation += 1
    joinBusy = true
    joinRefusal = null
    try {
      const answer = await entrantApi.join(slug, wanted)
      if (request !== identityRequest) return
      me = answer
      joining = null
    } catch (error: unknown) {
      if (request === identityRequest) joinRefusal = say(error)
    } finally {
      if (request === identityRequest) joinBusy = false
    }
  }

  async function signIn(key: string): Promise<void> {
    if (signInBusy) return
    const request = ++identityRequest
    generation += 1
    signInBusy = true
    signInRefusal = null
    try {
      const answer = await entrantApi.signIn(key)
      if (request === identityRequest) me = answer
    } catch (error: unknown) {
      if (request === identityRequest) signInRefusal = say(error)
    } finally {
      if (request === identityRequest) signInBusy = false
    }
  }

  async function signOut(): Promise<void> {
    const request = ++identityRequest
    generation += 1
    await entrantApi.signOut().catch(() => undefined)
    if (request !== identityRequest) return
    me = { entrant: null, key: null, link: null }
    mine = null
  }

  async function send(file: File, bundleId?: string | null): Promise<boolean> {
    const slug = actionSlug()
    if (!slug || sending) return false
    const context = requestContext()
    sending = true
    sendRefusal = null
    try {
      await entrantApi.send(slug, file, bundleId)
      if (!currentContext(context)) return false
      await loadMine(slug)
      return true
    } catch (error: unknown) {
      if (currentContext(context)) sendRefusal = say(error)
      return false
    } finally {
      if (currentContext(context)) sending = false
    }
  }

  async function choose(id: string): Promise<void> {
    const slug = actionSlug()
    if (!slug || busy || page?.competition.scoring !== 'chosen') return
    const context = requestContext()
    busy = true
    try {
      const fresh = await entrantApi.choose(slug, id)
      if (!currentContext(context)) return
      mine = fresh
      await loadBoard(slug)
    } catch (error: unknown) {
      if (currentContext(context)) sendRefusal = say(error)
    } finally {
      if (currentContext(context)) busy = false
    }
  }

  async function cancel(id: string): Promise<void> {
    const slug = actionSlug()
    if (!slug || busy) return
    const context = requestContext()
    busy = true
    try {
      const fresh = await entrantApi.cancel(slug, id)
      if (currentContext(context)) mine = fresh
    } catch (error: unknown) {
      if (!currentContext(context)) return
      sendRefusal = say(error)
      await loadMine(slug)
    } finally {
      if (currentContext(context)) busy = false
    }
  }

  function goTab(next: CompetitionView): void {
    const slug = route.slug
    if (!slug) return
    onnavigate(
      next === 'task'
        ? `/k/${slug}`
        : next === 'submissions'
          ? `/k/${slug}/submissions`
          : next === 'dependencies' ? `/k/${slug}/dependencies` : `/k/${slug}/leaderboard`,
    )
  }

  function showKey(): void {
    if (route.slug !== null) {
      onnavigate(COMPETITIONS_LANDING)
      return
    }
    document.querySelector('[data-key-card]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  /* --------------------------------------------------- header numbers */

  const myPublic = $derived(board?.public.find((line) => line.you) ?? null)

  /**
   * "YOUR PLACE 7 of 28" — the place AMONG PEOPLE.
   *
   * In the table the baseline stands as an ordinary row with its own place
   * (as in mockup P3), but the header's denominator is the participants, and
   * taking the numerator from the same table means one day showing "2 of 1":
   * in a competition where nobody has yet sent a solution better than the
   * baseline, it comes first.
   */
  function placeAmongPeople(lines: readonly { you: boolean; baseline: boolean }[]): number | null {
    const at = lines.filter((line) => !line.baseline).findIndex((line) => line.you)
    return at < 0 ? null : at + 1
  }

  const myPlace = $derived(placeAmongPeople(board?.public ?? []))
  const myFinalPlace = $derived(board?.private ? placeAmongPeople(board.private) : null)
  const shift = $derived(myFinalPlace === null ? null : placeShift(myPlace, myFinalPlace))
</script>

{#if route.view === 'screen' && page && board}
  <!-- The projector: the same leaderboard without the header and tabs. It is
       shown to the class and read from the back row, so everything that is
       not a table row is removed from here. -->
  <main class="competition-ui flex h-full flex-col gap-6 overflow-auto bg-canvas p-10">
    <h1 class="text-gauge-lg font-black text-ink">{page.competition.title}</h1>
    <BoardView
      competition={page.competition}
      {board}
      phone={false}
      final={final && board.privateOpen}
      onfinal={(value) => (final = value)}
    />
  </main>
{:else}
  <div class="competition-ui flex h-full flex-col overflow-auto bg-canvas">
    <!--
      On a phone there is no bar inside a competition: its place is taken by
      the page header, which already has both "‹ Competitions" and the name
      (P4). Two bars in a row at 390 px are 110 px of furniture above the task
      title.
    -->
    {#if !phone || route.slug === null}
      <TopBar {name} {onnavigate} onkey={showKey} />
    {/if}

    {#if claiming || (!ready && !failure)}
      <Splash size="screen" />
    {:else if route.slug === null}
      <main class="mx-auto flex w-full max-w-[1600px] flex-col gap-8 px-4 py-8 sm:px-10 sm:py-10 xl:flex-row xl:gap-10">
        <div class="min-w-0 grow">
          {#if failure}
            <p class="mb-6 text-ui text-danger">{failure}</p>
          {/if}
          <CompetitionsList
            rows={list?.competitions ?? []}
            {now}
            {joining}
            {joinBusy}
            {joinRefusal}
            defaultName={name ?? ''}
            onopen={(slug) => onnavigate(`/k/${slug}/submissions`)}
            onjoin={join}
            onjoinstart={(slug) => {
              joining = slug
              joinRefusal = null
            }}
          />
        </div>
        <aside class="w-full shrink-0 self-start border border-line bg-surface p-5 xl:w-[360px]">
          <KeyPanel {me} busy={signInBusy} refusal={signInRefusal} onsignin={signIn} onsignout={signOut} />
        </aside>
      </main>
    {:else if page}
      <PageHeader
        view={page}
        {tab}
        {now}
        {phone}
        {name}
        submissions={mine?.submissions.length ?? null}
        place={myPlace ?? page.mine?.place ?? null}
        total={page.entrants}
        finalPlace={myFinalPlace}
        {shift}
        score={myPublic?.score ?? page.mine?.score ?? null}
        ontab={goTab}
        {onnavigate}
      />
      <main class="flex flex-col gap-4 px-4 py-4 sm:px-10 sm:py-7">
        {#if streamLost}
          <p class="text-micro text-warning">{tr('competitions.p.streamLost')}</p>
        {/if}
        {#if tab === 'task'}
          <TaskView
            view={page}
            {phone}
            fileUrl={(file) => entrantApi.fileUrl(page!.competition.slug, file)}
          />
        {:else if tab === 'dependencies'}
          {#key `${page.competition.slug}:${me?.entrant?.id ?? ''}`}
            <DependenciesView slug={page.competition.slug} signedIn={!!me?.entrant} onjoin={() => {
              onnavigate(COMPETITIONS_LANDING)
              joining = page!.competition.slug
            }} />
          {/key}
        {:else if tab === 'submissions'}
          {#if mine}
            {#key `${page.competition.slug}:${me?.entrant?.id ?? ''}`}
            <SubmissionsView
              view={page}
              {mine}
              board={board?.public ?? []}
              {phone}
              {now}
              {sending}
              {busy}
              refusal={sendRefusal}
              notebookUrl={(id) => entrantApi.notebookUrl(page!.competition.slug, id)}
              onsend={send}
              onrefuse={(message) => (sendRefusal = message)}
              oncancel={cancel}
              onchoose={choose}
              onboard={() => goTab('leaderboard')}
              onjoin={() => {
                onnavigate(COMPETITIONS_LANDING)
                joining = page!.competition.slug
              }}
            />
            {/key}
          {:else}
            <div class="flex flex-col items-start gap-3">
              <p class="text-ui text-muted">{tr('competitions.refusal.signIn')}</p>
              <button
                class="h-[38px] bg-brand px-4 text-micro font-black uppercase tracking-label text-white"
                type="button"
                onclick={() => {
                  onnavigate(COMPETITIONS_LANDING)
                  joining = page!.competition.slug
                }}
              >
                {tr('competitions.p.join')}
              </button>
            </div>
          {/if}
        {:else if board}
          <BoardView
            competition={page.competition}
            {board}
            {phone}
            final={final && board.privateOpen}
            onfinal={(value) => (final = value)}
          />
        {/if}
      </main>
    {:else}
      <main class="flex grow flex-col items-start gap-4 px-4 py-10 sm:px-10">
        <p class="text-ui text-danger">{failure ?? tr('competitions.refusal.notFound')}</p>
        <button
          class="border border-line px-4 py-2 text-2xs text-ink hover:bg-surface"
          type="button"
          onclick={() => onnavigate(COMPETITIONS_LANDING)}
        >
          {tr('competitions.title')}
        </button>
      </main>
    {/if}
  </div>
{/if}
