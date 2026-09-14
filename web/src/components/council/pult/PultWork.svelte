<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Правая колонка: одна работа целиком.
   *
   * Шапка 50, плита кода, плита вывода, письма, поле ответа — и полоса действий,
   * прибитая к низу. Всё, что выше поля ответа, — только ваше; ниже начинается
   * зал, и туда ведёт ровно одна кнопка.
   *
   * Плита кода НЕ РАСТЁТ: высота разбора не должна зависеть от длины чужого
   * кода. Первые строки видны, дальше плита прокручивается внутри себя, а под
   * ней стоит счёт оставшихся строк.
   */
  import { councilLetters, type CouncilAttempt, type CouncilGroup } from '@shared/protocol'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'
  import Code from '@/components/ui/Code.svelte'
  import { statusLabel } from '@/lib/council-board'
  import { clock } from '@/lib/history'
  import { cn, spell } from '@/lib/utils'
  import PultActions from './PultActions.svelte'
  import PultLetters from './PultLetters.svelte'
  import PultReply from './PultReply.svelte'

  interface Props {
    attempt: CouncilAttempt | null
    group: CouncilGroup | undefined
    /** Номер группы с единицы и сколько групп всего. */
    groupIndex: number
    groups: number
    /** Место работы в ленте: «12 / 487». */
    index: number
    total: number
    variant: number
    names: boolean
    now: number
    onScreen: boolean
    shownAt: number | null
    disabled: boolean
    hasNeighbour: boolean
    reply: string
    replyToGroup: boolean
    onshow: () => void
    onclear: () => void
    onrun: () => void
    oninterrupt: () => void
    onneighbour: () => void
    onmark: (correct: boolean) => void
    onreplychange: (text: string) => void
    onreplytoggle: () => void
    onreplysend: () => void
    onreplyfocus: () => void
    onreplyblur: () => void
  }

  let {
    attempt,
    group,
    groupIndex,
    groups,
    index,
    total,
    variant,
    names,
    now,
    onScreen,
    shownAt,
    disabled,
    hasNeighbour,
    reply,
    replyToGroup,
    onshow,
    onclear,
    onrun,
    oninterrupt,
    onneighbour,
    onmark,
    onreplychange,
    onreplytoggle,
    onreplysend,
    onreplyfocus,
    onreplyblur,
  }: Props = $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
  /** Сколько строк кода показываем, не прокручивая. */
  const LINES = 3

  const writing = $derived(attempt !== null && attempt.submittedAt === null)
  const run = $derived(attempt?.run ?? null)
  const running = $derived(run?.state === 'running' || run?.state === 'queued')
  const letters = $derived(councilLetters(attempt))
  const lines = $derived(attempt ? attempt.text.split('\n') : [])
  const rest = $derived(Math.max(lines.length - LINES, 0))
  const same = $derived(group ? group.count - 1 : 0)

  /** Одна моноширинная строка под именем: всё про место этой работы. */
  const place = $derived.by(() => {
    if (!attempt) return ''
    const parts: string[] = []
    if (attempt.submittedAt !== null) parts.push(tr('room.ui.1322', { p0: clock(attempt.submittedAt) }))
    else parts.push(tr('room.ui.1311'))
    if (groupIndex > 0) parts.push(tr('room.ui.1323', { p0: groupIndex, p1: groups }))
    if (same > 0) parts.push(tr('room.ui.1314', { count: same }))
    parts.push(`${index} / ${total}`)
    return parts.join(' · ')
  })

  const markTone = $derived(
    attempt?.status === 'correct'
      ? 'border-positive text-positive'
      : attempt?.status === 'wrong'
        ? 'border-warning text-warning'
        : attempt?.status === 'failed'
          ? 'border-danger text-danger'
          : 'border-line text-faint',
  )
</script>

{#if !attempt}
  <div class="flex flex-1 items-center justify-center px-16 text-center">
    <p class="text-ui-lg font-bold text-muted">{tr('room.ui.1363')}</p>
  </div>
{:else}
  <div class="flex min-h-0 flex-1 flex-col" data-pult-work={attempt.participantId}>
    <!-- Шапка работы: кто, когда, какая группа и какая это работа по счёту. -->
    <div class="flex h-[50px] shrink-0 items-center gap-2.5 border-b border-line px-4">
      <span
        class="h-[26px] w-[26px] shrink-0 rounded-full"
        style:background-color={names ? attempt.color : 'rgb(var(--line))'}
        aria-hidden="true"
      ></span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-ui-lg font-bold text-ink">
          {names ? attempt.name : tr('room.ui.1255', { p0: variant })}
        </span>
        <span class="truncate font-mono text-micro text-faint">{place}</span>
      </span>
      <span class={cn(CAPS, 'flex h-5 shrink-0 items-center border px-2', markTone)}>
        {statusLabel(attempt)}
      </span>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 pt-3.5">
      <!-- Код: подложка surface, полоса line, и своя прокрутка внутри. -->
      <div class="shrink-0 border-l-2 border-line bg-surface px-3.5 py-3">
        <div class="max-h-[76px] overflow-y-auto">
          <Code code={attempt.text} />
        </div>
        {#if rest > 0}
          <p class="pt-1 font-mono text-micro text-faint">{tr('room.ui.1334', { count: rest })}</p>
        {/if}
      </div>

      <!-- Вывод: подложка raised, полоса цвета исхода, подпись — кто запускал. -->
      {#if run}
        <div
          class={cn(
            'shrink-0 border-l-2 bg-raised px-3.5 py-2.5',
            run.state === 'error' ? 'border-danger' : run.state === 'ok' ? 'border-positive' : 'border-accent',
          )}
        >
          {#if run.outputs.length > 0}
            <CellOutputs outputs={run.outputs} />
          {/if}
          <p class={cn(CAPS, 'pt-1.5 text-faint')}>
            {run.by === 'host' ? tr('room.ui.61') : tr('room.ui.1061')}
            {#if run.ranMs !== null} · {spell(run.ranMs)}{/if}
          </p>
        </div>
      {:else}
        <p class="shrink-0 text-2xs text-faint">{tr('room.ui.1335')}</p>
      {/if}

      {#if letters.length > 0}
        <PultLetters {letters} groupSize={group?.count ?? 1} />
      {/if}

      <div class="min-h-0 flex-1"></div>

      <PultReply
        text={reply}
        toGroup={replyToGroup}
        groupSize={group?.count ?? 1}
        {disabled}
        onchange={onreplychange}
        ontoggle={onreplytoggle}
        onsend={onreplysend}
        onfocus={onreplyfocus}
        onblur={onreplyblur}
      />
    </div>

    <PultActions
      {onScreen}
      running={Boolean(running)}
      elapsed={run ? Math.max(now - run.startedAt, 0) : 0}
      inFrame={shownAt === null ? 0 : Math.max(now - shownAt, 0)}
      ran={run !== null}
      correct={attempt.correct}
      {writing}
      {disabled}
      {hasNeighbour}
      {onshow}
      {onclear}
      {onrun}
      {oninterrupt}
      {onneighbour}
      {onmark}
    />
  </div>
{/if}
