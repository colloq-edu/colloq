import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { config } from '../config.js'
import type { DependencyBundle } from '@shared/dependencies'
import type { PreparationResult } from './preparation-contract.js'
import { DependencyPreparationError } from './preparation-contract.js'

export const dependencyRoot = path.join(config.dataDir, 'dependencies')
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
  fs.writeFileSync(path.join(publishing,'manifest.json'),JSON.stringify(result),{mode:0o444})
  fs.chmodSync(publishing,0o755)
  fs.renameSync(publishing,destination)
}
/** Hashes are rechecked before execution, not just when downloading. */
export async function verifyBundleFiles(bundle:DependencyBundle,expectedLock:string):Promise<string> {
  if(bundle.state!=='ready')throw new Error('Dependency bundle is not ready')
  const dir=bundleDir(bundle.id)
  for(const pkg of bundle.packages){
    const file=path.join(dir,'wheels',pkg.fileName)
    if(regular(file).size!==pkg.bytes||await fileHash(file)!==pkg.sha256)throw new Error('Dependency wheel missing or corrupt')
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
