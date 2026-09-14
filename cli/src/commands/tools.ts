/**
 * Инструменты — посмотреть, проверить, посчитать.
 *
 * Цели группы: status, doctor, activity, site, course, load, make
 * (make status, make activity, make site, make course, make load; doctor и
 * make — свои).
 *
 * --json есть ровно у status, doctor и env list: команда
 * объявляет флаг {name:'json'}, иначе каркас откажет с кодом 2.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.sh и ctx.io.
 */
import type { Command, Ctx } from '../registry.js'
import { PreconditionError, roomsWord, SYMBOL, UsageError } from '../ui.js'
import { joinPath } from '../env.js'
import { TCP_PROBE } from '../sh.js'

// ------------------------------------------------------------------ мелочь

/** Значение строкового флага без краёв; нет флага — пустая строка. */
function text(ctx: Ctx, name: string): string {
  const value = ctx.values[name]
  return typeof value === 'string' ? value.trim() : ''
}

/** Булев флаг. */
function on(ctx: Ctx, name: string): boolean {
  return ctx.values[name] === true
}

/** Отказ группы: три строки и код 1 — до всякого делегирования. */
function refuse(what: string, why: string, fix: string): never {
  throw new UsageError(what, fix, why)
}

/** Проверка до вопроса: каркас зовёт её раньше, чем спрашивает. */
function checker(find: (ctx: Ctx) => [string, string, string] | null): (ctx: Ctx) => void {
  return (ctx: Ctx) => {
    const trouble = find(ctx)
    if (trouble) refuse(...trouble)
  }
}

/** Ответ несостоявшегося вызова: программы нет, спрашивать нечего. */
function missing(): Promise<{ code: number; stdout: string; stderr: string }> {
  return Promise.resolve({ code: 127, stdout: '', stderr: '' })
}

/** «01:14:23», «1-02:03:04», «05:23» → секунды. Формат etime у ps один на обеих системах. */
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

/** «1 ч 14 мин», «47 с», «3 дн 2 ч». */
export function humanDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return total + ' с'
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return minutes + ' мин'
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes ? hours + ' ч ' + restMinutes + ' мин' : hours + ' ч'
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? days + ' дн ' + restHours + ' ч' : days + ' дн'
}

/** «4 ч назад». */
function humanAge(milliseconds: number): string {
  return humanDuration(milliseconds / 1000) + ' назад'
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

/** «14:02». */
function clock(milliseconds: number): string {
  const date = new Date(milliseconds)
  return two(date.getHours()) + ':' + two(date.getMinutes())
}

/** «12.09». */
function day(milliseconds: number): string {
  const date = new Date(milliseconds)
  return two(date.getDate()) + '.' + two(date.getMonth() + 1)
}

/** Имя машины из адреса; адреса нет — пустая строка. */
export function hostOf(url: string): string {
  const value = url.trim()
  if (value === '') return ''
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value)
  const authority = match ? (match[1] ?? '') : value
  const host = authority.split('@').pop() ?? ''
  return host.replace(/:\d+$/, '').toLowerCase()
}

/** Развернуть тильду: в .env путь к ключу пишут как ~/.ssh/id_ed25519. */
function expandHome(ctx: Ctx, path: string): string {
  const home = ctx.env.home()
  if (path === '~') return home
  if (path.startsWith('~/')) return joinPath(home, path.slice(2))
  return path
}

/** Самый свежий файл каталога с одним из расширений; нет каталога — null. */
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

/** Строка «ключ значение» с общей колонкой: у доктора подписи длиннее kv(12). */
function rowPrinter(ctx: Ctx, labels: string[]): (label: string, value: string) => void {
  // Символ и пробел перед подписью — те же две позиции, что у ● в status.
  const width = Math.max(12, ...labels.map((label) => label.length + 4))
  return (label, value) => ctx.ui.line('  ' + label.padEnd(width) + value)
}

// ------------------------------------------------------------------ status

/** Один вызов docker на весь экран: метка комнаты, служба compose, состояние. */
const PS_FORMAT = '{{.Label "colloq.kind"}}|{{.Label "com.docker.compose.service"}}|{{.State}}'

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
  const port = env.port()
  const kernelEnv = env.kernelEnv()
  const publicUrl = env.publicUrl()
  const relayDomain = env.relay().domain
  const host = hostOf(publicUrl)
  const outside = host !== '' && host !== '127.0.0.1' && host !== 'localhost'
  const cluster = env.read('COLLOQ_CLUSTER') === '1'
  const hasUnit = io.exists(env.paths.serviceUnit)
  const pidText = (io.readText(env.paths.pidFile) ?? '').trim()
  const pid = /^\d+$/.test(pidText) ? Number(pidText) : null

  // Порядок тот же, что в scripts/host.sh:387-397. Всё, что можно спросить у
  // системы, спрашивается разом: экран должен успеть за секунду.
  const [service, docker, image, etime, frpc, cloudflared] = await Promise.all([
    hasUnit ? sh.capture('systemctl', ['is-active', 'colloq'], { timeoutMs: 300 }) : missing(),
    sh.capture('docker', ['ps', '--format', PS_FORMAT], { timeoutMs: 700 }),
    sh.capture(
      'docker',
      ['image', 'inspect', 'colloq-kernel:' + kernelEnv, '--format', '{{.Created}}'],
      { timeoutMs: 700 },
    ),
    // Живость pid и время работы — одной строкой ps, она есть и на macOS, и на Linux.
    pid === null
      ? missing()
      : sh.capture('ps', ['-p', String(pid), '-o', 'etime='], {
          timeoutMs: 300,
        }),
    outside ? sh.capture('pgrep', ['-x', 'frpc'], { timeoutMs: 300 }) : missing(),
    outside ? sh.capture('pgrep', ['-x', 'cloudflared'], { timeoutMs: 300 }) : missing(),
  ])

  let rooms = 0
  let appRunning = false
  for (const line of docker.stdout.split('\n')) {
    const [kind, compose, state] = line.split('|')
    if ((kind ?? '') === 'room-kernel') rooms++
    if ((compose ?? '') === 'app' && (state ?? '').toLowerCase().includes('running')) {
      appRunning = true
    }
  }
  const dockerNote =
    docker.code === 0
      ? ''
      : docker.code === 124
        ? 'docker не ответил за 0,7 с'
        : docker.code === 127
          ? 'docker не найден'
          : 'docker не отвечает'

  const uptimeSec = etime.code === 0 ? parseEtime(etime.stdout) : null
  const alive = etime.code === 0 && uptimeSec !== null
  const form = cluster
    ? 'кластер'
    : service.code === 0
      ? 'служба'
      : appRunning
        ? 'контейнер'
        : alive
          ? 'make run'
          : rooms > 0
            ? 'другая форма'
            : ''

  const startedAt = uptimeSec === null ? null : ctx.io.now() - uptimeSec * 1000
  const distAt = newestDist(ctx)
  const stale = distAt !== null && startedAt !== null && distAt > startedAt

  const transport = !outside
    ? ''
    : relayDomain !== '' && (host === relayDomain || host.endsWith('.' + relayDomain))
      ? 'ретранслятор'
      : 'Cloudflare'
  const frpcPid = firstPid(frpc)
  const cloudflaredPid = firstPid(cloudflared)
  const tunnelPid = transport === 'ретранслятор' ? frpcPid : cloudflaredPid
  const tunnel = transport === 'ретранслятор' ? 'frpc' : 'cloudflared'

  const imageAt = image.code === 0 ? dateValue(image.stdout) : null
  const envName = host === '' || !outside ? '' : (host.split('.')[0] ?? '')
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
    pid: alive || form !== '' ? pid : null,
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

/** Самый свежий mtime внутри web/dist: корень и assets/. */
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
    ui.line('ничего не запущено · ' + ui.cyan('colloq run'))
    return
  }

  ui.header('Colloq · ' + (facts.envName || 'локально'))
  serverLine(ctx, facts)

  // Клиент — главная строка экрана: собранная панель старше сервера значит,
  // что класс видит прошлую версию, и по коду этого не понять никак.
  if (facts.distAt === null) {
    ui.kv(SYMBOL.off + ' клиент', 'фронтенд не собран')
    ui.hint('colloq build')
  } else if (facts.stale) {
    ui.kv(
      SYMBOL.on + ' клиент',
      'web/dist собран ' +
        clock(facts.distAt) +
        ' — новее сервера (поднят ' +
        clock(facts.startedAt ?? 0) +
        ')',
    )
    ui.hint('colloq restart')
  } else {
    ui.kv(SYMBOL.on + ' клиент', 'web/dist собран ' + clock(facts.distAt))
  }

  publicLine(ctx, facts)
  // Ссылка отдельной строкой — только когда её есть кому дать: в строке
  // «наружу» местный адрес уже назван, и второй раз он читается как другой.
  if (facts.transport !== '' && facts.publicUrl !== '') ui.kv('  ссылка', ui.cyan(facts.publicUrl))

  if (facts.dockerNote !== '') ui.kv(SYMBOL.off + ' ядра', facts.dockerNote)
  else if (facts.imageAt === null) {
    ui.kv(SYMBOL.off + ' ядра', 'образа ' + facts.image + ' нет · комнат с ядром: ' + facts.rooms)
    ui.hint('colloq env build ' + facts.kernelEnv)
  } else {
    ui.kv(
      SYMBOL.on + ' ядра',
      facts.image + ', собран ' + day(facts.imageAt) + ' · комнат с ядром: ' + facts.rooms,
    )
  }
  ui.kv('  окружение', facts.kernelEnv, 'сменить: colloq env use <имя>')

  vastLine(ctx)
  backupLine(ctx, facts)
}

function serverLine(ctx: Ctx, facts: Status): void {
  const { ui } = ctx
  if (facts.form === '') {
    ui.kv(SYMBOL.off + ' сервер', 'не запущен · порт ' + facts.port)
    ui.hint('colloq run')
    return
  }
  const parts: string[] = []
  if (facts.pid !== null) parts.push('pid ' + facts.pid)
  parts.push('порт ' + facts.port)
  if (facts.uptimeSec !== null) parts.push(humanDuration(facts.uptimeSec))
  parts.push(facts.form)
  ui.kv(SYMBOL.on + ' сервер', parts.join(' · '))
}

function publicLine(ctx: Ctx, facts: Status): void {
  const { ui } = ctx
  const host = hostOf(facts.publicUrl)
  if (facts.transport === '') {
    ui.kv(SYMBOL.off + ' наружу', 'не выставлен · только ' + (facts.publicUrl || 'эта машина'))
    ui.hint('colloq host <имя>')
    return
  }
  const tail =
    facts.tunnelPid === null
      ? ' — туннеля не видно'
      : ' (' + facts.tunnel + ' pid ' + facts.tunnelPid + ')'
  ui.kv(SYMBOL.on + ' наружу', host + ' · ' + facts.transport + tail)
}

function vastLine(ctx: Ctx): void {
  const { ui } = ctx
  const state = ctx.env.readState()
  // last пишет каркас после ЛЮБОЙ команды: своей строкой vast считается
  // только та, что начинается с vast, иначе «colloq ps» выдавал бы себя за
  // память об аренде.
  const last = state.last ?? {}
  const command = (last.command ?? '').startsWith('vast') ? (last.command ?? '') : ''
  const known = Boolean(state.name || state.gpu || command)
  if (!known) {
    ui.kv(SYMBOL.off + ' vast', 'ничего не запомнено', 'по памяти, без сети')
    return
  }
  const parts: string[] = []
  if (command) {
    const verdict =
      last.code === undefined
        ? command
        : command + (last.code === 0 ? ' прошёл' : ' кончился кодом ' + last.code)
    parts.push(last.at ? verdict + ' ' + day(last.at) + ' ' + clock(last.at) : verdict)
  }
  if (state.gpu) parts.push(state.gpu)
  if (state.alive === false) parts.push('машина уничтожена')
  const head = state.name ? state.name + ' — ' : ''
  ui.kv(SYMBOL.off + ' vast', head + parts.join(' · '), 'по памяти, без сети')
  ui.hint('свежее: colloq vast status')
}

function backupLine(ctx: Ctx, facts: Status): void {
  const { ui } = ctx
  if (facts.backupAt === null) {
    ui.kv(SYMBOL.off + ' копия', 'копий нет')
    ui.hint('colloq backup')
    return
  }
  const name = facts.backupPath.split('/').pop() ?? facts.backupPath
  const age = ctx.io.now() - facts.backupAt
  ui.kv(SYMBOL.on + ' копия', name + ' · ' + humanAge(age))
  // Подсказка про арендованную машину — только когда среда вообще известна.
  if (age > 86400000 && ctx.env.readState().name) ui.hint('colloq vast sync')
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

const PROGRAMS = ['sqlite3', 'python3', 'frpc', 'cloudflared', 'gws'] as const

async function doctorChecks(ctx: Ctx): Promise<Check[]> {
  const { env, io, sh } = ctx
  const kernelEnv = env.kernelEnv()
  const port = env.port()
  const relay = env.relay()
  const offline = on(ctx, 'offline')
  const pidText = (io.readText(env.paths.pidFile) ?? '').trim()

  const [programs, info, image, listen, disk, rooms, relayTcp] = await Promise.all([
    // Одна оболочка на пять программ: пять отдельных вызовов стоили бы вдвое дольше.
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
    // Только LISTEN: чужой CLOSE_WAIT однажды уже дал ложное «порт занят».
    sh.capture('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { timeoutMs: 2000 }),
    sh.capture('df', ['-k', env.paths.root], { timeoutMs: 2000 }),
    ctx.rooms(),
    // Единственная сетевая проверка, и она снимается флагом --offline.
    offline || relay.addr === ''
      ? missing()
      : sh.capture('node', ['-e', TCP_PROBE, relay.addr, String(relay.port)], { timeoutMs: 2500 }),
  ])

  const found = new Set(programs.stdout.split('\n').map((line) => line.trim()))
  const checks: Check[] = []
  const add = (check: Check): void => void checks.push(check)

  const hasEnv = io.exists(env.paths.envFile)
  add({
    id: 'env',
    label: '.env',
    ok: hasEnv,
    optional: false,
    value: hasEnv ? 'есть · PORT ' + port + ' · KERNEL_ENV ' + kernelEnv : 'нет файла',
    hint: 'colloq make .env — копия из .env.example со своим JUPYTER_TOKEN',
  })

  const major = Number.parseInt((process.version ?? 'v0').slice(1), 10)
  add({
    id: 'node',
    label: 'node',
    ok: Number.isFinite(major) && major >= 20,
    optional: false,
    value: process.version ?? 'неизвестно',
    hint: 'нужен Node ≥ 20: brew install node',
  })

  const hasTsx = io.exists(env.path('node_modules/.bin/tsx'))
  add({
    id: 'tsx',
    label: 'tsx',
    ok: hasTsx,
    optional: false,
    value: hasTsx ? 'на месте' : 'нет — этим же tsx запущен colloq',
    hint: 'npm install',
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
        ? 'демон не отвечает'
        : daemonName +
          ', ' +
          (memTotal / 1024 ** 3).toFixed(0) +
          ' ГБ' +
          (enoughMemory ? '' : ' — ядру комнаты мало'),
    hint:
      info.code !== 0
        ? 'запустите Docker Desktop или colima start'
        : 'поднять память докера: меньше 4 ГБ — и ядро комнаты убьёт по OOM',
  })

  const listener = listen.code === 0 ? listenerOf(listen.stdout) : null
  const ours = listener !== null && pidText !== '' && String(listener.pid) === pidText
  add({
    id: 'port',
    label: 'порт ' + port,
    ok: listen.code === 127 ? false : listener === null || ours,
    optional: listen.code === 127,
    value:
      listen.code === 127
        ? 'нет lsof — порт не проверить'
        : listener === null
          ? 'свободен'
          : ours
            ? 'слушает наш сервер, pid ' + listener.pid
            : 'занят: ' + listener.name + ' pid ' + listener.pid + ' — это второй Colloq',
    hint: 'colloq stop · colloq status (pkill по имени — никогда)',
  })

  add({
    id: 'kernel-image',
    label: 'образ ядра',
    ok: image.code === 0,
    optional: false,
    value:
      image.code === 0 ? 'colloq-kernel:' + kernelEnv : 'нет образа colloq-kernel:' + kernelEnv,
    hint: 'colloq env build ' + kernelEnv,
  })

  const envFile = io.exists(joinPath(env.paths.envDir, kernelEnv + '.txt'))
  add({
    id: 'kernel-env-file',
    label: 'окружение',
    ok: envFile,
    optional: false,
    value: envFile ? kernelEnv + '.txt на месте' : 'нет kernel/environments/' + kernelEnv + '.txt',
    hint: 'colloq env list · colloq env new <имя>',
  })

  const distNames = io.list(env.paths.dist)
  const assets = io.list(joinPath(env.paths.dist, 'assets'))
  // Считаем только то, что жмётся: шрифты и картинки .br не получают никогда,
  // а самые мелкие файлы сборщик пропускает сам — потому доля, а не «все».
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
      ? 'фронтенд не собран'
      : share >= 0.8
        ? 'собран, сжат заранее: ' + squeezed.length + ' из ' + plain.length
        : 'фронтенд не сжат заранее — 11,6 мс и 25 КБ на студента за файл',
    hint: 'colloq build',
  })

  const dockerGid = env.has('DOCKER_GID')
  add({
    id: 'docker-gid',
    label: 'DOCKER_GID',
    ok: dockerGid,
    optional: true,
    value: dockerGid ? 'есть' : 'нет — комнаты поделят одно ядро',
    hint: 'colloq docker-gid',
  })

  add({
    id: 'sqlite3',
    label: 'sqlite3',
    ok: found.has('sqlite3'),
    optional: true,
    value: found.has('sqlite3') ? 'есть' : 'нет — colloq backup --legacy не сделает копию',
    hint: 'brew install sqlite',
  })
  add({
    id: 'python3',
    label: 'python3',
    ok: found.has('python3'),
    optional: true,
    value: found.has('python3') ? 'есть' : 'нет — не будет activity, backup, release validate',
    hint: 'brew install python',
  })

  const wantRelay = relay.domain !== ''
  add({
    id: 'frpc',
    label: 'frpc',
    ok: found.has('frpc'),
    optional: !wantRelay,
    value: found.has('frpc')
      ? 'есть'
      : wantRelay
        ? 'нет — под *.' + relay.domain + ' не выйти'
        : 'ретранслятор не настроен',
    hint: 'поставьте frpc: scripts/relay-setup.sh ставит его на машину ретранслятора',
  })
  add({
    id: 'cloudflared',
    label: 'cloudflared',
    ok: found.has('cloudflared'),
    optional: true,
    value: found.has('cloudflared')
      ? 'есть'
      : 'нет — быстрый туннель не поднимется (для *.colloq.ru не нужен)',
    hint: 'brew install cloudflared',
  })

  const keyPath = expandHome(ctx, env.read('VAST_SSH_KEY') || '~/.ssh/id_ed25519')
  const hasKey = io.exists(keyPath) && io.exists(keyPath + '.pub')
  const hasVastToken = env.has('VAST_TOKEN')
  add({
    id: 'vast-key',
    label: 'ключ vast',
    ok: hasKey,
    optional: !hasVastToken,
    value: hasKey ? keyPath + ' и .pub на месте' : 'нет пары ' + keyPath + ' и .pub',
    hint: 'ssh-keygen -t ed25519',
  })
  add({
    id: 'vast-token',
    label: 'токен vast',
    ok: hasVastToken,
    optional: true,
    value: hasVastToken ? 'есть' : 'нет — аренда недоступна',
    hint: 'VAST_TOKEN в .env',
  })

  const relayOk = relayTcp.code === 0
  add({
    id: 'relay',
    label: 'ретранслятор',
    ok: relayOk,
    optional: relay.addr === '' || offline,
    value:
      relay.addr === ''
        ? 'RELAY_ADDR не задан'
        : offline
          ? 'не проверяли: --offline'
          : relayOk
            ? relay.addr + ':' + relay.port + ' отвечает'
            : relay.addr + ':' + relay.port + ' не отвечает за 2 с',
    hint:
      relay.addr === ''
        ? 'RELAY_ADDR в .env — если под *.colloq.ru вообще выходят'
        : offline
          ? 'снимите --offline, и проверим'
          : 'проверьте машину, потом colloq relay ping',
  })

  const cf = env.has('CF_TOKEN') && env.has('CF_ZONE')
  const cert = io.exists(joinPath(env.home(), '.cloudflared/cert.pem'))
  add({
    id: 'cloudflare',
    label: 'Cloudflare',
    ok: cf && cert,
    optional: true,
    value:
      (cf ? 'CF_TOKEN и CF_ZONE есть' : 'CF_TOKEN или CF_ZONE нет') +
      (cert ? ' · cert.pem есть' : ' · cert.pem нет'),
    hint: 'без них не сработают colloq dns и colloq tunnel setup (cert.pem — не тот же токен)',
  })

  const oracle = env.has('OPENAI_API_KEY') || env.has('OPENROUTER_API_KEY')
  add({
    id: 'oracle',
    label: 'оракул',
    ok: oracle,
    optional: true,
    value: oracle ? 'ключ есть' : 'ключа нет — подсказки выключены',
    hint: 'OPENAI_API_KEY или OPENROUTER_API_KEY в .env',
  })

  const sheet = env.has('ACTIVITY_SHEET_ID')
  add({
    id: 'activity',
    label: 'таблица',
    ok: sheet && found.has('gws'),
    optional: true,
    value:
      (sheet ? 'ACTIVITY_SHEET_ID есть' : 'ACTIVITY_SHEET_ID нет') +
      (found.has('gws') ? ' · gws есть' : ' · gws нет') +
      (sheet && found.has('gws') ? '' : ' — colloq activity не запишет'),
    hint: 'завести таблицу: python3 scripts/activity-sheet.py --create «название»',
  })

  const freeGb = freeSpaceGb(disk)
  add({
    id: 'disk',
    label: 'место',
    ok: freeGb !== null && freeGb >= 15,
    optional: freeGb === null || freeGb >= 5,
    value:
      freeGb === null
        ? 'df не ответил'
        : freeGb < 5
          ? freeGb.toFixed(1) + ' ГБ — сборка образа и копия не влезут'
          : freeGb < 15
            ? freeGb.toFixed(1) + ' ГБ — на образ и копию впритык'
            : freeGb.toFixed(0) + ' ГБ',
    hint: 'уберите старое из backups/ и logs/',
  })

  const release = io.exists(joinPath(env.paths.clusterState, 'releases/current.json'))
  const legacy = io.list(env.paths.backupsDir).some((name) => name.endsWith('.db'))
  add({
    id: 'worlds',
    label: 'два мира',
    ok: (release || legacy) && !(release && legacy),
    optional: !release && !legacy,
    value:
      release && legacy
        ? 'на машине смешаны релиз и прежний формат: restore откажет legacy-наложению'
        : release
          ? 'релиз k3s'
          : legacy
            ? 'прежний формат, копии в backups/'
            : 'здесь только локальная разработка',
    hint: 'разворачивать переносимый архив: colloq restore --archive … --release …',
  })

  const marker = io.exists(joinPath(env.paths.clusterState, '.restore-in-progress'))
  add({
    id: 'restore',
    label: 'восстановление',
    ok: !marker,
    optional: false,
    value: marker
      ? 'прервано: не пойдут prepare, install, update, rollback, start, smoke и backup'
      : 'маркера нет',
    hint: 'довести до конца: colloq restore … --recover (руками маркер не снимать)',
  })

  add({
    id: 'class',
    label: 'занятие',
    ok: rooms === 0,
    optional: true,
    value:
      rooms === 0
        ? 'комнат с ядром нет'
        : 'идёт занятие: ' + roomsWord(rooms) + ' — опасные команды спросят про них',
    hint: 'это предупреждение перед down, restart, build, ui, sync, а не запрет',
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

/**
 * Что не так с аргументами activity. Отдельно от run() затем, что вопрос
 * каркас задаёт ДО неё: без этой проверки «переписать строки?» опережало бы
 * отказ «не сказано, чью активность считать».
 */
function activityTrouble(ctx: Ctx): [string, string, string] | null {
  const all = on(ctx, 'all')
  const rooms = ctx.positionals.join(' ')
  // ROOM уходит в рецепт Makefile без кавычек, и оболочка исполнит всё, что
  // похоже на команду: сито стоит здесь, до вопроса и до делегирования.
  for (const room of ctx.positionals) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
      return [
        'комната «' + room + '» не годится',
        'это хвост ссылки /s/<id>: буквы, цифры, дефис и подчёркивание',
        'colloq activity y84w9hpc',
      ]
    }
  }
  if (!all && rooms === '') {
    return [
      'не сказано, чью активность считать',
      'нужна комната или --all',
      'colloq activity y84w9hpc · colloq activity --all',
    ]
  }
  if (all && rooms !== '') {
    return [
      'комната и --all вместе не читаются',
      '--all берёт все комнаты, которых в таблице ещё нет',
      'colloq activity ' + rooms + ' · colloq activity --all',
    ]
  }
  return null
}

/** Куда пойдёт стенд: --url или умолчание LOAD_BASE_URL. */
function loadTarget(ctx: Ctx): string {
  return text(ctx, 'url') || 'http://localhost:3000'
}

/** То же для course: без таблицы и колонки спрашивать не о чем. */
function courseTrouble(ctx: Ctx): [string, string, string] | null {
  const sheet = text(ctx, 'sheet')
  if (sheet === '') {
    return [
      'не сказано, из какой таблицы брать расписание',
      'нужен --sheet <id> — это id из ссылки на таблицу',
      'colloq course --sheet <id> --col "ML · сильная"',
    ]
  }
  if (text(ctx, 'col') === '') {
    return [
      'не сказано, какую колонку брать',
      'колонка ищется по тексту заголовка первой строки',
      'colloq course --sheet ' + sheet + ' --col "ML · сильная"',
    ]
  }
  return null
}

// ------------------------------------------------------------------ реестр

export const commands: Command[] = [
  {
    name: 'status',
    aliases: ['st'],
    group: 'tools',
    summary: 'Что сейчас с этой машиной — одним экраном, без сети',
    usage: 'colloq status [--short] [--json]',
    flags: [
      { name: 'short', summary: 'Две строки: сервер и наружу' },
      { name: 'json', summary: 'Машинный вид' },
    ],
    destructive: false,
    delegates: 'native: .env, .colloq.pid, ps, docker ps, web/dist, backups/, .colloq/state.json',
    examples: ['colloq status', 'colloq status --short'],
    notes:
      'Только чтение и никакой сети. Докера спрашиваем один раз с потолком 0,7 с: не ответил — строка о нём, экран печатается дальше. Про vast здесь только память прошлых команд, свежее — colloq vast status.',
    async run(ctx) {
      if (ctx.dryRun) return ctx.sh.dry('native: status (читает .env, .colloq.pid, docker ps)')
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
          vast: ctx.env.readState(),
          backup: {
            path: facts.backupPath,
            ageSec:
              facts.backupAt === null ? null : Math.round((ctx.io.now() - facts.backupAt) / 1000),
          },
        })
        return 0
      }
      if (on(ctx, 'short')) {
        // Ими открывается меню: ровно две строки, без подсказок.
        serverLine(ctx, facts)
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
    summary: 'Проверить, всё ли на месте перед парой',
    usage: 'colloq doctor [--offline] [--json]',
    flags: [
      { name: 'offline', summary: 'Без единственной сетевой проверки' },
      { name: 'json', summary: 'Машинный вид' },
    ],
    destructive: false,
    delegates: 'native: программы, файлы, образы, место; одна проверка ретранслятора по TCP',
    examples: ['colloq doctor', 'colloq doctor --offline'],
    notes:
      '✗ — сломано, чинить; ○ — возможность выключена, и это не ошибка. Из .env печатаются только PORT и KERNEL_ENV, остальное — «есть / нет». Код 3, если есть хоть одно ✗.',
    async run(ctx) {
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: doctor (программы, файлы, образы, место; TCP до ретранслятора — 2 с)',
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

  {
    name: 'activity',
    group: 'tools',
    summary: 'Посчитать активность семинара и записать в Google-таблицу',
    usage: 'colloq activity <room…|--all> [--replace]',
    args: [{ name: 'room', summary: 'Комната: хвост ссылки /s/<id>; можно несколько' }],
    // Комнат бывает несколько, и ROOM=«a b» рецепт разбирает сам: хвост
    // позиционных не лишний.
    extra: true,
    flags: [
      { name: 'all', summary: 'Все комнаты с активностью, которых в таблице ещё нет' },
      { name: 'replace', summary: 'Строки этих комнат в таблице переписать' },
    ],
    destructive: true,
    confirm: 'cli',
    check: checker(activityTrouble),
    confirmWhen: async (ctx) => on(ctx, 'replace'),
    confirmQuestion: 'переписать строки этих комнат в таблице?',
    delegates: 'make activity ROOM=… [ALL=1] [REPLACE=1]',
    examples: ['colloq activity y84w9hpc', 'colloq activity --all'],
    notes:
      'Пишет наружу, в Google, через gws — он должен быть авторизован: gws auth status. Таблица берётся из ACTIVITY_SHEET_ID, база — data/colloq.db рядом. Листы «Семинары» (дописывание) и «Сводка» (формула QUERY). Новую таблицу заводит python3 scripts/activity-sheet.py --create «название» — обёртки у CLI нет нарочно.',
    async run(ctx) {
      const all = on(ctx, 'all')
      const rooms = ctx.positionals.join(' ')
      const vars = {
        ROOM: all ? undefined : rooms,
        ALL: all ? '1' : undefined,
        REPLACE: on(ctx, 'replace') ? '1' : undefined,
      }
      if (ctx.dryRun) return await ctx.sh.make('activity', vars)
      if (!ctx.env.has('ACTIVITY_SHEET_ID')) {
        throw new PreconditionError(
          'нет ACTIVITY_SHEET_ID в .env — некуда писать',
          'завести таблицу: python3 scripts/activity-sheet.py --create «Colloq · активность»',
        )
      }
      ctx.ui.header('считаю активность ' + (all ? 'всех комнат' : rooms) + ': пишу в таблицу')
      return await ctx.sh.make('activity', vars)
    },
  },

  {
    name: 'site',
    group: 'tools',
    summary: 'Выложить сайт colloq.ru — лендинг и опубликованные семинары',
    usage: 'colloq site [--dry] [--site <путь>] [--base <адрес>]',
    flags: [
      { name: 'dry', summary: 'DRY=1 скрипта: только собрать, без коммита и push' },
      { name: 'site', arg: 'путь', summary: 'Каталог сайта (умолчание site/)' },
      { name: 'base', arg: 'адрес', summary: 'Базовый адрес (умолчание https://colloq.ru)' },
    ],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => !on(ctx, 'dry'),
    confirmQuestion: 'выложить сайт? будет коммит и push в main',
    delegates: 'make site [SITE=…] [BASE=…] [DRY=1]',
    examples: ['colloq site --dry', 'colloq site'],
    notes:
      'Единственная команда во всём наборе, трогающая историю git. На любой ветке кроме main откажется сам скрипт. Читает местную базу, чтобы узнать, какие семинары опубликованы. Два похожих флага: --dry — это DRY=1 скрипта (собрать без push), --dry-run — общий флаг CLI (напечатать вызов и выйти).',
    async run(ctx) {
      const site = text(ctx, 'site')
      const vars = {
        SITE: site === '' ? undefined : ctx.env.userPath(site),
        BASE: text(ctx, 'base') || undefined,
        DRY: on(ctx, 'dry') ? '1' : undefined,
      }
      if (ctx.dryRun) return await ctx.sh.make('site', vars)
      ctx.ui.header(on(ctx, 'dry') ? 'собираю сайт: без push' : 'собираю сайт и делаю push в main')
      return await ctx.sh.make('site', vars)
    },
  },

  {
    name: 'course',
    group: 'tools',
    summary: 'Завести курс из расписания в таблице',
    usage:
      'colloq course --sheet <id> --col <заголовок> [--gid <gid>] [--name <имя>] [--blurb <строка>] [--dry]',
    flags: [
      { name: 'sheet', arg: 'id', summary: 'Опубликованная таблица: id из ссылки' },
      { name: 'gid', arg: 'gid', summary: 'Лист таблицы (умолчание 0)' },
      { name: 'col', arg: 'заголовок', summary: 'Колонка по ТЕКСТУ заголовка, не по номеру' },
      { name: 'name', arg: 'имя', summary: 'Имя курса' },
      { name: 'blurb', arg: 'строка', summary: 'Строка под именем' },
      { name: 'dry', summary: 'DRY=1 скрипта: показать и ничего не записать' },
    ],
    destructive: true,
    confirm: 'cli',
    check: checker(courseTrouble),
    confirmWhen: async (ctx) => !on(ctx, 'dry'),
    confirmQuestion: 'завести курс? пишем в data/colloq.db',
    delegates: 'make course SHEET=… GID=… COL=… [NAME=…] [BLURB=…] [DRY=1]',
    examples: [
      'colloq course --sheet SHEETID --col "ML · сильная" --dry',
      'colloq course --sheet SHEETID --gid 0 --col "ML · сильная" --name "ML · сильная"',
    ],
    notes:
      'Колонка выбирается по ТЕКСТУ заголовка первой строки, а не по номеру: кавычки вокруг «ML · сильная» обязательны, иначе оболочка разорвёт её на слова. Таблица должна быть опубликована — скрипт тянет CSV.',
    async run(ctx) {
      const sheet = text(ctx, 'sheet')
      const column = text(ctx, 'col')
      const vars = {
        SHEET: sheet,
        GID: text(ctx, 'gid') || '0',
        COL: column,
        NAME: text(ctx, 'name') || undefined,
        BLURB: text(ctx, 'blurb') || undefined,
        DRY: on(ctx, 'dry') ? '1' : undefined,
      }
      if (ctx.dryRun) return await ctx.sh.make('course', vars)
      ctx.ui.header('завожу курс из таблицы: колонка «' + column + '»')
      return await ctx.sh.make('course', vars)
    },
  },

  {
    name: 'load',
    group: 'tools',
    summary: 'Загнать N студентов в свою комнату — нагрузочный стенд',
    usage:
      'colloq load [N] [--ramp <сек>] [--idle <сек>] [--pid <pid>] [--tree <файлов/с>] [--council <сколько>] [--ink <кадров/с>] [--staff] [--url <адрес>]',
    args: [{ name: 'N', summary: 'Сколько студентов (умолчание 500)' }],
    flags: [
      { name: 'ramp', arg: 'сек', summary: 'За сколько секунд они входят' },
      { name: 'idle', arg: 'сек', summary: 'Сколько секунд просто сидят' },
      { name: 'pid', arg: 'pid', summary: 'pid сервера ради CPU и RSS (SPID)' },
      { name: 'tree', arg: 'файлов/с', summary: 'Рассылка изменений дерева' },
      { name: 'council', arg: 'сколько', summary: 'Сколько пишут в консилиум' },
      { name: 'ink', arg: 'кадров/с', summary: 'Рисование одного ведущего всем' },
      { name: 'staff', summary: 'Входить кукой штата, мимо предела новых участников' },
      { name: 'url', arg: 'адрес', summary: 'Куда стучаться (LOAD_BASE_URL)' },
    ],
    destructive: true,
    // Вопрос называет настоящую цель, а она зависит от --url.
    confirm: 'cli',
    check: (ctx) => {
      const students = ctx.positionals[0] ?? ''
      if (students !== '' && !/^\d+$/.test(students)) {
        refuse('N — это число студентов', 'а сказано: ' + students, 'colloq load 500 --ramp 60')
      }
    },
    confirmQuestion: (ctx) =>
      'стенд пойдёт по ' + loadTarget(ctx) + ' — это сервер преподавателя; гнать?',
    delegates: 'make load N=… RAMP=… [SPID=… IDLE=… TREE=… COUNCIL=… INK=… STAFF=1]',
    examples: ['colloq load 500 --ramp 60', 'colloq load 50 --url https://{domain}'],
    notes:
      'Стенд заводит свою комнату и удаляет её, но по чужой машине его не гоняют: умолчание LOAD_BASE_URL — http://localhost:3000, то есть сервер преподавателя. SPID не угадывают: служба — systemctl show -p MainPID colloq, make run — cat .colloq.pid; без --pid берётся .colloq.pid. ulimit -n 8192 ставит сам Makefile. Чужое присутствие стенд серверу не повторяет — прежнее поведение меряется make-формой: colloq load 500 LOAD_ECHO=1. Тонкие ручки — парами make: K=20 M=5 STORM=20 TREE_SEC=10 EVERY=2 COUNCIL_SEC=10 INK_SEC=10.',
    async run(ctx) {
      const students = ctx.positionals[0] ?? ''
      const url = text(ctx, 'url')
      const pidText = (ctx.io.readText(ctx.env.paths.pidFile) ?? '').trim()
      const given = text(ctx, 'pid')
      const spid = given !== '' ? given : /^\d+$/.test(pidText) ? pidText : ''
      const vars = {
        N: students || undefined,
        RAMP: text(ctx, 'ramp') || undefined,
        IDLE: text(ctx, 'idle') || undefined,
        SPID: spid || undefined,
        TREE: text(ctx, 'tree') || undefined,
        COUNCIL: text(ctx, 'council') || undefined,
        INK: text(ctx, 'ink') || undefined,
        STAFF: on(ctx, 'staff') ? '1' : undefined,
      }
      const opts = url === '' ? {} : { env: { LOAD_BASE_URL: url } }
      if (ctx.dryRun) return await ctx.sh.make('load', vars, opts)

      if (given === '' && spid !== '') ctx.ui.hint('pid сервера взят из .colloq.pid: ' + spid)
      ctx.ui.header('гоняю стенд: ' + (students || '500') + ' студентов по ' + loadTarget(ctx))
      return await ctx.sh.make('load', vars, opts)
    },
  },

  {
    name: 'make',
    group: 'tools',
    summary: 'Позвать цель Makefile напрямую, ничего не разбирая',
    usage: 'colloq make <цель> [ПЕРЕМ=значение …]',
    args: [{ name: 'цель', summary: 'Имя цели Makefile' }],
    extra: true,
    flags: [],
    destructive: false,
    delegates: 'make <цель> [ПЕРЕМ=значение …]',
    examples: ['colloq make vast-up NAME=hse', 'colloq make help'],
    notes:
      'Запасной выход: ни подтверждений, ни проверок, ни подстановок — ровно то, что напечатали. Этим же путём зовётся цель, у которой обёртки нет вовсе. Ручки цели — это пары, а не флаги: colloq make ui HEADED=1. После -- ставят настоящие ключи make (colloq make check -- -n); общие флаги CLI, --dry-run в том числе, действуют только ДО --.',
    async run(ctx) {
      const target = ctx.positionals[0]
      if (!target) {
        ctx.ui.refuse(
          'не сказано, какую цель звать',
          'colloq make <цель> — всё после имени цели уходит make как есть',
          'список целей ниже',
        )
        await ctx.sh.make('help')
        return 2
      }
      const tail = ctx.positionals.slice(1)
      return await ctx.sh.run('make', [target, ...tail, ...pairs(ctx)])
    },
  },
]

/** Пары ВИДА=ЗНАЧЕНИЕ, снятые каркасом из argv: их несёт sh.make, а тут вызов свой. */
function pairs(ctx: Ctx): string[] {
  return Object.entries(ctx.makeVars).map(([key, value]) => key + '=' + value)
}

/** Вторая строка --short: та же, что «наружу», но без подсказки. */
function publicLineShort(ctx: Ctx, facts: Status): void {
  const host = hostOf(facts.publicUrl)
  if (facts.transport === '') {
    ctx.ui.kv(SYMBOL.off + ' наружу', 'не выставлен · colloq host <имя>')
    return
  }
  const tail =
    facts.tunnelPid === null
      ? ' — туннеля не видно'
      : ' (' + facts.tunnel + ' pid ' + facts.tunnelPid + ')'
  ctx.ui.kv(SYMBOL.on + ' наружу', host + ' · ' + facts.transport + tail)
}
