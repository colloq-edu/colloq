import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createCompetition, createEntrant, acceptSubmission, takeNext, queueRow, nextQueueRow, deferResourceAttempt, leaveQueue, getSubmission, updateCompetition, updateSubmission, listRuns, queueRows, setQueuePaused } from '../server/src/competitions/store.js'
import { putOpenFile, putSecretFile, putSubmissionNotebook } from '../server/src/competitions/storage.js'
import { putRevision, selectRevision, bindSubmission } from '../server/src/dependencies/store.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { CompetitionResourcePending } from '../server/src/competitions/broker-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { pumpOnce, settleCompetitionWork } from '../server/src/competitions/runner.js'
import { waitingEligibilityOrder } from '../server/src/competitions/panel.js'

test('queue presentation places eligible work before delayed resource retries',()=>{
  const rows=[
    {submissionId:'deferred',entrantId:'one',turn:0,enqueuedAt:1,notBefore:6000},
    {submissionId:'eligible',entrantId:'two',turn:1,enqueuedAt:2,notBefore:0},
  ]
  const ordered=waitingEligibilityOrder(rows,new Set<string>(),1000)
  assert.deepEqual(ordered.eligible.map(row=>row.submissionId),['eligible'])
  assert.deepEqual(ordered.deferred.map(row=>row.submissionId),['deferred'])
})

test('unschedulable attempt defers durably without consuming restart attempts',()=>{
  const competition=createCompetition({slug:'retry-'+randomUUID(),title:'Retry'})!
  const entrant=createEntrant('Retry').entrant
  const submission=acceptSubmission({competitionId:competition.id,entrantId:entrant.id,fileName:'notebook.ipynb',bytes:1,at:500})
  const first=takeNext({at:1000})!
  assert.equal(first.attempts,1)
  assert.equal(deferResourceAttempt(first,'Waiting for competition resources',1000),6000)
  assert.equal(queueRow(submission.id)?.state,'waiting')
  assert.equal(queueRow(submission.id)?.attempts,0)
  assert.equal(queueRow(submission.id)?.resourceRetries,1)
  assert.equal(nextQueueRow(5999),null)
  assert.equal(nextQueueRow(6000)?.submissionId,submission.id)
  const second=takeNext({at:6000})!
  assert.equal(second.attempts,1)
  assert.equal(deferResourceAttempt(second,'Waiting for competition resources',6000),16000)
  assert.equal(queueRow(submission.id)?.resourceRetries,2)
  const scorer=takeNext({at:16000})!
  deferResourceAttempt(scorer,'Waiting for scorer resources',16000,'Scorer Pod unschedulable','metric')
  assert.equal(queueRow(submission.id)?.kind,'metric')
  leaveQueue(submission.id)
})

test('infeasible 64 GiB notebook remains queued, then scores after lowering the limit',async()=>{
  for(const row of queueRows())leaveQueue(row.submissionId)
  setQueuePaused(false)
  const competition=createCompetition({slug:'large-'+randomUUID(),title:'Large',blurb:'',description:'',metric:{name:'score',direction:'lower',code:'def score(solution, submission):\n return 1.0'},publicPercent:30,
    limits:{wallSeconds:600,memoryMb:65536,cpus:2,perDay:0},environment:'base'})!
  putOpenFile(competition.id,'sample_submission.csv',Buffer.from('id,target\n1,0\n'))
  putSecretFile(competition.id,'solution.csv',Buffer.from('id,target\n1,1\n'))
  const entrant=createEntrant('Memory retry').entrant
  const submission=acceptSubmission({competitionId:competition.id,entrantId:entrant.id,fileName:'notebook.ipynb',bytes:100})
  putSubmissionNotebook(competition.id,submission.id,Buffer.from(JSON.stringify({cells:[{cell_type:'code',source:'pass',metadata:{},outputs:[]}],metadata:{},nbformat:4,nbformat_minor:5})))
  const revision=putRevision({environmentName:'base',imageDigest:`registry/base@sha256:${'f'.repeat(64)}`,pythonVersion:'3.12.1',pythonAbi:'cp312',platform:'linux/x86_64',packages:[{name:'pip',version:'25'}],baseConstraintsHash:'f'})
  selectRevision(competition.id,revision.id)
  bindSubmission(submission.id,revision.id,null)
  updateSubmission(submission.id,{publicScore:0.3,privateScore:0.4})
  const runner=new FakeCompetitionRunner()
  runner.availableMb=null
  Object.defineProperty(runner,'backend',{value:'broker'})
  const actualRun=runner.run.bind(runner)
  let launches=0
  runner.run=async request=>{launches++;if(request.limits.memoryMb>4096)throw new CompetitionResourcePending('memory');return actualRun(request)}
  useCompetitionRunner(runner)
  try {
    assert.equal(await pumpOnce(),1)
    await settleCompetitionWork()
    const waiting=queueRow(submission.id)!
    assert.equal(waiting.state,'waiting')
    assert.equal(waiting.attempts,0)
    assert.equal(waiting.resourceRetries,1)
    assert.ok(waiting.notBefore>Date.now())
    assert.equal(listRuns(submission.id).length,0)
    assert.equal(getSubmission(submission.id)?.state,'queued')
    assert.equal(getSubmission(submission.id)?.publicScore,0.3)
    assert.match(getSubmission(submission.id)?.participantError??'',/resources|ресурс/i)
    assert.equal(await pumpOnce(),0)
    updateCompetition(competition.id,{limits:{memoryMb:4096}})
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,waiting.notBefore-Date.now()+20)))
    assert.equal(await pumpOnce(),1)
    await settleCompetitionWork()
    assert.equal(launches,2)
    assert.equal(queueRow(submission.id),null)
    assert.equal(getSubmission(submission.id)?.state,'scored')
  }finally{useCompetitionRunner(null);leaveQueue(submission.id)}
})
