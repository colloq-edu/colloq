/** Durable dependency jobs and immutable submission/environment bindings. */
import { randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { DEPENDENCY_LIMITS, dependencyActive, type DependencyBundle, type DependencyDraft, type DependencyPolicy, type EnvironmentRevision, type SubmissionEnvironment } from '@shared/dependencies'
import type { PreparationProgress, PreparationResult } from './preparation-contract.js'
import { submissionsOpen, type CompetitionState } from '@shared/competitions'

const id = () => randomUUID().replaceAll('-', '')
export class DependencyStoreError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); this.name = 'DependencyStoreError' }
}

db.exec(`
CREATE TABLE IF NOT EXISTS environment_revisions (
 id TEXT PRIMARY KEY, environment_name TEXT NOT NULL, image_digest TEXT NOT NULL,
 python_version TEXT NOT NULL, python_abi TEXT NOT NULL, platform TEXT NOT NULL,
 packages_json TEXT NOT NULL, constraints_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(environment_name,image_digest)
);
CREATE TABLE IF NOT EXISTS competition_dependency_policies (
 competition_id TEXT PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0, max_download_bytes INTEGER NOT NULL,
 max_installed_bytes INTEGER NOT NULL, revision_id TEXT REFERENCES environment_revisions(id)
);
CREATE TABLE IF NOT EXISTS dependency_drafts (
 competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
 entrant_id TEXT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
 requirements_text TEXT NOT NULL DEFAULT '', selected_bundle_id TEXT,
 next_number INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
 PRIMARY KEY(competition_id,entrant_id)
);
CREATE TABLE IF NOT EXISTS dependency_bundles (
 id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
 entrant_id TEXT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
 number INTEGER NOT NULL, revision_id TEXT NOT NULL REFERENCES environment_revisions(id),
 requirements_text TEXT NOT NULL, normalized_json TEXT NOT NULL DEFAULT '[]',
 state TEXT NOT NULL, packages_json TEXT NOT NULL DEFAULT '[]',
 download_bytes INTEGER NOT NULL DEFAULT 0, installed_bytes INTEGER NOT NULL DEFAULT 0,
 max_download_bytes INTEGER NOT NULL, max_installed_bytes INTEGER NOT NULL,
 content_hash TEXT, lock_text TEXT, error_json TEXT, log_json TEXT NOT NULL DEFAULT '[]',
 created_at INTEGER NOT NULL, ready_at INTEGER,
 UNIQUE(competition_id,entrant_id,number)
);
CREATE INDEX IF NOT EXISTS dependency_bundle_queue ON dependency_bundles(state,created_at);
CREATE INDEX IF NOT EXISTS dependency_bundle_owner ON dependency_bundles(entrant_id,created_at);
CREATE TABLE IF NOT EXISTS dependency_artifacts (
 sha256 TEXT PRIMARY KEY, file_name TEXT NOT NULL, distribution TEXT NOT NULL,
 version TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dependency_bundle_artifacts (
 bundle_id TEXT NOT NULL REFERENCES dependency_bundles(id) ON DELETE CASCADE,
 sha256 TEXT NOT NULL REFERENCES dependency_artifacts(sha256),
 PRIMARY KEY(bundle_id,sha256)
);
CREATE TABLE IF NOT EXISTS submission_environments (
 submission_id TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
 revision_id TEXT REFERENCES environment_revisions(id),
 bundle_id TEXT REFERENCES dependency_bundles(id), legacy INTEGER NOT NULL DEFAULT 0
);
`)

type Row = Record<string, string | number | null>
const json = <T>(value: Row[string], fallback: T): T => value ? JSON.parse(String(value)) as T : fallback
function toRevision(row: Row): EnvironmentRevision {
 return {id:String(row.id),environmentName:String(row.environment_name),imageDigest:String(row.image_digest),pythonVersion:String(row.python_version),pythonAbi:String(row.python_abi),platform:String(row.platform),packages:json(row.packages_json,[]),baseConstraintsHash:String(row.constraints_hash),createdAt:Number(row.created_at)}
}
export function getRevision(revisionId: string): EnvironmentRevision | null {
 const row=db.prepare('SELECT * FROM environment_revisions WHERE id=?').get(revisionId) as Row|undefined
 return row?toRevision(row):null
}
export function revisions(): EnvironmentRevision[] { return (db.prepare('SELECT * FROM environment_revisions').all() as Row[]).map(toRevision) }
export function putRevision(value: Omit<EnvironmentRevision,'id'|'createdAt'> & {createdAt?:number}): EnvironmentRevision {
 const existing=db.prepare('SELECT * FROM environment_revisions WHERE environment_name=? AND image_digest=?').get(value.environmentName,value.imageDigest) as Row|undefined
 if(existing)return toRevision(existing)
 const key=id();db.prepare('INSERT INTO environment_revisions VALUES (?,?,?,?,?,?,?,?,?)').run(key,value.environmentName,value.imageDigest,value.pythonVersion,value.pythonAbi,value.platform,JSON.stringify(value.packages),value.baseConstraintsHash,value.createdAt??Date.now())
 return getRevision(key)!
}
function policyRow(competitionId: string): Row {
 db.prepare('INSERT OR IGNORE INTO competition_dependency_policies (competition_id,max_download_bytes,max_installed_bytes) VALUES (?,?,?)').run(competitionId,DEPENDENCY_LIMITS.downloadBytes,DEPENDENCY_LIMITS.installedBytes)
 return db.prepare('SELECT * FROM competition_dependency_policies WHERE competition_id=?').get(competitionId) as Row
}
export function policyOf(competitionId: string): DependencyPolicy {
 const r=policyRow(competitionId);return {enabled:!!r.enabled,maxDownloadBytes:Number(r.max_download_bytes),maxInstalledBytes:Number(r.max_installed_bytes)}
}
export function competitionRevision(competitionId: string): EnvironmentRevision|null {
 const r=policyRow(competitionId);return r.revision_id?getRevision(String(r.revision_id)):null
}
export function selectRevision(competitionId: string, revisionId: string): void {
 policyRow(competitionId)
 if(!getRevision(revisionId))throw new DependencyStoreError('dependency_revision',404)
 db.prepare('UPDATE competition_dependency_policies SET revision_id=? WHERE competition_id=?').run(revisionId,competitionId)
}
export function setPolicy(competitionId: string, change: Partial<DependencyPolicy>): DependencyPolicy {
 const value={...policyOf(competitionId),...change}
 if(typeof value.enabled!=='boolean'||!Number.isInteger(value.maxDownloadBytes)||value.maxDownloadBytes<1024*1024||value.maxDownloadBytes>DEPENDENCY_LIMITS.downloadBytes||value.maxInstalledBytes!==DEPENDENCY_LIMITS.installedBytes) throw new DependencyStoreError('dependency_limits',400)
 db.prepare('UPDATE competition_dependency_policies SET enabled=?,max_download_bytes=? WHERE competition_id=?').run(value.enabled?1:0,value.maxDownloadBytes,competitionId)
 return value
}
export function checkRequirements(text: string): string {
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>DEPENDENCY_LIMITS.requestBytes||text.includes('\0')) throw new DependencyStoreError('dependency_limits',400)
 const normalized=text.replace(/\r\n?/g,'\n').trim()
 if(normalized.split('\n').filter(s=>s.trim()&&!s.trim().startsWith('#')).length>DEPENDENCY_LIMITS.lines)throw new DependencyStoreError('dependency_limits',400)
 return normalized
}
function ensureDraft(c: string,e: string): void {
 db.prepare('INSERT OR IGNORE INTO dependency_drafts(competition_id,entrant_id,updated_at) VALUES(?,?,?)').run(c,e,Date.now())
}
export function draftOf(c: string,e: string): DependencyDraft {
 ensureDraft(c,e);const row=db.prepare('SELECT * FROM dependency_drafts WHERE competition_id=? AND entrant_id=?').get(c,e) as Row
 return {requirementsText:String(row.requirements_text),selectedBundleId:row.selected_bundle_id?String(row.selected_bundle_id):null}
}
export function assertUsableBundle(c: string,e: string,revisionId: string,bundleId: string|null): DependencyBundle|null {
 if(!bundleId)return null
 const b=getBundle(bundleId)
 if(!b||b.competitionId!==c||b.entrantId!==e)throw new DependencyStoreError('dependency_owner',404)
 if(b.state!=='ready')throw new DependencyStoreError('dependency_not_ready')
 if(b.revisionId!==revisionId)throw new DependencyStoreError('dependency_revision')
 return b
}
export const saveDraft=db.transaction((c:string,e:string,value:{requirementsText:string;selectedBundleId?:string|null}):DependencyDraft=>{
 const text=checkRequirements(value.requirementsText);ensureDraft(c,e)
 if(value.selectedBundleId!==undefined){
  if(value.selectedBundleId!==null && typeof value.selectedBundleId!=='string')throw new DependencyStoreError('dependency_owner',400)
  assertUsableBundle(c,e,competitionRevision(c)?.id??'',value.selectedBundleId)
  db.prepare('UPDATE dependency_drafts SET selected_bundle_id=? WHERE competition_id=? AND entrant_id=?').run(value.selectedBundleId,c,e)
 }
 db.prepare('UPDATE dependency_drafts SET requirements_text=?,updated_at=? WHERE competition_id=? AND entrant_id=?').run(text,Date.now(),c,e)
 return draftOf(c,e)
})
function toBundle(r: Row): DependencyBundle {
 return {id:String(r.id),number:Number(r.number),competitionId:String(r.competition_id),entrantId:String(r.entrant_id),revisionId:String(r.revision_id),requirementsText:String(r.requirements_text),normalizedRequirements:json(r.normalized_json,[]),state:String(r.state) as DependencyBundle['state'],packages:json(r.packages_json,[]),downloadBytes:Number(r.download_bytes),installedBytes:Number(r.installed_bytes),contentHash:r.content_hash?String(r.content_hash):null,error:json(r.error_json,null),log:json(r.log_json,[]),createdAt:Number(r.created_at),readyAt:r.ready_at===null?null:Number(r.ready_at)}
}
export function getBundle(key: string): DependencyBundle|null {
 const r=db.prepare('SELECT * FROM dependency_bundles WHERE id=?').get(key) as Row|undefined;return r?toBundle(r):null
}
export function bundleLimits(key:string): Pick<DependencyPolicy,'maxDownloadBytes'|'maxInstalledBytes'> {
 const r=db.prepare('SELECT max_download_bytes,max_installed_bytes FROM dependency_bundles WHERE id=?').get(key) as Row
 return {maxDownloadBytes:Number(r.max_download_bytes),maxInstalledBytes:Number(r.max_installed_bytes)}
}
export function listBundles(c:string,e?:string):DependencyBundle[]{
 const rows=e?db.prepare('SELECT * FROM dependency_bundles WHERE competition_id=? AND entrant_id=? ORDER BY number DESC').all(c,e):db.prepare('SELECT * FROM dependency_bundles WHERE competition_id=? ORDER BY created_at DESC LIMIT 200').all(c)
 return (rows as Row[]).map(toBundle)
}
export const createBundle=db.transaction((c:string,e:string,revisionId:string,text:string,now=Date.now()):DependencyBundle=>{
 const competition=db.prepare('SELECT state,starts_at,deadline_at,environment FROM competitions WHERE id=?').get(c) as {state:CompetitionState;starts_at:number|null;deadline_at:number|null;environment:string}|undefined
 if(!competition||submissionsOpen({state:competition.state,startsAt:competition.starts_at,deadlineAt:competition.deadline_at},now)!=='open')throw new DependencyStoreError('dependency_closed',403)
 if(getRevision(revisionId)?.environmentName!==competition.environment)throw new DependencyStoreError('dependency_revision')
 const policy=policyOf(c);if(!policy.enabled)throw new DependencyStoreError('dependency_disabled',403)
 text=checkRequirements(text);if(!text||!text.split('\n').some(s=>s.trim()&&!s.trim().startsWith('#')))throw new DependencyStoreError('dependency_empty',400)
 if(competitionRevision(c)?.id!==revisionId)throw new DependencyStoreError('dependency_revision')
 const active=db.prepare("SELECT * FROM dependency_bundles WHERE entrant_id=? AND state IN ('queued','resolving','downloading','verifying') LIMIT 1").get(e) as Row|undefined
 if(active){const b=toBundle(active);if(b.competitionId===c&&b.revisionId===revisionId&&b.requirementsText===text)return b;throw new DependencyStoreError('dependency_active')}
 const count=db.prepare('SELECT COUNT(*) AS n FROM dependency_bundles WHERE entrant_id=? AND created_at>?').get(e,now-3600000) as {n:number}
 if(count.n>=DEPENDENCY_LIMITS.perHour)throw new DependencyStoreError('dependency_quota',429)
 ensureDraft(c,e);const row=db.prepare('SELECT next_number FROM dependency_drafts WHERE competition_id=? AND entrant_id=?').get(c,e) as Row
 const key=id();db.prepare('INSERT INTO dependency_bundles(id,competition_id,entrant_id,number,revision_id,requirements_text,state,max_download_bytes,max_installed_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,c,e,Number(row.next_number),revisionId,text,'queued',policy.maxDownloadBytes,policy.maxInstalledBytes,now)
 db.prepare('UPDATE dependency_drafts SET next_number=next_number+1,requirements_text=?,updated_at=? WHERE competition_id=? AND entrant_id=?').run(text,now,c,e)
 return getBundle(key)!
})
export const claimNextBundle=db.transaction(():DependencyBundle|null=>{
 if(db.prepare("SELECT 1 FROM dependency_bundles WHERE state IN ('resolving','downloading','verifying') LIMIT 1").get())return null
 const row=db.prepare("SELECT id FROM dependency_bundles WHERE state='queued' ORDER BY created_at,id LIMIT 1").get() as {id:string}|undefined
 if(!row)return null
 db.prepare("UPDATE dependency_bundles SET state='resolving' WHERE id=? AND state='queued'").run(row.id)
 return getBundle(row.id)
})
export function updateProgress(key:string,progress:PreparationProgress):void{
 const b=getBundle(key);if(!b||!dependencyActive(b.state))return
 const order=['queued','resolving','downloading','verifying'];if(order.indexOf(progress.state)<order.indexOf(b.state))return
 const logs=progress.log?[...b.log,progress.log.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(0,1000)].slice(-200):b.log
 db.prepare('UPDATE dependency_bundles SET state=?,normalized_json=?,download_bytes=?,installed_bytes=?,log_json=? WHERE id=?').run(progress.state,JSON.stringify(progress.normalizedRequirements??b.normalizedRequirements),progress.downloadBytes??b.downloadBytes,progress.installedBytes??b.installedBytes,JSON.stringify(logs),key)
}
export const completeBundle=db.transaction((key:string,result:PreparationResult):boolean=>{
 const b=getBundle(key);if(!b||!dependencyActive(b.state))return false
 for(const p of result.packages){
  db.prepare('INSERT OR IGNORE INTO dependency_artifacts VALUES(?,?,?,?,?,?)').run(p.sha256,p.fileName,p.name,p.version,p.bytes,Date.now())
  db.prepare('INSERT INTO dependency_bundle_artifacts VALUES(?,?)').run(key,p.sha256)
 }
 db.prepare("UPDATE dependency_bundles SET state='ready',normalized_json=?,packages_json=?,download_bytes=?,installed_bytes=?,content_hash=?,lock_text=?,error_json=NULL,ready_at=? WHERE id=?").run(JSON.stringify(result.normalizedRequirements),JSON.stringify(result.packages),result.downloadBytes,result.installedBytes,result.contentHash,result.lock,Date.now(),key)
 return true
})
export function failBundle(key:string,code:string,message:string,line?:number):void{
 const b=getBundle(key);if(!b||!dependencyActive(b.state))return
 db.prepare("UPDATE dependency_bundles SET state='failed',error_json=? WHERE id=?").run(JSON.stringify({code,message,...(line===undefined?{}:{line})}),key)
}
export function cancelBundle(key:string):DependencyBundle|null{
 const b=getBundle(key);if(b&&dependencyActive(b.state))db.prepare("UPDATE dependency_bundles SET state='cancelled' WHERE id=?").run(key)
 return getBundle(key)
}
export function recoverPreparations():number{
 return db.prepare("UPDATE dependency_bundles SET state='failed',error_json=? WHERE state IN ('resolving','downloading','verifying')").run(JSON.stringify({code:'worker_restarted',message:'Подготовка прервалась при перезапуске сервера. Повторите подготовку.'})).changes
}
export function lockOf(key:string):string|null{
 const row=db.prepare("SELECT lock_text FROM dependency_bundles WHERE id=? AND state='ready'").get(key) as Row|undefined;return row?.lock_text===null||!row?null:String(row.lock_text)
}
export interface SubmissionBinding { revision:EnvironmentRevision|null; bundle:DependencyBundle|null; legacy:boolean }
export function getBinding(sid:string):SubmissionBinding|null{
 const row=db.prepare('SELECT * FROM submission_environments WHERE submission_id=?').get(sid) as Row|undefined
 return row?{revision:row.revision_id?getRevision(String(row.revision_id)):null,bundle:row.bundle_id?getBundle(String(row.bundle_id)):null,legacy:!!row.legacy}:null
}
export function bindSubmission(sid:string,revisionId:string|null,bundleId:string|null,legacy=false):void{
 const current=db.prepare('SELECT * FROM submission_environments WHERE submission_id=?').get(sid) as Row|undefined
 if(current){if(current.revision_id!==revisionId||current.bundle_id!==bundleId)throw new DependencyStoreError('dependency_immutable');return}
 const submission=db.prepare('SELECT competition_id,entrant_id FROM submissions WHERE id=?').get(sid) as {competition_id:string;entrant_id:string}|undefined
 if(!submission)throw new DependencyStoreError('dependency_submission',404)
 if(bundleId)assertUsableBundle(submission.competition_id,submission.entrant_id,revisionId??'',bundleId)
 db.prepare('INSERT INTO submission_environments VALUES(?,?,?,?)').run(sid,revisionId,bundleId,legacy?1:0)
}
export function submissionEnvironment(sid:string,environmentName:string):SubmissionEnvironment{
 const b=getBinding(sid);return {revisionId:b?.revision?.id??null,environmentName:b?.revision?.environmentName??environmentName,pythonVersion:b?.revision?.pythonVersion??null,platform:b?.revision?.platform??null,bundleId:b?.bundle?.id??null,bundleNumber:b?.bundle?.number??null,legacy:b?.legacy??true}
}
export function unusedBundles(before:number):string[]{
 return (db.prepare(`SELECT id FROM dependency_bundles b WHERE b.created_at<? AND b.state IN ('ready','failed','cancelled')
 AND NOT EXISTS(SELECT 1 FROM submission_environments s WHERE s.bundle_id=b.id)
 AND NOT EXISTS(SELECT 1 FROM dependency_drafts d WHERE d.selected_bundle_id=b.id)`).all(before) as {id:string}[]).map(r=>r.id)
}
export function removeUnusedBundle(key:string):boolean{
 const referenced=db.prepare('SELECT 1 FROM submission_environments WHERE bundle_id=? UNION SELECT 1 FROM dependency_drafts WHERE selected_bundle_id=? LIMIT 1').get(key,key)
 if(referenced)return false
 return db.prepare("DELETE FROM dependency_bundles WHERE id=? AND state IN ('ready','failed','cancelled')").run(key).changes>0
}
export function orphanArtifacts():string[]{return (db.prepare('SELECT sha256 FROM dependency_artifacts a WHERE NOT EXISTS(SELECT 1 FROM dependency_bundle_artifacts b WHERE b.sha256=a.sha256)').all() as {sha256:string}[]).map(r=>r.sha256)}
export function knownArtifactHashes():Set<string>{return new Set((db.prepare('SELECT sha256 FROM dependency_artifacts').all() as {sha256:string}[]).map(r=>r.sha256))}
export function removeOrphanArtifact(hash:string):void{db.prepare('DELETE FROM dependency_artifacts WHERE sha256=? AND NOT EXISTS(SELECT 1 FROM dependency_bundle_artifacts WHERE sha256=?)').run(hash,hash)}
