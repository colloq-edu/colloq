<script lang="ts">
  /**
   * Оракул о классе: сводка по решениям сверху, разговор под ней.
   *
   * Вкладка была экраном одной кнопки: «Подготовить сводку» — и три абзаца про
   * сданный код. На живом семинаре 19.09 выяснилось, чего ей не хватает: пока
   * никто не сдал, она говорила «ждём сданных работ», а именно в эти минуты
   * преподавателю и нужно знать, кто застрял. Теперь это мессенджер: сверху
   * числа, посередине лента «вопрос → ответ», снизу прибитая панель ввода — и
   * спросить можно, как только у кого-то появился лист.
   *
   * Две вещи держатся нарочно.
   *
   * Панель ввода не уезжает. Она вне области прокрутки: на телефоне и в окне
   * 900×650 поле «спросить» должно быть под рукой, а не в конце ленты, которую
   * сперва надо промотать.
   *
   * Метки в ответе — живые. Модель видит людей как `S7` и других имён не знает
   * (server/src/ai/council.ts), а словарь «метка → человек» приезжает вместе с
   * ответом; здесь метка превращается в чип с именем (или «Вариант N», если
   * имена выключены), по которому открывается работа. Разбор текста — чистой
   * функцией в lib/council-oracle-answer.ts: наивная замена подстроки съела бы
   * `S7` внутри `S70`.
   */
  import { tr } from '@shared/i18n'
  import { MAX_ORACLE_QUESTION, type CouncilAttempt, type CouncilOracle } from '@shared/protocol'
  import { oracleState, staleBy } from '@/lib/council-board'
  import { splitAnswer, type AnswerPiece } from '@/lib/council-oracle-answer'
  import { clock } from '@/lib/history'

  interface Props {
    oracle: CouncilOracle | null
    attempts: readonly CouncilAttempt[]
    submitted: number
    names: boolean
    /** Номера вариантов ячейки (council-pult.ts · variantNumbers) — подпись чипа при выключенных именах. */
    variants: ReadonlyMap<string, number>
    askWhy: string | null
    /** Без вопроса — сводка по решениям; с вопросом — разговор о классе. */
    onask: (question?: string) => void
    onstop: () => void
    /** Открыть работу этого человека — нажатие на чип в ответе. */
    onopen: (participantId: string) => void
  }

  let { oracle, attempts, submitted, names, variants, askWhy, onask, onstop, onopen }: Props =
    $props()

  let draft = $state('')
  let bodyEl = $state<HTMLElement | null>(null)
  let field = $state<HTMLTextAreaElement | null>(null)

  /**
   * Высота поля — по тексту, до четырёх строк (как у письма автору,
   * PultReply.svelte). Тем же способом, а не `field-sizing: content`: пульт
   * открывают и в Safari, где этого свойства ещё нет, и поле в одну строку
   * молча прятало бы конец длинного вопроса.
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
  const behind = $derived(oracle ? staleBy(oracle, submitted) : 0)
  /*
   * `?? []` и `?? null` на обязательных полях — не перестраховка: кадр мог
   * приехать от сервера, который ленты ещё не знает (`CouncilOracle.answers`),
   * и вкладка в этом случае обязана нарисоваться пустой, а не упасть.
   */
  const answers = $derived(oracle?.answers ?? [])
  const pending = $derived(oracle?.pending ?? null)
  const evaluated = $derived(
    attempts.filter((one) => one.submittedAt !== null && one.correct !== null).length,
  )
  const writing = $derived(attempts.filter((one) => one.submittedAt === null).length)
  const hasSummary = $derived(oracle?.summary.some((one) => one.trim().length > 0) ?? false)
  const byId = $derived(new Map(attempts.map((one) => [one.participantId, one] as const)))
  const empty = $derived(answers.length === 0 && pending === null && !hasSummary)

  const heads = ['room.pult.v2.oracle.success', 'room.pult.v2.oracle.discuss', 'room.pult.v2.oracle.show']

  /** Быстрые вопросы: на кнопке — два слова, модели уезжает целое предложение. */
  const quick = $derived([
    { label: tr('room.pult.v2.oracle.ask.status'), question: tr('room.pult.v2.oracle.ask.qStatus') },
    { label: tr('room.pult.v2.oracle.ask.stuck'), question: tr('room.pult.v2.oracle.ask.qStuck') },
    {
      label: tr('room.pult.v2.oracle.ask.mistakes'),
      question: tr('room.pult.v2.oracle.ask.qMistakes'),
    },
  ])

  const canSend = $derived(askWhy === null && !reading)
  const sendDisabled = $derived(!canSend || draft.trim().length === 0)

  function ask(question: string): void {
    if (!canSend) return
    const text = question.trim().slice(0, MAX_ORACLE_QUESTION)
    if (!text) return
    onask(text)
  }

  /** Сводка по решениям — тот же маршрут без вопроса; без сдач ей нечего читать. */
  function askSummary(): void {
    if (!canSend || submitted === 0) return
    onask()
  }

  function sendDraft(): void {
    if (sendDisabled) return
    const text = draft.trim()
    draft = ''
    ask(text)
  }

  /** Подпись чипа: имя, «Вариант N» или сама метка, если человека уже нет в стопке. */
  function chipText(piece: Extract<AnswerPiece, { kind: 'person' }>): string {
    const attempt = byId.get(piece.participantId)
    if (!attempt) return piece.label
    if (names && attempt.name.trim()) return attempt.name
    const no = variants.get(piece.participantId)
    return no === undefined ? piece.label : tr('room.ui.1255', { p0: no })
  }

  /*
   * Лента всегда показывает последнее: вопрос уходит вниз, и ответ приезжает
   * туда же. Кадром позже, потому что высота считается уже после отрисовки
   * нового куска.
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

    {#if hasSummary && oracle}
      <section class="summary-card" aria-label={tr('room.pult.v2.oracle.ask.summaryTitle')}>
        <h3 class="summary-title">{tr('room.pult.v2.oracle.ask.summaryTitle')}</h3>
        {#each oracle.summary as paragraph, at (at)}
          {#if paragraph.trim()}
            <section class="summary-section" class:discussion={at === 1}>
              <h4>
                {#if at === 0}<span class="success-mark" aria-hidden="true">✓</span>{/if}
                {tr(heads[at] ?? 'room.pult.v2.oracle.observation')}
              </h4>
              <p>{paragraph}</p>
            </section>
          {/if}
        {/each}
        <p class="summary-meta">
          {tr('room.pult.v2.oracle.basedOn', { count: oracle.basedOn })}{oracle.askedAt === null
            ? ''
            : ` · ${tr('room.pult.v2.oracle.requestedAt', { time: clock(oracle.askedAt) })}`}
        </p>
        {#if behind > 0}
          <p class="stale-message" role="status">{tr('room.pult.v2.oracle.stale', { count: behind })}</p>
        {/if}
      </section>
    {/if}

    {#if empty}
      <section class="oracle-empty">
        <h3>{tr(attempts.length === 0 ? 'room.pult.v2.oracle.ask.noSheets' : 'room.pult.v2.oracle.ask.empty')}</h3>
        <p>{tr(attempts.length === 0 ? 'room.pult.v2.oracle.ask.noSheetsHint' : 'room.pult.v2.oracle.ask.emptyHint')}</p>
      </section>
    {/if}

    {#if answers.length > 0 || pending}
      <section class="thread" aria-label={tr('room.pult.v2.oracle.ask.history')}>
        {#each answers as answer (answer.id)}
          <article class="turn">
            <p class="turn-question" aria-label={tr('room.pult.v2.oracle.ask.question')}>{answer.question}</p>
            <div class="turn-answer" aria-label={tr('room.pult.v2.oracle.ask.answer')}>
              {@render answerText(answer.text, answer.people)}
              <p class="turn-meta">
                {tr('room.pult.v2.oracle.ask.answerMeta', {
                  time: clock(answer.askedAt),
                  submitted: answer.basedOn.submitted,
                  drafts: answer.basedOn.drafts,
                })}
              </p>
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

    {#if reading && !pending}
      <section class="oracle-loading" aria-busy="true" aria-label={tr('room.pult.v2.oracle.reading')}>
        <p class="loading-label" role="status">✦ {tr('room.pult.v2.oracle.reading')}</p>
        <p class="state-copy">{tr('room.pult.v2.oracle.readingScope', { count: oracle?.basedOn ?? submitted })}</p>
        <div class="skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
      </section>
    {/if}
  </div>

  <footer class="oracle-ask">
    <div class="quick-row">
      {#each quick as one (one.label)}
        <button type="button" class="pult-button quick-chip" disabled={!canSend}
          onclick={() => ask(one.question)}>{one.label}</button>
      {/each}
      <button type="button" class="pult-button quick-chip" disabled={!canSend || submitted === 0}
        title={submitted === 0 ? tr('room.pult.v2.oracle.ask.summaryWhy') : undefined}
        onclick={askSummary}>
        <span aria-hidden="true">✦</span> {tr(hasSummary ? 'room.pult.v2.oracle.refresh' : 'room.pult.v2.oracle.ask.summary')}
      </button>
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
    <p class="pult-meta ask-note">
      {tr('room.pult.v2.oracle.ask.privacy')}{names ? '' : ` · ${tr('room.pult.v2.oracle.anonymous')}`}
    </p>
    {#if askWhy}<p class="ask-reason" role="status">{askWhy}</p>{/if}
  </footer>
</div>

<style>
  .oracle-view { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: rgb(var(--ink)); }

  /* Шапка — одна строка: числа нужны глазом, а не размером. */
  .oracle-bar { display: flex; flex-shrink: 0; align-items: center; flex-wrap: wrap; gap: 8px 16px; padding: 12px var(--pult-pad); border-bottom: 1px solid rgb(var(--line)); }
  .oracle-symbol { color: rgb(var(--accent-text)); font-size: 18px; line-height: 22px; }
  h2 { font-size: 16px; line-height: 22px; font-weight: 700; }
  .oracle-metrics { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin: 0 0 0 auto; }
  .oracle-metrics div { display: flex; align-items: baseline; gap: 5px; }
  dt { order: 1; font-size: 13px; line-height: 18px; color: rgb(var(--muted)); }
  dd { margin: 0; font-size: 15px; line-height: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }

  .oracle-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px var(--pult-pad) 20px; display: flex; flex-direction: column; gap: 16px; }

  .summary-card { padding: 14px 16px; border: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  .summary-title { font-size: 13px; line-height: 18px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: rgb(var(--muted)); }
  .summary-section { margin-top: 12px; }
  h4 { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 15px; line-height: 20px; font-weight: 700; }
  .success-mark { color: rgb(var(--positive)); }
  .summary-section p { font-size: 14px; line-height: 21px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .discussion { padding: 10px 12px; border-left: 3px solid rgb(var(--warning)); background: rgb(var(--warning) / 0.08); }
  .discussion h4 { color: rgb(var(--warning)); }
  .summary-meta { margin-top: 12px; color: rgb(var(--muted)); font-size: 13px; line-height: 18px; }
  .stale-message { margin-top: 4px; color: rgb(var(--warning)); font-size: 13px; line-height: 18px; }

  .oracle-empty h3 { font-size: 15px; line-height: 20px; font-weight: 700; }
  .oracle-empty p { max-width: 560px; margin-top: 8px; color: rgb(var(--muted)); font-size: 14px; line-height: 21px; }
  .oracle-error { padding: 10px 14px; border-left: 3px solid rgb(var(--danger)); background: rgb(var(--danger) / 0.07); font-size: 14px; line-height: 21px; }
  .oracle-error strong { color: rgb(var(--danger)); }
  .oracle-error p { margin-top: 4px; overflow-wrap: anywhere; }

  /* Лента: вопрос справа и выделен, ответ слева — как в переписке. */
  .thread { display: flex; flex-direction: column; gap: 16px; }
  .turn { display: flex; flex-direction: column; gap: 8px; }
  .turn-question { align-self: flex-end; max-width: min(100%, 560px); padding: 8px 12px; border: 1px solid rgb(var(--accent)); background: rgb(var(--accent) / 0.1); color: rgb(var(--ink)); font-size: 14px; line-height: 21px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn-answer { align-self: flex-start; max-width: min(100%, 640px); padding: 10px 14px; border: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  .answer-text { font-size: 14px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn-meta { margin-top: 8px; color: rgb(var(--muted)); font-size: 12px; line-height: 17px; }

  /* Чип человека — часть предложения, по которой нажимают (как .pult-value). */
  .answer-person { display: inline; padding: 0 1px; border: 0; border-bottom: 1px dashed rgb(var(--primary) / 0.5); background: transparent; color: rgb(var(--primary)); font: inherit; font-weight: 700; cursor: pointer; }
  .answer-person:hover { background: rgb(var(--raised)); }

  .loading-label { color: rgb(var(--accent-text)); font-size: 14px; line-height: 20px; font-weight: 700; }
  .state-copy { margin-top: 8px; color: rgb(var(--muted)); font-size: 14px; line-height: 21px; }
  .skeleton { display: flex; flex-direction: column; gap: 10px; max-width: 520px; padding: 14px 0 4px; }
  .skeleton span { height: 12px; background: rgb(var(--line)); }
  .skeleton span:nth-child(2) { width: 85%; }
  .skeleton span:nth-child(3) { width: 60%; }

  /* Панель ввода прибита: она вне прокрутки и видна всегда. */
  .oracle-ask { display: flex; flex-shrink: 0; flex-direction: column; gap: 8px; padding: 10px var(--pult-pad) 12px; border-top: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  .quick-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .oracle-ask :global(.quick-chip) { min-height: 32px; padding: 5px 10px; font-size: 13px; font-weight: 600; line-height: 18px; }
  .ask-field { display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px; border: 1px solid rgb(var(--line)); background: rgb(var(--canvas)); }
  .ask-field:focus-within { outline: 2px solid rgb(var(--accent) / 0.45); outline-offset: 1px; }
  .ask-text { display: block; flex: 1; min-width: 0; height: 22px; max-height: 92px; overflow-y: auto; resize: none; border: 0; padding: 0; background: transparent; color: rgb(var(--ink)); font: inherit; font-size: 14px; line-height: 22px; outline: none; }
  .ask-text::placeholder { color: rgb(var(--muted)); }
  .oracle-ask :global(.ask-send) { min-height: 36px; padding: 7px 12px; font-size: 14px; line-height: 20px; }
  .ask-note { margin: 0; }
  .ask-reason { color: rgb(var(--warning)); font-size: 13px; line-height: 18px; }

  /* Телефон: палец, а не мышь — цель нажатия не меньше 44 px. */
  @media (max-width: 650px) {
    .oracle-bar { padding: 10px var(--pult-pad); }
    .oracle-metrics { margin-left: 0; width: 100%; }
    .turn-question, .turn-answer { max-width: 100%; }
    /*
     * Быстрые вопросы — одним рядом, который листается вбок. В два ряда они
     * съедали у ленты ответов ещё 50 px там, где их и так мало, — тот же довод,
     * что у чипов отбора над списком работ (PultFilters).
     */
    .quick-row { flex-wrap: nowrap; overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .quick-row::-webkit-scrollbar { display: none; }
    .oracle-ask :global(.quick-chip) { min-height: 44px; padding: 10px 12px; flex-shrink: 0; white-space: nowrap; }
    .oracle-ask :global(.ask-send) { min-height: 44px; }
  }
</style>
