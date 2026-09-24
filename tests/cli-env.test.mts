/**
 * The env group: kernel environments.
 *
 * No process is started here and no real file is read by the commands: the
 * executor is a stand-in that writes calls into an array, io is an in-memory
 * file map. Only the test itself reads the real kernel/environments/*.txt —
 * and puts them into the same map, to check the machine view against the
 * counting rule that the env-list target in the Makefile uses too.
 *
 * All four commands of the group — list, show, new, use — are files only:
 * none of them starts anything, and the call array must stay empty after
 * each. That is why WHAT was written is checked too: the file map is handed
 * back out (Harness.io), and it is looked into after the command.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { cli } from '../cli/src/main.js'
import { createEnv, createMemoryIo, type Io } from '../cli/src/env.js'
import { commands, envFileIn, listEnvNames } from '../cli/src/commands/env.js'
import { PYTHON_VERSIONS } from '../shared/admin.js'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  '/repo/package.json': '{ "name": "colloq", "version": "0.1.0" }',
  '/repo/cli/package.json': '{ "name": "@colloq/cli", "version": "0.1.0" }',
  '/repo/.env': ['PORT=3000', 'KERNEL_ENV=cv', 'RELAY_DOMAIN=hse.colloq.ru'].join('\n'),
  '/repo/kernel/Dockerfile': ['FROM scratch', 'ARG PARENT=python:3.11-slim-bookworm'].join('\n'),
  '/repo/kernel/requirements.txt': [
    'jupyter-server>=2.14,<3',
    '# кнопка FORMAT',
    'numpy>=1.26',
  ].join('\n'),
  '/repo/kernel/environments/base.txt': '# Базовое окружение — здесь намеренно пусто.\n',
  '/repo/kernel/environments/base-gpu.txt': [
    '# Тяжёлая половина GPU-окружений.',
    '# colloq: gpu',
    '# colloq: python 3.12',
    'torch>=2.4',
    'torchvision>=0.19',
  ].join('\n'),
  '/repo/kernel/environments/cv.txt': [
    '# Компьютерное зрение.',
    '',
    '--extra-index-url https://download.pytorch.org/whl/cpu',
    'torch>=2.4',
    'torchvision>=0.19',
  ].join('\n'),
  '/repo/kernel/environments/gpu.txt': [
    '# Нейросети на GPU.',
    '# colloq: from base-gpu',
    'transformers>=4.44',
    'accelerate>=0.33',
  ].join('\n'),
}

/** Two environments that refer to each other: a chain that cannot exist. */
const RING: Record<string, string> = {
  '/repo/kernel/environments/ring.txt': ['# Петля.', '# colloq: from ring2', 'timm'].join('\n'),
  '/repo/kernel/environments/ring2.txt': ['# Вторая половина петли.', '# colloq: from ring'].join(
    '\n',
  ),
}

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: string[][]
  asked: string[]
  io: Io
}

async function run(
  argv: string[],
  opts: {
    files?: Record<string, string>
    answer?: string
    tty?: boolean
    /**
     * An installed colloq. The commands' behaviour does not depend on it; it
     * only decides the defaults of a new .env — the same ones the launch would
     * write.
     */
    dist?: boolean
    /** The state directory, when it differs from the app directory. */
    home?: string
    /** Paths that do not exist on this machine: a clean slate is checked too. */
    without?: string[]
  } = {},
): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const calls: string[][] = []
  const asked: string[] = []
  const map: Record<string, string> = { ...FILES, ...(opts.files ?? {}) }
  for (const path of opts.without ?? []) delete map[path]
  const io = createMemoryIo(map, 1_700_000_000_000)
  const code = await cli(argv, {
    io,
    root: ROOT,
    home: opts.home,
    cwd: ROOT,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    tty: opts.tty ?? false,
    dist: opts.dist ?? false,
    processEnv: {},
    ask:
      opts.answer === undefined
        ? undefined
        : async (question: string) => {
            asked.push(question)
            return opts.answer as string
          },
    runner: {
      async run(cmd, args) {
        calls.push([cmd, ...args])
        return 0
      },
      async capture() {
        // The framework's room count is a read, not a launch: it has no place
        // in calls.
        return { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  return { code, out, err, calls, asked, io }
}

/** A list line of exactly the width the env-list target prints (%-14s). */
function row(mark: string, name: string, tail: string): string {
  return '  ' + mark + ' ' + name.padEnd(14) + ' ' + tail
}

/** Real environment files in the memory map: same path, their own content. */
function realFiles(): Record<string, string> {
  const files: Record<string, string> = {
    '/repo/kernel/Dockerfile': readFileSync(
      new URL('../kernel/Dockerfile', import.meta.url),
      'utf8',
    ),
    '/repo/kernel/requirements.txt': readFileSync(
      new URL('../kernel/requirements.txt', import.meta.url),
      'utf8',
    ),
    // Our own line instead of the real .env: it does not go into the test.
    '/repo/.env': 'KERNEL_ENV=base\n',
  }
  const dir = new URL('../kernel/environments/', import.meta.url)
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.txt')) continue
    files['/repo/kernel/environments/' + name] = readFileSync(new URL(name, dir), 'utf8')
  }
  return files
}

// ----------------------------------------------------------- two directories

test('two environment directories: one path in the repository, different ones in an installed colloq', () => {
  const io = createMemoryIo({})
  const repo = createEnv({ io, root: '/repo' })
  assert.equal(repo.paths.ownEnvDir, '/repo/kernel/environments')
  assert.equal(repo.paths.ownEnvDir, repo.paths.envDir, 'in a clone there is nowhere to write but kernel/')

  const installed = createEnv({ io, root: '/app', home: '/home/teacher/.colloq' })
  assert.equal(installed.paths.envDir, '/app/kernel/environments')
  assert.equal(installed.paths.ownEnvDir, '/home/teacher/.colloq/environments')
})

test("the list is the union of two directories, and one's own name overrides the bundled one", () => {
  const dirs = { app: '/app/kernel/environments', own: '/home/.colloq/environments' }
  const io = createMemoryIo({
    '/app/kernel/environments/base.txt': '',
    '/app/kernel/environments/cv.txt': 'torch',
    '/home/.colloq/environments/cv.txt': 'timm',
    '/home/.colloq/environments/ml.txt': 'transformers',
    // Not a package list, so it does not get into the listing.
    '/home/.colloq/environments/README.md': 'заметка',
  })
  assert.deepEqual(listEnvNames(io, dirs), ['base', 'cv', 'ml'])
  assert.equal(envFileIn(io, dirs, 'base'), '/app/kernel/environments/base.txt')
  assert.equal(envFileIn(io, dirs, 'cv'), '/home/.colloq/environments/cv.txt', "one's own wins")
  assert.equal(envFileIn(io, dirs, 'ml'), '/home/.colloq/environments/ml.txt')
  // The name is nowhere, yet a path is still named, and it is the bundled one:
  // the "no such environment" refusal is built on it.
  assert.equal(envFileIn(io, dirs, 'нет'), '/app/kernel/environments/нет.txt')
})

test('coinciding directories do not double a name', () => {
  const same = '/repo/kernel/environments'
  const io = createMemoryIo({ [same + '/base.txt']: '', [same + '/cv.txt']: 'torch' })
  assert.deepEqual(listEnvNames(io, { app: same, own: same }), ['base', 'cv'])
})

// -------------------------------------------------------------- group makeup

test('the group has four commands, and none of them builds an image', async () => {
  /*
   * env build and env freeze left together with the Makefile wrapper: the
   * image is built by colloq start, and the env-build and env-freeze targets
   * stayed in the workshop. An old name must not quietly do something else —
   * `env build cv` gets as far as `env` (the list alias) and refuses on the
   * extra word without starting anything.
   */
  assert.deepEqual(
    commands.map((command) => command.name),
    ['env list', 'env show', 'env new', 'env use'],
  )
  for (const argv of [
    ['env', 'build', 'cv'],
    ['env', 'freeze'],
  ]) {
    const result = await run(argv, { answer: 'y' })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(result.calls, [])
    assert.deepEqual(result.asked, [])
    assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'])
  }
})

// ------------------------------------------------------------------ env list

test('env list: the name, a bare env and env ls print the list themselves, starting nothing', async () => {
  for (const argv of [['env', 'list'], ['env'], ['env', 'ls']]) {
    const result = await run(argv)
    assert.equal(result.code, 0)
    assert.deepEqual(result.calls, [], 'a native command starts nothing')
    assert.deepEqual(result.out, [
      'Environments (kernel/environments/)',
      '',
      row(' ', 'base', 'Python 3.11 · 0 packages on top of the base'),
      row(' ', 'base-gpu', 'Python 3.12 · 2 packages on top of the base'),
      row('*', 'cv', 'Python 3.11 · 2 packages on top of the base'),
      // gpu inherits Python from the root of the base-gpu chain instead of
      // taking the default.
      row(' ', 'gpu', 'Python 3.12 · 2 packages on top of the base'),
      '',
      '* — the default for new classes. Change it: colloq env use <name>',
    ])
  }
})

test('env list: the column width and the asterisk are the same as the target prints', async () => {
  const result = await run(['env', 'list'])
  assert.equal(
    result.out[4],
    '  * cv             Python 3.11 · 2 packages on top of the base',
    'two spaces, the mark, a 14-character name',
  )
})

test('env list --dry-run: one native line, not a single call', async () => {
  const result = await run(['env', 'list', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.equal(result.out.length, 1)
  assert.match(result.out[0] as string, /^native: env list \(reads kernel\/environments\//)
})

test('env list --json: the machine view, an asterisk on the current one, the version from the chain root', async () => {
  const result = await run(['env', 'list', '--json'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.equal(result.out.length, 1)
  assert.deepEqual(result.err, [])
  const parsed = JSON.parse(result.out[0] as string) as {
    ok: boolean
    current: string
    dir: string
    ownDir: string
    environments: { name: string; python: string; packages: number; current: boolean }[]
  }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.current, 'cv')
  assert.equal(parsed.dir, 'kernel/environments')
  assert.equal(parsed.ownDir, 'kernel/environments')
  assert.deepEqual(
    parsed.environments.map((item) => [item.name, item.python, item.packages, item.current]),
    [
      ['base', '3.11', 0, false],
      ['base-gpu', '3.12', 2, false],
      ['cv', '3.11', 2, true],
      ['gpu', '3.12', 2, false],
    ],
  )
})

test('env list --json --dry-run: exactly one JSON line and nothing besides it', async () => {
  const result = await run(['env', 'list', '--json', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.equal(result.out.length, 1)
  assert.deepEqual(result.err, [])
  const parsed = JSON.parse(result.out[0] as string) as { ok: boolean; command: string }
  assert.equal(parsed.ok, true)
  assert.match(parsed.command, /^native: env list /)
})

test('env list --json on the real files counts packages by the same rule as the env-list target', async () => {
  const result = await run(['env', 'list', '--json'], { files: realFiles() })
  assert.equal(result.code, 0)
  const parsed = JSON.parse(result.out[0] as string) as {
    current: string
    environments: { name: string; python: string; packages: number; current: boolean }[]
  }
  /*
   * The expectation is computed FROM THE FILES, not written out as numbers.
   *
   * Numbers stood here, and they went stale exactly as they had to: the
   * environment lists are edited from the panel right on the machine where
   * classes run (the "Environments" window writes
   * kernel/environments/<name>.txt), and the very first such edit turned the
   * test red — not by finding a bug but by finding someone else's work. What
   * has to be checked is not "the base has zero packages" but "the CLI counts
   * them by the same rule as the env-list target": comments and pip flags are
   * not packages, and neither are blank lines.
   *
   * The rule here is our own and deliberately simple — a second count,
   * independent of the first. If two different methods agree, the count is
   * right; if they diverge, one of them has a bug, and that is exactly what
   * the test must catch.
   */
  const dir = new URL('../kernel/environments/', import.meta.url)
  const expected = readdirSync(dir)
    .filter((name) => name.endsWith('.txt'))
    // By environment NAME, not by file name: "base-gpu.txt" sorts before
    // "base.txt" (a hyphen sorts before a dot), while the list sorts "base"
    // and "base-gpu".
    .sort((left, right) => (left.replace(/\.txt$/, '') < right.replace(/\.txt$/, '') ? -1 : 1))
    .map((file) => {
      const text = readFileSync(new URL(file, dir), 'utf8')
      const packages = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('--')).length
      return [file.replace(/\.txt$/, ''), packages]
    })
  assert.deepEqual(
    parsed.environments.map((item) => [item.name, item.packages]),
    expected,
  )
  // Python comes from the root of the "# colloq: from" chain, and that is
  // separate arithmetic.
  assert.deepEqual(
    parsed.environments.map((item) => item.python),
    parsed.environments.map(() => '3.11'),
  )
})

test('env list tolerates a loop: the list does not die because of one broken environment', async () => {
  const result = await run(['env', 'list'], { files: RING })
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, /ring {11}Python 3\.11/, 'the version is unknown, so the default is taken')
  assert.match(text, /cv/, 'the other environments are in place')
})

// ------------------------------------------------------------------ env show

test('env show without a name shows the current environment itself, starting nothing', async () => {
  const bare = await run(['env', 'show'])
  assert.equal(bare.code, 0)
  assert.deepEqual(bare.calls, [])
  const text = bare.out.join('\n')
  assert.match(text, /^cv — kernel\/environments\/cv\.txt · Python 3\.11/)
  assert.match(text, /torch>=2\.4/)
  assert.match(text, /Base \(always there\):/)

  // The current environment's name gives the same as no name.
  const named = await run(['env', 'show', 'cv'])
  assert.deepEqual(named.out, bare.out)
})

test('env show of another environment reads the file itself: packages, the base, not a single call', async () => {
  const result = await run(['env', 'show', 'gpu'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  const text = result.out.join('\n')
  assert.match(text, /gpu — kernel\/environments\/gpu\.txt · Python 3\.12/)
  assert.match(text, /transformers>=4\.44/)
  assert.match(text, /Base \(always there\):/)
  assert.match(text, /numpy>=1\.26/)
  // Comments and directives do not get into the package list.
  assert.equal(/colloq: from/.test(text), false)
})

test('env show --dry-run on another environment prints one native line', async () => {
  const result = await run(['env', 'show', 'gpu', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, [
    'native: env show gpu (reads kernel/environments/gpu.txt and kernel/requirements.txt)',
  ])
})

test('env show: no file means refusal 3 with a pointer to the list, nothing started', async () => {
  const result = await run(['env', 'show', 'нетакого'])
  assert.equal(result.code, 2, 'a name not in Latin letters is a usage error')

  const missing = await run(['env', 'show', 'ml'])
  assert.equal(missing.code, 3)
  assert.deepEqual(missing.calls, [])
  assert.match(missing.err.join('\n'), /kernel\/environments\/ml\.txt/)
  assert.match(missing.err.join('\n'), /colloq env list/)
})

test('env show of an empty environment says there is nothing on top of the base', async () => {
  const result = await run(['env', 'show', 'base'])
  assert.equal(result.code, 0)
  assert.match(result.out.join('\n'), /nothing on top of the base/)
})

test('env show on a loop refuses instead of printing a guessed version', async () => {
  const result = await run(['env', 'show', 'ring'], { files: RING })
  assert.equal(result.code, 3)
  assert.match(result.err.join('\n'), /in a circle: ring/)
})

// ------------------------------------------------------------------- env new

test('env new --dry-run: the path and the version are named, no file is created', async () => {
  const plain = await run(['env', 'new', 'ml', '--dry-run'])
  assert.equal(plain.code, 0)
  assert.deepEqual(plain.calls, [])
  assert.deepEqual(plain.out, [
    'native: env new ml (creates kernel/environments/ml.txt, Python 3.11)',
  ])
  assert.equal(plain.io.exists('/repo/kernel/environments/ml.txt'), false)

  const withPython = await run(['env', 'new', 'ml', '--python', '3.12', '--dry-run'])
  assert.deepEqual(withPython.out, [
    'native: env new ml (creates kernel/environments/ml.txt, Python 3.12)',
  ])
})

test('env new writes a file with a header into its own directory and starts nothing', async () => {
  const result = await run(['env', 'new', 'ml'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  const text = result.io.readText('/repo/kernel/environments/ml.txt') as string
  assert.match(text, /# Environment "ml"\./)
  assert.match(text, /kernel\/requirements\.txt/)
  assert.match(text, /#   transformers>=4\.44/)
  // The default is not written into the header: tomorrow ARG PARENT gets
  // bumped, and the line turns into a lie nobody asked for.
  assert.equal(/colloq: python/.test(text), false)
  // Not a single package on top of the base: the header is all comments.
  assert.match(result.out.join('\n'), /^created kernel\/environments\/ml\.txt/)
  assert.match(
    result.out.join('\n'),
    /Python 3\.11 · write the packages in, then: colloq env use ml/,
  )
})

test('env new with a non-default --python writes a directive into the header', async () => {
  const other = await run(['env', 'new', 'ml', '--python', '3.12'])
  assert.equal(other.code, 0)
  const text = other.io.readText('/repo/kernel/environments/ml.txt') as string
  assert.match(text, /^# colloq: python 3\.12\n#\n# Environment "ml"/)
  assert.match(other.out.join('\n'), /Python 3\.12/)

  const same = await run(['env', 'new', 'ml', '--python', '3.11'])
  const plain = same.io.readText('/repo/kernel/environments/ml.txt') as string
  assert.equal(/colloq: python/.test(plain), false, 'the default was asked for, so there is nothing to write')
})

test('env new without a name is a usage error, nothing started', async () => {
  const result = await run(['env', 'new'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /<name>/)
})

test('Python versions come with the code rather than being read from a file: the package has no shared/', async () => {
  /*
   * There is no shared/ directory either in the file map or in the
   * distribution (scripts/pack.mts ships server/dist, web/dist, server/assets
   * and kernel/*). The list used to be read from there as text relative to the
   * app root, came out empty in an installed colloq — and the check silently
   * switched off along with it: an environment got created with
   * "# colloq: python 3.99", and env list then showed the teacher that as the
   * version of an environment that will never build.
   */
  const wrong = await run(['env', 'new', 'ml', '--python', '3.99'], { dist: true })
  assert.equal(wrong.code, 2)
  assert.deepEqual(wrong.calls, [])
  assert.equal(wrong.io.exists('/repo/kernel/environments/ml.txt'), false)
  assert.ok(
    wrong.err.join('\n').includes('available: ' + PYTHON_VERSIONS.join(' ')),
    "the list is the same as the panel's: " + wrong.err.join('\n'),
  )

  const latest = PYTHON_VERSIONS[PYTHON_VERSIONS.length - 1] as string
  const good = await run(['env', 'new', 'ml', '--python', latest], { dist: true })
  assert.equal(good.code, 0)
  const text = good.io.readText('/repo/kernel/environments/ml.txt') as string
  assert.ok(text.startsWith('# colloq: python ' + latest + '\n'), text.slice(0, 40))
})

test('env new: an unknown Python version is refused with the list, a bad name is refused', async () => {
  const python = await run(['env', 'new', 'ml', '--python', '3.9'])
  assert.equal(python.code, 2)
  assert.deepEqual(python.calls, [])
  assert.match(python.err.join('\n'), /3\.10 3\.11 3\.12 3\.13/)

  const name = await run(['env', 'new', 'ML Env'])
  assert.equal(name.code, 2)
  assert.deepEqual(name.calls, [])
  assert.match(name.err.join('\n'), /cannot be an environment name/)
})

test('env new: the file already exists: refusal 3, the other list untouched', async () => {
  const result = await run(['env', 'new', 'cv'])
  assert.equal(result.code, 3)
  assert.match(result.err.join('\n'), /kernel\/environments\/cv\.txt already exists/)
  assert.equal(
    result.io.readText('/repo/kernel/environments/cv.txt'),
    FILES['/repo/kernel/environments/cv.txt'],
  )
})

// ------------------------------------------------------------------- env use

test('env use --dry-run: the write is named, no question, .env untouched', async () => {
  const result = await run(['env', 'use', 'base', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.out, ['native: env use base (KERNEL_ENV=base in .env)'])
  assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'])
})

test('env use --yes rewrites KERNEL_ENV in .env and builds nothing itself', async () => {
  const result = await run(['env', 'use', 'base', '--yes'], { answer: 'y' })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.calls, [], 'the image is built by colloq start, not by this command')
  assert.equal(
    result.io.readText('/repo/.env'),
    ['PORT=3000', 'RELAY_DOMAIN=hse.colloq.ru', 'KERNEL_ENV=base', ''].join('\n'),
    'the other lines are in place, exactly one KERNEL_ENV',
  )
  assert.deepEqual(result.out, [
    'Default environment for new classes: base',
    'the image is built on your next colloq start: this can take minutes',
  ])
})

test('env use asks once and promises no build; "no" gives code 4 and .env is intact', async () => {
  const no = await run(['env', 'use', 'base'], { answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(no.calls, [])
  assert.equal(no.asked.length, 1)
  assert.match(no.asked[0] as string, /make environment base the default for new classes\?/)
  assert.doesNotMatch(no.asked[0] as string, /build|slow/, 'there is no build here, so no promise of one')
  assert.match(no.out.join('\n'), /cancelled/)
  assert.equal(no.io.readText('/repo/.env'), FILES['/repo/.env'])

  const yes = await run(['env', 'use', 'base'], { answer: 'y' })
  assert.equal(yes.code, 0)
  assert.equal(yes.asked.length, 1)
  assert.deepEqual(yes.calls, [])
  assert.match(yes.io.readText('/repo/.env') ?? '', /^KERNEL_ENV=base$/m)
})

test('env use without a terminal and without --yes gives refusal 3, not "yes"', async () => {
  const result = await run(['env', 'use', 'cv'])
  assert.equal(result.code, 3)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /--yes/)
  assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'])
})

test('env use: no environment means refusal 3 without a question; the env switch alias is the same command', async () => {
  const missing = await run(['env', 'use', 'ml'], { answer: 'y' })
  assert.equal(missing.code, 3)
  assert.deepEqual(missing.asked, [])
  assert.deepEqual(missing.calls, [])
  assert.match(missing.err.join('\n'), /colloq env new ml/)
  assert.equal(missing.io.readText('/repo/.env'), FILES['/repo/.env'])

  const alias = await run(['env', 'switch', 'base', '--dry-run'])
  assert.deepEqual(alias.out, ['native: env use base (KERNEL_ENV=base in .env)'])

  // The check runs before the question and under --dry-run too: a "would do"
  // line about an environment that does not exist would be a lie.
  const dry = await run(['env', 'use', 'ml', '--dry-run'])
  assert.equal(dry.code, 3)
  assert.deepEqual(dry.out, [])
})

test('env use without a name or with a bad name is a usage error, .env untouched', async () => {
  const bare = await run(['env', 'use'], { answer: 'y' })
  assert.equal(bare.code, 2)
  assert.deepEqual(bare.asked, [])
  assert.match(bare.err.join('\n'), /<name>/)

  const wrong = await run(['env', 'use', 'ML'], { answer: 'y' })
  assert.equal(wrong.code, 2)
  assert.deepEqual(wrong.asked, [])
  assert.match(wrong.err.join('\n'), /cannot be an environment name/)
  assert.equal(wrong.io.readText('/repo/.env'), FILES['/repo/.env'])
})

test('env use on a loop refuses before the question', async () => {
  const result = await run(['env', 'use', 'ring'], { files: RING, answer: 'y' })
  assert.equal(result.code, 3)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /in a circle: ring/)
  assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'])
})

// ---------------------------------------------------------------------- help

test('help for a group command: usage, an example with a real environment, the delegate', async () => {
  const result = await run(['env', 'use', '--help'])
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, /Usage: colloq env use <name>/)
  assert.match(text, /colloq env use cv --yes/)
  assert.match(text, /delegates: native: KERNEL_ENV in \.env$/m)
  // Workshop targets have no place in the teacher's help: there is nothing to
  // call them with.
  assert.doesNotMatch(text, /env-build|NAME=/)
})

// ------------------------------------------ installed colloq and the repository

/**
 * An installed colloq and the repository behave the same.
 *
 * Only one ctx.dist fork is left in the group — the defaults of a new .env
 * (launch-config.ts · localClassEnv), and it repeats the launch's own choice.
 * Everything else — the question, the write, the output — does not depend on
 * the flag, and that is checked directly: two roads, one result.
 */
test('env use is the same in an installed colloq and in the repository', async () => {
  const dist = await run(['env', 'use', 'gpu', '--yes'], { dist: true })
  const repo = await run(['env', 'use', 'gpu', '--yes'], { dist: false })
  for (const result of [dist, repo]) {
    assert.equal(result.code, 0)
    assert.deepEqual(result.calls, [])
    assert.match(result.io.readText('/repo/.env') ?? '', /^KERNEL_ENV=gpu$/m)
  }
  assert.deepEqual(dist.out, repo.out)
  assert.equal(dist.io.readText('/repo/.env'), repo.io.readText('/repo/.env'))
})

test('env use on a clean slate creates a whole .env, not one line', async () => {
  const result = await run(['env', 'use', 'gpu', '--yes'], {
    without: ['/repo/.env'],
    dist: true,
  })
  assert.equal(result.code, 0)
  const written = result.io.readText('/repo/.env') ?? ''
  assert.match(written, /^KERNEL_ENV=gpu$/m)
  assert.equal(
    written.match(/^KERNEL_ENV=/gm)?.length,
    1,
    'the line from the defaults was replaced, not doubled',
  )
  // Exactly what was missing: a kernel token of its own, not the well-known
  // one from the example.
  assert.match(written, /^JUPYTER_TOKEN=[0-9a-f]{48}$/m)
  assert.match(written, /^KERNEL_BACKEND=docker$/m)
  assert.doesNotMatch(written, /colloq-dev-token/)
  // With the pip package the room and the panel open in English; in the
  // repository, ru.
  assert.match(written, /^UI_LANGUAGE=en$/m)

  const repo = await run(['env', 'use', 'gpu', '--yes'], { without: ['/repo/.env'] })
  assert.match(repo.io.readText('/repo/.env') ?? '', /^UI_LANGUAGE=ru$/m)
})

test('env use in an existing .env touches one line and leaves the rest', async () => {
  const result = await run(['env', 'use', 'gpu', '--yes'])
  const written = result.io.readText('/repo/.env') ?? ''
  assert.match(written, /^KERNEL_ENV=gpu$/m)
  assert.match(written, /^PORT=3000$/m, 'the other lines are in place')
  assert.match(written, /^RELAY_DOMAIN=hse\.colloq\.ru$/m)
  assert.doesNotMatch(written, /JUPYTER_TOKEN/, 'an existing file is not rewritten from scratch')
})

// ------------------------------------------ two directories: own and bundled

/**
 * The state directory apart from the app directory.
 *
 * This is how an installed colloq lives, and so does a working tree started
 * with COLLOQ_HOME. Then .env lives in <home>, one's own environments in
 * <home>/environments, and the bundled ones in <app>/kernel/environments, and
 * every command of the group must look into both directories and write only
 * into its own.
 */
const HOME = '/home/teacher/.colloq'

const SPLIT: Record<string, string> = {
  [HOME + '/.env']: 'KERNEL_ENV=base\n',
  [HOME + '/environments/mine.txt']: ['# colloq: from base', 'statsmodels'].join('\n'),
}

test("env list with two directories names both and marks one's own", async () => {
  const result = await run(['env', 'list'], { home: HOME, files: SPLIT })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.equal(result.out[0], 'Environments (kernel/environments/ and ' + HOME + '/environments/)')
  const text = result.out.join('\n')
  assert.match(text, /\* base /, "the asterisk follows the state directory's .env")
  assert.match(text, /mine .*1 package on top of the base · your own$/m)
  assert.doesNotMatch(text, /cv .*your own/, 'a bundled one is not called your own')

  const json = await run(['env', 'list', '--json'], { home: HOME, files: SPLIT })
  const parsed = JSON.parse(json.out[0] as string) as {
    ownDir: string
    environments: { name: string; own: boolean; file: string }[]
  }
  assert.equal(parsed.ownDir, HOME + '/environments')
  const mine = parsed.environments.find((item) => item.name === 'mine')
  assert.deepEqual([mine?.own, mine?.file], [true, HOME + '/environments/mine.txt'])
})

test('env new with two directories writes only into its own, and says an override out loud', async () => {
  const fresh = await run(['env', 'new', 'ml'], { home: HOME, files: SPLIT })
  assert.equal(fresh.code, 0)
  assert.ok(fresh.io.exists(HOME + '/environments/ml.txt'))
  assert.equal(fresh.io.exists('/repo/kernel/environments/ml.txt'), false, 'we do not write into the package')
  assert.doesNotMatch(fresh.out.join('\n'), /overrides/)

  // cv came with the product: one of your own with the same name is
  // legitimate, but not silently.
  const shadow = await run(['env', 'new', 'cv'], { home: HOME, files: SPLIT })
  assert.equal(shadow.code, 0)
  assert.ok(shadow.io.exists(HOME + '/environments/cv.txt'))
  assert.equal(
    shadow.io.readText('/repo/kernel/environments/cv.txt'),
    FILES['/repo/kernel/environments/cv.txt'],
    'the bundled list is untouched',
  )
  assert.match(shadow.out.join('\n'), /overrides the bundled environment with the same name/)
})

test("env show of one's own environment reads its file, not the bundled one", async () => {
  const result = await run(['env', 'show', 'mine'], { home: HOME, files: SPLIT })
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, new RegExp('^mine — ' + HOME + '/environments/mine\\.txt · Python 3\\.11'))
  assert.match(text, /statsmodels/)
})

test("env use on one's own environment writes KERNEL_ENV into the state directory's .env", async () => {
  const result = await run(['env', 'use', 'mine', '--yes'], { home: HOME, files: SPLIT })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.match(result.io.readText(HOME + '/.env') ?? '', /^KERNEL_ENV=mine$/m)
  assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'], "the app's .env is not ours")
  assert.match(result.out.join('\n'), /the image is built on your next colloq start/)
})

test('env use on a bundled environment with two directories does the same', async () => {
  const result = await run(['env', 'use', 'cv', '--yes'], { home: HOME, files: SPLIT })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.match(result.io.readText(HOME + '/.env') ?? '', /^KERNEL_ENV=cv$/m)
})

test('env use: a chain goes through both directories, and a missing parent is a refusal', async () => {
  const kid = await run(['env', 'use', 'kid', '--yes'], {
    home: HOME,
    files: {
      ...SPLIT,
      [HOME + '/environments/kid.txt']: ['# colloq: from mine', 'seaborn'].join('\n'),
    },
  })
  assert.equal(kid.code, 0, "the parent mine comes from one's own directory, its parent base from the package")
  assert.deepEqual(kid.calls, [])
  assert.match(kid.io.readText(HOME + '/.env') ?? '', /^KERNEL_ENV=kid$/m)

  const orphan = await run(['env', 'use', 'orphan', '--yes'], {
    home: HOME,
    files: {
      ...SPLIT,
      [HOME + '/environments/orphan.txt']: ['# colloq: from gone', 'seaborn'].join('\n'),
    },
  })
  assert.equal(orphan.code, 3)
  assert.match(orphan.err.join('\n'), /"gone" is named as a parent, and it does not exist/)
  assert.equal(orphan.io.readText(HOME + '/.env'), SPLIT[HOME + '/.env'])
})
