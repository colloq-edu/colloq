import { TEST_ROOT } from './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const enabled = process.env.COLLOQ_RESTORE_DOCKER_TEST === '1'
const repo = fileURLToPath(new URL('..',import.meta.url))
const fixtureDirs: string[] = []
after(() => { for (const dir of fixtureDirs) fs.rmSync(dir,{recursive:true,force:true}) })
const execute = promisify(execFile)
const run = async (command:string,args:string[]) => execute(command,args,{cwd:repo,env:process.env,timeout:300_000,maxBuffer:4*1024*1024})

test('Docker: prepared hashed packages and pinned offline notebook scoring survive a portable archive restore', {skip:!enabled,timeout:600_000}, async () => {
  const source = fs.realpathSync(fs.mkdtempSync(path.join(repo,'.restore-test-source-')))
  const restored = fs.realpathSync(fs.mkdtempSync(path.join(repo,'.restore-test-target-')))
  fixtureDirs.push(source,restored)
  // Colima shares the repository; host OS temporary directories need not be mounted.
  for (const root of [source,restored]) fs.writeFileSync(path.join(root,'.restore-smoke-root'),'colloq-restore-smoke-v1')
  fs.mkdirSync(path.join(source,'workspace'))
  fs.mkdirSync(path.join(source,'secrets'))
  const fixture = path.join(repo,'scripts/restore-run-fixture.mts')
  await run(process.execPath,['--import','tsx',fixture,'seed',source])
  const before = JSON.parse(fs.readFileSync(path.join(source,'run-summary.json'),'utf8'))
  const release = path.join(TEST_ROOT,'restore-release.json')
  fs.writeFileSync(release,JSON.stringify({schemaVersion:1,version:'smoke',dataSchemaVersion:1,compatibleDataSchemaVersions:[1],
    catalog:{schemaVersion:1,release:'smoke',environments:[{name:'kaggle-base',image:before.imageDigest,gpu:false}]}}))
  const archive = path.join(TEST_ROOT,'prepared-offline-run.tar.gz')
  const backup = path.join(repo,'scripts/runtime-backup.py')
  // The seed subprocess exited and closed SQLite: no app or queue is writing.
  await run('python3',[backup,'backup','--root',source,'--release',release,'--output',archive,'--mode','consistent','--quiesced','--name','restore-smoke'])
  await run('python3',[backup,'validate','--release',release,'--archive',archive,'--name','restore-smoke'])
  await run('python3',[backup,'restore','--root',restored,'--release',release,'--archive',archive,'--name','restore-smoke'])
  assert.equal(fs.existsSync(path.join(restored,'.restore-in-progress')),false)
  // A new process reloads the restored SQLite binding and rehashes its wheels.
  await run(process.execPath,['--import','tsx',fixture,'run',restored])
  const after = JSON.parse(fs.readFileSync(path.join(restored,'run-summary.json'),'utf8'))
  assert.notEqual(after.attemptId,before.attemptId)
  delete before.attemptId; delete after.attemptId
  assert.deepEqual(after,before)
  assert.ok(after.packages.length >= 2)
})
