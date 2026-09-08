/**
 * End-to-end: two browsers, one shared notebook, real Python, output via CRDT.
 * Self-contained on purpose — importing shared/notebook.ts here would load a
 * second copy of Yjs under tsx and break instanceof checks inside the test.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WS from 'ws'

/*
 * The target is configurable and defaults to the usual dev server. It was a
 * constant, which is how a run of this script once created a seminar inside an
 * instance somebody was teaching in. Anything it makes, it removes again on the
 * way out — in a finally, so a timeout removes it too.
 */
const BASE = (process.env.E2E_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const WSB = BASE.replace(/^http/, 'ws')
/** Where the server keeps its setup token; config.ts defaults it to <repo>/data. */
const DATA_DIR = resolve(
  process.env.DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data'),
)
const j = (r: Response) => r.json() as any
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cells = (d: Y.Doc) => d.getArray<Y.Map<any>>('cells')
const meta = (d: Y.Doc) => d.getMap<any>('meta')
const idOf = (c: Y.Map<any>) => c.get('id') as string

/** Returns the id alongside the cell: Y.Map.get() only works once integrated. */
function newCell(source: string) {
  const id = 'c_' + Math.random().toString(36).slice(2, 12)
  const c = new Y.Map<any>()
  c.set('id', id)
  c.set('type', 'code')
  const t = new Y.Text(); t.insert(0, source)
  c.set('source', t)
  c.set('outputs', new Y.Array())
  c.set('state', 'idle'); c.set('execCount', null); c.set('runBy', null)
  return { cell: c, id }
}

function outputsOf(c: Y.Map<any>) {
  const arr = c.get('outputs') as Y.Array<Y.Map<any>>
  return arr.toArray().map((o) => {
    const kind = o.get('kind')
    if (kind === 'stream') return { kind, name: o.get('name'), text: String(o.get('text')) }
    return { kind, ...JSON.parse((o.get('json') as string) ?? '{}') }
  }) as any[]
}

async function until(label: string, fn: () => boolean, ms = 120_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) { console.log(`  ok  ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return }
    await wait(150)
  }
  throw new Error(`TIMEOUT: ${label}`)
}

/*
 * Creating a seminar is staff-only now, so the test has to be a teacher before
 * it can be one. It uses the setup token's second job: signing in as the
 * founding owner. What comes back is the HttpOnly cookie every /api/admin call
 * and POST /api/sessions is authorised by, so it is carried by hand from here
 * on (fetch keeps no jar).
 *
 * Claiming an unclaimed instance is deliberately not done here. A harness that
 * claims one becomes its owner — "Alexander <owner@colloq.test>" in somebody
 * else's panel — and takes away the first-run screen the teacher was supposed
 * to see. Claiming an instance is a person's decision, so say so and stop.
 */
const setupToken = readFileSync(resolve(DATA_DIR, 'setup-token'), 'utf8').trim()
const instance = await j(await fetch(`${BASE}/api/admin/state`))
if (!instance.claimed) {
  throw new Error(
    'FAIL: nobody has claimed this instance yet. Open /admin, claim it with the setup token, then run this again.',
  )
}

const signIn = await fetch(`${BASE}/api/admin/signin/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: setupToken }),
})
if (!signIn.ok) throw new Error(`FAIL: could not sign in as staff (${signIn.status} ${await signIn.text()})`)
// Name=value only: the browser's own attributes (Path, HttpOnly, SameSite) are
// instructions to a browser and not part of what gets sent back.
const staffCookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0]
if (!staffCookie.startsWith('colloq_staff=')) throw new Error('FAIL: no staff cookie was issued')
const me = await j(signIn)
console.log(`0. signed in as staff: ${me.teacher.name} (${me.teacher.role}) — setup token, recovery path`)

const created = await j(await fetch(`${BASE}/api/sessions`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: staffCookie },
  body: JSON.stringify({ name: 'Computer Vision Seminar — 25.08' }),
}))
if (!created?.session?.id) throw new Error(`FAIL: seminar not created: ${JSON.stringify(created)}`)
const sid = created.session.id
console.log(`1. teacher created a seminar -> ${BASE}/s/${sid}`)

/*
 * Everything the seminar is needed for happens inside this try, and the finally
 * is the point of it. The script throws from a dozen places — every until() that
 * runs out of patience — and until it did this, a run that died on the way left
 * the seminar in the panel for good, plus (under KERNEL_ISOLATION=auto) the room
 * container it had started.
 */
const closers: Array<() => void> = []
let pass = false
try {
  const join = async (name: string, hostToken?: string) =>
    j(await fetch(`${BASE}/api/sessions/${sid}/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, hostToken }),
    }))
  const alex = await join('Alexander', created.hostToken)
  const maria = await join('Maria')
  console.log(`2. joined by name only: ${alex.participant.name} (${alex.participant.role}), ${maria.participant.name} (${maria.participant.role})`)

  const open = (token: string) => {
    const doc = new Y.Doc()
    // Root types must be declared before remote updates arrive, or Yjs cannot
    // tell what shape they are. SessionState does the same in its constructor.
    cells(doc); meta(doc)
    const p = new WebsocketProvider(`${WSB}/collab`, sid, doc, {
      params: { token }, WebSocketPolyfill: WS as any, connect: true,
    })
    closers.push(() => p.destroy())
    return { doc, p }
  }
  const A = open(alex.token)
  const B = open(maria.token)
  await until('both clients synced', () => (A.p as any).synced && (B.p as any).synced)
  await until('server seeded the notebook', () => cells(A.doc).length > 0 && cells(B.doc).length > 0)
  console.log(`3. shared document open — A: ${cells(A.doc).length} cells, B: ${cells(B.doc).length} cells`)

  const { cell, id: newId } = newCell('import sys\nprint("hello from", sys.platform)\n21 * 2')
  A.doc.transact(() => cells(A.doc).push([cell]))
  await until('B received the cell A typed', () => cells(B.doc).toArray().some((c) => idOf(c) === newId))
  console.log('4. realtime edit propagated A -> B')

  const control = new WS(`${WSB}/control/${sid}?token=${encodeURIComponent(maria.token)}`)
  closers.push(() => control.close())
  await new Promise((res, rej) => { control.on('open', res as any); control.on('error', rej) })
  control.send(JSON.stringify({ t: 'run', cellId: newId }))
  console.log('5. Maria pressed Run on the cell Alexander wrote')

  const onB = () => cells(B.doc).toArray().find((c) => idOf(c) === newId)!
  await until('kernel came up', () => ['busy', 'idle'].includes(meta(B.doc).get('kernelStatus')))
  await until('cell finished (seen by B)', () => ['ok', 'error'].includes(onB().get('state')))

  const state = onB().get('state')
  const outs = outputsOf(onB())
  console.log(`6. B sees state=${state} execCount=${onB().get('execCount')} runBy=${onB().get('runBy')}`)
  for (const o of outs) {
    if (o.kind === 'stream') console.log(`     stdout: ${o.text.trim()}`)
    else if (o.kind === 'data') console.log(`     result: ${JSON.stringify(o.data)}`)
    else console.log(`     ${o.ename}: ${o.evalue}`)
  }

  const { cell: fileCell, id: fileId } = newCell("open('made-in-class.txt','w').write('hi')")
  A.doc.transact(() => cells(A.doc).push([fileCell]))
  await until('B received the file-writing cell', () => cells(B.doc).toArray().some((c) => idOf(c) === fileId))
  control.send(JSON.stringify({ t: 'run', cellId: fileId }))
  await until('file-writing cell finished', () => {
    const c = cells(B.doc).toArray().find((x) => idOf(x) === fileId)
    return !!c && ['ok', 'error'].includes(c.get('state'))
  })
  const listed = await fetch(`${BASE}/api/sessions/${sid}/files`, {
    headers: { authorization: `Bearer ${maria.token}` },
  })
  if (!listed.ok) throw new Error(`FAIL: participant could not list room files (${listed.status})`)
  const files = await j(listed)
  console.log(`7. workspace files: ${files.files.map((f: any) => f.name).join(', ') || '(none)'}`)

  pass =
    state === 'ok' &&
    onB().get('runBy') === 'Maria' &&
    outs.some((o) => o.kind === 'stream' && o.text.includes('hello from')) &&
    outs.some((o) => o.kind === 'data' && JSON.stringify(o.data).includes('42')) &&
    files.files.some((f: any) => f.name === 'made-in-class.txt')

  console.log(pass ? '\nPASS — shared notebook, shared kernel, shared outputs, shared files' : '\nFAIL')
} finally {
  for (const close of closers) {
    try { close() } catch { /* already gone: nothing to unwind */ }
  }
  /*
   * Leave the instance as it was found. A check that runs often and leaves a
   * seminar behind every time turns somebody's panel into a scrollable list of
   * this script's leftovers, which is exactly what happened before it did this.
   * Its own failure is caught: a cleanup that throws would replace the real
   * reason the run stopped with a second, less interesting one.
   */
  try {
    const removed = await fetch(`${BASE}/api/admin/seminars/${sid}`, {
      method: 'DELETE',
      headers: { cookie: staffCookie },
    })
    console.log(removed.ok ? '8. cleaned up: the test seminar is gone' : `8. could not remove ${sid} (HTTP ${removed.status})`)
  } catch (err) {
    console.log(`8. could not remove ${sid}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

process.exit(pass ? 0 : 1)
