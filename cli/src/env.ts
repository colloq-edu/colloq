/**
 * Откуда CLI знает, где он и что вокруг: корень репозитория, .env, пути,
 * состояние последнего вызова.
 *
 * Чтение .env — построчная копия read_env() из scripts/lib.sh, включая то,
 * ради чего она там появилась: обрезаются только края, кавычки снимаются
 * парой, внутренность значения не трогается вовсе («RTX 4090» остаётся с
 * пробелом). Разъехаться этим двум чтениям нельзя.
 *
 * Секретов CLI не читает. Для JUPYTER_TOKEN, SESSION_SECRET и прочего из
 * SECRET_KEYS есть только has(): есть строка или нет. read() на таком ключе
 * бросает, и это стережёт тест — чтобы значение не утекло ни в argv, ни в
 * строку --dry-run, ни в вывод status.
 */

import * as fs from 'node:fs'

/**
 * Имя среды: дословно то же сито, что в scripts/vast.sh, scripts/backup.sh и
 * scripts/restore.sh — буквы, цифры и дефис в середине. Правило одно на всех:
 * имя среды это и метка на vast, и подкаталог backups/, и поддомен.
 */
export function envNameOk(name: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(name) && !name.startsWith('-') && !name.endsWith('-')
}

/** Ключи, значения которых CLI не берёт в руки никогда. */
export const SECRET_KEYS = [
  'JUPYTER_TOKEN',
  'SESSION_SECRET',
  'RELAY_TOKEN',
  'CF_TOKEN',
  'VAST_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
] as const

export type SecretKey = (typeof SECRET_KEYS)[number]

/** Единственная дверь к файловой системе для команд. Пути — абсолютные. */
export type Io = {
  exists(path: string): boolean
  /** Содержимое файла или null, если его нет. */
  readText(path: string): string | null
  /** Время правки в миллисекундах или null. */
  mtime(path: string): number | null
  /** Имена в каталоге, отсортированные; нет каталога — пустой список. */
  list(path: string): string[]
  /** Сейчас, в миллисекундах. В тестах — постоянное число. */
  now(): number
  /** Запись. Нужна ровно одному месту — .colloq/state.json. */
  writeText(path: string, text: string): void
}

/** Последний вызов: чем занимались, где и чем кончилось. Ничего секретного. */
export type State = {
  /** Имя семинара или машины. */
  name?: string
  /** Карта арендованной машины. */
  gpu?: string
  /** Путь, который передавали аргументом (release.json, архив, база). */
  path?: string
  /** Жива ли среда: false — машину уничтожили, помним только имя. */
  alive?: boolean
  /**
   * Что звали в прошлый раз. Отдельным полем, а не рядом с name: каркас пишет
   * его после КАЖДОЙ команды, и `colloq ps` затирал бы память об аренде.
   */
  last?: {
    /** Последняя выполненная команда. */
    command?: string
    /** Её код выхода. */
    code?: number
    /** Когда это было, в миллисекундах. */
    at?: number
  }
}

export type Relay = { domain: string; addr: string; port: number }

export type EnvPaths = {
  /** Корень репозитория. */
  root: string
  envFile: string
  makefile: string
  /** Локальный запуск через make run. */
  pidFile: string
  logFile: string
  /** Списки пакетов: одно окружение — один файл. */
  envDir: string
  backupsDir: string
  /** Собранная панель. */
  dist: string
  serviceUnit: string
  /** Состояние k3s на выделенной машине. */
  clusterState: string
  stateFile: string
}

export type Env = {
  /** Корень репозитория: вверх по каталогам до Makefile рядом с package.json. */
  root(): string
  /** Путь внутри репозитория. */
  path(...parts: string[]): string
  /** Путь из аргумента человека: считается от каталога, откуда он позвал (COLLOQ_CWD). */
  userPath(path: string): string
  /** Строка из .env. На ключе из SECRET_KEYS бросает. */
  read(key: string): string
  /** Есть ли непустая строка с этим ключом. Единственное, что можно спросить о секрете. */
  has(key: string): boolean
  /** PORT, умолчание 3000. */
  port(): number
  /** KERNEL_ENV, умолчание base. */
  kernelEnv(): string
  /** PUBLIC_URL или пустая строка. */
  publicUrl(): string
  /** RELAY_DOMAIN / RELAY_ADDR / RELAY_PORT (7000). */
  relay(): Relay
  /** Домашний каталог человека или пустая строка: там лежат ключи ssh и cloudflared. */
  home(): string
  paths: EnvPaths
  io: Io
  /** .colloq/state.json целиком; нет файла или он битый — пустое состояние. */
  readState(): State
  /** Дописать поля в .colloq/state.json. */
  writeState(patch: Partial<State>): State
}

export type EnvOptions = {
  io?: Io
  /** Корень; по умолчанию ищется вверх от этого файла. */
  root?: string
  /** Каталог, откуда позвали (шим кладёт его в COLLOQ_CWD). */
  cwd?: string
  /** Переменные окружения процесса — для COLLOQ_STATE_DIR. */
  processEnv?: NodeJS.ProcessEnv
}

const SEP = '/'

/** Соединить части пути без node:path: в этом модуле он не нужен. */
export function joinPath(...parts: string[]): string {
  const segments: string[] = []
  let absolute = false
  for (const part of parts) {
    if (part === '') continue
    if (part.startsWith(SEP)) {
      segments.length = 0
      absolute = true
    }
    for (const piece of part.split(SEP)) {
      if (piece === '' || piece === '.') continue
      if (piece === '..') {
        segments.pop()
        continue
      }
      segments.push(piece)
    }
  }
  return (absolute ? SEP : '') + segments.join(SEP)
}

/**
 * Значение ключа так, как его читает scripts/lib.sh: последняя совпавшая
 * строка, срез \r, обрезка пробелов только по краям, парные кавычки снимаются.
 */
export function parseEnvValue(text: string, key: string): string {
  let found = ''
  for (const raw of text.split('\n')) {
    if (!raw.startsWith(key + '=')) continue
    found = raw.slice(key.length + 1)
  }
  let value = found
  if (value.endsWith('\r')) value = value.slice(0, -1)
  value = value.replace(/^[\s]+/, '').replace(/[\s]+$/, '')
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1)
    }
  }
  return value
}

/** Настоящая файловая система. */
export function createIo(): Io {
  // node:fs живёт здесь и только здесь: командам он запрещён, у них ctx.io.
  return {
    exists: (path) => fs.existsSync(path),
    readText: (path) => {
      try {
        return fs.readFileSync(path, 'utf8') as string
      } catch {
        return null
      }
    },
    mtime: (path) => {
      try {
        return fs.statSync(path).mtimeMs as number
      } catch {
        return null
      }
    },
    list: (path) => {
      try {
        return (fs.readdirSync(path) as string[]).slice().sort()
      } catch {
        return []
      }
    },
    now: () => Date.now(),
    writeText: (path, text) => {
      const dir = path.slice(0, path.lastIndexOf(SEP))
      if (dir) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path, text)
    },
  }
}

/** Карта файлов в памяти — для тестов. Ключи и здесь абсолютные пути. */
export function createMemoryIo(files: Record<string, string> = {}, now = 0): Io {
  const map = new Map<string, string>(Object.entries(files))
  return {
    exists: (path) => map.has(path) || [...map.keys()].some((key) => key.startsWith(path + SEP)),
    readText: (path) => map.get(path) ?? null,
    mtime: (path) => (map.has(path) ? now : null),
    list: (path) => {
      const prefix = path.endsWith(SEP) ? path : path + SEP
      const names = new Set<string>()
      for (const key of map.keys()) {
        if (!key.startsWith(prefix)) continue
        names.add(key.slice(prefix.length).split(SEP)[0] ?? '')
      }
      return [...names].filter(Boolean).sort()
    },
    now: () => now,
    writeText: (path, text) => void map.set(path, text),
  }
}

export function createEnv(opts: EnvOptions = {}): Env {
  const processEnv = opts.processEnv ?? process.env
  const io = opts.io ?? createIo()
  const root = opts.root ?? findRoot(io)
  const cwd = opts.cwd ?? processEnv.COLLOQ_CWD ?? root

  const path = (...parts: string[]): string => joinPath(root, ...parts)
  const paths: EnvPaths = {
    root,
    envFile: path('.env'),
    makefile: path('Makefile'),
    pidFile: path('.colloq.pid'),
    logFile: path('.colloq.log'),
    envDir: path('kernel/environments'),
    backupsDir: path('backups'),
    dist: path('web/dist'),
    serviceUnit: '/etc/systemd/system/colloq.service',
    clusterState: processEnv.COLLOQ_STATE_DIR ?? '/var/lib/colloq',
    stateFile: path('.colloq/state.json'),
  }

  const readRaw = (key: string): string => {
    const text = io.readText(paths.envFile)
    if (text === null) return ''
    return parseEnvValue(text, key)
  }

  const env: Env = {
    root: () => root,
    path,
    userPath: (value) => (value.startsWith(SEP) ? value : joinPath(cwd, value)),
    read(key) {
      if ((SECRET_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          'значение ' + key + ' не читается: секреты живут в .env, у CLI есть только has()',
        )
      }
      return readRaw(key)
    },
    has: (key) => readRaw(key) !== '',
    port() {
      const value = Number.parseInt(readRaw('PORT'), 10)
      return Number.isFinite(value) && value > 0 ? value : 3000
    },
    kernelEnv: () => readRaw('KERNEL_ENV') || 'base',
    home: () => processEnv.HOME ?? processEnv.USERPROFILE ?? '',
    publicUrl: () => readRaw('PUBLIC_URL'),
    relay() {
      const port = Number.parseInt(readRaw('RELAY_PORT'), 10)
      return {
        domain: readRaw('RELAY_DOMAIN'),
        addr: readRaw('RELAY_ADDR'),
        port: Number.isFinite(port) && port > 0 ? port : 7000,
      }
    },
    paths,
    io,
    readState() {
      const text = io.readText(paths.stateFile)
      if (text === null) return {}
      try {
        const parsed = JSON.parse(text) as unknown
        return parsed && typeof parsed === 'object' ? (parsed as State) : {}
      } catch {
        return {}
      }
    },
    writeState(patch) {
      const next: State = { ...env.readState(), ...patch }
      try {
        io.writeText(paths.stateFile, JSON.stringify(next, null, 2) + '\n')
      } catch {
        // Состояние — удобство, а не условие работы: не записалось — и ладно.
      }
      return next
    },
  }
  return env
}

/** Вверх по каталогам до Makefile рядом с package.json, где name — colloq. */
export function findRoot(io: Io, start?: string): string {
  const here = start ?? moduleDir()
  let dir = here
  for (let i = 0; i < 12; i++) {
    const pkg = io.readText(joinPath(dir, 'package.json'))
    if (pkg !== null && io.exists(joinPath(dir, 'Makefile')) && /"name"\s*:\s*"colloq"/.test(pkg)) {
      return dir
    }
    const up = dir.slice(0, dir.lastIndexOf(SEP))
    if (!up || up === dir) break
    dir = up
  }
  return here
}

/** Каталог этого файла. */
function moduleDir(): string {
  const url = import.meta.url
  const file = url.startsWith('file://') ? decodeURIComponent(url.slice(7)) : url
  return file.slice(0, file.lastIndexOf(SEP))
}
