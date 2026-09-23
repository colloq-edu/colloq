import { TEST_ROOT } from './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { prepareDependencies } from '../server/src/dependencies/preparation.js'
import type { PreparationProgress } from '../server/src/dependencies/preparation-contract.js'

test('a failed container publishes a bounded diagnostic at its latest preparation stage', async () => {
  const bin = path.join(TEST_ROOT,'diagnostic-bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin,'docker'), `#!${process.execPath}
if (process.argv[2] === 'run') {
 process.stdout.write('__COLLOQ_DEP__' + JSON.stringify({state:'downloading'}) + '\\n');
 process.stderr.write('x'.repeat(4000) + 'fixture mount failed');
 process.exitCode = 1;
}
`, {mode:0o755})
  const previousPath = process.env.PATH
  process.env.PATH = bin + path.delimiter + previousPath
  const progress: PreparationProgress[] = []
  try {
    await assert.rejects(prepareDependencies({id:'diagnostic',imageDigest:'sha256:'+'a'.repeat(64),requirementsText:'demo',basePackages:[],
      workDir:path.join(TEST_ROOT,'diagnostic-work'),maxDownloadBytes:1024*1024,maxInstalledBytes:1024*1024,
      signal:new AbortController().signal,onProgress:value=>progress.push(value)}), {code:'preparation_failed'})
  } finally { process.env.PATH = previousPath }
  const failed = progress.at(-1)!
  assert.equal(failed.state,'downloading','a backwards stage makes the durable store discard the diagnostic')
  assert.ok(failed.log && failed.log.length <= 2000)
  assert.match(failed.log,/fixture mount failed$/)
})
