import { Router, type Request, type Response } from 'express'
import { requireStaff } from '../admin/auth.js'
import { requireEntrant, type EntrantRequest } from '../competitions/identity.js'
import { findCompetition, getCompetition } from '../competitions/store.js'
import { submissionsOpen, type Competition } from '@shared/competitions'
import { dependencyActive } from '@shared/dependencies'
import * as service from './service.js'
import * as store from './store.js'
import { dependencyMessage } from './messages.js'
import { ensureCompetitionRevision } from './revisions.js'

type Handler=(req:Request,res:Response)=>unknown|Promise<unknown>
const endpoint=(fn:Handler)=>(req:Request,res:Response):void=>{void Promise.resolve().then(()=>fn(req,res)).catch(error=>{
 if(res.headersSent)return
 const code=error instanceof store.DependencyStoreError?error.code:'dependency_image'
 res.status(error instanceof store.DependencyStoreError?error.status:503).json({reason:code,error:dependencyMessage(code)})
})}
function visible(req:Request):Competition{
 const c=findCompetition(String(req.params.slug))
 if(!c||c.state==='draft')throw new store.DependencyStoreError('dependency_owner',404)
 return c
}
function teacherCompetition(req:Request):Competition{
 const c=getCompetition(String(req.params.id));if(!c)throw new store.DependencyStoreError('dependency_owner',404);return c
}
const entrant=(req:Request):string=>(req as EntrantRequest).entrant!.id
function requirements(req:Request):string{
 if(typeof req.body?.requirementsText!=='string')throw new store.DependencyStoreError('invalid_requirement',400)
 return store.checkRequirements(req.body.requirementsText)
}
export function dependencyRoutes():Router{
 const r=Router(),base='/api/k/competitions/:slug/dependencies',admin='/api/admin/competitions/:id/dependencies'
 r.use(base,requireEntrant)
 r.get(base,endpoint(async(req,res)=>res.json(await service.dependencyOverview(visible(req),entrant(req)))))
 r.put(base+'/draft',endpoint(async(req,res)=>{
  const c=visible(req),eid=entrant(req)
  if(!service.hasJoined(c.id,eid))throw new store.DependencyStoreError('dependency_join',403)
  const text=requirements(req)
  await service.executionRevision(c)
  store.saveDraft(c.id,eid,{requirementsText:text,...(req.body.selectedBundleId===undefined?{}:{selectedBundleId:req.body.selectedBundleId})})
  res.json(await service.dependencyOverview(c,eid))
 }))
 r.post(base+'/prepare',endpoint(async(req,res)=>{
  const c=visible(req)
  if(submissionsOpen(c,Date.now())!=='open')throw new store.DependencyStoreError('dependency_closed',403)
  const bundle=await service.prepareBundle(c,entrant(req),requirements(req));res.status(202).json({bundle})
 }))
 r.get(base+'/:bundleId',endpoint((req,res)=>{const c=visible(req);res.json(service.ownBundle(c.id,entrant(req),String(req.params.bundleId)))}))
 r.post(base+'/:bundleId/cancel',endpoint(async(req,res)=>{
  const c=visible(req),b=service.ownBundle(c.id,entrant(req),String(req.params.bundleId));res.json(await service.cancelPreparation(b.id))
 }))
 r.get(base+'/:bundleId/lock',endpoint((req,res)=>{
  const c=visible(req),b=service.ownBundle(c.id,entrant(req),String(req.params.bundleId));const lock=store.lockOf(b.id)
  if(lock===null)throw new store.DependencyStoreError('dependency_not_ready')
  res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="requirements-set-${b.number}.lock"`);res.setHeader('Cache-Control','no-store');res.send(lock)
 }))
 r.get(base+'/:bundleId/stream',endpoint((req,res)=>{
  const c=visible(req),eid=entrant(req),b=service.ownBundle(c.id,eid,String(req.params.bundleId))
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'})
  let closed=false
  let stop=()=>{}
  let ping:ReturnType<typeof setInterval>|null=null
  const close=()=>{if(closed)return;closed=true;if(ping)clearInterval(ping);stop()}
  const push=()=>{
   if(closed)return
   const fresh=store.getBundle(b.id)
   if(!fresh||res.writableLength>512*1024){close();res.end();return}
   res.write(`event: state\ndata: ${JSON.stringify(fresh)}\n\n`)
   if(!dependencyActive(fresh.state)){close();res.end()}
  }
  stop=service.watchBundle(b.id,push)
  ping=setInterval(()=>res.write(': keep-alive\n\n'),20000)
  res.on('close',close)
  push()
 }))
 r.use(admin,requireStaff)
 r.get(admin,endpoint(async(req,res)=>res.json(await service.adminDependencyOverview(teacherCompetition(req)))))
 r.patch(admin+'/policy',endpoint(async(req,res)=>{
  const c=teacherCompetition(req),body=req.body??{}
  if(body.enabled!==undefined&&typeof body.enabled!=='boolean')throw new store.DependencyStoreError('dependency_limits',400)
  store.setPolicy(c.id,{...(body.enabled===undefined?{}:{enabled:body.enabled}),...(body.maxDownloadBytes===undefined?{}:{maxDownloadBytes:body.maxDownloadBytes})})
  res.json(await service.adminDependencyOverview(c))
 }))
 r.post(admin+'/refresh-base',endpoint(async(req,res)=>{
  const c=teacherCompetition(req);await ensureCompetitionRevision(c,true);res.json(await service.adminDependencyOverview(c))
 }))
 r.post(admin+'/:bundleId/cancel',endpoint(async(req,res)=>{
  const c=teacherCompetition(req),b=store.getBundle(String(req.params.bundleId))
  if(!b||b.competitionId!==c.id)throw new store.DependencyStoreError('dependency_owner',404)
  res.json(await service.cancelPreparation(b.id))
 }))
 return r
}
