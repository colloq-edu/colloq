import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

function helper(args:string[], env:NodeJS.ProcessEnv=process.env):Promise<{code:number|null,out:string,err:string}> {
 return new Promise(resolve=>{const p=spawn(process.execPath,['--import','tsx','scripts/public-url-lease.mts',...args],{env}); let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('close',code=>resolve({code,out,err}))})
}
test('standalone host discovers the owning server and refuses a different run at the same port',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-host-'))
 let runId='mine'
 const server=http.createServer((_req,res)=>res.end(JSON.stringify({localRunId:runId})))
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const port=(server.address() as import('node:net').AddressInfo).port
 const receipt=path.join(dir,'session.json')
 fs.writeFileSync(receipt,JSON.stringify({pid:process.pid,runId:'mine',port,url:'http://localhost:5173',leaseFile:path.join(dir,'lease.json'),dataDir:dir}))
 try {
  const env={...process.env,COLLOQ_LOCAL_SESSION:'',COLLOQ_LOCAL_RUN_ID:''}
  const good=await helper(['discover',receipt],env)
  assert.equal(good.code,0,good.err)
  assert.deepEqual(good.out.trim().split('\t'),['mine',path.join(dir,'lease.json'),'http://localhost:5173',String(port),dir,'5173'])
  runId='someone-else'
  const bad=await helper(['discover',receipt],env)
  assert.equal(bad.code,1)
  assert.match(bad.err,/does not match/)
 } finally {await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true})}
})

/*
 * Чужая расписка — не упавшая сессия.
 *
 * 20.09.2026 `make vast-up` привёз на арендованную машину `.colloq/` с ноутбука:
 * расписку `make dev` с номером процесса, которого на той машине никогда не
 * было. Сервер там работал службой systemd (о локальной сессии он не знает —
 * `localRunId: null`), а публикация отказывала словами «сначала запустите
 * colloq». Расписка с мёртвым процессом рядом с живым сервером, который ей не
 * принадлежит, — это «расписки нет» (код 2); с мёртвым процессом и пустым
 * портом — по-прежнему отказ.
 */
test('a stale receipt next to a server that is not a local session counts as no receipt', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-stale-'))
 const server=http.createServer((_req,res)=>res.end(JSON.stringify({ok:true,version:'0.2.0',localRunId:null})))
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const port=(server.address() as import('node:net').AddressInfo).port
 const receipt=path.join(dir,'session.json')
 // pid 999999 — заведомо мёртвый: процесс с ноутбука на этой машине не живёт.
 const write=(at:number)=>fs.writeFileSync(receipt,JSON.stringify({pid:999999,runId:'laptop-run',port:at,url:'http://localhost:5173',leaseFile:path.join(dir,'lease.json'),dataDir:dir}))
 const env={...process.env,COLLOQ_LOCAL_SESSION:'',COLLOQ_LOCAL_RUN_ID:''}
 try {
  write(port)
  const foreign=await helper(['discover',receipt],env)
  assert.equal(foreign.code,2,foreign.err)
  assert.equal(foreign.out,'')
 } finally {await new Promise<void>(r=>server.close(()=>r()))}
 try {
  // Тот же порт, но сервера уже нет: это упавшая сессия, и говорить надо о ней.
  write(port)
  const crashed=await helper(['discover',receipt],env)
  assert.equal(crashed.code,1)
  assert.match(crashed.err,/no longer running/)
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
})

test('the vast deploy never ships the laptop\'s session state and removes a receipt that already travelled', () => {
 const script=fs.readFileSync('scripts/vast-legacy.sh','utf8')
 const excludes=/<<'EXCL'\n([\s\S]*?)\nEXCL/.exec(script)?.[1].split('\n') ?? []
 for (const path of ['.colloq/','.claude/','scratchpad/']) assert.ok(excludes.includes(path),`${path} едет на арендованную машину`)
 // Исключённое rsync --delete не удаляет, а данные и .env там трогать нельзя — поэтому точечно.
 assert.match(script,/rssh "rm -f '\$REMOTE_DIR\/\.colloq\/local-session\.json'/)
 assert.doesNotMatch(script,/--delete-excluded/)
})

test('native host never restarts a server and local publication uses the lease helper',()=>{
 const script=fs.readFileSync('scripts/host.sh','utf8').split('\n').filter(l=>!/^\s*#/.test(l)).join('\n')
 assert.doesNotMatch(script,/kill "\$\(cat "\$PIDFILE"\)"/)
 assert.match(script,/public-url-lease\.mts/)
 assert.match(script,/local-session\.json/)
 assert.match(script,/localPort = \$\{TUNNEL_PORT\}/)
})

test('lease watcher releases the URL and ends its tunnel when its host process disappears',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-watch-'))
 const file=path.join(dir,'lease.json')
 const server=http.createServer((_req,res)=>res.end(JSON.stringify({localRunId:'run'})))
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const url=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
 const host=spawn(process.execPath,['-e','setInterval(()=>{},1000)'])
 const tunnel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'])
 let watcher:ReturnType<typeof spawn>|undefined
 try {
  assert.equal((await helper(['acquire',file,'run','owner','https://temporary.example',url])).code,0)
  watcher=spawn(process.execPath,['--import','tsx','scripts/public-url-lease.mts','watch',file,'run','owner',String(tunnel.pid),String(host.pid),url])
  const hostDone=new Promise<void>(r=>host.once('exit',()=>r()));host.kill('SIGTERM');await hostDone
  await Promise.race([new Promise<void>(r=>watcher!.once('exit',()=>r())),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('watcher did not stop')),6000).unref())])
  assert.equal(fs.existsSync(file),false)
  assert.equal(tunnel.exitCode!==null || tunnel.signalCode!==null,true)
 } finally {
  watcher?.kill('SIGTERM');host.kill('SIGTERM');tunnel.kill('SIGTERM')
  await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true})
 }
})

test('a brief development server reload preserves the tunnel and resumes lease renewal',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-watch-reload-'))
 const file=path.join(dir,'lease.json')
 let reloading=false
 const server=http.createServer((_req,res)=>{if(reloading){res.statusCode=503;res.end('Reloading')}else res.end(JSON.stringify({localRunId:'run'}))})
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const url=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
 const tunnel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'])
 let watcher:ReturnType<typeof spawn>|undefined
 try {
  assert.equal((await helper(['acquire',file,'run','owner','https://temporary.example',url])).code,0)
  const expiry=JSON.parse(fs.readFileSync(file,'utf8')).expiresAt
  reloading=true
  watcher=spawn(process.execPath,['--import','tsx','scripts/public-url-lease.mts','watch',file,'run','owner',String(tunnel.pid),String(process.pid),url])
  await new Promise(r=>setTimeout(r,1000));reloading=false
  await new Promise(r=>setTimeout(r,3000))
  assert.equal(watcher.exitCode,null)
  assert.equal(tunnel.signalCode,null)
  assert.ok(JSON.parse(fs.readFileSync(file,'utf8')).expiresAt>expiry)
 } finally {
  const done=watcher && watcher.exitCode===null && watcher.signalCode===null ? new Promise<void>(r=>watcher!.once('exit',()=>r())) : Promise.resolve()
  watcher?.kill('SIGTERM');await done;tunnel.kill('SIGTERM')
  await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true})
 }
})

test('local host script publishes and releases a lease without touching env or stopping the app',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-host-script-'))
 const root=process.cwd()
 const server=http.createServer((_req,res)=>res.end(JSON.stringify({localRunId:'run'})))
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const port=(server.address() as import('node:net').AddressInfo).port
 let host:ReturnType<typeof spawn>|undefined
 try {
  for(const name of ['scripts/host.sh','scripts/lib.sh','scripts/public-url-lease.mts','server/src/local/public-url-lease.ts','shared/local-public-url-lease.ts','tsconfig.json']) {
   const dest=path.join(dir,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,name),dest)
  }
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir')
  const bin=path.join(dir,'bin');fs.mkdirSync(bin)
  const fake=(name:string,code:string)=>fs.writeFileSync(path.join(bin,name),`#!${process.execPath}\n${code}\n`,{mode:0o755})
  fake('docker','process.exit(1)')
  // Здоровье называет изоляцию комнат: без поля isolation host.sh не
  // публикует ничего (замок — см. тест ниже).
  fake('curl',"if(process.argv.some(a=>a.includes('/api/health'))) process.stdout.write('{\"localRunId\":\"run\",\"isolation\":\"docker\"}');else if(process.argv.includes('-w')) process.stdout.write('200')")
  fake('dig',"process.stdout.write('127.0.0.1\\n')")
  fake('cloudflared',"require('node:fs').writeFileSync('tunnel-argv.json',JSON.stringify(process.argv.slice(2)));setInterval(()=>{},1000)")
  const original='PUBLIC_URL=https://persistent.example\nRELAY_DOMAIN=\nCOLLOQ_CLUSTER=\n'
  fs.writeFileSync(path.join(dir,'.env'),original)
  const lease=path.join(dir,'.colloq/public-url.json')
  let output=''
  host=spawn('bash',['scripts/host.sh'],{cwd:dir,env:{...process.env,PATH:`${bin}:${process.env.PATH}`,COLLOQ_CLUSTER:'1',COLLOQ_DIRECT:'',COLLOQ_HOSTNAME:'temporary.example',COLLOQ_LOCAL_SESSION:'1',COLLOQ_LOCAL_RUN_ID:'run',COLLOQ_LOCAL_URL:`http://127.0.0.1:${port}`,COLLOQ_PUBLIC_URL_LEASE_FILE:lease,PORT:String(port),DATA_DIR:path.join(dir,'data')}})
  host.stdout.on('data',d=>output+=d);host.stderr.on('data',d=>output+=d)
  const tunnelArgsFile=path.join(dir,'tunnel-argv.json')
  const deadline=Date.now()+8000
  while((!fs.existsSync(lease)||!fs.existsSync(tunnelArgsFile)) && Date.now()<deadline && host.exitCode===null) await new Promise(r=>setTimeout(r,50))
  assert.ok(fs.existsSync(lease),output)
  assert.ok(fs.existsSync(tunnelArgsFile),'tunnel process did not record its arguments: '+output)
  assert.equal(JSON.parse(fs.readFileSync(lease,'utf8')).url,'https://temporary.example')
  const tunnelArgs=JSON.parse(fs.readFileSync(tunnelArgsFile,'utf8'))
  assert.equal(tunnelArgs[tunnelArgs.indexOf('--http-host-header')+1],`127.0.0.1:${port}`,'tunnel must use the trusted local Host header')
  assert.equal(fs.readFileSync(path.join(dir,'.env'),'utf8'),original)
  const done=new Promise<void>(r=>host!.once('exit',()=>r()));host.kill('SIGTERM');await done
  assert.equal(fs.existsSync(lease),false,output)
  assert.equal(fs.readFileSync(path.join(dir,'.env'),'utf8'),original)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status,200)
 } finally {host?.kill('SIGTERM');await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true})}
})

/**
 * Стенд host.sh под `colloq start --share`: настоящий скрипт и настоящая
 * расписка адреса, выдуманные curl, dig и cloudflared. cloudflared лежит НЕ в
 * PATH — его называет COLLOQ_CLOUDFLARED, как это делает супервизор, найдя и
 * сверив файл сам.
 */
async function shareStand(health:string){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-host-share-'))
 const root=process.cwd()
 const server=http.createServer((_req,res)=>res.end(JSON.stringify({localRunId:'run'})))
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const port=(server.address() as import('node:net').AddressInfo).port
 for(const name of ['scripts/host.sh','scripts/lib.sh','scripts/public-url-lease.mts','server/src/local/public-url-lease.ts','shared/local-public-url-lease.ts','tsconfig.json']) {
  const dest=path.join(dir,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,name),dest)
 }
 fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir')
 const bin=path.join(dir,'bin');fs.mkdirSync(bin)
 const tools=path.join(dir,'tools');fs.mkdirSync(tools)
 const fake=(where:string,name:string,code:string)=>fs.writeFileSync(path.join(where,name),`#!${process.execPath}\n${code}\n`,{mode:0o755})
 fake(bin,'docker','process.exit(1)')
 fake(bin,'curl',`if(process.argv.some(a=>a.includes('/api/health'))) process.stdout.write(${JSON.stringify(health)});else if(process.argv.includes('-w')) process.stdout.write('200')`)
 fake(bin,'dig',"process.stdout.write('127.0.0.1\\n')")
 // Быстрый туннель печатает адрес в свой вывод, а host.sh ищет его в журнале.
 fake(tools,'cloudflared',"require('node:fs').writeFileSync('tunnel-argv.json',JSON.stringify(process.argv.slice(2)));console.log('INF |  https://quick-share.trycloudflare.com  |');setInterval(()=>{},1000)")
 fs.writeFileSync(path.join(dir,'.env'),'RELAY_DOMAIN=\n')
 const lease=path.join(dir,'.colloq/public-url.json')
 const host=spawn('bash',['scripts/host.sh'],{cwd:dir,env:{...process.env,PATH:`${bin}:${process.env.PATH}`,COLLOQ_SHARE:'1',COLLOQ_CLOUDFLARED:path.join(tools,'cloudflared'),COLLOQ_CLUSTER:'',COLLOQ_DIRECT:'',COLLOQ_HOSTNAME:'',COLLOQ_LOCAL_SESSION:'1',COLLOQ_LOCAL_RUN_ID:'run',COLLOQ_LOCAL_URL:`http://127.0.0.1:${port}`,COLLOQ_PUBLIC_URL_LEASE_FILE:lease,PORT:String(port),DATA_DIR:path.join(dir,'data')}})
 let output=''
 host.stdout.on('data',d=>output+=d);host.stderr.on('data',d=>output+=d)
 const close=async()=>{if(host.exitCode===null&&host.signalCode===null){const done=new Promise<void>(r=>host.once('exit',()=>r()));host.kill('SIGTERM');await done};await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true})}
 return {dir,lease,host,read:()=>output.replace(/\x1b\[[0-9;]*m/g,''),close}
}

test('--share: host.sh names the address with one marker line and keeps its own summary to itself',async()=>{
 const s=await shareStand('{"ok":true,"localRunId":"run","isolation":"docker"}')
 try {
  const deadline=Date.now()+15000
  while(!s.read().includes('@colloq-share') && s.host.exitCode===null && Date.now()<deadline) await new Promise(r=>setTimeout(r,50))
  const out=s.read()
  assert.match(out,/^@colloq-share ok https:\/\/quick-share\.trycloudflare\.com$/m,out)
  // Итог печатает супервизор: ни ссылки с токеном, ни своего абзаца здесь нет.
  assert.doesNotMatch(out,/Sign-in to the panel|Colloq is available|\/admin\/t\//)
  assert.equal(JSON.parse(fs.readFileSync(s.lease,'utf8')).url,'https://quick-share.trycloudflare.com')
  // Туннель — тот cloudflared, что назван, и быстрый: без имени туннеля.
  const argv=JSON.parse(fs.readFileSync(path.join(s.dir,'tunnel-argv.json'),'utf8'))
  assert.deepEqual(argv.slice(0,3),['tunnel','--no-autoupdate','--url'])
  assert.equal(s.host.exitCode,null,'host.sh must keep the tunnel open')
 } finally {await s.close()}
})

test('the gate: without the isolation field host.sh opens no tunnel at all',async()=>{
 for (const health of ['{"ok":true,"localRunId":"run"}','{"ok":true,"localRunId":"run","isolation":null}']) {
  const s=await shareStand(health)
  try {
   const code=await new Promise<number|null>(r=>s.host.once('exit',c=>r(c)))
   const out=s.read()
   assert.notEqual(code,0,out)
   assert.match(out,/not publishing: .* does not confirm that every room\s+runs in a container of its own/,out)
   assert.equal(fs.existsSync(path.join(s.dir,'tunnel-argv.json')),false,'a tunnel was started past the gate')
   assert.equal(fs.existsSync(s.lease),false)
  } finally {await s.close()}
 }
})


test('Vite still rejects arbitrary public Hosts while accepting the rewritten tunnel origin', async()=>{
 const {createServer}=await import('vite')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-vite-host-'))
 fs.writeFileSync(path.join(dir,'index.html'),'<html><body>local dev</body></html>')
 const vite=await createServer({configFile:false,root:dir,server:{host:'127.0.0.1',port:0},logLevel:'silent'})
 try {
  await vite.listen()
  const port=(vite.httpServer!.address() as import('node:net').AddressInfo).port
  const request=(host:string)=>new Promise<number>(resolve=>{
    http.get({hostname:'127.0.0.1',port,path:'/',headers:{host}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!))})
  })
  assert.equal(await request('seminar.example.test'),403)
  assert.equal(await request(`127.0.0.1:${port}`),200)
  const script=fs.readFileSync('scripts/host.sh','utf8')
  assert.ok(script.includes('hostHeaderRewrite = \"127.0.0.1:%s\"'), 'FRP must rewrite the origin Host too')
 } finally {await vite.close();fs.rmSync(dir,{recursive:true,force:true})}
})
