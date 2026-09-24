<script lang="ts">
  /**
   * The oracle about the class: a messenger in which the teacher asks about
   * the task.
   *
   * The tab used to be a one-button screen: "Prepare a summary" — and three
   * paragraphs about the submitted code, laid out across six nameless
   * groups. Neither the groups nor the summary are here any more, and that
   * was the owner's request: he thinks of the class not as piles of
   * identical text but as people — "it works for Anya, it fails for Petya".
   * What remains is one "question → answer" feed, and you can ALWAYS ask:
   * even before anyone has written a single line, the model will read "what
   * kind of task is this anyway and how should they best go about it" from
   * the text of the shared cell.
   *
   * Three things are held on purpose.
   *
   * The input panel does not scroll away. It is outside the scroll area: on
   * a phone and in a 900×650 window the "ask" field has to be at hand, not
   * at the end of a feed that first has to be scrolled.
   *
   * Names in an answer are live. The model calls people by name (or by an
   * `S7` label if names on this Colloq are not sent to it), and a "label →
   * person" dictionary arrives with the answer; here the label turns into a
   * chip that opens the work. The text is parsed by a pure function in
   * lib/council-oracle-answer.ts: a naive substring replacement would eat
   * "Anna" inside "Anna Belova".
   *
   * A refusal stays IN THE FEED. A question that was not answered does not
   * disappear: otherwise there is nothing to repeat, and it is not even
   * possible to understand where it got stuck.
   */
  import { tr } from '@shared/i18n'
  import { MAX_ORACLE_QUESTION, type CouncilAttempt, type CouncilOracle } from '@shared/protocol'
  import { REASONING_EFFORTS, type ReasoningEffort } from '@shared/admin'
  import { oracleState } from '@/lib/council-board'
  import { splitAnswer, type AnswerPiece } from '@/lib/council-oracle-answer'
  import { rememberEffort, rememberedEffort } from '@/lib/oracle-effort'
  import { clock } from '@/lib/history'

  interface Props {
    oracle: CouncilOracle | null
    attempts: readonly CouncilAttempt[]
    submitted: number
    names: boolean
    /**
     * The cell's answer numbers (council-pult.ts · variantNumbers) — the chip
     * label when names are off.
     */
    variants: ReadonlyMap<string, number>
    askWhy: string | null
    /** The question and the reasoning level for it; no level — the instance default. */
    onask: (question: string, effort?: ReasoningEffort) => void
    onstop: () => void
    /** Open this person's work — a press on a chip in the answer. */
    onopen: (participantId: string) => void
  }

  let { oracle, attempts, submitted, names, variants, askWhy, onask, onstop, onopen }: Props =
    $props()

  let draft = $state('')
  let bodyEl = $state<HTMLElement | null>(null)
  let field = $state<HTMLTextAreaElement | null>(null)
  /** `null` means "as on the instance": nothing new goes into the request. */
  let effort = $state<ReasoningEffort | null>(rememberedEffort())

  /**
   * The field's height follows the text, up to four lines (as for the letter
   * to the author, PultReply.svelte). The same way, not `field-sizing:
   * content`: the console is opened in Safari too, which does not have this
   * property yet, and a one-line field would silently hide the end of a
   * long question.
   */
  const MAX_FIELD = 92
  $effect(() => {
    const box = field
    const value = draft
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(Math.max(box.scrollHeight, 22), MAX_FIELD)}px`
    void value
  })

  const view = $derived(oracleState(oracle, submitted))
  const reading = $derived(view === 'reading')
  /*
   * `?? []` and `?? null` on required fields are not over-caution: a frame
   * may have come from a server that does not know the feed yet
   * (`CouncilOracle.answers`), and in that case the tab has to render empty
   * rather than crash.
   */
  const answers = $derived(oracle?.answers ?? [])
  const pending = $derived(oracle?.pending ?? null)
  const evaluated = $derived(
    attempts.filter((one) => one.submittedAt !== null && one.correct !== null).length,
  )
  const writing = $derived(attempts.filter((one) => one.submittedAt === null).length)
  const byId = $derived(new Map(attempts.map((one) => [one.participantId, one] as const)))
  const empty = $derived(answers.length === 0 && pending === null)

  /** Quick questions: two words on the button, a whole sentence goes to the model. */
  const quick = $derived([
    { label: tr('room.pult.v2.oracle.ask.status'), question: tr('room.pult.v2.oracle.ask.qStatus') },
    { label: tr('room.pult.v2.oracle.ask.stuck'), question: tr('room.pult.v2.oracle.ask.qStuck') },
    {
      label: tr('room.pult.v2.oracle.ask.mistakes'),
      question: tr('room.pult.v2.oracle.ask.qMistakes'),
    },
    {
      // The former "Summary of solutions" — now a question like the others,
      // and there is no reason for it to grey out without submissions: going
      // over "what to write next" is useful on drafts too.
      label: tr('room.pult.v2.oracle.ask.review'),
      question: tr('room.pult.v2.oracle.ask.qReview'),
    },
  ])

  const effortLabel: Record<ReasoningEffort, string> = {
    instant: tr('common.reasoningInstant'),
    normal: tr('common.reasoningNormal'),
    deep: tr('common.reasoningDeep'),
  }

  const canSend = $derived(askWhy === null && !reading)
  const sendDisabled = $derived(!canSend || draft.trim().length === 0)

  function ask(question: string): void {
    if (!canSend) return
    const text = question.trim().slice(0, MAX_ORACLE_QUESTION)
    if (!text) return
    onask(text, effort ?? undefined)
  }

  function sendDraft(): void {
    if (sendDisabled) return
    const text = draft.trim()
    draft = ''
    ask(text)
  }

  /** Picking the same level again means "as on the instance": the press clears it. */
  function pickEffort(next: ReasoningEffort): void {
    effort = effort === next ? null : next
    rememberEffort(effort)
  }

  /** Chip label: the name, "Answer N", or the frame's label if the person is gone. */
  function chipText(piece: Extract<AnswerPiece, { kind: 'person' }>): string {
    const attempt = byId.get(piece.participantId)
    if (!attempt) return piece.label
    if (names && attempt.name.trim()) return attempt.name
    const no = variants.get(piece.participantId)
    return no === undefined ? piece.label : tr('room.ui.1255', { p0: no })
  }

  /*
   * The feed always shows the latest: a question goes to the bottom, and the
   * answer arrives there too. A frame later, because the height is computed
   * only after the new piece has been drawn.
   */
  $effect(() => {
    void answers.length
    void pending
    const node = bodyEl
    if (!node) return
    const frame = requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  })
</script>

{#snippet answerText(text: string, people: Record<string, string>)}
  <p class="answer-text">{#each splitAnswer(text, people) as piece, at (at)}{#if piece.kind === 'text'}{piece.text}{:else if byId.has(piece.participantId)}<button
          type="button"
          class="answer-person"
          title={tr('room.pult.v2.oracle.ask.openWork', { who: chipText(piece) })}
          onclick={() => onopen(piece.participantId)}>{chipText(piece)}</button>{:else}{piece.label}{/if}{/each}</p>
{/snippet}

<div class="oracle-view" data-pult-oracle={view}>
  <header class="oracle-bar">
    <span class="oracle-symbol" aria-hidden="true">✦</span>
    <h2>{tr('room.pult.v2.oracle.title')}</h2>
    <dl class="oracle-metrics">
      <div><dt>{tr('room.pult.v2.oracle.submitted')}</dt><dd>{submitted}</dd></div>
      <div><dt>{tr('room.pult.v2.oracle.evaluated')}</dt><dd>{evaluated}</dd></div>
      <div><dt>{tr('room.pult.v2.oracle.drafts', { count: writing })}</dt><dd>{writing}</dd></div>
    </dl>
  </header>

  <div class="oracle-body" bind:this={bodyEl} data-pult-oracle-body>
    {#if oracle?.error}
      <div class="oracle-error" role="alert">
        <strong>{tr('room.pult.v2.oracle.error')}</strong><p>{oracle.error}</p>
      </div>
    {/if}

    {#if empty}
      <section class="oracle-empty">
        <h3>{tr('room.pult.v2.oracle.ask.empty')}</h3>
        <p>{tr('room.pult.v2.oracle.ask.emptyHint')}</p>
      </section>
    {/if}

    {#if answers.length > 0 || pending}
      <section class="thread" aria-label={tr('room.pult.v2.oracle.ask.history')}>
        {#each answers as answer (answer.id)}
          <article class="turn">
            <p class="turn-question" aria-label={tr('room.pult.v2.oracle.ask.question')}>{answer.question}</p>
            <div class="turn-answer" class:turn-failed={!!answer.failed}
              aria-label={tr('room.pult.v2.oracle.ask.answer')}>
              {#if answer.failed}
                <!-- The refusal stands where the answer would have: the
                     question stays in place, and it is clear what to repeat. -->
                <p class="turn-failed-text" role="status">{answer.failed}</p>
                <button type="button" class="pult-button retry"
                  disabled={!canSend} onclick={() => ask(answer.question)}>
                  {tr('room.pult.v2.oracle.retry')}
                </button>
              {:else}
                {@render answerText(answer.text, answer.people)}
                <p class="turn-meta">
                  {tr('room.pult.v2.oracle.ask.answerMeta', {
                    time: clock(answer.askedAt),
                    submitted: answer.basedOn.submitted,
                    drafts: answer.basedOn.drafts,
                  })}
                </p>
              {/if}
            </div>
          </article>
        {/each}
        {#if pending}
          <article class="turn">
            <p class="turn-question">{pending.question}</p>
            <div class="turn-answer" aria-busy="true">
              <p class="loading-label" role="status">✦ {tr('room.pult.v2.oracle.ask.thinking')}</p>
              <div class="skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
            </div>
          </article>
        {/if}
      </section>
    {/if}
  </div>

  <footer class="oracle-ask">
    <div class="quick-row">
      {#each quick as one (one.label)}
        <button type="button" class="pult-button quick-chip" disabled={!canSend}
          onclick={() => ask(one.question)}>{one.label}</button>
      {/each}
    </div>
    <div class="ask-field">
      <textarea class="ask-text" rows="1" maxlength={MAX_ORACLE_QUESTION} bind:this={field}
        aria-label={tr('room.pult.v2.oracle.ask.placeholder')}
        placeholder={tr('room.pult.v2.oracle.ask.placeholder')}
        title={tr('room.pult.v2.oracle.ask.keys')}
        disabled={!canSend} bind:value={draft} data-pult-oracle-ask
        onkeydown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          sendDraft()
        }}
      ></textarea>
      {#if reading}
        <button type="button" class="pult-button pult-button--danger ask-send" onclick={onstop}>
          {tr('room.pult.v2.oracle.stop')}
        </button>
      {:else}
        <button type="button" class="pult-button pult-button--primary ask-send"
          disabled={sendDisabled} onclick={sendDraft}>
          {tr('room.pult.v2.oracle.ask.send')} <span aria-hidden="true">↗</span>
        </button>
      {/if}
    </div>
    <div class="effort-row" data-pult-oracle-effort>
      <span class="effort-title">{tr('common.reasoning')}</span>
      {#each REASONING_EFFORTS as one (one)}
        <button type="button" class="effort-chip" class:effort-on={effort === one}
          aria-pressed={effort === one} onclick={() => pickEffort(one)}>{effortLabel[one]}</button>
      {/each}
    </div>
    <p class="pult-meta ask-note">
      {tr(names ? 'room.pult.v2.oracle.ask.privacy' : 'room.pult.v2.oracle.ask.privacyAnon')}
    </p>
    {#if askWhy}<p class="ask-reason" role="status">{askWhy}</p>{/if}
  </footer>
</div>

<style>
  .oracle-view { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: rgb(var(--ink)); }

  /* The header is one line: the numbers are needed at a glance, not in size. */
  .oracle-bar { display: flex; flex-shrink: 0; align-items: center; flex-wrap: wrap; gap: 8px 16px; padding: 12px var(--pult-pad); border-bottom: 1px solid rgb(var(--line)); }
  .oracle-symbol { color: rgb(var(--accent-text)); font-size: 18px; line-height: 22px; }
  h2 { font-size: 16px; line-height: 22px; font-weight: 700; }
  .oracle-metrics { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin: 0 0 0 auto; }
  .oracle-metrics div { display: flex; align-items: baseline; gap: 5px; }
  dt { order: 1; font-size: 13px; line-height: 18px; color: rgb(var(--muted)); }
  dd { margin: 0; font-size: 15px; line-height: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }

  .oracle-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px var(--pult-pad) 20px; display: flex; flex-direction: column; gap: 16px; }

  .oracle-empty h3 { font-size: 15px; line-height: 20px; font-weight: 700; }
  .oracle-empty p { max-width: 560px; margin-top: 8px; color: rgb(var(--muted)); font-size: 14px; line-height: 21px; }
  .oracle-error { padding: 10px 14px; border-left: 3px solid rgb(var(--danger)); background: rgb(var(--danger) / 0.07); font-size: 14px; line-height: 21px; }
  .oracle-error strong { color: rgb(var(--danger)); }
  .oracle-error p { margin-top: 4px; overflow-wrap: anywhere; }

  /* Feed: the question right and highlighted, the answer left — as in a chat. */
  .thread { display: flex; flex-direction: column; gap: 16px; }
  .turn { display: flex; flex-direction: column; gap: 8px; }
  .turn-question { align-self: flex-end; max-width: min(100%, 560px); padding: 8px 12px; border: 1px solid rgb(var(--accent)); background: rgb(var(--accent) / 0.1); color: rgb(var(--ink)); font-size: 14px; line-height: 21px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn-answer { align-self: flex-start; max-width: min(100%, 640px); padding: 10px 14px; border: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  /* A failed turn is the same turn with a different frame: the question above stays. */
  .turn-failed { border-left: 3px solid rgb(var(--danger)); background: rgb(var(--danger) / 0.05); }
  .turn-failed-text { font-size: 14px; line-height: 21px; overflow-wrap: anywhere; }
  .turn-answer .retry { margin-top: 8px; min-height: 30px; padding: 5px 10px; font-size: 13px; line-height: 18px; }
  .answer-text { font-size: 14px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn-meta { margin-top: 8px; color: rgb(var(--muted)); font-size: 12px; line-height: 17px; }

  /* A person chip is a part of the sentence that is pressed (like .pult-value). */
  .answer-person { display: inline; padding: 0 1px; border: 0; border-bottom: 1px dashed rgb(var(--primary) / 0.5); background: transparent; color: rgb(var(--primary)); font: inherit; font-weight: 700; cursor: pointer; }
  .answer-person:hover { background: rgb(var(--raised)); }

  .loading-label { color: rgb(var(--accent-text)); font-size: 14px; line-height: 20px; font-weight: 700; }
  .skeleton { display: flex; flex-direction: column; gap: 10px; max-width: 520px; padding: 14px 0 4px; }
  .skeleton span { height: 12px; background: rgb(var(--line)); }
  .skeleton span:nth-child(2) { width: 85%; }
  .skeleton span:nth-child(3) { width: 60%; }

  /* The input panel is pinned: it is outside the scroll and always visible. */
  .oracle-ask { display: flex; flex-shrink: 0; flex-direction: column; gap: 8px; padding: 10px var(--pult-pad) 12px; border-top: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  .quick-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .oracle-ask :global(.quick-chip) { min-height: 32px; padding: 5px 10px; font-size: 13px; font-weight: 600; line-height: 18px; }
  .ask-field { display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px; border: 1px solid rgb(var(--line)); background: rgb(var(--canvas)); }
  .ask-field:focus-within { outline: 2px solid rgb(var(--accent) / 0.45); outline-offset: 1px; }
  .ask-text { display: block; flex: 1; min-width: 0; height: 22px; max-height: 92px; overflow-y: auto; resize: none; border: 0; padding: 0; background: transparent; color: rgb(var(--ink)); font: inherit; font-size: 14px; line-height: 22px; outline: none; }
  .ask-text::placeholder { color: rgb(var(--muted)); }
  .oracle-ask :global(.ask-send) { min-height: 36px; padding: 7px 12px; font-size: 14px; line-height: 20px; }

  /* The reasoning level is a small line under the field: rarely chosen, always seen. */
  .effort-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
  .effort-title { color: rgb(var(--muted)); font-size: 12px; line-height: 17px; }
  .effort-chip { min-height: 24px; padding: 2px 8px; border: 1px solid rgb(var(--line)); background: transparent; color: rgb(var(--muted)); font: inherit; font-size: 12px; line-height: 17px; cursor: pointer; }
  .effort-chip:hover { color: rgb(var(--ink)); }
  .effort-on { border-color: rgb(var(--accent)); background: rgb(var(--accent) / 0.12); color: rgb(var(--ink)); font-weight: 700; }

  .ask-note { margin: 0; }
  .ask-reason { color: rgb(var(--warning)); font-size: 13px; line-height: 18px; }

  /* Phone: a finger, not a mouse — touch targets of at least 44 px. */
  @media (max-width: 650px) {
    .oracle-bar { padding: 10px var(--pult-pad); }
    .oracle-metrics { margin-left: 0; width: 100%; }
    .turn-question, .turn-answer { max-width: 100%; }
    /*
     * Quick questions in one row that scrolls sideways. In two rows they took
     * another 50 px from the answer feed where there are few to begin with —
     * the same argument as for the filter chips above the work list
     * (PultFilters).
     */
    .quick-row { flex-wrap: nowrap; overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .quick-row::-webkit-scrollbar { display: none; }
    .oracle-ask :global(.quick-chip) { min-height: 44px; padding: 10px 12px; flex-shrink: 0; white-space: nowrap; }
    .oracle-ask :global(.ask-send) { min-height: 44px; }
    .effort-chip { min-height: 32px; padding: 6px 10px; }
  }
</style>
