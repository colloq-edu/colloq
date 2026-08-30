/**
 * Сходится ли проектор с пультом, когда листают быстро.
 *
 * Появился после жалобы с настоящей пары: «пролистать вперёд или назад — синк
 * может догонять пульт секунд пять или больше или не догонять вообще и
 * оставаться на старом слайде». Ни один существующий стенд этого не ловит:
 * `ui-check` листает по одной странице и ждёт ответа после каждой, а именно
 * ожидание и прячет всю болезнь. Мерить надо ОЧЕРЕДЬ нажатий — десять подряд
 * быстрее, чем успевает обернуться сокет.
 *
 * Меряются три вещи, и они разные:
 *   ДОШЛО   — какую страницу в итоге показывает сервер (все ли нажатия учтены);
 *   КОГДА   — через сколько после ПОСЛЕДНЕГО нажатия проекция нарисовала её;
 *   ЧТО     — те ли это пиксели (отпечаток холста против эталона той страницы).
 *
 * Третье здесь не паранойя: «остаётся на старом слайде» — это когда состояние
 * доехало, а холст остался прежним, и никакая проверка по состоянию такого не
 * видит.
 *
 * Порты свои (3898 и 9338): ui-check живёт на 3891/9334, pencil-check на
 * 3897/9337, и три прогона рядом друг другу не мешают.
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
/** Столько страниц в колоде: очередь нажатий должна упираться в документ, а не в его конец. */
const PAGES = 24

/* ------------------------------------------------------- маленький PDF */

/** Тот же PDF, что в остальных стендах, только длиннее: слайды 16:9. */
function samplePdf(pages: number): string {
  const obj = (n: number, body: string) => `${n} 0 obj\n${body}\nendobj\n`
  const font = 3 + pages * 2
  const parts = [obj(1, '<< /Type /Catalog /Pages 2 0 R >>')]
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')
  parts.push(obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`))
  for (let i = 0; i < pages; i += 1) {
    /*
     * Страницу опознаёт ПОЛОСА, длина которой зависит от номера, — и никакого
     * текста. Стенду нужно уметь сказать «на проекторе седьмая, а не третья»,
     * и опираться в этом на шрифт нельзя: pdf.js без `standardFontDataUrl`
     * бросает на первом же Helvetica и оставляет холст белым, дорисовав один
     * фон. Первая версия этого стенда так и молчала — восемь «разных» страниц
     * с одинаковым отпечатком. Полоса рисуется до всякого текста и не зависит
     * ни от чего, кроме двух чисел.
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
  // Шрифта в колоде нет вовсе: страницы различает полоса, а не надпись.
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

/* ---------------------------------------------------------------- сервер */

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

/* ---------------------------------------------------------------- браузер */

const chrome = spawn(
  CHROME,
  [
    ...(HEADED ? [] : ['--headless=new']),
    '--disable-gpu',
    /*
     * Без этих трёх флагов вкладка, оказавшаяся не на виду, не получает НИ
     * ОДНОГО кадра, а pdf.js продвигает отрисовку именно кадрами: холст
     * остаётся тем белым фоном, который заливается синхронно, и стенд меряет
     * пустоту. Ровно на этом первая версия стенда и встала — «восемь разных
     * страниц с одинаковым отпечатком».
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
    /* ещё не поднялся */
  }
  await wait(250)
}
if (!browserWsUrl) {
  console.error(`Chrome не открыл порт отладки. Он вообще есть по пути?\n  ${CHROME}`)
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
      trouble.push('искл: ' + (d?.exception?.description ?? d?.text ?? '?'))
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
  console.log(`  (не дождались: ${what})`)
  return false
}

const results: { ok: boolean; what: string; got: string }[] = []
const check = (ok: boolean, what: string, got: unknown) =>
  results.push({ ok, what, got: String(got) })

/* ------------------------------------------------------- комната и лекция */

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
    `if(!b) throw new Error('строки lecture.pdf в дереве нет'); b.click(); return 1`,
)
await until(host, 'document.querySelectorAll("canvas").length > 0', 'документ открылся у ведущего')
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Лекция');` +
    `if(!b) throw new Error('кнопки «Лекция» нет'); b.click(); return 1`,
)
await until(
  host,
  `[...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`,
  'лекция идёт',
)

/*
 * Отпечаток страницы — ОДНА строка пикселей поперёк листа.
 *
 * Первая версия читала весь холст целиком: полтора миллиона пикселей, четыре
 * холста, и всё это по проводу отладчика. Одна такая мерка стоила три секунды,
 * и стенд предъявлял их продукту как его задержку — хотя трасса отрисовки в то
 * же время показывала 419 мс на всё. Мера, которая дороже измеряемого, меряет
 * себя.
 *
 * Страницы различает чёрная полоса, растущая с номером; строка на середине
 * листа пересекает её всегда. Холст страницы ищется один раз — он единственный
 * непрозрачный, слои чернил прозрачны.
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

/* ------------------------------------------------------------- проекция */

/**
 * Проекция отдельной вкладкой. В продукте её открывает `window.open` из
 * комнаты, но окно и вкладка для нашей меры — одно и то же: важен свой
 * документ, свой pdf.js и свой сокет, а не рамка вокруг.
 */
const beam = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}/screen`)
/*
 * Проекцию выносим на передний план и держим там весь прогон. Это не удобство
 * стенда, а условие опыта: в фоновой вкладке браузер глушит requestAnimationFrame,
 * а pdf.js именно им продвигает отрисовку — холст остаётся белым навсегда.
 * Пульт всё это время работает из фона: нажатия ему шлются через JS, а им
 * фокус не нужен.
 */
await beam.send('Page.bringToFront')
await until(beam, `!!document.querySelector('canvas')`, 'проекция нарисовала страницу')
await wait(800)
await until(beam, FIND_SHEET, 'нашли холст страницы')
/*
 * Считаем стрелки, дошедшие до окна проекции, отдельно от того, что из них
 * вышло. Без этого «семь нажатий сдвинули на одну страницу» читается двояко:
 * то ли шесть нажатий потерялись по дороге, то ли долетели все, а логика их
 * склеила. Это разные болезни и разные лекарства.
 */
await beam.js(
  `window.__keys=0; window.addEventListener('keydown', (e)=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft') window.__keys++}, true); return 1`,
)
await wait(600)

/** Отпечаток холста проекции: сумма по редкой сетке — числа хватает, чтобы отличить страницы. */
const shownNow = () => beam.js(FINGERPRINT) as Promise<Shot | null>
/** Две страницы считаются одной, только если совпало и число тёмных пикселей, и сумма. */
const same = (a: Shot | null, b: Shot | null) =>
  a !== null && b !== null && a.dark === b.dark && a.sum === b.sum

/**
 * Та же ли это страница НА ДРУГОМ ЭКРАНЕ.
 *
 * У студента лист меньше проекторного — в комнате по бокам панели, — и считать
 * пиксели бессмысленно: одна и та же восьмая страница даёт 453 тёмных точки на
 * проекторе и 276 у студента. Сравнивать надо долю, которую занимает полоса:
 * она у страницы своя и от масштаба не зависит. Полпроцента допуска — на
 * округление краёв полосы при разном размере холста.
 */
const samePage = (a: Shot | null, b: Shot | null) =>
  a !== null && b !== null && a.w > 0 && b.w > 0 && Math.abs(a.dark / a.w - b.dark / b.w) < 0.005

/**
 * Эталоны: как выглядит каждая страница, если дать нарисовать её спокойно.
 * Снимаются ОДИН раз в начале и по одному нажатию — то есть по тому пути, в
 * котором никто не сомневается. Дальше стенд сверяет с ними быструю листалку.
 */
const press = (aria: string) =>
  `const b=document.querySelector('[aria-label=${JSON.stringify(aria)}]');` +
  `if(!b) throw new Error('на пульте нет органа «${aria}»'); b.click(); return 1`

const pult = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}/pult`)
await pult.send('Emulation.setDeviceMetricsOverride', {
  width: 1180,
  height: 820,
  deviceScaleFactor: 2,
  mobile: true,
})
await pult.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/s/${ROOM}/pult` })
await until(pult, `!!document.querySelector('.ink-input')`, 'пульт нарисовал лист')
await wait(800)

/** Какую страницу СЕРВЕР считает текущей — спрашиваем у зала, а не у пульта. */
const { lectureOf } = await import('../server/src/lecture.js')
const serverPage = () => lectureOf(ROOM)?.page ?? 0

const marks = new Map<number, Shot>()
for (let n = 1; n <= 10; n += 1) {
  if (n > 1) {
    await pult.js(press('Следующая страница'))
    await until(beam, `true`, 'кадр', 100)
    await wait(700)
  }
  /*
   * Эталон снимается на ВИДИМОМ окне: это образец того, как страница выглядит,
   * когда ей никто не мешает. Всё остальное меряется потом на закрытом окне —
   * и сверяется с этим образцом.
   */
  await beam.send('Page.bringToFront')
  /*
   * Ждём, пока холст ПЕРЕСТАНЕТ меняться, а не заранее назначенные полсекунды:
   * эталон, снятый посреди отрисовки, — это белый лист, и дальше весь прогон
   * сверяется с ним. Именно так в отчёте появлялись «страницы» с нулём тёмных
   * пикселей.
   */
  const was = marks.get(n - 1) ?? null
  let mark: Shot | null = null
  for (let i = 0; i < 40; i += 1) {
    await wait(100)
    const now = await shownNow()
    // Сперва дождаться, что страница СМЕНИЛАСЬ, и только потом — что устоялась.
    if (!now || now.dark === 0 || (was && same(now, was))) continue
    if (mark && same(now, mark)) break
    mark = now
  }
  if (mark) marks.set(n, mark)
  if (n === 1 && process.argv.includes('--why')) {
    console.log(
      '  кадры проекции: ' +
        JSON.stringify(
          await beam.js(
            `let n=0; const stop=performance.now()+600;` +
              `await new Promise(r=>{setTimeout(r,900); const t=()=>{n++; if(performance.now()<stop) requestAnimationFrame(t); else r()}; requestAnimationFrame(t)});` +
              `return {frames:n, hidden:document.hidden, vis:document.visibilityState}`,
          ),
        ),
    )
    console.log(
      '  холсты проекции: ' +
        JSON.stringify(
          await beam.js(
            `return [...document.querySelectorAll('canvas')].map(q=>{` +
              `const g=q.getContext('2d',{willReadFrequently:true});` +
              `if(!g||!q.width) return {w:q.width,h:q.height,note:'нет контекста'};` +
              `const d=g.getImageData(0,0,q.width,q.height).data;` +
              `let opaque=0,dark=0; for(let i=0;i<d.length;i+=4){if(d[i+3]>8) opaque++; if(d[i+3]>8&&d[i]+d[i+1]+d[i+2]<200) dark++}` +
              `return {cls:q.className,w:q.width,h:q.height,opaque,dark}})`,
          ),
        ),
    )
    console.log('  текст проекции: ' + JSON.stringify(await beam.js(`return (document.body.textContent||'').slice(0,140)`)))
  }
}
const distinct = new Set([...marks.values()].map((m) => `${m.dark}/${m.sum}`))
check(
  marks.size === 10 && distinct.size === 10,
  'эталоны страниц различимы',
  `${marks.size} снято, ${distinct.size} различных · холст ${[...marks.values()][0]?.w}×${[...marks.values()][0]?.h}` +
    ` · тёмных ${[...marks.values()].map((m) => m.dark).join(', ')}`,
)

/*
 * Одно нажатие, разобранное по кадрам: сколько проходит от нажатия до того, как
 * на холсте появились пиксели новой страницы. Меряется на ВИДИМОМ окне — это
 * лучший случай, какой у продукта есть, и если уж он плох, разговор про
 * закрытое окно можно не начинать.
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
    if (i % 10 === 0) seen.push(`${Date.now() - t}мс`)
    await wait(100)
  }
  console.log(
    '  ход отрисовки (мс от обнуления): ' +
      JSON.stringify(
        await beam.js(
          'const z=window.__t0||0; return (window.__renderLog||[]).slice(0,16).map(r=>({...r,t:Math.round(r.t-z)}))',
        ),
      ),
  )
  check(
    painted >= 0 && painted < 700,
    'одно нажатие: проекция перерисовалась',
    painted < 0 ? `за 6 с не перерисовалась (щупали ${seen.join(', ')})` : `${painted} мс`,
  )
}

/*
 * Студент в зале — своим контекстом браузера: личность лежит в localStorage,
 * общем на профиль, и без отдельного контекста он оказался бы тем же человеком,
 * что ведущий.
 */
const student = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}`, true)
await enter(student, 'Нина')
await until(
  student,
  `(document.body.textContent||'').includes('Лекцию ведёт')`,
  'студент увидел лекцию',
)
await student.send('Page.bringToFront')
await until(student, FIND_SHEET.replace('window.__sheet', 'window.__sheet'), 'у студента есть лист')
const seenByHall = () => student.js(FINGERPRINT) as Promise<Shot | null>

/*
 * Дальше проекция уходит за чужое окно и там остаётся. Это не приём стенда, а
 * рабочее положение вещей: окно проекции отдают в Zoom и переключаются на своё,
 * второй экран гаснет заставкой, преподаватель открывает поверх заметки. Всё,
 * что меряется ниже, обязано работать в этом положении — иначе зал остаётся на
 * прошлом слайде, а ведущий об этом не знает.
 */
await pult.send('Page.bringToFront')
await wait(400)

/* --------------------------------------------------- быстрая листалка */

/** Вернуться на первую страницу спокойно, по одному нажатию, и дать всему осесть. */
async function rewind(): Promise<void> {
  for (let i = 0; i < 40 && serverPage() > 1; i += 1) {
    await pult.js(press('Предыдущая страница'))
    await wait(120)
  }
  await wait(1200)
}

/**
 * Одна мера: N нажатий подряд с шагом `gap` мс, потом ожидание схождения.
 * Возвращает, до какой страницы дошёл сервер и через сколько после последнего
 * нажатия проекция нарисовала то, что должна.
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
  // Спокойно доходим до места, откуда меряем: сама дорога туда — не мера.
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
  /* Ждём схождения до пяти секунд — дольше на паре уже никто не ждёт. */
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
   * Главная проверка всего стенда: зал и проектор на ОДНОЙ странице. Ведущий
   * говорит про седьмую, а зал читает шестую — и узнают об этом по вопросу из
   * аудитории, если узнают вообще. Ждём до полутора секунд: студенту, в
   * отличие от проектора, разрешено доезжать чуть позже.
   */
  let hall: Shot | null = null
  for (let i = 0; i < 30; i += 1) {
    hall = await seenByHall()
    if (want && samePage(hall, want)) break
    await wait(50)
  }
  check(
    want ? samePage(hall, want) : false,
    `${what}: зал на той же странице, что проектор`,
    hall
      ? `доля полосы ${(hall.dark / hall.w).toFixed(3)} против ${((want?.dark ?? 0) / (want?.w || 1)).toFixed(3)}`
      : 'листа у студента нет',
  )
  const right = same(shown, want ?? null)
  check(
    got === expect && settled >= 0 && settled < 500,
    `${what}: ${times} нажатий за ${fired - t0} мс`,
    `сервер на ${got} из ${from}→${expect}` +
      (keys ? ` · стрелок долетело ${keys}` : '') +
      ` · холст ${right ? 'та же страница' : 'ДРУГАЯ'}` +
      ` · сошлось ${settled < 0 ? 'НЕ СОШЛОСЬ за 5 с' : settled + ' мс после последнего нажатия'}`,
  )
}

await burst(
  'пульт, вперёд',
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
  'проекция, стрелка вперёд',
  arrow(beam, 'ArrowRight', 'ArrowRight'),
  7,
  40,
  8,
)

/*
 * Назад — не зеркало «вперёд». Ведущий возвращается к формуле, которую зал не
 * успел списать, и это самое частое место, где проектор отставал: назад листают
 * очередью, не глядя, «на три слайда обратно».
 */
await burst(
  'пульт, назад',
  () => pult.js(press('Предыдущая страница')),
  6,
  40,
  4,
  10,
)

await burst(
  'проекция, стрелка назад',
  arrow(beam, 'ArrowLeft', 'ArrowLeft'),
  6,
  40,
  4,
  10,
)

/* ------------------------------------------------------------- отчёт */

for (const page of [host, pult, beam]) {
  for (const line of page.trouble.slice(0, 3)) console.log(`  (${line})`)
}
let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`  ${r.ok ? 'ok  ' : 'ПЛОХО'}  ${r.what.padEnd(48)} ${r.got}`)
}
console.log(`\n  ${failed === 0 ? 'проектор идёт за пультом' : `не сходится: ${failed}`}\n`)
chrome.kill()
process.exit(failed === 0 ? 0 : 1)
