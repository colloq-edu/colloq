/**
 * The class ZIP: every material of a page in one archive, laid out like the
 * room.
 *
 * A student who unpacks `ml-strong-04.zip` gets one folder with the notebooks
 * (with their outputs), the slides and `data/train.csv` at the room's own
 * paths, so `pd.read_csv('data/train.csv')` runs unchanged; a folder
 * material puts every file of it there too, so `from scripts import
 * case_cian` imports after unzipping. A folder alone downloads the same way,
 * as `data.zip` with `data/` inside (folderZipPlan). A README next to
 * them says which class this is and where its page lives; it never names the
 * room, whose id is the right to write into it.
 *
 * Store-only and streamed. The files are PDFs, CSVs and notebooks with PNGs
 * inside, which deflate barely shrinks, and compressing 200 MB on the class's
 * process would hold the loop for seconds. Without compression every size and
 * CRC is known before the first byte (the CRCs sit in page_files), so the
 * archive has an exact Content-Length, no data descriptors and no ZIP64: a
 * page is capped at 200 MB, far under the 4 GB a plain archive holds.
 */
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { getLocale, tr } from '@shared/i18n'
import { formatDay, isClassDay } from '@shared/class-day'
import { publicationAddress, suggestSlug } from '@shared/publish'
import { config } from '../config.js'
import { instanceToday } from '../time-zone.js'
import { scrubText } from './checks.js'
import { crc32, pageFileInfo, pageFilePath } from './page-files.js'
import type { MaterialRow, Publication } from './store.js'

/** What the README and the folder name are made of. */
export interface ZipContext {
  pub: Pick<Publication, 'id' | 'slug' | 'title' | 'sessionId'>
  materials: readonly Pick<MaterialRow, 'kind' | 'name' | 'path' | 'hash' | 'bytes' | 'files'>[]
  /** The student title, as the class page shows it. */
  title: string
  n: number | null
  /** The class day; the archive's entries are dated noon of it. */
  day: string | null
  course: { id: string; slug: string | null; name: string } | null
}

export interface ZipEntry {
  /** `<top>/<room path>`, UTF-8. */
  name: string
  bytes: number
  crc: number
  /** A page file on disk, or the bytes made in memory (the README). */
  file: string | null
  body: Buffer | null
}

export interface ZipPlan {
  /** The top folder, and the archive's name without `.zip`. */
  top: string
  entries: ZipEntry[]
  /** The exact length of the archive. */
  bytes: number
  dosTime: number
  dosDate: number
}

const LOCAL_HEADER = 30
const CENTRAL_HEADER = 46
const END_RECORD = 22
/** General-purpose flag bit 11: names are UTF-8, so «Лекция.pdf» survives unzip. */
const UTF8_FLAG = 0x0800
/** 2.0: the version every unzip reads; nothing here needs more. */
const VERSION = 20
/** Made by Unix (3), so unpacked files get rw-r--r-- instead of no permissions at all. */
const MADE_BY = (3 << 8) | VERSION
const FILE_MODE = (0o100644 << 16) >>> 0

/**
 * The archive's name: the page address when it has a name, else a name made
 * from the title. An eight-letter id is a fine address and a poor folder.
 */
export function zipTop(pub: Pick<Publication, 'id' | 'slug' | 'title'>): string {
  return pub.slug ?? (suggestSlug(pub.title) || pub.id)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The README: what this is, when it was, where its page lives, what is inside. */
export function readmeOf(ctx: ZipContext): Buffer {
  const origin = config.publicUrl.replace(/\/+$/, '')
  const heading = ctx.n !== null ? `${pad2(ctx.n)} · ${ctx.title}` : ctx.title
  const lines = [`# ${heading}`, '']
  if (ctx.day && isClassDay(ctx.day)) {
    const day = formatDay(ctx.day, getLocale(), { year: true })
    lines.push(ctx.n !== null ? tr('server.zip.classDay', { n: pad2(ctx.n), day }) : day, '')
  }
  if (ctx.course) {
    const url = `${origin}/c/${ctx.course.slug ?? ctx.course.id}`
    lines.push(tr('server.zip.course', { name: ctx.course.name, url }), '')
  }
  lines.push(tr('server.zip.page', { url: `${origin}/p/${publicationAddress(ctx.pub)}` }), '')
  lines.push(`## ${tr('server.zip.files')}`, '')
  for (const m of ctx.materials) {
    if (m.kind === 'folder') {
      const folder = `${m.path}/`
      const count = tr('server.zip.folder', { count: m.files?.length ?? 0 })
      const label = m.name && m.name !== folder ? `${m.name}, ${count}` : count
      lines.push(`- \`${folder}\` — ${label}`)
      continue
    }
    const label =
      m.kind === 'notebook'
        ? tr('server.zip.notebook', { name: m.name })
        : m.name && m.name !== m.path
          ? m.name
          : ''
    lines.push(label ? `- \`${m.path}\` — ${label}` : `- \`${m.path}\``)
  }
  lines.push('', tr('server.zip.footer'), '')
  const text = lines.join('\n')
  // Titles and names are typed by people in the room; the id must not ride out in them.
  return Buffer.from(ctx.pub.sessionId ? scrubText(text, ctx.pub.sessionId) : text, 'utf8')
}

function dosStamp(day: string | null): { dosTime: number; dosDate: number } {
  const at = day && isClassDay(day) ? day : instanceToday()
  const year = Math.min(Math.max(Number(at.slice(0, 4)), 1980), 2107)
  const month = Number(at.slice(5, 7))
  const date = Number(at.slice(8, 10))
  // Noon: a midnight stamp shows up as the day before in any zone west of UTC.
  return { dosTime: 12 << 11, dosDate: ((year - 1980) << 9) | (month << 5) | date }
}

/**
 * Everything the archive will hold, with its exact length.
 *
 * `verify` stats every file, and drops one whose bytes are not on disk as
 * the row says (a restore that missed data/page-files): the archive stays
 * valid with one file fewer instead of breaking half-way. Size estimates for
 * the page skip it; the download route asks for it.
 */
export function zipPlan(ctx: ZipContext, options: { verify?: boolean } = {}): ZipPlan {
  const top = zipTop(ctx.pub)
  const files = entriesOf(options.verify === true)
  for (const m of ctx.materials) {
    if (m.kind === 'folder') {
      // At their room paths: `data/train.csv` lands where the notebook reads it.
      for (const file of m.files ?? []) files.add(`${top}/${file.path}`, file.hash)
    } else {
      files.add(`${top}/${m.path}`, m.hash)
    }
  }
  // The room's own README keeps its name; ours steps aside.
  const readmeName = files.has(`${top}/README.md`) ? 'README-colloq.md' : 'README.md'
  const body = readmeOf(ctx)
  const readme = { name: `${top}/${readmeName}`, bytes: body.length, crc: crc32(body), file: null, body }
  return planOf(top, [readme, ...files.list], ctx.day)
}

/**
 * One folder material as its own archive: `data.zip` holding `data/` with
 * every file at its room path, and no README (the folder is a part of a
 * page, not a class). Unzipped next to the notebooks, it is the room's
 * `data/` again.
 */
export function folderZipPlan(
  folder: Pick<MaterialRow, 'path' | 'files'>,
  day: string | null,
  options: { verify?: boolean } = {},
): ZipPlan {
  const files = entriesOf(options.verify === true)
  for (const file of folder.files ?? []) files.add(file.path, file.hash)
  return planOf(folder.path, files.list, day)
}

/** The page files of an archive, each once, ignoring case: unzip on a Mac would merge them. */
function entriesOf(verify: boolean) {
  const list: ZipEntry[] = []
  const used = new Set<string>()
  const has = (name: string): boolean => used.has(name.toLowerCase())
  const add = (name: string, hash: string): void => {
    if (has(name)) return
    const info = pageFileInfo(hash)
    if (!info) return
    const file = pageFilePath(hash)
    if (verify && !onDisk(file, info.bytes)) {
      console.error(`[pages] ${hash} is missing from data/page-files; left out of the archive`)
      return
    }
    used.add(name.toLowerCase())
    list.push({ name, bytes: info.bytes, crc: info.crc32, file, body: null })
  }
  return { list, has, add }
}

function planOf(top: string, entries: ZipEntry[], day: string | null): ZipPlan {
  let bytes = END_RECORD
  for (const entry of entries) {
    const name = Buffer.byteLength(entry.name)
    bytes += LOCAL_HEADER + name + entry.bytes + CENTRAL_HEADER + name
  }
  return { top, entries, bytes, ...dosStamp(day) }
}

function onDisk(file: string, bytes: number): boolean {
  try {
    return fs.statSync(file).size === bytes
  } catch {
    return false
  }
}

function localHeader(plan: ZipPlan, entry: ZipEntry, name: Buffer): Buffer {
  const head = Buffer.alloc(LOCAL_HEADER)
  head.writeUInt32LE(0x04034b50, 0)
  head.writeUInt16LE(VERSION, 4)
  head.writeUInt16LE(UTF8_FLAG, 6)
  head.writeUInt16LE(0, 8)
  head.writeUInt16LE(plan.dosTime, 10)
  head.writeUInt16LE(plan.dosDate, 12)
  head.writeUInt32LE(entry.crc, 14)
  head.writeUInt32LE(entry.bytes, 18)
  head.writeUInt32LE(entry.bytes, 22)
  head.writeUInt16LE(name.length, 26)
  head.writeUInt16LE(0, 28)
  return Buffer.concat([head, name])
}

function centralHeader(plan: ZipPlan, entry: ZipEntry, name: Buffer, offset: number): Buffer {
  const head = Buffer.alloc(CENTRAL_HEADER)
  head.writeUInt32LE(0x02014b50, 0)
  head.writeUInt16LE(MADE_BY, 4)
  head.writeUInt16LE(VERSION, 6)
  head.writeUInt16LE(UTF8_FLAG, 8)
  head.writeUInt16LE(0, 10)
  head.writeUInt16LE(plan.dosTime, 12)
  head.writeUInt16LE(plan.dosDate, 14)
  head.writeUInt32LE(entry.crc, 16)
  head.writeUInt32LE(entry.bytes, 20)
  head.writeUInt32LE(entry.bytes, 24)
  head.writeUInt16LE(name.length, 28)
  head.writeUInt16LE(0, 30)
  head.writeUInt16LE(0, 32)
  head.writeUInt16LE(0, 34)
  head.writeUInt16LE(0, 36)
  head.writeUInt32LE(FILE_MODE, 38)
  head.writeUInt32LE(offset, 42)
  return Buffer.concat([head, name])
}

function endRecord(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(END_RECORD)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return end
}

async function* archive(plan: ZipPlan): AsyncGenerator<Buffer> {
  let offset = 0
  const central: Buffer[] = []
  for (const entry of plan.entries) {
    const name = Buffer.from(entry.name, 'utf8')
    central.push(centralHeader(plan, entry, name, offset))
    yield localHeader(plan, entry, name)
    if (entry.body) {
      yield entry.body
    } else {
      // A file that came out shorter or longer than its row would shift every
      // offset after it: better a cut-off download than a corrupt archive.
      let seen = 0
      for await (const chunk of fs.createReadStream(entry.file!)) {
        seen += (chunk as Buffer).length
        yield chunk as Buffer
      }
      if (seen !== entry.bytes) throw new Error(`${entry.name}: ${seen} bytes, expected ${entry.bytes}`)
    }
    offset += LOCAL_HEADER + name.length + entry.bytes
  }
  const directory = Buffer.concat(central)
  yield directory
  yield endRecord(plan.entries.length, directory.length, offset)
}

/** The archive as a stream; its length is `plan.bytes`. */
export function zipStream(plan: ZipPlan): Readable {
  return Readable.from(archive(plan))
}

/* ------------------------------------------------------------- the gate */

/**
 * At most three archives of one page at a time, and six on the instance.
 *
 * Each one reads up to 200 MB from disk on the class's process, so a class
 * that presses «Скачать всё» together at the end of the lesson must not
 * become thirty streams starving the rooms that are still running.
 *
 * The rest WAIT in line rather than hearing 429 at once. The button is a
 * plain `<a download>`: a refusal shows up in the browser as a failed
 * download, or as the error's JSON saved under `ml-strong-04.zip`, which then
 * will not unzip, and most of the class concludes the archive is broken. A
 * request that waits is a download that starts a little later. Only one that
 * waited ZIP_WAIT_MS hears «через минуту».
 */
export const ZIP_PER_PAGE = 3
export const ZIP_PER_INSTANCE = 6
/** How long a download waits for a slot before it is refused. */
export const ZIP_WAIT_MS = 75_000
/**
 * A stream that moves no bytes this long is dropped, and its slot freed. A
 * paused browser download or a script reading nothing would otherwise hold
 * a slot for as long as it liked, and six of them every slot there is.
 */
export const ZIP_IDLE_MS = 60_000

let waitLimit = ZIP_WAIT_MS

/** The wait in line, for a test that should not sit through 75 seconds; `null` restores it. */
export function setZipWait(ms: number | null): void {
  waitLimit = ms ?? ZIP_WAIT_MS
}

interface Waiter {
  page: string
  admit: () => void
}

const running = new Map<string, number>()
const line: Waiter[] = []
let total = 0

const fits = (page: string): boolean =>
  total < ZIP_PER_INSTANCE && (running.get(page) ?? 0) < ZIP_PER_PAGE

function take(page: string): void {
  running.set(page, (running.get(page) ?? 0) + 1)
  total++
}

/**
 * Let in whoever fits, first come first served. A waiter whose page is full
 * does not hold up one for another page behind it.
 */
function admitWaiting(): void {
  for (let i = 0; i < line.length && total < ZIP_PER_INSTANCE; ) {
    const waiter = line[i]
    if (!fits(waiter.page)) {
      i++
      continue
    }
    line.splice(i, 1)
    take(waiter.page)
    waiter.admit()
  }
}

/** Take a slot for this page now, or `false` when either limit is reached. */
export function enterZip(page: string): boolean {
  if (!fits(page)) return false
  take(page)
  return true
}

/**
 * Take a slot, waiting in line for one. `true` once taken (the caller owes a
 * `leaveZip`); `false` after `waitMs`, or as soon as `signal` aborts (the
 * client went away while it waited).
 */
export function waitForZip(
  page: string,
  options: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (options.signal?.aborted) return Promise.resolve(false)
  if (line.length === 0 && enterZip(page)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const drop = () => {
      const at = line.indexOf(waiter)
      if (at < 0) return
      line.splice(at, 1)
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', drop)
      resolve(false)
    }
    const waiter: Waiter = {
      page,
      admit: () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', drop)
        resolve(true)
      },
    }
    line.push(waiter)
    timer = setTimeout(drop, options.waitMs ?? waitLimit)
    timer.unref?.()
    options.signal?.addEventListener('abort', drop, { once: true })
    // Everyone ahead may be for a full page while this one fits.
    admitWaiting()
  })
}

export function leaveZip(page: string): void {
  const mine = running.get(page) ?? 0
  if (mine <= 0) return
  if (mine === 1) running.delete(page)
  else running.set(page, mine - 1)
  total = Math.max(0, total - 1)
  admitWaiting()
}
