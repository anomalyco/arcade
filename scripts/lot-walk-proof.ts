import assert from "node:assert/strict"
import { mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "./browser-budget"
import { serveDist } from "../games/lot/scripts/serve-dist"
import type { WalkAudioFrame } from "../games/lot/src/walk-audio"

await using budget = browserBudget()
const { chromium } = budget

// One headless, muted actual-input tape; Today replays its exact body poses for the stacked comparison.
// Frames are encoded on a render worker afterwards, never on Studio's display.
const out=resolve(process.env.LOT_WALK_OUT??"captures/lot/walking")
const server=serveDist(resolve("games/lot/dist")),W=1280,H=720,seconds=9
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],tape:WalkAudioFrame[]=[],poses:{x:number;z:number;yaw:number;pitch:number}[]=[],trace:unknown[]=[]
try{
  for(const mode of ["after","today"]){
    mkdirSync(resolve(out,mode),{recursive:true})
    const page=await browser.newPage({viewport:{width:W,height:H},deviceScaleFactor:1})
    page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
    await page.addInitScript(()=>{
      const configure=GPUCanvasContext.prototype.configure
      GPUCanvasContext.prototype.configure=function(c){return configure.call(this,{...c,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC})}
    })
    await page.goto(`http://127.0.0.1:${server.port}/arcade/lot/?time=8`)
    await page.waitForFunction(()=>(window as any).lot?.frames>8,undefined,{timeout:600000,polling:100})
    await page.addStyleTag({content:"#hud,#credits,[data-lab-panel]{display:none!important}"})
    await page.evaluate(mode=>{
      const a=(window as any).lot;a.paused=true;a.walking.walkMode=mode==="today"?"today":"grounded";a.walking.reduceMotion=false
      a.camera.release();a.camera.body.x=-5;a.camera.body.y=102;a.camera.yaw=-.1;a.camera.pitch=-.08
      a.camera.resetWalk();a.renderer.resetTemporalHistory()
      for(let i=0;i<30;i++)a.step(1000/60)
      a.camera.resetWalk()
      const c=document.querySelector<HTMLCanvasElement>("#view")!,ctx=c.getContext("webgpu")!,d=a.renderer.passContext.device
      const row=Math.ceil(c.width*4/256)*256,buffer=d.createBuffer({size:row*c.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      const output=new OffscreenCanvas(c.width,c.height),g=output.getContext("2d")!
      ;(window as any).grab=async()=>{
        const texture=ctx.getCurrentTexture(),enc=d.createCommandEncoder()
        enc.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[c.width,c.height]);d.queue.submit([enc.finish()])
        await buffer.mapAsync(GPUMapMode.READ);const src=new Uint8Array(buffer.getMappedRange()),rgba=new Uint8ClampedArray(c.width*c.height*4)
        for(let y=0;y<c.height;y++)rgba.set(src.subarray(y*row,y*row+c.width*4),y*c.width*4)
        buffer.unmap()
        if(navigator.gpu.getPreferredCanvasFormat().startsWith("bgra"))for(let i=0;i<rgba.length;i+=4){const b=rgba[i]!;rgba[i]=rgba[i+2]!;rgba[i+2]=b}
        g.putImageData(new ImageData(rgba,c.width,c.height),0,0)
        const blob=await output.convertToBlob({type:"image/jpeg",quality:.91}),bytes=new Uint8Array(await blob.arrayBuffer()),chunks=[]
        for(let i=0;i<bytes.length;i+=16384)chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)))
        return btoa(chunks.join(""))
      }
    },mode)
    await page.locator("#view").click({force:true})
    await page.waitForFunction(()=>document.pointerLockElement?.id==="view",undefined,{polling:100})
    for(let i=0;i<seconds*60;i++){
      if(mode==="after"){
        if(i===0||i===180||i===360){
          await page.keyboard.up("KeyW");await page.keyboard.up("ShiftLeft")
          await page.evaluate(i=>{
            const a=(window as any).lot,c=a.camera;c.release()
            if(i===180){c.body.x=6;c.body.y=130;c.yaw=0;c.pitch=-.12}
            if(i===360){c.body.x=-5;c.body.y=120;c.yaw=.2;c.pitch=-.12}
            if(i>0)a.renderer.resetTemporalHistory()
          },i)
          await page.keyboard.down("KeyW")
        }
        if(i===60)await page.keyboard.down("ShiftLeft")
        if(i===96)await page.keyboard.up("ShiftLeft")
        if(i===138||i===318||i===510)await page.keyboard.up("KeyW")
      }
      const r=await page.evaluate(async({i,mode,pose})=>{
        const a=(window as any).lot,c=a.camera
        if(mode==="today"){c.body.x=pose!.x;c.body.y=pose!.z;c.body.vx=c.body.vy=0;c.yaw=pose!.yaw;c.pitch=pose!.pitch;if(i===180||i===360)a.renderer.resetTemporalHistory()}
        else {if(i>=138&&i<174)c.yaw+=.004;if(i===480)a.walking.reduceMotion=true}
        a.step(1000/60)
        const jpeg=i%2===0?await (window as any).grab():""
        if(!jpeg)await a.renderer.passContext.device.queue.onSubmittedWorkDone()
        return {jpeg,pose:{x:c.body.x,z:c.body.y,yaw:c.yaw,pitch:c.pitch},audio:a.audioFrame,trace:{frame:i,eye:[...c.eye],phase:c.walk.phase,offset:[c.walk.lateral,c.walk.vertical,c.walk.roll],speed:c.walk.speed,surface:a.audioFrame.surface}}
      },{i,mode,pose:poses[i]})
      if(mode==="after"){poses.push(r.pose);tape.push(r.audio);trace.push(r.trace)}
      if(r.jpeg)writeFileSync(resolve(out,mode,`${String(i/2).padStart(4,"0")}.jpg`),Buffer.from(r.jpeg,"base64"))
      if(i%120===0)console.log(`${mode} ${i}/${seconds*60}`)
      assert(errors.length===0,errors.join("\n"))
    }
    if(mode==="after"){
      const audio=await page.evaluate(async({tape,seconds})=>{
        const a=await (window as any).lot.renderWalkAudio(tape,seconds),chunks=[]
        for(let i=0;i<a.length;i+=16384)chunks.push(String.fromCharCode(...a.subarray(i,i+16384)))
        return btoa(chunks.join(""))
      },{tape,seconds})
      writeFileSync(resolve(out,"walking.wav"),Buffer.from(audio,"base64"))
    }
    await page.close()
  }
  const contacts=tape.flatMap(f=>f.events.filter(e=>e.kind==="step").map(e=>({surface:f.surface,time:e.time,gain:e.gain})))
  assert(contacts.length>10,"Real input did not produce walking contacts")
  assert(new Set(contacts.map(c=>c.surface)).size>=3,"Did not cross three authored surfaces")
  assert(tape.slice(480).some(f=>f.events.some(e=>e.kind==="step")),"Reduced motion silenced contacts")
  writeFileSync(resolve(out,"walking.json"),JSON.stringify({seconds,fps:30,cuts:[3,6],errors,contacts,trace,tape,poses},null,2))
  console.log(JSON.stringify({out,contacts,errors}))
}finally{await browser.close();server.stop()}
