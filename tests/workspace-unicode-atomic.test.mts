import './_env.mts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {createSession} from '../server/src/db.js'
import {workspaceFs,makeFile,copyFile,writeText,readText,freeCopyName} from '../server/src/workspace.js'

test('atomic copy and save fit Linux filename bytes for an accepted Unicode name',()=>{
 const id='unicode-atomic';createSession(id,'Unicode',null);const name='о'.repeat(112)+'.csv';makeFile(id,name,'before');
 const original=workspaceFs.openSync;const names:string[]=[];
 workspaceFs.openSync=((file:any,...args:any[])=>{
  const base=path.basename(String(file));names.push(base);
  if(Buffer.byteLength(base)>255){const e=Object.assign(new Error('File name too long'),{code:'ENAMETOOLONG'});throw e}
  return (original as any).call(workspaceFs,file,...args);
 }) as any;
 try{assert.equal(copyFile(id,name,freeCopyName(id,name)),'ok');assert.equal(writeText(id,name,'after'),true);assert.equal(readText(id,name)?.text,'after');}
 finally{workspaceFs.openSync=original}
 assert(names.every(n=>Buffer.byteLength(n)<=255));
});


test('file path validation rejects names exceeding filesystem UTF-8 byte capacity',async()=>{
 const {safeSegment,whySegmentRefused}=await import('../shared/paths.js')
 assert.equal(safeSegment('界'.repeat(90)),false)
 assert.match(whySegmentRefused('界'.repeat(90)),/байт|bytes/)
})
