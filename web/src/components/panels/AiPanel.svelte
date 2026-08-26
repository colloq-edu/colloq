<script lang="ts">
  /**
   * The room's assistant thread.
   *
   * Nothing here holds an answer: the server publishes both the question and
   * the streaming reply into the session document, and this panel is a reader
   * of that array like every other browser in the seminar. Which is the point —
   * a question asked in a private tab helps one student and teaches the teacher
   * nothing, so every question is attributed and lands on all screens at once.
   */
  import type * as Y from 'yjs'
  import { getCells, getChat, readChatEntry, type ChatSnapshot } from '@shared/notebook'
  import { actionAllowedIn, type AiAction, type AiAskRequest, type AwarenessUser } from '@shared/protocol'
  import type { AssistantMode } from '@shared/admin'
  import { api } from '@/lib/api'
  import { getSessionState } from '@/lib/session.svelte'
  import { watchCellIds } from '@/lib/yreactive.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Markdown from '@/components/notebook/Markdown.svelte'

  const QUICK: { action: AiAction; label: string }[] = [
    { action: 'explain', label: 'Explain' },
    { action: 'fix', label: 'Fix' },
    { action: 'debug', label: 'Debug' },
    { action: 'improve', label: 'Improve' },
    { action: 'hint', label: 'Hint' },
  ]

  /**
   * How many named chips the SEES row shows before the rest collapse into "+N".
   * Three is what fits on one line at the panel's width without wrapping, and a
   * row that wraps stops being a glanceable one-line answer to "what am I about
   * to send?".
   */
  const MAX_SEES = 3

  /** Rides inside the answer's markdown so it sits right after the last token. */
  const CARET = '<span class="ai-caret" aria-hidden="true"></span>'

  const session = getSessionState()
  const cellIds = watchCellIds(session.doc)
  const chat = getChat(session.doc)
  const isHost = $derived(session.me.role === 'host')

  // Raw: the whole array is rebuilt on every observer fire, so deep-proxying
  // each snapshot would be work spent on objects that are replaced next frame.
  let entries = $state.raw<ChatSnapshot[]>(chat.map(readChatEntry))
  let status = $state<{ enabled: boolean; model: string; mode: AssistantMode } | null>(null)
  let draft = $state('')
  let sendError = $state<string | null>(null)
  let armed = $state(false)
  let pinned = $state(true)
  /** Does any cell in the notebook currently hold a traceback? See the effect. */
  let errored = $state(false)

  let scroller = $state<HTMLDivElement | null>(null)
  let composer = $state<HTMLTextAreaElement | null>(null)

  let composeTimer: number | undefined
  let armTimer: number | undefined
  /** What the room currently believes about us, so we only announce changes. */
  let composingSent = false

  // Optimistic until proven otherwise: a null status means "still checking",
  // and a dead input while a fetch is in flight reads as a broken assistant.
  const offline = $derived(status !== null && !status.enabled)
  /*
   * Hints mode is a real state of the room, not an error to discover by
   * pressing a button. The chips it refuses are not drawn at all — the rule
   * comes from actionAllowedIn, the same function the route refuses with, so
   * the two cannot drift.
   */
  const mode = $derived<AssistantMode>(status?.mode ?? 'full')
  const quickActions = $derived(QUICK.filter((q) => actionAllowedIn(mode, q.action)))
  const hintsOnly = $derived(mode === 'hints')
  const selected = $derived(cellNumber(session.selectedCellId))

  $effect(() => {
    const read = () => (entries = chat.map(readChatEntry))
    read()
    // Deep: an answer streams into a Y.Text *inside* an entry. The array itself
    // only changes when somebody asks something new.
    chat.observeDeep(read)
    return () => chat.unobserveDeep(read)
  })

  $effect(() => {
    let alive = true
    api
      .aiStatus()
      .then((res) => {
        if (alive) status = res
      })
      .catch(() => {
        if (alive) status = { enabled: false, model: '', mode: 'off' }
      })
    return () => {
      alive = false
    }
  })

  /**
   * Whether a traceback would travel with the next question.
   *
   * ai/context.ts pins the newest error cell into the prompt whether or not it
   * is the one the student has selected, so this has to look at the whole
   * notebook. It reads `state`, which the runner sets to 'error' exactly when a
   * cell produces an error output, and subscribes per cell rather than
   * observeDeep-ing the array: a Y.Text edit never reaches its parent map, so
   * typing cannot wake this, and a run writes `state` two or three times.
   */
  $effect(() => {
    // Named so the dependency on the cell sequence is deliberate: a cell added
    // or removed means a different set of maps to listen to.
    void cellIds.current
    const cells = getCells(session.doc).toArray()
    const read = () => (errored = cells.some((cell) => cell.get('state') === 'error'))
    const detach = cells.map((cell) => {
      const onKeys = (event: Y.YMapEvent<any>) => {
        if (event.keysChanged.has('state')) read()
      }
      cell.observe(onKeys)
      return () => cell.unobserve(onKeys)
    })
    read()
    return () => {
      for (const off of detach) off()
    }
  })

  // The notebook asks on the student's behalf from "Ask AI" and "Fix with AI".
  $effect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<{ cellId?: string; action?: AiAction }>).detail
      if (!detail) return
      void ask({
        message: '',
        action: detail.action ?? 'explain',
        cellId: detail.cellId ?? session.selectedCellId,
      })
    }
    window.addEventListener('colloq:ask-ai', onAsk)
    return () => window.removeEventListener('colloq:ask-ai', onAsk)
  })

  $effect(() => () => {
    window.clearTimeout(armTimer)
    // Leaving with text in the box must not leave a ghost typing line behind.
    stopComposing()
  })

  /* -------------------------------------------------------------- reading */

  const avatars = $derived.by(() => {
    const map = new Map<string, string | null>()
    for (const peer of session.peers) {
      if (peer.user.avatar) map.set(peer.user.id, peer.user.avatar)
    }
    return map
  })

  /** One line per person, not per tab — two tabs are still one student. */
  const typing = $derived.by(() => {
    const seen = new Map<string, AwarenessUser>()
    for (const peer of session.peers) {
      if (peer.user.id === session.me.id || !peer.user.composing) continue
      if (!seen.has(peer.user.id)) seen.set(peer.user.id, peer.user)
    }
    return [...seen.values()]
  })

  const typingLine = $derived.by(() => {
    const names = typing.map((user) => user.name)
    if (names.length === 0) return null
    if (names.length === 1) return `${names[0]} is typing a question…`
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing questions…`
    return `${names.length} people are typing questions…`
  })

  /**
   * What the next question will actually carry, named piece by piece.
   *
   * Every chip here is something ai/context.ts demonstrably puts in the prompt:
   * the selected cell, the newest traceback, and the workspace file list. The
   * context also carries the whole notebook and the kernel status, which have
   * no chip because they are unconditional — a chip that is always lit tells a
   * student nothing. Nothing is claimed that this browser cannot verify.
   */
  const sees = $derived.by(() => {
    const chips: { label: string; title: string }[] = []
    if (selected !== null) {
      chips.push({
        label: `cell ${pad(selected)}`,
        title: `Cell ${pad(selected)} — its code and its output go with the question`,
      })
    }
    if (errored) {
      chips.push({ label: 'traceback', title: 'The newest error in this notebook, in full' })
    }

    // Files fill whatever room the cell and traceback chips leave, so a student
    // looking at a failure still sees the failure named first.
    const files = session.files
    const room = Math.max(0, MAX_SEES - chips.length)
    for (const file of files.slice(0, room)) {
      chips.push({ label: file.name, title: `${file.name} — in the workspace listing` })
    }
    const rest = files.slice(room).map((file) => file.name)
    return { chips, rest }
  })

  /**
   * The artboard draws one action chip outlined rather than filled. The only
   * thing that can honestly be "current" in this panel is the action whose
   * answer is still arriving, so that is what lights up.
   */
  const liveAction = $derived.by(() => {
    const tail = entries[entries.length - 1]
    return tail?.state === 'streaming' ? ((tail.action as AiAction | null) ?? null) : null
  })

  function cellNumber(id: string | null | undefined): number | null {
    if (!id) return null
    const index = cellIds.current.indexOf(id)
    return index === -1 ? null : index + 1
  }

  /** Cells are named 01…04 in the gutter; the thread has to agree with it. */
  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }

  function askedLabel(id: string | null): string {
    const n = cellNumber(id)
    return n === null ? 'asked' : `asked about cell ${pad(n)}`
  }

  function clock(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  /* ------------------------------------------------------------- scrolling */

  $effect(() => {
    const tail = entries[entries.length - 1]
    // Depend on the tail's length too, or a streaming answer scrolls out of view.
    void entries.length
    void tail?.answer.length
    if (!pinned || !scroller) return
    const el = scroller
    // After the DOM has the new text, not before.
    requestAnimationFrame(() => {
      if (pinned) el.scrollTop = el.scrollHeight
    })
  })

  function onScroll() {
    if (!scroller) return
    // Reading back through the transcript wins over following the newest answer.
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
  }

  /* ------------------------------------------------------------- composing */

  /**
   * Debounced in both directions: one keystroke should not broadcast, and a
   * pause to think should not yank the line out of everyone else's panel.
   */
  function announceComposing(active: boolean) {
    window.clearTimeout(composeTimer)
    if (active === composingSent) return
    composeTimer = window.setTimeout(
      () => {
        composingSent = active
        session.setComposing(active)
      },
      active ? 220 : 600,
    )
  }

  function stopComposing() {
    window.clearTimeout(composeTimer)
    if (!composingSent) return
    composingSent = false
    session.setComposing(false)
  }

  /* ---------------------------------------------------------------- asking */

  async function ask(body: AiAskRequest) {
    if (offline) return
    stopComposing()
    sendError = null
    pinned = true
    try {
      await api.aiAsk(session.session.id, session.token, body)
    } catch (err) {
      // Verbatim: a 403 ("hints mode…", "switched off…") and a 429 with the
      // minutes until the next question are the server explaining an
      // instance's rules, and paraphrasing them would leave the student
      // guessing at a limit only the server knows.
      sendError = err instanceof Error ? err.message : 'Could not reach the assistant.'
    }
  }

  function submit() {
    const message = draft.trim()
    if (!message) return
    draft = ''
    if (composer) {
      composer.style.height = 'auto'
      composer.focus()
    }
    void ask({ message, action: 'ask', cellId: session.selectedCellId })
  }

  function retry(entry: ChatSnapshot) {
    void ask({
      message: entry.question,
      action: (entry.action as AiAction | null) ?? undefined,
      cellId: entry.cellId,
    })
  }

  async function stop(entryId: string) {
    try {
      await api.aiCancel(session.session.id, session.token, entryId)
    } catch (err) {
      sendError = err instanceof Error ? err.message : 'Could not stop the answer.'
    }
  }

  async function clearThread() {
    // Two-step: this wipes what the whole class asked, and the button sits one
    // pixel from the model name.
    if (!armed) {
      armed = true
      armTimer = window.setTimeout(() => (armed = false), 3000)
      return
    }
    window.clearTimeout(armTimer)
    armed = false
    try {
      await api.aiClearThread(session.session.id, session.token)
    } catch (err) {
      sendError = err instanceof Error ? err.message : 'Could not clear the thread.'
    }
  }

  function onInput(event: Event) {
    const el = event.currentTarget as HTMLTextAreaElement
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    announceComposing(el.value.trim().length > 0)
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    submit()
  }
</script>

<div class="panel h-full">
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
    <Icon name="sparkles" size={14} class="shrink-0 text-accent-text" />
    <span class="shrink-0 text-2xs font-bold uppercase tracking-section text-ink">Assistant</span>
    <span
      class="inline-flex h-5 shrink-0 items-center bg-raised px-1.5 text-2xs font-bold uppercase
             tracking-caps text-ink"
      title="Everyone in this session reads the same thread"
    >
      shared · {entries.length} Q
    </span>

    <span class="ml-auto min-w-0 truncate font-mono text-2xs text-muted">
      <!--
        Only when there is something to name. A header reading "gpt-4o-mini"
        above a panel saying "no model is set up on this Colloq yet" is the
        screen contradicting itself: the model is what the server WOULD use, and
        until it can, saying it is a claim the room cannot act on.
      -->
      {offline ? '' : (status?.model ?? '')}
    </span>

    {#if isHost}
      <button
        type="button"
        class="btn-ghost h-7 shrink-0 gap-1 px-1.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 {armed
          ? 'text-danger hover:text-danger'
          : ''}"
        title="Clear the room's thread"
        aria-label="Clear the room's thread"
        disabled={entries.length === 0}
        onclick={clearThread}
      >
        <Icon name="eraser" size={14} />
        {#if armed}<span>Clear?</span>{/if}
      </button>
    {/if}
  </div>

  <!--
    What the question carries. It sits above the thread rather than inside the
    composer because it is true of every question the room asks, not only the
    one being typed — and because a student has to be able to read it before
    deciding whether to ask here at all.
  -->
  {#if !offline && (sees.chips.length > 0 || sees.rest.length > 0)}
    <div
      class="flex shrink-0 items-center gap-1.5 overflow-hidden border-b border-line bg-raised px-4 py-1.5"
    >
      <span
        class="shrink-0 text-2xs font-bold uppercase tracking-institution text-muted"
        title="Sent with every question: the whole notebook, the kernel status and the workspace file list, plus what is named here"
      >
        Sees
      </span>
      {#each sees.chips as chip (chip.label)}
        <span
          class="inline-flex h-5 shrink-0 items-center bg-line px-1.5 font-mono text-2xs text-muted"
          title={chip.title}
        >
          {chip.label}
        </span>
      {/each}
      {#if sees.rest.length > 0}
        <span
          class="inline-flex h-5 shrink-0 items-center px-1.5 font-mono text-2xs text-muted"
          title={sees.rest.join(', ')}
        >
          +{sees.rest.length}
        </span>
      {/if}
    </div>
  {/if}

  <div bind:this={scroller} onscroll={onScroll} class="min-h-0 flex-1 overflow-y-auto">
    {#if entries.length === 0}
      <p class="px-4 pb-4 pt-3.5 text-2xs text-muted">
        No questions yet. Whatever you ask goes into the room's thread with your name on it, and the
        answer arrives on everyone's screen at once — select a cell first to ask about that cell.
      </p>
    {/if}

    <div class="divide-y divide-line">
      {#each entries as entry (entry.id)}
        {@const mine = entry.participantId === session.me.id}
        <article class="animate-fade-up px-4 py-4">
          <header class="flex items-center gap-2">
            <Avatar
              size="xs"
              name={entry.name}
              color={entry.color}
              avatar={avatars.get(entry.participantId) ?? null}
            />
            <span class="min-w-0 truncate text-2xs font-bold leading-tight text-ink">
              {entry.name}
            </span>
            {#if mine}
              <span class="shrink-0 text-2xs text-muted">you</span>
            {/if}
            <span class="min-w-0 shrink truncate text-2xs text-muted">
              {askedLabel(entry.cellId)}
            </span>
            <time
              class="ml-auto shrink-0 font-mono text-2xs tabular-nums text-muted"
              datetime={new Date(entry.createdAt).toISOString()}
            >
              {clock(entry.createdAt)}
            </time>
          </header>

          <!-- Indented past the avatar, so the thread reads as one column of
               prose with a face in the margin rather than a chat log. -->
          <p class="mt-1.5 whitespace-pre-wrap break-words pl-7 text-ui text-ink">
            {entry.question}
          </p>

          {#if entry.state === 'error'}
            <div class="ml-7 mt-2 border-l-2 border-danger bg-danger/[0.05] px-3 py-2 text-code text-danger">
              <p class="break-words">{entry.answer || 'The assistant did not answer.'}</p>
              <button
                type="button"
                class="mt-2 inline-flex h-6 items-center gap-1 border border-danger/40 px-2 text-2xs font-bold uppercase tracking-caps transition-colors duration-100 hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                onclick={() => retry(entry)}
              >
                <Icon name="restart" size={12} />
                Retry
              </button>
            </div>
          {:else if entry.answer}
            <Markdown
              class="prose-answer mt-2.5 pl-7"
              source={entry.state === 'streaming' ? entry.answer + CARET : entry.answer}
            />
          {:else if entry.state === 'streaming'}
            <div class="mt-2 flex items-center gap-1.5 pl-7 text-2xs text-muted">
              <Icon name="spinner" size={14} class="animate-spin" />
              thinking
            </div>
          {/if}

          {#if entry.state === 'streaming'}
            <button
              type="button"
              class="ml-7 mt-2 inline-flex h-6 items-center gap-1 border border-line px-2 text-2xs font-bold uppercase tracking-caps text-muted transition-colors duration-100 hover:border-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onclick={() => void stop(entry.id)}
            >
              <Icon name="stop" size={12} />
              Stop
            </button>
          {/if}
        </article>
      {/each}
    </div>

    {#if typingLine}
      <div class="flex items-center gap-2 px-4 pb-4 pt-1.5 text-2xs italic text-muted">
        <span class="flex shrink-0 -space-x-1.5">
          {#each typing.slice(0, 3) as user (user.id)}
            <Avatar size="xs" ring name={user.name} color={user.color} avatar={user.avatar} />
          {/each}
        </span>
        <span class="min-w-0 truncate">{typingLine}</span>
      </div>
    {/if}
  </div>

  <div class="flex shrink-0 flex-col gap-2.5 border-t border-line px-4 pb-4 pt-3">
    {#if sendError}
      <div
        class="flex items-start gap-2 border-l-2 border-danger bg-danger/[0.05] px-3 py-2 text-2xs text-danger"
      >
        <span class="min-w-0 flex-1 break-words">{sendError}</span>
        <button
          type="button"
          class="shrink-0 p-0.5 transition-colors duration-100 hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          aria-label="Dismiss"
          onclick={() => (sendError = null)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    {/if}

    <div class="flex flex-wrap items-center gap-1.5">
      {#each quickActions as quick (quick.action)}
        {@const live = liveAction === quick.action}
        <!-- The transparent border on the resting chip keeps the box the same
             size as the outlined one, so nothing shifts when an answer starts. -->
        <button
          type="button"
          class="inline-flex h-6 shrink-0 items-center border px-2 text-2xs font-bold uppercase tracking-caps transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 {live
            ? 'border-accent text-accent-text'
            : 'border-transparent bg-line text-ink hover:border-faint disabled:hover:border-transparent'}"
          disabled={selected === null || offline}
          onclick={() =>
            void ask({ message: '', action: quick.action, cellId: session.selectedCellId })}
        >
          {quick.label}
        </button>
      {/each}
      {#if hintsOnly}
        <span class="text-2xs text-muted">
          hints only — the assistant points, it does not write the answer
        </span>
      {:else if selected === null}
        <span class="text-2xs text-muted">select a cell to use these</span>
      {/if}
    </div>

    {#if offline}
      <!--
        Two different facts wore the same sentence, and it was addressed to
        whoever runs the server while being read by a student who cannot act on
        it. An assistant switched off by the teacher is a decision, not a fault;
        an unconfigured one is a fault, and only staff can do anything about it —
        so only staff are told where.
      -->
      <p class="border border-line bg-raised px-3 py-2 text-2xs text-muted">
        {#if mode === 'off'}
          The assistant is switched off for this seminar.
        {:else if isHost}
          No model is set up on this Colloq yet — add a key under
          <span class="font-semibold text-ink">Assistant</span> in the teaching panel.
        {:else}
          No model is set up on this Colloq yet, so there is nobody to ask here.
        {/if}
      </p>
    {:else}
      <div
        class="flex items-end gap-2 border border-line bg-surface py-1 pl-2 pr-1.5 transition-colors duration-100 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15"
      >
        <!-- Your face before you type, so it is obvious the room will see this. -->
        <Avatar
          class="mb-1"
          size="xs"
          name={session.me.name}
          color={session.me.color}
          avatar={session.me.avatar}
          title="asking as {session.me.name}"
        />
        <textarea
          bind:this={composer}
          bind:value={draft}
          rows="1"
          placeholder={selected === null ? "Ask the room's assistant…" : `Ask about cell ${pad(selected)}…`}
          title="Enter sends, Shift+Enter for a new line"
          class="max-h-40 flex-1 resize-none bg-transparent py-1 text-ui text-ink placeholder:text-muted focus:outline-none"
          oninput={onInput}
          onkeydown={onKeydown}
          onblur={() => {
            if (!draft.trim()) stopComposing()
          }}
        ></textarea>
        <button
          type="button"
          class="btn-primary h-7 w-7 shrink-0 px-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Send"
          disabled={!draft.trim()}
          onclick={submit}
        >
          <Icon name="send" size={14} />
        </button>
      </div>
    {/if}

    <p class="flex items-start gap-1.5 text-2xs text-muted">
      <Icon name="users" size={13} class="mt-px shrink-0" />
      <span>
        The whole room sees your question and the answer — asking here keeps it in the seminar
        instead of a private tab.
      </span>
    </p>
  </div>
</div>

<style>
  /*
   * The caret is inserted into the answer's markdown, which reaches the DOM
   * through {@html} in <Markdown> — outside Svelte's scoping, hence :global.
   */
  @keyframes -global-ai-caret {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.2;
    }
  }

  :global(.ai-caret) {
    display: inline-block;
    /* Sized off the answer's own type so it reads as the next character. */
    width: 0.55em;
    height: 1.05em;
    margin-left: 2px;
    vertical-align: -0.18em;
    background: rgb(var(--accent));
    animation: ai-caret 1.1s ease-in-out infinite;
  }
</style>
