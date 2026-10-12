/**
 * The "iPad with Pencil and a palm" harness for the lecture console: a
 * regression check for §8 of the brief.
 *
 * It appeared after the teacher tried the console on a real iPad and said
 * that "everything else is done badly": the third of three quick strokes does
 * not draw, a palm on the margins selects the sheet, the pointer jumps, and
 * the page turns by itself. None of these complaints reproduces with a mouse,
 * and that is exactly why `ui-check` did not see them: there the pen is four
 * synthetic events, and there is no palm at all.
 *
 * Here Chrome is driven over CDP as a tablet: a window with a double pixel,
 * touch emulation, the pen is `Input.dispatchMouseEvent` with `pointerType:
 * 'pen'`, pressure and tilt (a real PointerEvent with `pointerType === 'pen'`
 * reaches the page, and the very first scenario checks that), the palm is
 * `Input.dispatchTouchEvent` with one and two contacts.
 *
 * AN HONEST LIMITATION. Chrome, on receiving a pen press, CANCELS all live
 * touches (`pointercancel` on every contact: that is how its input pipeline
 * works, it never has a pen on top of fingers). On an iPad the palm lies
 * there the whole time one writes. So in the scenarios where the palm and the
 * pen are on the sheet AT THE SAME TIME, the palm is fed as synthetic
 * PointerEvents straight into the DOM (`via: 'dom'`), while the pen stays real
 * CDP input: pointer capture, `preventDefault`, hitting the element, all as
 * with a live pen. The palm logic in the console is plain pointer event
 * handlers, it does not care where an event comes from; but synthetic events
 * do not trigger system selection and scrolling, so the margins scenario lays
 * the palm down with a real touch (`via: 'cdp'`).
 *
 * The harness does not cut the wire or wait for it: it INTERCEPTS it. The
 * identity and the socket are not exposed outside the page (and rightly so),
 * so before the page is even navigated to, a `WebSocket` wrapper is slipped
 * into it that collects the instances in `window.__sockets`: the "mute wire"
 * for the scenario with a hundred wet strokes is `send = () => {}` on the
 * live socket, the "drop" is its `close()`. Neither can be had through
 * `Network.emulateNetworkConditions`: offline emulation does not touch an
 * already open socket.
 *
 *   npx tsx scripts/pencil-check.mts               — three geometries in a row
 *   npx tsx scripts/pencil-check.mts --size=834x1194    — only one
 *   npx tsx scripts/pencil-check.mts --headed      — with a visible window
 *   npx tsx scripts/pencil-check.mts --shot        — a console screenshot for each
 *
 * Its own ports (3897 and 9337): `ui-check` lives on 3891/9334, and two runs
 * side by side stay out of each other's way.
 *
 * How to write a scenario: see the "helpers" block below: `stroke`,
 * `rapidStrokes`, `palm.down / move / up`, `laserHold`, `measure`. A scenario
 * is a few helper calls and one or two `check`s. Between scenarios the sheet
 * is wiped (`clean()`), so that the numbers of one do not end up in another.
 *
 * The fourth console's scenarios (15–21: the pinch and the magnifier the hall
 * mirrors, the pointer phrase, the highlighter under the ink, the sheets)
 * read what the hall is TOLD from the server's memory (this process runs the
 * server: `lectureOf`, `inkPageOf`) and what it SHOWS from the student's
 * canvases: two screens showing the same region of a page show the same ink
 * at the same fractions of their frames (`inkBoxExpr`).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WS from 'ws'

const HEADED = process.argv.includes('--headed')
const SHOT = process.argv.includes('--shot')
// The ports can be overridden by the environment, to debug the harness itself
// while the builder runs the full pass on the standard ones.
const PORT = Number(process.env.PENCIL_CHECK_PORT ?? 3897)
const CDP_PORT = Number(process.env.PENCIL_CHECK_CDP ?? 9337)
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/*
 * Tablet geometries. All three: an 11" iPad in landscape, 12.9" and 11" in
 * portrait. The console was drawn for the first and drowned on the other
 * two, and checking it on one means checking half of it. `--size=` leaves
 * one, for debugging the harness itself.
 */
const sizeArg = process.argv.find((a) => a.startsWith('--size='))?.slice(7)
const ALL_SIZES: [number, number][] = [
  [1180, 820],
  [1366, 1024],
  [834, 1194],
]
const SIZES: [number, number][] = (() => {
  const m = /^(\d+)x(\d+)$/.exec(sizeArg ?? '')
  return m ? [[+m[1], +m[2]]] : ALL_SIZES
})()

const root = mkdtempSync(path.join(tmpdir(), 'colloq-pencil-'))
const ROOM = 'pencil1'

/* ------------------------------------------------------- a small PDF */

/**
 * A real three-page PDF, the same as in ui-check: no dependencies. The pages
 * are 16:9 (960×540), like slides: the layout thresholds in §8.11 ("top
 * ≤24 px, width ≥80 % of the box") are written for a slide, and an A4
 * portrait would not satisfy them on any tablet, however hard the console
 * tried.
 */
function samplePdf(pages = 3): string {
  const obj = (n: number, body: string) => `${n} 0 obj\n${body}\nendobj\n`
  const font = 3 + pages * 2
  const parts = [obj(1, '<< /Type /Catalog /Pages 2 0 R >>')]
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')
  parts.push(obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`))
  for (let i = 0; i < pages; i += 1) {
    const stream = `BT /F1 48 Tf 72 440 Td (Stranica ${i + 1}) Tj ET`
    parts.push(
      obj(
        3 + i * 2,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      ),
      obj(4 + i * 2, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
    )
  }
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
writeFileSync(path.join(root, 'workspace', ROOM, 'lecture.pdf'), samplePdf(), 'latin1')

/* ---------------------------------------------------------------- server */

process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
process.env.SESSION_SECRET = 'pencil-check'
process.env.PORT = String(PORT)
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`
// There is no kernel, and none is needed: the harness is about the pen, not about Python.
process.env.JUPYTER_URL = 'http://127.0.0.1:1'
process.env.NODE_ENV = 'test'
process.env.KERNEL_BACKEND = 'test'
process.env.KERNEL_ISOLATION = 'off'
// A build elsewhere can be checked without touching web/dist: several
// agents and the owner's own `make dev` share one tree.
process.env.STATIC_DIR = process.env.CHECK_STATIC_DIR ?? path.resolve('web/dist')
process.env.OPENAI_API_KEY = 'pencil-check-not-a-real-key'
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1'

await import('../server/src/index.js')
const { createSession } = await import('../server/src/db.js')
const { createTeacher } = await import('../server/src/admin/store.js')
const { issueStaffCookie } = await import('../server/src/admin/auth.js')
const { STAFF_COOKIE } = await import('../shared/admin.js')
/*
 * The server runs in this very process, so what the hall is TOLD (the
 * lecture's page, zoom and sheets, the strokes it keeps) is read straight
 * from its memory, as lecture-sync-check reads the page. What the hall SHOWS
 * is still measured on the student's screen.
 */
const { lectureOf, inkPageOf } = await import('../server/src/lecture.js')
await new Promise((r) => setTimeout(r, 700))
createSession(ROOM, 'Стенд пера', null)
const teacher = createTeacher({ name: 'Ада', email: 'ada@pencil.local', role: 'owner' })!
let cookieValue = ''
issueStaffCookie({ cookie: (_n: string, v: string) => (cookieValue = v) } as never, teacher)

/* ---------------------------------------------------------------- browser */

const chrome = spawn(
  CHROME,
  [
    ...(HEADED ? [] : ['--headless=new']),
    '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(root, 'chrome')}`,
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const cdp = `http://127.0.0.1:${CDP_PORT}`
let up = false
let browserWsUrl = ''
for (let i = 0; i < 80; i += 1) {
  try {
    const res = await fetch(`${cdp}/json/version`)
    if (res.ok) {
      browserWsUrl = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
      up = true
      break
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error(`Chrome did not open the debugging port. Is it even at this path?\n  ${CHROME}`)
  chrome.kill()
  process.exit(1)
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A connection to one CDP socket: the browser's or a tab's. */
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

/**
 * A tab. `isolated` means in a separate browser context, with its own
 * localStorage and its own cookies: the student must be a DIFFERENT person,
 * and the identity lies in localStorage, shared across the profile.
 * `ui-check` clears the storage for this and joins again; here it is simpler
 * and more reliable to give the student a context of their own: then the
 * teacher, the console and the student cannot accidentally become one person.
 */
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
    const made = await browser.send('Target.createTarget', { url })
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      trouble.push(
        'console: ' + m.params.args.map((a: any) => a.value ?? a.description ?? a.type).join(' '),
      )
    }
  })
  await link.send('Runtime.enable')
  await link.send('Page.enable')
  await link.send('Network.enable')
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

/** Go through the join screen under this name. */
async function enter(page: Tab, name: string): Promise<void> {
  await wait(3000)
  if (!(await page.js("return !!document.querySelector('input#join-name')"))) return
  await page.js(
    `const i=document.querySelector('input#join-name');` +
      `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;` +
      `set.call(i,${JSON.stringify(name)}); i.dispatchEvent(new Event('input',{bubbles:true})); return 1`,
  )
  await wait(300)
  // The join button speaks the room's language: "Войти на занятие" on a Russian
  // instance, "Join…" on an English one. Matching only /join/ left the stand at
  // the door after the strings were translated.
  await page.js(
    "const b=[...document.querySelectorAll('button')].find(x=>/join|войти/i.test(x.textContent||'')); b&&b.click(); return 1",
  )
  await wait(3000)
}

async function until(page: Tab, expr: string, what: string, ms = 20000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await page.js(`return ${expr}`)) === true) return true
    await wait(200)
  }
  console.log(`  (gave up waiting: ${what})`)
  return false
}

const results: { ok: boolean; what: string; got: string }[] = []
/** The prefix of the current geometry, so that the report shows WHERE it failed. */
let where = ''
const check = (ok: boolean, what: string, got: unknown) =>
  results.push({ ok, what: where ? `${where} ${what}` : what, got: String(got) })

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

const student = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}`, true)
await enter(student, 'Нина')

check(
  (await host.js('return !document.querySelector("input#join-name")')) === true &&
    (await student.js('return !document.querySelector("input#join-name")')) === true,
  'the teacher and the student joined',
  'yes',
)

await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('lecture.pdf'));` +
    `if(!b) throw new Error('no lecture.pdf row in the tree'); b.click(); return 1`,
)
await until(host, 'document.querySelectorAll("canvas").length === 3', 'the teacher has the pages')
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Лекция');` +
    `if(!b) throw new Error('no "Лекция" button'); b.click(); return 1`,
)
const presenterBar = `[...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`
await until(host, presenterBar, 'the host has the lecture console')
const audience = `(document.body.textContent||'').includes('Лекцию ведёт Ада')`
await until(student, audience, 'the student saw the lecture')
check((await student.js(`return ${audience}`)) === true, 'the lecture is on, the student is in the hall', 'yes')

/* ------------------------------------------------------------ tablet */

/*
 * The names of the console's controls: §7 of the contract, to the letter (the
 * same list is in ui-check).
 */
const PULT = {
  gauge: 'Выбрать страницу',
  pen: 'Перо',
  marker: 'Маркер',
  laser: 'Указка',
  prev: 'Предыдущая страница',
  next: 'Следующая страница',
  undo: 'Отменить последний штрих',
  eraser: 'Ластик',
  red: 'Перо, красное',
  black: 'Перо, чёрное',
  notes: 'Заметки',
  // The magnifier at ×1, and the same key once zoomed: the way back.
  zoom: 'Лупа',
  zoomWhole: 'Весь слайд',
  // "＋ Лист": a sheet right after the page on screen. Back is "Back".
  newSheet: 'Новый лист',
  more: 'Ещё',
  dropSheet: 'Удалить лист',
} as const
const press = (aria: string) =>
  `const b=document.querySelector('[aria-label=${JSON.stringify(aria)}]');` +
  `if(!b) throw new Error('the console has no control "${aria}"'); b.click(); return 1`
const pressed = (aria: string) =>
  `document.querySelector('[aria-label=${JSON.stringify(aria)}]')?.getAttribute('aria-pressed')`

/*
 * The socket wrapper: see the header. It is slipped in before the first
 * navigation and survives reloads: `addScriptToEvaluateOnNewDocument` fires
 * on every new document of this tab.
 */
const SOCKET_HOOK =
  `(()=>{const Real=window.WebSocket;window.__sockets=[];` +
  `function Hooked(url,protocols){const s=protocols===undefined?new Real(url):new Real(url,protocols);window.__sockets.push(s);return s}` +
  `Hooked.prototype=Real.prototype;Object.setPrototypeOf(Hooked,Real);` +
  `for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) Hooked[k]=Real[k];` +
  `window.WebSocket=Hooked})()`
/** The console's live control socket: open and with `/control/` in its URL (the page has others too). */
const liveSocket = `[...(window.__sockets||[])].reverse().find(s=>s.readyState===1&&/\\/control\\//.test(s.url))`
/** The mute wire: whatever the console sends goes nowhere; there will be no echo. */
const mute = () =>
  pult.js(
    `const s=${liveSocket}; if(!s) throw new Error('no live socket'); s.send=()=>{}; return 1`,
  )
const unmute = () => pult.js(`for(const s of window.__sockets||[]) delete s.send; return 1`)
/**
 * A drop: ALL live sockets are closed, as when the network is gone. Cutting
 * only the control one is not enough: the console takes "no connection" from
 * `session.connected`, and that is the status of the Yjs provider, another
 * socket of the same window.
 */
const cut = () =>
  pult.js(
    `const open=(window.__sockets||[]).filter(s=>s.readyState===1);if(!open.length) throw new Error('no live sockets');` +
      `for(const s of open) s.close(); return open.map(s=>s.url.replace(/\\?.*$/,'').replace(/^ws:\\/\\/[^/]+/,''))`,
  )

const pult = await tab('about:blank')
await pult.send('Page.addScriptToEvaluateOnNewDocument', { source: SOCKET_HOOK })

/*
 * The emulation is set BEFORE navigation: the console measures the window at
 * startup, and a tab that got the tablet geometry with the sheet already open
 * would show a layout recomputed on the fly, while on an iPad it is drawn from
 * scratch.
 */
async function tablet(width: number, height: number): Promise<void> {
  await pult.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await pult.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
}
/** The sheet is drawn and the input layer is in place. */
const READY =
  `!!document.querySelector('.ink-input') && !!document.querySelector('canvas.ink-live') &&` +
  `(document.querySelector('canvas.ink-wet')?.getBoundingClientRect().width||0)>200`
async function open(width: number, height: number): Promise<boolean> {
  await tablet(width, height)
  await pult.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/s/${ROOM}/pult` })
  await pult.send('Page.bringToFront')
  const ok = await until(pult, READY, 'the console drew the sheet')
  await wait(400)
  /*
   * The lecture is already on, and the console was opened by a key: over the
   * sheet lies the "Tap to take the console" cover (§5): full screen can only
   * be requested from a live gesture. We lift it with a real touch, like a
   * finger: otherwise the harness's very first stroke goes into the cover,
   * not into the ink layer.
   */
  const bed = (await pult.js(
    `const b=document.querySelector('[aria-label="Коснуться и начать"]');if(!b) return null;` +
      `const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}`,
  )) as { x: number; y: number } | null
  if (bed) {
    await pult.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: bed.x, y: bed.y, id: 950 }],
    })
    await wait(60)
    await pult.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await until(
      pult,
      `!document.querySelector('[aria-label="Коснуться и начать"]')`,
      'the first-touch cover is gone',
      4000,
    )
    await wait(300)
  }
  /*
   * Every geometry starts where the first one did: slide 1, the whole page,
   * no sheets. The server keeps all three across a reopened console, and a
   * scenario that failed half-way must cost its own check, not every check
   * of the next geometry (`wholePage`, `noSheets`).
   */
  if (ok) {
    await wholePage()
    await noSheets()
    for (let i = 0; i < 4 && hallPage() > 1; i += 1) {
      await pult.js(press(PULT.prev))
      await untilHere(() => hallPage() === 1, 'the hall is back on slide 1', 3000)
    }
  }
  return ok
}

/* ------------------------------------------------------------ helpers */

/**
 * The sheet geometry: the ink canvas, the sheet box with margins, the rail, in
 * the window's CSS pixels. It is read again before every scenario: the sheet
 * may move.
 */
interface Rect {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
}
interface Geometry {
  canvas: Rect
  sheet: Rect
  rail: Rect | null
  input: Rect | null
}
async function geometry(): Promise<Geometry> {
  return pult.js(
    `const r=e=>{if(!e) return null;const b=e.getBoundingClientRect();return {left:b.left,top:b.top,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};` +
      `return {canvas:r(document.querySelector('canvas.ink-wet')),sheet:r(document.querySelector('.pult-sheet')),` +
      `rail:r(document.querySelector('.pult-rail')),input:r(document.querySelector('.ink-input'))}`,
  )
}
/** A canvas point in fractions → window coordinates. */
const onCanvas = (g: Geometry, fx: number, fy: number) => ({
  x: g.canvas.left + g.canvas.width * fx,
  y: g.canvas.top + g.canvas.height * fy,
})
/**
 * A point on the sheet's MARGINS: between the canvas and the edge of the box.
 * A margin is where the input layer lies under the pen: the rest below the
 * sheet in landscape is taken by the notes peek strip, and that is a key, not
 * a margin. So the side margin comes first, and only when there is none (the
 * sheet is full width), the bottom one.
 */
const onMargin = (g: Geometry) => {
  const right = g.sheet.right - g.canvas.right
  const bottom = g.sheet.bottom - g.canvas.bottom
  return right >= 6
    ? { x: g.canvas.right + right / 2, y: g.canvas.top + g.canvas.height * 0.7 }
    : {
        x: g.canvas.left + g.canvas.width * 0.7,
        y: g.canvas.bottom + Math.max(3, Math.min(bottom / 2, 6)),
      }
}
/** The middle of the rail: where the finger goes in the "finger went onto the rail" scenario. */
const onRail = (g: Geometry) =>
  g.rail
    ? { x: g.rail.left + g.rail.width / 2, y: g.rail.top + g.rail.height / 2 }
    : { x: 36, y: g.canvas.top + g.canvas.height / 2 }

/* CDP always has one pen pointer; the palm gets its own ids from 900. */

type Via = 'cdp' | 'dom'
interface StrokeOpts {
  speed?: number
  pressure?: number
  via?: Via
  id?: number
  /** What to do when the pen is halfway through a stroke (the palm lands, a finger taps). */
  midway?: () => Promise<void>
}

/**
 * One stroke with a real pen through points IN THE WINDOW.
 *
 * The points are equally spaced, so that the whole stroke fits into `speed`
 * milliseconds; between two given points intermediate ones are added so that
 * an event arrives about every 8 ms: Pencil gives 240 Hz, but CDP has its own
 * round trip to the browser and cannot manage more often than every eight
 * milliseconds. The pressure changes along an arc: pressed lightly, pushed in
 * the middle, released. The tilt is that of a pen in a right hand.
 */
async function strokeAt(
  px: { x: number; y: number }[],
  { speed = 150, pressure = 0.55, via = 'cdp', id = 1, midway }: StrokeOpts = {},
): Promise<void> {
  const steps = Math.max(px.length, Math.round(speed / 8))
  const path: { x: number; y: number }[] = []
  const total = px.length - 1
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * total
    const k = Math.min(total - 1, Math.floor(t))
    const f = total === 0 ? 0 : t - k
    const a = px[k]
    const b = px[Math.min(total, k + 1)]
    path.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f })
  }
  const dwell = speed / steps
  const force = (i: number) => pressure * (0.6 + 0.4 * Math.sin((Math.PI * i) / steps))
  const pen = (
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
    p: { x: number; y: number },
    i: number,
  ) =>
    via === 'cdp'
      ? pult.send('Input.dispatchMouseEvent', {
          type,
          x: p.x,
          y: p.y,
          button: 'left',
          buttons: type === 'mouseReleased' ? 0 : 1,
          clickCount: 1,
          pointerType: 'pen',
          force: type === 'mouseReleased' ? 0 : force(i),
          tiltX: 22,
          tiltY: -12,
        })
      : pult.js(
          `const t=document.elementFromPoint(${p.x},${p.y})||document.body;` +
            `t.dispatchEvent(new PointerEvent(${JSON.stringify(
              {
                mousePressed: 'pointerdown',
                mouseMoved: 'pointermove',
                mouseReleased: 'pointerup',
              }[type],
            )},{bubbles:true,cancelable:true,pointerId:${id},pointerType:'pen',isPrimary:true,` +
            `buttons:${type === 'mouseReleased' ? 0 : 1},pressure:${type === 'mouseReleased' ? 0 : force(i)},` +
            `tiltX:22,tiltY:-12,clientX:${p.x},clientY:${p.y}})); return 1`,
        )
  await pen('mousePressed', path[0], 0)
  const half = Math.floor(path.length / 2)
  for (let i = 1; i < path.length; i += 1) {
    await wait(dwell)
    await pen('mouseMoved', path[i], i)
    if (i === half && midway) await midway()
  }
  await pen('mouseReleased', path[path.length - 1], steps)
}

/** The same stroke, but the points are in fractions of the canvas. */
async function stroke(points: [number, number][], opts: StrokeOpts = {}): Promise<void> {
  const g = await geometry()
  await strokeAt(
    points.map(([fx, fy]) => onCanvas(g, fx, fy)),
    opts,
  )
}

/**
 * N quick strokes in a row: each is a short slanted line in its own band of
 * the sheet (the bands do not intersect, so that they can be counted
 * separately), 150 ms per stroke and 60 ms to move the pen between them: that
 * is how ticks are written. `between` is called in the pause after the i-th
 * stroke: that is where the palm lands in scenario 4.
 */
function band(i: number, n: number): [number, number] {
  const h = 0.6 / n
  return [0.2 + h * i, 0.2 + h * (i + 1)]
}
const bands = (n: number) => Array.from({ length: n }, (_, i) => band(i, n))
async function rapidStrokes(
  n: number,
  opts: StrokeOpts = {},
  between?: (i: number) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const [top, bottom] = band(i, n)
    const mid = (top + bottom) / 2
    await stroke(
      [
        [0.15, mid + (bottom - top) * 0.3],
        [0.35, top + (bottom - top) * 0.15],
        [0.55, mid],
      ],
      { speed: 150, ...opts },
    )
    if (i < n - 1) {
      await wait(30)
      if (between) await between(i)
      await wait(30)
    }
  }
}

/**
 * The palm. Two contacts are the heel (a large patch) and the little finger (a
 * small one), one is the heel only. `via: 'cdp'` is a real touch, `via:
 * 'dom'` is synthetic, see the file header. The heel lies where a writing
 * right hand puts it: below and to the right of where one writes.
 */
interface Contact {
  id: number
  x: number
  y: number
  r: number
}
const palm = {
  via: 'cdp' as Via,
  contacts: [] as Contact[],
  async down(
    at: { x: number; y: number },
    { contacts = 2, via = 'cdp' as Via } = {},
  ): Promise<void> {
    this.via = via
    this.contacts = [{ id: 901, x: at.x, y: at.y, r: 28 }]
    if (contacts === 2) this.contacts.push({ id: 902, x: at.x - 34, y: at.y - 46, r: 9 })
    if (via === 'cdp') {
      await pult.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: this.contacts.map((c) => ({
          x: c.x,
          y: c.y,
          id: c.id,
          radiusX: c.r,
          radiusY: c.r * 1.4,
        })),
      })
    } else {
      for (const [i, c] of this.contacts.entries()) await this.dom('pointerdown', c, i === 0)
    }
  },
  /** Palm drift: the whole hand moves together. */
  async move(dx: number, dy: number, steps = 6): Promise<void> {
    for (let s = 1; s <= steps; s += 1) {
      for (const c of this.contacts) {
        c.x += dx / steps
        c.y += dy / steps
      }
      if (this.via === 'cdp') {
        await pult.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: this.contacts.map((c) => ({
            x: c.x,
            y: c.y,
            id: c.id,
            radiusX: c.r,
            radiusY: c.r * 1.4,
          })),
        })
      } else {
        for (const [i, c] of this.contacts.entries()) await this.dom('pointermove', c, i === 0)
      }
      await wait(30)
    }
  },
  async up(): Promise<void> {
    if (this.via === 'cdp') {
      await pult.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      for (const [i, c] of this.contacts.entries()) await this.dom('pointerup', c, i === 0)
    }
    this.contacts = []
  },
  dom(type: string, c: Contact, primary: boolean): Promise<unknown> {
    return pult.js(
      `const t=document.elementFromPoint(${c.x},${c.y})||document.body;` +
        `t.dispatchEvent(new PointerEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,` +
        `pointerId:${c.id},pointerType:'touch',isPrimary:${primary},buttons:${type === 'pointerup' ? 0 : 1},` +
        `pressure:${type === 'pointerup' ? 0 : 1},width:${c.r * 2},height:${c.r * 2.8},` +
        `clientX:${c.x},clientY:${c.y}})); return 1`,
    )
  },
}

/**
 * Two fingers: a tap. `via: 'cdp'` is a real two-point touch (without a pen at
 * that moment Chrome does not cancel it), `via: 'dom'` is synthetic, for when
 * the pen is on the sheet. 80 ms between down and up, no movement: that is
 * what makes it a tap.
 */
async function twoFingerTap(at: { x: number; y: number }, via: Via = 'cdp'): Promise<void> {
  const pts: Contact[] = [
    { id: 911, x: at.x, y: at.y, r: 10 },
    { id: 912, x: at.x + 56, y: at.y + 4, r: 10 },
  ]
  if (via === 'cdp') {
    await pult.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: pts.map((c) => ({ x: c.x, y: c.y, id: c.id, radiusX: c.r, radiusY: c.r })),
    })
    await wait(80)
    await pult.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    for (const [i, c] of pts.entries()) await palm.dom('pointerdown', c, i === 0)
    await wait(80)
    for (const [i, c] of pts.entries()) await palm.dom('pointerup', c, i === 0)
  }
}

/**
 * What is on the screen. Everything that can be counted rather than seen:
 *  - ink pixels on the dry, wet and live canvases (and by band),
 *  - red ones (the pointer) there too; by contract §3 it lives on `ink-live`,
 *  - the page number in the hall and in the gauge,
 *  - the selection on the console,
 *  - the sheet shift (a transform on `.pult-sheet` or its children).
 */
const inkExpr = (cls: string, bands: [number, number][]) =>
  `(()=>{const c=document.querySelector('canvas.${cls}');if(!c||!c.width) return {all:-1,red:-1,any:-1,bands:[]};` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;const W=c.width,H=c.height;` +
  `const bands=${JSON.stringify(bands)};const per=bands.map(()=>0);let all=0,red=0,any=0;` +
  `for(let i=0;i<d.length;i+=4){const a=d[i+3];if(a<=16) continue;any+=1;` +
  `const isRed=a>24&&d[i]>150&&d[i+1]<120;if(isRed) red+=1;else all+=1;` +
  `if(!isRed){const y=((i/4)/W|0)/H;for(let b=0;b<bands.length;b+=1) if(y>=bands[b][0]&&y<bands[b][1]) per[b]+=1}}` +
  `return {all,red,any,bands:per}})()`
/** The page number in the hall: "на стр. N" in the header or "N / M" in the reader. */
const hallExpr =
  `(()=>{const t=document.body.innerText||'';` +
  `const m=/на стр\\. (\\d+)/.exec(t)||/(?:^|\\n)\\s*(\\d+)\\s*\\/\\s*\\d+\\s*(?:\\n|$)/.exec(t);return m?m[1]:''})()`
interface Ink {
  all: number
  red: number
  any: number
  bands: number[]
}
interface Measure {
  wet: Ink
  dry: Ink
  live: Ink
  selection: number
  ranges: number
  shift: number
  gauge: string
  student: { dry: Ink; wet: Ink; live: Ink }
  hall: string
}
async function measure(bands: [number, number][] = []): Promise<Measure> {
  const onPult = await pult.js(
    `const wet=${inkExpr('ink-wet', bands)};const dry=${inkExpr('ink-dry', bands)};const live=${inkExpr('ink-live', bands)};` +
      `const sel=document.getSelection();` +
      `const sheet=document.querySelector('.pult-sheet');` +
      `const tx=e=>{const m=getComputedStyle(e).transform;const k=/matrix\\(([^)]+)\\)/.exec(m);return k?Math.abs(Math.round(parseFloat(k[1].split(',')[4]))):0};` +
      `const shift=sheet?tx(sheet):0;` +
      `const g=document.querySelector('[aria-label=${JSON.stringify(PULT.gauge)}]');` +
      `const gauge=(/\\d+/.exec(((g&&(g.innerText||g.textContent))||'').replace(/\\s+/g,' '))||[''])[0];` +
      `return {wet,dry,live,selection:sel?sel.toString().length:0,ranges:sel?sel.rangeCount:0,shift,gauge}`,
  )
  const atStudent = await student.js(
    `return {dry:${inkExpr('ink-dry', bands)},wet:${inkExpr('ink-wet', bands)},live:${inkExpr('ink-live', bands)}}`,
  )
  const hall = await student.js(`return ${hallExpr}`)
  return { ...onPult, student: atStudent, hall }
}
/** Red at the student's, wherever their layer draws the pointer: the live canvas or the wet one. */
const redAtStudent = (m: Measure) =>
  Math.max(0, m.student.live.red) + Math.max(0, m.student.wet.red)
/** The ink of a band on the console, wet plus dry: a stroke lives on one of the two. */
const pultBands = (m: Measure) => m.wet.bands.map((w, i) => w + m.dry.bands[i])

/** Wipe the ink for the whole room and wait until it disappears everywhere. */
async function clean(): Promise<void> {
  /*
   * "Erase" on the laptop bar asks first ("Стереть всё?") and erases on the
   * second press. With one press the sheet was never wiped, and every
   * scenario after the first measured the ink of the ones before it.
   */
  await host.js(
    `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Стереть'); b&&b.click(); return 1`,
  )
  await wait(80)
  await host.js(
    `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Стереть всё?'); b&&b.click(); return 1`,
  )
  const empty = (cls: string) => `${inkExpr(cls, [])}.all <= 0`
  // The highlighter has a canvas of its own, under the pen ink (`ink-mark`).
  await until(student, `${empty('ink-dry')} && ${empty('ink-mark')}`, 'the ink was wiped for the student', 8000)
  await until(
    pult,
    `${empty('ink-dry')} && ${empty('ink-wet')} && ${empty('ink-mark')}`,
    'the ink was wiped on the console',
    8000,
  )
  await wait(300)
}

/** Wait until the echo of all strokes reaches the student: the dry canvas stops changing. */
async function settled(bands: [number, number][]): Promise<void> {
  let last = ''
  for (let i = 0; i < 20; i += 1) {
    await wait(350)
    const now = JSON.stringify((await student.js(`return ${inkExpr('ink-dry', bands)}`)).bands)
    if (now === last && now !== '[]') return
    last = now
  }
}

/** The pen is over the sheet but not pressing: Pencil hovers. CDP sends that as mouseMoved without buttons. */
const hover = (p: { x: number; y: number }) =>
  pult.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: p.x,
    y: p.y,
    button: 'none',
    buttons: 0,
    pointerType: 'pen',
  })

/**
 * A key on the console's keyboard, for turning pages while writing (the palm
 * does not press keys).
 *
 * `dom` is the standard name, and it is NOT always equal to `key`: for the
 * arrows and Escape the fields match, but for the letter `z` the key code is
 * `KeyZ`. The console parses letters precisely by `code` (the Russian layout
 * gives "я", "и", "д" in `key`), so `code: 'z'` is a key the console will
 * never hear, that is, a mute fallback in the check.
 */
async function key(name: string, code: number, dom = name): Promise<void> {
  for (const type of ['keyDown', 'keyUp'] as const) {
    await pult.send('Input.dispatchKeyEvent', {
      type,
      key: name,
      code: dom,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    })
  }
}

/** Get the pen back: "Pen" takes off both the pointer and the eraser. */
async function penTool(): Promise<void> {
  await pult.js(press(PULT.pen))
  await wait(200)
  // A tap on the ACTIVE pen opens the palette: close it with a tap beside it (the cover), like a finger.
  if (await pult.js(`return !!document.querySelector('[data-pult-palette]')`)) {
    await pult.js(`document.querySelector('[aria-label="Закрыть палитру"]')?.click(); return 1`)
    await wait(200)
    if (await pult.js(`return !!document.querySelector('[data-pult-palette]')`))
      await key('Escape', 27)
    await until(pult, `!document.querySelector('[data-pult-palette]')`, 'the palette closed', 2000)
  }
}

/* ---------------------------------------------- zoom and sheets: readings */

/** "Such a control is on the screen", by its name. */
const named = (aria: string) => `!!document.querySelector('[aria-label=${JSON.stringify(aria)}]')`

/** Wait for what the harness itself can see: the server's memory, or a value it computes. */
async function untilHere(test: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await test()) return true
    await wait(100)
  }
  console.log(`  (gave up waiting: ${what})`)
  return false
}

interface Zoom {
  x: number
  y: number
  z: number
}
/** The zoom the server holds: what every screen of the hall is told to show. `null` is the whole page. */
const hallZoom = (): Zoom | null => lectureOf(ROOM)?.zoom ?? null
const zoomWords = (zoom: Zoom | null): string => (zoom ? `${zoom.x} ${zoom.y} ${zoom.z}` : 'whole page')
/** The console's own view, as `.pult-sheet` marks it (`data-pult-zoom`); `null` at the whole page. */
const pultZoom = (): Promise<string | null> =>
  pult.js(`return document.querySelector('.pult-sheet')?.getAttribute('data-pult-zoom') ?? null`)
/** The console and the server agree on one zoom, the one `test` wants. */
const zoomAgreed = async (test: (zoom: Zoom | null) => boolean): Promise<boolean> => {
  const zoom = hallZoom()
  return test(zoom) && (await pultZoom()) === (zoom ? zoomWords(zoom) : null)
}
/** A zoom as the magnifier key writes it: "×2,5", "×2", one decimal, the Russian comma. */
const times = (z: number): string => `×${String(Math.round(z * 10) / 10).replace('.', ',')}`

/**
 * Back to the whole page by the console's own key, "0", and the server must
 * agree. Every geometry starts there: the server keeps the zoom across a
 * reconnect and a reopened console adopts it, so a scenario that failed
 * half-way would otherwise hand the next geometry a magnified sheet, and
 * every stroke there would land somewhere else.
 */
async function wholePage(): Promise<boolean> {
  if (await zoomAgreed((zoom) => zoom === null)) return true
  await key('0', 48, 'Digit0')
  return untilHere(() => zoomAgreed((zoom) => zoom === null), 'the whole page again', 6000)
}

/** The lecture's sheets, as the server lists them, in the order they stand. */
const sheetsNow = () => lectureOf(ROOM)?.sheets ?? []
/** The page the hall is on, by the server's word: a sheet is a negative number. */
const hallPage = () => lectureOf(ROOM)?.page ?? 0

/**
 * Leave the lecture without sheets. The sheets scenario deletes its own
 * through the sheet menu; this is the safety net for one that failed
 * half-way, so that "Next" from slide 1 does not lead the next geometry onto
 * a forgotten sheet. It sends exactly the frame the menu's "Delete" sends,
 * through the console's own socket.
 */
async function noSheets(): Promise<boolean> {
  const left = sheetsNow().map((sheet) => sheet.page)
  if (left.length === 0) return true
  await pult.js(
    `const s=${liveSocket};if(!s) return 0;` +
      `for(const page of ${JSON.stringify(left)}) s.send(JSON.stringify({t:'lecture:sheet',op:'drop',page}));return 1`,
  )
  return untilHere(() => sheetsNow().length === 0, 'the sheets are gone', 6000)
}

/**
 * WHERE THE INK IS, as a box in fractions of the page's frame: the union of
 * the opaque pixels of the given canvases. Every screen fits the page by
 * "contain" and shows the same region of it, so two screens that show the
 * same region show the same strokes at the same fractions of their frames,
 * whatever their sizes. Comparing these boxes is comparing regions: a hall
 * left at the whole page while the console zoomed shows the strokes
 * elsewhere, and smaller.
 *
 * The bitmaps are read, not what is on the glass: during a motion a canvas
 * is moved by CSS until the view rests and it is repainted. So the boxes are
 * compared at rest, polled until they agree.
 */
interface Frac {
  x0: number
  y0: number
  x1: number
  y1: number
}
const inkBoxExpr = (classes: string[]) =>
  `(()=>{let box=null;for(const cls of ${JSON.stringify(classes)}){const c=document.querySelector('canvas.'+cls);` +
  `if(!c||c.width<2||c.height<2) continue;const W=c.width,H=c.height;const d=c.getContext('2d').getImageData(0,0,W,H).data;` +
  `let x0=W,y0=H,x1=-1,y1=-1;for(let i=3,p=0;i<d.length;i+=4,p+=1){if(d[i]<=16) continue;const x=p%W,y=(p-x)/W;` +
  `if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y}` +
  `if(x1<0) continue;const b={x0:x0/W,y0:y0/H,x1:(x1+1)/W,y1:(y1+1)/H};` +
  `box=box?{x0:Math.min(box.x0,b.x0),y0:Math.min(box.y0,b.y0),x1:Math.max(box.x1,b.x1),y1:Math.max(box.y1,b.y1)}:b}` +
  `return box})()`
/** The console's ink: its own strokes are wet until the echo, then dry. */
const pultInk = (): Promise<Frac | null> => pult.js(`return ${inkBoxExpr(['ink-dry', 'ink-wet'])}`)
const hallInk = (): Promise<Frac | null> => student.js(`return ${inkBoxExpr(['ink-dry'])}`)
/** A page box as a screen zoomed to `zoom` shows it: the region stretched over the whole frame. */
const zoomedBox = (box: Frac | null, zoom: Zoom | null): Frac | null =>
  box && zoom
    ? {
        x0: (box.x0 - zoom.x) * zoom.z,
        y0: (box.y0 - zoom.y) * zoom.z,
        x1: (box.x1 - zoom.x) * zoom.z,
        y1: (box.y1 - zoom.y) * zoom.z,
      }
    : box
/**
 * The same place to within 1.5 % of the frame: a pixel or two of
 * anti-aliasing on a projector-sized frame, against the 7 % and more that
 * the zooms below (×2.25 and up) move the edges of the landmark, a cross a
 * tenth of the page wide around its middle.
 */
const sameBox = (a: Frac | null, b: Frac | null, slack = 0.015): boolean =>
  !!a &&
  !!b &&
  Math.abs(a.x0 - b.x0) <= slack &&
  Math.abs(a.y0 - b.y0) <= slack &&
  Math.abs(a.x1 - b.x1) <= slack &&
  Math.abs(a.y1 - b.y1) <= slack
const boxWords = (b: Frac | null): string =>
  b ? `${b.x0.toFixed(3)}…${b.x1.toFixed(3)} × ${b.y0.toFixed(3)}…${b.y1.toFixed(3)}` : 'no ink'
/** Read a box until it is what `want` wants (the view settled and was repainted), or give the last one. */
async function boxUntil(
  read: () => Promise<Frac | null>,
  want: (box: Frac | null) => boolean,
  ms = 6000,
): Promise<Frac | null> {
  const deadline = Date.now() + ms
  let last = await read()
  while (!want(last) && Date.now() < deadline) {
    await wait(200)
    last = await read()
  }
  return last
}
/** A box once it stops changing: the echo has landed and the repaint is done. */
async function restingBox(read: () => Promise<Frac | null>, ms = 6000): Promise<Frac | null> {
  const deadline = Date.now() + ms
  let last: Frac | null = null
  while (Date.now() < deadline) {
    await wait(250)
    const now = await read()
    if (now && sameBox(now, last, 0.002)) return now
    last = now
  }
  return last
}

/** A console screenshot under a name, with `--shot`. */
async function shoot(name: string): Promise<void> {
  if (!SHOT) return
  const shot = await pult.send('Page.captureScreenshot', { format: 'png' })
  const file = path.resolve(`pencil-check-${name}.png`)
  writeFileSync(file, Buffer.from(shot.result.data as string, 'base64'))
  console.log(`  screenshot: ${file}`)
}

/**
 * The pointer: a path of points with the pen. It measures by frames: the delay
 * of the first drawn head after the press, frozen frames, head jumps, the
 * worst frame, and that after lifting the beam goes out on the live canvas and
 * does NOT flare up again.
 *
 * The observer lives in the page itself and on every rAF reads the head from
 * `window.__inkLat.head`: what the ink layer drew in its last frame. It used
 * to read the `ink-live` pixels on every frame, but `getImageData` forces the
 * browser to rasterize the canvas immediately, and on the harness's software
 * raster (Chrome without a GPU, double pixel) that cost 100–700 ms: the first
 * pixel was "late" because of its own read, and the worst frame was the frame
 * of the polling itself. Pixels are read twice: once on the first head (that
 * the red really landed on the canvas), and after lifting, where all that
 * matters is "is there red or not". The observer catches the input points
 * itself, by intercepting `pointermove` on the document, with a timestamp: a
 * jump is when the head covered noticeably more in a frame than the pen did in
 * the same time.
 *
 * WHY NOT "HEADS ≥ 0.9 × POINTS". The head is drawn once a frame, while at a
 * `stepMs` of a few ms the points arrive more often than frames: at 60 Hz
 * forty points take ten to twenty frames, and they cannot be compared one by
 * one. What is measured is a stall: a frame during which the pen moved and the
 * head did not. There are at most a fifth of those (the threshold: see
 * scenario 8).
 */
async function laserHold(points: [number, number][], stepMs = 4) {
  const g = await geometry()
  const px = points.map(([fx, fy]) => onCanvas(g, fx, fy))
  const c = g.canvas
  const xs = px.map((p) => p.x)
  const ys = px.map((p) => p.y)
  const pad = 60
  const box = {
    left: Math.max(0, Math.min(...xs) - c.left - pad),
    top: Math.max(0, Math.min(...ys) - c.top - pad),
    right: Math.min(c.width, Math.max(...xs) - c.left + pad),
    bottom: Math.min(c.height, Math.max(...ys) - c.top + pad),
  }
  await pult.js(
    `const c=document.querySelector('canvas.ink-live');const ctx=c.getContext('2d');` +
      `const cr=c.getBoundingClientRect();const k=c.width/cr.width;` +
      `const bx=Math.floor(${box.left}*k),by=Math.floor(${box.top}*k),bw=Math.ceil((${box.right}-${box.left})*k),bh=Math.ceil((${box.bottom}-${box.top})*k);` +
      `const w={t0:performance.now(),first:-1,firstRed:0,frames:[],inputs:[],release:-1,stop:false};window.__laser=w;` +
      `w.onIn=e=>{if(e.pointerType!=='pen') return;if(e.type==='pointerdown'&&w.downAt===undefined) w.downAt=performance.now()-w.t0;w.inputs.push({t:performance.now()-w.t0,x:e.clientX-cr.left,y:e.clientY-cr.top})};` +
      `document.addEventListener('pointerdown',w.onIn,true);document.addEventListener('pointermove',w.onIn,true);` +
      `const red=()=>{const d=ctx.getImageData(bx,by,bw,bh).data;let any=0;for(let y=0;y<bh;y+=4)for(let x=0;x<bw;x+=4){const i=(y*bw+x)*4;` +
      `if(d[i+3]>24&&d[i]>150&&d[i+1]<120) any+=1}return any};` +
      `const tick=()=>{if(w.stop){document.removeEventListener('pointerdown',w.onIn,true);document.removeEventListener('pointermove',w.onIn,true);return}` +
      `const t=performance.now();const head=window.__inkLat&&window.__inkLat.head;` +
      `const f={t:t-w.t0,any:head?1:0};` +
      `if(head){if(w.first<0){w.first=t-w.t0;w.paintedAt=head.at-w.t0;w.firstRed=red()}f.x=head.x;f.y=head.y}` +
      `else if(w.release>=0) f.any=red();` +
      `w.frames.push(f);requestAnimationFrame(tick)};requestAnimationFrame(tick);return 1`,
  )
  const pen = (type: string, p: { x: number; y: number }) =>
    pult.send('Input.dispatchMouseEvent', {
      type,
      x: p.x,
      y: p.y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      pointerType: 'pen',
      force: type === 'mouseReleased' ? 0 : 0.5,
    })
  // The observer's zero is the moment of the press: set it right before the dispatch.
  await pult.js(`window.__laser.t0=performance.now(); return 1`)
  await pen('mousePressed', px[0])
  for (let i = 1; i < px.length; i += 1) {
    await wait(stepMs)
    await pen('mouseMoved', px[i])
  }
  await wait(120)
  await pult.js(`window.__laser.release=performance.now()-window.__laser.t0; return 1`)
  await pen('mouseReleased', px[px.length - 1])
  /*
   * After lifting, watch until the end of the shape's life and a little past
   * it: a shape is a phrase of one press, which holds for PHRASE_HOLD_MS after
   * its last lift and fades over PHRASE_FADE_MS (1500 + 600 in laser.ts), so
   * it is dark by 2.1 s. All that time and 600 ms after it, it must not flare
   * up again: hovering no longer picks it up.
   */
  await wait(2800)
  const raw = (await pult.js(`window.__laser.stop=true; return window.__laser`)) as {
    first: number
    firstRed: number
    downAt?: number
    paintedAt?: number
    release: number
    frames: { t: number; any: number; x?: number; y?: number }[]
    inputs: { t: number; x: number; y: number }[]
  }
  const active = raw.frames.filter((f) => f.t <= raw.release)
  // The pen's path between two moments in time.
  const travelled = (from: number, to: number) => {
    let s = 0
    for (let i = 1; i < raw.inputs.length; i += 1) {
      const a = raw.inputs[i - 1]
      const b = raw.inputs[i]
      if (b.t > from && b.t <= to) s += Math.hypot(b.x - a.x, b.y - a.y)
    }
    return s
  }
  let heads = 0
  let stalls = 0
  let moving = 0
  let jumps = 0
  let longest = 0
  let prev: { t: number; x: number; y: number } | null = null
  for (const f of active) {
    if (f.x === undefined || f.y === undefined) continue
    heads += 1
    if (prev) {
      const d = Math.hypot(f.x - prev.x, f.y - prev.y)
      const l = travelled(prev.t, f.t)
      if (l >= 1) {
        moving += 1
        if (d < 0.5) stalls += 1
      }
      longest = Math.max(longest, d)
      if (d > 2 * l + 6) jumps += 1
    }
    prev = { t: f.t, x: f.x, y: f.y }
  }
  /*
   * The head landed IN THE HANDLER of the press, not in the next frame: the
   * moment of drawing is earlier than the observer's first frame after the
   * press arrived. Measuring this way is more honest than in milliseconds: on
   * the harness the same busy processor stretches both the handler and the
   * frame, but it does not change the order.
   */
  const firstTickAfterDown =
    raw.downAt === undefined ? undefined : raw.frames.find((f) => f.t > raw.downAt!)?.t
  const paintedInHandler =
    raw.paintedAt !== undefined &&
    (firstTickAfterDown === undefined || raw.paintedAt <= firstTickAfterDown)
  const stamps = active.map((f) => f.t)
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i])
  const frameMs = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0
  const worstFrame = gaps.length ? Math.max(...gaps) : 0
  const slowFrames = gaps.filter((gap) => gap > 34).length
  // After lifting: the first frame with no red at all, and whether it flared up after it.
  const after = raw.frames.filter((f) => f.t > raw.release)
  const offAt = after.find((f) => f.any === 0)
  const relit = offAt
    ? after.some((f) => f.t > offAt.t && f.t <= offAt.t + 600 && f.any > 0)
    : false
  return {
    // A head the layer considers drawn while the canvas has no red is not a first pixel.
    firstPixelMs: raw.firstRed > 0 ? Math.round(raw.first) : -1,
    /** From the press arriving in the page to the call that draws the head: the console's share of the delay. */
    paintLagMs:
      raw.downAt !== undefined && raw.paintedAt !== undefined
        ? Math.round(raw.paintedAt - raw.downAt)
        : -1,
    paintedInHandler,
    heads,
    inputs: raw.inputs.length,
    frames: active.length,
    stalls,
    moving,
    jumps,
    longestJump: Math.round(longest * 10) / 10,
    frameMs: Math.round(frameMs * 10) / 10,
    worstFrame: Math.round(worstFrame),
    slowFrames,
    frameGaps: gaps.length,
    offAfterMs: offAt ? Math.round(offAt.t - raw.release) : -1,
    relit,
  }
}

/* ================================================================ the run */

/**
 * The scenarios that depend on geometry run on all three tablets; those about
 * the wire and the load (12–14) run once: the sheet there is the same, but the
 * minutes of the run are not.
 */
/* ================================================================ review */

/*
 * `--razbor` runs the reviewer's scenarios: not "does what was fixed work"
 * but "what else breaks if you hold the tablet like a person". The palm
 * BEFORE the pen on the rail and on the peek strip, the palm on the eraser
 * key, the palette under the first stroke, the palm with the pointer, two
 * fingers after a long stroke, the notes field under the heel of the palm in
 * portrait. The regular run does not run them: some of them are known
 * failures, and until they are fixed, they would color the whole run.
 */
const RAZBOR = process.argv.includes('--razbor')

/** The center of a control by aria-label, in the window. */
async function center(aria: string): Promise<{ x: number; y: number }> {
  return pult.js(
    `const b=document.querySelector('[aria-label=${JSON.stringify(aria)}]');if(!b) throw new Error('no "${aria}"');` +
      `const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}`,
  )
}
/** A short real tap with a finger/palm: down, a pause, up. */
async function tap(at: { x: number; y: number }, holdMs = 120, r = 28): Promise<void> {
  await pult.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: at.x, y: at.y, id: 931, radiusX: r, radiusY: r * 1.4 }],
  })
  await wait(holdMs)
  await pult.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
const notesSheetOpen = () =>
  pult.js(`return document.querySelector('[aria-label="Заметки"]')?.getAttribute('aria-pressed')`)
const toolPressed = async () =>
  pult.js(
    `return [...document.querySelectorAll('[aria-pressed="true"]')].map(b=>b.getAttribute('aria-label')).join(',')`,
  )

if (RAZBOR) {
  if (!process.env.RAZBOR_PORTRAIT) {
  where = '[1180×820]'
  const opened = await open(1180, 820)
  check(opened, 'review: the console is open', opened)
  await penTool()
  // Warm-up: the first pen turns off the finger.
  await stroke([[0.2, 0.3], [0.5, 0.32]], { speed: 120 })
  await wait(400)
  await clean()

  /* R1. five quick strokes, 30 ms pauses, a two-contact palm drifts 20 px between them */
  {
    const g = await geometry()
    const b5 = bands(5)
    await palm.down(onCanvas(g, 0.8, 0.9), { contacts: 2, via: 'dom' })
    await wait(300)
    await rapidStrokes(5, { speed: 110 }, async () => {
      await palm.move(6, 20, 2)
    })
    await settled(b5)
    const m = await measure(b5)
    await palm.up()
    check(
      m.student.dry.bands.every((n) => n > 0) && pultBands(m).every((n) => n > 0),
      'R1. five quick strokes under a drifting palm — all five reach the hall',
      `student ${m.student.dry.bands.join(' / ')} · console ${pultBands(m).join(' / ')}`,
    )
    await clean()
  }

  /* R2. a stroke left the sheet box for the rail and came back */
  {
    const g = await geometry()
    const pageBefore = (await measure()).hall
    const railMid = onRail(g)
    await strokeAt(
      [onCanvas(g, 0.25, 0.3), { x: railMid.x, y: onCanvas(g, 0, 0.4).y }, onCanvas(g, 0.3, 0.55)],
      { speed: 400 },
    )
    await settled([[0.5, 0.6]])
    const m = await measure([[0.25, 0.35], [0.5, 0.6]])
    check(
      m.student.dry.bands[0] > 0 && m.student.dry.bands[1] > 0 && m.hall === pageBefore,
      'R2. a stroke that went onto the rail and came back is intact in the hall and turns no page',
      `student: start ${m.student.dry.bands[0]} px, return ${m.student.dry.bands[1]} px · hall ${pageBefore}→${m.hall}`,
    )
    await clean()
  }

  /* R3. the palm lands on the sheet while the pen leads the pointer */
  {
    const g = await geometry()
    await pult.js(press(PULT.laser))
    await wait(200)
    const pen = (type: string, p: { x: number; y: number }) =>
      pult.send('Input.dispatchMouseEvent', {
        type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1, pointerType: 'pen', force: type === 'mouseReleased' ? 0 : 0.5,
      })
    const heel = onCanvas(g, 0.85, 0.9)
    await pen('mousePressed', onCanvas(g, 0.2, 0.3))
    for (let i = 1; i <= 10; i += 1) { await wait(16); await pen('mouseMoved', onCanvas(g, 0.2 + 0.02 * i, 0.3)) }
    await palm.down(heel, { contacts: 1, via: 'dom' })
    await wait(100)
    const jumped = (await pult.js(`return window.__inkLat.head`)) as { x: number; y: number } | null
    for (let i = 11; i <= 30; i += 1) { await wait(16); await pen('mouseMoved', onCanvas(g, 0.2 + 0.02 * i, 0.3)) }
    await wait(150)
    const end = (await pult.js(`return window.__inkLat.head`)) as { x: number; y: number } | null
    const penEnd = { x: g.canvas.width * 0.8, y: g.canvas.height * 0.3 }
    const heelC = { x: g.canvas.width * 0.85, y: g.canvas.height * 0.9 }
    const d = (a: { x: number; y: number } | null, b: { x: number; y: number }) => (a ? Math.round(Math.hypot(a.x - b.x, a.y - b.y)) : -1)
    await pen('mouseReleased', onCanvas(g, 0.8, 0.3))
    await palm.up()
    await wait(300)
    check(
      d(jumped, heelC) > 40 && d(end, penEnd) < 40,
      'R3. a palm under the pointer: the head does not jump to the palm and follows the pen',
      `after the palm the head is ${d(jumped, heelC)} px from the palm; at the end ${d(end, penEnd)} px from the pen`,
    )
    await pult.js(press(PULT.pen))
    await wait(300)
  }

  /* R4. the palm lay on the "Eraser" key while writing and lifted */
  {
    const key = await center(PULT.eraser)
    const b1 = bands(1)
    await stroke([[0.2, 0.4], [0.6, 0.5]], {
      speed: 500,
      midway: async () => {
        const c = { id: 941, x: key.x, y: key.y, r: 26 }
        await palm.dom('pointerdown', c, true)
        await wait(80)
        await palm.dom('pointerup', c, true)
      },
    })
    await wait(300)
    const tools = await toolPressed()
    await settled(b1)
    check(
      !tools.includes('Ластик'),
      'R4. a palm on the eraser key while writing does not change the tool',
      `pressed: ${tools}`,
    )
    await penTool()
    await clean()
  }

  /* R5. the palm BEFORE the pen: a tap on "Forward" and a drift off the rail */
  {
    const pageBefore = (await measure()).hall
    await tap(await center(PULT.next), 250)
    await wait(800)
    const m1 = await measure()
    check(m1.hall === pageBefore, 'R5. a palm (radius 28) on "Forward" before the pen turns no page', `hall ${pageBefore}→${m1.hall}`)
    if (m1.hall !== pageBefore) { await pult.js(press(PULT.prev)); await until(student, `${hallExpr} === '${pageBefore}'`, 'back', 6000) }
    const g = await geometry()
    const spacer = { x: g.rail!.left + 36, y: g.rail!.top + g.rail!.height * 0.62 }
    await palm.down(spacer, { contacts: 1, via: 'dom' })
    await wait(150)
    await stroke([[0.2, 0.5], [0.5, 0.55]], { speed: 300 })
    await palm.move(90, 10, 6)
    await palm.up()
    await wait(800)
    const m2 = await measure()
    check(m2.hall === pageBefore, 'R5. a palm that landed on the rail before the pen and slid onto the sheet turns no page', `hall ${pageBefore}→${m2.hall}`)
    if (m2.hall !== pageBefore) { await pult.js(press(PULT.prev)); await until(student, `${hallExpr} === '${pageBefore}'`, 'back', 6000) }
    await clean()
  }

  /* R6. the notes peek strip under the sheet: the palm and the pen */
  {
    const g = await geometry()
    const under = { x: g.canvas.left + g.canvas.width * 0.6, y: g.canvas.bottom + 40 }
    const what = await pult.js(`const e=document.elementFromPoint(${under.x},${under.y});return e?(e.closest('button')?.getAttribute('aria-label')||e.className):'nothing'`)
    await tap(under, 150)
    await wait(500)
    const open1 = await notesSheetOpen()
    check(open1 !== 'true', 'R6. a palm below the sheet does not open the notes', `under the heel: ${what} · notes aria-pressed=${open1}`)
    if (open1 === 'true') { await pult.js(press(PULT.notes)); await wait(400) }
    await strokeAt([under, onCanvas(g, 0.6, 0.8), onCanvas(g, 0.4, 0.75)], { speed: 300 })
    await wait(1200)
    const m = await measure()
    const open2 = await notesSheetOpen()
    check(m.student.dry.all > 0 && open2 !== 'true', 'R6. a stroke started 40 px below the sheet draws', `student ${m.student.dry.all} px · notes=${open2}`)
    if (open2 === 'true') { await pult.js(press(PULT.notes)); await wait(400) }
    await clean()
  }

  /* R7. the palette is open: the first stroke */
  {
    await pult.js(press(PULT.pen))
    await wait(200)
    const pal = await pult.js(`return !!document.querySelector('[data-pult-palette]')`)
    /*
     * The stroke starts on the sheet BESIDE the palette, not under it: the
     * palette is 304 px wide now, and at 1180×820 a stroke from 20 % of the
     * sheet started on the red pen's chip and picked a colour instead. Its
     * card is pressable and is not the sheet; what this scenario asks is
     * whether the first stroke on the sheet draws while the palette is open.
     */
    const g7 = await geometry()
    const right = (await pult.js(
      `const p=document.querySelector('[data-pult-palette] > *');return p?p.getBoundingClientRect().right:0`,
    )) as number
    const from = Math.min(0.6, Math.max(0.2, (right - g7.canvas.left) / g7.canvas.width + 0.05))
    await stroke([[from, 0.4], [Math.min(0.95, from + 0.35), 0.45]], { speed: 250 })
    await wait(1200)
    const m = await measure()
    const palAfter = await pult.js(`return !!document.querySelector('[data-pult-palette]')`)
    check(pal && m.student.dry.all > 0, 'R7. a stroke with the palette open draws (the palette closes)', `palette was ${pal}, became ${palAfter} · student ${m.student.dry.all} px`)
    await penTool()
    await clean()
  }

  /* R8. two fingers right after a long stroke */
  {
    const g = await geometry()
    const b1 = bands(1)
    await stroke([[0.15, 0.4], [0.35, 0.5], [0.55, 0.42]], { speed: 1300 })
    await wait(120)
    await twoFingerTap(onCanvas(g, 0.75, 0.9), 'dom')
    await wait(1200)
    const m = await measure(b1)
    check(m.student.dry.bands[0] > 0, 'R8. a heel and a little finger landing 120 ms after a long stroke do not undo it', `student ${m.student.dry.bands[0]} px`)
    await clean()
  }

  /* R9. the "Full screen" strip over the top line of the slide */
  {
    const bar = await pult.js(`const b=document.querySelector('[aria-label="Во весь экран"]');if(!b) return null;const r=b.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}`)
    const g = await geometry()
    const overlaps = bar && bar.bottom > g.canvas.top && bar.top < g.canvas.bottom
    await stroke([[0.45, 0.04], [0.55, 0.05]], { speed: 200 })
    await wait(1200)
    const m = await measure()
    check(!overlaps || m.student.dry.all > 0, 'R9. the top of the slide is not covered by the "Full screen" strip', bar ? `strip ${Math.round(bar.top)}–${Math.round(bar.bottom)} px, sheet from ${Math.round(g.canvas.top)} · stroke along the top line: student ${m.student.dry.all} px` : 'no strip')
    await clean()
  }

  /* R10. "Blank": the pen under the blanked projection */
  {
    await pult.js(press('Затемнить проекцию'))
    await wait(600)
    await stroke([[0.2, 0.5], [0.5, 0.55]], { speed: 200 })
    await wait(1200)
    const m = await measure()
    const blank = await pult.js(`return document.querySelector('[aria-label="Вернуть проекцию"]')?.getAttribute('aria-pressed')`)
    check(m.student.dry.all > 0, 'R10. the pen draws under the blanked projection (as the comment promises)', `student ${m.student.dry.all} px · projection ${blank === 'true' ? 'still dark' : 'came back on the stroke'}`)
    if (blank === 'true') { await pult.js(press('Вернуть проекцию')); await wait(300) }
    await clean()
  }

  /* R11. a 60-point pointer: no trace on either the dry or the wet canvas; the pen puts it out */
  {
    await pult.js(press(PULT.laser))
    await wait(200)
    const pts: [number, number][] = Array.from({ length: 60 }, (_, i) => [0.1 + 0.8 * (i / 59), 0.5 + 0.3 * Math.sin((i / 59) * Math.PI * 3)])
    const l = await laserHold(pts, 8)
    await pult.js(press(PULT.pen))
    await wait(500)
    const m = await measure()
    check(l.firstPixelMs >= 0 && m.dry.red === 0 && m.wet.red === 0 && m.student.dry.red === 0 && m.student.wet.red === 0 && m.live.red === 0 && redAtStudent(m) === 0,
      'R11. a 60-point pointer: first pixel, no trace, goes out on the pen',
      `first pixel ${l.firstPixelMs} ms · stalls ${l.stalls}/${l.moving} · jumps ${l.jumps} · worst frame ${l.worstFrame} · trace: dry ${m.dry.red}/${m.student.dry.red}, wet ${m.wet.red}/${m.student.wet.red} · live ${m.live.red}`)
    await penTool()
  }

  /* R12. a stroke during a connection drop */
  {
    const b1 = bands(1)
    await cut()
    await until(pult, `!!document.querySelector('.pult-rail') && document.querySelector('.pult-rail').className.includes('danger')`, 'drop', 4000)
    await rapidStrokes(1)
    const back = await until(pult, `!!(${liveSocket})`, 'reconnected', 15000)
    await wait(2500)
    const m = await measure(b1)
    check(back && m.student.dry.bands[0] > 0 && m.wet.all <= 0, 'R12. a stroke drawn during a drop arrives once connected, the wet one goes out', `student ${m.student.dry.bands[0]} px · wet on the console ${m.wet.all}`)
    await clean()
  }

  /* R13. the finger is off: a finger swipe over the sheet neither draws nor turns pages */
  {
    const g = await geometry()
    const pageBefore = (await measure()).hall
    const from = onCanvas(g, 0.7, 0.5)
    await pult.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 951, radiusX: 12, radiusY: 12 }] })
    for (let i = 1; i <= 8; i += 1) { await wait(20); await pult.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x - 30 * i, y: from.y, id: 951, radiusX: 12, radiusY: 12 }] }) }
    await pult.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await wait(900)
    const m = await measure()
    check(m.hall === pageBefore && m.wet.all <= 0 && m.student.dry.all <= 0 && m.shift === 0, 'R13. the finger is off — a swipe over the sheet does nothing', `hall ${pageBefore}→${m.hall} · wet ${m.wet.all} · student ${m.student.dry.all}`)
  }

  /* R13b. the finger is off + the pointer: the beam FOLLOWS the finger instead of freezing */
  {
    /*
     * R11 leads the pointer with the PEN, R13 moves a finger with the PEN
     * tool, and both are green, while between them lived the most common case
     * in class: the pen in its case, the finger long since turned off by the
     * very first Pencil touch, and people point with a finger. The beam
     * flashed at the touch point and stood there the whole time the finger
     * moved: the hall saw a motionless spot away from where people were
     * pointing, and not a single sign of a breakage.
     */
    await pult.js(press(PULT.laser))
    // The pen goes back into its case: a finger leads the pointer only after
    // the pen has been away from the glass for a moment (InkLayer · mine).
    await wait(2800)
    const g = await geometry()
    const path = Array.from({ length: 11 }, (_, i) => onCanvas(g, 0.75 - 0.45 * (i / 10), 0.5))
    const headX = `const h=window.__inkLat&&window.__inkLat.head;return h?Math.round(h.x):-1`
    const touch = (type: string, at: { x: number; y: number } | null) =>
      pult.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: at ? [{ x: at.x, y: at.y, id: 952, radiusX: 12, radiusY: 12 }] : [],
      })
    await touch('touchStart', path[0])
    await wait(150)
    const lit = Number(await pult.js(headX))
    for (let i = 1; i < path.length; i += 1) {
      await wait(40)
      await touch('touchMove', path[i])
    }
    // The head follows the target on a spring: let it catch up before the finger lifts.
    await wait(400)
    const moved = Number(await pult.js(headX))
    await touch('touchEnd', null)
    await wait(400)
    const shift = lit >= 0 && moved >= 0 ? Math.abs(moved - lit) : 0
    // The pointer leaves no trace: that is already measured by R11; here only the movement is measured.
    check(
      lit >= 0 && shift > g.canvas.width * 0.2,
      'R13b. the finger is off: the pointer follows the finger',
      `head ${lit < 0 ? 'did not light up' : lit} → ${moved < 0 ? 'went out' : moved} · shift ${Math.round(shift)} px for a travel of ${Math.round(g.canvas.width * 0.45)}`,
    )
    await penTool()
    await clean()
  }

  /* R14. selection: long touches on the rail, the gauge, the peek strip */
  {
    const g = await geometry()
    let sel = ''
    for (const [name, at] of [
      ['gauge', await center(PULT.gauge)],
      ['peek', { x: g.canvas.left + g.canvas.width * 0.3, y: g.canvas.bottom + 60 }],
      ['key', await center(PULT.next)],
    ] as const) {
      await tap(at, 1200, 20)
      await wait(200)
      const s = await pult.js(`const s=document.getSelection();return (s?s.toString().length:0)+'/'+(s?s.rangeCount:0)`)
      sel += `${name} ${s} `
    }
    check(!/[1-9]\d*\//.test(sel), 'R14. a long touch selects nothing anywhere', sel.trim())
  }

  }
  /* ---------------------------------------------------------- portrait */
  where = '[834×1194]'
  await open(834, 1194)
  await penTool()
  await clean()

  /* R15. the heel of the palm below the sheet, on the notes field */
  {
    const g = await geometry()
    const ta = await pult.js(`const t=document.querySelector('[data-pult-notes] textarea');if(!t) return null;const r=t.getBoundingClientRect();return {top:r.top,left:r.left,w:r.width,h:r.height}`)
    let what = ''
    let active = ''
    for (const dy of [30, 60, 90]) {
      const under = { x: g.canvas.left + g.canvas.width * 0.7, y: g.canvas.bottom + dy }
      what += `${dy}px→` + (await pult.js(`const e=document.elementFromPoint(${under.x},${under.y});return e?e.tagName:'nothing'`)) + ' '
      await tap(under, 200, 28)
      await wait(400)
      active = await pult.js(`return document.activeElement?.tagName`)
      if (active === 'TEXTAREA') break
    }
    const liveInput = await pult.js(`return document.querySelector('.ink-input')?.className.includes('pointer-events-auto')`)
    await stroke([[0.2, 0.5], [0.5, 0.55]], { speed: 200 })
    await wait(1200)
    const m = await measure()
    check(active !== 'TEXTAREA' && m.student.dry.all > 0, 'R15. portrait: a heel 30 px below the sheet does not move the focus into the notes', `under the heel ${what} · notes field from ${ta ? Math.round(ta.top) : '—'} px (the sheet down to ${Math.round(g.canvas.bottom)}) · focus ${active} · input layer alive: ${liveInput} · stroke at the student ${m.student.dry.all} px`)
    await pult.js(`document.activeElement?.blur(); return 1`)
    await wait(300)
    await clean()
  }

  /* R16. portrait: five strokes with a palm and drift */
  {
    const g = await geometry()
    const b5 = bands(5)
    await palm.down(onCanvas(g, 0.8, 0.9), { contacts: 2, via: 'dom' })
    await wait(300)
    await rapidStrokes(5, { speed: 110 }, async () => { await palm.move(4, 10, 2) })
    await settled(b5)
    const m = await measure(b5)
    await palm.up()
    check(m.student.dry.bands.every((n) => n > 0), 'R16. portrait: five quick strokes under a palm', `student ${m.student.dry.bands.join(' / ')}`)
    await clean()
  }
}

for (const [index, [W, H]] of (RAZBOR ? [] : SIZES).entries()) {
  where = `[${W}×${H}]`
  const opened = await open(W, H)
  check(
    opened,
    'the console is open as a tablet',
    `${W}×${H}@2 · ${await pult.js('return location.pathname')}`,
  )
  if (!opened) continue
  const first = index === 0

  /* ---------------------------------------------- the pen arrives as a pen */

  /*
   * The first thing checked is the harness itself: a PointerEvent on the input
   * layer must arrive with `pointerType === 'pen'`, pressure and tilt.
   * Otherwise everything below measures a mouse, while the complaints are
   * about a pen. Along the way it records whether the event has
   * `getCoalescedEvents` (it exists only in a secure context, and 127.0.0.1 is
   * secure). The warm-up stroke is also the first pen on this screen: by
   * contract §1 the console turns off finger drawing after it.
   */
  await penTool()
  await pult.js(
    `window.__seen=[];document.addEventListener('pointerdown',e=>window.__seen.push({type:e.pointerType,p:+e.pressure.toFixed(2),tilt:e.tiltX,coalesced:typeof e.getCoalescedEvents,target:e.target.className}),true);return 1`,
  )
  await stroke(
    [
      [0.2, 0.3],
      [0.5, 0.32],
    ],
    { speed: 120 },
  )
  const seen = (await pult.js('return window.__seen[0]')) as
    | { type: string; p: number; tilt: number; coalesced: string; target: string }
    | undefined
  check(
    seen?.type === 'pen' && seen.p > 0 && seen.tilt !== 0,
    'the CDP pen reaches the page as a pen',
    seen
      ? `pointerType=${seen.type} pressure=${seen.p} tiltX=${seen.tilt} getCoalescedEvents=${seen.coalesced} → ${seen.target}`
      : 'there was no event',
  )
  const warm = await until(
    student,
    `${inkExpr('ink-dry', [])}.all > 0`,
    'the warm-up stroke reached the student',
    8000,
  )
  check(warm, 'the warm-up stroke is visible at the student', warm ? 'yes' : 'no')
  await wait(300)
  const fingerKey = await pult.js(`return localStorage.getItem('colloq.pult.finger')`)
  check(
    fingerKey === 'off',
    'the first pen turns off finger drawing',
    `colloq.pult.finger=${fingerKey}`,
  )
  await clean()

  /* ------------------------------------- a swipe along the rail turns pages */

  /*
   * A real CDP touch along the rail's LONG side: up the side rail, left
   * along the bottom one is forward, the opposite is back. It used to be
   * measured across the rail (72 px wide on the side, 64 px tall at the
   * bottom) with a 64 px threshold, so the gesture fired only edge to edge in
   * landscape and never in portrait. The finger travels 120 px and lifts
   * inside the rail.
   */
  {
    const rail = (await geometry()).rail
    const swipeRail = async (dir: 1 | -1): Promise<void> => {
      if (!rail) return
      const across = rail.width > rail.height
      const from = across
        ? { x: rail.left + rail.width * 0.55, y: rail.top + rail.height / 2 }
        : { x: rail.left + rail.width / 2, y: rail.top + rail.height * 0.55 }
      const point = (i: number) => {
        const d = (120 * i * dir) / 8
        return across ? { x: from.x - d, y: from.y } : { x: from.x, y: from.y - d }
      }
      await pult.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...from, id: 961, radiusX: 10, radiusY: 10 }],
      })
      for (let i = 1; i <= 8; i += 1) {
        await wait(20)
        await pult.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...point(i), id: 961, radiusX: 10, radiusY: 10 }],
        })
      }
      await pult.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    const before = (await measure()).hall
    await swipeRail(1)
    const forward = await until(student, `${hallExpr} === '2'`, 'the rail swipe turned forward', 6000)
    const gaugeFwd = (await measure()).gauge
    await swipeRail(-1)
    const back = await until(student, `${hallExpr} === '1'`, 'the rail swipe turned back', 6000)
    check(
      rail !== null && before === '1' && forward && back,
      'a swipe along the rail turns the page forward and back',
      `rail ${rail ? `${Math.round(rail.width)}×${Math.round(rail.height)}` : '—'} · hall ${before} → ${forward ? '2' : 'stayed'} (gauge ${gaugeFwd || '—'}) → ${back ? '1' : 'stayed'}`,
    )
    if (!back) {
      await pult.js(press(PULT.prev))
      await until(student, `${hallExpr} === '1'`, 'the hall is back on the first', 8000)
    }
    // The click a moved finger's lift may produce is swallowed for half a
    // second; a scripted `.click()` has no press of its own to clear that.
    await wait(700)
  }

  /* ------------------------------------------ "next" is always somewhere */

  /*
   * "Next": in landscape the next item's tile in the strip under the slide
   * (board 06: the slide's thumbnail, captioned "2 · дальше"), and, with the
   * notes column open, the column's footer in words as well; in portrait the
   * dock's footer says it in words, after the ribbon of chips (board 08), and
   * there is no picture to demand. Visible, inside the window, off the rail
   * and clear of "Fullscreen".
   *
   * The tile used to be a picture with nothing pressable in it. It is a page
   * of the strip now, like every other tile, and a tap on it goes there: that
   * is checked too, and the hall must follow.
   */
  {
    const NEXT_TILE = '[data-pult-film] [data-pult-next]'
    const nextBox = (selector: string) =>
      pult.js(
        `const n=document.querySelector(${JSON.stringify(selector)});if(!n) return null;const r=n.getBoundingClientRect();` +
          `const over=e=>{if(!e) return false;const o=e.getBoundingClientRect();return r.left<o.right&&r.right>o.left&&r.top<o.bottom&&r.bottom>o.top};` +
          `const fs=document.querySelector('.pult-sheet [aria-label="Во весь экран"]');const c=n.querySelector('canvas');` +
          // The words, without the ribbon's chips: "ДАЛЬШЕ Stranica 2 · затем 3".
          `const words=[...n.children].filter(e=>!e.matches('[data-pult-ribbon]')).map(e=>e.innerText||'').join(' ').replace(/\\s+/g,' ').trim();` +
          `return {w:Math.round(r.width),h:Math.round(r.height),inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,` +
          `rail:over(document.querySelector('.pult-rail')),fs:over(fs),drawn:!!c&&c.width>1,page:n.getAttribute('data-pult-page'),` +
          `words:(words||n.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60)}`,
      ) as Promise<{
        w: number
        h: number
        inside: boolean
        rail: boolean
        fs: boolean
        drawn: boolean
        page: string | null
        words: string
      } | null>
    const seen = (b: Awaited<ReturnType<typeof nextBox>>) =>
      b
        ? `${b.w}×${b.h} inside ${b.inside} · over the rail ${b.rail} · over "Fullscreen" ${b.fs} · "${b.words}"${b.page ? ` · page ${b.page}${b.drawn ? ', drawn' : ', no picture'}` : ''}`
        : 'none'
    const placed = (b: Awaited<ReturnType<typeof nextBox>>) => !!b && b.inside && !b.rail && !b.fs
    /** The strip's tile: page 2, its thumbnail drawn, "2 · дальше" under it. */
    const tileOk = (b: Awaited<ReturnType<typeof nextBox>>) =>
      placed(b) && b!.w >= 90 && b!.page === '2' && b!.drawn && /2\s*·\s*дальше/i.test(b!.words)
    /** A footer in words: "ДАЛЬШЕ" and the next slide (its title, or "Слайд 2"). */
    const wordsOk = (b: Awaited<ReturnType<typeof nextBox>>) =>
      placed(b) && b!.w >= 100 && /дальше/i.test(b!.words) && /2/.test(b!.words)
    if (W > H) {
      await until(
        pult,
        `(document.querySelector(${JSON.stringify(NEXT_TILE + ' canvas')})?.width||0)>1`,
        'the next thumbnail',
        6000,
      )
      const plain = await nextBox(NEXT_TILE)
      check(tileOk(plain), '"next" is on the console', seen(plain))
    } else {
      await until(pult, `!!document.querySelector('[data-pult-next]')`, 'the next footer', 6000)
      const plain = await nextBox('[data-pult-next]')
      check(wordsOk(plain), '"next" is on the console', seen(plain))
    }
    if (W > H) {
      const notesKey = () =>
        pult.js(`return document.querySelector('[aria-label=${JSON.stringify(PULT.notes)}]')?.getAttribute('aria-pressed')`)
      /** Bring the notes sheet to a state by its key, not by counting presses. */
      const notesTo = async (open: boolean): Promise<boolean> => {
        for (let i = 0; i < 3; i += 1) {
          if ((await notesKey()) === String(open)) return true
          await pult.js(press(PULT.notes))
          await wait(400)
        }
        return (await notesKey()) === String(open)
      }
      const wasOpen = (await notesKey()) === 'true'
      const opened = await notesTo(true)
      await wait(300)
      await until(
        pult,
        `(document.querySelector(${JSON.stringify(NEXT_TILE + ' canvas')})?.width||0)>1`,
        'the next thumbnail beside the notes',
        6000,
      )
      const withNotes = await nextBox(NEXT_TILE)
      // The notes column says it in words too, at its foot.
      const column = await nextBox('aside[data-pult-notes] [data-pult-next]')
      const state = await notesKey()
      // Leave the notes as they were: the scenarios below write on the lower bands.
      await notesTo(wasOpen)
      check(
        opened && state === 'true' && tileOk(withNotes) && wordsOk(column),
        '"next" stays with the notes sheet open',
        `notes ${state} · strip ${seen(withNotes)} · column ${seen(column)}`,
      )
      /* The tile is a page of the strip: a tap goes there, for the hall too. */
      await until(pult, `!!document.querySelector(${JSON.stringify(NEXT_TILE)})`, 'the next tile', 4000)
      await pult.js(
        `const b=document.querySelector(${JSON.stringify(NEXT_TILE)});if(!b) throw new Error('no next tile'); b.click(); return 1`,
      )
      const went = await until(student, `${hallExpr} === '2'`, 'a tap on the next tile turned the hall', 6000)
      const gaugeThere = (await measure()).gauge
      await pult.js(press(PULT.prev))
      const back = await until(student, `${hallExpr} === '1'`, 'the hall is back on the first', 6000)
      check(
        went && gaugeThere === '2' && back,
        'a tap on the "next" tile turns the page there',
        `hall ${went ? '1 → 2' : 'stayed'} · gauge ${gaugeThere || '—'} · back ${back ? 'on 1' : 'not on 1'}`,
      )
      // Page 1 renders again before the palm scenarios below write on it (the pen waits for the picture).
      await wait(300)
    }
  }

  /* ---------- 1. a two-contact palm 700 ms before the pen, three strokes */

  {
    const g = await geometry()
    const b3 = bands(3)
    // The heel below and to the right of the writing bands, on the canvas: that is where a right-hander's lies.
    await palm.down(onCanvas(g, 0.78, 0.88), { contacts: 2, via: 'dom' })
    await wait(700)
    await rapidStrokes(3)
    await settled(b3)
    const during = await measure(b3)
    await palm.up()
    await wait(500)
    const after = await measure(b3)
    check(
      pultBands(during).every((n) => n > 0) && during.student.dry.bands.every((n) => n > 0),
      '1. a two-contact palm lies down before the pen — three strokes draw',
      `console ${pultBands(during).join(' / ')} px · student ${during.student.dry.bands.join(' / ')} px`,
    )
    check(
      after.student.dry.bands.every((n) => n > 0) && pultBands(after).every((n) => n > 0),
      '1. …and stay after the palm lifts',
      `student ${after.student.dry.bands.join(' / ')} px · console ${pultBands(after).join(' / ')} px`,
    )
    await clean()
  }

  /* -------------------- 2. the palm drifts 70 px while writing */

  {
    const g = await geometry()
    const b2 = bands(2)
    /*
     * From the second page, not the first: the palm of the writing hand moves
     * to the RIGHT, and a swipe to the right was once "back"; on the first page
     * there is nowhere to go back to, and the harness would silently praise the
     * console for simply having nowhere to turn.
     */
    await pult.js(press(PULT.next))
    await until(student, `${hallExpr} === '2'`, 'the hall is on the second page', 8000)
    const pageBefore = (await measure()).hall
    await palm.down(onCanvas(g, 0.7, 0.85), { contacts: 1, via: 'dom' })
    await wait(700)
    await stroke(
      [
        [0.15, 0.3],
        [0.4, 0.35],
      ],
      { speed: 200 },
    )
    await wait(100)
    const before = await geometry()
    await palm.move(70, 6)
    const after = await geometry()
    // The shift: both the transform on the sheet box and the actual position of the canvas.
    const shifted = Math.max(
      (await measure()).shift,
      Math.abs(Math.round(after.canvas.left - before.canvas.left)),
    )
    await stroke(
      [
        [0.15, 0.6],
        [0.4, 0.62],
      ],
      { speed: 200 },
    )
    await settled(b2)
    const written = await measure(b2)
    await palm.up()
    await wait(900)
    const m = await measure(b2)
    check(
      m.hall === pageBefore && m.gauge === pageBefore && shifted === 0,
      '2. a 70 px palm drift neither turns the page nor moves the sheet',
      `hall ${pageBefore} → ${m.hall || '—'} · gauge ${m.gauge || '—'} · sheet shift ${shifted}px`,
    )
    check(
      written.student.dry.bands.every((n) => n > 0),
      '2. both strokes with the palm down reached the hall',
      `student ${written.student.dry.bands.join(' / ')} px`,
    )
    if (m.hall !== pageBefore) {
      await pult.js(press(Number(m.hall) > Number(pageBefore) ? PULT.prev : PULT.next))
      await wait(600)
    }
    await pult.js(press(PULT.prev))
    await until(student, `${hallExpr} === '1'`, 'the hall is back on the first', 8000)
    await clean()
  }

  /* --------------------- 3. the palm lies for 2 s without a pen: no ink, no pointer */

  {
    const g = await geometry()
    await penTool()
    await palm.down(onCanvas(g, 0.7, 0.85), { contacts: 1, via: 'dom' })
    await wait(2000)
    const m = await measure()
    await palm.up()
    await wait(300)
    check(
      redAtStudent(m) === 0 && m.live.red === 0 && m.wet.all <= 0 && m.student.dry.all <= 0,
      '3. a still palm without a pen — no pointer, no stroke',
      `red: student ${redAtStudent(m)}, live canvas ${m.live.red} · ink: wet ${m.wet.all}, student ${m.student.dry.all}`,
    )
    await clean()
  }

  /* ------------------------- 4. the palm lands BETWEEN strokes */

  {
    const g = await geometry()
    const b3 = bands(3)
    await rapidStrokes(3, {}, async (i) => {
      if (i === 0) await palm.down(onCanvas(g, 0.78, 0.88), { contacts: 2, via: 'dom' })
    })
    await settled(b3)
    const m = await measure(b3)
    await palm.up()
    check(
      m.student.dry.bands.every((n) => n > 0) && pultBands(m).every((n) => n > 0),
      '4. the palm landed in a pause between strokes — all three are in place',
      `student ${m.student.dry.bands.join(' / ')} px · console ${pultBands(m).join(' / ')} px`,
    )
    await clean()
  }

  /* ------------------ 5. a finger went from the sheet onto the rail and lifted: no ghosts */

  {
    const g = await geometry()
    const b1 = bands(1)
    await palm.down(onCanvas(g, 0.5, 0.5), { contacts: 1, via: 'cdp' })
    const rail = onRail(g)
    const from = palm.contacts[0]
    await palm.move(rail.x - from.x, rail.y - from.y, 8)
    await palm.up()
    await wait(400)
    const ghost = await measure()
    await rapidStrokes(1)
    await settled(b1)
    const m = await measure(b1)
    check(
      ghost.wet.all <= 0 &&
        ghost.student.dry.all <= 0 &&
        m.student.dry.bands[0] > 0 &&
        pultBands(m)[0] > 0,
      '5. a finger that went onto the rail leaves no ghosts and does not hinder the pen',
      `after the finger: wet ${ghost.wet.all}, student ${ghost.student.dry.all} · pen stroke: student ${m.student.dry.bands[0]} px`,
    )
    await clean()
  }

  /* ---------------------- 6. a stroke starts on the margin and goes onto the canvas */

  {
    const g = await geometry()
    await strokeAt([onMargin(g), onCanvas(g, 0.5, 0.7), onCanvas(g, 0.3, 0.72)], { speed: 220 })
    const arrived = await until(
      student,
      `${inkExpr('ink-dry', [])}.all > 0`,
      'the stroke from the margin arrived',
      8000,
    )
    const m = await measure()
    check(
      arrived && m.student.dry.all > 0,
      '6. a stroke started on the margin draws',
      `student ${m.student.dry.all} px`,
    )
    await clean()
  }

  /* --------------------------------- 7. two fingers: a tap = undo */

  {
    const g = await geometry()
    const b2 = bands(2)
    await rapidStrokes(2)
    await settled(b2)
    const before = await measure(b2)
    await twoFingerTap(onCanvas(g, 0.5, 0.9), 'cdp')
    const undone = await until(
      student,
      `${inkExpr('ink-dry', b2)}.bands[1] === 0`,
      'the last stroke was undone',
      8000,
    )
    const m = await measure(b2)
    check(
      before.student.dry.bands.every((n) => n > 0) &&
        undone &&
        m.student.dry.bands[0] > 0 &&
        m.student.dry.bands[1] === 0,
      '7. a two-finger tap undoes the last stroke',
      `was ${before.student.dry.bands.join(' / ')} px → became ${m.student.dry.bands.join(' / ')} px`,
    )
    /*
     * Two fingers are a pinch now as well, and the tap must stay Undo and
     * nothing else: a pinch commits only once the fingers spread by a tenth
     * or slide 16 px (ink.ts · `pinchCommits`), and the stand's tap does
     * neither.
     */
    const tapZoom = { hall: hallZoom(), pult: await pultZoom() }
    check(
      tapZoom.hall === null && tapZoom.pult === null,
      '7. …and zooms nothing',
      `hall ${zoomWords(tapZoom.hall)} · console ${tapZoom.pult ?? 'whole page'}`,
    )
    await clean()
    /*
     * And during writing the same tap does nothing: the pen is in contact, the
     * stroke is intact, the previous one is not undone. The fingers are
     * synthetic, because the pen is down.
     */
    const b3 = bands(3)
    await stroke(
      [
        [0.15, band(0, 3)[0] + 0.05],
        [0.55, band(0, 3)[1] - 0.05],
      ],
      { speed: 200 },
    )
    await settled([band(0, 3)])
    await stroke(
      [
        [0.15, band(2, 3)[0] + 0.05],
        [0.55, band(2, 3)[1] - 0.05],
      ],
      { speed: 300, midway: () => twoFingerTap(onCanvas(g, 0.5, 0.95), 'dom') },
    )
    await settled(b3)
    const mid = await measure(b3)
    check(
      mid.student.dry.bands[0] > 0 && mid.student.dry.bands[2] > 0,
      '7. a two-finger tap during a stroke drops nothing',
      `student ${mid.student.dry.bands.join(' / ')} px`,
    )
    await clean()
  }

  /* --------------------------------- 8. the pointer: a path of forty points */

  {
    await pult.js(press(PULT.laser))
    await wait(250)
    const latched = await pult.js(`return ${pressed(PULT.laser)}`)
    // An arc of forty points across the whole sheet: the step is even, so a jump shows.
    const pts: [number, number][] = Array.from({ length: 40 }, (_, i) => {
      const t = i / 39
      return [0.15 + 0.7 * t, 0.5 + 0.25 * Math.sin(t * Math.PI * 2)]
    })
    // Twice: the first press in the lecture and a repeated one. The cold one is
    // what the teacher sees when first showing "right here".
    const cold = await laserHold(pts, 8)
    await wait(500)
    const laser = await laserHold(pts, 8)
    /*
     * THE THRESHOLDS GO BY THE CONSOLE'S SHARE, NOT BY THE HARNESS'S FRAME. On
     * the device the brief requires the first pixel within three frames and
     * not a single frame longer than 34 ms. The harness is Chrome without a GPU
     * with a double pixel, next to two more tabs and the server: calls into
     * the browser (pointer capture, sending into the socket, the compositor
     * frame) get stuck here for 10–200 ms at random, on an empty sheet,
     * without a single line of our code in the profile (see the header of
     * laserHold), and in two runs in a row different ones get stuck. So what is
     * checked is what the console is responsible for: the head is drawn in THE
     * SAME handler that got the press, not in the next frame
     * (`paintedInHandler`); the first frame with a head comes no later than
     * 350 ms even with a compositor stall; frames longer than 34 ms, stalls and
     * jumps are at most a fifth. A jump after a stall is the spring catching
     * up with the pen, and that is its job. The cold press gets twice as much,
     * both in time and in frames: on the first geometry it is also the first
     * run of the pointer code through the JIT, and that alone costs a third of
     * a second.
     */
    const share = (of: number) => Math.ceil(of * 0.2)
    const coldShare = (of: number) => Math.ceil(of * 0.4)
    check(
      latched === 'true' &&
        cold.firstPixelMs >= 0 &&
        cold.firstPixelMs <= 700 &&
        laser.firstPixelMs >= 0 &&
        laser.firstPixelMs <= 350 &&
        cold.paintedInHandler &&
        laser.paintedInHandler,
      '8. the pointer lights up in the press handler',
      `head before the first frame: cold ${cold.paintedInHandler ? 'yes' : 'no'} (${cold.paintLagMs} ms), repeated ${laser.paintedInHandler ? 'yes' : 'no'} (${laser.paintLagMs} ms) · first frame with red: cold ${cold.firstPixelMs} ms, repeated ${laser.firstPixelMs} ms · frame ${laser.frameMs} ms`,
    )
    check(
      laser.moving > 0 && laser.stalls <= share(laser.moving) && laser.jumps <= share(laser.moving),
      '8. the pointer head follows the pen without stalls or jumps',
      `heads ${laser.heads} over ${laser.frames} frames for ${laser.inputs} points · stalls ${laser.stalls}/${laser.moving} · jumps ${laser.jumps} (cold ${cold.jumps}) · longest step ${laser.longestJump}px`,
    )
    check(
      laser.slowFrames <= share(laser.frameGaps) &&
        cold.slowFrames <= coldShare(cold.frameGaps) &&
        laser.worstFrame <= 350 &&
        cold.worstFrame <= 700,
      '8. a frame with the pointer does not drop',
      `frames longer than 34 ms: ${laser.slowFrames}/${laser.frameGaps} (cold ${cold.slowFrames}/${cold.frameGaps}) · worst ${laser.worstFrame} ms (cold ${cold.worstFrame})`,
    )
    /*
     * A lifted shape is a phrase of one press, and a phrase holds before it
     * fades (laser.ts · PHRASE_HOLD_MS 1500, PHRASE_FADE_MS 600): still lit
     * 1.2 s after the lift, which the old 900 ms hold of each shape was not,
     * and dark by 2.1 s, 2.6 s at the latest with the observer's own frames.
     */
    check(
      laser.offAfterMs > 1200 && cold.offAfterMs > 1200,
      '8. the lifted pointer still shines 1.2 s after the lift',
      `went out after ${laser.offAfterMs} ms (cold ${cold.offAfterMs} ms)`,
    )
    check(
      laser.offAfterMs >= 0 &&
        laser.offAfterMs <= 2600 &&
        cold.offAfterMs >= 0 &&
        cold.offAfterMs <= 2600 &&
        !laser.relit &&
        !cold.relit,
      '8. the lifted pointer goes out within 2.6 s and does not flare up again',
      laser.offAfterMs < 0 || cold.offAfterMs < 0
        ? 'did not go out within 2.8 s'
        : `went out after ${laser.offAfterMs} ms (cold ${cold.offAfterMs} ms) · flare after: ${laser.relit || cold.relit ? 'yes' : 'no'}`,
    )
    /*
     * The pointer is a palette tool, as in GoodNotes/Notability: choosing the
     * pen takes it off. The "Pen" key is inactive here, so a tap on it is a
     * choice.
     */
    await pult.js(press(PULT.pen))
    await wait(500)
    const stillLaser = await pult.js(`return ${pressed(PULT.laser)}`)
    const redLeft = (await measure()).live.red
    check(
      stillLaser === 'false' && redLeft === 0,
      '8. choosing the pen takes off the pointer',
      `after "Pen" the pointer aria-pressed=${stillLaser} · red on the live canvas ${redLeft}`,
    )
  }

  /* ------------------- 9. Pencil hovers over the sheet: a shadow, but no beam */

  {
    /*
     * Hovering NO LONGER lights up. Before, a Pencil brought up to the glass
     * already led a beam across the projector: the hand goes to the sheet and
     * the hall sees a red line nobody was showing. Now the teacher sees a grey
     * shadow of the tip, and the hall sees nothing; the beam lights up on
     * touch.
     */
    const g = await geometry()
    await pult.js(press(PULT.laser))
    await wait(200)
    for (let i = 0; i <= 8; i += 1) {
      await hover(onCanvas(g, 0.3 + 0.03 * i, 0.5))
      await wait(16)
    }
    await wait(300)
    const hoverHere = await measure()
    check(
      hoverHere.live.red === 0 && redAtStudent(hoverHere) === 0,
      '9. a hovering pen does not light the pointer',
      `red on the console ${hoverHere.live.red} · student ${redAtStudent(hoverHere)}`,
    )
    /* The shadow is grey: not red (red is only what the hall sees) and not
       empty space (otherwise it is unclear where the beam will land). */
    const shade = (await pult.js(
      `const c=document.querySelector('canvas.ink-live');` +
        `if(!c||!c.width) return -1;` +
        `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
        `let grey=0;` +
        `for(let i=0;i<d.length;i+=4){` +
        `if(d[i+3]<24) continue;` +
        `const mx=Math.max(d[i],d[i+1],d[i+2]), mn=Math.min(d[i],d[i+1],d[i+2]);` +
        `if(mx-mn<40) grey+=1}` +
        `return grey`,
    )) as number
    check(shade > 0, '9. a hovering pen shows a grey shadow', `grey points ${shade}`)

    /* A touch, and now there is a beam, and the hall sees it. */
    await strokeAt([onCanvas(g, 0.35, 0.55), onCanvas(g, 0.55, 0.5), onCanvas(g, 0.7, 0.6)], {
      speed: 220,
    })
    const beam = await until(
      student,
      `(${inkExpr('ink-live', [])}.red > 0) || (${inkExpr('ink-wet', [])}.red > 0)`,
      'the beam from the touch reached the hall',
      5000,
    )
    check(beam, '9. the beam lights up on touch and reaches the hall', beam ? 'arrived' : 'no')

    /*
     * A traced shape HOLDS and then fades out whole: PHRASE_HOLD_MS = 1500
     * and PHRASE_FADE_MS = 600 in laser.ts. First we make sure that half a
     * second after the pen lifts it is still in place (that is "pinned it, it
     * stays"), then we wait for it to melt away.
     */
    await wait(500)
    const held = (await measure()).live.red
    check(held > 0, '9. the shape holds after the pen lifts', `${held} red after 0.5 s`)

    await pult.js(press(PULT.pen))
    await until(pult, `(${inkExpr('ink-live', [])}.red === 0)`, 'the shape went out on the console', 4000)
    await until(
      student,
      `(${inkExpr('ink-live', [])}.red === 0) && (${inkExpr('ink-wet', [])}.red === 0)`,
      'the shape went out in the hall',
      4000,
    )

    /*
     * ALL PENS HAVE A SHADOW, not only the eraser and the pointer: there is no
     * cursor on glass, and before the touch it is not visible where the tip
     * will land. We count the opaque points of the live canvas in a small
     * square around the hovering pen, far from where the stroke will go.
     */
    const box = (fx: number, fy: number, half = 0.06) =>
      `(()=>{const c=document.querySelector('canvas.ink-live');` +
      `if(!c||!c.width) return -1;` +
      `const W=c.width,H=c.height;` +
      `const x0=Math.round((${fx}-${half})*W),x1=Math.round((${fx}+${half})*W);` +
      `const y0=Math.round((${fy}-${half})*H),y1=Math.round((${fy}+${half})*H);` +
      `const d=c.getContext('2d').getImageData(x0,y0,Math.max(1,x1-x0),Math.max(1,y1-y0)).data;` +
      `let n=0;for(let i=3;i<d.length;i+=4) if(d[i]>16) n+=1;return n})()`
    const shadeAt: [number, number] = [0.28, 0.36]
    for (let i = 0; i <= 4; i += 1) {
      await hover(onCanvas(g, shadeAt[0] + 0.004 * i, shadeAt[1]))
      await wait(16)
    }
    await wait(120)
    const penShade = (await pult.js(`return ${box(shadeAt[0], shadeAt[1])}`)) as number
    check(penShade > 0, '9. a hovering pen shows a shadow', `shadow points ${penShade}`)

    /*
     * And it DISAPPEARS UNDER A TOUCH, unlike the eraser ring: there the ring is
     * the working area, while here the stroke itself is already under the pen,
     * and a second mark would get in the way of looking at the letter. We write
     * far from the hover spot and, without lifting the pen, look at the same
     * square.
     */
    await pult.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...onCanvas(g, 0.72, 0.72),
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'pen',
      force: 0.5,
    })
    await pult.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...onCanvas(g, 0.78, 0.74),
      button: 'left',
      buttons: 1,
      pointerType: 'pen',
      force: 0.5,
    })
    await wait(140)
    const shadeUnderPen = (await pult.js(`return ${box(shadeAt[0], shadeAt[1])}`)) as number
    await pult.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...onCanvas(g, 0.78, 0.74),
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'pen',
      force: 0,
    })
    check(
      shadeUnderPen === 0,
      '9. the pen shadow goes away under a touch',
      `${shadeUnderPen} points in the hover square while the pen is on the sheet`,
    )
    await clean()

    /*
     * SEVERAL SHAPES LIVE TOGETHER. You underlined a line, then circled a
     * formula, and the underline did not go anywhere: while every touch erased
     * the previous one, it was impossible to finish a sentence about what was
     * shown.
     */
    await pult.js(press(PULT.laser))
    await wait(200)
    const left: [number, number] = [0.3, 0.3]
    const right: [number, number] = [0.72, 0.68]
    await strokeAt([onCanvas(g, 0.22, 0.3), onCanvas(g, 0.38, 0.3)], { speed: 180 })
    await wait(250)
    await strokeAt([onCanvas(g, 0.64, 0.68), onCanvas(g, 0.8, 0.68)], { speed: 180 })
    await wait(120)
    const redBox = (fx: number, fy: number) =>
      `(()=>{const c=document.querySelector('canvas.ink-live');` +
      `if(!c||!c.width) return -1;` +
      `const W=c.width,H=c.height;` +
      `const x0=Math.round((${fx}-0.1)*W),y0=Math.round((${fy}-0.08)*H);` +
      `const d=c.getContext('2d').getImageData(x0,y0,Math.round(0.2*W),Math.round(0.16*H)).data;` +
      `let n=0;for(let i=0;i<d.length;i+=4) if(d[i+3]>24&&d[i]>150&&d[i+1]<120) n+=1;return n})()`
    const first = (await pult.js(`return ${redBox(left[0], left[1])}`)) as number
    const second = (await pult.js(`return ${redBox(right[0], right[1])}`)) as number
    check(
      first > 0 && second > 0,
      '9. the second shape does not erase the first',
      `${first} red in the first, ${second} in the second`,
    )
    await pult.js(press(PULT.pen))
    await until(pult, `(${inkExpr('ink-live', [])}.red === 0)`, 'the shapes burned out', 4000)
    const m = await measure()
    check(
      m.live.red === 0 && redAtStudent(m) === 0,
      '9. the shape goes out whole and everywhere',
      `console ${m.live.red} · student ${redAtStudent(m)}`,
    )
    await penTool()
  }

  /* ------------------------------------- 10. the controlling properties */

  {
    const g = await geometry()
    await pult.js(`document.getSelection()?.removeAllRanges(); return 1`)
    await palm.down(onMargin(g), { contacts: 1, via: 'cdp' })
    await wait(1100)
    await palm.move(12, 4, 3)
    const held = await measure()
    await palm.up()
    await wait(200)
    /*
     * The iPad system selection cannot be reached from Chrome: it lives in
     * WebKit. We measure what controls it: `user-select` and `touch-action` on
     * the root, the sheet and the input layer, and that the notes field is the
     * only place where text gets selected.
     */
    const css = (await pult.js(
      `const q=s=>document.querySelector(s);const g=(e,p)=>e?getComputedStyle(e)[p]:'missing';` +
        `const notes=q('[data-pult-notes] textarea')||q('textarea');` +
        `return {rootSelect:g(q('.pult-root'),'userSelect'),sheetTouch:g(q('.pult-sheet'),'touchAction'),` +
        `inputTouch:g(q('.ink-input'),'touchAction'),inputSelect:g(q('.ink-input'),'userSelect'),` +
        `notesSelect:notes?g(notes,'userSelect'):'no field',readerSelect:g(q('.pult-reader'),'userSelect')}`,
    )) as Record<string, string>
    check(
      held.selection === 0 && held.ranges === 0,
      '10. a long touch on the margins selects nothing',
      `selected characters ${held.selection}, ranges ${held.ranges}`,
    )
    check(
      css.rootSelect === 'none' &&
        css.sheetTouch === 'none' &&
        css.inputTouch === 'none' &&
        css.inputSelect === 'none',
      '10. the root, the sheet and the input layer are closed to selection and scrolling',
      `.pult-root user-select=${css.rootSelect} · .pult-sheet touch-action=${css.sheetTouch} · .ink-input touch-action=${css.inputTouch} user-select=${css.inputSelect}`,
    )
    /*
     * And the notes READER selects nothing: it lies where a right hand's palm
     * rests while writing on the slide, and a long touch on selectable text
     * there opens WebKit's selection with a loupe over the formula.
     */
    check(
      (css.notesSelect === 'text' || css.notesSelect === 'auto' || css.notesSelect === 'no field') &&
        (css.readerSelect === 'none' || css.readerSelect === 'missing'),
      '10. the notes field is the only place where text gets selected',
      `textarea user-select=${css.notesSelect} · reader user-select=${css.readerSelect}`,
    )
    await clean()
  }

  /* ------------------------------------------------- 11. layout */

  {
    const g = await geometry()
    const portrait = H > W
    const railW = g.rail ? (portrait ? 0 : g.rail.width) : 0
    /*
     * The width the sheet must take is what the rail AND the notes column
     * leave: in landscape the notes are a column beside the slide (open by
     * default), and the slide refits to the rest instead of being covered.
     */
    const columnW = portrait
      ? 0
      : ((await pult.js(
          `const n=document.querySelector('aside[data-pult-notes]');return n?n.getBoundingClientRect().width:0`,
        )) as number)
    const needWidth = 0.8 * (W - railW - columnW - 24)
    const share = Math.round(((g.canvas.width * g.canvas.height) / (W * H)) * 100)
    const railPlace = !g.rail
      ? 'no rail'
      : portrait
        ? g.rail.bottom >= H - 1
          ? 'bottom'
          : `not at the bottom (bottom=${Math.round(g.rail.bottom)})`
        : g.rail.left === 0
          ? 'left'
          : `not on the left (left=${Math.round(g.rail.left)})`
    check(
      g.canvas.top <= 24 && g.canvas.width >= needWidth,
      '11. the sheet is pressed to the top and takes the width',
      `sheet ${Math.round(g.canvas.width)}×${Math.round(g.canvas.height)} (${share}% of the screen), top ${Math.round(g.canvas.top)}px, ≥${Math.round(needWidth)}px of width needed`,
    )
    check(
      railPlace === (portrait ? 'bottom' : 'left'),
      `11. rail ${portrait ? 'at the bottom' : 'on the left'}`,
      `${railPlace}${g.rail ? ` · ${Math.round(g.rail.width)}×${Math.round(g.rail.height)}` : ''}`,
    )
    /*
     * There is no top thread: not a single full-width strip pressed to the
     * edge. The "Full screen" strip is narrower than 400 px and does not fall
     * under the filter.
     */
    const thread = (await pult.js(
      `const root=document.querySelector('.pult-root')||document.body;const w=window.innerWidth;` +
        `const wide=[...root.querySelectorAll('*')].filter(el=>{const r=el.getBoundingClientRect();` +
        `return r.top<8 && r.width>w*0.8 && r.height>=28 && r.height<=110 && !el.querySelector('canvas')});` +
        `return wide.slice(0,3).map(el=>el.tagName.toLowerCase()+'.'+String(typeof el.className==='string'?el.className:'').slice(0,28)+' '+Math.round(el.getBoundingClientRect().height)+'px').join(' | ')`,
    )) as string
    check(thread === '', '11. the console has no top thread', thread || 'no strips')
    check(
      !!g.input &&
        Math.abs(g.input.left - g.sheet.left) <= 1 &&
        Math.abs(g.input.width - g.sheet.width) <= 2,
      '11. the input layer covers the sheet with margins',
      g.input
        ? `input ${Math.round(g.input.width)}×${Math.round(g.input.height)} · sheet ${Math.round(g.sheet.width)}×${Math.round(g.sheet.height)}`
        : 'no input layer',
    )
  }

  if (SHOT) {
    const shot = await pult.send('Page.captureScreenshot', { format: 'png' })
    const file = path.resolve(`pencil-check-${W}x${H}.png`)
    writeFileSync(file, Buffer.from(shot.result.data as string, 'base64'))
    console.log(`  screenshot: ${file}`)
  }

  /* ============================================================ console v4 */

  /*
   * What the fourth console added, on every geometry: the zoom the hall
   * mirrors (15–18), the pointer phrase (19), the highlighter under the ink
   * (20) and the sheets the server keeps (21). The hall is the student's
   * screen; what it is TOLD is read from the server's memory.
   */

  /* ------------------------------------ 15. a pinch: the hall sees the detail */

  {
    await penTool()
    await wholePage()
    await clean()
    /*
     * A landmark in the middle of the page, drawn at ×1: a cross. Whatever
     * the view, every screen must show it at the same place of its frame, and
     * the console where the zoom the server holds puts it.
     */
    await stroke([[0.45, 0.44], [0.55, 0.56]], { speed: 160 })
    await stroke([[0.45, 0.56], [0.55, 0.44]], { speed: 160 })
    const whole = await restingBox(pultInk)
    const hallWhole = await boxUntil(hallInk, (box) => sameBox(box, whole))
    const g = await geometry()
    const mid = { x: g.canvas.left + g.canvas.width * 0.5, y: g.canvas.top + g.canvas.height * 0.5 }
    const fingers = (d: number) => [
      { x: mid.x - d, y: mid.y, id: 971, radiusX: 6, radiusY: 6 },
      { x: mid.x + d, y: mid.y, id: 972, radiusX: 6, radiusY: 6 },
    ]
    /*
     * The pen rests first: within 600 ms of its last touch two fingers on
     * the sheet are the writing hand's heel and pinky, and they never zoom.
     * Then two real touches 80 px apart spread to 200 about the middle of the
     * sheet: ×2.5, the region 0.3…0.7 of the page.
     */
    await wait(800)
    await pult.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [fingers(40)[0]] })
    await wait(30)
    await pult.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(40) })
    let midway: Zoom | null = null
    for (let i = 1; i <= 12; i += 1) {
      await wait(16)
      await pult.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(40 + i * 5) })
      if (i === 8) midway = hallZoom()
    }
    await wait(60)
    await pult.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const agreed = await untilHere(
      () => zoomAgreed((zoom) => zoom !== null && zoom.z > 2),
      'the console and the server settled on the pinch',
      6000,
    )
    const zoom = hallZoom()
    check(
      agreed &&
        zoom !== null &&
        Math.abs(zoom.z - 2.5) <= 0.15 &&
        Math.abs(zoom.x - 0.3) <= 0.02 &&
        Math.abs(zoom.y - 0.3) <= 0.02 &&
        midway !== null &&
        midway.z < zoom.z,
      '15. a pinch zooms the console, and the hall follows the fingers',
      `server ${zoomWords(zoom)} · console ${(await pultZoom()) ?? 'whole page'} · while the fingers moved ${zoomWords(midway)}`,
    )
    const pultSees = await boxUntil(pultInk, (box) => sameBox(box, zoomedBox(whole, zoom)))
    const hallSees = await boxUntil(hallInk, (box) => sameBox(box, pultSees))
    check(
      sameBox(hallWhole, whole) && sameBox(pultSees, zoomedBox(whole, zoom)) && sameBox(hallSees, pultSees),
      '15. the hall shows the region the console shows',
      `landmark at ×1 ${boxWords(whole)} (hall ${boxWords(hallWhole)}) · zoomed: console ${boxWords(pultSees)}, hall ${boxWords(hallSees)}`,
    )
    const keyWords = (await pult.js(
      `return (document.querySelector('[aria-label=${JSON.stringify(PULT.zoomWhole)}]')?.textContent||'').replace(/\\s+/g,' ').trim()`,
    )) as string
    const armrest = (await pult.js(
      `const a=document.querySelector('[data-pult-hall-zoom]');return a?a.getAttribute('data-pult-hall-zoom')+' '+(a.textContent||'').replace(/\\s+/g,' ').trim():''`,
    )) as string
    const lupaGone = (await pult.js(`return !${named(PULT.zoom)}`)) === true
    check(
      zoom !== null &&
        keyWords.includes(times(zoom.z)) &&
        /весь слайд/i.test(keyWords) &&
        lupaGone &&
        armrest.startsWith(`${zoom.z} `) &&
        armrest.includes(times(zoom.z)),
      '15. the magnifier key reads the zoom, the armrest what the hall sees',
      `key "${keyWords}" · armrest "${armrest}"`,
    )
    await shoot(`zoom-${W}x${H}`)
    /*
     * A stroke on the magnified detail: in page space it lands where the pen
     * was in the region (x + fx / z), and it is the chosen width divided by
     * the zoom, so on the glass it is as thick as at ×1.
     */
    const known = new Set(inkPageOf(ROOM, 1).map((s) => s.id))
    const tip = { fx: 0.2, fy: 0.25 }
    await stroke([[tip.fx, tip.fy], [tip.fx + 0.12, tip.fy + 0.04]], { speed: 200 })
    await untilHere(() => inkPageOf(ROOM, 1).some((s) => !known.has(s.id)), 'the stroke over the zoom reached the server', 6000)
    const fresh = inkPageOf(ROOM, 1).find((s) => !known.has(s.id))
    const want = zoom ? { x: zoom.x + tip.fx / zoom.z, y: zoom.y + tip.fy / zoom.z, w: 0.005 / zoom.z } : null
    const landed =
      !!fresh &&
      !!want &&
      Math.abs(fresh.points[0] - want.x) <= 0.003 &&
      Math.abs(fresh.points[1] - want.y) <= 0.003 &&
      Math.abs(fresh.width - want.w) <= 0.0002
    const pultAfter = await restingBox(pultInk)
    const hallAfter = await boxUntil(hallInk, (box) => sameBox(box, pultAfter))
    check(
      landed && sameBox(hallAfter, pultAfter),
      '15. a stroke on the zoomed detail lands where the pen was, in the hall too',
      fresh && want
        ? `first point ${fresh.points[0].toFixed(4)}, ${fresh.points[1].toFixed(4)} (want ${want.x.toFixed(4)}, ${want.y.toFixed(4)}) · width ${fresh.width} (want ${want.w.toFixed(4)}) · console ${boxWords(pultAfter)} · hall ${boxWords(hallAfter)}`
        : 'no new stroke on the server',
    )
    /* "0" on the keyboard: the whole slide again, everywhere. */
    await key('0', 48, 'Digit0')
    const unzoomed = await untilHere(() => zoomAgreed((z) => z === null), 'the whole page after "0"', 6000)
    const wholeAgain =
      zoom && pultAfter
        ? {
            x0: zoom.x + pultAfter.x0 / zoom.z,
            y0: zoom.y + pultAfter.y0 / zoom.z,
            x1: zoom.x + pultAfter.x1 / zoom.z,
            y1: zoom.y + pultAfter.y1 / zoom.z,
          }
        : null
    const pultBack = await boxUntil(pultInk, (box) => sameBox(box, wholeAgain))
    const hallBack = await boxUntil(hallInk, (box) => sameBox(box, wholeAgain))
    check(
      unzoomed &&
        sameBox(pultBack, wholeAgain) &&
        sameBox(hallBack, wholeAgain) &&
        (await pult.js(`return ${named(PULT.zoom)}`)) === true,
      '15. "0" takes the console and the hall back to the whole slide',
      `server ${zoomWords(hallZoom())} · console ${boxWords(pultBack)} · hall ${boxWords(hallBack)} · want ${boxWords(wholeAgain)}`,
    )
  }

  /* ------------------------------- 16. the magnifier: a frame, then "Whole slide" */

  {
    /*
     * "Лупа" arms the magnifier: the pen drags a frame instead of a stroke,
     * the frame fills the sheet, and the key gives the pen back at once, to
     * write on the detail. Zoomed, the key is the way back: "Весь слайд".
     * The landmark and the stroke of 15 are still on the page; the hall's
     * view is read by them.
     */
    const page = await restingBox(pultInk)
    await pult.js(press(PULT.zoom))
    await wait(200)
    const armed = await pult.js(`return ${pressed(PULT.zoom)}`)
    // From 30 % to 70 % of the sheet: a 0.4 square of the page, ×2.5 about its middle.
    const strokesBefore = inkPageOf(ROOM, 1).length
    await stroke([[0.3, 0.3], [0.7, 0.7]], { speed: 250 })
    const framed = await untilHere(() => zoomAgreed((z) => z !== null), 'the frame zoomed the console and the server', 6000)
    const zoom = hallZoom()
    const penBack = await pult.js(`return ${pressed(PULT.pen)}`)
    const turned = (await pult.js(`return ${named(PULT.zoomWhole)} && !${named(PULT.zoom)}`)) === true
    const strokesAfter = inkPageOf(ROOM, 1).length
    check(
      armed === 'true' &&
        framed &&
        zoom !== null &&
        Math.abs(zoom.z - 2.5) <= 0.1 &&
        Math.abs(zoom.x - 0.3) <= 0.01 &&
        Math.abs(zoom.y - 0.3) <= 0.01 &&
        penBack === 'true' &&
        turned &&
        strokesAfter === strokesBefore,
      '16. the magnifier: a frame drawn with the pen fills the sheet, and the pen is back',
      `armed ${armed} · server ${zoomWords(zoom)} · pen aria-pressed=${penBack} · key ${turned ? '"Весь слайд"' : 'unchanged'} · strokes ${strokesBefore} → ${strokesAfter}`,
    )
    const hallFramed = await boxUntil(hallInk, (box) => sameBox(box, zoomedBox(page, zoom)))
    await pult.js(press(PULT.zoomWhole))
    const back = await untilHere(() => zoomAgreed((z) => z === null), '"Весь слайд" took the zoom away', 6000)
    const hallBack = await boxUntil(hallInk, (box) => sameBox(box, page))
    const lupa = (await pult.js(`return ${named(PULT.zoom)} && !${named(PULT.zoomWhole)}`)) === true
    check(
      sameBox(hallFramed, zoomedBox(page, zoom)) && back && sameBox(hallBack, page) && lupa,
      '16. the hall follows the frame, and "Весь слайд" takes everyone back',
      `hall framed ${boxWords(hallFramed)} (want ${boxWords(zoomedBox(page, zoom))}) · after "Весь слайд": server ${zoomWords(hallZoom())}, hall ${boxWords(hallBack)} · key ${lupa ? '"Лупа"' : 'not back'}`,
    )
  }

  /* --------------------------------------------- 17. a turn resets the zoom */

  {
    /*
     * A page turn resets the zoom for everyone (the server's `turnTo`), and
     * coming back does not bring it back: the next slide starts whole, and
     * so does the previous one when it is shown again.
     */
    const page = await restingBox(pultInk)
    // "=" twice: ×1.5, then ×2.25, about the middle of the view.
    await key('=', 187, 'Equal')
    await wait(150)
    await key('=', 187, 'Equal')
    const keyed = await untilHere(
      () => zoomAgreed((z) => z !== null && Math.abs(z.z - 2.25) < 0.01),
      '"=" twice zoomed ×2.25',
      6000,
    )
    const zoom = hallZoom()
    const hallZoomed = await boxUntil(hallInk, (box) => sameBox(box, zoomedBox(page, zoom)))
    await pult.js(press(PULT.next))
    const turned = await until(student, `${hallExpr} === '2'`, 'the hall turned to page 2', 8000)
    const reset = await untilHere(
      async () => hallPage() === 2 && (await zoomAgreed((z) => z === null)),
      'the turn reset the zoom',
      6000,
    )
    const keyBack = (await pult.js(`return ${named(PULT.zoom)}`)) === true
    await pult.js(press(PULT.prev))
    const back = await until(student, `${hallExpr} === '1'`, 'the hall is back on page 1', 8000)
    const pultWhole = await boxUntil(pultInk, (box) => sameBox(box, page))
    const hallWhole = await boxUntil(hallInk, (box) => sameBox(box, page))
    check(
      keyed &&
        sameBox(hallZoomed, zoomedBox(page, zoom)) &&
        turned &&
        reset &&
        keyBack &&
        back &&
        hallZoom() === null &&
        sameBox(pultWhole, page) &&
        sameBox(hallWhole, page),
      '17. a page turn resets the zoom, on the console and in the hall',
      `"=" twice → ${zoomWords(zoom)} (hall ${sameBox(hallZoomed, zoomedBox(page, zoom)) ? 'followed' : `at ${boxWords(hallZoomed)}`}) · after the turn ${reset ? 'whole page' : zoomWords(hallZoom())} · back on page 1: server ${zoomWords(hallZoom())}, console ${boxWords(pultWhole)}, hall ${boxWords(hallWhole)}`,
    )
    await clean()
  }

  /* -------------------------------------------- 18. the palm does not zoom */

  {
    /*
     * The writing hand's heel and pinky are two contacts, and they creep: the
     * review's R1 drift, 20 px between five quick strokes. The heel is
     * palm-sized and ignored; the pinky alone is one finger. Then the same
     * hand as older WebKit reports it, every contact small: two "fingers"
     * that land right after the pen lifts and spread. Neither may zoom: no
     * pinch under the pen, nor within 600 ms of its last touch.
     */
    await wholePage()
    const g = await geometry()
    const b5 = bands(5)
    await palm.down(onCanvas(g, 0.8, 0.9), { contacts: 2, via: 'dom' })
    await wait(300)
    await rapidStrokes(5, { speed: 110 }, async () => {
      await palm.move(6, 20, 2)
    })
    await settled(b5)
    const m = await measure(b5)
    await palm.up()
    const drifted = { hall: hallZoom(), pult: await pultZoom() }
    await stroke([[0.2, 0.1], [0.4, 0.12]], { speed: 120 })
    const small = (d: number): Contact[] => [
      { id: 981, x: g.canvas.left + g.canvas.width * 0.6 - d, y: g.canvas.top + g.canvas.height * 0.88, r: 9 },
      { id: 982, x: g.canvas.left + g.canvas.width * 0.6 + d, y: g.canvas.top + g.canvas.height * 0.88, r: 9 },
    ]
    for (const [i, contact] of small(25).entries()) await palm.dom('pointerdown', contact, i === 0)
    for (let s = 1; s <= 6; s += 1) {
      await wait(20)
      for (const [i, contact] of small(25 + s * 7).entries()) await palm.dom('pointermove', contact, i === 0)
    }
    for (const [i, contact] of small(67).entries()) await palm.dom('pointerup', contact, i === 0)
    await wait(600)
    const spread = { hall: hallZoom(), pult: await pultZoom() }
    check(
      m.student.dry.bands.every((n) => n > 0) &&
        drifted.hall === null &&
        drifted.pult === null &&
        spread.hall === null &&
        spread.pult === null,
      '18. a palm drifting by the pen zooms nothing, and every stroke lands',
      `student ${m.student.dry.bands.join(' / ')} px · after the heel ${zoomWords(drifted.hall)} · after two small contacts by the pen ${zoomWords(spread.hall)}`,
    )
    await clean()
  }

  /* ------------------------------ 19. a pointer phrase: lit while one writes */

  {
    /*
     * A WORD WRITTEN WITH THE POINTER STAYS LIT WHILE IT IS BEING WRITTEN.
     * Three strokes 400 ms apart are one phrase (laser.ts · PHRASE_HOLD_MS
     * 1500): the first is still at full brightness when the third lifts, the
     * whole phrase holds 1.5 s after the last lift and then goes out
     * together over 0.6 s, on the console and in the hall. Under the old rule
     * each stroke burnt out on its own clock, 0.9 + 0.9 s after its own lift,
     * and the start of a word was gone before its end was written.
     *
     * A watcher in each page counts the red in three boxes, one per stroke,
     * every 50 ms; the last lift is marked on both clocks.
     */
    await pult.js(press(PULT.laser))
    await wait(250)
    const watch =
      `const cs=['ink-live','ink-wet'].map(k=>document.querySelector('canvas.'+k)).filter(Boolean);` +
      `const red=(f0,f1)=>{let n=0;for(const c of cs){if(c.width<2) continue;const x0=Math.floor(c.width*f0),x1=Math.ceil(c.width*f1);` +
      `const y0=Math.floor(c.height*0.16),y1=Math.ceil(c.height*0.42);const d=c.getContext('2d').getImageData(x0,y0,x1-x0,y1-y0).data;` +
      `for(let i=0;i<d.length;i+=16) if(d[i+3]>24&&d[i]>150&&d[i+1]<120) n+=1}return n};` +
      `const w={t0:performance.now(),s:[],stop:false,lift:-1};window.__phrase=w;` +
      `const tick=()=>{if(w.stop) return;w.s.push({t:performance.now()-w.t0,a:red(0.08,0.36),b:red(0.38,0.66),c:red(0.68,0.96)});setTimeout(tick,50)};` +
      `tick();return 1`
    await pult.js(watch)
    await student.js(watch)
    const g = await geometry()
    const strokes: [number, number][] = [
      [0.12, 0.32],
      [0.42, 0.62],
      [0.72, 0.92],
    ]
    for (const [i, [from, to]] of strokes.entries()) {
      if (i > 0) await wait(400)
      await strokeAt([onCanvas(g, from, 0.32), onCanvas(g, (from + to) / 2, 0.24), onCanvas(g, to, 0.32)], {
        speed: 150,
      })
    }
    const lifted = `window.__phrase.lift=performance.now()-window.__phrase.t0;return 1`
    await pult.js(lifted)
    await student.js(lifted)
    await wait(2900)
    type Sample = { t: number; a: number; b: number; c: number }
    type Phrase = { lift: number; s: Sample[] }
    const read = `const w=window.__phrase;w.stop=true;return {lift:w.lift,s:w.s}`
    const onPult = (await pult.js(read)) as Phrase
    const inHall = (await student.js(read)) as Phrase
    const near = (p: Phrase, t: number): Sample | undefined =>
      p.s.reduce<Sample | undefined>((best, x) => (!best || Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best), undefined)
    const lit = (x: Sample | undefined) => !!x && x.a > 0 && x.b > 0 && x.c > 0
    const say = (x: Sample | undefined) => (x ? `${x.a}/${x.b}/${x.c}` : '—')
    /** When, after the last lift, a box (or all three) first has no red: −1 if never. */
    const off = (p: Phrase, box: 'a' | 'b' | 'c' | 'all') => {
      const x = p.s.find((y) => y.t > p.lift && (box === 'all' ? y.a + y.b + y.c === 0 : y[box] === 0))
      return x ? Math.round(x.t - p.lift) : -1
    }
    const relit = (p: Phrase) => {
      const dark = p.s.find((y) => y.t > p.lift && y.a + y.b + y.c === 0)
      return dark ? p.s.some((y) => y.t > dark.t && y.a + y.b + y.c > 0) : false
    }
    const each = (['a', 'b', 'c'] as const).map((box) => off(onPult, box))
    const pultOff = off(onPult, 'all')
    const hallOff = off(inHall, 'all')
    check(
      lit(near(onPult, onPult.lift)) && lit(near(inHall, inHall.lift + 300)),
      '19. a pointer phrase: the first stroke still shines when the third lifts',
      `red per stroke at the last lift: console ${say(near(onPult, onPult.lift))} · hall ${say(near(inHall, inHall.lift + 300))}`,
    )
    check(
      lit(near(onPult, onPult.lift + 1200)) && lit(near(inHall, inHall.lift + 1200)),
      '19. the whole phrase still shines 1.2 s after the last lift',
      `console ${say(near(onPult, onPult.lift + 1200))} · hall ${say(near(inHall, inHall.lift + 1200))}`,
    )
    check(
      pultOff >= 1800 &&
        pultOff <= 2600 &&
        Math.min(...each) >= 0 &&
        Math.max(...each) - Math.min(...each) <= 250 &&
        !relit(onPult) &&
        hallOff >= 1700 &&
        hallOff <= 2900 &&
        !relit(inHall),
      '19. …and goes out whole 2.1–2.6 s after the last lift, everywhere',
      `console dark after ${pultOff} ms (strokes ${each.join(' / ')} ms) · hall dark after ${hallOff} ms · relit: console ${relit(onPult) ? 'yes' : 'no'}, hall ${relit(inHall) ? 'yes' : 'no'}`,
    )
    await pult.js(press(PULT.pen))
    await wait(300)
  }

  /* ----------------------------------- 20. the highlighter lies under the ink */

  {
    /*
     * The highlighter goes UNDER the pen: on a canvas of its own at the
     * bottom of the ink layer (`ink-mark`), multiplied with the page, so a
     * pen line and the slide's text under a highlight stay crisp. A marker
     * drawn over a pen line must land there on both screens, never on the
     * pen ink's canvas, where it would cover the line.
     */
    await penTool()
    await stroke([[0.2, 0.62], [0.6, 0.62]], { speed: 200 })
    await pult.js(press(PULT.marker))
    await wait(200)
    const markerOn = await pult.js(`return ${pressed(PULT.marker)}`)
    await stroke([[0.17, 0.62], [0.63, 0.625]], { speed: 260 })
    const yellow = (cls: string) =>
      `(()=>{const c=document.querySelector('canvas.${cls}');if(!c||c.width<2) return 0;` +
      `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;` +
      `for(let i=0;i<d.length;i+=4) if(d[i+3]>16&&d[i]>200&&d[i+1]>150&&d[i+2]<120) n+=1;return n})()`
    const penInk = (cls: string) =>
      `(()=>{const c=document.querySelector('canvas.${cls}');if(!c||c.width<2) return 0;` +
      `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;` +
      `for(let i=0;i<d.length;i+=4) if(d[i+3]>200&&d[i]+d[i+1]+d[i+2]<250) n+=1;return n})()`
    // The console's own strokes are wet until their echo: wait until both have settled.
    await until(
      pult,
      `${yellow('ink-mark')} > 0 && ${yellow('ink-wet')} === 0 && ${penInk('ink-dry')} > 0`,
      'the highlight and the line settled on the console',
      8000,
    )
    await until(student, `${yellow('ink-mark')} > 0 && ${penInk('ink-dry')} > 0`, 'the highlight reached the hall', 8000)
    const look = (tab: Tab) =>
      tab.js(
        `const m=document.querySelector('canvas.ink-mark'),k=document.querySelector('canvas.ink-dry');` +
          `return {mark:${yellow('ink-mark')},dry:${yellow('ink-dry')},wet:${yellow('ink-wet')},pen:${penInk('ink-dry')},` +
          `blend:m?getComputedStyle(m).mixBlendMode:'none',under:!!m&&!!k&&!!(m.compareDocumentPosition(k)&Node.DOCUMENT_POSITION_FOLLOWING)}`,
      ) as Promise<{ mark: number; dry: number; wet: number; pen: number; blend: string; under: boolean }>
    const here = await look(pult)
    const there = await look(student)
    const ok = (s: typeof here) => s.mark > 0 && s.dry === 0 && s.wet === 0 && s.pen > 0 && s.blend === 'multiply' && s.under
    const words = (s: typeof here) =>
      `highlight on ink-mark ${s.mark} px, on ink-dry ${s.dry}, on ink-wet ${s.wet} · pen line ${s.pen} px · ${s.blend}${s.under ? ', under the ink' : ', NOT under the ink'}`
    check(
      markerOn === 'true' && ok(here) && ok(there),
      '20. the highlighter lies under the pen ink, on its own canvas, on both screens',
      `console: ${words(here)} · hall: ${words(there)}`,
    )
    await shoot(`highlighter-${W}x${H}`)
    await penTool()
    await clean()
  }

  /* --------------------------------------- 21. sheets: made, walked, deleted */

  {
    /*
     * "НОВЫЙ ЛИСТ" TWICE, AND THE LECTURE KNOWS BOTH. The server owns the
     * list: a press asks for a sheet right after the page on screen, the
     * server numbers it, puts it there and turns the hall to it, and the
     * console follows. Labels go by place ("Л2", "лист 2 из 2"), the strip
     * (the ribbon in portrait) shows both in place, "Back" walks from Л2
     * through Л1 to the slide, and a sheet goes from its own menu with a
     * question that names its strokes, moving the hall back one step.
     */
    const landscape = W > H
    const STRIP = landscape ? '[data-pult-film]' : '[data-pult-ribbon]'
    const gaugeJs = `((document.querySelector('[aria-label=${JSON.stringify(PULT.gauge)}]')?.innerText)||'').replace(/\\s+/g,' ').trim()`
    const gaugeWords = () => pult.js(`return ${gaugeJs}`) as Promise<string>
    const hallSays = () =>
      student.js(`return ((/лист \\d+ из \\d+/i.exec(document.body.innerText||'')||[''])[0]).toLowerCase()`) as Promise<string>
    const tiles = () =>
      pult.js(
        `const s=document.querySelector(${JSON.stringify(STRIP)});if(!s) return [];` +
          `return [...s.querySelectorAll('[data-pult-page]')].map(b=>({page:+b.getAttribute('data-pult-page'),name:b.getAttribute('aria-label'),current:b.getAttribute('aria-current')==='page'}))`,
      ) as Promise<{ page: number; name: string; current: boolean }[]>
    const tileWords = (list: { page: number; name: string; current: boolean }[]) =>
      list.map((t) => `${t.name}${t.current ? ' (current)' : ''}`).join(' · ') || 'no tiles'
    const menuKey = `document.querySelector('[data-pult-menu-key]')`
    const openMenu = async (): Promise<boolean> => {
      await until(pult, `!!${menuKey}`, 'the current sheet offers its menu', 4000)
      await pult.js(`const b=${menuKey};if(!b) throw new Error('the current sheet has no menu key'); b.click(); return 1`)
      return until(pult, `!!document.querySelector('[data-pult-menu]')`, 'the sheet menu opened', 4000)
    }

    await noSheets()
    await pult.js(press(PULT.newSheet))
    const one = await untilHere(
      () => sheetsNow().length === 1 && hallPage() === sheetsNow()[0].page,
      'the first sheet, and the hall on it',
      8000,
    )
    const p1 = sheetsNow()[0]?.page ?? 0
    await until(pult, `/Л\\s*1/.test(${gaugeJs})`, 'the console followed the hall to Л1', 6000)
    await pult.js(press(PULT.newSheet))
    const two = await untilHere(
      () => sheetsNow().length === 2 && hallPage() === sheetsNow().find((s) => s.page !== p1)?.page,
      'the second sheet, and the hall on it',
      8000,
    )
    const p2 = sheetsNow().find((s) => s.page !== p1)?.page ?? 0
    await until(pult, `/Л\\s*2/.test(${gaugeJs})`, 'the console followed the hall to Л2', 6000)
    await until(student, `/лист 2 из 2/i.test(document.body.innerText||'')`, 'the hall says "лист 2 из 2"', 6000)
    const gauge2 = await gaugeWords()
    const hall2 = await hallSays()
    const order = sheetsNow()
      .map((s) => `${s.page}@${s.after}`)
      .join(' ')
    check(
      one &&
        two &&
        p1 < 0 &&
        p2 < 0 &&
        order === `${p1}@1 ${p2}@1` &&
        /Л\s*2/.test(gauge2) &&
        (landscape ? /лист 2 из 2/i.test(gauge2) : /лист/i.test(gauge2)) &&
        hall2 === 'лист 2 из 2',
      '21. «Новый лист» twice: Л1 and Л2 after the slide, the hall on Л2',
      `sheets ${order || 'none'} · hall on ${hallPage()} ("${hall2}") · gauge "${gauge2}"`,
    )
    const shown = await tiles()
    const at = (page: number) => shown.findIndex((t) => t.page === page)
    check(
      shown[at(p1)]?.name === 'Лист 1' &&
        shown[at(p2)]?.name === 'Лист 2' &&
        shown[at(p2)]?.current === true &&
        at(1) >= 0 &&
        at(1) < at(p1) &&
        at(p1) < at(p2) &&
        (at(2) < 0 || at(p2) < at(2)),
      `21. the ${landscape ? 'strip' : 'ribbon'} shows both sheets in place, Л2 current`,
      tileWords(shown),
    )
    await shoot(`sheets-${W}x${H}`)

    // One stroke on Л2, for the question before it goes.
    await until(
      pult,
      `!!document.querySelector('.ink-input')?.className.includes('pointer-events-auto')`,
      'the pen is live on the sheet',
      6000,
    )
    await stroke([[0.3, 0.4], [0.6, 0.45]], { speed: 200 })
    const inked = await untilHere(() => inkPageOf(ROOM, p2).length === 1, 'the stroke on Л2 reached the server', 6000)

    await pult.js(press(PULT.prev))
    const toL1 = await untilHere(() => hallPage() === p1, 'Back went to Л1', 6000)
    await until(pult, `/Л\\s*1/.test(${gaugeJs})`, 'the console on Л1', 6000)
    const gauge1 = await gaugeWords()
    await pult.js(press(PULT.prev))
    const toSlide = await untilHere(() => hallPage() === 1, 'Back went on to the slide', 6000)
    await until(student, `${hallExpr} === '1'`, 'the hall shows slide 1', 6000)
    const gaugeSlide = (await measure()).gauge
    // On the slide, "next" is the sheet after it: the strip's next tile, or the footer's words.
    const nextHere = (await pult.js(
      landscape
        ? `const n=document.querySelector('[data-pult-film] [data-pult-next]');return n?n.getAttribute('data-pult-page')+' '+(n.innerText||'').replace(/\\s+/g,' ').trim():''`
        : `const n=document.querySelector('[data-pult-next]');return n?[...n.children].filter(e=>!e.matches('[data-pult-ribbon]')).map(e=>e.innerText||'').join(' ').replace(/\\s+/g,' ').trim():''`,
    )) as string
    check(
      inked &&
        toL1 &&
        /Л\s*1/.test(gauge1) &&
        toSlide &&
        gaugeSlide === '1' &&
        (landscape ? nextHere.startsWith(`${p1} `) && /Л1\s*·\s*дальше/i.test(nextHere) : /Лист 1/.test(nextHere)),
      '21. «Back» walks from Л2 through Л1 to the slide, where "next" is Л1',
      `Л2 → ${toL1 ? 'Л1' : hallPage()} (gauge "${gauge1}") → ${toSlide ? 'slide 1' : hallPage()} (gauge ${gaugeSlide || '—'}) · next "${nextHere}"`,
    )

    // Forward again through Л1 to Л2, and its menu.
    await pult.js(press(PULT.next))
    await untilHere(() => hallPage() === p1, 'Next went to Л1', 6000)
    await until(pult, `/Л\\s*1/.test(${gaugeJs})`, 'the console on Л1', 6000)
    await pult.js(press(PULT.next))
    await untilHere(() => hallPage() === p2, 'Next went to Л2', 6000)
    await until(pult, `/Л\\s*2/.test(${gaugeJs})`, 'the console on Л2', 6000)
    const menuOpen = await openMenu()
    const menuName = (await pult.js(`return document.querySelector('[data-pult-menu]')?.getAttribute('aria-label') ?? ''`)) as string
    await pult.js(
      `const b=document.querySelector('[data-pult-menu] [data-paper="grid"]');if(!b) throw new Error('no "Клетка" in the menu'); b.click(); return 1`,
    )
    const ruled = await untilHere(() => sheetsNow().find((s) => s.page === p2)?.paper === 'grid', 'the paper reached the server', 4000)
    await until(
      pult,
      `document.querySelector('[data-pult-menu] [data-paper="grid"]')?.getAttribute('aria-checked')==='true'`,
      'the menu marks the new paper',
      3000,
    )
    const stays = (await pult.js(
      `return !!document.querySelector('[data-pult-menu]') && document.querySelector('[data-pult-menu] [data-paper="grid"]')?.getAttribute('aria-checked')==='true'`,
    )) as boolean
    check(
      menuOpen && menuName === 'Лист 2 из 2' && ruled && stays,
      "21. the current sheet's tile opens its menu, and «Клетка» rules it at once",
      `menu ${menuOpen ? `"${menuName}"` : 'did not open'} · paper on the server ${sheetsNow().find((s) => s.page === p2)?.paper ?? 'plain'} · menu ${stays ? 'stays, «Клетка» checked' : 'closed or unchecked'}`,
    )
    if (landscape) {
      /*
       * The strip's tile is a picture of the sheet: its paper and its ink
       * (SheetCard), redrawn a moment after the pen lifts. It is by its ink
       * that one finds "the sheet where I derived the limit" again. (The
       * portrait ribbon's chips carry the paper and "Л2", not the ink.)
       */
      const tile = JSON.stringify(`${STRIP} [data-pult-page="${p2}"]`)
      const tileInk = `[...(document.querySelector(${tile})?.querySelectorAll('svg path')??[])].filter(p=>p.getAttribute('stroke-linejoin')==='round').length`
      const pictured = await until(pult, `${tileInk} === 1`, "Л2's tile shows its stroke", 4000)
      const ruledTile = await pult.js(`return !!document.querySelector(${tile})?.querySelector('svg path[stroke="#dce2ee"]')`)
      check(
        pictured && ruledTile === true,
        "21. Л2's tile in the strip shows its paper and its stroke",
        `${await pult.js(`return ${tileInk}`)} ink path(s) on the tile · paper ${ruledTile ? 'ruled' : 'plain'}`,
      )
    }
    await shoot(`sheet-menu-${W}x${H}`)
    await pult.js(press(PULT.dropSheet))
    await until(pult, `!!document.querySelector('[data-pult-drop]')`, 'the question before deleting', 4000)
    const question2 = (await pult.js(
      `return (document.querySelector('[data-pult-menu]')?.innerText||'').replace(/\\s+/g,' ').trim()`,
    )) as string
    await pult.js(`document.querySelector('[data-pult-drop]').click(); return 1`)
    const dropped = await untilHere(
      () => sheetsNow().length === 1 && sheetsNow()[0].page === p1 && hallPage() === p1,
      'Л2 is gone and the hall is on Л1',
      8000,
    )
    await until(pult, `/Л\\s*1/.test(${gaugeJs})`, 'the console on Л1', 6000)
    await until(student, `/лист 1 из 1/i.test(document.body.innerText||'')`, 'the hall says "лист 1 из 1"', 6000)
    const hall1 = await hallSays()
    const left = (await tiles()).filter((t) => t.page < 0)
    check(
      /Удалить лист 2 и его 1 штрих\?/.test(question2) &&
        dropped &&
        inkPageOf(ROOM, p2).length === 0 &&
        hall1 === 'лист 1 из 1' &&
        left.length === 1 &&
        left[0].page === p1,
      '21. Л2 goes from its menu, its stroke with it, and the hall moves back to Л1',
      `asked "${question2}" · sheets ${sheetsNow().map((s) => s.page).join(',') || 'none'} · hall on ${hallPage()} ("${hall1}") · ${landscape ? 'strip' : 'ribbon'}: ${tileWords(left)}`,
    )

    // The empty Л1 too: the question says it is empty, and the hall is back on the slide.
    const menuAgain = await openMenu()
    await pult.js(press(PULT.dropSheet))
    await until(pult, `!!document.querySelector('[data-pult-drop]')`, 'the question before deleting', 4000)
    const question1 = (await pult.js(
      `return (document.querySelector('[data-pult-menu]')?.innerText||'').replace(/\\s+/g,' ').trim()`,
    )) as string
    await pult.js(`document.querySelector('[data-pult-drop]')?.click(); return 1`)
    const none = await untilHere(() => sheetsNow().length === 0 && hallPage() === 1, 'no sheets, the hall on slide 1', 8000)
    await until(student, `${hallExpr} === '1'`, 'the hall shows slide 1', 6000)
    const gaugeEnd = (await measure()).gauge
    check(
      menuAgain && /Удалить пустой лист 1\?/.test(question1) && none && gaugeEnd === '1',
      '21. the empty Л1 goes too, and the hall is back on the slide',
      `asked "${question1}" · sheets ${sheetsNow().length} · hall on ${hallPage()} · gauge ${gaugeEnd || '—'}`,
    )
    await noSheets()
  }

  /* ------------------------------ 22. a pen held still straightens the line */

  {
    /*
     * HOLD THE PEN AT THE END AND THE LINE STRAIGHTENS (ink.ts ·
     * STRAIGHT_HOLD_MS 550): a slightly wobbly line rests under a pen held
     * perfectly still (no events at all, as a resting Pencil may send none),
     * and on the console, and only there, a ring closes round the tip
     * (`window.__inkLat.hold`): nothing for the first 150 ms of the rest, then
     * closing, full at the snap, gone right after it. On the lift the room
     * gets the line as ONE stroke of two points, the freehand taken back, and
     * one Undo removes it whole.
     */
    await penTool()
    await clean()
    const g = await geometry()
    const pen = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', fx: number, fy: number) =>
      pult.send('Input.dispatchMouseEvent', {
        type,
        ...onCanvas(g, fx, fy),
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
        pointerType: 'pen',
        force: type === 'mouseReleased' ? 0 : 0.5,
      })
    await pult.js(
      `const w={s:[],stop:false,t0:performance.now(),rest:-1};window.__ring=w;` +
        `const tick=()=>{if(w.stop) return;const h=window.__inkLat&&window.__inkLat.hold;` +
        `w.s.push({t:performance.now()-w.t0,c:h?h.closed:-1});requestAnimationFrame(tick)};requestAnimationFrame(tick);return 1`,
    )
    const wobble = (i: number) => 0.5 + 0.004 * Math.sin(i * 1.7)
    await pen('mousePressed', 0.2, wobble(0))
    for (let i = 1; i <= 24; i += 1) {
      await wait(8)
      await pen('mouseMoved', 0.2 + 0.4 * (i / 24), wobble(i))
    }
    await pult.js(`window.__ring.rest=performance.now()-window.__ring.t0;return 1`)
    await wait(900)
    await pen('mouseReleased', 0.6, wobble(24))
    const ring = (await pult.js(`const w=window.__ring;w.stop=true;return {rest:w.rest,s:w.s}`)) as {
      rest: number
      s: { t: number; c: number }[]
    }
    const after = ring.s.filter((x) => x.t >= ring.rest)
    const firstShown = after.find((x) => x.c >= 0)
    const closing = after.some((x) => x.c >= 0.2 && x.c <= 0.8)
    const full = after.find((x) => x.c >= 0.999)
    const gone = full ? after.find((x) => x.t > full.t && x.c < 0) : undefined
    const one = await untilHere(
      () => inkPageOf(ROOM, 1).length === 1 && inkPageOf(ROOM, 1)[0].points.length === 4,
      'the room has the straight line alone',
      6000,
    )
    const line = inkPageOf(ROOM, 1)[0]
    const straight =
      one &&
      Math.abs(line.points[0] - 0.2) <= 0.01 &&
      Math.abs(line.points[2] - 0.6) <= 0.01 &&
      Math.abs(line.points[1] - 0.5) <= 0.01 &&
      Math.abs(line.points[3] - 0.5) <= 0.01
    const hallLine = await boxUntil(hallInk, (box) => !!box && box.x1 - box.x0 > 0.35 && box.y1 - box.y0 < 0.03)
    check(
      !!firstShown &&
        firstShown.t - ring.rest >= 100 &&
        closing &&
        !!full &&
        full.t - ring.rest >= 450 &&
        !!gone &&
        gone.t - full.t <= 300 &&
        straight &&
        !!hallLine &&
        hallLine.x1 - hallLine.x0 > 0.35 &&
        hallLine.y1 - hallLine.y0 < 0.03,
      '22. a pen held still straightens the line, and a ring on the console counts it down',
      `ring: shown ${firstShown ? Math.round(firstShown.t - ring.rest) : '—'} ms into the rest, closing ${closing ? 'seen' : 'not seen'}, full at ${full ? Math.round(full.t - ring.rest) : '—'} ms, gone ${gone && full ? Math.round(gone.t - full.t) : '—'} ms later · room: ${inkPageOf(ROOM, 1).length} stroke(s), ${line ? line.points.map((n) => n.toFixed(3)).join(',') : '—'} · hall ${boxWords(hallLine)}`,
    )
    await pult.js(press(PULT.undo))
    const undone = await untilHere(() => inkPageOf(ROOM, 1).length === 0, 'Undo took the line back', 6000)
    check(undone, '22. one Undo takes the straight line back whole', `${inkPageOf(ROOM, 1).length} stroke(s) left`)
    await clean()
  }

  if (!first) continue

  /* ------------------------ 12. a hundred wet strokes, then the pointer */

  {
    /*
     * The wire is mute: there is no echo, a hundred strokes stay wet. After
     * that the pointer must move just as it does on a clean sheet: that is what
     * proves the live canvas does not redraw the wet ones on every frame.
     */
    await mute()
    for (let i = 0; i < 100; i += 1) {
      const y = 0.1 + 0.8 * (i / 99)
      await stroke(
        [
          [0.1, y],
          [0.3 + 0.02 * (i % 5), y + 0.01],
        ],
        { speed: 40, via: 'dom', id: 1 },
      )
    }
    const wetNow = (await measure()).wet.all
    await pult.js(press(PULT.laser))
    await wait(200)
    const pts: [number, number][] = Array.from({ length: 40 }, (_, i) => [
      0.15 + 0.7 * (i / 39),
      0.5 + 0.25 * Math.sin((i / 39) * Math.PI * 2),
    ])
    const loaded = await laserHold(pts, 8)
    await pult.js(press(PULT.pen))
    await wait(200)
    await unmute()
    // The thresholds are the same as in §8: see the comment there.
    check(
      wetNow > 0 &&
        loaded.slowFrames <= Math.ceil(loaded.frameGaps * 0.2) &&
        loaded.worstFrame <= 350 &&
        loaded.jumps <= Math.ceil(loaded.moving * 0.2),
      '12. the pointer over a hundred wet strokes does not lag',
      `wet pixels ${wetNow} · frames longer than 34 ms: ${loaded.slowFrames}/${loaded.frameGaps} · worst ${loaded.worstFrame} ms · frame ${loaded.frameMs} ms · jumps ${loaded.jumps}`,
    )
    // The resend after the wire comes back must not bring down the page: we just clean up.
    await wait(1500)
    await clean()
  }

  /* --------------------- 13. echo on a slow processor: no flashes */

  {
    /*
     * An observer in the page counts the ink of a band on the wet and dry
     * canvases together every 80 ms. A stroke that "went out and came back"
     * (the wet one erased before the dry one is drawn) gives a zero between
     * two non-zeros, and in the hall that shows as blinking. Only the band area
     * is counted, otherwise the polling itself would press on the slowed-down
     * processor harder than the console.
     */
    const b6 = bands(6)
    await pult.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await pult.js(
      `const wet=document.querySelector('canvas.ink-wet'),dry=document.querySelector('canvas.ink-dry');` +
        `const W=wet.width,H=wet.height;const bands=${JSON.stringify(b6)};` +
        `const x0=Math.floor(W*0.1),x1=Math.ceil(W*0.6),y0=Math.floor(H*0.2),y1=Math.ceil(H*0.8);` +
        `const count=c=>{const d=c.getContext('2d').getImageData(x0,y0,x1-x0,y1-y0).data;const per=bands.map(()=>0);const bw=x1-x0;` +
        `for(let i=0;i<d.length;i+=4){if(d[i+3]<=16) continue;const y=(y0+((i/4)/bw|0))/H;` +
        `for(let b=0;b<bands.length;b+=1) if(y>=bands[b][0]&&y<bands[b][1]) per[b]+=1}return per};` +
        `const w={samples:[],stop:false};window.__flash=w;` +
        `const tick=()=>{if(w.stop) return;const a=count(wet),b=count(dry);w.samples.push(a.map((n,i)=>n+b[i]));setTimeout(tick,80)};tick();return 1`,
    )
    await rapidStrokes(6, { speed: 120 })
    await settled(b6)
    await wait(600)
    const samples = (await pult.js(
      `window.__flash.stop=true; return window.__flash.samples`,
    )) as number[][]
    await pult.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const m = await measure(b6)
    const flashes: number[] = []
    for (let bnd = 0; bnd < 6; bnd += 1) {
      let seen = false
      for (const s of samples) {
        if (s[bnd] > 0) seen = true
        else if (seen) {
          flashes.push(bnd + 1)
          break
        }
      }
    }
    check(
      m.student.dry.bands.every((n) => n > 0),
      '13. six strokes on a slow processor reach the hall',
      `student ${m.student.dry.bands.join(' / ')} px`,
    )
    check(
      flashes.length === 0 && samples.length > 5,
      '13. a stroke does not blink between wet and dry',
      flashes.length
        ? `bands went out: ${flashes.join(', ')} (${samples.length} samples)`
        : `${samples.length} samples, no dips`,
    )
    await clean()
  }

  /* --------------------------- 14. what used to work and must not be broken */

  {
    const g = await geometry()
    const b1 = bands(1)
    // Eraser: a hovering pen means a ring on the live canvas; a press erases.
    await rapidStrokes(1)
    await settled(b1)
    await pult.js(press(PULT.eraser))
    await wait(200)
    // The second point of the `rapidStrokes` stroke: x=0.35, y=the top of the band + 15 % of its height.
    const [top, bottom] = band(0, 1)
    const spot = onCanvas(g, 0.35, top + (bottom - top) * 0.15)
    for (let i = 0; i < 6; i += 1) {
      await hover({ x: spot.x - 30 + i * 5, y: spot.y })
      await wait(16)
    }
    const ring = await until(pult, `${inkExpr('ink-live', [])}.any > 0`, 'the eraser ring', 2000)
    const ringPx = (await measure()).live.any
    await strokeAt(
      [
        { x: spot.x - 40, y: spot.y - 6 },
        { x: spot.x + 40, y: spot.y + 6 },
      ],
      { speed: 200 },
    )
    const erased = await until(
      student,
      `${inkExpr('ink-dry', b1)}.bands[0] === 0`,
      'the stroke was erased for the student',
      8000,
    )
    const left = await measure(b1)
    check(
      ring && erased,
      '14. eraser: a ring under the pen, erasing on press',
      `ring ${ringPx} px on the live canvas · student ${erased ? 'erased' : `${left.student.dry.bands[0]} px left`} · console ${pultBands(left)[0]} px`,
    )
    await penTool()
    await clean()

    // The palm does not press the rail keys while the pen writes.
    const railBtn = await pult.js(
      `const b=document.querySelector('[aria-label=${JSON.stringify(PULT.next)}]');const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}`,
    )
    const pageBefore = (await measure()).hall
    await stroke(
      [
        [0.2, 0.4],
        [0.5, 0.45],
      ],
      {
        speed: 400,
        midway: async () => {
          const c = { id: 921, x: railBtn.x, y: railBtn.y, r: 14 }
          await palm.dom('pointerdown', c, true)
          await palm.dom('pointerup', c, true)
          // Chrome's `click` is a PointerEvent with the same pointerId and pointerType as the touch.
          await pult.js(
            `const b=document.querySelector('[aria-label=${JSON.stringify(PULT.next)}]');` +
              `b.dispatchEvent(new PointerEvent('click',{bubbles:true,cancelable:true,pointerId:${c.id},pointerType:'touch',clientX:${c.x},clientY:${c.y}})); return 1`,
          )
        },
      },
    )
    await wait(800)
    const pageAfter = (await measure()).hall
    check(
      pageBefore === pageAfter,
      '14. the palm does not press the rail keys while writing',
      `hall ${pageBefore} → ${pageAfter}`,
    )
    if (pageBefore !== pageAfter) {
      await pult.js(press(PULT.prev))
      await wait(600)
    }
    await clean()

    // Turning the page mid-stroke closes the stroke, it does not erase it: the stroke stays on the previous page.
    await stroke(
      [
        [0.2, 0.4],
        [0.6, 0.5],
      ],
      { speed: 400, midway: () => key('ArrowRight', 39) },
    )
    await until(student, `${hallExpr} === '2'`, 'the hall is on the second page', 8000)
    await pult.js(press(PULT.prev))
    await until(student, `${hallExpr} === '1'`, 'the hall is back', 8000)
    const kept = await until(
      student,
      `${inkExpr('ink-dry', [])}.all > 0`,
      'the stroke stayed on the first',
      6000,
    )
    check(
      kept,
      '14. turning the page mid-stroke closes the stroke instead of erasing it',
      kept ? 'the stroke on the first page is intact' : 'no stroke',
    )
    await clean()

    // A connection drop: undo answers with a refusal instead of firing later.
    await rapidStrokes(1)
    await settled(b1)
    const beforeCut = (await measure(b1)).student.dry.bands[0]
    const closing = (await cut()) as string[]
    /*
     * Closing is a handshake, not an instant: right after `close()` the socket
     * is CLOSING, and the console learns of the drop only from `onclose`. We
     * wait not for the socket but for the console itself: on a drop the rail
     * changes its edge to `border-danger/40`.
     */
    const offlineShown = await until(
      pult,
      `!!document.querySelector('.pult-rail') && document.querySelector('.pult-rail').className.includes('danger')`,
      'the console saw the drop',
      4000,
    )
    /*
     * Undo RIGHT AWAY, as soon as the console shows the drop, and only then
     * measure: the control socket reconnects within a second or two, and
     * measuring the ink on two tabs costs just as much. An undo pressed on a
     * live connection already is a legitimate undo, and the harness would catch
     * it as a "deferred action".
     *
     * There are two ways to undo: a tap on the key and Z. The key may be
     * `disabled` during a drop: then `.click()` is deaf, and that is a refusal
     * too, just a mute one; at least one of the ways must speak, and the
     * stroke must survive in both.
     */
    const toastAfter = () =>
      pult.js(
        `return [...document.querySelectorAll('[aria-live]')].map(e=>(e.innerText||'').trim()).filter(Boolean).join(' | ')`,
      ) as Promise<string>
    await pult.js(press(PULT.undo))
    await wait(150)
    let toast = await toastAfter()
    let via = 'tap'
    if (!/нет связи/i.test(toast)) {
      await key('z', 90, 'KeyZ')
      await wait(150)
      toast = await toastAfter()
      via = 'Z'
    }
    const atCut = (await measure(b1)).student.dry.bands[0]
    const back = await until(pult, `!!(${liveSocket})`, 'the console reconnected', 15000)
    await wait(1200)
    const after = await measure(b1)
    check(
      offlineShown &&
        /нет связи/i.test(toast) &&
        back &&
        beforeCut > 0 &&
        atCut > 0 &&
        after.student.dry.bands[0] > 0,
      '14. undo during a drop — a refusal by toast, not a deferred action',
      `drop ${offlineShown ? 'shown' : 'not shown'} · toast (${via}) "${toast || '—'}" · connection ${back ? 'back' : 'no'} · stroke at the student: before the drop ${beforeCut} px, during the drop ${atCut} px, after ${after.student.dry.bands[0]} px · cut ${closing.join(' ')}`,
    )
    await clean()
  }
}

/* ------------------------------------------- the rail fits every window */

/*
 * THE RAIL FITS, AND "NEXT" IS NEVER CUT OFF.
 *
 * Full screen is only on request, so a tablet in ordinary Safari loses its
 * toolbars' height: 1180×746 and 1180×706 on an 11", 1133×744 on an iPad
 * mini even in full screen, 744 and 678 wide in portrait and Split View. The
 * rail used to need 816 px and cut "Next" in all of them. Every rail key,
 * and both turn keys above all, must lie inside the window. The prompter is
 * checked too: its rail and its reader, and no ink layer under them.
 */
if (!RAZBOR && !sizeArg) {
  const railOutside =
    `(()=>{const out=[];for(const b of document.querySelectorAll('.pult-rail button')){const r=b.getBoundingClientRect();` +
    `if(r.width===0) continue;if(r.left<-0.5||r.top<-0.5||r.right>innerWidth+0.5||r.bottom>innerHeight+0.5)` +
    `out.push((b.getAttribute('aria-label')||b.textContent.trim()).slice(0,20)+'@'+Math.round(r.left)+','+Math.round(r.top))}return out})()`
  const turnInside =
    `[${JSON.stringify(PULT.prev)},${JSON.stringify(PULT.next)}].every(n=>{const b=document.querySelector('.pult-rail [aria-label='+JSON.stringify(n)+']');` +
    `if(!b) return false;const r=b.getBoundingClientRect();return r.top>=0&&r.left>=0&&r.bottom<=innerHeight+0.5&&r.right<=innerWidth+0.5&&r.height>=40})`
  for (const [W, H] of [
    [1180, 746],
    [1180, 706],
    [1133, 744],
    [1133, 672],
    [744, 1133],
    [678, 1024],
  ] as const) {
    where = `[${W}×${H}]`
    const opened = await open(W, H)
    const outside = (await pult.js(`return ${railOutside}`)) as string[]
    const turn = (await pult.js(`return ${turnInside}`)) as boolean
    check(
      opened && outside.length === 0 && turn,
      'the rail fits the window, "Back" and "Next" whole',
      outside.length ? `outside: ${outside.join(' · ')}` : `all keys inside · turn keys ${turn ? 'whole' : 'cut'}`,
    )
    /*
     * A tight rail gives keys up rather than overflow, but never the
     * magnifier or "＋ Лист" for good: what has no room on the rail is a row
     * of "More".
     */
    const onRail = async (name: string): Promise<boolean> =>
      (await pult.js(`return !!document.querySelector('.pult-rail [aria-label=${JSON.stringify(name)}]')`)) === true
    const where2 = { zoom: (await onRail(PULT.zoom)) ? 'rail' : '', sheet: (await onRail(PULT.newSheet)) ? 'rail' : '' }
    if (!where2.zoom || !where2.sheet) {
      await pult.js(press(PULT.more))
      await until(pult, `!!document.querySelector('.pult-drawer')`, 'the "More" sheet', 3000)
      const rows = (await pult.js(
        `return [...document.querySelectorAll('.pult-drawer button')].map(b=>(b.innerText||'').replace(/\\s+/g,' ').trim())`,
      )) as string[]
      if (!where2.zoom && rows.some((r) => r.startsWith(PULT.zoom))) where2.zoom = 'More'
      if (!where2.sheet && rows.some((r) => r.startsWith(PULT.newSheet))) where2.sheet = 'More'
      await key('Escape', 27)
      await until(pult, `!document.querySelector('.pult-drawer')`, 'the "More" sheet closed', 3000)
    }
    check(
      opened && !!where2.zoom && !!where2.sheet,
      'the magnifier and «Новый лист» are on the rail or in "More"',
      `magnifier: ${where2.zoom || 'nowhere'} · «Новый лист»: ${where2.sheet || 'nowhere'}`,
    )
    if (SHOT) {
      const shot = await pult.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path.resolve(`pencil-check-rail-${W}x${H}.png`), Buffer.from(shot.result.data as string, 'base64'))
    }
  }
  for (const [W, H] of [
    [1180, 820],
    [834, 1194],
  ] as const) {
    where = `[${W}×${H} prompter]`
    await tablet(W, H)
    await pult.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/s/${ROOM}/pult` })
    await until(pult, `!!document.querySelector('.pult-root')`, 'the console root')
    await pult.js(`localStorage.setItem('colloq.pult.view','tele'); return 1`)
    await pult.send('Page.reload')
    const drawn = await until(pult, `!!document.querySelector('.pult-reader')`, 'the prompter drew the notes', 15000)
    await wait(600)
    const state = (await pult.js(
      `const r=document.querySelector('.pult-reader')?.getBoundingClientRect();` +
        `return {reader:r?Math.round(r.width)+'x'+Math.round(r.height):'none',ink:!!document.querySelector('.ink-input'),outside:${railOutside},turn:${turnInside},` +
        `font:getComputedStyle(document.querySelector('.pult-prose')||document.body).fontSize}`,
    )) as { reader: string; ink: boolean; outside: string[]; turn: boolean; font: string }
    check(
      drawn && !state.ink && state.outside.length === 0 && state.turn && parseFloat(state.font) >= 22,
      'the prompter: notes over the screen, no ink, the rail whole',
      `reader ${state.reader} at ${state.font} · ink layer ${state.ink ? 'present' : 'none'} · outside ${state.outside.join(' · ') || 'none'}`,
    )
    if (SHOT) {
      const shot = await pult.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path.resolve(`pencil-check-prompter-${W}x${H}.png`), Buffer.from(shot.result.data as string, 'base64'))
    }
    await pult.js(`localStorage.setItem('colloq.pult.view','slide'); return 1`)
  }
  where = ''
}

/* ------------------------------------------------------------- report */

for (const [who, page] of [
  ['console', pult],
  ['student', student],
  ['teacher', host],
] as const) {
  for (const line of page.trouble.slice(0, 4)) console.log(`  (${who}) ${line}`)
}

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.what.padEnd(70)} ${r.got}`)
}
console.log(
  failed === 0 ? '\n  the pen and the palm behave as in a notes app' : `\n  failures: ${failed}`,
)

chrome.kill()
spawnSync('rm', ['-rf', root])
process.exit(failed === 0 ? 0 : 1)
