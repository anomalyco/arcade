import { chromium } from "playwright-core"
import { existsSync,mkdirSync,readdirSync,writeFileSync } from "node:fs"
import { resolve } from "node:path"

const out=resolve(process.env.SPLATTER_OUT??"../../captures/splatter"),host=process.env.LAB_URL??"http://127.0.0.1:5180/arcade/lab",quick=process.env.SPLATTER_QUICK==="1"
mkdirSync(out,{recursive:true})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`,executablePath=readdirSync(cache).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],captures:string[]=[],results:any[]=[],median=(a:number[])=>a.toSorted((a,b)=>a-b)[Math.floor(a.length/2)]!
try{
 const page=await browser.newPage({viewport:{width:1000,height:720},deviceScaleFactor:1})
 page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("404"))errors.push(m.text())})
 await page.goto(`${host}/?bench`)
 await page.waitForFunction(()=>!!(window as any).lab,undefined,{timeout:30000}).catch(error=>{throw new Error(`${error.message}\n${errors.slice(0,3).join("\n")}`)})
 const adapter=await page.evaluate(()=>{const a=(window as any).lab.adapter;return{vendor:a.vendor,architecture:a.architecture}})
 if(!adapter.architecture.includes("metal"))throw new Error("Metal required")
 const select=(label:string,value:string)=>page.getByRole("combobox",{name:label,exact:true}).selectOption(value)
 await select("Section","splatter")
 const state=(values:Record<string,unknown>)=>page.evaluate(values=>{const l=(window as any).lab;Object.assign(l.sections.find((s:any)=>s.id==="splatter").settings,values);l.context.sync()},values)
 const step=(n:number)=>page.evaluate(async n=>{const l=(window as any).lab;for(let i=0;i<n;i++){l.advance(1/60);await l.render()}},n)
 const render=()=>page.evaluate(async()=>await(window as any).lab.render())
 const capture=async(name:string)=>{await page.locator("canvas").focus();await page.keyboard.press("Backquote");await render();const image=await page.screenshot({path:resolve(out,name)});await page.keyboard.press("Backquote");captures.push(name);return image}
 for(const room of quick?[process.env.SPLATTER_ROOM??"office"]:["office","downtown"]){
  await select("Room",room)
  for(const target of quick?["floor","wall","desk"]:["floor","wall","grazing","desk","glass"]){
   await select("Target",target);await state({playing:true,loop:false});await page.getByRole("button",{name:"Retrigger",exact:true}).click();await step(75);await state({playing:false})
   for(const zoom of quick?[2.5]:[1,2.5]){
    await state({zoom})
    for(const style of [0,1]){await select("Style",String(style));await render();await capture(`${room}-${target}-${zoom}-${style}.png`)}
   }
   const telemetry=await page.evaluate(()=>(window as any).lab.sections.find((s:any)=>s.id==="splatter").telemetry())
   const inspect=JSON.parse(telemetry.slice(telemetry.indexOf("{")))
   if(target!=="glass"&&inspect.decals===0)throw new Error(`Missing ${room}/${target} deposits`)
   if(target==="wall"&&inspect.walls===0)throw new Error("Missing wall-aligned deposits")
   results.push({room,target,inspect})
  }
 }
 if(!quick){
  await select("Room","office");await select("Target","floor");await state({zoom:2.5,style:1,playing:true,loop:false})
  for(const preset of ["blood","ink","slime","oil","potion"]){await select("Preset",preset);await step(75);await state({playing:false});await capture(`preset-${preset}.png`);await state({playing:true})}
  await select("Preset","blood");await state({playing:false});await page.getByRole("button",{name:"Step frame",exact:true}).click();await render()
  const stepTime=await page.evaluate(()=>JSON.parse((window as any).lab.sections.find((s:any)=>s.id==="splatter").telemetry().split(" · ").at(-1)).time)
  if(Math.abs(stepTime-1/60)>1e-5)throw new Error(`Frame stepping advanced ${stepTime}`)
  await state({slowMotion:.25,playing:true});await step(60);await state({playing:false})
  const slowTime=await page.evaluate(()=>JSON.parse((window as any).lab.sections.find((s:any)=>s.id==="splatter").telemetry().split(" · ").at(-1)).time)
  if(Math.abs(slowTime-(.25+1/60))>1e-5)throw new Error(`Slow motion advanced ${slowTime}`)
  results.push({controls:{stepTime,slowTime}})
  // Exercise and time the actual Blackout HDR pipeline, including the opt-in motion MRT.
  for(const room of ["office","downtown"]){
   await page.goto(`${host}/envlab.html?fxproof&bench&kind=${room}&seed=7`)
   await page.waitForFunction(()=>!!(window as any).fxProof)
   await page.evaluate(async room=>{
    const w=window as any,f=w.fxProof,game=f.game
    const {blackoutEnvironment}=await import(/* @vite-ignore */"/src/lab/environment.ts" as string)
    const {Camera}=await import(/* @vite-ignore */"/src/render/camera.ts" as string)
    const seeded=(seed:number,run:()=>any)=>{const old=Math.random;Math.random=()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296};try{return run()}finally{Math.random=old}}
    const camera=new Camera();camera.snap(13.5,11.5);camera.dist=20;w.frames=[]
    game.labLoad(blackoutEnvironment(room,7));game.juice.lookMotion=false
    const event={id:400,limbId:3,seed:19,x:13.5,y:1.05,z:11.5,dx:1,dy:-.1,dz:.2,vx:0,vy:0,vz:0}
    for(const style of [0,1]){
     game.labClear();game.now=0;game.splatterStyle=style
     seeded(19,()=>{if(style)game.cosmeticSplatter(event);else game.labBlood(event)})
     let frame:any
     for(let i=0;i<75;i++){game.labAdvance(1/60);frame=seeded(19,()=>game.build(camera,1000,720,1/60))}
     w.frames.push({...frame,frame:frame.frame.slice(),lights:frame.lights.slice(),occluders:frame.occluders.slice(),lampPower:frame.lampPower.slice(),alphaSprites:frame.alphaSprites.slice(),addSprites:frame.addSprites.slice(),batches:frame.batches.map((b:any)=>({...b,data:b.data.slice()}))})
    }
    w.sample=async(style:number,motion=false)=>{const frame=w.frames[style];frame.frame[45]=(frame.frame[45]&~1024)|(motion?1024:0);return f.renderer.measure(frame)}
   },room)
   const pairs:any[]=[]
   for(let round=0;round<10;round++){
    const samples:number[][]=[[],[]]
    for(const style of round%2?[1,0]:[0,1])samples[style]=await page.evaluate(async style=>{const out:number[]=[];for(let i=0;i<12;i++){const ms=await(window as any).sample(style);if(ms===null||!Number.isFinite(ms)||ms<=0)throw new Error("Invalid GPU timestamp");if(i>=4)out.push(ms)}return out},style)
    if(round>0)pairs.push({before:samples[0],after:samples[1],delta:median(samples[1])-median(samples[0])})
   }
   for(const style of [0,1]){await page.evaluate(async style=>{const w=window as any;w.fxProof.renderer.render(w.frames[style]);await w.fxProof.renderer.device.queue.onSubmittedWorkDone()},style);await page.addStyleTag({content:"[data-lab],#info{visibility:hidden!important}"});await page.screenshot({path:resolve(out,`production-${room}-${style}.png`)})}
   await page.evaluate(async()=>await(window as any).sample(1,true))
   const delta=median(pairs.map(p=>p.delta));results.push({production:room,delta,mad:median(pairs.map(p=>Math.abs(p.delta-delta))),pairs})
  }
 }
 if(errors.length)throw new Error(errors.slice(0,4).join("\n"))
 writeFileSync(resolve(out,quick?"quick-proof.json":"proof.json"),JSON.stringify({adapter,resolution:[1000,720],captures,results,errors},null,2))
 console.log(JSON.stringify({adapter,captures:captures.length,results:results.map(r=>({...r,pairs:undefined})),errors}))
}finally{await browser.close()}
