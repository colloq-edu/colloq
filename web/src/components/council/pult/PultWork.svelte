<script lang="ts">
  import { tr } from '@shared/i18n'
  import Avatar from '@/components/ui/Avatar.svelte'
  import { councilLetters, type CouncilAttempt } from '@shared/protocol'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'
  import Code from '@/components/ui/Code.svelte'
  import {
    attemptExecution,
    attemptFiles,
    attemptFootnote,
    attemptReview,
    kernelAhead,
    pultClock,
    pultDuration,
    pultIdle,
    pultRanFor,
    timedOutLimit,
    type PultPresence,
    type PultRule,
  } from '@/lib/council-pult'
  import { getSessionState } from '@/lib/session.svelte'
  import { takeAttemptFile } from '@/lib/council-files'
  import PultActions from './PultActions.svelte'
  import PultLetters from './PultLetters.svelte'
  import PultReply from './PultReply.svelte'

  /**
   * The open work — three zones, and exactly one scrolls.
   *
   * [author header] · [code and output] · [communication dock]
   *
   * This is how it has been built since the 19 Sep 2026 class. Before, the
   * panel was one column with the code scrolling inside the panel's scroll,
   * and in a 900×650 window everything that gets used — letters, the reply
   * field, four actions — lay below the fold: "like, you have to scroll
   * somewhere for something, there is no fixed area for communication".
   *
   * The dock is pinned to the bottom and always visible: the correspondence
   * with the author, the letter line and the row of actions. Only the middle
   * scrolls — code and output — and inside it there are no nested scrolls:
   * long code is shown as its first forty lines with a "show all" button,
   * not as a 240 px window where you hunt for something to drag.
   */
  interface Props {
    attempt: CouncilAttempt | null
    presence: PultPresence
    /**
     * The work's place in the visible list: "1 of 13". Counted by the current
     * tab and filter.
     */
    index: number
    total: number
    /** The header's pager: the same move as j / k and the arrows. */
    onstep: (delta: 1 | -1) => void
    variant: number
    names: boolean
    now: number
    onScreen: boolean
    shownAt: number | null
    disabled: boolean
    /** The run limit from the cell's rules; `null` — no limit. */
    limit: number | null
    /** A narrow window: the author's name stands in the work screen's top bar. */
    phone: boolean
    onrules: (rule: PultRule, from: HTMLElement) => void
    reply: string
    /** The reply field holds an oracle draft. */
    replyFromOracle: boolean
    onshow: () => void
    onclear: () => void
    onrun: () => void
    oninterrupt: () => void
    onmark: (correct: boolean) => void
    onreplychange: (text: string) => void
    onreplysend: () => void
    onreplyfocus: () => void
    onreplyblur: () => void
    /** Remove the author from the class — the shared ban menu confirms it. */
    onremove: (attempt: CouncilAttempt, event: MouseEvent) => void
    /**
     * The room's line numbers (shared/rules.ts · lineNumbers): the teacher
     * reads the attempt by the same numbers the author and the class see,
     * and "line 7" means one line to all of them.
     */
    lineNumbers?: boolean
    /**
     * The council cell of the work, as the window has it: a pool's attempt
     * is stopped by its cell and author, the cell's kernel frame carries its
     * pool, and its files are taken by the cell.
     */
    cellId: string
  }

  let {
    attempt,
    presence,
    index,
    total,
    onstep,
    variant,
    names,
    now,
    onScreen,
    shownAt,
    disabled,
    limit,
    phone,
    onrules,
    reply,
    replyFromOracle,
    onshow,
    onclear,
    onrun,
    oninterrupt,
    onmark,
    onreplychange,
    onreplysend,
    onreplyfocus,
    onreplyblur,
    onremove,
    cellId,
    lineNumbers = false,
  }: Props = $props()

  const writing = $derived(attempt !== null && attempt.submittedAt === null)
  const run = $derived(attempt?.run ?? null)
  const letters = $derived(councilLetters(attempt))
  const lines = $derived(attempt ? attempt.text.split('\n').length : 0)
  const review = $derived(attempt ? attemptReview(attempt) : null)
  const execution = $derived(attempt ? attemptExecution(attempt) : null)
  /** The limit that cut off THIS run: the rules may have changed since. */
  const stoppedAt = $derived(attempt ? timedOutLimit(attempt) : null)

  /*
   * WHERE IT COMPUTED (docs/architecture/remote-classes.md §9.8, Paper 18 ·
   * Z9). In a class whose council is on machines an attempt runs on one of
   * the pool's workers, on a snapshot of the notebook's kernel, or in the
   * shared kernel for a reason the server names; the run line gets a second
   * line that says which, and its files come under the output. The same
   * footnote stands on the author's sheet (CellView), only in its own place.
   */
  const footnote = $derived(attemptFootnote(run))
  const files = $derived(attemptFiles(run))
  const session = getSessionState()
  /** The class's pool for this cell's notebook, from its kernel frame (`CouncilKernel.pool`). */
  const pool = $derived(session.council.kernels[cellId]?.pool ?? null)
  /**
   * "The kernel has run 3 cells since the snapshot — …" (§9.8, Z8): the
   * notebook kernel's state is past the snapshot this attempt saw, so "Put
   * in cell and run" may print something else than its card. Said where the
   * console knows the count (council-pult.ts · kernelAhead).
   */
  const ahead = $derived(kernelAhead(run, pool))

  /**
   * A pool's attempt is stopped on its own worker, by name: a stop that
   * names the cell alone goes to the notebook's kernel (protocol.ts ·
   * interrupt) — the teacher's cell computing there, never this attempt.
   */
  function stop(): void {
    if (attempt && run?.placed === 'pool') {
      if (!disabled) session.send({ t: 'interrupt', cellId, participantId: attempt.participantId })
      return
    }
    oninterrupt()
  }

  /**
   * "Take the run out of the queue" (control.ts · council:run:drop, which
   * looks in the pool's queue too). The queue tab lists the notebook's queue
   * alone (council-pult.ts · kernelView), so an attempt waiting for one of
   * the pool's workers is taken off from its work.
   */
  function dropRun(): void {
    if (disabled || !attempt || run?.state !== 'queued') return
    session.council.dropRun(cellId, attempt.participantId)
  }

  /** "Put in cell and run" beside the warning, for the work on the class's screen: the server adopts nothing else. */
  function adoptRun(): void {
    if (disabled || !attempt || !onScreen) return
    session.council.adopt(cellId, attempt.participantId, true)
  }

  /** One of the attempt's files, kept here: the browser takes it (lib/council-files.ts · takeAttemptFile). */
  let fileError = $state<string | null>(null)
  async function take(name: string): Promise<void> {
    if (!attempt) return
    fileError = await takeAttemptFile(session.session.id, session.token, cellId, attempt.participantId, name)
  }

  /**
   * Long code — as its first forty lines.
   *
   * A 240 px slab with its own scroll was a nested scroll inside the panel's
   * scroll: the wheel over the code moved the code, over the output the
   * panel, and hitting the right one was a matter of luck. Forty lines are
   * the whole code of almost any attempt; the rest need one button, and it
   * unfolds the code in full into the same feed, without a second
   * scrollbar.
   *
   * The room's line numbers are sized for the whole attempt from the start:
   * Code gets the full count, so unfolding does not move the code a digit to
   * the right.
   */
  const CODE_LINES = 40
  let openCode = $state<string | null>(null)
  const allCode = $derived(attempt !== null && openCode === attempt.participantId)
  const long = $derived(lines > CODE_LINES)
  const shownCode = $derived(
    attempt === null || allCode || !long
      ? (attempt?.text ?? '')
      : attempt.text.split('\n').slice(0, CODE_LINES).join('\n'),
  )

  /**
   * Who ran it: the author's notebook says "run by you"; here the teacher is
   * the one looking.
   */
  const ranBy = $derived(run === null ? '' : run.by === 'host' ? tr('room.ui.61') : tr('room.pult.v2.ranByAuthor'))

  /**
   * The run line: what happened, how long it ran, when and by whose hand.
   *
   * Seconds in the run's time are a request from the class: when there are
   * three runs in a minute, "17:24" on all three does not tell them apart,
   * and they are used to match the output on screen with what was pressed.
   */
  const runLine = $derived.by(() => {
    if (!execution) return ''
    if (run === null) return execution.label
    const parts = [execution.label]
    if (run.ranMs !== null) parts.push(pultRanFor(run.ranMs))
    parts.push(tr('room.pult.v3.ranAt', { time: pultClock(run.startedAt, true) }))
    parts.push(ranBy)
    return parts.join(' · ')
  })

  /**
   * One quiet line under the name instead of three mismatched pieces in a
   * row.
   *
   * The row used to hold: a filled "SUBMITTED 15:19" badge, bare "offline"
   * text, the grade badge and "2 / 13" — four different weights, four
   * different meanings and the word "submitted" said twice (in the badge and
   * in the grade "Submitted · awaiting review"). Now there are three roles:
   * WHO (the avatar with a dot, the name, this line), WHAT IS UP WITH THE
   * WORK (one badge, four values) and WHERE I AM IN THE PILE (the pager).
   *
   * Grammatical gender is never derived from a name anywhere in the product,
   * so the Russian here says an impersonal "submitted at 15:19" rather than
   * a gendered form: the impersonal form is right for everyone and does not
   * require knowing about the person what they have not said.
   *
   * "offline SINCE 15:24" is NOT here and cannot be. Presence arrives at the
   * console as a live Yjs set (session.peersById) — a snapshot of "who is
   * here now", without a single departure time. `participants.last_seen`
   * lives in the server's database and does not go to the client,
   * `presence.left` is an activity log entry, also on the server. There is
   * nothing to invent a departure hour from, and an invented hour in a line
   * used to decide "should I wait for an answer" is worse than an empty
   * spot.
   */
  const headLine = $derived.by(() => {
    if (!attempt) return ''
    const parts: string[] = []
    if (attempt.submittedAt !== null) {
      parts.push(tr('room.pult.v3.head.submitted', { time: pultClock(attempt.submittedAt) }))
    } else {
      const idle = Math.max(now - attempt.updatedAt, 0)
      parts.push(
        idle < 60_000
          ? tr('room.pult.v3.head.editedNow')
          : tr('room.pult.v3.head.edited', { duration: pultIdle(idle / 1000) }),
      )
    }
    if (presence !== 'unknown') {
      parts.push(tr(presence === 'online' ? 'room.pult.online' : 'room.pult.offline'))
    }
    return parts.join(' · ')
  })

  /**
   * "Remove from class" — in the "⋯" menu, not as a button in the most
   * visible spot.
   *
   * A red frame stood next to the name and was bigger than anything else in
   * the header: the most destructive action in the window, used once a
   * semester, took up that spot and sat next to "Correct", which is pressed
   * two hundred times per class. The confirmation (the shared ban menu) is
   * unchanged.
   */
  let menuOpen = $state(false)
  let menu = $state<HTMLElement | null>(null)
  $effect(() => {
    if (!menuOpen) return
    const away = (event: MouseEvent): void => {
      if (menu && !menu.contains(event.target as Node)) menuOpen = false
    }
    // capture: the menu closes before the press reaches whatever is under it.
    window.addEventListener('mousedown', away, true)
    return () => window.removeEventListener('mousedown', away, true)
  })
</script>

{#if !attempt}
  <div class="work-empty"><p>{tr('room.ui.1363')}</p></div>
{:else}
  <div class="work" data-pult-work={attempt.participantId}>
    <header class="work-header">
      <!-- Who: the avatar with a presence dot, the name and one quiet line under it. -->
      <span class="pult-face work-avatar" data-presence={presence} aria-hidden="true">
        <span class="work-avatar-face" style:background-color={names ? attempt.color : 'rgb(var(--line))'}>
          {#if names}
            <Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="xs" emojiPx={20} class="!h-full !w-full" />
          {/if}
        </span>
        <span class="pult-face-dot"></span>
      </span>
      <div class="work-id">
        {#if !phone}
          <h2 class="work-name">{names ? attempt.name : tr('room.ui.1255', { p0: variant })}</h2>
        {/if}
        <p class="work-sub" data-pult-headline>{headLine}</p>
      </div>
      <!--
        What is up with the work — ONE badge and exactly four values:
        "Awaiting review" (filled with the accent — the only one that needs a
        hand), "Correct", "Needs revision", "Draft". The former two
        ("SUBMITTED 15:19" and the grade) merge into it: they said the same
        thing, and "submitted" was said twice.
      -->
      <span class="pult-badge work-state" data-tone={review?.tone} data-shape={review?.shape} data-pult-state
        title={tr('room.pult.v3.head.state')}><span class="pult-badge-dot" aria-hidden="true"></span>{review?.label}</span>
      <!--
        Where I am in the pile. It used to be a "2 / 13" caption that could
        not be pressed — even though moving to the neighbouring work is the
        most frequent move in the window. The buttons go by the same `step` as
        the j / k keys and the arrows, that is, through the current tab and
        the current filter; at the edges they grey out.
      -->
      {#if !phone}
        <div class="work-pager" role="group" aria-label={tr('room.pult.v3.head.place')}>
          <button type="button" class="work-page" data-pult-prev aria-label={tr('room.pult.v3.prevWork')}
            disabled={index <= 1} onclick={() => onstep(-1)}><span aria-hidden="true">‹</span></button>
          <span class="work-page-count">{tr('room.pult.v3.head.pager', { index, total })}</span>
          <button type="button" class="work-page" data-pult-next aria-label={tr('room.pult.v3.nextWork')}
            disabled={index >= total} onclick={() => onstep(1)}><span aria-hidden="true">›</span></button>
        </div>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions (Escape closes the menu; the trigger and the item are buttons.) -->
      <div class="work-menu" bind:this={menu} onkeydown={(event) => {
        if (event.key !== 'Escape' || !menuOpen) return
        // The key does not reach the window: an open menu takes Escape for
        // itself, otherwise it would also close the search while the menu
        // stayed hanging.
        event.stopPropagation()
        menuOpen = false
        menu?.querySelector<HTMLButtonElement>('.work-more')?.focus()
      }}>
        <button type="button" class="work-more" aria-haspopup="menu" aria-expanded={menuOpen}
          aria-label={tr('room.pult.v3.more')} onclick={() => (menuOpen = !menuOpen)}><span aria-hidden="true">⋯</span></button>
        {#if menuOpen}
          <div class="work-menu-sheet" role="menu">
            <!-- A waiting run off the queue, the person and their text untouched: the queue row's own item, here because a run waiting for the pool's worker is in no row of the queue tab. -->
            {#if run?.state === 'queued'}
              <button type="button" role="menuitem" class="work-drop" disabled={disabled}
                data-pult-drop onclick={() => { menuOpen = false; dropRun() }}>{tr('room.pult.v3.queue.drop')}</button>
            {/if}
            <button type="button" role="menuitem" class="work-remove" disabled={disabled}
              data-pult-remove onclick={(event) => { menuOpen = false; onremove(attempt, event) }}>{tr('room.ui.78')}</button>
          </div>
        {/if}
      </div>
    </header>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The only scrollable zone needs keyboard access.) -->
    <div class="work-content" data-pult-work-scroll tabindex="0" role="region" aria-label={tr('room.pult.v2.workCode')}>
      <section class="work-code" aria-label={tr('room.pult.v2.workCode')}>
        <div class="work-section-meta pult-meta">
          <span>{tr('room.pult.v2.workCode')}</span>
        </div>
        <div class="work-code-surface">
          <div class="work-code-scroll">
            <Code code={shownCode} class="pult-solution-code" {lineNumbers} lineCount={lines} />
          </div>
          {#if long && !allCode}
            <button type="button" class="pult-button work-code-all" data-pult-code-all
              onclick={() => (openCode = attempt.participantId)}>{tr('room.pult.v3.codeAll', { count: lines })}</button>
          {/if}
        </div>
      </section>

      <section class="work-execution" data-tone={execution?.tone} aria-label={tr('room.pult.v2.workExecution')}>
        <!--
          A run stopped by the limit is explained here in full, not with the
          word "error". Next to it is the limit in force: it gets changed at
          exactly this second, while looking at someone's code that did not
          finish, and going to a tab for it would mean losing sight of the
          work.
        -->
        <div class="work-execution-head">
          <span class="work-execution-title" role="status">
            {#if stoppedAt !== null}
              {tr('room.pult.v2.rules.workTimedOut', { duration: pultDuration(stoppedAt) })}
              {#if run}{' · '}{tr('room.pult.v3.ranAt', { time: pultClock(run.startedAt, true) })}{' · '}{ranBy}{/if}
            {:else}
              {runLine}
            {/if}
          </span>
          {#if stoppedAt !== null && limit !== null}
            <button type="button" class="pult-value" onclick={(event) => onrules('runLimit', event.currentTarget)}>
              {tr('room.pult.v2.rules.limitLink', { duration: pultDuration(limit) })}
            </button>
          {/if}
        </div>
        {#if footnote}
          <!--
            The run line's second line (Z9): where and on what state it
            computed. Short here, the server's whole sentence in its hover —
            and, for what needs attention, on a phone, which has no hover.
          -->
          <p class="work-footnote" data-tone={footnote.tone} title={footnote.full} data-pult-footnote>
            {#if run?.placed === 'pool'}
              <!-- A pool's worker: a cell of the grid, filled. -->
              <svg class="work-footnote-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1.5" y="1.5" width="4" height="4" fill="none" stroke="currentColor" stroke-width="1.2" />
                <rect x="6.5" y="1.5" width="4" height="4" fill="none" stroke="currentColor" stroke-width="1.2" />
                <rect x="1.5" y="6.5" width="4" height="4" fill="none" stroke="currentColor" stroke-width="1.2" />
                <rect x="6.5" y="6.5" width="4" height="4" fill="currentColor" />
              </svg>
            {/if}
            <span class="work-footnote-short">{footnote.short}</span>
            {#if footnote.tone === 'warning'}<span class="work-footnote-full">{footnote.full}</span>{/if}
          </p>
        {/if}
        {#if run}
          {#if run.outputs.length > 0}
            <!--
              The output stands right under the code and has no scroll of its
              own: vertically it moves with the code in the panel's only
              scroll. The sideways scroll stays — a wide table could not be
              read at all otherwise.
            -->
            <div class="work-output">
              <CellOutputs outputs={run.outputs} />
            </div>
          {:else if run.outputsOmitted}
            <p class="pult-meta">{tr('room.pult.v2.workLoadingOutput')}</p>
          {/if}
        {/if}
        {#if files}
          <!--
            What the attempt wrote into its own folder (§9.7): not in the
            class's files — here, on its card. One still on its way from the
            machine is drawn as such, dashed; those left behind are counted,
            their names in the hover.
          -->
          <div class="work-files" data-pult-files>
            <span class="work-files-label">{tr('room.council.pool.files')}</span>
            {#each files.brought as file (file.name)}
              {#if file.sha256}
                <!-- Here: the teacher takes it, as the author does from their sheet. -->
                <button type="button" class="work-file work-file-take" data-pult-file-take={file.name}
                  title={tr('room.council.pool.take', { name: file.name })} onclick={() => void take(file.name)}
                ><span class="work-file-name">{file.name}</span><span class="work-file-size">{file.size}</span><span class="work-file-arrow" aria-hidden="true">↓</span></button>
              {:else}
                <span class="work-file" data-coming={file.coming ? 'yes' : null}><span class="work-file-name">{file.name}</span><span class="work-file-size">{file.size}</span>{#if file.coming}<span class="work-file-coming">{tr('room.council.pool.coming')}</span>{/if}</span>
              {/if}
            {/each}
            {#if files.dropped}<span class="work-files-dropped" title={files.droppedNames}>{files.dropped}</span>{/if}
            {#if fileError}<span class="work-files-error" role="alert">{fileError}</span>{/if}
          </div>
        {/if}
      </section>
    </div>

    <!--
      The communication dock: what the window is open next to the notebook
      for. Letters, the reply line and four actions — always on screen,
      whatever is going on above.
    -->
    <div class="work-dock" data-pult-dock>
      <PultLetters {letters} />
      <PultReply text={reply} fromOracle={replyFromOracle} {disabled}
        onchange={onreplychange} onsend={onreplysend}
        onfocus={onreplyfocus} onblur={onreplyblur} />
      {#if ahead !== null}
        <!--
          Before "Put in cell and run" (Z8): the cell would compute on the
          notebook kernel's state, which is past this attempt's snapshot. The
          button stands here only for the work on the class's screen — the
          only one the server puts in the cell.
        -->
        <div class="work-ahead" role="status" data-pult-ahead>
          <span class="work-ahead-words">{tr('server.theKernelHasRunCellsSinceThe.e29733', { count: ahead })}</span>
          {#if onScreen}
            <button type="button" class="pult-button work-ahead-run" {disabled} onclick={adoptRun}>{tr('room.council.adoptRun')}</button>
          {/if}
        </div>
      {/if}
      <PultActions {onScreen} running={run?.state === 'running'} queued={run?.state === 'queued'}
        elapsed={run ? Math.max(now - run.startedAt, 0) : 0}
        inFrame={shownAt === null ? 0 : Math.max(now - shownAt, 0)} ran={run !== null}
        correct={attempt.correct} {writing} {disabled}
        {onshow} {onclear} {onrun} oninterrupt={stop} {onmark} />
    </div>
  </div>
{/if}

<style>
  .work { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; background: rgb(var(--canvas)); }
  .work-empty { display: grid; flex: 1; place-items: center; padding: 32px; text-align: center; font-size: 16px; color: rgb(var(--muted)); }
  /*
   * The author header — three roles in one line: who · what is up with the
   * work · where I am in the pile.
   *
   * The proportions are taken from the mockup (Paper 05d, artboard 11:
   * avatar 44, name 20/26, caption 13/18, badge and pager 30 each, gap 14)
   * and reduced by a step: a 900×650 window is a legitimate console size,
   * and in it every extra header line is a line of code gone below the
   * fold. In a large window the mockup's sizes come back in full, below.
   */
  .work-header { display: flex; align-items: center; flex-shrink: 0; flex-wrap: nowrap; gap: 12px; min-height: 62px; padding: 9px 16px; border-bottom: 1px solid rgb(var(--line)); }
  .work-avatar { --face-dot: 12px; width: 38px; height: 38px; }
  .work-avatar-face { display: block; width: 100%; height: 100%; overflow: hidden; border-radius: 50%; }
  /* Name and caption are one column: about one person, they move together. */
  .work-id { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
  .work-name { min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 18px; line-height: 23px; font-weight: 700; }
  .work-sub { min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--muted)); font-size: 13px; line-height: 17px; }
  .work-state { flex-shrink: 0; min-height: 28px; padding: 4px 10px; white-space: nowrap; font-size: 13px; }
  /* The pager as one box: three targets in a shared frame read as one instrument. */
  .work-pager { display: flex; align-items: center; flex-shrink: 0; height: 28px; border: 1px solid rgb(var(--line)); }
  .work-page { display: flex; align-items: center; justify-content: center; width: 28px; align-self: stretch; color: rgb(var(--ink)); font-size: 15px; line-height: 1; cursor: pointer; }
  .work-page:first-child { border-right: 1px solid rgb(var(--line)); }
  .work-page:last-child { border-left: 1px solid rgb(var(--line)); }
  .work-page:hover:not(:disabled) { background: rgb(var(--raised)); }
  .work-page:disabled { color: rgb(var(--faint)); opacity: .5; cursor: default; }
  .work-page-count { padding: 0 9px; color: rgb(var(--ink)); font-size: 13px; line-height: 18px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .work-menu { position: relative; flex-shrink: 0; }
  .work-more { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid transparent; color: rgb(var(--muted)); font-size: 18px; line-height: 1; cursor: pointer; }
  .work-more:hover { border-color: rgb(var(--line)); color: rgb(var(--ink)); }
  .work-menu-sheet { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 200px; padding: 4px; border: 1px solid rgb(var(--line)); background: rgb(var(--canvas)); box-shadow: 0 12px 32px rgb(0 0 0 / .28); }
  .work-remove { display: block; width: 100%; padding: 10px 12px; text-align: left; color: rgb(var(--danger)); font-size: 14px; line-height: 20px; cursor: pointer; }
  .work-remove:hover:not(:disabled) { background: rgb(var(--danger) / .1); }
  .work-remove:disabled { opacity: .48; cursor: default; }
  .work-drop { display: block; width: 100%; padding: 10px 12px; text-align: left; color: rgb(var(--ink)); font-size: 14px; line-height: 20px; cursor: pointer; }
  .work-drop:hover:not(:disabled) { background: rgb(var(--raised)); }
  .work-drop:disabled { opacity: .48; cursor: default; }
  /* The proportionate item first, the person's removal after a rule (the queue row's menu has the same gap). */
  .work-drop + .work-remove { margin-top: 4px; border-top: 1px solid rgb(var(--line)); }
  /* The panel's only scroll. There is no second one over the code or the output. */
  .work-content { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 10px 16px 14px; display: flex; flex-direction: column; gap: 12px; }
  .work-content > * { flex-shrink: 0; }
  .work-content:focus-visible { outline: 2px solid rgb(var(--accent-text)); outline-offset: -2px; }
  .work-section-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; margin-bottom: 6px; }
  .work-code-surface { padding: 10px 12px; background: rgb(var(--surface)); }
  .work-code-scroll { overflow-x: auto; }
  .work-code-scroll :global(.pult-solution-code) { font-size: 13px; line-height: 20px; }
  .work-code-scroll :global(.pult-solution-code > span) { min-height: 20px; }
  .work-code-all { margin-top: 8px; }
  .work-execution { --run-tone: var(--muted); border-left: 3px solid rgb(var(--run-tone)); padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; background: rgb(var(--run-tone) / 0.08); }
  .work-execution[data-tone='positive'] { --run-tone: var(--positive); }
  .work-execution[data-tone='warning'] { --run-tone: var(--warning); }
  .work-execution[data-tone='danger'] { --run-tone: var(--danger); }
  .work-execution[data-tone='accent'] { --run-tone: var(--accent-text); }
  .work-execution-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  .work-execution-title { min-width: 0; color: rgb(var(--run-tone)); font-size: 13px; line-height: 19px; font-weight: 600; }
  .work-output { overflow-x: auto; }
  /*
   * Where it computed (Paper 18 · Z9): the run line's second line, 12/16 and
   * quiet; amber only for what needs attention. The whole sentence is the
   * hover's here and the line's own on a phone (below).
   */
  .work-footnote { display: flex; align-items: center; gap: 6px; margin: 0; color: rgb(var(--muted)); font-size: 12px; line-height: 16px; }
  .work-footnote[data-tone='warning'] { color: rgb(var(--warning)); }
  .work-footnote-icon { flex-shrink: 0; }
  .work-footnote-full { display: none; }
  .work-files { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 4px; font-size: 12px; line-height: 16px; }
  .work-files-label, .work-files-dropped { color: rgb(var(--muted)); }
  .work-file { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 0 8px; border: 1px solid rgb(var(--line)); background: rgb(var(--canvas)); }
  .work-file-name { color: rgb(var(--ink)); font-family: var(--font-mono); }
  .work-file-size { color: rgb(var(--muted)); font-family: var(--font-mono); font-size: 11px; line-height: 14px; }
  /* Here, to take: the same chip, pressable, its arrow in the accent. */
  .work-file-take { cursor: pointer; }
  .work-file-take:hover { background: rgb(var(--raised)); }
  .work-file-arrow { color: rgb(var(--accent-text)); font-size: 12px; line-height: 14px; }
  .work-files-error { color: rgb(var(--danger)); }
  /* On its way: the same chip, dashed and quiet, until it lands. */
  .work-file[data-coming] { border-style: dashed; background: transparent; }
  .work-file[data-coming] .work-file-name { color: rgb(var(--muted)); }
  .work-file-coming { color: rgb(var(--muted)); font-size: 11px; line-height: 14px; }
  /* Before "Put in cell and run" (Z8): amber, the button framed in its tone. */
  .work-ahead { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid rgb(var(--warning) / .35); background: rgb(var(--warning) / .08); }
  .work-ahead-words { flex: 1; min-width: 0; color: rgb(var(--ink)); font-size: 13px; line-height: 18px; }
  .work-ahead .work-ahead-run { min-height: 32px; padding: 4px 10px; border-color: rgb(var(--warning)); color: rgb(var(--warning)); font-size: 13px; }
  .work-output :global(.output-stream), .work-output :global(.text-code) { font-size: 13px; line-height: 20px; }
  .work-output :global(button) { min-height: 36px; font-size: 13px; }
  .work-dock { display: flex; flex-shrink: 0; flex-direction: column; gap: 8px; padding: 8px 16px 10px; border-top: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  /* A large window: the same three zones, only roomier. */
  @media (min-width: 1200px) and (min-height: 800px) {
    /* The mockup's full sizes: with room enough, there is no need to be cramped. */
    .work-header { min-height: 72px; padding: 12px 20px; gap: 14px; }
    .work-avatar { --face-dot: 14px; width: 44px; height: 44px; }
    .work-name { font-size: 20px; line-height: 26px; }
    .work-state, .work-pager { height: 30px; min-height: 30px; }
    .work-page { width: 30px; }
    .work-content { padding: 14px 20px 18px; gap: 14px; }
    .work-dock { gap: 10px; padding: 10px 20px 12px; }
  }
  @media (max-width: 900px) {
    .work-header { gap: 10px; padding-inline: 12px; }
    .work-content { padding-inline: 12px; }
    .work-dock { padding-inline: 12px; }
  }
  /* The pair to the under-480 px window (PultWindow · .pult-work-pane): the
     panel is a page again there, and the work gets a height at which the
     dock is not crushed. */
  @media (max-height: 479px) {
    .work { min-height: 420px; flex-shrink: 0; }
    .work-content { min-height: 120px; }
  }
  /*
   * Phone: the avatar with a dot, the state line, the badge — and that is
   * all.
   *
   * The name stands in the work screen's bar (PultWindow · .phone-bar), and
   * a second name in a row at 390 px is a line taken away from the code.
   * There is no pager here either: the feed is walked with that bar's
   * arrows, and the way back to the list is a gesture.
   */
  @media (max-width: 650px) {
    .work-header { min-height: 48px; gap: 10px; padding: 6px 12px; }
    .work-avatar { --face-dot: 11px; width: 32px; height: 32px; }
    .work-dock { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
    .work-more { width: 40px; height: 40px; }
    /* A phone has no hover: what needs attention reads whole (Z10), the rest stays short. */
    .work-footnote { align-items: flex-start; font-size: 13px; line-height: 18px; }
    .work-footnote-icon { margin-top: 3px; }
    .work-footnote[data-tone='warning'] .work-footnote-short { display: none; }
    .work-footnote[data-tone='warning'] .work-footnote-full { display: inline; }
    .work-file { min-height: 36px; padding: 0 10px; font-size: 13px; }
    .work-ahead { flex-wrap: wrap; }
    .work-ahead .work-ahead-run { min-height: 40px; }
  }
</style>
