/**
 * Taking the lecture over, in two real browsers.
 *
 *   npx tsx scripts/ui-check.mts --takeover-only
 *
 * The findings this answers were all found by hand on a stand: the same
 * teacher in a second browser saw "presented by Ada" about herself with
 * nothing to press; the console that lost the lecture went quiet mid-stroke;
 * a holder who closed the lid stayed "presenting" forever. So the check is
 * the same walk: browser A presents (the room on the laptop, the console on
 * an iPad), browser B is the same teacher in a second browser profile, B
 * takes over, A is told and takes it back, then A disappears and B takes
 * over a stale lock without waiting.
 *
 * Two PROFILES, not two tabs: a participant lives in localStorage, and two
 * tabs of one profile are one participant (the handoff case, which leads
 * together). A separate browser context is exactly "Safari next to Chrome".
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import WS from 'ws'

export interface Tab {
  js: (expr: string) => Promise<unknown>
  send: (method: string, params?: Record<string, unknown>) => Promise<any>
  trouble: string[]
}

export interface TakeoverContext {
  host: Tab
  /** A new tab in the host's profile: the same participant. */
  tab: (url: string) => Promise<Tab>
  cdp: string
  port: number
  room: string
  cookie: { name: string; value: string }
  wait: (ms: number) => Promise<unknown>
  until: (page: Tab, expr: string, what: string, ms?: number) => Promise<boolean>
  enter: (page: Tab, name: string) => Promise<void>
  shots: string
}

const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/17.0 Mobile/15E148 Safari/604.1'

/** Wire a CDP page socket the same way ui-check's `tab` does. */
async function attach(url: string): Promise<Tab> {
  const ws = new WS(url)
  await new Promise<void>((r) => ws.on('open', () => r()))
  let seq = 0
  const waiters = new Map<number, (value: any) => void>()
  const trouble: string[] = []
  ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString())
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)!(m)
      waiters.delete(m.id)
    }
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
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = ++seq
      waiters.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
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

/** A tab in a NEW browser context: its own cookies and localStorage, a second "browser". */
async function contextTab(cdp: string): Promise<{ page: Tab; close: () => Promise<void> }> {
  const version = (await (await fetch(`${cdp}/json/version`)).json()) as {
    webSocketDebuggerUrl: string
  }
  const root = await attach(version.webSocketDebuggerUrl)
  const made = await root.send('Target.createBrowserContext', { disposeOnDetach: false })
  const browserContextId = made.result.browserContextId as string
  const target = await root.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const targetId = target.result.targetId as string
  const port = new URL(cdp).port
  const page = await attach(`ws://127.0.0.1:${port}/devtools/page/${targetId}`)
  return {
    page,
    close: async () => {
      await root.send('Target.closeTarget', { targetId })
    },
  }
}

async function shot(page: Tab, file: string): Promise<void> {
  const res = await page.send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, Buffer.from(res.result.data, 'base64'))
}

export async function checkTakeover(ctx: TakeoverContext): Promise<boolean> {
  const { host, port, room, wait, until, enter } = ctx
  mkdirSync(ctx.shots, { recursive: true })
  const results: { ok: boolean; what: string; got: string }[] = []
  const check = (ok: boolean, what: string, got: unknown) => {
    results.push({ ok, what, got: String(got) })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok ? '' : ` — got: ${String(got)}`}`)
  }
  const text = (page: Tab, selector: string) =>
    page.js(
      `return document.querySelector(${JSON.stringify(selector)})?.textContent?.replace(/\\s+/g,' ').trim() ?? null`,
    )

  /* -------------------------------------------- A: the laptop starts it */
  await host.js(
    `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('lecture.pdf'));` +
      `if(!b) throw new Error('no lecture.pdf row in the tree'); b.click(); return 1`,
  )
  await until(host, 'document.querySelectorAll("canvas").length >= 1', 'the teacher has the pages')
  await host.js(
    `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Лекция');` +
      `if(!b) throw new Error('no "Лекция" button'); b.click(); return 1`,
  )
  const presenterBar = `[...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`
  check(
    await until(host, presenterBar, 'the laptop presents'),
    'A (laptop) started the lecture and presents',
    'no bar',
  )

  /* ------------------------------ A: the iPad console, same participant */
  const pult = await ctx.tab('about:blank')
  await pult.send('Emulation.setUserAgentOverride', { userAgent: IPAD_UA, platform: 'iPad' })
  await pult.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await pult.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await pult.send('Page.navigate', { url: `http://127.0.0.1:${port}/s/${room}/pult` })
  await until(
    pult,
    `!!document.querySelector('[aria-label="Следующая страница"]')`,
    'the console is up',
  )
  await wait(800)
  const cover = (await pult.js(
    `const b=document.querySelector('[aria-label="Коснуться и начать"]');if(!b) return null;` +
      `const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}`,
  )) as { x: number; y: number } | null
  if (cover) {
    await pult.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: cover.x, y: cover.y, id: 1 }],
    })
    await wait(60)
    await pult.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await wait(400)
  }
  // The iPad acts: the room should now name it as the presenting device.
  await pult.js(`document.querySelector('[aria-label="Следующая страница"]').click(); return 1`)
  await wait(800)

  /* ------------------------- B: the same teacher in a second browser */
  const second = await contextTab(ctx.cdp)
  const b = second.page
  await b.send('Network.setCookie', { ...ctx.cookie, domain: '127.0.0.1', path: '/' })
  await b.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await b.send('Page.navigate', { url: `http://127.0.0.1:${port}/s/${room}` })
  await enter(b, 'Ада')
  const banner = `!!document.querySelector('[data-takeover]')`
  // The lecture document is the shared screen: B lands on it.
  check(
    await until(b, banner, 'B sees the take-over banner'),
    'B sees the take-over banner',
    await text(b, 'main'),
  )
  const title = String(await text(b, '[data-takeover] p'))
  check(
    /с другого устройства \(iPad, пульт\)/.test(title),
    'B is told it is itself, on the iPad console',
    title,
  )
  const sub = String(
    await b.js(`return document.querySelectorAll('[data-takeover] p')[1]?.textContent ?? ''`),
  )
  check(
    /в сети/.test(sub) && /последнее действие/.test(sub) && /страница 2/.test(sub),
    'B sees online, last action and the page',
    sub,
  )
  // At 1180 with the room's panels open the middle is narrow: "Notes" is there, and opens the editor.
  check(
    (await b.js(`return !!document.querySelector('[data-takeover] [data-notes-open]')`)) === true,
    'B has "Notes" in the banner without leading',
    'no Notes key',
  )
  check(
    /страницы листают на iPad/.test(String(await b.js(`return document.body.textContent`))),
    'the strip under the slide says the iPad turns the pages',
    'no strip',
  )
  await shot(b, path.join(ctx.shots, 'b-1180x820.png'))
  const fits = async (page: Tab) =>
    page.js(
      `const r=[...document.querySelectorAll('[data-takeover] button')].map(x=>x.getBoundingClientRect());` +
        `return document.documentElement.scrollWidth<=innerWidth && r.length>0 && r.every(x=>x.right<=innerWidth+0.5&&x.left>=0)`,
    )
  check((await fits(b)) === true, 'B banner fits at 1180×820', 'overflow')
  for (const [w, h] of [
    [834, 1194],
    [1366, 1024],
  ]) {
    await b.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await wait(600)
    check((await fits(b)) === true, `B banner fits at ${w}×${h}`, 'overflow')
    if (w === 1366) {
      check(
        (await b.js(`return !!document.querySelector('[data-cohost-notes] textarea')`)) === true,
        'B has the notes editor beside the slide at 1366 without leading',
        'no textarea',
      )
    }
    await shot(b, path.join(ctx.shots, `b-${w}x${h}.png`))
  }
  await b.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await wait(400)

  // The people list names the second browser as you, not a stranger.
  check(
    /Вы · другое устройство/.test(String(await host.js('return document.body.textContent'))),
    'A sees B in the people list as "you · another device"',
    'no badge',
  )

  /* -------------------------------------------------- B takes it over */
  await b.js(`document.querySelector('[data-takeover] [data-take]').click(); return 1`)
  check(
    await until(b, presenterBar, 'B presents', 8000),
    'B took it over in one press (itself, no question)',
    'still watching',
  )

  check(
    await until(pult, `!!document.querySelector('[data-taken]')`, 'A console is told', 8000),
    'the old console shows "taken over"',
    'nothing',
  )
  const taken = String(await text(pult, '[data-taken]'))
  check(
    /Лекцию перехватили/.test(taken) && /Mac · \d\d:\d\d/.test(taken),
    'the notice says Mac and the time',
    taken,
  )
  check(
    /сохранили до момента передачи/.test(taken),
    'the notice says what happened to the line',
    taken,
  )
  await shot(pult, path.join(ctx.shots, 'c-1180x820.png'))
  check(
    await until(
      host,
      `/Лекцию перехватили/.test(document.querySelector('[data-takeover]')?.textContent||'')`,
      'A laptop is told',
      8000,
    ),
    'the old laptop room says "taken over" too',
    await text(host, '[data-takeover]'),
  )
  await shot(host, path.join(ctx.shots, 'a-room-taken.png'))

  /* ------------------------------------------- A takes it back from the iPad */
  await pult.js(`document.querySelector('[data-give-back]').click(); return 1`)
  check(
    await until(
      pult,
      `!document.querySelector('[data-taken]') && !document.querySelector('[data-grab]')`,
      'A leads again',
      8000,
    ),
    '"Take it back" returns the console to the iPad',
    'still taken',
  )
  check(await until(b, banner, 'B watches again', 8000), 'B is back to the banner', 'no banner')

  /* ----------------------------------------- A disappears: a stale lock */
  // Closed, not navigated away: a page left for about:blank may sit in the
  // back-forward cache with its sockets still open, which is not a closed lid.
  void pult.send('Page.close')
  void host.send('Page.close')
  check(
    await until(
      b,
      `/не в сети/.test(document.querySelector('[data-takeover]')?.textContent||'')`,
      'B sees offline',
      15000,
    ),
    'B sees the holder offline within the grace',
    await text(b, '[data-takeover]'),
  )
  check(
    /не в сети — пульт перейдёт сразу/.test(String(await text(b, '#take-hint'))),
    'the hint says the take-over does not wait',
    await text(b, '#take-hint'),
  )
  await shot(b, path.join(ctx.shots, 'b-stale.png'))
  await b.js(`document.querySelector('[data-takeover] [data-take]').click(); return 1`)
  check(
    await until(b, presenterBar, 'B presents', 8000),
    'B took over a stale lock at once',
    'still watching',
  )

  const trouble = [...b.trouble, ...pult.trouble].filter((line) => !/favicon|ERR_|404/.test(line))
  check(trouble.length === 0, 'no exceptions in either browser', trouble.join(' | '))
  await second.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} take-over checks passed`)
  return failed.length === 0
}
