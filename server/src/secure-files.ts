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

/** Операции над workspace, привязанные к доверенному открытому корню.
 *
 * LINUX — настоящий дескрипторный обход. walk() открывает каждый сегмент с
 * O_DIRECTORY|O_NOFOLLOW и адресует следующий через /proc/self/fd/<fd>/<имя>:
 * ядро идёт от уже открытого каталога, а не от строки, поэтому между проверкой
 * и операцией подменить путь нечем. Держать проверенную строку или защищать
 * только последнее звено — недостаточно.
 *
 * НЕ-LINUX (macOS преподавателя) — дескрипторного обхода нет и быть не может.
 * В Node нет openat(), а /dev/fd/<fd>/<имя> на macOS отдаёт ENOENT (проверено
 * замером, это не /proc/self/fd — там нет каталога-заглушки на дескриптор).
 * Поэтому здесь сделан максимум возможного без openat:
 *   • каждый сегмент пути, включая корень workspace, именно ОТКРЫВАЕТСЯ с
 *     O_DIRECTORY|O_NOFOLLOW, а не проверяется lstat-ом: по симлинку никто не
 *     проходит, открытие отказывает (Linux отвечает ELOOP, macOS с O_DIRECTORY
 *     — ENOTDIR; обе ошибки — отказ);
 *   • дескрипторы всех сегментов удерживаются на время операции. Переименовать
 *     каталог это не мешает, зато держит его inode живым — значит сверка dev/ino
 *     честная: номер inode не могли переиспользовать под нами;
 *   • сразу после операции последний каталог открывается ещё раз по полному пути
 *     от корня и его dev/ino сверяется с удержанным (verify). Полный путь ядро
 *     резолвит заново, поэтому подмена ЛЮБОГО сегмента выше приводит в другой
 *     inode и видна. Предотвратить подмену это не может — только не отдать
 *     чужой результат наружу и упасть громко вместо тихого успеха.
 *
 * ЧТО НА macOS ОСТАЁТСЯ ДЫРОЙ, ПРЯМО И БЕЗ УКРАШЕНИЙ: сама операция всё равно
 * идёт по СТРОКЕ, и ядро резолвит её заново. Кто успеет между нашей проверкой
 * сегмента и вызовом fs.* подменить промежуточный каталог на симлинк — уведёт
 * операцию наружу; verify() заметит это после, но запись уже произойдёт.
 * Закрыть окно нечем: адресовать относительно дескриптора в Node на macOS не из
 * чего (нет ни openat, ни магического каталога на fd). На Linux этого окна нет
 * вовсе. Отсюда правило: боевой сервер — только Linux в контейнере, а локальное
 * занятие на macOS живёт в периметре «мой класс на моём компьютере», где машина
 * преподавателя и всё, что на ней запущено, считаются доверенными.
 *
 * Ещё две разницы с Linux, обе видны снаружи. Каталог, которому сняли права
 * (mode 000), на macOS рекурсивно не удаляется: починить права, не пойдя по
 * имени, нечем — подробности у removeNative. И жёсткая ссылка с именем-симлинком
 * в источнике на macOS отвергается, потому что там link() идёт по ссылке, а на
 * Linux копирует саму ссылку (оба поведения проверены замером).
 *
 * Флаг COLLOQ_UNSAFE_DEV_FILES (options.allowUnsafeDevelopment) больше НИЧЕГО
 * здесь не решает и оставлен только для совместимости сигнатуры с вызывающими.
 * Раньше он включал путь, который сегменты лишь lstat-ил и отдавал обычную
 * строку — то есть по симлинку, подставленному после проверки, fs.* спокойно
 * проходил. Такого пути больше нет: не-Linux ходит с O_NOFOLLOW, и запуск на
 * macOS не требует ни флага, ни слова UNSAFE в .env преподавателя.
 *
 * Не закрыто на обеих платформах: разделение уже существующих жёстких ссылок.
 * Продакшен исходит из чистого дерева «каталог на комнату»: миграция с общего
 * рантайма обязана материализовать обычные файлы отдельно, через проверенные
 * backup/restore. Законные жёсткие ссылки внутри комнаты работают; Pod с
 * ограниченным subPath не может назвать соседнюю комнату и создать ссылку
 * между комнатами.
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
    // Всё обещание держится на двух флагах открытия. Платформа, где их нет
    // (Windows отдаёт undefined на обоих), молча получила бы флаги без них — то
    // есть обычный open по строке, по любому симлинку. Такое лучше назвать
    // вслух и отказать, чем сделать вид, что защита есть.
    if (!fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY)
      fail('Workspace anchoring needs O_NOFOLLOW and O_DIRECTORY; this platform has neither. Run the server on Linux (make up) or on macOS.')
    if (rootFd === undefined) {
      fs.mkdirSync(root, { recursive: true })
      // Корень доверенный, но открывается он тоже с O_NOFOLLOW: если сам
      // workspace окажется симлинком, всё дерево под ним — уже чужое место.
      rootFd = fs.openSync(root, directoryFlags)
      if (linux) {
        try { fs.statSync(`/proc/self/fd/${rootFd}/.`) }
        catch { fs.closeSync(rootFd); rootFd = undefined; fail(tr("server.workspaceDescriptorTraversalIsUnavailable.be15fe")) }
      }
    }
    return rootFd!
  }
  const identity = (fd: number): string => { const info = fs.fstatSync(fd); return `${info.dev}:${info.ino}` }
  /** Открыть каталог по имени, ни в коем случае не пройдя по симлинку.
   * Это единственный способ «проверить» сегмент на не-Linux: не lstat (он
   * отвечает про прошлое), а отказ самого открытия. lstat в catch нужен только
   * чтобы назвать причину человеческими словами — решение уже принято ядром. */
  const openDirectory = (absolute: string): number => {
    try { return fs.openSync(absolute, directoryFlags) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        let symlink = false
        try { symlink = fs.lstatSync(absolute).isSymbolicLink() } catch { /* исчез — отдадим исходную ошибку */ }
        if (symlink) fail(tr("server.workspaceSymlinksAreForbidden.f2f20a"))
      }
      throw error
    }
  }
  type NativeChain = { dir: string; verify(): void; close(): void }
  /** Не-Linux: открыть и удержать КАЖДЫЙ сегмент пути с O_NOFOLLOW.
   * Удержание не мешает переименованию, но пинит inode, поэтому verify() может
   * честно сверить dev/ino: пока мы держим каталог, его номер не переиспользуют. */
  const holdNative = (names: string[], create = false): NativeChain => {
    const held = [initialize()]  // [0] — корневой дескриптор объекта, он не наш, не закрываем
    const close = (): void => { while (held.length > 1) fs.closeSync(held.pop()!) }
    let current = root
    try {
      for (const name of names) {
        current = path.join(current, name)
        if (create) {
          // mkdir по имени не идёт по симлинку: занятое ссылкой имя даёт EEXIST,
          // а следующее открытие с O_NOFOLLOW эту ссылку и отвергнет.
          try { fs.mkdirSync(current, { mode: 0o2775 }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        }
        held.push(openDirectory(current))
      }
    } catch (error) { close(); throw error }
    // Сверять хватает ОДИН последний каталог, и это не экономия на безопасности:
    // повторное открытие идёт по полному пути от корня, то есть ядро заново
    // проходит всю цепочку. Подменили сегмент выше — тот же путь приведёт в
    // другой каталог, и dev/ino не совпадут (или открытие просто откажет).
    // Каталог с тем же inode подсунуть нельзя: жёстких ссылок на каталоги нет.
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
  /** discard нужен тем действиям, что возвращают захваченный ресурс: если
   * verify() уже после действия скажет «каталог подменили», результат наружу не
   * уйдёт, а значит его некому будет закрыть — закрываем здесь. */
  const parent = <T>(file: string, action: (anchored: string) => T, create = false, deleting = false, discard?: (value: T) => void): T => {
    const names = parts(file)
    if (linux) {
      if (!names.length) return action(`/proc/self/fd/${initialize()}/.`)
      const held = walk(names.slice(0, -1), create, deleting)
      try { return action(`/proc/self/fd/${held.fd}/${names.at(-1)}`) }
      finally { held.close() }
    }
    // Не-Linux: родительские каталоги открыты с O_NOFOLLOW и удержаны, действие
    // идёт по имени внутри последнего из них, а verify() сразу после действия
    // проверяет, что цепочку не подменили. deleting здесь не применяется: чинить
    // права каталогу 000 нечем (см. removeNative).
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
    // unlink никогда не идёт по симлинку — снимается сама ссылка, не её цель.
    if (!info.isDirectory()) { fs.unlinkSync(absolute); return }
    if (!recursive) { fs.rmdirSync(absolute); return }
    let fd: number
    try { fd = openDirectory(absolute) }
    catch (error) {
      // Каталог без прав (mode 000) на macOS не открыть, и починить права
      // честно нечем: fchmod требует дескриптора, которого нет; lchmod на
      // каталоге отвечает EISDIR (проверено); а обычный chmod пошёл бы ПО ИМЕНИ
      // и, если имя успели подменить ссылкой, снял бы права с чужого inode —
      // ровно то, чего этот модуль не делает. На Linux случай лечится
      // deletionDirectory: O_PATH пинит inode, и chmod идёт по магической ссылке
      // /proc/self/fd/<fd>, то есть по самому каталогу, а не по имени. Здесь
      // остаётся одно безопасное действие: пустой каталог снимет rmdir (права
      // нужны родителю, не ему), непустой — честный отказ вызывающему.
      if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error
      fs.rmdirSync(absolute)
      return
    }
    // Дескриптор каталога держим всё время обхода: он доказан как не-симлинк и
    // его inode никуда не денется, пока мы снимаем содержимое по именам.
    try { for (const name of fs.readdirSync(absolute)) removeNative(path.join(absolute, name), true) }
    finally { fs.closeSync(fd) }
    // rmdir по симлинку не пойдёт: подменённое имя ответит ENOTDIR.
    fs.rmdirSync(absolute)
  }
  const safe = {
    close() { if (rootFd !== undefined) { fs.closeSync(rootFd); rootFd = undefined } },
    openSync: open,
    openRead(file: string): HeldFile {
      const fd = open(file)
      if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); fail(tr("server.expectedARegularWorkspaceFile.8a4343")) }
      let live = true
      // Отдаём имя самого открытого inode, а не путь: Express откроет его
      // заново, и по пути мог бы поймать подмену. На macOS /dev/fd/<fd> для
      // обычного файла работает (проверено: чтение, размер и диапазоны байт),
      // хотя обход /dev/fd/<fd>/<имя> там и невозможен. Переоткрытие заново
      // проверяет права — файл, у которого их сняли после open, не отдастся.
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
      // readdir не умеет O_NOFOLLOW, поэтому каталог открываем сами: holdNative
      // берёт с O_NOFOLLOW и сам целевой каталог, значит симлинк вместо него
      // отвергнут до чтения. Читать приходится по имени — verify() решает, можно
      // ли отдать прочитанное: подменили цепочку, значит список не наш.
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
    // rename не идёт по симлинкам последних звеньев — переносится сама запись
    // каталога (проверено на macOS: ссылка переехала ссылкой). Промежуточные
    // каталоги обоих путей открыты с O_NOFOLLOW цепочками parent().
    renameSync(from: string, to: string) { return parent(from, a => parent(to, b => fs.renameSync(a, b))) },
    linkSync(from: string, to: string) {
      if (linux) return parent(from, a => parent(to, b => fs.linkSync(a, b)))
      // Проверено на macOS: link() ИДЁТ по симлинку-источнику — жёсткая ссылка
      // получается на цель ссылки, а не на саму ссылку (на Linux наоборот).
      // Флага O_NOFOLLOW у link() нет, а открыть источник самим можно не всегда
      // (права на файл могли снять). Поэтому имя-симлинк отвергаем сразу, а
      // после link сверяем inode новой ссылки с тем, что видел lstat источника.
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
        // Созданную до отказа ссылку убираем: иначе в комнате останется жёсткая
        // ссылка на inode, который мы только что отказались отдать. Убирать
        // приходится по имени — другого способа нет; если имя к этой секунде уже
        // подменили, снимется чужая запись с тем же именем, и это меньшее зло,
        // чем оставленная ссылка на чужой файл.
        if (made !== undefined) { try { fs.unlinkSync(made) } catch { /* уже нечего убирать */ } }
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
