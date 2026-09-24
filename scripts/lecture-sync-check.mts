/**
 * Does the projector keep up with the console when pages are turned fast.
 *
 * It appeared after a complaint from a real class: "flip forward or back, and
 * the sync may take five seconds or more to catch up with the console, or not
 * catch up at all and stay on the old slide". None of the existing harnesses
 * catches this: `ui-check` turns one page at a time and waits for an answer
 * after each, and the waiting is exactly what hides the whole disease. What
 * has to be measured is a QUEUE of presses: ten in a row, faster than the
 * socket can turn around.
 *
 * Three things are measured, and they are different:
 *   ARRIVED — which page the server shows in the end (were all presses counted);
 *   WHEN    — how long after the LAST press the projection drew it;
 *   WHAT    — whether those are the right pixels (the canvas fingerprint against
 *             the reference of that page).
 *
 * The third is not paranoia here: "stays on the old slide" is when the state
 * arrived but the canvas stayed as it was, and no check by state sees that.
 *
 * Its own ports (3898 and 9338): ui-check lives on 3891/9334, pencil-check on
 * 3897/9337, and three runs side by side stay out of each other's way.
 *
 *   npx tsx scripts/lecture-sync-check.mts
 *   npx tsx scripts/lecture-sync-check.mts --headed
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WS from 'ws'

const HEADED = process.argv.includes('--headed')
const PORT = Number(process.env.SYNC_CHECK_PORT ?? 3898)
const CDP_PORT = Number(process.env.SYNC_CHECK_CDP ?? 9338)
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const root = mkdtempSync(path.join(tmpdir(), 'colloq-sync-'))
const ROOM = 'sync1'
/** This many pages in the deck: the queue of presses must stay inside the document, not run into its end. */
const PAGES = 24

/* ------------------------------------------------------- a small PDF */

/** The same PDF as in the other harnesses, only longer: 16:9 slides. */
function samplePdf(pages: number): string {
  const obj = (n: number, body: string) => `${n} 0 obj\n${body}\nendobj\n`
  const font = 3 + pages * 2
  const parts = [obj(1, '<< /Type /Catalog /Pages 2 0 R >>')]
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')
  parts.push(obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`))
  for (let i = 0; i < pages; i += 1) {
    /*
     * The page is recognized by a BAR whose length depends on the number, and
     * by no text at all. The harness needs to be able to say "the projector
     * shows the seventh, not the third", and it cannot lean on a font for
     * that: pdf.js without `standardFontDataUrl` throws on the very first
     * Helvetica and leaves the canvas white, having drawn only the background.
     * The first version of this harness stayed silent exactly like that: eight
     * "different" pages with the same fingerprint. The bar is drawn before any
     * text and depends on nothing but two numbers.
     */
    const bar = 40 + i * 34
    const stream = `0 0 0 rg 72 120 ${bar} 300 re f`
    parts.push(
      obj(
        3 + i * 2,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      ),
      obj(4 + i * 2, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
    )
  }
  // There is no font in the deck at all: pages are told apart by the bar, not by a caption.
  parts.push(obj(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const part of parts) {
    offsets.push(out.length)
    out += part
  }
  const start = out.length
  out += `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${parts.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return out
}

mkdirSync(path.join(root, 'workspace', ROOM), { recursive: true })
writeFileSync(path.join(root, 'workspace', ROOM, 'lecture.pdf'), samplePdf(PAGES), 'latin1')

/* ---------------------------------------------------------------- server */

process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
process.env.SESSION_SECRET = 'lecture-sync-check'
process.env.PORT = String(PORT)
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`
process.env.JUPYTER_URL = 'http://127.0.0.1:1'
process.env.KERNEL_ISOLATION = 'off'
process.env.STATIC_DIR = path.resolve('web/dist')
process.env.OPENAI_API_KEY = 'sync-check-not-a-real-key'
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1'

await import('../server/src/index.js')
const { createSession } = await import('../server/src/db.js')
const { createTeacher } = await import('../server/src/admin/store.js')
const { issueStaffCookie } = await import('../server/src/admin/auth.js')
const { STAFF_COOKIE } = await import('../shared/admin.js')
await new Promise((r) => setTimeout(r, 700))
createSession(ROOM, 'Стенд синхронизации', null)
const teacher = createTeacher({ name: 'Ада', email: 'ada@sync.local', role: 'owner' })!
let cookieValue = ''
issueStaffCookie({ cookie: (_n: string, v: string) => (cookieValue = v) } as never, teacher)

/* ---------------------------------------------------------------- browser */

const chrome = spawn(
  CHROME,
  [
    ...(HEADED ? [] : ['--headless=new']),
    '--disable-gpu',
    /*
     * Without these three flags a tab that ends up out of view gets NOT A
     * SINGLE frame, and pdf.js advances rendering precisely by frames: the
     * canvas stays the white background that is filled synchronously, and the
     * harness measures emptiness. That is exactly where the first version of
     * the harness got stuck: "eight different pages with the same
     * fingerprint".
     */
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(root, 'chrome')}`,
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let browserWsUrl = ''
for (let i = 0; i < 80; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
    if (res.ok) {
      browserWsUrl = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
      break
    }
  } catch {
    /* not up yet */
  }
  await wait(250)
}
if (!browserWsUrl) {
  console.error(`Chrome did not open the debugging port. Is it even at this path?\n  ${CHROME}`)
  chrome.kill()
  process.exit(1)
}

function connect(url: string) {
  const ws = new WS(url)
  const ready = new Promise<void>((r) => ws.on('open', () => r()))
  let seq = 0
  const waiters = new Map<number, (value: any) => void>()
  const listeners: ((m: any) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString())
    if (message.id && waiters.has(message.id)) {
      waiters.get(message.id)!(message)
      waiters.delete(message.id)
    } else for (const l of listeners) l(message)
  })
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = ++seq
      waiters.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { ready, send, on: (l: (m: any) => void) => listeners.push(l) }
}

const browser = connect(browserWsUrl)
await browser.ready

interface Tab {
  js: (expr: string) => Promise<any>
  send: (method: string, params?: Record<string, unknown>) => Promise<any>
  trouble: string[]
}

async function tab(url: string, isolated = false): Promise<Tab> {
  let targetId: string
  if (isolated) {
    const ctx = await browser.send('Target.createBrowserContext')
    const made = await browser.send('Target.createTarget', {
      url,
      browserContextId: ctx.result.browserContextId,
    })
    targetId = made.result.targetId
  } else {
    const made = await browser.send('Target.createTarget', { url, newWindow: true })
    targetId = made.result.targetId
  }
  const link = connect(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${targetId}`)
  await link.ready
  const trouble: string[] = []
  link.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      trouble.push('exception: ' + (d?.exception?.description ?? d?.text ?? '?'))
    }
  })
  await link.send('Runtime.enable')
  await link.send('Page.enable')
  const js = async (expr: string) => {
    const res = await link.send('Runtime.evaluate', {
      expression: `(async()=>{${expr}})()`,
      awaitPromise: true,
      returnByValue: true,
    })
    const failed = res.result?.exceptionDetails
    if (failed) throw new Error(failed.exception?.description ?? failed.text)
    return res.result?.result?.value
  }
  return { js, send: link.send, trouble }
}

async function enter(page: Tab, name: string): Promise<void> {
  await wait(2500)
  if (!(await page.js("return !!document.querySelector('input#join-name')"))) return
  await page.js(
    `const i=document.querySelector('input#join-name');` +
      `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;` +
      `set.call(i,${JSON.stringify(name)}); i.dispatchEvent(new Event('input',{bubbles:true})); return 1`,
  )
  await wait(250)
  await page.js(
    "const b=[...document.querySelectorAll('button')].find(x=>/join/i.test(x.textContent||'')); b&&b.click(); return 1",
  )
  await wait(2500)
}

async function until(page: Tab, expr: string, what: string, ms = 20000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await page.js(`return ${expr}`)) === true) return true
    await wait(150)
  }
  console.log(`  (gave up waiting: ${what})`)
  return false
}

const results: { ok: boolean; what: string; got: string }[] = []
const check = (ok: boolean, what: string, got: unknown) =>
  results.push({ ok, what, got: String(got) })

/* ------------------------------------------------------- room and lecture */

const host = await tab('about:blank')
await host.send('Network.setCookie', {
  name: STAFF_COOKIE,
  value: cookieValue,
  domain: '127.0.0.1',
  path: '/',
})
await host.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/s/${ROOM}` })
await enter(host, 'Ада')
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('lecture.pdf'));` +
    `if(!b) throw new Error('no lecture.pdf row in the tree'); b.click(); return 1`,
)
await until(host, 'document.querySelectorAll("canvas").length > 0', 'the document opened for the host')
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Лекция');` +
    `if(!b) throw new Error('no "Лекция" button'); b.click(); return 1`,
)
await until(
  host,
  `[...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`,
  'the lecture is on',
)

/*
 * The page fingerprint is ONE row of pixels across the sheet.
 *
 * The first version read the whole canvas: a million and a half pixels, four
 * canvases, and all of it over the debugger wire. One such measurement cost
 * three seconds, and the harness charged them to the product as its latency,
 * while the render trace at the same time showed 419 ms for everything. A
 * measure that costs more than what it measures is measuring itself.
 *
 * Pages are told apart by a black bar that grows with the number; a row in the
 * middle of the sheet always crosses it. The page canvas is looked up once: it
 * is the only opaque one, the ink layers are transparent.
 */
const FIND_SHEET =
  `window.__sheet = [...document.querySelectorAll('canvas')].find(q=>{` +
  `  if(!q.width||!q.height) return false;` +
  `  const g=q.getContext('2d',{willReadFrequently:true}); if(!g) return false;` +
  `  const d=g.getImageData(0,(q.height/2)|0,q.width,1).data;` +
  `  for(let i=3;i<d.length;i+=4) if(d[i]>8) return true;` +
  `  return false;` +
  `}) || null; return !!window.__sheet`

const FINGERPRINT =
  `const c=window.__sheet; if(!c||!c.width) return null;` +
  `const g=c.getContext('2d',{willReadFrequently:true}); if(!g) return null;` +
  `const d=g.getImageData(0,(c.height/2)|0,c.width,1).data;` +
  `let dark=0,sum=0; for(let i=0;i<d.length;i+=4){const v=d[i]+d[i+1]+d[i+2]; if(v<200) dark++; sum=(sum*31+v)>>>0}` +
  `return {dark,sum,w:c.width,h:c.height}`

interface Shot {
  dark: number
  sum: number
  w: number
  h: number
}

/* ------------------------------------------------------------- projection */

/**
 * The projection as a separate tab. In the product it is opened by
 * `window.open` from the room, but for our measurement a window and a tab are
 * the same thing: what matters is its own document, its own pdf.js and its own
 * socket, not the frame around them.
 */
const beam = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}/screen`)
/*
 * The projection is brought to the front and kept there for the whole run.
 * This is not a convenience of the harness but a condition of the experiment:
 * in a background tab the browser throttles requestAnimationFrame, and pdf.js
 * advances rendering precisely with it, so the canvas stays white forever.
 * The console works from the background all this time: presses are sent to it
 * via JS, and those need no focus.
 */
await beam.send('Page.bringToFront')
await until(beam, `!!document.querySelector('canvas')`, 'the projection drew a page')
await wait(800)
await until(beam, FIND_SHEET, 'found the page canvas')
/*
 * Count the arrows that reached the projection window separately from what
 * came of them. Without this, "seven presses moved it by one page" reads two
 * ways: either six presses got lost on the way, or all of them arrived and the
 * logic merged them. Those are different diseases and different cures.
 */
await beam.js(
  `window.__keys=0; window.addEventListener('keydown', (e)=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft') window.__keys++}, true); return 1`,
)
await wait(600)

/** The projection canvas fingerprint: a sum over a sparse grid; the number is enough to tell pages apart. */
const shownNow = () => beam.js(FINGERPRINT) as Promise<Shot | null>
/** Two pages count as one only if both the number of dark pixels and the sum match. */
const same = (a: Shot | null, b: Shot | null) =>
  a !== null && b !== null && a.dark === b.dark && a.sum === b.sum

/**
 * Whether it is the same page ON ANOTHER SCREEN.
 *
 * The student's sheet is smaller than the projector's (in the room there are
 * panels on the sides), and counting pixels is pointless: one and the same
 * eighth page gives 453 dark dots on the projector and 276 at the student's.
 * What has to be compared is the share the bar takes: each page has its own,
 * and it does not depend on scale. Half a percent of tolerance is for the
 * rounding of the bar's edges at different canvas sizes.
 */
const samePage = (a: Shot | null, b: Shot | null) =>
  a !== null && b !== null && a.w > 0 && b.w > 0 && Math.abs(a.dark / a.w - b.dark / b.w) < 0.005

/**
 * References: what each page looks like when it is allowed to draw calmly.
 * They are taken ONCE at the start, one press at a time, that is, along the
 * path nobody doubts. After that the harness checks fast page-turning against
 * them.
 */
const press = (aria: string) =>
  `const b=document.querySelector('[aria-label=${JSON.stringify(aria)}]');` +
  `if(!b) throw new Error('the console has no control "${aria}"'); b.click(); return 1`

const pult = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}/pult`)
await pult.send('Emulation.setDeviceMetricsOverride', {
  width: 1180,
  height: 820,
  deviceScaleFactor: 2,
  mobile: true,
})
await pult.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/s/${ROOM}/pult` })
await until(pult, `!!document.querySelector('.ink-input')`, 'the console drew the sheet')
await wait(800)

/** Which page the SERVER considers current: we ask the hall, not the console. */
const { lectureOf } = await import('../server/src/lecture.js')
const serverPage = () => lectureOf(ROOM)?.page ?? 0

const marks = new Map<number, Shot>()
for (let n = 1; n <= 10; n += 1) {
  if (n > 1) {
    await pult.js(press('Следующая страница'))
    await until(beam, `true`, 'frame', 100)
    await wait(700)
  }
  /*
   * The reference is taken on the VISIBLE window: it is a sample of what the
   * page looks like when nothing gets in its way. Everything else is measured
   * later on a covered window and checked against this sample.
   */
  await beam.send('Page.bringToFront')
  /*
   * Wait until the canvas STOPS changing, not for a fixed half second: a
   * reference taken in the middle of rendering is a white sheet, and the whole
   * run is then checked against it. That is exactly how "pages" with zero dark
   * pixels showed up in the report.
   */
  const was = marks.get(n - 1) ?? null
  let mark: Shot | null = null
  for (let i = 0; i < 40; i += 1) {
    await wait(100)
    const now = await shownNow()
    // First wait for the page to CHANGE, and only then for it to settle.
    if (!now || now.dark === 0 || (was && same(now, was))) continue
    if (mark && same(now, mark)) break
    mark = now
  }
  if (mark) marks.set(n, mark)
  if (n === 1 && process.argv.includes('--why')) {
    console.log(
      '  projection frames: ' +
        JSON.stringify(
          await beam.js(
            `let n=0; const stop=performance.now()+600;` +
              `await new Promise(r=>{setTimeout(r,900); const t=()=>{n++; if(performance.now()<stop) requestAnimationFrame(t); else r()}; requestAnimationFrame(t)});` +
              `return {frames:n, hidden:document.hidden, vis:document.visibilityState}`,
          ),
        ),
    )
    console.log(
      '  projection canvases: ' +
        JSON.stringify(
          await beam.js(
            `return [...document.querySelectorAll('canvas')].map(q=>{` +
              `const g=q.getContext('2d',{willReadFrequently:true});` +
              `if(!g||!q.width) return {w:q.width,h:q.height,note:'no context'};` +
              `const d=g.getImageData(0,0,q.width,q.height).data;` +
              `let opaque=0,dark=0; for(let i=0;i<d.length;i+=4){if(d[i+3]>8) opaque++; if(d[i+3]>8&&d[i]+d[i+1]+d[i+2]<200) dark++}` +
              `return {cls:q.className,w:q.width,h:q.height,opaque,dark}})`,
          ),
        ),
    )
    console.log('  projection text: ' + JSON.stringify(await beam.js(`return (document.body.textContent||'').slice(0,140)`)))
  }
}
const distinct = new Set([...marks.values()].map((m) => `${m.dark}/${m.sum}`))
check(
  marks.size === 10 && distinct.size === 10,
  'page references are distinguishable',
  `${marks.size} taken, ${distinct.size} distinct · canvas ${[...marks.values()][0]?.w}×${[...marks.values()][0]?.h}` +
    ` · dark ${[...marks.values()].map((m) => m.dark).join(', ')}`,
)

/*
 * One press, broken down by frames: how long it takes from the press until the
 * pixels of the new page appear on the canvas. Measured on the VISIBLE window:
 * that is the best case the product has, and if even that is bad, there is no
 * point starting the conversation about a covered window.
 */
await beam.send('Page.bringToFront')
await wait(600)
{
  const before = await shownNow()
  await beam.js(
    'window.__renderLog=[]; window.__t0=performance.now(); return 1',
  )
  const t = Date.now()
  await pult.js(press('Следующая страница'))
  let painted = -1
  const seen: string[] = []
  for (let i = 0; i < 60; i += 1) {
    const now = await shownNow()
    if (now && !same(now, before)) {
      painted = Date.now() - t
      break
    }
    if (i % 10 === 0) seen.push(`${Date.now() - t}ms`)
    await wait(100)
  }
  console.log(
    '  render progress (ms from reset): ' +
      JSON.stringify(
        await beam.js(
          'const z=window.__t0||0; return (window.__renderLog||[]).slice(0,16).map(r=>({...r,t:Math.round(r.t-z)}))',
        ),
      ),
  )
  check(
    painted >= 0 && painted < 700,
    'one press: the projection redrew',
    painted < 0 ? `did not redraw within 6 s (probed at ${seen.join(', ')})` : `${painted} ms`,
  )
}

/*
 * A student in the hall, in a browser context of their own: the identity lies
 * in localStorage, shared across the profile, and without a separate context
 * they would turn out to be the same person as the host.
 */
const student = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}`, true)
await enter(student, 'Нина')
await until(
  student,
  `(document.body.textContent||'').includes('Лекцию ведёт')`,
  'the student saw the lecture',
)
await student.send('Page.bringToFront')
await until(student, FIND_SHEET.replace('window.__sheet', 'window.__sheet'), 'the student has a sheet')
const seenByHall = () => student.js(FINGERPRINT) as Promise<Shot | null>

/*
 * From here on the projection goes behind another window and stays there. This
 * is not a trick of the harness but the working state of things: the
 * projection window is handed to Zoom and people switch to their own, the
 * second screen blanks into a screensaver, the teacher opens notes on top.
 * Everything measured below must work in this position; otherwise the hall
 * stays on the previous slide, and the host does not know it.
 */
await pult.send('Page.bringToFront')
await wait(400)

/* --------------------------------------------------- fast page-turning */

/** Go back to the first page calmly, one press at a time, and let everything settle. */
async function rewind(): Promise<void> {
  for (let i = 0; i < 40 && serverPage() > 1; i += 1) {
    await pult.js(press('Предыдущая страница'))
    await wait(120)
  }
  await wait(1200)
}

/**
 * One measurement: N presses in a row with a `gap` ms step, then waiting for
 * convergence. Returns which page the server got to and how long after the
 * last press the projection drew what it should.
 */
async function burst(
  what: string,
  fire: () => Promise<void>,
  times: number,
  gap: number,
  expect: number,
  start = 1,
): Promise<void> {
  await rewind()
  // Walk calmly to the place we measure from: the way there is not part of the measurement.
  while (serverPage() < start) {
    await pult.js(press('Следующая страница'))
    await wait(150)
  }
  await wait(800)
  const from = serverPage()
  const t0 = Date.now()
  for (let i = 0; i < times; i += 1) {
    await fire()
    await wait(gap)
  }
  const fired = Date.now()
  /* Wait for convergence up to five seconds: nobody in a class waits any longer. */
  let settled = -1
  const want = marks.get(expect)
  for (let i = 0; i < 100; i += 1) {
    const now = await shownNow()
    if (want && same(now, want) && serverPage() === expect) {
      settled = Date.now() - fired
      break
    }
    await wait(50)
  }
  const got = serverPage()
  const keys = (await beam.js('const n=window.__keys||0; window.__keys=0; return n')) as number
  const shown = await shownNow()
  /*
   * The main check of the whole harness: the hall and the projector on the
   * SAME page. The host talks about the seventh while the hall reads the
   * sixth, and they find out from a question from the audience, if they find
   * out at all. Wait up to a second and a half: the student, unlike the
   * projector, is allowed to arrive a little later.
   */
  let hall: Shot | null = null
  for (let i = 0; i < 30; i += 1) {
    hall = await seenByHall()
    if (want && samePage(hall, want)) break
    await wait(50)
  }
  check(
    want ? samePage(hall, want) : false,
    `${what}: the hall is on the same page as the projector`,
    hall
      ? `bar share ${(hall.dark / hall.w).toFixed(3)} against ${((want?.dark ?? 0) / (want?.w || 1)).toFixed(3)}`
      : 'the student has no sheet',
  )
  const right = same(shown, want ?? null)
  check(
    got === expect && settled >= 0 && settled < 500,
    `${what}: ${times} presses in ${fired - t0} ms`,
    `server at ${got} for ${from}→${expect}` +
      (keys ? ` · arrows arrived ${keys}` : '') +
      ` · canvas ${right ? 'the same page' : 'a DIFFERENT one'}` +
      ` · converged ${settled < 0 ? 'DID NOT CONVERGE within 5 s' : settled + ' ms after the last press'}`,
  )
}

await burst(
  'console, forward',
  () => pult.js(press('Следующая страница')),
  7,
  40,
  8,
)

const arrow = (page: Tab, key: string, code: string) => async () => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : 37 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : 37 })
}

await burst(
  'projection, right arrow',
  arrow(beam, 'ArrowRight', 'ArrowRight'),
  7,
  40,
  8,
)

/*
 * Back is not a mirror of "forward". The host returns to a formula the hall
 * did not manage to copy down, and this is the most common place where the
 * projector lagged: people flip back in a burst, without looking, "three
 * slides back".
 */
await burst(
  'console, back',
  () => pult.js(press('Предыдущая страница')),
  6,
  40,
  4,
  10,
)

await burst(
  'projection, left arrow',
  arrow(beam, 'ArrowLeft', 'ArrowLeft'),
  6,
  40,
  4,
  10,
)

/* ------------------------------------------------------------- report */

for (const page of [host, pult, beam]) {
  for (const line of page.trouble.slice(0, 3)) console.log(`  (${line})`)
}
let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.what.padEnd(48)} ${r.got}`)
}
console.log(`\n  ${failed === 0 ? 'the projector follows the console' : `out of sync: ${failed}`}\n`)
chrome.kill()
process.exit(failed === 0 ? 0 : 1)
