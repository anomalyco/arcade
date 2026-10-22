/**
 * Boot-screen proof: one still mid-load and a short muted clip from a cold load through Begin into the opening.
 *
 *   hivemind run --kind browser --browser-approval "…" -- bun games/nightshift/scripts/boot-proof.ts [--mbps 24] [--fail]
 *
 * Builds and serves dist/ with the network throttled so the stages are visible. `--fail` returns 404 for one prop and
 * checks the in-world DISK ERROR and retry instead. Writes captures/nightshift-boot/.
 */
import { chromium } from "playwright-core"
import { existsSync } from "node:fs"
import { mkdir, readdir, rename } from "node:fs/promises"
import { resolve } from "node:path"

const arg=(name:string)=>{const i=process.argv.indexOf(`--${name}`);return i<0?undefined:process.argv[i+1]}
const mbps=Number(arg("mbps")??24),fail=process.argv.includes("--fail"),root=resolve(import.meta.dir,".."),out=resolve(root,"captures/nightshift-boot")
await mkdir(out,{recursive:true})
const build=Bun.spawn(["bunx","vite","build"],{cwd:root,stdout:"ignore",stderr:"inherit"});if(await build.exited!==0)throw Error("Build failed")
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  const p=new URL(req.url).pathname
  if(fail&&p.endsWith("/rolodex.glb"))return new Response(null,{status:404})
  const f=Bun.file(`${root}/dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})
}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=existsSync(cache)?(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync):undefined
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[]
try{
  const context=await browser.newContext({viewport:{width:1280,height:720},recordVideo:fail?undefined:{dir:out,size:{width:1280,height:720}}})
  const page=await context.newPage()
  page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
  const cdp=await context.newCDPSession(page)
  await cdp.send("Network.enable");await cdp.send("Network.emulateNetworkConditions",{offline:false,latency:30,downloadThroughput:mbps*125000,uploadThroughput:mbps*125000})
  const t0=Date.now()
  await page.goto(`http://127.0.0.1:${server.port}/arcade/nightshift/`,{waitUntil:"commit"})
  if(fail){
    await page.waitForSelector("#arcade-boot[data-failed]",{timeout:120_000})
    await page.screenshot({path:`${out}/boot-fail.png`})
    const text=await page.locator("#arcade-boot").textContent()
    if(!/DISK ERROR READING ROLODEX\.GLB/.test(text??""))throw Error(`Unexpected failure text: ${text}`)
    await page.locator("#arcade-boot button").click()
    await page.waitForEvent("load")
    console.log(`fail: DISK ERROR shown and retry reloads (${text?.replace(/\s+/g," ").slice(-140)})`)
  }else{
    // A still once a few file lines are running.
    await page.waitForFunction(()=>document.querySelectorAll("[data-boot-stage]").length>=8,undefined,{timeout:120_000,polling:50})
    await page.screenshot({path:`${out}/boot-loading.png`})
    const loading=Date.now()-t0
    // A click during the load must not take the pointer or start the opening.
    await page.mouse.click(640,360)
    await page.waitForTimeout(200)
    if(await page.evaluate(()=>!!document.pointerLockElement||!!(window as unknown as {nightshift?:{opening:{started:boolean}}}).nightshift?.opening.started))throw Error("A click during loading started the game")
    await page.waitForSelector("#arcade-boot[data-ready]",{timeout:120_000})
    const ready=Date.now()-t0
    await page.waitForFunction(()=>/Begin/.test(document.querySelector("[data-boot-tail]")?.textContent??""),undefined,{timeout:10_000})
    await page.screenshot({path:`${out}/boot-ready.png`})
    await page.waitForTimeout(1200)
    await page.mouse.click(640,360)
    await page.waitForSelector("#arcade-boot",{state:"detached",timeout:5_000})
    await page.waitForTimeout(4500)
    await page.screenshot({path:`${out}/opening.png`})
    const log=await page.evaluate(()=>(window as unknown as {nightshift:{opening:{started:boolean;time:number}}}).nightshift.opening)
    console.log(`still at ${loading} ms, ready at ${ready} ms (${mbps} Mbps); opening started ${log.started}, t=${log.time.toFixed(2)} s`)
    const video=page.video()
    await context.close()
    if(video){await rename(await video.path(),`${out}/boot-handoff.webm`);console.log(`video ${out}/boot-handoff.webm`)}
  }
  if(errors.filter(e=>!(fail&&/404|rolodex|DISK ERROR/i.test(e))).length)throw Error(`browser errors: ${errors.join("\n")}`)
}finally{await browser.close();server.stop(true)}
