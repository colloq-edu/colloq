import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
const script = new URL('../scripts/cluster.sh', import.meta.url).pathname
const manifest = () => ({ schemaVersion: 1, version: 'v1', sourceCommit: 'a'.repeat(40), k3sVersion: 'v1.34.1+k3s1',
  appImage: 'registry.example/app@sha256:' + 'b'.repeat(64), runtimeImage: 'registry.example/runtime@sha256:' + 'c'.repeat(64),
  dataSchemaVersion: 1, compatibleDataSchemaVersions: [1], catalog: { schemaVersion: 1, release: 'v1', defaultEnvironment: 'base',
    environments: [{ name: 'base', image: 'registry.example/kernel@sha256:' + 'd'.repeat(64), gpu: false }] } })
test('install, prepare and update reject missing explicit release before host operations', () => {
  for (const command of ['install', 'prepare', 'update', 'rollback']) {
    const result = spawnSync('bash', [script, command], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /explicit.*release|release.*required/i)
  }
})
test('incomplete restore blocks starts and publication before any host command', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-restore-guard-'))
  try {
    fs.writeFileSync(path.join(state, '.restore-in-progress'), 'durable recovery marker')
    const release = path.join(state, 'release.json'); fs.writeFileSync(release, JSON.stringify(manifest()))
    for (const args of [['start'], ['public-url', 'https://example.invalid'], ['smoke'], ['gpu-preflight'],
      ...['prepare', 'install', 'update', 'rollback'].map(cmd => [cmd, '--release', release])]) {
      const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, COLLOQ_STATE_DIR: state } })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /restore.*progress|incomplete.*restore/i)
      assert.equal(fs.existsSync(path.join(state, '.operation.lock')), false)
    }
  } finally { fs.rmSync(state, { recursive: true, force: true }) }
})
test('all cluster writer mutations contend on the shared operation lock before kubernetes calls', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-lock-guard-'))
  try {
    const bin = path.join(state, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'k3s'), '#!/bin/sh\necho unexpected-kubernetes-call >&2\nexit 91\n', { mode: 0o755 })
    const env = { ...process.env, COLLOQ_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` }
    const bundle = path.join(state, 'bundle'); fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true })
    const hashes: Record<string, string> = {}
    for (const file of ['cluster.sh', 'release.py', 'state-lock.py', 'backup.sh', 'runtime-backup.py', 'restore.sh', 'host.sh', 'lib.sh']) {
      const bytes = fs.readFileSync(new URL('../scripts/' + file, import.meta.url))
      fs.writeFileSync(path.join(bundle, 'scripts', file), bytes)
      hashes[`scripts/${file}`] = createHash('sha256').update(bytes).digest('hex')
    }
    const release = path.join(bundle, 'release.json')
    fs.writeFileSync(release, JSON.stringify({ ...manifest(), tooling: { sourceFiles: hashes } }))
    const entry = path.join(bundle, 'scripts/cluster.sh')
    // This parent holds the actual lock while the child deliberately receives no
    // inherited descriptor. Every cluster mutation must fail before invoking k3s.
    const code = 'import fcntl,os,subprocess,sys; f=open(os.path.join(sys.argv[1],".operation.lock"),"w"); fcntl.flock(f,fcntl.LOCK_EX); r=subprocess.run(["bash",sys.argv[2],*sys.argv[3:]],capture_output=True,text=True); print(r.stderr,end=""); sys.exit(r.returncode)'
    for (const args of [['start'], ['stop'], ['public-url', 'https://example.invalid'], ['smoke'], ['gpu-preflight'],
      ...['prepare', 'install', 'update', 'rollback'].map(cmd => [cmd, '--release', release])]) {
      const result = spawnSync('python3', ['-c', code, state, entry, ...args], { encoding: 'utf8', env })
      assert.notEqual(result.status, 0)
      assert.match(result.stdout, /operation lock.*active/)
      assert.doesNotMatch(result.stdout, /unexpected-kubernetes-call/)
    }
  } finally { fs.rmSync(state, { recursive: true, force: true }) }
})
test('start consumes restored schema metadata before permitting the first application writer', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-start-order-'))
  try {
    const bin = path.join(state, 'bin'); fs.mkdirSync(bin)
    for (const [name, body] of Object.entries({ uname: 'echo Linux', id: 'echo 0', curl: 'exit 0',
      k3s: 'case "$*" in *"scale deployment/colloq-app --replicas=1"*) test ! -e "$COLLOQ_STATE_DIR/recovery/release.json" || exit 91;; esac\nexit 0' })) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    }
    fs.mkdirSync(path.join(state, 'releases')); fs.mkdirSync(path.join(state, 'recovery'))
    fs.writeFileSync(path.join(state, 'releases/current.json'), JSON.stringify(manifest()))
    fs.writeFileSync(path.join(state, 'recovery/release.json'), JSON.stringify(manifest()))
    const result = spawnSync('bash', [script, 'start'], { encoding: 'utf8', env: { ...process.env, COLLOQ_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.existsSync(path.join(state, 'recovery/release.json')), false)
    assert.equal(fs.existsSync(path.join(state, 'recovery/applied-release.json')), true)
  } finally { fs.rmSync(state, { recursive: true, force: true }) }
})
test('make restore forwards the portable archive and release as distinct quoted arguments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-make-restore-'))
  try {
    fs.copyFileSync(new URL('../Makefile', import.meta.url), path.join(dir, 'Makefile'))
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.writeFileSync(path.join(dir, 'scripts/restore.sh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const result = spawnSync('make', ['--no-print-directory', 'restore', 'ARCHIVE=backup with spaces.tar.gz',
      'RELEASE=release with spaces.json', 'REPLACE=1'], { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split('\n'), ['--archive', 'backup with spaces.tar.gz', '--release', 'release with spaces.json', '--replace'])
    const missing = spawnSync('make', ['--no-print-directory', 'restore'], { cwd: dir, encoding: 'utf8' })
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /ARCHIVE/)
    const legacy = spawnSync('make', ['--no-print-directory', 'restore-legacy', 'DB=old.db', 'FILES=old-files.tar.gz'], { cwd: dir, encoding: 'utf8' })
    assert.equal(legacy.status, 0, legacy.stderr)
    assert.deepEqual(legacy.stdout.trim().split('\n'), ['old.db', 'old-files.tar.gz'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('restore Service reset requires completed file replacement and confirmed absent writers', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-service-reset-'))
  try {
    const bin = path.join(state, 'bin'); fs.mkdirSync(bin)
    for (const [name, body] of Object.entries({ uname: 'echo Linux', id: 'echo 0',
      k3s: 'case "$*" in *"get pods"*) if [ "$PROOF_API_FAIL" = 1 ]; then exit 71; fi; if [ "$PROOF_WRITER" = 1 ]; then echo pod/active; fi;; *"delete services"*) touch "$COLLOQ_STATE_DIR/deleted";; esac\nexit 0' })) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    }
    const env = { ...process.env, COLLOQ_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` }
    const run = (extra = {}) => spawnSync('bash', [script, 'restore-services'], { encoding: 'utf8', env: { ...env, ...extra } })
    assert.notEqual(run().status, 0)
    fs.writeFileSync(path.join(state, '.restore-in-progress'), JSON.stringify({ phase: 'files-restored' }))
    assert.notEqual(run({ PROOF_API_FAIL: '1' }).status, 0)
    assert.equal(fs.existsSync(path.join(state, 'deleted')), false)
    assert.notEqual(run({ PROOF_WRITER: '1' }).status, 0)
    assert.equal(fs.existsSync(path.join(state, 'deleted')), false)
    assert.equal(run().status, 0)
    assert.equal(fs.existsSync(path.join(state, 'deleted')), true)
    assert.equal(fs.existsSync(path.join(state, '.restore-in-progress')), true)
  } finally { fs.rmSync(state, { recursive: true, force: true }) }
})

test('cluster commands use the bundled client with the managed kubeconfig and no extra kubectl argument', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-client-context-'))
  try {
    const bin = path.join(state, 'bin'); fs.mkdirSync(bin)
    for (const [name, body] of Object.entries({uname:'echo Linux',id:'echo 0',curl:'exit 0',
      k3s:'test "$KUBECONFIG" = /etc/rancher/k3s/k3s.yaml || exit 92\n[ "$1" != kubectl ] || exit 93\nprintf "%s\\n" "$*"'})) {
      fs.writeFileSync(path.join(bin,name), `#!/bin/sh\n${body}\n`, {mode:0o755})
    }
    const result=spawnSync('bash',[script,'status'],{encoding:'utf8',env:{...process.env,
      KUBECONFIG:'/unrelated/operator-cluster',COLLOQ_STATE_DIR:state,PATH:`${bin}:${process.env.PATH}`}})
    assert.equal(result.status,0,result.stderr)
    assert.match(result.stdout,/-n colloq get deployments,pods,pvc/)
  } finally { fs.rmSync(state,{recursive:true,force:true}) }
})

/**
 * `public-url --if-current`: only whoever set the address may take it down.
 *
 * On exit scripts/host.sh gives the cluster back localhost. Without a check,
 * its cleanup overwrote an address someone else had set in the meantime, and
 * a live link silently turned into localhost. The check sits in cluster.sh,
 * under the state lock next to the write, and is tested here against the real
 * script.
 */
test('public-url --if-current changes the address only while it is still the expected one', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-public-url-cas-'))
  try {
    const bin = path.join(state, 'bin'); fs.mkdirSync(bin)
    const calls = path.join(state, 'k3s-calls')
    for (const [name, body] of Object.entries({ uname: 'echo Linux', id: 'echo 0',
      k3s: `printf '%s\\n' "$*" >> '${calls}'\ncase "$*" in *apply*) cat >/dev/null;; *jsonpath*) echo 1;; esac\nexit 0` })) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    }
    fs.mkdirSync(path.join(state, 'releases'))
    fs.writeFileSync(path.join(state, 'releases/current.json'), JSON.stringify(manifest()))
    const config = path.join(state, 'config.env')
    fs.writeFileSync(config, 'INSTITUTION=Test\nPUBLIC_URL=https://someone-else.example\n')
    const env = { ...process.env, COLLOQ_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` }
    const run = (...args: string[]) => spawnSync('bash', [script, 'public-url', ...args], { encoding: 'utf8', env })

    // Someone else's address: refused with a distinct exit code, the file and
    // the cluster untouched.
    let r = run('http://127.0.0.1:30080', '--if-current', 'https://tunnel.example')
    assert.equal(r.status, 4, r.stderr)
    assert.match(r.stderr, /no longer https:\/\/tunnel\.example/)
    assert.match(fs.readFileSync(config, 'utf8'), /^PUBLIC_URL=https:\/\/someone-else\.example$/m)
    assert.equal(fs.existsSync(calls), false, 'mismatch must not touch the cluster')

    // Our own address: the write, the config into the cluster, an app restart.
    fs.writeFileSync(config, 'INSTITUTION=Test\nPUBLIC_URL=https://tunnel.example\n')
    r = run('http://127.0.0.1:30080', '--if-current', 'https://tunnel.example')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(fs.readFileSync(config, 'utf8').split('\n').filter(l => l.startsWith('PUBLIC_URL=')), ['PUBLIC_URL=http://127.0.0.1:30080'])
    assert.match(fs.readFileSync(config, 'utf8'), /^INSTITUTION=Test$/m)
    assert.match(fs.readFileSync(calls, 'utf8'), /rollout restart deployment\/colloq-app/)

    // Repeating the same cleanup is neither a refusal nor a second restart: the
    // address is already the right one.
    const before = fs.readFileSync(calls, 'utf8')
    r = run('http://127.0.0.1:30080', '--if-current', 'https://tunnel.example')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(fs.readFileSync(calls, 'utf8'), before)
  } finally { fs.rmSync(state, { recursive: true, force: true }) }
})

/*
 * Room memory for the broker comes from the operator's file, not from editing
 * the Deployment.
 *
 * `render` shows exactly what prepare will install: the new --env-file,
 * otherwise the kept config.env. `update` checks these numbers BEFORE the
 * backup: the backup already stops the rooms, and a bad number surfacing after
 * it would cost the class its variables for nothing — or drop the broker into
 * CrashLoop.
 */
test('cluster render carries the broker memory from --env-file or the kept config.env', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runtime-env-'))
  try {
    const release = path.join(state, 'release.json'); fs.writeFileSync(release, JSON.stringify(manifest()))
    const env = { ...process.env, COLLOQ_STATE_DIR: state }
    const brokerEnv = (stdout: string) => Object.fromEntries(JSON.parse(stdout).items
      .find((x: any) => x.kind === 'Deployment' && x.metadata.name === 'colloq-runtime')
      .spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]))
    fs.writeFileSync(path.join(state, 'config.env'), 'PUBLIC_URL=https://x.example\nRUNTIME_KERNEL_MEMORY=3Gi\n')
    let r = spawnSync('bash', [script, 'render', '--release', release], { encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(brokerEnv(r.stdout).RUNTIME_KERNEL_MEMORY, '3Gi')
    const next = path.join(state, 'next.env'); fs.writeFileSync(next, 'RUNTIME_KERNEL_MEMORY=5Gi\nRUNTIME_KERNEL_MEMORY_MAX=20Gi\n')
    r = spawnSync('bash', [script, 'render', '--release', release, '--env-file', next], { encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(brokerEnv(r.stdout).RUNTIME_KERNEL_MEMORY, '5Gi')
    assert.equal(brokerEnv(r.stdout).RUNTIME_KERNEL_MEMORY_MAX, '20Gi')
    fs.writeFileSync(next, 'RUNTIME_KERNEL_MEMORY=5GB\n')
    r = spawnSync('bash', [script, 'render', '--release', release, '--env-file', next], { encoding: 'utf8', env })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /RUNTIME_KERNEL_MEMORY must be a Kubernetes quantity/)
  } finally { fs.rmSync(state, { recursive: true, force: true }) }
})
test('update refuses unusable broker memory before the backup stops any room', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runtime-env-update-'))
  try {
    const bin = path.join(state, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'k3s'), '#!/bin/sh\necho unexpected-kubernetes-call >&2\nexit 91\n', { mode: 0o755 })
    const bundle = path.join(state, 'bundle'); fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true })
    const hashes: Record<string, string> = {}
    for (const file of ['cluster.sh', 'release.py', 'state-lock.py', 'backup.sh', 'runtime-backup.py', 'restore.sh', 'host.sh', 'lib.sh']) {
      const bytes = fs.readFileSync(new URL('../scripts/' + file, import.meta.url))
      fs.writeFileSync(path.join(bundle, 'scripts', file), bytes, { mode: 0o755 })
      hashes[`scripts/${file}`] = createHash('sha256').update(bytes).digest('hex')
    }
    const release = path.join(bundle, 'release.json')
    fs.writeFileSync(release, JSON.stringify({ ...manifest(), tooling: { sourceFiles: hashes } }))
    fs.mkdirSync(path.join(state, 'releases'))
    fs.writeFileSync(path.join(state, 'releases/current.json'), JSON.stringify(manifest()))
    fs.writeFileSync(path.join(state, 'config.env'), 'RUNTIME_KERNEL_MEMORY=8Gi\nRUNTIME_KERNEL_MEMORY_MAX=4Gi\n')
    const r = spawnSync('bash', [path.join(bundle, 'scripts/cluster.sh'), 'update', '--release', release], { encoding: 'utf8',
      env: { ...process.env, COLLOQ_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` } })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /exceeds RUNTIME_KERNEL_MEMORY_MAX/)
    assert.doesNotMatch(r.stderr, /unexpected-kubernetes-call/)
    assert.equal(fs.existsSync(path.join(bundle, 'backups')), false, 'no backup may start before the check')
  } finally { fs.rmSync(state, { recursive: true, force: true }) }
})
