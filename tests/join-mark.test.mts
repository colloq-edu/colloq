/**
 * Метка, с которой стучатся в комнату, и момент, в который её выбирают.
 *
 * Экран входа обещает метку, которой никто в комнате не носит. Обещание
 * держалось на одном чтении ростера — при монтировании, — а класс открывает
 * ссылку в одну минуту: у всех тридцати комната пуста, все выбирают из полного
 * списка независимо, и одинаковые метки получаются не по невезению, а по
 * построению. Ошибка тихая: два ежа в комнате — это два одинаковых курсора в
 * тетради (цвет их не различает, он минтуется из id), и заметят это на
 * двадцатой минуте.
 *
 * Здесь проверяется то, что от этого лечится на клиенте: занятость считается
 * по ТЕМ, КТО В КОМНАТЕ, а метка пересчитывается по ростеру, прочитанному
 * перед входом, — и при этом выбранная руками не подменяется никогда.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Participant } from '../shared/protocol.js'
import { markToClaim, takenMarks } from '../web/src/components/join/pick.js'
import { MARKS } from '../web/src/lib/marks.js'

const all = MARKS.map((entry) => entry.mark)

const person = (id: string, avatar: string | null, role: Participant['role'] = 'participant'): Participant => ({
  id,
  name: id,
  avatar,
  color: '#123456',
  role,
})

test('занята метка только того, кто в комнате прямо сейчас', () => {
  const roster = [person('p1', all[0]), person('p2', all[1])]
  // p2 входил неделю назад и давно закрыл вкладку.
  const taken = takenMarks(roster, new Set(['p1']), null)
  assert.equal(taken.has(all[0]), true)
  assert.equal(taken.has(all[1]), false, 'метка ушедшего осталась занятой')
})

test('своё же прошлое место комнате не мешает', () => {
  const roster = [person('me', all[3])]
  assert.equal(takenMarks(roster, new Set(['me']), 'me').size, 0)
  assert.equal(takenMarks(roster, new Set(['me']), null).size, 1)
})

test('участник без метки ничего не занимает', () => {
  assert.equal(takenMarks([person('p1', null)], new Set(['p1']), null).size, 0)
})

test('выданная нами метка пересчитывается по свежему ростеру', () => {
  /*
   * Ровно тот случай, ради которого всё это: при монтировании комната пуста,
   * экран выдал ежа; пока студент печатал имя, ежа занял сосед.
   */
  const mine = all[7]
  const atMount = takenMarks([], new Set(), null)
  assert.equal(markToClaim(mine, false, atMount, null), mine)

  const beforeKnock = takenMarks([person('other', mine)], new Set(['other']), null)
  const given = markToClaim(mine, false, beforeKnock, null)
  assert.notEqual(given, mine, 'постучались меткой, которую при нас уже надели')
  assert.ok(all.includes(given))
})

test('выбранную руками не подменяет никто', () => {
  const chosen = all[11]
  const taken = takenMarks([person('other', chosen)], new Set(['other']), null)
  assert.equal(
    markToClaim(chosen, true, taken, null),
    chosen,
    'экран отменил выбор человека молча — это хуже двух ежей',
  )
})

test('свободную метку не трогают ни при каком ростере', () => {
  const mine = all[2]
  const taken = takenMarks([person('a', all[0]), person('b', all[1])], new Set(['a', 'b']), null)
  for (let i = 0; i < 20; i++) assert.equal(markToClaim(mine, false, taken, null), mine)
})

test('полная комната делится меткой, а не закрывает дверь', () => {
  const roster = all.map((mark, i) => person(`p${i}`, mark))
  const taken = takenMarks(roster, new Set(roster.map((p) => p.id)), null)
  const given = markToClaim(all[0], false, taken, null)
  assert.ok(all.includes(given), 'вход остался без метки вовсе')
})

test('вернувшемуся отдают его же зверя, если он свободен', () => {
  const prefer = all[5]
  const taken = takenMarks([person('a', all[0])], new Set(['a']), null)
  // Выданная нами метка занята, но у браузера есть своя из прошлого раза.
  for (let i = 0; i < 20; i++) {
    assert.equal(markToClaim(all[0], false, taken, prefer), prefer)
  }
})
