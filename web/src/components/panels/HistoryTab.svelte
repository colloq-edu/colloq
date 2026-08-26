<script lang="ts">
  /**
   * What the room did to its notebook, and how to put any of it back.
   *
   * Two columns, because the two questions are asked together: the timeline on
   * the left says who changed something and when, the panel on the right says
   * what they changed. Clicking a row never leaves the notebook — the drawer is
   * over it, and the sheet above stays where the reader left it.
   *
   * The list is loaded whole and once; a version's content is loaded when it is
   * opened and kept, so walking back over rows already visited costs nothing.
   * That is the whole performance story here, and it is enough: a seminar's
   * history is dozens of rows, not thousands.
   */
  import type { Version } from '@shared/history'
  import Icon from '@/components/ui/Icon.svelte'
  import { getSessionState } from '@/lib/session.svelte'
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

  let versions = $state<Version[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let openSeq = $state<number | null>(null)
  let detail = $state<VersionDetail | null>(null)
  let busy = $state(false)
  let naming = $state(false)
  let label = $state('')

  /** Versions already fetched. A second visit to a row is free. */
  const seen = new Map<number, VersionDetail>()

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const body = await listVersions(session.session.id, session.token)
      versions = body.versions
      if (openSeq === null && versions.length > 0) void open(versions[0].seq)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not read the history'
    } finally {
      loading = false
    }
  }

  async function open(seq: number): Promise<void> {
    openSeq = seq
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
      error = cause instanceof Error ? cause.message : 'Could not read that version'
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
      error = cause instanceof Error ? cause.message : 'Could not restore'
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
      error = cause instanceof Error ? cause.message : 'Could not set a checkpoint'
    } finally {
      busy = false
    }
  }

  $effect(() => {
    void load()
  })

  /** The row's own words: a checkpoint says its name, everything else its summary. */
  function saying(v: Version): string {
    return v.kind === 'checkpoint' ? (v.label ?? 'checkpoint') : v.summary
  }
</script>

<div class="hist">
  <div class="hist-list" role="list">
    {#if loading && versions.length === 0}
      <p class="hist-note">Reading the history…</p>
    {:else if versions.length === 0}
      <p class="hist-note">Nothing has been written in this room yet.</p>
    {:else}
      {#each versions as v (v.seq)}
        <button
          type="button"
          role="listitem"
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
            <b>{v.kind === 'checkpoint' ? (v.label ?? 'checkpoint') : (v.authorName ?? 'the room')}</b>
            <em>{v.kind === 'checkpoint' ? `checkpoint by ${v.authorName ?? 'the room'}` : saying(v)}</em>
          </span>
          <span class="hist-count">
            {#if v.added > 0}<i class="plus">+{v.added}</i>{/if}
            {#if v.removed > 0}<i class="minus">−{v.removed}</i>{/if}
          </span>
        </button>
      {/each}
    {/if}
  </div>

  <div class="hist-change">
    {#if error}
      <p class="hist-note hist-note--bad" role="alert">{error}</p>
    {:else if openSeq === null}
      <p class="hist-note">Pick a moment on the left.</p>
    {:else if !detail}
      <p class="hist-note">Rebuilding that version…</p>
    {:else if detail.diffs.length === 0}
      <p class="hist-note">
        {detail.version.kind === 'opened'
          ? 'The notebook the room opened with.'
          : 'This moment was marked, not edited — the notebook is as it was just before it.'}
      </p>
    {:else}
      <div class="hist-diffs">
        {#each detail.diffs as d (d.cellId)}
          <div class="hist-diff">
            <div class="hist-diff-head">
              <b>{d.before === null ? 'new cell' : d.after === null ? 'deleted cell' : 'cell'}</b>
              {#if isHost && d.after !== null}
                <button
                  type="button"
                  class="hist-mini"
                  disabled={busy}
                  onclick={() => restore(d.cellId)}
                >
                  Restore this cell
                </button>
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
      {#if naming}
        <input
          class="hist-name"
          bind:value={label}
          placeholder="before the exercise"
          maxlength="80"
          onkeydown={(e) => {
            if (e.key === 'Enter') void checkpoint()
            if (e.key === 'Escape') naming = false
          }}
        />
        <button type="button" class="hist-go" disabled={busy || !label.trim()} onclick={checkpoint}>
          Mark it
        </button>
      {:else}
        {#if isHost && openSeq !== null && detail}
          <button type="button" class="hist-go" disabled={busy} onclick={() => restore()}>
            <Icon name="restart" size={12} />
            Restore the whole notebook
          </button>
        {/if}
        {#if isHost}
          <button type="button" class="hist-mini" onclick={() => (naming = true)}>
            Checkpoint
          </button>
        {/if}
      {/if}
      <span class="hist-foot">
        {#if isHost}a restore is itself an edit{:else}only the host can restore{/if}
      </span>
    </div>
  </div>
</div>

<style>
  /*
   * The drawer paints from its own palette rather than the page tokens — see
   * the note in TerminalDrawer — so these follow the same local values.
   */
  .hist {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    color: #9aa8c9;
  }

  .hist-list {
    display: flex;
    flex-direction: column;
    width: 318px;
    flex: none;
    overflow-y: auto;
    border-right: 1px solid #1b2a52;
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
    background: #0c1631;
  }

  .hist-row.on {
    background: #0e1a3d;
    border-left-color: #4fc3f0;
  }

  .hist-row:focus-visible {
    outline: 2px solid #4fc3f0;
    outline-offset: -2px;
  }

  .hist-time {
    width: 32px;
    flex: none;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    color: #7c8aae;
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
    background: #2a3c6b;
  }

  .hist-dot.accent {
    background: #4fc3f0;
  }

  .hist-dot.keep {
    background: #3ec9a7;
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
    background: #1b2a52;
  }

  .hist-what {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 auto;
    min-width: 0;
  }

  .hist-what b {
    font-size: 11px;
    font-weight: 600;
    color: #e6e7e8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hist-what em {
    font-size: 11px;
    font-style: normal;
    color: #7c8aae;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hist-count {
    display: flex;
    gap: 6px;
    flex: none;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
  }

  .hist-count .plus {
    color: #3ec9a7;
    font-style: normal;
  }

  .hist-count .minus {
    color: #e8899a;
    font-style: normal;
  }

  .hist-change {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
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
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #5f6e92;
  }

  .hist-diff-head b {
    font-weight: 700;
    color: #9aa8c9;
  }

  .hist-lines {
    margin: 0 0 12px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 13px;
    line-height: 19px;
    white-space: pre;
    overflow-x: auto;
  }

  .hist-line {
    display: block;
    color: #5f6e92;
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
    align-items: center;
    gap: 10px;
    flex: none;
    height: 44px;
    padding: 0 14px;
    border-top: 1px solid #1b2a52;
  }

  .hist-go,
  .hist-mini {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 12px;
    font: inherit;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    cursor: pointer;
    /* Bound to the finger, not to a state, so it cannot arrive late. */
    transition:
      background-color 120ms var(--ease-out, ease-out),
      transform 120ms var(--ease-out, ease-out);
  }

  .hist-go {
    background: #0fa0d7;
    color: #06233a;
    border: 0;
  }

  .hist-mini {
    background: none;
    color: #9aa8c9;
    border: 1px solid #24365f;
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
    outline: 2px solid #4fc3f0;
    outline-offset: 2px;
  }

  .hist-name {
    height: 26px;
    flex: 1 1 auto;
    max-width: 260px;
    padding: 0 10px;
    font: inherit;
    font-size: 12px;
    color: #e6e7e8;
    background: #0c1631;
    border: 1px solid #24365f;
  }

  .hist-foot {
    margin-left: auto;
    font-size: 11px;
    color: #5f6e92;
  }

  .hist-note {
    margin: 0;
    padding: 14px;
    font-size: 12px;
    color: #5f6e92;
  }

  .hist-note--bad {
    color: #e8a3b1;
  }

  @media (prefers-reduced-motion: reduce) {
    .hist-go,
    .hist-mini {
      transition-property: background-color;
    }
  }
</style>
