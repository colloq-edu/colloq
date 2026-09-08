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
