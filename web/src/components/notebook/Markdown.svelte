<script lang="ts">
  import {
    applyEdits,
    findAttachmentRefs,
    findWorkspaceImages,
    shaOfAttachment,
    type TextEdit,
  } from '@shared/images'
  import { askFiles, fileSrc, forgetFileSrc, pathOfFileSrc } from '@/lib/note-files.svelte'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { cn } from '@/lib/utils'
  import { askTicket, blobSrc, forgetBlobSrc } from './CellOutputs.svelte'

  interface Props {
    source: string
    class?: string
  }

  let { source, class: className = '' }: Props = $props()

  /*
   * Every note in the room was typed by another student, so its markup is
   * untrusted and is sanitized in lib/render before it reaches {@html}.
   *
   * The renderer arrives a chunk late. Markdown source is designed to be
   * readable as-is, so the gap shows the source itself rather than a spinner or
   * a blank — the words are on screen either way, and only the formatting
   * settles a frame later.
   */
  loadRenderers()

  /**
   * The room — or nothing, by the same argument as for outputs.
   *
   * The same component draws an oracle answer in the panel and a note on a
   * published page, where there is no session at all. A note's images lie on
   * the ROOM's shelf, and without the room the link to them stays in the text
   * as it is.
   */
  let room: { id: string; token: string } | null = null
  try {
    const session = getSessionState()
    room = { id: session.session.id, token: session.token }
  } catch {
    room = null
  }
  if (room) askTicket(room.id, room.token)

  /**
   * A note ready to be shown: `attachment:<sha>.<ext>` — as an address on the
   * shelf.
   *
   * A task-statement image lives not in the document but next to the room
   * (shared/images.ts · server/src/notebook-images.ts): 9 MB of base64 in the
   * text of cells is 9 MB for everyone who enters. Until the key to the shelf
   * has arrived, `blobSrc` answers `null`, and the link stays a link: the
   * address will be substituted on the next frame — the key lies in `$state`,
   * and this read is exactly the subscription to it.
   */
  function withImages(text: string): string {
    if (!room) return text
    const here = room
    const edits: TextEdit[] = []
    for (const ref of findAttachmentRefs(text)) {
      const sha = shaOfAttachment(ref.name)
      if (!sha) continue
      const url = blobSrc(here.id, { sha, mime: '', bytes: 0 })
      if (url) edits.push({ start: ref.start, end: ref.end, text: url })
    }
    /*
     * And an image lying as a FILE in the seminar folder:
     * `![diagram](assets/fig01.png)`.
     *
     * That is how task statements are written in a notebook that came from a
     * course repository — a path to a neighbouring file that Jupyter reads from
     * disk next to the notebook. In the room it stayed as written, and the
     * browser resolved it relative to the page address:
     * `/s/<room>/assets/fig01.png`, where the app lives and answers any path
     * with its `index.html`. That is, 200, `text/html` and an empty frame — a
     * success with nothing to show, and not even a 404 in the network tab.
     *
     * Only the display address is substituted: the path in the cell text does
     * not change (see shared/images.ts), and an `.ipynb` with
     * `assets/fig01.png` inside still opens in Jupyter.
     */
    for (const ref of findWorkspaceImages(text)) {
      const url = fileSrc(here.id, ref.path)
      if (url) edits.push({ start: ref.start, end: ref.end, text: url })
    }
    return applyEdits(text, edits)
  }

  /*
   * Tickets for files — from an effect, not from `withImages`.
   *
   * That involves the network and a state write, while `withImages` is called
   * from `$derived`: doing either in the middle of a computation is a way to
   * get a re-render inside a re-render. The effect re-runs on a text edit, so
   * an image added to a cell live is found the same way as when the room is
   * opened.
   */
  $effect(() => {
    const here = room
    if (!here) return
    const paths = findWorkspaceImages(source ?? '').map((ref) => ref.path)
    if (paths.length > 0) askFiles(here.id, here.token, paths)
  })

  const render = $derived(renderers())
  const shown = $derived(withImages(source ?? ''))
  const html = $derived(render ? render.markdown(shown) : null)

  /**
   * An image failed to load — most likely the key in its address has gone
   * stale.
   *
   * The same cure as for outputs (CellOutputs · retry), and for the same
   * reason: a key lives five minutes, while a class lasts an hour and a half,
   * and a tab that has woken up from sleep comes for an image with the old key.
   * We catch it on the way down: the `error` event on `<img>` does not bubble,
   * but it can be captured.
   */
  function imageFailed(event: Event): void {
    if (!room) return
    const here = room
    const img = event.target as HTMLImageElement | null
    const src = img?.getAttribute('src') ?? ''
    const sha = /\/blobs\/([0-9a-f]{64})/.exec(src)?.[1]
    if (sha) {
      if (forgetBlobSrc(here.id, sha)) askTicket(here.id, here.token)
      return
    }
    // And the same for a file from the folder: its ticket lives the same five
    // minutes.
    const path = pathOfFileSrc(here.id, src)
    if (path && forgetFileSrc(here.id, path)) askFiles(here.id, here.token, [path])
  }
</script>

{#if html !== null}
  <div class={cn('prose-note', className)} onerrorcapture={imageFailed}>
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in lib/render -->
    {@html html}
  </div>
{:else}
  <div class={cn('prose-note whitespace-pre-wrap', className)}>{source ?? ''}</div>
{/if}
