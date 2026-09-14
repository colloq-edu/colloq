import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('SIGINT sent to the CLI reaches its delegated process before the wrapper exits', { timeout: 10000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const fixture = mkdtempSync(join(tmpdir(), 'colloq-signal-'))
  cpSync(join(root, 'cli'), join(fixture, 'cli'), { recursive: true })
  writeFileSync(join(fixture, 'package.json'), '{"name":"colloq","type":"module"}')
  writeFileSync(join(fixture, 'Makefile'), 'hold:\n')
  mkdirSync(join(fixture, 'bin'))
  writeFileSync(join(fixture, 'bin', 'make'),
    '#!/bin/sh\nexec "$COLLOQ_TEST_NODE" -e \'console.log(process.pid); setInterval(() => {}, 1000)\'\n',
    { mode: 0o755 })
  const cli = spawn(process.execPath, ['--import', 'tsx', join(fixture, 'cli/src/main.ts'), 'make', 'hold'], {
    cwd: root,
    env: { ...process.env, COLLOQ_TEST_NODE: process.execPath, PATH: join(fixture, 'bin') + ':' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childPid: number | undefined
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    cli.once('exit', (code, signal) => resolve({ code, signal })))
  try {
    childPid = await new Promise<number>((resolve, reject) => {
      let output = ''
      cli.stdout.on('data', (chunk) => {
        output += chunk.toString()
        if (output.includes('\n')) resolve(Number(output.trim()))
      })
      cli.once('error', reject)
      cli.once('exit', () => reject(new Error('CLI exited before its child started')))
    })
    assert.ok(Number.isInteger(childPid) && childPid > 0)
    cli.kill('SIGINT')
    assert.deepEqual(await exited, { code: 130, signal: null })
    assert.throws(() => process.kill(childPid!, 0), { code: 'ESRCH' }, 'the delegated process must have stopped')
  } finally {
    if (childPid) {
      try { process.kill(childPid, 'SIGKILL') } catch { /* already stopped */ }
    }
    cli.kill('SIGKILL')
    await exited
    rmSync(fixture, { recursive: true, force: true })
  }
})
