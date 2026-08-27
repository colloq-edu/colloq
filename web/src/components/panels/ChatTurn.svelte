<script lang="ts">
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
  import type { ChatSnapshot } from '@shared/notebook'
  import { acceptPatch, findChatEntry, findCell, rejectPatch } from '@shared/notebook'
  import { diffCounts, diffLines } from '@shared/diff'
  import type { AiAction } from '@shared/protocol'
  import { getSessionState } from '@/lib/session.svelte'
  import { watchText } from '@/lib/yreactive.svelte'
  import { diffTokens, loadSyntax, syntax } from '@/lib/syntax.svelte'
  import { cn } from '@/lib/utils'
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
    cellNumber: number | null
    onretry: () => void
    onstop: () => void
  }

  let { entry, avatar, cellNumber, onretry, onstop }: Props = $props()

  const session = getSessionState()
  const mine = $derived(entry.participantId === session.me.id)

  /*
   * The cell this turn is about, watched live.
   *
   * An open proposal is diffed against what the cell says NOW, because that is
   * what accepting would replace. A decided one is diffed against the text the
   * model was given — after accepting, the cell and the patch are the same
   * string and a live diff would show that nothing had happened.
   */
  const cell = $derived(entry.cellId ? (findCell(session.doc, entry.cellId)?.cell ?? null) : null)
  const live = watchText(() => cell)

  const against = $derived(entry.patchState === 'open' ? live.current : (entry.patchBase ?? ''))
  const patchLines = $derived(entry.patch === null ? [] : diffLines(against, entry.patch))
  const patchCounts = $derived(diffCounts(patchLines))
  /*
   * Both sides of the diff, painted by the editor's own rules. A proposal is
   * read to decide whether to accept it, and deciding means seeing that the
   * green line calls a function where the red one indexed a list — which is
   * exactly the distinction colour makes and a wall of one-colour mono does not.
   */
  $effect(() => {
    if (entry.patch !== null) void loadSyntax()
  })
  const patchTokens = $derived(diffTokens(patchLines, against, entry.patch ?? '', syntax()))
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

  /**
   * Whether to say anything about thinking at all.
   *
   * A trace is shown whenever there is one. Without a trace the strip is only
   * worth drawing when the wait was long enough to have been noticed: under two
   * seconds "thought for 1s" is a line of furniture reporting that a computer
   * was fast, and the thread has forty of those in it by the end of a class.
   */
  const NOTICED_MS = 2_000
  const thinking = $derived(
    entry.reasoning.trim().length > 0 || (entry.thoughtMs !== null && entry.thoughtMs >= NOTICED_MS),
  )

  /** "4s", "1m 20s" — the wait as a person would say it, not as milliseconds. */
  function spell(ms: number | null): string {
    if (ms === null) return ''
    const total = Math.round(ms / 1000)
    if (total < 60) return `${total}s`
    return `${Math.floor(total / 60)}m ${total % 60}s`
  }

  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }

  function clock(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
    explain: 'Explain',
    fix: 'Fix',
    debug: 'Debug',
    improve: 'Improve',
    hint: 'Hint',
    edit: 'Rewrite',
  }
  const badge = $derived(BADGE[(entry.action ?? '') as AiAction] ?? null)

  /** Take the notebook to the cell this turn is about. */
  function reveal() {
    if (!entry.cellId) return
    session.selectCell(entry.cellId)
    document
      .querySelector(`[data-cell-id="${entry.cellId}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function decide(accept: boolean) {
    const target = findChatEntry(session.doc, entry.id)
    if (!target) return
    if (accept) acceptPatch(session.doc, target, session.me.name)
    else rejectPatch(session.doc, target, session.me.name)
  }

  const CHIP = 'inline-flex h-4 shrink-0 items-center px-1.5 text-micro font-bold uppercase tracking-caps'
  const GHOST =
    'inline-flex h-[19px] shrink-0 items-center gap-1 border border-line px-1.5 text-2xs font-bold ' +
    'uppercase tracking-caps text-muted transition-colors duration-[var(--speed-quick)] ' +
    'hover:border-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
</script>

<article class="flex animate-fade-up items-stretch border-b border-line-soft">
  <!-- The asker's colour, running the whole height of the turn. -->
  <div class="w-0.5 shrink-0" style="background: {entry.color}" aria-hidden="true"></div>

  <div class="flex min-w-0 flex-1 flex-col items-stretch gap-3 py-3.5 pl-3.5 pr-4">
    <header class="flex items-center gap-1.5">
      <Avatar size="xs" name={entry.name} color={entry.color} {avatar} />
      <span class="min-w-0 shrink truncate text-2xs font-bold leading-tight text-ink">
        {entry.name}
      </span>
      {#if mine}
        <span class="shrink-0 text-2xs text-faint">you</span>
      {/if}
      {#if badge}
        <span class={cn(CHIP, 'bg-raised text-muted')}>{badge}</span>
      {/if}
      {#if cellNumber !== null}
        <!-- A link, not a label: the notebook is usually somewhere else by now. -->
        <button
          type="button"
          class={cn(
            CHIP,
            'border border-line font-mono normal-case tracking-normal text-muted',
            'transition-colors duration-[var(--speed-quick)] hover:border-faint hover:text-ink',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          )}
          title="Go to cell {pad(cellNumber)}"
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
      <p class="whitespace-pre-wrap break-words bg-raised px-2.5 py-2 text-ui font-semibold text-ink">
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
              <span class="font-semibold text-accent-text">thinking</span>
            {:else}
              <span>thought for {spell(entry.thoughtMs)}</span>
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
              <span class="font-semibold text-accent-text">thinking…</span>
            {:else}
              thought for {spell(entry.thoughtMs)}
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
          <div class="max-h-44 overflow-y-auto border-l border-line pl-2.5">
            <Markdown class="prose-trace" source={trace} />
          </div>
        {/if}
      </div>
    {/if}

    {#if entry.state === 'error'}
      <div class="flex flex-col items-start gap-2 border-l-2 border-danger bg-danger/[0.06] px-2.5 py-2">
        <!-- Verbatim: a limit and the minutes until the next question are known
             only to the server, and a paraphrase leaves the student guessing. -->
        <p class="break-words text-code text-danger">
          {entry.answer || 'The oracle did not answer.'}
        </p>
        <button
          type="button"
          class="inline-flex h-[22px] items-center gap-1.5 border border-danger/45 px-1.5 text-2xs
                 font-bold uppercase tracking-caps text-danger transition-colors
                 duration-[var(--speed-quick)] hover:bg-danger/15 focus-visible:outline-none
                 focus-visible:ring-2 focus-visible:ring-danger/40"
          onclick={onretry}
        >
          <Icon name="restart" size={11} />
          Retry
        </button>
      </div>
    {:else if entry.answer}
      <AnswerBody source={entry.answer} {streaming} cellId={entry.cellId} omit={entry.patch} />
    {:else if streaming && !thinking}
      <div class="flex items-center gap-1.5 text-2xs text-muted">
        <Icon name="spinner" size={13} class="animate-spin" />
        thinking
      </div>
    {/if}

    {#if streaming}
      <button type="button" class={cn(GHOST, 'self-start')} onclick={onstop}>
        <Icon name="stop" size={10} />
        Stop
      </button>
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
            {applied ? 'Applied' : 'Proposed'}{cellNumber === null ? '' : ` for ${pad(cellNumber)}`}
          </span>
          {#if stale}
            <div class="flex-1"></div>
            <span class="shrink-0 text-2xs text-warning">the cell moved</span>
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
        <div class="overflow-x-auto py-0">
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
            <span class="min-w-0 truncate text-muted">
              accepted by {entry.patchBy ?? 'someone'}
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
              <p class="text-2xs text-warning">
                Written against text the cell no longer holds — somebody edited it while the oracle
                was answering.
              </p>
            {/if}
            <div class="flex flex-wrap items-center gap-2">
              <!--
                When the ground has moved the primary button changes hands. The
                reflex press after five accepts is the filled one, and the
                reflex must land on the safe outcome.
              -->
              {#if stale}
                <button type="button" class="btn-primary h-7" onclick={() => decide(false)}>
                  Discard
                </button>
                <button type="button" class="btn-outline h-7" onclick={() => decide(true)}>
                  Apply anyway
                </button>
              {:else}
                <button type="button" class="btn-primary h-7" onclick={() => decide(true)}>
                  Accept
                </button>
                <button type="button" class="btn-outline h-7" onclick={() => decide(false)}>
                  Discard
                </button>
                <div class="flex-1"></div>
                <span class="shrink-0 text-2xs text-muted">for everyone, as you</span>
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
          <span class="min-w-0 truncate">discarded by {entry.patchBy ?? 'someone'}</span>
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
