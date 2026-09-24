/** Local session supervisor. Administrative deployment remains in the existing scripts. */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parse as parseEnv } from 'dotenv'
import {
  launchConfig,
  localClassEnv,
  parseLaunchArgs,
  type LaunchOptions,
} from './launch-config.js'
import { capture, delay, Processes, type ManagedProcess } from './launch-process.js'
import {
  acquireLock,
  alive,
  appDir,
  homeDir,
  isDistribution,
  readJson,
  readReceipt,
  SESSION_FILE,
  writeJson,
  type LaunchReceipt,
} from './launch-state.js'
import { prepare } from './launch-prepare.js'
import { logTail, renderBanner, teacherLink } from './launch-banner.js'
import { devFrontendReady } from './launch-readiness.js'
import { ensureCloudflared } from './launch-cloudflared.js'
import {
  parseShareMarker,
  publishRefusal,
  readClasses,
  refusalText,
  renderShareBlock,
} from './launch-share.js'
import { leaseUrl } from '../../shared/local-public-url-lease.js'
import { createRequire } from 'node:module'

/**
 * Third-party bundles the frontend serves as is: put them in place before
 * Vite starts.
 *
 * The pdf.js worker and plotly.js are not imported by the sources: they are
 * static files in `web/public`, and the `npm run assets` step
 * (web/package.json) lays them out, that is, `npm run dev` and `npm run
 * build`. This command calls Vite DIRECTLY, bypassing npm, and on a fresh
 * clone plotly.js (it is not in git: five megabytes derivable from
 * package-lock) would not be in place: instead of a picture a chart would say
 * it failed to load. A copy is made only when there is none or it has a
 * different size; a failure does not bring the start down: without these
 * files two things do not work, not everything.
 */
function layOutWebAssets(root: string): void {
  const from = createRequire(path.join(root, 'web/package.json'))
  const copies: Array<[string, string]> = [
    ['pdfjs-dist/build/pdf.worker.min.mjs', 'web/public/pdf/pdf.worker.min.mjs'],
    ['plotly.js-strict-dist-min/plotly-strict.min.js', 'web/public/plotly/plotly.min.js'],
  ]
  for (const [module, target] of copies) {
    try {
      const source = from.resolve(module)
      const to = path.join(root, target)
      if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(source).size) continue
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(source, to)
    } catch (error) {
      console.warn(`[colloq] ${target}: ${error instanceof Error ? error.message : String(error)} — npm ci?`)
    }
  }
}

/*
 * Two roots instead of one: root is where the application is, home is where
 * the class is. The reasoning is at launch-state.ts · two roots. In the
 * repository it is one and the same directory, so not a single path below
 * moved there.
 */
const root = appDir()
const home = homeDir()
const dist = isDistribution(root)
const receiptFile = path.join(home, SESSION_FILE)
const resultFile = path.join(home, '.colloq/local-session-result.json')
const pidFile = path.join(home, '.colloq.pid')
const logFile = path.join(home, '.colloq.log')
const entry = fileURLToPath(import.meta.url)
const GRACE = 80000

async function health(port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return null
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}
/** The nearest free port from `from`, no further than a hundred; none means null. */
async function nearestFreePort(from: number): Promise<number | null> {
  for (let port = from; port < Math.min(from + 100, 65536); port++)
    if (!(await portOccupied(port))) return port
  return null
}
async function portOccupied(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const done = (busy: boolean): void => {
      socket.destroy()
      resolve(busy)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1000, () => done(true))
  })
}
async function supervisorOwned(receipt: LaunchReceipt): Promise<boolean> {
  /*
   * We recognize the receipt by the STATE directory, not by the application
   * directory.
   *
   * For an installed colloq the application directory changes by itself: an
   * update puts the code into a new version of the package. If we compared it,
   * `colloq stop` after a `pip install -U` in the middle of a class would
   * refuse to stop its own live server ("someone else's process was not
   * stopped"), and the teacher would be left with a running class and no
   * controls. Ownership is proven anyway not by this line but by the process
   * name (clq:<runId>) below.
   */
  if (receipt.root !== home || !alive(receipt.pid)) return false
  const command = await capture(root, process.env, 'ps', [
    '-ww',
    '-p',
    String(receipt.pid),
    '-o',
    'command=',
  ])
  return command.code === 0 && command.text.trim() === `clq:${receipt.runId.slice(0, 24)}`
}
function openBrowser(url: string): void {
  if (!process.stdout.isTTY) return
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { stdio: 'ignore', detached: process.platform !== 'win32' })
  child.on('error', () => console.log(`Open in your browser: ${url}`))
  child.unref()
}
async function banner(receipt: LaunchReceipt, detachedRun: boolean): Promise<void> {
  const version = (await health(receipt.port))?.version
  console.log(
    renderBanner({
      link: teacherLink(receipt.url, receipt.dataDir),
      workspaceDir: receipt.workspaceDir,
      logFile,
      detached: detachedRun,
      version: typeof version === 'string' ? version : undefined,
    }).join('\n'),
  )
}
/** The log tail on a failure of a quiet start: what used to be "in the log above". */
function showLogTail(): void {
  const tail = logTail(logFile)
  if (tail.length === 0) return
  console.error(`\nThe last lines of the log (${logFile}):\n`)
  for (const line of tail) console.error(`  ${line}`)
}
/**
 * The --share link block (launch-share.ts · renderShareBlock).
 *
 * The classes are read from the database at the moment of printing, not at
 * the start: the tunnel takes half a minute to come up, and a class created in
 * the opened browser during that time already makes it into the block.
 */
async function announceShare(
  url: string,
  receipt: Pick<LaunchReceipt, 'url' | 'dataDir'>,
  relayDomain: string,
  verified: boolean | null,
  detached: boolean,
): Promise<void> {
  const { classes, total } = await readClasses(receipt.dataDir)
  console.log(
    renderShareBlock({
      url,
      teacher: teacherLink(url, receipt.dataDir),
      local: receipt.url,
      classes,
      total,
      verified,
      detached,
      relayDomain,
    }).join('\n'),
  )
}
/**
 * cloudflared for --share, with a refusal that says what to do without it.
 * The same in the terminal and in a background start.
 */
async function shareCloudflared(
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await ensureCloudflared({ home, env, say: (line) => console.log(line), signal })
  } catch (error) {
    throw new Error(
      `No cloudflared for --share: ${(error as Error).message}\n` +
        'Start without --share (colloq start) and publish later with colloq host.',
    )
  }
}
/** The effective environment as the server will see it: .env and the variables on top of it. */
function effectiveEnv(): Record<string, string | undefined> {
  const envFile = path.join(home, '.env')
  return {
    ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile)) : {}),
    ...process.env,
  }
}
async function stopSession(): Promise<LaunchReceipt | null> {
  const receipt = readReceipt(receiptFile)
  if (!receipt) {
    console.log('No local session found.')
    return null
  }
  if (!alive(receipt.pid)) {
    console.log('The local session has already ended.')
    return receipt
  }
  if (!(await supervisorOwned(receipt)))
    throw new Error(
      'The PID in the session receipt does not belong to this run. Nothing was stopped.',
    )
  console.log('Saving and stopping the local session…')
  process.kill(receipt.pid, 'SIGTERM')
  const deadline = Date.now() + GRACE * 2 + 10000
  while (Date.now() < deadline) {
    if (readReceipt(receiptFile)?.runId !== receipt.runId && !alive(receipt.pid)) {
      const result = readJson<{ runId: string; error: string | null }>(resultFile)
      if (result?.runId === receipt.runId && result.error)
        throw new Error(result.error + ' Check colloq logs.')
      return receipt
    }
    await delay(100)
  }
  throw new Error('The stop did not finish. Check colloq logs; nothing was killed by force.')
}
/**
 * What to remove the room kernels with after the server stops.
 *
 * The cleanup is the same server code (the database and docker), and it used
 * to be called through tsx straight from the source: `node --import tsx
 * server/src/ops/local-cleanup.ts`. In a distribution such a line does not
 * exist (the package has neither server/src nor tsx), and `--import tsx` on a
 * missing package does not "do nothing" but fails with code 1, that is, every
 * stop of a class would end with an error message while the kernels were
 * fully cleaned up.
 *
 * The choice is a built twin next to the server: server/dist/local-cleanup.js,
 * with the same esbuild line as server/dist/runtime-smoke.js (see build in
 * server/package.json): a twin already exists, the pattern is known, and the
 * cleanup stays a separate short-lived command. The second path considered,
 * moving the cleanup inside the server, was rejected: by this moment the
 * server is already dead, and the safety net is needed precisely for the case
 * when it died on its own and did not do its own cleanup.
 *
 * The order of preference differs on the two sides, and on purpose. In the
 * repository the truth is the source (make dev runs on it, an edit is visible
 * at once); in a distribution it is the bundle. If the preferred one is
 * missing, we take the other: a built tree without the bundle and an unpacked
 * distribution with sources must both clean up after themselves.
 */
function kernelCleanupArgs(): string[] | null {
  const bundle = path.join(root, 'server/dist/local-cleanup.js')
  const source = path.join(root, 'server/src/ops/local-cleanup.ts')
  for (const candidate of dist ? [bundle, source] : [source, bundle]) {
    if (!fs.existsSync(candidate)) continue
    return candidate.endsWith('.ts') ? ['--import', 'tsx', candidate] : [candidate]
  }
  return null
}
function childArgs(options: LaunchOptions): string[] {
  const args = [options.action, '--child']
  if (options.detach) args.push('--detach')
  if (!options.open) args.push('--no-open')
  if (options.fast) args.push('--fast')
  if (options.build) args.push('--build')
  if (options.host) args.push('--host', options.host)
  if (options.share) args.push('--share')
  if (options.port) args.push('--port', String(options.port))
  return args
}
async function detached(options: LaunchOptions): Promise<number> {
  const existing = readReceipt(receiptFile)
  if (existing && (await supervisorOwned(existing))) {
    console.log(`Colloq is already running: ${existing.url}`)
    return 0
  }
  /*
   * cloudflared is fetched here, in the terminal, not in the background child:
   * the download on the first start takes a minute, and in the background it
   * would be visible only in the log, while the person would stare at a
   * motionless "Preparing the background start". The child will then find the
   * checked copy right away (launch-cloudflared.ts).
   */
  if (options.share || options.host) {
    // The lock by the settings is here too: the child's refusal would land in
    // the log, and the person would read only "the background start failed".
    const env = effectiveEnv()
    const refusal = publishRefusal({ env })
    if (refusal) throw new Error(refusalText(refusal))
    if (options.share) await shareCloudflared(env)
  }
  const runId = randomUUID()
  const log = fs.openSync(logFile, 'a', 0o600)
  fs.chmodSync(logFile, 0o600)
  /*
   * tsx is needed exactly when the source is being run. In a distribution this
   * same file arrives built, and `--import tsx` would not be found there: the
   * background start would fail on "Cannot find package 'tsx'" before the
   * first line.
   *
   * Both roots go to the child as explicit variables. It could work them out
   * again on its own, but a relative COLLOQ_HOME or a start from another
   * directory would give a second answer to the same question, and the
   * receipt would end up somewhere other than where the parent looks for it.
   */
  const loader = entry.endsWith('.ts') ? ['--import', 'tsx'] : []
  const child = spawn(process.execPath, [...loader, entry, ...childArgs(options)], {
    cwd: root,
    env: { ...process.env, COLLOQ_LAUNCH_ID: runId, COLLOQ_APP_DIR: root, COLLOQ_HOME: home },
    detached: true,
    stdio: ['ignore', log, log],
  })
  fs.closeSync(log)
  let ended = false,
    failure = '',
    cancelled = 0
  child.once('error', (error) => {
    failure = error.message
    ended = true
  })
  child.once('exit', () => {
    ended = true
  })
  const stop = (code: number): void => {
    cancelled = code
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  const onInt = (): void => stop(130),
    onTerm = (): void => stop(143)
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  try {
    console.log(`Preparing the background start. Log: ${logFile}`)
    while (!ended) {
      const receipt = readReceipt(receiptFile)
      let publicUrl: string | undefined
      if (receipt?.runId === runId) {
        try {
          publicUrl = leaseUrl(fs.readFileSync(receipt.leaseFile, 'utf8'), runId, Date.now())
        } catch {}
      }
      const publishing = Boolean(options.host || options.share)
      if (
        !cancelled &&
        receipt?.runId === runId &&
        receipt.phase === 'ready' &&
        (!publishing || publicUrl || receipt.hosting === 'failed')
      ) {
        await banner(receipt, true)
        if (publicUrl && options.share)
          await announceShare(
            publicUrl,
            receipt,
            effectiveEnv().RELAY_DOMAIN?.trim() ?? '',
            null,
            true,
          )
        else if (publicUrl) console.log(`Public address: ${publicUrl}`)
        else if (publishing)
          console.log(`The tunnel did not come up; local work continues. Details: ${logFile}`)
        /*
         * Under --share the tunnel link is opened: signing in on the public
         * address puts the cookie where the teacher will take the links for
         * the students from. The tunnel did not come up: we open nothing, the
         * person did not ask for localhost under --share.
         */
        if (options.open) {
          if (!options.share) openBrowser(teacherLink(receipt.url, receipt.dataDir))
          else if (publicUrl) openBrowser(teacherLink(publicUrl, receipt.dataDir))
        }
        child.unref()
        return 0
      }
      await delay(150)
    }
    if (cancelled) return cancelled
    if (!failure) showLogTail()
    throw new Error(failure || `The background start failed. Log: ${logFile}`)
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}

async function runSession(options: LaunchOptions): Promise<number> {
  const prior = readReceipt(receiptFile)
  if (prior && (await supervisorOwned(prior))) {
    console.log(
      `Colloq is already ${prior.phase === 'ready' ? 'running' : 'starting'}: ${teacherLink(prior.url, prior.dataDir)}`,
    )
    if (options.host) console.log(`For public access: colloq host ${options.host}`)
    if (options.share) console.log('For a public link: colloq host')
    if (options.open && !options.share && prior.phase === 'ready')
      openBrowser(teacherLink(prior.url, prior.dataDir))
    return 0
  }
  if (options.detach && !options.child) return await detached(options)
  const runId = options.child ? process.env.COLLOQ_LAUNCH_ID || randomUUID() : randomUUID()
  process.title = `clq:${runId.slice(0, 24)}`
  const releases: Array<() => void> = []
  let processes: Processes | undefined, receipt: LaunchReceipt | undefined, log: number | undefined
  let stopping = false,
    exitCode = 0,
    started = false
  let stopPromise: Promise<void> | undefined
  let cleanupFailure: string | null = null
  let tunnel: ManagedProcess | undefined
  // Ctrl+C in the middle of the cloudflared download cuts the download off rather than waiting for its end.
  const cancel = new AbortController()
  const stop = (code: number): void => {
    if (stopping) return
    stopping = true
    exitCode = code
    cancel.abort()
    console.log('\nStopping the local session…')
    stopPromise = (async () => {
      if (tunnel) await processes?.stop(tunnel, 5000)
      await processes?.stopAll(GRACE)
    })()
  }
  const onInt = (): void => stop(130),
    onTerm = (): void => stop(143),
    onHangup = (): void => stop(129)
  const onOutputError = (): void => stop(129)
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  process.on('SIGHUP', onHangup)
  process.stdout.on('error', onOutputError)
  process.stderr.on('error', onOutputError)
  try {
    releases.push(acquireLock(path.join(home, '.colloq/local-session.lock'), process.pid, runId))
    const legacy = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : 0)
    if (legacy && alive(legacy))
      throw new Error(
        'A server from .colloq.pid is already running. Use it, or stop it explicitly with colloq stop.',
      )
    /*
     * The .env of a local class is written by colloq itself, not a copy of
     * .env.example. Why exactly so: launch-config.ts · localClassEnv.
     */
    const envFile = path.join(home, '.env')
    if (!fs.existsSync(envFile)) {
      fs.writeFileSync(envFile, localClassEnv(dist), { flag: 'wx', mode: 0o600 })
      console.log(`Created ${envFile}: the settings for this machine.`)
    }
    const settings = { ...parseEnv(fs.readFileSync(envFile)), ...process.env }
    let config = launchConfig(root, options, settings, home)
    /*
     * The default port is taken: we take the nearest free one, like Jupyter.
     * Only when nobody named the port: `--port 3000` is a request for exactly
     * that one, and a taken one is answered by the refusal below. Under make
     * dev the server port lives in .env, and --port is the Vite port, so
     * nothing is picked there.
     */
    if (options.action !== 'dev' && options.port === undefined && (await portOccupied(config.port))) {
      const taken = config.port
      const free = await nearestFreePort(taken + 1)
      if (free !== null) {
        options.port = free
        config = launchConfig(root, options, settings, home)
        console.log(`Port ${taken} is taken; using ${free}.`)
      }
    }
    config.env.COLLOQ_LOCAL_RUN_ID = runId
    /*
     * Name the port that is really taken, and the way out. It used to be
     * "Port 3000 or 3000 is already taken": with a single port the phrase
     * repeated the number and did not say what to do.
     */
    const busy = (await portOccupied(config.port))
      ? config.port
      : config.uiPort !== config.port && (await portOccupied(config.uiPort))
        ? config.uiPort
        : null
    if (busy !== null)
      throw new Error(
        `Port ${busy} is already taken by another program; it was left alone. ` +
          'Stop that program, or pick another port with --port, for example --port 3100.',
      )
    /*
     * The publishing lock by the settings, before the build and before the
     * server. A refusal here costs a second; the same refusal after a minute of
     * building costs a minute, and with KERNEL_ISOLATION=off the server would
     * not become healthy at all, and the person would read "did not come up in
     * 90 seconds" instead of the reason.
     */
    const publishing = Boolean(options.host || options.share)
    const early = publishing ? publishRefusal({ env: config.env }) : null
    if (early) throw new Error(refusalText(early))
    /*
     * cloudflared for --share also comes before the server: the first
     * download takes a minute, and it had better run while nothing is up yet.
     * If it fails, the refusal comes at once, with the reason, and not a class
     * without a link that people learn about from the group chat.
     */
    let cloudflared: string | undefined
    if (options.share) {
      try {
        cloudflared = await shareCloudflared(config.env, cancel.signal)
      } catch (error) {
        if (stopping) return exitCode
        throw error
      }
    }
    if (stopping) return exitCode
    releases.push(acquireLock(path.join(config.dataDir, '.local-session.lock'), process.pid, runId))
    fs.mkdirSync(config.workspaceDir, { recursive: true })
    if (!options.child) {
      log = fs.openSync(logFile, 'a', 0o600)
      fs.chmodSync(logFile, 0o600)
    }
    processes = new Processes(root, config.env, log)
    receipt = {
      pid: process.pid,
      runId,
      // The state directory: it is what identifies the session (see supervisorOwned).
      root: home,
      port: config.port,
      url: config.url,
      dataDir: config.dataDir,
      workspaceDir: config.workspaceDir,
      leaseFile: config.leaseFile,
      mode: options.action === 'dev' ? 'dev' : 'run',
      startedAt: Date.now(),
      phase: 'preparing',
      options,
    }
    writeJson(receiptFile, receipt)
    fs.writeFileSync(pidFile, String(process.pid) + '\n', { mode: 0o600 })
    if (stopping) return exitCode
    await prepare(config, options, processes, () => stopping)
    if (stopping) return exitCode
    receipt.phase = 'starting'
    writeJson(receiptFile, receipt)
    const dev = options.action === 'dev'
    if (dev) layOutWebAssets(root)
    const server = dev
      ? processes.start('Dev server', process.execPath, [
          path.join(root, 'node_modules/tsx/dist/cli.mjs'),
          'watch',
          '--clear-screen=false',
          'server/src/index.ts',
        ])
      : // The server speaks to the log, not to the screen: its lines are for
        // whoever is fixing things, and the teacher needs the summary below
        // (launch-banner.ts).
        processes.start('Server', process.execPath, ['server/dist/server.js'], !options.child)
    started = true
    receipt.serverPid = server.child.pid
    writeJson(receiptFile, receipt)
    let frontend: ManagedProcess | undefined
    if (dev) {
      frontend = processes.start(
        'Dev frontend',
        process.execPath,
        [
          path.join(root, 'node_modules/vite/bin/vite.js'),
          path.join(root, 'web'),
          '--host',
          '127.0.0.1',
          '--port',
          String(config.uiPort),
          '--strictPort',
          '--clearScreen=false',
        ],
        false,
        {},
        path.join(root, 'web'),
      )
    }
    const deadline = Date.now() + 90000
    while (!stopping) {
      if (server.settled || frontend?.settled)
        throw new Error(
          dev
            ? 'The server or the frontend exited before it was ready. Check the log above.'
            : `The server exited before it was ready. Log: ${logFile}`,
        )
      const status = await health(config.port)
      const uiReady = !dev || (await devFrontendReady(config.url))
      if (status?.localRunId === runId && uiReady) break
      if (Date.now() > deadline)
        throw new Error(
          dev
            ? 'The server did not become ready in 90 seconds. Check Docker and the log above.'
            : `The server did not become ready in 90 seconds. Check Docker. Log: ${logFile}`,
        )
      await delay(150)
    }
    if (stopping) return exitCode
    receipt.phase = 'ready'
    if (publishing) receipt.hosting = 'starting'
    writeJson(receiptFile, receipt)
    if (!options.child) await banner(receipt, false)
    // Under --share the browser waits for the tunnel link (announceShare below).
    if (options.open && !options.share) openBrowser(teacherLink(config.url, config.dataDir))
    if (publishing) {
      /*
       * The path to the script is checked before the start, because its
       * absence gave no sign of itself. `bash scripts/host.sh` without the file
       * exits with code 127: hosting: 'failed' went into the receipt, and the
       * person read "Public access ended (code 127). Local work continues",
       * that is, "something ended", not "the class is not visible from
       * outside". People went to class with that. The refusal now names the
       * file and says what to do.
       *
       * The name is absolute: the child's cwd is the application directory,
       * and a relative name would be checked somewhere other than where it
       * runs.
       */
      const script = path.join(root, 'scripts/host.sh')
      /*
       * The publishing lock by the live server: the docker daemon answers, and
       * the server itself names what keeps the rooms apart (/api/health ·
       * isolation). Before the tunnel, not after: a door opened for a second is
       * still a door.
       */
      const docker = fs.existsSync(script)
        ? await capture(root, config.env, 'docker', ['info', '--format', '{{.ServerVersion}}'])
        : null
      const refusal = docker
        ? publishRefusal({
            env: config.env,
            dockerReachable: docker.code === 0,
            health: await health(config.port),
          })
        : null
      if (!fs.existsSync(script)) {
        receipt.hosting = 'failed'
        writeJson(receiptFile, receipt)
        console.error(
          `\nNot published: there is no ${script} next to the application.\n` +
            `The class runs locally: ${config.url}\n` +
            'The package looks built without scripts/: update colloq (pip install -U colloq).',
        )
      } else if (refusal) {
        receipt.hosting = 'failed'
        writeJson(receiptFile, receipt)
        console.error('\n' + refusalText(refusal, config.url))
      } else {
        /*
         * The state directory goes to the child as an explicit variable: the
         * script looks in it for .env, the class receipt and .colloq.pid, and
         * on its own it would take the directory above scripts/, which for an
         * installed colloq is the application directory, where none of that
         * exists (scripts/lib.sh · COLLOQ_STATE_ROOT). For a start from the
         * terminal COLLOQ_HOME may not be in the environment at all: the
         * supervisor works it out itself.
         *
         * For --share the name is empty on purpose: an empty COLLOQ_HOSTNAME is
         * exactly the quick tunnel, and a line in .env or in the shell must not
         * pull the link into a named one. COLLOQ_CLOUDFLARED is the file found
         * and checked above: the script does not look for it a second time.
         * COLLOQ_SHARE=1 asks the script not to print its own summary but to
         * say with a marker line that the address is up; we print the summary,
         * in one block (launch-share.ts).
         */
        const relayDomain = config.env.RELAY_DOMAIN?.trim() ?? ''
        tunnel = processes.start(
          'Public access',
          'bash',
          [script],
          false,
          {
            COLLOQ_HOME: home,
            ...(options.share
              ? {
                  COLLOQ_HOSTNAME: '',
                  COLLOQ_DIRECT: '',
                  COLLOQ_SHARE: '1',
                  COLLOQ_CLOUDFLARED: cloudflared ?? '',
                }
              : { COLLOQ_HOSTNAME: options.host }),
          },
          root,
          options.share
            ? (line) => {
                const shared = parseShareMarker(line)
                if (!shared || !receipt) return false
                void announceShare(shared.url, receipt, relayDomain, shared.verified, false)
                if (options.open) openBrowser(teacherLink(shared.url, receipt.dataDir))
                return true
              }
            : undefined,
        )
        void tunnel.done.then((code) => {
          if (!stopping && receipt) {
            receipt.hosting = 'failed'
            writeJson(receiptFile, receipt)
            console.log(
              `\nPublic access ended (code ${code}). Local work continues: ${config.url}\n` +
                (options.share
                  ? 'Try again: colloq host (a new quick tunnel — and a new address to send).'
                  : `Try again: colloq host ${options.host}`),
            )
          }
        })
      }
    }
    const ended = await Promise.race([server.done, ...(frontend ? [frontend.done] : [])])
    if (!stopping) {
      exitCode = ended || 1
      if (!dev) showLogTail()
      console.error('The local server or frontend exited. Stopping the remaining processes.')
    }
    return exitCode
  } catch (error) {
    if (!stopping) {
      if (log !== undefined && options.action !== 'dev') showLogTail()
      console.error(error instanceof Error ? error.message : String(error))
    }
    return stopping ? exitCode : 1
  } finally {
    stopping = true
    if (receipt && readReceipt(receiptFile)?.runId === runId) {
      receipt.phase = 'stopping'
      writeJson(receiptFile, receipt)
    }
    await stopPromise
    if (tunnel) await processes?.stop(tunnel, 5000)
    await processes?.stopAll(GRACE)
    const cleanupArgs = started && processes ? kernelCleanupArgs() : null
    if (started && processes && !cleanupArgs)
      /*
       * There is no safety net, and that is worth saying out loud, but not
       * worth breaking the stop over: a non-zero exit code will not shut down
       * a single container. The regular path has already removed the kernels:
       * on SIGTERM the server removes the room kernels itself
       * (server/src/index.ts, COLLOQ_STOP_KERNELS_ON_EXIT=1). What is lost is
       * only the backup for the case when the server died on its own and never
       * got to it.
       */
      console.error(
        'Nothing here can stop the kernels: neither server/dist/local-cleanup.js nor the source. ' +
          'Containers left behind are visible with: docker ps --filter name=colloq-room-',
      )
    if (processes && cleanupArgs) {
      const cleanup = processes.start('Stopping kernels', process.execPath, cleanupArgs)
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanupCode = await Promise.race([
        cleanup.done,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), GRACE)
        }),
      ])
      if (cleanupCode !== 0)
        cleanupFailure =
          cleanupCode === undefined
            ? 'Stopping the kernels timed out.'
            : `Stopping the kernels exited with code ${cleanupCode}.`
      if (timer) clearTimeout(timer)
      if (!cleanup.settled) {
        processes.signal(cleanup, 'SIGKILL')
        await cleanup.done
      }
    }
    if (receipt && readJson<{ runId: string }>(receipt.leaseFile)?.runId === runId) {
      try {
        fs.unlinkSync(receipt.leaseFile)
      } catch {}
    }
    if (receipt) writeJson(resultFile, { runId, error: cleanupFailure })
    if (readReceipt(receiptFile)?.runId === runId) fs.unlinkSync(receiptFile)
    try {
      if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile)
    } catch {}
    for (const release of releases.reverse()) release()
    if (log !== undefined) fs.closeSync(log)
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    process.off('SIGHUP', onHangup)
    process.stdout.off('error', onOutputError)
    process.stderr.off('error', onOutputError)
    if (cleanupFailure) throw new Error(cleanupFailure + ' Check colloq logs; the data is saved.')
  }
}

async function main(): Promise<number> {
  const options = parseLaunchArgs(process.argv.slice(2))
  if (options.action === 'cloudflared') {
    /*
     * A service word for scripts/host.sh: the path goes to stdout (the script
     * takes it through $(...)), the words about the download go to stderr,
     * straight into the person's terminal.
     */
    const file = await ensureCloudflared({
      home,
      env: effectiveEnv(),
      say: (line) => console.error(line),
    })
    process.stdout.write(file + '\n')
    return 0
  }
  if (options.action === 'stop') {
    await stopSession()
    return 0
  }
  if (options.action === 'restart') {
    const prior = await stopSession()
    if (!prior) return 1
    process.env.DATA_DIR = prior.dataDir
    process.env.WORKSPACE_DIR = prior.workspaceDir
    process.env.PORT = String(prior.port)
    const port = prior.mode === 'dev' ? Number(new URL(prior.url).port || 80) : prior.port
    return await runSession({
      ...prior.options,
      action: prior.mode,
      port,
      child: false,
      build: options.build,
      fast: options.fast || prior.options.fast,
    })
  }
  return await runSession(options)
}
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
