<!--
  A confirmation for the contests' irreversible presses: deleting a contest,
  a problem, every test, a question; removing a participant; finishing now;
  revealing the frozen board.

  One component, because the panel's dialogs are one drawing (the veil, the
  card, the two buttons on the right, the refusal said inside) and the
  contests tab has six of them; six hand copies are six chances to drift from
  the competitions' — and from each other. The refusal lands in the dialog it
  belongs to, never in a banner behind the veil the teacher cannot read.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { onMount } from 'svelte'

  interface Props {
    title: string
    body: string
    /** The confirming button's word: «Удалить», «Завершить сейчас». */
    confirm: string
    /** Red for what destroys; the primary fill for what only cannot be taken back. */
    danger?: boolean
    busy?: boolean
    /** The server's refusal, said where the press was made. */
    error?: string | null
    onconfirm: () => void
    oncancel: () => void
  }

  let { title, body, confirm, danger = true, busy = false, error = null, onconfirm, oncancel }: Props = $props()

  const id = `contest-confirm-${Math.random().toString(36).slice(2, 8)}`

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) oncancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<div
  role="dialog"
  aria-modal="true"
  aria-labelledby={id}
  class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
>
  <div class="dialog-card w-full max-w-[480px] border border-line bg-canvas p-5 shadow-pop">
    <h2 {id} class="break-words text-title font-semibold text-ink">{title}</h2>
    <p class="mt-2 text-ui leading-relaxed text-muted">{body}</p>
    {#if error}
      <p class="mt-3 text-ui text-danger" role="alert">{error}</p>
    {/if}
    <div class="mt-5 flex justify-end gap-2">
      <button type="button" class="btn-outline" disabled={busy} onclick={oncancel}>
        {tr('admin.cancel')}
      </button>
      <button type="button" class={danger ? 'btn-danger-solid' : 'btn-primary'} disabled={busy} onclick={onconfirm}>
        {confirm}
      </button>
    </div>
  </div>
</div>
