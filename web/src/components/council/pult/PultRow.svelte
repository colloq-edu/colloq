<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { CouncilAttempt } from '@shared/protocol'
  import Avatar from '@/components/ui/Avatar.svelte'
  import { attemptReview, attemptRunLine, draftLine, pultClock, type PultPresence, type RowMeaning } from '@/lib/council-pult'
  interface Props {
    attempt: CouncilAttempt; presence: PultPresence; unread: boolean; variant: number;
    names: boolean; selected: boolean; focused: boolean; meaning: RowMeaning;
    /** The window clock: it drives "Running 3 s" for whoever is running right now. */
    now: number;
    onlet: (() => void) | null; onopen: () => void
  }
  let { attempt, presence, unread, variant, names, selected, focused, meaning, now, onlet, onopen }: Props = $props()
  const review = $derived(attemptReview(attempt))
  const title = $derived(names ? attempt.name : tr('room.ui.1255',{p0:variant}))
  const draft = $derived(attempt.submittedAt === null)
  /*
   * Two lines per row, and the second is DIFFERENT for those who submitted
   * and those writing.
   *
   * For those who submitted — the grade badge and the full run line: what
   * happened, how long it ran and when (the run's hour is a request from the
   * 19 Sep 2026 class; it is used to match a run with what happened in the
   * lecture hall a minute ago).
   *
   * Those writing have no badge at all: "Draft" in every other row is ten
   * identical words in a row. Instead there is one state line, and it
   * answers the only question of the "Writing" tab: who is stuck. This spot
   * used to say "offline" — a caption repeated for half the class and saying
   * nothing; presence is now a dot on the avatar.
   */
  const execution = $derived(draft ? draftLine(attempt, now) : attemptRunLine(attempt, now))
  /*
   * The icon comes from the state itself, if it sent one: a run stopped by
   * the limit shares its tone with a failed one (red), while the clock says
   * there was no error in the code.
   *
   * Those writing have no icon at all. There the state line is the person's
   * only line, and it starts with the word that is the answer ("silent 7
   * min"); an icon before it would read as one more kind of state that does
   * not exist.
   */
  const runIcon = $derived(draft
    ? ''
    : (execution.icon ?? (execution.tone === 'danger' ? '×' : execution.tone === 'accent' ? '▶' : execution.tone === 'warning' ? '◷' : '')))
</script>
<div class="pult-row" class:selected class:focused class:asking={meaning==='asking'} class:on-screen={meaning==='screen'} data-pult-row={attempt.participantId} data-selected={selected?'yes':'no'} data-presence={presence} data-draft={draft?'yes':'no'}>
  <button type="button" class="pult-row-select" data-pult-select tabindex={selected?0:-1} aria-pressed={selected} title={title} onclick={onopen}>
    <span class="pult-unread" class:unread aria-hidden="true"></span>
    <span class="pult-face pult-avatar" data-presence={presence} aria-hidden="true">
      {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" emojiPx={18} />{:else}<span class="pult-anonymous"></span>{/if}
      <span class="pult-face-dot"></span>
    </span>
    <span class="pult-row-main">
      <span class="pult-row-name">{title}</span>
      <!-- The badge only for someone who submitted: for someone writing its
           place is taken by the state line, and "Draft" is already said by
           the muted row. -->
      {#if !draft}
        <span class="pult-row-tags">
          <span class="pult-badge" data-tone={review.tone} data-shape={review.shape}>{#if review.tone==='positive'}<span aria-hidden="true">✓</span>{:else if review.tone==='warning'}<span aria-hidden="true">↺</span>{/if}{review.label}</span>
          {#if meaning==='screen'}<span class="pult-badge" data-tone="positive" data-shape="fill">{tr('room.ui.1313')}</span>{/if}
        </span>
      {:else if meaning==='screen'}
        <span class="pult-row-tags"><span class="pult-badge" data-tone="positive" data-shape="fill">{tr('room.ui.1313')}</span></span>
      {/if}
      <span class="pult-run-state" data-tone={execution.tone} data-loud={draft && execution.tone!=='neutral' ? 'yes' : 'no'} title={execution.label}>{#if runIcon}<span aria-hidden="true">{runIcon} </span>{/if}{execution.label}</span>
    </span>
  </button>
  <div class="pult-row-tail">
    {#if onlet}
      <button type="button" class="pult-allow" aria-label={`${tr('room.ui.1296')} · ${title}`} onclick={onlet}>{tr('room.ui.1296')}</button>
    {:else}
      <time class="pult-meta" datetime={new Date(attempt.submittedAt ?? attempt.updatedAt).toISOString()}>{pultClock(attempt.submittedAt ?? attempt.updatedAt)}</time>
    {/if}
  </div>
</div>
<style>
  /*
   * 72 px per row instead of 86: in a 900×650 window two and a half of them
   * were visible, and the list stopped being a list. Three lines of text
   * (name, badge, run) fit into 72 without crowding, and a finger on a phone
   * gets its 64 — the touch target does not drop below the row's own height.
   */
  .pult-row { display:flex; align-items:center; gap:8px; min-height:70px; border-bottom:1px solid rgb(var(--line)); border-left:3px solid transparent; padding:6px 10px 6px 7px; background:rgb(var(--canvas)); }
  .pult-row:hover { background:rgb(var(--surface)); }
  .pult-row.selected { background:rgb(var(--raised)); border-left-color:rgb(var(--primary)); }
  .pult-row.asking:not(.selected) { border-left-color:rgb(var(--warning)); }
  .pult-row.on-screen:not(.selected) { border-left-color:rgb(var(--positive)); }
  .pult-row.focused { outline:2px solid rgb(var(--accent-text)); outline-offset:-2px; }
  /* A draft is muted: it is listed for completeness, but people look at submissions. */
  .pult-row[data-draft='yes'] .pult-avatar, .pult-row[data-draft='yes'] .pult-row-name { opacity:.65; }
  .pult-row-select { display:flex; align-items:center; gap:9px; min-width:0; flex:1; text-align:left; cursor:pointer; }
  .pult-unread { width:6px; height:6px; flex-shrink:0; border-radius:50%; background:transparent; }
  .pult-unread.unread { background:rgb(var(--accent)); }
  .pult-avatar { --face-dot:11px; display:block; width:30px; height:30px; flex-shrink:0; }
  .pult-anonymous { display:block; width:100%; height:100%; background:rgb(var(--line)); border-radius:50%; }
  .pult-row-main { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
  .pult-row-name { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:15px; font-weight:700; line-height:18px; }
  .pult-row-tags { display:flex; gap:4px; flex-wrap:wrap; }
  /* A row's badge is smaller than the usual one: three lines must fit in 70 px. */
  .pult-row-tags :global(.pult-badge) { padding:1px 6px; font-size:12px; line-height:16px; }
  .pult-run-state { font-size:12px; line-height:16px; color:rgb(var(--muted)); overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .pult-run-state[data-tone="danger"] { color:rgb(var(--danger)); }
  .pult-run-state[data-tone="warning"] { color:rgb(var(--warning)); }
  .pult-run-state[data-tone="accent"] { color:rgb(var(--accent-text)); }
  /* For someone writing this line is all that is said about them: an alarming
     one is set in bold, so that "silent 7 min" is caught before the
     neighbouring "writing · 14 lines". */
  .pult-run-state[data-loud="yes"] { font-weight:700; }
  .pult-row-tail { display:flex; flex-direction:column; gap:3px; align-items:flex-end; width:58px; flex-shrink:0; text-align:right; }
  .pult-allow { min-height:34px; padding:5px 8px; background:rgb(var(--warning)/.12); border:1px solid rgb(var(--warning)/.45); color:rgb(var(--warning)); font-size:13px; font-weight:600; cursor:pointer; }
  @media(max-width:800px) { .pult-row { padding-right:8px; }.pult-row-tail { width:54px; } }
  /* Phone: a row opens the full-screen work, and it is pressed with a finger. */
  @media(max-width:650px) { .pult-row { min-height:64px; }.pult-row-name { font-size:16px; line-height:20px; } }
</style>
