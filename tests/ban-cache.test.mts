/**
 * Кэш банов на комнату: чего он экономит и чем за это платит.
 *
 * `banFor` спрашивают на входе и на рукопожатии каждого из трёх сокетов, а
 * после перезапуска сервера пятьсот вкладок возвращаются за одну-две секунды —
 * тысяча DELETE плюс тысяча SELECT в ту самую секунду, когда вся комната ждёт
 * возврата, и в подавляющем большинстве комнат ни за что: банов там нет вовсе.
 * Поэтому комната помнит одно число — до какого момента в ней есть кого ловить.
 *
 * Кэш прав тем, что он про число, а не про флаг: истечь бан может сам, а
 * появиться — только через `banParticipant`, и там кэш забывается. Здесь
 * проверяется и то, и другое, и цена: строка, положенная в таблицу МИМО
 * продукта, до первого чтения списка не действует. Это и есть доказательство,
 * что чтения базы на второй запрос не было.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { banFor, banParticipant, liftBan, listBans } from '../server/src/bans.js'
import { createSession, db, upsertParticipant } from '../server/src/db.js'

let rooms = 0

function room(): { id: string; petya: string } {
  const id = `ban-cache-${++rooms}`
  createSession(id, 'Семинар', null)
  const petya = `p_petya_${rooms}`
  upsertParticipant({ id: petya, sessionId: id, name: 'Петя', avatar: null, role: 'participant' })
  return { id, petya }
}

/** Бан мимо продукта — тем же SQL, что и `banParticipant`, но без него. */
function insertBehindTheBack(sessionId: string, participantId: string, until: number): void {
  db.prepare(
    `INSERT INTO bans (id, session_id, participant_id, device, ip, name, until, by_teacher, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
  ).run(`b_hand_${rooms}`, sessionId, participantId, 'Петя', until, Date.now())
}

test('в комнате без банов второй вопрос до базы не доходит', () => {
  const { id, petya } = room()
  // Первое чтение — честное: оно и убирает просроченное, и заводит число.
  assert.equal(banFor(id, petya, undefined), null)

  insertBehindTheBack(id, petya, Date.now() + 60_000)
  assert.equal(
    banFor(id, petya, undefined),
    null,
    'банов в комнате не было, а запрос всё-таки ушёл в базу',
  )

  // И это не слепота, а незнание: продукт своей дверью читает список — и видит.
  assert.equal(listBans(id, null).length, 1)
  assert.ok(banFor(id, petya, undefined), 'прочитанный список так и не дошёл до проверки')
})

test('бан действует сразу — кэш забывается там же, где заводится строка', () => {
  const { id, petya } = room()
  assert.equal(banFor(id, petya, undefined), null, 'человек забанен до бана')

  const ban = banParticipant({ sessionId: id, participantId: petya, ip: null, byTeacher: 'Ада' })
  assert.ok(ban)
  const caught = banFor(id, petya, undefined)
  assert.equal(caught?.id, ban.id, 'забаненный прошёл в дверь, пока кэш помнил вчерашнее')

  assert.equal(liftBan(id, ban.id), true)
  assert.equal(banFor(id, petya, undefined), null, 'снятый бан продолжает держать')
})

test('срок выходит сам: числу не нужно, чтобы его кто-то забыл', async () => {
  const { id, petya } = room()
  const ban = banParticipant({
    sessionId: id,
    participantId: petya,
    ip: null,
    byTeacher: 'Ада',
    until: Date.now() + 120,
  })
  assert.ok(ban)
  assert.ok(banFor(id, petya, undefined), 'бан не действует, пока идёт его срок')

  await sleep(200)
  assert.equal(
    banFor(id, petya, undefined),
    null,
    'ни секунды сверх срока — а кэш держит дверь закрытой',
  )
})
