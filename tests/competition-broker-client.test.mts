import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { RuntimeClient } from '../server/src/kernel/runtime-client.js'

const jobId = 'a'.repeat(32)
const revision = `sha256:${'b'.repeat(64)}`
const intent = {schemaVersion:1,jobId,kind:'notebook',environment:'kaggle-base',revision,
  competitionId:'abcdefgh',submissionId:'bcdefghi',attemptId:'c'.repeat(32),
  limits:{wallSeconds:600,memoryMb:4096,cpus:2,pids:256,tmpfsMb:512,targetBytes:64*1024*1024}}
const status = {jobId,kind:'notebook',phase:'complete',startedAt:1,finishedAt:2,exitCode:0,oomKilled:false,progress:null,error:null}

test('competition job client uses typed routes and rejects substituted job identity', async () => {
  const seen:Array<{method?:string;url?:string;body:string}> = []
  let reply:unknown = status
  const server = http.createServer(async(req,res) => {
    let body=''; for await (const part of req) body+=part
    seen.push({method:req.method,url:req.url,body})
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify(reply))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address() as {port:number}
  const client=new RuntimeClient({url:`http://127.0.0.1:${address.port}`,token:'a'.repeat(64)})
  try {
    assert.deepEqual(await client.startCompetitionJob(intent),status)
    assert.deepEqual(await client.competitionJob(jobId),status)
    reply={files:[{name:'wheels/example-1.0-py3-none-any.whl',bytes:4,sha256:'d'.repeat(64)}],totalBytes:4}
    assert.deepEqual(await client.collectCompetitionJob(jobId),reply)
    reply={ok:true}
    await client.cancelCompetitionJob(jobId)
    reply={jobs:[status]}
    assert.deepEqual(await client.competitionJobs(),[status])
    assert.deepEqual(seen.map(x=>[x.method,x.url]),[
      ['POST',`/v1/competition-jobs/${jobId}`],['GET',`/v1/competition-jobs/${jobId}`],
      ['POST',`/v1/competition-jobs/${jobId}/collect`],['DELETE',`/v1/competition-jobs/${jobId}`],
      ['GET','/v1/competition-jobs'],
    ])
    assert.deepEqual(JSON.parse(seen[0].body),intent)
    reply={...status,jobId:'f'.repeat(32)}
    await assert.rejects(()=>client.competitionJob(jobId),/job|identity/i)
    await assert.rejects(()=>client.competitionJob('../escape'),/job|identity/i)
    assert.equal(seen.length,6)
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())) }
})
