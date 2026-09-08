import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
test('Vast up refuses missing explicit release before account access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-vast-guard-'))
  try {
    fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'bin'))
    for (const file of ['vast.sh', 'lib.sh']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(dir, 'scripts', file))
    fs.writeFileSync(path.join(dir, '.env'), 'VAST_TOKEN=test-only\n')
    fs.writeFileSync(path.join(dir, 'bin/curl'), '#!/bin/sh\necho ACCOUNT_ACCESSED >&2\nexit 99\n', { mode: 0o755 })
    const result = spawnSync('bash', ['scripts/vast.sh', 'up'], { cwd: dir, encoding: 'utf8', env: { ...process.env, RELEASE: '', PATH: path.join(dir, 'bin') + ':' + process.env.PATH } })
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /RELEASE=/); assert.doesNotMatch(result.stdout + result.stderr, /ACCOUNT_ACCESSED/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('Vast deployment keeps VM safeguards and deploys only the release commit artifact', () => {
  const script = fs.readFileSync(path.join(repo, 'scripts/vast.sh'), 'utf8')
  assert.match(script, /"vms_enabled": \{"eq": True\}/); assert.match(script, /"vm": True/); assert.match(script, /"type": "ondemand"/)
  assert.match(script, /git archive/); assert.match(script, /sourceCommit/)
  assert.doesNotMatch(script, /rsync -az --delete/); assert.doesNotMatch(script, /^make service-install$/m)
  assert.match(script, /runtime-backup\.py validate/)
})
test('registry credentials and anonymous-pull declaration are checked before account access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-registry-guard-'))
  try {
    fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'bin'))
    for (const file of ['vast.sh', 'lib.sh']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(dir, 'scripts', file))
    fs.writeFileSync(path.join(dir, '.env'), 'VAST_TOKEN=test-only\n'); fs.writeFileSync(path.join(dir, 'release.json'), '{}')
    fs.writeFileSync(path.join(dir, 'bin/curl'), '#!/bin/sh\necho ACCOUNT_ACCESSED >&2\nexit 99\n', { mode: 0o755 })
    const env = { ...process.env, RELEASE: path.join(dir, 'release.json'), VAST_REGISTRY_CONFIG: '', VAST_PUBLIC_IMAGES: '', VAST_REGISTRY_READ_ONLY: '', PATH: path.join(dir, 'bin') + ':' + process.env.PATH }
    let r = spawnSync('bash', ['scripts/vast.sh', 'up'], { cwd: dir, encoding: 'utf8', env })
    assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /VAST_PUBLIC_IMAGES/); assert.doesNotMatch(r.stdout + r.stderr, /ACCOUNT_ACCESSED/)
    const registry = path.join(dir, 'registry.json'); fs.writeFileSync(registry, JSON.stringify({ auths: {}, credsStore: 'desktop' }))
    r = spawnSync('bash', ['scripts/vast.sh', 'up', '--registry-config', registry], { cwd: dir, encoding: 'utf8', env: { ...env, VAST_REGISTRY_READ_ONLY: '1' } })
    assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /registry config/i); assert.doesNotMatch(r.stdout + r.stderr, /ACCOUNT_ACCESSED/)
    fs.writeFileSync(registry, JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from('user:never-log-this-password').toString('base64') } } }))
    r = spawnSync('bash', ['scripts/vast.sh', 'up', '--registry-config', registry], { cwd: dir, encoding: 'utf8', env })
    assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /VAST_REGISTRY_READ_ONLY/); assert.doesNotMatch(r.stdout + r.stderr, /never-log-this-password|ACCOUNT_ACCESSED/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
