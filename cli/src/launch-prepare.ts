import fs from 'node:fs'
import path from 'node:path'
import {
  buildIsCurrent,
  fingerprint,
  kernelInputs,
  type BuildStamp,
  type LaunchConfig,
  type LaunchOptions,
} from './launch-config.js'
import { capture, Processes } from './launch-process.js'
import { readJson, writeJson } from './launch-state.js'

/**
 * One link of the chain of environments: one colloq-kernel:<name> image.
 *
 * When we build from the application directory itself and there is a
 * Makefile next to it (viaMake below; the reason is at its computation in
 * prepare), we call `make env-build`, the very target environments are built
 * with by hand, so that the build from the CLI and the build from the
 * terminal do not drift apart.
 *
 * Otherwise plain docker builds. A distribution has no Makefile, and there is
 * nothing to point docker compose at either:
 * docker-compose.yml is a file of the repository. But exactly the same thing
 * gets built there, and it can be seen line by line: the `kernel` target in
 * docker-compose.yml takes the ./kernel context and passes two arguments,
 * KERNEL_ENV (which environment sheet to copy) and PARENT (what to put the
 * layer on top of), and sets the tag colloq-kernel:<name>. Here this is said
 * with a direct docker call.
 *
 * We do not pass a parent at all when there is none: the default lives in
 * kernel/Dockerfile itself (ARG PARENT=python:3.11-slim-bookworm), and a
 * second copy of the base image name must not be created: they would drift
 * apart. The same choice, for the same reason, is made on the server side:
 * server/src/environments.ts · buildCommand, where this same direct call is
 * assembled for the panel.
 *
 * BUILDKIT_PROGRESS=plain comes from there too: the output goes both to the
 * terminal and to .colloq.log line by line, while the "pretty" progress
 * redraws itself with carriage returns and turns into mush in the log.
 *
 * buildRoot is not the application root but the BUILD root: it is also the
 * docker context. kernelRoot below separates them when the person has
 * environments of their own.
 */
async function buildKernelImage(
  processes: Processes,
  buildRoot: string,
  viaMake: boolean,
  name: string,
  parentImage: string,
  quiet: boolean,
): Promise<void> {
  if (viaMake) {
    const target = ['--no-print-directory', 'env-build', `NAME=${name}`]
    await processes.run('Python build', 'make', target)
    return
  }
  const kernel = path.join(buildRoot, 'kernel')
  const args = [
    'build',
    '-f',
    path.join(kernel, 'Dockerfile'),
    '--build-arg',
    `KERNEL_ENV=${name}`,
    ...(parentImage ? ['--build-arg', `PARENT=${parentImage}`] : []),
    '-t',
    `colloq-kernel:${name}`,
    kernel,
  ]
  const build = processes.start('Python build', 'docker', args, quiet, {
    DOCKER_BUILDKIT: '1',
    BUILDKIT_PROGRESS: 'plain',
  })
  const code = await build.done
  if (code !== 0) throw new Error(`Python build: the process exited with code ${code}.`)
}

/**
 * The kernel build root: what was shipped plus one's own, in one directory.
 *
 * Environments live in two places. The shipped ones (base, cv, gpu) lie next
 * to the application and are only read: for an installed package that is
 * site-packages, which cannot be written to at all. A person creates their
 * own with `colloq env new`, and they go into COLLOQ_HOME.
 *
 * Keeping these two places apart throughout the start (in the fingerprint, in
 * the inheritance chain, in the `docker build` context) means dragging the
 * fork into four different places and one day forgetting one of them. So the
 * fork is right here: before the build the kernel directory is assembled anew
 * in the state, and from then on everything works as before, with ONE root.
 * One's own name overrides a shipped one: a person is entitled to redefine
 * `cv` for their course.
 *
 * In the repository there is nothing to merge (the state is the repository):
 * the root itself is returned there, and not a byte is copied.
 */
function kernelRoot(root: string, home: string): string {
  const own = path.join(home, 'environments')
  if (home === root || !fs.existsSync(own)) return root
  const staged = path.join(home, '.colloq/kernel-build')
  const to = path.join(staged, 'kernel')
  fs.rmSync(staged, { recursive: true, force: true })
  // preserveTimestamps: the copy must keep the modification time. The first
  // time (when there is no build mark yet) it decides whether the image is
  // fresh, and without it every merge would look like "the sources have just
  // changed" and cost the teacher an extra rebuild before class.
  const keep = { recursive: true, preserveTimestamps: true } as const
  fs.cpSync(path.join(root, 'kernel'), to, keep)
  const into = path.join(to, 'environments')
  fs.mkdirSync(into, { recursive: true })
  for (const file of fs.readdirSync(own))
    if (file.endsWith('.txt')) fs.cpSync(path.join(own, file), path.join(into, file), keep)
  return staged
}

export async function prepare(
  config: LaunchConfig,
  options: LaunchOptions,
  processes: Processes,
  stopped: () => boolean,
): Promise<void> {
  const { root, home, env, kernelEnv, dist } = config
  /*
   * Everything about the kernel is computed from the MERGED root: it has both
   * the shipped environments and the ones the person created. See kernelRoot:
   * the fork is only there.
   */
  const kernelFrom = kernelRoot(root, home)
  /*
   * Whom to trust with building a link: make or plain docker.
   *
   * The criterion here is the same one by which the directories were merged
   * above: whether the BUILD root coincides with the application directory.
   * The `env-build` target knows nothing of any buildRoot: it reads $(ENV_DIR)
   * next to the Makefile itself and builds from the ./kernel context of the
   * same tree, so it can be trusted exactly when there was nothing to merge and
   * kernelRoot returned root itself.
   *
   * It used to go by dist, and broke in the gap between two different forks: a
   * working tree (that is, !dist) started with COLLOQ_HOME=~/classA merged the
   * environments into <home>/.colloq/kernel-build and right away called make,
   * which does not see the merge. The class fell over on "No <name>.txt", and
   * if the name matched a shipped one, the SHIPPED list was built silently
   * instead of one's own, which is exactly the "redefine cv for one's course"
   * the merge was introduced for.
   *
   * dist stays in the condition as the second term for a single reason: for
   * an installed colloq without environments of its own there is nothing to
   * merge either and kernelFrom equals root, but the Makefile does not travel
   * into the package, and there is nothing to call there.
   */
  const viaMake = !dist && kernelFrom === root
  /*
   * The COLLOQ_UNSAFE_DEV_FILES requirement is gone from here.
   *
   * It used to be: on anything that is not Linux, the start refused until a
   * line with the word UNSAFE appeared in .env. For a teacher with a MacBook
   * this was a two-step dead end: first a refusal about a file that does not
   * exist yet, then an offer to write "unsafe" into it oneself. This is fixed
   * in the file layer (server · secure-files.ts), not with a receipt in the
   * config: a path without the Linux descriptor workaround must be either
   * sound or absent.
   *
   * The Docker liveness check stays: without it the class kernel will not come
   * up at all, and it is better to say so now than after a minute and a half
   * of building.
   */
  if ((await capture(root, env, 'docker', ['info', '--format', '{{.ServerVersion}}'])).code !== 0)
    throw new Error('Docker is not responding. Start Docker and run colloq run again.')
  if (stopped()) throw new Error('Launch cancelled.')
  const inputs = kernelInputs(kernelFrom, kernelEnv)
  const sourceHash = fingerprint(kernelFrom, inputs)
  const chain = inputs
    .slice(2)
    .reverse()
    .map((file) => {
      const name = path.basename(file, '.txt')
      const sources = kernelInputs(kernelFrom, name)
      return { name, sources, fingerprint: fingerprint(kernelFrom, sources) }
    })
  type KernelStamp = { fingerprint: string; id: string; parentId?: string }
  const stamps: Array<{ file: string; value: KernelStamp }> = []
  const inspect = async (name: string): Promise<{ Id: string; Created: string } | undefined> => {
    const result = await capture(root, env, 'docker', ['image', 'inspect', `colloq-kernel:${name}`])
    if (stopped()) throw new Error('Launch cancelled.')
    if (result.code !== 0) return undefined
    try {
      const image = JSON.parse(result.text)[0]
      return typeof image?.Id === 'string' && image.Id ? image : undefined
    } catch {
      return undefined
    }
  }
  let parentId = '',
    parentImage = '',
    parentCreated = 0,
    ancestorRebuilt = false
  // env-build deliberately reuses existing parents. Request each changed
  // ancestor explicitly before building its descendants against that image.
  for (const item of chain) {
    let image = await inspect(item.name)
    // The mark about the built image is about this MACHINE (images live in its
    // docker), not about the application, hence home. The directory of an
    // installed application may well be closed for writing, and we have
    // nothing to write there.
    const marker = path.join(home, `.colloq/kernel-${item.name}.json`)
    const stamp = readJson<KernelStamp>(marker)
    const freshImage =
      image &&
      Date.parse(image.Created) >= parentCreated &&
      item.sources.every(
        (file) => fs.statSync(path.join(kernelFrom, file)).mtimeMs <= Date.parse(image!.Created),
      )
    const current = stamp
      ? stamp.fingerprint === item.fingerprint &&
        stamp.id === image?.Id &&
        (stamp.parentId ?? '') === parentId
      : freshImage
    if (!image || ancestorRebuilt || !current) {
      /*
       * The docker build log goes to the log file, and only the start and the
       * end reach the screen: a hundred "#7 CACHED" lines tell the teacher
       * nothing, and on a failure launch.ts shows the tail of the log. Under
       * make dev the log stays on the screen.
       */
      const quiet = options.action !== 'dev'
      const began = Date.now()
      console.log(
        `Preparing the Python environment "${item.name}"` +
          (quiet ? ' (the first start takes a few minutes)…' : ''),
      )
      await buildKernelImage(processes, kernelFrom, viaMake, item.name, parentImage, quiet)
      if (quiet) console.log(`  ready in ${Math.max(1, Math.round((Date.now() - began) / 1000))} s`)
      image = await inspect(item.name)
      if (!image) throw new Error('The build finished, but the kernel image is not there.')
      ancestorRebuilt = true
    }
    if (fingerprint(kernelFrom, inputs) !== sourceHash)
      throw new Error('The sources changed during the build. Start again, or use make dev.')
    stamps.push({ file: marker, value: { fingerprint: item.fingerprint, id: image.Id, parentId } })
    parentId = image.Id
    parentImage = `colloq-kernel:${item.name}`
    parentCreated = Date.parse(image.Created)
  }
  for (const stamp of stamps) writeJson(stamp.file, stamp.value)
  if (stopped()) throw new Error('Launch cancelled.')
  if (options.action === 'dev') return
  /*
   * A distribution is accepted as is.
   *
   * The source fingerprint (launch-config.ts · fingerprint) answers the
   * question "has the build drifted from the code", a developer's question.
   * An installed application has no sources at all: the fingerprint would be
   * computed over an empty place, would match itself and still mean nothing,
   * and there is nothing to call `npm run build` with: the package has no npm,
   * no build node_modules, no web/src.
   *
   * So the only thing checked is that the application is in place. We say so
   * right away rather than start node on a missing file.
   */
  if (dist) {
    for (const required of ['web/dist/index.html', 'server/dist/server.js'])
      if (!fs.existsSync(path.join(root, required)))
        throw new Error(
          `The installation is incomplete: no ${required} in ${root}. Reinstall colloq (pip install --force-reinstall colloq).`,
        )
    return
  }
  /*
   * The build mark is about THIS source tree, so it stays next to it, not in
   * the class directory. Only a working tree gets here (a distribution hits the
   * return above), and it is writable by definition. Also, moving COLLOQ_HOME
   * to a new class does not look like "the build is out of date" and does not
   * cost the teacher an extra three minutes before class.
   */
  const file = path.join(root, '.colloq/build.json')
  if (options.build || !buildIsCurrent(root, readJson<BuildStamp>(file), options.fast)) {
    const before = fingerprint(root)
    console.log('Building the application…')
    await processes.run('Application build', 'npm', [
      'run',
      options.fast ? 'build' : 'build:optimized',
    ])
    if (
      !fs.existsSync(path.join(root, 'web/dist/index.html')) ||
      !fs.existsSync(path.join(root, 'server/dist/server.js'))
    )
      throw new Error('The build produced no frontend and no server. Check the output above.')
    if (fingerprint(root) !== before)
      throw new Error('The sources changed during the build. Start again, or use make dev.')
    writeJson(file, { fingerprint: before, fast: options.fast })
  }
}
