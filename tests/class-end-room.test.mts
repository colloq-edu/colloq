/**
 * The bell in the room: «Занятие завершено» asks the teacher for the class
 * page's materials once, and says how the automatic refresh went after that.
 *
 * The first week of a course is the only time a teacher has to do anything
 * for the class page. If the question reaches a student, the projector or a
 * room outside a course, it is noise; if it opens the picker anywhere but a
 * new tab, the room with its resume button is gone from under the teacher.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, translate } from '../shared/i18n.js'
import {
  offerOf,
  pageLineOf,
  pagePickerPath,
  rowLine,
  type OfferContext,
  type PageNews,
} from '../web/src/lib/class-end.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file: string) => readFileSync(resolve(ROOT, file), 'utf8')

afterEach(() => setLocaleResolver(() => 'ru'))

const offerFrame: PageNews = {
  t: 'page',
  state: 'offer',
  course: { name: 'МЛ | сильная группа', n: 4, title: 'Лики и хаки данных', day: '2026-10-04' },
  at: 100,
}

const room: OfferContext = {
  host: true,
  inRoom: true,
  finished: true,
  published: false,
  course: 'МЛ | сильная группа',
  dismissed: 0,
}

test('the teacher in a finished course room without a page is asked, with the row it lands in', () => {
  setLocaleResolver(() => 'ru')
  assert.deepEqual(offerOf(offerFrame, room), {
    course: 'МЛ | сильная группа',
    line: '04 · Лики и хаки данных · вс, 4 окт',
  })
})

test('nobody else is asked, and nothing is asked twice or after it stopped being true', () => {
  assert.equal(offerOf(offerFrame, { ...room, host: false }), null, 'a student was asked')
  assert.equal(offerOf(offerFrame, { ...room, inRoom: false }), null, 'the console or projector was asked')
  assert.equal(offerOf(offerFrame, { ...room, finished: false }), null, 'asked after the class resumed')
  assert.equal(offerOf(offerFrame, { ...room, published: true }), null, 'asked when a page exists')
  assert.equal(offerOf(offerFrame, { ...room, dismissed: 100 }), null, '«Не сейчас» did not stick')
  // A room outside a course has nowhere to send students: no question.
  const lonely: PageNews = { t: 'page', state: 'offer', at: 5 }
  assert.equal(offerOf(lonely, { ...room, course: null }), null)
  // The next bell asks again.
  assert.ok(offerOf({ ...offerFrame, at: 200 }, { ...room, dismissed: 100 }))
  // Other states never open the dialog.
  assert.equal(offerOf({ ...offerFrame, state: 'updated' }, room), null)
})

test('the row line drops what the row does not have', () => {
  assert.equal(rowLine({ name: 'К', n: null, title: 'Каникулы', day: null }, 'ru'), 'Каникулы')
  assert.equal(rowLine({ name: 'К', n: 12, title: 'Бустинг', day: null }, 'ru'), '12 · Бустинг')
  assert.equal(rowLine({ name: 'C', n: 4, title: 'Leaks', day: '2026-10-04' }, 'en'), '04 · Leaks · Sun, Oct 4')
  assert.equal(rowLine(undefined), '')
})

test('the picker opens as the panel screen, with its way back to the room', () => {
  assert.equal(pagePickerPath('k7m2xq4b'), '/admin/publish/k7m2xq4b?from=room')
})

test('refresh lines go to the teacher until closed, and never carry the offer', () => {
  const updated: PageNews = { t: 'page', state: 'updated', address: 'ml-strong-04', materials: 4, at: 7 }
  assert.equal(pageLineOf(updated, { host: true, closed: 0 }), updated)
  assert.equal(pageLineOf(updated, { host: false, closed: 0 }), null)
  assert.equal(pageLineOf(updated, { host: true, closed: 7 }), null)
  assert.equal(pageLineOf(offerFrame, { host: true, closed: 0 }), null)
})

test('the words: four materials, the check that held the page, both languages', () => {
  assert.equal(
    translate('ru', 'room.classEnd.updated', { count: 4 }),
    'Страница занятия обновлена · 4 материала',
  )
  assert.equal(
    translate('ru', 'room.classEnd.updated', { count: 5 }),
    'Страница занятия обновлена · 5 материалов',
  )
  assert.equal(translate('en', 'room.classEnd.updated', { count: 1 }), 'Class page updated · 1 material')
  const reason = 'похоже на ключ API — «Семинар», ячейка 14'
  assert.equal(
    translate('ru', 'room.classEnd.held', { reason }),
    `Страница не обновилась: ${reason}`,
  )
  assert.equal(
    translate('ru', 'room.classEnd.offer', { course: 'МЛ | сильная группа' }),
    'Положите материалы на страницу занятия — студенты найдут её в курсе «МЛ | сильная группа».',
  )
})

test('the room draws the dialog from the rule, opens the picker in a new tab, and keeps one stack', () => {
  const screen = read('web/src/screens/SessionScreen.svelte')
  // The dialog is drawn from `offer` and nothing else.
  const start = screen.indexOf('{#if offer}')
  const dialog = screen.slice(start, screen.indexOf("tr('room.classEnd.later')", start))
  assert.ok(start > 0 && dialog.length > 0, 'the end-of-class dialog is gone')
  assert.match(dialog, /href=\{pagePickerHref\}\s+target="_blank"/, 'the picker replaces the room')
  assert.match(dialog, /onclick=\{dismissOffer\}/)
  assert.match(screen, /const pagePickerHref = \$derived\(pagePickerPath\(session\.session\.id\)\)/)
  assert.match(screen, /host: isHost,\s+inRoom: mode === 'room',\s+finished: session\.finished/)
  // The finished strip's link: for the teacher, and it says what is there.
  const from = screen.indexOf('{#if session.finished}')
  const strip = screen.slice(from, screen.indexOf("tr('room.ui.909')", from))
  assert.match(strip, /\{#if isHost\}[\s\S]*href=\{pagePickerHref\}[\s\S]*target="_blank"/)
  assert.match(strip, /session\.session\.published \? tr\('room\.classEnd\.page'\) : tr\('room\.classEnd\.publish'\)/)
  // The refresh lines live in the room's one notification stack.
  const stack = screen.slice(screen.indexOf('ONE notification stack per room'), screen.indexOf('{#snippet leftPanels()}'))
  assert.match(stack, /\{#if pageLine\}/, 'the refresh line got a stack of its own')
  // The session state turns an 'updated' frame into a page the strip knows about.
  const state = read('web/src/lib/session.svelte.ts')
  const from2 = state.indexOf("if (message.t === 'page')")
  const branch = state.slice(from2, state.indexOf('this.pageNews = { ...message', from2))
  assert.match(branch, /message\.state === 'updated'[\s\S]*published: \{ address: message\.address/)
})

test('a waiting spinner goes when the refresh will not happen', () => {
  /*
   * «Страница обновится, когда досчитаются ячейки» stayed for the rest of the
   * class after «Продолжить занятие»: the server sent nothing and the room
   * kept promising. Now the server closes it with 'cancelled', and the room
   * drops it on the resume too, whichever comes first.
   */
  const waiting: PageNews = { t: 'page', state: 'waiting', address: 'ml-strong-04', at: 3 }
  assert.equal(pageLineOf(waiting, { host: true, closed: 0 }), waiting)
  const cancelled: PageNews = { t: 'page', state: 'cancelled', at: 4 }
  assert.equal(pageLineOf(cancelled, { host: true, closed: 0 }), null)
  const state = read('web/src/lib/session.svelte.ts')
  const page = state.slice(state.indexOf("if (message.t === 'page')"))
  assert.match(page, /if \(message\.state === 'cancelled'\) \{\s*if \(this\.pageNews\?\.state === 'waiting'\) this\.pageNews = null\s*return/)
  const resumed = state.slice(state.indexOf("if (message.t === 'class')"), state.indexOf("if (message.t === 'page')"))
  assert.match(resumed, /changed && !this\.finished && this\.pageNews\?\.state === 'waiting'\) this\.pageNews = null/)
})

test('the join screen leads to the page and the course by the addresses the class was given', () => {
  const join = read('web/src/screens/JoinScreen.svelte')
  assert.match(join, /href="\/p\/\{session\.published\.address\}"/)
  assert.match(join, /href="\/c\/\{session\.course\.slug \?\? session\.course\.id\}"/)
  assert.doesNotMatch(join, /published\.steps|room\.ui\.71[345]/, 'steps are back on the join screen')
  const screen = read('web/src/screens/SessionScreen.svelte')
  assert.match(screen, /`\/c\/\$\{session\.session\.course\.slug \?\? session\.session\.course\.id\}`/)
})
