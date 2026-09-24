/**
 * The oracle ceiling field is the only rules control where the value is TYPED.
 *
 * Everything else in the list is a switch: pressed, and the rule either got
 * through or it did not. A number has two extra states, and both are quiet:
 * the browser hands over unparsable input ("5e") as an empty string — that is,
 * "as on the instance" — and a failed save leaves a number in the field that
 * the room does not have. Neither can be seen by eye: the field looks just as
 * correct.
 *
 * It is read straight from the component, as in `panels-craft`: markup on
 * runes has neither a pure function nor a browser, and a test with its own
 * copy of the rule passes forever while the file drifts away. So this checks
 * ORDER — what comes before what — rather than a retelling of behaviour.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const RULES = 'web/src/components/RoomRulesRows.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Code without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const source = code(read(RULES))
const commit = source.slice(source.indexOf('function commit('), source.indexOf('</script>'))
const effect = source.slice(source.indexOf('$effect(() => {'), source.indexOf('function commit('))

test('garbage in the number field is not read as "as on the instance"', () => {
  const bad = commit.indexOf('field.validity.badInput')
  const empty = commit.indexOf('if (!text)')
  assert.ok(bad > 0, 'badInput is checked at all')
  assert.ok(bad < empty, 'and checked BEFORE the "empty → null" branch, otherwise "5e" removes the ceiling')

  const guard = commit.slice(bad, empty)
  assert.match(guard, /field\.value = current === null \? '' : String\(current\)/)
  assert.doesNotMatch(guard, /onchange/, 'garbage saves nothing')
})

test('clamping is visible before the server answers: the number lands in the field before the request', () => {
  const tail = commit.slice(commit.indexOf('const value = Math.min'))
  const put = tail.indexOf('field.value = String(value)')
  const send = tail.indexOf('onchange(')
  assert.ok(put > 0, 'the clamped number is put into the field')
  assert.ok(put < send, '"500" → "200" shows at once, not after a round trip to the server')
})

test('the field goes back to the saved value only once the save has ANSWERED', () => {
  // The caller (`setRule` in SessionScreen and in admin/Seminars) raises busy
  // synchronously, before the request: an effect that fires on any change of
  // busy catches the old `rules` on the rise and wipes the number just typed.
  assert.doesNotMatch(effect, /void busy/, 'the effect is not woken by busy rising')
  assert.match(effect, /const answered = saving && !busy/, 'the comparison happens as busy falls')
  assert.match(effect, /saving = busy/, 'and the fall is remembered for the next frame')

  const guard = effect.indexOf('if (!answered) return')
  const write = effect.indexOf('field.value = want')
  assert.ok(guard > 0, 'without an answer the effect returns')
  assert.ok(guard < write, 'the write to the field is unreachable while the save is in flight')
})

test('both callers raise busy before the request: the fall rests on that', () => {
  for (const rel of ['web/src/screens/SessionScreen.svelte', 'web/src/admin/screens/Seminars.svelte']) {
    const set = code(read(rel))
    const fn = set.slice(set.indexOf('async function setRule('))
    const raise = fn.indexOf('rulesBusy = true')
    const request = fn.indexOf('await ')
    const drop = fn.indexOf('rulesBusy = false')
    assert.ok(raise >= 0 && request > raise, `${rel}: busy is raised before the request`)
    assert.ok(drop > request, `${rel}: and dropped after the answer, on success and on refusal alike`)
  }
})
