/// <reference types="@webgpu/types" />
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from 'vite'
import { mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

await using budget = browserBudget()
const { chromium } = budget
const root=resolve(import.meta.dir,'..'),out=resolve(root,'../../captures/motion-blur')
mkdirSync(out,{recursive:true})
const server=await createServer({root,configFile:join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0}})
await server.listen();const address=server.httpServer!.address();if(!address||typeof address==='string')throw Error('port')
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--ignore-gpu-blocklist','--mute-audio','--disable-dawn-features=timestamp_quantization']})
const errors:string[]=[],pairs:any[]=[],median=(n:number[])=>n.toSorted((a,b)=>a-b)[Math.floor(n.length/2)]!
try{
 const page=await browser.newPage({viewport:{width:2560,height:1440},deviceScaleFactor:1})
 page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)})
 page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404')){errors.push(m.text());console.error(m.text())}})
 await page.goto(`http://localhost:${address.port}/?solo&peaceful=1&seed=7&bench&nohud&smoketiming`)
 await page.waitForFunction(()=>(window as any).__getawayBench)
 const info=await page.evaluate(async()=>{const b=(window as any).__getawayBench;await b.ready;b.reset(true);b.distance(46);return b.adapterInfo})
 if(!info.architecture.includes('metal'))throw Error(JSON.stringify(info))
 const step=(i:number,dt=1/30)=>page.evaluate(async({i,dt})=>(window as any).__getawayBench.step(i,dt,true),{i,dt})
 const toggle=(enabled:boolean)=>page.evaluate(async enabled=>{const path='/src/render/motion.ts';const m=await import(/* @vite-ignore */path);m.motionBlur.enabled=enabled},enabled)
 for(let i=0;i<65;i++)await step(i)
 const pictures:Buffer[]=[]
 for(const enabled of [false,true]){await toggle(enabled);await step(64,0);pictures.push(await page.screenshot({path:join(out,enabled?'after.png':'before.png')}))}
 if(pictures[0]!.equals(pictures[1]!))throw Error('Moving frame did not change')
 for(let pair=-1;pair<9;pair++){
   const members:any={}
   for(const enabled of pair%2?[true,false]:[false,true]){
     await toggle(enabled);const frames:number[]=[],poses:any[]=[]
     for(let n=0;n<4;n++)await step(64,0)
     for(let n=0;n<32;n++){const r=await step(64,0);frames.push(r.totalGpuMs);poses.push(r.pose)}
     members[enabled?'on':'off']={frames,median:median(frames),poses}
   }
   if(JSON.stringify(members.on.poses)!==JSON.stringify(members.off.poses))throw Error('Pose mismatch')
   if(pair>=0)pairs.push({pair,...members,delta:members.on.median-members.off.median})
 }
 const delta=median(pairs.map(p=>p.delta)),mad=median(pairs.map(p=>Math.abs(p.delta-delta)))
 await page.evaluate(()=>(window as any).__getawayBench.reset(true))
 await toggle(true);await step(0,1/60);const resetOn=await page.screenshot()
 await toggle(false);await step(0,0);const resetOff=await page.screenshot()
 if(!resetOn.equals(resetOff))throw Error('Camera cut must have zero blur')
 const result={info,width:2560,height:1440,delta,mad,pairs,errors,checks:{movingPixelsChanged:true,resetPixelsIdentical:true},method:'Whole GPU interval, first shadow through dependent offscreen final composite marker, excluding presentation copy. Nine alternating pairs of 32 frozen nitro-drift frames, four settling frames per member, one warmup pair. Includes depth retention, velocity and gather.'}
 writeFileSync(join(out,'proof.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({delta,mad,errors}))
 if(errors.length)throw Error(errors.slice(0,4).join('\n'))
}finally{await browser.close();await server.close()}
