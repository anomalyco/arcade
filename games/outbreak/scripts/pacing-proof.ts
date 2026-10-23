import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, ".."), out = resolve(process.env.PERF_OUT ?? "captures/outbreak-pacing")
mkdirSync(out, { recursive: true })
let variant = "before"
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, plugins: [{
  name: "pacing-proof", enforce: "pre", transform(code, id) {
    if (variant === "before" && id === resolve(root,"src/level.ts")) return code.replace("chunks([...meshes,...props],true)","chunks([...meshes,...props],false)")
    if (variant === "before" && id === resolve(root,"src/shaders.ts")) return code.replace('solidCutaway: "",','')
    if (id !== resolve(root,"src/main.ts")) return
    return code.replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, lab, session: () => session })")
      .replace("function tick(now: number) {", "function tick(now: number) { const stats=(window as any).__pacing; if(stats?.active)stats.callbacks.push({wall:performance.now(),raf:now,hidden:document.hidden,frozen});")
  },
}] })
await server.listen()
const port = (server.httpServer!.address() as {port:number}).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"] })
const reports:any[]=[]
try {
  for(let pair=0;pair<8;pair++)for(const name of pair%2?["after","before"]:["before","after"]){
    variant=name;server.moduleGraph.invalidateAll()
    const page=await browser.newPage({viewport:{width:1728,height:947},deviceScaleFactor:2})
    const errors:string[]=[]
    page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
    await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
    await page.waitForFunction(()=>(window as any).__arcadeHarness?.ready)
    const adapter=await page.evaluate(()=>(window as any).__arcadeHarness.adapterInfo)
    assert.match(adapter.architecture,/metal/)
    for(const scene of [{name:"street",x:30,y:41,zoom:46,hour:18},{name:"interior",x:27.7,y:31,zoom:34,hour:19}]){
      await page.evaluate(async scene=>{
        const w=window as any,h=w.__arcadeHarness
        h.freeze();h.reset(7);h.setLab("timeScale",0);h.setLab("zoom",scene.zoom);h.setLab("hour",scene.hour);h.pose(scene.x,scene.y,-Math.PI/2)
        await h.step(0)
        const s=h.session(),r=h.renderer
        const stats:any=w.__pacing={active:false,callbacks:[],ticks:[],draws:[],inputs:[],end:0,header:""}
        const update=s.update.bind(s),draw=r.draw.bind(r)
        s.update=(dt:number,c:any,...args:any[])=>{const start=performance.now();update(dt,c,...args);if(stats.active)stats.ticks.push({wall:start,dt,mx:c.mx,my:c.my,time:s.view.time,x:s.view.player.x,y:s.view.player.y})}
        r.draw=(f:any)=>{const entry={submit:performance.now(),time:f.frame[19],x:f.frame[24],y:f.frame[25],complete:0};draw(f);if(stats.active){stats.draws.push(entry);void r.device.queue.onSubmittedWorkDone().then(()=>{entry.complete=performance.now()})}}
        window.addEventListener("keydown",e=>{if(e.code==="ArrowRight"&&stats.active)stats.inputs.push({kind:"down",wall:performance.now(),x:s.view.player.x,y:s.view.player.y,time:s.view.time})},true)
        window.addEventListener("keyup",e=>{if(e.code==="ArrowRight"&&stats.active)stats.inputs.push({kind:"up",wall:performance.now(),x:s.view.player.x,y:s.view.player.y,time:s.view.time})},true)
        h.freeze(false);await new Promise(resolve=>setTimeout(resolve,500));h.freeze();await r.device.queue.onSubmittedWorkDone()
      },scene)
      await page.locator("#game").click()
      await page.evaluate(()=>{const w=window as any;w.__pacing.active=true;w.__arcadeHarness.freeze(false)})
      await page.keyboard.down("ArrowRight")
      // This is the measured held-input interval, not a readiness/CI sleep-poll.
      await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,2000)))
      await page.keyboard.up("ArrowRight")
      const result=await page.evaluate(async()=>{
        const w=window as any,h=w.__arcadeHarness,s=w.__pacing
        s.end=performance.now();s.header=h.lab.header.textContent;s.active=false;h.freeze();await h.renderer.device.queue.onSubmittedWorkDone()
        return {...s,adapter:h.adapterInfo,viewport:[innerWidth,innerHeight,devicePixelRatio],canvas:[document.querySelector<HTMLCanvasElement>("canvas")!.width,document.querySelector<HTMLCanvasElement>("canvas")!.height],hidden:document.hidden}
      })
      reports.push({pair,variant:name,scene:scene.name,...result})
      await Bun.write(resolve(out,"live.json"),JSON.stringify(reports,null,2))
    }
    assert.deepEqual(errors,[]);await page.close()
  }
  const quantiles=(a:number[])=>{a.sort((x,y)=>x-y);const q=(p:number)=>a[Math.min(a.length-1,Math.floor(p*(a.length-1)))];return{count:a.length,p50:q(.5),p95:q(.95),p99:q(.99),max:a.at(-1)}}
  const gap=(a:number[])=>a.slice(1).map((x,i)=>x-a[i]!)
  const summaries=reports.map(r=>{
    const down=r.inputs.find((e:any)=>e.kind==="down"),up=r.inputs.find((e:any)=>e.kind==="up")
    const ticks=r.ticks.filter((t:any)=>t.wall>=down.wall&&t.wall<=up.wall)
    const moved=ticks.find((t:any)=>Math.hypot(t.x-down.x,t.y-down.y)>.0001)
    const draws=r.draws.filter((d:any)=>d.submit>=down.wall&&d.submit<=up.wall)
    const fresh=draws.find((d:any)=>d.time>=moved.time-1e-5&&Math.hypot(d.x-down.x,d.y-down.y)>.0001)
    const wallSeconds=(up.wall-down.wall)/1000,simSeconds=up.time-down.time
    return{pair:r.pair,variant:r.variant,scene:r.scene,header:r.header,wallSeconds,simSeconds,realtimeFactor:simSeconds/wallSeconds,distance:Math.hypot(up.x-down.x,up.y-down.y),speed:Math.hypot(up.x-down.x,up.y-down.y)/wallSeconds,expectedDistance:3.4*simSeconds,ticks:ticks.length,submitted:draws.length,submittedPerSecond:draws.length/wallSeconds,callbackGaps:quantiles(gap(r.callbacks.map((c:any)=>c.wall))),submissionGaps:quantiles(gap(draws.map((d:any)=>d.submit))),completionGaps:quantiles(gap(draws.map((d:any)=>d.complete))),queueLatency:quantiles(draws.map((d:any)=>d.complete-d.submit)),inputToSimulationMs:moved.wall-down.wall,inputToSubmissionMs:fresh.submit-down.wall,inputToGPUCompleteMs:fresh.complete-down.wall,hidden:r.hidden}
  })
  await Bun.write(resolve(out,"summary.json"),JSON.stringify({note:"GPU completion/submission are not screen presentation. True input-to-presentation latency remains unmeasured.",summaries},null,2))
  console.log(JSON.stringify(summaries.filter(r=>r.pair>0),null,2))
}finally{await browser.close();await server.close()}
