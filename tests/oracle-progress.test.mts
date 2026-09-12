/**
 * Поручение, которое идёт, и поручение, которое повисло, — это две разные
 * картинки, а не одна.
 *
 * Ход «сделать» шёл тринадцать минут, и всё это время панель показывала
 * неподвижную вертушку и «готовит следующий шаг»: ни номера шага, ни цифры, ни
 * способа отличить работу от зависшего запроса к модели. Здесь проверяется
 * ровно то, из чего эта разница складывается: время у каждой строки ленты,
 * растущая цифра под ней, слова про затянувшееся молчание и выжимка запуска,
 * которая раньше была недостижима по разметке.
 *
 * Читается прямо из компонентов, как в `panels-craft.test.mts`: тест со своей
 * копией правила проходит вечно, пока файл уезжает.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'svelte/compiler'
import ts from 'typescript'
import { runInNewContext } from 'node:vm'
import { setLocaleResolver, translate, tr } from '../shared/i18n.js'
import { roomMessages } from '../shared/locales/room.js'
import { activityMessages } from '../shared/locales/activity.js'
import { ACTIVITY_KIND_LEVEL } from '../shared/activity.js'
import { spell } from '../web/src/lib/utils.js'

afterEach(() => setLocaleResolver(() => 'ru'))

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const TURN = 'web/src/components/panels/ChatTurn.svelte'
const HISTORY = 'web/src/components/panels/ActivityHistory.svelte'
const NOTEBOOK = 'shared/notebook.ts'

/* --------------------------------------------------------------- словарь */

test('строки секундомера есть на обоих языках и обе несут подстановки', () => {
  for (const key of ['room.oracle.stepAt', 'room.oracle.progress', 'room.oracle.stalled']) {
    const pair = roomMessages[key]
    assert.ok(pair, `${key}: нет в словаре комнаты`)
    for (const locale of ['ru', 'en'] as const) {
      const text = pair[locale]
      assert.equal(typeof text, 'string', `${key}/${locale}`)
      assert.match(text as string, /\{p0\}/, `${key}/${locale}: потеряна подстановка`)
    }
    // Английский — без кириллицы: то же правило, что и у остального словаря.
    assert.doesNotMatch(pair.en as string, /[А-Яа-яЁё]/, key)
  }
  // Живая строка называет и номер шага, и сколько уже ждут: одного мало.
  for (const key of ['room.oracle.progress', 'room.oracle.stalled']) {
    for (const locale of ['ru', 'en'] as const) {
      assert.match(roomMessages[key][locale] as string, /\{p1\}/, `${key}/${locale}`)
    }
  }
})

test('живая строка и молчание модели читаются словами, а не ключами', () => {
  assert.equal(translate('ru', 'room.oracle.progress', { p0: 7, p1: '1 мин 40 с' }), 'шаг 7 · 1 мин 40 с')
  assert.equal(translate('en', 'room.oracle.progress', { p0: 7, p1: '1m 40s' }), 'step 7 · 1m 40s')
  assert.match(translate('ru', 'room.oracle.stalled', { p0: 7, p1: '2 мин' }), /ждём ответа модели уже 2 мин/)
  assert.match(translate('en', 'room.oracle.stalled', { p0: 7, p1: '2m' }), /waiting for the model for 2m/)
})

/* ------------------------------------------------------------ время шага */

/** Живьём: `stepAt` и `since` из самого компонента, а не их копия здесь. */
function relativeTimeOf(createdAt: number): (step: unknown) => string {
  const source = read(TURN)
  const ast = parse(source, { modern: true })
  const body = (ast.instance!.content as { body: unknown[] }).body as any[]
  const pick = (name: string): string => {
    const node = body.find((n: any) => n.type === 'FunctionDeclaration' && n.id?.name === name)
    assert.ok(node, `не нашли функцию ${name} в компоненте`)
    return source.slice(node.start!, node.end!)
  }
  const js = ts.transpileModule(`${pick('stepAt')}\n${pick('since')}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return runInNewContext(`${js}; since`, { tr, spell, entry: { createdAt } }) as (
    step: unknown,
  ) => string
}

test('у строки шага своё время — от начала хода, и по нему видно, где он встал', () => {
  const start = 1_700_000_000_000
  const since = relativeTimeOf(start)
  setLocaleResolver(() => 'ru')
  assert.equal(since({ kind: 'read', at: start + 12_000 }), '+12 с')
  assert.equal(since({ kind: 'run', at: start + 130_000 }), '+2 мин 10 с')
  // Одиннадцать минут между шагами — то самое, ради чего столбец и заведён.
  assert.equal(since({ kind: 'run', at: start + 790_000 }), '+13 мин 10 с')
  setLocaleResolver(() => 'en')
  assert.equal(since({ kind: 'read', at: start + 12_000 }), '+12s')
  assert.equal(since({ kind: 'run', at: start + 130_000 }), '+2m 10s')
})

test('шаг без времени не показывает ничего — «+0 с» тоже', () => {
  const start = 1_700_000_000_000
  const since = relativeTimeOf(start)
  // Ходы, записанные до появления поля: время им взять неоткуда.
  assert.equal(since({ kind: 'read', target: 'train.py' }), '')
  assert.equal(since({ kind: 'read', at: null }), '')
  assert.equal(since({ kind: 'read', at: Number.NaN }), '')
  // Первые шаги идут подряд: «+0 с» стоял бы у каждого и не значил бы ничего.
  assert.equal(since({ kind: 'read', at: start }), '')
  assert.equal(since({ kind: 'read', at: start + 400 }), '')
  assert.equal(since({ kind: 'read', at: start + 1_000 }), '+1 с')
})

/* --------------------------------------------------------- лента и низ её */

test('выжимка запуска показывается: у неё была недостижимая ветка', () => {
  const turn = code(read(TURN))
  /*
   * Ветка `{:else if step.note}` стоит после `{:else if step.kind === 'run'}`,
   * то есть для запуска не выполнялась никогда: «не уложился в 90 с» и хвост
   * вывода — единственное, что объясняет код 124, — не показывались ни разу.
   */
  assert.match(turn, /step\.kind === 'run' && step\.note/, 'у запуска есть своя ветка выжимки')
  const at = turn.indexOf("step.kind === 'run' && step.note")
  const block = turn.slice(at, at + 400)
  assert.match(block, /\{step\.note\}/, 'и она печатает саму выжимку')
  assert.match(block, /text-muted/, 'тем же приглушённым, что и прочие выжимки')
  // Хвост вывода бывает длинным: он прокручивается внутри себя, а не растит ход.
  assert.match(block, /max-h-\d+ overflow-y-auto/, 'длинный хвост не растит ход')
})

test('низ ленты — это номер шага и растущая цифра, а не одна вертушка', () => {
  const turn = code(read(TURN))
  assert.doesNotMatch(turn, /room\.ui\.550/, '«готовит следующий шаг» больше ничего не сообщает')
  assert.match(turn, /room\.oracle\.progress/, 'номер шага и сколько уже')
  assert.match(turn, /room\.oracle\.stalled/, 'и слова про затянувшееся молчание')
  assert.match(turn, /animate-spin/, 'вертушка остаётся: она про «идёт», цифра — про «сколько»')
})

test('часы тикают раз в секунду и снимаются, когда ход закончился', () => {
  const turn = read(TURN)
  assert.match(turn, /setInterval\(\(\) => \(now = Date\.now\(\)\), 1000\)/, 'раз в секунду')
  assert.match(turn, /return \(\) => clearInterval\(timer\)/, 'таймер снимается за собой')
  // Производное само гасит эффект: у законченного хода часов нет.
  assert.match(turn, /if \(!working\) return/, 'часы идут только у живого поручения')
  assert.match(
    turn,
    /const working = \$derived\(streaming && !pending && entry\.mode === 'agent'\)/,
    'строка-обещание из ask-outbox секундомером не обзаводится',
  )
})

test('порог молчания — две минуты, и он записан числом, а не наугад', () => {
  const turn = read(TURN)
  const threshold = /const STALLED_MS = ([\d_]+)/.exec(turn)
  assert.ok(threshold, 'порог молчания объявлен')
  assert.equal(Number(threshold![1].replaceAll('_', '')), 120_000)
  assert.match(turn, /const stalled = \$derived\(waited >= STALLED_MS\)/)
})

test('«Стоп» стоит рядом со счётчиком и остаётся одной кнопкой', () => {
  const turn = code(read(TURN))
  // Две копии кнопки разъехались бы на первой правке прав: она одна.
  assert.equal((turn.match(/onclick=\{onstop\}/g) ?? []).length, 1, '«Стоп» описан один раз')
  assert.match(turn, /\{#snippet stopButton\(/, 'и вынесен в сниппет')
  const footer = turn.slice(turn.indexOf('room.oracle.progress'))
  assert.match(
    footer.slice(0, 400),
    /\{@render stopButton\(/,
    'в живой строке «Стоп» стоит рядом с цифрой',
  )
  // Под вопросом кнопка остаётся там же, где была.
  assert.match(turn, /\{#if streaming && !working\}[\s\S]{0,200}\{@render stopButton\('self-start'\)\}/)
})

test('лента знает все виды шага и не молчит про незнакомый', () => {
  const kinds = /export type StepKind =([^\n]+)/.exec(read(NOTEBOOK))
  assert.ok(kinds, 'перечень видов шага на месте')
  const names = [...kinds![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(names.includes('new'), 'create_notebook пишет шаг «завёл»')
  const turn = read(TURN)
  for (const kind of names) {
    assert.match(turn, new RegExp(`get ${kind}\\(\\)`), `${kind}: нет слова в ленте`)
    assert.match(turn, new RegExp(`^\\s+${kind}: '`, 'm'), `${kind}: нет значка в ленте`)
  }
  // Вид, которого вкладка ещё не знает, рисуется словом из документа: сервер и
  // браузер обновляются порознь, и молчащая строка врёт сильнее голого слова.
  assert.match(turn, /VERB\[step\.kind\] \?\? step\.kind/)
  assert.match(turn, /STEP_ICON\[step\.kind\] \?\? 'info'/)
})

/* ------------------------------------------------------------- история */

test('шаг работы оракула назван на обоих языках и попадает в «Подробное»', () => {
  const pair = activityMessages['activity.oracle.work_step']
  assert.ok(pair, 'у нового вида события есть подпись')
  assert.ok(pair.ru && pair.en, 'обе подписи')
  assert.doesNotMatch(pair.en as string, /[А-Яа-яЁё]/)
  assert.notEqual(pair.ru, pair.en)
  assert.equal((ACTIVITY_KIND_LEVEL as Record<string, string>)['oracle.work_step'], 'detailed')
  // Отбор по разделу читает приставку вида: «oracle.» — это Оракул.
  assert.match('oracle.work_step', /^oracle\./)
  assert.ok(activityMessages['activity.tool'], 'подпись для имени инструмента')
  assert.doesNotMatch(activityMessages['activity.tool'].en as string, /[А-Яа-яЁё]/)
})

test('строка истории называет инструмент и итог, и только у шага работы', () => {
  const history = code(read(HISTORY))
  assert.match(history, /const WORK_STEP = 'oracle\.work_step'/)
  /*
   * `subjectId` — поле общее: у разбора там владелец черновика, и печатать его
   * во всех строках значило бы показывать чужой идентификатор вместо имени.
   */
  assert.match(history, /event\.kind === WORK_STEP \? \(event\.details\.subjectId \?\? ''\) : ''/)
  const row = history.slice(history.indexOf('{#if tool ||'), history.indexOf('</small>'))
  assert.match(row, /\{#if tool\}<code>\{tool\}<\/code>\{\/if\}/, 'имя инструмента в строке')
  assert.match(row, /activity\.outcome\.\$\{event\.details\.outcome\}/, 'и итог рядом с ним')
  assert.match(
    history,
    /detail\.kind === WORK_STEP && detail\.details\.subjectId[\s\S]{0,120}activity\.tool/,
    'в подробностях инструмент назван отдельной строкой',
  )
})

/* --------------------------------------------------------- без русского */

test('ни ленты, ни истории — ни одной русской строки прямо в разметке', () => {
  for (const file of [TURN, HISTORY]) {
    const ast = parse(read(file), { modern: true })
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object' || node.type === 'Comment') return
      if (node.type === 'Text') assert.doesNotMatch(node.data, /[А-Яа-яЁё]/, `${file}: ${node.data}`)
      for (const [key, value] of Object.entries(node)) {
        if (['css', 'instance', 'module', 'comments', 'loc'].includes(key)) continue
        if (Array.isArray(value)) value.forEach(walk)
        else if (value && typeof value === 'object') walk(value)
      }
    }
    walk(ast.fragment)
  }
})
