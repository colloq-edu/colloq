import { tr } from '@shared/i18n'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createAnchoredFilesystem } from './secure-files.js'
import path from 'node:path'
import { config } from './config.js'
import type { FileEntry, FilesDelta } from '@shared/protocol'
import { MAX_DEPTH, MAX_PATH, MAX_SEGMENT, MAX_SEGMENT_BYTES, segmentBytes, baseOf, kindOf, normalizePath, parentOf } from '@shared/paths'

export const workspaceFs = createAnchoredFilesystem(config.workspaceDir, {
  allowUnsafeDevelopment: process.env.NODE_ENV !== 'production' &&
    (process.env.NODE_ENV === 'test' || process.env.COLLOQ_UNSAFE_DEV_FILES === '1'),
})

/**
 * Each session gets a directory under the shared /workspace volume. The kernel
 * container mounts the same volume, so `open('data.csv')` inside a cell and the
 * Files panel in the browser look at the same bytes.
 */
export function sessionDir(sessionId: string): string {
  const dir = path.join(config.workspaceDir, sessionId)
  const made = !workspaceFs.existsSync(dir)
  workspaceFs.mkdirSync(dir, { recursive: true })
  /*
   * Permissions are set explicitly rather than left to the process umask.
   *
   * Two parties write to the folder: the server and the room's kernel — and
   * those are different users when the server runs on the host as root and
   * the kernel runs inside a container as runner. With umask 0022 the folder
   * comes out 0755, and the very first `open('a.txt','w')` in a cell fails
   * with PermissionError — on a green screen, without a single word about the
   * reason. 2775: both can write, and setgid keeps the group on everything
   * created inside, so the permission is not lost at the first nested folder.
   *
   * Only when we create it: the permissions of a folder that already exists
   * are not ours, and on Windows the mode means nothing anyway.
   */
  if (made && process.platform !== 'win32') {
    try {
      workspaceFs.chmodSync(dir, 0o2775)
    } catch {
      // Not our folder — so the permissions are not ours either. The room's
      // work does not depend on it: if writing is impossible, the first write
      // will say so.
    }
  }
  return dir
}

/** Kernel-side path (the kernel container mounts the volume at /workspace too). */
export function kernelCwd(sessionId: string): string {
  return `/workspace/${sessionId}`
}

/**
 * Every temporary name a room ever has — under one rule.
 *
 * Two things write alongside and rename: the upload (`routes/files.ts`,
 * `.<name>.uploading-<hex>`) and the editor's autosave (`writeText` below,
 * `.<name>.saving-<pid>-<time>`). The sweeper knew only the first name,
 * although it promised to remove everything a crash in the middle of a write
 * left behind. Meanwhile the second one piles up by itself: the editor saves
 * every few seconds, and a process crash leaves a megabyte and a half that is
 * not in the tree (the name starts with a dot), cannot be deleted from the
 * panel — and is counted by `sessionBytes`, that is, it eats into the room's
 * ceiling until someone cleans it up by hand.
 *
 * The tail after "what we are doing" is the unique part, hexadecimal or
 * `<pid>-<time>`; six characters at least, so that the rule does not catch a
 * file a person named `.notes.saving-1`.
 */
const TEMP_FILE = /^\..+\.(?:uploading|saving)-[0-9a-z][0-9a-z-]{5,}$/i

/**
 * Clear away temp files an interrupted write left behind.
 *
 * An upload — and an editor autosave — writes beside its target and renames on
 * success, and every failure path removes its own temp: every path except the
 * process dying mid-write. What that leaves is a dotfile, so the room never
 * sees it and nobody can remove it from the panel either. Swept on the next
 * upload into the same seminar, which is the moment somebody is thinking about
 * that folder anyway.
 */
export function sweepStaleUploads(sessionId: string, olderThanMs = 60 * 60 * 1000): void {
  const root = sessionDir(sessionId)
  const cutoff = Date.now() - olderThanMs
  const walk = (rel: string, depth: number): void => {
    let names: string[]
    try {
      names = workspaceFs.readdirSync(path.join(root, rel))
    } catch {
      return
    }
    for (const name of names) {
      const here = rel ? `${rel}/${name}` : name
      const full = path.join(root, here)
      if (TEMP_FILE.test(name)) {
        try {
          if (workspaceFs.statSync(full).mtimeMs < cutoff) {
            workspaceFs.rmSync(full, { force: true })
            // Temporary names are not in the tree anyway, but the walk counted
            // them towards the entry ceiling: once removed, the count is stale.
            forgetTree(sessionId)
          }
        } catch {
          /* somebody else got there first */
        }
        continue
      }
      // Folders too: an upload now lands in the folder it was brought to, and
      // an unfinished file stays there as well. Hidden ones are skipped —
      // except the very temporary ones handled above.
      if (name.startsWith('.') || depth + 1 >= MAX_DEPTH) continue
      try {
        if (workspaceFs.lstatSync(full).isDirectory()) walk(here, depth + 1)
      } catch {
        /* gone */
      }
    }
  }
  walk('', 0)
}

/**
 * The same across all rooms — once at startup.
 *
 * The sweep hung on the next file upload into the same room, and for uploads
 * that was enough: an unfinished one appears where someone is busy with the
 * folder anyway. The editor's autosave works differently — it runs by itself,
 * every few seconds, in a room where nothing may ever be uploaded. The
 * leftover from a crashed process would lie there until cleaned by hand,
 * invisible in the tree and counted against the room's ceiling.
 *
 * Startup is the right moment: a temporary file survives exactly the crash
 * after which we start. The hour of grace stays: rooms on a shared volume are
 * rare, but a neighbor's unfinished file is not ours to remove.
 */
export function sweepAllStaleUploads(olderThanMs?: number): void {
  let rooms: string[]
  try {
    rooms = workspaceFs.readdirSync(config.workspaceDir)
  } catch {
    return // no volume yet — so nothing to sweep
  }
  for (const room of rooms) {
    try {
      if (!workspaceFs.lstatSync(path.join(config.workspaceDir, room)).isDirectory()) continue
    } catch {
      continue
    }
    sweepStaleUploads(room, olderThanMs)
  }
}

export function resolveInSession(sessionId: string, name: string): string | null {
  const rel = normalizePath(name)
  if (rel === null || rel === '') return null
  const dir = sessionDir(sessionId)
  const full = path.join(dir, rel)
  /*
   * The name check above is about the REQUEST: it stops `../` from leaving the
   * folder. This one is about the ENTRY: it stops a symlink inside the folder
   * from pointing out of it. They are different holes and only the first was
   * closed. The kernel container runs any Python a student types on the same
   * mounted workspace, so `os.symlink('/data/session-secret', 'key.txt')` put
   * a file in the room's list that the download route then streamed — the
   * secret every token in the product is signed with.
   */
  let realDir: string
  try {
    realDir = workspaceFs.realpathSync(dir)
  } catch {
    return null
  }
  return contained(full, realDir) ? full : null
}

/**
 * Whether a path lies inside the seminar folder — allowing for the fact that
 * it may not exist yet.
 *
 * A nonexistent path used to be let through as is, and on a flat folder that
 * was right: a single segment has nothing to forge. With folders it no longer
 * is: a link could sit on an intermediate folder, and `realpath` on a
 * nonexistent file throws without saying anything about its parents. So we
 * climb to the nearest existing ancestor: if IT is inside, then everything
 * that does not exist yet under it will be inside too — a link has nowhere to
 * come from where there is nothing.
 */
function contained(full: string, realDir: string): boolean {
  let probe = full
  for (let up = 0; up <= MAX_DEPTH + 2; up++) {
    try {
      const real = workspaceFs.realpathSync(probe)
      return real === realDir || real.startsWith(realDir + path.sep)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      const parent = path.dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
  return false
}

/**
 * How many tree rows are given to the room.
 *
 * A ceiling, not a page: the panel draws the tree whole, and `pip install` in
 * a cell creates thousands of files in the seminar folder in one go. Two
 * thousand rows is already more than anyone will read, and less than what
 * rendering would choke on.
 */
const MAX_ENTRIES = 2000

/** The room's tree — and a flag saying it hit the ceiling. */
export interface FileTree {
  files: FileEntry[]
  /**
   * The list is incomplete: some folders did not fit under the ceiling and
   * stayed unexpanded.
   *
   * A flag, not silence: a truncated list is not "the room has this many
   * files", and everything that detects losses by it (notebooks, the board,
   * tabs) must know the difference, otherwise it will delete something alive.
   */
  truncated: boolean
}

/**
 * How the new tree differs from the previous one.
 *
 * Computed from two walks — the one the room has already seen and a fresh
 * one — and it travels instead of the whole list (shared/protocol.ts ·
 * FilesDelta). The cost of a change stops depending on the size of the
 * folder: a created file is one entry in the frame, not two thousand.
 *
 * `at` on a new entry is its place in the FINISHED list. This works because
 * the tree's order is uniquely determined by its contents (depth-first walk,
 * folders before files, by name): the surviving entries stand relative to
 * each other in the new list exactly as they did in the old one, and
 * inserting in ascending `at` after the removals gives exactly the new list.
 * There is one rule for applying it, it lives in the tab
 * (web/src/lib/files-delta.ts), and it is tested on both.
 */
export function treeDelta(before: readonly FileEntry[], after: readonly FileEntry[]): FilesDelta {
  const was = new Map<string, FileEntry>()
  for (const entry of before) was.set(entry.path, entry)
  const changed: FileEntry[] = []
  const added: { at: number; entry: FileEntry }[] = []
  const kept = new Set<string>()
  after.forEach((entry, at) => {
    const old = was.get(entry.path)
    if (!old) {
      added.push({ at, entry })
      return
    }
    kept.add(entry.path)
    // The name too: a rename inside a folder changes the whole path, but a
    // file moved on disk behind our back may come with the same path and
    // everything else different.
    if (
      old.dir !== entry.dir ||
      old.size !== entry.size ||
      old.modifiedAt !== entry.modifiedAt ||
      old.name !== entry.name
    )
      changed.push(entry)
  })
  const removed: string[] = []
  for (const entry of before) if (!kept.has(entry.path)) removed.push(entry.path)
  return { removed, changed, added }
}

/**
 * The seminar folder as a tree — in the order it is drawn.
 *
 * A flat list, not a nested one: from it it is equally simple to build the
 * tree in the panel and to walk it whole on the server, and it fits into the
 * same `files` message the room already receives. The order is a depth-first
 * walk, folders before files at every level; the client just draws it as is.
 *
 * It is read, though, not depth-first but level by level, and that is no
 * small thing. The first overgrown subfolder (`!unzip` of a dataset,
 * `pip install -t .`) used to eat the whole ceiling, and the ROOT's files —
 * the room's notebook among them — did not make it into the list at all; a
 * notebook missing from the list was considered deleted and was erased for
 * everyone with all its cells. What gets cut must be the deepest, not the
 * topmost, and the cut must be announced out loud.
 */
/**
 * A short memory of the walk — per room.
 *
 * A walk costs a `readdir` plus an `lstat` for each of two thousand entries,
 * and it runs synchronously, in the same loop where the server answers
 * everyone else. The same thing gets asked twice in a row all the time: the
 * broadcast to the room and the answer to whoever pressed go in one tick
 * (`routes/files.ts`), and after a server restart five hundred tabs come back
 * within a second or two and each asks for the tree itself.
 *
 * The window is small on purpose: this is memory for a burst of calls in a
 * row, not a cache. Everything that changes the tree through this module
 * resets the memory by itself (see `forgetTree` further down the file).
 *
 * But not every write goes "through this module", and that cannot be taken
 * on trust. An upload puts the file in place with `rename` (`routes/files.ts`),
 * a cell writes from the container, the editor saves an open file, and so
 * does the notebook projection — nobody there resets the memory, and the tree
 * is asked for right after the write and in the same tick. So the memory
 * answered with a list WITHOUT the file just uploaded — to the very person
 * who uploaded it, and in the answer to their own request. That is why on a
 * hit the memory is not taken at its word but checked against the disk:
 * every folder read has its modification time recorded, and the appearance,
 * disappearance or rename of any entry moves it — one `lstat` per folder
 * against a `readdir` plus an `lstat` for each of two thousand entries.
 *
 * What the check does not catch is an edit of the CONTENTS of an existing
 * file: the folder's time does not move because of it, and the size and date
 * in the list may lag by one window. That is the whole remaining limit on
 * staleness: the tree's composition is always right, and the number next to
 * a name is no older than three hundred milliseconds.
 */
const TREE_MEMO_MS = 300

/** The modification time of every folder the walk read — by absolute path. */
type TreeStamp = { path: string; mtimeMs: number }[]

const treeMemo = new Map<string, { at: number; tree: FileTree; stamp: TreeStamp }>()

/** Whether none of the folders has changed since they were walked. */
function stampHolds(stamp: TreeStamp): boolean {
  for (const dir of stamp) {
    let now: fs.Stats
    try {
      now = workspaceFs.lstatSync(dir.path)
    } catch {
      // The folder was taken away — the tree is certainly not the same. Recompute.
      return false
    }
    if (now.mtimeMs !== dir.mtimeMs) return false
  }
  return true
}

/** Recompute the tree of this room (or of every room) without waiting out the window. */
export function forgetTree(sessionId?: string): void {
  if (sessionId === undefined) treeMemo.clear()
  else treeMemo.delete(sessionId)
}

export function listTree(sessionId: string): FileTree {
  const known = treeMemo.get(sessionId)
  // A copy of the wrapper, not of the list itself: `files` is read but not
  // modified, and copying two thousand entries for that would bring half the
  // cost of the walk back.
  if (known && Date.now() - known.at < TREE_MEMO_MS && stampHolds(known.stamp)) {
    return { files: known.tree.files, truncated: known.tree.truncated }
  }
  const { tree, stamp } = walkTree(sessionId)
  const now = Date.now()
  /*
   * Expired entries are removed right here, on a miss.
   *
   * Otherwise the map would grow by an entry for every room the instance has
   * ever shown — and an entry holds up to two thousand tree rows. There is no
   * reason to set up a timer sweep for this: a miss is exactly the moment
   * when rooms get thought of at all, and next to a folder walk it costs
   * nothing.
   */
  for (const [id, entry] of treeMemo) if (now - entry.at >= TREE_MEMO_MS) treeMemo.delete(id)
  treeMemo.set(sessionId, { at: now, tree, stamp })
  return tree
}

function walkTree(sessionId: string): { tree: FileTree; stamp: TreeStamp } {
  const root = sessionDir(sessionId)
  /** The contents of every folder read — in drawing order. */
  const children = new Map<string, FileEntry[]>()
  const stamp: TreeStamp = []
  let total = 0
  let truncated = false

  const read = (rel: string): FileEntry[] => {
    const dir = rel ? path.join(root, rel) : root
    /*
     * The folder's modification time is taken BEFORE reading, and the order
     * matters here.
     *
     * An entry that slips in between `lstat` and `readdir` gets into the list
     * with the old fingerprint — the check will see the mismatch and
     * recompute once more than needed. The reverse order errs the other way:
     * a list without the new entry but with the new time passes the check,
     * that is, it lies for the whole window.
     */
    let mtimeMs: number | null = null
    try {
      mtimeMs = workspaceFs.lstatSync(dir).mtimeMs
    } catch {
      /* gone — readdir below will see that too */
    }
    let names: string[]
    try {
      names = workspaceFs.readdirSync(dir)
    } catch {
      return []
    }
    // Only folders that were read: an unread one has nothing to be checked
    // against, and its appearance and disappearance show in the parent's time.
    if (mtimeMs !== null) stamp.push({ path: dir, mtimeMs })
    const dirs: FileEntry[] = []
    const files: FileEntry[] = []
    for (const name of names) {
      if (name.startsWith('.') || name === '__pycache__') continue
      const here = rel ? `${rel}/${name}` : name
      let stat: fs.Stats
      try {
        // lstat, not stat: a symlink is not a file of this room, whatever it
        // points at, and listing it as one is how a link to a secret became a
        // download button. A symlinked DIRECTORY is refused by the same line —
        // it is neither isFile nor isDirectory under lstat.
        stat = workspaceFs.lstatSync(path.join(root, here))
      } catch {
        continue /* vanished between readdir and stat; skip */
      }
      if (stat.isDirectory())
        dirs.push({ name, path: here, dir: true, size: 0, modifiedAt: stat.mtimeMs })
      else if (stat.isFile())
        files.push({ name, path: here, dir: false, size: stat.size, modifiedAt: stat.mtimeMs })
    }
    const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name)
    dirs.sort(byName)
    files.sort(byName)
    return [...dirs, ...files]
  }

  let level = ['']
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (total >= MAX_ENTRIES) {
        truncated = true
        break
      }
      const here = read(dir)
      if (here.length > MAX_ENTRIES - total) {
        here.length = MAX_ENTRIES - total
        truncated = true
      }
      total += here.length
      children.set(dir, here)
      for (const entry of here) if (entry.dir) next.push(entry.path)
    }
    level = next
  }

  // The drawing order is assembled from what was read: a folder, then its
  // contents, and so on all the way down.
  const out: FileEntry[] = []
  const emit = (dir: string): void => {
    for (const entry of children.get(dir) ?? []) {
      out.push(entry)
      if (entry.dir) emit(entry.path)
    }
  }
  emit('')
  return { tree: { files: out, truncated }, stamp }
}

/** The same tree, for those who need only the list. */
export function listFiles(sessionId: string): FileEntry[] {
  return listTree(sessionId).files
}

/**
 * How much space the room takes.
 *
 * There was always a limit per file, but not for the room as a whole: fifty
 * megabytes at a time and a hundred rounds give five gigabytes, and the disk
 * on this server is shared with the database, notebook snapshots and
 * environment images. It will run out silently and for everyone at once.
 *
 * Unfinished uploads are counted too: they take up space just the same.
 */
export function sessionBytes(sessionId: string): number {
  const root = sessionDir(sessionId)
  let total = 0
  const walk = (rel: string, depth: number): void => {
    let names: string[]
    try {
      names = workspaceFs.readdirSync(path.join(root, rel))
    } catch {
      return
    }
    for (const name of names) {
      const here = rel ? `${rel}/${name}` : name
      try {
        // lstat: a symbolic link takes its own size, not its target's — and it
        // certainly does not get to charge someone else's gigabyte to the room.
        const stat = workspaceFs.lstatSync(path.join(root, here))
        if (stat.isFile()) total += stat.size
        else if (stat.isDirectory() && depth + 1 < MAX_DEPTH) walk(here, depth + 1)
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  walk('', 0)
  return total
}

/* ---------------------------------------------------------- tree edits */

/**
 * How an attempt to change something in the tree ended.
 *
 * A string, not an exception: every outcome has its own phrase in the
 * interface, and all of them are the ordinary course of things, not a
 * breakage. `busy` is about what no check can see in advance: a file the
 * kernel is writing at this very moment.
 *
 * `too-deep` and `not-a-folder` appeared together with drag and drop: before
 * it the tree only renamed in place, and both cases were unreachable. Both
 * used to answer `busy`, that is, "try again in a second" — advice that does
 * not turn a file lying where a folder should be into a folder.
 */
export type TreeResult =
  | 'ok'
  | 'bad-name'
  | 'exists'
  | 'missing'
  | 'busy'
  /** The moving folder's contents would go beyond the depth that can be addressed. */
  | 'too-deep'
  /** The same, past the path length: after the move there would be no way to address it. */
  | 'too-long'
  /** Nowhere to put it: where the target folder should be, there is a file. */
  | 'not-a-folder'

/**
 * A file system refusal — as a word with the truth behind it.
 *
 * Every error used to become `busy`, and `busy` promises "in a second". A
 * person will wait a second both for a file lying where a folder should be
 * and for a non-empty directory where the target should be: neither goes away
 * by waiting, and the advice spends time only on proving that the advice was
 * bad.
 */
function whyFailed(err: unknown): TreeResult {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return 'exists'
  if (code === 'ENOTDIR' || code === 'EISDIR') return 'not-a-folder'
  if (code === 'ENOENT') return 'missing'
  if (code === 'ENAMETOOLONG') return 'too-long'
  return 'busy'
}

/** Create a folder. Intermediate folders are created along with it. */
export function makeDir(sessionId: string, rel: string): TreeResult {
  const full = resolveInSession(sessionId, rel)
  if (!full) return 'bad-name'
  if (workspaceFs.existsSync(full)) return 'exists'
  try {
    workspaceFs.mkdirSync(full, { recursive: true })
    forgetTree(sessionId)
    return 'ok'
  } catch (err) {
    return whyFailed(err)
  }
}

/**
 * Create a file. Only a new one: overwriting with emptiness is erasing, and
 * that has its own button with its own rule.
 */
export function makeFile(sessionId: string, rel: string, text = ''): TreeResult {
  const full = resolveInSession(sessionId, rel)
  if (!full) return 'bad-name'
  if (workspaceFs.existsSync(full)) return 'exists'
  try {
    workspaceFs.mkdirSync(path.dirname(full), { recursive: true })
    // 'wx' — refuse rather than overwrite if the file appeared between the check
    // and the write. Two tabs pressing "new file" at once is not made up.
    workspaceFs.writeFileSync(full, text, { flag: 'wx' })
    forgetTree(sessionId)
    return 'ok'
  } catch (err) {
    // By the error code, not "it failed, so the name is taken": "a.py already
    // exists" about a file that is not there sends a person searching the tree
    // for it.
    return whyFailed(err)
  }
}

/**
 * The same entry under a different spelling — that is, a change of the
 * name's case.
 *
 * On a case-insensitive file system (macOS on half of the machines) "Data"
 * and "data" are one folder, and `existsSync(target)` answered "taken" with
 * the source itself: changing the case of a name was impossible altogether,
 * and the phrase explained it as the file colliding with itself. On Linux the
 * same rename always went through — one operation behaved differently on the
 * developer's machine and on the server.
 *
 * Three conditions, and each cuts off its own case. One folder and names that
 * differ only in case — that is about spelling, not a move. Matching inode
 * and device — about the entry really being one: on a file system where case
 * matters, "Data" and "data" lie side by side, and taking them for one would
 * mean moving on top of a live file. `ino === 0` never happens on POSIX and
 * does happen on Windows, where there is nothing to compare — there the
 * answer is "different".
 *
 * A hard link (`os.link` from a cell) deliberately does not qualify: its
 * names are different, and "b.txt already exists" is the truth.
 */
function spelledSame(source: string, target: string): boolean {
  if (path.dirname(source) !== path.dirname(target)) return false
  const was = path.basename(source)
  const now = path.basename(target)
  if (was === now || was.toLowerCase() !== now.toLowerCase()) return false
  try {
    const one = workspaceFs.lstatSync(source)
    const two = workspaceFs.lstatSync(target)
    return one.ino !== 0 && one.ino === two.ino && one.dev === two.dev
  } catch {
    return false
  }
}

/**
 * Whether the contents would go beyond what can be addressed if put here.
 *
 * `normalizePath` checks only the path it was sent: a folder from the seventh
 * level could be put on the sixth, and a folder with long names inside into a
 * folder with a long name. Whatever ended up deeper than the eighth level,
 * `listTree` no longer walks — and does not say so: `truncated` is set only by
 * the number of rows. Whatever ended up longer than four hundred characters
 * gets into the list, but `resolveInSession` does not let such a path
 * through. Both ends look the same: the room gets a list that declares itself
 * complete, while a file in it can be neither opened, nor downloaded, nor
 * removed on its own — and it still takes up space.
 *
 * `levels` is how many levels remain under this entry at the new place,
 * `chars` how many characters. The walk goes deeper exactly until the first
 * violation, so the check costs no more than the answer itself.
 */
function outgrows(full: string, levels: number, chars: number): 'ok' | 'too-deep' | 'too-long' {
  let entries: fs.Dirent[]
  try {
    entries = workspaceFs.readdirSync(full, { withFileTypes: true })
  } catch {
    // Not a folder — the usual case, a file is moving — or it cannot be read.
    return 'ok'
  }
  for (const entry of entries) {
    // Count the same as the tree shows: hidden entries, `__pycache__` and
    // symbolic links do not get into it, and there is no way to address them
    // even now.
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue
    if (!entry.isDirectory() && !entry.isFile()) continue
    if (levels <= 0) return 'too-deep'
    // The separator and the name: exactly what the path grows by at this level.
    const left = chars - 1 - entry.name.length
    if (left < 0) return 'too-long'
    if (entry.isDirectory()) {
      const inside = outgrows(path.join(full, entry.name), levels - 1, left)
      if (inside !== 'ok') return inside
    }
  }
  return 'ok'
}

/**
 * Move a file without the right to replace what already lies under the new
 * name.
 *
 * `rename(2)` silently replaces the target, and the "is it taken" check
 * happened before it: in the window between them a cell manages to finish
 * writing `out.csv` — and the move erases the fresh file without a single
 * word. `link` does not fit into that window: it rejects a taken name by
 * itself, just like the `'wx'` flag in `makeFile` above.
 *
 * `false` means there are no hard links on this file system; the caller does
 * it the old way. A taken name is excluded from this answer: it flies out as
 * an exception, because that is an answer to a person, not a property of the
 * disk.
 */
function linked(source: string, target: string): boolean {
  try {
    workspaceFs.linkSync(source, target)
  } catch (err) {
    if (whyFailed(err) === 'exists') throw err
    return false
  }
  workspaceFs.unlinkSync(source)
  return true
}

/**
 * Rename or move. One operation, because on disk they are one and the same,
 * and in the tree a rename is a drag in place.
 *
 * The order of the checks is load-bearing, and it is not the one it used to
 * be. First "is it the same path", "not into itself" and "not the same entry
 * under a different spelling", and only then "is the name taken":
 * `existsSync`, which stood first, answered `exists` to a move to nowhere —
 * that is, explained to a person that the file collided with itself — and it
 * also forbade changing the case of a name.
 */
export function movePath(sessionId: string, from: string, to: string): TreeResult {
  const landing = normalizePath(to)
  const source = resolveInSession(sessionId, from)
  const target = resolveInSession(sessionId, to)
  if (!source || !target || !landing) return 'bad-name'
  if (!workspaceFs.existsSync(source)) return 'missing'
  // A move to nowhere: it already lies where it is asked to be put. There is
  // nothing to refuse — while `existsSync` below answered this with "already
  // exists", that is, found a collision of the file with itself. The room does
  // not even get here: `tree:move` answers such a gesture with silence,
  // because nothing happened.
  if (target === source) return 'ok'
  /*
   * A folder cannot be put inside itself. `rename` answers EINVAL on such a
   * pair, and that would be a clear refusal — but on file systems where it
   * answers with success, the subtree leaves the tree forever.
   *
   * The words for this are said by `control.ts`: `bad-name` here is a
   * boundary, not an explanation, and `whySegmentRefused` would complain
   * about a name that has nothing to do with it.
   */
  if (target.startsWith(source + path.sep)) return 'bad-name'
  const same = spelledSame(source, target)
  if (!same && workspaceFs.existsSync(target)) return 'exists'
  const inside = outgrows(source, MAX_DEPTH - landing.split('/').length, MAX_PATH - landing.length)
  if (inside !== 'ok') return inside
  try {
    workspaceFs.mkdirSync(path.dirname(target), { recursive: true })
    /*
     * A change of spelling and a folder go by `rename`: for the first, `link`
     * would answer "taken" with the entry itself, and there are no hard links
     * to directories at all. `rename` will not replace a non-empty directory
     * — it answers ENOTEMPTY; it will replace an empty one, and there is
     * nothing to lose in it.
     */
    if (same || workspaceFs.lstatSync(source).isDirectory()) workspaceFs.renameSync(source, target)
    else if (!linked(source, target)) workspaceFs.renameSync(source, target)
    forgetTree(sessionId)
    return 'ok'
  } catch (err) {
    return whyFailed(err)
  }
}

/**
 * Remove a file or a folder.
 *
 * A folder is removed with everything in it, and that is deliberate: an empty
 * folder that cannot be removed until everything inside is removed one by one
 * is work the panel shifts onto a person instead of a single "are you sure?".
 * Whoever draws the button asks; here it is already being done.
 */
export function deleteFile(sessionId: string, name: string): boolean {
  const full = resolveInSession(sessionId, name)
  if (!full) return false
  try {
    const stat = workspaceFs.lstatSync(full)
    if (stat.isDirectory()) workspaceFs.rmSync(full, { recursive: true, force: true })
    else workspaceFs.unlinkSync(full)
    forgetTree(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * How many bytes a copy moves at a time.
 *
 * Not "read the whole file": the ceiling for one file is fifty megabytes
 * (config.maxUploadBytes), and a buffer of that size in the room's
 * synchronous handler is half a second of pause for the whole instance and a
 * memory peak the neighboring seminar will notice. A quarter of a megabyte is
 * the usual size at which the kernel works in pages anyway.
 */
const COPY_CHUNK = 256 * 1024

/**
 * Copy a file alongside, without touching the original.
 *
 * It is written under a temporary name and moved into place — just like
 * `writeText` above and the upload (routes/files.ts), and for the same
 * reason: the copy appears in the tree whole or not at all. A half-copied CSV
 * is read by pandas without an error, and the loss is discovered from the
 * numbers.
 *
 * A taken name is not replaced: first `link`, which rejects a taken name by
 * itself (the same trick as in `movePath`), and only on a file system without
 * hard links `rename`, before which the name is checked separately. The
 * copy's name is chosen by `freeCopyName`, so it can arrive here taken only
 * in a race — but that race is real: two tabs duplicate one file in the same
 * second.
 *
 * Folders are deliberately not handled here: `openRead` rejects both a folder
 * and a symbolic link, and that is the right answer — the panel must not
 * promise a recursive copy with the room's ceiling at every step.
 */
export function copyFile(sessionId: string, from: string, to: string): TreeResult {
  const source = resolveInSession(sessionId, from)
  const target = resolveInSession(sessionId, to)
  if (!source || !target) return 'bad-name'
  if (source === target) return 'exists'
  if (workspaceFs.existsSync(target)) return 'exists'
  let held: ReturnType<typeof workspaceFs.openRead>
  try {
    held = workspaceFs.openRead(source)
  } catch {
    // The decision was made not by this code but by the OS kernel
    // (secure-files.ts · openRead): a folder, a symbolic link and a vanished
    // path all mean "nothing to copy".
    return 'missing'
  }
  const tmp = path.join(path.dirname(target), `.colloq.saving-${randomUUID()}`)
  let out: number | null = null
  try {
    out = workspaceFs.openSync(tmp, 'wx')
    const chunk = Buffer.allocUnsafe(COPY_CHUNK)
    // By offset, not as a stream: the source descriptor is held for the whole
    // copy, and the position in it is ours — someone else writing to the same
    // file will not shift it under us.
    let at = 0
    for (;;) {
      const read = fs.readSync(held.fd, chunk, 0, chunk.length, at)
      if (read === 0) break
      // writeSync may write less than asked: the rest is written right here,
      // otherwise the copy silently comes out shorter than the original.
      let written = 0
      while (written < read) {
        written += fs.writeSync(out, chunk, written, read - written, at + written)
      }
      at += read
    }
    fs.closeSync(out)
    out = null
    if (!linked(tmp, target)) workspaceFs.renameSync(tmp, target)
    forgetTree(sessionId)
    return 'ok'
  } catch (err) {
    try {
      workspaceFs.rmSync(tmp, { force: true })
    } catch {
      /* the parent was swapped — nothing to remove and no way to remove it */
    }
    return whyFailed(err)
  } finally {
    held.close()
    if (out !== null) {
      try {
        fs.closeSync(out)
      } catch {
        /* already closed */
      }
    }
  }
}

/* --------------------------------------------------------------- contents */

/**
 * The ceiling for text that opens in the editor.
 *
 * A megabyte and a half is about thirty thousand lines: more than a file
 * edited at a seminar ever has, and less than what makes CodeMirror stop and
 * think over every keystroke. A larger file does not open in the editor at
 * all — neither whole nor its beginning: saving a fragment over the whole
 * means losing the tail silently, and showing a beginning that can be neither
 * edited nor saved means promising an editor where there is none. Such a file
 * can still be downloaded and read from a cell.
 *
 * The price is named out loud — and said out loud too: when someone clicks a
 * three-megabyte CSV, the tab does not close silently but explains that the
 * file is too big for the editor. For that the file socket has a third close
 * code, 4413, next to "edit not accepted" and "no such file" (see `TOO_BIG`
 * in collab/files.ts).
 */
export const MAX_TEXT_BYTES = 1_500_000

export interface TextFile {
  text: string
  /** The file is over the ceiling: `text` holds only its beginning, it was not read whole. */
  truncated: boolean
  /** Not text at all — there are zero bytes in it. */
  binary: boolean
  modifiedAt: number
  size: number
}

/**
 * Read a file as text.
 *
 * A zero byte in the first eight kilobytes is the sign everybody goes by: the
 * extension lies (a student named an archive `data.csv`), the contents do
 * not. Opening an archive in the editor means showing garbage and offering to
 * save it.
 */
export function readText(sessionId: string, rel: string, maxBytes = MAX_TEXT_BYTES): TextFile | null {
  const full = resolveInSession(sessionId, rel)
  if (!full) return null
  let stat: fs.Stats
  let held: ReturnType<typeof workspaceFs.openRead>
  try {
    held = workspaceFs.openRead(full)
    stat = fs.fstatSync(held.fd)
  } catch {
    return null
  }
  const truncated = stat.size > maxBytes
  let buf: Buffer
  try {
    buf = Buffer.alloc(Math.min(stat.size, maxBytes))
    const read = fs.readSync(held.fd, buf, 0, buf.length, 0)
    buf = buf.subarray(0, read)
  } catch {
    return null
  } finally {
    held.close()
  }
  const binary = buf.subarray(0, 8192).includes(0)
  return {
    text: binary ? '' : buf.toString('utf8'),
    truncated,
    binary,
    modifiedAt: stat.mtimeMs,
    size: stat.size,
  }
}

/**
 * Read a file as bytes.
 *
 * The twin of `readText` for what is not text: a picture from a problem
 * statement lying in the seminar folder next to the notebook. Publishing
 * needed it — `![diagram](assets/fig01.png)` in a note points to a file, and
 * on the exported page there is no seminar folder any more, so the picture
 * has to be taken along (publish/build.ts · projectNote).
 *
 * The ceiling is a mandatory argument, not a precaution: the file is read
 * WHOLE into memory, and a one-and-a-half-gigabyte `![](data/train.csv.gz)`
 * would bring down the publication build together with the server. Over the
 * ceiling means `null`, that is, "could not", and the caller decides what to
 * show instead.
 */
export function readBytes(sessionId: string, rel: string, maxBytes: number): Buffer | null {
  const full = resolveInSession(sessionId, rel)
  if (!full) return null
  let held: ReturnType<typeof workspaceFs.openRead>
  try {
    held = workspaceFs.openRead(full)
  } catch {
    return null
  }
  try {
    const stat = fs.fstatSync(held.fd)
    if (!stat.isFile() || stat.size > maxBytes) return null
    const buf = Buffer.alloc(stat.size)
    const read = fs.readSync(held.fd, buf, 0, buf.length, 0)
    return buf.subarray(0, read)
  } catch {
    return null
  } finally {
    held.close()
  }
}

/**
 * Write a whole file.
 *
 * Alongside and by rename, not on top: `writeFileSync` first truncates the
 * file to zero and fills it afterwards, so a cell reading this CSV right now
 * manages to read half of it and finish without an error. The same argument
 * is written above the upload in routes/files.ts, and it is equally true for
 * an editor that saves by itself every few seconds.
 */
export function writeText(sessionId: string, rel: string, text: string): boolean {
  const full = resolveInSession(sessionId, rel)
  if (!full) return false
  const tmp = path.join(
    path.dirname(full),
    `.colloq.saving-${randomUUID()}`,
  )
  try {
    workspaceFs.mkdirSync(path.dirname(full), { recursive: true })
    workspaceFs.writeFileSync(tmp, text, { flag: 'wx' })
    workspaceFs.renameSync(tmp, full)
    forgetTree(sessionId)
    return true
  } catch {
    try { workspaceFs.rmSync(tmp, { force: true }) } catch { /* parent was replaced */ }
    return false
  }
}

/** Whether the path exists, and what it is. `null` — there is nothing. */
export function statPath(
  sessionId: string,
  rel: string,
): { dir: boolean; size: number; modifiedAt: number } | null {
  const full = resolveInSession(sessionId, rel)
  if (!full) return null
  try {
    const stat = workspaceFs.lstatSync(full)
    if (!stat.isFile() && !stat.isDirectory()) return null
    return { dir: stat.isDirectory(), size: stat.size, modifiedAt: stat.mtimeMs }
  } catch {
    return null
  }
}

/**
 * A free name next to a taken one: `train.py` -> `train 2.py`.
 *
 * Needed exactly where a refusal would be worse: the oracle creates a file
 * that already exists, and cancelling its whole turn because of a name means
 * losing work. A person who typed the name by hand still gets "taken": they
 * meant exactly that name.
 */
export function freeName(sessionId: string, rel: string): string {
  if (!statPath(sessionId, rel)) return rel
  const dir = parentOf(rel)
  const base = baseOf(rel)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; n < 100; n++) {
    const candidate = `${dir ? dir + '/' : ''}${stem} ${n}${ext}`
    if (!statPath(sessionId, candidate)) return candidate
  }
  return rel
}

/**
 * What to name a copy: `train.py` → `train (копия).py` → `train (копия 2).py`
 * ("копия" is "copy").
 *
 * Not `freeName`, and the difference matters. That one appends a number to
 * the name and is needed where a refusal would be worse than a taken name
 * (the oracle creates a file in the middle of a turn); here a person sees the
 * name, and `train 2.py` next to `train.py` does not say which of them is the
 * copy. The word comes from the dictionary, because a room can be English,
 * and the file name is what the student later types in a cell.
 *
 * The extension stays in its place: `train (копия).py` opens in the editor,
 * `train.py (копия)` no longer does.
 */
export function freeCopyName(sessionId: string, rel: string): string {
  const dir = parentOf(rel)
  const base = baseOf(rel)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  /*
   * A long name is trimmed, and only here — not someone else's name, but the
   * one we compose ourselves. `safeSegment` rejects a segment longer than
   * MAX_SEGMENT outright, and without trimming, duplicating a file with a
   * hundred-and-seventeen-letter name (an ordinary export from an LMS) would
   * answer "the name will not do" about a name the person never typed.
   */
  const room = (suffix: string): string => {
    const left = MAX_SEGMENT - suffix.length - 1 - ext.length
    let head = left > 0 ? stem.slice(0, left).trimEnd() : ''
    while(head && segmentBytes(`${head} ${suffix}${ext}`)>MAX_SEGMENT_BYTES) head=Array.from(head).slice(0,-1).join('').trimEnd()
    // No head left at all — so the name consists of the extension alone;
    // then the copy is called just by the word.
    const name = head ? `${head} ${suffix}${ext}` : `${suffix}${ext}`
    return dir ? `${dir}/${name}` : name
  }
  const first = room(tr('server.files.copySuffix'))
  if (!statPath(sessionId, first)) return first
  for (let n = 2; n < 100; n++) {
    const candidate = room(tr('server.files.copySuffixN', { p0: n }))
    if (!statPath(sessionId, candidate)) return candidate
  }
  // A hundred copies of one file is not a task worth inventing a hundredth way
  // to name a file for: let whoever is copying get "taken".
  return first
}

/** Whether this is a text file, by name and by contents at once. */
export function isEditable(sessionId: string, rel: string): boolean {
  if (kindOf(rel) !== 'text') return false
  const read = readText(sessionId, rel)
  return read !== null && !read.binary && !read.truncated
}
