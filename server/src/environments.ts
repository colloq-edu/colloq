/**
 * Environments: the packages a seminar's Python has.
 *
 * One environment is one file, `kernel/environments/<name>.txt`, installed on
 * top of `kernel/requirements.txt` — which every kernel has and which is why an
 * environment costs only the packages the base does not already carry. Building
 * one produces the image `colloq-kernel:<name>`; every built environment keeps
 * its own tag, so going back to one is a container restart rather than another
 * pip install.
 *
 * The panel and the `make env-*` targets are two faces of this, not two
 * implementations: both read the same directory and both write the same
 * `KERNEL_ENV` line in `.env`. Edit a file by hand and the panel shows it.
 *
 * Which environment a seminar gets is decided when the seminar is created and
 * then fixed (`sessions.environment`); the room starts its own container from
 * that image. So the active environment here is the DEFAULT — what the next
 * seminar will be created with — and not something switching takes away from
 * rooms that already exist. The one arrangement where it is instance-wide is
 * the old one: `KERNEL_ISOLATION=off`, or a server that cannot start a
 * container for a room at all (no Docker socket, no permission on it, no room
 * network). Then every room shares the compose kernel and restarting it does
 * empty everybody's variables — which is exactly what `shared` tells the panel.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdminEnvironment, EnvironmentState } from '@shared/admin'
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
export const ENV_DIR = path.join(ROOT, 'kernel', 'environments')
const ENV_FILE = path.join(ROOT, '.env')

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

export function needsGpu(name: string): boolean {
  return declaresGpu(readSource(name))
}

export function writeSource(name: string, source: string): void {
  fs.mkdirSync(ENV_DIR, { recursive: true })
  const text = source.endsWith('\n') ? source : `${source}\n`
  // Temp-file then rename: a half-written requirements file is a build that
  // fails in a way nobody can explain.
  const tmp = `${fileFor(name)}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, fileFor(name))
}

export function removeEnvironment(name: string): void {
  fs.rmSync(fileFor(name), { force: true })
  // Штамп уходит вместе со списком: иначе среда, заведённая под тем же именем
  // заново, сравнивалась бы с чужой сборкой.
  fs.rmSync(stampFor(name), { force: true })
}

export function exists(name: string): boolean {
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
  let text: string | null = null
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8')
  } catch {
    text = null
  }
  return pickActiveName(text, process.env.KERNEL_ENV)
}

export function setActiveName(name: string): void {
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
 * Whether this install can build at all.
 *
 * The server builds by shelling out to Docker. On the host that just works; in
 * a container it needs `/var/run/docker.sock` — `docker-compose.yml` mounts it,
 * but reading it also takes the group that owns it (`DOCKER_GID`, which
 * `make up` works out). Rather than offer buttons that fail, the panel asks
 * first and says what is missing.
 */
export async function dockerAvailable(): Promise<{ ok: boolean; reason: string | null }> {
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}'], 8000)
  if (version.code !== 0) {
    return {
      ok: false,
      reason:
        'Docker is not reachable from the server. Running in a container? It needs /var/run/docker.sock ' +
        'and DOCKER_GID, the group that owns it — `make up` sets both. ' +
        'Environments still list and edit here; switching is `make env-use NAME=<name>`.',
    }
  }
  /*
   * Собирать и переключать — это `docker compose` над ЭТИМ репозиторием, а не
   * просто «виден ли docker».
   *
   * В образе app лежат dist, статика и списки пакетов — ни docker-compose.yml,
   * ни kernel/Dockerfile, ни .env хоста. Клиент docker там теперь есть, он
   * нужен для контейнера комнаты, и без этой проверки панель предлагала бы
   * Build, падающий «no configuration file provided», и «Make default»,
   * который записал бы умолчание в .env ВНУТРИ контейнера — то есть до первой
   * же пересборки, пока compose всё это время читает файл на хосте.
   */
  if (!fs.existsSync(path.join(ROOT, 'docker-compose.yml'))) {
    return {
      ok: false,
      reason:
        'The server runs in a container and the repository is not in it: building an environment, ' +
        'and making one the default, need docker-compose.yml and the .env next to it. ' +
        'Environments still list and edit here; both are `make env-build` / `make env-use NAME=<name>` on the host.',
    }
  }
  return { ok: true, reason: null }
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
 * Build an environment's image, in the background.
 *
 * Uses the dev override when the kernel is currently published on the host —
 * the same reasoning as the Makefile: rebuilding without it silently drops the
 * port the host server reaches the kernel through, and the room loses Python
 * while every container still reports healthy.
 */
export async function startBuild(name: string): Promise<void> {
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

  const files = (await usesDevOverride())
    ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml']
    : []
  // Cancel мог прийти, пока мы спрашивали docker: тогда начинать нечего.
  if (build.done) return

  const child = spawn('docker', ['compose', ...files, 'build', 'kernel'], {
    cwd: ROOT,
    env: { ...process.env, KERNEL_ENV: name, DOCKER_BUILDKIT: '1', BUILDKIT_PROGRESS: 'plain' },
  })
  build.child = child
  push(build, `$ KERNEL_ENV=${name} docker compose build kernel`)

  child.stdout.on('data', (d: Buffer) => push(build, d.toString()))
  child.stderr.on('data', (d: Buffer) => push(build, d.toString()))
  child.on('error', (err) => {
    push(build, String(err))
    build.failed = true
    build.done = true
    failures.set(name, String(err))
  })
  child.on('close', (code) => {
    build.done = true
    build.failed = code !== 0
    if (build.failed) {
      // The last non-empty line is what a person reads first; keeping the whole
      // log for the panel and one line for the row is the difference between
      // "it failed" and "tensorflow==1.15 does not exist".
      failures.set(name, build.lines.filter((l) => /error|ERROR/.test(l)).pop() ?? `build exited ${code}`)
    }
    if (!build.failed) {
      // Remember WHAT was built, so the next comparison is about content.
      try {
        fs.writeFileSync(stampFor(name), readSource(name))
      } catch {
        // No stamp is not a failure: staleness falls back to mtime, as before.
      }
    }
    push(build, build.failed ? `— build failed (${code})` : '— build finished')
  })
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
  if (!restartShared) return { ok: true, out: '' }
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

function stateOf(name: string, built: ImageFacts | null): EnvironmentState {
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
  return editedSinceBuild(name, built) ? 'unbuilt' : 'ready'
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
  const active = activeName()
  const names = listNames()
  return Promise.all(
    names.map(async (name) => {
      const built = await imageFacts(name)
      const source = readSource(name)
      return {
        name,
        state: stateOf(name, built),
        packages: parsePackages(source),
        imageBytes: built?.bytes ?? null,
        builtAt: built?.builtAt ?? null,
        active: name === active,
        error: failures.get(name) ?? null,
        // Директива из шапки файла, а не отдельный реестр: панель показывает то
        // же самое, по чему потом решает подъём ядра.
        gpu: declaresGpu(source),
      }
    }),
  )
}
