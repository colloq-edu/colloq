import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const helper = fileURLToPath(new URL('../scripts/state-lock.py', import.meta.url))
test('operation lock excludes competing actions and remains held across nested launchers', async () => {
  const state = mkdtempSync(path.join(tmpdir(), 'colloq-lock-'))
  const child = spawn(
    'python3',
    [
      helper,
      'run',
      '--state',
      state,
      '--',
      'python3',
      '-u',
      '-c',
      `import os, subprocess, sys
r=subprocess.run([sys.executable,sys.argv[1],'run','--state',sys.argv[2],'--',sys.executable,sys.argv[1],'held','--state',sys.argv[2]],close_fds=False)
assert r.returncode==0
print('ready',flush=True)
sys.stdin.readline()`,
      helper,
      state,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => {
        if (String(d).includes('ready')) resolve()
      })
      child.once('exit', (code) => reject(new Error(`lock holder exited ${code}`)))
      child.stderr.on('data', (d) => reject(new Error(String(d))))
    })
    const competing = spawnSync(
      'python3',
      [helper, 'run', '--state', state, '--', 'python3', '-c', 'print("must not run")'],
      { encoding: 'utf8' },
    )
    assert.notEqual(competing.status, 0)
    assert.equal(competing.stdout.includes('must not run'), false)
    child.stdin.end('\n')
    await new Promise((r) => child.once('exit', r))
    assert.equal(
      spawnSync('python3', [helper, 'run', '--state', state, '--', 'python3', '-c', 'pass']).status,
      0,
    )
  } finally {
    child.kill()
    rmSync(state, { recursive: true, force: true })
  }
})
test('an environment variable alone cannot impersonate the inherited lock', () => {
  const state = mkdtempSync(path.join(tmpdir(), 'colloq-lock-'))
  try {
    assert.notEqual(
      spawnSync('python3', [helper, 'held', '--state', state], {
        env: { ...process.env, COLLOQ_STATE_LOCK_FD: '9' },
      }).status,
      0,
    )
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
