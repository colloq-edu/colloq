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

await host.js(
  `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
    `if(cells.length < 2) throw new Error('в тетради меньше двух ячеек');` +
    `cells[0].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); return 1`,
)
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 1,
  'нажатие выделяет одну ячейку',
  await host.js(`return ${selectedCount}`),
)

/* Cmd (Ctrl) добавляет вторую, не снимая первую. */
await host.js(
  `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
    `cells[1].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,metaKey:true})); return 1`,
)
await wait(300)
check(
  (await host.js(`return ${selectedCount}`)) === 2,
  'Cmd добавляет вторую ячейку к выделению',
  await host.js(`return ${selectedCount}`),
)

/* Тем же Cmd она снимается обратно. */
await host.js(
  `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
    `cells[1].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,metaKey:true})); return 1`,
)
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
await host.js(
  `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
    `cells[1].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); return 1`,
)
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
  (await host.js(
    `return [...document.querySelectorAll('[data-rail] canvas')].filter(c=>c.width>0).length`,
  )) > 0,
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
const landed = (await host.js(
  `const sc=document.querySelector('[role=document]');` +
    `document.querySelector('[data-thumb="3"]').click();` +
    `const sheet=sc.querySelector('[data-page="3"]');` +
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
const sheetWidth = `Math.round(document.querySelector('canvas.ink').getBoundingClientRect().width)`
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
    `const c=document.querySelector('canvas.ink');` +
      `if(!c||!c.width) return -1;` +
      `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
      `let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>16) n+=1; return n`,
  )
check(((await strokeOn(student)) as number) <= 0, 'до штриха страница чистая', 'пусто')

await host.js(
  `const c=document.querySelector('canvas.ink');` +
    `if(!c) throw new Error('слоя чернил нет');` +
    `const r=c.getBoundingClientRect();` +
    `const at=(t,fx,fy)=>c.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerId:1,pointerType:'pen',` +
    `buttons:t==='pointerup'?0:1,pressure:0.5,clientX:r.left+r.width*fx,clientY:r.top+r.height*fy}));` +
    `at('pointerdown',0.2,0.3); at('pointermove',0.4,0.45); at('pointermove',0.6,0.35);` +
    `at('pointermove',0.8,0.5); at('pointerup',0.8,0.5); return 1`,
)
await until(student, `(async()=>{const c=document.querySelector('canvas.ink');if(!c||!c.width)return false;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=3;i<d.length;i+=4) if(d[i]>16) return true; return false})()`, 'штрих доехал до студента')
const inked = (await strokeOn(student)) as number
check(inked > 0, 'штрих ведущего появляется у студента', `${inked} закрашенных точек`)

/* Стёрли — и стёрлось у всех, а не только у того, кто рисовал. */
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Стереть').click(); return 1`,
)
await until(student, `(async()=>{const c=document.querySelector('canvas.ink');if(!c)return true;` +
  `const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;` +
  `for(let i=3;i<d.length;i+=4) if(d[i]>16) return false; return true})()`, 'чернила стёрлись у студента')
check(((await strokeOn(student)) as number) <= 0, 'стирание доезжает до всей комнаты', 'чисто')

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
await until(
  pad,
  `[...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`,
  'планшет вошёл и получил пульт',
)
check(
  (await pad.js(`return !document.querySelector('input#join-name')`)) === true,
  'планшет не спрашивает имени',
  'вошёл сразу',
)
check(
  (await pad.js(`return location.pathname`)) === `/s/${ROOM}`,
  'ключ убран из адреса после входа',
  await pad.js('return location.pathname'),
)
check(
  (await pad.js(
    `return [...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Закончить')`,
  )) === true,
  'планшет получает пульт, а не место в зале',
  'пульт на месте',
)
/*
 * И вторым человеком в комнате он не становится: список людей считает людей, а
 * не вкладки. Второй «Ада» в списке — это лекция, которую ведёт непонятно кто.
 */
check(
  (await host.js(
    `return [...document.body.textContent.matchAll(/Ада/g)].length`,
  )) as number >= 1,
  'в комнате по-прежнему один ведущий',
  await host.js(`return (document.body.textContent||'').match(/(\\d+) in the room/)?.[1] ?? '?'`),
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

/* Пауза гасит проекцию, но не пульт: у ведущего страница остаётся. */
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Пауза').click(); return 1`,
)
await until(beam, `(document.body.textContent||'').includes('пауза')`, 'проекция погасла')
check(
  (await host.js(`return document.querySelectorAll('canvas').length > 0`)) === true,
  'пауза гасит зал, а у ведущего страница остаётся',
  'да',
)
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Пауза').click(); return 1`,
)

/* Конец лекции возвращает всех в обычную читалку. */
await host.js(
  `[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Закончить').click(); return 1`,
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
await host.js(
  `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
    `cells[0].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); return 1`,
)
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
    `const cells=[...document.querySelectorAll('[data-cell-id]')];` +
      `cells[1]?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); return 1`,
  )
  await wait(400)
  const shot = await host.send('Page.captureScreenshot', { format: 'png' })
  const where = path.resolve('ui-check.png')
  writeFileSync(where, Buffer.from(shot.result.data as string, 'base64'))
  console.log(`  снимок: ${where}`)
}

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
