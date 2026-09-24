/**
 * A check of the interface in a real browser.
 *
 * It appeared after a button went out into the room that did nothing: the
 * message handler on the client had not been written, the types matched, the
 * tests were green, and there was nothing to press it with. Everything else in
 * this repository is checked without a browser — and that is exactly why the
 * hole was right here.
 *
 * It drives Chrome over CDP directly, without Playwright: the machine already
 * has the browser, and one more dependency of a hundred and fifty megabytes for
 * ten clicks does not pay off.
 *
 *   npx tsx scripts/ui-check.mts            — bring everything up and check
 *   npx tsx scripts/ui-check.mts --headed   — the same, but with a visible window
 *
 * It brings up an instance of its own, in a temporary directory: running this
 * against a live seminar is not allowed, and that is easy to forget.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WS from 'ws'

const HEADED = process.argv.includes('--headed')
const SELECTION_ONLY = process.argv.includes('--cell-selection-only')
const OUTBOX_ONLY = process.argv.includes('--oracle-outbox-only')
// Ports can be overridden from the environment — to debug the stand itself
// while a full run goes on the regular ones.
const PORT = Number(process.env.UI_CHECK_PORT ?? 3891)
const CDP_PORT = Number(process.env.UI_CHECK_CDP ?? 9334)
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const root = mkdtempSync(path.join(tmpdir(), 'colloq-ui-'))
const ROOM = 'uicheck1'

/* ------------------------------------------------------- a small PDF */

/**
 * A real three-page PDF, put together by hand: no dependencies. The pages are
 * 16:9 (960×540), like lecture slides: the console layout is measured by the
 * share of the screen under the sheet, and for an A4 portrait those thresholds
 * make no sense.
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
/*
 * The image is real, so that the browser really decodes it.
 *
 * A one-pixel GIF: forty-three bytes, not a single dependency and not a single
 * checksum that would have to be computed by hand. It is checked by
 * `naturalWidth`: that is above zero only for an image that arrived and was
 * decoded — a broken `<img>` shows `alt` and zero.
 */
writeFileSync(
  path.join(root, 'workspace', ROOM, 'схема.gif'),
  Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
)

/* ---------------------------------------------------------------- server */

process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
process.env.SESSION_SECRET = 'ui-check'
process.env.PORT = String(PORT)
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`
// The check has no kernel and must not have one: it is about the interface.
process.env.JUPYTER_URL = 'http://127.0.0.1:1'
process.env.NODE_ENV = 'test'
process.env.KERNEL_BACKEND = 'test'
process.env.KERNEL_ISOLATION = 'off'
if (SELECTION_ONLY || OUTBOX_ONLY) process.env.UI_LANGUAGE = 'en'
process.env.STATIC_DIR = path.resolve('web/dist')
/*
 * The Oracle is "configured" but goes nowhere: the key is made up, the address
 * is known to be dead. The check asks no questions; the key is needed exactly
 * so that the panel draws the input line and not the "model is not configured"
 * placeholder — otherwise no check sees half of the panel.
 */
process.env.OPENAI_API_KEY = 'ui-check-not-a-real-key'
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1'

let oracleRequests = 0
if (OUTBOX_ONLY) {
  const http = await import('node:http')
  const gateway = http.createServer((req, res) => {
    req.resume()
    oracleRequests++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Fixture: corrected the failing cell.' } }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    }, 200)
  })
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1`
}

await import('../server/src/index.js')
const { createSession } = await import('../server/src/db.js')
const { createTeacher } = await import('../server/src/admin/store.js')
const { issueStaffCookie } = await import('../server/src/admin/auth.js')
const { STAFF_COOKIE } = await import('../shared/admin.js')
await new Promise((r) => setTimeout(r, 700))
createSession(ROOM, 'Проверка интерфейса', null)
if (SELECTION_ONLY || OUTBOX_ONLY) {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { createCell, cellOutputs, writeOutput } = await import('../shared/notebook.js')
  const { doc } = getSessionDoc(ROOM)
  const cells = doc.getArray('cells')
  doc.transact(() => {
    cells.delete(0, cells.length)
    cells.push([0, 1, 2].map(n => createCell('code', `value_${n} = ${n}`)))
    if (OUTBOX_ONLY) {
      const cell = cells.get(0) as ReturnType<typeof createCell>
      cell.set('state', 'error')
      cellOutputs(cell).push([writeOutput({ kind: 'error', ename: 'NameError', evalue: 'missing is not defined', traceback: ['NameError: missing is not defined'] })])
    }
  })
}
const teacher = createTeacher({ name: 'Ада', email: 'ada@ui.local', role: 'owner' })!
let cookieValue = ''
issueStaffCookie({ cookie: (_n: string, v: string) => (cookieValue = v) } as never, teacher)

/* ---------------------------------------------------------------- browser */

const cdp = `http://127.0.0.1:${CDP_PORT}`

/*
 * Clean up after ourselves on a failure too.
 *
 * The script throws from dozens of places ("no button", "no question field"),
 * and Chrome is started with a plain spawn and outlives node's exit — together
 * with its profile in the temporary directory. The next run opened tabs in that
 * orphan: a participant token is an HMAC over the constant SESSION_SECRET and
 * ROOM, so the saved localStorage passed the check on a fresh server too. The
 * tab entered silently, never saw the login screen, and half the checks blamed
 * the product.
 */
let browser: ReturnType<typeof spawn> | null = null
let cleaned = false
const cleanUp = () => {
  if (cleaned) return
  cleaned = true
  /* SIGKILL, not SIGTERM: on the "polite" signal Chrome tidies up by itself
     and writes the profile AFTER our rm — a chrome/ folder was left over from
     the directory, and over a hundred of them piled up that way. The profile
     is thrown away anyway. */
  browser?.kill('SIGKILL')
  spawnSync('rm', ['-rf', root])
}
process.on('exit', cleanUp)
/* Without its own handler Ctrl-C never reaches 'exit' at all. */
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

/*
 * And if an orphan is left after all (the run was killed with -9, someone
 * else's Chrome on the same port) — say so rather than connect. The waiting
 * loop below reaches anyone who answers on that port and would not notice the
 * difference.
 */
try {
  const busy = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(600) })
  if (busy.ok) {
    console.error(
      `Something already answers on debugging port ${CDP_PORT} — most likely Chrome from the previous run.\n` +
        'Close it or pick another port: UI_CHECK_CDP=9335 npx tsx scripts/ui-check.mts',
    )
    process.exit(1)
  }
} catch {
  /* the port is free — as it should be */
}

browser = spawn(
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

/*
 * Wait until the browser opens the debugging port. One attempt is not enough,
 * and neither is "wait a second": a cold Chrome start on a busy machine takes
 * several.
 */
let up = false
for (let i = 0; i < 80; i += 1) {
  try {
    const res = await fetch(`${cdp}/json/version`)
    if (res.ok) {
      up = true
      break
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error(
    `Chrome did not open the debugging port. Is it at this path at all?\n  ${CHROME}\n` +
      'Another path is set with the CHROME variable.',
  )
  process.exit(1)
}

interface Tab {
  js: (expr: string) => Promise<unknown>
  send: (method: string, params?: Record<string, unknown>) => Promise<any>
  /** What the page has managed to break: exceptions and console errors. */
  trouble: string[]
}

async function tab(url: string): Promise<Tab> {
  const info = (await (
    await fetch(`${cdp}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json()) as { webSocketDebuggerUrl: string }
  const ws = new WS(info.webSocketDebuggerUrl)
  await new Promise<void>((r) => ws.on('open', () => r()))
  let seq = 0
  const waiters = new Map<number, (value: any) => void>()
  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString())
    if (message.id && waiters.has(message.id)) {
      waiters.get(message.id)!(message)
      waiters.delete(message.id)
    }
  })
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = ++seq
      waiters.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  /*
   * Exceptions and console complaints are collected from the very start: a check
   * that keeps quiet about something having crashed on the page sends people
   * looking for the cause in code that has nothing to do with it.
   */
  const trouble: string[] = []
  ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString())
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      trouble.push(
        'exception: ' +
          (d?.exception?.description ??
            [d?.text, d?.exception?.value, d?.exception?.className].filter(Boolean).join(' ') ??
            '?'),
      )
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      trouble.push(
        'console: ' + m.params.args.map((a: any) => a.value ?? a.description ?? a.type).join(' '),
      )
    }
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.enable')
  const js = async (expr: string) => {
    const res = await send('Runtime.evaluate', {
      expression: `(async()=>{${expr}})()`,
      awaitPromise: true,
      returnByValue: true,
    })
    const failed = res.result?.exceptionDetails
    if (failed) throw new Error(failed.exception?.description ?? failed.text)
    return res.result?.result?.value
  }
  return { js, send, trouble }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Get through the login screen under this name. */
async function enter(page: Tab, name: string): Promise<void> {
  await wait(3500)
  if (!(await page.js("return !!document.querySelector('input#join-name')"))) return
  await page.js(
    `const i=document.querySelector('input#join-name');` +
      `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;` +
      `set.call(i,${JSON.stringify(name)}); i.dispatchEvent(new Event('input',{bubbles:true})); return 1`,
  )
  await wait(300)
  await page.js(
    "const b=[...document.querySelectorAll('button')].find(x=>/join/i.test(x.textContent||'')); b&&b.click(); return 1",
  )
  await wait(3500)
}

/* ---------------------------------------------------------------- checks */

const results: { ok: boolean; what: string; got: string }[] = []
const check = (ok: boolean, what: string, got: unknown) =>
  results.push({ ok, what, got: String(got) })

const host = await tab('about:blank')
await host.send('Network.setCookie', {
  name: STAFF_COOKIE,
  value: cookieValue,
  domain: '127.0.0.1',
  path: '/',
})
await host.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/s/${ROOM}` })
await enter(host, 'Ада')

if (SELECTION_ONLY) {
  const { checkCellSelection } = await import('./cell-selection-check.mts')
  await checkCellSelection(host)
  process.exit(0)
}

if (OUTBOX_ONLY) {
  const assert = (await import('node:assert/strict')).default
  assert.equal(await until(host, `[...document.querySelectorAll('button')].some(b=>/fix with ai/i.test(b.textContent))`, 'Fix with AI is available'), true)
  for (let n = 1; n <= 2; n++) {
    await host.js(`const button=[...document.querySelectorAll('button')].find(b=>/fix with ai/i.test(b.textContent)); button.click(); return 1`)
    assert.equal(await until(host, `[...document.querySelectorAll('article')].filter(a=>a.textContent.includes('Fixture: corrected')).length===${n}`, 'the answer arrived'), true)
    // Let the HTTP acknowledgement and document observer both finish.
    await wait(300)
    assert.equal(await host.js(`return document.querySelectorAll('article').length`), n, 'one question has one turn, without a pending duplicate')
    assert.equal(oracleRequests, n, 'one click sends one request to the model')
  }
  await host.send('Page.reload')
  assert.equal(await until(host, `[...document.querySelectorAll('article')].filter(a=>a.textContent.includes('Fixture: corrected')).length===2`, 'the same two turns survive reload'), true)
  assert.equal(await host.js(`return document.querySelectorAll('article').length`), 2)
  assert.deepEqual(host.trouble, [], 'no browser exceptions or console errors')
  console.log('PASS Fix with AI: one turn per click, repeat works, reload shows the same turns')
  process.exit(0)
}

const student = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}`)
await student.send('Network.clearBrowserCookies')
/*
 * And localStorage too — otherwise THE SAME person enters the room in the
 * second tab.
 *
 * A participant's identity lives in localStorage, which is shared by the whole
 * browser profile: the tab silently entered under the saved name, never saw
 * the login screen, and both tabs turned out to be one participant with two
 * cursors. Half the checks about "two people in the room" still passed —
 * presence tells tabs apart, not people — and that is exactly why the
 * substitution went unnoticed.
 */
await student.js('localStorage.clear(); return 1')
await student.send('Page.reload')
await enter(student, 'Нина')

/*
 * The teacher's cookie is set again.
 *
 * `Network.clearBrowserCookies` above clears the WHOLE browser, not one tab —
 * that is, it also throws the teacher out of the panel. This is not noticeable
 * at once: sockets opened before the clearing live on with the old rights, but
 * the next HTTP request already arrives without the cookie, and the server
 * honestly answers "only the teacher can do this". In a real room this does
 * not happen — everyone has their own browser there — so it is fixed here, not
 * in the product.
 */
await host.send('Network.setCookie', {
  name: STAFF_COOKIE,
  value: cookieValue,
  domain: '127.0.0.1',
  path: '/',
})

check(
  (await host.js('return !document.querySelector("input#join-name")')) === true,
  'the teacher entered the room',
  'yes',
)


/*
 * The action buttons are absolutely positioned and take no part in the layout:
 * a lane sized for two lays the third one over the file name. We measure the
 * gap.
 */
const gap = (await host.js(`
  const row=[...document.querySelectorAll('button')].find(b=>(b.title||'').includes('lecture.pdf'));
  if(!row) return null;
  const lane=row.parentElement.querySelector('.relative.flex.h-6');
  if(!lane) return null;
  return Math.round(lane.getBoundingClientRect().left - row.getBoundingClientRect().right);
`)) as number | null
check(gap !== null && gap >= 0, 'the buttons do not run over the file name', `gap ${gap}px`)

const before = await student.js('return document.querySelectorAll("canvas").length')
check(before === 0, 'before the click the student has no document', `canvases ${before}`)

/* A click on the file name in the tree opens it: for the teacher the PDF goes
   to the room's shared screen, for everyone else it opens just for them. */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('lecture.pdf'));` +
    `if(!b) throw new Error('no lecture.pdf row in the tree'); b.click(); return 1`,
)

/**
 * Wait for a condition, not for seconds.
 *
 * The first version slept for a fixed time and blamed the product for the
 * student having no pages: the library, the worker and the file itself take
 * longer to arrive in a cold tab than in a warm one. A check that depends on
 * whose tab was faster is not a check.
 */
async function until(page: Tab, expr: string, what: string, ms = 20000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await page.js(`return ${expr}`)) === true) return true
    await wait(250)
  }
  console.log(`  (gave up waiting: ${what})`)
  return false
}

await until(host, 'document.querySelectorAll("canvas").length === 3', 'pages for the teacher')
await until(student, 'document.querySelectorAll("canvas").length === 3', 'pages for the student')

check(
  (await host.js('return document.querySelectorAll("canvas").length')) === 3,
  'all pages opened for the teacher',
  await host.js('return document.querySelectorAll("canvas").length'),
)
check(
  (await student.js('return document.querySelectorAll("canvas").length')) === 3,
  'the document appeared for the student by itself',
  await student.js('return document.querySelectorAll("canvas").length'),
)
check(
  (await student.js('return /Идём за/.test(document.body.innerText)')) === true,
  'the student follows the teacher',
  await student.js("return /Идём за[^\\n]*/.exec(document.body.innerText)?.[0] ?? 'no such line'"),
)

/* ------------------------------------------------------------------ summary */

/* ------------------------------------------------- two modes of one centre */

check(
  (await host.js('return !!document.querySelector("main.hidden")')) === true,
  'the document took the centre, not a column next to it',
  'notebook hidden',
)

await host.js(
  'const t=[...document.querySelectorAll("button")].find(b=>/Тетрадь/.test(b.textContent||"")); if(!t) throw new Error("the Тетрадь tab is missing: " + [...document.querySelectorAll("button")].map(b=>JSON.stringify((b.textContent||"").trim().slice(0,20))).join(",")); t.click(); return 1',
)
await wait(600)
check(
  (await host.js('return !document.querySelector("main.hidden")')) === true,
  'the tab returns to the notebook',
  'notebook visible',
)
/*
 * The "where the teacher is" mark is checked for the STUDENT: the teacher does
 * not follow themselves and must not have it. Asking the teacher about it would
 * check the wrong thing.
 */
await student.js(
  'const t=[...document.querySelectorAll("button")].find(b=>/Тетрадь/.test(b.textContent||"")); t&&t.click(); return 1',
)
await wait(600)
check(
  (await student.js('return /на стр\\. \\d+/.test(document.body.innerText)')) === true,
  'from the notebook the student sees where the teacher is',
  await student.js(
    'return /[^\\n]*на стр\\. \\d+/.exec(document.body.innerText)?.[0]?.trim() ?? "none"',
  ),
)
check(
  (await host.js('return /на стр\\. \\d+/.test(document.body.innerText)')) === false,
  'the teacher does not follow themselves',
  'no mark',
)

/*
 * "The teacher left" is only for someone who was following somebody and lost
 * them. The teacher never has anyone to follow: nobody follows themselves.
 */
await host.js(
  'const t=[...document.querySelectorAll("button")].find(b=>/lecture\\.pdf/.test(b.textContent||"")); t&&t.click(); return 1',
)
await wait(500)
check(
  (await host.js('return /вышел/.test(document.body.innerText)')) === false,
  'the teacher is not told that they left',
  await host.js(
    'return /[^\\n]*вышел[^\\n]*/.exec(document.body.innerText)?.[0]?.trim() ?? "not told"',
  ),
)

/* There has to be a way to close the document — for the room, not only for oneself. */
check(
  (await host.js('return !!document.querySelector(\'[aria-label="Закрыть lecture.pdf"]\')')) ===
    true,
  'the document can be closed',
  'a button on the tab',
)
await host.js('document.querySelector(\'[aria-label="Закрыть lecture.pdf"]\').click(); return 1')
await until(
  host,
  'document.querySelectorAll("canvas").length === 0',
  'the document closed for the teacher',
)
await until(
  student,
  'document.querySelectorAll("canvas").length === 0',
  'the document closed for the student',
)
check(
  (await host.js('return document.querySelectorAll("canvas").length')) === 0,
  'closing removes the document for the teacher',
  await host.js('return document.querySelectorAll("canvas").length'),
)
check(
  (await student.js('return document.querySelectorAll("canvas").length')) === 0,
  'and for the whole room',
  await student.js('return document.querySelectorAll("canvas").length'),
)
check(
  (await student.js(
    'return /lecture\\.pdf/.test(document.querySelector("main")?.parentElement?.textContent ?? "")',
  )) === false,
  'the document tab disappeared along with it',
  'no tab',
)

/* ------------------------------------------------- editor and tree */

/**
 * A new file typed in the tree reaches the second browser — and back.
 *
 * That is exactly why files became Yjs documents: two people in one script.
 * The check goes through a real CodeMirror, not through writing into Y.Text
 * directly: what can break is exactly the place where the editor binds to the
 * shared text, and replacing it by hand would check everything except that.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Новый файл');` +
    `if(!b) throw new Error('no "new file" button'); b.click(); return 1`,
)
await wait(400)
await host.js(
  `const i=document.querySelector('input.font-mono');` +
    `if(!i) throw new Error('no name field; in the panel: ' + (document.querySelector('section[aria-label]')?.innerText||'').slice(0,200));` +
    `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;` +
    `set.call(i,'train.py'); i.dispatchEvent(new Event('input',{bubbles:true}));` +
    `i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1`,
)
/*
 * We search by `title`, not by the row text. The name in the tree is split into
 * two parts — the stem and the extension — so that the extension is not eaten
 * by an ellipsis, and there is a line break between them in the markup. Both
 * `textContent` and `innerText` give it as a space, so `train.py` looks like
 * `train .py` there and is not caught as a substring. `title` is the full path,
 * the very one the file is opened by.
 */
const inTree = `[...document.querySelectorAll('button')].some(b=>(b.title||'').startsWith('train.py'))`
await until(host, inTree, 'the file appeared in the tree')
check((await host.js(`return ${inTree}`)) === true, 'the new file appeared in the tree', 'train.py')
await until(student, inTree, 'the file reached the student')
check(
  (await student.js(`return ${inTree}`)) === true,
  'and for the whole room, not only for the author',
  'train.py',
)

await until(host, `!!document.querySelector('.cm-file .cm-content')`, 'the editor opened')
check(
  (await host.js(`return !!document.querySelector('.cm-file .cm-content')`)) === true,
  'the new file opened in the editor right away',
  'CodeMirror in place',
)
check(
  (await host.js(
    `return [...document.querySelectorAll('button')].some(b=>/запустить/i.test(b.textContent||''))`,
  )) === true,
  'the script has something to run it with',
  'the Run button',
)

/*
 * We type in the teacher's editor — as a person would, not around it.
 *
 * `Input.insertText` delivers text to the focus the same way the keyboard
 * does, so both the CodeMirror handlers and the binding to the shared text are
 * checked. There is no way to reach `EditorView` from the page: it is not
 * exposed, and rightly so — a test that pokes into the internals checks them,
 * not the product.
 */
await host.js(`document.querySelector('.cm-file .cm-content').focus(); return 1`)
await host.send('Input.insertText', { text: "print('привет из общего файла')" })
await wait(600)
// We wait for the row rather than hope for it: the file list arrives as a
// message, and clicking it a frame too early is a race, not a check.
await until(
  student,
  `[...document.querySelectorAll('button')].some(x=>(x.title||'').includes('train.py'))`,
  'the train.py row reached the student',
)
await student.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('train.py'));` +
    `if(!b) throw new Error('the student has no train.py row'); b.click(); return 1`,
)
await until(
  student,
  `(document.querySelector('.cm-file .cm-content')?.textContent||'').includes('привет из общего файла')`,
  'the text reached the student',
)
check(
  (await student.js(
    `return (document.querySelector('.cm-file .cm-content')?.textContent||'').includes('привет из общего файла')`,
  )) === true,
  'what was typed in the file is visible to the second person',
  await student.js(
    `return (document.querySelector('.cm-file .cm-content')?.textContent||'').slice(0,40)`,
  ),
)

/* The file panel says who else is in this file. */
const seesNina = `(document.body.textContent||'').includes('Нина')`
await until(host, seesNina, 'the teacher sees the student in the file')
check(
  (await host.js(`return ${seesNina}`)) === true,
  'it shows who else is editing this file',
  'Нина is here',
)

/* A tab closes for oneself and touches nobody else. */
await student.js(`document.querySelector('[aria-label="Закрыть train.py"]').click(); return 1`)
await wait(500)
check(
  (await student.js(`return !document.querySelector('.cm-file .cm-content')`)) === true,
  'the file tab closes',
  'no editor',
)
check(
  (await host.js(`return !!document.querySelector('.cm-file .cm-content')`)) === true,
  'a tab closed for oneself did not close for the neighbour',
  'open for the teacher',
)

/* ---------------------------------------------- a notebook is a file */

/**
 * The room's notebook lies in its folder as a file and opens as a tab, like
 * everything else. That is exactly why it stopped being special: the file is
 * visible in the tree, it can be downloaded, read from a cell and opened next
 * to a second one.
 */
check(
  (await host.js(
    `return [...document.querySelectorAll('button')].some(b=>(b.title||'').startsWith('Тетрадь.ipynb'))`,
  )) === true,
  'the room notebook lies in the tree as a file',
  'Тетрадь.ipynb',
)

/* A second notebook is created and opens next to the first one. */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Новая тетрадь');` +
    `if(!b) throw new Error('no "new notebook" button'); b.click(); return 1`,
)
await wait(400)
await host.js(
  `const i=document.querySelector('input.font-mono');` +
    `if(!i) throw new Error('no name field');` +
    `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;` +
    `set.call(i,'разбор.ipynb'); i.dispatchEvent(new Event('input',{bubbles:true}));` +
    `i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1`,
)
const twoBooks = `[...document.querySelectorAll('main')].length >= 2`
await until(host, twoBooks, 'the second notebook opened')
check(
  (await host.js(`return ${twoBooks}`)) === true,
  'the second notebook opens next to the first',
  await host.js(`return document.querySelectorAll('main').length + ' notebooks'`),
)
check(
  (await host.js(`return document.querySelectorAll('main:not(.hidden)').length`)) === 1,
  'exactly one of them is shown',
  'one',
)
/* And it has its own toolbar: "Run all" applies to the notebook where it was pressed. */
check(
  (await host.js(
    `return (document.querySelector('main:not(.hidden)')?.textContent||'').includes('Run all')`,
  )) === true,
  'the second notebook has its own toolbar',
  'Run all in place',
)

/*
 * There must be nothing extra under an open notebook.
 *
 * The "this file is not text" branch reached the notebook last and was
 * formally right: .ipynb is indeed not opened in the editor. It was printed
 * UNDER the notebook, that is, under a working sheet of cells.
 */
check(
  (await host.js(
    `return (document.querySelector('main:not(.hidden)')?.parentElement?.textContent||'').includes('не текст')`,
  )) === false,
  'nothing under the notebook says it is not text',
  'clean',
)

/* ------------------------------------------- selecting several cells */

/**
 * Selection is how a person tells the Oracle "look here".
 *
 * Everything checked here used to be impossible: selecting a second cell,
 * clearing the selection at all. We count by aria-label, not by colour: colour
 * is read by eyes, a label by eyes and by a screen reader.
 */
const selectedCount = `document.querySelectorAll('[aria-label$="selected"]').length`

/**
 * A press on a cell is a press where cells are pressed, and the stand has to
 * aim at the same place.
 *
 * Selection listens to `[data-cell-pick]` — the body column (code, output, the
 * toolbar above them) and the NUMBER itself — while the gaps around and the
 * empty field under the number are neutral on purpose: a click there clears
 * the selection (see the comment at this block in CellView.svelte). Events
 * bubble up, not down, so a `pointerdown` sent to the `[data-cell-id]` root
 * never reached the handler at all: the stand selected nothing and blamed the
 * product for it.
 *
 * It aims at the BODY: the marker is now on two nodes, and `querySelector`
 * without narrowing would take the one earlier in the markup. The number is
 * checked separately.
 */
const pressCell = (n: number, extra = ''): string =>
  `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
  `if(cells.length < ${n + 1}) throw new Error('the notebook has fewer than ${n + 1} cells');` +
  `const body=cells[${n}].querySelector('[data-cell-pick]:not(span)');` +
  `if(!body) throw new Error('cell ${n + 1} has no body — nothing to press');` +
  `body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true${extra}})); return 1`

await host.js(pressCell(0))
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 1,
  'a press selects one cell',
  await host.js(`return ${selectedCount}`),
)

/* Cmd (Ctrl) adds a second one without clearing the first. */
await host.js(pressCell(1, ',metaKey:true'))
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 2,
  'Cmd adds a second cell to the selection',
  await host.js(`return ${selectedCount}`),
)

/* The same Cmd takes it back off. */
await host.js(pressCell(1, ',metaKey:true'))
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 1,
  'the same press takes it back off',
  await host.js(`return ${selectedCount}`),
)

/*
 * A press outside a cell clears the selection. Until now there was no way out
 * of the "selected" state other than reloading the page.
 */
await host.js(`const main=document.querySelector('main:not(.hidden)');` + `main.click(); return 1`)
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 0,
  'a press outside a cell clears the selection',
  await host.js(`return ${selectedCount}`),
)

/*
 * The panel names the field of view — and adds the selection to it.
 *
 * "Видит" (sees) is always there: it is about what goes out in any case.
 * "Особенно" (especially) appears only when there is something to focus on — a
 * line that is always lit says nothing.
 */
check(
  (await host.js(`return (document.body.textContent||'').includes('всю комнату')`)) === true,
  'the panel says the Oracle sees the whole room',
  await host.js(
    `return /всю комнату[^А-Я]*/.exec(document.body.textContent||'')?.[0]?.trim() ?? 'silent'`,
  ),
)
check(
  (await host.js(`return (document.body.textContent||'').includes('Особенно')`)) === false,
  'without a selection "Особенно" is not shown',
  'no line',
)
await host.js(pressCell(1))
await wait(400)
check(
  (await host.js(`return (document.body.textContent||'').includes('Особенно')`)) === true,
  'the selected cell is added to the field of view',
  await host.js(
    `return /Особенно[^А-Я]*/.exec(document.body.textContent||'')?.[0]?.trim() ?? 'silent'`,
  ),
)

/* ------------------------------------------------ reader controls */

/**
 * An open document can be controlled: zoomed in and searched for a page.
 *
 * The reader used to be one scroll without a single button: there was no way
 * to enlarge a lecture set in 10 pt, and reaching page twenty meant scrolling
 * through nineteen.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith('lecture.pdf'));` +
    `if(!b) throw new Error('lecture.pdf is not in the tree'); b.click(); return 1`,
)
await until(host, `document.querySelectorAll('canvas').length >= 3`, 'the document opened again')

const zoomShown = `[...document.querySelectorAll('button')].find(b=>/^\\d+%$/.test((b.textContent||'').trim()))?.textContent.trim()`
check(
  (await host.js(`return ${zoomShown}`)) === '100%',
  'the reader opens at fit width',
  await host.js(`return ${zoomShown} ?? 'no zoom button'`),
)

const pageWidth = `Math.round(document.querySelector('[data-page="1"]').getBoundingClientRect().width)`
const wasWide = (await host.js(`return ${pageWidth}`)) as number
await host.js(
  `[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Крупнее').click(); return 1`,
)
await wait(600)
check(
  ((await host.js(`return ${pageWidth}`)) as number) > wasWide,
  'the page really gets bigger',
  `${wasWide} → ${await host.js(`return ${pageWidth}`)}`,
)
check(
  (await host.js(`return ${zoomShown}`)) === '125%',
  'and the percentage says by how much',
  await host.js(`return ${zoomShown}`),
)

/* A press on the percentage returns to "fit width" — the only zoom that needs no choice. */
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.title||'')==='По ширине').click(); return 1`,
)
await wait(600)
check(
  ((await host.js(`return ${pageWidth}`)) as number) === wasWide,
  'the percentage returns the page to fit width',
  await host.js(`return ${zoomShown}`),
)

/*
 * The page strip is closed by default, opens with a button and does NOT take
 * width from the page: it is an overlay, and a column would force the document
 * to be redrawn on every opening.
 */
check(
  (await host.js(`return !!document.querySelector('[data-rail]')`)) === false,
  'the page strip is closed by default',
  'not there',
)
await host.js(
  `[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Полоса страниц').click(); return 1`,
)
await until(host, `!!document.querySelector('[data-rail]')`, 'the strip opened')
check(
  ((await host.js(`return ${pageWidth}`)) as number) < wasWide,
  'the strip takes a column of its own rather than lying over the page',
  `${wasWide} → ${await host.js(`return ${pageWidth}`)}`,
)
await until(
  host,
  `[...document.querySelectorAll('[data-rail] canvas')].some(c=>c.width>0)`,
  'the thumbnails were drawn',
)
check(
  ((await host.js(
    `return [...document.querySelectorAll('[data-rail] canvas')].filter(c=>c.width>0).length`,
  )) as number) > 0,
  'page thumbnails are drawn',
  await host.js(
    `return document.querySelectorAll('[data-rail] canvas').length + ' pages in the strip'`,
  ),
)

/* A page was chosen — the strip closed by itself. */
/*
 * Choosing a page takes the scroll to it.
 *
 * It is measured in the same call as the press: the place in the document is
 * `scrollTop`, and it has to be compared with the position of the page itself,
 * not with the counter in the tab row. The counter updates on the scroll event,
 * that is, a frame later, and depending on whether the headless browser has
 * managed to put out that frame means testing the browser.
 */
/*
 * We jump to the SECOND page, not the last: the pages here are 16:9, like
 * slides, and the last one is shorter than the window — nothing can scroll it
 * up to its top, and the check would scold the reader for the document having
 * ended.
 */
const landed = (await host.js(
  `const sc=document.querySelector('[role=document]');` +
    `document.querySelector('[data-thumb="2"]').click();` +
    `const sheet=sc.querySelector('[data-page="2"]');` +
    `const at=sheet.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;` +
    // The start of the page must stay VISIBLE: the scroll must not go past the
    // top of the sheet. A miss of thirty-four pixels — the height of the control
    // bar — looked like "jumps a bit low": the end of the previous page was at the
    // top.
    `return JSON.stringify({over: Math.round(sc.scrollTop - at), page: sc.scrollTop})`,
)) as string
const over = JSON.parse(landed).over as number
check(
  over <= 0 && over > -200,
  'the jump shows the start of the page, not its middle',
  `the top of the sheet is ${-over}px below the edge`,
)
await wait(700)
check(
  (await host.js(`return !!document.querySelector('[data-rail]')`)) === true,
  'choosing a page does not close the strip',
  'stayed open',
)
/*
 * Lecture: the console is with the presenter, the page and the ink are with
 * everyone.
 *
 * What is checked here cannot be seen in one tab: the page turned on the tablet
 * and the line drawn by the Pencil have to appear for the STUDENT. All of it
 * travels over the control socket and lives in the server's memory, that is, it
 * breaks silently — the presenter's screen keeps showing exactly the same.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Лекция');` +
    `if(!b) throw new Error('no "Лекция" button in the reader'); b.click(); return 1`,
)
const presenterBar = `[...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`
await until(host, presenterBar, 'the lecture console appeared')
check(
  (await host.js(`return ${presenterBar}`)) === true,
  'the presenter gets the lecture console',
  'yes',
)

const audience = `(document.body.textContent||'').includes('Лекцию ведёт Ада')`
await until(student, audience, 'the student saw the lecture')
check(
  (await student.js(`return ${audience}`)) === true,
  'the student sees the lecture without opening it',
  await student.js(
    `return (document.querySelector('canvas.ink')? 'with the ink layer' : 'without the ink layer')`,
  ),
)
check(
  (await student.js(
    `return [...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`,
  )) === false,
  'the student has no console',
  'none',
)

/* The presenter turns the page — it arrives for everyone. */
await host.js(
  `[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Следующая страница').click(); return 1`,
)
const onSecond = `[...document.querySelectorAll('span')].some(s=>/^2 \\/ 3$/.test((s.textContent||'').trim()))`
await until(student, onSecond, 'the page reached the student')
check(
  (await student.js(`return ${onSecond}`)) === true,
  'the presenter turns the page for the whole room',
  await student.js(
    `return [...document.querySelectorAll('span')].map(s=>(s.textContent||'').trim()).find(t=>/^\\d+ \\/ \\d+$/.test(t)) ?? 'no counter'`,
  ),
)

/*
 * The sheet takes up room instead of collapsing to zero.
 *
 * The sheet size was computed ONLY from the resize observer, and it stays
 * silent while the browser does not render the tab: a projection opened as a
 * second window that never got focus stayed empty — a white rectangle of zero
 * pixels that pdf.js does not draw into, because there is nowhere to draw. On
 * screen that is "the lecture did not open", and the document would look
 * guilty.
 */
const sheetWidth = `Math.round(document.querySelector('canvas.ink-dry').getBoundingClientRect().width)`
// We wait rather than sleep: the sheet gets its size when the document itself
// arrives, and it arrives over the network — longer in a cold tab than in a
// warm one.
await until(host, `${sheetWidth} > 200`, 'the lecture sheet got its size')
check(
  ((await host.js(`return ${sheetWidth}`)) as number) > 200,
  'the lecture page takes up its room',
  `${await host.js(`return ${sheetWidth}`)}px`,
)

/*
 * Ink. The pen is taken by pressing a colour — there are no two switches for
 * four colours — and after that these are ordinary PointerEvents: the Pencil
 * takes the same path.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'')==='Перо, красный');` +
    `if(!b) throw new Error('no pen in the console'); b.click(); return 1`,
)
await wait(200)
const strokeOn = (page: Tab) =>
  page.js(
    `const c=document.querySelector('canvas.ink-dry');` +
      `if(!c||!c.width) return -1;` +
      `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
      `let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>16) n+=1; return n`,
  )
check(((await strokeOn(student)) as number) <= 0, 'before the stroke the page is clean', 'empty')

/*
 * The synthetic pen aims at the INPUT LAYER, not at a canvas.
 *
 * Touches on the ink layer are received by one element — `div.ink-input` over
 * three canvases (§1 of the contract): the canvases are siblings, not parents,
 * and an event sent to a canvas never reaches the handlers. The coordinates,
 * though, are counted from the canvas: the input layer is wider than it by the
 * sheet margins.
 */
const inkTarget =
  `const c=document.querySelector('canvas.ink-wet');const input=document.querySelector('.ink-input')||c;` +
  `if(!c) throw new Error('no ink layer');const r=c.getBoundingClientRect();`
await host.js(
  inkTarget +
    `const at=(t,fx,fy)=>input.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerId:1,pointerType:'pen',` +
    `buttons:t==='pointerup'?0:1,pressure:0.5,clientX:r.left+r.width*fx,clientY:r.top+r.height*fy}));` +
    `at('pointerdown',0.2,0.3); at('pointermove',0.4,0.45); at('pointermove',0.6,0.35);` +
    `at('pointermove',0.8,0.5); at('pointerup',0.8,0.5); return 1`,
)
await until(student, `(async()=>{const c=document.querySelector('canvas.ink-dry');if(!c||!c.width)return false;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=3;i<d.length;i+=4) if(d[i]>16) return true; return false})()`, 'the stroke reached the student')
const inked = (await strokeOn(student)) as number
check(inked > 0, "the presenter's stroke appears for the student", `${inked} painted pixels`)

/*
 * The pointer: press and HOLD.
 *
 * Most often it just stays in place — "right here" — that is, no new points
 * arrive at all. The tail has to burn out meanwhile and the dot itself has to
 * stay: once it went out together with the tail after four tenths of a second,
 * and on screen that looked like "pressed, it blinked, nothing".
 *
 * The presenter's tab comes to the front: `laser:off` goes out on the burn-out
 * timer (300 ms), and headless Chrome slows the timers of a tab that has lain in
 * the background for more than five minutes down to once a minute. The check
 * was then waiting for the browser, not the product.
 */
await host.send('Page.bringToFront')
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>/указк/i.test((x.textContent||'')+(x.getAttribute('aria-label')||'')));` +
    `if(!b) throw new Error('no pointer in the lecture console'); b.click(); return 1`,
)
await wait(200)
await host.js(
  inkTarget +
    `const at=(t,fx,fy)=>input.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerId:2,pointerType:'pen',` +
    `buttons:t==='pointerup'?0:1,clientX:r.left+r.width*fx,clientY:r.top+r.height*fy}));` +
    `at('pointerdown',0.5,0.5); at('pointermove',0.55,0.52); return 1`,
)
/*
 * The red is looked for on the LIVE canvas: under §3 of the contract the
 * pointer, the eraser ring and the predicted tip live on `ink-live`, and the
 * wet one holds ink only. The wet one is added in anyway — the audience's layer
 * may draw the pointer echo its own way.
 */
const redExpr =
  `(()=>{let n=0;for(const cls of ['ink-live','ink-wet']){const c=document.querySelector('canvas.'+cls);` +
  `if(!c||!c.width) continue;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=0;i<d.length;i+=4) if(d[i+3]>24 && d[i]>150 && d[i+1]<120) n+=1}return n})()`
const redOn = (page: Tab) => page.js(`return ${redExpr}`)
/*
 * We measure at the STUDENT — so the student comes to the front: the live layer
 * is drawn on requestAnimationFrame, and a background tab gets no frames at
 * all. Pixels on a canvas nobody draws are not "the pointer did not arrive".
 */
await student.send('Page.bringToFront')
await until(student, `${redExpr} > 0`, 'the pointer reached the student')
// Wait longer than the tail lives: the head has to stay.
await wait(1400)
const stillLit = (await redOn(student)) as number
check(stillLit > 0, 'the pointer does not go out while held', `${stillLit} red pixels after 1.4 s`)

/* Released — it goes out for everyone. The presenter to the front: the burn-out timer is theirs. */
await host.send('Page.bringToFront')
await host.js(
  inkTarget +
    `input.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:2,pointerType:'pen',buttons:0,` +
    `clientX:r.left+r.width*0.55,clientY:r.top+r.height*0.52})); return 1`,
)
await wait(500)
await student.send('Page.bringToFront')
await until(student, `${redExpr} === 0`, 'the pointer went out for the student')
check(((await redOn(student)) as number) <= 0, 'a released pointer goes out for everyone', 'out')
/* Back to the pen: the checks further on draw with it. */
await host.send('Page.bringToFront')
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'')==='Перо, красный');b&&b.click(); return 1`,
)

/**
 * A two-step button of the bar is pressed twice — and that is not a slip of the
 * check.
 *
 * "Erase" and "End" are irreversible: ink has no history, and ending the
 * lecture erases it on all pages at once. So both ask with a second press
 * (LectureView · askWipe/askStop): the first changes the label, the second
 * does it. A check that pressed once only armed the button and waited for the
 * erased ink right up to the timeout — silently, because there was nothing for
 * it to wait for.
 *
 * We search by both labels: between the presses the bar manages to redraw, and
 * the second time the button is already labelled with the question.
 */
const pressTwice = async (page: Tab, labels: [string, string]): Promise<void> => {
  const find =
    `[...document.querySelectorAll('button')]` +
    `.find(b=>${JSON.stringify(labels)}.includes((b.textContent||'').trim()))`
  await page.js(
    `const b=${find}; if(!b) throw new Error('no "${labels[0]}" button in the bar'); b.click(); return 1`,
  )
  await page.js(
    `const b=${find}; if(!b) throw new Error('"${labels[0]}" did not ask again'); b.click(); return 1`,
  )
}

/* Erased — and it is erased for everyone, not only for whoever drew. */
await pressTwice(host, ['Стереть', 'Стереть всё?'])
await until(student, `(async()=>{const c=document.querySelector('canvas.ink-dry');if(!c)return true;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=3;i<d.length;i+=4) if(d[i]>16) return false; return true})()`, 'the ink was erased for the student')
check(((await strokeOn(student)) as number) <= 0, 'erasing reaches the whole room', 'clean')

/* ------------------------------------------------------- names of the console controls */

/*
 * The console is found by ARIA names, and that is not pedantry but the only way
 * left to find it.
 *
 * The check used to find keys by the words on them — "Sheet", "Pointer",
 * "End". There are no more words on the console: four labels are left on the
 * whole device, the pigment is shown by a paper chip with a real stroke,
 * "Back" is a single chevron, and "End" moved into the "More" sheet as its last
 * row. A text-based check would after that look for something that is not on
 * the screen at all, and would keep quiet about exactly the console that is
 * held in the hand.
 *
 * The names below are §7 of the contract, letter for letter. They are also all
 * that these keys are called for voice access, so a rename breaks not the check
 * but the console, and breaks it silently. That is why there is one list and it
 * lives here, rather than being scattered over selectors.
 */
const PULT = {
  gauge: 'Выбрать страницу',
  blank: 'Чистый лист',
  toSlide: 'Вернуться к слайду',
  dim: 'Затемнить проекцию',
  undim: 'Вернуть проекцию',
  laser: 'Указка',
  prev: 'Предыдущая страница',
  next: 'Следующая страница',
  undo: 'Отменить последний штрих',
  eraser: 'Ластик',
  marker: 'Маркер',
  red: 'Перо, красное',
  green: 'Перо, зелёное',
  black: 'Перо, чёрное',
  fader: 'Яркость листа',
  more: 'Ещё',
  bigger: 'Заметки крупнее',
  pen: 'Перо',
  notes: 'Заметки',
  finger: 'Рисовать пальцем',
  fullscreen: 'Во весь экран',
  thin: 'Тонкое',
  mid: 'Среднее',
  thick: 'Толстое',
} as const

/** An expression for "such a control is on the screen". */
const named = (aria: string) => `!!document.querySelector('[aria-label=${JSON.stringify(aria)}]')`
/** Press a control by name — with a clear complaint if it is missing. */
const press = (aria: string) =>
  `const b=document.querySelector('[aria-label=${JSON.stringify(aria)}]');` +
  `if(!b) throw new Error('the console has no "${aria}" control'); b.click(); return 1`
/** The latch state of a key: 'true' / 'false' / 'none'. */
const pressedIs = (aria: string) =>
  `(document.querySelector('[aria-label=${JSON.stringify(aria)}]')?.getAttribute('aria-pressed') ?? 'none')`

/*
 * The console on a tablet.
 *
 * The lecture is run from an iPad, and there is no way to log in on it again:
 * this product has neither a password nor an account. The link has to let in
 * THE SAME person — otherwise a second "Ада" appears in the room, and there
 * will be nobody to run the lecture. This is exactly what is checked: the link
 * opened in a clean tab does not ask for a name and gives the console, not a
 * seat in the audience.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith('Ссылка, по которой'));` +
    `if(!b) throw new Error('no "Пульт" button'); b.click(); return 1`,
)
await until(host, `!!document.querySelector('[aria-label="Пульт на планшет"]')`, 'the console link is ready')
const consoleLink = (await host.js(
  `return document.querySelector('[aria-label="Пульт на планшет"] .select-all')?.textContent?.trim() ?? ''`,
)) as string
check(
  consoleLink.includes(`/s/${ROOM}/t/`),
  'the presenter is given the console link',
  consoleLink ? consoleLink.slice(0, 34) + '…'
    : await host.js(
        `return (document.querySelector('[aria-label="Пульт на планшет"]')?.textContent||'').trim().slice(0,120)`,
      ),
)

const pad = await tab(consoleLink)
/*
 * The sign of the console is the gauge, not "End".
 *
 * "End" was removed from the always-visible surface (§8.2 of the drawing): red
 * next to the finger for the whole hour for the sake of a press that happens
 * once. The gauge, on the other hand, is always on the console — it is the
 * only place in the product where the page number lives.
 */
const padHasPult = named(PULT.gauge)
await until(pad, padHasPult, 'the tablet entered and got the console')
check(
  (await pad.js(`return !document.querySelector('input#join-name')`)) === true,
  'the tablet does not ask for a name',
  'entered at once',
)
check(
  (await pad.js(`return location.pathname`)) === `/s/${ROOM}/pult`,
  'the key is removed from the address, and the tablet opens as the console',
  await pad.js('return location.pathname'),
)
check(
  (await pad.js(`return ${padHasPult}`)) === true,
  'the tablet gets the console, not a seat in the audience',
  'the gauge is in place',
)
/*
 * And it does not become a second person in the room: the people list counts
 * people, not tabs. A second "Ада" in the list is a lecture run by who knows
 * whom.
 */
/*
 * The tablet is not a second person in the room: it enters as the same
 * participant. The people list counts PEOPLE, not tabs, and a second "Ада" in
 * it would mean a lecture run by who knows whom.
 */
const inRoom = `(document.body.textContent||'').match(/(\\d+) in the room/)?.[1] ?? '?'`
await until(host, `${inRoom} === '2'`, 'the head count in the room settled', 8000)
check(
  (await host.js(`return ${inRoom}`)) === '2',
  'the tablet did not become a second person in the room',
  (await host.js(`return ${inRoom} + ' · ' + [...document.querySelectorAll('[title]')].map(n=>n.getAttribute('title')).filter(t=>/Ада|Нина/.test(t||'')).join(' | ')`)) as string,
)
for (const line of pad.trouble.slice(0, 3)) console.log(`  (tablet) ${line}`)

/*
 * The projection is a separate address, not a button: it is opened on the
 * machine at the projector, and it has to survive a reload. It must have
 * neither tabs nor panels — it is the only screen twenty people watch at once.
 */
const beam = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}/screen`)
await until(beam, `document.querySelectorAll('canvas').length > 0`, 'the projection opened')
check(
  (await beam.js(`return document.querySelectorAll('[role="tablist"], input#join-name').length === 0`)) === true,
  'the projection has neither tabs nor a login screen',
  'a clean screen',
)
check(
  (await beam.js(
    `return getComputedStyle(document.querySelector('.fixed.inset-0')).backgroundColor`,
  )) === 'rgb(0, 0, 0)',
  'the projection is black, like a screen in a lecture hall',
  await beam.js(`return getComputedStyle(document.querySelector('.fixed.inset-0')).backgroundColor`),
)

/*
 * Screenshots of the lecture — on request with `--shot`, like the room
 * screenshot below.
 *
 * The console and the projection are checked by eye and by nothing else: the
 * console bar carries a dozen buttons, and whether they fit the width of a
 * tablet is a question no condition check answers.
 */
if (process.argv.includes('--shot')) {
  for (const [who, page] of [
    ['ui-lecture.png', host],
    ['ui-projection.png', beam],
  ] as const) {
    await page.send('Page.bringToFront')
    // We wait for a drawn page, not a second: a background tab does not draw at
    // all, and a screenshot "a second after switching" caught a black screen.
    await until(page, `[...document.querySelectorAll('canvas')].some(c=>c.width>1)`, `sheet for ${who}`)
    await wait(400)
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    const where = path.resolve(who)
    writeFileSync(where, Buffer.from(shot.result.data as string, 'base64'))
    console.log(`  screenshot: ${where}`)
  }
  await host.send('Page.bringToFront')
  await wait(400)
}

/*
 * The console is a separate application, and it is measured by a tablet.
 *
 * The check's window is 1600×1000, that is, a laptop; the console, however, is
 * held in the hand, and everything in it is designed for 1180×820 at double
 * pixel density. The tab is given exactly this geometry — otherwise a layout
 * that never happens on a tablet gets checked.
 */
const pult = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}/pult`)
await pult.send('Emulation.setDeviceMetricsOverride', {
  width: 1180,
  height: 820,
  deviceScaleFactor: 2,
  mobile: false,
})
await pult.send('Page.bringToFront')
const pultReady = await until(
  pult,
  `!!document.querySelector('.ink-input') && [...document.querySelectorAll('canvas')].some(c=>c.getBoundingClientRect().width>200)`,
  'the console drew the page',
)
check(pultReady, 'the console shows the lecture sheet', await pult.js(`return location.pathname`))
/*
 * The lecture is already running and the console is opened by key — over the
 * sheet lies the "Touch to take the console" overlay: full screen can be
 * requested only from a live gesture. The keys under it are in the DOM, and
 * `press` would press them anyway, but a screenshot would show the slab, not
 * the console. It is dismissed the same way as with a finger.
 */
async function takeConsole(): Promise<void> {
  if (!(await pult.js(`return !!document.querySelector('[aria-label="Коснуться и начать"]')`))) return
  await pult.js(`document.querySelector('[aria-label="Коснуться и начать"]').click(); return 1`)
  await until(pult, `!document.querySelector('[aria-label="Коснуться и начать"]')`, 'the first-touch overlay went away', 4000)
  await wait(300)
}
await takeConsole()
check(
  (await pult.js(`return ${named(PULT.laser)}`)) === true,
  'the console has its own tools',
  await pult.js(`return document.querySelectorAll('button').length + ' buttons'`),
)

/*
 * All of §7 at once, not one name.
 *
 * A check of one key catches a rename of exactly that key; but usually the
 * whole family breaks at once — "перо, красный" instead of "Перо, красное",
 * "Стереть" instead of "Ластик". The pairs are one control in two states, and
 * exactly one of the two has to be present.
 */
/*
 * Colours and widths live in the pop-up palette, and "Notes bigger" in the
 * header of the sliding notes sheet; they are not on the rail. The palette is
 * opened by a tap on the ACTIVE "Pen" (on an inactive one the tap selects the
 * pen), the notes sheet by the "Notes" key. Both are opened here just for the
 * roll call and then closed.
 */
const has = (aria: string) => `!!document.querySelector('[aria-label=${JSON.stringify(aria)}]')`
async function openPalette(): Promise<boolean> {
  await pult.js(press(PULT.pen))
  await wait(200)
  if (!(await pult.js(`return !!document.querySelector('[data-pult-palette]')`))) {
    await pult.js(press(PULT.pen))
    await wait(200)
  }
  return (await pult.js(`return !!document.querySelector('[data-pult-palette]')`)) === true
}
async function escape(): Promise<void> {
  for (const type of ['keyDown', 'keyUp'] as const) {
    await pult.send('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
  }
  await wait(250)
}
const onRail = [PULT.gauge, PULT.pen, PULT.marker, PULT.laser, PULT.prev, PULT.next, PULT.undo, PULT.eraser, PULT.fader, PULT.notes]
const inPalette = [PULT.red, PULT.green, PULT.black, PULT.thin, PULT.mid, PULT.thick]
const inNotes = [PULT.more, PULT.bigger]
const absent: string[] = []
for (const n of onRail) if (!(await pult.js(`return ${has(n)}`))) absent.push(n)
for (const pair of [
  [PULT.blank, PULT.toSlide],
  [PULT.dim, PULT.undim],
]) {
  if (!(await pult.js(`return ${has(pair[0])} || ${has(pair[1])}`))) absent.push(pair.join(' / '))
}
const paletteOpen = await openPalette()
if (!paletteOpen) absent.push('palette [data-pult-palette]')
else for (const n of inPalette) if (!(await pult.js(`return ${has(n)}`))) absent.push(n)
check(
  paletteOpen &&
    (await pult.js(
      `const p=document.querySelector('[data-pult-palette]');` +
        `return !!p.querySelector('[role="radiogroup"][aria-label="Цвет пера"]') && !!p.querySelector('[role="radiogroup"][aria-label="Толщина"]')`,
    )) === true,
  'the pen palette has two rows: colour and width',
  paletteOpen ? 'radiogroups "Цвет пера" and "Толщина"' : 'the palette did not open',
)
/*
 * A CHOICE DOES NOT CLOSE THE PALETTE. It used to — and to try a thicker blue
 * one had to open it twice; and people try exactly like that, by picking,
 * looking at the sheet. Both halves are checked: the colour and the width.
 */
if (paletteOpen) {
  await pult.js(press(PULT.green))
  await wait(200)
  const afterColor = (await pult.js(`return !!document.querySelector('[data-pult-palette]')`)) === true
  await pult.js(press(PULT.thick))
  await wait(200)
  const afterWidth = (await pult.js(`return !!document.querySelector('[data-pult-palette]')`)) === true
  check(
    afterColor && afterWidth,
    'choosing a colour and a width does not close the palette',
    `after the colour ${afterColor ? 'open' : 'CLOSED'}, after the width ${afterWidth ? 'open' : 'CLOSED'}`,
  )
  // Back to black medium — the screenshots further on depend on them.
  await pult.js(press(PULT.black))
  await wait(150)
  await pult.js(press(PULT.mid))
  await wait(150)
}
await escape()
check(
  (await pult.js(`return !document.querySelector('[data-pult-palette]')`)) === true,
  'Escape closes the palette',
  'closed',
)

/*
 * THE POINTER HAS ITS OWN PALETTE: a dot points, a line circles. It opens with
 * the same gesture as the pen one — a second tap on the tool already taken.
 */
await pult.js(press(PULT.laser))
await wait(250)
await pult.js(press(PULT.laser))
await wait(350)
const laserPalette = (await pult.js(`return !!document.querySelector('[data-pult-palette]')`)) === true
check(
  laserPalette &&
    (await pult.js(`return ${has('Линия')} && ${has('Точка')}`)) === true,
  'the pointer offers a choice: line or dot',
  laserPalette
    ? await pult.js(
        `return (document.querySelector('[data-pult-palette]')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)`,
      )
    : 'the pointer palette did not open',
)
await escape()
await pult.js(press(PULT.pen))
await wait(200)
await pult.js(press(PULT.notes))
await wait(500)
// The notes on the console have no input field at all — they are pinned (see §9 below).
const notesOpen = (await pult.js(`return !!document.querySelector('[data-pult-notes] .pult-prompt')`)) === true
if (!notesOpen) absent.push('notes sheet [data-pult-notes]')
else for (const n of inNotes) if (!(await pult.js(`return ${has(n)}`))) absent.push(n)
check(absent.length === 0, 'the console controls are named per the contract', absent.length ? absent.join(', ') : 'all names in place')

/*
 * THERE IS NO TOP STRIP AT ALL.
 *
 * A 52 px strip across the whole width was the second brightest object of the
 * night console after the sheet itself, and it put the wall clock — looked at
 * once every ten minutes — above the page number, which is looked at every
 * sentence. Its load has been spread out: the clock and the number into the
 * gauge, the document name onto the choice screen, the rest into the "More"
 * sheet.
 *
 * We look not for a class (the class will be renamed and the check will go
 * green) but for a shape: a full-width strip pressed against the top edge, as
 * tall as a chrome strip. The sheet's field does not fall under the filter — it
 * is twice as tall and holds the canvas.
 */
const band = (await pult.js(
  `const root=document.querySelector('.pult-root')||document.body;` +
    `const w=window.innerWidth;` +
    `const wide=[...root.querySelectorAll('*')].filter(el=>{` +
    `const r=el.getBoundingClientRect();` +
    `return r.top<8 && r.width>w*0.8 && r.height>=28 && r.height<=110 && !el.querySelector('canvas')});` +
    `return wide.slice(0,3).map(el=>el.tagName.toLowerCase()+'.'+` +
    `String(typeof el.className==='string'?el.className:'').slice(0,28)+' '+` +
    `Math.round(el.getBoundingClientRect().height)+'px').join(' | ')`,
)) as string
check(band === '', 'the console has no top strip', band || 'no chrome strips')

/*
 * "End" does not hang next to the finger.
 *
 * Red in a dark hall is the loudest thing there is, and it is pressed once per
 * lecture, at a moment when nobody is in a hurry. Its place is the last row of
 * the "More" sheet, and this is checked from both sides: here the word is
 * absent, below it is present in the raised sheet.
 *
 * THE ORDER HERE IS PART OF THE CHECK: the line has to stand BEFORE "More" is
 * open. Moved down, it demands from the console what the contract does not
 * demand of it — and the two rules start arguing with each other for no
 * reason. The sheet is raised further down in the file and closed right after.
 */
check(
  (await pult.js(`return !/закончить/i.test(document.body.innerText||'')`)) === true,
  'no red "End" in sight',
  await pult.js(
    `return /[^\\n]*закончить[^\\n]*/i.exec(document.body.innerText||'')?.[0]?.trim() ?? 'none'`,
  ),
)

/*
 * THE GAUGE AND THE HALL SEE ONE NUMBER.
 *
 * The number lives in ONE place in the product — the gauge — and the whole
 * point of that number is that it does not lag behind the hall. They can
 * diverge silently: the console draws its own intention, it has not reached
 * the projector, and on screen that looks like a working console.
 */
const roomPage =
  `(()=>{const t=document.body.innerText||'';` +
  `const m=/на стр\\. (\\d+)/.exec(t)||/(?:^|\\n)\\s*(\\d+)\\s*\\/\\s*\\d+\\s*(?:\\n|$)/.exec(t);` +
  `return m?m[1]:''})()`
const gaugeText =
  `(()=>{const g=document.querySelector('[aria-label=${JSON.stringify(PULT.gauge)}]');` +
  `return ((g&&(g.innerText||g.textContent))||'').replace(/\\s+/g,' ').trim()})()`
const gaugePage = `(()=>{const m=/\\d+/.exec(${gaugeText});return m?m[0]:''})()`

const roomNow = (await student.js(`return ${roomPage}`)) as string
const gaugeNow = (await pult.js(`return ${gaugePage}`)) as string
check(
  gaugeNow !== '' && gaugeNow === roomNow,
  'the gauge shows the page number',
  `gauge ${gaugeNow || '—'} · hall ${roomNow || '—'}`,
)

/*
 * And this number is live: we turn the page from the console and wait for the
 * hall. Backwards rather than forwards, when there is somewhere to go: on the
 * last page "FORWARD" is disabled, and the check would be checking a disabled
 * key.
 */
const backwards = Number(roomNow) > 1
const wantPage = String(Number(roomNow) + (backwards ? -1 : 1))
await pult.js(press(backwards ? PULT.prev : PULT.next))
const caught = await until(student, `${roomPage} === ${JSON.stringify(wantPage)}`, 'the hall caught up with the console', 8000)
const gaugeAfter = (await pult.js(`return ${gaugePage}`)) as string
check(
  caught && gaugeAfter === wantPage,
  'the page from the console reaches the hall',
  `gauge ${gaugeAfter || '—'} · hall ${(await student.js(`return ${roomPage}`)) || '—'}`,
)

/*
 * THE SHEET FADER.
 *
 * The sheet is the only source of light on the console, and it has to have a
 * control that does not leave the application: three steps of veil over the
 * sheet AND the ink, 0 / 0.28 / 0.55, the default is "hall".
 *
 * What is measured is not the veil's class but its work: the darkest
 * semi-transparent fill covering the whole sheet. The implementation is free —
 * `opacity` on the slab, alpha in the colour itself — but the number has to
 * change, otherwise the fader clicks idly and that is visible only by eye in a
 * dark hall. `[data-pult-veil]`, if present, removes all this geometry.
 */
const veil =
  `(()=>{const alpha=el=>{const cs=getComputedStyle(el);` +
  `const m=/^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(cs.backgroundColor);` +
  `if(!m) return 0;` +
  `const a=(m[4]===undefined?1:parseFloat(m[4]))*parseFloat(cs.opacity||'1');` +
  `return (+m[1]<=40&&+m[2]<=40&&+m[3]<=48)?a:0};` +
  `const marked=document.querySelector('[data-pult-veil]');` +
  `if(marked) return Math.round(alpha(marked)*100)/100;` +
  `const sheet=[...document.querySelectorAll('canvas')].map(c=>c.getBoundingClientRect())` +
  `.filter(r=>r.width>200).sort((a,b)=>b.width-a.width)[0];` +
  `if(!sheet) return -1;` +
  `let top=0;` +
  `for(const el of document.querySelectorAll('body *')){` +
  `const r=el.getBoundingClientRect();` +
  `const ix=Math.max(0,Math.min(r.right,sheet.right)-Math.max(r.left,sheet.left));` +
  `const iy=Math.max(0,Math.min(r.bottom,sheet.bottom)-Math.max(r.top,sheet.top));` +
  `if(ix*iy<sheet.width*sheet.height*0.9) continue;` +
  `const a=alpha(el);` +
  `if(a>0.95||a<=top) continue;` +
  `top=a}` +
  `return Math.round(top*100)/100})()`
/*
 * The pointer on the console: PRESSED — and it works.
 *
 * The key was a pure spring: it lit only while held — and for the dot to appear
 * one had to hold the key on the rail AND move along the sheet at the same
 * time. Two hands on the tablet and no mouse on the laptop; on screen it read
 * as "the button presses and nothing happens". Now a tap leaves the pointer on,
 * and it is exactly the tap that is checked.
 */
await pult.send('Page.bringToFront')
await pult.js(press(PULT.laser))
await wait(200)
check(
  (await pult.js(
    `return document.querySelector('[aria-label=${JSON.stringify(PULT.laser)}]')?.getAttribute('aria-pressed') === 'true'`,
  )) === true,
  'a tap on the pointer leaves it on',
  await pult.js(
    `return document.querySelector('[aria-label=${JSON.stringify(PULT.laser)}]')?.getAttribute('aria-pressed') ?? 'no key'`,
  ),
)
await pult.js(
  inkTarget +
    `const at=(t,fx,fy)=>input.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerId:7,pointerType:'pen',` +
    `buttons:t==='pointerup'?0:1,clientX:r.left+r.width*fx,clientY:r.top+r.height*fy}));` +
    `at('pointerdown',0.4,0.6); at('pointermove',0.45,0.58); return 1`,
)
/* The red is on the live canvas: under §3 of the contract the pointer lives on `ink-live`. */
const pultRed =
  `(()=>{const c=document.querySelector('canvas.ink-live');` +
  `if(!c||!c.width) return -1;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `let n=0; for(let i=0;i<d.length;i+=4) if(d[i+3]>24 && d[i]>150 && d[i+1]<120) n+=1; return n})()`
const litUp = await until(pult, `${pultRed} > 0`, 'the console pointer lit up', 8000)
check(litUp, 'the console pointer shines after a press', `${await pult.js(`return ${pultRed}`)} red pixels on ink-live`)
await pult.js(
  inkTarget +
    `input.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,pointerType:'pen',buttons:0,` +
    `clientX:r.left+r.width*0.45,clientY:r.top+r.height*0.58})); return 1`,
)
/*
 * The pointer is a palette tool, not a separate mode: in GoodNotes and
 * Notability choosing a pen turns it off, and here too. It is switched off not
 * by a second tap on itself but by "Pen" — that way you never forget it
 * wandering over the projector until the end of the class.
 */
await pult.js(press(PULT.pen))
/*
 * A circled figure burns out even after the tool changes — just as in the
 * hall: putting it out on the console instantly would mean showing the
 * presenter something other than what the hall sees. We wait for the end of
 * the burn (HOLD_MS + FADE_MS in InkLayer) and demand emptiness: a pointer left
 * pressed is exactly what must not happen.
 */
const wentOut = await until(pult, `${pultRed} === 0`, 'the pointer figure burned out', 4000)
check(
  wentOut &&
    (await pult.js(
      `return document.querySelector('[aria-label=${JSON.stringify(PULT.laser)}]')?.getAttribute('aria-pressed') === 'false'`,
    )) === true,
  'choosing the pen turns the pointer off',
  `pointer aria-pressed=${await pult.js(
    `return document.querySelector('[aria-label=${JSON.stringify(PULT.laser)}]')?.getAttribute('aria-pressed') ?? '?'`,
  )} · red on ink-live ${await pult.js(`return ${pultRed}`)}`,
)

/* The case and the well do not get in here: they are opaque (alpha 1), the veil is not. */
const faderCells =
  `(()=>{const root=document.querySelector('[aria-label=${JSON.stringify(PULT.fader)}]');` +
  `if(!root) return [];` +
  `let cells=[...root.querySelectorAll('button,[role="radio"],[role="button"]')];` +
  `if(!cells.length&&root.matches('button,[role="radio"],[role="button"]')) cells=[root];` +
  `if(!cells.length) cells=[...root.children];` +
  `return cells})()`
const faderSteps = (await pult.js(`return ${faderCells}.length`)) as number
check(faderSteps === 3, 'the sheet fader has three steps', `cells ${faderSteps}`)
/*
 * A step is measured AT REST, not after a fixed pause.
 *
 * The veil has a 320 ms transition, and `getComputedStyle` returns the value of
 * the last style computation — that is, the current animation frame. Frames on
 * the console are rare: headless without an accelerator redraws the whole
 * lecture sheet, and "wait 450 ms" on a busy machine caught the veil still at
 * the start of the transition. The check then declared broken a fader whose
 * markup had exactly what the contract asked for. We wait until the value
 * stops changing: two identical readings in a row, with a frame between them
 * pulled out by its own rAF.
 */
async function restingVeil(): Promise<number> {
  let last = Number.NaN
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await wait(200)
    const now = (await pult.js(
      `await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));` +
        `return ${veil}`,
    )) as number
    if (now === last) return now
    last = now
  }
  return last
}

const ladder: number[] = []
for (let i = 0; i < faderSteps; i += 1) {
  await pult.js(`${faderCells}[${i}].click(); return 1`)
  ladder.push(await restingVeil())
}
const rungs = [...ladder].sort((a, b) => a - b)
check(
  rungs.length === 3 &&
    rungs[0] <= 0.05 &&
    rungs[1] > 0.2 &&
    rungs[1] < 0.36 &&
    rungs[2] > 0.46 &&
    rungs[2] < 0.64,
  'the fader changes the opacity of the veil',
  rungs.length ? rungs.join(' · ') : 'no veil found',
)
/* Back to "hall": it is the default, and the rest of the run lives with it. */
const hall = ladder.indexOf(rungs[1])
if (hall >= 0) {
  await pult.js(`${faderCells}[${hall}].click(); return 1`)
  await restingVeil()
}

/*
 * In landscape the notes are a sliding sheet over the lower part of the page:
 * the lecture sheet takes up the whole rest of the screen, and there is no
 * permanent strip under it any more. The "Notes" key on the rail raises it and
 * holds `aria-pressed`; above, the sheet has already been opened by the roll
 * call of controls — here it is checked that it closes and opens again.
 */
await pult.js(press(PULT.notes))
await wait(400)
check(
  (await pult.js(`return !document.querySelector('[data-pult-notes] .pult-prompt')`)) === true &&
    (await pult.js(`return ${pressedIs(PULT.notes)}`)) === 'false',
  'the "Notes" key folds the notes sheet',
  `aria-pressed=${await pult.js(`return ${pressedIs(PULT.notes)}`)}`,
)
await pult.js(press(PULT.notes))
await wait(500)
check(
  (await pult.js(`return !!document.querySelector('[data-pult-notes] .pult-prompt')`)) === true &&
    (await pult.js(`return ${pressedIs(PULT.notes)}`)) === 'true',
  "the speaker's notes slide out and can be read",
  await pult.js(
    `return (document.querySelector('[data-pult-notes] .pult-prompt')?.textContent||'').trim().slice(0,40) || 'no sheet'`,
  ),
)
/*
 * THE NOTES ON THE CONSOLE ARE PINNED. A talk is written at a desk and read at
 * the console: there is no input field here at all, and this is checked
 * directly — not "the field is not focused" but "the field does not exist".
 * While it existed, the tablet caught accidental palm touches with it, raised
 * the keyboard over half the screen, and the Pencil started converting strokes
 * into text.
 */
check(
  (await pult.js(`return !document.querySelector('[data-pult-notes] textarea')`)) === true,
  'the notes on the console cannot be edited',
  await pult.js(
    `return 'input fields '+document.querySelectorAll('[data-pult-notes] textarea, [data-pult-notes] [contenteditable]').length`,
  ),
)
check(
  (await pult.js(
    `const t=document.querySelector('[data-pult-notes] .pult-prompt');return t?getComputedStyle(t).userSelect:'missing'`,
  )) !== 'none',
  'the notes text can be selected',
  await pult.js(
    `const t=document.querySelector('[data-pult-notes] .pult-prompt');return 'user-select='+(t?getComputedStyle(t).userSelect:'missing')`,
  ),
)
/* There is no room on the console at all: no tabs, no file panel, no Oracle. */
check(
  (await pult.js(
    `return !document.querySelector('[aria-label="Toggle the AI oracle"]') && !document.querySelector('[role="tablist"]')`,
  )) === true,
  'the room did not move onto the console',
  'only the lecture',
)
/*
 * THE "MORE" SHEET — AND THE FACT THAT IT OPENS FROM THE NOTES HEADER.
 *
 * The load of the removed strip lives here: full screen, "Change document",
 * "Left hand", a note on screen sleep and "End lecture". There is nowhere to
 * open this from except "⋯" in the header of the notes strip, and the place of
 * the button is part of the contract: the notes header starts UNDER the sheet.
 * A button that moved back to the top is the strip come back, only made of one
 * glyph.
 */
const morePlace = (await pult.js(
  `const b=document.querySelector('[aria-label=${JSON.stringify(PULT.more)}]');` +
    `if(!b) return 'no "Ещё" button';` +
    `const notes=document.querySelector('[data-pult-notes]');` +
    `if(!notes) return 'no notes sheet';` +
    `if(!notes.contains(b)) return 'outside the notes sheet';` +
    `const r=b.getBoundingClientRect(),n=notes.getBoundingClientRect();` +
    `return r.top-n.top<=48 ? 'in the notes header' : 'in the notes sheet, but '+Math.round(r.top-n.top)+'px below the header'`,
)) as string
check(morePlace === 'in the notes header', '"More" lives in the header of the notes sheet', morePlace)

await pult.js(press(PULT.more))
await wait(400)
const endsHere = (await pult.js(
  `return /закончить лекц/i.test(document.body.innerText||'')` +
    ` || !!document.querySelector('[aria-label="Закончить лекцию"]')`,
)) as boolean
check(endsHere === true, 'the "More" sheet has "End lecture"', endsHere ? 'present' : 'none')
/* In the same place — "Draw with your finger": the only place where the finger is allowed to draw again. */
check(
  (await pult.js(`return ${has(PULT.finger)}`)) === true,
  'the "More" sheet has "Draw with your finger"',
  await pult.js(`return ${pressedIs(PULT.finger)}`).then((v) => `aria-pressed=${v}`),
)

/* Close with both the overlay and Escape: both have to close the sheet, and
   further on the check needs the console, not a raised slab over it. */
await pult.js(`document.querySelector('[aria-label="Закрыть"]')?.click(); return 1`)
for (const type of ['keyDown', 'keyUp'] as const) {
  await pult.send('Input.dispatchKeyEvent', {
    type,
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  })
}
await until(pult, `!/закончить лекц/i.test(document.body.innerText||'')`, 'the "More" sheet closed', 4000)

/* The notes sheet folds: further on the lecture sheet itself is measured. */
await pult.js(press(PULT.notes))
await wait(400)

/*
 * THE SHEET OVER THE WHOLE REST OF THE SCREEN — on three tablets.
 *
 * The layout was computed for one 11" iPad in landscape, and on 12.9" and in
 * portrait the sheet drowned in the top third of the screen: "the document in
 * some little window". Now the sheet is everything left over from the rail and
 * the margins, and this is checked by a number, not by eye: the share of the
 * screen under the canvas, the top edge and the width of the box. The share
 * threshold comes from geometry: 16:9 in landscape fits in ≈2/3 of the screen,
 * in portrait 810 wide in a third, the rest is given to the notes.
 *
 * Each geometry is opened ANEW: the console measures the window at start, and
 * a tab recomputed on the fly would show something other than what an iPad
 * draws.
 */
const READY = `!!document.querySelector('.ink-input') && (document.querySelector('canvas.ink-wet')?.getBoundingClientRect().width||0)>200`
for (const [W, H, file] of [
  [1180, 820, 'ui-pult.png'],
  [1366, 1024, 'ui-pult-129.png'],
  [834, 1194, 'ui-pult-portrait.png'],
] as const) {
  await pult.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false })
  await pult.send('Page.reload')
  await pult.send('Page.bringToFront')
  const drawn = await until(pult, READY, `console ${W}×${H} drew the sheet`)
  await wait(500)
  await takeConsole()
  const portrait = H > W
  // The notes sheet is remembered under a key; in landscape the bare sheet is measured and shot.
  if (!portrait && (await pult.js(`return ${pressedIs(PULT.notes)}`)) === 'true') {
    await pult.js(press(PULT.notes))
    await wait(400)
  }
  const g = (await pult.js(
    `const r=e=>{if(!e) return null;const b=e.getBoundingClientRect();return {left:b.left,top:b.top,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};` +
      `return {canvas:r(document.querySelector('canvas.ink-wet')),rail:r(document.querySelector('.pult-rail')),notes:r(document.querySelector('[data-pult-notes]'))}`,
  )) as { canvas: DOMRect | null; rail: DOMRect | null; notes: DOMRect | null }
  const share = g.canvas ? (g.canvas.width * g.canvas.height) / (W * H) : 0
  const railW = g.rail && !portrait ? g.rail.width : 0
  const need = portrait ? 0.3 : 0.55
  check(
    drawn && !!g.canvas && share >= need && g.canvas.top <= 24 && g.canvas.width >= 0.8 * (W - railW - 24),
    `${W}×${H}: the sheet fills the screen`,
    g.canvas
      ? `${Math.round(g.canvas.width)}×${Math.round(g.canvas.height)} — ${Math.round(share * 100)}% of the screen (need ≥${Math.round(need * 100)}%), top ${Math.round(g.canvas.top)}px`
      : 'no canvas',
  )
  const railPlace = !g.rail
    ? 'no rail'
    : portrait
      ? g.rail.bottom >= H - 1
        ? 'at the bottom'
        : `not at the bottom (bottom ${Math.round(g.rail.bottom)})`
      : g.rail.left === 0
        ? 'on the left'
        : `not on the left (left ${Math.round(g.rail.left)})`
  check(railPlace === (portrait ? 'at the bottom' : 'on the left'), `${W}×${H}: rail ${portrait ? 'at the bottom' : 'on the left'}`, railPlace)
  if (portrait) {
    // In portrait the notes do not slide out but are docked between the sheet and the rail.
    check(
      !!g.notes && !!g.canvas && g.notes.top >= g.canvas.bottom && (!g.rail || g.notes.bottom <= g.rail.top + 1),
      `${W}×${H}: the notes are docked under the sheet`,
      g.notes ? `notes ${Math.round(g.notes.width)}×${Math.round(g.notes.height)} at y=${Math.round(g.notes.top)}` : 'no notes',
    )
  }
  if (process.argv.includes('--shot')) {
    // The screenshot is taken with a LIVE console: a tab that went into the
    // background loses its socket, and without this wait the "no connection" bar
    // got into the shot.
    await wait(400)
    const shot = await pult.send('Page.captureScreenshot', { format: 'png' })
    const where = path.resolve(file)
    writeFileSync(where, Buffer.from(shot.result.data as string, 'base64'))
    console.log(`  screenshot: ${where}`)
  }
}
/* Back to 11": the rest of the run lives with this geometry. */
await pult.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 2, mobile: false })
await pult.send('Page.reload')
await until(pult, READY, 'the console is back at 11"')
await takeConsole()
for (const line of pult.trouble.slice(0, 3)) console.log(`  (console) ${line}`)
await host.send('Page.bringToFront')

/*
 * The projection shows the page, not a black rectangle.
 *
 * The most expensive mistake of this screen: even when it works it is almost
 * all black, so an empty sheet on it cannot be told from "not arrived yet". The
 * window is brought to the front on purpose — headless does not draw background
 * tabs at all, and the projection on the beam is always in view.
 */
await beam.send('Page.bringToFront')
const beamDrew = await until(
  beam,
  `[...document.querySelectorAll('canvas')].some(c=>c.getBoundingClientRect().width>200)`,
  'the projection drew the page',
)
check(
  beamDrew,
  'the projection shows the sheet, not emptiness',
  await beam.js(
    `return document.querySelector('.shadow-pop')?.getAttribute('style') ?? 'no sheet'`,
  ),
)
await host.send('Page.bringToFront')

/*
 * Arrows on the projection turn the lecture's pages.
 *
 * The projection runs on the computer at the projector, and a keyboard and a
 * clicker are plugged into it — and a clicker sends exactly arrows and
 * PageDown. Only the one whose slides these are turns the pages: here the
 * projection window entered as the same teacher who presents.
 */
await beam.send('Page.bringToFront')
/*
 * We press until the hall turns the page. The projection window in the
 * headless browser lay in the background for a long time, and its socket may
 * have dropped: a press then waits in the queue for the reconnection. A person
 * does not do this — the projection has its own monitor — but the check has
 * to, otherwise it checks Chrome's background tabs.
 */
const onThird = `[...document.querySelectorAll('span')].some(s=>/^3 \\/ 3$/.test((s.textContent||'').trim()))`
const arrow = (key: string) =>
  beam.js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true})); return 1`)
async function pressUntil(key: string, seen: string, what: string): Promise<boolean> {
  for (let i = 0; i < 12; i += 1) {
    await arrow(key)
    if (await until(student, seen, what, 1500)) return true
  }
  return false
}
await wait(400)
check(await pressUntil('ArrowRight', onThird, 'the arrow on the projection went on to the third page'), 'arrows on the projection turn the lecture pages', 'forward: 3 / 3')
check(await pressUntil('ArrowLeft', onSecond, 'the arrow on the projection went back to the second page'), 'and back too', 'back: 2 / 3')
await host.send('Page.bringToFront')

/*
 * "Project" from the room opens a separate window, and the room stays.
 *
 * The projection used to go into the same tab, and the room on that computer
 * ended. Here we check that the tab's address did not change and that the
 * projection window appeared among the browser's targets.
 */
/*
 * `window.open` is replaced: a synthetic click is not a human gesture, and the
 * browser does not let it open a window, while the product, on its fallback
 * path, navigates the tab itself. We check the intention — where it opens and
 * that the tab stays — not the pop-up policy of the headless browser.
 */
await host.js(
  `window.__opened=null; window.open=(u)=>{window.__opened=String(u); return {focus(){}, closed:false}};` +
    `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='На проектор');` +
    `if(!b) throw new Error('no "На проектор" button'); b.click(); return 1`,
)
await wait(600)
check(
  (await host.js(`return location.pathname`)) === `/s/${ROOM}`,
  'the room stays in place after "Project"',
  await host.js(`return location.pathname`),
)
check(
  (await host.js(`return window.__opened`)) === `/s/${ROOM}/screen`,
  'the projection opens in a separate window',
  await host.js(`return String(window.__opened)`),
)

/*
 * A blank sheet.
 *
 * The slide has ended, but the derivation has not. The sheet is created from
 * the console and has to reach the projector as a white field: a page with a
 * negative number exists in the lecture but not in the document, and
 * everything that only knows PDF has to know about it. Exactly that is checked
 * — that the beam is clean, not showing the last slide.
 */
await pult.send('Page.bringToFront')
/*
 * The key stayed a key, but there is no word on it any more: a blank sheet is
 * created in the middle of a sentence, and two presses (the page strip → "+ new
 * sheet") for that are already a failure. It is found by name, not by label.
 */
await until(pult, named(PULT.blank), 'the blank sheet key is in place')
await pult.js(press(PULT.blank))
const blankSheet =
  `(async()=>{const c=[...document.querySelectorAll('canvas')].find(n=>n.getBoundingClientRect().width>200);` +
  `if(!c||!c.width) return false;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=3;i<d.length;i+=4) if(d[i]>16) return false; return true})()`
await beam.send('Page.bringToFront')
const cleared = await until(beam, blankSheet, 'the projection became a blank sheet', 12000)
check(cleared, 'the blank sheet reaches the projector', 'a white field')
/*
 * The gauge says so, and only the gauge: a blank sheet has no share of the
 * deck, so instead of "7 / 24" it shows "Л2", and instead of the pace ruler
 * the word "ЛИСТ". We ask the gauge, not the whole page: the word "лист" can
 * turn up by accident anywhere.
 */
await pult.send('Page.bringToFront')
const boardGauge = (await pult.js(`return ${gaugeText}`)) as string
check(
  /Л\s*\d/i.test(boardGauge) || /лист/i.test(boardGauge),
  'the console says it shows a sheet, not a page',
  boardGauge || 'the gauge is silent',
)
/* And back to the slides — with the same press: the written sheet has not gone anywhere. */
await until(pult, named(PULT.toSlide), 'the back-to-slide key appeared')
await pult.js(press(PULT.toSlide))
await beam.send('Page.bringToFront')
await wait(300)
await until(beam, `!${blankSheet}`, 'the projection returned to the slide')
await host.send('Page.bringToFront')

/* Pause darkens the projection, but not the console: the presenter keeps the page. */
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Пауза').click(); return 1`,
)
/* Both statements are checked, not one: a hall that did not go dark used to
   pass this line with a cheerful "yes", because the result of the wait went
   nowhere. */
const dimmed = await until(beam, `(document.body.textContent||'').includes('пауза')`, 'the projection went dark')
const hostKept = (await host.js(`return document.querySelectorAll('canvas').length > 0`)) === true
check(
  dimmed && hostKept,
  'pause darkens the hall, and the presenter keeps the page',
  dimmed ? (hostKept ? 'yes' : 'the hall went dark, but the presenter has no page either') : 'the hall did not go dark',
)
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Пауза').click(); return 1`,
)

/*
 * The end of the lecture returns everyone to the ordinary reader — on the
 * second press.
 *
 * The first press only asks, and that is checked by a separate line: "End"
 * stands right next to "Project" — the button the presenter presses at the
 * start of a class — and a miss by one carried off the markup of the whole
 * lecture irreversibly. Without this check the button will one day go back to
 * a single click, and the stand will keep quiet.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Закончить');` +
    `if(!b) throw new Error('no "Закончить" button in the bar'); b.click(); return 1`,
)
await wait(300)
const stopAsked =
  (await host.js(
    `return [...document.querySelectorAll('button')]` +
      `.some(b=>(b.textContent||'').trim()==='Закончить лекцию?')`,
  )) === true
const stillLive =
  (await student.js(`return (document.body.textContent||'').includes('Лекцию ведёт')`)) === true
check(
  stopAsked && stillLive,
  'the first "End" asks rather than ends',
  stopAsked ? (stillLive ? 'asked' : 'asked, but the lecture is already over') : 'did not ask',
)
await host.js(
  `const b=[...document.querySelectorAll('button')]` +
    `.find(x=>['Закончить','Закончить лекцию?'].includes((x.textContent||'').trim()));` +
    `if(!b) throw new Error('"Закончить" vanished between the presses'); b.click(); return 1`,
)
await until(
  student,
  `!(document.body.textContent||'').includes('Лекцию ведёт')`,
  'the lecture ended for the student',
)
check(
  (await student.js(`return !(document.body.textContent||'').includes('Лекцию ведёт')`)) === true,
  'ending the lecture removes it for everyone',
  'removed',
)
for (const line of beam.trouble.slice(0, 3)) console.log(`  (projection) ${line}`)

await host.js(`document.querySelector('[aria-label="Закрыть lecture.pdf"]')?.click(); return 1`)
await wait(400)

/*
 * The number of a selected cell is a mark, not a dark rectangle.
 *
 * `cn` is clsx, it does not resolve classes: the state colour and the mark
 * colour both stayed, and the digits came out in the colour of their own
 * background. On screen it read as a filled square instead of a number.
 */
await host.js(pressCell(0))
await wait(300)
const inkOnInk = await host.js(
  `const cell=document.querySelector('[aria-label$="selected"]');` +
    `const span=[...cell.querySelectorAll('span')].find(s=>/^\\d\\d$/.test((s.textContent||'').trim()));` +
    `if(!span) return 'no number found';` +
    `const css=getComputedStyle(span);` +
    `return css.color === css.backgroundColor ? 'digits in the background colour' : css.color + ' on ' + css.backgroundColor`,
)
check(
  typeof inkOnInk === 'string' && inkOnInk.includes(' on '),
  'the number of a selected cell is readable, not filled in',
  inkOnInk,
)

/*
 * An image opens instead of showing its name.
 *
 * A file in the room has no public address: an `<img>` with a direct link got
 * 401 and drew `alt` — that is, the file name. It looked like "images do not
 * open", and that was the truth.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith('схема.gif'));` +
    `if(!b) throw new Error('the image is not in the tree'); b.click(); return 1`,
)
await until(
  host,
  `(document.querySelector('main img, img[alt="схема.gif"]')?.naturalWidth ?? 0) > 0`,
  'the image loaded',
)
check(
  (await host.js(
    `return (document.querySelector('img[alt="схема.gif"]')?.naturalWidth ?? 0) > 0`,
  )) === true,
  'the image opens instead of showing its name',
  await host.js(
    `return (document.querySelector('img[alt="схема.gif"]')?.naturalWidth ?? 0) + 'px'`,
  ),
)
await host.js(`document.querySelector('[aria-label="Закрыть схема.gif"]')?.click(); return 1`)
await wait(300)

/* There are no more quick actions in the Oracle panel. */
check(
  (await host.js(
    `return [...document.querySelectorAll('button')].some(b=>/^(Explain|Fix|Debug|Improve|Hint)$/.test((b.textContent||'').trim()))`,
  )) === false,
  'no "explain/fix/improve" buttons in the panel',
  'removed',
)

/* A notebook can be closed too — its tab used to be eternal. */
await host.js(`document.querySelector('[aria-label="Закрыть разбор.ipynb"]').click(); return 1`)
await wait(400)
check(
  (await host.js(`return document.querySelectorAll('main').length`)) === 1,
  'a notebook closes like any other file',
  'one left',
)

/*
 * A screenshot as a keepsake — on request with `--shot`.
 *
 * The checks answer the question "does it work", and none of them answers
 * "what does it look like". File-type icons, tab spacing and tree density are
 * checked only by eye, and a screenshot is the only way to look at them without
 * bringing everything up by hand.
 */
if (process.argv.includes('--shot')) {
  // The screenshot is taken with the document OPEN and the page strip: that is
  // the newest thing on the screen and the only thing checked by eye.
  await host.js(
    `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith('lecture.pdf')); b&&b.click(); return 1`,
  )
  await wait(1200)
  // We wait for the document itself: before it arrives there is no page strip by
  // construction, and a blind press on "Pages" at that moment closed exactly
  // what the screenshot is taken for.
  await until(host, `document.querySelectorAll('canvas').length > 0`, 'the document for the screenshot')
  await host.js(
    `if(!document.querySelector('[data-rail]')){` +
      `[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Полоса страниц')?.click()}` +
      `return 1`,
  )
  await wait(900)
  await wait(500)
  // With a selected cell: the filled number is the smallest thing worth looking
  // at by eye, and exactly what once turned out to be a dark square.
  await host.js(
    // Into the body, not the root: selection listens to `[data-cell-pick]` (see pressCell).
    `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
      `cells[1]?.querySelector('[data-cell-pick]:not(span)')` +
      `?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); return 1`,
  )
  await wait(400)
  const shot = await host.send('Page.captureScreenshot', { format: 'png' })
  const where = path.resolve('ui-check.png')
  writeFileSync(where, Buffer.from(shot.result.data as string, 'base64'))
  console.log(`  screenshot: ${where}`)
}

/*
 * Room rules: a reload is not "the teacher changed".
 *
 * The rules-changed notice popped up on every page reload in any room with
 * non-open rules: the frame received while the page had no rules was treated as
 * "the first frame", but the page always has rules — from the cache or the
 * default. So first we make the rules non-open FOR REAL (through the same door
 * as the rules console), then reload the student and check that there is no
 * notice — and that a real change does show it.
 */
const RULES_NOTICE = `/Преподаватель изменил, что можно делать/.test(document.body.textContent||'')`
const patchRules = (rules: Record<string, string>) =>
  `const me=JSON.parse(localStorage.getItem('colloq.identity.v1')||'{}')[${JSON.stringify(ROOM)}];` +
  `const r=await fetch('/api/sessions/${ROOM}/rules',{method:'PATCH',headers:{'content-type':'application/json',authorization:'Bearer '+me.token},body:JSON.stringify({rules:${JSON.stringify(rules)}})});` +
  `return r.status`
check((await host.js(patchRules({ edit: 'host' }))) === 200, 'the room rules change from the screen', 'edit: host')
await until(student, RULES_NOTICE, 'the student saw the rules change')
check(
  (await student.js(`return ${RULES_NOTICE}`)) === true,
  'a real rules change shows the notice',
  'shown',
)
/*
 * The "reload" is a second tab of the same teacher, not Page.reload.
 *
 * For the bug it is the same thing: the page comes up with rules from the cache
 * and gets the socket's welcome frame. For the check it is not: a reloaded
 * presenter tab rebuilds its token and tabs and throws off a dozen checks
 * below, and a reloaded student would enter with the teacher's cookie from the
 * browser's shared storage. A second tab touches none of this and is closed
 * right after.
 */
const again = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}`)
await until(
  again,
  `!document.querySelector('input#join-name') && [...document.querySelectorAll('button')].some(b=>(b.title||'').startsWith('lecture.pdf'))`,
  "the teacher's second tab opened",
)
await wait(1500)
check(
  (await again.js(`return ${RULES_NOTICE}`)) === false,
  'a page reload does not pass itself off as a rules change',
  'no notice',
)
await again.send('Page.navigate', { url: 'about:blank' })
await wait(400)
/* Give back the open room — as it was. */
check((await host.js(patchRules({ edit: 'room' }))) === 200, 'the rules are back to open', 'edit: room')
await wait(600)

/* ---------------------------------------------- the Oracle thread and its bottom */

/*
 * The thread has to follow the audience's questions while the reader stays at
 * the bottom — and freeze as soon as they have gone up to read. This is caught
 * only by a queue of questions: a single question manages to finish drawing,
 * and the bottom does not move away.
 *
 * The check stands at the very end: it adds eight thread turns to the room, and
 * any check above that counts entries would trip over them.
 */
const OPEN_ORACLE =
  `const b=document.querySelector('[aria-label="Toggle the AI oracle"]');` +
  `if(b && !document.querySelector('textarea')) b.click(); return 1`
await host.send('Page.bringToFront')
await host.js(OPEN_ORACLE)
await student.js(OPEN_ORACLE)
await wait(900)

/** The thread's scroll window: how far is left to the bottom and where we stand. */
const THREAD =
  `const s=[...document.querySelectorAll('div')].filter(d=>(d.className||'').includes('overflow-y-auto')).pop();` +
  `if(!s) return null; return {gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), top: Math.round(s.scrollTop)}`

/*
 * The question is long on purpose: the thread turn keeps growing AFTER we have
 * scrolled down, and the whole mechanism used to fall into that gap — the
 * event of our own scroll reached the handler when the height had already
 * grown, and the thread detached itself from the bottom.
 */
const LONG =
  'Вопрос номер N: не понимаю, почему на третьей ячейке вылезает traceback про то, ' +
  'что объект не поддерживает индексацию, хотя выше по тетради ровно такая же строка ' +
  'отрабатывает без единой жалобы; расскажи подробно, что тут происходит и куда смотреть'

async function askOracle(page: Tab, text: string): Promise<void> {
  await page.js(
    `const t=[...document.querySelectorAll('textarea')].pop();` +
      `if(!t) throw new Error('no question field');` +
      `const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;` +
      `set.call(t,${JSON.stringify(text)}); t.dispatchEvent(new Event('input',{bubbles:true})); return 1`,
  )
  await wait(200)
  await page.js(
    `const t=[...document.querySelectorAll('textarea')].pop();` +
      `t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1`,
  )
  await wait(900)
}

const gaps: number[] = []
for (let n = 1; n <= 6; n += 1) {
  await askOracle(student, LONG.replace('N', String(n)))
  const at = (await host.js(THREAD)) as { gap: number } | null
  gaps.push(at?.gap ?? 999)
}
check(
  gaps.every((g) => g < 40),
  'the Oracle thread keeps to the bottom on every question',
  `gaps: ${gaps.join(', ')}`,
)

/* A reader who went up is not jerked by a new question: reading matters more than following. */
await host.js(
  `const s=[...document.querySelectorAll('div')].filter(d=>(d.className||'').includes('overflow-y-auto')).pop();` +
    `s.scrollTop = Math.max(0, s.scrollTop - 260); s.dispatchEvent(new Event('scroll')); return 1`,
)
await wait(400)
const parked = (await host.js(THREAD)) as { top: number } | null
await askOracle(student, LONG.replace('N', '7'))
const stayed = (await host.js(THREAD)) as { top: number } | null
check(
  parked !== null && stayed !== null && Math.abs(stayed.top - parked.top) < 8,
  'a new question does not jerk a reader who went up the thread',
  `stood at ${parked?.top}, stayed at ${stayed?.top}`,
)
check(
  (await host.js(`return !!document.querySelector('button.animate-fade-up')`)) === true,
  'a new-answer mark appeared at the bottom of the thread',
  'present',
)

/* And the mark takes you back down, attaching the thread again. */
await host.js(`const b=document.querySelector('button.animate-fade-up'); if(b) b.click(); return 1`)
await wait(500)
await askOracle(student, LONG.replace('N', '8'))
const back = (await host.js(THREAD)) as { gap: number } | null
check((back?.gap ?? 999) < 40, 'after the mark the thread follows the questions again', `gap ${back?.gap}`)

for (const [who, page] of [
  ['teacher', host],
  ['student', student],
] as const) {
  for (const line of page.trouble.slice(0, 4)) console.log(`  (${who}) ${line}`)
}

/*
 * And the same as a check, not as a line in the output.
 *
 * Exceptions are collected from the very start "because a check that keeps
 * quiet about something having crashed on the page sends people looking for
 * the cause in code that has nothing to do with it" — but they did not get
 * into the result: a page throwing a TypeError on every frame gave "the
 * interface answers" and exit code 0, and the three lines about it drowned
 * among two hundred. There was no silence, and there was no failure either.
 */
const pages = [
  ['teacher', host],
  ['student', student],
  ['tablet', pad],
  ['projection', beam],
  ['console', pult],
  ['second tab', again],
] as const
const broke = pages.filter(([, page]) => page.trouble.length > 0)
check(
  broke.length === 0,
  'pages throw no exceptions',
  broke.length === 0
    ? 'none'
    : broke.map(([who, page]) => `${who}: ${page.trouble.length} — ${page.trouble[0]}`).join(' · '),
)

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.what.padEnd(46)} ${r.got}`)
}
console.log(failed === 0 ? '\n  the interface answers' : `\n  failures: ${failed}`)

/* cleanUp on 'exit' removes the browser and the temporary directory — on this
   path and on any failure halfway. */
process.exit(failed === 0 ? 0 : 1)
