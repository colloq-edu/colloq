<script lang="ts">
  /**
   * The seminar itself: the room, and the three things around it.
   *
   * The layout is one decision repeated — the notebook is the page, and Files,
   * People and the oracle are what it is surrounded by. Below about 1100px
   * the oracle folds into a button in the top bar and below about 700px the
   * left rail follows it, each opening as a panel over the room that closes on
   * Escape, on a click outside, or on the button that opened it. Nothing here
   * scrolls the page sideways at any width.
   *
   * This screen owns no seminar state. Everything it draws — the title, who is
   * here, the kernel's mood, the queue — is read from the shared document or
   * from awareness, so what it shows is what everybody else is looking at.
   */
  import { onDestroy } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import { fade, fly } from 'svelte/transition'
  import { peopleInRoom } from '@/lib/room'
  import { gridFaviconHref } from '@/lib/logo'
  import AvatarStack from '@/components/ui/AvatarStack.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Notebook from '@/components/notebook/Notebook.svelte'
  import AiPanel from '@/components/panels/AiPanel.svelte'
  import FilesPanel from '@/components/panels/FilesPanel.svelte'
  import PeoplePanel from '@/components/panels/PeoplePanel.svelte'
  import TerminalDrawer from '@/components/panels/TerminalDrawer.svelte'
  import ThemeSwitch from '@/components/ui/ThemeSwitch.svelte'
  import Wordmark from '@/components/ui/Wordmark.svelte'
  import type { StoredIdentity } from '@/lib/identity'
  import { SessionState, setSessionState } from '@/lib/session.svelte'
  import { cn, prefersReducedMotion } from '@/lib/utils'
  import { watchNotebookMeta } from '@/lib/yreactive.svelte'
  import { getMeta, type KernelStatus } from '@shared/notebook'
  import type { SessionInfo } from '@shared/protocol'

  interface Props {
    session: SessionInfo
    identity: StoredIdentity
  }

  let { session: info, identity }: Props = $props()

  // Context can only be written during initialisation, so the live session is
  // built here rather than in the router — by now both the room and the person
  // are known, and every panel below reads it with getSessionState().
  // Reading the props once is the point: rebuilding SessionState would drop the
  // local CRDT and every keystroke that has not synced yet. The router remounts
  // this component when the room or the person actually changes.
  // svelte-ignore state_referenced_locally
  const session = new SessionState(info, identity)
  setSessionState(session)
  onDestroy(() => session.destroy())

  const meta = watchNotebookMeta(session.doc)
  const storedTitle = $derived(meta.current.title)
  const title = $derived(storedTitle || info.name)
  const isHost = $derived(session.me.role === 'host')

  $effect(() => {
    document.title = `${title} · Colloq`
    return () => {
      document.title = 'Colloq'
    }
  })

  /* ------------------------------------------------------------- masthead */

  // DD.MM beside the seminar name, as the artboard sets it: in a room you are
  // standing in the year is noise. The full date stays in the tooltip.
  // Read once, like the session above: the router remounts this component when
  // the room changes, so a room's start date cannot change under it.
  // svelte-ignore state_referenced_locally
  const started = new Date(info.createdAt)
  const dateShort = `${String(started.getDate()).padStart(2, '0')}.${String(
    started.getMonth() + 1,
  ).padStart(2, '0')}`
  const dateLong = started.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  /*
   * People, not sockets. Keyed on the client id this counted a second tab as a
   * second student, so the bar could say "4 in the room" above a list of three
   * — with one of them printed twice. The participant id is also the steadier
   * face: it survives a reconnect, where the client id does not.
   */
  /*
   * A mark per seminar, in the tab bar.
   *
   * The grid is derived from the session id, so it is the same for everybody in
   * the room and the same next week; a teacher with back-to-back seminars open
   * can tell the tabs apart at 16px, which is the whole reason a logo is
   * allowed to change at all. Restored on the way out so the join screen and
   * the panel keep the brand's own mark.
   */
  $effect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) return
    const brand = link.getAttribute('href')
    link.setAttribute('href', gridFaviconHref(session.session.id))
    return () => {
      if (brand) link.setAttribute('href', brand)
    }
  })

  const inRoom = $derived(peopleInRoom(session.peers))
  const room = $derived(
    inRoom.map((person) => ({
      id: person.user.id,
      name: person.user.name,
      avatar: person.user.avatar,
      color: person.user.color,
      title: person.isSelf ? `${person.user.name} (you)` : person.user.name,
    })),
  )
  const roomNames = $derived(
    inRoom.map((person) => (person.isSelf ? `${person.user.name} (you)` : person.user.name)).join(', '),
  )

  /*
   * The live state of the machine, in the words the states sheet uses.
   *
   * The dot is the only coloured thing here: on the brand ground the label has
   * to stay white in both themes, because `danger` and `warning` are tuned for
   * the canvas and neither clears AA against navy. So the colour signals and
   * the word informs — which is also why a dead kernel gets a plate rather than
   * red type.
   */
  const KERNEL: Record<KernelStatus, { label: string; dot: string; alarm: boolean }> = {
    starting: { label: 'STARTING', dot: 'bg-white/35', alarm: false },
    restarting: { label: 'RESTARTING', dot: 'bg-white/35', alarm: false },
    idle: { label: 'IDLE', dot: 'bg-white/50', alarm: false },
    busy: { label: 'RUNNING', dot: 'bg-accent', alarm: false },
    dead: { label: 'KERNEL DEAD', dot: 'bg-danger', alarm: true },
  }

  const kernel = $derived(KERNEL[meta.current.kernelStatus])

  /* ------------------------------------------------------------- layout */

  const PANELS_KEY = 'colloq.panels.v1'

  function loadPanels(): { left: boolean; right: boolean } {
    try {
      const raw = localStorage.getItem(PANELS_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as { left?: boolean; right?: boolean }
        return { left: saved.left !== false, right: saved.right !== false }
      }
    } catch {
      /* private browsing; the default layout is fine */
    }
    return { left: true, right: true }
  }

  const panels = loadPanels()
  let leftOpen = $state(panels.left)
  let rightOpen = $state(panels.right)
  let leftDrawer = $state(false)
  let rightDrawer = $state(false)

  // Narrow windows keep the notebook full width and show panels over it, so a
  // student on half a laptop screen still has somewhere to type.
  const AI_COLUMN = '(min-width: 1100px)'
  const SIDEBAR_COLUMN = '(min-width: 820px)'

  // Measured before the first paint so a narrow window never flashes columns.
  let wideEnough = $state(window.matchMedia(AI_COLUMN).matches)
  let roomyEnough = $state(window.matchMedia(SIDEBAR_COLUMN).matches)

  $effect(() => {
    const forAi = window.matchMedia(AI_COLUMN)
    const forSidebar = window.matchMedia(SIDEBAR_COLUMN)
    const sync = () => {
      wideEnough = forAi.matches
      roomyEnough = forSidebar.matches
    }
    sync()
    forAi.addEventListener('change', sync)
    forSidebar.addEventListener('change', sync)
    return () => {
      forAi.removeEventListener('change', sync)
      forSidebar.removeEventListener('change', sync)
    }
  })

  const leftIsDrawer = $derived(!roomyEnough)
  const rightIsDrawer = $derived(!wideEnough)
  const leftShown = $derived(leftIsDrawer ? leftDrawer : leftOpen)
  const rightShown = $derived(rightIsDrawer ? rightDrawer : rightOpen)

  // Returning to a wide window must not leave a stale overlay hanging around.
  $effect(() => {
    if (!leftIsDrawer) leftDrawer = false
  })
  $effect(() => {
    if (!rightIsDrawer) rightDrawer = false
  })

  function persistPanels(): void {
    try {
      localStorage.setItem(PANELS_KEY, JSON.stringify({ left: leftOpen, right: rightOpen }))
    } catch {
      /* ignore */
    }
  }

  function toggleLeft(): void {
    if (leftIsDrawer) {
      leftDrawer = !leftDrawer
      return
    }
    leftOpen = !leftOpen
    persistPanels()
  }

  function toggleRight(): void {
    if (rightIsDrawer) {
      rightDrawer = !rightDrawer
      return
    }
    rightOpen = !rightOpen
    persistPanels()
  }

  /* ------------------------------------------------------------ terminal */

  let terminalOpen = $state(false)
  /** Which surface the drawer opens on — see the run bar's two buttons. */
  let drawerTab = $state<'terminal' | 'history'>('terminal')
  // The session holds the unread count; only this screen knows whether anybody
  // is looking at the transcript.
  $effect(() => session.setTerminalOpen(terminalOpen))

  function toggleTerminal(): void {
    terminalOpen = !terminalOpen
    // The shell belongs to the room, so ask for one only when nobody has
    // started it yet; reopening my own drawer must never restart a live shell.
    const status = session.terminalStatus
    if (terminalOpen && (status === 'closed' || status === 'dead')) {
      session.send({ t: 'term:open' })
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    // Ctrl+` reaches the terminal from anywhere, including a focused cell.
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Backquote') {
      event.preventDefault()
      toggleTerminal()
      return
    }
    if (event.key !== 'Escape') return
    if (rightDrawer) {
      rightDrawer = false
      event.preventDefault()
    } else if (leftDrawer) {
      leftDrawer = false
      event.preventDefault()
    }
  }

  /* -------------------------------------------------------------- header */

  let copied = $state(false)
  let copyTimer: number | undefined
  onDestroy(() => window.clearTimeout(copyTimer))

  function rename(next: string): void {
    getMeta(session.doc).set('title', next)
  }

  // The field shows the link the way a person would read it out; the clipboard
  // gets the one a browser can open. Read once, for the same reason as above.
  // svelte-ignore state_referenced_locally
  const shareUrl = `${location.host}/s/${info.id}`

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${location.origin}/s/${info.id}`)
    } catch {
      return
    }
    copied = true
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copied = false), 1600)
  }

  /*
   * Everything on the brand band dims by opacity rather than by swapping a
   * colour: opacity is the only property allowed to animate, and on navy a
   * translucent white reads as the same ink turned down instead of a second
   * grey that has to be picked to work in both themes.
   */
  // No colour here on purpose: `text-white` and `text-brand` land in the same
  // Tailwind bucket, so a caller that inverts to the white ground has to be the
  // only one naming an ink.
  const BAND_BTN =
    'flex shrink-0 items-center justify-center focus-visible:outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white ' +
    'transition-opacity duration-100 hover:opacity-100'

  const bandIcon = (on: boolean) =>
    cn(BAND_BTN, 'h-7 w-7 text-white', on ? 'opacity-100' : 'opacity-55')
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full min-h-0 flex-col overflow-hidden bg-canvas">
  <!--
    Two bands, one brand ground. The navy is the printed object the room is
    held in — the same in both themes, like the join poster — so nothing in
    here reads a theme token that flips. White, translucent white, `brand-2`
    and `accent` are the entire palette above the workspace, and every one of
    them resolves to the same value on either side of the switch.
  -->
  <header class="shrink-0 bg-brand">
    <div class="px-4 pt-4 sm:px-7">
      <a
        href="/"
        aria-label="Back to Colloq"
        class="block max-w-full transition-opacity duration-100 hover:opacity-85
               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <Wordmark faculty tone="onDark" />
      </a>
    </div>

    <!-- The loudest thing on the screen. Black rather than bold: HSE Sans Black
         is what the artboard is drawn in, and Inter at 700 reads thin here. -->
    <div class="flex items-end gap-3 px-4 pb-4 pt-2 sm:gap-4 sm:px-7 sm:pb-5 sm:pt-3">
      {#if isHost}
        <!-- Renaming writes into the shared doc, so the room sees it immediately. -->
        <input
          class="name-field -mx-1.5 min-w-0 truncate bg-transparent px-1.5 text-marquee-sm
                 font-black text-white hover:bg-white/5 focus:bg-white/10 sm:text-marquee"
          value={storedTitle}
          oninput={(event) => rename(event.currentTarget.value)}
          aria-label="Seminar title"
          maxlength={80}
          spellcheck="false"
        />
      {:else}
        <h1 class="-mx-1.5 min-w-0 truncate px-1.5 text-marquee-sm font-black text-white sm:text-marquee">
          {title}
        </h1>
      {/if}

      <time
        datetime={started.toISOString()}
        title={dateLong}
        class="shrink-0 pb-1 font-mono text-ui-lg text-white/60">{dateShort}</time
      >
      <!-- Holds the pair to the left when the name is short. -->
      <span class="min-w-0 flex-1"></span>
    </div>

    <!-- The live state of the room: who is here, what the machine is doing, and
         the two controls that are about this room rather than about the
         notebook inside it. -->
    <!--
      45, а не 44: правило сверху съедает пиксель из коробки содержимого, и в
      оставшихся 43 всякий чётный по высоте ребёнок центрируется на половине
      пикселя. Круги от этого размывались по кольцу, а на 1x — заметно.
    -->
    <div class="flex h-[45px] items-center gap-3 border-t border-brand-2 px-4 sm:gap-4 sm:px-7">
      {#if room.length > 0}
        <div class="flex shrink-0 items-center gap-4" title={roomNames}>
          <!-- 28, как на экране входа: 24 в этой полосе читались мелко, а
               человек в комнате — единственное, что здесь про людей. -->
          <AvatarStack people={room} max={4} size={28} ring="rgb(var(--brand))" tone="onDark" />
          <span
            class="hidden shrink-0 text-2xs font-bold uppercase tracking-label text-white/80 sm:inline"
          >
            {room.length} in the room
          </span>
        </div>
        <span class="hidden h-3.5 w-px shrink-0 bg-brand-2 sm:block" aria-hidden="true"></span>
      {/if}

      <!-- Kernel. `python3` is the runtime this product runs and nothing else,
           so naming it is a fact rather than a field we do not have. -->
      <!--
        Dimmed while the socket is down. What the pill holds then is the last
        thing the server said, not what the kernel is doing now — nobody knows
        that — and a live-looking "IDLE" beside a spinner marked RECONNECTING is
        two claims that cannot both be true. Half opacity says "last known"
        without adding a word to a bar that is already full.
      -->
      <div
        class={cn(
          'flex h-7 shrink-0 items-center gap-2 transition-opacity duration-quick',
          kernel.alarm && 'bg-danger/20 px-2.5 ring-1 ring-inset ring-danger',
          !session.connected && 'opacity-50',
        )}
        title={session.connected ? undefined : 'Last known — the connection dropped'}
        role="status"
      >
        <span class={cn('h-1.5 w-1.5 shrink-0 rounded-full', kernel.dot)} aria-hidden="true"></span>
        <span class="text-2xs font-bold uppercase tracking-label text-white">{kernel.label}</span>
        {#if !kernel.alarm}
          <span class="hidden font-mono text-2xs text-white/60 lg:inline">python3</span>
        {/if}
      </div>

      {#if !session.connected}
        <div
          class="flex shrink-0 items-center gap-2 text-white"
          role="status"
          transition:fade={{ duration: 120 }}
        >
          <Icon name="spinner" size={12} class="animate-spin" />
          <span class="text-2xs font-bold uppercase tracking-label">Reconnecting</span>
        </div>
      {/if}

      <span class="min-w-0 flex-1"></span>

      <!-- Panels are not on the artboard, which draws both columns open; they
           stay because on a narrow window they are the only way to reach the
           files, the people and the oracle. -->
      <div class="flex shrink-0 items-center gap-0.5">
        <button
          class={bandIcon(leftShown)}
          onclick={toggleLeft}
          aria-pressed={leftShown}
          aria-label="Toggle files and people"
          title="Files and people"
        >
          <Icon name="file" size={16} />
        </button>
        <button
          class={bandIcon(rightShown)}
          onclick={toggleRight}
          aria-pressed={rightShown}
          aria-label="Toggle the AI oracle"
          title="AI oracle"
        >
          <Icon name="sparkles" size={16} />
        </button>
      </div>

      <ThemeSwitch tone="onDark" />

      <!-- The link, readable and attached to the button that takes it. -->
      <div class="flex h-7 shrink-0 items-center">
        <span
          class="hidden h-full select-all items-center border border-r-0 border-brand-2 px-3
                 font-mono text-2xs text-white/80 xl:flex"
        >
          {shareUrl}
        </span>
        <button
          class={cn(BAND_BTN, 'h-full gap-2 bg-white px-3 text-brand opacity-100')}
          onclick={copyLink}
          title="Copy the seminar link"
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          <span class="text-2xs font-bold uppercase tracking-label">
            {copied ? 'Copied' : 'Copy'}
          </span>
        </button>
      </div>
    </div>
  </header>

  <!-- Positioned, so the panel drawers below cover the workspace and stop at
       the masthead without anyone hard-coding how tall the masthead is. -->
  <div class="relative flex min-h-0 flex-1">
    {#if leftShown && !leftIsDrawer}
      <aside class="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
        {@render leftPanels()}
      </aside>
    {/if}

    <!-- The drawer sits inside the notebook column, not under the whole app:
         it is the same machine the cells run on. -->
    <div class="flex min-w-0 flex-1 flex-col">
      <main class="min-h-0 flex-1 overflow-y-auto">
        <Notebook
          {terminalOpen}
          historyOpen={terminalOpen && drawerTab === 'history'}
          ontoggleterminal={() => {
            if (terminalOpen && drawerTab === 'history') {
              drawerTab = 'terminal'
              return
            }
            drawerTab = 'terminal'
            toggleTerminal()
          }}
          ontogglehistory={() => {
            if (terminalOpen && drawerTab === 'history') {
              terminalOpen = false
              return
            }
            drawerTab = 'history'
            if (!terminalOpen) terminalOpen = true
          }}
        />
      </main>

      {#if terminalOpen}
        <TerminalDrawer open={drawerTab} onclose={() => (terminalOpen = false)} />
      {/if}
    </div>

    {#if rightShown && !rightIsDrawer}
      <aside class="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface">
        <AiPanel />
      </aside>
    {/if}

    <!--
      The travel below is gated here rather than in index.css, and it has to be:
      Svelte runs transition:fly through element.animate(), which no media query
      can reach — the reduced-motion block in index.css names what CSS owns, and
      these ±140px are the largest movement in the product. Reduced is a
      reduction, not a blackout: the panel still arrives over 140ms and still
      fades, it simply stops sliding.
    -->
    {#if leftIsDrawer && leftDrawer}
      <div class="absolute inset-0 z-40 flex">
        <button
          class="absolute inset-0 bg-canvas/70"
          aria-label="Close the files panel"
          onclick={() => (leftDrawer = false)}
          transition:fade={{ duration: 120 }}
        ></button>
        <aside
          class="relative flex w-60 max-w-[85vw] flex-col border-r border-line bg-surface shadow-pop"
          transition:fly={{ x: prefersReducedMotion() ? 0 : -140, duration: 140, easing: cubicOut }}
        >
          {@render leftPanels()}
        </aside>
      </div>
    {/if}

    {#if rightIsDrawer && rightDrawer}
      <div class="absolute inset-0 z-40 flex justify-end">
        <button
          class="absolute inset-0 bg-canvas/70"
          aria-label="Close the AI panel"
          onclick={() => (rightDrawer = false)}
          transition:fade={{ duration: 120 }}
        ></button>
        <aside
          class="relative flex w-[380px] max-w-[92vw] flex-col border-l border-line bg-surface shadow-pop"
          transition:fly={{ x: prefersReducedMotion() ? 0 : 140, duration: 140, easing: cubicOut }}
        >
          <AiPanel />
        </aside>
      </div>
    {/if}
  </div>
</div>

{#if session.lastError}
  <div class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
    <div
      role="status"
      class="pointer-events-auto flex max-w-lg items-start gap-2 border border-line bg-raised py-2 pl-3 pr-1.5 shadow-pop"
      transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: cubicOut }}
    >
      <span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
      <p class="min-w-0 flex-1 break-words py-0.5 text-ui leading-snug text-muted">
        {session.lastError}
      </p>
      <button
        class="btn-ghost h-6 w-6 shrink-0 px-0"
        onclick={() => session.dismissError()}
        aria-label="Dismiss"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  </div>
{/if}

<!-- One scrolling rail: the artboards stack both groups at the top of the
     column, and each brings its own header rule, so there is nothing between
     them but the 24px the panels already carry. -->
{#snippet leftPanels()}
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <FilesPanel />
    <PeoplePanel />
  </div>
{/snippet}

<style>
  /*
   * The seminar name is a heading that happens to be editable, so it has to be
   * exactly as wide as its text — a field at its default width would leave the
   * date stranded in the middle of the band. Chrome sizes it from the content;
   * anywhere else the input keeps the old behaviour and takes the row, which
   * still reads correctly, just with the date at the far edge.
   */
  .name-field {
    field-sizing: content;
    max-width: 100%;
  }

  @supports not (field-sizing: content) {
    .name-field {
      flex: 1 1 auto;
    }
  }
</style>
