/**
 * The Colloq mark is a 3×3 grid of cells.
 *
 * One pattern is the brand and never varies. A seminar gets its own pattern
 * derived from its session id, which is what makes four open seminars
 * distinguishable in a tab bar — the only reason a changing logo earns its keep.
 */
type GridPattern = readonly boolean[]

/** Corners and centre. Symmetric on both axes, so it survives 16px. */
const BRAND_GRID: GridPattern = [
  true, false, true,
  false, true, false,
  true, false, true,
]

/**
 * Below four filled cells the mark reads as empty, above seven as a solid
 * square — either way it stops being a pattern. An unconstrained hash reaches
 * both ends eventually, so the band is enforced rather than hoped for.
 */
const MIN_FILLED = 4
const MAX_FILLED = 7

function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function gridForSession(sessionId: string): GridPattern {
  // Re-salt rather than re-roll randomly: the same id must always give the same
  // mark, for every person in the room and for the whole life of the seminar.
  for (let salt = 0; salt < 32; salt++) {
    const hash = fnv1a(salt === 0 ? sessionId : `${sessionId}#${salt}`)
    const cells: boolean[] = []
    let filled = 0
    for (let i = 0; i < 9; i++) {
      const on = ((hash >>> i) & 1) === 1
      cells.push(on)
      if (on) filled++
    }
    if (filled >= MIN_FILLED && filled <= MAX_FILLED) return cells
  }
  return BRAND_GRID
}

interface SvgOptions {
  size?: number
  /** Filled cells. */
  ink?: string
  /** Unfilled cells — a tint of the ink, never the accent. */
  tint?: string
  background?: string
}

/** Standalone SVG markup, for the favicon data URI and anywhere outside Svelte. */
function gridSvg(pattern: GridPattern, options: SvgOptions = {}): string {
  const { size = 32, ink = '#FFFFFF', tint = '#2E4E8C', background } = options
  const cells: string[] = []
  for (let i = 0; i < 9; i++) {
    const x = 2 + (i % 3) * 7
    const y = 2 + Math.floor(i / 3) * 7
    const fill = pattern[i] ? ink : tint
    cells.push(`<rect x="${x}" y="${y}" width="6" height="6" rx="1.6" fill="${fill}"/>`)
  }
  const bg = background ? `<rect width="24" height="24" fill="${background}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${bg}${cells.join('')}</svg>`
}

export function gridFaviconHref(sessionId: string | null): string {
  const pattern = sessionId ? gridForSession(sessionId) : BRAND_GRID
  const svg = gridSvg(pattern, { background: '#0F2D69' })
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
