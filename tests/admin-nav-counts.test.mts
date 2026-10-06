/**
 * The figures in the panel's rail after a reload on a deep address.
 *
 * Each list screen puts its own count into the rail, so the shell skipped the
 * active tab's list to save a request. One competition, one course or a class
 * page opened from a course belongs to that tab too but loads no list: a
 * reload there left «Соревнования» without its figure. The shell now skips
 * only when the tab's own list is the open screen.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')

test('the rail asks for the active tab’s count unless that tab’s list is on screen', () => {
  const shell = read('web/src/admin/AdminShell.svelte')
  assert.match(shell, /void navCounts\.load\(listShown \? tab : undefined\)/)
  const screen = read('web/src/screens/AdminScreen.svelte')
  assert.match(screen, /<AdminShell \{tab\} \{listShown\} \{navigate\}>/)
  const lists = /const LIST_PATHS = new Set\(\[([^\]]*)\]\)/.exec(screen)?.[1] ?? ''
  for (const list of ['/admin', '/admin/courses', '/admin/competitions', '/admin/environments', '/admin/teachers']) {
    assert.ok(lists.includes(`'${list}'`), `${list} reports its own count`)
  }
  // A single competition is not its list.
  assert.ok(!lists.includes('/admin/competitions/'), 'a deep address counts as a list')
})
