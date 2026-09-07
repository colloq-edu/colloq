/**
 * «Строка комнаты ещё есть?» — вопрос, на который отвечает база, а не память.
 *
 * Строка семинара теперь отвечает из кэша (`db.ts` · roomCache): рукопожатий у
 * зала на пятьсот человек — тысяча за секунду, и каждое спрашивало одно и то же.
 * Но у того же вопроса есть второй, редкий читатель — сброс снимка документа
 * (`collab/persistence.ts`): он не пишет тетрадь комнаты на диск, если комнаты
 * больше нет, и это последняя линия обороны против семинара, воскресшего через
 * несколько секунд после удаления. Ответь ему кэш — и защита держалась бы не на
 * базе, а на том, что каждый путь удаления не забыл позвать `forgetRoom`.
 *
 * Поэтому у db.ts две двери на один вопрос, и здесь закреплено, чем они
 * отличаются: `getSession` быстрый и помнит, `sessionRowExists` медленный (один
 * SELECT по первичному ключу раз в несколько секунд на комнату) и не помнит
 * ничего.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, db, forgetRoom, getSession, sessionRowExists } from '../server/src/db.js'

/**
 * Запись мимо этого модуля — та самая забытая инвалидация, только устроенная
 * нарочно: продуктовый путь удаления зовёт `forgetRules` и через неё
 * `forgetRoom`, а этот тест проверяет, что будет, когда кто-нибудь однажды
 * этого не сделает.
 */
const deleteBehindTheBack = db.prepare('DELETE FROM sessions WHERE id = ?')

test('о комнате, которой никогда не было, отвечает «нет»', () => {
  assert.equal(sessionRowExists('никогда-не-заводили'), false)
})

test('строку снесли мимо кэша: память ещё помнит комнату, база уже нет', () => {
  const id = 'row-exists-room'
  createSession(id, 'Комната', null)
  assert.equal(sessionRowExists(id), true)
  // Тот же вопрос через кэш — чтобы в нём наверняка лежала эта комната.
  assert.equal(getSession(id)?.name, 'Комната')

  deleteBehindTheBack.run(id)

  assert.equal(sessionRowExists(id), false, 'ответ приехал из памяти, а не из базы')
  assert.ok(
    getSession(id),
    'кэш вдруг узнал об удалении сам — тогда этот тест проверяет не то, что нужно',
  )

  // А продуктовый путь удаления сходится с базой: он забывает комнату целиком.
  forgetRoom(id)
  assert.equal(getSession(id), null)
  assert.equal(sessionRowExists(id), false)
})
