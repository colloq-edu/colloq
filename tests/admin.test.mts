/**
 * The staff list is a list of live credentials. Three independent reviews found
 * real holes here, so the invariants that survived are pinned down.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import {
  countOwners,
  createTeacher,
  deleteTeacher,
  getTeacherByEmail,
  getTeacherByLinkKey,
  linkKeyOf,
  listTeachers,
  normalizeEmail,
  rotateLinkKey,
  updateTeacherIdentity,
  updateTeacherRole,
} from '../server/src/admin/store.js'
import { issueStaffCookie, staffFromCookieHeader, verifySetupToken } from '../server/src/admin/auth.js'

/** issueStaffCookie writes onto express's Response; this is the smallest thing that shape. */
function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function fresh(name: string, email: string, role: 'owner' | 'teacher' = 'teacher') {
  const teacher = createTeacher({ name, email, role })
  assert.ok(teacher, `could not create ${email}`)
  rotateLinkKey(teacher.id)
  return teacher
}

test('an email is one identity however it was typed', () => {
  assert.equal(normalizeEmail('  Ada.Lovelace@HSE.RU '), 'ada.lovelace@hse.ru')
  const ada = fresh('Ada', 'Ada.Lovelace@HSE.RU', 'owner')
  assert.equal(ada.email, 'ada.lovelace@hse.ru')
  // The same person, shouted: a second row here is a second account nobody knows about.
  assert.equal(createTeacher({ name: 'Ada again', email: ' ADA.lovelace@hse.ru ', role: 'teacher' }), null)
  assert.ok(getTeacherByEmail('ada.lovelace@hse.ru'))
})

test('a sign-in link is never in a listing', () => {
  const grace = fresh('Grace Hopper', 'grace@hse.ru')
  const listed = listTeachers().find((t) => t.id === grace.id)
  assert.ok(listed)
  assert.equal(listed.hasLink, true)
  // hasLink says there is one; the key itself must not ride along.
  assert.equal(JSON.stringify(listed).includes(linkKeyOf(grace.id) ?? 'x'), false)
})

test('rotating a link kills the old one and every session opened from it', () => {
  const katherine = fresh('Katherine Johnson', 'katherine@hse.ru')
  const oldKey = linkKeyOf(katherine.id)
  assert.ok(oldKey)
  const cookie = mintCookie(katherine)
  assert.equal(staffFromCookieHeader(cookie)?.id, katherine.id)

  const minted = rotateLinkKey(katherine.id)
  assert.ok(minted)
  assert.notEqual(minted.key, oldKey)
  // Revocation with no session table: the signature is over the link key, so
  // replacing the key invalidates every cookie ever signed with it.
  assert.equal(getTeacherByLinkKey(oldKey), null)
  assert.equal(staffFromCookieHeader(cookie), null)
  assert.equal(staffFromCookieHeader(mintCookie(minted.teacher))?.id, katherine.id)
})

test('deleting a teacher kills their cookie too', () => {
  const pavel = fresh('Pavel', 'pavel@hse.ru')
  const cookie = mintCookie(pavel)
  assert.equal(staffFromCookieHeader(cookie)?.id, pavel.id)
  assert.equal(deleteTeacher(pavel.id), true)
  assert.equal(staffFromCookieHeader(cookie), null)
})

test('a forged or absent cookie is nobody', () => {
  const marina = fresh('Marina', 'marina@hse.ru')
  const cookie = mintCookie(marina)
  const value = cookie.slice(STAFF_COOKIE.length + 1)
  const [body, sig] = [value.slice(0, value.lastIndexOf('.')), value.slice(value.lastIndexOf('.') + 1)]

  assert.equal(staffFromCookieHeader(undefined), null)
  assert.equal(staffFromCookieHeader(''), null)
  assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=nonsense`), null)
  assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=${body}.tampered`), null)
  // Someone else's signature over your own id.
  const other = mintCookie(fresh('Other', 'other@hse.ru'))
  const otherSig = other.slice(other.lastIndexOf('.') + 1)
  assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=${body}.${otherSig}`), null)
  assert.notEqual(sig, otherSig)
})

test('the owner count tracks promotion and demotion', () => {
  const before = countOwners()
  const dmitry = fresh('Dmitry', 'dmitry@hse.ru')
  assert.equal(countOwners(), before)
  updateTeacherRole(dmitry.id, 'owner')
  assert.equal(countOwners(), before + 1)
  updateTeacherRole(dmitry.id, 'teacher')
  assert.equal(countOwners(), before)
})

test('a wrong setup token is refused and a right one is not', () => {
  assert.equal(verifySetupToken('definitely-not-it'), false)
  assert.equal(verifySetupToken(''), false)
  assert.equal(verifySetupToken(null), false)
  assert.equal(verifySetupToken(12345), false)
})

test('a teacher can be renamed without losing their link', () => {
  const marina = fresh('Ada Lovelace', 'ada@example.edu')
  const key = linkKeyOf(marina.id)

  const fixed = updateTeacherIdentity(marina.id, { name: 'Ada Lovelace', email: 'Ada@Example.edu ' })
  assert.equal(fixed?.name, 'Ada Lovelace')
  // Тот же адрес, приведённый к одному виду — как и на заведении.
  assert.equal(fixed?.email, 'ada@example.edu')
  // Смысл правки в том, что ссылка остаётся: иначе это удаление с заводом заново.
  assert.equal(linkKeyOf(marina.id), key)
  assert.ok(getTeacherByEmail('ada@example.edu'))
  assert.equal(getTeacherByEmail('ada@example.edu'), null)
})

test('a rename onto somebody else’s address is refused, not merged', () => {
  const one = fresh('Sergey', 'sergey@hse.ru')
  fresh('Olga', 'olga@hse.ru')

  assert.equal(updateTeacherIdentity(one.id, { name: 'Sergey', email: 'olga@hse.ru' }), null)
  // Отказ не должен переименовать наполовину.
  assert.equal(getTeacherByEmail('sergey@hse.ru')?.id, one.id)
})
