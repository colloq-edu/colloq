<script module lang="ts">
  import { api } from '@/lib/api'
  import type { OutputBlob } from '@shared/notebook'

  /**
   * The ticket for the room's images: one per tab, not one per cell.
   *
   * Large images live not in the document but next to the room, and are
   * fetched by a separate request (server/src/routes/blobs.ts). A header
   * cannot be put on an `<img>`, so a short-lived ticket rides in the
   * address, the same trick as for file downloads. Here it lives at module
   * level: a notebook is a hundred of these components, and asking for a
   * ticket in each would mean a hundred identical requests on opening the
   * room.
   */
  let ticket = $state<{ room: string; token: string; at: number } | null>(null)
  /** The room whose ticket is already requested: a second request adds nothing. */
  let asking: string | null = null

  /** A ticket lives five minutes; we fetch a new one early, not after a refusal. */
  const TICKET_FRESH_MS = 4 * 60_000

  /**
   * An address, issued once.
   *
   * The ticket gets renewed, but the address of an image already drawn must
   * not change: another address is another `src`, that is, reloading
   * everything visible on screen every few minutes. A record's name is the
   * hash of its content, so an issued address never goes stale in meaning;
   * only the ticket inside it does, and that is cured by asking again on a
   * refusal.
   */
  const issued = new Map<string, string>()

  export function blobSrc(room: string, blob: OutputBlob): string | null {
    const key = `${room}:${blob.sha}`
    const known = issued.get(key)
    if (known) return known
    if (!ticket || ticket.room !== room) return null
    const url = api.blobUrl(room, blob.sha, ticket.token)
    issued.set(key, url)
    return url
  }

  /** Ask for a ticket if there is none or it is about to go stale. */
  export function askTicket(room: string, token: string): void {
    const fresh = ticket && ticket.room === room && Date.now() - ticket.at < TICKET_FRESH_MS
    if (fresh || asking === room) return
    asking = room
    void api
      .blobTicket(room, token)
      .then((got) => {
        ticket = { room, token: got.token, at: Date.now() }
      })
      .catch(() => {
        /* No ticket given: the image shows as its text representation; the next
           attempt comes with the next image. */
      })
      .finally(() => {
        if (asking === room) asking = null
      })
  }

  /**
   * An address was refused (the ticket went stale): forget it and get a new
   * ticket.
   *
   * Exactly once per record: otherwise an image that does not exist on the
   * server at all would go round in circles, "refusal → new ticket → new
   * address → refusal", and an empty box would cost a request per second.
   */
  const retried = new Set<string>()

  export function forgetBlobSrc(room: string, sha: string): boolean {
    const key = `${room}:${sha}`
    if (retried.has(key)) return false
    retried.add(key)
    issued.delete(key)
    if (ticket && ticket.room === room) ticket = null
    return true
  }
</script>

<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { CellOutput } from '@shared/notebook'
  import Icon from '@/components/ui/Icon.svelte'
  import ScopedOutput from './ScopedOutput.svelte'
  import PlotlyOutput from './PlotlyOutput.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { PLOTLY_MIME } from '@shared/plotly'
  // What to show as an image, what as markup, what as text lives in its own
  // module: the list of raster types there is tied to publishing, not
  // rewritten by hand.
  import {
    asImage,
    hasVisibleMarkup,
    imageSrc,
    isAddress,
    isPicture,
    pickMime,
    withBlobs,
  } from './output-mimes'
  import { loadRenderers, renderers, stripAnsi } from '@/lib/render.svelte'
  import { withoutEcho } from '@/lib/traceback'
  import { cn, collapseCarriage } from '@/lib/utils'
  import { outputKey } from '@/lib/output-seat'

  interface Props {
    outputs: CellOutput[]
    /**
     * How many images have not reported their size yet.
     *
     * Exposed so that the cell does not release its reserved space before
     * there is something to fill it with. See `outputSeat`.
     */
    pending?: number
  }

  let { outputs, pending = $bindable(0) }: Props = $props()

  /**
   * The room, or nothing, and that is not a slip.
   *
   * The same component draws outputs on the published page (reader/
   * PublicNotebook) and in the council stack: there is no session there at
   * all, and images arrive already as publication addresses.
   * `getSessionState` throws outside a session, which is right for everyone
   * who cannot work without one, and is not about us.
   */
  let room: { id: string; token: string } | null = null
  try {
    const session = getSessionState()
    room = { id: session.session.id, token: session.token }
  } catch {
    room = null
  }
  /*
   * The ticket is asked for when the notebook opens, not on the first image:
   * otherwise a chart the kernel has just finished would wait one more round
   * trip to the server, and the room would have time to see
   * "<Figure size 640x480 with 1 Axes>" in its place.
   */
  if (room) askTicket(room.id, room.token)

  /** Output ready to show: offloaded images become addresses. See withBlobs. */
  function shown(output: CellOutput): CellOutput {
    if (!room) return output
    const here = room
    return withBlobs(output, (blob) => blobSrc(here.id, blob))
  }

  /**
   * An image failed to load: most likely the ticket in its address went stale.
   *
   * Five minutes of ticket against a class of an hour and a half: a tab back
   * from sleep comes for an image with an old ticket and gets 401. We forget
   * the address and get a new ticket; the redraw puts in a fresh one, and
   * this is the only case in which a drawn image's `src` changes.
   */
  function retry(output: CellOutput): void {
    if (!room || output.kind !== 'data') return
    let again = false
    for (const blob of output.blobs ?? []) again = forgetBlobSrc(room.id, blob.sha) || again
    if (again) askTicket(room.id, room.token)
  }

  /**
   * An image that has not decoded yet.
   *
   * `imageSrc` builds a data URI, and the `<img>` has no width, no height and
   * no aspect-ratio, so a freshly created element takes up no space at all
   * until the base64 is decoded. Without this counter the space would be
   * released in the frame when the array stopped being empty, and the room
   * would see three states in a row: nine hundred pixels of reserve, an
   * eight-pixel white strip, and a jerk back to nine hundred. That is exactly
   * the jerk that was being removed, only with an extra intermediate frame.
   *
   * By load/error events, no timers; and all of it is bounded by the run in
   * any case, because the reserve lives only while `running`.
   */
  function decoding(node: HTMLImageElement) {
    if (node.complete) return
    let counted = true
    pending += 1
    const done = () => {
      if (!counted) return
      counted = false
      pending -= 1
    }
    node.addEventListener('load', done)
    node.addEventListener('error', done)
    return {
      destroy() {
        done()
        node.removeEventListener('load', done)
        node.removeEventListener('error', done)
      },
    }
  }

  /** Roughly twenty-five lines of output — past that a cell starts eating the page. */
  const COLLAPSE_PX = 420

  let heights = $state<number[]>([])
  let expanded = $state<boolean[]>([])

  /*
   * ANSI colouring and HTML sanitising live in lib/render, which is fetched the
   * first time a notebook renders. Until it lands, output still appears — the
   * escape codes are stripped and the text goes out as text. Colour is the only
   * thing missing for that one frame, and a student watching a cell finish
   * cares that it printed, not that it printed in green.
   */
  loadRenderers()

  const render = $derived(renderers())

  function tall(index: number, output: CellOutput): boolean {
    if (isPicture(output, render !== null)) return false
    return (heights[index] ?? 0) > COLLAPSE_PX + 40
  }
</script>

<div class="space-y-1.5">
  <!--
    Keyed by the shape of the slot, not by its number: `clear_output(wait=True)`
    swaps N records for M in one transaction, and a nine-hundred-pixel
    traceback becomes a two-hundred-pixel chart inside the same wrapper with
    the old `heights[0]`: the chart is drawn clipped, with a "Show more" from
    nowhere hanging under it.
  -->
  {#each outputs as raw, i (outputKey(i, raw))}
    <!-- Offloaded images as addresses; everything else as it arrived. -->
    {@const output = shown(raw)}
    {@const clipped = tall(i, output) && !expanded[i]}
    <div class="relative">
      <div class="overflow-hidden" style:max-height={clipped ? `${COLLAPSE_PX}px` : undefined}>
        <div bind:clientHeight={heights[i]}>
          <!-- eslint-disable svelte/no-at-html-tags -- every {@html} below is sanitized in lib/render -->
          {#if output.kind === 'stream'}
            <!-- A progress bar is one line redrawn, not two hundred printed:
                 see collapseCarriage. -->
            {@const text = collapseCarriage(output.text)}
            <div
              class={cn(
                'output-stream px-2 py-1',
                // A warning is not a failure. Painting every stderr line in the
                // colour of a crash is how a room learns to ignore the colour of
                // a crash — and pip and matplotlib write to stderr constantly.
                output.name === 'stderr' ? 'text-warning' : 'text-ink/90',
              )}
            >{#if render}{@html render.ansi(text)}{:else}{stripAnsi(text)}{/if}</div>
          {:else if output.kind === 'error'}
            {@const traceback = withoutEcho(output.traceback, output.ename, output.evalue)}
            <div class="px-1 py-0.5">
              <div class="font-mono text-code font-semibold text-danger">
                <!-- No name, just the text: that is how the server signs its
                     own stops (the council run limit), and a colon before the
                     phrase would read as a cut-off. -->
                {[output.ename, output.evalue].filter(Boolean).join(': ')}
              </div>
              {#if traceback}
                <div
                  class="output-stream mt-1.5 text-muted"
                >{#if render}{@html render.ansi(traceback)}{:else}{stripAnsi(traceback)}{/if}</div>
              {/if}
            </div>
          {:else}
            {@const mime = pickMime(output.data, render !== null)}
            {@const payload = mime ? output.data[mime] : ''}
            {#if mime === PLOTLY_MIME}
              <!-- An interactive chart, in a sandbox: see PlotlyOutput. -->
              <PlotlyOutput
                {payload}
                address={isAddress(payload)}
                onstale={() => retry(raw)}
              />
            {:else if mime && asImage(mime, payload)}
              <!-- Plots are drawn for paper: a transparent figure needs a light
                   backing or its black axes vanish into the canvas. -->
              <img
                use:decoding
                src={imageSrc(mime, payload)}
                alt={tr('room.ui.329')}
                class="max-w-full bg-white/95 p-1"
                onerror={() => retry(raw)}
              />
            {:else if mime === 'image/svg+xml' && render}
              <ScopedOutput
                kind="svg"
                markup={render.svg(payload)}
                class="max-w-full overflow-x-auto bg-white/95 p-1"
              />
            {:else if mime === 'text/html' && render}
              {@const markup = render.html(payload)}
              {#if hasVisibleMarkup(markup)}
                <ScopedOutput
                  kind="html"
                  markup={markup}
                  class="overflow-x-auto px-2 py-1 text-code text-ink"
                />
              {:else}
                <!--
                  The sanitiser removed everything that was there, so the
                  whole output lived in a script. Bokeh, folium, altair
                  without an image, ipywidgets, plotly with the old renderer:
                  the library sends markup whose entire job is in `<script>`,
                  and Colloq does not and will not execute scripts from output
                  (SECURITY.md). Staying silent about it is not an option: an
                  empty space under "Out [7]" reads as "the cell printed
                  nothing".
                -->
                <div class="px-2 py-1 text-code text-muted">{tr('room.output.interactive')}</div>
              {/if}
            {:else if mime === 'text/markdown' && render}
              <!--
                Output markdown is drawn by the same renderer as a note, and
                right in the page, without a shadow root, unlike `text/html`
                next to it.
                
                The difference is not trust but WHAT the sanitiser lets
                through. The note pass forbids `<style>` entirely and checks
                the properties of an inline `style` against an allowlist
                (shared/note-css.ts), that is, it lets through exactly what any
                student can write in a text cell; that cannot cover the screen.
                Whereas `text/html` from the kernel KEEPS `<style>` (that is
                where `df.style` lives) and therefore has to go into the root.
                
                And it should look like prose: `display(Markdown(...))` is
                written to caption the output in words, not to show markup.
              -->
              <div class="prose-note px-2 py-1 text-prose">{@html render.markdown(payload)}</div>
            {:else if mime}
              <div
                class="output-stream px-2 py-1 text-ink/90"
              >{#if render}{@html render.ansi(payload)}{:else}{stripAnsi(payload)}{/if}</div>
            {:else if Object.keys(output.data).length > 0}
              <!--
                Nothing to show it with: the bundle has not a single familiar
                type. This is what output looks like from a library whose
                whole representation is its own mime plus a script
                (ipywidgets, vega). The same line as for the scrubbed markup
                above, and for the same reason.
              -->
              <div class="px-2 py-1 text-code text-muted">{tr('room.output.interactive')}</div>
            {/if}
          {/if}
          <!-- eslint-enable svelte/no-at-html-tags -->
        </div>
      </div>

      {#if tall(i, output)}
        <div class="mt-1 border-t border-line-soft pt-1">
          <button
            type="button"
            class="inline-flex min-h-7 items-center gap-1 px-1.5 py-0.5 text-2xs font-medium
                   text-muted transition-colors duration-100 hover:bg-raised hover:text-ink
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onclick={() => (expanded[i] = !expanded[i])}
          >
            <Icon name={expanded[i] ? 'chevron-up' : 'chevron-down'} size={12} />
            {expanded[i] ? tr('room.ui.330') : tr('room.ui.331')}
          </button>
        </div>
      {/if}
    </div>
  {/each}
</div>
