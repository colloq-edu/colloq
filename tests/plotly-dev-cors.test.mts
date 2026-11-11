import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import config from '../web/vite.config.js'

test('the actual Vite development server permits only public Plotly modules to the opaque frame',async()=>{
 const root=path.resolve(import.meta.dirname,'../web')
 const require=createRequire(path.join(root,'package.json'))
 const viteRoot=path.dirname(require.resolve('vite/package.json'))
 const {createServer}=await import(pathToFileURL(path.join(viteRoot,'dist/node/index.js')).href)
 const publicDir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-plotly-dev-'))
 let server:Awaited<ReturnType<typeof createServer>>|undefined
 try{
  for(const file of ['plotly/plotly.min.js','plotly/chunks/strict-ABCDEFGH.js','plotly/other.js']){
   const target=path.join(publicDir,file)
   fs.mkdirSync(path.dirname(target),{recursive:true})
   fs.writeFileSync(target,'export const fixture = true;')
  }
  server=await createServer({...config,configFile:false,root,publicDir,
   optimizeDeps:{noDiscovery:true,include:[]},
   server:{host:'127.0.0.1',port:0,strictPort:false,watch:null},logLevel:'silent'})
  await server.listen()
  const address=server.httpServer!.address() as {port:number}
  const base=`http://127.0.0.1:${address.port}`
  for(const file of ['/plotly/plotly.min.js','/plotly/chunks/strict-ABCDEFGH.js']){
   const response=await fetch(base+file,{headers:{origin:'null'}})
   assert.equal(response.status,200)
   assert.equal(response.headers.get('access-control-allow-origin'),'*')
   assert.equal(response.headers.get('access-control-allow-credentials'),null)
  }
  const other=await fetch(base+'/plotly/other.js',{headers:{origin:'null'}})
  assert.equal(other.headers.get('access-control-allow-origin'),null)
 }finally{await server?.close();fs.rmSync(publicDir,{recursive:true,force:true})}
})
