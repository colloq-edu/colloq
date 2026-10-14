import { tr } from '@shared/i18n'

/** CodeMirror phrase identifiers stay stable; only their display values change. */
const PHRASES = ["Find", "Replace", "next", "previous", "all", "match case", "regexp", "by word", "replace", "replace all", "close", "Go to line", "go", "current match", "on line", "replaced $ matches", "replaced match on line $", "Completions", "Selection deleted", "Diagnostics", "No diagnostics", "Control character", "Fold line", "Unfold line"]
let last: Record<string, string> | null = null

/**
 * The editors' phrases in the current language: the same object while the
 * words stay the same.
 *
 * The view redraws itself whole (`setState`) when the phrases facet changes,
 * and the facet compares its maps by reference. CodeEditor sets its labels
 * right after every build (`setLabels`), so a new map from each call rebuilt
 * every editor's view once more right after it was made: on a page of thirty
 * cells, thirty views built twice.
 */
export function editorPhrases(): Record<string, string> {
  const next = Object.fromEntries(PHRASES.map(phrase => [phrase, tr('room.editor.' + phrase)]))
  if (last && PHRASES.every(phrase => last![phrase] === next[phrase])) return last
  last = next
  return next
}
