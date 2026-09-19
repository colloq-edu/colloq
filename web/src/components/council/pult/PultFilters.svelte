<script lang="ts">
  import { tr } from '@shared/i18n'
  import { councilStripText } from '@/lib/council.svelte'
  import type { CouncilBoard } from '@shared/protocol'
  import { FILTERS, filterLabel, type PultFilter } from '@/lib/council-pult'
  /**
   * Надпись над списком: сколько сдано, поиск и шесть чипов отбора.
   *
   * Всё это — постоянная обвязка, и цена ей — строки списка: в окне 900×650 она
   * съедала около ста пикселей, то есть полторы работы из двух с половиной
   * видимых. Поэтому здесь ровно две строки: числа с поиском и ряд чипов.
   *
   * Чипы — все шесть, без «Ещё» в выпадающем списке. Отбор, спрятанный в
   * `<select>`, надо СНАЧАЛА открыть, чтобы узнать, что в нём есть, а на паре
   * его открывают одной рукой, глядя в зал; на телефоне ряд листается вбок.
   */
  interface Props {
    filter: PultFilter; search: string; searching: boolean; names: boolean;
    counts: CouncilBoard['counts']; groups: number;
    /** Узкое окно: поиск раскрывается по значку, чипы листаются вбок. */
    phone: boolean;
    onfilter: (filter: PultFilter) => void; onsearch: (text: string) => void;
    onclose: () => void; onopensearch: () => void
  }
  let { filter, search, searching, names, counts, groups, phone, onfilter, onsearch, onclose, onopensearch }: Props = $props()
  let field = $state<HTMLInputElement | null>(null)
  $effect(() => { if(searching) field?.focus() })
  /** На телефоне поле поиска занимает всю строку — числа уступают ему место. */
  const openField = $derived(!phone || searching || search !== '')
</script>
<div class="pult-filters" data-searching={openField ? 'yes' : 'no'}>
  <div class="pult-filters-top">
    <div class="pult-counts" role="group" aria-label={councilStripText(counts, groups)}><strong>{counts.submitted}</strong><span>{tr('room.pult.v2.submitted')} · {tr('room.ui.1056',{count:counts.writing})}</span></div>
    {#if names}
      {#if openField}
        <div class="pult-search">
          <span aria-hidden="true">⌕</span>
          <input bind:this={field} type="search" value={search} placeholder={tr('room.ui.1310')} aria-label={tr('room.ui.1310')} data-pult-search oninput={(event)=>onsearch(event.currentTarget.value)} />
          {#if search || phone}<button type="button" aria-label={tr('room.pult.closeSearch')} onclick={onclose}>×</button>{/if}
        </div>
      {:else}
        <button type="button" class="pult-search-open" data-pult-search-open aria-label={tr('room.pult.v3.openSearch')} onclick={onopensearch}><span aria-hidden="true">⌕</span></button>
      {/if}
    {/if}
  </div>
  <div class="pult-chips" role="group" aria-label={tr('room.pult.v2.filterLabel')}>
    {#each FILTERS as item (item)}
      <button type="button" class:selected={filter===item} aria-pressed={filter===item} onclick={()=>onfilter(item)}>{filterLabel(item)}</button>
    {/each}
  </div>
</div>
<style>
  .pult-filters { display:flex; flex-direction:column; gap:6px; flex-shrink:0; padding:8px 12px; border-bottom:1px solid rgb(var(--line)); background:rgb(var(--surface)); }
  .pult-filters-top { display:flex; align-items:center; gap:8px; min-height:34px; }
  .pult-counts { display:flex; align-items:baseline; gap:6px; min-width:0; margin:0; }
  .pult-counts strong { font-size:18px; line-height:24px; font-weight:700; }
  .pult-counts span { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:13px; color:rgb(var(--muted)); }
  .pult-search { display:flex; align-items:center; min-height:34px; gap:6px; flex:1; min-width:0; border:1px solid rgb(var(--line)); background:rgb(var(--canvas)); padding:0 8px; }
  .pult-search span { color:rgb(var(--muted)); font-size:18px; }
  .pult-search input { min-width:0; width:100%; background:transparent; outline:none; color:rgb(var(--ink)); font-size:14px; }
  .pult-search input::placeholder { color:rgb(var(--muted)); }
  .pult-search:focus-within { outline:2px solid rgb(var(--accent-text)); outline-offset:1px; }
  .pult-search button { min-width:28px; min-height:32px; font-size:20px; }
  .pult-search-open { display:flex; align-items:center; justify-content:center; width:34px; min-height:34px; margin-left:auto; flex-shrink:0; border:1px solid rgb(var(--line)); background:rgb(var(--canvas)); color:rgb(var(--muted)); font-size:18px; cursor:pointer; }
  /*
   * Ряд чипов листается вбок и не переносится на телефоне: перенос отдал бы
   * списку на строку меньше ровно там, где строк и так мало.
   */
  .pult-chips { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
  .pult-chips button { min-height:30px; padding:5px 8px; background:transparent; color:rgb(var(--muted)); font-size:13px; cursor:pointer; white-space:nowrap; }
  .pult-chips .selected { background:rgb(var(--raised)); color:rgb(var(--ink)); font-weight:600; }
  @media(max-width:650px) {
    .pult-filters { gap:8px; padding:8px 12px; }
    .pult-filters-top { min-height:40px; }
    .pult-search, .pult-search-open { min-height:40px; }
    .pult-search-open { width:40px; }
    .pult-filters[data-searching='yes'] .pult-counts { display:none; }
    .pult-chips { flex-wrap:nowrap; overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; scrollbar-width:none; }
    .pult-chips::-webkit-scrollbar { display:none; }
    .pult-chips button { min-height:36px; padding:7px 12px; font-size:14px; }
  }
</style>
