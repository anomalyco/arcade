import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { cpus } from "node:os"
import { chromium } from "playwright-core"

const game=resolve(process.env.GAME_ROOT??resolve(import.meta.dir,"..")), phase=process.env.PHASE??"refined"
const baseline=!!process.env.GAME_ROOT
const captureOnly=process.env.CAPTURE_ONLY==="1"
const out=resolve(import.meta.dir,"../../../captures/outbreak-look-v2",phase)
mkdirSync(out,{recursive:true})
assert.equal(Bun.spawnSync(["bun","run","build"],{cwd:game,stdout:"inherit",stderr:"inherit"}).exitCode,0)
const root=resolve(game,"dist/arcade/outbreak")
const fixture=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname,f=Bun.file(resolve(root,`.${p==="/"?"/index.html":p}`));return await f.exists()?new Response(f):new Response("Not found",{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const chrome=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(chrome)
const browser=await chromium.launch({executablePath:chrome,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
try {
  const page=await browser.newPage({viewport:{width:1000,height:680},deviceScaleFactor:1})
  const errors:string[]=[]
  page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
  if(!captureOnly)await page.addInitScript(()=>{
    const w=window as any, request=GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice=async function(desc={}) {
      const d=await request.call(this,{...desc,requiredFeatures:this.features.has("timestamp-query")?["timestamp-query"]:[]})
      const q=d.features.has("timestamp-query")?d.createQuerySet({type:"timestamp",count:64}):null
      const rb=d.createBuffer({size:512,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC})
      const read=d.createBuffer({size:512,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})
      const create=d.createCommandEncoder.bind(d)
      let pending=false, sample:any=null
      w.__measure=false
      w.__drain=async()=>{
        if(!sample)return null
        const s=sample;sample=null
        if(q){await read.mapAsync(GPUMapMode.READ);const ns=new BigUint64Array(read.getMappedRange());s.passes=s.passes.map((p:any,i:number)=>({...p,ms:Number(ns[i*2+1]!-ns[i*2]!)/1e6}));read.unmap()}
        pending=false;return s
      }
      d.createCommandEncoder=(desc)=>{
        const e=create(desc)
        if(!w.__measure||pending)return e
        pending=true
        const s={passes:[] as any[],draws:0,vertices:0},finish=e.finish.bind(e)
        for(const kind of ["beginRenderPass","beginComputePass"] as const){const begin=e[kind].bind(e) as any
          ;(e as any)[kind]=(desc:any={})=>{const i=s.passes.length;s.passes.push({kind,label:desc.label??i});const p=begin({...desc,...(q?{timestampWrites:{querySet:q,beginningOfPassWriteIndex:i*2,endOfPassWriteIndex:i*2+1}}:{})});if(kind==="beginRenderPass"){const draw=p.draw.bind(p);p.draw=(v:number,n=1,...args:any[])=>{s.draws++;s.vertices+=v*n;draw(v,n,...args)}}return p}
        }
        e.finish=(desc)=>{if(q){e.resolveQuerySet(q,0,s.passes.length*2,rb,0);e.copyBufferToBuffer(rb,0,read,0,s.passes.length*16)}sample=s;return finish(desc)}
        return e
      }
      return d
    }
  })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`)
  await page.waitForFunction(()=>(window as any).__arcadeHarness?.ready)
  assert.deepEqual(errors,[])
  const adapter=await page.evaluate(()=>(window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture,/metal/)
  const scenes=[{name:"street",x:30,y:41,aim:-Math.PI/2,hour:18,zoom:42},{name:"interior",x:27.7,y:31,aim:-Math.PI/2,hour:19,zoom:34}]
  const reports:any[]=[]
  for(const scene of scenes){
    await page.evaluate(async s=>{const h=(window as any).__arcadeHarness;h.reset(7);h.setLab("timeScale",0);h.setLab("hour",s.hour);h.setLab("zoom",s.zoom)
      for(const [x,y,a] of [[30,41,-1.57],[20,35,-1.57],[20,26,0],[30,21,1.57],[38,32,3.14]]){h.pose(x,y,a);await h.step()}
      h.pose(s.x,s.y,s.aim);if(s.name==="interior")await h.step(1/60,{interact:true});for(let i=0;i<8;i++)await h.step()
    },scene)
    for(const [mode,label] of ["beauty","albedo","direct","ambient","specular","bloom","before-memory"].entries()){
      if((baseline||process.env.DIAGNOSTICS!=="1")&&mode>0)continue
      await page.evaluate(async ({mode,baseline})=>{const h=(window as any).__arcadeHarness;if(!baseline)h.setLab("diagnostic",mode);await h.step(0)},{mode,baseline})
      await page.screenshot({path:resolve(out,`${scene.name}-${label}.png`)})
    }
    if(captureOnly){reports.push({scene,state:await page.evaluate(()=>(window as any).__arcadeHarness.state())});continue}
    const perf=await page.evaluate(async baseline=>{const w=window as any,h=w.__arcadeHarness;if(!baseline)h.setLab("diagnostic",0)
      for(let i=0;i<30;i++)await h.step(0)
      const samples=[];w.__measure=true
      for(let i=0;i<24;i++){const start=performance.now();await h.step(0);const span=performance.now()-start;const sample=await w.__drain();samples.push({...sample,queueCompletedMs:span})}
      w.__measure=false;return {state:h.state(),samples}
    },baseline)
    const lightAblation=baseline?[]:await page.evaluate(async()=>{
      const h=(window as any).__arcadeHarness, runs=[]
      for(let pair=0;pair<4;pair++)for(const lighting of pair%2?[0,1]:[1,0]){
        h.setLab("lighting",lighting);for(let i=0;i<10;i++)await h.step(0)
        const spans=[];for(let i=0;i<20;i++){const t=performance.now();await h.step(0);spans.push(performance.now()-t)}
        runs.push({pair,lighting,spans})
      }
      h.setLab("lighting",1);return runs
    })
    reports.push({scene,...perf,lightAblation})
  }
  if(!baseline) {
  await page.keyboard.press("Backquote")
  const diagnostic=page.getByRole("combobox",{name:"Contribution",exact:true})
  await diagnostic.selectOption("4")
  await page.evaluate(async()=>{await (window as any).__arcadeHarness.step(0)})
  assert.equal(await diagnostic.inputValue(),"4")
  await diagnostic.selectOption("0")
  await page.keyboard.press("Backquote")
  }
  assert.deepEqual(errors,[])
  await Bun.write(resolve(out,"proof.json"),JSON.stringify({phase,source:baseline?"e5554a7":"working tree",timing:captureOnly?"not measured":"queueCompletedMs includes CPU and queue completion; pass timestamp intervals overlap on Metal and must not be summed or treated as isolated pass costs",adapter,hardware:cpus()[0]?.model,viewport:[1000,680],dpr:1,crop:[0,0,1000,680],reports,errors},null,2))
}finally{await browser.close();fixture.stop(true)}
