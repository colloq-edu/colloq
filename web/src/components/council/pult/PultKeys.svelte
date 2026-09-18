<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Полный список клавиш по «?».
   *
   * Пультом пользуются, не отводя глаз от зала, поэтому руки не должны искать
   * мышь. Тринадцать клавиш; две главные напоминает строка состояния, остальные
   * живут здесь и закрываются по Esc, по «?» и кнопкой закрытия.
   */
  import { cn } from '@/lib/utils'

  interface Props {
    onclose: () => void
  }

  let { onclose }: Props = $props()

  let dialog = $state<HTMLDialogElement | null>(null)
  $effect(() => { dialog?.showModal() })

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
    { keys: ['G'], what: tr('room.pult.v2.rules.keys') },
    { keys: ['Esc', '?', '⌘W'], what: tr('room.ui.1381') },
  ]
</script>

<dialog
  bind:this={dialog}
  class="m-auto max-h-[90dvh] w-[560px] max-w-[calc(100%-32px)] overflow-y-auto border border-line bg-canvas p-5 text-ink shadow-pop backdrop:bg-canvas/80"
  aria-label={tr('room.ui.1356')}
  data-pult-keys
  onclose={onclose}
  oncancel={onclose}
>
  <div class="flex items-center justify-between gap-4 pb-3">
    <h2 class="text-ui font-bold text-ink">{tr('room.ui.1356')}</h2>
    <button type="button" class="h-8 w-8 border border-line text-ui-lg" aria-label={tr('room.pult.closeHelp')} onclick={onclose}>×</button>
  </div>
  {#each ROWS as row, at (at)}
    <div class="flex items-center gap-4 border-b border-line py-2 last:border-b-0">
      <span class="flex w-[116px] shrink-0 gap-1">
        {#each row.keys as key (key)}<kbd class={cn(KEY)}>{key}</kbd>{/each}
      </span>
      <span class="min-w-0 flex-1 text-ui text-muted">{row.what}</span>
    </div>
  {/each}
</dialog>
