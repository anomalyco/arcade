import assert from "node:assert/strict"
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "./browser-budget"
import { serveDist } from "../games/lot/scripts/serve-dist"

await using budget = browserBudget()
const { chromium } = budget
const out=resolve(process.argv[2]??"captures/lot/paired-cost.json")
const servers={before:serveDist(resolve(process.env.LOT_COST_BEFORE??"../lot-walk-before/games/lot/dist")),after:serveDist(resolve("games/lot/dist"))}
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
try{
  const errors:string[]=[],pages={} as Record<keyof typeof servers,Awaited<ReturnType<typeof browser.newPage>>>
  for(const mode of ["before","after"] as const){
    const page=pages[mode]=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1})
    page.on("pageerror",e=>errors.push(`${mode}: ${e.message}`));page.on("console",m=>{if(m.type()==="error")errors.push(`${mode}: ${m.text()}`)})
    await page.goto(`http://127.0.0.1:${servers[mode].port}/arcade/lot/?time=8`)
    await page.waitForFunction(()=>(window as any).lot?.frames>8,undefined,{timeout:600000,polling:100})
    await page.evaluate(()=>{const a=(window as any).lot;a.paused=true;a.camera.body.x=-5;a.camera.body.y=102;a.camera.yaw=-.1;a.camera.pitch=-.02;a.renderer.resetTemporalHistory()})
  }
  const pairs:Record<string,number>[]=[]
  for(let i=0;i<14;i++){
    const row:Record<string,number>={}
    for(const mode of (i%2?["after","before"]:["before","after"]) as (keyof typeof servers)[]){
      row[mode]=await pages[mode].evaluate(async()=>{const a=(window as any).lot;for(let j=0;j<5;j++)a.step(1000/60);await a.renderer.passContext.device.queue.onSubmittedWorkDone();return a.measureFrame()})
    }
    if(i>=2)pairs.push(row)
  }
  assert(errors.length===0,errors.join("\n"))
  const median=(a:number[])=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)]!
  const deltas=pairs.map(p=>p.after!-p.before!),delta=median([...deltas])
  const report={viewport:[1920,1080],method:"Immutable #387 and current branch, same camera; alternating page order, 5 warm frames per sample, 2 warm rounds, 12 paired whole-frame GPU timestamps. Idle presentation; excludes CPU/audio cost.",beforeMs:median(pairs.map(p=>p.before!)),afterMs:median(pairs.map(p=>p.after!)),pairedDeltaMs:delta,deltaMadMs:median(deltas.map(d=>Math.abs(d-delta))),pairs,errors}
  mkdirSync(resolve(out,".."),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}finally{await browser.close();for(const server of Object.values(servers))server.stop()}
