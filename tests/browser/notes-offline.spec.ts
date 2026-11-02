import {test,expect,type BrowserContext,type Locator,type Page,type WebSocketRoute} from '@playwright/test'
import {NOTES_FILE,NOTES_ROOM,SETUP_TOKEN} from './fixture'

/*
 * Speaker notes typed while the server cannot answer are the teacher's to
 * keep: the real editor, the real control socket and the real server, with
 * only the connection and the timing of the server's answers controlled.
 *
 * Turning to another slide and back used to load the server's older text
 * into the field, because an edit waiting for its acknowledgement lived only
 * in the outbox; the next keystroke then replaced that queued edit with
 * "old text + keystroke", and what was typed offline never reached the server.
 * The lecture column did the same to a field left after a pause, and a late
 * echo of an older text, or a save lost with a dying socket, ended the same
 * way. The session now keeps unconfirmed edits and shows them over the
 * server's map (web/src/lib/notes-outbox.ts).
 */

type Notes=Record<string,string>

/** The room's sockets reach the real server; the test only cuts them, slows the
 * server's answers, or swallows the editor's saves on a connection about to die. */
async function wire(context:BrowserContext){
 let disconnected=false,blocked=0,delay=0,swallow=false
 const routes=new Set<WebSocketRoute>()
 const maps:Notes[]=[]
 await context.routeWebSocket(/\/(collab|control|file)\//,route=>{
  if(disconnected){blocked++;void route.close({code:1012,reason:'Offline test'});return}
  const server=route.connectToServer();routes.add(route)
  const control=/\/control\//.test(route.url())
  // Each answer keeps its own deadline and its place in line.
  let line=Promise.resolve()
  server.onMessage(message=>{
   if(control&&typeof message==='string')try{const value=JSON.parse(message);if(value.t==='notes')maps.push(value.notes)}catch{/* not JSON */}
   if(!control){route.send(message);return}
   // Through the line even with no delay, so nothing overtakes a held frame.
   const due=Date.now()+delay
   line=line.then(()=>new Promise(resolve=>setTimeout(resolve,Math.max(0,due-Date.now())))).then(()=>route.send(message)).catch(()=>{})
  })
  route.onMessage(message=>{
   if(control&&swallow&&typeof message==='string'&&message.includes('"notes:set"'))return
   server.send(message)
  })
 })
 return {
  async offline(){disconnected=true;await Promise.all([...routes].map(route=>route.close({code:1012,reason:'Offline test'}).catch(()=>{})));routes.clear();await expect.poll(()=>blocked).toBeGreaterThan(0)},
  online(){disconnected=false},
  slow(ms:number){delay=ms},
  swallowSaves(on:boolean){swallow=on},
  /** The last full map the server sent: its own state, read back. */
  last(){return maps.at(-1)},
  maps,
 }
}

/** The owner signs in and enters the room, which makes them its host. */
async function enterRoom(page:Page){
 expect((await page.request.post('/api/admin/signin/token',{data:{token:SETUP_TOKEN}})).ok()).toBe(true)
 await page.goto('/s/'+NOTES_ROOM)
 // The files panel names a file in two parts: "slides" and ".pdf".
 const [stem,extension]=NOTES_FILE.split('.')
 const name=page.locator('#join-name')
 const file=page.getByRole('region',{name:'Class files'}).getByRole('button',{name:new RegExp(`^${stem}\\s*\\.${extension}$`)})
 await expect(name.or(file)).toBeVisible()
 if(await name.isVisible()){
  await name.fill('Teacher')
  await page.getByRole('button',{name:/Join the class|Войти на занятие/}).click()
 }
 return {file}
}

/** The host opens the notes editor on the deck from its reader. */
async function openEditor(page:Page){
 const {file}=await enterRoom(page)
 await file.click()
 await page.locator('[data-notes-open]').first().click()
 const dialog=page.getByRole('dialog')
 const field=dialog.locator('.cm-content[data-notes]')
 await expect(field).toBeVisible()
 return {dialog,field}
}

/** The same teacher starts a lecture on the deck: the presenter's column holds the notes field. */
async function startLecture(page:Page){
 const {file}=await enterRoom(page)
 const pad=page.locator('textarea[data-notes]').first()
 // A lecture an earlier attempt left running is taken as it is.
 const running=await pad.waitFor({state:'visible',timeout:2000}).then(()=>true,()=>false)
 if(!running){
  await file.click()
  await page.getByTitle('Start a lecture with this document').click()
 }
 await expect(pad).toBeVisible()
 return pad
}

async function textOf(field:Locator){
 return field.evaluate(element=>Array.from(element.querySelectorAll('.cm-line')).map(line=>line.textContent??'').join('\n'))
}
async function expectText(field:Locator,value:string){await expect.poll(()=>textOf(field)).toBe(value)}
/** Replace the note, and give the editor its pause so the save leaves. */
async function write(page:Page,field:Locator,value:string){
 await field.click();await page.keyboard.press('ControlOrMeta+A');await page.keyboard.insertText(value)
 await expectText(field,value);await page.waitForTimeout(700)
}
async function append(page:Page,field:Locator,value:string){
 await field.click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText(value)
 await page.waitForTimeout(700)
}
async function turn(page:Page,dialog:Locator,step:1|-1,to:number){
 await page.keyboard.press(step>0?'ControlOrMeta+ArrowDown':'ControlOrMeta+ArrowUp')
 await expect(dialog.locator(`[data-slide="${to}"]`)).toHaveAttribute('aria-current','true')
}
/** What the server holds, read by a browser that never saw any of these edits. */
async function serverNotes(browser:import('@playwright/test').Browser):Promise<Notes|undefined>{
 const context=await browser.newContext()
 try{
  const fresh=await wire(context),page=await context.newPage()
  await openEditor(page)
  await expect.poll(()=>fresh.last()).toBeTruthy()
  return fresh.last()
 }finally{await context.close()}
}

/** A mark of this run: a retry or a repeat finds the previous run's texts on the server. */
const run=()=>Math.random().toString(36).slice(2,7)

test('offline edits survive turning slides back and forth, and all of them reach the server',async({browser})=>{
 const context=await browser.newContext()
 try{
  const net=await wire(context),page=await context.newPage()
  const {dialog,field}=await openEditor(page)
  // The editor opens on the server's text, whatever an earlier run left there.
  await expect.poll(()=>net.last()).toBeTruthy()
  const before=net.last()!
  await expectText(field,before[1]??'')
  const [one,two,three]=['one','two','three'].map(word=>`Offline page-${word} edit ${run()}`)
  await net.offline()
  await write(page,field,one)
  await turn(page,dialog,1,2);await expectText(field,before[2]??'')
  await write(page,field,two)
  // Back on the first slide: the text typed here, not the server's older one.
  await turn(page,dialog,-1,1);await expectText(field,one)
  await append(page,field,' + next edit')
  await turn(page,dialog,1,2);await expectText(field,two)
  await turn(page,dialog,1,3);await write(page,field,three)
  for(let cycle=0;cycle<2;cycle+=1){
   await turn(page,dialog,-1,2);await expectText(field,two)
   await turn(page,dialog,-1,1);await expectText(field,one+' + next edit')
   await turn(page,dialog,1,2);await turn(page,dialog,1,3);await expectText(field,three)
  }
  const expected={1:one+' + next edit',2:two,3:three}
  net.online()
  await expect.poll(()=>net.last(),{timeout:20_000}).toEqual(expected)
  await expect(dialog.getByText(/^Saved/)).toBeVisible()
  expect(await serverNotes(browser)).toEqual(expected)
 }finally{await context.close()}
})

test('a late acknowledgement of an older text does not hand the slide back to it',async({browser})=>{
 const context=await browser.newContext()
 try{
  const net=await wire(context),page=await context.newPage()
  const {dialog,field}=await openEditor(page)
  const [a,ab]=[`Late A ${run()}`,`Late AB ${run()}`]
  // The server's echoes arrive seconds late, as over a lossy link: A → AB → A.
  net.slow(2500)
  for(const value of [a,ab,a])await write(page,field,value)
  await turn(page,dialog,1,2);await turn(page,dialog,-1,1)
  await expectText(field,a)
  await append(page,field,' then more')
  // While the echoes of A and AB land, the field keeps the newest text.
  await page.waitForTimeout(3000)
  await expectText(field,a+' then more')
  net.slow(0)
  await turn(page,dialog,1,2);await turn(page,dialog,-1,1)
  await expectText(field,a+' then more')
  await expect(dialog.getByText(/^Saved/)).toBeVisible({timeout:20_000})
  expect((await serverNotes(browser))?.[1]).toBe(a+' then more')
 }finally{await context.close()}
})

test('a save the dying connection swallowed is sent again after reconnecting',async({browser})=>{
 const context=await browser.newContext()
 try{
  const net=await wire(context),page=await context.newPage()
  const {dialog,field}=await openEditor(page)
  await turn(page,dialog,1,2)
  const lost=`Sent into a dead line ${run()}`
  // The save leaves the tab and never reaches the server; then the line drops.
  net.swallowSaves(true)
  await write(page,field,lost)
  await net.offline();net.swallowSaves(false)
  await turn(page,dialog,-1,1);await turn(page,dialog,1,2)
  await expectText(field,lost)
  net.online()
  await expect.poll(()=>net.last()?.[2],{timeout:20_000}).toBe(lost)
  expect((await serverNotes(browser))?.[2]).toBe(lost)
 }finally{await context.close()}
})

test('the lecture column keeps an offline edit when the field is left after a pause',async({browser})=>{
 const context=await browser.newContext()
 try{
  const net=await wire(context),page=await context.newPage()
  const pad=await startLecture(page)
  await expect.poll(()=>net.last()).toBeTruthy()
  const kept=`Pad offline ${run()}`
  await net.offline()
  await pad.click();await page.keyboard.press('ControlOrMeta+A');await page.keyboard.insertText(kept)
  // Past the column's own-echo window (1.5 s), then out of the field: the
  // server's older text used to come back into it here, and the next
  // keystroke saved that text over the one typed offline.
  await page.waitForTimeout(2500)
  await pad.evaluate(element=>(element as HTMLTextAreaElement).blur())
  await page.waitForTimeout(1000)
  await expect(pad).toHaveValue(kept)
  await pad.click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText(' + more')
  await page.waitForTimeout(700)
  net.online()
  await expect.poll(()=>net.last()?.[1],{timeout:20_000}).toBe(kept+' + more')
  // The room is left as it was found. "End" takes a second press, and is
  // refused until both of the room's sockets are back (the shared document's
  // one waits out its own backoff), so it is pressed until the lecture is gone.
  const end=page.getByTitle(/^End lecture/)
  await expect(async()=>{
   if(await pad.isVisible()){await end.click({timeout:2000});await end.click({timeout:2000})}
   await expect(pad).toBeHidden({timeout:2000})
  }).toPass({timeout:30_000})
 }finally{await context.close()}
})
