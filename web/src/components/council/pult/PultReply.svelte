<script lang="ts">
  import { tr } from '@shared/i18n'
  import { cn } from '@/lib/utils'

  /**
   * Поле письма автору — строка мессенджера, а не форма.
   *
   * Раньше это была коробка в две строки с подписью «Личное письмо» и кнопкой
   * «Отправить» под ней: четыре строки высоты под действие, которое совершают
   * одним движением, — и вместе с письмами они уезжали под сгиб окна 900×650.
   * Теперь поле в одну строку, растёт под текстом до пяти строк и стоит в доке,
   * прибитом к низу работы. Кому уйдёт письмо — видно по кнопке «Всем N»
   * (нажата — группе), а не по подписи, которую читают один раз.
   */
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

  /**
   * Высота поля — по тексту, до пяти строк.
   *
   * Одна строка в покое: письмо чаще всего в одну строку и есть («попробуй
   * dropna»), а поле в две строки держало под это лишние 22 px в каждом кадре.
   * Дальше пяти не растёт — за ними начинается прокрутка внутри поля, и код
   * работы остаётся виден.
   */
  /** 40 — строка текста вместе с полями: ровно высота кнопок рядом. */
  const ONE_LINE = 40
  const MAX_HEIGHT = 128
  let field = $state<HTMLTextAreaElement | null>(null)
  $effect(() => {
    const box = field
    // Текст читается ради самой зависимости: высота пересчитывается на каждый
    // знак, в том числе когда текст подменил черновик оракула, а не палец.
    const value = text
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(Math.max(box.scrollHeight, ONE_LINE), MAX_HEIGHT)}px`
    void value
  })
</script>

<div class="reply" class:reply-group={toGroup} data-pult-reply-box>
  <textarea class="reply-text" rows="1" maxlength="3000" bind:this={field}
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
</div>
{#if text.length > 2700}<p class="pult-meta reply-note" class:text-danger={text.length > 3000} role="status">{text.length} / 3000</p>{/if}
{#if fromOracle}<p class="pult-meta reply-note reply-oracle">{tr('room.ui.30')}</p>{/if}

<style>
  .reply { display: flex; align-items: flex-end; flex-shrink: 0; gap: 8px; padding: 2px 6px 2px 12px; border: 1px solid rgb(var(--line)); background: rgb(var(--canvas)); }
  .reply-group { border-color: rgb(var(--accent)); }
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
