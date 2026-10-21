/**
 * «Машины для посылок» as the panel words them: the client of the owner's
 * doors (/api/admin/runners) and every decision the screens take about what a
 * machine, a run on one, or a wait for one is called (Paper page 16, M1–M7).
 *
 * No Svelte and no browser, as in `admin/running-kernels.ts` and
 * `admin/runner-cards.ts`: these are the words an owner decides by in the
 * middle of a burst — whether a machine is worth waiting for, why fifty
 * notebooks do not move, which machine to disconnect — and a slip in them
 * (a «молчит» on a machine that answered, a «готова» on one still pulling
 * twelve gigabytes, a cause of a return the server never named) shows only
 * on a live competition, when it is too late to fix.
 *
 * What is not here: whether a machine is silent, outdated or quarantined,
 * whether it may take a competition, and why a submission waits. Home decides
 * all of that (server/src/competitions/remote/) and the types say it
 * (shared/remote-admin.ts); the panel only words what it was told, and where
 * it was told nothing it says less rather than guess.
 */
import { formatDate, formatNumber, tr } from '@shared/i18n'
import { REMOTE_ATTEMPTS_MAX, REMOTE_CODE_TTL_MAX_MS, REMOTE_DRIVER_MIN, REMOTE_PER_DEVICE_MAX } from '@shared/remote-runner'
import type { RemoteAttemptPhase, RemoteProblemCode } from '@shared/remote-runner'
import type { ClassPlacement, ClassPlacementPreset, UpdateClassMachineSettingsRequest } from '@shared/admin'
import { CLASS_PLACEMENT_PRESETS } from '@shared/admin'
import type {
  ClassMachineSettingsResponse,
  ClassPlacementOutlook,
  MintRemoteCodeRequest,
  MintRemoteCodeResponse,
  RemoteClassAction,
  RemoteClassBanner,
  RemoteCodeView,
  RemoteCompetitionWhere,
  RemoteConsoleGroup,
  RemoteEvent,
  RemoteMachine,
  RemoteMachineAction,
  RemoteMachineCard,
  RemoteMachineClassRow,
  RemoteMachineClasses,
  RemoteMachineDetail,
  RemoteMachineFacts,
  RemoteMachineRun,
  RemoteMachineState,
  RemoteMachinesResponse,
  RemoteReadiness,
  RemoteReadinessItem,
  RemoteReadinessVerdict,
  RemoteWhereMachine,
  RunningRemote,
  UpdateRemoteMachineRequest,
} from '@shared/remote-admin'
import type { RunningNow, WaitingRow } from '@shared/competitions-api'
import { AdminApiError, adminRequest } from '@/lib/adminApi'
import { cardWord, type Outcome } from './running-kernels'

/* ------------------------------------------------------------------ client */

const machinePath = (id: string): string => `/runners/${encodeURIComponent(id)}`
const body = (value: unknown): RequestInit => ({ body: JSON.stringify(value) })

/**
 * The owner's doors (requireOwner, every one of them: a machine sees rivals'
 * notebooks and, when trusted, the hidden test, so who may connect one is the
 * instance's business, not a course's). Through the panel's one request
 * function, so the cookie, a 401 and a dropped Wi-Fi read the same here as on
 * every other tab.
 *
 * The answers to the writes are not read: a write is followed by a fresh
 * read of the list or the page, and the screen draws what the server holds
 * after it rather than what one answer happened to carry.
 */
export const runnersApi = {
  /** GET /api/admin/runners — the M1 block, read again while it is on screen. */
  list: (): Promise<RemoteMachinesResponse> => adminRequest<RemoteMachinesResponse>('/runners'),

  /** GET /api/admin/runners/:id — the M3 page. */
  machine: (id: string): Promise<RemoteMachineDetail> => adminRequest<RemoteMachineDetail>(machinePath(id)),

  /** POST /api/admin/runners/codes — the code, shown once, inside the three join commands (M2). */
  mintCode: (request: MintRemoteCodeRequest): Promise<MintRemoteCodeResponse> =>
    adminRequest<MintRemoteCodeResponse>('/runners/codes', { method: 'POST', ...body(request) }),

  /** PATCH /api/admin/runners/:id — places, runs per card, trust, name; a field left out stays. */
  update: (id: string, patch: UpdateRemoteMachineRequest): Promise<void> =>
    adminRequest<unknown>(machinePath(id), { method: 'PATCH', ...body(patch) }).then(() => undefined),

  /** POST /api/admin/runners/:id/drain | resume | revoke. */
  act: (id: string, action: RemoteMachineAction): Promise<void> =>
    adminRequest<unknown>(`${machinePath(id)}/${action}`, { method: 'POST' }).then(() => undefined),

  /** POST /api/admin/runners/revoke-all — «Отключить все». */
  revokeAll: (): Promise<void> => adminRequest<unknown>('/runners/revoke-all', { method: 'POST' }).then(() => undefined),

  /** DELETE /api/admin/runners/codes/:id — «Отменить»: no machine joins with the code any more; those that joined stay. */
  cancelCode: (id: string): Promise<void> =>
    adminRequest<unknown>(`/runners/codes/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined),

  /** POST /api/admin/runners/:id/classes/resume | move — «Вернуть» under the class quarantine, «Перенести занятия». */
  classAction: (id: string, action: RemoteClassAction): Promise<void> =>
    adminRequest<unknown>(`${machinePath(id)}/classes/${action}`, { method: 'POST' }).then(() => undefined),

  /** GET /api/admin/resources/classes — «Занятия на машинах» (staff read it; the class form needs the switch and the default). */
  classSettings: (): Promise<ClassMachineSettingsResponse> => adminRequest<ClassMachineSettingsResponse>('/resources/classes'),

  /** PUT /api/admin/resources/classes — the owner's; a field left out stays, `null` forgets the saved value. */
  saveClassSettings: (patch: UpdateClassMachineSettingsRequest): Promise<ClassMachineSettingsResponse> =>
    adminRequest<ClassMachineSettingsResponse>('/resources/classes', { method: 'PUT', ...body(patch) }),

  /** GET /api/admin/seminars/:id/placement — the class form's live line: the machines against this class (Z4). */
  placementOutlook: (sessionId: string): Promise<ClassPlacementOutlook> =>
    adminRequest<ClassPlacementOutlook>(`/seminars/${encodeURIComponent(sessionId)}/placement`),
}

/**
 * The order of overlapping reads of one list (the machines block, M1).
 *
 * Reads overlap — the timer's, the one after a menu action, the one after
 * the Resources form's Save — and their answers come back in any order: a
 * timed read that left before a Save and landed after it put the old state
 * back on screen until the next tick. So every read takes a ticket
 * (`ask`), and an answer is shown only when it is newer than the last one
 * shown (`accept`). A read asked for after a write (`ask(true)`) also
 * retires every read that left before it: those carry the state from before
 * the write, whichever lands first.
 */
export function readOrder(): { ask: (afterWrite?: boolean) => number; accept: (ticket: number) => boolean } {
  let asked = 0
  let floor = 0
  return {
    ask(afterWrite = false) {
      asked += 1
      if (afterWrite) floor = Math.max(floor, asked - 1)
      return asked
    },
    accept(ticket) {
      if (ticket <= floor) return false
      floor = ticket
      return true
    },
  }
}

/**
 * What to ask before the Resources form saves «только метрики»
 * (homeNotebooks off): with no machine online nothing runs a notebook and
 * every submission waits, so the owner is asked first — and told plainly when
 * the machines list could not be read rather than told there are none.
 * `null` — nothing to ask: notebooks stay on (or are forgotten back to the
 * default, which is on), or a machine is online.
 */
export function notebooksOffQuestion(homeNotebooks: boolean | null | undefined, machinesOnline: number | null): string | null {
  if (homeNotebooks !== false) return null
  if (machinesOnline !== null && machinesOnline > 0) return null
  return tr(machinesOnline === null ? 'admin.runners.homeNotebooks.offConfirmUnknown' : 'admin.runners.homeNotebooks.offConfirm')
}

/* ------------------------------------------------------------------- tones */

/** A chip's tone, as Badge draws it (screens/competitions/Badge.svelte · BadgeTone). */
export type ChipTone = 'positive' | 'warning' | 'danger' | 'accent' | 'neutral'

/** A line's tone; the screens paint `muted` grey and `ink` in the text colour. */
export type LineTone = 'positive' | 'warning' | 'danger' | 'accent' | 'muted' | 'ink'

export interface Line {
  text: string
  tone: LineTone
}

/* ----------------------------------------------------------------- numbers */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Gigabytes from megabytes, the way a machine's memory reads: «126 ГБ», «7,5 ГБ». */
export function gbFromMb(mb: number): string {
  const gb = mb / 1024
  return tr('admin.runners.gb', { value: formatNumber(gb, { maximumFractionDigits: gb >= 10 ? 0 : 1 }) })
}

/**
 * A download's size: «12,7 ГБ», «0,9 МБ», «210 МБ». `null` for a size nobody
 * said — an image the registry did not describe — which the screens leave
 * out rather than print as zero.
 */
export function sizeWords(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return tr('admin.runners.gb', { value: formatNumber(gb, { maximumFractionDigits: 1 }) })
  const mb = bytes / 1024 ** 2
  return tr('admin.runners.mb', { value: formatNumber(mb, { maximumFractionDigits: mb < 10 ? 1 : 0 }) })
}

/** «23:41» today, «13.10, 23:41» before. */
export function clockTime(at: number, now: number): string {
  const time = formatDate(at, { hour: '2-digit', minute: '2-digit' })
  return new Date(at).toDateString() === new Date(now).toDateString()
    ? time
    : `${formatDate(at, { day: '2-digit', month: '2-digit' })}, ${time}`
}

/** An event's time: «23:52:14» today — events come seconds apart — and «13.10, 23:52» before. */
export function eventTime(at: number, now: number): string {
  if (new Date(at).toDateString() !== new Date(now).toDateString()) return clockTime(at, now)
  return formatDate(at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * How long ago a machine was heard: «2 с назад», «4 мин назад».
 *
 * In seconds while it is seconds, and not the panel's «только что»
 * (panel.ts · ago): a machine syncs every ten to twenty-five seconds, and the
 * difference between «3 с» and «50 с» is the difference between a heartbeat
 * and the first sign of a machine going away.
 */
export function heardAgo(at: number, now: number): string {
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return tr('admin.runners.seen.seconds', { count: Math.floor(ms / SECOND) })
  if (ms < HOUR) return tr('admin.runners.seen.minutes', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) return tr('admin.runners.seen.hours', { count: Math.floor(ms / HOUR) })
  return tr('admin.runners.seen.days', { count: Math.floor(ms / DAY) })
}

/** «GPU 0 и GPU 1», «a, b и c»: a list read as a phrase. */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} ${tr('admin.runners.and')} ${items[items.length - 1]}`
}

/* ---------------------------------------------------------------- the chip */

/**
 * The state chip of a machine, on its row, its page and the console's group
 * header. Feminine in Russian: «машина» (decision 9), so «устарела»,
 * «отключена», not the «устарел» of the design's first draft.
 */
export function stateChip(state: RemoteMachineState, silentSince: number | null | undefined, now: number): { word: string; tone: ChipTone } {
  switch (state) {
    case 'online':
      return { word: tr('admin.runners.state.online'), tone: 'positive' }
    case 'silent': {
      // Since when, if the server said; «молчит» alone otherwise, never a
      // number made up from when the page happened to load.
      if (silentSince === null || silentSince === undefined) return { word: tr('admin.runners.state.silent'), tone: 'warning' }
      const ms = Math.max(0, now - silentSince)
      return ms < HOUR
        ? { word: tr('admin.runners.state.silentMin', { count: Math.max(1, Math.floor(ms / MINUTE)) }), tone: 'warning' }
        : { word: tr('admin.runners.state.silentHours', { count: Math.floor(ms / HOUR) }), tone: 'warning' }
    }
    case 'outdated':
      return { word: tr('admin.runners.state.outdated'), tone: 'warning' }
    case 'draining':
      return { word: tr('admin.runners.state.draining'), tone: 'neutral' }
    case 'quarantined':
      return { word: tr('admin.runners.state.quarantined'), tone: 'danger' }
    case 'revoked':
      return { word: tr('admin.runners.state.revoked'), tone: 'neutral' }
    case 'left':
      return { word: tr('admin.runners.state.left'), tone: 'neutral' }
  }
}

/** A machine that is gone for good: revoked by the owner, or it revoked itself on `leave`. */
export function machineGone(state: RemoteMachineState): boolean {
  return state === 'revoked' || state === 'left'
}

/**
 * The line under the chip: when it was heard. A silent machine says when it
 * was last heard («была в 23:41») — that is the fact the owner compares with
 * the moment the VM was destroyed — and one that never synced says so.
 */
export function heardLine(machine: Pick<RemoteMachine, 'state' | 'lastSeenAt'>, now: number): string {
  if (machine.lastSeenAt === null) return tr('admin.runners.seen.never')
  if (machine.state === 'silent') return tr('admin.runners.seen.lastAt', { time: clockTime(machine.lastSeenAt, now) })
  return heardAgo(machine.lastSeenAt, now)
}

/* ----------------------------------------------------------- what it has */

/** «64 ядра · 126 ГБ», as far as the machine said; «—» when it said nothing. */
export function resourcesLine(facts: Pick<RemoteMachineFacts, 'cpus' | 'memoryMb'>): string {
  const parts = [
    facts.cpus === null ? null : tr('admin.runners.cores', { count: facts.cpus }),
    facts.memoryMb === null ? null : gbFromMb(facts.memoryMb),
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

/**
 * A card's name the way a row has room for it: nvidia-smi says «NVIDIA
 * GeForce RTX 4090», and the vendor's two words take a third of the column
 * before the model the owner rented the machine for.
 */
export function shortCardName(name: string | null): string {
  const text = (name ?? '').trim().replace(/^nvidia\s+/i, '').replace(/^geforce\s+/i, '')
  return text || 'GPU'
}

/**
 * The cards of a machine in one phrase: «2 × RTX 4090 · по 8», «1 × RTX 3090
 * + 1 × A100 · по 4», or «без карт». The runs per card are the ones in force
 * on the machine now (RemoteMachineCard.perDevice); after the owner lowered
 * them they differ between cards for a while, and the phrase says the most.
 */
export function cardsLine(cards: readonly Pick<RemoteMachineCard, 'name' | 'perDevice'>[]): string {
  if (cards.length === 0) return tr('admin.runners.noCards')
  const counts = new Map<string, number>()
  for (const card of cards) {
    const name = shortCardName(card.name)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const models = [...counts].map(([name, count]) => `${count} × ${name}`).join(' + ')
  const per = Math.max(...cards.map((card) => card.perDevice))
  return `${models} · ${tr('admin.runners.cardsPer', { count: per })}`
}

/** The cards with their memory, for the machine page's facts: «2 × RTX 4090 · 24 ГБ». */
export function cardsFacts(cards: readonly Pick<RemoteMachineCard, 'name' | 'memoryMb'>[]): string {
  if (cards.length === 0) return tr('admin.runners.noCards')
  const counts = new Map<string, { count: number; memoryMb: number | null }>()
  for (const card of cards) {
    const name = shortCardName(card.name)
    const known = counts.get(name)
    if (known) known.count += 1
    else counts.set(name, { count: 1, memoryMb: card.memoryMb })
  }
  return [...counts]
    .map(([name, { count, memoryMb }]) => [`${count} × ${name}`, memoryMb === null ? null : gbFromMb(memoryMb)].filter(Boolean).join(' · '))
    .join(' + ')
}

/**
 * The share a run gets on this machine's smallest card at `perDevice` runs
 * a card, MB — the machine's own rule (competitions/gpu.ts · gpuSliceMb runs
 * there unchanged). `null` when a card did not say its size: nothing is
 * promised then, and the screens print no number.
 */
export function machineSliceMb(cards: readonly Pick<RemoteMachineCard, 'memoryMb'>[], perDevice: number): number | null {
  if (cards.length === 0) return null
  const runs = Math.max(1, Math.floor(perDevice))
  let slice: number | null = null
  for (const card of cards) {
    if (card.memoryMb === null || !(card.memoryMb > 0)) return null
    const share = Math.floor(card.memoryMb / runs)
    slice = slice === null ? share : Math.min(slice, share)
  }
  return slice
}

/** Places on a machine: busy of what it gives, and the share for the bar. */
export interface Places {
  busy: number
  total: number
  /** 0…1. */
  share: number
}

/**
 * What a machine gives the queue: the owner's cap when there is one, and
 * never more than it offers (§5.7: min(approved, offered)). A machine that
 * went quiet may still hold runs it no longer offers places for, so the total
 * is never drawn below what is busy: «2 из 0» is a bar past its own end.
 */
export function machinePlaces(places: RemoteMachine['places']): Places {
  const given = places.approved === null ? places.offered : Math.min(places.approved, places.offered)
  const total = Math.max(0, given, places.busy)
  return { busy: places.busy, total, share: total > 0 ? Math.min(1, places.busy / total) : 0 }
}

/** «14 из 16». */
export function placesWords(places: Pick<Places, 'busy' | 'total'>): string {
  return tr('admin.runners.placesOf', { busy: places.busy, count: places.total })
}

/* ------------------------------------------------------------- the summary */

export interface SummaryGauge {
  value: number
  label: string
}

/**
 * The three numbers above the list: «3 на связи из 5», «60 мест · 32
 * заняты», «2 карты × 8 · срез ≈ 3 ГБ». The cards' gauge only when a machine
 * that takes work has one: «0 карт» says nothing a CPU fleet needs.
 */
export function summaryGauges(summary: RemoteMachinesResponse['summary']): SummaryGauge[] {
  const gauges: SummaryGauge[] = [
    { value: summary.online, label: tr('admin.runners.summary.online', { count: summary.total }) },
    {
      value: summary.places,
      label: `${tr('admin.runners.summary.places', { count: summary.places })} · ${tr('admin.runners.summary.busy', { count: summary.busy })}`,
    },
  ]
  if (summary.cards > 0) {
    const parts = [tr('admin.runners.summary.cards', { count: summary.cards })]
    if (summary.perDevice !== null) parts[0] = `${parts[0]} × ${summary.perDevice}`
    if (summary.sliceMb !== null) parts.push(tr('admin.resourcesTab.gpuSliceShort', { value: formatNumber(Math.round(summary.sliceMb / 102.4) / 10) }))
    gauges.push({ value: summary.cards, label: parts.join(' · ') })
  }
  return gauges
}

/* ------------------------------------------------------------ readiness */

/**
 * The competition the list's readiness column is about: the one the fleet is
 * busy with (the most runs across machines), and, while nothing runs, the
 * first the server lists — it orders a machine's competitions by what it
 * fetches first: waiting submissions, then open, then upcoming (§4.3).
 * `null` — no machine has anything to prepare for.
 */
export function focusCompetition(
  machines: readonly Pick<RemoteMachine, 'state' | 'readiness'>[],
): { competitionId: string; title: string } | null {
  const tally = new Map<string, { title: string; running: number; order: number }>()
  for (const machine of machines) {
    if (machineGone(machine.state)) continue
    for (const item of machine.readiness) {
      const known = tally.get(item.competitionId)
      if (known) known.running += item.running
      else tally.set(item.competitionId, { title: item.title, running: item.running, order: tally.size })
    }
  }
  let best: { competitionId: string; title: string; running: number; order: number } | null = null
  for (const [competitionId, entry] of tally) {
    if (best === null || entry.running > best.running || (entry.running === best.running && entry.order < best.order)) {
      best = { competitionId, ...entry }
    }
  }
  return best === null ? null : { competitionId: best.competitionId, title: best.title }
}

type ItemKind = 'image' | 'data' | 'sealed'

function itemName(kind: ItemKind): string {
  switch (kind) {
    case 'image':
      return tr('admin.runners.ready.what.image')
    case 'data':
      return tr('admin.runners.ready.what.data')
    case 'sealed':
      return tr('admin.runners.ready.what.sealed')
  }
}

/** «образ ✓», «образ ↓ 45 %», «данные в очереди», «тест ✗»; `null` for what the competition does not need. */
export function itemWord(kind: ItemKind, item: RemoteReadinessItem): string | null {
  const what = itemName(kind)
  switch (item.state) {
    case 'ready':
      return tr('admin.runners.ready.item.ready', { what })
    case 'fetching':
      return item.percent === null
        ? tr('admin.runners.ready.item.fetchingBare', { what })
        : tr('admin.runners.ready.item.fetching', { what, percent: Math.floor(item.percent) })
    case 'waiting':
      return tr('admin.runners.ready.item.waiting', { what })
    case 'problem':
      return tr('admin.runners.ready.item.problem', { what })
    case 'not_needed':
      return null
  }
}

/** The image, the data and the hidden test of one competition, in one line. */
export function itemsWords(readiness: Pick<RemoteReadiness, 'image' | 'data' | 'sealedData'>): string {
  return [itemWord('image', readiness.image), itemWord('data', readiness.data), itemWord('sealed', readiness.sealedData)]
    .filter((word): word is string => word !== null)
    .join(' · ')
}

/** The NVIDIA driver's major number: 580 from «580.95.05». */
function driverMajor(driver: string | null): number | null {
  const match = /^(\d{2,4})\b/.exec(driver?.trim() ?? '')
  return match ? Number(match[1]) : null
}

/**
 * A problem in the owner's words. The machine's own detail (what docker or
 * nvidia-smi said) is shown under it as it came, never in place of it: it is
 * English, it is long, and «образ не скачался» is the decision.
 *
 * A failed GPU smoke test on a driver older than REMOTE_DRIVER_MIN is named
 * by the driver — «драйвер 535, нужен 580+» is what the owner fixes, «torch
 * sees no CUDA» is what they would have to look up.
 */
export function problemWords(code: RemoteProblemCode, facts: Pick<RemoteMachineFacts, 'driver'>): string {
  switch (code) {
    case 'smoke': {
      const major = driverMajor(facts.driver)
      return major !== null && major < REMOTE_DRIVER_MIN
        ? tr('admin.runners.problem.driver', { driver: major, min: REMOTE_DRIVER_MIN })
        : tr('admin.runners.problem.smoke')
    }
    case 'image':
      return tr('admin.runners.problem.image')
    case 'layers':
      return tr('admin.runners.problem.layers')
    case 'data':
      return tr('admin.runners.problem.data')
    case 'wheels':
      return tr('admin.runners.problem.wheels')
    case 'disk':
      return tr('admin.runners.problem.disk')
    case 'docker':
      return tr('admin.runners.problem.docker')
    case 'cards':
      return tr('admin.runners.problem.cards')
  }
}

/** The first problem among a competition's items: image, then data, then the hidden test. */
export function firstProblem(readiness: Pick<RemoteReadiness, 'image' | 'data' | 'sealedData'>): NonNullable<RemoteReadinessItem['problem']> | null {
  return readiness.image.problem ?? readiness.data.problem ?? readiness.sealedData.problem ?? null
}

/** A machine's detail cut to one line of a row: the full text is on its page. */
function brief(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A readiness cell: what it says, in what tone, and the small line under it. */
export interface ReadinessLine {
  lead: string
  tone: LineTone
  detail: string | null
}

/**
 * The «Готовность» column of a machine's row (M1, M7): where the machine
 * stands against the competition the column is about, decided in the order
 * the owner asks: is it gone, is it held (quarantine), is its code the
 * server's, and only then — is the competition's image and data in place.
 *
 * `homeVersion` names the server's release for an outdated machine («код
 * 0.23.0, сервер 0.24.0»); the machine's own is what it last said. When both
 * say the same release the build still differs (a dev build, a rebuilt
 * image), and then the line says the code differs instead of naming two
 * equal numbers as if they were the reason.
 */
export function readinessLine(
  machine: Pick<RemoteMachine, 'state' | 'compatible' | 'version' | 'readiness' | 'places' | 'lastTrouble' | 'facts' | 'selfDrain'>,
  focus: { competitionId: string; title: string } | null,
  homeVersion: string | null,
): ReadinessLine {
  if (machine.state === 'revoked') return { lead: tr('admin.runners.ready.revoked'), tone: 'muted', detail: null }
  if (machine.state === 'left') return { lead: tr('admin.runners.ready.left'), tone: 'muted', detail: null }

  const readiness = focus === null ? undefined : machine.readiness.find((item) => item.competitionId === focus.competitionId)

  if (machine.state === 'quarantined') {
    const problem = readiness ? firstProblem(readiness) : null
    return {
      lead: problem
        ? problemWords(problem.code, machine.facts)
        : machine.lastTrouble
          ? tr('admin.runners.ready.quarantinedWhy', { why: brief(machine.lastTrouble, 90) })
          : tr('admin.runners.ready.quarantined'),
      tone: 'danger',
      detail: tr('admin.runners.ready.quarantinedHint'),
    }
  }

  if (machine.state === 'outdated' || !machine.compatible || readiness?.verdict === 'outdated') {
    const named = machine.version !== null && homeVersion !== null && machine.version !== homeVersion
    return {
      lead: named
        ? tr('admin.runners.ready.outdated', { machine: machine.version as string, home: homeVersion as string })
        : tr('admin.runners.ready.outdatedBare'),
      tone: 'warning',
      detail:
        machine.places.busy > 0
          ? tr('admin.runners.ready.outdatedBusy', { count: machine.places.busy })
          : tr('admin.runners.ready.outdatedIdle'),
    }
  }

  if (machine.state === 'draining') {
    // Drained by the machine itself (RemoteMachine.selfDrain): an update, a
    // stop or a leave on the machine. «Вернуть в работу — в меню» under it
    // sent the owner to a resume that changes nothing, since the drain is not
    // theirs to lift: the machine takes work again by itself once it is back
    // (or, leaving, never).
    if (machine.selfDrain === 'leaving') {
      return {
        lead:
          machine.places.busy > 0
            ? tr('admin.runners.ready.leaving', { count: machine.places.busy })
            : tr('admin.runners.ready.leavingIdle'),
        tone: 'muted',
        detail: tr('admin.runners.ready.leavingHint'),
      }
    }
    if (machine.selfDrain === 'draining') {
      return {
        lead:
          machine.places.busy > 0
            ? tr('admin.runners.ready.stopping', { count: machine.places.busy })
            : tr('admin.runners.ready.stoppingIdle'),
        tone: 'muted',
        detail: tr('admin.runners.ready.stoppingHint'),
      }
    }
    return {
      lead:
        machine.places.busy > 0
          ? tr('admin.runners.ready.draining', { count: machine.places.busy })
          : tr('admin.runners.ready.drained'),
      tone: 'muted',
      detail: tr('admin.runners.ready.resumeHint'),
    }
  }

  let line: ReadinessLine
  if (focus === null) {
    line = { lead: tr('admin.runners.ready.none'), tone: 'muted', detail: tr('admin.runners.ready.noneDetail') }
  } else if (readiness === undefined) {
    line = { lead: tr('admin.runners.ready.unknown', { title: focus.title }), tone: 'muted', detail: null }
  } else {
    line = verdictLine(readiness, machine)
  }

  // Silent: the last word it gave stands, with the fact that it no longer
  // answers. Whether its leases are already back in the queue is home's to
  // know (path evidence, §3.4), so the line says what will happen, not what
  // may not have yet.
  if (machine.state === 'silent') {
    const words = readiness ? itemsWords(readiness) : ''
    return {
      lead: words ? `${words} · ${tr('admin.runners.ready.notAnswering')}` : tr('admin.runners.ready.notAnswering'),
      tone: 'warning',
      detail: tr('admin.runners.ready.silentDetail'),
    }
  }
  return line
}

/** One competition's verdict on a machine that answers and whose code is the server's. */
function verdictLine(readiness: RemoteReadiness, machine: Pick<RemoteMachine, 'places' | 'facts'>): ReadinessLine {
  const items = itemsWords(readiness)
  switch (readiness.verdict) {
    case 'taking': {
      const image = sizeWords(readiness.image.bytes)
      const data = sizeWords(readiness.data.bytes)
      const detail = [
        image ? `${readiness.environment} ${image}` : readiness.environment,
        data ? tr('admin.runners.ready.dataSize', { size: data }) : null,
      ]
        .filter(Boolean)
        .join(' · ')
      return { lead: [items, tr('admin.runners.ready.taking')].filter(Boolean).join(' · '), tone: 'positive', detail }
    }
    case 'preparing':
      return {
        lead: items || tr('admin.runners.ready.preparingBare'),
        tone: 'accent',
        detail:
          machine.places.busy > readiness.running
            ? tr('admin.runners.ready.preparingBusy', { title: readiness.title })
            : tr('admin.runners.ready.preparing', { title: readiness.title }),
      }
    case 'problem': {
      const problem = firstProblem(readiness)
      return {
        lead: problem ? problemWords(problem.code, machine.facts) : tr('admin.runners.ready.problem'),
        tone: 'danger',
        detail: problem?.detail ? brief(problem.detail) : null,
      }
    }
    case 'home_only':
      return {
        lead: tr('admin.runners.ready.homeOnly'),
        tone: 'warning',
        detail: tr('admin.runners.ready.homeOnlyDetail', { environment: readiness.environment }),
      }
    case 'needs_trusted':
      return {
        lead: tr('admin.runners.ready.needsTrusted'),
        tone: 'muted',
        detail: tr('admin.runners.ready.needsTrustedDetail', { title: readiness.title }),
      }
    case 'needs_card':
      return { lead: tr('admin.runners.ready.needsCard', { title: readiness.title }), tone: 'muted', detail: null }
    case 'outdated':
      // Handled before this is reached (readinessLine); kept for the type.
      return { lead: tr('admin.runners.ready.outdatedBare'), tone: 'warning', detail: tr('admin.runners.ready.outdatedIdle') }
  }
}

/* ------------------------------------------------- the machine page's table */

export interface ReadinessCells {
  /** «видеокарта · скрытый тест» under the competition's title. */
  about: string
  image: ReadinessLine & { percent: number | null }
  data: ReadinessLine & { percent: number | null }
  result: ReadinessLine
}

/** «2,1 из 4,6 ГБ» for a download under way; `null` when its size was not said. */
function progressBytes(item: RemoteReadinessItem): string | null {
  if (item.state !== 'fetching' || item.bytes === null || item.percent === null) return null
  const done = sizeWords((item.bytes * Math.max(0, Math.min(100, item.percent))) / 100)
  const total = sizeWords(item.bytes)
  return done && total ? tr('admin.runners.page.ofSize', { done, total }) : null
}

/**
 * One row of «Готовность к соревнованиям» on a machine's page (M3): the
 * image by its environment's name, the data with the hidden test under it,
 * and the verdict — the same words the console and the editor use.
 */
export function readinessCells(readiness: RemoteReadiness, facts: Pick<RemoteMachineFacts, 'driver'>): ReadinessCells {
  const about = [
    readiness.gpu ? tr('admin.runners.page.withCard') : tr('admin.runners.page.withoutCard'),
    readiness.sealed ? tr('admin.runners.page.withSealed') : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const env = readiness.environment
  const image = readiness.image
  const imageCell: ReadinessCells['image'] =
    readiness.verdict === 'home_only'
      ? { lead: env, tone: 'muted', detail: tr('admin.runners.page.builtHere'), percent: null }
      : image.state === 'ready'
        ? { lead: tr('admin.runners.page.envReady', { environment: env }), tone: 'positive', detail: sizeWords(image.bytes), percent: null }
        : image.state === 'fetching'
          ? {
              lead:
                image.percent === null
                  ? tr('admin.runners.page.envFetchingBare', { environment: env })
                  : tr('admin.runners.page.envFetching', { environment: env, percent: Math.floor(image.percent) }),
              tone: 'accent',
              detail: progressBytes(image),
              percent: image.percent,
            }
          : image.state === 'waiting'
            ? { lead: tr('admin.runners.page.envWaiting', { environment: env }), tone: 'muted', detail: null, percent: null }
            : image.state === 'problem'
              ? {
                  lead: tr('admin.runners.page.envProblem', { environment: env }),
                  tone: 'danger',
                  detail: image.problem ? problemWords(image.problem.code, facts) : null,
                  percent: null,
                }
              : { lead: env, tone: 'muted', detail: null, percent: null }

  const data = readiness.data
  const sealedWord = readiness.sealed
    ? readiness.sealedData.state === 'not_needed'
      ? tr('admin.runners.page.sealedTrustedOnly')
      : itemWord('sealed', readiness.sealedData)
    : null
  const dataCell: ReadinessCells['data'] =
    data.state === 'ready'
      ? { lead: tr('admin.runners.page.dataReady', { size: sizeWords(data.bytes) ?? '' }).trim(), tone: 'positive', detail: sealedWord, percent: null }
      : data.state === 'fetching'
        ? {
            lead:
              data.percent === null
                ? tr('admin.runners.page.dataFetchingBare')
                : tr('admin.runners.page.dataFetching', { percent: Math.floor(data.percent) }),
            tone: 'accent',
            detail: [progressBytes(data), sealedWord].filter(Boolean).join(' · ') || null,
            percent: data.percent,
          }
        : data.state === 'waiting'
          ? { lead: tr('admin.runners.page.dataWaiting'), tone: 'muted', detail: sealedWord, percent: null }
          : data.state === 'problem'
            ? {
                lead: tr('admin.runners.page.dataProblem'),
                tone: 'danger',
                detail: data.problem ? problemWords(data.problem.code, facts) : sealedWord,
                percent: null,
              }
            : { lead: '—', tone: 'muted', detail: sealedWord, percent: null }

  return { about, image: imageCell, data: dataCell, result: resultCell(readiness, facts) }
}

/** The «Итог» of a competition on a machine. */
export function resultCell(readiness: RemoteReadiness, facts: Pick<RemoteMachineFacts, 'driver'>): ReadinessLine {
  switch (readiness.verdict) {
    case 'taking':
      return {
        lead: tr('admin.runners.page.result.taking'),
        tone: 'positive',
        detail: readiness.running > 0 ? tr('admin.runners.page.result.running', { count: readiness.running }) : null,
      }
    case 'preparing':
      return { lead: tr('admin.runners.page.result.preparing'), tone: 'ink', detail: null }
    case 'problem': {
      const problem = firstProblem(readiness)
      return {
        lead: tr('admin.runners.page.result.problem'),
        tone: 'danger',
        detail: problem ? problemWords(problem.code, facts) : null,
      }
    }
    case 'home_only':
      return { lead: tr('admin.runners.ready.homeOnly'), tone: 'warning', detail: tr('admin.runners.page.result.homeOnly') }
    case 'needs_trusted':
      return { lead: tr('admin.runners.page.result.needsTrusted'), tone: 'muted', detail: tr('admin.runners.page.result.needsTrustedWhy') }
    case 'needs_card':
      return { lead: tr('admin.runners.page.result.needsCard'), tone: 'muted', detail: null }
    case 'outdated':
      return { lead: tr('admin.runners.page.result.outdated'), tone: 'warning', detail: tr('admin.runners.ready.outdatedIdle') }
  }
}

/* ------------------------------------------------------------- the menu */

export interface MachineMenu {
  places: boolean
  perDevice: boolean
  trust: boolean
  drain: boolean
  resume: boolean
  revoke: boolean
  /** «Принимает занятия» (D2), a checkbox item with its warning under it. */
  classes: boolean
  /** «Перенести занятия»: only while a class holds a slot on it. */
  moveClasses: boolean
  /** «Вернуть занятиям»: only under the class quarantine (D32). */
  resumeClasses: boolean
  /**
   * The one of the two flags the other one greys (D3), with its reason:
   * «Доверенная» while it takes classes, «Принимает занятия» while it is
   * trusted. Null — both may be pressed.
   */
  locked: { item: 'trust' | 'classes'; why: string } | null
}

/**
 * What the row's ⋯ menu and the page's header offer. A gone machine offers
 * nothing: its secret is refused, and whatever is set on it would never
 * reach it. Drain and resume are one place, by the state: a quarantined
 * machine is drained by home, and «Вернуть в работу» is how the owner says
 * the cause is fixed.
 *
 * A machine that drains by itself (RemoteMachine.selfDrain: `colloq-host
 * runner update`, a stop, a leave) is not held by anyone's word here: the
 * resume door lifts only the owner's drain or home's quarantine, so it
 * answered 200 and the machine stayed «осушается». It offers «Осушить»
 * instead — the owner's drain is what keeps it from taking work once it is
 * back from its update.
 */
export function machineMenu(machine: Pick<RemoteMachine, 'state' | 'cards' | 'selfDrain' | 'trusted' | 'classes'>): MachineMenu {
  const live = !machineGone(machine.state)
  const own = machine.state === 'draining' && machine.selfDrain !== undefined
  const held = (machine.state === 'draining' && !own) || machine.state === 'quarantined'
  const classes = machine.classes
  const locked = !live
    ? null
    : classes?.on
      ? { item: 'trust' as const, why: tr('admin.runners.menu.trustNotWithClasses') }
      : machine.trusted
        ? { item: 'classes' as const, why: tr('admin.runners.menu.classesNotWithTrust') }
        : null
  return {
    places: live,
    perDevice: live && machine.cards.length > 0,
    trust: live,
    drain: live && !held,
    resume: live && held,
    revoke: live,
    classes: live,
    moveClasses: live && (classes?.held.slots ?? 0) > 0,
    resumeClasses: live && (classes?.quarantinedAt ?? null) !== null,
    locked,
  }
}

/** The list's order: machines that are still here first, as the server sent them; gone ones after. */
export function listOrder<T extends Pick<RemoteMachine, 'state'>>(machines: readonly T[]): T[] {
  return [...machines.filter((machine) => !machineGone(machine.state)), ...machines.filter((machine) => machineGone(machine.state))]
}

/* --------------------------------------------------------------- numbers in */

/**
 * A whole number the owner typed, within bounds, or `null` for an empty
 * field («авто», «как на сервере»). The word itself is accepted too, in the
 * panel's language and in English: the placeholder says it, and a person who
 * types what they see should get what they typed.
 */
export function wholeOrAuto(text: string, min: number, max: number): { value: number | null } | { error: true } {
  const typed = text.trim().toLowerCase()
  if (typed === '' || typed === 'auto' || typed === tr('admin.runners.auto').toLowerCase()) return { value: null }
  if (!/^\d+$/.test(typed.replace(/[\s_]/g, ''))) return { error: true }
  const value = Number(typed.replace(/[\s_]/g, ''))
  return Number.isInteger(value) && value >= min && value <= max ? { value } : { error: true }
}

/** The places field's bounds: a lease per place, and a machine holds at most REMOTE_ATTEMPTS_MAX. */
export const PLACES_BOUNDS = { min: 1, max: REMOTE_ATTEMPTS_MAX } as const
/** Runs per card: shared/remote-runner.ts · REMOTE_PER_DEVICE_MAX. */
export const PER_DEVICE_BOUNDS = { min: 1, max: REMOTE_PER_DEVICE_MAX } as const
/**
 * A code joins 1–100 machines (MintRemoteCodeRequest.machines): the door's
 * bound and `colloq-host runner-code --machines`'s (server/src/competitions/
 * remote/store.ts · REMOTE_CODE_MACHINES_MAX). A stricter one here refused
 * in the dialog what the shell on the same server allows.
 */
export const MACHINES_BOUNDS = { min: 1, max: 100 } as const
/** A code lives 1 h to a day (REMOTE_CODE_TTL_MAX_MS). */
export const HOURS_BOUNDS = { min: 1, max: Math.floor(REMOTE_CODE_TTL_MAX_MS / HOUR) } as const

export interface ConnectForm {
  machines: string
  hours: string
  /** Empty or «авто»: whatever each machine offers. */
  places: string
  trusted: boolean
  /** «Принимать занятия» (D2): never together with `trusted` (D3); the dialog greys the one while the other is on. */
  classes: boolean
}

/** The dialog's starting point: one machine, a day, auto, not trusted (decision 1), no classes (D2). */
export function connectDefaults(): ConnectForm {
  return { machines: '1', hours: String(HOURS_BOUNDS.max), places: '', trusted: false, classes: false }
}

/** The form as the code door wants it, or the first field that will not do, in words. */
export function mintRequest(form: ConnectForm): { request: MintRemoteCodeRequest } | { error: string } {
  const machines = wholeOrAuto(form.machines, MACHINES_BOUNDS.min, MACHINES_BOUNDS.max)
  if ('error' in machines || machines.value === null) return { error: tr('admin.runners.connect.invalid.machines', { max: MACHINES_BOUNDS.max }) }
  const hours = wholeOrAuto(form.hours, HOURS_BOUNDS.min, HOURS_BOUNDS.max)
  if ('error' in hours || hours.value === null) return { error: tr('admin.runners.connect.invalid.hours', { max: HOURS_BOUNDS.max }) }
  const places = wholeOrAuto(form.places, PLACES_BOUNDS.min, PLACES_BOUNDS.max)
  if ('error' in places) return { error: tr('admin.runners.connect.invalid.places', { max: PLACES_BOUNDS.max }) }
  // The dialog never offers both (D3); a form that still has them is refused here in the door's own words.
  if (form.trusted === true && form.classes === true) return { error: tr('admin.runners.connect.classesSealed') }
  return {
    request: {
      machines: machines.value,
      hours: hours.value,
      trusted: form.trusted === true,
      approvedSlots: places.value,
      ...(form.classes === true ? { classes: true } : {}),
    },
  }
}

/**
 * A code still valid, as the machines block lists it (M1): how many machines
 * it is for and how many joined, the places it caps them at, until when it
 * is valid, and whose it is — «на 3 машины, подключилось 1 · действует до
 * 23:41 · выпуск: Анна Ким».
 *
 * Listed because a code outlives the dialog that showed it: closing the
 * window, or disconnecting every machine that joined with it, left a code
 * for more machines valid for up to a day, and invisible — in a VM's
 * `docker inspect`, a Vast on-start or a chat, enough to join a fresh,
 * possibly trusted machine. The list is where the owner sees it and cancels
 * it.
 */
export function codeWords(
  code: Pick<RemoteCodeView, 'machines' | 'used' | 'approvedSlots' | 'expiresAt' | 'createdBy' | 'console'>,
  now: number,
): string {
  return [
    tr('admin.runners.codes.uses', { count: code.machines, used: code.used }),
    code.approvedSlots === null ? null : tr('admin.runners.codes.places', { count: code.approvedSlots }),
    tr('admin.runners.codes.until', { time: clockTime(code.expiresAt, now) }),
    // Whose it is, when the server says: a code minted on the console is not one the panel's owner pasted anywhere.
    code.console ? tr('admin.runners.codes.console') : code.createdBy ? tr('admin.runners.codes.by', { name: code.createdBy }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** One of the dialog's join commands (M2): what it is for, and the exact text Copy takes. */
export interface JoinCommand {
  key: 'docker' | 'bare' | 'vast'
  label: string
  text: string
}

/**
 * The join commands the dialog draws, in the server's order, and only those
 * the server filled in (MintRemoteCodeResponse.commands). It leaves `vast`
 * out ('') on purpose for an instance on an image of its own — a
 * university's registry, an official image pinned by digest with no release
 * label — since `make vast-runner` machines take the published colloq-server
 * of the release, which is not this instance's build (remote/commands.ts).
 * Drawn anyway, that was a label over an empty terminal box whose Copy
 * copied nothing and said «Скопировано»; the dialog says why it is missing
 * instead (`vastLeftOut`), as `colloq-host runner-code` does.
 */
export function joinCommands(commands: MintRemoteCodeResponse['commands']): { commands: JoinCommand[]; vastLeftOut: boolean } {
  const all: JoinCommand[] = [
    { key: 'docker', label: tr('admin.runners.connect.docker'), text: commands.docker },
    { key: 'bare', label: tr('admin.runners.connect.bare', { min: REMOTE_DRIVER_MIN }), text: commands.bare },
    { key: 'vast', label: tr('admin.runners.connect.vast'), text: commands.vast },
  ]
  return { commands: all.filter((command) => command.text.trim() !== ''), vastLeftOut: commands.vast.trim() === '' }
}

/* ---------------------------------------------------- «ждём первую машину» */

/**
 * How many machines joined with the code the dialog minted, by the code's
 * own count (RemoteCodeView.used, matched on MintRemoteCodeResponse.id).
 *
 * The list keeps only codes with uses left, so a code still valid that has
 * left it is spent: every machine it was minted for joined. But only once
 * the list has shown it (`seen`): the list read before the code was minted
 * does not have it either, and «все подключились» the moment the commands
 * appeared would be the dialog's first word. Before that, nothing joined
 * that the list knows of. `null` — the server gave no id, or the code
 * expired and left the list: then the newcomers count (joinProgress).
 */
export function codeJoined(
  minted: Pick<MintRemoteCodeResponse, 'id' | 'machines' | 'expiresAt'>,
  codes: readonly Pick<RemoteCodeView, 'id' | 'used'>[],
  now: number,
  seen: boolean,
): number | null {
  if (!minted.id) return null
  const code = codes.find((one) => one.id === minted.id)
  if (code) return code.used
  if (now >= minted.expiresAt) return null
  return seen ? minted.machines : 0
}

export interface JoinProgress {
  title: string
  text: string
  /** Machines that joined since the code was shown. */
  joined: number
}

/** What a machine that has just joined is doing, in a few words. */
function joinStatus(machine: RemoteMachine): string {
  if (machine.lastSeenAt === null) return tr('admin.runners.connect.status.quiet')
  // A machine for classes pulls its class image first: «vast-11 качает образ base для занятий · 45 %».
  const block = machine.classes?.block
  if (block?.reason === 'image' && block.environment !== null && block.percent !== null) {
    return tr('admin.runners.connect.classImage', { name: machine.name, env: block.environment, percent: formatNumber(Math.round(block.percent)) })
  }
  for (const readiness of machine.readiness) {
    const problem = firstProblem(readiness)
    if (problem) return problemWords(problem.code, machine.facts)
  }
  const image = machine.readiness.find((readiness) => readiness.image.state === 'fetching')
  if (image) {
    const size = sizeWords(image.image.bytes)
    return size
      ? tr('admin.runners.connect.status.imageSized', { environment: image.environment, size })
      : tr('admin.runners.connect.status.image', { environment: image.environment })
  }
  const data = machine.readiness.find((readiness) => readiness.data.state === 'fetching' || readiness.sealedData.state === 'fetching')
  if (data) return tr('admin.runners.connect.status.data', { title: data.title })
  if (machine.readiness.some((readiness) => readiness.verdict === 'taking')) return tr('admin.runners.connect.status.ready')
  return tr('admin.runners.connect.status.online')
}

/**
 * The dialog's live line under the commands (M2): nothing yet, then which
 * machines joined and what the latest is doing.
 *
 * How many joined is the code's own count when the server tells it
 * (`joined`, codeJoined): the list's machines that are new since the code was
 * shown also take in one that joined with ANOTHER code meanwhile, and «1 из
 * 3» over a machine from yesterday's code is the dialog lying about the
 * command the owner just pasted. Which machines they are is known only when
 * the newcomers are exactly that many; otherwise the line gives the count
 * alone, never a name it cannot vouch for. Without the code's count
 * (`null`), every newcomer counts, as before.
 */
export function joinProgress(known: ReadonlySet<string>, machines: readonly RemoteMachine[], expected: number, joined: number | null = null): JoinProgress {
  const newcomers = machines.filter((machine) => !known.has(machine.id)).sort((a, b) => a.createdAt - b.createdAt)
  const count = joined ?? newcomers.length
  if (count === 0) {
    return { title: tr('admin.runners.connect.waiting'), text: tr('admin.runners.connect.waitingNote'), joined: 0 }
  }
  const title = count >= expected ? tr('admin.runners.connect.allJoined') : tr('admin.runners.connect.waitingMore')
  const total = Math.max(expected, count)
  if (joined !== null && newcomers.length !== joined) {
    return { title, text: tr('admin.runners.connect.joinedCount', { count, total }), joined: count }
  }
  const shown = newcomers.slice(-3).map((machine) => machine.name)
  const names = newcomers.length > shown.length ? `${shown.join(', ')} ${tr('admin.runners.connect.andMore', { count: newcomers.length - shown.length })}` : shown.join(', ')
  return {
    title,
    text: tr('admin.runners.connect.joined', { count, total, names, status: joinStatus(newcomers[newcomers.length - 1]) }),
    joined: count,
  }
}

/**
 * The machines that joined with the code the dialog minted, by the code
 * each of them joined with (RemoteMachine.codeId, matched on
 * MintRemoteCodeResponse.id), oldest first; `null` — the server does not say
 * which code a machine came with (a server from before it), and the dialog
 * counts by the code's own uses instead (codeJoined).
 *
 * This count does not depend on when the list was read. The list keeps only
 * codes with uses left, so a one-machine code spent before any read showed
 * it — a machine that joined within the three seconds between reads, or
 * reads that failed meanwhile — never appeared there: codeJoined said
 * nothing joined, «Ждём первую машину…» stood over the very machine it was
 * waiting for until the code expired (up to a day), and Escape asked whether
 * to close a window whose code was already used up.
 */
export function codeMachines(minted: Pick<MintRemoteCodeResponse, 'id'>, machines: readonly RemoteMachine[]): RemoteMachine[] | null {
  if (!minted.id || !machines.every((machine) => machine.codeId !== undefined)) return null
  return machines.filter((machine) => machine.codeId === minted.id).sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * The dialog's live line (M2) as it is drawn: by this code's own machines
 * when the server names each machine's code (codeMachines) — they are the
 * newcomers, by name, however the reads fell — and otherwise by the code's
 * count of uses and the machines new since the code was shown (codeJoined,
 * joinProgress).
 */
export function connectProgress(
  minted: Pick<MintRemoteCodeResponse, 'id' | 'machines' | 'expiresAt'>,
  known: ReadonlySet<string>,
  machines: readonly RemoteMachine[],
  codes: readonly Pick<RemoteCodeView, 'id' | 'used'>[],
  now: number,
  seen: boolean,
): JoinProgress {
  const mine = codeMachines(minted, machines)
  if (mine) return joinProgress(new Set(), mine, minted.machines, mine.length)
  return joinProgress(known, machines, minted.machines, codeJoined(minted, codes, now, seen))
}

/* ------------------------------------------------------------- the page */

/** «Ника Р. · #14», «#14», or nothing: who an event or a run was about. */
export function whoOf(subject: { entrantName: string | null; number: number | null }): string | null {
  if (subject.entrantName && subject.number !== null) return `${subject.entrantName} · #${subject.number}`
  if (subject.entrantName) return subject.entrantName
  return subject.number !== null ? `#${subject.number}` : null
}

/** A line of the machine's log (M3): the sentence, its tone, and what was measured under it. */
export interface EventLine {
  text: string
  tone: LineTone
  detail: string | null
}

/**
 * The machine's log, worded per kind. The competition and what home or the
 * machine measured go on a second line, as they came: one sentence per kind
 * keeps the words translatable, and a docker message glued into the middle
 * of a Russian sentence reads as neither.
 *
 * A kind this build does not know (a newer server) shows by its own name
 * rather than disappearing, as in the audit log (admin/audit.ts): a log that
 * hides what it cannot name is worse than one that shows it plainly.
 */
export function eventLine(event: Pick<RemoteEvent, 'kind' | 'attemptId' | 'entrantName' | 'number' | 'competition' | 'detail' | 'address'>): EventLine {
  const who = whoOf(event) ?? tr('admin.runners.event.someone')
  const detail =
    [event.competition ? tr('admin.runners.event.competition', { title: event.competition }) : null, event.detail?.trim() || null]
      .filter(Boolean)
      .join(' · ') || null
  const line = (text: string, tone: LineTone = 'ink'): EventLine => ({ text, tone, detail })
  switch (event.kind) {
    case 'joined':
      return line(tr('admin.runners.event.joined'))
    case 'leased':
      return line(tr('admin.runners.event.leased', { who }))
    case 'applied':
      return line(tr('admin.runners.event.applied', { who }))
    case 'declined':
      return line(tr('admin.runners.event.declined', { who }), 'warning')
    case 'lost':
      return line(tr('admin.runners.event.lost', { who }), 'danger')
    case 'withdrawn':
      return line(tr('admin.runners.event.withdrawn', { who }), 'warning')
    case 'revoked':
      return event.attemptId ? line(tr('admin.runners.event.revokedRun', { who })) : line(tr('admin.runners.event.revoked'), 'muted')
    case 'quarantined':
      return line(tr('admin.runners.event.quarantined'), 'danger')
    case 'resumed':
      return line(tr('admin.runners.event.resumed'))
    case 'drained':
      return line(tr('admin.runners.event.drained'))
    case 'trusted':
      return line(tr('admin.runners.event.trusted'))
    case 'untrusted':
      return line(tr('admin.runners.event.untrusted'))
    case 'renamed':
      return line(tr('admin.runners.event.renamed'))
    case 'outdated':
      return line(tr('admin.runners.event.outdated'), 'warning')
    case 'image_ready':
      return line(tr('admin.runners.event.image_ready'))
    case 'data_ready':
      return line(tr('admin.runners.event.data_ready'))
    case 'sealed_fetched':
      return line(tr('admin.runners.event.sealed_fetched'))
    case 'problem':
      return line(tr('admin.runners.event.problem'), 'danger')
    case 'left':
      return line(tr('admin.runners.event.left'), 'muted')
    // Classes on machines (remote-classes.md §11): worded here, never the server's measured English underneath.
    case 'tunnel_replaced': {
      const previous = event.detail?.trim() || null
      const address = event.address?.trim() || null
      if (!address || !previous || address === previous) return { text: tr('admin.runners.event.tunnel_reconnected'), tone: 'muted', detail: null }
      return { text: tr('admin.runners.event.tunnel_replaced', { address, previous }), tone: 'warning', detail: null }
    }
    case 'class_failover':
      return { ...classFailoverLine(event.detail), detail: null }
    case 'classes_quarantined':
      return { text: tr('admin.runners.event.classes_quarantined'), tone: 'danger', detail: null }
    case 'classes_resumed':
      return { text: tr('admin.runners.event.classes_resumed'), tone: 'ink', detail: null }
    case 'unclassed': {
      const moved = /^moved (\d+)$/.exec(event.detail?.trim() ?? '')
      return {
        text: moved ? tr('admin.runners.event.unclassedMoved', { count: Number(moved[1]) }) : tr('admin.runners.event.unclassed'),
        tone: 'warning',
        detail: null,
      }
    }
    case 'perimeter_failing':
      return { text: tr('admin.runners.event.perimeter_failing'), tone: 'danger', detail: null }
    default:
      return line(String(event.kind), 'muted')
  }
}

/**
 * A `class_failover` line (placement.ts · failedOver writes its cause, and
 * «moved: Ада» for a move by hand): why the classes left, in words. A cause
 * this build does not know reads as the plain move.
 */
function classFailoverLine(detail: string | null): Line {
  const [cause, ...rest] = (detail ?? '').split(':')
  const who = rest.join(':').trim()
  if (cause === 'moved' && who) return { text: tr('admin.runners.event.class_failover_by', { who }), tone: 'warning' }
  const why = ((): string => {
    switch (cause.trim()) {
      case 'silence':
        return tr('admin.runners.event.why.silence')
      case 'tunnel':
        return tr('admin.runners.event.why.tunnel')
      case 'revoked':
        return tr('admin.runners.event.why.revoked')
      case 'unclassed':
        return tr('admin.runners.event.why.unclassed')
      case 'leaving':
        return tr('admin.runners.event.why.leaving')
      case 'perimeter':
        return tr('admin.runners.event.why.perimeter')
      case 'blocked':
        return tr('admin.runners.event.why.blocked')
      default:
        return tr('admin.runners.event.why.moved')
    }
  })()
  return { text: tr('admin.runners.event.class_failover', { why }), tone: 'warning' }
}

/** Where a run on a machine is, while its container has not started or has ended. */
export function runPhaseWord(phase: RemoteMachineRun['phase'] | undefined): string | null {
  switch (phase) {
    case 'accepted':
      return tr('admin.runners.phase.accepted')
    case 'preparing':
      return tr('admin.runners.phase.preparing')
    case 'exporting':
      return tr('admin.runners.phase.exporting')
    case 'uploading':
      return tr('admin.runners.phase.uploading')
    default:
      return null
  }
}

/**
 * The header's line under the title (M3): address, release and whether its
 * code is the server's, when it joined, when it was last heard.
 */
export function machineLede(machine: Pick<RemoteMachine, 'address' | 'version' | 'compatible' | 'createdAt' | 'lastSeenAt' | 'state'>, now: number): string {
  return [
    machine.address,
    machine.version === null
      ? null
      : `colloq ${machine.version}, ${machine.compatible ? tr('admin.runners.page.codeSame') : tr('admin.runners.page.codeDiffers')}`,
    tr('admin.runners.page.joined', { when: formatDate(machine.createdAt, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) }),
    machine.lastSeenAt === null
      ? tr('admin.runners.seen.never')
      : machine.state === 'silent'
        ? tr('admin.runners.page.heardAt', { time: clockTime(machine.lastSeenAt, now) })
        : tr('admin.runners.page.heard', { ago: heardAgo(machine.lastSeenAt, now) }),
  ]
    .filter(Boolean)
    .join(' · ')
}

/* --------------------------------------------------------------- the console */

/** A group of the console grid: this server or a machine, and the runs drawn under it. */
export interface ConsoleGroup {
  key: string
  group: RemoteConsoleGroup
  runs: RunningNow[]
}

/**
 * The console's grid by where a run is (M4): this server first, then each
 * machine, in the server's order. A run whose machine the groups do not name
 * (it was disconnected a moment ago, and the groups and the runs come from
 * two looks at the queue) still gets a group of its own, so it is never
 * silently dropped from the grid; one of this server's with no server group
 * gets one too.
 */
export function consoleGroups(groups: readonly RemoteConsoleGroup[], running: readonly RunningNow[]): ConsoleGroup[] {
  const out: ConsoleGroup[] = groups.map((group) => ({ key: group.machineId ?? 'home', group, runs: [] }))
  const byKey = new Map(out.map((entry) => [entry.key, entry]))
  /** Groups made up here: they count their own runs, since nobody said their places. */
  const made = new Set<string>()
  for (const run of running) {
    const id = run.machine?.id ?? null
    const key = id ?? 'home'
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        key,
        group: { machineId: id, name: run.machine?.name ?? null, state: null, places: 0, busy: 0, cards: null },
        runs: [],
      }
      byKey.set(key, entry)
      made.add(key)
      if (id === null) out.unshift(entry)
      else out.push(entry)
    }
    entry.runs.push(run)
    if (made.has(key)) entry.group = { ...entry.group, busy: entry.runs.length, places: entry.runs.length }
  }
  return out
}

/**
 * The free places a group draws: its places for notebooks less the
 * notebooks drawn under it. A metric run here is the metric lane's
 * (scoreSlots), not one of this server's notebook places — counted against
 * them, two rescores left two free cells under «Сервер · 0 из 4», while all
 * four could take a notebook. A server that runs no notebooks has none to
 * give.
 *
 * The console's header counts the queue's own number (QueueSnapshot.slots),
 * not a sum over these groups: it is the one the forecast and the
 * participant's estimate are counted by, and the groups also list machines
 * that only finish what they hold.
 */
export function freePlaces(group: Pick<RemoteConsoleGroup, 'places' | 'metricsOnly'>, runs: readonly Pick<RunningNow, 'kind'>[]): number {
  if (group.metricsOnly) return 0
  return Math.max(0, group.places - runs.filter((run) => run.kind !== 'metric').length)
}

/** What the console's header counts (consoleLoad). */
export interface ConsoleLoad {
  /** Notebook runs on the executors whose places the header's number is (QueueSnapshot.slots). */
  busy: number
  /** Notebook runs on this server: the plain grid draws its free cells from these. */
  homeNotebooks: number
  /** Metric runs on this server: the metric lane's, never one of the notebook places. */
  metrics: number
  /** The metric lane's places when the server said them (RemoteConsoleGroup.metric); `null` — not said. */
  metricPlaces: number | null
}

/**
 * The console's header and plain grid (M4), counted the way the queue
 * counts its places: «ИСПОЛНИТЕЛИ · busy ИЗ slots» is the notebook lane's.
 *
 * Since the two lanes (§5.3) a metric — a rescore, a machine's result —
 * runs under «Оценок одновременно», not in one of this server's notebook
 * places, and `running` lists those runs too: counted against the places, a
 * single server with one place, one notebook and two rescores read «3 ИЗ 1
 * ЗАНЯТЫ», and three places, one notebook and two metrics drew no free cell
 * while two notebook places stood free and the pump took the next upload at
 * once. So the metric runs are counted apart (`metrics`, said in the header
 * beside the places), and the busy places are the notebook runs here — while
 * this server runs notebooks — plus the runs on machines that take work now:
 * a silent, draining or outdated machine's runs are not in the queue's
 * places (a live machine's only are, §5.7), and counted in them they read as
 * places taken that nobody counts as places.
 */
export function consoleLoad(
  running: readonly Pick<RunningNow, 'kind' | 'machine'>[],
  groups: readonly Pick<RemoteConsoleGroup, 'machineId' | 'state' | 'metricsOnly' | 'metric'>[] | null,
): ConsoleLoad {
  const here = running.filter((run) => !run.machine)
  const homeNotebooks = here.filter((run) => run.kind !== 'metric').length
  const metrics = here.length - homeNotebooks
  if (!groups) return { busy: homeNotebooks, homeNotebooks, metrics, metricPlaces: null }
  const home = groups.find((group) => group.machineId === null)
  const live = new Set(groups.filter((group) => group.machineId !== null && group.state === 'online').map((group) => group.machineId))
  const onMachines = running.filter((run) => run.machine && live.has(run.machine.id)).length
  return {
    busy: (home?.metricsOnly ? 0 : homeNotebooks) + onMachines,
    homeNotebooks,
    metrics,
    metricPlaces: home?.metric?.places ?? null,
  }
}

/** The metric lane's part of the console's header: «МЕТРИКИ · 2 ИЗ 2», «МЕТРИКИ · 2» when its places were not said; `null` — none runs. */
export function metricLaneHead(load: Pick<ConsoleLoad, 'metrics' | 'metricPlaces'>): string | null {
  if (load.metrics === 0) return null
  return load.metricPlaces === null
    ? tr('admin.competitions.fleet.metricLaneBare', { busy: load.metrics })
    : tr('admin.competitions.fleet.metricLane', { busy: load.metrics, count: load.metricPlaces })
}

/**
 * Whether a run on a machine can still be stopped there: its notebook has
 * not finished — the machine accepted it, prepares it, or runs its container
 * (RemoteAttemptPhase; a phase not said yet is `accepted`, as the server
 * reads it). Exporting or uploading, the notebook has run, and its answer is
 * on its way here to be scored: a stop now threw a finished result away.
 * The kill door says the same at the moment of the press (`onMachine`).
 */
export function stoppableOnMachine(phase: RemoteAttemptPhase | null | undefined): boolean {
  return phase !== 'exporting' && phase !== 'uploading'
}

/** «на сервере и 2 машинах», «на 3 машинах»; `null` with no machine in the groups. */
export function fleetWords(groups: readonly RemoteConsoleGroup[]): string | null {
  const machines = groups.filter((group) => group.machineId !== null).length
  if (machines === 0) return null
  const home = groups.find((group) => group.machineId === null)
  return home && !home.metricsOnly
    ? tr('admin.competitions.fleet.where', { count: machines })
    : tr('admin.competitions.fleet.whereMachines', { count: machines })
}

/** The state chip of a machine's group; `null` for this server, which has none. */
export function groupChip(group: RemoteConsoleGroup, now: number): { word: string; tone: ChipTone } | null {
  if (group.machineId === null || group.state === null) return null
  return stateChip(group.state, group.silentSince, now)
}

/**
 * The muted line beside a group's name (M4): «только метрики · 2 из 2» for
 * this server, «16 из 16 · 2 карты по 8» for a machine that takes work, and
 * for one that does not, why — «досчитывает 2 · новых не берёт», or for a
 * silent one what became of its runs. `returned` is how many of THIS
 * competition's waiting rows came back from it (the console sees only its
 * own); `homeVersion` is the server's release as this server's own group
 * says it (RemoteConsoleGroup.version) — never the panel bundle's, which a
 * browser holding an old panel would name.
 */
export function groupLine(group: RemoteConsoleGroup, returned: number, homeVersion: string | null): string {
  if (group.machineId === null) {
    // With notebooks off, `places` and `busy` are the notebook lane's — zero
    // — and «только метрики · 0 из 0» over two metrics running said the
    // opposite of what this server does. The metric lane's own numbers
    // (`metric`) when the server sends them; no number at all when not.
    if (group.metricsOnly) {
      return group.metric
        ? tr('admin.competitions.fleet.homeMetrics', { busy: group.metric.busy, count: group.metric.places })
        : tr('admin.competitions.fleet.homeMetricsBare')
    }
    return tr('admin.competitions.fleet.places', { busy: group.busy, count: group.places })
  }
  const finishing = group.busy > 0 ? tr('admin.competitions.fleet.finishing', { count: group.busy }) : tr('admin.competitions.fleet.noNew')
  switch (group.state) {
    case 'silent':
      return returned > 0 ? tr('admin.competitions.fleet.silentReturned', { count: returned }) : tr('admin.competitions.fleet.silent')
    case 'outdated': {
      const named = group.version && homeVersion && group.version !== homeVersion
      return named ? `${finishing}: ${tr('admin.competitions.fleet.versions', { machine: group.version as string, home: homeVersion as string })}` : finishing
    }
    case 'draining':
    case 'quarantined':
    case 'revoked':
    case 'left':
      return finishing
    default: {
      const places = tr('admin.competitions.fleet.places', { busy: group.busy, count: group.places })
      return group.cards ? `${places} · ${tr('admin.competitions.fleet.cards', { count: group.cards.count, per: group.cards.perDevice })}` : places
    }
  }
}

/** How many of these waiting rows came back from a machine of this name. */
export function returnedFrom(waiting: readonly Pick<WaitingRow, 'reason' | 'returnedFrom'>[], name: string | null): number {
  if (!name) return 0
  return waiting.filter((row) => row.reason === 'returned' && row.returnedFrom === name).length
}

/**
 * The line under a waiting submission when it waits for a machine's reason
 * rather than its turn (RemoteWaitReason), or because its result waits for
 * its metric here. A row that came back from a machine says which one, and
 * why only when home said why (WaitingRow.returnedWhy): «замолчала» about a
 * machine that refused a notebook would send the owner to a VM that is fine.
 *
 * `home` is this server as its console group says it (RemoteConsoleGroup:
 * `metricsOnly`), when the console has groups. `home_only_env` has two
 * causes on the server (remote/views.ts · blockedBy): this server runs no
 * notebooks, or the notebook needs a card and this server gives submissions
 * none. «…а он считает только метрики» over a server whose notebooks are on
 * sent the owner to a switch that was already on; with them on, the cause is
 * the card.
 *
 * A notebook too big for this server (WaitingRow.tooBig: it leaves it to the
 * machines, runner.ts · leftToMachines) has a third cause for three of the
 * reasons, the server's size, and says it: on a server that never had a
 * machine there is no group to tell the switch by, and «сервер считает
 * только метрики» was said of one that runs notebooks.
 */
export function waitReason(
  row: Pick<WaitingRow, 'reason' | 'returnedFrom' | 'returnedWhy' | 'scoring' | 'tooBig'>,
  home: { notebooks: boolean } | null = null,
): Line | null {
  switch (row.reason) {
    case 'returned': {
      const machine = row.returnedFrom
      if (!machine) return { text: tr('admin.competitions.fleet.reason.returnedBare'), tone: 'warning' }
      switch (row.returnedWhy) {
        case 'silent':
          return { text: tr('admin.competitions.fleet.reason.returnedSilent', { machine }), tone: 'warning' }
        case 'declined':
          return { text: tr('admin.competitions.fleet.reason.returnedDeclined', { machine }), tone: 'warning' }
        case 'released':
          return { text: tr('admin.competitions.fleet.reason.returnedReleased', { machine }), tone: 'warning' }
        default:
          return { text: tr('admin.competitions.fleet.reason.returned', { machine }), tone: 'warning' }
      }
    }
    case 'no_runners':
      return { text: tr(row.tooBig ? 'admin.competitions.fleet.reason.no_runnersTooBig' : 'admin.competitions.fleet.reason.no_runners'), tone: 'warning' }
    case 'no_gpu_runner':
      return { text: tr('admin.competitions.fleet.reason.no_gpu_runner'), tone: 'warning' }
    case 'preparing_image':
      return { text: tr('admin.competitions.fleet.reason.preparing_image'), tone: 'accent' }
    case 'preparing_data':
      return { text: tr('admin.competitions.fleet.reason.preparing_data'), tone: 'accent' }
    case 'needs_trusted':
      return { text: tr('admin.competitions.fleet.reason.needs_trusted'), tone: 'warning' }
    case 'home_only_env':
      return {
        text: tr(
          row.tooBig
            ? 'admin.competitions.fleet.reason.home_only_envTooBig'
            : home?.notebooks
              ? 'admin.competitions.fleet.reason.home_only_envNoCard'
              : 'admin.competitions.fleet.reason.home_only_env',
        ),
        tone: 'warning',
      }
    case 'no_fit':
      // No machine that takes work can run it as it is — its memory or CPUs
      // over a machine's, a package set too big for a lease (RemoteWaitReason)
      // — so it waits for this server or a bigger machine, and its turn
      // alone will not bring it. Too big for this server as well, it waits
      // for a bigger machine alone.
      return { text: tr(row.tooBig ? 'admin.competitions.fleet.reason.no_fitTooBig' : 'admin.competitions.fleet.reason.no_fit'), tone: 'warning' }
    default:
      return row.scoring ? { text: tr('admin.competitions.fleet.reason.scoring'), tone: 'accent' } : null
  }
}

/**
 * The one line under a waiting submission in the console: a machine's
 * reason (waitReason) when there is one, the card it waits for when that is
 * all (`onCard`, admin/competitions.ts · waitsForCard), nothing for a plain
 * turn.
 *
 * The reason comes first. «ждёт место на видеокарте» says a share will free
 * by itself; a reason says what has to change instead. With the card's words
 * first, a GPU notebook on a server without cards whose machines had gone
 * read «ждёт место на видеокарте» while nothing anywhere could take it, and
 * a row back from a silent machine lost its «вернулась: … замолчала» the
 * moment every share was busy. Without machines a reason appears only when
 * this server runs no notebooks, or the notebook is too big for it, and then
 * no card frees anything either.
 */
export function waitingLine(
  row: Pick<WaitingRow, 'reason' | 'returnedFrom' | 'returnedWhy' | 'scoring' | 'tooBig'>,
  onCard: boolean,
  home: { notebooks: boolean } | null = null,
): Line | null {
  const reason = waitReason(row, home)
  if (reason) return reason
  return onCard ? { text: tr('admin.competitions.waitsForCard'), tone: 'accent' } : null
}

/**
 * The warning over the waiting list when GPU work has no share on any card
 * to start on (admin/competitions.ts · noPlaceOnCards). Without machines it
 * is this server's card, given on «Ресурсы»; with machines (`fleet`) it is
 * also every machine on the line, and a server like vsos has no card of its
 * own to give — sending its owner to give one was advice nobody could take.
 */
export function cardlessWarning(fleet: boolean): string {
  return tr(fleet ? 'admin.competitions.fleet.gpuNoPlace' : 'admin.competitions.gpuNoPlace')
}

/** The stage word of a running cell on a machine whose container has not started yet, or has ended. */
export function cellPhaseWord(run: Pick<RunningNow, 'machine' | 'remotePhase'>): string | null {
  if (!run.machine) return null
  switch (run.remotePhase) {
    case 'accepted':
      return tr('admin.competitions.fleet.phase.accepted')
    case 'preparing':
      return tr('admin.competitions.fleet.phase.preparing')
    case 'exporting':
      return tr('admin.competitions.fleet.phase.exporting')
    case 'uploading':
      return tr('admin.competitions.fleet.phase.uploading')
    default:
      return null
  }
}

/** How many cells a machine's group shows before «ещё N на этой машине»: two rows of the grid. */
export const GROUP_CELLS = 6

/** A machine's page: a route under «Ресурсы» (screens/AdminScreen.svelte reads it back). */
export function machinePagePath(id: string): string {
  return `/admin/resources/machines/${encodeURIComponent(id)}`
}

/** The machines block on «Ресурсы», scrolled to — and with its connect dialog open, for `connect`. */
export function machinesListPath(connect = false): string {
  return connect ? '/admin/resources?machines=connect' : '/admin/resources?machines'
}

/* --------------------------------------------------------- «Работают сейчас» */

export interface RemoteRowLine {
  name: string
  chip: string
  text: string
}

export interface RemoteRow {
  lead: string
  detail: string
  lines: RemoteRowLine[]
}

/**
 * A competition whose submissions run on machines, in «Работают сейчас»
 * (M5): how many run there, that this server holds only their metrics, and
 * a line per machine — each «здесь 0 МБ», because the point of the row is
 * that none of it is this server's memory. The metric runs themselves stay
 * rows of their own above (RunningKernels.runs), with their reservation and
 * their stop.
 */
export function remoteRow(remote: RunningRemote): RemoteRow {
  const runs = remote.machines.reduce((sum, machine) => sum + machine.runs, 0)
  const lines: RemoteRowLine[] = []
  if (remote.scoring > 0) {
    lines.push({
      name: tr('admin.resourcesTab.running.remote.metricHere'),
      chip: tr('admin.resourcesTab.running.remote.chipScoring'),
      text: tr('admin.resourcesTab.running.remote.metricLine', { count: remote.scoring }),
    })
  }
  for (const machine of remote.machines) {
    lines.push({
      name: machine.name,
      chip: tr('admin.resourcesTab.running.remote.chipOnMachine'),
      text: [
        tr('admin.resourcesTab.running.remote.machineRuns', { count: machine.runs }),
        machine.devices.length > 0 ? listWords(machine.devices.map(cardWord)) : null,
        tr('admin.resourcesTab.running.remote.zeroHere'),
      ]
        .filter(Boolean)
        .join(' · '),
    })
  }
  return {
    lead: tr('admin.resourcesTab.running.remote.onMachines', { count: runs }),
    detail:
      remote.scoring > 0
        ? tr('admin.resourcesTab.running.remote.scoringHere', { count: remote.scoring })
        : tr('admin.resourcesTab.running.remote.nothingHere'),
    lines,
  }
}

/** What stopping a competition's submissions on machines came to (stopRemoteRuns). */
export interface RemoteStopTally {
  /** Cancelled now: on a machine a durable cancel its next call carries (§3.5). */
  stopped: number
  /**
   * Answered 409: the run ended between the list and the press — or, with
   * the kill's `onMachine`, its notebook did: the result is on its way here
   * or waits for its metric, and is scored, not cancelled.
   */
  ended: number
  /** The first other refusal (a dropped connection, a signed-out panel); `null` — none. */
  error: unknown
}

/**
 * Stop a competition's submissions on machines (M5) through the console's
 * own kill door, one request per submission: there is no door that stops a
 * competition's machine runs at once, and the kill already is the durable
 * cancel for a run a machine holds (competitions/runner.ts · cancelSubmission
 * → cancelRemote). Every request is let finish: one that fails does not keep
 * the others from stopping, and the tally says which were which.
 *
 * The caller's `kill` is the door with `onMachine` (adminApi ·
 * killCompetitionRun): the ids are the list's, seconds old, and a run whose
 * notebook finished since became a metric row here with no machine — the
 * kill without the flag took its `waiting` branch and cancelled a finished
 * result, counted as «снята на машинах».
 */
export async function stopRemoteRuns(ids: readonly string[], kill: (id: string) => Promise<unknown>): Promise<RemoteStopTally> {
  const results = await Promise.allSettled(ids.map((id) => kill(id)))
  const tally: RemoteStopTally = { stopped: 0, ended: 0, error: null }
  for (const result of results) {
    if (result.status === 'fulfilled') tally.stopped += 1
    else if (result.reason instanceof AdminApiError && result.reason.status === 409) tally.ended += 1
    else if (tally.error === null) tally.error = result.reason
  }
  return tally
}

/**
 * The line after that stop: how many were cancelled, how many had already
 * ended — never «all stopped» over runs that were over before the press — and,
 * when some did not answer, that pressing again stops the rest.
 */
export function remoteStopOutcome(name: string | null, tally: RemoteStopTally): Outcome {
  const title = name ?? tr('admin.resourcesTab.running.unnamed')
  const parts: string[] = []
  if (tally.stopped > 0) parts.push(tr('admin.resourcesTab.running.remote.stopped', { name: title, count: tally.stopped }))
  else if (tally.error === null) parts.push(tr('admin.resourcesTab.running.remote.allEnded', { name: title }))
  if (tally.stopped > 0 && tally.ended > 0) parts.push(tr('admin.resourcesTab.running.remote.stoppedEnded', { count: tally.ended }))
  if (tally.error !== null) parts.push(tr('admin.resourcesTab.running.remote.stoppedPartly'))
  return { tone: tally.error === null ? 'positive' : 'warning', text: parts.join(' ') }
}

/* --------------------------------------------------------- the editor (M6) */

/** The «Где считается» row: this server's chip, the machines that take it, and the sentence beside them. */
export interface WhereRow {
  home: string
  /** Only this server runs it: the chip is the warning's «только этот сервер». */
  homeOnly: boolean
  machines: string[]
  text: string
}

/** Whether the environment picked in the form runs only here: the saved verdict, or the registry for an unsaved pick. */
export function whereHomeOnly(where: Pick<RemoteCompetitionWhere, 'homeOnly' | 'registry'>, environment: string, savedEnvironment: string): boolean {
  return environment === savedEnvironment ? where.homeOnly : !where.registry.includes(environment)
}

/**
 * Whether this server runs the competition's notebooks as the form stands:
 * its notebooks are on (RemoteCompetitionWhere.home) and, with the card
 * switched on, it gives submissions a card of its own — `homeCards`, the
 * editor's count of them (CompetitionGpuSettings.devices); `null` while
 * nobody has said, and then the server's word stands.
 *
 * The server's rule (remote/views.ts · blockedBy, the pump's freeShare): a
 * GPU notebook on a server without cards is the machines' alone, whatever
 * «Тетради на этом сервере» says. `where.home` alone does not know it, and
 * on vsos — notebooks on, no card, a machine with cards online — warning 1
 * read «Посылки посчитает сервер: 7 мест» and warning 2 «посчитает только
 * сервер» over a GPU competition on an environment built here, whose every
 * notebook waited for good while uploads were accepted.
 */
export function homeRuns(where: Pick<RemoteCompetitionWhere, 'home'>, ctx: { gpu?: boolean; homeCards?: number | null } = {}): boolean {
  return where.home.notebooks && !(ctx.gpu === true && ctx.homeCards === 0)
}

function unfitWhy(verdict: RemoteReadinessVerdict): string | null {
  switch (verdict) {
    case 'needs_card':
      return tr('admin.competitions.where.why.needs_card')
    case 'needs_trusted':
      return tr('admin.competitions.where.why.needs_trusted')
    case 'outdated':
      return tr('admin.competitions.where.why.outdated')
    case 'problem':
      return tr('admin.competitions.where.why.problem')
    default:
      return null
  }
}

/** A verdict that depends on the competition's image: another environment picked in the form leaves it unknown until Save. */
function imageVerdict(verdict: RemoteReadinessVerdict): boolean {
  return verdict === 'taking' || verdict === 'preparing' || verdict === 'home_only'
}

/**
 * A machine's verdict for the competition as the FORM stands, where the form
 * makes it certain: with the card switched on, a machine without cards
 * cannot take it whatever the saved verdict says (the server's own rule
 * after outdated code, remote/views.ts · readinessFor), and the row read «2
 * машины с картами» over a machine that has none until Save. The other way
 * round is not certain — a GPU image needs a card with the switch off too —
 * so it is left to the saved verdict.
 */
function formVerdict(machine: RemoteWhereMachine, gpu: boolean): RemoteReadinessVerdict {
  if (machine.verdict === 'outdated') return 'outdated'
  return gpu && machine.cards === 0 ? 'needs_card' : machine.verdict
}

/**
 * «Где считается» (M6): this server and the machines that take this
 * competition, and in one sentence the rest — how many machines and places,
 * which is still preparing, which does not fit and why. Only the first
 * machine that does not fit is named: the row is a line, and the owner fixes
 * one machine at a time anyway.
 *
 * The verdicts are the server's for the competition AS SAVED. With another
 * environment named in the form (`unsaved`) whatever depends on the image —
 * taking it, still preparing it, an environment only this server had — is
 * not known until Save, when the machines fetch the new image: those
 * machines read «подготовятся после сохранения». Kept as they were, a switch
 * from an environment built here to one in the registry read «ни одна машина
 * пока не берёт» over a choice that is exactly what lets them. The reasons
 * that do not depend on the image (no card, not trusted, outdated code, a
 * failed preparation) stay.
 *
 * This server's chip says what it does for THIS competition (homeRuns):
 * «только этот сервер» only when it runs these notebooks and the machines
 * cannot; with its notebooks off, or a GPU competition and no card of its
 * own, it only scores them — «сервер · метрика» — even when the environment
 * runs only here, and warning 1 says that then nobody runs them.
 */
export function whereRow(
  where: RemoteCompetitionWhere,
  ctx: { gpu: boolean; draft: boolean; homeOnly: boolean; unsaved?: boolean; homeCards?: number | null },
): WhereRow {
  const home = !homeRuns(where, ctx)
    ? tr('admin.competitions.where.homeMetrics')
    : ctx.homeOnly
      ? tr('admin.competitions.where.homeOnly')
      : tr('admin.competitions.where.home')
  if (ctx.homeOnly) {
    return { home, homeOnly: true, machines: [], text: tr('admin.competitions.where.homeOnlyLine') }
  }
  const unsaved = ctx.unsaved === true
  const machines = where.machines.map((machine) => ({ ...machine, verdict: formVerdict(machine, ctx.gpu) }))
  const taking = unsaved ? [] : machines.filter((machine) => machine.verdict === 'taking')
  const preparing = machines.filter((machine) => (unsaved ? imageVerdict(machine.verdict) : machine.verdict === 'preparing'))
  const unfit = machines.filter((machine) => unfitWhy(machine.verdict) !== null)
  const parts: string[] = []
  if (taking.length > 0) {
    const places = taking.reduce((sum, machine) => sum + machine.places, 0)
    parts.push(
      `${tr(ctx.gpu ? 'admin.competitions.where.machinesCards' : 'admin.competitions.where.machines', { count: taking.length })}, ${tr('admin.competitions.where.places', { count: places })}`,
    )
  } else if (machines.length > 0 && preparing.length === 0) {
    parts.push(tr('admin.competitions.where.noneTaking'))
  }
  if (preparing.length > 0) {
    // A draft is prefetched only once it opens, whatever the form names; a
    // live competition's new environment, once it is saved.
    const key = ctx.draft
      ? 'admin.competitions.where.preparingDraft'
      : unsaved
        ? 'admin.competitions.where.preparingUnsaved'
        : 'admin.competitions.where.preparing'
    parts.push(tr(key, { names: listWords(preparing.map((machine) => machine.name)), count: preparing.length }))
  }
  if (unfit.length > 0) {
    const first = unfit[0]
    parts.push(
      tr('admin.competitions.where.unfit', { name: first.name, why: unfitWhy(first.verdict) as string }) +
        (unfit.length > 1 ? ` ${tr('admin.competitions.where.moreUnfit', { count: unfit.length - 1 })}` : ''),
    )
  }
  return {
    home,
    homeOnly: false,
    machines: [...taking, ...preparing].map((machine) => machine.name),
    text: parts.length > 0 ? parts.join('; ') : tr('admin.competitions.where.noMachines'),
  }
}

/**
 * Warning 1's box: who will run the submissions instead, and which
 * environments machines can take. Nobody, when this server runs no
 * notebooks — or, for a GPU competition, gives submissions no card of its
 * own (homeRuns, the same `gpu` and `homeCards` as the row's): then the way
 * out is an environment from the registry, or a card here.
 */
export function homeOnlyBox(where: RemoteCompetitionWhere, environment: string, ctx: { gpu?: boolean; homeCards?: number | null } = {}): string {
  const list = where.registry.length > 0 ? listWords(where.registry) : null
  if (!where.home.notebooks) {
    return list
      ? tr('admin.competitions.where.homeOnlyNobody', { environment, list })
      : tr('admin.competitions.where.homeOnlyNobodyBare', { environment })
  }
  if (!homeRuns(where, ctx)) {
    return list
      ? tr('admin.competitions.where.homeOnlyNoCard', { environment, list })
      : tr('admin.competitions.where.homeOnlyNoCardBare', { environment })
  }
  return list
    ? tr('admin.competitions.where.homeOnlyHome', { count: where.home.places, list })
    : tr('admin.competitions.where.homeOnlyHomeBare', { count: where.home.places })
}

/**
 * Warning 2: a hidden test goes to trusted machines only (decision 1). With
 * trusted machines that take this competition it is information — which
 * ones, and that this server runs these submissions too when its notebooks
 * are on; with none it is the reason the hidden-test submissions run only
 * here, or, on a server that runs no notebooks, wait.
 *
 * Named are the trusted machines that take this competition (or prepare
 * for it): a trusted machine without the card a GPU competition needs, with
 * outdated code or a failed preparation runs none of these, and listing it
 * as where the hidden test goes sent the owner to the wrong machine when
 * they waited. The same `homeOnly`, `unsaved` and `gpu` as the row's
 * (whereRow): an environment only this server has goes to no machine at all.
 *
 * And only those online (RemoteWhereMachine.state): a trusted machine that
 * went silent, drains or has outdated code takes no hidden-test submission
 * now, and the verdict for the competition alone (its image and data in
 * place) still read «taking» for it. A server that does not say a machine's
 * state is taken at the verdict, as before.
 *
 * This server counts only where it runs the notebooks (homeRuns, the same
 * `homeCards` as the row's): a GPU competition on a server with no card of
 * its own is the machines' alone, and «посчитает только сервер» there was
 * the opposite of what happens — the submissions wait.
 */
export function sealedWarning(
  where: RemoteCompetitionWhere,
  ctx: { homeOnly?: boolean; unsaved?: boolean; gpu?: boolean; homeCards?: number | null } = {},
): { trusted: string[]; text: string; tone: LineTone } {
  const takes = (verdict: RemoteReadinessVerdict): boolean =>
    ctx.unsaved ? imageVerdict(verdict) : verdict === 'taking' || verdict === 'preparing'
  const online = (machine: RemoteWhereMachine): boolean => machine.state === undefined || machine.state === 'online'
  const trusted = ctx.homeOnly
    ? []
    : where.machines
        .filter((machine) => machine.trusted && online(machine) && takes(formVerdict(machine, ctx.gpu === true)))
        .map((machine) => machine.name)
  const home = homeRuns(where, ctx)
  if (trusted.length > 0) {
    return {
      trusted,
      text: tr(home ? 'admin.competitions.where.sealedTrustedHome' : 'admin.competitions.where.sealedTrusted'),
      tone: 'muted',
    }
  }
  if (home) return { trusted, text: tr('admin.competitions.where.sealedHomeOnly'), tone: 'warning' }
  return {
    trusted,
    text: tr(where.home.notebooks ? 'admin.competitions.where.sealedWaitsNoCard' : 'admin.competitions.where.sealedWaits'),
    tone: 'danger',
  }
}

/**
 * Warning 3's box under the GPU row: no card here and none on a machine
 * heard within the hour, so the door refuses GPU uploads (decision 8). It
 * names the last machine with cards and when it was heard, when there was
 * one: that is usually a rented VM that was destroyed, and the owner reads
 * from it whether to rent another or wake the old one.
 */
export function noCardsBox(where: Pick<RemoteCompetitionWhere, 'cards'>, now: number, owner: boolean): string {
  const last = where.cards.last
  const head = tr(owner ? 'admin.competitions.where.noCardsOwner' : 'admin.competitions.where.noCardsTeacher')
  return last ? `${head} ${tr('admin.competitions.where.noCardsLast', { name: last.name, ago: heardAgo(last.at, now) })}` : head
}

/* --------------------------------------------- classes on machines (0.25) */

/**
 * «0:41», «1:02:05»: how long a machine has not answered, as the room's chip
 * counts it (the room's own timer says the same).
 */
export function elapsedWords(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** «14:41:19» today, the class line's moment of a move. */
function secondsTime(at: number, now: number): string {
  return eventTime(at, now)
}

/** «3 класса». */
export function classesCount(count: number): string {
  return tr('admin.runners.classes.count', { count })
}

/**
 * The «занятия» chip of a machine's row and page (Paper 18 · Z1, the
 * designer's tones): calm while it serves or is ready, accent while a class
 * image downloads, amber for what the owner must fix with a command or a
 * wait, red for a perimeter that is not there, and a dashed faint one where
 * classes are impossible (a Colloq server on its Docker). `null` — no chip:
 * the machine was never opened to classes and holds none, or it is gone.
 */
export function classesChip(machine: Pick<RemoteMachine, 'state' | 'classes'>): { word: string; tone: ChipTone; dashed: boolean } | null {
  const classes = machine.classes
  if (!classes || machineGone(machine.state)) return null
  const word = tr('admin.runners.chip.classes')
  switch (classes.block?.reason) {
    case undefined:
    case 'facts':
    case 'winding':
      return { word, tone: 'neutral', dashed: false }
    case 'image':
      return { word, tone: 'accent', dashed: false }
    case 'same-daemon':
      return { word, tone: 'neutral', dashed: true }
    case 'canary':
      return { word, tone: classes.block.detail === null ? 'neutral' : 'danger', dashed: false }
    case 'perimeter':
    case 'quarantined':
      return { word, tone: 'danger', dashed: false }
    default:
      return { word, tone: 'warning', dashed: false }
  }
}

/** A perimeter that is not in place, in the owner's words (RemoteClassFacts.perimeter). */
function perimeterWords(state: string | null): string {
  switch (state) {
    case 'no-iptables':
      return tr('admin.runners.classes.perimeter.noIptables')
    case 'no-dockerd':
      return tr('admin.runners.classes.perimeter.noDockerd')
    case 'failing':
      return tr('admin.runners.classes.perimeter.failing')
    default:
      return tr('admin.runners.classes.perimeter.refused')
  }
}

/**
 * The line «Занятия: …» under a machine's row (Paper 18 · Z1): what it holds
 * for classes and how it answers — «3 класса · 30 из 60 ГБ · карта 0 занята
 * классом · связь 48 мс (p95 80)» — or the one thing that keeps new classes
 * away, worded for the owner who fixes it. `null` — no class line.
 */
export function classLine(machine: Pick<RemoteMachine, 'state' | 'classes' | 'facts' | 'lastSeenAt' | 'silentSince'>, now: number): Line | null {
  const classes = machine.classes
  if (!classes || machineGone(machine.state)) return null
  const block = classes.block
  const held = classes.held
  switch (block?.reason) {
    case 'quarantined':
      return { text: tr('admin.runners.classes.quarantined', { time: clockTime(classes.quarantinedAt ?? now, now) }), tone: 'danger' }
    case 'silent':
      if (held.classes === 0) return { text: tr('admin.runners.classes.silentIdle'), tone: 'warning' }
      return classOutage(machine, classes, now)
    case 'winding':
      return { text: tr('admin.runners.classes.winding'), tone: 'muted' }
    case 'outdated':
      return { text: tr('admin.runners.classes.outdated'), tone: 'warning' }
    case 'facts':
      return { text: tr('admin.runners.classes.facts'), tone: 'muted' }
    case 'same-daemon':
      return { text: tr('admin.runners.classes.sameDaemon'), tone: 'muted' }
    case 'host-network':
      return { text: tr('admin.runners.classes.hostNetwork'), tone: 'warning' }
    case 'perimeter':
      return { text: perimeterWords(block.detail), tone: 'danger' }
    case 'canary':
      // No detail: the check has not run yet, and waits for a class image on the machine.
      return block.detail === null
        ? { text: tr('admin.runners.classes.canaryPending'), tone: 'muted' }
        : { text: tr('admin.runners.classes.canary', { detail: brief(block.detail, 100) }), tone: 'danger' }
    case 'tunnel':
      // Classes on it wait for their tunnel, or are about to move: said as the silence is, with when.
      return held.classes > 0 ? classOutage(machine, classes, now) : { text: tr('admin.runners.classes.tunnel'), tone: 'warning' }
    case 'image': {
      const percent = formatNumber(Math.round(block.percent ?? 0))
      return block.environment
        ? { text: tr('admin.runners.classes.image', { percent, env: block.environment }), tone: 'accent' }
        : { text: tr('admin.runners.classes.imageBare', { percent }), tone: 'accent' }
    }
    case 'gone':
      return null
  }
  const used = formatNumber(held.memoryMb / 1024, { maximumFractionDigits: held.memoryMb >= 10 * 1024 ? 0 : 1 })
  const total = machine.facts.memoryMb
  const parts = [
    held.classes > 0 ? classesCount(held.classes) : tr('admin.runners.classes.ready'),
    held.classes > 0
      ? total !== null
        ? tr('admin.runners.classes.memory', { used, total: formatNumber(Math.round(total / 1024)) })
        : tr('admin.runners.classes.memoryHeld', { used })
      : null,
    held.card !== null ? tr('admin.runners.classes.card', { card: cardWord(held.card) }) : null,
    linkWords(classes.link),
  ]
  return { text: parts.filter(Boolean).join(' · '), tone: 'ink' }
}

/**
 * A machine whose classes do not hear it (Z1): «2 класса · нет связи 0:41 ·
 * перенесём на сервер в 14:41:19», or without the time while no class moves
 * by itself (they wait for the machine, or the outage is too young to tell).
 * Counted from its tunnel's last frame, as the room's chip counts it: the
 * classes move after their own seconds, long before 0.23's silence.
 */
function classOutage(machine: Pick<RemoteMachine, 'silentSince' | 'lastSeenAt'>, classes: RemoteMachineClasses, now: number): Line {
  const quiet = classes.link && !classes.link.up && classes.link.since !== null ? classes.link.since : (machine.silentSince ?? machine.lastSeenAt)
  const elapsed = elapsedWords(quiet === null ? 0 : now - quiet)
  const count = classesCount(classes.held.classes)
  return classes.moveAt !== null
    ? { text: tr('admin.runners.classes.silent', { classes: count, elapsed, time: secondsTime(classes.moveAt, now) }), tone: 'warning' }
    : { text: tr('admin.runners.classes.silentWait', { classes: count, elapsed }), tone: 'warning' }
}

/** «связь 48 мс (p95 80)», or nothing before the first round trip. */
function linkWords(link: RemoteMachineClasses['link']): string | null {
  if (!link || link.rttMs === null) return null
  const ms = formatNumber(Math.round(link.rttMs))
  return link.p95Ms === null
    ? tr('admin.runners.classes.linkOnly', { ms })
    : tr('admin.runners.classes.link', { ms, p95: formatNumber(Math.round(link.p95Ms)) })
}

/** One of the owner's class banners, in its sentence (§13.2). */
export function classBannerText(banner: RemoteClassBanner): string {
  switch (banner.kind) {
    case 'quarantined':
      return tr('admin.runners.classBanner.quarantined', { name: banner.name })
    case 'tunnel':
      return tr('admin.runners.classBanner.tunnel', {
        name: banner.name,
        minutes: banner.minutes,
        count: banner.count,
        addresses: banner.addresses.join(', ') || '—',
      })
    case 'perimeter':
      return tr('admin.runners.classBanner.perimeter', { name: banner.name })
  }
}

/** The class gauge above the list: «3 ведут занятия · 6 классов»; `null` while no machine takes classes. */
export function classesGauge(summary: RemoteMachinesResponse['classMachines']): SummaryGauge | null {
  if (!summary || summary.machines === 0) return null
  return { value: summary.machines, label: tr('admin.runners.summary.classes', { classes: classesCount(summary.classes) }) }
}

/* ------------------------------------------------ the machine's page (Z3) */

/** «↑ 3 файла, 12 МБ», «2 файла только на машине», «синхронно»: a copy's lag (§8.7), and its tone. */
export function filesLag(lag: { pending: number; pendingBytes: number; heldOnly: number; heldOnlyBytes: number } | null): Line | null {
  if (!lag) return null
  if (lag.pending > 0) {
    return {
      text: tr('admin.runners.files.pending', { files: tr('admin.runners.files.count', { count: lag.pending }), size: sizeWords(lag.pendingBytes) ?? '—' }),
      tone: 'accent',
    }
  }
  if (lag.heldOnly > 0) return { text: tr('admin.runners.files.heldOnly', { files: tr('admin.runners.files.count', { count: lag.heldOnly }) }), tone: 'warning' }
  return { text: tr('admin.runners.files.synced'), tone: 'positive' }
}

/** A role of a class's slot: «класс», «личные», «консилиум». */
export function roleWord(role: RemoteMachineClassRow['roles'][number]): string {
  switch (role) {
    case 'room':
      return tr('admin.runners.role.room')
    case 'own':
      return tr('admin.runners.role.own')
    case 'council':
      return tr('admin.runners.role.council')
  }
}

/** A row of «Занятия на машине» (Z3): its kernels, memory, CPU and files, in words. */
export interface ClassRowCells {
  kernels: string
  kernelsDetail: string | null
  memory: string
  /** Use against the limit, 0…1; null — unknown. */
  share: number | null
  cpu: string | null
  files: Line | null
}

export function classRowCells(row: RemoteMachineClassRow): ClassRowCells {
  const gb = (mb: number) => formatNumber(mb / 1024, { maximumFractionDigits: 1 })
  const details = [
    row.workers !== null ? tr('admin.runners.page.workers', { count: row.workers }) : null,
    row.card !== null ? tr('admin.runners.page.cardWithClass', { card: cardWord(row.card) }) : null,
    row.waiting ? tr('admin.runners.page.waiting') : null,
  ].filter(Boolean)
  return {
    kernels: row.roles.map(roleWord).join(' · '),
    kernelsDetail: details.length > 0 ? details.join(' · ') : null,
    memory:
      row.memory.usedMb === null
        ? tr('admin.runners.page.memoryLimit', { limit: gb(row.memory.limitMb) })
        : tr('admin.runners.page.memoryOf', { used: gb(row.memory.usedMb), limit: gb(row.memory.limitMb) }),
    share: row.memory.usedMb === null || row.memory.limitMb <= 0 ? null : Math.min(1, row.memory.usedMb / row.memory.limitMb),
    cpu: row.cpuPercent === null ? null : tr('admin.runners.page.cpuPercent', { value: formatNumber(Math.round(row.cpuPercent)) }),
    files: filesLag(row.files),
  }
}

/* --------------------------------------------- «Где считается» (Z4 form) */

/** The three parts of the form, in the order it draws them. */
export const PLACEMENT_PARTS = ['room', 'own', 'council'] as const

/**
 * Whether a class can compute on machines on this server at all, by its
 * class settings: never under the broker, which keeps a class's Pods (D26),
 * and not on a server from before classes (no settings). The class forms
 * draw «Где считается» only then.
 */
export function classesOnMachines(settings: Pick<ClassMachineSettingsResponse, 'backend'> | null): boolean {
  return settings !== null && settings.backend !== 'broker'
}

/**
 * The tile a setting matches (shared/admin.ts · classPlacementPreset), the
 * GPU tile for a GPU class's «всё на машинах»; `null` — a mix of its own,
 * and no tile is lit.
 */
export function presetOf(placement: Pick<ClassPlacement, 'room' | 'own' | 'council'>, gpu: boolean): ClassPlacementPreset | null {
  for (const name of ['home', 'personal', 'machines', 'gpu'] as const) {
    if (name === (gpu ? 'machines' : 'gpu')) continue
    const preset = CLASS_PLACEMENT_PRESETS[name]
    if (preset.room === placement.room && preset.own === placement.own && preset.council === placement.council) return name
  }
  return null
}

/** The tiles the form offers: the GPU one for a GPU class instead of «Всё на машинах». */
export function presetsFor(gpu: boolean): ClassPlacementPreset[] {
  return gpu ? ['home', 'personal', 'gpu'] : ['home', 'personal', 'machines']
}

/** A tile's name and its small line. */
export function presetWords(preset: ClassPlacementPreset): { name: string; note: string } {
  switch (preset) {
    case 'home':
      return { name: tr('admin.classes.preset.home'), note: tr('admin.classes.preset.homeNote') }
    case 'personal':
      return { name: tr('admin.classes.preset.personal'), note: tr('admin.classes.preset.personalNote') }
    case 'machines':
      return { name: tr('admin.classes.preset.machines'), note: tr('admin.classes.preset.machinesNote') }
    case 'gpu':
      return { name: tr('admin.classes.preset.gpu'), note: tr('admin.classes.preset.gpuNote') }
  }
}

/** Why a machine does not fit the class now, in two or three words (placement.ts · MachineRefusal, and `outdated`). */
export function refusalWord(refusal: string): string {
  switch (refusal) {
    case 'memory':
      return tr('admin.placement.why.memory')
    case 'cpus':
      return tr('admin.placement.why.cpus')
    case 'card':
      return tr('admin.placement.why.card')
    case 'image':
      return tr('admin.placement.why.image')
    case 'full':
      return tr('admin.placement.why.full')
    case 'not-live':
      return tr('admin.placement.why.notLive')
    case 'outdated':
      return tr('admin.placement.why.outdated')
    case 'classes-off':
      return tr('admin.placement.why.classesOff')
    case 'quarantined':
      return tr('admin.placement.why.quarantined')
    case 'sealed':
      return tr('admin.placement.why.sealed')
    case 'tunnel':
      return tr('admin.placement.why.tunnel')
    case 'facts':
      return tr('admin.placement.why.facts')
    case 'host-network':
      return tr('admin.placement.why.hostNetwork')
    case 'perimeter':
      return tr('admin.placement.why.perimeter')
    case 'canary':
      return tr('admin.placement.why.canary')
    case 'same-daemon':
      return tr('admin.placement.why.sameDaemon')
    case 'avoided':
      return tr('admin.placement.why.avoided')
    default:
      return tr('admin.placement.why.other')
  }
}

/**
 * The live line under the form (Z4): «Подходят: vast-3 (свободно 22 ГБ ·
 * 1 карта), lab-2 (18 ГБ)», with «· далеко: +190 мс на ячейку» when the
 * nearest fitting machine is far (p95 over 150 ms), or — when machines take
 * classes and none fits now — each one's reason. `null` — the class itself
 * is refused (the refusal box takes the line's place), or no machine at all.
 */
export function outlookLine(outlook: ClassPlacementOutlook): { text: string; far: string | null; tone: 'positive' | 'warning' } | null {
  if (outlook.refusal !== null || outlook.machines.length === 0) return null
  const gb = (mb: number) => formatNumber(Math.round(mb / 1024))
  const fitting = outlook.machines.filter((machine) => machine.refusal === null)
  if (fitting.length === 0) {
    const list = outlook.machines
      .slice(0, 4)
      .map((machine) => tr('admin.placement.notFitItem', { name: machine.name, why: refusalWord(machine.refusal ?? '') }))
      .join(', ')
    return { text: tr('admin.placement.notFit', { list }), far: null, tone: 'warning' }
  }
  const items = fitting.slice(0, 4).map((machine, index) => {
    if (machine.freeMb === null) return tr('admin.placement.fitBare', { name: machine.name })
    const cards = machine.cards > 0 ? tr('admin.placement.cards', { count: machine.cards }) : null
    const free = gb(machine.freeMb)
    if (index === 0) return cards ? tr('admin.placement.fitFirstCards', { name: machine.name, free, cards }) : tr('admin.placement.fitFirst', { name: machine.name, free })
    return cards ? tr('admin.placement.fitOtherCards', { name: machine.name, free, cards }) : tr('admin.placement.fitOther', { name: machine.name, free })
  })
  const list = items.join(', ')
  // «Далеко» is about the machine a slot would land on first: the nearest that fits, as the chooser prefers short links (§6.3).
  const nearest = [...fitting].sort((a, b) => (a.rttP95Ms ?? Infinity) - (b.rttP95Ms ?? Infinity))[0]
  const far = nearest.far && nearest.rttP95Ms !== null ? tr('admin.placement.far', { ms: formatNumber(Math.round(nearest.rttP95Ms)) }) : null
  return { text: tr(fitting.length === 1 ? 'admin.placement.fitsOne' : 'admin.placement.fits', { list }), far, tone: 'positive' }
}

/**
 * The refusal that takes the live line's place and greys «На машинах»
 * (Z4, the M6 warning pattern): the environment was built here, no machine
 * takes classes, this server's blocked ranges cannot go to one — and, read
 * on this side, a GPU class on a server without cards whose class notebooks
 * stay here. `null` — none.
 */
export type PlacementRefusal = 'not-portable' | 'no-machines' | 'blocked-ranges' | 'gpu'

export function placementRefusal(
  outlook: Pick<ClassPlacementOutlook, 'refusal'> | null,
  ctx: { gpu: boolean; homeCards: number; room: ClassPlacement['room'] },
): PlacementRefusal | null {
  if (outlook?.refusal) return outlook.refusal
  if (ctx.gpu && ctx.homeCards === 0 && ctx.room === 'home') return 'gpu'
  return null
}

/** Whether a refusal greys «На машинах» on every part (the class can run nowhere but here). */
export function refusalLocks(refusal: PlacementRefusal | null): boolean {
  return refusal === 'not-portable' || refusal === 'no-machines' || refusal === 'blocked-ranges'
}
