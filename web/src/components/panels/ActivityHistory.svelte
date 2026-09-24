<script lang="ts">
  import { untrack } from 'svelte'
  import { formatDate, formatNumber, tr } from '@shared/i18n'
  import { ACTIVITY_CATEGORIES, ACTIVITY_LEVELS, type ActivityCategory, type ActivityEvent, type ActivityLevel } from '@shared/activity'
  import { listActivity } from '@/lib/activity'
  import { clock, initialsOf } from '@/lib/history'
  import { getSessionState } from '@/lib/session.svelte'

  const session = getSessionState()
  /**
   * A step of the oracle's work: its details carry the name of a tool, not of a
   * person.
   *
   * `subjectId` is a shared field — for a council review it holds the draft's
   * owner — so the name is shown only for this kind of event, and only here.
   */
  const WORK_STEP = 'oracle.work_step'
  let level = $state<ActivityLevel>('normal')
  let category = $state<ActivityCategory>('all')
  let events = $state<ActivityEvent[]>([])
  let selected = $state<number | null>(null)
  const detail = $derived(events.find((event) => event.seq === selected) ?? null)
  let loading = $state(false)
  let failed = $state(false)
  let nextBefore = $state<number | null>(null)
  let trimmed = $state(false)
  let olderLoaded = false
  let controller: AbortController | null = null
  let generation = 0

  async function load(append = false): Promise<void> {
    if (loading || (append && nextBefore === null)) return
    const current = generation
    const abort = new AbortController()
    controller = abort
    loading = true
    failed = false
    try {
      const body = await listActivity(session.session.id, session.token, level, category, append ? nextBefore : null, abort.signal)
      if (current !== generation || abort.signal.aborted) return
      events = append ? [...events, ...body.events.filter((item) => !events.some((existing) => existing.seq === item.seq))] : body.events
      nextBefore = body.nextBefore
      trimmed = body.trimmed
      olderLoaded = append
      if (!events.some((event) => event.seq === selected)) selected = events[0]?.seq ?? null
    } catch {
      if (current === generation && !abort.signal.aborted) failed = true
    } finally {
      if (current === generation) loading = false
    }
  }

  function chooseCategory(event: Event): void {
    category = (event.currentTarget as HTMLSelectElement).value as ActivityCategory
    // Categories should immediately show their events, even from Important.
    if (category === 'runtime' || category === 'notebook') level = 'detailed'
    else if (category === 'presence' && level === 'important') level = 'normal'
  }

  $effect(() => {
    // One request per filter change. No listener lives outside this mounted view.
    level; category
    untrack(() => {
      generation += 1
      controller?.abort()
      loading = false
      events = []
      selected = null
      nextBefore = null
      olderLoaded = false
      if (document.visibilityState === 'visible') void load()
    })
    const refresh = () => {
      // Reading older pages is deliberate: do not replace them underneath the reader.
      if (document.visibilityState === 'visible' && !olderLoaded) void load()
    }
    const interval = setInterval(refresh, 15_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      generation += 1
      controller?.abort()
      clearInterval(interval)
      document.removeEventListener('visibilitychange', refresh)
    }
  })
</script>

<div class="activity">
  <div class="filters">
    <label>{tr('activity.category')}
      <select aria-label={tr('activity.category')} value={category} onchange={chooseCategory}>
        {#each ACTIVITY_CATEGORIES as value}<option {value}>{tr(`activity.category.${value}`)}</option>{/each}
      </select>
    </label>
    <label>{tr('activity.level')}
      <select aria-label={tr('activity.level')} bind:value={level}>
        {#each ACTIVITY_LEVELS as value}<option {value}>{tr(`activity.${value}`)}</option>{/each}
      </select>
    </label>
    <button type="button" class="refresh" disabled={loading} onclick={() => load()}>{tr('activity.refresh')}</button>
    <p class="filter-hint">{tr(`activity.hint.${level}`)}</p>
  </div>
  <div class="activity-body">
    <div class="timeline" aria-busy={loading}>
      {#if failed}
        <p class="note error" role="alert">{tr('activity.error')}</p>
      {/if}
      {#if loading && events.length === 0}
        <p class="note" role="status">{tr('activity.loading')}</p>
      {:else if !failed && events.length === 0}
        <p class="note">{tr('activity.empty')}</p>
      {/if}
      <ul aria-label={tr('activity.title')}>
        {#each events as event (event.seq)}
          {@const tool = event.kind === WORK_STEP ? (event.details.subjectId ?? '') : ''}
          <li>
            <button type="button" class="event" class:selected={selected === event.seq} aria-pressed={selected === event.seq} onclick={() => (selected = event.seq)}>
              <time datetime={new Date(event.createdAt).toISOString()} title={formatDate(event.createdAt, { dateStyle: 'medium', timeStyle: 'medium' })}>{clock(event.createdAt)}</time>
              <span class="avatar" aria-hidden="true">{initialsOf(event.actor?.name ?? null) || '·'}</span>
              <span class="event-copy">
                <strong>{event.actor?.name ?? tr('activity.system')}</strong>
                <span>{tr(`activity.${event.kind}`)}</span>
                {#if tool || event.details.source || event.details.outcome}
                  <small class:bad={event.details.outcome === 'error'}>
                    {#if tool}<code>{tool}</code>{/if}
                    {#if tool && (event.details.source || event.details.outcome)} · {/if}
                    {#if event.details.source}{tr(`activity.source.${event.details.source}`)}{/if}
                    {#if event.details.source && event.details.outcome} · {/if}
                    {#if event.details.outcome}{tr(`activity.outcome.${event.details.outcome}`)}{/if}
                  </small>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if nextBefore !== null}
        <button type="button" class="more" disabled={loading} onclick={() => load(true)}>{loading ? tr('activity.loading') : tr('activity.more')}</button>
      {:else if trimmed}
        <p class="note tail">{tr('activity.trimmed')}</p>
      {/if}
    </div>
    <div class="detail">
      <div class="detail-content">
        {#if detail}
          <p class="eyebrow">{tr(`activity.${detail.level}`)}</p>
          <h3>{tr(`activity.${detail.kind}`)}</h3>
          <dl>
            <dt>{tr('activity.actor')}</dt><dd>{detail.actor?.name ?? tr('activity.system')}</dd>
            <dt>{tr('activity.time')}</dt><dd>{formatDate(detail.createdAt, { dateStyle: 'medium', timeStyle: 'medium' })}</dd>
            {#if detail.details.action}<dt>{tr('activity.action')}</dt><dd>{tr(`activity.action.${detail.details.action}`)}</dd>{/if}
            {#if detail.details.outcome}<dt>{tr('activity.outcome')}</dt><dd class:bad={detail.details.outcome === 'error'}>{tr(`activity.outcome.${detail.details.outcome}`)}</dd>{/if}
            {#if detail.details.source}<dt>{tr('activity.source')}</dt><dd>{tr(`activity.source.${detail.details.source}`)}</dd>{/if}
            {#if detail.details.durationMs !== undefined}<dt>{tr('activity.duration')}</dt><dd>{tr('activity.seconds', { count: formatNumber(detail.details.durationMs / 1000, { maximumFractionDigits: 1 }) })}</dd>{/if}
            {#if detail.details.versionSeq !== undefined}<dt>{tr('activity.version')}</dt><dd>#{detail.details.versionSeq}</dd>{/if}
            {#if detail.kind === WORK_STEP && detail.details.subjectId}<dt>{tr('activity.tool')}</dt><dd><code>{detail.details.subjectId}</code></dd>{/if}
            {#if detail.details.cellId}<dt>{tr('activity.cell')}</dt><dd><code>{detail.details.cellId}</code></dd>{/if}
            {#if detail.details.count !== undefined}<dt>{tr('activity.count')}</dt><dd>{detail.details.count}</dd>{/if}
            {#if detail.details.reason}<dt>{tr('activity.reason')}</dt><dd>{tr(`activity.reason.${detail.details.reason}`)}</dd>{/if}
          </dl>
        {:else}
          <p class="note">{tr('activity.select')}</p>
        {/if}
      </div>
      <footer><p>{tr('activity.readOnly')}</p><span>{tr('activity.hostOnly')}</span></footer>
    </div>
  </div>
</div>

<style>
  .activity { display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1; color: var(--tm-muted); font-size: 14px; }
  .filters { display: flex; align-items: end; flex-wrap: wrap; gap: 8px 12px; padding: 10px 14px; border-bottom: 1px solid var(--tm-edge); flex: none; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--tm-muted); }
  select, .refresh, .more { box-sizing: border-box; min-height: 34px; padding: 6px 10px; border: 1px solid var(--tm-edge); color: var(--tm-ink); background: var(--tm-bg); font: inherit; cursor: pointer; }
  select { max-width: 100%; }
  button:focus-visible, select:focus-visible { outline: 2px solid var(--tm-accent); outline-offset: -2px; }
  button:disabled { cursor: default; opacity: 0.5; }
  .filter-hint { flex: 1 1 140px; margin: 0 0 8px; color: var(--tm-muted); font-size: 13px; }
  .activity-body { display: flex; flex: 1; min-height: 0; min-width: 0; }
  .timeline { flex: 0 0 45%; min-width: 0; overflow-y: auto; border-right: 1px solid var(--tm-edge); padding-block: 6px; }
  ul { margin: 0; padding: 0; list-style: none; }
  .event { box-sizing: border-box; display: flex; align-items: start; gap: 10px; width: 100%; padding: 9px 12px; text-align: left; color: inherit; border: 0; border-left: 2px solid transparent; background: transparent; font: inherit; cursor: pointer; }
  .event:hover { background: #0c1631; }
  .event.selected { background: #0e1a3d; border-left-color: var(--tm-accent); }
  time { flex: none; width: 38px; margin-top: 3px; color: var(--tm-muted); font: 12px var(--tm-mono); }
  .avatar { display: flex; flex: none; align-items: center; justify-content: center; width: 23px; height: 23px; border: 1px solid var(--tm-edge); border-radius: 50%; color: var(--tm-accent); font-size: 9px; font-weight: 700; }
  .event-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; line-height: 1.4; }
  .event-copy strong { color: var(--tm-ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .event-copy span { overflow-wrap: anywhere; color: var(--tm-muted); }
  .event-copy small { color: var(--tm-live); font-size: 13px; }
  .event-copy small code, dd code { font: inherit; font-family: var(--tm-mono); }
  .more { margin: 8px 12px; }
  .detail { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
  .detail-content { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
  .eyebrow { margin: 0 0 8px; color: var(--tm-accent); font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; }
  h3 { margin: 0 0 18px; color: var(--tm-ink); font-size: 16px; font-weight: 600; line-height: 1.4; }
  dl { display: grid; grid-template-columns: minmax(75px, 0.7fr) minmax(0, 1fr); gap: 10px 16px; line-height: 1.5; }
  dt { color: var(--tm-muted); } dd { margin: 0; color: var(--tm-ink); overflow-wrap: anywhere; }
  footer { flex: none; border-top: 1px solid var(--tm-edge); padding: 12px 16px; font-size: 13px; line-height: 1.5; }
  footer p { margin: 0 0 8px; } footer span { color: var(--tm-muted); }
  .note { margin: 0; padding: 12px; color: var(--tm-muted); line-height: 1.5; }
  .detail-content > .note { padding: 0; }
  .error, .bad, .event-copy small.bad { color: #e8a3b1; }
  .tail { border-top: 1px solid var(--tm-edge); }
  @media (max-width: 720px) {
    .activity { overflow-y: auto; }
    .activity-body { flex-direction: column; flex: 1 0 auto; overflow: visible; }
    .timeline { flex: 0 0 auto; max-height: 180px; border-right: 0; border-bottom: 1px solid var(--tm-edge); }
    .detail { flex: 1 0 auto; }
    .detail-content { overflow: visible; }
    .filters { gap: 8px; }
    .filter-hint { flex-basis: 100%; margin: 0; }
  }
</style>
