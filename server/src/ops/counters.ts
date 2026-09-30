/**
 * Counters for /metrics, kept apart from the page that prints them.
 *
 * The exposition (ops/metrics.ts) reads rooms, kernels, the database and the
 * disks, so it imports half the server; the places that count (the kernel
 * start, the Oracle's transport, the HTTP stack) are imported BY that half. A
 * counter living in metrics.ts would close an import cycle at every call
 * site. This module imports nothing at run time, so anything can count.
 *
 * Every label has a fixed set of values, spelled out below. A label that
 * could take a room id or a person's would grow a series per class, and a
 * Prometheus that scrapes a semester of those is the platform team's outage.
 * Room-level detail belongs to the log, which is where it already is.
 */
import type { KernelRole } from '../kernel/pool.js'

export const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const
export type StatusClass = (typeof STATUS_CLASSES)[number]

/**
 * Why a request was answered 429.
 *
 * The door to a room refuses for two different reasons, and they call for
 * different fixes: too many newcomers in one room at once is a class arriving
 * at the bell, too many from one address is a NAT without SHARED_ADDRESSES or
 * a script (routes/sessions.ts). The Oracle's and the competitions' limits
 * are told apart by the address of the request (ops/metrics.ts), so their
 * routes did not have to change for this.
 */
export const REFUSAL_REASONS = ['join_room', 'join_address', 'oracle', 'competitions', 'other'] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

export const KERNEL_ROLES: readonly KernelRole[] = ['room', 'own']

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>

const httpResponses = zeros(STATUS_CLASSES)
const rateLimited = zeros(REFUSAL_REASONS)
const kernelStarts = zeros(KERNEL_ROLES)
const kernelStartFailures = zeros(KERNEL_ROLES)
let oracleRequests = 0

/** One finished HTTP response, by the first digit of its status. */
export function countHttpResponse(status: number): void {
  const key = `${Math.floor(status / 100)}xx`
  if (key in httpResponses) httpResponses[key as StatusClass] += 1
}

export function countRateLimited(reason: RefusalReason): void {
  rateLimited[reason] += 1
}

/** A kernel came up (`ok`) or its start failed, in the class's container or the personal one. */
export function countKernelStart(role: KernelRole, ok: boolean): void {
  const counts = ok ? kernelStarts : kernelStartFailures
  if (role in counts) counts[role] += 1
}

/** A request sent to the model endpoint: a question, a hint, a council read or one agent step. */
export function countOracleRequest(): void {
  oracleRequests += 1
}

/** Copies, so that a caller holding them cannot move the counters. */
export function counterValues() {
  return {
    httpResponses: { ...httpResponses },
    rateLimited: { ...rateLimited },
    kernelStarts: { ...kernelStarts },
    kernelStartFailures: { ...kernelStartFailures },
    oracleRequests,
  }
}

/*
 * The reason of a 429, named by the route that refuses.
 *
 * Counted where the response finishes (ops/metrics.ts · countResponses), not
 * here: that one place sees every 429, including ones added later without a
 * word about metrics, and those land in `other` rather than nowhere. A route
 * that knows more than its address says leaves a note on the response.
 */
const REFUSAL_KEY = 'colloqRefusal'

export function refusalReason(res: { locals: Record<string, unknown> }, reason: RefusalReason): void {
  res.locals[REFUSAL_KEY] = reason
}

export function refusalOf(res: { locals: Record<string, unknown> }): RefusalReason | undefined {
  const noted = res.locals[REFUSAL_KEY]
  return (REFUSAL_REASONS as readonly unknown[]).includes(noted) ? (noted as RefusalReason) : undefined
}
