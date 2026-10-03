import { tr } from './i18n.js'
/**
 * The vocabulary of a class page: what a file is, what to call it, what its
 * address is, and whether it goes out by default.
 *
 * One copy for the server, which builds pages and computes default ticks,
 * and for the browser, which draws course rows from the same tags. Pure: it
 * looks only at names, sizes and texts it is handed, never at the disk.
 *
 * The default ticks are suggestions with a reason attached, never silent
 * decisions: the teacher sees «похоже на ответы» next to an unticked
 * `solutions.py` and can tick it anyway. The rules lean towards leaving a
 * file out, because what goes out is a public link that cannot be taken back
 * from a chat, while a file left out is one click away.
 */
import { baseOf, extOf, parentOf } from './paths.js'
import {
  MATERIAL_KINDS,
  MAX_FOLDER_FILES,
  MAX_MATERIAL_NAME,
  PICK_DATA_BYTES,
  PICK_TEXT_BYTES,
  transliterate,
  type MaterialKind,
  type PickReason,
} from './publish.js'

/* ------------------------------------------------------------------ kinds */

const DATA_EXT = new Set([
  'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'geojson', 'parquet', 'feather', 'arrow', 'orc',
  'xlsx', 'xls', 'ods', 'npy', 'npz', 'pkl', 'pickle', 'joblib', 'h5', 'hdf5', 'nc',
  'sqlite', 'db', 'zip', 'gz', 'bz2', 'xz', 'tar', 'tgz', 'dta', 'sav', 'arff', 'mat',
])
const CODE_EXT = new Set([
  'py', 'pyi', 'r', 'sql', 'sh', 'bash', 'js', 'ts', 'jl', 'c', 'cpp', 'h', 'java', 'go', 'rs',
])
const TEXT_EXT = new Set([
  'md', 'markdown', 'txt', 'rst', 'tex', 'yaml', 'yml', 'toml', 'cfg', 'ini', 'bib',
])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])

/** What a material is, by its file name; a path with a trailing slash is a folder ('data/'). */
export function materialKind(path: string): MaterialKind {
  if (path.endsWith('/')) return 'folder'
  const ext = extOf(path)
  if (ext === 'ipynb') return 'notebook'
  if (ext === 'pdf') return 'pdf'
  if (DATA_EXT.has(ext)) return 'data'
  if (CODE_EXT.has(ext)) return 'code'
  if (TEXT_EXT.has(ext)) return 'text'
  if (IMAGE_EXT.has(ext)) return 'image'
  return 'file'
}

/**
 * How much of a text file the publishing checks read (publish/checks.ts):
 * keys, students' names and the room's address are looked for in at most
 * this many bytes of a file.
 */
export const SCAN_TEXT_BYTES = 2 * 1024 * 1024
const SCAN_DATA_EXT = new Set(['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'geojson', 'txt'])

/**
 * Whether the checks can read this file: code, text and the text kinds of
 * data, small enough to read whole. A parquet, a picture or an exported page
 * is not looked into.
 */
export function scannable(path: string, bytes: number): boolean {
  const kind = materialKind(path)
  if (bytes > SCAN_TEXT_BYTES) return false
  if (kind === 'code' || kind === 'text') return true
  return kind === 'data' && SCAN_DATA_EXT.has(extOf(path))
}

/** The file name without its last extension: `lecture.ipynb` → `lecture`. */
export function stemOf(path: string): string {
  const base = baseOf(path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/* ------------------------------------------------------------------ roles */

/** What a notebook or a PDF is for, read from its name; `null` when the name does not say. */
export type MaterialRole = 'lecture' | 'seminar' | 'homework' | 'slides' | null

const LECTURE_RE = /lect|лекц/
const SEMINAR_RE = /semin|семин|practic|практи|(^|[^a-z])sem([^a-z]|$)/
const HOMEWORK_RE = /home ?work|домашн|assignment|(^|[^a-zа-яё])(hw|дз)([^a-zа-яё]|$)/
const SLIDES_RE = /slide|слайд|presentation|презентац/

export function roleOf(text: string): MaterialRole {
  const t = text.toLowerCase().replace(/[_]+/g, ' ')
  if (HOMEWORK_RE.test(t)) return 'homework'
  if (SLIDES_RE.test(t)) return 'slides'
  if (LECTURE_RE.test(t)) return 'lecture'
  if (SEMINAR_RE.test(t)) return 'seminar'
  return null
}

/**
 * The name a material gets until the teacher types another.
 *
 * Notebooks and PDFs get a word when their file names say what they are
 * (`lecture.ipynb` → «Лекция»), otherwise the file name. Everything else
 * keeps its room path: code refers to `data/train.csv`, and calling it
 * «Данные» on the page would hide the one thing the reader needs to know.
 */
export function suggestName(path: string, kind: MaterialKind = materialKind(path)): string {
  const role = roleOf(stemOf(path))
  let name: string
  if (kind === 'notebook') {
    name =
      role === 'lecture'
        ? tr('server.material.lecture')
        : role === 'seminar'
          ? tr('server.material.seminar')
          : role === 'homework'
            ? tr('server.material.homework')
            : stemOf(path)
  } else if (kind === 'pdf') {
    name =
      role === 'lecture'
        ? tr('server.material.lectureSlides')
        : role === 'seminar'
          ? tr('server.material.seminarSlides')
          : role === 'slides'
            ? tr('server.material.slides')
            : stemOf(path)
  } else {
    // A folder keeps its slash: «data/» on the page is what `data/` is in the code.
    name = path
  }
  return name.slice(0, MAX_MATERIAL_NAME)
}

/**
 * Suggested names for a whole page at once.
 *
 * Two notebooks that both look like a lecture would both be «Лекция», and two
 * tabs with one name are no tabs at all: a name that would repeat falls back
 * to the file name for every material that shares it.
 */
export function suggestNames(paths: readonly string[]): string[] {
  const suggested = paths.map((path) => suggestName(path))
  const count = new Map<string, number>()
  for (const name of suggested) count.set(name, (count.get(name) ?? 0) + 1)
  return suggested.map((name, i) => {
    if ((count.get(name) ?? 0) < 2) return name
    const kind = materialKind(paths[i])
    const fallback = kind === 'notebook' || kind === 'pdf' ? stemOf(paths[i]) : paths[i]
    return fallback.slice(0, MAX_MATERIAL_NAME)
  })
}

/* -------------------------------------------------------------------- keys */

/**
 * A material's address on the page: `/p/ml-strong-04/seminar`.
 *
 * Lowercase Latin, digits and hyphens, at most forty characters, and always
 * at least one letter. The letter is what tells a material from a step: the
 * 0.12 addresses were `/p/<h>/<digits>`, and the reader turns any all-digit
 * tail into a legacy redirect.
 */
export const MATERIAL_KEY_RE = /^(?=[a-z0-9-]*[a-z])[a-z0-9-]{1,40}$/

export function materialKey(
  path: string,
  kind: MaterialKind,
  taken: Iterable<string> = [],
): string {
  const used = new Set(taken)
  const clip = (value: string, max: number) => value.slice(0, max).replace(/-+$/, '')
  // A folder's whole name: `data.v2/` is not a file `data` with an extension.
  const stem = kind === 'folder' ? baseOf(path.replace(/\/+$/, '')) : stemOf(path)
  // suggestSlug's rules without its three-letter minimum: `02.ipynb` keeps its digits.
  const slug = transliterate(stem).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  let base = clip(slug, 40)
  if (!/[a-z]/.test(base)) base = base ? clip(`${kind}-${base}`, 40) : kind
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const key = `${clip(base, 40 - suffix.length)}${suffix}`
    if (!used.has(key)) return key
  }
}

/* -------------------------------------------------------------------- tags */

/**
 * The words a course row lists for a page, in this order and once each:
 * «лекция · семинар · слайды · данные». The browser translates them.
 */
export type MaterialTag =
  | 'lecture'
  | 'seminar'
  | 'notebook'
  | 'homework'
  | 'slides'
  | 'pdf'
  | 'data'
  | 'code'
  | 'files'

export const MATERIAL_TAGS: readonly MaterialTag[] = [
  'lecture',
  'seminar',
  'notebook',
  'homework',
  'slides',
  'pdf',
  'data',
  'code',
  'files',
]

interface Named {
  kind: MaterialKind
  name: string
  path?: string
  /** Folders: what is inside (MaterialRef · holds). */
  holds?: readonly MaterialKind[]
}

function roleOfMaterial(m: Named): MaterialRole {
  return roleOf(m.name) ?? (m.path ? roleOf(stemOf(m.path)) : null)
}

/**
 * The words a material adds to its course row.
 *
 * A folder speaks for what is in it: «данные» for data, «код» for code, both
 * when it holds both, «файлы» for anything else. A folder of pictures adds
 * nothing: they are the notes' illustrations, and «файлы» on the row would
 * promise something to download that nobody would look for.
 */
export function tagsOf(m: Named): MaterialTag[] {
  if (m.kind !== 'folder') return [tagOf(m)]
  const holds = m.holds ?? []
  const tags: MaterialTag[] = []
  if (holds.includes('data')) tags.push('data')
  if (holds.includes('code')) tags.push('code')
  if (tags.length > 0) return tags
  if (holds.length > 0 && holds.every((kind) => kind === 'image')) return []
  return ['files']
}

export function tagOf(m: Named): MaterialTag {
  if (m.kind === 'folder') return tagsOf(m)[0] ?? 'files'
  const role = roleOfMaterial(m)
  if (m.kind === 'notebook') {
    return role === 'lecture' || role === 'seminar' || role === 'homework' ? role : 'notebook'
  }
  if (m.kind === 'pdf') return role === 'lecture' || role === 'slides' ? 'slides' : 'pdf'
  if (m.kind === 'data') return 'data'
  if (m.kind === 'code') return 'code'
  return 'files'
}

export function materialTags(materials: readonly Named[]): MaterialTag[] {
  const present = new Set(materials.flatMap(tagsOf))
  return MATERIAL_TAGS.filter((tag) => present.has(tag))
}

/**
 * What a folder is called on the page, by what it holds: «Данные» when there
 * is data in it, «Код» for code, «Картинки» when it is only pictures, else
 * «Файлы». One rule for the page, the panel and the README.
 */
export function folderLabel(holds: readonly MaterialKind[]): 'data' | 'code' | 'image' | 'file' {
  if (holds.includes('data')) return 'data'
  if (holds.includes('code')) return 'code'
  if (holds.length > 0 && holds.every((kind) => kind === 'image')) return 'image'
  return 'file'
}

/** The kinds of these files, once each, in MATERIAL_KINDS order. */
export function holdsOf(paths: readonly string[]): MaterialKind[] {
  const present = new Set(paths.map(materialKind))
  return MATERIAL_KINDS.filter((kind) => present.has(kind))
}

/**
 * The default page order: Лекция, Семинар, other notebooks, Домашнее
 * задание, then PDFs, data, code and the rest, and folders last. Sort by it
 * stably, so that materials of one rank keep the order they came in.
 */
export function materialRank(m: Named): number {
  if (m.kind === 'notebook') {
    const role = roleOfMaterial(m)
    return role === 'lecture' ? 0 : role === 'seminar' ? 1 : role === 'homework' ? 3 : 2
  }
  if (m.kind === 'pdf') return 4
  if (m.kind === 'data') return 5
  if (m.kind === 'code') return 6
  // A folder is the supporting cast: after every file the reader opens by itself.
  if (m.kind === 'folder') return 8
  return 7
}

/* ----------------------------------------------------------- default picks */

/**
 * A path segment starting with `_`: the teacher's own convention for "not for
 * students". Except a Python dunder name (`__init__.py`, `__main__.py`): that
 * underscore is the language's, and a package without its `__init__.py` does
 * not import after unzipping.
 */
export const PRIVATE_RE = /(^|\/)(?!__[^/]*?__(?:\.[^/]*)?(?:\/|$))_/

/** Answer keys and solutions, in both languages and in transliteration. */
export const ANSWERS_RE =
  /(^|[^a-zа-яё])(answers?|solutions?|solved|sol|ответы?|ответ\p{L}*|решени\p{L}*|решённ\p{L}*|otvet\p{L}*|reshen\p{L}*)([^a-zа-яё]|$)/iu

/** Folders that hold what a run produced, not what the class was given. */
export const GENERATED_DIRS: ReadonlySet<string> = new Set([
  'outputs', 'output', 'results', 'runs', 'logs', 'checkpoints', 'wandb', 'mlruns',
  'lightning_logs', 'catboost_info', 'tensorboard', 'tb_logs',
])
const GENERATED_EXT = new Set(['log', 'pyc', 'pt', 'pth', 'ckpt', 'safetensors', 'onnx'])
/** An exported plotly or folium page is megabytes of script; a handout in HTML is not. */
const GENERATED_HTML_BYTES = 1024 * 1024

/** Key stores and certificates by extension (and Keynote's .key, which a page cannot show). */
const SECRET_EXT = new Set(['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'ppk', 'kdbx'])
/** A file named for what it holds: `id_rsa`, `credentials.json`, `token.txt`, `openai_key.txt`. */
const SECRET_STEM = new RegExp(
  '^(id_(rsa|dsa|ecdsa|ed25519)|credentials?|secrets?|token|passwords?|api[-_]?keys?' +
    '|[\\w-]*[-_](api[-_]?)?key)$',
  'i',
)
const SERVICE_ACCOUNT = /service[-_]?account/i

/**
 * Whether a file's name says it is a key or a password. The checks find a
 * key inside text they can read; a .pem, an `id_rsa` or a GCP service
 * account in JSON is better caught by its name first.
 */
export function looksSecret(path: string): boolean {
  const stem = stemOf(path)
  return SECRET_EXT.has(extOf(path)) || SECRET_STEM.test(stem) || SERVICE_ACCOUNT.test(stem)
}

export function isPrivatePath(path: string): boolean {
  return PRIVATE_RE.test(path)
}

export function looksLikeAnswers(path: string): boolean {
  return ANSWERS_RE.test(stemOf(path).replace(/_/g, ' '))
}

export function looksGenerated(path: string, bytes: number): boolean {
  const segments = path.toLowerCase().split('/')
  if (segments.slice(0, -1).some((s) => GENERATED_DIRS.has(s))) return true
  const base = segments.at(-1) ?? ''
  const ext = extOf(base)
  if (GENERATED_EXT.has(ext) || base.includes('tfevents')) return true
  if ((ext === 'html' || ext === 'htm') && bytes > GENERATED_HTML_BYTES) return true
  return /^submission/.test(base)
}

/** Words of a name or a file stem: `ZuevAkim_02` → zuev, akim, 02. */
function wordsOf(text: string): string[] {
  const split = text.replace(/([a-zа-яё])([A-ZА-ЯЁ])/gu, '$1 $2')
  return transliterate(split)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * The participant a file name seems to belong to, or `null`.
 *
 * A notebook called `ZuevAkim_02.ipynb` in a room where «Зуев Аким» sat is a
 * student's work even when nobody recorded its owner (an upload, a copy made
 * by hand). It counts when every word of a multi-word name is in the file
 * name, or one word of four letters or more is: «Аким» in `akim_hw.ipynb`.
 */
export function rosterMatch(path: string, names: readonly string[]): string | null {
  const words = new Set(wordsOf(stemOf(path)))
  const compact = [...words].join('')
  for (const name of names) {
    const parts = wordsOf(name).filter((w) => w.length >= 3)
    if (parts.length === 0) continue
    if (parts.length > 1 && parts.every((p) => words.has(p) || compact.includes(p))) return name
    if (parts.some((p) => p.length >= 4 && words.has(p))) return name
  }
  return null
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `import a.b, c as d`: one statement per line, as Python writes them. */
const IMPORT_LINE = /^[ \t]*import[ \t]+([^\n#;]+)/gm
/** `from a.b import c, d as e`, `from . import c`, and a parenthesised list over lines. */
const FROM_LINE = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)/gm

interface Imports {
  /** Modules named as modules: `import a.b` and the `a.b` of `from a.b import`. */
  modules: Set<string>
  /** What a `from` takes, qualified: `from scripts import case_cian` → scripts.case_cian. */
  members: Set<string>
  /**
   * What a relative `from` names, relative to the importing package:
   * `from . import _utils` → _utils, `from ._core import x` → _core and
   * _core.x. The importer's own place is not known here, so these match any
   * module whose dotted path ends with them.
   */
  relative: Set<string>
}

/*
 * The same notebook text is asked about every file of the room, so its
 * imports are parsed once. Bounded, and emptied by the server once a picker
 * or a build is done (forgetImports): a cached text is up to a couple of
 * megabytes of somebody's code, and nothing else needs it afterwards.
 */
const importCache = new Map<string, Imports>()
const IMPORT_CACHE = 16

/** Drop the parsed imports of every text seen so far. */
export function forgetImports(): void {
  importCache.clear()
}

function importsOf(text: string): Imports {
  const known = importCache.get(text)
  if (known) return known
  const modules = new Set<string>()
  const members = new Set<string>()
  const relative = new Set<string>()
  const word = (part: string) => part.trim().split(/\s+/)[0] ?? ''
  for (const m of text.matchAll(IMPORT_LINE)) {
    for (const part of m[1].split(',')) {
      const name = word(part)
      if (/^\w+(\.\w+)*$/.test(name)) modules.add(name)
    }
  }
  for (const m of text.matchAll(FROM_LINE)) {
    // A relative `from .x import y` is a sibling module: its own name is what matches.
    const base = m[1].replace(/^\.+/, '')
    const isRelative = base !== m[1]
    if (base) modules.add(base)
    if (isRelative && base) relative.add(base)
    for (const part of m[2].replace(/[()\\]/g, ' ').split(',')) {
      const name = word(part)
      if (!/^\w+$/.test(name)) continue
      members.add(base ? `${base}.${name}` : name)
      if (isRelative) relative.add(base ? `${base}.${name}` : name)
    }
  }
  const found = { modules, members, relative }
  if (importCache.size >= IMPORT_CACHE) importCache.delete(importCache.keys().next().value!)
  importCache.set(text, found)
  return found
}

/**
 * Whether the text imports this Python file.
 *
 * By module (`import scripts.utils`, `from utils import plot`), by a `from`
 * list (`from scripts import case_cian as cian, case_bpm`), and for a
 * package's `__init__.py` by any import of the package or of a module in it:
 * `from scripts.eda_tools import load` runs scripts/__init__.py first.
 */
function imported(path: string, text: string): boolean {
  if (extOf(path) !== 'py') return false
  const { modules, members, relative } = importsOf(text)
  if (modules.size === 0 && members.size === 0) return false
  // `from ._core import x` runs _core/__init__.py and imports _core.py or _core/x.py.
  const endsWith = (whole: string, tail: string) => whole === tail || whole.endsWith(`.${tail}`)
  if (baseOf(path) === '__init__.py') {
    const pkg = parentOf(path).replace(/\//g, '.')
    if (!pkg) return false
    const under = (n: string) =>
      n === pkg || n.startsWith(`${pkg}.`) || n.endsWith(`.${pkg}`) || n.includes(`.${pkg}.`)
    if ([...modules].some(under)) return true
    if ([...members].some((n) => n === pkg || n.endsWith(`.${pkg}`))) return true
    return [...relative].some((n) => {
      const parts = n.split('.')
      return parts.some((_, i) => endsWith(pkg, parts.slice(0, i + 1).join('.')))
    })
  }
  const stem = stemOf(path)
  const dotted = path.slice(0, -3).replace(/\//g, '.')
  for (const n of relative) if (endsWith(dotted, n)) return true
  for (const n of modules) {
    if (n === stem || n === dotted) return true
    if (n.endsWith(`.${stem}`) || n.endsWith(`.${dotted}`)) return true
  }
  /*
   * A member is often a function, not a module: only the module's own path
   * counts (`from scripts import case_cian`), never a bare name at the end of
   * someone else's (`from matplotlib.pyplot import plot` and a local plot.py).
   */
  for (const n of members) {
    if (n === dotted || (dotted.includes('.') && n.endsWith(`.${dotted}`))) return true
  }
  return false
}

/**
 * Whether a notebook's text refers to this file.
 *
 * By file name anywhere a path could end (`pd.read_csv('data/train.csv')`
 * mentions `train.csv`), by module for Python helpers (`from utils import`,
 * `from scripts import case_cian`), and by a folder written as one
 * (`os.listdir('data/')` mentions every file under `data/`).
 */
export function mentioned(path: string, text: string): boolean {
  const base = baseOf(path)
  if (
    text.includes(base) &&
    new RegExp(`(^|[^\\w.-])${escape(base)}(?![\\w-]|\\.\\w)`, 'mu').test(text)
  ) {
    return true
  }
  if (imported(path, text)) return true
  const segments = path.split('/')
  for (let depth = segments.length - 1; depth > 0; depth--) {
    const folder = segments.slice(0, depth).join('/')
    if (!text.includes(`${folder}/`)) continue
    const written = new RegExp(`(^|[^\\w.-])${escape(folder)}/(?=["'\`\\s)\\]},;]|$)`, 'mu')
    if (written.test(text)) return true
  }
  return false
}

/** Calls that take a folder by its bare name: `Path('data')`, `os.listdir('data')`. */
const FOLDER_CALLS = 'Path|listdir|scandir|walk|join|chdir|glob|iglob|rglob|exists|isdir|makedirs'

/**
 * Whether a text uses a top-level folder of the room: mentions a file in it
 * (see `mentioned`), reads it (`glob('data/*.csv')`, `Path('data')`,
 * `f'data/{name}.csv'`) or imports it as a package (`import scripts`).
 *
 * `paths` are the room paths of the files inside.
 */
export function folderMentioned(folder: string, paths: readonly string[], text: string): boolean {
  const name = folder.replace(/\/+$/, '')
  if (!name) return false
  if (paths.some((path) => mentioned(path, text))) return true
  if (text.includes(name)) {
    const quoted = escape(name)
    if (new RegExp(`["'\`](?:\\./)?${quoted}/`, 'u').test(text)) return true
    const called = new RegExp(`(?:${FOLDER_CALLS})\\(\\s*[rfb]?["'](?:\\./)?${quoted}/?["']`, 'u')
    if (called.test(text)) return true
  }
  if (!/^\w+$/.test(name)) return false
  const { modules, members } = importsOf(text)
  const under = (n: string) => n === name || n.startsWith(`${name}.`)
  return [...modules].some(under) || [...members].some(under)
}

export interface DefaultPick {
  picked: boolean
  why: PickReason | null
}

/**
 * Whether a notebook goes out by default.
 *
 * `owner` is the participant a BookRule records for a student's own notebook
 * (shared/rules.ts · BookRule); `roster` holds the names of everyone in the
 * room except the hosts.
 */
export function notebookPick(input: {
  path: string
  empty: boolean
  owner: string | null
  roster: readonly string[]
}): DefaultPick {
  if (input.empty) return { picked: false, why: 'empty' }
  if (input.owner) return { picked: false, why: 'student' }
  if (rosterMatch(input.path, input.roster)) return { picked: false, why: 'roster' }
  if (isPrivatePath(input.path)) return { picked: false, why: 'private' }
  if (looksLikeAnswers(input.path)) return { picked: false, why: 'answers' }
  return { picked: true, why: null }
}

/**
 * Whether a room file goes out by default.
 *
 * PDFs do (they are the slides); data, code and the rest only when a
 * notebook refers to them and they are small enough to be what the class
 * was given rather than what it produced. Images already drawn in a note
 * travel inside the notebook and are not offered twice.
 */
export function filePick(input: {
  path: string
  kind: MaterialKind
  bytes: number
  usedBy: readonly string[]
  inNotes: boolean
  roster: readonly string[]
  fileLimit: number
}): DefaultPick {
  const { path, kind, bytes } = input
  if (bytes > input.fileLimit) return { picked: false, why: 'too-large' }
  if (isPrivatePath(path)) return { picked: false, why: 'private' }
  if (looksLikeAnswers(path)) return { picked: false, why: 'answers' }
  if (rosterMatch(path, input.roster)) return { picked: false, why: 'roster' }
  if (looksGenerated(path, bytes)) return { picked: false, why: 'generated' }
  if (kind === 'image' && input.inNotes) return { picked: false, why: 'image' }
  if (kind === 'pdf') return { picked: true, why: null }
  const readme = /^readme(\.md|\.txt)?$/i.test(path)
  if (!readme && input.usedBy.length === 0) return { picked: false, why: 'unused' }
  const ceiling = kind === 'code' || kind === 'text' ? PICK_TEXT_BYTES : PICK_DATA_BYTES
  if (bytes > ceiling) return { picked: false, why: 'too-large' }
  return { picked: true, why: null }
}

/**
 * Why a file inside a folder stays in the room when the folder goes out, or
 * `null` when it goes with it.
 *
 * The same rules as for a root file, minus the ones about being needed: a
 * folder is ticked as a whole, so a dataset nobody reads by name still goes,
 * and a picture drawn in a note goes too (the archive needs it, beside the
 * notebook). What stays: drafts on «_» (any segment, but not `__init__.py`),
 * answers and student names (by any segment: `scripts/solutions/x.py`,
 * `hw/zuev_akim/model.py`, since a folder per student is how homework is
 * collected), what runs produced, anything over the upload limit, and what
 * the checks cannot look into: a file named like a key, and a file of no
 * known data or picture kind that cannot be read as text. A root file like
 * that goes out only when a notebook names it and the teacher sees it
 * ticked; inside a folder it would go out unseen, at every refresh.
 *
 * Only 'too-large' is final; the rest are suggestions the teacher can
 * overrule file by file (PickedFile · include, exclude).
 */
export function folderEntryWhy(input: {
  path: string
  bytes: number
  roster: readonly string[]
  fileLimit: number
}): PickReason | null {
  const { path, bytes } = input
  if (bytes > input.fileLimit) return 'too-large'
  if (isPrivatePath(path)) return 'private'
  const segments = path.split('/')
  if (segments.some((segment) => looksLikeAnswers(segment))) return 'answers'
  if (segments.some((segment) => rosterMatch(segment, input.roster))) return 'roster'
  if (looksGenerated(path, bytes)) return 'generated'
  if (looksSecret(path)) return 'secret'
  const kind = materialKind(path)
  if (kind !== 'data' && kind !== 'image' && kind !== 'pdf' && !scannable(path, bytes)) {
    return 'unchecked'
  }
  return null
}

/** The teacher's word on single files of a picked folder (PickedFile · include, exclude). */
export interface FolderChoice {
  include?: ReadonlySet<string>
  exclude?: ReadonlySet<string>
}

/**
 * Whether a file inside a folder goes out with it: by the rules (`why`),
 * unless the teacher said otherwise for that file. A file over the upload
 * limit never does: the build does not read past it.
 */
export function entryGoes(
  entry: { path: string; why: PickReason | null },
  choice: FolderChoice | null,
): boolean {
  if (entry.why === 'too-large') return false
  if (entry.why === null) return !(choice?.exclude?.has(entry.path) ?? false)
  return choice?.include?.has(entry.path) ?? false
}

const PY_EXT = new Set(['py', 'pyi'])
/** A `_` segment that is the teacher's, not Python's dunder (see PRIVATE_RE). */
const isDraftSegment = (segment: string) =>
  segment.startsWith('_') && !/^__[^/]*?__(\.[^/]*)?$/.test(segment)

/**
 * The `_` modules of a package that the code going out imports.
 *
 * «_» is the teacher's mark for "not for students", and it is also Python's
 * for "internal to the package": `scripts/eda_tools.py` doing `from ._utils
 * import plot` needs `scripts/_utils.py`, or `from scripts import eda_tools`
 * fails after unzipping, for the same reason `__init__.py` is never private.
 * So a `.py` whose only drafts-mark is that of a module (or a subpackage) of
 * a package, i.e. whose folder has an `__init__.py`, goes out when something
 * going out imports it: a module of the folder that goes out, or one of the
 * `readers` (the texts of the notebooks going out). An `_scratch.py` nobody
 * imports stays the teacher's draft.
 */
export function neededModules(
  entries: readonly { path: string; why: PickReason | null }[],
  textOf: (path: string) => string | null,
  readers: Iterable<string>,
): Set<string> {
  const needed = new Set<string>()
  const packages = new Set(
    entries.filter((e) => baseOf(e.path) === '__init__.py').map((e) => parentOf(e.path)),
  )
  if (packages.size === 0) return needed
  const inPackage = (path: string): boolean => {
    const segments = path.split('/')
    return segments.every((segment, i) => {
      if (!isDraftSegment(segment)) return true
      const parent = segments.slice(0, i).join('/')
      if (!parent || !packages.has(parent)) return false
      // A `_` folder counts only as a subpackage, with its own __init__.py.
      return i === segments.length - 1 || packages.has(segments.slice(0, i + 1).join('/'))
    })
  }
  const candidates = entries.filter(
    (e) => e.why === 'private' && PY_EXT.has(extOf(e.path)) && inPackage(e.path),
  )
  if (candidates.length === 0) return needed
  const texts = [...readers]
  for (const entry of entries) {
    if (entry.why !== null || !PY_EXT.has(extOf(entry.path))) continue
    const text = textOf(entry.path)
    if (text !== null) texts.push(text)
  }
  // A module brought back may import another `_` one: until nothing more is needed.
  for (let grew = true; grew; ) {
    grew = false
    for (const entry of candidates) {
      if (needed.has(entry.path) || !texts.some((text) => imported(entry.path, text))) continue
      needed.add(entry.path)
      grew = true
      const text = textOf(entry.path)
      if (text !== null) texts.push(text)
    }
  }
  return needed
}

/**
 * Whether a top-level folder goes out by default.
 *
 * When something on the page uses it (a notebook reads a file in it or
 * imports it, or code going out does), or when it holds pictures the notes
 * draw: `assets/` has to sit next to the notebook for the archive to show
 * them. Otherwise «не используется», like a root file. The folder's own name
 * can rule it out first: `_drafts/`, `solutions/`, `outputs/`.
 */
export function folderPick(input: {
  /** 'data/' or 'data'. */
  path: string
  /** Files that would go out in it, and their bytes. */
  files: number
  bytes: number
  usedBy: readonly string[]
  inNotes: readonly string[]
  roster: readonly string[]
  pageLimit: number
}): DefaultPick {
  const name = input.path.replace(/\/+$/, '')
  if (isPrivatePath(name)) return { picked: false, why: 'private' }
  if (looksLikeAnswers(name)) return { picked: false, why: 'answers' }
  if (rosterMatch(name, input.roster)) return { picked: false, why: 'roster' }
  if (GENERATED_DIRS.has(name.toLowerCase())) return { picked: false, why: 'generated' }
  if (input.files === 0) return { picked: false, why: 'empty' }
  if (input.files > MAX_FOLDER_FILES) return { picked: false, why: 'too-many' }
  if (input.bytes > input.pageLimit) return { picked: false, why: 'too-large' }
  if (input.usedBy.length === 0 && input.inNotes.length === 0) {
    return { picked: false, why: 'unused' }
  }
  return { picked: true, why: null }
}
