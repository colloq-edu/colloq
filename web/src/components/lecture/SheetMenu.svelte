<!--
  THE SHEET MENU: what a sheet is ruled with, and deleting it. One card for
  the strip under the slide, the portrait ribbon and the "Pages" grid; it
  hangs from the CURRENT sheet's tile, its notch on the tile's "⋯" (or the
  chip), and the console places it and closes it (ConsoleView · `menuPlace`).

  THE HEADING REPEATS THE READING UNDER THE SLIDE, "Лист 2 из 3 · после
  слайда 14", so it is plain which sheet is about to change.

  PAPER CHANGES WITH ONE TOUCH, for everyone at once: the console, the
  projector and the students' screens rule the sheet anew under the ink that
  stays where it is. The menu stays open, so the four can be tried in turn by
  looking at the sheet, as a pen colour is.

  DELETING ASKS, IN PLACE OF THE MENU, not in a second card on top of it: the
  question names the sheet and what goes with it ("и его 14 штрихов"), and an
  empty sheet is asked about as empty. "Delete" is filled and on the LEFT,
  "Cancel" outlined on the right, under the thumb of the hand that holds the
  tablet, as with "End lecture". A stray touch on "Delete sheet" only opens
  the question.

  Offline both are disabled rather than queued: the frames are never queued
  (session · `DISCARDED_OFFLINE`), and a sheet deleted a minute later, when
  the Wi-Fi came back, would be deleted from under the next slide.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { SHEET_PAPERS, type SheetPaper } from '@shared/lecture'
  import Icon from '@/components/ui/Icon.svelte'
  import { afterWords, dropQuestion, paperSample } from './film'

  interface Props {
    /** The sheet's place among the lecture's sheets, and how many there are. */
    n: number
    total: number
    /** The slide the sheet follows (0: before the first), or `null` when the list does not say. */
    after: number | null
    paper: SheetPaper
    /** The sheet's strokes, for the question before deleting it. */
    strokes: number
    /** The portrait card, wider and with larger samples (board 08a); the landscape one is board 07's. */
    wide: boolean
    offline: boolean
    /** The fader's veil: the samples are paper, and paper dims with the room light. */
    veil: number
    /** The notch's centre, px from the card's left edge. */
    notch: number
    /** The card hangs below its tile, the notch pointing up. */
    below: boolean
    /** The delete question is open (the console rings the tile in danger meanwhile). */
    asking: boolean
    onpaper: (paper: SheetPaper) => void
    ondrop: () => void
  }

  let {
    n,
    total,
    after,
    paper,
    strokes,
    wide,
    offline,
    veil,
    notch,
    below,
    asking = $bindable(false),
    onpaper,
    ondrop,
  }: Props = $props()

  /*
   * The press, as on the console's keys (ConsoleView · `PRESS`): the listed
   * properties keep `transform` in the transition, and the press is the only
   * proof a touch was heard.
   */
  const PRESS =
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'
  /** A place name in the card, the palettes' voice (ToolPalette · `LABEL`). */
  const LABEL = 'font-mono text-micro font-semibold uppercase tracking-label text-muted'

  const NAMES: Record<SheetPaper, string> = {
    plain: 'room.pult4.paperPlain',
    grid: 'room.pult4.paperGrid',
    lines: 'room.pult4.paperLines',
    dots: 'room.pult4.paperDots',
  }

  /** The samples: 58 × 33 in the landscape card, 76 × 43 in the portrait one, as drawn. */
  const sampleW = $derived(wide ? 76 : 58)
  const sampleH = $derived(wide ? 43 : 33)
  const samples = $derived(
    SHEET_PAPERS.map((id) => ({ id, ...paperSample(id, sampleW, sampleH, wide ? 6 : 5.5) })),
  )
</script>

<div
  class="relative flex flex-col border border-line bg-raised shadow-pop {wide ? 'w-[378px]' : 'w-[320px]'}"
  role="dialog"
  aria-label={tr('room.pult4.sheetOf', { n, total })}
  data-pult-menu
>
  {#if asking}
    <div class="flex flex-col gap-5 p-5">
      <p class="text-[19px] leading-[26px] text-ink">{dropQuestion(n, strokes)}</p>
      <div class="flex gap-2">
        <!-- The dangerous one filled and on the left, "Cancel" on the right. -->
        <button
          type="button"
          class="{PRESS} flex h-12 flex-1 items-center justify-center bg-danger text-[16px] font-semibold leading-5 text-canvas disabled:opacity-50"
          disabled={offline}
          data-pult-drop
          onclick={ondrop}
        >
          {tr('room.pult4.drop')}
        </button>
        <button
          type="button"
          class="{PRESS} flex h-12 flex-1 items-center justify-center border border-faint/40 text-[16px] font-semibold leading-5 text-ink enabled:active:bg-line"
          onclick={() => (asking = false)}
        >
          {tr('room.ui.29')}
        </button>
      </div>
    </div>
  {:else}
    <div class="flex items-baseline gap-2.5 px-5 pt-[18px]">
      <span class="whitespace-nowrap text-[17px] font-semibold leading-[22px] text-ink">
        {tr('room.pult4.sheetOf', { n, total })}
      </span>
      {#if after !== null}
        <span class="min-w-0 truncate text-[14px] leading-[18px] text-muted">{afterWords(after)}</span>
      {/if}
    </div>
    <div class="flex flex-col gap-3 px-5 pb-[18px] pt-4">
      <span class={LABEL}>{tr('room.pult4.paper')}</span>
      <div class="flex {wide ? 'gap-2.5' : 'gap-4'}" role="radiogroup" aria-label={tr('room.pult4.paper')}>
        {#each samples as sample (sample.id)}
          {@const on = paper === sample.id}
          <button
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={tr(NAMES[sample.id])}
            class="{PRESS} flex shrink-0 flex-col items-center gap-2 disabled:opacity-50"
            style={`width:${sampleW}px`}
            disabled={offline}
            data-paper={sample.id}
            onclick={() => onpaper(sample.id)}
          >
            <span
              class="relative block overflow-hidden bg-[#f4f6fa] {on ? 'ring-2 ring-accent ring-offset-2 ring-offset-raised' : ''}"
              style={`width:${sampleW}px;height:${sampleH}px`}
              aria-hidden="true"
            >
              <svg width={sampleW} height={sampleH} viewBox={`0 0 ${sampleW} ${sampleH}`} class="absolute inset-0 block">
                {#if sample.lines}
                  <path d={sample.lines} fill="none" stroke="#bac4d7" stroke-width="1" />
                {/if}
                {#each sample.dots as dot, at (at)}
                  <rect x={dot.x - 0.75} y={dot.y - 0.75} width="1.5" height="1.5" fill="#8f9bb5" />
                {/each}
              </svg>
              <span class="pult-veil absolute inset-0 bg-canvas" style={`opacity:${veil}`}></span>
            </span>
            <span class="text-[13px] leading-4 {on ? 'font-semibold text-ink' : 'text-muted'}">{tr(NAMES[sample.id])}</span>
          </button>
        {/each}
      </div>
    </div>
    <!--
      Delete is set apart by a hairline: one press under the samples should
      not be the one that starts it. It only opens the question.
    -->
    <button
      type="button"
      class="{PRESS} flex h-[52px] items-center gap-3 border-t border-line px-5 text-left text-danger enabled:active:bg-line disabled:opacity-50"
      disabled={offline}
      aria-label={tr('room.pult4.dropSheet')}
      onclick={() => (asking = true)}
    >
      <Icon name="trash" size={18} />
      <span class="text-[15px] font-semibold leading-5">{tr('room.pult4.dropSheet')}</span>
    </button>
  {/if}

  <!-- The notch, on the tile it hangs from. -->
  <svg
    width="18"
    height="10"
    viewBox="0 0 18 10"
    class="pointer-events-none absolute block {below ? '-top-[9px] rotate-180' : '-bottom-[9px]'}"
    style={`left:${notch - 9}px`}
    aria-hidden="true"
  >
    <path d="M0 0 H18 L9 9 Z" class="fill-raised" />
    <path d="M0 0.5 L9 9.2 L18 0.5" fill="none" class="stroke-line" />
  </svg>
</div>
