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
await import('../../server/src/index.js')
