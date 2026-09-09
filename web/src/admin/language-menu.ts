/** Place the menu in viewport coordinates; its top-layer surface cannot be clipped by the shell. */
export function languageMenuPosition(
  anchor: { left: number; right: number; top: number; width: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const inset = 8
  const preferredLeft = anchor.width < 100 ? anchor.right + inset : anchor.left + 12
  return {
    left: Math.max(inset, Math.min(preferredLeft, viewport.width - menu.width - inset)),
    top: Math.max(inset, Math.min(anchor.top - menu.height - inset, viewport.height - menu.height - inset)),
  }
}
