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

  interface Props {
    letters: readonly CouncilReply[]
    /** Сколько человек в группе — для подписи «Вы · всем N». */
    groupSize: number
  }

  let { letters, groupSize }: Props = $props()

</script>

<section class="letters" aria-label={tr('room.pult.v2.workFeedback')}>
  <h3>{tr('room.pult.v2.workFeedback')}</h3>
  {#if letters.length === 0}
    <p class="pult-meta letters-empty">{tr('room.pult.v2.workNoFeedback')}</p>
  {/if}
  {#each letters as letter, at (at)}
    <article class="letter" class:letter-oracle={letter.to === 'oracle'} class:letter-group={letter.to === 'group'}>
      <div class="letter-meta pult-meta">
        <span class="letter-author">
          {letter.to === 'oracle' ? tr('room.ui.1325') : letter.to === 'group' ? tr('room.ui.1329', { p0: groupSize }) : tr('room.ui.1328')}
        </span>
        <span>· {clock(letter.at)}</span>
        {#if letter.to === 'oracle'}
          <span>· {tr('room.pult.v2.workOraclePrivate')}</span>
        {:else if letter.to !== 'group'}
          <span>· {letter.by}</span>
        {/if}
      </div>
      <p class="letter-text">{letter.text}</p>
    </article>
  {/each}
</section>

<style>
  .letters { display: flex; flex-direction: column; gap: 8px; }
  .letters h3 { margin: 0; font-size: 16px; line-height: 20px; font-weight: 700; }
  .letters-empty { margin: 0; }
  .letter { display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; background: rgb(var(--surface)); }
  .letter-oracle { border-left: 3px solid rgb(var(--accent)); }
  .letter-group { border-left: 3px solid rgb(var(--muted)); }
  .letter-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px; }
  .letter-author { font-weight: 600; color: rgb(var(--ink)); }
  .letter-oracle .letter-author { color: rgb(var(--accent-text)); }
  .letter-text { margin: 0; font-size: 14px; line-height: 21px; white-space: pre-wrap; overflow-wrap: anywhere; color: rgb(var(--ink)); }
</style>
