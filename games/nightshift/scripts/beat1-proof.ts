/** Requested beat-1 review tape: headless GPU readback, file-only audio. */
import { chromium } from "playwright-core"
import { existsSync,readdirSync,mkdirSync } from "node:fs"
import { resolve } from "node:path"
import type { WalkCamera } from "../src/walk-camera"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { Opening } from "../src/opening"
import type { Elevator } from "../src/elevator"
import type { Settings } from "../src/settings"
import type { Call } from "../shared/call"
import { CALL_DURATION, CALL_FIRST_LINE_END } from "../shared/call"
import type { BeatAudioFrame,OfficeAudio,renderBeatAudio } from "../src/audio"
import type { OfficePhysics } from "../src/polish/props"
import type { Continuity } from "../src/polish/continuity"
import type { DustField } from "../src/polish/dust"
import type { tubeSignal } from "../src/polish/tube"
import type { CameraFilter } from "@arcade/kit/gpu/post/camcorder"
type App={camera:WalkCamera;renderer:Renderer;opening:Opening;elevator:Elevator;settings:Settings;audio:OfficeAudio;call:Call;physics:OfficePhysics;continuity:Continuity;dustField:DustField;tubeSignal:typeof tubeSignal;clock:number;paused:boolean;step(ms:number):void;renderBeatAudio:typeof renderBeatAudio}
type Host=Window&{nightshift:App;cameraFilter:CameraFilter;capture(ms:number):Promise<string>;tape:BeatAudioFrame[];pixelMean:number;finalPixelMax?:number}
const out=resolve(process.env.NIGHTSHIFT_BEAT_DIR??"captures/nightshift-beat1"),stills=process.argv.includes("--stills"),controls=process.argv.includes("--controls"),filters=process.argv.includes("--filters"),fps=30
mkdirSync(out,{recursive:true})
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const p=new URL(req.url).pathname,f=Bun.file(`${import.meta.dir}/../dist${p}${p.endsWith("/")?"index.html":""}`);return await f.exists()?new Response(f):new Response(null,{status:404})}})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
if(!executablePath)throw Error("Headless Chromium missing")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],trace:unknown[]=[],saved=new Set<string>()
let encoder:ReturnType<typeof Bun.spawn>|undefined
try{
  const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
  await page.addInitScript(()=>{
    const w=window as unknown as Host;window.requestAnimationFrame=()=>1;w.tape=[]
    let configured=false,readback:GPUBuffer|undefined
    const image=document.createElement("canvas");image.width=1280;image.height=720;const paint=image.getContext("2d")!
    w.capture=async(ms:number)=>{
      const a=w.nightshift,canvas=document.getElementById("view") as HTMLCanvasElement,ctx=canvas.getContext("webgpu")!,device=a.renderer.passContext.device
      if(!configured){ctx.configure({device,format:navigator.gpu.getPreferredCanvasFormat(),alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});configured=true}
      const get=ctx.getCurrentTexture.bind(ctx);let texture:GPUTexture|undefined;ctx.getCurrentTexture=()=>texture??=get()
      a.step(ms);ctx.getCurrentTexture=get
      if(!texture)throw Error("Frame did not render")
      readback??=device.createBuffer({size:1280*720*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer:readback,bytesPerRow:5120},[1280,720]);device.queue.submit([enc.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      const rgba=new Uint8ClampedArray(readback.getMappedRange().slice(0));readback.unmap()
      if(navigator.gpu.getPreferredCanvasFormat().startsWith("bgra"))for(let i=0;i<rgba.length;i+=4){const b=rgba[i];rgba[i]=rgba[i+2];rgba[i+2]=b}
      let sum=0;for(let i=0;i<rgba.length;i+=4)sum+=rgba[i]+rgba[i+1]+rgba[i+2]
      w.pixelMean=sum/(1280*720*3)
      if(!a.opening.complete){
        if(a.continuity.events.length)throw Error("Continuity changed during opening")
        if(a.physics.paper!==0||a.physics.chairs.some(c=>c.x!==c.homeX||c.z!==c.homeZ||c.yaw!==0))throw Error("Opening excited physical props")
        if(a.dustField.offsets.some(v=>v!==0))throw Error("Opening excited dust wake")
      }
      if(a.elevator.done){
        let max=0;for(let i=0;i<rgba.length;i+=4)max=Math.max(max,rgba[i],rgba[i+1],rgba[i+2])
        w.finalPixelMax=max;if(max!==0)throw Error(`Cinematic fade did not reach black: ${max}`)
      }
      paint.putImageData(new ImageData(rgba,1280,720),0,0)
      paint.textAlign="center";paint.textBaseline="top";paint.shadowColor="#000";paint.shadowBlur=8
      for(const id of ["subtitle","prompt"]){const el=document.getElementById(id)!,style=getComputedStyle(el),rect=el.getBoundingClientRect();paint.font=style.font;paint.fillStyle=style.color;paint.fillText(el.textContent??"",640,rect.top)}
      return image.toDataURL("image/jpeg",.93).split(",")[1]
    }
  })
  await page.goto(`${server.url}arcade/nightshift/`,{waitUntil:"domcontentloaded"})
  await page.waitForFunction(()=>!!(window as unknown as Host).nightshift,undefined,{polling:100,timeout:120000})
  await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;a.paused=true;a.renderer.render=a.renderer.drawTo.bind(a.renderer);a.step(0)})
  if(controls)await page.evaluate(async()=>{const w=window as unknown as Host;await w.capture(0);if(w.pixelMean!==0)throw Error("Scene visible before Begin")})
  await page.locator("#view").click({force:true})
  await page.waitForFunction(()=>document.pointerLockElement?.id==="view"&&(window as unknown as Host).nightshift.audio.ready,undefined,{polling:100,timeout:30000}).catch(async e=>{console.error(await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;return {locked:document.pointerLockElement?.id,started:a.opening.started,audioReady:a.audio.ready,audioError:a.audio.error,hidden:document.hidden,focus:document.hasFocus()}}));throw e})
  if(filters){
    for(const mode of ["today","iphone","vhs","crt","bodycam"] as const){
      const result=await page.evaluate(async mode=>{
        const w=window as unknown as Host,a=w.nightshift,f=w.cameraFilter
        f.settings.mode=mode;a.opening.time=2;a.elevator.closing=false;a.elevator.elapsed=0
        await w.capture(0)
        if(f.motion!==0||Object.values(a.camera.mount).some(v=>v!==0)||a.camera.eye[1]!==a.camera.height)throw Error(`${mode}: seated camera changed`)
        a.elevator.closing=true;a.elevator.elapsed=2.6
        await w.capture(0);const visible=w.pixelMean
        a.elevator.elapsed=3.3
        await w.capture(0);const half=w.pixelMean
        if(visible<1||half/visible<.4||half/visible>.6)throw Error(`${mode}: fade not applied once: ${visible} -> ${half}`)
        a.elevator.elapsed=4
        await w.capture(0)
        return {mode,seatedMountZero:true,visibleMean:visible,halfFadeMean:half,finalPixelMax:w.finalPixelMax}
      },mode)
      trace.push(result)
    }
    trace.push(await page.evaluate(async()=>{
      const w=window as unknown as Host,a=w.nightshift
      a.elevator.closing=false;a.elevator.elapsed=0
      while(!a.opening.complete)a.opening.step(.05,true,false)
      await w.capture(0)
      if(Object.values(a.camera.mount).some(v=>v!==0))throw Error("Bodycam changed seated handoff")
      a.opening.stand();await w.capture(50)
      const mount=a.camera.mount.height
      if(!(mount<0&&mount>-.04))throw Error(`Bodycam mount jumped at stand: ${mount}`)
      a.settings.reduceMotion=true;await w.capture(50)
      if(Object.values(a.camera.mount).some(v=>v!==0)||w.cameraFilter.motion!==0)throw Error("Bodycam ignored reduced motion")
      return {bodycamHandoffContinuous:true,firstStandMount:mount,reducedMotionMountZero:true}
    }))
  }else if(controls){
    await page.evaluate(async()=>{const w=window as unknown as Host;await w.capture(0);if(w.pixelMean!==0)throw Error("Begin did not continue from black")})
    const checkHangUp=async(elapsed:number,allowed:boolean)=>{
      const offered=await page.evaluate(elapsed=>{const a=(window as unknown as Host).nightshift;Object.assign(a.call,{phase:"call",elapsed,lift:1});a.step(0);return document.getElementById("prompt")!.textContent!.includes("Hang up")},elapsed)
      if(offered!==allowed)throw Error(`Incorrect hangup prompt at ${elapsed}: ${offered}`)
      await page.keyboard.press("e")
      const phase=await page.evaluate(()=>(window as unknown as Host).nightshift.call.phase)
      if(phase!==(allowed?"hangup":"call"))throw Error(`Incorrect hangup action at ${elapsed}: ${phase}`)
    }
    await page.keyboard.down("w");await page.keyboard.press("e")
    await page.evaluate(()=>(window as unknown as Host).nightshift.step(50))
    await page.keyboard.up("w")
    const before=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;return {time:a.opening.time,x:a.camera.body.x,z:a.camera.body.y,phase:a.call.phase}})
    if(before.x!==-.74||before.z!==-4.47||before.phase!=="ringing")throw Error("Intro input leaked")
    await page.evaluate(()=>document.exitPointerLock());await page.waitForFunction(()=>!document.pointerLockElement,undefined,{polling:50})
    const pausedTime=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;a.step(50);return a.opening.time})
    if(pausedTime!==before.time)throw Error("Unfocused timeline advanced")
    await page.locator("#view").click({force:true});await page.waitForFunction(()=>!!document.pointerLockElement,undefined,{polling:50})
    await page.keyboard.press("Backquote")
    const panelTime=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;a.step(50);return a.opening.time})
    if(panelTime!==pausedTime)throw Error("Panel did not pause the opening")
    await page.keyboard.press("Backquote");await page.locator("#view").click({force:true});await page.waitForFunction(()=>!!document.pointerLockElement,undefined,{polling:50})
    await page.evaluate(()=>{
      const a=(window as unknown as Host).nightshift
      // Advance the already-tested pure timeline; exercise the real final handoff.
      for(let i=0;i<360;i++)a.opening.step(.05,true,false)
      a.opening.complete=false;a.step(50)
      if(!a.opening.complete||localStorage.getItem("nightshift.openingSeen")!=="true")throw Error("First-view completion not persisted")
      if(a.opening.standing)throw Error("Handoff stood without input")
    })
    await page.keyboard.down("w")
    const height=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;a.step(50);return a.camera.height})
    await page.keyboard.up("w");if(!(height>1.4&&height<1.5))throw Error("First movement did not smoothly stand")
    await checkHangUp(CALL_FIRST_LINE_END,false)
    await checkHangUp(CALL_DURATION-.01,false)
    await page.evaluate(()=>localStorage.setItem("nightshift.reduceMotion","true"))
    await page.reload({waitUntil:"domcontentloaded"});await page.waitForFunction(()=>!!(window as unknown as Host).nightshift,undefined,{polling:100})
    await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;a.paused=true;a.renderer.render=a.renderer.drawTo.bind(a.renderer);a.step(0);if(!a.settings.reduceMotion)throw Error("Reduced motion not restored")})
    await page.locator("#view").click({force:true});await page.waitForFunction(()=>!!document.pointerLockElement&&(window as unknown as Host).nightshift.audio.ready,undefined,{polling:50})
    const pose=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;return [a.camera.yaw,a.camera.pitch,a.camera.height]})
    await page.keyboard.press("Space")
    const skipped=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;return {skipping:a.opening.skipping,pose:[a.camera.yaw,a.camera.pitch,a.camera.height]}})
    if(!skipped.skipping||JSON.stringify(skipped.pose)!==JSON.stringify(pose))throw Error("Skip jumped the pose or ignored prior viewing")
    await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;while(!a.opening.complete)a.opening.step(.05,true,true);a.step(0)})
    await checkHangUp(CALL_FIRST_LINE_END-.01,false)
    await checkHangUp(CALL_FIRST_LINE_END,true)
    trace.push({beginsBlack:true,beginContinuesFromBlack:true,firstCallForced:true,repeatHangupAfterFirstLine:true,introInputBlocked:true,pointerUnlockPauses:true,panelPauses:true,completionPersisted:true,firstMoveHeight:height,reducedMotionRestored:true,skipPoseContinuous:true})
  }else if(stills){
    for(const [name,time] of [["01-at-desk",2],["02-whip-to-phone",7.4],["03-look-across",16.5]] as const){
      const jpg=await page.evaluate(async time=>{const w=window as unknown as Host;while(w.nightshift.opening.time<time-.05){w.nightshift.step(50);await w.nightshift.renderer.passContext.device.queue.onSubmittedWorkDone()}return w.capture(50)},time)
      await Bun.write(resolve(out,`beat1-${name}.jpg`),Buffer.from(jpg,"base64"))
    }
    await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;Object.assign(a.camera.body,{x:0,y:6});a.camera.yaw=-Math.PI;a.camera.pitch=-.12;a.opening.standing=true;a.opening.height.x=1.65})
    const jpg=await page.evaluate(()=>(window as unknown as Host).capture(33.333));await Bun.write(resolve(out,"beat1-04-elevator.jpg"),Buffer.from(jpg,"base64"))
  }else{
    const enc=Bun.spawn(["ffmpeg","-v","error","-y","-f","image2pipe","-framerate",String(fps),"-i","-","-an","-c:v","libx264","-threads","2","-preset","fast","-crf","21","-pix_fmt","yuv420p",resolve(out,"silent.mp4")],{stdin:"pipe",stdout:"inherit",stderr:"inherit"});encoder=enc
    let answered=false,endedFrame=-1,walkFrame=-1,turnBackFrame=-1
    await page.keyboard.down("w")
    for(let i=0;i<115*fps;i++){
      if(i===fps){await page.keyboard.up("w");const state=await page.evaluate(()=>{const a=(window as unknown as Host).nightshift;return {x:a.camera.body.x,z:a.camera.body.y,phase:a.call.phase}});if(state.x!==-.74||state.z!==-4.47||state.phase!=="ringing")throw Error("Intro leaked movement/interaction")}
      if(i===20*fps){await page.keyboard.press("e");answered=true}
      if(endedFrame>=0&&i===endedFrame+2*fps){await page.keyboard.down("a");walkFrame=i}
      if(walkFrame>=0&&i===walkFrame+14){await page.keyboard.up("a");await page.keyboard.down("w")}
      if(turnBackFrame>=0&&i===turnBackFrame+fps)await page.keyboard.down("s")
      const result=await page.evaluate(async({i,fps,endedFrame,turnBackFrame})=>{
        const w=window as unknown as Host,a=w.nightshift,t=i/fps
        const smooth=(x:number)=>{const v=Math.max(0,Math.min(1,x));return v*v*v*(10+v*(-15+6*v))}
        if(t>=17&&t<20){const k=smooth((t-17)/2);a.camera.yaw=-3.1+2.3*k;a.camera.pitch=.025-.275*k}
        if(endedFrame>=0){const k=smooth((i-endedFrame)/(2*fps));a.camera.yaw=-.8+(-Math.PI+.8)*k;a.camera.pitch=-.25+.13*k}
        if(turnBackFrame>=0)a.camera.yaw=-Math.PI+Math.PI*smooth((i-turnBackFrame)/(.8*fps))
        const jpg=await w.capture(1000/fps),c=a.camera,o=a.opening,e=a.elevator,s=a.settings
        const distance=Math.hypot(c.body.x-.12,c.body.y+5.4),pan=((.12-c.eye[0])*Math.cos(c.yaw)-(-5.4-c.eye[2])*Math.sin(c.yaw))/Math.max(.1,distance)
         const signal=a.tubeSignal(a.clock,s.flicker)
         w.tape.push({time:t,openingTime:o.time,ringTime:Math.max(0,o.time-6.2),distance,pan,call:{...a.call},room:{time:t,x:c.body.x,z:c.body.y,yaw:c.yaw,volume:s.volume*(1-e.fade),active:true,tube:signal.level,foley:s.foley,room:s.roomTone*o.roomGain,ballast:s.polish&&s.tubeSound?signal:undefined,crackle:s.tubeCrackle},events:c.walk.events.map(event=>({...event,time:event.time+t-c.walk.time}))})
         return {jpg,time:t,opening:o.time,complete:o.complete,eye:[...c.eye],yaw:c.yaw,pitch:c.pitch,phase:a.call.phase,elapsed:a.call.elapsed,lift:a.call.lift,closure:e.closure,fade:e.fade,done:e.done,tube:signal,continuityEvents:a.continuity.events.length,finalPixelMax:w.finalPixelMax,subtitle:document.getElementById("subtitle")!.textContent??""}
      },{i,fps,endedFrame,turnBackFrame})
      if(answered&&i===21*fps&&result.phase!=="call")throw Error("Real E did not answer")
      if(endedFrame<0&&result.phase==="ended")endedFrame=i
      if(turnBackFrame<0&&result.eye[2]>8.1){turnBackFrame=i;await page.keyboard.up("w")}
      const {jpg,...state}=result;trace.push(state);const bytes=Buffer.from(jpg,"base64");enc.stdin.write(bytes);await enc.stdin.flush()
      const label=i===2*fps?"01-at-desk":i===Math.round(7.4*fps)?"02-whip-to-phone":i===16*fps?"03-look-across":result.eye[2]>6&&!result.done?"04-elevator":undefined
      if(label&&!saved.has(label)){saved.add(label);await Bun.write(resolve(out,`beat1-${label}.jpg`),bytes)}
      if(i%(10*fps)===0)console.log(`Beat 1 ${Math.round(i/fps)}s: ${result.phase}`)
      if(result.done)break
    }
    await page.keyboard.up("w");await page.keyboard.up("s");enc.stdin.end();if(await enc.exited!==0)throw Error("Encoding failed")
    const audio=await page.evaluate(async()=>{const w=window as unknown as Host,a=w.nightshift;if(!a.elevator.done)throw Error(`Did not reach elevator: ${JSON.stringify(a.camera.body)}`);const b=await fetch("./audio/kit-call.mp3").then(r=>r.arrayBuffer());const wav=new Uint8Array(await a.renderBeatAudio(w.tape,w.tape.length/30,b));let s="";for(let i=0;i<wav.length;i+=8192)s+=String.fromCharCode(...wav.subarray(i,i+8192));return btoa(s)})
    await Bun.write(resolve(out,"beat1-mix.wav"),Buffer.from(audio,"base64"))
    const mux=Bun.spawn(["ffmpeg","-v","error","-y","-i",resolve(out,"silent.mp4"),"-i",resolve(out,"beat1-mix.wav"),"-map","0:v","-map","1:a","-c:v","copy","-c:a","aac","-b:a","160k","-movflags","+faststart",resolve(out,"beat1.mp4")],{stdout:"inherit",stderr:"inherit"});if(await mux.exited!==0)throw Error("Mux failed")
  }
  if(errors.length)throw Error(JSON.stringify(errors))
}finally{
  if(encoder&&encoder.exitCode===null){encoder.kill();await encoder.exited}
  await Bun.write(resolve(out,filters?"filters-report.json":controls?"controls-report.json":stills?"stills-report.json":"trace.json"),JSON.stringify({fps,errors,trace},null,2));await browser.close();server.stop(true)
}
