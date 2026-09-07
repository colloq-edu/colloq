/**
 * Мелочи экранов входа и комнаты, у которых нет ни функции, ни сокета.
 *
 * Всё здесь — про разметку: отклик плитки под пальцем, список свойств у
 * перехода, признак обрезки, доехавший до вкладок, окно отказа со ВСЕМ
 * потерянным текстом и указатель на опубликованную версию у закончившегося
 * занятия. Каждое из этих решений откатывается одной строкой и не роняет ни
 * один тест — ровно так все они и появились в аудите.
 *
 * Читается прямо из компонентов, как в `panels-craft.test.mts`: тест со своей
 * копией правила проходит вечно, пока файл уезжает.
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
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const SESSION = 'web/src/screens/SessionScreen.svelte'
const JOIN = 'web/src/screens/JoinScreen.svelte'
const PICKER = 'web/src/components/join/MarkPicker.svelte'
const FILEBAR = 'web/src/components/editor/FileBar.svelte'

/* -------------------------------------------------------------- нажатие */

test('плитки марок отвечают пальцу, а свободны они или нет — решает ростер', () => {
  const picker = code(read(PICKER))
  const grid = picker.slice(picker.indexOf('role="radiogroup"'))
  // Сорок плиток — самое нажимаемое место экрана входа, и рамка с кольцом
  // приезжают из `value`, то есть кругом через сервер. `press` — единственное,
  // что отвечает на самом нажатии (index.css · .press).
  assert.match(grid, /\bpress\b/, 'плитка носит домашний press')
  assert.match(grid, /held \? '' : 'press'/, 'занятая марка не обещает того, чего не сделает')
  // Никаких утилит `transition-*` рядом: они переписали бы transition-property
  // и оставили transform за списком.
  assert.doesNotMatch(grid, /transition-/, 'помощнику ничто не мешает')
})

test('кнопки полос под вкладкой переводят только то, что у них движется', () => {
  // Шорткат `transition` переводит ВСЕ свойства — включая border-color и
  // box-shadow фокусного кольца, которое обязано появляться на кадре нажатия
  // клавиши. Позиционный список — как у .btn (index.css). Обе кнопки — близнецы
  // (одна полоса под вкладкой, одна высота, один грунт), и разъехаться им негде.
  const session = code(read(SESSION))
  assert.doesNotMatch(session, /\btransition duration-/, 'голого шортката не осталось')
  const board = session.slice(session.indexOf('showToRoom(activePath)') - 900)
  const run = code(read(FILEBAR))
  for (const [name, source] of [
    ['«На общий экран»', board],
    ['«Запустить»', run],
  ] as const) {
    assert.match(source, /transition-\[filter,transform\]/, `${name}: список свойств — руками`)
    assert.match(source, /duration-press ease-out/, `${name}: скорость и кривая из лестницы`)
    assert.match(source, /enabled:active:scale-\[0\.97\]/, `${name}: и есть чему двигаться`)
  }
  assert.doesNotMatch(run, /\btransition duration-/, '«Запустить» — тоже без шортката')
})

/* ------------------------------------------------------- обрезанный список */

test('вкладки полются по полному списку файлов, а не по обрезанному', () => {
  const session = code(read(SESSION))
  // MAX_ENTRIES=2000 (server/src/workspace.ts): распакованный студентом датасет
  // выталкивает из списка чужую тетрадь, и без этого признака `Tabs` закрывал
  // бы вкладки всей комнате. Поле необязательное — молчание здесь означало бы
  // «список полный», то есть прежнее поведение.
  assert.match(session, /tabs\.settle\(\{[^}]*\btruncated\b/, 'признак обрезки доезжает до Tabs')
  assert.match(session, /session\.filesTruncated/, 'и берётся у состояния комнаты')
})

/* ------------------------------------------------------------ окно отказа */

test('окно отказа показывает всё потерянное, а не ячейку под курсором', () => {
  const session = code(read(SESSION))
  // Гейт отказывает кадру целиком, а кадр после обрыва — это все офлайн-правки
  // сразу (lib/refusal.ts). Пока здесь стояла одна ячейка, остальные уходили
  // вместе с кэшем молча.
  assert.match(session, /stillLost\(/, 'сверка с серверной копией')
  assert.match(session, /refusalHasText\(/, 'и одно правило на «есть ли что показывать»')
  assert.match(session, /\{#each refusedCells as cell/, 'рисуется список, а не строка')
  assert.doesNotMatch(session, /\{#if refusal\.text\}/, 'одной ячейки в разметке не осталось')
})

test('потери считаются только после того, как сервер отдал свою копию', () => {
  const session = code(read(SESSION))
  // До синхронизации документ пуст, а пустота значит «ещё не читали»: посчитать
  // раньше — объявить потерянной всю тетрадь.
  assert.match(session, /provider\.on\('sync', settle\)/, 'ждём sync провайдера')
  assert.match(session, /provider\.off\('sync', settle\)/, 'и отписываемся')
  assert.match(session, /lostCells !== null/, 'считается ровно один раз')
})

/* ------------------------------------------------- закончившееся занятие */

test('закончившееся занятие показывает дорогу к опубликованной версии', () => {
  const join = code(read(JOIN))
  // Ссылка в чате ведёт в комнату, и это единственный адрес, который у студента
  // есть: без строки он через неделю входит один в живую тетрадь (shared/protocol.ts
  // · SessionInfo.published). Поле завели ровно ради этого экрана.
  assert.match(join, /session\.published/, 'поле читается')
  assert.match(
    join,
    /href="\/p\/\{publicationAddress\(session\.published\)\}"/,
    'адрес — по имени страницы, а не собран руками',
  )
  assert.match(join, /plural\(session\.published\.steps/, 'шаги названы по-русски')
  assert.match(join, /href="\/c\/\{session\.course\.id\}"/, 'и курс рядом, когда он есть')
})

test('указатель на публикацию стоит внутри «занятие закончено», а не сам по себе', () => {
  const join = code(read(JOIN))
  // Идущее занятие с прошлой публикацией — обычное дело (страницу собирают
  // между парами), и уводить с него в чтение незачем.
  const finished = join.indexOf('{#if finishedStamp}')
  assert.ok(finished > 0, 'блок про конец занятия на месте')
  const published = join.indexOf('{#if session.published}')
  assert.ok(published > finished, 'указатель — внутри него')
})
