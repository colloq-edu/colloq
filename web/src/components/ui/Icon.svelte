<script lang="ts" module>
  /**
   * One component for the whole icon set: 16px glyphs on a 24 grid, sharing a
   * single stroke weight. Keeps the app free of an icon dependency and keeps
   * every glyph visually consistent by construction.
   */
  export type IconName = keyof typeof PATHS

  const PATHS = {
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18M12 3c-5 5-5 13 0 18"/>',
    play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    restart: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
    /*
     * Undo is an arrow that lies back down onto the line, not a circular one:
     * in this product the circular arrow is taken by `restart`, and "restart
     * the kernel" next to "undo the stroke" would be two different decisions
     * with a single icon.
     */
    undo: '<path d="M4 10h10a5 5 0 0 1 0 10h-6"/><path d="M8 6l-4 4 4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash:
      '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>',
    'chevron-up': '<path d="M6 15l6-6 6 6"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    /*
     * Duplicate is the same pair of sheets as `copy`, but with a plus: the copy
     * does not go off to the clipboard, it is LAID DOWN next to the original,
     * and these are different actions that sit one under the other in the same
     * menu. A single `copy` for both would read as "copy again", a single
     * `plus` as "new file".
     */
    'copy-plus':
      '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/><path d="M14.5 14.5h-4M12.5 12.5v4"/>',
    sparkles:
      '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    upload: '<path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    download: '<path d="M12 4v12M8 12l4 4 4-4"/><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>',
    users:
      '<path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.5a4 4 0 0 0-3-3.87"/><path d="M15.5 4.13a3.5 3.5 0 0 1 0 6.74"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2A5 5 0 0 0 12.5 4.5l-1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2A5 5 0 0 0 11.5 19.5l1-1"/>',
    code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
    // A shell prompt rather than a pair of angle brackets: this one names the
    // terminal, `code` names source. VH-0 draws them differently for that reason.
    prompt: '<path d="M5 7l5 5-5 5M12 17h7"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    'arrow-right': '<path d="M5 12h13M13 7l5 5-5 5"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
    /*
     * The same body and the same shackle, released from the right post: an open
     * lock has to read as THIS lock in another position, not as a second icon.
     * The pair appears side by side in the notebook — one on one cell, the
     * other on the next — and what tells them apart should be the movement of
     * the shackle, not the silhouette.
     */
    unlock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 6.8-.9"/>',
    // The Seminars nav mark: a board with a header rail, not a code glyph.
    board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
    // A course is a folder of seminars. The only place in the product where
    // this metaphor fits: nothing else has anything to do with files.
    folder: '<path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h4.1l2 2.4h8.5A1.7 1.7 0 0 1 21 8.6v9.7a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 18.3V6.2z"/>',
    /*
     * Icons for file kinds. Drawn on the same 24 grid and with the same stroke
     * weight, so that the column of names reads as a column and not as a set of
     * pictures: the difference between rows should be in the silhouette alone,
     * not in the line weight.
     */
    notebook:
      '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5v-15z"/><path d="M5 17.5h13.5"/><path d="M9 3v14.5"/>',
    table:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="1"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v15"/>',
    image:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="1"/><circle cx="9" cy="9.5" r="1.6"/><path d="M4 17l4.5-4.5 3.5 3.5 3-2.5 5 4"/>',
    braces:
      '<path d="M9.5 3.5c-2 0-2.5 1-2.5 3v2c0 1.5-.6 2.5-2 3 1.4.5 2 1.5 2 3v2c0 2 .5 3 2.5 3"/><path d="M14.5 3.5c2 0 2.5 1 2.5 3v2c0 1.5.6 2.5 2 3-1.4.5-2 1.5-2 3v2c0 2-.5 3-2.5 3"/>',
    pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 17v-4h1.5a1.2 1.2 0 0 1 0 2.4H8.5"/><path d="M12.5 17v-4h1.3c1 0 1.7.8 1.7 2s-.7 2-1.7 2h-1.3z"/>',
    'file-plus':
      '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/>',
    'folder-plus':
      '<path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h4.1l2 2.4h8.5A1.7 1.7 0 0 1 21 8.6v9.7a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 18.3V6.2z"/><path d="M12 10.5v6M9 13.5h6"/>',
    // The theme pair. Both live here so the switch on the brand band and the one
    // on the canvas cannot drift apart.
    sun:
      '<circle cx="12" cy="12" r="4.2"/>' +
      '<path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/>',
    moon: '<path d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8a8.4 8.4 0 1 0 10.6 10.6z"/>',
    text: '<path d="M5 6h14M5 12h9M5 18h12"/>',
    // Pencil: editing what has already been written.
    pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M14.5 7.5 16.5 9.5"/>',
    send: '<path d="M4.5 12L20 4.5 15 20l-3.5-6.5z"/><path d="M11.5 13.5L20 4.5"/>',
    more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
    eraser: '<path d="M8 20H5l-2-2 9-9 6 6-5 5z"/><path d="M12 5l4-2 5 5-3 4"/>',
    // The marker sits next to the eraser on purpose: they are neighbours on the
    // console's right rail, and their silhouettes should be told apart at the
    // first glance, not the second.
    marker:
      '<path d="M5 20h6"/><path d="M8.5 16.5 6 14l9-9 3.5 3.5-9 9-1 1z"/><path d="M14 6.5 17.5 10"/>',
    /*
     * The pointer is a DOT WITH A TRAIL, that is, exactly what it leaves on a
     * slide. Its rail neighbours are drawn by the same rule: the pen, the
     * marker and the eraser are tools, but people recognise them by what they
     * do, not by their bodies.
     *
     * The first sketch was a star with rays in all directions — "a point of
     * light". On the rail it read as BRIGHTNESS and stood three keys away from
     * "Blank", which is precisely about brightness. The tail removes the
     * confusion: brightness has no tail.
     */
    laser:
      '<path d="M3.6 17.4c3.2-1.1 5.4-3.6 7.2-6.1"/>' +
      '<circle cx="16.4" cy="7.6" r="2.8" fill="currentColor" stroke="none"/>' +
      '<circle cx="16.4" cy="7.6" r="6.2" opacity="0.45"/>',
    // Four corners: "full screen". No arrows inside — they read as direction,
    // and this button is about bounds, not direction.
    expand: '<path d="M4 9V4h5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M9 20H4v-5"/>',
    // A shipping crate: an environment is a built container image, and the
    // Environments artboard draws it as one.
    box: '<path d="M21 8.5v7a1.6 1.6 0 0 1-.85 1.41l-7.4 3.9a1.6 1.6 0 0 1-1.5 0l-7.4-3.9A1.6 1.6 0 0 1 3 15.5v-7"/><path d="M3.4 7.6l8.6-4.5 8.6 4.5-8.6 4.5-8.6-4.5z"/><path d="M12 12.1V20"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/>',
    // The room header: a small window with a filled top band. Not an up arrow —
    // an arrow promises scrolling or navigation, whereas what folds away here
    // is exactly the band visible above the button.
    masthead:
      '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
      '<path d="M4.6 4h14.8A1.6 1.6 0 0 1 21 5.6V9.4H3V5.6A1.6 1.6 0 0 1 4.6 4z" fill="currentColor" stroke="none"/>',
    alert:
      '<path d="M10.6 3.9 2.5 18a1.6 1.6 0 0 0 1.4 2.4h16.2A1.6 1.6 0 0 0 21.5 18L13.4 3.9a1.6 1.6 0 0 0-2.8 0z"/><path d="M12 9v4.5"/><path d="M12 17.2h.01"/>',
    // The brand grid: corners and centre filled, edges as a tint of the same ink.
    logo:
      '<rect x="2" y="2" width="6" height="6" rx="1.6" fill="currentColor" stroke="none"/>' +
      '<rect x="9" y="2" width="6" height="6" rx="1.6" fill="currentColor" stroke="none" opacity="0.42"/>' +
      '<rect x="16" y="2" width="6" height="6" rx="1.6" fill="currentColor" stroke="none"/>' +
      '<rect x="2" y="9" width="6" height="6" rx="1.6" fill="currentColor" stroke="none" opacity="0.42"/>' +
      '<rect x="9" y="9" width="6" height="6" rx="1.6" fill="currentColor" stroke="none"/>' +
      '<rect x="16" y="9" width="6" height="6" rx="1.6" fill="currentColor" stroke="none" opacity="0.42"/>' +
      '<rect x="2" y="16" width="6" height="6" rx="1.6" fill="currentColor" stroke="none"/>' +
      '<rect x="9" y="16" width="6" height="6" rx="1.6" fill="currentColor" stroke="none" opacity="0.42"/>' +
      '<rect x="16" y="16" width="6" height="6" rx="1.6" fill="currentColor" stroke="none"/>',
  } as const
</script>

<script lang="ts">
  interface Props {
    name: IconName
    size?: number
    class?: string
    strokeWidth?: number
  }

  let { name, size = 16, class: className = '', strokeWidth = 1.8 }: Props = $props()
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden="true"
>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- constant markup from the table above -->
  {@html PATHS[name]}
</svg>
