import { browserBudget } from "../../../scripts/browser-budget"
import { mkdir,readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const out=resolve("captures/lot/synced-compare")
await mkdir(out,{recursive:true})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
if(!executablePath)throw new Error("Full Chromium is required for pointer lock")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[], poses:unknown[]=[]
try {
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message))
  await page.goto("https://studio.taila8e7c7.ts.net:5254/compare.html",{waitUntil:"domcontentloaded"})
  await page.waitForFunction(()=>{
    const w=window as unknown as {compareState:()=>{ready:boolean;ack:number}}
    return w.compareState().ready&&w.compareState().ack>10
  },undefined,{timeout:300_000})
  const ours=page.frames().find(f=>f.url().includes(":5251/"))!
  const linked=async(expected?:Record<string,number>)=>{
    const state=await page.waitForFunction(expected=>{
      const s=(window as unknown as {compareState:()=>{latest:{pose:Record<string,number>};applied:Record<string,number>}}).compareState()
      const p=expected??s.latest.pose
      return s.applied&&Object.keys(p).every(k=>Math.abs(p[k]!-s.applied[k]!)<1e-5)&&Object.keys(p).every(k=>Math.abs(p[k]!-s.latest.pose[k]!)<1e-5)?s:false
    },expected,{timeout:15_000})
    poses.push(await state.jsonValue())
  }
  await linked()
  if(!process.argv.includes("--controls-only")) {
  await page.screenshot({path:resolve(out,"title-pair.png"),timeout:60_000})
  await ours.locator("#view").click()
  await ours.waitForFunction(()=>document.pointerLockElement?.id==="view")
  await page.keyboard.down("w")
  await ours.waitForFunction(()=>{
    const c=(window as unknown as {lot:{camera:{body:{y:number}}}}).lot.camera
    return c.body.y<157
  },undefined,{timeout:20_000})
  await page.keyboard.up("w")
  await page.mouse.move(1100,500)
  await page.keyboard.press("Escape")
  // Playwright's synthetic Escape does not trigger Chromium's browser-level pointer-lock escape.
  await ours.evaluate(()=>document.exitPointerLock())
  await ours.waitForFunction(()=>document.pointerLockElement===null)
  await linked()
  // Same ground-level booth view in both engines; assignment uses the shipped camera hook, no shader replacement.
  await ours.evaluate(()=>{
    const c=(window as unknown as {lot:{camera:{body:{x:number;y:number};height:number;yaw:number;pitch:number}}}).lot.camera
    c.body.x=-1.5;c.body.y=141;c.height=1.7;c.yaw=-0.4;c.pitch=-0.18
  })
  await linked({x:-1.5,y:1.7,z:141,yaw:-0.4,pitch:-0.18,fov:68})
  await page.screenshot({path:resolve(out,"booth-ground-pair.png"),timeout:60_000})
  }
  const beforeSize=await ours.evaluate(()=>[innerWidth,innerHeight])
  await page.locator("#flip").click()
  await page.waitForFunction(()=>document.body.dataset.mode==="flip")
  await page.locator("#switch").click()
  if(await page.locator("body").getAttribute("data-side")!=="theirs")throw new Error("Flip did not show Ashwood")
  const afterSize=await ours.evaluate(()=>[innerWidth,innerHeight])
  if(JSON.stringify(beforeSize)!==JSON.stringify(afterSize))throw new Error("Flip resized the renderer")
  if(errors.length)throw new Error(errors.join("\n"))
  console.log(`Verified ${poses.length} matched camera poses and flip without renderer resize`,out)
} finally {
  await Bun.write(resolve(out,process.argv.includes("--controls-only")?"controls-proof.json":"proof.json"),JSON.stringify({errors,poses},null,2))
  await browser.close()
}
