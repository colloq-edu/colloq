<script lang="ts">
  import { tr } from '@shared/i18n'

  /**
   * The field for a letter to the author — a messenger line, not a form.
   *
   * It used to be a two-line box captioned "Private reply" with a "Send"
   * button under it: four lines of height for an action done in one motion —
   * and together with the letters they slid below the fold of a 900×650
   * window. Now the field is one line, grows with the text up to five lines
   * and stands in the dock pinned to the bottom of the work.
   *
   * There is one recipient — the work's author. Next to it there used to be
   * an "Everyone N" button sending the same letter to the whole group of
   * identical answers; it went away with grouping (20 Sep 2026), and there is
   * no replacement: in the console a letter is written to the person whose
   * work is being read.
   */
  interface Props {
    text: string
    /** The field holds an oracle draft, not your own text. */
    fromOracle: boolean
    disabled: boolean
    onchange: (text: string) => void
    onsend: () => void
    onfocus: () => void
    onblur: () => void
  }

  let {
    text,
    fromOracle,
    disabled,
    onchange,
    onsend,
    onfocus,
    onblur,
  }: Props = $props()

  const sendDisabled = $derived(disabled || !text.trim() || text.trim().length > 3000)

  /**
   * The field's height follows the text, up to five lines.
   *
   * One line at rest: a letter most often is one line ("try dropna"), and a
   * two-line field kept an extra 22 px for it in every frame. It does not
   * grow past five — beyond that the field scrolls inside, and the work's
   * code stays visible.
   */
  /** 40 is a text line plus padding: exactly the height of the buttons beside it. */
  const ONE_LINE = 40
  const MAX_HEIGHT = 128
  let field = $state<HTMLTextAreaElement | null>(null)
  $effect(() => {
    const box = field
    // The text is read for the dependency itself: the height is recomputed
    // on every character, including when an oracle draft replaced the text
    // rather than a finger.
    const value = text
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(Math.max(box.scrollHeight, ONE_LINE), MAX_HEIGHT)}px`
    void value
  })
</script>

<div class="reply" data-pult-reply-box>
  <textarea class="reply-text" rows="1" maxlength="3000" bind:this={field}
    aria-label={tr('room.ui.1331')}
    value={text} disabled={disabled} data-pult-reply
    placeholder={tr('room.pult.v2.workWrite')}
    oninput={(event) => onchange(event.currentTarget.value)} onfocus={onfocus} onblur={onblur}
    onkeydown={(event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault()
        event.stopPropagation()
        if (!sendDisabled) onsend()
      }
    }}
  ></textarea>
  <div class="reply-controls">
    <button type="button" class="pult-button reply-send" disabled={sendDisabled} onclick={onsend}>
      {tr('room.pult.send')} <span aria-hidden="true">↗</span>
    </button>
  </div>
</div>
{#if text.length > 2700}<p class="pult-meta reply-note" class:text-danger={text.length > 3000} role="status">{text.length} / 3000</p>{/if}
{#if fromOracle}<p class="pult-meta reply-note reply-oracle">{tr('room.ui.30')}</p>{/if}

<style>
  .reply { display: flex; align-items: flex-end; flex-shrink: 0; gap: 8px; padding: 2px 6px 2px 12px; border: 1px solid rgb(var(--line)); background: rgb(var(--canvas)); }
  .reply:focus-within { outline: 2px solid rgb(var(--accent) / 0.45); outline-offset: 1px; }
  .reply-text { display: block; flex: 1; min-width: 0; height: 40px; max-height: 128px; overflow-y: auto; resize: none; border: 0; padding: 9px 0; background: transparent; color: rgb(var(--ink)); font: inherit; font-size: 14px; line-height: 22px; outline: none; }
  .reply-text::placeholder { color: rgb(var(--muted)); }
  .reply-controls { display: flex; flex-shrink: 0; align-items: center; gap: 6px; }
  .reply :global(.pult-button) { min-height: 32px; font-size: 13px; line-height: 18px; padding: 6px 10px; }
  .reply :global(.reply-send) { color: rgb(var(--accent-text)); border-color: rgb(var(--accent)); font-weight: 600; }
  .reply-note { margin: 4px 0 0; }
  .reply-oracle { color: rgb(var(--accent-text)); }
  @media (max-width: 650px) {
    .reply { padding: 6px 6px 6px 10px; }
    .reply :global(.pult-button) { min-height: 40px; padding: 8px 10px; }
  }
</style>
