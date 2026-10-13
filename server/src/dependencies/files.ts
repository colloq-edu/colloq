import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
// The data root without config.ts: a machine that runs submissions keeps its package sets here too (data-dir.ts).
import { dataDir } from '../data-dir.js'
import type { DependencyBundle } from '@shared/dependencies'
import type { PreparationResult } from './preparation-contract.js'
import { DependencyPreparationError, manifestPackages } from './preparation-contract.js'

export const dependencyRoot = path.join(dataDir, 'dependencies')
const checked = (key: string): string => {
  if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('Invalid dependency identifier')
  return key
}
const hashKey = (key: string): string => {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid artifact hash')
  return key
}
export function stagingDir(key: string): string { return path.join(dependencyRoot, 'staging', checked(key)) }
export function bundleDir(key: string): string { return path.join(dependencyRoot, 'bundles', checked(key)) }
const artifactPath = (hash: string): string => path.join(dependencyRoot, 'artifacts', hashKey(hash))
export function ensureDependencyStorage(): void {
  for (const part of ['', 'staging', 'bundles', 'artifacts']) fs.mkdirSync(path.join(dependencyRoot,part), {recursive:true,mode:0o700})
}
export function freshStaging(key:string):string {
  ensureDependencyStorage()
  const dir=stagingDir(key)
  if(fs.existsSync(dir))throw new Error('Dependency staging directory already exists')
  fs.mkdirSync(dir,{mode:0o755})
  return dir
}
export function removeStaging(key:string):void { fs.rmSync(stagingDir(key),{recursive:true,force:true}) }
export function removeBundleFiles(key:string):void { fs.rmSync(bundleDir(key),{recursive:true,force:true}) }
export function removeArtifactFile(hash:string):void { fs.rmSync(artifactPath(hash),{force:true}) }
async function fileHash(file:string):Promise<string> {
  const hash=createHash('sha256')
  for await(const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
function regular(file:string):fs.Stats {
  const stat=fs.lstatSync(file)
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Dependency artifact is not a regular file')
  return stat
}
export async function publishBundle(key:string,result:PreparationResult):Promise<void> {
  ensureDependencyStorage()
  // The downloaded source and CAS copy coexist until publication completes.
  const free=freeDependencyBytes()
  if(free!==null&&free<result.downloadBytes+64*1024*1024)throw new DependencyPreparationError('disk_full','Insufficient storage to publish packages')
  const destination=bundleDir(key)
  if(fs.existsSync(destination))throw new Error('Dependency bundle is immutable')
  const stage=stagingDir(key)
  const publishing=path.join(stage,'publish')
  fs.mkdirSync(path.join(publishing,'wheels'),{recursive:true,mode:0o755})
  const seen=new Set<string>()
  let total=0
  for(const pkg of result.packages){
    if(!/^[A-Za-z0-9][A-Za-z0-9_.+!-]{0,230}\.whl$/.test(pkg.fileName)||seen.has(pkg.fileName))throw new Error('Invalid wheel filename')
    seen.add(pkg.fileName)
    const source=path.join(stage,'wheels',pkg.fileName)
    const stat=regular(source)
    if(stat.size!==pkg.bytes||await fileHash(source)!==pkg.sha256)throw new DependencyPreparationError('hash_mismatch','Dependency wheel hash mismatch')
    total+=stat.size
    const cached=artifactPath(pkg.sha256)
    if(fs.existsSync(cached)){
      if(regular(cached).size!==pkg.bytes||await fileHash(cached)!==pkg.sha256)throw new DependencyPreparationError('hash_mismatch','Cached dependency wheel is corrupt')
    }else{
      fs.copyFileSync(source,cached,fs.constants.COPYFILE_EXCL)
      fs.chmodSync(cached,0o444)
    }
    fs.linkSync(cached,path.join(publishing,'wheels',pkg.fileName))
  }
  if(total!==result.downloadBytes)throw new Error('Dependency artifact sizes disagree')
  fs.writeFileSync(path.join(publishing,'requirements.lock'),result.lock,{mode:0o444})
  // Each wheel with its sha256, size and, where it passes the check, the address
  // it came from (preparation-contract.ts · manifestPackages): the same list the
  // set's row keeps (store.ts · completeBundle).
  fs.writeFileSync(path.join(publishing,'manifest.json'),JSON.stringify({...result,packages:manifestPackages(result.packages)}),{mode:0o444})
  fs.chmodSync(publishing,0o755)
  fs.renameSync(publishing,destination)
}
/*
 * File digests by file identity: first for the wheel check before execution,
 * now for any file this server hands out by content hash.
 *
 * A bundle is immutable (0444, hard links into the CAS), yet every submission
 * used to hash every wheel again: up to half a gigabyte read per notebook,
 * and with eight slots eight times per wave. A file that kept its path,
 * size, mtime, ctime and inode kept its bytes as far as the kernel can tell
 * (the same stat cache git trusts); anything else is hashed again. Bounded:
 * the oldest entries go first.
 *
 * Exported for the competition data (competitions/storage.ts ·
 * openFileSha256): rows uploaded before the hash had a column get theirs
 * lazily, and a check of the same unchanged file must not read two hundred
 * megabytes every time it is asked. One read per identity at a time, too: two
 * callers asking about the same file at once (two machines asking for the same
 * data in the same second) wait for the one read instead of making two.
 */
const digests = new Map<string, string>()
const DIGESTS_MAX = 4096
const reading = new Map<string, Promise<string>>()

/**
 * The sha256 (hex) of `file`, whose identity `stat` describes. `read` gives
 * its bytes when they have to be read; by default the file is opened by path.
 * A caller that opened the file itself (through the anchored file system)
 * passes the stat of that descriptor and a stream over it, so the identity and
 * the bytes are of one and the same inode.
 */
export async function cachedSha256(
  file: string,
  stat: fs.Stats,
  read: () => AsyncIterable<Buffer | string> = () => fs.createReadStream(file),
): Promise<string> {
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`
  const known = digests.get(key)
  if (known) return known
  const running = reading.get(key)
  if (running) return running
  const pending = (async () => {
    const hash = createHash('sha256')
    for await (const chunk of read()) hash.update(chunk)
    const digest = hash.digest('hex')
    if (digests.size >= DIGESTS_MAX) digests.delete(digests.keys().next().value!)
    digests.set(key, digest)
    return digest
  })()
  reading.set(key, pending)
  try {
    return await pending
  } finally {
    reading.delete(key)
  }
}

/** Hashes are rechecked before execution, not just when downloading. */
export async function verifyBundleFiles(bundle:DependencyBundle,expectedLock:string):Promise<string> {
  if(bundle.state!=='ready')throw new Error('Dependency bundle is not ready')
  const dir=bundleDir(bundle.id)
  for(const pkg of bundle.packages){
    const file=path.join(dir,'wheels',pkg.fileName)
    const stat=regular(file)
    if(stat.size!==pkg.bytes||await cachedSha256(file,stat)!==pkg.sha256)throw new Error('Dependency wheel missing or corrupt')
  }
  regular(path.join(dir,'requirements.lock'))
  if(fs.readFileSync(path.join(dir,'requirements.lock'),'utf8')!==expectedLock)throw new Error('Dependency lock missing or corrupt')
  return dir
}
/** Reconcile files from interrupted publication, including files never recorded
 * in SQLite. A grace period protects another process finishing publication. */
export function reconcileArtifacts(knownHashes:ReadonlySet<string>,before=Date.now()-3600000):number {
  ensureDependencyStorage();let removed=0
  const dir=path.join(dependencyRoot,'artifacts')
  for(const name of fs.readdirSync(dir)){
    if(!/^[a-f0-9]{64}$/.test(name)||knownHashes.has(name))continue
    const file=path.join(dir,name),stat=fs.lstatSync(file)
    if(stat.mtimeMs<before){fs.rmSync(file,{force:true});removed++}
  }
  return removed
}
export function freeDependencyBytes():number|null {
  ensureDependencyStorage()
  try { const stat=fs.statfsSync(dependencyRoot);return Number(stat.bavail)*Number(stat.bsize) }catch{return null}
}

/** A SQL cascade or interrupted cleanup may remove bundle rows before their
 * hardlinked wheels. Do not follow symlinks; fresh publication has a grace. */
export function reconcileBundles(knownIds: ReadonlySet<string>, before = Date.now() - 3600000): number {
  ensureDependencyStorage()
  let removed = 0
  for (const name of fs.readdirSync(path.join(dependencyRoot, 'bundles'))) {
    if (!/^[a-f0-9]{32}$/.test(name) || knownIds.has(name)) continue
    const target = bundleDir(name)
    const stat = fs.lstatSync(target)
    if (stat.mtimeMs >= before) continue
    fs.rmSync(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true })
    removed++
  }
  return removed
}

/** Source wheels + CAS copy + bounded metadata/publication headroom. */
export function preparationPeakBytes(downloadBytes:number):number{return 2*downloadBytes+256*1024*1024}
