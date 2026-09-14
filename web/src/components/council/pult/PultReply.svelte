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
   */
  import { cn } from '@/lib/utils'

  interface Props {
    text: string
    /** Письмо уйдёт всей группе, а не одному. */
    toGroup: boolean
    /** Сколько человек в группе; 1 — переключателя нет вовсе. */
    groupSize: number
    disabled: boolean
    onchange: (text: string) => void
    ontoggle: () => void
    onsend: () => void
    onfocus: () => void
    onblur: () => void
  }

  let { text, toGroup, groupSize, disabled, onchange, ontoggle, onsend, onfocus, onblur }: Props = $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
</script>

<div
  class={cn(
    'flex shrink-0 items-center gap-2.5 border px-3 py-2.5',
    toGroup ? 'border-accent' : 'border-line',
  )}
>
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
    >{tr('room.ui.1333', { p0: groupSize })}</button>
  {/if}
</div>
