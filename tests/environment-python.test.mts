/**
 * Which Python an environment has — from a line in the file to a line in the
 * panel.
 *
 * The version comes from the BASE IMAGE: `python:3.12-slim-bookworm` is the
 * interpreter itself, and everything else goes on top of it in layers. Hence
 * three things, pinned here. The version is requested by the root of the
 * chain, not by a leaf: a layer on top of a ready image installs wheels for
 * the Python that came from the base and cannot replace it. The default
 * lives in kernel/Dockerfile, not as a second number next to it. And a built
 * image tells about itself — with the PYTHON_VERSION variable — because the
 * file may have been edited after the build, and then the panel must show
 * both versions rather than pick a convenient one.
 *
 * The neighbouring environments.test.mts holds the rest of the directive
 * family (`gpu`, `from`), and the parsing is shared — shared/admin.ts.
 */
import './_env.mts'
import http from 'node:http'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChain,
  buildCommand,
  declaresPython,
  listChanged,
  parseImageFacts,
  parsePackages,
  pythonOf,
  rootParentImage,
} from '../server/src/environments.js'
import { adminEnvironmentRoutes } from '../server/src/routes/admin-environments.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import {
  DEFAULT_PYTHON,
  PYTHON_VERSIONS,
  STAFF_COOKIE,
  pythonImage,
  unreadablePython,
  withPython,
} from '../shared/admin.js'
import { parseRuntimeCatalog } from '../shared/runtime.js'
import { translate } from '../shared/i18n.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

/* ------------------------------------------------------------- directive */

test('a directive in the header names the version, and pip does not see it', () => {
  const source = '# зрение\n# colloq: python 3.12\ntorch>=2.4\n'
  assert.equal(declaresPython(source), '3.12')
  // For pip it is a comment: neither an extra package in the count nor
  // "Needs rebuild" on a built image because of one line.
  assert.deepEqual(parsePackages(source), ['torch>=2.4'])
  assert.equal(listChanged('torch>=2.4\n', source), false)
})

test('spaces and case do not break the directive, and a phrase about it is not a directive', () => {
  assert.equal(declaresPython('  #   colloq:  python   3.12  \n'), '3.12')
  assert.equal(declaresPython('# Colloq: PYTHON 3.13\n'), '3.13')
  assert.equal(declaresPython('# colloq: python 3.12 и новее\n'), null)
  assert.equal(declaresPython('# ставится на python 3.12\n'), null)
})

test('only what has an official slim image counts as a version', () => {
  for (const ok of ['3.9', '3.10', '3.11', '3.12', '3.13']) {
    assert.equal(declaresPython(`# colloq: python ${ok}\n`), ok, ok)
  }
  // `python:3.8-slim-bookworm` does not exist, and "3.12.7" and "3" are not
  // tags either: this cannot be built, and silently building something else
  // instead is the worst of answers. Not a version — not a directive, and the
  // environment goes on the default, which the editor mentions in a separate
  // line.
  for (const bad of ['3.8', '2.7', '4.0', '3.14', '3.12.7', '3', 'latest', '']) {
    assert.equal(declaresPython(`# colloq: python ${bad}\n`), null, bad)
  }
})

test('a line that looks like a directive is named out loud, not swallowed', () => {
  assert.equal(unreadablePython('# colloq: python 3.8\n'), '# colloq: python 3.8')
  assert.equal(unreadablePython('# colloq: python 3.12\n'), null)
  assert.equal(unreadablePython('# зрение\ntorch>=2.4\n'), null)
})

test('the directive is written into the header, and the default is not written at all', () => {
  const source = '# зрение\ntorch>=2.4\n'
  assert.equal(withPython(source, '3.12'), '# colloq: python 3.12\n# зрение\ntorch>=2.4\n')
  // A file without the line and a file with a line about the default mean
  // the same thing, and the second one will even lie if the default in the
  // Dockerfile is raised one day.
  assert.equal(withPython(withPython(source, '3.12'), DEFAULT_PYTHON), source)
  // There are never two version lines in one header: the first would be
  // read, while a person would edit the second.
  const twice = withPython(withPython(source, '3.12'), '3.13')
  assert.equal(declaresPython(twice), '3.13')
  assert.equal(twice.split('\n').filter((line) => /colloq:\s*python/.test(line)).length, 1)
  // And what was entered with a button is read back by the same parser as
  // the build.
  for (const version of PYTHON_VERSIONS) {
    assert.equal(declaresPython(withPython(source, version)) ?? DEFAULT_PYTHON, version)
  }
})

/* -------------------------------------------- the root sets the version */

/** Environments that do not exist on disk: chain parsing does not depend on the disk. */
function reader(files: Record<string, string>) {
  return (name: string): string | null => files[name] ?? null
}

const CHAIN = {
  'base-gpu': '# colloq: gpu\n# colloq: python 3.12\ntorch>=2.4\n',
  gpu: '# colloq: from base-gpu\ntransformers>=4.44\n',
  vlm: '# colloq: from gpu\nqwen-vl\n',
  plain: 'pillow\n',
}

test('the version is inherited together with the base image', () => {
  const files = reader(CHAIN)
  assert.equal(pythonOf('base-gpu', files), '3.12')
  assert.equal(pythonOf('gpu', files), '3.12')
  assert.equal(pythonOf('vlm', files), '3.12')
  // Nothing said — the Dockerfile default, that is, exactly the old build.
  assert.equal(pythonOf('plain', files), DEFAULT_PYTHON)
  assert.equal(pythonOf('нет-такого', files), DEFAULT_PYTHON)
})

test('a child\'s own version is a refusal, and both versions are named out loud', () => {
  const files = reader({ ...CHAIN, gpu: '# colloq: from base-gpu\n# colloq: python 3.10\n' })
  // A layer on top of a ready image does not change the interpreter: the
  // build would build this on 3.12, silently, while the panel showed 3.10.
  assert.throws(() => buildChain('gpu', files), /gpu/)
  assert.throws(() => buildChain('gpu', files), /3\.10/)
  assert.throws(() => buildChain('gpu', files), /base-gpu/)
  assert.throws(() => buildChain('gpu', files), /3\.12/)
  // And for a grandchild too: the chain is checked as a whole, not one step
  // up.
  assert.throws(
    () => buildChain('vlm', reader({ ...CHAIN, vlm: '# colloq: from gpu\n# colloq: python 3.11\n' })),
    /3\.11/,
  )
})

test('repeating the parent\'s version is not a conflict but a redundant line', () => {
  const same = reader({ ...CHAIN, gpu: '# colloq: from base-gpu\n# colloq: python 3.12\n' })
  assert.deepEqual(buildChain('gpu', same), ['base-gpu', 'gpu'])
  assert.equal(pythonOf('gpu', same), '3.12')
  // Nothing forbids the root its own version: it is the one that sets it.
  assert.deepEqual(buildChain('base-gpu', reader(CHAIN)), ['base-gpu'])
})

test('a broken chain leaves the panel what the file itself asks for', () => {
  // The build will say so; here something has to be shown, and there is
  // nothing to invent.
  const broken = reader({ lone: '# colloq: from нет-такого\n# colloq: python 3.13\n' })
  assert.throws(() => buildChain('lone', broken))
  assert.equal(pythonOf('lone', broken), '3.13')
})

test('the repository\'s model environments run on the default', () => {
  // Should the default fall out of the Dockerfile, the next test will notice,
  // not a class.
  for (const name of ['base', 'cv', 'gpu', 'base-gpu']) {
    assert.equal(pythonOf(name), DEFAULT_PYTHON, name)
  }
})

/* ------------------------------------------------ the default in one place */

test('the version default matches what is in effect in the Dockerfile and compose', () => {
  /*
   * A second number living next to the first is exactly the way to lie
   * silently: the panel would show 3.11 over an image built on 3.12. So
   * DEFAULT_PYTHON is checked against both places where the base is named.
   */
  const arg = /^ARG PARENT=(python:([0-9]+\.[0-9]+)-slim-bookworm)$/m.exec(read('kernel/Dockerfile'))
  assert.ok(arg, 'kernel/Dockerfile no longer has the ARG PARENT=python:<version>-slim-bookworm line')
  assert.equal(arg[2], DEFAULT_PYTHON)
  assert.equal(arg[1], pythonImage(DEFAULT_PYTHON))
  // compose substitutes the same when KERNEL_PARENT is not set.
  assert.match(
    read('docker-compose.yml'),
    new RegExp(`PARENT: \\$\\{KERNEL_PARENT:-${pythonImage(DEFAULT_PYTHON)}\\}`),
  )
  // And the Makefile takes the default from the same place, not as a third
  // number.
  assert.match(read('Makefile'), /PY_DEFAULT := \$\(shell sed -nE 's\/\^ARG PARENT=python:/)
})

/* ---------------------------------------------------------- what builds it */

/** The path to the kernel directory in these checks: it does not have to exist. */
const KERNEL = '/srv/colloq/kernel'

test('the chain root is built on the official image of its version', () => {
  assert.equal(rootParentImage('3.12'), 'python:3.12-slim-bookworm')
  const direct = buildCommand({ via: 'direct' }, 'cv', rootParentImage('3.12'), KERNEL).args.join(' ')
  assert.ok(direct.includes('--build-arg PARENT=python:3.12-slim-bookworm'))
  assert.ok(direct.includes('-t colloq-kernel:cv'))
  // The same image under the same name via compose: these two paths must
  // not diverge — both produce the same `colloq-kernel:<name>`.
  const { env } = buildCommand({ via: 'compose', files: [] }, 'cv', rootParentImage('3.12'))
  assert.equal(env.KERNEL_PARENT, 'python:3.12-slim-bookworm')
  assert.equal(env.KERNEL_ENV, 'cv')
})

test('a child gets no version: it stands on the parent\'s image', () => {
  const direct = buildCommand({ via: 'direct' }, 'gpu', 'colloq-kernel:base-gpu', KERNEL).args.join(' ')
  assert.ok(direct.includes('--build-arg PARENT=colloq-kernel:base-gpu'))
  assert.ok(!direct.includes('python:'))
  const { env } = buildCommand({ via: 'compose', files: [] }, 'gpu', 'colloq-kernel:base-gpu')
  assert.equal(env.KERNEL_PARENT, 'colloq-kernel:base-gpu')
})

test('the operator\'s KERNEL_PARENT beats the directive — and this is said out loud', () => {
  // This is the way to build the chain on one's own base image; ignoring it
  // silently means building something other than what was asked for.
  assert.equal(rootParentImage('3.12', 'ghcr.io/uni/base:2026'), 'ghcr.io/uni/base:2026')
  assert.equal(rootParentImage('3.12', '  '), 'python:3.12-slim-bookworm')
  assert.equal(rootParentImage('3.12', undefined), 'python:3.12-slim-bookworm')
  // The log line names both sides: the panel will show the directive's
  // version for the environment, while the image has someone else's.
  const said = translate('ru', 'server.kernelParentIsSetInTheServers.4c1d90', {
    p0: 'ghcr.io/uni/base:2026',
    p1: 'python:3.12-slim-bookworm',
  })
  assert.match(said, /KERNEL_PARENT=ghcr\.io\/uni\/base:2026/)
  assert.match(said, /python:3\.12-slim-bookworm/)
})

/* -------------------------------------------- what the image itself tells */

/**
 * One `docker image inspect` per environment: size, date and image
 * variables. The list polls every environment on every opening of the
 * screen, and a second call per row would double that in the same event
 * loop that drives someone else's class.
 */
const INSPECT = [
  '1234567890',
  '2026-09-12T08:30:00.123456789Z',
  'PATH=/usr/local/bin:/usr/local/sbin',
  'LANG=C.UTF-8',
  'GPG_KEY=7169605F62C751356D054A26A821E680E5FA6305',
  'PYTHON_VERSION=3.12.7',
  'PYTHON_SHA256=24887b92e2afd4a2ac602419ad4b596372f67ac9b077190f',
  'PYTHONUNBUFFERED=1',
  '',
].join('\n')

test('the built image\'s version is read from its own configuration', () => {
  const facts = parseImageFacts(INSPECT)
  assert.ok(facts)
  assert.equal(facts.bytes, 1_234_567_890)
  assert.equal(facts.builtAt, Date.parse('2026-09-12T08:30:00.123456789Z'))
  // The patch is kept whole: `3.12.7` is what is really installed in the
  // image, and showing it is more honest than rounding to the minor.
  assert.equal(facts.python, '3.12.7')
  // PYTHON_SHA256 sits next to it on purpose: parsing goes by the start of
  // the line, not by an occurrence of the word.
})

test('an image that says nothing about Python stays an image', () => {
  const quiet = parseImageFacts('42\n2026-09-12T08:30:00Z\nPATH=/usr/bin\n')
  assert.deepEqual(quiet, { bytes: 42, builtAt: Date.parse('2026-09-12T08:30:00Z'), python: null })
  // Not built at all is null as a whole, not a record of zeros.
  assert.equal(parseImageFacts(''), null)
  assert.equal(parseImageFacts('нет такого образа\n'), null)
})

/* ----------------------------------------------------- in the API response */

const app = express()
app.use(express.json())
app.use(adminEnvironmentRoutes())
let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

let cookie = ''
function staffCookie(): string {
  if (cookie) return cookie
  const teacher = createTeacher({ name: 'Ада', email: 'ada@test.local', role: 'owner' })
  assert.ok(teacher)
  let value = ''
  issueStaffCookie(
    { cookie: (_n: string, v: string) => (value = v) } as unknown as Response,
    teacher,
  )
  cookie = `${STAFF_COOKIE}=${value}`
  return cookie
}

test('an environment row carries both versions: the requested and the built one', async () => {
  const res = await fetch(`${base}/api/admin/environments`, { headers: { cookie: staffCookie() } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    environments: { name: string; python: unknown; pythonBuilt: unknown }[]
  }
  assert.ok(body.environments.length > 0)
  for (const env of body.environments) {
    // The requested one is always there: the file knows it, and the panel
    // has something to show before the first build. The built one only when
    // the image exists and has told about it.
    assert.match(String(env.python), /^3\.\d+$/, env.name)
    assert.ok(
      env.pythonBuilt === null || /^3\.\d+/.test(String(env.pythonBuilt)),
      `${env.name}: ${String(env.pythonBuilt)}`,
    )
  }
})

test('a published catalogue names the version itself — or does not name it at all', () => {
  const entry = (extra: Record<string, unknown>) => ({
    schemaVersion: 1,
    release: 'v1',
    defaultEnvironment: 'base',
    environments: [
      { name: 'base', image: `registry.example/colloq-kernel@sha256:${'a'.repeat(64)}`, gpu: false, ...extra },
    ],
  })
  assert.equal(parseRuntimeCatalog(entry({ python: '3.12' })).environments[0].python, '3.12')
  // Not stated — and the panel stays silent: substituting the default would
  // mean writing a version that someone else's immutable image may not have.
  assert.equal(parseRuntimeCatalog(entry({})).environments[0].python, undefined)
  assert.throws(() => parseRuntimeCatalog(entry({ python: '3.12 или новее' })), /Python/)
  assert.throws(() => parseRuntimeCatalog(entry({ python: 312 })), /Python/)
})

/* ------------------------------------------------------ and on the screen */

/** Markup without comments: an explanation is not a promise. */
const code = (source: string): string =>
  source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('an environment row shows the version next to the size, not the word "Python"', () => {
  const screen = code(read('web/src/admin/screens/Environments.svelte'))
  // The bare word stood here from the very beginning, and the version is
  // exactly what people look at this row for.
  assert.ok(!/'Python',/.test(screen), 'the row again has the word "Python" without a version')
  assert.match(screen, /pythonLabel\(env\),\n\s*env\.imageBytes/)
  // The built version is shown as long as it matches the requested one; once
  // they diverge, the requested one, with the same "Needs rebuild" badge as
  // an edit of the list.
  assert.match(screen, /env\.pythonBuilt !== null && !pythonStale\(env\)/)
  assert.match(screen, /pythonStale\(env\)\s*\?\s*tr\('admin\.env\.pythonNeedsRebuild'/)
})

test('the version is chosen with buttons and written into the same file', () => {
  const screen = code(read('web/src/admin/screens/Environments.svelte'))
  assert.match(screen, /\{#each PYTHON_VERSIONS as version \(version\)\}/)
  // The button edits the environment's text, not a separate field next to
  // it: the file stays the only truth, and a directive typed by hand lights
  // up its button.
  assert.match(screen, /draftSource = withPython\(draftSource, version\)/)
  assert.match(screen, /declaresPython\(draftSource\) \?\? DEFAULT_PYTHON/)
  // The parent sets the version for the child — the buttons are locked and
  // say why.
  assert.match(screen, /disabled=\{draftParent !== null \|\| !editorReady\}/)
  assert.match(screen, /tr\('admin\.env\.pythonFromParent'/)
})

test('the new class form shows the environment\'s version and no longer denies it', () => {
  const source = read('web/src/admin/screens/NewSeminar.svelte')
  assert.match(code(source), /Python \$\{chosen\.pythonBuilt \?\? chosen\.python\}/)
  // The comment promised the opposite — "the server does not know it"; now it
  // does.
  assert.ok(!/Версии Python здесь нет намеренно/.test(source))
})

test('both captions about the version exist in two languages', () => {
  for (const key of [
    'admin.env.pythonVersion',
    'admin.env.pythonHint',
    'admin.env.pythonFromParent',
    'admin.env.pythonFromParentUnknown',
    'admin.env.pythonNotUnderstood',
    'admin.env.pythonConflict',
    'admin.env.pythonNeedsRebuild',
  ]) {
    assert.notEqual(translate('ru', key), key, key)
    assert.notEqual(translate('en', key), key, key)
    assert.doesNotMatch(translate('en', key, { version: '3.12', built: '3.11', parent: 'base', line: '#', list: '3.12' }), /[А-Яа-яЁё]/, key)
  }
})
