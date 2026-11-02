import {test,expect,type Page} from '@playwright/test'

/*
 * Notes are drawn into the page itself, under the app's own stylesheet and next
 * to the app's own lookups, so what a classmate types has to stay inside its
 * cell for everyone else. These run against the production build: the overlay
 * this guards against is made of the app's real utility classes, and only the
 * built stylesheet says what they do. Fixtures: tests/browser/server.mts.
 */

async function enter(page:Page,room:string){
 await page.goto('/s/'+room)
 await page.locator('#join-name').fill('Reader')
 await page.getByRole('button',{name:/Join the class|Войти на занятие/}).click()
 await expect(page.locator('.prose-note').first()).toBeVisible()
}

/** Whether a press at the centre of the element lands on it, not on something drawn over it. */
function reachable(page:Page,selector:string){
 return page.locator(selector).first().evaluate(element=>{
  element.scrollIntoView({block:'center'})
  const box=element.getBoundingClientRect()
  const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)
  return hit!==null&&(element===hit||element.contains(hit))
 })
}

test('a note cannot lay the app\'s own classes over the room',async({page})=>{
 await enter(page,'browser-note-names')
 const blocked=page.locator('.prose-note div',{hasText:/^Blocked$/})
 await expect(blocked).toBeVisible()
 const placed=await blocked.evaluate(element=>{
  const box=element.getBoundingClientRect(),cell=element.closest('[data-cell-id]')!.getBoundingClientRect()
  return {
   classes:element.getAttribute('class'),position:getComputedStyle(element).position,
   inside:box.top>=cell.top&&box.bottom<=cell.bottom&&box.left>=cell.left&&box.right<=cell.right,
   covers:box.width>=innerWidth&&box.height>=innerHeight,
  }
 })
 expect(placed).toEqual({classes:null,position:'static',inside:true,covers:false})
 // The controls a teacher reaches for to remove such a cell are still there to press.
 expect(await reachable(page,'button:has-text("Run all")')).toBe(true)
 expect(await reachable(page,'[data-cell-id="browser-note-names-c5"] .cm-content')).toBe(true)
})

test('a click in a note opens nothing above the interface',async({page})=>{
 await enter(page,'browser-note-names')
 const notes=page.locator('.prose-note')
 await notes.getByRole('button',{name:'Show the answer'}).click()
 await notes.getByRole('button',{name:'Open',exact:true}).click()
 expect(await page.evaluate(()=>document.querySelectorAll(':popover-open, dialog, :modal').length)).toBe(0)
 // The words stay, in the note's own flow.
 await expect(page.locator('.prose-note',{hasText:'covered'})).toBeVisible()
 await expect(page.locator('.prose-note',{hasText:'dialog text'})).toBeVisible()
 expect(await reachable(page,'button:has-text("Run all")')).toBe(true)
})

test('a note cannot answer to the names the page looks things up by',async({page})=>{
 await enter(page,'browser-note-names')
 const found=await page.evaluate(()=>{
  const cell=document.querySelector('[data-cell-id="browser-note-names-c5"]')
  const own=document.getElementById('user-content-probe')
  return {
   cellIsTheCell:cell!==null&&cell.closest('.prose-note')===null,
   forged:document.querySelectorAll('.prose-note [data-cell-id], .prose-note [data-cell-slot]').length,
   bareId:document.getElementById('probe'),
   ownInNote:own?.closest('.prose-note')!=null,
   label:document.querySelector('.prose-note label')?.getAttribute('for'),
   jump:document.querySelector('.prose-note a[href^="#"]')?.getAttribute('href'),
  }
 })
 expect(found).toEqual({cellIsTheCell:true,forged:0,bareId:null,ownInNote:true,label:'user-content-probe',jump:'#user-content-probe'})
})

test('every kind of link in a note opens beside the room',async({page})=>{
 await enter(page,'browser-note-names')
 await expect(page.locator('.prose-note svg')).toBeVisible()
 const links=await page.evaluate(()=>Array.from(document.querySelectorAll('.prose-note a[*|href], .prose-note area[href]'),link=>link.getAttribute('target')))
 expect(links.length).toBe(3)
 expect(links.every(target=>target==='_blank')).toBe(true)
})

test('ordinary note markup renders as before',async({page})=>{
 await enter(page,'browser-note-names')
 const note=page.locator('.prose-note',{hasText:'x = 1'})
 await expect(note.locator('code.language-python')).toHaveCount(1)
 await expect(note.locator('code.language-js')).toHaveAttribute('class','language-js')
 await expect(note.locator('.table-scroll table')).toHaveCount(1)
 await expect(note.locator('input[type=checkbox]')).toHaveCount(2)
 await expect(note.locator('.katex')).toHaveCount(1)
 // An SVG's references follow its renamed definitions, so the gradient still paints.
 const gradient=await page.locator('.prose-note svg rect').evaluate(rect=>{
  const fill=rect.getAttribute('fill')??'',id=/url\(#(.+)\)/.exec(fill)?.[1]??''
  return {fill,defined:document.getElementById(id)?.localName}
 })
 expect(gradient).toEqual({fill:'url(#user-content-g)',defined:'linearGradient'})
})
