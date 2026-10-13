/** Shared screen-space shutter blur. Velocities are current-minus-previous UV, before exposure scaling. */
export const motionBlurDefaults = () => ({ enabled: true, strength: 0.65, shutter: 0.5 })
export type MotionBlurSettings = ReturnType<typeof motionBlurDefaults>
export type MotionIdentity=string|number|object

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
 let p=clamp(vec2i(o.uv*M.size.xy),vec2i(0),vec2i(M.size.xy)-1);
 var z=textureLoad(depth,p,0);
 ${multisampled?'for(var i=1;i<4;i++){z=min(z,textureLoad(depth,p,i));}':''}
 let world=M.inverse*vec4f(o.uv*vec2f(2,-2)+vec2f(-1,1),z,1);
 let old=M.previous*(world/world.w);var result:Out;
 result.motion=vec4f(select(vec2f(0),o.uv-motionUV(old),old.w>0.0&&z<1.0),z,1);
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
  /** Resize only when source attachments change. Optional external velocity replaces the camera/instance field. */
  resize(width:number,height:number,color:GPUTextureView,depth:GPUTextureView,velocityTarget?:GPUTextureView){
    for(const t of this.textures)t.destroy();this.textures=[]
    const texture=(w:number,h:number,format:GPUTextureFormat)=>{const t=this.device.createTexture({size:[w,h],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.textures.push(t);return t.createView()}
    this.velocityView=texture(Math.ceil(width/2),Math.ceil(height/2),'rgba16float')
    this.depthView=texture(Math.ceil(width/2),Math.ceil(height/2),'depth32float')
    this.output=texture(width,height,this.format)
    this.cameraGroup=this.device.createBindGroup({layout:this.camera.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:depth}]})
    this.gatherGroup=this.device.createBindGroup({layout:this.gather.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:color},{binding:2,resource:velocityTarget??this.velocityView},{binding:3,resource:this.device.createSampler({minFilter:'linear',magFilter:'linear'})}]})
    this.data.set([width,height,0,0],48)
  }
  update(current:Float32Array,inverse:Float32Array,previous:Float32Array,dt:number,strength:number,shutter:number,valid=true,maxPixels=32){
    this.data.set(inverse.subarray(0,16));this.data.set(previous.subarray(0,16),16);this.data.set(current.subarray(0,16),32)
    // Shutter is a fraction of a 60 Hz frame; motion remains stable across render rates.
    this.data.set([valid?Math.max(0,strength)*Math.min(1,Math.max(0,shutter))/(60*Math.max(1/240,dt)):0,maxPixels,0,0],52)
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
