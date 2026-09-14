<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Письма по одной работе — три вида, и чужих здесь нет.
   *
   * Оракул — полоса accent и пометка, попросил ли подсказку студент; такое
   * письмо студент видит у себя, потому что просил сам. Личное письмо
   * преподавателя — raised без полосы. Письмо всей группе — raised с полосой
   * muted и счётом прочитавших, если он известен.
   *
   * Счёт прочитавших сервер не везёт (`CouncilReply` — текст, время, автор и
   * адресат), поэтому строка «прочитали N из M» здесь НЕ печатается: число,
   * которого нет, придумывать нельзя — по нему решают, повторять ли объяснение.
   */
  import type { CouncilReply } from '@shared/protocol'
  import { clock } from '@/lib/history'
  import { cn } from '@/lib/utils'

  interface Props {
    letters: readonly CouncilReply[]
    /** Сколько человек в группе — для подписи «Вы · всем N». */
    groupSize: number
  }

  let { letters, groupSize }: Props = $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
</script>

<div class="flex flex-col gap-2.5">
  <div class="flex items-center gap-2">
    <span class={cn(CAPS, 'shrink-0 text-faint')}>{tr('room.ui.1324')}</span>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
  </div>
  {#each letters as letter, at (at)}
    {#if letter.to === 'oracle'}
      <div class="flex flex-col gap-1 border-l-2 border-accent bg-surface px-3 py-2.5">
        <div class="flex flex-wrap items-baseline gap-2">
          <span class={cn(CAPS, 'text-accent-text')}>{tr('room.ui.1325')}</span>
          <span class="font-mono text-micro text-faint">
            {tr('room.ui.1326')} · {tr('room.ui.1327')} · {clock(letter.at)}
          </span>
        </div>
        <p class="text-ui text-muted">{letter.text}</p>
      </div>
    {:else if letter.to === 'group'}
      <div class="flex flex-col gap-1 border-l-2 border-muted bg-raised px-3 py-2.5">
        <div class="flex flex-wrap items-baseline gap-2">
          <span class="text-2xs font-bold text-ink">{tr('room.ui.1329', { p0: groupSize })}</span>
          <span class="font-mono text-micro text-faint">{clock(letter.at)}</span>
        </div>
        <p class="text-ui text-muted">{letter.text}</p>
      </div>
    {:else}
      <div class="flex flex-col gap-1 bg-raised px-3 py-2.5">
        <div class="flex flex-wrap items-baseline gap-2">
          <span class="text-2xs font-bold text-ink">{tr('room.ui.1328')}</span>
          <span class="font-mono text-micro text-faint">{clock(letter.at)} · {letter.by}</span>
        </div>
        <p class="text-ui text-muted">{letter.text}</p>
      </div>
    {/if}
  {/each}
</div>
