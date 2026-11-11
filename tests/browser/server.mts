import '../_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import {NOTES_FILE,NOTES_ROOM,SERVER_NOTES,SETUP_TOKEN,slides} from './fixture.ts'
// _env initializes and owns an isolated temporary state directory before any
// server module import. This process never opens the ordinary data/ directory.
process.env.PORT='4317'
process.env.BIND_ADDR='127.0.0.1'
process.env.PUBLIC_URL='http://127.0.0.1:4317'
process.env.STATIC_DIR=path.resolve('web/dist')
process.env.UI_LANGUAGE='en'
process.env.COMPETITION_BACKEND='test'
// The owner's way back in, known to the specs that need a teacher: the server
// keeps a setup token it finds on disk, so this one is in place before it reads.
fs.mkdirSync(process.env.DATA_DIR!,{recursive:true})
fs.writeFileSync(path.join(process.env.DATA_DIR!,'setup-token'),SETUP_TOKEN+'\n',{mode:0o600})
const {createSession,setNote}=await import('../../server/src/db.js')
const {getSessionDoc}=await import('../../server/src/collab/index.js')
const {createCell,writeOutput}=await import('../../shared/notebook.js')
const {createTeacher}=await import('../../server/src/admin/store.js')
const {makeFile}=await import('../../server/src/workspace.js')
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
// Notes and outputs written against the page around them (markdown.spec.ts,
// outputs.spec.ts). Each cell has a known id, so a note can name another cell
// the way a real one would; outputs are bundles as the kernel writes them.
type Fixture={type:'code'|'markdown',source:string,outputs?:Record<string,string>[]}
const HOST_TAKEOVER='position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;background:black!important'
const markup:Record<string,Fixture[]>={
 'browser-plotly':[
  {type:'code',source:'scatter figure',outputs:[{'application/vnd.plotly.v1+json':JSON.stringify({data:[{type:'scatter',x:[1,2,3],y:[2,1,4],mode:'markers'}],layout:{height:320}})}]},
 ],
 'browser-plotly-3d':[
  {type:'code',source:'three dimensional figure',outputs:[{'application/vnd.plotly.v1+json':JSON.stringify({data:[{type:'scatter3d',x:[1,2,3],y:[2,1,4],z:[1,3,2],mode:'markers'}],layout:{height:320}})}]},
 ],
 'browser-plotly-switch':[
  {type:'code',source:'figure with a trace selector',outputs:[{'application/vnd.plotly.v1+json':JSON.stringify({
   data:[{type:'scatter',x:[1,2,3],y:[2,1,4],mode:'markers'}],
   layout:{height:320,updatemenus:[{type:'buttons',active:-1,buttons:[{label:'Bar',method:'restyle',args:['type','bar']}]}]},
  })}]},
 ],
 'browser-note-names':[
  {type:'markdown',source:'<div class="fixed inset-0 z-[95] bg-canvas">Blocked</div>'},
  {type:'markdown',source:'<button popovertarget="cover">Show the answer</button><div popover="manual" id="cover" style="width:100%;height:100%;background:#000">covered</div>\n\n<button commandfor="modal" command="show-modal">Open</button><dialog id="modal" open>dialog text</dialog>'},
  {type:'markdown',source:'<div data-cell-id="browser-note-names-c5" data-cell-slot="browser-note-names-c5">fake cell</div>\n\n<a id="probe">anchor</a> <label for="probe">label</label> [jump](#probe)'},
  {type:'markdown',source:'```python\nx = 1\n```\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nInline $x^2$ math <code class="language-js fixed">c</code>'},
  {type:'markdown',source:'<map name="m"><area shape="rect" coords="0,0,20,20" href="https://example.com/area"></map><img usemap="#m" alt="mapped" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">\n\n<svg width="200" height="40"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="100" height="20" fill="url(#g)"/><a xlink:href="https://example.com/svg"><text x="110" y="15">svg link</text></a></svg>'},
  {type:'code',source:'print("after")'},
 ],
 'browser-note-math':[
  {type:'markdown',source:'before <span data-math="%">broken</span> <span data-math="%ZZ">zz</span> <span data-math="%E0%A4%A">utf</span> <span data-math="%5Cfrac%7B1%7D%7B2%7D">fraction</span> after\n\n<div data-math="x" data-display="">display</div>'},
  {type:'markdown',source:'Inline $x^2$ and an unparsable $\\frac{1}{$ one\n\n$$\\frac{a}{b}$$'},
  {type:'markdown',source:'**bold** text'},
  {type:'code',source:'print("after")'},
 ],
 'browser-output-host':[
  {type:'code',source:'display(HTML(host))',outputs:[{'text/html':`<b>owned</b><style>:host{${HOST_TAKEOVER}}</style>`}]},
  {type:'code',source:'display(SVG(context))',outputs:[{'image/svg+xml':`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><style>:host-context(body){${HOST_TAKEOVER}}</style><rect width="80" height="20"/></svg>`}]},
  {type:'code',source:'display(HTML(popover))',outputs:[{'text/html':'<button popovertarget="cover">show</button><div popover="manual" id="cover" style="width:100vw;height:100vh;margin:0;background:red">covered</div>'}]},
  {type:'code',source:'df.style',outputs:[
   {'text/html':'<table><tr><td id="T_cell">1</td></tr></table><style>#T_cell{background-color:rgb(255, 0, 0)}</style>'},
   {'image/svg+xml':'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><style>.patch{fill:rgb(0, 128, 0)}</style><rect class="patch" width="80" height="20"/></svg>'},
  ]},
  {type:'code',source:'print("after")'},
 ],
}
for(const [roomId,fixtures] of Object.entries(markup)){
 createSession(roomId,'Browser markup fixture',null)
 const doc=getSessionDoc(roomId).doc
 doc.transact(()=>{
  const cells=doc.getArray('cells');cells.delete(0,cells.length)
  fixtures.forEach(({type,source,outputs=[]},i)=>{
   const cell=createCell(type,source,`${roomId}-c${i}`);cell.set('open',true);cells.push([cell])
   // An output goes in after the cell is in the document: a detached Y.Map has no `outputs` to read yet.
   for(const data of outputs){cell.get('outputs').push([writeOutput({kind:'data',data,execCount:1})]);cell.set('execCount',1);cell.set('state','ok')}
  })
 })
}
// A note showing a figure from the room's folder (note-images.spec.ts): one room
// has the file from the start, the other gets it uploaded during the test.
const {sessionDir}=await import('../../server/src/workspace.js')
const {writeFileSync}=await import('node:fs')
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64')
for(const [roomId,name,seeded] of [['browser-note-image','fig.png',true],['browser-note-image-late','late.png',false]] as const){
 createSession(roomId,'Browser note image fixture',null)
 const doc=getSessionDoc(roomId).doc
 doc.transact(()=>{
  const cells=doc.getArray('cells');cells.delete(0,cells.length)
  const note=createCell('markdown',`Figure: ![figure](${name})`,`${roomId}-c0`);note.set('open',true);cells.push([note])
  const code=createCell('code','print("after")',`${roomId}-c1`);code.set('open',true);cells.push([code])
 })
 if(seeded)writeFileSync(path.join(sessionDir(roomId),name),PNG)
}
// A claimed instance, as a claim leaves it, but with the setup token kept: the
// owner it signs in as is staff of every room, so the room makes them its host.
createTeacher({email:'owner@test.local',name:'Browser owner',role:'owner'})
createSession(NOTES_ROOM,'Browser notes fixture',null)
makeFile(NOTES_ROOM,NOTES_FILE,slides(SERVER_NOTES.length))
SERVER_NOTES.forEach((text,index)=>setNote(NOTES_ROOM,NOTES_FILE,index+1,text))
// A complete board with different public/private ranks and a pending private score.
const {createCompetition,createEntrant,acceptSubmission,updateSubmission,setCompetitionState,leaveQueue}=await import('../../server/src/competitions/store.js')
const exportCompetition=createCompetition({slug:'browser-leaderboard-export',title:'Leaderboard export',metric:{direction:'higher'},privateRelease:'manual'})!
setCompetitionState(exportCompetition.id,'live')
for(const [name,publicScore,privateScore] of [['Anna Browser',0.1234567890123456,-0.5],['Boris Browser',0.1,0.5],['Pending Browser',0,null]] as const){
 const entrant=createEntrant(name).entrant
 const submission=acceptSubmission({competitionId:exportCompetition.id,entrantId:entrant.id,fileName:'answer.ipynb',bytes:2})
 updateSubmission(submission.id,{state:'scored',publicScore,privateScore})
 leaveQueue(submission.id)
}
await import('../../server/src/index.js')
