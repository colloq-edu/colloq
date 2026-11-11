import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {SETUP_TOKEN} from './fixture'

for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
 test(`teacher downloads the full leaderboard on a ${viewport.width}px screen`,async({page},testInfo)=>{
  await page.setViewportSize(viewport)
  expect((await page.request.post('/api/admin/signin/token',{data:{token:SETUP_TOKEN}})).ok()).toBe(true)
  await page.goto('/admin/competitions/browser-leaderboard-export/board')
  const link=page.getByRole('link',{name:'Download CSV',exact:true})
  await expect(link).toBeVisible()
  await expect(page.getByText('Anna Browser',{exact:true})).toBeVisible()
  await link.focus()
  await expect(link).toBeFocused()
  const waiting=page.waitForEvent('download')
  await link.press('Enter')
  const download=await waiting
  expect(download.suggestedFilename()).toBe('browser-leaderboard-export-leaderboard.csv')
  const csv=await readFile((await download.path())!,'utf8')
  expect(csv).toBe('\uFEFF"Public place","Participant","Public score","Private place","Private score"\r\n'+
   '"1","Anna Browser","0.1234567890123456","2","-0.5"\r\n'+
   '"2","Boris Browser","0.1","1","0.5"\r\n'+
   '"3","Pending Browser","0","",""\r\n')
  await page.screenshot({path:testInfo.outputPath('leaderboard-export.png'),fullPage:true})
 })
}
