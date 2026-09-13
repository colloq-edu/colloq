/**
 * Заглушки на экранах преподавателя: что стоит на месте чисел, пока их везут.
 *
 * Раздел «Ресурсы» кормится ответом машины, и до ответа он показывал ПУСТОЕ
 * включённое поле памяти: в него приглашали печатать за миг до того, как
 * приехавшее число сотрёт набранное, а подсказка под ним была пустой строкой.
 * Здесь проверяется ровно то, что откатывается одной строкой и не роняет ни
 * один другой тест: что до ответа на месте полей стоят заглушки, что пустого
 * включённого поля нет ни в одном состоянии, что при отказе сказано словами и
 * что кнопка «Создать занятие» не нажимается, пока форма не знает, что отправит.
 *
 * Читается прямо из компонентов, как в `panels-craft.test.mts` и
 * `screens-craft.test.mts`: тест со своей копией правила проходит вечно, пока
 * файл уезжает.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adminMessages } from '../shared/locales/admin.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const RESOURCES = 'web/src/admin/ui/Resources.svelte'
const NEW_SEMINAR = 'web/src/admin/screens/NewSeminar.svelte'
const SEMINARS = 'web/src/admin/screens/Seminars.svelte'
const SKELETON = 'web/src/components/ui/Skeleton.svelte'

/** Ветка `{#if loading}` целиком — от неё до `{:else}` того же уровня. */
function loadingBranch(source: string): string {
  const start = source.indexOf('{#if loading}')
  assert.notEqual(start, -1, 'ветка ожидания есть')
  const end = source.indexOf('\n  {:else}', start)
  assert.notEqual(end, -1, 'у ветки ожидания есть продолжение')
  return source.slice(start, end)
}

/* ------------------------------------------------------ поля под заглушкой */

test('пока ресурсы едут, на месте полей памяти и ядер стоят заглушки, а не пустые поля', () => {
  const resources = code(read(RESOURCES))
  const waiting = loadingBranch(resources)
  // Два поля — память и ядра, — и оба под заглушкой ростом с настоящее поле.
  const fields = [...waiting.matchAll(/<Skeleton[^/]*height=\{FIELD_H\}/g)]
  assert.equal(fields.length, 2, 'заглушка и у памяти, и у ядер')
  // Ни одного поля ввода в этой ветке: пустое включённое поле — приглашение
  // печатать в то, что через мгновение перепишет ответ сервера.
  assert.doesNotMatch(waiting, /<input/, 'до ответа полей ввода нет вовсе')
  // Полоски и подсказки — тоже, иначе раздел прыгнет, когда числа приедут.
  assert.match(waiting, /hintLines\(/, 'подсказки заняли свои строки')
  assert.match(waiting, /height="4px"/, 'полоска занятой памяти на месте')
})

test('размеры заглушек берутся из одних чисел, а не пишутся в каждой по месту', () => {
  const resources = read(RESOURCES)
  // Одно число на все поля и одно на все строки подсказок: разъехаться они
  // могут только вместе, и тогда прыжок видно глазом.
  assert.match(resources, /const FIELD_H = '38px'/, 'высота поля — одним числом')
  assert.match(resources, /const HINT_LINE = 18\b/, 'высота строки подсказки — одним числом')
  const waiting = loadingBranch(code(resources))
  // И поля берут высоту оттуда, а не переписывают число себе: пара «38px» в
  // разметке и «38px» в константе расходится на первой же правке кегля.
  assert.doesNotMatch(waiting, /height="38px"/, 'поле не носит свою копию высоты')
  assert.doesNotMatch(waiting, /height="18px"/, 'строка подсказки — тоже')
})

test('раздел ждёт ответа только когда ответ в пути, а не когда его уже не будет', () => {
  const resources = code(read(RESOURCES))
  // `null` значил и «ещё не знаем», и «спросили и не узнали». Разделяет их флаг.
  assert.match(resources, /loading\?: boolean/, 'ожидание — отдельное свойство')
  assert.match(resources, /const unreadable = \$derived\(!resources && !loading\)/, 'отказ — это не ожидание')
})

/* ------------------------------------------------------------ отказ машины */

test('машина не ответила — поля остаются, и сказано об этом словами', () => {
  const resources = code(read(RESOURCES))
  assert.match(resources, /admin\.resources\.unreadable/, 'строка отказа стоит под полями')
  // Поле не остаётся немой пустой рамкой: подсказка внутри говорит, что
  // комната получит умолчание.
  const placeholders = [...resources.matchAll(/placeholder=\{unreadable \? tr\('admin\.resources\.asDefault'\)/g)]
  assert.equal(placeholders.length, 2, 'подсказка внутри обоих полей')
  for (const key of ['admin.resources.unreadable', 'admin.resources.asDefault', 'admin.resources.reading']) {
    const pair = adminMessages[key]
    assert.ok(pair && pair.ru && pair.en, `${key} переведена на оба языка`)
  }
})

/* ------------------------------------------------------ бегущая полоса */

test('под «поменьше движения» заглушка перестаёт бежать, а не исчезает', () => {
  const skeleton = read(SKELETON)
  const reduced = skeleton.slice(skeleton.indexOf('prefers-reduced-motion'))
  assert.match(reduced, /animation:\s*none/, 'блик стоит на месте')
  // Сам блок остаётся: он держит размер, и без него раздел схлопнется.
  assert.match(reduced, /\.skeleton::after/, 'гасится блик, а не заглушка')
  // Блик едет трансформацией: он идёт на КАЖДОМ кадре ожидания, и двигать им
  // `left` или `background-position` значит раскладывать страницу заново всё
  // то время, пока она и без того занята ответом сервера.
  const running = skeleton.slice(0, skeleton.indexOf('prefers-reduced-motion'))
  assert.match(running, /transform:\s*translateX\(-100%\)/, 'блик стоит слева трансформацией')
  assert.match(running, /@keyframes shimmer\s*\{\s*to\s*\{\s*transform:\s*translateX\(100%\)/, 'и ею же уезжает')
})

/* -------------------------------------------------------- кнопка и чтения */

test('«Создать занятие» не нажимается, пока форма не знает, что отправит', () => {
  const form = code(read(NEW_SEMINAR))
  assert.match(
    form,
    /const settling = \$derived\(environmentsLoading \|\| oracleLoading \|\| resourcesLoading\)/,
    'ждут все три чтения — окружения, потолок оракула, ресурсы',
  )
  assert.match(form, /!busy &&\s*\n\s*!settling &&/, 'кнопка ждёт вместе с ними')
  // Флаг гаснет и на успехе, и на отказе: ждать второго ответа от того, кто
  // уже сказал «нет», нечего — иначе кнопка не оживёт никогда.
  const finallies = [...form.matchAll(/\.finally\(\(\) => \((?:environments|oracle|resources)Loading = false\)\)/g)]
  assert.equal(finallies.length, 3, 'каждое чтение гасит свой флаг')
})

test('список окружений тоже ждёт под заглушкой, а не пустой строкой', () => {
  const form = code(read(NEW_SEMINAR))
  const start = form.indexOf('{#if environmentsLoading}')
  assert.notEqual(start, -1, 'у списка есть состояние ожидания')
  const waiting = form.slice(start, form.indexOf('{:else if environments'))
  assert.match(waiting, /<Skeleton/, 'карточка окружения нарисована заглушкой')
  assert.match(waiting, /h-\[45px\]/, 'строка имени занимает свою высоту')
})

test('окно настроек занятия ждёт ответа тем же способом, что и форма', () => {
  const list = code(read(SEMINARS))
  assert.match(list, /loading=\{resourcesLoading\}/, 'тот же раздел получает тот же флаг')
  // Перечитывание после сохранения идёт под уже нарисованными числами:
  // мигать разделом на каждое изменение памяти нечем.
  assert.match(list, /resourcesLoading = resources === null/, 'заглушки только на первом чтении')
  assert.match(list, /\.finally\(\(\) => \(resourcesLoading = false\)\)/, 'отказ снимает ожидание')
})
