import { tr } from '@shared/i18n'
import type { CompetitionLeaderboard } from '@shared/competitions-api'

/** Keep numeric scores numeric, and prevent participant names from becoming spreadsheet formulas. */
function field(value: string | number | null): string {
  let text = value === null ? '' : String(value)
  if (typeof value === 'string' && (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

/** The teacher's full board, in its public order, with unrounded scores and both places. */
export function competitionLeaderboardCsv(board: Pick<CompetitionLeaderboard, 'public' | 'private'>): string {
  const headers = [
    tr('admin.competitions.csv.publicPlace'),
    tr('admin.competitions.csv.entrant'),
    tr('admin.competitions.csv.publicScore'),
    tr('admin.competitions.csv.privatePlace'),
    tr('admin.competitions.csv.privateScore'),
  ]
  const hidden = new Map(board.private.map((row) => [row.entrantId, row]))
  const lines = [headers.map(field).join(',')]
  for (const row of board.public) {
    const mirror = hidden.get(row.entrantId)
    lines.push([row.place, row.entrantName, row.score, mirror?.place ?? null, mirror?.score ?? null].map(field).join(','))
  }
  // Excel recognizes Cyrillic without an encoding dialog when the UTF-8 BOM is present.
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
