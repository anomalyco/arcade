/** GPU instrument, not a second sky implementation. Uses the production SkyPass without a game. */
import { mat4 } from "wgpu-matrix"
import { SkyPass } from "../../packages/kit/sky/pass"
import { loadSkyAssets } from "../../packages/kit/sky/assets"
import { createSkySettings } from "../../packages/kit/sky/settings"
import { skyShader } from "../../packages/kit/sky/shaders"
import { TemporalResolve, TEMPORAL_DEFAULTS, jitterViewProj } from "../../packages/kit/gpu/temporal"
import { equatorialBasis, moonLight } from "../../packages/kit/sky/model"

async function main() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) throw new Error("WebGPU adapter missing")
  const timestamps = adapter.features.has("timestamp-query")
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ["timestamp-query"] : [] })
  const errors: string[] = []
  device.addEventListener("uncapturederror", event => errors.push(event.error.message))
  const module = device.createShaderModule({ code: skyShader })
  const info = await module.getCompilationInfo()
  if (info.messages.some(m => m.type === "error")) throw new Error(info.messages.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join("\n"))
  const canvas = document.querySelector<HTMLCanvasElement>("#sky")!
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const width = canvas.width, height = canvas.height
  const frame = new Float32Array(48)
  const frameBuffer = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const frameLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] })
  const frameBind = device.createBindGroup({ layout: frameLayout, entries: [{ binding: 0, resource: { buffer: frameBuffer } }] })
  const hdr = device.createTexture({ size: [width,height], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC })
  const msaa = device.createTexture({ size: [width,height], sampleCount: 4, format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT })
  const depth = device.createTexture({ size: [width,height], sampleCount: 4, format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
  const assets = await loadSkyAssets(device)
  const settings = createSkySettings({ skyMode: "physical", skyScintillation: 0 })
  const passContext = { device, frameLayout, color: "rgba16float" as const, depth: "depth24plus" as const, samples: 4 }
  const sky = new SkyPass(passContext,assets,settings)
  const outputModule = device.createShaderModule({ code: `
    @group(0) @binding(0) var image:texture_2d<f32>;
    struct V { @builtin(position) pos:vec4f }
    @vertex fn vs(@builtin(vertex_index) i:u32)->V {return V(vec4f(vec2f(f32((i<<1u)&2u),f32(i&2u))*2.0-1.0,0,1));}
    @fragment fn fs(v:V)->@location(0) vec4f {let c=textureLoad(image,vec2i(v.pos.xy),0).rgb*1.6;return vec4f(pow(c/(1.0+c),vec3f(1.0/2.2)),1);}` })
  const outputPipeline = device.createRenderPipeline({ layout: "auto", vertex: { module: outputModule, entryPoint: "vs" }, fragment: { module: outputModule, entryPoint: "fs", targets: [{ format }] } })
  const outputBind = device.createBindGroup({ layout: outputPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: hdr.createView() }] })
  const query = timestamps ? device.createQuerySet({ type: "timestamp", count: 2 }) : undefined
  const queryResolve = timestamps ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : undefined
  const queryRead = timestamps ? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : undefined
  const projection = mat4.perspective(70*Math.PI/180,width/height,0.1,300)
  const eye = [0,1.65,0]
  let yaw = 0, pitch = 0.65, time = 0, units = 1
  function camera(offset = 0) {
    const direction = [-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)]
    const vp = mat4.multiply(projection,mat4.lookAt(eye,eye.map((n,i) => n+direction[i]!),[0,1,0]))
    for (let col = 0; col < 4; col++) vp[col*4] = vp[col*4]!+offset*2/width*vp[col*4+3]!
    frame.set(vp); frame.set(eye,16); frame[20]=width; frame[21]=height
    device.queue.writeBuffer(frameBuffer,0,frame)
  }
  function draw(offset = 0, target = sky, measure = false, temporal?: TemporalResolve) {
    camera(offset)
    if (temporal) {
      const [jx,jy]=temporal.begin(frame,{...TEMPORAL_DEFAULTS,mode:"taa",sharpen:0},false,true)
      jitterViewProj(frame,jx,jy,width,height)
      device.queue.writeBuffer(frameBuffer,0,frame)
    }
    target.update({ time, sceneUnitsPerCdM2: units })
    const encoder = device.createCommandEncoder()
    const render = encoder.beginRenderPass({ colorAttachments: [{ view: msaa.createView(), resolveTarget: hdr.createView(), clearValue: [0,0,0,1], loadOp: "clear", storeOp: "discard" }], depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: temporal ? "store" : "discard" }, ...(measure && query ? { timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}) })
    render.setBindGroup(0,frameBind); target.draw(render); render.end()
    if(temporal) {
      const reactive=encoder.beginRenderPass({colorAttachments:[{view:temporal.reactiveView,clearValue:[0,0,0,0],loadOp:"clear",storeOp:"store"}]});reactive.end()
      temporal.encode(encoder,hdr.createView(),depth.createView(),false)
    }
    const out = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: [0,0,0,1], loadOp: "clear", storeOp: "store" }] })
    out.setPipeline(outputPipeline); out.setBindGroup(0,temporal ? device.createBindGroup({layout:outputPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:temporal.outputView}]}) : outputBind); out.draw(3); out.end()
    if (measure && query) { encoder.resolveQuerySet(query,0,2,queryResolve!,0); encoder.copyBufferToBuffer(queryResolve!,0,queryRead!,0,16) }
    device.queue.submit([encoder.finish()])
  }
  const half = (n: number) => { const e=(n>>10)&31,m=n&1023; return (n&32768?-1:1)*(e===0 ? m*2**-24 : e===31 ? Infinity : (1+m/1024)*2**(e-15)) }
  async function readCentre(texture = hdr) {
    const size=32, row=256
    const buffer=device.createBuffer({size:row*size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
    const encoder=device.createCommandEncoder()
    encoder.copyTextureToBuffer({texture,origin:[width/2-size/2,height/2-size/2]}, {buffer,bytesPerRow:row}, [size,size])
    device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ)
    const data=new Uint16Array(buffer.getMappedRange()); let sum=0,moment=0
    for(let i=0;i<data.length;i+=4) { const l=half(data[i]!)*0.2126+half(data[i+1]!)*0.7152+half(data[i+2]!)*0.0722;sum+=l;moment+=l*((i/4)%size+0.5) }
    buffer.unmap();buffer.destroy();return {sum,centroidX:moment/sum}
  }
  async function measure() {
    if(!queryRead) throw new Error("Hardware timestamp queries unavailable")
    const results:{mode:string;ms:number}[]=[]
    for(let i=0;i<20;i++) draw()
    await device.queue.onSubmittedWorkDone()
    for(let i=0;i<14;i++) for(const mode of (i%2 ? ["physical","today"] : ["today","physical"]) as ("physical"|"today")[]) {
      settings.skyMode=mode;draw(0,sky,true)
      await queryRead.mapAsync(GPUMapMode.READ)
      const t=new BigUint64Array(queryRead.getMappedRange());results.push({mode,ms:Number(t[1]!-t[0]!)/1e6});queryRead.unmap()
    }
    settings.skyMode="physical";draw()
    return results
  }
  async function stability() {
    // Zenith test star at the zenith's equatorial coordinate (date/precession disabled by using J2000).
    const testSettings=createSkySettings({skyMode:"physical",skyVision:"photometric",skyYear:2000,skyDay:1,skyHour:12,skyLatitude:90,skyLongitude:0,skyAirglow:0,skyMilkyWay:0,skyZodiacal:0,skyScintillation:0})
    const testSky=new SkyPass(passContext,{...assets,stars:[{id:424,ra:0,dec:Math.PI/2,magnitude:0,temperature:5778,pmRa:0,pmDec:0}]},testSettings)
    const savedPitch=pitch;pitch=Math.PI/2-0.000001
    const results:Record<string,{samples:number[];relativePeakToPeak:number;mean:number}>={}
    try {
      for(const vision of ["photometric","adapted"] as const) {
        testSettings.skyVision=vision
        const samples:number[]=[]
        for(let i=0;i<32;i++) { draw(i/32,testSky);const on=await readCentre();testSettings.skyStars=0;draw(i/32,testSky);const off=await readCentre();testSettings.skyStars=1;samples.push(on.sum-off.sum) }
        const mean=samples.reduce((a,b)=>a+b,0)/samples.length
        const variation=(Math.max(...samples)-Math.min(...samples))/mean
        if(!Number.isFinite(variation)||variation>0.01) throw new Error(`${vision} star flux variation ${(variation*100).toFixed(3)}% exceeds 1%`)
        results[vision]={samples,relativePeakToPeak:variation,mean}
      }
      return results
    } finally { pitch=savedPitch;testSky.dispose();draw() }
  }
  async function temporalTranslation() {
    const testSettings=createSkySettings({skyMode:"physical",skyYear:2000,skyDay:1,skyHour:12,skyLatitude:90,skyAirglow:0,skyMilkyWay:0,skyZodiacal:0,skyScintillation:0})
    const testSky=new SkyPass(passContext,{...assets,stars:[{id:424,ra:0,dec:Math.PI/2,magnitude:0,temperature:5778,pmRa:0,pmDec:0}]},testSettings)
    const taa=new TemporalResolve(device,"rgba16float",4);taa.resize(width,height,width,height)
    const savedPitch=pitch;pitch=Math.PI/2-0.000001
    try {
      for(let i=0;i<64;i++) { draw(0,testSky,false,taa);await device.queue.onSubmittedWorkDone() }
      const still=await readCentre(taa.output)
      for(let i=0;i<64;i++) {eye[0]=i+1;draw(0,testSky,false,taa);await device.queue.onSubmittedWorkDone()}
      const translated=await readCentre(taa.output),drift=Math.abs(still.centroidX-translated.centroidX)
      if(!Number.isFinite(drift)||drift>0.05)throw new Error(`Infinite-sky TAA drift ${drift}px after 64 m translation`)
      return {still,translated,centroidDriftPixels:drift,translationMetres:64}
    } finally {eye[0]=0;pitch=savedPitch;testSky.dispose();draw()}
  }
  async function occultation() {
    const s=createSkySettings({skyMode:"physical",skyMoon:"crescent",skyScintillation:0})
    const direction=moonLight(s).direction
    const eq=equatorialBasis(s).map(axis=>axis.reduce((sum,v,i)=>sum+v*direction[i]!,0))
    const testSky=new SkyPass(passContext,{...assets,stars:[{id:425,ra:Math.atan2(eq[1]!,eq[0]!),dec:Math.asin(eq[2]!),magnitude:0,temperature:5778,pmRa:0,pmDec:0}]},s)
    const saved={yaw,pitch};yaw=-s.skyMoonAzimuth*Math.PI/180;pitch=s.skyMoonAltitude*Math.PI/180
    const energies: Record<string,number>={}
    try {
      for(const phase of ["none","crescent"] as const) {
        s.skyMoon=phase;s.skyStars=1;draw(0,testSky);const on=await readCentre()
        s.skyStars=0;draw(0,testSky);const off=await readCentre()
        energies[phase]=on.sum-off.sum
      }
      const fraction=energies.crescent!/energies.none!
      if(!(energies.none!>0.1)||!Number.isFinite(fraction)||fraction>0.02||fraction<0) throw new Error(`Lunar occultation leaked ${fraction} of the background star`)
      return {energies,transmittedFraction:fraction}
    } finally {yaw=saved.yaw;pitch=saved.pitch;testSky.dispose();draw()}
  }
  draw();await device.queue.onSubmittedWorkDone()
  if(errors.length) throw new Error(errors.join("\n"))
  Object.assign(window,{skyProof:{settings,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description},timestamps,errors,measure,stability,temporalTranslation,occultation,
    draw:async(values:Partial<typeof settings>={},view?:{yaw?:number;pitch?:number;time?:number;units?:number})=>{Object.assign(settings,values);yaw=view?.yaw??yaw;pitch=view?.pitch??pitch;time=view?.time??time;units=view?.units??units;draw();await device.queue.onSubmittedWorkDone()},
  }})
}
void main().catch(error=>{console.error(error);document.body.dataset.error=String(error)})
