import {test,expect,type BrowserContext,type Page,type WebSocketRoute,type Locator} from '@playwright/test'

async function join(page:Page,room:string,name:string){
 await page.goto('/s/'+room)
 await page.locator('#join-name').fill(name)
 await page.getByRole('button',{name:/Join the class|Войти на занятие/}).click()
 const editor=page.locator(`[data-cell-id="${room}"] .cm-content[contenteditable="true"]`).last()
 await expect(editor).toBeVisible()
 return editor
}
async function expectCode(editor:Locator,value:string){
 // Remote cursor widgets include participant names inside .cm-content. Compare
 // only rendered code lines, excluding decorations, rather than their labels.
 await expect.poll(()=>editor.evaluate(element=>Array.from(element.querySelectorAll('.cm-line')).map(line=>{
  const copy=line.cloneNode(true) as HTMLElement
  copy.querySelectorAll('.cm-ySelectionCaret').forEach(cursor=>cursor.remove())
  return copy.textContent??''
 }).join('\n'))).toBe(value)
}
async function replaceText(editor:Locator,value:string){
 await editor.click();await editor.press('ControlOrMeta+A');await editor.pressSequentially(value)
 await expectCode(editor,value)
}
/** The frames normally reach the real server unmodified; only connection
 * closure/reconnect is controlled. This exercises the actual browser queue. */
async function connection(context:BrowserContext){
 let disconnected=false,blocked=0
 const routes=new Set<WebSocketRoute>()
 const drafts=new Map<string,string>()
 await context.routeWebSocket(/\/(collab|control|file)\//,route=>{
  if(disconnected){blocked++;void route.close({code:1012,reason:'Offline test'});return}
  const server=route.connectToServer();routes.add(route)
  server.onMessage(message=>{
   route.send(message)
   if(typeof message==='string')try{const value=JSON.parse(message);if(value.t==='council:mine'&&value.state)drafts.set(value.cellId,value.state.text)}catch{/* binary or unrelated frame */}
  })
 })
 return {
  async offline(){disconnected=true;await Promise.all([...routes].map(route=>route.close({code:1012,reason:'Offline test'}).catch(()=>{})));routes.clear();await expect.poll(()=>blocked).toBeGreaterThan(0)},
  online(){disconnected=false},
  draft(cellId:string){return drafts.get(cellId)},
 }
}

test('shared notebook synchronizes an offline edit with another browser and survives reload',async({browser})=>{
 const first=await browser.newContext(),second=await browser.newContext()
 try{
  const wire=await connection(first),a=await first.newPage(),b=await second.newPage()
  const local=await join(a,'browser-shared','Alice'),remote=await join(b,'browser-shared','Bob')
  await replaceText(local,'# synchronized before disconnect');await expectCode(remote,'# synchronized before disconnect')
  await wire.offline();await replaceText(local,'# final offline version');await expectCode(remote,'# synchronized before disconnect')
  wire.online();await expectCode(remote,'# final offline version')
  await b.reload();await expectCode(b.locator('[data-cell-id="browser-shared"] .cm-content').last(),'# final offline version')
 }finally{await first.close();await second.close()}
})

test('council draft A → B → A reconnects with the last value on a fresh browser',async({browser})=>{
 const context=await browser.newContext()
 let fresh:BrowserContext|undefined
 try{
  const wire=await connection(context),page=await context.newPage()
  const editor=await join(page,'browser-council','Draft author')
  await wire.offline()
  for(const value of ['answer A','answer B','answer A']){
   await replaceText(editor,value)
   // The production draft debounce is 800ms; each change represents a distinct
   // offline snapshot, including the user's undo back to A.
   await page.waitForTimeout(900)
  }
  wire.online()
  await expect.poll(()=>wire.draft('browser-council')).toBe('answer A')
  // New context keeps the signed room identity, but has no IndexedDB/Yjs draft.
  fresh=await browser.newContext({storageState:await context.storageState()})
  const reader=await fresh.newPage();await reader.goto('/s/browser-council')
  await expectCode(reader.locator('[data-cell-id="browser-council"] .cm-content[contenteditable="true"]').last(),'answer A')
 }finally{await fresh?.close();await context.close()}
})
