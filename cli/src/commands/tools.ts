/**
 * Инструменты — посмотреть и проверить: status и doctor.
 *
 * Два вопроса, которые преподаватель задаёт своему ноутбуку: «что на нём
 * сейчас идёт» и «всё ли на месте перед парой». Оба только читают — ничего
 * не запускают, ничего не пишут и в сеть не ходят: экран, который смотрят за
 * пять минут до звонка, не имеет права ни ждать чужой машины, ни что-то
 * менять.
 *
 * Мастерская — таблица активности, лендинг, курс из расписания, нагрузочный
 * стенд, аренда машин — живёт в Makefile и scripts/, и отсюда о ней ни слова:
 * ни строки на экране, ни подсказки. Совет, который нечем выполнить после
 * `pip install colloq`, читается как поломка, поэтому каждая подсказка ниже
 * называет команду этого CLI или то, что ставят руками (brew, pip).
 *
 * --json есть ровно у status, doctor и env list: команда
 * объявляет флаг {name:'json'}, иначе каркас откажет с кодом 2.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.sh и ctx.io.
 */
import type { Command, Ctx } from '../registry.js'
import { SYMBOL } from '../ui.js'
import { joinPath } from '../env.js'
import { readSession, type Session } from '../session.js'
import { leaseUrl } from '../../../shared/local-public-url-lease.js'
// Те же слова, что говорит colloq host: два места, одна формулировка — см.
// PERIMETER в host.ts. Расходиться им нельзя, иначе одно из двух окажется
// неправдой.
import { PERIMETER } from './host.js'

// ------------------------------------------------------------------ мелочь

/** Булев флаг. */
function on(ctx: Ctx, name: string): boolean {
  return ctx.values[name] === true
}

/** Ответ несостоявшегося вызова: программы нет, спрашивать нечего. */
function missing(): Promise<{ code: number; stdout: string; stderr: string }> {
  return Promise.resolve({ code: 127, stdout: '', stderr: '' })
}

/**
 * Чем чинить собранное приложение.
 *
 * Панель приезжает в колесе готовой и уже сжатой (scripts/pack.mts собирает
 * её build:optimized), а собрать её у преподавателя нечем: ни npm-сборки, ни
 * исходников в пакете нет. Нет её или она не сжата — значит, установка
 * неполная, и выход один — поставить пакет заново. Тот же совет даёт и запуск
 * (launch-prepare.ts), чтобы doctor и `colloq start` не советовали разное.
 *
 * Из рабочего дерева совет тот же: CLI ведёт себя одинаково, откуда бы его ни
 * звали, а тот, кто держит исходники, знает `npm run build` и без подсказки.
 */
const REINSTALL = 'reinstall colloq: pip install --force-reinstall colloq'

/**
 * Чем получить образ ядра.
 *
 * `colloq env build` у установленного colloq отказывает нарочно — собирать
 * образ заранее незачем, это делает запуск, — и посылать туда человека значит
 * послать его в отказ. Совет один и тот же, откуда бы ни звали CLI.
 */
const KERNEL_IMAGE_FIX = 'colloq start — the image is built before the class'

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

/**
 * Один вызов docker на весь экран: метка комнаты, служба compose, состояние — и
 * ЗАНЯТИЕ, которому контейнер принадлежит.
 *
 * Занятие нужно потому, что контейнеров у него два: его собственный и тот, где
 * считаются личные тетради его студентов. Считать строки значило бы написать
 * «2 комнаты» там, где идёт одна пара.
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
   * расписки остаётся .colloq.pid: его пишет `make run` в рабочем дереве, и
   * там лежит номер самого сервера.
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

  // Всё, что можно спросить у системы, спрашивается разом: экран должен
  // успеть за секунду.
  const [docker, image, etime, frpc, cloudflared] = await Promise.all([
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

  const seen = new Set<string>()
  let appRunning = false
  for (const line of docker.stdout.split('\n')) {
    const [kind, compose, state, session] = line.split('|')
    // По занятиям, а не по контейнерам: у одной пары их два.
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
   * Форма — то, чем этот сервер завели, и называется она той командой, которой
   * его заводят: по ней же человек поймёт, чем его остановить.
   *
   * Расписка идёт первой: если она жива, порт и номера уже взяты из неё, и
   * назвать эту же пару «контейнером» значило бы собрать на одной строке два
   * разных сервера. Режим dev супервизора заводят `npm run dev` в рабочем
   * дереве — у CLI такой команды нет, и называть её `colloq dev` значило бы
   * отправить к слову, которого он не знает. Дальше — то, что бывает на
   * ноутбуке без расписки: compose-контейнер app (`make up`) и сервер, который
   * `make run` оставил в .colloq.pid. Служба systemd и кластер — формы
   * выделенной машины, у преподавательского CLI их нет.
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
     * Под подписью «сервер» стоит номер СЕРВЕРА, и только он: тем же номером
     * называет слушателя порта doctor, а до этой правки два экрана звали один
     * и тот же сервер по-разному — status номером супервизора, doctor номером
     * его ребёнка. Пока сервер занятия не поднялся, номера нет вовсе, и строка
     * обойдётся портом и временем: выдать вместо него супервизора значило бы
     * вернуть ту же путаницу. Номер из .colloq.pid печатается, только если ps
     * подтвердил, что он жив: рядом с «container» мёртвый номер от прошлого
     * `make run` выдавал бы себя за сервер контейнера.
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
  // Ссылка отдельной строкой — только когда её есть кому дать: в строке
  // «наружу» местный адрес уже назван, и второй раз он читается как другой.
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
 * Строка «сервер». hint:false — для --short: две строки обещаны ровно двумя, и
 * подсказка под незапущенным сервером делала их тремя как раз тогда, когда
 * смотреть не на что.
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

/** Чем занятие выходит наружу: ретранслятор или быстрый туннель. */
const PROGRAMS = ['frpc', 'cloudflared'] as const

/*
 * Осмотр отвечает на один вопрос: пойдёт ли занятие на ЭТОЙ машине и пустит
 * ли она класс. Ключи чужой инфраструктуры (аренда, ретранслятор как машина,
 * Cloudflare, таблица активности), средства сборки и формы выделенной машины
 * из этого вопроса выпадают — их проверяет мастерская своими скриптами.
 *
 * Сети здесь нет вовсе. Единственная сетевая проверка была про ретранслятор
 * как машину — вопрос того, кто его держит, а не того, кто ведёт пару; вместе
 * с ней ушёл и флаг --offline, выключать стало нечего.
 */
async function doctorChecks(ctx: Ctx): Promise<Check[]> {
  const { env, io, sh } = ctx
  const kernelEnv = env.kernelEnv()
  const relay = env.relay()
  const pidText = (io.readText(env.paths.pidFile) ?? '').trim()
  /*
   * Осмотр идёт по тому порту, на котором идёт занятие, а не по тому, что
   * записан в .env: `colloq run --port 4100` .env не трогает, и проверка порта
   * 3000 отвечала бы «свободен» про порт, которого класс в глаза не видел.
   */
  const session = readSession(io, env.paths.sessionFile)
  const port = session?.port ?? env.port()

  const [programs, info, image, listen, disk] = await Promise.all([
    // Одна оболочка на обе программы: отдельные вызовы стоили бы вдвое дольше.
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
     * и подсказка ниже сама зовёт чистить backups/. У поставленного через pip
     * colloq каталоги разные, и легко на разных томах: осмотр показывал
     * свободное место под site-packages, а кончалось оно у данных.
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
   * расписка ещё не переписана. .colloq.pid остаётся третьим: без расписки его
   * пишет `make run` в рабочем дереве, и там лежит номер самого сервера.
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
    hint: REINSTALL,
  })

  /*
   * Обе программы ставят руками, и совет — те же слова, какими отказывает
   * scripts/host.sh, не найдя их: у доктора и у `colloq host` он один.
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
   * Сеть комнат — проверка настройки, а не слова. По умолчанию ядра не
   * достают до локальных адресов (LAN, роутер, сам компьютер, метаданные
   * облака; server/src/kernel/perimeter.ts), и это ✓. COLLOQ_ROOM_NETWORK=open
   * снимает запрет — ○, как у всякой выключенной возможности: ошибкой это не
   * считается (так решил тот, кто написал строку), но вслух сказано перед
   * каждой парой. Встал ли запрет на деле, доктор не знает и не спрашивает —
   * это видно в журнале на старте сервера, а без запрета комнаты не
   * поднимаются вовсе, с текстом о том, как быть.
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

// ------------------------------------------------------------------ реестр

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
        // Ровно две строки и без подсказок: «идёт ли и видно ли снаружи» —
        // одним взглядом, без остального экрана.
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
