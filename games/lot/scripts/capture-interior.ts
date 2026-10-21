import { chromium } from "playwright-core"
import { mkdir, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { VIEWPOINTS } from "../src/interior/viewpoints"

// Matched cameras on both actual renderers. Run through approved HiveMind browser admission.
const out=resolve(process.env.LEASE_OUT ?? process.env.LOT_CAPTURE_DIR ?? "captures/lot/interior")
await mkdir(out,{recursive:true})
console.log("Capture output",out)
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
if(!executablePath)throw Error("Full headless Chromium required")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const report:{views:unknown[];errors:string[]}={views:[],errors:[]}
try {
  for(const view of (process.env.LOT_VIEWS ?? "entrance,lobby,corridor").split(",")) {
    const pose=VIEWPOINTS[view]!
    for(const kind of ["lot","ashwood"]) {
      if(kind==="ashwood" && process.argv.includes("--lot-only"))continue
      const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1})
      const pending=new Set<string>()
      page.on("request",r=>pending.add(r.url()))
      page.on("requestfinished",r=>pending.delete(r.url()))
      page.on("requestfailed",r=>{pending.delete(r.url());console.error("Request failed",r.url(),r.failure())})
      page.on("pageerror",e=>{report.errors.push(`${kind}/${view}: ${e.message}`);console.error(e.message)})
      page.on("console",m=>{if(m.type()==="error"){report.errors.push(`${kind}/${view}: ${m.text()}`);console.error(m.text())}})
      const url=new URL(kind==="lot"?(process.env.LOT_URL??"https://studio.taila8e7c7.ts.net:5255/arcade/lot/"):"https://studio.taila8e7c7.ts.net:5253/")
      url.searchParams.set("view",view);url.searchParams.set("cam",[pose.x,pose.y,pose.z,pose.yaw,pose.pitch,pose.fov].join(","))
      if(kind==="ashwood"){url.searchParams.set("shot","1");url.searchParams.set("follow","1")}
      await page.goto(url.href,{waitUntil:"domcontentloaded",timeout:60_000})
      if(kind==="lot") {
        await page.waitForFunction(()=>{const w=window as any;return w.lot?.ready&&w.lot.frames>60},undefined,{timeout:180_000}).catch(async error=>{
          console.error("Scene state",await page.evaluate(()=>({text:document.body.innerText,lot:(window as any).lot?{ready:(window as any).lot.ready,frames:(window as any).lot.frames}:null})),"Pending",[...pending])
          await page.screenshot({path:resolve(out,"interior-load-failure.png")})
          throw error
        })
        await page.addStyleTag({content:"#hud,#credits,[data-lab-panel]{display:none!important}"})
        await page.evaluate(async()=>{const w=window as any;w.lot.paused=true;await w.lot.renderer.passContext.device.queue.onSubmittedWorkDone();await new Promise<void>(r=>requestAnimationFrame(()=>r()))})
      } else {
        await page.evaluate(pose=>{const w=window as any;w.appliedCount=0;addEventListener("message",e=>{if(e.data?.type==="ashwood-camera-applied"){w.applied=e.data;w.appliedCount++}});postMessage({type:"ashwood-camera",seq:1,pose},location.origin)},pose)
        await page.waitForFunction(()=>{const w=window as any;return w.applied?.ready&&w.appliedCount>60},undefined,{timeout:300_000})
        await page.addStyleTag({content:"body>*:not(canvas){visibility:hidden!important}"})
      }
      await page.screenshot({path:resolve(out,`interior-${view}-${kind}.png`),timeout:60_000})
      report.views.push({view,kind,pose,actual:await page.evaluate(kind=>{const w=window as any;return kind==="lot"?{eye:w.lot.camera.eye,yaw:w.lot.camera.yaw,pitch:w.lot.camera.pitch,fov:w.lot.camera.fov}:w.applied},kind)})
      console.log("Captured",view,kind)
      await page.close()
    }
  }
  if(report.errors.length)throw Error(report.errors.join("\n"))
} finally {
  await Bun.write(resolve(out,"interior-capture.json"),JSON.stringify(report,null,2))
  await browser.close()
}
