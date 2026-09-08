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
// Порты переопределяются окружением — чтобы отлаживать сам стенд, пока
// на штатных идёт полный прогон.
const PORT = Number(process.env.UI_CHECK_PORT ?? 3891)
const CDP_PORT = Number(process.env.UI_CHECK_CDP ?? 9334)
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const root = mkdtempSync(path.join(tmpdir(), 'colloq-ui-'))
const ROOM = 'uicheck1'

/* ------------------------------------------------------- маленький PDF */

/**
 * Настоящий PDF на три страницы, собранный руками: без зависимостей.
 * Страницы 16:9 (960×540), как слайды лекции: раскладка пульта меряется
 * долей экрана под листом, и для A4-портрета эти пороги не имеют смысла.
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
 * Картинка — настоящая, чтобы браузер правда её разобрал.
 *
 * GIF на один пиксель: сорок три байта, ни одной зависимости и ни одной
 * контрольной суммы, которую пришлось бы считать руками. Проверяется по
 * `naturalWidth`: он больше нуля только у картинки, которая доехала и
 * разобралась, — сломанный `<img>` показывает `alt` и ноль.
 */
writeFileSync(
  path.join(root, 'workspace', ROOM, 'схема.gif'),
  Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
)

/* ---------------------------------------------------------------- сервер */

process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
process.env.SESSION_SECRET = 'ui-check'
process.env.PORT = String(PORT)
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`
// Ядра у проверки нет и не должно быть: она про интерфейс.
process.env.JUPYTER_URL = 'http://127.0.0.1:1'
process.env.NODE_ENV = 'test'
process.env.KERNEL_BACKEND = 'test'
process.env.KERNEL_ISOLATION = 'off'
process.env.STATIC_DIR = path.resolve('web/dist')
/*
 * Оракул — «настроен», но никуда не ходит: ключ выдуманный, адрес заведомо
 * мёртвый. Проверка не задаёт ни одного вопроса; ключ нужен ровно затем, чтобы
 * панель нарисовала наборную строку, а не заглушку «модель не настроена», —
 * иначе половину панели никакая проверка не видит.
 */
process.env.OPENAI_API_KEY = 'ui-check-not-a-real-key'
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1'

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

const cdp = `http://127.0.0.1:${CDP_PORT}`

/*
 * Убирать за собой надо и на падении.
 *
 * Скрипт бросает из десятков мест («кнопки нет», «поля вопроса нет»), а Chrome
 * запущен обычным spawn и выход node переживает — вместе со своим профилем во
 * временном каталоге. Следующий прогон открывал вкладки в этой сироте: токен
 * участника — HMAC над постоянными SESSION_SECRET и ROOM, поэтому сохранённый
 * localStorage проходил проверку и на свежем сервере. Вкладка входила молча,
 * экрана входа не видела, и половина проверок обвиняла продукт.
 */
let browser: ReturnType<typeof spawn> | null = null
let cleaned = false
const cleanUp = () => {
  if (cleaned) return
  cleaned = true
  /* SIGKILL, а не SIGTERM: по «вежливому» сигналу Chrome прибирается сам и
     дописывает профиль уже ПОСЛЕ нашего rm — от каталога оставалась папка
     chrome/, и так их накопилось больше сотни. Профиль всё равно выбрасывается. */
  browser?.kill('SIGKILL')
  spawnSync('rm', ['-rf', root])
}
process.on('exit', cleanUp)
/* Без своего обработчика Ctrl-C не доходит до 'exit' вовсе. */
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

/*
 * И если сирота всё-таки осталась (убили прогон -9, чужой Chrome на том же
 * порту) — сказать об этом, а не подключиться. Цикл ожидания ниже достучится
 * до кого угодно, кто отвечает на этом порту, и разницы не заметит.
 */
try {
  const busy = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(600) })
  if (busy.ok) {
    console.error(
      `На порту отладки ${CDP_PORT} уже кто-то отвечает — скорее всего Chrome от прошлого прогона.\n` +
        'Закройте его или задайте другой порт: UI_CHECK_CDP=9335 npx tsx scripts/ui-check.mts',
    )
    process.exit(1)
  }
} catch {
  /* порт свободен — так и надо */
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
      trouble.push(
        'искл: ' +
          (d?.exception?.description ??
            [d?.text, d?.exception?.value, d?.exception?.className].filter(Boolean).join(' ') ??
            '?'),
      )
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
/*
 * И localStorage — иначе второй вкладкой в комнату входит ТОТ ЖЕ человек.
 *
 * Личность участника лежит в localStorage, а он общий на весь профиль браузера:
 * вкладка молча входила по сохранённому имени, экрана входа не видела, и обе
 * вкладки оказывались одним участником с двумя курсорами. Половина проверок про
 * «двое в комнате» при этом проходила — присутствие различает вкладки, а не
 * людей, — и ровно поэтому подмена не была заметна.
 */
await student.js('localStorage.clear(); return 1')
await student.send('Page.reload')
await enter(student, 'Нина')

/*
 * Кука преподавателя ставится заново.
 *
 * `Network.clearBrowserCookies` выше чистит ВЕСЬ браузер, а не одну вкладку, —
 * то есть заодно выкидывает преподавателя из панели. Заметно это не сразу:
 * сокеты, открытые до чистки, живут с прежними правами, а вот следующий
 * HTTP-запрос приходит уже без куки, и сервер честно отвечает «это может
 * преподаватель». В настоящей комнате такого не бывает — там у каждого свой
 * браузер, — так что чинится это здесь, а не в продукте.
 */
await host.send('Network.setCookie', {
  name: STAFF_COOKIE,
  value: cookieValue,
  domain: '127.0.0.1',
  path: '/',
})

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

/* Нажатие по имени файла в дереве открывает его: у преподавателя PDF уезжает
   на общий экран комнаты, у остальных — открывается себе. */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('lecture.pdf'));` +
    `if(!b) throw new Error('строки lecture.pdf в дереве нет'); b.click(); return 1`,
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
  (await host.js('return !!document.querySelector(\'[aria-label="Закрыть lecture.pdf"]\')')) ===
    true,
  'документ есть чем закрыть',
  'кнопка на вкладке',
)
await host.js('document.querySelector(\'[aria-label="Закрыть lecture.pdf"]\').click(); return 1')
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
  'вкладка документа исчезла вместе с ним',
  'вкладки нет',
)

/* ------------------------------------------------- редактор и дерево */

/**
 * Новый файл, набранный в дереве, доезжает до второго браузера — и обратно.
 *
 * Это и есть то, ради чего файлы стали документами Yjs: два человека в одном
 * скрипте. Проверка идёт через настоящий CodeMirror, а не через запись в Y.Text
 * напрямую: сломаться может ровно то место, где редактор привязывается к
 * общему тексту, и подмена его руками проверила бы всё, кроме него.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Новый файл');` +
    `if(!b) throw new Error('кнопки «новый файл» нет'); b.click(); return 1`,
)
await wait(400)
await host.js(
  `const i=document.querySelector('input.font-mono');` +
    `if(!i) throw new Error('поля для имени нет; в панели: ' + (document.querySelector('section[aria-label]')?.innerText||'').slice(0,200));` +
    `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;` +
    `set.call(i,'train.py'); i.dispatchEvent(new Event('input',{bubbles:true}));` +
    `i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1`,
)
/*
 * Ищем по `title`, а не по тексту строки. Имя в дереве разложено на две части —
 * основу и расширение, — чтобы расширение не съедалось многоточием, и между
 * ними в разметке стоит перенос строки. И `textContent`, и `innerText` отдают
 * его как пробел, так что `train.py` там выглядит как `train .py` и на
 * подстроку не ловится. `title` — это полный путь, тот самый, по которому файл
 * и открывают.
 */
const inTree = `[...document.querySelectorAll('button')].some(b=>(b.title||'').startsWith('train.py'))`
await until(host, inTree, 'файл появился в дереве')
check((await host.js(`return ${inTree}`)) === true, 'новый файл появился в дереве', 'train.py')
await until(student, inTree, 'файл доехал до студента')
check(
  (await student.js(`return ${inTree}`)) === true,
  'и у всей комнаты, а не только у автора',
  'train.py',
)

await until(host, `!!document.querySelector('.cm-file .cm-content')`, 'редактор открылся')
check(
  (await host.js(`return !!document.querySelector('.cm-file .cm-content')`)) === true,
  'новый файл сразу открылся в редакторе',
  'CodeMirror на месте',
)
check(
  (await host.js(
    `return [...document.querySelectorAll('button')].some(b=>/запустить/i.test(b.textContent||''))`,
  )) === true,
  'у скрипта есть чем его запустить',
  'кнопка «Запустить»',
)

/*
 * Печатаем в редакторе преподавателя — как человек, а не в обход.
 *
 * `Input.insertText` доставляет текст в фокус тем же путём, что и клавиатура,
 * так что проверяются и обработчики CodeMirror, и привязка к общему тексту.
 * Дотянуться до `EditorView` из страницы нечем: наружу он не выставлен, и это
 * правильно — тест, который лезет во внутренности, проверяет их, а не продукт.
 */
await host.js(`document.querySelector('.cm-file .cm-content').focus(); return 1`)
await host.send('Input.insertText', { text: "print('привет из общего файла')" })
await wait(600)
// Ждём строку, а не надеемся на неё: список файлов приезжает сообщением, и
// нажать по нему на кадр раньше — это гонка, а не проверка.
await until(
  student,
  `[...document.querySelectorAll('button')].some(x=>(x.title||'').includes('train.py'))`,
  'строка train.py доехала до студента',
)
await student.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('train.py'));` +
    `if(!b) throw new Error('строки train.py у студента нет'); b.click(); return 1`,
)
await until(
  student,
  `(document.querySelector('.cm-file .cm-content')?.textContent||'').includes('привет из общего файла')`,
  'текст доехал до студента',
)
check(
  (await student.js(
    `return (document.querySelector('.cm-file .cm-content')?.textContent||'').includes('привет из общего файла')`,
  )) === true,
  'набранное в файле видно второму человеку',
  await student.js(
    `return (document.querySelector('.cm-file .cm-content')?.textContent||'').slice(0,40)`,
  ),
)

/* Панель файлов говорит, кто ещё в этом файле. */
const seesNina = `(document.body.textContent||'').includes('Нина')`
await until(host, seesNina, 'преподаватель видит студента в файле')
check(
  (await host.js(`return ${seesNina}`)) === true,
  'видно, кто ещё правит этот файл',
  'Нина здесь',
)

/* Вкладка закрывается у себя и не трогает никого больше. */
await student.js(`document.querySelector('[aria-label="Закрыть train.py"]').click(); return 1`)
await wait(500)
check(
  (await student.js(`return !document.querySelector('.cm-file .cm-content')`)) === true,
  'вкладка файла закрывается',
  'редактора нет',
)
check(
  (await host.js(`return !!document.querySelector('.cm-file .cm-content')`)) === true,
  'закрытая у себя вкладка не закрылась у соседа',
  'у преподавателя открыт',
)

/* ---------------------------------------------- тетрадь — это файл */

/**
 * Тетрадь комнаты лежит в её папке файлом и открывается вкладкой, как всё
 * остальное. Это и есть то, ради чего она перестала быть особой: файл видно в
 * дереве, его можно скачать, прочитать из ячейки и открыть рядом со второй.
 */
check(
  (await host.js(
    `return [...document.querySelectorAll('button')].some(b=>(b.title||'').startsWith('Тетрадь.ipynb'))`,
  )) === true,
  'тетрадь комнаты лежит в дереве файлом',
  'Тетрадь.ipynb',
)

/* Вторая тетрадь заводится и открывается рядом с первой. */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Новая тетрадь');` +
    `if(!b) throw new Error('кнопки «новая тетрадь» нет'); b.click(); return 1`,
)
await wait(400)
await host.js(
  `const i=document.querySelector('input.font-mono');` +
    `if(!i) throw new Error('поля для имени нет');` +
    `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;` +
    `set.call(i,'разбор.ipynb'); i.dispatchEvent(new Event('input',{bubbles:true}));` +
    `i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1`,
)
const twoBooks = `[...document.querySelectorAll('main')].length >= 2`
await until(host, twoBooks, 'вторая тетрадь открылась')
check(
  (await host.js(`return ${twoBooks}`)) === true,
  'вторая тетрадь открывается рядом с первой',
  await host.js(`return document.querySelectorAll('main').length + ' тетрадей'`),
)
check(
  (await host.js(`return document.querySelectorAll('main:not(.hidden)').length`)) === 1,
  'показана ровно одна из них',
  'одна',
)
/* И у неё свой тулбар: «Run all» относится к той тетради, в которой нажали. */
check(
  (await host.js(
    `return (document.querySelector('main:not(.hidden)')?.textContent||'').includes('Run all')`,
  )) === true,
  'у второй тетради свой тулбар',
  'Run all на месте',
)

/*
 * Под открытой тетрадью не должно быть ничего лишнего.
 *
 * Ветка «этот файл — не текст» добиралась до тетради последней и была формально
 * права: .ipynb действительно не открывают редактором. Печаталась она ПОД
 * тетрадью, то есть под работающим листом с ячейками.
 */
check(
  (await host.js(
    `return (document.querySelector('main:not(.hidden)')?.parentElement?.textContent||'').includes('не текст')`,
  )) === false,
  'под тетрадью не пишут, что она не текст',
  'чисто',
)

/* ------------------------------------------- выделение нескольких ячеек */

/**
 * Выделение — то, чем человек говорит оракулу «смотри сюда».
 *
 * Всё, что здесь проверяется, до сих пор было невозможно: выделить вторую
 * ячейку, снять выделение вообще. Считаем по aria-label, а не по цвету: цвет
 * читается глазами, метка — и глазами, и экранным диктором.
 */
const selectedCount = `document.querySelectorAll('[aria-label$="selected"]').length`

/**
 * Нажатие в ячейку — это нажатие в её ТЕЛО, и стенд обязан целиться туда же.
 *
 * Выделение слушает `[data-cell-body]` — колонку кода, вывода и тулбара над
 * ними, — а поле с номером и просветы вокруг нарочно нейтральны: щелчок в
 * пустоту слева ячейку не выбирает (см. комментарий у этого блока в
 * CellView.svelte). События всплывают вверх, а не вниз, поэтому
 * `pointerdown`, посланный в корень `[data-cell-id]`, до обработчика не
 * доходил вовсе: стенд не выделял ничего и обвинял в этом продукт.
 */
const pressCell = (n: number, extra = ''): string =>
  `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
  `if(cells.length < ${n + 1}) throw new Error('в тетради меньше ${n + 1} ячеек');` +
  `const body=cells[${n}].querySelector('[data-cell-body]');` +
  `if(!body) throw new Error('у ячейки ${n + 1} нет тела — нажимать нечего');` +
  `body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true${extra}})); return 1`

await host.js(pressCell(0))
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 1,
  'нажатие выделяет одну ячейку',
  await host.js(`return ${selectedCount}`),
)

/* Cmd (Ctrl) добавляет вторую, не снимая первую. */
await host.js(pressCell(1, ',metaKey:true'))
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 2,
  'Cmd добавляет вторую ячейку к выделению',
  await host.js(`return ${selectedCount}`),
)

/* Тем же Cmd она снимается обратно. */
await host.js(pressCell(1, ',metaKey:true'))
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 1,
  'тем же нажатием снимается обратно',
  await host.js(`return ${selectedCount}`),
)

/*
 * Нажатие мимо ячейки снимает выделение. До сих пор выйти из состояния
 * «выбрано» было нельзя ничем, кроме перезагрузки страницы.
 */
await host.js(`const main=document.querySelector('main:not(.hidden)');` + `main.click(); return 1`)
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 0,
  'нажатие мимо ячейки снимает выделение',
  await host.js(`return ${selectedCount}`),
)

/*
 * Панель называет зону видимости — и добавляет к ней выделенное.
 *
 * «Видит» стоит всегда: она про то, что уедет в любом случае. «Особенно»
 * появляется только когда есть на чём сосредоточиться — строка, которая горит
 * всегда, ничего не говорит.
 */
check(
  (await host.js(`return (document.body.textContent||'').includes('всю комнату')`)) === true,
  'панель говорит, что оракул видит комнату целиком',
  await host.js(
    `return /всю комнату[^А-Я]*/.exec(document.body.textContent||'')?.[0]?.trim() ?? 'молчит'`,
  ),
)
check(
  (await host.js(`return (document.body.textContent||'').includes('Особенно')`)) === false,
  'без выделения «особенно» не показывают',
  'нет строки',
)
await host.js(pressCell(1))
await wait(400)
check(
  (await host.js(`return (document.body.textContent||'').includes('Особенно')`)) === true,
  'выделенная ячейка добавляется к зоне видимости',
  await host.js(
    `return /Особенно[^А-Я]*/.exec(document.body.textContent||'')?.[0]?.trim() ?? 'молчит'`,
  ),
)

/* ------------------------------------------------ управление читалкой */

/**
 * Открытым документом можно управлять: приблизить и найти страницу.
 *
 * Раньше читалка была одной прокруткой без единой кнопки: увеличить лекцию,
 * набранную десятым кеглем, было нечем, а попасть на двадцатую страницу — только
 * пролистав девятнадцать.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith('lecture.pdf'));` +
    `if(!b) throw new Error('lecture.pdf нет в дереве'); b.click(); return 1`,
)
await until(host, `document.querySelectorAll('canvas').length >= 3`, 'документ открылся заново')

const zoomShown = `[...document.querySelectorAll('button')].find(b=>/^\\d+%$/.test((b.textContent||'').trim()))?.textContent.trim()`
check(
  (await host.js(`return ${zoomShown}`)) === '100%',
  'читалка открывается по ширине',
  await host.js(`return ${zoomShown} ?? 'кнопки масштаба нет'`),
)

const pageWidth = `Math.round(document.querySelector('[data-page="1"]').getBoundingClientRect().width)`
const wasWide = (await host.js(`return ${pageWidth}`)) as number
await host.js(
  `[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Крупнее').click(); return 1`,
)
await wait(600)
check(
  ((await host.js(`return ${pageWidth}`)) as number) > wasWide,
  'страница правда становится крупнее',
  `${wasWide} → ${await host.js(`return ${pageWidth}`)}`,
)
check(
  (await host.js(`return ${zoomShown}`)) === '125%',
  'и доля называет, насколько',
  await host.js(`return ${zoomShown}`),
)

/* Нажатие на долю возвращает «по ширине» — единственный масштаб без выбора. */
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.title||'')==='По ширине').click(); return 1`,
)
await wait(600)
check(
  ((await host.js(`return ${pageWidth}`)) as number) === wasWide,
  'доля возвращает страницу по ширине',
  await host.js(`return ${zoomShown}`),
)

/*
 * Полоса страниц закрыта по умолчанию, открывается кнопкой и НЕ отнимает
 * ширину у страницы: она накладка, а колонка заставила бы перерисовать
 * документ на каждое открытие.
 */
check(
  (await host.js(`return !!document.querySelector('[data-rail]')`)) === false,
  'полоса страниц закрыта по умолчанию',
  'её нет',
)
await host.js(
  `[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Полоса страниц').click(); return 1`,
)
await until(host, `!!document.querySelector('[data-rail]')`, 'полоса открылась')
check(
  ((await host.js(`return ${pageWidth}`)) as number) < wasWide,
  'полоса берёт себе колонку, а не ложится поверх страницы',
  `${wasWide} → ${await host.js(`return ${pageWidth}`)}`,
)
await until(
  host,
  `[...document.querySelectorAll('[data-rail] canvas')].some(c=>c.width>0)`,
  'миниатюры нарисовались',
)
check(
  ((await host.js(
    `return [...document.querySelectorAll('[data-rail] canvas')].filter(c=>c.width>0).length`,
  )) as number) > 0,
  'миниатюры страниц рисуются',
  await host.js(
    `return document.querySelectorAll('[data-rail] canvas').length + ' страниц в полосе'`,
  ),
)

/* Выбрали страницу — полоса закрылась сама. */
/*
 * Выбор страницы уводит прокрутку к ней.
 *
 * Меряется в том же вызове, что и нажатие: место в документе — это `scrollTop`,
 * и сравнивать его надо с положением самой страницы, а не со счётчиком в строке
 * вкладок. Счётчик обновляется от события прокрутки, то есть кадром позже, и
 * зависеть от того, успел ли headless-браузер выпустить этот кадр, — значит
 * проверять браузер.
 */
/*
 * Прыгаем на ВТОРУЮ страницу, а не на последнюю: страницы здесь 16:9, как
 * слайды, и последняя короче окна — до верха её не докрутить ничем, и
 * проверка ругала бы читалку за то, что документ кончился.
 */
const landed = (await host.js(
  `const sc=document.querySelector('[role=document]');` +
    `document.querySelector('[data-thumb="2"]').click();` +
    `const sheet=sc.querySelector('[data-page="2"]');` +
    `const at=sheet.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;` +
    // Начало страницы обязано остаться ВИДНО: прокрутка не должна уехать за
    // верх листа. Промах в тридцать четыре пикселя — высоту полосы управления —
    // выглядел как «прыгает низковато»: сверху был конец предыдущей страницы.
    `return JSON.stringify({over: Math.round(sc.scrollTop - at), page: sc.scrollTop})`,
)) as string
const over = JSON.parse(landed).over as number
check(
  over <= 0 && over > -200,
  'прыжок показывает начало страницы, а не её середину',
  `верх листа на ${-over}px ниже кромки`,
)
await wait(700)
check(
  (await host.js(`return !!document.querySelector('[data-rail]')`)) === true,
  'выбор страницы не закрывает полосу',
  'осталась открыта',
)
/*
 * Лекция: пульт у ведущего, страница и чернила — у всех.
 *
 * Проверяется здесь то, что нельзя увидеть на одной вкладке: страница, которую
 * листает планшет, и линия, которую рисует Pencil, обязаны появиться у
 * СТУДЕНТА. Всё это едет по управляющему сокету и живёт в памяти сервера, то
 * есть ломается молча — у ведущего на экране остаётся ровно то же самое.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Лекция');` +
    `if(!b) throw new Error('кнопки «Лекция» в читалке нет'); b.click(); return 1`,
)
const presenterBar = `[...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`
await until(host, presenterBar, 'пульт лекции появился')
check(
  (await host.js(`return ${presenterBar}`)) === true,
  'у ведущего появляется пульт лекции',
  'да',
)

const audience = `(document.body.textContent||'').includes('Лекцию ведёт Ада')`
await until(student, audience, 'студент увидел лекцию')
check(
  (await student.js(`return ${audience}`)) === true,
  'студент видит лекцию, не открывая её сам',
  await student.js(
    `return (document.querySelector('canvas.ink')? 'со слоем чернил' : 'без слоя чернил')`,
  ),
)
check(
  (await student.js(
    `return [...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`,
  )) === false,
  'пульта у студента нет',
  'нет',
)

/* Страницу листает ведущий — приезжает она ко всем. */
await host.js(
  `[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Следующая страница').click(); return 1`,
)
const onSecond = `[...document.querySelectorAll('span')].some(s=>/^2 \\/ 3$/.test((s.textContent||'').trim()))`
await until(student, onSecond, 'страница доехала до студента')
check(
  (await student.js(`return ${onSecond}`)) === true,
  'страница ведущего листается у всей комнаты',
  await student.js(
    `return [...document.querySelectorAll('span')].map(s=>(s.textContent||'').trim()).find(t=>/^\\d+ \\/ \\d+$/.test(t)) ?? 'счётчика нет'`,
  ),
)

/*
 * Лист занимает место, а не схлопывается в ноль.
 *
 * Размер листа считался ТОЛЬКО по наблюдателю за размером, а он молчит, пока
 * браузер не рисует вкладку: проекция, открытая вторым окном и не получившая
 * фокуса, оставалась пустой — белый прямоугольник в ноль пикселей, в который
 * pdf.js не рисует, потому что рисовать некуда. На экране это «лекция не
 * открылась», и виноватым выглядел бы документ.
 */
const sheetWidth = `Math.round(document.querySelector('canvas.ink-dry').getBoundingClientRect().width)`
// Ждём, а не спим: лист получает размер, когда приедет сам документ, а он
// приезжает по сети — на холодной вкладке дольше, чем на прогретой.
await until(host, `${sheetWidth} > 200`, 'лист лекции получил размер')
check(
  ((await host.js(`return ${sheetWidth}`)) as number) > 200,
  'страница лекции занимает своё место',
  `${await host.js(`return ${sheetWidth}`)}px`,
)

/*
 * Чернила. Перо берётся нажатием на цвет — двух переключателей ради четырёх
 * цветов нет, — а дальше это обычные PointerEvent'ы: у Pencil тот же путь.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'')==='Перо, красный');` +
    `if(!b) throw new Error('пера в пульте нет'); b.click(); return 1`,
)
await wait(200)
const strokeOn = (page: Tab) =>
  page.js(
    `const c=document.querySelector('canvas.ink-dry');` +
      `if(!c||!c.width) return -1;` +
      `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
      `let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>16) n+=1; return n`,
  )
check(((await strokeOn(student)) as number) <= 0, 'до штриха страница чистая', 'пусто')

/*
 * Синтетическое перо целится в СЛОЙ ВВОДА, а не в холст.
 *
 * Касания у слоя чернил принимает один элемент — `div.ink-input` поверх трёх
 * холстов (§1 договора): холсты — соседи, а не родители, и событие, посланное
 * холсту, до обработчиков не доходит. Координаты при этом считаются от холста:
 * слой ввода шире него на поля листа.
 */
const inkTarget =
  `const c=document.querySelector('canvas.ink-wet');const input=document.querySelector('.ink-input')||c;` +
  `if(!c) throw new Error('слоя чернил нет');const r=c.getBoundingClientRect();`
await host.js(
  inkTarget +
    `const at=(t,fx,fy)=>input.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerId:1,pointerType:'pen',` +
    `buttons:t==='pointerup'?0:1,pressure:0.5,clientX:r.left+r.width*fx,clientY:r.top+r.height*fy}));` +
    `at('pointerdown',0.2,0.3); at('pointermove',0.4,0.45); at('pointermove',0.6,0.35);` +
    `at('pointermove',0.8,0.5); at('pointerup',0.8,0.5); return 1`,
)
await until(student, `(async()=>{const c=document.querySelector('canvas.ink-dry');if(!c||!c.width)return false;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=3;i<d.length;i+=4) if(d[i]>16) return true; return false})()`, 'штрих доехал до студента')
const inked = (await strokeOn(student)) as number
check(inked > 0, 'штрих ведущего появляется у студента', `${inked} закрашенных точек`)

/*
 * Указка: нажали и ДЕРЖИТЕ.
 *
 * Ею чаще всего стоят на месте — «вот здесь», — то есть новых точек не
 * приходит вовсе. Хвост при этом обязан догореть, а сама точка остаться:
 * однажды она гасла вместе с хвостом через четыре десятых секунды, и на
 * экране это выглядело как «нажал, мигнуло, ничего».
 *
 * Вкладка ведущего — вперёд: `laser:off` уходит по таймеру догорания (300 мс),
 * а таймеры вкладки, пролежавшей в фоне дольше пяти минут, headless Chrome
 * замедляет до раза в минуту. Проверка тогда ждала не продукт, а браузер.
 */
await host.send('Page.bringToFront')
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>/указк/i.test((x.textContent||'')+(x.getAttribute('aria-label')||'')));` +
    `if(!b) throw new Error('указки в пульте лекции нет'); b.click(); return 1`,
)
await wait(200)
await host.js(
  inkTarget +
    `const at=(t,fx,fy)=>input.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerId:2,pointerType:'pen',` +
    `buttons:t==='pointerup'?0:1,clientX:r.left+r.width*fx,clientY:r.top+r.height*fy}));` +
    `at('pointerdown',0.5,0.5); at('pointermove',0.55,0.52); return 1`,
)
/*
 * Красное ищется на ЖИВОМ холсте: по §3 договора указка, кольцо ластика и
 * предсказанный кончик живут на `ink-live`, а мокрый — только чернила. Мокрый
 * всё же суммируется — у зала слой может рисовать эхо указки по-своему.
 */
const redExpr =
  `(()=>{let n=0;for(const cls of ['ink-live','ink-wet']){const c=document.querySelector('canvas.'+cls);` +
  `if(!c||!c.width) continue;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=0;i<d.length;i+=4) if(d[i+3]>24 && d[i]>150 && d[i+1]<120) n+=1}return n})()`
const redOn = (page: Tab) => page.js(`return ${redExpr}`)
/*
 * Меряем у СТУДЕНТА — значит, вперёд выводим студента: живой слой рисуется
 * по requestAnimationFrame, а фоновой вкладке кадров не дают вовсе. Пиксели на
 * холсте, который никто не рисует, — это не «указка не доехала».
 */
await student.send('Page.bringToFront')
await until(student, `${redExpr} > 0`, 'указка доехала до студента')
// Ждём дольше, чем живёт хвост: голова обязана остаться.
await wait(1400)
const stillLit = (await redOn(student)) as number
check(stillLit > 0, 'указка не гаснет, пока её держат', `${stillLit} красных точек через 1.4 с`)

/* Отпустили — гаснет у всех. Ведущий вперёд: таймер догорания — его. */
await host.send('Page.bringToFront')
await host.js(
  inkTarget +
    `input.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:2,pointerType:'pen',buttons:0,` +
    `clientX:r.left+r.width*0.55,clientY:r.top+r.height*0.52})); return 1`,
)
await wait(500)
await student.send('Page.bringToFront')
await until(student, `${redExpr} === 0`, 'указка погасла у студента')
check(((await redOn(student)) as number) <= 0, 'отпущенная указка гаснет у всех', 'погасла')
/* Возвращаем перо: дальше проверки рисуют им. */
await host.send('Page.bringToFront')
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'')==='Перо, красный');b&&b.click(); return 1`,
)

/**
 * Двухтактную кнопку полосы нажимают дважды — и это не описка проверки.
 *
 * «Стереть» и «Закончить» необратимы: истории у чернил нет, а конец лекции
 * стирает их сразу на всех страницах. Обе поэтому спрашивают вторым нажатием
 * (LectureView · askWipe/askStop): первое меняет подпись, второе делает.
 * Проверка, нажимавшая один раз, кнопку только вооружала и ждала стёртых
 * чернил до самого таймаута — молча, потому что ждать ей было нечего.
 *
 * Ищем по обеим подписям: между нажатиями полоса успевает перерисоваться, и
 * второй раз кнопка называется уже вопросом.
 */
const pressTwice = async (page: Tab, labels: [string, string]): Promise<void> => {
  const find =
    `[...document.querySelectorAll('button')]` +
    `.find(b=>${JSON.stringify(labels)}.includes((b.textContent||'').trim()))`
  await page.js(
    `const b=${find}; if(!b) throw new Error('кнопки «${labels[0]}» в полосе нет'); b.click(); return 1`,
  )
  await page.js(
    `const b=${find}; if(!b) throw new Error('«${labels[0]}» не переспросила'); b.click(); return 1`,
  )
}

/* Стёрли — и стёрлось у всех, а не только у того, кто рисовал. */
await pressTwice(host, ['Стереть', 'Стереть всё?'])
await until(student, `(async()=>{const c=document.querySelector('canvas.ink-dry');if(!c)return true;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=3;i<d.length;i+=4) if(d[i]>16) return false; return true})()`, 'чернила стёрлись у студента')
check(((await strokeOn(student)) as number) <= 0, 'стирание доезжает до всей комнаты', 'чисто')

/* ------------------------------------------------------- имена органов пульта */

/*
 * Пульт ищется по ARIA-именам, и это не педантичность, а единственный
 * оставшийся способ его найти.
 *
 * Раньше проверка искала клавиши по словам на них — «Лист», «Указка»,
 * «Закончить». Слов на пульте больше нет: подписей осталось четыре на весь
 * прибор, пигмент показывают чипом бумаги с настоящим штрихом, «Назад» — это
 * один шеврон, а «Закончить» уехало последней строкой в лист «Ещё». Проверка
 * по тексту после этого искала бы то, чего на экране нет вовсе, и молчала бы
 * ровно про тот пульт, который держат в руках.
 *
 * Имена ниже — §7 договора, буква в букву. Они же — всё, чем эти клавиши
 * названы для голосового доступа, так что переименование ломает не проверку, а
 * пульт, и ломает молча. Поэтому список один и лежит здесь, а не рассыпан по
 * селекторам.
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

/** Выражение «такой орган на экране есть». */
const named = (aria: string) => `!!document.querySelector('[aria-label=${JSON.stringify(aria)}]')`
/** Нажать орган по имени — с внятной жалобой, если его нет. */
const press = (aria: string) =>
  `const b=document.querySelector('[aria-label=${JSON.stringify(aria)}]');` +
  `if(!b) throw new Error('на пульте нет органа «${aria}»'); b.click(); return 1`
/** Состояние защёлки клавиши: 'true' / 'false' / 'нет'. */
const pressedIs = (aria: string) =>
  `(document.querySelector('[aria-label=${JSON.stringify(aria)}]')?.getAttribute('aria-pressed') ?? 'нет')`

/*
 * Пульт на планшет.
 *
 * Лекцию ведут с айпада, а войти на нём заново нечем: ни пароля, ни аккаунта в
 * этом продукте нет. Ссылка обязана впустить ТЕМ ЖЕ человеком — иначе в
 * комнате появится второй «Ада», а вести лекцию будет некому. Проверяется
 * именно это: открытая в чистой вкладке ссылка не спрашивает имени и даёт
 * пульт, а не место в зале.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith('Ссылка, по которой'));` +
    `if(!b) throw new Error('кнопки «Пульт» нет'); b.click(); return 1`,
)
await until(host, `!!document.querySelector('[aria-label="Пульт на планшет"]')`, 'ссылка на пульт готова')
const consoleLink = (await host.js(
  `return document.querySelector('[aria-label="Пульт на планшет"] .select-all')?.textContent?.trim() ?? ''`,
)) as string
check(
  consoleLink.includes(`/s/${ROOM}/t/`),
  'ссылка на пульт выдаётся ведущему',
  consoleLink ? consoleLink.slice(0, 34) + '…'
    : await host.js(
        `return (document.querySelector('[aria-label="Пульт на планшет"]')?.textContent||'').trim().slice(0,120)`,
      ),
)

const pad = await tab(consoleLink)
/*
 * Признак пульта — прибор, а не «Закончить».
 *
 * «Закончить» с постоянно видимой поверхности убрано (§8.2 чертежа): красное
 * рядом с пальцем весь час ради нажатия, которое случается один раз. Прибор же
 * есть у пульта всегда — это единственное место в продукте, где живёт номер
 * страницы.
 */
const padHasPult = named(PULT.gauge)
await until(pad, padHasPult, 'планшет вошёл и получил пульт')
check(
  (await pad.js(`return !document.querySelector('input#join-name')`)) === true,
  'планшет не спрашивает имени',
  'вошёл сразу',
)
check(
  (await pad.js(`return location.pathname`)) === `/s/${ROOM}/pult`,
  'ключ убран из адреса, а планшет открыт пультом',
  await pad.js('return location.pathname'),
)
check(
  (await pad.js(`return ${padHasPult}`)) === true,
  'планшет получает пульт, а не место в зале',
  'прибор на месте',
)
/*
 * И вторым человеком в комнате он не становится: список людей считает людей, а
 * не вкладки. Второй «Ада» в списке — это лекция, которую ведёт непонятно кто.
 */
/*
 * Планшет — не второй человек в комнате: он входит тем же участником. Список
 * людей считает ЛЮДЕЙ, а не вкладки, и второй «Ада» в нём означал бы лекцию,
 * которую ведёт непонятно кто.
 */
const inRoom = `(document.body.textContent||'').match(/(\\d+) in the room/)?.[1] ?? '?'`
await until(host, `${inRoom} === '2'`, 'счёт людей в комнате устоялся', 8000)
check(
  (await host.js(`return ${inRoom}`)) === '2',
  'планшет не стал вторым человеком в комнате',
  (await host.js(`return ${inRoom} + ' · ' + [...document.querySelectorAll('[title]')].map(n=>n.getAttribute('title')).filter(t=>/Ада|Нина/.test(t||'')).join(' | ')`)) as string,
)
for (const line of pad.trouble.slice(0, 3)) console.log(`  (планшет) ${line}`)

/*
 * Проекция — отдельный адрес, а не кнопка: её открывают на машине у проектора,
 * и она обязана пережить перезагрузку. Ни вкладок, ни панелей на ней быть не
 * должно — это единственный экран, который смотрят двадцать человек сразу.
 */
const beam = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}/screen`)
await until(beam, `document.querySelectorAll('canvas').length > 0`, 'проекция открылась')
check(
  (await beam.js(`return document.querySelectorAll('[role="tablist"], input#join-name').length === 0`)) === true,
  'на проекции нет ни вкладок, ни экрана входа',
  'чистый экран',
)
check(
  (await beam.js(
    `return getComputedStyle(document.querySelector('.fixed.inset-0')).backgroundColor`,
  )) === 'rgb(0, 0, 0)',
  'проекция чёрная, как экран в аудитории',
  await beam.js(`return getComputedStyle(document.querySelector('.fixed.inset-0')).backgroundColor`),
)

/*
 * Снимки лекции — по просьбе `--shot`, как и снимок комнаты ниже.
 *
 * Пульт и проекция проверяются глазами и ничем больше: полоса пульта несёт
 * десяток кнопок, и влезают ли они в ширину планшета — вопрос, на который
 * никакая проверка условием не отвечает.
 */
if (process.argv.includes('--shot')) {
  for (const [who, page] of [
    ['ui-lecture.png', host],
    ['ui-projection.png', beam],
  ] as const) {
    await page.send('Page.bringToFront')
    // Ждём нарисованную страницу, а не секунду: фоновая вкладка не рисует
    // вовсе, и снимок «через секунду после переключения» ловил чёрный экран.
    await until(page, `[...document.querySelectorAll('canvas')].some(c=>c.width>1)`, `лист для ${who}`)
    await wait(400)
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    const where = path.resolve(who)
    writeFileSync(where, Buffer.from(shot.result.data as string, 'base64'))
    console.log(`  снимок: ${where}`)
  }
  await host.send('Page.bringToFront')
  await wait(400)
}

/*
 * Пульт — отдельное приложение, и меряется оно планшетом.
 *
 * Окно проверки 1600×1000, то есть ноутбук; пульт же держат в руках, и всё в
 * нём рассчитано на 1180×820 с двойным пикселем. Вкладке выдаётся ровно эта
 * геометрия — иначе проверяется раскладка, которой на планшете не бывает.
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
  'пульт нарисовал страницу',
)
check(pultReady, 'пульт показывает лист лекции', await pult.js(`return location.pathname`))
/*
 * Лекция уже идёт, а пульт открыт по ключу — над листом ложе «Коснитесь,
 * чтобы взять пульт»: полный экран просится только из живого жеста. Клавиши
 * под ним в DOM есть, и `press` их нажал бы и так, но снимок показал бы
 * плиту, а не пульт. Снимается оно так же, как пальцем.
 */
async function takeConsole(): Promise<void> {
  if (!(await pult.js(`return !!document.querySelector('[aria-label="Коснуться и начать"]')`))) return
  await pult.js(`document.querySelector('[aria-label="Коснуться и начать"]').click(); return 1`)
  await until(pult, `!document.querySelector('[aria-label="Коснуться и начать"]')`, 'ложе первого касания ушло', 4000)
  await wait(300)
}
await takeConsole()
check(
  (await pult.js(`return ${named(PULT.laser)}`)) === true,
  'у пульта есть свои инструменты',
  await pult.js(`return document.querySelectorAll('button').length + ' кнопок'`),
)

/*
 * Весь §7 разом, а не одно имя.
 *
 * Проверка по одной клавише ловит переименование ровно этой клавиши; ломается
 * же обычно всё семейство сразу — «перо, красный» вместо «Перо, красное»,
 * «Стереть» вместо «Ластик». Пары — это один орган в двух состояниях, и
 * присутствовать обязано ровно одно из двух.
 */
/*
 * Цвета и толщины живут во всплывающей палитре, а «Заметки крупнее» — в
 * шапке выдвижного листа заметок; на рейле их нет. Палитру открывает тап по
 * АКТИВНОМУ «Перу» (по неактивному — выбор пера), лист заметок — клавиша
 * «Заметки». Оба открываются здесь ровно на время переклички и закрываются.
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
if (!paletteOpen) absent.push('палитра [data-pult-palette]')
else for (const n of inPalette) if (!(await pult.js(`return ${has(n)}`))) absent.push(n)
check(
  paletteOpen &&
    (await pult.js(
      `const p=document.querySelector('[data-pult-palette]');` +
        `return !!p.querySelector('[role="radiogroup"][aria-label="Цвет пера"]') && !!p.querySelector('[role="radiogroup"][aria-label="Толщина"]')`,
    )) === true,
  'палитра пера — два ряда: цвет и толщина',
  paletteOpen ? 'radiogroup «Цвет пера» и «Толщина»' : 'палитра не открылась',
)
/*
 * ВЫБОР НЕ ЗАКРЫВАЕТ ПАЛИТРУ. Закрывал — и чтобы попробовать синий потолще,
 * приходилось открывать её дважды; а пробуют именно так, подбором, глядя на
 * лист. Проверяется обе половины: и цвет, и толщина.
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
    'выбор цвета и толщины не закрывает палитру',
    `после цвета ${afterColor ? 'открыта' : 'ЗАКРЫЛАСЬ'}, после толщины ${afterWidth ? 'открыта' : 'ЗАКРЫЛАСЬ'}`,
  )
  // Возвращаем чёрное среднее — дальше по прогону от них зависят снимки.
  await pult.js(press(PULT.black))
  await wait(150)
  await pult.js(press(PULT.mid))
  await wait(150)
}
await escape()
check(
  (await pult.js(`return !document.querySelector('[data-pult-palette]')`)) === true,
  'палитра закрывается Escape',
  'закрыта',
)

/*
 * У УКАЗКИ СВОЯ ПАЛИТРА: точкой показывают, линией обводят. Открывается тем же
 * жестом, что и перьевая, — повторным тапом по уже взятому инструменту.
 */
await pult.js(press(PULT.laser))
await wait(250)
await pult.js(press(PULT.laser))
await wait(350)
const laserPalette = (await pult.js(`return !!document.querySelector('[data-pult-palette]')`)) === true
check(
  laserPalette &&
    (await pult.js(`return ${has('Линия')} && ${has('Точка')}`)) === true,
  'у указки есть выбор: линия или точка',
  laserPalette
    ? await pult.js(
        `return (document.querySelector('[data-pult-palette]')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)`,
      )
    : 'палитра указки не открылась',
)
await escape()
await pult.js(press(PULT.pen))
await wait(200)
await pult.js(press(PULT.notes))
await wait(500)
// Поля ввода в заметках на пульте нет вовсе — они прибиты (см. §9 ниже).
const notesOpen = (await pult.js(`return !!document.querySelector('[data-pult-notes] .pult-prompt')`)) === true
if (!notesOpen) absent.push('лист заметок [data-pult-notes]')
else for (const n of inNotes) if (!(await pult.js(`return ${has(n)}`))) absent.push(n)
check(absent.length === 0, 'органы пульта названы по договору', absent.length ? absent.join(', ') : 'все имена на месте')

/*
 * ВЕРХНЕЙ НИТИ НЕТ ВОВСЕ.
 *
 * Нить 52 px во всю ширину была вторым по яркости предметом ночного пульта
 * после самого листа и ставила стенные часы — их смотрят раз в десять минут —
 * выше номера страницы, который смотрят каждую фразу. Её груз разложен: часы и
 * номер в прибор, имя документа на экран выбора, остальное в лист «Ещё».
 *
 * Ищем не класс (класс переименуют и проверка позеленеет), а форму: полосу во
 * всю ширину, прижатую к верхней кромке, ростом с полосу chrome. Поле листа
 * под фильтр не попадает — оно вдвое выше и держит холст.
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
check(band === '', 'верхней нити на пульте нет', band || 'полос chrome нет')

/*
 * «Закончить» не висит рядом с пальцем.
 *
 * Красное в тёмном зале — самое громкое, что бывает, а нажимают его один раз
 * за лекцию и в момент, когда никто никуда не спешит. Место такому — последней
 * строкой листа «Ещё», и проверяется это с двух сторон: здесь слова нет, ниже —
 * оно есть в поднятом листе.
 *
 * ПОРЯДОК ЗДЕСЬ — ЧАСТЬ ПРОВЕРКИ: строка обязана стоять ДО того, как «Ещё»
 * открыт. Переставленная вниз, она требует от пульта того, чего договор от
 * него не требует, — и два правила начинают спорить друг с другом на ровном
 * месте. Лист поднимается ниже по файлу и закрывается сразу после.
 */
check(
  (await pult.js(`return !/закончить/i.test(document.body.innerText||'')`)) === true,
  'красного «Закончить» на виду нет',
  await pult.js(
    `return /[^\\n]*закончить[^\\n]*/i.exec(document.body.innerText||'')?.[0]?.trim() ?? 'нет'`,
  ),
)

/*
 * ПРИБОР И ЗАЛ ВИДЯТ ОДИН НОМЕР.
 *
 * Номер живёт в ОДНОМ месте продукта — в приборе, — и весь смысл этого номера
 * в том, что он не отстаёт от зала. Разойтись они умеют молча: на пульте
 * рисуется своё намерение, а до проектора оно не доехало, и на экране это
 * выглядит исправным пультом.
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
  'прибор показывает номер страницы',
  `прибор ${gaugeNow || '—'} · зал ${roomNow || '—'}`,
)

/*
 * И этот номер живой: листаем с пульта и ждём зал. Назад, а не вперёд, когда
 * есть куда: на последней странице «ВПЕРЁД» выключено, и проверка проверяла бы
 * выключенную клавишу.
 */
const backwards = Number(roomNow) > 1
const wantPage = String(Number(roomNow) + (backwards ? -1 : 1))
await pult.js(press(backwards ? PULT.prev : PULT.next))
const caught = await until(student, `${roomPage} === ${JSON.stringify(wantPage)}`, 'зал догнал пульт', 8000)
const gaugeAfter = (await pult.js(`return ${gaugePage}`)) as string
check(
  caught && gaugeAfter === wantPage,
  'страница с пульта доезжает до зала',
  `прибор ${gaugeAfter || '—'} · зал ${(await student.js(`return ${roomPage}`)) || '—'}`,
)

/*
 * ФЕЙДЕР ЛИСТА.
 *
 * Лист — единственный источник света на пульте, и у него обязан быть
 * регулятор, не выходящий из приложения: три ступени пелены поверх листа И
 * чернил, 0 / 0.28 / 0.55, умолчание «зал».
 *
 * Меряется не класс пелены, а её работа: самая тёмная полупрозрачная заливка,
 * накрывающая лист целиком. Реализация свободна — `opacity` на плите, alpha в
 * самом цвете, — а вот число обязано меняться, иначе фейдер щёлкает вхолостую
 * и это видно только глазами в тёмном зале. `[data-pult-veil]`, если он есть,
 * снимает всю эту геометрию.
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
 * Указка на пульте: НАЖАЛИ — и она работает.
 *
 * Клавиша была чистой пружиной: светила, только пока её держат, — а чтобы
 * точка появилась, надо было держать клавишу на рейле И одновременно вести по
 * листу. Две руки на планшете и ни одной мыши на ноутбуке; на экране это
 * читалось как «кнопка нажимается, и ничего не происходит». Теперь тап
 * оставляет указку включённой, и проверяется именно тап.
 */
await pult.send('Page.bringToFront')
await pult.js(press(PULT.laser))
await wait(200)
check(
  (await pult.js(
    `return document.querySelector('[aria-label=${JSON.stringify(PULT.laser)}]')?.getAttribute('aria-pressed') === 'true'`,
  )) === true,
  'тап по указке оставляет её включённой',
  await pult.js(
    `return document.querySelector('[aria-label=${JSON.stringify(PULT.laser)}]')?.getAttribute('aria-pressed') ?? 'нет клавиши'`,
  ),
)
await pult.js(
  inkTarget +
    `const at=(t,fx,fy)=>input.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerId:7,pointerType:'pen',` +
    `buttons:t==='pointerup'?0:1,clientX:r.left+r.width*fx,clientY:r.top+r.height*fy}));` +
    `at('pointerdown',0.4,0.6); at('pointermove',0.45,0.58); return 1`,
)
/* Красное — на живом холсте: указка по §3 договора живёт на `ink-live`. */
const pultRed =
  `(()=>{const c=document.querySelector('canvas.ink-live');` +
  `if(!c||!c.width) return -1;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `let n=0; for(let i=0;i<d.length;i+=4) if(d[i+3]>24 && d[i]>150 && d[i+1]<120) n+=1; return n})()`
const litUp = await until(pult, `${pultRed} > 0`, 'указка пульта зажглась', 8000)
check(litUp, 'указка пульта светит после нажатия', `${await pult.js(`return ${pultRed}`)} красных точек на ink-live`)
await pult.js(
  inkTarget +
    `input.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,pointerType:'pen',buttons:0,` +
    `clientX:r.left+r.width*0.45,clientY:r.top+r.height*0.58})); return 1`,
)
/*
 * Указка — инструмент палитры, а не отдельный режим: в GoodNotes и Notability
 * выбор пера её снимает, и здесь тоже. Гасится она не вторым тапом по себе,
 * а «Пером» — так её никогда не забудешь гулять по проектору до конца пары.
 */
await pult.js(press(PULT.pen))
/*
 * Обведённая фигура догорает и после смены инструмента — так же, как в зале:
 * гасить её на пульте мгновенно значило бы показывать ведущему не то, что
 * видит зал. Ждём конца горения (HOLD_MS + FADE_MS в InkLayer) и требуем
 * пустоты: указка, забытая нажатой, — это как раз то, чего быть не должно.
 */
const wentOut = await until(pult, `${pultRed} === 0`, 'фигура указки догорела', 4000)
check(
  wentOut &&
    (await pult.js(
      `return document.querySelector('[aria-label=${JSON.stringify(PULT.laser)}]')?.getAttribute('aria-pressed') === 'false'`,
    )) === true,
  'выбор пера снимает указку',
  `указка aria-pressed=${await pult.js(
    `return document.querySelector('[aria-label=${JSON.stringify(PULT.laser)}]')?.getAttribute('aria-pressed') ?? '?'`,
  )} · красных на ink-live ${await pult.js(`return ${pultRed}`)}`,
)

/* Корпус и колодец сюда не попадают: они непрозрачны (alpha 1), пелена — нет. */
const faderCells =
  `(()=>{const root=document.querySelector('[aria-label=${JSON.stringify(PULT.fader)}]');` +
  `if(!root) return [];` +
  `let cells=[...root.querySelectorAll('button,[role="radio"],[role="button"]')];` +
  `if(!cells.length&&root.matches('button,[role="radio"],[role="button"]')) cells=[root];` +
  `if(!cells.length) cells=[...root.children];` +
  `return cells})()`
const faderSteps = (await pult.js(`return ${faderCells}.length`)) as number
check(faderSteps === 3, 'у фейдера листа три ступени', `ячеек ${faderSteps}`)
/*
 * Меряется ступень В ПОКОЕ, а не через фиксированную паузу.
 *
 * У пелены переход 320 мс, а `getComputedStyle` отдаёт значение последнего
 * расчёта стиля — то есть текущий кадр анимации. Кадры на пульте редкие:
 * headless без ускорителя перерисовывает лист лекции целиком, и «подождать
 * 450 мс» на занятой машине ловило пелену ещё на старте перехода. Проверка
 * при этом объявляла сломанным фейдер, у которого в разметке стояло ровно
 * то, что просил договор. Ждём, пока значение перестанет меняться: два
 * одинаковых чтения подряд, кадр между ними вытягивается своим rAF.
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
  'фейдер меняет непрозрачность пелены',
  rungs.length ? rungs.join(' · ') : 'пелены не нашли',
)
/* Возвращаем «зал»: это умолчание, и с ним живёт весь остальной прогон. */
const hall = ladder.indexOf(rungs[1])
if (hall >= 0) {
  await pult.js(`${faderCells}[${hall}].click(); return 1`)
  await restingVeil()
}

/*
 * Заметки в ландшафте — выдвижной лист поверх нижней части страницы: лист
 * лекции занимает весь остаток экрана, и постоянной ленты под ним больше
 * нет. Клавиша «Заметки» на рейле его поднимает и держит `aria-pressed`;
 * выше лист уже открыт перекличкой органов — здесь проверяется, что он
 * закрывается и открывается снова.
 */
await pult.js(press(PULT.notes))
await wait(400)
check(
  (await pult.js(`return !document.querySelector('[data-pult-notes] .pult-prompt')`)) === true &&
    (await pult.js(`return ${pressedIs(PULT.notes)}`)) === 'false',
  'клавиша «Заметки» сворачивает лист заметок',
  `aria-pressed=${await pult.js(`return ${pressedIs(PULT.notes)}`)}`,
)
await pult.js(press(PULT.notes))
await wait(500)
check(
  (await pult.js(`return !!document.querySelector('[data-pult-notes] .pult-prompt')`)) === true &&
    (await pult.js(`return ${pressedIs(PULT.notes)}`)) === 'true',
  'заметки спикера выдвигаются и читаются',
  await pult.js(
    `return (document.querySelector('[data-pult-notes] .pult-prompt')?.textContent||'').trim().slice(0,40) || 'листа нет'`,
  ),
)
/*
 * ЗАМЕТКИ НА ПУЛЬТЕ ПРИБИТЫ. Речь пишут за столом, на пуле её читают: поля
 * ввода здесь нет вовсе, и это проверяется прямо — не «поле не в фокусе», а
 * «поля не существует». Пока оно было, планшет ловил им случайное касание
 * ладони, поднимал клавиатуру на полэкрана, а Pencil начинал переводить
 * росчерк в текст.
 */
check(
  (await pult.js(`return !document.querySelector('[data-pult-notes] textarea')`)) === true,
  'заметки на пульте не правятся',
  await pult.js(
    `return 'полей ввода '+document.querySelectorAll('[data-pult-notes] textarea, [data-pult-notes] [contenteditable]').length`,
  ),
)
check(
  (await pult.js(
    `const t=document.querySelector('[data-pult-notes] .pult-prompt');return t?getComputedStyle(t).userSelect:'нет'`,
  )) !== 'none',
  'текст заметок выделяется',
  await pult.js(
    `const t=document.querySelector('[data-pult-notes] .pult-prompt');return 'user-select='+(t?getComputedStyle(t).userSelect:'нет')`,
  ),
)
/* Комнаты на пульте нет вовсе: ни вкладок, ни панели файлов, ни оракула. */
check(
  (await pult.js(
    `return !document.querySelector('[aria-label="Toggle the AI oracle"]') && !document.querySelector('[role="tablist"]')`,
  )) === true,
  'комната на пульт не переехала',
  'только лекция',
)
/*
 * ЛИСТ «ЕЩЁ» — И ТО, ЧТО ОН ОТКРЫВАЕТСЯ ИЗ ШАПКИ ЗАМЕТОК.
 *
 * Груз убранной нити лежит здесь: полный экран, «Сменить документ», «Левая
 * рука», справка про сон экрана и «Закончить лекцию». Открывать это неоткуда,
 * кроме «⋯» в шапке ленты заметок, и место кнопки — часть договора: шапка
 * заметок начинается ПОД листом. Кнопка, уехавшая обратно наверх, — это
 * вернувшаяся нить, только из одного знака.
 */
const morePlace = (await pult.js(
  `const b=document.querySelector('[aria-label=${JSON.stringify(PULT.more)}]');` +
    `if(!b) return 'кнопки «Ещё» нет';` +
    `const notes=document.querySelector('[data-pult-notes]');` +
    `if(!notes) return 'листа заметок нет';` +
    `if(!notes.contains(b)) return 'вне листа заметок';` +
    `const r=b.getBoundingClientRect(),n=notes.getBoundingClientRect();` +
    `return r.top-n.top<=48 ? 'в шапке заметок' : 'в листе заметок, но на '+Math.round(r.top-n.top)+'px ниже шапки'`,
)) as string
check(morePlace === 'в шапке заметок', '«Ещё» живёт в шапке листа заметок', morePlace)

await pult.js(press(PULT.more))
await wait(400)
const endsHere = (await pult.js(
  `return /закончить лекц/i.test(document.body.innerText||'')` +
    ` || !!document.querySelector('[aria-label="Закончить лекцию"]')`,
)) as boolean
check(endsHere === true, 'в листе «Ещё» есть «Закончить лекцию»', endsHere ? 'есть' : 'нет')
/* Там же — «Рисовать пальцем»: единственное место, где палец возвращают перу. */
check(
  (await pult.js(`return ${has(PULT.finger)}`)) === true,
  'в листе «Ещё» есть «Рисовать пальцем»',
  await pult.js(`return ${pressedIs(PULT.finger)}`).then((v) => `aria-pressed=${v}`),
)

/* Закрываем и ложем, и Escape: закрыть лист обязаны оба, а дальше проверке
   нужен пульт, а не поднятая плита поверх него. */
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
await until(pult, `!/закончить лекц/i.test(document.body.innerText||'')`, 'лист «Ещё» закрылся', 4000)

/* Лист заметок сворачивается: дальше меряется сам лист лекции. */
await pult.js(press(PULT.notes))
await wait(400)

/*
 * ЛИСТ ВО ВЕСЬ ОСТАТОК ЭКРАНА — на трёх планшетах.
 *
 * Раскладка считалась под один iPad 11" в ландшафте, и на 12.9" и в портрете
 * лист тонул в верхней трети экрана: «документ в каком-то окошке». Теперь
 * лист — всё, что осталось от рейла и полей, и проверяется это числом, а не
 * глазами: доля экрана под холстом, верхняя кромка и ширина коробки. Порог
 * доли — от геометрии: 16:9 в ландшафте укладывается на ≈2/3 экрана, в
 * портрете шириной 810 — на треть, остальное отдано заметкам.
 *
 * Каждая геометрия открывается ЗАНОВО: пульт меряет окно при старте, и
 * вкладка, пересчитанная на ходу, показала бы не то, что рисуется на iPad.
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
  const drawn = await until(pult, READY, `пульт ${W}×${H} нарисовал лист`)
  await wait(500)
  await takeConsole()
  const portrait = H > W
  // Лист заметок помнится ключом; в ландшафте меряется и снимается голый лист.
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
    `${W}×${H}: лист занимает экран`,
    g.canvas
      ? `${Math.round(g.canvas.width)}×${Math.round(g.canvas.height)} — ${Math.round(share * 100)}% экрана (нужно ≥${Math.round(need * 100)}%), верх ${Math.round(g.canvas.top)}px`
      : 'холста нет',
  )
  const railPlace = !g.rail
    ? 'рейла нет'
    : portrait
      ? g.rail.bottom >= H - 1
        ? 'снизу'
        : `не снизу (bottom ${Math.round(g.rail.bottom)})`
      : g.rail.left === 0
        ? 'слева'
        : `не слева (left ${Math.round(g.rail.left)})`
  check(railPlace === (portrait ? 'снизу' : 'слева'), `${W}×${H}: рейл ${portrait ? 'снизу' : 'слева'}`, railPlace)
  if (portrait) {
    // В портрете заметки не выдвигаются, а пристыкованы между листом и рейлом.
    check(
      !!g.notes && !!g.canvas && g.notes.top >= g.canvas.bottom && (!g.rail || g.notes.bottom <= g.rail.top + 1),
      `${W}×${H}: заметки пристыкованы под листом`,
      g.notes ? `заметки ${Math.round(g.notes.width)}×${Math.round(g.notes.height)} с y=${Math.round(g.notes.top)}` : 'заметок нет',
    )
  }
  if (process.argv.includes('--shot')) {
    // Снимок делается с ЖИВЫМ пультом: вкладка, ушедшая в фон, теряет сокет, и
    // без этого ожидания на снимок попадала полоса «нет связи».
    await wait(400)
    const shot = await pult.send('Page.captureScreenshot', { format: 'png' })
    const where = path.resolve(file)
    writeFileSync(where, Buffer.from(shot.result.data as string, 'base64'))
    console.log(`  снимок: ${where}`)
  }
}
/* Обратно на 11": с этой геометрией живёт остаток прогона. */
await pult.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 2, mobile: false })
await pult.send('Page.reload')
await until(pult, READY, 'пульт вернулся на 11"')
await takeConsole()
for (const line of pult.trouble.slice(0, 3)) console.log(`  (пульт) ${line}`)
await host.send('Page.bringToFront')

/*
 * Проекция показывает страницу, а не чёрный прямоугольник.
 *
 * Самая дорогая ошибка этого экрана: он и в исправном виде почти весь чёрный,
 * так что пустой лист на нём не отличить от «ещё не приехало». Окно выводится
 * вперёд нарочно — headless не рисует фоновые вкладки вовсе, а проекция на
 * балке всегда на виду.
 */
await beam.send('Page.bringToFront')
const beamDrew = await until(
  beam,
  `[...document.querySelectorAll('canvas')].some(c=>c.getBoundingClientRect().width>200)`,
  'проекция нарисовала страницу',
)
check(
  beamDrew,
  'проекция показывает лист, а не пустоту',
  await beam.js(
    `return document.querySelector('.shadow-pop')?.getAttribute('style') ?? 'листа нет'`,
  ),
)
await host.send('Page.bringToFront')

/*
 * Стрелки на проекции листают лекцию.
 *
 * Проекция стоит на компьютере у проектора, и в него воткнуты клавиатура и
 * кликер — а кликер шлёт ровно стрелки и PageDown. Листает только тот, чьи
 * это слайды: здесь окно проекции вошло тем же преподавателем, что ведёт.
 */
await beam.send('Page.bringToFront')
/*
 * Нажимаем, пока зал не перевернёт страницу. Окно проекции в headless-браузере
 * долго лежало в фоне, и его сокет мог оборваться: нажатие тогда ждёт
 * переподключения в очереди. Человек так не делает — у проекции свой монитор,
 * — а проверка так делать обязана, иначе она проверяет фоновые вкладки Chrome.
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
check(await pressUntil('ArrowRight', onThird, 'стрелка на проекции долистала до третьей'), 'стрелки на проекции листают лекцию', 'вперёд: 3 / 3')
check(await pressUntil('ArrowLeft', onSecond, 'стрелка на проекции вернула вторую'), 'и назад тоже', 'назад: 2 / 3')
await host.send('Page.bringToFront')

/*
 * «На проектор» из комнаты — отдельным окном, а комната остаётся.
 *
 * Раньше проекция уходила в ту же вкладку, и комната на этом компьютере
 * заканчивалась. Здесь смотрим, что адрес вкладки не сменился, а окно
 * проекции появилось среди целей браузера.
 */
/*
 * `window.open` подменён: синтетический клик — не жест человека, и браузер
 * не даёт ему открыть окно, а продукт по запасному пути уводит вкладку сам.
 * Проверяем намерение — куда открывают и что вкладка остаётся, — а не
 * политику всплывающих окон headless-браузера.
 */
await host.js(
  `window.__opened=null; window.open=(u)=>{window.__opened=String(u); return {focus(){}, closed:false}};` +
    `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='На проектор');` +
    `if(!b) throw new Error('кнопки «На проектор» нет'); b.click(); return 1`,
)
await wait(600)
check(
  (await host.js(`return location.pathname`)) === `/s/${ROOM}`,
  'комната остаётся на месте после «На проектор»',
  await host.js(`return location.pathname`),
)
check(
  (await host.js(`return window.__opened`)) === `/s/${ROOM}/screen`,
  'проекция открывается отдельным окном',
  await host.js(`return String(window.__opened)`),
)

/*
 * Чистый лист.
 *
 * Слайд кончился, а вывод формулы — нет. Лист заводится с пульта и обязан
 * доехать до проектора белым полем: страница с отрицательным номером есть в
 * лекции, но её нет в документе, и всё, что умеет только PDF, должно об этом
 * знать. Проверяется именно это — что на балке чисто, а не последний слайд.
 */
await pult.send('Page.bringToFront')
/*
 * Клавиша осталась клавишей, но слова на ней больше нет: чистый лист заводят
 * посреди фразы, и два нажатия (лента страниц → «+ новый лист») для этого —
 * уже отказ. Ищется по имени, не по подписи.
 */
await until(pult, named(PULT.blank), 'клавиша чистого листа на месте')
await pult.js(press(PULT.blank))
const blankSheet =
  `(async()=>{const c=[...document.querySelectorAll('canvas')].find(n=>n.getBoundingClientRect().width>200);` +
  `if(!c||!c.width) return false;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=3;i<d.length;i+=4) if(d[i]>16) return false; return true})()`
await beam.send('Page.bringToFront')
const cleared = await until(beam, blankSheet, 'проекция стала чистым листом', 12000)
check(cleared, 'чистый лист доезжает до проектора', 'белое поле')
/*
 * Говорит об этом прибор, и только он: у чистого листа нет доли колоды, поэтому
 * вместо «7 / 24» там «Л2», а вместо линейки темпа — слово «ЛИСТ». Спрашиваем
 * прибор, а не всю страницу: слово «лист» умеет случайно найтись где угодно.
 */
await pult.send('Page.bringToFront')
const boardGauge = (await pult.js(`return ${gaugeText}`)) as string
check(
  /Л\s*\d/i.test(boardGauge) || /лист/i.test(boardGauge),
  'пульт говорит, что показывает лист, а не страницу',
  boardGauge || 'прибор молчит',
)
/* И назад к слайдам — тем же нажатием: исписанный лист никуда не делся. */
await until(pult, named(PULT.toSlide), 'возврат к слайду появился')
await pult.js(press(PULT.toSlide))
await beam.send('Page.bringToFront')
await wait(300)
await until(beam, `!${blankSheet}`, 'проекция вернулась к слайду')
await host.send('Page.bringToFront')

/* Пауза гасит проекцию, но не пульт: у ведущего страница остаётся. */
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Пауза').click(); return 1`,
)
/* Оба утверждения проверяются, а не одно: непогасший зал раньше проходил эту
   строку с бодрым «да», потому что результат ожидания никуда не брался. */
const dimmed = await until(beam, `(document.body.textContent||'').includes('пауза')`, 'проекция погасла')
const hostKept = (await host.js(`return document.querySelectorAll('canvas').length > 0`)) === true
check(
  dimmed && hostKept,
  'пауза гасит зал, а у ведущего страница остаётся',
  dimmed ? (hostKept ? 'да' : 'зал погас, но и у ведущего страницы нет') : 'зал не погас',
)
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Пауза').click(); return 1`,
)

/*
 * Конец лекции возвращает всех в обычную читалку — со второго нажатия.
 *
 * Первое только спрашивает, и это проверяется отдельной строкой: «Закончить»
 * стоит вплотную к «На проектор» — к той кнопке, которую ведущий нажимает в
 * начале пары, — а промах на одну уносил разметку всей лекции безвозвратно.
 * Без этой проверки кнопку однажды вернут в один клик, и стенд промолчит.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Закончить');` +
    `if(!b) throw new Error('кнопки «Закончить» в полосе нет'); b.click(); return 1`,
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
  'первое «Закончить» спрашивает, а не заканчивает',
  stopAsked ? (stillLive ? 'спросила' : 'спросила, но лекция уже кончилась') : 'не спросила',
)
await host.js(
  `const b=[...document.querySelectorAll('button')]` +
    `.find(x=>['Закончить','Закончить лекцию?'].includes((x.textContent||'').trim()));` +
    `if(!b) throw new Error('«Закончить» пропала между нажатиями'); b.click(); return 1`,
)
await until(
  student,
  `!(document.body.textContent||'').includes('Лекцию ведёт')`,
  'лекция кончилась у студента',
)
check(
  (await student.js(`return !(document.body.textContent||'').includes('Лекцию ведёт')`)) === true,
  'конец лекции убирает её у всех',
  'убрал',
)
for (const line of beam.trouble.slice(0, 3)) console.log(`  (проекция) ${line}`)

await host.js(`document.querySelector('[aria-label="Закрыть lecture.pdf"]')?.click(); return 1`)
await wait(400)

/*
 * Номер выделенной ячейки — метка, а не тёмный прямоугольник.
 *
 * `cn` — это clsx, он классы не разрешает: цвет состояния и цвет метки
 * оставались оба, и цифры выходили цвета собственного фона. На экране это
 * читалось как залитый квадрат вместо номера.
 */
await host.js(pressCell(0))
await wait(300)
const inkOnInk = await host.js(
  `const cell=document.querySelector('[aria-label$="selected"]');` +
    `const span=[...cell.querySelectorAll('span')].find(s=>/^\\d\\d$/.test((s.textContent||'').trim()));` +
    `if(!span) return 'номера не нашли';` +
    `const css=getComputedStyle(span);` +
    `return css.color === css.backgroundColor ? 'цифры цвета фона' : css.color + ' на ' + css.backgroundColor`,
)
check(
  typeof inkOnInk === 'string' && inkOnInk.includes(' на '),
  'номер выделенной ячейки читается, а не залит',
  inkOnInk,
)

/*
 * Картинка открывается, а не показывает своё имя.
 *
 * У файла в комнате нет открытого адреса: `<img>` с прямой ссылкой получал 401
 * и рисовал `alt` — то есть имя файла. Выглядело это как «картинки не
 * открываются», и это была правда.
 */
await host.js(
  `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith('схема.gif'));` +
    `if(!b) throw new Error('картинки нет в дереве'); b.click(); return 1`,
)
await until(
  host,
  `(document.querySelector('main img, img[alt="схема.gif"]')?.naturalWidth ?? 0) > 0`,
  'картинка загрузилась',
)
check(
  (await host.js(
    `return (document.querySelector('img[alt="схема.gif"]')?.naturalWidth ?? 0) > 0`,
  )) === true,
  'картинка открывается, а не показывает своё имя',
  await host.js(
    `return (document.querySelector('img[alt="схема.gif"]')?.naturalWidth ?? 0) + 'px'`,
  ),
)
await host.js(`document.querySelector('[aria-label="Закрыть схема.gif"]')?.click(); return 1`)
await wait(300)

/* Быстрых действий в панели оракула больше нет. */
check(
  (await host.js(
    `return [...document.querySelectorAll('button')].some(b=>/^(Explain|Fix|Debug|Improve|Hint)$/.test((b.textContent||'').trim()))`,
  )) === false,
  'кнопок «объясни/почини/улучши» в панели нет',
  'убраны',
)

/* Закрыть можно и тетрадь — раньше её вкладка была вечной. */
await host.js(`document.querySelector('[aria-label="Закрыть разбор.ipynb"]').click(); return 1`)
await wait(400)
check(
  (await host.js(`return document.querySelectorAll('main').length`)) === 1,
  'тетрадь закрывается, как любой другой файл',
  'осталась одна',
)

/*
 * Снимок экрана на память — по просьбе `--shot`.
 *
 * Проверки отвечают на вопрос «работает ли», и ни одна из них не отвечает на
 * «как это выглядит». Значки видов файла, отступы вкладок и плотность дерева
 * проверяются только глазами, и снимок — единственный способ посмотреть на них,
 * не поднимая всё руками.
 */
if (process.argv.includes('--shot')) {
  // Снимок делаем с ОТКРЫТЫМ документом и полосой страниц: это самое новое, что
  // есть на экране, и единственное, что проверяется глазами.
  await host.js(
    `const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith('lecture.pdf')); b&&b.click(); return 1`,
  )
  await wait(1200)
  // Ждём сам документ: до его прихода полосы страниц нет по построению, и
  // слепое нажатие на «Страницы» в этот момент закрывало ровно то, ради чего
  // снимок и делается.
  await until(host, `document.querySelectorAll('canvas').length > 0`, 'документ для снимка')
  await host.js(
    `if(!document.querySelector('[data-rail]')){` +
      `[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Полоса страниц')?.click()}` +
      `return 1`,
  )
  await wait(900)
  await wait(500)
  // С выделенной ячейкой: залитый номер — самое мелкое, что стоит смотреть
  // глазами, и ровно то, что однажды оказалось тёмным квадратом.
  await host.js(
    // В тело, а не в корень: выделение слушает `[data-cell-body]` (см. pressCell).
    `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
      `cells[1]?.querySelector('[data-cell-body]')` +
      `?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); return 1`,
  )
  await wait(400)
  const shot = await host.send('Page.captureScreenshot', { format: 'png' })
  const where = path.resolve('ui-check.png')
  writeFileSync(where, Buffer.from(shot.result.data as string, 'base64'))
  console.log(`  снимок: ${where}`)
}

/*
 * Правила комнаты: перезагрузка — не «преподаватель изменил».
 *
 * Плашка о смене правил всплывала на каждой перезагрузке страницы в любой
 * комнате с неоткрытыми правилами: «первым кадром» считался кадр при
 * отсутствии правил у страницы, а правила у неё есть всегда — из кэша или из
 * умолчания. Поэтому сначала делаем правила неоткрытыми ПО-НАСТОЯЩЕМУ (той же
 * дверью, что и пульт правил), потом перезагружаем студента и смотрим, что
 * плашки нет, — и что настоящая смена её всё-таки показывает.
 */
const RULES_NOTICE = `/Преподаватель изменил, что можно делать/.test(document.body.textContent||'')`
const patchRules = (rules: Record<string, string>) =>
  `const me=JSON.parse(localStorage.getItem('colloq.identity.v1')||'{}')[${JSON.stringify(ROOM)}];` +
  `const r=await fetch('/api/sessions/${ROOM}/rules',{method:'PATCH',headers:{'content-type':'application/json',authorization:'Bearer '+me.token},body:JSON.stringify({rules:${JSON.stringify(rules)}})});` +
  `return r.status`
check((await host.js(patchRules({ edit: 'host' }))) === 200, 'правила комнаты меняются с экрана', 'edit: host')
await until(student, RULES_NOTICE, 'студент увидел смену правил')
check(
  (await student.js(`return ${RULES_NOTICE}`)) === true,
  'настоящая смена правил показывает плашку',
  'показала',
)
/*
 * «Перезагрузка» — второй вкладкой того же преподавателя, а не Page.reload.
 *
 * Для ошибки это одно и то же: страница поднимается с правилами из кэша и
 * получает приветственный кадр сокета. А для проверки — нет: перезагруженная
 * вкладка ведущего пересобирает токен и вкладки и сбивает десяток проверок
 * ниже, а перезагруженный студент вошёл бы с кукой преподавателя из общего
 * хранилища браузера. Вторая вкладка ничего из этого не трогает и закрывается
 * сразу после.
 */
const again = await tab(`http://127.0.0.1:${PORT}/s/${ROOM}`)
await until(
  again,
  `!document.querySelector('input#join-name') && [...document.querySelectorAll('button')].some(b=>(b.title||'').startsWith('lecture.pdf'))`,
  'вторая вкладка преподавателя открылась',
)
await wait(1500)
check(
  (await again.js(`return ${RULES_NOTICE}`)) === false,
  'перезагрузка страницы не выдаёт себя за смену правил',
  'плашки нет',
)
await again.send('Page.navigate', { url: 'about:blank' })
await wait(400)
/* Возвращаем открытую комнату — какой она и была. */
check((await host.js(patchRules({ edit: 'room' }))) === 200, 'правила вернулись к открытым', 'edit: room')
await wait(600)

/* ---------------------------------------------- тред оракула и его низ */

/*
 * Тред обязан ехать за вопросами аудитории, пока читатель стоит внизу, — и
 * замирать, как только он ушёл вверх читать. Ловится это только очередью
 * вопросов: один вопрос успевает дорисоваться, и низ не уезжает.
 *
 * Проверка стоит в самом конце: она добавляет в комнату восемь поворотов
 * треда, и любая проверка выше, считающая записи, сбилась бы об них.
 */
const OPEN_ORACLE =
  `const b=document.querySelector('[aria-label="Toggle the AI oracle"]');` +
  `if(b && !document.querySelector('textarea')) b.click(); return 1`
await host.send('Page.bringToFront')
await host.js(OPEN_ORACLE)
await student.js(OPEN_ORACLE)
await wait(900)

/** Окно прокрутки треда: сколько осталось до низа и где мы стоим. */
const THREAD =
  `const s=[...document.querySelectorAll('div')].filter(d=>(d.className||'').includes('overflow-y-auto')).pop();` +
  `if(!s) return null; return {gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), top: Math.round(s.scrollTop)}`

/*
 * Вопрос длинный намеренно: поворот треда дорастает уже ПОСЛЕ того, как мы
 * прокрутили вниз, и раньше в этот зазор проваливалась вся механика — событие
 * нашей же прокрутки приходило в обработчик, когда высота успела подрасти, и
 * тред отцеплялся от низа сам себе.
 */
const LONG =
  'Вопрос номер N: не понимаю, почему на третьей ячейке вылезает traceback про то, ' +
  'что объект не поддерживает индексацию, хотя выше по тетради ровно такая же строка ' +
  'отрабатывает без единой жалобы; расскажи подробно, что тут происходит и куда смотреть'

async function askOracle(page: Tab, text: string): Promise<void> {
  await page.js(
    `const t=[...document.querySelectorAll('textarea')].pop();` +
      `if(!t) throw new Error('поля вопроса нет');` +
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
  'тред оракула держится низа на каждом вопросе',
  `зазоры: ${gaps.join(', ')}`,
)

/* Ушедшего вверх читателя новый вопрос не дёргает: чтение важнее слежения. */
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
  'ушедшего вверх по треду новый вопрос не дёргает',
  `стоял на ${parked?.top}, остался на ${stayed?.top}`,
)
check(
  (await host.js(`return !!document.querySelector('button.animate-fade-up')`)) === true,
  'внизу треда появилась метка о новом ответе',
  'есть',
)

/* И метка возвращает вниз, снова прицепляя тред. */
await host.js(`const b=document.querySelector('button.animate-fade-up'); if(b) b.click(); return 1`)
await wait(500)
await askOracle(student, LONG.replace('N', '8'))
const back = (await host.js(THREAD)) as { gap: number } | null
check((back?.gap ?? 999) < 40, 'по метке тред снова идёт за вопросами', `зазор ${back?.gap}`)

for (const [who, page] of [
  ['преподаватель', host],
  ['студент', student],
] as const) {
  for (const line of page.trouble.slice(0, 4)) console.log(`  (${who}) ${line}`)
}

/*
 * И то же самое — проверкой, а не строчкой в выводе.
 *
 * Исключения собираются с самого начала «затем, что проверка, молчащая о том,
 * что на странице что-то упало, отправляет искать причину в код, который ни при
 * чём», — но в итог не попадали: страница, роняющая TypeError на каждом кадре,
 * давала «интерфейс отвечает» и код выхода 0, а три строки про неё тонули среди
 * двух сотен. Молчания не было, отказа не было тоже.
 */
const pages = [
  ['преподаватель', host],
  ['студент', student],
  ['планшет', pad],
  ['проекция', beam],
  ['пульт', pult],
  ['вторая вкладка', again],
] as const
const broke = pages.filter(([, page]) => page.trouble.length > 0)
check(
  broke.length === 0,
  'страницы не роняют исключений',
  broke.length === 0
    ? 'ни одного'
    : broke.map(([who, page]) => `${who}: ${page.trouble.length} — ${page.trouble[0]}`).join(' · '),
)

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`  ${r.ok ? 'ok  ' : 'ПЛОХО'}  ${r.what.padEnd(46)} ${r.got}`)
}
console.log(failed === 0 ? '\n  интерфейс отвечает' : `\n  провалов: ${failed}`)

/* Браузер и временный каталог убирает cleanUp на 'exit' — и на этом пути, и на
   любом падении посередине. */
process.exit(failed === 0 ? 0 : 1)
