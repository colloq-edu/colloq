/**
 * The «Как поделена машина» bar with «Тетради на этом сервере» off: the panel's
 * preview must promise what the server's budget does — the metric lane's
 * places, each the run cushion and the metric's memory — not the notebook
 * slots that never run on this server (a rehearsal home showed «19
 * исполнителей × 4 ГБ», 76 GB, on a server set to metrics only).
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { METRIC_MEMORY_MB, metricMemoryMb } from '../shared/competitions.js'
import { messages } from '../shared/i18n.js'

test('the metric memory rule has one definition, capped at 2 GB and floored at 512 MB', () => {
  assert.equal(METRIC_MEMORY_MB, 2048)
  assert.equal(metricMemoryMb(4096), 2048)
  assert.equal(metricMemoryMb(1024), 1024)
  assert.equal(metricMemoryMb(256), 512)
  const port = readFileSync(new URL('../server/src/competitions/runner-port.ts', import.meta.url), 'utf8')
  const budget = readFileSync(new URL('../server/src/routes/admin-resources.ts', import.meta.url), 'utf8')
  assert.match(port, /memoryMb: metricMemoryMb\(limits\.memoryMb\)/)
  assert.match(budget, /metricMemoryMb\(limits\.memoryMb\)/)
  assert.doesNotMatch(port, /Math\.min\(METRIC_MEMORY_MB/)
})

test('with notebooks off, the preview counts the metric lane, not notebook slots', () => {
  const tab = readFileSync(new URL('../web/src/admin/screens/ResourcesTab.svelte', import.meta.url), 'utf8')
  const share = tab.slice(tab.indexOf('const competitionShare = $derived.by'), tab.indexOf('const memory = $derived.by'))
  assert.match(share, /const homeOn = homeChoice \?\? queue\.runners\?\.homeNotebooks\.value \?\? true/)
  assert.match(share, /if \(!homeOn\) \{[\s\S]*valueOf\('c\.scoreSlots'\)[\s\S]*cushion \+ metricMemoryMb\(memoryMb\)[\s\S]*metricsOnly: true/)
  assert.match(tab, /competitionShare\.metricsOnly \? 'admin\.resourcesTab\.metricsDetail' : 'admin\.resourcesTab\.competitionsDetail'/)
  const words = messages['admin.resourcesTab.metricsDetail'] as { ru: Record<string, string>; en: Record<string, string> }
  assert.ok(words?.ru?.many?.includes('оценок') && words?.en?.other?.includes('metrics'))
})
