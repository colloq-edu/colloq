/**
 * Whether the reader has room for its right rail: 1024 px and up, the same
 * threshold as Tailwind's `lg`.
 *
 * Read through matchMedia rather than the width on resize, so the script and
 * the stylesheet cannot disagree about which side of the line a tablet is
 * on. A rune and not a pair of `lg:hidden` copies: the rail holds the same
 * blocks the phone shows inline, and two live copies of a copy button or a
 * list of links would be two of everything for a screen reader.
 */
export const WIDE_QUERY = '(min-width: 1024px)'

export function wideScreen(): { readonly current: boolean } {
  let current = $state(window.matchMedia(WIDE_QUERY).matches)
  $effect(() => {
    const media = window.matchMedia(WIDE_QUERY)
    const sync = () => (current = media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  })
  return {
    get current() {
      return current
    },
  }
}
