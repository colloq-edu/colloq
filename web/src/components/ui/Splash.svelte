<script lang="ts">
  /**
   * The app splash: the mark in the centre and a thin bar under it.
   *
   * The same picture that `#boot` draws in `web/index.html`, and that is its
   * main property. The shell goes away, and the splash stays standing in its
   * place — at the same coordinates, the same size, with the same animation —
   * so to a person it is ONE continuous splash, not two that replaced each
   * other. That is why the numbers below are a copy of the ones there, and they
   * are edited as a pair: index.html has a pointer here, and this file has one
   * there.
   *
   * Why a copy and not a shared file: `#boot` is drawn before the app's CSS
   * arrives (the stylesheet loads without blocking, see vite.config.ts), so its
   * own `--boot-*` tokens and its own markup are unavoidable. The mark,
   * meanwhile, is drawn from the same set of cells — here through
   * `Icon name="logo"`, there with the same SVG written by hand.
   *
   * Replaces the "page" and "notebook" skeletons: grey layout promises a
   * specific screen and appears before anything about that screen is known —
   * whereas the splash promises only "loading", which is the truth.
   */
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'

  interface Props {
    /**
     * `screen` — in place of the whole screen: exactly where `#boot` stood.
     * `pane` — inside an interface that is already drawn (the notebook area in
     * the room, the page body in the reader): quieter and smaller, so as not to
     * compete with what is already around it.
     */
    size?: 'screen' | 'pane'
    label?: string
  }

  let { size = 'screen', label = tr('common.loading') }: Props = $props()

  // The mark is smaller in a pane for the same reason the bar is shorter: a
  // nested splash cannot be bigger than the one that stands in for the screen.
  const MARK = { screen: 28, pane: 20 } as const
</script>

<!--
  `role="status"` with `aria-busy` — the same as on `#boot` and on the skeletons
  this splash replaced: a screen reader announces "Loading…" once, not every
  minute while the wait goes on.
-->
<div
  class="splash {size}"
  data-splash={size}
  role="status"
  aria-label={label}
  aria-busy="true"
>
  <div class="mark">
    <Icon name="logo" size={MARK[size]} />
    <span class="bar" aria-hidden="true"></span>
  </div>
</div>

<style>
  /*
   * THE NUMBERS ARE A COPY OF #boot FROM web/index.html. Mark 28, bar 88×2, gap
   * 16, fade-in 0.25s after a 0.25s delay, sweep 1.1s ease-in-out. Once they
   * drift apart, they will produce a jump exactly at the moment the shell goes
   * away — the very thing this splash was introduced to prevent.
   */
  .splash {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgb(var(--canvas));
  }

  /*
   * The screen splash is fixed, not "the whole parent box": it has to land on
   * the same centre of the window as `#boot`, no matter which branch of the
   * markup it was placed in. Its z-index is below the shell's (999): until the
   * shell is gone, this one stands under it and cannot be seen.
   */
  .screen {
    position: fixed;
    inset: 0;
    z-index: 30;
  }

  /*
   * The pane splash is an ordinary block in the flow. It has a minimum height
   * so that the area does not collapse into a strip: 240 px is roughly the
   * first cell of a notebook, that is, as much space as whatever is loading
   * will take up anyway.
   */
  .pane {
    width: 100%;
    height: 100%;
    min-height: 240px;
  }

  .mark {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    color: rgb(var(--ink));
    opacity: 0;
    /* A load that is faster than a quarter of a second should show nothing: a
       splash that blinks reads as a hiccup, not as waiting. */
    animation: splash-in 0.25s ease 0.25s forwards;
  }
  @keyframes splash-in {
    to {
      opacity: 1;
    }
  }

  .bar {
    display: block;
    position: relative;
    overflow: hidden;
    width: 88px;
    height: 2px;
    border-radius: 999px;
    background: rgb(var(--line));
  }
  .pane .bar {
    width: 64px;
  }
  .bar::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 40%;
    border-radius: inherit;
    background: rgb(var(--accent));
    transform: translateX(-100%);
    animation: splash-sweep 1.1s ease-in-out infinite;
  }
  @keyframes splash-sweep {
    to {
      transform: translateX(250%);
    }
  }

  /* As in `#boot`: there is no running accent at all, only a quiet bar
     remains — and it appears at once, since there is nothing to hold back. */
  @media (prefers-reduced-motion: reduce) {
    .mark {
      animation-delay: 0s;
    }
    .bar::after {
      width: 100%;
      transform: none;
      animation: none;
      opacity: 0.4;
    }
  }
</style>
