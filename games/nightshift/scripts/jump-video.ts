/**
 * The jump (playtest Oct 21, 03:16: "I can't jump"): real Space presses in headless Chromium (muted, no window), 60 Hz
 * GPU readback at 30 fps, and the offline Foley mix of the actual contacts muxed in (no speaker playback).
 *
 *   bun run build && bun scripts/jump-video.ts
 */
import {chromium} from "playwright-core"
import {mkdir,readdir} from "node:fs/promises"
import {existsSync} from "node:fs"
import {resolve} from "node:path"
import type {WalkCamera} from "../src/walk-camera"
import type {Renderer} from "@arcade/kit/gpu/renderer"
import type {Settings} from "../src/settings"
import type {FoleyFrame,renderFoley} from "../src/foley"
import type {Call} from "../shared/call"
type App={camera:WalkCamera;renderer:Renderer;settings:Settings;call:Call;renderFoley:typeof renderFoley;setCamera(view:"wide"|"phone"):void}
type WindowProof={nightshift:App;step(capture:boolean,label:string):Promise<string>}
const out=resolve(process.env.NIGHTSHIFT_JUMP_DIR??"captures/nightshift-jump")
await mkdir(out,{recursive:true})
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname;const f=Bun.file(`${import.meta.dir}/../dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],tape:FoleyFrame[]=[],trace:unknown[]=[]
try{
  const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
  await page.addInitScript(()=>{
    let callbacks:FrameRequestCallback[]=[],clock=0,configured=false,readback:GPUBuffer|undefined
    const canvas2d=document.createElement("canvas");canvas2d.width=1280;canvas2d.height=720;const paint=canvas2d.getContext("2d")!
    window.requestAnimationFrame=f=>{callbacks.push(f);return callbacks.length};performance.now=()=>clock
    Object.assign(window,{step:async(capture:boolean,label:string)=>{
      const a=(window as unknown as WindowProof).nightshift,canvas=document.querySelector<HTMLCanvasElement>("#view")!,ctx=canvas.getContext("webgpu")!,device=a.renderer.passContext.device,format=navigator.gpu.getPreferredCanvasFormat()
      if(!configured){ctx.configure({device,format,alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});configured=true}
      let texture:GPUTexture|undefined;const get=ctx.getCurrentTexture.bind(ctx);ctx.getCurrentTexture=()=>texture??=get()
      clock+=1000/60;const pending=callbacks;callbacks=[];for(const f of pending)f(clock)
      await Promise.resolve();ctx.getCurrentTexture=get
      if(!capture){await device.queue.onSubmittedWorkDone();return ""}
      if(!texture)throw Error("No video texture")
      readback??=device.createBuffer({size:1280*720*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer:readback,bytesPerRow:5120},[1280,720]);device.queue.submit([enc.finish()])
      await readback.mapAsync(GPUMapMode.READ);const rgba=new Uint8ClampedArray(readback.getMappedRange().slice(0));readback.unmap()
      if(format.startsWith("bgra"))for(let i=0;i<rgba.length;i+=4){const b=rgba[i];rgba[i]=rgba[i+2];rgba[i+2]=b}
      paint.putImageData(new ImageData(rgba,1280,720),0,0);paint.fillStyle="#0009";paint.fillRect(20,20,610,45);paint.font="20px sans-serif";paint.fillStyle="#e9eee9";paint.fillText(label,34,49)
      return canvas2d.toDataURL("image/png").split(",")[1]
    }})
  })
  await page.goto(`${server.url}arcade/nightshift/`)
  await page.waitForFunction(()=>Boolean((window as unknown as WindowProof).nightshift),undefined,{polling:100,timeout:90000})
  for(let i=0;i<30;i++)await page.evaluate(()=>(window as unknown as WindowProof).step(false,""))
  await page.locator("#view").click({force:true});await page.waitForFunction(()=>document.pointerLockElement?.id==="view",undefined,{polling:100})
  await page.evaluate(()=>{const a=(window as unknown as WindowProof).nightshift;a.setCamera("wide");a.camera.resetWalk();a.call.phase="ended";a.settings.reduceMotion=false;a.settings.flicker=0;a.settings.dust=0})
  const encoder=Bun.spawn(["ffmpeg","-v","error","-y","-f","image2pipe","-framerate","30","-i","-","-an","-c:v","libx264","-threads","2","-preset","fast","-crf","20","-pix_fmt","yuv420p",resolve(out,"jump-silent.mp4")],{stdin:"pipe",stdout:"inherit",stderr:"inherit"})
  // Real keys: walk, jump while walking, stop, jump in place, then the same with Reduce camera motion.
  const keys:Record<number,()=>Promise<void>>={
    30:()=>page.keyboard.down("w"),75:()=>page.keyboard.press("Space"),150:()=>page.keyboard.up("w"),
    200:()=>page.keyboard.press("Space"),290:()=>page.keyboard.press("Space"),
    400:()=>page.keyboard.press("Space"),
  }
  for(let i=0;i<8*60;i++){
    await keys[i]?.()
    const result=await page.evaluate(async i=>{
      const w=window as unknown as WindowProof,a=w.nightshift,c=a.camera
      if(i===0){c.release();c.body.x=-.15;c.body.y=2.25;c.yaw=.12;c.pitch=-.1}
      if(i===360){c.release();a.settings.reduceMotion=true}
      const label=i<180?"Space while walking · 0.3 m hop, landing dip, soft two-foot landing":i<360?"Space standing still":"Reduce camera motion · same hop and landing sound, no dip"
      const png=await w.step(i%2===0,label),m=c.walk
      return {png,room:{time:m.time,x:c.body.x,z:c.body.y,yaw:c.yaw,volume:a.settings.volume,active:true,tube:1,foley:a.settings.foley,room:a.settings.roomTone},events:m.events,trace:{frame:i,time:m.time,body:[c.body.x,c.body.y],eyeY:c.eye[1],air:{...c.air},events:m.events.map(e=>e.kind)}}
    },i)
    tape.push({room:result.room,events:result.events});trace.push(result.trace)
    if(result.png){const bytes=Buffer.from(result.png,"base64");encoder.stdin.write(bytes);await encoder.stdin.flush();if([84,220,420].includes(i))await Bun.write(resolve(out,`jump-${i}.png`),bytes)}
  }
  encoder.stdin.end();if(await encoder.exited!==0)throw Error("Video encoding failed")
  const wav=await page.evaluate(async tape=>{
    const bytes=await (window as unknown as WindowProof).nightshift.renderFoley(tape,8),chunks=[]
    for(let i=0;i<bytes.length;i+=16384)chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)))
    return btoa(chunks.join(""))
  },tape)
  await Bun.write(resolve(out,"jump.wav"),Buffer.from(wav,"base64"))
  const mux=Bun.spawn(["ffmpeg","-v","error","-y","-i",resolve(out,"jump-silent.mp4"),"-i",resolve(out,"jump.wav"),"-map","0:v","-map","1:a","-c:v","copy","-c:a","aac","-b:a","160k","-movflags","+faststart",resolve(out,"jump.mp4")],{stdout:"inherit",stderr:"inherit"})
  if(await mux.exited!==0)throw Error("Mux failed")
  await Bun.write(resolve(out,"input-trace.json"),JSON.stringify({errors,fps:60,trace,tape},null,2))
  if(errors.length)throw Error(errors.join("\n"))
  console.log(JSON.stringify({out,frames:trace.length,events:tape.flatMap(t=>t.events).reduce((a,e)=>({...a,[e.kind]:(a[e.kind]??0)+1}),{} as Record<string,number>),errors}))
}finally{await browser.close();server.stop(true)}
