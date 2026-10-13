/**
 * A machine's video cards, asked of the cards themselves: the local
 * `nvidia-smi` when there is one, otherwise one throwaway container given
 * every card, and a container of its own for an entry that one did not name.
 *
 * MOVED OUT OF kernel/resources.ts, AND KEPT PURE. A machine that runs
 * submissions for a home instance (docs/architecture/remote-runners.md, §5.5)
 * owns its cards and asks them exactly this way, from an agent
 * (dist/runner.js) that must not load the room pool, the runtime client or
 * the database behind resources.ts. So nothing here knows which backend this
 * server runs or whose docker to call: the caller brings its docker (home:
 * resources.ts's own, which its tests swap with useDockerInfo) and decides
 * whether a probe makes sense at all (resources.ts · probeGpuCards answers
 * the test stand and the broker without one). What is home's stays there: the
 * inventory of KERNEL_GPUS, its cache and its watch; the parsers are
 * re-exported from there, so nothing that imports them changes.
 *
 * WHY A CONTAINER. Inside the colloq-vast container nvidia-smi is not in the
 * app's image (deploy/vast/README.md lists it as a known gap), and neither is
 * it in a machine's agent; yet a card's memory decides the share every
 * submission on it is promised AND held to (competitions/gpu-math.ts ·
 * gpuSliceMb), so it has to be read wherever the app actually runs. The NVIDIA
 * toolkit mounts nvidia-smi into every container it gives a card to, and with
 * every card visible the container numbers them as the host does, which is
 * how `--gpus device=<index>` names them too. One container for all of them,
 * not one per card: on the 2 × 4090 VM a probe container took ~6 s for both
 * cards and ~7 s for each card alone (13 Oct 2026), and a refresh in the
 * middle of a class is then one container on a busy daemon rather than one
 * per card. An entry that container did not name (it failed, or the entry is
 * spelled in a way only `--gpus device=` understands) is asked from a
 * container of its own, `--gpus device=<id>`, whose answer is about the card
 * docker hands out under that very id.
 *
 * A MIG instance stays unknown on purpose: the per-card query describes the
 * physical card the instance is cut from, and a share computed from that would
 * promise each run more than the whole instance has.
 *
 * Nothing here throws. `nvidia-smi` and docker may be missing on someone
 * else's machine, answer with garbage or hang; a card that cannot be asked is
 * a card of unknown size, and whoever shows it says exactly that.
 */
import { spawn } from 'node:child_process'
import type { GpuCard } from '@shared/admin'

/** A docker call: argv in, exit code and output out; never rejects (resources.ts · useDockerInfo swaps home's). */
export type DockerRead = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>

/** A card's own word about itself; `null` — it could not be asked, nobody guesses. */
export interface GpuCardFacts {
  name: string | null
  memoryMb: number | null
}

/** Asks about cards by their ids (KERNEL_GPUS entries at home); an id missing from the answer is unknown. */
export type GpuCardProbe = (devices: readonly string[]) => Promise<Map<string, GpuCardFacts>>

/* ------------------------------------------------------------ nvidia-smi */

/**
 * What the local `nvidia-smi` prints for these arguments; `null` — it is not
 * there, it failed, or it did not answer in time.
 *
 * Neither errors nor a missing binary escape. The timeout is short and real
 * (kill, not just reject): `nvidia-smi` on a machine with a hung driver never
 * returns, and this read hangs on the panel's request.
 */
export function nvidiaSmi(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('nvidia-smi', args)
    } catch {
      resolve(null)
      return
    }
    let out = ''
    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, 3_000)
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))
  })
}

/** "0, NVIDIA GeForce RTX 3090, 24576": one line per card, as the seminar form's question prints it. */
export function parseGpus(out: string): GpuCard[] {
  const cards: GpuCard[] = []
  for (const line of out.split('\n')) {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 3) continue
    const index = Number(parts[0])
    const memoryMb = Number(parts[2].replace(/[^\d]/g, ''))
    if (!Number.isFinite(index) || !parts[1]) continue
    cards.push({ index, name: parts[1], memoryMb: Number.isFinite(memoryMb) ? memoryMb : 0 })
  }
  return cards
}

/* ------------------------------------------------------ what a card says */

/** What the local nvidia-smi and the all-cards container are asked: one line per card (`parseCardList`). */
export const CARD_QUERY = ['--query-gpu=index,uuid,name,memory.total', '--format=csv,noheader,nounits']

/** One line of `CARD_QUERY`'s answer. */
export type CardRow = { index: string; uuid: string; name: string; memoryMb: number | null }

/**
 * "0, GPU-8f…, NVIDIA GeForce RTX 4090, 24564": one line per card, as
 * `--query-gpu=index,uuid,name,memory.total` prints it. A memory field that
 * is not a number ("[N/A]") is unknown, not zero.
 */
export function parseCardList(out: string): CardRow[] {
  const cards: CardRow[] = []
  for (const line of out.split('\n')) {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 4 || !/^\d+$/.test(parts[0]) || !parts[1]) continue
    const memoryMb = Number(parts[parts.length - 1])
    cards.push({
      index: parts[0],
      uuid: parts[1],
      name: parts.slice(2, -1).join(', '),
      memoryMb: Number.isSafeInteger(memoryMb) && memoryMb > 0 ? memoryMb : null,
    })
  }
  return cards
}

/**
 * "NVIDIA GeForce RTX 4090, 24564" from the probe container. Docker's own
 * words may come before it on the same stream (`run` merges stderr), so the
 * first line of that shape is taken, not the first line.
 */
export function parseCardFacts(out: string): GpuCardFacts | null {
  for (const line of out.split('\n')) {
    const match = /^(.+?),\s*(\d+)\s*$/.exec(line.trim())
    if (!match) continue
    const memoryMb = Number(match[2])
    if (Number.isSafeInteger(memoryMb) && memoryMb > 0) return { name: match[1].trim(), memoryMb }
  }
  return null
}

/* ---------------------------------------------------- the probe container */

/** Kernel images are `colloq-kernel:<environment>` (kernel/pool.ts · IMAGE_PREFIX). */
const KERNEL_IMAGE = 'colloq-kernel'

/**
 * A kernel image to start the probe from, among those already on the
 * machine: `base-gpu` first, it is surely there on a machine with cards. Never
 * pulled (`--pull=never` below): `colloq-kernel` is not on any registry, and a
 * pull attempt is half a minute of nothing.
 */
export async function kernelProbeImage(docker: DockerRead): Promise<string | null> {
  const res = await docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', KERNEL_IMAGE], 10_000)
  if (res.code !== 0) return null
  const tags = res.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${KERNEL_IMAGE}:`) && !line.endsWith(':<none>'))
  return tags.find((tag) => tag === `${KERNEL_IMAGE}:base-gpu`) ?? tags.find((tag) => tag === `${KERNEL_IMAGE}:base`) ?? tags[0] ?? null
}

/**
 * Ask the cards themselves what they are, from a container that lives a few
 * seconds: no network, no capabilities, removed on exit. Read-only for the
 * cards — the query takes no memory on them and disturbs no run already there.
 */
function probeContainer(docker: DockerRead, gpus: string, image: string, query: readonly string[]): Promise<{ code: number; out: string }> {
  return docker(
    [
      'run', '--rm', '--pull=never', '--network', 'none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--gpus', gpus, '--entrypoint', 'nvidia-smi', image, ...query,
    ],
    30_000,
  )
}

/**
 * Every card at once, from one container given all of them: the same question
 * and the same lines as the local nvidia-smi. `null` — docker did not start
 * it or nvidia-smi failed in it; a partial answer is not read, since a line
 * cut short by the timeout would read as a smaller card.
 */
export async function cardsInContainer(docker: DockerRead, image: string): Promise<CardRow[] | null> {
  const res = await probeContainer(docker, 'all', image, CARD_QUERY)
  return res.code === 0 ? parseCardList(res.out) : null
}

/** One card, from a container given only it: for an entry the all-cards container did not name. */
async function cardInContainer(docker: DockerRead, device: string, image: string): Promise<GpuCardFacts | null> {
  const res = await probeContainer(docker, `device=${device}`, image, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  return res.code === 0 ? parseCardFacts(res.out) : null
}

/* -------------------------------------------------------------- the probe */

/**
 * The cards behind these ids, matched by index or by UUID (the two ways
 * KERNEL_GPUS names a whole card): the local nvidia-smi first, then one
 * throwaway container given every card, then a container of its own for an
 * entry neither named. An id missing from the answer is unknown.
 *
 * `image` picks what the containers start from; by default a kernel image
 * already on the machine (kernelProbeImage). No image, no container: the
 * entries the local nvidia-smi did not name stay unknown.
 */
export async function probeCards(
  devices: readonly string[],
  options: { docker: DockerRead; image?: (docker: DockerRead) => Promise<string | null> },
): Promise<Map<string, GpuCardFacts>> {
  const { docker } = options
  const answer = new Map<string, GpuCardFacts>()
  const name = (listed: CardRow[]): void => {
    for (const device of devices) {
      const card = listed.find((row) => row.index === device || row.uuid === device)
      if (card && !answer.has(device)) answer.set(device, { name: card.name, memoryMb: card.memoryMb })
    }
  }
  const unnamed = (): string[] => devices.filter((device) => !answer.has(device) && !device.startsWith('MIG-'))
  const local = await nvidiaSmi(CARD_QUERY)
  if (local !== null) name(parseCardList(local))
  if (unnamed().length === 0) return answer
  const image = await (options.image ?? kernelProbeImage)(docker)
  if (!image) return answer
  const all = await cardsInContainer(docker, image)
  if (all) name(all)
  await Promise.all(
    unnamed().map(async (device) => {
      const facts = await cardInContainer(docker, device, image)
      if (facts) answer.set(device, facts)
    }),
  )
  return answer
}
