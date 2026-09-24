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

/** Operations on the workspace, bound to a trusted open root.
 *
 * LINUX — a real descriptor-based walk. walk() opens every segment with
 * O_DIRECTORY|O_NOFOLLOW and addresses the next one through
 * /proc/self/fd/<fd>/<name>: the kernel starts from an already open
 * directory, not from a string, so between the check and the operation there
 * is nothing to swap the path with. Holding a checked string, or protecting
 * only the last link, is not enough.
 *
 * NON-LINUX (the teacher's macOS) — there is no descriptor-based walk and
 * there cannot be one. Node has no openat(), and /dev/fd/<fd>/<name> on macOS
 * returns ENOENT (checked by measurement; it is not /proc/self/fd — there is
 * no stand-in directory per descriptor there). So here the most that is
 * possible without openat is done:
 *   • every segment of the path, including the workspace root, is actually
 *     OPENED with O_DIRECTORY|O_NOFOLLOW rather than checked with lstat:
 *     nobody walks through a symlink, the open refuses (Linux answers ELOOP,
 *     macOS with O_DIRECTORY — ENOTDIR; both errors are a refusal);
 *   • the descriptors of all segments are held for the duration of the
 *     operation. That does not prevent renaming a directory, but it keeps its
 *     inode alive — so the dev/ino comparison is honest: the inode number
 *     could not have been reused under us;
 *   • right after the operation the last directory is opened once more by its
 *     full path from the root, and its dev/ino is compared with the held one
 *     (verify). The kernel resolves the full path anew, so swapping ANY
 *     segment above leads to a different inode and shows. This cannot prevent
 *     the swap — only keep someone else's result from going out and fail
 *     loudly instead of succeeding quietly.
 *
 * WHAT REMAINS A HOLE ON macOS, PLAINLY AND WITHOUT EMBELLISHMENT: the
 * operation itself still goes by STRING, and the kernel resolves it anew.
 * Whoever manages, between our check of a segment and the fs.* call, to swap
 * an intermediate directory for a symlink will lead the operation outside;
 * verify() will notice it afterwards, but the write will already have
 * happened. There is nothing to close the window with: Node on macOS has
 * nothing to address relative to a descriptor with (neither openat nor a
 * magic directory per fd). On Linux this window does not exist at all. Hence
 * the rule: a production server is only Linux in a container, and a local
 * class on macOS lives inside the "my class on my computer" perimeter, where
 * the teacher's machine and everything running on it are considered trusted.
 *
 * Two more differences from Linux, both visible from outside. A directory
 * whose permissions were removed (mode 000) cannot be deleted recursively on
 * macOS: there is no way to repair the permissions without going by name —
 * details at removeNative. And a hard link whose source name is a symlink is
 * rejected on macOS, because there link() follows the link, while on Linux it
 * copies the link itself (both behaviors checked by measurement).
 *
 * The COLLOQ_UNSAFE_DEV_FILES flag (options.allowUnsafeDevelopment) decides
 * NOTHING here any more and is kept only for signature compatibility with the
 * callers. It used to enable a path that merely lstat-ed the segments and
 * handed out a plain string — that is, fs.* calmly went through a symlink
 * planted after the check. That path is gone: non-Linux goes with O_NOFOLLOW,
 * and running on macOS needs neither the flag nor the word UNSAFE in the
 * teacher's .env.
 *
 * Not closed on either platform: splitting hard links that already exist.
 * Production assumes a clean "a directory per room" tree: a migration from a
 * shared runtime must materialize regular files separately, through the
 * tested backup/restore. Legitimate hard links inside a room work; a Pod with
 * a restricted subPath cannot name a neighboring room and create a link
 * between rooms.
 */
export function createAnchoredFilesystem(rootPath: string, _options: { allowUnsafeDevelopment?: boolean } = {}): SafeFs {
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
    // The whole promise rests on two open flags. A platform that lacks them
    // (Windows gives undefined for both) would silently get flags without them
    // — that is, a plain open by string, through any symlink. Better to say so
    // out loud and refuse than to pretend there is protection.
    if (!fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY)
      fail('Workspace anchoring needs O_NOFOLLOW and O_DIRECTORY; this platform has neither. Run the server on Linux (make up) or on macOS.')
    if (rootFd === undefined) {
      fs.mkdirSync(root, { recursive: true })
      // The root is trusted, but it too is opened with O_NOFOLLOW: if the
      // workspace itself turns out to be a symlink, the whole tree under it is
      // already someone else's place.
      rootFd = fs.openSync(root, directoryFlags)
      if (linux) {
        try { fs.statSync(`/proc/self/fd/${rootFd}/.`) }
        catch { fs.closeSync(rootFd); rootFd = undefined; fail(tr("server.workspaceDescriptorTraversalIsUnavailable.be15fe")) }
      }
    }
    return rootFd!
  }
  const identity = (fd: number): string => { const info = fs.fstatSync(fd); return `${info.dev}:${info.ino}` }
  /** Open a directory by name without ever walking through a symlink.
   * This is the only way to "check" a segment on non-Linux: not lstat (it
   * answers about the past) but the refusal of the open itself. The lstat in
   * the catch is only there to name the reason in human words — the kernel has
   * already made the decision. */
  const openDirectory = (absolute: string): number => {
    try { return fs.openSync(absolute, directoryFlags) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        let symlink = false
        try { symlink = fs.lstatSync(absolute).isSymbolicLink() } catch { /* gone — rethrow the original error */ }
        if (symlink) fail(tr("server.workspaceSymlinksAreForbidden.f2f20a"))
      }
      throw error
    }
  }
  type NativeChain = { dir: string; verify(): void; close(): void }
  /** Non-Linux: open and hold EVERY segment of the path with O_NOFOLLOW.
   * Holding does not prevent renaming, but it pins the inode, so verify() can
   * honestly compare dev/ino: while we hold the directory, its number is not
   * reused. */
  const holdNative = (names: string[], create = false): NativeChain => {
    const held = [initialize()]  // [0] is the object's root descriptor: not ours, do not close it
    const close = (): void => { while (held.length > 1) fs.closeSync(held.pop()!) }
    let current = root
    try {
      for (const name of names) {
        current = path.join(current, name)
        if (create) {
          // mkdir by name does not follow a symlink: a name taken by a link
          // gives EEXIST, and the next open with O_NOFOLLOW rejects that link.
          try { fs.mkdirSync(current, { mode: 0o2775 }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        }
        held.push(openDirectory(current))
      }
    } catch (error) { close(); throw error }
    // Checking ONE last directory is enough, and that is not skimping on
    // security: the repeated open goes by the full path from the root, that is,
    // the kernel walks the whole chain again. If a segment above was swapped,
    // the same path leads to a different directory, and dev/ino will not match
    // (or the open simply refuses). A directory with the same inode cannot be
    // slipped in: there are no hard links to directories.
    const identifier = identity(held.at(-1)!)
    return {
      dir: current,
      verify() {
        const fd = openDirectory(current)
        try { if (identity(fd) !== identifier) fail('Workspace directory was replaced while the operation ran') }
        finally { fs.closeSync(fd) }
      },
      close,
    }
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
  /** discard is for actions that return a captured resource: if verify() says
   * "the directory was swapped" after the action, the result does not go out,
   * which means nobody would be left to close it — so it is closed here. */
  const parent = <T>(file: string, action: (anchored: string) => T, create = false, deleting = false, discard?: (value: T) => void): T => {
    const names = parts(file)
    if (linux) {
      if (!names.length) return action(`/proc/self/fd/${initialize()}/.`)
      const held = walk(names.slice(0, -1), create, deleting)
      try { return action(`/proc/self/fd/${held.fd}/${names.at(-1)}`) }
      finally { held.close() }
    }
    // Non-Linux: the parent directories are opened with O_NOFOLLOW and held,
    // the action goes by name inside the last of them, and verify() right
    // after the action checks that the chain was not swapped. deleting does
    // not apply here: there is nothing to repair a mode-000 directory's
    // permissions with (see removeNative).
    const held = holdNative(names.slice(0, -1), create)
    try {
      const result = action(names.length ? path.join(held.dir, names.at(-1)!) : held.dir)
      try { held.verify() } catch (error) { discard?.(result); throw error }
      return result
    } finally { held.close() }
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
  }, false, false, opened => fs.closeSync(opened))
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
  const removeNative = (absolute: string, recursive: boolean): void => {
    const info = fs.lstatSync(absolute)
    // unlink never follows a symlink — the link itself is removed, not its target.
    if (!info.isDirectory()) { fs.unlinkSync(absolute); return }
    if (!recursive) { fs.rmdirSync(absolute); return }
    let fd: number
    try { fd = openDirectory(absolute) }
    catch (error) {
      // A directory without permissions (mode 000) cannot be opened on macOS,
      // and there is no honest way to repair its permissions: fchmod needs a
      // descriptor we do not have; lchmod on a directory answers EISDIR
      // (checked); and a plain chmod would go BY NAME and, if the name had
      // been swapped for a link by then, would change the permissions of
      // someone else's inode — exactly what this module does not do. On Linux
      // the case is handled by deletionDirectory: O_PATH pins the inode, and
      // chmod goes through the magic link /proc/self/fd/<fd>, that is, through
      // the directory itself rather than its name. Here one safe action is
      // left: an empty directory is removed by rmdir (the permissions needed
      // are the parent's, not its own), a non-empty one is an honest refusal
      // to the caller.
      if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error
      fs.rmdirSync(absolute)
      return
    }
    // The directory's descriptor is held for the whole walk: it is proven not
    // to be a symlink, and its inode will not go anywhere while we remove the
    // contents by name.
    try { for (const name of fs.readdirSync(absolute)) removeNative(path.join(absolute, name), true) }
    finally { fs.closeSync(fd) }
    // rmdir will not follow a symlink: a swapped name answers ENOTDIR.
    fs.rmdirSync(absolute)
  }
  const safe = {
    close() { if (rootFd !== undefined) { fs.closeSync(rootFd); rootFd = undefined } },
    openSync: open,
    openRead(file: string): HeldFile {
      const fd = open(file)
      if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); fail(tr("server.expectedARegularWorkspaceFile.8a4343")) }
      let live = true
      // Hand out the name of the opened inode itself, not the path: Express
      // opens it again, and by path it could catch a swap. On macOS
      // /dev/fd/<fd> works for a regular file (checked: reading, size and byte
      // ranges), although walking /dev/fd/<fd>/<name> is impossible there.
      // Reopening checks permissions again — a file whose permissions were
      // removed after open will not be served.
      const held = linux ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`
      return { fd, path: held, close() { if (live) { live = false; fs.closeSync(fd) } } }
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
      if (linux) {
        const held = walk(parts(file))
        try { return fs.readdirSync(`/proc/self/fd/${held.fd}/.`, opts) } finally { held.close() }
      }
      // readdir cannot do O_NOFOLLOW, so we open the directory ourselves:
      // holdNative takes the target directory itself with O_NOFOLLOW too, so a
      // symlink in its place is rejected before reading. Reading has to go by
      // name — verify() decides whether what was read may be handed out: if
      // the chain was swapped, the list is not ours.
      const held = holdNative(parts(file))
      try { const entries = fs.readdirSync(held.dir, opts); held.verify(); return entries } finally { held.close() }
    },
    mkdirSync(file: string, opts?: any) {
      if (opts?.recursive) {
        const held = linux ? walk(parts(file), true) : holdNative(parts(file), true)
        held.close(); return undefined
      }
      return parent(file, p => fs.mkdirSync(p, opts))
    },
    // rename does not follow symlinks at the last links — the directory entry
    // itself is moved (checked on macOS: a link moved as a link). The
    // intermediate directories of both paths are opened with O_NOFOLLOW by
    // the parent() chains.
    renameSync(from: string, to: string) { return parent(from, a => parent(to, b => fs.renameSync(a, b))) },
    linkSync(from: string, to: string) {
      if (linux) return parent(from, a => parent(to, b => fs.linkSync(a, b)))
      // Checked on macOS: link() DOES follow a source symlink — the hard link
      // is made to the link's target, not to the link itself (on Linux it is
      // the other way round). link() has no O_NOFOLLOW flag, and opening the
      // source ourselves is not always possible (the file's permissions may
      // have been removed). So a symlink name is rejected right away, and
      // after link the new link's inode is compared with what lstat saw for
      // the source.
      let made: string | undefined
      try {
        return parent(from, a => parent(to, b => {
          const source = fs.lstatSync(a)
          if (source.isSymbolicLink()) fail(tr("server.workspaceSymlinksAreForbidden.f2f20a"))
          fs.linkSync(a, b)
          made = b
          const result = fs.lstatSync(b)
          if (result.dev !== source.dev || result.ino !== source.ino) fail('Workspace link source was replaced while the operation ran')
          return undefined
        }))
      } catch (error) {
        // A link created before the refusal is removed: otherwise the room
        // would keep a hard link to an inode we have just refused to hand out.
        // It has to be removed by name — there is no other way; if the name
        // has been swapped by that moment, someone else's entry with the same
        // name is removed, and that is a lesser evil than a link left behind
        // to someone else's file.
        if (made !== undefined) { try { fs.unlinkSync(made) } catch { /* nothing left to remove */ } }
        throw error
      }
    },
    unlinkSync(file: string) { return parent(file, p => fs.unlinkSync(p)) },
    rmSync(file: string, opts?: any) {
      if (!parts(file).length) fail(tr("server.refusingToRemoveTheTrustedWorkspaceRoot.c003d1"))
      try { return parent(file, p => linux ? removeAt(p, opts?.recursive === true) : removeNative(p, opts?.recursive === true), false, true) }
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
