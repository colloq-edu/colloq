<script lang="ts" module>
  import { api } from '@/lib/api'

  /**
   * "Fix with AI" is drawn only where there is an assistant to reach. Every
   * failing cell asks the same question, so the answer is fetched once per tab
   * and shared — a status request per cell would be one request per traceback.
   */
  let assistant: Promise<boolean> | null = null

  function assistantEnabled(): Promise<boolean> {
    assistant ??= api
      .aiStatus()
      .then((status) => status.enabled)
      .catch(() => false)
    return assistant
  }
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { cellSource } from '@shared/notebook'
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
  import { getSessionState } from '@/lib/session.svelte'
  import { cn } from '@/lib/utils'
  import {
    watchCell,
    watchCellMeta,
    watchCellPeers,
    watchNotebookMeta,
    watchOutputs,
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

  /* Idle and error are dimmed on purpose: at 20px black the ordinal is the
     loudest thing in the gutter, and a resting cell has nothing to announce. */
  const ORDINAL = {
    running: 'text-accent-text',
    error: 'text-danger/50',
    queued: 'text-accent-text/60',
    selected: 'text-ink',
    idle: 'text-faint/70',
  } as const

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
    void assistantEnabled().then((enabled) => {
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

  /** Only Notebook knows the cell order, so hand-offs go through it. */
  function step(direction: -1 | 1, focus = true, fallback = false) {
    window.dispatchEvent(
      new CustomEvent('colloq:step-cell', { detail: { cellId: id, direction, focus, fallback } }),
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
    'inline-flex h-5 w-6 items-center justify-center text-muted transition-colors ' +
    'duration-[var(--speed-quick)] focus-visible:outline-none focus-visible:ring-2 ' +
    'disabled:opacity-30 disabled:hover:bg-transparent'
  const TOOL = `${TOOL_BASE} hover:bg-line hover:text-ink focus-visible:ring-accent/50`
  const TOOL_DANGER = `${TOOL_BASE} hover:bg-danger/15 hover:text-danger focus-visible:ring-danger/40`

  /** The strip under a cell body: aligned to the code, not to the rule. */
  const FOOTER = 'mt-2.5 flex items-center gap-2 pl-5'
  /** Caps voice for every small label in the sheet. */
  const CAPS = 'text-micro font-bold uppercase tracking-label'
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
      <span
        title={meta.current.execCount === null ? undefined : `Run ${meta.current.execCount}`}
        class={cn(
          'block text-right text-head font-black tabular-nums tracking-tight',
          'transition-colors duration-[var(--speed-quick)]',
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
          'opacity-0 transition-opacity duration-[var(--speed-quick)]',
          'group-hover:opacity-100 focus-within:opacity-100',
          selected && 'opacity-100',
        )}
      >
        {#if isCode}
          <button type="button" class={TOOL} title="Run cell" aria-label="Run cell" onclick={run}>
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
          title="Ask AI about this cell"
          aria-label="Ask AI about this cell"
          onclick={() => askAi('explain')}
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
                'border-l-4 px-3 py-1 transition-colors duration-[var(--speed-quick)]',
                RULE[tone],
                isCode ? 'bg-surface' : 'bg-surface/70',
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
                autoFocus={!isCode && focusOnEdit}
                placeholder={isCode ? '' : 'Write in markdown…'}
                onfocus={() => onselect()}
                onrun={run}
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
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="note" ondblclick={() => enter()}>
              {#if source.current.trim()}
                <Markdown source={source.current} class="text-prose text-muted" />
              {:else}
                <p class="text-prose text-faint">Empty — double-click to write.</p>
              {/if}
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
                    <span class="font-mono text-micro text-faint">{ranByOther}</span>
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
            disabled={session.me.role !== 'host'}
            title={session.me.role === 'host'
              ? 'Stop the running cell'
              : 'Only the host can interrupt the kernel'}
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
      {:else if cellState === 'queued' && queuePosition >= 0}
        <div class={FOOTER}>
          <span
            title="Waiting in the run queue"
            class="inline-flex h-5 items-center bg-raised px-2 font-mono text-micro text-muted"
          >
            {place(queuePosition + 1)} in queue
          </span>
          {#if runBy}
            <span class="text-2xs text-muted">queued by {runBy}</span>
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
   * index.css is shared with the assistant panel, which wants neither, so the
   * notebook's own voice is set here rather than by retuning every reader.
   */
  .note :global(.prose-note h1) {
    @apply text-display font-black text-ink;
  }
  .note :global(.prose-note h2) {
    @apply text-head font-black text-ink;
  }
</style>
