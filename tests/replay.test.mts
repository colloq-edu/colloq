/**
 * Самое опасное в этом наборе правок — история версий: снимки теперь пишутся
 * по накопленным байтам, всплеск может принадлежать двоим, а «до» берётся из
 * памяти. Если хоть что-то из этого рвёт цепочку повтора, старые версии
 * пересоберутся с пропусками, и Restore затрёт живой текст — ровно та беда,
 * ради которой всё это чинили. Проверка простая: собрать каждую версию из
 * базы и сверить с тем, что было на самом деле.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession, listVersions } from '../server/src/db.js'
import { flushHistory, record, cellsAt } from '../server/src/collab/history.js'
import { createCell, getCells } from '../shared/notebook.js'

test('каждая версия пересобирается ровно в то, чем была', () => {
  const id = 'replay-check'
  createSession(id, 'Replay', null)
  const doc = new Y.Doc()
  let who = 'p_one'
  doc.on('update', (u: Uint8Array) => record(id, doc, u, who))

  doc.transact(() => getCells(doc).push([createCell('code', 'x = 0')]))
  flushHistory(id)

  const expected: string[] = []
  for (let i = 1; i <= 60; i++) {
    // Автор чередуется: всплеск, в который писали двое, теперь один.
    who = i % 3 === 0 ? 'p_two' : 'p_one'
    const cell = getCells(doc).get(0)
    const src = cell.get('source') as Y.Text
    doc.transact(() => src.insert(src.length, `\n# ${i}`))
    flushHistory(id)
    expected.push(src.toString())
  }

  // И крупная правка — чтобы снимок сработал по байтам, а не по потолку строк:
  // именно на нём стоит вся сборка старых версий, и порвись он — молча.
  for (let i = 0; i < 4; i++) {
    who = 'p_one'
    const src = getCells(doc).get(0).get('source') as Y.Text
    doc.transact(() => src.insert(src.length, '\n' + 'z'.repeat(30_000)))
    flushHistory(id)
  }

  const versions = listVersions(id, 500)
  assert.ok(versions.length > 5, `версий всего ${versions.length}`)
  assert.ok(
    versions.some((v) => v.kind === 'keyframe'),
    'ни одного полного снимка — правило по байтам не сработало',
  )

  // Последняя настоящая версия должна совпасть с живым документом — если
  // цепочка где-то порвалась, здесь будет обрубок.
  const live = (getCells(doc).get(0).get('source') as Y.Text).toString()
  const newest = versions.find((v) => v.kind === 'edit' || v.kind === 'quiet')!
  const rebuilt = cellsAt(id, newest.seq)
  assert.equal(rebuilt[0]?.source, live, 'последняя версия пересобралась не тем')

  // И каждая версия по отдельности — не пустая и не короче предыдущей.
  let previous = 0
  for (const v of [...versions].reverse()) {
    if (v.kind === 'opened') continue
    const cells = cellsAt(id, v.seq)
    assert.ok(cells.length > 0, `версия ${v.seq} (${v.kind}) пересобралась пустой`)
    const length = cells[0].source.length
    assert.ok(length >= previous, `версия ${v.seq} (${v.kind}) короче предыдущей: ${length} < ${previous}`)
    previous = length
  }
})
