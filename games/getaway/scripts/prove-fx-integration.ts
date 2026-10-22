/// <reference types="@webgpu/types" />
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer, type ViteDevServer } from "vite"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { installGpuInstrumentation } from "../../blackout/scripts/compare"

await using budget = browserBudget()
const { chromium } = budget

const root=resolve(import.meta.dir,"../../.."),out=join(root,"captures/fx-integration")
mkdirSync(out,{recursive:true})
const servers:ViteDevServer[]=[],errors:string[]=[],report:any={}
const fixture=async(game:string,baseline=false)=>{
  const dir=join(root,"games",game),server=await createServer({root:dir,configFile:join(dir,"vite.config.ts"),
    plugins:baseline?[{name:"shipped-tyre-baseline",enforce:"pre",load(id){
      if(id===join(dir,"src/render/smoke.ts"))return readFileSync(join(root,"perf/fx-baseline/smoke.txt"),"utf8")
      if(id===join(dir,"src/game/smoke-trail.ts"))return readFileSync(join(root,"perf/fx-baseline/trail.txt"),"utf8")
    }}]:[],server:{host:"127.0.0.1",port:0}})
  servers.push(server);await server.listen();const a=server.httpServer!.address()
  if(!a||typeof a==="string")throw Error("No fixture port")
  return `http://localhost:${a.port}`
}
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio","--disable-dawn-features=timestamp_quantization"]})
try{
  const page=await browser.newPage({viewport:{width:960,height:640}})
  page.on("pageerror",e=>{errors.push(e.message);console.error(e.message)})
  page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("404")){errors.push(m.text());console.error(m.text())}})
  const pictures:Buffer[]=[],poses:unknown[]=[]
  for(const baseline of [true,false]){
    const url=await fixture("getaway",baseline)
    await page.goto(`${url}/?solo&peaceful=1&seed=7&bench&nohud`)
    await page.waitForFunction(()=>(window as any).__getawayBench)
    await page.evaluate(async()=>{
      const b=(window as any).__getawayBench;await b.ready
      const path="/src/render/motion.ts",{motionBlur}=await import(/* @vite-ignore */path);motionBlur.enabled=false
      b.emissionStudy("drift");b.distance(38);b.reset(true)
    })
    poses.push(await page.evaluate(async()=>{const b=(window as any).__getawayBench;let frame:any;for(let i=0;i<=64;i++)frame=await b.step(i,1/30,true);return {pose:frame.pose,adapter:b.adapterInfo}}))
    pictures.push(await page.screenshot({path:join(out,`tyre-${baseline?"main":"shared"}.png`)}))
  }
  if(!pictures[0]!.equals(pictures[1]!))throw Error("Shared tyre smoke differs from shipped main")
  if(JSON.stringify(poses[0])!==JSON.stringify(poses[1]))throw Error("Tyre pose mismatch")
  report.tyre={byteIdentical:true,poses}
  const blackout=await fixture("blackout")
  await page.goto(`${blackout}/envlab.html?fxproof&bench&seed=1&lab=1`)
  await page.waitForFunction(()=>(window as any).fxProof)
  report.volume=await page.evaluate(async()=>{
    const f=(window as any).fxProof
    if(!f.adapter.architecture.includes("metal"))throw Error("Metal required")
    if(!f.settings.volumes)throw Error("Shared smoke must default on")
    const floor=f.map.floors.find((f:any)=>f.rect[2]-f.rect[0]>5&&f.rect[3]-f.rect[1]>5).rect
    const x=(floor[0]+floor[2])/2,y=(floor[1]+floor[3])/2
    ;(window as any).goto(x,y);f.explode(x,y)
    for(let i=0;i<48;i++)await f.step(1/30)
    await f.draw(true)
    return {count:f.game.smokeVolumes.count,cells:Array.from(f.game.smokeVolumes.density as Uint8Array).filter(x=>x>0).length}
  })
  if(!report.volume.count||!report.volume.cells)throw Error("Grenade did not fill volume")
  await page.keyboard.press("Backquote")
  for(const on of [false,true]){await page.evaluate(async on=>await(window as any).fxProof.draw(on),on);await page.screenshot({path:join(out,`blackout-volume-${on?"on":"off"}.png`)})}
  await installGpuInstrumentation(page)
  await page.goto(`${blackout}/?sandbox=1&seed=4&manualVideo=1`)
  await page.waitForFunction(()=>(window as any).__stepManualVideo)
  report.blackout=await page.evaluate(async()=>{
    const w=window as any,path="/src/render/renderer.ts",{Renderer}=await import(/* @vite-ignore */path)
    const render=Renderer.prototype.render
    Renderer.prototype.render=function(f:any){w.frame=f;w.renderer=this;render.call(this,f)}
    for(let i=0;i<30;i++){await w.__stepManualVideo(1000/60);if(w.renderer)await w.renderer.device.queue.onSubmittedWorkDone()}
    return {parts:w.frame.batches.reduce((n:number,b:any)=>n+b.count,0)}
  })
  await page.keyboard.press("Backquote")
  await page.getByRole("checkbox",{name:"Motion Blur",exact:true}).check()
  await page.getByRole("slider",{name:"Shutter",exact:true}).evaluate(el=>{(el as HTMLInputElement).value=".8";el.dispatchEvent(new Event("input",{bubbles:true}))})
  await page.keyboard.press("Backquote")
  await page.mouse.move(700,320);await page.mouse.down();await page.keyboard.down("d")
  report.blackout.motion=await page.evaluate(async()=>{const w=window as any;let keys=0;for(let i=0;i<24;i++){await w.__stepManualVideo(1000/60);await w.renderer.device.queue.onSubmittedWorkDone();keys=Math.max(keys,w.frame.addMotionKeys.filter(Boolean).length)}return {keys,exposure:w.renderer.motionData[16]}})
  await page.keyboard.up("d");await page.mouse.up()
  if(!report.blackout.motion.keys||!report.blackout.motion.exposure)throw Error("Live motion missing")
  await page.screenshot({path:join(out,"blackout-motion.png")})
  report.errors=errors
  if(errors.length)throw Error(errors.join("\n"))
  writeFileSync(join(out,"proof.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}finally{await browser.close();for(const server of servers)await server.close()}
