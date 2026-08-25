<script lang="ts">
  import { tick } from 'svelte'
  import type { CellType } from '@shared/notebook'
  import Icon from '@/components/ui/Icon.svelte'
  import { deleteCell, insertCell, setCellType } from '@/lib/notebook-ops'
  import { getSessionState } from '@/lib/session.svelte'
  import { cn } from '@/lib/utils'
  import { watchCellIds, watchNotebookMeta } from '@/lib/yreactive.svelte'
  import CellView from './CellView.svelte'

  interface Props {
    /** The shared terminal drawer, whose tab VH-0 draws at the end of this bar. */
    terminalOpen?: boolean
    ontoggleterminal?: () => void
  }

  let { terminalOpen = false, ontoggleterminal }: Props = $props()

  const session = getSessionState()
  const ids = watchCellIds(session.doc)
  const notebook = watchNotebookMeta(session.doc)

  const isHost = session.me.role === 'host'
  const kernel = $derived(notebook.current.kernelStatus)
  const queued = $derived(notebook.current.queue.length)

  /* --------------------------------------------------------- navigation */

  function reveal(id: string) {
    document.querySelector(`[data-cell-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  function select(id: string) {
    session.selectCell(id)
    // Keyboard navigation must not walk the selection off screen — and the
    // target may have been parked, so let it take its real height first.
    void tick().then(() => reveal(id))
  }

  function enter(id: string) {
    window.dispatchEvent(new CustomEvent('colloq:enter-cell', { detail: { cellId: id } }))
  }

  async function addAt(index: number, type: CellType) {
    const created = insertCell(session.doc, type, index)
    select(created)
    // The new cell has to exist in the DOM before it can take focus.
    await tick()
    enter(created)
  }

  /** A cell handing off to its neighbour; only this component knows the order. */
  $effect(() => {
    const onStep = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          cellId: string
          direction: -1 | 1
          focus?: boolean
          fallback?: boolean
        }>
      ).detail
      if (!detail) return
      const list = ids.current
      const from = list.indexOf(detail.cellId)
      if (from === -1) return
      const back = detail.fallback ? list[from - detail.direction] : undefined
      const target = list[from + detail.direction] ?? back
      if (!target) return
      select(target)
      if (detail.focus !== false) enter(target)
    }
    window.addEventListener('colloq:step-cell', onStep)
    return () => window.removeEventListener('colloq:step-cell', onStep)
  })

  /* ----------------------------------------------------------- viewport */

  /**
   * Every mounted code cell is a CodeMirror instance, and a seminar notebook is
   * tens of them. Cells far outside the viewport keep their component — and
   * every Yjs subscription with it — but swap the editor and the outputs for a
   * placeholder the height of what they last measured, so the scrollbar stays
   * honest and coming back is a render rather than a rebuild.
   *
   * A cell the observer has not ruled on yet falls back to its position, which
   * is what keeps a cold start from building forty editors before the first
   * IntersectionObserver callback lands.
   */
  const EAGER = 10
  const NEAR_MARGIN = '1200px 0px'

  let ruling = $state.raw(new Map<string, boolean>())

  const viewport =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            let next: Map<string, boolean> | null = null
            for (const entry of entries) {
              const id = (entry.target as HTMLElement).dataset.cellSlot
              if (!id || ruling.get(id) === entry.isIntersecting) continue
              next ??= new Map(ruling)
              next.set(id, entry.isIntersecting)
            }
            if (next) ruling = next
          },
          { rootMargin: NEAR_MARGIN },
        )

  $effect(() => () => viewport?.disconnect())

  function isNear(id: string, index: number): boolean {
    return ruling.get(id) ?? index < EAGER
  }

  function slot(node: HTMLElement, id: string) {
    node.dataset.cellSlot = id
    viewport?.observe(node)
    return {
      destroy() {
        viewport?.unobserve(node)
        // In place on purpose: a ruling for a cell that no longer exists cannot
        // change anything on screen and must not schedule a render.
        ruling.delete(id)
      },
    }
  }

  /* ----------------------------------------------------------- keyboard */

  /** Two taps of D delete; the chord expires so a stray D is never destructive. */
  const CHORD_MS = 700
  let armedDeleteAt = 0

  /** True when the keystroke already belongs to whatever has focus. */
  function claimedByFocus(target: EventTarget | null, key: string): boolean {
    const element = target as HTMLElement | null
    if (!element || typeof element.closest !== 'function') return false
    if (element.isContentEditable) return true
    const tag = element.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (element.closest('.cm-editor')) return true
    // A focused control activates on Enter/Space; navigation must not eat that.
    return (key === 'Enter' || key === ' ') && element.closest('button, a, [role="button"]') !== null
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if (claimedByFocus(event.target, event.key)) return

    const list = ids.current
    if (list.length === 0) return
    const current = session.selectedCellId
    const at = current ? list.indexOf(current) : -1

    if (event.key === 'Enter' && event.shiftKey) {
      if (!current) return
      event.preventDefault()
      session.send({ t: 'run', cellId: current })
      return
    }
    if (event.shiftKey) return

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault()
        select(list[at <= 0 ? 0 : at - 1])
        break
      case 'ArrowDown':
        event.preventDefault()
        select(list[at < 0 ? 0 : Math.min(at + 1, list.length - 1)])
        break
      case 'Enter':
        if (!current) return
        event.preventDefault()
        enter(current)
        break
      case 'a':
        event.preventDefault()
        void addAt(at < 0 ? 0 : at, 'code')
        break
      case 'b':
        event.preventDefault()
        void addAt(at < 0 ? list.length : at + 1, 'code')
        break
      case 'm':
        if (!current) return
        event.preventDefault()
        setCellType(session.doc, current, 'markdown')
        break
      case 'y':
        if (!current) return
        event.preventDefault()
        setCellType(session.doc, current, 'code')
        break
      case 'd': {
        if (!current) return
        event.preventDefault()
        const now = Date.now()
        if (now - armedDeleteAt < CHORD_MS) {
          armedDeleteAt = 0
          const next = list[at + 1] ?? list[at - 1] ?? null
          deleteCell(session.doc, current)
          if (next) select(next)
        } else {
          armedDeleteAt = now
        }
        break
      }
      default:
        return
    }
    if (event.key !== 'd') armedDeleteAt = 0
  }

  /* Both adders speak the artboard's caps voice; the inline one sits on a
     raised ground because it lands on top of the hairline it interrupts. */
  const ADD_LABEL = 'text-micro font-bold uppercase tracking-label'
  const ADD =
    `inline-flex h-6 items-center gap-1.5 border border-line bg-canvas px-2.5 ${ADD_LABEL} ` +
    'text-muted transition-colors duration-[var(--speed-quick)] hover:text-ink ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'

  /*
   * The run bar is four caps-tracked words, and only the first one is filled.
   * The artboard runs each button the full height of the bar with no rounding
   * and no border, so the hover ground is the whole slot rather than a pill
   * floating inside it.
   */
  const CAP =
    'inline-flex h-full items-center px-4 text-2xs font-semibold uppercase tracking-label ' +
    'text-ink transition-colors duration-[var(--speed-quick)] hover:bg-raised ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ' +
    'focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-40'

  /** Bordered, square, mono: the voice every status readout in the sheet uses. */
  const PILL = 'inline-flex h-6 shrink-0 items-center gap-2 border px-2.5 font-mono'

  /** Same button, at the foot of the sheet, where nothing needs to hide a rule. */
  const ADD_FOOT =
    `inline-flex h-6 items-center gap-1.5 border border-line px-2.5 ${ADD_LABEL} text-muted ` +
    'transition-colors duration-[var(--speed-quick)] hover:text-ink ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
</script>

<svelte:window {onkeydown} />

{#snippet adder(index: number)}
  <div class="group/add relative flex h-6 items-center justify-center">
    <div
      class="pointer-events-none absolute left-12 right-0 top-1/2 h-px bg-line-soft opacity-0
             transition-opacity duration-[var(--speed-quick)] group-hover/add:opacity-100"
    ></div>
    <div
      class="relative flex items-center gap-1 opacity-0 transition-opacity
             duration-[var(--speed-quick)] focus-within:opacity-100 group-hover/add:opacity-100"
    >
      <button type="button" class={ADD} title="Insert code cell" onclick={() => addAt(index, 'code')}>
        <Icon name="plus" size={11} />
        Code
      </button>
      <button
        type="button"
        class={ADD}
        title="Insert a text cell — markdown"
        onclick={() => addAt(index, 'markdown')}
      >
        <Icon name="plus" size={11} />
        Text
      </button>
    </div>
  </div>
{/snippet}

<div class="mx-auto w-full max-w-[900px] px-4 pb-40">
  <div
    class="sticky top-0 z-30 -mx-4 mb-4 flex h-10 items-center border-b border-line
           bg-canvas/95 backdrop-blur"
  >
    <button
      type="button"
      class="inline-flex h-full items-center gap-2 bg-primary px-5 text-2xs font-bold uppercase
             tracking-label text-primary-ink transition-opacity duration-[var(--speed-quick)]
             hover:opacity-90 focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-primary-ink/60"
      title="Run every code cell"
      onclick={() => session.send({ t: 'runAll' })}
    >
      <Icon name="play" size={12} />
      Run all
    </button>
    <button
      type="button"
      class={CAP}
      disabled={!isHost}
      title={isHost ? 'Stop the running cell' : 'Only the host can interrupt the kernel'}
      onclick={() => session.send({ t: 'interrupt' })}
    >
      Interrupt
    </button>
    <button
      type="button"
      class={CAP}
      disabled={!isHost}
      title={isHost
        ? 'Restart the kernel — every variable is lost'
        : 'Only the host can restart the kernel'}
      onclick={() => session.send({ t: 'restart' })}
    >
      Restart
    </button>
    <button
      type="button"
      class={CAP}
      title="Clear every output"
      onclick={() => session.send({ t: 'clearOutputs' })}
    >
      Clear
    </button>

    {#if ontoggleterminal}
      <!--
        A tab, not a button: VH-0 draws the open terminal as the selected tab of
        this bar, sitting on the drawer it opened. Closed, it is the same slot
        with the bar's own voice, so the row keeps its shape either way.
      -->
      <button
        type="button"
        class={cn(
          CAP,
          'gap-2 border-b-2',
          terminalOpen ? 'border-brand bg-raised text-ink' : 'border-transparent text-muted',
        )}
        aria-pressed={terminalOpen}
        title="Shared terminal — Ctrl+`"
        onclick={ontoggleterminal}
      >
        <Icon name="prompt" size={12} />
        Terminal
        {#if session.terminalStatus === 'busy'}
          <span class="h-1.5 w-1.5 animate-blink rounded-full bg-accent"></span>
        {:else}
          <span class="hidden font-mono text-micro text-faint xl:inline">⌃`</span>
        {/if}
      </button>
    {/if}

    <div class="ml-auto flex items-center gap-2.5">
      <!--
        The artboard's run bar carries the queue and the cell count and nothing
        else — a healthy kernel is reported in the masthead. An unhealthy one is
        not reported anywhere else yet, so it keeps its pill here.
      -->
      {#if kernel === 'dead'}
        <span class={cn(PILL, 'border-danger/40 bg-danger/10 text-2xs text-danger')}>
          <span class="h-1.5 w-1.5 rounded-full bg-danger"></span>
          kernel dead
          {#if isHost}
            <button
              type="button"
              class="text-micro font-bold uppercase tracking-label text-ink
                     transition-opacity duration-[var(--speed-quick)] hover:opacity-70
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
              onclick={() => session.send({ t: 'restart' })}
            >
              Restart
            </button>
          {/if}
        </span>
      {:else if kernel === 'starting' || kernel === 'restarting'}
        <!-- Opacity, not a background sweep: the same information for one
             composited property instead of a repaint every frame. -->
        <span class={cn(PILL, 'animate-pulse border-line text-2xs text-muted')}>
          <span class="h-1.5 w-1.5 rounded-full bg-faint"></span>
          {kernel === 'starting' ? 'starting…' : 'restarting…'}
        </span>
      {/if}

      {#if queued > 0}
        <span
          class={cn(PILL, 'border-line text-micro text-muted')}
          title="Cells waiting for the kernel"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-muted"></span>
          {queued} queued
        </span>
      {/if}
      <span class="pl-0.5 pr-5 font-mono text-micro text-faint">
        {ids.current.length}
        {ids.current.length === 1 ? 'cell' : 'cells'}
      </span>
    </div>
  </div>

  {#each ids.current as id, index (id)}
    {@render adder(index)}
    <div use:slot={id}>
      <CellView
        {id}
        {index}
        selected={session.selectedCellId === id}
        near={isNear(id, index)}
        onselect={() => session.selectCell(id)}
      />
    </div>
  {/each}

  {@render adder(ids.current.length)}

  <div class={cn('mt-1 flex items-center gap-3 pl-12', ids.current.length === 0 && 'mt-8')}>
    <button
      type="button"
      class={ADD_FOOT}
      title="Add a code cell at the end"
      onclick={() => addAt(ids.current.length, 'code')}
    >
      <Icon name="plus" size={11} />
      Code
    </button>
    <button
      type="button"
      class={ADD_FOOT}
      title="Add a text cell at the end — markdown"
      onclick={() => addAt(ids.current.length, 'markdown')}
    >
      <Icon name="text" size={11} />
      Text
    </button>
    <div class="h-px flex-1 bg-line-soft"></div>
    <span class="hidden shrink-0 font-mono text-micro text-faint sm:inline">
      A / B to insert · ⇧↵ to run
    </span>
  </div>
</div>
