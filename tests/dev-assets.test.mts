import './_env.mts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {layOutWebAssets} from '../cli/src/web-assets.js'

const launch=fs.readFileSync(new URL('../cli/src/launch.ts',import.meta.url),'utf8')
test('the dev launcher lays static assets out before Vite starts',()=>{
 const at=launch.indexOf('if (dev) layOutWebAssets(root)')
 assert.ok(at>0)
 assert.ok(at<launch.indexOf("'Dev frontend'"))
})

test('dev startup copies the PDF worker and executes the modular Plotly generator',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-dev-assets-'))
 try{
  const worker=path.join(root,'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')
  fs.mkdirSync(path.dirname(worker),{recursive:true})
  fs.writeFileSync(worker,'pdf worker fixture')
  fs.mkdirSync(path.join(root,'web/scripts'),{recursive:true})
  fs.writeFileSync(path.join(root,'web/package.json'),'{}')
  // The external build process is the boundary. The real supervisor must
  // execute it, not silently copy an obsolete monolithic package over it.
  fs.writeFileSync(path.join(root,'web/scripts/plotly.mjs'),`
   import fs from 'node:fs';
   fs.mkdirSync('web/public/plotly/chunks',{recursive:true});
   fs.writeFileSync('web/public/plotly/plotly.min.js','import "./chunks/strict.js"');
   fs.writeFileSync('web/public/plotly/chunks/strict.js','strict module fixture');
  `)
  layOutWebAssets(root)
  assert.equal(fs.readFileSync(path.join(root,'web/public/pdf/pdf.worker.min.mjs'),'utf8'),'pdf worker fixture')
  assert.equal(fs.readFileSync(path.join(root,'web/public/plotly/plotly.min.js'),'utf8'),'import "./chunks/strict.js"')
  assert.equal(fs.readFileSync(path.join(root,'web/public/plotly/chunks/strict.js'),'utf8'),'strict module fixture')
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
