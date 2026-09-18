/**
 * Откуда CLI знает, где он и что вокруг: каталог приложения, каталог
 * состояния, .env, пути.
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

/*
 * Два корня — приложение и состояние — разрешаются в одном месте на весь CLI:
 * launch-state.ts (там же и объяснение, почему именно там). Здесь они только
 * перепечатываются наружу, чтобы команды звали их отсюда, вместе с остальными
 * путями, и второго ответа на вопрос «где мои данные» не завелось.
 */
import { appDir, homeDir, isDistribution, SESSION_FILE } from './launch-state.js'
export { appDir, homeDir, isDistribution }

/**
 * Имя среды: дословно то же сито, что в scripts/backup.sh и scripts/restore.sh
 * — буквы, цифры и дефис в середине. Имя среды — это подкаталог backups/.
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
  /**
   * Запись. mode ставится только при создании файла — так же, как у fs: у
   * существующего права не трогаются, и .env, положенный человеком, остаётся
   * его. Нужен он одному случаю — .env, в котором лежат ключи входа.
   */
  writeText(path: string, text: string, mode?: number): void
}

export type Relay = { domain: string; addr: string; port: number }

export type EnvPaths = {
  /**
   * Каталог приложения: web/dist, server/dist, kernel/, scripts/, node_modules.
   *
   * Не «корень репозитория», как было сказано здесь до разделения корней: у
   * установленного colloq репозитория нет вовсе, а этот каталог есть — он
   * внутри пакета. Состояние занятия сюда не кладут НИКОГДА (см. home ниже):
   * его перезапишет следующий `pip install -U`, а на многих машинах в него и
   * не пишется.
   */
  root: string
  /**
   * Каталог состояния: .env, .colloq/, .colloq.pid, .colloq.log, data/.
   * В репозитории он же и есть корень; у установленного colloq — свой
   * (homeDir). Пути ниже, которые относятся к состоянию, считаются от него.
   */
  home: string
  envFile: string
  /**
   * Кто сейчас ведёт занятие: pid супервизора, а НЕ сервера.
   *
   * Сервер — его ребёнок, и его номер лежит в расписке полем serverPid. Кто
   * ищет по этому файлу слушателя порта, найдёт не того и назовёт своё же
   * занятие чужим.
   */
  pidFile: string
  logFile: string
  /**
   * Расписка идущего занятия: порт, адрес, pid супервизора и сервера.
   *
   * Единственный источник правды о том, что работает ПРЯМО СЕЙЧАС. .env
   * отвечает на другой вопрос — что настроено, — и `colloq run --port 4100`
   * его не трогает вовсе.
   */
  sessionFile: string
  /** Списки пакетов, приехавшие с продуктом: одно окружение — один файл. */
  envDir: string
  /**
   * Списки пакетов, которые завёл человек: сюда и только сюда пишет
   * `colloq env new`. Почему каталог второй — объяснено у его вычисления ниже.
   */
  ownEnvDir: string
  backupsDir: string
  /** Собранная панель. */
  dist: string
}

export type Env = {
  /** Каталог приложения; см. EnvPaths.root. */
  root(): string
  /**
   * Путь внутри каталога ПРИЛОЖЕНИЯ.
   *
   * Только для файлов, которые приехали вместе с программой: cli/launch.mjs,
   * kernel/Dockerfile, web/dist. Всё, что заводится на машине — .env, журнал,
   * расписка, данные, свои окружения, — берётся из paths.*, и там оно уже
   * посчитано от каталога состояния.
   */
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
}

export type EnvOptions = {
  io?: Io
  /** Корень; по умолчанию ищется вверх от этого файла. */
  root?: string
  /** Каталог состояния; по умолчанию — корень, как было всегда. */
  home?: string
  /** Каталог, откуда позвали (шим кладёт его в COLLOQ_CWD). */
  cwd?: string
  /** Переменные окружения процесса — для COLLOQ_CWD. */
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
    writeText: (path, text, mode) => {
      const dir = path.slice(0, path.lastIndexOf(SEP))
      if (dir) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path, text, mode === undefined ? undefined : { mode })
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
  /*
   * Умолчания корней — те же два ответа, что у запуска (launch-state.ts), и
   * это важнее, чем кажется: иначе `colloq run` писал бы журнал в одно место,
   * а `colloq logs` читал его в другом.
   *
   * home берёт корень, когда его назвали явно: так живут тесты и всё, что
   * прикалывает CLI к своему дереву, — для них ничего не меняется.
   */
  const root = opts.root ?? appDir()
  const home = opts.home ?? opts.root ?? homeDir()
  const cwd = opts.cwd ?? processEnv.COLLOQ_CWD ?? root

  const path = (...parts: string[]): string => joinPath(root, ...parts)
  const statePath = (...parts: string[]): string => joinPath(home, ...parts)
  const paths: EnvPaths = {
    root,
    home,
    envFile: statePath('.env'),
    pidFile: statePath('.colloq.pid'),
    logFile: statePath('.colloq.log'),
    envDir: path('kernel/environments'),
    /*
     * Второй каталог окружений — и он заводится ровно там, где первый писать
     * нельзя.
     *
     * Окружения, приехавшие с продуктом (base, base-gpu, cv, gpu), лежат в
     * <app>/kernel/environments. У установленного colloq это site-packages:
     * каталог целиком перезаписывается следующим `pip install -U`, а на многих
     * машинах не пишется вовсе. Завести там своё окружение значит либо
     * получить отказ прав, либо потерять файл на первом же обновлении.
     *
     * Поэтому своё живёт в каталоге состояния, рядом с .env и data/, — там,
     * где его никто не перезапишет: <home>/environments.
     *
     * В репозитории (и в любом рабочем дереве, где home и есть корень
     * приложения) второй каталог — это ПЕРВЫЙ, тот же самый путь. Так и
     * задумано: там kernel/environments и пишется, и читается, и попадает в
     * контекст `docker build`, и её же видят Makefile, launch-config.ts ·
     * kernelInputs и панель преподавателя. Новый каталог рядом увёл бы файл
     * из-под всех троих, и `colloq env new` в клоне заводил бы окружение,
     * которого не видит сборка.
     */
    ownEnvDir: home === root ? path('kernel/environments') : joinPath(home, 'environments'),
    sessionFile: statePath(SESSION_FILE),
    backupsDir: statePath('backups'),
    dist: path('web/dist'),
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
          'the value of ' + key + ' is not readable: secrets live in .env, the CLI only has has()',
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
  }
  return env
}
