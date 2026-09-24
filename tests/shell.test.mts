/**
 * The shell: the addresses by which people get here, and what the browser
 * remembers between visits.
 *
 * There are no screens or sockets here — only three functions that have one
 * thing in common: when they break, they do not fail the build but quietly
 * change where a person ends up. A regex that stopped recognizing the console
 * key drops the tablet onto the entry screen with a live key in the address
 * bar — on the projector; an identity map that lost an entry sends a student
 * to introduce themselves again in the middle of class. Until now no test
 * caught either: tests/identity and tests/persistence, despite their names,
 * test the server.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signHandoffToken } from '../server/src/auth.js'
import { OPEN_ROOM } from '../shared/rules.js'
import { handoffLanding, isAdminPath, readCourseId, readPublicRoute, readRoomRoute } from '../web/src/lib/routes.js'
import { forgetIdentity, loadIdentity, loadProfile, saveIdentity } from '../web/src/lib/identity.js'
import {
  forgetSessionInfo,
  recallSessionInfo,
  rememberSessionInfo,
} from '../web/src/lib/persistence.svelte.js'

/*
 * Browser storage, which Node does not have. The modules read it only inside
 * functions, so a fake installed before the first test is enough.
 */
class MemoryStorage {
  #map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value)
  }
  removeItem(key: string): void {
    this.#map.delete(key)
  }
  clear(): void {
    this.#map.clear()
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

/* ------------------------------------------------------------ addresses */

test('a seminar link is the room and nothing more', () => {
  assert.deepEqual(readRoomRoute('/s/kf3n8q2p'), {
    id: 'kf3n8q2p',
    mode: 'room',
    handoffKey: null,
    cellId: null,
  })
  // A trailing slash is the same link: mail clients append it.
  assert.deepEqual(readRoomRoute('/s/kf3n8q2p/'), {
    id: 'kf3n8q2p',
    mode: 'room',
    handoffKey: null,
    cellId: null,
  })
})

test('the council console is the same room and one of its cells', () => {
  /*
   * The cell is IN THE ADDRESS, not in the window state: the console is
   * opened as a separate window, the window survives a reload, and after it
   * the window must return to the same stack. A notebook can have several
   * council cells.
   */
  assert.deepEqual(readRoomRoute('/s/kf3n8q2p/council/cell-04'), {
    id: 'kf3n8q2p',
    mode: 'council',
    handoffKey: null,
    cellId: 'cell-04',
  })
  assert.equal(readRoomRoute('/s/kf3n8q2p/council/cell-04/')?.cellId, 'cell-04')
  // Without a cell this is not the council console but a nonexistent
  // address: showing a stack at random means one day showing the wrong one.
  assert.equal(readRoomRoute('/s/kf3n8q2p/council'), null)
  assert.equal(readRoomRoute('/s/kf3n8q2p/council/'), null)
  // A cell in a foreign alphabet does not pass for an address.
  assert.equal(readRoomRoute('/s/kf3n8q2p/council/../secret'), null)
  // The other screens have no cell at all.
  assert.equal(readRoomRoute('/s/kf3n8q2p/pult')?.cellId, null)
  assert.equal(readRoomRoute('/s/kf3n8q2p')?.cellId, null)
})

test('the projection and the console are the same room, a different screen', () => {
  assert.equal(readRoomRoute('/s/kf3n8q2p/screen')?.mode, 'screen')
  assert.equal(readRoomRoute('/s/kf3n8q2p/pult')?.mode, 'pult')
  assert.equal(readRoomRoute('/s/kf3n8q2p/screen')?.id, 'kf3n8q2p')
})

test('a console key signed by the server is recognized in full', () => {
  /*
   * The very case this file was set up for: the key's alphabet is defined by
   * `signHandoffToken` (base64url joined by dots), and the regex here
   * recognizes it. They can drift apart silently — the tablet then lands on
   * the entry screen, and the key stays in the address bar.
   */
  const key = signHandoffToken('kf3n8q2p', 'p-123', 'teacher@example.edu')
  const route = readRoomRoute(`/s/kf3n8q2p/t/${key}`)
  assert.equal(route?.handoffKey, key, key)
  assert.equal(route?.mode, 'room')
  // And without the staff cookie — the key is shorter then, but of the same
  // alphabet.
  const plain = signHandoffToken('kf3n8q2p', 'p-123')
  assert.equal(readRoomRoute(`/s/kf3n8q2p/t/${plain}`)?.handoffKey, plain, plain)
})

test('the key is a suffix to ANY screen, not a fifth screen', () => {
  /*
   * "I'd like the council console to work like the lecture console: easy to
   * copy a link that contains the teacher token, open it on the phone and
   * watch everything there" — 20 Sep 2026.
   *
   * While `/t/<key>` sat in one alternation with `pult` and `council/:cell`,
   * the link `/s/:id/council/:cell/t/<key>` did not exist at all, and where to
   * go after the exchange was decided not by the address but by a hard-coded
   * string in App.
   */
  const key = signHandoffToken('kf3n8q2p', 'p-123')
  const council = readRoomRoute(`/s/kf3n8q2p/council/cell-04/t/${key}`)
  assert.equal(council?.mode, 'council')
  assert.equal(council?.cellId, 'cell-04')
  assert.equal(council?.handoffKey, key)
  const pult = readRoomRoute(`/s/kf3n8q2p/pult/t/${key}`)
  assert.equal(pult?.mode, 'pult')
  assert.equal(pult?.handoffKey, key)
  const screen = readRoomRoute(`/s/kf3n8q2p/screen/t/${key}`)
  assert.equal(screen?.mode, 'screen')
  assert.equal(screen?.handoffKey, key)
  // A trailing slash is the same address.
  assert.equal(readRoomRoute(`/s/kf3n8q2p/council/cell-04/t/${key}/`)?.cellId, 'cell-04')
  // "council/t/<key>" does not pass for a cell: there is no cell there.
  assert.equal(readRoomRoute(`/s/kf3n8q2p/council/t/${key}`), null)
})

test('after the exchange it lands where the link pointed', () => {
  /*
   * The address is replaced right after the exchange (the key is single-use,
   * and the string survives both the tab and a screenshot), and the
   * replacement must name THE SAME screen. Otherwise a link to the council
   * console would land on the lecture console, as it did before 20 Sep 2026 —
   * that is, it would open something other than what it was given for.
   */
  assert.equal(
    handoffLanding({ id: 'kf3n8q2p', mode: 'council', cellId: 'cell-04' }),
    '/s/kf3n8q2p/council/cell-04',
  )
  assert.equal(handoffLanding({ id: 'kf3n8q2p', mode: 'screen', cellId: null }), '/s/kf3n8q2p/screen')
  assert.equal(handoffLanding({ id: 'kf3n8q2p', mode: 'pult', cellId: null }), '/s/kf3n8q2p/pult')
  // A bare `/s/:id/t/<key>` is a lecture console link issued before the key
  // became a suffix to a screen: it leads to the console, not to the room.
  assert.equal(handoffLanding({ id: 'kf3n8q2p', mode: 'room', cellId: null }), '/s/kf3n8q2p/pult')
})

test('other addresses do not pass for a room', () => {
  for (const path of ['/', '/admin', '/admin/seminars', '/c/ml-2026', '/p/x9tb4kwm', '/s/']) {
    assert.equal(readRoomRoute(path), null, path)
  }
  // A suffix that does not exist: four screens is the whole list.
  assert.equal(readRoomRoute('/s/kf3n8q2p/notes'), null)
})

test('a course and a publication have their own addresses, not derived from the room address', () => {
  assert.equal(readCourseId('/c/ml-2026'), 'ml-2026')
  assert.equal(readCourseId('/c/ml-2026/'), 'ml-2026')
  assert.equal(readCourseId('/s/kf3n8q2p'), null)
  assert.deepEqual(readPublicRoute('/p/x9tb4kwm'), { id: 'x9tb4kwm', step: null })
  assert.deepEqual(readPublicRoute('/p/x9tb4kwm/3'), { id: 'x9tb4kwm', step: 3 })
  // A "step from the end" is supported by neither `readStep`, nor the rail,
  // nor the export, and nothing produces links with a minus: such an address
  // is not a step but garbage, and the router no longer passes it off as a
  // step.
  assert.equal(readPublicRoute('/p/x9tb4kwm/-1'), null)
  assert.equal(readPublicRoute('/c/ml-2026'), null)
})

test('the panel is recognized by its prefix, not by the start of a word', () => {
  assert.equal(isAdminPath('/admin'), true)
  assert.equal(isAdminPath('/admin/teachers'), true)
  assert.equal(isAdminPath('/administrators'), false)
  assert.equal(isAdminPath('/s/kf3n8q2p'), false)
})

/* ----------------------------------------------------------- identities */

const IDENTITY = {
  sessionId: 'kf3n8q2p',
  participantId: 'p-1',
  token: 'token-1',
  name: 'Ада',
  avatar: 'fox',
  color: '#123456',
  role: 'participant' as const,
}

test('an identity is remembered per room and erased one at a time', () => {
  storage.clear()
  saveIdentity(IDENTITY)
  saveIdentity({ ...IDENTITY, sessionId: 'other', participantId: 'p-2' })

  assert.equal(loadIdentity('kf3n8q2p')?.participantId, 'p-1')
  assert.equal(loadIdentity('other')?.participantId, 'p-2')

  forgetIdentity('kf3n8q2p')
  // The room's key is no longer valid — but the neighbouring seminar has
  // nothing to do with it.
  assert.equal(loadIdentity('kf3n8q2p'), null)
  assert.equal(loadIdentity('other')?.participantId, 'p-2')
  // The name stays: one has to introduce oneself again, but not retype it.
  assert.equal(loadProfile().name, 'Ада')
})

test('forgetting what is not there is not an error', () => {
  storage.clear()
  forgetIdentity('kf3n8q2p')
  assert.equal(loadIdentity('kf3n8q2p'), null)
})

test('a corrupted entry means "we remember no one", not a crash at the entrance', () => {
  storage.clear()
  storage.setItem('colloq.identity.v1', '{not json')
  assert.equal(loadIdentity('kf3n8q2p'), null)
  // And one can still write over the garbage.
  saveIdentity(IDENTITY)
  assert.equal(loadIdentity('kf3n8q2p')?.token, 'token-1')
})

/* ----------------------------------------------------------------- room card */

const ROOM = {
  id: 'kf3n8q2p',
  name: 'Регуляризация',
  createdAt: 1_700_000_000_000,
  rules: { ...OPEN_ROOM },
  finishedAt: null,
  published: null,
  course: null,
  institution: 'HSE University · Faculty of Computer Science',
}

test('the room card survives a visit and is updated on rename', () => {
  storage.clear()
  assert.equal(recallSessionInfo('kf3n8q2p'), null)

  rememberSessionInfo(ROOM)
  assert.equal(recallSessionInfo('kf3n8q2p')?.name, 'Регуляризация')

  rememberSessionInfo({ ...ROOM, name: 'Регуляризация и отбор' })
  assert.equal(recallSessionInfo('kf3n8q2p')?.name, 'Регуляризация и отбор')

  forgetSessionInfo('kf3n8q2p')
  assert.equal(recallSessionInfo('kf3n8q2p'), null)
})

test('rules and publication are updated in the card the same way as the name', () => {
  /*
   * The room's first frame is drawn from this card, and a rule left in it
   * since last semester enables buttons the person is no longer allowed. A
   * check comparing by name let exactly this slip through.
   */
  storage.clear()
  rememberSessionInfo(ROOM)

  const locked = { ...ROOM, rules: { ...OPEN_ROOM, edit: 'host' as const } }
  rememberSessionInfo(locked)
  assert.equal(recallSessionInfo('kf3n8q2p')?.rules.edit, 'host')

  rememberSessionInfo({ ...locked, published: { id: 'x9tb4kwm', steps: 12 } })
  assert.equal(recallSessionInfo('kf3n8q2p')?.published?.id, 'x9tb4kwm')
})

test('a card written before the organization line is read without it', () => {
  /*
   * The line appeared later than the cards already sitting in browsers, and
   * the old one simply does not have it. `undefined` would make it to the
   * layout, where a separator would hang next to the logo with nothing beside
   * it — the same place where a neighbouring `finishedAt` once put out a live
   * room. Not knowing here means "no organization set".
   */
  storage.clear()
  const old: Record<string, unknown> = { ...ROOM }
  delete old.institution
  storage.setItem('colloq.room.v1', JSON.stringify({ kf3n8q2p: old }))
  assert.equal(recallSessionInfo('kf3n8q2p')?.institution, '')
})

test('corrupted storage — the room is simply unknown', () => {
  storage.clear()
  storage.setItem('colloq.room.v1', 'null}')
  assert.equal(recallSessionInfo('kf3n8q2p'), null)
  rememberSessionInfo(ROOM)
  assert.equal(recallSessionInfo('kf3n8q2p')?.id, 'kf3n8q2p')
})
