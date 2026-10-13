import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { cpus } from "node:os"
import { chromium } from "playwright-core"

const root=resolve(import.meta.dir,"../../.."), out=resolve(root,process.env.COST_PATH??"captures/outbreak-look/cost")
const baselineRef=process.env.BASELINE_REF??"cd77303", scene=process.env.COST_SCENE??"street"
const baseline=resolve(out,"baseline")
mkdirSync(baseline,{recursive:true})
const run=(args:string[],cwd:string) => assert.equal(Bun.spawnSync(args,{cwd,stdout:"inherit",stderr:"inherit"}).exitCode,0,args.join(" "))
run(["tar","-xf",resolve(root,process.env.BASELINE_ARCHIVE??"games/outbreak/scripts/.baseline.tar"),"-C",baseline],root)
run(["bun","install","--frozen-lockfile"],baseline)
const sources={before:baseline,after:root}
const fixtures:ReturnType<typeof Bun.serve>[]=[]
const urls:Record<string,string>={}, vertices:Record<string,number>={}
for(const [name,src] of Object.entries(sources)) {
  const game=resolve(src,"games/outbreak")
  run(["bun","run","build"],game)
  const count=Bun.spawnSync(["bun","-e",`import {makeTown} from './shared/map';import {buildLevel} from './src/level'; const l=buildLevel(makeTown(7)); console.log([...l.chunks,...l.glass].reduce((n,c)=>n+c.data.byteLength/24,0))`],{cwd:game})
  assert.equal(count.exitCode,0);vertices[name]=Number(count.stdout.toString().trim())
  const folder=resolve(game,"dist/arcade/outbreak")
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const path=new URL(req.url).pathname;const f=Bun.file(resolve(folder,`.${path==="/"?"/index.html":path}`));return await f.exists()?new Response(f):new Response("Not found",{status:404})}})
  fixtures.push(server);urls[name]=`http://127.0.0.1:${server.port}/?solo&seed=7&bench`
}
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const chrome=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(chrome)
const browser=await chromium.launch({executablePath:chrome,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const runs:any[]=[]
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]!
try {
  for(let pair=-1;pair<7;pair++) for(const name of pair%2===0?["before","after"]:["after","before"]) {
    const page=await browser.newPage({viewport:{width:1000,height:680},deviceScaleFactor:1})
    const errors:string[]=[]
    page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
    await page.goto(urls[name]!)
    await page.waitForFunction(()=>(window as any).__arcadeHarness?.ready)
    const adapter=await page.evaluate(()=>(window as any).__arcadeHarness.adapterInfo)
    assert.match(adapter.architecture,/metal/)
    await page.evaluate(async scene=>{const h=(window as any).__arcadeHarness;h.setLab("timeScale",0);h.setLab("hour",scene==="street"?18:19);h.setLab("zoom",scene==="street"?42:34);h.pose(scene==="street"?30:27.7,scene==="street"?41:31,-Math.PI/2);if(scene!=="street")await h.step(1/60,{interact:true});for(let i=0;i<30;i++)await h.step()},scene)
    const cdp=await page.context().newCDPSession(page)
    await cdp.send("HeapProfiler.startSampling",{samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true})
    const measurement=await page.evaluate(async()=>{
      const h=(window as any).__arcadeHarness, spans:number[]=[]
      for(let i=0;i<120;i++) {
        const start=performance.now()
        await h.step(1/60,{mx:Math.sin(i*.05)*.2,my:0,aim:-Math.PI/2+Math.sin(i*.025)*.3})
        spans.push(performance.now()-start)
      }
      return {spans,player:h.state().player}
    })
    const {profile}=await cdp.send("HeapProfiler.stopSampling")
    assert.deepEqual(errors,[])
    runs.push({pair,name,adapter,vertices:vertices[name],sampledBytesPerStep:profile.samples.reduce((n,s)=>n+s.size,0)/120,medianMs:median(measurement.spans),...measurement})
    await cdp.detach();await page.close()
  }
  const measured=runs.filter(r=>r.pair>=0)
  const summary=Object.fromEntries(["before","after"].map(name=>{const r=measured.filter(r=>r.name===name),ms=r.map(r=>r.medianMs);return [name,{medianMs:median(ms),minMs:Math.min(...ms),maxMs:Math.max(...ms),sampledBytesPerStep:median(r.map(r=>r.sampledBytesPerStep)),vertices:vertices[name]}]}))
  for(let pair=0;pair<7;pair++) assert.deepEqual(measured.find(r=>r.pair===pair&&r.name==="before").player,measured.find(r=>r.pair===pair&&r.name==="after").player)
  const deltas=Array.from({length:7},(_,pair)=>measured.find(r=>r.pair===pair&&r.name==="after").medianMs-measured.find(r=>r.pair===pair&&r.name==="before").medianMs)
  await Bun.write(resolve(out,"paired.json"),JSON.stringify({baseline:baselineRef,scene,hardware:cpus()[0]?.model,viewport:[1000,680],frames:120,warmupPairs:1,measuredPairs:7,description:"Awaited production harness steps (CPU + GPU queue completion, not pure GPU time). CDP 4KiB sampled allocations include collected objects and harness state snapshots; not an exact allocation count.",summary,pairedDeltaMs:{median:median(deltas),min:Math.min(...deltas),max:Math.max(...deltas)},runs},null,2))
  console.log(JSON.stringify(summary,null,2))
} finally {await browser.close();for(const fixture of fixtures)fixture.stop(true)}
