<script lang="ts">
  /**
   * Страницы соревнований `/k` — список, соревнование, посылки, лидерборд.
   *
   * Один экран на все четыре адреса нарочно: вкладки одного соревнования — это
   * одна страница, и переход между ними не должен заново грузить задачу,
   * ронять таймер и рвать живой поток. Адрес разбирает `lib/routes.ts`, данные
   * ходят через `lib/entrantApi.ts`, слова и счёт — `lib/competition-words.ts`;
   * здесь остаётся только то, что нельзя посчитать заранее: что сейчас на
   * экране, что уже приехало и что сломалось.
   *
   * ЖИВОЕ ОБНОВЛЕНИЕ — `EventSource`, тем же способом, что журнал сборки
   * окружений и экран соревнования у преподавателя. Сокет комнаты сюда не
   * годится вовсе: у этих страниц нет ни комнаты, ни документа, ни присутствия,
   * а нужно им ровно одно направление — сервер говорит, что посылка сдвинулась.
   * Поток открывается, только пока у человека что-то ИДЁТ, и закрывается, как
   * только всё досчиталось: тридцать открытых вкладок лидерборда, каждая со
   * своим соединением, — это тридцать соединений ради страницы, на которой
   * ничего не меняется.
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

  /* ------------------------------------------------------------- ширина */

  /*
   * Телефон — не «то же самое, но уже»: у него своя раскладка строки посылки,
   * свои подписи и нет полосы этапов (P4). Поэтому ширина читается здесь, а не
   * только классами: разница структурная, и рисовать оба дерева сразу значит
   * возить лишнее каждому.
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

  /* --------------------------------------------------------- состояние */

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

  /* ------------------------------------------------------------- часы */

  /*
   * ОДНО булево, а не чтение всего `mine`, и это не стиль.
   *
   * Живой кадр приезжает раз в секунду и заменяет `mine` целиком. Эффект,
   * который читает `mine` прямо в теле, перезапускается на каждом кадре — то
   * есть каждую секунду пересоздаёт таймер (и он не успевает тикнуть) и
   * ЗАКРЫВАЕТ-ОТКРЫВАЕТ поток. Второе измерено на стенде: прокси между
   * браузером и сервером кончился локальными портами (EADDRNOTAVAIL) за
   * полминуты такой работы. `$derived` от булева пересчитывается тихо, а
   * эффект будит только его СМЕНА.
   */
  const running = $derived((mine?.submissions ?? []).some((it) => !isTerminal(it.state)))

  $effect(() => {
    // Секунда, пока что-то идёт (у таймера прогона она в подписи), и полминуты
    // в остальное время: обратный счёт до дедлайна меняется раз в минуту.
    const step = running ? 1000 : 30_000
    const timer = setInterval(() => (now = Date.now()), step)
    return () => clearInterval(timer)
  })

  /* ------------------------------------------------------ ключ из ссылки */

  /**
   * Ключ из ссылки — в печенье, и сразу же прочь из адресной строки.
   *
   * Адрес переживает и вкладку, и снимок экрана, который студент пришлёт
   * однокурснику вместе со своим местом; ключ в нём — это чужие посылки. То же
   * правило и по той же причине, что у ссылки на пульт (App.svelte · claiming).
   */
  let claiming = $state(false)
  let claimed: string | null = null
  $effect(() => {
    const key = route.signInKey
    if (!key || claimed === key) return
    claimed = key
    claiming = true
    void entrantApi
      .signIn(key)
      .then((answer) => {
        me = answer
      })
      .catch((error: unknown) => {
        if (error instanceof EntrantApiError) signInRefusal = error.message
      })
      .finally(() => {
        claiming = false
        history.replaceState({}, '', COMPETITIONS_LANDING)
        onnavigate(COMPETITIONS_LANDING)
      })
  })

  /* --------------------------------------------------------- загрузка */

  function say(error: unknown): string {
    return error instanceof EntrantApiError ? error.message : tr('common.networkError')
  }

  async function loadMe(): Promise<void> {
    try {
      me = await entrantApi.me()
    } catch {
      // Личность — не то, ради чего человек пришёл: список соревнований
      // открыт и без неё, и падать всей страницей из-за печенья незачем.
      me = { entrant: null, key: null, link: null }
    }
  }

  async function loadList(): Promise<void> {
    try {
      list = await entrantApi.list()
      failure = null
    } catch (error: unknown) {
      failure = say(error)
    } finally {
      ready = true
    }
  }

  async function loadPage(slug: string): Promise<void> {
    try {
      page = await entrantApi.competition(slug)
      failure = null
    } catch (error: unknown) {
      failure = say(error)
      page = null
    } finally {
      ready = true
    }
  }

  async function loadBoard(slug: string): Promise<void> {
    try {
      board = await entrantApi.leaderboard(slug)
    } catch (error: unknown) {
      failure = say(error)
    }
  }

  async function loadMine(slug: string): Promise<void> {
    try {
      mine = await entrantApi.submissions(slug)
    } catch (error: unknown) {
      // «Войдите по ключу» — не поломка страницы: человек просто ещё не
      // вступал, и вкладка посылок покажет ему кнопку, а не красную строку.
      if (error instanceof EntrantApiError && error.status === 401) mine = null
      else failure = say(error)
    }
  }

  let carried: string | null = null
  $effect(() => {
    const slug = route.slug
    const view = route.view
    const person = me?.entrant?.id ?? null
    if (me === null) {
      void loadMe()
      return
    }
    if (slug === null) {
      if (route.signInKey === null) void loadList()
      return
    }
    if (carried !== slug) {
      carried = slug
      page = null
      mine = null
      board = null
      final = false
    }
    void loadPage(slug)
    /*
     * Лидерборд грузится на ЛЮБОЙ вкладке, включая «Задачу»: из него считается
     * «ВАШЕ МЕСТО» в шапке — место среди людей, без базового решения. Без него
     * шапка берёт место, посчитанное сервером по всей таблице, и говорит «4 из
     * 3» на соревновании, где бейзлайн идёт первым.
     */
    void loadBoard(slug)
    if (view === 'submissions' && person !== null) void loadMine(slug)
  })

  /*
   * Итоговая таблица выбирается сама, когда её открыли: человек, зашедший на
   * лидерборд после дедлайна, пришёл за итогом, а не за публичной частью.
   */
  let switched: string | null = null
  $effect(() => {
    if (!board?.privateOpen || board.private === null) return
    if (switched === route.slug) return
    switched = route.slug
    final = true
  })

  /* ------------------------------------------------------- живой поток */

  $effect(() => {
    const slug = route.slug
    if (!slug || route.view !== 'submissions' || !running) return
    const stream = new EventSource(entrantApi.streamUrl(slug))
    stream.addEventListener('state', (event) => {
      streamLost = false
      try {
        const fresh = JSON.parse((event as MessageEvent<string>).data) as EntrantSubmissions
        /*
         * Посылка ДОСЧИТАЛАСЬ — значит, рядом устарело всё остальное: место в
         * шапке, мини-таблица лидерборда, «лучший результат» под именем файла.
         * Поток про них не знает (он про мои посылки), поэтому конец прогона —
         * единственный момент, когда страница спрашивает соседние двери заново.
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
        /* кадр не разобрался — следующий приедет через секунду */
      }
    })
    /*
     * Поток оборвался — и это надо сказать: перезапуск сервера, прокси,
     * уснувший ноутбук. Таймер и полоса просто замирают, и без слова страница
     * выглядит живой, будучи мёртвой. Числа догонит опрос ниже.
     */
    stream.addEventListener('error', () => {
      streamLost = true
    })
    return () => stream.close()
  })

  /*
   * Запасной опрос — на случай, когда поток не доехал вовсе (буферизующий
   * прокси, корпоративная сеть, выключённый EventSource). Пять секунд, а не
   * одна: это запасной путь, и платить за него столько же, сколько за живой,
   * незачем.
   */
  $effect(() => {
    const slug = route.slug
    if (!slug || !streamLost || route.view !== 'submissions') return
    const timer = setInterval(() => void loadMine(slug), 5000)
    return () => clearInterval(timer)
  })

  /*
   * Оболочка из index.html снимается по первому экрану, а не по монтированию
   * (lib/boot.ts). Обмен ключа под заставкой — честнее, чем мелькнувшая пустая
   * страница под ним, поэтому доклад ждёт его конца.
   */
  $effect(() => {
    if (!claiming && (ready || failure)) firstScreenReady()
  })

  /* --------------------------------------------------------- действия */

  async function join(slug: string, wanted: string): Promise<void> {
    joinBusy = true
    joinRefusal = null
    try {
      me = await entrantApi.join(slug, wanted)
      joining = null
      await Promise.all([loadList(), route.slug === slug ? loadPage(slug) : Promise.resolve()])
      if (route.slug === slug) await loadMine(slug)
    } catch (error: unknown) {
      joinRefusal = say(error)
    } finally {
      joinBusy = false
    }
  }

  async function signIn(key: string): Promise<void> {
    signInBusy = true
    signInRefusal = null
    try {
      me = await entrantApi.signIn(key)
      await loadList()
    } catch (error: unknown) {
      signInRefusal = say(error)
    } finally {
      signInBusy = false
    }
  }

  async function signOut(): Promise<void> {
    await entrantApi.signOut().catch(() => undefined)
    me = { entrant: null, key: null, link: null }
    mine = null
    await loadList()
  }

  async function send(file: File, bundleId?: string | null): Promise<boolean> {
    const slug = route.slug
    if (!slug) return false
    sending = true
    sendRefusal = null
    try {
      await entrantApi.send(slug, file, bundleId)
      await loadMine(slug)
      return true
    } catch (error: unknown) {
      sendRefusal = say(error)
      return false
    } finally {
      sending = false
    }
  }

  async function choose(id: string): Promise<void> {
    const slug = route.slug
    if (!slug) return
    busy = true
    try {
      mine = await entrantApi.choose(slug, id)
      await loadBoard(slug)
    } catch (error: unknown) {
      sendRefusal = say(error)
    } finally {
      busy = false
    }
  }

  async function cancel(id: string): Promise<void> {
    const slug = route.slug
    if (!slug) return
    busy = true
    try {
      mine = await entrantApi.cancel(slug, id)
    } catch (error: unknown) {
      sendRefusal = say(error)
      await loadMine(slug)
    } finally {
      busy = false
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

  /* --------------------------------------------------- счёт для шапки */

  const myPublic = $derived(board?.public.find((line) => line.you) ?? null)

  /**
   * «ВАШЕ МЕСТО 7 из 28» — место СРЕДИ ЛЮДЕЙ.
   *
   * В таблице базовое решение стоит обычной строкой со своим местом (так в
   * макете P3), но в знаменателе шапки — участники, и брать числитель из той
   * же таблицы значит однажды показать «2 из 1»: на соревновании, где никто
   * ещё не прислал решения лучше бейзлайна, он идёт первым.
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
  <!-- Проектор: тот же лидерборд без шапки и вкладок. Его показывают классу с
       заднего ряда, и всё, что не строка таблицы, отсюда убрано. -->
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
      На телефоне внутри соревнования полосы нет: её место занимает шапка
      страницы, где уже есть и «‹ Соревнования», и имя (P4). Две полосы подряд
      в 390 px — это 110 px мебели над названием задачи.
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
