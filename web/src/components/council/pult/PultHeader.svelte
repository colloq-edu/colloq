<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Шапка пульта — и регламент ячейки одной строкой. Буквально одной.
   *
   * На месте строки «Личный пульт преподавателя» (её читали один раз в жизни,
   * а стояла она в каждом кадре) — то, что меняется и на что смотрят: кто
   * запускает, сколько длится запуск, когда разрешён повтор, что видит зал.
   * Правила эти живут не в очереди и не в строке состояния, а здесь, над всеми
   * вкладками, потому что они про ЯЧЕЙКУ, а не про открытую работу.
   *
   * Предложением, а не списком ручек: «Запускают по просьбе · каждый запуск до
   * 30 с» читается слева направо один раз, а четыре подписанных переключателя
   * пришлось бы читать каждый раз заново. Нажимают по значению — лист
   * открывается сразу на нём.
   *
   * Заголовок, подпись и регламент стоят в ОДНОЙ строке, а не в трёх: в окне
   * 900×650 постоянная обвязка съедала 290 px из 650, то есть почти половину
   * окна под то, что не меняется за пару. Бюджет шапки теперь 56 px.
   */
  import type { PultRule, RulePart } from '@/lib/council-pult'
  interface Props {
    cellIndex: number | null
    title: string
    /** Регламент словами — council-pult.ts · rulesSentence. */
    rules: RulePart[]
    /** На каком правиле открыт лист: его значение подчёркнуто сплошной. */
    openRule: PultRule | null
    onrules: (rule: PultRule, from: HTMLElement) => void
    onexit: () => void
  }
  let { cellIndex, title, rules, openRule, onrules, onexit }: Props = $props()
  const cell = $derived(cellIndex === null ? '' : tr('room.ui.1272', { p0: String(cellIndex).padStart(2, '0') }))
  const where = $derived([cell, title].filter(Boolean).join(' · '))
</script>
<header class="pult-header">
  <h1>{tr('room.pult.v2.title')}</h1>
  <!-- Ячейка и комната — подпись к заголовку, а не вторая строка: на телефоне
       от неё остаётся номер ячейки, имя комнаты там ничего не решает. -->
  <p class="pult-context" title={where}>
    {#if cell}<span class="pult-context-cell">{cell}</span>{/if}
    {#if title}<span class="pult-context-room">{cell ? ' · ' : ''}{title}</span>{/if}
  </p>
  <div class="pult-rules">
    <button
      type="button"
      class="pult-rules-label"
      data-pult-rules-open
      aria-expanded={openRule !== null}
      title={tr('room.pult.v2.rules.open')}
      onclick={(event) => onrules(rules[0]?.rule ?? 'studentRun', event.currentTarget)}
    >{tr('room.pult.v2.rules.label')}</button>
    <p class="pult-rules-line">
      {#each rules as part, at (part.rule)}
        {#if at > 0}<span class="pult-rules-dot" aria-hidden="true">·</span>{/if}
        <span class="pult-rules-lead">{part.lead}</span>
        <button
          type="button"
          class="pult-value"
          data-pult-rules-value={part.rule}
          data-tone={part.warn ? 'warning' : null}
          aria-expanded={openRule === part.rule}
          onclick={(event) => onrules(part.rule, event.currentTarget)}
        ><span class="pult-rules-wide">{part.value}</span><span class="pult-rules-narrow">{part.short}</span></button>
      {/each}
    </p>
  </div>
  <button type="button" class="pult-button pult-exit" aria-label={tr('room.pult.v3.exit')} onclick={onexit}>
    <span class="pult-exit-word">{tr('room.ui.1271')}</span> <span aria-hidden="true">↗</span>
  </button>
</header>
<style>
  .pult-header { display:flex; align-items:center; gap:10px; flex-shrink:0; min-height:48px; padding:6px var(--pult-pad); border-bottom:1px solid rgb(var(--line)); }
  h1 { flex-shrink:0; font-size:18px; line-height:24px; font-weight:700; margin:0; }
  .pult-context { min-width:0; flex:1; margin:0; color:rgb(var(--muted)); font-size:13px; line-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pult-rules { display:flex; align-items:baseline; gap:8px; min-width:0; flex-shrink:1; }
  .pult-rules-label { flex-shrink:0; color:rgb(var(--faint)); font-size:11px; line-height:14px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; cursor:pointer; }
  /* Одна строка и только одна: регламент, переехавший во вторую, перестаёт быть
     подписью к заголовку и становится абзацем, который читают. */
  .pult-rules-line { display:flex; align-items:baseline; gap:6px; margin:0; font-size:13px; line-height:18px; white-space:nowrap; overflow:hidden; }
  .pult-rules-lead, .pult-rules-dot { color:rgb(var(--muted)); }
  .pult-rules-dot { color:rgb(var(--faint)); }
  .pult-rules-narrow { display:none; }
  .pult-exit { flex-shrink:0; min-height:34px; padding:6px 10px; }
  /* Большое окно — немного воздуха, но не прежние три строки: там, где места
     хватает, тесно быть не обязано. */
  @media(min-width:1200px) and (min-height:800px) {
    .pult-header { min-height:56px; padding-block:10px; }
    h1 { font-size:20px; line-height:26px; }
    .pult-context { font-size:14px; }
  }
  @media(max-width:1100px) {
    /* Связки уходят, значения остаются: «по просьбе · до 30 с · повтор через
       30 с · с именами» — то же предложение, только без служебных слов. */
    .pult-rules-lead { display:none; }
    .pult-rules-wide { display:none; }
    .pult-rules-narrow { display:inline; }
  }
  @media(max-width:860px) {
    /* Уже некуда: от регламента остаётся его имя — и оно же дверь в лист. */
    .pult-rules-line { display:none; }
    .pult-rules-label { padding:0 1px; border-bottom:1px dashed rgb(var(--primary)/.5); color:rgb(var(--primary)); font-size:13px; line-height:18px; letter-spacing:0; text-transform:none; }
  }
  @media(max-width:650px) {
    h1 { font-size:16px; line-height:22px; }
    /* Имя комнаты уступает место: на 360 px решает номер ячейки. */
    .pult-context-room { display:none; }
    /* Выход — значком: подпись «В тетрадь» стоит здесь дороже, чем весит. */
    .pult-exit-word { display:none; }
    .pult-exit { min-height:40px; min-width:40px; padding:6px 8px; font-size:16px; }
  }
</style>
