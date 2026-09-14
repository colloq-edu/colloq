<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Полный список клавиш по «?».
   *
   * Пультом пользуются, не отводя глаз от зала, поэтому руки не должны искать
   * мышь. Двенадцать клавиш; две главные напоминает строка состояния, остальные
   * живут здесь и закрываются по Esc, по «?» и по щелчку мимо.
   */
  import { cn } from '@/lib/utils'

  interface Props {
    onclose: () => void
  }

  let { onclose }: Props = $props()

  const KEY =
    'flex h-6 min-w-6 shrink-0 items-center justify-center border border-line bg-surface px-1.5 font-mono text-2xs font-bold text-ink'

  const ROWS: { keys: string[]; what: string }[] = [
    { keys: ['j', 'k', '↑↓'], what: tr('room.ui.1374') },
    { keys: ['Space'], what: tr('room.ui.1375') },
    { keys: ['⌘F'], what: tr('room.ui.1376') },
    { keys: ['Tab'], what: tr('room.ui.1377') },
    { keys: ['Enter'], what: tr('room.ui.1378') },
    { keys: ['R', '1', '2'], what: tr('room.ui.1379') },
    { keys: ['3', '←→'], what: tr('room.ui.1380') },
    { keys: ['Esc', '?', '⌘W'], what: tr('room.ui.1381') },
  ]
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="absolute inset-0 z-50 flex items-center justify-center bg-canvas/80 p-8"
  data-pult-keys
  onclick={onclose}
>
  <div class="flex w-[520px] max-w-full flex-col gap-2.5 border border-line bg-canvas p-5 shadow-pop">
    <p class="text-2xs font-bold uppercase tracking-label text-ink">{tr('room.ui.1356')}</p>
    {#each ROWS as row, at (at)}
      <div class="flex items-center gap-4 border-b border-line py-1.5 last:border-b-0">
        <span class="flex w-[116px] shrink-0 gap-1">
          {#each row.keys as key (key)}
            <span class={cn(KEY)}>{key}</span>
          {/each}
        </span>
        <span class="min-w-0 flex-1 text-ui text-muted">{row.what}</span>
      </div>
    {/each}
  </div>
</div>
