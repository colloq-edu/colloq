<script lang="ts">
  import { tr } from '@shared/i18n'
  import Avatar from '@/components/ui/Avatar.svelte'
  import type { CouncilAttempt } from '@shared/protocol'
  import type { CouncilSettings } from '@shared/notebook'
  import ContextMenu, { type ContextMenuItem } from '@/components/ui/ContextMenu.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { kernelIsBusy, pultClock, pultDuration, queuedInBook, requestReason, timedOutAttempts, timedOutLimit, type KernelView } from '@/lib/council-pult'
  import { spell } from '@/lib/utils'

  interface Props {
    kernel: KernelView
    /** The cell's rules give the queue its run limit; they are changed in the sheet. */
    settings: CouncilSettings
    /**
     * The whole pile, for the "Stopped by the limit" section: that work is no
     * longer in the queue.
     */
    attempts: readonly CouncilAttempt[]
    names: boolean
    now: number
    /** Retained for callers; global navigation now controls this view. */
    open: boolean
    disabled: boolean
    ontoggle: () => void
    oninterrupt: () => void
    /** Restart the NOTEBOOK's kernel — a last resort when it is deaf to the signal. */
    onrestart: () => void
    onapprove: (attempt: CouncilAttempt) => void
    ondecline: (attempt: CouncilAttempt) => void
    onapproveall: () => void
    onopen: (participantId: string) => void
    /** Take a waiting run out of the queue — without touching the person. */
    ondrop: (attempt: CouncilAttempt) => void
    onremove: (attempt: CouncilAttempt, event: MouseEvent) => void
  }

  let { kernel, settings, attempts, names, now, disabled, oninterrupt, onrestart, onapprove, ondecline, onapproveall, onopen, ondrop, onremove }: Props = $props()
  const running = $derived(kernel.running)
  /**
   * Someone else's work holding the queue — and `null` when there is none.
   *
   * "Someone else's" is either an ordinary notebook cell or an attempt from a
   * NEIGHBOURING council cell. An attempt of our own (`here`) does not get
   * here: the card below draws it, with all the details of the pile.
   */
  const elsewhere = $derived(kernel.book?.busy && !kernel.book.busy.here ? kernel.book.busy : null)
  const busy = $derived(kernelIsBusy(kernel))
  /** Two signals sent, the work still runs: the queue is stuck and will not move. */
  const stuck = $derived(kernel.book?.busy?.stuck === true)
  const startedAt = $derived(running?.run?.startedAt ?? kernel.book?.busy?.startedAt ?? 0)
  const elapsed = $derived(busy ? Math.max(now - startedAt, 0) : 0)
  /**
   * Which limit the running work runs under.
   *
   * For our own attempt it is the cell's rules; for someone else's work it
   * is what came with the kernel frame: a neighbouring council cell has its
   * own rules, an ordinary cell has the room's limit (rules.ts ·
   * cellLimitSec), and both can differ from ours. Showing our limit for
   * someone else's run would mean drawing a bar that guards nothing.
   */
  const limitSec = $derived(elsewhere ? elsewhere.limitSec : settings.runLimitSec)
  const limitMs = $derived(limitSec === null ? null : limitSec * 1000)
  /** Past the limit and still running: SIGINT did not take; from here, by hand only. */
  const overLimit = $derived(limitMs !== null && elapsed >= limitMs)
  const stopped = $derived(timedOutAttempts(attempts))
  const who = (attempt: CouncilAttempt): string => names ? attempt.name : tr('room.pult.v2.queue.anonymous')
  /** A name from the kernel frame — under the same names switch as the pile rows. */
  const whoBusy = (name: string): string => names ? name : tr('room.pult.v2.queue.anonymous')
  const firstLine = (text: string): string => text.split('\n').find((line) => line.trim()) ?? ''

  /**
   * The queue row's menu — and the reason it was introduced.
   *
   * The row had one button, and it was "remove from class". That is, the
   * only thing a teacher could do with someone else's run was to throw out
   * its author: so disproportionate that nobody used it. Now the row is a
   * button that opens the work, and the dangerous action moved under "⋯",
   * next to its proportionate neighbour — "take the run out of the queue".
   *
   * The room's shared menu (components/ui/ContextMenu.svelte), not one of
   * its own: it already handles the keyboard, the window edges and the
   * bottom sheet under a finger, and a second copy of that would diverge
   * from the first.
   */
  let menuAt = $state<{ x: number; y: number } | null>(null)
  let menuFor = $state<CouncilAttempt | null>(null)
  let menuBack: HTMLElement | null = null

  function openMenu(attempt: CouncilAttempt, event: MouseEvent): void {
    event.stopPropagation()
    menuBack = event.currentTarget as HTMLElement
    menuFor = attempt
    menuAt = { x: event.clientX, y: event.clientY }
  }

  const menuItems = $derived<ContextMenuItem[]>(
    menuFor === null
      ? []
      : [
          {
            label: tr('room.pult.v3.queue.drop'),
            icon: 'x',
            // A running one cannot be reached from here: the row has gone into
            // the kernel, and "Interrupt" stops it. The item stays visible and
            // says why — greyed out without a reason reads as breakage.
            disabled: disabled || menuFor.run?.state !== 'queued',
            why: menuFor.run?.state === 'running' ? tr('room.pult.v3.queue.dropRunning') : undefined,
            run: () => menuFor && ondrop(menuFor),
          },
          {
            gap: true,
            label: tr('room.ui.78'),
            icon: 'trash',
            danger: true,
            disabled,
            run: () => {
              const attempt = menuFor
              if (!attempt || !menuBack) return
              // The ban menu opens at the same "⋯" button that was pressed:
              // it needs real coordinates, and the event is gone by now.
              const box = menuBack.getBoundingClientRect()
              onremove(attempt, new MouseEvent('click', { clientX: box.left, clientY: box.bottom }))
            },
          },
        ],
  )
</script>

<div class="queue-view" data-pult-queue>
  <div class="queue-content">
    <header class="queue-heading">
      <div>
        <h2>{tr('room.pult.v2.queue.title')}</h2>
        <!-- The queue belongs to the NOTEBOOK, not the cell, and the caption
             has to say so: otherwise "3 in the queue" reads as three minutes
             of waiting when a dozen other cells stand ahead. -->
        <p>{tr(kernel.book ? 'room.pult.v3.queue.scopeBook' : 'room.pult.v2.queue.scope')}</p>
      </div>
      <p class="queue-counts">
        {#if kernel.book}
          {tr('room.pult.v3.queue.countsBook', { running: busy ? 1 : 0, queued: queuedInBook(kernel) })}
        {:else}
          {tr('room.pult.v2.queue.counts', { running: running ? 1 : 0, queued: kernel.queued.length })}
        {/if}
      </p>
    </header>

    <section class="running-card" class:is-running={busy} class:is-stuck={stuck} aria-label={tr('room.pult.v2.queue.current')}>
      {#if busy}
        <span class="running-icon" aria-hidden="true">▶</span>
        <div class="running-copy">
          <span class="running-label">
            {#if running}
              {tr('room.pult.v2.queue.current')}
            {:else if elsewhere}
              <!--
                Someone else's work is named for what it is: a cell number or a
                neighbouring council cell. This spot used to say "No code is
                running in this cell" — true about the cell and a lie about the
                queue, which left the teacher waiting for who knows what.
              -->
              {elsewhere.kind === 'cell'
                ? (elsewhere.index === null
                    ? tr('room.pult.v3.queue.busyCellPlain')
                    : tr('room.pult.v3.queue.busyCell', { index: elsewhere.index }))
                : (elsewhere.index === null
                    ? tr('room.pult.v3.queue.busyOtherPlain')
                    : tr('room.pult.v3.queue.busyOther', { index: elsewhere.index }))}
            {/if}
          </span>
          <div class="running-author">
            {#if running && names}<Avatar name={running.name} color={running.color} avatar={running.avatar} size="md" />{/if}
            <!-- The run's time with seconds: there can be three in a minute,
                 and "17:24" on all three does not tell them apart. -->
            <strong>{running ? who(running) : whoBusy(elsewhere?.name ?? '')}</strong><span class="running-time">{tr('room.pult.v3.queueRunning', { time: pultClock(startedAt, true), duration: spell(elapsed) })}</span>
          </div>
          {#if elsewhere}
            <p class="running-hold">{tr('room.pult.v3.queue.holds')}</p>
          {/if}
          <!--
            The limit — where it takes effect.
            The bar answers the only question about someone else's run going
            on in front of the whole class: wait for it or interrupt it. It also
            catches the case where waiting is pointless: time is up but the run
            goes on — so the stop did not take, and from here only a hand will
            help.
          -->
          {#if limitMs !== null}
            <div class="running-limit">
              <span class="limit-track" aria-hidden="true">
                <span class="limit-fill" class:over={overLimit} style:width={`${Math.min(100, (elapsed / limitMs) * 100)}%`}></span>
              </span>
              <!-- When the "kernel is not answering" panel stands below, the
                   bar's caption stays silent: it would say the same thing half
                   as long and half as strong, and two warnings about one thing
                   read as two. -->
              {#if !stuck}
                <span class="limit-note" class:over={overLimit}>
                  {overLimit
                    ? tr('room.pult.v2.queue.limitStuck')
                    : tr('room.pult.v2.queue.limitStops', { duration: pultDuration(limitSec!) })}
                </span>
              {/if}
            </div>
          {/if}
          <!--
            The kernel is deaf to the interrupt — and that is said in words, not
            with a bar.

            The server sends two signals and goes quiet: SIGINT into a tight
            loop once a second is a storm of requests to Jupyter without a
            single chance of helping. From that second the notebook's queue is
            dead stuck, and until now nobody found out about it. The cost of a
            restart is named next to the button, not in a confirmation: the
            decision is made before the press.
          -->
          {#if stuck}
            <div class="running-stuck" data-pult-stuck>
              <p class="stuck-title">{tr('room.pult.v3.queue.stuck')}</p>
              <p class="stuck-why">{tr('room.pult.v3.queue.stuckWhy')} {tr('room.pult.v3.queue.restartCost')}</p>
            </div>
          {/if}
        </div>
        <div class="running-actions">
          <!-- The button is there in ANY busy state: it interrupts whatever
               holds the queue now — our attempt, someone else's attempt or a
               cell. It used to live inside our attempt's branch, that is, it
               disappeared exactly when it was needed. -->
          <button type="button" class="pult-button pult-button--danger" {disabled} onclick={oninterrupt}>{tr('room.pult.v2.queue.interrupt')}</button>
          {#if stuck}
            <button type="button" class="pult-button pult-button--danger" {disabled} data-pult-restart
              onclick={onrestart}>{tr('room.pult.v3.queue.restart')}</button>
          {/if}
          <!--
            "Remove from class" left here together with the same button in the
            queue rows: taking a person out of the class and stopping their run
            are things of different weight, and they must not stand side by
            side as identical buttons. Stopping is on the left, and the person
            is removed from the row menu, next to the proportionate "take the
            run out of the queue".
          -->
        </div>
      {:else}
        <span class="running-icon" aria-hidden="true">○</span>
        <p class="idle-copy">{tr(kernel.book ? 'room.pult.v3.queue.idleBook' : 'room.pult.v2.queue.idle')}</p>
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
                <!-- Since when they have been waiting — in words, not only in a
                     tooltip: it decides whom to let in first. -->
                <span class="request-time">{tr('room.pult.v2.queue.waiting', { duration: spell(Math.max(now - attempt.runRequest!.requestedAt, 0)) })} · {tr('room.pult.v3.queueSince', { time: pultClock(attempt.runRequest!.requestedAt) })}</span>
              </div>
              {#if reason}<span class="request-reason pult-meta">{reason}</span>{/if}
              <div class="row-actions">
                <button type="button" class="pult-button pult-button--primary" {disabled} onclick={() => onapprove(attempt)}>{tr('room.pult.v2.queue.allow')}</button>
                <button type="button" class="pult-button" {disabled} onclick={() => ondecline(attempt)}>{tr('room.pult.v2.queue.decline')}</button>
                <!-- "Remove from class" moved under "⋯" by the same argument as
                     in the queue rows: next to "Approve" and "Decline" it read
                     as a third equal answer to the request. -->
                <button type="button" class="pult-icon-button" {disabled} data-menu-button data-pult-more
                  aria-label={tr('room.pult.v3.queue.rowMenu')} onclick={(event) => openMenu(attempt, event)}>
                  <Icon name="more" size={16} />
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="queued-section" aria-label={tr('room.pult.v2.queue.queuedTitle', { count: kernel.queued.length })}>
      <div class="section-heading"><h3>{tr('room.pult.v2.queue.queuedTitle', { count: kernel.queued.length })}</h3></div>
      {#if kernel.queued.length === 0}
        <p class="empty-copy">{tr(kernel.book && queuedInBook(kernel) === 0 ? 'room.pult.v3.queue.noQueuedBook' : 'room.pult.v2.queue.noQueued')}</p>
      {:else}
        <ol class="attempt-list">
          {#each kernel.queued as attempt, at (attempt.participantId)}
            <li class="queued-row">
              <!--
                The row is a button that opens the work.

                Before this someone else's run could not be pressed at all: the
                first lines of code were visible, and the only available action
                was to remove the author from the class. Deciding by three
                lines whom to throw out is disproportionate, and a teacher said
                so plainly in class. Now a press leads to the "Work" tab with
                the cursor on this person, that is, to the full text and
                output.
              -->
              <button type="button" class="queued-open" data-pult-queued-open
                aria-label={tr('room.pult.v3.queue.openRow', { name: who(attempt) })}
                onclick={() => onopen(attempt.participantId)}>
                <span class="queue-position" aria-hidden="true">{String(at + 1).padStart(2, '0')}</span>
                <span class="avatar-slot" aria-hidden="true">
                  {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" />{:else}<span class="anonymous-avatar"></span>{/if}
                </span>
                <span class="queued-copy">
                  <strong class="queued-author">{who(attempt)}</strong>
                  <!-- How long they have been waiting — as a number, not only
                       the time they were queued: "4 in the queue" without
                       movement does not answer whether it is moving at all. -->
                  <span class="pult-meta queued-since">{tr('room.pult.v3.queue.waitingFor', { duration: spell(Math.max(now - attempt.run!.startedAt, 0)) })} · {tr('room.pult.v3.queueSince', { time: pultClock(attempt.run!.startedAt) })}</span>
                </span>
                <code>{firstLine(attempt.text)}</code>
              </button>
              <button type="button" class="pult-icon-button" {disabled} data-menu-button data-pult-more
                aria-label={tr('room.pult.v3.queue.rowMenu')} onclick={(event) => openMenu(attempt, event)}>
                <Icon name="more" size={16} />
              </button>
            </li>
          {/each}
        </ol>
        <p class="queue-order pult-meta">{tr('room.pult.v2.queue.order')}</p>
      {/if}
    </section>

    <!--
      The last section — those the queue left behind.
      They are no longer in the queue, and in the work feed they stand as
      ordinary rows, but the question "why does half the class have no output"
      is asked exactly here, looking at the queue. On the left is the limit
      that fired: it may have changed since, and the number is about THAT
      run, not about today's rule.
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

<!-- The row menu: shared by the whole room, so that the keyboard, the window
     edges and the bottom sheet under a finger are the same here as in the
     file tree. -->
<ContextMenu
  at={menuAt}
  label={tr('room.pult.v3.queue.rowMenu')}
  title={menuFor ? who(menuFor) : null}
  items={menuItems}
  opener={menuBack}
  onclose={() => { menuAt = null; menuFor = null }}
/>

<style>
  .queue-view { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: rgb(var(--ink)); }
  .queue-content { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 28px; }
  .queue-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  h2 { font-size: 24px; line-height: 30px; font-weight: 700; }
  .queue-heading p { margin-top: 6px; color: rgb(var(--muted)); font-size: 14px; line-height: 20px; }
  .queue-counts { flex-shrink: 0; }
  .running-card { display: flex; align-items: center; gap: 16px; margin: 20px 0 24px; padding: 18px 20px; border-left: 4px solid rgb(var(--line)); background: rgb(var(--raised)); }
  .running-card.is-running { border-left-color: rgb(var(--accent)); }
  /* The icon sits at the card's TOP line, not its middle: the card grows with
     the limit bar and the "kernel is not answering" panel, and a centred
     triangle drifted towards them, as if it belonged to them and not to the
     name. */
  .running-icon { flex-shrink: 0; align-self: flex-start; width: 32px; color: rgb(var(--accent-text)); font-size: 26px; line-height: 32px; }
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
  .queued-row { display: flex; align-items: center; gap: 8px; padding: 0; border-top: 1px solid rgb(var(--line)); }
  /* The row button takes the full width except the "⋯" slot: a press beside
     the text is a press on the work too, and there is nowhere to miss. */
  .queued-open { display: flex; flex: 1; align-items: center; gap: 16px; min-width: 0; padding: 12px 0; text-align: left; cursor: pointer; }
  .queued-open:hover { background: rgb(var(--surface)); }
  .queued-copy { display: flex; min-width: 0; flex-direction: column; gap: 4px; width: 210px; flex-shrink: 0; }
  .pult-icon-button { display: flex; flex-shrink: 0; align-items: center; justify-content: center; width: 32px; height: 32px; color: rgb(var(--muted)); }
  .pult-icon-button:hover:not(:disabled) { background: rgb(var(--raised)); color: rgb(var(--ink)); }
  .pult-icon-button:disabled { opacity: .45; }
  .running-hold { margin-top: 6px; color: rgb(var(--muted)); font-size: 13px; line-height: 18px; }
  .running-card.is-stuck { border-left-color: rgb(var(--danger)); }
  .running-stuck { margin-top: 10px; padding: 10px 12px; background: rgb(var(--canvas)); border-left: 3px solid rgb(var(--danger)); }
  .stuck-title { color: rgb(var(--danger)); font-size: 14px; line-height: 20px; font-weight: 700; }
  .stuck-why { margin-top: 2px; color: rgb(var(--muted)); font-size: 13px; line-height: 18px; }
  .queue-position { width: 24px; flex-shrink: 0; color: rgb(var(--muted)); font-size: 15px; font-variant-numeric: tabular-nums; }
  /* The name within its own column: the width is held by `.queued-copy`, with
     the second line showing the waiting time under it. */
  .queued-author { width: 100%; }
  .queued-since { display: block; }
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
  .queued-since { font-variant-numeric: tabular-nums; }
  @media (max-width: 850px) {
    .queue-content { padding: 20px; }
    .pending-row { flex-wrap: wrap; gap: 12px; }
    .attempt-copy { min-width: 180px; }
    .request-reason { max-width: none; flex-basis: 100%; padding-left: 44px; order: 1; }
    .queued-copy { width: 150px; }
  }
  @media (max-width: 540px) {
    .running-card { flex-wrap: wrap; }
    .row-actions { margin-left: 44px; }
    .queued-open { flex-wrap: wrap; gap: 10px; }
    .queued-open code { flex-basis: 100%; margin-left: 34px; }
  }
</style>
