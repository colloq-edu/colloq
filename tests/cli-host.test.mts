/**
 * A class online: colloq host is the group's only command.
 *
 * In the first half of the file no process is started and no real file is
 * read: the executor is replaced by an array of calls, the file system by an
 * in-memory map, output by an array of lines. What is checked is exactly what
 * the group is responsible for: which line goes to scripts/host.sh, what
 * happens to a bad name, and who asks before a dangerous action.
 *
 * The second half (at the end of the file) reads the real scripts/host.sh,
 * scripts/lib.sh and scripts/pack.mts: the line may go out right while there
 * is neither the script nor the state directory at its other end — and a
 * stand-in executor cannot see that. Why this is a separate check is
 * explained there.
 *
 * The shared parts (unique names, --dry-run without launches, a question for
 * every destructive command) are guarded by tests/cli-core.test.mts — we do
 * not duplicate them here.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cli } from '../cli/src/main.js'
import { createMemoryIo } from '../cli/src/env.js'
import { registry } from '../cli/src/registry.js'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  '/repo/package.json': '{ "name": "colloq", "version": "0.1.0" }',
  '/repo/cli/package.json': '{ "name": "@colloq/cli", "version": "0.1.0" }',
  '/repo/.env': [
    'PORT=3000',
    'KERNEL_ENV=base',
    'RELAY_DOMAIN=colloq.ru',
    'RELAY_ADDR=203.0.113.10',
    'RELAY_PORT=7000',
    'RELAY_TOKEN=very-secret-token',
    'CF_TOKEN=zone-token',
  ].join('\n'),
}

type Call = string[]

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: Call[]
  envs: (Record<string, string> | undefined)[]
  asked: string[]
}

type Options = {
  /** File map edits: null means no such file (how a missing .env is tested). */
  files?: Record<string, string | null>
  answer?: string
  tty?: boolean
  /** What the stand-in capture answers: docker ps goes here. */
  capture?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string }
  /**
   * Installed package or sources. This must not affect how host behaves — the
   * field is kept precisely to check that it does not.
   */
  dist?: boolean
  /** The state directory. Defaults to the app root, as in the sources. */
  home?: string
}

/** The same pattern as in cli-core: not a single real process or file. */
async function run(argv: string[], opts: Options = {}): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const calls: Call[] = []
  const envs: (Record<string, string> | undefined)[] = []
  const asked: string[] = []
  const files: Record<string, string> = { ...FILES }
  for (const [path, text] of Object.entries(opts.files ?? {})) {
    if (text === null) delete files[path]
    else files[path] = text
  }
  const io = createMemoryIo(files, 1_700_000_000_000)
  const code = await cli(argv, {
    io,
    root: ROOT,
    home: opts.home,
    dist: opts.dist,
    cwd: ROOT,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    tty: opts.tty ?? false,
    processEnv: {},
    ask:
      opts.answer === undefined
        ? undefined
        : async (question: string) => {
            asked.push(question)
            return opts.answer as string
          },
    runner: {
      async run(cmd, args, runOpts) {
        calls.push([cmd, ...args])
        envs.push(runOpts.env)
        return 0
      },
      async capture(cmd, args) {
        calls.push(['capture', cmd, ...args])
        return opts.capture?.(cmd, args) ?? { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  return { code, out, err, calls, envs, asked }
}

/** One room is running: docker ps answers with one line. */
const oneRoom: Options['capture'] = (cmd) =>
  cmd === 'docker'
    ? { code: 0, stdout: 'c0ffee\n', stderr: '' }
    : { code: 1, stdout: '', stderr: '' }

/** Launches without reads: capture (docker ps) does not count here. */
function spawned(result: Harness): Call[] {
  return result.calls.filter((call) => call[0] !== 'capture')
}

/* ------------------------------------------------------------------ host */

test('host: the name goes to the script as a variable, --direct adds COLLOQ_DIRECT=1', async () => {
  const relay = await run(['host', 'hse.colloq.ru', '--dry-run'])
  assert.equal(relay.code, 0)
  // COLLOQ_HOME in front is the state directory: .env, the class receipt and
  // .colloq.pid live there, not next to the script. In the sources it is the
  // same directory, and the variable changes nothing in the line except its
  // honesty.
  assert.deepEqual(relay.out, ['COLLOQ_HOME=/repo COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh'])
  assert.deepEqual(spawned(relay), [])

  // The order is as in the host-direct target and in the host.sh header:
  // people copy this line.
  const direct = await run(['host', 'hse.colloq.ru', '--direct', '--dry-run'])
  assert.deepEqual(direct.out, [
    'COLLOQ_HOME=/repo COLLOQ_DIRECT=1 COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh',
  ])

  // Without a name it is a quick tunnel: no name is made up for the script.
  const quick = await run(['host', '--dry-run'])
  assert.deepEqual(quick.out, ['COLLOQ_HOME=/repo ./scripts/host.sh'])

  const alias = await run(['public', 'hse.colloq.ru', '--dry-run'])
  assert.deepEqual(alias.out, ['COLLOQ_HOME=/repo COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh'])
})

test('host: the same line from the wheel and from the sources, and make is never called', async () => {
  // Previously the sources sent `make host HOST=…` while the wheel ran the
  // script itself: two branches, and the one checked on the author's machine
  // was not the one the teacher had. Now there is one branch, and ctx.dist
  // does not touch it.
  for (const argv of [
    ['host', 'hse.colloq.ru'],
    ['host', 'hse.colloq.ru', '--direct'],
    ['host'],
  ]) {
    const source = await run([...argv, '--dry-run'], { dist: false, home: '/home/.colloq' })
    const wheel = await run([...argv, '--dry-run'], { dist: true, home: '/home/.colloq' })
    assert.deepEqual(source.out, wheel.out, argv.join(' '))
    assert.match(wheel.out[0] ?? '', /^COLLOQ_HOME=\/home\/\.colloq .*\.\/scripts\/host\.sh$/)
    assert.doesNotMatch(wheel.out[0] ?? '', /\bmake\b/)
  }
})

test('host: KEY=VALUE pairs are no longer parsed — a refusal, not a silent substitution', async () => {
  // HOST=… in place of the name is a name, and it is no good for DNS.
  const asName = await run(['host', 'HOST=hse.colloq.ru', '--dry-run'])
  assert.equal(asName.code, 2)
  assert.deepEqual(spawned(asName), [])
  assert.deepEqual(asName.out, [])
  assert.match(asName.err.join('\n'), /will not do/)

  // PORT=3001 after the name is an extra argument, and it does not go to the
  // script as environment.
  const extra = await run(['host', 'hse.colloq.ru', 'PORT=3001', '--dry-run'])
  assert.equal(extra.code, 2)
  assert.deepEqual(spawned(extra), [])
  assert.deepEqual(extra.out, [])
  assert.match(extra.err.join('\n'), /extra argument: PORT=3001/)
})

test('host: direct mode without a name is a usage refusal, nothing is started', async () => {
  const result = await run(['host', '--direct', '--yes'], { tty: true })
  assert.equal(result.code, 2)
  assert.deepEqual(spawned(result), [])
  assert.match(result.err.join('\n'), /direct mode needs a name/)
  assert.match(result.err.join('\n'), /colloq host class\.example\.org --direct/)

  // Under --dry-run too: a line with an empty COLLOQ_HOSTNAME would lie about
  // what is going to run.
  const dry = await run(['host', '--direct', '--dry-run'])
  assert.equal(dry.code, 2)
  assert.deepEqual(dry.out, [])
})

test('host: a name not in Latin letters is refused before it gets to the script', async () => {
  for (const name of [
    'ХСЕ.colloq.ru',
    'Hse.colloq.ru',
    'hse.colloq.ru-',
    'hse.colloq.ru.',
    'hse_colloq.ru',
  ]) {
    const result = await run(['host', name, '--dry-run'])
    assert.equal(result.code, 2, name)
    assert.deepEqual(spawned(result), [], name)
    assert.deepEqual(result.out, [], name)
    assert.match(result.err.join('\n'), /will not do/, name)
  }
})

test('host: the question is not asked before the check, so a bad name gives code 2, not 3', async () => {
  for (const argv of [
    ['host', 'ХСЕ.colloq.ru', '--direct'],
    ['host', '--direct'],
  ]) {
    // Neither a terminal nor --yes: the framework would ask and refuse with
    // code 3 — but check fires before the question.
    const result = await run(argv)
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
  }
})

test('host --direct: the question names the cost; "no" gives code 4 and "cancelled"', async () => {
  const no = await run(['host', 'hse.colloq.ru', '--direct'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /caddy on 80 and 443.*hse\.colloq\.ru\?/)
  assert.deepEqual(no.out, ['cancelled'])

  const yes = await run(['host', 'hse.colloq.ru', '--direct'], { tty: true, answer: 'y' })
  assert.equal(yes.code, 0)
  assert.deepEqual(spawned(yes), [['./scripts/host.sh']])
  assert.deepEqual(yes.envs[0], {
    COLLOQ_HOME: '/repo',
    COLLOQ_DIRECT: '1',
    COLLOQ_HOSTNAME: 'hse.colloq.ru',
  })
})

test('host --direct --yes: no question at all', async () => {
  const result = await run(['host', 'hse.colloq.ru', '--direct', '--yes'], { tty: true })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(spawned(result), [['./scripts/host.sh']])
  assert.equal(result.envs[0]?.COLLOQ_DIRECT, '1')
})

test('host: the tunnel stays quiet while no class is running, and asks when one is', async () => {
  const quiet = await run(['host', 'hse.colloq.ru'], { tty: true, answer: 'n' })
  assert.equal(quiet.code, 0)
  assert.deepEqual(quiet.asked, [])
  assert.deepEqual(spawned(quiet), [['./scripts/host.sh']])
  assert.deepEqual(quiet.envs[0], { COLLOQ_HOME: '/repo', COLLOQ_HOSTNAME: 'hse.colloq.ru' })

  const busy = await run(['host', 'hse.colloq.ru'], { tty: true, answer: 'n', capture: oneRoom })
  assert.equal(busy.code, 4)
  assert.deepEqual(spawned(busy), [])
  assert.match(busy.asked[0] ?? '', /publish hse\.colloq\.ru\? 1 room is running/)

  // Without a name the question names the class as a whole, not an empty spot.
  const quick = await run(['host'], { tty: true, answer: 'n', capture: oneRoom })
  assert.equal(quick.code, 4)
  assert.match(quick.asked[0] ?? '', /publish the class\? 1 room is running/)
})

test('host: the header names the transport, and there is one; under it, two lines about the perimeter', async () => {
  const relay = await run(['host', 'hse.colloq.ru', '--yes'], { tty: true })
  // One header, and under it two lines about the perimeter: a room is a
  // hardened container with no access to the home network, and the link is
  // still a door to code on this computer. colloq doctor says the same words
  // (PERIMETER in cli/src/commands/host.ts).
  assert.equal(relay.out[0], 'publishing hse.colloq.ru through the relay: keep this window open')
  assert.equal(relay.out.length, 3)
  assert.match(relay.out[1] ?? '', /hardened container per room, cut off from your home network/)
  assert.match(relay.out[2] ?? '', /the link is a door: anyone who has it runs code in a sandbox/)
  assert.match(relay.out[2] ?? '', /keep it for your class; Ctrl\+C closes it/)
  // The old words were true before rooms were hardened, and they must not
  // come back.
  assert.doesNotMatch(relay.out.join('\n'), /without production limits|privileges are not dropped/)

  const cloud = await run(['host', 'class.example.ru', '--yes'], { tty: true })
  assert.match(cloud.out[0] ?? '', /through Cloudflare, which does not open from Russia/)

  const quick = await run(['host', '--yes'], { tty: true })
  assert.match(quick.out[0] ?? '', /quick Cloudflare tunnel: the name is random/)

  const direct = await run(['host', 'hse.colloq.ru', '--direct', '--yes'], { tty: true })
  assert.equal(
    direct.out[0],
    'installing caddy on this machine: it holds 80 and 443 for hse.colloq.ru',
  )
  assert.equal(direct.out.length, 3)

  // Not a single line of secrets from .env gets into the output.
  for (const result of [relay, cloud, quick, direct]) {
    const text = [...result.out, ...result.err].join('\n')
    assert.equal(text.includes('very-secret-token'), false)
    assert.equal(text.includes('zone-token'), false)
  }
})

test('host: no .env gives code 3, names the path and a workable hint, the same everywhere', async () => {
  const source = await run(['host', 'hse.colloq.ru', '--yes'], {
    tty: true,
    files: { '/repo/.env': null },
  })
  assert.equal(source.code, 3)
  assert.deepEqual(spawned(source), [])
  // The full path, not "no .env": there are two roots, and a person needs to
  // know which one lacks the file.
  assert.match(source.err.join('\n'), /no \/repo\/\.env/)
  // The hint must be workable. The old one, "cp .env.example .env", lied
  // twice: the path is relative (that is, in the person's current directory),
  // and an installed package has no .env.example at all. .env is created by
  // colloq start, from the sources as well, so there is one hint.
  assert.match(source.err.join('\n'), /colloq start creates it on the first run/)
  assert.doesNotMatch(source.err.join('\n'), /\.env\.example/)

  const packaged = await run(['host', 'hse.colloq.ru', '--yes'], {
    tty: true,
    dist: true,
    home: '/home/.colloq',
    files: { '/repo/.env': null },
  })
  assert.equal(packaged.code, 3)
  assert.deepEqual(spawned(packaged), [])
  assert.match(packaged.err.join('\n'), /no \/home\/\.colloq\/\.env/)
  assert.match(packaged.err.join('\n'), /colloq start creates it on the first run/)
  assert.doesNotMatch(packaged.err.join('\n'), /\.env\.example/)
})

test('host: no .env but --dry-run: the line is printed, no .env check is needed', async () => {
  // --dry-run only shows what would run and reads nothing beyond the
  // arguments: refusing over a missing .env here would be a refusal for
  // nothing.
  const result = await run(['host', 'hse.colloq.ru', '--dry-run'], {
    files: { '/repo/.env': null },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, [
    'COLLOQ_HOME=/repo COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh',
  ])
})

/* -------------------------------------------------- host in an installed colloq */

/**
 * Two roots: the app separate, the state separate.
 *
 * In a colloq installed through pip the app directory lives inside the package
 * (read-only, wiped by an update), while .env, the class receipt and
 * .colloq.pid are in ~/.colloq. The script has to be told where the state is,
 * otherwise it looks for it next to itself and publishes the address into a
 * file nobody reads.
 */
const PACKAGED: Options = { dist: true, home: '/home/.colloq' }

test('host: the script really runs and knows the state directory', async () => {
  const result = await run(['host', 'hse.colloq.ru', '--yes'], {
    ...PACKAGED,
    tty: true,
    files: { '/repo/.env': null, '/home/.colloq/.env': 'PORT=3000\nRELAY_DOMAIN=colloq.ru\n' },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(spawned(result), [['./scripts/host.sh']])
  assert.deepEqual(result.envs[0], {
    COLLOQ_HOME: '/home/.colloq',
    COLLOQ_HOSTNAME: 'hse.colloq.ru',
  })
  // The settings were read from the state directory: RELAY_DOMAIN comes from
  // there, and the header names the relay, not Cloudflare.
  assert.match(result.out[0] ?? '', /through the relay/)
})

test('host: in the sources the state root is named the same way, even though it matches the app', async () => {
  // There is deliberately no "do not send when the roots match" fork: someone
  // would have to remember to repeat it in the next command. copies and link
  // live by the same rule (cli/src/commands/local.ts · stateEnv).
  const result = await run(['host', '--yes'], { tty: true })
  assert.deepEqual(spawned(result), [['./scripts/host.sh']])
  assert.deepEqual(result.envs[0], { COLLOQ_HOME: '/repo' })
})

/* -------------------------------------------------------- group makeup */

test('the group has one command, host; the workshop is not called from here', () => {
  // The relay, DNS, a named tunnel and the test bench install and change other
  // machines and the zone: that is the Makefile and scripts/, and the CLI has
  // no wrapper over them.
  const group = registry.filter((command) => command.group === 'host')
  assert.deepEqual(
    group.map((command) => command.name),
    ['host'],
  )
  // host has one other name, public; direct mode lives as the --direct flag,
  // not as a separate host-direct command.
  assert.deepEqual(group[0]?.aliases, ['public'])
})

test('old workshop names get "no such command", and nothing is started', async () => {
  for (const argv of [
    ['host-direct', 'hse.colloq.ru'],
    ['tunnel', 'setup', 'class.example.ru'],
    ['relay', 'setup', 'root@203.0.113.10'],
    ['relay', 'ping'],
    ['dns', 'point', 'hse.colloq.ru', '203.0.113.10'],
  ]) {
    const result = await run([...argv, '--yes'], { tty: true })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
  }
})

/* -------------------------------------------- the scripts that actually do it */

/**
 * The second half of the file is about what a stand-in executor cannot see.
 *
 * Above, no process is started and no real file is read: what is checked is
 * WHAT goes to the script. Here what is checked is what lies at the other end
 * of that line — and it can only be seen in the real files. That is exactly
 * where the finding was: the line went out right, but the script was not in
 * the package at all, and `colloq host` died with code 127 on the only command
 * by which the class gets its link.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hostSh = fs.readFileSync(path.join(repo, 'scripts/host.sh'), 'utf8')
const packMts = fs.readFileSync(path.join(repo, 'scripts/pack.mts'), 'utf8')

/** Lines without comments: it is the comments that tell about these decisions. */
function code(text: string, mark = '#'): string {
  return text
    .split('\n')
    .filter((line) => !new RegExp(`^\\s*${mark}`).test(line))
    .join('\n')
}

/** Which scripts/* this script calls (by code lines, not by stories about them). */
function invoked(text: string): Set<string> {
  return new Set([...code(text).matchAll(/\bscripts\/([A-Za-z0-9._-]+)/g)].map((hit) => hit[1]!))
}

/** What scripts/pack.mts puts into the wheel: the SCRIPTS keys. */
const packedScripts = new Set(
  [...packMts.matchAll(/^\s*'([A-Za-z0-9._-]+\.(?:sh|py))':/gm)].map((hit) => hit[1]!),
)

test('everything the scripts call goes into the wheel, and none of it is forgotten', () => {
  // A closure, not a list checked by eye: host.sh sources lib.sh, backup and
  // restore call cluster.sh and their python helpers. Miss one, and the
  // failure comes as code 127 on the teacher's machine, not here.
  assert.ok(packedScripts.has('host.sh'), 'scripts/host.sh does not go into the wheel')
  const seen = new Set<string>()
  const queue = [...packedScripts]
  while (queue.length) {
    const name = queue.shift()!
    if (seen.has(name) || !name.endsWith('.sh')) continue
    seen.add(name)
    const text = fs.readFileSync(path.join(repo, 'scripts', name), 'utf8')
    for (const needed of invoked(text)) {
      if (needed.endsWith('.mts')) continue // these are built, not copied — see below
      assert.ok(
        packedScripts.has(needed),
        `scripts/${name} calls scripts/${needed}, which does not go into the wheel`,
      )
      queue.push(needed)
    }
  }
})

test('host.sh calls the public address lease as a bundle, and the source only next to the repository', () => {
  // The distribution has no tsx at all: `node --import tsx` failed there
  // before the first line, and the local session was left without an address.
  // The same fork as the supervisor has in cli/src/commands/local.ts.
  const bundle = 'cli/public-url-lease.mjs'
  assert.match(code(hostSh), new RegExp(`\\[ -f ${bundle.replace('/', '\\/')} \\]`))
  assert.match(code(hostSh), /node --import tsx scripts\/public-url-lease\.mts/)
  // And the bundle really is built, under the same name; otherwise the fork
  // would silently take the tsx branch.
  assert.match(packMts, /entryPoints: \[path\.join\(root, 'scripts\/public-url-lease\.mts'\)\]/)
  assert.match(packMts, new RegExp(`outfile: path\\.join\\(appDir, '${bundle}'\\)`))
  // The fork is an array, not a function: the address watcher goes into the
  // background, and $! must hold the pid of node itself. With a function it
  // would hold the subshell's pid, cleanup would kill that, and the watcher
  // would be left an orphan, renewing for three more seconds the lease on an
  // address we had just given up.
  assert.match(code(hostSh), /^\s*LEASE=\(node /m)
  assert.match(code(hostSh), /"\$\{LEASE\[@\]\}" watch .* &$/m)
})

test('scripts look for state in the state directory, not next to themselves', () => {
  const body = code(hostSh)
  // The class receipt and the pid file hang off the state root. The old
  // defaults were relative, that is, "next to the script".
  assert.match(body, /SESSION_RECEIPT="\$COLLOQ_STATE_ROOT\/\.colloq\/local-session\.json"/)
  assert.match(body, /PIDFILE="\$\{PIDFILE:-\$COLLOQ_STATE_ROOT\/\.colloq\.pid\}"/)
  assert.equal(/\$\{PIDFILE:-\.colloq\.pid\}/.test(body), false, 'the pid file is looked up locally again')
  assert.equal(
    /\[ -f \.colloq\/local-session\.json \]/.test(body),
    false,
    'the class receipt is looked up locally again',
  )
  // PUBLIC_URL is written into the .env that colloq link reads — otherwise
  // after a "successful" publication it would keep saying "not published".
  const setter = /^set_public_url\(\) \{$[\s\S]*?^\}$/m.exec(hostSh)![0]
  assert.match(setter, /"\$ENV_FILE"/)
  assert.equal(
    /(^|\s)\.env(\s|$)/m.test(code(setter)),
    false,
    'set_public_url writes to ./.env again',
  )
})

test('lib.sh: the state root is COLLOQ_HOME, and without it the old directory', () => {
  // The only place in this file where a process is started: the property is
  // checked on real bash, because its whole point lies in shell substitution.
  // Checking it by reading would mean checking one's own guess.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-state-'))
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3999\n')
    const ask = (cwd: string, home?: string): string =>
      execFileSync('bash', ['-c', `. "${path.join(repo, 'scripts/lib.sh')}"; read_env PORT`], {
        cwd,
        encoding: 'utf8',
        env:
          home === undefined
            ? { PATH: process.env.PATH ?? '' }
            : { PATH: process.env.PATH ?? '', COLLOQ_HOME: home },
      })
    // A named state directory beats the one the script is in: for an
    // installed colloq these are different directories, and only the first
    // has .env.
    assert.equal(ask(repo, dir), '3999')
    // Without the variable, as before: the current directory the scripts cd
    // into themselves (the very directory above scripts/). In the repository
    // that is exactly it.
    assert.equal(ask(dir), '3999')
    assert.equal(ask(os.tmpdir()), '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
