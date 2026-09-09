import { tr } from '@shared/i18n'
/**
 * Starting a seminar from a notebook that already exists on GitHub.
 *
 * A teacher's material is almost never in this product yet — it is in a course
 * repository, one notebook per week, with the CSV the notebook reads sitting
 * next to it. Asking them to re-create that by hand is asking them not to use
 * the tool. So a link is enough: paste the GitHub URL of a notebook or of the
 * week's folder, and the room opens with the cells already in it and the data
 * files already in the workspace.
 *
 * Two things this deliberately does NOT bring across.
 *
 * Outputs are dropped. A committed notebook carries last run's outputs — plots,
 * tracebacks, a 1.8 MB base64 image — and importing them would put a document
 * every student has to download in front of a seminar that has not started.
 * Worse, it would show answers before anyone has run anything. The cells arrive
 * exactly as a teacher would want them on the projector: written, not yet run.
 *
 * Nothing is authenticated. Public repositories only, no token, no OAuth. A
 * course repository is public or it is not this feature's business, and the
 * moment this asked for a token it would become a thing to administer.
 */
import { LIMITS } from '@shared/admin'
import { readIpynb, type FlatCell } from '@shared/ipynb'

/* --------------------------------------------------------------- the URL */

export interface GithubTarget {
  owner: string
  repo: string
  /** Branch, tag or commit. GitHub calls it a ref and so does the API. */
  ref: string
  /** Path inside the repository. Empty string means the repository root. */
  path: string
  kind: 'file' | 'dir'
}

/*
 * Only the two shapes a person actually copies out of the address bar. The API
 * URL form (api.github.com/repos/...) is deliberately not accepted: nobody has
 * one in their clipboard, and pretending to support it would mean guessing at
 * shapes we have never seen.
 */
const BLOB = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/
const TREE = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/
const BARE = /^\/([^/]+)\/([^/]+)\/?$/

export function parseGithubUrl(input: string): GithubTarget | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null

  /*
   * A trailing #cell or ?plain=1 is what you get from GitHub's own UI.
   *
   * Decoding is guarded, not just parsing: the WHATWG parser lets a lone `%`
   * through the path (`95%_CI.ipynb`, copied out of a chat rather than the
   * address bar), and decodeURIComponent throws URIError on it. Thrown from an
   * async handler under Express 4 that is not an error page — it is a request
   * that never answers, and a preview spinner that turns forever.
   */
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname.replace(/\/+$/, '') || '/')
  } catch {
    return null
  }

  const blob = BLOB.exec(pathname)
  if (blob) {
    return { owner: blob[1], repo: blob[2], ref: blob[3], path: blob[4], kind: 'file' }
  }
  const tree = TREE.exec(pathname)
  if (tree) {
    return { owner: tree[1], repo: tree[2], ref: tree[3], path: tree[4] ?? '', kind: 'dir' }
  }
  const bare = BARE.exec(pathname)
  if (bare) {
    // No ref in the URL, so the repository's default branch is the only honest
    // guess — the API resolves an empty ref to it.
    return { owner: bare[1], repo: bare[2].replace(/\.git$/, ''), ref: '', path: '', kind: 'dir' }
  }
  return null
}

/** A name for the seminar, taken from what was linked. */
export function seminarNameFor(target: GithubTarget): string {
  const last = target.path.split('/').filter(Boolean).pop()

  /*
   * Only a notebook's filename gets tidied. `01_HSE_PE_Intro_to_Python.ipynb`
   * is filename grammar — a sort index and underscores standing in for spaces —
   * and reads as a title once both are gone.
   *
   * A folder and a repository are NOT tidied, because their names are chosen,
   * not generated: `week02` is what the teacher calls that week, and turning
   * `ml_hse` into "ml hse" replaces a name with a misspelling of it.
   */
  if (last && /\.ipynb$/i.test(last)) {
    const bare = last.replace(/\.ipynb$/i, '')
    const pretty = bare.replace(/^\d+[-_.]\s*/, '').replace(/[_-]+/g, ' ').trim()
    return (pretty.length > 0 ? pretty : bare).slice(0, LIMITS.seminarName)
  }
  return (last ?? target.repo).slice(0, LIMITS.seminarName)
}

/* ------------------------------------------------------------ the notebook */

/*
 * Разбор .ipynb здесь больше не живёт.
 *
 * Он был написан тут первым, потом переехал в shared/ipynb.ts — и копия
 * осталась строка в строку. Две функции, читающие один формат, расходятся
 * молча: правка «не выбрасывать пустую ячейку из середины» попадала бы в одну
 * из них, и тетрадь, открытая из комнаты, отличалась бы от той же тетради,
 * привезённой импортом. Имена ниже — переходник для тех, кто звал старое;
 * разбор один, и он в shared.
 */
export type ImportedCell = FlatCell
export const notebookCells = readIpynb

/* ------------------------------------------------------------- what to take */

export interface RepoEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number
  downloadUrl: string | null
}

/**
 * Which files from a folder belong in the seminar's workspace.
 *
 * Not everything: a course folder holds READMEs, images for the README, and
 * sometimes a whole solutions subfolder. What a notebook needs at runtime is
 * data, and data is what gets copied. Subdirectories are skipped rather than
 * walked — a recursive import of somebody's course repository is a surprise,
 * not a feature.
 *
 * `py` в этом списке не по недосмотру: `utils.py`, `helpers.py`, `plotting.py`
 * рядом с тетрадью — то же самое, что и данные. Первая ячейка учебной тетради
 * — `from utils import show`, и без модуля она не запускается: без него импорт
 * молчит (файла просто нет в предпросмотре), а на паре у всей комнаты разом
 * выходит ModuleNotFoundError. Подкаталог `solutions/` при этом по-прежнему не
 * едет — он подкаталог.
 */
const DATA_EXTENSIONS = new Set([
  'csv', 'tsv', 'json', 'jsonl', 'txt', 'npy', 'npz', 'parquet', 'pkl',
  'xlsx', 'xls', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'zip', 'yaml', 'yml',
  'py',
])

export function filesToTake(entries: RepoEntry[], maxBytes: number): RepoEntry[] {
  return entries.filter((e) => {
    if (e.type !== 'file' || !e.downloadUrl) return false
    if (e.name.toLowerCase().endsWith('.ipynb')) return false
    if (e.size > maxBytes) return false
    const ext = e.name.split('.').pop()?.toLowerCase() ?? ''
    return DATA_EXTENSIONS.has(ext)
  })
}

/** The notebook a folder is about: the only one, or the first by name. */
export function pickNotebook(entries: RepoEntry[]): RepoEntry | null {
  const books = entries
    .filter((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.ipynb'))
    .sort((a, b) => a.name.localeCompare(b.name))
  return books[0] ?? null
}

/* ----------------------------------------------------------------- fetching */

const API = 'https://api.github.com'

/**
 * «Нет такого» отдельным типом — по нему решают, стоит ли переспросить.
 *
 * 404 у GitHub — единственный ответ, за которым может стоять не отсутствие, а
 * неверно разобранная ссылка (см. `resolveRef`). Все остальные отказы — лимит,
 * пятисотка, оборванная сеть — переспрашивать бессмысленно.
 */
class GithubMissing extends Error {}

/**
 * GitHub rate-limits anonymous callers by IP, at sixty requests an hour. An
 * import costs two or three, so a teacher will not notice — but the error when
 * it happens is a 403 with a JSON body, and saying "GitHub said no" without
 * saying why would send somebody hunting through their own network.
 */
async function ghJson(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'colloq' },
    signal: AbortSignal.timeout(20_000),
  })
  /*
   * 404 здесь значит и «нет такого», и «есть, но не для вас».
   *
   * Приватному репозиторию GitHub отвечает анонимному запросу именно 404, а не
   * 403: иначе по коду ответа можно было бы перебирать чужие названия. Для
   * преподавателя, который скопировал ссылку из адресной строки браузера, где
   * он в свой репозиторий залогинен, «GitHub has nothing at that address» —
   * это неправда, и он идёт искать опечатку там, где её нет.
   */
  if (res.status === 404) {
    throw new GithubMissing(
      tr("server.githubHasNothingAtThatAddressOr.e7b0f0") +
        tr("server.thisServerReadsGithubAnonymouslySoA.6f5e7a") +
        tr("server.checkTheLinkAndIfItIs.53f905"),
    )
  }
  if (res.status === 403) {
    throw new Error(
      tr("server.githubIsRateLimitingThisServerSixty.13314c"),
    )
  }
  if (!res.ok) throw new Error(tr("server.githubAnswered.ac167e", { p0: res.status }))
  return res.json()
}

/**
 * Ветка со слэшем: `release/2024`, `feature/x`, `students/2026-fall`.
 *
 * Адрес такой ветки в браузере выглядит ровно как адрес обычной —
 * `/o/r/tree/release/2024/week1`, — и по нему не видно, где кончается имя ветки
 * и начинается путь. Разбор берёт первый сегмент, GitHub отвечает 404 на
 * `week1?ref=release`, а `ghJson` переводит это в «нет такого или репозиторий
 * приватный»: преподаватель идёт искать опечатку в ссылке, с которой всё в
 * порядке, или делать публичным репозиторий, который и так публичный.
 *
 * Догадка стоит одного запроса и делается только после 404 — анонимных
 * запросов к GitHub шестьдесят в час, тратить их на догадку при живом ответе
 * незачем. Берётся самая длинная ветка, которой начинается «ref/path»:
 * `release/2024` бьёт `release`, а `release/2024/hotfix` — обоих. Дальше сотни
 * веток список не идёт: сотая ветка в курсовом репозитории — это уже не тот
 * случай, ради которого стоит платить второй страницей.
 *
 * Возвращает исходную цель, когда догадываться не о чем, — тогда наверх уходит
 * первоначальный отказ, а не выдуманный.
 */
export async function resolveRef(target: GithubTarget): Promise<GithubTarget> {
  if (!target.ref || !target.path) return target
  const whole = `${target.ref}/${target.path}`

  let names: string[]
  try {
    const json = await ghJson(
      `/repos/${target.owner}/${target.repo}/branches?per_page=100`,
    )
    if (!Array.isArray(json)) return target
    names = (json as Record<string, unknown>[])
      .map((b) => String(b.name ?? ''))
      .filter((name) => name.includes('/'))
  } catch {
    // Догадка — не обязанность: приватный репозиторий, лимит, оборванная сеть.
    return target
  }

  let best: string | null = null
  for (const name of names) {
    if (whole !== name && !whole.startsWith(`${name}/`)) continue
    if (!best || name.length > best.length) best = name
  }
  if (!best) return target
  return { ...target, ref: best, path: whole.slice(best.length + 1) }
}

export async function listDirectory(target: GithubTarget): Promise<RepoEntry[]> {
  try {
    return await listAt(target)
  } catch (err) {
    if (!(err instanceof GithubMissing)) throw err
    const fixed = await resolveRef(target)
    if (fixed.ref === target.ref) throw err
    return listAt(fixed)
  }
}

async function listAt(target: GithubTarget): Promise<RepoEntry[]> {
  const ref = target.ref ? `?ref=${encodeURIComponent(target.ref)}` : ''
  const json = await ghJson(
    `/repos/${target.owner}/${target.repo}/contents/${target.path}${ref}`,
  )
  if (!Array.isArray(json)) throw new Error(tr("server.thatLinkPointsAtAFileNot.906633"))
  return (json as Record<string, unknown>[]).map((e) => ({
    name: String(e.name ?? ''),
    path: String(e.path ?? ''),
    type: e.type === 'dir' ? 'dir' : 'file',
    size: Number(e.size ?? 0),
    downloadUrl: typeof e.download_url === 'string' ? e.download_url : null,
  }))
}

/**
 * Тетрадь по ссылке на файл — с той же поправкой на ветку со слэшем.
 *
 * `raw.githubusercontent.com` разбирает `<ref>/<path>` своими правилами и на
 * ветке со слэшем отвечает 404 так же, как API; разница только в том, что
 * ошибка звучит «Could not download … (404)». Второй заход — после запроса
 * веток, и только если ветка правда нашлась.
 */
export async function fetchNotebook(target: GithubTarget, maxBytes: number): Promise<Buffer> {
  try {
    return await fetchRaw(rawUrlFor(target), maxBytes)
  } catch (err) {
    if (!(err instanceof GithubMissing)) throw err
    const fixed = await resolveRef(target)
    if (fixed.ref === target.ref) throw err
    return fetchRaw(rawUrlFor(fixed), maxBytes)
  }
}

export async function fetchRaw(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'colloq' },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const message = tr("server.couldNotDownload.d09a9d", { p0: url, p1: res.status })
    throw res.status === 404 ? new GithubMissing(message) : new Error(message)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > maxBytes) {
    throw new Error(tr("server.thatFileIsLargerThanTheMb.1e9617", { p0: Math.round(maxBytes / 1e6) }))
  }
  return buf
}

export function rawUrlFor(target: GithubTarget): string {
  const ref = target.ref || 'HEAD'
  return `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${ref}/${target.path}`
}
