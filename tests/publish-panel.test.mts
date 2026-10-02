/**
 * «Страница занятия»: the panel's side of publishing a class.
 *
 * Three promises the screen makes, checked where they are kept.
 *
 * Every unticked row says why. The reasons are the server's decisions
 * (shared/materials.ts · notebookPick, filePick), and a row left unticked
 * without a word reads as a bug: the teacher ticks a student's notebook back
 * on because nothing said whose it was.
 *
 * «Проверил(а) — публиковать как есть» gates the button. A key in a cell goes
 * out to everyone with the link; the button stays disabled until someone
 * confirms the findings in what is ticked — and only those.
 *
 * No step words. The page is every notebook with its results, not a story of
 * checkpoints: «шаг», «момент» and «Отметить момент» are gone from the screen
 * and from the calls it makes.
 *
 * And, kept from before: the refusal "address already taken" names its
 * holder, so a former name can be released by its owner.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, translate, type Locale } from '../shared/i18n.js'
import type { FileChoice, NotebookChoice, PickReason, PublishCheck } from '../shared/publish.js'
import {
  checkText,
  fileReason,
  kindText,
  lockedFile,
  lockedNotebook,
  notebookMeta,
  notebookReason,
  publishBlocked,
  relevantChecks,
  sizeText,
} from '../web/src/admin/page-picker.js'
import {
  AdminApiError,
  addressHolderOf,
  adminApi,
  publishRefusal,
} from '../web/src/lib/adminApi.js'

afterEach(() => setLocaleResolver(() => 'ru'))

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and code without comments: an explanation is not a promise. */
function code(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** Static message calls resolved, so the copy can be read the way the screen shows it. */
function localized(source: string, locale: Locale): string {
  return source.replace(/\btr\(\s*['"]([^'"]+)['"][^)]*\)/g, (_m, key: string) => translate(locale, key))
}

const PUBLISH = 'web/src/admin/screens/Publish.svelte'

const book = (over: Partial<NotebookChoice>): NotebookChoice => ({
  root: 'nb:1',
  path: 'lecture.ipynb',
  cells: 54,
  outputs: 40,
  name: 'Лекция',
  picked: true,
  why: null,
  owner: null,
  isNew: false,
  ...over,
})

const file = (over: Partial<FileChoice>): FileChoice => ({
  path: 'data/train.csv',
  kind: 'data',
  bytes: 460 * 1024,
  name: 'train.csv',
  picked: true,
  why: null,
  usedBy: [],
  isNew: false,
  ...over,
})

const MB = 1024 * 1024
const LIMIT = 50 * MB

/* ------------------------------------------------- every reason in words */

test('an unticked notebook says why, in the artboard\'s words', () => {
  const said = (why: PickReason, owner: string | null = null) =>
    notebookReason(book({ picked: false, why, owner }))
  assert.equal(said('student', 'Зуев Аким'), 'тетрадь ученика · Зуев Аким')
  assert.equal(said('student'), 'тетрадь ученика')
  assert.equal(said('roster'), 'похоже на работу ученика')
  assert.equal(said('private'), 'имя начинается с «_»')
  assert.equal(said('answers'), 'похоже на ответы')
  assert.equal(said('empty'), 'пустая')
  // A ticked notebook has nothing to explain.
  assert.equal(notebookReason(book({})), null)
  // An empty notebook cannot be ticked at all; any other can.
  assert.equal(lockedNotebook(book({ picked: false, why: 'empty' })), true)
  assert.equal(lockedNotebook(book({ picked: false, why: 'student' })), false)
  assert.equal(notebookMeta(book({})), '54 ячейки · 40 с результатами')
  assert.equal(notebookMeta(book({ cells: 12, outputs: 0 })), '12 ячеек')
})

test('a file says why it is in or out, and the size limit has two meanings', () => {
  const out = (why: PickReason, over: Partial<FileChoice> = {}) =>
    fileReason(file({ picked: false, why, ...over }), LIMIT)?.text
  assert.equal(out('unused'), 'не упоминается в тетрадях')
  assert.equal(out('generated'), 'похоже на результат запуска')
  assert.equal(out('answers'), 'похоже на ответы')
  assert.equal(out('private'), 'имя начинается с «_»')
  assert.equal(out('image', { kind: 'image' }), 'картинка уже в тексте тетради')
  assert.equal(out('roster'), 'похоже на работу ученика')
  // Over the upload limit: locked, and the limit is named.
  const huge = file({ picked: false, why: 'too-large', bytes: 60 * MB })
  assert.equal(fileReason(huge, LIMIT)?.text, 'больше 50 МБ')
  assert.equal(lockedFile(huge, LIMIT), true)
  // Over the default threshold only: still allowed, and the threshold is named.
  const big = file({ picked: false, why: 'too-large', bytes: 30 * MB })
  assert.equal(fileReason(big, LIMIT)?.text, 'больше 20 МБ')
  assert.equal(lockedFile(big, LIMIT), false)
  // The positive reason: where the file is used.
  const used = fileReason(file({ usedBy: ['seminar.ipynb'] }), LIMIT)
  assert.deepEqual(used, { text: 'используется в seminar.ipynb', positive: true })
  assert.equal(fileReason(file({}), LIMIT), null, 'a ticked file with nothing to say says nothing')
})

test('kinds and sizes read like the artboard: «PDF · 5,1 МБ», «Данные · 460 КБ», «HTML»', () => {
  assert.equal(kindText('pdf', 'lecture.pdf'), 'PDF')
  assert.equal(kindText('data', 'train.csv'), 'Данные')
  assert.equal(kindText('file', 'surface.html'), 'HTML')
  assert.equal(kindText('file', 'Makefile'), 'Файл')
  assert.equal(sizeText(460 * 1024), '460 КБ')
  assert.equal(sizeText(5.1 * MB), '5,1 МБ')
  assert.equal(sizeText(200 * MB), '200 МБ')
  setLocaleResolver(() => 'en')
  assert.equal(kindText('data', 'train.csv'), 'Data')
  assert.equal(sizeText(5.1 * MB), '5.1 MB')
})

test('the screen renders the reasons, and an unticked row keeps its reason beside it', () => {
  const screen = code(read(PUBLISH))
  assert.match(screen, /notebookReason\(book\)/)
  assert.match(screen, /fileReason\(file, fileLimit\)/)
  assert.match(screen, /\{reason\.text\}/)
  assert.match(screen, /disabled=\{lockedNotebook\(book\)\}/, 'an empty notebook cannot be ticked')
  assert.match(screen, /disabled=\{lockedFile\(file, fileLimit\)\}/, 'nor a file over the upload limit')
  assert.match(screen, /\{#if book\.isNew\}/, 'a notebook added since the last publish is marked')
})

/* --------------------------------------------- the check gates the button */

const check = (over: Partial<PublishCheck>): PublishCheck => ({
  id: 'c1',
  kind: 'secret',
  where: '«Семинар», ячейка 14',
  root: 'nb:2',
  cellId: 'cell14',
  path: null,
  sample: 'sk-p…3f',
  ...over,
})

test('only findings in what is ticked are asked about', () => {
  const checks = [
    check({ id: 'key', root: 'nb:2' }),
    check({ id: 'name', kind: 'name', root: 'nb:9', sample: 'Зуев Аким' }),
    check({ id: 'file', kind: 'roomId', root: null, cellId: null, path: 'data/notes.txt', where: 'data/notes.txt' }),
  ]
  const asked = relevantChecks(checks, new Set(['nb:2']), new Set(['data/notes.txt']))
  assert.deepEqual(asked.map((c) => c.id), ['key', 'file'], 'the unticked notebook is not asked about')
  assert.equal(checkText(checks[0]), 'Похоже на ключ API — «Семинар», ячейка 14:')
  assert.equal(checkText(checks[1]), 'Похоже на имя ученика — «Семинар», ячейка 14:')
  assert.equal(checkText(checks[2]), 'Адрес комнаты в файле data/notes.txt — файл публикуется как есть')
})

test('a key or a name in a picked file reads as one, not as the room address', () => {
  const key = check({ id: 'fkey', root: null, cellId: null, path: 'utils.py', where: 'файл utils.py' })
  const name = check({ id: 'fname', kind: 'name', root: null, cellId: null, path: 'data/students.csv', where: 'файл data/students.csv', sample: 'Зуев Аким' })
  assert.equal(checkText(key), 'Похоже на ключ API — файл utils.py:')
  assert.equal(checkText(name), 'Похоже на имя ученика — файл data/students.csv:')
  // Asked about while the file is ticked, and only then.
  assert.deepEqual(relevantChecks([key, name], new Set(), new Set(['utils.py'])).map((c) => c.id), ['fkey'])
})

test('a withdrawn page is never refreshed from the panel, only published again on purpose', () => {
  /*
   * «Обновить страницу» on a withdrawn page made it public again with a
   * notice that said only «Страница обновлена». The row menu hides it; the
   * screen's button says «Опубликовать снова», which is the explicit choice.
   */
  const courses = code(read('web/src/admin/screens/Courses.svelte'))
  const menu = courses.slice(courses.indexOf("{#if item.kind === 'seminar' && hasPage}"))
  assert.match(menu.slice(0, menu.indexOf("tr('admin.course.menu.refresh')")), /\{#if !withdrawn\}/)
  const screen = code(read(PUBLISH))
  assert.match(screen, /already\?\.state === 'withdrawn'\s*\? tr\('admin\.page\.publishAgain'\)/)
  assert.equal(translate('ru', 'admin.page.publishAgain'), 'Опубликовать снова')
  assert.notEqual(translate('en', 'admin.page.publishAgain'), 'admin.page.publishAgain')
})

test('the button waits for something ticked, a page that fits, and every finding confirmed', () => {
  assert.equal(publishBlocked({ picked: 0, limit: 24, unconfirmed: 0 }), 'nothing')
  assert.equal(publishBlocked({ picked: 25, limit: 24, unconfirmed: 0 }), 'too-many')
  assert.equal(publishBlocked({ picked: 3, limit: 24, unconfirmed: 1 }), 'unconfirmed')
  assert.equal(publishBlocked({ picked: 3, limit: 24, unconfirmed: 0 }), null)
})

test('the screen ties «Проверил(а)» to the button', () => {
  const screen = code(read(PUBLISH))
  assert.match(screen, /const unconfirmed = \$derived\(checks\.filter\(\(check\) => !acked\.includes\(check\.id\)\)\)/)
  assert.match(screen, /unconfirmed: unconfirmed\.length/, 'the unconfirmed findings block the build')
  assert.match(screen, /disabled=\{blocked !== null \|\| building\}/, 'the primary button obeys the block')
  assert.match(screen, /onchange=\{\(on\) => confirmChecks\(on\)\}/, 'the box confirms what is on screen')
  assert.match(localized(screen, 'ru'), /Проверил\(а\) — публиковать как есть/)
  // A finding that turned up since the screen was read comes back as a 409 and joins the list.
  assert.match(screen, /refusal\?\.kind === 'unconfirmed'/)
})

test('a 409 is read for what it is: unconfirmed findings, or no saved pick', () => {
  const found = [check({})]
  const unconfirmed = new AdminApiError('unconfirmed', 409, 'invalid', { error: 'unconfirmed', checks: found })
  assert.deepEqual(publishRefusal(unconfirmed), { kind: 'unconfirmed', checks: found })
  const noPick = new AdminApiError('no selection', 409, 'invalid', { error: 'no selection' })
  assert.deepEqual(publishRefusal(noPick), { kind: 'no selection' })
  assert.equal(publishRefusal(new AdminApiError('taken', 409, 'invalid', { error: 'other' })), null)
  assert.equal(publishRefusal(new AdminApiError('x', 400, 'invalid', { error: 'unconfirmed' })), null)
  assert.equal(publishRefusal(new Error('network')), null)
})

/* ------------------------------------------------------ the room door */

test('«Вход в комнату со страницы»: three choices in the rail, members by default', () => {
  const screen = code(read(PUBLISH))
  const rail = screen.slice(screen.indexOf('<aside'), screen.indexOf('</aside>'))
  assert.match(rail, /role="radiogroup" aria-labelledby="room-access"/)
  assert.match(rail, /\{#each ROOM_ACCESS as option, i \(option\)\}/)
  assert.match(rail, /role="radio"\s+aria-checked=\{on\}/)
  assert.match(rail, /tr\('admin\.page\.roomAccess'\)/)
  assert.match(rail, /tr\('admin\.page\.roomAccessHint'\)/)
  // Only for a page whose room still exists: a deleted room leads nowhere anyway.
  const door = rail.slice(rail.indexOf("{#if info?.room.exists}"), rail.indexOf('id="room-access"'))
  assert.ok(door.length > 0, 'the control is no longer under the room check')
  assert.match(screen, /roomAccess = body\.roomAccess \?\? 'members'/)
  // The hint names the cost of «Все» in the teacher's words.
  const ru = translate('ru', 'admin.page.roomAccessHint')
  assert.match(ru, /имена учеников/)
  assert.match(ru, /вопросы оракулу/)
  assert.match(ru, /преподаватели видят вход всегда/)
})

test('the choice saves on its own when there is a pick, and rides with the publish otherwise', () => {
  const screen = code(read(PUBLISH))
  const at = screen.indexOf('async function chooseAccess')
  const choose = screen.slice(at, screen.indexOf('/* ---', at))
  assert.match(choose, /if \(!page \|\| !hasPick\) return/, 'a page with no pick is PATCHed into a 409')
  assert.match(choose, /await adminApi\.setRoomAccess\(page\.id, next\)/)
  assert.match(choose, /roomAccess = was/, 'a refused save still shows what the server did not keep')
  assert.match(choose, /tr\('admin\.page\.roomAccessFailed'\)/)
  assert.doesNotMatch(choose, /adminApi\.publish\(/, 'saving the door rebuilds the page')
  // The publish body carries it, and a publish leaves a pick behind.
  const start = screen.indexOf('async function publish')
  const publish = screen.slice(start, screen.indexOf('const address = $derived'))
  assert.match(publish, /\n\s+roomAccess,\n/)
  assert.match(publish, /hasPick = true/)
})

test('the door setting goes where the server listens: a PATCH of the page', async () => {
  const seen: { url: string; init?: RequestInit }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ roomAccess: 'none' }),
    } as unknown as Response
  }) as typeof fetch
  try {
    assert.deepEqual(await adminApi.setRoomAccess('pub00001', 'none'), { roomAccess: 'none' })
  } finally {
    globalThis.fetch = real
  }
  assert.equal(seen[0].url, '/api/admin/publications/pub00001')
  assert.equal(seen[0].init?.method, 'PATCH')
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { roomAccess: 'none' })
})

test('every word of the door control exists in both languages', () => {
  const keys = [
    'admin.page.roomAccess',
    'admin.page.roomAccess.members',
    'admin.page.roomAccess.anyone',
    'admin.page.roomAccess.none',
    'admin.page.roomAccessHint',
    'admin.page.roomAccessFailed',
    'admin.audit.action.publication.room_access',
    'server.roomDoor.badAccess',
    'server.roomDoor.publishFirst',
    'server.roomDoor.badTokens',
    'server.roomDoor.tooOften',
  ]
  for (const key of keys) {
    assert.notEqual(translate('ru', key), key, key)
    assert.notEqual(translate('en', key), key, key)
  }
  assert.deepEqual(
    ['members', 'anyone', 'none'].map((k) => translate('ru', `admin.page.roomAccess.${k}`)),
    ['Участники', 'Все', 'Никто'],
  )
})

/* ------------------------------------------------------- no step words */

test('no steps, moments or checkpoints on the screen or in its calls', () => {
  const screen = code(read(PUBLISH))
  for (const locale of ['ru', 'en'] as const) {
    const copy = localized(screen, locale)
    assert.doesNotMatch(copy, /шаг|момент|контрольн/i, `${locale}: a step word is back`)
    assert.doesNotMatch(copy, /\bsteps?\b|checkpoint|moment/i, `${locale}: a step word is back`)
  }
  assert.doesNotMatch(screen, /candidates|finalLabel|MAX_STEP_LABEL|skippedStepLine/)
  const api = code(read('web/src/lib/adminApi.ts'))
  assert.doesNotMatch(api, /finalLabel|PublishCandidate|SkippedStep/)
  assert.doesNotMatch(code(read('web/src/admin/panel.ts')), /skippedStepLine|SKIP_REASON_TEXT/)
})

test('the publish calls go where the server listens, with the pick as the body', async () => {
  const seen: { url: string; init?: RequestInit }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ page: { materials: [] }, refused: [] }),
    } as unknown as Response
  }) as typeof fetch
  try {
    await adminApi.publish('room1234', {
      notebooks: [{ root: 'nb:1', name: 'Лекция' }],
      files: [{ path: 'lecture.pdf', name: 'Слайды лекции' }],
      autoRefresh: true,
      ack: ['c1'],
    })
    await adminApi.refreshPage('room1234')
    await adminApi.removeMaterial('pub00001', 'slides')
  } finally {
    globalThis.fetch = real
  }
  assert.equal(seen[0].url, '/api/admin/seminars/room1234/publish')
  assert.equal(seen[0].init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), {
    notebooks: [{ root: 'nb:1', name: 'Лекция' }],
    files: [{ path: 'lecture.pdf', name: 'Слайды лекции' }],
    autoRefresh: true,
    ack: ['c1'],
  })
  assert.equal(seen[1].url, '/api/admin/seminars/room1234/publish/refresh')
  assert.equal(seen[1].init?.method, 'POST')
  assert.equal(seen[2].url, '/api/admin/publications/pub00001/materials/slides')
  assert.equal(seen[2].init?.method, 'DELETE')
})

test('every word the picker shows exists in both languages', () => {
  const keys = [
    ...['notebook', 'pdf', 'data', 'code', 'text', 'image', 'file'].map((k) => `admin.page.kind.${k}`),
    ...['draft', 'live', 'idle', 'finished'].map((k) => `admin.course.status.${k}`),
    'admin.course.page.early',
    'admin.course.page.page',
  ]
  for (const key of keys) {
    assert.notEqual(translate('ru', key), key, key)
    assert.notEqual(translate('en', key), key, key)
  }
})

/* -------------------------------------------- who holds the address name */

const refusal = (body: unknown): AdminApiError =>
  new AdminApiError('Адрес «ml-2025» уже занят.', 409, 'invalid', body)

test('the holder of a former name reaches the panel in full', () => {
  const holder = addressHolderOf(
    refusal({
      error: 'Адрес «ml-2025» уже занят.',
      reason: 'invalid',
      holder: { kind: 'course', id: 'c0000001', name: 'ML 2025', former: true },
    }),
  )
  assert.deepEqual(holder, { kind: 'course', id: 'c0000001', name: 'ML 2025', former: true })
})

test('a live address of another page is told apart from a former one: former travels as is', () => {
  const holder = addressHolderOf(
    refusal({ holder: { kind: 'publication', id: 'p0000009', name: 'Неделя 1', former: false } }),
  )
  // There is nothing to release here, and the panel has to see that from the answer, not guess.
  assert.equal(holder?.former, false)
})

test('server silence about the holder does not invent a holder', () => {
  // While the server names only the fact ("already taken"), the screen behaves
  // as before: it shows the refusal phrase and offers nothing to release.
  assert.equal(addressHolderOf(refusal({ error: 'Адрес «ml-2025» уже занят.' })), null)
  assert.equal(addressHolderOf(refusal(null)), null)
})

test('garbage in the answer does not become a button', () => {
  for (const holder of [
    { kind: 'seminar', id: 'x', name: 'x', former: true },
    { kind: 'course', name: 'без идентификатора', former: true },
    { kind: 'course', id: '', name: 'пустой', former: true },
    'ml-2025',
    42,
  ]) {
    assert.equal(addressHolderOf(refusal({ holder })), null, JSON.stringify(holder))
  }
})

test('a refusal about something else is not about the address: a 404 names no holder', () => {
  const notFound = new AdminApiError('not found', 404, 'invalid', {
    holder: { kind: 'course', id: 'c0000001', name: 'ML 2025', former: true },
  })
  assert.equal(addressHolderOf(notFound), null)
  assert.equal(addressHolderOf(new Error('network')), null)
})

/* -------------------------------------------- releasing a former name */

test('a former name is released at its holder, not at whoever needs it', async () => {
  const seen: { url: string; init?: RequestInit }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return {
      ok: true,
      status: 204,
      headers: new Headers({ 'content-length': '0' }),
      json: async () => ({}),
    } as unknown as Response
  }) as typeof fetch
  try {
    await adminApi.releaseFormerSlug('course', 'c0000001', 'ml-2025')
  } finally {
    globalThis.fetch = real
  }

  assert.equal(seen.length, 1)
  // The id in the address is the holder's: the server releases a name only to its
  // owner (server/src/publish/store.ts · releaseFormerSlug).
  assert.equal(seen[0].url, '/api/admin/slug/course/c0000001/former/ml-2025')
  assert.equal(seen[0].init?.method, 'DELETE')
})
