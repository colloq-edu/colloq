<script lang="ts" module>
  /**
   * One component for the whole icon set: 16px glyphs on a 24 grid, sharing a
   * single stroke weight. Keeps the app free of an icon dependency and keeps
   * every glyph visually consistent by construction.
   */
  export type IconName = keyof typeof PATHS

  const PATHS = {
    play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    restart: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash:
      '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>',
    'chevron-up': '<path d="M6 15l6-6 6 6"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    duplicate: '<rect x="4" y="8" width="12" height="12" rx="2"/><path d="M8 4h10a2 2 0 0 1 2 2v10"/>',
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
    // The Seminars nav mark: a board with a header rail, not a code glyph.
    board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
    // Курс — папка семинаров. Единственное место в продукте, где эта метафора
    // уместна: остальное к файлам отношения не имеет.
    folder: '<path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h4.1l2 2.4h8.5A1.7 1.7 0 0 1 21 8.6v9.7a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 18.3V6.2z"/>',
    // The theme pair. Both live here so the switch on the brand band and the one
    // on the canvas cannot drift apart.
    sun:
      '<circle cx="12" cy="12" r="4.2"/>' +
      '<path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/>',
    moon: '<path d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8a8.4 8.4 0 1 0 10.6 10.6z"/>',
    text: '<path d="M5 6h14M5 12h9M5 18h12"/>',
    // Карандаш: правка того, что уже записано.
    pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M14.5 7.5 16.5 9.5"/>',
    send: '<path d="M4.5 12L20 4.5 15 20l-3.5-6.5z"/><path d="M11.5 13.5L20 4.5"/>',
    more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
    eraser: '<path d="M8 20H5l-2-2 9-9 6 6-5 5z"/><path d="M12 5l4-2 5 5-3 4"/>',
    // A shipping crate: an environment is a built container image, and the
    // Environments artboard draws it as one.
    box: '<path d="M21 8.5v7a1.6 1.6 0 0 1-.85 1.41l-7.4 3.9a1.6 1.6 0 0 1-1.5 0l-7.4-3.9A1.6 1.6 0 0 1 3 15.5v-7"/><path d="M3.4 7.6l8.6-4.5 8.6 4.5-8.6 4.5-8.6-4.5z"/><path d="M12 12.1V20"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/>',
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
