/**
 * cloudflared без ручной установки.
 *
 * Быстрый туннель Cloudflare — это один процесс cloudflared, и до сих пор его
 * надо было поставить самому: `brew install cloudflared`, иначе host.sh
 * умирал отказом. Для преподавателя, который поставил colloq через pip, это
 * второй установщик ради одной ссылки, а на Linux без Homebrew — поиск пакета.
 *
 * Порядок поиска (resolveCloudflared) — от явного к скачанному:
 *   1. COLLOQ_CLOUDFLARED=/путь — человек назвал файл сам; ему и верим;
 *   2. cloudflared в PATH — поставленный руками (brew, пакет системы);
 *   3. <home>/bin/cloudflared — наша копия, и только если её байты совпадают
 *      с закреплённой суммой (launch-cloudflared-pin.ts);
 *   4. иначе скачиваем закреплённый выпуск с GitHub в <home>/bin.
 * COLLOQ_CLOUDFLARED_DOWNLOAD=0 запрещает четвёртый шаг: машины, где из сети
 * ничего не качают, получают отказ со словами, а не тихую загрузку.
 *
 * Скачанное запускается только после сверки: сумма архива — до распаковки,
 * сумма исполняемого файла — после неё и ещё раз с диска, до chmod +x.
 * Непроверенный файл не получает права на запуск ни на миг: пишется 0600 под
 * временным именем и становится cloudflared одним rename, уже проверенным.
 *
 * Здесь только встроенные модули node: бандл CLI не тянет зависимостей
 * (scripts/pack.mts это проверяет), а tar и curl есть не везде одинаковые —
 * архив в одну запись разбирается двадцатью строками ниже.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  type CloudflaredAsset,
} from './launch-cloudflared-pin.js'

export const CLOUDFLARED_RELEASES = 'https://github.com/cloudflare/cloudflared/releases'

/** Совет, который годится при любом отказе: поставить самому или назвать файл. */
export const INSTALL_HINT =
  'Install cloudflared yourself (brew install cloudflared, or a package from ' +
  CLOUDFLARED_RELEASES +
  ') or name the file: COLLOQ_CLOUDFLARED=/path/to/cloudflared.'

const SYSTEMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux' }

export function cloudflaredUrl(asset: CloudflaredAsset, version = CLOUDFLARED_VERSION): string {
  return `${CLOUDFLARED_RELEASES}/download/${version}/${asset.name}`
}

/**
 * Файл выпуска для этой машины — или отказ, который говорит, что делать.
 *
 * Windows отказываем отдельными словами: колесо pip собирается для macOS и
 * Linux, супервизор публикует через bash-скрипт, и cloudflared.exe один
 * ничего бы не дал. WSL 2 — это Linux, и там всё работает как на Linux.
 */
export function pickCloudflaredAsset(
  platform: string,
  arch: string,
  assets: readonly CloudflaredAsset[] = CLOUDFLARED_ASSETS,
): CloudflaredAsset {
  if (platform === 'win32')
    throw new Error(
      'Sharing a class from Windows is not supported: colloq runs on macOS and Linux. ' +
        'Run it inside WSL 2 (Ubuntu on Windows), where it works as on Linux.',
    )
  const asset = assets.find((item) => item.platform === platform && item.arch === arch)
  if (!asset)
    throw new Error(
      `colloq has no pinned cloudflared build for ${SYSTEMS[platform] ?? platform} ${arch}. ` +
        INSTALL_HINT,
    )
  return asset
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Сверка суммы. Отказ называет обе суммы: так видно, подмена это или обрыв. */
export function verifySha256(data: Uint8Array, expected: string, what: string): void {
  const actual = sha256(data)
  if (actual !== expected)
    throw new Error(
      `${what}: the sha256 does not match the pinned one (expected ${expected}, got ${actual}). ` +
        'Nothing was saved or run.',
    )
}

/**
 * Один обычный файл из tar — по имени, без каталогов вокруг.
 *
 * Архив cloudflared для macOS — ustar с единственной записью `cloudflared`.
 * Разбор знает ровно то, что встречается в tar от bsdtar и GNU tar: префикс
 * ustar, длинное имя GNU (L) и путь из pax (x). Всё прочее пропускается, а
 * запись с другим именем не берётся никогда: исполняемым станет только файл,
 * названный cloudflared, — и только после сверки его суммы.
 */
export function untarFile(tar: Uint8Array, wanted: string): Buffer {
  const data = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength)
  let at = 0
  let nextName: string | null = null
  while (at + 512 <= data.length) {
    const header = data.subarray(at, at + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start: number, length: number): string => {
      const raw = header.subarray(start, start + length)
      const end = raw.indexOf(0)
      return raw.subarray(0, end === -1 ? length : end).toString('utf8')
    }
    const size = parseInt(field(124, 12).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('The archive is damaged.')
    const body = at + 512
    if (body + size > data.length) throw new Error('The archive is cut short.')
    const type = header[156]
    const content = data.subarray(body, body + size)
    const prefix = field(345, 155)
    const name = nextName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    nextName = null
    if (type === 0x4c /* L */) nextName = content.toString('utf8').replace(/\0+$/, '')
    else if (type === 0x78 /* x */)
      nextName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(content.toString('utf8'))?.[1] ?? null
    else if ((type === 0x30 /* 0 */ || type === 0) && name.replace(/^\.\//, '') === wanted)
      return Buffer.from(content)
    at = body + Math.ceil(size / 512) * 512
  }
  throw new Error(`There is no ${wanted} inside the archive.`)
}

/** Скачанный файл → исполняемый, с обеими сверками. Бросает до всякой записи на диск. */
export function cloudflaredBinary(asset: CloudflaredAsset, downloaded: Uint8Array): Buffer {
  verifySha256(downloaded, asset.sha256, asset.name)
  const binary =
    asset.archive === 'tgz'
      ? untarFile(gunzipSync(downloaded), 'cloudflared')
      : Buffer.from(downloaded)
  verifySha256(binary, asset.binarySha256, `cloudflared from ${asset.name}`)
  return binary
}

export type CloudflaredResolution =
  | { kind: 'use'; path: string; source: 'override' | 'path' | 'colloq' }
  | { kind: 'download'; asset: CloudflaredAsset; stale: boolean }
  | { kind: 'refuse'; message: string }

export interface CloudflaredLookup {
  env: Record<string, string | undefined>
  platform: string
  arch: string
  /** Куда colloq кладёт свою копию: <home>/bin. */
  binDir: string
  /** Есть ли файл и можно ли его запустить. */
  executable(file: string): boolean
  /** sha256 файла или null, если его не прочесть. */
  hashOf(file: string): string | null
  assets?: readonly CloudflaredAsset[]
}

/** Где взять cloudflared — без единого действия; решение исполняет ensureCloudflared. */
export function resolveCloudflared(lookup: CloudflaredLookup): CloudflaredResolution {
  const named = (lookup.env.COLLOQ_CLOUDFLARED ?? '').trim()
  if (named) {
    if (!path.isAbsolute(named))
      return {
        kind: 'refuse',
        message: `COLLOQ_CLOUDFLARED must be an absolute path to the file, not "${named}".`,
      }
    if (!lookup.executable(named))
      return {
        kind: 'refuse',
        message: `COLLOQ_CLOUDFLARED names ${named}, and that is not an executable file.`,
      }
    return { kind: 'use', path: named, source: 'override' }
  }
  const ours = path.join(lookup.binDir, 'cloudflared')
  for (const dir of (lookup.env.PATH ?? '').split(path.delimiter)) {
    // Свой каталог из PATH не берём: наша копия запускается только сверенной
    // (ниже), и PATH не должен быть обходом этой сверки.
    if (!dir || !path.isAbsolute(dir) || path.resolve(dir) === path.resolve(lookup.binDir)) continue
    const candidate = path.join(dir, 'cloudflared')
    if (lookup.executable(candidate)) return { kind: 'use', path: candidate, source: 'path' }
  }
  let asset: CloudflaredAsset
  try {
    asset = pickCloudflaredAsset(lookup.platform, lookup.arch, lookup.assets)
  } catch (error) {
    return { kind: 'refuse', message: (error as Error).message }
  }
  const present = lookup.executable(ours)
  if (present && lookup.hashOf(ours) === asset.binarySha256)
    return { kind: 'use', path: ours, source: 'colloq' }
  if (lookup.env.COLLOQ_CLOUDFLARED_DOWNLOAD?.trim() === '0')
    return {
      kind: 'refuse',
      message:
        (present
          ? `${ours} is not the pinned cloudflared ${CLOUDFLARED_VERSION}`
          : 'cloudflared is not installed') +
        ', and downloading is switched off (COLLOQ_CLOUDFLARED_DOWNLOAD=0). ' +
        INSTALL_HINT,
    }
  return { kind: 'download', asset, stale: present }
}

/**
 * Скачать с GitHub, не больше закреплённого размера, говоря о ходе вслух.
 *
 * Сорок мегабайт на медленной сети — минута-другая, и молчаливая минута
 * читается как «зависло» (то же сказано у шима про первый npm install).
 * Поэтому ход печатается четвертями, а ждём мы не общий срок, а тишину:
 * минута без единого байта — обрыв, а долгая, но идущая загрузка — нет.
 */
async function download(
  url: string,
  asset: CloudflaredAsset,
  fetchImpl: typeof fetch,
  say: (line: string) => void,
  cancel?: AbortSignal,
): Promise<Buffer> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  cancel?.addEventListener('abort', abort, { once: true })
  let quiet: ReturnType<typeof setTimeout> | undefined
  const idle = (): void => {
    if (quiet) clearTimeout(quiet)
    quiet = setTimeout(abort, 60000)
  }
  try {
    idle()
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || !response.body)
      throw new Error(`GitHub answered ${response.status} for ${url}.`)
    const chunks: Buffer[] = []
    let received = 0
    let told = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      idle()
      received += value.byteLength
      if (received > asset.size)
        throw new Error(`${asset.name} is larger than the pinned ${asset.size} bytes.`)
      chunks.push(Buffer.from(value))
      const quarter = Math.floor((received / asset.size) * 4)
      if (quarter > told && quarter < 4) {
        told = quarter
        say(`  … ${quarter * 25}%`)
      }
    }
    return Buffer.concat(chunks, received)
  } catch (error) {
    if (cancel?.aborted) throw new Error('The download was cancelled.')
    if (controller.signal.aborted) throw new Error('The download stalled: no data for a minute.')
    // «fetch failed» ничего не говорит; причина — в cause (DNS, TLS, обрыв).
    const cause = (error as { cause?: unknown }).cause
    const reason = cause instanceof Error ? cause.message : (error as Error).message
    throw new Error(`Could not download ${asset.name}: ${reason}`)
  } finally {
    if (quiet) clearTimeout(quiet)
    cancel?.removeEventListener('abort', abort)
    // Брошенное на полпути соединение не держим: отказ по размеру или
    // статусу иначе дочитывал бы файл в пустоту.
    controller.abort()
  }
}

/** Записать сверенные байты: 0600 под временным именем, сверка с диска, chmod, rename. */
function install(binDir: string, binary: Buffer, expected: string): string {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 })
  const file = path.join(binDir, 'cloudflared')
  const temporary = path.join(binDir, `.cloudflared-${process.pid}-${randomUUID()}`)
  try {
    fs.writeFileSync(temporary, binary, { mode: 0o600, flag: 'wx' })
    verifySha256(fs.readFileSync(temporary), expected, temporary)
    fs.chmodSync(temporary, 0o755)
    fs.renameSync(temporary, file)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
  return file
}

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function hashOf(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return null
  }
}

export interface EnsureOptions {
  /** Каталог состояния: копия ложится в <home>/bin. */
  home: string
  env: Record<string, string | undefined>
  /** Куда говорить: супервизор — в терминал, host.sh ждёт путь в stdout и берёт слова из stderr. */
  say(line: string): void
  platform?: string
  arch?: string
  fetch?: typeof fetch
  assets?: readonly CloudflaredAsset[]
  /** Ctrl+C посреди загрузки. */
  signal?: AbortSignal
}

/** Путь к cloudflared, которому можно доверить туннель; при нужде — скачав его. */
export async function ensureCloudflared(options: EnsureOptions): Promise<string> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const binDir = path.join(options.home, 'bin')
  const decision = resolveCloudflared({
    env: options.env,
    platform,
    arch,
    binDir,
    executable,
    hashOf,
    assets: options.assets,
  })
  if (decision.kind === 'use') return decision.path
  if (decision.kind === 'refuse') throw new Error(decision.message)
  const { asset } = decision
  const url = cloudflaredUrl(asset)
  options.say(
    decision.stale
      ? `The cloudflared in ${binDir} is not the pinned ${CLOUDFLARED_VERSION} build: fetching it again.`
      : 'cloudflared is not installed: colloq fetches it once, for this and every later link.',
  )
  options.say(
    `  cloudflared ${CLOUDFLARED_VERSION} for ${SYSTEMS[asset.platform]} ${asset.arch}, ` +
      `${(asset.size / 1e6).toFixed(0)} MB, from ${url}`,
  )
  const downloaded = await download(
    url,
    asset,
    options.fetch ?? fetch,
    options.say,
    options.signal,
  )
  const binary = cloudflaredBinary(asset, downloaded)
  const file = install(binDir, binary, asset.binarySha256)
  options.say(`  sha256 matches the pinned one; saved as ${file}`)
  return file
}
