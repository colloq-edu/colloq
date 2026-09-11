/**
 * Страницы ошибок ретранслятора: что именно они говорят и на каком языке.
 *
 * До этой правки любая ошибка веб-сервера показывала одну страницу — «комната
 * ещё не открыта» — с советом проверить адрес. Она врала трижды: комнаты с
 * таким именем могло не быть вовсе, Colloq на машине преподавателя мог
 * молчать при живом туннеле, а ретранслятор — падать сам по себе, и адрес был
 * ни при чём. Теперь состояний четыре, и проверяется здесь не вёрстка, а то,
 * из-за чего правка и случилась:
 *
 *  • у каждого состояния есть текст на обоих языках, и они разные. Английский
 *    добавлялся вручную, строка за строкой, — забыть одну проще простого, и
 *    тогда посреди английской страницы встанет русская фраза;
 *  • опрос комнаты идёт только там, где есть чему вернуться. «Такой комнаты
 *    нет» не ждёт: возвращаться нечему, а дышащая точка обещала бы обратное;
 *  • метка, по которой страница отличает «всё ещё мы» от «комната открылась»,
 *    лежит в разметке, а ищется в скрипте. Разъедутся — опрос замолчит
 *    навсегда, и никто не заметит: страница будет исправно висеть;
 *  • фигурных скобок в файле ровно три, и это подстановки caddy. Любая
 *    четвёртая — «{{» в JS или в тексте — ломает шаблон, и вместо страницы
 *    ошибки приедет пустой ответ от самого caddy;
 *  • разметка без JS обязана говорить то же, что скрипт по-русски: с
 *    выключенным JS видно именно её.
 *
 * Страницу отдаёт настоящая служба очков (scripts/relay-capy.py с CAPY_PAGE):
 * она отвечает тем же кодом 404, что и frps на живой машине, — так проверяется
 * и то, что страница цела, и то, что снаружи ей ничего не нужно.
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const PAGE = path.resolve(import.meta.dirname, '..', 'scripts/relay-offline.html')
const html = fs.readFileSync(PAGE, 'utf8')

const python = spawnSync('python3', ['--version'])
const HAVE_PYTHON = python.status === 0

/* ------------------------------------------------------------- текст страницы
 *
 * Словарь берётся из самой страницы, а не переписывается сюда: проверять копию
 * значило бы проверять себя. Кусок от помощников до `let lang` — это и есть
 * весь текст, и ничего, кроме текста, в нём нет.
 */
function texts(): any {
  const from = html.indexOf('// 1 очко, 2 очка')
  const to = html.indexOf('let lang = pickLang();')
  assert.ok(from > 0 && to > from, 'словарь текстов на странице не найден — переехал?')
  const src = html.slice(from, to)
  return new Function(`${src}\nreturn TEXT;`)()
}

const TEXT = texts()
const STATES = ['waiting', 'missing', 'down', 'fault']
const FACT = { host: 'hse.colloq.ru', code: 0, text: '', id: '', reason: '' }

/** Все пути словаря: ru и en должны совпадать по ним до последнего ключа. */
function paths(node: any, at = ''): string[] {
  if (typeof node !== 'object' || node === null) return [at]
  return Object.keys(node).flatMap((k) => paths(node[k], at ? `${at}.${k}` : k))
}

const CYRILLIC = /[А-Яа-яЁё]/

test('в словаре оба языка и ни одного пропущенного ключа', () => {
  assert.deepEqual(Object.keys(TEXT).sort(), ['en', 'ru'], 'языков не два')
  const ru = paths(TEXT.ru).sort()
  const en = paths(TEXT.en).sort()
  const lost = ru.filter((k) => !en.includes(k))
  const extra = en.filter((k) => !ru.includes(k))
  assert.deepEqual(
    lost,
    [],
    `по-английски нет того, что есть по-русски: ${lost.join(', ')}. ` +
      'Посреди английской страницы встанет русская фраза — и увидит её тот, ' +
      'кто по-русски не читает.',
  )
  assert.deepEqual(extra, [], `лишнее по-английски: ${extra.join(', ')}`)
})

test('у каждого из четырёх состояний свой текст на обоих языках', () => {
  for (const state of STATES) {
    for (const lang of ['ru', 'en'] as const) {
      const s = TEXT[lang].states[state]
      assert.ok(s, `нет состояния «${state}» на ${lang}`)
      const fact = { ...FACT, code: state === 'fault' ? 502 : 0 }
      for (const part of ['head', 'lede', 'wait', 'foot']) {
        const said = typeof s[part] === 'function' ? s[part](fact) : s[part]
        // Заголовок короткий по замыслу, остальное — живые фразы.
        const least = part === 'head' ? 8 : 40
        assert.ok(
          typeof said === 'string' && said.trim().length > least,
          `${state}.${part} на ${lang} — пусто или обрывок: «${said}»`,
        )
        // Английская страница по-русски не говорит. Обратное не проверяем:
        // «Colloq» в русской фразе — это имя, а не забытый перевод.
        if (lang === 'en') {
          assert.doesNotMatch(
            said,
            CYRILLIC,
            `${state}.${part}: английский текст с кириллицей — строку забыли перевести`,
          )
        }
      }
      assert.notEqual(
        TEXT.ru.states[state].head,
        TEXT.en.states[state].head,
        `заголовок «${state}» на обоих языках одинаковый — перевода нет`,
      )
    }
  }
  // Четыре состояния — четыре разных заголовка: иначе они снова слипнутся в
  // один, с чего эта правка и началась.
  for (const lang of ['ru', 'en'] as const) {
    const heads = STATES.map((s) => TEXT[lang].states[s].head)
    assert.equal(new Set(heads).size, heads.length, `заголовки повторяются (${lang})`)
  }
})

test('«не отвечает» честно называет, кто именно молчит', () => {
  for (const lang of ['ru', 'en'] as const) {
    const s = TEXT[lang].states.down
    const cls = s.lede({ ...FACT, reason: 'class' })
    const relay = s.lede({ ...FACT, reason: 'relay' })
    assert.notEqual(
      cls,
      relay,
      `${lang}: поломка ретранслятора и молчание машины преподавателя описаны одной фразой — ` +
        'а это разные новости и разные люди, к которым идти',
    )
    assert.notEqual(s.foot({ ...FACT, reason: 'class' }), s.foot({ ...FACT, reason: 'relay' }))
  }
})

test('«такой комнаты нет» показывает адрес, по которому пришли', () => {
  for (const lang of ['ru', 'en'] as const) {
    assert.match(
      TEXT[lang].states.missing.lede(FACT),
      /hse\.colloq\.ru/,
      `${lang}: имя, которого нет, не названо — человеку нечего сверять с ссылкой`,
    )
  }
})

test('«что-то пошло не так» показывает код и номер записи в журнале', () => {
  for (const lang of ['ru', 'en'] as const) {
    const line = TEXT[lang].fact({ ...FACT, code: 413, text: 'Payload Too Large', id: 'nqeb5jn18' })
    assert.match(line, /413/, `${lang}: кода нет в строке — по чему искать в журнале?`)
    assert.match(line, /nqeb5jn18/, `${lang}: номер запроса потерян`)
    const big = TEXT[lang].states.fault.lede({ ...FACT, code: 413 })
    const other = TEXT[lang].states.fault.lede({ ...FACT, code: 500 })
    assert.notEqual(big, other, `${lang}: 413 объясняется тем же, чем 500`)
    assert.match(other, /500/, `${lang}: код не назван в тексте`)
  }
})

test('опрос комнаты идёт только там, где есть чему вернуться', () => {
  const body = /function polls\(\) \{([^}]*)\}/.exec(html)?.[1]
  assert.ok(body, 'функции polls() на странице нет')
  const named = [...body.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(
    named,
    ['down', 'waiting'],
    'опрос ждёт не то: ждать имеет смысл только «ещё не открыта» и «не отвечает». ' +
      '«Такой комнаты нет» возвращаться неоткуда, а поломке 413 нечего перечитывать — ' +
      'дышащая точка и счётчик проверок обещали бы им то, чего не будет.',
  )
  // Точка дышит ровно в тех же состояниях — иначе страница обещает глазами то,
  // чего не делает.
  assert.match(html, /\[data-state='missing'\] \.dot \{[^}]*animation: none/)
  assert.match(html, /\[data-state='fault'\] \.dot \{[^}]*animation: none/)
})

test('метка опроса в разметке и в скрипте — одна и та же', () => {
  const meta = /<meta name="colloq-page" content="([a-z]+)" \/>/.exec(html)?.[1]
  const mark = /const MARK = '([^']+)'/.exec(html)?.[1]
  assert.ok(meta && mark, 'метки страницы или её поиска в скрипте нет')
  assert.equal(
    mark,
    `name="colloq-page" content="${meta}"`,
    'разметка и скрипт разошлись: опрос будет искать в ответе слово, которого там нет, — ' +
      'и вкладка перезагрузится в ту же страницу навсегда либо не перезагрузится никогда',
  )
})

test('подстановок ровно три, и это подстановки caddy', () => {
  // Скобки нарочно не те, что у шаблонов Go по умолчанию: пара фигурных
  // встречается в JS и в тексте сама собой, и первая же попытка упала на
  // комментарии, где такая пара стояла в объяснении. Пара с процентом не
  // встречается ни в HTML, ни в CSS, ни в JS.
  const open = (html.match(/<%/g) ?? []).length
  const found = [...html.matchAll(/<%([^%]*)%>/g)].map((m) => m[1].trim())
  assert.deepEqual(
    found,
    [
      'placeholder "http.error.status_code"',
      'placeholder "http.error.status_text"',
      'placeholder "http.error.id"',
    ],
    'подстановки caddy разъехались с тем, что читает страница',
  )
  assert.equal(
    open,
    3,
    'директива templates разбирает весь файл как шаблон Go: лишняя пара скобок ' +
      'где угодно — хоть в комментарии — это ошибка разбора, а значит пустой ответ ' +
      'вместо страницы ошибки. Белый экран ровно тогда, когда нужно объяснение.',
  )
})

test('разметка без JS говорит то же, что скрипт по-русски', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  const pick = (re: RegExp) => flat(re.exec(html)?.[1] ?? '')
  const waiting = TEXT.ru.states.waiting
  assert.equal(pick(/<h1 id="head">([^<]*)<\/h1>/), waiting.head, 'заголовок в разметке отстал')
  assert.equal(pick(/<p class="lede" id="lede">([^<]*)<\/p>/), flat(waiting.lede(FACT)))
  assert.equal(pick(/<span id="wait-text">([^<]*)<\/span>/), flat(waiting.wait(FACT)))
  assert.equal(pick(/<p class="note" id="foot">([^<]*)<\/p>/), flat(waiting.foot(FACT)))
  assert.match(html, /<main id="page" data-state="waiting">/, 'разметка без JS не в том состоянии')
})

test('страница открыта проверкам: игра и состояние', () => {
  assert.match(html, /window\.capy = \{/, 'игра больше не доступна проверкам вживую')
  assert.match(html, /window\.colloqPage = \{/, 'состояние страницы не видно проверкам')
  for (const key of ['setState', 'setLang', 'get state()', 'get lang()', 'get polls()']) {
    assert.ok(html.includes(key), `в window.colloqPage нет ${key}`)
  }
})

/* ------------------------------------------------------ страница на сервере */

let service: ChildProcess | null = null
let base = ''
let root = ''

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

async function up(): Promise<void> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-page-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  service = spawn('python3', [path.resolve(import.meta.dirname, '..', 'scripts/relay-capy.py')], {
    env: { ...process.env, CAPY_STATE: root, CAPY_PORT: String(port), CAPY_PAGE: PAGE },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/.relay/capy/scores`)
      if (r.ok) return
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('сервис капибары не поднялся')
}

function down(): void {
  service?.kill('SIGKILL')
  if (root) fs.rmSync(root, { recursive: true, force: true })
}

const suite = test.suite ?? test.describe

suite('страница ошибки на сервере', { skip: HAVE_PYTHON ? false : 'нет python3' }, () => {
  test.before(up)
  test.after(down)

  test('отдаётся целиком и тем же кодом, что у frps', async () => {
    const r = await fetch(`${base}/`)
    assert.equal(r.status, 404, 'страница ошибки ушла с кодом успеха — снаружи её примут за комнату')
    const body = await r.text()
    assert.equal(body, html, 'сервер отдал не тот файл, который лежит в репозитории')
    assert.match(body, /<meta name="colloq-page" content="offline" \/>/)
  })

  test('снаружи странице не нужно ничего', async () => {
    const body = await (await fetch(`${base}/`)).text()
    // Ни шрифтов, ни картинок, ни библиотек: её открывают с телефона в
    // аудитории, где может не грузиться вообще ничего.
    assert.doesNotMatch(body, /https?:\/\//, 'в странице появился внешний адрес')
    assert.doesNotMatch(body, /(?:src|href)="\/\//, 'в странице появился адрес без схемы')
    const asked = [...body.matchAll(/fetch\((['"])([^'"]+)\1/g)].map((m) => m[2])
    assert.deepEqual(
      asked.sort(),
      ['/.relay/capy/start', '/.relay/state'].sort(),
      'страница просит не то и не там: всё, кроме своего адреса и путей /.relay/*, ' +
        'в аудитории без интернета просто не приедет',
    )
  })

  test('таблица рекордов у страницы своя и живая', async () => {
    const r = await fetch(`${base}/.relay/capy/scores`)
    assert.equal(r.status, 200)
    const board = (await r.json()) as { top: unknown[] }
    assert.ok(Array.isArray(board.top), 'служба очков отвечает не таблицей')
    assert.match(html, /const API = '\/\.relay\/capy\/scores'/, 'страница ходит за очками не туда')
  })
})
