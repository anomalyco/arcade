/** One matched turning tape, with source ablations to isolate Scrawl's vertical bands. */
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdir,readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { FirstPerson } from "@arcade/kit/client/first-person"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { Settings } from "../src/settings"

await using budget = browserBudget()
const { chromium } = budget

const out=resolve(process.env.NIGHTSHIFT_TURN_DIR??"captures/nightshift-turn")
const stableHash=`fn officeHash(p: vec3f) -> f32 { var v=vec3u(vec3i(floor(p))); v=((v>>vec3u(8u))^v.yzx)*1103515245u; v=((v>>vec3u(8u))^v.yzx)*1103515245u; return f32(v.x^v.y^v.z)/4294967295.0; }`
const oldHash="fn officeHash(p: vec3f) -> f32 { return fract(sin(dot(p,vec3f(127.1,311.7,74.7)))*43758.5453); }"
const only=process.argv.find(a=>a.startsWith("--only="))?.slice(7)
const variants=only?[only]:process.argv.includes("--final")?["final"]:["today","no-detail","no-shadows","stable-hash"]
if(!existsSync(resolve(import.meta.dir,"../dist/arcade/nightshift/index.html"))){
  const build=Bun.spawn(["bun","run","build"],{cwd:resolve(import.meta.dir,".."),stdout:"inherit",stderr:"inherit"})
  if(await build.exited!==0)throw Error("Fixture build failed")
}
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname;const f=Bun.file(`${import.meta.dir}/../dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
type App={camera:FirstPerson;renderer:Renderer;settings:Settings;time:number}
try {
  for(const variant of variants){
    const folder=resolve(out,variant);await mkdir(folder,{recursive:true})
    const errors:string[]=[],page=await browser.newPage({viewport:{width:960,height:540},deviceScaleFactor:1})
    page.on("pageerror",e=>{errors.push(e.message);console.error(e.message)})
    page.on("console",m=>{if(m.type()==="error"){errors.push(m.text());console.error(m.text())}})
    page.on("requestfailed",r=>console.error(`Request failed: ${r.url()} ${r.failure()?.errorText}`))
    await page.route("**/assets/*.js",async route=>{
      const response=await route.fetch();let body=await response.text()
      if(variant==="stable-hash") {if(!body.includes(oldHash))throw new Error("Baseline hash not found");body=body.replaceAll(oldHash,stableHash)}
      if(variant==="no-detail") body=body.replaceAll("return fract(sin(dot(p,vec3f(127.1,311.7,74.7)))*43758.5453);","return 0.5;").replaceAll("let weave=sin(uv.x*3400.0)*sin(uv.y*2100.0);","let weave=0.0;")
      if(variant==="no-shadows") body=body.replaceAll("att *= spotShadowVis(i, world, n);","att *= 1.0;").replaceAll("att*=blindCookie(world,L.pos.xyz);","att*=1.0;")
      if(variant==="no-contact"){
        const from="let vis = 1.0 - clamp(lost, 0.0, 1.0) * k.z * fade;"
        if(!body.includes(from))throw Error("Contact ablation did not match")
        body=body.replaceAll(from,"let vis = 1.0;")
      }
      await route.fulfill({response,body})
    })
    await page.addInitScript(()=>{
      let callback:FrameRequestCallback|undefined,clock=0
      window.requestAnimationFrame=f=>{callback=f;return 1};performance.now=()=>clock
      Object.assign(window,{step:async()=>{clock+=1000/60;const f=callback;callback=undefined;f?.(clock);await Promise.resolve();await (window as unknown as {nightshift:App}).nightshift.renderer.passContext.device.queue.onSubmittedWorkDone()}})
    })
    await page.goto(`${server.url}arcade/nightshift/`)
    try{await page.waitForFunction(()=>Boolean((window as unknown as {nightshift:App}).nightshift),undefined,{polling:100,timeout:90000})}
    catch(error){
      const hud=await page.locator("#hud").textContent()
      await Bun.write(resolve(folder,"boot-error.json"),JSON.stringify({errors,hud,error:String(error)},null,2))
      throw Error(`Nightshift boot: ${errors.join("\n") || hud || String(error)}`)
    }
    await page.addStyleTag({content:"body>div,body>a{display:none!important}"})
    const trace=[]
    for(let i=-30;i<48;i++){
      const pose=await page.evaluate(async i=>{
        const w=window as unknown as {nightshift:App;step():Promise<void>},a=w.nightshift
        a.time=.7;a.settings.flicker=0;a.settings.dust=0
        Object.assign(a.settings,{cameraMotion:0,reduceMotion:true})
        a.camera.body.x=-.15;a.camera.body.y=2.25;a.camera.yaw=.12+Math.max(0,i)*.004;a.camera.pitch=-.12
        await w.step();return {frame:i,eye:[...a.camera.eye],viewProj:Array.from(a.camera.viewProj)}
      },i)
      if(errors.length)throw Error(errors[0])
      if(i>=0){trace.push(pose);await page.screenshot({path:resolve(folder,`${String(i).padStart(3,"0")}.png`)})}
    }
    await Bun.write(resolve(folder,"trace.json"),JSON.stringify({variant,errors,width:960,height:540,trace},null,2))
    await page.close();if(errors.length)throw new Error(errors.join("\n"));console.log(`Captured ${variant}`)
  }
} finally {await browser.close();server.stop(true)}
