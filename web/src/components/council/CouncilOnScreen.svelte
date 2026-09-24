<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * The banner of a shown attempt — what the whole room sees under the cell.
   *
   * "Show to the class" used to overwrite the cell's shared text with someone
   * else's solution on the teacher's behalf: the starter code vanished for
   * everyone, the history recorded the host as the author of the edit, and
   * nothing on the screen said this was someone's solution — no name, no
   * chip, no line in the events. Now a show is an attachment to the same
   * cell: a caption, the code and the teacher's output under one stripe of
   * the positive colour, while the cell itself stays a cell.
   *
   * One markup for two places: for a student it stands under their own
   * sheet, for the teacher under the stack. The difference is exactly one
   * link on the right ("take off screen"), and only the one entitled to
   * press it has it.
   *
   * The author of what is shown NEVER sees this banner: their code is in
   * front of them anyway, and a second identical block under it would be two
   * identical pieces of code in a row. Instead of the council chip they get
   * a green "Your answer is on screen" (CellView · sheet footer); the caller
   * decides that, and nothing here knows about authorship.
   */
  import type { CouncilShown } from '@shared/protocol'
  import { clock } from '@/lib/history'
  import { cn, spell } from '@/lib/utils'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Code from '@/components/ui/Code.svelte'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'

  interface Props {
    shown: CouncilShown
    /** The host: only they have "take off screen" on the right. */
    mayClear?: boolean
    onclear?: () => void
  }

  let { shown, mayClear = false, onclear }: Props = $props()

  const CAPS = 'text-2xs font-bold uppercase tracking-label'

  /**
   * The caption under the name: who put it up, when, and how many more wrote
   * the same thing.
   *
   * Only a real time: a show started before shows began to be captioned (the
   * room was on the previous version) has none, and an invented hour would
   * be worse than silence. "K more wrote the same" appears when there is a K:
   * a zero in this line is noise next to the number it is read for.
   */
  const line = $derived.by(() => {
    const parts = [tr('room.ui.1256')]
    if (shown.shownAt !== null) parts.push(clock(shown.shownAt))
    if (shown.alsoWrote > 0) parts.push(tr('room.ui.1257', { count: shown.alsoWrote }))
    return parts.join(' · ')
  })
</script>

<!--
  One stripe for everything — banner, code and output: it is one object, not
  three neighbouring blocks. The positive colour is the only place in the
  notebook where the edge changes colour in the middle of a cell, and it has
  one justification: further down the column there is a different author,
  and this piece lives exactly as long as it is shown.
-->
<div class="border-l-4 border-positive" data-council-shown>
  <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 bg-positive/10 px-3.5 py-2">
    <span class={cn(CAPS, 'shrink-0 bg-positive px-1.5 py-px text-canvas')}>{tr('room.ui.52')}</span>
    {#if shown.name !== null}
      <Avatar name={shown.name} color={shown.color ?? '#888888'} avatar={shown.avatar} size="xs" />
      <span class="min-w-0 truncate text-ui-lg font-bold text-ink">{shown.name}</span>
    {:else}
      <!--
        Names on the projector are off: the answer number is the caption, and
        the circle in the avatar's place stays empty — neither a stranger's
        face nor a hole in the line. The number is assigned at the show and
        does not move (protocol · CouncilShown).
      -->
      <span class="h-5 w-5 shrink-0 rounded-full bg-raised" aria-hidden="true"></span>
      <span class="text-ui-lg font-bold text-ink">{tr('room.ui.1255', { p0: shown.variant })}</span>
    {/if}
    <span class="text-2xs text-muted">{line}</span>
    {#if mayClear}
      <button
        type="button"
        class="ml-auto shrink-0 text-2xs text-accent-text hover:underline"
        onclick={() => onclear?.()}
      >{tr('room.ui.1254')}</button>
    {/if}
  </div>

  <div class="bg-surface px-4 py-1">
    <Code code={shown.text} />
  </div>

  <!--
    The output is the teacher's, and it is labelled as the teacher's.

    The author's own run does not come here: under the code on screen the
    class reads what the host answers for — and it is by this output that the
    host says "correct". The hairline between code and output is the same
    pair as in an ordinary cell.
  -->
  {#if shown.run}
    <div
      class={cn('border-t', shown.run.state === 'error' ? 'bg-danger/5' : 'bg-canvas')}
      style:border-top-color="rgb(var(--line))"
    >
      {#if shown.run.outputs.length > 0}
        <div class="px-2 py-1.5">
          <CellOutputs outputs={shown.run.outputs} />
        </div>
      {/if}
      <p class={cn(CAPS, 'px-4 pb-1.5 pt-1 text-faint')}>
        {tr('room.ui.61')}{shown.run.ranMs === null ? '' : ` · ${spell(shown.run.ranMs)}`}
      </p>
    </div>
  {/if}
</div>
