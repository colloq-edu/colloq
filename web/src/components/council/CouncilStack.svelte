<script lang="ts">
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
  import type { CouncilAttempt, CouncilBoard } from '@shared/protocol'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Code from '@/components/ui/Code.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'
  import { askToBan } from '@/lib/bans'
  import {
    groupAttempts,
    neighbours,
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
    onreply: (to: { participantId: string } | { groupKey: string }, text: string) => void
    onmark: (participantId: string, correct: boolean | null) => void
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
    onreply,
    onmark,
    onban,
    onask,
    onstop = () => {},
    onposition,
    ontoggle,
  }: Props = $props()

  // Один расчёт групп на оба вида: сводка получает их пропсом.
  const groups = $derived(groupAttempts(board.attempts, board.oracle?.groupLabels ?? {}))
  const order = $derived(stackOrder(groups, board.attempts))

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
    const focus = target?.closest('textarea, input, [contenteditable]')
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

  const cellLabel = $derived(cellIndex === null ? '' : ` — ячейка ${String(cellIndex).padStart(2, '0')}`)
  const SEG =
    'h-6 px-2 text-2xs font-bold uppercase tracking-label transition-colors duration-[var(--speed-quick)] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
</script>

<!-- Клавиши ловит контейнер стопки, не документ: см. onkeydown. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="flex flex-col gap-2.5 focus-visible:outline-none"
  role="group"
  aria-label="Консилиум{cellLabel}"
  data-cell={cellId}
  tabindex="0"
  {onkeydown}
>
  <!-- Полоса режима: счётчики и переключатель, общие для обоих видов. -->
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-2">
    <span class="text-2xs font-bold uppercase tracking-label text-accent-text">Консилиум{cellLabel}</span>
    <span class="font-mono text-2xs tabular-nums text-muted">
      {board.counts.attempts} {plural(board.counts.attempts, 'попытка', 'попытки', 'попыток')}
      · {board.counts.submitted} {plural(board.counts.submitted, 'сдал', 'сдали', 'сдали')}
      {#if board.counts.writing > 0}
        · {board.counts.writing} ещё {plural(board.counts.writing, 'пишет', 'пишут', 'пишут')}
      {/if}
      · {groups.length} {plural(groups.length, 'разный ответ', 'разных ответа', 'разных ответов')}
    </span>
    {#if board.lock !== 'council'}
      <span class="text-2xs text-warning">консилиум закрыт — попытки остались на просмотр</span>
    {/if}
    <div class="ml-auto flex border border-line" role="group" aria-label="Вид">
      <button
        type="button"
        class={cn(SEG, view === 'stack' ? 'bg-ink text-canvas' : 'text-muted hover:text-ink')}
        aria-pressed={view === 'stack'}
        onclick={() => ontoggle('stack')}
      >
        Стопка
      </button>
      <button
        type="button"
        class={cn(SEG, view === 'summary' ? 'bg-ink text-canvas' : 'text-muted hover:text-ink')}
        aria-pressed={view === 'summary'}
        onclick={() => ontoggle('summary')}
      >
        Сводка
      </button>
    </div>
  </div>

  {#if view === 'summary'}
    <CouncilSummary {board} {groups} {askWhy} {onshow} {onreply} {onposition} {ontoggle} {onask} {onstop} />
  {:else if current === null}
    <p class="border border-dashed border-line px-3 py-6 text-center text-2xs text-muted">
      {#if board.counts.writing > 0}
        ещё никто не сдал — {board.counts.writing}
        {plural(board.counts.writing, 'пишет', 'пишут', 'пишут')}
      {:else if board.lock === 'council'}
        попыток пока нет — студенты видят пустой лист и пишут у себя
      {:else}
        попыток не было
      {/if}
    </p>
  {:else}
    {@const attempt = current}
    <article class="flex flex-col border border-line bg-surface" aria-label="Попытка · {attempt.name}">
      <!-- Плашка: кто, когда, в каком состоянии и где мы в стопке. -->
      <div class="flex flex-wrap items-center gap-2 border-b border-line-soft px-2 py-1.5">
        <button
          type="button"
          class="btn-ghost h-7 w-7 px-0"
          disabled={!around.prev}
          aria-label="Предыдущая попытка"
          title="← предыдущая · Shift+← группа"
          onclick={() => go(around.prev)}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="xs" />
        <span class="min-w-0 max-w-[14rem] truncate text-ui font-semibold text-ink">{attempt.name}</span>
        <span class="font-mono text-2xs text-muted">
          {#if attempt.submittedAt !== null}
            сдано {clock(attempt.submittedAt)}
          {:else}
            пишет · {clock(attempt.updatedAt)}
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
            <Icon name="board" size={11} />
            на экране
          </span>
        {/if}
        {#if place.same > 0}
          <span class="text-2xs text-muted">так же ещё {place.same}</span>
        {/if}
        <span class="ml-auto font-mono text-2xs tabular-nums text-muted">
          {#if place.group > 0}
            группа {place.group} из {place.groups} ·
          {/if}
          {place.index} / {place.total}
        </span>
        <button
          type="button"
          class="btn-ghost h-7 w-7 px-0"
          disabled={!around.next}
          aria-label="Следующая попытка"
          title="→ следующая · Shift+→ группа"
          onclick={() => go(around.next)}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>

      <div class={cn('px-3 py-2', attempt.submittedAt === null && 'opacity-70')}>
        {#if attempt.text.trim()}
          <Code code={attempt.text} />
        {:else}
          <p class="text-2xs italic text-muted">пустой лист</p>
        {/if}
      </div>

      {#if attempt.run}
        <div class="border-t border-line-soft">
          <div class="flex items-center gap-2 px-3 pt-1.5 text-2xs text-muted">
            {#if running}
              <Icon name="spinner" size={12} class="animate-spin text-accent-text/70" />
              <span class="font-bold uppercase tracking-label text-accent-text">
                {attempt.run.state === 'queued' ? 'В очереди' : 'Выполняется'}
              </span>
            {:else}
              <span>
                {attempt.run.by === 'host' ? 'запускал преподаватель' : 'запускал автор'}
                · {clock(attempt.run.startedAt)}
                {#if attempt.run.ranMs !== null}
                  · {spell(attempt.run.ranMs)}
                {/if}
              </span>
            {/if}
          </div>
          {#if attempt.run.outputs.length > 0}
            <CellOutputs outputs={attempt.run.outputs} />
          {/if}
        </div>
      {/if}

      {#if attempt.reply}
        <p class="flex flex-wrap gap-x-2 border-t border-line-soft px-3 py-1.5 text-2xs text-muted">
          <span class="font-semibold text-ink">{attempt.reply.by}</span>
          <span class="font-mono">{clock(attempt.reply.at)}</span>
          <span class="min-w-0 flex-1 break-words">{attempt.reply.text}</span>
        </p>
      {/if}

      <div class="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-2">
        <button
          type="button"
          class={attempt.shown ? 'btn-outline h-8' : 'btn-primary h-8'}
          title="Enter"
          onclick={() => onshow(attempt.participantId)}
        >
          <Icon name="board" size={13} />
          {attempt.shown ? 'Показать снова' : 'Показать классу'}
        </button>
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
          {/if}
          Запустить
        </button>
        <button
          type="button"
          class="btn-ghost h-8"
          aria-expanded={replying === 'one'}
          onclick={() => toggleReply('one')}
        >
          Ответить
        </button>
        {#if group && place.same > 0}
          <button
            type="button"
            class="btn-ghost h-8"
            aria-expanded={replying === 'group'}
            onclick={() => toggleReply('group')}
          >
            Ответить всем {group.count}
            {#if board.oracle?.drafts[group.key]}
              <span class="text-2xs text-accent-text">· черновик</span>
            {/if}
          </button>
        {/if}
        <button
          type="button"
          class={cn('btn-ghost h-8', attempt.correct === true && 'text-positive hover:text-positive')}
          aria-pressed={attempt.correct === true}
          onclick={() => onmark(attempt.participantId, attempt.correct === true ? null : true)}
        >
          <Icon name="check" size={13} />
          Верно
        </button>
        <button
          type="button"
          class="btn-ghost ml-auto h-8 text-danger hover:text-danger"
          onclick={(event) => remove(event, attempt)}
        >
          <Icon name="trash" size={13} />
          Убрать
        </button>
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
          to="всем {group.count}"
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
    <p class="text-2xs text-faint">
      ← → попытка · Shift+← → группа · Enter — показать классу · когда фокус в стопке
    </p>
  {/if}
</div>
