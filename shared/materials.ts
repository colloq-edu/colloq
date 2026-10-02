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
import { baseOf, extOf } from './paths.js'
import {
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

/** What a material is, by its file name. */
export function materialKind(path: string): MaterialKind {
  const ext = extOf(path)
  if (ext === 'ipynb') return 'notebook'
  if (ext === 'pdf') return 'pdf'
  if (DATA_EXT.has(ext)) return 'data'
  if (CODE_EXT.has(ext)) return 'code'
  if (TEXT_EXT.has(ext)) return 'text'
  if (IMAGE_EXT.has(ext)) return 'image'
  return 'file'
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
  // suggestSlug's rules without its three-letter minimum: `02.ipynb` keeps its digits.
  const slug = transliterate(stemOf(path)).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
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
}

function roleOfMaterial(m: Named): MaterialRole {
  return roleOf(m.name) ?? (m.path ? roleOf(stemOf(m.path)) : null)
}

export function tagOf(m: Named): MaterialTag {
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
  const present = new Set(materials.map(tagOf))
  return MATERIAL_TAGS.filter((tag) => present.has(tag))
}

/**
 * The default page order: Лекция, Семинар, other notebooks, Домашнее
 * задание, then PDFs, data, code and the rest. Sort by it stably, so that
 * materials of one rank keep the order they came in.
 */
export function materialRank(m: Named): number {
  if (m.kind === 'notebook') {
    const role = roleOfMaterial(m)
    return role === 'lecture' ? 0 : role === 'seminar' ? 1 : role === 'homework' ? 3 : 2
  }
  if (m.kind === 'pdf') return 4
  if (m.kind === 'data') return 5
  if (m.kind === 'code') return 6
  return 7
}

/* ----------------------------------------------------------- default picks */

/** A path segment starting with `_`: the teacher's own convention for "not for students". */
export const PRIVATE_RE = /(^|\/)_/

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

/**
 * Whether a notebook's text refers to this file.
 *
 * By file name anywhere a path could end (`pd.read_csv('data/train.csv')`
 * mentions `train.csv`), by module for Python helpers (`from utils import`),
 * and by a folder written as one (`os.listdir('data/')` mentions every file
 * under `data/`).
 */
export function mentioned(path: string, text: string): boolean {
  const base = baseOf(path)
  if (new RegExp(`(^|[^\\w.-])${escape(base)}(?![\\w-]|\\.\\w)`, 'mu').test(text)) return true
  if (extOf(path) === 'py') {
    const module = path.slice(0, -3).replace(/\//g, '.')
    const stem = escape(stemOf(path))
    const dotted = escape(module)
    const name = `(?:[\\w.]+\\.)?(?:${stem}|${dotted})`
    const imports = new RegExp(`(^|\\n)\\s*(from\\s+${name}\\s+import|import\\s+${name}\\b)`)
    if (imports.test(text)) return true
  }
  const segments = path.split('/')
  for (let depth = segments.length - 1; depth > 0; depth--) {
    const folder = escape(segments.slice(0, depth).join('/'))
    if (new RegExp(`(^|[^\\w.-])${folder}/(?=["'\`\\s)\\]},;]|$)`, 'mu').test(text)) return true
  }
  return false
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
