/**
 * Лица в полосе состояния комнаты — и то, на что они НЕ реагируют.
 *
 * `yCollab` объявляет положение курсора через присутствие на каждое движение
 * выделения. При сотне печатающих это сотни кадров в секунду, и каждый из них
 * пересобирал в шапке массив из всех, кто в комнате, склеивал их имена в
 * подсказку и будил стопку аватаров — на каждом из пятисот клиентов, включая
 * проекцию. От курсора здесь не зависит ничего: полоса рисует имя, метку, цвет
 * и «(you)».
 *
 * Ошибка невидимая по определению — картинка правильная, платит за неё главный
 * поток, — поэтому проверяется правило, а не картинка: одинаковый состав
 * обязан давать «то же самое», а любое изменение того, что ВИДНО, — «другое».
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { faceOf, namesLine, sameFaces, type Someone } from '../web/src/screens/roster.js'

const someone = (id: string, name: string, extra: Partial<Someone['user']> = {}): Someone => ({
  user: { id, name, avatar: '🦊', color: '#123456', ...extra },
  isSelf: false,
})

test('тот же состав — то же самое', () => {
  const people = [someone('a', 'Ада'), someone('b', 'Борис')]
  const faces = people.map(faceOf)
  // Новый кадр присутствия: те же люди, другие объекты.
  const again = [someone('a', 'Ада'), someone('b', 'Борис')]
  assert.equal(sameFaces(faces, again), true)
})

test('каждое поле, которое видно, ломает совпадение', () => {
  const faces = [someone('a', 'Ада')].map(faceOf)
  assert.equal(sameFaces(faces, [someone('a', 'Аделаида')]), false, 'имя')
  assert.equal(sameFaces(faces, [someone('a', 'Ада', { avatar: '🐢' })]), false, 'метка')
  assert.equal(sameFaces(faces, [someone('a', 'Ада', { color: '#654321' })]), false, 'цвет')
  assert.equal(sameFaces(faces, [someone('b', 'Ада')]), false, 'другой человек с тем же именем')
})

test('«(you)» — тоже то, что видно', () => {
  const faces = [someone('a', 'Ада')].map(faceOf)
  const asSelf: Someone = { user: { id: 'a', name: 'Ада', avatar: '🦊', color: '#123456' }, isSelf: true }
  assert.equal(sameFaces(faces, [asSelf]), false)
  assert.equal(faceOf(asSelf).title, 'Ада (you)')
  assert.equal(faces[0].title, 'Ада')
})

test('состав изменился числом или порядком — это другой состав', () => {
  const faces = [someone('a', 'Ада'), someone('b', 'Борис')].map(faceOf)
  assert.equal(sameFaces(faces, [someone('a', 'Ада')]), false, 'кто-то ушёл')
  assert.equal(
    sameFaces(faces, [someone('a', 'Ада'), someone('b', 'Борис'), someone('c', 'Вера')]),
    false,
    'кто-то пришёл',
  )
  assert.equal(sameFaces(faces, [someone('b', 'Борис'), someone('a', 'Ада')]), false, 'порядок')
})

test('пустая комната совпадает с пустой', () => {
  assert.equal(sameFaces([], []), true)
})

test('подсказка на пятьсот человек не строится целиком', () => {
  const many = Array.from({ length: 500 }, (_, i) => someone(`p${i}`, `Человек ${i}`)).map(faceOf)
  const line = namesLine(many)
  assert.ok(line.includes('Человек 0'), 'первых не видно вовсе')
  assert.ok(line.endsWith('and 480 more'), line.slice(-40))
  assert.ok(!line.includes('Человек 400'), 'склеили всех пятьсот')
})

test('комната на тридцать человек называет всех', () => {
  const class30 = Array.from({ length: 12 }, (_, i) => someone(`p${i}`, `И${i}`)).map(faceOf)
  const line = namesLine(class30, 20)
  assert.equal(line.split(', ').length, 12)
  assert.ok(!line.includes('more'))
})
