<script module lang="ts">
  /**
   * The left names whose "Not carried over" line the teacher hid, by room
   * and cell (council-pult.ts · poolLeftKeys): the console names them once
   * (§9.0), and a cell switch remounts it ({#key} in SessionScreen) — a
   * hidden line must not come back with it. Not by snapshot: a cell that
   * follows the kernel takes one after each of the teacher's cells, and the
   * line would come back with the same names every time. A name new since
   * the hide, or a new reason, brings it back.
   */
  const hiddenLeft = new Map<string, ReadonlySet<string>>()
  const NONE_HIDDEN: ReadonlySet<string> = new Set()
  /**
   * The rooms whose «Порядок множеств…» band the teacher hid (Z9: shown
   * once): a kernel's hash seed is its container's, and it stays for the
   * class's whole life — a band that came back with each snapshot would say
   * the same thing every few minutes.
   */
  const hiddenSeed = new Set<string>()
</script>

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
   *
   * THE POOL STRIP stands right under it (Paper 18 · Z8, Z8b, Z8c), for a
   * class whose council computes on machines and only there: the pool's
   * workers, its machine, the snapshot its attempts compute on, how that
   * changes, and "Refresh". The two rules it names ("Attempts run",
   * "State for attempts") are not pieces of the sentence above — six do
   * not fit it at any width (Z8c) — and their values here open the sheet on
   * their rows as the sentence's do. Under the strip, once, the names the
   * snapshot could not carry. Both live here because the header
   * is the console's one part that is always drawn and knows its cell: the
   * kernel frame that carries the pool is the cell's (`council:kernel`).
   */
  import { getSessionState } from '@/lib/session.svelte'
  import {
    othersWaiting,
    poolLeftKeys,
    poolLeftLine,
    poolLeftNew,
    poolStrip,
    pultClock,
    type PultCellRow,
    type PultRule,
    type RulePart,
  } from '@/lib/council-pult'
  import ConsoleLink from '@/components/lecture/ConsoleLink.svelte'
  import Icon from '@/components/ui/Icon.svelte'
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

  /* ------------------------------------------------------------ the pool */

  const session = getSessionState()
  const board = $derived(session.council.boards[cellId] ?? null)
  /** The class's pool of workers for this cell's notebook (`CouncilKernel.pool`); null — its council is not on machines. */
  const pool = $derived(session.council.kernels[cellId]?.pool ?? null)
  /** Only while the council is open: a closed one's attempts compute nowhere, and its cell keeps only the review. */
  const strip = $derived(board?.lock === 'council' ? poolStrip(pool, board.settings) : null)
  /** Offline, or a console that does not lead the class: what it reads stays, its presses go nowhere. */
  const idle = $derived(!session.connected || session.me.role !== 'host')
  const leftScope = $derived(`${session.session.id}\u0000${cellId}`)
  let hidden = $state.raw<ReadonlyMap<string, ReadonlySet<string>>>(new Map(hiddenLeft))
  /** "Not carried over: …" — once, until a name comes that the teacher has not hidden; for a cell whose attempts go to the pool at all. */
  const left = $derived(
    strip !== null && strip.kind !== 'lane' && pool?.epoch && poolLeftNew(pool.epoch.left, hidden.get(leftScope) ?? NONE_HIDDEN)
      ? poolLeftLine(pool.epoch.left)
      : null,
  )

  function hideLeft(): void {
    if (!pool?.epoch) return
    hiddenLeft.set(leftScope, new Set([...(hiddenLeft.get(leftScope) ?? []), ...poolLeftKeys(pool.epoch.left)]))
    hidden = new Map(hiddenLeft)
  }

  /**
   * «Порядок множеств в попытках может отличаться от тетради: её ядро
   * запущено до обновления.» (§13.2, b87dc7): the notebook's kernel hashes
   * strings with another seed than the workers, its container being older
   * than 0.25.0 (council-pool.ts · accept). Once a room, until the teacher
   * hides it; a restart of the notebook's container mends it for good.
   */
  let seedHidden = $state(hiddenSeed.has(session.session.id))
  const seedNote = $derived(strip !== null && strip.kind !== 'lane' && pool?.epoch?.seedDiffers === true && !seedHidden)
  function hideSeed(): void {
    hiddenSeed.add(session.session.id)
    seedHidden = true
  }

  /**
   * "Refresh": a fresh snapshot of the notebook's kernel for the attempts
   * (`council:epoch`, remote-classes.md §9.2). It goes between the teacher's
   * cells, as a service run of the notebook's queue; the strip says
   * "taking a snapshot" until it is taken, and then the new time.
   */
  function refresh(): void {
    if (idle) return
    session.send({ t: 'council:epoch', cellId })
  }
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
{#if strip}
  <!--
    The pool strip (Paper 18 · Z8b, the strip's states): one line, its
    five states. The bars are the workers — free green first, then those
    computing in the accent, grey while one comes up — and the words say the
    same numbers, so the bars hide from a screen reader. The machine is named:
    the console is the teacher's, and staff read machines by name.
  -->
  <div class="pool-strip" data-pult-pool={strip.kind} data-pult-pool-epoch={pool?.epoch?.seq ?? null} role="group" aria-label={tr('room.pult.pool.label')}>
    {#if strip.kind === 'lane'}
      <span class="pool-line">
        <span class="pool-muted">{tr('room.pult.pool.laneLead')}</span>
        <button type="button" class="pult-value" data-pult-pool-value="lane" aria-expanded={openRule === 'lane'}
          onclick={(event) => onrules('lane', event.currentTarget)}>{tr('room.pult.pool.laneValue')}</button>
        <span class="pool-dot" aria-hidden="true">·</span>
        <span class="pool-muted">{tr('room.pult.pool.laneNote')}</span>
      </span>
    {:else if strip.kind === 'stalled' || strip.kind === 'shared'}
      <!-- The pool cannot take attempts: in the server's words, with what that means for them. -->
      <span class="pool-line pool-trouble" role="status">
        <span class="pool-icon" aria-hidden="true"><Icon name="alert" size={13} /></span>
        {#if strip.kind === 'stalled'}
          {#if strip.lead}<strong class="pool-lead">{strip.lead}</strong>{/if}
          <span class="pool-why">{strip.why}</span>
          <span class="pool-dot" aria-hidden="true">·</span>
          <span class="pool-muted">{tr('room.pult.pool.inShared')}</span>
        {:else}
          <span class="pool-why">{strip.note}</span>
          {#if strip.refreezing}<span class="pool-dot" aria-hidden="true">·</span><span class="pool-muted">{tr('room.pult.pool.snapshot')}</span>{/if}
        {/if}
      </span>
      {#if strip.kind === 'shared'}
        <!-- A snapshot that did not fit or come together may after the teacher's next cell: they may ask for one. -->
        <button type="button" class="pool-refresh" data-pult-pool-refresh disabled={idle}
          title={tr('room.pult.pool.refreshTitle')} onclick={refresh}>{tr('room.pult.pool.refresh')}</button>
      {/if}
    {:else}
      <span class="pool-line">
        <span class="pool-bars" aria-hidden="true">
          {#each strip.bars as bar, at (at)}<span class="pool-bar" data-bar={bar}></span>{/each}
        </span>
        {#if strip.kind === 'ready'}
          <span class="pool-ready" class:pool-none={strip.ready === 0}>{tr('room.pult.pool.ready', { count: strip.ready })}</span>
          <span class="pool-dot" aria-hidden="true">·</span>
          <span class="pool-busy" class:pool-none={strip.busy === 0}>{tr('room.pult.pool.busy', { count: strip.busy })}</span>
          <span class="pool-dot" aria-hidden="true">·</span>
          <span class="pool-queued">{tr('room.pult.pool.queued', { count: strip.queued })}</span>
        {:else}
          <strong class="pool-lead">{tr('room.pult.pool.starting')}</strong>
          {#if strip.size > 0}
            <!-- Z8b: how far it is up, of the size it is to have. -->
            <span class="pool-dot" aria-hidden="true">·</span>
            <span class="pool-muted" data-pult-pool-up>{tr('room.pult.pool.readyOf', { count: strip.up, size: strip.size })}</span>
          {/if}
        {/if}
        {#if strip.machine}
          <span class="pool-dot" aria-hidden="true">·</span>
          <span class="pool-machine" data-pult-pool-machine>{strip.machine}</span>
        {/if}
        {#if strip.kind === 'starting'}
          <span class="pool-dot" aria-hidden="true">·</span>
          <span class="pool-muted">{tr('room.pult.pool.meanwhile')}</span>
        {/if}
      </span>
      {#if strip.kind === 'ready'}
        <!-- The snapshot the attempts compute on, and how it changes: a door into its row of the sheet. -->
        <span class="pool-line pool-state">
          <!-- One sentence with the workers on a wide strip; a line of its own on a phone. -->
          <span class="pool-dot pool-joint" aria-hidden="true">·</span>
          {#if strip.at !== null}
            <span class="pool-muted" data-pult-pool-time>{tr('room.pult.pool.state', { time: pultClock(strip.at) })}</span>
            <span class="pool-dot" aria-hidden="true">·</span>
          {/if}
          <button type="button" class="pult-value" data-pult-pool-value="refresh" aria-expanded={openRule === 'refresh'}
            onclick={(event) => onrules('refresh', event.currentTarget)}
          >{tr(strip.refresh === 'auto' ? 'room.pult.pool.refreshAuto' : 'room.pult.pool.refreshManual')}</button>
          {#if strip.refreezing}
            <span class="pool-dot" aria-hidden="true">·</span>
            <span class="pool-snapshot" role="status">{tr('room.pult.pool.snapshot')}</span>
          {/if}
          {#if strip.recycled}
            <!-- Z8: an attempt left a worker unfit, and the pool restarted it — amber, hollow, said for a minute. -->
            <span class="pool-recycled" role="status" title={tr('room.pult.pool.recycledTitle')} data-pult-pool-recycled>
              <span class="pool-recycled-dot" aria-hidden="true"></span>{tr('room.pult.pool.recycled')}
            </span>
          {/if}
          <button type="button" class="pool-refresh" data-pult-pool-refresh disabled={idle}
            title={tr('room.pult.pool.refreshTitle')} onclick={refresh}>{tr('room.pult.pool.refresh')}</button>
        </span>
      {/if}
    {/if}
  </div>
  {#if strip.kind === 'ready' && strip.note}
    <!-- The pool computes, on an older snapshot than the newest: "The new state does not fit — attempts run on the state as of 14:05." -->
    <p class="pool-note" role="status"><span class="pool-icon" aria-hidden="true"><Icon name="alert" size={13} /></span><span>{strip.note}</span></p>
  {/if}
{/if}
{#if seedNote}
  <!-- Z9: the hash seed's note, once a room (§13.2, b87dc7). -->
  <div class="pool-note pool-seed" data-pult-pool-seed role="note">
    <span class="pool-icon" aria-hidden="true"><Icon name="alert" size={13} /></span>
    <span class="pool-left-line">{tr('server.theOrderOfSetsInAttemptsMay.b87dc7')}</span>
    <button type="button" class="pool-left-hide" aria-label={tr('room.pult.pool.seedHide')} title={tr('room.pult.pool.seedHide')}
      onclick={hideSeed}><span aria-hidden="true">×</span></button>
  </div>
{/if}
{#if left && pool?.epoch}
  <!--
    What the snapshot could not carry (§9.4, Z8): once, until the teacher
    hides it, and again only with a name they have not hidden. An attempt
    that reads one of these names computes in the shared kernel, and its
    card says which.
  -->
  <div class="pool-note pool-left" data-pult-pool-left role="note" title={poolLeftLine(pool.epoch.left, true) ?? undefined}>
    <span class="pool-icon" aria-hidden="true"><Icon name="alert" size={13} /></span>
    <span class="pool-left-line">{left}</span>
    <span class="pool-left-note">{tr('room.pult.pool.leftNote')}</span>
    <button type="button" class="pool-left-hide" aria-label={tr('room.pult.pool.leftHide')} title={tr('room.pult.pool.leftHide')}
      onclick={hideLeft}><span aria-hidden="true">×</span></button>
  </div>
{/if}
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

  /*
   * The pool strip (Paper 18 · Z8b): one line of 36 px under the header, the
   * sizes of the mockup. Its two halves — the workers, then the snapshot and
   * Refresh — wrap as wholes when a narrow window has no room for both,
   * and on a phone stand as two lines with Refresh a button of a finger's
   * size (Z10).
   */
  .pool-strip { display:flex; align-items:center; flex-wrap:wrap; gap:2px 8px; flex-shrink:0; min-height:36px; padding:4px var(--pult-pad); border-bottom:1px solid rgb(var(--line)); background:rgb(var(--canvas)); font-size:13px; line-height:18px; }
  .pool-line { display:flex; align-items:center; flex-wrap:wrap; gap:2px 8px; min-width:0; }
  .pool-state { flex:1 1 auto; }
  .pool-bars { display:flex; flex-wrap:wrap; gap:2px; max-width:100%; }
  .pool-bar { width:4px; height:12px; flex-shrink:0; background:rgb(var(--line)); }
  .pool-bar[data-bar='ready'] { background:rgb(var(--positive)); }
  .pool-bar[data-bar='busy'] { background:rgb(var(--accent)); }
  .pool-ready { color:rgb(var(--positive)); font-weight:700; }
  .pool-busy { color:rgb(var(--accent-text)); font-weight:700; }
  /* A count of none reads quiet (Z8's "0 ready"): the colour is for what there is. */
  .pool-ready.pool-none, .pool-busy.pool-none { color:rgb(var(--muted)); }
  .pool-queued, .pool-lead { color:rgb(var(--ink)); font-weight:700; }
  .pool-machine { color:rgb(var(--muted)); font-family:var(--font-mono); font-size:12px; }
  .pool-muted { color:rgb(var(--muted)); }
  .pool-dot { color:rgb(var(--faint)); }
  .pool-snapshot { color:rgb(var(--accent-text)); }
  /* Z8: the outlined chip, warning, its dot hollow. */
  .pool-recycled { display:inline-flex; align-items:center; gap:6px; min-height:22px; padding:0 8px; border:1px solid rgb(var(--warning) / .6); color:rgb(var(--warning)); font-size:12px; line-height:16px; white-space:nowrap; }
  .pool-recycled-dot { width:7px; height:7px; flex-shrink:0; border:1.5px solid currentColor; border-radius:50%; }
  /* Refresh reads as the sentence's values do — a word you press — and stands at the strip's end. */
  .pool-refresh { flex-shrink:0; margin-left:auto; padding:0 1px; border-bottom:1px dashed rgb(var(--primary) / .5); color:rgb(var(--primary)); font-weight:700; white-space:nowrap; cursor:pointer; }
  .pool-refresh:hover:not(:disabled) { background:rgb(var(--raised)); }
  .pool-refresh:disabled { opacity:.48; cursor:default; }
  .pool-trouble { flex:1 1 auto; }
  .pool-trouble .pool-lead { color:rgb(var(--warning)); }
  .pool-why { min-width:0; color:rgb(var(--ink)); }
  .pool-icon { display:inline-flex; flex-shrink:0; color:rgb(var(--warning)); }
  [data-pult-pool='stalled'], [data-pult-pool='shared'] { background:rgb(var(--warning) / .07); box-shadow:inset 3px 0 0 rgb(var(--warning)); }
  /* Under the strip: what the snapshot could not carry, and a note about the pool's newest snapshot. */
  .pool-note { display:flex; align-items:center; gap:10px; flex-shrink:0; min-height:32px; margin:0; padding:4px var(--pult-pad); border-bottom:1px solid rgb(var(--line)); background:rgb(var(--warning) / .07); color:rgb(var(--ink)); font-size:13px; line-height:18px; }
  .pool-left-line { flex:1; min-width:0; }
  .pool-left-note { flex-shrink:0; color:rgb(var(--muted)); font-size:12px; line-height:16px; }
  .pool-left-hide { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; width:24px; height:24px; color:rgb(var(--faint)); font-size:15px; line-height:1; cursor:pointer; }
  .pool-left-hide:hover { color:rgb(var(--ink)); background:rgb(var(--raised)); }
  @media(max-width:650px) {
    .pool-strip { flex-direction:column; align-items:stretch; gap:4px; padding-block:8px; font-size:14px; line-height:20px; }
    .pool-machine { font-size:13px; }
    .pool-state { min-height:36px; }
    .pool-joint { display:none; }
    .pool-refresh { display:inline-flex; align-items:center; min-height:36px; padding:0 12px; border:1px solid rgb(var(--line)); }
    .pool-note { align-items:flex-start; padding-block:10px; }
    .pool-left-note { display:none; }
    .pool-left-hide { width:32px; height:32px; margin:-6px -6px -6px 0; }
  }
</style>
