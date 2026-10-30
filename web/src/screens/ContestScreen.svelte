<script lang="ts">
  /**
   * A contest's pages under `/a/<slug>` — the problems (one at a time, the
   * rail of letters beside), the person's submissions, the leaderboard (and
   * its projector screen), the questions.
   *
   * One screen for all of them, as on `/k`: the tabs and the letters are one
   * page with one person, and moving between them must not reload the
   * statement, drop the draft in the editor, restart the countdown or reopen
   * the live stream. The address is read by lib/routes.ts, data goes through
   * lib/contestApi.ts (the person through lib/entrantApi.ts — one identity for
   * competitions and contests), words and numbers are lib/contest-words.ts;
   * what stays here is what cannot be computed in advance: what is on screen,
   * what has arrived, and what broke.
   *
   * THE CLOCK IS THE SERVER'S. Every page answer carries the server's `now`,
   * and the page keeps the difference (`offset`): the phase, «приём открыт»
   * and the countdown are worked out by the shared rules (contestPhase,
   * submissionsOpenFor) against the server's time, so a laptop five minutes
   * fast neither shows a start that has not come nor counts to a zero at which
   * the door still refuses. When the phase moves by the clock — the start, the
   * end — the page asks the door again: the problems appear at the start
   * because the door sends them then, not because the page decided so.
   *
   * LIVE UPDATES — one EventSource per open contest (`…/stream`), which says
   * only WHAT changed (the contest's revision, the person's submissions, the
   * board, the questions); the page fetches just that. A broken stream is said
   * quietly and replaced by a poll every five seconds until it comes back.
   *
   * Every answer belongs to the visit that asked for it — this contest and
   * this person (requestContext): an answer that comes back after a sign-in
   * with another key, or after the address moved to another contest, is
   * dropped instead of painting someone else's numbers here.
   */
  import { untrack } from 'svelte'
  import { tr } from '@shared/i18n'
  import { contestPhase, judged, submissionsOpenFor, type ContestLanguage } from '@shared/contests'
  import type { EntrantMe } from '@shared/competitions-entrant'
  import type {
    ContestQuestion,
    ContestStreamState,
    EntrantContestSubmissions,
    EntrantContestView,
    EntrantProblem,
    EntrantStandings,
  } from '@shared/contests-entrant'
  import Splash from '@/components/ui/Splash.svelte'
  import JoinStep from '@/components/competitions/JoinStep.svelte'
  import KeyPanel from '@/components/competitions/KeyPanel.svelte'
  import TopBar from '@/components/competitions/TopBar.svelte'
  import { joinedMe, visitKey } from '@/components/competitions/join-step'
  import ContestHeader from '@/components/contests/ContestHeader.svelte'
  import ContestIntro from '@/components/contests/ContestIntro.svelte'
  import LeaderboardView from '@/components/contests/LeaderboardView.svelte'
  import ProblemRail from '@/components/contests/ProblemRail.svelte'
  import ProblemStatement from '@/components/contests/ProblemStatement.svelte'
  import ProblemSubmissions from '@/components/contests/ProblemSubmissions.svelte'
  import ProjectorView from '@/components/contests/ProjectorView.svelte'
  import QuestionsView from '@/components/contests/QuestionsView.svelte'
  import SolutionPanel from '@/components/contests/SolutionPanel.svelte'
  import SubmissionsTable from '@/components/contests/SubmissionsTable.svelte'
  import { firstScreenReady } from '@/lib/boot'
  import { clockStep } from '@/lib/competition-words'
  import { contestCountdown, currentTest, inFlight } from '@/lib/contest-words'
  import { contestApi, ContestApiError } from '@/lib/contestApi'
  import { entrantApi, EntrantApiError } from '@/lib/entrantApi'
  import { COMPETITIONS_LANDING, contestRoutePath, type ContestRoute } from '@/lib/routes'

  interface Props {
    route: ContestRoute
    onnavigate: (path: string) => void
  }

  const { route, onnavigate }: Props = $props()

  /*
   * The address in parts, each a value of its own. `route` is a new object on
   * every navigation, and an effect that read `route.slug` reran on every
   * letter clicked: the page fetched again, the stream closed and reopened —
   * seven reads of one contest in a minute of moving between problems on the
   * test stand. A derived value wakes its readers only when it changes.
   */
  const routeSlug = $derived(route.slug)
  const routeView = $derived(route.view)
  const routeLetter = $derived(route.letter)

  /* -------------------------------------------------------------- width */

  /*
   * A phone is a different layout, not a narrower one (K5): the letters in a
   * row, one column, the editor folded behind two buttons. Read here, not
   * only through classes, because the trees differ, and drawing both means
   * mounting two editors.
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
  /** The server's clock minus this laptop's, as the last page answer measured it. */
  let offset = $state(0)
  const serverNow = $derived(now + offset)

  let me = $state<EntrantMe | null>(null)
  let page = $state<EntrantContestView | null>(null)
  let mine = $state<EntrantContestSubmissions | null>(null)
  let board = $state<EntrantStandings | null>(null)
  /** The board is for participants only and this visitor is not one: the tab says why instead of an error. */
  let boardClosed = $state(false)
  let questions = $state<ContestQuestion[] | null>(null)
  /** The stream said the questions moved while their tab was closed: the dot lights before the next read. */
  let questionsFresh = $state(false)
  /**
   * The questions tab has been read in this visit. The page's count of unread
   * answers is the server's as of the page's last read, which may have left
   * before the «seen» arrived: without this, a page reloaded a second after
   * the tab was read would light the dot again for what was just read. Anything
   * new after that comes through the stream (questionsFresh).
   */
  let answersRead = $state(false)
  let failure = $state<string | null>(null)
  let ready = $state(false)
  let streamLost = $state(false)

  /** «Вступить» was pressed for this contest (its slug): the join step takes the focus once on screen. */
  let joinAsk = $state<string | null>(null)
  /** The visit that has just joined: its key card stands above the editor, where the person is. */
  let joinedHere = $state<string | null>(null)
  let joinBusy = $state(false)
  let joinRefusal = $state<string | null>(null)
  let signInBusy = $state(false)
  let signInRefusal = $state<string | null>(null)
  let sending = $state(false)
  /** The door's refusal of a send, with the problem it was for: another problem's editor does not show it. */
  let sendRefusal = $state<{ problemId: string; message: string } | null>(null)
  let asking = $state(false)
  let askRefusal = $state<string | null>(null)
  /** «все посылки» under a problem: the submissions tab opens filtered by it. */
  let problemFilter = $state<string | null>(null)
  /** The problem last open: the «Задачи» tab returns to it, not to A. */
  let lastLetter = $state<string | null>(null)

  const person = $derived(me?.entrant?.id ?? null)
  const name = $derived(me?.entrant?.name ?? null)
  /** The person has been asked about at all: until then nothing else is asked. */
  const known = $derived(me !== null)
  const phase = $derived(page ? contestPhase(page.contest, serverNow) : null)
  const accepting = $derived(page ? submissionsOpenFor(page.contest, serverNow) : 'not_open')
  const submissions = $derived(mine?.submissions ?? [])
  /** In the contest: joined by the door's word, or with a submission here (the competitions' rule, takesPartHere). */
  const joined = $derived(page?.mine?.joined === true || submissions.length > 0)
  const running = $derived(submissions.some(inFlight))
  const countdown = $derived(page ? contestCountdown(page.contest, serverNow) : null)
  const unread = $derived(
    routeView !== 'questions' && (questionsFresh || ((page?.mine?.unreadAnswers ?? 0) > 0 && !answersRead)),
  )
  /** The test the person's own runs are on, per problem — their row of the board says «тест 7». */
  const pendingTests = $derived.by(() => {
    const tests: Record<string, number | null> = {}
    for (const submission of [...submissions].reverse()) {
      if (submission.state === 'running') tests[submission.problemId] = currentTest(submission)
    }
    return tests
  })
  /** The place in the header: the board's own number once it is here, the page's until then. */
  const place = $derived.by(() => {
    if (board?.me) {
      const row = board.rows.find((candidate) => candidate.entrantId === board!.me)
      if (row) return row.place
    }
    return page?.mine?.place ?? null
  })

  /* ---------------------------------------------------------- the clock */

  /*
   * A second while the header counts down or something of the person's is
   * being judged; half a minute otherwise. The step is a derived number and
   * the effect reads only it: a new timer when the step flips, not on every
   * tick (the competitions screen learned that one by exhausting a proxy's
   * ports).
   */
  const step = $derived(clockStep(running, countdown?.at ?? null, serverNow))
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), step)
    return () => clearInterval(timer)
  })

  /* ----------------------------------------------------------- loading */

  let generation = 0
  let identityRequest = 0
  function requestContext() {
    return { generation, slug: routeSlug, identity: person }
  }
  function currentContext(context: ReturnType<typeof requestContext>): boolean {
    return context.generation === generation && context.slug === routeSlug && context.identity === person
  }

  function say(error: unknown): string {
    if (error instanceof ContestApiError || error instanceof EntrantApiError) return error.message
    return tr('common.networkError')
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

  async function loadPage(slug: string): Promise<void> {
    const context = requestContext()
    try {
      const fresh = await contestApi.contest(slug)
      if (!currentContext(context)) return
      offset = fresh.now - Date.now()
      page = fresh
      failure = null
    } catch (error: unknown) {
      if (!currentContext(context)) return
      // A page already on screen survives a blink of the network; a missing contest does not.
      if (page === null || (error instanceof ContestApiError && error.reason === 'not_found')) {
        page = null
        failure = say(error)
      }
    } finally {
      if (currentContext(context)) ready = true
    }
  }

  /** A submission was judged since the last read: the rail, the header and the board have moved with it. */
  function landed(before: EntrantContestSubmissions | null, after: EntrantContestSubmissions): boolean {
    if (before === null) return false
    const was = new Map(before.submissions.map((submission) => [submission.id, submission.state]))
    return after.submissions.some((submission) => {
      if (!judged(submission.state)) return false
      const state = was.get(submission.id)
      return state === undefined || !judged(state)
    })
  }

  async function loadMine(slug: string): Promise<void> {
    const context = requestContext()
    try {
      const fresh = await contestApi.submissions(slug)
      if (!currentContext(context)) return
      const before = mine
      mine = fresh
      if (landed(before, fresh)) {
        void loadPage(slug)
        if (routeView === 'leaderboard') void loadBoard(slug)
      }
    } catch (error: unknown) {
      if (!currentContext(context)) return
      // Not in the contest, or not signed in: there is nothing of theirs, which is an answer too.
      if (error instanceof ContestApiError && (error.status === 401 || error.reason === 'not_joined')) {
        mine = { submissions: [], version: '' }
      }
    }
  }

  async function loadBoard(slug: string): Promise<void> {
    const context = requestContext()
    // The projector is shown to the whole room: it asks for the class's view
    // even from the teacher's signed-in browser.
    const audience = routeView === 'screen' ? 'class' : 'me'
    try {
      const fresh = await contestApi.standings(slug, audience)
      if (!currentContext(context) || audience !== (routeView === 'screen' ? 'class' : 'me')) return
      board = fresh
      boardClosed = false
    } catch (error: unknown) {
      if (!currentContext(context)) return
      if (error instanceof ContestApiError && error.reason === 'board_closed') {
        board = null
        boardClosed = true
      }
    }
  }

  async function loadQuestions(slug: string): Promise<void> {
    const context = requestContext()
    try {
      const fresh = await contestApi.questions(slug)
      if (!currentContext(context)) return
      questions = fresh.questions
      if (routeView === 'questions') void markSeen(slug)
    } catch {
      if (currentContext(context) && questions === null) questions = []
    }
  }

  /** The questions tab is open: what it shows is read. The dot goes out at once, the door learns it after. */
  async function markSeen(slug: string): Promise<void> {
    questionsFresh = false
    answersRead = true
    if (page?.mine && page.mine.unreadAnswers > 0) page = { ...page, mine: { ...page.mine, unreadAnswers: 0 } }
    if (person === null) return
    await contestApi.seen(slug).catch(() => undefined)
  }

  async function loadDetail(id: string) {
    const slug = routeSlug
    return contestApi.submission(slug, id)
  }

  /*
   * A visit is this contest seen by this person (join-step.ts · visitKey).
   * Another person on the same contest keeps the contest on screen and reads
   * their own numbers; another contest starts from nothing.
   */
  let carried: string | null = null
  $effect(() => {
    const slug = routeSlug
    const who = person
    const key = visitKey(slug, who)
    if (carried !== key) {
      const sameContest = carried !== null && carried.startsWith(`${slug}:`)
      generation += 1
      carried = key
      mine = null
      board = null
      boardClosed = false
      questions = null
      questionsFresh = false
      answersRead = false
      streamLost = false
      sending = false
      sendRefusal = null
      asking = false
      askRefusal = null
      joinRefusal = null
      if (!sameContest) {
        page = null
        ready = false
        failure = null
        problemFilter = null
        lastLetter = null
      }
      // A focus request belongs to the contest it was made for, the join's
      // mark to the person who made it. Untracked: either coming and going
      // must not load the page again.
      if (untrack(() => joinAsk) !== slug) joinAsk = null
      if (untrack(() => joinedHere) !== key) joinedHere = null
    }
    if (!known) {
      void loadMe()
      return
    }
    void loadPage(slug)
    if (who !== null) void loadMine(slug)
  })

  /* The tab's own data, each time the tab is entered: a board left open an hour ago is an hour old. */
  $effect(() => {
    const slug = routeSlug
    const view = routeView
    void person
    if (!known) return
    untrack(() => {
      if (view === 'leaderboard' || view === 'screen') void loadBoard(slug)
      if (view === 'questions') void loadQuestions(slug)
    })
  })

  /* The problem last opened, for the «Задачи» tab's link. */
  $effect(() => {
    if (routeView === 'problems' && routeLetter !== null) lastLetter = routeLetter
  })

  /* ----------------------------------------------------- live stream */

  const streamOn = $derived(page !== null)

  /*
   * The header's place moves when someone else overtakes, and the stream
   * says only «the board changed». Off the leaderboard tab the page is asked
   * again for it — at most twice a minute: thirty people sending in the
   * last ten minutes are thirty board changes, not thirty reloads each.
   */
  let placeTimer: ReturnType<typeof setTimeout> | null = null
  let placeAskedAt = 0
  function refreshPlaceSoon(slug: string): void {
    if (placeTimer !== null || person === null || !joined) return
    const wait = Math.max(0, placeAskedAt + 30_000 - Date.now())
    placeTimer = setTimeout(() => {
      placeTimer = null
      placeAskedAt = Date.now()
      if (routeSlug === slug) void loadPage(slug)
    }, wait)
  }
  $effect(() => () => {
    if (placeTimer !== null) clearTimeout(placeTimer)
  })

  /** What a stream word changed, fetched — and only that. */
  function follow(slug: string, before: ContestStreamState | null, next: ContestStreamState): void {
    const view = routeView
    if (before === null) {
      // The first word of a connection: catch up with whatever moved between
      // the page's reads and the stream's opening.
      if (page && next.revision !== page.contest.revision) void loadPage(slug)
      if (person !== null && mine && next.mine !== mine.version) void loadMine(slug)
      return
    }
    if (next.revision !== before.revision) void loadPage(slug)
    if (next.mine !== before.mine && person !== null) void loadMine(slug)
    if (next.board !== before.board) {
      if (view === 'leaderboard' || view === 'screen') void loadBoard(slug)
      else refreshPlaceSoon(slug)
    }
    if (next.questions !== before.questions) {
      if (view === 'questions') void loadQuestions(slug)
      else if (person !== null) questionsFresh = true
    }
  }

  $effect(() => {
    const slug = routeSlug
    const who = person
    if (!streamOn) return
    /*
     * Alive while it is still this contest and this person — not by the
     * request generation: a join or a sign-in with the same key bumps that,
     * and a stream that outlived it would go deaf for the rest of the class.
     */
    const alive = (): boolean => routeSlug === slug && person === who
    let last: ContestStreamState | null = null
    const stream = new EventSource(contestApi.streamUrl(slug))
    stream.addEventListener('state', (event) => {
      if (!alive()) return
      streamLost = false
      let next: ContestStreamState
      try {
        next = JSON.parse((event as MessageEvent<string>).data) as ContestStreamState
      } catch {
        return
      }
      const before = last
      last = next
      follow(slug, before, next)
    })
    /*
     * The stream broke — a server restart, a proxy, a laptop asleep. Said, so
     * that a page that looks alive is not taken for one; the poll below keeps
     * the numbers moving, and EventSource keeps trying to come back.
     */
    stream.addEventListener('error', () => {
      if (alive()) streamLost = true
    })
    return () => stream.close()
  })

  /* The fallback: every five seconds while the stream is down, the page itself every half minute. */
  $effect(() => {
    const slug = routeSlug
    if (!streamLost || !streamOn) return
    let tick = 0
    const timer = setInterval(() => {
      tick += 1
      const view = routeView
      if (person !== null) void loadMine(slug)
      if (view === 'leaderboard' || view === 'screen') void loadBoard(slug)
      if (view === 'questions') void loadQuestions(slug)
      if (tick % 6 === 0) void loadPage(slug)
    }, 5000)
    return () => clearInterval(timer)
  })

  /*
   * The phase moved by the clock (the start, the end): the door answers
   * differently now — the problems at the start, the closed intake at the
   * end — so the page asks it again. Spread over a second and a half: a class
   * of thirty all waiting for the same second is thirty requests in one.
   */
  let phaseSeen: string | null = null
  $effect(() => {
    const slug = routeSlug
    const current = phase
    if (current === null) return
    const key = `${slug}:${current}`
    const before = phaseSeen
    phaseSeen = key
    if (before === null || before === key || !before.startsWith(`${slug}:`)) return
    const timer = setTimeout(() => void loadPage(slug), Math.random() * 1500)
    return () => clearTimeout(timer)
  })

  /* Started, and the door still sent no problems (its clock a moment behind ours): asked again, a few times. */
  const waitingForProblems = $derived(phase === 'open' && page !== null && page.problems.length === 0)
  $effect(() => {
    const slug = routeSlug
    if (!waitingForProblems) return
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (tries > 5) clearInterval(timer)
      else void loadPage(slug)
    }, 3000)
    return () => clearInterval(timer)
  })

  /* The shell from index.html leaves on the first screen (lib/boot.ts). */
  $effect(() => {
    if (ready || failure) firstScreenReady()
  })

  /* ----------------------------------------------------------- actions */

  /* A refusal answers the form it was typed into: another tab is another form. */
  let formsAt: string | null = null
  $effect(() => {
    const at = `${routeSlug}/${routeView}`
    if (formsAt === at) return
    formsAt = at
    joinRefusal = null
    signInRefusal = null
    askRefusal = null
  })

  /* A new tab or problem opens at its top, not where the previous one was scrolled to. */
  let scroller = $state<HTMLElement | null>(null)
  $effect(() => {
    void routeView
    void routeLetter
    untrack(() => scroller?.scrollTo({ top: 0 }))
  })

  async function join(slug: string, wanted: string): Promise<void> {
    if (joinBusy) return
    const request = ++identityRequest
    joinBusy = true
    joinRefusal = null
    try {
      const answer = await contestApi.join(slug, wanted)
      if (request !== identityRequest) return
      const same = answer.entrant?.id !== undefined && answer.entrant.id === person
      me = joinedMe(me, answer)
      joinedHere = visitKey(slug, answer.entrant?.id)
      joinAsk = null
      // The door said yes: the page knows it now, not a round trip later.
      if (routeSlug === slug && page) {
        page = { ...page, mine: { place: null, solved: 0, score: 0, unreadAnswers: 0, ...page.mine, joined: true } }
      }
      // The same person stays the same visit, so nothing reloads by itself: the page and the list are asked here.
      if (same) {
        void loadPage(slug)
        void loadMine(slug)
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

  /** «Вступить» from a tab that has no join step: to the problems, where it stands, and focused there. */
  function startJoin(): void {
    if (!page) return
    joinAsk = page.contest.slug
    if (routeView === 'leaderboard' || routeView === 'screen') {
      onnavigate(contestRoutePath({ slug: page.contest.slug, view: 'problems', letter: lastLetter }))
    }
  }

  async function send(problem: EntrantProblem, language: ContestLanguage, source: string): Promise<void> {
    const slug = page?.contest.slug
    if (!slug || slug !== routeSlug || sending) return
    const context = requestContext()
    sending = true
    sendRefusal = null
    try {
      const answer = await contestApi.submit(slug, { problemId: problem.id, language, source })
      if (!currentContext(context)) return
      // The new row stands at once, before the list comes back with it.
      const rest = (mine?.submissions ?? []).filter((submission) => submission.id !== answer.submission.id)
      mine = { submissions: [answer.submission, ...rest], version: mine?.version ?? '' }
      void loadMine(slug)
      // The attempts left under the button counted this one.
      void loadPage(slug)
    } catch (error: unknown) {
      if (!currentContext(context)) return
      sendRefusal = { problemId: problem.id, message: say(error) }
      // A refusal by the page's own numbers means the numbers were stale.
      if (error instanceof ContestApiError && ['not_joined', 'not_open', 'closed', 'attempts', 'language'].includes(error.reason)) {
        void loadPage(slug)
      }
    } finally {
      if (currentContext(context)) sending = false
    }
  }

  async function ask(problemId: string | null, question: string): Promise<boolean> {
    const slug = page?.contest.slug
    if (!slug || asking) return false
    const context = requestContext()
    asking = true
    askRefusal = null
    try {
      const created = await contestApi.ask(slug, { problemId, question })
      if (!currentContext(context)) return false
      questions = [created, ...(questions ?? []).filter((item) => item.id !== created.id)]
      return true
    } catch (error: unknown) {
      if (currentContext(context)) askRefusal = say(error)
      return false
    } finally {
      if (currentContext(context)) asking = false
    }
  }

  function showKey(): void {
    // Right after joining, the key stands on the contest's own page; otherwise on the list.
    const card = document.querySelector('[data-key-card]')
    if (!card) {
      onnavigate(COMPETITIONS_LANDING)
      return
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  function allOf(problem: EntrantProblem): void {
    if (!page) return
    problemFilter = problem.id
    onnavigate(contestRoutePath({ slug: page.contest.slug, view: 'submissions', letter: null }))
  }

  /* ------------------------------------------------------ the problems */

  /** The contest's first page has something of its own to say: a start to wait for, or the teacher's description. */
  const intro = $derived(page !== null && (page.problems.length === 0 || page.contest.description.trim() !== ''))
  /** The open problem; null — the intro (or a letter the contest does not have). */
  const problem = $derived.by(() => {
    if (!page || routeView !== 'problems') return null
    if (routeLetter !== null) return page.problems.find((candidate) => candidate.letter === routeLetter) ?? null
    return intro ? null : (page.problems[0] ?? null)
  })
  const showIntro = $derived(routeView === 'problems' && routeLetter === null && intro)
  const problemSubmissions = $derived(
    problem ? submissions.filter((submission) => submission.problemId === problem.id).sort((a, b) => b.number - a.number) : [],
  )
  /*
   * The join step's door: a contest takes people before its start too —
   * registering ahead of a timed test is the point of a link sent the day
   * before — and after its end only while it takes upsolving.
   */
  const joinAccepting = $derived(accepting === 'not_open' ? 'open' : accepting)
  const joinWords = $derived({
    title: tr('contests.p.joinTitle'),
    hint: tr('contests.p.joinHint'),
    lateHint: tr('contests.p.joinLateHint'),
    notOpen: tr('contests.p.notOpenSend'),
    closed: tr('contests.p.closedSend'),
  })
  const address = $derived(
    typeof location === 'undefined' ? contestRoutePath({ slug: routeSlug, view: 'problems', letter: null }) : `${location.host}${contestRoutePath({ slug: routeSlug, view: 'problems', letter: null })}`,
  )
</script>

{#snippet joinStep(narrow: boolean)}
  {#if page}
    <JoinStep
      accepting={joinAccepting}
      defaultName={name ?? ''}
      signedIn={!!me?.entrant}
      busy={joinBusy}
      refusal={joinRefusal}
      {signInBusy}
      {signInRefusal}
      focus={joinAsk === page.contest.slug}
      onfocused={() => (joinAsk = null)}
      onjoin={(wanted) => void join(page!.contest.slug, wanted)}
      onsignin={signIn}
      words={joinWords}
      {narrow}
    />
  {/if}
{/snippet}

{#snippet joinWide()}
  {@render joinStep(false)}
{/snippet}

{#snippet joinNarrow()}
  {@render joinStep(true)}
{/snippet}

{#snippet keyCard()}
  {#if page && joinedHere === visitKey(page.contest.slug, person)}
    <KeyPanel {me} keyOnly />
  {/if}
{/snippet}

{#snippet solution(item: EntrantProblem)}
  {#key item.id}
    <SolutionPanel
      contestId={page!.contest.id}
      problem={item}
      languages={page!.languages}
      {accepting}
      {joined}
      {sending}
      refusal={sendRefusal?.problemId === item.id ? sendRefusal.message : null}
      {phone}
      onsend={(language, source) => void send(item, language, source)}
      onrefuse={(message) => (sendRefusal = message === null ? null : { problemId: item.id, message })}
      join={phone ? undefined : joinNarrow}
    />
  {/key}
{/snippet}

{#if routeView === 'screen'}
  {#if page}
    <ProjectorView view={page} standings={board} closed={boardClosed} {serverNow} {address} />
  {:else if !ready && !failure}
    <Splash size="screen" />
  {:else}
    <main class="competition-ui flex h-full items-center justify-center bg-canvas px-6">
      <p class="text-title text-muted">{failure ?? tr('contests.refusal.notFound')}</p>
    </main>
  {/if}
{:else}
  <div class="competition-ui flex h-full flex-col overflow-auto bg-canvas" bind:this={scroller}>
    {#if !phone}
      <TopBar {name} {onnavigate} onkey={showKey} />
    {/if}

    {#if !ready && !failure}
      <Splash size="screen" />
    {:else if page}
      <ContestHeader
        view={page}
        tab={routeView}
        letter={lastLetter}
        {serverNow}
        {phone}
        submissions={mine && submissions.length > 0 ? submissions.length : null}
        {unread}
        {place}
        {onnavigate}
      />
      {#if streamLost}
        <p class="px-4 pt-3 text-micro text-warning sm:px-10" role="status">{tr('contests.p.streamLost')}</p>
      {/if}

      {#if routeView === 'problems'}
        {#if phone}
          {#if page.problems.length > 0}
            <ProblemRail
              slug={page.contest.slug}
              problems={page.problems}
              rules={page.contest.rules}
              letter={problem?.letter ?? null}
              {submissions}
              phone
              {onnavigate}
            />
          {/if}
          {#if showIntro}
            <ContestIntro view={page} {serverNow} phone {onnavigate} join={joined ? undefined : joinWide} />
          {:else if problem}
            <div class="px-4 py-[18px]"><ProblemStatement {problem} phone /></div>
            <div class="flex flex-col gap-4 px-4 pb-4 empty:hidden">
              {@render keyCard()}
              {#if !joined}{@render joinStep(true)}{/if}
            </div>
            <ProblemSubmissions {problem} submissions={problemSubmissions} rules={page.contest.rules} phone onall={() => allOf(problem)} />
            {@render solution(problem)}
          {:else}
            <p class="px-4 py-6 text-ui text-muted">{tr('contests.p.noSuchProblem', { letter: routeLetter ?? '' })}</p>
          {/if}
        {:else}
          <div class="flex flex-col gap-6 px-4 pb-12 pt-7 sm:px-10 lg:flex-row lg:items-start lg:gap-9">
            {#if page.problems.length > 0}
              <div class="lg:hidden">
                <ProblemRail
                  slug={page.contest.slug}
                  problems={page.problems}
                  rules={page.contest.rules}
                  letter={problem?.letter ?? null}
                  {submissions}
                  phone
                  {onnavigate}
                />
              </div>
              <aside class="hidden w-[216px] shrink-0 lg:block">
                <ProblemRail
                  slug={page.contest.slug}
                  problems={page.problems}
                  rules={page.contest.rules}
                  letter={showIntro ? null : (problem?.letter ?? routeLetter)}
                  {submissions}
                  intro={intro && page.contest.description.trim() !== ''}
                  {onnavigate}
                />
              </aside>
            {/if}
            {#if showIntro}
              <div class="min-w-0 flex-1">
                <ContestIntro view={page} {serverNow} phone={false} {onnavigate} join={joined ? undefined : joinWide} />
              </div>
            {:else if problem}
              <div class="flex min-w-0 flex-1 flex-col gap-9 xl:flex-row xl:items-start">
                <div class="min-w-0 flex-1"><ProblemStatement {problem} /></div>
                <div class="flex w-full shrink-0 flex-col gap-3.5 xl:w-[460px] min-[1400px]:w-[540px]">
                  {@render keyCard()}
                  {@render solution(problem)}
                  <ProblemSubmissions {problem} submissions={problemSubmissions} rules={page.contest.rules} onall={() => allOf(problem)} />
                </div>
              </div>
            {:else}
              <p class="py-6 text-ui text-muted">{tr('contests.p.noSuchProblem', { letter: routeLetter ?? '' })}</p>
            {/if}
          </div>
        {/if}
      {:else}
        <main class="flex flex-col gap-5 px-4 py-5 sm:px-10 sm:py-7">
          {#if routeView === 'submissions'}
            {#if !joined}
              {@render joinStep(false)}
            {/if}
            {@render keyCard()}
            {#if joined || submissions.length > 0}
              <SubmissionsTable
                {submissions}
                problems={page.problems}
                languages={page.languages}
                rules={page.contest.rules}
                {phone}
                {problemFilter}
                onfilter={(id) => (problemFilter = id)}
                load={loadDetail}
              />
            {/if}
          {:else if routeView === 'leaderboard'}
            {#if board}
              <LeaderboardView standings={board} {phone} pending={pendingTests} />
            {:else if boardClosed}
              <div class="flex max-w-[640px] flex-col items-start gap-3 border-t-2 border-ink pt-5">
                <p class="text-title font-bold leading-6 text-ink">{tr('contests.p.boardClosedTitle')}</p>
                <p class="text-ui leading-5 text-muted">{tr('contests.p.boardClosedText')}</p>
                {#if accepting !== 'closed'}
                  <button
                    class="h-[38px] bg-brand px-4 text-micro font-black uppercase tracking-label text-white hover:bg-brand-2"
                    type="button"
                    onclick={startJoin}
                  >
                    {tr('competitions.p.join')}
                  </button>
                {/if}
              </div>
            {/if}
          {:else if routeView === 'questions'}
            <QuestionsView
              questions={questions ?? []}
              problems={page.problems}
              {joined}
              busy={asking}
              refusal={askRefusal}
              now={serverNow}
              {phone}
              onask={ask}
              join={joinNarrow}
            />
          {/if}
        </main>
      {/if}
    {:else}
      <main class="flex grow flex-col items-start gap-4 px-4 py-10 sm:px-10">
        <p class="text-ui text-danger">{failure ?? tr('contests.refusal.notFound')}</p>
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
