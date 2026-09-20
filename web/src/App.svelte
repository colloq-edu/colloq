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
   * Адреса и их разбор живут в `lib/routes.ts` — там же, где их проверяют
   * тесты: регулярка, тихо переставшая совпадать, сборку не уронит, а высадит
   * планшет с живым ключом в адресной строке на экран входа.
   */
  let path = $state(location.pathname)
  /**
   * Комната и то, каким из её экранов её открыли.
   *
   * Режим одним значением, а не набором флагов: экранов ровно четыре и они
   * взаимоисключающие, а пара `projection` + `pult` умеет быть включённой
   * одновременно — то есть умеет означать то, чего не бывает.
   */
  const roomRoute = $derived(readRoomRoute(path))
  const sessionId = $derived(roomRoute?.id ?? null)
  const mode = $derived(roomRoute?.mode ?? 'room')
  /** Ячейка пульта консилиума — только у режима `council`. */
  const councilCell = $derived(roomRoute?.cellId ?? null)
  /** Ключ из ссылки на пульт: планшет меняет его на обычный вход. */
  const handoffKey = $derived(roomRoute?.handoffKey ?? null)
  // The teaching side. It routes its own sub-paths; this only has to get out of
  // the way, and to do so before the seminar route touches localStorage.
  const isAdmin = $derived(isAdminPath(path))
  const courseId = $derived(readCourseId(path))
  const publicSeminar = $derived(readPublicRoute(path))
  /*
   * Соревнования — четвёртая публичная дверь продукта, рядом с курсом и
   * публикацией: ни комнаты, ни токена участника здесь нет, а личность — своя,
   * уровня инстанса, и живёт она в печенье, а не в localStorage.
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
   * Публичные страницы — тоже отдельным куском, и по более резкому поводу, чем
   * панель: это единственные адреса Colloq, которые открывают с телефона, из
   * дома, через неделю после занятия. Тащить туда редактор, терминал и оракула
   * значит платить за них тем, кто пришёл прочитать тетрадь.
   */
  let readerChunk: Promise<typeof import('@/screens/ReaderScreen.svelte').default> | null = null
  const reader = () =>
    (readerChunk ??= loadLocalizedScreen(
      () => import('@/screens/ReaderScreen.svelte').then((m) => m.default), 'reader', language.current))

  /*
   * И соревнования — тем же куском и по тому же доводу: `/k` открывают дома с
   * телефона за час до дедлайна, и редактор, терминал и оракул там не нужны
   * ни одной строкой. Словарь у них свой (lib/screen-language.ts · competitions).
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
  /** О комнате знают, а не догадываются: см. `enter`. */
  let confirmed = $state(false)
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
    tr('room.ui.1219')

  function navigate(next: string): void {
    if (next !== location.pathname) history.pushState({}, '', next)
    /*
     * Публичные страницы — единственные во всём продукте, где прокручивается
     * сам документ: комната закреплена по высоте окна. Переход внутри них —
     * это новая страница, а не смена панели, и открываться она обязана сверху:
     * студент, долиставший курс до пятнадцатой строки и нажавший семинар,
     * попадал в середину чужой тетради, без шапки и без рельсы шагов, и решал,
     * что промахнулся.
     *
     * Только для перехода вперёд. `popstate` сюда не заходит (у него свой
     * слушатель), и это намеренно: место на странице, с которой ушли, — дело
     * браузера, он его и восстанавливает.
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
    const cached = id ? recallSessionInfo(id) : null
    /*
     * «Про комнату известно» — это ответ сервера или память браузера, но НЕ
     * заглушка из `knownRoom`: у неё пустое имя и угаданные правила, и снимать
     * по ней заставку значит показать форму входа, на которой вместо названия
     * занятия стоит серая полоса. Ровно тот кадр, ради которого заставку и
     * держат (lib/boot.ts).
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
   * Язык сменили — доложить словарь тому экрану, который уже открыт.
   *
   * Экранный словарь везёт один язык (lib/screen-language.ts), поэтому смена
   * языка — это ещё и загрузка. До её конца `translate` отдаёт прежний язык, а
   * не голый ключ; `messagesChanged` перерисовывает переведённое, когда словарь
   * доехал. Куски экранов при этом не трогаются: ни одна память комнаты не
   * пересобирается из-за переключателя языка.
   */
  let localeShown = language.current
  $effect(() => {
    const locale = language.current
    if (locale === localeShown) return
    localeShown = locale
    void reloadAreaMessages(locale).then(messagesChanged, () => {})
  })

  /**
   * Когда снимать заставку из index.html — на тех экранах, которые рисует сам
   * App (lib/boot.ts · кто докладывает).
   *
   * Их два. Экран отказа — это уже экран: ждать под заставкой больше нечего, и
   * висеть она обязана не дольше, чем есть надежда. Форма входа — это экран,
   * как только известно, КУДА входят: у неё в шапке название занятия, и до
   * ответа сервера там стоит заглушка.
   *
   * Остальные ветки докладывают о себе сами, когда доедут: панель, читалка,
   * комната. Обмен ключа на вход (`claiming`) намеренно молчит — это один
   * запрос, и заставка над ним честнее, чем мелькнувшая строка «Открываем
   * пульт…» под ней.
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
         * НАШ 404, а не любой.
         *
         * Здесь стирают местную копию тетради — то есть всё, что человек успел
         * напечатать без связи, — и по голому коду состояния этого делать
         * нельзя: 404 отдаёт и ретранслятор, у которого отвалился frpc, и
         * статика, раздающая index.html на всё подряд. Тогда перебой связи
         * превращался в «этот семинар удалён» у всего класса разом. Признак —
         * слова сервера в теле ответа (shared/protocol.ts · saysSessionMissing);
         * чужой 404 ниже разбирается как обычный обрыв.
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
    // Один помощник на оба экрана — см. screens/staff.ts: снятие метки и
    // разбор ответа «нет»/«не знаю» жили здесь и в JoinScreen по-разному.
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
   * Ссылка на пульт: обменять ключ на вход и стереть его из адреса.
   *
   * Планшет открывает `/s/:id/t/<ключ>` и должен оказаться в комнате ТЕМ ЖЕ
   * человеком, что и ноутбук, — без формы имени и без второго участника в
   * списке. Ключ одноразовый и живёт минуты, но адрес переживает и то и
   * другое: он остаётся в истории, во вкладках и на снимке экрана, который
   * преподаватель потом покажет классу. Поэтому сразу после обмена адрес
   * заменяется — replaceState, чтобы «назад» не возвращало на мёртвый ключ.
   *
   * Заменяется на ЭКРАН, КОТОРЫЙ НАЗВАЛА ССЫЛКА (`handoffLanding`), а не на
   * комнату: этой ссылкой открывают планшет, чтобы ВЕСТИ, и раньше он приезжал
   * в ту же комнату, что и ноутбук — с вкладками, панелью файлов и оракулом, из
   * которых на паре не нужно ничего. Комната остаётся в одном нажатии («В
   * комнату» в «Ещё»), а пульт больше не надо искать.
   *
   * Экран берётся из разбора ДО обмена и запоминается: `path` меняется здесь же,
   * и читать его после было бы чтением собственного следа. Пульт консилиума
   * этим и живёт — ссылка с ключом ведёт в конкретную ячейку, а не «куда-нибудь
   * в пульт»; голый `/s/:id/t/<ключ>` по-прежнему означает пульт лекции.
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
         * Ключ протух — это обычный ход дела, а не поломка: ссылку открыли
         * через час. Поэтому причина едет запиской на экран входа, а не
         * экраном поломки.
         *
         * Раньше здесь ставился `failure`, и ветка `failure` в разметке стоит
         * раньше и комнаты, и формы: комментарий обещал «оставляем экран
         * входа», а на деле человек видел «Could not open this seminar» —
         * причём и тот, у кого личность для этой комнаты уже сохранена.
         * Ноутбук преподавателя, открывший вчерашнюю ссылку на пульт,
         * выкидывало из живой комнаты до нажатия «Try again».
         *
         * Записку рисует JoinScreen; у кого личность есть — тот просто входит
         * в комнату, и говорить ему не о чем: пульт он откроет из «Ещё».
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
  <!-- Ни токена, ни личности, ни сокетов: эти страницы читают и всё. -->
  <!--
    По ключу страницы, а не по одному условию на обе: `/c/…` и `/p/…` — один и
    тот же компонент, и переход между ними (нажатие на семинар в списке курса)
    менял только пропсы. Экран при этом оставался прежним: загруженный курс
    никто не гасил, и студент, ткнув в занятие, видел тот же список.

    Ключ без шага: `/p/:id/3` → `/p/:id/4` — это перелистывание внутри одной
    публикации, и пересобирать её ради него значило бы загружать семинар
    заново на каждый шаг.

    И С ПРЕФИКСОМ ВИДА. Slug уникален внутри вида, а не глобально: адреса
    курса и публикации проверяются разными таблицами (PK — пара вид+slug), так
    что `/c/ml-2026` и `/p/ml-2026` существуют одновременно совершенно
    законно. Голый handle давал им один и тот же ключ, экран не пересобирался,
    загруженный курс никто не гасил — и нажатие на семинар в списке меняло
    адрес, оставляя на экране тот же список.
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
    Страницы соревнований. Стоят перед панелью и перед комнатой, потому что
    `/k/…` не пересекается ни с тем, ни с другим, а ссылка для входа
    (`/k/t/<ключ>`) обязана доехать до своего экрана раньше, чем что-нибудь
    решит, что адрес ему незнаком, и отправит человека в панель.

    Без ключа: `#key` здесь не нужен — переход между вкладками одного
    соревнования это та же страница, и пересобирать её значило бы загружать
    задачу заново на каждое нажатие.
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

    «Не имеет причины» — не то же самое, что «не может»: студента сюда приводил
    каждый выход из комнаты, потому что и марка в шапке, и кнопка на экране
    отказа вели на `/`. Обе теперь ведут туда только штат — см. выше и
    SessionScreen.
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
        «Back to Colloq» — только тому, кому там есть куда прийти.

        Корень — это панель преподавателя (ниже), а на ней — форма «paste the
        setup token». Студент, ткнувший сюда с неверной ссылки на семинар,
        оказывался на экране входа штата и терял последнее, что у него было, —
        адрес комнаты в строке браузера. Метка `mightBeStaff` ничего не
        разрешает и ничего не спрашивает у сервера: она говорит только, что
        этот браузер когда-то подписывался в панели, — и этого ровно достаточно,
        чтобы решить, показывать ли дорогу туда.
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
    Обмен ключа на вход. Занимает один запрос, но экран входа мигнуть за это
    время успевает — а человек, который только что открыл ссылку «свой пульт»,
    увидел бы форму «как вас зовут» и решил бы, что ссылка не сработала.
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
