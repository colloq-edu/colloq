<script lang="ts">
  import { tr } from '@shared/i18n'
  import { councilStripText } from '@/lib/council.svelte'
  import type { CouncilBoard } from '@shared/protocol'
  import {
    PULT_TABS,
    filterLabel,
    filterTone,
    tabFilters,
    tabLabel,
    type PultFilter,
    type PultTab,
  } from '@/lib/council-pult'
  /**
   * The list header: three tabs with counters, a row of chips and a
   * magnifier.
   *
   * Before: a line of numbers "13 submitted · 11 drafts", the search and FIVE
   * filter chips in one row. At the column's width the chips wrapped onto a
   * second line, taking one more piece of work away from the list, and
   * "drafts" stood fifth among them — although it is not a filter within a
   * pile but a DIFFERENT pile, with a different question.
   *
   * Now: "Submitted · Writing · All" as tabs, each with its own row of chips.
   * Of those who submitted one asks "what have I not graded yet" (Ungraded ·
   * New · With an error), of those writing "who is stuck" (Silent · Failed ·
   * Run requested). The numbers are on the tabs themselves: both piles are
   * visible without switching.
   *
   * The chip row NEVER wraps — at any width. A wrap costs a row of the list,
   * and a 900×650 window shows only a few rows; so there is one row, and if
   * it is cramped it scrolls sideways, as on a phone. The fifth chip, "not
   * run", was removed from the set: in 280 px (the column at a window width
   * of 860) it did not fit.
   */
  interface Props {
    tab: PultTab
    filter: PultFilter
    /** Tab numbers: how many submitted, how many are writing, how many in all. */
    tabs: Record<PultTab, number>
    /** Chip numbers for the current tab — by the same sieve the chip filters with. */
    chips: Record<PultFilter, number>
    search: string
    searching: boolean
    names: boolean
    counts: CouncilBoard['counts']
    ontab: (tab: PultTab) => void
    onfilter: (filter: PultFilter) => void
    onsearch: (text: string) => void
    onclose: () => void
    onopensearch: () => void
  }
  let {
    tab, filter, tabs, chips, search, searching, names, counts,
    ontab, onfilter, onsearch, onclose, onopensearch,
  }: Props = $props()
  let field = $state<HTMLInputElement | null>(null)
  $effect(() => { if(searching) field?.focus() })
  /**
   * An open search field takes the tab row for itself.
   *
   * At 336 px three tabs with counters take up almost the whole row, and a
   * field squeezed in next to them would be four letters wide. The tabs do
   * not go anywhere: the search is closed with the cross or Esc, and they
   * come back — and in the console people search by name, that is, across
   * the whole class at once.
   */
  const openField = $derived(searching || search !== '')
</script>
<div class="pult-filters" data-searching={openField ? 'yes' : 'no'}>
  <div class="pult-tabs" role="group" aria-label={councilStripText(counts, 0)}>
    {#if openField && names}
      <div class="pult-search">
        <span aria-hidden="true">⌕</span>
        <input bind:this={field} type="search" value={search} placeholder={tr('room.ui.1310')} aria-label={tr('room.ui.1310')} data-pult-search oninput={(event)=>onsearch(event.currentTarget.value)} />
        <button type="button" aria-label={tr('room.pult.closeSearch')} onclick={onclose}>×</button>
      </div>
    {:else}
      <div class="pult-tab-row" role="tablist" aria-label={tr('room.pult.v3.tabs.label')}>
        {#each PULT_TABS as item (item)}
          <button type="button" role="tab" class="pult-tab" aria-selected={tab===item}
            data-pult-tab={item} onclick={()=>ontab(item)}
          >{tabLabel(item)}<span class="pult-tab-n">{tabs[item]}</span></button>
        {/each}
      </div>
      {#if names}
        <button type="button" class="pult-search-open" data-pult-search-open aria-label={tr('room.pult.v3.openSearch')} onclick={onopensearch}><span aria-hidden="true">⌕</span></button>
      {/if}
    {/if}
  </div>
  <div class="pult-chips" role="group" aria-label={tr('room.pult.v2.filterLabel')}>
    {#each tabFilters(tab) as item (item)}
      <button type="button" class:selected={filter===item} data-tone={filterTone(item)} data-pult-chip={item}
        aria-pressed={filter===item} onclick={()=>onfilter(item)}
      >{filterLabel(item)}{#if item !== 'all'}<span class="pult-chip-n">{chips[item]}</span>{/if}</button>
    {/each}
  </div>
</div>
<style>
  .pult-filters { display:flex; flex-direction:column; flex-shrink:0; border-bottom:1px solid rgb(var(--line)); background:rgb(var(--surface)); }
  .pult-tabs { display:flex; align-items:stretch; gap:8px; min-height:42px; padding:0 12px; border-bottom:1px solid rgb(var(--line)); }
  .pult-tab-row { display:flex; align-items:stretch; gap:16px; min-width:0; flex:1; overflow-x:auto; overscroll-behavior-x:contain; scrollbar-width:none; }
  .pult-tab-row::-webkit-scrollbar { display:none; }
  /*
   * A tab is an underline, not a button.
   *
   * The buttons already stand a row above (Work · Queue · Oracle), and a
   * second row of buttons under them would read as a continuation of the
   * same row. An underline is the common sign for "these are tabs inside",
   * and it takes no height.
   */
  .pult-tab { display:inline-flex; align-items:center; gap:6px; flex-shrink:0; padding:2px 0 0; border-bottom:3px solid transparent; background:transparent; color:rgb(var(--muted)); font-size:15px; line-height:20px; white-space:nowrap; cursor:pointer; }
  .pult-tab[aria-selected="true"] { border-bottom-color:rgb(var(--primary)); color:rgb(var(--ink)); font-weight:700; }
  .pult-tab-n { font-variant-numeric:tabular-nums; font-size:13px; }
  .pult-search { display:flex; align-items:center; min-height:34px; gap:6px; flex:1; min-width:0; align-self:center; border:1px solid rgb(var(--line)); background:rgb(var(--canvas)); padding:0 8px; }
  .pult-search span { color:rgb(var(--muted)); font-size:18px; }
  .pult-search input { min-width:0; width:100%; background:transparent; outline:none; color:rgb(var(--ink)); font-size:14px; }
  .pult-search input::placeholder { color:rgb(var(--muted)); }
  .pult-search:focus-within { outline:2px solid rgb(var(--accent-text)); outline-offset:1px; }
  .pult-search button { min-width:28px; min-height:32px; font-size:20px; }
  .pult-search-open { display:flex; align-items:center; justify-content:center; width:32px; min-height:32px; align-self:center; flex-shrink:0; color:rgb(var(--muted)); font-size:18px; cursor:pointer; }
  .pult-search-open:hover { color:rgb(var(--ink)); }
  /*
   * The chip row is ONE line at any width.
   *
   * `nowrap` with no exceptions: a wrap would give the list one piece of
   * work less exactly where only three are visible anyway. When cramped, the
   * row scrolls sideways (the scrollbar is hidden: its room costs pixels
   * too, and here people scroll with a finger and a wheel).
   */
  .pult-chips { display:flex; flex-wrap:nowrap; gap:3px; align-items:center; padding:5px 10px; overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; scrollbar-width:none; }
  .pult-chips::-webkit-scrollbar { display:none; }
  .pult-chips button { display:inline-flex; align-items:center; gap:5px; flex-shrink:0; min-height:28px; padding:4px 8px; background:transparent; color:rgb(var(--ink)); font-size:13px; line-height:18px; cursor:pointer; white-space:nowrap; }
  .pult-chips button[data-tone="danger"] { color:rgb(var(--danger)); }
  .pult-chips button[data-tone="warning"] { color:rgb(var(--warning)); }
  .pult-chips .selected { background:rgb(var(--raised)); font-weight:700; }
  .pult-chip-n { font-variant-numeric:tabular-nums; }
  /*
   * A 280 px column (an 860 window) is the narrowest the list ever gets.
   *
   * The four Russian chips "All · Ungraded 9 · New 2 · With an error 3" did
   * not fit into it by 17 px. What gives way is the AIR, not the row's
   * content: the row's padding, the gaps between chips and around the number
   * inside a chip. Removing a chip would cost a filter that is needed at
   * this width just as much as at a wide one.
   */
  @media(max-width:900px) {
    .pult-tabs { gap:6px; padding:0 10px; }
    .pult-tab-row { gap:12px; }
    .pult-chips { gap:2px; padding-inline:6px; }
    .pult-chips button { gap:4px; padding:4px 5px; }
  }
  @media(max-width:650px) {
    .pult-tabs { min-height:48px; padding:0 12px; }
    .pult-tab { font-size:16px; }
    .pult-search, .pult-search-open { min-height:40px; }
    .pult-search-open { width:40px; }
    .pult-chips { padding:6px 12px; }
    .pult-chips button { min-height:36px; padding:7px 12px; font-size:14px; }
  }
</style>
