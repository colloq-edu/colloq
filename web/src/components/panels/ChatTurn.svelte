<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  /**
   * One exchange in the room's thread: a question, and what came back.
   *
   * The turn — not the message — is the unit here, and that is the difference
   * between this panel and a chat window. In Cursor a conversation belongs to
   * one person and the two halves can drift apart down the page; in a seminar
   * twenty people ask into one thread, and a question separated from its answer
   * is a question somebody will answer again ten minutes later. So the pair is
   * one block, and the block carries the asker's colour down its left edge:
   * scrolled back through half an hour of a class, the header has gone but the
   * spine has not.
   *
   * Everything the turn can say about itself is laid out in the same order every
   * time — who and when, what was asked, how long it thought, what it said, what
   * it proposed, what the room decided — because a log whose rows are shaped
   * differently is a log you have to read rather than scan.
   */
  import type { AgentStep, ChatSnapshot } from '@shared/notebook'
  import { cellLock, findChatEntry, rootOfCell } from '@shared/notebook'
  import { diffCounts, diffLines } from '@shared/diff'
  import type { AiAction, ParticipantRole } from '@shared/protocol'
  import { actsAfterClass, CLASS_IS_OVER } from '@shared/rules'
  import { askToBan, mayBan } from '@/lib/bans'
  import { getSessionState } from '@/lib/session.svelte'
  import { watchCell, watchText } from '@/lib/yreactive.svelte'
  import { diffTokens, loadSyntax, syntax } from '@/lib/syntax.svelte'
  import { revealCell } from '@/lib/reveal'
  import { COUNCIL_SHARED_CELL, LECTURE_CELL, mayEditThisCell, permitsIn } from '@/lib/may'
  import { copyText } from '@/lib/clipboard'
  import { cn, NOTICED_MS, spell } from '@/lib/utils'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Markdown from '@/components/notebook/Markdown.svelte'
  import Code from '@/components/ui/Code.svelte'
  import CodeLine from '@/components/ui/CodeLine.svelte'
  import AnswerBody from './AnswerBody.svelte'

  interface Props {
    entry: ChatSnapshot
    /** The emoji this person chose, when they are still in the room. */
    avatar: string | null
    /** 1-based position of the cell asked about, or null when it is gone. */
    /** Number of the cell the turn is tied to: the proposal goes there. */
    cellNumber: number | null
    /**
     * Numbers of the cells that were asked about.
     *
     * Separate from `cellNumber`: one can ask about several but propose an edit
     * to only one. Empty for turns recorded before several cells could be
     * selected.
     */
    askedAbout: number[]
    /**
     * Whether a "do" turn can be started in this room: the `agent` rule plus
     * the oracle mode. Computed by the panel — only the panel knows the
     * instance mode.
     */
    canDo: boolean
    /**
     * The role of the entry's author — from the room's presence, computed by
     * the panel.
     *
     * Not by searching `session.peers` here: the presence array is rebuilt on
     * every remote cursor, and a search in every turn turned a neighbour's move
     * between cells into a pass over the whole feed. Someone who has left the
     * room is not in presence — they count as a participant, and that is the
     * same as before.
     */
    authorRole: ParticipantRole
    /**
     * Whether to play the entrance.
     *
     * False for exactly one entry — the one that took the place of the promise
     * row from ask-outbox: their keys differ, Svelte removes one node and
     * mounts another, and without this the same question in the same place
     * appeared a second time. The entrance is for what is new, not for what was
     * already on screen.
     */
    enter?: boolean
    /**
     * The question is being sent to the server: there is no entry in the
     * document yet.
     *
     * The row is drawn by this tab so that the question appears in the feed
     * right after Enter (see `outbox` in AiPanel). It looks like the real
     * thing — that is the whole idea — but there is nothing to stop: the server
     * does not have this turn yet, and "Stop" would knock on a name nobody
     * knows.
     */
    pending?: boolean
    onretry: () => void
    onstop: () => void
    /** Undo the whole turn: the files return to what they were before it. */
    onundo: () => void
  }

  let {
    entry,
    avatar,
    authorRole,
    enter = true,
    cellNumber,
    askedAbout,
    canDo,
    pending = false,
    onretry,
    onstop,
    onundo,
  }: Props = $props()

  /** What a step's row says: the verb, the target and the result. */
  const VERB: Record<string, string> = {
    get read() { return tr('room.ui.568') },
    get write() { return tr('room.ui.569') },
    get new() { return tr('room.ui.570') },
    get run() { return tr('room.ui.571') },
    get note() { return tr('room.ui.572') },
  }
  const STEP_ICON: Record<string, 'search' | 'pencil' | 'file-plus' | 'play' | 'alert'> = {
    read: 'search',
    write: 'pencil',
    new: 'file-plus',
    run: 'play',
    note: 'alert',
  }

  const session = getSessionState()
  const mine = $derived(entry.participantId === session.me.id)

  /**
   * Whether the entry's author can be removed from class from here.
   *
   * The author's role is not stored in the entry — the panel brings it, having
   * computed it once for the whole feed (see `authorRole` in the props).
   * Someone who has left the room is not in presence and counts as a
   * participant: banning someone who has already left is routine (the feed
   * survives the departure), and the server will not ban staff in any case, and
   * its refusal will arrive in words in the same window.
   */
  const banHere = $derived(!mine && mayBan(session.me.role, authorRole))

  /*
   * The cell this turn is about, watched live.
   *
   * An open proposal is diffed against what the cell says NOW, because that is
   * what accepting would replace. A decided one is diffed against the text the
   * model was given — after accepting, the cell and the patch are the same
   * string and a live diff would show that nothing had happened.
   */
  /*
   * Through the cell registry, not by searching in `$derived`.
   *
   * `findCell` in a derived value depended only on `entry`, and the document
   * did not wake it. Moving a cell on the server recreates it as a clone
   * (Y.Array cannot move), the old Y.Map is deleted — and `watchText` kept
   * looking at the corpse, returning an empty string: an open proposal started
   * being diffed against emptiness, turned into a warning and lied "somebody
   * edited it", although nobody had edited anything. `watchCell` watches
   * precisely for the recreation and returns the live map.
   */
  const watched = watchCell(session.doc, () => entry.cellId ?? '')
  const cell = $derived(entry.cellId ? watched.current : null)
  const live = watchText(() => cell)

  const against = $derived(entry.patchState === 'open' ? live.current : (entry.patchBase ?? ''))
  const patchLines = $derived(entry.patch === null ? [] : diffLines(against, entry.patch))
  const patchCounts = $derived(diffCounts(patchLines))
  /*
   * Both sides of the diff, painted by the editor's own rules. A proposal is
   * read to decide whether to accept it, and deciding means seeing that the
   * green line calls a function where the red one indexed a list — which is
   * exactly the distinction colour makes and a wall of one-colour mono does not.
   *
   * Only for code cells: a text cell's proposal holds prose, and Python
   * colouring would highlight the word for in the middle of a sentence.
   */
  const patchIsCode = $derived(cell === null || cell.get('type') !== 'markdown')
  $effect(() => {
    if (entry.patch !== null && patchIsCode) void loadSyntax()
  })
  const patchTokens = $derived(
    diffTokens(patchLines, against, entry.patch ?? '', patchIsCode ? syntax() : null),
  )
  /*
   * Somebody edited the cell while the model was writing. The proposal is not
   * hidden and not applied quietly: it says what it was written against and
   * hands the primary button to the refusal, so the reflex press is the safe one.
   */
  const stale = $derived(
    entry.patchState === 'open' && entry.patchBase !== null && live.current !== entry.patchBase,
  )

  /** A rejected proposal opens on request; nobody re-reads code that never happened. */
  let showRejected = $state(false)
  /** The trace is folded away by default — see the note on the strip below. */
  let showThinking = $state(false)

  const streaming = $derived(entry.state === 'streaming')

  /* -------------------------------------------------------- turn stopwatch */

  /**
   * A task is under way: only a task has a feed of steps and a live line under
   * it.
   *
   * The promise row from ask-outbox does not get here: the server does not have
   * this turn yet, there will be no steps, and the stopwatch would be counting
   * the request's trip, not the work.
   */
  const working = $derived(streaming && !pending && entry.mode === 'agent')

  /**
   * How long to wait in silence before saying it out loud.
   *
   * A task ran for thirteen minutes, and the panel showed a motionless spinner
   * and "preparing the next step": there was nothing to tell work from a hang
   * by. Two minutes without a new step is no longer "about to finish": that is
   * how long a request to the model that will not come back is held open.
   */
  const STALLED_MS = 120_000

  /**
   * The live line's clock: ticks once a second, and only while the turn is
   * running.
   *
   * Once a second, not five times as with the cell stopwatch: here the number
   * is read not as "is it moving" but as "how long already" — tenths in it only
   * flicker. The derived `working` removes the timer by itself when the turn is
   * over.
   */
  let now = $state(Date.now())
  $effect(() => {
    if (!working) return
    now = Date.now()
    const timer = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(timer)
  })

  /**
   * When the step was recorded.
   *
   * The field appeared later than the feed itself: turns recorded before it
   * have no time at all — and then the line shows nothing, rather than "+0 s"
   * on every step.
   */
  function stepAt(step: AgentStep): number | null {
    return typeof step.at === 'number' && Number.isFinite(step.at) ? step.at : null
  }

  /**
   * "+2 min 10 s" — from the start of the turn, not from the previous step.
   *
   * From the start, because the feed is read as a whole: the column shows at
   * once that the first six steps fit into a minute, while the seventh has been
   * standing for eleven. The difference between neighbouring rows can be
   * subtracted from these same numbers by eye; the other way round it cannot.
   */
  function since(step: AgentStep): string {
    const at = stepAt(step)
    if (at === null) return ''
    const delta = at - entry.createdAt
    // Under a second is noise: the first steps come in a row, and "+0 s" would
    // stand next to each of them.
    if (delta < 1000) return ''
    return tr('room.oracle.stepAt', { p0: spell(delta) })
  }

  /** Live number's origin: the last recorded step, or the turn's start. */
  const lastAt = $derived.by(() => {
    for (let index = entry.steps.length - 1; index >= 0; index -= 1) {
      const at = stepAt(entry.steps[index])
      if (at !== null) return at
    }
    return entry.createdAt
  })
  const waited = $derived(Math.max(0, now - lastAt))
  const stalled = $derived(waited >= STALLED_MS)

  /**
   * Whether to say anything about thinking at all.
   *
   * A trace is shown whenever there is one. Without a trace the strip is only
   * worth drawing when the wait was long enough to have been noticed: under two
   * seconds "thought for 1s" is a line of furniture reporting that a computer
   * was fast, and the thread has forty of those in it by the end of a class.
   */
  const thinking = $derived(
    entry.reasoning.trim().length > 0 || (entry.thoughtMs !== null && entry.thoughtMs >= NOTICED_MS),
  )

  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }

  function clock(ts: number): string {
    return new Date(ts).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
  }

  /**
   * The action, as a word rather than a slug.
   *
   * `ask` gets no badge: a plain question is what the panel is for, and a chip
   * on every second turn saying so is a chip that stops being read. `edit` is
   * called REWRITE here because that is what the room sees happen to the cell —
   * "edit" is the name of the request, "rewrite" is the name of the result.
   */
  const BADGE: Partial<Record<AiAction, string>> = {
    get explain() { return tr('room.ui.573') },
    get fix() { return tr('room.ui.574') },
    get debug() { return tr('room.ui.575') },
    get improve() { return tr('room.ui.576') },
    get hint() { return tr('room.ui.577') },
    get edit() { return tr('room.ui.578') },
  }
  const badge = $derived(BADGE[(entry.action ?? '') as AiAction] ?? null)

  /** Take the notebook to the cell this turn is about. */
  function reveal() {
    if (entry.cellId) revealCell(session, entry.cellId)
  }

  /*
   * The server decides, not this tab.
   *
   * The "proposal still open" check inside a transaction saved us from two
   * presses here and did not save us from two browsers: each read `'open'` in
   * its own copy, each wrote, and Yjs conscientiously merged both edits — the
   * cell got the patch twice. The server has one copy, and it processes
   * messages in turn.
   */
  /*
   * And by the rules of the NOTEBOOK the turn's cell lives in: "Apply" is an
   * edit, and an edit asks the notebook (shared/rules.ts · rulesForBook). One's
   * own personal notebook accepts a proposal even in a lecture; someone else's
   * does not accept it even in an open room — exactly what the server answers
   * too (control.ts · ai:decide).
   */
  const may = $derived(
    permitsIn(session.session.rules, session.me.role, session.finished, {
      root: entry.cellId ? rootOfCell(session.doc, entry.cellId) : null,
      participantId: session.me.id,
    }),
  )
  /**
   * "Apply" asks the CELL, not only the room rule.
   *
   * The `edit` rule is about the room as a whole, and in an open room it allows
   * a participant everything. The lock and the council narrow that: a locked
   * cell is edited by the teacher, and a shared council cell is the assignment,
   * and rewriting it for oneself would mean rewriting it for the whole class. A
   * proposal could also have arrived BEFORE the lock clicked shut: the feed
   * survives a mode change, and a button on an old entry has to reckon with the
   * new state of affairs.
   *
   * The server refuses with exactly this (control.ts · ai:decide), and a button
   * that lies before it is pressed is worse than no button.
   */
  const cellLockHere = $derived(cell ? cellLock(cell) : 'closed')
  const mayApply = $derived(
    mayEditThisCell(may, cellLockHere === 'open') &&
      (cellLockHere !== 'council' || session.me.role === 'host'),
  )
  const applyWhy = $derived(
    cellLockHere === 'council' && session.me.role !== 'host'
      ? tr(COUNCIL_SHARED_CELL)
      : may.edit
        ? tr(LECTURE_CELL)
        : may.editWhy,
  )

  /** The proposal can be copied even by those who cannot apply it. */
  let copied = $state(false)
  let copyTimer: number | undefined
  async function copyPatch(): Promise<void> {
    if (entry.patch === null) return
    try {
      await copyText(entry.patch)
      copied = true
      window.clearTimeout(copyTimer)
      copyTimer = window.setTimeout(() => (copied = false), NOTICED_MS)
    } catch {
      // A browser that refused the clipboard leaves the text selectable — as in
      // AnswerBody: staying silent here is more honest than scolding its
      // settings.
    }
  }
  $effect(() => () => window.clearTimeout(copyTimer))
  /*
   * Undo a turn — wherever one can start it, plus the teacher always: that is
   * exactly how the server reads it (control.ts, case 'ai:undo').
   */
  const mayUndo = $derived(session.me.role === 'host' || may.agent)
  /*
   * Whether this person acts after the bell.
   *
   * For what has no rule at all: asking again, rejecting a proposal. The same
   * `actsAfterClass` that the server answers with — a second permission
   * mechanism must not be introduced here. "Stop" has left this list: it has
   * its own rule, and the bell changes nothing in it — see below.
   */
  const acts = $derived(actsAfterClass(may.finished, session.me.role))
  /*
   * "Stop" — on one's own entry, always; on someone else's — only for the
   * teacher.
   *
   * Not after the bell but in general: cutting off someone else's answer means
   * erasing work the person is waiting for, and cutting off someone else's
   * agent turn means abandoning an edit of files halfway. The teacher really
   * needs it for others' entries: a runaway answer hangs on the projector in
   * front of the whole room. That is exactly how the server reads it
   * (routes/ai.ts, /ai/cancel) — a second set of rules must not be introduced
   * here.
   */
  const mayStop = $derived(!pending && (mine || session.me.role === 'host'))

  function decide(accept: boolean) {
    if (!findChatEntry(session.doc, entry.id)) return
    session.send({ t: 'ai:decide', entryId: entry.id, accept })
  }

  const CHIP = 'inline-flex min-h-5 shrink-0 items-center px-1.5 py-0.5 text-micro font-bold uppercase tracking-caps'
  const GHOST =
    'inline-flex min-h-6 shrink-0 items-center gap-1 border border-line px-1.5 py-0.5 text-2xs font-bold ' +
    'uppercase tracking-caps text-muted transition-colors duration-[var(--speed-quick)] ' +
    'hover:border-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
</script>

<!--
  "Stop" — one per turn, in two places of the markup: for a task it stands in
  the live line (people want to stop it exactly when they are looking at the
  counter), for a question — under the answer. A snippet, not two copies: the
  button has its own permission rule and its own refusal hint, and they would
  drift apart at the very first edit.
-->
{#snippet stopButton(extra: string)}
  <button
    type="button"
    class={cn(GHOST, extra, 'disabled:cursor-not-allowed disabled:opacity-40')}
    disabled={!mayStop}
    title={mayStop ? '' : pending ? tr('room.extra.242') : tr('room.extra.243')}
    onclick={onstop}
  >
    <Icon name="stop" size={10} /> {tr('room.ui.13')} </button>
{/snippet}

<article class={cn('flex items-stretch border-b border-line-soft', enter && 'animate-fade-up')}>
  <!-- The asker's colour, running the whole height of the turn. -->
  <div class="w-0.5 shrink-0" style="background: {entry.color}" aria-hidden="true"></div>

  <div class="flex min-w-0 flex-1 flex-col items-stretch gap-3 py-3.5 pl-3.5 pr-4">
    <header class="flex items-center gap-1.5">
      <!--
        The mark and the name are a way into the same menu as the right click in
        the people list. Here it is looked for sooner: spam is seen in the feed,
        not in the rail, and the person being removed is the one the teacher is
        reading at that moment.

        svelte:element, not two branches of markup: the mark and the name stand
        right next to each other and would drift apart at the very first
        indentation edit.
      -->
      <svelte:element
        this={banHere ? 'button' : 'span'}
        role={banHere ? 'button' : undefined}
        type={banHere ? 'button' : undefined}
        title={banHere ? tr('room.extra.232', { p0: entry.name }) : undefined}
        onclick={banHere
          ? (event: MouseEvent) =>
              askToBan({
                id: entry.participantId,
                name: entry.name,
                color: entry.color,
                avatar,
                x: event.clientX,
                y: event.clientY,
              })
          : undefined}
        class={cn(
          'flex min-w-0 shrink items-center gap-1.5',
          banHere &&
            'transition-colors duration-[var(--speed-quick)] hover:text-accent-text ' +
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        )}
      >
        <Avatar size="xs" name={entry.name} color={entry.color} {avatar} />
        <span class="min-w-0 shrink truncate text-2xs font-bold leading-tight text-ink">
          {entry.name}
        </span>
      </svelte:element>
      {#if mine}
        <span class="shrink-0 text-2xs text-faint">{tr('room.ui.544')}</span>
      {/if}
      {#if badge}
        <span class={cn(CHIP, 'bg-raised text-muted')}>{badge}</span>
      {/if}
      {#if askedAbout.length > 0}
        <!--
          A link, not a caption: by this time the notebook has usually moved on.
          It leads to the FIRST of the named cells — the one the conversation
          started with; the others are named next to it, so that it is visible
          what the talk was about at all.
        -->
        <button
          type="button"
          class={cn(
            CHIP,
            'border border-line font-mono normal-case tracking-normal text-muted',
            'transition-colors duration-[var(--speed-quick)] hover:border-faint hover:text-ink',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          )}
          title={askedAbout.length === 1
            ? tr('room.extra.238', { p0: pad(askedAbout[0]) })
            : tr('room.extra.239', { p0: askedAbout.map(pad).join(', ') })}
          onclick={reveal}
        >
          {askedAbout.map(pad).join(' · ')}
        </button>
      {:else if cellNumber !== null}
        <button
          type="button"
          class={cn(
            CHIP,
            'border border-line font-mono normal-case tracking-normal text-muted',
            'transition-colors duration-[var(--speed-quick)] hover:border-faint hover:text-ink',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          )}
          title={tr('room.extra.238', { p0: pad(cellNumber) })}
          onclick={reveal}
        >
          {pad(cellNumber)}
        </button>
      {/if}
      <div class="flex-1"></div>
      <time
        class="shrink-0 font-mono text-2xs tabular-nums text-faint"
        datetime={new Date(entry.createdAt).toISOString()}
      >
        {clock(entry.createdAt)}
      </time>
    </header>

    <!--
      The question, on its own ground. Questions are what a thread is scanned
      for — "has somebody already asked this?" — and answers are what it is read
      for, so the two are set differently: the question denser and banded, the
      answer open prose on the panel itself.
    -->
    {#if entry.question.trim()}
      <!-- `anywhere`, not `break-words`: a question is sometimes a single line
           of a path or an address without a single space, and only `anywhere`
           counts toward the minimum width — that is, the line does not push the
           turn apart but wraps. -->
      <p
        class="whitespace-pre-wrap bg-raised px-2.5 py-2 text-ui font-semibold text-ink
               [overflow-wrap:anywhere]"
      >
        {entry.question}
      </p>
    {/if}

    {#if thinking}
      <!--
        Folded by default, and folded for you alone: which of the room has
        opened the model's trace is nobody's business but theirs, so this is
        local state and not a fact in the document. While the answer is still
        coming it stands open — a trace arriving is the only thing on screen,
        and hiding it would leave a spinner where there is something to read.
      -->
      {@const trace = entry.reasoning.trim()}
      {@const open = showThinking || (streaming && !entry.answer)}
      <div class="flex flex-col items-stretch gap-1.5">
        {#if trace}
          <button
            type="button"
            class="inline-flex min-w-0 items-center gap-1.5 self-start text-2xs text-muted
                   transition-colors duration-[var(--speed-quick)] hover:text-ink
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-expanded={open}
            onclick={() => (showThinking = !open)}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={10} class="shrink-0" />
            {#if streaming && !entry.answer}
              <span class="font-semibold text-accent-text">{tr('room.ui.545')}</span>
            {:else}
              <span>{tr('room.ui.546')} {spell(entry.thoughtMs)}</span>
            {/if}
          </button>
        {:else}
          <!--
            No trace, so no chevron. Most endpoints send none, and a disclosure
            arrow that discloses nothing is worse than the plain sentence: it
            teaches a reader that the arrows in this panel are decoration.
          -->
          <span class="self-start text-2xs text-muted">
            {#if streaming && !entry.answer}
              <span class="font-semibold text-accent-text">{tr('room.ui.547')}</span>
            {:else} {tr('room.ui.546')} {spell(entry.thoughtMs)}
            {/if}
          </span>
        {/if}
        {#if open && trace}
          <!--
            Capped, and scrolls inside itself. A reasoning model writes four
            hundred words to decide where a print() goes, and left to its full
            height it pushed the answer — the thing that was actually asked for
            — off the bottom of a 380px panel.
          -->
          <div class="max-h-44 overflow-y-auto overflow-x-hidden border-l border-line pl-2.5">
            <Markdown class="prose-trace" source={trace} />
          </div>
        {/if}
      </div>
    {/if}

    <!--
      What the oracle did by itself. The feed lives in the document next to the
      answer, not in the server logs: the room must see what exactly happened to
      its files, not read about it in a retelling.
    -->
    {#if entry.steps.length > 0 || working}
      <div class="flex flex-col border border-line bg-canvas">
        {#each entry.steps as step, at (at)}
          <!--
            An unfamiliar kind of step is drawn, not skipped: the server and the
            tab update separately, and a feed that keeps silent about what the
            tab does not know yet lies more than a feed with a bare word from
            the document.
          -->
          <div class="flex flex-col {at > 0 ? 'border-t border-line-soft' : ''}">
            <div class="flex items-center gap-2 px-2.5 py-1.5">
              <Icon
                name={STEP_ICON[step.kind] ?? 'info'}
                size={12}
                class="shrink-0 {step.kind === 'note' ? 'text-warning' : 'text-faint'}"
              />
              <span class="shrink-0 text-2xs text-muted">{VERB[step.kind] ?? step.kind}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-2xs text-ink" title={step.target}>
                {step.target}
              </span>
              {#if step.kind === 'write' || step.kind === 'new'}
                <span class="shrink-0 font-mono text-2xs font-semibold text-positive">
                  +{step.added}
                </span>
                <span class="shrink-0 font-mono text-2xs font-semibold text-danger">
                  −{step.removed}
                </span>
              {:else if step.kind === 'run'}
                <span
                  class="shrink-0 font-mono text-2xs {step.exit === 0
                    ? 'text-positive'
                    : 'text-danger'}"
                > {tr('room.ui.549')} {step.exit ?? '?'}
                </span>
              {:else if step.note}
                <span class="max-w-[45%] shrink-0 truncate text-2xs text-muted" title={step.note}>
                  {step.note}
                </span>
              {/if}
              <!--
                How much time has passed since the start of the turn. Empty for
                entries made before a step started remembering its time.
              -->
              {#if since(step)}
                <span class="shrink-0 font-mono text-2xs tabular-nums text-faint">
                  {since(step)}
                </span>
              {/if}
            </div>
            <!--
              For a run the row is taken by the exit code, and the summary —
              "did not fit into 90 s", the tail of the output — never once fit
              into it: the branch further down the markup was unreachable for
              `run`. It is the one thing that explains code 124.
            -->
            {#if step.kind === 'run' && step.note}
              <p
                class="max-h-16 overflow-y-auto overflow-x-hidden whitespace-pre-wrap px-2.5 pb-1.5
                       text-2xs leading-snug text-muted [overflow-wrap:anywhere]"
              >{step.note}</p>
            {/if}
          </div>
        {/each}
        {#if streaming}
          <!--
            A live line, not a motionless spinner: the step number and a growing
            figure. Thirteen minutes under the caption "preparing the next step"
            look exactly the same as thirteen minutes of a hang.
          -->
          <div
            class="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line-soft px-2.5 py-1.5"
          >
            <Icon name="spinner" size={12} class="shrink-0 animate-spin text-faint" />
            <span
              class={cn('min-w-0 text-2xs tabular-nums', stalled ? 'text-warning' : 'text-muted')}
              role="status"
              aria-live="polite"
            >
              {stalled
                ? tr('room.oracle.stalled', { p0: entry.steps.length + 1, p1: spell(waited) })
                : tr('room.oracle.progress', { p0: entry.steps.length + 1, p1: spell(waited) })}
            </span>
            <div class="flex-1"></div>
            {@render stopButton('')}
          </div>
        {/if}
      </div>
    {/if}

    {#if entry.state === 'error'}
      <div class="flex flex-col items-start gap-2 border-l-2 border-danger bg-danger/[0.06] px-2.5 py-2">
        <!-- Verbatim: a limit and the minutes until the next question are known
             only to the server, and a paraphrase leaves the student guessing. -->
        <p class="text-code text-danger [overflow-wrap:anywhere]">
          {entry.answer || tr('room.ui.551')}
        </p>
        <!-- A retry of a "do" turn is the same turn: where it cannot be
             started, there is nothing to retry either. After the bell there is
             nothing to retry at all: the oracle answers only the teacher
             (routes/ai.ts), and the button would bring back a red refusal line
             under the red error line. -->
        {#if acts && (entry.mode !== 'agent' || canDo)}
          <button
            type="button"
            class="inline-flex h-[22px] items-center gap-1.5 border border-danger/45 px-1.5 text-2xs
                   font-bold uppercase tracking-caps text-danger transition-colors
                   duration-[var(--speed-quick)] hover:bg-danger/15 focus-visible:outline-none
                   focus-visible:ring-2 focus-visible:ring-danger/40"
            onclick={onretry}
          >
            <Icon name="restart" size={11} /> {tr('room.ui.552')} </button>
        {/if}
      </div>
    {:else if entry.answer}
      <AnswerBody source={entry.answer} {streaming} cellId={entry.cellId} omit={entry.patch} />
    {:else if streaming && !thinking && !working}
      <!-- A task does not get "thinking" without a number: right there, under
           the feed of steps, the live line says the same thing and tells how
           long it has been. -->
      <div class="flex items-center gap-1.5 text-2xs text-muted">
        <Icon name="spinner" size={13} class="animate-spin" /> {tr('room.ui.545')} </div>
    {/if}

    {#if streaming && !working}
      <!-- The button stays even on someone else's entry: the entry is running,
           and a "Stop" that silently disappeared would read as "the oracle can
           no longer be stopped". It dims and says why. -->
      {@render stopButton('self-start')}
    {/if}

    <!--
      Undo of the whole turn. One button, because a turn is one decision: taking
      it apart edit by edit would mean asking a person to figure out which of
      four edits is superfluous, in the middle of a class.
    -->
    {#if entry.undo === 'available'}
      <div class="flex flex-col gap-1.5 border-t border-line pt-2">
        <!-- Exactly what is done is promised: the server restores only the
             files nobody touched after the turn, and skips the renamed and
             rewritten ones, naming them in the answer. -->
        <p class="text-2xs leading-snug text-muted"> {tr('room.ui.553')} </p>
        <!-- The turn is undone by whoever is allowed to start it: the server
             refuses everyone else (control.ts), and a button that lies before
             it is pressed is worse than no button. The line above stays — it is
             about what happened, not about what is allowed. -->
        <button
          type="button"
          class={cn(GHOST, 'self-start disabled:cursor-not-allowed disabled:opacity-40')}
          disabled={!mayUndo}
          title={mayUndo ? '' : may.agentWhy}
          onclick={onundo}
        >
          <Icon name="restart" size={11} /> {tr('room.ui.554')} </button>
      </div>
    {:else if entry.undo === 'done'}
      <p class="border-t border-line pt-2 text-2xs text-muted"> {tr('room.ui.555')}{entry.undoBy ? ` — ${entry.undoBy}` : ''}{tr('room.ui.556')} </p>
    {/if}

    {#if entry.patch !== null && entry.patchState !== 'rejected'}
      {@const applied = entry.patchState === 'accepted'}
      <div
        class={cn(
          'flex flex-col items-stretch border bg-canvas',
          applied && 'border-positive/40',
          !applied && (stale ? 'border-warning/40' : 'border-accent/40'),
        )}
      >
        <div
          class={cn(
            'flex h-7 shrink-0 items-center gap-1.5 border-b pl-2 pr-1.5',
            applied && 'border-positive/30 bg-positive/[0.09]',
            !applied && (stale ? 'border-warning/30 bg-warning/[0.09]' : 'border-accent/30 bg-accent/[0.09]'),
          )}
        >
          <span
            class={cn(
              'shrink-0 text-2xs font-bold uppercase tracking-caps',
              applied && 'text-positive',
              !applied && (stale ? 'text-warning' : 'text-accent-text'),
            )}
          >
            {applied ? tr('room.ui.557') : tr('room.ui.558')}{cellNumber === null ? '' : ` · ${pad(cellNumber)}`}
          </span>
          {#if stale}
            <div class="flex-1"></div>
            <span class="shrink-0 text-2xs text-warning">{tr('room.ui.559')}</span>
          {:else}
            {#if patchCounts.added > 0}
              <span class="shrink-0 font-mono text-2xs text-positive">+{patchCounts.added}</span>
            {/if}
            {#if patchCounts.removed > 0}
              <span class="shrink-0 font-mono text-2xs text-danger">−{patchCounts.removed}</span>
            {/if}
            <div class="flex-1"></div>
          {/if}
        </div>

        <!--
          Two boxes, and both are needed. The outer one scrolls; the inner one
          is as wide as the widest line (w-max) but never narrower than the box
          (min-w-full), which is what the rows then fill. With the rows sized
          against the scroll box instead, a line long enough to scroll left its
          neighbours' red and green tints behind at the old edge.
        -->
        <div class="max-w-full overflow-x-auto overscroll-x-contain py-0">
          <div class="w-max min-w-full">
            {#each patchLines as line, index (index)}<span
              class={cn(
                'flex min-h-[20px] items-start',
                line.kind === 'added' && 'bg-positive/10',
                line.kind === 'removed' && 'bg-danger/10',
              )}
              ><span
                class={cn(
                  'w-5 shrink-0 select-none text-center font-mono text-code leading-5',
                  line.kind === 'added' && 'text-positive',
                  line.kind === 'removed' && 'text-danger',
                  line.kind === 'same' && 'text-faint',
                )}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span
              ><span
                class={cn(
                  'whitespace-pre font-mono text-code leading-5',
                  // Unchanged lines are context, not news. Held back rather than
                  // recoloured, so the syntax still reads and the eye still goes
                  // to the two rows that changed.
                  line.kind === 'same' && 'opacity-55',
                )}><CodeLine tokens={patchTokens[index] ?? []} /></span
              ></span
            >{/each}
          </div>
        </div>

        {#if applied}
          <div
            class="flex items-center gap-1.5 border-t border-positive/30 bg-surface px-2 py-2 text-2xs"
          >
            <Icon name="check" size={12} class="shrink-0 text-positive" />
            <span class="min-w-0 truncate text-muted"> {tr('room.ui.560')} {entry.patchBy ?? tr('room.ui.561')}
            </span>
          </div>
        {:else}
          <div
            class={cn(
              'flex flex-col items-stretch gap-2 border-t bg-surface p-2',
              stale ? 'border-warning/30' : 'border-accent/30',
            )}
          >
            {#if stale}
              <p class="text-2xs text-warning"> {tr('room.ui.562')} </p>
            {/if}
            <div class="flex flex-wrap items-center gap-2">
              <!--
                "Copy" stands next to the decisions and is always there.

                The proposal's code is not shown anywhere else: it is omitted
                from the answer (`omit={entry.patch}` on AnswerBody) so as not
                to be read twice — and where it could not be applied, nothing at
                all could be taken away from the panel. Reading it and carrying
                it over by hand into one's own sheet is exactly what a
                participant in a lecture and in a council is left with.
              -->
              <button
                type="button"
                class={cn(GHOST, 'h-7')}
                onclick={() => void copyPatch()}
              >
                <Icon name={copied ? 'check' : 'copy'} size={11} />
                {copied ? tr('room.ui.1268') : tr('room.ui.1267')}
              </button>
              <!--
                When the ground has moved the primary button changes hands. The
                reflex press after five accepts is the filled one, and the
                reflex must land on the safe outcome.
              -->
              {#if stale}
                <button
                  type="button"
                  class="btn-primary h-7"
                  disabled={!acts}
                  title={acts ? '' : tr(CLASS_IS_OVER)}
                  onclick={() => decide(false)}
                > {tr('room.ui.68')} </button>
                <!-- Apply is an edit of the notebook, and the room rule is
                     about that too. Reject stays open to everyone while the
                     class is on: a dismissed pill breaks nothing. After the
                     bell it does: the proposal will disappear for good, and
                     there is no way to ask for it again — the oracle answers
                     only the teacher. -->
                <button
                  type="button"
                  class="btn-outline h-7"
                  disabled={!mayApply}
                  title={mayApply ? '' : applyWhy}
                  onclick={() => decide(true)}
                > {tr('room.ui.563')} </button>
              {:else}
                <button
                  type="button"
                  class="btn-primary h-7"
                  disabled={!mayApply}
                  title={mayApply ? '' : applyWhy}
                  onclick={() => decide(true)}
                > {tr('room.ui.564')} </button>
                <button
                  type="button"
                  class="btn-outline h-7"
                  disabled={!acts}
                  title={acts ? '' : tr(CLASS_IS_OVER)}
                  onclick={() => decide(false)}
                > {tr('room.ui.68')} </button>
                <div class="flex-1"></div>
                <span class="shrink-0 text-2xs text-muted">{tr('room.ui.565')}</span>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {:else if entry.patch !== null}
      <!-- Rejected: one line. Code that never happened is not worth the height,
           and the fact that it was refused, by whom, is the part that is. -->
      <div class="flex flex-col items-stretch gap-1.5 border border-line bg-surface px-2 py-1.5">
        <button
          type="button"
          class="flex min-w-0 items-center gap-1.5 text-2xs text-muted
                 transition-colors duration-[var(--speed-quick)] hover:text-ink
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-expanded={showRejected}
          onclick={() => (showRejected = !showRejected)}
        >
          <Icon name={showRejected ? 'chevron-down' : 'chevron-right'} size={10} class="shrink-0" />
          <span class="min-w-0 truncate">{tr('room.ui.566')} {entry.patchBy ?? tr('room.ui.561')}</span>
          <span class="shrink-0 font-mono text-2xs text-faint">
            +{patchCounts.added} −{patchCounts.removed}
          </span>
        </button>
        {#if showRejected}
          <Code code={entry.patch} class="border-l border-line pl-2.5" />
        {/if}
      </div>
    {/if}
  </div>
</article>
