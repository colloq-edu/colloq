import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { TEST_ROOT } from './_env.mts'
import { config } from '../server/src/config.js'
import { hostPathOf } from '../server/src/competitions/storage.js'
import { competitionRunner, forgetCompetitionRunner, limitsFor, useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { runArgs, scoreArgs, useDockerForCompetitions } from '../server/src/competitions/docker-runner.js'
import type { Competition } from '../shared/competitions.js'

const limits = limitsFor({ limits: { memoryMb: 4096, cpus: 2, wallSeconds: 60 } } as Competition, 'notebook')
const args = () => [
  runArgs({ container: 'notebook', image: 'base', dataDir: path.join(config.dataDir, 'data'), inputDir: path.join(config.dataDir, 'input'), resultDir: path.join(config.dataDir, 'result'), target: 'submission.csv', limits }),
  scoreArgs({ container: 'scorer', image: 'base', secretDir: path.join(config.dataDir, 'secret'), submissionDir: path.join(config.dataDir, 'answer'), outDir: path.join(config.dataDir, 'score'), limits, solutionFile: 'solution.csv', metricFile: 'metric.py', idColumn: 'id', publicPercent: 30, splitSeed: 'seed' }),
]
const scope = (root: string) => createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)

test('both execution steps bound raw stdout/stderr retention and carry the canonical host instance label', () => {
  for (const command of args()) {
    assert.ok(command.includes('--log-driver=local'))
    assert.ok(command.includes('--log-opt=max-size=8m'))
    assert.ok(command.includes('--log-opt=max-file=2'))
    assert.ok(command.includes(`ru.colloq.competition-instance=${scope(hostPathOf(config.dataDir))}`))
  }
})

test('two containerized apps sharing the internal data path get distinct scopes from their host roots', () => {
  const internal = path.join(TEST_ROOT, 'same-internal-data')
  const source = `
import './tests/_env.mts'
process.env.DATA_DIR = process.argv[1]
process.env.DATA_HOST_DIR = process.argv[2]
const {runArgs} = await import('./server/src/competitions/docker-runner.ts')
const command = runArgs({container:'c',image:'base',dataDir:process.argv[1],inputDir:process.argv[1],resultDir:process.argv[1],target:'submission.csv',limits:{memoryMb:4096,cpus:2,pids:256,tmpfsMb:128,targetBytes:1024,outputBytes:1024,outputKillBytes:2048,wallSeconds:10,fsizeBytes:4096}})
console.log(command.find(value=>value.startsWith('ru.colloq.competition-instance=')))
`
  const labels = ['/srv/instance-one', '/srv/instance-two'].map((root) => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, internal, root], { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    return child.stdout.trim()
  })
  assert.notEqual(labels[0], labels[1])
  assert.deepEqual(labels, ['/srv/instance-one', '/srv/instance-two'].map((root) => `ru.colloq.competition-instance=${scope(root)}`))
})

test('startup sweep removes this instance jobs and verified legacy mounts, preserving other instances', async () => {
  const previous = process.env.COMPETITION_BACKEND
  process.env.COMPETITION_BACKEND = 'docker'; useCompetitionRunner(null); forgetCompetitionRunner()
  const root = path.resolve(hostPathOf(config.dataDir)), foreign = `${root}-another`
  const ownScope = scope(root), foreignScope = scope(foreign)
  const inventory = new Map([
    ['our-run', { labels: { 'colloq.kind': 'competition-run', 'ru.colloq.competition-instance': ownScope }, mounts: [{ Type: 'bind', Source: path.join(root, 'data') }] }],
    ['their-run', { labels: { 'colloq.kind': 'competition-run', 'ru.colloq.competition-instance': foreignScope }, mounts: [{ Type: 'bind', Source: path.join(foreign, 'data') }] }],
    ['our-score', { labels: { 'colloq.kind': 'competition-score', 'ru.colloq.competition-instance': ownScope }, mounts: [{ Type: 'bind', Source: path.join(root, 'secret') }] }],
    ['their-score', { labels: { 'colloq.kind': 'competition-score', 'ru.colloq.competition-instance': foreignScope }, mounts: [{ Type: 'bind', Source: path.join(foreign, 'secret') }] }],
    ['legacy-ours', { labels: { 'colloq.kind': 'competition-run' }, mounts: [{ Type: 'bind', Source: path.join(root, 'old-result') }] }],
    ['legacy-foreign', { labels: { 'colloq.kind': 'competition-run' }, mounts: [{ Type: 'bind', Source: path.join(foreign, 'old-result') }] }],
    ['legacy-mixed', { labels: { 'colloq.kind': 'competition-run' }, mounts: [{ Type: 'bind', Source: path.join(root, 'data') }, { Type: 'bind', Source: path.join(foreign, 'old-result') }] }],
  ] as Array<[string, { labels: Record<string, string>; mounts: Array<{ Type: string; Source: string }> }]>)
  useDockerForCompetitions(async (command) => {
    if (command[0] === 'ps') {
      const filters = command.filter((_, index) => command[index - 1] === '--filter').map((value) => value.replace(/^label=/, '').split('='))
      const matching = [...inventory].filter(([, value]) => filters.every(([key, expected]) => value.labels[key] === expected))
      return { code: 0, out: matching.map(([id]) => id).join('\n') }
    }
    if (command[0] === 'inspect') {
      const found = inventory.get(command[1])
      return { code: found ? 0 : 1, out: found ? JSON.stringify(found) : 'No such container' }
    }
    assert.equal(command[0], 'rm')
    inventory.delete(command.at(-1)!)
    return { code: 0, out: '' }
  })
  try {
    assert.equal(await competitionRunner().sweep(['legacy-ours', 'legacy-foreign', 'legacy-mixed']), 3)
    assert.deepEqual([...inventory.keys()].sort(), ['legacy-foreign', 'legacy-mixed', 'their-run', 'their-score'])
  } finally {
    useDockerForCompetitions(null); forgetCompetitionRunner()
    if (previous === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = previous
  }
})
