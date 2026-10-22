/** Headless production-shader compilation, flux stability, still and timestamp proof; run via HiveMind on mini. */
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { existsSync } from "node:fs"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { hostname } from "node:os"

const out=resolve("captures/sky-gpu")
await mkdir(out,{recursive:true})
const server=await createServer({configFile:false,root:process.cwd(),server:{host:"127.0.0.1",port:0},logLevel:"error"})
await server.listen()
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>n.startsWith("chromium_headless_shell-")).sort().reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if(!executablePath) throw new Error("Headless Chromium missing")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio","--enable-features=WebGPUExperimentalFeatures"]})
const errors:string[]=[]
try {
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1})
  page.on("pageerror",error=>errors.push(error.message))
  page.on("console",message=>{if(message.type()==="error")errors.push(message.text())})
  await page.goto(`${server.resolvedUrls!.local[0]}scripts/sky/fixture.html`,{waitUntil:"domcontentloaded"})
  await page.waitForFunction(()=>"skyProof" in window||!!document.body.dataset.error,undefined,{timeout:120000})
  const report=await page.evaluate(async(extra)=>{
    type Proof={adapter:unknown;timestamps:boolean;errors:string[];measure():Promise<unknown>;stability():Promise<unknown>;temporalTranslation():Promise<unknown>;occultation():Promise<unknown>}
    if(document.body.dataset.error)throw new Error(document.body.dataset.error)
    const p=(window as unknown as {skyProof:Proof}).skyProof
    return {adapter:p.adapter,timestamps:p.timestamps,...(extra === "occultation" ? {occultation:await p.occultation()} : extra === "temporal" ? {temporal:await p.temporalTranslation()} : {stability:await p.stability(),timings:await p.measure()}),errors:p.errors}
  },process.argv.includes("--occultation") ? "occultation" : process.argv.includes("--temporal") ? "temporal" : "all")
  await page.screenshot({path:resolve(out,"physical.png")})
  if(process.argv.includes("--temporal")) for(const phase of ["crescent","half","full"]) {
    await page.evaluate(async phase=>{
      const p=(window as unknown as {skyProof:{draw(settings:Record<string,unknown>,view:Record<string,number>):Promise<void>}}).skyProof
      await p.draw({skyMoon:phase},{yaw:-220*Math.PI/180,pitch:0.45})
    },phase)
    await page.screenshot({path:resolve(out,`${phase}.png`)})
  }
  await writeFile(resolve(out,process.argv.includes("--occultation")?"occultation.json":process.argv.includes("--temporal")?"temporal.json":"report.json"),JSON.stringify({...report,host:hostname(),errors:[...errors,...report.errors]},null,2))
  if(errors.length||report.errors.length)throw new Error([...errors,...report.errors].join("\n"))
  console.log(JSON.stringify(report,null,2))
} finally {await browser.close();await server.close()}
