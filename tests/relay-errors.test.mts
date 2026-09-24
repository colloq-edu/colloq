/**
 * The relay's error pages: what exactly they say and in which language.
 *
 * Before this change, any web server error showed one page — "the room is not
 * open yet" — with advice to check the address. It lied three times over: a
 * room with that name might not exist at all, Colloq on the teacher's machine
 * could be silent while the tunnel was alive, and the relay could fail on its
 * own, with the address having nothing to do with it. Now there are four
 * states, and what is checked here is not the layout but what the change was
 * made for:
 *
 *  • every state has text in both languages, and the two differ. The English
 *    was added by hand, line by line — forgetting one is the easiest thing in
 *    the world, and then a Russian phrase stands in the middle of the English
 *    page;
 *  • the room is polled only where there is something to come back to. "No
 *    such room" does not wait: there is nothing to come back to, and a
 *    breathing dot would promise the opposite;
 *  • the mark by which the page tells "still us" from "the room has opened"
 *    lives in the markup but is searched for in the script. If they drift
 *    apart, polling goes silent forever, and nobody notices: the page will
 *    hang there dutifully;
 *  • there are exactly three curly-brace pairs in the file, and they are caddy
 *    placeholders. Any fourth — "{{" in the JS or in the text — breaks the
 *    template, and instead of the error page an empty response comes from
 *    caddy itself;
 *  • the markup without JS has to say the same as the script does in Russian:
 *    with JS turned off, the markup is exactly what is visible.
 *
 * The page is served by the real score service (scripts/relay-capy.py with
 * CAPY_PAGE): it answers with the same 404 code as frps on a live machine —
 * which checks both that the page is intact and that it needs nothing from
 * outside.
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

/* -------------------------------------------------------------- the page text
 *
 * The dictionary is taken from the page itself rather than copied here:
 * checking a copy would mean checking ourselves. The slice from the helpers to
 * `let lang` is the whole text, and there is nothing but text in it.
 */
function texts(): any {
  const from = html.indexOf('// 1 очко, 2 очка')
  const to = html.indexOf('let lang = pickLang();')
  assert.ok(from > 0 && to > from, 'the text dictionary was not found on the page: has it moved?')
  const src = html.slice(from, to)
  return new Function(`${src}\nreturn TEXT;`)()
}

const TEXT = texts()
const STATES = ['waiting', 'missing', 'down', 'fault']
const FACT = { host: 'hse.colloq.ru', code: 0, text: '', id: '', reason: '' }

/** All the dictionary paths: ru and en must match on them down to the last key. */
function paths(node: any, at = ''): string[] {
  if (typeof node !== 'object' || node === null) return [at]
  return Object.keys(node).flatMap((k) => paths(node[k], at ? `${at}.${k}` : k))
}

const CYRILLIC = /[А-Яа-яЁё]/

test('the dictionary has both languages and not a single missing key', () => {
  assert.deepEqual(Object.keys(TEXT).sort(), ['en', 'ru'], 'there are not two languages')
  const ru = paths(TEXT.ru).sort()
  const en = paths(TEXT.en).sort()
  const lost = ru.filter((k) => !en.includes(k))
  const extra = en.filter((k) => !ru.includes(k))
  assert.deepEqual(
    lost,
    [],
    `English lacks what Russian has: ${lost.join(', ')}. ` +
      'A Russian phrase will stand in the middle of the English page, and it will be seen by ' +
      'someone who does not read Russian.',
  )
  assert.deepEqual(extra, [], `extra in English: ${extra.join(', ')}`)
})

test('each of the four states has its own text in both languages', () => {
  for (const state of STATES) {
    for (const lang of ['ru', 'en'] as const) {
      const s = TEXT[lang].states[state]
      assert.ok(s, `no "${state}" state in ${lang}`)
      const fact = { ...FACT, code: state === 'fault' ? 502 : 0 }
      for (const part of ['head', 'lede', 'wait', 'foot']) {
        const said = typeof s[part] === 'function' ? s[part](fact) : s[part]
        // The heading is short by design; the rest are real sentences.
        const least = part === 'head' ? 8 : 40
        assert.ok(
          typeof said === 'string' && said.trim().length > least,
          `${state}.${part} in ${lang} is empty or a fragment: "${said}"`,
        )
        // The English page does not speak Russian. The reverse is not checked:
        // "Colloq" in a Russian phrase is a name, not a forgotten translation.
        if (lang === 'en') {
          assert.doesNotMatch(
            said,
            CYRILLIC,
            `${state}.${part}: English text with Cyrillic — a line was left untranslated`,
          )
        }
      }
      assert.notEqual(
        TEXT.ru.states[state].head,
        TEXT.en.states[state].head,
        `the "${state}" heading is the same in both languages: there is no translation`,
      )
    }
  }
  // Four states, four different headings: otherwise they would stick together
  // into one again, which is where this change began.
  for (const lang of ['ru', 'en'] as const) {
    const heads = STATES.map((s) => TEXT[lang].states[s].head)
    assert.equal(new Set(heads).size, heads.length, `headings repeat (${lang})`)
  }
})

test('"not responding" honestly names who exactly is silent', () => {
  for (const lang of ['ru', 'en'] as const) {
    const s = TEXT[lang].states.down
    const cls = s.lede({ ...FACT, reason: 'class' })
    const relay = s.lede({ ...FACT, reason: 'relay' })
    assert.notEqual(
      cls,
      relay,
      `${lang}: a relay failure and a silent teacher machine are described by one phrase — ` +
        'yet these are different news and different people to go to',
    )
    assert.notEqual(s.foot({ ...FACT, reason: 'class' }), s.foot({ ...FACT, reason: 'relay' }))
  }
})

test('"no such room" shows the address the request came to', () => {
  for (const lang of ['ru', 'en'] as const) {
    assert.match(
      TEXT[lang].states.missing.lede(FACT),
      /hse\.colloq\.ru/,
      `${lang}: the missing name is not named: the person has nothing to check the link against`,
    )
  }
})

test('"something went wrong" shows the code and the log entry number', () => {
  for (const lang of ['ru', 'en'] as const) {
    const line = TEXT[lang].fact({ ...FACT, code: 413, text: 'Payload Too Large', id: 'nqeb5jn18' })
    assert.match(line, /413/, `${lang}: the code is not in the line: what would the log be searched by?`)
    assert.match(line, /nqeb5jn18/, `${lang}: the request number is lost`)
    const big = TEXT[lang].states.fault.lede({ ...FACT, code: 413 })
    const other = TEXT[lang].states.fault.lede({ ...FACT, code: 500 })
    assert.notEqual(big, other, `${lang}: 413 is explained the same way as 500`)
    assert.match(other, /500/, `${lang}: the code is not named in the text`)
  }
})

test('the room is polled only where there is something to come back to', () => {
  const body = /function polls\(\) \{([^}]*)\}/.exec(html)?.[1]
  assert.ok(body, 'there is no polls() function on the page')
  const named = [...body.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(
    named,
    ['down', 'waiting'],
    'polling waits for the wrong thing: waiting makes sense only for "not open yet" and "not responding". ' +
      '"No such room" has nowhere to come back from, and a 413 failure has nothing to reread — ' +
      'a breathing dot and a check counter would promise them what will not happen.',
  )
  // The dot breathes in exactly the same states — otherwise the page promises
  // with its looks what it does not do.
  assert.match(html, /\[data-state='missing'\] \.dot \{[^}]*animation: none/)
  assert.match(html, /\[data-state='fault'\] \.dot \{[^}]*animation: none/)
})

test('the polling mark in the markup and in the script is one and the same', () => {
  const meta = /<meta name="colloq-page" content="([a-z]+)" \/>/.exec(html)?.[1]
  const mark = /const MARK = '([^']+)'/.exec(html)?.[1]
  assert.ok(meta && mark, 'the page mark or the search for it in the script is missing')
  assert.equal(
    mark,
    `name="colloq-page" content="${meta}"`,
    'the markup and the script drifted apart: polling will look in the response for a word that is not there — ' +
      'and the tab will reload into the same page forever or never reload at all',
  )
})

test('there are exactly three placeholders, and they are caddy placeholders', () => {
  // The delimiters are deliberately not the Go template defaults: a pair of curly
  // braces turns up in JS and in text on its own, and the very first attempt failed
  // on a comment where such a pair stood in an explanation. A pair with a percent
  // sign occurs neither in HTML, nor in CSS, nor in JS.
  const open = (html.match(/<%/g) ?? []).length
  const found = [...html.matchAll(/<%([^%]*)%>/g)].map((m) => m[1].trim())
  assert.deepEqual(
    found,
    [
      'placeholder "http.error.status_code"',
      'placeholder "http.error.status_text"',
      'placeholder "http.error.id"',
    ],
    'the caddy placeholders drifted apart from what the page reads',
  )
  assert.equal(
    open,
    3,
    'the templates directive parses the whole file as a Go template: an extra pair of delimiters ' +
      'anywhere — even in a comment — is a parse error, which means an empty response ' +
      'instead of the error page. A white screen exactly when an explanation is needed.',
  )
})

test('the markup without JS says the same as the script in Russian', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  const pick = (re: RegExp) => flat(re.exec(html)?.[1] ?? '')
  const waiting = TEXT.ru.states.waiting
  assert.equal(pick(/<h1 id="head">([^<]*)<\/h1>/), waiting.head, 'the heading in the markup fell behind')
  assert.equal(pick(/<p class="lede" id="lede">([^<]*)<\/p>/), flat(waiting.lede(FACT)))
  assert.equal(pick(/<span id="wait-text">([^<]*)<\/span>/), flat(waiting.wait(FACT)))
  assert.equal(pick(/<p class="note" id="foot">([^<]*)<\/p>/), flat(waiting.foot(FACT)))
  assert.match(html, /<main id="page" data-state="waiting">/, 'the markup without JS is in the wrong state')
})

test('the page is open to checks: the game and the state', () => {
  assert.match(html, /window\.capy = \{/, 'the game is no longer available to live checks')
  assert.match(html, /window\.colloqPage = \{/, 'the page state is not visible to checks')
  for (const key of ['setState', 'setLang', 'get state()', 'get lang()', 'get polls()']) {
    assert.ok(html.includes(key), `window.colloqPage has no ${key}`)
  }
})

/* --------------------------------------------------- the page on the server */

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
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the capybara service did not come up')
}

function down(): void {
  service?.kill('SIGKILL')
  if (root) fs.rmSync(root, { recursive: true, force: true })
}

const suite = test.suite ?? test.describe

suite('the error page on the server', { skip: HAVE_PYTHON ? false : 'no python3' }, () => {
  test.before(up)
  test.after(down)

  test('it is served whole and with the same code as frps', async () => {
    const r = await fetch(`${base}/`)
    assert.equal(r.status, 404, 'the error page went out with a success code: from outside it would pass for the room')
    const body = await r.text()
    assert.equal(body, html, 'the server served a different file than the one in the repository')
    assert.match(body, /<meta name="colloq-page" content="offline" \/>/)
  })

  test('the page needs nothing from outside', async () => {
    const body = await (await fetch(`${base}/`)).text()
    // No fonts, no images, no libraries: it is opened from a phone in a classroom
    // where nothing at all may load.
    assert.doesNotMatch(body, /https?:\/\//, 'an external address appeared in the page')
    assert.doesNotMatch(body, /(?:src|href)="\/\//, 'a scheme-less address appeared in the page')
    const asked = [...body.matchAll(/fetch\((['"])([^'"]+)\1/g)].map((m) => m[2])
    assert.deepEqual(
      asked.sort(),
      ['/.relay/capy/start', '/.relay/state'].sort(),
      'the page asks for the wrong things in the wrong places: everything except its own address and ' +
        'the /.relay/* paths simply will not arrive in a classroom without internet',
    )
  })

  test('the page has its own live high-score table', async () => {
    const r = await fetch(`${base}/.relay/capy/scores`)
    assert.equal(r.status, 200)
    const board = (await r.json()) as { top: unknown[] }
    assert.ok(Array.isArray(board.top), 'the score service does not answer with a table')
    assert.match(html, /const API = '\/\.relay\/capy\/scores'/, 'the page fetches scores from the wrong place')
  })
})
