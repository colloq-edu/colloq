export type Encoding = 'br' | 'gzip'

/** Accepted encodings, highest client preference first; prefer Brotli on ties. */
export function preferredEncodings(header: string | undefined): Encoding[] {
  if (!header) return []
  const offered = new Map<string, number>()
  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().split(';')
    let q = 1
    for (const param of params) {
      const match = /^\s*q=([\d.]+)/i.exec(param)
      if (match) q = Number(match[1])
    }
    offered.set(token.trim().toLowerCase(), Number.isFinite(q) ? q : 0)
  }
  const quality = (name: Encoding) => offered.get(name) ?? offered.get('*') ?? 0
  return (['br', 'gzip'] as Encoding[])
    .filter(name => quality(name) > 0)
    .sort((a, b) => quality(b) - quality(a))
}
