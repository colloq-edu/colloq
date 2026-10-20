/**
 * The join commands of the «Подключить машину» dialog are byte for byte the
 * ones `colloq-host runner-code` prints (§8.1): the panel's builder
 * (server/src/competitions/remote/commands.ts) against deploy/vast/colloq-host
 * itself, run with a stand-in docker that plays the instance.
 *
 * Two owners copy these commands: one from the panel, one from the
 * instance's console over Teleport when the panel is out of reach. A machine
 * joined from either must be the same machine — the same image, the same
 * mounts, the same network (the host's, which classes need), the same join,
 * the same check before a code for classes joins a bare machine — and the
 * image naming rule (colloq-vast and colloq-server are one digest, a machine
 * runs the release by name, an instance on an image of its own names that
 * image and gets no Vast command) must be one rule, not two copies that
 * drift.
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

/** colloq-host runner-code on an instance running `image` labelled `version`, minting for `machines` (a code that takes classes with `classes`). */
function colloqHost(image: string, version: string, machines: number, url: string, classes = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-commands-'))
  try {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    const minted = JSON.stringify({ code: CODE, expiresAt: Date.UTC(2026, 9, 14, 12, 0), machines, trusted: false, classes })
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
    const run = spawnSync('bash', [HOST, 'runner-code', '--machines', String(machines), ...(classes ? ['--classes'] : [])], {
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

/** Whether colloq-host's output holds the command as whole lines: a word more at the end of one is another command. */
const holds = (out: string, command: string): boolean => `\n${out}`.includes(`\n${printed(command)}\n`)

const CASES: Array<{ name: string; image: string; version: string; published: boolean; shown: string }> = [
  { name: 'the published colloq-vast, by its release', image: 'ghcr.io/colloq-edu/colloq-vast:0.24.0', version: '0.24.0', published: true, shown: 'ghcr.io/colloq-edu/colloq-server:0.24.0' },
  { name: 'colloq-server by a moving tag, by its release', image: 'ghcr.io/colloq-edu/colloq-server:latest', version: '0.24.1', published: true, shown: 'ghcr.io/colloq-edu/colloq-server:0.24.1' },
  { name: 'an official image with no release label, by its own digest', image: `ghcr.io/colloq-edu/colloq-vast@sha256:${'a'.repeat(64)}`, version: '', published: false, shown: `ghcr.io/colloq-edu/colloq-server@sha256:${'a'.repeat(64)}` },
  { name: 'an image of the university\'s own, whole', image: 'registry.example.org/colloq/colloq-vast:0.24.0-campus', version: '0.24.0', published: false, shown: 'registry.example.org/colloq/colloq-vast:0.24.0-campus' },
  { name: 'an image run by its id, by its release', image: `sha256:${'c'.repeat(64)}`, version: '0.24.0', published: true, shown: 'ghcr.io/colloq-edu/colloq-server:0.24.0' },
  { name: 'the local tag of a rollback, by its release', image: 'colloq-previous:20261014-153000', version: '0.24.0', published: true, shown: 'ghcr.io/colloq-edu/colloq-server:0.24.0' },
]

for (const one of CASES) {
  for (const classes of [false, true]) {
    test(`the panel's three commands are colloq-host's: ${one.name}${classes ? ', for a code that takes classes' : ''}`, () => {
      const url = 'https://vsos.colloq.ru'
      const named = runnerImage(one.image, one.version)
      assert.deepEqual(named, { image: one.shown, published: one.published })
      const commands = runnerJoinCommands({ home: url, code: CODE, image: named.image, published: named.published, machines: 3, classes })
      const out = colloqHost(one.image, one.version, 3, url, classes)
      assert.ok(holds(out, commands.docker), `docker:\n${commands.docker}\n---\n${out}`)
      assert.ok(holds(out, commands.bare), `bare:\n${commands.bare}\n---\n${out}`)
      // A bare machine for classes is checked before it joins; the flag itself is the code's, so the other two say nothing of it.
      assert.equal(commands.bare.split('\n')[2]!.endsWith(' --classes'), classes, commands.bare)
      assert.doesNotMatch(commands.docker + commands.vast, /--classes/)
      if (one.published) assert.ok(holds(out, commands.vast), `vast:\n${commands.vast}\n---\n${out}`)
      else {
        assert.equal(commands.vast, '', 'no Vast command for an image those VMs would not run')
        assert.doesNotMatch(out, /make vast-runner COUNT/)
      }
    })
  }
}

test('a machine joined with the plain docker run gets the stop timeout and the host network colloq-host gives its own agent', () => {
  // On SIGTERM the agent hands back the runs it holds, through a relay's backoff; an image cannot set its own
  // stop timeout, and Docker's 10 s killed the agent first, its runs coming back as losses. And a class kernel's
  // Jupyter is published on the host's loopback only (D19): an agent on Docker's bridge never reaches it.
  const runRunner = /^run_runner\(\) \{\n[\s\S]*?\n\}\n/m.exec(fs.readFileSync(HOST, 'utf8'))?.[0] ?? ''
  const own = /--stop-timeout (\d+) /.exec(runRunner)?.[1]
  assert.equal(own, '90', 'colloq-host gives its agent a minute and a half')
  assert.match(runRunner, /^ {4}--network host \\$/m, 'colloq-host runs its agent on the host\'s network')
  const commands = runnerJoinCommands({ home: 'https://vsos.colloq.ru', code: CODE, image: 'ghcr.io/colloq-edu/colloq-server:0.24.0', published: true, machines: 1 })
  const first = `docker run -d --name colloq-runner --restart unless-stopped --network host --stop-timeout ${own} \\`
  assert.equal(commands.docker.split('\n')[0], first)
  // And colloq-host runner-code's copy, on the instance's console.
  assert.ok(colloqHost('ghcr.io/colloq-edu/colloq-vast:0.24.0', '0.24.0', 1, 'https://vsos.colloq.ru').includes(`  ${first}\n`))
})

test('a server that knows no image of its own names the published one of its release', () => {
  assert.deepEqual(runnerImage(null, '0.24.0'), { image: 'ghcr.io/colloq-edu/colloq-server:0.24.0', published: true })
  const commands = runnerJoinCommands({ home: 'https://vsos.colloq.ru/', code: CODE, image: 'ghcr.io/colloq-edu/colloq-server:0.24.0', published: true, machines: 1 })
  assert.match(commands.docker, /COLLOQ_RUNNER_JOIN='https:\/\/vsos\.colloq\.ru#0123/, 'the origin alone, its trailing slash gone')
})

test('a server run by an image only its host holds names the published image of its release, as one that knows no image', () => {
  // `colloq-host update sha256:…` passes the id as COLLOQ_SERVER_IMAGE, and the rollback it prints
  // (`restore --image`) the colloq-previous tag rollback_ref made: a machine runs either only if it
  // already holds that very image, and pulls none.
  const unknown = runnerImage(null, '0.24.0')
  const join = (named: { image: string; published: boolean }) => runnerJoinCommands({ home: 'https://vsos.colloq.ru', code: CODE, ...named, machines: 2 })
  for (const id of [`sha256:${'a'.repeat(64)}`, 'a'.repeat(64), '0123456789ab', 'sha256:0123456789ab', 'colloq-previous:20261014-153000']) {
    assert.deepEqual(runnerImage(id, '0.24.0'), unknown, id)
    assert.deepEqual(join(runnerImage(id, '0.24.0')), join(unknown), id)
  }
  assert.equal(join(runnerImage(`sha256:${'a'.repeat(64)}`, '0.24.0')).vast, `make vast-runner COUNT=2 CODE=${CODE} URL=https://vsos.colloq.ru`)
  // A name with hex in it is still a name: by a digest, a repository spelled in hex, a tag; and so is
  // a colloq-previous in someone's registry.
  for (const named of [`registry.example.org/colloq/colloq-vast@sha256:${'b'.repeat(64)}`, 'registry.example.org/0123456789ab:0.24.0', '0123456789ab:0.24.0', 'registry.example.org/colloq-previous:20261014-153000']) {
    assert.deepEqual(runnerImage(named, '0.24.0'), { image: named, published: false }, named)
  }
})
