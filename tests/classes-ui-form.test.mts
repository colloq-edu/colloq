/**
 * A class's «Где считается» (Paper 18 · Z4) as the class forms draw it —
 * Resources.svelte rendered on the server with its parts standing in, as the
 * room's component tests render theirs — and what the two forms hand it
 * (Seminars.svelte, NewSeminar.svelte, read from their files as
 * admin-phone does).
 *
 * What these guard: the owner's-switch line («решает владелец») only where
 * the switch really keeps the viewer out, never while the viewer's own change
 * is on its way, and the presets hidden from such a viewer; and no «Где
 * считается» at all on a server where no class can go to a machine (the
 * broker, D26).
 */
import fs from 'node:fs'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { CLASS_PLACEMENT_DEFAULT, type ClassPlacement } from '../shared/admin.js'
import { classesOnMachines } from '../web/src/admin/runners.js'

let dir: string
let Resources: Component<any>
const web = (rel: string) => new URL(`../web/src/${rel}`, import.meta.url).href
const shared = (rel: string) => new URL(`../shared/${rel}`, import.meta.url).href

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-classes-form-'))
  const stub = async (name: string, body: string) => {
    const file = path.join(dir, `${name}.mjs`)
    await writeFile(file, body)
    return pathToFileURL(file).href
  }
  // The checkbox, the icons and the placeholders stand in: what is checked is the block's own markup.
  const component = await stub('component', 'export default function Stub() {}\n')
  const source = await readFile(new URL('../web/src/admin/ui/Resources.svelte', import.meta.url), 'utf8')
  let js = compile(source, { filename: 'Resources.svelte', generate: 'server' }).js.code
  for (const [from, to] of [
    ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
    ['svelte', import.meta.resolve('svelte')],
    ['@shared/i18n', shared('i18n.ts')],
    ['@shared/admin', shared('admin.ts')],
    ['@/admin/ui/Check.svelte', component],
    ['@/components/ui/Icon.svelte', component],
    ['@/components/ui/Skeleton.svelte', component],
    ['@/lib/utils', web('lib/utils.ts')],
    ['@/admin/runners', web('admin/runners.ts')],
  ]) js = js.replaceAll(`'${from}'`, JSON.stringify(to))
  const file = path.join(dir, 'Resources.mjs')
  await writeFile(file, js)
  Resources = (await import(pathToFileURL(file).href)).default
})

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/[  ]/g, ' ').replace(/\s+/g, ' ')
const LOCKED = /решает владелец/

/** The block as a class form draws it, for a viewer and a moment. */
function block(over: { editable: boolean; busy?: boolean; owner?: boolean; placement?: ClassPlacement }): string {
  return render(Resources, {
    props: {
      part: 'placement',
      resources: null,
      loading: false,
      environment: 'base',
      memoryMb: null,
      cpus: null,
      onmemory() {},
      oncpus() {},
      placement: over.placement ?? { ...CLASS_PLACEMENT_DEFAULT, own: 'machines', council: 'machines' },
      placementEditable: over.editable,
      placementBusy: over.busy ?? false,
      onplacement() {},
      outlook: null,
      owner: over.owner ?? false,
    },
  }).body
}

/** The buttons of the presets (radio) or of the parts (pressed), and whether each is greyed. */
const presets = (html: string) => [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((one) => /\sdisabled(=""|\s|>)/.test(one[0]))
const parts = (html: string) => [...html.matchAll(/<button[^>]*aria-pressed=[^>]*>/g)].map((one) => /\sdisabled(=""|\s|>)/.test(one[0]))

test('a change on its way greys the block, and says nothing of the owner\'s switch', () => {
  const idle = block({ editable: true, owner: true })
  assert.deepEqual(presets(idle), [false, false, false])
  assert.doesNotMatch(text(idle), LOCKED)
  // The owner's own save (or a teacher's, while the switch is on): busy, not kept out.
  const saving = block({ editable: true, busy: true, owner: true })
  assert.deepEqual(presets(saving), [true, true, true])
  assert.ok(parts(saving).length > 0 && parts(saving).every(Boolean), 'every part waits too')
  assert.doesNotMatch(text(saving), LOCKED, 'the owner is never told the owner decides')
})

test('a teacher whom the owner\'s switch keeps out reads where the class runs, greyed, without the presets', () => {
  const kept = block({ editable: false })
  assert.match(text(kept), /Где считать занятия, сейчас решает владелец: отправлять их на машины учителям не разрешено\./)
  assert.deepEqual(presets(kept), [], 'the presets are a way to change it: not drawn')
  assert.ok(parts(kept).length > 0 && parts(kept).every(Boolean), 'the parts stay, greyed')
})

/* ----------------------------------------------------------- the forms */

const read = (rel: string): string => fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
/** Markup without comments: an explanation is not a promise. */
const code = (source: string): string => source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const flat = (source: string): string => source.replace(/\s+/g, ' ')

test('the forms hand the block the viewer\'s right as the right and their own saves as busy', () => {
  const seminars = flat(code(read('web/src/admin/screens/Seminars.svelte')))
  assert.match(seminars, /placementEditable=\{ruling\.placementEditable === true\} \{placementBusy\}/)
  const created = flat(code(read('web/src/admin/screens/NewSeminar.svelte')))
  assert.match(created, /placementEditable=\{placementMay\} placementBusy=\{created !== null \|\| busy\}/)
})

test('no «Где считается» where no class can go to a machine: under the broker, or a server from before classes', () => {
  assert.equal(classesOnMachines({ backend: 'docker' }), true)
  assert.equal(classesOnMachines({ backend: 'test' }), true)
  assert.equal(classesOnMachines({ backend: 'broker' }), false)
  assert.equal(classesOnMachines(null), false)
  // The class dialog draws the block, and asks the machines, only when the server said classes can go to them.
  const seminars = flat(code(read('web/src/admin/screens/Seminars.svelte')))
  assert.match(seminars, /placement=\{machinesHere \? \(ruling\.placement \?\? null\) : null\}/)
  assert.match(seminars, /\(settings\) => \(machinesHere = classesOnMachines\(settings\)\)/)
  assert.match(seminars, /if \(yes && seminar\.placement && ruling\?\.id === seminar\.id\) readOutlook\(seminar\.id\)/)
  // The new-class form likewise.
  const created = flat(code(read('web/src/admin/screens/NewSeminar.svelte')))
  assert.match(created, /if \(!classSettings \|\| !classesOnMachines\(classSettings\)\) return null/)
})
