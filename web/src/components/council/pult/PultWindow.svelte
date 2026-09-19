<script lang="ts">
  import { tr } from '@shared/i18n'
  import './pult.css'
  /** Private teacher console: work, execution queue and class summary share
   * the room connection. Only explicit projection actions change the class screen. */
  import { tick, untrack } from 'svelte'
  import { DEFAULT_COUNCIL, findCell, type CouncilSettings } from '@shared/notebook'
  import type { CouncilAttempt } from '@shared/protocol'
  import { api } from '@/lib/api'
  import { askToBan, banTargetOf } from '@/lib/bans'
  import { OFFLINE_REASON } from '@/lib/controls'
  import { groupAttempts } from '@/lib/council-board'
  import {
    heldArrivals,
    holdsArrivals,
    kernelView,
    listRows,
    moveCursor,
    neighbourInGroup,
    pultKeyAction,
    pultShortcutAllowed,
    type PultView,
    pultPresence,
    rulesSentence,
    runStats,
    selectable,
    unreadIds,
    variantNumbers,
    type PultFilter,
    type PultFocus,
    type PultRule,
  } from '@/lib/council-pult'
  import { announcePult, savePultPlace } from '@/lib/council-pult-window'
  import { getSessionState } from '@/lib/session.svelte'
  import { cn, spell } from '@/lib/utils'
  import PultFilters from './PultFilters.svelte'
  import PultHeader from './PultHeader.svelte'
  import PultKeys from './PultKeys.svelte'
  import PultList from './PultList.svelte'
  import PultOnScreen from './PultOnScreen.svelte'
  import PultOracleTab from './PultOracleTab.svelte'
  import PultQueueStrip from './PultQueueStrip.svelte'
  import PultRules from './PultRules.svelte'
  import PultStatusLine from './PultStatusLine.svelte'
  import PultWork from './PultWork.svelte'

  interface Props {
    cellId: string
    /** Возврат в тетрадь: закрыть отдельное окно или перейти по адресу комнаты. */
    onexit: () => void
  }

  let { cellId, onexit }: Props = $props()

  const session = getSessionState()
  const host = $derived(session.me.role === 'host')
  let rosterReady = $state(false)
  $effect(() => {
    const provider = session.provider
    const sync = (ready: boolean): void => { rosterReady = ready }
    sync(provider.synced)
    provider.on('sync', sync)
    return () => provider.off('sync', sync)
  })
  const presenceKnown = $derived(session.connected && rosterReady)

  /* ------------------------------------------------------------ окно */

  // Стук соседнему окну: по нему кнопка под ячейкой знает, что окно живо.
  $effect(() => announcePult(session.session.id, cellId))

  /**
   * Место окна — на комнату, лучшим усилием.
   *
   * События «окно передвинули» у браузера нет; `resize` ловит только размер, а
   * переезд на второй монитор — ничего. Раз в секунду — достаточно точно для
   * того, чтобы второй раз открыться туда же, и дёшево: четыре чтения.
   */
  $effect(() => {
    const id = session.session.id
    const timer = setInterval(() => {
      savePultPlace(id, {
        left: window.screenX,
        top: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
      })
    }, 1000)
    return () => clearInterval(timer)
  })

  /** Живые часы окна: счётчики «считает 3,1 с» и «в кадре 1:40». */
  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(timer)
  })

  /* ----------------------------------------------------------- телефон */

  /**
   * Узкое окно — два экрана вместо двух колонок.
   *
   * Пульт пробовали с телефона на паре 19.09: «пролистать список всех
   * студентов невозможно». Две колонки в 390 px шириной — это список высотой в
   * половину строки под шапкой, вкладками, полосой, счётчиками, поиском и
   * чипами. Мессенджер в этом месте устроен одинаково везде и не зря: сперва
   * список во весь экран, нажатие открывает разговор во весь экран, назад
   * возвращает к списку.
   *
   * Порог тот же, что у остальных правил узкого окна (650 px), и читается он
   * через matchMedia, а не по ширине из resize: у `matchMedia` тот же порог,
   * что в CSS, и разойтись им нельзя.
   */
  let phone = $state(false)
  $effect(() => {
    const query = window.matchMedia('(max-width: 650px)')
    const sync = (): void => { phone = query.matches }
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  })
  let phonePane = $state<'list' | 'work'>('list')

  /**
   * Системный «назад» возвращает к списку, а не закрывает пульт.
   *
   * Адрес при этом не меняется: маршрут пульта — это ячейка (routes.ts), а не
   * то, на что в ней смотрят, и заводить под экран работы второй адрес значило
   * бы, что ссылка на пульт иногда открывается списком, а иногда чужой
   * работой. Поэтому запись истории своя, с тем же адресом и пометкой в
   * состоянии; жест «назад» её снимает, `popstate` возвращает список.
   */
  function toWork(): void {
    if (!phone || phonePane === 'work') return
    phonePane = 'work'
    history.pushState({ ...(history.state ?? {}), pultPane: 'work' }, '', location.href)
  }
  function toList(): void {
    if (phonePane !== 'work') return
    // Через историю, а не присваиванием: иначе запись о работе осталась бы в
    // стопке, и следующий «назад» уводил бы из пульта через пустой шаг.
    history.back()
  }
  $effect(() => {
    const back = (): void => { phonePane = 'list' }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  })

  /* --------------------------------------------------------- комната */

  const board = $derived(session.council.boards[cellId] ?? null)
  const shown = $derived(session.council.shown[cellId] ?? null)
  const settings = $derived<CouncilSettings>(board?.settings ?? DEFAULT_COUNCIL)
  const names = $derived(settings.namesOnProjector)
  const attempts = $derived(board?.attempts ?? [])
  const groups = $derived(groupAttempts(attempts, board?.oracle?.groupLabels ?? {}))
  const sizes = $derived(new Map(groups.map((group) => [group.key, group.count])))
  const variants = $derived(variantNumbers(attempts))
  const kernel = $derived(kernelView(attempts))
  const counts = $derived(board?.counts ?? { attempts: 0, submitted: 0, writing: 0, groups: 0 })
  const offline = $derived(!session.connected)
  const disabled = $derived(offline || !host)

  /** Номер ячейки обновляется при перестановке и удалении ячеек. */
  let cellIndex = $state<number | null>(null)
  $effect(() => {
    const doc = session.doc
    const id = cellId
    const refresh = (): void => {
      const found = findCell(doc, id)
      cellIndex = found ? found.index + 1 : null
    }
    refresh()
    doc.on('afterTransaction', refresh)
    return () => doc.off('afterTransaction', refresh)
  })

  /* -------------------------------------------------- состояние экрана */

  let filter = $state<PultFilter>('all')
  let search = $state('')
  let searching = $state(false)
  let cursor = $state<string | null>(null)
  /** Пришли с клавиатуры: только тогда у строки кольцо фокуса. */
  let keyboard = $state(false)
  let expanded = $state.raw<ReadonlySet<string>>(new Set())
  /** Чьи строки уже открывали: точка непрочитанного гаснет и не возвращается. */
  let seen = $state.raw<ReadonlySet<string>>(new Set())
  let tab = $state<PultView>('work')
  /**
   * Какой экран показан на телефоне; на широком окне видны оба.
   *
   * Очередь и оракул рисуются поверх слоя «список/работа» целиком, поэтому вне
   * вкладки работ экран всегда «список»: иначе после возврата из очереди
   * открывалась бы чужая работа без планки, которой её закрывают.
   */
  const pane = $derived(!phone ? 'both' : tab === 'work' ? phonePane : 'list')
  let helpOpen = $state(false)
  /**
   * Лист регламента: на каком правиле открыт и куда вернуть фокус.
   *
   * Правило хранится вместе с признаком «открыт», потому что лист всегда
   * открывают РАДИ правила — из предложения в шапке, из строки запуска, с
   * клавиши; строка этого правила подсвечена, и на ней же стоит фокус.
   * Возвращающий элемент запоминается самим открывающим: кнопка в шапке и
   * ссылка «предел 30 с» в работе — разные места, и «вернуть фокус туда, где
   * он был» значит именно туда, а не на первую попавшуюся.
   */
  let rulesOpen = $state(false)
  let rulesRule = $state<PultRule>('studentRun')
  /** Предложение в шапке и числа под пределом — по требованию: лист чаще закрыт. */
  const sentence = $derived(rulesSentence(settings))
  const stats = $derived(runStats(attempts))
  let rulesBack: HTMLElement | null = null
  /** Высота шапки: от её низа падает лист. Меняется от ширины окна и длины имени. */
  let headHeight = $state(0)
  let focus = $state<PultFocus>('list')
  type ReplyDraft = { text: string; toGroup: boolean; fromOracle: boolean; groupKey: string }
  // A draft belongs to its recipient, even when filters or live arrivals move the cursor.
  let oracleError = $state('')
  let replyDrafts = $state<Record<string, ReplyDraft>>({})
  const reply = $derived(cursor ? (replyDrafts[cursor]?.text ?? '') : '')
  const replyFromOracle = $derived(Boolean(cursor && replyDrafts[cursor]?.fromOracle))

  function updateReply(patch: Partial<ReplyDraft>): void {
    if (!cursor || !current) return
    replyDrafts[cursor] = {
      text: reply, toGroup: replyToGroup, fromOracle: replyFromOracle,
      groupKey: current.groupKey, ...patch,
    }
  }
  /** Момент открытия пульта: всё, что сдано раньше, непрочитанным не считается. */
  const openedAt = Date.now()

  /**
   * Придержанные сдачи.
   *
   * `frozenAt` — момент, с которого список перестал впускать новых: он ставится
   * не по таймеру, а по первому же прибытию, случившемуся, пока человек читает.
   * `null` — список открыт, всё попадает сразу.
   */
  let frozenAt = $state<number | null>(null)
  let held = $state.raw<ReadonlySet<string>>(new Set())

  const unread = $derived(unreadIds(attempts, openedAt, seen))

  /**
   * Набор строк отбора «новые» — тот, что НЕ ТАЕТ под курсором.
   *
   * Точка непрочитанного гаснет, как только строку открыли. Если бы отбор
   * «новые» читал живой набор, он вычёркивал бы строку ровно в тот момент,
   * когда её начали читать: курсор переезжает на следующую, гасит и её, —
   * и список опустошает сам себя за секунду, пока человек смотрит на первую
   * работу. Поэтому пока чип нажат, набор только пополняется, а очищается
   * при выходе из отбора: вернулись в «новые» — снова те, кто сдал с тех пор.
   */
  let newPool = $state.raw<ReadonlySet<string>>(new Set())
  $effect(() => {
    const live = unread
    const at = filter
    untrack(() => {
      if (at !== 'new') {
        if (newPool.size > 0) newPool = new Set()
        return
      }
      const next = new Set(newPool)
      let grew = false
      for (const id of live) if (!next.has(id)) (next.add(id), (grew = true))
      if (grew) newPool = next
    })
  })

  const rows = $derived(
    listRows({
      attempts,
      groups,
      filter,
      search: names ? search : '',
      unread: filter === 'new' ? newPool : unread,
      expanded,
      held,
    }),
  )
  const ids = $derived(selectable(rows))
  const current = $derived<CouncilAttempt | null>(
    attempts.find((attempt) => attempt.participantId === cursor) ?? null,
  )
  const replyToGroup = $derived(Boolean(cursor && replyDrafts[cursor]?.toGroup &&
    replyDrafts[cursor]?.groupKey === current?.groupKey))
  const group = $derived(current ? groups.find((one) => one.key === current.groupKey) : undefined)
  const groupIndex = $derived(
    current && current.submittedAt !== null
      ? groups.findIndex((one) => one.key === current.groupKey) + 1
      : 0,
  )
  const place = $derived(cursor === null ? 0 : ids.indexOf(cursor) + 1)
  /**
   * Черновик письма этой группе — от оракула (CouncilOracle.drafts).
   *
   * Он есть не всегда и только у сданных: у черновика автора группы нет.
   */
  const groupDraft = $derived(
    group && current?.submittedAt !== null ? (board?.oracle?.drafts[group.key] ?? '') : '',
  )
  const neighbour = $derived(neighbourInGroup(attempts, cursor, 1))
  const shownNeighbour = $derived(neighbourInGroup(attempts, shown?.participantId ?? null, 1))

  /**
   * Курсор всегда стоит на живой строке.
   *
   * Сменили отбор, автора убрали из комнаты, группу свернули — строки под
   * курсором больше нет, и правая колонка показывала бы работу, которой в
   * списке не видно. Переносим на первую; пустой список оставляет пустой курсор.
   */
  $effect(() => {
    const list = ids
    const at = untrack(() => cursor)
    if (at !== null && list.includes(at)) return
    cursor = list[0] ?? null
  })

  /** Only a work actually visible to the teacher counts as read. */
  $effect(() => {
    if (tab !== 'work') return
    const at = cursor
    if (at === null) return
    untrack(() => {
      if (seen.has(at)) return
      seen = new Set(seen).add(at)
    })
  })

  /**
   * Держать ли новые сдачи.
   *
   * Полоса появляется, когда список прокручен или курсор не на первой строке.
   * Под курсором строка не двигается никогда — даже если её автор сдал заново.
   */
  let scrolled = $state(false)
  let standing = $state.raw<ReadonlySet<string>>(new Set())
  $effect(() => {
    const atTop = cursor === ids[0]
    const away = scrolled || tab !== 'work'
    untrack(() => {
      if (!holdsArrivals(away, atTop)) {
        frozenAt = null
        return
      }
      if (frozenAt === null) {
        // Capture BEFORE the next board frame. Reading live ids after an arrival
        // would already include that arrival and could never hold it back.
        standing = new Set(attempts.filter((attempt) => attempt.submittedAt !== null && ids.includes(attempt.participantId)).map((attempt) => attempt.participantId))
        frozenAt = Date.now()
      }
    })
  })
  $effect(() => {
    const list = attempts
    const since = frozenAt
    const snapshot = standing
    untrack(() => {
      const next = since === null ? new Set<string>() : heldArrivals(list, since, snapshot, cursor)
      if (next.size !== held.size || [...next].some((id) => !held.has(id))) held = next
    })
  })

  function release(): void {
    frozenAt = null
    held = new Set()
    document.querySelector('[data-pult-scroll]')?.scrollTo({ top: 0 })
    scrolled = false
  }

  /**
   * Вывод открытой работы, не поехавший со стопкой, — попросить отдельно.
   *
   * Память о том, что уже спрашивали, живёт в `CouncilState.wantOutputs`: полный
   * кадр стопки её обнуляет, и вторая копия правила разошлась бы с первой на
   * первом же переподключении.
   */
  $effect(() => {
    const attempt = current
    if (attempt?.run?.outputsOmitted) session.council.wantOutputs(cellId, attempt.participantId)
  })

  /* ----------------------------------------------------------- действия */

  function open(participantId: string): void {
    cursor = participantId
    keyboard = false
    tab = 'work'
    // На телефоне открыть работу — значит перейти на её экран целиком.
    toWork()
  }

  /** Стрелки ‹ › на телефоне: по ленте, как j и k на клавиатуре. */
  function step(delta: 1 | -1): void {
    const next = moveCursor(rows, cursor, delta)
    if (next !== null) cursor = next
  }

  function show(participantId: string | null = cursor): void {
    if (disabled || participantId === null) return
    const attempt = attempts.find((one) => one.participantId === participantId)
    // Черновик классу не показывают: человек ещё пишет, и на стене окажется
    // половина мысли, за которую он не отвечает.
    if (!attempt || attempt.submittedAt === null) return
    session.council.show(cellId, participantId)
  }

  function clearShown(): void {
    if (disabled) return
    session.council.clearShown(cellId)
  }

  function run(participantId: string | null = cursor): void {
    if (disabled || participantId === null) return
    session.council.run(cellId, participantId)
  }

  function interrupt(): void {
    if (disabled) return
    session.send({ t: 'interrupt', cellId })
  }

  function mark(correct: boolean): void {
    if (disabled || !current) return
    session.council.mark(cellId, current.participantId, current.correct === correct ? null : correct)
  }

  function letThrough(attempt: CouncilAttempt): void {
    const request = attempt.runRequest
    if (disabled || request?.status !== 'pending') return
    session.council.approveRunRequest(cellId, attempt.participantId, request.id)
  }

  function declineRun(attempt: CouncilAttempt): void {
    const request = attempt.runRequest
    if (disabled || request?.status !== 'pending') return
    session.council.declineRunRequest(cellId, attempt.participantId, request.id)
  }

  function approveAll(): void {
    if (disabled) return
    for (const attempt of kernel.pending) letThrough(attempt)
  }

  /**
   * Правило регламента — тем же кадром, что и замок ячейки.
   *
   * Кадра «настройка консилиума» нет и не будет: ручки едут `cell:lock` вместе
   * с положением замка (council.svelte.ts · lock), и сервер кладёт их в ту же
   * версию истории. Повторное нажатие по уже выбранному не отправляется: это
   * не событие, а лишняя версия на каждый щелчок.
   */
  function setRule(patch: Partial<CouncilSettings>): void {
    if (disabled) return
    const changed = Object.entries(patch).some(
      ([key, value]) => settings[key as keyof CouncilSettings] !== value,
    )
    if (!changed) return
    session.council.lock(cellId, 'council', patch)
  }

  function openRules(rule: PultRule, from: HTMLElement | null = null): void {
    rulesBack = from
    rulesRule = rule
    rulesOpen = true
  }

  function closeRules(): void {
    rulesOpen = false
    const back = rulesBack
    rulesBack = null
    // Кнопка могла исчезнуть вместе со своим куском предложения: запретили
    // студентам запускать — «повтор …» ушёл из строки. Тогда фокус принимает
    // имя регламента: оно есть при любой ширине и в любом состоянии.
    void tick().then(() =>
      (back?.isConnected ? back : document.querySelector<HTMLElement>('[data-pult-rules-open]'))?.focus(),
    )
  }

  function sendReply(): void {
    const text = reply.trim()
    if (disabled || !text || text.length > 3000 || !current) return
    session.council.reply(
      cellId,
      replyToGroup && current.submittedAt !== null
        ? { groupKey: current.groupKey }
        : { participantId: current.participantId },
      text,
    )
    updateReply({ text: '', fromOracle: false, toGroup: false })
  }

  /**
   * «Всем N» — и черновик оракула, если он для этой группы есть.
   *
   * Черновик не подтверждают кнопкой «отправить как есть»: письмо уйдёт от
   * имени преподавателя, поэтому текст встаёт В ПОЛЕ и правится. Своё
   * написанное он не затирает никогда — только пустое поле.
   */
  function toggleReplyToGroup(): void {
    const toGroup = !replyToGroup
    updateReply({ toGroup, ...(toGroup && reply.trim() === '' && groupDraft
      ? { text: groupDraft, fromOracle: true } : {}) })
  }

  /**
   * Удалить автора работы или записи очереди с занятия.
   *
   * Спрашивает общее меню бана (components/panels/BanMenu.svelte) — оно живёт
   * в этом же окне и перечисляет последствия. Имя и id берутся из попытки и
   * при выключенных именах: «Вариант 12» удалять нельзя, удаляют человека.
   */
  function remove(attempt: CouncilAttempt, event: MouseEvent): void {
    if (disabled) return
    askToBan(banTargetOf(attempt, event))
  }

  /**
   * Оракул о классе — через тот же маршрут, что и в тетради.
   *
   * `question` — свободный вопрос о состоянии класса; без него сервер готовит
   * прежнюю сводку по решениям (server/src/routes/council.ts).
   */
  async function askOracle(stop: boolean, question?: string): Promise<void> {
    oracleError = ''
    try {
      if (stop) await api.councilStopOracle(session.session.id, session.token, cellId)
      else await api.councilAsk(session.session.id, session.token, cellId, question)
    } catch (error) {
      oracleError = error instanceof Error ? error.message : tr('room.pult.oracleError')
    }
  }

  function toggleGroup(groupKey: string): void {
    const next = new Set(expanded)
    if (next.has(groupKey)) next.delete(groupKey)
    else next.add(groupKey)
    expanded = next
  }

  /* ---------------------------------------------------------- клавиши */

  /**
   * Где стоит фокус, по элементу под ним: поле ответа — его клавиши, поиск —
   * стрелки продолжают ходить по списку, кнопка — Enter нажимает кнопку.
   */
  function where(target: EventTarget | null): PultFocus {
    const node = target instanceof HTMLElement ? target : null
    if (!node) return 'list'
    if (node.closest('[data-pult-reply], [data-pult-work-scroll] [role=region]')) return 'reply'
    if (node.closest('[data-pult-row]') && node.hasAttribute('data-pult-select')) return 'list'
    if (node.closest('[data-pult-search]')) return 'search'
    if (node.matches('input, textarea, select') || node.isContentEditable) return 'reply'
    if (node.tagName === 'BUTTON' || node.closest('[data-pult-actions]')) return 'actions'
    return 'list'
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return
    if (helpOpen) {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault()
        helpOpen = false
      }
      return
    }
    /*
     * Открытый лист забирает клавиатуру целиком.
     *
     * Иначе j и k ходили бы по списку за затемнением, а Esc закрывал бы заодно
     * поиск — и лист. Внутри листа своя жизнь: Tab по кругу, пробел на кнопке.
     */
    if (rulesOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRules()
      }
      return
    }
    const at = where(event.target)
    focus = at
    const action = pultKeyAction(
      { key: event.key, shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, composing: event.isComposing },
      at,
    )
    const inNavigation = event.target instanceof HTMLElement && Boolean(event.target.closest('[data-pult-nav]'))
    const inOverlay = event.target instanceof HTMLElement && Boolean(event.target.closest('[role=menu], [role=dialog], [role=alertdialog]'))
    if (action === null || !pultShortcutAllowed(action, tab, inNavigation, inOverlay)) return
    if (action === 'send') {
      // Отправку разбирает само поле: ⌘↵ внутри textarea уже перехвачен там.
      return
    }
    event.preventDefault()
    if (event.repeat && !['next', 'prev'].includes(action)) return
    switch (action) {
      case 'next':
      case 'prev':
        cursor = moveCursor(rows, cursor, action === 'next' ? 1 : -1)
        keyboard = true
        tab = 'work'
        void scrollToCursor(at !== 'search')
        return
      case 'toggleGroup': {
        const key = current?.groupKey
        if (key && (sizes.get(key) ?? 0) >= 3) toggleGroup(key)
        return
      }
      case 'search':
        tab = 'work'
        searching = true
        void tick().then(() => document.querySelector<HTMLInputElement>('[data-pult-search]')?.focus())
        return
      case 'show':
        show()
        return
      case 'run':
        run()
        return
      case 'correct':
        mark(true)
        return
      case 'wrong':
        mark(false)
        return
      case 'clearShown':
        clearShown()
        return
      case 'neighbourNext':
      case 'neighbourPrev': {
        const to = neighbourInGroup(attempts, cursor, action === 'neighbourNext' ? 1 : -1)
        if (to) {
          cursor = to
          keyboard = true
          void scrollToCursor(at !== 'search')
        }
        return
      }
      case 'help':
        helpOpen = !helpOpen
        return
      case 'rules':
        // С клавиши — всегда с первого правила: у «п» нет значения, по
        // которому нажали, и «где-то там, где были в прошлый раз» — не ответ.
        openRules('studentRun')
        return
      case 'escape':
        if (helpOpen) helpOpen = false
        else if (searching) {
          searching = false
          search = ''
        } else if (at === 'reply') (event.target as HTMLElement).blur()
        return
    }
  }

  /** Строка под курсором не должна оказаться у самого края списка. */
  async function scrollToCursor(moveFocus = true): Promise<void> {
    await tick()
    if (cursor === null) return
    const row = document.querySelector(`[data-pult-row="${CSS.escape(cursor)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
    if (moveFocus) row?.querySelector<HTMLButtonElement>('[data-pult-select]')?.focus({ preventScroll: true })
  }

</script>

<svelte:window on:keydown={onkeydown} />

{#if !host}
  <!--
    Отказ, а не пустой пульт. Ссылка на окно уезжает в чат так же легко, как
    любая другая, а за ней лежат чужие работы целиком.
  -->
  <div class="flex h-full w-full flex-col items-center justify-center gap-2 bg-canvas px-10 text-center">
    <p class="text-title font-bold text-ink">{tr('room.ui.1357')}</p>
    <p class="text-ui text-muted">{tr('room.ui.1358')}</p>
  </div>
{:else if board === null || (board.lock !== 'council' && board.counts.attempts === 0)}
  <div class="flex h-full w-full flex-col items-center justify-center gap-2 bg-canvas px-10 text-center">
    <p class="text-title font-bold text-ink">{tr('room.ui.1359')}</p>
    <p class="text-ui text-muted">{tr('room.ui.1360')}</p>
  </div>
{:else}
  <div class="pult-root relative flex h-full min-h-0 w-full flex-col bg-canvas text-ink" data-council-pult={cellId} data-pult-pane={pane}>
    <div class="pult-head" bind:clientHeight={headHeight}>
      <PultHeader
        {cellIndex}
        title={session.session.name}
        rules={sentence}
        openRule={rulesOpen ? rulesRule : null}
        onrules={openRules}
        {onexit}
      />
    </div>
    {#if offline}<p class="border-b border-warning px-4 py-2 text-ui text-warning" role="status">{tr(OFFLINE_REASON)}</p>{/if}
    {#if oracleError}<p class="border-b border-danger px-4 py-2 text-ui text-danger" role="alert">{oracleError}</p>{/if}

    <nav class="pult-nav" data-pult-nav aria-label={tr('room.pult.v2.navigation')}>
      <button type="button" class="pult-view-tab" aria-pressed={tab === 'work'} onclick={() => (tab = 'work')}>
        {tr('room.pult.v2.workTab')} <span class="pult-tab-count">{counts.attempts}</span>
      </button>
      <button type="button" class="pult-view-tab" aria-pressed={tab === 'queue'} onclick={() => (tab = 'queue')}>
        {tr('room.pult.v2.queueTab')} <span class="pult-tab-count" class:needs-attention={kernel.pending.length > 0}>{kernel.pending.length + kernel.queued.length}</span>
      </button>
      <button type="button" class="pult-view-tab" aria-pressed={tab === 'oracle'} onclick={() => (tab = 'oracle')}>
        <span aria-hidden="true">✦</span> {tr('room.pult.v2.oracleTab')}
      </button>
      {#if kernel.pending.length > 0 && tab !== 'queue'}
        <button type="button" class="pult-pending-link" onclick={() => (tab = 'queue')}>{tr('room.pult.v2.pending', {count:kernel.pending.length})}</button>
      {:else if !kernel.running && kernel.queued.length === 0 && kernel.pending.length === 0}
        <span class="pult-nav-status">{tr('room.pult.v2.queueEmpty')}</span>
      {/if}
    </nav>

    {#if shown}
      <PultOnScreen {shown} {now} hasNeighbour={shownNeighbour !== null} {disabled} onneighbour={() => show(shownNeighbour)} onclear={clearShown} />
    {/if}

    <section class="pult-work-layout" hidden={tab !== 'work'} aria-label={tr('room.pult.v2.workTab')}>
      <aside class="pult-sidebar">
    <PultFilters
      {filter}
      {search}
      {searching}
      {names}
      {counts}
      {phone}
      groups={groups.length}
      onfilter={(next) => (filter = next)}
      onsearch={(text) => (search = text)}
      onclose={() => { searching = false; search = '' }}
      onopensearch={() => (searching = true)}
    />
      <PultList
        people={session.peersById}
        connected={presenceKnown}
        filtered={filter !== 'all' || search.trim() !== ''}
        {rows}
        {cursor}
        keyboard={keyboard && focus !== 'reply'}
        {names}
        shown={shown?.participantId ?? null}
        {sizes}
        {now}
        onscroll={(at) => (scrolled = at > 0)}
        held={held.size}
        decisionsOff={disabled || settings.studentRun !== 'request'}
        onopen={open}
        onlet={letThrough}
        ontoggle={toggleGroup}
        onrelease={release}
      />
      </aside>
      <div class="pult-work-pane">
          {#if phone && phonePane === 'work'}
            <!--
              Планка экрана работы: назад к списку, чьё это, и стрелки по ленте.
              Имя стоит здесь, а не в шапке работы: на 390 px два имени подряд —
              это строка, отнятая у кода.
            -->
            <div class="phone-bar">
              <button type="button" class="phone-back" onclick={toList}>
                <span aria-hidden="true">‹</span> {tr('room.pult.v3.backToList')}
              </button>
              <span class="phone-title">{current === null ? '' : names ? current.name : tr('room.ui.1255', { p0: variants.get(current.participantId) ?? 0 })}</span>
              <span class="phone-place">{tr('room.pult.v3.place', { index: place, total: ids.length })}</span>
              <button type="button" class="phone-step" aria-label={tr('room.pult.v3.prevWork')}
                disabled={place <= 1} onclick={() => step(-1)}><span aria-hidden="true">‹</span></button>
              <button type="button" class="phone-step" aria-label={tr('room.pult.v3.nextWork')}
                disabled={place >= ids.length} onclick={() => step(1)}><span aria-hidden="true">›</span></button>
            </div>
          {/if}
          <PultWork
            attempt={current}
            phone={phone && phonePane === 'work'}
            presence={current ? pultPresence(presenceKnown, session.peersById, current.participantId) : 'unknown'}
            {group}
            {groupIndex}
            groups={groups.length}
            index={place}
            total={ids.length}
            variant={current ? (variants.get(current.participantId) ?? 0) : 0}
            {names}
            {now}
            onScreen={shown?.participantId === current?.participantId && shown !== null}
            shownAt={shown?.shownAt ?? null}
            {disabled}
            hasNeighbour={neighbour !== null}
            limit={settings.runLimitSec}
            onrules={openRules}
            {reply}
            {replyToGroup}
            replyDraft={groupDraft !== ''}
            {replyFromOracle}
            onshow={() => show()}
            onclear={clearShown}
            onrun={() => run()}
            oninterrupt={interrupt}
            onneighbour={() => {
              if (neighbour) show(neighbour)
            }}
            onmark={mark}
            onremove={remove}
            onreplychange={(text) => {
              updateReply({ text, ...(text.trim() === '' ? { fromOracle: false } : {}) })
            }}
            onreplytoggle={toggleReplyToGroup}
            onreplysend={sendReply}
            onreplyfocus={() => (focus = 'reply')}
            onreplyblur={() => (focus = 'list')}
          />
      </div>
    </section>
    {#if tab === 'queue'}
      <PultQueueStrip {kernel} {settings} {attempts} {names} {now} open={true} {disabled}
        ontoggle={() => {}} oninterrupt={interrupt} onapprove={letThrough}
        ondecline={declineRun} onapproveall={approveAll} onopen={open} onremove={remove} />
    {:else if tab === 'oracle'}
      <PultOracleTab oracle={board.oracle} {attempts} submitted={counts.submitted} {names} {variants}
        askWhy={offline ? tr(OFFLINE_REASON) : null} onask={(question) => void askOracle(false, question)}
        onstop={() => void askOracle(true)} onopen={open} />
    {/if}

    <PultStatusLine
      onScreen={shown === null ? null : (shown.name ?? tr('room.ui.1255', { p0: shown.variant }))}
      inFrame={shown?.shownAt ? spell(Math.max(now - shown.shownAt, 0)) : ''}
      index={place}
      total={ids.length}
      banner={shown !== null}
      onclear={clearShown}
      onhelp={() => (helpOpen = true)}
    />

    {#if rulesOpen}
      <PultRules
        {settings}
        rule={rulesRule}
        pending={kernel.pending.length}
        {stats}
        {disabled}
        top={headHeight}
        onchange={setRule}
        onclose={closeRules}
      />
    {/if}

    {#if helpOpen}
      <PultKeys onclose={() => (helpOpen = false)} />
    {/if}
  </div>
{/if}

<style>
  /*
   * Бюджет постоянной обвязки — 176 px из 650.
   *
   * Было 290: шапка в три строки, вкладки по 48 px с полями по 12, полоса
   * «на экране» в два ряда и строка состояния. В окне 900×650 это почти
   * половина высоты под то, что за пару не меняется, — а меняются в нём
   * список слева и работа справа, и им оставалось две с половиной строки и
   * панель, уезжающая под сгиб.
   */
  .pult-root { overflow:hidden; }
  .pult-head { flex-shrink:0; }
  .pult-nav { display:flex; align-items:center; flex-wrap:nowrap; gap:6px; flex-shrink:0; min-height:44px; padding:5px var(--pult-pad); background:rgb(var(--surface)); border-bottom:1px solid rgb(var(--line)); }
  .pult-view-tab { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:34px; padding:6px 12px; border:1px solid rgb(var(--line)); background:rgb(var(--canvas)); font-size:14px; font-weight:600; line-height:20px; white-space:nowrap; cursor:pointer; }
  .pult-view-tab[aria-pressed="true"] { background:rgb(var(--primary)); border-color:rgb(var(--primary)); color:rgb(var(--primary-ink)); font-weight:700; }
  .pult-tab-count { min-width:20px; text-align:center; padding:0 3px; font-variant-numeric:tabular-nums; }
  .pult-tab-count.needs-attention { background:rgb(var(--warning)); color:rgb(var(--canvas)); }
  .pult-pending-link { min-height:32px; padding:6px 10px; margin-left:auto; background:rgb(var(--warning)/.1); border:1px solid rgb(var(--warning)/.35); color:rgb(var(--warning)); font-size:13px; font-weight:600; white-space:nowrap; cursor:pointer; }
  .pult-nav-status { margin-left:auto; font-size:13px; color:rgb(var(--muted)); white-space:nowrap; }
  .pult-work-layout { display:flex; min-height:0; flex:1; }
  /* 336 — ширина, на которой «Запуск выполнен · 1,2 с · 17:24» стоит в строке
     целиком: ради этой третьей строчки список и расширен. */
  .pult-sidebar { display:flex; flex-direction:column; min-height:0; width:336px; flex-shrink:0; border-right:1px solid rgb(var(--line)); background:rgb(var(--surface)); }
  /*
   * Панель работы не прокручивается целиком НИКОГДА.
   *
   * Здесь стояло `@media(max-height:700px){ overflow-y:auto }` вместе с
   * `min-height:650px` у самой работы — то есть в невысоком окне панель
   * становилась длинной страницей, и поле ответа с четырьмя действиями лежало
   * под сгибом. Прокручивается ровно одна зона — код с выводом (PultWork ·
   * .work-content), а шапка автора и док общения прибиты к своим кромкам.
   */
  .pult-work-pane { display:flex; flex-direction:column; min-height:0; min-width:0; flex:1; }
  /*
   * Единственная высота, на которой три зоны не складываются: окно ниже
   * 480 px — это половина ноутбучного экрана, там доку с кодом и шапкой места
   * нет физически. Здесь панель снова становится страницей — лучше прокрутка,
   * чем раздавленные в ноль кнопки.
   */
  @media(max-height:479px) { .pult-work-pane { overflow-y:auto; } }
  /* Планка экрана работы на телефоне: назад, имя, место в ленте, стрелки. */
  .phone-bar { display:none; align-items:center; gap:8px; flex-shrink:0; min-height:44px; padding:4px 8px 4px 4px; border-bottom:1px solid rgb(var(--line)); background:rgb(var(--surface)); }
  .phone-back { display:flex; align-items:center; gap:4px; flex-shrink:0; min-height:40px; padding:6px 8px; color:rgb(var(--primary)); font-size:15px; font-weight:600; cursor:pointer; }
  .phone-title { min-width:0; flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:15px; font-weight:700; }
  .phone-place { flex-shrink:0; color:rgb(var(--muted)); font-size:13px; font-variant-numeric:tabular-nums; }
  .phone-step { display:flex; align-items:center; justify-content:center; width:40px; min-height:40px; flex-shrink:0; border:1px solid rgb(var(--line)); background:rgb(var(--canvas)); font-size:18px; cursor:pointer; }
  .phone-step:disabled { opacity:.4; cursor:default; }
  /* Тот же воздух, что у шапки: на большом мониторе плотность 650-пиксельного
     окна выглядит скупостью, а высоты там не жалко. */
  @media(min-width:1200px) and (min-height:800px) {
    .pult-nav { min-height:52px; padding-block:8px; }
    .pult-view-tab { min-height:38px; padding:8px 14px; font-size:15px; }
  }
  @media(max-width:1000px) { .pult-sidebar { width:324px; } }
  @media(max-width:860px) { .pult-sidebar { width:280px; } .pult-view-tab { padding:6px 9px; } }
  @media(max-width:650px) {
    /*
     * Телефон: два экрана, а не две колонки.
     *
     * Список во весь экран, работа во весь экран, между ними — нажатие и жест
     * «назад». Пока открыта работа, шапка, вкладки и полоса «на экране»
     * уходят: их место — это та самая высота, которой не хватало доку общения
     * и коду. Вернуться к ним — один жест.
     */
    .pult-root { height:100dvh; }
    .pult-nav-status, .pult-pending-link { display:none; }
    .pult-view-tab { flex:1; min-height:44px; font-size:14px; padding:6px 8px; }
    .pult-work-layout { flex-direction:row; }
    .pult-sidebar { width:100%; border-right:0; }
    .phone-bar { display:flex; }
    [data-pult-pane='work'] .pult-sidebar { display:none; }
    [data-pult-pane='list'] .pult-work-pane { display:none; }
    [data-pult-pane='work'] .pult-head,
    [data-pult-pane='work'] .pult-nav { display:none; }
    [data-pult-pane='work'] :global(.projection-banner) { display:none; }
  }
</style>
