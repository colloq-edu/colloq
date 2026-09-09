import './_env.mts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import express, {type Response} from 'express'
import http from 'node:http'
import {STAFF_COOKIE} from '../shared/admin.js'
import {issueStaffCookie} from '../server/src/admin/auth.js'
import {createTeacher,rotateLinkKey} from '../server/src/admin/store.js'
import {createSession,finishedAt} from '../server/src/db.js'
import {saveDraft,requestAttemptRun,attemptOf,resetCouncilCache} from '../server/src/council.js'
import {adminInstanceRoutes} from '../server/src/routes/admin-instance.js'

test('finishing through the admin API clears persisted requests before a later resume',async()=>{
 const owner=createTeacher({name:'Request reviewer',email:'request-reviewer@test.local',role:'owner'})!
 rotateLinkKey(owner.id)
 let value=''
 issueStaffCookie({cookie:(_name:string,v:string)=>{value=v}} as unknown as Response,owner)
 const cookie=`${STAFF_COOKIE}=${value}`
 createSession('request-admin-close','Approval cleanup')
 saveDraft('request-admin-close','cell','author','print(1)',1)
 assert.ok(requestAttemptRun('request-admin-close','cell','author',2))
 const app=express();app.use(express.json());app.use(adminInstanceRoutes())
 const server=http.createServer(app)
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 try{
  for(const finished of [true,false]){
   const response=await fetch(base+'/api/admin/seminars/request-admin-close',{method:'PATCH',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({finished})})
   assert.equal(response.status,200)
   resetCouncilCache('request-admin-close')
   assert.equal(attemptOf('request-admin-close','cell','author')?.runRequest,null)
   assert.equal(finishedAt('request-admin-close')!==null,finished)
  }
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
})
