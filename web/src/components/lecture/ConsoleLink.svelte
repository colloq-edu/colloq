<!--
  The link with which a teacher hands their console over to a tablet.

  A lecture is run from an iPad — the page is turned with a finger and
  written on with the Pencil — while the laptop at the projector stays to
  show it. For the tablet to become the console, it has to join the room as
  THE SAME person: otherwise a second "Ada" appears in the list, and there
  is nobody to run the lecture under the `board` rule.

  There is no name and password to type on the tablet — this product has
  none at all. Hence a link: a short-lived exchange key (ten minutes, one
  use), and the fact that it lets you into the room AS YOU is said plainly
  here. Not a token: the same address can neither open a socket nor
  download a file.

  The "Share" button is not decoration: on a MacBook it is exactly the
  system sheet from which the link goes to the tablet over AirDrop with one
  tap. Where there is no sheet, the clipboard remains, and the button
  silently becomes "copy".

  ONE FOR TWO CONSOLES. The council console is handed to a phone with the
  same move and the same key — exactly three things differ between them:
  the address tail (a cell instead of the lecture), the word on the button
  and WHAT makes this link dangerous. That is why the prop here is not
  "where to lead" but "which console": the words about other people's work
  must stand next to the link that opens it and must not come apart from
  it.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { copyText } from '@/lib/clipboard'
  import { getSessionState } from '@/lib/session.svelte'
  import { seminarLink } from '@/lib/seminar-link'

  interface Props {
    /** How the button looks in its own bar — the bars have different classes. */
    class?: string
    /**
     * The council console's cell. `null` — the lecture console, one per room.
     *
     * It decides the words too: behind a council link lie other people's work
     * in full, and the same place that hands out the link has to say so.
     */
    cellId?: string | null
    /** The button's caption; the icon is always there. `false` — icon only. */
    caption?: boolean
  }

  let { class: className = '', cellId = null, caption = true }: Props = $props()

  const session = getSessionState()
  const council = $derived(cellId !== null)
  /** The tail after `/s/:id` — the same parsing as in lib/routes.ts. */
  const tail = $derived(council ? `/council/${cellId}` : '/pult')

  let open = $state(false)
  let anchor = $state<HTMLButtonElement | null>(null)
  /**
   * Where the panel stands — computed from the button and clamped to the
   * window.
   *
   * It used to be `absolute right-0`, that is, "right edge to the button's
   * right edge", and at 390 px that pushed it past the LEFT edge of the
   * screen: the panel is wider than 360, and the button sits in the middle of
   * the bar. On a phone neither the warning nor the link itself could be
   * read then — exactly what the panel is opened for. `fixed` is also not
   * clipped by the scrolling bar the button lives in.
   */
  let at = $state<{ left: number; top: number; width: number } | null>(null)
  const GAP = 12
  function place(): void {
    const box = anchor?.getBoundingClientRect()
    if (!box) return
    const width = Math.min(384, window.innerWidth - GAP * 2)
    at = {
      width,
      left: Math.max(GAP, Math.min(box.right - width, window.innerWidth - width - GAP)),
      top: Math.min(box.bottom + 1, Math.max(GAP, window.innerHeight - GAP)),
    }
  }
  let busy = $state(false)
  let link = $state<string | null>(null)
  let minutes = $state(10)
  let failureRender = $state<() => string | null>(() => null)
  const failure = $derived(failureRender())
  let copied = $state(false)

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  async function ask(): Promise<void> {
    if (busy) return
    busy = true
    failureRender = () => (null)
    try {
      const res = await api.handoff(session.session.id, session.token)
      // Not from the address bar: a room is most often run from localhost,
      // and the tablet cannot open such a link at all. The same rule as in
      // the panel (seminar-link.ts) picks between the two addresses, and the
      // screen's tail and `/t/<key>` are appended to the finished
      // `<origin>/s/<id>`.
      link = `${seminarLink(res.origin, location.origin, session.session.id)}${tail}/t/${res.key}`
      minutes = Math.max(1, Math.round(res.livesMs / 60_000))
      place()
      open = true
    } catch (cause: unknown) {
      // The previous key goes off the screen too: it may already have been
      // spent, and a refusal above a link that looks alive is two opposite
      // statements at once.
      link = null
      failureRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.142'))
      place()
      open = true
    } finally {
      busy = false
    }
  }

  async function copy(): Promise<void> {
    if (!link) return
    try {
      await copyText(link)
      copied = true
      setTimeout(() => (copied = false), 1600)
    } catch {
      // The clipboard may be closed off by browser policy. The link on screen
      // is the fallback: it is visible in full and is selected with one
      // press. That is why the refusal is drawn ABOVE the link, not instead
      // of it (see the markup): advice to select a link that the same advice
      // removed is a dead end.
      failureRender = () => (tr('room.ui.143'))
    }
  }

  async function share(): Promise<void> {
    if (!link) return
    try {
      await navigator.share({ get title() { return tr(council ? 'room.pult.v3.shareTitle' : 'room.ui.144') }, url: link })
    } catch {
      // The sheet was closed with nothing chosen — not an error, nothing to say.
    }
  }
</script>

<span class="relative flex items-stretch">
  <button
    type="button"
    bind:this={anchor}
    class={className}
    aria-expanded={open}
    aria-label={tr(council ? 'room.pult.v3.toPhone' : 'room.ui.133')}
    data-console-link={council ? 'council' : 'lecture'}
    title={tr(council ? 'room.pult.v3.toPhoneHint' : 'room.ui.132')}
    onclick={() => (open ? (open = false) : void ask())}
  >
    <Icon name={busy ? 'spinner' : 'link'} size={12} class={busy ? 'animate-spin' : ''} />{#if caption} {tr(council ? 'room.pult.v3.toPhone' : 'room.ui.133')} {/if}</button>

  {#if open && at}
    <!-- Under the button and within the window: see `place`. -->
    <div
      class="fixed z-40 border border-line bg-raised p-3 text-left shadow-pop"
      style={`left:${at.left}px; top:${at.top}px; width:${at.width}px`}
      role="dialog"
      aria-label={tr(council ? 'room.pult.v3.shareTitle' : 'room.ui.134')}
    >
      <!--
        The refusal and the link are two independent blocks, not branches of
        one. The copy refusal says "the link is on screen — select it", and
        while this was an `{:else}` branch, the refusal itself removed that
        link from the screen: what remained were two buttons, one of which
        would fail again, and "Refresh", which burns the key.
      -->
      {#if failure}
        <p class="pb-2 text-ui leading-snug text-danger">{failure}</p>
      {/if}
      {#if link}
        <!--
          "Until first opened" can be promised here: the server burns the
          key on the very first exchange (auth.ts, `spendHandoffToken`), so
          ten minutes is an upper limit, not a window in which the link waits
          for anyone at all. While the server did not burn the key, three
          places in the product said "good for one use", and none of them was
          true.
        -->
        <p class="pb-2 text-2xs leading-snug text-muted"> {tr('room.ui.135')} {minutes} {tr('room.ui.136')} </p>
        <!--
          And what makes this link dangerous — in its own words, not a
          generic "do not send it to others". The council console holds the
          whole class behind one address: names, drafts, errors and grades.
          The same argument already stands on the refusal to a non-teacher
          inside the console (PultWindow · room.ui.1358), and it must not be
          worded differently in two places.
        -->
        {#if council}
          <p class="pb-2 text-2xs leading-snug text-warning" data-console-link-danger>
            {tr('room.pult.v3.shareDanger')}
          </p>
        {/if}
        <p
          class="select-all break-all border border-line bg-canvas px-2 py-1.5 font-mono text-2xs text-ink"
        >
          {link}
        </p>
      {/if}
      <div class="flex items-center gap-1.5 pt-2">
        {#if link && canShare}
          <button type="button" class="btn-primary h-7 px-2.5 text-2xs" onclick={() => void share()}> {tr('room.ui.137')} </button>
        {/if}
        {#if link}
          <button type="button" class="btn-outline h-7 px-2.5 text-2xs" onclick={() => void copy()}>
            {copied ? tr('room.ui.138') : tr('room.ui.139')}
          </button>
        {/if}
        <span class="flex-1"></span>
        <button
          type="button"
          class="btn-ghost h-7 px-2.5 text-2xs"
          onclick={() => void ask()}
          disabled={busy}
        > {tr('room.ui.140')} </button>
        <button
          type="button"
          class="btn-ghost h-7 w-7 px-0"
          aria-label={tr('room.ui.141')}
          onclick={() => (open = false)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  {/if}
</span>
