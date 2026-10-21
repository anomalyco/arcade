import { chromium } from "playwright-core"
import { mkdir, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { serveDist } from "./serve-dist"

// Kit-approved headless, muted fidelity iterations against the saved Ashwood title frame.
// Run via HiveMind browser admission. No reference-game server is needed.
const out = resolve(process.env.LOT_CAPTURE_DIR ?? "captures/lot/current")
await mkdir(out, { recursive: true })
const local = process.argv.includes("--local") ? serveDist(resolve(import.meta.dir, "../dist")) : null
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const input = process.argv.includes("--input")
// The shell build rejected Pointer Lock with WrongDocumentError on Mini. Try full
// Chromium in headless mode for the real input check, still without a visible window.
const executablePath = (await readdir(cache)).filter(n=>input ? /^chromium-\d+$/.test(n) : /^chromium_headless_shell-/.test(n)).sort().reverse()
  .map(n=>input ? `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` : `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if(!executablePath) throw new Error("Required headless Chromium executable is missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const errors: string[] = []
const report: Record<string, unknown> = { viewport: [1920, 1080], captured: new Date().toISOString(), errors }
try {
  const page = await context.newPage()
  page.on("pageerror", e=>errors.push(e.stack ?? e.message))
  page.on("console", m=>{ if(m.type()==="error") errors.push(`${m.text()} (${m.location().url})`) })
  page.on("response", r=>{ if(r.status()>=400) errors.push(`HTTP ${r.status()}: ${r.url()}`) })
  const url = local ? new URL("/arcade/lot/",local.url).href : process.env.LOT_URL ?? "https://studio.taila8e7c7.ts.net:5251/arcade/lot/"
  report.url=url
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.waitForFunction(()=>{
    const w=window as unknown as {lot?: {ready:boolean;frames:number}}
    return w.lot?.ready && w.lot.frames>48
  },undefined,{timeout:150_000})
  const hidden=await page.addStyleTag({content:"#hud,#credits,[data-lab-panel]{display:none!important}"})
  report.camera=await page.evaluate(()=>{
    const w=window as unknown as {lot:{camera:{eye:number[];yaw:number;pitch:number;fov:number;near:number};settings:unknown}}
    const c=w.lot.camera
    return {eye:c.eye,yaw:c.yaw,pitch:c.pitch,fov:c.fov,near:c.near,settings:w.lot.settings}
  })
  await page.evaluate(async()=>{
    const w=window as unknown as {lot:{paused:boolean;renderer:{passContext:{device:GPUDevice}}}}
    w.lot.paused=true
    await w.lot.renderer.passContext.device.queue.onSubmittedWorkDone()
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
  })
  if(!process.argv.includes("--input-only")) await page.screenshot({path:resolve(out,"kit.png"),timeout:60_000})
  // Restore the real UI before exercising input: hidden controls cannot take focus.
  await hidden.evaluate(element=>element.parentNode?.removeChild(element))
  await page.evaluate(()=>{ (window as unknown as {lot:{paused:boolean}}).lot.paused=false })
  if(errors.length) throw new Error(errors.join("\n"))
  if(process.argv.includes("--input")) {
    report.inputStage="pointer-lock"
    report.focus=await page.evaluate(()=>document.hasFocus())
    await page.evaluate(()=>{
      const canvas=document.querySelector<HTMLCanvasElement>("#view")!
      const request=canvas.requestPointerLock.bind(canvas)
      const errors:string[]=[]
      Object.assign(window,{pointerLockErrors:errors})
      canvas.requestPointerLock=async options=>{try {await request(options)} catch(error) {errors.push(String(error));throw error}}
    })
    const state=()=>page.evaluate(()=>{
      const w=window as unknown as {lot:{camera:{body:{x:number;y:number};yaw:number;flashlight:boolean};frames:number}}
      const c=w.lot.camera
      return {x:c.body.x,z:c.body.y,yaw:c.yaw,flashlight:c.flashlight,locked:document.pointerLockElement?.id,frames:w.lot.frames}
    })
    const start=await state()
    await page.locator("#view").click()
    await page.waitForFunction(()=>document.pointerLockElement?.id==="view",undefined,{timeout:5000})
    report.inputStage="move-look-flashlight"
    const locked=await state()
    await page.keyboard.down("w")
    await page.waitForFunction(frame=>(window as unknown as {lot:{frames:number}}).lot.frames>frame+30,locked.frames)
    await page.keyboard.up("w")
    await page.mouse.move(1100,600)
    await page.keyboard.press("f")
    const moved=await state()
    if(Math.hypot(moved.x-start.x,moved.z-start.z)<0.05 || moved.yaw===start.yaw || moved.flashlight===start.flashlight) throw new Error("First-person browser input did not update camera/flashlight")
    await page.keyboard.press("Backquote")
    report.inputStage="panel-release"
    await page.waitForFunction(()=>document.pointerLockElement===null,undefined,{timeout:5000})
    const panel=await state()
    await page.keyboard.down("w")
    await page.waitForFunction(frame=>(window as unknown as {lot:{frames:number}}).lot.frames>frame+15,panel.frames)
    await page.keyboard.up("w")
    const blocked=await state()
    if(Math.hypot(blocked.x-panel.x,blocked.z-panel.z)>0.001) throw new Error("Night panel did not own movement input")
    report.input={start,moved,panel,blocked}
    report.inputStage="passed"
  }
  if(errors.length) throw new Error(errors.join("\n"))
  console.log("Verified",out)
} catch(error) {
  report.failure=String(error)
  const page=context.pages()[0]
  if(page) report.pointerLockErrors=await page.evaluate(()=>(window as unknown as {pointerLockErrors?:string[]}).pointerLockErrors).catch(()=>undefined)
  throw error
}
finally {
  await Bun.write(resolve(out,"capture.json"),JSON.stringify(report,null,2))
  await context.close(); await browser.close()
  local?.stop(true)
}
