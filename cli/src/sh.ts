/**
 * Запуск подчинённых процессов. Больше CLI ничего не делает сам: цели
 * Makefile и scripts/*.sh знают своё дело, наша задача — не мешать.
 *
 * Поток ребёнка идёт без изменений: stdio наследуется, ни перехвата, ни
 * перерисовки, ни фильтрации. Скрипты сами нумеруют шаги («5/7 ставлю
 * docker»), и прятать это нельзя. Отказы делегированного скрипта тоже не
 * переписываются: его stderr уходит как есть.
 *
 * --dry-run печатает ровно одну строку — то, что выполнилось бы, — и не
 * запускает ничего. Значения из .env в неё не подставляются никогда: секреты
 * живут в .env, в argv их нет.
 */
import { constants } from 'node:os'
import type { Ui } from './ui.js'

export type RunOptions = {
  cwd?: string
  /** Добавка к окружению ребёнка. В строке --dry-run идёт префиксом `VAR=v ...`. */
  env?: Record<string, string>
}

export type CaptureOptions = {
  cwd?: string
  env?: Record<string, string>
  /** Мягкий потолок ожидания; по истечении ребёнок убивается, код 124. */
  timeoutMs?: number
}

export type CaptureResult = { code: number; stdout: string; stderr: string }

/**
 * Подставной исполнитель для тестов: приходит полем Deps.runner в cli().
 * Пока он стоит, ни один настоящий процесс не запускается.
 */
export type Runner = {
  run(cmd: string, args: string[], opts: RunOptions): Promise<number>
  capture(cmd: string, args: string[], opts: CaptureOptions): Promise<CaptureResult>
}

export type Sh = {
  /** Запустить и отдать код выхода. Поток ребёнка — наружу без изменений. */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<number>
  /** Запустить молча и забрать вывод: для status и doctor. Наружу не печатает ничего. */
  capture(cmd: string, args: string[], opts?: CaptureOptions): Promise<CaptureResult>
  /** `make <цель> K=v …` — пустые пары отбрасываются, переменные командной строки добавляются. */
  make(
    target: string,
    vars?: Record<string, string | undefined>,
    opts?: RunOptions,
  ): Promise<number>
  /** `npm run <скрипт> -- …` из корня репозитория. */
  npm(script: string, args?: string[], opts?: RunOptions): Promise<number>
  /** Прямой вызов scripts/*.sh — для того, чего нет целью. */
  script(path: string, args?: string[], opts?: RunOptions): Promise<number>
  /** Native-команда под --dry-run: одна строка `native: …`, код 0. */
  dry(line: string): number
  /** Переменные командной строки make, снятые из argv: они уходят каждому вызову make. */
  readonly makeVars: Record<string, string>
  /** Идёт ли --dry-run. */
  readonly dryRun: boolean
}

export type ShOptions = {
  root: string
  ui: Ui
  dryRun?: boolean
  makeVars?: Record<string, string>
  runner?: Runner | null
}

/**
 * Проба TCP одной строкой для `node -e`: соединение до адреса и порта, две
 * секунды на ответ, код 0 — отвечает.
 *
 * Подчинённым процессом, а не своим сокетом: node:* группам команд закрыт, а
 * sh.capture — та самая дверь, которую тест подменяет целиком. Живёт здесь,
 * потому что нужна двоим: `colloq relay ping` и `colloq doctor`.
 */
export const TCP_PROBE = [
  "const net = require('net')",
  'const [addr, port] = process.argv.slice(1)',
  'const socket = net.connect({ host: addr, port: Number(port) })',
  'const done = (code) => { socket.destroy(); process.exit(code) }',
  'socket.setTimeout(2000)',
  "socket.on('connect', () => done(0))",
  "socket.on('timeout', () => done(1))",
  "socket.on('error', () => done(1))",
].join('; ')

/** Отвечает ли адрес: одно соединение TCP, две секунды, ничего больше. */
export async function probeTcp(sh: Sh, addr: string, port: number): Promise<boolean> {
  const result = await sh.capture('node', ['-e', TCP_PROBE, addr, String(port)], {
    timeoutMs: 2500,
  })
  return result.code === 0
}

/** Код выхода по сигналу: 128 + номер, как в оболочке. SIGINT — 130. */
export function exitFromSignal(signal: NodeJS.Signals): number {
  const number = constants.signals[signal]
  return 128 + (typeof number === 'number' ? number : 2)
}

/** Кавычки для строки --dry-run: ровно настолько, чтобы её можно было скопировать. */
export function quote(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** Строка вызова так, как он выполнится: `VAR=v make host HOST=…`. */
export function commandLine(cmd: string, args: string[], env?: Record<string, string>): string {
  const head = env
    ? Object.entries(env)
        .map(([key, value]) => key + '=' + quote(value))
        .join(' ')
    : ''
  const body = [cmd, ...args].map(quote).join(' ')
  return head ? head + ' ' + body : body
}

export function createSh(opts: ShOptions): Sh {
  const { root, ui } = opts
  const dryRun = opts.dryRun ?? false
  const makeVars = opts.makeVars ?? {}
  const runner: Runner | null = opts.runner ?? null

  const real: Runner = {
    async run(cmd, args, runOpts) {
      const { spawn } = await import('node:child_process')
      return await new Promise<number>((resolve) => {
        const child = spawn(cmd, args, {
          cwd: runOpts.cwd ?? root,
          env: { ...process.env, ...(runOpts.env ?? {}) },
          stdio: 'inherit',
        })
        // Ctrl+C уходит ребёнку, и мы ждём его выхода: свой вывод не дописываем.
        const forward = (signal: NodeJS.Signals) => () => {
          try {
            child.kill(signal)
          } catch {
            /* ребёнок уже ушёл */
          }
        }
        const onInt = forward('SIGINT')
        const onTerm = forward('SIGTERM')
        const onHangup = forward('SIGHUP')
        process.on('SIGINT', onInt)
        process.on('SIGTERM', onTerm)
        process.on('SIGHUP', onHangup)
        const done = (code: number) => {
          process.off('SIGINT', onInt)
          process.off('SIGTERM', onTerm)
          process.off('SIGHUP', onHangup)
          resolve(code)
        }
        child.on('error', () => done(127))
        // Сигнал — это 128 + номер, как в оболочке: 130 остаётся ровно за
        // SIGINT. Иначе снесённый по нехватке памяти ребёнок выглядел бы как
        // отказ человека, и в state.json попадало бы «прервали вручную».
        child.on('close', (code, signal) => done(signal ? exitFromSignal(signal) : (code ?? 0)))
      })
    },
    async capture(cmd, args, captureOpts) {
      const { spawn } = await import('node:child_process')
      return await new Promise<CaptureResult>((resolve) => {
        const child = spawn(cmd, args, {
          cwd: captureOpts.cwd ?? root,
          env: { ...process.env, ...(captureOpts.env ?? {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let timer: NodeJS.Timeout | null = null
        // Свой ли это потолок: только собственный таймер даёт 124, чужой
        // сигнал — 128 + номер. Иначе убитый снаружи ребёнок выдавал бы себя
        // за истёкшее время.
        let expired = false
        child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
        child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
        child.stdin?.end()
        if (captureOpts.timeoutMs) {
          timer = setTimeout(() => {
            expired = true
            try {
              child.kill('SIGKILL')
            } catch {
              /* уже ушёл */
            }
          }, captureOpts.timeoutMs)
        }
        const done = (code: number) => {
          if (timer) clearTimeout(timer)
          resolve({ code, stdout, stderr })
        }
        child.on('error', () => done(127))
        child.on('close', (code, signal) => {
          if (expired) return done(124)
          done(signal ? exitFromSignal(signal) : (code ?? 0))
        })
      })
    },
  }

  const sh: Sh = {
    get makeVars() {
      return makeVars
    },
    get dryRun() {
      return dryRun
    },
    dry(line) {
      ui.line(line)
      return 0
    },
    async run(cmd, args, runOpts = {}) {
      if (dryRun) {
        ui.line(commandLine(cmd, args, runOpts.env))
        return 0
      }
      return await (runner ?? real).run(cmd, args, runOpts)
    },
    async capture(cmd, args, captureOpts = {}) {
      // capture наружу не печатает ничего и под --dry-run тоже: это чтение
      // состояния, а не действие.
      return await (runner ?? real).capture(cmd, args, captureOpts)
    },
    async make(target, vars = {}, runOpts = {}) {
      const pairs: string[] = []
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined || value === '') continue
        pairs.push(key + '=' + value)
      }
      // Переменные, снятые из командной строки, идут следом и главнее: make
      // экспортирует их в рецепт — так работают MODE, RESUME, FORCE, REPLACE,
      // SINCE, RELEASE.
      for (const [key, value] of Object.entries(makeVars)) pairs.push(key + '=' + value)
      return await sh.run('make', [target, ...pairs], runOpts)
    },
    async npm(script, args = [], runOpts = {}) {
      const tail = args.length ? ['--', ...args] : []
      return await sh.run('npm', ['run', script, ...tail], runOpts)
    },
    async script(path, args = [], runOpts = {}) {
      return await sh.run(path, args, runOpts)
    },
  }
  return sh
}
