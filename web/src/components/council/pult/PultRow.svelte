<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Строка списка пульта — главный предмет мессенджера.
   *
   * 50 px и шесть слотов, из которых ни один не плавает: слот, пустой в этой
   * строке, всё равно занимает своё место, иначе соседние строки перестают
   * читаться колонками (Paper · 05c · доска 06). Высота не меняется НИКОГДА —
   * меняются полоса слева, подложка и хвост.
   *
   * Полоса смысла 3 px есть у каждой строки, чаще всего цвета корпуса, то есть
   * невидимая: строка не должна дёргаться вбок оттого, что человек попросил
   * запуск. По той же причине точку непрочитанного рисует пустой кружок, а не
   * `{#if}`.
   *
   * Компонент чистый: всё приезжает пропсами, нажатия уходят наверх.
   */
  import type { CouncilAttempt } from '@shared/protocol'
  import { statusLabel } from '@/lib/council-board'
  import type { RowMeaning } from '@/lib/council-pult'
  import { clock } from '@/lib/history'
  import { cn } from '@/lib/utils'

  interface Props {
    attempt: CouncilAttempt
    /** Сдал после того, как в список смотрели: голубая точка слева. */
    unread: boolean
    /** Строка внутри раскрытой группы: отступ и подпись «та же строка». */
    inGroup: boolean
    /** Номер варианта — подпись при выключенных именах. */
    variant: number
    /** Имена включены; выключены — «Вариант N» в muted и серый диск. */
    names: boolean
    /** Выбрана: подложка raised, полоса accent, работа открыта справа. */
    selected: boolean
    /** Кольцо фокуса: только когда пришли с клавиатуры. */
    focused: boolean
    meaning: RowMeaning
    /** Сколько ЕЩЁ написали то же самое; 0 — никого. */
    same: number
    /** Пустить в ядро прямо отсюда; `null` — просьбы нет или решать нельзя. */
    onlet: (() => void) | null
    onopen: () => void
  }

  let { attempt, unread, inGroup, variant, names, selected, focused, meaning, same, onlet, onopen }: Props =
    $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
  const writing = $derived(attempt.submittedAt === null)

  /** Полоса смысла: что от вас требуется, а не что случилось. */
  const stripe = $derived(
    meaning === 'asking'
      ? 'border-l-warning'
      : meaning === 'screen'
        ? 'border-l-positive'
        : meaning === 'cursor'
          ? 'border-l-accent'
          : 'border-l-transparent',
  )

  /** Отметка капителью — слово и его цвет. */
  const mark = $derived.by(() => {
    if (writing) return { text: tr('room.ui.1311'), tone: 'text-accent' }
    switch (attempt.status) {
      case 'correct':
        return { text: `✓ ${statusLabel(attempt)}`, tone: 'text-positive' }
      case 'wrong':
        return { text: `✗ ${statusLabel(attempt)}`, tone: 'text-warning' }
      case 'failed':
        return { text: statusLabel(attempt), tone: 'text-danger' }
      default:
        return { text: statusLabel(attempt), tone: 'text-faint' }
    }
  })

  /**
   * Одно уточнение справа от отметки, и не больше двух слов.
   *
   * Порядок важен: «просит запуск» вытесняет всё, потому что это единственное,
   * что требует от вас действия прямо сейчас; «на экране» — единственное, что
   * прямо сейчас видит зал.
   */
  const why = $derived.by(() => {
    if (meaning === 'asking') return { text: tr('room.ui.1382'), tone: 'text-warning font-bold' }
    if (inGroup) return { text: tr('room.ui.1319'), tone: 'text-faint' }
    if (writing) return null
    if (attempt.status === 'failed' && same === 0) return { text: tr('room.ui.1321'), tone: 'text-faint' }
    if (same > 0) return { text: tr('room.ui.1314', { count: same }), tone: 'text-faint' }
    return null
  })
</script>

<div
  class={cn(
    'flex h-[50px] shrink-0 items-center gap-[9px] border-b border-l-[3px] border-b-line pr-3 text-left',
    stripe,
    inGroup ? 'pl-[21px]' : 'pl-[9px]',
    selected ? 'bg-raised' : 'hover:bg-surface',
    focused && 'outline outline-2 -outline-offset-2 outline-accent',
  )}
  data-pult-row={attempt.participantId}
  data-selected={selected ? 'yes' : 'no'}
>
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-[9px] text-left"
    tabindex="-1"
    onclick={onopen}
  >
    <!-- Слот точки занят всегда: гаснущая точка не должна двигать имя. -->
    <span
      class={cn('h-[7px] w-[7px] shrink-0 rounded-full', unread ? 'bg-accent' : 'bg-transparent')}
      aria-hidden="true"
    ></span>
    <span
      class="h-[22px] w-[22px] shrink-0 rounded-full"
      style:background-color={names ? attempt.color : 'rgb(var(--line))'}
      aria-hidden="true"
    ></span>
    <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span class={cn('truncate text-ui font-bold', names ? 'text-ink' : 'text-muted')}>
        {names ? attempt.name : tr('room.ui.1255', { p0: variant })}
      </span>
      <span class="flex min-w-0 items-center gap-1.5">
        <span class={cn(CAPS, 'shrink-0', mark.tone)}>{mark.text}</span>
        {#if meaning === 'screen'}
          <span class={cn(CAPS, 'shrink-0 bg-positive px-1.5 py-px text-canvas')}>{tr('room.ui.1313')}</span>
        {:else if why}
          <!-- Уточнение уступает место кнопке, а не лезет под неё: слоты в
               строке фиксированы, и растягивается только этот. -->
          <span class={cn('min-w-0 truncate text-2xs', why.tone)}>{why.text}</span>
        {/if}
      </span>
    </span>
  </button>
  <!--
    Хвост: время сдачи — или кнопка, когда от вас требуется действие. Это
    единственный случай, когда строка теряет время: пустить в ядро можно прямо
    отсюда, не открывая работу и не теряя места в списке.
  -->
  {#if onlet}
    <button
      type="button"
      class={cn(CAPS, 'h-6 shrink-0 bg-warning px-3 text-surface')}
      tabindex="-1"
      onclick={onlet}
    >{tr('room.ui.1296')}</button>
  {:else if writing}
    <span class="w-[30px] shrink-0 text-right font-mono text-micro text-accent">{tr('room.ui.1312')}</span>
  {:else}
    <span class="w-[30px] shrink-0 text-right font-mono text-micro text-faint">
      {clock(attempt.submittedAt ?? 0)}
    </span>
  {/if}
</div>
