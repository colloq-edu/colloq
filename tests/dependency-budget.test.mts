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
import {DependencyPreparationError} from '../server/src/dependencies/preparation-contract.js'
import {dependencyMessage} from '../server/src/dependencies/messages.js'
import {setLocaleResolver} from '../shared/i18n.js'
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

test('a failure is stored with its numbers and text, and the log keeps our steps as codes',async()=>{
 const {c,e,r}=fixture(),b=createBundle(c.id,e.id,r.id,'xgboost'),stat=fs.statfsSync;
 fs.statfsSync=(()=>({bavail:4096*MiB,bsize:1})) as typeof fs.statfsSync;
 setLocaleResolver(()=>'ru');
 const params={bytes:640*MiB,limitBytes:512*MiB,heaviest:[{name:'nvidia-nccl-cu12',bytes:330*MiB},{name:'xgboost',bytes:300*MiB}]};
 try{
  await processNextPreparation(async request=>{
   request.onProgress?.({state:'resolving',log:{code:'resolve'}});
   request.onProgress?.({state:'downloading',log:{code:'download',params:{count:2,'<b>':'x'}}});
   request.onProgress?.({state:'downloading',log:{code:'unknown'} as never});
   throw new DependencyPreparationError('installed_limit','The unpacked packages exceed the installed size limit.',undefined,{params});
  });
  const failed=getBundle(b.id)!;
  assert.equal(failed.error?.code,'installed_limit');assert.deepEqual(failed.error?.params,params);
  assert.equal(failed.error?.message,'Распакованный набор — 640 МБ при лимите 512 МБ. Больше всего весят: nvidia-nccl-cu12 (330 МБ), xgboost (300 МБ). У xgboost есть сборка без CUDA: укажите xgboost-cpu вместо xgboost.');
  assert.deepEqual(failed.log,[{code:'resolve'},{code:'download',params:{count:2}}],'no English failure line and no step that is not ours');
  setLocaleResolver(()=>'en');
  assert.equal(dependencyMessage('installed_limit',params,'xgboost'),'Unpacked, the set is 640 MB; the limit is 512 MB. The heaviest are nvidia-nccl-cu12 (330 MB), xgboost (300 MB). xgboost has a build without CUDA: use xgboost-cpu instead of xgboost.');
  setLocaleResolver(()=>'ru');
  // A failure without a text of its own still leaves its detail, without the staging path.
  const odd=createBundle(c.id,e.id,r.id,'fixture==2');
  await processNextPreparation(async request=>{throw new Error('fixture exploded in '+request.workDir)});
  assert.equal(getBundle(odd.id)?.error?.code,'preparation_failed');assert.equal(getBundle(odd.id)?.log.at(-1),'fixture exploded in [work]');
 }finally{fs.statfsSync=stat;setLocaleResolver(()=>'ru')}
});
