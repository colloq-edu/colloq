import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = new URL('..', import.meta.url).pathname
const required = ['cluster.sh', 'release.py', 'state-lock.py', 'backup.sh', 'runtime-backup.py', 'restore.sh', 'host.sh', 'lib.sh'].map(x => `scripts/${x}`)
const release = () => ({ schemaVersion: 1, version: 'v1', sourceCommit: 'a'.repeat(40), k3sVersion: 'v1.34.1+k3s1',
  appImage: 'registry.example/app@sha256:' + 'b'.repeat(64), runtimeImage: 'registry.example/runtime@sha256:' + 'c'.repeat(64),
  dataSchemaVersion: 1, compatibleDataSchemaVersions: [1], catalog: { schemaVersion: 1, release: 'v1', defaultEnvironment: 'base',
    environments: [{ name: 'base', image: 'registry.example/kernel@sha256:' + 'd'.repeat(64), gpu: false }] } })

test('archived build context excludes untracked inputs and uses committed content despite working-tree edits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-source-'))
  try {
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
    git('init', '-q'); fs.writeFileSync(path.join(repo, 'Dockerfile'), 'FROM committed\n')
    git('add', 'Dockerfile'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
    const commit = git('rev-parse', 'HEAD')
    fs.writeFileSync(path.join(repo, 'Dockerfile'), 'FROM dirty\n')
    fs.writeFileSync(path.join(repo, 'untracked.py'), 'unexpected input\n')
    const target = path.join(dir, 'archive')
    const code = 'import importlib.util,sys; s=importlib.util.spec_from_file_location("builder",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.archive_source(sys.argv[2],sys.argv[3],sys.argv[4])'
    const result = spawnSync('python3', ['-c', code, path.join(root, 'scripts/release-build.py'), repo, commit, target], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(path.join(target, 'Dockerfile'), 'utf8'), 'FROM committed\n')
    assert.equal(fs.existsSync(path.join(target, 'untracked.py')), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Git-less deployment tooling must match every hash in the selected release', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-tools-'))
  try {
    fs.mkdirSync(path.join(dir, 'scripts'))
    const hashes: Record<string, string> = {}
    for (const file of required) {
      const content = `archived ${file}\n`; fs.writeFileSync(path.join(dir, file), content)
      hashes[file] = createHash('sha256').update(content).digest('hex')
    }
    const file = path.join(dir, 'release.json')
    fs.writeFileSync(file, JSON.stringify({ ...release(), tooling: { sourceFiles: hashes } }))
    const run = () => spawnSync('python3', [path.join(root, 'scripts/release.py'), 'verify-tooling', '--release', file, '--tooling-root', dir], { encoding: 'utf8' })
    assert.equal(run().status, 0)
    fs.writeFileSync(path.join(dir, 'scripts/cluster.sh'), 'modified adjacent installer\n')
    assert.notEqual(run().status, 0); assert.match(run().stderr, /tooling|source/i)
    fs.writeFileSync(file, JSON.stringify(release()))
    assert.notEqual(run().status, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
