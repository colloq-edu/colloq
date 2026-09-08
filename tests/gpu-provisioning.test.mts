import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const source = fs.readFileSync(new URL('../scripts/cluster.sh', import.meta.url), 'utf8')
function shellFunction(name: string) {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))
  assert.ok(body, `missing ${name}`)
  return body[0]
}

function plugin(readyAfter: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-gpu-poll-'))
  try {
    const result = spawnSync('bash', ['-c', `set -euo pipefail
die() { echo "$*" >&2; exit 1; }
release() { if [ "$1" = field ]; then echo true; else echo '{}'; fi; }
kube() { if [ "$1" = apply ]; then cat >/dev/null; fi; }
k() {
  if [ "$2" = secret ]; then echo '{"metadata":{"name":"colloq-registry"}}'; return; fi
  local count=0
  [ ! -f "$POLL_FILE" ] || read -r count < "$POLL_FILE"
  count=$((count + 1)); echo "$count" > "$POLL_FILE"
  if [ "$count" -ge "$READY_AFTER" ]; then echo 2; fi
}
sleep() { SECONDS=$((SECONDS + $1)); }
${shellFunction('gpu_plugin')}
gpu_plugin release.json
`], { encoding: 'utf8', timeout: 5000, env: { ...process.env, POLL_FILE: path.join(dir, 'count'), READY_AFTER: String(readyAfter) } })
    assert.equal(result.error, undefined)
    return { ...result, polls: Number(fs.readFileSync(path.join(dir, 'count'), 'utf8')) }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('GPU provisioning waits for node registration after the plugin becomes ready', () => {
  const result = plugin(3)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.polls, 3)
})

test('GPU registration wait terminates when no GPU becomes allocatable', () => {
  const result = plugin(10000)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no allocatable GPU/)
  assert.ok(result.polls > 1 && result.polls <= 61, `bounded polling: ${result.polls}`)
})

test('newer toolkit packages fail before any package or repository mutation', () => {
  const result = spawnSync('bash', ['-c', `set -euo pipefail
RELEASE=release.json
die() { echo "$*" >&2; exit 1; }
release() { if [ "$5" = gpu ]; then echo true; else echo 1.20.0-1; fi; }
nvidia-smi() { :; }
dpkg-query() { echo 1.20.1-1; }
dpkg() { [ "$1" = --compare-versions ] && [ "$2" = 1.20.1-1 ] && [ "$3" = gt ] && [ "$4" = 1.20.0-1 ]; }
apt-get() { echo 'unexpected host mutation' >&2; exit 90; }
mkdir() { echo 'unexpected host mutation' >&2; exit 90; }
gpg() { echo 'unexpected host mutation' >&2; exit 90; }
${shellFunction('gpu_toolkit')}
gpu_toolkit
`], { encoding: 'utf8', timeout: 5000 })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, /unexpected host mutation/)
  assert.match(result.stderr, /nvidia-container-toolkit.*1\.20\.1-1.*newer.*1\.20\.0-1/)
  assert.match(result.stderr, /downgrade.*explicit|explicit.*downgrade/i)
})

function waitForNode(mode: 'ready' | 'missing' | 'multiple') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-node-poll-'))
  try {
    const node = (name: string, ready: string) => ({ metadata: { labels: { 'kubernetes.io/hostname': name } },
      status: { conditions: [{ type: 'Ready', status: ready }] } })
    const snapshots = [null, { items: [] }, { items: [node('test-node', 'False')] },
      { items: mode === 'multiple' ? [node('one', 'True'), node('two', 'True')] : [node('test-node', 'True')] }]
    snapshots.forEach((value, index) => fs.writeFileSync(path.join(dir, String(index + 1)), JSON.stringify(value)))
    const result = spawnSync('bash', ['-c', `set -euo pipefail
die() { echo "$*" >&2; exit 1; }
k() {
  case " $* " in *' --request-timeout=5s '*) ;; *) echo 'missing API timeout' >&2; exit 90 ;; esac
  local count=0
  [ ! -f "$POLL_DIR/count" ] || read -r count < "$POLL_DIR/count"
  count=$((count + 1)); echo "$count" > "$POLL_DIR/count"
  if [ "$count" -eq 1 ]; then echo 'connection refused' >&2; return 1; fi
  if [ "$MODE" = missing ]; then echo '{"items":[]}'; return; fi
  if [ "$count" -gt 4 ]; then count=4; fi
  cat "$POLL_DIR/$count"
}
sleep() { SECONDS=$((SECONDS + $1)); }
${shellFunction('wait_for_node')}
wait_for_node
`], { encoding: 'utf8', timeout: 20000, env: { ...process.env, POLL_DIR: dir, MODE: mode } })
    assert.equal(result.error, undefined)
    return { ...result, polls: Number(fs.readFileSync(path.join(dir, 'count'), 'utf8')) }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('node wait tolerates an unavailable API, missing node, and pending readiness', () => {
  const result = waitForNode('ready')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'test-node')
  assert.equal(result.polls, 4)
})

test('node wait fails within its deadline when registration never happens', () => {
  const result = waitForNode('missing')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /node.*180|180.*node/i)
  assert.ok(result.polls > 1 && result.polls <= 91, `bounded polling: ${result.polls}`)
})

test('node wait rejects multiple ready nodes instead of deploying on an arbitrary node', () => {
  const result = waitForNode('multiple')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /exactly one node/)
  assert.equal(result.stdout, '')
})

function waitForApp(readyAfter: number) {
  const result = spawnSync('bash', ['-c', `set -euo pipefail
PORT=30080
calls=0
die() { echo "$*" >&2; exit 1; }
curl() {
  calls=$((calls + 1))
  local connect=0 max=0 url=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --connect-timeout) connect="$2"; shift 2 ;;
      --max-time) max="$2"; shift 2 ;;
      http:*) url="$1"; shift ;;
      *) shift ;;
    esac
  done
  [ "$connect" = 2 ] && [ "$max" -ge 1 ] && [ "$max" -le 5 ] && [ "$url" = http://127.0.0.1:30080/api/health ] || exit 90
  [ "$calls" -ge "$READY_AFTER" ]
}
sleep() { [ "$1" = 1 ] || exit 91; SECONDS=$((SECONDS + $1)); }
trap 'echo "calls=$calls" >&2' EXIT
${shellFunction('wait_for_app')}
wait_for_app
`], { encoding: 'utf8', timeout: 5000, env: { ...process.env, READY_AFTER: String(readyAfter) } })
  assert.equal(result.error, undefined)
  return result
}

test('app startup waits through transient NodePort connection failures', () => {
  const result = waitForApp(3)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /calls=3/)
})

test('app health wait terminates with an actionable error when connectivity never arrives', () => {
  const result = waitForApp(10000)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /health.*60|60.*health/i)
  const calls = Number(result.stderr.match(/calls=(\d+)/)?.[1])
  assert.ok(calls > 1 && calls <= 60, `bounded polling: ${calls}`)
})
