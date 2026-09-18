import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isDistribution } from './launch-state.js'

export interface LaunchOptions {
  /**
   * cloudflared — не занятие, а служебное слово для scripts/host.sh: найти
   * или скачать cloudflared и напечатать путь (launch-cloudflared.ts). Скрипт
   * зовёт его, когда в PATH cloudflared нет, — так `colloq host` и `make host`
   * тоже обходятся без ручной установки, а правило поиска остаётся одно.
   */
  action: 'run' | 'dev' | 'stop' | 'restart' | 'cloudflared'
  detach: boolean
  open: boolean
  fast: boolean
  build: boolean
  host?: string
  /** Быстрый туннель Cloudflare с одной ссылкой для класса (launch-share.ts). */
  share?: boolean
  port?: number
  child?: boolean
}

export function parseLaunchArgs(args: string[]): LaunchOptions {
  const options: LaunchOptions = {
    action: 'run',
    detach: false,
    open: true,
    fast: false,
    build: false,
  }
  let at = 0
  if (['run', 'dev', 'stop', 'restart', 'cloudflared'].includes(args[0]))
    options.action = args[at++] as LaunchOptions['action']
  for (; at < args.length; at++) {
    const flag = args[at]
    if (flag === '--detach') options.detach = true
    else if (flag === '--no-open') options.open = false
    else if (flag === '--fast') options.fast = true
    else if (flag === '--build') options.build = true
    else if (flag === '--child') options.child = true
    else if (flag === '--share') options.share = true
    else if (flag === '--port') {
      const value = args[++at]
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error('The port must be a whole number from 1 to 65535.')
      options.port = Number(value)
    } else if (flag === '--host') {
      const host = args[++at]
      if (!host || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
        throw new Error('Give a name after --host, for example class.example.ru.')
      options.host = host
    } else throw new Error(`Unknown launch argument: ${flag}`)
  }
  if (options.action === 'dev' && options.detach)
    throw new Error('dev runs in the terminal; use run --detach for the background.')
  // Два способа выйти наружу сразу — это два туннеля на одну расписку адреса,
  // и второй получил бы отказ «адрес уже занят» посреди запуска. Отказ здесь
  // дешевле: ничего ещё не поднято.
  if (options.share && options.host)
    throw new Error(
      '--share and --host do not work together: --share is a quick Cloudflare link, --host is your own name.',
    )
  return options
}

export interface LaunchConfig {
  /** Каталог приложения: server/dist, web/dist, kernel/, node_modules. */
  root: string
  /** Каталог состояния: .env, .colloq/, data/, workspace/. В репозитории равен root. */
  home: string
  /** Приложение установлено готовым: сборки нет, make и npm звать нечем. */
  dist: boolean
  port: number
  uiPort: number
  url: string
  dataDir: string
  workspaceDir: string
  leaseFile: string
  env: Record<string, string>
  kernelEnv: string
}

/**
 * Настройки одного запуска. root — где приложение, home — где состояние
 * (launch-state.ts · два корня). Четвёртым параметром, а не полем объекта:
 * в репозитории и в тестах корень один, и вызов остаётся прежним.
 */
export function launchConfig(
  root: string,
  options: LaunchOptions,
  source: NodeJS.ProcessEnv,
  home: string = root,
): LaunchConfig {
  const dev = options.action === 'dev'
  const configuredPort = Number(source.PORT || 3000)
  const port = dev ? configuredPort : (options.port ?? configuredPort)
  const uiPort = dev ? (options.port ?? 5173) : port
  for (const value of [port, uiPort])
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error('Invalid PORT in the launch settings.')
  if (dev && port === uiPort)
    throw new Error('The dev frontend port must differ from the server PORT in .env.')
  // Данные, файлы и расписка аренды адреса — состояние занятия, значит home.
  // В репозитории home и есть репозиторий, и все три пути остаются прежними.
  const dataDir = path.resolve(home, source.DATA_DIR || 'data')
  const workspaceDir = path.resolve(home, source.WORKSPACE_DIR || 'workspace')
  const leaseFile = path.join(home, '.colloq/public-url.json')
  const url = `http://localhost:${uiPort}`
  const kernelEnv = source.KERNEL_ENV || 'base'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(kernelEnv))
    throw new Error('Invalid environment name in KERNEL_ENV.')
  /*
   * Отказ на broker остаётся, и он про чужую установку, а не про первый запуск.
   *
   * Раньше он срабатывал именно на первом: .env делался копией .env.example, а
   * там KERNEL_BACKEND=broker (это шаблон для прода), — и colloq отказывал на
   * файле, который сам же минуту назад и выписал. Чинится это не ослаблением
   * проверки, а тем, что colloq больше не копирует чужой шаблон: он пишет свой
   * .env локального занятия, где стоит docker (см. localClassEnv ниже).
   *
   * Смотрим на действующее окружение (файл плюс переменные оболочки) — то же,
   * что увидит сервер. Если на машине настоящая установка с брокером, run
   * по-прежнему отказывает: занятие на ноутбуке и прод — разные вещи.
   *
   * Та же ошибка жила и в Makefile: цель `.env` копировала шаблон, и после
   * `make up` отказывал `make dev`. Цель теперь пишет этот же файл
   * (scripts/local-env.sh), но клоны, где копия уже лежит, остались — с 09.09
   * broker стоит в шаблоне. Для них отказ говорит, какую строку поменять:
   * прежнее «это установка с брокером, идите в cluster» разработчику с
   * ноутбуком было неправдой и тупиком. COLLOQ_CLUSTER=1 такой подсказки не
   * получает — его пишет только развёртывание (scripts/vast.sh), случайной
   * копией он не бывает.
   */
  if (source.COLLOQ_CLUSTER === '1')
    throw new Error(
      'This is a runtime broker installation: use the service or cluster commands for it. run is meant for local Docker.',
    )
  if (source.KERNEL_BACKEND === 'broker')
    throw new Error(
      'KERNEL_BACKEND=broker is the production setting from .env.example, and a local class runs its kernels in Docker. ' +
        `Set KERNEL_BACKEND=docker in ${path.join(home, '.env')} (or move that file aside: colloq then writes one for this machine). ` +
        'A real runtime broker installation is run with the service or cluster commands.',
    )
  const env = Object.fromEntries(
    Object.entries(source).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  )
  Object.assign(env, {
    NODE_ENV: 'development',
    KERNEL_BACKEND: 'docker',
    PORT: String(port),
    BIND_ADDR: '127.0.0.1',
    DATA_DIR: dataDir,
    WORKSPACE_DIR: workspaceDir,
    WORKSPACE_HOST_DIR: '',
    COLLOQ_LOCAL_SESSION: '1',
    COLLOQ_LOCAL_URL: url,
    COLLOQ_PUBLIC_URL_LEASE_FILE: leaseFile,
    COLLOQ_STOP_KERNELS_ON_EXIT: dev ? '0' : '1',
    // Каталог состояния — серверу его надо СКАЗАТЬ. Сам он считает только
    // корень приложения (шагами вверх до kernel/environments), и потому окно
    // «Окружения» не видело ни одного окружения, заведённого `colloq env new`,
    // а заведённое из панели клало в site-packages. По этой строке панель
    // находит свои окружения и .env; без неё каталог у неё один, как раньше.
    COLLOQ_HOME: home,
    // Собранный интерфейс — часть приложения, поэтому root, а не home.
    STATIC_DIR: path.join(root, 'web/dist'),
    VITE_API_TARGET: `http://127.0.0.1:${port}`,
  })
  return {
    root,
    home,
    dist: isDistribution(root),
    port,
    uiPort,
    url,
    dataDir,
    workspaceDir,
    leaseFile,
    env,
    kernelEnv,
  }
}

/**
 * .env локального занятия — тот, который colloq выписывает сам.
 *
 * Копия .env.example здесь была ошибкой в самом корне: это шаблон установки,
 * первая же его строка говорит про прод и релиз, и настройки в нём стоят
 * прод-овые (KERNEL_BACKEND=broker). Получалось, что первый `colloq run` на
 * чистой машине писал файл, на котором сам же и отказывал.
 *
 * Правило теперь простое: файл, который colloq пишет за человека, обязан
 * годиться для того, что colloq собирается делать. Ровно так защищён и
 * Makefile — в рецепте run он выставляет `KERNEL_BACKEND=docker` в окружении
 * (Makefile · run), не полагаясь на строку в файле. Разница в том, что
 * переменная в рецепте невидима: человек открывает .env, читает broker и не
 * понимает, почему занятие идёт в Docker. Здесь то же самое сказано вслух, в
 * файле, который он и будет править.
 *
 * Здесь только то, что человек действительно может захотеть поменять перед
 * парой. Всё остальное — умолчания кода; полный список настроек остаётся в
 * .env.example, и он назван первой же строкой.
 *
 * Язык зависит от того, как программу поставили, и это не каприз. Репозиторий —
 * рабочее дерево авторов и машины, где занятия ведут по-русски: там ru, как
 * было. Пакет pip ставят где угодно, и умолчанием у него английский. Строка
 * при этом остаётся в файле на виду: человек её и правит, одним словом, без
 * поиска по документации.
 */
export function localClassEnv(dist: boolean): string {
  return `# Settings for this machine. colloq wrote this file on its first start:
# edit it and restart with colloq restart. The full list of everything that
# can be configured is in .env.example next to the application.

# The address of the class on this machine. From outside it is visible
# only through colloq host.
PORT=3000
BIND_ADDR=127.0.0.1
UI_LANGUAGE=${dist ? 'en' : 'ru'}

# The kernels of a class are Docker containers on this computer, one per room.
# Each room container is hardened: no privileges, a process limit, the internet
# yes, your local network and this computer no. COLLOQ_ROOM_NETWORK=open lifts
# the network block for a machine you fully trust.
KERNEL_BACKEND=docker
KERNEL_ENV=base
# Memory and processors of one room. 4g is enough for an ordinary class; for a
# class that trains networks set 8g-16g, if the machine has that much.
KERNEL_MEM=4g
KERNEL_CPUS=2
KERNEL_SHM=1g

# Signs the sign-in links of teachers and students. Left empty, the key is
# created in data/ on its own and survives a restart; a value written here
# wins over it.
SESSION_SECRET=
# Not a shared Jupyter: every room has a token of its own. This line is here
# so the log does not keep the token from .env.example, which everyone knows.
JUPYTER_TOKEN=${randomBytes(24).toString('hex')}

# File uploads and the disk space one class may take.
MAX_UPLOAD_MB=50
MAX_SESSION_MB=1024

# The Oracle. Without a key the class still runs, but the model cannot be asked.
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
`
}

function filesBelow(root: string, relative: string): string[] {
  const full = path.join(root, relative)
  if (!fs.existsSync(full)) return []
  const stat = fs.lstatSync(full)
  if (stat.isSymbolicLink()) return []
  if (!stat.isDirectory()) return [relative]
  return fs
    .readdirSync(full)
    .sort()
    .flatMap((name) => {
      if (
        ['node_modules', 'dist', '.git', '.vite'].includes(name) ||
        name.endsWith('.built') ||
        path.join(relative, name) === 'web/public/pdf'
      )
        return []
      return filesBelow(root, path.join(relative, name))
    })
}

export function fingerprint(
  root: string,
  inputs = [
    'web',
    'server',
    'runtime',
    'shared',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ],
): string {
  const hash = createHash('sha256')
  for (const file of inputs.flatMap((input) => filesBelow(root, input)).sort()) {
    hash
      .update(file)
      .update('\0')
      .update(fs.readFileSync(path.join(root, file)))
      .update('\0')
  }
  return hash.digest('hex')
}

export interface BuildStamp {
  fingerprint: string
  fast: boolean
}
export function buildIsCurrent(root: string, stamp: BuildStamp | null, fast: boolean): boolean {
  return Boolean(
    stamp &&
      stamp.fingerprint === fingerprint(root) &&
      (fast || !stamp.fast) &&
      fs.existsSync(path.join(root, 'web/dist/index.html')) &&
      fs.existsSync(path.join(root, 'server/dist/server.js')),
  )
}

export function kernelInputs(root: string, name: string): string[] {
  const files = ['kernel/Dockerfile', 'kernel/requirements.txt']
  const seen = new Set<string>()
  let current: string | undefined = name
  while (current) {
    if (seen.has(current) || seen.size >= 8)
      throw new Error('A cycle or too long a chain of Python environments.')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(current))
      throw new Error('Invalid parent environment name.')
    seen.add(current)
    const file: string = `kernel/environments/${current}.txt`
    if (!fs.existsSync(path.join(root, file))) throw new Error(`No environment ${current}: ${file}`)
    files.push(file)
    current = fs
      .readFileSync(path.join(root, file), 'utf8')
      .match(/^\s*#\s*colloq:\s*from\s+(\S+)/m)?.[1]
  }
  return files
}
