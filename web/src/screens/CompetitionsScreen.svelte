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
  import { untrack } from 'svelte'
  import { tr } from '@shared/i18n'
  import { isTerminal, placeShift } from '@shared/competitions'
  import type {
    EntrantBoardLine,
    EntrantCompetitionList,
    EntrantCompetitionView,
    EntrantLeaderboard,
    EntrantMe,
    EntrantSubmissions,
    SubmissionAccepted,
  } from '@shared/competitions-entrant'
  import Splash from '@/components/ui/Splash.svelte'
  import DependenciesView from '@/components/competitions/DependenciesView.svelte'
  import BoardView from '@/components/competitions/BoardView.svelte'
  import CompetitionsList from '@/components/competitions/CompetitionsList.svelte'
  import Conditions from '@/components/competitions/Conditions.svelte'
  import JoinStep from '@/components/competitions/JoinStep.svelte'
  import KeyPanel from '@/components/competitions/KeyPanel.svelte'
  import PageHeader from '@/components/competitions/PageHeader.svelte'
  import SubmissionsView from '@/components/competitions/SubmissionsView.svelte'
  import TaskView from '@/components/competitions/TaskView.svelte'
  import TopBar from '@/components/competitions/TopBar.svelte'
  import { joinedMe, joinStepPath, markJoined, takesPartHere, visitKey } from '@/components/competitions/join-step'
  import { firstScreenReady } from '@/lib/boot'
  import { acceptsUploads, boardPlaces, clockStep, gpuCondition, standingsClosed } from '@/lib/competition-words'
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
  /**
   * The board is open to this competition's entrants only, and the server
   * said this visitor is not one (`board_closed`): the page says why and how
   * to get in, instead of an empty table or an error.
   */
  let boardClosed = $state(false)
  let failure = $state<string | null>(null)
  let ready = $state(false)

  /**
   * «Участвовать» was pressed for this competition (its slug): its join step
   * takes the focus once it is on screen, and says so (JoinStep · onfocused).
   */
  let joinAsk = $state<string | null>(null)
  /**
   * The visit that has just joined — the competition and the person
   * (join-step.ts · visitKey): its «Посылки» tab shows the key above the send
   * box, where the person lands right after joining. It goes with the visit:
   * another page outside this competition, another person signing in, a
   * sign-out. Only the key card reads it; whether the send box stands there
   * at all is the server's word (takesPartHere).
   */
  let joinedHere = $state<string | null>(null)
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
  /*
   * The deadline the header counts down to — the same condition PageHeader
   * draws the countdown by: a deadline, and intake for the standings not over
   * yet. Late intake (`late`) is past it: the header names the passed
   * deadline instead, and nothing ticks by the second for it.
   */
  const countdownTo = $derived(
    route.slug !== null && page !== null && !standingsClosed(page.accepting) ? page.competition.deadlineAt : null,
  )
  /*
   * Whether a signed-in visitor may still join: the join door takes people
   * while it takes notebooks, late ones included.
   */
  const joinable = $derived(page !== null && acceptsUploads(page.accepting))
  /*
   * The step is a number derived from `now`, and the effect below reads only
   * it: a `$derived` wakes its readers only when its value CHANGES, so the
   * timer is recreated when the step flips, not on every tick.
   */
  const step = $derived(clockStep(running, countdownTo, now))

  $effect(() => {
    // A second while the header counts down (the countdown shows seconds) or a
    // run's stopwatch is on screen, half a minute otherwise (lib ·
    // competition-words · clockStep).
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
      // The projector is shown to the whole room: it asks for the class's
      // view even from the teacher's own signed-in browser.
      const fresh = await entrantApi.leaderboard(slug, route.view === 'screen' ? 'class' : 'me')
      if (!currentContext(context)) return
      board = fresh
      boardClosed = false
    } catch (error: unknown) {
      if (!currentContext(context)) return
      if (error instanceof EntrantApiError && error.reason === 'board_closed') {
        board = null
        boardClosed = true
      } else failure = say(error)
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
    const key = visitKey(slug, person)
    if (carried !== key) {
      generation += 1
      carried = key
      page = null
      mine = null
      board = null
      boardClosed = false
      list = null
      final = false
      ready = false
      failure = null
      sendRefusal = null
      busy = false
      sending = false
      streamLost = false
      joinRefusal = null
      // A focus request belongs to the competition it was made for, and the
      // join's mark to the visit that made it. Untracked: either coming and
      // going must not load the page again.
      if (untrack(() => joinAsk) !== slug) joinAsk = null
      if (untrack(() => joinedHere) !== key) joinedHere = null
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

  /*
   * A refusal answers the form it was typed into. On another page or tab the
   * form is a new one with an empty field, and the old red line under it
   * answered a question nobody had asked there: a key refused on the list
   * stood under the join step of a competition where nothing was typed. The
   * key link's own refusal stays, and not by luck: `/k/t/…` is the list too,
   * the same place the link drops the person on.
   */
  let formsAt: string | null = null
  function forgetRefusals(at: string): void {
    if (formsAt === at) return
    formsAt = at
    joinRefusal = null
    signInRefusal = null
  }
  $effect(() => forgetRefusals(`${route.slug ?? ''}/${route.view}`))

  async function join(slug: string, wanted: string): Promise<void> {
    if (joinBusy) return
    const request = ++identityRequest
    generation += 1
    joinBusy = true
    joinRefusal = null
    try {
      const answer = await entrantApi.join(slug, wanted)
      if (request !== identityRequest) return
      me = joinedMe(me, answer)
      joinedHere = visitKey(slug, answer.entrant?.id)
      joinAsk = null
      // The door said yes: the page's copies of this competition learn it now,
      // not a round trip later (join-step.ts · markJoined). Only while it is
      // still this competition on screen: an answer that comes back after the
      // person has moved on must not mark another one joined.
      if (route.slug === slug) {
        mine = markJoined(mine)
        if (page?.mine) page = { ...page, mine: markJoined(page.mine) }
      }
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
    joinedHere = null
  }

  /**
   * «Участвовать» — on a competition's tab or on its card in the list: to the
   * competition's join step, the first step of its «Посылки» tab, which takes
   * the focus once it is on screen. Not to the list any more, where the name
   * was asked for under the card, below the fold (join-step.ts).
   */
  function startJoin(slug: string): void {
    joinRefusal = null
    signInRefusal = null
    joinAsk = slug
    if (route.slug !== slug || route.view !== 'submissions') onnavigate(joinStepPath(slug))
  }

  /** The server's answer once the notebook is in, and only after "My submissions" has caught up with it. */
  async function send(file: File, bundleId?: string | null): Promise<SubmissionAccepted | null> {
    const slug = actionSlug()
    if (!slug || sending) return null
    const context = requestContext()
    sending = true
    sendRefusal = null
    try {
      const answer = await entrantApi.send(slug, file, bundleId)
      if (!currentContext(context)) return null
      await loadMine(slug)
      return answer
    } catch (error: unknown) {
      if (!currentContext(context)) return null
      sendRefusal = say(error)
      /*
       * Refused by the day's numbers — the limit, or the ceiling on failed
       * submissions — means the box's own numbers were stale: a run ended
       * since the last frame. Fresh numbers make the box say it in its strip,
       * with the reset time, and the same words twice are once too many.
       */
      if (error instanceof EntrantApiError && (error.reason === 'attempts' || error.reason === 'quota')) {
        await loadMine(slug)
        if (currentContext(context)) sendRefusal = null
      }
      return null
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
    // Right after joining, the key stands on the competition's own page.
    const card = document.querySelector('[data-key-card]')
    if (route.slug !== null && !card) {
      onnavigate(COMPETITIONS_LANDING)
      return
    }
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
   *
   * Read off `boardPlaces`, the numbers the table itself prints, rather than
   * counted here a second time: the header and the row beside the name must
   * not disagree, whatever rule numbers the table.
   */
  function placeAmongPeople(lines: readonly EntrantBoardLine[]): number | null {
    return boardPlaces(lines).find((line) => line.you && !line.baseline)?.place ?? null
  }

  const myPlace = $derived(placeAmongPeople(board?.public ?? []))
  const myFinalPlace = $derived(board?.private ? placeAmongPeople(board.private) : null)
  const shift = $derived(myFinalPlace === null ? null : placeShift(myPlace, myFinalPlace))
</script>

{#snippet closedBoard()}
  <!-- A board open to entrants only, seen by someone who is not one: why, and
       the way in — the key for a stranger, JOIN for a signed-in person while
       the competition still takes people. Both lead to the join step, which
       holds the name and the key side by side. -->
  <div class="flex max-w-[640px] flex-col items-start gap-3 border-t-2 border-ink pt-5">
    <p class="text-title font-bold leading-6 text-ink">{tr('competitions.p.boardClosedTitle')}</p>
    <p class="text-ui leading-5 text-muted">
      {tr('competitions.refusal.boardEntrantsOnly')}
      {#if !me?.entrant}
        {tr('competitions.refusal.signIn')}
      {:else if joinable}
        {tr('competitions.p.boardClosedJoin')}
      {/if}
    </p>
    {#if route.view !== 'screen' && (!me?.entrant || joinable)}
      <button
        class="h-[38px] bg-brand px-4 text-micro font-black uppercase tracking-label text-white"
        type="button"
        onclick={() => page && startJoin(page.competition.slug)}
      >
        {joinable ? tr('competitions.p.join') : tr('competitions.p.signIn')}
      </button>
    {/if}
  </div>
{/snippet}

{#if route.view === 'screen' && page && (board || boardClosed)}
  <!-- The projector: the same leaderboard without the header and tabs. It is
       shown to the class and read from the back row, so everything that is
       not a table row is removed from here. -->
  <main class="competition-ui flex h-full flex-col gap-6 overflow-auto bg-canvas p-10">
    <h1 class="text-gauge-lg font-black text-ink">{page.competition.title}</h1>
    {#if board}
      <BoardView
        competition={page.competition}
        {board}
        phone={false}
        final={final && board.privateOpen}
        onfinal={(value) => (final = value)}
      />
    {:else}
      {@render closedBoard()}
    {/if}
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
            onopen={(slug) => onnavigate(`/k/${slug}/submissions`)}
            onjoin={startJoin}
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
            zipUrl={entrantApi.zipUrl(page.competition.slug)}
          />
        {:else if tab === 'dependencies'}
          {#key `${page.competition.slug}:${me?.entrant?.id ?? ''}`}
            <DependenciesView slug={page.competition.slug} signedIn={!!me?.entrant} onjoin={() => startJoin(page!.competition.slug)} />
          {/key}
        {:else if tab === 'submissions'}
          {#if !takesPartHere(page, mine)}
            <!-- Not in this competition (yet), by the server's word: the join
                 step stands where the send box stands for those who are, with
                 the conditions of the check beside it, as on the tab the
                 person is about to use. -->
            <div class="flex flex-col gap-6 xl:flex-row xl:gap-12">
              <div class="flex min-w-0 grow flex-col">
                <JoinStep
                  accepting={page.accepting}
                  defaultName={name ?? ''}
                  signedIn={!!me?.entrant}
                  busy={joinBusy}
                  refusal={joinRefusal}
                  {signInBusy}
                  {signInRefusal}
                  focus={joinAsk === page.competition.slug}
                  onfocused={() => (joinAsk = null)}
                  onjoin={(wanted) => void join(page!.competition.slug, wanted)}
                  onsignin={signIn}
                />
              </div>
              <aside class="flex w-full shrink-0 flex-col gap-6 xl:w-[300px]">
                <Conditions competition={page.competition} sealedFiles={page.sealedFiles ?? []} gpu={gpuCondition(page)} />
              </aside>
            </div>
          {:else if mine}
            {#key `${page.competition.slug}:${me?.entrant?.id ?? ''}`}
            <SubmissionsView
              view={page}
              {mine}
              board={board?.public ?? []}
              {boardClosed}
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
            >
              {#snippet lead()}
                <!-- Where the person lands right after joining: the key they
                     will need on another device, above the box they send with. -->
                {#if joinedHere === visitKey(page!.competition.slug, me?.entrant?.id)}
                  <KeyPanel {me} keyOnly />
                {/if}
              {/snippet}
            </SubmissionsView>
            {/key}
          {/if}
        {:else if board}
          <BoardView
            competition={page.competition}
            {board}
            {phone}
            final={final && board.privateOpen}
            onfinal={(value) => (final = value)}
          />
        {:else if boardClosed}
          {@render closedBoard()}
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
