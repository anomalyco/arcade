/// <reference types="@webgpu/types" />
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root=resolve(import.meta.dir,".."),out=resolve(root,"../../captures/shared-blackout-motion")
mkdirSync(out,{recursive:true})
const server=await createServer({root,configFile:join(root,"vite.config.ts"),server:{host:"127.0.0.1",port:0}})
await server.listen();const a=server.httpServer!.address();if(!a||typeof a==="string")throw Error("No port")
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio","--disable-dawn-features=timestamp_quantization"]})
const errors:string[]=[],results:any[]=[],median=(a:number[])=>a.toSorted((a,b)=>a-b)[Math.floor(a.length/2)]!
try{
  const page=await browser.newPage({viewport:{width:2560,height:1440}})
  page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("404"))errors.push(m.text())})
  for(const kind of ["office","downtown"]){
    await page.goto(`http://localhost:${a.port}/envlab.html?fxproof&bench&seed=1&kind=${kind}&zoom=20`)
    await page.waitForFunction(()=>(window as any).fxProof)
    const adapter=await page.evaluate(async()=>{
      const w=window as any,f=w.fxProof,r=f.renderer
      const render=r.render.bind(r);r.render=(frame:any)=>{w.source=frame;render(frame)}
      await f.step(1/60);await r.device.queue.onSubmittedWorkDone()
      w.source={...w.source,frame:w.source.frame.slice(),batches:w.source.batches.map((b:any)=>({...b,data:b.data.slice()}))}
      w.sample=async(tick:number,on:boolean,measure=true)=>{
        const source=w.source,frame={...source,frame:source.frame.slice(),batches:source.batches.map((b:any)=>({...b,data:b.data.slice()}))}
        frame.frame[45]=(frame.frame[45]&~1024)|(on?1024:0)
        frame.frame[19]=tick/60
        const pan=Math.sin(tick*.12)*1.8
        for(let row=0;row<4;row++)frame.frame[12+row]+=frame.frame[row]*pan
        frame.frame[16]-=pan
        for(const b of frame.batches)for(let i=0;i<b.count;i++)if(b.motionKeys?.[i]){b.data[i*12]+=Math.sin(tick*.16)*.8;b.data[i*12+3]+=Math.sin(tick*.09)*.3}
        if(measure)return r.measure(frame)
        r.render(frame);await r.device.queue.onSubmittedWorkDone();return null
      }
      return {vendor:f.adapter.vendor,architecture:f.adapter.architecture}
    })
    if(!adapter.architecture.includes("metal"))throw Error("Metal required")
    const pairs:any[]=[]
    for(let pair=-1;pair<9;pair++){
      const members:any={}
      for(const on of pair%2?[true,false]:[false,true])members[on?"on":"off"]=await page.evaluate(async on=>{
        const w=window as any;w.fxProof.renderer.previousFrame=null
        const samples:number[]=[]
        for(let tick=0;tick<48;tick++){const ms=await w.sample(tick,on);if(tick>=24)samples.push(ms)}
        return samples
      },on)
      if(pair>=0)pairs.push({pair,...members,delta:median(members.on)-median(members.off)})
    }
    for(const on of [false,true]){
      await page.evaluate(async on=>{const w=window as any;w.fxProof.renderer.previousFrame=null;for(let t=0;t<=32;t++)await w.sample(t,on,false)},on)
      await page.screenshot({path:join(out,`${kind}-${on?"on":"off"}.png`)})
    }
    const delta=median(pairs.map(p=>p.delta)),mad=median(pairs.map(p=>Math.abs(p.delta-delta)))
    results.push({kind,adapter,delta,mad,pairs});console.log(JSON.stringify({kind,delta,mad}))
  }
  if(errors.length)throw Error(errors.join("\n"))
  writeFileSync(join(out,"proof.json"),JSON.stringify({size:[2560,1440],method:"Nine alternating pairs; each member replays identical 48 camera/instance poses, first 24 warm up, median of last 24. Whole GPU interval, first polar compute through dependent offscreen composite marker. Shared eight-tap gather plus full-resolution four-sample velocity MRT; strength 1, shutter 1. No pass sums.",results,errors},null,2))
}finally{await browser.close();await server.close()}
