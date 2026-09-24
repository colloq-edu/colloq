/**
 * Placeholders on the teacher screens: what stands in place of the numbers
 * while they are on their way.
 *
 * The "Resources" section is fed by the machine's answer, and before the
 * answer it showed an EMPTY, enabled memory field: it invited typing a
 * moment before the arriving number would erase what was typed, and the
 * hint under it was an empty line. Checked here is exactly what gets rolled
 * back in one line without breaking any other test: that before the answer
 * placeholders stand in place of the fields, that there is no empty enabled
 * field in any state, that a failure is stated in words, and that the
 * "Create class" button cannot be pressed until the form knows what it will
 * send.
 *
 * It is read straight from the components, as in `panels-craft.test.mts`
 * and `screens-craft.test.mts`: a test with its own copy of the rule passes
 * forever while the file drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adminMessages } from '../shared/locales/admin.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const RESOURCES = 'web/src/admin/ui/Resources.svelte'
const NEW_SEMINAR = 'web/src/admin/screens/NewSeminar.svelte'
const SEMINARS = 'web/src/admin/screens/Seminars.svelte'
const SKELETON = 'web/src/components/ui/Skeleton.svelte'

/** The whole `{#if loading}` branch, from it to the `{:else}` of the same level. */
function loadingBranch(source: string): string {
  const start = source.indexOf('{#if loading}')
  assert.notEqual(start, -1, 'the waiting branch exists')
  const end = source.indexOf('\n  {:else}', start)
  assert.notEqual(end, -1, 'the waiting branch has a continuation')
  return source.slice(start, end)
}

/* ---------------------------------------------- fields under a placeholder */

test('while resources are on their way, placeholders stand in place of the memory and core fields, not empty fields', () => {
  const resources = code(read(RESOURCES))
  const waiting = loadingBranch(resources)
  // Two fields, memory and cores, both under a placeholder as tall as the real field.
  const fields = [...waiting.matchAll(/<Skeleton[^/]*height=\{FIELD_H\}/g)]
  assert.equal(fields.length, 2, 'a placeholder for both memory and cores')
  // Not a single input in this branch: an empty enabled field is an
  // invitation to type into what the server's answer will overwrite a moment
  // later.
  assert.doesNotMatch(waiting, /<input/, 'there are no input fields at all before the answer')
  // Bars and hints too, otherwise the section jumps when the numbers arrive.
  assert.match(waiting, /hintLines\(/, 'the hints took their lines')
  assert.match(waiting, /height="4px"/, 'the used-memory bar is in place')
})

test('placeholder sizes come from shared numbers, not written into each one in place', () => {
  const resources = read(RESOURCES)
  // One number for all fields and one for all hint lines: they can drift
  // only together, and then the jump is visible to the eye.
  assert.match(resources, /const FIELD_H = '38px'/, 'the field height is one number')
  assert.match(resources, /const HINT_LINE = 18\b/, 'the hint line height is one number')
  const waiting = loadingBranch(code(resources))
  // And the fields take their height from there instead of copying the
  // number: a pair of "38px" in the markup and "38px" in the constant drifts
  // apart at the very first font-size edit.
  assert.doesNotMatch(waiting, /height="38px"/, 'the field does not carry its own copy of the height')
  assert.doesNotMatch(waiting, /height="18px"/, 'nor does the hint line')
})

test('the section waits for an answer only while the answer is on its way, not when it will never come', () => {
  const resources = code(read(RESOURCES))
  // `null` meant both "we do not know yet" and "we asked and did not find out". A flag separates them.
  assert.match(resources, /loading\?: boolean/, 'waiting is a separate property')
  assert.match(resources, /const unreadable = \$derived\(!resources && !loading\)/, 'a failure is not waiting')
})

/* --------------------------------------------------------- machine failure */

test('the machine did not answer: the fields stay, and that is said in words', () => {
  const resources = code(read(RESOURCES))
  assert.match(resources, /admin\.resources\.unreadable/, 'the failure line stands under the fields')
  // The field does not stay a mute empty frame: the hint inside says the room
  // will get the default.
  const placeholders = [...resources.matchAll(/placeholder=\{unreadable \? tr\('admin\.resources\.asDefault'\)/g)]
  assert.equal(placeholders.length, 2, 'a hint inside both fields')
  for (const key of ['admin.resources.unreadable', 'admin.resources.asDefault', 'admin.resources.reading']) {
    const pair = adminMessages[key]
    assert.ok(pair && pair.ru && pair.en, `${key} is translated into both languages`)
  }
})

/* ----------------------------------------------------- running shimmer */

test('under "reduce motion" the placeholder stops running rather than disappearing', () => {
  const skeleton = read(SKELETON)
  const reduced = skeleton.slice(skeleton.indexOf('prefers-reduced-motion'))
  assert.match(reduced, /animation:\s*none/, 'the shimmer stands still')
  // The block itself stays: it holds the size, and without it the section collapses.
  assert.match(reduced, /\.skeleton::after/, 'the shimmer is turned off, not the placeholder')
  // The shimmer moves by transform: it runs on EVERY frame of waiting, and
  // moving it by `left` or `background-position` means laying out the page
  // again the whole time it is already busy with the server's answer.
  const running = skeleton.slice(0, skeleton.indexOf('prefers-reduced-motion'))
  assert.match(running, /transform:\s*translateX\(-100%\)/, 'the shimmer sits on the left by transform')
  assert.match(running, /@keyframes shimmer\s*\{\s*to\s*\{\s*transform:\s*translateX\(100%\)/, 'and leaves by it too')
})

/* ----------------------------------------------- the button and the reads */

test('"Create class" cannot be pressed until the form knows what it will send', () => {
  const form = code(read(NEW_SEMINAR))
  assert.match(
    form,
    /const settling = \$derived\(environmentsLoading \|\| oracleLoading \|\| resourcesLoading\)/,
    'all three reads are awaited: environments, the oracle ceiling, resources',
  )
  assert.match(form, /!busy &&\s*\n\s*!settling &&/, 'the button waits along with them')
  // The flag goes off both on success and on failure: there is nothing to
  // wait for from someone who has already said "no", otherwise the button
  // never comes alive.
  const finallies = [...form.matchAll(/\.finally\(\(\) => \((?:environments|oracle|resources)Loading = false\)\)/g)]
  assert.equal(finallies.length, 3, 'each read turns off its own flag')
})

test('the environment list also waits under a placeholder, not an empty line', () => {
  const form = code(read(NEW_SEMINAR))
  const start = form.indexOf('{#if environmentsLoading}')
  assert.notEqual(start, -1, 'the list has a waiting state')
  const waiting = form.slice(start, form.indexOf('{:else if environments'))
  assert.match(waiting, /<Skeleton/, 'the environment card is drawn as a placeholder')
  assert.match(waiting, /h-\[45px\]/, 'the name line takes its height')
})

test('the class settings window waits for the answer the same way as the form', () => {
  const list = code(read(SEMINARS))
  assert.match(list, /loading=\{resourcesLoading\}/, 'the same section gets the same flag')
  // Rereading after saving happens under the numbers already drawn: there is
  // no reason to blink the section on every memory change.
  assert.match(list, /resourcesLoading = resources === null/, 'placeholders only on the first read')
  assert.match(list, /\.finally\(\(\) => \(resourcesLoading = false\)\)/, 'a failure ends the waiting')
})
