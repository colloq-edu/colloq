/** Durable dependency jobs and immutable submission/environment bindings. */
import { randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { getCompetition, invalidateCompetitionInputs } from '../competitions/store.js'
import { DEPENDENCY_LIMITS, normalizeRequirements, quotaWaitMinutes, requirementLineCount, requirementWithoutComment, unsupportedRequirementLine, dependencyActive, packagesFit, packagesMemoryParams, type DependencyBundle, type DependencyDraft, type DependencyErrorParams, type DependencyPackage, type DependencyPolicy, type DependencyQuota, type EnvironmentRevision, type SubmissionEnvironment } from '@shared/dependencies'
import { manifestPackages, wheelUrls, type PreparationProgress, type PreparationResult } from './preparation-contract.js'
import type { ImageIdentity } from './image-identity.js'
import { dependencyMessage, type DependencyRefusalDetail } from './messages.js'
import { acceptsUploads, submissionsOpen, type CompetitionState } from '@shared/competitions'

const id = () => randomUUID().replaceAll('-', '')
// `detail` carries what the refusal's text needs beyond the code (messages.ts · dependencyRefusal).
export class DependencyStoreError extends Error {
  constructor(public readonly code: string, public readonly status = 409, public readonly detail: DependencyRefusalDetail = {}) { super(code); this.name = 'DependencyStoreError' }
}
const HOUR = 3600000

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
/*
 * What a revision's image is beyond this machine (EnvironmentRevision.registryRef
 * and .layers, image-identity.ts): learned from `docker image inspect` when the
 * revision is captured, and for older revisions at startup (revisions.ts ·
 * backfillRevisionImages).
 *
 * A table of its own rather than two columns of environment_revisions, and not
 * for tidiness: 0.22 and every release before it record a revision with a
 * positional `INSERT INTO environment_revisions VALUES (?,?,?,?,?,?,?,?,?)`.
 * With two more columns, a server rolled back to such a release could not
 * record a single new revision (SQLite refuses nine values for eleven columns),
 * which is exactly the migration older code cannot live with and would take a
 * data-schema bump (data-schema.ts). A new table is state older code never
 * reads. A row is upserted, never removed: the revisions it describes are not
 * removed either.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS environment_revision_images (
 revision_id TEXT PRIMARY KEY REFERENCES environment_revisions(id) ON DELETE CASCADE,
 registry_ref TEXT, layers TEXT, inspected_at INTEGER NOT NULL
);
`)
/*
 * Where the metric of a competition with a card scores (decision 2 of
 * docs/architecture/remote-runners.md §12): the light kaggle-base revision it
 * was pinned to when its metric first ran (competitions/runner.ts ·
 * gpuScoringImage), or, with `revision_id` NULL, each submission's own pinned
 * image, the way every metric ran before the decision — kept by a competition
 * whose metrics had run there already, and by one whose first metric found no
 * kaggle-base on this server. Without a pin every metric took the newest
 * kaggle-base recorded anywhere here: another competition's base refresh, or
 * the first upload of a new one, moved a live competition's scores and
 * rescores to another image, and a metric that imported torch, checked in the
 * competition's own image, began failing in the middle of the competition.
 * Moved only by the teacher, together with a rescore of every submission
 * (runner.ts · moveMetricToLightImage).
 *
 * A table of its own: older code never reads it, and a row goes with its
 * competition.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS competition_metric_revisions (
 competition_id TEXT PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
 revision_id TEXT REFERENCES environment_revisions(id),
 pinned_at INTEGER NOT NULL
);
`)
/*
 * Where each wheel of a ready set was downloaded from (DependencyPackage.url,
 * preparation-contract.ts · wheelUrls): what the machines that run
 * submissions fetch from the index's CDN (bundleWheels). Apart from the set's
 * row and its manifest, which keep no address (manifestPackages): the row's
 * package list is what 0.22 hands the participant's page as it finds it, and
 * an institution's mirror is not named to the class. Older code never reads
 * this table, and its rows go with their set.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS dependency_bundle_wheel_urls (
 bundle_id TEXT NOT NULL REFERENCES dependency_bundles(id) ON DELETE CASCADE,
 sha256 TEXT NOT NULL,
 url TEXT NOT NULL,
 PRIMARY KEY(bundle_id,sha256)
);
`)
/**
 * A set completed by this release before the addresses had a table of their
 * own kept them in its row: moved here, so that no row older code can read
 * names a mirror. At every start, and a no-op once done. A row that does not
 * parse is left as it is (its pages fail on it either way). Returns how many
 * rows it moved.
 */
export const moveWheelUrlsApart = db.transaction((): number => {
 const rows=db.prepare(`SELECT id,packages_json FROM dependency_bundles WHERE packages_json LIKE '%"url"%'`).all() as {id:string;packages_json:string}[]
 let moved=0
 for(const row of rows){
  let packages:DependencyPackage[]
  try{packages=JSON.parse(row.packages_json) as DependencyPackage[];if(!Array.isArray(packages))continue}catch{continue}
  for(const pkg of packages)if(typeof pkg?.url==='string'&&typeof pkg.sha256==='string')db.prepare('INSERT OR IGNORE INTO dependency_bundle_wheel_urls(bundle_id,sha256,url) VALUES(?,?,?)').run(row.id,pkg.sha256,pkg.url)
  db.prepare('UPDATE dependency_bundles SET packages_json=? WHERE id=?').run(JSON.stringify(packages.map(({url:_url,...pkg})=>pkg)),row.id)
  moved++
 }
 return moved
})
moveWheelUrlsApart()

type Row = Record<string, string | number | null>
const json = <T>(value: Row[string], fallback: T): T => value ? JSON.parse(String(value)) as T : fallback
const REVISIONS = `SELECT r.*, i.registry_ref, i.layers FROM environment_revisions r
 LEFT JOIN environment_revision_images i ON i.revision_id = r.id`
function toRevision(row: Row): EnvironmentRevision {
 return {id:String(row.id),environmentName:String(row.environment_name),imageDigest:String(row.image_digest),pythonVersion:String(row.python_version),pythonAbi:String(row.python_abi),platform:String(row.platform),packages:json(row.packages_json,[]),baseConstraintsHash:String(row.constraints_hash),createdAt:Number(row.created_at),
  registryRef:row.registry_ref?String(row.registry_ref):null,layers:row.layers?String(row.layers):null}
}
export function getRevision(revisionId: string): EnvironmentRevision | null {
 const row=db.prepare(`${REVISIONS} WHERE r.id=?`).get(revisionId) as Row|undefined
 return row?toRevision(row):null
}
export function revisions(): EnvironmentRevision[] { return (db.prepare(REVISIONS).all() as Row[]).map(toRevision) }
/**
 * Record a revision, or find the one already recorded for this environment and
 * image. What the image is beyond this machine is not taken from `value`: it
 * is learned only from the image itself (noteRevisionImage), and a revision
 * copied into another one's fields must not hand it its registry reference.
 */
export function putRevision(value: Omit<EnvironmentRevision,'id'|'createdAt'|'registryRef'|'layers'> & {createdAt?:number}): EnvironmentRevision {
 const existing=db.prepare(`${REVISIONS} WHERE r.environment_name=? AND r.image_digest=?`).get(value.environmentName,value.imageDigest) as Row|undefined
 if(existing)return toRevision(existing)
 const key=id();db.prepare('INSERT INTO environment_revisions (id,environment_name,image_digest,python_version,python_abi,platform,packages_json,constraints_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(key,value.environmentName,value.imageDigest,value.pythonVersion,value.pythonAbi,value.platform,JSON.stringify(value.packages),value.baseConstraintsHash,value.createdAt??Date.now())
 return getRevision(key)!
}
const upsertRevisionImage = db.prepare(`INSERT INTO environment_revision_images (revision_id, registry_ref, layers, inspected_at)
 VALUES (@revision, @registry_ref, @layers, @at)
 ON CONFLICT(revision_id) DO UPDATE SET registry_ref = COALESCE(excluded.registry_ref, registry_ref),
  layers = COALESCE(excluded.layers, layers), inspected_at = excluded.inspected_at`)
/**
 * What an inspect of the revision's own image said about it (image-identity.ts ·
 * imageIdentity). Returns whether the revision now reads differently.
 *
 * A `null` never replaces what is known. An image whose registry tag was
 * removed here is still in the registry under its reference, and an inspect
 * that could not read RootFS proves nothing about the layers it had. A new
 * reference does replace the old one: the image went to the preferred
 * repository since (image-identity.ts · registryRefOf). Anything that is not
 * a digest reference or a fingerprint in shape is kept as no answer at all.
 */
export function noteRevisionImage(revisionId: string, identity: ImageIdentity, at = Date.now()): boolean {
 const before = getRevision(revisionId)
 if (!before) return false
 const registryRef = typeof identity.registryRef === 'string' && identity.registryRef.length <= 512 && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(identity.registryRef) ? identity.registryRef : null
 const layers = typeof identity.layers === 'string' && /^[a-f0-9]{64}$/.test(identity.layers) ? identity.layers : null
 if (registryRef === null && layers === null && (before.registryRef !== null || before.layers !== null)) return false
 upsertRevisionImage.run({ revision: revisionId, registry_ref: registryRef, layers, at })
 const after = getRevision(revisionId)!
 return after.registryRef !== before.registryRef || after.layers !== before.layers
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
export const selectRevision = db.transaction((competitionId: string, revisionId: string): void => {
 const before=policyRow(competitionId)
 if(!getRevision(revisionId))throw new DependencyStoreError('dependency_revision',404)
 db.prepare('UPDATE competition_dependency_policies SET revision_id=? WHERE competition_id=?').run(revisionId,competitionId)
 if(before.revision_id && before.revision_id!==revisionId)invalidateCompetitionInputs(competitionId)
})
/**
 * The metric pin of a competition with a card (competition_metric_revisions):
 * `null` — none yet, its metric has not run since there were pins;
 * `{ revisionId: null }` — each submission's own pinned image; otherwise the
 * light revision its every metric runs in.
 */
export function metricPin(competitionId: string): { revisionId: string | null } | null {
 const row=db.prepare('SELECT revision_id FROM competition_metric_revisions WHERE competition_id=?').get(competitionId) as Row|undefined
 return row?{revisionId:row.revision_id===null?null:String(row.revision_id)}:null
}
/**
 * Pin a competition's metric the first time it runs; returns the pin in
 * force. Two metrics that start at once pin one: the second finds the first's
 * pin and keeps it, whatever it would have chosen itself.
 */
export function pinMetric(competitionId: string, revisionId: string | null, at = Date.now()): { revisionId: string | null } {
 db.prepare('INSERT OR IGNORE INTO competition_metric_revisions (competition_id,revision_id,pinned_at) VALUES (?,?,?)').run(competitionId,revisionId,at)
 return metricPin(competitionId)!
}
/**
 * The teacher's move of a competition's metric to another light revision
 * (runner.ts · moveMetricToLightImage, which rescores every submission). The
 * scores from before were computed elsewhere, so the inputs they certify move
 * on too (input_revision), as when a competition is moved to another base
 * (selectRevision); its notebooks' results stand.
 */
export const moveMetricPin = db.transaction((competitionId: string, revisionId: string, at = Date.now()): void => {
 if(!getRevision(revisionId))throw new DependencyStoreError('dependency_revision',404)
 const before=metricPin(competitionId)
 db.prepare(`INSERT INTO competition_metric_revisions (competition_id,revision_id,pinned_at) VALUES (?,?,?)
  ON CONFLICT(competition_id) DO UPDATE SET revision_id=excluded.revision_id,pinned_at=excluded.pinned_at`).run(competitionId,revisionId,at)
 if(before?.revisionId!==revisionId)invalidateCompetitionInputs(competitionId,false)
})
/**
 * The latest metric run of a competition that ties its scores to an image
 * (competitions/runner.ts · metricPinOfHistory): one recorded under a revision
 * of the `light` environment — scored in kaggle-base before there were pins —
 * or a SCORED one recorded under none, as every metric before 0.23 was, in
 * its submission's own image; never the baseline's. `null` — none did;
 * `{ revisionId: null }` — the latest was one of 0.22's.
 *
 * Every metric run used to count, and the latest named the pin: a
 * competition born on `base`, its baseline checked there (a metric run under
 * the base revision), then given kaggle-gpu and a card, pinned each
 * submission's own image for good at its first metric with the card — its
 * metric ran in the ten-to-thirteen-gigabyte GPU image, neither where the
 * baseline was checked nor in kaggle-base. A run in the competition's own
 * pin on the CPU is no score of a board with a card, a failed metric is no
 * score at all, and the baseline is on no board.
 */
export function metricHistoryRevision(competitionId: string, light: string): { revisionId: string | null } | null {
 const row=db.prepare(`SELECT r.revision_id FROM submission_runs r JOIN submissions s ON s.id=r.submission_id
  JOIN competitions c ON c.id=s.competition_id LEFT JOIN environment_revisions e ON e.id=r.revision_id
  WHERE s.competition_id=? AND r.kind='metric'
   AND (e.environment_name=? OR (r.revision_id IS NULL AND r.verdict='ok'
    AND s.id IS NOT c.baseline_submission_id AND s.entrant_id IS NOT c.baseline_entrant_id))
  ORDER BY r.started_at DESC,r.seq DESC LIMIT 1`).get(competitionId,light) as Row|undefined
 return row?{revisionId:row.revision_id===null||row.revision_id===undefined?null:String(row.revision_id)}:null
}
export function setPolicy(competitionId: string, change: Partial<DependencyPolicy>): DependencyPolicy {
 const value={...policyOf(competitionId),...change}
 if(typeof value.enabled!=='boolean'||!Number.isInteger(value.maxDownloadBytes)||value.maxDownloadBytes<1024*1024||value.maxDownloadBytes>DEPENDENCY_LIMITS.downloadBytes||value.maxInstalledBytes!==DEPENDENCY_LIMITS.installedBytes) throw new DependencyStoreError('dependency_limits',400)
 db.prepare('UPDATE competition_dependency_policies SET enabled=?,max_download_bytes=? WHERE competition_id=?').run(value.enabled?1:0,value.maxDownloadBytes,competitionId)
 return value
}
/**
 * The list as it is stored: within the limits, in Python's line breaks, and
 * every requirement without its trailing comment.
 *
 * `numpy==1.26  # note` is stored as `numpy==1.26`, the line the checks here
 * and the preparation program read (shared/dependencies.ts ·
 * requirementWithoutComment), so the set's card and the identical-set check
 * in createBundle compare requirements, not notes. A comment on a line of its
 * own stays, a heading every reader already skips.
 */
export function checkRequirements(text: string): string {
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>DEPENDENCY_LIMITS.requestBytes||text.includes('\0')) throw new DependencyStoreError('dependency_limits',400)
 const normalized=normalizeRequirements(text).split('\n').map(line=>line.trim().startsWith('#')?line:requirementWithoutComment(line)).join('\n').trim()
 if(requirementLineCount(normalized)>DEPENDENCY_LIMITS.lines)throw new DependencyStoreError('dependency_limits',400)
 return normalized
}
/**
 * Refuse a list with a line pip would take but the isolated resolver cannot
 * install (a URL, a path, a pip option), before it becomes a preparation.
 *
 * The preparation program refuses the same lines (preparation-python.ts ·
 * unsupported_source), but only after a queue, a container and one of the
 * hour's preparations. Not part of checkRequirements: a draft keeps such a
 * line, being the entrant's scratch, and choosing a ready set saves the draft
 * along with the choice.
 */
export function checkRequirementSources(text:string):void{
 const line=unsupportedRequirementLine(text)
 if(line!==null)throw new DependencyStoreError('unsupported_source',400,{line})
}
/**
 * The hour's preparations as createBundle counts them: every set the entrant
 * started in the last hour, in any competition, failed and cancelled ones too.
 * Spent, the next one is possible when the oldest of the last `perHour` sets
 * leaves the hour.
 */
export function preparationQuota(e:string,now=Date.now()):DependencyQuota{
 const started=(db.prepare('SELECT created_at FROM dependency_bundles WHERE entrant_id=? AND created_at>? ORDER BY created_at').all(e,now-HOUR) as {created_at:number}[]).map(row=>Number(row.created_at))
 const left=Math.max(0,DEPENDENCY_LIMITS.perHour-started.length)
 return {left,nextAt:left?null:started[started.length-DEPENDENCY_LIMITS.perHour]+HOUR}
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
 /*
  * The set is installed into the submission's own memory, so one that cannot
  * fit there is refused here — when it is chosen or sent with a notebook —
  * with its numbers, rather than an hour later as a failed install. The
  * preparation holds a set to its size limit, not to this memory, and the
  * teacher may lower the memory after the set was prepared.
  */
 const memoryMb=getCompetition(c)?.limits.memoryMb
 if(memoryMb!==undefined&&!packagesFit(b.installedBytes,memoryMb))
  throw new DependencyStoreError('dependency_memory',409,{params:packagesMemoryParams(b.installedBytes,memoryMb)})
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
/*
 * A set as the pages and the runner read it: the wheels without their download
 * addresses. Those are for the machines that run submissions (bundleWheels); a
 * participant's page has no use for them, and an institution's mirror is not
 * named to the class (service.ts · sanitizedLog keeps registry URLs out of the
 * log for the same reason).
 */
function toBundle(r: Row): DependencyBundle {
 return {id:String(r.id),number:Number(r.number),competitionId:String(r.competition_id),entrantId:String(r.entrant_id),revisionId:String(r.revision_id),requirementsText:String(r.requirements_text),normalizedRequirements:json(r.normalized_json,[]),state:String(r.state) as DependencyBundle['state'],packages:json<DependencyPackage[]>(r.packages_json,[]).map(({url:_url,...pkg})=>pkg),downloadBytes:Number(r.download_bytes),installedBytes:Number(r.installed_bytes),contentHash:r.content_hash?String(r.content_hash):null,error:json(r.error_json,null),log:json(r.log_json,[]),createdAt:Number(r.created_at),readyAt:r.ready_at===null?null:Number(r.ready_at)}
}
export function getBundle(key: string): DependencyBundle|null {
 const r=db.prepare('SELECT * FROM dependency_bundles WHERE id=?').get(key) as Row|undefined;return r?toBundle(r):null
}
/**
 * The wheels of a ready set as its manifest keeps them, with the download
 * addresses kept apart (DependencyPackage.url, dependency_bundle_wheel_urls):
 * what a machine that runs submissions fetches from the index's CDN and
 * checks by sha256 and size. `null` — no such set, or not ready.
 */
export function bundleWheels(key: string): DependencyPackage[]|null {
 const r=db.prepare("SELECT packages_json FROM dependency_bundles WHERE id=? AND state='ready'").get(key) as Row|undefined
 if(!r)return null
 const urls=new Map((db.prepare('SELECT sha256,url FROM dependency_bundle_wheel_urls WHERE bundle_id=?').all(key) as {sha256:string;url:string}[]).map(row=>[row.sha256,row.url]))
 return json<DependencyPackage[]>(r.packages_json,[]).map(({url:_url,...pkg})=>{const url=urls.get(pkg.sha256);return url?{...pkg,url}:pkg})
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
 const competition=db.prepare('SELECT state,starts_at,deadline_at,late_submissions,environment FROM competitions WHERE id=?').get(c) as {state:CompetitionState;starts_at:number|null;deadline_at:number|null;late_submissions:number;environment:string}|undefined
 if(!competition||!acceptsUploads(submissionsOpen({state:competition.state,startsAt:competition.starts_at,deadlineAt:competition.deadline_at,lateSubmissions:competition.late_submissions===1},now)))throw new DependencyStoreError('dependency_closed',403)
 if(getRevision(revisionId)?.environmentName!==competition.environment)throw new DependencyStoreError('dependency_revision')
 const policy=policyOf(c);if(!policy.enabled)throw new DependencyStoreError('dependency_disabled',403)
 text=checkRequirements(text);if(!text||!text.split('\n').some(s=>s.trim()&&!s.trim().startsWith('#')))throw new DependencyStoreError('dependency_empty',400)
 checkRequirementSources(text)
 if(competitionRevision(c)?.id!==revisionId)throw new DependencyStoreError('dependency_revision')
 const active=db.prepare("SELECT * FROM dependency_bundles WHERE entrant_id=? AND state IN ('queued','resolving','downloading','verifying') LIMIT 1").get(e) as Row|undefined
 if(active){const b=toBundle(active);if(b.competitionId===c&&b.revisionId===revisionId&&b.requirementsText===text)return b;throw new DependencyStoreError('dependency_active')}
 // The refusal says when, not just "later": the eleventh try is exactly when someone asks.
 const quota=preparationQuota(e,now)
 if(quota.nextAt!==null)throw new DependencyStoreError('dependency_quota',429,{params:{waitMinutes:quotaWaitMinutes(quota.nextAt,now)}})
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
 // A step arrives as a code and is stored as one, so the log reads in the reader's language.
 const line=typeof progress.log==='string'?progress.log.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(0,1000):progress.log
 const logs=line?[...b.log,line].slice(-200):b.log
 db.prepare('UPDATE dependency_bundles SET state=?,normalized_json=?,download_bytes=?,installed_bytes=?,log_json=? WHERE id=?').run(progress.state,JSON.stringify(progress.normalizedRequirements??b.normalizedRequirements),progress.downloadBytes??b.downloadBytes,progress.installedBytes??b.installedBytes,JSON.stringify(logs),key)
}
export const completeBundle=db.transaction((key:string,result:PreparationResult):boolean=>{
 const b=getBundle(key);if(!b||!dependencyActive(b.state))return false
 // The same list the manifest on disk keeps (files.ts · publishBundle), without the addresses, which go apart.
 const packages=manifestPackages(result.packages)
 for(const p of packages){
  db.prepare('INSERT OR IGNORE INTO dependency_artifacts VALUES(?,?,?,?,?,?)').run(p.sha256,p.fileName,p.name,p.version,p.bytes,Date.now())
  db.prepare('INSERT INTO dependency_bundle_artifacts VALUES(?,?)').run(key,p.sha256)
 }
 for(const {sha256,url} of wheelUrls(result.packages))db.prepare('INSERT OR REPLACE INTO dependency_bundle_wheel_urls(bundle_id,sha256,url) VALUES(?,?,?)').run(key,sha256,url)
 db.prepare("UPDATE dependency_bundles SET state='ready',normalized_json=?,packages_json=?,download_bytes=?,installed_bytes=?,content_hash=?,lock_text=?,error_json=NULL,ready_at=? WHERE id=?").run(JSON.stringify(result.normalizedRequirements),JSON.stringify(packages),result.downloadBytes,result.installedBytes,result.contentHash,result.lock,Date.now(),key)
 return true
})
export function failBundle(key:string,code:string,message:string,line?:number,params?:DependencyErrorParams):void{
 const b=getBundle(key);if(!b||!dependencyActive(b.state))return
 db.prepare("UPDATE dependency_bundles SET state='failed',error_json=? WHERE id=?").run(JSON.stringify({code,message,...(line===undefined?{}:{line}),...(params?{params}:{})}),key)
}
export function cancelBundle(key:string):DependencyBundle|null{
 const b=getBundle(key);if(b&&dependencyActive(b.state))db.prepare("UPDATE dependency_bundles SET state='cancelled' WHERE id=?").run(key)
 return getBundle(key)
}
export function recoverPreparations():number{
 return db.prepare("UPDATE dependency_bundles SET state='failed',error_json=? WHERE state IN ('resolving','downloading','verifying')").run(JSON.stringify({code:'worker_restarted',message:dependencyMessage('worker_restarted')})).changes
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

export function knownBundleIds():Set<string>{return new Set((db.prepare('SELECT id FROM dependency_bundles').all() as {id:string}[]).map(row=>row.id))}

export function deferClaim(key:string):void {
 db.prepare("UPDATE dependency_bundles SET state='queued' WHERE id=? AND state='resolving'").run(key)
}

/**
 * Remove what one entrant prepared in one competition: their draft, their
 * package sets, and the environment bindings that point at those sets or
 * belong to their submissions there. Returns the removed sets; their
 * directories are the caller's to remove after the commit
 * (competitions/erase.ts). The shared wheel files stay for the collection
 * sweep here, which knows when no other set links them.
 *
 * Called BEFORE the submission and entrant rows go. The declared cascades
 * would take most of this with them (better-sqlite3 turns foreign keys on),
 * but then the set ids would be gone before anyone could remove their
 * directories — and a binding's `bundle_id` has no cascade, so a set still
 * bound to a submission cannot go first: the bindings go before the sets.
 */
export const removeEntrantDependencies = db.transaction((entrantId: string, competitionId: string): string[] => {
 const scope = { e: entrantId, c: competitionId }
 const bundles = (db.prepare('SELECT id FROM dependency_bundles WHERE entrant_id = @e AND competition_id = @c').all(scope) as { id: string }[]).map((row) => row.id)
 db.prepare(`DELETE FROM submission_environments WHERE submission_id IN
   (SELECT id FROM submissions WHERE entrant_id = @e AND competition_id = @c)
   OR bundle_id IN (SELECT id FROM dependency_bundles WHERE entrant_id = @e AND competition_id = @c)`).run(scope)
 db.prepare(`DELETE FROM dependency_bundle_artifacts WHERE bundle_id IN
   (SELECT id FROM dependency_bundles WHERE entrant_id = @e AND competition_id = @c)`).run(scope)
 db.prepare(`DELETE FROM dependency_bundle_wheel_urls WHERE bundle_id IN
   (SELECT id FROM dependency_bundles WHERE entrant_id = @e AND competition_id = @c)`).run(scope)
 db.prepare('DELETE FROM dependency_bundles WHERE entrant_id = @e AND competition_id = @c').run(scope)
 db.prepare('DELETE FROM dependency_drafts WHERE entrant_id = @e AND competition_id = @c').run(scope)
 return bundles
})
