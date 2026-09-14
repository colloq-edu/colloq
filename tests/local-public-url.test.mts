import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireLease, renewLease, releaseLease, readLeaseUrl } from '../server/src/local/public-url-lease.ts'

test('temporary URLs expire, reject other sessions, and preserve newer tunnel ownership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-lease-'))
  const file = path.join(dir, 'public.json')
  try {
    assert.equal(readLeaseUrl(file, 'run', 100), null)
    acquireLease(file, { runId: 'run', owner: 'one', url: 'https://one.example/' }, 100, 1000)
    assert.equal(readLeaseUrl(file, 'run', 200), 'https://one.example')
    assert.equal(readLeaseUrl(file, 'other', 200), null)
    assert.throws(() => acquireLease(file, {runId:'run',owner:'two',url:'https://two.example'},200,1000), /already/)
    assert.equal(renewLease(file, 'run', 'wrong', 300, 1000), false)
    assert.equal(readLeaseUrl(file, 'run', 1100), null)
    acquireLease(file, {runId:'run',owner:'two',url:'https://two.example'},1200,1000)
    assert.equal(releaseLease(file, 'run', 'one'), false)
    assert.equal(renewLease(file, 'run', 'one',1300,1000), false)
    assert.equal(readLeaseUrl(file, 'run',1300),'https://two.example')
    assert.equal(renewLease(file, 'run', 'two',2000,1000),true)
    assert.equal(readLeaseUrl(file, 'run',2500),'https://two.example')
    assert.equal(releaseLease(file,'run','two'),true)
    assert.equal(readLeaseUrl(file,'run',2500),null)
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})

test('invalid lease content and unsafe addresses never become public URLs', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-lease-'))
  const file=path.join(dir,'public.json')
  try {
    for(const value of ['{','null',JSON.stringify({runId:'run',owner:'one',expiresAt:10000,url:'javascript:alert(1)'})]) {
      fs.writeFileSync(file,value)
      assert.equal(readLeaseUrl(file,'run',100),null)
    }
    assert.throws(()=>acquireLease(file,{runId:'run',owner:'one',url:'https://user:password@example.org'},100),/URL/)
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})

test('local config ignores persistent PUBLIC_URL and uses an expiring address only for its run', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-local-config-'))
  const file=path.join(dir,'public.json')
  try {
    const env={...process.env,SESSION_SECRET:'test',DATA_DIR:dir,COLLOQ_LOCAL_SESSION:'1',COLLOQ_LOCAL_RUN_ID:'run',COLLOQ_LOCAL_URL:'http://localhost:5173',COLLOQ_PUBLIC_URL_LEASE_FILE:file,PUBLIC_URL:'https://persistent.example'}
    const read=()=>{
      const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {config} from './server/src/config.ts'; process.stdout.write(config.publicUrl)"],{env,encoding:'utf8'})
      assert.equal(result.status,0,result.stderr)
      return result.stdout
    }
    assert.equal(read(),'http://localhost:5173')
    acquireLease(file,{runId:'run',owner:'one',url:'https://temporary.example'})
    assert.equal(read(),'https://temporary.example')
    releaseLease(file,'run','one')
    assert.equal(read(),'http://localhost:5173')
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
