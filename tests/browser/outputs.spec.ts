import {test,expect,type Page} from '@playwright/test'

/*
 * Rich kernel output keeps its own stylesheets (pandas' `df.style`, a figure's
 * `<style>` in its SVG), so it is drawn in a shadow root, and the root must
 * hold: whatever the output's CSS selects, `:host` and `:host-context()`
 * included, stays inside the output's box. Fixtures: tests/browser/server.mts.
 */

async function enter(page:Page,room:string){
 await page.goto('/s/'+room)
 await page.locator('#join-name').fill('Reader')
 await page.getByRole('button',{name:/Join the class|Войти на занятие/}).click()
 await expect(page.locator(`[data-cell-id="${room}-c4"] .cm-content`)).toBeVisible()
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

/** The elements of every output's markup, wherever its roots put them. */
const deep=`(selector)=>{
 const found=[],walk=(root)=>{for(const element of root.querySelectorAll('*')){if(element.matches(selector))found.push(element);if(element.shadowRoot)walk(element.shadowRoot)}}
 walk(document);return found
}`

test('an output cannot move or cover the element it is drawn in',async({page})=>{
 await enter(page,'browser-output-host')
 // The editor is ready before optional rich output. Assert the real output
 // hosts have arrived before checking that their styles cannot escape.
 await expect(page.locator('[data-cell-id] div[style*="contain"]')).toHaveCount(5)
 const hosts=await page.evaluate(()=>Array.from(document.querySelectorAll<HTMLElement>('[data-cell-id] div[style*="contain"]'),host=>{
  const box=host.getBoundingClientRect(),cell=host.closest('[data-cell-id]')!.getBoundingClientRect()
  return {position:getComputedStyle(host).position,inCell:box.top>=cell.top&&box.left>=cell.left,covers:box.width>=innerWidth&&box.height>=innerHeight}
 }))
 expect(hosts.length).toBe(5)
 for(const host of hosts)expect(host).toEqual({position:'static',inCell:true,covers:false})
 // The controls stay pressable, the toolbar's and the next cell's.
 expect(await reachable(page,'button:has-text("Run all")')).toBe(true)
 expect(await reachable(page,'[data-cell-id="browser-output-host-c4"] .cm-content')).toBe(true)
})

test('a click in an output opens nothing above the page',async({page})=>{
 await enter(page,'browser-output-host')
 await page.getByRole('button',{name:'show',exact:true}).click()
 const open=await page.evaluate(`(${deep})(':popover-open').length`)
 expect(open).toBe(0)
 expect(await reachable(page,'button:has-text("Run all")')).toBe(true)
})

test('an output\'s own stylesheet still styles the output',async({page})=>{
 await enter(page,'browser-output-host')
 await expect.poll(()=>page.evaluate(`(${deep})('#T_cell').map(cell=>getComputedStyle(cell).backgroundColor)`)).toEqual(['rgb(255, 0, 0)'])
 await expect.poll(()=>page.evaluate(`(${deep})('rect.patch').map(rect=>getComputedStyle(rect).fill)`)).toEqual(['rgb(0, 128, 0)'])
})
