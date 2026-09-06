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
  import { findChatEntry, findCell } from '@shared/notebook'
  import { diffCounts, diffLines } from '@shared/diff'
  import type { AiAction } from '@shared/protocol'
  import { actsAfterClass, CLASS_IS_OVER } from '@shared/rules'
  import { askToBan, mayBan } from '@/lib/bans'
  import { getSessionState } from '@/lib/session.svelte'
  import { watchText } from '@/lib/yreactive.svelte'
  import { diffTokens, loadSyntax, syntax } from '@/lib/syntax.svelte'
  import { revealCell } from '@/lib/reveal'
  import { permitsIn } from '@/lib/may'
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
    /** Номер ячейки, к которой ход привязан: туда ляжет предложение. */
    cellNumber: number | null
    /**
     * Номера ячеек, о которых спрашивали.
     *
     * Отдельно от `cellNumber`: спросить можно про несколько, а предложить
     * правку — в одну. Пусто у ходов, записанных до выделения нескольких.
     */
    askedAbout: number[]
    /**
     * Можно ли завести ход «сделать» в этой комнате: правило `agent` плюс
     * режим оракула. Считает панель — режим инстанса знает только она.
     */
    canDo: boolean
    onretry: () => void
    onstop: () => void
    /** Отменить ход целиком: файлы вернутся к тому, что было до него. */
    onundo: () => void
  }

  let { entry, avatar, cellNumber, askedAbout, canDo, onretry, onstop, onundo }: Props = $props()

  /** Что говорит строка шага: глагол, цель и итог. */
  const VERB: Record<string, string> = {
    read: 'прочитал',
    write: 'изменил',
    new: 'завёл',
    run: 'запустил',
    note: 'не вышло',
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
   * Можно ли отсюда удалить автора записи с занятия.
   *
   * Роль автора в записи не хранится — её спрашивают у присутствия. Ушедшего из
   * комнаты там нет, и он считается участником: банить того, кто уже вышел, —
   * обычное дело (лента переживает уход), а штат сервер не забанит в любом
   * случае, и его отказ приедет словами в то же окно.
   */
  const authorRole = $derived(
    session.peers.find((peer) => peer.user.id === entry.participantId)?.user.role ?? 'participant',
  )
  const banHere = $derived(!mine && mayBan(session.me.role, authorRole))

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
   *
   * Только для кодовых ячеек: у текстовой в предложении проза, и питоновская
   * раскраска подсветила бы в ней слово for посреди предложения.
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
    if (entry.cellId) revealCell(session, entry.cellId)
  }

  /*
   * Решает сервер, а не эта вкладка.
   *
   * Проверка «предложение ещё открыто» внутри транзакции спасала от двух
   * нажатий здесь и не спасала от двух браузеров: каждый читал в своей копии
   * `'open'`, каждый писал, и Yjs добросовестно сливал обе правки — ячейка
   * получала патч дважды. У сервера копия одна, и он разбирает сообщения по
   * очереди.
   */
  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))
  /*
   * Отменить ход — там же, где его можно завести, плюс преподаватель всегда:
   * ровно так это читает сервер (control.ts, case 'ai:undo').
   */
  const mayUndo = $derived(session.me.role === 'host' || may.agent)
  /*
   * Действует ли этот человек после звонка.
   *
   * Для того, у чего правила нет вовсе: спросить снова, отклонить
   * предложение. Та же `actsAfterClass`, которой отвечает сервер, — второго
   * механизма прав здесь заводить нельзя. «Стоп» отсюда ушёл: у него правило
   * своё, и звонок в нём ничего не меняет — см. ниже.
   */
  const acts = $derived(actsAfterClass(may.finished, session.me.role))
  /*
   * «Стоп» — своей записи, всегда; чужой — только преподавателю.
   *
   * Не после звонка, а вообще: оборвать чужой ответ — это стереть работу,
   * которую человек ждёт, а оборвать чужой ход агента — бросить правку файлов
   * на середине. Преподавателю чужая нужна по-настоящему: разогнавшийся ответ
   * висит на проекторе у всей комнаты. Ровно так это читает сервер
   * (routes/ai.ts, /ai/cancel) — второго свода правил здесь заводить нельзя.
   */
  const mayStop = $derived(mine || session.me.role === 'host')

  function decide(accept: boolean) {
    if (!findChatEntry(session.doc, entry.id)) return
    session.send({ t: 'ai:decide', entryId: entry.id, accept })
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
      <!--
        Значок и имя — вход в то же меню, что и правая кнопка в списке людей.
        Здесь его ищут раньше: спам виден в ленте, а не в рельсе, и человека,
        которого удаляют, преподаватель в этот момент читает.

        svelte:element, а не две ветки разметки: значок и имя стоят вплотную и
        разошлись бы на первой же правке отступа.
      -->
      <svelte:element
        this={banHere ? 'button' : 'span'}
        role={banHere ? 'button' : undefined}
        type={banHere ? 'button' : undefined}
        title={banHere ? `Что сделать с участником: ${entry.name}` : undefined}
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
        <span class="shrink-0 text-2xs text-faint">you</span>
      {/if}
      {#if badge}
        <span class={cn(CHIP, 'bg-raised text-muted')}>{badge}</span>
      {/if}
      {#if askedAbout.length > 0}
        <!--
          Ссылка, а не подпись: тетрадь к этому времени обычно уже уехала. Ведёт
          к ПЕРВОЙ из названных — той, с которой разговор начался; остальные
          названы рядом, чтобы было видно, о чём вообще шла речь.
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
            ? `Перейти к ячейке ${pad(askedAbout[0])}`
            : `Спрашивали про ячейки ${askedAbout.map(pad).join(', ')} — перейти к первой`}
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
          title="Перейти к ячейке {pad(cellNumber)}"
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

    <!--
      Что оракул делал сам. Лента живёт в документе рядом с ответом, а не в
      логах сервера: комната должна видеть, что именно случилось с её файлами,
      а не читать про это в пересказе.
    -->
    {#if entry.steps.length > 0}
      <div class="flex flex-col border border-line bg-canvas">
        {#each entry.steps as step, at (at)}
          <div
            class="flex items-center gap-2 px-2.5 py-1.5 {at > 0 ? 'border-t border-line-soft' : ''}"
          >
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
              >
                код {step.exit ?? '?'}
              </span>
            {:else if step.note}
              <span class="max-w-[45%] shrink-0 truncate text-2xs text-muted" title={step.note}>
                {step.note}
              </span>
            {/if}
          </div>
        {/each}
        {#if entry.state === 'streaming'}
          <div class="flex items-center gap-2 border-t border-line-soft px-2.5 py-1.5">
            <Icon name="spinner" size={12} class="shrink-0 animate-spin text-faint" />
            <span class="text-2xs text-muted">думает, что дальше</span>
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
        <!-- Повтор хода «сделать» — это тот же ход: там, где его нельзя
             завести, нечего и повторять. После звонка нечего повторять вовсе:
             оракул отвечает одному преподавателю (routes/ai.ts), и кнопка
             вернула бы красную строку отказа под красной строкой ошибки. -->
        {#if acts && (entry.mode !== 'agent' || canDo)}
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
        {/if}
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
      <!-- Кнопка остаётся стоять и на чужой записи: она идёт, и молча
           исчезнувший «Стоп» читался бы как «оракула уже не остановить». Она
           гаснет и говорит, почему. -->
      <button
        type="button"
        class={cn(GHOST, 'self-start disabled:cursor-not-allowed disabled:opacity-40')}
        disabled={!mayStop}
        title={mayStop ? '' : 'Остановить чужой вопрос может преподаватель'}
        onclick={onstop}
      >
        <Icon name="stop" size={10} />
        Stop
      </button>
    {/if}

    <!--
      Отмена всего хода. Одна кнопка, потому что ход — это одно решение:
      разбирать его по правкам значило бы просить человека выяснять, какая из
      четырёх правок лишняя, посреди пары.
    -->
    {#if entry.undo === 'available'}
      <div class="flex flex-col gap-1.5 border-t border-line pt-2">
        <!-- Обещано ровно то, что делается: сервер возвращает только файлы, до
             которых после хода никто не дотянулся, а переименованные и
             переписанные пропускает и называет их в ответе. -->
        <p class="text-2xs leading-snug text-muted">
          Оракул поменял файлы сам. Отмена вернёт те из них, которых после этого никто не трогал.
        </p>
        <!-- Отменяет ход тот, кому разрешено его завести: сервер отказывает
             всем остальным (control.ts), а кнопка, которая врёт до нажатия,
             хуже её отсутствия. Строка выше остаётся — она про то, что
             случилось, а не про то, что можно. -->
        <button
          type="button"
          class={cn(GHOST, 'self-start disabled:cursor-not-allowed disabled:opacity-40')}
          disabled={!mayUndo}
          title={mayUndo ? '' : may.agentWhy}
          onclick={onundo}
        >
          <Icon name="restart" size={11} />
          Отменить всё
        </button>
      </div>
    {:else if entry.undo === 'done'}
      <p class="border-t border-line pt-2 text-2xs text-muted">
        Ход отменён{entry.undoBy ? ` — ${entry.undoBy}` : ''}: файлы, которых с тех пор никто не
        менял, вернулись к тому, что было.
      </p>
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
                <button
                  type="button"
                  class="btn-primary h-7"
                  disabled={!acts}
                  title={acts ? '' : CLASS_IS_OVER}
                  onclick={() => decide(false)}
                >
                  Discard
                </button>
                <!-- Применить — правка тетради, и правило комнаты про неё же.
                     Отклонить остаётся всем, пока идёт занятие: снятая плашка
                     ничего не рушит. После звонка рушит: предложение исчезнет
                     насовсем, а попросить его заново уже нечем — оракул
                     отвечает одному преподавателю. -->
                <button
                  type="button"
                  class="btn-outline h-7"
                  disabled={!may.edit}
                  title={may.edit ? '' : may.editWhy}
                  onclick={() => decide(true)}
                >
                  Apply anyway
                </button>
              {:else}
                <button
                  type="button"
                  class="btn-primary h-7"
                  disabled={!may.edit}
                  title={may.edit ? '' : may.editWhy}
                  onclick={() => decide(true)}
                >
                  Accept
                </button>
                <button
                  type="button"
                  class="btn-outline h-7"
                  disabled={!acts}
                  title={acts ? '' : CLASS_IS_OVER}
                  onclick={() => decide(false)}
                >
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
