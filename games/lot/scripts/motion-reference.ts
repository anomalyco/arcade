import assert from "node:assert/strict"
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { matchedPaths } from "./motion-paths"
import { START } from "../src/world"

// The local Ashwood preview's acknowledged camera bridge, without modifying its checkout.
// Camera poses match motion.ts. Atmosphere advances on Ashwood's own clock; this
// is a visual reference, not a claim of comparable depth-reprojection pop counts.
const out=resolve(process.env.MOTION_OUT??"captures/lot/shimmer-reference")
mkdirSync(out,{recursive:true})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath,"Headless Chromium required")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const report={source:process.env.ASHWOOD_URL??"http://127.0.0.1:5253/",fps:60,errors:[] as string[],runs:{} as Record<string,unknown>}
try {
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1})
  page.on("pageerror",e=>report.errors.push(e.message))
  page.on("console",m=>{if(m.type()==="error")report.errors.push(m.text())})
  await page.addInitScript(()=>{
    const w=window as any,configure=GPUCanvasContext.prototype.configure,get=GPUCanvasContext.prototype.getCurrentTexture
    GPUCanvasContext.prototype.configure=function(c){w.captureDevice=c.device;return configure.call(this,{...c,usage:(c.usage??GPUTextureUsage.RENDER_ATTACHMENT)|GPUTextureUsage.COPY_SRC})}
    GPUCanvasContext.prototype.getCurrentTexture=function(){const texture=get.call(this);w.captureTexture=texture;return texture}
  })
  const url=new URL(report.source);url.searchParams.set("shot","1");url.searchParams.set("follow","1");url.searchParams.set("view","lot")
  await page.goto(url.href,{waitUntil:"domcontentloaded",timeout:60_000})
  await page.waitForFunction(()=>(window as any).__afterhours?.ready,undefined,{timeout:600_000,polling:100})
  await page.evaluate(()=>{
    const w=window as any;w.motionClock=performance.now();w.motionCallbacks=[]
    performance.now=()=>w.motionClock
    window.requestAnimationFrame=f=>w.motionCallbacks.push(f)
    addEventListener("message",e=>{if(e.data?.type==="ashwood-camera-applied")w.motionApplied=e.data})
  })
  await page.waitForFunction(()=>(window as any).motionCallbacks.length>0,undefined,{polling:100})
  for(const name of (process.env.MOTION_PATHS??"kit,lamp,turn").split(",")) {
    const path=matchedPaths[name];assert(path,`Unknown path ${name}`)
    const dir=resolve(out,"frames",`${name}-reference`);mkdirSync(dir,{recursive:true})
    const result=await page.evaluate(async ({poses,height})=>{
      const w=window as any,device=w.captureDevice as GPUDevice,W=1920,H=1080,row=Math.ceil(W*4/256)*256
      const buffer=device.createBuffer({size:row*H,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      const canvas=new OffscreenCanvas(W,H),g=canvas.getContext("2d")!,image=g.createImageData(W,H)
      const images:string[]=[],applied:unknown[]=[]
      try {
        for(let i=-60;i<poses.length;i++) {
          const p=poses[Math.max(0,i)]!,pose={...p,y:height,fov:68},seq=i+61
          dispatchEvent(new MessageEvent("message",{source:window,origin:location.origin,data:{type:"ashwood-camera",seq,pose}}))
          w.motionClock+=1000/60
          const callbacks=w.motionCallbacks;w.motionCallbacks=[]
          for(const callback of callbacks)callback(w.motionClock)
          await Promise.resolve()
          const texture=w.captureTexture as GPUTexture,encoder=device.createCommandEncoder()
          encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[W,H]);device.queue.submit([encoder.finish()])
          await buffer.mapAsync(GPUMapMode.READ)
          const bytes=new Uint8Array(buffer.getMappedRange()),bgra=texture.format.startsWith("bgra")
          if(i>=0) {
            for(let y=0;y<H;y++)for(let x=0;x<W;x++) {
              const s=y*row+x*4,d=(y*W+x)*4
              image.data[d]=bytes[s+(bgra?2:0)]!;image.data[d+1]=bytes[s+1]!;image.data[d+2]=bytes[s+(bgra?0:2)]!;image.data[d+3]=255
            }
          }
          buffer.unmap()
          // postMessage acknowledgement runs as a task, independently of our held RAF queue.
          await new Promise<void>(r=>setTimeout(r,0))
          if(w.motionApplied?.seq!==seq)throw Error(`Camera did not acknowledge frame ${seq}`)
          const actual=w.motionApplied.pose
          if(["x","y","z","yaw","pitch","fov"].some(k=>Math.abs(actual[k]-(pose as any)[k])>1e-6))throw Error("Camera mismatch")
          if(i<0)continue
          applied.push(actual);g.putImageData(image,0,0)
          const b=new Uint8Array(await (await canvas.convertToBlob({type:"image/jpeg",quality:.9})).arrayBuffer())
          let s="";for(let j=0;j<b.length;j+=0x8000)s+=String.fromCharCode(...b.subarray(j,j+0x8000))
          images.push(btoa(s))
        }
        return {images,applied}
      } finally {buffer.destroy()}
    },{poses:Array.from({length:path.frames},(_,i)=>path.pose(i/60)),height:START.height})
    result.images.forEach((b,i)=>writeFileSync(resolve(dir,`${String(i+1).padStart(4,"0")}.jpg`),Buffer.from(b,"base64")))
    report.runs[name]={poses:result.applied}
    writeFileSync(resolve(out,"reference.json"),JSON.stringify(report,null,2))
    console.log(`Ashwood ${name}: ${result.images.length} acknowledged matching poses`)
  }
  assert.equal(report.errors.length,0,report.errors.join("\n"))
} finally {
  writeFileSync(resolve(out,"reference.json"),JSON.stringify(report,null,2))
  await browser.close()
}
