/**
 * Ткнули в ежа — вошли ежом.
 *
 * Судья уникальности меток — сервер: занятую он подменяет свободной, иначе
 * класс, открывший ссылку в одну минуту, расходится с одинаковыми зверями (у
 * пары одинаковый курсор в тетради, а цвет их не различает — он минтуется из
 * id). Отличить выданную экраном метку от ткнутой пальцем по телу /join было
 * нечем, и подменялись обе: человек нажимал на ежа и оказывался выдрой — без
 * единого слова, потому что карточка входа к этому моменту уже уехала в
 * комнату.
 *
 * Здесь проверяется договор, которым эта разница передаётся, и вторая половина
 * того же обещания: подборщик рисует занятые метки занятыми — по списку,
 * прочитанному в момент его открытия, а не при монтировании формы.
 *
 * Читается прямо из файлов, как в `screens-craft.test.mts`: тест со своей
 * копией правила проходит вечно, пока экран уезжает.
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

/** Где перенесена строка, решает форматтер, а не тест. */
function flat(source: string): string {
  return code(source).replace(/\s+/g, ' ')
}

const JOIN = 'web/src/screens/JoinScreen.svelte'
const PICKER = 'web/src/components/join/MarkPicker.svelte'
const PROTOCOL = 'shared/protocol.ts'

/* ------------------------------------------------- признак выбора руками */

test('в теле /join едет признак «выбрано руками»', () => {
  const protocol = code(read(PROTOCOL))
  const request = protocol.slice(
    protocol.indexOf('interface JoinRequest'),
    protocol.indexOf('interface JoinResponse'),
  )
  assert.match(request, /picked\?: boolean/, 'серверу нечем отличить выбранную метку от выданной')
})

test('экран входа этот признак действительно посылает', () => {
  const join = flat(read(JOIN))
  assert.match(
    join,
    /api\.join\(session\.id, \{ name: who, avatar: mark, picked,/,
    'метка уходит на сервер без признака выбора — подменят и её',
  )
})

/* ---------------------------------------------------- свежесть занятости */

test('подборщик открывается вместе с перечитыванием комнаты', () => {
  const join = flat(read(JOIN))
  assert.match(join, /onclick=\{openPicker\}/, '«Change» снова открывает подборщик напрямую')
  assert.doesNotMatch(
    join,
    /onclick=\{\(\) => \(picking = true\)\}/,
    'осталось открытие без чтения',
  )
  assert.match(
    join,
    /function openPicker\(\): void \{ picking = true void readRoom\(\)/,
    'сетка рисуется по ростеру минутной давности',
  )
})

test('чтение комнаты идёт через общее правило выбора метки', () => {
  // markToClaim — единственная копия правила (components/join/pick.ts): своё
  // пересчитываем, выбранное руками не трогаем. Вторая копия здесь разъехалась
  // бы с той, на которой стоят тесты.
  const join = flat(read(JOIN))
  assert.match(
    join,
    /async function readRoom\(\)[\s\S]*mark = markToClaim\(mark, picked, taken, profile\.avatar\)/,
    'у чтения комнаты завелась своя копия правила',
  )
})

/* ---------------------------------------------------------- своя плитка */

test('своя метка остаётся своей, даже когда её успели занять', () => {
  const picker = flat(read(PICKER))
  const grid = picker.slice(picker.indexOf('role="radiogroup"'))
  // Ростер перечитывается при открытии подборщика, и выбранный руками зверь
  // может приехать сюда уже занятым. Серым он тогда становиться не должен:
  // «где мой» на сорока плитках без рамки не читается.
  assert.match(
    grid,
    /\{selected \? 'border-accent[^']*' : held \?/,
    'занятость перекрашивает собственную метку и рамка теряется',
  )
  assert.match(
    grid,
    /held && !selected \? 'opacity-25'/,
    'свой же зверь гаснет до четверти видимости',
  )
  // И при этом точка носителя остаётся: рядом с вами его носит кто-то ещё.
  assert.match(grid, /\{#if held\}/, 'точка носителя пропала вместе с серым')
})
