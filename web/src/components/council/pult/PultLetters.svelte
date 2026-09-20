<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Письма по одной работе — три вида, и чужих здесь нет.
   *
   * Оракул — полоса accent и пометка, попросил ли подсказку студент; такое
   * письмо студент видит у себя, потому что просил сам. Личное письмо
   * преподавателя — raised без полосы. Письмо всей группе — raised с полосой
   * muted; отправить такое из пульта больше нельзя (группировка ушла 20.09), но
   * написанные раньше в ленте остаются: переписку задним числом не переписывают.
   *
   * Счёт прочитавших сервер не везёт (`CouncilReply` — текст, время, автор и
   * адресат), поэтому строка «прочитали N из M» здесь НЕ печатается: число,
   * которого нет, придумывать нельзя — по нему решают, повторять ли объяснение.
   *
   * Лента живёт в доке, прибитом к низу работы, и это её главное свойство.
   * Раньше письма стояли в общей прокрутке под кодом и выводом: чтобы увидеть,
   * что ты уже написал этому человеку, надо было пролистать чужой код («надо
   * листать куда-то что-то, нет фиксированной области общения»). Теперь они
   * всегда на экране, прокручены к последнему, и занимают не больше трети
   * панели — код важнее переписки ровно до тех пор, пока переписки мало.
   */
  import type { CouncilReply } from '@shared/protocol'
  import { pultClock } from '@/lib/council-pult'

  interface Props {
    letters: readonly CouncilReply[]
  }

  let { letters }: Props = $props()

  let feed = $state<HTMLElement | null>(null)
  /**
   * Лента стоит на последнем письме.
   *
   * Открыли работу — видно то, что написали ей последним, а не то, с чего
   * переписка началась: разговор продолжают с конца. Прыжок без анимации и
   * сразу: это не прокрутка, а исходное положение ленты.
   */
  $effect(() => {
    const count = letters.length
    const box = feed
    if (!box || count === 0) return
    box.scrollTop = box.scrollHeight
  })
</script>

{#if letters.length > 0}
  <section class="letters" aria-label={tr('room.pult.v3.letters')} bind:this={feed}>
    {#each letters as letter, at (at)}
      <article class="letter" class:letter-oracle={letter.to === 'oracle'} class:letter-group={letter.to === 'group'}>
        <div class="letter-meta pult-meta">
          <span class="letter-author">
            {letter.to === 'oracle' ? tr('room.ui.1325') : letter.to === 'group' ? tr('room.pult.v3.letterToGroup') : tr('room.ui.1328')}
          </span>
          <span>· {pultClock(letter.at)}</span>
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
{/if}

<style>
  /* Треть панели и ни строкой больше; писем нет — нет и места под них. */
  .letters { display: flex; flex-direction: column; gap: 6px; max-height: min(30dvh, 220px); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 8px 10px; background: rgb(var(--canvas)); border: 1px solid rgb(var(--line)); }
  .letter { display: flex; flex-direction: column; gap: 3px; padding: 7px 10px; background: rgb(var(--surface)); }
  .letter-oracle { border-left: 3px solid rgb(var(--accent)); }
  .letter-group { border-left: 3px solid rgb(var(--muted)); }
  .letter-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px; font-size: 12px; line-height: 16px; }
  .letter-author { font-weight: 600; color: rgb(var(--ink)); }
  .letter-oracle .letter-author { color: rgb(var(--accent-text)); }
  .letter-text { margin: 0; font-size: 14px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; color: rgb(var(--ink)); }
</style>
