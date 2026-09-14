<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * ПУЛЬТ КОНСИЛИУМА — отдельное окно, мессенджер: слева люди, справа их работа.
   *
   * Зачем окно, а не блок под ячейкой. Тетрадь зеркалится на проектор. Пока
   * стопка жила в ней, зал читал имена, черновики, ошибки и отметки ✓/✗ —
   * то есть всё, что преподаватель держит при себе. Второе: листание «‹ ›» по
   * одной карточке не отвечает на вопрос «кто сдал минуту назад» и прячет
   * очередь на запуск. Мессенджер отвечает на оба: лента сдач с курсором и
   * полоса очереди сверху.
   *
   * Окно 900×700 (мин 760×600) — размер выведен из содержимого, а не выбран:
   * 560 px тела это десять строк по 50, а справа в те же 560 укладываются шапка
   * работы, три строки кода, вывод, письма, поле ответа и полоса действий 56.
   *
   * СОЕДИНЕНИЕ ТО ЖЕ САМОЕ. Это та же комната тем же человеком: `SessionState`
   * создаётся в SessionScreen один раз, личность берётся из localStorage, и
   * пульт только читает `session.council` и шлёт в тот же управляющий сокет.
   * Своего состояния комнаты у окна нет — есть состояние ЭКРАНА: отбор, курсор,
   * раскрытые группы, придержанные сдачи. Оно и не пересылается: это способ
   * смотреть, а не свойство комнаты.
   *
   * ВСЁ, ЧТО ВИДИТ ЗАЛ, — ОДНА КНОПКА. «Показать классу» (и Enter на строке).
   * Листание, отметки, письма и оракул не меняют на стене ни пикселя.
   *
   * Пульт всегда тёмный — как и лекционный, и по той же причине: тёмный зал —
   * это факт о мире, а не настройка; светлая плита 900×700 в тёмной аудитории
   * бьёт по глазам. Тему одалживаем через `borrowTheme`.
   */
  import { untrack } from 'svelte'
  import { DEFAULT_COUNCIL, findCell, type CouncilSettings } from '@shared/notebook'
  import type { CouncilAttempt } from '@shared/protocol'
  import { api } from '@/lib/api'
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
    selectable,
    unreadIds,
    variantNumbers,
    type PultFilter,
    type PultFocus,
  } from '@/lib/council-pult'
  import { announcePult, savePultPlace } from '@/lib/council-pult-window'
  import { getSessionState } from '@/lib/session.svelte'
  import { borrowTheme } from '@/lib/theme.svelte'
  import { cn, spell } from '@/lib/utils'
  import PultFilters from './PultFilters.svelte'
  import PultHeader from './PultHeader.svelte'
  import PultKeys from './PultKeys.svelte'
  import PultList from './PultList.svelte'
  import PultOnScreen from './PultOnScreen.svelte'
  import PultOracleTab from './PultOracleTab.svelte'
  import PultQueueStrip from './PultQueueStrip.svelte'
  import PultStatusLine from './PultStatusLine.svelte'
  import PultWork from './PultWork.svelte'

  interface Props {
    cellId: string
    /** «В тетрадь ⇤»: окно закрывается, консоль возвращается под ячейку. */
    onexit: () => void
  }

  let { cellId, onexit }: Props = $props()

  const session = getSessionState()
  const host = $derived(session.me.role === 'host')

  /* ------------------------------------------------------------ окно */

  $effect(() => untrack(() => borrowTheme('dark')))

  // Стук соседнему окну: пока он идёт, тетрадь прячет свою стопку целиком.
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

  /** Номер ячейки в тетради — для шапки. Читается один раз, по готовности. */
  let cellIndex = $state<number | null>(null)
  $effect(() => {
    // Пересчитывается на каждый кадр стопки: тетрадь доезжает своим сокетом, и
    // на первой отрисовке ячейки в документе ещё может не быть.
    void board
    void session.connected
    const found = findCell(session.doc, cellId)
    if (found) cellIndex = found.index + 1
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
  let tab = $state<'work' | 'oracle'>('work')
  let queueOpen = $state(false)
  let helpOpen = $state(false)
  let focus = $state<PultFocus>('list')
  let reply = $state('')
  let replyToGroup = $state(false)
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
  const group = $derived(current ? groups.find((one) => one.key === current.groupKey) : undefined)
  const groupIndex = $derived(
    current && current.submittedAt !== null
      ? groups.findIndex((one) => one.key === current.groupKey) + 1
      : 0,
  )
  const place = $derived(cursor === null ? 0 : ids.indexOf(cursor) + 1)
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

  /** Открытая строка — прочитанная. */
  $effect(() => {
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
  $effect(() => {
    const list = attempts
    const holds = holdsArrivals(scrolled, untrack(() => cursor) === untrack(() => ids)[0])
    untrack(() => {
      if (!holds) {
        if (frozenAt !== null) {
          frozenAt = null
          held = new Set()
        }
        return
      }
      const since = frozenAt ?? Date.now()
      if (frozenAt === null) frozenAt = since
      const standing = new Set(ids)
      const next = heldArrivals(list, since, standing, cursor)
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

  function setPolicy(studentRun: CouncilSettings['studentRun']): void {
    if (disabled || studentRun === settings.studentRun) return
    session.council.lock(cellId, 'council', { studentRun })
  }

  function setNames(namesOnProjector: boolean): void {
    if (disabled || namesOnProjector === settings.namesOnProjector) return
    session.council.lock(cellId, 'council', { namesOnProjector })
  }

  function sendReply(): void {
    const text = reply.trim()
    if (disabled || !text || !current) return
    session.council.reply(
      cellId,
      replyToGroup && current.submittedAt !== null
        ? { groupKey: current.groupKey }
        : { participantId: current.participantId },
      text,
    )
    reply = ''
  }

  /** Оракул о классе — через тот же маршрут, что и в тетради. */
  async function askOracle(stop: boolean): Promise<void> {
    try {
      if (stop) await api.councilStopOracle(session.session.id, session.token, cellId)
      else await api.councilAsk(session.session.id, session.token, cellId)
    } catch {
      // Отказ приедет кадром `council:oracle` со своим словом — второго не надо.
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
    if (node.closest('[data-pult-reply]')) return 'reply'
    if (node.closest('[data-pult-search]')) return 'search'
    if (node.tagName === 'BUTTON' || node.closest('[data-pult-actions]')) return 'actions'
    return 'list'
  }

  function onkeydown(event: KeyboardEvent): void {
    const at = where(event.target)
    focus = at
    const action = pultKeyAction(
      { key: event.key, shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey },
      at,
    )
    if (action === null) return
    if (action === 'send') {
      // Отправку разбирает само поле: ⌘↵ внутри textarea уже перехвачен там.
      return
    }
    event.preventDefault()
    switch (action) {
      case 'next':
      case 'prev':
        cursor = moveCursor(rows, cursor, action === 'next' ? 1 : -1)
        keyboard = true
        tab = 'work'
        scrollToCursor()
        return
      case 'toggleGroup': {
        const key = current?.groupKey
        if (key && (sizes.get(key) ?? 0) >= 3) toggleGroup(key)
        return
      }
      case 'search':
        searching = true
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
          scrollToCursor()
        }
        return
      }
      case 'help':
        helpOpen = !helpOpen
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
  function scrollToCursor(): void {
    queueMicrotask(() => {
      const at = cursor
      if (at === null) return
      document
        .querySelector(`[data-pult-row="${CSS.escape(at)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
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
  <div class="relative flex h-full min-h-0 w-full flex-col bg-canvas text-ink" data-council-pult={cellId}>
    <PultHeader {cellIndex} title={session.session.name} {onexit} />

    <PultQueueStrip
      {kernel}
      {settings}
      {names}
      {now}
      open={queueOpen}
      disabled={disabled}
      ontoggle={() => (queueOpen = !queueOpen)}
      onpolicy={setPolicy}
      oninterrupt={interrupt}
      onapprove={letThrough}
      ondecline={declineRun}
      onapproveall={approveAll}
    />

    {#if shown}
      <PultOnScreen
        {shown}
        {now}
        hasNeighbour={shownNeighbour !== null}
        disabled={disabled}
        onneighbour={() => show(shownNeighbour)}
        onclear={clearShown}
      />
    {/if}

    <PultFilters
      {filter}
      {search}
      {searching}
      {names}
      submitted={counts.submitted}
      total={counts.attempts}
      onfilter={(next) => (filter = next)}
      onsearch={(text) => (search = text)}
      onclose={() => (searching = false)}
    />

    <div class="flex min-h-0 flex-1">
      <PultList
        {rows}
        {cursor}
        keyboard={keyboard && focus !== 'reply'}
        {names}
        shown={shown?.participantId ?? null}
        {sizes}
        onscroll={(at) => (scrolled = at > 0)}
        held={held.size}
        decisionsOff={disabled || settings.studentRun !== 'request'}
        onopen={open}
        onlet={letThrough}
        ontoggle={toggleGroup}
        onrelease={release}
      />

      <div class="flex min-h-0 flex-1 flex-col">
        <!-- Две вкладки, а не третья колонка: на 900 px её негде взять, а
             карточка поверх списка закрыла бы те строки, о которых говорит. -->
        <div class="flex h-10 shrink-0 border-b border-line">
          {#each [{ id: 'work', label: tr('room.ui.1343') }, { id: 'oracle', label: tr('room.ui.1344') }] as item (item.id)}
            <button
              type="button"
              class={cn(
                'flex items-center px-4 text-2xs font-bold uppercase tracking-label',
                tab === item.id ? 'border-b-2 border-accent bg-raised text-ink' : 'text-faint hover:text-muted',
              )}
              aria-pressed={tab === item.id}
              onclick={() => (tab = item.id as 'work' | 'oracle')}
            >{item.label}</button>
          {/each}
          <span class="flex-1"></span>
        </div>

        {#if tab === 'oracle'}
          <PultOracleTab
            oracle={board.oracle}
            {attempts}
            submitted={counts.submitted}
            {names}
            askWhy={offline ? tr(OFFLINE_REASON) : null}
            onask={() => void askOracle(false)}
            onstop={() => void askOracle(true)}
          />
        {:else}
          <PultWork
            attempt={current}
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
            {reply}
            {replyToGroup}
            onshow={() => show()}
            onclear={clearShown}
            onrun={() => run()}
            oninterrupt={interrupt}
            onneighbour={() => {
              if (neighbour) show(neighbour)
            }}
            onmark={mark}
            onreplychange={(text) => (reply = text)}
            onreplytoggle={() => (replyToGroup = !replyToGroup)}
            onreplysend={sendReply}
            onreplyfocus={() => (focus = 'reply')}
            onreplyblur={() => (focus = 'list')}
          />
        {/if}
      </div>
    </div>

    <PultStatusLine
      onScreen={shown === null ? null : (shown.name ?? tr('room.ui.1255', { p0: shown.variant }))}
      inFrame={shown?.shownAt ? spell(Math.max(now - shown.shownAt, 0)) : ''}
      {names}
      index={place}
      total={ids.length}
      disabled={disabled}
      onnames={setNames}
      onclear={clearShown}
      onhelp={() => (helpOpen = true)}
    />

    {#if helpOpen}
      <PultKeys onclose={() => (helpOpen = false)} />
    {/if}
  </div>
{/if}
