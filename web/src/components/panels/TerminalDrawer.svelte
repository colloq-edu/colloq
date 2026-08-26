<script lang="ts">
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { controlDisabled, controlTitle } from '@/lib/controls'
  import { loadRenderers, renderers, stripAnsi } from '@/lib/render.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { watchNotebookMeta } from '@/lib/yreactive.svelte'
  import { getTerminal, readTerminalLine, type TerminalLineSnapshot } from '@shared/notebook'

  interface Props {
    /** Hides this drawer. It never sends term:close — the shell belongs to the room. */
    onclose: () => void
  }

  let { onclose }: Props = $props()

  const session = getSessionState()
  const notebook = watchNotebookMeta(session.doc)
  /*
   * $derived, not a plain const: the control socket reports the role the server
   * will actually act on as soon as it opens, and a teacher whose token was
   * minted before they signed in arrives here as a participant and is corrected
   * a moment later. A value captured at init would never hear about it.
   */
  const isHost = $derived(session.me.role === 'host')
  const cwd = `/workspace/${session.session.id}`

  /* ------------------------------------------------------------- transcript */

  const terminal = getTerminal(session.doc)
  let lines = $state<TerminalLineSnapshot[]>(terminal.map(readTerminalLine))

  $effect(() => {
    const read = () => (lines = terminal.map(readTerminalLine))
    read()
    // Deep: output streams into the Y.Text *inside* a line, which a shallow
    // observer on the array never hears about.
    terminal.observeDeep(read)
    return () => terminal.unobserveDeep(read)
  })

  type Tab = 'terminal' | 'kernel'
  let tab = $state<Tab>('terminal')

  const shown = $derived(tab === 'terminal' ? lines : lines.filter((l) => l.kind === 'system'))
  const running = $derived(lines.some((l) => l.kind === 'command' && l.running))

  /**
   * pip and friends redraw one line in place with \r; keeping every frame would
   * print a hundred copies of the same progress bar.
   */
  function collapseCarriage(raw: string): string {
    const text = raw.replace(/\n+$/, '')
    if (!text.includes('\r')) return text
    return text
      .split('\n')
      .map((line) => {
        let last = ''
        for (const frame of line.split('\r')) if (frame !== '') last = frame
        return last
      })
      .join('\n')
  }

  /* The ANSI parser and the sanitizer are fetched with the notebook's renderers
     rather than at app start. Until they land the transcript still reads — the
     escape codes are dropped and the text goes out as text, which is what a
     student watching pip install actually needs. */
  loadRenderers()

  const render = $derived(renderers())

  const clock = (ts: number) =>
    new Date(ts).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

  /* --------------------------------------------------------------- elapsed */

  let now = $state(Date.now())

  $effect(() => {
    if (!running) return
    const id = window.setInterval(() => (now = Date.now()), 200)
    return () => window.clearInterval(id)
  })

  function elapsed(since: number): string {
    const seconds = Math.max(0, now - since) / 1000
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    return `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
  }

  /* -------------------------------------------------------------- scrolling */

  let scroller: HTMLDivElement | null = $state(null)
  let pinned = $state(true)

  function onScroll(): void {
    if (!scroller) return
    // Reading back is how a terminal earns trust: never yank someone to the end.
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 28
  }

  /** Changes whenever a line is added *or* text streams into an existing one. */
  const transcriptSize = $derived(lines.reduce((n, line) => n + line.text.length, lines.length))

  $effect(() => {
    void transcriptSize
    void tab
    if (!scroller || !pinned) return
    scroller.scrollTop = scroller.scrollHeight
  })

  /* ---------------------------------------------------------------- height */

  const HEIGHT_KEY = 'colloq.terminal.height.v1'
  /*
   * The drawer is a drawer, not a second window: below 140px it holds fewer
   * lines than a prompt plus its answer, and above 460px it starts taking the
   * notebook's half of a laptop screen. The remembered height is clamped into
   * this on the way in, so an old value from a big monitor cannot swallow a
   * small one.
   */
  const MIN_H = 140
  const MAX_H = 460

  const clamp = (px: number) =>
    Number.isFinite(px) ? Math.min(MAX_H, Math.max(MIN_H, Math.round(px))) : 260

  function loadHeight(): number {
    try {
      const raw = localStorage.getItem(HEIGHT_KEY)
      if (raw) return clamp(Number(raw))
    } catch {
      /* private browsing; the default height is fine */
    }
    return 260
  }

  let height = $state(loadHeight())

  function persistHeight(): void {
    try {
      localStorage.setItem(HEIGHT_KEY, String(height))
    } catch {
      /* ignore */
    }
  }

  function startResize(event: PointerEvent): void {
    const grip = event.currentTarget as HTMLElement
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    grip.setPointerCapture(event.pointerId)

    // Dragging upwards grows the drawer, hence the inverted delta.
    const move = (e: PointerEvent) => (height = clamp(startHeight - (e.clientY - startY)))
    const stop = () => {
      grip.releasePointerCapture(event.pointerId)
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', stop)
      grip.removeEventListener('pointercancel', stop)
      persistHeight()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
    grip.addEventListener('pointercancel', stop)
  }

  function gripKeys(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    height = clamp(height + (event.key === 'ArrowUp' ? 24 : -24))
    persistHeight()
  }

  /* ---------------------------------------------------------------- prompt */

  let input: HTMLInputElement | null = $state(null)
  let command = $state('')
  /** Only this person's commands: a shared history would be unusable in a room. */
  let history: string[] = []
  let historyAt = -1
  let draft = ''

  const status = $derived(session.terminalStatus)
  // A command has to reach the server to be a command. Disconnected, the status
  // in hand is the last one the server sent, which says nothing about now.
  const canType = $derived(session.connected && (status === 'idle' || status === 'busy'))

  const placeholder = $derived(
    !session.connected
      ? 'waiting for the connection…'
      : status === 'starting'
        ? 'starting the shell…'
        : status === 'dead'
          ? 'the shell stopped'
          : status === 'closed'
            ? 'the shell is not running'
            : 'pip install seaborn',
  )

  function submit(): void {
    const value = command.trim()
    if (!value || !canType) return
    session.send({ t: 'term:run', command: value })
    history = [value, ...history.filter((entry) => entry !== value)].slice(0, 100)
    historyAt = -1
    draft = ''
    command = ''
    pinned = true
  }

  function recall(step: 1 | -1): void {
    if (history.length === 0) return
    if (historyAt === -1 && step === 1) draft = command
    const next = historyAt + step
    if (next < -1) return
    historyAt = Math.min(next, history.length - 1)
    command = historyAt === -1 ? draft : history[historyAt]
    // Land the caret at the end of the recalled line, the way a shell does.
    queueMicrotask(() => input?.setSelectionRange(command.length, command.length))
  }

  function onPromptKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // In a prompt, Escape belongs to the shell: it clears the line you are
      // typing. Closing the drawer out from under someone mid-command would be
      // the wrong reading of the same key — that is what the handler below is
      // for, and it deliberately ignores the prompt.
      const target = event.currentTarget as HTMLInputElement
      if (target.value) {
        event.preventDefault()
        event.stopPropagation()
        command = ''
        // Back to the live line, so the next ArrowUp starts from the top of the
        // history rather than the middle of the recall you just abandoned.
        historyAt = -1
        draft = ''
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
      return
    }
    if (event.key === 'c' && event.ctrlKey) {
      // Copying a selection wins; an empty selection means "stop that command".
      const target = event.currentTarget as HTMLInputElement
      if (target.selectionStart !== target.selectionEnd) return
      event.preventDefault()
      session.send({ t: 'term:interrupt' })
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      recall(1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      recall(-1)
    }
  }

  // Presence must not stay stuck on "in the terminal" when the drawer unmounts.
  $effect(() => () => session.setInTerminal(false))
</script>

<!--
  Escape closes the drawer, unless the prompt has something in it — that case is
  handled above, where the key means "clear this line".
-->
<svelte:window
  onkeydown={(event) => {
    if (event.key !== 'Escape') return
    if (event.defaultPrevented) return
    onclose()
  }}
/>

<!--
  The drawer paints from its own variables instead of the global tokens on
  purpose: the shell has to read as "the machine" in either theme, and a
  terminal that turns pale in light mode stops looking like one.
-->
<section class="term" style="height: {height}px" aria-label="Shared terminal">
  <div
    class="term-grip"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize the terminal"
    aria-valuenow={height}
    aria-valuemin={MIN_H}
    aria-valuemax={MAX_H}
    tabindex="0"
    title="Drag to resize"
    onpointerdown={startResize}
    onkeydown={gripKeys}
  >
    <span class="term-grip-bar"></span>
  </div>

  <div class="term-tabs">
    <button
      type="button"
      class="term-tab"
      class:on={tab === 'terminal'}
      aria-pressed={tab === 'terminal'}
      onclick={() => (tab = 'terminal')}
    >
      Terminal
      {#if running}<span class="term-live-dot"></span>{/if}
    </button>
    <button
      type="button"
      class="term-tab"
      class:on={tab === 'kernel'}
      aria-pressed={tab === 'kernel'}
      onclick={() => (tab = 'kernel')}
    >
      Kernel log
    </button>

    <span class="term-badge" title="Everyone in the seminar sees this terminal">
      Shared with the room
    </span>

    <span class="term-cwd" title={cwd}>{cwd}</span>

    {#if isHost}
      <button
        type="button"
        class="term-act"
        disabled={controlDisabled(session.connected)}
        title={controlTitle(session.connected, 'Clear the transcript for everyone')}
        onclick={() => session.send({ t: 'term:clear' })}
      >
        <Icon name="eraser" size={12} />
        Clear
      </button>
    {/if}

    <button
      type="button"
      class="term-act"
      aria-label="Hide the terminal"
      title="Hide the terminal — the shell keeps running (Ctrl+`)"
      onclick={onclose}
    >
      <Icon name="x" size={14} />
    </button>
  </div>

  <div class="term-body" bind:this={scroller} onscroll={onScroll} role="log" aria-live="polite">
    {#if tab === 'kernel'}
      <div class="term-sys">
        python kernel · {notebook.current.kernelStatus} — terminal · {status}
      </div>
    {/if}

    {#if shown.length === 0}
      <p class="term-empty">
        {#if tab === 'terminal'}
          This shell runs in the same container as the kernel, so
          <code>pip install pandas</code> here changes the environment for every cell and everyone in
          the room. <code>!pip install pandas</code> inside a cell does exactly the same thing.
        {:else}
          Nothing logged yet. Kernel starts, restarts and crashes show up here.
        {/if}
      </p>
    {/if}

    {#each shown as line (line.id)}
      {#if line.kind === 'command'}
        <div class="term-row">
          <span class="term-av">
            <Avatar
              name={line.name ?? 'Someone'}
              color={line.color ?? 'var(--tm-muted)'}
              size="xs"
              class="!h-[14px] !w-[14px] !text-micro"
              title="{line.name ?? 'Someone'} ran this"
            />
          </span>
          <span class="term-sigil">$</span>
          <span class="term-cmd">{line.text}</span>
          {#if line.running}
            <span class="term-live">
              <span class="term-live-dot"></span>
              {elapsed(line.createdAt)}
            </span>
          {/if}
        </div>
      {:else if line.kind === 'output'}
        {@const text = collapseCarriage(line.text)}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in lib/render -->
        <pre class="term-out">{#if render}{@html render.ansi(text)}{:else}{stripAnsi(text)}{/if}</pre>
      {:else}
        <div class="term-sys">
          {#if tab === 'kernel'}<span class="term-time">{clock(line.createdAt)}</span>{/if}
          {line.text}
        </div>
      {/if}
    {/each}
  </div>

  <div class="term-prompt" class:off={!canType}>
    <span class="term-av">
      <Avatar
        name={session.me.name}
        color={session.me.color}
        avatar={session.me.avatar}
        size="xs"
        class="!h-[14px] !w-[14px] !text-micro"
        title="{session.me.name} (you)"
      />
    </span>
    <span class="term-sigil">$</span>
    <input
      bind:this={input}
      bind:value={command}
      class="term-input"
      type="text"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      aria-label="Run a shell command for the whole room"
      {placeholder}
      disabled={!canType}
      onkeydown={onPromptKey}
      onfocus={() => session.setInTerminal(true)}
      onblur={() => session.setInTerminal(false)}
    />
    <!-- A block cursor only while the line is empty, so it never fights the real caret. -->
    {#if canType && command.length === 0}
      <span class="term-caret"></span>
    {/if}
    <span class="term-hint">
      {#if status === 'busy'}
        <span class="term-live-dot"></span>
        ctrl-c stops it
      {:else if canType}
        ↑ history
      {:else}
        {status}
      {/if}
    </span>
  </div>
</section>

<style>
  .term {
    /*
     * A local palette instead of the global tokens: the brand navy pushed down
     * to a near-black blue, so the slab stays dark in the light theme too. A
     * terminal that follows the app's ground stops reading as "the machine".
     */
    --tm-bg: #050b1c;
    --tm-raised: #0b1531;
    --tm-edge: #17244a;
    --tm-ink: #e4e8f2;
    --tm-muted: #99a5be;
    /*
     * Raised from #5f6b85, which measured 3.37:1 on the tab bar and 3.67:1 on
     * the transcript — under AA, and unnoticed for as long as it was, because
     * the drawer is shut by default and no contrast pass had ever opened it.
     * This clears 4.8:1 on both grounds and still sits 3.15:1 below --tm-ink,
     * so it reads as the quiet tier rather than as body text.
     */
    --tm-faint: #78849f;
    --tm-accent: #2eb4e8;
    --tm-live: #3ec9a7;
    --tm-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    --tm-sans: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    /* Output aligns under the command text, not under the avatar. */
    --tm-indent: 38px;

    position: relative;
    z-index: 20;
    display: flex;
    min-height: 0;
    /* A remembered height must never squeeze the notebook off a short screen. */
    max-height: 62%;
    flex: none;
    flex-direction: column;
    background: var(--tm-bg);
    color: var(--tm-ink);
    border-top: 1px solid var(--tm-edge);
    box-shadow: 0 -20px 40px -30px rgb(0 0 0 / 0.85);
  }

  .term-grip {
    display: flex;
    height: 7px;
    flex: none;
    align-items: center;
    justify-content: center;
    cursor: row-resize;
    touch-action: none;
    background: var(--tm-bg);
  }
  .term-grip-bar {
    height: 2px;
    width: 42px;
    border-radius: 999px;
    background: var(--tm-edge);
    transition: background-color 100ms ease;
  }
  .term-grip:hover .term-grip-bar,
  .term-grip:focus-visible .term-grip-bar {
    background: var(--tm-accent);
  }
  .term-grip:focus-visible {
    outline: none;
  }

  .term-tabs {
    display: flex;
    height: 30px;
    flex: none;
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 10px;
    border-bottom: 1px solid var(--tm-edge);
    background: var(--tm-raised);
  }

  .term-tab {
    display: inline-flex;
    height: 100%;
    flex: none;
    align-items: center;
    gap: 5px;
    padding: 0 2px;
    font-family: var(--tm-sans);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--tm-faint);
    border-bottom: 1.5px solid transparent;
    transition: color 100ms ease;
  }
  .term-tab:hover {
    color: var(--tm-muted);
  }
  .term-tab.on {
    color: var(--tm-ink);
    border-bottom-color: var(--tm-accent);
  }

  .term-badge {
    flex: none;
    border-radius: 4px;
    padding: 2px 6px;
    font-family: var(--tm-sans);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--tm-accent);
    background: rgb(46 180 232 / 0.14);
  }

  .term-cwd {
    margin-left: auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--tm-mono);
    font-size: 10.5px;
    color: var(--tm-faint);
  }

  /* Narrow drawers drop the path before they drop the badge: the shared warning
     matters more than knowing the working directory. */
  @media (max-width: 720px) {
    .term-cwd {
      display: none;
    }
    .term-badge {
      margin-left: auto;
    }
  }

  .term-act {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 4px;
    border-radius: 6px;
    padding: 3px 6px;
    font-family: var(--tm-sans);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--tm-faint);
    transition:
      color 100ms ease,
      background-color 100ms ease;
  }
  .term-act:hover:not(:disabled) {
    color: var(--tm-ink);
    background: rgb(255 255 255 / 0.06);
  }
  .term-act:disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .term-act:focus-visible,
  .term-tab:focus-visible {
    outline: 2px solid var(--tm-accent);
    outline-offset: -2px;
  }

  .term-body {
    min-height: 0;
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px 12px 10px;
    font-family: var(--tm-mono);
    font-size: 12.5px;
    line-height: 1.55;
  }

  .term-empty {
    max-width: 68ch;
    padding: 4px 0 0 var(--tm-indent);
    font-family: var(--tm-sans);
    font-size: 12px;
    line-height: 1.65;
    color: var(--tm-faint);
  }
  .term-empty code {
    font-family: var(--tm-mono);
    font-size: 11.5px;
    color: var(--tm-muted);
  }

  .term-row {
    display: flex;
    align-items: flex-start;
    padding-top: 2px;
  }

  /* Fixed columns in both the transcript and the prompt row, so every command
     starts at exactly --tm-indent. */
  .term-av {
    display: flex;
    height: 19px;
    width: 14px;
    flex: none;
    align-items: center;
    margin-right: 8px;
  }
  .term-sigil {
    width: 10px;
    flex: none;
    margin-right: 6px;
    font-family: var(--tm-mono);
    color: var(--tm-accent);
  }
  .term-cmd {
    min-width: 0;
    flex: 1 1 auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--tm-ink);
  }

  .term-live {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 5px;
    padding-left: 10px;
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    color: var(--tm-live);
  }
  .term-live-dot {
    height: 5px;
    width: 5px;
    flex: none;
    border-radius: 999px;
    background: var(--tm-live);
    animation: tmblink 1.1s ease-in-out infinite;
  }

  .term-out {
    margin: 0;
    padding-left: var(--tm-indent);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--tm-mono);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--tm-muted);
  }

  .term-sys {
    padding-left: var(--tm-indent);
    font-style: italic;
    color: var(--tm-faint);
  }
  .term-time {
    margin-right: 8px;
    font-style: normal;
    color: rgb(255 255 255 / 0.22);
  }

  .term-prompt {
    display: flex;
    flex: none;
    align-items: center;
    border-top: 1px solid var(--tm-edge);
    padding: 7px 12px;
    background: var(--tm-bg);
    font-family: var(--tm-mono);
    font-size: 12.5px;
    transition: background-color 100ms ease;
  }
  .term-prompt.off {
    opacity: 0.55;
  }
  .term-prompt:focus-within {
    background: var(--tm-raised);
  }

  .term-input {
    min-width: 0;
    flex: 1 1 auto;
    border: 0;
    background: transparent;
    color: var(--tm-ink);
    caret-color: var(--tm-accent);
    font-family: var(--tm-mono);
    font-size: 12.5px;
  }
  .term-input::placeholder {
    color: var(--tm-faint);
  }
  .term-input:focus {
    outline: none;
  }
  .term-input:disabled {
    cursor: not-allowed;
  }

  .term-caret {
    height: 14px;
    width: 7px;
    flex: none;
    margin-left: -2px;
    background: var(--tm-accent);
    opacity: 0.75;
    animation: tmblink 1.1s ease-in-out infinite;
  }

  .term-hint {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 5px;
    padding-left: 10px;
    font-family: var(--tm-sans);
    font-size: 10px;
    color: var(--tm-faint);
  }

  @keyframes tmblink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.25;
    }
  }
</style>
