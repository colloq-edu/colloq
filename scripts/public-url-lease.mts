import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireLease, renewLease, releaseLease, LEASE_TTL_MS } from '../server/src/local/public-url-lease.js'

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
async function verify(url: string, runId: string): Promise<void> {
  const response = await fetch(`${url.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(3000) })
  const health = await response.json() as { localRunId?: string }
  if (!runId || health.localRunId !== runId) throw new Error('Local session identity does not match the running server')
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'discover') {
    let receipt: {pid?: number;runId:string;leaseFile:string;url:string;port:number;dataDir:string}
    if (process.env.COLLOQ_LOCAL_SESSION === '1') {
      receipt = {runId:process.env.COLLOQ_LOCAL_RUN_ID!, leaseFile:process.env.COLLOQ_PUBLIC_URL_LEASE_FILE!, url:process.env.COLLOQ_LOCAL_URL!,port:Number(process.env.PORT || 3000),dataDir:process.env.DATA_DIR || path.resolve('data')}
    } else {
      if (!fs.existsSync(args[0])) { process.exitCode = 2; return }
      receipt = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      if (!alive(Number(receipt.pid))) throw new Error('Local session is no longer running; start colloq first')
    }
    if (!Number.isInteger(receipt.port) || receipt.port < 1 || receipt.port > 65535) throw new Error('Invalid local session port')
    const values = [receipt.runId,receipt.leaseFile,receipt.url,String(receipt.port),receipt.dataDir]
    if (values.some(v=>typeof v !== 'string' || !v || /[\t\r\n]/.test(v))) throw new Error('Invalid local session receipt')
    const local = new URL(receipt.url)
    if (local.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(local.hostname)) throw new Error('Invalid local session URL')
    await verify(`http://127.0.0.1:${receipt.port}`,receipt.runId)
    process.stdout.write([...values,local.port || '80'].join('\t')+'\n')
    return
  }
  const [file,runId,owner] = args
  if (!file || !runId || !owner) throw new Error('Expected lease file, run ID and owner')
  if (command === 'acquire') {
    await verify(args[4],runId)
    acquireLease(file,{runId,owner,url:args[3]})
    return
  }
  if (command === 'release') { releaseLease(file,runId,owner); return }
  if (command !== 'watch') throw new Error('Unknown lease command')
  const tunnelPid = Number(args[3]), hostPid = Number(args[4]), healthUrl = args[5]
  let stopping = false
  const finish = () => {
    if (stopping) return
    stopping = true
    try { releaseLease(file,runId,owner) } catch {}
    try { if (alive(tunnelPid)) process.kill(tunnelPid,'SIGTERM') } catch {}
  }
  process.once('SIGINT',finish)
  process.once('SIGTERM',finish)
  let lastHealthy = Date.now()
  try {
    while (!stopping) {
      if (!alive(tunnelPid) || !alive(hostPid)) break
      try {
        await verify(healthUrl,runId)
        lastHealthy = Date.now()
      } catch (error) {
        // Watcher reloads briefly remove the HTTP listener. Never renew blindly,
        // but allow it to return before the existing lease expires.
        if ((error instanceof Error && /identity does not match/.test(error.message)) || Date.now() - lastHealthy >= LEASE_TTL_MS) throw error
        await delay(1000)
        continue
      }
      if (stopping || !renewLease(file,runId,owner)) break
      await delay(3000)
    }
  } finally { finish() }
}
main().catch(error=>{console.error(error instanceof Error ? error.message : error); process.exitCode=1})
