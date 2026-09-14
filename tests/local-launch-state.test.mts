import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireLock, readReceipt, writeJson } from '../cli/src/launch-state.js'

test('launch lock excludes a second owner, reclaims a dead owner and never removes a replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'colloq-launch-lock-')),
    file = join(root, 'lock')
  try {
    const release = acquireLock(file, 42, 'first', () => true)
    assert.throws(() => acquireLock(file, 43, 'second', () => true), /уже/)
    writeJson(file, { pid: 44, runId: 'replacement' })
    release()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).runId, 'replacement')
    const next = acquireLock(file, 45, 'last', () => false)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 45)
    next()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('malformed receipts cannot identify a running session', () => {
  const root = mkdtempSync(join(tmpdir(), 'colloq-launch-receipt-')),
    file = join(root, 'receipt')
  try {
    writeFileSync(file, '{"pid":1}')
    assert.equal(readReceipt(file), null)
    writeFileSync(file, 'not json')
    assert.equal(readReceipt(file), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
