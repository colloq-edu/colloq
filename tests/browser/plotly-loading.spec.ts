import {test,expect,type Page} from '@playwright/test'
import {gzipSync} from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

async function enter(page:Page,room:string){
 await page.goto('/s/'+room)
 await page.locator('#join-name').fill('Figure reader')
 await page.getByRole('button',{name:'Join the class',exact:true}).click()
 await expect(page.locator('iframe[title="Interactive plotly figure"]')).toBeVisible()
 return page.frameLocator('iframe[title="Interactive plotly figure"]')
}

test('a cold scatter fetches only its real module graph within 450 KiB gzip',async({page})=>{
 const resources=new Map<string,Promise<Buffer>>()
 page.on('response',response=>{
  const url=new URL(response.url())
  if(/^\/plotly\/.*\.js$/.test(url.pathname))resources.set(url.pathname,response.body())
 })
 const frame=await enter(page,'browser-plotly')
 await expect(frame.locator('.scatterlayer .point')).toHaveCount(3)
 const bytes=await Promise.all([...resources.values()])
 const total=bytes.reduce((sum,body)=>sum+gzipSync(body,{level:9}).length,0)
 expect(total/1024).toBeLessThanOrEqual(450)
 expect(resources.size).toBeGreaterThan(1)
 expect([...resources.keys()].some(file=>/scatter3d|scattermap|choropleth/.test(file))).toBe(false)
 await expect(page.locator('iframe')).toHaveAttribute('sandbox','allow-scripts allow-downloads')
 const isolation=await frame.locator('body').evaluate(()=>{
  let parentBlocked=false,cookiesBlocked=false
  try{void window.parent.document}catch{parentBlocked=true}
  try{void document.cookie}catch{cookiesBlocked=true}
  return {origin:window.origin,parentBlocked,cookiesBlocked}
 })
 expect(isolation).toEqual({origin:'null',parentBlocked:true,cookiesBlocked:true})
})

test('all upstream strict trace types remain available on demand',async({page})=>{
 const frame=await enter(page,'browser-plotly')
 await expect(frame.locator('.scatterlayer .point')).toHaveCount(3)
 const manifest=JSON.parse(fs.readFileSync(path.resolve('web/dist/plotly/manifest.json'),'utf8'))
 expect(manifest.traces).toEqual([
  'bar','barpolar','box','candlestick','carpet','choropleth','choroplethmap','cone','contour',
  'contourcarpet','densitymap','funnel','funnelarea','heatmap','histogram','histogram2d',
  'histogram2dcontour','icicle','image','indicator','isosurface','mesh3d','ohlc','parcats',
  'parcoords','pie','quiver','sankey','scatter','scatter3d','scattercarpet','scattergeo',
  'scattergl','scattermap','scatterpolar','scatterpolargl','scattersmith','scatterternary',
  'splom','streamtube','sunburst','surface','table','treemap','violin','volume','waterfall',
 ])
 const types=await frame.locator('body').evaluate(async(_body,traces:string[])=>{
  const runtime=await import('/plotly/plotly.min.js')
  const Plotly=await runtime.prepare({data:traces.map(type=>({type}))})
  return Object.keys(Plotly.PlotSchema.get().traces).sort()
 },manifest.traces)
 expect(types).toEqual(manifest.traces)
})

test('loading a map trace applies its real MapLibre stylesheet inside the opaque frame',async({page})=>{
 const frame=await enter(page,'browser-plotly')
 await expect(frame.locator('.scatterlayer .point')).toHaveCount(3)
 const actual=await frame.locator('body').evaluate(async body=>{
  const runtime=await import('/plotly/plotly.min.js?modules=1')
  await runtime.prepare({data:[{type:'scattermap',lat:[40],lon:[30]}]})
  // The sandbox deliberately cannot fetch map tiles or start network workers.
  // Probe the upstream map container/canvas layout after loading its real
  // module: a missing stylesheet breaks maps even before either is needed.
  const map=document.createElement('div')
  map.className='maplibregl-map'
  const canvas=document.createElement('canvas')
  canvas.className='maplibregl-canvas'
  map.appendChild(canvas)
  body.appendChild(map)
  const mapStyle=getComputedStyle(map),canvasStyle=getComputedStyle(canvas)
  const result={mapPosition:mapStyle.position,overflow:mapStyle.overflow,
   fontSize:mapStyle.fontSize,lineHeight:mapStyle.lineHeight,canvasPosition:canvasStyle.position}
  map.remove()
  return result
 })
 expect(actual).toEqual({mapPosition:'relative',overflow:'hidden',fontSize:'12px',lineHeight:'20px',canvasPosition:'absolute'})
})

test('a 3D scatter renders after loading its strict trace modules',async({page})=>{
 const failures:string[]=[]
 page.on('console',message=>{if(message.type()==='error')failures.push(message.text())})
 const frame=await enter(page,'browser-plotly-3d')
 await expect(frame.locator('.gl-container canvas')).toBeVisible()
 await expect.poll(()=>frame.locator('#plot').evaluate((node:any)=>node._fullData?.[0]?.type)).toBe('scatter3d')
 expect(failures.filter(message=>/unsafe-eval|Content Security Policy|Failed to fetch dynamically imported/.test(message))).toEqual([])
})

test('a figure button can switch to a trace type named by positional restyle arguments',async({page})=>{
 const frame=await enter(page,'browser-plotly-switch')
 await expect(frame.locator('.scatterlayer .point')).toHaveCount(3)
 await frame.getByText('Bar',{exact:true}).click()
 await expect(frame.locator('.barlayer .point')).toHaveCount(3)
})

test('a returning browser does not reuse the formerly cached classic Plotly bundle as a module',async({page})=>{
 // Before migration this unversioned URL was a classic bundle, cached fresh
 // for an hour. New response headers cannot expire a response already cached.
 await page.route(url=>url.pathname==='/plotly/plotly.min.js'&&!url.search,route=>route.fulfill({
  contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*','Cache-Control':'max-age=3600'},
  body:'window.Plotly = { legacy: true };',
 }))
 const frame=await enter(page,'browser-plotly')
 await expect(frame.locator('.scatterlayer .point')).toHaveCount(3)
})
