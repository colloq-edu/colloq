/**
 * The join commands of the «Подключить машину» dialog are byte for byte the
 * ones `colloq-host runner-code` prints (§8.1): the panel's builder
 * (server/src/competitions/remote/commands.ts) against deploy/vast/colloq-host
 * itself, run with a stand-in docker that plays the instance.
 *
 * Two owners copy these commands: one from the panel, one from the
 * instance's console over Teleport when the panel is out of reach. A machine
 * joined from either must be the same machine — the same image, the same
 * mounts, the same join — and the image naming rule (colloq-vast and
 * colloq-server are one digest, a machine runs the release by name, an
 * instance on an image of its own names that image and gets no Vast
 * command) must be one rule, not two copies that drift.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runnerImage, runnerJoinCommands } from '../server/src/competitions/remote/commands.ts'

const HOST = path.resolve(import.meta.dirname, '../deploy/vast/colloq-host')
const CODE = '0123456789abcdef0123456789abcdef'

/** colloq-host runner-code on an instance running `image` labelled `version`, minting for `machines`. */
function colloqHost(image: string, version: string, machines: number, url: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-commands-'))
  try {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    const minted = JSON.stringify({ code: CODE, expiresAt: Date.UTC(2026, 9, 14, 12, 0), machines, trusted: false })
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
case "$*" in
  *"{{.State.Running}}"*) echo true ;;
  *"{{.Config.Image}}"*) echo '${image}' ;;
  *"org.opencontainers.image.version"*) echo '${version}' ;;
  exec*) echo '${minted}' ;;
esac
exit 0
`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\nif [ "$1" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi\n', { mode: 0o755 })
    const home = path.join(dir, 'state')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, '.env'), `PUBLIC_URL=${url}\n`)
    const run = spawnSync('bash', [HOST, 'runner-code', '--machines', String(machines)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, COLLOQ_CONF_DIR: path.join(dir, 'conf'), COLLOQ_HOME: home },
    })
    assert.equal(run.status, 0, run.stderr + run.stdout)
    return run.stdout
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** A command as colloq-host prints it on a terminal: each line two spaces in. */
const printed = (command: string): string => command.split('\n').map((line) => `  ${line}`).join('\n')

const CASES: Array<{ name: string; image: string; version: string; published: boolean; shown: string }> = [
  { name: 'the published colloq-vast, by its release', image: 'ghcr.io/colloq-edu/colloq-vast:0.24.0', version: '0.24.0', published: true, shown: 'ghcr.io/colloq-edu/colloq-server:0.24.0' },
  { name: 'colloq-server by a moving tag, by its release', image: 'ghcr.io/colloq-edu/colloq-server:latest', version: '0.24.1', published: true, shown: 'ghcr.io/colloq-edu/colloq-server:0.24.1' },
  { name: 'an official image with no release label, by its own digest', image: `ghcr.io/colloq-edu/colloq-vast@sha256:${'a'.repeat(64)}`, version: '', published: false, shown: `ghcr.io/colloq-edu/colloq-server@sha256:${'a'.repeat(64)}` },
  { name: 'an image of the university\'s own, whole', image: 'registry.example.org/colloq/colloq-vast:0.24.0-campus', version: '0.24.0', published: false, shown: 'registry.example.org/colloq/colloq-vast:0.24.0-campus' },
]

for (const one of CASES) {
  test(`the panel's three commands are colloq-host's: ${one.name}`, () => {
    const url = 'https://vsos.colloq.ru'
    const named = runnerImage(one.image, one.version)
    assert.deepEqual(named, { image: one.shown, published: one.published })
    const commands = runnerJoinCommands({ home: url, code: CODE, image: named.image, published: named.published, machines: 3 })
    const out = colloqHost(one.image, one.version, 3, url)
    assert.ok(out.includes(printed(commands.docker)), `docker:\n${commands.docker}\n---\n${out}`)
    assert.ok(out.includes(printed(commands.bare)), `bare:\n${commands.bare}\n---\n${out}`)
    if (one.published) assert.ok(out.includes(printed(commands.vast)), `vast:\n${commands.vast}\n---\n${out}`)
    else {
      assert.equal(commands.vast, '', 'no Vast command for an image those VMs would not run')
      assert.doesNotMatch(out, /make vast-runner COUNT/)
    }
  })
}

test('a machine joined with the plain docker run gets the stop timeout colloq-host gives its own agent', () => {
  // On SIGTERM the agent hands back the runs it holds, through a relay's backoff; an image cannot set its own
  // stop timeout, and Docker's 10 s killed the agent first, its runs coming back as losses.
  const own = /^run_runner\(\) \{\n[\s\S]*?--stop-timeout (\d+) /m.exec(fs.readFileSync(HOST, 'utf8'))?.[1]
  assert.equal(own, '90', 'colloq-host gives its agent a minute and a half')
  const commands = runnerJoinCommands({ home: 'https://vsos.colloq.ru', code: CODE, image: 'ghcr.io/colloq-edu/colloq-server:0.24.0', published: true, machines: 1 })
  assert.equal(commands.docker.split('\n')[0], `docker run -d --name colloq-runner --restart unless-stopped --stop-timeout ${own} \\`)
  // And colloq-host runner-code's copy, on the instance's console.
  assert.ok(colloqHost('ghcr.io/colloq-edu/colloq-vast:0.24.0', '0.24.0', 1, 'https://vsos.colloq.ru').includes(`  docker run -d --name colloq-runner --restart unless-stopped --stop-timeout ${own} \\\n`))
})

test('a server that knows no image of its own names the published one of its release', () => {
  assert.deepEqual(runnerImage(null, '0.24.0'), { image: 'ghcr.io/colloq-edu/colloq-server:0.24.0', published: true })
  const commands = runnerJoinCommands({ home: 'https://vsos.colloq.ru/', code: CODE, image: 'ghcr.io/colloq-edu/colloq-server:0.24.0', published: true, machines: 1 })
  assert.match(commands.docker, /COLLOQ_RUNNER_JOIN='https:\/\/vsos\.colloq\.ru#0123/, 'the origin alone, its trailing slash gone')
})
