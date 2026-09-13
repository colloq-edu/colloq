<script lang="ts">
  import { applyEdits, findAttachmentRefs, shaOfAttachment, type TextEdit } from '@shared/images'
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
   * Комната — или ничего, тем же доводом, что и у выводов.
   *
   * Тот же компонент рисует ответ оракула в панели и заметку на опубликованной
   * странице, где сессии нет вовсе. Картинки заметки лежат на полке КОМНАТЫ, и
   * без неё ссылка на них остаётся в тексте как есть.
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
   * Заметка, готовая к показу: `attachment:<sha>.<ext>` — адресом на полку.
   *
   * Картинка условия живёт не в документе, а рядом с комнатой (shared/images.ts
   * · server/src/notebook-images.ts): 9 МБ base64 в тексте ячеек — это 9 МБ
   * каждому вошедшему. Пока ключ на полку не приехал, `blobSrc` отвечает
   * `null`, и ссылка остаётся ссылкой: адрес подставится следующим кадром —
   * ключ лежит в `$state`, и это чтение и есть подписка на него.
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
    return applyEdits(text, edits)
  }

  const render = $derived(renderers())
  const shown = $derived(withImages(source ?? ''))
  const html = $derived(render ? render.markdown(shown) : null)

  /**
   * Картинка не загрузилась — скорее всего, протух ключ в её адресе.
   *
   * То же лечение, что у выводов (CellOutputs · retry), и по той же причине:
   * ключ живёт пять минут, а пара — полтора часа, и вкладка, вернувшаяся из
   * сна, приходит за картинкой со старым. Ловим на всплытии вниз: событие
   * `error` у `<img>` не всплывает, а перехватывается.
   */
  function imageFailed(event: Event): void {
    if (!room) return
    const img = event.target as HTMLImageElement | null
    const sha = /\/blobs\/([0-9a-f]{64})/.exec(img?.getAttribute('src') ?? '')?.[1]
    if (!sha) return
    if (forgetBlobSrc(room.id, sha)) askTicket(room.id, room.token)
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
