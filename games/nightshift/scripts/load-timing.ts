/**
 * Cold-cache, headless, muted load timing: first byte to the Begin prompt.
 *
 *   hivemind run --kind browser --browser-approval "…" -- bun games/nightshift/scripts/load-timing.ts [--url https://anoma.ly/arcade/nightshift/] [--runs 3] [--mbps 40] [--no-build]
 *
 * Without --url it builds and serves dist/. Each run uses a fresh browser context (empty HTTP cache). Reports
 * navigation, every resource (bytes, start, end), the game's `nightshift:` marks, WebGPU adapter/device time,
 * pipeline counts, the first submitted frame's GPU completion and the longest main-thread frame gap.
 */
import { chromium, type Browser } from "playwright-core"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"

const arg=(name:string)=>{const i=process.argv.indexOf(`--${name}`);return i<0?undefined:process.argv[i+1]}
const runs=Number(arg("runs")??3),profile=process.argv.includes("--profile"),mbps=arg("mbps")?Number(arg("mbps")):undefined,root=resolve(import.meta.dir,"..")
const servers:ReturnType<typeof Bun.serve>[]=[]
const serve=(dir:string)=>{const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname,f=Bun.file(`${dir}${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}});servers.push(server);return `http://127.0.0.1:${server.port}/arcade/nightshift/`}
// --compare <dir> alternates runs between that saved dist (containing arcade/nightshift) and this build.
const compare=arg("compare"),urls:string[]=[]
if(arg("url"))urls.push(arg("url")!)
else{
  if(!process.argv.includes("--no-build")){const b=Bun.spawn(["bunx","vite","build",...(profile?["--minify","false"]:[])],{cwd:root,stdout:"ignore",stderr:"inherit"});if(await b.exited!==0)throw Error("Build failed")}
  if(compare)urls.push(serve(resolve(compare)))
  urls.push(serve(`${root}/dist`))
}
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=existsSync(cache)?(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync):undefined
// A fresh browser per run: an empty HTTP cache and GPU shader cache (and a second context crashed Chromium's GPU process).
const launch=()=>chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio","--autoplay-policy=user-gesture-required"]})
let browser:Browser|undefined
type Sample={url:string;begin:number;nav:Record<string,number>;resources:{name:string;type:string;bytes:number;start:number;end:number}[];marks:[string,number][];t:Record<string,number>;gaps:[number,number][];boot:string[]}
const samples:Sample[]=[]
try{
  for(let run=0;run<runs*urls.length;run++){
    const url=urls[run%urls.length]
    await browser?.close();browser=await launch()
    const context=await browser.newContext({viewport:{width:1280,height:720}})
    const page=await context.newPage()
    const cdp=await context.newCDPSession(page)
    if(mbps){await cdp.send("Network.enable");await cdp.send("Network.emulateNetworkConditions",{offline:false,latency:20,downloadThroughput:mbps*125000,uploadThroughput:mbps*125000})}
    if(profile){await cdp.send("Profiler.enable");await cdp.send("Profiler.setSamplingInterval",{interval:500});await cdp.send("Profiler.start")}
    await page.addInitScript(()=>{
      const t:Record<string,number>={},gaps:[number,number][]=[],w=window as unknown as {__load:{t:typeof t;gaps:typeof gaps;boot:string[]}}
      w.__load={t,gaps,boot:[]}
      new PerformanceObserver(l=>{for(const e of l.getEntries())gaps.push([Math.round(e.startTime),-Math.round(e.duration)])}).observe({type:"longtask",buffered:true})
      let last=0;const tick=(now:number)=>{if(last&&now-last>100)gaps.push([Math.round(last),Math.round(now-last)]);last=now;if(!t.begin)requestAnimationFrame(tick)};requestAnimationFrame(tick)
      new MutationObserver(()=>{
        if(!t.begin&&/Begin/.test((document.getElementById("prompt")?.textContent??"")+(document.querySelector("[data-boot-tail]")?.textContent??""))){t.begin=performance.now();void (window as unknown as {__queue?:GPUQueue}).__queue?.onSubmittedWorkDone().then(()=>{t.firstFrameDone=performance.now()})}
        const boot=document.querySelector("[data-boot-log]")?.textContent;if(boot&&w.__load.boot.at(-1)!==boot)w.__load.boot.push(`${Math.round(performance.now())} ${boot.replace(/\s+/g," ").slice(-90)}`)
      }).observe(document,{subtree:true,childList:true,characterData:true})
      const time=<A extends unknown[],R>(key:string,f:(...a:A)=>Promise<R>)=>async function(this:unknown,...a:A){const s=performance.now();t[`${key}At`]??=s;const r=await f.apply(this,a);t[key]=(t[key]??0)+performance.now()-s;return r}
      if(navigator.gpu){
        const gpu=Object.getPrototypeOf(navigator.gpu);gpu.requestAdapter=time("adapter",gpu.requestAdapter)
        GPUAdapter.prototype.requestDevice=time("device",GPUAdapter.prototype.requestDevice)
        for(const name of ["createRenderPipeline","createComputePipeline","createShaderModule"] as const){
          const f=GPUDevice.prototype[name] as (...a:unknown[])=>unknown
          ;(GPUDevice.prototype as unknown as Record<string,unknown>)[name]=function(this:GPUDevice,...a:unknown[]){const s=performance.now();const r=f.apply(this,a);t[`${name}Count`]=(t[`${name}Count`]??0)+1;t[`${name}Ms`]=(t[`${name}Ms`]??0)+performance.now()-s;t[`${name}Last`]=performance.now();return r}
        }
        for(const name of ["createRenderPipelineAsync","createComputePipelineAsync"] as const){
          const f=GPUDevice.prototype[name] as (...a:unknown[])=>Promise<unknown>
          ;(GPUDevice.prototype as unknown as Record<string,unknown>)[name]=function(this:GPUDevice,...a:unknown[]){t[`${name}Count`]=(t[`${name}Count`]??0)+1;return f.apply(this,a).finally(()=>{t[`${name}Last`]=performance.now()})}
        }
        const submit=GPUQueue.prototype.submit
        GPUQueue.prototype.submit=function(this:GPUQueue,b:Iterable<GPUCommandBuffer>){
          const first=!t.firstSubmit;if(first)t.firstSubmit=performance.now();(window as unknown as {__queue?:GPUQueue}).__queue=this
          submit.call(this,b)
          if(first)void this.onSubmittedWorkDone().then(()=>{t.firstSubmitDone=performance.now()})
        }
      }
    })
    await page.goto(url,{waitUntil:"commit"})
    await page.waitForFunction(()=>(window as unknown as {__load:{t:{begin?:number}}}).__load.t.begin,undefined,{timeout:180_000,polling:50})
    await page.waitForFunction(()=>(window as unknown as {__load:{t:{firstFrameDone?:number}}}).__load.t.firstFrameDone,undefined,{timeout:60_000,polling:50})
    const s=await page.evaluate(()=>{
      const n=performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming
      const w=window as unknown as {__load:{t:Record<string,number>;gaps:[number,number][];boot:string[]}}
      return {
        begin:w.__load.t.begin,t:w.__load.t,gaps:w.__load.gaps,boot:w.__load.boot,
        nav:{ttfb:n.responseStart,html:n.responseEnd,dom:n.domContentLoadedEventEnd,load:n.loadEventEnd},
        resources:(performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map(r=>({name:new URL(r.name).pathname.replace(/^\/arcade\/nightshift\//,""),type:r.initiatorType,bytes:r.encodedBodySize||r.transferSize,start:r.startTime,end:r.responseEnd})),
        marks:performance.getEntriesByType("mark").filter(m=>m.name.startsWith("nightshift:")).map(m=>[m.name.slice(11),m.startTime] as [string,number]),
      }
    })
    samples.push({...s,url} as Sample)
    if(profile&&run===0){
      type Node={id:number;callFrame:{functionName:string;url:string;lineNumber:number;columnNumber:number};children?:number[]}
      const {profile:p}=await cdp.send("Profiler.stop") as unknown as {profile:{nodes:Node[];samples:number[];timeDeltas:number[]}}
      const self=new Map<number,number>(),parent=new Map<number,number>(),byId=new Map(p.nodes.map(n=>[n.id,n]))
      for(const n of p.nodes)for(const c of n.children??[])parent.set(c,n.id)
      p.samples.forEach((id,i)=>self.set(id,(self.get(id)??0)+(p.timeDeltas[i]??0)/1000))
      const key=(n:Node)=>`${n.callFrame.functionName||"(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber+1}:${n.callFrame.columnNumber+1}`
      const selfBy=new Map<string,number>(),totalBy=new Map<string,number>()
      for(const [id,ms] of self){const n=byId.get(id)!;selfBy.set(key(n),(selfBy.get(key(n))??0)+ms);const seen=new Set<string>();for(let c:number|undefined=id;c!==undefined;c=parent.get(c)){const k=key(byId.get(c)!);if(!seen.has(k)){seen.add(k);totalBy.set(k,(totalBy.get(k)??0)+ms)}}}
      const top=(m:Map<string,number>)=>[...m].filter(([k])=>!/^\((idle|program|root|garbage)/.test(k)).sort((a,b)=>b[1]-a[1]).slice(0,25).map(([k,ms])=>`    ${String(Math.round(ms)).padStart(6)} ms  ${k}`).join("\n")
      console.log(`  CPU self:\n${top(selfBy)}\n  CPU total:\n${top(totalBy)}`)
    }
    const r=(v:number|undefined)=>v===undefined?"—":`${Math.round(v)}`
    console.log(`\n${url} run ${Math.floor(run/urls.length)+1}: Begin at ${r(s.begin)} ms  (ttfb ${r(s.nav.ttfb)}, html ${r(s.nav.html)}, DOMContentLoaded ${r(s.nav.dom)}, load ${r(s.nav.load)})`)
    const tt=s.t
    console.log(`  gpu: adapter ${r(tt.adapterAt)}+${r(tt.adapter)}  device +${r(tt.device)}  shaders ${tt.createShaderModuleCount??0} (${r(tt.createShaderModuleMs)} ms js)  render pipelines sync ${tt.createRenderPipelineCount??0} async ${tt.createRenderPipelineAsyncCount??0} (last ${r(tt.createRenderPipelineLast)}, async done ${r(tt.createRenderPipelineAsyncLast)})  compute ${tt.createComputePipelineCount??0}`)
    console.log(`  first submit ${r(tt.firstSubmit)} → GPU done ${r(tt.firstSubmitDone)} (${r((tt.firstSubmitDone??0)-(tt.firstSubmit??0))} ms); work submitted by Begin done at ${r(tt.firstFrameDone)}`)
    console.log(`  frame gaps >100 ms: ${s.gaps.filter(g=>g[1]>0).map(([at,ms])=>`${ms}@${at}`).join(" ")||"none"}`)
    console.log(`  main-thread long tasks: ${s.gaps.filter(g=>g[1]<0).map(([at,ms])=>`${-ms}@${at}`).join(" ")||"none"}`)
    if(s.marks.length)console.log(`  marks: ${s.marks.map(([n,ms])=>`${n} ${Math.round(ms)}`).join(" · ")}`)
    for(const x of s.resources.sort((a,b)=>a.start-b.start))console.log(`  ${x.name.padEnd(44)} ${String(Math.round(x.bytes/1024)).padStart(5)} KB  ${r(x.start).padStart(6)} → ${r(x.end).padStart(6)} ms`)
    if(s.boot.length)console.log(`  boot log:\n    ${s.boot.join("\n    ")}`)
  }
  const median=(xs:number[])=>xs.sort((a,b)=>a-b)[Math.floor(xs.length/2)]
  for(const url of urls){
    const mine=samples.filter(s=>s.url===url),ready=mine.map(s=>s.marks.find(m=>m[0]==="ready")?.[1]).filter((v):v is number=>v!==undefined)
    console.log(`\n${url}${mbps?` @ ${mbps} Mbps/20 ms`:""}: median Begin ${Math.round(median(mine.map(s=>s.begin)))} ms, first frame GPU done ${Math.round(median(mine.map(s=>s.t.firstFrameDone??s.t.firstSubmitDone??0)))} ms over ${runs} cold runs (${mine.map(s=>Math.round(s.begin)).join(", ")})${ready.length?`; boot ready ${Math.round(median(ready))} ms`:""}`)
  }
  await Bun.write(`${root}/captures/load-timing/${Date.now()}.json`,JSON.stringify({mbps,samples},null,1))
}finally{await browser?.close();for(const s of servers)s.stop(true)}
