import { chromium } from "playwright-core"
import { mkdir,readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { START } from "../src/world"

// One requested matched-camera evidence set; not an automated appearance test.
const out=resolve(process.env.LOT_CAPTURE_DIR ?? "captures/lot/detail-iteration-5")
await mkdir(out,{recursive:true})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
if(!executablePath) throw new Error("Full Chromium missing")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],report:unknown[]=[]
try {
  const page=await browser.newPage({viewport:{width:3840,height:1128},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message))
  page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
  page.on("response",r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)})
  await page.goto("https://studio.taila8e7c7.ts.net:5254/compare.html",{waitUntil:"domcontentloaded"})
  await page.addStyleTag({content:"body{--frame-width:1920px;--frame-height:1080px}"})
  await page.waitForFunction(()=>{
    const w=window as any,s=w.compareState();return s.ready&&s.ack>20
  },undefined,{timeout:300_000})
  const ours=page.frames().find(f=>f.url().includes(":5251/"))!,theirs=page.frames().find(f=>f.url().includes(":5253/"))!
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
      const l=(window as any).lot,c=l.camera;l.paused=false;c.body.x=s.x;c.body.y=s.z;c.height=s.y;c.yaw=s.yaw;c.pitch=s.pitch
    },shot)
    await page.waitForFunction(s=>{
      const c=(window as any).compareState(),p=c.applied
      return p && (["x","y","z","yaw","pitch"] as const).every(k=>Math.abs(p[k]-s[k])<1e-5)
    },shot,{timeout:20_000})
    const frame=await ours.evaluate(()=>(window as any).lot.frames)
    await ours.waitForFunction(f=>(window as any).lot.frames>f+48,frame,{timeout:60_000})
    await ours.evaluate(async()=>{const l=(window as any).lot;l.paused=true;await l.renderer.passContext.device.queue.onSubmittedWorkDone()})
    report.push({shot,state:await page.evaluate(()=>(window as any).compareState())})
    await ours.locator("#view").screenshot({path:resolve(out,`${shot}-kit.png`),timeout:60_000})
    await theirs.locator("#view").screenshot({path:resolve(out,`${shot}-ashwood.png`),timeout:60_000})
  }
  if(errors.length) throw new Error(errors.join("\n"))
} finally {
  await Bun.write(resolve(out,"capture.json"),JSON.stringify({errors,shots:report},null,2))
  await browser.close()
}
