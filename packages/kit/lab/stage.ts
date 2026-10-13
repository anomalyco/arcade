import { FrameTimer } from "../fx/frame-timer"
import { ParticleRenderer } from "../fx/particle-renderer"
import type { Particles } from "../fx/particles"
import { SmokeRenderer } from "../fx/tyre-renderer"
import type { SmokeTrail } from "../fx/smoke-trail"
import { VolumeRenderer } from "../fx/volume-renderer"
import type { SmokeVolumes, Wall } from "../fx/volume"
import { polarShader, stageShader } from "./stage-shader"
import { lightingDefaults } from "./lighting"

export const walls:readonly Wall[]=[[-6,-4,6,-3.6],[-6,-4,-5.6,5],[5.6,-4,6,-1],[5.6,1,6,5],[-6,4.6,6,5]]
const lightX=[-4,4,-4,4,0,0,-7,7],lightZ=[-2,2,3,-3,-6,6,0,0]
const tyreCommon=/* wgsl */`
struct Frame { viewProj:mat4x4f,cam:vec4f,screen:vec4f,moonDir:vec4f }
struct Light {pos:vec4f,color:vec4f,dir:vec4f}
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<storage,read> lights:array<Light>;
`
export type CameraWriter=(width:number,height:number,vp:Float32Array,inverse:Float32Array,eye:Float32Array)=>void
export class Stage {
  readonly lighting=lightingDefaults()
  readonly particles:ParticleRenderer
  readonly volume:VolumeRenderer
  readonly device:GPUDevice
  private readonly tyre:SmokeRenderer
  private readonly tyreBuffer:GPUBuffer
  private readonly tyreLights:GPUBuffer
  private readonly tyreGroup:GPUBindGroup
  private readonly tyreFrame=new Float32Array(28)
  private readonly frame=new Float32Array(148)
  private readonly inverse=this.frame.subarray(0,16)
  readonly viewProj=this.frame.subarray(16,32)
  readonly eye=this.frame.subarray(32,35)
  private readonly lightData=this.frame.subarray(52)
  private readonly buffer:GPUBuffer
  private readonly group:GPUBindGroup
  private readonly computeGroup:GPUBindGroup
  private readonly polar:GPUComputePipeline
  private readonly scene:GPURenderPipeline
  private readonly post:GPURenderPipeline
  private readonly postLayout:GPUBindGroupLayout
  private postGroup!:GPUBindGroup
  private textures:GPUTexture[]=[]
  private hdr!:GPUTextureView
  private output!:GPUTexture
  private outputView!:GPUTextureView
  private scenePass!:GPURenderPassDescriptor
  private readonly timer:FrameTimer|null
  private width=0;private height=0
  gpuMs:number|null=null
  lightCount=0
  sceneMode=0
  private measuring=false
  private frames=0
  constructor(device:GPUDevice,private readonly context:GPUCanvasContext,private readonly format:GPUTextureFormat,private readonly camera:CameraWriter){
    const d=this.device=device
    this.particles=new ParticleRenderer(d);this.volume=new VolumeRenderer(d)
    this.buffer=d.createBuffer({size:this.frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    const polarBuffer=d.createBuffer({size:8*256*9*16,usage:GPUBufferUsage.STORAGE})
    const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"read-only-storage"}}]})
    this.group=d.createBindGroup({layout,entries:[{binding:0,resource:{buffer:this.buffer}},{binding:1,resource:{buffer:polarBuffer}}]})
    const computeLayout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}]})
    this.computeGroup=d.createBindGroup({layout:computeLayout,entries:[{binding:0,resource:{buffer:this.buffer}},{binding:1,resource:{buffer:polarBuffer}}]})
    this.polar=d.createComputePipeline({layout:d.createPipelineLayout({bindGroupLayouts:[computeLayout]}),compute:{module:d.createShaderModule({code:polarShader,label:"Lab polar"}),entryPoint:"cs"}})
    const module=d.createShaderModule({code:stageShader,label:"Lab stage"})
    this.scene=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[layout]}),vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint:"fs",targets:[{format:"rgba16float"}]},depthStencil:{format:"depth24plus",depthCompare:"always",depthWriteEnabled:true},multisample:{count:4}})
    this.postLayout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{}}]})
    this.post=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[layout,this.postLayout]}),vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint:"post",targets:[{format}]}})
    const tyreLayout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"read-only-storage"}}]})
    this.tyre=new SmokeRenderer(d,tyreLayout,tyreCommon,"depth24plus")
    this.tyreBuffer=d.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    this.tyreLights=d.createBuffer({size:8*48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})
    this.tyreGroup=d.createBindGroup({layout:tyreLayout,entries:[{binding:0,resource:{buffer:this.tyreBuffer}},{binding:1,resource:{buffer:this.tyreLights}}]})
    this.timer=d.features.has("timestamp-query")?new FrameTimer(d):null
  }
  resize(width:number,height:number){
    if(width===this.width&&height===this.height)return
    this.width=width;this.height=height
    for(const t of this.textures)t.destroy()
    const d=this.device,usage=GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING
    const hdr=d.createTexture({size:[width,height],format:"rgba16float",usage})
    const msaa=d.createTexture({size:[width,height],format:"rgba16float",sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT})
    const depth=d.createTexture({size:[width,height],format:"depth24plus",sampleCount:4,usage})
    this.output=d.createTexture({size:[width,height],format:this.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC})
    this.outputView=this.output.createView()
    this.textures=[hdr,msaa,depth,this.output];this.hdr=hdr.createView();const depthView=depth.createView()
    this.scenePass={colorAttachments:[{view:msaa.createView(),resolveTarget:this.hdr,loadOp:"clear",storeOp:"discard",clearValue:{r:0,g:0,b:0,a:1}}],depthStencilAttachment:{view:depthView,depthLoadOp:"clear",depthStoreOp:"store",depthClearValue:1}}
    this.volume.resize(width,height,depthView)
    this.postGroup=d.createBindGroup({layout:this.postLayout,entries:[{binding:0,resource:this.hdr}]})
    this.camera(width,height,this.viewProj,this.inverse,this.eye)
    this.volume.uniforms.set(this.inverse);this.volume.uniforms.set(this.eye,16)
    this.particles.uniforms.set(this.viewProj);this.particles.uniforms.set(this.eye,16)
    this.tyreFrame.set(this.viewProj);this.tyreFrame.set(this.eye,16);this.tyreFrame[20]=width;this.tyreFrame[21]=height
  }
  private uploadLighting(debug:number){
    const s=this.lighting,f=this.frame,deg=Math.PI/180,count=Math.max(0,Math.min(8,Math.round(s.count)))
    f[36]=count;f[37]=Number(s.shadows);f[38]=debug;f[39]=this.sceneMode
    f[40]=Math.cos(s.moonAzimuth*deg)*Math.cos(s.moonElevation*deg);f[41]=Math.sin(s.moonElevation*deg);f[42]=Math.sin(s.moonAzimuth*deg)*Math.cos(s.moonElevation*deg);f[43]=s.moon?s.moonPower:0
    f[44]=s.exposure;f[45]=s.tone;f[46]=s.saturation;f[47]=s.temperature
    f[48]=0.06;f[49]=0.08;f[50]=0.13
    this.lightCount=0
    for(let i=0;i<8;i++){
      const o=i*12,spot=i===1,cool=i%2===1
      this.lightData[o]=lightX[i]!;this.lightData[o+1]=s.lampHeight;this.lightData[o+2]=lightZ[i]!;this.lightData[o+3]=s.lampRadius
      this.lightData[o+4]=cool?0.28:1.8;this.lightData[o+5]=cool?0.85:0.95;this.lightData[o+6]=cool?1.6:0.4
      const power=spot?(s.spot?s.spotPower:0):(s.lamps?s.lampPower:0)
      this.lightData[o+7]=i<count?power:0
      this.lightData[o+8]=Math.sin(s.spotYaw*deg)*Math.cos(s.spotPitch*deg);this.lightData[o+9]=-Math.sin(s.spotPitch*deg);this.lightData[o+10]=Math.cos(s.spotYaw*deg)*Math.cos(s.spotPitch*deg);this.lightData[o+11]=spot?Math.cos(s.spotAngle*deg):-2
      if(i<count&&power>0)this.lightCount++
      for(let j=0;j<8;j++){this.volume.uniforms[60+i*8+j]=this.lightData[o+j]!;this.particles.uniforms[24+i*8+j]=this.lightData[o+j]!}
    }
    this.volume.uniforms[22]=count;this.volume.uniforms[24]=0.08;this.volume.uniforms[25]=0.10;this.volume.uniforms[26]=0.15
    this.particles.uniforms[20]=0.25;this.particles.uniforms[21]=0.30;this.particles.uniforms[22]=0.42;this.particles.uniforms[23]=count
    this.tyreFrame[22]=count;for(let i=0;i<4;i++)this.tyreFrame[24+i]=f[40+i]!
    this.device.queue.writeBuffer(this.buffer,0,f);this.device.queue.writeBuffer(this.tyreLights,0,this.lightData)
  }
  async render(particles:Particles,volumes:SmokeVolumes,trail:SmokeTrail,debug:number,measure=false,draw?:(pass:GPURenderPassEncoder)=>void){
    if(this.measuring)return null
    const timed=!!this.timer&&(measure||this.frames++%45===0)
    this.uploadLighting(debug)
    this.particles.uniforms[19]=debug;this.volume.debug=debug
    this.particles.upload(particles);trail.prepare(6);this.tyre.upload(trail,6,true)
    this.tyreFrame[19]=volumes.time;this.device.queue.writeBuffer(this.tyreBuffer,0,this.tyreFrame)
    const enc=this.device.createCommandEncoder(),shadow=this.lighting.shadows&&this.lighting.count>0
    if(shadow){const p=enc.beginComputePass({timestampWrites:timed?this.timer!.start:undefined});p.setPipeline(this.polar);p.setBindGroup(0,this.computeGroup);p.dispatchWorkgroups(Math.ceil(Math.min(8,this.lighting.count)*256/64));p.end()}
    this.scenePass.timestampWrites=timed&&!shadow?this.timer!.start:undefined
    const pass=enc.beginRenderPass(this.scenePass);pass.setPipeline(this.scene);pass.setBindGroup(0,this.group);pass.draw(3)
    if(debug!==5){pass.setBindGroup(0,this.tyreGroup);this.tyre.draw(pass)}
    this.particles.draw(pass);draw?.(pass);pass.end()
    if(debug!==5)this.volume.render(enc,this.hdr,volumes)
    const output=this.outputView
    const post=enc.beginRenderPass({colorAttachments:[{view:output,loadOp:"clear",storeOp:"store",clearValue:{r:0,g:0,b:0,a:1}}]})
    post.setPipeline(this.post);post.setBindGroup(0,this.group);post.setBindGroup(1,this.postGroup);post.draw(3);post.end()
    if(timed)this.timer!.finish(enc,output)
    enc.copyTextureToTexture({texture:this.output},{texture:this.context.getCurrentTexture()},[this.width,this.height])
    this.device.queue.submit([enc.finish()])
    if(timed){this.measuring=true;try{this.gpuMs=await this.timer!.collect()}finally{this.measuring=false}}
    return timed?this.gpuMs:null
  }
}
