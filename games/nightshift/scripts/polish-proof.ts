/** Deterministic, muted Metal readback; original Foley rendered offline from the actual tape. */
import { chromium } from "playwright-core"
import { mkdir,readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { WalkCamera } from "../src/walk-camera"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { Settings } from "../src/settings"
import type { FoleyFrame,renderFoley } from "../src/foley"
import type { Call } from "../shared/call"
import type { OfficePhysics } from "../src/polish/props"
import type { Continuity } from "../src/polish/continuity"
import type { tubeSignal } from "../src/polish/tube"
type App={camera:WalkCamera;renderer:Renderer;settings:Settings;call:Call;renderFoley:typeof renderFoley;physics:OfficePhysics;continuity:Continuity;tubeSignal:typeof tubeSignal;clock:number;time:number;action():void;setCamera(view:"wide"|"phone"):void}
type Proof={nightshift:App;step(capture:boolean,label:string,measure?:boolean):Promise<{png:string;ms:number}>}
const out=resolve(process.env.POLISH_OUT??"captures/nightshift-polish"),boot=process.argv.includes("--boot"),perfOnly=process.argv.includes("--perf")
await mkdir(out,{recursive:true})
const build=Bun.spawn(["bun","run","build"],{cwd:resolve(import.meta.dir,".."),stdout:"inherit",stderr:"inherit"})
if(await build.exited!==0)throw Error("Build failed")
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname,f=Bun.file(`${import.meta.dir}/../dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],tape:FoleyFrame[]=[],trace:unknown[]=[]
let encoder:ReturnType<typeof Bun.spawn>|undefined
try{
  const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
  await page.addInitScript(()=>{
    let callbacks:FrameRequestCallback[]=[],clock=0,configured=false,readback:GPUBuffer|undefined
    let query:GPUQuerySet|undefined,resolved:GPUBuffer|undefined,timestamps:GPUBuffer|undefined
    const canvas2d=document.createElement("canvas");canvas2d.width=1280;canvas2d.height=720;const paint=canvas2d.getContext("2d")!
    window.requestAnimationFrame=f=>{callbacks.push(f);return callbacks.length};performance.now=()=>clock
    Object.assign(window,{step:async(capture:boolean,label:string,measure=false)=>{
      const a=(window as unknown as Proof).nightshift,canvas=document.querySelector<HTMLCanvasElement>("#view")!,ctx=canvas.getContext("webgpu")!,device=a.renderer.passContext.device,format=navigator.gpu.getPreferredCanvasFormat()
      if(!configured){ctx.configure({device,format,alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});configured=true}
      let texture:GPUTexture|undefined;const get=ctx.getCurrentTexture.bind(ctx),create=device.createCommandEncoder.bind(device)
      ctx.getCurrentTexture=()=>texture??=get()
      if(measure){
        if(!device.features.has("timestamp-query"))throw Error("GPU timestamps unavailable")
        query??=device.createQuerySet({type:"timestamp",count:2})
        resolved??=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC})
        timestamps??=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
        let started=false
        // Include the separate spot-shadow submission as well as the renderer.
        device.createCommandEncoder=(descriptor)=>{
          const enc=create(descriptor),render=enc.beginRenderPass.bind(enc),compute=enc.beginComputePass.bind(enc)
          enc.beginRenderPass=d=>{const stamp=!started;started=true;return render(stamp?{...d,timestampWrites:{querySet:query!,beginningOfPassWriteIndex:0}}:d)}
          enc.beginComputePass=(d={})=>{const stamp=!started;started=true;return compute(stamp?{...d,timestampWrites:{querySet:query!,beginningOfPassWriteIndex:0}}:d)}
          return enc
        }
      }
      clock+=1000/60;const pending=callbacks;callbacks=[];for(const f of pending)f(clock)
      await Promise.resolve();ctx.getCurrentTexture=get;device.createCommandEncoder=create
      if(!texture)throw Error("No rendered texture")
      let ms=0
      if(measure){
        const enc=create();enc.beginRenderPass({timestampWrites:{querySet:query!,endOfPassWriteIndex:1},colorAttachments:[{view:texture.createView(),loadOp:"load",storeOp:"store"}]}).end()
        enc.resolveQuerySet(query!,0,2,resolved!,0);enc.copyBufferToBuffer(resolved!,0,timestamps!,0,16);device.queue.submit([enc.finish()])
        await timestamps!.mapAsync(GPUMapMode.READ);const t=new BigUint64Array(timestamps!.getMappedRange());ms=Number(t[1]-t[0])/1e6;timestamps!.unmap()
        if(!(ms>0&&ms<1000))throw Error(`Invalid GPU interval ${ms}`)
      }
      if(!capture){await device.queue.onSubmittedWorkDone();return {png:"",ms}}
      readback??=device.createBuffer({size:1280*720*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      const enc=create();enc.copyTextureToBuffer({texture},{buffer:readback,bytesPerRow:5120},[1280,720]);device.queue.submit([enc.finish()])
      await readback.mapAsync(GPUMapMode.READ);const rgba=new Uint8ClampedArray(readback.getMappedRange().slice(0));readback.unmap()
      if(format.startsWith("bgra"))for(let i=0;i<rgba.length;i+=4){const b=rgba[i];rgba[i]=rgba[i+2];rgba[i+2]=b}
      paint.putImageData(new ImageData(rgba,1280,720),0,0)
      if(label){paint.fillStyle="#000b";paint.fillRect(20,20,880,45);paint.font="20px sans-serif";paint.fillStyle="#e9eee9";paint.fillText(label,34,49)}
      return {png:canvas2d.toDataURL("image/png").split(",")[1],ms}
    }})
  })
  await page.goto(`${server.url}arcade/nightshift/`)
  await page.waitForFunction(()=>Boolean((window as unknown as Proof).nightshift),undefined,{polling:100,timeout:90000})
  for(let i=0;i<45;i++)await page.evaluate(()=>(window as unknown as Proof).step(false,""))
  if(errors.length)throw Error(errors.join("\n"))
  const adapter=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return a?{...a.info,description:a.info.description,vendor:a.info.vendor,architecture:a.info.architecture}:null})
  if(boot){
    const image=await page.evaluate(()=>(window as unknown as Proof).step(true,""));await Bun.write(resolve(out,"polish-wide.png"),Buffer.from(image.png,"base64"))
    console.log(JSON.stringify({boot:true,adapter,errors}));
  }else{
    const samples:{polish:number;ms:number}[]=[]
    for(const polish of [0,1,1,0]){
      await page.evaluate(polish=>{const a=(window as unknown as Proof).nightshift;a.settings.polish=polish;a.time=4},polish)
      for(let i=0;i<12;i++)await page.evaluate(()=>(window as unknown as Proof).step(false,""))
      for(let i=0;i<24;i++){const r=await page.evaluate(()=>(window as unknown as Proof).step(false,"",true));samples.push({polish,ms:r.ms})}
    }
    const median=(p:number)=>{const a=samples.filter(s=>s.polish===p).map(s=>s.ms).sort((a,b)=>a-b);return (a[23]+a[24])/2}
    await Bun.write(resolve(out,"gpu.json"),JSON.stringify({adapter,resolution:[1280,720],method:"ABBA, 48 samples each; whole-frame GPU timestamps including spot shadows",today:median(0),polished:median(1),delta:median(1)-median(0),samples},null,2))
    if(!perfOnly){
      await page.locator("#view").click({force:true});await page.waitForFunction(()=>document.pointerLockElement?.id==="view",undefined,{polling:100})
      await page.evaluate(()=>{const a=(window as unknown as Proof).nightshift;a.settings.polish=1;a.camera.resetWalk();a.call.phase="ended";a.time=0})
      const ffmpeg=Bun.spawn(["ffmpeg","-v","error","-y","-f","image2pipe","-framerate","30","-i","-","-an","-c:v","libx264","-threads","2","-preset","fast","-crf","20","-pix_fmt","yuv420p",resolve(out,"polish-silent.mp4")],{stdin:"pipe",stdout:"inherit",stderr:"inherit"});encoder=ffmpeg
      for(let i=0;i<24*60;i++){
        if([60,240,360,420,600].includes(i))await page.keyboard.up("w")
        const result=await page.evaluate(async i=>{
          const w=window as unknown as Proof,a=w.nightshift,c=a.camera
          a.time=i/60+(i>=1320?90:0)
          if(i===0){c.release();c.body.x=-1.5;c.body.y=2.8;c.yaw=.9;c.pitch=-.1}
          if(i<360)c.yaw=.9-.6*i/360
          if(i===360){c.release();c.body.x=.4;c.body.y=-3.6;c.yaw=0;c.pitch=-.45}
          if(i===600){c.release();a.setCamera("phone");a.call.phase="ringing";a.action()}
          if(i>=660&&i<780)c.yaw+=.003
          if(i===780)a.action()
          if(i===960){c.release();c.body.x=-.1;c.body.y=1.7;c.yaw=0;c.pitch=.35}
          if(i>=960&&i<1200)c.yaw=-.3+.6*(i-960)/240
          if(i===1200){c.release();c.body.x=.2;c.body.y=5.2;c.yaw=-.8;c.pitch=-.3}
          if(i===1260)c.yaw=Math.PI
          if(i===1380)c.yaw=-.8
          const label=i<360?"Shadowed dust and walking wake":i<600?"Caster roll, swivel and paper settling":i<960?"Receiver cord: momentum, then rest":i<1200?"One seeded signal: tube, light and ballast":i<1320?"Look away: continuity waits until unseen":"90 seconds skipped while looking away; seeded continuity"
          const r=await w.step(i%2===0,label),m=c.walk,signal=a.tubeSignal(a.clock,a.settings.flicker)
          return {...r,room:{time:i/60,x:c.body.x,z:c.body.y,yaw:c.yaw,volume:a.settings.volume,active:true,tube:signal.level,ballast:signal,crackle:a.settings.tubeCrackle,foley:a.settings.foley,room:a.settings.roomTone},events:m.events.map(e=>({...e,time:i/60+e.time-m.time})),trace:{frame:i,time:a.clock,tube:signal,chair:a.physics.chairs.map(c=>({x:c.x,z:c.z,yaw:c.yaw,vx:c.vx,vz:c.vz,spin:c.spin})),cord:[...a.physics.swing],paper:a.physics.paper,continuity:a.continuity.events}}
        },i)
        if([60,360].includes(i))await page.keyboard.down("w")
        tape.push({room:result.room,events:result.events});trace.push(result.trace)
        if(result.png){const bytes=Buffer.from(result.png,"base64");ffmpeg.stdin.write(bytes);await ffmpeg.stdin.flush();if([180,690].includes(i))await Bun.write(resolve(out,`polish-${i}.png`),bytes)}
        if(errors.length)throw Error(errors.join("\n"))
      }
      ffmpeg.stdin.end();if(await ffmpeg.exited!==0)throw Error("Encoding failed");encoder=undefined
      const wav=await page.evaluate(async tape=>{const bytes=await (window as unknown as Proof).nightshift.renderFoley(tape,24),chunks=[];for(let i=0;i<bytes.length;i+=16384)chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));return btoa(chunks.join(""))},tape)
      await Bun.write(resolve(out,"polish.wav"),Buffer.from(wav,"base64"))
      const mux=Bun.spawn(["ffmpeg","-v","error","-y","-i",resolve(out,"polish-silent.mp4"),"-i",resolve(out,"polish.wav"),"-map","0:v","-map","1:a","-c:v","copy","-c:a","aac","-b:a","160k","-movflags","+faststart",resolve(out,"polish-showcase.mp4")],{stdout:"inherit",stderr:"inherit"})
      if(await mux.exited!==0)throw Error("Mux failed")
      await Bun.write(resolve(out,"render-trace.json"),JSON.stringify({errors,fps:60,trace,tape}))
    }
    if(errors.length)throw Error(errors.join("\n"))
    console.log(JSON.stringify({out,adapter,today:median(0),polished:median(1),delta:median(1)-median(0),frames:trace.length,errors}))
  }
}finally{if(encoder){encoder.kill();await encoder.exited}await browser.close();server.stop(true)}
