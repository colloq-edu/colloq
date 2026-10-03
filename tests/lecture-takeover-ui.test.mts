/**
 * Taking the lecture over — the browser half.
 *
 * The server half (lecture-take) checks what the wire does. Here: that the
 * room and the console ask it the right way and say the right words, which
 * is where the findings came from. A second browser of the same teacher read
 * "presented by Ada" about Ada herself with nothing to press; the console's
 * "Take control" went into the offline queue and restarted a finished
 * lecture; the old console lost its pen mid-stroke without a word; a holder
 * who closed the lid stayed "presenting" forever.
 *
 * The rules live in takeover.ts and are tested as functions; the screens are
 * checked by reading their sources, so that a second, silent copy of a rule
 * does not grow back next to the shared one.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import type { LectureState } from '../shared/lecture.js'
import {
  actedAgo,
  agoWords,
  deviceLong,
  deviceOn,
  holderOf,
  lostHands,
  takeAsks,
  takeMessage,
} from '../web/src/components/lecture/takeover.js'
import { deviceKindOf } from '../web/src/lib/device.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Code without comments: an explanation is not a promise. */
function code(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

const base: LectureState = {
  file: 'slides.pdf',
  by: 'p_ipad',
  byName: 'Ада',
  color: '#d4162f',
  page: 14,
  startedAt: 1_000,
  blank: false,
  device: { kind: 'ipad', console: true },
  byPerson: 'ada-key',
  since: 1_000,
  actedAt: 50_000,
  awaySince: null,
}

/* ------------------------------------------------------------- the rules */

test('the same teacher on another device is told apart from a colleague', () => {
  assert.equal(holderOf(base, 'ada-key').self, true)
  assert.equal(holderOf(base, 'boris-key').self, false)
  // Someone in the room by its link only is never "you" to anybody.
  assert.equal(holderOf(base, null).self, false)
  assert.equal(
    holderOf({ ...base, byPerson: null }, null).self,
    false,
    'two people without a key matched',
  )
})

test('a take-over asks again only when it interrupts somebody', () => {
  assert.equal(
    takeAsks(holderOf(base, 'boris-key')),
    true,
    'a live colleague was interrupted in one press',
  )
  assert.equal(
    takeAsks(holderOf(base, 'ada-key')),
    false,
    'oneself on another device was asked to confirm',
  )
  assert.equal(
    takeAsks(holderOf({ ...base, awaySince: 40_000 }, 'boris-key')),
    false,
    'a stale lock waits for a confirmation nobody can give',
  )
})

test('the take-over names the lecture and the holder it was pressed against', () => {
  assert.deepEqual(takeMessage(base, { kind: 'mac', console: false }), {
    t: 'lecture:take',
    file: 'slides.pdf',
    from: 'p_ipad',
    startedAt: 1_000,
    device: { kind: 'mac', console: false },
  })
})

test('losing the console is read from two states, and only a take-over counts', () => {
  const after = {
    ...base,
    by: 'p_mac',
    byName: 'Ада',
    device: { kind: 'mac' as const, console: false },
    since: 77_000,
  }
  const lost = lostHands(base, after, 'p_ipad', 'ada-key')
  assert.deepEqual(lost, {
    name: 'Ада',
    device: { kind: 'mac', console: false },
    at: 77_000,
    self: true,
    by: 'p_mac',
  })

  assert.equal(
    lostHands(base, null, 'p_ipad', 'ada-key'),
    null,
    'the end of the lecture read as a take-over',
  )
  assert.equal(
    lostHands(base, { ...after, startedAt: 2_000 }, 'p_ipad', 'ada-key'),
    null,
    'a new lecture read as a take-over',
  )
  assert.equal(
    lostHands(base, after, 'p_hall', 'ada-key'),
    null,
    'a watcher was told they lost the console',
  )
  assert.equal(
    lostHands(after, base, 'p_ipad', 'ada-key'),
    null,
    'getting it back read as losing it',
  )
  assert.equal(
    lostHands(base, { ...after, byPerson: 'boris-key', byName: 'Борис' }, 'p_ipad', 'ada-key')
      ?.self,
    false,
  )
})

test('"last action" takes the later of the server mark and what this tab heard', () => {
  // Server time 50 000; this browser runs 1 000 ms ahead of the server.
  assert.equal(actedAgo(base, 0, 1_000, 61_000), 10_000)
  assert.equal(
    actedAgo(base, 60_000, 1_000, 61_000),
    1_000,
    'a frame heard a second ago was ignored',
  )
  assert.equal(
    actedAgo({ ...base, actedAt: undefined }, 0, 0, 61_000),
    null,
    'an unknown time read as "long ago"',
  )
})

test('the words of a glance', () => {
  setLocaleResolver(() => 'ru')
  assert.equal(agoWords(12_400), '12 с')
  assert.equal(agoWords(4 * 60_000 + 5_000), '4 мин')
  assert.equal(agoWords(2 * 3_600_000), '2 ч')
  assert.equal(deviceLong({ kind: 'ipad', console: true }), 'iPad, пульт')
  assert.equal(deviceLong({ kind: 'mac', console: false }), 'Mac')
  assert.equal(deviceOn({ kind: 'windows', console: false }), 'на компьютере с Windows')
  assert.equal(deviceOn(null), 'на другом устройстве')
  setLocaleResolver(() => 'en')
  assert.equal(deviceLong({ kind: 'ipad', console: true }), 'iPad, console')
  setLocaleResolver(() => 'ru')
})

test('an iPad asking for the desktop site is still an iPad', () => {
  const mac =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  assert.equal(deviceKindOf(mac, 5), 'ipad')
  assert.equal(deviceKindOf(mac, 0), 'mac')
  assert.equal(deviceKindOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 5), 'ipad')
  assert.equal(deviceKindOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0), 'windows')
  assert.equal(deviceKindOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', 5), 'android')
  assert.equal(deviceKindOf('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari', 5), 'android-tablet')
  assert.equal(deviceKindOf('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 0), 'chromebook')
})

/* ------------------------------------------------------------ the screens */

test('a take-over is never queued without a connection', () => {
  const session = code(read('web/src/lib/session.svelte.ts'))
  const discarded =
    session.match(/const DISCARDED_OFFLINE = new Set<[^>]+>\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
  assert.match(discarded, /'lecture:take'/, 'a take-over goes into the offline queue')
})

test('the console takes over with the take-over, refuses offline, and never restarts', () => {
  const view = code(read('web/src/components/lecture/ConsoleView.svelte'))
  const grab = view.match(/function grab\(\): void \{([\s\S]*?)\n  \}/)?.[1] ?? ''
  assert.ok(grab, 'grab() is gone')
  assert.match(grab, /takeMessage\(/, 'the console does not use the take-over message')
  assert.doesNotMatch(grab, /lecture:start/, 'the console still takes over with a start')
  assert.match(grab, /if \(offline\)/, 'the console queues a take-over offline')
  // The key and the sheet's button are dead while offline, not a promise.
  assert.match(view, /data-grab[\s\S]{0,40}|disabled=\{offline\}[\s\S]{0,80}data-grab/)
  assert.match(
    view,
    /<button type="button" class="btn-primary h-12 flex-1" disabled=\{offline\} onclick=\{grab\}>/,
  )
})

test('the old console says it was taken over and offers it back', () => {
  const view = read('web/src/components/lecture/ConsoleView.svelte')
  assert.match(
    view,
    /lostHands\(seen, next, session\.me\.id, session\.person\)/,
    'the console does not notice losing the console',
  )
  assert.match(view, /\{#snippet takenNotice\(gone: Lost\)\}/)
  assert.match(
    view,
    /data-give-back[\s\S]{0,40}onclick=\{grab\}/,
    '"Take it back" is not the take-over',
  )
  assert.match(
    view,
    /room\.takeover\.takenInk/,
    'the notice does not say what happened to the line',
  )
  // Who holds it, where the turn keys were: the device for oneself, the name for a colleague.
  assert.match(view, /data-pult-holder/)
})

test('a teacher who does not lead gets the banner, the take-over and the notes', () => {
  const screen = code(read('web/src/screens/SessionScreen.svelte'))
  assert.match(
    screen,
    /role=\{leading \? 'presenter' : session\.me\.role === 'host' \? 'cohost' : 'audience'\}/,
    'a watching teacher still gets the students’ line',
  )
  assert.match(
    screen,
    /session\.setConsole\(pult\)/,
    'the server is not told when this tab is the console',
  )

  const view = code(read('web/src/components/lecture/LectureView.svelte'))
  assert.match(
    view,
    /\{:else if cohost && !hallView\}/,
    'there is no banner for a watching teacher',
  )
  assert.match(view, /data-take/)
  assert.match(view, /session\.send\(takeMessage\(lecture, session\.device\(\)\)\)/)
  assert.doesNotMatch(view, /lecture:start/, 'the room takes over with a start')
  assert.match(
    view,
    /\{#if cohost && host && notesShown && notesRoom\}/,
    'a watching teacher has no notes',
  )
  // Where the column does not fit, "Notes" opens the full editor instead of nothing.
  assert.match(view, /if \(notesRoom\) notesShown = !notesShown\s+else openNotesEditor\(/)
  assert.match(
    view,
    /lostHands\(seen, next, session\.me\.id, session\.person\)/,
    'the laptop does not notice losing the console',
  )
  // Offline is refused in words, like everything that would otherwise vanish.
  const take = view.match(/function takeOver\(\): void \{([\s\S]*?)\n  \}/)?.[1] ?? ''
  assert.match(take, /session\.connected/)
})

test('the people list draws the same teacher’s second browser as you, from the server’s word', () => {
  const panel = code(read('web/src/components/panels/PeoplePanel.svelte'))
  assert.match(panel, /session\.myDevices\.includes\(person\.user\.id\)/)
  // Not from presence: anyone can write anything into their own presence.
  assert.doesNotMatch(
    panel,
    /user\.person/,
    'the list trusts a key a tab put into its own presence',
  )
  const session = code(read('web/src/lib/session.svelte.ts'))
  assert.match(session, /message\.t === 'person:devices'\) \{\s+this\.myDevices = message\.ids/)
})

test('no Cyrillic text in the templates touched here', () => {
  for (const file of [
    'web/src/components/lecture/LectureView.svelte',
    'web/src/components/lecture/ConsoleView.svelte',
  ]) {
    const markup = read(file)
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
    const text = markup.replace(/\{[^{}]*\}/g, '').replace(/<[^>]*>/g, ' ')
    assert.doesNotMatch(text, /[А-Яа-яЁё]/, `${file} carries Russian text outside the catalog`)
  }
})
