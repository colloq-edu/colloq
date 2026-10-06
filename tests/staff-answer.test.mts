/**
 * "Is this staff?" — and the price of a wrong "no".
 *
 * The mark in localStorage permits nothing: it only says that this browser
 * once signed in to the panel, and that it is therefore worth ASKING. The
 * server gives the answer. But the entry screen and the router asked it each
 * in their own way, with different rules for removing the mark: one removed
 * it on any failure — including dropped Wi-Fi and a 500 during a server
 * restart — the other only on an explicit refusal.
 *
 * A mark removed by mistake is silent: from the next visit on, the teacher
 * gets the "what is your name" form instead of their room, and only signing
 * in to the panel again can bring it back. The rule is now one and shared:
 * "no" is the server's answer, "don't know" leaves the mark alone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readJoinRole, readStaffAnswer, staffGuestText } from '../web/src/screens/staff.js'
import { setLocaleResolver } from '../shared/i18n.js'

test('signed in — and here is the name it is under', () => {
  assert.deepEqual(readStaffAnswer(200, 'Ада Лавлейс'), { kind: 'staff', name: 'Ада Лавлейс' })
})

test('no cookie, or it was revoked — that is a "no"', () => {
  assert.deepEqual(readStaffAnswer(401, null), { kind: 'no' })
  assert.deepEqual(readStaffAnswer(403, null), { kind: 'no' })
})

test('an answer without a name is also a "no": there is nothing to sign in under', () => {
  assert.deepEqual(readStaffAnswer(200, null), { kind: 'no' })
})

test('the server cannot be heard — that is "do not know", and the mark stays', () => {
  // 0 is a failed fetch (that is how api.ts builds ApiError), the rest are a
  // server being restarted and the proxy in front of it.
  for (const status of [0, 500, 502, 503, 504]) {
    assert.deepEqual(readStaffAnswer(status, null), { kind: 'unknown' }, String(status))
  }
})

test('a foreign 404 from a proxy does not remove the mark', () => {
  // The same layer that fakes "the room is gone": under /api/admin/me it also
  // answers 404, and staff would silently be demoted to participants.
  assert.deepEqual(readStaffAnswer(404, null), { kind: 'unknown' })
})

/* ------------------------------------------------- a guest in someone's room */

test('a teacher let in as a participant is a guest, not a lost sign-in', () => {
  /*
   * Since 0.19 a staff cookie gives host only in the rooms its holder
   * teaches. The join answer for a colleague's room is a participant with a
   * staffGuest note. Reading that as "not staff" used to clear the marker,
   * and the same teacher got the name form in their OWN room the next day.
   */
  const guest = { course: { id: 'c1', name: 'Анализ данных' }, teachers: ['Марина Смирнова'] }
  assert.deepEqual(readJoinRole('host', null), { kind: 'host' })
  assert.deepEqual(readJoinRole('participant', guest), { kind: 'guest', guest })
  assert.deepEqual(readJoinRole('participant', null), { kind: 'participant' })
  assert.deepEqual(readJoinRole('participant', undefined), { kind: 'participant' })
  // A host answer wins even if a note came along with it.
  assert.deepEqual(readJoinRole('host', guest), { kind: 'host' })
})

test('the guest strip names the course and who can run the room, in both languages', () => {
  try {
    setLocaleResolver(() => 'ru')
    assert.deepEqual(
      staffGuestText({ course: { id: 'c1', name: 'Анализ данных, ПМИ 3 курс' }, teachers: ['Марина Смирнова', 'Глеб Т.'] }),
      {
        title: 'Это комната курса «Анализ данных, ПМИ 3 курс». Вы здесь как участник.',
        body: 'Вести её могут: Марина Смирнова, Глеб Т.. Попросите их добавить вас — или владельца.',
      },
    )
    // A room outside any course has no course to name.
    assert.match(staffGuestText({ course: null, teachers: ['Ада'] }).title, /вне курсов/)
    // Nobody but the owner can run it: there is no list to show.
    assert.equal(
      staffGuestText({ course: null, teachers: [] }).body,
      'Вести её сейчас может только владелец. Попросите его добавить вас.',
    )
    setLocaleResolver(() => 'en')
    assert.deepEqual(staffGuestText({ course: { id: 'c1', name: 'Data' }, teachers: ['Ada'] }), {
      title: 'This room belongs to the course “Data”. You are here as a participant.',
      body: 'It can be run by: Ada. Ask them to add you — or the owner.',
    })
    assert.match(staffGuestText({ course: null, teachers: [] }).title, /outside any course/)
  } finally {
    setLocaleResolver(() => 'ru')
  }
})
