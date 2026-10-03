import { translate, tr } from '../shared/i18n.js'
/**
 * One refusal — one voice; one pointer tick — one number.
 *
 * The lecture console and server talk about the same things in two pieces of
 * code, and both times the rule is spelled out rather than derived: the
 * console shows "the page is full" before a stroke, the server after a
 * reconnect, and it is ONE phrase; the console cuts pointer frames with a
 * certain window, and the server holds the dot back with the same window, and
 * it is ONE number. While there were two copies of each, both managed to
 * drift apart exactly the way copies do: the words matched, but the comment
 * on the server's tick referred to the INK tick — a different constant with
 * a similar name.
 *
 * The tests below compare not strings with each other (a tautology when there
 * is one function) but the two ends on the same ink: where the server
 * refuses, the console has already not opened a stroke, and vice versa. Plus
 * two looks into the sources — so that a second copy does not quietly appear
 * again.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LASER_EVERY_MS,
  LASER_HOLD_MS,
  MAX_INKED_PAGES,
  MAX_STROKES_PER_PAGE,
  inkFullSays,
} from '../shared/lecture.js'
import { addInk, inkOf, startLecture } from '../server/src/lecture.js'
import { inkRefusal } from '../web/src/components/lecture/pult.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Code without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const lecture = (id: string) =>
  startLecture(id, { file: 'slides.pdf', by: 'teacher', byName: 'Ада', color: '#d4162f' })

const dab = (page: number, name: string) => ({
  id: name,
  page,
  color: '#111',
  width: 0.004,
  points: [0, 0],
})

/* ------------------------------------------------- ceilings: two ends */

test('a full page: the console does not open a stroke exactly where the server would not accept it', () => {
  const id = 'полная-страница'
  lecture(id)
  for (let i = 0; i < MAX_STROKES_PER_PAGE - 1; i += 1) addInk(id, dab(1, `s${i}`))

  // The page is one stroke short: both ends still let it through.
  assert.equal(inkRefusal(inkOf(id), [], 1), null)
  const last = addInk(id, dab(1, 'последний'))
  assert.equal(last?.full, undefined)

  // And both refuse on the next one — not earlier and not later.
  const known = inkOf(id)
  const refusal = inkRefusal(known, [], 1)
  const server = addInk(id, dab(1, 'лишний'))
  assert.equal(server?.full, 'page-full')
  assert.equal(refusal, server?.full)
  /*
   * The phrase is one not because it happened to match but because the
   * function is one: the console calls `inkFullSays` from shared (InkLayer ·
   * `down`), the server calls the same one (control.ts · `case 'ink'`). The
   * console's own copy used to be there and matched word for word — until the
   * first edit of the wording.
   */
  assert.equal(inkFullSays(refusal!), inkFullSays(server!.full!))
  // The neighbouring page has nothing to do with this ceiling: writing goes
  // on there.
  assert.equal(inkRefusal(known, [], 2), null)
})

test('pages ran out: the console names the same ceiling as the server', () => {
  const id = 'много-страниц'
  lecture(id)
  for (let page = 1; page <= MAX_INKED_PAGES; page += 1) addInk(id, dab(page, `p${page}`))

  const known = inkOf(id)
  const fresh = MAX_INKED_PAGES + 1
  const refusal = inkRefusal(known, [], fresh)
  const server = addInk(id, dab(fresh, 'на новой'))
  assert.equal(server?.full, 'too-many-pages')
  assert.equal(refusal, server?.full)
  assert.equal(inkFullSays(refusal!), inkFullSays(server!.full!))

  // A page already written on lets both through: the ceiling is about the
  // number of pages.
  assert.equal(inkRefusal(known, [], 1), null)
  assert.equal(addInk(id, dab(1, 'ещё на первой'))?.full, undefined)
})

/* ----------------------------------------------- a second copy in the code */

test('the refusal words are typed in one file, and that is shared', () => {
  const says = (['page-full', 'too-many-pages', 'stroke-full'] as const).map(inkFullSays)
  const shared = read('shared/lecture.ts')
  for (const phrase of says) {
    const calls = [...shared.matchAll(/tr\("([^"]+)"\)/g)].map(match => match[1])
    assert.ok(
      calls.some(key => translate('ru', key) === phrase),
      `the phrase "${phrase}" is gone from shared/lecture.ts and its catalogue`,
    )
  }

  /*
   * We search the whole client and server: a copy appears not where people
   * remember it but where the refusal was needed a second time. Tests do not
   * count — they are supposed to know the phrase in order to guard it.
   */
  const sources: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.resolve(import.meta.dirname, '..', dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(ts|svelte)$/.test(entry.name)) sources.push(rel)
    }
  }
  walk('web/src')
  walk('server/src')

  for (const rel of sources) {
    const source = read(rel)
    for (const phrase of says) {
      assert.ok(!source.includes(phrase), `the phrase "${phrase}" is typed a second time in ${rel}`)
    }
  }
})

test('the console narrows the refusal from the shared type instead of typing the literals again', () => {
  const pult = code(read('web/src/components/lecture/pult.ts'))
  assert.match(
    pult,
    /export type InkRefusal = Extract<InkFull,/,
    'the console has its own list of refusals again: one renamed in shared will not break the build',
  )
})

/* ------------------------------------------------------- pointer tick */

test('the pointer tick is one number for both ends', () => {
  const ink = code(read('web/src/components/lecture/InkLayer.svelte'))
  assert.doesNotMatch(
    ink,
    /const\s+LASER_EVERY_MS\s*=/,
    'the console has its own copy of the tick again',
  )
  assert.match(
    ink,
    /import \{[^}]*\bLASER_EVERY_MS\b[^}]*\} from '@shared\/lecture'/,
    'the ink layer does not take the pointer tick from shared',
  )

  /*
   * The server's window is derived from the same number in shared
   * (`LASER_HOLD_MS`), a little shorter than the console's tick so that a
   * frame sent on time goes straight through. A copy of its own on the server
   * would drift apart from the console's at the first edit.
   */
  const control = code(read('server/src/control.ts'))
  assert.doesNotMatch(
    control,
    /const\s+LASER_(EVERY|HOLD)_MS\s*=/,
    'the server declares its own pointer window',
  )
  assert.match(
    control,
    /import \{[^}]*\bLASER_HOLD_MS\b[^}]*\} from '@shared\/lecture'/,
    'the server pointer window is not from shared',
  )
  assert.ok(
    LASER_HOLD_MS < LASER_EVERY_MS,
    'the server window is not shorter than the console tick',
  )
})

test('the hall plays the pointer back on a timeline, not on a spring', () => {
  /*
   * The spring is gone from both ends: on the console it lagged the Pencil and
   * rounded every corner, in the hall it chased fifteen points a second and
   * drew its own polygon instead of the presenter's circle. The delay the
   * hall plays the samples with is measured in ticks, so it follows the tick.
   */
  const ink = code(read('web/src/components/lecture/InkLayer.svelte'))
  assert.doesNotMatch(ink, /SPRING_(HAND|WIRE)/, 'the pointer is led by a spring again')
  const laser = code(read('web/src/components/lecture/laser.ts'))
  assert.match(
    laser,
    /LASER_DELAY_MS = LASER_EVERY_MS \* 2 \+ \d+/,
    'the playback delay no longer follows the tick',
  )
})
