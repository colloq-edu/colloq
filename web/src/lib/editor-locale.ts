import { tr } from '@shared/i18n'

/** CodeMirror phrase identifiers stay stable; only their display values change. */
const PHRASES = ["Find", "Replace", "next", "previous", "all", "match case", "regexp", "by word", "replace", "replace all", "close", "Go to line", "go", "current match", "on line", "replaced $ matches", "replaced match on line $", "Completions", "Selection deleted", "Diagnostics", "No diagnostics", "Control character", "Fold line", "Unfold line"]
export function editorPhrases(): Record<string, string> {
  return Object.fromEntries(PHRASES.map(phrase => [phrase, tr('room.editor.' + phrase)]))
}
