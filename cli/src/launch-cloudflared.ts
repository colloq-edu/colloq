/**
 * cloudflared without a manual install.
 *
 * A Cloudflare quick tunnel is one cloudflared process, and until now one had
 * to install it oneself: `brew install cloudflared`, otherwise host.sh died
 * with a refusal. For a teacher who installed colloq through pip, that is a
 * second installer for the sake of one link, and on Linux without Homebrew a
 * hunt for a package.
 *
 * The search order (resolveCloudflared) goes from explicit to downloaded:
 *   1. COLLOQ_CLOUDFLARED=/path: the person named the file themselves, and we
 *      trust it;
 *   2. cloudflared in PATH: installed by hand (brew, a system package);
 *   3. <home>/bin/cloudflared: our copy, and only if its bytes match the
 *      pinned sum (launch-cloudflared-pin.ts);
 *   4. otherwise we download the pinned release from GitHub into <home>/bin.
 * COLLOQ_CLOUDFLARED_DOWNLOAD=0 forbids the fourth step: machines that
 * download nothing from the network get a refusal in words, not a quiet
 * download.
 *
 * What was downloaded runs only after checking: the archive sum before
 * unpacking, the executable's sum after it and once more from disk, before
 * chmod +x. An unchecked file never gets execute permission, not for an
 * instant: it is written 0600 under a temporary name and becomes cloudflared
 * with a single rename, already checked.
 *
 * Only node's built-in modules here: the CLI bundle pulls in no dependencies
 * (scripts/pack.mts checks this), and tar and curl are not the same
 * everywhere, so the single-entry archive is parsed in twenty lines below.
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

/** Advice that fits any refusal: install it yourself or name the file. */
export const INSTALL_HINT =
  'Install cloudflared yourself (brew install cloudflared, or a package from ' +
  CLOUDFLARED_RELEASES +
  ') or name the file: COLLOQ_CLOUDFLARED=/path/to/cloudflared.'

const SYSTEMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux' }

export function cloudflaredUrl(asset: CloudflaredAsset, version = CLOUDFLARED_VERSION): string {
  return `${CLOUDFLARED_RELEASES}/download/${version}/${asset.name}`
}

/**
 * The release file for this machine, or a refusal that says what to do.
 *
 * Windows is refused in words of its own: the pip wheel is built for macOS
 * and Linux, the supervisor publishes through a bash script, and
 * cloudflared.exe alone would give nothing. WSL 2 is Linux, and there
 * everything works as on Linux.
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

/** Checking the sum. The refusal names both sums: that shows whether it is a swap or a cut-off. */
export function verifySha256(data: Uint8Array, expected: string, what: string): void {
  const actual = sha256(data)
  if (actual !== expected)
    throw new Error(
      `${what}: the sha256 does not match the pinned one (expected ${expected}, got ${actual}). ` +
        'Nothing was saved or run.',
    )
}

/**
 * One regular file from a tar, by name, without the directories around it.
 *
 * The cloudflared archive for macOS is a ustar with a single `cloudflared`
 * entry. The parser knows exactly what occurs in tars from bsdtar and GNU
 * tar: the ustar prefix, the GNU long name (L) and the pax path (x).
 * Everything else is skipped, and an entry with another name is never taken:
 * only the file named cloudflared becomes executable, and only after its sum
 * is checked.
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

/** Downloaded file → executable, with both checks. Throws before anything is written to disk. */
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
  /** Where colloq puts its copy: <home>/bin. */
  binDir: string
  /** Whether the file exists and can be run. */
  executable(file: string): boolean
  /** The file's sha256, or null if it cannot be read. */
  hashOf(file: string): string | null
  assets?: readonly CloudflaredAsset[]
}

/** Where to get cloudflared, without a single action; ensureCloudflared carries out the decision. */
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
    // We do not take our own directory from PATH: our copy runs only once
    // checked (below), and PATH must not be a way around that check.
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
 * Download from GitHub, no more than the pinned size, reporting progress out
 * loud.
 *
 * Forty megabytes on a slow network take a minute or two, and a silent minute
 * reads as "it hung" (the shim says the same about the first npm install). So
 * progress is printed in quarters, and what we wait for is not an overall
 * deadline but silence: a minute without a single byte is a cut-off, while a
 * long but progressing download is not.
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
    // "fetch failed" says nothing; the reason is in cause (DNS, TLS, a cut-off).
    const cause = (error as { cause?: unknown }).cause
    const reason = cause instanceof Error ? cause.message : (error as Error).message
    throw new Error(`Could not download ${asset.name}: ${reason}`)
  } finally {
    if (quiet) clearTimeout(quiet)
    cancel?.removeEventListener('abort', abort)
    // We do not keep a connection abandoned halfway: otherwise a refusal over
    // the size or the status would keep reading the file into the void.
    controller.abort()
  }
}

/** Write the checked bytes: 0600 under a temporary name, a check from disk, chmod, rename. */
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
  /** The state directory: the copy goes into <home>/bin. */
  home: string
  env: Record<string, string | undefined>
  /** Where to speak: the supervisor, to the terminal; host.sh wants the path on stdout, words on stderr. */
  say(line: string): void
  platform?: string
  arch?: string
  fetch?: typeof fetch
  assets?: readonly CloudflaredAsset[]
  /** Ctrl+C in the middle of the download. */
  signal?: AbortSignal
}

/** The path to a cloudflared that can be trusted with the tunnel; downloading it if needed. */
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
