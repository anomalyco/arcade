/**
 * Office look proof: the five fixed paint-over spots, each with Today and the new look, plus paired GPU timings.
 * Headless, muted Metal readback on a synthetic clock. `--perf` times only; `--set key=value,...` overrides the new
 * look's settings; `--variants today,look` picks what to capture; `--tier low|balanced|high` pins the quality tier.
 */
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdir,readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { WalkCamera } from "../src/walk-camera"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { Settings } from "../src/settings"
import type { Opening } from "../src/opening"
import type { Call } from "../shared/call"
import { LOOK_SPOTS } from "../src/look/spots"

await using budget = browserBudget()
const { chromium } = budget
type App={elevator:{phase:string;downstairs:boolean;closure:number};camera:WalkCamera;renderer:Renderer;settings:Settings;opening:Opening;call:Call;time:number;setCamera(view:"wide"|"phone"):void;lookReady():Promise<void>;quality:{pin(tier:string|null):void;state():unknown}}
type Proof={nightshift:App;step(capture:boolean,measure?:boolean):Promise<{png:string;ms:number}>}
const arg=(name:string)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined}
const out=resolve(process.env.LOOK_OUT??"captures/nightshift-look",arg("--label")??"run"),perfOnly=process.argv.includes("--perf")
const width=Number(arg("--width")??1280),height=Number(arg("--height")??720)
const overrides:Record<string,number>=Object.fromEntries((arg("--set")??"").split(",").filter(Boolean).map(kv=>{const [k,v]=kv.split("=");return [k,Number(v)]}))
const variants=(arg("--variants")??"today,look").split(",")
const spots=(arg("--spots")?.split(",")??LOOK_SPOTS.map(s=>s.id))
await mkdir(out,{recursive:true})
if(!process.argv.includes("--no-build")){
  const build=Bun.spawn(["bun","run","build"],{cwd:resolve(import.meta.dir,".."),stdout:"inherit",stderr:"inherit"})
  if(await build.exited!==0)throw Error("Build failed")
}
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname,f=Bun.file(`${import.meta.dir}/../dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[]
try{
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
  await page.addInitScript(([W,H])=>{
    let callbacks:FrameRequestCallback[]=[],clock=0,configured=false,readback:GPUBuffer|undefined
    let query:GPUQuerySet|undefined,resolved:GPUBuffer|undefined,timestamps:GPUBuffer|undefined
    const canvas2d=document.createElement("canvas");canvas2d.width=W;canvas2d.height=H;const paint=canvas2d.getContext("2d")!
    window.requestAnimationFrame=f=>{callbacks.push(f);return callbacks.length};performance.now=()=>clock
    Object.assign(window,{step:async(capture:boolean,measure=false)=>{
      const a=(window as unknown as Proof).nightshift,canvas=document.querySelector<HTMLCanvasElement>("#view")!,ctx=canvas.getContext("webgpu")!,device=a.renderer.passContext.device,format=navigator.gpu.getPreferredCanvasFormat()
      if(!configured){ctx.configure({device,format,alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});configured=true}
      let texture:GPUTexture|undefined;const get=ctx.getCurrentTexture.bind(ctx),create=device.createCommandEncoder.bind(device)
      ctx.getCurrentTexture=()=>texture??=get()
      if(measure){
        query??=device.createQuerySet({type:"timestamp",count:2})
        resolved??=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC})
        timestamps??=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
        let started=false
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
      }
      if(!capture){await device.queue.onSubmittedWorkDone();return {png:"",ms}}
      readback??=device.createBuffer({size:W*H*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      const enc=create();enc.copyTextureToBuffer({texture},{buffer:readback,bytesPerRow:W*4},[W,H]);device.queue.submit([enc.finish()])
      await readback.mapAsync(GPUMapMode.READ);const rgba=new Uint8ClampedArray(readback.getMappedRange().slice(0));readback.unmap()
      if(format.startsWith("bgra"))for(let i=0;i<rgba.length;i+=4){const b=rgba[i];rgba[i]=rgba[i+2];rgba[i+2]=b}
      paint.putImageData(new ImageData(rgba,W,H),0,0)
      return {png:canvas2d.toDataURL("image/png").split(",")[1],ms}
    }})
  },[width,height])
  await page.goto(`${server.url}arcade/nightshift/`)
  await page.waitForFunction(()=>Boolean((window as unknown as Proof).nightshift),undefined,{polling:100,timeout:90000})
  for(let i=0;i<20;i++)await page.evaluate(()=>(window as unknown as Proof).step(false))
  const adapter=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return a?{vendor:a.info.vendor,architecture:a.info.architecture,description:a.info.description}:null})
  const pose=async(id:string)=>page.evaluate(([id,spots])=>{
    const a=(window as unknown as Proof).nightshift,c=a.camera,s=spots.find(s=>s.id===id)!
    a.setCamera("wide");a.call.phase=s.ended?"ended":"ringing"
    const down="downstairs" in s&&s.downstairs;Object.assign(a.elevator,{phase:down?"basement":"floor",downstairs:down,closure:0})
    c.body.x=s.x;c.body.y=s.z;c.yaw=s.yaw;c.pitch=s.pitch;a.opening.height.x=s.height;c.release();c.resetWalk();a.time=6
  },[id,LOOK_SPOTS] as const)
  const apply=async(variant:string)=>{
    await page.evaluate(([variant,overrides])=>{const s=(window as unknown as Proof).nightshift.settings as unknown as Record<string,number>;s.look=variant==="today"?0:1;if(variant!=="today")Object.assign(s,overrides)},[variant,overrides] as const)
    for(let i=0;i<3;i++)await page.evaluate(()=>(window as unknown as Proof).step(false))
    await page.evaluate(()=>(window as unknown as Proof).nightshift.lookReady())
  }
  const tier=arg("--tier");if(tier)await page.evaluate(t=>(window as unknown as Proof).nightshift.quality.pin(t),tier)
  const report:Record<string,unknown>={adapter,width,height,overrides,errors}
  if(!perfOnly){
    for(const variant of variants){
      await apply(variant)
      for(const id of spots){
        await pose(id)
        for(let i=0;i<40;i++)await page.evaluate(()=>(window as unknown as Proof).step(false))
        const r=await page.evaluate(()=>(window as unknown as Proof).step(true))
        await Bun.write(resolve(out,`${id}-${variant}.png`),Buffer.from(r.png,"base64"))
        if(errors.length)throw Error(errors.join("\n"))
      }
    }
  }
  // ABBA paired whole-frame GPU time at the two heaviest views.
  const timing:Record<string,{today:number;look:number;delta:number}>={}
  for(const id of arg("--perf-spots")?.split(",")??["across","aisle"]){
    await pose(id)
    const samples:{v:string;ms:number}[]=[]
    for(const v of ["today","look","look","today"]){
      await apply(v);await pose(id)
      for(let i=0;i<15;i++)await page.evaluate(()=>(window as unknown as Proof).step(false))
      for(let i=0;i<30;i++){const r=await page.evaluate(()=>(window as unknown as Proof).step(false,true));samples.push({v,ms:r.ms})}
    }
    const median=(v:string)=>{const a=samples.filter(s=>s.v===v).map(s=>s.ms).sort((a,b)=>a-b);return (a[29]+a[30])/2}
    timing[id]={today:median("today"),look:median("look"),delta:median("look")-median("today")}
  }
  report.timing=timing
  report.quality=await page.evaluate(()=>(window as unknown as Proof).nightshift.quality.state())
  if(errors.length)throw Error(errors.join("\n"))
  await Bun.write(resolve(out,"report.json"),JSON.stringify(report,null,2))
  console.log(JSON.stringify({out,...report}))
}finally{await browser.close();server.stop(true)}
