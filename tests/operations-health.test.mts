import './_env.mts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {app} from '../server/src/app.js'
import {createTeacher} from '../server/src/admin/store.js'
import {issueStaffCookie} from '../server/src/admin/auth.js'

test('operational counters require staff and health reports separate executor capabilities',async()=>{
 const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const denied=await fetch(origin+'/api/instance/operations');assert.equal(denied.status,401);
  let cookie='';issueStaffCookie({cookie:(name:string,value:string)=>cookie=`${name}=${value}`} as any,createTeacher({name:'Ops',email:'ops@test.local',role:'owner'})!);
  const response=await fetch(origin+'/api/instance/operations',{headers:{cookie}});assert.equal(response.status,200);const status=await response.json();
  assert.equal(status.capabilities.execution.available,true);assert.equal(status.reservations.jobs,0);assert.equal(status.queues.competitions.waiting,0);assert.equal(status.queues.preparations.waiting,0);
  assert.equal(typeof status.storage.freeBytes,'number');assert.equal(typeof status.persistence.saveFailures,'number');assert.equal(typeof status.persistence.oldestUnsavedMs,'number');
  assert(!JSON.stringify(status).includes('setup-token'));assert(!JSON.stringify(status).includes('sessionSecret'));
  const health=await(await fetch(origin+'/api/health')).json();assert.equal(health.capabilities.execution.available,true);assert.equal(health.capabilities.preparation.available,true);
 }finally{server.closeAllConnections();server.close()}
});
