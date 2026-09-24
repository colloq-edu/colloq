/**
 * Tools, to look and to check: status and doctor.
 *
 * Two questions a teacher asks their laptop: "what is running on it now" and
 * "is everything in place before class". Both only read: they start nothing,
 * write nothing and do not go to the network: a screen looked at five minutes
 * before the bell has no right either to wait for another machine or to
 * change anything.
 *
 * The workshop (the activity sheet, the landing page, a course from the
 * timetable, the load test rig, renting machines) lives in the Makefile and
 * scripts/, and there is not a word about it from here: not a line on the
 * screen, not a hint. Advice there is no way to follow after `pip install
 * colloq` reads as a breakage, so every hint below names a command of this
 * CLI or something installed by hand (brew, pip).
 *
 * Exactly status, doctor and env list have --json: the command
 * declares the {name:'json'} flag, otherwise the framework refuses with code 2.
 *
 * node:child_process and node:fs must not be imported: only ctx.sh and ctx.io.
 */
import type { Command, Ctx } from '../registry.js'
import { SYMBOL } from '../ui.js'
import { joinPath } from '../env.js'
import { readSession, type Session } from '../session.js'
import { leaseUrl } from '../../../shared/local-public-url-lease.js'
// The same words colloq host says: two places, one wording; see PERIMETER in
// host.ts. They must not drift apart, otherwise one of the two would turn out
// to be untrue.
import { PERIMETER } from './host.js'

// ------------------------------------------------------------------ helpers

/** A boolean flag. */
function on(ctx: Ctx, name: string): boolean {
  return ctx.values[name] === true
}

/** The answer of a call that never happened: there is no program, nothing to ask. */
function missing(): Promise<{ code: number; stdout: string; stderr: string }> {
  return Promise.resolve({ code: 127, stdout: '', stderr: '' })
}

/**
 * What to fix the built application with.
 *
 * The panel arrives in the wheel ready and already compressed (scripts/pack.mts
 * builds it with build:optimized), and a teacher has nothing to build it with:
 * the package has neither an npm build nor the sources. If it is missing or
 * not compressed, the installation is incomplete, and there is one way out:
 * install the package again. The start (launch-prepare.ts) gives the same
 * advice, so that doctor and `colloq start` do not advise different things.
 *
 * From a working tree the advice is the same: the CLI behaves the same
 * wherever it is called from, and whoever holds the sources knows `npm run
 * build` without a hint.
 */
const REINSTALL = 'reinstall colloq: pip install --force-reinstall colloq'

/**
 * How to get the kernel image.
 *
 * `colloq env build` refuses on purpose for an installed colloq (there is no
 * reason to build the image in advance, the start does it), and sending a
 * person there means sending them into a refusal. The advice is one and the
 * same wherever the CLI is called from.
 */
const KERNEL_IMAGE_FIX = 'colloq start — the image is built before the class'

/** "01:14:23", "1-02:03:04", "05:23" → seconds. The etime format of ps is the same on both systems. */
export function parseEtime(value: string): number | null {
  const raw = value.trim()
  if (!/^(\d+-)?(\d+:)?\d+:\d+$/.test(raw)) return null
  let days = 0
  let rest = raw
  const dash = raw.indexOf('-')
  if (dash >= 0) {
    days = Number(raw.slice(0, dash))
    rest = raw.slice(dash + 1)
  }
  const parts = rest.split(':').map((piece) => Number(piece))
  const hours = parts.length === 3 ? (parts[0] ?? 0) : 0
  const minutes = parts.length === 3 ? (parts[1] ?? 0) : (parts[0] ?? 0)
  const seconds = parts.length === 3 ? (parts[2] ?? 0) : (parts[1] ?? 0)
  return days * 86400 + hours * 3600 + minutes * 60 + seconds
}

/** "1h 14m", "47s", "3d 2h". */
export function humanDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return total + 's'
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes ? hours + 'h ' + restMinutes + 'm' : hours + 'h'
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? days + 'd ' + restHours + 'h' : days + 'd'
}

/** "4h ago". */
function humanAge(milliseconds: number): string {
  return humanDuration(milliseconds / 1000) + ' ago'
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

/** "14:02". */
function clock(milliseconds: number): string {
  const date = new Date(milliseconds)
  return two(date.getHours()) + ':' + two(date.getMinutes())
}

/** "12.09". */
function day(milliseconds: number): string {
  const date = new Date(milliseconds)
  return two(date.getDate()) + '.' + two(date.getMonth() + 1)
}

/** The machine name from an address; no address means an empty string. */
export function hostOf(url: string): string {
  const value = url.trim()
  if (value === '') return ''
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value)
  const authority = match ? (match[1] ?? '') : value
  const host = authority.split('@').pop() ?? ''
  return host.replace(/:\d+$/, '').toLowerCase()
}

/**
 * Whether the address faces the outside. The three spellings of loopback are
 * the same ones the receipt accepts (session.ts · loopback): its address
 * comes here on a par with PUBLIC_URL, and `http://[::1]:4100` would count as
 * another machine, since the list used to have two.
 */
function outsideOf(url: string): boolean {
  const host = hostOf(url)
  return host !== '' && !['127.0.0.1', 'localhost', '[::1]'].includes(host)
}

/**
 * The address of the running class: the public one, if the session has a
 * live receipt for it.
 *
 * A class is exposed to the outside not through .env but through the
 * supervisor's own tunnel, and its address lies in a separate receipt
 * (leaseFile). Without it, what remains is the local address from the class
 * receipt, which is always loopback.
 */
function sessionAddress(ctx: Ctx, session: Session): string {
  if (session.leaseFile === '') return session.url
  return leaseUrl(ctx.io.readText(session.leaseFile), session.runId, ctx.io.now()) ?? session.url
}

/** The newest file of a directory with one of the extensions; no directory means null. */
function newestFile(
  ctx: Ctx,
  dir: string,
  keep: (name: string) => boolean,
): { name: string; at: number } | null {
  let best: { name: string; at: number } | null = null
  for (const name of ctx.io.list(dir)) {
    if (!keep(name)) continue
    const at = ctx.io.mtime(joinPath(dir, name))
    if (at === null) continue
    if (!best || at > best.at) best = { name, at }
  }
  return best
}

/** A "key value" line with a shared column: doctor's labels are longer than kv(12). */
function rowPrinter(ctx: Ctx, labels: string[]): (label: string, value: string) => void {
  // The symbol and the space before the label are the same two positions as ● in status.
  const width = Math.max(12, ...labels.map((label) => label.length + 4))
  return (label, value) => ctx.ui.line('  ' + label.padEnd(width) + value)
}

// ------------------------------------------------------------------ status

/**
 * One docker call for the whole screen: the room label, the compose service,
 * the state, and the CLASS the container belongs to.
 *
 * The class is needed because it has two containers: its own and the one
 * where its students' personal notebooks are computed. Counting lines would
 * mean writing "2 rooms" where a single class is going on.
 */
const PS_FORMAT =
  '{{.Label "colloq.kind"}}|{{.Label "com.docker.compose.service"}}|{{.State}}|{{.Label "colloq.session"}}'

type Status = {
  envName: string
  port: number
  kernelEnv: string
  publicUrl: string
  relayDomain: string
  form: string
  pid: number | null
  uptimeSec: number | null
  startedAt: number | null
  distAt: number | null
  stale: boolean
  transport: string
  tunnel: string
  tunnelPid: number | null
  rooms: number
  image: string
  imageAt: number | null
  dockerNote: string
  backupPath: string
  backupAt: number | null
}

async function statusFacts(ctx: Ctx): Promise<Status> {
  const { env, io, sh } = ctx
  const kernelEnv = env.kernelEnv()
  const relayDomain = env.relay().domain

  /*
   * The first source is the class receipt, the second is .env.
   *
   * Their questions differ: .env says what is configured, the receipt says what
   * the class is running on RIGHT NOW. `colloq run --port 4100` writes nothing
   * into .env, and live the screen printed "port 3000" while the class sat on
   * 4100. So the port, the address and the process numbers are taken from the
   * receipt, and only when there is none, from .env, as it always was.
   */
  const session = readSession(io, env.paths.sessionFile)
  const sessionUrl = session === null ? '' : sessionAddress(ctx, session)
  const envUrl = env.publicUrl()
  /*
   * Whose liveness we ask ps about. The port is held by the server, the
   * supervisor's child, and its number lies in the receipt in the serverPid
   * field; while the server is not up yet (phase preparing), the class is
   * running all the same, and the supervisor counts as alive. Without a
   * receipt there remains .colloq.pid: `make run` writes it in a working tree,
   * and it holds the number of the server itself.
   */
  const pidText = (io.readText(env.paths.pidFile) ?? '').trim()
  const filePid = /^\d+$/.test(pidText) ? Number(pidText) : null
  const pid = session === null ? filePid : (session.serverPid ?? session.pid)
  /*
   * We look for a tunnel if at least one of the two addresses faces the
   * outside: which of them is the real one becomes known only after ps, and an
   * extra pgrep costs next to nothing; otherwise we would have either to go to
   * the processes twice or to lose the "outside" line for a class with its own
   * tunnel.
   */
  const outside = outsideOf(sessionUrl) || outsideOf(envUrl)

  // Everything that can be asked of the system is asked at once: the screen
  // must make it within a second.
  const [docker, image, etime, frpc, cloudflared] = await Promise.all([
    sh.capture('docker', ['ps', '--format', PS_FORMAT], { timeoutMs: 700 }),
    sh.capture(
      'docker',
      ['image', 'inspect', 'colloq-kernel:' + kernelEnv, '--format', '{{.Created}}'],
      { timeoutMs: 700 },
    ),
    // The pid's liveness and uptime in one ps line, which exists on both macOS and Linux.
    pid === null
      ? missing()
      : sh.capture('ps', ['-p', String(pid), '-o', 'etime='], {
          timeoutMs: 300,
        }),
    outside ? sh.capture('pgrep', ['-x', 'frpc'], { timeoutMs: 300 }) : missing(),
    outside ? sh.capture('pgrep', ['-x', 'cloudflared'], { timeoutMs: 300 }) : missing(),
  ])

  const seen = new Set<string>()
  let appRunning = false
  for (const line of docker.stdout.split('\n')) {
    const [kind, compose, state, session] = line.split('|')
    // By classes, not by containers: one class has two of them.
    if ((kind ?? '') === 'room-kernel') seen.add((session ?? '').trim() || line)
    if ((compose ?? '') === 'app' && (state ?? '').toLowerCase().includes('running')) {
      appRunning = true
    }
  }
  const rooms = seen.size
  const dockerNote =
    docker.code === 0
      ? ''
      : docker.code === 124
        ? 'docker did not answer in 0.7s'
        : docker.code === 127
          ? 'docker not found'
          : 'docker is not answering'

  const uptimeSec = etime.code === 0 ? parseEtime(etime.stdout) : null
  const alive = etime.code === 0 && uptimeSec !== null
  /*
   * A receipt without a live process is a trace of a killed class: kill -9
   * does not remove it. It cannot be trusted then, otherwise the screen would
   * print the port and address of a class that does not exist, so everything
   * falls back to .env.
   */
  const live: Session | null = alive ? session : null
  const port = live ? live.port : env.port()
  const publicUrl = live ? sessionUrl : envUrl
  const host = hostOf(publicUrl)
  const published = outsideOf(publicUrl)
  /*
   * The form is what this server was started with, and it is named by the
   * command that starts it: by it the person will also understand what to stop
   * it with.
   *
   * The receipt comes first: if it is alive, the port and the numbers are
   * already taken from it, and calling this same class a "container" would
   * mean assembling two different servers on one line. The supervisor's dev
   * mode is started with `npm run dev` in a working tree: the CLI has no such
   * command, and calling it `colloq dev` would send people to a word it does
   * not know. Then comes what happens on a laptop without a receipt: the
   * compose container app (`make up`) and a server that `make run` left in
   * .colloq.pid. A systemd service and a cluster are forms of a dedicated
   * machine; the teacher's CLI does not have them.
   */
  const form = live
    ? live.mode === 'dev'
      ? 'npm run dev'
      : 'colloq run'
    : appRunning
      ? 'container'
      : alive
        ? 'make run'
        : rooms > 0
          ? 'another form'
          : ''

  const startedAt = uptimeSec === null ? null : ctx.io.now() - uptimeSec * 1000
  const distAt = newestDist(ctx)
  const stale = distAt !== null && startedAt !== null && distAt > startedAt

  const transport = !published
    ? ''
    : relayDomain !== '' && (host === relayDomain || host.endsWith('.' + relayDomain))
      ? 'relay'
      : 'Cloudflare'
  const frpcPid = firstPid(frpc)
  const cloudflaredPid = firstPid(cloudflared)
  const tunnelPid = transport === 'relay' ? frpcPid : cloudflaredPid
  const tunnel = transport === 'relay' ? 'frpc' : 'cloudflared'

  const imageAt = image.code === 0 ? dateValue(image.stdout) : null
  const envName = host === '' || !published ? '' : (host.split('.')[0] ?? '')
  const backupDir =
    envName !== '' && io.exists(joinPath(env.paths.backupsDir, envName))
      ? joinPath(env.paths.backupsDir, envName)
      : env.paths.backupsDir
  const backup = newestFile(ctx, backupDir, (name) => /\.(db|tar\.gz|tgz|zip)$/.test(name))

  return {
    envName,
    port,
    kernelEnv,
    publicUrl,
    relayDomain,
    form,
    /*
     * Under the "server" label stands the number of the SERVER, and only it:
     * doctor names the port listener by the same number, and before this fix
     * the two screens called one and the same server differently, status by
     * the supervisor's number, doctor by its child's. While the class server
     * is not up yet, there is no number at all, and the line makes do with the
     * port and the time: showing the supervisor instead would bring back the
     * same confusion. The number from .colloq.pid is printed only if ps
     * confirmed it is alive: next to "container", a dead number from an
     * earlier `make run` would pass itself off as the container's server.
     */
    pid: live ? live.serverPid : alive ? pid : null,
    uptimeSec,
    startedAt,
    distAt,
    stale,
    transport,
    tunnel,
    tunnelPid,
    rooms,
    image: 'colloq-kernel:' + kernelEnv,
    imageAt,
    dockerNote,
    backupPath: backup ? joinPath(backupDir, backup.name) : '',
    backupAt: backup ? backup.at : null,
  }
}

/** The newest mtime inside web/dist: the root and assets/. */
function newestDist(ctx: Ctx): number | null {
  const dist = ctx.env.paths.dist
  if (!ctx.io.exists(dist)) return null
  let best: number | null = null
  for (const dir of [dist, joinPath(dist, 'assets')]) {
    for (const name of ctx.io.list(dir)) {
      const at = ctx.io.mtime(joinPath(dir, name))
      if (at === null) continue
      if (best === null || at > best) best = at
    }
  }
  return best
}

function firstPid(result: { code: number; stdout: string }): number | null {
  if (result.code !== 0) return null
  const line = result.stdout.split('\n').find((item) => /^\d+$/.test(item.trim()))
  return line ? Number(line.trim()) : null
}

function dateValue(value: string): number | null {
  const at = Date.parse(value.trim())
  return Number.isFinite(at) ? at : null
}

function renderStatus(ctx: Ctx, facts: Status): void {
  const { ui } = ctx
  const empty =
    facts.form === '' && facts.rooms === 0 && facts.publicUrl === '' && facts.pid === null
  if (empty) {
    ui.line('nothing is running · ' + ui.cyan('colloq run'))
    return
  }

  ui.header('Colloq · ' + (facts.envName || 'local'))
  serverLine(ctx, facts)

  // The client is the main line of the screen: a built panel newer than the
  // server means the class sees the previous version, and there is no way to
  // tell that from the code.
  if (facts.distAt === null) {
    ui.kv(SYMBOL.off + ' client', 'the frontend is not built')
    ui.hint(REINSTALL)
  } else if (facts.stale) {
    ui.kv(
      SYMBOL.on + ' client',
      'web/dist built ' +
        clock(facts.distAt) +
        ' — newer than the server (started ' +
        clock(facts.startedAt ?? 0) +
        ')',
    )
    ui.hint('colloq restart')
  } else {
    ui.kv(SYMBOL.on + ' client', 'web/dist built ' + clock(facts.distAt))
  }

  publicLine(ctx, facts)
  // The link on a separate line only when there is someone to give it to: the
  // "outside" line already names the local address, and a second time it
  // reads as a different one.
  if (facts.transport !== '' && facts.publicUrl !== '') ui.kv('  link', ui.cyan(facts.publicUrl))

  if (facts.dockerNote !== '') ui.kv(SYMBOL.off + ' kernels', facts.dockerNote)
  else if (facts.imageAt === null) {
    ui.kv(
      SYMBOL.off + ' kernels',
      'no ' + facts.image + ' image · rooms with a kernel: ' + facts.rooms,
    )
    ui.hint(KERNEL_IMAGE_FIX)
  } else {
    ui.kv(
      SYMBOL.on + ' kernels',
      facts.image + ', built ' + day(facts.imageAt) + ' · rooms with a kernel: ' + facts.rooms,
    )
  }
  ui.kv('  env', facts.kernelEnv, 'change: colloq env use <name>')
  backupLine(ctx, facts)
}

/**
 * The "server" line. hint:false is for --short: two lines are promised to be
 * exactly two, and a hint under a server that is not running made them three
 * precisely when there is nothing to look at.
 */
function serverLine(ctx: Ctx, facts: Status, hint = true): void {
  const { ui } = ctx
  if (facts.form === '') {
    ui.kv(SYMBOL.off + ' server', 'not running · port ' + facts.port)
    if (hint) ui.hint('colloq run')
    return
  }
  const parts: string[] = []
  if (facts.pid !== null) parts.push('pid ' + facts.pid)
  parts.push('port ' + facts.port)
  if (facts.uptimeSec !== null) parts.push(humanDuration(facts.uptimeSec))
  parts.push(facts.form)
  ui.kv(SYMBOL.on + ' server', parts.join(' · '))
}

function publicLine(ctx: Ctx, facts: Status): void {
  const { ui } = ctx
  const host = hostOf(facts.publicUrl)
  if (facts.transport === '') {
    ui.kv(
      SYMBOL.off + ' outside',
      'not published · ' + (facts.publicUrl || 'this machine') + ' only',
    )
    ui.hint('colloq host <name>')
    return
  }
  const tail =
    facts.tunnelPid === null
      ? ' — no tunnel process'
      : ' (' + facts.tunnel + ' pid ' + facts.tunnelPid + ')'
  ui.kv(SYMBOL.on + ' outside', host + ' · ' + facts.transport + tail)
}

/** The second line of --short: the same as "outside", but without the hint. */
function publicLineShort(ctx: Ctx, facts: Status): void {
  const host = hostOf(facts.publicUrl)
  if (facts.transport === '') {
    ctx.ui.kv(SYMBOL.off + ' outside', 'not published · colloq host <name>')
    return
  }
  const tail =
    facts.tunnelPid === null
      ? ' — no tunnel process'
      : ' (' + facts.tunnel + ' pid ' + facts.tunnelPid + ')'
  ctx.ui.kv(SYMBOL.on + ' outside', host + ' · ' + facts.transport + tail)
}

function backupLine(ctx: Ctx, facts: Status): void {
  const { ui } = ctx
  if (facts.backupAt === null) {
    ui.kv(SYMBOL.off + ' backup', 'no backups')
    ui.hint('colloq backup')
    return
  }
  const name = facts.backupPath.split('/').pop() ?? facts.backupPath
  ui.kv(SYMBOL.on + ' backup', name + ' · ' + humanAge(ctx.io.now() - facts.backupAt))
}

// ------------------------------------------------------------------ doctor

type Check = {
  id: string
  label: string
  ok: boolean
  optional: boolean
  value: string
  hint: string
}

/** What the class goes outside with: the relay or a quick tunnel. */
const PROGRAMS = ['frpc', 'cloudflared'] as const

/*
 * The check-up answers one question: will the class run on THIS machine and
 * will it let the students in. The keys of other people's infrastructure
 * (renting, the relay as a machine, Cloudflare, the activity sheet), build
 * tools and the forms of a dedicated machine fall outside this question: the
 * workshop checks them with its own scripts.
 *
 * There is no network here at all. The only network check was about the relay
 * as a machine, a question for whoever maintains it, not for whoever teaches
 * the class; the --offline flag went along with it, there was nothing left to
 * switch off.
 */
async function doctorChecks(ctx: Ctx): Promise<Check[]> {
  const { env, io, sh } = ctx
  const kernelEnv = env.kernelEnv()
  const relay = env.relay()
  const pidText = (io.readText(env.paths.pidFile) ?? '').trim()
  /*
   * The check-up goes by the port the class runs on, not by the one written in
   * .env: `colloq run --port 4100` does not touch .env, and a check of port
   * 3000 would answer "free" about a port the class has never laid eyes on.
   */
  const session = readSession(io, env.paths.sessionFile)
  const port = session?.port ?? env.port()

  const [programs, info, image, listen, disk] = await Promise.all([
    // One shell for both programs: separate calls would take twice as long.
    sh.capture(
      'sh',
      [
        '-c',
        PROGRAMS.map((name) => 'command -v ' + name + ' >/dev/null 2>&1 && echo ' + name).join(
          '; ',
        ),
      ],
      {
        timeoutMs: 3000,
      },
    ),
    sh.capture('docker', ['info', '--format', '{{.ServerVersion}} {{.Name}} {{.MemTotal}}'], {
      timeoutMs: 3000,
    }),
    sh.capture(
      'docker',
      ['image', 'inspect', 'colloq-kernel:' + kernelEnv, '--format', '{{.Created}}'],
      { timeoutMs: 3000 },
    ),
    // LISTEN only: someone else's CLOSE_WAIT once already gave a false "port taken".
    sh.capture('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { timeoutMs: 2000 }),
    /*
     * We measure space on the volume of the STATE directory, not of the
     * application. Everything grows there: <home>/data, <home>/workspace,
     * <home>/backups, <home>/.colloq.log, and the hint below itself asks to
     * clean up backups/. For colloq installed through pip the directories
     * differ, and may easily be on different volumes: the check-up showed the
     * free space under site-packages, while it was the data that ran out of
     * it.
     */
    sh.capture('df', ['-k', env.paths.home], { timeoutMs: 2000 }),
  ])

  const found = new Set(programs.stdout.split('\n').map((line) => line.trim()))
  const checks: Check[] = []
  const add = (check: Check): void => void checks.push(check)

  const major = Number.parseInt((process.version ?? 'v0').slice(1), 10)
  add({
    id: 'node',
    label: 'node',
    ok: Number.isFinite(major) && major >= 22,
    optional: false,
    value: process.version ?? 'unknown',
    hint: 'Node ≥ 22 is required: brew install node',
  })

  const daemon = info.code === 0 ? info.stdout.trim().split(/\s+/) : []
  const memTotal = daemon.length ? Number(daemon[daemon.length - 1]) : 0
  const daemonName = daemon.length >= 2 ? daemon.slice(1, -1).join(' ') : ''
  const enoughMemory = memTotal >= 4 * 1024 ** 3
  add({
    id: 'docker',
    label: 'docker',
    ok: info.code === 0 && enoughMemory,
    optional: false,
    value:
      info.code !== 0
        ? 'the daemon is not answering'
        : daemonName +
          ', ' +
          (memTotal / 1024 ** 3).toFixed(0) +
          ' GB' +
          (enoughMemory ? '' : ' — not enough for a room kernel'),
    hint:
      info.code !== 0
        ? 'start Docker Desktop or colima start'
        : 'raise docker memory: under 4 GB the room kernel is killed by OOM',
  })

  const listener = listen.code === 0 ? listenerOf(listen.stdout) : null
  /*
   * Whose listener this is; the answer used to be "always someone else's".
   *
   * The port is held by the server, and it is the supervisor's child;
   * .colloq.pid holds the number of the supervisor ITSELF, and the comparison
   * with it never matched. Live, during a healthy class, doctor printed "✗ port
   * 3000 · taken: node pid 14552 — a second Colloq", advised colloq stop and
   * returned code 3, that is, told the teacher to stop their own class.
   *
   * Both of our numbers come from the receipt: serverPid is the one listening
   * now, the supervisor's pid is the one that will turn out to be the
   * listener if the server was restarted and the receipt has not been
   * rewritten yet. .colloq.pid stays the third: without a receipt `make run`
   * writes it in a working tree, and it holds the number of the server itself.
   */
  const ourPids = new Set<number>()
  if (session !== null) {
    ourPids.add(session.pid)
    if (session.serverPid !== null) ourPids.add(session.serverPid)
  }
  if (/^\d+$/.test(pidText)) ourPids.add(Number(pidText))
  const ours = listener !== null && ourPids.has(listener.pid)
  add({
    id: 'port',
    label: 'port ' + port,
    ok: listen.code === 127 ? false : listener === null || ours,
    optional: listen.code === 127,
    value:
      listen.code === 127
        ? 'no lsof — the port cannot be checked'
        : listener === null
          ? 'free'
          : ours
            ? 'our server is listening, pid ' + listener.pid
            : 'taken: ' + listener.name + ' pid ' + listener.pid + ' — a second Colloq',
    hint: 'colloq stop · colloq status (never pkill by name)',
  })

  add({
    id: 'kernel-image',
    label: 'kernel image',
    ok: image.code === 0,
    optional: false,
    value:
      image.code === 0 ? 'colloq-kernel:' + kernelEnv : 'no colloq-kernel:' + kernelEnv + ' image',
    hint: KERNEL_IMAGE_FIX,
  })

  /*
   * The environment list is looked for in BOTH directories, as in `colloq env
   * list`.
   *
   * Looking only into the shipped one would mean saying "no
   * kernel/environments/mlcourse.txt" about an environment the person created
   * themselves a minute ago and which lies intact in their directory, and so
   * sending them to fix what is not broken. env.paths knows the directories
   * (env.ts · envDir, ownEnvDir).
   */
  const ownEnvFile = joinPath(env.paths.ownEnvDir, kernelEnv + '.txt')
  const appEnvFile = joinPath(env.paths.envDir, kernelEnv + '.txt')
  const envFileAt = io.exists(ownEnvFile) ? ownEnvFile : io.exists(appEnvFile) ? appEnvFile : ''
  add({
    id: 'kernel-env-file',
    label: 'environment',
    ok: envFileAt !== '',
    optional: false,
    value:
      envFileAt === ''
        ? 'no ' + kernelEnv + '.txt list in either environment directory'
        : kernelEnv + '.txt in place' + (envFileAt === ownEnvFile ? ' · your own' : ''),
    hint: 'colloq env list · colloq env new <name>',
  })

  const distNames = io.list(env.paths.dist)
  const assets = io.list(joinPath(env.paths.dist, 'assets'))
  // We count only what compresses: fonts and images never get a .br, and the
  // builder skips the smallest files on its own, hence a share, not "all".
  const plain = assets.filter((name) => /\.(js|css|html|json|svg)$/.test(name))
  const squeezed = plain.filter((name) => assets.includes(name + '.br'))
  const hasDist = distNames.length > 0
  const share = plain.length === 0 ? 1 : squeezed.length / plain.length
  add({
    id: 'web-dist',
    label: 'web/dist',
    ok: hasDist && share >= 0.8,
    optional: hasDist,
    value: !hasDist
      ? 'the frontend is not built'
      : share >= 0.8
        ? 'built, pre-compressed: ' + squeezed.length + ' of ' + plain.length
        : 'the frontend is not pre-compressed — 11.6ms and 25 KB per student per file',
    hint: REINSTALL,
  })

  /*
   * Both programs are installed by hand, and the advice is the same words
   * scripts/host.sh refuses with when it does not find them: doctor and
   * `colloq host` share it.
   */
  const wantRelay = relay.domain !== ''
  add({
    id: 'frpc',
    label: 'frpc',
    ok: found.has('frpc'),
    optional: !wantRelay,
    value: found.has('frpc')
      ? 'present'
      : wantRelay
        ? 'missing — no way out under *.' + relay.domain
        : 'the relay is not set up',
    hint: 'brew install frpc',
  })
  add({
    id: 'cloudflared',
    label: 'cloudflared',
    ok: found.has('cloudflared'),
    optional: true,
    value: found.has('cloudflared')
      ? 'present'
      : 'missing — the quick tunnel will not start (not needed for *.colloq.ru)',
    hint: 'brew install cloudflared',
  })

  const oracle = env.has('OPENAI_API_KEY') || env.has('OPENROUTER_API_KEY')
  add({
    id: 'oracle',
    label: 'Oracle',
    ok: oracle,
    optional: true,
    value: oracle ? 'key present' : 'no key — suggestions are off',
    hint: 'OPENAI_API_KEY or OPENROUTER_API_KEY in .env',
  })

  const freeGb = freeSpaceGb(disk)
  add({
    id: 'disk',
    label: 'disk space',
    ok: freeGb !== null && freeGb >= 15,
    optional: freeGb === null || freeGb >= 5,
    value:
      freeGb === null
        ? 'df did not answer'
        : freeGb < 5
          ? freeGb.toFixed(1) + ' GB — an image build and a backup will not fit'
          : freeGb < 15
            ? freeGb.toFixed(1) + ' GB — barely enough for an image and a backup'
            : freeGb.toFixed(0) + ' GB',
    hint: 'clear old backups out of ' + env.paths.backupsDir,
  })

  /*
   * The room network is a check of a setting, not words. By default the
   * kernels do not reach local addresses (the LAN, the router, the computer
   * itself, cloud metadata; server/src/kernel/perimeter.ts), and that is ✓.
   * COLLOQ_ROOM_NETWORK=open lifts the block: ○, as with any switched-off
   * capability: it does not count as an error (so decided whoever wrote the
   * line), but it is said out loud before every class. Whether the block
   * actually took effect doctor does not know and does not ask: that is
   * visible in the log at server start, and without the block the rooms do not
   * come up at all, with a text about what to do.
   */
  const roomNetworkOpen = env.read('COLLOQ_ROOM_NETWORK').trim().toLowerCase() === 'open'
  add({
    id: 'room-network',
    label: 'room network',
    ok: !roomNetworkOpen,
    optional: true,
    value: roomNetworkOpen
      ? 'open (COLLOQ_ROOM_NETWORK=open): rooms reach your LAN, router and this computer'
      : 'local addresses blocked: LAN, router, this computer, cloud metadata',
    hint: 'remove COLLOQ_ROOM_NETWORK=open from .env, then colloq restart',
  })

  // The last line is the perimeter. It is not a check: there is nothing to fix
  // here, and "broken" never happens here. Hence ○ and optional:true, the same
  // sign doctor uses to say "a capability is switched off, and that is not an
  // error": the exit code does not change because of it, and the hint is
  // printed (it is shown for every non-ok line) and finishes saying what to
  // do if your own class is not enough.
  add({
    id: 'perimeter',
    label: 'perimeter',
    ok: false,
    optional: true,
    value: PERIMETER.what,
    hint: PERIMETER.fix,
  })

  return checks
}

function listenerOf(stdout: string): { name: string; pid: number } | null {
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    if (parts[0] === 'COMMAND') continue
    if (!/^\d+$/.test(parts[1] ?? '')) continue
    return { name: parts[0] ?? '', pid: Number(parts[1]) }
  }
  return null
}

function freeSpaceGb(result: { code: number; stdout: string }): number | null {
  if (result.code !== 0) return null
  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '')
  const last = lines[lines.length - 1] ?? ''
  const parts = last.trim().split(/\s+/)
  const kb = Number(parts[3])
  return Number.isFinite(kb) ? kb / 1024 / 1024 : null
}

// ------------------------------------------------------------------ registry

export const commands: Command[] = [
  {
    name: 'status',
    aliases: ['st'],
    group: 'tools',
    summary: 'Show what is on this machine right now: one screen, no network',
    usage: 'colloq status [--short] [--json]',
    flags: [
      { name: 'short', summary: 'Two lines: the server and the outside' },
      { name: 'json', summary: 'Machine-readable' },
    ],
    destructive: false,
    delegates:
      'native: .colloq/local-session.json, .env, .colloq.pid, ps, docker ps, web/dist, backups/',
    examples: ['colloq status', 'colloq status --short'],
    notes:
      'Reading only, and no network at all. The port, the address and the server pid come from the receipt of the class that is running, and only when there is no receipt — from .env: `colloq run --port 4100` writes nothing into .env. Under the "server" label stands the pid of the server, not of the supervisor: the same one doctor names as the listener on the port. Docker is asked once, with a ceiling of 0.7s — no answer means one line about docker, and the screen prints on.',
    async run(ctx) {
      if (ctx.dryRun) {
        return ctx.sh.dry('native: status (reads the class receipt, .env, .colloq.pid, docker ps)')
      }
      const facts = await statusFacts(ctx)
      if (ctx.json) {
        ctx.ui.json({
          ok: true,
          server: {
            form: facts.form,
            pid: facts.pid,
            port: facts.port,
            uptimeSec: facts.uptimeSec,
          },
          client: {
            builtAt: facts.distAt === null ? null : new Date(facts.distAt).toISOString(),
            stale: facts.stale,
          },
          public: {
            url: facts.publicUrl,
            transport: facts.transport,
            tunnelPid: facts.tunnelPid,
          },
          kernel: {
            image: facts.image,
            builtAt: facts.imageAt === null ? null : new Date(facts.imageAt).toISOString(),
            env: facts.kernelEnv,
            rooms: facts.rooms,
          },
          backup: {
            path: facts.backupPath,
            ageSec:
              facts.backupAt === null ? null : Math.round((ctx.io.now() - facts.backupAt) / 1000),
          },
        })
        return 0
      }
      if (on(ctx, 'short')) {
        // Exactly two lines and no hints: "is it running and is it visible
        // from outside" at a glance, without the rest of the screen.
        serverLine(ctx, facts, false)
        publicLineShort(ctx, facts)
        return 0
      }
      renderStatus(ctx, facts)
      return 0
    },
  },

  {
    name: 'doctor',
    group: 'tools',
    summary: 'Check that everything is in place before a class',
    usage: 'colloq doctor [--json]',
    flags: [{ name: 'json', summary: 'Machine-readable' }],
    destructive: false,
    delegates: 'native: programs, docker, the port, the kernel image, files, disk space',
    examples: ['colloq doctor', 'colloq doctor --json'],
    notes:
      '✗ — broken, fix it; ○ — a capability is switched off, and that is not an error. Out of .env only the port and the kernel environment are printed; keys are only "present / missing". The port that gets checked is the one the class runs on (from the receipt), and its listener counts as ours by the pids of the server and of the supervisor. No network at all. Code 3 if there is at least one ✗. The last line is about the perimeter: it checks nothing and does not change the code, it says how a local class differs from a server installation.',
    async run(ctx) {
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: doctor (programs, docker, the port, the kernel image, files, disk space)',
        )
      }
      const checks = await doctorChecks(ctx)
      const broken = checks.filter((check) => !check.ok && !check.optional)
      if (ctx.json) {
        ctx.ui.json(
          checks.map((check) => ({
            id: check.id,
            ok: check.ok,
            optional: check.optional,
            value: check.value,
            hint: check.ok ? '' : check.hint,
          })),
        )
        return broken.length ? 3 : 0
      }
      const row = rowPrinter(
        ctx,
        checks.map((check) => check.label),
      )
      for (const check of checks) {
        const symbol = check.ok ? SYMBOL.ok : check.optional ? SYMBOL.off : SYMBOL.bad
        row(symbol + ' ' + check.label, check.value)
        if (!check.ok) ctx.ui.hint(check.hint)
      }
      return broken.length ? 3 : 0
    },
  },
]
