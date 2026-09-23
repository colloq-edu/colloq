import './_env.mts'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Y from 'yjs'
import { createSession, db, loadDocSnapshot } from '../server/src/db.js'
import { config } from '../server/src/config.js'
import * as persistence from '../server/src/collab/persistence.js'

function diagnostics() {
  assert.equal(typeof (persistence as any).persistenceDiagnostics, 'function', 'persistence must expose aggregate durability diagnostics')
  return (persistence as any).persistenceDiagnostics() as {
    documents: number; dirtyDocuments: number; oldestUnsavedMs: number; saveFailures: number; lastFailureAt: number | null
  }
}

test('diagnostics show pending edits, failed snapshot age and successful recovery without identifiers', () => {
  const baseline = diagnostics()
  mock.timers.enable({apis:['Date','setTimeout'],now:10_000})
  const logging = mock.method(console, 'error', () => {})
  const a = new Y.Doc(), b = new Y.Doc()
  createSession('durability-a', 'Private room title', null)
  createSession('durability-b', 'Another private title', null)
  const disposeA = persistence.bindPersistence('durability-a', a)
  const disposeB = persistence.bindPersistence('durability-b', b)
  try {
    a.getText('private-content').insert(0, 'must never appear in diagnostics')
    mock.timers.tick(25)
    b.getText('private-content').insert(0, 'second edit')
    assert.deepEqual(diagnostics(), {...baseline,documents:baseline.documents+2,dirtyDocuments:2,oldestUnsavedMs:25})
    db.pragma('query_only = ON')
    persistence.flushPersistence('durability-a')
    db.pragma('query_only = OFF')
    const failed = diagnostics()
    assert.equal(failed.saveFailures, baseline.saveFailures + 1)
    assert.equal(failed.lastFailureAt, 10_025)
    assert.equal(failed.dirtyDocuments, 2)
    assert.equal(failed.oldestUnsavedMs, 25)
    assert.equal(loadDocSnapshot('durability-a'), null)
    assert.deepEqual(Object.keys(failed).sort(), ['dirtyDocuments','documents','lastFailureAt','oldestUnsavedMs','saveFailures'])
    persistence.flushPersistence('durability-a')
    assert.equal(diagnostics().dirtyDocuments, 1)
    persistence.flushPersistence('durability-b')
    assert.deepEqual(diagnostics(), {...failed,dirtyDocuments:0,oldestUnsavedMs:0})
  } finally {
    db.pragma('query_only = OFF')
    disposeA(); disposeB(); a.destroy(); b.destroy()
    logging.mock.restore(); mock.timers.reset()
  }
  assert.equal(diagnostics().documents, baseline.documents)
})

test('one failed tail save counts once and retains age until its scheduled retry succeeds', () => {
  const baseline = diagnostics()
  mock.timers.enable({apis:['Date','setTimeout'],now:20_000})
  const logging = mock.method(console, 'error', () => {})
  const doc = new Y.Doc()
  createSession('durability-tail', 'Private tail', null)
  const dispose = persistence.bindPersistence('durability-tail', doc)
  let fail = true
  const rename = fs.renameSync
  const fault = mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (fail && String(args[1]).includes('/doc-tail/')) throw Object.assign(new Error('test EIO'), {code:'EIO'})
    return rename(...args)
  })
  try {
    doc.getText('text').insert(0, 'before')
    persistence.flushPersistence('durability-tail')
    doc.getText('text').insert(6, ' after')
    mock.timers.tick(config.snapshotIntervalMs)
    const failed = diagnostics()
    assert.equal(failed.saveFailures, baseline.saveFailures + 1)
    assert.equal(failed.dirtyDocuments, 1)
    assert.equal(failed.oldestUnsavedMs, config.snapshotIntervalMs)
    assert.equal(failed.lastFailureAt, Date.now())
    fail = false
    mock.timers.tick(5000)
    assert.deepEqual(diagnostics(), {...failed,dirtyDocuments:0,oldestUnsavedMs:0})
  } finally {
    fault.mock.restore(); dispose(); doc.destroy()
    logging.mock.restore(); mock.timers.reset()
  }
})

test('failed tail compaction records settle and explicit-flush failures without claiming durable data is dirty', () => {
  const baseline = diagnostics()
  mock.timers.enable({apis:['Date','setTimeout'],now:30_000})
  const logging = mock.method(console, 'error', () => {})
  const doc = new Y.Doc()
  createSession('durability-settle', 'Private compaction', null)
  const dispose = persistence.bindPersistence('durability-settle', doc)
  try {
    doc.getText('text').insert(0, 'before')
    persistence.flushPersistence('durability-settle')
    doc.getText('text').insert(6, ' after')
    mock.timers.tick(config.snapshotIntervalMs)
    assert.equal(diagnostics().dirtyDocuments, 0)
    db.pragma('query_only = ON')
    mock.timers.tick(10_000)
    assert.equal(diagnostics().saveFailures, baseline.saveFailures + 1)
    assert.equal(diagnostics().dirtyDocuments, 0, 'the tail already contains all edits')
    persistence.flushPersistence('durability-settle')
    assert.equal(diagnostics().saveFailures, baseline.saveFailures + 2)
    assert.equal(diagnostics().lastFailureAt, Date.now())
    db.pragma('query_only = OFF')
    persistence.flushPersistence('durability-settle')
    const recovered = new Y.Doc()
    Y.applyUpdate(recovered, loadDocSnapshot('durability-settle')!)
    assert.equal(recovered.getText('text').toString(), 'before after')
    recovered.destroy()
  } finally {
    db.pragma('query_only = OFF'); dispose(); doc.destroy()
    logging.mock.restore(); mock.timers.reset()
  }
})
