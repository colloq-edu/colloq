<script lang="ts">
  import { tr } from '@shared/i18n'
  import ActivityHistory from './ActivityHistory.svelte'
  /**
   * What the room did to its notebook, and how to put any of it back.
   *
   * Two columns, because the two questions are asked together: the timeline on
   * the left says who changed something and when, the panel on the right says
   * what they changed. Clicking a row never leaves the notebook — the drawer is
   * over it, and the sheet above stays where the reader left it.
   *
   * The list is re-read in full — on opening and then on every lull in the
   * document (the effect below): a version is written on the server after a
   * pause, and a feed read only once would show an edit from half an hour ago
   * as the latest. A version's content is loaded on click and stays in memory,
   * so going back to a row that was already opened is free. That is enough: a
   * seminar's history is dozens of rows, not thousands.
   */
  import { BURST_IDLE_MS, type Version } from '@shared/history'
  import { CELLS_KEY } from '@shared/notebook'
  import { baseOf } from '@shared/paths'
  import Icon from '@/components/ui/Icon.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { watchBooks } from '@/lib/yreactive.svelte'
  import {
    clock,
    initialsOf,
    listVersions,
    readVersion,
    restoreVersion,
    setCheckpoint,
    type VersionDetail,
  } from '@/lib/history'

  const session = getSessionState()
  const isHost = $derived(session.me.role === 'host')
  let view = $state<'activity' | 'versions'>('activity')
  const showActivity = $derived(isHost && view === 'activity')

  /**
   * The history is about one notebook, and the panel has to say which.
   *
   * `collab/history` reads, describes and restores exactly the `cells` root —
   * it says there that this is pinned on purpose. A room can have several
   * notebooks, and a button without a name edits a different sheet from the one
   * the person sees on screen. The notebook with the `cells` root may no longer
   * exist (it was removed) — then restoring will create it anew, and there is
   * nothing to name it by in advance.
   */
  const books = watchBooks(session.doc)
  const versioned = $derived(books.current.find((book) => book.root === CELLS_KEY) ?? null)
  const versionedName = $derived(versioned ? baseOf(versioned.path) : tr('room.ui.651'))
  const otherBooks = $derived(books.current.length - (versioned ? 1 : 0))

  let versions = $state<Version[]>([])
  /**
   * The start of the feed was not kept: the room outgrew the ceiling on history
   * size.
   *
   * Computed by the server (db.ts · `historyTrimmed`) and delivered together
   * with the rows — the rows themselves do not show it, they look like the full
   * history of a short class. Not to be confused with the feed window:
   * `MAX_VERSIONS` does not return everything either, but those versions are in
   * the database, and they have to be talked about in different words.
   */
  let trimmed = $state(false)
  let loading = $state(true)
  let errorRender = $state<() => string | null>(() => null)
  const error = $derived(errorRender())
  let openSeq = $state<number | null>(null)
  let detail = $state<VersionDetail | null>(null)
  let busy = $state(false)
  let naming = $state(false)
  let label = $state('')

  /** Versions already fetched. A second visit to a row is free. */
  const seen = new Map<number, VersionDetail>()

  async function load(): Promise<void> {
    loading = true
    errorRender = () => (null)
    try {
      const body = await listVersions(session.session.id, session.token)
      versions = body.versions
      trimmed = body.trimmed
      /*
       * Only auto-open when nothing is open. A refresh arriving while somebody
       * is reading an old version must not yank them to the newest row — the
       * list moves under them constantly during a live seminar, and that is the
       * one moment they are looking at something on purpose.
       */
      if (openSeq === null && versions.length > 0) void open(versions[0].seq)
    } catch (cause) {
      errorRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.652'))
    } finally {
      loading = false
    }
  }

  async function open(seq: number): Promise<void> {
    openSeq = seq
    /*
     * The error belongs to the attempt, not to the panel.
     *
     * The right column draws the error instead of the content, and it was reset
     * only in `load()` — that is, by an edit in the document. In a quiet room
     * (a lecture, nobody typing) one network blip closed the diffs of all
     * following versions until the end of class.
     */
    errorRender = () => (null)
    const cached = seen.get(seq)
    if (cached) {
      detail = cached
      return
    }
    detail = null
    try {
      const body = await readVersion(session.session.id, seq, session.token)
      seen.set(seq, body)
      // The reader may have clicked on down the list while this was in flight.
      if (openSeq === seq) detail = body
    } catch (cause) {
      errorRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.653'))
    }
  }

  async function restore(cellId?: string): Promise<void> {
    if (openSeq === null || busy) return
    busy = true
    try {
      await restoreVersion(session.session.id, openSeq, session.token, cellId)
      // The restore is itself a version, so the list is now one longer.
      seen.clear()
      openSeq = null
      await load()
    } catch (cause) {
      errorRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.654'))
    } finally {
      busy = false
    }
  }

  async function checkpoint(): Promise<void> {
    const name = label.trim()
    if (!name || busy) return
    busy = true
    try {
      await setCheckpoint(session.session.id, name, session.token)
      label = ''
      naming = false
      seen.clear()
      await load()
    } catch (cause) {
      errorRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.655'))
    } finally {
      busy = false
    }
  }

  /*
   * The panel follows the room instead of being a snapshot of the moment it
   * opened. Somebody deletes a cell, and the row for it appears here without
   * anybody closing and reopening the drawer.
   *
   * Driven by the document rather than by a clock: a room where nothing is
   * happening asks the server nothing at all, and a room where a lot is
   * happening asks once per lull rather than once per keystroke. The wait is
   * deliberate and generous — the server groups a burst of typing into one
   * version, so refreshing faster would only redraw the same list.
   */
  const SETTLE_MS = 1200

  /**
   * And once more — when the server closes the burst.
   *
   * The quick refresh catches everything that has already been written, and in
   * a quiet room it catches nothing: the server collects what was typed into
   * one version and writes it after BURST_IDLE_MS of silence. A person typed,
   * the panel refreshed a second later and found nothing, there were no more
   * refreshes — and the edit's row never appeared, although it had been in the
   * database since the twelfth second. Half a second on top is for the trip and
   * the write.
   */
  const BURST_SETTLED_MS = BURST_IDLE_MS + 500

  $effect(() => {
    if (showActivity) return
    void load()

    let soon: ReturnType<typeof setTimeout> | null = null
    let settled: ReturnType<typeof setTimeout> | null = null
    const onChange = () => {
      if (soon) clearTimeout(soon)
      if (settled) clearTimeout(settled)
      soon = setTimeout(() => {
        soon = null
        void load()
      }, SETTLE_MS)
      settled = setTimeout(() => {
        settled = null
        void load()
      }, BURST_SETTLED_MS)
    }
    session.doc.on('update', onChange)
    return () => {
      if (soon) clearTimeout(soon)
      if (settled) clearTimeout(settled)
      session.doc.off('update', onChange)
    }
  })

  /**
   * The row's own words: a checkpoint says its name, everything else its summary.
   *
   * The time of a restored version is added by the browser, not the server: the
   * server sends an address (`targetSeq`), because it has its own clock — UTC
   * in the container — and a "restored the version from 15:04" assembled there
   * would point, in a UTC+3 classroom, to a row that is not in the list. Here
   * it is taken from the same row, by the same clock that draws the whole feed.
   * The row may be missing: the list is trimmed or the version arrived
   * earlier — then the caption stays as it is.
   *
   * "from 15:04", not "since 15:04": a version is a dated thing, like a letter,
   * and "since" reads as the start of a span it does not have.
   */
  function saying(v: Version): string {
    if (v.kind === 'checkpoint') return v.label ?? tr('room.ui.631')
    if (v.kind === 'restore' && v.targetSeq !== null) {
      const target = versions.find((row) => row.seq === v.targetSeq)
      if (target) return tr('room.ui.656', { p0: v.summary, p1: clock(target.createdAt) })
    }
    return v.summary
  }
</script>

<div class="history-panel">
  {#if isHost}
    <nav class="history-views" aria-label={tr('activity.views')}>
      <button type="button" aria-pressed={showActivity} class:on={showActivity} onclick={() => (view = 'activity')}>{tr('activity.title')}</button>
      <button type="button" aria-pressed={!showActivity} class:on={!showActivity} onclick={() => (view = 'versions')}>{tr('activity.versions')}</button>
    </nav>
  {/if}
  {#if showActivity}
    <ActivityHistory />
  {:else}
<div class="hist">
  <div class="hist-list">
    <!-- The feed is not about the whole room but about one notebook. That has
         to be said before the first click: in a room with two notebooks
         "nothing was recorded" reads as lost edits, not as the limits of the
         history. -->
    {#if otherBooks > 0}
      <p class="hist-note hist-note--aside"> {tr('room.ui.624')} {versionedName}{tr('room.ui.625')} {otherBooks === 1
          ? tr('room.ui.626')
          : tr('room.ui.627')} {tr('room.ui.628')} </p>
    {/if}
    {#if loading && versions.length === 0}
      <p class="hist-note">{tr('room.ui.629')}</p>
    {:else if versions.length === 0}
      <p class="hist-note">{tr('room.ui.630')}</p>
    {:else}
      {#each versions as v (v.seq)}
        <button
          type="button"
          aria-pressed={openSeq === v.seq}
          class="hist-row"
          class:on={openSeq === v.seq}
          class:mark={v.kind === 'checkpoint'}
          onclick={() => open(v.seq)}
        >
          <span class="hist-time">{clock(v.createdAt)}</span>
          <span class="hist-rail">
            <i class="hist-dot" class:accent={v.kind === 'restore'} class:keep={v.kind === 'checkpoint'}
            ></i>
          </span>
          {#if v.authorName}
            <span class="hist-face" style="background: {v.authorColor ?? '#5d6b8a'}">
              {initialsOf(v.authorName)}
            </span>
          {:else}
            <span class="hist-face hist-face--none" aria-hidden="true"></span>
          {/if}
          <span class="hist-what">
            <b>{v.kind === 'checkpoint' ? (v.label ?? tr('room.ui.631')) : (v.authorName ?? tr('room.ui.632'))}</b>
            <em>{v.kind === 'checkpoint' ? tr('room.ui.633', { p0: v.authorName ?? tr('room.extra.284') }) : saying(v)}</em>
          </span>
          <span class="hist-count">
            {#if v.added > 0}<i class="plus">+{v.added}</i>{/if}
            {#if v.removed > 0}<i class="minus">−{v.removed}</i>{/if}
          </span>
        </button>
      {/each}
      <!-- The end of the feed is not necessarily the start of the room. The
           line stands last because the list goes from newest to oldest: the
           boundary of what was kept runs right under the earliest surviving
           edit. -->
      {#if trimmed}
        <p class="hist-note hist-note--aside hist-note--tail"> {tr('room.ui.634')} </p>
      {/if}
    {/if}
  </div>

  <div class="hist-change">
    {#if error}
      <p class="hist-note hist-note--bad" role="alert">{error}</p>
    {:else if openSeq === null}
      <p class="hist-note">{tr('room.ui.635')}</p>
    {:else if !detail}
      <p class="hist-note">{tr('room.ui.636')}</p>
    {:else if detail.diffs.length === 0}
      <!--
        A checkpoint and "opened" edit nothing: their list of affected cells is
        empty by construction, and one sentence instead of the content was
        enough only until the first "restore" — the restore button was pressed
        blindly. The server sends this version's notebook in full anyway, on
        every click.
      -->
      <div class="hist-diffs">
        <p class="hist-note">
          {detail.version.kind === 'opened'
            ? tr('room.ui.637')
            : tr('room.ui.638')}
        </p>
        {#each detail.cells as c, at (c.id)}
          <div class="hist-diff">
            <div class="hist-diff-head">
              <b>{c.type === 'markdown' ? tr('room.ui.639') : tr('room.ui.549')} {at + 1}</b>
            </div>
            <pre class="hist-lines hist-source">{c.source}</pre>
          </div>
        {/each}
      </div>
    {:else}
      <div class="hist-diffs">
        {#each detail.diffs as d (d.cellId)}
          <div class="hist-diff">
            <div class="hist-diff-head">
              <b>{d.before === null ? tr('room.ui.640') : d.after === null ? tr('room.ui.641') : tr('room.ui.642')}</b>
              {#if isHost && d.after !== null}
                <button
                  type="button"
                  class="hist-mini"
                  disabled={busy}
                  onclick={() => restore(d.cellId)}
                > {tr('room.ui.643')} </button>
              {/if}
            </div>
            <pre class="hist-lines">{#each d.lines as line}<span
                  class="hist-line"
                  class:add={line.kind === 'added'}
                  class:del={line.kind === 'removed'}
                ><i>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</i>{line.text}
</span>{/each}</pre>
          </div>
        {/each}
      </div>
    {/if}

    <div class="hist-actions">
      <p id="history-versioned-notebook" class="hist-target" title={versionedName}>{tr('activity.notebook')}: <strong>{versionedName}</strong></p>
      <div class="hist-buttons">
      {#if naming}
        <input
          class="hist-name"
          bind:value={label}
          aria-label={tr('activity.checkpointName')}
          placeholder={tr('room.ui.644')}
          maxlength="80"
          onkeydown={(e) => {
            if (e.key === 'Enter') void checkpoint()
            // Escape closes the field — and only the field: the same key on the
            // window closes the whole drawer unless someone says it is already
            // busy, and the drawer takes the open version and the place in the
            // list away with it.
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              naming = false
            }
          }}
        />
        <button type="button" class="hist-go" disabled={busy || !label.trim()} onclick={checkpoint}> {tr('room.ui.645')} </button>
      {:else}
        {#if isHost && openSeq !== null && detail}
          <button
            type="button"
            class="hist-go"
            disabled={busy}
            title={tr('room.ui.646')}
            aria-describedby="history-versioned-notebook"
            onclick={() => restore()}
          >
            <Icon name="restart" size={14} /> {tr('activity.restoreWhole')} </button>
        {/if}
        {#if isHost}
          <button type="button" class="hist-mini" onclick={() => (naming = true)}> {tr('room.ui.648')} </button>
        {/if}
      {/if}
      </div>
      <span class="hist-foot">
        {#if isHost}{tr('room.ui.649')}{:else}{tr('room.ui.650')}{/if}
      </span>
    </div>
  </div>
</div>
  {/if}
</div>

<style>
  .history-panel { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
  .history-views { display: flex; flex: none; gap: 4px; padding: 7px 14px; border-bottom: 1px solid var(--tm-edge); }
  .history-views button { min-height: 32px; padding: 5px 12px; border: 1px solid transparent; background: transparent; color: var(--tm-muted); font: inherit; font-size: 13px; cursor: pointer; }
  .history-views button.on { border-color: var(--tm-edge); background: #0e1a3d; color: var(--tm-accent); }
  .history-views button:focus-visible { outline: 2px solid var(--tm-accent); outline-offset: 2px; }

  /*
   * The drawer palette is ONE, and it is taken from here as variables, not as a
   * second copy of the same numbers. The copy had managed to drift: the History
   * tab's underline was on #2eb4e8 while the selected row under it was on
   * #4fc3f0, and the quietest of all was #5f6e92 — exactly the shade that the
   * terminal once had raised because it did not pass AA. `--tm-*` are declared
   * on `.term`, and the history lives inside it, so the variables arrive by
   * inheritance.
   *
   * The two row backgrounds (hover and selected) have no variables of their
   * own: they are the only thing that stays local here, and they are mixed from
   * --tm-bg.
   */
  .hist {
    --hist-hover: #0c1631;
    --hist-on: #0e1a3d;
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    color: var(--tm-muted);
  }

  .hist-list {
    display: flex;
    flex-direction: column;
    width: 318px;
    flex: none;
    overflow-y: auto;
    border-right: 1px solid var(--tm-edge);
    padding-block: 8px;
  }

  .hist-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 14px;
    background: none;
    border: 0;
    /* Transparent rather than absent: the marker on the selected row must not
       shift the four lanes beside it by two pixels. */
    border-left: 2px solid transparent;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .hist-row:hover {
    background: var(--hist-hover);
  }

  .hist-row.on {
    background: var(--hist-on);
    border-left-color: var(--tm-accent);
  }

  .hist-row:focus-visible {
    outline: 2px solid var(--tm-accent);
    outline-offset: -2px;
  }

  .hist-time {
    width: 32px;
    flex: none;
    /* The same monospace as the transcript above it: `--font-mono` is not
       declared anywhere in the project, and the history's time slid into the
       system SF Mono next to the terminal's JetBrains Mono. The time stays at
       the compact step, but is no longer smaller than readable meta text. */
    font-family: var(--tm-mono);
    font-size: 12px;
    color: var(--tm-muted);
  }

  .hist-rail {
    width: 8px;
    flex: none;
    display: flex;
    justify-content: center;
  }

  .hist-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--tm-edge);
  }

  .hist-dot.accent {
    background: var(--tm-accent);
  }

  .hist-dot.keep {
    background: var(--tm-live);
  }

  .hist-face {
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    font-weight: 800;
    color: #fff;
  }

  .hist-face--none {
    background: var(--tm-edge);
  }

  .hist-what {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 auto;
    min-width: 0;
  }

  .hist-what b {
    font-size: 13px;
    font-weight: 600;
    color: var(--tm-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hist-what em {
    font-size: 13px;
    font-style: normal;
    color: var(--tm-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hist-count {
    display: flex;
    gap: 6px;
    flex: none;
    font-family: var(--tm-mono);
    font-size: 13px;
  }

  .hist-count .plus {
    color: var(--tm-live);
    font-style: normal;
  }

  .hist-count .minus {
    /* The pink of removal: the drawer has no variable of its own for it — it is
       needed only here and in two diff rows below. */
    color: #e8899a;
    font-style: normal;
  }

  .hist-change {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  .hist-diffs {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 0;
  }

  .hist-diff-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px 6px;
    font-size: 13px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--tm-muted);
  }

  .hist-diff-head b {
    font-weight: 700;
    color: var(--tm-muted);
  }

  .hist-lines {
    margin: 0 0 12px;
    font-family: var(--tm-mono);
    font-size: 13px;
    line-height: 19px;
    white-space: pre;
    overflow-x: auto;
  }

  /* The content of a version without edits: the same ladder as the diff, but
     without the column for plus and minus — there is nothing to change here. */
  .hist-source {
    padding-left: 26px;
    color: var(--tm-muted);
  }

  .hist-line {
    display: block;
    color: var(--tm-muted);
  }

  .hist-line i {
    display: inline-block;
    width: 26px;
    text-align: center;
    font-style: normal;
  }

  .hist-line.add {
    background: #0e2a22;
    color: #9fe8cf;
  }

  .hist-line.del {
    background: #2a1119;
    color: #e8a3b1;
  }

  .hist-actions {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    flex: none;
    margin-top: auto;
    padding: 10px 14px;
    border-top: 1px solid var(--tm-edge);
  }

  .hist-target { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--tm-muted); }
  .hist-target strong { font-weight: 500; color: var(--tm-ink); }
  .hist-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .hist-buttons .hist-go, .hist-buttons .hist-mini { box-sizing: border-box; height: 36px; flex: 0 0 auto; justify-content: center; white-space: nowrap; letter-spacing: 0.06em; }
  .hist-buttons .hist-name { box-sizing: border-box; height: 36px; min-width: 100px; }

  .hist-go,
  .hist-mini {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 12px;
    font: inherit;
    /* These are the two buttons that restore the notebook for the whole room,
       so they sit on the ordinary step of control text. */
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    cursor: pointer;
    /* Bound to the finger, not to a state, so it cannot arrive late. */
    transition:
      background-color var(--speed-quick, 0.1s) ease,
      transform var(--speed-press, 0.12s) var(--ease-out, ease-out);
  }

  .hist-go {
    /* The same blue as the tab underline: --tm-accent on dark reads as "here",
       and a second shade of it next to it read as a different element. The text
       is the drawer's background itself, the darkest it has. */
    background: var(--tm-accent);
    color: var(--tm-bg);
    border: 0;
  }

  .hist-mini {
    background: none;
    color: var(--tm-muted);
    border: 1px solid var(--tm-edge);
  }

  .hist-go:active,
  .hist-mini:active {
    transform: scale(0.97);
  }

  .hist-go:disabled,
  .hist-mini:disabled {
    opacity: 0.4;
    cursor: default;
    transform: none;
  }

  .hist-go:focus-visible,
  .hist-mini:focus-visible,
  .hist-name:focus-visible {
    outline: 2px solid var(--tm-accent);
    outline-offset: 2px;
  }

  .hist-name {
    height: 26px;
    flex: 1 1 auto;
    max-width: 260px;
    padding: 0 10px;
    font: inherit;
    font-size: 13px;
    color: var(--tm-ink);
    background: var(--hist-hover);
    border: 1px solid var(--tm-edge);
  }

  .hist-foot {
    font-size: 13px;
    color: var(--tm-muted);
  }

  .hist-note {
    margin: 0;
    padding: 14px;
    font-size: 14px;
    color: var(--tm-muted);
  }

  .hist-note--bad {
    color: #e8a3b1;
  }

  /* The limits of the history, not an event in it: quieter than the rows and
     separated from them. */
  .hist-note--aside {
    padding: 10px 14px;
    font-size: 13px;
    line-height: 1.45;
    border-bottom: 1px solid var(--tm-edge);
  }

  /* The same caveat, but at the bottom: the line separates it from the last
     row, not from the emptiness below it. */
  .hist-note--tail {
    border-bottom: 0;
    border-top: 1px solid var(--tm-edge);
  }

  /*
   * On a phone there is no room for two columns: 318px of timeline would leave
   * the diff about eighty, which is not a diff. The list keeps the width it
   * needs and the change goes underneath it, so both are readable one at a time
   * — which is how a narrow screen is read anyway.
   */
  @media (max-width: 720px) {
    .hist {
      flex-direction: column;
      overflow-y: auto;
    }

    .hist-change {
      flex: 1 0 200px;
    }

    .hist-list {
      width: 100%;
      flex: 0 0 auto;
      max-height: 140px;
      border-right: 0;
      border-bottom: 1px solid var(--tm-edge);
    }

    .hist-foot {
      display: none;
    }
  }

  /*
   * There is deliberately no `prefers-reduced-motion` block here.
   *
   * It removed transform from the transition list and kept the scale(0.97)
   * itself: a press snapped there and back without a transition — a jerk
   * instead of motion, which is exactly what that rule protects against. The
   * product's rule (index.css) explicitly keeps the press its 120 ms and 3%: it
   * does not travel anywhere, and it is the only proof that the press was
   * heard.
   */
</style>
