/**
 * Which notebooks go on a class page (server/src/publish/materials.ts).
 *
 * A room has many notebooks: the lecture, the seminar, homework, and up to
 * three personal ones per student. The page used to carry only the first in
 * the list. Now every notebook is offered, in the room's order, ticked or
 * not by rules a teacher can read («тетрадь ученика · Зуев Аким»), and a
 * refresh publishes exactly what was picked, never something added since.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession, setRules, upsertParticipant } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { addBook, createCell } from '../shared/notebook.js'
import { OPEN_ROOM } from '../shared/rules.js'
import {
  buildAndWrite,
  publishInfo,
  refreshPage,
  removeMaterial,
  setRoomAccess,
  type BuildResult,
} from '../server/src/publish/materials.js'
import {
  listMaterials,
  materialCellsText,
  publicationOf,
  readStep,
} from '../server/src/publish/store.js'
import type { PublicCell } from '../shared/publish.js'

after(() => shutdownCollab())

/** A book with code cells; the first one with an output. */
function book(doc: Y.Doc, path: string, sources: string[]): string {
  const made = addBook(doc, path)
  doc.transact(() => {
    const cells = doc.getArray<Y.Map<unknown>>(made.root)
    cells.push(sources.map((s) => createCell(s.startsWith('#') ? 'markdown' : 'code', s)))
    const first = cells.toArray().find((c) => c.get('type') === 'code')
    if (first) {
      const out = new Y.Map<unknown>()
      out.set('kind', 'stream')
      out.set('name', 'stdout')
      const text = new Y.Text()
      text.insert(0, `${path} ran\n`)
      out.set('text', text)
      ;(first.get('outputs') as Y.Array<unknown>).push([out])
      first.set('execCount', 1)
    }
  }, 'server')
  return made.root
}

function room(id: string): Y.Doc {
  createSession(id, 'Деревья и леса', null)
  return getSessionDoc(id, 'Деревья и леса').doc
}

function ok(result: BuildResult): Extract<BuildResult, { ok: true }> {
  assert.ok(result.ok, JSON.stringify(result))
  return result
}

test('the lecture and the seminar both go out, in the order the teacher put them', async () => {
  const id = 'books-both'
  const doc = room(id)
  // The room's first notebook, emptied: offered, but there is nothing to publish.
  doc.transact(() => doc.getArray('cells').delete(0, doc.getArray('cells').length), 'server')
  const lecture = book(doc, 'lecture.ipynb', ['# Лекция', 'import numpy as np'])
  const seminar = book(doc, 'seminar.ipynb', ['# Семинар', 'df.head()'])

  const info = publishInfo(id)!
  const offered = info.notebooks.map((n) => [n.path, n.name, n.picked, n.why])
  // Offered lecture first, then the seminar, then the rest — not in the order
  // the files happened to be opened in the room.
  assert.deepEqual(offered, [
    ['lecture.ipynb', 'Лекция', true, null],
    ['seminar.ipynb', 'Семинар', true, null],
    ['Тетрадь.ipynb', 'Тетрадь', false, 'empty'],
  ])

  const built = ok(
    await buildAndWrite(
      id,
      {
        notebooks: [
          { root: seminar, name: 'Семинар' },
          { root: lecture, name: 'Лекция' },
        ],
        files: [],
        autoRefresh: true,
        ack: [],
      },
      { by: 'Ада' },
    ),
  )
  const materials = listMaterials(built.publication.id)
  assert.deepEqual(
    materials.map((m) => [m.key, m.kind, m.name, m.path]),
    [
      ['seminar', 'notebook', 'Семинар', 'seminar.ipynb'],
      ['lecture', 'notebook', 'Лекция', 'lecture.ipynb'],
    ],
  )
  assert.equal(materials[0].cellCount, 2)
  assert.equal(materials[0].outputCount, 1)
  assert.deepEqual(materials[0].outline, [{ id: materials[0].outline[0].id, level: 1, text: 'Семинар' }])
  const cells = JSON.parse(materialCellsText(built.publication.id, 'seminar')!) as PublicCell[]
  assert.equal(cells[1].outputs[0].kind, 'stream')
  // The rollback step is the first notebook on the page.
  const step = readStep(built.publication.id, 0)
  assert.equal(step?.cells.length, 2)
  assert.equal(step?.cells[0].source, '# Семинар')
  assert.deepEqual(built.page.materials.map((m) => m.key), ['seminar', 'lecture'])
})

test('a student’s own notebook is offered unticked, with its owner', () => {
  const id = 'books-student'
  const doc = room(id)
  book(doc, 'seminar.ipynb', ['print(1)'])
  const own = book(doc, 'Мой черновик.ipynb', ['print(2)'])
  setRules(id, {
    ...OPEN_ROOM,
    books: { [own]: { access: 'owner', owner: 'p_zuev', ownerName: 'Зуев Аким' } },
  })
  const choice = publishInfo(id)!.notebooks.find((n) => n.root === own)!
  assert.equal(choice.picked, false)
  assert.equal(choice.why, 'student')
  assert.equal(choice.owner, 'Зуев Аким')
})

test('a notebook named after a student is offered unticked even without an owner record', () => {
  const id = 'books-roster'
  const doc = room(id)
  upsertParticipant({ id: 'p_zuev', sessionId: id, name: 'Зуев Аким', avatar: null, role: 'participant' })
  upsertParticipant({ id: 'p_host', sessionId: id, name: 'Ада Лавлейс', avatar: null, role: 'host' })
  const zuev = book(doc, 'ZuevAkim_02.ipynb', ['print(1)'])
  const ada = book(doc, 'ada_lavleys.ipynb', ['print(2)'])
  const info = publishInfo(id)!
  assert.deepEqual(
    [info.notebooks.find((n) => n.root === zuev)?.why, info.notebooks.find((n) => n.root === zuev)?.picked],
    ['roster', false],
  )
  // The host's name is not a student's.
  assert.equal(info.notebooks.find((n) => n.root === ada)?.picked, true)
})

test('a notebook removed from the room never appears, though its cells stay in the document', () => {
  const id = 'books-orphan'
  const doc = room(id)
  book(doc, 'seminar.ipynb', ['print(1)'])
  doc.transact(() => {
    doc.getArray('nb:b_orphanroot1').push([createCell('code', 'secret = 1')])
  }, 'server')
  const info = publishInfo(id)!
  assert.ok(!info.notebooks.some((n) => n.root === 'nb:b_orphanroot1'))
})

test('an unknown notebook is refused in words, and so is an empty request', async () => {
  const id = 'books-refused'
  const doc = room(id)
  book(doc, 'seminar.ipynb', ['print(1)'])
  const unknown = await buildAndWrite(
    id,
    { notebooks: [{ root: 'nb:b_nosuchbook', name: '' }], files: [], autoRefresh: true, ack: [] },
    { by: null },
  )
  assert.equal(unknown.ok, false)
  assert.equal(!unknown.ok && unknown.status, 400)
  const nothing = { notebooks: [], files: [], autoRefresh: true, ack: [] }
  const empty = await buildAndWrite(id, nothing, { by: null })
  assert.equal(!empty.ok && empty.status, 400)
})

test('a refresh publishes the saved pick: a notebook added since is offered as new, not picked up', async () => {
  const id = 'books-refresh'
  const doc = room(id)
  const seminar = book(doc, 'seminar.ipynb', ['print(1)'])
  const first = ok(
    await buildAndWrite(
      id,
      { notebooks: [{ root: seminar, name: 'Семинар' }], files: [], autoRefresh: true, ack: [] },
      { by: 'Ада' },
    ),
  )
  const extra = book(doc, 'extra.ipynb', ['print(3)'])
  const again = ok(await refreshPage(id, { by: 'Ада' }))
  assert.equal(again.publication.id, first.publication.id, 'a refresh issued a new address')
  assert.equal(again.publication.revision, first.publication.revision + 1)
  assert.equal(again.publication.firstAt, first.publication.firstAt)
  assert.deepEqual(listMaterials(again.publication.id).map((m) => m.key), ['seminar'])

  const info = publishInfo(id)!
  const added = info.notebooks.find((n) => n.root === extra)!
  assert.equal(added.isNew, true)
  assert.equal(added.picked, false)
  assert.equal(info.notebooks.find((n) => n.root === seminar)?.picked, true)
  assert.equal(info.notebooks.find((n) => n.root === seminar)?.isNew, false)
})

test('a refresh without a saved pick is refused', async () => {
  const id = 'books-no-pick'
  room(id)
  const result = await refreshPage(id, { by: null })
  assert.deepEqual(result, { ok: false, status: 409, error: 'no selection' })
})

test('a removal while a build is in flight is not undone by it', async () => {
  /*
   * A build yields between files and then commits the list and pick it
   * computed at its start. A removal that committed in between came back
   * with that commit, and every later refresh kept publishing it.
   */
  const id = 'books-race'
  const doc = room(id)
  const lecture = book(doc, 'lecture.ipynb', ['print(1)'])
  const answers = book(doc, 'answers.ipynb', ['print(42)'])
  const pick = {
    notebooks: [
      { root: lecture, name: 'Лекция' },
      { root: answers, name: 'Ответы' },
    ],
    // A file, so the build yields (materials.ts · pause) between its start and its commit.
    files: [{ path: 'gone.csv', name: '' }],
    autoRefresh: true,
    ack: [],
  }
  const first = ok(await buildAndWrite(id, pick, { by: 'Ада' }))
  assert.deepEqual(listMaterials(first.publication.id).map((m) => m.key), ['lecture', 'answers'])

  // The bell's refresh is building; another tab takes the answers off meanwhile.
  const building = refreshPage(id, { by: null })
  const removing = removeMaterial(first.publication.id, 'answers')
  const [built, removed] = await Promise.all([building, removing])
  ok(built)
  assert.ok(removed.ok, JSON.stringify(removed))
  assert.deepEqual(listMaterials(first.publication.id).map((m) => m.key), ['lecture'])
  assert.deepEqual(publicationOf(id)!.selection!.notebooks.map((n) => n.name), ['Лекция'])

  // And a refresh queued behind the removal rebuilds from the pick it left.
  const again = ok(await refreshPage(id, { by: null }))
  assert.deepEqual(listMaterials(again.publication.id).map((m) => m.key), ['lecture'])
})

test('the room-door setting saved during a build survives it', async () => {
  const id = 'books-door'
  const doc = room(id)
  const seminar = book(doc, 'seminar.ipynb', ['print(1)'])
  const pick = {
    notebooks: [{ root: seminar, name: 'Семинар' }],
    files: [{ path: 'gone.csv', name: '' }],
    autoRefresh: true,
    ack: [],
  }
  const first = ok(await buildAndWrite(id, pick, { by: 'Ада' }))
  assert.equal(first.publication.selection?.roomAccess, 'anyone')
  const building = refreshPage(id, { by: null })
  const saving = setRoomAccess(first.publication.id, 'none')
  const [built, saved] = await Promise.all([building, saving])
  ok(built)
  assert.ok(saved.ok)
  assert.equal(publicationOf(id)!.selection?.roomAccess, 'none')
  // A later refresh keeps it too: it reads the setting at commit time.
  ok(await refreshPage(id, { by: null }))
  assert.equal(publicationOf(id)!.selection?.roomAccess, 'none')
})
