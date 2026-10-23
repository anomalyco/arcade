/** One requested elevator-to-hall tape, headless/muted, real movement and file-muxed production audio. */
import { browserBudget } from "../../../scripts/browser-budget"
import { existsSync,readdirSync,mkdirSync } from "node:fs"
import { resolve } from "node:path"
import type { WalkCamera } from "../src/walk-camera"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { Opening } from "../src/opening"
import type { Descent,DescentSettings } from "../src/descent/state"
import type { DescentAudio,DescentAudioFrame,renderDescentAudio } from "../src/descent/audio"
import type { FoleyFrame } from "../src/foley"
import type { Settings } from "../src/settings"
import type { Call } from "../shared/call"

await using budget = browserBudget()
const { chromium } = budget
type App={camera:WalkCamera;renderer:Renderer;opening:Opening;elevator:Descent;settings:Settings;descent:DescentSettings;storyAudio:DescentAudio;audio:{ready:boolean};parked:number;call:Call;storyFrame:DescentAudioFrame;clock:number;paused:boolean;step(ms:number):void;renderDescentAudio:typeof renderDescentAudio}
type Host=Window&{nightshift:App;capture(ms:number):Promise<string>;tape:DescentAudioFrame[];feet:FoleyFrame[];pixelMax:number}
const review=process.argv.includes("--review-fixes")
const out=resolve(process.env.NIGHTSHIFT_DESCENT_DIR??(review?"captures/nightshift-descent-review":"captures/nightshift-descent")),fps=30,stills=process.argv.includes("--stills")
mkdirSync(out,{recursive:true})
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname,f=Bun.file(`${import.meta.dir}/../dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
if(!executablePath)throw Error("Headless Chromium missing")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],trace:unknown[]=[]
let encoder:ReturnType<typeof Bun.spawn>|undefined
try{
  const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1})
  const requests:string[]=[]
  page.on("request",r=>{if(r.url().includes("/audio/descent/"))requests.push(r.url())})
  if(review)await page.route("**/audio/descent/*",route=>{
    const url=route.request().url()
    if(url.endsWith("lift-down.mp3"))return route.fulfill({status:503,body:"Expected test failure"})
    if(url.endsWith("lift-token.mp3"))return route.fulfill({status:200,contentType:"audio/mpeg",body:"Undecodable test audio"})
    return route.continue()
  })
  page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error"&&!(review&&m.text().includes("503")))errors.push(m.text())})
  await page.addInitScript(()=>{
    const w=window as unknown as Host;window.requestAnimationFrame=()=>1;w.tape=[];w.feet=[]
    let configured=false,readback:GPUBuffer|undefined
    const image=document.createElement("canvas");image.width=1280;image.height=720;const paint=image.getContext("2d")!
    w.capture=async(ms:number)=>{
      const a=w.nightshift,canvas=document.getElementById("view") as HTMLCanvasElement,ctx=canvas.getContext("webgpu")!,device=a.renderer.passContext.device
      if(!configured){ctx.configure({device,format:navigator.gpu.getPreferredCanvasFormat(),alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});configured=true}
      const get=ctx.getCurrentTexture.bind(ctx);let texture:GPUTexture|undefined;ctx.getCurrentTexture=()=>texture??=get()
      try{a.step(ms)}finally{ctx.getCurrentTexture=get}
      if(!texture)throw Error("Frame did not render")
      readback??=device.createBuffer({size:1280*720*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer:readback,bytesPerRow:5120},[1280,720]);device.queue.submit([enc.finish()]);await readback.mapAsync(GPUMapMode.READ)
      const rgba=new Uint8ClampedArray(readback.getMappedRange().slice(0));readback.unmap()
      if(navigator.gpu.getPreferredCanvasFormat().startsWith("bgra"))for(let i=0;i<rgba.length;i+=4){const b=rgba[i];rgba[i]=rgba[i+2];rgba[i+2]=b}
      w.pixelMax=0;for(let i=0;i<rgba.length;i+=4)w.pixelMax=Math.max(w.pixelMax,rgba[i],rgba[i+1],rgba[i+2])
      paint.putImageData(new ImageData(rgba,1280,720),0,0);paint.textAlign="center";paint.textBaseline="top";paint.shadowColor="#000";paint.shadowBlur=8
      const el=document.getElementById("subtitle")!,style=getComputedStyle(el);paint.font=style.font;paint.fillStyle=style.color;paint.fillText(el.textContent??"",640,el.getBoundingClientRect().top)
      return image.toDataURL("image/jpeg",.93).split(",")[1]
    }
  })
  await page.goto(`${server.url}arcade/nightshift/`,{waitUntil:"domcontentloaded"})
  await page.waitForFunction(()=>!!(window as unknown as Host).nightshift,undefined,{polling:100,timeout:120000})
  await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;a.paused=true;a.renderer.render=a.renderer.drawTo.bind(a.renderer);a.step(0)})
  await page.waitForSelector("#arcade-boot[data-ready]",{state:"attached",timeout:30000})
  if(requests.length)throw Error(`Descent fetched ${requests.length} stems before Begin`)
  trace.push({bootStemRequests:requests.length})
  await page.locator("#view").click({force:true})
  await page.waitForFunction(()=>{const a=(window as unknown as Host).nightshift;return document.pointerLockElement?.id==="view"&&a.storyAudio.loaded+a.storyAudio.errors.length===11&&a.audio.ready},undefined,{polling:100,timeout:30000})
  if(review){
    await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;Object.assign(a.opening,{started:true,complete:true,standing:true,time:30});a.opening.height.x=1.65;Object.assign(a.camera.body,{x:0,y:8});a.camera.yaw=-Math.PI;a.step(0)})
    await page.keyboard.down("w")
    const gate=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;for(let i=0;i<90;i++)a.step(1000/30);return {call:a.call.phase,car:a.elevator.phase,z:a.camera.body.y}})
    await page.keyboard.up("w")
    if(gate.call!=="ringing"||gate.car!=="floor"||gate.z>=8.8)throw Error(`Ringing boarding gate failed: ${JSON.stringify(gate)}`)
    trace.push({gate})
  }
  // Verify the first call cannot own movement or drag the receiver across the floor.
  await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;Object.assign(a.opening,{started:true,complete:true,standing:true,time:30});a.opening.height.x=1.65;Object.assign(a.camera.body,{x:-.08,y:-4.82});a.camera.yaw=0;a.camera.pitch=-.6;a.step(0)})
  await page.keyboard.press("e")
  await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;for(let i=0;i<60;i++)a.step(1000/30)})
  await page.keyboard.down("s")
  const phone=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift,start=a.camera.body.y;for(let i=0;i<90;i++)a.step(1000/30);return {phase:a.call.phase,walked:a.camera.body.y-start,parked:a.parked}})
  await page.keyboard.up("s")
  if(phone.phase!=="call"||phone.walked<1||phone.parked!==1)throw Error(`Call exploration failed: ${JSON.stringify(phone)}`)
  trace.push({phone})
  if(review){
    await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;Object.assign(a.camera.body,{x:0,y:8,vx:0,vy:0});a.camera.yaw=-Math.PI;a.step(0)})
    await page.keyboard.down("w")
    const gate=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;for(let i=0;i<90;i++)a.step(1000/30);return {call:a.call.phase,car:a.elevator.phase,z:a.camera.body.y}})
    await page.keyboard.up("w")
    if(gate.call!=="call"||gate.car!=="floor"||gate.z>=8.8)throw Error(`Speaking boarding gate failed: ${JSON.stringify(gate)}`)
    const subtitles=await page.evaluate(()=>{
      const a=(window as unknown as Host).nightshift,seen=new Set<string>();a.call.phase="ended";a.call.lift=0;Object.assign(a.camera.body,{x:0,y:9.8,vx:0,vy:0})
      for(let i=0;i<60*30;i++){if(a.elevator.phase==="basement")a.camera.body.y=6;a.step(1000/30);if(document.getElementById("subtitle")!.textContent)seen.add(a.elevator.line!)}
      return {seen:[...seen],loaded:a.storyAudio.loaded,failures:a.storyAudio.errors,car:a.elevator.phase}
    })
    if(subtitles.seen.length!==9||subtitles.seen[0]!=="lift-down"||subtitles.seen[1]!=="lift-token"||subtitles.loaded!==9||subtitles.failures.length!==2||subtitles.car!=="basement")throw Error(`Audio fallback failed: ${JSON.stringify(subtitles)}`)
    trace.push({gate,subtitles})
    if(errors.length)throw Error(JSON.stringify(errors))
    console.log(JSON.stringify(trace,null,2));process.exitCode=0
  }else{
  await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;Object.assign(a.call,{phase:"ended",lift:0,elapsed:0});Object.assign(a.camera.body,{x:0,y:6,vx:0,vy:0});a.camera.yaw=-Math.PI;a.camera.pitch=-.08;a.camera.resetWalk();a.step(0)})
  const elevator=await page.evaluate(()=>(window as unknown as Host).capture(0));await Bun.write(resolve(out,"04-elevator.jpg"),Buffer.from(elevator,"base64"))
  if(stills){
    await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;Object.assign(a.elevator,{phase:"basement",downstairs:true,closure:0});Object.assign(a.camera.body,{x:40,y:7.7});a.camera.yaw=0;a.camera.pitch=-.04})
    const basement=await page.evaluate(()=>(window as unknown as Host).capture(0));await Bun.write(resolve(out,"05-basement.jpg"),Buffer.from(basement,"base64"))
  }else{
    const enc=Bun.spawn(["ffmpeg","-v","error","-y","-f","image2pipe","-framerate",String(fps),"-i","-","-an","-c:v","libx264","-threads","2","-preset","fast","-crf","21","-pix_fmt","yuv420p",resolve(out,"silent.mp4")],{stdin:"pipe",stdout:"inherit",stderr:"inherit"});encoder=enc
    let closing=-1,arrived=-1,saved=false
    await page.keyboard.down("w")
    for(let i=0;i<38*fps;i++){
      if(closing>=0&&i===closing+1)await page.keyboard.up("w")
      if(closing>=0&&i===closing+3*fps)await page.keyboard.down("a")
      if(closing>=0&&i===closing+3*fps+8)await page.keyboard.up("a")
      if(closing>=0&&i===closing+4*fps)await page.keyboard.down("d")
      if(closing>=0&&i===closing+4*fps+8)await page.keyboard.up("d")
      if(arrived>=0&&i===arrived+8)await page.keyboard.down("w")
      const result=await page.evaluate(async({i,fps,closing})=>{
        const w=window as unknown as Host,a=w.nightshift
        if(closing>=0){const t=Math.max(0,Math.min(1,(i-closing)/(fps*1.6))),s=t*t*(3-2*t);a.camera.yaw=-Math.PI*(1-s)+Math.sin((i-closing)/fps*.7)*.06*s;a.camera.pitch=-.08+Math.sin((i-closing)/fps*.43)*.025}
        const jpg=await w.capture(1000/fps),c=a.camera,t=i/fps,s=a.settings
        w.tape.push({...a.storyFrame,time:t})
        w.feet.push({room:{time:t,x:c.body.x,z:c.body.y,yaw:c.yaw,volume:s.volume,active:true,tube:0,foley:s.foley,room:0},events:c.walk.events.map(e=>({...e,time:e.time+t-c.walk.time}))})
        return {jpg,time:t,phase:a.elevator.phase,closure:a.elevator.closure,line:a.elevator.line,lineTime:a.elevator.lineTime,x:c.body.x,z:c.body.y,yaw:c.yaw,speed:c.speed}
      },{i,fps,closing})
      if(closing<0&&result.phase==="closing")closing=i
      if(arrived<0&&result.phase==="basement")arrived=i
      if(result.z<4)await page.keyboard.up("w")
      const {jpg,...state}=result;trace.push(state);const bytes=Buffer.from(jpg,"base64");enc.stdin.write(bytes);await enc.stdin.flush()
      if(!saved&&result.phase==="basement"&&result.z<7.8){saved=true;await Bun.write(resolve(out,"05-basement.jpg"),bytes)}
    }
    await page.keyboard.up("w");enc.stdin.end();if(await enc.exited!==0)throw Error("Encoding failed")
    const audio=await page.evaluate(async()=>{const w=window as unknown as Host,a=w.nightshift;if(a.elevator.phase!=="basement"||a.camera.body.y>7)throw Error("Did not walk out of elevator");const wav=new Uint8Array(await a.renderDescentAudio(w.tape,w.feet,w.tape.length/30));let s="";for(let i=0;i<wav.length;i+=8192)s+=String.fromCharCode(...wav.subarray(i,i+8192));return btoa(s)})
    await Bun.write(resolve(out,"descent.wav"),Buffer.from(audio,"base64"))
    const mux=Bun.spawn(["ffmpeg","-v","error","-y","-i",resolve(out,"silent.mp4"),"-i",resolve(out,"descent.wav"),"-map","0:v","-map","1:a","-c:v","copy","-c:a","aac","-b:a","160k","-movflags","+faststart",resolve(out,"descent.mp4")],{stdout:"inherit",stderr:"inherit"});if(await mux.exited!==0)throw Error("Mux failed")
    const ending=await page.evaluate(async()=>{const w=window as unknown as Host,a=w.nightshift;Object.assign(a.camera.body,{x:40,y:-15.7});for(let i=0;i<40;i++)a.elevator.step(.05,a.camera.body,true,-1,a.descent,true);await w.capture(0);return {done:a.elevator.done,pixelMax:w.pixelMax}})
    if(!ending.done||ending.pixelMax!==0)throw Error(`Final door fade failed: ${JSON.stringify(ending)}`)
    trace.push({ending})
  }
  if(errors.length)throw Error(JSON.stringify(errors))
  }
}finally{if(encoder&&encoder.exitCode===null){encoder.kill();await encoder.exited}await Bun.write(resolve(out,"report.json"),JSON.stringify({fps,errors,trace},null,2));await browser.close();server.stop(true)}
