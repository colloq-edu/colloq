/**
 * Оболочка: адреса, по которым сюда попадают, и то, что браузер помнит между
 * заходами.
 *
 * Здесь нет ни экранов, ни сокетов — только три функции, у которых общая
 * особенность: сломавшись, они не роняют сборку, а тихо меняют то, куда
 * человек попал. Регулярка, переставшая узнавать ключ пульта, высаживает
 * планшет на экран входа с живым ключом в адресной строке — на проекторе;
 * карта личностей, потерявшая запись, отправляет студента называться заново
 * посреди пары. Ни то, ни другое ни один тест до сих пор не ловил: tests/
 * identity и tests/persistence, вопреки именам, проверяют сервер.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signHandoffToken } from '../server/src/auth.js'
import { OPEN_ROOM } from '../shared/rules.js'
import { isAdminPath, readCourseId, readPublicRoute, readRoomRoute } from '../web/src/lib/routes.js'
import { forgetIdentity, loadIdentity, loadProfile, saveIdentity } from '../web/src/lib/identity.js'
import {
  forgetSessionInfo,
  recallSessionInfo,
  rememberSessionInfo,
} from '../web/src/lib/persistence.svelte.js'

/*
 * Хранилище браузера, которого в Node нет. Модули читают его только внутри
 * функций, поэтому подделки, поставленной до первого теста, достаточно.
 */
class MemoryStorage {
  #map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value)
  }
  removeItem(key: string): void {
    this.#map.delete(key)
  }
  clear(): void {
    this.#map.clear()
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

/* --------------------------------------------------------------- адреса */

test('ссылка на семинар — это комната и ничего больше', () => {
  assert.deepEqual(readRoomRoute('/s/kf3n8q2p'), {
    id: 'kf3n8q2p',
    mode: 'room',
    handoffKey: null,
  })
  // Косая черта на конце — та же ссылка: её дописывают почтовые клиенты.
  assert.deepEqual(readRoomRoute('/s/kf3n8q2p/'), {
    id: 'kf3n8q2p',
    mode: 'room',
    handoffKey: null,
  })
})

test('проекция и пульт — та же комната, другой экран', () => {
  assert.equal(readRoomRoute('/s/kf3n8q2p/screen')?.mode, 'screen')
  assert.equal(readRoomRoute('/s/kf3n8q2p/pult')?.mode, 'pult')
  assert.equal(readRoomRoute('/s/kf3n8q2p/screen')?.id, 'kf3n8q2p')
})

test('ключ пульта, подписанный сервером, узнаётся целиком', () => {
  /*
   * Тот самый случай, ради которого этот файл и заведён: алфавит ключа задаёт
   * `signHandoffToken` (base64url через точки), а узнаёт его регулярка здесь.
   * Разойтись они умеют молча — планшет тогда попадает на экран входа, а ключ
   * остаётся в адресной строке.
   */
  const key = signHandoffToken('kf3n8q2p', 'p-123', 'teacher@example.edu')
  const route = readRoomRoute(`/s/kf3n8q2p/t/${key}`)
  assert.equal(route?.handoffKey, key, key)
  assert.equal(route?.mode, 'room')
  // И без штатной куки — ключ тогда короче, но того же алфавита.
  const plain = signHandoffToken('kf3n8q2p', 'p-123')
  assert.equal(readRoomRoute(`/s/kf3n8q2p/t/${plain}`)?.handoffKey, plain, plain)
})

test('чужие адреса комнатой не притворяются', () => {
  for (const path of ['/', '/admin', '/admin/seminars', '/c/ml-2026', '/p/x9tb4kwm', '/s/']) {
    assert.equal(readRoomRoute(path), null, path)
  }
  // Хвост, которого не бывает: три экрана — это весь список.
  assert.equal(readRoomRoute('/s/kf3n8q2p/notes'), null)
})

test('курс и публикация — свои адреса, не выводимые из адреса комнаты', () => {
  assert.equal(readCourseId('/c/ml-2026'), 'ml-2026')
  assert.equal(readCourseId('/c/ml-2026/'), 'ml-2026')
  assert.equal(readCourseId('/s/kf3n8q2p'), null)
  assert.deepEqual(readPublicRoute('/p/x9tb4kwm'), { id: 'x9tb4kwm', step: null })
  assert.deepEqual(readPublicRoute('/p/x9tb4kwm/3'), { id: 'x9tb4kwm', step: 3 })
  // Отрицательный шаг — это «с конца», и он тоже шаг, а не мусор.
  assert.deepEqual(readPublicRoute('/p/x9tb4kwm/-1'), { id: 'x9tb4kwm', step: -1 })
  assert.equal(readPublicRoute('/c/ml-2026'), null)
})

test('панель узнаётся по своему префиксу, а не по началу слова', () => {
  assert.equal(isAdminPath('/admin'), true)
  assert.equal(isAdminPath('/admin/teachers'), true)
  assert.equal(isAdminPath('/administrators'), false)
  assert.equal(isAdminPath('/s/kf3n8q2p'), false)
})

/* ------------------------------------------------------------- личности */

const IDENTITY = {
  sessionId: 'kf3n8q2p',
  participantId: 'p-1',
  token: 'token-1',
  name: 'Ада',
  avatar: 'fox',
  color: '#123456',
  role: 'participant' as const,
}

test('личность помнится по комнатам и стирается по одной', () => {
  storage.clear()
  saveIdentity(IDENTITY)
  saveIdentity({ ...IDENTITY, sessionId: 'other', participantId: 'p-2' })

  assert.equal(loadIdentity('kf3n8q2p')?.participantId, 'p-1')
  assert.equal(loadIdentity('other')?.participantId, 'p-2')

  forgetIdentity('kf3n8q2p')
  // Ключ комнаты больше не годится — но соседний семинар тут ни при чём.
  assert.equal(loadIdentity('kf3n8q2p'), null)
  assert.equal(loadIdentity('other')?.participantId, 'p-2')
  // Имя остаётся: назваться придётся заново, набирать — нет.
  assert.equal(loadProfile().name, 'Ада')
})

test('забыть то, чего нет, — не ошибка', () => {
  storage.clear()
  forgetIdentity('kf3n8q2p')
  assert.equal(loadIdentity('kf3n8q2p'), null)
})

test('испорченная запись — это «никого не помним», а не падение на входе', () => {
  storage.clear()
  storage.setItem('colloq.identity.v1', '{not json')
  assert.equal(loadIdentity('kf3n8q2p'), null)
  // И поверх мусора всё ещё можно записаться.
  saveIdentity(IDENTITY)
  assert.equal(loadIdentity('kf3n8q2p')?.token, 'token-1')
})

/* ---------------------------------------------------------- карточка комнаты */

const ROOM = {
  id: 'kf3n8q2p',
  name: 'Регуляризация',
  createdAt: 1_700_000_000_000,
  rules: { ...OPEN_ROOM },
  finishedAt: null,
  published: null,
  course: null,
}

test('карточка комнаты переживает заход и обновляется с переименованием', () => {
  storage.clear()
  assert.equal(recallSessionInfo('kf3n8q2p'), null)

  rememberSessionInfo(ROOM)
  assert.equal(recallSessionInfo('kf3n8q2p')?.name, 'Регуляризация')

  rememberSessionInfo({ ...ROOM, name: 'Регуляризация и отбор' })
  assert.equal(recallSessionInfo('kf3n8q2p')?.name, 'Регуляризация и отбор')

  forgetSessionInfo('kf3n8q2p')
  assert.equal(recallSessionInfo('kf3n8q2p'), null)
})

test('правила и публикация обновляются в карточке так же, как имя', () => {
  /*
   * Первый кадр комнаты рисуется по этой карточке, и правило, оставшееся в
   * ней с прошлого семестра, включает кнопки, которых человеку уже нельзя.
   * Проверка сравнением по имени пропускала ровно это.
   */
  storage.clear()
  rememberSessionInfo(ROOM)

  const locked = { ...ROOM, rules: { ...OPEN_ROOM, edit: 'host' as const } }
  rememberSessionInfo(locked)
  assert.equal(recallSessionInfo('kf3n8q2p')?.rules.edit, 'host')

  rememberSessionInfo({ ...locked, published: { id: 'x9tb4kwm', steps: 12 } })
  assert.equal(recallSessionInfo('kf3n8q2p')?.published?.id, 'x9tb4kwm')
})

test('испорченное хранилище — комната просто неизвестна', () => {
  storage.clear()
  storage.setItem('colloq.room.v1', 'null}')
  assert.equal(recallSessionInfo('kf3n8q2p'), null)
  rememberSessionInfo(ROOM)
  assert.equal(recallSessionInfo('kf3n8q2p')?.id, 'kf3n8q2p')
})
