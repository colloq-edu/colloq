/**
 * The words and numbers of «Работают сейчас» (the Resources tab), taken out of
 * the component.
 *
 * No Svelte and no browser, as in `admin/panel.ts`: this is what the owner
 * reads at the moment a class cannot start a kernel and somebody has to
 * decide which room to stop. "Empty for 1 h 10 min, stops by itself in 50
 * min" and "frees 8 GB" are the whole decision, and a slip in them (a
 * countdown that says "never" for a room the sweep is about to take, a total
 * that counts a reservation as real use) shows only on a full machine, when
 * it is too late to fix.
 *
 * What is not here: whether a class is idle, busy or stoppable. The server
 * decides that (routes/admin-running.ts) and re-checks it at the moment of
 * stopping; the panel only words what it was told.
 */
import { tr, formatNumber } from '@shared/i18n'
import type {
  RunningBook,
  RunningBusy,
  RunningBusyKind,
  RunningClass,
  RunningContainer,
  RunningKernels,
  StopIdleKernelsResponse,
} from '@shared/admin'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Milliseconds from an ISO string to `now`; `null` for a missing or unreadable time. */
export function since(iso: string | null, now: number): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  return Number.isFinite(at) ? Math.max(0, now - at) : null
}

/** Milliseconds from `now` until an ISO time; negative once it has passed. */
export function until(iso: string | null, now: number): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at - now : null
}

/* ------------------------------------------------------------- numbers */

/**
 * Megabytes as the gigabytes the panel prints everywhere else ("0,1", "4",
 * "12,5"): one decimal at most, in the instance's locale. A container that
 * holds 30 MB reads "0", which is the truth at this scale; the reservation
 * beside it is what the decision is about.
 */
export function gb(mb: number): string {
  return formatNumber(mb / 1024, { maximumFractionDigits: 1 })
}

/** "4 ГБ", with the non-breaking space the copy keeps between a number and its unit. */
export function gbText(mb: number): string {
  return tr('admin.resourcesTab.running.gb', { value: gb(mb) })
}

/**
 * A stretch of time in the room's words: "40 мин", "1 ч 10 мин", "3 ч".
 *
 * Elapsed time rounds down and a countdown rounds up (`up`), so the two
 * lines of an idle row always add up to the room setting: "пусто 1 ч 10 мин"
 * beside "сам остановится через 50 мин", never "через 49" for a two-hour
 * limit.
 */
export function duration(ms: number, up = false): string {
  const minutes = up ? Math.ceil(ms / MINUTE) : Math.floor(ms / MINUTE)
  if (minutes < 1) return tr('admin.resourcesTab.running.underMinute')
  if (minutes < 60) return tr('admin.resourcesTab.running.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? tr('admin.resourcesTab.running.hours', { count: hours })
    : tr('admin.resourcesTab.running.hoursMinutes', { hours, minutes: rest })
}

/** A ticking clock: "3:12", "1:04:09". The run lane and the busy dialog count seconds. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/* ---------------------------------------------------------- the header */

export interface Totals {
  /** Containers holding memory: rooms, personal-notebook containers, runs and preparations. */
  containers: number
  /** Everything those containers reserve, runs and preparations included. */
  reservedMb: number
  /**
   * What the class containers really use, MEASURED only; `null` when the
   * runtime could not tell. A run's reservation is never counted here: a
   * header that added it would say "really in use" about a ceiling.
   */
  usedMb: number | null
}

export function totals(data: RunningKernels): Totals {
  let containers = 0
  for (const row of data.classes) containers += (row.room ? 1 : 0) + (row.own ? 1 : 0)
  containers += data.runs.length + data.preparations.length
  const reservedMb =
    data.reservedMb +
    data.runs.reduce((sum, run) => sum + run.reservedMb, 0) +
    data.preparations.reduce((sum, prep) => sum + prep.reservedMb, 0)
  const usedMb = data.usage === 'live' ? data.usedMb : null
  return { containers, reservedMb, usedMb }
}

/** What stopping this class (or only its personal notebooks) gives back. */
export function freedMb(row: RunningClass, what: 'class' | 'own'): number {
  const own = row.own?.reservedMb ?? 0
  return what === 'own' ? own : (row.room?.reservedMb ?? 0) + own
}

/** The classes «Остановить простаивающие» would take: idle by the server's word, and stoppable by this viewer. */
export function idleClasses(data: RunningKernels): RunningClass[] {
  return data.classes.filter((row) => row.idle && row.canStop && row.id !== null)
}

/**
 * The section's one line when nothing is listed.
 *
 * "No kernel is running" only from a census that answered in full. When
 * `docker ps` timed out or the broker did not answer, the list holds only the
 * classes this process has live kernels for: the containers it does not
 * track (a previous run's, after a restart; a room holding only its shell)
 * are missing, and on a full machine they are exactly what holds the memory.
 */
export function emptyLine(data: Pick<RunningKernels, 'complete'>): { tone: 'muted' | 'warning'; text: string } {
  return data.complete
    ? { tone: 'muted', text: tr('admin.resourcesTab.running.empty') }
    : { tone: 'warning', text: tr('admin.resourcesTab.running.incomplete') }
}

/* ------------------------------------------------------------ the rows */

/** A container's memory lane: real use against its reservation, or the reservation alone. */
export interface MemoryLane {
  /** "0,1 из 4 ГБ", "4 ГБ", or `null` when nothing is known. */
  text: string | null
  /** Used share of the limit, 0…1; `null` when use is unknown (no bar is drawn). */
  share: number | null
  /** Above 85 % of the limit: the bar turns amber, the kernel is close to being killed. */
  tight: boolean
  /** Only the reservation is known. */
  reserveOnly: boolean
}

export function memoryLane(container: RunningContainer | null): MemoryLane {
  const reserved = container?.reservedMb ?? null
  const used = container?.usedMb ?? null
  if (reserved === null) {
    return used === null
      ? { text: null, share: null, tight: false, reserveOnly: false }
      : { text: gbText(used), share: null, tight: false, reserveOnly: false }
  }
  if (used === null) return { text: gbText(reserved), share: null, tight: false, reserveOnly: true }
  const share = reserved > 0 ? Math.min(1, used / reserved) : 0
  return {
    text: tr('admin.resourcesTab.running.ofGb', { used: gb(used), reserved: gb(reserved) }),
    share,
    tight: share > 0.85,
    reserveOnly: false,
  }
}

/** "2 ядра · 140 %": the cores a container may use, and how busy they are if docker said. */
export function coresLane(container: RunningContainer | null): string | null {
  if (!container || container.cpus === null) return null
  const cores = tr('admin.resourcesTab.running.cores', {
    count: container.cpus,
    value: formatNumber(container.cpus, { maximumFractionDigits: 2 }),
  })
  if (container.cpuPercent === null) return cores
  const percent = tr('admin.resourcesTab.running.cpu', {
    value: formatNumber(container.cpuPercent, { maximumFractionDigits: 0 }),
  })
  return `${cores} · ${percent}`
}

export type Tone = 'accent' | 'warning' | 'ink' | 'muted'

/** The «Сейчас» lane: what the class is doing, in two lines. */
export interface StatusLines {
  first: string
  tone: Tone
  second: string | null
}

const BUSY_KINDS: ReadonlySet<string> = new Set<RunningBusyKind>([
  'cell',
  'queue',
  'attempt',
  'terminal',
  'starting',
  'restarting',
])

function busyWord(kind: RunningBusyKind): string {
  // A switch rather than a key built from `kind`: every key stays literal,
  // so the catalog check (tests/admin-language.test.mts) finds each one.
  switch (kind) {
    case 'cell':
      return tr('admin.resourcesTab.running.busy.cell')
    case 'queue':
      return tr('admin.resourcesTab.running.busy.queue')
    case 'attempt':
      return tr('admin.resourcesTab.running.busy.attempt')
    case 'terminal':
      return tr('admin.resourcesTab.running.busy.terminal')
    case 'starting':
      return tr('admin.resourcesTab.running.busy.starting')
    case 'restarting':
      return tr('admin.resourcesTab.running.busy.restarting')
  }
}

/** "в комнате 18 человек". */
export function peopleIn(online: number): string {
  return tr('admin.resourcesTab.running.people', {
    people: tr('admin.count.people', { count: online }),
  })
}

/**
 * The status of a class row, decided in the order the owner asks the
 * questions: is anything computing (do not stop it under someone's cell), is
 * anyone inside, and if it is empty, how long until it lets go by itself.
 *
 * A hidden row (another course's class) keeps its numbers but not its story:
 * one muted word, never whose cell or which notebook.
 */
export function statusLines(row: RunningClass, now: number): StatusLines {
  if (row.hidden) {
    const word = row.busy
      ? busyWord(row.busy.kind)
      : row.online > 0
        ? tr('admin.resourcesTab.running.hiddenOn')
        : tr('admin.resourcesTab.running.hiddenIdle')
    return { first: word, tone: 'muted', second: null }
  }
  if (row.busy) {
    const detail = [row.busy.who, row.busy.book].filter(Boolean).join(', ')
    const first = detail ? `${busyWord(row.busy.kind)} · ${detail}` : busyWord(row.busy.kind)
    const elapsed = since(row.busy.since, now)
    const parts = [
      elapsed === null ? null : tr('admin.resourcesTab.running.busyFor', { time: duration(elapsed) }),
      row.online > 0 ? peopleIn(row.online) : null,
    ].filter((part): part is string => part !== null)
    return { first, tone: 'accent', second: parts.length > 0 ? parts.join(' · ') : null }
  }
  if (row.online > 0) {
    const live = since(row.liveSince, now)
    return {
      first: peopleIn(row.online),
      tone: 'ink',
      second: live === null ? null : tr('admin.resourcesTab.running.runningFor', { time: duration(live) }),
    }
  }
  if (!row.idle) {
    // Nobody in, nothing computing, and still not idle: the server holds it
    // out of the idle list only while a stop or a deletion is under way.
    return { first: tr('admin.resourcesTab.running.stopping'), tone: 'muted', second: null }
  }
  const empty = since(row.idleSince, now)
  const first =
    empty === null
      ? tr('admin.resourcesTab.running.idleNow')
      : tr('admin.resourcesTab.running.idleFor', { time: duration(empty) })
  return { first, tone: 'warning', second: countdown(row, now) }
}

/**
 * The second line of an idle row. `stopsAt` null on an idle row means the
 * setting says never (roomIdleMin = 0) — the server sends null for "busy"
 * and "occupied" too, but those rows never get here. A time already passed is
 * the sweep's next pass, not "never": it will take the room on its next look.
 */
export function countdown(row: RunningClass, now: number): string {
  const left = until(row.stopsAt, now)
  if (left === null) return tr('admin.resourcesTab.running.neverStops')
  if (left < MINUTE) return tr('admin.resourcesTab.running.stopsSoon')
  return tr('admin.resourcesTab.running.stopsIn', { time: duration(left, true) })
}

/* ----------------------------------------------------------- notebooks */

export type BookTone = 'accent' | 'neutral' | 'warning'

/** A notebook's state chip in the expanded list. */
export function bookChip(book: RunningBook): { word: string; tone: BookTone } {
  switch (book.phase) {
    case 'busy':
      return { word: tr('admin.resourcesTab.running.phase.busy'), tone: 'accent' }
    case 'idle':
      return { word: tr('admin.resourcesTab.running.phase.idle'), tone: 'neutral' }
    case 'starting':
      return { word: tr('admin.resourcesTab.running.phase.starting'), tone: 'neutral' }
    case 'restarting':
      return { word: tr('admin.resourcesTab.running.phase.restarting'), tone: 'neutral' }
    case 'dead':
      return { word: tr('admin.resourcesTab.running.phase.dead'), tone: 'warning' }
    case 'off':
      return { word: tr('admin.resourcesTab.running.phase.off'), tone: 'neutral' }
  }
}

/* ------------------------------------------------------------- dialogs */

/**
 * A class name inside «…» in a dialog title or a result line, shortened at a
 * word boundary: «Оптимизация функций…», not a title that wraps into three
 * lines around a question mark.
 */
export function shortName(name: string | null, max = 28): string {
  const text = (name ?? '').trim() || tr('admin.resourcesTab.running.unnamed')
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.:;—-]+$/, '')}…`
}

/** The body of the K2-А confirmation, from the row's real numbers. */
export function stopBody(row: RunningClass, what: 'class' | 'own', now: number): string {
  const parts: string[] = []
  if (row.online > 0) {
    parts.push(tr('admin.resourcesTab.running.stop.people', { people: tr('admin.count.people', { count: row.online }) }))
  } else {
    const empty = since(row.idleSince, now)
    parts.push(
      empty === null
        ? tr('admin.resourcesTab.running.stop.nobody')
        : tr('admin.resourcesTab.running.stop.idleFor', { time: duration(empty) }),
    )
  }
  const books = row.books.filter((book) => what === 'class' || book.role === 'own').length
  parts.push(
    books > 0
      ? tr('admin.resourcesTab.running.stop.books', { count: books })
      : tr('admin.resourcesTab.running.stop.noBooks'),
  )
  if (what === 'class') parts.push(tr('admin.resourcesTab.running.stop.terminal'))
  const freed = freedMb(row, what)
  if (freed > 0) parts.push(tr('admin.resourcesTab.running.stop.frees', { memory: gb(freed) }))
  parts.push(
    what === 'class' ? tr('admin.resourcesTab.running.stop.back') : tr('admin.resourcesTab.running.stop.backOwn'),
  )
  return parts.join(' ')
}

/** The first sentence of the K2-Б dialog: what exactly would be cut short. */
export function busyBody(busy: RunningBusy): string {
  switch (busy.kind) {
    case 'cell':
      return tr('admin.resourcesTab.running.busy.body.cell')
    case 'queue':
      return tr('admin.resourcesTab.running.busy.body.queue')
    case 'attempt':
      return tr('admin.resourcesTab.running.busy.body.attempt')
    case 'terminal':
      return tr('admin.resourcesTab.running.busy.body.terminal')
    case 'restarting':
      return tr('admin.resourcesTab.running.busy.body.restarting')
    case 'starting':
      return tr('admin.resourcesTab.running.busy.body.starting')
  }
}

/** The caps word on the K2-Б live row. */
export function busyChip(kind: RunningBusyKind): string {
  if (kind === 'terminal') return tr('admin.resourcesTab.running.busy.chip.terminal')
  if (kind === 'restarting') return tr('admin.resourcesTab.running.busy.chip.restarting')
  if (kind === 'starting') return tr('admin.resourcesTab.running.busy.chip.starting')
  return tr('admin.resourcesTab.running.busy.chip.compute')
}

/** A 409 `busy` body, read defensively: it came over the network. */
export function busyOf(body: unknown): RunningBusy | null {
  const busy = (body as { reason?: unknown; busy?: unknown } | null)?.busy
  if ((body as { reason?: unknown } | null)?.reason !== 'busy' || !busy || typeof busy !== 'object') return null
  const kind = (busy as { kind?: unknown }).kind
  if (typeof kind !== 'string' || !BUSY_KINDS.has(kind)) return null
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
  return {
    kind: kind as RunningBusyKind,
    who: text((busy as { who?: unknown }).who),
    book: text((busy as { book?: unknown }).book),
    since: text((busy as { since?: unknown }).since),
  }
}

/* ------------------------------------------------------------- results */

export interface Outcome {
  tone: 'positive' | 'warning'
  text: string
}

/** The line under the header after one stop (K2-Г). */
export function stopOutcome(name: string | null, what: 'class' | 'own', freed: number): Outcome {
  const params = { name: shortName(name), memory: gb(freed) }
  return {
    tone: 'positive',
    text:
      what === 'class'
        ? tr('admin.resourcesTab.running.result.stopped', params)
        : tr('admin.resourcesTab.running.result.stoppedOwn', params),
  }
}

function skippedLine(reason: StopIdleKernelsResponse['skipped'][number]['reason'], name: string): string {
  switch (reason) {
    case 'busy':
      return tr('admin.resourcesTab.running.skipped.busy', { name })
    case 'online':
      return tr('admin.resourcesTab.running.skipped.online', { name })
    case 'stopping':
      return tr('admin.resourcesTab.running.skipped.stopping', { name })
    case 'gone':
      return tr('admin.resourcesTab.running.skipped.gone', { name })
    case 'failed':
      return tr('admin.resourcesTab.running.skipped.failed', { name })
  }
}

/**
 * The line after «Остановить простаивающие». Each class was re-checked at the
 * moment of stopping, so a room somebody walked into in the meantime is
 * skipped — and the line says which one and why, because "stopped 1 of 2"
 * alone sends the owner looking for a failure that did not happen.
 */
export function bulkOutcome(result: StopIdleKernelsResponse, names: ReadonlyMap<string, string | null>): Outcome {
  const done = result.stopped.length
  const total = done + result.skipped.length
  if (result.skipped.length === 0) {
    return {
      tone: 'positive',
      text: tr('admin.resourcesTab.running.result.bulk', { count: done, memory: gb(result.freedMb) }),
    }
  }
  const head =
    done === 0
      ? tr('admin.resourcesTab.running.result.none')
      : tr('admin.resourcesTab.running.result.partial', { done, total, memory: gb(result.freedMb) })
  const why = result.skipped.map((skip) => skippedLine(skip.reason, shortName(names.get(skip.id) ?? null)))
  return { tone: 'warning', text: [head, ...why].join(' ') }
}
