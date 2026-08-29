import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import type { FileEntry } from '@shared/protocol'
import { MAX_DEPTH, baseOf, kindOf, normalizePath, parentOf } from '@shared/paths'

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
  const root = sessionDir(sessionId)
  const cutoff = Date.now() - olderThanMs
  const walk = (rel: string, depth: number): void => {
    let names: string[]
    try {
      names = fs.readdirSync(path.join(root, rel))
    } catch {
      return
    }
    for (const name of names) {
      const here = rel ? `${rel}/${name}` : name
      const full = path.join(root, here)
      if (/^\..+\.uploading-[0-9a-f]{6,}$/.test(name)) {
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true })
        } catch {
          /* somebody else got there first */
        }
        continue
      }
      // Папки тоже: загрузка теперь ложится в ту, на которую её принесли, и
      // недописанный файл остаётся там же. Скрытые пропускаются — кроме тех
      // самых временных, которые разобраны выше.
      if (name.startsWith('.') || depth + 1 >= MAX_DEPTH) continue
      try {
        if (fs.lstatSync(full).isDirectory()) walk(here, depth + 1)
      } catch {
        /* исчезла */
      }
    }
  }
  walk('', 0)
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
    realDir = fs.realpathSync(dir)
  } catch {
    return null
  }
  return contained(full, realDir) ? full : null
}

/**
 * Лежит ли путь внутри папки семинара — с учётом того, что его может ещё не
 * быть.
 *
 * Раньше несуществующий путь пропускался как есть, и на плоской папке это было
 * верно: единственный сегмент подделать нечем. С папками — уже нет: ссылка
 * могла оказаться на промежуточной папке, а `realpath` на несуществующем файле
 * бросает, ничего про его родителей не сказав. Поэтому поднимаемся до
 * ближайшего существующего предка: если ОН внутри, то и всё, чего ещё нет под
 * ним, будет внутри — ссылке взяться неоткуда там, где ничего нет.
 */
function contained(full: string, realDir: string): boolean {
  let probe = full
  for (let up = 0; up <= MAX_DEPTH + 2; up++) {
    try {
      const real = fs.realpathSync(probe)
      return real === realDir || real.startsWith(realDir + path.sep)
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
  return false
}

/**
 * Сколько строк дерева отдаётся комнате.
 *
 * Потолок, а не страница: панель рисует дерево целиком, а `pip install` в
 * ячейке заводит в папке семинара тысячи файлов за один заход. Две тысячи строк
 * — это уже больше, чем кто-нибудь прочитает, и меньше, чем то, на чём
 * подавится отрисовка.
 */
const MAX_ENTRIES = 2000

/**
 * Папка семинара деревом — в том порядке, в каком её рисуют.
 *
 * Плоский список, а не вложенный: по нему одинаково просто и построить дерево в
 * панели, и пройти его целиком на сервере, и он влезает в то же сообщение
 * `files`, которое комната уже получает. Порядок — обход в глубину, папки перед
 * файлами на каждом уровне; клиенту остаётся отрисовать его как есть.
 */
export function listFiles(sessionId: string): FileEntry[] {
  const root = sessionDir(sessionId)
  const out: FileEntry[] = []

  const walk = (rel: string, depth: number): void => {
    let names: string[]
    try {
      names = fs.readdirSync(path.join(root, rel))
    } catch {
      return
    }
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
        stat = fs.lstatSync(path.join(root, here))
      } catch {
        continue /* vanished between readdir and stat; skip */
      }
      if (stat.isDirectory()) dirs.push({ name, path: here, dir: true, size: 0, modifiedAt: stat.mtimeMs })
      else if (stat.isFile()) files.push({ name, path: here, dir: false, size: stat.size, modifiedAt: stat.mtimeMs })
    }
    const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name)
    dirs.sort(byName)
    files.sort(byName)
    for (const entry of dirs) {
      if (out.length >= MAX_ENTRIES) return
      out.push(entry)
      if (depth + 1 < MAX_DEPTH) walk(entry.path, depth + 1)
    }
    for (const entry of files) {
      if (out.length >= MAX_ENTRIES) return
      out.push(entry)
    }
  }

  walk('', 0)
  return out
}

/**
 * Сколько места занимает комната.
 *
 * Ограничение на один файл было всегда, на комнату целиком — нет: пятьдесят
 * мегабайт за раз и сто заходов дают пять гигабайт, а диск на этом сервере
 * общий с базой, снимками тетрадей и образами окружений. Кончится он молча и
 * сразу для всех.
 *
 * Считаются и недописанные загрузки: место они занимают ровно так же.
 */
export function sessionBytes(sessionId: string): number {
  const root = sessionDir(sessionId)
  let total = 0
  const walk = (rel: string, depth: number): void => {
    let names: string[]
    try {
      names = fs.readdirSync(path.join(root, rel))
    } catch {
      return
    }
    for (const name of names) {
      const here = rel ? `${rel}/${name}` : name
      try {
        // lstat: символическая ссылка занимает свой размер, а не размер цели —
        // и уж точно не даёт списать на комнату чужой гигабайт.
        const stat = fs.lstatSync(path.join(root, here))
        if (stat.isFile()) total += stat.size
        else if (stat.isDirectory() && depth + 1 < MAX_DEPTH) walk(here, depth + 1)
      } catch {
        /* исчез между readdir и stat */
      }
    }
  }
  walk('', 0)
  return total
}

/* ------------------------------------------------------- правка дерева */

/**
 * Чем кончилась попытка что-то поменять в дереве.
 *
 * Строка, а не исключение: у каждого исхода своя фраза в интерфейсе, и все
 * четыре — обычный ход дела, а не поломка. `busy` — про то, чего никакая
 * проверка заранее не увидит: файл, который в этот момент пишет ядро.
 */
export type TreeResult = 'ok' | 'bad-name' | 'exists' | 'missing' | 'busy'

/** Завести папку. Промежуточные папки заводятся вместе с ней. */
export function makeDir(sessionId: string, rel: string): TreeResult {
  const full = resolveInSession(sessionId, rel)
  if (!full) return 'bad-name'
  if (fs.existsSync(full)) return 'exists'
  try {
    fs.mkdirSync(full, { recursive: true })
    return 'ok'
  } catch {
    return 'busy'
  }
}

/**
 * Завести файл. Только новый: перезапись пустотой — это стирание, и у него своя
 * кнопка со своим правилом.
 */
export function makeFile(sessionId: string, rel: string, text = ''): TreeResult {
  const full = resolveInSession(sessionId, rel)
  if (!full) return 'bad-name'
  if (fs.existsSync(full)) return 'exists'
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true })
    // 'wx' — отказ, а не перезапись, если файл появился между проверкой и
    // записью. Две вкладки, нажавшие «новый файл» одновременно, — не выдумка.
    fs.writeFileSync(full, text, { flag: 'wx' })
    return 'ok'
  } catch {
    return 'exists'
  }
}

/**
 * Переименовать или переложить. Одна операция, потому что на диске это одно и
 * то же, а в дереве переименование — это перетаскивание на месте.
 */
export function movePath(sessionId: string, from: string, to: string): TreeResult {
  const source = resolveInSession(sessionId, from)
  const target = resolveInSession(sessionId, to)
  if (!source || !target) return 'bad-name'
  if (!fs.existsSync(source)) return 'missing'
  if (fs.existsSync(target)) return 'exists'
  /*
   * Папку нельзя положить внутрь себя же. `rename` на такой паре отвечает
   * EINVAL, и это был бы понятный отказ, — но на файловых системах, где он
   * отвечает успехом, поддерево уезжает из дерева навсегда.
   */
  if (target === source || target.startsWith(source + path.sep)) return 'bad-name'
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(source, target)
    return 'ok'
  } catch {
    return 'busy'
  }
}

/**
 * Убрать файл или папку.
 *
 * Папка убирается со всем, что в ней, и это осознанно: пустая папка, которую
 * нельзя убрать, пока не убрал всё внутри поштучно, — это работа, которую
 * панель перекладывает на человека вместо одного вопроса «точно?». Спрашивает
 * тот, кто рисует кнопку; здесь уже делают.
 */
export function deleteFile(sessionId: string, name: string): boolean {
  const full = resolveInSession(sessionId, name)
  if (!full) return false
  try {
    const stat = fs.lstatSync(full)
    if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true })
    else fs.unlinkSync(full)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------- содержимое */

/**
 * Потолок на текст, который открывается в редакторе.
 *
 * Полтора мегабайта — это примерно тридцать тысяч строк: больше, чем бывает у
 * файла, который правят на семинаре, и меньше, чем то, на чём CodeMirror
 * начинает думать над каждым нажатием. Файл крупнее не режется на куски: он
 * показывается началом и не даёт себя править, потому что сохранить обрезок
 * поверх целого — это потерять хвост молча.
 */
export const MAX_TEXT_BYTES = 1_500_000

export interface TextFile {
  text: string
  /** Файл больше потолка: показан началом, править нельзя. */
  truncated: boolean
  /** Не текст вовсе — в нём нулевые байты. */
  binary: boolean
  modifiedAt: number
  size: number
}

/**
 * Прочитать файл как текст.
 *
 * Нулевой байт в первых восьми килобайтах — признак, по которому это делают
 * все: расширение врёт (студент назвал архив `data.csv`), а содержимое нет.
 * Открыть архив в редакторе — это показать мусор и предложить его сохранить.
 */
export function readText(sessionId: string, rel: string): TextFile | null {
  const full = resolveInSession(sessionId, rel)
  if (!full) return null
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(full)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  const truncated = stat.size > MAX_TEXT_BYTES
  let buf: Buffer
  try {
    if (!truncated) buf = fs.readFileSync(full)
    else {
      const fd = fs.openSync(full, 'r')
      try {
        buf = Buffer.alloc(MAX_TEXT_BYTES)
        const read = fs.readSync(fd, buf, 0, MAX_TEXT_BYTES, 0)
        buf = buf.subarray(0, read)
      } finally {
        fs.closeSync(fd)
      }
    }
  } catch {
    return null
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
 * Записать файл целиком.
 *
 * Рядом и переименованием, не поверх: `writeFileSync` сначала обрезает файл до
 * нуля и наполняет его потом, так что ячейка, читающая этот CSV прямо сейчас,
 * успевает прочитать половину и закончить без ошибки. Тот же довод записан над
 * загрузкой в routes/files.ts, и он одинаково верен для редактора, который
 * сохраняется сам каждые несколько секунд.
 */
export function writeText(sessionId: string, rel: string, text: string): boolean {
  const full = resolveInSession(sessionId, rel)
  if (!full) return false
  const tmp = path.join(path.dirname(full), `.${baseOf(rel)}.saving-${process.pid}-${Date.now().toString(36)}`)
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, full)
    return true
  } catch {
    fs.rmSync(tmp, { force: true })
    return false
  }
}

/** Существует ли путь, и что это. `null` — ничего нет. */
export function statPath(sessionId: string, rel: string): { dir: boolean; size: number; modifiedAt: number } | null {
  const full = resolveInSession(sessionId, rel)
  if (!full) return null
  try {
    const stat = fs.lstatSync(full)
    if (!stat.isFile() && !stat.isDirectory()) return null
    return { dir: stat.isDirectory(), size: stat.size, modifiedAt: stat.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Свободное имя рядом с занятым: `train.py` -> `train 2.py`.
 *
 * Нужно ровно там, где отказ был бы хуже: оракул создаёт файл, который уже
 * есть, и отменить весь ход из-за имени — потерять работу. Человеку, который
 * набрал имя руками, по-прежнему отвечают «занято»: он имел в виду именно его.
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

/** Текстовый ли это файл по имени и по содержимому разом. */
export function isEditable(sessionId: string, rel: string): boolean {
  if (kindOf(rel) !== 'text') return false
  const read = readText(sessionId, rel)
  return read !== null && !read.binary && !read.truncated
}
