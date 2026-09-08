import { usingRuntimeBroker, loadRuntimeCatalog, runtimeDefaultEnvironment, setRuntimeDefaultEnvironment, runtimeEnvironment, imageRevision } from './kernel/runtime-client.js'
/** Production environments are immutable entries in the operator's release
 * catalog. The selected default is persisted separately and only affects new
 * rooms. File editing and Docker builds below serve local development only. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdminEnvironment, EnvironmentAbilities, EnvironmentState } from '@shared/admin'
import { ENVIRONMENT_NAME } from '@shared/admin'

const here = path.dirname(fileURLToPath(import.meta.url))
/**
 * The repository, found by walking up until the kernel directory appears.
 *
 * Not a constant number of `..`: this file is imported from `server/src` in
 * development and from `server/dist` in a container, and those are different
 * depths. Looking for the thing we actually need is stable under both.
 */
function findRepoRoot(): string {
  let dir = here
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'kernel', 'environments'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return path.resolve(here, '../..')
}

const ROOT = findRepoRoot()
/**
 * Контекст сборки: Dockerfile, requirements.txt и списки окружений.
 *
 * Каталог, а не файл: `docker build` читает его КЛИЕНТОМ и отдаёт демону, так
 * что для сборки достаточно этой папки — демон может быть и на хосте.
 */
const KERNEL_DIR = path.join(ROOT, 'kernel')
export const ENV_DIR = path.join(KERNEL_DIR, 'environments')
const ENV_FILE = path.join(ROOT, '.env')
/** Репозиторий целиком: compose и .env рядом с ним — файлы хоста, не образа. */
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.yml')

/* ------------------------------------------------------------- the files */

function fileFor(name: string): string {
  // Belt and braces. `name` is validated at the route, and it also decides a
  // path — so it is checked again at the moment it becomes one.
  if (!ENVIRONMENT_NAME.test(name)) throw new Error(`bad environment name: ${name}`)
  return path.join(ENV_DIR, `${name}.txt`)
}

/**
 * What the package list looked like when the image was last built.
 *
 * Staleness used to be decided by comparing the file's mtime to the image's
 * creation time, and that answers a different question: whether the file was
 * WRITTEN since, not whether it says anything new. Opening the list and saving
 * it unchanged — or the file simply being created later than an image built by
 * `docker compose` — was enough to put "Needs rebuild" on a perfectly current
 * environment, which is exactly how `base` ended up reading "216 MB · built 5
 * days ago" beside a pill saying it was never built.
 *
 * The stamp holds the built list itself, so the comparison is about content.
 * No stamp (an image from before this file existed) falls back to the mtime,
 * which is the old behaviour and the safer guess: better to offer a rebuild
 * nobody needs than to hide one somebody does.
 */
function stampFor(name: string): string {
  if (!ENVIRONMENT_NAME.test(name)) throw new Error(`bad environment name: ${name}`)
  return path.join(ENV_DIR, `.${name}.built`)
}

/**
 * Did the package list actually change since it was built?
 *
 * Compares what the lists SAY, not how they are written: a comment added, a
 * blank line, trailing whitespace, the same packages in another order — none of
 * those change what pip installs, and none of them should put "Needs rebuild"
 * on a working environment. Exported because this rule is the whole difference
 * between an honest badge and a nagging one, and it is worth pinning.
 */
export function listChanged(stamped: string, current: string): boolean {
  const meaningful = (source: string) =>
    source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .sort()
      .join('\n')
  return meaningful(stamped) !== meaningful(current)
}

export function listNames(): string[] {
  if (usingRuntimeBroker()) return loadRuntimeCatalog().environments.filter(e=>e.current).map(e=>e.name).sort()
  try {
    return fs
      .readdirSync(ENV_DIR)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.slice(0, -4))
      .filter((n) => ENVIRONMENT_NAME.test(n))
      .sort()
  } catch {
    return []
  }
}

export function readSource(name: string): string {
  if (usingRuntimeBroker()) return (runtimeEnvironment(name).packages ?? []).join("\n")
  try {
    return fs.readFileSync(fileFor(name), 'utf8')
  } catch {
    return ''
  }
}

/**
 * The packages a file asks for, as a person would count them.
 *
 * Comments and blank lines are not packages, and neither is a pip directive
 * like `--extra-index-url` — counting those told the room "6 packages" for a
 * file listing five.
 */
export function parsePackages(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('-'))
}

/**
 * Нужен ли этому окружению срез GPU — по директиве `# colloq: gpu` в шапке.
 *
 * Признак живёт в самом списке пакетов, а не рядом с комнатой, потому что это
 * свойство окружения: колёса torch собраны под CUDA, и «то же самое, только на
 * процессоре» здесь не существует. Комната на таком окружении либо получает
 * срез на всё время жизни своего контейнера, либо честно не едет.
 *
 * Для pip это комментарий, поэтому директива ничего не ставит, не меняет
 * `listChanged` и не зажигает «Needs rebuild» на собранном образе.
 *
 * Ищется среди всех комментариев, а не только до первой строки с пакетом:
 * директива, дописанная человеком в конец файла, должна сработать, а не
 * промолчать. Строка сравнивается целиком — фраза «# colloq: gpu не нужен»
 * директивой не считается.
 */
export function declaresGpu(source: string): boolean {
  return source.split('\n').some((line) => /^#\s*colloq:\s*gpu$/i.test(line.trim()))
}

/**
 * Поверх чего строится это окружение — по директиве `# colloq: from <имя>` в
 * шапке, в том же виде, что и `# colloq: gpu`.
 *
 * Слой окружения один, и любая правка списка ставит его целиком заново. Для
 * окружения с torch это три гигабайта колёс и девять минут за добавленный timm.
 * Директива переносит тяжёлое в общий слой: родитель собирается один раз, а
 * дети — за секунды.
 *
 * Имя проверяется тем же выражением, что и всюду: оно становится и путём к
 * файлу, и тегом образа. Не имя — не директива; а несуществующее окружение
 * назвать родителем можно, и тогда откажет сборка, назвав его вслух.
 */
export function declaresParent(source: string): string | null {
  for (const line of source.split('\n')) {
    const found = /^#\s*colloq:\s*from\s+(\S+)\s*$/i.exec(line.trim())
    if (found) return found[1] ?? null
  }
  return null
}

/** Чем читается список: имя → текст, или null, когда такого окружения нет. */
export type ReadEnvironment = (name: string) => string | null

/**
 * Отличает «пусто» от «нет такого»: readSource возвращает '' на оба, а сборке
 * надо отказать на неизвестном родителе, а не молча собрать поверх базы.
 */
const fromDisk: ReadEnvironment = (name) => {
  try {
    return fs.readFileSync(fileFor(name), 'utf8')
  } catch {
    return null
  }
}

/** Длиннее этого цепочка не бывает: дальше это опечатка, а не устройство. */
export const MAX_INHERITANCE = 8

/**
 * Порядок сборки: от корня к листу, `['base-gpu', 'gpu']`.
 *
 * Три отказа вместо бесконечной сборки, и все три — до docker: петля (a → b →
 * a), цепочка длиннее MAX_INHERITANCE и родитель, которого нет. Девять минут,
 * потраченных на то, чтобы упасть на `COPY environments/нет-такого.txt`, — это
 * та же ошибка, только дороже.
 */
export function buildChain(name: string, read: ReadEnvironment = fromDisk): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let current: string | null = name
  while (current !== null) {
    if (seen.has(current)) {
      throw new Error(
        `окружения ссылаются друг на друга по кругу: ${[...chain, current].join(' → ')}`,
      )
    }
    if (!ENVIRONMENT_NAME.test(current)) {
      throw new Error(`«${current}» не может быть именем окружения — ни файлом, ни тегом образа`)
    }
    const source = read(current)
    if (source === null) {
      throw new Error(
        chain.length === 0
          ? `нет окружения «${current}»`
          : `окружение «${chain[0]}» строится поверх «${current}», а такого нет`,
      )
    }
    if (chain.length >= MAX_INHERITANCE) {
      throw new Error(`цепочка окружений длиннее ${MAX_INHERITANCE} звеньев: ${chain.join(' → ')}`)
    }
    seen.add(current)
    chain.unshift(current)
    current = declaresParent(source)
  }
  return chain
}

/**
 * Просит ли окружение срез видеокарты — своей директивой или родительской.
 *
 * Признак наследуется, потому что наследуется его причина: образ поверх base-gpu
 * несёт колёса под CUDA, и без устройства комната на нём упадёт на первом
 * `.cuda()`. Сломанная цепочка здесь не исключение: об этом скажет сборка, а
 * отнимать срез у окружения, которое его просит, — худший из двух ответов.
 */
export function needsGpu(name: string, read: ReadEnvironment = fromDisk): boolean {
  if (usingRuntimeBroker()) return runtimeEnvironment(name).gpu
  let chain: string[]
  try {
    chain = buildChain(name, read)
  } catch {
    chain = [name]
  }
  return chain.some((step) => declaresGpu(read(step) ?? ''))
}

export function writeSource(name: string, source: string): void {
  if (usingRuntimeBroker()) throw new Error('Published environments are managed by the release catalog. Build and import images outside the web application.')
  fs.mkdirSync(ENV_DIR, { recursive: true })
  const text = source.endsWith('\n') ? source : `${source}\n`
  // Temp-file then rename: a half-written requirements file is a build that
  // fails in a way nobody can explain.
  const tmp = `${fileFor(name)}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, fileFor(name))
}

export function removeEnvironment(name: string): void {
  if (usingRuntimeBroker()) throw new Error('Published environments are managed by the release catalog. Build and import images outside the web application.')
  fs.rmSync(fileFor(name), { force: true })
  // Штамп уходит вместе со списком: иначе среда, заведённая под тем же именем
  // заново, сравнивалась бы с чужой сборкой.
  fs.rmSync(stampFor(name), { force: true })
}

export function exists(name: string): boolean {
  if (usingRuntimeBroker()) return loadRuntimeCatalog().environments.some(e=>e.current && e.name===name)
  return fs.existsSync(fileFor(name))
}

/* ------------------------------------------------- which one is running */

/**
 * Какое окружение считается умолчанием: строка `.env`, а если её нет — то, что
 * compose передал процессу переменной окружения.
 *
 * Второе — про контейнер. В образе app файла `.env` нет и быть не должно (это
 * файл хоста), поэтому без запасного пути под `make up` панель всегда отвечала
 * «base», а новый семинар записывался на base при собранном ядре `cv`: имя
 * окружения у семинара — это то, из какого образа поднимется его контейнер,
 * когда сервер увидит docker.
 */
export function pickActiveName(envFile: string | null, fromEnv: string | undefined): string {
  const line = envFile
    ?.split('\n')
    .reverse()
    .find((l) => l.startsWith('KERNEL_ENV='))
  const value = line?.slice('KERNEL_ENV='.length).trim()
  if (value && ENVIRONMENT_NAME.test(value)) return value
  const forwarded = fromEnv?.trim()
  return forwarded && ENVIRONMENT_NAME.test(forwarded) ? forwarded : 'base'
}

/**
 * `KERNEL_ENV` in `.env` — the same line `make env-use` writes.
 *
 * Read from disk on every call rather than cached: the make targets edit this
 * file too, and a panel that believed a value from process start would show the
 * wrong environment as active for as long as the server ran.
 */
export function activeName(): string {
  if (usingRuntimeBroker()) return runtimeDefaultEnvironment()
  let text: string | null = null
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8')
  } catch {
    text = null
  }
  return pickActiveName(text, process.env.KERNEL_ENV)
}

export function setActiveName(name: string): void {
  if (usingRuntimeBroker()) { setRuntimeDefaultEnvironment(name); return }
  if (!ENVIRONMENT_NAME.test(name)) throw new Error(`bad environment name: ${name}`)
  let lines: string[] = []
  try {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n')
  } catch {
    /* no .env yet: the file is about to have exactly one line */
  }
  const kept = lines.filter((l) => !l.startsWith('KERNEL_ENV='))
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  kept.push(`KERNEL_ENV=${name}`, '')
  const tmp = `${ENV_FILE}.tmp`
  fs.writeFileSync(tmp, kept.join('\n'), 'utf8')
  fs.renameSync(tmp, ENV_FILE)
}

/* ------------------------------------------------------------- docker */

interface RunResult {
  code: number
  out: string
}

function run(
  command: string,
  args: string[],
  timeoutMs = 15_000,
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...extraEnv } })
    let out = ''
    const done = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err) => {
      clearTimeout(done)
      resolve({ code: -1, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(done)
      resolve({ code: code ?? -1, out })
    })
  })
}

/**
 * Что этот сервер умеет делать с окружениями — по отдельности.
 *
 * Раньше это был один вопрос на двоих («лежит ли рядом docker-compose.yml»), и
 * под `make up` он гасил обе кнопки разом: на арендованной машине окружение
 * нельзя было собрать вовсе, только по ssh. Но нужно им РАЗНОЕ.
 *
 * Сборке хватает клиента docker и каталога kernel: контекст читает клиент и
 * отдаёт демону, поэтому то, что демон на хосте, роли не играет, а compose для
 * `docker build` не нужен вовсе.
 *
 * Умолчание — это строка `KERNEL_ENV` в .env рядом с docker-compose.yml, то
 * есть файл ХОСТА. Записать его внутрь контейнера значит соврать человеку:
 * правка доживёт до первой пересборки, пока compose всё это время читает файл
 * на хосте. Поэтому «Make default» остаётся командой на хосте, и панель
 * говорит об этом ровно про ту кнопку, которой это касается.
 */
export function abilities(found: {
  docker: boolean
  /** kernel/Dockerfile: контекст сборки виден отсюда. */
  context: boolean
  /** docker-compose.yml: репозиторий целиком, а с ним и .env. */
  repository: boolean
}): EnvironmentAbilities {
  if (!found.docker) {
    const reason =
      'Docker is not reachable from the server. Running in a container? It needs /var/run/docker.sock ' +
      'and DOCKER_GID, the group that owns it — `make up` sets both. ' +
      'Environments still list and edit here; switching is `make env-use NAME=<name>`.'
    return {
      canBuild: false,
      cannotBuildReason: reason,
      canSetDefault: false,
      cannotSetDefaultReason: reason,
    }
  }
  return {
    canBuild: found.context,
    cannotBuildReason: found.context
      ? null
      : 'The kernel directory is not in this container, and a build needs it as its context: ' +
        'kernel/Dockerfile and the package lists beside it. docker-compose.yml mounts ./kernel — ' +
        'update it and restart, or build on the host with `make env-build NAME=<name>`.',
    canSetDefault: found.repository,
    cannotSetDefaultReason: found.repository
      ? null
      : 'Making an environment the default writes KERNEL_ENV to the .env beside docker-compose.yml, ' +
        'and that file is the host’s: run `make env-use NAME=<name>` there.' +
        (found.context ? ' Building an image needs neither, and works from here.' : ''),
  }
}

/** То же самое, но спросив docker и посмотрев, что вообще лежит рядом. */
export async function environmentAbilities(): Promise<EnvironmentAbilities> {
  if (usingRuntimeBroker()) {
    loadRuntimeCatalog()
    return {canBuild:false,cannotBuildReason:'Images are published outside the web application. Build an environment image and import its digest through the release tooling.',canSetDefault:true,cannotSetDefaultReason:null}
  }
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}'], 8000)
  return abilities({
    docker: version.code === 0,
    context: fs.existsSync(path.join(KERNEL_DIR, 'Dockerfile')),
    repository: fs.existsSync(COMPOSE_FILE),
  })
}

interface ImageFacts {
  bytes: number
  builtAt: number
}

/** Size and build time of `colloq-kernel:<name>`, or null when never built. */
async function imageFacts(name: string): Promise<ImageFacts | null> {
  const res = await run(
    'docker',
    ['image', 'inspect', `colloq-kernel:${name}`, '--format', '{{.Size}} {{.Created}}'],
    8000,
  )
  if (res.code !== 0) return null
  const [size, created] = res.out.trim().split(' ')
  const bytes = Number(size)
  const builtAt = Date.parse(created ?? '')
  if (!Number.isFinite(bytes) || !Number.isFinite(builtAt)) return null
  return { bytes, builtAt }
}

/* --------------------------------------------------------- build state */

/**
 * Builds happen in the background and their log is watched from the panel, so
 * the last one has to outlive the request that started it.
 */
interface Build {
  name: string
  lines: string[]
  done: boolean
  failed: boolean
  startedAt: number
  listeners: Set<(line: string) => void>
  child: ReturnType<typeof spawn> | null
}

const builds = new Map<string, Build>()
/** A finished failure, kept so the panel can show it after the log scrolls. */
const failures = new Map<string, string>()

export function buildOf(name: string): Build | undefined {
  return builds.get(name)
}

export function isBuilding(name: string): boolean {
  return builds.get(name)?.done === false
}

/** The log so far, so a panel opened mid-build is not left staring at nothing. */
export function buildLog(name: string): { lines: string[]; done: boolean; failed: boolean } | null {
  const build = builds.get(name)
  if (!build) return null
  return { lines: [...build.lines], done: build.done, failed: build.failed }
}

export function watchBuild(name: string, onLine: (line: string) => void): () => void {
  const build = builds.get(name)
  if (!build) return () => {}
  build.listeners.add(onLine)
  return () => build.listeners.delete(onLine)
}

/** How many log lines a build keeps. Enough to see what broke, bounded. */
const LOG_LINES = 400

function push(build: Build, chunk: string): void {
  for (const line of chunk.split('\n')) {
    const text = line.replace(/\r/g, '').trimEnd()
    if (!text) continue
    build.lines.push(text)
    if (build.lines.length > LOG_LINES) build.lines.shift()
    for (const listener of build.listeners) listener(text)
  }
}

/**
 * Чем собирать: прямым `docker build` или через compose поверх репозитория.
 *
 * Compose нужен ровно там, где он есть, — на машине с репозиторием: он
 * подхватывает dev-override, без которого пересобранное общее ядро теряет
 * проброшенный 8888. В контейнере app его нет и не будет (это файл хоста), а
 * каталог kernel есть, и его достаточно.
 */
export type BuildPlan = { via: 'direct' } | { via: 'compose'; files: string[] }

/**
 * Команда одного звена цепочки. Оба пути дают один и тот же образ
 * `colloq-kernel:<имя>` из одного и того же Dockerfile — расходятся они только
 * в том, кто подставляет аргументы: compose из своего файла или мы сами.
 *
 * Родитель — аргумент PARENT: тем же Dockerfile собирается и база (поверх
 * python-slim), и тонкий слой поверх готового colloq-образа. Когда родителя
 * нет, аргумент не передаётся вовсе — действует умолчание самого Dockerfile, и
 * имя базового образа остаётся в одном месте, а не в двух расходящихся.
 */
export function buildCommand(
  plan: BuildPlan,
  step: string,
  parentImage: string | null,
  kernel: string = KERNEL_DIR,
): { args: string[]; env: Record<string, string> } {
  // Журнал читают построчно в панели, а «красивый» прогресс BuildKit
  // перерисовывает себя каретками и в текстовом окне превращается в кашу.
  const env: Record<string, string> = { DOCKER_BUILDKIT: '1', BUILDKIT_PROGRESS: 'plain' }
  if (plan.via === 'compose') {
    env.KERNEL_ENV = step
    if (parentImage) env.KERNEL_PARENT = parentImage
    return { args: ['compose', ...plan.files, 'build', 'kernel'], env }
  }
  return {
    args: [
      'build',
      '-f',
      path.join(kernel, 'Dockerfile'),
      '--build-arg',
      `KERNEL_ENV=${step}`,
      ...(parentImage ? ['--build-arg', `PARENT=${parentImage}`] : []),
      '-t',
      `colloq-kernel:${step}`,
      kernel,
    ],
    env,
  }
}

/**
 * Одно звено цепочки: одна сборка одного окружения.
 *
 * Возвращает, продолжать ли: упавшее звено делает следующие бессмысленными.
 */
function runStage(
  build: Build,
  plan: BuildPlan,
  step: string,
  parentImage: string | null,
): Promise<boolean> {
  return new Promise((resolve) => {
    const { args, env: vars } = buildCommand(plan, step, parentImage)
    /*
     * Список читается ДО спавна — это и уедет в штамп.
     *
     * Штамп заведён затем, чтобы «Needs rebuild» говорило о содержимом, а не о
     * времени правки файла. Читая список на `close`, он говорил о содержимом
     * НЕ ТОГО момента: сборка с torch идёт минуты, преподаватель за это время
     * дописывает в тот же список `timm` и сохраняет, штамп получает новый
     * список, `editedSinceBuild` сравнивает его с файлом — совпадает, — и
     * строка показывает «Ready» над образом без timm. Обнаруживается это на
     * `import timm` посреди пары: ровно та ложь, от которой штамп и заведён.
     *
     * Здесь возможна ошибка в одну сторону — сказать «пересобрать» там, где
     * docker успел прочитать уже новый файл. Лишняя пересборка стоит минут,
     * ложное «Ready» — пары.
     */
    const built = readSource(step)
    const child = spawn('docker', args, {
      cwd: ROOT,
      env: { ...process.env, ...vars },
    })
    build.child = child
    // Строка журнала — то, что человек может повторить руками: переменные,
    // которые сборка правда читает, и сама команда целиком.
    const shown = Object.entries(vars)
      .filter(([name]) => name.startsWith('KERNEL_'))
      .map(([name, value]) => `${name}=${value} `)
      .join('')
    push(build, `$ ${shown}docker ${args.join(' ')}`)

    child.stdout.on('data', (d: Buffer) => push(build, d.toString()))
    child.stderr.on('data', (d: Buffer) => push(build, d.toString()))
    // Отменённой сборке ошибку не переписываем: «cancelled» — это ответ, а
    // «build exited null» на его месте — загадка.
    child.on('error', (err) => {
      push(build, String(err))
      if (!build.done) {
        build.failed = true
        failures.set(build.name, String(err))
      }
      resolve(false)
    })
    child.on('close', (code) => {
      if (code === 0) {
        // Remember WHAT was built, so the next comparison is about content.
        try {
          fs.writeFileSync(stampFor(step), built)
        } catch {
          // No stamp is not a failure: staleness falls back to mtime, as before.
        }
        resolve(true)
        return
      }
      if (!build.done) {
        build.failed = true
        // The last non-empty line is what a person reads first; keeping the whole
        // log for the panel and one line for the row is the difference between
        // "it failed" and "tensorflow==1.15 does not exist".
        failures.set(
          build.name,
          build.lines.filter((l) => /error|ERROR/.test(l)).pop() ?? `build exited ${code}`,
        )
      }
      push(build, `— build failed (${code})`)
      resolve(false)
    })
  })
}

/**
 * Build an environment's image, in the background — вместе с цепочкой, на
 * которой оно стоит.
 *
 * Родитель собирается первым и только если его образа ещё нет: ради этого
 * наследование и заведено — правка листа не должна ставить torch заново. Пока
 * идёт цепочка, «Building» стоит на каждом звене, которое она СОБИРАЕТ: журнал
 * у них общий, и второй Build на родителя посреди этой сборки не начнётся.
 * Звенья, чьи образы уже есть, отпускаются, как только это выяснится, — их
 * кнопка не должна быть заперта чужой сборкой.
 *
 * Uses the dev override when the kernel is currently published on the host —
 * the same reasoning as the Makefile: rebuilding without it silently drops the
 * port the host server reaches the kernel through, and the room loses Python
 * while every container still reports healthy.
 */
export async function startBuild(name: string): Promise<void> {
  if (usingRuntimeBroker()) throw new Error('Published environments are built outside the web application and imported through the release catalog')
  if (isBuilding(name)) return
  failures.delete(name)

  /*
   * Слот занимается синхронно, до первого await, и это существенно.
   *
   * Между проверкой `isBuilding` и `builds.set` стоял `docker compose ps` —
   * сотни миллисекунд, за которые второй Build на то же имя (вторая вкладка,
   * планшет рядом с ноутбуком) проходил проверку и запускал вторую сборку.
   * Первая при этом вытеснялась из карты: её лог и Cancel становились
   * недоступны, а закончившись, она молча дописывала штамп.
   */
  const build: Build = {
    name,
    lines: [],
    done: false,
    failed: false,
    startedAt: Date.now(),
    listeners: new Set(),
    child: null,
  }
  builds.set(name, build)

  let chain: string[]
  try {
    chain = buildChain(name)
  } catch (err) {
    // Петля, слишком длинная цепочка, несуществующий родитель — отказ до
    // docker. Собирать девять минут, чтобы упасть на COPY, — та же ошибка,
    // только дороже.
    const message = err instanceof Error ? err.message : String(err)
    push(build, message)
    build.failed = true
    build.done = true
    failures.set(name, message)
    return
  }

  /*
   * Занимается ВСЯ цепочка, и тоже до первого await.
   *
   * Слот на имя закрывал только половину двери: родители регистрировались
   * строкой ниже, после `docker compose ps` и опроса образов — сотни
   * миллисекунд, за которые Build на родителя из второго окна проходил
   * `isBuilding`, запускал свой `docker build` с тем же `-t`, а затем
   * вытеснялся записью ребёнка: лог и Cancel родителя пропадали, а конец
   * цепочки удалял запись, пока его собственная сборка ещё шла. Обещание из
   * шапки — «второй Build на родителя не начнётся» — держится здесь.
   */
  const busy = chain.find((step) => step !== name && isBuilding(step))
  if (busy) {
    // Не «упало», а «занято»: собирается тот самый слой, поверх которого мы бы
    // встали, и ждать его — единственное разумное.
    const message = `окружение «${busy}» из этой цепочки уже собирается — дождитесь конца`
    push(build, message)
    build.failed = true
    build.done = true
    failures.set(name, message)
    return
  }
  const held = chain.filter((step) => step !== name)
  for (const step of held) builds.set(step, build)
  /** Отпустить звенья — но только те, что и правда держим мы. */
  const release = (steps: readonly string[]): void => {
    for (const step of steps) if (builds.get(step) === build) builds.delete(step)
  }

  /*
   * Через compose — только там, где он лежит.
   *
   * В контейнере app примонтирован каталог kernel, а docker-compose.yml и .env
   * остались на хосте: `docker compose build` там падал бы «no configuration
   * file provided», и панель поэтому гасила Build вовсе. Прямая сборка этого не
   * требует — контекст читает клиент, — а путь через compose остаётся на машине
   * с репозиторием ради dev-override: без него пересобранное общее ядро
   * возвращается без проброшенного 8888, и комната теряет Python при всех
   * здоровых контейнерах.
   */
  const plan: BuildPlan = fs.existsSync(COMPOSE_FILE)
    ? {
        via: 'compose',
        files: (await usesDevOverride())
          ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml']
          : [],
      }
    : { via: 'direct' }
  // Cancel мог прийти, пока мы спрашивали docker: тогда начинать нечего.
  if (build.done) {
    release(held)
    return
  }

  /*
   * Начинаем с того места, где кончились готовые образы.
   *
   * Родитель нужен ровно затем, чтобы поверх него встал следующий слой: есть
   * его образ — прабабку трогать незачем. А устаревший родитель (список
   * правился) — отдельная кнопка в его собственной строке: пересобирать три
   * гигабайта за человека, который нажал Build на ребёнке, мы не вправе.
   */
  let from = 0
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    const step = chain[i]
    if (step !== undefined && (await imageFacts(step)) !== null) {
      from = i + 1
      break
    }
  }
  const stages = chain.slice(from)
  if (build.done) {
    release(held)
    return
  }
  // Пропущенные звенья отпускаем: их образы уже есть, собирать их никто не
  // собирается, и «Building» в их строке было бы враньём с запертой кнопкой.
  release(chain.slice(0, from))

  for (const step of stages) {
    if (build.done) break
    const before = chain[chain.indexOf(step) - 1]
    if (!(await runStage(build, plan, step, before ? `colloq-kernel:${before}` : null))) break
  }

  build.done = true
  if (!build.failed) push(build, '— build finished')
  // Дальше каждое звено отвечает за себя: чужой журнал в своей строке — это
  // «build failed» на образе, который собрался.
  release(held)
}

export function cancelBuild(name: string): boolean {
  const build = builds.get(name)
  if (!build || build.done) return false
  build.child?.kill('SIGTERM')
  push(build, '— cancelled')
  build.done = true
  build.failed = true
  failures.set(name, 'cancelled')
  return true
}

/** True when the kernel container publishes 8888 — i.e. the dev arrangement. */
async function usesDevOverride(): Promise<boolean> {
  const res = await run('docker', ['compose', 'ps', 'kernel', '--format', '{{.Publishers}}'], 8000)
  return res.code === 0 && res.out.includes('8888')
}

/**
 * Переключения идут по одному.
 *
 * `docker compose up -d kernel` — операция над одной службой одного проекта, и
 * два таких вызова внахлёст спорят за один контейнер: второй падает на
 * конфликте имени, а панель показывает «The kernel did not come back» там, где
 * ядро прекрасно вернулось — просто не для этого запроса. Очередь общая, а не
 * по имени окружения: служба одна, и два РАЗНЫХ имени ссорятся за неё ровно
 * так же.
 */
let switching: Promise<void> = Promise.resolve()

/**
 * Point the instance's kernel at an environment.
 *
 * Writes `KERNEL_ENV` first and restarts second, in that order: the file is
 * what every later `make up` and every panel read will believe, and a restart
 * that succeeded against a file that did not get written is a lie that outlives
 * the process.
 *
 * `restartShared` — правда ли комнаты сидят на ядре compose. Когда у каждой
 * свой контейнер, пересоздавать эту службу незачем: ни одна комната в неё не
 * ходит, а перезапуск на минуту занимает машину и выглядит в панели так, будто
 * что-то произошло с семинарами. Тогда «Make default» — это ровно запись
 * умолчания для новых семинаров, и больше ничего.
 */
export function activate(
  name: string,
  restartShared = true,
): Promise<{ ok: boolean; out: string }> {
  const done = switching.then(() => switchTo(name, restartShared))
  // Очередь не рвётся от неудачного переключения: следующему всё равно надо
  // дать ход, иначе панель залипает до перезапуска сервера.
  switching = done.then(
    () => undefined,
    () => undefined,
  )
  return done
}

async function switchTo(
  name: string,
  restartShared: boolean,
): Promise<{ ok: boolean; out: string }> {
  setActiveName(name)
  if (usingRuntimeBroker() || !restartShared) return { ok: true, out: '' }
  const files = (await usesDevOverride())
    ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml']
    : []
  /*
   * KERNEL_ENV is passed explicitly, and that is the whole fix.
   *
   * compose resolves `image: colloq-kernel:${KERNEL_ENV:-base}` from the
   * environment before it looks at the .env file, and this process was started
   * by `make run`, which had already exported the OLD value. So writing the
   * file and calling compose brought the container back up on the previous
   * image while the panel reported the new one — "nlp is active", and
   * `import transformers` still failing in every room.
   */
  const res = await run(
    'docker',
    ['compose', ...files, 'up', '-d', 'kernel'],
    120_000,
    { KERNEL_ENV: name },
  )
  return { ok: res.code === 0, out: res.out }
}

/* ------------------------------------------------------------- assembly */

function stateOf(
  name: string,
  built: ImageFacts | null,
  parentBuilt: ImageFacts | null,
): EnvironmentState {
  if (isBuilding(name)) return 'building'
  /*
   * A built image outranks a remembered failure.
   *
   * `failures` lives in memory and is only ever cleared by starting another
   * build, so one bad rebuild hid a perfectly good image: the environment
   * vanished from the seminar form and lost its "Make default" until somebody
   * restarted the process. The error is still reported beside the row; it just
   * no longer pretends there is nothing there.
   */
  if (!built) return failures.has(name) ? 'failed' : 'unbuilt'
  /*
   * Edited since the last build is not ready — that is what `unbuilt` says in
   * the contract, and it was never returned. Saving a package list and seeing
   * "Ready · built 3 days ago" is how a room ends up on the old image with
   * nothing on screen disagreeing.
   */
  if (editedSinceBuild(name, built)) return 'unbuilt'
  /*
   * Родителя пересобрали позже — значит, этот образ стоит на прежнем слое.
   *
   * Список ребёнка не менялся, и по нему всё готово; но torch в нём тот, что
   * был до пересборки base-gpu, а панель говорила бы «Ready». Тот же
   * «Needs rebuild», что и на правку списка: образ есть, комнаты на нём идут,
   * пересобрать стоит секунды.
   */
  if (parentBuilt && parentBuilt.builtAt > built.builtAt) return 'unbuilt'
  return 'ready'
}

/** Whether the package list was written after the image was built. */
function editedSinceBuild(name: string, built: ImageFacts): boolean {
  let stamped: string | null = null
  try {
    stamped = fs.readFileSync(stampFor(name), 'utf8')
  } catch {
    stamped = null
  }
  if (stamped !== null) return listChanged(stamped, readSource(name))
  try {
    return fs.statSync(fileFor(name)).mtimeMs > built.builtAt
  } catch {
    // No file to compare against; the image is all there is.
    return false
  }
}

export async function listEnvironments(): Promise<AdminEnvironment[]> {
  if (usingRuntimeBroker()) {
    const active = activeName()
    return loadRuntimeCatalog().environments.filter(e=>e.current).map(e=>({
      name:e.name,state:'ready',packages:e.packages??[],imageBytes:null,builtAt:null,
      active:e.name===active,error:null,parent:null,gpu:e.gpu,
      managed:true,image:e.image,revision:imageRevision(e.image),
    }))
  }
  const active = activeName()
  const names = listNames()
  // Образы всех окружений разом: строке нужен не только свой, но и родительский
  // — иначе «пересобрали родителя» видно только по датам, глазами.
  const facts = new Map<string, ImageFacts | null>(
    await Promise.all(names.map(async (name) => [name, await imageFacts(name)] as const)),
  )
  return names.map((name) => {
    const built = facts.get(name) ?? null
    const source = readSource(name)
    const parent = declaresParent(source)
    return {
      name,
      state: stateOf(name, built, parent === null ? null : (facts.get(parent) ?? null)),
      packages: parsePackages(source),
      imageBytes: built?.bytes ?? null,
      builtAt: built?.builtAt ?? null,
      active: name === active,
      error: failures.get(name) ?? null,
      parent,
      // Директива из шапки файла, а не отдельный реестр: панель показывает то
      // же самое, по чему потом решает подъём ядра, — включая унаследованное от
      // родителя.
      gpu: needsGpu(name),
    }
  })
}
