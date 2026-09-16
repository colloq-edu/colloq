<script lang="ts">
  import { tr } from '@shared/i18n'
  import Avatar from '@/components/ui/Avatar.svelte'
  import type { CouncilAttempt } from '@shared/protocol'
  import { COUNCIL_SHARED_KERNEL_NOTE, type CouncilSettings } from '@shared/notebook'
  import { requestReason, type KernelView } from '@/lib/council-pult'
  import { clock } from '@/lib/history'
  import { spell } from '@/lib/utils'

  interface Props {
    kernel: KernelView
    settings: CouncilSettings
    names: boolean
    now: number
    /** Retained for callers; global navigation now controls this view. */
    open: boolean
    disabled: boolean
    ontoggle: () => void
    onpolicy: (value: CouncilSettings['studentRun']) => void
    oninterrupt: () => void
    onapprove: (attempt: CouncilAttempt) => void
    ondecline: (attempt: CouncilAttempt) => void
    onapproveall: () => void
    onremove: (attempt: CouncilAttempt, event: MouseEvent) => void
  }

  let { kernel, settings, names, now, disabled, onpolicy, oninterrupt, onapprove, ondecline, onapproveall, onremove }: Props = $props()
  const running = $derived(kernel.running)
  const elapsed = $derived(running ? Math.max(now - running.run!.startedAt, 0) : 0)
  const POLICY: { value: CouncilSettings['studentRun']; key: string }[] = [
    { value: false, key: 'room.pult.v2.queue.policyTeacher' },
    { value: true, key: 'room.pult.v2.queue.policyEveryone' },
    { value: 'request', key: 'room.pult.v2.queue.policyRequest' },
  ]
  const who = (attempt: CouncilAttempt): string => names ? attempt.name : tr('room.pult.v2.queue.anonymous')
</script>

<div class="queue-view" data-pult-queue>
  <div class="queue-content">
    <header class="queue-heading">
      <div>
        <h2>{tr('room.pult.v2.queue.title')}</h2>
        <p>{tr('room.pult.v2.queue.scope')}</p>
      </div>
      <p class="queue-counts">{tr('room.pult.v2.queue.counts', { running: running ? 1 : 0, queued: kernel.queued.length })}</p>
    </header>

    <section class="running-card" class:is-running={running !== null} aria-label={tr('room.pult.v2.queue.current')}>
      {#if running}
        <span class="running-icon" aria-hidden="true">▶</span>
        <div class="running-copy">
          <span class="running-label">{tr('room.pult.v2.queue.current')}</span>
          <div class="running-author">
            {#if names}<Avatar name={running.name} color={running.color} avatar={running.avatar} size="md" />{/if}
            <strong>{who(running)}</strong><span class="running-time">{spell(elapsed)}</span>
          </div>
        </div>
        <div class="running-actions">
          <button type="button" class="pult-button pult-button--danger" {disabled} onclick={oninterrupt}>{tr('room.pult.v2.queue.interrupt')}</button>
          <button type="button" class="pult-button pult-button--danger" {disabled} data-pult-remove
            onclick={(event) => onremove(running, event)}>{tr('room.ui.78')}</button>
        </div>
      {:else}
        <span class="running-icon" aria-hidden="true">○</span>
        <p class="idle-copy">{tr('room.pult.v2.queue.idle')}</p>
      {/if}
    </section>

    <section class="pending-section" aria-label={tr('room.pult.v2.queue.pendingTitle', { count: kernel.pending.length })}>
      <div class="section-heading">
        <h3 class="pending-title">{tr('room.pult.v2.queue.pendingTitle', { count: kernel.pending.length })}</h3>
        {#if kernel.pending.length > 0}
          <button type="button" class="pult-button" {disabled} onclick={onapproveall}>{tr('room.pult.v2.queue.allowAll', { count: kernel.pending.length })}</button>
        {/if}
      </div>
      {#if kernel.pending.length === 0}
        <p class="empty-copy">{tr('room.pult.v2.queue.noRequests')}</p>
      {:else}
        <ul class="attempt-list">
          {#each kernel.pending as attempt (attempt.participantId)}
            {@const reason = requestReason(attempt)}
            <li class="pending-row">
              <span class="avatar-slot" aria-hidden="true">
                {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" />{:else}<span class="anonymous-avatar"></span>{/if}
              </span>
              <div class="attempt-copy">
                <strong>{who(attempt)}</strong>
                <span class="request-time" title={clock(attempt.runRequest!.requestedAt)}>{tr('room.pult.v2.queue.waiting', { duration: spell(Math.max(now - attempt.runRequest!.requestedAt, 0)) })}</span>
              </div>
              {#if reason}<span class="request-reason pult-meta">{reason}</span>{/if}
              <div class="row-actions">
                <button type="button" class="pult-button pult-button--primary" {disabled} onclick={() => onapprove(attempt)}>{tr('room.pult.v2.queue.allow')}</button>
                <button type="button" class="pult-button" {disabled} onclick={() => ondecline(attempt)}>{tr('room.pult.v2.queue.decline')}</button>
                <button type="button" class="pult-button pult-button--danger" {disabled} data-pult-remove
                  onclick={(event) => onremove(attempt, event)}>{tr('room.ui.78')}</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="queued-section" aria-label={tr('room.pult.v2.queue.queuedTitle', { count: kernel.queued.length })}>
      <div class="section-heading"><h3>{tr('room.pult.v2.queue.queuedTitle', { count: kernel.queued.length })}</h3></div>
      {#if kernel.queued.length === 0}
        <p class="empty-copy">{tr('room.pult.v2.queue.noQueued')}</p>
      {:else}
        <ol class="attempt-list">
          {#each kernel.queued as attempt, at (attempt.participantId)}
            <li class="queued-row">
              <span class="queue-position" aria-hidden="true">{String(at + 1).padStart(2, '0')}</span>
              <span class="avatar-slot" aria-hidden="true">
                {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" />{:else}<span class="anonymous-avatar"></span>{/if}
              </span>
              <strong class="queued-author">{who(attempt)}</strong>
              <code>{attempt.text.split('\n').find((line) => line.trim()) ?? ''}</code>
              <button type="button" class="pult-button pult-button--danger" {disabled} data-pult-remove
                onclick={(event) => onremove(attempt, event)}>{tr('room.ui.78')}</button>
            </li>
          {/each}
        </ol>
        <p class="queue-order pult-meta">{tr('room.pult.v2.queue.order')}</p>
      {/if}
    </section>
  </div>

  <section class="queue-policy" aria-label={tr('room.pult.v2.queue.policyTitle')}>
    <div class="policy-controls">
      <h3>{tr('room.pult.v2.queue.policyTitle')}</h3>
      <div class="policy-options">
        {#each POLICY as item (String(item.value))}
          <button type="button" class="pult-button" class:pult-button--selected={settings.studentRun === item.value} aria-pressed={settings.studentRun === item.value} {disabled} onclick={() => onpolicy(item.value)}>
            {tr(item.key)}{settings.studentRun === item.value ? ' ✓' : ''}
          </button>
        {/each}
      </div>
    </div>
    <p class="pult-meta shared-note">{tr(COUNCIL_SHARED_KERNEL_NOTE)}</p>
  </section>
</div>

<style>
  .queue-view { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: rgb(var(--ink)); }
  .queue-content { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 28px; }
  .queue-heading, .section-heading, .policy-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  h2 { font-size: 24px; line-height: 30px; font-weight: 700; }
  .queue-heading p { margin-top: 6px; color: rgb(var(--muted)); font-size: 14px; line-height: 20px; }
  .queue-counts { flex-shrink: 0; }
  .running-card { display: flex; align-items: center; gap: 16px; margin: 20px 0 24px; padding: 18px 20px; border-left: 4px solid rgb(var(--line)); background: rgb(var(--raised)); }
  .running-card.is-running { border-left-color: rgb(var(--accent)); }
  .running-icon { flex-shrink: 0; width: 32px; color: rgb(var(--accent-text)); font-size: 26px; line-height: 32px; }
  .running-copy { flex: 1; min-width: 0; }
  .running-label { color: rgb(var(--accent-text)); font-size: 14px; line-height: 20px; font-weight: 600; }
  .running-author { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 6px; font-size: 18px; line-height: 24px; }
  .running-author strong { overflow-wrap: anywhere; }
  .running-time { color: rgb(var(--muted)); font-size: 16px; font-variant-numeric: tabular-nums; }
  .running-actions { display: flex; flex-shrink: 0; flex-wrap: wrap; gap: 8px; }
  .idle-copy { font-size: 16px; line-height: 24px; color: rgb(var(--muted)); }
  h3 { font-size: 18px; line-height: 26px; font-weight: 700; }
  .pending-title { color: rgb(var(--warning)); font-size: 20px; }
  .section-heading { margin-bottom: 12px; }
  .attempt-list { padding: 0; margin: 0; list-style: none; }
  .pending-row { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-top: 1px solid rgb(var(--line)); }
  .avatar-slot, .anonymous-avatar { display: block; width: 32px; height: 32px; flex-shrink: 0; }
  .anonymous-avatar { border-radius: 50%; background: rgb(var(--line)); }
  .attempt-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 5px; }
  .attempt-copy strong, .queued-author { font-size: 16px; line-height: 20px; font-weight: 700; overflow-wrap: anywhere; }
  .request-time { color: rgb(var(--muted)); font-size: 14px; line-height: 20px; }
  .request-reason { max-width: 180px; color: rgb(var(--danger)); overflow-wrap: anywhere; }
  .row-actions { display: flex; flex-shrink: 0; gap: 8px; }
  .empty-copy { color: rgb(var(--muted)); font-size: 14px; line-height: 20px; }
  .queued-section { margin-top: 24px; }
  .queued-row { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-top: 1px solid rgb(var(--line)); }
  .queue-position { width: 24px; flex-shrink: 0; color: rgb(var(--muted)); font-size: 15px; font-variant-numeric: tabular-nums; }
  .queued-author { width: 170px; flex-shrink: 0; }
  code { min-width: 0; color: rgb(var(--muted)); font-family: var(--font-mono); font-size: 14px; line-height: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .queue-order { margin-top: 8px; color: rgb(var(--muted)); }
  .queue-policy { flex-shrink: 0; padding: 18px 28px; border-top: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  .policy-controls h3 { font-size: 15px; line-height: 20px; }
  .policy-options { display: flex; flex-wrap: wrap; gap: 8px; }
  .shared-note { margin-top: 12px; color: rgb(var(--muted)); line-height: 20px; }
  @media (max-width: 850px) {
    .queue-content { padding: 20px; }
    .queue-policy { padding: 16px 20px; }
    .pending-row { flex-wrap: wrap; gap: 12px; }
    .attempt-copy { min-width: 180px; }
    .request-reason { max-width: none; flex-basis: 100%; padding-left: 44px; order: 1; }
    .queued-author { width: 140px; }
  }
  @media (max-width: 540px) {
    .running-card { flex-wrap: wrap; }
    .row-actions { margin-left: 44px; }
    .queued-row { flex-wrap: wrap; gap: 10px; }
    .queued-row code { flex-basis: 100%; margin-left: 34px; }
  }
</style>
