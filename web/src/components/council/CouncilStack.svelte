<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Пульт консилиума — то, что видит преподаватель вместо тела ячейки.
   *
   * Полоса режима сверху («Консилиум — ячейка 04 · 487 попыток · …» и
   * переключатель Стопка/Сводка), под ней либо СТОПКА — карточка одной
   * попытки с полосой групп, либо СВОДКА (CouncilSummary). Один вход, а не
   * два компонента рядом: счётчики и переключатель одинаковы в обоих видах,
   * и рисовать их дважды значило бы однажды нарисовать по-разному.
   *
   * Компонент чистый: `board` приезжает пропсом, положение в стопке и вид
   * держит родитель (они не пересылаются — это состояние экрана, не комнаты),
   * каждое действие уходит наверх колбэком. Единственное исключение — «Убрать»:
   * меню бана уже глобальное (BanMenu в SessionScreen слушает событие окна), и
   * `askToBan` из lib/bans.ts ничего не знает о сессии, поэтому зовётся прямо
   * отсюда; `onban` — если родитель хочет иначе.
   */
  import { untrack } from 'svelte'
  import { COUNCIL_SHARED_KERNEL_NOTE } from '@shared/notebook'
  import { councilLetters, type CouncilAttempt, type CouncilBoard } from '@shared/protocol'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Code from '@/components/ui/Code.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'
  import { askToBan } from '@/lib/bans'
  import { councilStripText } from '@/lib/council.svelte'
  import {
    groupAttempts,
    neighbours,
    pendingRunRequests,
    placeOf,
    stackKeyAction,
    stackOrder,
    statusLabel,
    stripSegments,
    toneOf,
    type StripTone,
  } from '@/lib/council-board'
  import { clock } from '@/lib/history'
  import { plural } from '@/lib/plural'
  import { cn, spell } from '@/lib/utils'
  import CouncilStrip from './CouncilStrip.svelte'
  import CouncilSummary from './CouncilSummary.svelte'
  import CouncilReplyDraft from './CouncilReplyDraft.svelte'

  type View = 'stack' | 'summary'

  interface Props {
    board: CouncilBoard
    cellId: string
    /** Номер ячейки в тетради, с единицы — для «ячейка 04»; без него подпись короче. */
    cellIndex?: number | null
    /** Попытка на карточке; `null` — стопку ещё не листали, рисуется первая. */
    position: { participantId: string | null }
    view?: View
    /** Почему оракула не спросить; `null` — можно. */
    askWhy?: string | null
    onshow: (participantId: string) => void
    onrun: (participantId: string) => void
    requestsDisabled?: boolean
    onapproverun: (participantId: string, requestId: string) => void
    ondeclinerun: (participantId: string, requestId: string) => void
    onreply: (to: { participantId: string } | { groupKey: string }, text: string) => void
    onmark: (participantId: string, correct: boolean | null) => void
    /**
     * Попросить вывод этой попытки: в стопку он не поехал.
     *
     * Полный кадр стопки режется по бюджету вывода (сервер: control.ts), и у
     * попыток сверх бюджета `run.outputs` пуст, а `run.outputsOmitted` стоит.
     * Карточка — единственное место, где вывод показывают, поэтому повод даёт
     * она и только про ту попытку, которую сейчас смотрят; зовётся на каждый
     * показ, а «спрашивали ли уже» решает `CouncilState.wantOutputs` — там же,
     * где живёт стопка. Ответ приезжает обычной дельтой `council:patch`. Без
     * обработчика ничего не ломается: карточка говорит, что вывода в кадре
     * нет, и не обещает его.
     */
    onneedoutputs?: (participantId: string) => void
    onban?: (participantId: string) => void
    onask: () => void
    onstop?: () => void
    onposition: (participantId: string) => void
    ontoggle: (view: View) => void
  }

  let {
    board,
    cellId,
    cellIndex = null,
    position,
    view = 'stack',
    askWhy = null,
    onshow,
    onrun,
    requestsDisabled = false,
    onapproverun,
    ondeclinerun,
    onreply,
    onmark,
    onneedoutputs,
    onban,
    onask,
    onstop = () => {},
    onposition,
    ontoggle,
  }: Props = $props()

  // Один расчёт групп на оба вида: сводка получает их пропсом.
  const groups = $derived(groupAttempts(board.attempts, board.oracle?.groupLabels ?? {}))
  const order = $derived(stackOrder(groups, board.attempts))
  // Сдача не нужна: запросы ищем по всей стопке, включая черновики.
  const pendingRequests = $derived(pendingRunRequests(board.attempts))
  let deciding = $state<{ participantId: string; requestId: string; action: 'approve' | 'decline' } | null>(null)
  let decisionErrorRender = $state<() => string>(() => '')
  const decisionError = $derived(decisionErrorRender())
  let decisionTimer: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    const attempts = board.attempts
    const closed = board.lock !== 'council' || board.settings.studentRun !== 'request'
    const sent = untrack(() => deciding)
    if (!sent) return
    const request = attempts.find((attempt) => attempt.participantId === sent.participantId)?.runRequest
    if (!closed && request?.id === sent.requestId && request.status === 'pending') return
    deciding = null
    clearTimeout(decisionTimer)
  })
  $effect(() => () => clearTimeout(decisionTimer))

  function decideRun(attempt: CouncilAttempt, action: 'approve' | 'decline'): void {
    const request = attempt.runRequest
    if (requestsDisabled || deciding || board.lock !== 'council' || board.settings.studentRun !== 'request' || request?.status !== 'pending') return
    if (attempt.run?.state === 'queued' || attempt.run?.state === 'running') return
    deciding = { participantId: attempt.participantId, requestId: request.id, action }
    decisionErrorRender = () => ('')
    decisionTimer = setTimeout(() => {
      deciding = null
      decisionErrorRender = () => (tr('room.ui.86'))
    }, 8000)
    if (action === 'approve') onapproverun(attempt.participantId, request.id)
    else ondeclinerun(attempt.participantId, request.id)
  }

  /**
   * Что на карточке. Позиция, которой в стопке уже нет (автора убрали), и
   * пустая позиция ведут на первую попытку — карточка не бывает пустой, пока
   * есть хоть одна попытка.
   */
  const current = $derived.by<CouncilAttempt | null>(() => {
    const wanted = position.participantId
    return (wanted && order.find((a) => a.participantId === wanted)) || order[0] || null
  })
  const currentId = $derived(current?.participantId ?? null)
  const place = $derived(placeOf(order, groups, currentId))
  const around = $derived(neighbours(order, groups, currentId))
  const segments = $derived(
    stripSegments(groups, board.counts.writing, current?.submittedAt !== null ? current?.groupKey ?? null : null),
  )
  const group = $derived(current ? groups.find((g) => g.key === current.groupKey) : undefined)

  /**
   * Кому сейчас пишут ответ с карточки: автору или всей его группе. Помнит, С
   * КАКОЙ карточки открыли: перелистнули — поле закрывается само, потому что
   * текст адресован тому, кого на карточке уже нет. Производное, не эффект.
   */
  let draft = $state<{ id: string; kind: 'one' | 'group' } | null>(null)
  const replying = $derived(draft && draft.id === currentId ? draft.kind : null)
  function toggleReply(kind: 'one' | 'group'): void {
    draft = replying === kind || !currentId ? null : { id: currentId, kind }
  }

  const CHIP: Record<StripTone, string> = {
    ok: 'text-positive',
    error: 'text-warning',
    fail: 'text-danger',
    none: 'text-muted',
  }

  const running = $derived(
    current?.run !== null && (current?.run?.state === 'running' || current?.run?.state === 'queued'),
  )

  /**
   * Развернули карточку, а вывода в кадре нет — попросить его.
   *
   * Своей памяти о том, что уже спрашивали, здесь нет намеренно: она есть у
   * `CouncilState.wantOutputs`, и там ей и место — стопку эта карточка не
   * держит, а вторая копия правила разошлась бы с первой на первом же
   * переподключении (полный кадр стопки просьбы обнуляет). Отсюда — только
   * повод: вот эту попытку сейчас смотрят.
   */
  $effect(() => {
    const attempt = current
    if (attempt?.run?.outputsOmitted) onneedoutputs?.(attempt.participantId)
  })

  function go(id: string | null): void {
    if (id) onposition(id)
  }

  function pick(key: string): void {
    const target = groups.find((g) => g.key === key)
    if (target) onposition(target.representative)
  }

  /**
   * Клавиши — на контейнере, не на документе: пульт лежит в тетради среди
   * других ячеек, и стрелки должны листать стопку только когда фокус внутри
   * неё. Внутри — а не строго на ней: после щелчка по сегменту полосы или по
   * «Запустить» фокус остаётся на кнопке, и стрелки обязаны работать и оттуда,
   * иначе подсказка под полосой обещает то, чего нет. Что делает какая клавиша
   * откуда — stackKeyAction (council-board.ts).
   */
  function onkeydown(event: KeyboardEvent): void {
    if (view !== 'stack') return
    const target = event.target as HTMLElement | null
    const focus = target?.closest('textarea, input, select, [contenteditable]')
      ? 'field'
      : target?.closest('button, a')
        ? 'control'
        : 'stack'
    const action = stackKeyAction(event.key, event.shiftKey, focus)
    if (!action) return
    event.preventDefault()
    if (action === 'show') {
      if (current) onshow(current.participantId)
      return
    }
    go(around[action])
  }

  function remove(event: MouseEvent, attempt: CouncilAttempt): void {
    if (onban) {
      onban(attempt.participantId)
      return
    }
    askToBan({
      id: attempt.participantId,
      name: attempt.name,
      color: attempt.color,
      avatar: attempt.avatar,
      x: event.clientX,
      y: event.clientY,
    })
  }

  const cellLabel = $derived(cellIndex === null ? '' : tr('room.ui.87', { p0: String(cellIndex).padStart(2, '0') }))
  const SEG =
    'h-6 px-2 text-2xs font-bold uppercase tracking-label transition-colors duration-[var(--speed-quick)] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
</script>

<!-- Клавиши ловит контейнер стопки, не документ: см. onkeydown. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="flex flex-col gap-2.5 focus-visible:outline-none"
  role="group"
  aria-label={tr('room.council.label', { cell: cellLabel })}
  data-cell={cellId}
  tabindex="0"
  {onkeydown}
>
  <!-- Полоса режима: счётчики и переключатель, общие для обоих видов. -->
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-2">
    <span class="text-2xs font-bold uppercase tracking-label text-accent-text">{tr('room.ui.34')}{cellLabel}</span>
    <!--
      Строка счётчиков — из `councilStripText`, а не собранная здесь руками:
      это была третья копия одного правила, и она уже разошлась с остальными —
      «· 0 разных ответов» в начале работы писала только она. Второй довод —
      число групп НА ЭКРАНЕ: сервер считает их по всей комнате, а человек
      пересчитывает глазами то, что доехало до стопки.
    -->
    <span class="font-mono text-2xs tabular-nums text-muted">
      {councilStripText(board.counts, groups.length)}
    </span>
    {#if board.lock !== 'council'}
      <span class="text-2xs text-warning">{tr('room.ui.35')}</span>
    {/if}
    <div class="ml-auto flex border border-line" role="group" aria-label={tr('room.ui.36')}>
      <button
        type="button"
        class={cn(SEG, view === 'stack' ? 'bg-ink text-canvas' : 'text-muted hover:text-ink')}
        aria-pressed={view === 'stack'}
        onclick={() => ontoggle('stack')}
      > {tr('room.ui.37')} </button>
      <button
        type="button"
        class={cn(SEG, view === 'summary' ? 'bg-ink text-canvas' : 'text-muted hover:text-ink')}
        aria-pressed={view === 'summary'}
        onclick={() => ontoggle('summary')}
      > {tr('room.ui.38')} </button>
    </div>
    <!--
      Третье место, где говорится про общее ядро, — и последнее из трёх, что
      обещает шапка COUNCIL_SHARED_KERNEL_NOTE (подсказка ручки studentRun,
      эта полоса, README). Копия одна, в shared/notebook.ts: пересказ своими
      словами разъехался бы с ручкой на первой же правке.

      Строкой, а не подсказкой на метке «Консилиум»: пульт ведут с планшета,
      где наведения нет вовсе, а отметку «верно» преподаватель ставит по
      выводу — предупреждение, которое надо навести мышью, до него не доедет.
      Место — под счётчиками: это про режим целиком, а не про попытку на
      карточке, и сказать это довольно один раз сверху, а не у каждой кнопки.
      `basis-full` переносит строку на свою — не `w-full`: на широком пульте
      места справа от переключателя хватило бы, и она встала бы рядом с ним.
      Мера — как у остального длинного текста в продукте: на всю ширину зала
      строка в 10 px не читается.
    -->
    <p class="basis-full max-w-[660px] text-2xs leading-snug text-muted">
      {tr(COUNCIL_SHARED_KERNEL_NOTE)}
    </p>
  </div>

  {#if pendingRequests.length > 0}
    <div class="flex flex-wrap items-center gap-2 border-l-2 border-accent bg-accent/[0.04] px-3 py-2">
      <label class="flex min-w-0 flex-1 basis-64 flex-col gap-1.5 text-ui">
        <span class="font-semibold text-accent-text" role="status">{tr('room.ui.39')} {pendingRequests.length}</span>
        <select
          class="h-8 w-full min-w-0 border border-line bg-canvas px-2 text-ui text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          value={pendingRequests.some((attempt) => attempt.participantId === currentId) ? currentId ?? '' : ''}
          onchange={(event) => { go(event.currentTarget.value); ontoggle('stack') }}
        >
          <option value="" disabled>{tr('room.ui.40')}</option>
          {#each pendingRequests as request (request.participantId)}
            <option value={request.participantId}>{request.name} · {clock(request.runRequest!.requestedAt)}{request.submittedAt === null ? tr('room.ui.41') : ''}</option>
          {/each}
        </select>
      </label>
      <button type="button" class="btn-outline h-8 self-end" onclick={() => { go(pendingRequests[0]?.participantId ?? null); ontoggle('stack') }}>{tr('room.ui.42')}</button>
    </div>
  {/if}
  {#if decisionError}<p class="text-2xs text-warning" role="alert">{decisionError}</p>{/if}

  {#if view === 'summary'}
    <CouncilSummary {board} {groups} {askWhy} {onshow} {onreply} {onposition} {ontoggle} {onask} {onstop} />
  {:else if current === null}
    <p class="border border-dashed border-line px-3 py-6 text-center text-2xs text-muted">
      {#if board.counts.writing > 0} {tr('room.ui.43')} {board.counts.writing}
        {plural(board.counts.writing, tr('room.ui.44'), tr('room.ui.45'), tr('room.ui.45'))}
      {:else if board.lock === 'council'} {tr('room.ui.46')} {:else} {tr('room.ui.47')} {/if}
    </p>
  {:else}
    {@const attempt = current}
    <article class="flex flex-col border border-line bg-surface" aria-label={tr('room.council.attempt', { name: attempt.name })}>
      <!-- Плашка: кто, когда, в каком состоянии и где мы в стопке. -->
      <div class="flex flex-wrap items-center gap-2 border-b border-line-soft px-2 py-1.5">
        <button
          type="button"
          class="btn-ghost h-7 w-7 px-0"
          disabled={!around.prev}
          aria-label={tr('room.ui.48')}
          title={tr('room.ui.49')}
          onclick={() => go(around.prev)}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="xs" />
        <span class="min-w-0 max-w-[14rem] truncate text-ui font-semibold text-ink">{attempt.name}</span>
        <span class="font-mono text-2xs text-muted">
          {#if attempt.submittedAt !== null} {tr('room.ui.50')} {clock(attempt.submittedAt)}
          {:else} {tr('room.ui.51')} {clock(attempt.updatedAt)}
          {/if}
        </span>
        <span
          class={cn(
            'inline-flex h-5 items-center bg-raised px-1.5 font-mono text-2xs',
            CHIP[toneOf(attempt.status)],
          )}
        >
          {statusLabel(attempt)}
        </span>
        {#if attempt.shown}
          <span class="inline-flex h-5 items-center gap-1 bg-positive/10 px-1.5 text-2xs font-bold uppercase tracking-label text-positive">
            <Icon name="board" size={11} /> {tr('room.ui.52')} </span>
        {/if}
        {#if place.same > 0}
          <span class="text-2xs text-muted">{tr('room.ui.53')} {place.same}</span>
        {/if}
        <span class="ml-auto font-mono text-2xs tabular-nums text-muted">
          {#if place.group > 0} {tr('room.ui.54')} {place.group} {tr('room.ui.55')} {place.groups} ·
          {/if}
          {place.index} / {place.total}
        </span>
        <button
          type="button"
          class="btn-ghost h-7 w-7 px-0"
          disabled={!around.next}
          aria-label={tr('room.ui.56')}
          title={tr('room.ui.57')}
          onclick={() => go(around.next)}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>

      <div class={cn('px-3 py-2', attempt.submittedAt === null && 'opacity-70')}>
        {#if attempt.text.trim()}
          <Code code={attempt.text} />
        {:else}
          <p class="text-2xs italic text-muted">{tr('room.ui.58')}</p>
        {/if}
      </div>

      {#if attempt.run}
        <div class="border-t border-line-soft">
          <div class="flex items-center gap-2 px-3 pt-1.5 text-2xs text-muted">
            {#if running}
              <Icon name="spinner" size={12} class="animate-spin text-accent-text/70" />
              <span class="font-bold uppercase tracking-label text-accent-text">
                {attempt.run.state === 'queued' ? tr('room.ui.59') : tr('room.ui.60')}
              </span>
            {:else}
              <span>
                {attempt.run.by === 'host' ? tr('room.ui.61') : tr('room.ui.62')}
                · {clock(attempt.run.startedAt)}
                {#if attempt.run.ranMs !== null}
                  · {spell(attempt.run.ranMs)}
                {/if}
              </span>
            {/if}
          </div>
          {#if attempt.run.outputs.length > 0}
            <CellOutputs outputs={attempt.run.outputs} />
          {:else if attempt.run.outputsOmitted}
            <!-- Пустой вывод и «вывода в кадре нет» — разные вещи, и молчать
                 здесь нельзя: преподаватель решил бы, что запуск ничего не
                 напечатал. Запрос уже ушёл (см. `asked`), ответ приедет
                 дельтой. -->
            <p class="px-3 pb-2 pt-1 text-2xs italic text-muted">
              {onneedoutputs ? tr('room.ui.63') : tr('room.ui.64')}
            </p>
          {/if}
        </div>
      {/if}

      {#if attempt.runRequest?.status === 'pending'}
        <div class="flex flex-wrap items-center gap-2 border-t border-line-soft bg-accent/[0.04] px-3 py-2">
          <span class="mr-auto text-2xs text-accent-text">{tr('room.ui.65')} {clock(attempt.runRequest.requestedAt)}</span>
          <button
            type="button"
            class="btn-primary h-8"
            disabled={requestsDisabled || board.lock !== 'council' || board.settings.studentRun !== 'request' || running || deciding !== null || !attempt.text.trim()}
            onclick={() => decideRun(attempt, 'approve')}
          >{deciding?.requestId === attempt.runRequest.id && deciding.action === 'approve' ? tr('room.ui.66') : tr('room.ui.67')}</button>
          <button
            type="button"
            class="btn-outline h-8"
            disabled={requestsDisabled || board.lock !== 'council' || board.settings.studentRun !== 'request' || running || deciding !== null}
            onclick={() => decideRun(attempt, 'decline')}
          >{deciding?.requestId === attempt.runRequest.id && deciding.action === 'decline' ? tr('room.ui.66') : tr('room.ui.68')}</button>
        </div>
      {:else if attempt.runRequest?.status === 'declined'}
        <p class="border-t border-line-soft px-3 py-2 text-2xs text-muted">{tr('room.ui.69')}</p>
      {/if}

      <!-- Письма преподавателя — строка на письмо, а не одним абзацем.
           Их не больше двух (личное и групповое), и это разные письма: у
           склейки через пустую строку переносы здесь схлопываются, и «Проверьте
           знак» с рассылкой читались одной фразой. Черта сверху у каждого их и
           разделяет; групповое помечено словом — иначе непонятно, кто ещё это
           видел. -->
      {#each councilLetters(attempt) as letter (letter.to ?? 'person')}
        <p class="flex flex-wrap gap-x-2 border-t border-line-soft px-3 py-1.5 text-2xs text-muted">
          <span class="font-semibold text-ink">{letter.by}</span>
          <span class="font-mono">{clock(letter.at)}</span>
          {#if letter.to === 'group'}
            <span>{tr('room.ui.70')}</span>
          {/if}
          <span class="min-w-0 flex-1 break-words">{letter.text}</span>
        </p>
      {/each}

      <div class="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-2">
        <button
          type="button"
          class={attempt.shown ? 'btn-outline h-8' : 'btn-primary h-8'}
          title="Enter"
          onclick={() => onshow(attempt.participantId)}
        >
          <Icon name="board" size={13} />
          {attempt.shown ? tr('room.ui.71') : tr('room.ui.72')}
        </button>
        {#if attempt.runRequest?.status !== 'pending'}
          <button
            type="button"
            class="btn-outline h-8"
            disabled={running || !attempt.text.trim()}
            onclick={() => onrun(attempt.participantId)}
          >
            {#if running}
              <Icon name="spinner" size={13} class="animate-spin" />
            {:else}
              <Icon name="play" size={13} />
            {/if} {tr('room.ui.73')} </button>
        {/if}
        <button
          type="button"
          class="btn-ghost h-8"
          aria-expanded={replying === 'one'}
          onclick={() => toggleReply('one')}
        > {tr('room.ui.74')} </button>
        {#if group && place.same > 0}
          <button
            type="button"
            class="btn-ghost h-8"
            aria-expanded={replying === 'group'}
            onclick={() => toggleReply('group')}
          > {tr('room.ui.75')} {group.count}
            {#if board.oracle?.drafts[group.key]}
              <span class="text-2xs text-accent-text">{tr('room.ui.41')}</span>
            {/if}
          </button>
        {/if}
        <!--
          Две отметки, а не одна трёхтактная.

          Статус `wrong` (protocol.ts · CouncilStatus) продукт знает всюду —
          охряная черта под сегментом группы, чип «неверно», отметка сильнее
          запуска у оракула, — и не возникал ни разу: пульт слал только
          `true`/`null`. Трёхтактная кнопка (верно → неверно → снять) закрыла бы
          дыру дешевле, но второе нажатие по «Верно» ставило бы «Неверно» —
          и подпись под пальцем перестала бы отвечать за то, что случится.
          Отметки две, каждая снимается повторным нажатием собой же.
          Цвета — те же, что у чипа состояния (CHIP · toneOf).
        -->
        <button
          type="button"
          class={cn('btn-ghost h-8', attempt.correct === true && 'text-positive hover:text-positive')}
          aria-pressed={attempt.correct === true}
          onclick={() => onmark(attempt.participantId, attempt.correct === true ? null : true)}
        >
          <Icon name="check" size={13} /> {tr('room.ui.76')} </button>
        <button
          type="button"
          class={cn('btn-ghost h-8', attempt.correct === false && 'text-warning hover:text-warning')}
          aria-pressed={attempt.correct === false}
          onclick={() => onmark(attempt.participantId, attempt.correct === false ? null : false)}
        >
          <Icon name="x" size={13} /> {tr('room.ui.77')} </button>
        <button
          type="button"
          class="btn-ghost ml-auto h-8 text-danger hover:text-danger"
          onclick={(event) => remove(event, attempt)}
        >
          <Icon name="trash" size={13} /> {tr('room.ui.78')} </button>
      </div>

      {#if replying === 'one'}
        <CouncilReplyDraft
          to={attempt.name}
          onsend={(text) => {
            onreply({ participantId: attempt.participantId }, text)
            draft = null
          }}
          oncancel={() => (draft = null)}
        />
      {:else if replying === 'group' && group}
        <CouncilReplyDraft
          to={tr('room.council.recipients', { count: group.count })}
          initial={board.oracle?.drafts[group.key] ?? ''}
          fromOracle={Boolean(board.oracle?.drafts[group.key])}
          onsend={(text) => {
            onreply({ groupKey: group.key }, text)
            draft = null
          }}
          oncancel={() => (draft = null)}
        />
      {/if}
    </article>

    <CouncilStrip {segments} onpick={pick} />
    <!-- Клавиши работают, пока фокус в стопке (щелчок по карточке или по полосе его сюда и ставит). -->
    <p class="text-2xs text-faint"> {tr('room.ui.79')} </p>
  {/if}
</div>
