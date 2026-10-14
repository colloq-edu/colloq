/**
 * Which image an environment revision is, in terms another machine can check.
 *
 * A revision pins the image a submission runs in by its local id
 * (EnvironmentRevision.imageDigest, `.Id` of `docker image inspect`). That id
 * means nothing on another machine: the classic image store gives an image the
 * digest of its config, the containerd store the digest of its manifest or
 * index, so the same image pulled onto two machines can carry two different
 * ids, and an image built here has no id anyone else can ask a registry for.
 * Two things travel instead, both read off the same inspect:
 *
 *   - `registryRef`, `repo@sha256:…` from RepoDigests: what another machine
 *     pulls. Only an image that came from a registry (or was pushed to one)
 *     has it; a revision without it runs on this server only.
 *   - `layers`, the sha256 of the platform and RootFS.Layers: what the machine
 *     checks after the pull, before anything runs there. RootFS.Layers are the
 *     diff ids, the digests of the uncompressed layers written in the image's
 *     own config, and both stores report them alike.
 *
 * Pure and without imports of the server, on purpose: the machines that run
 * submissions compute the same fingerprint over their own inspect, and their
 * process loads neither the database nor anything that starts work on import.
 */
import { createHash } from 'node:crypto'

/** What an image is, in words another machine can check; `null` — not known. */
export interface ImageIdentity {
  registryRef: string | null
  layers: string | null
}

/** The registry the published kernels live in, unless the operator names another. */
export const PUBLISHED_KERNEL_REPO = 'ghcr.io/colloq-edu/colloq-kernel'

const DIFF_ID = /^sha256:[a-f0-9]{64}$/
const PLATFORM_PART = /^[a-z0-9_]{1,16}$/
/** More layers than any image has (overlay2 stops at 128), fewer than would make the text long. */
const LAYERS_MAX = 256
const DIGEST = /^sha256:[a-f0-9]{64}$/
// The reference grammar of distribution/reference, in the two halves docker prints.
const DOMAIN = /^(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])(?:\.(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]))*(?::[0-9]{1,5})?$/
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/

/**
 * The fingerprint of an image: its platform and its uncompressed layers, in
 * order. The platform is in it as os/architecture only: the layers already pin
 * every byte, and a variant one store reports and the other leaves out (arm64
 * and arm64/v8 are one platform) would turn the same image into two.
 *
 * The text hashed is the one a machine that runs submissions hashes over its
 * own inspect after the pull, and the two must never drift: change it and every
 * pin stored so far stops matching any image. Its first line names the scheme,
 * so it can never equal another text this code hashes, and a newline ends every
 * layer, so it reads one way only.
 */
export function layersFingerprint(os: string, architecture: string, diffIds: readonly string[]): string {
  return createHash('sha256').update(`colloq.remote.layers.v1\n${os}/${architecture}\n${diffIds.map((id) => `${id}\n`).join('')}`).digest('hex')
}

/**
 * The repository an image of ours is published to: KERNEL_IMAGE_REPO when the
 * operator set one (deploy/vast/entrypoint.sh · kernel_pull_ref reads the same
 * variable), else the one this server's image was built with
 * (COLLOQ_KERNEL_REPO), else the public one. `none` is the operator's word for
 * "every environment is built here": no repository is preferred then.
 */
export function kernelImageRepo(env: NodeJS.ProcessEnv = process.env): string | null {
  const asked = (env.KERNEL_IMAGE_REPO ?? '').trim()
  if (asked === 'none') return null
  return asked || (env.COLLOQ_KERNEL_REPO ?? '').trim() || PUBLISHED_KERNEL_REPO
}

/** The first component of a repository names a registry when docker would read it as one. */
function hasRegistry(repo: string): boolean {
  const slash = repo.indexOf('/')
  if (slash < 0) return false
  const first = repo.slice(0, slash)
  return first.includes('.') || first.includes(':') || first === 'localhost'
}

/** A registry another machine could reach: one that names itself, and not this machine's loopback. */
function portable(repo: string): boolean {
  if (!hasRegistry(repo)) return false
  const host = repo.slice(0, repo.indexOf('/')).replace(/:[0-9]+$/, '').toLowerCase()
  return host !== 'localhost' && !host.startsWith('127.')
}

/**
 * A repository as docker resolves it: `colloq-kernel` is
 * docker.io/library/colloq-kernel, `org/kernels` is docker.io/org/kernels.
 * RepoDigests print Docker Hub in that short form.
 */
function qualified(repo: string): string {
  if (hasRegistry(repo)) {
    const slash = repo.indexOf('/')
    return repo.slice(0, slash).toLowerCase() === 'index.docker.io' ? `docker.io${repo.slice(slash)}` : repo
  }
  return `docker.io/${repo.includes('/') ? repo : `library/${repo}`}`
}

/** A RepoDigests entry split into its repository and digest, or null when it is not one. */
function digested(entry: unknown): { repo: string; digest: string } | null {
  if (typeof entry !== 'string' || entry.length > 512) return null
  const at = entry.lastIndexOf('@')
  if (at <= 0) return null
  const repo = entry.slice(0, at)
  const digest = entry.slice(at + 1)
  if (!DIGEST.test(digest)) return null
  const parts = repo.split('/')
  const path = hasRegistry(repo) ? parts.slice(1) : parts
  if (hasRegistry(repo) && !DOMAIN.test(parts[0]!)) return null
  if (path.length === 0 || !path.every((part) => PATH_COMPONENT.test(part))) return null
  return { repo, digest }
}

/**
 * Where another machine can pull exactly this image, from `docker image
 * inspect`'s RepoDigests, or `null`.
 *
 * The preferred repository's entry first (kernelImageRepo): an image pulled
 * from the published kernels and pushed to a mirror as well is the published
 * one. Otherwise the first entry that names its registry, other than this
 * machine's loopback, which no other machine reaches. An entry without a
 * registry is Docker Hub in docker's short form, or, in the containerd store,
 * simply the local name of an image built here (that store prints every name
 * of an image with its digest, `colloq-kernel@sha256:…` included), so such an
 * entry counts only as the preferred repository itself. A wrong `null` costs
 * a revision that runs at home; a wrong reference costs machines that pull
 * something else, or nothing, under it.
 */
export function registryRefOf(repoDigests: unknown, preferred: string | null = kernelImageRepo()): string | null {
  const entries = (Array.isArray(repoDigests) ? repoDigests : []).map(digested).filter((entry) => entry !== null)
  const wanted = preferred ? qualified(preferred) : null
  const chosen = (wanted ? entries.find((entry) => qualified(entry.repo) === wanted) : undefined)
    ?? entries.find((entry) => portable(entry.repo))
  return chosen ? `${qualified(chosen.repo)}@${chosen.digest}` : null
}

/**
 * The identity of one element of `docker image inspect` (the array's object):
 * the registry reference, and the fingerprint of the layers when RootFS lists
 * them. Anything malformed is `null`, never a guess.
 */
export function imageIdentity(inspect: unknown, preferred: string | null = kernelImageRepo()): ImageIdentity {
  const info = inspect && typeof inspect === 'object' && !Array.isArray(inspect) ? inspect as Record<string, unknown> : {}
  const root = info.RootFS && typeof info.RootFS === 'object' ? info.RootFS as Record<string, unknown> : {}
  const diffIds = Array.isArray(root.Layers) ? root.Layers : []
  // As docker prints them, never adjusted: the machine reads its own inspect the same way.
  const os = typeof info.Os === 'string' ? info.Os : ''
  const architecture = typeof info.Architecture === 'string' ? info.Architecture : ''
  const layers = root.Type === 'layers' && diffIds.length > 0 && diffIds.length <= LAYERS_MAX
    && diffIds.every((id) => typeof id === 'string' && DIFF_ID.test(id))
    && PLATFORM_PART.test(os) && PLATFORM_PART.test(architecture)
    ? layersFingerprint(os, architecture, diffIds as string[])
    : null
  return { registryRef: registryRefOf(info.RepoDigests, preferred), layers }
}
