<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { CouncilAttempt } from '@shared/protocol'
  import Avatar from '@/components/ui/Avatar.svelte'
  import { attemptReview, attemptExecution, type PultPresence, type RowMeaning } from '@/lib/council-pult'
  import { clock } from '@/lib/history'
  interface Props {
    attempt: CouncilAttempt; presence: PultPresence; unread: boolean; inGroup: boolean; variant: number;
    names: boolean; selected: boolean; focused: boolean; meaning: RowMeaning; same: number;
    onlet: (() => void) | null; onopen: () => void
  }
  let { attempt, presence, unread, inGroup, variant, names, selected, focused, meaning, same, onlet, onopen }: Props = $props()
  const review = $derived(attemptReview(attempt))
  const execution = $derived(attemptExecution(attempt))
  const title = $derived(names ? attempt.name : tr('room.ui.1255',{p0:variant}))
  const draft = $derived(attempt.submittedAt === null)
  const runText = $derived(draft && !attempt.run && attempt.runRequest?.status !== 'pending' && presence !== 'unknown'
    ? tr(presence === 'online' ? 'room.pult.online' : 'room.pult.offline') : execution.label)
  const runIcon = $derived(execution.tone === 'danger' ? '×' : execution.tone === 'accent' ? '▶' : execution.tone === 'warning' ? '◷' : '')
</script>
<div class="pult-row" class:selected class:focused class:in-group={inGroup} class:asking={meaning==='asking'} class:on-screen={meaning==='screen'} data-pult-row={attempt.participantId} data-selected={selected?'yes':'no'} data-presence={presence}>
  <button type="button" class="pult-row-select" data-pult-select tabindex={selected?0:-1} aria-pressed={selected} title={title} onclick={onopen}>
    <span class="pult-unread" class:unread aria-hidden="true"></span>
    <span class="pult-avatar" aria-hidden="true">
      {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" emojiPx={18} />{:else}<span class="pult-anonymous"></span>{/if}
    </span>
    <span class="pult-row-main">
      <span class="pult-row-name">{title}</span>
      <span class="pult-row-tags">
        <span class="pult-badge" data-tone={review.tone}>{#if review.tone==='positive'}<span aria-hidden="true">✓</span>{:else if review.tone==='warning'}<span aria-hidden="true">↺</span>{/if}{review.label}</span>
        {#if meaning==='screen'}<span class="pult-badge" data-tone="positive">{tr('room.ui.1313')}</span>{/if}
      </span>
      <span class="pult-run-state" data-tone={execution.tone}>{#if runIcon}<span aria-hidden="true">{runIcon} </span>{/if}{runText}</span>
    </span>
  </button>
  <div class="pult-row-tail">
    {#if onlet}
      <button type="button" class="pult-allow" aria-label={`${tr('room.ui.1296')} · ${title}`} onclick={onlet}>{tr('room.ui.1296')}</button>
    {:else}
      <time class="pult-meta" datetime={new Date(attempt.submittedAt ?? attempt.updatedAt).toISOString()}>{clock(attempt.submittedAt ?? attempt.updatedAt)}</time>
    {/if}
    {#if presence==='offline' && !draft}<span class="pult-meta">{tr('room.pult.offline')}</span>{/if}
    {#if same>0 && !onlet}<span class="pult-same pult-meta" title={tr('room.ui.1314',{count:same})}>+{same}</span>{/if}
  </div>
</div>
<style>
  .pult-row { display:flex; align-items:center; gap:8px; min-height:86px; border-bottom:1px solid rgb(var(--line)); border-left:4px solid transparent; padding:10px 12px 10px 8px; background:rgb(var(--canvas)); }
  .pult-row:hover { background:rgb(var(--surface)); }
  .pult-row.selected { background:rgb(var(--raised)); border-left-color:rgb(var(--primary)); }
  .pult-row.asking:not(.selected) { border-left-color:rgb(var(--warning)); }
  .pult-row.on-screen:not(.selected) { border-left-color:rgb(var(--positive)); }
  .pult-row.focused { outline:2px solid rgb(var(--accent-text)); outline-offset:-2px; }
  .pult-row.in-group { padding-left:20px; }
  .pult-row-select { display:flex; align-items:center; gap:10px; min-width:0; flex:1; text-align:left; cursor:pointer; }
  .pult-unread { width:6px; height:6px; flex-shrink:0; border-radius:50%; background:transparent; }
  .pult-unread.unread { background:rgb(var(--accent)); }
  .pult-avatar,.pult-anonymous { display:block; width:32px; height:32px; flex-shrink:0; }
  .pult-anonymous { background:rgb(var(--line)); border-radius:50%; }
  .pult-row-main { display:flex; flex-direction:column; gap:4px; min-width:0; flex:1; }
  .pult-row-name { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:16px; font-weight:700; line-height:20px; }
  .pult-row-tags { display:flex; gap:4px; flex-wrap:wrap; }
  .pult-run-state { font-size:13px; line-height:18px; color:rgb(var(--muted)); }
  .pult-run-state[data-tone="danger"] { color:rgb(var(--danger)); }
  .pult-run-state[data-tone="warning"] { color:rgb(var(--warning)); }
  .pult-run-state[data-tone="accent"] { color:rgb(var(--accent-text)); }
  .pult-row-tail { display:flex; flex-direction:column; gap:4px; align-items:flex-end; width:64px; flex-shrink:0; text-align:right; }
  .pult-allow { min-height:34px; padding:5px 8px; background:rgb(var(--warning)/.12); border:1px solid rgb(var(--warning)/.45); color:rgb(var(--warning)); font-size:13px; font-weight:600; cursor:pointer; }
  .pult-same { padding:1px 5px; border:1px solid rgb(var(--line)); }
  @media(max-width:800px) { .pult-row { padding-right:8px; }.pult-row-tail { width:56px; }.pult-row-select { gap:6px; }.pult-row-name { font-size:15px; } }
</style>
