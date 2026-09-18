<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Шапка пульта — и регламент ячейки одной строкой.
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
  const where = $derived([cellIndex === null ? '' : tr('room.ui.1272', { p0: String(cellIndex).padStart(2, '0') }), title].filter(Boolean).join(' · '))
</script>
<header class="pult-header">
  <div class="pult-heading">
    <h1>{tr('room.pult.v2.title')}</h1>
    <p class="pult-context" title={where}>{where}</p>
  </div>
  <div class="pult-header-actions">
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
    <button type="button" class="pult-button" onclick={onexit}>{tr('room.ui.1271')} <span aria-hidden="true">↗</span></button>
  </div>
</header>
<style>
  .pult-header { display:flex; align-items:center; justify-content:space-between; gap:24px; flex-shrink:0; padding:20px var(--pult-pad); border-bottom:1px solid rgb(var(--line)); }
  .pult-heading { min-width:0; }
  h1 { font-size:26px; line-height:32px; font-weight:700; margin:0 0 6px; }
  .pult-context { margin:0; color:rgb(var(--muted)); font-size:14px; line-height:20px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pult-header-actions { display:flex; align-items:center; gap:20px; flex-shrink:0; }
  .pult-rules { display:flex; flex-direction:column; align-items:flex-end; gap:6px; min-width:0; }
  .pult-rules-label { flex-shrink:0; color:rgb(var(--faint)); font-size:11px; line-height:14px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; cursor:pointer; }
  /* Одна строка и только одна: регламент, переехавший во вторую, перестаёт быть
     подписью к заголовку и становится абзацем, который читают. */
  .pult-rules-line { display:flex; align-items:baseline; gap:6px; margin:0; font-size:14px; line-height:20px; white-space:nowrap; }
  .pult-rules-lead, .pult-rules-dot { color:rgb(var(--muted)); }
  .pult-rules-dot { color:rgb(var(--faint)); }
  .pult-rules-narrow { display:none; }
  @media(max-width:1000px) {
    /* Связки уходят, значения остаются: «по просьбе · до 30 с · повтор через
       30 с · с именами» — то же предложение, только без служебных слов. */
    .pult-rules-lead { display:none; }
    .pult-rules-wide { display:none; }
    .pult-rules-narrow { display:inline; }
  }
  @media(max-width:650px) {
    .pult-header { padding-top:14px; padding-bottom:14px; gap:12px; }
    h1 { font-size:22px; line-height:28px; }
    /* Уже некуда: от регламента остаётся его имя — и оно же дверь в лист. */
    .pult-rules-line { display:none; }
    .pult-rules-label { padding:0 1px; border-bottom:1px dashed rgb(var(--primary)/.5); color:rgb(var(--primary)); font-size:13px; line-height:18px; letter-spacing:0; text-transform:none; }
  }
</style>
