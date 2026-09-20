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
   * Шапка списка: три вкладки со счётчиками, ряд чипов и лупа.
   *
   * Было: строка чисел «13 сдано · 11 черновиков», поиск и ПЯТЬ чипов отбора в
   * одном ряду. Чипы на ширине колонки переносились на вторую строку, отнимая у
   * списка ещё одну работу, а «черновики» стоял среди них пятым — хотя это не
   * отбор внутри стопки, а ДРУГАЯ стопка, с другим вопросом.
   *
   * Стало: «Сдали · Пишут · Все» вкладками, и у каждой свой ряд чипов. У
   * сдавших спрашивают «что я ещё не оценил» (Без оценки · Новые · С ошибкой),
   * у пишущих — «кто застрял» (Молчат · Упало · Просят запуск). Числа стоят на
   * самих вкладках: обе стопки видны, не переключаясь.
   *
   * Ряд чипов НЕ ПЕРЕНОСИТСЯ никогда — ни на какой ширине. Перенос стоит строку
   * списка, а строк в окне 900×650 всего несколько; поэтому ряд один, а если
   * ему тесно, он листается вбок, как на телефоне. Пятый чип «не запущены» из
   * набора убран: в 280 px (колонка при ширине окна 860) он не помещался.
   */
  interface Props {
    tab: PultTab
    filter: PultFilter
    /** Числа на вкладках: сколько сдали, сколько пишут, сколько всего. */
    tabs: Record<PultTab, number>
    /** Числа в чипах текущей вкладки — тем же ситом, каким чип и отбирает. */
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
   * Открытое поле поиска забирает ряд вкладок себе.
   *
   * На 336 px три вкладки со счётчиками занимают почти весь ряд, и поле,
   * втиснутое рядом, было бы шириной в четыре буквы. Вкладки при этом никуда не
   * деваются: поиск закрывают крестиком или Esc, и они возвращаются на место —
   * а искать в пульте ищут по имени, то есть по всему классу сразу.
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
   * Вкладка — подчёркиванием, а не кнопкой.
   *
   * Кнопки уже стоят строкой выше (Работы · Очередь · Оракул), и второй ряд
   * кнопок под ними читался бы как продолжение того же ряда. Подчёркивание —
   * общий знак «это вкладки внутри», и оно не занимает высоты.
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
   * Ряд чипов — ОДНА строка на любой ширине.
   *
   * `nowrap` без оговорок: перенос отдал бы списку на работу меньше ровно там,
   * где работ и так видно три. Тесно — ряд листается вбок (полоса скрыта: её
   * место тоже стоит пикселей, а листают здесь пальцем и колесом).
   */
  .pult-chips { display:flex; flex-wrap:nowrap; gap:3px; align-items:center; padding:5px 10px; overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; scrollbar-width:none; }
  .pult-chips::-webkit-scrollbar { display:none; }
  .pult-chips button { display:inline-flex; align-items:center; gap:5px; flex-shrink:0; min-height:28px; padding:4px 8px; background:transparent; color:rgb(var(--ink)); font-size:13px; line-height:18px; cursor:pointer; white-space:nowrap; }
  .pult-chips button[data-tone="danger"] { color:rgb(var(--danger)); }
  .pult-chips button[data-tone="warning"] { color:rgb(var(--warning)); }
  .pult-chips .selected { background:rgb(var(--raised)); font-weight:700; }
  .pult-chip-n { font-variant-numeric:tabular-nums; }
  /*
   * Колонка 280 px (окно 860) — самая узкая, какая бывает у списка.
   *
   * Четыре чипа «Все · Без оценки 9 · Новые 2 · С ошибкой 3» не влезали в неё
   * на 17 px. Уступает ВОЗДУХ, а не состав ряда: поля строки, зазоры между
   * чипами и вокруг числа внутри чипа. Убрать один чип стоило бы отбора,
   * который на этой ширине нужен ровно так же, как на широкой.
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
