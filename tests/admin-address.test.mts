/**
 * Панель: прежний адрес, палец и один язык на одну поверхность.
 *
 * Три места, где панель обещала больше, чем показывала.
 *
 * Первое — прежнее имя в адресе. Сервер научился называть держателя и отдавать
 * его прежние имена (server/src/routes/courses.ts · former, addressHolder), а
 * отпускать их всё равно было негде: курс «ML 2025», переименованный в
 * «ml-2025-fall», держит «ml-2025» за собой навсегда, и увидеть, что держит его
 * именно этот курс, владелец не мог — строки с таким адресом в списке нет.
 * Проверяется, что список есть на обоих экранах, что цена названа РЯДОМ с
 * кнопкой, а не только в вопросе после неё, и что необратимое идёт вторым шагом.
 *
 * Второе — значок «скопировать» у адреса семинара. `hoverOnlyWhenSupported`
 * (tailwind.config.js) правильно убрал залипающий hover с сенсорных экранов, но
 * этот значок был у строки ЕДИНСТВЕННОЙ подсказкой, что она нажимается, — и на
 * iPad перестал появляться вовсе.
 *
 * Третье — язык. Панель двуязычна по экранам осознанно (решение записано в
 * components/RoomRulesRows.svelte), и дефект был не в этом, а в ОДНОЙ
 * поверхности на двух языках: меню строки семинара. Здесь закреплено и то, и
 * другое: меню без русского, окно правил — русское целиком.
 *
 * Читается прямо из компонентов, как в `panels-craft.test.mts` и
 * `panels-touch.test.mts`: тест со своей копией правила проходит вечно, пока
 * файл уезжает.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** Переносы строк — дело форматирования, а не смысла. */
const flat = (source: string): string => source.replace(/\s+/g, ' ')

const COURSES = 'web/src/admin/screens/Courses.svelte'
const PUBLISH = 'web/src/admin/screens/Publish.svelte'
const SEMINARS = 'web/src/admin/screens/Seminars.svelte'
const ENVIRONMENTS = 'web/src/admin/screens/Environments.svelte'

/* --------------------------------------------------- прежние имена в адресе */

test('прежние имена курса видно там, где их и меняли', () => {
  const courses = code(read(COURSES))
  // Список — с сервера, а не собранный экраном из своих же переименований:
  // адрес освобождают в сентябре следующего года, из другой вкладки и другими
  // руками (server/src/routes/courses.ts:128,153 · former).
  assert.match(courses, /const former = \$derived\(course\?\.former \?\? \[\]\)/)
  assert.match(courses, /\{#each former as name \(name\)\}/)
  assert.match(courses, /\/c\/\{name\}/, 'имя показано адресом, а не голой строкой')
})

test('цена отпускания названа у самой кнопки, а не только в вопросе', () => {
  const courses = flat(code(read(COURSES)))
  const list = courses.slice(courses.indexOf('Прежние адреса'), courses.indexOf('{#each former'))
  assert.ok(list.length > 0, 'блок прежних адресов не нашёлся')
  // Ссылка, записанная в чате прошлогодней группы, после этого отвечает 404 —
  // и об этом читают ДО нажатия, а не в окне поверх него.
  assert.match(list, /перестаёт вести куда-либо/)
  assert.match(list, /освобождается/, 'а зачем это делают — тоже сказано')
})

test('отпускают вторым шагом: кнопка задаёт вопрос, а не выполняет', () => {
  const courses = code(read(COURSES))
  // Нажатие в списке только спрашивает; сам запрос уходит из окна.
  assert.match(courses, /onclick=\{\(\) => \(dropping = name\)\}/)
  const asked = courses.indexOf('id="drop-slug-title"')
  assert.ok(asked > 0, 'окна с вопросом нет вовсе')
  assert.ok(
    courses.indexOf('void dropFormer()') > asked,
    'необратимое зовётся мимо вопроса — вторым шагом это не назвать',
  )
  // И вопрос называет тот самый адрес, а не «связанные данные».
  assert.match(flat(courses), /Отпустить адрес \/c\/\{going\}\?/)
})

test('отпускает владелец и своё: маршрут зовут с идентификатором курса', () => {
  const courses = code(read(COURSES))
  assert.match(courses, /adminApi\.releaseFormerSlug\('course', open\.id, name\)/)
  // Список пересчитывает сервер: своя копия ответа разошлась бы с ним на
  // первом же отказе (server/src/publish/store.ts · releaseFormerSlug → 404).
  assert.match(
    code(read(COURSES)).slice(courses.indexOf('async function dropFormer')),
    /await loadOne\(open\.id\)/,
  )
})

test('страница знает свои прежние имена ещё до того, как её переиздали', () => {
  const publish = code(read(PUBLISH))
  // Раньше список наполняли только переименования В ЭТОЙ ВКЛАДКЕ: экран,
  // открытый год спустя, показывал пустоту, и отпускать в нём было нечего.
  assert.match(publish, /former = already\?\.former \?\? \[\]/)
  assert.match(publish, /\{#snippet formerNames\(\)\}/, 'список нужен в двух местах экрана')
  const renders = publish.match(/\{@render formerNames\(\)\}/g) ?? []
  assert.equal(renders.length, 2, 'только что опубликованная страница — и опубликованная раньше')
})

test('у публикации отпускают то же и так же', () => {
  const publish = code(read(PUBLISH))
  const flatPublish = flat(publish)
  const list = flatPublish.slice(
    flatPublish.indexOf('Прежние адреса'),
    flatPublish.indexOf('{#each former'),
  )
  assert.match(list, /перестаёт открываться/, 'цена названа у кнопки')
  assert.match(publish, /adminApi\.releaseFormerSlug\('publication', page, name\)/)
  // Идентификатор — страницы, а не сегодняшнего нажатия «Опубликовать»:
  // прежние имена принадлежат ей и тогда, когда её публиковали в прошлом году.
  assert.match(publish, /const pageId = \$derived\(done \?\? already\?\.id \?\? null\)/)
  assert.ok(
    publish.indexOf('void dropFormer()') > publish.indexOf('id="drop-slug-title"'),
    'необратимое зовётся мимо вопроса',
  )
})

/* ------------------------------------------------------------------- палец */

test('значок «скопировать» у адреса семинара виден и без наведения', () => {
  const seminars = code(read(SEMINARS))
  // Именно та кнопка, что несёт адрес в строке списка: `data-copy` — её метка,
  // по ней же кнопку находит и сама страница, отвечая на ⌘C.
  const row = seminars.slice(seminars.indexOf('data-copy={seminar.id}'))
  const icon = row.slice(row.indexOf('<Icon'))
  const shown = flat(icon.slice(0, icon.indexOf('/>')))
  assert.match(shown, /group-hover:opacity-100/, 'указателю — по наведению')
  assert.match(shown, /group-focus-within:opacity-100/, 'клавиатуре — по фокусу в строке')
  // Там, где наведения не бывает вовсе (iPad, с которого панель и открывают),
  // подсказка о том, что строка нажимается, обязана стоять всегда: hover-утилиты
  // туда больше не доезжают (tailwind.config.js · hoverOnlyWhenSupported).
  assert.match(shown, /\[@media\(hover:none\)\]:opacity-100/)
})

/* -------------------------------------------------- один язык на поверхность */

test('меню строки семинара — на одном языке', () => {
  const seminars = code(read(SEMINARS))
  const opened = seminars.indexOf('role="menu"')
  const menu = seminars.slice(opened, seminars.indexOf('</tr>', opened))
  assert.ok(menu.includes('Copy link') && menu.includes('Delete…'), 'меню не нашлось')
  // «Copy link / Rename / Rules…» рядом с «Закончить занятие» и «Снять
  // страницу» — одно меню на двух языках, и читается оно как две разные панели.
  assert.doesNotMatch(menu, /[А-Яа-яЁё]/)
})

test('окно правил остаётся русским целиком — и сказано, почему', () => {
  const seminars = code(read(SEMINARS))
  const dialog = seminars.slice(seminars.indexOf('aria-labelledby="seminar-rules-title"'))
  const window_ = dialog.slice(0, dialog.indexOf('{#if doomed}'))
  assert.ok(window_.includes('RoomRulesRows'), 'окно правил не нашлось')
  // Подписи правил живут в языке КОМНАТЫ: тот же компонент — пульт правил
  // внутри неё. Перевод рамки вокруг русских строк сделал бы двуязычным само
  // окно — ровно тот дефект, который чинили в меню.
  assert.match(window_, /[А-Яа-яЁё]/, 'окно перевели по частям — теперь двуязычно оно')
  assert.match(
    read(SEMINARS),
    /RoomRulesRows\.svelte/,
    'решение о языке записано один раз, и отсюда на него есть ссылка',
  )
})

test('на экране окружений не осталось русского абзаца посреди английского', () => {
  // Абзац про срезы видеокарты печатался по-русски на экране, где всё
  // остальное — от «Needs rebuild» до «Make default» — по-английски.
  assert.doesNotMatch(code(read(ENVIRONMENTS)), /[А-Яа-яЁё]/)
})
