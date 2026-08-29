<script lang="ts">
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
  import { cubicOut } from 'svelte/easing'
  import { fade, fly } from 'svelte/transition'
  import { peopleInRoom } from '@/lib/room'
  import { REVEAL_EVENT, revealCell, type RevealTarget } from '@/lib/reveal'
  import { gridFaviconHref } from '@/lib/logo'
  import AvatarStack from '@/components/ui/AvatarStack.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Notebook from '@/components/notebook/Notebook.svelte'
  import AiPanel from '@/components/panels/AiPanel.svelte'
  import FilesPanel from '@/components/panels/FilesPanel.svelte'
  import PeoplePanel from '@/components/panels/PeoplePanel.svelte'
  import TerminalDrawer from '@/components/panels/TerminalDrawer.svelte'
  import PdfReader from '@/components/reader/PdfReader.svelte'
  import LectureView from '@/components/lecture/LectureView.svelte'
  import ConsoleView from '@/components/lecture/ConsoleView.svelte'
  import { fullscreenPossible, goFullscreen, leaveFullscreen } from '@/lib/fullscreen'
  import { keepAwake } from '@/lib/wakelock'
  import ImageView from '@/components/reader/ImageView.svelte'
  import ThemeSwitch from '@/components/ui/ThemeSwitch.svelte'
  import Wordmark from '@/components/ui/Wordmark.svelte'
  import type { StoredIdentity } from '@/lib/identity'
  import { SessionState, setSessionState } from '@/lib/session.svelte'
  import { cn, prefersReducedMotion } from '@/lib/utils'
  import { watchBooks, watchCellNumbers, watchNotebookMeta } from '@/lib/yreactive.svelte'
  import { getMeta, rootOfCell, type KernelStatus } from '@shared/notebook'
  import type { SessionInfo } from '@shared/protocol'
  import { copyText } from '@/lib/clipboard'
  import { takeRefusal } from '@/lib/refusal'
  import { permitsIn } from '@/lib/may'
  import TabStrip from '@/components/reader/TabStrip.svelte'
  import FileEditor from '@/components/editor/FileEditor.svelte'
  import FileBar from '@/components/editor/FileBar.svelte'
  import { leaderFor, sameLead, type Lead } from '@/lib/follow'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { Tabs } from '@/lib/tabs.svelte'
  import { holdFile, releaseFile, type FileDoc } from '@/lib/filedoc.svelte'
  import { baseOf, kindOf, runnerFor } from '@shared/paths'
  import { api } from '@/lib/api'
  import { readRules, type RoomRules } from '@shared/rules'
  import RoomRulesRows from '@/components/RoomRulesRows.svelte'

  interface Props {
    session: SessionInfo
    identity: StoredIdentity
    /**
     * Который из трёх экранов комнаты нарисован.
     *
     * `room` — семинар, как его видят все; `screen` — проекция на балке
     * (`/s/:id/screen`); `pult` — пульт в руках у преподавателя
     * (`/s/:id/pult`). Один проп, а не два флага: экраны взаимоисключающие, и
     * пара булевых умела бы означать то, чего не бывает.
     *
     * Все три живут в ОДНОМ компоненте, потому что живут на одном соединении:
     * `SessionState` создаётся ниже один раз, и переход между экранами его не
     * трогает — сокеты, документ и присутствие остаются на месте.
     */
    mode?: 'room' | 'screen' | 'pult'
    /** Уйти на другой адрес, не пересобирая комнату. */
    onnavigate?: (to: string) => void
  }

  let { session: info, identity, mode = 'room', onnavigate }: Props = $props()

  const projection = $derived(mode === 'screen')
  const pult = $derived(mode === 'pult')

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
  const refusal = takeRefusal(info.id)
  let refusalShown = $state(refusal !== null)
  let refusalCopied = $state(false)

  async function copyRefused(): Promise<void> {
    if (!refusal) return
    await copyText(refusal.text)
    refusalCopied = true
    setTimeout(() => (refusalCopied = false), 1600)
  }

  /* --------------------------------------------------- пульт правил комнаты */

  let rulesOpen = $state(false)
  let rulesBusy = $state(false)
  const roomRules = $derived(readRules(session.session.rules))

  /**
   * Один переключатель — один запрос.
   *
   * Присланное накладывается на текущее на сервере, а не заменяет его: экран,
   * трогающий одну строку, не должен уметь молча вернуть остальные семь к
   * умолчаниям. Ответ приходит и сюда, и всей комнате — рассылкой по
   * управляющему сокету, так что своё же изменение прилетит обратно тем же
   * путём, что и чужое.
   */
  async function setRule(patch: Partial<RoomRules>) {
    rulesBusy = true
    try {
      const body = await api.setRoomRules(session.session.id, identity.token, patch)
      session.session = { ...session.session, rules: body.rules }
    } catch (err) {
      session.showError(err instanceof Error ? err.message : 'Правило не сохранилось.')
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
  setSessionState(session)
  onDestroy(() => session.destroy())

  const meta = watchNotebookMeta(session.doc)
  const storedTitle = $derived(meta.current.title)
  const title = $derived(storedTitle || info.name)
  const isHost = $derived(session.me.role === 'host')

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
  const dateLong = started.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

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
  const room = $derived(
    inRoom.map((person) => ({
      id: person.user.id,
      name: person.user.name,
      avatar: person.user.avatar,
      color: person.user.color,
      title: person.isSelf ? `${person.user.name} (you)` : person.user.name,
    })),
  )
  const roomNames = $derived(
    inRoom.map((person) => (person.isSelf ? `${person.user.name} (you)` : person.user.name)).join(', '),
  )

  /*
   * The live state of the machine, in the words the states sheet uses.
   *
   * The dot is the only coloured thing here: on the brand ground the label has
   * to stay white in both themes, because `danger` and `warning` are tuned for
   * the canvas and neither clears AA against navy. So the colour signals and
   * the word informs — which is also why a dead kernel gets a plate rather than
   * red type.
   */
  const KERNEL: Record<KernelStatus, { label: string; dot: string; alarm: boolean }> = {
    starting: { label: 'STARTING', dot: 'bg-white/35', alarm: false },
    restarting: { label: 'RESTARTING', dot: 'bg-white/35', alarm: false },
    idle: { label: 'IDLE', dot: 'bg-white/50', alarm: false },
    busy: { label: 'RUNNING', dot: 'bg-accent', alarm: false },
    dead: { label: 'KERNEL DEAD', dot: 'bg-danger', alarm: true },
  }

  const kernel = $derived(KERNEL[meta.current.kernelStatus])

  /* ------------------------------------------------------------- layout */

  const PANELS_KEY = 'colloq.panels.v1'

  function loadPanels(): { left: boolean; right: boolean } {
    try {
      const raw = localStorage.getItem(PANELS_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as { left?: boolean; right?: boolean }
        return { left: saved.left !== false, right: saved.right !== false }
      }
    } catch {
      /* private browsing; the default layout is fine */
    }
    return { left: true, right: true }
  }

  const panels = loadPanels()
  let leftOpen = $state(panels.left)
  let rightOpen = $state(panels.right)
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

  const may = $derived(permitsIn(session.session.rules, session.me.role))

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
  const activePath = $derived(typeof tabs.active === 'string' ? tabs.active : null)
  const activeKind = $derived(activePath ? kindOf(activePath) : null)

  /** Тетради комнаты: список живёт в документе и приходит ко всем. */
  const books = watchBooks(session.doc)
  /*
   * Первый заход в комнату открывает её тетрадь.
   *
   * Один раз и только человеку, который здесь впервые: закрыв всё, он получает
   * пустой центр и подсказку слева, и открывать тетрадь заново каждым заходом
   * значило бы отменять его же решение.
   */
  let seeded = false
  $effect(() => {
    if (seeded || !tabs.firstVisit) return
    const first = books.current[0]
    if (!first) return
    seeded = true
    untrack(() => tabs.open(first.path))
  })

  /** Что читалка сообщает наружу: строка вкладок показывает это за неё. */
  let readerPage = $state(1)
  let readerPages = $state(0)
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
  function toProjection(): void {
    void goFullscreen(document.documentElement)
    onnavigate?.(`/s/${session.session.id}/screen`)
  }

  function fromProjection(): void {
    void leaveFullscreen()
    onnavigate?.(`/s/${session.session.id}`)
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
    if (book) tabs.show(book.path)
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
   * Вкладка на файл, которого больше нет, — пустая область без объяснения.
   * Файл мог убрать преподаватель, а мог переписать `os.remove` в ячейке.
   */
  $effect(() => {
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
    untrack(() => tabs.keepOnly(alive))
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
    if (doc?.missing && activePath) tabs.close(activePath, session.board)
  })

  /**
   * Закрыть вкладку.
   *
   * Свою закрывает кто угодно; документ, стоящий на общем экране, убирает тот,
   * кому это разрешено, — и убирает у всех сразу. Если права нет, а документ
   * общий, уйти от него в тетрадь всё равно можно: смотреть никого не
   * заставляют, а вкладка остаётся стоять.
   */
  function closeTab(path: string): void {
    if (path === session.board && may.board) {
      session.send({ t: 'board:close' })
      tabs.show(null)
      return
    }
    tabs.close(path, session.board)
  }

  /**
   * Открыть файл из панели.
   *
   * PDF у преподавателя уезжает на общий экран комнаты — это лекция, её смотрят
   * вместе. Всё остальное открывается себе: у скрипта нет «общего экрана», его
   * правят и запускают, а кто рядом — видно по точкам в дереве.
   */
  function openFile(path: string): void {
    if (kindOf(path) === 'pdf' && may.board) {
      session.send({ t: 'board:open', name: path })
      tabs.show(path)
      return
    }
    /*
     * .ipynb, который ещё не тетрадь, надо сперва внести в комнату: ячейки
     * переезжают из файла в документ, и это делает сервер один раз, а не
     * двадцать браузеров наперегонки. Вкладка открывается сразу и до прихода
     * тетради говорит «открываю» — это честнее, чем не реагировать на нажатие.
     */
    if (kindOf(path) === 'notebook' && !books.current.some((book) => book.path === path)) {
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
      localStorage.setItem(PANELS_KEY, JSON.stringify({ left: leftOpen, right: rightOpen }))
    } catch {
      /* ignore */
    }
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
    if (terminalOpen && (status === 'closed' || status === 'dead')) {
      session.send({ t: 'term:open' })
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    // Ctrl+` reaches the terminal from anywhere, including a focused cell.
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Backquote') {
      event.preventDefault()
      toggleTerminal()
      return
    }
    if (event.key !== 'Escape') return
    if (rightDrawer) {
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
      session.showError(`The browser blocked the clipboard. The link is ${location.origin}/s/${info.id}`)
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
   */
  const bandIcon = (on: boolean) =>
    cn(
      'flex h-7 w-7 shrink-0 items-center justify-center text-white',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
      'transition-[background-color,opacity,transform] duration-quick ease-out active:scale-95',
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
        <span class="text-2xs font-bold uppercase tracking-institution text-white/40">
          проекция
        </span>
        <p class="text-marquee-sm font-black text-white">{title}</p>
        <p class="max-w-md text-ui text-white/50">
          Экран готов. Он покажет документ, как только преподаватель начнёт лекцию.
        </p>
        <div class="mt-4 flex items-center gap-2">
          {#if fullscreenPossible()}
            <button
              type="button"
              class="border border-white/20 px-3 py-1.5 text-2xs font-bold uppercase tracking-label text-white/70 transition-colors duration-100 hover:border-white/40 hover:text-white"
              onclick={() => void goFullscreen(document.documentElement)}
            >
              Во весь экран
            </button>
          {/if}
          <button
            type="button"
            class="px-3 py-1.5 text-2xs font-bold uppercase tracking-label text-white/40 transition-colors duration-100 hover:text-white/70"
            onclick={fromProjection}
          >
            Вернуться в комнату
          </button>
        </div>
      </div>
    {/if}
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
  <div class="fixed inset-0 z-[95] bg-canvas">
    <ConsoleView onexit={leavePult} />
  </div>
{:else}
<div class="flex h-full min-h-0 flex-col overflow-hidden bg-canvas">
  <!--
    Two bands, one brand ground. The navy is the printed object the room is
    held in — the same in both themes, like the join poster — so nothing in
    here reads a theme token that flips. White, translucent white, `brand-2`
    and `accent` are the entire palette above the workspace, and every one of
    them resolves to the same value on either side of the switch.
  -->
  <header class="shrink-0 bg-brand">
    <div class="px-4 pt-4 sm:px-7">
      <a
        href="/"
        aria-label="Back to Colloq"
        class="block max-w-full transition-opacity duration-100 hover:opacity-85
               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <Wordmark faculty tone="onDark" />
      </a>
    </div>

    <!-- The loudest thing on the screen. Black rather than bold: HSE Sans Black
         is what the artboard is drawn in, and Inter at 700 reads thin here. -->
    <div class="flex items-end gap-3 px-4 pb-4 pt-2 sm:gap-4 sm:px-7 sm:pb-5 sm:pt-3">
      {#if isHost}
        <!-- Renaming writes into the shared doc, so the room sees it immediately. -->
        <input
          class="name-field -mx-1.5 min-w-0 truncate bg-transparent px-1.5 text-marquee-sm
                 font-black text-white hover:bg-white/5 focus:bg-white/10 sm:text-marquee"
          value={storedTitle}
          oninput={(event) => rename(event.currentTarget.value)}
          aria-label="Seminar title"
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

    <!-- The live state of the room: who is here, what the machine is doing, and
         the two controls that are about this room rather than about the
         notebook inside it. -->
    <!--
      45, а не 44: правило сверху съедает пиксель из коробки содержимого, и в
      оставшихся 43 всякий чётный по высоте ребёнок центрируется на половине
      пикселя. Круги от этого размывались по кольцу, а на 1x — заметно.
    -->
    <div class="flex h-[45px] items-center gap-3 border-t border-brand-2 px-4 sm:gap-4 sm:px-7">
      {#if room.length > 0}
        <div class="flex shrink-0 items-center gap-4" title={roomNames}>
          <!-- 28, как на экране входа: 24 в этой полосе читались мелко, а
               человек в комнате — единственное, что здесь про людей. -->
          <AvatarStack people={room} max={4} size={28} ring="rgb(var(--brand))" tone="onDark" />
          <span
            class="hidden shrink-0 text-2xs font-bold uppercase tracking-label text-white/80 sm:inline"
          >
            {room.length} in the room
          </span>
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
        title={session.connected ? undefined : 'Last known — the connection dropped'}
        role="status"
      >
        <span class={cn('h-1.5 w-1.5 shrink-0 rounded-full', kernel.dot)} aria-hidden="true"></span>
        <span class="text-2xs font-bold uppercase tracking-label text-white">{kernel.label}</span>
        {#if !kernel.alarm}
          <span class="hidden font-mono text-2xs text-white/60 lg:inline">python3</span>
        {/if}
      </div>

      {#if !session.connected}
        <div
          class="flex shrink-0 items-center gap-2 text-white"
          role="status"
          transition:fade={{ duration: 120 }}
        >
          <Icon name="spinner" size={12} class="animate-spin" />
          <span class="text-2xs font-bold uppercase tracking-label">Reconnecting</span>
        </div>
      {/if}

      <span class="min-w-0 flex-1"></span>

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
            aria-label="Что можно делать в комнате"
            title="Что можно делать в комнате"
          >
            <Icon name="lock" size={16} />
          </button>
        {/if}
        <button
          class={bandIcon(leftShown)}
          onclick={toggleLeft}
          aria-pressed={leftShown}
          aria-label="Toggle files and people"
          title="Files and people"
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
          aria-label="Терминал, журнал ядра и история"
          title="Терминал, журнал ядра и история — Ctrl+`"
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
              title={`${session.terminalUnread} непрочитанных сообщений ядра`}
            >
              {session.terminalUnread > 9 ? '9+' : session.terminalUnread}
            </span>
          {/if}
        </button>
        <button
          class={bandIcon(rightShown)}
          onclick={toggleRight}
          aria-pressed={rightShown}
          aria-label="Toggle the AI oracle"
          title="AI oracle"
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
          title="Copy the seminar link"
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          <span class="text-2xs font-bold uppercase tracking-label">
            {copied ? 'Copied' : 'Copy'}
          </span>
        </button>
      </div>
    </div>
  </header>

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
          page={readerPage}
          pages={readerPages}
          onshow={(key) => tabs.show(key)}
          onclose={closeTab}
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
              if ((event.target as HTMLElement | null)?.closest('[data-cell-id]')) return
              if (session.selection.length > 0) session.selectCell(null)
            }}
          >
            {#if books.current.some((book) => book.path === path)}
              <Notebook book={path} active={activePath === path} />
            {:else}
              <div class="flex h-full items-center justify-center text-ui text-muted">
                Открываю {baseOf(path)}…
              </div>
            {/if}
          </main>
        {/if}
      {/each}

      {#if activePath === null}
        <!--
          Ничего не открыто — это состояние, а не поломка: раньше его не было,
          потому что тетрадь нельзя было закрыть.
        -->
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p class="text-ui text-ink">Ничего не открыто.</p>
          <p class="text-2xs text-muted">Файлы и тетради комнаты — в панели слева.</p>
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
          <PdfReader
            file={activePath}
            shared={activePath === session.board}
            mayLead={may.board && lecture === null}
            backToLecture={lectureHere ? () => (soloRead = false) : null}
            {catchUp}
            {lead}
            bind:page={readerPage}
            bind:pages={readerPages}
          />
        {/if}
      {:else if activePath && activeKind === 'text'}
        {#if activeDoc}
          {#key activePath}
            <FileEditor
              file={activeDoc}
              readOnly={!may.files || activeDoc.refused}
              onrun={runnerFor(activePath) && may.run ? () => runFile(activePath) : null}
            />
          {/key}
        {:else}
          <div class="flex min-h-0 flex-1 items-center justify-center text-ui text-muted">
            Открываю {baseOf(activePath)}…
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
          <p class="text-ui text-ink">{baseOf(activePath)} — не текст.</p>
          <p class="text-2xs text-muted">
            Такой файл можно скачать или прочитать из ячейки; открывать его в
            редакторе значило бы показать мусор и предложить его сохранить.
          </p>
        </div>
      {/if}

      {#if terminalOpen}
        <TerminalDrawer bind:tab={drawerTab} onclose={() => (terminalOpen = false)} />
      {/if}
    </div>

    {#if rightShown && !rightIsDrawer}
      <aside class="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface">
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
    -->
    {#if leftIsDrawer && leftDrawer}
      <div class="absolute inset-0 z-40 flex">
        <button
          class="absolute inset-0 bg-canvas/70"
          aria-label="Close the files panel"
          onclick={() => (leftDrawer = false)}
          transition:fade={{ duration: 120 }}
        ></button>
        <aside
          class="relative flex w-60 max-w-[85vw] flex-col border-r border-line bg-surface shadow-pop"
          transition:fly={{ x: prefersReducedMotion() ? 0 : -140, duration: 140, easing: cubicOut }}
        >
          {@render leftPanels()}
        </aside>
      </div>
    {/if}

    {#if rightIsDrawer && rightDrawer}
      <div class="absolute inset-0 z-40 flex justify-end">
        <button
          class="absolute inset-0 bg-canvas/70"
          aria-label="Close the AI panel"
          onclick={() => (rightDrawer = false)}
          transition:fade={{ duration: 120 }}
        ></button>
        <aside
          class="relative flex w-[380px] max-w-[92vw] flex-col border-l border-line bg-surface shadow-pop"
          transition:fly={{ x: prefersReducedMotion() ? 0 : 140, duration: 140, easing: cubicOut }}
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
{#if session.gone}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-canvas/95 px-6">
    <div class="w-full max-w-sm text-center">
      <span
        class="mx-auto flex h-10 w-10 items-center justify-center border border-line bg-surface text-faint"
      >
        <Icon name="link" size={16} />
      </span>
      <h1 class="mt-4 text-title font-semibold tracking-tight text-ink">Этот семинар удалён</h1>
      <p class="mt-2 text-ui text-muted">
        Комнаты больше нет: ни ноутбука, ни файлов, ни истории. Ссылка тоже
        перестала работать — если она нужна была, спросите преподавателя.
      </p>
    </div>
  </div>
{/if}

{#if refusal && refusalShown}
  <!--
    Модальное, а не строкой: человек только что потерял несколько секунд работы,
    и текст, который он не успеет прочитать, — это тот же потерянный текст.
  -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="refused-title"
    class="fixed inset-0 z-[60] flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="flex max-h-full w-full max-w-[520px] flex-col border border-line bg-canvas shadow-pop">
      <div class="border-b border-line px-5 py-3.5">
        <h2 id="refused-title" class="text-title font-semibold text-ink">Эту правку не приняли</h2>
        <p class="mt-1 text-ui leading-snug text-muted">{refusal.message}</p>
      </div>
      {#if refusal.text}
        <div class="min-h-0 flex-1 overflow-y-auto border-b border-line bg-surface px-5 py-3">
          <p class="pb-1.5 text-2xs font-bold uppercase tracking-caps text-muted">
            Вот что было в вашей ячейке
          </p>
          <pre
            class="whitespace-pre-wrap break-words font-mono text-code leading-relaxed text-ink">{refusal.text}</pre>
        </div>
      {/if}
      <div class="flex items-center gap-2 px-5 py-3">
        {#if refusal.text}
          <button type="button" class="btn-ghost" onclick={() => void copyRefused()}>
            {refusalCopied ? 'Скопировано' : 'Скопировать'}
          </button>
        {/if}
        <span class="flex-1"></span>
        <button type="button" class="btn-primary" onclick={() => (refusalShown = false)}>
          Понятно
        </button>
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
{#if rulesOpen && isHost && !session.gone}
  <div
    class="fixed inset-0 z-40"
    role="presentation"
    onclick={() => (rulesOpen = false)}
    onkeydown={(event) => {
      if (event.key === 'Escape') rulesOpen = false
    }}
  ></div>
  <div
    class="fixed right-3 top-[104px] z-50 w-[min(30rem,calc(100vw-1.5rem))] border border-line bg-raised shadow-pop sm:right-6"
    role="dialog"
    aria-label="Что можно делать в комнате"
    transition:fly={{ y: prefersReducedMotion() ? 0 : -6, duration: 140, easing: cubicOut }}
  >
    <div class="flex items-center gap-2 border-b border-line px-4 py-2.5">
      <h2 class="text-2xs font-bold uppercase tracking-section text-muted">
        Что можно делать в комнате
      </h2>
      <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
      <button
        class="btn-ghost h-6 w-6 shrink-0 px-0"
        onclick={() => (rulesOpen = false)}
        aria-label="Закрыть"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
    <div class="max-h-[min(60vh,32rem)] overflow-y-auto px-4">
      <RoomRulesRows rules={roomRules} busy={rulesBusy} onchange={setRule} />
    </div>
    <p class="border-t border-line px-4 py-2 text-2xs text-muted">
      Комната узнаёт сразу — перезаходить никому не нужно.
    </p>
  </div>
{/if}

<!--
  Правила изменились — одна строка, и она уходит сама.

  Двадцать человек, у которых редакторы вдруг стали «только чтение» без единой
  фразы, решат, что сломались их ноутбуки. Строка спокойная, не как ошибка: это
  не поломка, а решение преподавателя, и сказано оно ровно один раз.
-->
<!--
  Пульт закрыли, а лекция идёт.

  Уход из пульта — это не конец пары, и объявить об этом надо ровно один раз:
  без строки человек, промахнувшийся мимо кнопки, ищет пропавшую лекцию, а не
  дорогу обратно. Кнопка рядом с фразой, потому что вернуться нужно ЗДЕСЬ и
  СЕЙЧАС — на пульт из комнаты другого пути нет: адрес его никто не помнит, а
  ссылку-ключ пришлось бы просить заново.
-->
{#if pultNoticeUp && mode === 'room' && !session.gone}
  <div
    class="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4
           pb-[env(safe-area-inset-bottom)]"
  >
    <div
      role="status"
      class="pointer-events-auto flex items-center gap-2 border border-line bg-raised py-1.5 pl-3 pr-1.5 shadow-pop"
      transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: cubicOut }}
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
      <p class="text-ui leading-snug text-muted">Пульт закрыт, лекция идёт.</p>
      <button
        class="btn-ghost h-6 px-2 text-2xs font-bold uppercase tracking-label"
        onclick={toPult}
      >
        Вернуться к пульту
      </button>
    </div>
  </div>
{/if}

{#if rulesNoticeUp && !session.gone}
  <div
    class="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4
           pb-[env(safe-area-inset-bottom)]"
  >
    <div
      role="status"
      class="pointer-events-none flex items-center gap-2 border border-line bg-raised px-3 py-1.5 shadow-pop"
      transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: cubicOut }}
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
      <p class="text-ui leading-snug text-muted">
        Преподаватель изменил, что можно делать в этой комнате.
      </p>
    </div>
  </div>
{/if}

<!-- Нижние отступы у всех трёх строк — с `viewport-fit=cover` (index.html)
     четыре пикселя ниже домашнего индикатора значат, что кнопка «закрыть»
     оказалась под системным свайпом. -->
<!--
  Полосу ошибки пульт и проекция рисуют сами и по-своему.

  Эта — общая комнатная: она ложится поверх всего с `z-50`, говорит
  по-английски («Waiting for the connection…») и приносит с собой крестик,
  который на планшете нажимают ладонью. Пульт про обрыв связи уже сказал
  своей строкой и своими словами, а на проекции в аудитории любая всплывшая
  плашка — это плашка, которую читает весь зал.
-->
{#if session.lastError && !session.gone && !pult && !projection}
  <div
    class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4
           pb-[env(safe-area-inset-bottom)]"
  >
    <div
      role="status"
      class="pointer-events-auto flex max-w-lg items-start gap-2 border border-line bg-raised py-2 pl-3 pr-1.5 shadow-pop"
      transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: cubicOut }}
    >
      <span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
      <p class="min-w-0 flex-1 break-words py-0.5 text-ui leading-snug text-muted">
        {session.lastError}
      </p>
      <button
        class="btn-ghost h-6 w-6 shrink-0 px-0"
        onclick={() => session.dismissError()}
        aria-label="Dismiss"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
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
