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
  import { othersWaiting, type PultCellRow, type PultRule, type RulePart } from '@/lib/council-pult'
  import ConsoleLink from '@/components/lecture/ConsoleLink.svelte'
  import PultCells from './PultCells.svelte'
  interface Props {
    /** Ячейка, на которой пульт стоит сейчас. */
    cellId: string
    /** Все ячейки консилиума комнаты — список выбора за номером ячейки. */
    cells: readonly PultCellRow[]
    title: string
    /** Регламент словами — council-pult.ts · rulesSentence. */
    rules: RulePart[]
    /** На каком правиле открыт лист: его значение подчёркнуто сплошной. */
    openRule: PultRule | null
    onrules: (rule: PultRule, from: HTMLElement) => void
    onpick: (cellId: string) => void
    onexit: () => void
  }
  let { cellId, cells, title, rules, openRule, onrules, onpick, onexit }: Props = $props()
  const here = $derived(cells.find((cell) => cell.cellId === cellId) ?? null)
  const place = $derived(cells.findIndex((cell) => cell.cellId === cellId) + 1)
  /**
   * Сколько ДРУГИХ ячеек ждут оценки.
   *
   * Не «сколько работ» и не «сколько ячеек всего»: единственный повод открыть
   * меню, не собираясь никуда переключаться, — узнать, что где-то ещё копится
   * непроверенное. Ноль не пишется вовсе: «ещё в 0 ждут оценки» — это строка,
   * которую читают каждый раз, чтобы каждый раз ничего не узнать.
   */
  const others = $derived(othersWaiting(cells, cellId))
</script>
<header class="pult-header">
  <h1>{tr('room.pult.v2.title')}</h1>
  <!-- Ячейка и комната — подпись к заголовку, а не вторая строка: на телефоне
       от неё остаётся номер ячейки, имя комнаты там ничего не решает. Номер —
       дверь в список ячеек: пульт один на комнату, и вторую ячейку смотрят в
       нём же, а не вторым окном. -->
  <!-- `div`, а не `p`: внутри стоит меню ячеек, а `div` внутри абзаца — это
       разметка, которую разбиратель HTML чинит по-своему. -->
  <div class="pult-context">
    <PultCells {cells} current={cellId} {onpick} />
    <!-- Где мы среди ячеек — и есть ли непроверенное в СОСЕДНИХ. Второе и есть
         повод открыть меню, не собираясь никуда переключаться. -->
    {#if cells.length > 1}
      <span class="pult-context-place" data-pult-cell-place
        >{tr('room.pult.v3.cells.place', { index: place, total: cells.length })}{#if others > 0}{' · '}{tr('room.pult.v3.cells.othersWaiting', { count: others })}{/if}</span>
    {/if}
    <!-- Консилиум закрыт, попытки остались: менять нечего, смотреть можно. -->
    {#if here?.review}<span class="pult-context-review">{tr('room.pult.v3.cells.review')}</span>{/if}
    {#if title}<span class="pult-context-room"> · {title}</span>{/if}
  </div>
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
  <!--
    Ссылка на этот пульт с преподавательским входом — тем же поповером, что у
    пульта лекции (lecture/ConsoleLink.svelte), и не копией его: ключ, отказы,
    «Поделиться» и слова про один раз в десять минут обязаны быть одними на оба
    пульта. Значок с подписью, а не длинная кнопка: бюджет шапки — 56 px.
  -->
  <ConsoleLink class="pult-button pult-link" {cellId} />
  <button type="button" class="pult-button pult-exit" aria-label={tr('room.pult.v3.exit')} onclick={onexit}>
    <span class="pult-exit-word">{tr('room.ui.1271')}</span> <span aria-hidden="true">↗</span>
  </button>
</header>
<style>
  .pult-header { display:flex; align-items:center; gap:10px; flex-shrink:0; min-height:48px; padding:6px var(--pult-pad); border-bottom:1px solid rgb(var(--line)); }
  h1 { flex-shrink:0; font-size:18px; line-height:24px; font-weight:700; margin:0; }
  /*
   * Ячейка важнее регламента — и в шапке это порядок уступок.
   *
   * До 20.09 в контексте стояло «ячейка 03 · Комната», и ему хватало остатка
   * после предложения регламента. Теперь тут НАЗВАНИЕ задания, на которое
   * смотрят весь семинар, и уступать место оно не должно: `flex:0 1 auto` вместо
   * `flex:1`, а свободную ширину забирает предложение — оно и сжимается первым
   * (`flex-shrink` у него больше), а на узком окне сворачивается в своё имя.
   */
  .pult-context { display:flex; align-items:center; gap:8px; min-width:0; flex:0 1 auto; margin:0; color:rgb(var(--muted)); font-size:13px; line-height:18px; white-space:nowrap; overflow:hidden; }
  .pult-context-place { flex-shrink:0; }
  .pult-context-review { flex-shrink:0; padding:0 5px; border:1px solid rgb(var(--line)); color:rgb(var(--muted)); font-size:11px; line-height:16px; }
  .pult-context-room { min-width:0; overflow:hidden; text-overflow:ellipsis; }
  /*
   * Регламент не сжимается ВОВСЕ — ни предложением, ни именем.
   *
   * Сжимался он до 19 px на 390 px, и «Регламент» вылезал из своей коробки под
   * соседнюю кнопку: слово наезжало на значок «На телефон». Место ему уступает
   * контекст (название задания умеет обрезаться многоточием), а само
   * предложение исчезает ступенями ниже.
   */
  .pult-rules { display:flex; align-items:baseline; gap:8px; flex:0 0 auto; margin-left:auto; }
  .pult-rules-label { flex-shrink:0; color:rgb(var(--faint)); font-size:11px; line-height:14px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; cursor:pointer; }
  /*
   * Одна строка и только одна: регламент, переехавший во вторую, перестаёт быть
   * подписью к заголовку и становится абзацем, который читают.
   *
   * И НЕ СЖИМАЕТСЯ: предложение читают слева направо один раз, а обрезанное
   * посередине («все по очереди · до 30 с …») — это уже не предложение, а
   * половина правила, по которой принимают решение. Всё или ничего: ступени
   * ниже убирают сперва связки, потом предложение целиком, оставляя его имя.
   */
  .pult-rules-line { display:flex; align-items:baseline; gap:6px; flex-shrink:0; margin:0; font-size:13px; line-height:18px; white-space:nowrap; overflow:hidden; }
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
  /*
   * Ступени шапки — сверху вниз по цене.
   *
   * В шапке прибавилось название задания и «ячейка 2 из 4 · ещё в N ждут
   * оценки», и порядок уступок теперь такой: связки предложения (1500), имя
   * комнаты (1400 — оно же стоит в заголовке окна), само предложение (1200 —
   * от него остаётся имя, и оно же дверь в лист), место среди ячеек (1000).
   * Название задания не уступает никогда: ради него кнопку и завели.
   */
  @media(max-width:1500px) {
    .pult-rules-lead { display:none; }
    .pult-rules-wide { display:none; }
    .pult-rules-narrow { display:inline; }
  }
  @media(max-width:1400px) { .pult-context-room { display:none; } }
  @media(max-width:1200px) {
    /* Уже некуда: от регламента остаётся его имя — и оно же дверь в лист. */
    .pult-rules-line { display:none; }
    .pult-rules-label { padding:0 1px; border-bottom:1px dashed rgb(var(--primary)/.5); color:rgb(var(--primary)); font-size:13px; line-height:18px; letter-spacing:0; text-transform:none; }
  }
  @media(max-width:1000px) { .pult-context-place { display:none; } }
  @media(max-width:650px) {
    /*
     * «Консилиум» уступает место названию задания.
     *
     * На 390 px слово занимает 80 px из 390 и повторяет заголовок окна и
     * вкладки, а название задания без него сжималось до «60 Зада…». Из
     * разметки заголовок не уходит: страница без h1 — это страница без имени
     * для тех, кто читает её голосом.
     */
    h1 { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
    /* Выход — значком: подпись «В тетрадь» стоит здесь дороже, чем весит. */
    .pult-exit-word { display:none; }
    .pult-exit { min-height:40px; min-width:40px; padding:6px 8px; font-size:16px; }
  }
</style>
