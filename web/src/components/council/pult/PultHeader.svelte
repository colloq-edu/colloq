<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * The console header — and the cell's rules in one line. Literally one.
   *
   * In place of the "Teacher's personal console" line (read once in a
   * lifetime, yet present in every frame) stands what changes and what
   * people look at: who runs, how long a run lasts, when a repeat is
   * allowed, what the room sees. These rules live not in the queue and not
   * in the status line but here, above all the tabs, because they are about
   * the CELL, not about the open piece of work.
   *
   * As a sentence, not a list of controls: "Run on request · each run up to
   * 30 s" is read left to right once, whereas four labelled switches would
   * have to be read anew every time. People press on a value — the sheet
   * opens right on it.
   *
   * The title, the caption and the rules stand on ONE line, not three: in a
   * 900×650 window the permanent frame ate 290 px of 650, that is, almost
   * half the window for things that do not change during a class. The
   * header's budget is now 56 px.
   */
  import { othersWaiting, type PultCellRow, type PultRule, type RulePart } from '@/lib/council-pult'
  import ConsoleLink from '@/components/lecture/ConsoleLink.svelte'
  import PultCells from './PultCells.svelte'
  interface Props {
    /** The cell the console is on right now. */
    cellId: string
    /** All of the room's council cells — the picker list behind the cell number. */
    cells: readonly PultCellRow[]
    title: string
    /** The rules in words — council-pult.ts · rulesSentence. */
    rules: RulePart[]
    /** Which rule the sheet is open on: its value gets a solid underline. */
    openRule: PultRule | null
    onrules: (rule: PultRule, from: HTMLElement) => void
    onpick: (cellId: string) => void
    onexit: () => void
  }
  let { cellId, cells, title, rules, openRule, onrules, onpick, onexit }: Props = $props()
  const here = $derived(cells.find((cell) => cell.cellId === cellId) ?? null)
  const place = $derived(cells.findIndex((cell) => cell.cellId === cellId) + 1)
  /**
   * How many OTHER cells are waiting for review.
   *
   * Not "how many pieces of work" and not "how many cells in total": the
   * only reason to open the menu without meaning to switch anywhere is to
   * learn that unreviewed work is piling up somewhere else. Zero is not
   * written at all: "0 more cells await review" is a line read every time
   * only to learn nothing every time.
   */
  const others = $derived(othersWaiting(cells, cellId))
</script>
<header class="pult-header">
  <h1>{tr('room.pult.v2.title')}</h1>
  <!-- The cell and the room are a caption to the title, not a second line: on
       a phone only the cell number is left of it, and the room name decides
       nothing there. The number is the door into the list of cells: there is
       one console per room, and a second cell is viewed in it too, not in a
       second window. -->
  <!-- `div`, not `p`: the cells menu sits inside, and a `div` inside a
       paragraph is markup the HTML parser repairs in its own way. -->
  <div class="pult-context">
    <PultCells {cells} current={cellId} {onpick} />
    <!-- Where we are among the cells — and whether there is unreviewed work
         in the NEIGHBOURING ones. The latter is the reason to open the menu
         without meaning to switch anywhere. -->
    {#if cells.length > 1}
      <span class="pult-context-place" data-pult-cell-place
        >{tr('room.pult.v3.cells.place', { index: place, total: cells.length })}{#if others > 0}{' · '}{tr('room.pult.v3.cells.othersWaiting', { count: others })}{/if}</span>
    {/if}
    <!-- Council closed, attempts kept: nothing to change, but viewing is fine. -->
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
    A link to this console with a teacher sign-in — through the same popover
    as the lecture console's (lecture/ConsoleLink.svelte), and not a copy of
    it: the key, the refusals, "Share" and the words about once in ten
    minutes must be the same for both consoles. An icon with a caption, not a
    long button: the header's budget is 56 px.
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
   * The cell matters more than the rules — and in the header that is the
   * order of giving way.
   *
   * Until 20 Sep 2026 the context read "cell 03 · Room", and what was left
   * after the rules sentence was enough for it. Now it holds the task's
   * NAME, which people look at for the whole seminar, and it must not give
   * way: `flex:0 1 auto` instead of `flex:1`, and the free width is taken by
   * the sentence — it is also the first to shrink (it has the larger
   * `flex-shrink`), and in a narrow window it folds into its name.
   */
  .pult-context { display:flex; align-items:center; gap:8px; min-width:0; flex:0 1 auto; margin:0; color:rgb(var(--muted)); font-size:13px; line-height:18px; white-space:nowrap; overflow:hidden; }
  .pult-context-place { flex-shrink:0; }
  .pult-context-review { flex-shrink:0; padding:0 5px; border:1px solid rgb(var(--line)); color:rgb(var(--muted)); font-size:11px; line-height:16px; }
  .pult-context-room { min-width:0; overflow:hidden; text-overflow:ellipsis; }
  /*
   * The rules do not shrink AT ALL — neither as a sentence nor as a name.
   *
   * They used to shrink to 19 px at 390 px, and "Rules" crept out of its box
   * under the neighbouring button: the word ran over the "To phone" icon.
   * The context gives way to it (the task name can be cut with an
   * ellipsis), and the sentence itself disappears in steps further down.
   */
  .pult-rules { display:flex; align-items:baseline; gap:8px; flex:0 0 auto; margin-left:auto; }
  .pult-rules-label { flex-shrink:0; color:rgb(var(--faint)); font-size:11px; line-height:14px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; cursor:pointer; }
  /*
   * One line and only one: rules that moved to a second line stop being a
   * caption to the title and become a paragraph to be read.
   *
   * And it does NOT SHRINK: the sentence is read left to right once, and one
   * cut off in the middle ("by anyone, in turn · up to 30 s …") is no longer
   * a sentence but half a rule that decisions get made by. All or nothing:
   * the steps below remove first the connecting words, then the whole
   * sentence, leaving its name.
   */
  .pult-rules-line { display:flex; align-items:baseline; gap:6px; flex-shrink:0; margin:0; font-size:13px; line-height:18px; white-space:nowrap; overflow:hidden; }
  .pult-rules-lead, .pult-rules-dot { color:rgb(var(--muted)); }
  .pult-rules-dot { color:rgb(var(--faint)); }
  .pult-rules-narrow { display:none; }
  .pult-exit { flex-shrink:0; min-height:34px; padding:6px 10px; }
  /* A large window gets a little air, but not the old three lines: where
     there is enough room, it does not have to be cramped. */
  @media(min-width:1200px) and (min-height:800px) {
    .pult-header { min-height:56px; padding-block:10px; }
    h1 { font-size:20px; line-height:26px; }
    .pult-context { font-size:14px; }
  }
  /*
   * The header's steps — from top to bottom by cost.
   *
   * The header gained the task name and "cell 2 of 4 · N more cells await
   * review", and the order of giving way is now: the sentence's connecting
   * words (1500), the room name (1400 — it is also in the window title), the
   * sentence itself (1200 — its name remains, and it is also the door into
   * the sheet), the place among the cells (1000). The task name never gives
   * way: the button was made for its sake.
   */
  @media(max-width:1500px) {
    .pult-rules-lead { display:none; }
    .pult-rules-wide { display:none; }
    .pult-rules-narrow { display:inline; }
  }
  @media(max-width:1400px) { .pult-context-room { display:none; } }
  @media(max-width:1200px) {
    /* No room left: the rules keep only their name — also the door into the sheet. */
    .pult-rules-line { display:none; }
    .pult-rules-label { padding:0 1px; border-bottom:1px dashed rgb(var(--primary)/.5); color:rgb(var(--primary)); font-size:13px; line-height:18px; letter-spacing:0; text-transform:none; }
  }
  @media(max-width:1000px) { .pult-context-place { display:none; } }
  @media(max-width:650px) {
    /*
     * "Council" gives way to the task name.
     *
     * At 390 px the Russian word takes 80 px of 390 and repeats the window
     * and tab titles, and without this the task name shrank to "60 Tas…". The
     * heading does not leave the markup: a page without an h1 is a page
     * without a name for those who read it by voice.
     */
    h1 { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
    /* Exit as an icon: a "To the notebook" caption costs more here than it is worth. */
    .pult-exit-word { display:none; }
    .pult-exit { min-height:40px; min-width:40px; padding:6px 8px; font-size:16px; }
  }
</style>
