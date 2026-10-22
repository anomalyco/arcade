import { chromium } from "playwright-core"
import { mkdir,readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { START } from "../src/world"

// One requested matched-camera evidence set; not an automated appearance test.
const out=resolve(process.env.LOT_CAPTURE_DIR ?? "captures/lot/detail-iteration-5")
// A loopback SSH tunnel lets workers outside the tailnet use the exact same preview servers.
const host=process.env.LOT_CAPTURE_HOST ?? "https://studio.taila8e7c7.ts.net"
await mkdir(out,{recursive:true})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if(!executablePath) throw new Error("Headless Chromium missing")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio",`--isolate-origins=${host}:5251,${host}:5253`]})
const errors:string[]=[],report:unknown[]=[]
const boot:string[]=[]
let fail!:(error:Error)=>void
const failed=new Promise<never>((_,reject)=>{fail=reject})
void failed.catch(()=>{})
const guard=<T>(work:Promise<T>)=>Promise.race([work,failed])
const recordError=(message:string)=>{errors.push(message);fail(new Error(message))}
let bundle:string|null=null
let releaseReference!:()=>void
const referenceGate=new Promise<void>(resolve=>{releaseReference=resolve})
let diagnostics:unknown=null
const page=await browser.newPage({viewport:{width:3840,height:1128},deviceScaleFactor:1})
try {
  page.on("pageerror",e=>recordError(e.message))
  page.on("console",m=>{if(m.type()==="error")recordError(m.text());else if(/^(REFERENCE|ADAPTER)/.test(m.text())){boot.push(m.text());console.log(m.text())}})
  await page.addInitScript(()=>{
    const request=GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice=function(descriptor) {
      const {vendor,architecture,device,description}=this.info
      const info={vendor,architecture,device,description}
      console.log("ADAPTER",location.origin,JSON.stringify(info))
      if(/swiftshader/i.test(JSON.stringify(info)))throw new Error("Matched capture requires hardware WebGPU")
      return request.call(this,descriptor)
    }
    if(location.port!=="5253")return
    new PerformanceObserver(list=>{
      for(const entry of list.getEntries())if(/^(boot:|mod:.*:(shown|compile:end)|body:)/.test(entry.name))console.log("REFERENCE",Math.round(entry.startTime),entry.name)
    }).observe({type:"mark",buffered:true})
  })
  page.on("requestfailed",r=>recordError(`${r.url()}: ${r.failure()?.errorText}`))
  page.on("response",r=>{if(r.status()>=400)recordError(`${r.status()} ${r.url()}`)})
  for(const url of [`${host}:5251/arcade/lot/`,`${host}:5253/?view=gate&follow=1&shot=1`]) {
    const response=await page.request.get(url)
    if(!response.ok()) throw new Error(`Preview unavailable: ${response.status()} ${url}`)
    if(url.includes(":5251/"))bundle=await response.text()
  }
  // Both heavy engines otherwise decode textures and compile their first frame concurrently in one renderer.
  await page.route(`${host}:5253/**`,async route=>{
    if(route.request().isNavigationRequest())await referenceGate
    await route.continue()
  })
  await guard(page.goto(`${host}:5254/compare.html`,{waitUntil:"domcontentloaded"}))
  await page.addStyleTag({content:"body{--frame-width:1920px;--frame-height:1080px}section>label{display:none}"})
  const ours=page.frames().find(f=>f.url().includes(":5251/")) ?? await guard(page.waitForEvent("framenavigated",{predicate:f=>f.url().includes(":5251/"),timeout:30_000}))
  await guard(ours.waitForFunction(()=>(window as any).lot?.ready && (window as any).lot.frames>2,undefined,{timeout:300_000,polling:100}))
  await guard(ours.evaluate(async()=>{const l=(window as any).lot;l.paused=true;await l.renderer.passContext.device.queue.onSubmittedWorkDone()}))
  await page.evaluate(()=>setInterval(()=>{
    const latest=(window as any).compareState().latest
    if(latest){const ref=document.querySelector<HTMLIFrameElement>("#theirs iframe")!;ref.contentWindow!.postMessage({...latest,type:"ashwood-camera"},new URL(ref.src).origin)}
  },1000))
  console.log("Lot initialized; starting Ashwood")
  releaseReference()
  await guard(page.waitForFunction(()=>{
    const w=window as any,s=w.compareState();return s.ready&&s.ack>0
  },undefined,{timeout:300_000,polling:100}))
  const theirs=page.frames().find(f=>f.url().includes(":5253/"))!
  await ours.addStyleTag({content:"#hud,#credits,[data-lab-panel]{display:none!important}"})
  await theirs.addStyleTag({content:"#hud,[data-lab-panel]{display:none!important}"})
  const shots=[
    {name:"title",x:START.x,y:START.height,z:START.z,yaw:START.yaw,pitch:START.pitch},
    {name:"gate",x:-1.5,y:1.7,z:141,yaw:-0.25,pitch:0.02},
    {name:"booth",x:3,y:1.7,z:135,yaw:-0.6,pitch:-0.22},
    {name:"lot",x:-5,y:1.7,z:102,yaw:-0.1,pitch:-0.12},
    {name:"road",x:-1.5,y:1.7,z:145,yaw:Math.PI+0.03,pitch:0.04},
  ]
  for(const shot of shots) {
    await ours.evaluate(s=>{
      const l=(window as any).lot,c=l.camera;l.paused=false;c.body.x=s.x;c.body.y=s.z;c.height=s.y;c.yaw=s.yaw;c.pitch=s.pitch;c.fov=68
    },shot)
    await guard(page.waitForFunction(s=>{
      const c=(window as any).compareState(),p=c.applied
      return c.ready && p && Math.abs(p.fov-68)<1e-5 && (["x","y","z","yaw","pitch"] as const).every(k=>Math.abs(p[k]-s[k])<1e-5)
    },shot,{timeout:20_000,polling:100}))
    const frame=await ours.evaluate(()=>(window as any).lot.frames)
    await guard(ours.waitForFunction(f=>(window as any).lot.frames>f+48,frame,{timeout:60_000,polling:100}))
    await guard(ours.evaluate(async()=>{const l=(window as any).lot;l.paused=true;await l.renderer.passContext.device.queue.onSubmittedWorkDone()}))
    for(const frame of [ours,theirs]) {
      const size=await frame.locator("#view").evaluate((canvas:HTMLCanvasElement)=>({width:canvas.width,height:canvas.height,cssWidth:canvas.clientWidth,cssHeight:canvas.clientHeight}))
      if(Object.values(size).some((value,i)=>value!==(i%2?1080:1920)))throw new Error(`Unexpected capture size ${frame.url()}: ${JSON.stringify(size)}`)
    }
    const state=await page.evaluate(()=>(window as any).compareState())
    // Element screenshots wait for two stable animation frames, which can stall after the WebGPU canvas pauses.
    // Capture the fixed page rectangle once, so both crops also share the same compositor presentation.
    const pair=resolve(out,`${shot.name}-pair.png`)
    const png=await guard(page.screenshot({path:pair,clip:{x:0,y:48,width:3840,height:1080},timeout:60_000}))
    if(png.readUInt32BE(16)!==3840 || png.readUInt32BE(20)!==1080)throw new Error(`Unexpected pair image size: ${shot.name}`)
    report.push({shot,state})
    console.log(`Captured ${shot.name}`)
  }
  const current=await page.request.get(`${host}:5251/arcade/lot/`)
  if(!current.ok() || await current.text()!==bundle)throw new Error("Lot preview changed during capture")
  for(const shot of shots) {
    if(!existsSync(resolve(out,`${shot.name}-pair.png`))) throw new Error(`Missing ${shot.name} capture`)
  }
  if(errors.length) throw new Error(errors.join("\n"))
} catch(error) {
  errors.push(String(error))
  const states=page.frames().map(f=>({url:f.url(),state:"unresponsive" as unknown}))
  diagnostics=states
  await Promise.race([
    Promise.all(page.frames().map(async (f,i)=>{states[i]!.state=await f.evaluate(()=>{
      const w=window as any
      return {comparison:w.compareState?.(),lot:w.lot?{ready:w.lot.ready,frames:w.lot.frames}:null,reference:w.__afterhours,hud:document.querySelector("#hud")?.textContent}
    }).catch(e=>String(e))})),
    new Promise(resolve=>setTimeout(resolve,5000)),
  ])
  throw error
} finally {
  releaseReference()
  await Bun.write(resolve(out,"capture.json"),JSON.stringify({errors,shots:report,diagnostics,bundle,boot},null,2))
  await browser.close()
}
