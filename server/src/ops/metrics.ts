/**
 * GET /metrics: the instance in Prometheus text format.
 *
 * For a platform team's Prometheus (a ServiceMonitor in the Helm chart), not
 * for a person: staff keep the Resources tab and /api/instance/operations.
 * The numbers here answer one question, "is the class OK right now", in a
 * shape an alert can be written on: memory, CPU and event loop of the one
 * process every room shares; rooms, people and sockets; kernels by container;
 * the run queue; the Oracle; the competition queue; notebook saves; the
 * disks; HTTP answers by class and 429s by the limit that refused; the
 * database snapshots.
 *
 * Off unless METRICS_TOKEN is set, and then only for a request carrying it as
 * a Bearer credential. The numbers name no room and no person, but they do
 * tell anyone who can reach the port how busy the instance is and whether
 * its backups run, and behind an Ingress the port is the internet. Unset, the
 * address answers 404 like any other unknown one: a probe that finds it has
 * learned nothing, and the operator who forgot the token gets a plain "not
 * found" to search for rather than a login page.
 *
 * Written by hand, with no client library: the text format is a line per
 * number, and a dependency for it would be the largest thing in this file.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type { NextFunction, Request, Response } from 'express'
import { tr } from '@shared/i18n'
import { SUBMISSION_STATES } from '@shared/competitions'
import { config } from '../config.js'
import { db } from '../db.js'
import { databaseSnapshotStatus } from '../db-snapshots.js'
import { roomCensus } from '../collab/index.js'
import { persistenceDiagnostics } from '../collab/persistence.js'
import { competitionExecutionDiagnostics } from '../competitions/runner.js'
import { kernelMetrics } from '../kernel/index.js'
import { kernelBackend } from '../kernel/runtime-client.js'
import { seldom, tallyTotals } from '../log.js'
import { COLLOQ_VERSION } from '../version.js'
import {
  counterValues,
  countHttpResponse,
  countRateLimited,
  KERNEL_ROLES,
  REFUSAL_REASONS,
  refusalOf,
  STATUS_CLASSES,
  type RefusalReason,
} from './counters.js'
import { filesystemSpace } from './disk.js'
import { queueCensus } from './status.js'

/* ------------------------------------------------------------- exposition */

export type MetricType = 'counter' | 'gauge'

export interface Sample {
  labels?: Record<string, string>
  value: number
}

export interface MetricFamily {
  name: string
  type: MetricType
  help: string
  samples: Sample[]
}

/**
 * The text format, version 0.0.4: per family its HELP and TYPE, then one line
 * per sample. A family with no samples is left out entirely (open file
 * descriptors on a machine without /proc, the event loop before its first
 * measurement): a HELP with nothing under it reads like a number that is zero.
 */
export function exposition(families: readonly MetricFamily[]): string {
  const lines: string[] = []
  for (const family of families) {
    if (family.samples.length === 0) continue
    lines.push(`# HELP ${family.name} ${family.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`)
    lines.push(`# TYPE ${family.name} ${family.type}`)
    for (const sample of family.samples) {
      lines.push(`${family.name}${labelText(sample.labels)} ${numberText(sample.value)}`)
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function labelText(labels: Record<string, string> | undefined): string {
  const pairs = Object.entries(labels ?? {})
  if (pairs.length === 0) return ''
  const escaped = pairs.map(
    ([name, value]) => `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  )
  return `{${escaped.join(',')}}`
}

function numberText(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return '+Inf'
  if (value === -Infinity) return '-Inf'
  return String(value)
}

const gauge = (name: string, help: string, samples: Sample[]): MetricFamily => ({ name, type: 'gauge', help, samples })
const counter = (name: string, help: string, samples: Sample[]): MetricFamily => ({ name, type: 'counter', help, samples })
const single = (value: number | null | undefined): Sample[] =>
  value === null || value === undefined || !Number.isFinite(value) ? [] : [{ value }]

/* ------------------------------------------------------------- event loop */

/*
 * How long a timer waited past its time, per minute.
 *
 * /api/health measures one trip through the loop per probe, which says how
 * the loop is at that instant and nothing about the stall a minute ago.
 * Node's own monitor samples it every LAG_RESOLUTION_MS into a histogram;
 * the minute's percentiles are kept when the minute ends, and a scrape reads
 * the last whole minute. So a stall stays visible for a minute whoever
 * scrapes and however often: two Prometheus replicas do not split it between
 * them, as a histogram reset by every scrape would.
 *
 * The monitor records the whole interval between two samples, the
 * resolution included; that is subtracted, so an idle loop reads zero rather
 * than 20 ms.
 */
const LAG_RESOLUTION_MS = 20
const LAG_WINDOW_MS = 60_000

interface LagWindow {
  p50: number
  p99: number
  max: number
}

let lag: IntervalHistogram | null = null
let lastMinute: LagWindow | null = null

function watchEventLoop(): void {
  if (lag) return
  lag = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS })
  lag.enable()
  const turn = setInterval(() => {
    lastMinute = readLag() ?? lastMinute
    lag?.reset()
  }, LAG_WINDOW_MS)
  turn.unref?.()
}

function readLag(): LagWindow | null {
  if (!lag || lag.count === 0) return null
  const beyond = (ns: number) => Math.max(0, ns / 1e6 - LAG_RESOLUTION_MS) / 1000
  return { p50: beyond(lag.percentile(50)), p99: beyond(lag.percentile(99)), max: beyond(lag.max) }
}

/* ---------------------------------------------------------------- sources */

let socketCount: (() => number) | null = null

/**
 * Called by index.ts once the server listens: the sockets live there (one
 * WebSocketServer for the notebook, control and file channels), and so does
 * the moment worth one line about the endpoint being on.
 */
export function startMetrics(options: { sockets: () => number }): void {
  socketCount = options.sockets
  if (!metricsToken()) return
  watchEventLoop()
  console.log('[metrics] GET /metrics is on: Prometheus text format, for requests with Authorization: Bearer <METRICS_TOKEN>')
}

/**
 * Read from the environment on every request rather than kept: that is where
 * a Kubernetes Secret puts it, and it is one lookup per scrape.
 */
function metricsToken(): string {
  return process.env.METRICS_TOKEN?.trim() ?? ''
}

/**
 * Compared as SHA-256 digests in constant time: equal lengths for
 * timingSafeEqual whatever was sent, so neither the token's characters nor
 * its length leak through how long a wrong guess takes. The scheme is
 * case-insensitive (RFC 7235); the token is compared trimmed, as it is read,
 * because a Secret written with `echo` carries a newline.
 */
function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^bearer[ \t]+(.+)$/i.exec(header ?? '')
  if (!match) return false
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(match[1].trim()), digest(token))
}

/* ------------------------------------------------------------ http answers */

const ORACLE_PATH = /^\/api\/sessions\/[^/]+\/(?:ai|council)\//
const COMPETITIONS_PATH = /^\/api\/k\//

/**
 * A 429 by the door it came from: the Oracle's limits (and the council's,
 * which spends the same question budget) and the competitions' are told
 * apart by address. The room's door says which of its two limits refused
 * itself (routes/sessions.ts), because the address is the same for both.
 */
function refusalByPath(url: string): RefusalReason {
  const pathname = url.split('?')[0] ?? ''
  if (ORACLE_PATH.test(pathname)) return 'oracle'
  if (COMPETITIONS_PATH.test(pathname)) return 'competitions'
  return 'other'
}

/**
 * Every HTTP answer, counted when it has gone out, by status class, and
 * every 429 by reason. The first middleware of the app (app.ts), so nothing
 * escapes it; WebSocket upgrades are not HTTP answers and have their own
 * gauge. A request the client abandoned before the answer finished is not
 * an answer; the error handler counts those (colloq_http_client_aborts_total).
 */
export function countResponses(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    countHttpResponse(res.statusCode)
    if (res.statusCode === 429) countRateLimited(refusalOf(res) ?? refusalByPath(req.originalUrl ?? req.url))
  })
  next()
}

/* -------------------------------------------------------------- endpoint */

export function metricsEndpoint(req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store')
  const token = metricsToken()
  if (!token) {
    res.status(404).type('text/plain').send(tr('common.notFound'))
    return
  }
  if (!bearerMatches(req.headers.authorization, token)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="colloq-metrics"')
    res.status(401).type('text/plain').send(tr('common.http401'))
    return
  }
  // A token set without a restart through index.ts (tests, mostly) still gets
  // the event loop measured from the first scrape on.
  watchEventLoop()
  res.status(200)
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.end(renderMetrics())
}

/**
 * Every family, in a fixed order. Each source is read on its own: a database
 * that cannot answer costs the competition numbers, not the whole scrape,
 * and the process numbers that would show why are still there.
 */
export function renderMetrics(): string {
  return exposition([
    ...collect('process', processFamilies),
    ...collect('rooms', roomFamilies),
    ...collect('kernels', kernelFamilies),
    ...collect('notebooks', notebookFamilies),
    ...collect('oracle', oracleFamilies),
    ...collect('competitions', competitionFamilies),
    ...collect('http', httpFamilies),
    ...collect('disk', diskFamilies),
    ...collect('snapshots', snapshotFamilies),
  ])
}

function collect(name: string, read: () => MetricFamily[]): MetricFamily[] {
  try {
    return read()
  } catch (err) {
    if (seldom(`metrics:${name}`)) {
      console.warn(`[metrics] ${name} could not be read: ${err instanceof Error ? err.message : String(err)}`)
    }
    return []
  }
}

/* --------------------------------------------------------------- families */

/*
 * The standard process names, so the platform's ready-made Node dashboards
 * find them; the Colloq-specific ones are prefixed colloq_.
 */
function processFamilies(): MetricFamily[] {
  const cpu = process.cpuUsage()
  const memory = process.memoryUsage()
  const window = lastMinute ?? readLag()
  return [
    counter('process_cpu_user_seconds_total', 'User CPU time spent by the server process, in seconds.', single(cpu.user / 1e6)),
    counter('process_cpu_system_seconds_total', 'System CPU time spent by the server process, in seconds.', single(cpu.system / 1e6)),
    counter('process_cpu_seconds_total', 'Total user and system CPU time spent by the server process, in seconds.', single((cpu.user + cpu.system) / 1e6)),
    gauge('process_resident_memory_bytes', 'Resident memory of the server process, in bytes.', single(memory.rss)),
    gauge('nodejs_heap_size_used_bytes', 'V8 heap in use, in bytes.', single(memory.heapUsed)),
    gauge('nodejs_heap_size_total_bytes', 'V8 heap reserved, in bytes.', single(memory.heapTotal)),
    gauge('process_open_fds', 'Open file descriptors of the server process (sockets included); Linux only.', single(openFds())),
    gauge('process_start_time_seconds', 'When the server process started, in seconds since the Unix epoch.', single(Math.round(performance.timeOrigin) / 1000)),
    gauge('colloq_uptime_seconds', 'Seconds since the server process started.', single(process.uptime())),
    gauge('colloq_build_info', 'The running Colloq release; always 1.', [{ labels: { version: COLLOQ_VERSION }, value: 1 }]),
    gauge(
      'colloq_event_loop_lag_p50_seconds',
      'Median event loop delay beyond the due time over the last minute, in seconds: how long a keystroke queues.',
      single(window?.p50),
    ),
    gauge(
      'colloq_event_loop_lag_p99_seconds',
      '99th percentile of the event loop delay beyond the due time over the last minute, in seconds.',
      single(window?.p99),
    ),
    gauge('colloq_event_loop_lag_max_seconds', 'Longest event loop delay beyond the due time over the last minute, in seconds.', single(window?.max)),
  ]
}

function openFds(): number | null {
  try {
    // The listing opens a descriptor of its own, which it then lists.
    return fs.readdirSync('/proc/self/fd').length - 1
  } catch {
    return null
  }
}

function roomFamilies(): MetricFamily[] {
  const census = roomCensus()
  const tallies = tallyTotals()
  let sockets: number | null = null
  try {
    sockets = socketCount?.() ?? null
  } catch {
    sockets = null
  }
  return [
    gauge('colloq_rooms_open', 'Rooms with at least one participant connected.', single(census.rooms)),
    gauge('colloq_participants_online', 'Participants connected to rooms, counted by person (a second tab is not a person).', single(census.people)),
    gauge('colloq_websockets_open', 'Open WebSocket connections: notebook, run control and file channels together.', single(sockets)),
    counter('colloq_sync_frames_total', 'Notebook sync frames accepted from clients.', single(tallies.frames)),
    counter('colloq_sync_frames_refused_total', 'Notebook sync frames refused by the room rules (the gate).', single(tallies.gate)),
  ]
}

function backendLabel(): string {
  try {
    return kernelBackend()
  } catch {
    return 'unknown'
  }
}

function kernelFamilies(): MetricFamily[] {
  const backend = backendLabel()
  const { kernels, runs } = kernelMetrics()
  const counts = counterValues()
  const states = ['idle', 'busy', 'starting', 'dead'] as const
  return [
    gauge(
      'colloq_kernels',
      'Kernels known to this server by container role (room: the class notebook, own: personal notebooks) and state; idle and busy are running, starting is being brought up.',
      KERNEL_ROLES.flatMap((role) => states.map((state) => ({ labels: { backend, role, state }, value: kernels[role][state] }))),
    ),
    counter(
      'colloq_kernel_starts_total',
      'Kernels brought up by this server, by container role.',
      KERNEL_ROLES.map((role) => ({ labels: { backend, role }, value: counts.kernelStarts[role] })),
    ),
    counter(
      'colloq_kernel_start_failures_total',
      'Kernel starts that failed, by container role.',
      KERNEL_ROLES.map((role) => ({ labels: { backend, role }, value: counts.kernelStartFailures[role] })),
    ),
    gauge('colloq_cell_runs_queued', 'Cell runs waiting for their notebook kernel, across all rooms.', single(runs.queued)),
    gauge('colloq_cell_runs_running', 'Cell runs executing right now, across all rooms.', single(runs.running)),
  ]
}

function notebookFamilies(): MetricFamily[] {
  const persistence = persistenceDiagnostics()
  return [
    counter('colloq_notebook_save_failures_total', 'Notebook saves to the database that failed.', single(persistence.saveFailures)),
    gauge('colloq_notebooks_unsaved', 'Open notebooks with changes not yet saved.', single(persistence.dirtyDocuments)),
    gauge(
      'colloq_notebook_oldest_unsaved_seconds',
      'Age of the oldest unsaved change in any open notebook, in seconds.',
      single(persistence.oldestUnsavedMs / 1000),
    ),
  ]
}

function oracleFamilies(): MetricFamily[] {
  return [
    counter(
      'colloq_oracle_requests_total',
      'Requests sent to the model endpoint: questions, hints, council reads and agent steps.',
      single(counterValues().oracleRequests),
    ),
    counter('colloq_oracle_failures_total', 'Model requests that failed, including refusals by the model safety filter.', single(tallyTotals().oracle)),
  ]
}

let submissionsByState: { all(): unknown[] } | null = null

function competitionFamilies(): MetricFamily[] {
  const queue = queueCensus('competition_queue', 'enqueued_at', 'waiting', ['running'])
  const execution = competitionExecutionDiagnostics()
  submissionsByState ??= db.prepare('SELECT state, COUNT(*) AS n FROM submissions GROUP BY state')
  const rows = submissionsByState.all() as { state: string; n: number }[]
  const byState = new Map<string, number>(SUBMISSION_STATES.map((state) => [state, 0]))
  let other = 0
  for (const row of rows) {
    if (byState.has(row.state)) byState.set(row.state, row.n)
    else other += row.n
  }
  const states: Sample[] = [...byState].map(([state, n]) => ({ labels: { state }, value: n }))
  if (other > 0) states.push({ labels: { state: 'other' }, value: other })
  return [
    gauge('colloq_competition_queue_waiting', 'Competition submissions waiting for a run slot.', single(queue.waiting)),
    gauge('colloq_competition_queue_running', 'Competition submissions running now.', single(queue.running)),
    gauge(
      'colloq_competition_queue_oldest_wait_seconds',
      'How long the oldest waiting competition submission has waited, in seconds; 0 when none waits.',
      single(queue.oldestWaitingMs / 1000),
    ),
    gauge('colloq_competition_submissions', 'Competition submissions stored, by state (queued, running, and each outcome).', states),
    counter('colloq_competition_attempts_started_total', 'Competition run attempts started by this server.', single(execution.started)),
    counter('colloq_competition_attempts_completed_total', 'Competition run attempts that finished, whatever the verdict.', single(execution.completed)),
    counter('colloq_competition_attempt_retries_total', 'Competition runs put back in the queue after a server restart cut them short.', single(execution.retries)),
    counter('colloq_competition_cleanup_failures_total', 'Competition containers or jobs that could not be removed.', single(execution.cleanupFailures)),
  ]
}

function httpFamilies(): MetricFamily[] {
  const counts = counterValues()
  return [
    counter(
      'colloq_http_requests_total',
      'HTTP responses sent, by status class (WebSocket upgrades not included).',
      STATUS_CLASSES.map((status) => ({ labels: { status_class: status }, value: counts.httpResponses[status] })),
    ),
    counter(
      'colloq_rate_limited_total',
      'Requests refused with 429, by the limit: join_room (newcomers per room), join_address (newcomers per address), oracle, competitions, other.',
      REFUSAL_REASONS.map((reason) => ({ labels: { reason }, value: counts.rateLimited[reason] })),
    ),
    counter('colloq_http_client_aborts_total', 'Requests the client abandoned before the answer (a closed tab mid-load).', single(tallyTotals().aborted)),
  ]
}

/*
 * Both volumes always, even when they are one filesystem: an alert written
 * for the workspace must not go silent on an install where it shares the
 * data disk. The panel shows one bar there (ops/disk.ts); a query can
 * deduplicate, but it cannot invent a series that is not there.
 */
function diskFamilies(): MetricFamily[] {
  const free: Sample[] = []
  const size: Sample[] = []
  for (const [volume, directory] of [
    ['data', config.dataDir],
    ['workspace', config.workspaceDir],
  ] as const) {
    try {
      const space = filesystemSpace(directory)
      free.push({ labels: { volume }, value: space.freeBytes })
      size.push({ labels: { volume }, value: space.totalBytes })
    } catch {
      /* not created yet: no number rather than a zero that would page someone */
    }
  }
  return [
    gauge('colloq_disk_free_bytes', 'Bytes available to the server on the filesystem of the data or workspace volume.', free),
    gauge('colloq_disk_size_bytes', 'Size of the filesystem of the data or workspace volume, in bytes.', size),
  ]
}

function snapshotFamilies(): MetricFamily[] {
  const status = databaseSnapshotStatus(config.dataDir)
  return [
    gauge('colloq_db_snapshot_interval_seconds', 'DB_SNAPSHOT_HOURS in seconds; 0 when periodic database snapshots are off.', single(status.everyHours * 3600)),
    gauge('colloq_db_snapshots', 'Database snapshots kept in the data volume, periodic and pre-migration.', single(status.count)),
    gauge(
      'colloq_db_snapshot_last_timestamp_seconds',
      'When the newest database snapshot was taken, in seconds since the Unix epoch.',
      single(status.last ? status.last.at / 1000 : null),
    ),
    gauge('colloq_db_snapshot_last_size_bytes', 'Size of the newest database snapshot, in bytes.', single(status.last?.bytes)),
    gauge(
      'colloq_db_snapshot_last_duration_seconds',
      'How long the last snapshot taken by this process took, in seconds.',
      single(status.lastDurationMs === null ? null : status.lastDurationMs / 1000),
    ),
    counter('colloq_db_snapshot_failures_total', 'Database snapshots that failed since the process started.', single(status.failures)),
  ]
}
