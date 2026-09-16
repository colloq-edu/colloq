/**
 * Инструменты — посмотреть, проверить, посчитать.
 *
 * Цели группы: status, doctor, activity, site, course, load, make
 * (make status, make activity, make site, make course, make load; doctor и
 * make — свои).
 *
 * В поверхности преподавателя (COLLOQ_SURFACE=teacher) видны две: status и
 * doctor — «что сейчас с машиной» и «всё ли на месте перед парой». activity,
 * site, course, load и make — мастерская: Google-таблицы, лендинг, курс из
 * расписания, нагрузочный стенд и запасной выход к Makefile, которого рядом с
 * поставленным пакетом нет вовсе. По точному имени они зовутся и оттуда.
 *
 * --json есть ровно у status, doctor и env list: команда
 * объявляет флаг {name:'json'}, иначе каркас откажет с кодом 2.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.sh и ctx.io.
 */
import type { Command, Ctx } from '../registry.js'
import { PreconditionError, roomsWord, SYMBOL, UsageError } from '../ui.js'
import { joinPath } from '../env.js'
import { readSession, type Session } from '../session.js'
import { TCP_PROBE } from '../sh.js'
import { leaseUrl } from '../../../shared/local-public-url-lease.js'
// Те же слова, что говорит colloq host: два места, одна формулировка — см.
// PERIMETER в host.ts. Расходиться им нельзя, иначе одно из двух окажется
// неправдой.
import { PERIMETER } from './host.js'

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

/** «4 ч назад». */
function humanAge(milliseconds: number): string {
  return humanDuration(milliseconds / 1000) + ' ago'
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

/**
 * Смотрит ли адрес наружу. Три написания петли — те же, что принимает расписка
 * (session.ts · loopback): её адрес приходит сюда наравне с PUBLIC_URL, и
 * `http://[::1]:4100` считался бы чужой машиной, раз уж список был из двух.
 */
function outsideOf(url: string): boolean {
  const host = hostOf(url)
  return host !== '' && !['127.0.0.1', 'localhost', '[::1]'].includes(host)
}

/**
 * Адрес идущего занятия: публичный, если у сессии живёт расписка на него.
 *
 * Занятие выставляют наружу не через .env, а через собственный туннель
 * супервизора, и его адрес лежит в отдельной расписке (leaseFile). Без неё
 * остаётся местный адрес из расписки занятия — он всегда петля.
 */
function sessionAddress(ctx: Ctx, session: Session): string {
  if (session.leaseFile === '') return session.url
  return leaseUrl(ctx.io.readText(session.leaseFile), session.runId, ctx.io.now()) ?? session.url
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
  const kernelEnv = env.kernelEnv()
  const relayDomain = env.relay().domain
  const cluster = env.read('COLLOQ_CLUSTER') === '1'
  const hasUnit = io.exists(env.paths.serviceUnit)

  /*
   * Первый источник — расписка занятия, второй — .env.
   *
   * Вопросы у них разные: .env говорит, что настроено, расписка — на чём идёт
   * занятие ПРЯМО СЕЙЧАС. `colloq run --port 4100` в .env не пишет ничего, и
   * живьём экран печатал «порт 3000», пока класс сидел на 4100. Потому порт,
   * адрес и номера процессов берутся из расписки, и только когда её нет — из
   * .env, как было всегда.
   */
  const session = readSession(io, env.paths.sessionFile)
  const sessionUrl = session === null ? '' : sessionAddress(ctx, session)
  const envUrl = env.publicUrl()
  /*
   * Чью живость спрашиваем у ps. Порт держит сервер — ребёнок супервизора, и
   * его номер лежит в расписке полем serverPid; пока сервер не поднялся (phase
   * preparing), занятие всё равно идёт, и живым считается супервизор. Без
   * расписки остаётся прежний путь: .colloq.pid, куда старый make run писал
   * номер самого сервера.
   */
  const pidText = (io.readText(env.paths.pidFile) ?? '').trim()
  const filePid = /^\d+$/.test(pidText) ? Number(pidText) : null
  const pid = session === null ? filePid : (session.serverPid ?? session.pid)
  /*
   * Туннель ищем, если наружу смотрит хоть один из двух адресов: какой из них
   * настоящий, станет известно только после ps, а лишний pgrep стоит копейки —
   * иначе пришлось бы либо ходить к процессам дважды, либо терять строку
   * «наружу» у занятия с собственным туннелем.
   */
  const outside = outsideOf(sessionUrl) || outsideOf(envUrl)

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
        ? 'docker did not answer in 0.7s'
        : docker.code === 127
          ? 'docker not found'
          : 'docker is not answering'

  const uptimeSec = etime.code === 0 ? parseEtime(etime.stdout) : null
  const alive = etime.code === 0 && uptimeSec !== null
  /*
   * Расписка без живого процесса — след от убитого занятия: kill -9 её не
   * убирает. Верить ей тогда нельзя, иначе экран печатал бы порт и адрес пары,
   * которой нет, — и всё возвращается к .env.
   */
  const live: Session | null = alive ? session : null
  const port = live ? live.port : env.port()
  const publicUrl = live ? sessionUrl : envUrl
  const host = hostOf(publicUrl)
  const published = outsideOf(publicUrl)
  /*
   * Форма. Своя строка у занятия под супервизором нужна не для красоты:
   * «make run» у поставленного пакета — совет в пустоту, make там нет вовсе, а
   * останавливают и перезапускают такое занятие словами colloq stop и colloq
   * restart. Имя формы поэтому называет ту самую команду, которой его завели,
   * — ровно как «make run» называет свою. Расписка идёт первой: если она жива,
   * порт и номера уже взяты из неё, и назвать эту же пару «контейнером» или
   * «службой» значило бы собрать на одной строке два разных сервера.
   */
  const form = live
    ? live.mode === 'dev'
      ? 'colloq dev'
      : 'colloq run'
    : cluster
      ? 'cluster'
      : service.code === 0
        ? 'service'
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
     * Под подписью «сервер» стоит номер СЕРВЕРА, и только он: тем же номером
     * называет слушателя порта doctor, а до этой правки два экрана звали один
     * и тот же сервер по-разному — status номером супервизора, doctor номером
     * его ребёнка. Пока сервер занятия не поднялся, номера нет вовсе, и строка
     * обойдётся портом и временем: выдать вместо него супервизора значило бы
     * вернуть ту же путаницу.
     */
    pid: live ? live.serverPid : alive || form !== '' ? pid : null,
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
    ui.line('nothing is running · ' + ui.cyan('colloq run'))
    return
  }

  ui.header('Colloq · ' + (facts.envName || 'local'))
  serverLine(ctx, facts)

  // Клиент — главная строка экрана: собранная панель старше сервера значит,
  // что класс видит прошлую версию, и по коду этого не понять никак.
  if (facts.distAt === null) {
    ui.kv(SYMBOL.off + ' client', 'the frontend is not built')
    ui.hint('colloq build')
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
  // Ссылка отдельной строкой — только когда её есть кому дать: в строке
  // «наружу» местный адрес уже назван, и второй раз он читается как другой.
  if (facts.transport !== '' && facts.publicUrl !== '') ui.kv('  link', ui.cyan(facts.publicUrl))

  if (facts.dockerNote !== '') ui.kv(SYMBOL.off + ' kernels', facts.dockerNote)
  else if (facts.imageAt === null) {
    ui.kv(
      SYMBOL.off + ' kernels',
      'no ' + facts.image + ' image · rooms with a kernel: ' + facts.rooms,
    )
    ui.hint(
      ctx.dist
        ? 'colloq start — the image is built before the class'
        : 'colloq env build ' + facts.kernelEnv,
    )
  } else {
    ui.kv(
      SYMBOL.on + ' kernels',
      facts.image + ', built ' + day(facts.imageAt) + ' · rooms with a kernel: ' + facts.rooms,
    )
  }
  ui.kv('  env', facts.kernelEnv, 'change: colloq env use <name>')

  /*
   * Арендованные машины — предмет мастерской, и в поверхности преподавателя
   * этой строки нет.
   *
   * Тот же довод, что у короткого осмотра (TEACHER_CHECKS): человеку,
   * поставившему пакет через pip, «vast: ничего не запомнено» не значит
   * ничего, а подсказка под ней зовёт команду, которой в его поверхности нет.
   * Строка, которая ни о чём не говорит и никуда не ведёт, — это шум в экране,
   * который смотрят перед парой.
   */
  if (ctx.surface !== 'teacher') vastLine(ctx)
  backupLine(ctx, facts)
}

function serverLine(ctx: Ctx, facts: Status): void {
  const { ui } = ctx
  if (facts.form === '') {
    ui.kv(SYMBOL.off + ' server', 'not running · port ' + facts.port)
    ui.hint('colloq run')
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
    ui.kv(SYMBOL.off + ' vast', 'nothing remembered', 'from memory, no network')
    return
  }
  const parts: string[] = []
  if (command) {
    const verdict =
      last.code === undefined
        ? command
        : command + (last.code === 0 ? ' succeeded' : ' exited with code ' + last.code)
    parts.push(last.at ? verdict + ' ' + day(last.at) + ' ' + clock(last.at) : verdict)
  }
  if (state.gpu) parts.push(state.gpu)
  if (state.alive === false) parts.push('the machine is destroyed')
  const head = state.name ? state.name + ' — ' : ''
  ui.kv(SYMBOL.off + ' vast', head + parts.join(' · '), 'from memory, no network')
  ui.hint('fresher: colloq vast status')
}

function backupLine(ctx: Ctx, facts: Status): void {
  const { ui } = ctx
  if (facts.backupAt === null) {
    ui.kv(SYMBOL.off + ' backup', 'no backups')
    ui.hint('colloq backup')
    return
  }
  const name = facts.backupPath.split('/').pop() ?? facts.backupPath
  const age = ctx.io.now() - facts.backupAt
  ui.kv(SYMBOL.on + ' backup', name + ' · ' + humanAge(age))
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

/**
 * Что из осмотра касается преподавателя.
 *
 * Полный осмотр отвечает на вопрос мастерской: всё ли готово вести занятия НА
 * ЭТОЙ машине и обслуживать флот. Человеку, поставившему пакет через pip,
 * половина строк не значит ничего, а хуже того — советует команды, которых в
 * его поверхности нет: «colloq make .env», «colloq docker-gid», «npm install»,
 * «scripts/activity-sheet.py». Совет, который нечем выполнить, читается как
 * поломка.
 *
 * Остаются те, что отвечают на его вопрос: пойдёт ли занятие и пустит ли он
 * класс. Ключи чужой инфраструктуры (vast, ретранслятор, Cloudflare, таблица
 * активности), tsx и DOCKER_GID из этого вопроса выпадают.
 */
const TEACHER_CHECKS: ReadonlySet<string> = new Set([
  'node',
  'docker',
  'port',
  'kernel-image',
  'kernel-env-file',
  'web-dist',
  'disk',
  'oracle',
  'cloudflared',
  'frpc',
  'perimeter',
])

async function doctorChecks(ctx: Ctx): Promise<Check[]> {
  const { env, io, sh } = ctx
  const kernelEnv = env.kernelEnv()
  const relay = env.relay()
  const offline = on(ctx, 'offline')
  const pidText = (io.readText(env.paths.pidFile) ?? '').trim()
  /*
   * Осмотр идёт по тому порту, на котором идёт занятие, а не по тому, что
   * записан в .env: `colloq run --port 4100` .env не трогает, и проверка порта
   * 3000 отвечала бы «свободен» про порт, которого класс в глаза не видел.
   * Сам .env ниже печатает своё значение — вопрос у той строки другой.
   */
  const session = readSession(io, env.paths.sessionFile)
  const envPort = env.port()
  const port = session?.port ?? envPort

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
    /*
     * Место меряем на томе каталога СОСТОЯНИЯ, а не приложения. Растёт всё
     * там: <home>/data, <home>/workspace, <home>/backups, <home>/.colloq.log —
     * и подсказка ниже сама зовёт чистить backups/ и logs/. У поставленного
     * через pip colloq каталоги разные, и легко на разных томах: осмотр
     * показывал свободное место под site-packages, а кончалось оно у данных.
     */
    sh.capture('df', ['-k', env.paths.home], { timeoutMs: 2000 }),
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
    value: hasEnv ? 'present · PORT ' + envPort + ' · KERNEL_ENV ' + kernelEnv : 'no file',
    hint: 'colloq make .env — a copy of .env.example with its own JUPYTER_TOKEN',
  })

  const major = Number.parseInt((process.version ?? 'v0').slice(1), 10)
  add({
    id: 'node',
    label: 'node',
    ok: Number.isFinite(major) && major >= 20,
    optional: false,
    value: process.version ?? 'unknown',
    hint: 'Node ≥ 20 is required: brew install node',
  })

  const hasTsx = io.exists(env.path('node_modules/.bin/tsx'))
  add({
    id: 'tsx',
    label: 'tsx',
    ok: hasTsx,
    optional: false,
    value: hasTsx ? 'in place' : 'missing — colloq itself runs on this tsx',
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
   * Чей это слушатель — и раньше ответ был «всегда чужой».
   *
   * Порт держит сервер, а он ребёнок супервизора; в .colloq.pid лежит номер
   * САМОГО супервизора, и сравнение с ним не совпадало никогда. Живьём, во
   * время здорового занятия, doctor печатал «✗ порт 3000 · занят: node pid
   * 14552 — это второй Colloq», советовал colloq stop и возвращал код 3 — то
   * есть звал преподавателя остановить собственную пару.
   *
   * Наши оба номера из расписки: serverPid — тот, кто слушает сейчас, pid
   * супервизора — тот, кто окажется слушателем, если сервер перезапустили, а
   * расписка ещё не переписана. .colloq.pid остаётся третьим: без расписки это
   * прежний путь, там старый make run писал номер самого сервера.
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
    // Совет обязан быть выполнимым. У установленного colloq `env build`
    // отказывает нарочно (собирать нечем и незачем — это делает запуск), и
    // посылать туда человека значит послать его в отказ.
    hint: ctx.dist
      ? 'colloq start — the image is built before the class'
      : 'colloq env build ' + kernelEnv,
  })

  /*
   * Список окружения ищется в ОБОИХ каталогах, как и в `colloq env list`.
   *
   * Смотреть только в привезённый значило бы сказать «нет kernel/environments/
   * mlcourse.txt» про окружение, которое человек минуту назад завёл сам и
   * которое лежит целым в его каталоге, — и этим послать чинить то, что не
   * сломано. Каталоги знает env.paths (env.ts · envDir, ownEnvDir).
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
      ? 'the frontend is not built'
      : share >= 0.8
        ? 'built, pre-compressed: ' + squeezed.length + ' of ' + plain.length
        : 'the frontend is not pre-compressed — 11.6ms and 25 KB per student per file',
    hint: 'colloq build',
  })

  const dockerGid = env.has('DOCKER_GID')
  add({
    id: 'docker-gid',
    label: 'DOCKER_GID',
    ok: dockerGid,
    optional: true,
    value: dockerGid ? 'present' : 'missing — rooms will share one kernel',
    hint: 'colloq docker-gid',
  })

  add({
    id: 'sqlite3',
    label: 'sqlite3',
    ok: found.has('sqlite3'),
    optional: true,
    value: found.has('sqlite3')
      ? 'present'
      : 'missing — colloq backup --legacy will not take a backup',
    hint: 'brew install sqlite',
  })
  add({
    id: 'python3',
    label: 'python3',
    ok: found.has('python3'),
    optional: true,
    value: found.has('python3')
      ? 'present'
      : 'missing — no activity, no backup, no release validate',
    hint: 'brew install python',
  })

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
    hint: 'install frpc: scripts/relay-setup.sh puts it on the relay machine',
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

  const keyPath = expandHome(ctx, env.read('VAST_SSH_KEY') || '~/.ssh/id_ed25519')
  const hasKey = io.exists(keyPath) && io.exists(keyPath + '.pub')
  const hasVastToken = env.has('VAST_TOKEN')
  add({
    id: 'vast-key',
    label: 'vast key',
    ok: hasKey,
    optional: !hasVastToken,
    value: hasKey ? keyPath + ' and .pub in place' : 'no ' + keyPath + ' and .pub pair',
    hint: 'ssh-keygen -t ed25519',
  })
  add({
    id: 'vast-token',
    label: 'vast token',
    ok: hasVastToken,
    optional: true,
    value: hasVastToken ? 'present' : 'missing — renting is unavailable',
    hint: 'VAST_TOKEN in .env',
  })

  const relayOk = relayTcp.code === 0
  add({
    id: 'relay',
    label: 'relay',
    ok: relayOk,
    optional: relay.addr === '' || offline,
    value:
      relay.addr === ''
        ? 'RELAY_ADDR is not set'
        : offline
          ? 'not checked: --offline'
          : relayOk
            ? relay.addr + ':' + relay.port + ' answers'
            : relay.addr + ':' + relay.port + ' does not answer in 2s',
    hint:
      relay.addr === ''
        ? 'RELAY_ADDR in .env — if anything goes out under *.colloq.ru at all'
        : offline
          ? 'drop --offline, and we will check'
          : 'check the machine, then colloq relay ping',
  })

  const cf = env.has('CF_TOKEN') && env.has('CF_ZONE')
  const cert = io.exists(joinPath(env.home(), '.cloudflared/cert.pem'))
  add({
    id: 'cloudflare',
    label: 'Cloudflare',
    ok: cf && cert,
    optional: true,
    value:
      (cf ? 'CF_TOKEN and CF_ZONE present' : 'CF_TOKEN or CF_ZONE missing') +
      (cert ? ' · cert.pem present' : ' · cert.pem missing'),
    hint: 'without them colloq dns and colloq tunnel setup will not work (cert.pem is not that token)',
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

  const sheet = env.has('ACTIVITY_SHEET_ID')
  add({
    id: 'activity',
    label: 'sheet',
    ok: sheet && found.has('gws'),
    optional: true,
    value:
      (sheet ? 'ACTIVITY_SHEET_ID present' : 'ACTIVITY_SHEET_ID missing') +
      (found.has('gws') ? ' · gws present' : ' · gws missing') +
      (sheet && found.has('gws') ? '' : ' — colloq activity will not write'),
    hint: 'create a sheet: python3 scripts/activity-sheet.py --create "name"',
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
    hint: 'clear the old out of backups/ and logs/',
  })

  const release = io.exists(joinPath(env.paths.clusterState, 'releases/current.json'))
  const legacy = io.list(env.paths.backupsDir).some((name) => name.endsWith('.db'))
  add({
    id: 'worlds',
    label: 'two worlds',
    ok: (release || legacy) && !(release && legacy),
    optional: !release && !legacy,
    value:
      release && legacy
        ? 'a release and the old format are mixed here: restore will refuse a legacy overlay'
        : release
          ? 'k3s release'
          : legacy
            ? 'the old format, backups in backups/'
            : 'local development only here',
    hint: 'restore a portable archive: colloq restore --archive … --release …',
  })

  const marker = io.exists(joinPath(env.paths.clusterState, '.restore-in-progress'))
  add({
    id: 'restore',
    label: 'restore',
    ok: !marker,
    optional: false,
    value: marker
      ? 'interrupted: prepare, install, update, rollback, start, smoke and backup will not run'
      : 'no marker',
    hint: 'carry it through: colloq restore … --recover (never clear the marker by hand)',
  })

  add({
    id: 'class',
    label: 'class',
    ok: rooms === 0,
    optional: true,
    value:
      rooms === 0
        ? 'no rooms with a kernel'
        : 'a class is running: ' + roomsWord(rooms) + ' — risky commands will ask about them',
    hint: 'this is a warning before down, restart, build, ui, sync, not a ban',
  })

  // Последней строкой — периметр. Это не проверка: чинить тут нечего, и
  // «сломано» здесь не бывает. Поэтому ○ и optional:true — тот же знак, каким
  // доктор говорит «возможность выключена, и это не ошибка»: код возврата от
  // неё не меняется, а подсказка печатается (её показывают у каждой не-ok
  // строки) и договаривает, что делать, если своего класса мало.
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
        'room "' + room + '" will not do',
        'this is the tail of the /s/<id> link: letters, digits, hyphen and underscore',
        'colloq activity y84w9hpc',
      ]
    }
  }
  if (!all && rooms === '') {
    return [
      'no room to count activity for',
      'a room or --all is needed',
      'colloq activity y84w9hpc · colloq activity --all',
    ]
  }
  if (all && rooms !== '') {
    return [
      'a room and --all cannot be read together',
      '--all takes every room that is not in the sheet yet',
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
      'no sheet to take the schedule from',
      '--sheet <id> is needed: the id from the link to the sheet',
      'colloq course --sheet <id> --col "ML · advanced"',
    ]
  }
  if (text(ctx, 'col') === '') {
    return [
      'no column to take',
      'the column is found by the text of the header in the first row',
      'colloq course --sheet ' + sheet + ' --col "ML · advanced"',
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
    audience: 'teacher',
    summary: 'Show what is on this machine right now: one screen, no network',
    usage: 'colloq status [--short] [--json]',
    flags: [
      { name: 'short', summary: 'Two lines: the server and the outside' },
      { name: 'json', summary: 'Machine-readable' },
    ],
    destructive: false,
    delegates:
      'native: .colloq/local-session.json, .env, .colloq.pid, ps, docker ps, web/dist, backups/, .colloq/state.json',
    examples: ['colloq status', 'colloq status --short'],
    notes:
      'Reading only, and no network at all. The port, the address and the server pid come from the receipt of the class that is running, and only when there is no receipt — from .env: `colloq run --port 4100` writes nothing into .env. Under the "server" label stands the pid of the server, not of the supervisor: the same one doctor names as the listener on the port. Docker is asked once, with a ceiling of 0.7s — no answer means one line about docker, and the screen prints on. About vast there is only the memory of past commands here; for something fresher, colloq vast status.',
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
    audience: 'teacher',
    summary: 'Check that everything is in place before a class',
    usage: 'colloq doctor [--offline] [--json]',
    flags: [
      { name: 'offline', summary: 'Without the single network check' },
      { name: 'json', summary: 'Machine-readable' },
    ],
    destructive: false,
    delegates: 'native: programs, files, images, disk space; one TCP check of the relay',
    examples: ['colloq doctor', 'colloq doctor --offline'],
    notes:
      '✗ — broken, fix it; ○ — a capability is switched off, and that is not an error. Only PORT and KERNEL_ENV are printed out of .env, everything else is "present / missing". The port that gets checked is the one the class runs on (from the receipt), and its listener counts as ours by the pids of the server and of the supervisor. Code 3 if there is at least one ✗. The last line is about the perimeter: it checks nothing and does not change the code, it says how a local class differs from a server installation.',
    async run(ctx) {
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: doctor (programs, files, images, disk space; TCP to the relay — 2s)',
        )
      }
      const all = await doctorChecks(ctx)
      /*
       * В поверхности преподавателя осмотр короче — и короче осознанно: см.
       * TEACHER_CHECKS. Фильтр стоит здесь, а не внутри сбора, потому что
       * проверки идут одной параллельной пачкой и выигрыш от «не спрашивать»
       * тут нулевой, а место, где решают, что показать, — одно.
       */
      const checks =
        ctx.surface === 'teacher' ? all.filter((check) => TEACHER_CHECKS.has(check.id)) : all
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
    summary: 'Count the activity of a class and write it into a Google sheet',
    usage: 'colloq activity <room…|--all> [--replace]',
    args: [{ name: 'room', summary: 'Room: the tail of the /s/<id> link; several are allowed' }],
    // Комнат бывает несколько, и ROOM=«a b» рецепт разбирает сам: хвост
    // позиционных не лишний.
    extra: true,
    flags: [
      { name: 'all', summary: 'Every room with activity that is not in the sheet yet' },
      { name: 'replace', summary: 'Rewrite the rows of these rooms in the sheet' },
    ],
    destructive: true,
    confirm: 'cli',
    check: checker(activityTrouble),
    confirmWhen: async (ctx) => on(ctx, 'replace'),
    confirmQuestion: 'rewrite the rows of these rooms in the sheet?',
    delegates: 'make activity ROOM=… [ALL=1] [REPLACE=1]',
    examples: ['colloq activity y84w9hpc', 'colloq activity --all'],
    notes:
      'Writes outward, into Google, through gws — and gws has to be authorised: gws auth status. The sheet is taken from ACTIVITY_SHEET_ID, the database is data/colloq.db next to it. One tab is appended to, a row per person per class; the other holds a single QUERY formula over it. A new sheet is created by python3 scripts/activity-sheet.py --create "name" — there is deliberately no CLI wrapper for that.',
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
          'no ACTIVITY_SHEET_ID in .env — nowhere to write',
          'create a sheet: python3 scripts/activity-sheet.py --create "Colloq · activity"',
        )
      }
      ctx.ui.header(
        'counting the activity of ' + (all ? 'every room' : rooms) + ': writing into the sheet',
      )
      return await ctx.sh.make('activity', vars)
    },
  },

  {
    name: 'site',
    group: 'tools',
    summary: 'Publish the colloq.ru site: the landing page and published classes',
    usage: 'colloq site [--dry] [--site <path>] [--base <url>]',
    flags: [
      { name: 'dry', summary: "The script's DRY=1: build only, no commit and no push" },
      { name: 'site', arg: 'path', summary: 'Site directory (default site/)' },
      { name: 'base', arg: 'url', summary: 'Base address (default https://colloq.ru)' },
    ],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => !on(ctx, 'dry'),
    confirmQuestion: 'publish the site? there will be a commit and a push to main',
    delegates: 'make site [SITE=…] [BASE=…] [DRY=1]',
    examples: ['colloq site --dry', 'colloq site'],
    notes:
      "The only command in the whole set that touches git history. On any branch other than main the script itself refuses. It reads the local database to learn which classes are published. Two similar flags: --dry is the script's DRY=1 (build without a push), --dry-run is the common CLI flag (print the call and exit).",
    async run(ctx) {
      const site = text(ctx, 'site')
      const vars = {
        SITE: site === '' ? undefined : ctx.env.userPath(site),
        BASE: text(ctx, 'base') || undefined,
        DRY: on(ctx, 'dry') ? '1' : undefined,
      }
      if (ctx.dryRun) return await ctx.sh.make('site', vars)
      ctx.ui.header(
        on(ctx, 'dry') ? 'building the site: no push' : 'building the site and pushing to main',
      )
      return await ctx.sh.make('site', vars)
    },
  },

  {
    name: 'course',
    group: 'tools',
    summary: 'Create a course from a schedule in a sheet',
    usage:
      'colloq course --sheet <id> --col <header> [--gid <gid>] [--name <name>] [--blurb <line>] [--dry]',
    flags: [
      { name: 'sheet', arg: 'id', summary: 'A published sheet: the id from its link' },
      { name: 'gid', arg: 'gid', summary: 'Tab of the sheet (default 0)' },
      { name: 'col', arg: 'header', summary: 'Column by the TEXT of its header, not by number' },
      { name: 'name', arg: 'name', summary: 'Name of the course' },
      { name: 'blurb', arg: 'line', summary: 'Line under the name' },
      { name: 'dry', summary: "The script's DRY=1: show it and write nothing" },
    ],
    destructive: true,
    confirm: 'cli',
    check: checker(courseTrouble),
    confirmWhen: async (ctx) => !on(ctx, 'dry'),
    confirmQuestion: 'create the course? we write into data/colloq.db',
    delegates: 'make course SHEET=… GID=… COL=… [NAME=…] [BLURB=…] [DRY=1]',
    examples: [
      'colloq course --sheet SHEETID --col "ML · advanced" --dry',
      'colloq course --sheet SHEETID --gid 0 --col "ML · advanced" --name "ML · advanced"',
    ],
    notes:
      'The column is chosen by the TEXT of the header in the first row, not by its number: the quotes around "ML · advanced" are required, otherwise the shell tears it into words. The sheet has to be published — the script pulls CSV.',
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
      ctx.ui.header('creating a course from the sheet: column "' + column + '"')
      return await ctx.sh.make('course', vars)
    },
  },

  {
    name: 'load',
    group: 'tools',
    summary: 'Drive N students into a room of your own: the load test',
    usage:
      'colloq load [N] [--ramp <sec>] [--idle <sec>] [--pid <pid>] [--tree <files/s>] [--council <how many>] [--ink <frames/s>] [--staff] [--url <url>]',
    args: [{ name: 'N', summary: 'How many students (default 500)' }],
    flags: [
      { name: 'ramp', arg: 'sec', summary: 'Over how many seconds they arrive' },
      { name: 'idle', arg: 'sec', summary: 'How many seconds they just sit' },
      { name: 'pid', arg: 'pid', summary: 'Server pid, for CPU and RSS (SPID)' },
      { name: 'tree', arg: 'files/s', summary: 'Broadcast of file tree changes' },
      { name: 'council', arg: 'how many', summary: 'How many of them write in the council' },
      { name: 'ink', arg: 'frames/s', summary: 'One presenter drawing for everyone' },
      { name: 'staff', summary: 'Join with a staff cookie, past the limit on new participants' },
      { name: 'url', arg: 'url', summary: 'Where to knock (LOAD_BASE_URL)' },
    ],
    destructive: true,
    // Вопрос называет настоящую цель, а она зависит от --url.
    confirm: 'cli',
    check: (ctx) => {
      const students = ctx.positionals[0] ?? ''
      if (students !== '' && !/^\d+$/.test(students)) {
        refuse(
          'N is a number of students',
          'and what was given: ' + students,
          'colloq load 500 --ramp 60',
        )
      }
    },
    confirmQuestion: (ctx) =>
      'the load test will go at ' + loadTarget(ctx) + " — that is the teacher's server; drive it?",
    delegates: 'make load N=… RAMP=… [SPID=… IDLE=… TREE=… COUNCIL=… INK=… STAFF=1]',
    examples: ['colloq load 500 --ramp 60', 'colloq load 50 --url https://{domain}'],
    notes:
      "The load test creates a room of its own and deletes it, but it is not driven at somebody else's machine: the default LOAD_BASE_URL is http://localhost:3000, that is, the teacher's server. SPID is not guessed: for a service it is systemctl show -p MainPID colloq, for make run it is cat .colloq.pid; without --pid it is taken from the class receipt (the serverPid field), and without a receipt — from .colloq.pid. .colloq.pid holds the pid of the supervisor, not of the server: with that one the load test would measure zeros. ulimit -n 8192 is set by the Makefile itself. The load test does not echo other people's presence back to the server — the former behaviour is measured through the make form: colloq load 500 LOAD_ECHO=1. The fine knobs are make pairs: K=20 M=5 STORM=20 TREE_SEC=10 EVERY=2 COUNCIL_SEC=10 INK_SEC=10.",
    async run(ctx) {
      const students = ctx.positionals[0] ?? ''
      const url = text(ctx, 'url')
      const given = text(ctx, 'pid')
      /*
       * SPID — это номер того, кого меряют по CPU и RSS, и ошибиться в нём
       * значит получить стенд, показывающий нули: супервизор занятия во время
       * нагрузки не делает ничего, вся работа у его ребёнка. Потому при живой
       * расписке берём serverPid и только его — подставить супервизора «хоть
       * что-нибудь» здесь хуже, чем не мерить вовсе. Без расписки прежний
       * путь: .colloq.pid, куда make run писал номер самого сервера.
       */
      const session = readSession(ctx.io, ctx.env.paths.sessionFile)
      const pidText = (ctx.io.readText(ctx.env.paths.pidFile) ?? '').trim()
      const found =
        session !== null
          ? session.serverPid === null
            ? ''
            : String(session.serverPid)
          : /^\d+$/.test(pidText)
            ? pidText
            : ''
      const spid = given !== '' ? given : found
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

      if (given === '' && spid !== '') {
        // Откуда номер — часть ответа: по нему видно, сервер это или не он.
        ctx.ui.hint(
          'the server pid is taken from ' +
            (session === null ? '.colloq.pid' : 'the class receipt') +
            ': ' +
            spid,
        )
      }
      ctx.ui.header(
        'driving the load test: ' + (students || '500') + ' students at ' + loadTarget(ctx),
      )
      return await ctx.sh.make('load', vars, opts)
    },
  },

  {
    name: 'make',
    group: 'tools',
    summary: 'Call a Makefile target directly, parsing nothing',
    usage: 'colloq make <target> [VAR=value …]',
    args: [{ name: 'target', summary: 'Name of the Makefile target' }],
    extra: true,
    flags: [],
    destructive: false,
    delegates: 'make <target> [VAR=value …]',
    examples: ['colloq make vast-up NAME=hse', 'colloq make help'],
    notes:
      "The escape hatch: no confirmations, no checks, no substitutions — exactly what was typed. A target that has no wrapper at all is called the same way. A target's knobs are pairs, not flags: colloq make ui HEADED=1. After -- go make's own options (colloq make check -- -n); the common CLI flags, --dry-run among them, work only BEFORE --.",
    async run(ctx) {
      const target = ctx.positionals[0]
      if (!target) {
        ctx.ui.refuse(
          'no target to call',
          'colloq make <target> — everything after the target name goes to make as is',
          'the list of targets is below',
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
    ctx.ui.kv(SYMBOL.off + ' outside', 'not published · colloq host <name>')
    return
  }
  const tail =
    facts.tunnelPid === null
      ? ' — no tunnel process'
      : ' (' + facts.tunnel + ' pid ' + facts.tunnelPid + ')'
  ctx.ui.kv(SYMBOL.on + ' outside', host + ' · ' + facts.transport + tail)
}
