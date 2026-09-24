/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,svelte}'],
  /*
   * `hover:*` — only where there is a real pointer: the flag wraps EVERY such
   * utility in `@media (hover: hover) and (pointer: fine)`.
   *
   * The console and the notebook are opened on an iPad, and a tap on a touch
   * screen leaves hover hanging until the next touch somewhere else: the
   * highlight stuck on Interrupt/Restart/Clear in the run bar, on the cell
   * toolbar and on the file tree rows — the finger lifted, the button still
   * "under the cursor". A flag rather than a pass over the files, because the
   * rule is one for the whole project and the next `hover:` utility anyone
   * writes must get it by itself.
   *
   * The flag's price: hover stops being an input on a touch screen, so
   * everything that opens ONLY on hover must have a second path —
   * `focus-within`, the selected cell, an open menu.
   */
  future: { hoverOnlyWhenSupported: true },
  // Mirrors the token cascade in index.css: an explicit [data-theme] wins over
  // the OS preference, so a `dark:` utility never disagrees with its palette.
  darkMode: [
    'variant',
    [
      '@media (prefers-color-scheme: dark) { &:not([data-theme="light"] *) }',
      '&:is([data-theme="dark"] *)',
    ],
  ],
  theme: {
    // OUTSIDE `extend`, and that is the whole point: `extend` MERGES with
    // Tailwind's defaults, so `.ease-in { cubic-bezier(0.4, 0, 1, 1) }` was
    // still generated the moment anyone wrote the utility. index.css:99 bans
    // that curve rather than merely not using it, and a ban enforced only in
    // the token file is not enforced in the layer the next component actually
    // reaches for. Replacing the set is what makes `ease-in` unwritable.
    //
    // DEFAULT is restated at Tailwind's own value so every `transition-*`
    // utility keeps the timing function it has today — this change removes a
    // curve, it does not retune the product — and `linear` stays because
    // constant motion is a real job (a progress fill, a marquee).
    transitionTimingFunction: {
      DEFAULT: 'cubic-bezier(0.4, 0, 0.2, 1)',
      linear: 'linear',
      out: 'var(--ease-out)',
      'in-out': 'var(--ease-in-out)',
      drawer: 'var(--ease-drawer)',
    },
    extend: {
      colors: {
        // Everything routes through CSS variables so the palette stays in one place.
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised: 'rgb(var(--raised) / <alpha-value>)',
        sunken: 'rgb(var(--sunken) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        'line-soft': 'rgb(var(--line-soft) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        faint: 'rgb(var(--faint) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
        'brand-2': 'rgb(var(--brand-2) / <alpha-value>)',
        // accent = live state; primary = the action you press. They coincide in
        // dark and part ways in light, where cyan cannot carry a filled button.
        accent: 'rgb(var(--accent) / <alpha-value>)',
        // Accent-coloured *text*. Identical to accent in dark; darkened in light,
        // where the bright cyan fails contrast against every background.
        'accent-text': 'rgb(var(--accent-text) / <alpha-value>)',
        'accent-ink': 'rgb(var(--accent-ink) / <alpha-value>)',
        primary: 'rgb(var(--primary) / <alpha-value>)',
        'primary-ink': 'rgb(var(--primary-ink) / <alpha-value>)',
        positive: 'rgb(var(--positive) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
      },
      fontFamily: {
        // 'HSE Sans' leads and now always wins: index.html declares it with
        // @font-face, so the instance serves the four weights itself instead of
        // hoping the machine has them. Inter stays as the name to fall back to
        // if those files ever fail to arrive; nothing downloads it any more.
        sans: ["'HSE Sans'", 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        // There is deliberately no stack here: there is one for the whole
        // product, and it lives in index.css (--font-mono) — together with the
        // fallback families that carry metric overrides for JetBrains Mono
        // (index.html), so that swap does not move lines. The terminal drawer
        // and the kernel's html output use the same variable; a list in four
        // places has already drifted apart once.
        mono: ['var(--font-mono)'],
      },
      // Readable workspace scale. Words and actions start at 13px; the smaller
      // step is reserved for compact counters and keyboard hints.
      fontSize: {
        micro: ['12px', '16px'],
        '2xs': ['13px', '18px'],
        code: ['13px', '20px'],
        ui: ['14px', '21px'],
        'code-lg': ['14px', '22px'],
        'ui-lg': ['15px', '22px'],
        prose: ['15px', '24px'],
        answer: ['15px', '25px'],
        title: ['18px', '24px'],
        head: ['22px', '28px'],
        /*
         * Prompter text: the speaker's note, and nobody else's. It is read
         * with the head RAISED, in snatches between glances at the hall — that
         * is, from the same distance as the clock, and in the same half
         * seconds. The thirteen pixels of a working line here mean "lean
         * towards the tablet", and there is no time to lean in the middle of a
         * sentence. The leading is generous: the eye returns to the line not
         * continuously but anew every time.
         *
         * There are THREE steps, and it is a ladder, not two sizes plus an
         * extra. There used to be 19/29 and 25/36 here, set in a hurry: 19 as
         * the default is exactly that "lean in", and the second step was
         * chosen not as "reading without looking" but as "a bit bigger". Now
         * 18 is the floor (in the presenter's narrow column on a laptop, room
         * is worth more than point size), 22 is the DEFAULT (on the console
         * strip that is exactly 60 characters per line at a 658 px measure,
         * that is, a real paragraph of speech), 28 is "reading across the
         * whole hall without focusing". The middle step carries the bare name
         * `prompt` on purpose: it is the default, and the markup should show
         * that without comparing numbers.
         *
         * Tracking −0.01em is the same for all three: light text on a night
         * ground already spreads the letters wider, and extra air between them
         * adds length to the line but not readability.
         */
        'prompt-sm': ['18px', { lineHeight: '26px', letterSpacing: '-0.01em' }],
        prompt: ['22px', { lineHeight: '32px', letterSpacing: '-0.01em' }],
        'prompt-lg': ['28px', { lineHeight: '40px', letterSpacing: '-0.01em' }],
        /*
         * Two steps for the CONSOLE, and they are not here out of greed for
         * size.
         *
         * Everything else in this product is read from half a metre, sitting;
         * the console is held at arm's length and glanced at for half a second,
         * standing in front of the audience without taking one's eyes off the
         * hall. At that distance 20px means "squinting", and the lecture clock
         * and the page number have to be readable with peripheral vision. The
         * names are by purpose, like the whole scale: a gauge reading.
         */
        gauge: ['30px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
        'gauge-lg': ['40px', { lineHeight: '40px', letterSpacing: '-0.03em' }],
        display: ['26px', { lineHeight: '30px', letterSpacing: '-0.02em' }],
        // The seminar name across the top of the workspace. A step of its own
        // because the poster masthead is drawn for a half-width column with
        // nothing under it, and at 76px it would own a screen that has a
        // notebook to get on with. Same voice, one room quieter.
        // The object form is the one Tailwind reads letter-spacing out of; the
        // three-element form below silently drops it.
        marquee: ['46px', { lineHeight: '48px', letterSpacing: '-0.03em' }],
        // The same name on a phone. At 46px a 390px screen fits about seven
        // characters of it, so "Week 7 — Attention" arrived as "Week 7 — …":
        // the loudest thing on the screen, saying nothing. 26px fits the whole
        // of a typical seminar name in the width a phone actually has.
        'marquee-sm': ['26px', { lineHeight: '30px', letterSpacing: '-0.02em' }],
        // The poster headline, and the largest type in the product. Retuned from
        // 42px to the join artboard, where the seminar name is the whole point
        // of the screen; at 42px it read as a page title instead of a poster.
        masthead: ['76px', { lineHeight: '74px', letterSpacing: '-0.038em' }],
        /*
         * The join screen's mark, sized for a CIRCLE rather than for a box. A
         * glyph is bounded by the circle's inscribed square — 0.707 of the
         * diameter — not by its width, so a wide, flat emoji (the hippo, the
         * whale) pokes out of a 56px disc long before a square one does. Apple
         * Color Emoji also paints about 1.17x its font-size, which measuring
         * the box does not show. 32px clears both.
         */
        mark: ['32px', { lineHeight: '32px' }],
        // The sign-in poster's headline (2X6-0). Smaller than the join poster's
        // because that screen carries a lede and a footnote under the title and
        // the two cards beside it are the thing to read first.
        banner: ['56px', { lineHeight: '56px', letterSpacing: '-0.035em' }],
      },
      letterSpacing: {
        // 0.14em on 11px uppercase is the label voice used across every panel;
        // it was pasted as an arbitrary value eight times before this existed.
        label: '0.14em',
        caps: '0.08em',
        // Panel and sidebar section labels — FILES, PEOPLE, ORACLE, TEACHING.
        // A step wider than `label`, which is what the artboards draw them at;
        // the two are not interchangeable and the rail is where the difference
        // shows, because three of these labels stack in one column.
        section: '0.2em',
        // The COLLOQ lockup only. Wider than label, because six letters have to
        // hold together as a mark rather than read as a word.
        wordmark: '0.22em',
        // The institution line trailing the lockup — a step tighter than the
        // wordmark so it stays subordinate at the same size.
        institution: '0.16em',
      },
      boxShadow: {
        pop: '0 12px 32px -12px rgb(var(--shadow-color) / var(--shadow-pop)), 0 0 0 1px rgb(var(--line) / 0.9)',
        glow: '0 0 0 1px rgb(var(--accent) / 0.5), 0 0 24px -6px rgb(var(--accent) / 0.45)',
      },
      // Motion values are NOT defined here. index.css :root owns the curves and
      // the speed ladder; this file only gives them Tailwind names, so there is
      // one number per decision in the product and not two that drift apart.
      transitionDuration: {
        quick: 'var(--speed-quick)',   // hover, focus, a colour settling
        press: 'var(--speed-press)',   // the transform under the finger
        panel: 'var(--speed-panel)',   // a panel or popover arriving
        // No `drawer`: the two full-height surfaces travel on transition:fly,
        // whose duration is a JS argument and cannot read a CSS variable. The
        // step it named had no consumer at all — see the ladder in index.css.
      },
      keyframes: {
        // 4px, not 12: this is an element appearing, not an element arriving
        // from somewhere. `shimmer` used to live here with zero usages in
        // web/src and animated background-position, which index.css forbids by
        // name (it repaints every frame); it is gone rather than left loaded.
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        blink: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.25' } },
      },
      animation: {
        // 160ms is the small-entrance tier (125-200ms), and the curve is the
        // token rather than the `ease-out` keyword it used to carry — the whole
        // point of --ease-out is that the built-in of the same name is weaker.
        // A var() resolves here because every consumer of this utility is
        // inside the app document, which loads index.css.
        'fade-up': 'fade-up 160ms var(--ease-out)',
        // The one place a built-in curve is still right. This is a heartbeat,
        // not an entrance: it never travels, it holds both ends, and the soft
        // symmetric keyword is what makes it read as breathing. The product's
        // own in-out curve is a snap-and-hold, which on a live dot reads as a
        // fault rather than a pulse.
        blink: 'blink 1.1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
