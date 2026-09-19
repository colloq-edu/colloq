<script lang="ts">
  import { tr } from '@shared/i18n'
  import Avatar from '@/components/ui/Avatar.svelte'
  import type { CouncilAttempt } from '@shared/protocol'
  import type { CouncilSettings } from '@shared/notebook'
  import { pultClock, pultDuration, requestReason, timedOutAttempts, timedOutLimit, type KernelView } from '@/lib/council-pult'
  import { spell } from '@/lib/utils'

  interface Props {
    kernel: KernelView
    /** Регламент ячейки: отсюда очередь знает предел запуска. Меняют его в листе. */
    settings: CouncilSettings
    /** Вся стопка — ради секции «Остановлены сами»: её работы уже не в очереди. */
    attempts: readonly CouncilAttempt[]
    names: boolean
    now: number
    /** Retained for callers; global navigation now controls this view. */
    open: boolean
    disabled: boolean
    ontoggle: () => void
    oninterrupt: () => void
    onapprove: (attempt: CouncilAttempt) => void
    ondecline: (attempt: CouncilAttempt) => void
    onapproveall: () => void
    onopen: (participantId: string) => void
    onremove: (attempt: CouncilAttempt, event: MouseEvent) => void
  }

  let { kernel, settings, attempts, names, now, disabled, oninterrupt, onapprove, ondecline, onapproveall, onopen, onremove }: Props = $props()
  const running = $derived(kernel.running)
  const elapsed = $derived(running ? Math.max(now - running.run!.startedAt, 0) : 0)
  const limitMs = $derived(settings.runLimitSec === null ? null : settings.runLimitSec * 1000)
  /** Предел вышел, а запуск идёт: SIGINT не взял, и дальше — только руками. */
  const overLimit = $derived(limitMs !== null && elapsed >= limitMs)
  const stopped = $derived(timedOutAttempts(attempts))
  const who = (attempt: CouncilAttempt): string => names ? attempt.name : tr('room.pult.v2.queue.anonymous')
  const firstLine = (text: string): string => text.split('\n').find((line) => line.trim()) ?? ''
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
            <!-- Час запуска с секундами: за минуту их бывает три, и «17:24» у
                 всех трёх не отличает их друг от друга. -->
            <strong>{who(running)}</strong><span class="running-time">{tr('room.pult.v3.queueRunning', { time: pultClock(running.run!.startedAt, true), duration: spell(elapsed) })}</span>
          </div>
          <!--
            Предел — там, где он срабатывает.
            Полоса отвечает на единственный вопрос к чужому запуску, идущему
            перед всем классом: ждать его или прерывать. Она же и ловит случай,
            когда ждать бессмысленно: время вышло, а запуск идёт — значит
            остановка не взяла, и дальше поможет только рука.
          -->
          {#if limitMs !== null}
            <div class="running-limit">
              <span class="limit-track" aria-hidden="true">
                <span class="limit-fill" class:over={overLimit} style:width={`${Math.min(100, (elapsed / limitMs) * 100)}%`}></span>
              </span>
              <span class="limit-note" class:over={overLimit}>
                {overLimit
                  ? tr('room.pult.v2.queue.limitStuck')
                  : tr('room.pult.v2.queue.limitStops', { duration: pultDuration(settings.runLimitSec!) })}
              </span>
            </div>
          {/if}
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
                <!-- С какого времени ждёт — словом, а не только в подсказке:
                     по нему решают, кого пускать первым. -->
                <span class="request-time">{tr('room.pult.v2.queue.waiting', { duration: spell(Math.max(now - attempt.runRequest!.requestedAt, 0)) })} · {tr('room.pult.v3.queueSince', { time: pultClock(attempt.runRequest!.requestedAt) })}</span>
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
              <code>{firstLine(attempt.text)}</code>
              <!-- С какого времени стоит в очереди: без этого «в очереди 4» —
                   число без движения, и непонятно, идёт ли она вообще. -->
              <time class="pult-meta queued-since" datetime={new Date(attempt.run!.startedAt).toISOString()}>{tr('room.pult.v3.queueSince', { time: pultClock(attempt.run!.startedAt) })}</time>
              <button type="button" class="pult-button pult-button--danger" {disabled} data-pult-remove
                onclick={(event) => onremove(attempt, event)}>{tr('room.ui.78')}</button>
            </li>
          {/each}
        </ol>
        <p class="queue-order pult-meta">{tr('room.pult.v2.queue.order')}</p>
      {/if}
    </section>

    <!--
      Последняя секция — те, кого очередь обогнала.
      Их в очереди уже нет, и в ленте работ они стоят обычными строками, но
      вопрос «почему у половины класса нет вывода» задают именно здесь, глядя
      на очередь. Слева — предел, который сработал: он мог с тех пор
      поменяться, и число говорит про СВОЙ запуск, а не про сегодняшнее
      правило.
    -->
    {#if stopped.length > 0}
      <section class="stopped-section" aria-label={tr('room.pult.v2.queue.stoppedTitle', { count: stopped.length })}>
        <div class="section-heading">
          <h3 class="stopped-title">{tr('room.pult.v2.queue.stoppedTitle', { count: stopped.length })}</h3>
          <p class="pult-meta">{tr('room.pult.v2.queue.stoppedNote')}</p>
        </div>
        <ul class="attempt-list">
          {#each stopped as attempt (attempt.participantId)}
            <li>
              <button type="button" class="stopped-row" onclick={() => onopen(attempt.participantId)}
                aria-label={tr('room.pult.v2.queue.stoppedOpen', { name: who(attempt) })}>
                <span class="stopped-limit">{pultDuration(timedOutLimit(attempt)!)}</span>
                <span class="avatar-slot" aria-hidden="true">
                  {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" />{:else}<span class="anonymous-avatar"></span>{/if}
                </span>
                <strong class="queued-author">{who(attempt)}</strong>
                <code>{firstLine(attempt.text)}</code>
                <time class="pult-meta stopped-time" datetime={new Date(attempt.run!.startedAt).toISOString()}>{pultClock(attempt.run!.startedAt)}</time>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</div>

<style>
  .queue-view { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: rgb(var(--ink)); }
  .queue-content { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 28px; }
  .queue-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
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
  .running-limit { display: flex; align-items: center; gap: 12px; padding-top: 7px; }
  .limit-track { flex: 1; min-width: 0; height: 4px; background: rgb(var(--canvas)); }
  .limit-fill { display: block; height: 100%; background: rgb(var(--accent)); }
  .limit-fill.over { background: rgb(var(--danger)); }
  .limit-note { flex-shrink: 0; color: rgb(var(--muted)); font-size: 13px; line-height: 18px; }
  .limit-note.over { color: rgb(var(--danger)); }
  .stopped-section { margin-top: 24px; }
  .stopped-title { color: rgb(var(--muted)); line-height: 22px; }
  .stopped-row { display: flex; align-items: center; gap: 16px; width: 100%; padding: 12px 0; border-top: 1px solid rgb(var(--line)); text-align: left; cursor: pointer; }
  .stopped-row:hover { background: rgb(var(--surface)); }
  .stopped-limit { width: 36px; flex-shrink: 0; color: rgb(var(--danger)); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stopped-time { flex-shrink: 0; }
  .queued-since { flex-shrink: 0; font-variant-numeric: tabular-nums; }
  @media (max-width: 850px) {
    .queue-content { padding: 20px; }
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
