/**
 * Чего стоит возврат зала базе: строка комнаты и право по токену.
 *
 * После перезапуска сервера или моргания ретранслятора пятьсот вкладок
 * возвращаются за одну-две секунды, по два сокета каждая, и на каждом
 * рукопожатии сервер спрашивал одно и то же: жив ли ещё семинар (`getSession`)
 * и ведущий ли этот человек (`isTokenHost`). Тысяча SELECT по первичному ключу
 * — микросекунды каждый и полсекунды занятого цикла событий ровно в ту минуту,
 * когда все ждут возврата комнаты.
 *
 * Здесь закреплено, что ответ теперь берётся из памяти — и, что важнее, что
 * забывается он ВЕЗДЕ, где меняется: кэш прав, который пережил конец занятия
 * или удаление семинара, — это не медленно, это неверно.
 *
 * Замер (эта машина, комната на 500 человек, тысяча рукопожатий подряд):
 *
 *   из базы, как было ......... 6.59 мс
 *   из памяти, как стало ...... 0.08 мс
 *
 * Потолок в тесте — с запасом на порядок: под нагруженной машиной время
 * плавает, и тест, падающий от соседнего процесса, хуже отсутствующего.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSession,
  db,
  forgetRoom,
  forgetRules,
  getRules,
  getSession,
  isTokenHost,
  renameSession,
  setFinished,
  setRules,
  storedRules,
  upsertParticipant,
} from '../server/src/db.js'

/**
 * Запись мимо этого модуля — руками в sqlite3, как в комментарии у кэша, — и
 * есть доказательство: если бы вопрос снова доходил до базы, новое значение
 * приехало бы. Ни один продуктовый путь так не пишет.
 */
const renameBehindTheBack = db.prepare('UPDATE sessions SET name = ? WHERE id = ?')
const rulesBehindTheBack = db.prepare('UPDATE sessions SET rules = ? WHERE id = ?')
const hostBehindTheBack = db.prepare('UPDATE participants SET token_host = 1 WHERE id = ?')

/** Сколько миллисекунд заняло — по лучшему из прогонов, а не по первому. */
function fastest(times: number, run: () => void): number {
  let best = Infinity
  for (let i = 0; i < times; i++) {
    const at = process.hrtime.bigint()
    run()
    best = Math.min(best, Number(process.hrtime.bigint() - at) / 1e6)
  }
  return best
}

test('строка комнаты читается один раз, а не на каждое рукопожатие', () => {
  const id = 'cache-room'
  createSession(id, 'Комната', null)
  assert.equal(getSession(id)?.name, 'Комната')

  renameBehindTheBack.run('Мимо кэша', id)
  assert.equal(getSession(id)?.name, 'Комната', 'строка комнаты читается на каждый вопрос')

  // Дверь на запись одна, и она забывает: имя, поменянное продуктом, видно
  // сразу — иначе панель переименовала бы семинар, а комната отвечала бы
  // прежним именем до перезапуска.
  renameSession(id, 'Переименована')
  assert.equal(getSession(id)?.name, 'Переименована')
})

test('одна строка — оба кэша: правила приезжают с ней, а не вторым запросом', () => {
  const id = 'cache-one-read'
  createSession(id, 'Одно чтение', null)
  setRules(id, { ...storedRules(id), run: 'host' })
  forgetRoom(id)

  // Первый же вопрос о комнате читает строку целиком — вместе с правилами.
  assert.equal(getSession(id)?.rules.run, 'host')
  rulesBehindTheBack.run(JSON.stringify({ ...storedRules(id), run: 'room' }), id)
  assert.equal(getRules(id).run, 'host', 'за правилами сходили в базу второй раз')
})

test('правила наружу уезжают своей копией', () => {
  const id = 'cache-copy'
  createSession(id, 'Копия', null)
  const seen = getSession(id)
  assert.ok(seen)
  seen.rules.run = 'host'
  assert.equal(storedRules(id).run, 'room', 'правку чужой копии увидела вся комната')
})

test('конец занятия виден сразу, а не после перезапуска', () => {
  const id = 'cache-finished'
  createSession(id, 'Занятие', null)
  assert.equal(getSession(id)?.finishedAt, null)

  setFinished(id, 1_700_000_000_000)
  assert.equal(getSession(id)?.finishedAt, 1_700_000_000_000)
  setFinished(id, null)
  assert.equal(getSession(id)?.finishedAt, null)
})

test('«нет такой комнаты» не переживает её создание', () => {
  const id = 'cache-later'
  // Студент открыл ссылку раньше, чем преподаватель нажал «Создать».
  assert.equal(getSession(id), null)

  createSession(id, 'Появилась', null)
  assert.equal(getSession(id)?.name, 'Появилась')
})

test('удалённый семинар перестаёт открывать дверь', () => {
  const id = 'cache-gone'
  createSession(id, 'Удалённый', null)
  upsertParticipant({
    id: 'p_host',
    sessionId: id,
    name: 'Ведущий',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  assert.ok(getSession(id))
  assert.equal(isTokenHost(id, 'p_host'), true)

  // Ровно то, что делает маршрут удаления (routes/admin-instance.ts): строки
  // нет, комната забыта. Кэш, переживший её, пускал бы старый токен в дверь,
  // которой уже нет, до истечения самого токена.
  db.prepare('DELETE FROM participants WHERE session_id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  forgetRules(id)

  assert.equal(getSession(id), null)
  assert.equal(isTokenHost(id, 'p_host'), false)
})

test('право по токену помнится на человека и обновляется входом', () => {
  const id = 'cache-host'
  createSession(id, 'Права', null)
  upsertParticipant({
    id: 'p_student',
    sessionId: id,
    name: 'Студент',
    avatar: null,
    role: 'participant',
  })
  assert.equal(isTokenHost(id, 'p_student'), false)

  hostBehindTheBack.run('p_student')
  assert.equal(isTokenHost(id, 'p_student'), false, 'право спрашивается у базы на каждый сокет')

  // Вход по ключу ведущего — та самая дверь на запись, и она кладёт в кэш
  // новое право сразу: первое же рукопожатие спросит именно его.
  upsertParticipant({
    id: 'p_student',
    sessionId: id,
    name: 'Студент',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  assert.equal(isTokenHost(id, 'p_student'), true)

  // Незнакомец, которого в комнате нет, — такой же ответ и так же один раз.
  assert.equal(isTokenHost(id, 'p_ghost'), false)
  // И право одной комнаты не отвечает за соседнюю: ключ от комнаты остаётся
  // ключом только от неё.
  const other = 'cache-host-other'
  createSession(other, 'Соседняя', null)
  assert.equal(isTokenHost(other, 'p_student'), false)
})

test('шторм возврата: тысяча рукопожатий стоит зала, а не тысячи чтений', () => {
  const id = 'cache-storm'
  createSession(id, 'Зал', null)
  const people: string[] = []
  for (let i = 0; i < 500; i++) {
    const who = `p_${i}`
    people.push(who)
    upsertParticipant({
      id: `${id}-${who}`,
      sessionId: id,
      name: `Студент ${i}`,
      avatar: null,
      role: 'participant',
    })
  }
  const ids = people.map((who) => `${id}-${who}`)

  // Рукопожатие: жив ли семинар (index.ts) и кто это (routes/sessions.ts ·
  // roleFor). Два сокета на вкладку — тысяча на зал.
  const handshakes = (forget: boolean) => () => {
    for (let i = 0; i < 1000; i++) {
      if (forget) forgetRoom(id)
      getSession(id)
      isTokenHost(id, ids[i % ids.length])
    }
  }
  const warm = fastest(3, handshakes(false))
  const cold = fastest(3, handshakes(true))

  assert.ok(
    warm * 3 < cold,
    `из памяти ${warm.toFixed(2)} мс против ${cold.toFixed(2)} мс из базы — кэш перестал работать`,
  )
  assert.ok(warm < 20, `тысяча рукопожатий заняла ${warm.toFixed(2)} мс`)
})
