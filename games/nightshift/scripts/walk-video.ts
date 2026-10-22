import {chromium} from "playwright-core"
import {mkdir,readdir} from "node:fs/promises"
import {existsSync} from "node:fs"
import {resolve} from "node:path"
import type {WalkCamera} from "../src/walk-camera"
import type {Renderer} from "@arcade/kit/gpu/renderer"
import type {Settings} from "../src/settings"
import type {FoleyFrame,renderFoley} from "../src/foley"
import type {Call} from "../shared/call"
type App={camera:WalkCamera;renderer:Renderer;settings:Settings;call:Call;renderFoley:typeof renderFoley}
type WindowProof={nightshift:App;step(capture:boolean,label:string):Promise<string>}
const out=resolve(process.env.NIGHTSHIFT_WALK_DIR??"captures/nightshift-walk")
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
  await page.evaluate(()=>{const a=(window as unknown as WindowProof).nightshift;a.camera.resetWalk();a.call.phase="ended";a.settings.reduceMotion=false;a.settings.flicker=0;a.settings.dust=0})
  const encoder=Bun.spawn(["ffmpeg","-v","error","-y","-f","image2pipe","-framerate","30","-i","-","-an","-c:v","libx264","-threads","2","-preset","fast","-crf","20","-pix_fmt","yuv420p",resolve(out,"walk-silent.mp4")],{stdin:"pipe",stdout:"inherit",stderr:"inherit"})
  for(let i=0;i<16*60;i++){
    if([60,300,360,420,480,540,570,600,780,900].includes(i)){
      await page.keyboard.up("w");await page.keyboard.up("s")
      if([60,360,480,780].includes(i))await page.keyboard.down("w")
      if(i===570)await page.keyboard.down("s")
    }
    const result=await page.evaluate(async i=>{
      const w=window as unknown as WindowProof,a=w.nightshift,c=a.camera
      if(i===360)a.settings.speed=.65
      if(i===420)a.settings.speed=1.7
      if(i===480){c.release();c.body.x=.65;c.body.y=-3.5;c.yaw=0;c.pitch=-.15}
      if(i===660){c.release();c.body.x=.1;c.body.y=4.9;c.yaw=-.75;c.pitch=-.32}
      if(i===780){c.release();c.body.x=-.15;c.body.y=2.25;c.yaw=.12;c.pitch=-.12;a.settings.reduceMotion=true}
      if(i>=330&&i<420)c.yaw=.18*Math.sin((i-330)/90*Math.PI*2)
      if(i>=660&&i<780)c.yaw=-.75+.15*Math.sin((i-660)/120*Math.PI*2)
      const label=i<300?"Carpet footsteps + cloth · distance-synchronized":i<480?"Stop, slow walk + turn · 0.3 s, zero bounce":i<660?"Chair contact · no footsteps while blocked":i<780?"Grounded trays and boxes · room tone": "Reduce camera motion · footsteps retained"
      const png=await w.step(i%2===0,label),m=c.walk
      return {png,room:{time:m.time,x:c.body.x,z:c.body.y,yaw:c.yaw,volume:a.settings.volume,active:true,tube:1,foley:a.settings.foley,room:a.settings.roomTone},events:m.events,trace:{frame:i,time:m.time,body:[c.body.x,c.body.y],eye:[...c.eye],yaw:c.yaw,pitch:c.pitch,phase:m.phase,speed:m.speed,offset:[m.lateral,m.vertical,m.roll],reduced:a.settings.reduceMotion,events:m.events}}
    },i)
    // A release at a cut clears held input: send the real key again on the next frame.
    if(i===480||i===780)await page.keyboard.down("w")
    tape.push({room:result.room,events:result.events});trace.push(result.trace)
    if(result.png){const bytes=Buffer.from(result.png,"base64");encoder.stdin.write(bytes);await encoder.stdin.flush();if([240,540,720,900].includes(i))await Bun.write(resolve(out,`frame-${i}.png`),bytes)}
  }
  encoder.stdin.end();if(await encoder.exited!==0)throw Error("Video encoding failed")
  const wav=await page.evaluate(async tape=>{
    const bytes=await (window as unknown as WindowProof).nightshift.renderFoley(tape,16),chunks=[]
    for(let i=0;i<bytes.length;i+=16384)chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)))
    return btoa(chunks.join(""))
  },tape)
  await Bun.write(resolve(out,"walk.wav"),Buffer.from(wav,"base64"))
  const mux=Bun.spawn(["ffmpeg","-v","error","-y","-i",resolve(out,"walk-silent.mp4"),"-i",resolve(out,"walk.wav"),"-map","0:v","-map","1:a","-c:v","copy","-c:a","aac","-b:a","160k","-movflags","+faststart",resolve(out,"walk.mp4")],{stdout:"inherit",stderr:"inherit"})
  if(await mux.exited!==0)throw Error("Mux failed")
  await Bun.write(resolve(out,"input-trace.json"),JSON.stringify({errors,fps:60,cuts:[480,660,780],trace,tape},null,2))
  if(errors.length)throw Error(errors.join("\n"))
  console.log(JSON.stringify({out,frames:trace.length,events:tape.flatMap(t=>t.events).reduce((a,e)=>({...a,[e.kind]:(a[e.kind]??0)+1}),{} as Record<string,number>),errors}))
}finally{await browser.close();server.stop(true)}
