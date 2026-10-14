import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import { config } from '../config.js'
import { imageRevision, kernelRuntimeClient, loadRuntimeCatalog } from '../kernel/runtime-client.js'
import { resolveRuntimeEnvironment } from '@shared/runtime'
import { competitionBackend, limitsFor } from './runner-port.js'
import { runnerGpuDevices } from './gpu.js'
import { homeNotebooksSetting } from './settings.js'
import { getCompetition } from './store.js'
import { competitionRevision } from '../dependencies/store.js'
import { heardAt, remoteCardsSeen, runnerCards } from './remote/heard.js'
import { homeTakes, stepClaim } from './remote/fit.js'
import { listStandingRunners } from './remote/store.js'
import { portableRevision } from './remote/want.js'
import { tr } from '@shared/i18n'
import { REMOTE_GPU_SEEN_MS, REMOTE_HOST_RESERVE_MB } from '@shared/remote-runner'
import type { CompetitionCapabilities, RuntimeCapability } from '@shared/capabilities'

const execute = promisify(execFile)
const ok = (): RuntimeCapability => ({ available: true, code: 'available', reason: null })
const unavailable = (code: string, key: string): RuntimeCapability => ({ available: false, code, reason: tr(key) })
type Backend = 'broker' | 'docker' | 'test'
function dockerMajor(version: string | null | undefined): number | null {
  const matched = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(version ?? '')
  const major = matched ? Number(matched[1]) : NaN
  return Number.isSafeInteger(major) ? major : null
}
/**
 * `gpu` — the competition wants a card (CompetitionLimits.gpu); `runnerGpus`
 * — the owner gave this machine's submissions at least one (docker and the
 * test stand-in). Under the broker the second answer is the broker's own
 * `gpu` capability, and a broker that does not report one has none.
 *
 * `gpu_unavailable` is an EXECUTION verdict and comes last: a dead docker or a
 * missing image is said first, being the more basic trouble. Preparation is
 * judged before it and never inherits it: installing a participant's packages
 * needs no card. Without a card a GPU competition is refused at the door —
 * the upload and the baseline check — instead of waiting in the queue for a
 * card that nobody gave, or failing as a metric on the broker.
 *
 * Under the broker the answer also carries the broker's `gpuSlots` as it
 * came (absent when it said none): how many GPU notebooks the cluster has
 * units for at once, which the pump keeps its GPU work to (runner.ts ·
 * queueCards). Not a verdict, and never a reason to refuse anything here.
 */
export function evaluateCapabilities(input: { backend: Backend; dockerVersion?: string | null; imageAvailable?: boolean; storageAvailable?: boolean; brokerCapabilities?: CompetitionCapabilities; gpu?: boolean; runnerGpus?: boolean }): CompetitionCapabilities {
  let execution = ok()
  if (input.backend === 'broker') execution = input.brokerCapabilities?.execution ?? unavailable('broker_unavailable', 'runtime.brokerUnavailable')
  else if (input.backend === 'docker' && !input.dockerVersion) execution = unavailable('docker_unavailable', 'runtime.dockerUnavailable')
  if (execution.available && input.imageAvailable === false) execution = unavailable('image_unavailable', 'runtime.imageUnavailable')
  if (execution.available && input.storageAvailable === false) execution = unavailable('storage_unavailable', 'runtime.storageUnavailable')
  const major = dockerMajor(input.dockerVersion)
  let preparation:RuntimeCapability
  if(input.backend==='broker') {
    preparation=input.brokerCapabilities?.preparation??unavailable('broker_unavailable','runtime.brokerUnavailable')
    if(preparation.available&&input.imageAvailable===false)preparation=unavailable('image_unavailable','runtime.imageUnavailable')
    if(preparation.available&&input.storageAvailable===false)preparation=unavailable('storage_unavailable','runtime.storageUnavailable')
  }else preparation=!execution.available?{...execution}:input.backend==='docker'&&(major===null||major<28)
    ?unavailable('docker_version','runtime.preparationVersion'):ok()
  if (execution.available && input.gpu === true) {
    // Read defensively: `gpu` is a newer field of the broker's health.
    const cards = input.backend === 'broker' ? input.brokerCapabilities?.gpu?.available === true : input.runnerGpus === true
    if (!cards) execution = unavailable('gpu_unavailable', input.backend === 'broker' ? 'runtime.gpuUnavailableCluster' : 'runtime.gpuUnavailable')
  }
  const gpuSlots = input.backend === 'broker' ? input.brokerCapabilities?.gpuSlots : undefined
  return { execution, preparation, ...(gpuSlots !== undefined ? { gpuSlots } : {}) }
}

/**
 * What a check of ONE competition adds to the image: whether its notebook
 * wants a card, and which competition it is — so that one whose notebooks
 * only the machines run is judged by the image its metric needs here
 * (machinesRunIt), not by the one its notebooks run in there.
 */
export interface CompetitionNeeds { gpu?: boolean; competitionId?: string }

/**
 * What a door that runs a competition's NOTEBOOK asks of the executor: its
 * card, when the competition has one. Only those doors: the metric never gets
 * a card, and a door that runs only the metric (a rescore, the metric check)
 * or no notebook at all (package preparation, a draft) asks for none.
 */
export function notebookNeeds(competition: { id?: string; limits: { gpu?: boolean } }): CompetitionNeeds {
  return { gpu: competition.limits.gpu === true, ...(competition.id ? { competitionId: competition.id } : {}) }
}

/*
 * A COMPETITION WHOSE NOTEBOOKS ONLY MACHINES RUN NEEDS ITS METRIC'S IMAGE
 * HERE, NOT ITS OWN. With «Тетради на этом сервере» off, or a GPU competition
 * on a server with no card for submissions, this server never starts the
 * competition's own image: the machines pull it from the registry by digest,
 * and this server only scores — a GPU competition in the light kaggle-base it
 * is pinned to (decision 2). The door still asked for the competition's own
 * image, 13 GB of kaggle-gpu on vsos's disk for nothing. So when that image
 * is not here, the notebooks are the machines' alone (fit.ts · homeTakes),
 * its revision is in a registry (want.ts · portableRevision), and a machine
 * that fits its runs was heard within REMOTE_GPU_SEEN_MS (with cards, for a
 * GPU competition), the image the door asks for is the metric's
 * (runner.ts · metricScoringImage): kaggle-base for a GPU competition, which
 * must be here. A CPU competition's metric runs in its own pinned image, so
 * for one of those nothing changes: its own image must still be here.
 */
async function machinesRunIt(competitionId: string, gpu: boolean, ownDigest: string | undefined, now = Date.now()): Promise<{ environment: string; imageDigest: string | undefined } | null> {
  const competition = getCompetition(competitionId)
  if (!competition) return null
  if (homeTakes({ gpu, homeNotebooks: homeNotebooksSetting().value, homeCards: runnerGpuDevices().length > 0 })) return null
  if (!portableRevision(competitionRevision(competition.id))) return null
  const claim = stepClaim(limitsFor(competition, 'notebook'))
  const fitting = listStandingRunners().some((runner) => {
    const at = heardAt(runner.id) ?? runner.lastSeenAt
    if (at === null || now - at > REMOTE_GPU_SEEN_MS) return false
    if (gpu && runnerCards(runner).length === 0) return false
    // What the machine said it is when it joined (or since): its memory less the host's reserve, its CPUs less one, against one run's claim.
    const facts = runner.facts
    return !facts || (facts.memoryMb - REMOTE_HOST_RESERVE_MB >= claim.memoryMb && facts.cpus - 1 >= claim.cpus)
  })
  if (!fitting) return null
  // The pump's own choice of the metric's image, read where it is decided (an import of the module that imports this one, made when it is asked).
  const { metricScoringImage } = await import('./runner.js')
  const metric = await metricScoringImage(competition)
  if (metric.environment === competition.environment && metric.imageDigest === ownDigest) return null
  return metric
}

type Command = (args: string[]) => Promise<string>
interface Probe<T> { until: number; value: Promise<T> }
/**
 * Whether a failed `docker image inspect` said the image is not there —
 * docker's «No such image» (or «No such object») — rather than that docker
 * could not say: the three-second timeout, a daemon that went away. The two
 * meant one verdict, `image_unavailable`, and the metric of a competition with
 * a card read a stall of the daemon as its pinned image gone, and scored in
 * another one (runner.ts · gpuScoringImage). Now a failure that says nothing
 * about the image is docker not answering (`docker_unavailable`), and the
 * metric waits for an answer instead.
 */
function imageAbsent(error: unknown): boolean {
  const said = error instanceof Error ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? '')}` : String(error)
  return /no such (image|object)/i.test(said)
}
interface CapabilityReaderOptions {
  backend?: () => Backend
  run?: Command
  clock?: () => number
  storageAvailable?: () => boolean
  brokerCapabilities?: () => Promise<CompetitionCapabilities | null>
  catalogAvailable?: (environmentName?:string,imageDigest?:string)=>boolean
  /** Whether any card is given to submissions here (docker and the test stand-in). */
  runnerGpus?: () => boolean
}
/** One short cache for both successful and failed probes. In-flight callers
 * share the promise; expiry starts at completion, so slow probes also coalesce.
 *
 * The cache holds what is slow to ask — the daemon, an image, the broker —
 * and never a verdict: whether the competition wants a card is applied to
 * every answer afresh, and whether the machine has runner cards is read at
 * each call (a settings row and KERNEL_GPUS, no process). So a GPU
 * competition and a CPU one on the same image never share a verdict, and a
 * card the owner just gave is seen at the next request. */
export function createCapabilityReader(options: CapabilityReaderOptions = {}) {
  const clock = options.clock ?? Date.now
  const backendOf = options.backend ?? (() => competitionBackend())
  /*
   * THE GPU DOOR (decision 8 of docs/architecture/remote-runners.md §12): this
   * server's own cards given to submissions, as in 0.22.0, or a machine with
   * cards heard within the last hour (remote/heard.ts · remoteCardsSeen). Not
   * only one online now: a GPU competition keeps taking uploads through a
   * machine's restart or an update, and its notebooks wait in the queue for
   * the machine rather than being refused at the door.
   */
  const runnerGpus = options.runnerGpus ?? (() => runnerGpuDevices().length > 0 || remoteCardsSeen().recent > 0)
  const run = options.run ?? (async (args) => (await execute('docker', args, { timeout: 3000, maxBuffer: 4096 })).stdout.trim())
  const storageAvailable = options.storageAvailable ?? (() => {
    try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK); return true }
    catch { return false }
  })
  const brokerCapabilities=options.brokerCapabilities??(async()=>{
    const health=await kernelRuntimeClient().health()
    return health.ok?health.competition??null:null
  })
  const catalogAvailable=options.catalogAvailable??((environmentName?:string,imageDigest?:string)=>{
    if(!environmentName&&!imageDigest)return true
    if(!environmentName)return false
    const catalog=loadRuntimeCatalog()
    const selected=resolveRuntimeEnvironment(catalog,environmentName,imageDigest?imageRevision(imageDigest):undefined)
    return !imageDigest||selected.image===imageDigest
  })
  let daemon: Probe<string | null> | null = null
  let broker: Probe<CompetitionCapabilities|null>|null=null
  // `null` — the inspect failed without saying the image is not there (imageAbsent).
  const images = new Map<string, Probe<boolean | null>>()
  const probe = <T>(work: () => Promise<T>): Probe<T> => {
    const entry: Probe<T> = { until: Infinity, value: Promise.resolve().then(work) }
    entry.value.finally(() => { entry.until = clock() + 5000 }).catch(() => undefined)
    return entry
  }
  return async (environmentName?: string, imageDigest?: string, needs: CompetitionNeeds = {}): Promise<CompetitionCapabilities> => {
    const backend = backendOf()
    const gpu = needs.gpu === true
    if(backend==='broker') {
      if(!broker||broker.until<=clock())broker=probe(()=>brokerCapabilities().catch(()=>null))
      let imageAvailable=false
      try{imageAvailable=catalogAvailable(environmentName,imageDigest)}catch{ /* catalog unavailable */ }
      return evaluateCapabilities({backend,brokerCapabilities:await broker.value??undefined,imageAvailable,storageAvailable:storageAvailable(),gpu})
    }
    if (backend !== 'docker') return evaluateCapabilities({ backend, gpu, runnerGpus: gpu && runnerGpus() })
    if (!daemon || daemon.until <= clock()) daemon = probe(() => run(['version', '--format', '{{.Server.Version}}']).then(value => value || null, () => null))
    const version = await daemon.value
    if (!version) return evaluateCapabilities({ backend, dockerVersion: null })
    const imagePresent = (name: string | undefined, digest: string | undefined): Promise<boolean | null> => {
      const image = digest ?? `colloq-kernel:${name}`
      let cached = images.get(image)
      if (!cached || cached.until <= clock()) {
        cached = probe(() => run(['image', 'inspect', '--format', '{{.Id}}', image]).then(() => true, (error: unknown) => imageAbsent(error) ? false : null))
        if (images.size >= 64 && !images.has(image)) images.delete(images.keys().next().value!)
        images.set(image, cached)
      }
      return cached.value
    }
    let imageAvailable = true
    if (environmentName || imageDigest) {
      let present = await imagePresent(environmentName, imageDigest)
      // Not here, and the notebooks only machines run: the image this server needs is the metric's (machinesRunIt).
      if (present === false && needs.competitionId) {
        const metric = await machinesRunIt(needs.competitionId, gpu, imageDigest).catch(() => null)
        if (metric) present = await imagePresent(metric.environment, metric.imageDigest)
      }
      // Docker did not answer about the image: said as a daemon that does not answer, never as an image that is gone.
      if (present === null) return evaluateCapabilities({ backend, dockerVersion: null })
      imageAvailable = present
    }
    return evaluateCapabilities({ backend, dockerVersion: version, imageAvailable, storageAvailable: storageAvailable(), gpu, runnerGpus: gpu && runnerGpus() })
  }
}
let reader = createCapabilityReader()
/**
 * What the executor can do now; with an environment (and its pinned image)
 * for one competition, and `needs.gpu` when that competition's notebook
 * wants a card (`{ gpu: competition.limits.gpu === true }`). The instance-wide
 * question — the pump, the health page — passes nothing and is never refused
 * for a card.
 */
export const competitionCapabilities = (environmentName?: string, imageDigest?: string, needs: CompetitionNeeds = {}): Promise<CompetitionCapabilities> => reader(environmentName, imageDigest, needs)
/**
 * Swap the probe out — for tests that need a runtime answering slowly: the
 * test backend answers in the same tick, and what needs checking is what
 * happens while the answer is still on its way. `null` restores the real one.
 */
export function useCompetitionCapabilities(fake: ReturnType<typeof createCapabilityReader> | null): void {
  reader = fake ?? createCapabilityReader()
}
export class RuntimeUnavailableError extends Error {
  readonly status = 503
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RuntimeUnavailableError' }
}
export async function assertCompetitionCapability(kind: 'execution' | 'preparation', environmentName?: string, imageDigest?: string, needs: CompetitionNeeds = {}): Promise<void> {
  const capability = (await competitionCapabilities(environmentName, imageDigest, needs))[kind]
  if (!capability.available) throw new RuntimeUnavailableError(capability.code, capability.reason ?? tr('runtime.prepareUnavailable'))
}
