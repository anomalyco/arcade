import { FrameTimer } from "../fx/frame-timer"
import { ParticleRenderer } from "../fx/particle-renderer"
import type { Particles } from "../fx/particles"
import { SmokeRenderer } from "../fx/tyre-renderer"
import type { SmokeTrail } from "../fx/smoke-trail"
import { VolumeRenderer } from "../fx/volume-renderer"
import type { SmokeVolumes, Wall } from "../fx/volume"

export const walls:readonly Wall[]=[[-6,-4,6,-3.6],[-6,-4,-5.6,5],[5.6,-4,6,-1],[5.6,1,6,5],[-6,4.6,6,5]]
const shader=/* wgsl */`
struct Frame { inverse:mat4x4f, vp:mat4x4f, eye:vec4f }
@group(0) @binding(0) var<uniform> F:Frame;
struct Box { lo:vec3f, hi:vec3f }
const boxes=array<Box,9>(
  Box(vec3f(-6,0,-4),vec3f(6,2.2,-3.6)),Box(vec3f(-6,0,-4),vec3f(-5.6,2.2,5)),
  Box(vec3f(5.6,0,-4),vec3f(6,2.2,-1)),Box(vec3f(5.6,0,1),vec3f(6,2.2,5)),Box(vec3f(-6,0,4.6),vec3f(6,0.65,5)),
  Box(vec3f(-3.5,0.2,-0.8),vec3f(-0.5,0.85,0.8)),Box(vec3f(-2.7,0.85,-0.65),vec3f(-1.1,1.4,0.65)),
  Box(vec3f(2.5,0,0.7),vec3f(3,1.3,1.2)),Box(vec3f(2.55,1.3,0.75),vec3f(2.95,1.7,1.15)));
fn intersect(origin:vec3f,ray:vec3f,b:Box)->f32 {
  let a=(b.lo-origin)/ray;let c=(b.hi-origin)/ray;let lo=min(a,c);let hi=max(a,c);
  let near=max(max(lo.x,lo.y),lo.z);let far=min(min(hi.x,hi.y),hi.z);
  return select(10000.0,max(near,0.0),near<far&&far>0.0);
}
struct Out {@builtin(position) p:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index)i:u32)->Out {let c=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.p=vec4f(c[i],0,1);o.uv=c[i]*vec2f(0.5,-0.5)+0.5;return o;}
struct Pixel {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn fs(o:Out)->Pixel {
  let q=F.inverse*vec4f(o.uv*vec2f(2,-2)+vec2f(-1,1),1,1);let ray=normalize(q.xyz/q.w-F.eye.xyz);
  var hit=-F.eye.y/ray.y;var index=-1;
  for(var i=0;i<9;i++){let d=intersect(F.eye.xyz,ray,boxes[i]);if(d<hit){hit=d;index=i;}}
  let p=F.eye.xyz+ray*hit;var normal=vec3f(0,1,0);var albedo=vec3f(0.18,0.21,0.26);
  if(index>=0){let b=boxes[index];let mid=(b.lo+b.hi)*0.5;let r=(p-mid)/((b.hi-b.lo)*0.5);let m=max(max(abs(r.x),abs(r.y)),abs(r.z));normal=select(vec3f(0),sign(r),abs(r)>=vec3f(m-0.002));albedo=vec3f(0.3,0.34,0.38);if(index==5){albedo=vec3f(0.06,0.22,0.26);}if(index==6){albedo=vec3f(0.035,0.08,0.11);}if(index>=7){albedo=vec3f(0.42,0.32,0.17);}}
  let lamps=array<vec3f,2>(vec3f(-4,3,-2),vec3f(4,3,2));let colors=array<vec3f,2>(vec3f(1.8,0.95,0.4),vec3f(0.28,0.85,1.6));
  var light=vec3f(0.10,0.14,0.23)*(0.5+0.5*max(normal.y,0.0));
  for(var l=0;l<2;l++){let delta=lamps[l]-p;let distance=length(delta);let direction=delta/distance;var shadow=1.0;for(var b=0;b<9;b++){if(intersect(p+normal*0.02,direction,boxes[b])<distance){shadow=0.18;}}light+=colors[l]*pow(max(0.0,1.0-distance/10.0),2.0)*max(0.0,dot(normal,direction))*shadow;}
  let grid=select(1.0,0.72,min(fract(p.x),fract(p.z))<0.025&&index<0);
  var rgb=albedo*light*grid;
  for(var l=0;l<2;l++){rgb+=colors[l]*pow(max(0.0,1.0-distance(p.xz,lamps[l].xz)/0.16),3.0)*1.5;}
  let clip=F.vp*vec4f(p,1);var out:Pixel;out.color=vec4f(rgb,1);out.depth=clip.z/clip.w;return out;
}
@group(1) @binding(0) var hdr:texture_2d<f32>;
@fragment fn post(o:Out)->@location(0) vec4f {let p=vec2i(o.uv*vec2f(textureDimensions(hdr)));let c=textureLoad(hdr,p,0).rgb;return vec4f(pow(c/(c+0.8),vec3f(1.0/2.2)),1);}
`
const tyreCommon=/* wgsl */`
struct Frame { viewProj:mat4x4f,cam:vec4f,screen:vec4f,moonDir:vec4f }
struct Light {pos:vec4f,color:vec4f,dir:vec4f}
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<storage,read> lights:array<Light>;
`
export type CameraWriter=(width:number,height:number,vp:Float32Array,inverse:Float32Array,eye:Float32Array)=>void
export class Stage {
  readonly particles:ParticleRenderer
  readonly volume:VolumeRenderer
  private readonly tyre:SmokeRenderer
  private readonly tyreBuffer:GPUBuffer
  private readonly tyreGroup:GPUBindGroup
  private readonly tyreFrame=new Float32Array(28)
  private readonly frame=new Float32Array(36)
  private readonly inverse=this.frame.subarray(0,16)
  private readonly vp=this.frame.subarray(16,32)
  private readonly eye=this.frame.subarray(32,35)
  private readonly buffer:GPUBuffer
  private readonly group:GPUBindGroup
  private readonly scene:GPURenderPipeline
  private readonly post:GPURenderPipeline
  private readonly postLayout:GPUBindGroupLayout
  private postGroup!:GPUBindGroup
  private textures:GPUTexture[]=[]
  private hdr!:GPUTextureView
  private scenePass!:GPURenderPassDescriptor
  private readonly timer:FrameTimer|null
  private width=0;private height=0
  gpuMs:number|null=null
  private measuring=false
  private frames=0
  constructor(private readonly device:GPUDevice,private readonly context:GPUCanvasContext,format:GPUTextureFormat,private readonly camera:CameraWriter){
    const d=device
    this.particles=new ParticleRenderer(d);this.volume=new VolumeRenderer(d)
    this.buffer=d.createBuffer({size:144,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}}]})
    this.group=d.createBindGroup({layout,entries:[{binding:0,resource:{buffer:this.buffer}}]})
    const module=d.createShaderModule({code:shader,label:"FX stage"})
    this.scene=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[layout]}),vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint:"fs",targets:[{format:"rgba16float"}]},depthStencil:{format:"depth24plus",depthCompare:"always",depthWriteEnabled:true},multisample:{count:4}})
    this.postLayout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{}}]})
    this.post=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[layout,this.postLayout]}),vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint:"post",targets:[{format}]}})
    const tyreLayout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"read-only-storage"}}]})
    this.tyre=new SmokeRenderer(d,tyreLayout,tyreCommon,"depth24plus")
    this.tyreBuffer=d.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    const lights=d.createBuffer({size:96,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})
    d.queue.writeBuffer(lights,0,new Float32Array([-4,3,-2,10,1.8,0.95,0.4,2,0,0,0,-2,4,3,2,10,0.28,0.85,1.6,2,0,0,0,-2]))
    this.tyreGroup=d.createBindGroup({layout:tyreLayout,entries:[{binding:0,resource:{buffer:this.tyreBuffer}},{binding:1,resource:{buffer:lights}}]})
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
    this.textures=[hdr,msaa,depth];this.hdr=hdr.createView();const depthView=depth.createView()
    this.scenePass={colorAttachments:[{view:msaa.createView(),resolveTarget:this.hdr,loadOp:"clear",storeOp:"discard",clearValue:{r:0,g:0,b:0,a:1}}],depthStencilAttachment:{view:depthView,depthLoadOp:"clear",depthStoreOp:"store",depthClearValue:1}}
    this.volume.resize(width,height,depthView)
    this.postGroup=d.createBindGroup({layout:this.postLayout,entries:[{binding:0,resource:this.hdr}]})
    this.camera(width,height,this.vp,this.inverse,this.eye);d.queue.writeBuffer(this.buffer,0,this.frame)
    this.volume.uniforms.set(this.inverse);this.volume.uniforms.set(this.eye,16)
    this.volume.uniforms.set([0.08,0.10,0.15,0],24);this.volume.uniforms[22]=2
    this.volume.uniforms.set([-4,3,-2,10,1.8,0.95,0.4,1.5,4,3,2,10,0.28,0.85,1.6,1.5],60)
    this.particles.uniforms.set(this.vp);this.particles.uniforms.set(this.eye,16);this.particles.uniforms.set([0.25,0.30,0.42,2],20)
    this.particles.uniforms.set([-4,3,-2,10,1.8,0.95,0.4,2,4,3,2,10,0.28,0.85,1.6,2],24)
    this.tyreFrame.set(this.vp);this.tyreFrame.set(this.eye,16);this.tyreFrame.set([width,height,2,0,0.3,0.9,0.2,1],20)
  }
  async render(particles:Particles,volumes:SmokeVolumes,trail:SmokeTrail,debug:number,measure=false){
    if(this.measuring)return null
    const timed=!!this.timer&&(measure||this.frames++%45===0)
    this.particles.uniforms[19]=debug;this.volume.debug=debug
    this.particles.upload(particles);trail.prepare(6);this.tyre.upload(trail,6,true)
    this.tyreFrame[19]=volumes.time;this.device.queue.writeBuffer(this.tyreBuffer,0,this.tyreFrame)
    const enc=this.device.createCommandEncoder()
    this.scenePass.timestampWrites=timed?this.timer!.start:undefined
    const pass=enc.beginRenderPass(this.scenePass);pass.setPipeline(this.scene);pass.setBindGroup(0,this.group);pass.draw(3)
    pass.setBindGroup(0,this.tyreGroup);this.tyre.draw(pass);this.particles.draw(pass);pass.end()
    this.volume.render(enc,this.hdr,volumes)
    const output=this.context.getCurrentTexture().createView()
    const post=enc.beginRenderPass({colorAttachments:[{view:output,loadOp:"clear",storeOp:"store",clearValue:{r:0,g:0,b:0,a:1}}]})
    post.setPipeline(this.post);post.setBindGroup(0,this.group);post.setBindGroup(1,this.postGroup);post.draw(3);post.end()
    if(timed)this.timer!.finish(enc,output)
    this.device.queue.submit([enc.finish()])
    if(timed){this.measuring=true;try{this.gpuMs=await this.timer!.collect()}finally{this.measuring=false}}
    return timed?this.gpuMs:null
  }
}
