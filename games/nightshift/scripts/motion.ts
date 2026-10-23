import { browserBudget } from "../../../scripts/browser-budget"
import { mkdir,readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { FirstPerson } from "@arcade/kit/client/first-person"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { Settings } from "../src/settings"

await using budget = browserBudget()
const { chromium } = budget

const out=resolve(process.env.NIGHTSHIFT_MOTION_DIR??"captures/nightshift-motion")
await mkdir(out,{recursive:true})
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname;const f=Bun.file(`${import.meta.dir}/../dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
type App={camera:FirstPerson;renderer:Renderer;settings:Settings;frames:number;time:number;paused:boolean}
const errors:string[]=[]
try {
  const page=await browser.newPage({viewport:{width:960,height:540},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message))
  await page.addInitScript(()=>{
    let callback:FrameRequestCallback|undefined,clock=0
    window.requestAnimationFrame=f=>{callback=f;return 1}
    performance.now=()=>clock
    Object.assign(window,{step:async()=>{clock+=1000/60;const f=callback;callback=undefined;f?.(clock);await Promise.resolve();await (window as unknown as {nightshift:App}).nightshift.renderer.passContext.device.queue.onSubmittedWorkDone()}})
  })
  await page.goto(`${server.url}arcade/nightshift/`)
  await page.waitForFunction(()=>Boolean((window as unknown as {nightshift:App}).nightshift),undefined,{polling:100,timeout:90000})
  await page.addStyleTag({content:"body>div,body>a{display:none!important}"})
  const trace=[]
  // Deterministic strafe/walk at the reported mid-aisle partition. Static lighting
  // separates material shimmer from intended lamp flicker and drifting dust.
  for(let i=-40;i<90;i++) {
    const pose=await page.evaluate(async i=>{
      const w=window as unknown as {nightshift:App;step():Promise<void>},a=w.nightshift
      a.time=0.7;a.settings.flicker=0;a.settings.dust=0
      a.camera.body.x=-0.15+Math.max(0,i)*0.0025;a.camera.body.y=2.25-Math.max(0,i)*0.006
      a.camera.yaw=0.12;a.camera.pitch=-0.12
      await w.step()
      return {frame:i,eye:[...a.camera.eye],viewProj:Array.from(a.camera.viewProj)}
    },i)
    if(i>=0){trace.push(pose);await page.screenshot({path:resolve(out,`${String(i).padStart(3,"0")}.png`)})}
  }
  await Bun.write(resolve(out,"trace.json"),JSON.stringify({errors,width:960,height:540,trace},null,2))
  if(errors.length)throw new Error(errors.join("\n"))
  console.log(`Saved 90 matched-motion frames: ${out}`)
}finally{await browser.close();server.stop(true)}
