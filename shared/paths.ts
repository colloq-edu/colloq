import { tr } from './i18n.js'
/**
 * Paths inside the seminar folder — one set of rules for the browser and the
 * server.
 *
 * Until now the folder was flat: the name check on the server rejected
 * anything with a separator, and that was enough right up to the day a room
 * needed `src/model.py`. The separator is allowed — which means everything it
 * brings along has to be called by name: `..`, an absolute path, an empty
 * segment, `.` in the middle, a depth at which the tree no longer fits in the
 * panel, and a length at which the file system refuses by itself.
 *
 * The module is shared because the check is needed in two places and must be
 * one. The server refuses — that is the boundary. The browser refuses
 * earlier, so that a person sees "you can't do that" in the input field
 * rather than after a round trip over the network. Once apart, these two
 * checks give the worst possible kind of error: the panel is sure the name is
 * fine, the server silently does not accept it.
 *
 * It does not fix or rename a single name: a name is either fine or rejected
 * whole. A quietly corrected name is a file the person later will not find
 * where they put it.
 *
 * Separators are another matter, and this is the only exception, named out
 * loud: `a//b` and `data/` are brought to the canonical form
 * (`normalizePath`). No segment changes because of it — only the spelling of
 * the path changes, and in the protocol and in keys it travels in one form.
 * Letting two spellings of the same path roam the code is worse:
 * `parentOf('data/')` is `data`, and the tree would get a folder inside
 * itself.
 */

/** Segments deep. Eight is `a/b/c/d/e/f/g/file`, and the tree is still readable. */
export const MAX_DEPTH = 8
/** Length of one name. Beyond it, file systems themselves start to refuse. */
export const MAX_SEGMENT = 120
export const MAX_SEGMENT_BYTES = 255
const pathEncoder = new TextEncoder()
export const segmentBytes = (name: string): number => pathEncoder.encode(name).length
/** Length of the whole path. Headroom under ext4's 255 and macOS's 1024, root included. */
export const MAX_PATH = 400

/*
 * A control character in a name is legal in POSIX and harmful everywhere
 * else: a line feed splits a list line in two, a carriage return hides the
 * tail of the name in the terminal, and neither survives `pd.read_csv`. The
 * same argument as for participants' names.
 */
// eslint-disable-next-line no-control-regex -- control characters are the very subject here
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Whether one name — of a file or a folder — will do.
 *
 * A leading dot is rejected, and that is not about security but about
 * honesty: hidden files are not shown in the tree, and accepting `.env` and
 * then never showing it is worse than saying "no" right away. The same rule
 * drops `.ipynb_checkpoints` and `.git`, which no person creates, from the
 * list.
 */
export function safeSegment(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (name.length > MAX_SEGMENT || segmentBytes(name) > MAX_SEGMENT_BYTES) return false
  if (name.startsWith('.')) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (CONTROL.test(name)) return false
  // A trailing space — a name that is impossible to type and hard to notice.
  if (name !== name.trim()) return false
  return true
}

/**
 * Bring a path to canonical form or reject it.
 *
 * Returns the path without a leading or trailing slash, with single
 * separators — the form in which paths travel through the protocol and sit in
 * keys. The root of the seminar folder is the empty string; it is allowed as
 * a PARENT (create a file in the root) but not as a target, which is why
 * `normalizePath('')` returns an empty string rather than null, and it should
 * be called where the root makes sense.
 *
 * What gets canonicalized is named here in full, so that a "small fix" to a
 * name never cites this line one day: EMPTY SEGMENTS. `a//b` is `a/b`,
 * `data/` is `data`. Nothing else: no segment is corrected, trimmed or
 * renamed — if one does not fit, the whole path is rejected (`safeSegment`).
 * The difference between these two things is the whole rule of the module:
 * the spelling of a path says nothing about where the file will end up, and
 * a name does.
 */
export function normalizePath(raw: string): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length > MAX_PATH) return null
  /*
   * An absolute path is rejected, not trimmed down to a relative one.
   *
   * Trimming would be tempting — `/etc/passwd` would turn into an `etc`
   * folder inside the seminar and escape nowhere — but that is exactly the
   * quiet name correction this module does nowhere: a person who typed
   * `/data/train.csv` meant a file on the machine, and would have got a new
   * folder with nothing in it.
   */
  if (raw.startsWith('/') || raw.startsWith('\\')) return null
  const parts = raw.split('/').filter((part) => part.length > 0)
  if (parts.length === 0) return ''
  if (parts.length > MAX_DEPTH) return null
  for (const part of parts) if (!safeSegment(part)) return null
  return parts.join('/')
}

/** The path of the folder `path` lies in. The root is the empty string. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

/** The name without folders. */
export function baseOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? path : path.slice(at + 1)
}

/** The extension in lower case, without the dot. A file without a dot gets the empty string. */
export function extOf(path: string): string {
  const base = baseOf(path)
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}

/** Whether `path` lies inside the folder `dir` (or is that folder itself). */
export function isInside(path: string, dir: string): boolean {
  if (dir === '') return true
  return path === dir || path.startsWith(dir + '/')
}

/**
 * Join a folder and a name. Neither is checked here — the result goes through
 * `normalizePath` anyway wherever it is used.
 */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/**
 * Why a name will not do — as a phrase a person can act on.
 *
 * `safeSegment` answers "yes" or "no", and that is enough for the server and
 * for nobody else: "invalid name" in the middle of a class says neither which
 * name nor what is wrong with it.
 */
export function whySegmentRefused(name: string): string {
  const shown = name.slice(0, 60) || tr("server.empty.9a3a4f")
  if (!name) return tr("server.theNameCannotBeEmpty.fc2696")
  if (name === '.' || name === '..') return tr("server.theNamesAndAreReservedChooseAnother.d0854b")
  if (name.includes('/') || name.includes('\\')) {
    return tr("server.containsASlashUseNewFolderTo.b86a22", { p0: shown })
  }
  if (CONTROL.test(name)) return tr("server.containsUnsupportedCharacters.7b05cf", { p0: shown })
  if (name.startsWith('.')) {
    return tr("server.startsWithADotTheFilesPanel.864c22", { p0: shown })
  }
  if (name !== name.trim()) return tr("server.startsOrEndsWithASpaceRemove.32f39c", { p0: shown })
  if (name.length > MAX_SEGMENT)
    return tr("server.theNameContainsCharactersShortenItTo.b0c9e9", { p0: name.length, p1: MAX_SEGMENT })
  if (segmentBytes(name) > MAX_SEGMENT_BYTES) return tr("common.fileNameBytes", {count: MAX_SEGMENT_BYTES})
  return tr("server.cannotBeUsedAsAName.67c58f", { p0: shown })
}

/* ------------------------------------------------------------------ kind */

/**
 * What a file will turn out to be on screen.
 *
 * `text` opens in the editor. `notebook` is a notebook, and the editor does
 * not touch it: the room has one notebook, and opening a second one as JSON
 * would mean inviting people to edit it by hand. `pdf` and `image` are for
 * viewing. `binary` is download-only.
 *
 * A list of extensions, not guessing by content: guessing is wrong exactly on
 * the files a student has just created and not yet filled.
 */
export type FileKind = 'text' | 'notebook' | 'pdf' | 'image' | 'binary'

const TEXT_EXT = new Set([
  'py',
  'pyi',
  'txt',
  'md',
  'markdown',
  'rst',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'sh',
  'bash',
  'zsh',
  'sql',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'css',
  'scss',
  'html',
  'htm',
  'xml',
  'svg',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'java',
  'go',
  'rs',
  'rb',
  'lua',
  'r',
  'jl',
  'tex',
  'bib',
  'env',
  'gitignore',
  'dockerfile',
  'log',
])

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'])

/** Files without an extension that are text all the same. */
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'readme', 'license', 'requirements'])

export function kindOf(path: string): FileKind {
  const ext = extOf(path)
  if (ext === 'ipynb') return 'notebook'
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (TEXT_EXT.has(ext)) return 'text'
  if (!ext && TEXT_NAMES.has(baseOf(path).toLowerCase())) return 'text'
  return 'binary'
}

/**
 * What runs the file — or nothing.
 *
 * Exactly two ways, and both are already in the room: `python` and the
 * container's shell. Nothing third should be added here until a third
 * language appears in the image — a "Run" button that calls a nonexistent
 * interpreter behaves like a breakage.
 */
export function runnerFor(path: string): 'python' | 'shell' | null {
  const ext = extOf(path)
  if (ext === 'py') return 'python'
  if (ext === 'sh' || ext === 'bash') return 'shell'
  return null
}

/**
 * The language for highlighting. A name from the CodeMirror set the editor
 * loads.
 *
 * `null` means no highlighting, and that is fine: .csv and .log read as text,
 * and a grammar stretched over the wrong language colors worse than no color
 * at all.
 */
export type Highlight = 'python' | 'markdown' | 'json' | 'yaml' | 'javascript' | 'css' | 'html'

export function highlightFor(path: string): Highlight | null {
  const ext = extOf(path)
  if (ext === 'py' || ext === 'pyi') return 'python'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'json' || ext === 'jsonl' || ext === 'ipynb') return 'json'
  if (ext === 'yaml' || ext === 'yml') return 'yaml'
  if (
    ext === 'js' ||
    ext === 'mjs' ||
    ext === 'cjs' ||
    ext === 'ts' ||
    ext === 'tsx' ||
    ext === 'jsx'
  ) {
    return 'javascript'
  }
  if (ext === 'css' || ext === 'scss') return 'css'
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg') return 'html'
  return null
}
