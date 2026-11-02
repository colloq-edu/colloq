import '../_env.mts'
import path from 'node:path'
// _env initializes and owns an isolated temporary state directory before any
// server module import. This process never opens the ordinary data/ directory.
process.env.PORT='4317'
process.env.BIND_ADDR='127.0.0.1'
process.env.PUBLIC_URL='http://127.0.0.1:4317'
process.env.STATIC_DIR=path.resolve('web/dist')
process.env.UI_LANGUAGE='en'
process.env.COMPETITION_BACKEND='test'
const {createSession}=await import('../../server/src/db.js')
const {getSessionDoc}=await import('../../server/src/collab/index.js')
const {createCell}=await import('../../shared/notebook.js')
for(const [roomId,council] of [['browser-shared',false],['browser-council',true]] as const){
 createSession(roomId,'Browser reconnect fixture',null)
 const doc=getSessionDoc(roomId).doc
 doc.transact(()=>{
  const cells=doc.getArray('cells');cells.delete(0,cells.length)
  const cell=createCell('code',council?'# Write an answer':'# shared initial',roomId)
  cell.set('open',council?'council':true)
  cells.push([cell])
 })
}
// Notes written against the page around them (markdown.spec.ts). Each cell has
// a known id, so a note can name another cell the way a real one would.
type Fixture={type:'code'|'markdown',source:string}
const markup:Record<string,Fixture[]>={
 'browser-note-names':[
  {type:'markdown',source:'<div class="fixed inset-0 z-[95] bg-canvas">Blocked</div>'},
  {type:'markdown',source:'<button popovertarget="cover">Show the answer</button><div popover="manual" id="cover" style="width:100%;height:100%;background:#000">covered</div>\n\n<button commandfor="modal" command="show-modal">Open</button><dialog id="modal" open>dialog text</dialog>'},
  {type:'markdown',source:'<div data-cell-id="browser-note-names-c5" data-cell-slot="browser-note-names-c5">fake cell</div>\n\n<a id="probe">anchor</a> <label for="probe">label</label> [jump](#probe)'},
  {type:'markdown',source:'```python\nx = 1\n```\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nInline $x^2$ math <code class="language-js fixed">c</code>'},
  {type:'markdown',source:'<map name="m"><area shape="rect" coords="0,0,20,20" href="https://example.com/area"></map><img usemap="#m" alt="mapped" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">\n\n<svg width="200" height="40"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="100" height="20" fill="url(#g)"/><a xlink:href="https://example.com/svg"><text x="110" y="15">svg link</text></a></svg>'},
  {type:'code',source:'print("after")'},
 ],
}
for(const [roomId,fixtures] of Object.entries(markup)){
 createSession(roomId,'Browser markup fixture',null)
 const doc=getSessionDoc(roomId).doc
 doc.transact(()=>{
  const cells=doc.getArray('cells');cells.delete(0,cells.length)
  fixtures.forEach(({type,source},i)=>{const cell=createCell(type,source,`${roomId}-c${i}`);cell.set('open',true);cells.push([cell])})
 })
}
await import('../../server/src/index.js')
