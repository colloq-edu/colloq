<script lang="ts">
  import { tr } from '@shared/i18n'
  import { cn } from '@/lib/utils'

  interface Props {
    text: string
    /** Письмо уйдёт всей группе, а не одному. */
    toGroup: boolean
    /** Сколько человек в группе; 1 — переключателя нет вовсе. */
    groupSize: number
    /** У группы есть черновик оракула — пометка на переключателе. */
    hasDraft: boolean
    /** В поле стоит черновик оракула, а не свой текст. */
    fromOracle: boolean
    disabled: boolean
    onchange: (text: string) => void
    ontoggle: () => void
    onsend: () => void
    onfocus: () => void
    onblur: () => void
  }

  let {
    text,
    toGroup,
    groupSize,
    hasDraft,
    fromOracle,
    disabled,
    onchange,
    ontoggle,
    onsend,
    onfocus,
    onblur,
  }: Props = $props()

  const sendDisabled = $derived(disabled || !text.trim() || text.trim().length > 3000)
</script>

<div class="reply" class:reply-group={toGroup}>
  <textarea class="reply-text" rows="2" maxlength="3000"
    aria-label={toGroup ? tr('room.ui.1332') : tr('room.ui.1331')}
    value={text} disabled={disabled} data-pult-reply
    placeholder={toGroup ? tr('room.ui.1332') : tr('room.pult.v2.workWrite')}
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
    <span class="pult-meta reply-scope">{toGroup ? tr('room.pult.groupReply') : tr('room.pult.replyScope')}</span>
    {#if groupSize > 1}
      <button type="button" class={cn('pult-button', toGroup && 'pult-button--selected')}
        aria-pressed={toGroup} {disabled} onclick={ontoggle}>
        {tr('room.ui.1333', { p0: groupSize })}{hasDraft ? tr('room.ui.41') : ''}
      </button>
    {/if}
    <button type="button" class="pult-button reply-send" disabled={sendDisabled} onclick={onsend}>
      {tr('room.pult.send')} <span aria-hidden="true">↗</span>
    </button>
  </div>
  {#if text.length > 2700}<p class="pult-meta reply-note" class:text-danger={text.length > 3000} role="status">{text.length} / 3000</p>{/if}
  {#if fromOracle}<p class="pult-meta reply-note reply-oracle">{tr('room.ui.30')}</p>{/if}
</div>

<style>
  .reply { display: flex; flex-direction: column; flex-shrink: 0; gap: 8px; padding: 10px 14px; border: 1px solid rgb(var(--line)); }
  .reply-group { border-color: rgb(var(--accent)); }
  .reply:focus-within { outline: 2px solid rgb(var(--accent) / 0.45); outline-offset: 1px; }
  .reply-text { display: block; width: 100%; min-height: 44px; max-height: 110px; resize: none; border: 0; padding: 0; background: transparent; color: rgb(var(--ink)); font: inherit; font-size: 14px; line-height: 22px; outline: none; }
  .reply-text::placeholder { color: rgb(var(--muted)); }
  .reply-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .reply-scope { flex: 1; min-width: 100px; }
  .reply :global(.pult-button) { min-height: 40px; font-size: 14px; line-height: 20px; padding: 8px 12px; }
  .reply :global(.reply-send) { color: rgb(var(--accent-text)); border-color: rgb(var(--accent)); font-weight: 600; }
  .reply-note { margin: 0; }
  .reply-oracle { padding-top: 8px; border-top: 1px solid rgb(var(--line)); }
</style>
