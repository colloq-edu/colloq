<script lang="ts">
  import { initials, inkOn } from '@/lib/utils'

  interface Props {
    name: string
    color: string
    avatar?: string | null
    size?: 'xs' | 'sm' | 'md' | 'lg'
    /**
     * Кегль метки в пикселях, если круг задан не ступенью, а числом.
     * Ступеней четыре, а диаметров у стопки сколько угодно: на 28px ступень
     * `sm` даёт те же 14px, что и на 24px, и метка вместо 55% диаметра
     * занимает 47 — то есть чем крупнее круг, тем мельче в нём человек.
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
  const isEmoji = $derived(!!avatar && !avatar.startsWith('http') && !avatar.startsWith('data:'))

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
  {#if avatar && !isEmoji}
    <img src={avatar} alt={name} class="h-full w-full object-cover" />
  {:else if isEmoji}
    <!-- normal-case: an emoji is unaffected, but a text avatar would be shouted. -->
    <span class="normal-case leading-none">{avatar}</span>
  {:else}
    {initials(name)}
  {/if}
</span>
