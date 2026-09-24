/**
 * A task that is running and a task that has hung are two different pictures,
 * not one.
 *
 * An "Act" turn ran for thirteen minutes, and all that time the panel showed a
 * motionless spinner and "preparing the next step": no step number, no figure,
 * no way to tell work from a hung request to the model. What is checked here is
 * exactly what that difference is made of: the time on every feed row, the
 * growing figure under it, the words about a prolonged silence, and the run
 * summary, which used to be unreachable in the markup.
 *
 * It is read straight from the components, as in `panels-craft.test.mts`: a
 * test with its own copy of the rule passes forever while the file drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'svelte/compiler'
import ts from 'typescript'
import { runInNewContext } from 'node:vm'
import { setLocaleResolver, translate, tr } from '../shared/i18n.js'
import { roomMessages } from '../shared/locales/room.js'
import { activityMessages } from '../shared/locales/activity.js'
import { ACTIVITY_KIND_LEVEL } from '../shared/activity.js'
import { spell } from '../web/src/lib/utils.js'

afterEach(() => setLocaleResolver(() => 'ru'))

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const TURN = 'web/src/components/panels/ChatTurn.svelte'
const HISTORY = 'web/src/components/panels/ActivityHistory.svelte'
const NOTEBOOK = 'shared/notebook.ts'

/* -------------------------------------------------------- the dictionary */

test('the stopwatch strings exist in both languages and both carry placeholders', () => {
  for (const key of ['room.oracle.stepAt', 'room.oracle.progress', 'room.oracle.stalled']) {
    const pair = roomMessages[key]
    assert.ok(pair, `${key}: missing from the room dictionary`)
    for (const locale of ['ru', 'en'] as const) {
      const text = pair[locale]
      assert.equal(typeof text, 'string', `${key}/${locale}`)
      assert.match(text as string, /\{p0\}/, `${key}/${locale}: a placeholder was lost`)
    }
    // English without Cyrillic: the same rule as for the rest of the dictionary.
    assert.doesNotMatch(pair.en as string, /[А-Яа-яЁё]/, key)
  }
  // The live line names both the step number and how long the wait has been: one is not enough.
  for (const key of ['room.oracle.progress', 'room.oracle.stalled']) {
    for (const locale of ['ru', 'en'] as const) {
      assert.match(roomMessages[key][locale] as string, /\{p1\}/, `${key}/${locale}`)
    }
  }
})

test('the live line and the model silence read as words, not keys', () => {
  assert.equal(translate('ru', 'room.oracle.progress', { p0: 7, p1: '1 мин 40 с' }), 'шаг 7 · 1 мин 40 с')
  assert.equal(translate('en', 'room.oracle.progress', { p0: 7, p1: '1m 40s' }), 'step 7 · 1m 40s')
  assert.match(translate('ru', 'room.oracle.stalled', { p0: 7, p1: '2 мин' }), /ждём ответа модели уже 2 мин/)
  assert.match(translate('en', 'room.oracle.stalled', { p0: 7, p1: '2m' }), /waiting for the model for 2m/)
})

/* ------------------------------------------------------------- step time */

/** Live: `stepAt` and `since` from the component itself, not a copy of them here. */
function relativeTimeOf(createdAt: number): (step: unknown) => string {
  const source = read(TURN)
  const ast = parse(source, { modern: true })
  const body = (ast.instance!.content as { body: unknown[] }).body as any[]
  const pick = (name: string): string => {
    const node = body.find((n: any) => n.type === 'FunctionDeclaration' && n.id?.name === name)
    assert.ok(node, `did not find the function ${name} in the component`)
    return source.slice(node.start!, node.end!)
  }
  const js = ts.transpileModule(`${pick('stepAt')}\n${pick('since')}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return runInNewContext(`${js}; since`, { tr, spell, entry: { createdAt } }) as (
    step: unknown,
  ) => string
}

test('a step row has its own time, from the start of the turn, and it shows where the turn stalled', () => {
  const start = 1_700_000_000_000
  const since = relativeTimeOf(start)
  setLocaleResolver(() => 'ru')
  assert.equal(since({ kind: 'read', at: start + 12_000 }), '+12 с')
  assert.equal(since({ kind: 'run', at: start + 130_000 }), '+2 мин 10 с')
  // Eleven minutes between steps is exactly what the column exists for.
  assert.equal(since({ kind: 'run', at: start + 790_000 }), '+13 мин 10 с')
  setLocaleResolver(() => 'en')
  assert.equal(since({ kind: 'read', at: start + 12_000 }), '+12s')
  assert.equal(since({ kind: 'run', at: start + 130_000 }), '+2m 10s')
})

test('a step without a time shows nothing, and neither does a "+0 s" one', () => {
  const start = 1_700_000_000_000
  const since = relativeTimeOf(start)
  // Turns recorded before the field existed: there is nowhere to take their time from.
  assert.equal(since({ kind: 'read', target: 'train.py' }), '')
  assert.equal(since({ kind: 'read', at: null }), '')
  assert.equal(since({ kind: 'read', at: Number.NaN }), '')
  // The first steps follow one another: "+0 s" would stand at each and mean nothing.
  assert.equal(since({ kind: 'read', at: start }), '')
  assert.equal(since({ kind: 'read', at: start + 400 }), '')
  assert.equal(since({ kind: 'read', at: start + 1_000 }), '+1 с')
})

/* ------------------------------------------------ the feed and its bottom */

test('the run summary is shown: it had an unreachable branch', () => {
  const turn = code(read(TURN))
  /*
   * The `{:else if step.note}` branch comes after `{:else if step.kind === 'run'}`,
   * so for a run it never executed: "did not finish within 90 s" and the output
   * tail — the only things that explain exit code 124 — were never shown.
   */
  assert.match(turn, /step\.kind === 'run' && step\.note/, 'a run has its own summary branch')
  const at = turn.indexOf("step.kind === 'run' && step.note")
  const block = turn.slice(at, at + 400)
  assert.match(block, /\{step\.note\}/, 'and it prints the summary itself')
  assert.match(block, /text-muted/, 'in the same muted style as the other summaries')
  // The output tail can be long: it scrolls within itself instead of growing the turn.
  assert.match(block, /max-h-\d+ overflow-y-auto/, 'a long tail does not grow the turn')
})

test('the bottom of the feed is the step number and a growing figure, not just a spinner', () => {
  const turn = code(read(TURN))
  assert.doesNotMatch(turn, /room\.ui\.550/, '"preparing the next step" tells nothing any more')
  assert.match(turn, /room\.oracle\.progress/, 'the step number and how long so far')
  assert.match(turn, /room\.oracle\.stalled/, 'and the words about a prolonged silence')
  assert.match(turn, /animate-spin/, 'the spinner stays: it says "running", the figure says "how long"')
})

test('the clock ticks once a second and is removed when the turn ends', () => {
  const turn = read(TURN)
  assert.match(turn, /setInterval\(\(\) => \(now = Date\.now\(\)\), 1000\)/, 'once a second')
  assert.match(turn, /return \(\) => clearInterval\(timer\)/, 'the timer cleans up after itself')
  // The derived value itself turns the effect off: a finished turn has no clock.
  assert.match(turn, /if \(!working\) return/, 'the clock runs only for a live task')
  assert.match(
    turn,
    /const working = \$derived\(streaming && !pending && entry\.mode === 'agent'\)/,
    'a promise row from ask-outbox does not get a stopwatch',
  )
})

test('the silence threshold is two minutes, and it is written as a number, not guessed', () => {
  const turn = read(TURN)
  const threshold = /const STALLED_MS = ([\d_]+)/.exec(turn)
  assert.ok(threshold, 'the silence threshold is declared')
  assert.equal(Number(threshold![1].replaceAll('_', '')), 120_000)
  assert.match(turn, /const stalled = \$derived\(waited >= STALLED_MS\)/)
})

test('"Stop" sits next to the counter and stays one button', () => {
  const turn = code(read(TURN))
  // Two copies of the button would drift apart at the first change to the rights: there is one.
  assert.equal((turn.match(/onclick=\{onstop\}/g) ?? []).length, 1, '"Stop" is declared once')
  assert.match(turn, /\{#snippet stopButton\(/, 'and moved out into a snippet')
  const footer = turn.slice(turn.indexOf('room.oracle.progress'))
  assert.match(
    footer.slice(0, 400),
    /\{@render stopButton\(/,
    'in the live line "Stop" sits next to the figure',
  )
  // Under a question the button stays where it was.
  assert.match(turn, /\{#if streaming && !working\}[\s\S]{0,200}\{@render stopButton\('self-start'\)\}/)
})

test('the feed knows every step kind and does not stay silent about an unknown one', () => {
  const kinds = /export type StepKind =([^\n]+)/.exec(read(NOTEBOOK))
  assert.ok(kinds, 'the list of step kinds is in place')
  const names = [...kinds![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(names.includes('new'), 'create_notebook writes a "created" step')
  const turn = read(TURN)
  for (const kind of names) {
    assert.match(turn, new RegExp(`get ${kind}\\(\\)`), `${kind}: no word in the feed`)
    assert.match(turn, new RegExp(`^\\s+${kind}: '`, 'm'), `${kind}: no icon in the feed`)
  }
  // A kind the tab does not know yet is drawn with the word from the document: the
  // server and the browser update separately, and a silent row lies more than a bare word.
  assert.match(turn, /VERB\[step\.kind\] \?\? step\.kind/)
  assert.match(turn, /STEP_ICON\[step\.kind\] \?\? 'info'/)
})

/* ------------------------------------------------------------- history */

test('an oracle work step is named in both languages and goes into "Detailed"', () => {
  const pair = activityMessages['activity.oracle.work_step']
  assert.ok(pair, 'the new event kind has a caption')
  assert.ok(pair.ru && pair.en, 'both captions')
  assert.doesNotMatch(pair.en as string, /[А-Яа-яЁё]/)
  assert.notEqual(pair.ru, pair.en)
  assert.equal((ACTIVITY_KIND_LEVEL as Record<string, string>)['oracle.work_step'], 'detailed')
  // Filtering by section reads the kind prefix: "oracle." is the Oracle.
  assert.match('oracle.work_step', /^oracle\./)
  assert.ok(activityMessages['activity.tool'], 'a caption for the tool name')
  assert.doesNotMatch(activityMessages['activity.tool'].en as string, /[А-Яа-яЁё]/)
})

test('a history row names the tool and the outcome, and only for a work step', () => {
  const history = code(read(HISTORY))
  assert.match(history, /const WORK_STEP = 'oracle\.work_step'/)
  /*
   * `subjectId` is a shared field: for a walkthrough it holds the draft owner, and
   * printing it in every row would mean showing someone else's id instead of a name.
   */
  assert.match(history, /event\.kind === WORK_STEP \? \(event\.details\.subjectId \?\? ''\) : ''/)
  const row = history.slice(history.indexOf('{#if tool ||'), history.indexOf('</small>'))
  assert.match(row, /\{#if tool\}<code>\{tool\}<\/code>\{\/if\}/, 'the tool name in the row')
  assert.match(row, /activity\.outcome\.\$\{event\.details\.outcome\}/, 'and the outcome next to it')
  assert.match(
    history,
    /detail\.kind === WORK_STEP && detail\.details\.subjectId[\s\S]{0,120}activity\.tool/,
    'in the details the tool is named on a separate line',
  )
})

/* ----------------------------------------------------------- no Russian */

test('neither the feed nor the history has a single Russian string right in the markup', () => {
  for (const file of [TURN, HISTORY]) {
    const ast = parse(read(file), { modern: true })
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object' || node.type === 'Comment') return
      if (node.type === 'Text') assert.doesNotMatch(node.data, /[А-Яа-яЁё]/, `${file}: ${node.data}`)
      for (const [key, value] of Object.entries(node)) {
        if (['css', 'instance', 'module', 'comments', 'loc'].includes(key)) continue
        if (Array.isArray(value)) value.forEach(walk)
        else if (value && typeof value === 'object') walk(value)
      }
    }
    walk(ast.fragment)
  }
})
