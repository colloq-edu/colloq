<script lang="ts">
  import { tr } from '@shared/i18n'
  import { councilStripText } from '@/lib/council.svelte'
  import type { CouncilBoard } from '@shared/protocol'
  import { FILTERS, filterLabel, type PultFilter } from '@/lib/council-pult'
  interface Props {
    filter: PultFilter; search: string; searching: boolean; names: boolean;
    counts: CouncilBoard['counts']; groups: number;
    onfilter: (filter: PultFilter) => void; onsearch: (text: string) => void;
    onclose: () => void; onopensearch: () => void
  }
  let { filter, search, searching, names, counts, groups, onfilter, onsearch, onclose }: Props = $props()
  let field = $state<HTMLInputElement | null>(null)
  $effect(() => { if(searching) field?.focus() })
</script>
<div class="pult-filters">
  <div class="pult-counts" role="group" aria-label={councilStripText(counts, groups)}><strong>{counts.submitted}</strong><span>{tr('room.pult.v2.submitted')} · {tr('room.ui.1056',{count:counts.writing})}</span></div>
  {#if names}
    <div class="pult-search">
      <span aria-hidden="true">⌕</span>
      <input bind:this={field} type="search" value={search} placeholder={tr('room.ui.1310')} aria-label={tr('room.ui.1310')} data-pult-search oninput={(event)=>onsearch(event.currentTarget.value)} />
      {#if search}<button type="button" aria-label={tr('room.pult.closeSearch')} onclick={onclose}>×</button>{/if}
    </div>
  {/if}
  <div class="pult-filter-controls">
    {#each ['all','error'] as item}
      <button type="button" class:selected={filter===item} aria-pressed={filter===item} onclick={()=>onfilter(item as PultFilter)}>{filterLabel(item as PultFilter)}</button>
    {/each}
    <select class:selected={!['all','error'].includes(filter)} aria-label={tr('room.pult.v2.filterLabel')} value={['all','error'].includes(filter)?'':filter} onchange={(event)=>onfilter(event.currentTarget.value as PultFilter)}>
      <option value="" disabled>{tr('room.pult.v2.moreFilters')}</option>
      {#each FILTERS.filter(item=>item!=='all'&&item!=='error') as item}<option value={item}>{filterLabel(item)}</option>{/each}
    </select>
  </div>
</div>
<style>
  .pult-filters { display:flex; flex-direction:column; gap:10px; flex-shrink:0; padding:16px 20px; border-bottom:1px solid rgb(var(--line)); background:rgb(var(--surface)); }
  .pult-counts { display:flex; align-items:baseline; gap:8px; margin:0; }
  .pult-counts strong { font-size:26px; line-height:32px; font-weight:700; }
  .pult-counts span { font-size:14px; color:rgb(var(--muted)); }
  .pult-search { display:flex; align-items:center; min-height:40px; gap:6px; border:1px solid rgb(var(--line)); background:rgb(var(--canvas)); padding:0 10px; }
  .pult-search span { color:rgb(var(--muted)); font-size:20px; }
  .pult-search input { min-width:0; width:100%; background:transparent; outline:none; color:rgb(var(--ink)); font-size:14px; }
  .pult-search input::placeholder { color:rgb(var(--muted)); }
  .pult-search:focus-within { outline:2px solid rgb(var(--accent-text)); outline-offset:1px; }
  .pult-search button { min-width:28px; min-height:32px; font-size:20px; }
  .pult-filter-controls { display:flex; gap:4px; align-items:center; }
  .pult-filter-controls button,.pult-filter-controls select { min-width:0; min-height:32px; padding:5px 8px; background:transparent; color:rgb(var(--muted)); font-size:14px; cursor:pointer; }
  .pult-filter-controls select { flex:1; }
  .pult-filter-controls option { background:rgb(var(--canvas)); color:rgb(var(--ink)); }
  .pult-filter-controls .selected { background:rgb(var(--raised)); color:rgb(var(--ink)); font-weight:600; }
</style>
