import { tr } from '@shared/i18n'
import {
  usingRuntimeBroker,
  loadRuntimeCatalog,
  runtimeDefaultEnvironment,
  setRuntimeDefaultEnvironment,
  runtimeEnvironment,
  imageRevision,
} from './kernel/runtime-client.js'
/** Production environments are immutable entries in the operator's release
 * catalog. The selected default is persisted separately and only affects new
 * rooms. File editing and Docker builds below serve local development only. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdminEnvironment, EnvironmentAbilities, EnvironmentState } from '@shared/admin'
import {
  DEFAULT_PYTHON,
  ENVIRONMENT_NAME,
  declaresParent,
  declaresPython,
  pythonImage,
} from '@shared/admin'
/*
 * Директивы шапки разбираются в одном месте на всех — в shared/admin.ts.
 *
 * Форма создания окружения читает `# colloq: from` и `# colloq: python` тем же
 * разбором, что и сборка: второй список регулярных выражений разъехался бы с
 * первым на первой же правке, и панель показывала бы не ту версию, на которой
 * образ соберётся. Переэкспорт — чтобы соседи по файлу (declaresGpu, buildChain)
 * читались как одна семья, какой они и являются.
 */
export { declaresParent, declaresPython }

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
/** Репозиторий целиком: compose и .env рядом с ним — файлы хоста, не образа. */
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.yml')

/* --------------------------------------------- два каталога окружений */

/**
 * Каталог состояния этой машины: .env, data/, workspace/ и свои окружения.
 *
 * Сам сервер его не вычисляет и вычислить не может: корень ПРИЛОЖЕНИЯ он
 * находит шагами вверх до kernel/environments (findRepoRoot выше), а состояние
 * у установленного через pip colloq лежит совсем в другом месте — ~/.colloq или
 * COLLOQ_HOME. Поэтому каталог ему СООБЩАЮТ переменной, ровно как DATA_DIR и
 * WORKSPACE_DIR (cli/src/launch-config.ts · launchConfig).
 *
 * Переменной нет — значит, сервер подняли не супервизором: репозиторий, `make
 * up`, служба. Тогда каталог окружений один, как было всегда, и ни одна строка
 * ниже своего поведения не меняет.
 *
 * Читается на каждом обращении, а не однажды при импорте: .env доезжает до
 * process.env из config.ts (`dotenv/config`), и порядок вычисления модулей не
 * должен решать, увидим мы переменную или нет. Цена вопроса — один path.join.
 */
function stateHome(): string | null {
  const named = process.env.COLLOQ_HOME?.trim()
  return named ? path.resolve(named) : null
}

/**
 * Куда панель ПИШЕТ окружения. Та же развилка, что у CLI (cli/src/env.ts ·
 * ownEnvDir), и списана она оттуда дословно: разъехаться этим двоим нельзя —
 * иначе `colloq env new` заводит окружение, которого не видит панель, а панель
 * заводит такое, которого не видит `colloq env list`. Ровно это и было.
 *
 * У установленного colloq <app>/kernel/environments — это site-packages:
 * каталог целиком перезаписывается следующим `pip install -U`, а на многих
 * машинах в него и не пишется вовсе. Поэтому своё живёт в каталоге состояния,
 * рядом с .env и data/, — там, где его никто не перезапишет.
 *
 * Когда состояние И ЕСТЬ каталог приложения (репозиторий, клон, контейнер под
 * `make up`), второй каталог — это ПЕРВЫЙ, тот же самый путь: новый каталог
 * рядом увёл бы файл из-под make env-list, из-под `colloq env new` и из-под
 * контекста `docker build`.
 */
export function ownEnvDirOf(root: string, home: string | null): string {
  const shipped = path.join(root, 'kernel', 'environments')
  if (home === null || home === path.resolve(root)) return shipped
  return path.join(home, 'environments')
}

function ownEnvDir(): string {
  return ownEnvDirOf(ROOT, stateHome())
}

/**
 * Оба каталога в порядке старшинства: своё перебивает привезённое.
 *
 * Перебивает, а не отказывает: человек вправе переопределить `cv` под свой
 * курс, и его список должен побеждать везде — в чтении, в списке, в цепочке
 * наследования и в контексте сборки.
 */
function envDirs(): string[] {
  const own = ownEnvDir()
  return own === ENV_DIR ? [ENV_DIR] : [own, ENV_DIR]
}

/* ------------------------------------------------------------- the files */

function checkName(name: string): void {
  // Belt and braces. `name` is validated at the route, and it also decides a
  // path — so it is checked again at the moment it becomes one.
  if (!ENVIRONMENT_NAME.test(name))
    throw new Error(tr('server.badEnvironmentName.cf94f0', { p0: name }))
}

/**
 * Где файл ЛЕЖИТ: сначала свой каталог, потом привезённый.
 *
 * Нет ни там, ни там — возвращается привезённый путь: читать по нему нечего, а
 * «нет такого окружения» отвечают вызывающие, каждый по-своему (readSource —
 * пустой строкой, fromDisk — null).
 */
function findFile(file: string): string {
  const dirs = envDirs()
  return path.join(dirs.find((dir) => fs.existsSync(path.join(dir, file))) ?? ENV_DIR, file)
}

function fileFor(name: string): string {
  checkName(name)
  return findFile(`${name}.txt`)
}

/** Куда ПИСАТЬ список: всегда своё. Каталог приложения только читается. */
function ownFileFor(name: string): string {
  checkName(name)
  return path.join(ownEnvDir(), `${name}.txt`)
}

/**
 * Приехало с продуктом и своей копии не имеет — значит, это не наш файл.
 *
 * Отдельным вопросом, потому что от него зависит отказ на удаление: `rm` по
 * site-packages либо падает правами, либо удаляет файл, который вернётся
 * следующим `pip install -U`. Кнопка, которая иногда работает, хуже честного
 * отказа. В репозитории каталог один, свой и привезённый совпадают, и ответ
 * здесь всегда «нет» — то есть поведение прежнее.
 */
export function isShipped(name: string): boolean {
  checkName(name)
  return !fs.existsSync(ownFileFor(name)) && fs.existsSync(path.join(ENV_DIR, `${name}.txt`))
}

/** `.env` со строкой KERNEL_ENV — файл СОСТОЯНИЯ, а не приложения. */
function envFile(): string {
  return path.join(stateHome() ?? ROOT, '.env')
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
 *
 * Штамп — состояние ЭТОЙ машины: он про образ, который лежит в её docker, а не
 * про продукт. Поэтому пишется он в свой каталог (ownStampFor), даже когда сам
 * список приехал с colloq: в site-packages ему либо откажут правами, либо он
 * исчезнет на первом `pip install -U` вместе со всей папкой. Читается из обоих:
 * штамп, оставленный в каталоге приложения прежней версией, — это ответ на тот
 * же вопрос, и терять его значит звать на лишнюю пересборку перед парой.
 */
function stampFor(name: string): string {
  checkName(name)
  return findFile(`.${name}.built`)
}

function ownStampFor(name: string): string {
  checkName(name)
  return path.join(ownEnvDir(), `.${name}.built`)
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

/**
 * Все окружения — объединением двух каталогов, по одному имени на строку.
 *
 * Set, а не конкатенация: своё окружение с именем привезённого — это то же
 * самое окружение, переопределённое, и в списке панели ему полагается одна
 * строка. Раньше читался только каталог приложения, и заведённое `colloq env
 * new` окружение не показывалось вовсе — при том что активным панель называла
 * именно его имя.
 */
export function listNames(): string[] {
  if (usingRuntimeBroker())
    return loadRuntimeCatalog()
      .environments.filter((e) => e.current)
      .map((e) => e.name)
      .sort()
  const names = new Set<string>()
  for (const dir of envDirs()) {
    let files: string[] = []
    try {
      files = fs.readdirSync(dir)
    } catch {
      // Своего каталога может не быть вовсе: человек ещё не заводил окружений.
      continue
    }
    for (const file of files) {
      const name = file.endsWith('.txt') ? file.slice(0, -4) : ''
      if (name && ENVIRONMENT_NAME.test(name)) names.add(name)
    }
  }
  return [...names].sort()
}

export function readSource(name: string): string {
  if (usingRuntimeBroker()) return (runtimeEnvironment(name).packages ?? []).join('\n')
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
        tr('server.environmentsReferToEachOtherInA.0d5bfa', {
          p0: [...chain, current].join(' → '),
        }),
      )
    }
    if (!ENVIRONMENT_NAME.test(current)) {
      throw new Error(tr('server.cannotBeAnEnvironmentFilenameOrImage.0ea5d5', { p0: current }))
    }
    const source = read(current)
    if (source === null) {
      throw new Error(
        chain.length === 0
          ? tr('server.environmentDoesNotExist.8a7fc4', { p0: current })
          : tr('server.environmentIsBasedOnWhichDoesNot.3611b2', { p0: chain[0], p1: current }),
      )
    }
    if (chain.length >= MAX_INHERITANCE) {
      throw new Error(
        tr('server.theEnvironmentChainExceedsLevels.8f1ecf', {
          p0: MAX_INHERITANCE,
          p1: chain.join(' → '),
        }),
      )
    }
    seen.add(current)
    chain.unshift(current)
    current = declaresParent(source)
  }
  /*
   * Версию Python выбирает КОРЕНЬ цепочки, и четвёртый отказ — про это.
   *
   * Слой поверх готового образа не меняет интерпретатор: pip в нём ставит
   * колёса под тот Python, который пришёл из базы. Файл, где написано
   * `# colloq: from base-gpu` и `# colloq: python 3.12`, обещает ровно то, чего
   * сборка сделать не может, — и молча собрался бы на версии родителя, а панель
   * показывала бы 3.12. Та же цена, что у неизвестного родителя: лучше отказать
   * здесь и назвать обе версии вслух.
   *
   * Повтор родительской версии — не конфликт: это лишняя строка, а не ложь.
   */
  const root = chain[0] as string
  const rootPython = declaresPython(read(root) ?? '') ?? DEFAULT_PYTHON
  for (const step of chain.slice(1)) {
    const own = declaresPython(read(step) ?? '')
    if (own !== null && own !== rootPython) {
      throw new Error(
        tr('server.environmentAsksForPythonButTheChain.7b21ac', {
          p0: step,
          p1: own,
          p2: root,
          p3: rootPython,
        }),
      )
    }
  }
  return chain
}

/**
 * На каком Python поедет это окружение: версия корня цепочки, иначе умолчание
 * Dockerfile.
 *
 * Не своя директива, а корневая, потому что версия приходит из базового образа:
 * `# colloq: python` у листа — это либо повтор корня, либо ложь, и второе
 * сборка отвергает (buildChain выше). Сломанная цепочка здесь не исключение:
 * об этом скажет сборка, а панели нужно что-то показать — показывается то, что
 * просит сам файл.
 */
export function pythonOf(name: string, read: ReadEnvironment = fromDisk): string {
  let root = name
  try {
    root = buildChain(name, read)[0] ?? name
  } catch {
    root = name
  }
  return declaresPython(read(root) ?? '') ?? DEFAULT_PYTHON
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

/**
 * Запись — всегда в свой каталог, никогда в каталог приложения.
 *
 * Правка привезённого окружения тоже: она ложится своей копией, и чтение её
 * перебивает (envDirs). Иначе панель писала бы в site-packages — отказ прав в
 * лучшем случае, а в худшем файл, который исчезнет на первом `pip install -U`
 * вместе со штампом сборки, и человек не поймёт, куда делся его список.
 */
export function writeSource(name: string, source: string): void {
  if (usingRuntimeBroker())
    throw new Error(tr('server.publishedEnvironmentsAreManagedByTheRelease.8ff51e'))
  const file = ownFileFor(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = source.endsWith('\n') ? source : `${source}\n`
  // Temp-file then rename: a half-written requirements file is a build that
  // fails in a way nobody can explain.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Удалить можно только своё.
 *
 * Отказ, а не тихое «ничего не произошло»: `rm` по каталогу приложения либо
 * падает правами, либо снимает файл, который вернётся следующим обновлением
 * пакета, — и в обоих случаях строка в панели пропадает не навсегда. Маршрут
 * спрашивает isShipped раньше и отвечает 409; этот отказ — для всех остальных,
 * чтобы дыру нельзя было обойти мимо маршрута.
 */
export function removeEnvironment(name: string): void {
  if (usingRuntimeBroker())
    throw new Error(tr('server.publishedEnvironmentsAreManagedByTheRelease.8ff51e'))
  if (isShipped(name)) {
    throw new Error(tr('server.shipsWithColloqAndCannotBeDeletedHere.06a8ea', { p0: name }))
  }
  fs.rmSync(ownFileFor(name), { force: true })
  // Штамп уходит вместе со списком: иначе среда, заведённая под тем же именем
  // заново, сравнивалась бы с чужой сборкой.
  fs.rmSync(ownStampFor(name), { force: true })
}

export function exists(name: string): boolean {
  if (usingRuntimeBroker())
    return loadRuntimeCatalog().environments.some((e) => e.current && e.name === name)
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
 *
 * Файл берётся из каталога СОСТОЯНИЯ (envFile выше). У установленного colloq
 * .env лежит в ~/.colloq, а не в site-packages: там его пишет `colloq env use`,
 * оттуда его читает следующий запуск, — и панель обязана смотреть в тот же
 * файл, иначе она называет активным одно, а занятие поднимается на другом.
 */
export function activeName(): string {
  if (usingRuntimeBroker()) return runtimeDefaultEnvironment()
  let text: string | null = null
  try {
    text = fs.readFileSync(envFile(), 'utf8')
  } catch {
    text = null
  }
  return pickActiveName(text, process.env.KERNEL_ENV)
}

export function setActiveName(name: string): void {
  if (usingRuntimeBroker()) {
    setRuntimeDefaultEnvironment(name)
    return
  }
  if (!ENVIRONMENT_NAME.test(name))
    throw new Error(tr('server.badEnvironmentName.cf94f0', { p0: name }))
  const file = envFile()
  let lines: string[] = []
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    /* no .env yet: the file is about to have exactly one line */
  }
  const kept = lines.filter((l) => !l.startsWith('KERNEL_ENV='))
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  kept.push(`KERNEL_ENV=${name}`, '')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, kept.join('\n'), 'utf8')
  fs.renameSync(tmp, file)
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
 *
 * У установленного colloq всё это верно наоборот, и потому появился третий
 * вопрос — `home`. Репозитория там нет и docker-compose.yml нет, а .env есть:
 * он лежит в каталоге состояния, который назвал супервизор. Тот же самый файл
 * читает и пишет `colloq env use`, и перечитает его следующий `colloq run`, —
 * никакого хоста «снаружи» здесь не существует, врать некому. Гасить
 * «Make default» в этом случае значило отнимать у преподавателя единственный
 * способ выбрать окружение из панели и посылать его в make, которого у него
 * тоже нет.
 */
export function abilities(found: {
  docker: boolean
  /** kernel/Dockerfile: контекст сборки виден отсюда. */
  context: boolean
  /** docker-compose.yml: репозиторий целиком, а с ним и .env. */
  repository: boolean
  /** Нам назвали каталог состояния: .env в нём — наш, и писать его можно. */
  home: boolean
}): EnvironmentAbilities {
  if (!found.docker) {
    const reason =
      tr('server.dockerIsNotReachableFromTheServer.ffa886') +
      tr('server.andDockerGidTheGroupThatOwns.6ee275') +
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
      : tr('server.theKernelDirectoryIsNotInThis.3ff129') +
        tr('server.kernelDockerfileAndThePackageListsBeside.7f2949') +
        tr('server.updateItAndRestartOrBuildOn.25c277'),
    canSetDefault: found.repository || found.home,
    cannotSetDefaultReason:
      found.repository || found.home
        ? null
        : tr('server.makingAnEnvironmentTheDefaultWritesKernel.40527e') +
          tr('server.andThatFileIsTheHostS.d583a8') +
          (found.context ? tr('server.buildingAnImageNeedsNeitherAndWorks.0701a2') : ''),
  }
}

/** То же самое, но спросив docker и посмотрев, что вообще лежит рядом. */
export async function environmentAbilities(): Promise<EnvironmentAbilities> {
  if (usingRuntimeBroker()) {
    loadRuntimeCatalog()
    return {
      canBuild: false,
      cannotBuildReason: tr('server.imagesArePublishedOutsideTheWebApplication.d2806b'),
      canSetDefault: true,
      cannotSetDefaultReason: null,
    }
  }
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}'], 8000)
  return abilities({
    docker: version.code === 0,
    context: fs.existsSync(path.join(KERNEL_DIR, 'Dockerfile')),
    repository: fs.existsSync(COMPOSE_FILE),
    // Переменная от супервизора, а не догадка по файлам: она и значит, что
    // .env этой установки лежит там, куда мы можем писать.
    home: stateHome() !== null,
  })
}

interface ImageFacts {
  bytes: number
  builtAt: number
  /** `3.12.7` — из самого образа; null, если он про Python молчит. */
  python: string | null
}

/**
 * Строка формата: размер, дата и переменные образа — по строке на каждую.
 *
 * Одним `docker image inspect`, а не двумя: список опрашивает КАЖДОЕ окружение
 * на каждое открытие экрана и на каждый тик опроса во время сборки, и второй
 * вызов на строку удвоил бы это в том же цикле событий, который ведёт чужую
 * пару.
 */
const IMAGE_FORMAT =
  '{{println .Size}}{{println .Created}}{{range .Config.Env}}{{println .}}{{end}}'

/**
 * Что образ рассказывает о себе сам.
 *
 * Версия Python берётся из переменной PYTHON_VERSION, которую официальный
 * `python:<версия>-slim` записывает в конфигурацию образа, — значит, спросить
 * её можно не запуская контейнер. Это ВЕРСИЯ СБОРКИ, а не то, что просит файл:
 * расходятся они ровно тогда, когда файл поправили после сборки, и показать
 * надо обе.
 */
export function parseImageFacts(out: string): ImageFacts | null {
  const [size, created, ...vars] = out.split('\n')
  const bytes = Number(size?.trim())
  const builtAt = Date.parse(created?.trim() ?? '')
  if (!Number.isFinite(bytes) || !Number.isFinite(builtAt)) return null
  const found = vars
    .map((line) => /^PYTHON_VERSION=(\d+\.\d+(?:\.\d+)?)/.exec(line.trim())?.[1])
    .find((value) => value !== undefined)
  return { bytes, builtAt, python: found ?? null }
}

/** Size, build time and Python of `colloq-kernel:<name>`; null when never built. */
async function imageFacts(name: string): Promise<ImageFacts | null> {
  const res = await run(
    'docker',
    ['image', 'inspect', `colloq-kernel:${name}`, '--format', IMAGE_FORMAT],
    8000,
  )
  if (res.code !== 0) return null
  return parseImageFacts(res.out)
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
 *
 * `kernel` — каталог контекста: обычно это kernel/ приложения, а у
 * установленного colloq — склеенная копия со своими окружениями (buildContext).
 * Путь через compose его не принимает и не должен: контекст ./kernel записан в
 * docker-compose.yml, а он лежит только там, где каталог окружений и так один.
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
 * Контекст `docker build`, когда каталогов окружений два: копия kernel/ со
 * своими списками поверх привезённых.
 *
 * Склейка, а не развилка в самой сборке, — тот же выбор и по той же причине,
 * что на стороне запуска (cli/src/launch-prepare.ts · kernelRoot): развилку
 * «этот файл оттуда, а тот отсюда» пришлось бы протащить в цепочку
 * наследования, в COPY внутри Dockerfile и в сам вызов docker, и однажды
 * забыть про одно из трёх. Здесь она ровно в одном месте: контекст собирается
 * заново перед сборкой, а дальше всё идёт как раньше, с ОДНИМ каталогом.
 *
 * А вот каталог свой, и он на имя: kernelRoot чистит своё место rmSync раз за
 * запуск, когда сервера ещё нет вовсе, а панель собирает несколько окружений
 * разом — две сборки на один каталог значат, что чистка второй выдёргивает
 * контекст из-под первой, и та падает на «no such file or directory» посреди
 * чтения. Одно имя дважды одновременно не собирается (слот в builds), так что
 * на своём каталоге чистка безопасна.
 *
 * Каталог не убирается после сборки: он маленький (весь kernel/ — десятки
 * килобайт), по нему видно, что именно уехало в docker, а следующая сборка того
 * же имени всё равно переписывает его целиком.
 *
 * Возвращается сам каталог ядра, а не корень над ним: buildCommand ждёт ту
 * папку, где лежит Dockerfile.
 */
export function buildContext(name: string): string {
  const home = stateHome()
  if (home === null || ownEnvDir() === ENV_DIR) return KERNEL_DIR
  const staged = path.join(home, '.colloq', 'kernel-context', name)
  fs.rmSync(staged, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(staged), { recursive: true })
  // preserveTimestamps: копия обязана быть неотличима от оригинала — по времени
  // правки решается свежесть образа, пока штампа сборки ещё нет.
  const keep = { recursive: true, preserveTimestamps: true } as const
  fs.cpSync(KERNEL_DIR, staged, keep)
  const into = path.join(staged, 'environments')
  fs.mkdirSync(into, { recursive: true })
  for (const file of fs.readdirSync(ownEnvDir()))
    if (file.endsWith('.txt')) fs.cpSync(path.join(ownEnvDir(), file), path.join(into, file), keep)
  return staged
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
  kernel: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const { args, env: vars } = buildCommand(plan, step, parentImage, kernel)
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
        // Штамп — про образ в docker этой машины, поэтому в свой каталог: см.
        // stampFor. Каталога может ещё не быть — своих окружений человек не
        // заводил, а собрал привезённое.
        try {
          const stamp = ownStampFor(step)
          fs.mkdirSync(path.dirname(stamp), { recursive: true })
          fs.writeFileSync(stamp, built)
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
          build.lines.filter((l) => /error|ERROR/.test(l)).pop() ??
            tr('server.buildExited.e3b35b', { p0: String(code) }),
        )
      }
      push(build, tr('server.buildFailed.3e3a83', { p0: String(code) }))
      resolve(false)
    })
  })
}

/**
 * Поверх чего встаёт КОРЕНЬ цепочки: официальный python той версии, которую
 * просит его файл.
 *
 * Передаётся всегда, а не только когда версия не умолчательная, — ровно затем,
 * чтобы строка команды в журнале называла базовый образ целиком: «на чём это
 * собрано» человек читает там, а не в Dockerfile.
 *
 * KERNEL_PARENT из окружения сервера (оболочка или строка в .env — config.ts
 * читает его dotenv) сильнее директивы: это способ собрать цепочку на своём
 * базовом образе, и молча его игнорировать значит собрать не то, что просили.
 * Но тогда об этом говорится вслух, потому что в панели у окружения будет
 * стоять версия из директивы, а в образе — чужая.
 */
export function rootParentImage(version: string, override?: string): string {
  const named = override?.trim()
  return named ? named : pythonImage(version)
}

function rootParent(build: Build, root: string): string {
  const asked = pythonImage(pythonOf(root))
  const chosen = rootParentImage(pythonOf(root), process.env.KERNEL_PARENT)
  if (chosen !== asked) {
    push(build, tr('server.kernelParentIsSetInTheServers.4c1d90', { p0: chosen, p1: asked }))
  }
  return chosen
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
  if (usingRuntimeBroker())
    throw new Error(tr('server.publishedEnvironmentsAreBuiltOutsideTheWeb.538ec6'))
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
    const message = tr('server.environmentInThisChainIsAlreadyBuilding.166f94', { p0: busy })
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

  /*
   * Контекст готовится здесь, а не в начале: до этой строки сборку могли
   * отменить, и копировать каталог ради отменённой сборки незачем. Отказ
   * копирования (нет места, закрыт каталог состояния) — это провал сборки со
   * своей причиной в журнале, а не исключение, летящее мимо панели.
   */
  let kernel: string
  try {
    kernel = buildContext(name)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    push(build, message)
    build.failed = true
    build.done = true
    failures.set(name, message)
    release(held)
    return
  }

  const base = rootParent(build, chain[0] as string)
  for (const step of stages) {
    if (build.done) break
    const before = chain[chain.indexOf(step) - 1]
    if (!(await runStage(build, plan, step, before ? `colloq-kernel:${before}` : base, kernel)))
      break
  }

  build.done = true
  if (!build.failed) push(build, tr('server.buildFinished.ce23d0'))
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
  const res = await run('docker', ['compose', ...files, 'up', '-d', 'kernel'], 120_000, {
    KERNEL_ENV: name,
  })
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
   * Просит одну версию Python, а собрано на другой — тоже «пересобрать».
   *
   * Отдельной проверкой, потому что штамп здесь не помогает: директива для pip
   * комментарий, и `listChanged` её не видит вовсе — то есть смена версии в
   * шапке не меняет НИЧЕГО в том, чем мы отличаем свежий образ от старого.
   * Панель показывала бы «Python 3.12 · Ready» над образом с 3.11, а узнавали
   * бы об этом на первом `match` посреди пары.
   */
  if (pythonDrifted(name, built)) return 'unbuilt'
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

/**
 * Разошлись ли версия из файла и версия в образе.
 *
 * Сравниваются минорные версии: образ говорит `3.12.7`, файл просит `3.12` —
 * это одна и та же версия, и предлагать из-за патча пересборку значит звать на
 * неё после каждого обновления официального образа. Образ, который про Python
 * молчит (собран не от python-slim), расхождением не считается: сказать
 * «пересоберите» на основании незнания — хуже, чем промолчать.
 */
function pythonDrifted(name: string, built: ImageFacts): boolean {
  if (built.python === null) return false
  const minor = built.python.split('.').slice(0, 2).join('.')
  return minor !== pythonOf(name)
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
    return loadRuntimeCatalog()
      .environments.filter((e) => e.current)
      .map((e) => ({
        name: e.name,
        state: 'ready',
        packages: e.packages ?? [],
        imageBytes: null,
        builtAt: null,
        active: e.name === active,
        error: null,
        parent: null,
        gpu: e.gpu,
        // Версия — только та, которую назвал каталог: образ здесь чужой и
        // неизменный, спросить его отсюда нечем, а умолчание на этом месте было
        // бы выдумкой о production-сборке. Не сказано — панель промолчит.
        python: e.python ?? '',
        pythonBuilt: null,
        managed: true,
        image: e.image,
        revision: imageRevision(e.image),
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
      // Обе версии: чего просит файл и что получилось в образе. Пока они
      // совпадают, панель показывает вторую — она точнее (`3.12.7`); разошлись
      // — первую, вместе с «Needs rebuild», который её и объясняет.
      python: pythonOf(name),
      pythonBuilt: built?.python ?? null,
    }
  })
}
