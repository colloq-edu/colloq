/**
 * LOG_FORMAT=json, and the text log it must leave exactly as it was.
 *
 * A bank's platform ships stdout into Loki or ELK, which cut the stream at
 * line breaks: a stack trace in the text log arrives there as a dozen
 * unrelated entries. With LOG_FORMAT=json every console call of the server is
 * one JSON object on one line. The text log stays the default, byte for byte,
 * because people and scripts (`colloq logs`, grep in the docs) read it.
 *
 * log.ts patches console the moment it loads, so each mode runs in a process
 * of its own and the test reads what really reached stdout and stderr.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { jsonLine } from '../server/src/log.ts'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-log-format-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const BANNER = [
  '',
  '  ┌ nobody owns this Colloq yet',
  '  │ open  http://localhost:3000/admin/t/SETUP-TOKEN-0123456789',
  '  └ the token alone is in data/setup-token (0600).',
  '',
].join('\n')

const script = path.join(dir, 'speak.mts')
fs.writeFileSync(
  script,
  `const log = await import(${JSON.stringify(path.join(repo, 'server/src/log.ts'))})
const { logWith } = await import(${JSON.stringify(path.join(repo, 'server/src/log-fields.ts'))})
console.log('[db] opened', 42, { a: 1 })
console.info('plain words')
console.warn('[net] careful: 50%d is not a format here', 7)
const failure = new Error('boom')
failure.stack = 'Error: boom\\n    at first (a.ts:1:1)\\n    at second (b.ts:2:2)'
console.error('[http] unhandled error on GET /x:', failure.stack)
console.debug('[kernel abc/cells] up (base, room)')
log.tally('frames', 12)
log.tally('oracle', 2)
log.startJournal(() => ({ rooms: 2, people: 41, kernels: { live: 2, busy: 1, dead: 0 } }))
log.journalMinute()
log.stopJournal()
logWith('log', { bytes: 1024 }, '[db] with a field')
console.log('[db] without one')
console.log(${JSON.stringify(BANNER)})
`,
)

function speak(format: string | undefined): { out: string[]; err: string[] } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, LOG_FORMAT: format ?? '' },
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  const lines = (text: string) => text.split('\n').filter((line) => line !== '')
  return { out: lines(r.stdout), err: lines(r.stderr) }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

test('LOG_FORMAT=json: every console call is one JSON line with time, level and msg, on the stream it always used', () => {
  const { out, err } = speak('json')
  const parsed = (lines: string[]) =>
    lines.map((line) => {
      assert.doesNotThrow(() => JSON.parse(line), `not one JSON object: ${line}`)
      return JSON.parse(line) as Record<string, unknown>
    })
  const stdout = parsed(out)
  const stderr = parsed(err)
  for (const entry of [...stdout, ...stderr]) {
    assert.match(String(entry.time), ISO)
    assert.ok(['info', 'warn', 'error', 'debug'].includes(String(entry.level)), `level ${entry.level}`)
    assert.equal(typeof entry.msg, 'string')
  }
  // log, info, debug, the summary, two field lines and the banner on stdout;
  // warn and error on stderr, one line each even for a multi-line stack.
  assert.equal(stdout.length, 7, out.join('\n'))
  assert.equal(stderr.length, 2, err.join('\n'))

  const [opened, plain, debug, minute, withField, withoutField, banner] = stdout
  assert.deepEqual(
    { level: opened.level, msg: opened.msg, component: opened.component },
    { level: 'info', msg: '[db] opened 42 { a: 1 }', component: 'db' },
  )
  assert.equal(plain.msg, 'plain words')
  assert.equal(plain.component, undefined, 'no brackets, no component')
  assert.equal(debug.level, 'debug')
  assert.equal(debug.component, 'kernel')

  const [warning, error] = stderr
  assert.equal(warning.level, 'warn')
  // Formatted as the text log formats it: the message is never a format string.
  assert.equal(warning.msg, '[net] careful: 50%d is not a format here 7')
  assert.equal(error.level, 'error')
  assert.equal(error.msg, '[http] unhandled error on GET /x: Error: boom\n    at first (a.ts:1:1)\n    at second (b.ts:2:2)')

  // The minute summary: the same words, and its numbers as keys.
  assert.equal(minute.component, 'minute')
  assert.equal(minute.msg, '[minute] rooms 2 · people 41 · kernels 2 live (1 busy) · frames 12 · oracle failed 2')
  assert.equal(minute.rooms, 2)
  assert.equal(minute.people, 41)
  assert.equal(minute.kernelsLive, 2)
  assert.equal(minute.kernelsBusy, 1)
  assert.equal(minute.kernelsDead, 0)
  assert.equal(minute.frames, 12)
  assert.equal(minute.oracleFailed, 2)
  assert.equal(minute.aborted, 0)

  // Fields belong to their own line and never stick to the next one.
  assert.equal(withField.bytes, 1024)
  assert.equal(withoutField.msg, '[db] without one')
  assert.equal(withoutField.bytes, undefined)

  // The first-run banner stays one message: nothing lifts the token out of it.
  assert.equal(banner.msg, BANNER)
  assert.deepEqual(Object.keys(banner).sort(), ['level', 'msg', 'time'])
})

test('without LOG_FORMAT the text log is what it always was: the time, a space, the words', () => {
  const { out, err } = speak(undefined)
  const words = (line: string) => {
    const [time, ...rest] = line.split(' ')
    assert.match(time, ISO, `no timestamp first: ${line}`)
    return rest.join(' ')
  }
  assert.equal(words(out[0]), '[db] opened 42 { a: 1 }')
  assert.equal(words(out[1]), 'plain words')
  assert.equal(words(out[2]), '[kernel abc/cells] up (base, room)')
  assert.equal(words(out[3]), '[minute] rooms 2 · people 41 · kernels 2 live (1 busy) · frames 12 · oracle failed 2')
  assert.equal(words(out[4]), '[db] with a field', 'a field is JSON-only; the text line carries the words alone')
  assert.equal(words(out[5]), '[db] without one')
  assert.ok(!out.some((line) => line.trimStart().startsWith('{')), 'a JSON line in the text log')
  assert.equal(words(err[0]), '[net] careful: 50%d is not a format here 7')
  // A stack keeps its line breaks in the text log, as before.
  assert.equal(words(err[1]), '[http] unhandled error on GET /x: Error: boom')
  assert.equal(err[2], '    at first (a.ts:1:1)')
  // The banner prints as the multi-line block it is.
  assert.ok(out.join('\n').includes(BANNER.trim()), 'the banner is not printed whole')
})

test('LOG_FORMAT is read case-insensitively and anything but json means text', () => {
  const upper = speak(' JSON ')
  assert.doesNotThrow(() => JSON.parse(upper.out[0]))
  const other = speak('logfmt')
  assert.match(other.out[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[db\] opened/)
})

test('a JSON line keeps its own keys whatever the fields say, and survives a field JSON cannot write', () => {
  const line = JSON.parse(jsonLine('2026-09-30T10:00:00.000Z', 'info', ['[db] x'], { time: 'forged', level: 'error', msg: 'forged', extra: 1 }))
  assert.deepEqual(line, { time: '2026-09-30T10:00:00.000Z', level: 'info', msg: '[db] x', component: 'db', extra: 1 })
  const odd = JSON.parse(jsonLine('2026-09-30T10:00:00.000Z', 'warn', ['odd'], { big: 1n as unknown as number }))
  assert.deepEqual(odd, { time: '2026-09-30T10:00:00.000Z', level: 'warn', msg: 'odd' })
})
