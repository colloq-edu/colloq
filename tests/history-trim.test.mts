/**
 * Потолок истории: она перестала расти без края — и повтор при этом цел.
 *
 * `doc_history` рос до удаления семинара: единственный DELETE во всём db.ts
 * стоял в `discardHistory`. На оживлённой паре всплеск закрывается несколько
 * раз в секунду, а полный снимок приходит всякий раз, когда дельты догоняют
 * объём тетради, — семестровая комната писала сотни мегабайт в базу, лежащую
 * на том же диске, что и файлы всех остальных комнат.
 *
 * Резать при этом можно не что угодно. Повтор версии начинается с ближайшего
 * снимка НЕ ПОЗЖЕ неё и накатывает все строки между ними (`updatesUpTo`), так
 * что выброшенная строка ломает возврат не себя, а всех, кто стоит за ней до
 * следующего снимка. Отсюда правило: граница — ровно на keyframe, и всё, что
 * старше него, уходит целиком. Здесь это и проверяется — вместе с тем, что
 * комната, не упёршаяся в потолок, не теряет ни строки.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendVersion,
  createSession,
  db,
  historyTrimmed,
  trimHistory,
  updatesUpTo,
} from '../server/src/db.js'

/** Строка истории с телом заданного размера; возвращает её seq. */
function row(sessionId: string, kind: string, bytes: number): number {
  return appendVersion({
    sessionId,
    update: new Uint8Array(bytes),
    kind,
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: kind,
    added: 0,
    removed: 0,
    cells: [],
  })
}

const seqs = (sessionId: string): number[] =>
  (
    db.prepare('SELECT seq FROM doc_history WHERE session_id = ? ORDER BY seq').all(sessionId) as {
      seq: number
    }[]
  ).map((r) => r.seq)

test('история под потолком не теряет ни строки', () => {
  const id = 'trim-under'
  createSession(id, 'Под потолком', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  row(id, 'opened', 64)
  row(id, 'edit', 64)
  row(id, 'keyframe', 64)
  row(id, 'edit', 64)
  const before = seqs(id)

  // Потолок — мегабайт, в комнате четверть килобайта: резать не за что.
  assert.equal(trimHistory(id, 1024 * 1024), 0)
  assert.deepEqual(seqs(id), before)
})

test('потолок режет целыми отрезками — до снимка, а не до строки', () => {
  const id = 'trim-over'
  createSession(id, 'За потолком', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  row(id, 'opened', 1000)
  const oldQuiet = row(id, 'quiet', 1000)
  const oldEdit = row(id, 'edit', 1000)
  const secondBase = row(id, 'keyframe', 1000)
  const kept = row(id, 'quiet', 1000)
  const last = row(id, 'edit', 1000)

  // Потолок в 3500 байт: последний отрезок (снимок + две строки, 3000) влезает,
  // предыдущий (ещё 3000) — уже нет.
  const dropped = trimHistory(id, 3500)
  assert.equal(dropped, 3, 'ушли ровно строки старше снимка')
  assert.deepEqual(seqs(id), [secondBase, kept, last])
  assert.ok(oldQuiet < secondBase && oldEdit < secondBase)

  /*
   * И главное: то, что осталось, по-прежнему разворачивается. Повтор последней
   * версии начинается со снимка и берёт всё, что между, — ни одной дыры.
   */
  assert.equal(updatesUpTo(id, last).length, 3)
  assert.equal(updatesUpTo(id, kept).length, 2)
})

test('единственный снимок не режется, даже если он один больше потолка', () => {
  const id = 'trim-one'
  createSession(id, 'Один снимок', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  const opened = row(id, 'opened', 10)
  const base = row(id, 'keyframe', 9000)
  const tail = row(id, 'edit', 10)

  // Влезть не может ничто, но повторить комнату должно быть с чего.
  assert.equal(trimHistory(id, 100), 1)
  assert.deepEqual(seqs(id), [base, tail])
  assert.ok(opened < base)
  assert.equal(updatesUpTo(id, tail).length, 2)
})

test('без единого снимка не режется ничего: повторить будет не с чего', () => {
  const id = 'trim-none'
  createSession(id, 'Без снимка', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  row(id, 'opened', 5000)
  row(id, 'edit', 5000)
  const before = seqs(id)

  assert.equal(trimHistory(id, 100), 0)
  assert.deepEqual(seqs(id), before)
})

/**
 * Обрезка молчаливой быть не может: панель истории показывает остаток так же,
 * как показывала бы целую ленту, и по ней не отличить «тут ничего не писали» от
 * «до этого места не сохранилось». Признак — состояние, а не память о событии:
 * самая старая строка комнаты либо `opened`, либо начало срезано.
 */
test('обрезанная история сама говорит, что начинается позже комнаты', () => {
  const id = 'trim-says'
  createSession(id, 'Про начало', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  // Пустая — не обрезанная: комнате, где ещё ничего не записано, панель
  // говорит своими словами.
  assert.equal(historyTrimmed(id), false)

  row(id, 'opened', 1000)
  row(id, 'edit', 1000)
  assert.equal(historyTrimmed(id), false, 'лента начинается с открытия — она целая')

  row(id, 'keyframe', 1000)
  row(id, 'edit', 1000)
  assert.ok(trimHistory(id, 2500) > 0, 'проба должна упереться в потолок')
  assert.equal(historyTrimmed(id), true, 'начало ушло — об этом надо сказать словом')
})
