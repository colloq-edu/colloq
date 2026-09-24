<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * The full list of keys, on "?".
   *
   * The console is used without taking one's eyes off the room, so hands
   * should not have to look for the mouse. The status line reminds of the
   * two main ones, the rest live here and close with Esc, "?" and the close
   * button.
   *
   * Space and the ← → arrows are no longer in the list: the first expanded a
   * group of identical answers, the others moved through it. Grouping was
   * removed on 20 Sep 2026, and the help lines went with it — help promising
   * a key that does not exist is worse than a missing line.
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
    // There is one console per room, and the cell in it is switched more
    // often than it seems: the brackets do it without opening the menu
    // (council-pult.ts · pultKeyAction).
    { keys: ['[', ']'], what: tr('room.pult.v3.keys.cells') },
    { keys: ['⌘F', '/'], what: tr('room.ui.1376') },
    { keys: ['Tab'], what: tr('room.ui.1377') },
    { keys: ['Enter'], what: tr('room.ui.1378') },
    { keys: ['R', '1', '2'], what: tr('room.ui.1379') },
    { keys: ['3'], what: tr('room.pult.v3.keys.clear') },
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
