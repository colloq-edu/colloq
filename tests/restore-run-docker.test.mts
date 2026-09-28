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
const execute = promisify(execFile)
const run = async (command:string,args:string[]) => execute(command,args,{cwd:repo,env:process.env,timeout:300_000,maxBuffer:4*1024*1024})
// The documented portable restore runs as root and hands data/workspace to UID 1000, the
// container user; restored files stay 0600. A Linux runner with another UID (GitHub: 1001)
// must follow that path, or the restored tree is unreadable inside containers. Docker
// Desktop's file sharing hides ownership, so macOS runs everything as the current user.
const asRoot = process.platform === 'linux' && process.getuid!() !== 0 && process.getuid!() !== 1000
const privileged = async (command:string,args:string[]) => asRoot ? run('sudo',['-n','--preserve-env',command,...args]) : run(command,args)
after(async () => {
  for (const dir of fixtureDirs) {
    if (asRoot) await run('sudo',['-n','rm','-rf','--',dir])
    else fs.rmSync(dir,{recursive:true,force:true})
  }
})

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
  await privileged('python3',[backup,'restore','--root',restored,'--release',release,'--archive',archive,'--name','restore-smoke'])
  assert.equal(fs.existsSync(path.join(restored,'.restore-in-progress')),false)
  // A new process reloads the restored SQLite binding and rehashes its wheels.
  await privileged(process.execPath,['--import','tsx',fixture,'run',restored])
  const after = JSON.parse(fs.readFileSync(path.join(restored,'run-summary.json'),'utf8'))
  assert.notEqual(after.attemptId,before.attemptId)
  delete before.attemptId; delete after.attemptId
  assert.deepEqual(after,before)
  assert.ok(after.packages.length >= 2)
})
