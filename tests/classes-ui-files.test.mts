/**
 * The files panel of a class whose kernel computes on a machine (Paper 18 ·
 * Z6): what is on its way from the machine, what stays there with «Привезти»
 * for staff, a package tree as one row, and a conflict copy with its note —
 * FilesPanel.svelte rendered on the server with its session standing in, as
 * the room's other component tests render theirs.
 *
 * What these guard: home's tree stays home's (D16) and the panel says plainly
 * what is not here yet or not here at all; «Привезти» and the staff notes
 * reach staff only; a tree from a server before classes reads as it always
 * did.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import * as Y from 'yjs'
import { setLocaleResolver } from '../shared/i18n.js'
import { OPEN_ROOM } from '../shared/rules.js'

let dir: string
let FilesPanel: Component<any>
const web = (rel: string) => new URL(`../web/src/${rel}`, import.meta.url).href
const shared = (rel: string) => new URL(`../shared/${rel}`, import.meta.url).href

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-classes-files-'))
  const stub = async (name: string, body: string) => {
    const file = path.join(dir, `${name}.mjs`)
    await writeFile(file, body)
    return pathToFileURL(file).href
  }
  const session = await stub('session', 'export function getSessionState() { return globalThis.__files.session }\n')
  const watchers = await stub('yreactive', 'export function watchBooks() { return { get current() { return [] } } }\n')
  const component = await stub('component', 'export default function Stub() {}\n')
  const api = await stub('api', 'export const api = {}\n')
  const clipboard = await stub('clipboard', 'export async function copyText() {}\n')
  const source = await readFile(new URL('../web/src/components/panels/FilesPanel.svelte', import.meta.url), 'utf8')
  let js = compile(source, { filename: 'FilesPanel.svelte', generate: 'server' }).js.code
  for (const [from, to] of [
    ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
    ['svelte', import.meta.resolve('svelte')],
    ['@shared/i18n', shared('i18n.ts')],
    ['@shared/paths', shared('paths.ts')],
    ['@/components/ui/RowsSkeleton.svelte', component],
    ['@/components/ui/ContextMenu.svelte', component],
    ['@/components/ui/Icon.svelte', component],
    ['@/lib/api', api],
    ['@/lib/session.svelte', session],
    ['@/lib/utils', web('lib/utils.ts')],
    ['@/lib/clipboard', clipboard],
    ['@/lib/file-icons', web('lib/file-icons.ts')],
    ['@/lib/may', web('lib/may.ts')],
    ['@/lib/tree-move', web('lib/tree-move.ts')],
    ['@/lib/yreactive.svelte', watchers],
  ]) js = js.replaceAll(`'${from}'`, JSON.stringify(to))
  const file = path.join(dir, 'FilesPanel.mjs')
  await writeFile(file, js)
  FilesPanel = (await import(pathToFileURL(file).href)).default
})

after(async () => {
  setLocaleResolver(() => 'ru')
  if (dir) await rm(dir, { recursive: true, force: true })
})

const KB = 1024
const GB = 1024 ** 3
const entry = (name: string, size: number, extra: Record<string, unknown> = {}) => ({ name, path: name, dir: false, size, modifiedAt: 1, ...extra })

/** The tree of a class on a machine, as the server's tree frame would carry it (shared/protocol.ts · FileEntry). */
const MACHINE_TREE = [
  entry('data (с машины 14-32).csv', 1.4 * 1024 * KB, { conflict: { of: 'data.csv', at: 1 } }),
  entry('data.csv', 1.4 * 1024 * KB),
  entry('model.pt', 0, { onMachine: { bytes: 2.1 * GB, why: 'size' } }),
  entry('out.csv', 12 * KB, { pending: true }),
  // Home's package row (kernel/remote/files.ts · PACKAGES_ROW): the folder the packages went to, `.packages` at the top.
  { name: '.packages', path: '.packages', dir: false, size: 2.1 * GB, modifiedAt: 0, kind: 'packages', bytes: 2.1 * GB, count: 1234, onMachine: { bytes: 2.1 * GB, why: 'package' } },
]

function panel(role: 'host' | 'participant', files: unknown[] = MACHINE_TREE): string {
  ;(globalThis as Record<string, unknown>).__files = {
    session: {
      doc: new Y.Doc(),
      files,
      filesArrived: true,
      filesTruncated: false,
      peers: [],
      me: { id: 'p1', role },
      session: { id: 'room0001', rules: OPEN_ROOM },
      finished: false,
      connected: true,
      token: 't',
      send() {},
    },
  }
  return render(FilesPanel, { props: {} }).body
}

const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/[  ]/g, ' ').replace(/\s+/g, ' ')
const count = (html: string, mark: string) => (html.match(new RegExp(mark, 'g')) ?? []).length

test('the strip says what is still on its way from the machine, and the arrow stands before its size', () => {
  const html = panel('participant')
  assert.equal(count(html, 'data-machine-incoming'), 1)
  assert.match(text(html), /С машины едет 1 файл/)
  assert.match(text(html), /↑ 12 КБ/)
})

test('a file over the cap is «на машине» with «Привезти» for staff, twice — on its row and in its note — and never for a student', () => {
  const host = panel('host')
  assert.equal(count(host, 'data-on-machine'), 1)
  assert.match(text(host), /model \.pt на машине 2,1 ГБ/)
  assert.equal(count(text(host), 'Привезти'), 2)
  assert.match(text(host), /model\.pt \(2,1 ГБ\) больше предела и остаётся на машине\. Если машина пропадёт, файл пропадёт тоже\./)
  const student = panel('participant')
  assert.equal(count(student, 'data-on-machine'), 1, 'everyone sees that it is not here')
  assert.equal(count(text(student), 'Привезти'), 0)
  assert.equal(count(student, 'data-machine-kept'), 0)
})

test('«Привезти» waits as long as the tree says the file is on its way, in every tab, and only then', () => {
  // The server took the pull: the row is `pending` as well as on the machine, here as after a reload.
  const coming = MACHINE_TREE.map((one) => (one.path === 'model.pt' ? { ...one, pending: true } : one))
  const host = panel('host', coming)
  const buttons = [...host.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].filter((one) => /Везём|Привезти/.test(one[1]))
  assert.equal(buttons.length, 2, 'the row\'s and the note\'s')
  for (const [button, words] of buttons) {
    assert.match(words, /Везём model\.pt с машины…/)
    assert.match(button, /\sdisabled(=""|\s|>)/)
  }
  // Not pending (never pressed, or refused): pressable, as before.
  const still = [...panel('host').matchAll(/<button[^>]*>([^<]*)<\/button>/g)].filter((one) => /Привезти/.test(one[1]))
  assert.equal(still.length, 2)
  for (const [button] of still) assert.doesNotMatch(button, /\sdisabled(=""|\s|>)/)
})

test('a file only on the machine has nothing here to open, give, copy or rename: its menu says so, and offers staff «Привезти»', () => {
  const source = (readFileSync(new URL('../web/src/components/panels/FilesPanel.svelte', import.meta.url), 'utf8')).replace(/\s+/g, ' ')
  assert.match(source, /function fileItems\(entry: FileEntry\): ContextMenuItem\[\] \{ \/\/ [^/]*? if \(machineSide\(entry\)\.onMachine\) return machineItems\(entry\)/)
  const items = source.slice(source.indexOf('function machineItems(entry: FileEntry)'), source.indexOf('function panelItems('))
  assert.match(items, /const waits = \(label: string, icon: ContextMenuItem\['icon'\]\): ContextMenuItem => \(\{ label, icon, disabled: true, why: notHere, run: \(\) => \{\} \}\)/)
  assert.match(items, /if \(isHost\) \{ items\.push\(\{ label: tr\('room\.files\.machine\.fetch'\)/)
  for (const label of ['open', 'download', 'duplicate', 'rename']) assert.match(items, new RegExp(`waits\\(tr\\('room\\.files\\.menu\\.${label}'\\)`), `${label} waits with why`)
  // F2 and a double click reach the rename past the menu, a copy its own way: both say why too.
  assert.match(source, /function startRename\(entry: FileEntry\): void \{ if \(!isHost\) return \/\/ [^\n]*? if \(machineSide\(entry\)\.onMachine\) \{ errorRender = \(\) => tr\('room\.files\.machine\.notHere'\)/)
})

test('a package tree is one row with its size; nothing of it is listed file by file', () => {
  const html = panel('host')
  assert.equal(count(html, 'data-machine-packages'), 1)
  assert.match(text(html), /пакеты \(pip -t\) — на машине, 2,1 ГБ/)
  assert.doesNotMatch(text(html), /\.packages/, 'the row is named by its words, not by home\'s marker')
  // A package row is no file kept on the machine: no «Привезти», no note of its own.
  assert.equal(count(html, 'data-on-machine'), 1)
  assert.equal(count(html, 'data-machine-kept'), 1)
})

test('a conflict copy is tinted, with its note for staff naming both files; a student sees the copy and no note', () => {
  const host = panel('host')
  assert.match(host, /bg-warning\/\[0\.08\]/)
  assert.equal(count(host, 'data-machine-conflict'), 1)
  assert.match(text(host), /data\.csv изменили одновременно здесь и на машине\. Оставлена версия сервера, версия с машины — «data \(с машины 14-32\)\.csv»\./)
  const student = panel('participant')
  assert.equal(count(student, 'data-machine-conflict'), 0)
  assert.match(text(student), /data \(с машины 14-32\)/)
})

test('a tree from a server before classes reads as it always did', () => {
  const html = panel('host', [entry('data.csv', 1.4 * 1024 * KB), entry('out.csv', 12 * KB)])
  for (const mark of ['data-machine-incoming', 'data-on-machine', 'data-machine-packages', 'data-machine-conflict', 'data-machine-kept']) {
    assert.equal(count(html, mark), 0, mark)
  }
  assert.doesNotMatch(text(html), /↑/)
})

test('the English panel says the same', () => {
  setLocaleResolver(() => 'en')
  try {
    const html = text(panel('host'))
    assert.match(html, /1 file coming from the machine/)
    assert.match(html, /model \.pt on the machine 2\.1 GB/)
    assert.match(html, /Fetch/)
    assert.match(html, /packages \(pip -t\) — on the machine, 2[.,]1 GB/)
  } finally {
    setLocaleResolver(() => 'ru')
  }
})
