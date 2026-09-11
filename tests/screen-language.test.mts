/**
 * Словарь экрана: одна область, один язык.
 *
 * Общий `full-language` вёз 351 КБ исходника и оба языка перед любым экраном —
 * в том числе весь каталог панели преподавателя студенту и весь серверный
 * каталог всем. Резать его пришлось в трёх местах сразу: плагин сборки решает,
 * что попадёт в кусок, `registerMessages` учится доливать второй язык к уже
 * известному ключу, а `translate` — читаться, пока тот язык ещё в пути.
 * Ошибка в любом из трёх видна одинаково: `room.ui.862` посреди формы.
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

/** То, что плагин положит в кусок вместо исходного файла области. */
function built(area: string, locale: string): Record<string, Record<string, unknown>> {
  const code = plugin.load.call(
    { addWatchFile() {} },
    path.join(folder, `${area}-${locale}.ts`),
  ) as string
  assert.match(code, /^import \{ registerMessages \} from '@shared\/i18n-runtime'/)
  return JSON.parse(code.slice(code.indexOf('registerMessages(') + 'registerMessages('.length, code.lastIndexOf(')')))
}

test('every area speaks every language, and the loader names all six modules', () => {
  const files = fs.readdirSync(folder).sort()
  assert.deepEqual(files, [
    'admin-en.ts', 'admin-ru.ts', 'reader-en.ts', 'reader-ru.ts', 'room-en.ts', 'room-ru.ts',
  ])
  // Имена перечислены в загрузчике руками (сборщик не читает вычисленные
  // адреса) — разойтись с каталогом они умеют молча.
  const loader = fs.readFileSync(path.join(root, 'web/src/lib/screen-language.ts'), 'utf8')
  for (const file of files) assert.ok(loader.includes(`./messages/${file.replace(/\.ts$/, '')}`), file)
})

test('a screen carries one language and only the catalogs it reads', () => {
  const room = built('room', 'ru')
  const admin = built('admin', 'ru')
  const reader = built('reader', 'ru')
  for (const [name, catalog] of Object.entries({ room, admin, reader })) {
    for (const pair of Object.values(catalog)) {
      assert.deepEqual(Object.keys(pair), ['ru'], `${name} ships a second language`)
    }
  }
  assert.ok(room['room.ui.0'] && room['common.reload'] && room['activity.title'])
  assert.equal(room['admin.teaching'], undefined, 'the room pays for the teacher panel')
  assert.ok(admin['admin.teaching'] && admin['room.ui.0'])
  assert.ok(reader['room.ui.0'])
  assert.equal(reader['admin.teaching'], undefined)
  // Русский и английский — это разные куски, а не один с двумя половинами.
  assert.equal(built('room', 'en')['room.ui.0'].en, messages['room.ui.0'].en)
  assert.equal(built('room', 'en')['room.ui.0'].ru, undefined)
})

test('one language of the room is a fraction of what every screen used to carry', () => {
  const whole = Buffer.byteLength(JSON.stringify(messages))
  const room = Buffer.byteLength(JSON.stringify(built('room', 'ru')))
  assert.ok(room * 3 < whole, `комната ${room} B против общего словаря ${whole} B`)
})

/*
 * Серверный каталог — единственный, который режется по ключам. Промах здесь не
 * падает, а печатает ключ вместо слова «занято» под ячейкой.
 */
test('the server catalog keeps exactly what a browser can look up', () => {
  const client = collectClientKeys(root, messages, 'server')
  for (const key of [
    'server.classOver', 'server.defaultNotebook', 'server.welcomeNotebook',
    'server.councilSharedKernel', 'server.kernel_word.busy', 'server.kernel_word.restarting',
    'server.shell_word.closed', 'server.skip_reason_text.duplicate',
  ]) assert.ok(client.has(key), `клиент ищет ${key}, а его вырезали`)
  const room = built('room', 'ru')
  for (const key of client) assert.ok(room[key], `${key} не доехал до комнаты`)
  // А страницы публикации рисует сам сервер, и его слов в браузере нет.
  const server = Object.keys(messages).filter((key) => key.startsWith('server.'))
  assert.ok(client.size * 5 < server.length, `${client.size} из ${server.length} — это не подмножество`)
  assert.equal(room['server.ssr.download'], undefined)
})

/*
 * Второй язык приезжает отдельным куском и позже. Пока он в пути, ключ уже
 * известен — с половиной пары, — и читаться обязан прежним языком.
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
  // Долив второго языка правит пару НА МЕСТЕ: делать это с объектом из чужого
  // каталога значит менять его для всех, кто этот каталог импортировал.
  const { roomMessages } = await import('../shared/locales/room.js')
  assert.deepEqual(messages['room.ui.0'], roomMessages['room.ui.0'])
  assert.notEqual(messages['room.ui.0'], roomMessages['room.ui.0'], 'the runtime holds the source catalog itself')
})

/*
 * Intl строится дорого: первый объект поднимает ICU, и это десятки миллисекунд
 * на холодной вкладке. Пара правил множественного числа стояла на верхнем
 * уровне модуля — то есть во ВХОДНОМ куске, до первого кадра формы, где
 * множественного числа нет ни в одной надписи.
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
