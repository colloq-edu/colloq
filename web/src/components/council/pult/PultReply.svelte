<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Поле ответа под письмами. Одна строка, растущая под текст, и один
   * переключатель адресата.
   *
   * «Всем N» — не вторая кнопка отправки, а переключатель: нажали — подсказка
   * меняется на «написать всем, кто ответил так же», и ⌘↵ отправляет уже
   * группе. Две кнопки отправки рядом означали бы, что рассылку на триста
   * человек отделяет от личного письма один промах пальца.
   *
   * Курсор-полоска accent слева — то же, что в макете: поле в пульте одно, и
   * ему не нужна рамка в полный рост, чтобы его нашли глазами.
   *
   * ЧЕРНОВИК ОРАКУЛА приезжает сюда текстом, а не кнопкой «отправить как
   * есть»: письмо уходит от имени преподавателя, и палец обязан пройти через
   * поле. Пометка на переключателе говорит, что черновик для этой группы
   * есть, строка под полем — что перед вами именно он.
   */
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

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
</script>

<div class={cn('flex shrink-0 flex-col border', toGroup ? 'border-accent' : 'border-line')}>
  <div class="flex flex-wrap items-center gap-2.5 px-3 py-2.5">

    <textarea
      class="min-h-[38px] min-w-0 basis-full flex-1 resize-none bg-transparent text-ui text-ink outline-none placeholder:text-faint"
      rows="2"
      maxlength="3000"
      aria-label={toGroup ? tr('room.ui.1332') : tr('room.ui.1331')}
      value={text}
      disabled={disabled}
      data-pult-reply
      placeholder={toGroup ? tr('room.ui.1332') : tr('room.ui.1331')}
      oninput={(event) => onchange(event.currentTarget.value)}
      onfocus={onfocus}
      onblur={onblur}
      onkeydown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          onsend()
        }
      }}
    ></textarea>
    <span class="min-w-0 flex-1 text-2xs text-muted">{toGroup ? tr('room.pult.groupReply') : tr('room.pult.replyScope')}</span>
    {#if groupSize > 1}
      <button
        type="button"
        class={cn(
          CAPS,
          'h-6 shrink-0 border px-3',
          toGroup ? 'border-accent bg-accent text-accent-ink' : 'border-line text-muted',
        )}
        aria-pressed={toGroup}
        {disabled}
        onclick={ontoggle}
      >{tr('room.ui.1333', { p0: groupSize })}{hasDraft ? tr('room.ui.41') : ''}</button>
    {/if}
    <button type="button" class="h-7 shrink-0 border border-accent px-3 text-2xs font-bold text-accent-text disabled:opacity-50" disabled={disabled || !text.trim() || text.trim().length > 3000} onclick={onsend}>{tr('room.pult.send')}</button>
  </div>
  {#if text.length > 2700}<p class="px-3 pb-2 text-2xs" class:text-danger={text.length > 3000} role="status">{text.length} / 3000</p>{/if}
  <!-- Черновик оракула правят, а не подтверждают: строка говорит, чей это
       текст и что уйдёт он от вашего имени. -->
  {#if fromOracle}
    <p class="border-t border-line px-3 py-1.5 text-micro text-faint">{tr('room.ui.30')}</p>
  {/if}
</div>
