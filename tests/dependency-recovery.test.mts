import './_env.mts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createCompetition, createEntrant, setCompetitionState, deleteCompetition } from '../server/src/competitions/store.js'
import * as store from '../server/src/dependencies/store.js'
import * as files from '../server/src/dependencies/files.js'
import { PREPARATION_PYTHON } from '../server/src/dependencies/preparation-python.js'
import { config } from '../server/src/config.js'

async function published(){
 const c=createCompetition({slug:'recovery-'+randomUUID(),title:'Recovery',environment:'base'})!;setCompetitionState(c.id,'live');
 const e=createEntrant('Recovery').entrant;
 const r=store.putRevision({environmentName:'base',imageDigest:'sha256:'+'a'.repeat(64),pythonVersion:'3.11.16',pythonAbi:'cp311',platform:'linux/arm64',packages:[{name:'pip',version:'25.1'}],baseConstraintsHash:'hash'});
 store.selectRevision(c.id,r.id);store.setPolicy(c.id,{enabled:true});const b=store.createBundle(c.id,e.id,r.id,'fixture==1');
 const bytes=Buffer.from('fixture '+b.id),sha256=createHash('sha256').update(bytes).digest('hex');
 const pkg={name:'fixture',version:'1',fileName:'fixture-1-py3-none-any.whl',sha256,bytes:bytes.length};
 const result={normalizedRequirements:['fixture==1'],packages:[pkg],downloadBytes:bytes.length,installedBytes:bytes.length,contentHash:sha256,lock:'fixture'};
 const stage=files.freshStaging(b.id);fs.mkdirSync(path.join(stage,'wheels'));fs.writeFileSync(path.join(stage,'wheels',pkg.fileName),bytes);
 await files.publishBundle(b.id,result);store.completeBundle(b.id,result);files.removeStaging(b.id);return{c,b,pkg};
}
test('reconciliation releases deleted competition bundles while preserving live and recent publication',async()=>{
 const old=await published(),live=await published();deleteCompetition(old.c.id);
 const cutoff=Date.now()-3600000;fs.utimesSync(files.bundleDir(old.b.id),new Date(cutoff-1000),new Date(cutoff-1000));
 const pending=randomUUID().replaceAll('-','');fs.mkdirSync(files.bundleDir(pending));
 const known=new Set([live.b.id]);
 // The fallback is the pre-fix behavior: the storage layer has no bundle reconciliation.
 (files as typeof files & {reconcileBundles?:(known:Set<string>,before:number)=>number}).reconcileBundles?.(known,cutoff);
 for(const h of store.orphanArtifacts()){files.removeArtifactFile(h);store.removeOrphanArtifact(h)}
 assert.equal(fs.existsSync(files.bundleDir(old.b.id)),false,'orphan hardlinks must be released');
 assert.equal(fs.existsSync(path.join(files.bundleDir(live.b.id),'wheels',live.pkg.fileName)),true);
 assert.equal(fs.existsSync(files.bundleDir(pending)),true,'grace period protects an in-progress publication');
});
test('Python and intake count meaningful requirements, keeping comments outside the line budget',()=>{
 const input=Array.from({length:32},()=> '# comment').join('\n')+'\npip';assert.equal(store.checkRequirements(input),input);
 const program="__name__='test'\n"+PREPARATION_PYTHON+"\nprint(len(parse_requirements("+JSON.stringify(input)+", [])))\n";
 const result=spawnSync('python3',['-c',program],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'1');
});
test('preparation resources have distinct ownership for distinct host data roots',()=>{
 const root=path.join(config.dataDir,'scope');fs.mkdirSync(root,{recursive:true});const bin=path.join(root,'bin');fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,'docker'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CHECK_COMMANDS,JSON.stringify(process.argv.slice(2))+'\\n')\n`,{mode:0o755});
 const probe=path.join(root,'probe.mts');fs.writeFileSync(probe,`process.env.DATA_DIR=process.env.CHECK_DATA;process.env.DATA_HOST_DIR=process.env.CHECK_HOST;const {cleanupPreparationResources}=await import(${JSON.stringify(path.join(process.cwd(),'server/src/dependencies/preparation.ts'))});await cleanupPreparationResources();`);
 const filters:string[]=[];for(const instance of ['a','b']){
  const log=path.join(root,instance+'.log');const result=spawnSync(process.execPath,['--import','tsx',probe],{encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CHECK_DATA:root,CHECK_HOST:'/srv/'+instance+'/data',CHECK_COMMANDS:log}});
  assert.equal(result.status,0,result.stderr);const commands=fs.readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));filters.push(commands.find(a=>a[0]==='ps').at(-1));
 }
 assert.notEqual(filters[0],filters[1]);
});
