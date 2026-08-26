/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,svelte}'],
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
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // A scale sized for a dense workspace. Tailwind's defaults start at 12px
      // and step in 2px, which is why every component was escaping into
      // text-[13px] and inventing its own line-height. Names say what the text
      // IS, not how big it is — that is what stops the next person reaching for
      // text-[13.5px]. Line-height is baked in, in px, so leading- is never
      // needed alongside these.
      fontSize: {
        micro: ['10px', '13px'],   // badges, the smallest thing we allow
        '2xs': ['11px', '16px'],   // uppercase section labels, meta
        code: ['12px', '19px'],    // mono: outputs, file sizes, terminal
        ui: ['13px', '19px'],      // the workhorse: rows, buttons, fields
        'code-lg': ['13px', '21px'], // mono: the editor itself
        'ui-lg': ['14px', '21px'],
        prose: ['14px', '23px'],   // assistant answers, markdown body
        title: ['16px', '22px'],
        head: ['20px', '26px'],
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
        // Panel and sidebar section labels — FILES, PEOPLE, ASSISTANT, TEACHING.
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
        drawer: 'var(--speed-drawer)', // a full-height surface from an edge
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
