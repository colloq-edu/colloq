/**
 * Одно правило — одна копия: где на клиенте их было две.
 *
 * Монограмма человека считалась дважды и по-разному: лента версий брала первую
 * и ВТОРУЮ буквы, аватар и список людей — первую и ПОСЛЕДНЮЮ. «Иван Петрович
 * Сидоров» получался «ИП» в одном углу экрана и «ИС» в другом — один человек,
 * один экран, две монограммы, и ни одна из них не выглядит ошибкой.
 *
 * Полоса режима консилиума складывалась тремя способами: `councilStripText`
 * (с тестом и без единого вызова), разметка консоли руками и счётчики сервера.
 * Здесь проверяется, что у функции есть чем ответить на оба вопроса — и про
 * счёт сервера, и про то, что человек может пересчитать глазами, — и что её
 * по-прежнему кто-то зовёт: функция с тестом и без вызова — это и был дефект.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initials } from '../web/src/lib/utils.js'
import { initialsOf } from '../web/src/lib/history.js'
import { councilStripText } from '../web/src/lib/council.svelte.js'

test('монограмма в ленте версий — та же, что на аватаре', () => {
  for (const name of ['Иван Петрович Сидоров', 'Ада Лавлейс', 'Пётр', 'Anna Maria de la Cruz']) {
    assert.equal(initialsOf(name), initials(name), `${name}: два разных кружка на одном экране`)
  }
})

test('у записи без автора монограммы нет: это комната, а не неизвестный человек', () => {
  // `initials` отвечает «?» — «кто-то, кого мы не знаем»; лента рисует точку,
  // и это другое утверждение: никто, потому что писал не человек.
  assert.equal(initialsOf(null), '')
  assert.equal(initialsOf('   '), '')
  assert.equal(initials(''), '?')
})

test('полоса консилиума считает группы по тому, что на экране, а не только по серверу', () => {
  const counts = { attempts: 487, submitted: 446, writing: 41, groups: 6 }
  assert.equal(
    councilStripText(counts),
    '487 попыток · 446 сдали · 41 черновик · 6 разных ответов',
  )
  // Стопка сгруппировала то, что ей доехало, — в полосе должно стоять это.
  assert.equal(
    councilStripText(counts, 2),
    '487 попыток · 446 сдали · 41 черновик · 2 разных ответа',
  )
})

test('полосу режима кто-то рисует: функция без единого вызова — это и был дефект', () => {
  // Консоль переехала в окно пульта, и полоса вместе с ней — в полосу отбора.
  const filters = readFileSync(
    resolve(import.meta.dirname, '..', 'web/src/components/council/pult/PultFilters.svelte'),
    'utf8',
  )
  assert.match(filters, /councilStripText\(counts, groups\)/)
})

test('нечего сказать — не говорим: ни «0 черновиков», ни «0 разных ответов»', () => {
  assert.equal(
    councilStripText({ attempts: 2, submitted: 0, writing: 2, groups: 0 }, 0),
    '2 попытки · 0 сдали · 2 черновика',
  )
})
