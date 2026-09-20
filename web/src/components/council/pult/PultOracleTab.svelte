<script lang="ts">
  /**
   * Оракул о классе: мессенджер, в котором преподаватель спрашивает о задаче.
   *
   * Вкладка была экраном одной кнопки: «Подготовить сводку» — и три абзаца про
   * сданный код, разложенные по шести безымянным группам. Ни группы, ни сводки
   * здесь больше нет, и это просьба владельца: он думает о классе не стопками
   * одинакового текста, а людьми — «у Ани работает, у Пети падает». Осталась
   * одна лента «вопрос → ответ», и спросить можно ВСЕГДА: ещё до того, как
   * кто-нибудь написал хоть строку, — «что это вообще за задание и как им
   * лучше действовать» модель прочитает по тексту общей ячейки.
   *
   * Три вещи держатся нарочно.
   *
   * Панель ввода не уезжает. Она вне области прокрутки: на телефоне и в окне
   * 900×650 поле «спросить» должно быть под рукой, а не в конце ленты, которую
   * сперва надо промотать.
   *
   * Имена в ответе — живые. Модель называет людей по имени (или меткой `S7`,
   * если имена на этом Colloq к ней не едут), а словарь «подпись → человек»
   * приезжает вместе с ответом; здесь подпись превращается в чип, по которому
   * открывается работа. Разбор текста — чистой функцией в
   * lib/council-oracle-answer.ts: наивная замена подстроки съела бы «Анна»
   * внутри «Анна Белова».
   *
   * Отказ остаётся В ЛЕНТЕ. Вопрос, на который не ответили, не исчезает:
   * иначе повторить нечего, и даже понять, на чём повисло, невозможно.
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
    /** Номера вариантов ячейки (council-pult.ts · variantNumbers) — подпись чипа при выключенных именах. */
    variants: ReadonlyMap<string, number>
    askWhy: string | null
    /** Вопрос и уровень размышлений на него; без уровня — умолчание инстанса. */
    onask: (question: string, effort?: ReasoningEffort) => void
    onstop: () => void
    /** Открыть работу этого человека — нажатие на чип в ответе. */
    onopen: (participantId: string) => void
  }

  let { oracle, attempts, submitted, names, variants, askWhy, onask, onstop, onopen }: Props =
    $props()

  let draft = $state('')
  let bodyEl = $state<HTMLElement | null>(null)
  let field = $state<HTMLTextAreaElement | null>(null)
  /** `null` — «как на инстансе»: в запрос не уходит ничего нового. */
  let effort = $state<ReasoningEffort | null>(rememberedEffort())

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
  const byId = $derived(new Map(attempts.map((one) => [one.participantId, one] as const)))
  const empty = $derived(answers.length === 0 && pending === null)

  /** Быстрые вопросы: на кнопке — два слова, модели уезжает целое предложение. */
  const quick = $derived([
    { label: tr('room.pult.v2.oracle.ask.status'), question: tr('room.pult.v2.oracle.ask.qStatus') },
    { label: tr('room.pult.v2.oracle.ask.stuck'), question: tr('room.pult.v2.oracle.ask.qStuck') },
    {
      label: tr('room.pult.v2.oracle.ask.mistakes'),
      question: tr('room.pult.v2.oracle.ask.qMistakes'),
    },
    {
      // Бывшая «Сводка по решениям» — теперь такой же вопрос, как остальные, и
      // гаснуть без сдач ему незачем: разбирать «что писать дальше» полезно и
      // по черновикам.
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

  /** Тот же уровень второй раз — «как на инстансе»: выбор снимается нажатием. */
  function pickEffort(next: ReasoningEffort): void {
    effort = effort === next ? null : next
    rememberEffort(effort)
  }

  /** Подпись чипа: имя, «Вариант N» или сама подпись из кадра, если человека уже нет. */
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
                <!-- Отказ стоит там же, где стоял бы ответ: вопрос остаётся на
                     месте, и его видно, чем повторить. -->
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

  /* Шапка — одна строка: числа нужны глазом, а не размером. */
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

  /* Лента: вопрос справа и выделен, ответ слева — как в переписке. */
  .thread { display: flex; flex-direction: column; gap: 16px; }
  .turn { display: flex; flex-direction: column; gap: 8px; }
  .turn-question { align-self: flex-end; max-width: min(100%, 560px); padding: 8px 12px; border: 1px solid rgb(var(--accent)); background: rgb(var(--accent) / 0.1); color: rgb(var(--ink)); font-size: 14px; line-height: 21px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn-answer { align-self: flex-start; max-width: min(100%, 640px); padding: 10px 14px; border: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  /* Неудачный ход — такой же ход, только рамка другая: вопрос над ним остаётся. */
  .turn-failed { border-left: 3px solid rgb(var(--danger)); background: rgb(var(--danger) / 0.05); }
  .turn-failed-text { font-size: 14px; line-height: 21px; overflow-wrap: anywhere; }
  .turn-answer .retry { margin-top: 8px; min-height: 30px; padding: 5px 10px; font-size: 13px; line-height: 18px; }
  .answer-text { font-size: 14px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn-meta { margin-top: 8px; color: rgb(var(--muted)); font-size: 12px; line-height: 17px; }

  /* Чип человека — часть предложения, по которой нажимают (как .pult-value). */
  .answer-person { display: inline; padding: 0 1px; border: 0; border-bottom: 1px dashed rgb(var(--primary) / 0.5); background: transparent; color: rgb(var(--primary)); font: inherit; font-weight: 700; cursor: pointer; }
  .answer-person:hover { background: rgb(var(--raised)); }

  .loading-label { color: rgb(var(--accent-text)); font-size: 14px; line-height: 20px; font-weight: 700; }
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

  /* Уровень размышлений — мелкая строка под полем: выбирают редко, видят всегда. */
  .effort-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
  .effort-title { color: rgb(var(--muted)); font-size: 12px; line-height: 17px; }
  .effort-chip { min-height: 24px; padding: 2px 8px; border: 1px solid rgb(var(--line)); background: transparent; color: rgb(var(--muted)); font: inherit; font-size: 12px; line-height: 17px; cursor: pointer; }
  .effort-chip:hover { color: rgb(var(--ink)); }
  .effort-on { border-color: rgb(var(--accent)); background: rgb(var(--accent) / 0.12); color: rgb(var(--ink)); font-weight: 700; }

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
    .effort-chip { min-height: 32px; padding: 6px 10px; }
  }
</style>
