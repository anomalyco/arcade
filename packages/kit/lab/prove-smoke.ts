/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

const root=resolve(import.meta.dir,"../../.."),out=resolve(root,"captures/smoke-volume")
const baseline=process.env.SMOKE_BASELINE??"076fb7c"
mkdirSync(out,{recursive:true})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const originals=new Map(["fx/volume.ts","fx/volume-renderer.ts","fx/volume-shader.ts","lab/effects.ts"].map(p=>{
  const file=`packages/kit/${p}`
  const saved=resolve(root,".smoke-baseline",p)
  return [resolve(root,file),existsSync(saved)?readFileSync(saved,"utf8"):execFileSync("git",["show",`${baseline}:${file}`],{cwd:root,encoding:"utf8"})]
}))
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],report:Record<string,unknown>={source:baseline,viewport:[1280,800],dt:1/60,seed:7}
const live:{variant:string,page:Page,server:ViteDevServer}[]=[]
try {
  for(const variant of ["before","after"]){
    const dir=resolve(root,"games/lab")
    const server=await createServer({root:dir,configFile:resolve(dir,"vite.config.ts"),plugins:variant==="before"?[{name:"smoke-baseline",enforce:"pre",load(id){return originals.get(id)}}]:[],server:{host:"127.0.0.1",port:0}})
    await server.listen()
    const addr=server.httpServer!.address();assert(addr&&typeof addr!=="string")
    const page=await browser.newPage({viewport:{width:1280,height:800}})
    live.push({variant,page,server})
    page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
    await page.addInitScript(()=>{window.AudioContext=class {constructor(){throw new Error("Live audio is disabled in this proof")}} as any})
    try {
      await page.goto(`http://127.0.0.1:${addr.port}/?bench`)
      await page.waitForFunction(()=>!!(window as any).lab,undefined,{timeout:60000})
      await page.locator('[data-catalog-id="effects:smoke"]').click()
      await page.getByRole("button",{name:"Transport play",exact:true}).click()
      await page.getByRole("button",{name:"Transport loop",exact:true}).click()
      await page.getByRole("button",{name:"Frame target",exact:true}).click()
      const adapter=await page.evaluate(()=>{const a=(window as any).lab.adapter;return {architecture:a.architecture,vendor:a.vendor,device:a.device}})
      assert.match(adapter.architecture,/metal/i)
      // The transport step path temporarily unpauses the selected section, then restores pause.
      for(let f=1;f<=(process.argv.includes("--perf-only")?0:540);f++){
        await page.evaluate(async()=>{
          const l=(window as any).lab,s=l.sections.find((s:any)=>s.id==="effects")
          s.settings.playing=true;l.advance(1/60);s.settings.playing=false;await l.render()
        })
        if([20,40,80,160,360,440,500,540].includes(f))await page.screenshot({path:resolve(out,`${variant}-${f}.png`)})
        if(f<=240&&f%2===0)await page.locator("canvas").screenshot({path:resolve(out,`${variant}-clip-${String(f/2).padStart(3,"0")}.png`)})
      }
      // Paired whole-frame GPU interval + end-to-end wall clock, including upload and completion.
      const timing=await page.evaluate(async()=>{
        const l=(window as any).lab,s=l.sections.find((s:any)=>s.id==="effects")
        s.retrigger();s.settings.playing=true;l.advance(1/60);s.settings.playing=false
        for(let i=0;i<120;i++)l.context.volume.update(1/60)
        const runs=[]
        for(let i=0;i<8;i++){
          const gpu:number[]=[],whole:number[]=[]
          for(let j=0;j<20;j++){const t=performance.now();gpu.push(await l.render(true));await l.context.device.queue.onSubmittedWorkDone();whole.push(performance.now()-t)}
          if(i)runs.push({gpu,whole})
        }
        const v=l.context.volume
        return {runs,arrays:Object.fromEntries(Object.entries(v).filter(([,v])=>ArrayBuffer.isView(v)).map(([k,v]:any)=>[k,v.byteLength]))}
      })
      const controls=await page.evaluate(()=>{
        const r=document.querySelector('[data-lab]')!.shadowRoot!
        return [...r.querySelectorAll('[data-controls] [data-key]')].map(x=>x.getAttribute('data-key'))
      })
      if(variant==="after"){
        const before=await page.evaluate(()=>(window as any).lab.context.volume.time)
        await page.getByRole('slider',{name:'Extinction',exact:true}).fill('4')
        assert.equal(await page.evaluate(()=>(window as any).lab.context.volume.time),before,"Appearance does not retrigger")
        await page.getByRole('button',{name:'Reset Appearance',exact:true}).click()
        await page.getByRole('button',{name:'Randomize Shape',exact:true}).click()
        await page.getByRole('button',{name:'Reset Shape',exact:true}).click()
        await page.getByRole('button',{name:'Transport retrigger',exact:true}).click()
        await page.getByRole('button',{name:'Transport step',exact:true}).click()
        const preset=await page.evaluate(()=>JSON.parse((window as any).lab.workbench.exportPreset()))
        report.preset=preset
        await page.screenshot({path:resolve(out,"after-controls.png")})
        report.shaderProbe=await page.evaluate(async root=>{
          const l=(window as any).lab,v=l.context.volume,r=l.context.stage.volume,d=l.context.device as GPUDevice
          const path=`/@fs${root}/packages/kit/fx/volume-shader.ts`
          const {volumeShader}=await import(/* @vite-ignore */path)
          const code=volumeShader+`\n@group(1) @binding(0) var<storage,read_write> result: array<f32>;
            @compute @workgroup_size(1) fn probe(){
              result[0]=density(vec3f(0.26,0.3,0.26)).x;
              result[1]=density(vec3f(0,0.3,0)).x;
              result[2]=density(vec3f(0.76,0.3,0)).x;
            }`
          const pipeline=d.createComputePipeline({layout:"auto",compute:{module:d.createShaderModule({code}),entryPoint:"probe"}})
          const output=d.createBuffer({size:12,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC})
          const read=d.createBuffer({size:12,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
          const frame=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.buffer}},{binding:1,resource:r.field.createView({dimension:"2d-array"})}]})
          const result=d.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:output}}]})
          const probe=async()=>{
            r.upload(v)
            const enc=d.createCommandEncoder(),pass=enc.beginComputePass()
            pass.setPipeline(pipeline);pass.setBindGroup(0,frame);pass.setBindGroup(1,result);pass.dispatchWorkgroups(1);pass.end()
            enc.copyBufferToBuffer(output,0,read,0,12);d.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ)
            const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();return values
          }
          v.reset([[0.26,-20,0.74,0.24],[-20,0.26,0.24,0.74]]);v.spawn(0,0,6,12);v.update(3)
          const corner=await probe()
          if(corner[0]!==0||corner[1]<=0)throw new Error(`Shader corner leak: ${corner}`)
          v.reset([]);v.spawn(0,0,6,12);v.update(0.2)
          const front=await probe()
          if(!(front[2]>0&&front[2]<0.1))throw new Error(`Shader clipped empty-cell front: ${front}`)
          output.destroy();read.destroy()
          return {corner,front}
        },root)
      }
      report[variant]={adapter,timing,controls}
    }catch(error){throw error}
  }
  // Alternate seven measured pairs after a warmup pair. A queue marker submitted BEFORE
  // simulation/upload captures the whole dependent queue interval, including queue.writeTexture.
  // This includes CPU-fed queue idle time: it is not summed render-pass GPU busy time.
  for(const {page} of live)await page.evaluate(()=>{
    const l=(window as any).lab,s=l.sections.find((s:any)=>s.id==="effects")
    s.retrigger();s.settings.playing=false;l.context.volume.update(2)
    const d=l.context.device as GPUDevice
    const queries=d.createQuerySet({type:"timestamp",count:2})
    const resolve=d.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC})
    const read=d.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
    const marker=d.createComputePipeline({layout:"auto",compute:{module:d.createShaderModule({code:"@group(0) @binding(0) var<storage,read_write> value: u32; @compute @workgroup_size(1) fn main(){value=value+1u;}"}),entryPoint:"main"}})
    const storage=d.createBuffer({size:4,usage:GPUBufferUsage.STORAGE})
    const group=d.createBindGroup({layout:marker.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:storage}}]})
    ;(window as any).smokeMeasure=async()=>{
      const start=performance.now(),a=d.createCommandEncoder()
      const first=a.beginComputePass({timestampWrites:{querySet:queries,beginningOfPassWriteIndex:0}})
      first.setPipeline(marker);first.setBindGroup(0,group);first.dispatchWorkgroups(1);first.end()
      d.queue.submit([a.finish()])
      l.context.volume.update(0)
      const renderGpu=await l.render(true)
      const b=d.createCommandEncoder()
      const last=b.beginComputePass({timestampWrites:{querySet:queries,endOfPassWriteIndex:1}})
      last.setPipeline(marker);last.setBindGroup(0,group);last.dispatchWorkgroups(1);last.end()
      b.resolveQuerySet(queries,0,2,resolve,0);b.copyBufferToBuffer(resolve,0,read,0,16)
      d.queue.submit([b.finish()]);await read.mapAsync(GPUMapMode.READ)
      const stamps=new BigUint64Array(read.getMappedRange()),queueMs=Number(stamps[1]-stamps[0])/1e6
      if(!(queueMs>0))throw new Error(`Invalid whole-queue timestamp interval: ${queueMs}`)
      read.unmap()
      return {queueMs,renderGpu,wholeMs:performance.now()-start}
    }
  })
  const pairs=[]
  for(let pair=0;pair<8;pair++){
    const row:Record<string,unknown>={}
    for(const {variant,page} of pair%2?[...live].reverse():live){
      await page.bringToFront()
      row[variant]=await page.evaluate(async()=>{const samples=[];for(let i=0;i<20;i++)samples.push(await (window as any).smokeMeasure());return samples})
    }
    if(pair)pairs.push(row)
  }
  report.paired=pairs
  assert.deepEqual(errors,[])
  writeFileSync(resolve(out,"report.json"),JSON.stringify(report,null,2))
  console.log(JSON.stringify({out,errors}))
}finally{await browser.close();for(const {server} of live)await server.close()}
