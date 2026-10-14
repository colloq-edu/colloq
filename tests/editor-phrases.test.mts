/**
 * The editors' phrases (web/src/lib/editor-locale.ts) are one object while
 * their words stay the same.
 *
 * CodeMirror's view redraws itself whole when the phrases facet changes, and
 * the facet compares its maps by reference (@codemirror/view: "When the
 * phrases change, redraw the editor"). CodeEditor sets its labels right after
 * every build, so a fresh map from each call built every editor's view twice.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.ts'
import { editorPhrases } from '../web/src/lib/editor-locale.ts'

let language = 'ru'
setLocaleResolver(() => language)
after(() => setLocaleResolver(() => 'ru'))

test('the same words are the same object, so a label update redraws no editor', () => {
  const first = editorPhrases()
  assert.equal(editorPhrases(), first)
  assert.equal(editorPhrases(), first)
  assert.notEqual(first.Find, 'room.editor.Find', 'the phrases are translated, not bare keys')
})

test('another language is another object, with its own words', () => {
  language = 'ru'
  const ru = editorPhrases()
  language = 'en'
  const en = editorPhrases()
  assert.notEqual(en, ru)
  assert.notEqual(en.Find, ru.Find)
  assert.equal(editorPhrases(), en)
  language = 'ru'
  assert.deepEqual(editorPhrases(), ru)
})
