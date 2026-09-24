/**
 * Environments: the packages a seminar's Python has.
 *
 * One environment is one file in `kernel/environments/`, installed on top of
 * the base every kernel carries, and built into the image `colloq-kernel:<name>`.
 * The panel and the `make env-*` targets are two faces of the same directory
 * and the same `KERNEL_ENV` line, which is why the parsing rules live in one
 * place and are pinned here.
 *
 * There are two directories, though: the ones shipped with the product are
 * only read, one's own a person creates. That is the last section of the
 * file.
 */
import './_env.mts'
import http from 'node:http'
import path from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENV_DIR,
  MAX_INHERITANCE,
  abilities,
  activeName,
  buildChain,
  buildCommand,
  buildContext,
  declaresGpu,
  declaresParent,
  isShipped,
  listChanged,
  listNames,
  needsGpu,
  ownEnvDirOf,
  parsePackages,
  pickActiveName,
  readSource,
  removeEnvironment,
  setActiveName,
  writeSource,
} from '../server/src/environments.js'
import { adminEnvironmentRoutes } from '../server/src/routes/admin-environments.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { ENVIRONMENT_NAME, STAFF_COOKIE } from '../shared/admin.js'

/* ------------------------------------------------ what counts as a package */

test('a package per line, as a person would count them', () => {
  assert.deepEqual(parsePackages('torch>=2.4\ntimm>=1.0\n'), ['torch>=2.4', 'timm>=1.0'])
})

test('comments and blank lines are not packages', () => {
  const source = '# computer vision\n\ntorch>=2.4\n\n#  another note\ntimm>=1.0\n'
  assert.deepEqual(parsePackages(source), ['torch>=2.4', 'timm>=1.0'])
})

test('a pip directive is not a package', () => {
  // Counting these told a room "6 packages" for a file that listed five, which
  // is the sort of small lie that makes the rest of a number untrustworthy.
  const source = '--extra-index-url https://download.pytorch.org/whl/cpu\ntorch>=2.4\n'
  assert.deepEqual(parsePackages(source), ['torch>=2.4'])
})

test('surrounding whitespace does not make two packages out of one', () => {
  assert.deepEqual(parsePackages('  torch>=2.4  \n\t timm \n'), ['torch>=2.4', 'timm'])
})

test('an empty file asks for nothing, and says so without crashing', () => {
  assert.deepEqual(parsePackages(''), [])
  assert.deepEqual(parsePackages('\n\n#только комментарий\n'), [])
})

test('a package with a marker or an extra survives whole', () => {
  const source = "uvicorn[standard]>=0.30\nnumpy>=1.26; python_version < '3.13'\n"
  assert.deepEqual(parsePackages(source), [
    'uvicorn[standard]>=0.30',
    "numpy>=1.26; python_version < '3.13'",
  ])
})

/* ---------------------------------- the environment needs a GPU slice */

/*
 * GPU is a property of the environment, not of the room: torch wheels are
 * built for CUDA, and "the same, only on the CPU" does not exist here. It is
 * declared by a line in the file header, because the package list is the
 * environment, and a separate registry next to it drifts apart at the very
 * first manual edit.
 */
test('a directive in the header declares GPU, and pip does not see it', () => {
  const source = '# нейросети\n# colloq: gpu\ntorch>=2.4\n'
  assert.equal(declaresGpu(source), true)
  // For pip it is a comment: neither an extra package in the count nor
  // "Needs rebuild" on a built image because of one line.
  assert.deepEqual(parsePackages(source), ['torch>=2.4'])
  assert.equal(listChanged('torch>=2.4\n', source), false)
})

test('spaces and case do not break the directive', () => {
  assert.equal(declaresGpu('  #   colloq:  gpu  \n'), true)
  assert.equal(declaresGpu('# Colloq: GPU\n'), true)
})

test('an ordinary environment does not ask for a slice', () => {
  assert.equal(declaresGpu(''), false)
  assert.equal(declaresGpu('# зрение на процессоре\ntorch>=2.4\n'), false)
  // A word in a sentence is not a directive: otherwise a phrase about GPU
  // inside an explanation would take the slice away from a seminar that
  // really needs it.
  assert.equal(declaresGpu('# colloq: gpu тут не нужен\n'), false)
})

test('the model gpu environment does declare the slice, and the base one does not', () => {
  // The only two examples of this directive in the repository: base-gpu
  // declares it itself, gpu gets it by inheritance. Should it fall out, the
  // room will run on the CPU and fail on the first `.cuda()`.
  assert.equal(needsGpu('base-gpu'), true)
  assert.equal(needsGpu('gpu'), true)
  assert.equal(needsGpu('base'), false)
  assert.equal(needsGpu('cv'), false)
  // A non-existent name is an empty file, not an exception: this is asked at
  // kernel start-up, and there is no reason to fail there.
  assert.equal(needsGpu('нет-такого'), false)
})

/* ------------------------------------------- what it is built on top of */

/*
 * An environment has one layer, and any edit of the list installs it all
 * over again: for an environment with torch that is three gigabytes of
 * wheels and nine minutes per added timm. `# colloq: from base-gpu` moves
 * the heavy part into a shared layer — the parent is built once, the
 * children in seconds. It is written in the same form as `# colloq: gpu`,
 * and it stays a comment for pip in the same way.
 */
test('a directive in the header names the parent, and pip does not see it', () => {
  const source = '# нейросети\n# colloq: from base-gpu\ntransformers>=4.44\n'
  assert.equal(declaresParent(source), 'base-gpu')
  assert.deepEqual(parsePackages(source), ['transformers>=4.44'])
  // Neither an extra package in the count nor "Needs rebuild" on a built
  // image.
  assert.equal(listChanged('transformers>=4.44\n', source), false)
})

test('spaces and case do not break the directive, and a phrase about it is not a directive', () => {
  assert.equal(declaresParent('  #   colloq:  from   base-gpu  \n'), 'base-gpu')
  assert.equal(declaresParent('# Colloq: FROM base-gpu\n'), 'base-gpu')
  assert.equal(declaresParent('# colloq: from base-gpu и дальше своё\n'), null)
  assert.equal(declaresParent('# строится from base-gpu\n'), null)
})

test('no parent named — we build on top of the ordinary base, as before', () => {
  assert.equal(declaresParent(''), null)
  assert.equal(declaresParent('# зрение\ntorch>=2.4\n'), null)
  assert.equal(declaresParent(readSource('cv')), null)
})

test('the repository\'s model environments are chained exactly like this', () => {
  // Should the line fall out of gpu.txt, "editing the list" will become nine
  // minutes again, silently.
  assert.equal(declaresParent(readSource('gpu')), 'base-gpu')
  assert.deepEqual(buildChain('gpu'), ['base-gpu', 'gpu'])
  assert.deepEqual(buildChain('cv'), ['cv'])
})

/* ------------------------------------------------- order and refusals */

/** Environments that do not exist on disk: chain parsing does not depend on the disk. */
function reader(files: Record<string, string>) {
  return (name: string): string | null => files[name] ?? null
}

test('a chain is built from the root to the leaf', () => {
  const read = reader({
    'base-gpu': '# colloq: gpu\ntorch>=2.4\n',
    gpu: '# colloq: from base-gpu\ntransformers>=4.44\n',
    vlm: '# colloq: from gpu\nqwen-vl\n',
  })
  assert.deepEqual(buildChain('vlm', read), ['base-gpu', 'gpu', 'vlm'])
  assert.deepEqual(buildChain('base-gpu', read), ['base-gpu'])
})

test('a loop is a refusal, not an endless build', () => {
  const read = reader({ a: '# colloq: from b\n', b: '# colloq: from a\n' })
  assert.throws(() => buildChain('a', read), /по кругу/)
  // And the shortest loop too: a file that named itself as its parent.
  assert.throws(() => buildChain('s', reader({ s: '# colloq: from s\n' })), /по кругу/)
})

test('a chain that is too long is a refusal, not a build of nine layers', () => {
  const files: Record<string, string> = {}
  const last = MAX_INHERITANCE + 1
  for (let i = 0; i <= last; i += 1) files[`e${i}`] = i === 0 ? '' : `# colloq: from e${i - 1}\n`
  assert.equal(buildChain(`e${MAX_INHERITANCE - 1}`, reader(files)).length, MAX_INHERITANCE)
  assert.throws(() => buildChain(`e${last}`, reader(files)), /длиннее/)
})

test('an unknown parent is named out loud, and before docker', () => {
  const read = reader({ gpu: '# colloq: from base-gpu\n' })
  // Nine minutes to fail on `COPY environments/base-gpu.txt` is the same
  // error, only more expensive.
  assert.throws(() => buildChain('gpu', read), /«base-gpu»/)
  assert.throws(() => buildChain('missing', read), /нет окружения/)
  // The name goes both into the path and into the image tag: not a name —
  // not a parent.
  assert.throws(() => buildChain('x', reader({ x: '# colloq: from ../etc\n' })), /не может быть/)
})

test('the gpu flag is inherited together with the CUDA wheels', () => {
  const read = reader({
    'base-gpu': '# colloq: gpu\ntorch>=2.4\n',
    gpu: '# colloq: from base-gpu\ntransformers>=4.44\n',
    vlm: '# colloq: from gpu\nqwen-vl\n',
    cpu: '# colloq: from base\npillow\n',
    base: '',
  })
  // Otherwise the room gets an image with CUDA wheels and no device — that
  // is, it fails on the first `.cuda()`, while the panel stays silent.
  assert.equal(needsGpu('gpu', read), true)
  assert.equal(needsGpu('vlm', read), true)
  assert.equal(needsGpu('cpu', read), false)
})

test('a child\'s own directive counts too', () => {
  const read = reader({ base: '', own: '# colloq: from base\n# colloq: gpu\n' })
  assert.equal(needsGpu('own', read), true)
})

test('a broken chain does not take the slice away from whoever asks for it', () => {
  // The build will say so. Staying silent here means bringing up a room
  // without a device and finding out in the middle of a class.
  assert.equal(needsGpu('gpu', reader({ gpu: '# colloq: gpu\n# colloq: from нет\n' })), true)
})

/* ------------------------------------------------------- what builds it */

/*
 * There is no real docker in the suite (see `_env.mts`), so what is checked
 * is what does not depend on it: the command we build for it — as in
 * gpu.test.
 *
 * There are two paths, and that is not decoration. On a machine with the
 * repository compose builds: it picks up the dev override, without which a
 * rebuilt shared kernel comes back without the forwarded 8888. In the app
 * container there is no compose at all — there is the kernel directory and
 * the socket, and that is enough.
 */

/** The path to the kernel directory in these checks: it does not have to exist. */
const KERNEL = '/srv/colloq/kernel'

test('a direct build makes do with the kernel directory — neither compose nor the repository', () => {
  const { args, env } = buildCommand({ via: 'direct' }, 'cv', null, KERNEL)
  assert.deepEqual(args, [
    'build',
    '-f',
    '/srv/colloq/kernel/Dockerfile',
    '--build-arg',
    'KERNEL_ENV=cv',
    '-t',
    'colloq-kernel:cv',
    '/srv/colloq/kernel',
  ])
  // The context is read by the client and handed to the daemon, so a daemon
  // on the host is no obstacle. While `docker compose` would fail from here
  // with "no configuration file provided", and that is exactly why the panel
  // dimmed Build under `make up`.
  assert.ok(!args.includes('compose'))
  assert.equal(env.KERNEL_ENV, undefined)
})

test('without a parent the PARENT argument is not passed at all', () => {
  // The default is in the Dockerfile itself: name the base image here as
  // well, and one day it will be raised there and forgotten here.
  const { args } = buildCommand({ via: 'direct' }, 'base', null, KERNEL)
  assert.ok(!args.some((arg) => arg.startsWith('PARENT=')))
})

test('via compose, variables rather than flags: it substitutes the arguments itself', () => {
  const files = ['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml']
  const { args, env } = buildCommand({ via: 'compose', files }, 'gpu', 'colloq-kernel:base-gpu')
  assert.deepEqual(args, ['compose', ...files, 'build', 'kernel'])
  assert.equal(env.KERNEL_ENV, 'gpu')
  assert.equal(env.KERNEL_PARENT, 'colloq-kernel:base-gpu')
})

test('on the direct path every layer stands on top of the previous one\'s image', () => {
  const read = reader({
    'base-gpu': '# colloq: gpu\ntorch>=2.4\n',
    gpu: '# colloq: from base-gpu\ntransformers>=4.44\n',
  })
  const chain = buildChain('gpu', read)
  const commands = chain.map((step, i) => {
    const before = chain[i - 1]
    return buildCommand(
      { via: 'direct' },
      step,
      before === undefined ? null : `colloq-kernel:${before}`,
      KERNEL,
    ).args.join(' ')
  })
  assert.ok(commands[0]?.includes('--build-arg KERNEL_ENV=base-gpu'))
  assert.ok(commands[0]?.includes('-t colloq-kernel:base-gpu'))
  assert.ok(!commands[0]?.includes('PARENT='))
  // This is what inheritance exists for: torch stays in the parent, and
  // editing a leaf costs seconds, not nine minutes.
  assert.ok(commands[1]?.includes('--build-arg PARENT=colloq-kernel:base-gpu'))
  assert.ok(commands[1]?.includes('-t colloq-kernel:gpu'))
})

/* ------------------------------------------- what can be done here at all */

/*
 * Building and making default are two different questions, and one reason
 * shared by both dimmed both buttons: under `make up` an environment could
 * not be built at all, only by going in over ssh.
 */

test('the repository is next door — one can both build and make default', () => {
  const can = abilities({ docker: true, context: true, repository: true, home: false })
  assert.deepEqual(
    [can.canBuild, can.cannotBuildReason, can.canSetDefault, can.cannotSetDefaultReason],
    [true, null, true, null],
  )
})

test('in a container there is only kernel: building is possible, the default is on the host', () => {
  // Exactly `make up`: kernel and the socket are mounted, while
  // docker-compose.yml and .env stayed outside. Writing .env inside the
  // container is lying: the edit lives until the first rebuild, while
  // compose reads the file on the host.
  const can = abilities({ docker: true, context: true, repository: false, home: false })
  assert.equal(can.canBuild, true)
  assert.equal(can.cannotBuildReason, null)
  assert.equal(can.canSetDefault, false)
  // The refusal names a doable action, not "everything is broken".
  assert.match(can.cannotSetDefaultReason ?? '', /make env-use/)
})

test('there is no kernel directory either — the build refusal names the mount', () => {
  const can = abilities({ docker: true, context: false, repository: false, home: false })
  assert.equal(can.canBuild, false)
  assert.match(can.cannotBuildReason ?? '', /kernel/)
  // And the default does not promise a build that is not here either.
  assert.ok(!/works from here/.test(can.cannotSetDefaultReason ?? ''))
})

test('docker is not visible — nothing is possible, and both buttons have the same reason', () => {
  const can = abilities({ docker: false, context: true, repository: true, home: false })
  assert.equal(can.canBuild, false)
  assert.equal(can.canSetDefault, false)
  assert.equal(can.cannotBuildReason, can.cannotSetDefaultReason)
  assert.match(can.cannotBuildReason ?? '', /docker\.sock/)
})

/* ------------------------------------------------------------ the name */

test('a name is what a filename and a Docker tag can both be', () => {
  for (const ok of ['base', 'cv', 'cv-torch-2', 'a', 'nlp-hf']) {
    assert.ok(ENVIRONMENT_NAME.test(ok), ok)
  }
})

test('a name that would escape the directory or break a tag is refused', () => {
  // It becomes a path and an image tag, so this is not cosmetic.
  for (const bad of [
    '../etc',
    'CV',
    'cv torch',
    'cv.torch',
    '-cv',
    'cv-',
    '',
    'cv/../x',
    'cv:latest',
  ]) {
    assert.ok(!ENVIRONMENT_NAME.test(bad), bad)
  }
})

test('a name is short enough to read in a table row', () => {
  assert.ok(ENVIRONMENT_NAME.test('a'.repeat(32)))
  assert.ok(!ENVIRONMENT_NAME.test('a'.repeat(33)))
})

/* ----------------------------------------------------- is it really built */

/*
 * "Built or not" used to be decided by comparing the file's modification
 * time with the image's build time — that is, it answered a different
 * question: not whether the list changed, but whether the file was touched.
 * Opening the list and saving without changes, or simply having a file
 * newer than an image built through docker compose, was enough for "Needs
 * rebuild" to hang in production next to "216 MB · built 5 days ago".
 */
test('saving without changes is not a change', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'torch>=2.4\ntimm>=1.0\n'), false)
})

test('a comment and a blank line do not change what pip will install', () => {
  assert.equal(
    listChanged('torch>=2.4\ntimm>=1.0\n', '# зрение\n\ntorch>=2.4\n\ntimm>=1.0\n'),
    false,
  )
})

test('the same list in a different order is the same list', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'timm>=1.0\ntorch>=2.4\n'), false)
})

test('a new package is a change', () => {
  assert.equal(listChanged('torch>=2.4\n', 'torch>=2.4\nnumpy\n'), true)
})

test('another version of the same package is a change', () => {
  assert.equal(listChanged('torch>=2.4\n', 'torch>=2.5\n'), true)
})

test('a removed package is a change', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'torch>=2.4\n'), true)
})

/* -------------------------------------- which environment is the default */

/*
 * `.env` is a host file, and the app image does not have it. Without a
 * fallback the panel under `make up` always answered "base", and a new
 * seminar was recorded on base with the cv kernel built: a seminar's
 * environment name decides which image its container comes up from once the
 * server sees docker.
 */
test('the .env line decides while it exists', () => {
  assert.equal(pickActiveName('PORT=3000\nKERNEL_ENV=cv\n', 'base'), 'cv')
})

test('the last line is the one make env-use appended', () => {
  assert.equal(pickActiveName('KERNEL_ENV=base\nKERNEL_ENV=nlp\n', undefined), 'nlp')
})

test('without the file, what compose passed to the container is taken', () => {
  assert.equal(pickActiveName(null, 'cv'), 'cv')
})

test('no line in the file — the environment variable too', () => {
  assert.equal(pickActiveName('PORT=3000\n', 'cv'), 'cv')
})

test('neither a file nor a variable — base', () => {
  assert.equal(pickActiveName(null, undefined), 'base')
  assert.equal(pickActiveName('KERNEL_ENV=\n', ''), 'base')
})

test('a name that can be neither a file nor a tag does not count', () => {
  // It goes into a path and an image name, so it is checked here, not there.
  assert.equal(pickActiveName('KERNEL_ENV=../etc\n', undefined), 'base')
  assert.equal(pickActiveName('KERNEL_ENV=CV\n', 'cv'), 'cv')
})

/* ------------------------------------------ creating versus overwriting */

/**
 * PUT is the same for "created an environment" and "edited the list", while
 * the intentions differ.
 *
 * The "New environment" form sends the same request, and on a taken name it
 * silently overwrote someone else's package list wholesale — these files
 * have no history, there is nothing to restore from. `If-None-Match: *`
 * means "only if there is no such thing yet".
 */
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

/**
 * issueStaffCookie writes into an express Response; this is the least thing
 * that is one.
 *
 * The teacher is created once for the whole suite: the address is unique by
 * index, and a second call with the same one would return null, not a
 * second cookie.
 */
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

test('creating on a taken name refuses instead of rewriting the list', async () => {
  const before = readSource('base')
  const res = await fetch(`${base}/api/admin/environments/base`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'if-none-match': '*',
      cookie: staffCookie(),
    },
    body: JSON.stringify({ name: 'base', source: '# пусто\n' }),
  })
  assert.equal(res.status, 409)
  const body = (await res.json()) as { reason?: string }
  assert.equal(body.reason, 'exists')
  // The main thing: the file is untouched — otherwise the refusal would be
  // politeness after the loss.
  assert.equal(readSource('base'), before)
})

/* ------------------------ its own kernel per room or one shared by all */

/**
 * The flag travels together with the list, because it is shown in the same
 * place.
 *
 * The panel promised a container per seminar unconditionally, while on an
 * install without docker or with KERNEL_ISOLATION=off that is untrue in two
 * places at once: rooms see each other's files, and "Make default" really
 * takes variables away from open seminars. Only the server knows this — so
 * it is the one who says it.
 */
test('the environment list does not offer a shared production runtime', async () => {
  const res = await fetch(`${base}/api/admin/environments`, { headers: { cookie: staffCookie() } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { environments?: unknown; shared?: unknown }
  assert.ok(Array.isArray(body.environments))
  // A boolean, not "no field": the panel reads `undefined` as "all is well".
  assert.equal(typeof body.shared, 'boolean')
  // Test-only Jupyter bypass is not a production shared-runtime capability.
  assert.equal(body.shared, false)
})

/* ------------------------------------ .env.example versus docker-compose */

/**
 * Every line from .env.example reaches the app container.
 *
 * compose reads .env only for substitution: a variable not named in
 * `environment:` never reaches the server inside the container at all. This
 * is how `MAX_SESSION_MB=200` and `AI_REASONING=true` silently did not work
 * under `make up`, even though both README and .env.example promised them,
 * while `make run` applied the same lines — two modes of one instance
 * behaved differently, and it could only be noticed by an extra gigabyte
 * loaded into a room.
 */
test('a variable promised in .env.example reaches the container', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const documented = readFileSync(path.join(root, '.env.example'), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf('=')))
  assert.ok(documented.length > 10, 'parsing .env.example found nothing')

  const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
  const app = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  kernel:'))
  const production = readFileSync(path.join(root, 'scripts/release.py'), 'utf8')
  const hostOnly = new Set(['PORT', 'BIND_ADDR'])
  const brokerOnly = new Set([
    'KERNEL_RUNTIME_URL',
    'KERNEL_RUNTIME_TOKEN_FILE',
    'KERNEL_CATALOG_FILE',
  ])
  for (const name of documented) {
    // Billing/relay credentials belong to the host tooling, never the app Pod.
    if (hostOnly.has(name) || /^(?:RELAY|CF|VAST)_/.test(name)) continue
    if (brokerOnly.has(name)) {
      assert.ok(
        production.includes(`'${name}'`),
        `${name} missing from production app configuration`,
      )
      continue
    }
    assert.ok(
      new RegExp(`\\n +${name}: `).test(app),
      `${name} missing from development app configuration`,
    )
  }
})

/* -------------------------------------- two environment directories */

/**
 * Environments live in two places, and this is not symmetry but necessity.
 *
 * The ones shipped with the product (base, base-gpu, cv, gpu) lie next to
 * the application; for colloq installed via pip that is site-packages — a
 * directory the next `pip install -U` overwrites, and on many machines it
 * is not writable at all. One's own a person creates with `colloq env new`,
 * and they go into the state directory, next to .env and data/.
 *
 * The panel knew about one directory of the two, and on one screen
 * contradicted itself: an environment the person created was not shown in
 * the list, while the panel named exactly its name as the active one. One
 * created FROM the panel went into site-packages — a permission refusal or
 * a file that vanishes at the first update.
 *
 * The whole model is checked here: reading as a union, writing only into
 * one's own, deleting only one's own, and the `docker build` context that
 * sees both.
 */

/** A state directory for one test: the variable is what the supervisor calls it. */
async function withHome<T>(run: (home: string) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(path.join(tmpdir(), 'colloq-home-'))
  const before = process.env.COLLOQ_HOME
  process.env.COLLOQ_HOME = home
  try {
    return await run(home)
  } finally {
    if (before === undefined) delete process.env.COLLOQ_HOME
    else process.env.COLLOQ_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
}

test('one\'s own directory is derived from the state, and in the repository it coincides with the shipped one', () => {
  // Without the variable the server was not brought up by the supervisor —
  // one directory, as before.
  assert.equal(ownEnvDirOf('/app', null), path.join('/app', 'kernel', 'environments'))
  // The state is the application itself (a repository, a clone, a container
  // under make up): a second directory next to it would take the file away
  // from under make env-list and from under the build.
  assert.equal(ownEnvDirOf('/app', '/app'), path.join('/app', 'kernel', 'environments'))
  assert.equal(
    ownEnvDirOf('/app', '/home/ada/.colloq'),
    path.join('/home/ada/.colloq', 'environments'),
  )
})

test('the list is a union of two directories, and an overridden name appears in it once', async () => {
  await withHome(async () => {
    writeSource('own-nlp', 'transformers\n')
    // One's own environment with a shipped one's name is the same
    // environment, overridden: it gets one row in the panel list.
    writeSource('cv', '# мой курс\ntimm\n')
    const names = listNames()
    assert.ok(names.includes('own-nlp'), `the own environment is not in the list: ${names.join(', ')}`)
    assert.ok(names.includes('base'), 'a shipped environment disappeared from the list')
    assert.equal(names.filter((name) => name === 'cv').length, 1)
  })
})

test('writing goes into one\'s own directory, and the shipped file stays untouched', async () => {
  const shipped = readFileSync(path.join(ENV_DIR, 'cv.txt'), 'utf8')
  await withHome(async (home) => {
    writeSource('cv', '# мой курс\ntimm\n')
    // One's own overrides the shipped one on reading — a person is entitled
    // to override cv for their course.
    assert.equal(readSource('cv'), '# мой курс\ntimm\n')
    assert.equal(
      readFileSync(path.join(home, 'environments', 'cv.txt'), 'utf8'),
      '# мой курс\ntimm\n',
    )
  })
  // The main thing: the application directory is untouched. Writing used to
  // go exactly there.
  assert.equal(readFileSync(path.join(ENV_DIR, 'cv.txt'), 'utf8'), shipped)
})

test('a shipped environment is not deleted, and the refusal says what to do instead', async () => {
  await withHome(async () => {
    assert.equal(isShipped('cv'), true)
    assert.throws(() => removeEnvironment('cv'), /colloq/)
    assert.equal(existsSync(path.join(ENV_DIR, 'cv.txt')), true)
    // One's own copy is no longer shipped: that is what gets deleted.
    writeSource('cv', 'timm\n')
    assert.equal(isShipped('cv'), false)
    removeEnvironment('cv')
    // Under the same name there is the shipped one again: the copy was
    // deleted, not the environment.
    assert.equal(readSource('cv'), readFileSync(path.join(ENV_DIR, 'cv.txt'), 'utf8'))
  })
})

test('the docker build context sees both directories, and one\'s own is stronger in it', async () => {
  await withHome(async (home) => {
    writeSource('own-nlp', '# colloq: from base\ntransformers\n')
    writeSource('cv', '# мой курс\ntimm\n')
    const context = buildContext('own-nlp')
    // The merge lies in the state: there is no way to write into the
    // application directory.
    assert.ok(context.startsWith(home), `the context was not assembled in the state: ${context}`)
    assert.equal(existsSync(path.join(context, 'Dockerfile')), true)
    assert.equal(existsSync(path.join(context, 'requirements.txt')), true)
    // The shipped ones are in place — without base the chain does not build
    // at all.
    assert.equal(existsSync(path.join(context, 'environments', 'base.txt')), true)
    assert.equal(
      readFileSync(path.join(context, 'environments', 'own-nlp.txt'), 'utf8'),
      '# colloq: from base\ntransformers\n',
    )
    assert.equal(
      readFileSync(path.join(context, 'environments', 'cv.txt'), 'utf8'),
      '# мой курс\ntimm\n',
    )
  })
  // Without the variable there is nothing to merge: the context is the
  // kernel directory itself, as before.
  assert.equal(buildContext('cv'), path.dirname(ENV_DIR))
})

test('the default is read and written in the state directory\'s .env', async () => {
  await withHome(async (home) => {
    const file = path.join(home, '.env')
    writeFileSync(file, 'PORT=3000\nKERNEL_ENV=own-nlp\n')
    // The same file is edited by `colloq env use` and reread by the next
    // start. A panel that looked into the application directory's .env named
    // base as active for installed colloq whatever the person chose.
    assert.equal(activeName(), 'own-nlp')
    setActiveName('base')
    const written = readFileSync(file, 'utf8')
    assert.match(written, /KERNEL_ENV=base/)
    // The other lines are in place: .env is the person's file, not ours.
    assert.match(written, /PORT=3000/)
  })
})

test('for installed colloq the default can be set even though there is no compose nearby', () => {
  // The ban was about the container: there KERNEL_ENV is read by compose
  // from the HOST, and writing inside is a lie that lives until the first
  // rebuild. Installed colloq has no host outside: .env lies in the state
  // directory, and the same file is read by the next colloq run. Dimming the
  // button meant sending the teacher to make, which they do not have either.
  const can = abilities({ docker: true, context: true, repository: false, home: true })
  assert.equal(can.canSetDefault, true)
  assert.equal(can.cannotSetDefaultReason, null)
  assert.equal(can.canBuild, true)
  // While in a container it is still not allowed, and the reason is the
  // same.
  const inContainer = abilities({ docker: true, context: true, repository: false, home: false })
  assert.equal(inContainer.canSetDefault, false)
})

test('the panel refuses to delete a shipped environment and deletes one\'s own copy', async () => {
  await withHome(async (home) => {
    // The active environment is protected by a separate branch; so that this
    // one is what gets checked, the default is set explicitly.
    writeFileSync(path.join(home, '.env'), 'KERNEL_ENV=base\n')
    const shipped = readSource('cv')
    const refused = await fetch(`${base}/api/admin/environments/cv`, {
      method: 'DELETE',
      headers: { cookie: staffCookie() },
    })
    assert.equal(refused.status, 409)
    const body = (await refused.json()) as { reason?: string; error?: string }
    assert.equal(body.reason, 'protected')
    // A refusal, not a quiet "nothing happened" and not a bare "internal
    // error" from EACCES in site-packages.
    assert.match(body.error ?? '', /colloq/)
    assert.equal(readSource('cv'), shipped)

    writeSource('cv', '# мой курс\ntimm\n')
    const removed = await fetch(`${base}/api/admin/environments/cv`, {
      method: 'DELETE',
      headers: { cookie: staffCookie() },
    })
    assert.equal(removed.status, 204)
    assert.equal(readSource('cv'), shipped)
    assert.equal(existsSync(path.join(home, 'environments', 'cv.txt')), false)
  })
})
