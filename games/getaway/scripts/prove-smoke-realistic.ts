/// <reference types="@webgpu/types" />
import { chromium } from "playwright-core"
import { mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EmissionStudy } from "../src/game/emission-study"

const out = join(import.meta.dir, "../../../captures/getaway-smoke-realistic")
mkdirSync(out, { recursive: true })
const video = process.argv.includes("--video"), timing = process.argv.includes("--timing")
const style = Number(process.argv.find(a=>a.startsWith("--style="))?.slice(8) ?? 6)
const cases: { name: EmissionStudy; label: string; frames: number; shots: number[] }[] = [
  { name:"drift", label:"Drift · two rear plumes", frames:285, shots:[32,64,125,245] },
  { name:"burnout", label:"Burnout → launch", frames:315, shots:[12,72,105,275] },
  { name:"nitro", label:"Nitro · grip, no tyre smoke", frames:105, shots:[12,36,64,84] },
  { name:"pops", label:"Shift & lift-off pops", frames:150, shots:[30,65,100,103] },
  { name:"cold", label:"Cold exhaust · condensation", frames:90, shots:[12,32,64,84] },
]
const selected = process.argv.find(a=>a.startsWith("--cases="))?.slice(8).split(",")
const fixture = process.argv.includes("--fixture") ? await (await import("vite")).createServer({ configFile: join(import.meta.dir,"../vite.config.ts"), server: { host:"127.0.0.1", port:0 } }) : null
await fixture?.listen()
const address = fixture?.httpServer?.address()
const host = typeof address === "object" && address ? `http://localhost:${address.port}` : "http://getaway-smoke.localhost:1355"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser = await chromium.launch({executablePath:chrome,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio","--disable-dawn-features=timestamp_quantization"]})
const errors:string[]=[], runs:any[]=[]
const median = (a:number[])=>a.toSorted((a,b)=>a-b)[Math.floor(a.length/2)]!
try {
  const page = await browser.newPage({viewport:video?{width:720,height:1280}:{width:960,height:640},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message))
  page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("404")) errors.push(m.text())})
  await page.goto(`${host}/?solo&peaceful=1&seed=7&bench&nohud&smoke=${style}${timing?"&smoketiming":""}`)
  await page.waitForFunction(()=>(window as any).__getawayBench)
  const adapter=await page.evaluate(async()=>{const b=(window as any).__getawayBench;await b.ready;return b.adapterInfo})
  if(!adapter.architecture.includes("metal")) throw new Error(JSON.stringify(adapter))
  console.log("Adapter",adapter)
  const reset=async(name:EmissionStudy)=>page.evaluate(({name,style})=>{const b=(window as any).__getawayBench;b.emissionStudy(name);b.smoke(style,true);b.distance(name==="cold"?24:38);b.reset(true)},{name,style})
  const step=async(i:number,dt=1/30)=>page.evaluate(async({i,dt})=>(window as any).__getawayBench.step(i,dt,true),{i,dt})
  if(timing) {await reset("drift");for(let i=0;i<150;i++) await step(i)}
  let sequence=0
  for(const study of cases.filter(c=>!selected||selected.includes(c.name))) {
    await reset(study.name)
    const samples:any[]=[], pairs:any[]=[]
    if(video) await page.evaluate(label=>{
      let el=document.getElementById("study-label");if(!el){el=document.createElement("div");el.id="study-label";document.body.append(el)}
      el.textContent=label;el.style.cssText="position:fixed;top:78px;left:24px;color:#fff;background:#10151ee8;padding:14px 20px;border-radius:9px;font:600 26px system-ui;z-index:9999"
    },study.label)
    let lastPops=0
    const lingering = study.name === "drift" || study.name === "burnout"
    for(let i=0;i<(timing?(lingering?170:130):study.frames);i++) {
      const r=await step(i); samples.push({frame:i,pose:r.pose,...r.smoke})
      if(study.name==="nitro"&&r.smoke.connected!==0) throw new Error(`Nitro emitted tyre smoke at ${i}`)
      if(!timing&&study.shots.includes(i)) await page.screenshot({path:join(out,`${video?"portrait":"still"}-${style}-${study.name}-${i}.jpg`),type:"jpeg",quality:94})
      if(!timing&&r.smoke.pops>lastPops) await page.screenshot({path:join(out,`${video?"portrait":"still"}-${style}-${study.name}-pop-${i}.jpg`),type:"jpeg",quality:94})
      lastPops=r.smoke.pops
      if(video&&i%2===0) await page.screenshot({path:join(out,`phone-${String(sequence++).padStart(4,"0")}.jpg`),type:"jpeg",quality:90})
      if(timing&&([48,64,100].includes(i)||lingering&&i===150)) {
        for(let pair=-1;pair<9;pair++) {
          const members:any={}
          for(const visible of pair%2===0?[true,false]:[false,true]) {
            await page.evaluate(({style,visible})=>(window as any).__getawayBench.smoke(style,visible),{style,visible})
            const frames:number[]=[],poses:any[]=[]
            for(let repeat=0;repeat<8;repeat++){const r=await step(i,0);frames.push(r.totalGpuMs);poses.push(r.pose)}
            members[visible?"on":"off"]={frames,poses,median:median(frames)}
          }
          if(JSON.stringify(members.on.poses)!==JSON.stringify(members.off.poses)) throw new Error("Paired pose mismatch")
          if(pair>=0) pairs.push({frame:i,pair,...members,delta:members.on.median-members.off.median})
        }
        await page.evaluate(style=>(window as any).__getawayBench.smoke(style,true),style)
        console.log(study.name,i,"delta",median(pairs.filter(p=>p.frame===i).map(p=>p.delta)))
      }
    }
    runs.push({name:study.name,style,samples,pairs})
    console.log(study.name,"peak",Math.max(...samples.map(s=>s.connected)),"final",samples.at(-1).connected,"pops",lastPops)
  }
  writeFileSync(join(out,timing?`timings-${style}.json`:video?"phone-proof.json":`proof-${style}.json`),JSON.stringify({adapter,errors,style,method:"whole GPU interval: first shadow start through dependent load/store of the same composite target; marker overhead in both members; 9 alternating pairs of 8 frozen frames per pose; no pass sums",runs},null,2))
  if(errors.length) throw new Error(errors.slice(0,6).join("\n"))
} finally {await browser.close();await fixture?.close()}
