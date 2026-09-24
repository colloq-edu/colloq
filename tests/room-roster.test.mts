/**
 * The faces in the room's status bar — and what they do NOT react to.
 *
 * `yCollab` announces the cursor position through presence on every selection
 * move. With a hundred people typing that is hundreds of frames a second, and
 * each of them rebuilt the array of everyone in the room in the header, glued
 * their names into a tooltip and woke the avatar stack — on every one of five
 * hundred clients, the projection included. Nothing here depends on the
 * cursor: the bar draws the name, the badge, the colour and "(you)".
 *
 * The bug is invisible by definition — the picture is right, and the main
 * thread pays for it — so the rule is checked, not the picture: the same
 * line-up has to give "the same", and any change to what is VISIBLE has to
 * give "different".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { faceOf, namesLine, sameFaces, type Someone } from '../web/src/screens/roster.js'

const someone = (id: string, name: string, extra: Partial<Someone['user']> = {}): Someone => ({
  user: { id, name, avatar: '🦊', color: '#123456', ...extra },
  isSelf: false,
})

test('the same line-up is the same', () => {
  const people = [someone('a', 'Ада'), someone('b', 'Борис')]
  const faces = people.map(faceOf)
  // A new presence frame: the same people, different objects.
  const again = [someone('a', 'Ада'), someone('b', 'Борис')]
  assert.equal(sameFaces(faces, again), true)
})

test('every visible field breaks the match', () => {
  const faces = [someone('a', 'Ада')].map(faceOf)
  assert.equal(sameFaces(faces, [someone('a', 'Аделаида')]), false, 'name')
  assert.equal(sameFaces(faces, [someone('a', 'Ада', { avatar: '🐢' })]), false, 'badge')
  assert.equal(sameFaces(faces, [someone('a', 'Ада', { color: '#654321' })]), false, 'colour')
  assert.equal(sameFaces(faces, [someone('b', 'Ада')]), false, 'another person with the same name')
})

test('"(you)" is something visible too', () => {
  const faces = [someone('a', 'Ада')].map(faceOf)
  const asSelf: Someone = { user: { id: 'a', name: 'Ада', avatar: '🦊', color: '#123456' }, isSelf: true }
  assert.equal(sameFaces(faces, [asSelf]), false)
  assert.equal(faceOf(asSelf).title, 'Ада (вы)')
  assert.equal(faces[0].title, 'Ада')
})

test('a line-up changed in number or order is a different line-up', () => {
  const faces = [someone('a', 'Ада'), someone('b', 'Борис')].map(faceOf)
  assert.equal(sameFaces(faces, [someone('a', 'Ада')]), false, 'someone left')
  assert.equal(
    sameFaces(faces, [someone('a', 'Ада'), someone('b', 'Борис'), someone('c', 'Вера')]),
    false,
    'someone came',
  )
  assert.equal(sameFaces(faces, [someone('b', 'Борис'), someone('a', 'Ада')]), false, 'order')
})

test('an empty room matches an empty room', () => {
  assert.equal(sameFaces([], []), true)
})

test('a tooltip for five hundred people is not built in full', () => {
  const many = Array.from({ length: 500 }, (_, i) => someone(`p${i}`, `Человек ${i}`)).map(faceOf)
  const line = namesLine(many)
  assert.ok(line.includes('Человек 0'), 'the first ones are not visible at all')
  assert.ok(line.endsWith('и ещё 480'), line.slice(-40))
  assert.ok(!line.includes('Человек 400'), 'all five hundred were glued together')
})

test('a room of thirty people names everyone', () => {
  const class30 = Array.from({ length: 12 }, (_, i) => someone(`p${i}`, `И${i}`)).map(faceOf)
  const line = namesLine(class30, 20)
  assert.equal(line.split(', ').length, 12)
  assert.ok(!line.includes('more'))
})
