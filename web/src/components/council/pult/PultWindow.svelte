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
    selectable,
    unreadIds,
    variantNumbers,
    type PultFilter,
    type PultFocus,
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
  let helpOpen = $state(false)
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

  /** Оракул о классе — через тот же маршрут, что и в тетради. */
  async function askOracle(stop: boolean): Promise<void> {
    oracleError = ''
    try {
      if (stop) await api.councilStopOracle(session.session.id, session.token, cellId)
      else await api.councilAsk(session.session.id, session.token, cellId)
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
  <div class="relative flex h-full min-h-0 w-full flex-col bg-canvas text-ink" data-council-pult={cellId}>
    <PultHeader {cellIndex} title={session.session.name} {onexit} />
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
          <PultWork
            attempt={current}
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
      <PultQueueStrip {kernel} {settings} {names} {now} open={true} {disabled}
        ontoggle={() => {}} onpolicy={setPolicy} oninterrupt={interrupt} onapprove={letThrough}
        ondecline={declineRun} onapproveall={approveAll} onremove={remove} />
    {:else if tab === 'oracle'}
      <PultOracleTab oracle={board.oracle} {attempts} submitted={counts.submitted} {names}
        askWhy={offline ? tr(OFFLINE_REASON) : null} onask={() => void askOracle(false)} onstop={() => void askOracle(true)} />
    {/if}

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

<style>
  .pult-nav { display:flex; align-items:center; flex-wrap:wrap; gap:8px; flex-shrink:0; padding:12px var(--pult-pad); background:rgb(var(--surface)); border-bottom:1px solid rgb(var(--line)); }
  .pult-view-tab { display:inline-flex; align-items:center; justify-content:center; gap:10px; min-height:48px; padding:10px 18px; border:1px solid rgb(var(--line)); background:rgb(var(--canvas)); font-size:16px; font-weight:600; line-height:24px; cursor:pointer; }
  .pult-view-tab[aria-pressed="true"] { background:rgb(var(--primary)); border-color:rgb(var(--primary)); color:rgb(var(--primary-ink)); font-weight:700; }
  .pult-tab-count { min-width:24px; text-align:center; padding:0 4px; font-variant-numeric:tabular-nums; }
  .pult-tab-count.needs-attention { background:rgb(var(--warning)); color:rgb(var(--canvas)); }
  .pult-pending-link { min-height:44px; padding:10px 14px; margin-left:auto; background:rgb(var(--warning)/.1); border:1px solid rgb(var(--warning)/.35); color:rgb(var(--warning)); font-size:14px; font-weight:600; cursor:pointer; }
  .pult-nav-status { margin-left:auto; font-size:14px; color:rgb(var(--muted)); }
  .pult-work-layout { display:flex; min-height:0; flex:1; }
  .pult-sidebar { display:flex; flex-direction:column; min-height:0; width:332px; flex-shrink:0; border-right:1px solid rgb(var(--line)); background:rgb(var(--surface)); }
  .pult-work-pane { display:flex; flex-direction:column; min-height:0; min-width:0; flex:1; }
  @media(max-height:700px) { .pult-work-pane { overflow-y:auto; } }
  @media(max-width:1000px) { .pult-sidebar { width:292px; } .pult-view-tab { padding:10px 14px; } }
  @media(max-width:800px) { .pult-sidebar { width:268px; } .pult-view-tab { font-size:15px; min-height:44px; padding:9px 10px; } .pult-pending-link { min-height:36px; padding:6px 10px; } }
  @media(max-width:650px) { .pult-nav-status { display:none; }.pult-work-layout { flex-direction:column; }.pult-sidebar { width:100%; max-height:40%; border-right:0; border-bottom:1px solid rgb(var(--line)); flex-shrink:1; }.pult-work-pane { min-height:260px; }.pult-nav { gap:6px; }.pult-view-tab { font-size:14px; } }
</style>
