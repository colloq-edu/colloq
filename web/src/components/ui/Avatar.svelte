<script lang="ts">
  import { isMark } from '@/lib/marks'
  import { initials, inkOn } from '@/lib/utils'

  interface Props {
    name: string
    color: string
    avatar?: string | null
    size?: 'xs' | 'sm' | 'md' | 'lg'
    /**
     * The mark's font size in pixels, when the circle is given as a number
     * rather than a step.
     * There are four steps, but a stack can have any diameter: at 28px the `sm`
     * step gives the same 14px as at 24px, and the mark takes 47% of the
     * diameter instead of 55 — so the bigger the circle, the smaller the person
     * inside it.
     */
    emojiPx?: number
    ring?: boolean
    class?: string
    title?: string
  }

  let {
    name,
    color,
    avatar = null,
    size = 'sm',
    emojiPx,
    ring = false,
    class: className = '',
    title,
  }: Props = $props()

  /*
   * The emoji size is a property of the CIRCLE, not of the label font. It used
   * to be 1.15em of text-micro, which drew an 11px emoji inside a 24px disc and
   * read as a speck. Roughly 0.55 of the diameter fills it the way the artboards
   * do without the glyph touching the ring.
   */
  const SIZES = {
    xs: { box: 'h-5 w-5', label: 'text-micro', emoji: 'text-code' },
    sm: { box: 'h-6 w-6', label: 'text-micro', emoji: 'text-ui-lg' },
    md: { box: 'h-8 w-8', label: 'text-2xs', emoji: 'text-head' },
    lg: { box: 'h-12 w-12', label: 'text-ui-lg', emoji: 'text-display' },
  } as const

  const step = $derived(SIZES[size])
  /*
   * A mark is only one that is on the room's list, not "anything that does not
   * look like an address". Telling them apart by prefix meant drawing <img src>
   * from any string: the mark arrives here through presence, that is, from a
   * client that may have been modified, and `avatar="https://…/px.png"` made
   * the browser of everyone in the room — and the laptop at the projector —
   * knock on a foreign address every time the list of people was drawn. An
   * unfamiliar string is drawn as initials: the person's circle is in place,
   * and there is no foreign request.
   */
  const isEmoji = $derived(isMark(avatar))

  /*
   * Everyone gets the same solid disc in their own colour — the colour that is
   * also their cursor in the editor, which is the whole point of it. Picking an
   * emoji used to blank the disc to transparent, so an emoji person floated
   * loose in a row of coloured circles; a translucent tint was no better, since
   * over the navy meta band it turned to mud. The artboards draw one uniform
   * circle per person and the mark simply sits on it.
   */
</script>

<span
  {title}
  class="relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden
         rounded-full font-semibold uppercase leading-none
         {step.box} {isEmoji ? step.emoji : step.label} {ring ? 'ring-2 ring-surface' : ''} {className}"
  style="background-color: {color}; color: {inkOn(color)}{isEmoji && emojiPx
    ? `; font-size: ${emojiPx}px`
    : ''}"
>
  {#if isEmoji}
    <!-- normal-case: an emoji is unaffected, but a text avatar would be shouted. -->
    <span class="normal-case leading-none">{avatar}</span>
  {:else}
    {initials(name)}
  {/if}
</span>
