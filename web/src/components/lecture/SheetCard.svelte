<!--
  A BLANK SHEET IN MINIATURE: its paper and its ink, for the strip under the
  slide and the "Pages" grid.

  An SVG, not a canvas. The canvases of a page are counted against ONE budget
  per process on iPad, and they are already spent on the slide, its ink and
  the slides' thumbnails; a sheet's picture is a handful of lines, and an SVG
  of them costs no bitmap at all. The ink is the point of the picture: it is
  by its ink that one finds "the sheet where I derived the limit" again.

  The paper is the sheet's own rules at this scale (page-region.ts ·
  `paperMarks`), in a lighter grey: three pixels apart on a 96 px card they
  read as the texture of the paper, which is what tells a ruled sheet from a
  plain one at a glance. The card fills its box; the console sizes the box to
  the deck's proportions.
-->
<script lang="ts">
  import type { InkStroke, SheetPaper } from '@shared/lecture'
  import { inkPaths } from './film'
  import { paperMarks } from './page-region'

  interface Props {
    paper: SheetPaper
    /** The sheet's strokes, or `null` while the card is outside the drawn window: paper only. */
    strokes: readonly InkStroke[] | null
    w: number
    h: number
  }

  let { paper, strokes, w, h }: Props = $props()

  const marks = $derived(paperMarks(paper, w, h, null))
  const rules = $derived.by(() => {
    let d = ''
    const lines = marks.lines
    for (let at = 0; at + 3 < lines.length; at += 4) {
      d += `M${lines[at].toFixed(1)} ${lines[at + 1].toFixed(1)}L${lines[at + 2].toFixed(1)} ${lines[at + 3].toFixed(1)}`
    }
    return d
  })
  // Dots as zero-length segments with round caps: one path, not five hundred circles.
  const dots = $derived.by(() => {
    let d = ''
    const at = marks.dots
    for (let i = 0; i + 1 < at.length; i += 2) d += `M${at[i].toFixed(1)} ${at[i + 1].toFixed(1)}h0.01`
    return d
  })
  const ink = $derived(strokes ? inkPaths(strokes, w, h) : [])
</script>

<svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} class="absolute inset-0 block" aria-hidden="true">
  {#if rules}
    <path d={rules} fill="none" stroke="#dce2ee" stroke-width="0.5" />
  {/if}
  {#if dots}
    <path d={dots} fill="none" stroke="#c3ccdd" stroke-width="1" stroke-linecap="round" />
  {/if}
  {#each ink as line, at (at)}
    <path
      d={line.d}
      fill={line.fill === undefined ? 'none' : line.color}
      fill-opacity={line.fill}
      stroke={line.color}
      stroke-width={line.width}
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {/each}
</svg>
