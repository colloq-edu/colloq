/**
 * Проверка интерфейса настоящим браузером.
 *
 * Появилась после того, как в комнату уехала кнопка, которая ничего не делала:
 * приём сообщения на клиенте не был написан, типы сходились, тесты были
 * зелёными, а нажать её было нечем. Всё остальное в этом репозитории
 * проверяется без браузера — и ровно поэтому дырка была именно здесь.
 *
 * Ведёт Chrome по CDP напрямую, без Playwright: браузер на машине уже есть, а
 * ещё одна зависимость на полтораста мегабайт ради десяти нажатий не окупается.
 *
 *   npx tsx scripts/ui-check.mts            — поднять всё и проверить
 *   npx tsx scripts/ui-check.mts --headed   — то же, но с видимым окном
 *
 * Инстанс поднимается свой, во временном каталоге: гонять это по работающему
 * семинару нельзя, а забыть про такое легко.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WS from 'ws'

const HEADED = process.argv.includes('--headed')
const PORT = 3891
const CDP_PORT = 9334
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const root = mkdtempSync(path.join(tmpdir(), 'colloq-ui-'))
const ROOM = 'uicheck1'

/* ------------------------------------------------------- маленький PDF */

/** Настоящий PDF на три страницы, собранный руками: без зависимостей. */
function samplePdf(pages = 3): string {
  const obj = (n: number, body: string) => `${n} 0 obj\n${body}\nendobj\n`
  const font = 3 + pages * 2
  const parts = [obj(1, '<< /Type /Catalog /Pages 2 0 R >>')]
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')
  parts.push(obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`))
  for (let i = 0; i < pages; i += 1) {
    const stream = `BT /F1 48 Tf 72 700 Td (Stranica ${i + 1}) Tj ET`
    parts.push(
      obj(
        3 + i * 2,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
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

/* ---------------------------------------------------------------- сервер */

process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
process.env.SESSION_SECRET = 'ui-check'
process.env.PORT = String(PORT)
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`
// Ядра у проверки нет и не должно быть: она про интерфейс.
process.env.JUPYTER_URL = 'http://127.0.0.1:1'
process.env.KERNEL_ISOLATION = 'off'
process.env.STATIC_DIR = path.resolve('web/dist')

await import('../server/src/index.js')
const { createSession } = await import('../server/src/db.js')
const { createTeacher } = await import('../server/src/admin/store.js')
const { issueStaffCookie } = await import('../server/src/admin/auth.js')
const { STAFF_COOKIE } = await import('../shared/admin.js')
await new Promise((r) => setTimeout(r, 700))
createSession(ROOM, 'Проверка интерфейса', null)
const teacher = createTeacher({ name: 'Ада', email: 'ada@ui.local', role: 'owner' })!
let cookieValue = ''
issueStaffCookie({ cookie: (_n: string, v: string) => (cookieValue = v) } as never, teacher)

/* ---------------------------------------------------------------- браузер */

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
/*
 * Ждём, пока браузер откроет порт отладки. Одной попытки мало и «подождать
 * секунду» тоже: холодный запуск Chrome на занятой машине занимает несколько.
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
    /* ещё не поднялся */
  }
  await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error(
    `Chrome не открыл порт отладки. Он вообще есть по пути?\n  ${CHROME}\n` +
      'Другой путь задаётся переменной CHROME.',
  )
  chrome.kill()
  process.exit(1)
}

interface Tab {
  js: (expr: string) => Promise<unknown>
  send: (method: string, params?: Record<string, unknown>) => Promise<any>
  /** Что страница успела сломать: исключения и ошибки консоли. */
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
   * Исключения и жалобы консоли собираются с самого начала: проверка, молчащая
   * о том, что на странице что-то упало, отправляет искать причину в код,
   * который ни при чём.
   */
  const trouble: string[] = []
  ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString())
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      trouble.push('искл: ' + (d?.exception?.description ?? d?.text ?? '?'))
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      trouble.push(
        'консоль: ' + m.params.args.map((a: any) => a.value ?? a.description ?? a.type).join(' '),
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

/** Пройти экран входа под этим именем. */
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

/* ---------------------------------------------------------------- проверки */

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

const student = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}`)
await student.send('Network.clearBrowserCookies')
await student.send('Page.reload')
await enter(student, 'Нина')

check(
  (await host.js('return !document.querySelector("input#join-name")')) === true,
  'преподаватель вошёл в комнату',
  'да',
)

/*
 * Кнопки действий лежат absolute и в раскладке не участвуют: полоса,
 * рассчитанная на две, третью выкладывает поверх имени файла. Меряем зазор.
 */
const gap = (await host.js(`
  const row=[...document.querySelectorAll('button')].find(b=>(b.title||'').includes('lecture.pdf'));
  if(!row) return null;
  const lane=row.parentElement.querySelector('.relative.flex.h-6');
  if(!lane) return null;
  return Math.round(lane.getBoundingClientRect().left - row.getBoundingClientRect().right);
`)) as number | null
check(gap !== null && gap >= 0, 'кнопки не наезжают на имя файла', `зазор ${gap}px`)

const before = await student.js('return document.querySelectorAll("canvas").length')
check(before === 0, 'до нажатия у студента документа нет', `канвасов ${before}`)

await host.js(
  'const b=document.querySelector(\'[aria-label^="Открыть"]\'); if(!b) throw new Error("кнопки «Открыть» нет"); b.click(); return 1',
)

/**
 * Ждать условия, а не секунд.
 *
 * Первая версия спала фиксированно и обвиняла продукт в том, что у студента
 * нет страниц: библиотека, воркер и сам файл на холодной вкладке приезжают
 * дольше, чем на прогретой. Проверка, зависящая от того, чья вкладка успела,
 * — это не проверка.
 */
async function until(page: Tab, expr: string, what: string, ms = 20000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await page.js(`return ${expr}`)) === true) return true
    await wait(250)
  }
  console.log(`  (не дождались: ${what})`)
  return false
}

await until(host, 'document.querySelectorAll("canvas").length === 3', 'страницы у преподавателя')
await until(student, 'document.querySelectorAll("canvas").length === 3', 'страницы у студента')

check(
  (await host.js('return document.querySelectorAll("canvas").length')) === 3,
  'у преподавателя открылись все страницы',
  await host.js('return document.querySelectorAll("canvas").length'),
)
check(
  (await student.js('return document.querySelectorAll("canvas").length')) === 3,
  'документ сам появился у студента',
  await student.js('return document.querySelectorAll("canvas").length'),
)
check(
  (await student.js('return /Идём за/.test(document.body.innerText)')) === true,
  'студент идёт за преподавателем',
  await student.js("return /Идём за[^\\n]*/.exec(document.body.innerText)?.[0] ?? 'строки нет'"),
)

/* ------------------------------------------------------------------ итог */

/* ------------------------------------------------- два режима одного центра */

check(
  (await host.js('return !!document.querySelector("main.hidden")')) === true,
  'документ занял центр, а не колонку рядом',
  'тетрадь скрыта',
)

await host.js(
  'const t=[...document.querySelectorAll("button")].find(b=>/Тетрадь/.test(b.textContent||"")); if(!t) throw new Error("вкладки «Тетрадь» нет: " + [...document.querySelectorAll("button")].map(b=>JSON.stringify((b.textContent||"").trim().slice(0,20))).join(",")); t.click(); return 1',
)
await wait(600)
check(
  (await host.js('return !document.querySelector("main.hidden")')) === true,
  'вкладка возвращает в тетрадь',
  'тетрадь видна',
)
/*
 * Метку «где преподаватель» проверяем у СТУДЕНТА: сам преподаватель за собой не
 * идёт, и у него её быть не должно. Спросить об этом его же — проверить не то.
 */
await student.js(
  'const t=[...document.querySelectorAll("button")].find(b=>/Тетрадь/.test(b.textContent||"")); t&&t.click(); return 1',
)
await wait(600)
check(
  (await student.js('return /на стр\\. \\d+/.test(document.body.innerText)')) === true,
  'из тетради студент видит, где преподаватель',
  await student.js(
    'return /[^\\n]*на стр\\. \\d+/.exec(document.body.innerText)?.[0]?.trim() ?? "нет"',
  ),
)
check(
  (await host.js('return /на стр\\. \\d+/.test(document.body.innerText)')) === false,
  'преподаватель не идёт за самим собой',
  'метки нет',
)

/*
 * «Преподаватель вышел» — только тому, кто за кем-то шёл и потерял. У самого
 * преподавателя ведущего нет никогда: за собой не идут.
 */
await host.js(
  'const t=[...document.querySelectorAll("button")].find(b=>/lecture\\.pdf/.test(b.textContent||"")); t&&t.click(); return 1',
)
await wait(500)
check(
  (await host.js('return /вышел/.test(document.body.innerText)')) === false,
  'преподавателю не пишут, что он вышел',
  await host.js(
    'return /[^\\n]*вышел[^\\n]*/.exec(document.body.innerText)?.[0]?.trim() ?? "не пишут"',
  ),
)

/* Документ должно быть чем закрыть — и у комнаты, а не только у себя. */
check(
  (await host.js('return !!document.querySelector(\'[aria-label="Закрыть документ"]\')')) === true,
  'документ есть чем закрыть',
  'кнопка на вкладке',
)
await host.js('document.querySelector(\'[aria-label="Закрыть документ"]\').click(); return 1')
await until(
  host,
  'document.querySelectorAll("canvas").length === 0',
  'документ закрылся у преподавателя',
)
await until(
  student,
  'document.querySelectorAll("canvas").length === 0',
  'документ закрылся у студента',
)
check(
  (await host.js('return document.querySelectorAll("canvas").length')) === 0,
  'закрытие убирает документ у преподавателя',
  await host.js('return document.querySelectorAll("canvas").length'),
)
check(
  (await student.js('return document.querySelectorAll("canvas").length')) === 0,
  'и у всей комнаты',
  await student.js('return document.querySelectorAll("canvas").length'),
)
check(
  (await student.js(
    'return /lecture\\.pdf/.test(document.querySelector("main")?.parentElement?.textContent ?? "")',
  )) === false,
  'строка вкладок исчезла вместе с документом',
  'вкладок нет',
)

for (const [who, page] of [
  ['преподаватель', host],
  ['студент', student],
] as const) {
  for (const line of page.trouble.slice(0, 4)) console.log(`  (${who}) ${line}`)
}

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`  ${r.ok ? 'ok  ' : 'ПЛОХО'}  ${r.what.padEnd(46)} ${r.got}`)
}
console.log(failed === 0 ? '\n  интерфейс отвечает' : `\n  провалов: ${failed}`)

chrome.kill()
spawnSync('rm', ['-rf', root])
process.exit(failed === 0 ? 0 : 1)
