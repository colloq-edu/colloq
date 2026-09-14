<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Полоса отбора, 36 px: шесть чипов по 22 и одно число справа.
   *
   * Счётчиков крупным кеглем в мессенджере нет: сколько сдало из скольких —
   * это одна строка, а не приборная доска. Поиск открывается по ⌘F и встаёт на
   * место числа; при выключенных именах его нет вовсе — искать нечего, имён в
   * пульте не показывают.
   */
  import type { CouncilBoard } from '@shared/protocol'
  import { councilStripText } from '@/lib/council.svelte'
  import { FILTERS, filterLabel, type PultFilter } from '@/lib/council-pult'
  import { cn } from '@/lib/utils'

  interface Props {
    filter: PultFilter
    search: string
    /** Поле поиска раскрыто. */
    searching: boolean
    /** Имена включены: выключены — поиск по имени не работает. */
    names: boolean
    /** Счётчики комнаты — их же складывает полоса режима. */
    counts: CouncilBoard['counts']
    /** Сколько разных ответов ВИДНО: сервер считает их по всей комнате. */
    groups: number
    onfilter: (filter: PultFilter) => void
    onsearch: (text: string) => void
    onclose: () => void
  }

  let { filter, search, searching, names, counts, groups, onfilter, onsearch, onclose }: Props = $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
  let field = $state<HTMLInputElement | null>(null)

  // Фокус в поле, как только его открыли: ⌘F, после которого надо ещё
  // прицелиться мышью, — это не поиск, а два действия вместо одного.
  $effect(() => {
    if (searching) field?.focus()
  })
</script>

<div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-4">
  {#each FILTERS as item (item)}
    <button
      type="button"
      class={cn(
        CAPS,
        'h-[22px] shrink-0 border px-2',
        filter === item ? 'border-accent text-accent' : 'border-line text-muted hover:text-ink',
      )}
      aria-pressed={filter === item}
      onclick={() => onfilter(item)}
    >{filterLabel(item)}</button>
  {/each}
  <div class="min-w-0 flex-1"></div>
  {#if searching && names}
    <input
      bind:this={field}
      class="h-[22px] w-40 shrink-0 border border-accent bg-canvas px-2 text-2xs text-ink outline-none"
      type="search"
      value={search}
      placeholder={tr('room.ui.1310')}
      data-pult-search
      oninput={(event) => onsearch(event.currentTarget.value)}
      onblur={onclose}
    />
  {:else}
    <!--
      Полоса режима старой консоли: попытки, сдачи, пишущие и число разных
      ответов. Складывает её одна функция на весь клиент (`councilStripText`) —
      это уже был третий способ считать одно и то же, и он с остальными
      расходился.
    -->
    <span class="min-w-0 truncate font-mono text-micro text-faint">
      {councilStripText(counts, groups)}
    </span>
  {/if}
</div>
