<!--
  A notebook on a published page.

  The same cells and the same outputs as in the room — and not a single button
  that changes anything. There is no editor here at all: code is shown as
  highlighted text. This is not a "read-only editor" but a different object —
  behind the page there is neither a document nor a kernel, and there is nothing
  in it to change.
-->
<script lang="ts">
  import { tr, formatNumber } from '@shared/i18n'
  import { onMount } from 'svelte'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { copyText } from '@/lib/clipboard'
  import Code from '@/components/ui/Code.svelte'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { BLOB_PREFIX, SPILL_MIMES, type PublicCell } from '@shared/publish'
  import type { CellOutput } from '@shared/notebook'

  interface Props {
    cells: PublicCell[]
    /** The publication whose images are served by address — see `blobbed`. */
    publication: string
  }

  let { cells, publication }: Props = $props()

  onMount(() => void loadRenderers())

  const render = $derived(renderers())

  /**
   * Large images are stored as separate records and are turned into an address
   * here.
   *
   * The page holds `blob:<hash>` — that is, content moved out of the JSON so
   * that six steps do not carry six copies of the same plot. The hash is the
   * version, which is why the address is served with an eternal cache.
   *
   * Only the mimes that the server actually moves out (`SPILL_MIMES`) get an
   * address: raster images and the plotly figure — the former are drawn by
   * `<img>`, the latter goes off into a frame that fetches it by this same
   * address. Giving an address to every key in a row meant handing the path to
   * the SVG branch, and that branch sanitizes it as markup and prints it as a
   * line of text: in place of a graphviz plot the reader saw
   * "/api/p/x9tb4kwm/blob/6f1c…". A link to a record that has nothing to show
   * it is dropped from the bundle altogether: then the choice gets down to
   * text/plain — a repr instead of an address line. Publications built before
   * the server stopped moving out non-raster content are cured by exactly this.
   */
  function blobbed(output: CellOutput): CellOutput {
    if (output.kind !== 'data') return output
    const data: Record<string, string> = {}
    for (const [mime, value] of Object.entries(output.data)) {
      if (!value.startsWith(BLOB_PREFIX)) data[mime] = value
      else if (SPILL_MIMES.has(mime))
        data[mime] = `/api/p/${publication}/blob/${value.slice(BLOB_PREFIX.length)}`
    }
    return { ...output, data }
  }

  /**
   * A note with links to the publication's records — as addresses.
   *
   * An image from a task statement lives on the room's shelf, and when the page
   * is built it is copied into the publication's records and takes the form
   * `![diagram](blob:<hash>.<ext>)` in the text (server/src/publish/build.ts ·
   * projectNote). The reader serves records by the same route as the output
   * images a line above; the extension is not part of the address — it is there
   * for the catalogue export, where a record becomes a file.
   */
  function noted(source: string): string {
    /*
     * Both ways of writing an image: `![diagram](blob:…)` from markdown and
     * `<img src="blob:…">` from markup, which a note now renders. The closing
     * bracket and the quote are left alone — only the address between them is
     * replaced.
     */
    return source.replace(
      /(\]\(|src\s*=\s*["'])blob:([0-9a-f]{8,64})\.[a-z0-9]+/gi,
      (_all, lead: string, hash: string) => `${lead}/api/p/${publication}/blob/${hash}`,
    )
  }

  let copied = $state<string | null>(null)
  /**
   * The cell whose clipboard REFUSED.
   *
   * `copyText` throws: there is no async clipboard outside a secure context,
   * and the browser is entitled to refuse the fallback `execCommand` (strict
   * site settings, a recent Firefox with `dom.events.testing.asyncClipboard`
   * turned off). The call had no `catch`, and the refusal looked like nothing:
   * the check mark did not appear, not a word changed, and the rejection went
   * to unhandledrejection. Someone on a department's http instance pressed
   * again and decided the button was broken — while there was a way out for
   * them, and nobody told them about it.
   */
  let refused = $state<string | null>(null)

  async function copy(cell: PublicCell): Promise<void> {
    try {
      await copyText(cell.source)
    } catch {
      refused = cell.id
      setTimeout(() => (refused = refused === cell.id ? null : refused), 1600)
      return
    }
    copied = cell.id
    setTimeout(() => (copied = copied === cell.id ? null : copied), 1600)
  }

  const seconds = (ms: number): string => tr('room.duration.seconds', { count: formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
</script>

<div class="flex flex-col gap-6">
  {#each cells as cell (cell.id)}
    {#if cell.type === 'markdown'}
      <!-- The seminar's prose — without a frame: it is the text of the page.
           The rule set is the same as for a note in the room (`.prose-note`) —
           the promise of "the same cells" is kept by those rules, not by a
           second description of the same thing. -->
      <div class="prose-note prose-cell leading-relaxed">
        {#if render}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in lib/render -->
          {@html render.markdown(noted(cell.source))}
        {:else}
          <p class="whitespace-pre-wrap">{cell.source}</p>
        {/if}
      </div>
    {:else}
      {@const said =
        refused === cell.id
          ? tr('room.ui.731')
          : copied === cell.id
            ? tr('room.ui.138')
            : tr('room.ui.732')}
      <div class="border border-line bg-canvas">
        <div class="flex items-start gap-3 bg-surface/60 px-4 py-3">
          <Code code={cell.source} lang="python" class="min-w-0 flex-1 text-code-lg leading-relaxed" />
          <!--
            "Copy" on every cell — ten lines, and the whole difference between a
            page that is read and a page that is used: in the room itself the
            cells are separate CodeMirror editors, and code cannot be selected
            with the mouse across several of them.
          -->
          <!--
            A clipboard refusal is an answer too. A cross and the caption
            "select the code" for the same 1.6 s: on a department's http
            instance and in a strict browser the button does not work, and the
            person should learn that from the button itself, not conclude that
            the page is broken.
          -->
          <button
            class="press mt-0.5 flex h-[24px] w-[24px] shrink-0 items-center justify-center border
                   border-line transition-colors duration-100 hover:border-faint hover:text-ink
                   {refused === cell.id ? 'border-warning text-warning' : 'text-muted'}"
            title={said}
            aria-label={said}
            onclick={() => void copy(cell)}
          >
            <Icon
              name={refused === cell.id ? 'x' : copied === cell.id ? 'check' : 'copy'}
              size={11}
            />
          </button>
        </div>

        {#if cell.outputs.length > 0}
          <div class="border-t border-line px-4 py-3">
            <CellOutputs outputs={cell.outputs.map(blobbed)} />
          </div>
        {/if}

        <div
          class="flex items-center justify-end gap-2 border-t border-line bg-surface/60 px-4 py-1.5"
        >
          {#if cell.execCount === null && cell.outputs.length > 0}
            <!--
              There is an output, but no execution behind it any more: the
              kernel was restarted or a version was restored. Staying silent
              here is more honest than making up a number.
            -->
            <span class="font-mono text-2xs text-warning">Out [—]</span>
          {:else if cell.execCount !== null}
            <span class="font-mono text-2xs text-muted">
              Out [{cell.execCount}]{cell.ranMs !== null ? ` · ${seconds(cell.ranMs)}` : ''}
            </span>
          {:else}
            <span class="font-mono text-2xs text-muted">{tr('room.ui.736')}</span>
          {/if}
        </div>
      </div>
    {/if}
  {/each}
</div>
