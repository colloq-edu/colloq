<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Всё, что есть в комнате, — одной клавишей.
   *
   * До сих пор клавиатура покрывала только тетрадь (командный режим, стрелки,
   * ⇧↵) и терминал; панели, вкладки, переход к ячейке и строка оракула жили
   * только под мышью. Преподаватель, ведущий пару с клавиатуры, за каждым таким
   * действием тянулся к трекпаду — а это те самые секунды, в которые в
   * аудитории молчат.
   *
   * Палитра — не второе меню, а один список того, что комната уже умеет: её
   * строки зовут те же самые функции, что и кнопки. Поэтому она и не знает
   * ничего о комнате: список ей приносят готовым, снимком на момент открытия.
   * Снимок — намеренно: пока человек читает список, ячейки не должны
   * переставляться под курсором выбора от чужого нажатия.
   *
   * Ничего не анимируется. Это поверхность, которую открывают десятки раз за
   * пару, и любое движение на открытии превращается в задержку между клавишей
   * и первой буквой запроса (Raycast не анимирует ровно поэтому).
   */
  import Icon from '@/components/ui/Icon.svelte'
  import { groupHeads, matchItems, type PaletteItem } from '@/components/ui/palette'

  interface Props {
    items: PaletteItem[]
    onclose: () => void
  }

  let { items, onclose }: Props = $props()

  let query = $state('')
  let cursor = $state(0)
  let field = $state<HTMLInputElement | null>(null)
  let listBox = $state<HTMLElement | null>(null)

  /** Правило отбора и порядка живёт в palette.ts — там его и проверяют. */
  const shown = $derived(matchItems(items, query))

  // Набранная буква выбрасывает прежний выбор: строка под ним уже другая.
  $effect(() => {
    void query
    cursor = 0
  })

  const active = $derived(shown[Math.min(cursor, Math.max(shown.length - 1, 0))] ?? null)

  $effect(() => {
    field?.focus()
  })

  /** Держать выбранную строку на виду — без плавности: это шаг, а не поездка. */
  $effect(() => {
    const id = active?.id
    if (!id || !listBox) return
    listBox.querySelector(`[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  function choose(item: PaletteItem | null): void {
    if (!item) return
    // Сначала закрыть, потом сделать: половина действий открывает панель или
    // ставит фокус, и палитра, ещё стоящая поверх, отняла бы его обратно.
    onclose()
    item.run()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onclose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      cursor = shown.length === 0 ? 0 : (Math.min(cursor, shown.length - 1) + 1) % shown.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      cursor =
        shown.length === 0 ? 0 : (Math.min(cursor, shown.length - 1) + shown.length - 1) % shown.length
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(active)
    }
  }

  const headings = $derived(groupHeads(shown))

</script>

<!--
  Слой выше пульта и проекции (z-[95]/z-[90]) палитре не нужен сам по себе:
  она живёт только в комнате. Но выше выдвижных панелей (z-40) и окна отказа
  она быть обязана — из палитры эти панели и открывают, а окно отказа с тех
  пор поднялось над пультом (z-[97], SessionScreen), и палитра поехала за ним.
  Выше терминальных плашек комнаты (z-[100]) не поднимается ничто: там
  открывать уже нечего.
-->
<div
  class="fixed inset-0 z-[98] flex justify-center bg-brand/30 px-4 pt-[12vh]"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose()
  }}
>
  <!-- tabindex, чтобы окно могло принять фокус, если поле ввода его отдало:
       клавиши разбираются здесь, а всплывают они от того, что в фокусе. -->
  <div
    class="flex max-h-[70vh] w-full max-w-[560px] flex-col border border-line bg-raised shadow-pop focus:outline-none"
    role="dialog"
    aria-modal="true"
    aria-label={tr('room.ui.751')}
    tabindex="-1"
    onkeydown={onKeydown}
  >
    <div class="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
      <Icon name="search" size={14} class="shrink-0 text-faint" />
      <input
        bind:this={field}
        bind:value={query}
        class="min-w-0 flex-1 bg-transparent text-ui-lg text-ink placeholder:text-faint focus:outline-none"
        placeholder={tr('room.ui.752')}
        aria-label={tr('room.ui.753')}
        autocomplete="off"
        spellcheck="false"
      />
      <kbd class="shrink-0 border border-line px-1.5 py-0.5 font-mono text-micro text-muted">esc</kbd>
    </div>

    <div bind:this={listBox} class="min-h-0 flex-1 overflow-y-auto py-1">
      {#each shown as item, index (item.id)}
        {#if headings[index]}
          <p class="px-4 pb-1 pt-2.5 text-micro font-bold uppercase tracking-section text-muted">
            {headings[index]}
          </p>
        {/if}
        <!-- 36px: строку выбирают пальцем на планшете с пультом в другой руке,
             и 24px — нижняя граница, а не цель. -->
        <button
          type="button"
          data-row={item.id}
          class="flex h-9 w-full items-center gap-3 border-l-2 px-4 text-left
                 transition-colors duration-quick ease-out active:bg-line
                 {item.id === active?.id ? 'border-accent bg-surface' : 'border-transparent'}"
          onmousemove={() => (cursor = index)}
          onclick={() => choose(item)}
        >
          <span class="min-w-0 flex-1 truncate text-ui text-ink">{item.label}</span>
          {#if item.hint}
            <span class="shrink-0 font-mono text-2xs text-muted">{item.hint}</span>
          {/if}
        </button>
      {:else}
        <p class="px-4 py-6 text-center text-ui text-muted">{tr('room.ui.756')}</p>
      {/each}
    </div>
  </div>
</div>
