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
 * Чужие бандлы, которые фронтенд отдаёт как есть, — на место, до старта Vite.
 *
 * Воркер pdf.js и plotly.js не импортируются исходниками: это статические файлы
 * в `web/public`, и раскладывает их шаг `npm run assets` (web/package.json), то
 * есть `npm run dev` и `npm run build`. Эта команда зовёт Vite НАПРЯМУЮ, минуя
 * npm, — и на свежем клоне plotly.js (его нет в git: пять мегабайт, выводимых из
 * package-lock) не оказалось бы на месте: график вместо рисунка писал бы, что
 * не смог загрузиться. Копия — только когда её нет или она другого размера;
 * неудача не роняет запуск: без этих файлов не работают две вещи, а не всё.
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
 * Два корня вместо одного: root — где приложение, home — где занятие.
 * Разбор и причина — launch-state.ts · два корня. В репозитории это один и тот
 * же каталог, поэтому ни один путь ниже там не сдвинулся.
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
   * Расписку узнаём по каталогу СОСТОЯНИЯ, а не по каталогу приложения.
   *
   * Каталог приложения у установленного colloq меняется сам собой: обновление
   * кладёт код в новую версию пакета. Сверяй мы его — `colloq stop` после
   * `pip install -U` посреди пары отказался бы останавливать свой же живой
   * сервер («чужой процесс не остановлен»), и преподаватель остался бы с
   * работающим занятием без пульта. Владение всё равно доказывает не эта
   * строка, а имя процесса (clq:<runId>) ниже.
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
function banner(receipt: LaunchReceipt): void {
  console.log(
    `\nColloq is running\n\nLocal:  ${receipt.url}\nPanel:  ${receipt.url}/admin\nData:   ${receipt.dataDir}\nFiles:  ${receipt.workspaceDir}\n\nCtrl+C — save and stop the server and the local kernels\n`,
  )
}
/**
 * Блок ссылки --share (launch-share.ts · renderShareBlock).
 *
 * Занятия читаются из базы в миг печати, а не при запуске: туннель
 * поднимается полминуты, и занятие, созданное за это время в открывшемся
 * браузере, в блок уже попадает.
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
 * cloudflared для --share — с отказом, который говорит, как быть без него.
 * Один и тот же в терминале и в фоновом запуске.
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
/** Действующее окружение так, как его увидит сервер: .env и поверх него переменные. */
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
 * Чем снимать ядра комнат после остановки сервера.
 *
 * Уборка — это тот же серверный код (база и docker), и звали её через tsx
 * прямо по исходнику: `node --import tsx server/src/ops/local-cleanup.ts`. В
 * дистрибутиве такой строки не существует — ни server/src, ни tsx в пакете
 * нет, — а `--import tsx` на отсутствующем пакете не «ничего не делает», а
 * падает с кодом 1, то есть каждая остановка занятия заканчивалась бы
 * сообщением об ошибке при полностью убранных ядрах.
 *
 * Выбран собранный двойник рядом с сервером: server/dist/local-cleanup.js,
 * той же строкой esbuild, что и server/dist/runtime-smoke.js (см. build в
 * server/package.json) — двойник уже есть, шаблон известен, и уборка остаётся
 * отдельной короткоживущей командой. Второй рассмотренный путь — перенести
 * уборку внутрь сервера — отвергнут: сервер к этому моменту уже мёртв, а
 * страховка нужна именно на случай, когда он умер сам и своей уборки не
 * сделал.
 *
 * Порядок предпочтения разный с двух сторон, и намеренно. В репозитории
 * правда — исходник (на нём работает make dev, правку видно сразу); в
 * дистрибутиве — бандл. Если предпочтённого нет, берём второй: собранное
 * дерево без bundle и распакованный дистрибутив с исходниками одинаково
 * должны убирать за собой.
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
   * cloudflared — здесь, в терминале, а не в фоновом ребёнке: загрузка на
   * первом запуске идёт минуту, и в фоне её было бы видно только в журнале,
   * а человек смотрел бы на «Preparing the background start» без движения.
   * Ребёнок потом найдёт сверенную копию сразу (launch-cloudflared.ts).
   */
  if (options.share || options.host) {
    // Замок по настройкам — тоже здесь: отказ ребёнка лёг бы в журнал, а
    // человек прочёл бы только «фоновый запуск не удался».
    const env = effectiveEnv()
    const refusal = publishRefusal({ env })
    if (refusal) throw new Error(refusalText(refusal))
    if (options.share) await shareCloudflared(env)
  }
  const runId = randomUUID()
  const log = fs.openSync(logFile, 'a', 0o600)
  fs.chmodSync(logFile, 0o600)
  /*
   * tsx нужен ровно тогда, когда запускается исходник. В дистрибутиве этот же
   * файл приезжает собранным, и `--import tsx` там не нашлось бы: фоновый
   * запуск падал бы на «Cannot find package 'tsx'» ещё до первой строки.
   *
   * Оба корня уезжают ребёнку явными переменными. Считать их заново он мог бы
   * и сам, но относительный COLLOQ_HOME или запуск из другого каталога дали бы
   * второй ответ на тот же вопрос — и расписка оказалась бы не там, где её
   * ищет родитель.
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
        console.log(
          `Colloq is running in the background: ${receipt.url}\nLogs: colloq logs\nStop: colloq stop`,
        )
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
        if (options.open) openBrowser(`${receipt.url}/admin`)
        child.unref()
        return 0
      }
      await delay(150)
    }
    if (cancelled) return cancelled
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
      `Colloq is already ${prior.phase === 'ready' ? 'running' : 'starting'}: ${prior.url}`,
    )
    if (options.host) console.log(`For public access: colloq host ${options.host}`)
    if (options.share) console.log('For a public link: colloq host')
    if (options.open && prior.phase === 'ready') openBrowser(`${prior.url}/admin`)
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
  // Ctrl+C посреди загрузки cloudflared обрывает загрузку, а не ждёт её конца.
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
     * .env локального занятия пишет сам colloq — не копия .env.example.
     * Почему именно так: launch-config.ts · localClassEnv.
     */
    const envFile = path.join(home, '.env')
    if (!fs.existsSync(envFile)) {
      fs.writeFileSync(envFile, localClassEnv(dist), { flag: 'wx', mode: 0o600 })
      console.log(`Created ${envFile}: the settings for this machine.`)
    }
    const config = launchConfig(
      root,
      options,
      {
        ...parseEnv(fs.readFileSync(envFile)),
        ...process.env,
      },
      home,
    )
    config.env.COLLOQ_LOCAL_RUN_ID = runId
    if (
      (await portOccupied(config.port)) ||
      (config.uiPort !== config.port && (await portOccupied(config.uiPort)))
    )
      throw new Error(
        `Port ${config.port} or ${config.uiPort} is already taken. The running process was left alone.`,
      )
    /*
     * Замок публикации по настройкам — до сборки и до сервера. Отказ здесь
     * стоит секунду; тот же отказ после минуты сборки — минуту, а с
     * KERNEL_ISOLATION=off сервер и вовсе не стал бы здоровым, и человек
     * прочёл бы «не поднялся за 90 секунд» вместо причины.
     */
    const publishing = Boolean(options.host || options.share)
    const early = publishing ? publishRefusal({ env: config.env }) : null
    if (early) throw new Error(refusalText(early))
    /*
     * cloudflared для --share — тоже до сервера: первая загрузка идёт минуту,
     * и лучше ей идти, пока ничего не поднято. Не вышло — отказ сразу, с
     * причиной, а не занятие без ссылки, о котором узнают из чата группы.
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
      // Каталог состояния: он и опознаёт сессию (см. supervisorOwned).
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
      : processes.start('Server', process.execPath, ['server/dist/server.js'])
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
          'The server or the frontend exited before it was ready. Check the log above.',
        )
      const status = await health(config.port)
      const uiReady = !dev || (await devFrontendReady(config.url))
      if (status?.localRunId === runId && uiReady) break
      if (Date.now() > deadline)
        throw new Error(
          'The server did not become ready in 90 seconds. Check Docker and the log above.',
        )
      await delay(150)
    }
    if (stopping) return exitCode
    receipt.phase = 'ready'
    if (publishing) receipt.hosting = 'starting'
    writeJson(receiptFile, receipt)
    banner(receipt)
    if (options.open) openBrowser(`${config.url}/admin`)
    if (publishing) {
      /*
       * Путь до скрипта проверяется до запуска, потому что его отсутствие
       * ничем себя не выдавало. `bash scripts/host.sh` без файла уходит кодом
       * 127 — в расписку ложилось hosting: 'failed', а человек читал «Внешний
       * доступ завершён (код 127). Локальная работа продолжается», то есть
       * «что-то закончилось», а не «класса снаружи не видно». С этим и шли на
       * пару. Отказ теперь называет файл и говорит, что делать.
       *
       * Имя абсолютное: cwd ребёнка — каталог приложения, и относительное имя
       * проверялось бы не там, где запускается.
       */
      const script = path.join(root, 'scripts/host.sh')
      /*
       * Замок публикации по живому серверу: демон docker отвечает, и сервер
       * сам называет, чем разделены комнаты (/api/health · isolation). До
       * туннеля, а не после: дверь, открытая на секунду, — всё равно дверь.
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
         * Каталог состояния уезжает ребёнку явной переменной: скрипт ищет в
         * нём .env, расписку занятия и .colloq.pid, а сам взял бы каталог над
         * scripts/ — у поставленного colloq это каталог приложения, где ничего
         * этого нет (scripts/lib.sh · COLLOQ_STATE_ROOT). У запуска из
         * терминала COLLOQ_HOME в окружении может и не быть вовсе: супервизор
         * считает его сам.
         *
         * У --share имя пустое нарочно: пустой COLLOQ_HOSTNAME и есть быстрый
         * туннель, и строка в .env или в оболочке не должна увести ссылку в
         * именованный. COLLOQ_CLOUDFLARED — файл, найденный и сверенный выше:
         * скрипт не ищет его второй раз. COLLOQ_SHARE=1 просит скрипт не
         * печатать свой итог, а сказать строкой-меткой, что адрес поднят; итог
         * печатаем мы, одним блоком (launch-share.ts).
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
      console.error('The local server or frontend exited. Stopping the remaining processes.')
    }
    return exitCode
  } catch (error) {
    if (!stopping) console.error(error instanceof Error ? error.message : String(error))
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
       * Страховки нет — и это стоит сказать вслух, но не сорвать остановку:
       * ненулевым кодом выхода не погаснет ни один контейнер. Штатный путь
       * ядра уже убрал: сервер по SIGTERM снимает ядра комнат сам
       * (server/src/index.ts, COLLOQ_STOP_KERNELS_ON_EXIT=1). Теряется только
       * подстраховка на случай, когда сервер умер сам и до неё не дошёл.
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
     * Служебное слово для scripts/host.sh: путь — в stdout (скрипт берёт его
     * через $(...)), слова о загрузке — в stderr, прямо в терминал человека.
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
