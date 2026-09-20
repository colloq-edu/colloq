<script lang="ts">
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import { tr, getLocale } from '@shared/i18n'
  /**
   * The seminar itself: the room, and the three things around it.
   *
   * The layout is one decision repeated — the notebook is the page, and Files,
   * People and the oracle are what it is surrounded by. Below about 1100px
   * the oracle folds into a button in the top bar and below about 700px the
   * left rail follows it, each opening as a panel over the room that closes on
   * Escape, on a click outside, or on the button that opened it. Nothing here
   * scrolls the page sideways at any width.
   *
   * This screen owns no seminar state. Everything it draws — the title, who is
   * here, the kernel's mood, the queue — is read from the shared document or
   * from awareness, so what it shows is what everybody else is looking at.
   */
  import { onDestroy, untrack } from 'svelte'
  import { quintOut } from 'svelte/easing'
  import { fade, fly, slide } from 'svelte/transition'
  import { peopleInRoom } from '@/lib/room'
  import { faceOf, namesLine, sameFaces, type Face } from '@/screens/roster'
  import { ruleRefusal } from '@/lib/rule-refusal'
  import { REVEAL_EVENT, revealCell, type RevealTarget } from '@/lib/reveal'
  import { gridFaviconHref } from '@/lib/logo'
  import { firstScreenReady } from '@/lib/boot'
  import Avatar from '@/components/ui/Avatar.svelte'
  import AvatarStack from '@/components/ui/AvatarStack.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Notebook from '@/components/notebook/Notebook.svelte'
  import AiPanel from '@/components/panels/AiPanel.svelte'
  import BanMenu from '@/components/panels/BanMenu.svelte'
  import BannedScreen from '@/components/BannedScreen.svelte'
  import FilesPanel from '@/components/panels/FilesPanel.svelte'
  import PeoplePanel from '@/components/panels/PeoplePanel.svelte'
  import TerminalDrawer from '@/components/panels/TerminalDrawer.svelte'
  import PdfReader from '@/components/reader/PdfReader.svelte'
  import LectureView from '@/components/lecture/LectureView.svelte'
  import { fullscreenPossible, goFullscreen, leaveFullscreen } from '@/lib/fullscreen'
  import { keepAwake } from '@/lib/wakelock'
  import ImageView from '@/components/reader/ImageView.svelte'
  import ThemeSwitch from '@/components/ui/ThemeSwitch.svelte'
  import Wordmark from '@/components/ui/Wordmark.svelte'
  import type { StoredIdentity } from '@/lib/identity'
  import { SessionState, setSessionState } from '@/lib/session.svelte'
  import { cn, modKey, prefersReducedMotion } from '@/lib/utils'
  import { onLanguageChange } from '@/lib/i18n.svelte'
  import type { PaletteItem } from '@/components/ui/palette'
  import {
    watchBookBusy,
    watchBookKernel,
    watchBooks,
    watchCellNumbers,
    watchNotebookMeta,
  } from '@/lib/yreactive.svelte'
  import { kernelProblemAdvice } from '@shared/kernel-problem'
  import {
    CELLS_KEY,
    cellLock,
    cellSource,
    findCell,
    getMeta,
    rootOfCell,
    type KernelStatus,
  } from '@shared/notebook'
  import { countLine, shownOutputLines, type CouncilCount } from '@/lib/council.svelte'
  import { pultPath } from '@/lib/council-pult-window'
  import { clock } from '@/lib/history'
  import type { CouncilShown, SessionInfo } from '@shared/protocol'
  import { copyText } from '@/lib/clipboard'
  import {
    beginVisit,
    refusalHasText,
    reloadByHand,
    stillLost,
    takeRefusal,
    type RefusedCell,
  } from '@/lib/refusal'
  import { permitsIn } from '@/lib/may'
  import { accessPatch } from '@/lib/book-access'
  import { controlDisabled, controlTitle } from '@/lib/controls'
  import TabStrip from '@/components/reader/TabStrip.svelte'
  import FileEditor from '@/components/editor/FileEditor.svelte'
  import FileBar from '@/components/editor/FileBar.svelte'
  import { leaderFor, sameLead, type Lead } from '@/lib/follow'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { Tabs } from '@/lib/tabs.svelte'
  import { holdFile, releaseFile, type FileDoc } from '@/lib/filedoc.svelte'
  import { baseOf, kindOf, runnerFor } from '@shared/paths'
  import { api } from '@/lib/api'
  import {
    actsAfterClass,
    CLASS_IS_OVER,
    readRules,
    type BookAccess,
    type OracleLimits,
    type RoomRules,
  } from '@shared/rules'
  import RoomRulesRows from '@/components/RoomRulesRows.svelte'

  interface Props {
    session: SessionInfo
    identity: StoredIdentity
    /**
     * Который из экранов комнаты нарисован.
     *
     * `room` — семинар, как его видят все; `screen` — проекция на балке
     * (`/s/:id/screen`); `pult` — пульт лекции в руках у преподавателя
     * (`/s/:id/pult`); `council` — пульт консилиума по одной ячейке в
     * отдельном окне (`/s/:id/council/:cell`). Один проп, а не набор флагов:
     * экраны взаимоисключающие, и пара булевых умела бы означать то, чего не
     * бывает.
     *
     * Все они живут в ОДНОМ компоненте, потому что живут на одном соединении:
     * `SessionState` создаётся ниже один раз, и переход между экранами его не
     * трогает — сокеты, документ и присутствие остаются на месте.
     */
    mode?: 'room' | 'screen' | 'pult' | 'council'
    /** Ячейка пульта консилиума; имеет смысл только при `mode: 'council'`. */
    councilCell?: string | null
    /** Уйти на другой адрес, не пересобирая комнату. */
    onnavigate?: (to: string) => void
    /**
     * Место в комнате перестало действовать — вернуть человека к форме имени.
     *
     * Комната сама этого сделать не может: экран входа живёт выше, а
     * сохранённую личность к этому моменту уже стёрли (см. `#diagnose`).
     */
    onexpired?: () => void
  }

  let {
    session: info,
    identity,
    mode = 'room',
    councilCell = null,
    onnavigate,
    onexpired,
  }: Props = $props()

  const projection = $derived(mode === 'screen')
  const pult = $derived(mode === 'pult')
  /**
   * Пульт консилиума — отдельное окно, и комната под ним не рисуется по той же
   * причине, что и под лекционным пультом, только повёрнутой в третью сторону:
   * тетрадь зеркалится на проектор, а в пульте лежат имена, черновики и
   * отметки. Одно окно — один зритель.
   */
  const councilPult = $derived(mode === 'council')

  /*
   * Пульт приезжает по требованию — по тому же поводу, что и панель в App.
   *
   * ConsoleView со своими палитрами и заметками спикера — несколько тысяч
   * строк, которые рисуются на одном планшете у одного человека. Статическим
   * импортом они лежали в чанке комнаты, то есть их качал и разбирал КАЖДЫЙ
   * студент на входе — включая тот, что смотрит проекцию. Динамический импорт
   * — единственное, что правда откладывает байты: перенос статического импорта
   * в другой файл просто переносит их вместе с ним.
   *
   * Запоминается, чтобы блок `{#await}` получал одно и то же обещание на
   * каждую перерисовку и пульт не пересобирался под рукой преподавателя.
   * InkLayer и LectureView остаются статическими: их рисует зал.
   */
  let pultChunk: Promise<typeof import('@/components/lecture/ConsoleView.svelte').default> | null =
    null
  const consoleView = () =>
    (pultChunk ??= import('@/components/lecture/ConsoleView.svelte').then((m) => m.default))
  /**
   * Пульт консилиума — вторым чанком, по тому же доводу и с той же ценой: он
   * рисуется в одном окне у одного человека, а лежал бы в чанке комнаты у
   * каждого студента.
   */
  function exitCouncil(): void {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.focus()
        window.close()
        return
      }
    } catch { /* An opener may no longer be accessible. */ }
    onnavigate?.(`/s/${session.session.id}`)
  }

  let councilChunk: Promise<
    typeof import('@/components/council/pult/PultWindow.svelte').default
  > | null = null
  const councilWindow = () =>
    (councilChunk ??= import('@/components/council/pult/PultWindow.svelte').then((m) => m.default))
  // Начинаем качать, как только адрес пульта на экране, а не когда дошли до
  // разметки: у планшета, открывшего ссылку-ключ, это выигрывает целый круг.
  $effect(() => {
    if (pult) void consoleView()
    if (councilPult) void councilWindow()
  })

  // Context can only be written during initialisation, so the live session is
  // built here rather than in the router — by now both the room and the person
  // are known, and every panel below reads it with getSessionState().
  // Reading the props once is the point: rebuilding SessionState would drop the
  // local CRDT and every keystroke that has not synced yet. The router remounts
  // this component when the room or the person actually changes.
  // svelte-ignore state_referenced_locally
  const session = new SessionState(info, identity)

  /*
   * Строка про смену правил живёт шесть секунд и уходит сама: её читают один
   * раз, а закрывать её крестиком — просить о работе за объявление.
   */
  /*
   * Правку не приняли — и вот она.
   *
   * Браузер, которому отказали, пересобирает документ перезагрузкой (см.
   * `lib/refusal.ts`), и без этой панели это было бы молчаливым стиранием чужой
   * работы, что не лучше молчаливо онемевшего браузера.
   */
  // Один раз при монтировании, как и SessionState выше: записка про тот заход,
  // который только что закончился отказом, и роутер пересоздаёт этот компонент,
  // когда комната действительно меняется.
  // svelte-ignore state_referenced_locally
  beginVisit()
  // svelte-ignore state_referenced_locally
  const refusal = takeRefusal(info.id)
  /*
   * Окно — про потерянный текст. Отказ кэшу при входе, после которого текста не
   * пропало, — это строка внизу на несколько секунд: вкладка уже собралась
   * заново, и всё, что человеку тут делать, — знать, почему она моргнула.
   *
   * Снимок ячеек сам по себе потери не доказывает: в нём вся тетрадь, включая
   * нетронутое. Что из неё правда не доехало, видно только после того, как
   * сервер отдал свою копию (`lostCells` ниже), — поэтому отказ КЭШУ со
   * снимком начинается строкой и поднимается окном, если сверка что-нибудь
   * найдёт. Без снимка (записка прошлой сборки или не влезшая в квоту) судим
   * тем, что есть, — `refusalHasText`.
   */
  const refusedSnapshot = refusal !== null && (refusal.cells?.length ?? 0) > 0
  const refusedWindow =
    refusal !== null && (refusal.kind !== 'stale' || (!refusedSnapshot && refusalHasText(refusal)))
  let refusalShown = $state(refusedWindow)
  let staleNotice = $state(refusal !== null && refusal.kind === 'stale' && !refusedWindow)
  if (staleNotice) setTimeout(() => (staleNotice = false), 9000)
  let refusalCopied = $state(false)

  /**
   * Что из записки правда не доехало — сверкой с копией, которую отдал сервер.
   *
   * `null`, пока сверять не с чем: до серверного sync документ пуст, а пустота
   * значит «ещё не читали», а не «сервер этого не принял» — посчитать здесь
   * рано значило бы объявить потерянной всю тетрадь. Считается один раз:
   * дальше человек уже правит документ сам, и вторая сверка объявила бы
   * потерей его же новую строку.
   */
  let lostCells = $state<RefusedCell[] | null>(null)
  if (refusal) {
    const settle = (isSynced: boolean): void => {
      if (!isSynced || lostCells !== null) return
      lostCells = stillLost(refusal, (id) => {
        const found = findCell(session.doc, id)
        return found ? cellSource(found.cell).toString() : null
      })
      // Нашлось потерянное — это уже не «вкладка моргнула», а «вот то, что вы
      // написали»: строка внизу уступает место окну.
      if (lostCells.length > 0 && !refusalShown) {
        refusalShown = true
        staleNotice = false
      }
      session.provider.off('sync', settle)
    }
    session.provider.on('sync', settle)
    onDestroy(() => session.provider.off('sync', settle))
    // Сокет мог успеть синхронизироваться до того, как экран смонтировался.
    if (session.provider.synced) settle(true)
  }

  /**
   * Что показать окном.
   *
   * Снимка может не быть вовсе — записка прошлой сборки или не влезшая в
   * квоту вкладки (см. `stashRefusal`); тогда остаётся то единственное, что в
   * ней есть, — ячейка под курсором, как было раньше.
   */
  const refusedCells = $derived.by((): RefusedCell[] => {
    if (!refusal) return []
    if (!refusedSnapshot) return refusal.text === '' ? [] : [{ id: '', text: refusal.text }]
    return lostCells ?? []
  })
  /** Снимок есть, сервер ещё не ответил: сказать нечего, но и врать нечем. */
  const refusedChecking = $derived(refusedSnapshot && lostCells === null)

  async function copyRefused(): Promise<void> {
    const list = refusedCells
    if (list.length === 0) return
    // Пустой строкой между ячейками: разделитель, который не притворяется ни
    // комментарием Python, ни заголовком markdown — тетрадь бывает и той, и
    // другой, а номера человек и так видит на экране.
    await copyText(list.map((cell) => cell.text).join('\n\n'))
    refusalCopied = true
    setTimeout(() => (refusalCopied = false), 1600)
  }

  /* --------------------------------------------------- пульт правил комнаты */

  let rulesOpen = $state(false)
  let rulesBusy = $state(false)
  const roomRules = $derived(readRules(session.session.rules))

  /**
   * Потолки оракула, действующие на инстансе.
   *
   * Две строки пульта ставят СВОИ потолки под инстансовые, и без числа рядом
   * «как на инстансе» не говорит человеку ничего: он не знает, ужесточает он
   * сейчас или пишет то же самое. Спрашивается один раз и только когда пульт
   * открыли: строка нужна преподавателю на десять секунд, а комната без неё
   * живёт как жила.
   */
  let oracleLimits = $state<OracleLimits | null>(null)
  $effect(() => {
    if (!rulesOpen || !isHost || oracleLimits) return
    let alive = true
    api
      .aiStatus()
      .then((status) => {
        if (alive) {
          oracleLimits = {
            questionsPerHour: status.questionsPerHour,
            slowModeSeconds: status.slowModeSeconds,
            agentSteps: status.agentSteps,
          }
        }
      })
      // Молча: пульт и без подсказки настраивается, а красная строка поверх
      // правил объясняла бы не то, что сломалось.
      .catch(() => {})
    return () => {
      alive = false
    }
  })

  /**
   * Один переключатель — один запрос.
   *
   * Присланное накладывается на текущее на сервере, а не заменяет его: экран,
   * трогающий одну строку, не должен уметь молча вернуть остальные семь к
   * умолчаниям. Ответ приходит и сюда, и всей комнате — рассылкой по
   * управляющему сокету, так что своё же изменение прилетит обратно тем же
   * путём, что и чужое.
   *
   * Причину отказа называет `ruleRefusal` (lib/rule-refusal.ts), а не
   * `err.message`: у `ApiError` фраза английская с обеих сторон — и запасная
   * («Could not reach the server…»), и тело маршрута («join the session
   * first»), — а комната русская целиком. Своей копии правила здесь нет
   * намеренно: слова живут одним куском рядом с `api.ts`, который их и
   * порождает.
   */
  async function setRule(patch: Partial<RoomRules>) {
    rulesBusy = true
    try {
      const body = await api.setRoomRules(session.session.id, identity.token, patch)
      session.session = { ...session.session, rules: body.rules }
    } catch (err) {
      session.showError(ruleRefusal(err))
    } finally {
      rulesBusy = false
    }
  }

  const RULES_NOTICE_MS = 6000
  let rulesNoticeUp = $state(false)
  $effect(() => {
    if (session.rulesChangedAt === 0) return
    rulesNoticeUp = true
    const timer = window.setTimeout(() => (rulesNoticeUp = false), RULES_NOTICE_MS)
    return () => window.clearTimeout(timer)
  })

  /* ------------------------------------------------------- конец занятия */

  /**
   * Закончить занятие — и открыть его обратно.
   *
   * Управляющим сокетом, а не запросом: правила комната узнаёт рассылкой по
   * нему же, и конец занятия должен приезжать той же дорогой и в том же
   * порядке. Своё нажатие вернётся сюда кадром `class`, как чужое, — поэтому
   * здесь ничего не записывается вперёд сервера.
   */
  function setClassOver(over: boolean): void {
    session.send({ t: over ? 'class:finish' : 'class:resume' })
  }

  /**
   * Когда занятие закончили — цифрами, которые человек помнит.
   *
   * Час, пока это сегодня, и день, когда нет: комнату открывают и через
   * неделю, а «закончено в 15:40» в такой вкладке врёт про день. Полная дата
   * остаётся в подсказке.
   */
  const finishedStamp = $derived.by(() => {
    const at = session.session.finishedAt
    if (at === null) return ''
    const when = new Date(at)
    const pad = (value: number) => String(value).padStart(2, '0')
    return when.toDateString() === new Date().toDateString()
      ? `${pad(when.getHours())}:${pad(when.getMinutes())}`
      : `${pad(when.getDate())}.${pad(when.getMonth() + 1)}`
  })
  const finishedLong = $derived.by(() => {
    const at = session.session.finishedAt
    if (at === null) return ''
    return tr('room.ui.957', { p0: new Date(at).toLocaleString(getLocale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', }) })
  })

  /*
   * Переход — одной строкой, и она уходит сама.
   *
   * По образцу строки про правила, и по метке, а не по сравнению с местной
   * переменной: у двадцати человек разом гаснут кнопки, и без единой фразы это
   * читается как поломка ноутбука, а не как конец пары.
   *
   * Метку ставит разбор кадра (`session.classChangedAt`) и молчит на первом
   * кадре соединения — поэтому вошедшему в давно законченную комнату строка не
   * всплывает: про это говорит чип в полосе состояния. Своё сравнение здесь
   * держаться не может: две смены признака подряд гасили таймер уборкой
   * эффекта и не заводили новый, и строка оставалась висеть до конца пары.
   */
  const CLASS_NOTICE_MS = 6000
  let classNoticeUp = $state(false)
  $effect(() => {
    if (session.classChangedAt === 0) return
    classNoticeUp = true
    const timer = window.setTimeout(() => (classNoticeUp = false), CLASS_NOTICE_MS)
    return () => window.clearTimeout(timer)
  })
  setSessionState(session)
  onDestroy(() => session.destroy())

  /*
   * Ключ этого браузера комната больше не признаёт — уступаем место форме
   * имени. Одной строкой и без вопросов: сокеты отсюда уже не поднимутся
   * никогда, а «Reconnecting» перед человеком, которому нечего ждать, — это
   * вечный спиннер.
   */
  $effect(() => {
    if (session.expired) onexpired?.()
  })

  const meta = watchNotebookMeta(session.doc)
  const storedTitle = $derived(meta.current.title)
  const title = $derived(storedTitle || info.name)
  const isHost = $derived(session.me.role === 'host')

  /**
   * Куда ведёт марка в шапке — и ведёт ли вообще.
   *
   * `/` — панель преподавателя, и только ему туда и надо. Участнику наверх
   * ведёт страница курса, если она есть: это единственный публичный адрес, где
   * его семинар стоит среди других. Ни того ни другого — марка не ссылка.
   */
  const homeHref = $derived(
    isHost ? '/' : session.session.course ? `/c/${session.session.course.id}` : null,
  )

  $effect(() => {
    document.title = `${title} · Colloq`
    return () => {
      document.title = 'Colloq'
    }
  })

  /* ------------------------------------------------------------- masthead */

  // DD.MM beside the seminar name, as the artboard sets it: in a room you are
  // standing in the year is noise. The full date stays in the tooltip.
  // Read once, like the session above: the router remounts this component when
  // the room changes, so a room's start date cannot change under it.
  // svelte-ignore state_referenced_locally
  const started = new Date(info.createdAt)
  const dateShort = `${String(started.getDate()).padStart(2, '0')}.${String(
    started.getMonth() + 1,
  ).padStart(2, '0')}`
  const dateLong = $derived(started.toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }))

  /*
   * People, not sockets. Keyed on the client id this counted a second tab as a
   * second student, so the bar could say "4 in the room" above a list of three
   * — with one of them printed twice. The participant id is also the steadier
   * face: it survives a reconnect, where the client id does not.
   */
  /*
   * A mark per seminar, in the tab bar.
   *
   * The grid is derived from the session id, so it is the same for everybody in
   * the room and the same next week; a teacher with back-to-back seminars open
   * can tell the tabs apart at 16px, which is the whole reason a logo is
   * allowed to change at all. Restored on the way out so the join screen and
   * the panel keep the brand's own mark.
   */
  $effect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) return
    const brand = link.getAttribute('href')
    link.setAttribute('href', gridFaviconHref(session.session.id))
    return () => {
      if (brand) link.setAttribute('href', brand)
    }
  })

  const inRoom = $derived(peopleInRoom(session.peers))
  /*
   * Лица в полосе — тем же массивом, пока рисовать нечего нового.
   *
   * `yCollab` объявляет положение курсора через присутствие на каждое движение
   * выделения: сто печатающих — сотни кадров в секунду, и каждый из них
   * пересобирал здесь массив из всех, кто в комнате, склеивал их имена в
   * `title` и будил стопку аватаров. От курсора не меняется ничего из того,
   * что здесь нарисовано: имя, метка, цвет и «(you)».
   *
   * Сравнение — без единой аллокации (screens/roster.ts), и при совпадении
   * возвращается ТОТ ЖЕ массив: Svelte сравнивает результат derived по
   * ссылке, так что всё, что ниже, просто не просыпается. Кадр присутствия всё
   * равно стоит одного прохода по списку — убрать это может только коалесинг
   * в самом `#readPeers` (см. handoff).
   */
  let faces: Face[] = []
  const room = $derived.by(() => {
    const people = inRoom
    return untrack(() => {
      if (!sameFaces(faces, people)) faces = people.map(faceOf)
      return faces
    })
  })
  /** Подсказка над стопкой: считается от `room`, то есть только на смену состава. */
  const roomNames = $derived(namesLine(room))

  /*
   * The live state of the machine, in the words the states sheet uses.
   *
   * The dot is the only coloured thing here: on the brand ground the label has
   * to stay white in both themes, because `danger` and `warning` are tuned for
   * the canvas and neither clears AA against navy. So the colour signals and
   * the word informs — which is also why a dead kernel gets a plate rather than
   * red type.
   */
  const KERNEL: Record<KernelStatus, { label: string; dot: string; alarm: boolean; why?: string }> = {
    /*
     * «НЕ ЗАПУЩЕНО» — не тревога и не обещание.
     *
     * Ядро поднимается лениво: у комнаты, которую только открыли, его нет, и
     * никто его не поднимает. До 20.09 это состояние показывалось как «ЗАПУСК»
     * — плашка часами обещала то, чего не происходило. Точка глуше остальных,
     * рамки нет, а `title` говорит, что делать: запустить ячейку или навести на
     * имя за справкой — оба жеста ядро и поднимают.
     */
    off: {
      get label() { return tr('room.kernel.state.off') },
      dot: 'bg-white/25',
      alarm: false,
      get why() { return tr('room.kernel.state.offWhy') },
    },
    starting: { get label() { return tr('room.kernel.state.starting') }, dot: 'bg-white/35', alarm: false },
    restarting: { get label() { return tr('room.kernel.state.restarting') }, dot: 'bg-white/35', alarm: false },
    idle: { get label() { return tr('room.kernel.state.idle') }, dot: 'bg-white/50', alarm: false },
    busy: { get label() { return tr('room.kernel.state.busy') }, dot: 'bg-accent', alarm: false },
    dead: { get label() { return tr('room.kernel.state.dead') }, dot: 'bg-danger', alarm: true },
  }


  /* ------------------------------------------------------------- layout */

  const PANELS_KEY = 'colloq.panels.v1'

  /*
   * Шапка лежит в той же коробке, что и панели, и это нарочно.
   *
   * Свёрнутая шапка — такая же настройка раскладки комнаты, как закрытая
   * панель файлов: её выбирают один раз на своей машине и ждут, что она
   * переживёт F5. Отдельный ключ означал бы вторую запись про одно и то же и
   * второе место, где её забывают почистить. Поле необязательное: у того, кто
   * закрывал панели до этой правки, в коробке нет `head` вовсе, и шапка ему
   * достаётся развёрнутой — то есть ровно та, что была.
   */
  function loadPanels(): { left: boolean; right: boolean; head: boolean } {
    try {
      const raw = localStorage.getItem(PANELS_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as { left?: boolean; right?: boolean; head?: boolean }
        return { left: saved.left !== false, right: saved.right !== false, head: saved.head !== false }
      }
    } catch {
      /* private browsing; the default layout is fine */
    }
    return { left: true, right: true, head: true }
  }

  const panels = loadPanels()
  let leftOpen = $state(panels.left)
  let rightOpen = $state(panels.right)
  let headOpen = $state(panels.head)
  let leftDrawer = $state(false)
  let rightDrawer = $state(false)

  // Narrow windows keep the notebook full width and show panels over it, so a
  // student on half a laptop screen still has somewhere to type.
  const AI_COLUMN = '(min-width: 1100px)'
  const SIDEBAR_COLUMN = '(min-width: 820px)'

  // Measured before the first paint so a narrow window never flashes columns.
  let wideEnough = $state(window.matchMedia(AI_COLUMN).matches)
  let roomyEnough = $state(window.matchMedia(SIDEBAR_COLUMN).matches)

  $effect(() => {
    const forAi = window.matchMedia(AI_COLUMN)
    const forSidebar = window.matchMedia(SIDEBAR_COLUMN)
    const sync = () => {
      wideEnough = forAi.matches
      roomyEnough = forSidebar.matches
    }
    sync()
    forAi.addEventListener('change', sync)
    forSidebar.addEventListener('change', sync)
    return () => {
      forAi.removeEventListener('change', sync)
      forSidebar.removeEventListener('change', sync)
    }
  })

  const leftIsDrawer = $derived(!roomyEnough)
  const rightIsDrawer = $derived(!wideEnough)

  /* ------------------------------------------------------------- читалка */

  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))

  /**
   * Что открыто в центре — тетрадь и файлы, которые открыли.
   *
   * Список своих вкладок живёт здесь, а не в каждом компоненте: вкладка
   * переживает уход в тетрадь и обратно, а место в документе и курсор в
   * редакторе теряются от размонтирования. Общий документ комнаты приходит
   * сбоку — от сервера — и встаёт в тот же ряд.
   */
  // svelte-ignore state_referenced_locally
  const tabs = new Tabs(info.id)
  const row = $derived(tabs.row(session.board, session.lecture?.file ?? null))
  /*
   * Вкладки, приколотые комнатой, — те же, из которых складывается `row`.
   *
   * Строка вкладок по ним решает, что можно двигать: порядок приколотых задаёт
   * комната, и переставить их себе значило бы завести у одного человека свой
   * порядок общего экрана.
   */
  const roomPinned = $derived(
    [session.board, session.lecture?.file ?? null].filter((path): path is string => !!path),
  )
  const activePath = $derived(typeof tabs.active === 'string' ? tabs.active : null)
  const activeKind = $derived(activePath ? kindOf(activePath) : null)

  /*
   * Заставке из index.html пора уходить — кроме одного случая.
   *
   * Комната рисуется из того, что браузер знает и без сети: шапка, рельсы,
   * вкладки. Ждать под заставкой стоит только тетрадь — единственное здесь,
   * что до первого кадра сокета пусто; о ней докладывает сама тетрадь
   * (Notebook.svelte · cold). Пульт, проекция, консилиум и открытый файл
   * ничего такого не ждут, и держать над ними заставку было бы враньём
   * (lib/boot.ts).
   */
  $effect(() => {
    if (mode !== 'room' || activeKind !== 'notebook') firstScreenReady()
  })

  /** Тетради комнаты: список живёт в документе и приходит ко всем. */
  const books = watchBooks(session.doc)

  /**
   * Тетради вместе с их доступом — то, из чего строка вкладок рисует метку и
   * наполняет меню «Доступ».
   *
   * Список тетрадей живёт в ДОКУМЕНТЕ (он общий и переживает перезагрузку), а
   * доступ — в ПРАВИЛАХ комнаты (он право, и права не носят в CRDT, где их
   * может переписать любой). Складываются они здесь, по корню: путь файла
   * переименовывают, корень — нет.
   */
  const bookBusy = watchBookBusy(session.doc)
  const bookTabs = $derived(
    books.current.map((book) => ({
      path: book.path,
      root: book.root,
      rule: roomRules.books?.[book.root] ?? null,
      // Ядро у каждой тетради своё: точка на вкладке говорит, что соседний
      // лист считает прямо сейчас, — иначе туда надо переключаться, чтобы
      // узнать, идёт ли ещё.
      busy: bookBusy.busy(book.root),
    })),
  )

  /**
   * Тетрадь, о чьём ядре говорит индикатор в шапке, — ОТКРЫТАЯ.
   *
   * Ядро у каждой тетради своё (server/src/kernel/index.ts), и «ГОТОВО» над
   * семинаром, пока лекция считает, — это правда про семинар, а не недосмотр.
   * Когда открыта не тетрадь (доска, .py, лекция), шапка говорит про тетрадь
   * комнаты: индикатор про занятие, а не про вкладку, и молчать ему нельзя.
   *
   * Стоит ПОСЛЕ списка тетрадей и вкладок намеренно: он их читает.
   */
  const openRoot = $derived(
    (activeKind === 'notebook' && activePath
      ? books.current.find((entry) => entry.path === activePath)?.root
      : books.current[0]?.root) ?? CELLS_KEY,
  )
  const openKernel = watchBookKernel(session.doc, () => openRoot)
  const kernel = $derived(KERNEL[openKernel.current.kernelStatus])

  /*
   * Почему Python комнаты не поднялся — совет ведущему, и только ему.
   *
   * Pod комнаты на k3s не встаёт, когда узлу нечего дать: память каждой
   * комнаты зарезервирована целиком. Студент видит в ячейке и журнале ядра
   * короткое «на сервере нет места, преподаватель видит причину», а исправить
   * это может только тот, кто меняет память комнат, — ему здесь сказано, что
   * именно уменьшить. Висит, пока ядро мертво по этой причине; закрытый
   * крестиком возвращается только с новым советом (другое число, другой ресурс).
   */
  const kernelAdvice = $derived(
    isHost && openKernel.current.kernelStatus === 'dead' && openKernel.current.kernelProblem
      ? kernelProblemAdvice(openKernel.current.kernelProblem)
      : null,
  )
  let adviceDismissed = $state<string | null>(null)
  const adviceUp = $derived(kernelAdvice !== null && kernelAdvice !== adviceDismissed)

  /**
   * Сменить доступ к одной тетради.
   *
   * Тем же путём, каким меняются все прочие правила комнаты (`setRule` выше, то
   * есть PATCH /api/sessions/:id/rules): доступ к тетради ЖИВЁТ в правилах,
   * и второй двери у него нет — а значит нет и второго места, где забудут
   * спросить роль. Сервер всё равно спрашивает её сам.
   */
  function setBookAccess(root: string, access: BookAccess): void {
    void setRule(accessPatch(roomRules, root, access))
  }

  /** Что читалка сообщает наружу: строка вкладок показывает это за неё. */
  let readerPage = $state(1)
  let readerPages = $state(0)
  /**
   * Идём ли за ведущим прямо сейчас — по мнению самой читалки.
   *
   * Одного номера страницы для строки вкладок мало: отстать можно и не сменив
   * страницу, одной прокруткой в пределах листа. Пока признак сюда не доходил,
   * строка писала «Идём за Анной» тому, кто уже отстал по своей воле, — а
   * читалка строкой ниже честно говорила «смотрите сами».
   */
  let readerFollowing = $state(true)
  let lead = $state<Lead | null>(null)
  /** Ведущий был и пропал — не то же самое, что «ведущего нет». */
  let orphaned = $state(false)
  /** За кем шли до сих пор: пока он на месте, ведущего не меняют. */
  let sticky = $state<number | null>(null)

  /**
   * Документ, по которому вообще есть за кем идти.
   *
   * Тот, что открыт сейчас, — или, если человек ушёл в тетрадь, общий документ
   * комнаты: метка «преподаватель на стр. 4» на вкладке должна оставаться живой
   * и из тетради, иначе о том, что лекция уехала, узнаёшь, только
   * переключившись.
   */
  const followFile = $derived(
    activeKind === 'pdf'
      ? activePath
      : session.board && kindOf(session.board) === 'pdf'
        ? session.board
        : null,
  )

  /*
   * Ведущий пересчитывается на каждое изменение присутствия — но записывается,
   * только если правда изменился: `leaderFor` собирает новый объект каждый раз,
   * а эффект пишет то же состояние, которое читает.
   */
  $effect(() => {
    const peers = session.peers
    const file = followFile
    if (!file) {
      // Смотреть нечего — и «преподаватель вышел» тут значило бы сообщать о
      // событии, которого не было.
      if (untrack(() => lead) !== null) lead = null
      if (untrack(() => sticky) !== null) sticky = null
      if (untrack(() => orphaned)) orphaned = false
      return
    }
    const next = leaderFor(
      peers,
      file,
      untrack(() => sticky),
    )
    if (sameLead(untrack(() => lead), next)) return
    lead = next
    if (next) sticky = next.clientId
    // «Был и пропал» — а не «его нет».
    orphaned = next === null && untrack(() => sticky) !== null
  })
  /** Нажатия «догнать» — счётчиком: догонять можно и дважды подряд. */
  let catchUp = $state(0)

  /* ------------------------------------------------------------- лекция */

  /**
   * Идёт ли лекция по тому, что открыто сейчас.
   *
   * Лекция всегда стоит и на общем экране — это одно и то же решение, принятое
   * сервером (см. `lecture:start`), — поэтому вкладка на неё есть у всех, и
   * специально открывать её никому не нужно.
   */
  const lecture = $derived(session.lecture)
  const leading = $derived(lecture !== null && lecture.by === session.me.id)
  const lectureHere = $derived(lecture !== null && lecture.file === activePath)

  /**
   * «Читать самому».
   *
   * Лекция показывает всем одну страницу — ту, на которой ведущий. Но комната,
   * где студент не может отлистнуть назад и перечитать формулу, — это
   * трансляция экрана, а не семинар, и весь продукт устроен наоборот: за
   * преподавателем ИДУТ, а не привязаны к нему. Поэтому выйти в обычную читалку
   * можно одним нажатием — и вернуться тем же.
   *
   * Сбрасывается со сменой лекции: следующая начинается общей для всех.
   */
  let soloRead = $state(false)
  $effect(() => {
    void lecture?.file
    untrack(() => (soloRead = false))
  })

  /**
   * Уйти на проекцию и вернуться.
   *
   * Адресом, а не флагом: проекцию открывают на машине у проектора, её ссылку
   * кладут в закладки, и она обязана пережить перезагрузку. Полный экран
   * просится ровно здесь, из живого нажатия, — из эффекта после навигации
   * браузер его не даёт.
   */
  /**
   * На проектор — ОТДЕЛЬНЫМ окном, а не этой же вкладкой.
   *
   * Проекция уходила в ту же вкладку, и комната на этом компьютере
   * заканчивалась: чтобы показать ячейку, преподаватель выходил с проектора.
   * Окно — это то, что кладут на второй монитор и отдают в Zoom как «экран»,
   * пока в первом окне продолжается работа. Имя окна — чтобы второе нажатие
   * находило уже открытое, а не плодило проекции. Полный экран в новом окне
   * просит само окно по первому нажатию в нём: жест из этого окна туда не
   * переносится, а без жеста браузер полный экран не даёт.
   *
   * Всплывающие окна бывают запрещены — тогда, как раньше, уходим сами.
   */
  function toProjection(): void {
    const url = `/s/${session.session.id}/screen`
    const opened = window.open(url, `colloq-screen-${session.session.id}`, 'popup=yes,width=1280,height=720')
    if (opened) {
      opened.focus()
      return
    }
    void goFullscreen(document.documentElement)
    onnavigate?.(url)
  }

  function fromProjection(): void {
    void leaveFullscreen()
    // Окно, открытое из комнаты, закрывается; вкладка, в которую пришли по
    // адресу, возвращается в комнату.
    if (window.opener) window.close()
    if (!window.closed) onnavigate?.(`/s/${session.session.id}`)
  }

  /*
   * Escape уводит с проекции. Первым нажатием браузер закрывает полный экран
   * сам и до страницы событие не доводит — поэтому на балке Escape нажимают
   * дважды, и это ровно то, что нужно: случайное нажатие не гасит лекцию.
   */
  $effect(() => {
    if (!projection) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') fromProjection()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  })

  /* ---------------------------------------------------------------- пульт */

  /**
   * Экран не гаснет, пока стоит пульт или проекция.
   *
   * Автоблокировка iPad по умолчанию — две минуты, а преподаватель говорит
   * дольше; у ноутбука с проектором та же беда под другим именем — заставка.
   * Оба экрана существуют ровно для того, чтобы на них смотрели, ничего при
   * этом не нажимая, — то есть ровно для того случая, который система считает
   * бездействием.
   *
   * Держится по режиму, а не по нажатию: жеста этот API не требует, а брать
   * блокировку на входе и забывать отпустить — значит держать экран включённым
   * в комнате, где она не нужна. Отпускается возвратом эффекта, то есть на
   * уходе с экрана и на размонтировании.
   *
   * Отказ здесь молча: сказать о нём есть кому только на пульте — там для этого
   * своя строка в верхней нити, и пульт просит блокировку сам (две блокировки
   * на один документ независимы, экран не гаснет, пока держат хоть одну). На
   * проекции читателей двадцать, и предупреждение «экран может погаснуть» на
   * весь зал — это шум, который никто из зала всё равно не починит.
   */
  $effect(() => {
    if (mode === 'room') return
    return keepAwake(() => {})
  })

  /**
   * Уйти из пульта.
   *
   * Лекцию это НЕ останавливает и останавливать не должно: пульт — это руки, а
   * не сама лекция, и человек, заглянувший в тетрадь показать ячейку, не
   * закончил пару. Но исчезнувший пульт нужно объяснить — иначе тот, кто
   * промахнулся мимо кнопки, будет искать, куда делась лекция, вместо того
   * чтобы вернуться одним нажатием.
   */
  const PULT_NOTICE_MS = 6000
  let pultNoticeUp = $state(false)

  function leavePult(): void {
    if (lecture !== null && leading) pultNoticeUp = true
    onnavigate?.(`/s/${session.session.id}`)
  }

  function toPult(): void {
    pultNoticeUp = false
    onnavigate?.(`/s/${session.session.id}/pult`)
  }

  $effect(() => {
    if (!pultNoticeUp) return
    const timer = window.setTimeout(() => (pultNoticeUp = false), PULT_NOTICE_MS)
    return () => window.clearTimeout(timer)
  })

  /*
   * Свайп от левой кромки — это «назад» в истории Safari, и выключить его на
   * iPad нельзя ничем. У пульта левая кромка — это рука, которой планшет
   * держат: пролистнуть лекцию назад одним неверным миллиметром и оказаться в
   * комнате с вкладками и оракулом — вопрос времени.
   *
   * Поэтому по `popstate` возвращаемся на пульт — но только в одном случае:
   * лекцию ведёт ЭТОТ человек с ЭТОГО устройства, и ушли мы в свою же комнату.
   * За пределы комнаты не держим вовсе. Капкан, из которого не выйти «назад»,
   * дороже случайного выхода, а настоящий выход есть и он видимый — «В комнату»
   * в «Ещё».
   *
   * Слушатель App'а срабатывает раньше нашего и уже поставил новый путь;
   * `onnavigate` кладёт поверх него запись пульта, так что и следующее «назад»
   * приводит сюда же.
   */
  $effect(() => {
    if (!pult || lecture === null || !leading) return
    const room = `/s/${session.session.id}`
    const back = () => {
      if (location.pathname === room || location.pathname === `${room}/`) {
        onnavigate?.(`${room}/pult`)
      }
    }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  })

  /*
   * Документ появился на общем экране — комната смотрит его: это и есть
   * «началась лекция». Пропал — все возвращаются в тетрадь, потому что
   * смотреть больше нечего. Сравнение с прошлым значением, а не просто
   * чтение: иначе переключение вкладкой тут же отменялось бы этим же эффектом.
   */
  let lastBoard: string | null = null
  $effect(() => {
    const now = session.board
    if (now === lastBoard) return
    const was = lastBoard
    lastBoard = now
    if (now) tabs.show(now)
    else if (untrack(() => tabs.active) === was) tabs.show(null)
  })

  /*
   * Место в документе живёт, пока документ вообще открыт, — а не пока на него
   * смотрят.
   *
   * Разница ровно в одном случае, и он самый частый: преподаватель ушёл в
   * тетрадь показать ячейку. Он никуда не «выходил» из лекции, и комната должна
   * по-прежнему видеть на вкладке «Ада на стр. 4» — иначе о том, что лекция
   * уехала дальше, узнаёшь, только переключившись. Читалка этого сделать не
   * может: она размонтируется вместе с переключением вкладки.
   */
  $effect(() => {
    if (!followFile) session.setViewing(null)
  })

  /*
   * Пока идёт лекция, «кто где» по этому документу не считается вовсе.
   *
   * Место в документе нужно, чтобы за человеком можно было ПОЙТИ; во время
   * лекции идти некуда — страница одна на всех и приезжает от ведущего. Метка
   * «преподаватель на стр. 4» рядом с лекцией была бы вторым источником той же
   * правды, и он бы врал: у ведущего читалки нет, и последнее, что он успел
   * сообщить, — это страница, на которой он стоял до начала лекции. Заодно
   * гаснет счётчик в строке вкладок: во время лекции номер живёт в её полосе.
   */
  $effect(() => {
    if (!lectureHere || soloRead) return
    session.setViewing(null)
    readerPage = 1
    readerPages = 0
  })

  /*
   * Как показать ячейку, где бы она ни лежала.
   *
   * Ставится один раз: ссылки на ячейки приходят из панели людей и из треда
   * оракула, и обе не знают ни про вкладки, ни про тетради.
   */
  session.showCell = (cellId: string) => {
    const root = rootOfCell(session.doc, cellId)
    if (!root) return
    const book = books.current.find((entry) => entry.root === root)
    /*
     * Открыть, а не показать: тетрадей в комнате несколько, и та, в которой
     * лежит ячейка, у этого человека может быть не открыта вовсе — внёс её
     * преподаватель, а сам он её не трогал. `show` в этом случае ставил
     * активной вкладку, которой нет в ряду: центр экрана пустел, ни одна
     * вкладка не подсвечивалась, и «покажи, где он» оказывалось кнопкой,
     * которая врёт.
     */
    if (book) tabs.open(book.path)
  }

  /*
   * Выделение переживало собственные ячейки.
   *
   * Ячейку можно удалить — свою и чужую, — а выделение до сих пор оставалось
   * указывать на неё: чип оракула гас, а Shift+Enter отправлял запуск мёртвой
   * ячейки. Проверяется по всем тетрадям комнаты сразу, потому что выделение
   * одно на человека, а тетрадей несколько.
   */
  const everyCell = watchCellNumbers(session.doc)

  /**
   * Консилиумы, идущие сейчас, — для проектора: пока класс пишет, счёт «N сдали
   * из M»; как только преподаватель вывел чей-то вариант — этот вариант, с
   * подписью.
   *
   * Чужих попыток здесь по-прежнему нет: стопку видит один преподаватель. На
   * полосу едет РОВНО ОДНА — та, которую он сам решил показать залу (кадр
   * `council:shown`, он же приходит всей комнате плашкой под ячейкой). Раньше
   * показанное ложилось в общий текст ячейки и на экране оказывалось
   * анонимным: зал читал решение и не знал, чьё оно; полоса под ним считала
   * сдавших, будто показа и не было.
   *
   * Имя в подписи решает ручка `namesOnProjector` — и решает на СЕРВЕРЕ: при
   * выключенной имени в кадре нет вовсе, и подписывает «Вариант N»
   * (shared/protocol.ts · CouncilShown). Здесь его просто рисуют.
   *
   * Замок читается из документа на каждый пересчёт, а пересчёт заказывают
   * счётчики (сокет) и нумерация ячеек (документ): консилиум, который закрыли,
   * сходит с полосы вместе с ближайшим кадром счётчика. Своего наблюдателя на
   * каждую ячейку проектор не заводит — ему это и не по чину, и не по цене.
   */
  const councilsOnAir = $derived.by(() => {
    const out: {
      cellId: string
      ordinal: string
      count: CouncilCount
      shown: CouncilShown | null
    }[] = []
    const numbers = everyCell.current
    for (const [cellId, count] of Object.entries(session.council.counts)) {
      const found = findCell(session.doc, cellId)
      if (!found || cellLock(found.cell) !== 'council') continue
      const number = numbers.get(cellId)
      out.push({
        cellId,
        ordinal: number === undefined ? '' : String(number).padStart(2, '0'),
        count,
        shown: session.council.shown[cellId] ?? null,
      })
    }
    return out
  })
  $effect(() => {
    const alive = everyCell.current
    untrack(() => {
      const kept = session.selection.filter((id) => alive.has(id))
      if (kept.length !== session.selection.length) {
        session.selection = kept
        if (session.selectedCellId && !alive.has(session.selectedCellId)) {
          session.selectCell(kept.at(-1) ?? null)
        }
      }
    })
  })

  /*
   * Файл, который правит этот человек, — комнате. Панель файлов рисует по нему
   * точки «кто здесь», а полоса над редактором — имена.
   */
  $effect(() => {
    // И тетрадь тоже: «кто здесь» в дереве отвечает на один вопрос — не правит
    // ли этот файл кто-то ещё прямо сейчас, — и для тетради он тот же самый.
    session.setEditing(activeKind === 'text' || activeKind === 'notebook' ? activePath : null)
  })

  /*
   * Комната ответила — вкладки становятся на места.
   *
   * Первый прогон возвращает человека туда, где он был до перезагрузки (или
   * открывает тетрадь тому, кто здесь впервые), дальше — прополка: вкладка на
   * файл, которого больше нет, — пустая область без объяснения, а файл мог
   * убрать преподаватель и мог переписать `os.remove` в ячейке. Решает всё
   * `Tabs.settle`, здесь только собирается то, из чего оно решает.
   */
  $effect(() => {
    /*
     * И только когда список правда приезжал.
     *
     * «Не спрашивали ещё» и «файлов нет» — разные вещи, а на первом кадре они
     * выглядели одинаково: `files` пуст до ответа сервера, документ ещё не
     * переигран с диска, и первый же прогон этого эффекта выбрасывал все
     * запомненные вкладки и записывал в хранилище пустой список. Обещание
     * «свои вкладки переживают перезагрузку» не выполнялось ни разу: каждый
     * F5 у каждого участника оставлял пустой центр.
     */
    if (!session.filesArrived || !session.hydrated) return
    const alive = new Set(session.files.filter((file) => !file.dir).map((file) => file.path))
    /*
     * Тетради — по списку комнаты, а не по списку файлов.
     *
     * Файл тетради пишется проекцией через секунду после правки, а сама тетрадь
     * существует в комнате сразу. Пока список файлов не догнал, вкладка на неё
     * закрывалась бы у всех — и первым делом у того, кто только что вошёл: его
     * тетрадь открывается раньше, чем её файл появляется на диске.
     */
    for (const book of books.current) alive.add(book.path)
    // Общий экран читается здесь же: он приезжает с того же сокета, что и
    // список файлов, и кто из них первый — не угадать. Придёт позже —
    // подхватит эффект доски ниже; успел раньше — комната смотрит его, и
    // возвращение в свою тетрадь у неё экран не отнимает.
    const board = session.board
    const firstBook = books.current[0]?.path ?? null
    /*
     * И признак обрезки — вместе со списком.
     *
     * «Файла в списке нет» и «файл не влез в список» выглядят отсюда
     * одинаково, а значат противоположное: обход папок упирается в потолок
     * (server/src/workspace.ts · MAX_ENTRIES), и студент, распаковавший
     * датасет на три тысячи файлов, закрывал бы вкладки всей комнате. Прополка
     * идёт только по полному списку — решает это `Tabs`, здесь только
     * передаётся то, из чего оно решает.
     */
    const truncated = session.filesTruncated
    untrack(() => tabs.settle({ alive, firstBook, board, truncated }))
  })

  /*
   * Прогрев по факту, а не на каждый вход в комнату: библиотека и воркер — это
   * полтора мегабайта, и платить за них должен тот, у кого правда есть что
   * открывать.
   */
  $effect(() => {
    if (session.files.some((file) => !file.dir && kindOf(file.path) === 'pdf')) {
      void loadPdf()
    }
  })

  /* --------------------------------------------------- документы файлов */

  /**
   * Документы открытых текстовых файлов.
   *
   * Держатся для ВСЕХ открытых вкладок, а не только для текущей: соединение
   * поднимается за сотню миллисекунд, но вместе с ним пересобирается история
   * отмен, и переключение между двумя файлами туда-обратно стирало бы Ctrl+Z в
   * обоих. Пять открытых файлов — пять сокетов; семинар, где не открыли ни
   * одного, держит ровно те два, что держал всегда.
   */
  let docs = $state<Record<string, FileDoc>>({})

  $effect(() => {
    const want = new Set(
      row.filter(
        (key): key is string => typeof key === 'string' && kindOf(key) === 'text',
      ),
    )
    untrack(() => {
      for (const path of want) {
        if (!docs[path]) docs[path] = holdFile(session.session.id, path, session.token)
      }
      for (const path of Object.keys(docs)) {
        if (want.has(path)) continue
        releaseFile(session.session.id, path)
        delete docs[path]
      }
    })
  })

  onDestroy(() => {
    for (const path of Object.keys(docs)) releaseFile(session.session.id, path)
    docs = {}
  })

  const activeDoc = $derived(activePath && activeKind === 'text' ? docs[activePath] : undefined)

  /*
   * Файл, который сервер закрыл с 4404, исчез с диска между списком и
   * открытием — гонка узкая и вполне обычная: преподаватель убрал файл ровно в
   * ту секунду, когда студент по нему нажал.
   */
  $effect(() => {
    const doc = activeDoc
    if (doc?.missing && activePath) {
      // С теми же приколотыми вкладками, что нарисованы: соседа слева считают
      // по ряду, и ряд без лекции сдвинул бы человека не туда.
      tabs.close(activePath, session.board, session.lecture?.file ?? null)
    }
  })

  /**
   * Закрыть вкладку.
   *
   * Свою закрывает кто угодно; документ, стоящий на общем экране, убирает тот,
   * кому это разрешено, — и убирает у всех сразу. Если права нет, а документ
   * общий, уйти от него в тетрадь всё равно можно: смотреть никого не
   * заставляют, а вкладка остаётся стоять.
   *
   * Пока идёт лекция, крестик не убирает документ ни у кого: лекцию
   * заканчивают явным «Закончить», и сервер `board:close` в это время всё
   * равно отвергает словами. Крестик на её вкладке — это «уйти отсюда», и
   * сорок минут разметки на проекторе не должны зависеть от промаха мимо
   * соседней вкладки.
   */
  function closeTab(path: string): void {
    if (path === session.board && may.board && lecture === null) {
      session.send({ t: 'board:close' })
      tabs.show(null)
      return
    }
    tabs.close(path, session.board, session.lecture?.file ?? null)
  }

  /**
   * Поставить документ на общий экран комнаты.
   *
   * Отдельное действие, а не побочный эффект открытия файла: право `board` —
   * про общий экран, а не про чтение («смотреть и листать у себя может любой
   * всегда», см. `rule-rows.ts` и обработчик на сервере).
   *
   * Полоса с кнопкой держится до прихода общего документа, а не гаснет по
   * нажатию: ответ идёт круг, и отказать сервер тоже умеет («такого файла в
   * комнате нет»). Кнопка, исчезнувшая раньше ответа, оставила бы человека без
   * второй попытки.
   *
   * Активной вкладка становится только та, что уже нарисована в ряду. Файл,
   * которого у себя ещё нет, приедет вкладкой вместе с ответом — тем же
   * кадром, что и у всех; поставить его активным раньше значило бы показать
   * пустой центр на круг сети, а при отказе — навсегда.
   */
  function showToRoom(path: string): void {
    session.send({ t: 'board:open', name: path })
    if (row.includes(path)) tabs.show(path)
  }

  /**
   * Открыть файл из панели.
   *
   * PDF у преподавателя уезжает на общий экран комнаты — это лекция, её смотрят
   * вместе. Всё остальное открывается себе: у скрипта нет «общего экрана», его
   * правят и запускают, а кто рядом — видно по точкам в дереве.
   *
   * У преподавателя — и только у него. В комнате, где правило `board` отдано
   * всем (семинар, где студенты по очереди показывают своё), клик любого
   * студента по методичке забирал экран у тридцати человек: вкладка прыгала у
   * всех, а прочитать что-то у себя было нельзя вовсе — то есть право не
   * добавляло возможность, а отнимало. Студент открывает себе, а показать
   * комнате может кнопкой над читалкой.
   *
   * И не во время лекции: пока она идёт, общий экран занят ею, сервер смену
   * документа отвергает словами («Идёт лекция по «…» — сначала закончите её»),
   * и щелчок по файлу в панели превращался бы в отказ на ровном месте. Открыть
   * себе можно всегда — этим же щелчком.
   */
  function openFile(path: string): void {
    if (kindOf(path) === 'pdf' && may.board && isHost && lecture === null) {
      showToRoom(path)
      return
    }
    /*
     * .ipynb, который ещё не тетрадь, надо сперва внести в комнату: ячейки
     * переезжают из файла в документ, и это делает сервер один раз, а не
     * двадцать браузеров наперегонки. Вкладка открывается сразу и до прихода
     * тетради говорит «открываю» — это честнее, чем не реагировать на нажатие.
     */
    if (kindOf(path) === 'notebook' && !books.current.some((book) => book.path === path)) {
      /*
       * И только если внести её вообще можно: внесение — это ДОБАВЛЕНИЕ
       * тетради в комнату, у него своё правило (shared/rules.ts · ownBooks), и
       * сервер на это же ответит отказом. Без проверки вкладка открывалась бы
       * навсегда с «открываю»: тетради не появится, и закрывать нечего.
       */
      if (!may.ownBook) {
        session.showError(may.ownBookWhy)
        return
      }
      session.send({ t: 'book:open', path })
    }
    tabs.open(path)
  }

  function runFile(path: string): void {
    session.send({ t: 'file:run', path })
    // Вывод идёт в терминал, и открыть его — часть запуска: иначе нажатие
    // выглядит как ничего не сделавшее.
    terminalOpen = true
    drawerTab = 'terminal'
  }

  const leftShown = $derived(leftIsDrawer ? leftDrawer : leftOpen)
  const rightShown = $derived(rightIsDrawer ? rightDrawer : rightOpen)

  // Returning to a wide window must not leave a stale overlay hanging around.
  $effect(() => {
    if (!leftIsDrawer) leftDrawer = false
  })
  $effect(() => {
    if (!rightIsDrawer) rightDrawer = false
  })

  function persistPanels(): void {
    try {
      localStorage.setItem(
        PANELS_KEY,
        JSON.stringify({ left: leftOpen, right: rightOpen, head: headOpen }),
      )
    } catch {
      /* ignore */
    }
  }

  /**
   * Свернуть и развернуть верхнюю полосу шапки.
   *
   * Без ветки «а на узком экране иначе», как у панелей: шапка нигде не
   * становится выдвижным ящиком — она просто есть или её нет, и на телефоне
   * это нужнее всего, потому что 110 px из 640 там стоят дороже.
   */
  function toggleHead(): void {
    headOpen = !headOpen
    persistPanels()
  }

  function toggleLeft(): void {
    if (leftIsDrawer) {
      leftDrawer = !leftDrawer
      return
    }
    leftOpen = !leftOpen
    persistPanels()
  }

  function toggleRight(): void {
    if (rightIsDrawer) {
      rightDrawer = !rightDrawer
      return
    }
    rightOpen = !rightOpen
    persistPanels()
  }

  /* ------------------------------------------------------------ terminal */

  let terminalOpen = $state(false)
  /*
   * Which surface the drawer is showing. Lives here rather than in the drawer
   * because the drawer is unmounted when it closes, and a teacher who closes
   * the panel to look at a cell should come back to what they were reading.
   */
  let drawerTab = $state<'terminal' | 'kernel' | 'history'>('terminal')
  // The session holds the unread count; only this screen knows whether anybody
  // is looking at the transcript.
  $effect(() => session.setTerminalOpen(terminalOpen))

  /*
   * «Покажи, где он» из списка людей.
   *
   * Строка про человека давно знала, где он — «правит ячейку 04», «в
   * терминале», — но никуда не вела: увидеть было можно, дойти нельзя.
   * Обрабатывается здесь, потому что две трети мест это панели, а панелями
   * распоряжается этот экран и никто больше.
   */
  $effect(() => {
    const onReveal = (event: Event) => {
      const target = (event as CustomEvent<RevealTarget>).detail
      if (!target) return
      // На узком экране левая панель лежит поверх ноутбука: не убрать её
      // значит привести человека к ячейке, которую он не увидит.
      if (leftIsDrawer) leftDrawer = false
      if (target.where === 'cell') {
        revealCell(session, target.cellId)
        return
      }
      if (target.where === 'file') {
        /*
         * Вкладкой, а не `openFile`.
         *
         * `openFile` — жест из панели файлов, и он про КОМНАТУ: PDF у
         * преподавателя уезжает оттуда на общий экран, а .ipynb сперва вносится
         * в комнату кадром `book:open`. Переход к определению — чтение себе: он
         * не должен ни отнимать у зала экран, ни заводить в комнате тетрадь
         * из-за того, что кто-то щёлкнул по имени с зажатым Cmd.
         *
         * Определение бывает только в .py, то есть ветка с PDF не сработала бы
         * и так, — но правило «переход ничего не показывает комнате» должно
         * держаться на решении здесь, а не на том, что сервер сегодня отвечает
         * именно про .py-файлы.
         *
         * Уже открытую вкладку `Tabs.open` просто делает текущей: второй такой
         * же в ряду не появляется, и место в файле при этом не теряется — его
         * помнит lib/goto.svelte.ts, и читает его сам редактор файла.
         *
         * Файла может уже не быть — его убрали между ответом сервера и щелчком.
         * Отдельной проверки здесь нет намеренно: «есть ли такой файл» этот
         * экран решает один раз и в одном месте (`tabs.settle` выше и `doc.missing`
         * рядом с ним), а вторая, более слабая копия того же суждения врала бы
         * на обрезанном списке файлов (`filesTruncated`) — то есть закрывала бы
         * переход тому, у кого в папке три тысячи файлов.
         */
        tabs.open(target.path)
        return
      }
      if (target.where === 'terminal') {
        drawerTab = 'terminal'
        if (!terminalOpen) toggleTerminal()
        return
      }
      if (rightIsDrawer) rightDrawer = true
      else if (!rightOpen) {
        rightOpen = true
        persistPanels()
      }
    }
    window.addEventListener(REVEAL_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_EVENT, onReveal)
  })

  /*
   * «Спросить оракула» из ячейки, когда панели оракула на экране нет.
   *
   * Единственный слушатель этого события живёт внутри AiPanel, а панель есть
   * только при открытой правой колонке — то есть на экране шире 1100px или в
   * выдвижном ящике. Под проектором с зумом кнопка «Fix with AI» под
   * трейсбеком нажималась в пустоту: ни спиннера, ни ошибки, ни вопроса.
   *
   * Этот слушатель открывает панель и пересылает событие ей — уже
   * смонтированной. Он стоит перед ней в очереди только когда её нет.
   */
  $effect(() => {
    const onAsk = (event: Event) => {
      if (rightShown) return
      const detail = (event as CustomEvent).detail
      if (rightIsDrawer) rightDrawer = true
      else {
        rightOpen = true
        persistPanels()
      }
      // Следующим кадром: панель должна смонтироваться и повесить свой
      // слушатель, иначе вопрос уйдёт снова в пустоту.
      requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent('colloq:ask-ai', { detail })),
      )
    }
    window.addEventListener('colloq:ask-ai', onAsk)
    return () => window.removeEventListener('colloq:ask-ai', onAsk)
  })

  function toggleTerminal(): void {
    terminalOpen = !terminalOpen
    // The shell belongs to the room, so ask for one only when nobody has
    // started it yet; reopening my own drawer must never restart a live shell.
    const status = session.terminalStatus
    /*
     * Ящик открывается всегда — лента общая, и читать её после пары как раз и
     * приходят, — а вот будить оболочку после конца занятия участнику нельзя.
     * Правилом это не выражается, поэтому та же `actsAfterClass`, по которой
     * решает сервер: он такую просьбу не исполнит и отказа не пришлёт. Без
     * этой проверки открытый почитать ящик поднимал бы уснувший контейнер —
     * молча и от имени того, кто ни о чём не просил.
     */
    if (
      terminalOpen &&
      (status === 'closed' || status === 'dead') &&
      actsAfterClass(may.finished, session.me.role)
    ) {
      session.send({ t: 'term:open' })
    }
  }

  /* ------------------------------------------------- палитра и клавиатура */

  /**
   * Строка оракула — под курсором, а не под мышью.
   *
   * Панель может быть закрыта или лежать ящиком; открыть её мало — спрашивать
   * всё равно некуда, пока фокус не в поле. Поле помечено атрибутом в AiPanel
   * (см. handoff): искать его по `aside textarea` значило бы завязаться на
   * вёрстку чужой панели.
   */
  function focusOracle(): void {
    if (rightIsDrawer) rightDrawer = true
    else if (!rightOpen) {
      rightOpen = true
      persistPanels()
    }
    // Следующим кадром: панель ещё монтируется.
    requestAnimationFrame(() => {
      const line =
        document.querySelector<HTMLTextAreaElement>('[data-oracle-composer]') ??
        // Пока метки на самом поле нет — по колонке, которую этот экран и
        // рисует: строка ввода в панели оракула ровно одна.
        document.querySelector<HTMLTextAreaElement>('[data-oracle-panel] textarea')
      line?.focus()
    })
  }

  /**
   * Палитра команд — по требованию и снимком.
   *
   * Чанк отдельный по той же причине, что и у пульта: список нужен тому, кто
   * нажал ⌘K, а не каждому, кто вошёл в комнату. Список собирается в момент
   * открытия и дальше не живёт: пока человек читает его, чужой Run не должен
   * переставлять строки под курсором выбора.
   */
  let paletteOpen = $state(false)
  // raw: список заменяется целиком и никогда не правится по месту, а глубокий
  // $state завернул бы в прокси каждую из сотен строк ради этого.
  let paletteList = $state.raw<PaletteItem[]>([])
  let paletteChunk: Promise<
    typeof import('@/components/ui/CommandPalette.svelte').default
  > | null = null
  const paletteView = () =>
    (paletteChunk ??= import('@/components/ui/CommandPalette.svelte').then((m) => m.default))

  /** Первая непустая строка ячейки — то, по чему её узнают в списке. */
  function cellLine(cellId: string): string {
    const found = findCell(session.doc, cellId)
    if (!found) return ''
    // `cell.get`, а не `cellSource`: тот заводит пустой Y.Text, если его нет, —
    // то есть правит общий документ ради подписи в списке.
    const source = found.cell.get('source') as { toString(): string } | undefined
    const text = source ? source.toString() : ''
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed
    }
    return ''
  }

  $effect(() => onLanguageChange(() => { if (paletteOpen) paletteList = paletteItems() }))

  function paletteItems(): PaletteItem[] {
    const out: PaletteItem[] = []
    const live = session.connected
    const book = activeKind === 'notebook' && activePath ? activePath : (books.current[0]?.path ?? null)
    /*
     * Права — по ТОЙ тетради, в которую уедут «Запустить всё», «Очистить
     * выводы» и «Форматировать»: у неё может быть свой доступ, и комнатный
     * ответ здесь либо прятал бы действия в собственной тетради студента, либо
     * предлагал бы их в чужой личной — чтобы сервер отказал.
     */
    const here = permitsIn(session.session.rules, session.me.role, session.finished, {
      root: books.current.find((entry) => entry.path === book)?.root ?? null,
      participantId: session.me.id,
    })

    /* Действия — первыми: их ищут словом, а ячейки номером. */
    const act = (
      id: string,
      label: string,
      allowed: boolean,
      run: () => void,
      hint?: string,
      keywords?: string,
    ) => {
      if (allowed) out.push({ id, get group() { return tr('room.ui.960') }, label, hint, keywords, run })
    }
    act(
      'run-all',
      tr('room.ui.961'),
      live && here.run && here.bulk && book !== null,
      () => session.send({ t: 'runAll', book: book ?? undefined }),
      undefined,
      "run all выполнить",
    )
    act(
      'interrupt',
      tr('room.ui.964'),
      live && may.run,
      // Лист называется, как и у соседних строк: очередей столько же, сколько
      // тетрадей, и безымянное нажатие разобрало бы чужую.
      () => session.send({ t: 'interrupt', book: book ?? undefined }),
      undefined,
      "interrupt stop прервать",
    )
    act(
      'clear',
      tr('room.ui.966'),
      live && may.wipe && book !== null,
      () => session.send({ t: 'clearOutputs', book: book ?? undefined }),
      undefined,
      "clear outputs очистить",
    )
    act(
      'format',
      tr('room.ui.969'),
      live && here.bulk && here.edit && book !== null,
      () => session.send({ t: 'format', book: book ?? undefined }),
      undefined,
      'format black',
    )
    /*
     * Перезапуска ядра здесь нет намеренно. В тулбаре он сделан УДЕРЖАНИЕМ, и
     * это решение: он теряет все переменные комнаты и не откатывается. Строка
     * в списке, срабатывающая по Enter с первого нажатия, обошла бы ровно тот
     * второй шаг, ради которого удержание и написано.
     */
    act('panel-files', tr('room.ui.971'), true, toggleLeft, `${modKey}B`, 'files people')
    // Шапка складывается и с клавиатуры: горячей клавиши у неё нет нарочно —
    // это настройка на пару, а не то, что дёргают посреди работы.
    act(
      'head',
      headOpen ? tr('room.head.fold') : tr('room.head.unfold'),
      true,
      toggleHead,
      undefined,
      'header шапка',
    )
    act('panel-oracle', tr('room.ui.973'), true, focusOracle, `${modKey}I`, "ai oracle ии")
    act('panel-terminal', tr('room.ui.679'), true, toggleTerminal, `${modKey}J`, "terminal shell консоль")
    act('copy-link', tr('room.ui.976'), true, () => void copyLink(), undefined, 'link')
    act('rules', tr('room.ui.900'), isHost, () => (rulesOpen = true), undefined, "правила rules")
    act('projection', tr('room.ui.301'), isHost, toProjection, undefined, "screen проекция")
    act('pult', tr('room.ui.979'), isHost, toPult, undefined, "пульт console лекция")
    act(
      'class',
      session.finished ? tr('room.ui.909') : tr('room.ui.933'),
      isHost && live,
      () => setClassOver(!session.finished),
      undefined,
      "class занятие",
    )

    /* Вкладки, которые уже открыты, — и файлы, которые ещё нет. */
    row.forEach((key, index) => {
      if (typeof key !== 'string') return
      out.push({
        id: `tab:${key}`,
        get group() { return tr('room.ui.982') },
        label: baseOf(key),
        hint: index < 9 ? `Ctrl${index + 1}` : undefined,
        keywords: key,
        run: () => tabs.show(key),
      })
    })
    const open = new Set(row.filter((key): key is string => typeof key === 'string'))
    for (const file of session.files) {
      if (file.dir || open.has(file.path)) continue
      out.push({
        id: `file:${file.path}`,
        get group() { return tr('room.ui.586') },
        label: file.path,
        run: () => openFile(file.path),
      })
    }

    /* Ячейки — всех тетрадей комнаты сразу: номер у каждой свой, а «покажи,
       где она» умеет открыть ту тетрадь, в которой она лежит. */
    for (const [cellId, number] of everyCell.current) {
      const line = cellLine(cellId)
      out.push({
        id: `cell:${cellId}`,
        get group() { return tr('room.ui.984') },
        label: line || tr('room.ui.985'),
        hint: String(number).padStart(2, '0'),
        keywords: `ячейка cell ${number}`,
        run: () => revealCell(session, cellId),
      })
    }
    return out
  }

  function openPalette(): void {
    paletteList = paletteItems()
    paletteOpen = true
    void paletteView()
  }

  function onKeydown(event: KeyboardEvent): void {
    /*
     * Клавиатура комнаты — только в комнате.
     *
     * `<svelte:window>` стоит вне веток режима, и до сих пор эти клавиши
     * доставали до состояния, которого на проекции и на пульте не нарисовано:
     * Ctrl+` ставил `terminalOpen = true` под невидимым ящиком, обнулял
     * непрочитанное этой вкладки и при спящем контейнере посылал `term:open` —
     * то есть будил оболочку нажатием на ноутбуке у проектора. У пульта своя
     * клавиатура (ConsoleView), у проекции нет никакой, кроме Escape, и он
     * живёт в своём эффекте выше.
     */
    if (mode !== 'room') return
    // Пока палитра открыта, клавиши разбирает она.
    if (paletteOpen) return

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    // Ctrl+` reaches the terminal from anywhere, including a focused cell.
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Backquote') {
      event.preventDefault()
      toggleTerminal()
      return
    }
    if (mod && !event.shiftKey) {
      /*
       * Четыре сочетания и один список. Всё, что они делают, есть и в палитре
       * подписью с этим же сочетанием: клавиша, о которой негде прочитать, —
       * это клавиша, которой пользуется один человек, её написавший.
       */
      if (event.code === 'KeyK') {
        event.preventDefault()
        openPalette()
        return
      }
      if (event.code === 'KeyB') {
        event.preventDefault()
        toggleLeft()
        return
      }
      if (event.code === 'KeyJ') {
        event.preventDefault()
        toggleTerminal()
        return
      }
      if (event.code === 'KeyI') {
        event.preventDefault()
        focusOracle()
        return
      }
    }
    /*
     * Ctrl+1…9 — вкладка по счёту, как в браузере и в редакторах. Ctrl, а не
     * ⌘: ⌘1…9 на макбуке переключает вкладки САМОГО браузера, и отнять их у
     * него — значит сломать то, чем человек пользуется чаще.
     */
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const digit = /^Digit([1-9])$/.exec(event.code)
      if (digit) {
        const key = row[Number(digit[1]) - 1]
        if (typeof key === 'string') {
          event.preventDefault()
          tabs.show(key)
        }
        return
      }
    }
    if (event.key !== 'Escape') return
    /*
     * Escape закрывает то, что открыто последним, — и пульт правил тоже.
     *
     * У него был свой `onkeydown` на фоновом `<div role="presentation">` без
     * tabindex: такой элемент не получает клавиш никогда, то есть Escape там
     * был написан и не работал ни разу.
     */
    if (rulesOpen) {
      rulesOpen = false
      event.preventDefault()
    } else if (rightDrawer) {
      rightDrawer = false
      event.preventDefault()
    } else if (leftDrawer) {
      leftDrawer = false
      event.preventDefault()
    }
  }

  /* -------------------------------------------------------------- header */

  let copied = $state(false)
  let copyTimer: number | undefined
  onDestroy(() => window.clearTimeout(copyTimer))

  function rename(next: string): void {
    getMeta(session.doc).set('title', next)
  }

  // The field shows the link the way a person would read it out; the clipboard
  // gets the one a browser can open. Read once, for the same reason as above.
  // svelte-ignore state_referenced_locally
  const shareUrl = `${location.host}/s/${info.id}`

  async function copyLink(): Promise<void> {
    try {
      await copyText(`${location.origin}/s/${info.id}`)
    } catch {
      // Ссылка — это весь смысл нажатия, и молча ничего не делать здесь хуже
      // всего: человек уверен, что скопировал, и вставляет в чат прошлое.
      session.showError(tr('room.ui.991', { p0: location.origin, p1: info.id }))
      return
    }
    copied = true
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copied = false), 1600)
  }

  /*
   * Everything on the brand band dims by opacity rather than by swapping a
   * colour: opacity is the only property allowed to animate, and on navy a
   * translucent white reads as the same ink turned down instead of a second
   * grey that has to be picked to work in both themes.
   */
  // No colour here on purpose: `text-white` and `text-brand` land in the same
  // Tailwind bucket, so a caller that inverts to the white ground has to be the
  // only one naming an ink.
  /**
   * Коробка одного уведомления в стеке внизу.
   *
   * Одна на все пять строк: они стоят в одной колонке друг под другом, и
   * коробка, отличающаяся у соседей рамкой или грунтом, читалась бы как две
   * разные вещи. Отступы у каждой свои — у одних внутри кнопка, у других
   * крестик, у третьих ничего.
   */
  const TOAST =
    'pointer-events-auto flex max-w-lg gap-2 border border-line bg-raised shadow-pop'

  const BAND_BTN =
    'flex shrink-0 items-center justify-center focus-visible:outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white ' +
    'transition-opacity duration-quick ease-out hover:opacity-100'

  /*
   * The two panel toggles, and the one place on the band where opacity alone is
   * not enough.
   *
   * They used to differ by nothing but 55% ink versus 100%, which reads as
   * "this one is dimmer", not as "this one is switched on" — and the shared
   * `hover:opacity-100` above did literally nothing to the open button, since
   * it was already at 100. So both of them answered the pointer with silence,
   * and the state they were reporting was invisible unless you compared the two
   * against each other.
   *
   * A ground fixes both at once. Open is a white wash the button keeps whether
   * or not the pointer is near it; hover is half that wash, so a closed button
   * says "press me" and an open one still says "already on". White rather than
   * the accent on purpose: the accent is this band's one signal colour and it
   * belongs to the kernel's state, not to which column is showing.
   *
   * The press is the house one — 3% under the finger, bound to :active rather
   * than to a state, so it cannot arrive late. index.css keeps it under reduced
   * motion for the same reason it keeps every other press: 3% that never
   * travels is feedback, not decoration.
   *
   * Три процента и есть три: здесь стояло 0.95, а на кнопке 28 px это читается
   * как вздрагивание (index.css: «0.95 reads as a flinch at this size»), и
   * продукт держит ровно один масштаб нажатия. Списки позиционные, как у `.btn`
   * там же: цвет отвечает УКАЗАТЕЛЮ и берёт `ease` со скоростью щелчка,
   * transform отвечает НАЖАТИЮ и берёт --ease-out со своей, 120 мс. Одной
   * длительностью на три свойства transform ехал за 100 мс — не ту ступень
   * лестницы.
   */
  const bandIcon = (on: boolean) =>
    cn(
      'flex h-7 w-7 shrink-0 items-center justify-center text-white',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
      'transition-[background-color,opacity,transform]',
      'duration-[var(--speed-quick),var(--speed-quick),var(--speed-press)]',
      'ease-[ease,ease,var(--ease-out)] enabled:active:scale-[0.97]',
      on
        ? 'bg-white/15 opacity-100 hover:bg-white/20'
        : 'opacity-60 hover:bg-white/10 hover:opacity-100',
    )
</script>

<svelte:window onkeydown={onKeydown} />

{#if projection}
  <!--
    Экран на балке. Комната под ним не рисуется вовсе — ни вкладок, ни панелей,
    ни тетради: это единственное место в продукте, которое смотрят двадцать
    человек сразу, и всё, что на нём есть лишнего, они и увидят. Соединение при
    этом то же самое: SessionState живёт в этом же компоненте и переход сюда его
    не трогает.
  -->
  <!--
    Отступы под вырезом — на контейнере, а не в каждой строке: с
    `viewport-fit=cover` (см. index.html) страница занимает физический экран
    целиком, и на планшете, поставленном вместо проектора, «Экран готов»
    оказалось бы под чёлкой. На ноутбуке у проектора все четыре нуля, и правило
    не стоит ничего.
  -->
  <div
    class="fixed inset-0 z-[90] flex flex-col bg-black
           pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]
           pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]"
  >
    <!--
      Связь на проекции — своей строкой, потому что чужие сюда не доходят.

      Полоса «Reconnecting» живёт в шапке комнаты, а комнаты здесь нет вовсе;
      LectureView про соединение не знает. Балка при этом — самая опасная из
      трёх поверхностей: последняя страница висит, преподаватель листает на
      планшете, зал видит неподвижный слайд и ни слова о том, почему он
      неподвижен. Угол, а не плашка: читает это один человек у проектора,
      остальным двадцати она была бы просто мусором на экране.
    -->
    {#if !session.connected && !session.stuck && !session.gone}
      <div
        class="pointer-events-none absolute right-[max(1.5rem,env(safe-area-inset-right))]
               top-[max(1.5rem,env(safe-area-inset-top))] z-10 flex items-center gap-2 text-white/60"
        role="status"
      >
        <Icon name="spinner" size={12} class="animate-spin" />
        <span class="text-2xs font-bold uppercase tracking-label">{tr('room.ui.890')}</span>
      </div>
    {/if}
    {#if lecture}
      <LectureView {lecture} role="projection" onleave={fromProjection} />
    {:else}
      <!--
        Лекции ещё нет. Это обычное дело: проектор включают до пары, а ссылку
        открывают заранее — экран должен сказать, что он готов и чего ждёт, а не
        показывать чёрный прямоугольник, в котором нельзя отличить «жду» от
        «сломалось».
      -->
      <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <span class="text-2xs font-bold uppercase tracking-institution text-white/40"> {tr('room.ui.891')} </span>
        <p class="text-marquee-sm font-black text-white">{title}</p>
        <p class="max-w-md text-ui text-white/50"> {tr('room.ui.892')} </p>
        <div class="mt-4 flex items-center gap-2">
          {#if fullscreenPossible()}
            <button
              type="button"
              class="border border-white/20 px-3 py-1.5 text-2xs font-bold uppercase tracking-label text-white/70 transition-colors duration-100 hover:border-white/40 hover:text-white"
              onclick={() => void goFullscreen(document.documentElement)}
            > {tr('room.ui.193')} </button>
          {/if}
          <button
            type="button"
            class="px-3 py-1.5 text-2xs font-bold uppercase tracking-label text-white/40 transition-colors duration-100 hover:text-white/70"
            onclick={fromProjection}
          > {tr('room.ui.893')} </button>
        </div>
      </div>
    {/if}
    <!--
      Консилиум на проекторе — счётчик, пока пишут, и подписанный вариант,
      когда его вывели.

      Класс работает у себя, и зал должен видеть, что работа идёт: сколько
      сдали из скольких. Чужих попыток здесь нет — кроме одной, которую
      преподаватель сам решил показать: тогда счётчик уступает место ей, потому
      что смотрят в эту минуту на неё. И подписана она так же, как плашка в
      тетради у каждого: то же имя (или «Вариант N»), то же время, тот же
      вывод — один показ, одна подпись на весь зал.

      Поверх лекции, а не в потоке: страница документа не должна ёрзать от
      того, что сдал ещё один человек.
    -->
    {#if councilsOnAir.length > 0}
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-black/70 px-8 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4"
        aria-live="polite"
      >
        {#each councilsOnAir as council (council.cellId)}
          <div class="flex flex-col gap-1.5">
            <div class="flex items-baseline gap-4">
              <span class="text-2xs font-bold uppercase tracking-institution text-white/50"> {tr('room.ui.34')}{council.ordinal ? tr('room.ui.894', { p0: council.ordinal }) : ''}
              </span>
              {#if council.shown}
                <!-- Справа — состояние показанного: «на экране», и отметка
                     преподавателя рядом, если она уже стоит. Счёт сдавших
                     уходит: в эту минуту зал смотрит не на него. -->
                <span
                  class={cn(
                    'ml-auto text-2xs font-bold uppercase tracking-institution',
                    council.shown.correct === false ? 'text-warning' : 'text-positive',
                  )}
                >
                  {tr('room.ui.52')}{council.shown.correct === null
                    ? ''
                    : ` · ${council.shown.correct ? tr('room.ui.1225') : tr('room.ui.1226')}`}
                </span>
              {:else}
                <span class="font-mono text-ui-lg tabular-nums text-white">
                  {countLine(council.count)}
                </span>
              {/if}
            </div>
            {#if council.shown}
              {@const shown = council.shown}
              {@const lines = shownOutputLines(council.shown.run)}
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                {#if shown.name !== null}
                  <Avatar name={shown.name} color={shown.color ?? '#888888'} avatar={shown.avatar} size="sm" />
                  <span class="text-prompt-sm font-bold text-white">{shown.name}</span>
                {:else}
                  <!-- Имена на проекторе выключены: номер варианта вместо имени
                       и пустой кружок вместо лица — тот же кадр, что в тетради. -->
                  <span class="h-6 w-6 shrink-0 rounded-full bg-white/15" aria-hidden="true"></span>
                  <span class="text-prompt-sm font-bold text-white">
                    {tr('room.ui.1255', { p0: shown.variant })}
                  </span>
                {/if}
                <span class="text-ui text-white/50">
                  {tr('room.ui.1256')}{shown.shownAt === null ? '' : ` · ${clock(shown.shownAt)}`}{shown.alsoWrote >
                  0
                    ? ` · ${tr('room.ui.1257', { count: shown.alsoWrote })}`
                    : ''}
                </span>
              </div>
              <!--
                Код — простым моноширинным, без подсветки: краски тетради
                набраны под белый лист, и на чёрном половина их растворяется.
                Зал читает форму решения, а не цвет его литералов.
              -->
              <pre
                class="overflow-x-auto whitespace-pre font-mono text-prompt-sm text-white">{shown.text}</pre>
              {#if lines.length > 0}
                <pre
                  class="overflow-x-auto whitespace-pre font-mono text-ui-lg text-white/50">{lines.join('\n')}</pre>
              {/if}
            {:else}
              <!--
                Полоса растёт масштабом, а не шириной.

                Единственное место в комнате, где анимировалась геометрия: ширина
                стоит layout на каждом кадре перехода, и делала она это на
                проекторе, поверх страницы лекции, каждый раз, когда кто-то сдал.
                `scaleX` от левого края даёт ту же картинку на композиторе — так
                же сделана полоса загрузки в панели файлов. Ярус тот же, что у
                панели (220 мс): 300 выше всего, что продукт себе позволяет.
              -->
              <div class="h-1 w-full bg-white/15">
                <div
                  class="h-full w-full origin-left bg-white transition-transform duration-panel ease-out"
                  style:transform={`scaleX(${council.count.total > 0 ? council.count.submitted / council.count.total : 0})`}
                ></div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{:else if councilPult && councilCell}
  <!--
    Пульт консилиума. Ни тетради, ни панелей: окно открыто ради того, чтобы
    имена, черновики, ошибки и отметки НЕ попали на проектор, и всё, что
    нарисовано рядом с ними, эту цель отменяет.
    Соединение то же самое — то же `SessionState`, та же личность из
    localStorage, тот же управляющий сокет. Отказ не-преподавателю пульт
    печатает сам, своими словами: он один знает, чего именно нельзя.
  -->
  <div class="fixed inset-0 z-[95] bg-canvas">
    {#await councilWindow() then Pult}
      <!--
        Перемонтаж на смену ячейки — намеренный.

        Стоит он одну перерисовку, а снимает девять состояний окна: прочитанное,
        черновики писем, набор «новых», придержанные сдачи, момент заморозки,
        снимок списка, момент открытия, раскрытое и курсор. Гасить их руками —
        девять мест, в которых однажды забудут одно, и тогда во второй ячейке
        окажется письмо, написанное человеку из первой.
      -->
      {#key councilCell}
        <Pult
          cellId={councilCell}
          onpick={(next) => onnavigate?.(pultPath(session.session.id, next))}
          onexit={exitCouncil}
        />
      {/key}
    {/await}
  </div>
{:else if pult}
  <!--
    Пульт. Комната под ним не рисуется вовсе — по той же причине, что и под
    проекцией, только повёрнутой в другую сторону: на проекцию смотрят двадцать
    человек и лишнего им видеть нельзя, а пульт держат в руках посреди фразы, и
    лишнее там — это лишняя секунда молчания в аудитории. Ни вкладок, ни панели
    файлов, ни оракула, ни терминала.
    Соединение то же самое: `SessionState` живёт в этом же компоненте, и приход
    сюда его не трогает — ни сокетов, ни документа, ни присутствия.
    Обёртка даёт пульту только место и подложку: правила касания (лупа по
    долгому нажатию, серая вспышка на каждом тапе) и отступы под вырезом стоят
    внутри ConsoleView — там знают, какая кромка чем занята, и там же они
    кончаются, не задевая ни тетрадь, ни читалку.
  -->
  <!-- Без ветки ожидания, как у панели в App: грунт уже нарисован, а спиннер
       поверх него был бы вторым ожиданием на то же самое. -->
  <div class="fixed inset-0 z-[95] bg-canvas">
    {#await consoleView() then Console}
      <Console onexit={leavePult} />
    {/await}
  </div>
{:else}
<!--
  `clip`, а не `hidden`: у комнаты нет прокрутки вбок ни при каком содержимом.

  `overflow-hidden` создаёт прокручиваемую коробку — невидимую, но настоящую:
  стоит браузеру показать фокус на кнопке, уехавшей за правый край (панель,
  ящик, чужая полоса), и он прокручивает эту коробку сам. Комната после этого
  стоит сдвинутой влево целиком — с маркой и именем занятия за кромкой, — и
  вернуть её нечем: полосы прокрутки нет, а жеста для скрытой коробки не
  существует. `clip` режет точно так же, но коробку не заводит, и такой сдвиг
  становится невозможен, кто бы что ни переполнил внутри.
-->
<div class="flex h-full min-h-0 flex-col overflow-clip bg-canvas">
  <!--
    Two bands, one brand ground. The navy is the printed object the room is
    held in — the same in both themes, like the join poster — so nothing in
    here reads a theme token that flips. White, translucent white, `brand-2`
    and `accent` are the entire palette above the workspace, and every one of
    them resolves to the same value on either side of the switch.
  -->
  <header class="shrink-0 bg-brand">
    <!--
      Марка ведёт туда, где человеку есть что делать, — или никуда.

      Корень Colloq — это панель преподавателя (см. App), и ссылка на неё стояла
      у ВСЕХ: студент, ткнувший в логотип посреди пары, полной навигацией уходил
      из комнаты на форму «paste the setup token». Теперь дорога наверх есть у
      того, у кого она есть: у ведущего — панель, у участника — страница курса,
      если семинар в курсе состоит. Больше некуда — и тогда марка просто знак, а
      не обещание.
    -->
    <!--
      Вся верхняя полоса шапки — один складывающийся блок.

      Складка меряется высотой, и это единственное место в комнате, где
      геометрия анимируется нарочно: свернуть шапку — значит ОТДАТЬ её место
      тетради, а место отдаётся только настоящей высотой. `slide` держит её на
      своём element.animate() и умеет разворачиваться с полдороги — нажатие
      посреди хода не начинает заново, а едет обратно от того кадра, на котором
      застало. 200 мс — ярус панели (--speed-panel), quintOut — та же кривая,
      что у ящиков по краям.

      Содержимое гаснет быстрее складки (120 мс): к середине хода читать уже
      нечего, и название не успевает подъехать к полосе состояния вплотную —
      оно уходит под кромку целым, а не сплющенным.

      Под `prefers-reduced-motion` обе длительности — нули, и это тот редкий
      случай, когда правило index.css («прозрачность остаётся») не годится:
      блок уезжает из DOM только после ПОСЛЕДНЕГО своего перехода, и складка в
      0 мс рядом с растворением в 120 оставляла шапку стоять во всю высоту эти
      120 мс, а потом срезала её скачком. Мерено на стенде: высота через 35 мс
      после нажатия — прежние 157. Нуль на обоих — настоящее мгновенно.
      Перекрытие двух марок внизу при этом живёт: оно ничего не смещает.
    -->
    {#if headOpen}
      <div transition:slide={{ duration: prefersReducedMotion() ? 0 : 200, easing: quintOut }}>
        <div
          class="px-4 pt-4 sm:px-7"
          transition:fade={{ duration: prefersReducedMotion() ? 0 : 120 }}
        >
          {#if homeHref}
            <a
              href={homeHref}
              aria-label={isHost ? tr('room.extra.401') : tr('room.extra.402', { p0: session.session.course?.name ?? '' })}
              class="block max-w-full transition-opacity duration-100 hover:opacity-85
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <Wordmark institution={session.session.institution} tone="onDark" />
            </a>
          {:else}
            <div class="block max-w-full">
              <Wordmark institution={session.session.institution} tone="onDark" />
            </div>
          {/if}
        </div>

        <!-- The loudest thing on the screen. Black rather than bold: HSE Sans Black
             is what the artboard is drawn in, and Inter at 700 reads thin here. -->
        <div
          class="flex items-end gap-3 px-4 pb-4 pt-2 sm:gap-4 sm:px-7 sm:pb-5 sm:pt-3"
          transition:fade={{ duration: prefersReducedMotion() ? 0 : 120 }}
        >
          {#if !title}
            <div role="status" aria-label={tr('common.loading')} aria-busy="true" class="min-w-0 flex-1 text-marquee-sm sm:text-marquee">
              <Skeleton width="min(80%, 32rem)" height="0.85em" tone="onDark" />
            </div>
          {:else if isHost}
            <!-- Renaming writes into the shared doc, so the room sees it immediately. -->
            <input
              class="name-field -mx-1.5 min-w-0 truncate bg-transparent px-1.5 text-marquee-sm
                     font-black text-white hover:bg-white/5 focus:bg-white/10 sm:text-marquee"
              value={storedTitle}
              oninput={(event) => rename(event.currentTarget.value)}
              aria-label={tr('room.ui.895')}
              maxlength={80}
              spellcheck="false"
            />
          {:else}
            <h1 class="-mx-1.5 min-w-0 truncate px-1.5 text-marquee-sm font-black text-white sm:text-marquee">
              {title}
            </h1>
          {/if}

          <time
            datetime={started.toISOString()}
            title={dateLong}
            class="shrink-0 pb-1 font-mono text-ui-lg text-white/60">{dateShort}</time
          >
          <!-- Holds the pair to the left when the name is short. -->
          <span class="min-w-0 flex-1"></span>
        </div>
      </div>
    {/if}

    <!-- The live state of the room: who is here, what the machine is doing, and
         the two controls that are about this room rather than about the
         notebook inside it. -->
    <!--
      45, а не 44: правило сверху съедает пиксель из коробки содержимого, и в
      оставшихся 43 всякий чётный по высоте ребёнок центрируется на половине
      пикселя. Круги от этого размывались по кольцу, а на 1x — заметно.
    -->
    <!--
      Полоса ПЕРЕНОСИТСЯ, а не выталкивает своё содержимое за экран.

      На телефоне в ней восемь органов сразу: люди, ядро, состояние связи,
      четыре переключателя, тема и ссылка — около 520 px при окне в 360. Пока
      строка была одна и без переноса, лишнее уезжало вправо под
      `overflow-hidden` корня: кнопка «Скопировать» стояла за краем целиком, а
      «Восстанавливаем связь» уводила туда же и её, и тему — то есть обрыв
      связи забирал с экрана ровно те две кнопки, которыми на него отвечают.
      Перенос ставит группу кнопок второй строкой ровно тогда, когда она не
      влезла, и не стоит ни пикселя там, где влезла.

      Без точки перелома нарочно: полоса переполняется не на «телефонной»
      ширине, а тогда, когда в ней много СОДЕРЖИМОГО — четверо в комнате,
      «ЯДРО ОСТАНОВЛЕНО» и «Восстанавливаем связь» вместе занимают 500 px и на
      планшете в 768. Перенос по месту чинит и этот случай, а на ноутбуке не
      случается ни разу.

      Рост прежний: 45 − 1 (правило сверху) = 44, минус py-1.5 с двух сторон =
      32 на строку, и ребёнок в 28 по-прежнему центрируется целыми пикселями.
    -->
    <!--
      Линейка сверху — пока сверху что-то есть.

      Она отделяет полосу от названия занятия, и у свёрнутой шапки отделять
      нечего: полоса стоит первой строкой экрана, и линейка на её верхней
      кромке читалась бы как недорисованная рамка окна.
    -->
    <div
      class={cn(
        'flex min-h-[45px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5 sm:gap-x-4 sm:px-7',
        headOpen && 'border-t border-brand-2',
      )}
    >
      <!--
        Марка у свёрнутой шапки — та же самая, и стоит она в том же столбце.

        Левый отступ у полосы и у шапки один (px-4 / sm:px-7), поэтому знак
        никуда не едет по горизонтали: пока складка сходится, полоса сама
        поднимается к нему, и две марки — уходящая в шапке и приходящая здесь —
        съезжаются в одну точку. Перекрытие плотностей на этом пути читается как
        ПЕРЕЕЗД одного знака, а не как подмена одного другим; настоящий
        общий элемент дал бы ту же картинку ценой измерений на каждом кадре.

        Заголовок уезжает вместе со складкой, и без `h1` страница осталась бы
        безымянной для читалки: `sr-only` возвращает имя занятия туда, где оно
        и было, а `title` у знака — тем, кто наводит указатель.
      -->
      {#if !headOpen}
        <h1 class="sr-only">{title}</h1>
        <!-- Та же дверь, что у марки в развёрнутой шапке: свернул полосу — не
             потерял путь в панель (или на страницу курса). -->
        {#if homeHref}
          <a
            href={homeHref}
            aria-label={isHost ? tr('room.extra.401') : tr('room.extra.402', { p0: session.session.course?.name ?? '' })}
            class="flex shrink-0 items-center text-white transition-opacity duration-100 hover:opacity-85
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            in:fade={{ duration: 160, delay: 40 }}
            out:fade={{ duration: 100 }}
          >
            <Icon name="logo" size={16} />
          </a>
        {:else}
          <span
            class="flex shrink-0 items-center text-white"
            title={title}
            in:fade={{ duration: 160, delay: 40 }}
            out:fade={{ duration: 100 }}
          >
            <Icon name="logo" size={16} />
          </span>
        {/if}
      {/if}
      {#if room.length > 0}
        <div class="flex shrink-0 items-center gap-4" title={roomNames}>
          <!-- 28, как на экране входа: 24 в этой полосе читались мелко, а
               человек в комнате — единственное, что здесь про людей. -->
          <AvatarStack people={room} max={4} size={28} ring="rgb(var(--brand))" tone="onDark" />
          <span
            class="hidden shrink-0 text-2xs font-bold uppercase tracking-label text-white/80 sm:inline"
          >
            {room.length} {tr('room.ui.896')} </span>
        </div>
        <span class="hidden h-3.5 w-px shrink-0 bg-brand-2 sm:block" aria-hidden="true"></span>
      {/if}

      <!-- Kernel. `python3` is the runtime this product runs and nothing else,
           so naming it is a fact rather than a field we do not have. -->
      <!--
        Dimmed while the socket is down. What the pill holds then is the last
        thing the server said, not what the kernel is doing now — nobody knows
        that — and a live-looking "IDLE" beside a spinner marked RECONNECTING is
        two claims that cannot both be true. Half opacity says "last known"
        without adding a word to a bar that is already full.
      -->
      <div
        class={cn(
          'flex h-7 shrink-0 items-center gap-2 transition-opacity duration-quick',
          kernel.alarm && 'bg-danger/20 px-2.5 ring-1 ring-inset ring-danger',
          !session.connected && 'opacity-50',
        )}
        title={session.connected ? kernel.why : tr('room.extra.405')}
        role="status"
      >
        <span class={cn('h-1.5 w-1.5 shrink-0 rounded-full', kernel.dot)} aria-hidden="true"></span>
        <span class="text-2xs font-bold uppercase tracking-label text-white">{kernel.label}</span>
        {#if !kernel.alarm}
          <span class="hidden font-mono text-2xs text-white/60 lg:inline">python3</span>
        {/if}
      </div>

      <!--
        Обе строки состояния УСЫХАЮТ, а не растут.

        «Восстанавливаем связь» разрядкой в верхнем регистре — это 185 px, и
        `shrink-0` на них означал, что связь, оборвавшись, уносит за правый край
        всё, что стоит правее: тему и «Скопировать». Значок при этом не
        усыхает никогда (`shrink-0` на нём), слово усыхает многоточием, а
        целиком его держит `title` — вместе с переносом полосы выше этого
        хватает, чтобы фраза читалась полностью в комнате на четверых.
      -->
      {#if session.stuck}
        <!-- Не «Reconnecting»: вкладка больше не пробует, и крутилка врала бы. -->
        <div
          class="flex min-w-0 shrink items-center gap-2 text-white"
          role="status"
          title={tr('room.ui.898')}
        >
          <Icon name="alert" size={12} class="shrink-0" />
          <span class="truncate text-2xs font-bold uppercase tracking-label">{tr('room.ui.898')}</span>
        </div>
      {:else if !session.connected}
        <div
          class="flex min-w-0 shrink items-center gap-2 text-white"
          role="status"
          title={tr('room.ui.899')}
          transition:fade={{ duration: 120 }}
        >
          <Icon name="spinner" size={12} class="shrink-0 animate-spin" />
          <span class="truncate text-2xs font-bold uppercase tracking-label">{tr('room.ui.899')}</span>
        </div>
      {/if}

      <span class="min-w-0 flex-1"></span>

      <!--
        Кнопки комнаты — ОДНОЙ группой, и переносятся они тоже вместе.

        Порознь перенос рвал их по живому: переключатели оставались в первой
        строке, тема с «Скопировать» уезжали во вторую, и одна полоса читалась
        как две разные. Группа переносится целиком и прижимается вправо на той
        строке, куда попала (`ml-auto`), — на широком окне её прижимает та же
        распорка, что и раньше, и рисунок полосы не меняется.
      -->
      <div class="ml-auto flex shrink-0 items-center gap-3 sm:gap-4">
        <!-- Panels are not on the artboard, which draws both columns open; they
             stay because on a narrow window they are the only way to reach the
             files, the people and the oracle. -->
        <div class="flex shrink-0 items-center gap-0.5">
          {#if isHost}
            <!--
              Пульт правил стоит здесь, а не только в панели.

              Лекция, лабораторная и консультация — три фазы одной пары, а
              правило, до которого можно дотянуться только из админки и только
              при создании семинара, — это правило, до которого преподаватель не
              дотягивается в ту минуту, когда оно нужно.
            -->
            <button
              class={bandIcon(rulesOpen)}
              onclick={() => (rulesOpen = !rulesOpen)}
              aria-pressed={rulesOpen}
              aria-label={tr('room.ui.900')}
              title={tr('room.ui.900')}
            >
              <Icon name="lock" size={16} />
            </button>
          {/if}
          <!--
            Шапка — такая же поверхность комнаты, как панели и ящик, и
            переключается там же. Порядок слева направо повторяет экран:
            шапка сверху, файлы слева, ящик снизу, оракул справа.

            `aria-expanded`, а не `aria-pressed`, как у соседей: те включают и
            выключают панель, а эта раскрывает и складывает то, что стоит прямо
            над ней, — это раскрывашка, и читалка должна назвать её так.
            Подпись меняется вместе с состоянием: «свернуть» на развёрнутой
            шапке — это то, что произойдёт, а не то, что есть.
          -->
          <button
            class={bandIcon(headOpen)}
            onclick={toggleHead}
            aria-expanded={headOpen}
            aria-label={headOpen ? tr('room.head.fold') : tr('room.head.unfold')}
            title={headOpen ? tr('room.head.fold') : tr('room.head.unfold')}
          >
            <Icon name="masthead" size={16} />
          </button>
          <button
            class={bandIcon(leftShown)}
            onclick={toggleLeft}
            aria-pressed={leftShown}
            aria-label={tr('room.ui.901')}
            title={tr('room.extra.407', { p0: modKey })}
          >
            <Icon name="file" size={16} />
          </button>
          <!--
            Ящик снизу — такая же поверхность комнаты, как панели по краям, и
            переключается там же, где они. Стоял он до сих пор в тулбаре тетради,
            среди Run All и Restart, — то есть среди того, что ЗАПУСКАЕТ, а не
            того, что открывает и закрывает. Порядок слева направо повторяет
            экран: файлы слева, ящик снизу, оракул справа.
          -->
          <button
            class={cn(bandIcon(terminalOpen), 'relative')}
            onclick={toggleTerminal}
            aria-pressed={terminalOpen}
            aria-label={tr('room.ui.902')}
            title={tr('room.extra.408', { p0: modKey })}
          >
            <Icon name="prompt" size={16} />
            {#if session.terminalStatus === 'busy'}
              <span
                class="absolute right-1 top-1 h-1.5 w-1.5 animate-blink rounded-full bg-accent"
              ></span>
            {:else if session.terminalUnread > 0}
              <!--
                Новости самого ядра — почему остановился Run All, кто перезапустил
                — пишутся в ленту, а лента за этой кнопкой. Без метки у комнаты
                была причина на руках и ни одного повода её искать.
              -->
              <span
                class="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center
                       justify-center rounded-full bg-accent px-1 font-mono text-micro
                       font-bold text-white"
                title={tr('room.extra.409', { p0: session.terminalUnread })}
              >
                {session.terminalUnread > 9 ? '9+' : session.terminalUnread}
              </span>
            {/if}
          </button>
          <button
            class={bandIcon(rightShown)}
            onclick={toggleRight}
            aria-pressed={rightShown}
            aria-label={tr('room.ui.903')}
            title={tr('room.oracle.shortcut', { key: modKey })}
          >
            <Icon name="sparkles" size={16} />
          </button>
        </div>

        <ThemeSwitch tone="onDark" />

        <!--
          The link, readable and attached to the button that takes it.

          Показывается с 1024px, а не с 1280: до этого адрес прятался на любом
          ноутбуке уже 13", то есть на большинстве машин, с которых семинар и
          ведут. А адрес на экране — это запасной ход, когда буфер обмена не
          работает: его можно продиктовать или переписать руками. Прятать его
          именно там, где он чаще всего и нужен, — ровно наоборот.

          `select-all`, чтобы одно нажатие выделяло его целиком.
        -->
        <div class="flex h-7 min-w-0 shrink items-center">
          <span
            class="hidden h-full min-w-0 select-all items-center truncate border border-r-0
                   border-brand-2 px-3 font-mono text-2xs text-white/80 lg:flex"
            title={shareUrl}
          >
            {shareUrl}
          </span>
          <button
            class={cn(BAND_BTN, 'h-full shrink-0 gap-2 bg-white px-3 text-brand opacity-100')}
            onclick={copyLink}
            title={tr('room.ui.904')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            <!--
              Слово уходит в `sr-only`, а не под `hidden`: кнопка с одним
              значком обязана остаться названной. «СКОПИРОВАТЬ» — это 108 px из
              360, и ради них полоса до сих пор выталкивала саму кнопку за край
              экрана: на телефоне от неё оставались две буквы. Имя для читалки
              и `title` для указателя говорят то же самое, а с `sm` слово
              возвращается на место (`not-sr-only`).
            -->
            <span class="sr-only text-2xs font-bold uppercase tracking-label sm:not-sr-only">
              {copied ? tr('room.ui.905') : tr('room.ui.906')}
            </span>
          </button>
        </div>
      </div>
    </div>
  </header>

  <!--
    Занятие закончено — полосой, а не значком.

    Это состояние всей комнаты, и держится оно днями: значок в шапке такое
    говорит шёпотом, и человек, у которого не нажимается ничего, ищет поломку.
    Полоса стоит там, где начинается работа, не перекрывает её и никуда не
    уезжает при прокрутке — а тёплый тон отличает «так решили» от красного
    «сломалось».

    Всем, а не одним участникам: преподавателю она объясняет, почему у него
    одного всё живо, и держит кнопку возврата под рукой — чтобы не искать её в
    пульте правил посреди пары.
  -->
  {#if session.finished}
    <div
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line
             bg-warning/[0.08] px-4 py-2"
      role="status"
      transition:fade={{ duration: 140 }}
    >
      <Icon name="lock" size={14} class="shrink-0 text-warning" />
      <p class="text-ui font-semibold text-ink"> {tr('room.ui.843')} <span class="ml-1 font-mono text-2xs font-normal text-muted" title={finishedLong}>
          {finishedStamp}
        </span>
      </p>
      <!-- Что осталось, а не что отняли: сюда приходят перечитывать разбор, и
           первое, что человек должен узнать, — что всё на месте. -->
      <!-- `basis-56`, как у подвала пульта правил: `flex-1` с нулевой основой
           брал на телефоне остаток строки в 30 px и ставил фразу в столбик по
           слову на строку. Двести двадцать четыре — та ширина, ниже которой
           строку переносят целиком на свою. -->
      <p class="min-w-0 flex-1 basis-56 text-2xs leading-snug text-muted">
        {isHost
          ? tr('room.ui.907')
          : tr('room.ui.908')}
      </p>
      {#if isHost}
        <button
          type="button"
          class="btn-outline h-[26px] shrink-0 text-2xs font-semibold"
          disabled={controlDisabled(session.connected)}
          title={controlTitle(
            session.connected,
            tr('room.extra.411'),
          )}
          onclick={() => setClassOver(false)}
        > {tr('room.ui.909')} </button>
      {/if}
    </div>
  {/if}

  <!-- Positioned, so the panel drawers below cover the workspace and stop at
       the masthead without anyone hard-coding how tall the masthead is. -->
  <div class="relative flex min-h-0 flex-1">
    {#if leftShown && !leftIsDrawer}
      <aside class="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
        {@render leftPanels()}
      </aside>
    {/if}

    <!-- The drawer sits inside the notebook column, not under the whole app:
         it is the same machine the cells run on. -->
    <div class="flex min-w-0 flex-1 flex-col">
      {#if row.length > 0}
        <!--
          Вкладки появляются только когда есть что переключать: в комнате, где
          не открыли ни файла, этой строки нет вовсе, и она не стоит ни пикселя
          высоты.
        -->
        <TabStrip
          tabs={row}
          active={tabs.active}
          board={session.board}
          mayBoard={may.board}
          {lead}
          {orphaned}
          following={readerFollowing}
          page={readerPage}
          pages={readerPages}
          pinned={roomPinned}
          books={bookTabs}
          mayAccess={isHost}
          meId={session.me.id}
          onaccess={setBookAccess}
          onshow={(key) => tabs.show(key)}
          onclose={closeTab}
          onreorder={(dragged, onto) => tabs.reorder(dragged, onto)}
          oncatchup={() => (catchUp += 1)}
        />
      {/if}

      {#if activePath && activeKind === 'text'}
        <FileBar
          path={activePath}
          mayRun={may.run && runnerFor(activePath) !== null}
          mayEdit={may.files}
          whyReadOnly={may.filesWhy}
          refused={activeDoc?.refused ?? false}
          onrun={() => runFile(activePath)}
        />
      {/if}

      <!--
        Тетрадь прячется, а не размонтируется: в ней курсор, прокрутка и полтора
        десятка редакторов CodeMirror, и пересобирать их на каждое переключение
        вкладки значит терять место в тексте. Скрытых тетрадей столько, сколько
        открыто вкладок, — а не одна на комнату.
      -->
      {#each row as path (path)}
        {#if kindOf(path) === 'notebook'}
          <!--
            Нажатие мимо ячейки снимает выделение.

            До сих пор выйти из состояния «выбрано» было нельзя ничем: способ
            выделить был один — нажать на ячейку, — а способа не выделять не
            было вовсе. Обработчик стоит на колонке, а не на самой тетради:
            ниже последней ячейки лежит пустое место, и оно тоже «мимо».
            Проверяется цель нажатия, а не координата: кнопка тулбара — тоже
            мимо ячейки, и это верно, она относится ко всей тетради.
          -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <main
            class="min-h-0 flex-1 overflow-y-auto"
            class:hidden={activePath !== path}
            aria-hidden={activePath !== path}
            onclick={(event) => {
              // По тому, что нажимают, а не по корню ячейки: тело и сам номер
              // несут `data-cell-pick` и выделяют, а пустое место в поле рядом
              // с номером — это уже мимо, там и снимают.
              if ((event.target as HTMLElement | null)?.closest('[data-cell-pick]')) return
              if (session.selection.length > 0) session.selectCell(null)
            }}
          >
            {#if books.current.some((book) => book.path === path)}
              <Notebook book={path} active={activePath === path} />
            {:else}
              <div class="flex h-full items-center justify-center text-ui text-muted"> {tr('room.ui.107')} {baseOf(path)}…
              </div>
            {/if}
          </main>
        {/if}
      {/each}

      {#if activePath === null}
        <!--
          Ничего не открыто — это состояние, а не поломка: раньше его не было,
          потому что тетрадь нельзя было закрыть.

          Здесь стояли две строки текста по центру пустого прямоугольника, и
          читались они как сообщение об ошибке, которого никто не совершал.
          Теперь центр держит водяной знак: та же марка, что в шапке комнаты и
          на постере входа, только в один тон и почти прозрачная. Пустое место
          и должно выглядеть пустым — но своим, а не сломанным.

          Марка СТОЛБИКОМ, а не строкой, как везде: строка на 820×830 читается
          как заголовок, который забыли дописать, а столбик — как знак на
          бумаге. Это не тот замок, что в шапке (он один на всех экранах и
          размера не меняет); это его тень, и она нарочно другой формы.

          Девять процентов — столько, чтобы знак был виден на белом и не
          спорил с панелями по краям; в тёмной теме тот же токен даёт то же
          соотношение сам.
        -->
        <div
          class="flex min-h-0 flex-1 select-none flex-col items-center justify-center gap-7 px-6"
        >
          <div
            class="flex flex-col items-center gap-5 text-ink opacity-[0.09]"
            aria-hidden="true"
          >
            <Icon name="logo" size={104} />
            <!-- Отрицательное поле справа ровно в трекинг: 0.22em добавляются и
                 ПОСЛЕ последней Q, и без этого слово стоит на полшага левее
                 знака над ним. На 11 пикселях в шапке это незаметно, на сорока
                 двух — видно. -->
            <span
              class="-mr-[0.22em] text-[42px] font-bold uppercase leading-none tracking-wordmark"
            >
              Colloq
            </span>
          </div>
          <!-- Голосом читалки состояние всё равно называется: знак его не
               произносит, а знать о нём нужно ровно тем, кто знака не видит. -->
          <p class="sr-only">{tr('room.ui.910')}</p>
          <p class="text-2xs text-muted">{tr('room.ui.911')}</p>
        </div>
      {:else if activeKind === 'pdf'}
        {#if lecture && lectureHere && !soloRead}
          <LectureView
            {lecture}
            role={leading ? 'presenter' : 'audience'}
            onproject={toProjection}
            onsolo={leading ? undefined : () => (soloRead = true)}
          />
        {:else}
          {#if may.board && lecture === null && activePath !== session.board}
            <!--
              «На общий экран» — то самое отдельное действие, ради которого
              открытие файла перестало забирать экран у комнаты. Полоса под
              вкладкой, как у скрипта: у каждой вкладки свои действия, и они
              всегда под ней.

              Переход — списком свойств, а не шорткатом `transition`: тот
              переводит ВСЕ свойства, включая border-color и box-shadow
              фокусного кольца, то есть кольцо приезжало бы вслед за клавишей.
              Двигаются здесь ровно два — brightness под курсором и scale под
              пальцем; полоса рисуется руками и в `.btn` не укладывается
              (см. index.css · .btn, где такой же список стоит позиционно).
            -->
            <div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas">
              <button
                type="button"
                class="flex shrink-0 items-center gap-2 bg-primary px-4 text-2xs font-bold
                       uppercase tracking-label text-primary-ink
                       transition-[filter,transform] duration-press ease-out
                       enabled:active:scale-[0.97] hover:brightness-110 active:brightness-95
                       focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                title={tr('room.ui.912')}
                onclick={() => showToRoom(activePath)}
              >
                <Icon name="board" size={11} /> {tr('room.ui.913')} </button>
              <span class="flex-1"></span>
              {#if session.board}
                <!-- Имя файла усыхает: «идём за» с длинным именем выталкивало
                   саму кнопку «На общий экран» за правый край телефона. -->
              <span class="flex min-w-0 shrink items-center px-3 text-2xs text-muted sm:px-5">
                <span class="truncate"> {tr('room.ui.914')} {baseOf(session.board)} </span>
              </span>
              {/if}
            </div>
          {/if}
          <!--
            По файлу, а не по одной ветке на все PDF: читалка открывает документ
            один раз при монтировании, и смена файла в той же ветке оставляла на
            экране страницы прошлого — под новым именем вкладки, с его же
            счётчиком страниц, и «идём за …» сходилось по номерам, потому что
            все смотрели один и тот же не тот документ.
          -->
          {#key activePath}
            <PdfReader
              file={activePath}
              shared={activePath === session.board}
              mayLead={may.board && lecture === null}
              backToLecture={lectureHere ? () => (soloRead = false) : null}
              {catchUp}
              {lead}
              bind:page={readerPage}
              bind:pages={readerPages}
              bind:following={readerFollowing}
            />
          {/key}
        {/if}
      {:else if activePath && activeKind === 'text'}
        {#if activeDoc?.tooBig}
          <!--
            Файл есть, просто он велик для редактора. Вкладка остаётся стоять:
            «файла нет» её закрывает, а тут закрывать нечего — человек нажал по
            живому файлу, и ему нужен ответ, а не исчезнувшая вкладка.
          -->
          <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p class="text-ui text-ink">{baseOf(activePath)} {tr('room.ui.915')}</p>
            <p class="text-2xs text-muted"> {tr('room.ui.916')} </p>
          </div>
        {:else if activeDoc}
          {#key activePath}
            <FileEditor
              file={activeDoc}
              readOnly={!may.files || activeDoc.refused}
              onrun={runnerFor(activePath) && may.run ? () => runFile(activePath) : null}
            />
          {/key}
        {:else}
          <div class="flex min-h-0 flex-1 items-center justify-center text-ui text-muted"> {tr('room.ui.107')} {baseOf(activePath)}…
          </div>
        {/if}
      {:else if activePath && activeKind === 'image'}
        <!-- Картинку смотрят, а не правят. Скачивание — в дереве, там же, где
             у всех остальных файлов. -->
        <ImageView path={activePath} />
      {:else if activePath && activeKind !== 'notebook'}
        <!--
          Тетрадь сюда не попадает: она нарисована выше, в своём `main`. Без
          этого условия под открытой тетрадью печаталось «не текст» — ветка
          добиралась до неё последней и была формально права.
        -->
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p class="text-ui text-ink">{baseOf(activePath)} {tr('room.ui.917')}</p>
          <p class="text-2xs text-muted"> {tr('room.ui.918')} </p>
        </div>
      {/if}

      {#if terminalOpen}
        <TerminalDrawer bind:tab={drawerTab} onclose={() => (terminalOpen = false)} />
      {/if}
    </div>

    {#if rightShown && !rightIsDrawer}
      <aside
        class="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface"
        data-oracle-panel
      >
        <AiPanel />
      </aside>
    {/if}

    <!--
      The travel below is gated here rather than in index.css, and it has to be:
      Svelte runs transition:fly through element.animate(), which no media query
      can reach — the reduced-motion block in index.css names what CSS owns, and
      these ±140px are the largest movement in the product. Reduced is a
      reduction, not a blackout: the panel still arrives over 140ms and still
      fades, it simply stops sliding.

      `in:`, а не `transition:` — то же решение, что admin/motion.css принял для
      меню панели, и по той же причине. Ящик закрывают Escape'ом (onKeydown
      ниже), а анимировать действие с клавиатуры нельзя: клавишу жмут, чтобы
      УБРАТЬ панель, и 140 мс отъезда — это 140 мс, в которые её ещё видно.
      Уход мгновенный на всех трёх дорогах — Escape, щелчок мимо, та же кнопка,
      — потому что панель, уезжающая по-разному в зависимости от того, чем её
      закрыли, читается как разные панели.

      quintOut, а не cubicOut: 1−(1−t)⁵ — ближайшая из svelte/easing к
      --ease-out, которой index.css велит двигаться всему, что движется.
      cubicOut заметно мягче, и панель приезжала не тем движением, что все
      соседние поверхности.
    -->
    {#if leftIsDrawer && leftDrawer}
      <div class="absolute inset-0 z-40 flex">
        <button
          class="absolute inset-0 bg-canvas/70"
          aria-label={tr('room.ui.919')}
          onclick={() => (leftDrawer = false)}
          in:fade={{ duration: 120 }}
        ></button>
        <aside
          class="relative flex w-60 max-w-[85vw] flex-col border-r border-line bg-surface shadow-pop"
          in:fly={{ x: prefersReducedMotion() ? 0 : -140, duration: 140, easing: quintOut }}
        >
          {@render leftPanels()}
        </aside>
      </div>
    {/if}

    {#if rightIsDrawer && rightDrawer}
      <div class="absolute inset-0 z-40 flex justify-end">
        <button
          class="absolute inset-0 bg-canvas/70"
          aria-label={tr('room.ui.920')}
          onclick={() => (rightDrawer = false)}
          in:fade={{ duration: 120 }}
        ></button>
        <aside
          class="relative flex w-[380px] max-w-[92vw] flex-col border-l border-line bg-surface shadow-pop"
          data-oracle-panel
          in:fly={{ x: prefersReducedMotion() ? 0 : 140, duration: 140, easing: quintOut }}
        >
          <AiPanel />
        </aside>
      </div>
    {/if}
  </div>
</div>
{/if}

<!--
  Комната, которой больше нет.
  
  Сервер закрывает сокет с 1001 и причиной, и раньше её никто не читал:
  браузер просто переподключался, получал отказ и крутил «RECONNECTING» до
  конца дня перед человеком, чьего семинара уже не существует. Это не полоска
  внизу, а конец работы — поэтому во весь экран.
-->
<!--
  Слой выше проекции (z-90) и пульта (z-95): под ними эта плашка была нарисована
  и невидима, и обе поверхности продолжали выглядеть живыми — последняя страница
  лекции на балке, лист с клавишами на планшете. «Мёртвая, но живая на вид»
  поверхность — худший случай из всех, и здесь он был.

  Не на пульте: там про удалённую комнату говорит сам ConsoleView, своими
  словами и про чернила, которых уже некуда сохранить.
-->
{#if session.gone && !pult}
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/95 px-6">
    <div class="w-full max-w-sm text-center">
      <span
        class="mx-auto flex h-10 w-10 items-center justify-center border border-line bg-surface text-faint"
      >
        <Icon name="link" size={16} />
      </span>
      <h1 class="mt-4 text-title font-semibold tracking-tight text-ink">{tr('room.ui.145')}</h1>
      <p class="mt-2 text-ui text-muted"> {tr('room.ui.921')} </p>
    </div>
  </div>
{/if}

<!--
  Вас удалили с занятия — посреди занятия.

  Поверх комнаты и во весь экран, как «семинар удалён»: работать здесь больше
  нельзя, и полоска внизу, под живой на вид тетрадью, обещала бы обратное.
  Комната при этом цела — этим случай и отличается от удалённой, — но говорить
  об этом на экране незачем: человеку нужно знать, до какого часа и к кому идти.
-->
{#if session.banned !== null}
  <!-- Тем же ярусом, что и «семинар удалён» выше, и по той же причине: пульт и
       проекция не должны переживать удаление своего человека молча. -->
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/95 px-6">
    <BannedScreen until={session.banned} />
  </div>
{/if}

<!-- Одно меню на оба места, откуда банят, — см. BanMenu.svelte. Только
     ведущему: студенту оно ничего не откроет, а нарисованное — соврёт. -->
{#if isHost && !session.gone && session.banned === null}
  <BanMenu />
{/if}

<!--
  Палитра — вся клавиатура комнаты в одном списке.

  Только в комнате: у пульта своя клавиатура, у проекции нет никакой. Без
  ветки ожидания — чанк маленький и приезжает за один запрос, а мигание
  спиннера на месте, куда сейчас будут печатать, стоит дороже.
-->
{#if paletteOpen && mode === 'room' && !session.gone && session.banned === null}
  {#await paletteView() then Palette}
    <Palette items={paletteList} onclose={() => (paletteOpen = false)} />
  {/await}
{/if}

{#if refusal && refusalShown && !projection}
  <!--
    Модальное, а не строкой: человек только что потерял несколько секунд работы,
    и текст, который он не успеет прочитать, — это тот же потерянный текст.
  -->
  <!--
    И на пульте тоже — но не на проекции.

    Пульт: отказ лечится перезагрузкой, а перезагрузка с `/s/:id/pult`
    возвращает на `/s/:id/pult` (lib/refusal.ts · reloadByHand). Пока окно
    лежало на z-[60] под непрозрачной обёрткой пульта (z-[95] ниже),
    преподаватель на планшете получал обратно свой лист и ни слова о том, что
    правку не приняли и что именно из набранного не доехало. Свой текст
    ConsoleView здесь не пишет намеренно: окно — это не объявление, а
    единственная копия потерянного, и второй такой копии в продукте быть не
    должно (у «удалён» и «разошлись» слов ровно на плашку, потому они и
    сказаны там своими).

    Проекция: на балку смотрит зал, и чужая тетрадь во весь экран посреди пары
    — худшее, что там можно нарисовать. Печатать на проекции нечем, так что
    сюда записка попадает только эхом (кэш той же вкладки, побывавшей в
    комнате). Она не пропадает: `refusal` и `refusedCells` живут в этом же
    компоненте, а смена режима его не пересоздаёт (App держит `{#key}` на
    токене, не на режиме) — окно дождётся выхода с проекции в комнату.
  -->
  <!--
    Печатал в секунду звонка — и об этом надо сказать звонком, а не правкой.

    Гейт отказал теми же словами, что и всё остальное после конца занятия
    (CLASS_IS_OVER, server/src/collab/gate.ts), — по ним окно и узнаёт свой
    случай. Заголовок «Правка не сохранена» здесь врёт про причину: правку не
    приняли не потому, что она плохая, и не потому, что кто-то поменял правило,
    а потому, что пара кончилась ровно между двумя нажатиями клавиш.
  -->
  {@const overClass = refusal.message === CLASS_IS_OVER || refusal.message === tr(CLASS_IS_OVER)}
  <!--
    Свой ярус между пультом и терминальными плашками: выше обёртки пульта
    (z-[95]) и проекции (z-[90]), но ниже «удалён» / «вас удалили» /
    «разошлись» (z-[100]). Порядок тут важен в обе стороны: под пультом окно
    было невидимо, а НАД плашкой удалённой комнаты оно предлагало бы
    скопировать текст туда, куда его уже некуда вернуть.
  -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="refused-title"
    class="fixed inset-0 z-[97] flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="flex max-h-full w-full max-w-[520px] flex-col border border-line bg-canvas shadow-pop">
      <div class="border-b border-line px-5 py-3.5">
        <h2 id="refused-title" class="text-title font-semibold text-ink">
          {overClass ? tr('room.ui.843') : tr('room.ui.922')}
        </h2>
        <p class="mt-1 text-ui leading-snug text-muted">
          {#if overClass} {tr('room.ui.923')} {:else}
            {refusal.message}
          {/if}
        </p>
      </div>
      <!--
        Все ячейки, а не одна.

        Гейт отказывает КАДРУ ЦЕЛИКОМ, а кадр после обрыва связи — это всё, что
        человек набрал без сети, во всех ячейках сразу. Пока здесь стояла одна
        (та, где был курсор), остальные уходили вместе с кэшем молча.

        Показывается только то, чего у сервера правда нет: перезагрузка
        собирает вкладку из серверной копии, и сорок ячеек, из которых
        тридцать девять на месте, прячут ту одну, ради которой всё затевалось
        (lib/refusal.ts · stillLost).
      -->
      {#if refusedChecking}
        <div class="border-b border-line bg-surface px-5 py-3">
          <p class="text-ui text-muted">{tr('room.ui.924')}</p>
        </div>
      {:else if refusedCells.length > 0}
        <div class="min-h-0 flex-1 overflow-y-auto border-b border-line bg-surface px-5 py-3">
          <p class="pb-1.5 text-2xs font-bold uppercase tracking-caps text-muted">
            {refusedCells.length === 1 ? tr('room.ui.925') : tr('room.ui.926')}
          </p>
          <div class="flex flex-col gap-3">
            {#each refusedCells as cell (cell.id || 'cursor')}
              {@const number = cell.id ? everyCell.current.get(cell.id) : undefined}
              <div class="flex flex-col gap-1">
                {#if number !== undefined}
                  <p class="font-mono text-2xs text-muted"> {tr('room.ui.927')} {String(number).padStart(2, '0')}
                  </p>
                {/if}
                <pre
                  class="whitespace-pre-wrap break-words font-mono text-code leading-relaxed text-ink">{cell.text}</pre>
              </div>
            {/each}
          </div>
        </div>
      {/if}
      <!-- На пульте это читают с планшета и нажимают пальцем: те же кнопки в
           той же строке, но ростом с остальные кнопки пульта (h-11, см.
           ConsoleView) — 30 px под палец у нижней кромки мало. -->
      <div class="flex items-center gap-2 px-5 py-3">
        {#if refusedCells.length > 0}
          <button
            type="button"
            class={cn('btn-ghost', pult && 'h-11 px-5')}
            onclick={() => void copyRefused()}
          >
            {refusalCopied
              ? tr('room.ui.138')
              : refusedCells.length === 1
                ? tr('room.ui.139')
                : tr('room.ui.928')}
          </button>
        {/if}
        <span class="flex-1"></span>
        <button
          type="button"
          class={cn('btn-primary', pult && 'h-11 px-6')}
          onclick={() => (refusalShown = false)}
        > {tr('room.ui.929')} </button>
      </div>
    </div>
  </div>
{/if}

<!--
  Пульт правил: тот же список, что и в панели, теми же словами.

  Ложится на полосу состояния, а не открывается отдельной страницей: это
  инструмент, который берут посреди пары на десять секунд, а не экран, на
  который уходят.
-->
<!--
  Только в комнате, как и палитра рядом. Открыть его можно лишь отсюда (полоса
  состояния и палитра — обе в комнате), но `rulesOpen` переживает смену режима:
  этот компонент один на все три (`mode` — свойство, App держит `{#key}` на
  токене). Пульт правил, оставшийся открытым, ложился под проекцию (z-[90]) и
  под пульт (z-[95]) — нарисованный, кликабельный и невидимый; Escape до него
  там тоже не доходит (`onKeydown` уходит на первой же строке). Состояние
  сохраняется: вернулись в комнату — панель на месте.
-->
{#if rulesOpen && isHost && mode === 'room' && !session.gone}
  <!-- Только щелчок мимо. Escape разбирает оконный обработчик (`onKeydown`):
       здесь он висел на нефокусируемом `div` и не срабатывал никогда. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-40" role="presentation" onclick={() => (rulesOpen = false)}></div>
  <!--
    Рост ОГРАНИЧЕН экраном, а не содержимым.

    Ограничение стояло на списке правил (60vh), а заголовок, «Закончить
    занятие» и примечание считались бесплатными — и в альбомной ориентации
    телефона (390 px высоты) 104 сверху плюс 60vh плюс эти три полосы уезжали
    за нижнюю кромку вместе с самой важной кнопкой. Домотать до неё было
    нельзя: прокручивался список ВНУТРИ, а не лист. Теперь лист не выше окна,
    а прокручивается по-прежнему список — заголовок и кнопка всегда на виду.
  -->
  <div
    class="fixed right-3 top-[104px] z-50 flex max-h-[calc(100dvh-7.5rem)] flex-col
           w-[min(30rem,calc(100vw-1.5rem))] border border-line bg-raised shadow-pop sm:right-6"
    role="dialog"
    aria-label={tr('room.ui.900')}
    in:fly={{ y: prefersReducedMotion() ? 0 : -6, duration: 140, easing: quintOut }}
  >
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
      <h2 class="min-w-0 truncate text-2xs font-bold uppercase tracking-section text-muted"> {tr('room.ui.900')} </h2>
      <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
      <button
        class="btn-ghost h-6 w-6 shrink-0 px-0"
        onclick={() => (rulesOpen = false)}
        aria-label={tr('room.ui.141')}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
    <!-- Прокручивается СПИСОК, а не весь лист: заголовок и «Закончить
         занятие» под ним обязаны оставаться на виду. -->
    <div class="min-h-0 flex-1 overflow-y-auto px-4 sm:max-h-[min(60vh,32rem)]">
      <RoomRulesRows
        rules={roomRules}
        busy={rulesBusy}
        instance={oracleLimits}
        ownKernels={session.ownKernels}
        onchange={setRule}
      />
    </div>
    <!--
      Конец занятия — здесь, под правилами, а не восьмой строкой среди них.

      Правило отвечает на «кому можно», а это — «идёт ли пара»: оно накрывает
      все восемь разом и снимается тем же нажатием, и выбранные правила при
      этом остаются на месте, чтобы вернуться, когда занятие продолжат.
    -->
    <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3">
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-ui font-semibold text-ink">
          {session.finished ? tr('room.ui.843') : tr('room.ui.930')}
        </p>
        <p class="mt-0.5 text-2xs leading-snug text-muted">
          {#if session.finished} {tr('room.ui.931')} {:else} {tr('room.ui.932')} {/if}
        </p>
      </div>
      <!-- Как «Перезапустить ядро»: без связи нажатие никуда не уйдёт, и
           кнопка, сделавшая вид, что ушло, здесь дороже прочих — половина
           комнаты продолжит печатать в занятии, которое, как кажется,
           закончили. -->
      <button
        type="button"
        class="btn-outline h-[30px] shrink-0 text-2xs font-semibold"
        disabled={controlDisabled(session.connected)}
        title={controlTitle(
          session.connected,
          session.finished
            ? tr('room.extra.411')
            : tr('room.extra.412'),
        )}
        onclick={() => setClassOver(!session.finished)}
      >
        {session.finished ? tr('room.ui.909') : tr('room.ui.933')}
      </button>
    </div>
    <!--
      Второй строкой — то, что видно из зала.

      Ужесточение правила действует раньше, чем о нём узнают чужие браузеры:
      кадр, вылетевший до рассылки, гейт уже не принимает, и такой вкладке
      приходится пересобрать документ перезагрузкой (см. `lib/refusal.ts`).
      Попадает в это окно тот, кто печатал в ту самую секунду, — и он увидит
      окно «Правка не сохранена». Обещать ему обратное — значит объяснять
      ему потом, что сломалось.
    -->
    <p class="shrink-0 border-t border-line px-4 py-2 text-2xs text-muted"> {tr('room.ui.934')} </p>
  </div>
{/if}

<!--
  Вкладка разошлась с сервером и больше не пробует сама — см. SessionState.stuck.
  Полоса, а не тост: тост закрывают крестиком и остаются с мёртвой тетрадью,
  которая выглядит живой. Единственное действие — перезагрузка рукой, и она
  начинает счёт перезагрузок заново.

  Не на пульте: там про расхождение говорит сам ConsoleView — своими словами,
  своим размером под палец и с обещанием, что лекция не прервалась. Иначе об
  одном и том же говорили бы дважды: его лист внутри обёртки пульта и эта
  полоса поверх неё.
-->
{#if session.stuck && !session.gone && !pult}
  <!-- И тоже поверх проекции (z-90). До сих пор она лежала под ней: после
       второго отказа кэшу балка оставалась с застывшей страницей и без
       причины на экране. Полоса снизу, а не плашка во весь экран: комната под
       ней всё ещё читается, а лекция на балке всё ещё видна залу. -->
  <div
    class="fixed inset-x-0 bottom-0 z-[100] flex justify-center border-t border-line bg-raised px-4 py-3
           pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    role="alert"
  >
    <div class="flex w-full max-w-2xl items-center gap-3">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
      <p class="min-w-0 flex-1 text-ui leading-snug text-ink">{session.stuck}</p>
      <button type="button" class="btn-primary shrink-0" onclick={() => reloadByHand()}> {tr('room.ui.151')} </button>
    </div>
  </div>
{/if}

<!--
  ОДИН стек уведомлений на комнату.

  Здесь стояли пять независимых `{#if}` с одинаковыми координатами — bottom-4,
  по центру, — и два одновременных накладывались буква на букву. Случай не
  редкий и самый неудачный из возможных: преподаватель ужесточил правило
  (строка живёт шесть секунд), студент в ту же секунду нажал Run и получил
  красную строку отказа — ровно поверх объяснения, почему ему отказали.

  Порядок в колонке — снизу вверх по важности: ошибка у самой кромки, там же,
  где она была, когда стояла одна; спокойные объявления встают над ней. Каждая
  строка приезжает и уходит своей анимацией, стек только держит их в ряд.

  Ниже — те же нижние отступы: с `viewport-fit=cover` (index.html) четыре
  пикселя под домашним индикатором значат, что крестик оказался под системным
  свайпом. И тот же подъём над полосой «разошлись с сервером»: она занимает
  кромку целиком, и садиться на неё стеку некуда.

  Пульт и проекция рисуют свои строки сами и по-своему: у пульта своя,
  по-русски и без крестика под ладонь, а на балке любая всплывшая плашка — это
  плашка, которую читает весь зал.
-->
{#if !session.gone && !pult && !projection}
  <div
    class={cn(
      'pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4',
      'pb-[env(safe-area-inset-bottom)]',
      session.stuck ? 'bottom-[4.75rem]' : 'bottom-4',
    )}
  >
    <!--
      Пульт закрыли, а лекция идёт.

      Уход из пульта — это не конец пары, и объявить об этом надо ровно один
      раз: без строки человек, промахнувшийся мимо кнопки, ищет пропавшую
      лекцию, а не дорогу обратно. Кнопка рядом с фразой, потому что вернуться
      нужно ЗДЕСЬ и СЕЙЧАС — на пульт из комнаты другого пути нет: адрес его
      никто не помнит, а ссылку-ключ пришлось бы просить заново.
    -->
    {#if pultNoticeUp}
      <div
        role="status"
        class={cn(TOAST, 'items-center py-1.5 pl-3 pr-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
        <p class="min-w-0 flex-1 text-ui leading-snug text-muted">{tr('room.ui.935')}</p>
        <button
          class="btn-ghost h-6 px-2 text-2xs font-bold uppercase tracking-label"
          onclick={toPult}
        > {tr('room.ui.936')} </button>
      </div>
    {/if}

    <!--
      Правила изменились — одна строка, и она уходит сама.

      Двадцать человек, у которых редакторы вдруг стали «только чтение» без
      единой фразы, решат, что сломались их ноутбуки. Строка спокойная, не как
      ошибка: это не поломка, а решение преподавателя, и сказано оно ровно один
      раз.
    -->
    {#if rulesNoticeUp}
      <div
        role="status"
        class={cn(TOAST, 'items-center px-3 py-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
        <p class="min-w-0 flex-1 text-ui leading-snug text-muted"> {tr('room.ui.937')} </p>
      </div>
    {/if}

    <!--
      Занятие кончилось — или пошло снова. Теми же шестью секундами и тем же
      спокойным тоном, что и строка про правила: это не поломка, а решение
      преподавателя, и сказать его надо ровно один раз. Что было и осталось —
      тетрадь, файлы, лента — стоит в самой фразе: гаснут кнопки, а не комната.
    -->
    {#if classNoticeUp}
      <div
        role="status"
        class={cn(TOAST, 'items-center px-3 py-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
        <p class="min-w-0 flex-1 text-ui leading-snug text-muted">
          {#if session.finished} {tr('room.ui.938')} {:else} {tr('room.ui.939')} {/if}
        </p>
      </div>
    {/if}

    <!-- Ядро не поднялось, и ведущий может это исправить: тоном ошибки, до крестика. -->
    {#if adviceUp}
      <div
        role="status"
        class={cn(TOAST, 'items-start py-2 pl-3 pr-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
        <p class="min-w-0 flex-1 break-words py-0.5 text-ui leading-snug text-muted">{kernelAdvice}</p>
        <button
          class="btn-ghost h-6 w-6 shrink-0 px-0"
          onclick={() => (adviceDismissed = kernelAdvice)}
          aria-label={tr('room.ui.941')}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}

    <!-- Кэш был старше сервера, вкладка собралась заново, текста не пропало. -->
    {#if staleNotice}
      <div
        role="status"
        class={cn(TOAST, 'items-start py-2 pl-3 pr-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-faint"></span>
        <p class="min-w-0 flex-1 break-words py-0.5 text-ui leading-snug text-muted"> {tr('room.ui.940')} </p>
        <button
          class="btn-ghost h-6 w-6 shrink-0 px-0"
          onclick={() => (staleNotice = false)}
          aria-label={tr('room.ui.941')}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}

    <!-- Ошибка — у самой кромки: это единственная строка, которая говорит, что
         нажатие НЕ сработало, и читать её надо первой. -->
    {#if session.lastError}
      <div
        role="status"
        class={cn(TOAST, 'items-start py-2 pl-3 pr-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
        <p class="min-w-0 flex-1 break-words py-0.5 text-ui leading-snug text-muted">
          {tr(session.lastError)}
        </p>
        <button
          class="btn-ghost h-6 w-6 shrink-0 px-0"
          onclick={() => session.dismissError()}
          aria-label={tr('room.ui.941')}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}
  </div>
{/if}

<!-- One scrolling rail: the artboards stack both groups at the top of the
     column, and each brings its own header rule, so there is nothing between
     them but the 24px the panels already carry. -->
{#snippet leftPanels()}
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <FilesPanel
      onopen={openFile}
      active={activePath}
      onrename={(from, to) => tabs.rename(from, to)}
      onrun={runFile}
    />
    <PeoplePanel />
  </div>
{/snippet}

<style>
  /*
   * The seminar name is a heading that happens to be editable, so it has to be
   * exactly as wide as its text — a field at its default width would leave the
   * date stranded in the middle of the band. Chrome sizes it from the content;
   * anywhere else the input keeps the old behaviour and takes the row, which
   * still reads correctly, just with the date at the far edge.
   */
  .name-field {
    field-sizing: content;
    max-width: 100%;
  }

  @supports not (field-sizing: content) {
    .name-field {
      flex: 1 1 auto;
    }
  }
</style>
