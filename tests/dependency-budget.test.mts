import './_env.mts'
import '../server/src/competitions/fake-runner.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {createCompetition,createEntrant,setCompetitionState,joinCompetition,getCompetition} from '../server/src/competitions/store.js'
import {putRevision,selectRevision,setPolicy,listBundles,createBundle,getBundle,lockOf} from '../server/src/dependencies/store.js'
import {prepareBundle,processNextPreparation} from '../server/src/dependencies/service.js'
import {bundleDir,stagingDir} from '../server/src/dependencies/files.js'
import {workBudgetSnapshot} from '../server/src/ops/work-budget.js'
const MiB=1024*1024
function fixture(){
 const c=createCompetition({slug:'budget-'+randomUUID(),title:'Budget',environment:'base'})!;setCompetitionState(c.id,'live');const e=createEntrant('Budget').entrant;joinCompetition(c.id,e.id,e.name);
 const r=putRevision({environmentName:'base',imageDigest:'sha256:'+'a'.repeat(64),pythonVersion:'3.11.16',pythonAbi:'cp311',platform:'linux/arm64',packages:[{name:'pip',version:'25.1'}],baseConstraintsHash:'hash'});selectRevision(c.id,r.id);setPolicy(c.id,{enabled:true});return{c:getCompetition(c.id)!,e,r};
}
test('intake refuses insufficient peak publication space before consuming preparation quota',async()=>{
 const {c,e}=fixture(),stat=fs.statfsSync;
 fs.statfsSync=(()=>({bavail:900,bsize:MiB})) as typeof fs.statfsSync;
 try{await assert.rejects(prepareBundle(c,e.id,'fixture==1'),{code:'disk_full'});assert.equal(listBundles(c.id,e.id).length,0)}finally{fs.statfsSync=stat}
});
test('disk exhaustion between verification and publication fails cleanly and releases reservations',async()=>{
 const {c,e,r}=fixture(),b=createBundle(c.id,e.id,r.id,'fixture==1'),stat=fs.statfsSync;
 let free=4096*MiB;fs.statfsSync=(()=>({bavail:free,bsize:1})) as typeof fs.statfsSync;
 try{
  await processNextPreparation(async request=>{
   assert.equal(workBudgetSnapshot().byKind.preparation,1);
   const bytes=Buffer.from('small fixture'),hash=createHash('sha256').update(bytes).digest('hex'),name='fixture-1-py3-none-any.whl';
   fs.mkdirSync(path.join(request.workDir,'wheels'));fs.writeFileSync(path.join(request.workDir,'wheels',name),bytes);free=0;
   return{normalizedRequirements:['fixture==1'],packages:[{name:'fixture',version:'1',fileName:name,sha256:hash,bytes:bytes.length}],downloadBytes:bytes.length,installedBytes:bytes.length,contentHash:hash,lock:'fixture'};
  });
  assert.equal(getBundle(b.id)?.state,'failed');assert.equal(getBundle(b.id)?.error?.code,'disk_full');assert.equal(lockOf(b.id),null);
  assert.equal(fs.existsSync(bundleDir(b.id)),false);assert.equal(fs.existsSync(stagingDir(b.id)),false);assert.equal(workBudgetSnapshot().jobs,0);
 }finally{fs.statfsSync=stat}
});
