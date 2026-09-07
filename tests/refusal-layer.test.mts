/**
 * Окно «эту правку не приняли» — на каких поверхностях оно есть и над чем лежит.
 *
 * Отказ гейта лечится перезагрузкой, а перезагрузка возвращает вкладку туда же,
 * откуда ушла: с `/s/:id/pult` — снова на пульт. Пока окно лежало на z-[60], оно
 * рисовалось под непрозрачной обёрткой пульта (z-[95]) и под проекцией (z-[90]),
 * то есть преподаватель на планшете получал обратно свой лист и ни слова о том,
 * что правку не приняли и что именно из набранного не доехало. Второй копии
 * этого окна в продукте нет и быть не должно: окно — не объявление, а
 * единственная копия потерянного текста.
 *
 * Ярус у него свой, между пультом и терминальными плашками: выше пульта, но ниже
 * «удалён» / «вас удалили» / «разошлись» (z-[100]) — над плашкой удалённой
 * комнаты окно предлагало бы скопировать текст туда, куда его уже некуда
 * вернуть. Палитра идёт следом: из неё открывают панели, и лежать под окном она
 * не может.
 *
 * На проекции окна нет вовсе: печатать там нечем, а чужая тетрадь во весь экран
 * посреди пары — худшее, что можно нарисовать на балке. Тем же проходом закрыт
 * и пульт правил: открытым он переживал уход на балку и лежал под ней —
 * нарисованный, кликабельный и невидимый.
 *
 * Читается прямо из компонентов, как в `pult-one-voice.test.mts`: тест со своей
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

const SESSION = code(read('web/src/screens/SessionScreen.svelte'))
const PALETTE = code(read('web/src/components/ui/CommandPalette.svelte'))

/** Ярус слоя: первое `z-[NN]` после его ветки. */
function layer(source: string, from: string): number {
  const at = source.indexOf(from)
  assert.notEqual(at, -1, `не нашли «${from}»`)
  const found = /z-\[(\d+)\]/.exec(source.slice(at, at + 1200))
  assert.ok(found, `у «${from}» не стало яруса`)
  return Number(found[1])
}

const REFUSAL = '{#if refusal && refusalShown && !projection}'

test('окно отказа лежит выше пульта и проекции', () => {
  const refusal = layer(SESSION, REFUSAL)
  for (const [what, under] of [
    ['проекции', layer(SESSION, '{#if projection}')],
    ['пульта', layer(SESSION, '{:else if pult}')],
  ] as const) {
    assert.ok(
      refusal > under,
      `окно отказа (z-${refusal}) снова под обёрткой ${what} (z-${under}) — нарисовано и невидимо`,
    )
  }
})

test('и ниже терминальных плашек: там копировать уже некуда', () => {
  const refusal = layer(SESSION, REFUSAL)
  for (const [what, over] of [
    ['«удалён»', layer(SESSION, '{#if session.gone && !pult}')],
    ['«вас удалили»', layer(SESSION, '{#if session.banned !== null}')],
    ['«разошлись»', layer(SESSION, '{#if session.stuck && !session.gone && !pult}')],
  ] as const) {
    assert.ok(
      refusal < over,
      `окно отказа (z-${refusal}) перекрыло плашку ${what} (z-${over})`,
    )
  }
})

test('палитра осталась над окном отказа: из неё открывают панели', () => {
  const palette = layer(PALETTE, 'fixed inset-0')
  const refusal = layer(SESSION, REFUSAL)
  assert.ok(palette > refusal, `палитра (z-${palette}) ушла под окно отказа (z-${refusal})`)
  assert.ok(
    palette < layer(SESSION, '{#if session.gone && !pult}'),
    'палитра поднялась над терминальными плашками — открывать там уже нечего',
  )
})

test('на проекции окна нет, но записка его дожидается', () => {
  // Смена режима не пересоздаёт SessionScreen (App держит `{#key}` на токене),
  // так что `refusal` переживает выход с балки в комнату — там окно и покажут.
  assert.match(
    SESSION,
    /\{#if refusal && refusalShown && !projection\}/,
    'окно снова рисуется на балке — чужая тетрадь во весь экран перед залом',
  )
  const app = code(read('web/src/App.svelte'))
  assert.match(app, /\{#key me\.token\}/, 'экран комнаты пересобирается при смене режима')
})

test('пульт правил не остаётся под балкой открытым', () => {
  // `rulesOpen` переживает смену режима: компонент один на все три. Без режима
  // в ветке панель ложилась под проекцию (z-[90]) и под пульт (z-[95]), где её
  // не видно, но она есть, — и Escape туда не доходит (`onKeydown` уходит на
  // первой строке при `mode !== 'room'`).
  assert.match(
    SESSION,
    /\{#if rulesOpen && isHost && mode === 'room'/,
    'пульт правил снова рисуется вне комнаты',
  )
  assert.match(SESSION, /if \(mode !== 'room'\) return/, 'клавиши комнаты — только в комнате')
})

test('окно отказа в продукте одно — второй копии потерянного текста нет', () => {
  // «Удалён» и «разошлись» пульт говорит своими словами (pult-one-voice), и
  // соблазн повторить так же с окном велик. Но у тех плашек слов ровно на
  // плашку, а здесь — сам потерянный текст: две копии разъедутся первой правкой.
  const roots = ['web/src/screens', 'web/src/components', 'web/src/lib']
  const seen: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.resolve(import.meta.dirname, '..', dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(svelte|ts)$/.test(entry.name) && code(read(rel)).includes('Скопировать всё')) {
        seen.push(rel)
      }
    }
  }
  for (const dir of roots) walk(dir)
  assert.deepEqual(seen, ['web/src/screens/SessionScreen.svelte'], 'окно отказа размножилось')
})
