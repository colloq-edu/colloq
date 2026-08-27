import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import type { FileEntry } from '@shared/protocol'

/**
 * Each session gets a directory under the shared /workspace volume. The kernel
 * container mounts the same volume, so `open('data.csv')` inside a cell and the
 * Files panel in the browser look at the same bytes.
 */
export function sessionDir(sessionId: string): string {
  const dir = path.join(config.workspaceDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Kernel-side path (the kernel container mounts the volume at /workspace too). */
export function kernelCwd(sessionId: string): string {
  return `/workspace/${sessionId}`
}

/** Reject anything that could escape the session directory. */
/*
 * A control character in a filename is legal on POSIX and a menace everywhere
 * else: a newline breaks the file list into two rows, a carriage return hides
 * the rest of the name in the terminal, and neither survives being read back
 * out of `pd.read_csv`. Participant names are already stripped of them for the
 * same reason. Refused rather than stripped — silently renaming somebody's
 * upload is worse than telling them the name will not do.
 */
// eslint-disable-next-line no-control-regex -- control characters are the subject
const CONTROL = /[\u0000-\u001f\u007f]/

export function safeName(name: string): string | null {
  const base = path.basename(name)
  if (!base || base === '.' || base === '..') return null
  if (base.includes('/') || base.includes('\\')) return null
  if (CONTROL.test(base)) return null
  if (base.length > 200) return null
  // A leading dot is filtered out of the listing — that is how the kernel's own
  // `.ipynb_checkpoints` stays out of the room's way. Accepting an upload and
  // then never showing it is worse than refusing it, so it is refused here.
  if (base.startsWith('.')) return null
  return base
}

/**
 * Why a name was refused, in a sentence the person who dropped the file can act
 * on. `safeName` answers yes or no, which is all the server needs and nothing a
 * student can use: "unusable file name" told them neither which file nor what
 * about it, in the middle of a class, with the seminar waiting.
 */
/**
 * Clear away temp files an interrupted upload left behind.
 *
 * An upload writes beside its target and renames on success, and every failure
 * path removes its own temp — every path except the process dying mid-write.
 * What that leaves is a dotfile, so the room never sees it and nobody can
 * remove it from the panel either. Swept on the next upload into the same
 * seminar, which is the moment somebody is thinking about that folder anyway.
 */
export function sweepStaleUploads(sessionId: string, olderThanMs = 60 * 60 * 1000): void {
  const dir = sessionDir(sessionId)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - olderThanMs
  for (const name of names) {
    if (!/^\..+\.uploading-[0-9a-f]{6,}$/.test(name)) continue
    const full = path.join(dir, name)
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true })
    } catch {
      /* somebody else got there first */
    }
  }
}

export function whyRefused(name: string): string {
  const base = path.basename(name ?? '')
  const shown = base.slice(0, 60) || '(no name)'
  if (!base || base === '.' || base === '..') return 'That upload arrived without a usable file name.'
  if (base.includes('/') || base.includes('\\')) {
    return `“${shown}” has a folder path in its name — upload the file itself rather than the folder.`
  }
  if (CONTROL.test(base)) return `“${shown}” has characters in its name that a file system will not take.`
  if (base.length > 200) {
    return `“${shown.slice(0, 40)}…” has a name of ${base.length} characters — shorten it to 200 or fewer.`
  }
  if (base.startsWith('.')) {
    return `“${shown}” starts with a dot, which hides it from the room's file list. Rename it and drop it again.`
  }
  return `“${shown}” cannot be used as a file name here.`
}

export function resolveInSession(sessionId: string, name: string): string | null {
  const base = safeName(name)
  if (!base) return null
  const dir = sessionDir(sessionId)
  const full = path.join(dir, base)
  if (!full.startsWith(dir + path.sep)) return null
  /*
   * The name check above is about the REQUEST: it stops `../` from leaving the
   * folder. This one is about the ENTRY: it stops a symlink inside the folder
   * from pointing out of it. They are different holes and only the first was
   * closed. The kernel container runs any Python a student types on the same
   * mounted workspace, so `os.symlink('/data/session-secret', 'key.txt')` put
   * a file in the room's list that the download route then streamed — the
   * secret every token in the product is signed with.
   *
   * realpath follows the link; a target outside the folder is refused. A path
   * that does not exist yet (an upload about to land) resolves as itself.
   */
  let real: string
  try {
    real = fs.realpathSync(full)
  } catch {
    return full
  }
  let realDir: string
  try {
    realDir = fs.realpathSync(dir)
  } catch {
    return null
  }
  if (real !== realDir && !real.startsWith(realDir + path.sep)) return null
  return full
}

export function listFiles(sessionId: string): FileEntry[] {
  const dir = sessionDir(sessionId)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const entries: FileEntry[] = []
  for (const name of names) {
    if (name.startsWith('.') || name === '__pycache__') continue
    try {
      // lstat, not stat: a symlink is not a file of this room, whatever it
      // points at, and listing it as one is how a link to a secret became a
      // download button.
      const stat = fs.lstatSync(path.join(dir, name))
      if (!stat.isFile()) continue
      entries.push({ name, size: stat.size, modifiedAt: stat.mtimeMs })
    } catch {
      /* vanished between readdir and stat; skip */
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export function deleteFile(sessionId: string, name: string): boolean {
  const full = resolveInSession(sessionId, name)
  if (!full) return false
  try {
    fs.unlinkSync(full)
    return true
  } catch {
    return false
  }
}
