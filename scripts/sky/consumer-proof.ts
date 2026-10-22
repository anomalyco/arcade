/** One muted, deterministic consumer check: lazy assets, actual scene shader and return to Today. */
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { existsSync } from "node:fs"
import { mkdir, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import type { Renderer } from "../../packages/kit/gpu/renderer"
import type { attachSky } from "../../packages/kit/sky/controller"
import type { Opening } from "../../games/nightshift/src/opening"
import { serveDist } from "../../games/lot/scripts/serve-dist"

type App = {
  sky: ReturnType<typeof attachSky>; renderer: Renderer; paused: boolean; time: number
  camera: { body: { x: number; y: number }; yaw: number; pitch: number; release(): void; resetWalk(): void }
  step(ms: number): void; setCamera(view: "wide"): void; opening: Opening
}
type Probe = Window & { lot: App; nightshift: App }
const input=process.argv[2]
if(input!=="lot"&&input!=="nightshift")throw Error("Expected lot or nightshift")
const game: "lot" | "nightshift"=input
const root=resolve(`games/${game}`),out=resolve("captures/sky-consumers")
await mkdir(out,{recursive:true})
const built=process.argv.includes("--built")
if(built) {
  const build=Bun.spawn(["bun","run","build"],{cwd:root,stdout:"inherit",stderr:"inherit"})
  if(await build.exited)throw Error("Consumer build failed")
}
const server=built?undefined:await createServer({root,configFile:resolve(root,"vite.config.ts"),server:{host:"127.0.0.1",port:0},logLevel:"error"})
await server?.listen()
const dist=built?serveDist(resolve(root,"dist")):undefined
const url=dist?`http://127.0.0.1:${dist.port}/arcade/${game}/`:server!.resolvedUrls!.local[0]!
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=(await readdir(cache)).filter(n=>n.startsWith("chromium_headless_shell-")).sort().reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if(!executablePath)throw Error("Headless Chromium missing")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],requests:string[]=[]
try {
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1})
  page.on("pageerror",e=>errors.push(e.message))
  page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
  page.on("request",r=>{if(/sky\/assets\/(stars|moon)\.|\/assets\/(stars|moon)-/.test(r.url()))requests.push(r.url())})
  await page.addInitScript(()=>{
    // The apps expose synchronous step() hooks; keep presentation clocks frozen throughout the pair.
    window.requestAnimationFrame=()=>0;performance.now=()=>8000
    const configure=GPUCanvasContext.prototype.configure
    GPUCanvasContext.prototype.configure=function(c){return configure.call(this,{...c,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC})}
  })
  await page.goto(`${url}?time=8`,{waitUntil:"commit",timeout:120000})
  await page.waitForFunction(game=>!!(window as Probe)[game],game,{polling:100,timeout:180000})
  await page.evaluate(game=>{
    const a=(window as Probe)[game];a.paused=true
    // render() coalesces work in a microtask. This frozen-clock fixture needs the
    // production synchronous entry point so canvas readback follows the draw.
    a.renderer.render=a.renderer.drawTo.bind(a.renderer)
    if(game==="nightshift") {
      a.setCamera("wide");a.time=8;a.opening.height.x=1.65
      a.camera.body.x=-2.2;a.camera.body.y=0;a.camera.yaw=Math.PI/2;a.camera.pitch=0.4
      a.sky.settings.skyMoonAzimuth=270;a.sky.settings.skyMoonAltitude=25
    } else { a.camera.pitch=0.65 }
    a.camera.release();a.camera.resetWalk()
    a.sky.settings.skyScintillation=0
  },game)
  if(requests.length)throw Error("Today fetched sky assets")
  const capture=async(mode:"today"|"physical")=>{
    const png=await page.evaluate(async({game,mode})=>{
      const a=(window as Probe)[game];a.sky.settings.skyMode=mode;a.sky.settings.skyMoon="crescent"
      if(mode==="physical")await a.sky.load()
      for(let i=0;i<12;i++)a.step(0)
      const d=a.renderer.passContext.device,c=document.querySelector<HTMLCanvasElement>("#view")!,ctx=c.getContext("webgpu")!
      const row=Math.ceil(c.width*4/256)*256,b=d.createBuffer({size:row*c.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      a.step(0)
      const enc=d.createCommandEncoder();enc.copyTextureToBuffer({texture:ctx.getCurrentTexture()},{buffer:b,bytesPerRow:row},[c.width,c.height]);d.queue.submit([enc.finish()])
      await b.mapAsync(GPUMapMode.READ)
      const src=new Uint8Array(b.getMappedRange()),rgba=new Uint8ClampedArray(c.width*c.height*4)
      for(let y=0;y<c.height;y++)rgba.set(src.subarray(y*row,y*row+c.width*4),y*c.width*4)
      b.unmap();b.destroy()
      if(navigator.gpu.getPreferredCanvasFormat().startsWith("bgra"))for(let i=0;i<rgba.length;i+=4){const x=rgba[i]!;rgba[i]=rgba[i+2]!;rgba[i+2]=x}
      let visible=0
      for(let i=0;i<rgba.length;i+=4)if(Math.max(rgba[i]!,rgba[i+1]!,rgba[i+2]!)>8)visible++
      if(visible<c.width*c.height*.001)throw Error(`${mode} capture is blank (${visible} visible pixels)`)
      const output=document.createElement("canvas");output.width=c.width;output.height=c.height;output.getContext("2d")!.putImageData(new ImageData(rgba,c.width,c.height),0,0)
      if(a.sky.active!==(mode==="physical"))throw Error("Sky mode did not take effect")
      return output.toDataURL("image/png").split(",")[1]!
    },{game,mode})
    await Bun.write(resolve(out,`${game}-${mode}.png`),Buffer.from(png,"base64"))
  }
  await capture("today");await capture("physical")
  await page.evaluate(game=>{const a=(window as Probe)[game];a.sky.settings.skyMode="today";a.step(0);if(a.sky.active)throw Error("Today did not restore")},game)
  const report={game,viewport:[1920,1080],todayAssetRequests:0,requests,errors,returnedToToday:true}
  await Bun.write(resolve(out,`${game}.json`),JSON.stringify(report,null,2))
  if(errors.length)throw Error(errors.join("\n"))
  console.log(JSON.stringify(report))
} catch(error) {
  await Bun.write(resolve(out,`${game}.json`),JSON.stringify({game,requests,errors,failure:String(error)},null,2))
  console.error(JSON.stringify({errors,requests}));throw error
} finally {await browser.close();await server?.close();dist?.stop(true)}
