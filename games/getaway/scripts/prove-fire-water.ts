import { chromium } from "playwright-core"
import { existsSync,mkdirSync,readdirSync,writeFileSync } from "node:fs"
import { resolve } from "node:path"

const out=process.env.FX_OUT??resolve(import.meta.dir,"../../../captures/fire-water")
mkdirSync(out,{recursive:true})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],results:unknown[]=[]
try{
 const page=await browser.newPage({viewport:{width:1000,height:720},deviceScaleFactor:1})
 page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("404"))errors.push(m.text())})
 await page.goto(`${process.env.LAB_URL??"http://127.0.0.1:5180/arcade/lab"}/?bench`)
 await page.waitForFunction(()=>!!(window as any).lab,undefined,{timeout:30000}).catch(error=>{throw new Error(`${error.message}\n${errors.slice(0,3).join("\n")}`)})
 if(errors.length)throw new Error(errors.slice(0,3).join("\n"))
 const adapter=await page.evaluate(()=>{const a=(window as any).lab.adapter;return {vendor:a.vendor,architecture:a.architecture,device:a.device}})
 if(!adapter.architecture.includes("metal"))throw new Error(`Not Metal: ${JSON.stringify(adapter)}`)
 const select=(label:string,value:string)=>page.getByRole("combobox",{name:label,exact:true}).selectOption(value)
 await select("Section","fire-water")
 const render=()=>page.evaluate(async()=>await(window as any).lab.render())
 const state=(values:Record<string,unknown>)=>page.evaluate(values=>{const l=(window as any).lab;Object.assign(l.sections.find((s:any)=>s.id==="fire-water").settings,values);l.context.sync()},values)
 const step=(n:number)=>page.evaluate(async n=>{const l=(window as any).lab;for(let i=0;i<n;i++){l.advance(1/60);await l.render()}},n)
 const quick=process.env.FX_QUICK==="1",captures:string[]=[]
 for(const environment of process.env.FX_TIMING_ONLY==="1"?[]:process.env.FX_ENV?.split(",")??(quick?["downtown"]:["downtown","office","alley"])){
   await select("Environment",environment)
   for(const effect of quick?["fire","water"]:["fire","water","wreck","explosion","fireball"]){
     await select("Effect",effect);await state({playing:true,loop:false});await page.getByRole("button",{name:"Retrigger",exact:true}).click()
     await step(effect==="fireball"?18:effect==="explosion"?90:150);await state({playing:false})
     for(const zoom of quick?[1]:[1,2.3]){
       await state({zoom})
       for(const style of quick?[1,2]:[0,1,2]){
         await select("Style",String(style));await render()
         await page.locator("canvas").focus();await page.keyboard.press("Backquote");await render()
         const file=`${environment}-${effect}-${zoom}-${style}.png`;await page.screenshot({path:resolve(out,file)});captures.push(file)
         await page.keyboard.press("Backquote")
       }
     }
   }
 }
 if(!quick&&process.env.FX_CAPTURE_ONLY!=="1"){
  await select("Environment","downtown")
  const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]
  for(const effect of ["fire","water"]){
   await select("Effect",effect);await state({playing:true,loop:false});await step(150);await state({playing:false})
   for(const zoom of [1,2.3]){
    await state({zoom});const samples:number[][][]=[[],[],[]]
    for(let round=0;round<11;round++)for(const style of round%2?[2,1,0]:[0,1,2]){
      await state({style});const batch=await page.evaluate(async()=>{const l=(window as any).lab,result:number[]=[];for(let i=0;i<12;i++){const ms=await l.render(true);if(ms===null||!Number.isFinite(ms)||ms<=0)throw new Error("Invalid GPU timestamp");if(i>=4)result.push(ms)}return result})
      if(round>=2)samples[style].push(batch)
    }
    const batches=samples.map(style=>style.map(median)),paired=[1,2].map(style=>batches[style].map((x,i)=>x-batches[0][i])),deltas=paired.map(median)
    results.push({effect,zoom,medians:batches.map(median),pairedDelta:deltas,pairedMad:paired.map((values,i)=>median(values.map(v=>Math.abs(v-deltas[i])))),samples})
   }
  }
 }
 if(errors.length)throw new Error(errors.slice(0,3).join("\n"))
 const filename=process.env.FX_CAPTURE_ONLY==="1"?"capture-proof.json":quick?"quick-proof.json":"proof.json"
 writeFileSync(resolve(out,filename),JSON.stringify({adapter,resolution:[1000,720],captures,results,errors},null,2));console.log(JSON.stringify({adapter,captures:captures.length,results:results.map((r:any)=>({...r,samples:undefined})),errors}))
}finally{await browser.close()}
