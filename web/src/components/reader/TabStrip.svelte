<!--
  The centre's tab row: the notebook and everything that has been opened in the
  room.

  It appears only when there is something to switch between: in a seminar where
  nobody has opened a single file this row does not exist at all, and it costs
  not a pixel of height. That is the answer to "so that it does not take up
  space" — the room that uses it is the one that pays for it.

  This is also where the teacher's position in the document is shown. A separate
  pill at the bottom of the reader said the same thing in a second voice; one
  place is more reliable than two.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import { quintOut } from 'svelte/easing'
  import { fly } from 'svelte/transition'
  import Icon from '@/components/ui/Icon.svelte'
  import type { Lead } from '@/lib/follow'
  import type { TabKey } from '@/lib/tabs.svelte'
  import { baseOf, kindOf } from '@shared/paths'
  import { iconFor } from '@/lib/file-icons'
  import { accessOptions, bookMark, type BookTab } from '@/lib/book-access'
  import { prefersReducedMotion } from '@/lib/utils'
  import type { BookAccess } from '@shared/rules'

  interface Props {
    /** Paths of the open files. The notebook is just a file among them. */
    tabs: string[]
    active: TabKey
    /** The shared-screen document: its tab is marked and closes differently. */
    board: string | null
    /** Whether the shared document may be removed for the whole room. */
    mayBoard: boolean
    /** Whom we follow through the document, if there is anyone to follow. */
    lead: Lead | null
    /** The presenter was here and left — not the same as "no presenter". */
    orphaned: boolean
    /**
     * Whether the viewer is following the presenter right now.
     *
     * Computed by the reader: any gesture of the viewer's own breaks following,
     * including scrolling within the same page. Until this flag was here, the
     * row said "Following Anna" to someone who had already fallen behind of
     * their own accord — while the reader a line below honestly said "you are
     * on your own".
     */
    following?: boolean
    page: number
    pages: number
    /**
     * Tabs pinned by the room: the shared screen and the lecture.
     *
     * They are not moved. The order of pinned tabs is set by the room, not by
     * whoever is looking at them — and dragging someone else's tab would mean
     * rearranging it for yourself while seeing it as "moved for everyone".
     */
    pinned?: string[]
    /**
     * The room's notebooks together with their access — one entry per open
     * notebook.
     *
     * Here, and not inside the notebook itself, because the mark is needed from
     * OUTSIDE: access explains why a tab the person has not switched to yet
     * will have grey buttons, while the neighbouring one will not.
     */
    books?: BookTab[]
    /** The "Access" menu is the teacher's: the room owner hands out rights. */
    mayAccess?: boolean
    /** Own participantId: for one's own notebook the mark says "mine". */
    meId?: string | null
    /** Change a notebook's access. Goes by the same route as the room rules. */
    onaccess?: (root: string, access: BookAccess) => void
    onshow: (key: TabKey) => void
    onclose: (path: string) => void
    /** Move one's own tab: `onto === null` means to the end of the row. */
    onreorder?: (dragged: string, onto: string | null) => void
    /** Catch up with the teacher: the reader listens to this as a counter. */
    oncatchup: () => void
  }

  let {
    tabs,
    active,
    board,
    mayBoard,
    lead,
    orphaned,
    following = true,
    page,
    pages,
    pinned = [],
    books = [],
    mayAccess = false,
    meId = null,
    onaccess,
    onshow,
    onclose,
    onreorder,
    oncatchup,
  }: Props = $props()

  /* ------------------------------------------------------ notebook access */

  /** What the room knows about this tab; `null`: the tab is not a notebook. */
  const bookOf = (key: string): BookTab | null =>
    books.find((book) => book.path === key) ?? null

  /** This tab's access mark — or `null` when the access is the room's. */
  const markOf = (key: string) => bookMark(bookOf(key)?.rule ?? null, meId)

  /** This notebook's kernel is computing right now. Not a notebook: silent. */
  const busyOf = (key: string): boolean => bookOf(key)?.busy === true

  /**
   * The menu is open on this notebook — and here is where it stands.
   *
   * `position: fixed` and a computed point, not `absolute` inside the tab: the
   * tab row scrolls horizontally (`overflow-x-auto`), and by the spec that also
   * turns on vertical clipping — a dropdown inside it would be cut off at the
   * 38-pixel bottom edge. The same technique as the ban menu
   * (panels/BanMenu.svelte), and for the same reason.
   */
  let menuAt = $state<{ root: string; x: number; y: number } | null>(null)
  let opener: HTMLElement | null = null
  let menuBox = $state<HTMLElement | null>(null)

  const MENU_W = 268
  /*
   * The menu height is measured, not computed: four rows with captions come to
   * about three hundred pixels on a narrow screen. The number is needed only to
   * press the menu against the bottom edge of the window, not for layout; an
   * error on the high side is harmless, on the low side it cuts off the last
   * row on a phone.
   */
  const MENU_H = 360

  function openMenu(event: MouseEvent, book: BookTab): void {
    const button = event.currentTarget as HTMLElement
    if (menuAt?.root === book.root) {
      closeMenu()
      return
    }
    opener = button
    const box = button.getBoundingClientRect()
    /*
     * Do not go past the window — on both axes. There can be a dozen tabs, and
     * the last one stands at the right edge; on a 390-pixel phone the second
     * one already goes past the edge. A menu that has gone under the edge looks
     * like a click that did not work.
     */
    menuAt = {
      root: book.root,
      x: Math.max(8, Math.min(box.left, window.innerWidth - MENU_W - 8)),
      y: Math.max(8, Math.min(box.bottom + 2, window.innerHeight - MENU_H - 8)),
    }
    /*
     * The opened layer takes the keyboard at once — and first takes a row that
     * CAN be chosen: "Personal" is dimmed on a teacher's notebook, and focus on
     * it would mean a menu the keyboard cannot move forward out of.
     */
    void tick().then(() =>
      menuBox?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),
    )
  }

  /** Close and return focus to the opener: the menu is keyboard-navigable. */
  function closeMenu(): void {
    if (!menuAt) return
    const back = opener
    menuAt = null
    opener = null
    void tick().then(() => {
      if (back?.isConnected) back.focus()
    })
  }

  function pick(root: string, access: BookAccess): void {
    closeMenu()
    onaccess?.(root, access)
  }

  /*
   * The menu closes from outside: a click outside, Escape, a notebook that has
   * disappeared.
   *
   * The listeners are installed only while the menu is open — following the
   * lock on a cell (notebook/CellView.svelte) — so that two window handlers do
   * not hang on the tab row for the whole class.
   */
  $effect(() => {
    if (!menuAt) return
    const away = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-access-menu]')) return
      if (target?.closest('[data-access-button]')) return
      closeMenu()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', escape, true)
    }
  })

  /* The notebook was removed from the room while the menu was open — there is
     nothing left to close off. */
  $effect(() => {
    if (menuAt && !books.some((book) => book.root === menuAt?.root)) closeMenu()
  })

  /*
   * Dragging tabs — and why it lives here rather than in a shared place.
   *
   * The "where did it land" decision is computed by a pure function
   * (lib/tabs.svelte · reordered), just as for the file tree
   * (lib/tree-move.ts): that is also where it is tested. What remains here is
   * the mouse — and one thing the mouse cannot do without: `dragging` is needed
   * to know the SIDE it is being dragged from, and so as not to draw the line
   * under the dragged tab itself.
   */
  let dragging = $state<string | null>(null)
  /** Where it lands: the tab the line goes before/after, or the end. */
  let over = $state<string | null>(null)
  let atEnd = $state(false)

  const movable = (key: string): boolean => onreorder !== undefined && !pinned.includes(key)

  function startDrag(event: DragEvent, key: string): void {
    if (!movable(key)) return
    dragging = key
    /*
     * `move`, not `copy`: the cursor has to tell the truth about what will
     * happen. And text in the transfer — so that the drag does not look broken
     * where a tab cannot be dropped (into the editor, into the files panel):
     * the path goes there.
     */
    event.dataTransfer?.setData('text/plain', key)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function aim(event: DragEvent, key: string | null): void {
    if (dragging === null) return
    // Without preventDefault the browser does not treat this as a place where
    // things can be dropped.
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    over = key
    atEnd = key === null
  }

  function drop(event: DragEvent, key: string | null): void {
    if (dragging === null) return
    event.preventDefault()
    if (key !== dragging) onreorder?.(dragging, key)
    stopDrag()
  }

  function stopDrag(): void {
    dragging = null
    over = null
    atEnd = false
  }

  /**
   * And the same from the keyboard.
   *
   * Dragging with the mouse is the only way to rearrange a tab, and the tab row
   * is traversed with Tab and lives under focus: a gesture the keyboard does
   * not have would mean "you do not have this ability" here.
   */
  function nudge(event: KeyboardEvent, key: string): void {
    if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    if (!movable(key)) return
    const own = tabs.filter((path) => !pinned.includes(path))
    const at = own.indexOf(key)
    const to = event.key === 'ArrowLeft' ? at - 1 : at + 1
    if (to < 0) return
    event.preventDefault()
    onreorder?.(key, to >= own.length ? null : own[to])
  }

  /*
   * Whether the viewer has fallen behind — that is, whether to offer "catch
   * up".
   *
   * Not only by page number: one can stop following without changing it, with a
   * single scroll within the page, and then "catch up" is the only way back.
   * There is deliberately no threshold on a fraction of the height here (see
   * follow.ts): it is not the reader that decides whether they have drifted
   * apart but the person — following is broken by their gesture.
   */
  const behind = $derived(lead !== null && (!following || lead.page !== page))
  /** Is a document shown now? Then a page counter stands on the right. */
  const reading = $derived(typeof active === 'string' && kindOf(active) === 'pdf')

  const TAB =
    'group flex items-center gap-2 pl-4 text-ui transition-colors duration-100 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40'
  const ON = 'bg-canvas font-semibold text-ink shadow-[inset_0_-2px_0_currentColor]'
  const OFF = 'text-muted hover:text-ink'

  function closeTitle(path: string): string {
    if (path !== board) return tr('room.ui.141')
    return mayBoard
      ? tr('room.ui.745')
      : tr('room.ui.746')
  }
</script>

<!--
  The row has no left padding: it used to be only on the first tab, and that tab
  stood twenty pixels to the right of all the others. Every tab pays for itself,
  and exactly as much as its neighbour.
-->
<div class="flex h-[38px] shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface">
  {#each tabs as key (key)}
      <!--
        A tab's width shrinks to a limit and no further: ten open files must not
        turn the names into a single letter. Beyond that the row scrolls — that
        is more honest than hiding tabs in a menu nobody can see.
      -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!--
        A tab with an access mark is wider than an ordinary one, and that is not
        decoration: "personal · Akim Studentov" next to a file name did not fit
        into 220 pixels, and the first thing to shrink to zero was the FILE
        NAME — the tab was left labelled with the mark alone. Two hundred and
        eighty is the name plus the mark in ordinary cases; beyond that both are
        cut with an ellipsis, and the tab row still scrolls.
      -->
      <div
        class={`relative flex min-w-0 shrink items-stretch ${markOf(key) ? 'max-w-[280px]' : 'max-w-[220px]'} ${active === key ? 'bg-canvas' : ''} ${dragging === key ? 'opacity-40' : ''}`}
        role="presentation"
        ondragover={(event) => aim(event, key)}
        ondrop={(event) => drop(event, key)}
      >
        <!--
          The line shows WHERE the tab will land, not what the pointer hovers
          over: dragging left — on the left, right — on the right. Without it
          the drop is blind, and one can miss by a position without ever
          learning about it.
        -->
        {#if over === key && dragging !== null && dragging !== key}
          {@const back = tabs.indexOf(dragging) > tabs.indexOf(key)}
          <span
            aria-hidden="true"
            class="pointer-events-none absolute inset-y-0 w-0.5 bg-accent {back ? 'left-0' : 'right-0'}"
          ></span>
        {/if}
        <button
          type="button"
          class={`${TAB} min-w-0 pr-1 ${active === key ? ON : OFF}`}
          title={key}
          draggable={movable(key)}
          ondragstart={(event) => startDrag(event, key)}
          ondragend={stopDrag}
          onkeydown={(event) => nudge(event, key)}
          onclick={() => onshow(key)}
        >
          <Icon name={iconFor(key)} size={13} class="shrink-0" />
          <!--
            This notebook's kernel is computing.

            Every notebook has its own Python and its own queue, and they can
            compute at the same time: without the dot, a neighbouring tab where
            training is running looks exactly like an idle one, and the only way
            to learn whether it has finished is to switch to it. A dot, not a
            word: the file name and the access mark already share the space on
            the tab, and "computing" here is a fact, not a caption. The tab's
            title stays the path (`title={key}`), so the dot has its own.
          -->
          {#if busyOf(key)}
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent {prefersReducedMotion() ? '' : 'animate-pulse'}"
              title={tr('room.book.busy')}
              aria-label={tr('room.book.busy')}
            ></span>
          {/if}
          <!-- The name is given a floor of three and a quarter rem: the mark is
               long ("personal · Akim Studentov"), and without the floor the tab
               was labelled with a single ellipsis instead of the file name. -->
          <span class="min-w-[3.25rem] flex-1 truncate font-mono text-code">{baseOf(key)}</span>
          <!--
            An access mark — only where the access is NOT "as in the room".

            A caption on every notebook would be noise: most have the room's
            rules, and "as in the room" on every tab says nothing. It appears
            exactly when something inside is grey, and explains that BEFORE
            switching — otherwise you learn about someone else's personal
            notebook only by opening it and poking at the dimmed buttons.
          -->
          {#if markOf(key)}
            {@const mark = markOf(key)!}
            <!-- The mark shrinks before the file name: a tab is asked "what
                 file is this", and the mark answers a second question. -->
            <span
              class={`min-w-0 max-w-[8.5rem] shrink truncate px-1.5 py-0.5 text-2xs font-semibold ${
                mark.tone === 'mine' ? 'bg-accent/15 text-accent-text' : 'bg-raised text-muted'
              }`}
              title={mark.text}
            >{mark.text}</span>
          {/if}
          {#if key === board && active !== key && lead}
            <!-- Where the teacher is can be seen from the notebook too:
                 otherwise you learn that the lecture has moved to another page
                 only by switching. -->
            <span class="flex shrink-0 items-center gap-1.5 bg-raised px-1.5 py-0.5">
              <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
              <span class="text-2xs font-semibold text-muted">{lead.name} {tr('room.ui.737')} {lead.page}</span>
            </span>
          {/if}
        </button>
        <!--
          "Access" is a teacher's menu, and only on notebooks.

          Next to closing, not in the rules panel: access is a property of ONE
          notebook, and it is decided while looking at that notebook. The rules
          panel holds the neighbouring question — what a notebook that a student
          creates for themselves will get (`ownBooks`).
        -->
        {#if mayAccess && bookOf(key)}
          {@const book = bookOf(key)!}
          <button
            type="button"
            data-access-button
            class="flex w-6 shrink-0 items-center justify-center text-faint transition-colors
                   duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-inset focus-visible:ring-accent/40"
            aria-haspopup="menu"
            aria-expanded={menuAt?.root === book.root}
            aria-label={`${tr('room.book.access.title')}: ${baseOf(key)}`}
            title={tr('room.book.access.title')}
            onclick={(event) => openMenu(event, book)}
          >
            <Icon name="lock" size={12} />
          </button>
        {/if}
        <!--
          Close. For whoever put the document up for the room, it removes it for
          everyone; for whoever opened it for themselves, only for themselves;
          for a student who may not remove the shared document, it takes them to
          the notebook, and the document stays with the room. The button lives
          on the tab, not in the files panel: people close what they are looking
          at, right where they are looking at it.
        -->
        <button
          type="button"
          class="flex w-7 shrink-0 items-center justify-center text-faint transition-colors
                 duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
                 focus-visible:ring-inset focus-visible:ring-accent/40"
          title={closeTitle(key)}
          aria-label={`${closeTitle(key)}: ${baseOf(key)}`}
          onclick={() => onclose(key)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
  {/each}

  <!--
    The empty space on the right is a target too: a drop here puts the tab last.
    Otherwise there is nothing to take the last position with except hitting the
    right half of the rightmost tab, and that is a target a few pixels wide.
  -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="relative flex-1"
    role="presentation"
    ondragover={(event) => aim(event, null)}
    ondrop={(event) => drop(event, null)}
  >
    {#if atEnd && dragging !== null}
      <span aria-hidden="true" class="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-accent"></span>
    {/if}
  </span>

  {#if reading}
    <div class="flex shrink-0 items-center gap-2.5 px-5">
      {#if behind && lead}
        <button
          type="button"
          class="flex items-center gap-1.5 border border-accent bg-canvas px-2 py-0.5
                 text-2xs font-semibold text-accent-text transition-colors duration-100 hover:bg-accent/5"
          onclick={oncatchup}
        >
          <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span> {tr('room.ui.738')} {lead.name} {tr('room.ui.739')} {lead.page}
        </button>
      {:else if lead}
        <span class="flex items-center gap-1.5">
          <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
          <span class="text-2xs font-semibold text-muted">{tr('room.ui.740')} {lead.name}</span>
        </span>
      {:else if orphaned}
        <!--
          Only for someone who WAS FOLLOWING SOMEONE and lost them. The teacher
          never has a presenter — nobody follows themselves — and telling them
          "you have left" means reporting an event that did not happen.
        -->
        <span class="text-2xs text-muted">{tr('room.ui.741')}</span>
      {/if}
      {#if pages > 0}
        <span class="h-3.5 w-px bg-line" aria-hidden="true"></span>
        <span class="font-mono text-2xs text-muted">{page} / {pages}</span>
      {/if}
    </div>
  {/if}
</div>

<!--
  The access menu stands OUTSIDE the scrolling row and is positioned from the
  window: see `menuAt`. Only the entrance follows the product's curve — the exit
  is not animated, because the menu is dismissed with a key, and an action from
  the keyboard must not be animated (the same decision as in BanMenu and the
  rules console).
-->
{#if menuAt}
  {@const open = books.find((book) => book.root === menuAt?.root)}
  {#if open}
    <div
      bind:this={menuBox}
      role="menu"
      tabindex="-1"
      data-access-menu
      aria-label={`${tr('room.book.access.title')}: ${baseOf(open.path)}`}
      class="fixed z-[60] border border-line bg-canvas p-1 shadow-pop"
      style={`left:${menuAt.x}px; top:${menuAt.y}px; width:${MENU_W}px`}
      in:fly={{ y: prefersReducedMotion() ? 0 : -4, duration: 120, easing: quintOut }}
    >
      <!--
        A header with the notebook's name — as in the ban menu
        (panels/BanMenu.svelte).

        The menu stands on top of the tab row and opens from a small button on
        ANY of the tabs, while the active one stays lit: without the name
        inside, it is easy to believe you are configuring the notebook you are
        looking at — and hand out rights to the wrong one.
      -->
      <p class="truncate px-2.5 pb-1 pt-0.5 text-2xs font-bold uppercase tracking-label text-muted">
        {baseOf(open.path)}
      </p>
      {#each accessOptions(open.rule) as option (option.access)}
        {@const current = (open.rule?.access ?? 'room') === option.access}
        <button
          role="menuitemradio"
          type="button"
          aria-checked={current}
          disabled={option.disabled}
          class={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-ui transition-colors
                  duration-100 focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-inset focus-visible:ring-accent/40
                  disabled:pointer-events-none disabled:opacity-45
                  ${current ? 'bg-raised text-ink' : 'text-ink hover:bg-raised'}`}
          onclick={() => pick(open.root, option.access)}
        >
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate">{option.label}</span>
            <span class="text-2xs leading-snug text-muted">{option.hint}</span>
          </span>
          {#if current}
            <Icon name="check" size={12} class="mt-1 shrink-0 text-accent-text" />
          {/if}
        </button>
      {/each}
    </div>
  {/if}
{/if}
