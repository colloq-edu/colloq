/**
 * competition-load.mts: will a competition hold a class sending at once.
 *
 * The question it answers is the one a real class asked at the deadline:
 * fifteen people behind one router press "Send" in the same minute — do all
 * the notebooks get in, how long does each wait for a slot, and when is the
 * last result in? The rig takes an EXISTING live competition and a notebook,
 * joins N new entrants through the public door (the way students do, with
 * distinct names), fires N uploads at once and then watches the queue until
 * every accepted submission has a result. Then it prints:
 *
 *   ACCEPT   accepted and refused, refusals by reason, time to accept p50/p95/max
 *   QUEUE    wait for a slot p50/p95, run time p50/p95
 *   DRAIN    from the first upload to the last result
 *   SLOTS    the most submissions seen running at once (ours, and the whole queue)
 *
 * Waits and run times come from the server's own run records (the panel's
 * "All output"), not from polling, so a run shorter than the poll still
 * counts; "running at once" is computed from the same records, and the
 * polled queue is shown next to it.
 *
 * IT DELETES NOTHING. The entrants and their submissions stay in the instance
 * and appear on that competition's leaderboard as "@load_<run>_<i>". Point it
 * at a competition made for the test, never at the one a class is solving:
 * every submission costs a slot, and the class waits behind them.
 *
 * Usage: make competition-load SLUG=<slug> NOTEBOOK=<file.ipynb> [N=15]
 *        (or npx tsx scripts/competition-load.mts with the variables below)
 *   LOAD_BASE_URL      where the instance is                 default http://localhost:3000
 *   LOAD_SLUG          the competition's address, /k/<slug>  required
 *   LOAD_NOTEBOOK      the notebook every entrant sends      required
 *   LOAD_ENTRANTS      how many entrants join and send       default 15
 *   LOAD_TIMEOUT_SEC   stop waiting for results after        default 1800
 *   LOAD_SETUP_TOKEN   the setup token, when data/setup-token is not next to it
 *   LOAD_STAFF_COOKIE  a ready `colloq_staff=...` cookie, if there is no token at all
 *   DATA_DIR           where setup-token lies                default <repo>/data
 * Neither the token nor the cookie is ever printed.
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* --------------------------------------------------------------- settings */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = (process.env.LOAD_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const SLUG = (process.env.LOAD_SLUG ?? '').trim()
const NOTEBOOK = (process.env.LOAD_NOTEBOOK ?? '').trim()
const ENTRANTS = Math.max(1, Math.round(Number(process.env.LOAD_ENTRANTS ?? 15) || 15))
const TIMEOUT_MS = Math.max(10, Number(process.env.LOAD_TIMEOUT_SEC ?? 1800) || 1800) * 1000
const POLL_MS = 1000

const bold = (text: string) => `\x1b[1m${text}\x1b[0m`
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`
const red = (text: string) => `\x1b[31m${text}\x1b[0m`
const say = (text = '') => console.log(text)
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/* ------------------------------------------------------ signing in to the panel */

/**
 * The same door as in load.mts: the setup token spent on its second job,
 * signing in as the founder, or a ready staff cookie. The panel is needed for
 * the queue and the run records; the entrants themselves come through the
 * public door like everyone else.
 */
async function staffCookie(): Promise<string> {
  const given = (process.env.LOAD_STAFF_COOKIE ?? '').trim()
  if (given) {
    const cookie = given.split(';')[0]
    if (!cookie.startsWith('colloq_staff=')) throw new Error('LOAD_STAFF_COOKIE is not a colloq_staff= cookie')
    return cookie
  }
  const tokenFile = resolve(process.env.DATA_DIR ?? join(ROOT, 'data'), 'setup-token')
  let token = (process.env.LOAD_SETUP_TOKEN ?? '').trim()
  if (!token) {
    try {
      token = readFileSync(tokenFile, 'utf8').trim()
    } catch {
      throw new Error(`no setup token in ${tokenFile} or in LOAD_SETUP_TOKEN, and no cookie in LOAD_STAFF_COOKIE`)
    }
  }
  const res = await fetch(`${BASE}/api/admin/signin/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw new Error(`sign-in refused (${res.status})`)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie.startsWith('colloq_staff=')) throw new Error('no staff cookie was issued')
  return cookie
}

async function panel<T>(cookie: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}/api/admin${path}`, { headers: { cookie } })
  if (!res.ok) throw new Error(`GET /api/admin${path} answered ${res.status}`)
  return (await res.json()) as T
}

/* --------------------------------------------------------------- numbers */

function percentile(values: readonly number[], share: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))]
}

function seconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

const spread = (values: readonly number[]) =>
  `p50 ${seconds(percentile(values, 0.5))} · p95 ${seconds(percentile(values, 0.95))} · max ${seconds(values.length ? Math.max(...values) : null)}`

/** The most intervals open at one moment — a sweep over starts and ends. */
function mostAtOnce(intervals: readonly [number, number][]): number {
  const edges = intervals.flatMap(([start, end]) => [[start, 1], [end, -1]] as const)
  // An end at the same moment as a start closes first: back-to-back runs share a slot.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let open = 0, most = 0
  for (const [, step] of edges) {
    open += step
    most = Math.max(most, open)
  }
  return most
}

/* ------------------------------------------------------------------ shapes */

interface Submission { id: string; number: number; state: string; acceptedAt: number; durationMs: number | null }
interface Run { kind: string; startedAt: number; finishedAt: number | null }
const TERMINAL = new Set(['scored', 'notebookFailed', 'rejected', 'timedOut', 'outOfMemory', 'metricFailed', 'cancelled'])

/* -------------------------------------------------------------------- run */

async function main(): Promise<void> {
  if (!SLUG || !NOTEBOOK) {
    console.error(red('LOAD_SLUG and LOAD_NOTEBOOK are required: make competition-load SLUG=<slug> NOTEBOOK=<file.ipynb>'))
    process.exit(2)
  }
  const notebook = readFileSync(NOTEBOOK)
  const cookie = await staffCookie()

  const list = await panel<{ competitions: { competition: { id: string; slug: string; state: string; deadlineAt: number | null; title: string } }[] }>(cookie, '/competitions')
  const competition = list.competitions.map((row) => row.competition).find((one) => one.slug === SLUG)
  if (!competition) throw new Error(`no competition /k/${SLUG} on ${BASE}`)
  if (competition.state !== 'live') throw new Error(`/k/${SLUG} is ${competition.state}, not live: it accepts nothing`)
  const settings = await panel<{ slots: { mode: string; effective: number }; uploadsPerMinute: { value: number } }>(cookie, '/competitions/settings').catch(() => null)

  say(bold(`competition-load · ${BASE}/k/${SLUG} · ${ENTRANTS} entrants · ${basename(NOTEBOOK)}`))
  if (settings) say(dim(`slots: ${settings.slots.effective} (${settings.slots.mode}) · uploads per entrant per minute: ${settings.uploadsPerMinute.value}`))
  say(dim('the rig deletes nothing: its entrants and submissions stay on this competition'))

  /* ------------------------------------------------------------- joining */

  const run = Math.random().toString(36).slice(2, 6)
  const entrants: { name: string; cookie: string }[] = []
  for (let i = 1; i <= ENTRANTS; i++) {
    // A Telegram-shaped name: the door takes nothing else (shared/competitions.ts
    // · entrantHandle), and "load_" keeps it starting with a letter whatever
    // the random run tag begins with.
    const name = `@load_${run}_${i}`
    const res = await fetch(`${BASE}/api/k/competitions/${encodeURIComponent(SLUG)}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { reason?: string; error?: string } | null
      throw new Error(`joining "${name}" was refused (${res.status} ${body?.reason ?? ''}): ${body?.error ?? ''}`)
    }
    const entrant = (res.headers.getSetCookie?.() ?? []).find((line) => line.startsWith('colloq_k='))?.split(';')[0]
    if (!entrant) throw new Error('the join answered without an entrant cookie')
    entrants.push({ name, cookie: entrant })
  }
  say(`joined ${entrants.length}`)

  /* ------------------------------------------------------------- sending */

  const fired = Date.now()
  const sent = await Promise.all(entrants.map(async (entrant, index) => {
    const form = new FormData()
    form.append('file', new Blob([notebook]), `load-${run}-${index + 1}.ipynb`)
    const at = Date.now()
    const res = await fetch(`${BASE}/api/k/competitions/${encodeURIComponent(SLUG)}/submissions`, {
      method: 'POST',
      headers: { cookie: entrant.cookie },
      body: form,
    })
    const body = (await res.json().catch(() => null)) as { submission?: Submission; reason?: string } | null
    return { status: res.status, ms: Date.now() - at, reason: body?.reason ?? null, submission: res.ok ? body?.submission ?? null : null }
  }))
  const accepted = sent.filter((one) => one.submission)
  const refusals = new Map<string, number>()
  for (const one of sent) if (!one.submission) {
    const key = `${one.status} ${one.reason ?? 'unknown'}`
    refusals.set(key, (refusals.get(key) ?? 0) + 1)
  }

  /* ------------------------------------------------------------ watching */

  const ours = new Set(accepted.map((one) => one.submission!.id))
  // Numbers are the server's own order, so paging stops by them, whatever the two clocks say.
  const oldest = Math.min(...accepted.map((one) => one.submission!.number))
  const finished = new Map<string, Submission>()
  let busiestOurs = 0, busiestAll = 0
  const until = Date.now() + TIMEOUT_MS
  let lastLine = ''
  while (finished.size < ours.size && Date.now() < until) {
    const queue = await panel<{ running: { submissionId: string }[]; waiting: number }>(cookie, '/competitions/queue')
    busiestAll = Math.max(busiestAll, queue.running.length)
    busiestOurs = Math.max(busiestOurs, queue.running.filter((row) => ours.has(row.submissionId)).length)
    // Our submissions are the newest ones; page through the feed until all are seen.
    for (let offset = 0; ; offset += 200) {
      const feed = await panel<{ total: number; rows: { submission: Submission }[] }>(cookie, `/competitions/${competition.id}/submissions?limit=200&offset=${offset}`)
      for (const { submission } of feed.rows) {
        if (ours.has(submission.id) && TERMINAL.has(submission.state)) finished.set(submission.id, submission)
      }
      if (offset + 200 >= feed.total || feed.rows.every((row) => row.submission.number < oldest)) break
    }
    const line = `  ${finished.size}/${ours.size} done · ${queue.running.length} running · ${queue.waiting} waiting`
    if (line !== lastLine) say(dim(line))
    lastLine = line
    if (finished.size < ours.size) await sleep(POLL_MS)
  }
  const drained = Date.now()

  /* ------------------------------------------------------------- records */

  const waits: number[] = []
  const runs: number[] = []
  const intervals: [number, number][] = []
  const states = new Map<string, number>()
  for (const submission of finished.values()) {
    states.set(submission.state, (states.get(submission.state) ?? 0) + 1)
    const detail = await panel<{ runs: Run[] }>(cookie, `/competitions/${competition.id}/submissions/${submission.id}`)
    const first = detail.runs[0]
    const last = detail.runs.at(-1)
    if (!first) continue
    waits.push(Math.max(0, first.startedAt - submission.acceptedAt))
    const end = last?.finishedAt ?? first.startedAt
    runs.push(submission.durationMs ?? Math.max(0, end - first.startedAt))
    intervals.push([first.startedAt, end])
  }

  /* -------------------------------------------------------------- report */

  say()
  say(bold('ACCEPT'))
  say(`  accepted ${accepted.length} of ${sent.length}${refusals.size ? red(` · refused ${sent.length - accepted.length}`) : ''}`)
  for (const [key, n] of refusals) say(red(`    ${n} × ${key}`))
  say(`  time to accept  ${spread(sent.map((one) => one.ms))}`)
  say(bold('QUEUE'))
  say(`  wait for a slot ${spread(waits)}`)
  say(`  run time        ${spread(runs)}`)
  say(`  outcomes        ${[...states].map(([state, n]) => `${state} ${n}`).join(' · ') || '—'}`)
  say(bold('DRAIN'))
  say(`  first upload → last result  ${seconds(drained - fired)}${finished.size < ours.size ? red(` · gave up with ${ours.size - finished.size} unfinished`) : ''}`)
  say(bold('SLOTS'))
  say(`  most running at once  ${mostAtOnce(intervals)} of ours by the run records · polled: ${busiestOurs} ours, ${busiestAll} in the whole queue`)
  if (finished.size < ours.size) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(red(`competition-load: ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
})
