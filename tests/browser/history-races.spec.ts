import {test, expect, type Page, type Route} from '@playwright/test'
import type {Version} from '../../shared/history'
import {SETUP_TOKEN} from './fixture'

const version = (seq: number): Version => ({
  seq, kind:'checkpoint', authorId:null, authorName:null, authorColor:null,
  createdAt:1_700_000_000_000 + seq * 60_000, label:`Version ${seq}`,
  summary:'', targetSeq:null, added:0, removed:0, cells:['browser-shared'],
})
const detail = (seq: number) => ({
  version:version(seq), diffs:[],
  cells:[{id:'browser-shared', type:'code', source:`source from version ${seq}`}],
})
async function enterHistory(page:Page) {
  await page.goto('/s/browser-shared')
  const name=page.locator('#join-name')
  const editor=page.locator('[data-cell-id="browser-shared"] .cm-content')
  await expect(name.or(editor)).toBeVisible()
  if(await name.isVisible()){
    await name.fill('History reader')
    await page.getByRole('button',{name:'Join the class',exact:true}).click()
  }
  await expect(page.locator('[data-cell-id="browser-shared"] .cm-content')).toBeVisible()
  await page.getByRole('button',{name:'Terminal, kernel log and history',exact:true}).click()
  await page.getByRole('button',{name:'History',exact:true}).click()
  const versions=page.getByRole('button',{name:'Notebook versions',exact:true})
  if(await versions.isVisible())await versions.click()
}
async function list(page:Page) {
  await page.route('**/api/sessions/browser-shared/history', route => route.fulfill({
    json:{versions:[version(3),version(2),version(1)],trimmed:false},
  }))
}

// A late rejected request must never replace a newer visible selection.
test('late history failure leaves the newly selected version visible', async ({page}) => {
  await list(page)
  let old:Route|undefined
  await page.route('**/api/sessions/browser-shared/history/*', async route => {
    const seq=Number(route.request().url().split('/').at(-1))
    if(seq===1){old=route;return}
    await route.fulfill({json:detail(seq)})
  })
  await enterHistory(page)
  await expect(page.locator('.hist-source')).toHaveText('source from version 3')
  await page.getByRole('button',{name:/Version 1/}).click()
  await expect.poll(()=>Boolean(old)).toBe(true)
  await page.getByRole('button',{name:/Version 2/}).click()
  await expect(page.locator('.hist-source')).toHaveText('source from version 2')
  await old!.fulfill({status:400,json:{error:'old request failed'}})
  // Let fetch's rejection and Svelte's scheduled render consume the response.
  await page.waitForTimeout(100)
  expect(await page.locator('.hist-change [role="alert"]').count()).toBe(0)
  await expect(page.locator('.hist-source')).toHaveText('source from version 2')
})

test('a pending version survives a visit to Activity and back',async({page})=>{
  expect((await page.request.post('/api/admin/signin/token',{data:{token:SETUP_TOKEN}})).ok()).toBe(true)
  await list(page)
  let pending:Route|undefined
  await page.route('**/api/sessions/browser-shared/history/3',route=>{pending=route})
  await enterHistory(page)
  await expect.poll(()=>Boolean(pending)).toBe(true)
  await page.getByRole('button',{name:'Class activity',exact:true}).click()
  await page.getByRole('button',{name:'Notebook versions',exact:true}).click()
  await pending!.fulfill({json:detail(3)})
  await expect(page.locator('.hist-source')).toHaveText('source from version 3')
})

// A → B → A can have two simultaneous requests for A. Comparing only its
// version number lets the first A overwrite the second A's successful retry.
test('history retry ignores the failure of an earlier request for the same version', async ({page}) => {
  await list(page)
  let old:Route|undefined
  await page.route('**/api/sessions/browser-shared/history/*', async route => {
    const seq=Number(route.request().url().split('/').at(-1))
    if(seq===1&&!old){old=route;return}
    await route.fulfill({json:detail(seq)})
  })
  await enterHistory(page)
  await expect(page.locator('.hist-source')).toHaveText('source from version 3')
  await page.getByRole('button',{name:/Version 1/}).click()
  await expect.poll(()=>Boolean(old)).toBe(true)
  await page.getByRole('button',{name:/Version 2/}).click()
  await expect(page.locator('.hist-source')).toHaveText('source from version 2')
  await page.getByRole('button',{name:/Version 1/}).click()
  await expect(page.locator('.hist-source')).toHaveText('source from version 1')
  await old!.fulfill({status:400,json:{error:'earlier retry failed'}})
  await page.waitForTimeout(100)
  expect(await page.locator('.hist-change [role="alert"]').count()).toBe(0)
  await expect(page.locator('.hist-source')).toHaveText('source from version 1')
})

for (const stale of ['success', 'failure'] as const) {
  test(`late history list ${stale} cannot replace a newer refresh`, async ({page}) => {
    let old:Route|undefined
    let lists=0
    await page.route('**/api/sessions/browser-shared/history', async route => {
      lists += 1
      if(lists===1){old=route;return}
      await route.fulfill({json:{versions:[version(2)],trimmed:false}})
    })
    await page.route('**/api/sessions/browser-shared/history/2', route => route.fulfill({json:detail(2)}))
    await enterHistory(page)
    await expect.poll(()=>Boolean(old)).toBe(true)
    const editor=page.locator('[data-cell-id="browser-shared"] .cm-content')
    await editor.click()
    await page.keyboard.insertText(`# refresh ${stale}\n`)
    await expect(page.locator('.hist-source')).toHaveText('source from version 2')
    await old!.fulfill(stale==='success'
      ? {json:{versions:[version(1)],trimmed:true}}
      : {status:400,json:{error:'old list failed'}})
    await page.waitForTimeout(100)
    expect(await page.locator('.hist-change [role="alert"]').count()).toBe(0)
    await expect(page.locator('.hist-row')).toHaveCount(1)
    expect(await page.locator('.hist-row').innerText()).toContain('Version 2')
    await expect(page.locator('.hist-source')).toHaveText('source from version 2')
  })
}

test('an older list finishing cannot clear the current refresh loading state', async ({page},testInfo) => {
  const pending:Route[]=[]
  await page.route('**/api/sessions/browser-shared/history', route => {pending.push(route)})
  await page.route('**/api/sessions/browser-shared/history/2', route => route.fulfill({json:detail(2)}))
  await enterHistory(page)
  await expect.poll(()=>pending.length).toBe(1)
  await page.locator('[data-cell-id="browser-shared"] .cm-content').click()
  await page.keyboard.insertText('# loading refresh\n')
  await expect.poll(()=>pending.length).toBeGreaterThanOrEqual(2)
  await pending[0].fulfill({json:{versions:[],trimmed:false}})
  await page.waitForTimeout(100)
  expect(await page.locator('.hist-list').innerText()).toBe('Loading history…')
  await page.screenshot({path:testInfo.outputPath('history-loading.png')})
  await pending.at(-1)!.fulfill({json:{versions:[version(2)],trimmed:false}})
  await expect(page.locator('.hist-source')).toHaveText('source from version 2')
})
