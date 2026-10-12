<!--
  THE CONSOLE'S TOOL PALETTES: the pen's, the highlighter's and the
  pointer's, one card 304 px wide in one measure, so that every tool is
  set the same way. The console places the card beside the tool's key and
  marks it `data-pult-palette` (ConsoleView · `paletteStyle`); this file is
  only what is inside.

  A CHOICE IS SHOWN AS WHAT IT WILL WRITE, not as a swatch of colour or a
  dot of size. A pen colour is a short real stroke on paper (a colour disc
  on the night body lies: black on night is invisible, white on night is the
  brightest thing on the screen); the widths are drawn at TRUE scale, the
  fraction of the page times the page's width on this very screen, so what
  the palette shows is what lands on the slide; a highlighter is a band over
  a word, the way it will lie over the slide's text.

  The card's body lets the pen through (`pointer-events: none` from the
  console's wrapper); only the chips and rows take a press. A pen that lands
  in the padding goes on to the sheet, and the console's outside-tap closer
  folds the palette away, as in GoodNotes. That is over the sheet only:
  where the card lies over anything else (in portrait, the docked notes and
  the ribbon's chips) the console lays a guard under the card, and a touch
  on its body there stays with the card (ConsoleView · `paletteGuard`).

  Choosing does not close the palette: people try a colour and a width by
  looking at the sheet, not from memory.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { LASER_RED, PHRASE_HOLD_MS } from './laser'
  import { INKS, MARKER_WIDTHS, MARKERS, PEN_WIDTHS, oneDecimal, paperFor } from './pult'

  interface Props {
    /** Which palette: the pen's, the highlighter's or the pointer's. */
    kind: 'pen' | 'marker' | 'laser'
    ink: string
    penWidth: number
    markerColor: string
    markerWidth: number
    laserShape: 'dot' | 'line'
    /**
     * The page's width on screen, in px: the widths are drawn at the scale
     * the pen writes them (LecturePage · `onfit`).
     */
    sheetWidth: number
    onink: (color: string) => void
    onpenwidth: (width: number) => void
    onmarker: (color: string) => void
    onmarkerwidth: (width: number) => void
    onshape: (shape: 'dot' | 'line') => void
  }

  let {
    kind,
    ink,
    penWidth,
    markerColor,
    markerWidth,
    laserShape,
    sheetWidth,
    onink,
    onpenwidth,
    onmarker,
    onmarkerwidth,
    onshape,
  }: Props = $props()

  /*
   * The press, as on the console's keys: the listed properties keep
   * `transform` in the transition, and the press is the only proof a touch
   * was heard (ConsoleView · `PRESS`).
   */
  const PRESS =
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'
  /** A place name in the card: "COLOR", "WIDTH". */
  const LABEL = 'font-mono text-micro font-semibold uppercase tracking-label text-muted'
  /**
   * The chosen chip: a 2 px gap of the card's own ground, then a 2 px ring of
   * ink. A ring, not a fill: a slab under a coloured chip argues with the
   * colour itself.
   */
  const CHOSEN = 'ring-2 ring-ink ring-offset-2 ring-offset-raised'

  /** The stroke drawn on a pen's chip: a short real line of handwriting. */
  const SAMPLE = 'M11 23 C 18 24, 23 14, 30 14 S 40 11, 45 10'
  /** The stroke in each fifth of the width strip, centred in its 54 px cell. */
  const WIDTH_SAMPLE = 'M15 26 C 22 26, 30 18, 39 18'
  /** A highlighter's band in the strip: 52 px end to end, caps included. */
  const BAND = 52

  /** A width as it lands on the glass: the fraction of the page times the page's width here. */
  const onGlass = (width: number): number => width * (sheetWidth > 0 ? sheetWidth : 704)

  /** The pointer's glow: one gradient per card, its id unique on the page. */
  const uid = $props.id()
  const glow = `pult-glow-${uid}`

  const SHAPES = $derived([
    { id: 'line' as const, name: tr('room.ui.180'), says: tr('room.pult4.lineSays') },
    { id: 'dot' as const, name: tr('room.ui.182'), says: tr('room.ui.183') },
  ])
</script>

<div class="flex w-[304px] flex-col border border-line bg-raised p-4">
  {#if kind === 'pen'}
    <!--
      EIGHT PIGMENTS in two rows of four, in the order of the digit keys.
      Yellow and white lie on dark paper and say what they are for under the
      pair: on a white slide they would be invisible, and a chip that showed
      nothing would look broken.
    -->
    <span class="pb-3 {LABEL}">{tr('room.pult4.color')}</span>
    <div class="grid grid-cols-4 gap-x-4 gap-y-3" role="radiogroup" aria-label={tr('room.ui.184')}>
      {#each INKS as choice (choice.color)}
        {@const on = ink === choice.color}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto block h-[34px] w-14 {on ? CHOSEN : ''}"
          style={`background:${paperFor(choice.color)}`}
          onclick={() => onink(choice.color)}
        >
          <svg width="56" height="34" viewBox="0 0 56 34" class="block" aria-hidden="true">
            <path d={SAMPLE} fill="none" stroke={choice.color} stroke-width="4" stroke-linecap="round" />
          </svg>
        </button>
      {/each}
    </div>
    <div class="flex justify-end pt-[7px]">
      <span class="w-32 text-center text-[11px] leading-[14px] text-muted">{tr('room.pult4.forDark')}</span>
    </div>

    <!--
      THE WIDTHS ARE ONE STRIP OF PAPER, the five strokes in the pen's own
      colour at the size they will write; the chosen one is marked by an
      accent bar under it, not by a ring: on a strip of five a ring would cut
      the paper into tiles.
    -->
    <span class="pb-3 pt-[18px] {LABEL}">{tr('room.ui.186')}</span>
    <div class="relative flex h-[51px] w-[272px]" role="radiogroup" aria-label={tr('room.ui.186')}>
      <span class="absolute inset-x-0 top-0 h-11" style={`background:${paperFor(ink)}`} aria-hidden="true"></span>
      {#each PEN_WIDTHS as choice (choice.width)}
        {@const on = penWidth === choice.width}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto relative flex h-full min-w-0 flex-1 flex-col items-center"
          onclick={() => onpenwidth(choice.width)}
        >
          <svg width="54" height="44" viewBox="0 0 54 44" class="block shrink-0" aria-hidden="true">
            <path
              d={WIDTH_SAMPLE}
              fill="none"
              stroke={ink}
              stroke-width={Math.max(1, onGlass(choice.width))}
              stroke-linecap="round"
            />
          </svg>
          {#if on}
            <span class="absolute bottom-0 h-[3px] w-7 bg-accent" aria-hidden="true"></span>
          {/if}
        </button>
      {/each}
    </div>
    {@render hold(tr('room.pult4.penHold'))}
  {:else if kind === 'marker'}
    <!--
      FIVE HIGHLIGHTERS in a row of three and a row of two, each a band over
      a word on white paper: on the slide the band lies UNDER the text (the
      ink layer multiplies it with the page), so the word stays dark through
      it, and that is what the chip shows.
    -->
    <span class="pb-3 {LABEL}">{tr('room.pult4.markerColor')}</span>
    <div class="grid grid-cols-3 gap-x-4 gap-y-3" role="radiogroup" aria-label={tr('room.pult4.markerColor')}>
      {#each MARKERS as choice (choice.color)}
        {@const on = markerColor === choice.color}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto relative flex h-[34px] w-20 items-center justify-center bg-white {on
            ? CHOSEN
            : ''}"
          onclick={() => onmarker(choice.color)}
        >
          <span
            class="absolute left-1.5 top-2.5 h-3.5 w-[68px] rounded-[7px]"
            style={`background:${choice.color}`}
            aria-hidden="true"
          ></span>
          <span class="relative text-[11px] leading-[14px] text-[#101a33]" aria-hidden="true">
            {tr('room.pult4.markerSample')}
          </span>
        </button>
      {/each}
    </div>

    <span class="pb-3 pt-[18px] {LABEL}">{tr('room.pult4.markerWidthLabel')}</span>
    <div class="relative flex w-[272px]" role="radiogroup" aria-label={tr('room.pult4.markerWidth')}>
      <span class="absolute inset-x-0 top-0 h-11 bg-white" aria-hidden="true"></span>
      {#each MARKER_WIDTHS as choice (choice.width)}
        {@const on = markerWidth === choice.width}
        {@const thick = Math.min(BAND, Math.max(2, onGlass(choice.width)))}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto relative flex min-w-0 flex-1 flex-col items-center"
          onclick={() => onmarkerwidth(choice.width)}
        >
          <svg width="90" height="44" viewBox="0 0 90 44" class="block shrink-0" aria-hidden="true">
            <line
              x1={45 - BAND / 2 + thick / 2}
              y1="22"
              x2={45 + BAND / 2 - thick / 2}
              y2="22"
              stroke={markerColor}
              stroke-width={thick}
              stroke-linecap="round"
            />
          </svg>
          <span class="mt-1 h-[3px] w-7 {on ? 'bg-accent' : ''}" aria-hidden="true"></span>
          <span class="pt-1.5 text-micro {on ? 'font-semibold text-ink' : 'text-muted'}" aria-hidden="true">
            {choice.name}
          </span>
        </button>
      {/each}
    </div>
    {@render hold(tr('room.pult4.markerHold'))}
  {:else}
    <!--
      THE POINTER: a line circles and writes, a dot points. Each row draws
      what will happen on the sheet the way the sheet draws it: the line with
      its halo, core and glowing head, the dot alone. The footnote says the
      rule nobody can see on a frame: the word stays lit while one writes,
      and goes out whole after a pause.
    -->
    <div class="flex flex-col" role="radiogroup" aria-label={tr('room.ui.165')}>
      {#each SHAPES as choice (choice.id)}
        {@const on = laserShape === choice.id}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto flex h-12 items-center gap-3 pl-2 pr-2.5 text-left {on
            ? 'bg-line'
            : ''} enabled:active:bg-line"
          onclick={() => onshape(choice.id)}
        >
          <svg width="40" height="20" viewBox="0 0 40 20" class="block shrink-0" aria-hidden="true">
            {#if choice.id === 'line'}
              <defs>
                <radialGradient id={glow} cx="0.5" cy="0.5" r="0.5">
                  <stop offset="0" stop-color={LASER_RED} />
                  <stop offset="1" stop-color={LASER_RED} stop-opacity="0" />
                </radialGradient>
              </defs>
              <path
                d="M4 15 C 11 4, 19 18, 31 8"
                fill="none"
                stroke={LASER_RED}
                stroke-opacity="0.22"
                stroke-width="7"
                stroke-linecap="round"
              />
              <path
                d="M4 15 C 11 4, 19 18, 31 8"
                fill="none"
                stroke={LASER_RED}
                stroke-opacity="0.9"
                stroke-width="2.6"
                stroke-linecap="round"
              />
              <circle cx="32" cy="7.4" r="6.5" fill={`url(#${glow})`} fill-opacity="0.55" />
              <circle cx="32" cy="7.4" r="2.6" fill={LASER_RED} />
            {:else}
              <circle cx="20" cy="10" r="7.5" fill={LASER_RED} fill-opacity="0.22" />
              <circle cx="20" cy="10" r="3.4" fill={LASER_RED} />
            {/if}
          </svg>
          <span class="text-[14px] leading-[18px] {on ? 'font-semibold text-ink' : 'text-muted'}">{choice.name}</span>
          <span class="ml-auto text-[11px] font-semibold leading-[14px] text-muted">{choice.says}</span>
        </button>
      {/each}
    </div>
    <p class="mt-2.5 border-t border-line px-2 pt-2.5 text-2xs text-muted">
      {tr('room.pult4.laserNote', { s: oneDecimal(PHRASE_HOLD_MS / 1000) })}
    </p>
  {/if}
</div>

{#snippet hold(says: string)}
  <!--
    The straight line on hold, said where the pen is chosen: a stroke held
    still at its end straightens (InkLayer · `straighten`). The picture is the
    ring the console draws at the pen's tip while it holds.
  -->
  <div class="mt-4 flex items-center gap-3 border-t border-line pt-3.5">
    <svg width="40" height="24" viewBox="0 0 40 24" fill="none" class="block shrink-0" aria-hidden="true">
      <path d="M3 18 L 27 9" class="text-ink" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <circle cx="29" cy="8" r="6" class="text-line" stroke="currentColor" stroke-width="2" />
      <path d="M29 2 A 6 6 0 1 1 23 8" class="text-accent" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
    <span class="min-w-0 flex-1 whitespace-pre-line text-2xs font-normal text-muted">{says}</span>
  </div>
{/snippet}
