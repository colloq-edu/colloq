/**
 * The contest screen's decisions, read out of the screen itself and run
 * against plain state (the way competitions-navigation does it): which
 * answers are dropped as stale, what a word of the live stream fetches, and
 * how the screen is wired into App, the bundle and the `/k` list.
 *
 * None of this fails loudly when it breaks. A late answer for the previous
 * person paints their submissions under the new one's name; a stream word
 * that refetches everything is thirty full reloads a second in the last
 * minutes of a class test; a grammar in the wrong chunk is a slower room for
 * every seminar. Each gets a test.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { judged } from '../shared/contests.js'
import type { EntrantContestRow } from '../shared/contests-entrant.js'
import { ContestApiError } from '../web/src/lib/contestApi.js'
import config from '../web/vite.config.js'

const screen = readFileSync(new URL('../web/src/screens/ContestScreen.svelte', import.meta.url), 'utf8')

/** One function of the screen, run against a plain state object. */
function fn(name: string, state: Record<string, unknown>, scope: Record<string, unknown> = {}) {
  const start = screen.search(new RegExp(`\\n  (async )?function ${name}\\(`)) + 1
  assert.ok(start > 0, `no ${name} in the screen`)
  const end = screen.indexOf('\n  }', start) + 4
  const code = ts.transpile(screen.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  const names = Object.keys(scope)
  return new Function('state', ...names, `with (state) { ${code}; return ${name}; }`)(state, ...names.map((key) => scope[key]))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** The screen's state, with its own requestContext/currentContext read out of it. */
function stateOf(over: Record<string, unknown> = {}): Record<string, any> {
  const state: Record<string, any> = {
    routeSlug: 'algo',
    routeView: 'problems',
    person: 'one',
    generation: 1,
    page: null,
    mine: null,
    board: null,
    boardClosed: false,
    questions: null,
    questionsFresh: false,
    failure: null,
    ready: false,
    offset: 0,
    joined: true,
    ...over,
  }
  state.requestContext = fn('requestContext', state)
  state.currentContext = fn('currentContext', state)
  state.say = (error: unknown) => (error instanceof Error ? error.message : 'network')
  state.judged = judged
  state.ContestApiError = ContestApiError
  return state
}

/* --------------------------------------------------- stale answers */

for (const [name, apiName, field] of [
  ['loadPage', 'contest', 'page'],
  ['loadMine', 'submissions', 'mine'],
  ['loadBoard', 'standings', 'board'],
  ['loadQuestions', 'questions', 'questions'],
] as const) {
  test(`${name} drops an answer that comes back for another contest or another person`, async () => {
    for (const change of ['route', 'identity'] as const) {
      const pending = deferred<any>()
      const state = stateOf()
      state.loadPage = () => Promise.resolve()
      state.loadBoard = () => Promise.resolve()
      state.markSeen = () => Promise.resolve()
      state.landed = () => false
      const load = fn(name, state, { contestApi: { [apiName]: () => pending.promise } })
      const task = load('algo')
      state.generation++
      if (change === 'route') state.routeSlug = 'graphs'
      else state.person = 'two'
      state[field] = { current: 'new' }
      pending.resolve({ now: 0, contest: {}, submissions: [], questions: [], version: 'old', rows: [] })
      await task
      assert.deepEqual(state[field], { current: 'new' }, `${name} after a ${change} change`)
      assert.equal(state.failure, null)
    }
  })
}

test('the page keeps what it shows through a network blink, and drops it for a contest that is gone', async () => {
  const shown = { contest: { slug: 'algo' } }
  const blink = stateOf({ page: shown })
  await fn('loadPage', blink, { contestApi: { contest: () => Promise.reject(new ContestApiError('нет сети', 0, 'network')) } })('algo')
  assert.equal(blink.page, shown, 'a blink does not blank the page')
  assert.equal(blink.failure, null)

  const gone = stateOf({ page: shown })
  await fn('loadPage', gone, { contestApi: { contest: () => Promise.reject(new ContestApiError('Контест не найден', 404, 'not_found')) } })('algo')
  assert.equal(gone.page, null)
  assert.equal(gone.failure, 'Контест не найден')
})

test('the page measures the server’s clock from every answer', async () => {
  const state = stateOf()
  const before = Date.now()
  await fn('loadPage', state, { contestApi: { contest: () => Promise.resolve({ now: before + 300_000, contest: {} }) } })('algo')
  // Five minutes ahead, measured within the time the test took.
  assert.ok(Math.abs(state.offset - 300_000) < 1000, `offset ${state.offset}`)
  assert.equal(state.ready, true)
})

test('a submission judged since the last read reloads the page (the rail, the header) and an open board', async () => {
  const run = (id: string, state: string) => ({ id, state })
  const reloads: string[] = []
  const state = stateOf({ mine: { submissions: [run('s1', 'running')], version: 'a' }, routeView: 'leaderboard' })
  state.landed = fn('landed', state)
  state.loadPage = () => void reloads.push('page')
  state.loadBoard = () => void reloads.push('board')
  const fresh = { submissions: [run('s1', 'done')], version: 'b' }
  await fn('loadMine', state, { contestApi: { submissions: () => Promise.resolve(fresh) } })('algo')
  assert.equal(state.mine, fresh)
  assert.deepEqual(reloads, ['page', 'board'])

  // Another test of the same run passing is not a landing.
  reloads.length = 0
  state.mine = { submissions: [run('s2', 'running')], version: 'c' }
  await fn('loadMine', state, { contestApi: { submissions: () => Promise.resolve({ submissions: [run('s2', 'running')], version: 'd' }) } })('algo')
  assert.deepEqual(reloads, [])
})

test('the board closed to participants is an answer, not an error; the projector asks for the class’s view', async () => {
  const state = stateOf({ board: { rows: [] } })
  await fn('loadBoard', state, { contestApi: { standings: () => Promise.reject(new ContestApiError('Только участникам', 403, 'board_closed')) } })('algo')
  assert.equal(state.board, null)
  assert.equal(state.boardClosed, true)

  const asked: string[] = []
  const projector = stateOf({ routeView: 'screen' })
  await fn('loadBoard', projector, {
    contestApi: { standings: (_slug: string, audience: string) => (asked.push(audience), Promise.resolve({ rows: [] })) },
  })('algo')
  assert.deepEqual(asked, ['class'])
})

/* ------------------------------------------------------ the stream */

function following(view: string, over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const state = stateOf({
    routeView: view,
    page: { contest: { revision: 3 } },
    mine: { version: 'm1', submissions: [] },
    ...over,
  })
  for (const name of ['loadPage', 'loadMine', 'loadBoard', 'loadQuestions', 'refreshPlaceSoon']) {
    state[name] = () => void calls.push(name)
  }
  return { state, calls, follow: fn('follow', state) }
}

const word = (over: Record<string, unknown> = {}) => ({ revision: 3, mine: 'm1', board: 'b1', questions: 'q1', ...over })

test('the first word of a connection catches up only with what moved before it opened', () => {
  const same = following('problems')
  same.follow('algo', null, word())
  assert.deepEqual(same.calls, [], 'nothing moved: nothing is fetched on connecting')

  const moved = following('problems')
  moved.follow('algo', null, word({ revision: 4, mine: 'm2' }))
  assert.deepEqual(moved.calls, ['loadPage', 'loadMine'])
})

test('a stream word fetches what it names and nothing else', () => {
  const mineOnly = following('problems')
  mineOnly.follow('algo', word(), word({ mine: 'm2' }))
  assert.deepEqual(mineOnly.calls, ['loadMine'])

  const revision = following('submissions')
  revision.follow('algo', word(), word({ revision: 4 }))
  assert.deepEqual(revision.calls, ['loadPage'])

  // The board: fetched on the leaderboard; elsewhere only the header's place, throttled.
  const onBoard = following('leaderboard')
  onBoard.follow('algo', word(), word({ board: 'b2' }))
  assert.deepEqual(onBoard.calls, ['loadBoard'])
  const offBoard = following('problems')
  offBoard.follow('algo', word(), word({ board: 'b2' }))
  assert.deepEqual(offBoard.calls, ['refreshPlaceSoon'])

  // The questions: read on their tab; elsewhere the dot lights without a request.
  const onQuestions = following('questions')
  onQuestions.follow('algo', word(), word({ questions: 'q2' }))
  assert.deepEqual(onQuestions.calls, ['loadQuestions'])
  const offQuestions = following('problems')
  offQuestions.follow('algo', word(), word({ questions: 'q2' }))
  assert.deepEqual(offQuestions.calls, [])
  assert.equal(offQuestions.state.questionsFresh, true)

  // A stranger has no submissions to fetch and no answers to be told about.
  const stranger = following('problems', { person: null })
  stranger.follow('algo', word(), word({ mine: 'm2', questions: 'q2' }))
  assert.deepEqual(stranger.calls, [])
  assert.equal(stranger.state.questionsFresh, false)
})

test('the stream stays alive through a join or a sign-in with the same key', () => {
  // Its liveness is the contest and the person, not the request generation
  // that every identity action bumps (or the stream would go deaf).
  const effect = screen.slice(screen.indexOf('const alive = (): boolean =>'), screen.indexOf('return () => stream.close()'))
  assert.match(effect, /const alive = \(\): boolean => routeSlug === slug && person === who/)
  assert.doesNotMatch(effect, /currentContext\(/)
})

test('the screen reads the address through derived parts, so a letter clicked reloads nothing', () => {
  // `route` is a new object on every navigation: an effect reading `route.slug`
  // reran on every letter — the page fetched again, the stream reopened.
  const script = screen.slice(0, screen.indexOf('</script>'))
  const declared = 'const routeLetter = $derived(route.letter)'
  const after = script.slice(script.indexOf(declared) + declared.length)
  assert.match(script, /const routeSlug = \$derived\(route\.slug\)/)
  assert.doesNotMatch(after, /\broute\.(slug|view|letter)\b/, 'an effect or a function reads the route object itself')
  const markup = screen.slice(screen.indexOf('</script>'))
  assert.doesNotMatch(markup, /\broute\.(slug|view|letter)\b/)
})

/* ----------------------------------------------- wiring and bundle */

test('App opens the contest pages in a lazy chunk with the competitions’ dictionary, before the panel', () => {
  const app = readFileSync(new URL('../web/src/App.svelte', import.meta.url), 'utf8')
  assert.match(app, /const contest = \$derived\(readContestRoute\(path\)\)/)
  assert.match(app, /import\('@\/screens\/ContestScreen\.svelte'\)\.then\(\(m\) => m\.default\),\s*'competitions',/)
  const markup = app.slice(app.indexOf('</script>'))
  const contestAt = markup.indexOf('{:else if contest}')
  assert.ok(contestAt > markup.indexOf('{:else if competition}'), 'after the competitions branch')
  assert.ok(contestAt < markup.indexOf('{:else if isAdmin}'), 'before the panel, which would take an unknown address')
  assert.match(markup.slice(contestAt, markup.indexOf('{:else if isAdmin}')), /<ContestPage route=\{contest\} onnavigate=/)
})

test('the C and C++ grammar has a chunk of its own, and the room’s editor chunk keeps the rest', () => {
  const manualChunks = (config as any).build.rollupOptions.output.manualChunks as (id: string) => string | undefined
  const at = (pkg: string) => `/repo/node_modules/${pkg}/dist/index.js`
  assert.equal(manualChunks(at('@codemirror/lang-cpp')), 'codemirror-cpp')
  assert.equal(manualChunks(at('@lezer/cpp')), 'codemirror-cpp')
  assert.equal(manualChunks(at('@codemirror/lang-python')), 'codemirror')
  assert.equal(manualChunks(at('@lezer/common')), 'codemirror')
  assert.equal(manualChunks(at('@codemirror/view')), 'codemirror')
})

/* --------------------------------------------- the /k list section */

let dir = ''
let List: Component<any>
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-contests-list-'))
  const load = async (file: string, name: string, extra: [string, string][] = []): Promise<string> => {
    let code = compile(await readFile(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8'), {
      filename: `${name}.svelte`,
      generate: 'server',
    }).js.code
    for (const [from, to] of [
      ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
      ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
      ['@shared/contests', new URL('../shared/contests.ts', import.meta.url).href],
      ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
      ['@/lib/contest-words', new URL('../web/src/lib/contest-words.ts', import.meta.url).href],
      ['@/lib/routes', new URL('../web/src/lib/routes.ts', import.meta.url).href],
      ...extra,
    ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
    const out = path.join(dir, `${name}.mjs`)
    await writeFile(out, code)
    return pathToFileURL(out).href
  }
  const badge = await load('competitions/Badge.svelte', 'Badge')
  List = (await import(await load('contests/ContestsList.svelte', 'ContestsList', [['@/components/competitions/Badge.svelte', badge]]))).default
})
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 9, 30, 10, 0)
function row(slug: string, over: Partial<EntrantContestRow['contest']>, mine: EntrantContestRow['mine'] = null): EntrantContestRow {
  return {
    contest: {
      id: `c-${slug}`, slug, title: `Контест ${slug}`, blurb: '', description: '', state: 'live', rules: 'icpc',
      penaltyMinutes: 20, freezeMinutes: 0, unfrozenAt: null, attemptsPerProblem: 0, languages: ['python3'],
      environment: 'base', startsAt: NOW - 3_600_000, endsAt: NOW + 3_600_000, upsolving: false,
      boardVisibility: 'public', revision: 1, createdAt: 0, updatedAt: 0, ...over,
    } as EntrantContestRow['contest'],
    problems: 6,
    entrants: 34,
    mine,
  }
}
const text = (html: string) => html.replace(/<!--[^>]*-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

test('the /k list shows contests running first, links to /a/<slug>, and says where the person stands', () => {
  const html = render(List, {
    props: {
      now: NOW,
      onopen: () => {},
      rows: [
        row('old', { state: 'finished', endsAt: NOW - 86_400_000 }),
        row('soon', { startsAt: NOW + 7_200_000, endsAt: NOW + 10_800_000 }),
        row('live', {}, { joined: true, solved: 3, score: 3, place: 5 }),
      ],
    },
  }).body
  const shown = text(html)
  assert.ok(shown.indexOf('Контест live') < shown.indexOf('Контест soon'), 'running before soon')
  assert.ok(shown.indexOf('Контест soon') < shown.indexOf('Контест old'), 'soon before finished')
  assert.match(shown, /КОНТЕСТЫ 3|Контесты 3/i)
  assert.match(html, /href="\/a\/live"/)
  assert.match(shown, /ИДЁТ Контест · правила ICPC · 6 задач · 34 участника · штраф 20 мин за попытку Контест live/)
  assert.match(shown, /решено 3 из 6 · место 5/)
  assert.match(shown, /СКОРО/)
  assert.match(shown, /ДО НАЧАЛА 2 ч 0 мин/)
  assert.match(shown, /ДО КОНЦА 1 ч 0 мин/)
  assert.match(shown, /ЗАВЕРШЕНО/)
  assert.match(shown, /ещё не участвуете/)
})

test('the /k list has no contests section when there are none', () => {
  assert.equal(text(render(List, { props: { now: NOW, onopen: () => {}, rows: [] } }).body).trim(), '')
  // And the list screen asks for them beside the competitions, quietly.
  const list = readFileSync(new URL('../web/src/screens/CompetitionsScreen.svelte', import.meta.url), 'utf8')
  assert.match(list, /void loadList\(\)\s*\n\s*void loadContests\(\)/)
  assert.match(list, /<ContestsList rows=\{contests\} \{now\} onopen=\{onnavigate\} \/>/)
})
