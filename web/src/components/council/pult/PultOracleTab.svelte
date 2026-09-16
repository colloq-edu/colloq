<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { CouncilAttempt, CouncilOracle } from '@shared/protocol'
  import { oracleState, staleBy } from '@/lib/council-board'
  import { clock } from '@/lib/history'

  interface Props {
    oracle: CouncilOracle | null
    attempts: readonly CouncilAttempt[]
    submitted: number
    names: boolean
    askWhy: string | null
    onask: () => void
    onstop: () => void
  }

  let { oracle, attempts, submitted, names, askWhy, onask, onstop }: Props = $props()
  const ENOUGH = 10
  const view = $derived(oracleState(oracle, submitted))
  const behind = $derived(oracle ? staleBy(oracle, submitted) : 0)
  const evaluated = $derived(attempts.filter((attempt) => attempt.submittedAt !== null && (attempt.correct === true || attempt.correct === false)).length)
  const drafts = $derived(attempts.filter((attempt) => attempt.submittedAt === null).length)
  const hasSummary = $derived(oracle?.summary.some((paragraph) => paragraph.trim().length > 0) ?? false)
  const heads = ['room.pult.v2.oracle.success', 'room.pult.v2.oracle.discuss', 'room.pult.v2.oracle.show']
</script>

<div class="oracle-view" data-pult-oracle={view}>
  <div class="oracle-content">
    <header class="oracle-heading">
      <span class="oracle-symbol" aria-hidden="true">✦</span>
      <div><h2>{tr('room.pult.v2.oracle.title')}</h2><p>{tr('room.pult.v2.oracle.purpose')}</p></div>
    </header>
    <dl class="oracle-metrics">
      <div><dt>{tr('room.pult.v2.oracle.submitted')}</dt><dd>{submitted}</dd></div>
      <div><dt>{tr('room.pult.v2.oracle.evaluated')}</dt><dd>{evaluated}</dd></div>
      <div><dt>{tr('room.pult.v2.oracle.drafts', { count: drafts })}</dt><dd>{drafts}</dd></div>
    </dl>

    {#if oracle?.error}
      <div class="oracle-error" role="alert"><strong>{tr('room.pult.v2.oracle.error')}</strong><p>{oracle.error}</p></div>
    {/if}

    {#if view === 'reading'}
      <section class="oracle-loading" aria-busy="true" aria-label={tr('room.pult.v2.oracle.reading')}>
        <p class="loading-label" role="status">✦ {tr('room.pult.v2.oracle.reading')}</p>
        <p class="state-copy">{tr('room.pult.v2.oracle.readingScope', { count: oracle?.basedOn ?? submitted })}</p>
        <div class="skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
        <p class="state-copy">{tr('room.pult.v2.oracle.readingHint')}</p>
      </section>
    {:else if hasSummary && oracle}
      <div class="oracle-summary">
        {#each oracle.summary as paragraph, at (at)}
          {#if paragraph.trim()}
            <section class="summary-section" class:discussion={at === 1}>
              <h3>
                {#if at === 0}<span class="success-mark" aria-hidden="true">✓</span>{/if}
                {tr(heads[at] ?? 'room.pult.v2.oracle.observation')}
              </h3>
              <p>{paragraph}</p>
            </section>
          {/if}
        {/each}
        <div class="summary-meta">
          <p>{tr('room.pult.v2.oracle.basedOn', { count: oracle.basedOn })}{oracle.askedAt === null ? '' : ` · ${tr('room.pult.v2.oracle.requestedAt', { time: clock(oracle.askedAt) })}`}</p>
          {#if behind > 0}<p class="stale-message" role="status">{tr('room.pult.v2.oracle.stale', { count: behind })}</p>{/if}
        </div>
      </div>
    {:else}
      <section class="oracle-empty">
        <h3>{tr(submitted === 0 ? 'room.pult.v2.oracle.noSubmissions' : 'room.pult.v2.oracle.noSummary')}</h3>
        <p>{tr(submitted === 0 ? 'room.pult.v2.oracle.noSubmissionsHint' : submitted < ENOUGH ? 'room.pult.v2.oracle.fewSubmissions' : 'room.pult.v2.oracle.emptyHint')}</p>
      </section>
    {/if}
  </div>

  <footer class="oracle-actions">
    <div class="oracle-action-copy">
      <p>{tr('room.pult.v2.oracle.private')}</p>
      {#if !names}<p class="pult-meta">{tr('room.pult.v2.oracle.anonymous')}</p>{/if}
      {#if askWhy && view !== 'reading'}<p class="ask-reason">{askWhy}</p>{/if}
    </div>
    {#if view === 'reading'}
      <button type="button" class="pult-button pult-button--danger" onclick={onstop}>{tr('room.pult.v2.oracle.stop')}</button>
    {:else}
      <button type="button" class="pult-button pult-button--primary" disabled={askWhy !== null} onclick={onask}>
        <span aria-hidden="true">✦</span> {tr(hasSummary ? 'room.pult.v2.oracle.refresh' : oracle?.error ? 'room.pult.v2.oracle.retry' : 'room.pult.v2.oracle.ask')}
      </button>
    {/if}
  </footer>
</div>

<style>
  .oracle-view { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: rgb(var(--ink)); }
  .oracle-content { flex: 1; min-height: 0; overflow-y: auto; }
  .oracle-heading { display: flex; align-items: center; gap: 18px; padding: 28px; }
  .oracle-symbol { display: flex; align-items: center; justify-content: center; width: 52px; height: 52px; flex-shrink: 0; color: rgb(var(--accent-text)); font-size: 32px; line-height: 40px; }
  h2 { font-size: 24px; line-height: 30px; font-weight: 700; }
  .oracle-heading p { margin-top: 7px; font-size: 15px; line-height: 22px; color: rgb(var(--muted)); }
  .oracle-metrics { display: flex; flex-wrap: wrap; gap: 24px 32px; margin: 0; padding: 0 28px 24px; border-bottom: 1px solid rgb(var(--line)); }
  .oracle-metrics div { display: flex; align-items: baseline; gap: 10px; min-width: 170px; }
  dt { order: 1; font-size: 15px; line-height: 20px; color: rgb(var(--muted)); }
  dd { margin: 0; font-size: 30px; line-height: 36px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .oracle-summary { padding: 24px 28px; }
  .summary-section { margin-bottom: 20px; }
  h3 { font-size: 18px; line-height: 24px; font-weight: 700; }
  .summary-section h3 { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .success-mark { color: rgb(var(--positive)); }
  .summary-section p { max-width: 850px; font-size: 16px; line-height: 24px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .discussion { padding: 20px 24px; border-left: 4px solid rgb(var(--warning)); background: rgb(var(--warning) / 0.08); }
  .discussion h3 { color: rgb(var(--warning)); }
  .summary-meta { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding-top: 4px; color: rgb(var(--muted)); font-size: 14px; line-height: 20px; }
  .stale-message { color: rgb(var(--warning)); }
  .oracle-empty, .oracle-loading { padding: 32px 28px; }
  .oracle-empty p { max-width: 640px; margin-top: 12px; color: rgb(var(--muted)); font-size: 16px; line-height: 24px; }
  .oracle-error { margin: 24px 28px 0; padding: 16px 20px; border-left: 4px solid rgb(var(--danger)); background: rgb(var(--danger) / 0.07); font-size: 16px; line-height: 24px; }
  .oracle-error strong { color: rgb(var(--danger)); }
  .oracle-error p { margin-top: 6px; overflow-wrap: anywhere; }
  .loading-label { color: rgb(var(--accent-text)); font-size: 18px; line-height: 24px; font-weight: 700; }
  .state-copy { color: rgb(var(--muted)); margin-top: 12px; font-size: 16px; line-height: 24px; }
  .skeleton { display: flex; flex-direction: column; gap: 14px; max-width: 760px; padding: 28px 0; }
  .skeleton span { height: 14px; background: rgb(var(--line)); }
  .skeleton span:nth-child(2) { width: 85%; }
  .skeleton span:nth-child(3) { width: 65%; }
  .oracle-actions { display: flex; flex-shrink: 0; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 28px; border-top: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  .oracle-action-copy { flex: 1; min-width: 180px; display: flex; flex-direction: column; gap: 6px; color: rgb(var(--muted)); font-size: 14px; line-height: 20px; }
  .ask-reason { color: rgb(var(--warning)); }
  @media (max-width: 850px) {
    .oracle-heading { padding: 24px 20px; }
    .oracle-metrics { padding: 0 20px 20px; gap: 16px 24px; }
    .oracle-metrics div { min-width: 140px; }
    .oracle-summary, .oracle-empty, .oracle-loading { padding: 24px 20px; }
    .oracle-error { margin: 20px 20px 0; }
    .oracle-actions { padding: 16px 20px; }
  }
</style>
