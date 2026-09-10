import { tr } from '@shared/i18n'
import fs from 'node:fs'
import path from 'node:path'
import type { Response } from 'express'

export interface HeldFile { fd: number; path: string; close(): void }
/** Preserve Express conditional/range handling while it opens a held inode. */
export function downloadHeldFile(res: Response, file: HeldFile, name: string): void {
  res.type(name)
  try {
    res.download(file.path, name, { dotfiles: 'allow' }, error => {
      file.close()
      if (error && !res.headersSent) res.status(404).json({ error: tr("server.fileNotFound.3e2256") })
    })
  } catch (error) { file.close(); throw error }
}
type SafeFs = Pick<typeof fs, 'openSync' | 'existsSync' | 'lstatSync' | 'statSync' |
  'realpathSync' | 'readFileSync' | 'writeFileSync' | 'chmodSync' | 'readdirSync' |
  'mkdirSync' | 'renameSync' | 'linkSync' | 'unlinkSync' | 'rmSync' |
  'createWriteStream' | 'createReadStream'> & { close(): void; openRead(file: string): HeldFile }

/** Linux pathname operations anchored to an opened, trusted workspace root.
 * Every untrusted parent is opened with O_DIRECTORY|O_NOFOLLOW. Holding only a
 * validated string, or protecting only the final component, is insufficient.
 * The opt-in development fallback rejects static symlinks but is not race-safe.
 * This does not split pre-existing hardlinked inodes. Production assumes a
 * clean per-room storage tree: migration from a shared runtime must materialize
 * regular files independently through validated backup/restore. Legitimate
 * in-room hardlinks remain supported; a restricted subPath Pod cannot name a
 * sibling room to create a cross-room link in the first place.
 */
export function createAnchoredFilesystem(rootPath: string, options: { allowUnsafeDevelopment: boolean }): SafeFs {
  const root = path.resolve(rootPath)
  let rootFd: number | undefined
  const linux = process.platform === 'linux'
  const nofollow = fs.constants.O_NOFOLLOW
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | nofollow
  // Linux O_PATH (uapi asm-generic/fcntl.h); Node does not expose this constant.
  const pathOnly = 0x200000
  const fail = (message: string): never => { throw new Error(message) }
  const parts = (file: any): string[] => {
    if (typeof file !== 'string') fail(tr("server.workspaceAccessRequiresAPathname.69ac15"))
    const relative = path.relative(root, path.resolve(file))
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) fail(tr("server.pathIsOutsideTheWorkspace.5d7c04"))
    if (relative.includes('\0')) fail(tr("server.invalidWorkspacePathname.e819a2"))
    return relative ? relative.split(path.sep) : []
  }
  const initialize = (): number => {
    if (!linux) fail('Linux descriptor traversal is required. Use make up (Linux in Docker), or set COLLOQ_UNSAFE_DEV_FILES=1 in .env for trusted native development only; never use it in production.')
    if (rootFd === undefined) {
      fs.mkdirSync(root, { recursive: true })
      rootFd = fs.openSync(root, directoryFlags)
      try { fs.statSync(`/proc/self/fd/${rootFd}/.`) }
      catch { fs.closeSync(rootFd); rootFd = undefined; fail(tr("server.workspaceDescriptorTraversalIsUnavailable.be15fe")) }
    }
    return rootFd!
  }
  const devPath = (file: string): string => {
    if (!options.allowUnsafeDevelopment) initialize()
    const names = parts(file); let current = root
    for (const name of names) {
      current = path.join(current, name)
      try { if (fs.lstatSync(current).isSymbolicLink()) fail(tr("server.workspaceSymlinksAreForbidden.f2f20a")) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return current
  }
  const deletionDirectory = (anchored: string): number => {
    // O_PATH pins an owned mode000 directory without needing read permission.
    // chmod the magic-link itself: adding '/.' would require execute permission
    // before the mode could be repaired. Never chmod the untrusted entry name.
    const fd = fs.openSync(anchored, pathOnly | fs.constants.O_DIRECTORY | nofollow)
    try {
      const info = fs.fstatSync(fd)
      if ((info.mode & 0o700) !== 0o700) {
        fs.chmodSync(`/proc/self/fd/${fd}`, (info.mode & 0o7777) | 0o700)
      }
      return fd
    } catch (error) { fs.closeSync(fd); throw error }
  }
  const walk = (names: string[], create = false, deleting = false): { fd: number; close(): void } => {
    let fd = initialize(), own = false
    try {
      for (const name of names) {
        const item = `/proc/self/fd/${fd}/${name}`
        if (create) {
          try { fs.mkdirSync(item, { mode: 0o2775 }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        }
        const next = deleting ? deletionDirectory(item) : fs.openSync(item, directoryFlags)
        if (own) fs.closeSync(fd)
        fd = next; own = true
      }
      return { fd, close() { if (own) { fs.closeSync(fd); own = false } } }
    } catch (error) { if (own) fs.closeSync(fd); throw error }
  }
  const parent = <T>(file: string, action: (anchored: string) => T, create = false, deleting = false): T => {
    if (!linux) return action(devPath(file))
    const names = parts(file)
    if (!names.length) return action(`/proc/self/fd/${initialize()}/.`)
    const held = walk(names.slice(0, -1), create, deleting)
    try { return action(`/proc/self/fd/${held.fd}/${names.at(-1)}`) }
    finally { held.close() }
  }
  const flagNumber = (flags: string | number): number => {
    if (typeof flags === 'number') return flags
    const map: Record<string, number> = {
      r: fs.constants.O_RDONLY, 'r+': fs.constants.O_RDWR,
      w: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
      wx: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_EXCL,
      a: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
      ax: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_EXCL,
    }
    if (!(flags in map)) fail(tr("server.unsupportedWorkspaceOpenMode.1e9628"))
    return map[flags]
  }
  const open = (file: string, flags: string | number = 'r', mode = 0o600): number => parent(file, anchored => {
    const fd = fs.openSync(anchored, flagNumber(flags) | nofollow | fs.constants.O_NONBLOCK, mode)
    const info = fs.fstatSync(fd)
    if (!info.isFile() && !info.isDirectory()) { fs.closeSync(fd); fail(tr("server.workspaceSpecialFilesAreForbidden.fc1802")) }
    return fd
  })
  const withFile = <T>(file: string | number, action: (fd: number) => T, flags: string | number = 'r', mode?: number): T => {
    if (typeof file === 'number') return action(file)
    const fd = open(file, flags, mode)
    try { return action(fd) } finally { fs.closeSync(fd) }
  }
  const removeAt = (anchored: string, recursive: boolean): void => {
    const info = fs.lstatSync(anchored)
    if (!info.isDirectory()) { fs.unlinkSync(anchored); return }
    if (!recursive) { fs.rmdirSync(anchored); return }
    const fd = deletionDirectory(anchored)
    try {
      for (const name of fs.readdirSync(`/proc/self/fd/${fd}/.`)) removeAt(`/proc/self/fd/${fd}/${name}`, true)
    } finally { fs.closeSync(fd) }
    // If the name was swapped, rmdir cannot follow a symlink to its target.
    fs.rmdirSync(anchored)
  }
  const safe = {
    close() { if (rootFd !== undefined) { fs.closeSync(rootFd); rootFd = undefined } },
    openSync: open,
    openRead(file: string): HeldFile {
      const fd = open(file)
      if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); fail(tr("server.expectedARegularWorkspaceFile.8a4343")) }
      let live = true
      return { fd, path: linux ? `/proc/self/fd/${fd}` : devPath(file), close() { if (live) { live = false; fs.closeSync(fd) } } }
    },
    existsSync(file: string) { try { parent(file, p => fs.lstatSync(p)); return true } catch { return false } },
    lstatSync(file: string, opts?: any) { return parent(file, p => fs.lstatSync(p, opts)) },
    statSync(file: string, opts?: any) { return withFile(file, fd => fs.fstatSync(fd, opts)) },
    realpathSync(file: string) { return withFile(file, () => path.resolve(file)) },
    readFileSync(file: string | number, opts?: any) { return withFile(file, fd => fs.readFileSync(fd, opts)) },
    writeFileSync(file: string | number, data: any, opts?: any) {
      return withFile(file, fd => fs.writeFileSync(fd, data, opts), opts?.flag ?? 'w', opts?.mode)
    },
    chmodSync(file: string, mode: number) { return withFile(file, fd => fs.fchmodSync(fd, mode)) },
    readdirSync(file: string, opts?: any) {
      if (!linux) return fs.readdirSync(devPath(file), opts)
      const held = walk(parts(file))
      try { return fs.readdirSync(`/proc/self/fd/${held.fd}/.`, opts) } finally { held.close() }
    },
    mkdirSync(file: string, opts?: any) {
      if (!linux) return fs.mkdirSync(devPath(file), opts)
      if (opts?.recursive) { const held = walk(parts(file), true); held.close(); return undefined }
      return parent(file, p => fs.mkdirSync(p, opts))
    },
    renameSync(from: string, to: string) { return parent(from, a => parent(to, b => fs.renameSync(a, b))) },
    linkSync(from: string, to: string) { return parent(from, a => parent(to, b => fs.linkSync(a, b))) },
    unlinkSync(file: string) { return parent(file, p => fs.unlinkSync(p)) },
    rmSync(file: string, opts?: any) {
      if (!parts(file).length) fail(tr("server.refusingToRemoveTheTrustedWorkspaceRoot.c003d1"))
      try { return parent(file, p => linux ? removeAt(p, opts?.recursive === true) : fs.rmSync(p, opts), false, true) }
      catch (error) { if (!opts?.force || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    },
    createWriteStream(file: string, opts?: any) {
      const fd = open(file, opts?.flags ?? 'w', opts?.mode)
      try { return fs.createWriteStream(file, { ...opts, fd, autoClose: true }) }
      catch (error) { fs.closeSync(fd); throw error }
    },
    createReadStream(file: string, opts?: any) {
      const fd = open(file)
      try { return fs.createReadStream(file, { ...opts, fd, autoClose: true }) }
      catch (error) { fs.closeSync(fd); throw error }
    },
  }
  return safe as unknown as SafeFs
}
