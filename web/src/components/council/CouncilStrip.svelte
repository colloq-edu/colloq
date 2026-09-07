<script lang="ts">
  /**
   * Полоса групп под карточкой: один взгляд — сколько разных решений и как они
   * распределены. Ширина сегмента — по числу людей, но не меньше `min-width`:
   * группа из трёх на пятьсот человек иначе пропадала бы в пиксель, а именно
   * редкие решения преподаватель и ищет.
   *
   * Тонкая черта снизу — состояние группы (council-board.ts · toneOf), тёмный
   * сегмент — группа попытки, которая сейчас на карточке, пунктирный хвост —
   * те, кто ещё пишет: у них нет ключа группы, поэтому по хвосту не щёлкают.
   */
  import type { StripSegment, StripTone } from '@/lib/council-board'
  import { cn } from '@/lib/utils'
  import { plural } from '@/lib/plural'

  interface Props {
    segments: StripSegment[]
    onpick: (key: string) => void
  }

  let { segments, onpick }: Props = $props()

  const TONE: Record<StripTone, string> = {
    ok: 'border-positive',
    error: 'border-warning',
    fail: 'border-danger',
    none: 'border-faint',
  }

  function title(segment: StripSegment): string {
    if (segment.writing) return `${segment.count} ещё ${plural(segment.count, 'пишет', 'пишут', 'пишут')}`
    return `${segment.count} ${plural(segment.count, 'человек', 'человека', 'человек')}`
  }
</script>

<!--
  Рисунок — двенадцать пикселей, цель — двадцать четыре.

  По сегментам преподаватель прыгает между группами решений, и на десятке групп
  они сжимаются к своему минимуму: 8×12 — вдвое меньше пола 2.5.8, который
  продукт сам цитирует в тетради, и пальцем в них не попасть. Кнопка выросла
  вверх отрицательным полем и осталась на месте: полоса живёт внутри неё
  отдельным span'ом, а лишняя высота уходит в прозрачное поле над ней.
-->
{#if segments.length > 0}
  <div class="flex h-3 items-stretch gap-px" role="group" aria-label="Группы решений">
    {#each segments as segment (segment.key)}
      {#if segment.writing}
        <span
          class="min-w-[10px] border border-dashed border-faint"
          style="flex: {segment.count} 1 0"
          title={title(segment)}
        ></span>
      {:else}
        <button
          type="button"
          class={cn(
            'group relative -my-1.5 flex h-6 min-w-[16px] items-center',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          )}
          style="flex: {segment.count} 1 0"
          title={title(segment)}
          aria-label={title(segment)}
          aria-current={segment.current ? 'true' : undefined}
          onclick={() => onpick(segment.key)}
        >
          <span
            class={cn(
              'h-3 w-full border-b-2 transition-colors duration-[var(--speed-quick)]',
              TONE[segment.tone],
              segment.current ? 'bg-ink' : 'bg-line group-hover:bg-faint',
            )}
          ></span>
        </button>
      {/if}
    {/each}
  </div>
{/if}
