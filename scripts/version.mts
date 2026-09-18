/**
 * Версия Colloq: одно число и все его копии.
 *
 *   node --import tsx scripts/version.mts current
 *   node --import tsx scripts/version.mts check [--tag vX.Y.Z]
 *   node --import tsx scripts/version.mts sync [--dry-run]
 *   make version
 *
 * Источник один — поле "version" корневого package.json. Всё остальное его
 * копии, и у каждой копии есть причина существовать, поэтому их не убрать, а
 * только держать равными:
 *
 *   · package.json воркспейсов и shared/ — npm требует поле в каждом, а
 *     `colloq --version` в рабочей копии читает именно cli/package.json;
 *   · package-lock.json — в нём записаны версии корня и каждого воркспейса, и
 *     `npm ci` сверяет замок с манифестами;
 *   · python/colloq/_version.py — из него hatchling берёт версию колеса, и он же
 *     нужен sdist-у, который собирается без node;
 *   · .release-please-manifest.json — последняя выпущенная версия для
 *     release-please.
 *
 * Поднимает число только release-please (.github/workflows/release-please.yml):
 * он держит PR выпуска, и в этом PR правит все копии разом — те, что знает
 * release-type node (package.json, корень замка), и те, что перечислены в
 * extra-files release-please-config.json. Этот скрипт ничего не поднимает. Он
 * сверяет копии и заранее, офлайн, проигрывает правку release-please
 * (simulateRelease): копия, которую тот не тронет, разъехалась бы с корнем
 * прямо в PR выпуска, и CI уронил бы его уже после того, как владелец решил
 * выпускать. Новый воркспейс без строки в extra-files ловится так на первом же
 * PR, который его приносит.
 *
 * Производные (веб, сервер, образы, release.json) копий не держат: веб и сервер
 * берут число из корневого package.json на сборке, образы — из тега. См.
 * RELEASING.md.
 *
 * npm install здесь не зовётся намеренно: он переразрешил бы дерево и принёс бы
 * в замок чужие изменения под видом правки версии. Версии в замке правятся как
 * JSON, и правка отказывается, если файл не в каноническом виде npm (тогда
 * запись переформатировала бы его целиком, и diff стал бы нечитаемым).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PYTHON_VERSION_FILE = 'python/colloq/_version.py'
export const CHANGELOG_FILE = 'CHANGELOG.md'
export const LOCK_FILE = 'package-lock.json'
export const RELEASE_PLEASE_CONFIG = 'release-please-config.json'
export const RELEASE_PLEASE_MANIFEST = '.release-please-manifest.json'
/*
 * shared/ — не воркспейс, его package.json существует ради "type": "module".
 * Версия там всё равно записана, и 0.0.0 рядом с 0.1.0 выглядело как забытая
 * копия. Держим равной, чтобы вопрос не возникал.
 */
const EXTRA_MANIFESTS = ['shared/package.json']

// ------------------------------------------------------------------ semver

/*
 * Не весь semver, а его часть, которую понимают все три потребителя.
 *
 * Предвыпуск — только alpha|beta|rc с номером. Это не вкус: версия уходит в
 * колесо, а PEP 440 знает ровно эти три слова (0.2.0-rc.1 → 0.2.0rc1), и
 * «0.2.0-next.1» собралось бы в npm и в тег, а на `pip wheel` упало бы — в
 * середине выпуска, когда тег уже в origin. Сборочные метаданные (+sha)
 * отрезаны по той же причине: у тега и образа Docker символа «+» нет.
 * release-please такое число сам не придумает, но Release-As в коммите — может.
 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/

export function isVersion(text: string): boolean {
  return SEMVER.test(text)
}

// ------------------------------------------------------------------ файлы

type Json = Record<string, unknown>
/** Текст файла по пути от корня репозитория; null — файла нет. */
export type Reader = (file: string) => string | null

export function diskReader(root: string): Reader {
  return (file) => {
    try {
      return fs.readFileSync(path.join(root, file), 'utf8')
    } catch {
      return null
    }
  }
}

function parseJson(file: string, text: string): Json {
  try {
    return JSON.parse(text) as Json
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`)
  }
}

/** Канонический вид npm — отступ 2 и перевод строки в конце. */
function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function readJson(read: Reader, file: string): Json | null {
  const text = read(file)
  return text === null ? null : parseJson(file, text)
}

export function rootVersion(root: string = ROOT, read: Reader = diskReader(root)): string {
  const pkg = readJson(read, 'package.json')
  if (pkg === null) throw new Error(`no package.json in ${root}`)
  if (typeof pkg.version !== 'string') throw new Error('package.json has no "version"')
  return pkg.version
}

export function workspaces(read: Reader): string[] {
  const pkg = readJson(read, 'package.json') ?? {}
  const list = Array.isArray(pkg.workspaces) ? pkg.workspaces : []
  return list.filter((item): item is string => typeof item === 'string')
}

export function manifests(read: Reader): string[] {
  return [...workspaces(read).map((w) => `${w}/package.json`), ...EXTRA_MANIFESTS].filter(
    (file) => read(file) !== null,
  )
}

/*
 * Файл версии для hatchling. Пишут его двое: release-please в PR выпуска и
 * scripts/pack.mts при каждой упаковке. Текст обязан быть один: иначе упаковка
 * на CI (`make wheel`, затем `git diff --exit-code`) нашла бы в PR выпуска
 * «грязное» дерево. release-please меняет только число в строке с пометкой
 * x-release-please-version (его Generic updater, extra-files), остальной текст
 * не трогает, — поэтому пометка живёт здесь, в общем шаблоне, а не дописана
 * руками в файл. В шапке файла её нет нарочно: строку с пометкой release-please
 * правит целиком, где бы та ни стояла.
 */
export function pythonVersionFile(version: string): string {
  return (
    '# Версия пакета для hatchling: pyproject.toml берёт версию колеса отсюда.\n' +
    '# Число поднимает release-please в PR выпуска (по пометке в конце строки),\n' +
    '# а scripts/pack.mts переписывает файл тем же текстом при упаковке. Руками\n' +
    '# не править: `make version` сверяет число с корневым package.json.\n' +
    `__version__ = "${version}"  # x-release-please-version\n`
  )
}

// Хвостовой комментарий — та самая пометка release-please.
const PY_VERSION = /^__version__\s*=\s*["']([^"']*)["']\s*(?:#.*)?$/m

export interface Copy {
  where: string
  version: string | null
}

/** Все места, где записано число, кроме самого источника. */
export function collectCopies(read: Reader): Copy[] {
  const out: Copy[] = []
  for (const file of manifests(read)) {
    const value = readJson(read, file)!.version
    out.push({ where: file, version: typeof value === 'string' ? value : null })
  }
  const lock = readJson(read, LOCK_FILE)
  if (lock !== null) {
    const packages = (lock.packages ?? {}) as Record<string, Json | undefined>
    const at = (value: unknown) => (typeof value === 'string' ? value : null)
    out.push({ where: LOCK_FILE, version: at(lock.version) })
    out.push({ where: `${LOCK_FILE} packages[""]`, version: at(packages['']?.version) })
    for (const w of workspaces(read)) {
      out.push({ where: `${LOCK_FILE} packages["${w}"]`, version: at(packages[w]?.version) })
    }
  }
  const py = read(PYTHON_VERSION_FILE)
  out.push({ where: PYTHON_VERSION_FILE, version: py === null ? null : (PY_VERSION.exec(py)?.[1] ?? null) })
  return out
}

/**
 * Новые тексты всех копий под корневое число. Ничего не пишет: и --dry-run, и
 * тесты смотрят на результат, а запись — одна строка у вызывающего.
 */
export function versionEdits(read: Reader, version: string): Map<string, string> {
  const edits = new Map<string, string>()
  const setVersion = (file: string, mutate: (value: Json) => void) => {
    const text = read(file)
    if (text === null) return
    const value = parseJson(file, text)
    if (stringify(value) !== text) {
      throw new Error(
        `${file} is not in npm's canonical JSON layout; rewriting it would reformat the whole ` +
          'file. Format it first (2-space indent, trailing newline) and run again.',
      )
    }
    mutate(value)
    const next = stringify(value)
    if (next !== text) edits.set(file, next)
  }
  for (const file of manifests(read)) {
    setVersion(file, (value) => {
      value.version = version
    })
  }
  const names = workspaces(read)
  setVersion(LOCK_FILE, (lock) => {
    lock.version = version
    const packages = (lock.packages ?? {}) as Record<string, Json | undefined>
    for (const key of ['', ...names]) {
      if (packages[key]) packages[key].version = version
    }
  })
  const py = read(PYTHON_VERSION_FILE)
  if (py !== null && py !== pythonVersionFile(version)) edits.set(PYTHON_VERSION_FILE, pythonVersionFile(version))
  return edits
}

// ------------------------------------------------------------- CHANGELOG

/*
 * Заголовки выпусков, которые бывают в журнале: прежний рукописный
 * «## [0.1.0] - 2026-09-13» и то, что пишет release-please, —
 * «## [0.2.0](…/compare/v0.1.0...v0.2.0) (2026-09-20)», а без прошлого тега
 * «## 0.2.0 (2026-09-20)». ### — у старых версий release-please для patch.
 * «### Features» и прочие подзаголовки сюда не попадают: версия начинается с цифры.
 */
const VERSION_HEADING = /^#{2,3} \[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\]?(?:[\s(]|$)/

/** Версии разделов журнала сверху вниз. */
export function changelogVersions(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = VERSION_HEADING.exec(line)
    if (m) out.push(m[1]!)
  }
  return out
}

/*
 * Куда release-please вставит раздел нового выпуска: перед первым совпадением
 * этой строки (updaters/changelog.ts, DEFAULT_VERSION_HEADER_REGEX). Любой
 * заголовок вида «## [», «## 1» или «### v» выше настоящих выпусков —
 * например, рукописный «## [Unreleased]» — перехватил бы вставку.
 */
const RELEASE_PLEASE_INSERT_AT = /\n###? v?[0-9[]/s

// ------------------------------------------------------------ release-please

interface ExtraFile {
  type?: string
  path: string
  jsonpath?: string
}

interface ReleasePleaseConfig {
  releaseType: string | null
  releaseAs: string | null
  extraFiles: Array<string | ExtraFile>
}

function releasePleaseConfig(read: Reader): ReleasePleaseConfig | null {
  const config = readJson(read, RELEASE_PLEASE_CONFIG)
  if (config === null) return null
  const packages = (config.packages ?? {}) as Record<string, Json | undefined>
  const root = packages['.'] ?? {}
  const pick = (key: string) => (root[key] ?? config[key]) as unknown
  const extra = pick('extra-files')
  return {
    releaseType: typeof pick('release-type') === 'string' ? (pick('release-type') as string) : null,
    releaseAs: typeof root['release-as'] === 'string' ? (root['release-as'] as string) : null,
    extraFiles: Array.isArray(extra) ? (extra as Array<string | ExtraFile>) : [],
  }
}

/*
 * Подмножество JSONPath, которого хватает extra-files: $.a.b и $.a["b-c"].
 * release-please понимает весь JSONPath (jsonpath-plus), но сверке нужно знать
 * точно, какое поле он тронет, а путь сложнее этого — повод упростить конфиг,
 * а не сверку.
 */
function jsonPathKeys(expression: string): string[] | null {
  if (!expression.startsWith('$')) return null
  const keys: string[] = []
  const step = /^(?:\.([A-Za-z_$][\w$]*)|\[(?:"([^"]*)"|'([^']*)')\])/
  let rest = expression.slice(1)
  while (rest) {
    const m = step.exec(rest)
    if (!m) return null
    keys.push(m[1] ?? m[2] ?? m[3]!)
    rest = rest.slice(m[0].length)
  }
  return keys.length ? keys : null
}

const RP_VERSION = /(\d+)\.(\d+)\.(\d+)(-[\w.]+)?(\+[-\w.]+)?/

/**
 * Что release-please сделает с деревом, выпуская `next`, — без сети и без
 * самого release-please. Повторены ровно те правки, которые он делает для
 * этого репозитория (release-please 17, strategies/node.ts и base.ts):
 *
 *   · package.json → version; package-lock.json → version и packages[""]
 *     (release-type node, updaters/node/*);
 *   · extra-files: type json — строка по jsonpath (GenericJson), type generic
 *     или путь строкой — число в строках с пометкой x-release-please-version
 *     (Generic); путь строкой на .json — ещё и $.version;
 *   · .release-please-manifest.json → {".": next};
 *   · CHANGELOG.md — раздел выпуска вставляется перед первым заголовком версии.
 *
 * Файла нет или путь не ведёт к строке с числом — release-please молча
 * пропускает правку (createIfMissing: false, «No string in …. Skipping.»),
 * поэтому такие места возвращаются в `problems`, а не глотаются.
 */
export function simulateRelease(read: Reader, next: string): { files: Map<string, string>; problems: string[] } {
  const files = new Map<string, string>()
  const problems: string[] = []
  const current = (file: string) => (files.has(file) ? files.get(file)! : read(file))
  const config = releasePleaseConfig(read)
  if (config === null) return { files, problems: [`${RELEASE_PLEASE_CONFIG} is missing`] }
  if (config.releaseType !== 'node') {
    problems.push(`${RELEASE_PLEASE_CONFIG}: release-type must be "node" (it updates package.json and the lock root)`)
  }

  const editJson = (file: string, mutate: (value: Json) => boolean, what: string) => {
    const text = current(file)
    if (text === null) {
      problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: ${file} does not exist`)
      return
    }
    const value = parseJson(file, text)
    if (mutate(value)) files.set(file, stringify(value))
    else problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: no version string there`)
  }
  const setAt = (value: Json, keys: string[]): boolean => {
    let node: unknown = value
    for (const key of keys.slice(0, -1)) {
      if (typeof node !== 'object' || node === null) return false
      node = (node as Json)[key]
    }
    const last = keys[keys.length - 1]!
    if (typeof node !== 'object' || node === null) return false
    const old = (node as Json)[last]
    if (typeof old !== 'string' || !RP_VERSION.test(old)) return false
    ;(node as Json)[last] = old.replace(RP_VERSION, next)
    return true
  }

  // release-type node.
  editJson('package.json', (pkg) => setAt(pkg, ['version']), 'package.json')
  if (read(LOCK_FILE) !== null) {
    editJson(
      LOCK_FILE,
      (lock) => {
        lock.version = next
        const packages = lock.packages as Record<string, Json> | undefined
        if (packages?.['']) packages[''].version = next
        return true
      },
      LOCK_FILE,
    )
  }

  // extra-files.
  // quiet: путь строкой на .json release-please прогоняет и через Generic, но
  // без пометки там просто нечего менять — это не ошибка конфига.
  const generic = (file: string, what: string, quiet = false) => {
    const text = current(file)
    if (text === null) {
      if (!quiet) problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: ${file} does not exist`)
      return
    }
    let touched = false
    const out = text
      .split(/\r?\n/)
      .map((line) => {
        if (!/x-release-please-version/.test(line) || !RP_VERSION.test(line)) return line
        touched = true
        return line.replace(RP_VERSION, next)
      })
      .join('\n')
    if (touched) files.set(file, out)
    else if (!quiet) problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: no line marked x-release-please-version in ${file}`)
  }
  for (const entry of config.extraFiles) {
    if (typeof entry === 'string') {
      const isJson = entry.endsWith('.json')
      if (isJson) editJson(entry, (value) => setAt(value, ['version']), `extra-files ${entry}`)
      generic(entry, `extra-files ${entry}`, isJson)
      continue
    }
    const what = `extra-files ${entry.path}${entry.jsonpath ? ` ${entry.jsonpath}` : ''}`
    if (entry.type === 'json') {
      const keys = jsonPathKeys(entry.jsonpath ?? '')
      if (!keys) {
        problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: use a plain path like $.a.b or $.a["b"]`)
        continue
      }
      editJson(entry.path, (value) => setAt(value, keys), what)
    } else if (entry.type === 'generic') generic(entry.path, what)
    else problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: type "${entry.type}" is not used in this repository`)
  }

  files.set(RELEASE_PLEASE_MANIFEST, stringify({ '.': next }))
  const changelog = current(CHANGELOG_FILE) ?? ''
  const entry = `## [${next}](https://github.com/example/colloq/compare/v0...v${next}) (2026-01-01)\n\n### Bug Fixes\n\n* something`
  const at = changelog.search(RELEASE_PLEASE_INSERT_AT)
  files.set(
    CHANGELOG_FILE,
    at === -1
      ? `# Changelog\n\n${entry}\n\n${changelog.replace(/^#(\s)/gm, '##$1').trim()}\n`
      : `${changelog.slice(0, at)}\n${entry}\n${changelog.slice(at)}`.trim() + '\n',
  )
  return { files, problems }
}

/** Следующее число для пробного выпуска: patch, из предвыпуска — сам выпуск. */
function probeVersion(version: string): string {
  const m = SEMVER.exec(version)
  if (!m) return '0.0.1'
  return m[4] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

// ------------------------------------------------------------------ сверка

export interface CheckOptions {
  tag?: string
}

/** Список расхождений. Пустой — всё сходится. */
export function checkVersions(root: string = ROOT, options: CheckOptions = {}, read: Reader = diskReader(root)): string[] {
  const problems: string[] = []
  const version = rootVersion(root, read)
  if (!isVersion(version)) {
    problems.push(`package.json version "${version}" is not MAJOR.MINOR.PATCH[-alpha|beta|rc.N]`)
  }
  for (const copy of collectCopies(read)) {
    if (copy.version === null) problems.push(`${copy.where} has no version (expected ${version})`)
    else if (copy.version !== version) problems.push(`${copy.where} says ${copy.version}, package.json says ${version}`)
  }

  // Число поднимает release-please, и его манифест — та же копия. Разошлись —
  // значит, package.json подняли мимо PR выпуска.
  const manifest = readJson(read, RELEASE_PLEASE_MANIFEST)
  if (manifest === null) problems.push(`${RELEASE_PLEASE_MANIFEST} is missing`)
  else if (manifest['.'] !== version) {
    problems.push(
      `${RELEASE_PLEASE_MANIFEST} says ${String(manifest['.'])}, package.json says ${version}; ` +
        'versions change only in the release-please pull request',
    )
  }

  const changelog = read(CHANGELOG_FILE)
  if (changelog === null) problems.push(`${CHANGELOG_FILE} is missing`)
  else {
    const versions = changelogVersions(changelog)
    // Верхний раздел — текущая версия: release-please кладёт новый раздел
    // наверх в том же PR, где поднимает число.
    if (versions[0] !== version) {
      problems.push(
        `${CHANGELOG_FILE}: the top section is ${versions[0] ?? 'missing'}, package.json says ${version}; ` +
          'release-please writes this file, do not add sections by hand',
      )
    }
    // Второй раздел того же числа — это второй PR «release X» после выпуска X:
    // так бывает, если release-as в конфиге забыли убрать (RELEASING.md).
    const seen = new Set<string>()
    for (const v of versions) {
      if (seen.has(v)) problems.push(`${CHANGELOG_FILE} has two sections for ${v}`)
      seen.add(v)
    }
    // Всё, что выше раздела текущей версии и похоже на заголовок выпуска,
    // перехватило бы вставку release-please.
    const first = changelog.search(RELEASE_PLEASE_INSERT_AT)
    const heading = first === -1 ? null : changelog.slice(first + 1).split('\n')[0]!
    if (heading !== null && VERSION_HEADING.exec(heading)?.[1] !== versions[0]) {
      problems.push(`${CHANGELOG_FILE}: "${heading}" would take release-please's next section; remove it`)
    }
  }

  // Пробный выпуск: всё, что release-please правит, и всё, что не правит.
  const next = probeVersion(version)
  const simulated = simulateRelease(read, next)
  problems.push(...simulated.problems)
  if (simulated.problems.length === 0) {
    const after: Reader = (file) => (simulated.files.has(file) ? simulated.files.get(file)! : read(file))
    for (const copy of collectCopies(after)) {
      if (copy.version !== next) {
        problems.push(
          `release-please would leave ${copy.where} at ${copy.version ?? 'nothing'}: ` +
            `add it to extra-files in ${RELEASE_PLEASE_CONFIG}`,
        )
      }
    }
    // Упаковка перепишет _version.py шаблоном; разойдись он с правкой
    // release-please — PR выпуска упал бы на `git diff --exit-code` в CI.
    const py = after(PYTHON_VERSION_FILE)
    if (py !== null && py !== pythonVersionFile(next)) {
      problems.push(`${PYTHON_VERSION_FILE} differs from pythonVersionFile() after release-please edits it`)
    }
    if (changelogVersions(after(CHANGELOG_FILE) ?? '')[0] !== next) {
      problems.push(`release-please would not put the next section at the top of ${CHANGELOG_FILE}`)
    }
  }

  if (options.tag !== undefined && options.tag !== `v${version}`) {
    problems.push(`tag ${options.tag} does not match package.json version ${version} (expected v${version})`)
  }
  return problems
}

// ------------------------------------------------------------------ CLI

const USAGE = `Usage: node --import tsx scripts/version.mts <command>

  current                 print the version (root package.json)
  check [--tag vX.Y.Z]    fail if any copy, the changelog, the release-please files
                          or the tag disagree, or if release-please would miss a copy
  sync [--dry-run]        rewrite every copy to the root package.json version
                          (a repair; new versions come from the release-please PR)`

export function main(argv: string[], root: string = ROOT): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tag: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command] = positionals
  const read = diskReader(root)
  if (values.help || !command) {
    console.log(USAGE)
    return command || values.help ? 0 : 2
  }

  if (command === 'current') {
    console.log(rootVersion(root, read))
    return 0
  }

  if (command === 'check') {
    const problems = checkVersions(root, { tag: values.tag }, read)
    const version = rootVersion(root, read)
    // Первый выпуск идёт с release-as; после него строку нужно убрать, иначе
    // release-please снова предложит то же число. Не ошибка: в PR выпуска
    // это число и должно совпадать.
    const pinned = releasePleaseConfig(read)?.releaseAs
    if (pinned && pinned === version) {
      console.log(
        `note: ${RELEASE_PLEASE_CONFIG} still pins release-as ${pinned}. Once v${pinned} is released, ` +
          'remove it (RELEASING.md, "The first release").',
      )
    }
    if (problems.length === 0) {
      console.log(`version ${version}: every copy agrees` + (values.tag ? `, tag ${values.tag} matches` : ''))
      return 0
    }
    for (const problem of problems) console.error(`✗ ${problem}`)
    console.error('\nCopies: node --import tsx scripts/version.mts sync · a new version: the release-please PR (RELEASING.md)')
    return 1
  }

  /*
   * Починка расхождения без нового числа: копии догоняют корень. Нужна тому,
   * кто принёс воркспейс или поправил копию руками. Манифест release-please
   * не трогается: если руками подняли сам package.json, check это и покажет.
   */
  if (command === 'sync') {
    const version = rootVersion(root, read)
    if (!isVersion(version)) throw new Error(`package.json version "${version}" is not MAJOR.MINOR.PATCH[-alpha|beta|rc.N]`)
    const edits = versionEdits(read, version)
    for (const [file, text] of edits) {
      console.log(`  ${file.padEnd(28)} → ${version}`)
      if (!values['dry-run']) fs.writeFileSync(path.join(root, file), text)
    }
    console.log(edits.size === 0 ? `every copy already says ${version}` : values['dry-run'] ? '\nDry run: nothing written.' : '')
    return 0
  }

  console.error(USAGE)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`version: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
