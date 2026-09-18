import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { LaunchOptions } from './launch-config.js'

/*
 * ------------------------------------------------------------------ два корня
 *
 * Корень был один — репозиторий, — и в нём лежало сразу всё: и server/dist с
 * web/dist, и .env, и data/ с базой, и workspace/ с файлами студентов. Пока
 * colloq запускали из клона, это было правдой и ничего не стоило.
 *
 * `pip install colloq` эту правду ломает. Код приезжает туда, куда его кладёт
 * установщик (site-packages, Cellar, /usr/lib): каталог перезаписывается
 * следующим обновлением целиком и на многих машинах не пишется вовсе. Занятие
 * же — это .env с ключами входа, data/ с базой занятий и workspace/ с
 * тетрадями; потерять их при `pip install -U` нельзя, а класть рядом с кодом
 * значит однажды потерять.
 *
 * Поэтому корня два, и они названы:
 *   COLLOQ_APP_DIR — приложение: server/dist, web/dist, kernel/, node_modules;
 *   COLLOQ_HOME    — состояние: .env, .colloq/, .colloq.pid, .colloq.log,
 *                    data/, workspace/.
 *
 * Первое правило важнее остальных: в репозитории оба указывают на репозиторий.
 * Разработка не меняется ни на шаг — те же файлы на тех же местах, те же
 * тесты; расхождение начинается только там, где приложение установлено.
 *
 * Почему здесь, а не в env.ts, где живут остальные пути CLI. launch*.ts должны
 * запускаться отдельно от остального CLI: tests/local-launch-process.test.mts
 * собирает стенд, копируя в него ровно `cli/src/launch*.ts`, и импорт env.js
 * из launch.ts этот стенд не нашёл бы. Реализация одна и лежит в файле с
 * префиксом launch; env.ts её перепечатывает наружу для команд (env.ts ·
 * appDir/homeDir), чтобы у CLI не завелось второго ответа на тот же вопрос.
 */

/** Каталог этого файла: <app>/cli/src в репозитории, <app>/cli у бандла. */
const selfDir = path.dirname(fileURLToPath(import.meta.url))

/** `~` в значении переменной: оболочка его не раскрывает, если её просили о кавычках. */
function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value
}

/** Репозиторий: Makefile рядом с package.json, где name — colloq. */
function isRepository(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, 'Makefile'))) return false
    return /"name"\s*:\s*"colloq"/.test(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return false
  }
}

/**
 * Рабочее дерево без примет репозитория: исходники CLI лежат на месте.
 *
 * Так выглядят стенды тестов (копия cli/src/launch*.ts в пустом каталоге, без
 * Makefile) и клон, у которого Makefile переименовали. Состояние в таком
 * каталоге остаётся рядом с кодом — ровно как было всегда; уводить его в
 * ~/.colloq стоит только у установленного приложения, где рядом с кодом ему
 * не выжить.
 */
function isWorkingTree(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'cli/src/launch.ts'))
}

/**
 * Признак «это готовый дистрибутив, а не исходники»: <app>/.colloq-dist.json.
 *
 * Файл кладёт сборщик пакета. Всё, что решается по нему, решается одинаково:
 * не считать отпечаток исходников, не звать npm и make, не искать tsx — в
 * дистрибутиве ничего этого нет и не будет.
 */
export function isDistribution(dir = appDir()): boolean {
  return fs.existsSync(path.join(dir, '.colloq-dist.json'))
}

/**
 * Каталог, похожий на корень приложения: репозиторий, распакованный
 * дистрибутив или просто собранное дерево.
 *
 * Искать приходится по приметам, а не отсчитывать уровни: в репозитории этот
 * код лежит в cli/src/launch-state.ts, а в пакете тот же код приезжает одним
 * бандлом cli/launch.mjs (scripts/pack.mts) — на уровень выше. Фиксированное
 * «два вверх» было бы верным ровно в одной из двух раскладок и промахнулось бы
 * мимо корня в другой, причём молча.
 */
function looksLikeApp(dir: string): boolean {
  if (isRepository(dir) || fs.existsSync(path.join(dir, '.colloq-dist.json'))) return true
  return (
    fs.existsSync(path.join(dir, 'server/dist/server.js')) &&
    fs.existsSync(path.join(dir, 'web/dist'))
  )
}

let appCache: string | undefined
/** Каталог приложения. */
export function appDir(): string {
  if (appCache) return appCache
  const explicit = process.env.COLLOQ_APP_DIR
  if (explicit) return (appCache = path.resolve(expandHome(explicit)))
  for (let dir = selfDir, step = 0; step < 12; step++) {
    if (looksLikeApp(dir)) return (appCache = dir)
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  // Последнее слово — прежнее выражение launch.ts: два уровня над cli/src.
  return (appCache = path.resolve(selfDir, '../..'))
}

/** Каталог пользователя для состояния, когда рядом с кодом ему не место. */
function userStateDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  return xdg && path.isAbsolute(xdg) ? path.join(xdg, 'colloq') : path.join(os.homedir(), '.colloq')
}

function resolveHome(): string {
  // Относительный COLLOQ_HOME считается от текущего каталога человека; детям
  // (фоновый запуск) он уезжает уже абсолютным — launch.ts · detached.
  const explicit = process.env.COLLOQ_HOME
  if (explicit) return path.resolve(expandHome(explicit))
  const app = appDir()
  if (isRepository(app)) return app
  if (isDistribution(app)) return userStateDir()
  if (isWorkingTree(app)) return app
  return userStateDir()
}

let homeCache: string | undefined
/** Каталог состояния; заводится при первом обращении. */
export function homeDir(): string {
  if (homeCache) return homeCache
  const home = resolveHome()
  // 0700 действует только при создании: внутри .env с ключами входа и data/.
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  return (homeCache = home)
}

/**
 * Расписка идущего занятия — относительным именем, одним на всех.
 *
 * Пишет её супервизор (launch.ts), читают команды (commands/local.ts,
 * commands/tools.ts) и каркас. Пока имя было выписано в каждом месте своей
 * строкой, стороны разъехались молча: команды искали расписку в каталоге
 * ПРИЛОЖЕНИЯ, супервизор писал в каталог СОСТОЯНИЯ, и у установленного colloq
 * `colloq stop` отвечал «занятие не идёт», пока занятие шло. Имя здесь одно,
 * а от какого корня его считать — решает тот, кто зовёт.
 */
export const SESSION_FILE = '.colloq/local-session.json'

export interface LaunchReceipt {
  pid: number
  runId: string
  root: string
  port: number
  url: string
  dataDir: string
  workspaceDir: string
  leaseFile: string
  mode: 'run' | 'dev'
  startedAt: number
  phase: 'preparing' | 'starting' | 'ready' | 'stopping'
  options: LaunchOptions
  serverPid?: number
  hosting?: 'starting' | 'failed'
}
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}`
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 })
  try {
    fs.renameSync(temporary, file)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
}
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
export function readReceipt(file: string): LaunchReceipt | null {
  const value = readJson<LaunchReceipt>(file)
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    !['run', 'dev'].includes(value.mode) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !['root', 'url', 'dataDir', 'workspaceDir', 'leaseFile'].every(
      (key) => typeof (value as unknown as Record<string, unknown>)[key] === 'string',
    ) ||
    !value.options ||
    typeof value.options !== 'object'
  )
    return null
  return value
}

/** Reclaim under a separate exclusive guard: two stale-lock readers cannot unlink a new owner. */
export function acquireLock(file: string, pid: number, runId: string, isAlive = alive): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const create = (): void => {
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid, runId }) + '\n')
    } finally {
      fs.closeSync(fd)
    }
  }
  try {
    create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const guard = `${file}.reclaim`
    try {
      fs.mkdirSync(guard, { mode: 0o700 })
    } catch {
      throw new Error('Another run is already checking the local session. Repeat the command.')
    }
    try {
      const prior = readJson<{ pid: number; runId: string }>(file)
      if (!prior || isAlive(prior.pid))
        throw new Error(
          'A local session is already starting or running. Use colloq status / colloq stop.',
        )
      fs.unlinkSync(file)
      create()
    } finally {
      fs.rmdirSync(guard)
    }
  }
  return () => {
    if (readJson<{ runId: string }>(file)?.runId === runId) fs.unlinkSync(file)
  }
}
