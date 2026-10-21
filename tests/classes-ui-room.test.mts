/**
 * The room when its kernel computes on a machine (Paper 18 · Z5): the kernel
 * chip in the notebook's bar, the staff banner with «Перенести сейчас» and
 * «Ждать машину», and a queued cell's «ждёт машину» — Notebook.svelte,
 * rendered on the server with its session, its document watchers and its
 * cells standing in, as the room's other component tests render theirs.
 *
 * What these guard is the data path of §13.1: the whole room reads where the
 * kernel is and whether its machine answers from the document, which never
 * names the machine; staff alone read the name and the round trip, from the
 * control socket's `kernel:machine` frames the session keeps by role.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import * as Y from 'yjs'
import { setLocaleResolver, translate } from '../shared/i18n.js'
import { CELLS_KEY, KERNEL_LINK_FIELD, KERNEL_LINK_SINCE_FIELD, KERNEL_WHERE_FIELD, kernelEntry } from '../shared/notebook.js'
import { OPEN_ROOM } from '../shared/rules.js'
import type { KernelMachine } from '../shared/protocol.js'

let dir: string
let Notebook: Component<any>
const web = (rel: string) => new URL(`../web/src/${rel}`, import.meta.url).href
const shared = (rel: string) => new URL(`../shared/${rel}`, import.meta.url).href

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-classes-room-'))
  const stub = async (name: string, body: string) => {
    const file = path.join(dir, `${name}.mjs`)
    await writeFile(file, body)
    return pathToFileURL(file).href
  }
  // The session, the document's watchers, the cells and the icons stand in: what is checked is the bar, the banner and the queue.
  const session = await stub('session', 'export function getSessionState() { return globalThis.__room.session }\n')
  const watchers = await stub('yreactive', [
    'export function watchBooks() { return { get current() { return globalThis.__room.books } } }',
    'export function watchCellIds() { return { get current() { return globalThis.__room.ids } } }',
    'export function watchBookKernel() { return { get current() { return globalThis.__room.kernel } } }',
  ].join('\n'))
  const component = await stub('component', 'export default function Stub() {}\n')
  const boot = await stub('boot', 'export function firstScreenReady() {}\n')
  const source = await readFile(new URL('../web/src/components/notebook/Notebook.svelte', import.meta.url), 'utf8')
  let js = compile(source, { filename: 'Notebook.svelte', generate: 'server' }).js.code
  for (const [from, to] of [
    ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
    ['svelte', import.meta.resolve('svelte')],
    ['@shared/i18n', shared('i18n.ts')],
    ['@shared/notebook', shared('notebook.ts')],
    ['@shared/rules', shared('rules.ts')],
    ['@/components/ui/Splash.svelte', component],
    ['@/components/ui/Icon.svelte', component],
    ['./CellView.svelte', component],
    ['@/lib/boot', boot],
    ['@/lib/controls', web('lib/controls.ts')],
    ['@/lib/may', web('lib/may.ts')],
    ['./command-mode', web('components/notebook/command-mode.ts')],
    ['@/lib/notebook-ops', web('lib/notebook-ops.ts')],
    ['@/lib/session.svelte', session],
    ['@/lib/cell-scroll', web('lib/cell-scroll.ts')],
    ['@/lib/utils', web('lib/utils.ts')],
    ['@/lib/yreactive.svelte', watchers],
    ['./first-mount', web('components/notebook/first-mount.ts')],
  ]) js = js.replaceAll(`'${from}'`, JSON.stringify(to))
  const file = path.join(dir, 'Notebook.mjs')
  await writeFile(file, js)
  Notebook = (await import(pathToFileURL(file).href)).default
})

after(async () => {
  setLocaleResolver(() => 'ru')
  if (dir) await rm(dir, { recursive: true, force: true })
})

interface Room {
  role?: 'host' | 'participant'
  /** The document's placement fields of the class notebook: `undefined` — never on a machine. */
  where?: 'machine' | null
  link?: 'ok' | 'lost' | 'moving'
  linkSince?: number
  queue?: string[]
  ids?: string[]
  /** Staff's last `kernel:machine` frame of the class notebooks' slot, as the session keeps it. */
  frame?: { machine: KernelMachine | null; note?: string; at: number }
  /** This browser's clock minus the server's (session.svelte.ts · clockSkewMs). */
  clockSkewMs?: number
  /** When the class was finished; null — it goes on. */
  finishedAt?: number | null
}

/** The notebook's bar and the cells around it, as a browser in such a room renders them; the markup's text and data marks. */
function room(over: Room = {}): string {
  const doc = new Y.Doc()
  doc.transact(() => {
    const entry = kernelEntry(doc, CELLS_KEY)
    entry.set('status', 'idle')
    if (over.where !== undefined) {
      entry.set(KERNEL_WHERE_FIELD, over.where)
      if (over.link) entry.set(KERNEL_LINK_FIELD, over.link)
      if (over.linkSince !== undefined) entry.set(KERNEL_LINK_SINCE_FIELD, over.linkSince)
    }
  })
  const ids = over.ids ?? ['c1', 'c2']
  ;(globalThis as Record<string, unknown>).__room = {
    books: [{ path: 'seminar.ipynb', root: CELLS_KEY }],
    ids,
    kernel: { kernelStatus: 'idle', queue: over.queue ?? [], runningCellId: null, kernelProblem: null },
    session: {
      doc,
      me: { id: 'p1', role: over.role ?? 'participant' },
      session: { id: 'room0001', rules: OPEN_ROOM, finishedAt: over.finishedAt ?? null },
      finished: (over.finishedAt ?? null) !== null,
      clockSkewMs: over.clockSkewMs ?? 0,
      connected: true,
      hydrated: true,
      provider: { synced: true, on() {}, off() {} },
      selection: [],
      selectedCellId: null,
      send() {},
      showError() {},
      selectCell() {},
      toggleCell() {},
      extendTo() {},
      undoManager: null,
      ...(over.frame ? { kernelMachines: { room: over.frame } } : {}),
    },
  }
  return render(Notebook, { props: { book: 'seminar.ipynb', active: true } }).body
}

const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/[  ]/g, ' ').replace(/\s+/g, ' ')
const chipOf = (html: string) => /data-machine-chip="(\w+)"/.exec(html)?.[1] ?? null
const NOW = Date.now()

test('a kernel that never left this server adds nothing to the bar', () => {
  const html = room()
  assert.equal(chipOf(html), null)
  assert.doesNotMatch(html, /data-machine-banner|data-waits-machine/)
})

test('on a machine the whole room reads «Ядро на машине», and only staff read its name and round trip', () => {
  const machine: KernelMachine = { name: 'vast-3', state: 'ready', since: NOW - 60_000, rttMs: 52.4, failover: 'auto', failoverAt: null }
  const student = room({ where: 'machine', link: 'ok', linkSince: NOW - 60_000, frame: { machine, at: NOW } })
  assert.equal(chipOf(student), 'calm')
  assert.match(text(student), /Ядро на машине/)
  assert.doesNotMatch(student, /vast-3/, 'a student\'s page never names the machine, whatever the session holds')
  const host = room({ role: 'host', where: 'machine', link: 'ok', linkSince: NOW - 60_000, frame: { machine, at: NOW } })
  assert.match(text(host), /Ядро · vast-3 · 52 мс/)
  // Staff before their first frame read what the room reads.
  assert.match(text(room({ role: 'host', where: 'machine', link: 'ok', linkSince: NOW })), /Ядро на машине/)
})

test('while the machine does not answer the chip is amber with its timer, and the queued cells wait for it', () => {
  const html = room({ where: 'machine', link: 'lost', linkSince: NOW - 23_000, queue: ['c2'] })
  assert.equal(chipOf(html), 'amber')
  // A bar too narrow for the whole sentence (a server render measures none) keeps the timer: «Нет связи · 0:23».
  assert.match(text(html), /Нет связи · 0:2[3-9]/)
  // The timer is a box of its own that never shrinks: on a phone's bar the words go into the ellipsis, it stays whole (Z10).
  assert.match(html, /<span class="shrink-0 tabular-nums" data-machine-elapsed="">· 0:2[3-9]<\/span>/)
  // And the chip is a grid whose words alone may shrink to nothing: its smallest is the dot and the timer, never less.
  assert.match(html, /<span class="inline-grid h-6 grid-cols-\[auto_minmax\(0,1fr\)_auto\] items-center [^"]*" title="[^"]*" data-machine-chip="amber">/)
  assert.match(html, /title="Нет связи с машиной · 0:2[3-9]\. Ядро и переменные на машине целы/, 'the hover says how long, too')
  // The queued cell says it waits; the one not in the queue does not.
  assert.equal((html.match(/data-waits-machine/g) ?? []).length, 1)
  assert.match(text(html), /ждёт машину/)
})

test('a kernel being moved spins, and one back from a machine is calm with the move\'s time for the rest of the class', () => {
  assert.equal(chipOf(room({ where: 'machine', link: 'moving', linkSince: NOW })), 'moving')
  // The next start decides where it lands (another machine, or this server): the chip names neither.
  assert.match(text(room({ where: 'machine', link: 'moving', linkSince: NOW })), /Переносим ядро…/)
  const at = new Date(NOW - 20 * 60_000)
  const back = room({ where: null, linkSince: at.getTime() })
  assert.equal(chipOf(back), 'calm')
  assert.match(text(back), new RegExp(`На сервере · переехало в ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`))
  // Not after the class ended, and not a week later: the document keeps the move's time for good, the room does not say it.
  assert.equal(chipOf(room({ where: null, linkSince: at.getTime(), finishedAt: NOW - 60_000 })), null)
  assert.equal(chipOf(room({ where: null, linkSince: NOW - 7 * 86_400_000 })), null)
})

test('staff get the banner after ten seconds without the machine, with the server\'s sentence and both buttons; nobody else does', () => {
  const machine: KernelMachine = { name: 'vast-3', state: 'unreachable', since: NOW - 23_000, rttMs: 52, failover: 'auto', failoverAt: NOW + 37_000 }
  const note = 'Машина «vast-3» не отвечает с 14:32:05. Ждём до 14:33:05, потом поднимем ядро на этом сервере (переменные пропадут).'
  const host = room({ role: 'host', where: 'machine', link: 'lost', linkSince: NOW - 23_000, frame: { machine, note, at: NOW } })
  assert.match(host, /data-machine-banner/)
  assert.ok(text(host).includes(note))
  assert.match(text(host), /Перенести сейчас/)
  assert.match(text(host), /Ждать машину/)
  // Before ten seconds, and to a student at any time: no banner.
  assert.doesNotMatch(room({ role: 'host', where: 'machine', link: 'lost', linkSince: NOW - 5_000, frame: { machine, note, at: NOW } }), /data-machine-banner/)
  assert.doesNotMatch(room({ where: 'machine', link: 'lost', linkSince: NOW - 60_000 }), /data-machine-banner/)
})

test('without the server\'s word the banner promises nothing, and «Ждать машину» waits until the class is known to move by itself', () => {
  // Before staff's frame came (or after a reconnect lost it): no name, no automatic move promised, and only the move offered.
  const early = room({ role: 'host', where: 'machine', link: 'lost', linkSince: NOW - 12_000 })
  assert.match(text(early), /Нет связи с машиной · 0:1[2-9]\. Ядро и переменные на ней целы\. Перенести ядро можно сейчас \(переменные пропадут\) — или ждать машину\./)
  assert.doesNotMatch(text(early), /перенесёт ядро сам/)
  assert.match(text(early), /Перенести сейчас/)
  assert.doesNotMatch(text(early), /Ждать машину/, 'a class that may already wait is not offered the wait')
  // A class that waits for its machine by its own setting says so, and is offered only the move.
  const machine: KernelMachine = { name: 'vast-3', state: 'unreachable', since: NOW - 30_000, rttMs: 52, failover: 'wait', failoverAt: null }
  const waiting = room({ role: 'host', where: 'machine', link: 'lost', linkSince: NOW - 30_000, frame: { machine, at: NOW } })
  assert.match(text(waiting), /Ждём машину: ядро не переедет само, пока вы не нажмёте «Перенести сейчас»\./)
  assert.doesNotMatch(text(waiting), /Ждать машину/)
  // One that moves by itself, known from the frame: both.
  const auto = room({ role: 'host', where: 'machine', link: 'lost', linkSince: NOW - 30_000, frame: { machine: { ...machine, failover: 'auto', failoverAt: NOW + 30_000 }, at: NOW } })
  assert.match(text(auto), /Перенести сейчас Ждать машину/)
})

test('staff read the slow start in the server\'s own sentence while the slot starts on its machine; nobody else does', () => {
  const machine: KernelMachine = { name: 'vast-3', state: 'starting', since: NOW - 9_000, rttMs: null, failover: 'auto', failoverAt: null }
  const note = 'Запускаем ядро на машине «vast-3»… образ ↓ 45 %'
  const host = room({ role: 'host', frame: { machine, note, at: NOW } })
  assert.match(host, /data-machine-starting/)
  assert.ok(text(host).includes(note))
  assert.doesNotMatch(room({ frame: { machine, note, at: NOW } }), /data-machine-starting|vast-3/, 'a student reads the kernel log\'s unnamed one')
  // Up: the next frame (another state) carries no sentence, and the line goes.
  assert.doesNotMatch(room({ role: 'host', where: 'machine', link: 'ok', linkSince: NOW, frame: { machine: { ...machine, state: 'ready', rttMs: 52 }, at: NOW } }), /data-machine-starting/)
})

test('the timer and the banner\'s ten seconds count on the server\'s clock, whatever this browser\'s says', () => {
  // This browser is a minute behind the server; the machine went quiet 30 s ago by the server's clock.
  const serverNow = NOW + 60_000
  const behind = room({ role: 'host', where: 'machine', link: 'lost', linkSince: serverNow - 30_000, clockSkewMs: -60_000 })
  assert.match(behind, /data-machine-elapsed="">· 0:3\d</)
  assert.match(behind, /data-machine-banner/, '«Перенести сейчас» after ten seconds, not after seventy')
  // Two minutes ahead, and the machine quiet for two seconds: no banner yet, and no «2:02».
  const ahead = room({ role: 'host', where: 'machine', link: 'lost', linkSince: NOW - 120_000 - 2_000, clockSkewMs: 120_000 })
  assert.match(ahead, /data-machine-elapsed="">· 0:0\d</)
  assert.doesNotMatch(ahead, /data-machine-banner/)
})

test('the English room reads the same states in English', () => {
  setLocaleResolver(() => 'en')
  try {
    assert.match(text(room({ where: 'machine', link: 'lost', linkSince: NOW - 23_000, queue: ['c1'] })), /No link · 0:2\d.*waiting for the machine/)
    assert.equal(translate('en', 'room.machine.chip.machine'), 'Kernel on a machine')
  } finally {
    setLocaleResolver(() => 'ru')
  }
})

test('the session keeps staff\'s last frame of each role: a frame with no sentence keeps the one of its state, a new connection starts empty', async () => {
  const { noteKernelMachine } = await import('../web/src/lib/kernel-machines.js')
  const machine = (state: KernelMachine['state']): KernelMachine => ({ name: 'vast-3', state, since: NOW, rttMs: state === 'ready' ? 52 : null, failover: 'auto', failoverAt: null })
  const said = 'Машина «vast-3» не отвечает с 14:32:05. Ждём до 14:33:05, потом поднимем ядро заново (переменные пропадут).'
  let kept = noteKernelMachine({}, { t: 'kernel:machine', role: 'room', machine: machine('ready') }, 1)
  kept = noteKernelMachine(kept, { t: 'kernel:machine', role: 'own', machine: machine('ready') }, 2)
  kept = noteKernelMachine(kept, { t: 'kernel:machine', role: 'room', machine: machine('unreachable'), note: said }, 3)
  // The server's fresher view of the same outage, sent right after its sentence: the banner goes on reading the sentence.
  kept = noteKernelMachine(kept, { t: 'kernel:machine', role: 'room', machine: machine('unreachable') }, 4)
  assert.deepEqual(kept.room, { machine: machine('unreachable'), note: said, at: 4 })
  assert.deepEqual(kept.own, { machine: machine('ready'), at: 2 }, 'each role its own frame')
  // The machine answers again: what was said of the outage is not the banner's any more; nor is it for a slot back here.
  assert.deepEqual(noteKernelMachine(kept, { t: 'kernel:machine', role: 'room', machine: machine('ready') }, 5).room, { machine: machine('ready'), at: 5 })
  assert.deepEqual(noteKernelMachine(kept, { t: 'kernel:machine', role: 'room', machine: null }, 6).room, { machine: null, at: 6 })
  // And the session parses the frame with it, and forgets them on every new connection (its welcome says them again).
  const source = (await readFile(new URL('../web/src/lib/session.svelte.ts', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.match(source, /message\.t === 'kernel:machine'\) this\.kernelMachines = noteKernelMachine\(this\.kernelMachines, message, Date\.now\(\)\)/)
  const opened = source.slice(source.indexOf('socket.onopen = () => {'), source.indexOf('socket.onmessage'))
  assert.match(opened, /this\.kernelMachines = \{\}/)
})
