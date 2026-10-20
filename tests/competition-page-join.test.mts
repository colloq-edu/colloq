/**
 * The way into a competition (0.25, the owner's sixth request): «Участвовать»
 * pressed on the leaderboard or on the packages tab used to send the visitor
 * to the general list, where the name was asked for in a form unfolding under
 * the competition's card — below the fold, with nothing focused. It now leads
 * to the competition's own join step, the first step of its «Посылки» tab,
 * which takes the focus; after joining the person stays there, with the key
 * above the send box.
 *
 * Without a browser: the decisions (join-step.ts), the screen's own handlers
 * and conditions read out of its source the way
 * competitions-navigation.test.mts does, and the components rendered on the
 * server. Focus and scrolling themselves are the live check's (the
 * scratchpad's xc/check.mts and xc/check-fixes.mts).
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { setLocaleResolver } from '../shared/i18n.js'
import { publicCompetition, type Competition } from '../shared/competitions.js'
import type { Accepting, EntrantCompetitionRow, EntrantMe } from '../shared/competitions-entrant.js'
import {
  joinedMe,
  joinFocusTarget,
  joinStepPath,
  markJoined,
  takesPartHere,
  visitKey,
} from '../web/src/components/competitions/join-step.js'
import { COMPETITIONS_LANDING, readCompetitionRoute } from '../web/src/lib/routes.js'

/* ------------------------------------------------------------ decisions */

test('the join step is the top of the competition’s submissions tab', () => {
  assert.equal(joinStepPath('rohlik'), '/k/rohlik/submissions')
})

test('the step hands the focus to the name, the one action, or the key', () => {
  // A stranger types a name first.
  assert.equal(joinFocusTarget({ accepting: 'open', signedIn: false, name: '' }), 'name')
  assert.equal(joinFocusTarget({ accepting: 'late', signedIn: false, name: '' }), 'name')
  // A stranger who already typed something still lands in the field, not on a button for a name not yet checked.
  assert.equal(joinFocusTarget({ accepting: 'open', signedIn: false, name: '@ivan' }), 'name')
  // A signed-in person has the name filled in: one action is left.
  assert.equal(joinFocusTarget({ accepting: 'open', signedIn: true, name: '@ivan' }), 'action')
  assert.equal(joinFocusTarget({ accepting: 'open', signedIn: true, name: '  ' }), 'name')
  // The door takes nobody now: only someone who joined before gets in, by the key.
  for (const accepting of ['not_open', 'closed'] as Accepting[]) {
    assert.equal(joinFocusTarget({ accepting, signedIn: false, name: '' }), 'key')
    assert.equal(joinFocusTarget({ accepting, signedIn: true, name: '@ivan' }), null)
  }
})

const anna = { id: 'e1', name: '@anna', disabled: false, createdAt: 1, lastSeenAt: 1 } as unknown as EntrantMe['entrant']

test('a signed-in person keeps the key in hand after joining another competition', () => {
  const before: EntrantMe = { entrant: anna, key: 'K7Q-M2X-9FD', link: 'http://x/k/t/K7Q-M2X-9FD' }
  // The door answers a known person without a key: they already have it.
  const after = joinedMe(before, { entrant: anna, key: null, link: null })
  assert.equal(after.key, 'K7Q-M2X-9FD')
  assert.equal(after.link, 'http://x/k/t/K7Q-M2X-9FD')
  // A newcomer's answer carries the new key, and it wins.
  const newcomer = joinedMe({ entrant: null, key: null, link: null }, { entrant: anna, key: 'AAA-BBB-CCC', link: 'l' })
  assert.equal(newcomer.key, 'AAA-BBB-CCC')
  // Someone else's key is never carried over.
  const other = { ...anna!, id: 'e2' } as EntrantMe['entrant']
  assert.equal(joinedMe(before, { entrant: other, key: null, link: null }).key, null)
})

test('the send box stands for those who take part here, the join step for the rest', () => {
  assert.equal(takesPartHere(null, null), false)
  assert.equal(takesPartHere({ mine: null }, null), false)
  assert.equal(takesPartHere({ mine: { joined: false } }, null), false)
  assert.equal(takesPartHere({ mine: { joined: true } }, null), true)
  // "My submissions" decides once it has arrived, as the server does: joined, or a submission here.
  assert.equal(takesPartHere({ mine: { joined: true } }, { joined: false, submissions: [] }), false)
  assert.equal(takesPartHere({ mine: { joined: false } }, { joined: false, submissions: [{}] }), true)
  assert.equal(takesPartHere({ mine: { joined: false } }, { joined: true, submissions: [] }), true)
})

test('the page’s copy of a standing learns the door’s yes, and nothing else changes', () => {
  const standing = { joined: false, place: 4, submissions: [] as unknown[] }
  const marked = markJoined(standing)!
  assert.equal(marked.joined, true)
  assert.equal(marked.place, 4)
  assert.equal(standing.joined, false, 'a copy, not the object the page read')
  // Nothing read yet, or already in: as it was.
  assert.equal(markJoined(null), null)
  const joined = { joined: true, place: 1 }
  assert.equal(markJoined(joined), joined)
})

test('a visit is the competition and the person: two people on one tab are two visits', () => {
  assert.equal(visitKey('rohlik', 'e1'), 'rohlik:e1')
  assert.notEqual(visitKey('rohlik', 'e1'), visitKey('rohlik', 'e2'))
  // A stranger, and the list.
  assert.equal(visitKey('rohlik', null), 'rohlik:')
  assert.equal(visitKey('rohlik', undefined), 'rohlik:')
  assert.equal(visitKey(null, 'e1'), ':e1')
})

/* ------------------------------------------------- the screen's handlers */

const screen = readFileSync(new URL('../web/src/screens/CompetitionsScreen.svelte', import.meta.url), 'utf8')

/** One function of the screen, run against a plain state object (competitions-navigation.test.mts). */
function handler(name: string, state: Record<string, unknown>, scope: Record<string, unknown> = {}) {
  const start = screen.search(new RegExp(`\\n  (async )?function ${name}\\(`)) + 1
  assert.ok(start > 0, `no ${name} in the screen`)
  const end = screen.indexOf('\n  }', start) + 4
  const code = ts.transpile(screen.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  const names = Object.keys(scope)
  return new Function('state', ...names, `with (state) { ${code}; return ${name}; }`)(state, ...names.map((key) => scope[key]))
}

/**
 * The condition of the first `{#if …}` after `marker` in the screen's markup,
 * run against a plain state object: what the screen decides, read out of the
 * screen itself rather than restated here.
 */
function condition(marker: string, state: Record<string, unknown>, scope: Record<string, unknown> = {}): boolean {
  const markup = screen.slice(screen.indexOf('</script>'))
  const from = markup.indexOf(marker)
  assert.ok(from >= 0, `no ${marker} in the screen’s markup`)
  const open = markup.indexOf('{#if ', from) + '{#if '.length
  const close = markup.indexOf('}\n', open)
  const expression = ts.transpile(`(${markup.slice(open, close)})`, { target: ts.ScriptTarget.ES2022 }).trim().replace(/;$/, '')
  const names = Object.keys(scope)
  return new Function('state', ...names, `with (state) { return ${expression}; }`)(state, ...names.map((key) => scope[key]))
}
/** The «Посылки» tab: the join step, or the send box when this is true. */
const JOIN_STEP = "{:else if tab === 'submissions'}"
/** Above the send box: the key card. */
const KEY_CARD = '{#snippet lead()}'

const screenScope = { joinedMe, joinStepPath, markJoined, takesPartHere, visitKey }
const fresh = (overrides: Record<string, unknown> = {}): Record<string, any> => ({
  route: { slug: 'alpha', view: 'submissions' }, me: { entrant: null, key: null, link: null }, page: null, mine: null,
  joinBusy: false, joinRefusal: null, joinAsk: null, joinedHere: null, signInBusy: false, signInRefusal: null,
  identityRequest: 0, generation: 0, say: (error: unknown) => (error as Error).message, onnavigate: () => {},
  ...overrides,
})
const pageOf = (slug: string, joined: boolean | null) => ({ competition: { slug }, mine: joined === null ? null : { joined, place: null } })
const mineOf = (joined: boolean) => ({ joined, submissions: [] as unknown[] })

for (const [where, view] of [['the leaderboard', 'leaderboard'], ['the packages tab', 'dependencies'], ['the task tab', 'task']] as const) {
  test(`«Участвовать» on ${where} opens the join step and asks it for the focus`, () => {
    const went: string[] = []
    const state = fresh({ route: { slug: 'alpha', view }, joinRefusal: 'stale refusal', signInRefusal: 'stale key refusal', onnavigate: (path: string) => went.push(path) })
    handler('startJoin', state, { joinStepPath })('alpha')
    assert.deepEqual(went, ['/k/alpha/submissions'])
    assert.equal(state.joinAsk, 'alpha')
    assert.equal(state.joinRefusal, null)
    assert.equal(state.signInRefusal, null, 'a key refused elsewhere does not stand under the step’s empty key field')
  })
}

test('«Участвовать» on the submissions tab stays and asks for the focus; from the list it goes to the competition', () => {
  const went: string[] = []
  const here = fresh({ onnavigate: (path: string) => went.push(path) })
  handler('startJoin', here, { joinStepPath })('alpha')
  assert.equal(went.length, 0, 'already on the step: no navigation')
  assert.equal(here.joinAsk, 'alpha')
  const list = fresh({ route: { slug: null, view: 'list' }, signInRefusal: 'Такого ключа нет.', onnavigate: (path: string) => went.push(path) })
  handler('startJoin', list, { joinStepPath })('beta')
  assert.deepEqual(went, ['/k/beta/submissions'])
  assert.equal(list.joinAsk, 'beta')
  assert.equal(list.signInRefusal, null, 'the list’s refusal stays on the list')
})

test('joining keeps the person on the tab, marks the visit for the key card and keeps the key in hand', async () => {
  const state = fresh({ me: { entrant: anna, key: 'K7Q-M2X-9FD', link: 'l' }, joinAsk: 'alpha' })
  const asked: string[] = []
  const api = { join: async (slug: string, name: string) => { asked.push(`${slug}:${name}`); return { entrant: anna, key: null, link: null } } }
  await handler('join', state, { ...screenScope, entrantApi: api })('alpha', '@anna')
  assert.deepEqual(asked, ['alpha:@anna'])
  assert.equal(state.me.key, 'K7Q-M2X-9FD')
  assert.equal(state.joinedHere, 'alpha:e1', 'the mark names the person, not only the competition')
  assert.equal(state.joinAsk, null)
  assert.equal(state.joinBusy, false)
})

test('a person who already carries an identity gets the send box the moment the door says yes', async () => {
  // The same person on the same page: nothing is reset, so the page's own copies must learn it.
  const state = fresh({ me: { entrant: anna, key: 'K7Q-M2X-9FD', link: 'l' }, page: pageOf('alpha', false), mine: mineOf(false) })
  assert.equal(condition(JOIN_STEP, state, screenScope), true, 'not in yet: the join step')
  await handler('join', state, { ...screenScope, entrantApi: { join: async () => ({ entrant: anna, key: null, link: null }) } })('alpha', '@anna')
  assert.equal(state.mine.joined, true)
  assert.equal(state.page.mine.joined, true)
  assert.equal(condition(JOIN_STEP, state, screenScope), false, 'in: the send box, at once')
  assert.equal(condition(KEY_CARD, state, screenScope), true, 'with the key above it')
})

test('a join answered after the person moved to another competition marks nothing there', async () => {
  let answer!: (value: EntrantMe) => void
  const state = fresh({ me: { entrant: anna, key: 'K7Q-M2X-9FD', link: 'l' }, page: pageOf('alpha', false), mine: mineOf(false) })
  const api = { join: () => new Promise<EntrantMe>((done) => (answer = done)) }
  const task = handler('join', state, { ...screenScope, entrantApi: api })('alpha', '@anna')
  // The person opens beta while the answer is on its way: the page holds beta's copies now.
  Object.assign(state, { route: { slug: 'beta', view: 'submissions' }, page: pageOf('beta', false), mine: mineOf(false) })
  answer({ entrant: anna, key: null, link: null })
  await task
  assert.equal(state.mine.joined, false)
  assert.equal(state.page.mine.joined, false)
  assert.equal(condition(JOIN_STEP, state, screenScope), true, 'beta still offers its own step')
  assert.equal(condition(KEY_CARD, state, screenScope), false)
})

test('a join belongs to the person who made it: the next person on the same tab gets the join step', async () => {
  const ivan = { ...anna!, id: 'ivan', name: '@ivan' }
  const boris = { ...anna!, id: 'boris', name: '@boris' }
  const state = fresh({ route: { slug: 'rohlik', view: 'submissions' }, page: pageOf('rohlik', null), joinAsk: 'rohlik' })
  // Ivan, a stranger, joins Rohlik on its step; the page reads Rohlik again as Ivan.
  await handler('join', state, { ...screenScope, entrantApi: { join: async () => ({ entrant: ivan, key: 'IVN-7QX-2KD', link: 'l' }) } })('rohlik', '@ivan')
  Object.assign(state, { page: pageOf('rohlik', true), mine: mineOf(true) })
  assert.equal(condition(JOIN_STEP, state, screenScope), false, 'Ivan: the send box')
  assert.equal(condition(KEY_CARD, state, screenScope), true, 'Ivan: his new key above it')
  // Back on the list (no reload), Boris signs in with his key: he has joined only another competition.
  state.route = { slug: null, view: 'list' }
  await handler('signIn', state, { entrantApi: { signIn: async () => ({ entrant: boris, key: 'BRS-4MN-8TP', link: 'l' }) } })('BRS-4MN-8TP')
  assert.equal(state.me.entrant.id, 'boris')
  // «Участвовать» on Rohlik's card, and the page reads Rohlik as Boris.
  handler('startJoin', state, screenScope)('rohlik')
  Object.assign(state, { route: { slug: 'rohlik', view: 'submissions' }, page: pageOf('rohlik', false), mine: mineOf(false) })
  assert.equal(condition(JOIN_STEP, state, screenScope), true, 'Boris: the join step, not a send box the door refuses')
  assert.equal(condition(KEY_CARD, state, screenScope), false, 'and no key card for a join that was not his')
})

test('a refused join keeps the step, its focus request and the words of the refusal', async () => {
  const state = fresh({ page: pageOf('alpha', null), joinAsk: 'alpha' })
  const api = { join: async () => { throw new Error('name taken') } }
  await handler('join', state, { ...screenScope, entrantApi: api })('alpha', '@anna')
  assert.equal(state.joinRefusal, 'name taken')
  assert.equal(state.joinAsk, 'alpha')
  assert.equal(state.joinedHere, null)
  assert.equal(state.me.entrant, null)
  assert.equal(condition(JOIN_STEP, state, screenScope), true, 'still the step')
})

test('a refusal answers the form it was typed into: gone on another page or tab, kept through the key link’s landing', () => {
  const state: Record<string, unknown> = { formsAt: null, joinRefusal: null, signInRefusal: null }
  const forget = handler('forgetRefusals', state)
  const at = (path: string) => {
    const route = readCompetitionRoute(path)!
    return `${route.slug ?? ''}/${route.view}`
  }
  // A key link is refused on its own address and drops the person on the list: the same place, the words stay.
  assert.equal(at('/k/t/AAA-BBB-CCC'), at(COMPETITIONS_LANDING))
  forget(at('/k/t/AAA-BBB-CCC'))
  state.signInRefusal = 'Такого ключа нет.'
  forget(at(COMPETITIONS_LANDING))
  assert.equal(state.signInRefusal, 'Такого ключа нет.')
  // A key refused on the list does not follow the person to a competition's step (its card's title, not «Участвовать»).
  forget(at('/k/rohlik/submissions'))
  assert.equal(state.signInRefusal, null)
  // Nor does a refusal on the step outlive a trip to another tab and back: the form is a new one, its fields empty.
  Object.assign(state, { joinRefusal: 'Это имя уже занято.', signInRefusal: 'Ключ отключён.' })
  forget(at('/k/rohlik/leaderboard'))
  forget(at('/k/rohlik/submissions'))
  assert.deepEqual([state.joinRefusal, state.signInRefusal], [null, null])
})

test('the screen forgets the forms’ refusals on every move between its pages and tabs', () => {
  assert.match(screen, /\$effect\(\(\) => forgetRefusals\(`\$\{route\.slug \?\? ''\}\/\$\{route\.view\}`\)\)/)
})

test('whether the send box stands is the server’s word alone; the visit’s mark only places the key card', () => {
  const markup = screen.slice(screen.indexOf('</script>'))
  const guard = markup.slice(markup.indexOf(JOIN_STEP)).split('\n')[1].trim()
  assert.equal(guard, '{#if !takesPartHere(page, mine)}')
  const card = markup.slice(markup.indexOf(KEY_CARD)).split('\n').find((line) => line.includes('{#if '))!.trim()
  assert.equal(card, '{#if joinedHere === visitKey(page!.competition.slug, me?.entrant?.id)}')
  // The mark goes with the visit: the screen's reset drops one made by another person or on another page.
  assert.match(screen, /if \(untrack\(\(\) => joinedHere\) !== key\) joinedHere = null/)
  assert.match(screen, /const key = visitKey\(slug, person\)/)
})

test('no «Участвовать» on the competition’s pages leads to the list any more', () => {
  const markup = screen.slice(screen.indexOf('</script>'))
  // The closed board, the packages tab and the list's cards all go through startJoin.
  const closedBoard = markup.slice(markup.indexOf('{#snippet closedBoard()}'), markup.indexOf('{/snippet}'))
  assert.match(closedBoard, /onclick=\{\(\) => page && startJoin\(page\.competition\.slug\)\}/)
  assert.match(markup, /<DependenciesView [^>]*onjoin=\{\(\) => startJoin\(page!\.competition\.slug\)\}/)
  assert.match(markup, /<CompetitionsList[\s\S]*?onjoin=\{startJoin\}/)
  assert.doesNotMatch(screen, /\blet joining\b|\bjoining = |\{joining\}/, 'the list’s unfolding form is gone')
})

/* --------------------------------------------------------- the markup */

let dir = ''
let JoinStep: Component<any>
let List: Component<any>
let KeyPanel: Component<any>

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-join-step-'))
  const compiled = new Map<string, string>()
  async function load(name: string): Promise<Component<any>> {
    const source = await readFile(new URL(`../web/src/components/competitions/${name}.svelte`, import.meta.url), 'utf8')
    let code = compile(source, { filename: `${name}.svelte`, generate: 'server' }).js.code
    for (const [from, to] of [
      ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
      ['svelte', import.meta.resolve('svelte')],
      ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
      ['@shared/competitions', new URL('../shared/competitions.ts', import.meta.url).href],
      ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
      ['@/lib/clipboard', new URL('../web/src/lib/clipboard.ts', import.meta.url).href],
      ['./join-step', new URL('../web/src/components/competitions/join-step.ts', import.meta.url).href],
      ...[...compiled].map(([other, file]) => [`./${other}.svelte`, pathToFileURL(file).href]),
    ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
    const file = path.join(dir, `${name}.mjs`)
    await writeFile(file, code)
    compiled.set(name, file)
    return (await import(pathToFileURL(file).href)).default
  }
  await load('KeySignIn')
  JoinStep = await load('JoinStep')
  List = await load('CompetitionsList')
  KeyPanel = await load('KeyPanel')
})
after(async () => {
  setLocaleResolver(() => 'ru')
  if (dir) await rm(dir, { recursive: true, force: true })
})

const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

function step(props: Partial<Record<string, unknown>> = {}, locale: 'ru' | 'en' = 'ru'): string {
  setLocaleResolver(() => locale)
  const html = render(JoinStep, {
    props: {
      accepting: 'open', defaultName: '', signedIn: false, busy: false, refusal: null,
      signInBusy: false, signInRefusal: null, focus: false,
      onfocused: () => {}, onjoin: () => {}, onsignin: () => {},
      ...props,
    },
  }).body
  setLocaleResolver(() => 'ru')
  return html
}

test('past the deadline the step says the solution will not count, not that the name shows on the board', () => {
  // Late submissions never reach the board (store.ts · selectBoardRows), and the late card's JOIN leads here.
  const late = text(step({ accepting: 'late' }))
  assert.match(late, /Дедлайн прошёл/)
  assert.match(late, /вне зачёта/)
  assert.match(late, /в лидерборд и места поздние посылки не попадают/)
  assert.doesNotMatch(late, /Имя видно в лидерборде/)
  // The name and JOIN stay: the door still takes people.
  assert.match(step({ accepting: 'late' }), /id="competition-join-name"/)
  // On time, the name is what the board shows.
  assert.match(text(step()), /Имя видно в лидерборде/)
  const en = step({ accepting: 'late' }, 'en')
  assert.match(text(en), /The deadline has passed/)
  assert.match(text(en), /does not count/)
  assert.doesNotMatch(text(en), /The name shows on the leaderboard/)
  assert.doesNotMatch(en, /[а-яё]/i)
})

test('a stranger’s join step asks for the name and offers the key beside it', () => {
  const html = step()
  assert.match(html, /id="competition-join-name"/)
  assert.match(html, /<label[^>]*for="competition-join-name"/)
  assert.match(text(html), /Вступите в соревнование/)
  assert.match(text(html), /Telegram или почта/)
  assert.match(text(html), /УЧАСТВОВАТЬ/)
  // The second way in: the key, for someone who joined from another device.
  assert.match(text(html), /ВОЙТИ С СОХРАНЁННЫМ КЛЮЧОМ/)
  assert.match(html, /aria-labelledby="competition-join-key-title"/)
  assert.match(text(html), /Уже участвуете с другого устройства\?/)
  // Nothing to press before a name is typed.
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled/)
})

test('a signed-in person joins under the name they carry, with no key to type', () => {
  const html = step({ signedIn: true, defaultName: '@anna_kim' })
  assert.match(html, /id="competition-join-name"/)
  assert.doesNotMatch(html, /competition-join-key-title/)
  assert.doesNotMatch(text(html), /СОХРАНЁННЫМ КЛЮЧОМ/)
})

test('when the door takes nobody, the step says why and keeps only the key', () => {
  const closed = step({ accepting: 'closed' })
  assert.doesNotMatch(closed, /competition-join-name/)
  assert.match(text(closed), /Приём посылок закрыт: дедлайн прошёл\./)
  assert.match(closed, /competition-join-key-title/)
  const soon = step({ accepting: 'not_open', signedIn: true, defaultName: '@anna_kim' })
  assert.match(text(soon), /Соревнование ещё не открыто\./)
  assert.doesNotMatch(soon, /competition-join-name|competition-join-key-title/)
})

test('the join step speaks English on an English page', () => {
  setLocaleResolver(() => 'en')
  const html = render(JoinStep, {
    props: {
      accepting: 'open', defaultName: '', signedIn: false, busy: false, refusal: 'Refused.',
      signInBusy: false, signInRefusal: null, focus: false, onfocused: () => {}, onjoin: () => {}, onsignin: () => {},
    },
  }).body
  setLocaleResolver(() => 'ru')
  assert.match(text(html), /Join the competition/)
  assert.match(text(html), /SIGN IN WITH A SAVED KEY/)
  assert.match(text(html), /Already taking part from another device\?/)
  assert.match(text(html), /Refused\./)
  assert.doesNotMatch(html, /[а-яё]/i)
})

test('the list’s «Участвовать» unfolds nothing under the card any more', () => {
  setLocaleResolver(() => 'ru')
  const now = Date.now()
  const competition = {
    id: 'c1', slug: 'alpha', title: 'Альфа', blurb: '', description: '', state: 'live', startsAt: null,
    deadlineAt: now + 86_400_000, metric: { name: 'MAPE', direction: 'lower', code: '' }, publicPercent: 30, splitSeed: 1,
    limits: { perDay: 5 }, scoring: 'last', privateRelease: 'auto', privateOpenedAt: null, environment: 'base',
    createdBy: null, createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
  } as unknown as Competition
  const row: EntrantCompetitionRow = {
    competition: publicCompetition(competition), entrants: 3, submissions: 4, bestPublic: null, baselinePublic: null, privateOpen: false, mine: null,
  }
  // `joining` is what used to unfold the form under a card: the list takes no such word any more.
  const html = render(List, { props: { rows: [row], now, joining: 'alpha', onopen: () => {}, onjoin: () => {} } }).body
  assert.match(text(html), /УЧАСТВОВАТЬ/)
  assert.doesNotMatch(html, /competition-join-name|<form/)
})

test('the key card alone, above the send box: no sign-in under it and no sign-out', () => {
  setLocaleResolver(() => 'ru')
  const me: EntrantMe = { entrant: anna, key: 'K7Q-M2X-9FD', link: 'http://x/k/t/K7Q-M2X-9FD' }
  const alone = render(KeyPanel, { props: { me, keyOnly: true } }).body
  assert.match(alone, /data-key-card/)
  assert.match(text(alone), /K7Q-M2X-9FD/)
  assert.doesNotMatch(text(alone), /ВОЙТИ С СОХРАНЁННЫМ КЛЮЧОМ|Выйти/)
  // Without a key there is nothing to show at all — not «your key appears once you join».
  assert.equal(text(render(KeyPanel, { props: { me: { entrant: anna, key: null, link: null }, keyOnly: true } }).body).trim(), '')
  // The list's panel keeps both.
  const panel = render(KeyPanel, { props: { me, busy: false, refusal: null, onsignin: () => {}, onsignout: () => {} } }).body
  assert.match(text(panel), /ВОЙТИ С СОХРАНЁННЫМ КЛЮЧОМ/)
  assert.match(text(panel), /Выйти/)
  assert.match(panel, /aria-labelledby="competition-signin-title"/)
})
