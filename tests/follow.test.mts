/**
 * За кем идти по документу и когда предлагать вернуться.
 *
 * Всё здесь ломается тихо: экран просто ведёт себя странно, а объяснения нет.
 * Две вкладки одного преподавателя, двое преподавателей на разных страницах,
 * позиция в чужом файле — каждое из этого даёт дрожание или прыжки, которые
 * выглядят как поломка отрисовки.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adrift, leaderFor } from '../web/src/lib/follow.js'
import type { Peer } from '../web/src/lib/session.svelte.js'

let clientId = 0

function peer(
  role: 'host' | 'participant',
  viewing: { file: string; page: number; y: number } | null,
  extra: { name?: string; isSelf?: boolean; id?: number } = {},
): Peer {
  return {
    clientId: extra.id ?? ++clientId,
    isSelf: extra.isSelf ?? false,
    user: {
      id: `p${clientId}`,
      name: extra.name ?? 'Кто-то',
      avatar: null,
      color: '#000',
      role,
      viewing,
    },
  }
}

const HERE = { file: 'lecture.pdf', page: 3, y: 0.1 }

test('идут за преподавателем, а не за соседом', () => {
  const student = peer('participant', { file: 'lecture.pdf', page: 9, y: 0 })
  const teacher = peer('host', HERE, { name: 'Ада' })
  const lead = leaderFor([student, teacher], 'lecture.pdf', null)
  assert.equal(lead?.name, 'Ада')
  assert.equal(lead?.page, 3)
})

test('позиция в другом файле не считается', () => {
  /*
   * Двенадцатая страница другого документа — не то же место. Без имени файла
   * экран прыгал бы по чужим страницам, и это выглядит как поломка рендера.
   */
  const teacher = peer('host', { file: 'seminar-02.pdf', page: 12, y: 0 })
  assert.equal(leaderFor([teacher], 'lecture.pdf', null), null)
})

test('за собой не идут', () => {
  const me = peer('host', HERE, { isSelf: true })
  assert.equal(leaderFor([me], 'lecture.pdf', null), null)
})

test('из двух вкладок берут ту, где документ открыт', () => {
  /*
   * Сведение вкладок в одного человека предпочитает вкладку с активной
   * ячейкой — то есть запросто ту, где PDF не открыт. Поэтому читается сырой
   * список присутствий, а вкладка выбирается по наличию позиции в этом файле.
   */
  const notebookTab = peer('host', null, { name: 'Ада', id: 10 })
  const readerTab = peer('host', { file: 'lecture.pdf', page: 7, y: 0.5 }, { name: 'Ада', id: 11 })
  const lead = leaderFor([notebookTab, readerTab], 'lecture.pdf', null)
  assert.equal(lead?.clientId, 11)
  assert.equal(lead?.page, 7)
})

test('ведущий залипает: двое преподавателей не раскачивают экран', () => {
  /*
   * `host` — не один человек: преподавательская кука делает хостом любого
   * сотрудника. Двое на разных страницах без залипания дают дрожание экрана у
   * всей комнаты.
   */
  const first = peer('host', { file: 'lecture.pdf', page: 3, y: 0 }, { name: 'Ада', id: 20 })
  const second = peer('host', { file: 'lecture.pdf', page: 8, y: 0 }, { name: 'Борис', id: 5 })

  // Без истории — устойчивый выбор, а не «первый в списке»: порядок в
  // присутствии меняется от прихода любого кадра.
  assert.equal(leaderFor([first, second], 'lecture.pdf', null)?.clientId, 5)
  assert.equal(leaderFor([second, first], 'lecture.pdf', null)?.clientId, 5)

  // А если уже шли за первым — остаёмся с ним, хотя у второго id меньше.
  assert.equal(leaderFor([first, second], 'lecture.pdf', 20)?.clientId, 20)
})

test('ведущий ушёл — идти не за кем, и это отличается от «молчит»', () => {
  const gone = leaderFor([], 'lecture.pdf', 20)
  assert.equal(gone, null)
  // Позиции нет вовсе — тоже «не за кем»: кадр присутствия мог быть отброшен
  // целиком, например по потолку на число лиц с одного сокета.
  assert.equal(leaderFor([peer('host', null)], 'lecture.pdf', null), null)
})

test('доска закрыта — вести некому', () => {
  assert.equal(leaderFor([peer('host', HERE)], null, null), null)
})

/* ------------------------------------------------------- отставание */

const lead = { clientId: 1, name: 'Ада', color: '#000', page: 5, y: 0.4 }

test('другая страница — всегда отставание', () => {
  assert.equal(adrift({ page: 4, y: 0.4 }, lead), true)
  assert.equal(adrift({ page: 6, y: 0.4 }, lead), true)
})

test('дрожание на пиксель отставанием не считается', () => {
  // Иначе плашка «вернуться» мигает всё занятие и её перестают читать.
  assert.equal(adrift({ page: 5, y: 0.42 }, lead), false)
  assert.equal(adrift({ page: 5, y: 0.2 }, lead), false)
})

test('уехал по странице заметно — отставание', () => {
  assert.equal(adrift({ page: 5, y: 0.9 }, lead), true)
})
