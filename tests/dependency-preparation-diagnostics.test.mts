import { TEST_ROOT } from './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { prepareDependencies } from '../server/src/dependencies/preparation.js'
import type { DependencyPreparationError, PreparationProgress } from '../server/src/dependencies/preparation-contract.js'

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

test('a reported failure keeps only the details a page may show, and our steps arrive as codes', async () => {
  const bin = path.join(TEST_ROOT,'reported-bin')
  fs.mkdirSync(bin)
  const lines = [
    {state:'resolving',normalizedRequirements:['torch'],log:{code:'resolve'}},
    {error:{code:'download_limit',message:'The wheel downloads exceed the configured size limit.',line:null,params:{
      bytes:888100000,limitBytes:524288000,partial:true,note:'<script>',
      heaviest:[{name:'torch',bytes:888100000},{name:'<b>torch</b>',bytes:1},{name:'sympy',bytes:-1}],
    }}},
  ].map(value => '__COLLOQ_DEP__' + JSON.stringify(value) + '\n').join('')
  fs.writeFileSync(path.join(bin,'docker'), `#!${process.execPath}
if (process.argv[2] === 'run') { process.stdout.write(${JSON.stringify(lines)}); process.exitCode = 1 }
`, {mode:0o755})
  const previousPath = process.env.PATH
  process.env.PATH = bin + path.delimiter + previousPath
  const progress: PreparationProgress[] = []
  try {
    await assert.rejects(prepareDependencies({id:'reported',imageDigest:'sha256:'+'a'.repeat(64),requirementsText:'torch',basePackages:[],
      workDir:path.join(TEST_ROOT,'reported-work'),maxDownloadBytes:1024*1024,maxInstalledBytes:1024*1024,
      signal:new AbortController().signal,onProgress:value=>progress.push(value)}), (error: DependencyPreparationError) => {
      assert.equal(error.code,'download_limit')
      assert.deepEqual(error.params,{bytes:888100000,limitBytes:524288000,partial:true,heaviest:[{name:'torch',bytes:888100000}]})
      return true
    })
  } finally { process.env.PATH = previousPath }
  assert.deepEqual(progress.map(item => item.log),[{code:'start'},{code:'resolve'}])
})
