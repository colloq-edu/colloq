<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Letters about one piece of work — three kinds, and nobody else's are
   * here.
   *
   * The oracle — an accent stripe and a mark saying whether the student
   * asked for a hint; the student sees such a letter on their side, because
   * they asked themselves. A teacher's personal letter — raised without a
   * stripe. A letter to the whole group — raised with a muted stripe; such a
   * letter can no longer be sent from the console (grouping went away on 20
   * Sep 2026), but ones written earlier stay in the feed: correspondence is
   * not rewritten after the fact.
   *
   * The server does not send a count of readers (`CouncilReply` is text,
   * time, author and recipient), so a "read by N of M" line is NOT printed
   * here: a number that does not exist must not be invented — people decide
   * by it whether to repeat an explanation.
   *
   * The feed lives in a dock pinned to the bottom of the work, and that is
   * its main property. Letters used to stand in the shared scroll under the
   * code and output: to see what you had already written to this person you
   * had to scroll through someone's code ("you have to scroll somewhere for
   * something, there is no fixed area for communication"). Now they are
   * always on screen, scrolled to the latest, and take no more than a third
   * of the panel — code matters more than correspondence exactly as long as
   * there is little correspondence.
   */
  import type { CouncilReply } from '@shared/protocol'
  import { pultClock } from '@/lib/council-pult'

  interface Props {
    letters: readonly CouncilReply[]
  }

  let { letters }: Props = $props()

  let feed = $state<HTMLElement | null>(null)
  /**
   * The feed rests on the latest letter.
   *
   * When a piece of work is opened, what shows is what was written to it
   * last, not where the correspondence started: a conversation is continued
   * from the end. A jump without animation and immediate: this is not a
   * scroll but the feed's starting position.
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
  /* A third of the panel and not a line more; no letters — no room for them. */
  .letters { display: flex; flex-direction: column; gap: 6px; max-height: min(30dvh, 220px); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 8px 10px; background: rgb(var(--canvas)); border: 1px solid rgb(var(--line)); }
  .letter { display: flex; flex-direction: column; gap: 3px; padding: 7px 10px; background: rgb(var(--surface)); }
  .letter-oracle { border-left: 3px solid rgb(var(--accent)); }
  .letter-group { border-left: 3px solid rgb(var(--muted)); }
  .letter-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px; font-size: 12px; line-height: 16px; }
  .letter-author { font-weight: 600; color: rgb(var(--ink)); }
  .letter-oracle .letter-author { color: rgb(var(--accent-text)); }
  .letter-text { margin: 0; font-size: 14px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; color: rgb(var(--ink)); }
</style>
