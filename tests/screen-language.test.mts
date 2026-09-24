/**
 * A screen's dictionary: one area, one language.
 *
 * The shared `full-language` carried 351 KB of source and both languages ahead
 * of every screen — including the whole teacher panel catalog to a student and
 * the whole server catalog to everyone. Cutting it took three places at once:
 * the build plugin decides what goes into a chunk, `registerMessages` learns to
 * top up a second language onto an already known key, and `translate` learns
 * to read while that language is still on its way. A mistake in any of the
 * three looks the same: `room.ui.862` in the middle of a form.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { messages } from '../shared/i18n.js'
import { collectClientKeys } from '../web/scripts/entry-messages.js'
import config from '../web/vite.config.js'

const root = path.resolve(import.meta.dirname, '..')
const folder = path.join(root, 'web/src/lib/messages')
const plugin = (config as any).plugins.find((item: any) => item.name === 'colloq-screen-language')

/** What the plugin puts into the chunk in place of the area's source file. */
function built(area: string, locale: string): Record<string, Record<string, unknown>> {
  const code = plugin.load.call(
    { addWatchFile() {} },
    path.join(folder, `${area}-${locale}.ts`),
  ) as string
  assert.match(code, /^import \{ registerMessages \} from '@shared\/i18n-runtime'/)
  return JSON.parse(code.slice(code.indexOf('registerMessages(') + 'registerMessages('.length, code.lastIndexOf(')')))
}

test('every area speaks every language, and the loader names all eight modules', () => {
  const files = fs.readdirSync(folder).sort()
  assert.deepEqual(files, [
    'admin-en.ts', 'admin-ru.ts', 'competitions-en.ts', 'competitions-ru.ts',
    'reader-en.ts', 'reader-ru.ts', 'room-en.ts', 'room-ru.ts',
  ])
  // The names are listed in the loader by hand (the bundler does not read
  // computed paths), so they can drift away from the directory silently.
  const loader = fs.readFileSync(path.join(root, 'web/src/lib/screen-language.ts'), 'utf8')
  for (const file of files) assert.ok(loader.includes(`./messages/${file.replace(/\.ts$/, '')}`), file)
})

test('a screen carries one language and only the catalogs it reads', () => {
  const room = built('room', 'ru')
  const admin = built('admin', 'ru')
  const reader = built('reader', 'ru')
  const competitions = built('competitions', 'ru')
  for (const [name, catalog] of Object.entries({ room, admin, reader, competitions })) {
    for (const pair of Object.values(catalog)) {
      assert.deepEqual(Object.keys(pair), ['ru'], `${name} ships a second language`)
    }
  }
  assert.ok(room['room.ui.0'] && room['common.reload'] && room['activity.title'])
  assert.equal(room['admin.teaching'], undefined, 'the room pays for the teacher panel')
  assert.ok(admin['admin.teaching'] && admin['room.ui.0'])
  assert.ok(reader['room.ui.0'])
  assert.equal(reader['admin.teaching'], undefined)
  // The competition pages pay neither for the room nor for the panel: they have
  // no cell, no kernel, no list of seminars.
  assert.ok(competitions['competitions.state.live'] && competitions['common.reload'])
  assert.equal(competitions['room.ui.0'], undefined)
  assert.equal(competitions['admin.teaching'], undefined)
  // Russian and English are separate chunks, not one chunk with two halves.
  assert.equal(built('room', 'en')['room.ui.0'].en, messages['room.ui.0'].en)
  assert.equal(built('room', 'en')['room.ui.0'].ru, undefined)
})

test('one language of the room is a fraction of what every screen used to carry', () => {
  const whole = Buffer.byteLength(JSON.stringify(messages))
  const room = Buffer.byteLength(JSON.stringify(built('room', 'ru')))
  assert.ok(room * 3 < whole, `room ${room} B against the shared dictionary ${whole} B`)
})

/*
 * The server catalog is the only one cut by key. A miss here does not crash; it
 * prints the key instead of the word "busy" under the cell.
 */
test('the server catalog keeps exactly what a browser can look up', () => {
  const client = collectClientKeys(root, messages, 'server')
  for (const key of [
    'server.classOver', 'server.defaultNotebook', 'server.welcomeNotebook',
    'server.councilSharedKernel', 'server.kernel_word.busy', 'server.kernel_word.restarting',
    'server.shell_word.closed', 'server.skip_reason_text.duplicate',
  ]) assert.ok(client.has(key), `the client looks up ${key}, but it was cut out`)
  const room = built('room', 'ru')
  for (const key of client) assert.ok(room[key], `${key} did not reach the room`)
  // And the publication pages are rendered by the server itself; their words are
  // not in the browser.
  const server = Object.keys(messages).filter((key) => key.startsWith('server.'))
  assert.ok(client.size * 5 < server.length, `${client.size} of ${server.length} is not a subset`)
  assert.equal(room['server.ssr.download'], undefined)
})

/*
 * The second language arrives as a separate chunk, and later. While it is on its
 * way, the key is already known — with half of the pair — and has to read in the
 * language that is already there.
 */
test('a half-known key reads in the language that did arrive, never as a key', async () => {
  const child = await import('node:child_process').then(({ spawnSync }) => spawnSync(
    process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerMessages, translate, messages } from './shared/i18n-runtime.ts';
    registerMessages({ 'room.demo': { ru: 'Войти' } });
    assert.equal(translate('ru', 'room.demo'), 'Войти');
    assert.equal(translate('en', 'room.demo'), 'Войти', 'the other language must not read as a key');
    registerMessages({ 'room.demo': { en: 'Join' } });
    assert.equal(translate('en', 'room.demo'), 'Join');
    assert.equal(translate('ru', 'room.demo'), 'Войти');
    assert.deepEqual(messages['room.demo'], { ru: 'Войти', en: 'Join' });
    assert.throws(() => registerMessages({ 'room.demo': { en: 'Enter' } }), /Conflicting translation key/);
    assert.equal(translate('ru', 'room.nothing'), 'room.nothing');
  `], { cwd: process.cwd(), encoding: 'utf8' },
  ))
  assert.equal(child.status, 0, child.stderr || child.stdout)
})

test('a registered catalog is copied, not adopted', async () => {
  // Topping up the second language edits the pair IN PLACE: doing that to an
  // object from another catalog means changing it for everyone who imported that catalog.
  const { roomMessages } = await import('../shared/locales/room.js')
  assert.deepEqual(messages['room.ui.0'], roomMessages['room.ui.0'])
  assert.notEqual(messages['room.ui.0'], roomMessages['room.ui.0'], 'the runtime holds the source catalog itself')
})

/*
 * Intl is expensive to build: the first object brings up ICU, and that is tens
 * of milliseconds on a cold tab. A pair of plural rules sat at the top level of
 * the module — that is, in the ENTRY chunk, before the first frame of a form
 * that has no plural in any of its labels.
 */
test('Intl is built when it is first needed, and only once per shape', async () => {
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const counts = { plural: 0, date: 0 };
    for (const [name, key] of [['PluralRules', 'plural'], ['DateTimeFormat', 'date']]) {
      const Real = Intl[name];
      Intl[name] = class extends Real { constructor(...args) { counts[key]++; super(...args) } };
    }
    const { registerMessages, translate, formatDate, setLocaleResolver } = await import('./shared/i18n-runtime.ts');
    assert.deepEqual(counts, { plural: 0, date: 0 }, 'importing the runtime built an Intl object');
    setLocaleResolver(() => 'ru');
    registerMessages({ 'room.plain': { ru: 'Имя' }, 'room.count': { ru: { one: '{count} шаг', other: '{count} шагов' } } });
    translate('ru', 'room.plain');
    assert.equal(counts.plural, 0, 'a plain string asked for plural rules');
    translate('ru', 'room.count', { count: 1 });
    translate('ru', 'room.count', { count: 5 });
    assert.equal(counts.plural, 1, 'plural rules are rebuilt per call');
    const options = { day: '2-digit', month: '2-digit' };
    for (let i = 0; i < 5; i++) formatDate(1700000000000, { ...options });
    assert.equal(counts.date, 1, 'every timestamp built its own formatter');
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr || child.stdout)
})
