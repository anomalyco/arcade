import { chromium } from "playwright-core"
import { mkdir,readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { FirstPerson } from "@arcade/kit/client/first-person"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { Call } from "../shared/call"

const out=resolve(process.env.NIGHTSHIFT_VIDEO_DIR??"captures/nightshift-call")
await mkdir(out,{recursive:true})
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname;const f=Bun.file(`${import.meta.dir}/../dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
type App={camera:FirstPerson;renderer:Renderer;call:Call;setCamera(view:"phone"):void}
const errors:string[]=[],trace:{frame:number;phase:string;elapsed:number;lift:number;subtitle:string}[]=[]
try {
  const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message))
  page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
  await page.addInitScript(()=>{
    let callbacks:FrameRequestCallback[]=[],clock=0,configured=false,readback:GPUBuffer|undefined
    const composite=document.createElement("canvas");composite.width=1280;composite.height=720
    const paint=composite.getContext("2d")!
    window.requestAnimationFrame=f=>{callbacks.push(f);return callbacks.length};performance.now=()=>clock
    Object.assign(window,{step:async(capture=false)=>{
      const canvas=document.getElementById("view") as HTMLCanvasElement,ctx=canvas.getContext("webgpu")!
      const device=(window as unknown as {nightshift:App}).nightshift.renderer.passContext.device
      const format=navigator.gpu.getPreferredCanvasFormat()
      if(!configured){ctx.configure({device,format,alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});configured=true}
      let texture:GPUTexture|undefined
      const get=ctx.getCurrentTexture.bind(ctx)
      ctx.getCurrentTexture=()=>texture??=get()
      clock+=1000/24;const pending=callbacks;callbacks=[];for(const f of pending)f(clock)
      await Promise.resolve();ctx.getCurrentTexture=get
      if(!capture){await device.queue.onSubmittedWorkDone();return ""}
      if(!texture)throw new Error("Frame did not render")
      // Copy in the drawing task, before presentation destroys the swapchain
      // texture. This avoids compositor screenshots waiting on frozen RAF.
      readback??=device.createBuffer({size:1280*720*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      const enc=device.createCommandEncoder()
      enc.copyTextureToBuffer({texture},{buffer:readback,bytesPerRow:1280*4},[1280,720]);device.queue.submit([enc.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      const rgba=new Uint8ClampedArray(readback.getMappedRange().slice(0));readback.unmap()
      if(format.startsWith("bgra"))for(let i=0;i<rgba.length;i+=4){const b=rgba[i];rgba[i]=rgba[i+2];rgba[i+2]=b}
      paint.putImageData(new ImageData(rgba,1280,720),0,0)
      const subtitle=document.getElementById("subtitle")!,style=getComputedStyle(subtitle),rect=subtitle.getBoundingClientRect()
      paint.font=style.font;paint.fillStyle=style.color;paint.textAlign="center";paint.textBaseline="top";paint.shadowColor="#000";paint.shadowBlur=8
      paint.fillText(subtitle.textContent??"",640,rect.top)
      return composite.toDataURL("image/png").split(",")[1]
    }})
  })
  await page.goto(`${server.url}arcade/nightshift/`)
  await page.waitForFunction(()=>Boolean((window as unknown as {nightshift:App}).nightshift),undefined,{polling:100,timeout:90000})
  await page.evaluate(()=> (window as unknown as {nightshift:App}).nightshift.setCamera("phone"))
  for(let i=0;i<40;i++)await page.evaluate(()=> (window as unknown as {step():Promise<void>}).step())
  // Forced input skips Playwright's RAF-based stability wait; the game clock is
  // manually stepped here. This still sends a real pointer event and acquires lock.
  await page.locator("#view").click({force:true})
  await page.waitForFunction(()=>document.pointerLockElement?.id==="view",undefined,{polling:100})
  const encoder=Bun.spawn(["ffmpeg","-v","error","-y","-f","image2pipe","-framerate","24","-i","-","-an","-c:v","libx264","-threads","2","-preset","fast","-crf","20","-pix_fmt","yuv420p",resolve(out,"silent.mp4")],{stdin:"pipe",stdout:"inherit",stderr:"inherit"})
  for(let i=0;i<22*24;i++) {
    if(i===24||i===19*24)await page.keyboard.press("e")
    const state=await page.evaluate(async i=>{
      const w=window as unknown as {nightshift:App;step(capture?:boolean):Promise<string>},a=w.nightshift
      if(i>55&&i<19*24) {
        const settle=1-Math.max(0,Math.min(1,(i-17*24)/24))
        a.camera.pitch=-.95+.72*Math.min(1,(i-55)/48)*settle
        a.camera.yaw=-.3+.08*Math.sin((i-55)/90)*settle
      }
      const png=await Promise.race([w.step(true),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("GPU readback exceeded 15 seconds")),15000))])
      return {png,state:{frame:i,phase:a.call.phase,elapsed:a.call.elapsed,lift:a.call.lift,subtitle:document.getElementById("subtitle")!.textContent??""}}
    },i)
    trace.push(state.state)
    const png=Buffer.from(state.png,"base64")
    encoder.stdin.write(png);await encoder.stdin.flush()
    if(i===120)await Bun.write(resolve(out,"answering.png"),png)
    if(i===22*24-1)await Bun.write(resolve(out,"hangup.png"),png)
    if(i%120===0)console.log(`Answering frame ${i}/528: ${state.state.phase}`)
  }
  encoder.stdin.end();if(await encoder.exited!==0)throw new Error("Video encoding failed")
  const first=trace.find(f=>f.phase==="call")
  if(!first||trace.at(-1)?.phase!=="ended"||errors.length)throw new Error(JSON.stringify({errors,last:trace.at(-1)}))
  const offset=first.frame/24
  const mux=Bun.spawn(["ffmpeg","-v","error","-y","-i",resolve(out,"silent.mp4"),"-itsoffset",String(offset),"-i",resolve(import.meta.dir,"../public/audio/kit-call.mp3"),"-map","0:v","-map","1:a","-c:v","copy","-c:a","aac","-b:a","160k","-movflags","+faststart",resolve(out,"answering.mp4")],{stdout:"inherit",stderr:"inherit"})
  if(await mux.exited!==0)throw new Error("Audio mux failed")
  await Bun.write(resolve(out,"trace.json"),JSON.stringify({errors,audioOffset:offset,fps:24,trace},null,2))
  console.log(JSON.stringify({out,audioOffset:offset,frames:trace.length,errors}))
}finally{await browser.close();server.stop(true)}
