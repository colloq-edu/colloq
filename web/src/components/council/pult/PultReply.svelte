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
  <div class="flex items-center gap-2.5 px-3 py-2.5">
    <span class="h-4 w-0.5 shrink-0 bg-accent" aria-hidden="true"></span>
    <textarea
      class="min-h-[19px] w-full flex-1 resize-none bg-transparent text-ui text-ink outline-none placeholder:text-faint"
      rows="1"
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
    <span class="shrink-0 font-mono text-micro text-faint">⌘↵</span>
    {#if groupSize > 1}
      <button
        type="button"
        class={cn(
          CAPS,
          'h-6 shrink-0 border px-3',
          toGroup ? 'border-accent bg-accent text-accent-ink' : 'border-line text-muted',
        )}
        aria-pressed={toGroup}
        onclick={ontoggle}
      >{tr('room.ui.1333', { p0: groupSize })}{hasDraft ? tr('room.ui.41') : ''}</button>
    {/if}
  </div>
  <!-- Черновик оракула правят, а не подтверждают: строка говорит, чей это
       текст и что уйдёт он от вашего имени. -->
  {#if fromOracle}
    <p class="border-t border-line px-3 py-1.5 text-micro text-faint">{tr('room.ui.30')}</p>
  {/if}
</div>
