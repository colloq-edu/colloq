import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { collectEntryMessages } from '../web/scripts/entry-messages.js'
import { messages, translate } from '../shared/i18n.js'
import { MARKS } from '../shared/marks.js'
import { loadLocalizedScreen } from '../web/src/lib/screen-language.js'

const entry = collectEntryMessages(path.resolve(import.meta.dirname, '..'), messages)

test('entry carries its visible and failure copy in both languages, including generated mark names', () => {
  for (const key of [
    'common.loadingApp', 'common.moduleLoadFailed', 'common.http403', 'common.requestFailed',
    'room.ui.0', 'room.ui.120', 'room.ui.862', 'room.ui.863', 'room.ui.864', 'room.ui.1210',
    ...MARKS.map((mark) => 'room.mark.' + mark.name),
  ]) {
    assert.ok(entry.messages[key], `missing cold-entry key ${key}`)
    for (const locale of ['ru', 'en'] as const) {
      assert.deepEqual(entry.messages[key][locale], messages[key][locale])
      assert.notEqual(translate(locale, key), key)
    }
  }
  assert.ok(Object.keys(entry.messages).length < 250, 'a new import pulled unrelated catalogs into entry')
  assert.ok(Buffer.byteLength(JSON.stringify(entry.messages)) < 30_000)
  assert.equal(entry.messages['admin.teaching'], undefined)
  assert.ok(!entry.files.some((file) => /persistence|SessionScreen|AdminScreen|ReaderScreen|full-language/.test(file)))
})

test('a lazy screen is not evaluated until all of its translated constants can resolve', async () => {
  let finish!: () => void
  let registered = false
  let evaluated = false
  const loading = new Promise<void>((resolve) => { finish = () => { registered = true; resolve() } })
  const screen = loadLocalizedScreen(async () => {
    assert.ok(registered)
    evaluated = true
    return 'screen'
  }, () => loading)
  await Promise.resolve()
  assert.equal(evaluated, false)
  finish()
  assert.equal(await screen, 'screen')
  let failedScreen = false
  await assert.rejects(loadLocalizedScreen(async () => { failedScreen = true }, async () => { throw new Error('offline') }), /offline/)
  assert.equal(failedScreen, false)
})

test('the real lazy loader registers admin, History, and shared notebook copy before evaluation', () => {
  // Fresh process: importing the complete test catalog above must not make
  // this pass by having already populated the browser's runtime registry.
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { tr, messages } from './shared/i18n-runtime.ts';
    import { loadLocalizedScreen } from './web/src/lib/screen-language.ts';
    assert.equal(Object.keys(messages).length, 0);
    await loadLocalizedScreen(async () => {
      for (const key of ['admin.teaching', 'activity.title', 'activity.versions', 'room.ui.651', 'server.defaultNotebook']) {
        assert.notEqual(tr(key), key, 'late screen evaluated before ' + key);
      }
    });
  `], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr || child.stdout)
})
