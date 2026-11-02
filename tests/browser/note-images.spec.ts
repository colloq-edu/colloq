import {test,expect,type Page} from '@playwright/test'

/*
 * A figure from the room's folder in a note: `![figure](fig.png)` is shown by a
 * ticket asked for that path (web/src/lib/note-files.svelte.ts). A ticket the
 * network lost, or one refused because the file was not there yet, must not
 * leave the image broken until a reload. The retry is driven by the note's own
 * effect, which only the built app runs: tests/note-files.test.mts checks the
 * rule, this checks that the room acts on it. Fixtures: tests/browser/server.mts.
 */

async function enter(page:Page,room:string){
 await page.goto('/s/'+room)
 await page.locator('#join-name').fill('Reader')
 await page.getByRole('button',{name:/Join the class|Войти на занятие/}).click()
 await expect(page.locator('.prose-note').first()).toBeVisible()
}

/** Whether the note's image has arrived and decoded. */
function shown(page:Page){
 return page.locator('.prose-note img').evaluate(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0)
}

test('a ticket lost on the way is asked again, and the figure appears without a reload',async({context,page})=>{
 let asked=0
 await context.route('**/file/ticket**',route=>{
  asked++
  return asked===1?route.abort('internetdisconnected'):route.continue()
 })
 await enter(page,'browser-note-image')
 // The first wait is one to two seconds.
 await expect.poll(()=>shown(page),{timeout:10_000}).toBe(true)
 await expect(page.locator('.prose-note img')).toHaveAttribute('src',/\/api\/sessions\/browser-note-image\/file\?path=fig\.png&token=/)
 // And once it is there, nothing keeps knocking.
 const settled=asked
 await page.waitForTimeout(3_000)
 expect(settled).toBe(2)
 expect(asked).toBe(settled)
})

test('a figure the folder did not have yet appears once it is uploaded',async({page})=>{
 const first=page.waitForResponse(response=>response.url().includes('/file/ticket'))
 await enter(page,'browser-note-image-late')
 // A retry of this test finds the file uploaded by the first attempt.
 if((await first).status()===404){
  await page.waitForTimeout(500)
  expect(await shown(page)).toBe(false)
  await page.locator('input[type=file]').first().setInputFiles({name:'late.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64')})
 }
 await expect.poll(()=>shown(page),{timeout:10_000}).toBe(true)
})
