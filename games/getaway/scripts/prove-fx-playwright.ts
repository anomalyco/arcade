/// <reference types="@webgpu/types" />
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { mkdirSync, readdirSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root=resolve(import.meta.dir,"../../.."),out=join(root,"captures/fx-kit")
mkdirSync(out,{recursive:true})
const smokeOnly=process.argv.includes("--quick")
const labOnly=process.argv.includes("--lab")
const fixture=async(game:string,before=false)=>{
  const dir=join(root,"games",game)
  const server=await createServer({root:dir,configFile:join(dir,"vite.config.ts"),cacheDir:join(dir,before?"node_modules/.vite-fx-before":"node_modules/.vite-fx"),
    plugins:before?[{name:"approved-smoke-baseline",enforce:"pre",load(id){
      if(id===join(dir,"src/render/smoke.ts"))return readFileSync(join(root,"perf/fx-baseline/smoke.txt"),"utf8")
      if(id===join(dir,"src/game/smoke-trail.ts"))return readFileSync(join(root,"perf/fx-baseline/trail.txt"),"utf8")
    }}]:[],server:{host:"127.0.0.1",port:0}})
  await server.listen();const address=server.httpServer!.address()
  if(!address||typeof address==="string")throw new Error("No fixture port")
  return {server,url:`http://localhost:${address.port}`}
}
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const chrome=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath:chrome,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio","--disable-dawn-features=timestamp_quantization"]})
const errors:string[]=[],results:any={}
const fixtures:Awaited<ReturnType<typeof fixture>>[]=[]
const median=(xs:number[])=>xs.toSorted((a,b)=>a-b)[Math.floor(xs.length/2)]!
try{
  const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:1})
  page.on("pageerror",e=>{errors.push(e.message);console.error(e.message)})
  page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("404")){errors.push(m.text());console.error(m.text().slice(0,1500))}})
  const getaway=await fixture("getaway");fixtures.push(getaway)
  await page.goto(`${getaway.url}/fx.html?bench`)
  await page.waitForFunction(()=>(window as any).fx,{},{timeout:30000})
  results.adapter=await page.evaluate(()=>{const a=(window as any).fx.adapter;return {architecture:a.architecture,vendor:a.vendor,device:a.device,description:a.description}})
  if(!/metal/i.test(JSON.stringify(results.adapter))||/swiftshader/i.test(JSON.stringify(results.adapter)))throw new Error(`Not Metal: ${JSON.stringify(results.adapter)}`)
  console.log("Adapter",results.adapter)
  for(const [effect,frames,debug] of [["smoke",90,0],["water",55,0],["sparks",16,0],["smoke",90,1],["smoke",90,4],["debris",24,0],["fire",55,0],["nitro",30,0],["tyre",90,0],["explosion",12,0],["smoke",90,2],["smoke",90,3]] as const){
    await page.getByRole("combobox",{name:"Effect",exact:true}).selectOption(effect)
    await page.getByRole("combobox",{name:"Debug view",exact:true}).selectOption(String(debug))
    await page.evaluate(async({effect,frames,debug})=>{const f=(window as any).fx;f.reset(effect);f.debug(debug);for(let i=0;i<frames;i++)f.advance(1/30);await f.render(true)},{effect,frames,debug})
    await page.screenshot({path:join(out,`playground-${effect}-${debug}.png`)})
    console.log("Captured",effect,debug)
    if(errors.length)throw new Error("GPU validation errors")
    if(smokeOnly)break
  }
  if(labOnly){
    const originalUrl=page.url()
    const effect=page.getByRole("combobox",{name:"Effect",exact:true})
    await effect.selectOption("sparks")
    await page.getByRole("slider",{name:"Rate",exact:true}).focus()
    await page.keyboard.press("ArrowRight")
    if(await page.evaluate(()=>(window as any).fx.params.rate)!==76)throw new Error("Slider did not update shared state")
    await page.keyboard.press("ArrowLeft")
    await page.getByRole("checkbox",{name:"Play",exact:true}).uncheck()
    await page.getByRole("checkbox",{name:"Loop",exact:true}).uncheck()
    if(await page.evaluate(()=>(window as any).fx.params.playing||(window as any).fx.params.loop))throw new Error("Playback toggles failed")
    await page.getByRole("button",{name:"Retrigger",exact:true}).click()
    if(await page.evaluate(()=>(window as any).fx.particles.count)!==75)throw new Error("Retrigger failed")
    await page.context().grantPermissions(["clipboard-read","clipboard-write"],{origin:getaway.url})
    await page.getByRole("button",{name:"Copy",exact:true}).click()
    await page.getByRole("button",{name:"Copied",exact:true}).waitFor()
    const copied=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()))
    if(copied.effect!=="sparks"||copied.rate!==75)throw new Error("Copy lost current settings")
    await effect.focus();await page.keyboard.press("Backquote")
    if(await effect.isVisible())throw new Error("Focused control Backquote did not close Lab")
    await page.locator("canvas").focus();await page.keyboard.press("Backquote")
    if(!await effect.isVisible())throw new Error("Canvas Backquote did not open Lab")
    if(page.url()!==originalUrl)throw new Error("Playground UI rewrote the URL")
    await page.goto(`${getaway.url}/?solo&peaceful=1&seed=7&bench&nohud&lab=1&smoke=6`)
    await page.waitForFunction(()=>(window as any).__getawayBench)
    await page.evaluate(async()=>{await(window as any).__getawayBench.ready})
    const style=page.getByRole("combobox",{name:"Smoke style",exact:true}),gameUrl=page.url()
    await style.selectOption("2")
    await page.getByRole("button",{name:"All Off",exact:true}).click()
    if(await style.inputValue()!=="2")throw new Error("Toggle preset changed the select")
    await page.getByRole("button",{name:"All On",exact:true}).click()
    if(page.url()!==gameUrl)throw new Error("Smoke selector rewrote the URL")
    const blackout=await fixture("blackout");fixtures.push(blackout)
    await page.goto(`${blackout.url}/envlab.html?fxproof&bench&lab=1&seed=1`)
    await page.waitForFunction(()=>(window as any).fxProof)
    await page.getByRole("checkbox",{name:"Volume Smoke",exact:true}).uncheck()
    if(await page.evaluate(()=>(window as any).fxProof.settings.volumes))throw new Error("Blackout toggle failed")
    await page.getByRole("button",{name:"All On",exact:true}).click()
    if(!await page.evaluate(()=>(window as any).fxProof.settings.volumes))throw new Error("Blackout preset failed")
    results.controls={select:true,slider:true,play:true,loop:true,retrigger:true,copy:copied,backquote:true,urlUnchanged:true,presetsPreserveSelect:true,blackoutToggle:true}
  }
  if(!smokeOnly&&!labOnly){
    const blackout=await fixture("blackout");fixtures.push(blackout)
    await page.goto(`${blackout.url}/envlab.html?fxproof&bench&seed=1&x=15&y=15&zoom=30&lab=1`)
    await page.waitForFunction(()=>(window as any).fxProof)
    const floors=await page.evaluate(()=>(window as any).fxProof.map.floors)
    results.floors=floors
    console.log("Floors",JSON.stringify(floors).slice(0,2000))
    // Pick a room-sized floor with a clear centre, away from the map's boundary.
    const room=await page.evaluate(()=>{const f=(window as any).fxProof;for(const floor of f.map.floors){const r=floor.rect,w=r[2]-r[0],h=r[3]-r[1],x=(r[0]+r[2])/2,y=(r[1]+r[3])/2;if(w<5||w>14||h<5||h>14)continue;if(f.game.blockers.some((b:number[])=>x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3]))continue;return {x,y,rect:r}}throw new Error("No room")})
    results.room=room
    await page.evaluate(async({x,y})=>{(window as any).goto(x,y);const f=(window as any).fxProof;await f.step(0);f.explode(x,y);for(let i=0;i<48;i++)await f.step(1/30)},{x:room.x,y:room.y})
    for(const on of [false,true]){
      await page.getByRole("checkbox",{name:"Volume Smoke",exact:true}).setChecked(on)
      await page.evaluate(async on=>{await(window as any).fxProof.draw(on);await new Promise(requestAnimationFrame)},on)
      await page.screenshot({path:join(out,`blackout-${on?"new":"old"}.png`)})
    }
    results.volume=await page.evaluate(()=>{const v=(window as any).fxProof.game.smokeVolumes;return {count:v.count,nonzero:Array.from(v.density as Uint8Array).filter(v=>v>0).length}})
    // Isolate volume cost: hold the old sprite switch OFF throughout; toggle only the new renderer.
    results.pairs=[]
    for(let pair=-1;pair<9;pair++){
      const members:any={}
      for(const on of pair%2===0?[true,false]:[false,true]){
        members[on?"on":"off"]=await page.evaluate(async on=>{const f=(window as any).fxProof;f.renderer.smokeRenderer.enabled=on;const samples:number[]=[];for(let i=0;i<8;i++)samples.push(await f.draw(true,true));return samples},on)
      }
      if(pair>=0)results.pairs.push({pair,...members,delta:median(members.on)-median(members.off)})
    }
    results.medianDeltaMs=median(results.pairs.map((p:any)=>p.delta));results.madMs=median(results.pairs.map((p:any)=>Math.abs(p.delta-results.medianDeltaMs)))
    console.log("Volume delta",results.medianDeltaMs,"MAD",results.madMs)
    await page.evaluate(async()=>{const f=(window as any).fxProof;f.renderer.smokeRenderer.enabled=true;f.game.smokeVolumes.carve(0,0,100,100,1);await f.draw(true)})
    if(errors.length)throw new Error("GPU errors in Blackout")
    await page.goto(`${blackout.url}/envlab.html?kind=downtown&fxproof&bench&seed=1&light=0&lkind=fire&zoom=30`)
    await page.waitForFunction(()=>(window as any).fxProof)
    results.wreck=await page.evaluate(async()=>{const f=(window as any).fxProof;for(let i=0;i<75;i++)await f.step(1/30);await f.draw(true);return {count:f.game.smokeVolumes.count,nonzero:Array.from(f.game.smokeVolumes.density as Uint8Array).filter(v=>v>0).length}})
    if(!results.wreck.count||!results.wreck.nonzero)throw new Error("Wreck failed to emit a volume")
    await page.screenshot({path:join(out,"blackout-wreck.png")})
    const poses:any[]=[]
    for(const before of [true,false]){
      const target=before?await fixture("getaway",true):getaway;if(before)fixtures.push(target)
      await page.goto(`${target.url}/?solo&peaceful=1&seed=7&bench&nohud&smoke=6`)
      await page.waitForFunction(()=>(window as any).__getawayBench)
      await page.evaluate(async()=>{const b=(window as any).__getawayBench;await b.ready;b.emissionStudy("drift");b.smoke(6,true);b.distance(38);b.reset(true)})
      let pose:any
      for(let i=0;i<=64;i++)pose=await page.evaluate(async i=>(window as any).__getawayBench.step(i,1/30,true),i)
      poses.push(pose)
      await page.screenshot({path:join(out,`getaway-${before?"before":"after"}.png`)})
    }
    results.tyrePoses=poses
    if(JSON.stringify(poses[0].pose)!==JSON.stringify(poses[1].pose))throw new Error("Tyre pose mismatch")
  }
  results.errors=errors
  writeFileSync(join(out,labOnly?"lab-proof.json":"proof.json"),JSON.stringify(results,null,2))
  if(errors.length)throw new Error(`${errors.length} browser errors`)
}finally{await browser.close();for(const f of fixtures)await f.server.close()}
