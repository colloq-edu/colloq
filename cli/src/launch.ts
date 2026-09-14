/** Local session supervisor. Administrative deployment remains in the existing scripts. */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parse as parseEnv } from 'dotenv'
import { launchConfig, parseLaunchArgs, type LaunchOptions } from './launch-config.js'
import { capture, delay, Processes, type ManagedProcess } from './launch-process.js'
import {
  acquireLock,
  alive,
  readJson,
  readReceipt,
  writeJson,
  type LaunchReceipt,
} from './launch-state.js'
import { prepare } from './launch-prepare.js'
import { leaseUrl } from '../../shared/local-public-url-lease.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const receiptFile = path.join(root, '.colloq/local-session.json')
const pidFile = path.join(root, '.colloq.pid')
const logFile = path.join(root, '.colloq.log')
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
  if (receipt.root !== root || !alive(receipt.pid)) return false
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
  child.on('error', () => console.log(`Откройте в браузере: ${url}`))
  child.unref()
}
function banner(receipt: LaunchReceipt): void {
  console.log(
    `\nColloq работает\n\nЛокально:  ${receipt.url}\nПанель:    ${receipt.url}/admin\nДанные:    ${receipt.dataDir}\nФайлы:     ${receipt.workspaceDir}\n\nCtrl+C — сохранить и остановить сервер и локальные ядра\n`,
  )
}
async function stopSession(): Promise<LaunchReceipt | null> {
  const receipt = readReceipt(receiptFile)
  if (!receipt) {
    console.log('Локальная сессия не найдена.')
    return null
  }
  if (!alive(receipt.pid)) {
    console.log('Локальная сессия уже завершена.')
    return receipt
  }
  if (!(await supervisorOwned(receipt)))
    throw new Error('PID из расписки не принадлежит этому запуску. Чужой процесс не остановлен.')
  console.log('Сохраняю и останавливаю локальную сессию…')
  process.kill(receipt.pid, 'SIGTERM')
  const deadline = Date.now() + GRACE * 2 + 10000
  while (Date.now() < deadline) {
    if (readReceipt(receiptFile)?.runId !== receipt.runId && !alive(receipt.pid)) {
      const result = readJson<{ runId: string; error: string | null }>(
        path.join(root, '.colloq/local-session-result.json'),
      )
      if (result?.runId === receipt.runId && result.error)
        throw new Error(result.error + ' Проверьте colloq logs.')
      return receipt
    }
    await delay(100)
  }
  throw new Error('Остановка не завершилась. Проверьте colloq logs; процесс не убит принудительно.')
}
function childArgs(options: LaunchOptions): string[] {
  const args = [options.action, '--child']
  if (options.detach) args.push('--detach')
  if (!options.open) args.push('--no-open')
  if (options.fast) args.push('--fast')
  if (options.build) args.push('--build')
  if (options.host) args.push('--host', options.host)
  if (options.port) args.push('--port', String(options.port))
  return args
}
async function detached(options: LaunchOptions): Promise<number> {
  const existing = readReceipt(receiptFile)
  if (existing && (await supervisorOwned(existing))) {
    console.log(`Colloq уже работает: ${existing.url}`)
    return 0
  }
  const runId = randomUUID()
  const log = fs.openSync(logFile, 'a', 0o600)
  fs.chmodSync(logFile, 0o600)
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...childArgs(options)], {
    cwd: root,
    env: { ...process.env, COLLOQ_LAUNCH_ID: runId },
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
    console.log(`Подготавливаю фоновый запуск. Журнал: ${logFile}`)
    while (!ended) {
      const receipt = readReceipt(receiptFile)
      let publicUrl: string | undefined
      if (receipt?.runId === runId) {
        try {
          publicUrl = leaseUrl(fs.readFileSync(receipt.leaseFile, 'utf8'), runId, Date.now())
        } catch {}
      }
      if (
        !cancelled &&
        receipt?.runId === runId &&
        receipt.phase === 'ready' &&
        (!options.host || publicUrl || receipt.hosting === 'failed')
      ) {
        console.log(
          `Colloq работает в фоне: ${receipt.url}\nЛоги: colloq logs\nОстановить: colloq stop`,
        )
        if (publicUrl) console.log(`Внешний адрес: ${publicUrl}`)
        else if (options.host)
          console.log(`Туннель не поднялся; локальная работа продолжается. Подробности: ${logFile}`)
        if (options.open) openBrowser(`${receipt.url}/admin`)
        child.unref()
        return 0
      }
      await delay(150)
    }
    if (cancelled) return cancelled
    throw new Error(failure || `Фоновый запуск не удался. Журнал: ${logFile}`)
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}

async function runSession(options: LaunchOptions): Promise<number> {
  const prior = readReceipt(receiptFile)
  if (prior && (await supervisorOwned(prior))) {
    console.log(`Colloq уже ${prior.phase === 'ready' ? 'работает' : 'запускается'}: ${prior.url}`)
    if (options.host) console.log(`Для внешнего доступа: colloq host ${options.host}`)
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
  const stop = (code: number): void => {
    if (stopping) return
    stopping = true
    exitCode = code
    console.log('\nОстанавливаю локальную сессию…')
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
    releases.push(acquireLock(path.join(root, '.colloq/local-session.lock'), process.pid, runId))
    const legacy = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : 0)
    if (legacy && alive(legacy))
      throw new Error(
        'Уже работает сервер из .colloq.pid. Используйте его или явно остановите через colloq stop.',
      )
    const envFile = path.join(root, '.env')
    if (!fs.existsSync(envFile)) {
      const example = fs
        .readFileSync(path.join(root, '.env.example'), 'utf8')
        .replace(/^JUPYTER_TOKEN=.*$/m, `JUPYTER_TOKEN=${randomBytes(24).toString('hex')}`)
      fs.writeFileSync(envFile, example, { flag: 'wx', mode: 0o600 })
      console.log('Создан .env из примера.')
    }
    const config = launchConfig(root, options, {
      ...parseEnv(fs.readFileSync(envFile)),
      ...process.env,
    })
    config.env.COLLOQ_LOCAL_RUN_ID = runId
    if (
      (await portOccupied(config.port)) ||
      (config.uiPort !== config.port && (await portOccupied(config.uiPort)))
    )
      throw new Error(
        `Порт ${config.port} или ${config.uiPort} уже занят. Работающий процесс не изменён.`,
      )
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
      root,
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
    const server = dev
      ? processes.start('Сервер dev', process.execPath, [
          path.join(root, 'node_modules/tsx/dist/cli.mjs'),
          'watch',
          '--clear-screen=false',
          'server/src/index.ts',
        ])
      : processes.start('Сервер', process.execPath, ['server/dist/server.js'])
    started = true
    receipt.serverPid = server.child.pid
    writeJson(receiptFile, receipt)
    let frontend: ManagedProcess | undefined
    if (dev) {
      frontend = processes.start('Интерфейс dev', process.execPath, [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        path.join(root, 'web'),
        '--host',
        '127.0.0.1',
        '--port',
        String(config.uiPort),
        '--strictPort',
      ])
    }
    const deadline = Date.now() + 90000
    while (!stopping) {
      if (server.settled || frontend?.settled)
        throw new Error('Сервер или интерфейс завершился до готовности. Проверьте журнал выше.')
      const status = await health(config.port)
      let uiReady = !dev
      if (dev)
        try {
          uiReady = (await fetch(config.url, { signal: AbortSignal.timeout(1000) })).ok
        } catch {}
      if (status?.localRunId === runId && uiReady) break
      if (Date.now() > deadline)
        throw new Error('Сервер не стал готов за 90 секунд. Проверьте Docker и журнал выше.')
      await delay(150)
    }
    if (stopping) return exitCode
    receipt.phase = 'ready'
    if (options.host) receipt.hosting = 'starting'
    writeJson(receiptFile, receipt)
    banner(receipt)
    if (options.open) openBrowser(`${config.url}/admin`)
    if (options.host) {
      tunnel = processes.start('Внешний доступ', 'bash', ['scripts/host.sh'], false, {
        COLLOQ_HOSTNAME: options.host,
      })
      void tunnel.done.then((code) => {
        if (!stopping && receipt) {
          receipt.hosting = 'failed'
          writeJson(receiptFile, receipt)
          console.log(
            `\nВнешний доступ завершён (код ${code}). Локальная работа продолжается: ${config.url}\nПовторить: colloq host ${options.host}`,
          )
        }
      })
    }
    const ended = await Promise.race([server.done, ...(frontend ? [frontend.done] : [])])
    if (!stopping) {
      exitCode = ended || 1
      console.error('Локальный сервер или интерфейс завершился. Останавливаю оставшиеся процессы.')
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
    if (started && processes) {
      const cleanup = processes.start('Остановка ядер', process.execPath, [
        '--import',
        'tsx',
        'server/src/ops/local-cleanup.ts',
      ])
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
            ? 'Остановка ядер превысила время ожидания.'
            : `Остановка ядер завершилась с кодом ${cleanupCode}.`
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
    if (receipt)
      writeJson(path.join(root, '.colloq/local-session-result.json'), {
        runId,
        error: cleanupFailure,
      })
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
    if (cleanupFailure)
      throw new Error(cleanupFailure + ' Проверьте colloq logs; данные сохранены.')
  }
}

async function main(): Promise<number> {
  const options = parseLaunchArgs(process.argv.slice(2))
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
