import { browserBudget } from "../../../scripts/browser-budget"
import { mkdir, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { FirstPerson } from "@arcade/kit/client/first-person"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { Call } from "../shared/call"
import type { Settings } from "../src/settings"

await using budget = browserBudget()
const { chromium } = budget
declare global { interface Window { nightshift: { camera:FirstPerson;renderer:Renderer;call:Call;settings:Settings;cradle:unknown;frames:number;ready:boolean;paused:boolean;time:number;setCamera(view:"wide"|"phone"):void;action():void } } }
const out=resolve(process.env.NIGHTSHIFT_CAPTURE_DIR??process.env.LEASE_OUT??"captures/nightshift")
await mkdir(out,{recursive:true})
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname;if(p.includes(".."))return new Response(null,{status:400});const f=Bun.file(`${import.meta.dir}/../dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const page=await browser.newPage({viewport:{width:2000,height:1125},deviceScaleFactor:1}),errors:string[]=[],report:Record<string,unknown>={errors}
page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
try {
  await page.goto(`${server.url}arcade/nightshift/`,{waitUntil:"load"})
  await page.waitForFunction(()=>window.nightshift?.frames>40||document.getElementById("hud")?.textContent?.startsWith("Error:"),undefined,{timeout:90000})
  if(errors.length)throw new Error(errors.join("\n"))
  await page.evaluate(()=>window.nightshift.time=0.7)
  report.settings=await page.evaluate(()=>window.nightshift.settings)
  report.cradle=await page.evaluate(()=>window.nightshift.cradle)
  const hide=await page.addStyleTag({content:"#hud,#credits,#title,#prompt,#subtitle,#reticle{display:none!important}"})
  for(const view of ["wide","phone"] as const) {
    const frame=await page.evaluate(view=>{window.nightshift.setCamera(view);return window.nightshift.frames},view)
    await page.waitForFunction(f=>window.nightshift.frames>f+35,frame)
    await page.evaluate(async()=>{window.nightshift.paused=true;await window.nightshift.renderer.passContext.device.queue.onSubmittedWorkDone()})
    await page.screenshot({path:resolve(out,view+".png")})
    report[view]=await page.evaluate(()=>({eye:window.nightshift.camera.eye,yaw:window.nightshift.camera.yaw,pitch:window.nightshift.camera.pitch,fov:window.nightshift.camera.fov}))
    await page.evaluate(()=>window.nightshift.paused=false)
  }
  await hide.evaluate(e=>e.parentNode?.removeChild(e))
  if(process.argv.includes("--input")) {
    await page.locator("#view").click()
    await page.waitForFunction(()=>document.pointerLockElement?.id==="view",undefined,{timeout:5000})
    await page.keyboard.press("e")
    await page.waitForFunction(()=>window.nightshift.call.phase==="call")
    await page.screenshot({path:resolve(out,"pickup.png")})
    await page.keyboard.press("e")
    await page.waitForFunction(()=>window.nightshift.call.phase==="ended")
    await page.screenshot({path:resolve(out,"hangup.png")})
    await page.evaluate(()=>window.nightshift.setCamera("wide"))
    const before=await page.evaluate(()=>({z:window.nightshift.camera.body.y,frames:window.nightshift.frames}))
    // Physical KeyW with a Dvorak logical key must still move forward.
    await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyW",key:",",bubbles:true})))
    await page.waitForFunction(f=>window.nightshift.frames>f+25,before.frames)
    await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keyup",{code:"KeyW",key:",",bubbles:true})))
    const after=await page.evaluate(()=>window.nightshift.camera.body.y)
    if(after>=before.z-0.05)throw new Error("Physical movement failed")
    await page.keyboard.down("w")
    await page.waitForFunction(()=>window.nightshift.camera.body.y < -4.7,undefined,{timeout:15000})
    await page.keyboard.up("w")
    const desk=await page.evaluate(()=>({x:window.nightshift.camera.body.x,z:window.nightshift.camera.body.y}))
    await page.evaluate(()=>{window.nightshift.camera.yaw=0;window.nightshift.camera.pitch=-.15})
    await page.keyboard.down("s")
    await page.waitForFunction(()=>window.nightshift.camera.body.y> -3.65,undefined,{timeout:8000})
    await page.keyboard.up("s")
    await page.keyboard.down("d")
    await page.waitForFunction(()=>window.nightshift.camera.body.x>3.9,undefined,{timeout:8000})
    await page.keyboard.up("d")
    await page.keyboard.down("w")
    await page.waitForFunction(()=>window.nightshift.camera.body.y< -7.1,undefined,{timeout:8000})
    await page.keyboard.up("w")
    if(!await page.locator("#prompt").textContent().then(t=>t?.includes("to be continued")))throw new Error("Office objective did not complete")
    await page.screenshot({path:resolve(out,"office.png")})
    await page.keyboard.press("f")
    if(!await page.evaluate(()=>window.nightshift.camera.flashlight))throw new Error("Flashlight failed")
    await page.keyboard.press("Backquote")
    await page.waitForFunction(()=>document.pointerLockElement===null)
    report.input={call:"answered and hung up",dvorakForwardMetres:before.z-after,walkedFromStartToDesk:desk,office:"walked through ajar door and reached encounter stub",flashlight:true,panelReleasedPointer:true}
  }
  if(errors.length)throw new Error(errors.slice(0,6).join("\n"))
  console.log(JSON.stringify(report))
} catch(error) { console.error(JSON.stringify(report));throw error }
finally {await Bun.write(resolve(out,"capture.json"),JSON.stringify(report,null,2));await browser.close();server.stop(true)}
