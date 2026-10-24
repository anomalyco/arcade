import type { LabControl } from "../lab-panel"
import { mat4 } from "wgpu-matrix"

/** Shared screen-space shutter blur. Velocities are current-minus-previous UV, before exposure scaling. */
export const motionBlurDefaults = () => ({
  enabled: true,
  strength: 0.65,
  shutter: 0.5,
  burst: 1,
  burstDecay: 14,
})
export type MotionBlurSettings = ReturnType<typeof motionBlurDefaults>
export type MotionIdentity=string|number|object
export type MotionKey={initial?:readonly [number,number,number];maxTravel?:number}

export const motionBlurControls: readonly LabControl[] = [
  { key: "enabled", label: "Motion blur", group: "Motion" },
  { key: "strength", label: "Strength", group: "Motion", min: 0, max: 2, step: 0.05 },
  { key: "shutter", label: "Shutter", group: "Motion", min: 0, max: 1, step: 0.05 },
  { key: "burst", label: "Impulse burst", group: "Motion", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "burstDecay", label: "Burst decay", group: "Motion", min: 4, max: 30, step: 1, unit: "/s" },
]

/**
 * Short screen-space motion-blur impulse (directional recoil/lunge + radial blast/hit punch).
 * Decays exponentially and feeds `MotionBlur`'s camera velocity pass.
 */
export class MotionBlurBurst {
  dx = 0
  dy = 0
  radial = 0
  shutterBoost = 0

  add(opts: { dir?: number; directional?: number; radial?: number; boost?: number }, scale = 1): void {
    const s = Math.max(0, scale)
    if (s <= 0) return
    if (opts.dir !== undefined && opts.directional) {
      const amt = opts.directional * s
      this.dx = Math.max(-0.028, Math.min(0.028, this.dx + Math.cos(opts.dir) * amt))
      this.dy = Math.max(-0.028, Math.min(0.028, this.dy + Math.sin(opts.dir) * amt))
    }
    if (opts.radial) {
      this.radial = Math.max(-0.032, Math.min(0.032, this.radial + opts.radial * s))
    }
    if (opts.boost) {
      this.shutterBoost = Math.min(1.5, this.shutterBoost + opts.boost * s)
    }
  }

  step(dt: number, decay = 14): void {
    if (dt <= 0) return
    const k = Math.exp(-dt * Math.max(1, decay))
    this.dx *= k
    this.dy *= k
    this.radial *= k
    this.shutterBoost *= k
    if (Math.hypot(this.dx, this.dy) < 1e-4) {
      this.dx = 0
      this.dy = 0
    }
    if (Math.abs(this.radial) < 1e-4) this.radial = 0
    if (this.shutterBoost < 1e-3) this.shutterBoost = 0
  }

  reset(): void {
    this.dx = 0
    this.dy = 0
    this.radial = 0
    this.shutterBoost = 0
  }

  get active(): boolean {
    return (
      Math.abs(this.dx) > 1e-4 ||
      Math.abs(this.dy) > 1e-4 ||
      Math.abs(this.radial) > 1e-4 ||
      this.shutterBoost > 1e-3
    )
  }
}

/** Rig owners keep stable per-model part identities while their draw arrays are rebuilt. */
export class MotionKeys {
  private owners=new WeakMap<object,Map<number,MotionKey[]>>()
  private arrays=new WeakMap<number[],(MotionKey|undefined)[]>()
  private counts=new Map<number,number>()
  private parts:Map<number,MotionKey[]>|undefined
  private initial:MotionKey["initial"]
  private maxTravel=4
  begin(owner?:object,initial?:MotionKey["initial"],maxTravel=4){
    this.initial=initial;this.maxTravel=maxTravel
    this.counts.clear();this.parts=owner?this.owners.get(owner):undefined
    if(owner&&!this.parts)this.owners.set(owner,this.parts=new Map())
  }
  key(model:number){
    if(!this.parts)return
    const i=this.counts.get(model)??0;this.counts.set(model,i+1)
    let parts=this.parts.get(model);if(!parts)this.parts.set(model,parts=[])
    return parts[i]??(parts[i]={initial:this.initial,maxTravel:this.maxTravel})
  }
  record(array:number[],model:number){
    const key=this.key(model)
    let keys=this.arrays.get(array)
    if(!keys)this.arrays.set(array,keys=[])
    keys[array.length/12-1]=key
  }
  of(array:number[]){return this.arrays.get(array)}
}

/** Stable identities, not draw-order indices. Missing frames/spawns/teleports use the current transform. */
export class PreviousTransforms {
  private frame = 0
  private entries = new Map<MotionIdentity, { frame: number; value: Float32Array }>()
  constructor(readonly stride = 12, readonly teleport = 12) {}
  reset() { this.entries.clear(); this.frame = 0 }
  begin() {
    this.frame++
    for (const [key, entry] of this.entries) if (entry.frame < this.frame - 1) this.entries.delete(key)
  }
  write(key: MotionIdentity, current: Float32Array, offset: number, out: Float32Array, at: number) {
    let entry = this.entries.get(key)
    const valid = entry && entry.frame === this.frame - 1 && Math.hypot(current[offset]! - entry.value[0]!, current[offset+1]! - entry.value[1]!, current[offset+2]! - entry.value[2]!) < this.teleport
    for (let i=0;i<this.stride;i++) out[at+i] = valid ? entry!.value[i]! : current[offset+i]!
    if (!entry) { entry = { frame: this.frame, value: new Float32Array(this.stride) }; this.entries.set(key, entry) }
    for (let i=0;i<this.stride;i++) entry.value[i] = current[offset+i]!
    entry.frame = this.frame
  }
}

/** Packed-rig adapter for callers that mark continuity once at the beginning of a frame. */
export class MotionHistory {
  private entries=new WeakMap<MotionKey,{frame:number;pose:Float32Array}>()
  private frame=0
  private valid=false
  begin(valid:boolean){this.frame++;this.valid=valid}
  write(dst:Float32Array,offset:number,current:Float32Array,start:number,key?:MotionKey){
    let old=key?this.entries.get(key):undefined
    const continuous=this.valid&&old?.frame===this.frame-1&&Math.hypot(current[start]!-old.pose[0]!,current[start+1]!-old.pose[1]!,current[start+2]!-old.pose[2]!)<(key?.maxTravel??4)
    for(let i=0;i<12;i++)dst[offset+i]=continuous?old!.pose[i]!:current[start+i]!
    if(this.valid&&!old&&key?.initial)dst.set(key.initial,offset)
    if(!key)return
    if(!old){old={frame:this.frame,pose:new Float32Array(12)};this.entries.set(key,old)}
    old.frame=this.frame
    for(let i=0;i<12;i++)old.pose[i]=current[start+i]!
  }
}

/** The view-projection camera velocity is measured with: the unjittered one under TAA, whose jitter is not motion. */
export const blurViewProj = (frame: Float32Array, unjittered: Float32Array | null): Float32Array => (unjittered ?? frame).subarray(0, 16)

/** The velocity pass's camera motion for one pixel on the CPU (uv now minus uv then), for tests. */
export function cameraVelocity(current: Float32Array, previous: Float32Array, uv: readonly [number, number], z: number): [number, number] {
  const inv = mat4.inverse(current)
  const ndc = [uv[0] * 2 - 1, 1 - uv[1] * 2, z, 1]
  const world = [0, 0, 0, 0].map((_, r) => inv[r]! * ndc[0]! + inv[4 + r]! * ndc[1]! + inv[8 + r]! * ndc[2]! + inv[12 + r]! * ndc[3]!)
  const w = world[3]!
  const p = world.map((v) => v / w)
  const clip = [0, 1, 3].map((r) => previous[r]! * p[0]! + previous[4 + r]! * p[1]! + previous[8 + r]! * p[2]! + previous[12 + r]! * p[3]!)
  const ow = Math.max(clip[2]!, 1e-4)
  return [uv[0] - (clip[0]! / ow * 0.5 + 0.5), uv[1] - (clip[1]! / ow * -0.5 + 0.5)]
}

export const motionUniformWGSL = /* wgsl */ `
struct MotionFrame { inverse:mat4x4f, previous:mat4x4f, current:mat4x4f, size:vec4f, exposure:vec4f }
@group(0) @binding(0) var<uniform> M:MotionFrame;
fn motionUV(clip:vec4f)->vec2f {return clip.xy/max(clip.w,0.0001)*vec2f(.5,-.5)+.5;}
fn velocity(now:vec4f,old:vec4f)->vec2f {return select(vec2f(0),motionUV(now)-motionUV(old),old.w>0.0);}
struct Full {@builtin(position) pos:vec4f,@location(0) uv:vec2f}
@vertex fn fullscreen(@builtin(vertex_index) i:u32)->Full {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Full;
 o.pos=vec4f(p[i],0,1);o.uv=p[i]*vec2f(.5,-.5)+.5;return o;
}
`
const cameraShader = (multisampled:boolean) => motionUniformWGSL + /* wgsl */ `
@group(0) @binding(1) var depth:${multisampled?'texture_depth_multisampled_2d':'texture_depth_2d'};
struct Out {@location(0) motion:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn camera(o:Full)->Out {
 // Depth at its own size: under TAA the blur runs on the resolved image, the depth stays at the internal size.
 let ds=vec2i(textureDimensions(depth));
 let p=clamp(vec2i(o.uv*vec2f(ds)),vec2i(0),ds-1);
 var z=textureLoad(depth,p,0);
 ${multisampled?'for(var i=1;i<4;i++){z=min(z,textureLoad(depth,p,i));}':''}
 let world=M.inverse*vec4f(o.uv*vec2f(2,-2)+vec2f(-1,1),z,1);
 let old=M.previous*(world/world.w);var result:Out;
 let camVel=select(vec2f(0),o.uv-motionUV(old),old.w>0.0&&z<1.0);
 let fromC=o.uv-0.5;
 let edgeW=smoothstep(0.06,0.38,length(fromC));
 let burstVel=M.size.zw*(0.45+0.55*edgeW)+fromC*(M.exposure.z*1.45*edgeW);
 result.motion=vec4f(camVel*M.exposure.w+burstVel,z,1);
 result.depth=z;return result;
}
`
/** The same gather can run in a game's existing composite. Supply motionField() and motionColor(). */
export const motionGatherWGSL = (linearDepth=false) => /* wgsl */ `
fn gatherMotion(uv:vec2f,size:vec2f,exposure:f32,maxPixels:f32)->vec4f {
 let center=motionColor(uv);let m=motionField(uv);
 var v=m.xy*exposure*size;
 let len=length(v);v*=min(1.0,maxPixels/max(len,.0001));
 if(len<.5){return center;}
 let uvVelocity=v/size;var sum=center.rgb;var weight=1.0;
 // Symmetric shutter, no feedback/history colour. Reject unrelated depth layers.
 for(var i=0;i<8;i++){
   let t=(f32(i)+.5)/8.0-.5;let at=clamp(uv+uvVelocity*t,vec2f(.5)/size,vec2f(1)-vec2f(.5)/size);
   let n=motionField(at);
   let depthWeight=${linearDepth?'1.0-smoothstep(.15,max(.35,m.z*.018),abs(n.z-m.z))':'1.0-smoothstep(.008,.05,abs(n.z-m.z)/max(.0001,1.0-m.z))'};
   let w=depthWeight*(1.0-abs(t));sum+=motionColor(at).rgb*w;weight+=w;
 }
 return vec4f(sum/weight,center.a);
}
`
const gatherShader = motionUniformWGSL + /* wgsl */ `
@group(0) @binding(1) var color:texture_2d<f32>;
@group(0) @binding(2) var motion:texture_2d<f32>;
@group(0) @binding(3) var linearSampler:sampler;
fn motionField(uv:vec2f)->vec4f {let size=vec2i(textureDimensions(motion));return textureLoad(motion,clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1),0);}
fn motionColor(uv:vec2f)->vec4f{return textureSampleLevel(color,linearSampler,uv,0);}
${motionGatherWGSL()}
@fragment fn gather(o:Full)->@location(0) vec4f {
 return gatherMotion(o.uv,M.size.xy,M.exposure.x,M.exposure.y);
}
`

export class MotionBlur {
  readonly uniform:GPUBuffer
  readonly layout:GPUBindGroupLayout
  readonly group:GPUBindGroup
  readonly data=new Float32Array(56)
  readonly burst=new MotionBlurBurst()
  private width=0
  private height=0
  private camera:GPURenderPipeline
  private gather:GPURenderPipeline
  private cameraGroup!:GPUBindGroup
  private gatherGroup!:GPUBindGroup
  private textures:GPUTexture[]=[]
  private velocityView!:GPUTextureView
  private depthView!:GPUTextureView
  output!:GPUTextureView
  constructor(readonly device:GPUDevice,format:GPUTextureFormat='rgba16float',multisampled=true){
    const d=device
    this.uniform=d.createBuffer({size:224,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    this.layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}}]})
    this.group=d.createBindGroup({layout:this.layout,entries:[{binding:0,resource:{buffer:this.uniform}}]})
    const camera=d.createShaderModule({code:cameraShader(multisampled),label:'Camera velocity'}),gather=d.createShaderModule({code:gatherShader,label:'Depth-aware shutter gather'})
    this.camera=d.createRenderPipeline({layout:'auto',vertex:{module:camera,entryPoint:'fullscreen'},fragment:{module:camera,entryPoint:'camera',targets:[{format:'rgba16float'}]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'}})
    this.gather=d.createRenderPipeline({layout:'auto',vertex:{module:gather,entryPoint:'fullscreen'},fragment:{module:gather,entryPoint:'gather',targets:[{format}]}})
    this.format=format
  }
  private format:GPUTextureFormat
  addBurst(opts: { dir?: number; directional?: number; radial?: number; boost?: number }, scale = 1): void {
    this.burst.add(opts, scale)
  }
  stepBurst(dt: number, decay = 14): void {
    this.burst.step(dt, decay)
  }
  /** Resize only when source attachments change. Optional external velocity replaces the camera/instance field. */
  resize(width:number,height:number,color:GPUTextureView,depth:GPUTextureView,velocityTarget?:GPUTextureView){
    this.width=width;this.height=height
    for(const t of this.textures)t.destroy();this.textures=[]
    const texture=(w:number,h:number,format:GPUTextureFormat)=>{const t=this.device.createTexture({size:[w,h],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.textures.push(t);return t.createView()}
    this.velocityView=texture(Math.ceil(width/2),Math.ceil(height/2),'rgba16float')
    this.depthView=texture(Math.ceil(width/2),Math.ceil(height/2),'depth32float')
    this.output=texture(width,height,this.format)
    this.cameraGroup=this.device.createBindGroup({layout:this.camera.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:depth}]})
    this.gatherGroup=this.device.createBindGroup({layout:this.gather.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:color},{binding:2,resource:velocityTarget??this.velocityView},{binding:3,resource:this.device.createSampler({minFilter:'linear',magFilter:'linear'})}]})
    this.data.set([width,height,0,0],48)
  }
  update(current:Float32Array,inverse:Float32Array,previous:Float32Array,dt:number,strength:number,shutter:number,valid=true,maxPixels=32,burstScale=1){
    this.data.set(inverse.subarray(0,16));this.data.set(previous.subarray(0,16),16);this.data.set(current.subarray(0,16),32)
    const bScale=Math.max(0,burstScale)
    const hasBurst=bScale>0&&this.burst.active
    const effStrength=Math.max(0,strength)+(hasBurst?this.burst.shutterBoost*bScale:0)
    // Shutter is a fraction of a 60 Hz frame; motion remains stable across render rates.
    const baseExp=valid?effStrength*Math.min(1,Math.max(0,shutter))/(60*Math.max(1/240,dt)):0
    const effExp=hasBurst?Math.max(baseExp,0.5):baseExp
    const camScale=effExp>1e-6?baseExp/effExp:1
    const invExp=effExp>1e-6?1/effExp:0
    this.data[50]=hasBurst?this.burst.dx*bScale*invExp:0
    this.data[51]=hasBurst?this.burst.dy*bScale*invExp:0
    this.data.set([effExp,maxPixels,hasBurst?this.burst.radial*bScale*invExp:0,camScale],52)
    this.device.queue.writeBuffer(this.uniform,0,this.data)
  }
  encode(encoder:GPUCommandEncoder,drawVelocity?:(pass:GPURenderPassEncoder)=>void){
    const p=encoder.beginRenderPass({label:'Velocity',colorAttachments:[{view:this.velocityView,loadOp:'clear',storeOp:'store',clearValue:[0,0,1,1]}],depthStencilAttachment:{view:this.depthView,depthLoadOp:'clear',depthClearValue:1,depthStoreOp:'discard'}})
    p.setPipeline(this.camera);p.setBindGroup(0,this.cameraGroup);p.draw(3);drawVelocity?.(p);p.end()
    const g=encoder.beginRenderPass({label:'Motion gather',colorAttachments:[{view:this.output,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]})
    g.setPipeline(this.gather);g.setBindGroup(0,this.gatherGroup);g.draw(3);g.end()
  }
  destroy(){for(const t of this.textures)t.destroy();this.uniform.destroy()}
}
