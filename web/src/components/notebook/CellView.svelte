<script lang="ts" module>
  import { api } from '@/lib/api'
  import { actionAllowedIn } from '@shared/protocol'

  /**
   * "Fix with AI" is drawn only where there is an oracle that will take a
   * 'fix'. An oracle in hints mode is on, and would refuse this button — so
   * `enabled` alone is the wrong question and actionAllowedIn is the right one,
   * asked with the same function the route refuses with.
   *
   * Every failing cell asks the same question, so the answer is fetched once
   * per tab and shared: a status request per cell would be one request per
   * traceback.
   */
  let oracle: Promise<boolean> | null = null

  function oracleEnabled(): Promise<boolean> {
    oracle ??= api
      .aiStatus()
      .then((status) => status.enabled && actionAllowedIn(status.mode, 'fix'))
      .catch(() => false)
    return oracle
  }
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { acceptPatch, cellSource, patchIsStale, rejectPatch } from '@shared/notebook'
  import { diffCounts, diffLines } from '@shared/diff'
  import type { AiAction } from '@shared/protocol'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import {
    deleteCell,
    duplicateCell,
    insertCellAfter,
    moveCell,
    setCellType,
  } from '@/lib/notebook-ops'
  import { controlDisabled, controlTitle } from '@/lib/controls'
  import { getSessionState } from '@/lib/session.svelte'
  import { cn } from '@/lib/utils'
  import {
    watchCell,
    watchCellMeta,
    watchCellPeers,
    watchNotebookMeta,
    watchOutputs,
    watchPatchFor,
    watchText,
  } from '@/lib/yreactive.svelte'
  import CellOutputs from './CellOutputs.svelte'
  import CodeEditor from './CodeEditor.svelte'
  import Markdown from './Markdown.svelte'

  interface Props {
    id: string
    index: number
    selected: boolean
    /** False while the cell sits far outside the viewport; see Notebook.svelte. */
    near?: boolean
    onselect: () => void
  }

  let { id, index, selected, near = true, onselect }: Props = $props()

  const session = getSessionState()
  const cell = watchCell(session.doc, () => id)
  const meta = watchCellMeta(() => cell.current)

  const isCode = $derived(meta.current.type === 'code')

  /*
   * Ячейка остановилась внутри input().
   *
   * Это единственное состояние, в котором ядро ждёт ЧЕЛОВЕКА, а не машину.
   * Поле показывается всей комнате, а не тому, кто нажал Run: на семинаре
   * ответ чаще знает не тот, кто запустил, а тот, кто смотрит. Отвечает первый
   * — это не гонка, которую надо чинить, а то, как устроена аудитория.
   */
  const stdin = $derived(meta.current.stdin)
  let answer = $state('')
  let answerField = $state<HTMLInputElement | null>(null)

  $effect(() => {
    if (stdin) answerField?.focus()
    else answer = ''
  })

  function sendAnswer(event: SubmitEvent): void {
    event.preventDefault()
    if (!stdin) return
    session.send({ t: 'input', value: answer })
    answer = ''
  }
  const cellState = $derived(meta.current.state)
  const running = $derived(cellState === 'running')

  let editing = $state(false)
  /** Only true when edit mode was entered deliberately, so a peer cannot steal focus. */
  let focusOnEdit = $state(false)
  let focusWithin = $state(false)

  const showEditor = $derived(isCode || editing)

  const outputs = watchOutputs(() => cell.current)
  // A code cell's text lives in CodeMirror and is never rendered from here, so
  // asking for a copy would rebuild the whole string on every keystroke for
  // nothing. Notes need it: that is what the rendered form is made of.
  const source = watchText(() => (isCode ? null : cell.current))
  const peersHere = watchCellPeers(session.awareness, () => id)
  const notebook = watchNotebookMeta(session.doc)

  const ytext = $derived(cell.current ? cellSource(cell.current) : null)
  const queuePosition = $derived(notebook.current.queue.indexOf(id))
  const hasError = $derived(
    cellState === 'error' || outputs.current.some((output) => output.kind === 'error'),
  )

  /** 01, 02, 03 — the ordinal the artboard leads the gutter with. */
  const ordinal = $derived(String(index + 1).padStart(2, '0'))

  /*
   * One signal, two marks: the ordinal in the gutter and the rule down the left
   * edge of the body. Running and error outrank selection deliberately — a cell
   * you have clicked on is still, first, a cell that failed.
   */
  const tone = $derived(
    running
      ? 'running'
      : hasError
        ? 'error'
        : cellState === 'queued'
          ? 'queued'
          : selected
            ? 'selected'
            : 'idle',
  )

  /*
   * A resting cell has nothing to announce, so the ordinal is quiet — but it is
   * also how the room refers to a cell out loud ("look at four"), so quiet has a
   * floor. faint/70 measured 2.1:1 on the dark ground, which is not quiet, it is
   * gone; and the error ordinal at danger/50 was the dimmest thing on the one
   * cell everybody is looking at.
   */
  const ORDINAL = {
    running: 'text-accent-text',
    error: 'text-danger',
    queued: 'text-accent-text/80',
    selected: 'text-ink',
    idle: 'text-muted',
  } as const

  /*
   * Вертикальная полоса слева от тела ячейки — единственный признак состояния,
   * который есть у ЛЮБОЙ ячейки: и у кода, и у прочитанного текста, и у
   * свёрнутой. Поэтому выбор говорит именно ей.
   *
   * Выбранная — цветом чернил, то есть самым тёмным, что есть на листе: она
   * должна отличаться от покоящейся (тонкая серая линия) на расстоянии
   * проектора, а не при разглядывании.
   */
  const RULE = {
    running: 'border-accent',
    error: 'border-danger',
    queued: 'border-accent/50',
    selected: 'border-ink',
    idle: 'border-line',
  } as const

  /*
   * Whose run this is only matters when it tells you something you did not
   * already know: that a cell is busy, or that a finished result came from
   * somebody else's keyboard.
   */
  const runBy = $derived(meta.current.runBy)
  /*
   * Stopping your own runaway loop should not require a teacher in the room.
   * The server decides this too, from its own record of the queue — this only
   * decides whether the control is drawn as usable.
   */
  const mineIsRunning = $derived(meta.current.runById === session.me.id)
  const canInterrupt = $derived(session.me.role === 'host' || mineIsRunning)
  /*
   * A queued cell can be taken back; the running one cannot, that is Interrupt.
   * It matters most in the case the control is for: somebody else's long cell
   * holds the kernel, you pressed Run All behind it, and Interrupt is not yours
   * to press. The server checks this again against its own queue.
   */
  const canCancel = $derived(session.me.role === 'host' || meta.current.runById === session.me.id)
  const ranByOther = $derived(
    runBy && runBy !== session.me.name && (cellState === 'ok' || cellState === 'error')
      ? `Ran by ${runBy}`
      : null,
  )

  /** The runner's face, when the person who pressed Run is still in the room. */
  const runner = $derived(
    runBy ? (session.peers.find((peer) => peer.user.name === runBy)?.user ?? null) : null,
  )

  /** 1st, 2nd, 3rd: the queue chip reads as a place in line, not as a count. */
  function place(n: number): string {
    const teens = n % 100
    const suffix = teens >= 11 && teens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
    return `${n}${suffix}`
  }

  const editingHere = $derived.by(() => {
    const names = peersHere.current.map((peer) => peer.user.name)
    if (names.length === 0) return null
    if (names.length === 1) return `${names[0]} is editing here`
    if (names.length === 2) return `${names[0]} and ${names[1]} are editing here`
    return `${names[0]}, ${names[1]} and ${names.length - 2} more are editing here`
  })

  let aiReady = $state(false)

  // Asked only where the answer changes what is drawn, so a notebook that never
  // fails never asks. The promise behind it is shared across every cell.
  $effect(() => {
    if (!hasError) return
    let alive = true
    void oracleEnabled().then((enabled) => {
      if (alive) aiReady = enabled
    })
    return () => {
      alive = false
    }
  })

  let root = $state<HTMLDivElement | null>(null)

  /* ------------------------------------------------------------- parking */

  /**
   * A cell nobody can see renders a box the size of what it last measured
   * instead of a CodeMirror instance and its outputs. It stays mounted, so its
   * subscriptions and its edit state survive and coming back is a render rather
   * than a rebuild.
   */
  const PARK_ESTIMATE = 180

  let contentHeight = $state(0)
  let parkHeight = $state(PARK_ESTIMATE)

  $effect(() => {
    if (contentHeight > 0) parkHeight = contentHeight
  })

  /*
   * Never park a cell that is running, selected, or holding the local cursor.
   * Queued is deliberately not on that list: Run All queues the whole notebook
   * at once, and pinning on it would build forty editors at the exact moment
   * the machine has the least to spare. The gutter ordinal and the queue chip
   * live outside the parked region, so a parked cell still shows its place.
   */
  const pinned = $derived(selected || focusWithin || editing || running)
  const mounted = $derived(near || pinned)

  onMount(() => {
    // A note with nothing in it has nothing to render; drop straight into edit.
    if (meta.current.type === 'markdown' && source.current.trim() === '') {
      focusOnEdit = selected
      editing = true
    }
  })

  async function focusEditor() {
    await tick()
    const find = () => root?.querySelector<HTMLElement>('.cm-content') ?? null
    const node = find()
    if (node) {
      node.focus()
      return
    }
    // The cell was inserted or unparked a moment ago and CodeMirror has not
    // been built yet.
    requestAnimationFrame(() => find()?.focus())
  }

  function enter() {
    onselect()
    if (isCode) {
      void focusEditor()
    } else {
      focusOnEdit = true
      editing = true
    }
  }

  function commitMarkdown() {
    editing = false
    focusOnEdit = false
  }

  function run() {
    if (!isCode) {
      commitMarkdown()
      return
    }
    onselect()
    session.send({ t: 'run', cellId: id })
  }

  async function runAndAdd() {
    run()
    const created = insertCellAfter(session.doc, id, meta.current.type)
    session.selectCell(created)
    await tick()
    window.dispatchEvent(new CustomEvent('colloq:enter-cell', { detail: { cellId: created } }))
  }

  /**
   * Run, then go on — the pair everyone's fingers already know.
   *
   * Shift+Enter and Cmd+Enter both used to do exactly the same thing, so half
   * of a convention this notebook otherwise imitates down to `In [3]` was
   * missing: there was no way to run a cell and move on without also inserting
   * one. Shift+Enter now steps to the next cell and makes one only when there
   * is no next cell; Cmd/Ctrl+Enter runs and stays; Alt+Enter runs and inserts.
   */
  function runAndStep() {
    run()
    step(1, true, false, true)
  }

  /** Only Notebook knows the cell order, so hand-offs go through it. */
  function step(direction: -1 | 1, focus = true, fallback = false, grow = false) {
    window.dispatchEvent(
      new CustomEvent('colloq:step-cell', { detail: { cellId: id, direction, focus, fallback, grow } }),
    )
  }

  function removeSelf(focus: boolean) {
    // Hand the selection on first, while this cell is still in the list. `fallback`
    // covers deleting the very first cell, which has no cell above it to land on.
    step(-1, focus, true)
    deleteCell(session.doc, id)
  }

  function askAi(action: AiAction) {
    session.selectCell(id)
    window.dispatchEvent(new CustomEvent('colloq:ask-ai', { detail: { cellId: id, action } }))
  }

  /* ------------------------------------------------------ asking for an edit */

  /*
   * The oracle button used to fire 'explain' and open the panel — one canned
   * question, and the answer arrived somewhere else on the screen. What a person
   * actually wants at a cell is to say what is wrong with it in their own words
   * and get the corrected cell back where the cell is.
   *
   * So the button opens a line to type on, right under the cell, and the answer
   * comes back as a diff over that same cell. The thread still gets everything —
   * the question, the reasoning, the code — because the room is entitled to know
   * why the notebook it is reading changed.
   */
  let asking = $state(false)
  let prompt = $state('')
  let sending = $state(false)
  let askError = $state<string | null>(null)
  let promptBox = $state<HTMLTextAreaElement | null>(null)

  async function sendEdit(): Promise<void> {
    const message = prompt.trim()
    if (!message || sending) return
    sending = true
    askError = null
    try {
      await api.aiAsk(session.session.id, session.token, { message, action: 'edit', cellId: id })
      prompt = ''
      asking = false
    } catch (cause) {
      askError = cause instanceof Error ? cause.message : 'The oracle could not be reached'
    } finally {
      sending = false
    }
  }

  /*
   * The proposal is read from the shared document, not held here: it belongs to
   * the room. Two people looking at this cell see the same offer, and when one
   * of them decides, the other watches it resolve.
   */
  const patch = watchPatchFor(session.doc, () => id)
  const proposal = $derived(patch.current)
  /*
   * The cell's own text, watched separately from `source`.
   *
   * `source` deliberately follows markdown cells only — rendering a note does
   * not need the text of a code cell, and skipping it saves an observer per
   * cell. The diff needs exactly the opposite, and reading the wrong one showed
   * every proposal as pure addition: the old lines were never handed to the
   * diff, so nothing could be marked as replaced.
   */
  const liveText = watchText(() => cell.current)

  const proposedLines = $derived.by(() => {
    const proposed = proposal?.get('patch')
    if (typeof proposed !== 'string') return []
    return diffLines(liveText.current, proposed)
  })
  const proposedCounts = $derived(diffCounts(proposedLines))
  const proposalStale = $derived(proposal ? patchIsStale(session.doc, proposal) : false)

  function accept(): void {
    if (!proposal) return
    acceptPatch(session.doc, proposal, session.me.name)
  }

  function decline(): void {
    if (!proposal) return
    rejectPatch(session.doc, proposal, session.me.name)
  }

  $effect(() => {
    if (asking) promptBox?.focus()
  })

  function convert() {
    setCellType(session.doc, id, isCode ? 'markdown' : 'code')
    // Whichever way it went, the cell re-renders in its resting form.
    focusOnEdit = false
    editing = false
  }

  $effect(() => {
    const onEnterCell = (event: Event) => {
      const detail = (event as CustomEvent<{ cellId: string }>).detail
      if (detail?.cellId === id) enter()
    }
    window.addEventListener('colloq:enter-cell', onEnterCell)
    return () => window.removeEventListener('colloq:enter-cell', onEnterCell)
  })

  const TOOL_BASE =
    // 24px square: WCAG 2.5.8's floor, and the difference between hitting
    // "move cell up" and hitting the cell above it on a trackpad.
    'inline-flex h-6 w-6 items-center justify-center text-muted transition-colors ' +
    'duration-[var(--speed-quick)] focus-visible:outline-none focus-visible:ring-2 ' +
    'disabled:opacity-30 disabled:hover:bg-transparent'
  const TOOL = `${TOOL_BASE} hover:bg-line hover:text-ink focus-visible:ring-accent/50`
  const TOOL_DANGER = `${TOOL_BASE} hover:bg-danger/15 hover:text-danger focus-visible:ring-danger/40`

  /** The strip under a cell body: aligned to the code, not to the rule. */
  const FOOTER = 'mt-2.5 flex items-center gap-2 pl-5'
  /**
   * Caps voice for every small label in the sheet: cell state, run credits,
   * the cell's own actions. 11px rather than 10 — see the note on the two
   * smallest steps in tailwind.config.js. This one constant is most of the
   * 525 runs of 10px the workspace was carrying.
   */
  const CAPS = 'text-2xs font-bold uppercase tracking-label'
</script>

{#if cell.current && ytext}
  <div
    bind:this={root}
    role="group"
    aria-label={`Cell ${index + 1}`}
    data-cell-id={id}
    onpointerdown={() => onselect()}
    onfocusin={() => (focusWithin = true)}
    onfocusout={(event) => {
      const next = event.relatedTarget as Node | null
      focusWithin = next !== null && event.currentTarget.contains(next)
    }}
    class="group flex gap-4"
  >
    <!-- Gutter: one ordinal, coloured by state. It stays put on hover — the
         artboard draws the toolbar over a cell whose number is still legible,
         and Run lives in that toolbar rather than under the number. -->
    <div class="h-7 w-8 shrink-0 select-none">
      <!--
        Цвет номера меняется мгновенно, и это не экономия, а правило: `tone`
        переключается стрелкой, Enter и j/k, то есть сотни раз за пару. Метка
        «вот эта ячейка сейчас живая» — единственное, по чему двадцать человек
        в комнате понимают, куда смотреть; переход в 100ms сдвигает её на сто
        миллисекунд позже нажатия, и на быстром переборе ячеек цвет всё время
        догоняет курсор, вместо того чтобы стоять под ним.

        Тот же довод, что двадцатью строками ниже про кольцо фокуса: подсказка,
        пришедшая с опозданием, хуже пришедшей резко.
      -->
      <span
        title={meta.current.execCount === null ? undefined : `Run ${meta.current.execCount}`}
        class={cn(
          'block text-right text-head font-black tabular-nums tracking-tight',
          ORDINAL[tone],
        )}
      >
        {ordinal}
      </span>
    </div>

    <div class="relative min-w-0 flex-1">
      <!-- Out of flow and above the body: a toolbar that appeared in flow would
           push the cell down the moment the pointer arrived. -->
      <div
        class={cn(
          'absolute bottom-full right-0 z-10 flex items-center gap-0.5 bg-raised px-1.5 py-0.5',
          'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          // Переход живёт только у невыбранной ячейки, и поэтому достаётся
          // ровно наведению: мышь ведут медленно и плавное проявление ей
          // помогает. У выбранной перехода нет — значит стрелка открывает
          // тулбар в том же кадре, в котором нажата. Уход с ячейки снова
          // возвращает переход, и тулбар соседа успокаивается, а не пропадает.
          !selected && 'transition-opacity duration-[var(--speed-quick)]',
          selected && 'opacity-100',
        )}
      >
        {#if isCode}
          <button
            type="button"
            class={TOOL}
            disabled={controlDisabled(session.connected)}
            title={controlTitle(session.connected, 'Run cell')}
            aria-label="Run cell"
            onclick={run}
          >
            <Icon name="play" size={12} class="text-accent-text" />
          </button>
        {:else if !editing}
          <button
            type="button"
            class={TOOL}
            title="Edit this text cell"
            aria-label="Edit text cell"
            onclick={() => enter()}
          >
            <Icon name="text" size={13} />
          </button>
        {/if}
        <button
          type="button"
          class={TOOL}
          title="Move up"
          aria-label="Move cell up"
          disabled={index === 0}
          onclick={() => moveCell(session.doc, id, -1)}
        >
          <Icon name="chevron-up" size={13} />
        </button>
        <button
          type="button"
          class={TOOL}
          title="Move down"
          aria-label="Move cell down"
          onclick={() => moveCell(session.doc, id, 1)}
        >
          <Icon name="chevron-down" size={13} />
        </button>
        <button
          type="button"
          class={TOOL}
          title="Duplicate"
          aria-label="Duplicate cell"
          onclick={() => duplicateCell(session.doc, id)}
        >
          <Icon name="duplicate" size={13} />
        </button>
        <button
          type="button"
          class={TOOL}
          title={isCode ? 'Convert to text — M' : 'Convert to code — Y'}
          aria-label={isCode ? 'Convert to markdown' : 'Convert to code'}
          onclick={convert}
        >
          <Icon name={isCode ? 'text' : 'code'} size={13} />
        </button>
        <button
          type="button"
          class={TOOL}
          title="Ask the oracle to change this cell"
          aria-label="Ask the oracle to change this cell"
          aria-pressed={asking}
          onclick={() => (asking = !asking)}
        >
          <Icon name="sparkles" size={13} class="text-accent-text" />
        </button>
        <button
          type="button"
          class={TOOL_DANGER}
          title="Delete cell"
          aria-label="Delete cell"
          onclick={() => removeSelf(false)}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>

      {#if mounted}
        <div bind:clientHeight={contentHeight}>
          {#if showEditor}
            <!-- The focus ring lands at once: box-shadow cannot be animated
                 on the compositor, and a focus cue that arrives late is worse
                 than one that arrives hard. -->
            <div
              class={cn(
                // Без перехода — по тому же правилу, что и номер выше: и
                // кромка, и подложка держатся на `tone`, который переключает
                // клавиатура.
                'border-l-4 px-3 py-1',
                RULE[tone],
                isCode ? 'bg-surface' : 'bg-surface/70',
                // Выбранная ячейка отличается ещё и подложкой: одна кромка на
                // широком экране теряется у левого поля, а глаз ищет ячейку в
                // тексте, а не на границе.
                selected && !running && !hasError && 'bg-raised',
              )}
              onfocusout={(event) => {
                // Blurring a note puts it back to rendered form; code cells stay open.
                if (isCode) return
                const next = event.relatedTarget as Node | null
                if (!next || !event.currentTarget.contains(next)) commitMarkdown()
              }}
            >
              <CodeEditor
                text={ytext}
                awareness={session.awareness}
                undoManager={session.undoManager}
                language={isCode ? 'python' : 'markdown'}
                label={`${isCode ? 'Code' : 'Text'} cell ${ordinal}`}
                autoFocus={!isCode && focusOnEdit}
                placeholder={isCode ? '' : 'Write in markdown…'}
                onfocus={() => onselect()}
                onrun={run}
                onrunstep={runAndStep}
                onrunandadd={runAndAdd}
                onescape={() => {
                  if (isCode) root?.querySelector<HTMLElement>('.cm-content')?.blur()
                  else commitMarkdown()
                }}
                ondeleteempty={() => removeSelf(true)}
                onarrowout={(direction) => step(direction)}
              />
            </div>
          {:else}
            <!-- A note at rest carries no chrome at all: it is the seminar's
                 prose, and the editor is a thing you go and get. -->
            <!--
              Рельса есть и у прочитанного текста. Её тут не было вовсе: она
              рисовалась только внутри редактора, поэтому у текстовой ячейки при
              выборе менялся один номер в поле слева — по нему невозможно
              сказать, какая ячейка выбрана, если смотреть на текст, а не на
              поля. Теперь у всех ячеек одна и та же вертикальная полоса, и
              выбранная отличается от остальных так же, как работающая.
            -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class={cn(
                // См. выше: `tone` переключается стрелкой, переходу здесь не
                // место.
                'note border-l-4 px-3 py-1',
                RULE[tone],
                selected ? 'bg-surface/70' : 'bg-transparent',
              )}
              ondblclick={() => enter()}
            >
              {#if source.current.trim()}
                <Markdown source={source.current} class="text-prose text-muted" />
              {:else}
                <p class="text-prose text-muted">Empty — double-click to write.</p>
              {/if}
            </div>
          {/if}

          <!--
            Asking the oracle to change this cell, and what it answered.

            Both live under the cell rather than in the side panel, because both are about
            this cell: the sentence you type is about it, and the diff that comes back
            replaces it. The panel still receives every word — the question, the reasoning
            and the code — because the room is entitled to know why the notebook it is
            reading changed.
          -->
          {#if asking}
            <div class={cn('flex flex-col gap-2 border-l-4 px-3 py-2.5', RULE[tone], 'bg-surface')}>
              <textarea
                bind:this={promptBox}
                bind:value={prompt}
                rows="2"
                class="w-full resize-none border border-line bg-canvas px-3 py-2 text-ui text-ink
                       placeholder:text-faint focus:border-accent focus:outline-none"
                placeholder="What should this cell do instead?"
                onkeydown={(event) => {
                  // Enter sends: this is one sentence, not a document. Shift+Enter is
                  // there for the person who wants two.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void sendEdit()
                  }
                  if (event.key === 'Escape') asking = false
                }}
              ></textarea>
              <div class="flex flex-wrap items-center gap-2.5">
                <button type="button" class="btn-primary h-8" disabled={sending || !prompt.trim()} onclick={sendEdit}>
                  {#if sending}
                    <Icon name="spinner" size={13} class="animate-spin" />
                    Asking…
                  {:else}
                    Ask for a rewrite
                  {/if}
                </button>
                <button type="button" class="btn-ghost h-8" onclick={() => (asking = false)}>Cancel</button>
                {#if askError}
                  <span class="text-2xs text-danger" role="alert">{askError}</span>
                {:else}
                  <span class="text-2xs text-muted">The whole room sees the question and the answer.</span>
                {/if}
              </div>
            </div>
          {/if}

          {#if proposal}
            <div class="border-l-4 border-accent bg-accent/[0.04]">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2">
                <span class={cn(CAPS, 'text-accent-text')}>Proposed by the oracle</span>
                <span class="font-mono text-2xs">
                  {#if proposedCounts.added > 0}<span class="text-positive">+{proposedCounts.added}</span>{/if}
                  {#if proposedCounts.removed > 0}<span class="ml-1.5 text-danger">−{proposedCounts.removed}</span>{/if}
                </span>
                {#if proposalStale}
                  <!-- Not a refusal: the room may want the rewrite anyway. But accepting
                       deletes whatever arrived in the meantime, and that has to be said
                       before the press rather than after. -->
                  <span class="text-2xs text-warning">
                    The cell has changed since this was written — accepting replaces it whole.
                  </span>
                {/if}
              </div>
              <pre class="overflow-x-auto px-3 py-2 font-mono text-code-lg leading-[21px]">{#each proposedLines as line}<span class={cn('block min-h-[21px]', line.kind === 'added' && 'bg-positive/10 text-ink', line.kind === 'removed' && 'bg-danger/10 text-muted line-through', line.kind === 'same' && 'text-muted')}><span class="inline-block w-5 select-none text-center text-faint">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '\u2212' : ' '}</span>{line.text}</span>{/each}</pre>
              <div class="flex flex-wrap items-center gap-2.5 border-t border-line-soft px-3 py-2">
                <button type="button" class="btn-primary h-8" onclick={accept}>Accept</button>
                <button type="button" class="btn-outline h-8" onclick={decline}>Discard</button>
                <span class="text-2xs text-muted">Accepting writes the cell for everyone, under your name.</span>
              </div>
            </div>
          {/if}

          {#if isCode && outputs.current.length > 0}
            <div
              class={cn('border-l-4', RULE[tone], hasError ? 'bg-danger/5' : 'bg-surface/50')}
            >
              <div class="px-2 py-1.5">
                <CellOutputs outputs={outputs.current} />
              </div>
              {#if meta.current.execCount !== null || ranByOther}
                <div class="flex items-center gap-3 border-t border-line-soft px-4 py-1">
                  {#if ranByOther}
                    <span class="font-mono text-2xs text-muted">{ranByOther}</span>
                  {/if}
                  {#if meta.current.execCount !== null}
                    <span class={cn('ml-auto', CAPS, 'text-muted')}>
                      Out [{meta.current.execCount}]
                    </span>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <div class={cn('border-l-4 bg-surface/50', RULE[tone])} style="height: {parkHeight}px"></div>
      {/if}

      {#if stdin}
        <!--
          Форма стоит под ячейкой, а не в тосте: ждёт именно эта ячейка, и
          смотреть надо на неё. Кромка цветом бегущей — потому что ячейка и
          правда бежит, просто остановилась о человека.
        -->
        <form
          class="mt-1.5 flex items-center gap-2 border-l-4 border-accent bg-accent/[0.07] px-3 py-2"
          onsubmit={sendAnswer}
        >
          <span class={cn(CAPS, 'shrink-0 text-accent-text')}>Input</span>
          {#if stdin.prompt}
            <span class="shrink-0 font-mono text-code text-ink">{stdin.prompt}</span>
          {/if}
          <input
            bind:this={answerField}
            bind:value={answer}
            type={stdin.password ? 'password' : 'text'}
            class="field h-8 min-w-0 flex-1 font-mono text-code-lg"
            autocomplete="off"
            spellcheck="false"
            aria-label={stdin.prompt || 'The cell is waiting for input'}
          />
          <button
            type="submit"
            class={cn(
              'inline-flex h-8 shrink-0 items-center bg-primary px-3 text-primary-ink',
              CAPS,
              'transition-opacity duration-[var(--speed-quick)] hover:opacity-90',
            )}
          >
            Send
          </button>
        </form>
        <p class="px-3 pt-1 text-2xs text-muted">
          The kernel is waiting — anyone in the room can answer.
        </p>
      {/if}

      {#if running}
        <!-- The artboard's run bar: who is running it, and the one control that
             matters while it is. Elapsed time is not on the cell in the
             document, so it is not claimed here. -->
        <div class={FOOTER}>
          {#if runner}
            <Avatar
              name={runner.name}
              color={runner.color}
              avatar={runner.avatar}
              size="xs"
              title={`${runner.name} started this run`}
            />
          {/if}
          <span class={cn(CAPS, 'text-accent-text')}>Running</span>
          {#if runBy}
            <span class="text-2xs text-muted">started by {runBy}</span>
          {/if}
          <button
            type="button"
            disabled={controlDisabled(session.connected, canInterrupt)}
            title={controlTitle(
              session.connected,
              canInterrupt ? 'Stop the running cell' : 'Only the host, or whoever started it, can stop a run',
            )}
            onclick={() => session.send({ t: 'interrupt' })}
            class={cn(
              'ml-auto inline-flex h-6 items-center border border-line px-2 text-ink',
              CAPS,
              'transition-colors duration-[var(--speed-quick)] hover:bg-raised',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            Interrupt
          </button>
        </div>
      <!--
        A queued cell said nothing at all whenever the document's queue had not
        caught up with the cell's own state — which is exactly the moment after
        somebody presses Run All, and exactly when the room wants to know that
        their cell is waiting rather than ignored. The position is extra when we
        have it; that it is queued, and whose it is, we always have.
      -->
      {:else if cellState === 'queued'}
        <div class={FOOTER}>
          <!-- The chip is the POSITION. Without one it would only say "queued"
               beside "queued by John", which is the same word twice. -->
          {#if queuePosition >= 0}
            <span
              title="Waiting in the run queue"
              class="inline-flex h-5 items-center bg-raised px-2 font-mono text-2xs text-muted"
            >
              {place(queuePosition + 1)} in queue
            </span>
          {/if}
          <span class={cn(CAPS, 'text-accent-text')}>Queued</span>
          {#if runBy}
            <span class="text-2xs text-muted">by {runBy}</span>
          {/if}
          {#if canCancel}
            <button
              type="button"
              disabled={controlDisabled(session.connected)}
              title={controlTitle(session.connected, 'Take this cell out of the queue')}
              onclick={() => session.send({ t: 'cancel', cellId: id })}
              class={cn(
                'ml-auto inline-flex h-6 items-center border border-line px-2 text-ink',
                CAPS,
                // Spelled out, not `.press`: a Tailwind transition-* utility rewrites
                // transition-property, so the helper's transform would be left out of
                // the list and the scale would snap. Same shape the run bar's CAP uses.
                'transition-[color,background-color,border-color,transform] duration-press ease-out',
                'enabled:active:scale-[0.97] hover:bg-raised',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                'disabled:pointer-events-none disabled:opacity-40',
              )}
            >
              Cancel
            </button>
          {/if}
        </div>
      {:else if hasError && aiReady}
        <div class={FOOTER}>
          <button
            type="button"
            onclick={() => askAi('fix')}
            class={cn(
              // The filled pair, like Run all: cyan cannot carry a fill in light.
              'inline-flex h-7 items-center gap-2 bg-primary px-3 text-primary-ink',
              CAPS,
              'transition-opacity duration-[var(--speed-quick)] hover:opacity-90',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
              'focus-visible:ring-primary-ink/60',
            )}
          >
            <Icon name="sparkles" size={12} />
            Fix with AI
          </button>
          <span class="text-2xs text-muted">sends the traceback, this cell and the notebook</span>
        </div>
      {/if}

      {#if editingHere}
        <div class="{FOOTER} enter">
          {#each peersHere.current.slice(0, 4) as peer (peer.clientId)}
            <Avatar
              name={peer.user.name}
              color={peer.user.color}
              avatar={peer.user.avatar}
              size="xs"
              title={`${peer.user.name} is in this cell`}
            />
          {/each}
          <span class="text-2xs text-muted">{editingHere}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /*
   * A note in the notebook is the seminar's prose: the artboard leads it with a
   * display heading in the black weight and drops the body to muted, so the
   * code below it stays the loudest thing on the sheet. .prose-note in
   * index.css is shared with the oracle panel, which wants neither, so the
   * notebook's own voice is set here rather than by retuning every reader.
   */
  .note :global(.prose-note h1) {
    @apply text-display font-black text-ink;
  }
  .note :global(.prose-note h2) {
    @apply text-head font-black text-ink;
  }
</style>
