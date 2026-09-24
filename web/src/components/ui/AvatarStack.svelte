<script lang="ts">
  import Avatar from '@/components/ui/Avatar.svelte'

  interface Person {
    id: string
    name: string
    avatar?: string | null
    color: string
    /** Overrides the hover label — "Maria (you)" rather than "Maria". */
    title?: string
  }

  interface Props {
    people: Person[]
    /** Faces shown before the rest collapse into a "+N" chip. */
    max?: number
    /** Diameter in px, ring included. */
    size?: number
    /** Ground colour the ring is drawn in, so the stack reads on navy and on white. */
    ring?: string
    /** Which ground the chip has to sit on — the faces carry their own colour. */
    tone?: 'onDark' | 'onLight'
  }

  let {
    people,
    max = 4,
    size = 26,
    ring = 'rgb(var(--canvas))',
    tone = 'onLight',
  }: Props = $props()

  const shown = $derived(people.slice(0, max))
  const rest = $derived(people.length - shown.length)

  /*
   * The artboards slide each face a third of its diameter under the one before
   * it — far enough to read as a group, not so far that a face becomes a
   * crescent. Rounded, because a half pixel here shows up as a wobbling lane.
   */
  const step = $derived(Math.round((size * 2) / 3))
  const overlap = $derived(size - step)

  /*
   * Avatar owns initials, emoji and the colour chip; only its box is retuned
   * here, because `size` arrives as a number of pixels and no utility class can
   * say that. The nearest Avatar size still picks the right type size.
   */
  const face = $derived(size <= 22 ? 'xs' : size <= 30 ? 'sm' : size <= 40 ? 'md' : 'lg')

  /*
   * The mark's font size is a fraction of the diameter, not a step. There are
   * four steps and any number of stack diameters, and at 28px the `sm` step
   * gave the same 14px as at 24px: the circle grew, the person in it stayed the
   * same.
   *
   * 0.58, because Apple Color Emoji paints its ink at about 0.94 of the font
   * size, and Avatar wants 0.55 of the diameter — which is exactly 0.55/0.94.
   * Measured on a live stack, not derived from the metrics: for colour bitmap
   * emoji actualBoundingBox lies and returns the layout box.
   */
  const glyph = $derived(Math.round(size * 0.58))
</script>

<div class="flex shrink-0 items-center">
  {#each shown as person, i (person.id)}
    <!-- First person on top, z descending rightwards, so the stack reads as a
         queue rather than as whoever happened to be last in the DOM. -->
    <!--
      flex, not block. The avatar inside is inline-flex, that is, an inline box,
      and in a block parent it sits on the baseline: room for descenders is left
      under it, and the face slides down and pokes out of the ring. On a 24px
      circle that is three and a half pixels — the faces stood lower than the
      "+N" chip, and the row read as crooked. A flex container does not build a
      baseline, and `width/height: 100%` below puts the face exactly into the
      hole of the ring.
    -->
    <span
      class="cell relative flex shrink-0 rounded-full"
      style="width: {size}px; height: {size}px; border: 2px solid {ring}; z-index: {shown.length -
        i}; margin-left: {i === 0 ? 0 : -overlap}px"
    >
      <Avatar
        name={person.name}
        color={person.color}
        avatar={person.avatar}
        title={person.title}
        size={face}
        emojiPx={glyph}
      />
    </span>
  {/each}

  {#if rest > 0}
    <span
      class="relative flex shrink-0 items-center justify-center rounded-full text-micro font-bold leading-none {tone ===
      'onDark'
        ? 'bg-white/15 text-white'
        : 'bg-raised text-muted ring-1 ring-inset ring-line'}"
      style="width: {size}px; height: {size}px; border: 2px solid {ring}; z-index: 0; margin-left: {-overlap}px"
    >
      +{rest}
    </span>
  {/if}
</div>

<style>
  /* Avatar sizes itself off a fixed step of utility classes; the stack sizes in
     px, so the face fills whatever box the ring leaves it. */
  .cell > :global(span) {
    width: 100%;
    height: 100%;
  }
</style>
