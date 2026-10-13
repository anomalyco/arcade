import { PARTICLE_CAPACITY, Particles } from "./particles"

export const particleShader = /* wgsl */ `
struct Frame { vp: mat4x4f, eye: vec4f, ambient: vec4f, lights: array<vec4f,16> }
@group(0) @binding(0) var<uniform> F: Frame;
struct In { @location(0) pos: vec4f, @location(1) color: vec4f, @location(2) velocity: vec4f, @location(3) misc: vec4f }
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f, @location(2) world: vec3f, @location(3) @interpolate(flat) kind: f32 }
@vertex fn vs(@builtin(vertex_index) i:u32,s:In)->Out {
  let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let c=corners[i%6];let toward=normalize(F.eye.xyz-s.pos.xyz);
  var right=normalize(cross(vec3f(0,1,0),toward));var up=cross(toward,right);var size=vec2f(s.pos.w);
  if(s.velocity.w==1.0||s.velocity.w==3.0){
    let v=s.velocity.xyz;let speed=length(v);
    if(speed>0.1){up=v/speed;right=normalize(cross(up,toward));size.y*=1.0+min(9.0,speed*0.25);size.x*=0.4;}
  }
  var world=s.pos.xyz+(right*c.x*size.x+up*c.y*size.y);
  var normal=toward;
  if(s.velocity.w==2.0){
    let face=i/6;let axis=face/2;let sign=select(-1.0,1.0,face%2==0);
    var p=vec3f(c,sign);normal=vec3f(0,0,sign);
    if(axis==1){p=vec3f(sign,c);normal=vec3f(sign,0,0);}
    if(axis==2){p=vec3f(c.x,sign,c.y);normal=vec3f(0,sign,0);}
    let angle=s.misc.x;let cs=cos(angle);let sn=sin(angle);
    p=vec3f(p.x*cs-p.z*sn,p.y,p.x*sn+p.z*cs);world=s.pos.xyz+p*s.pos.w;
    if(F.eye.w==5.0){normal=vec3f(normal.x*cs-normal.z*sn,normal.y,normal.x*sn+normal.z*cs);}
  } else if(i>=6){world=s.pos.xyz;}
  var light=F.ambient.rgb;
  for(var l=0;l<min(8,i32(F.ambient.w));l++){
    let pos=F.lights[l*2];let color=F.lights[l*2+1];let delta=pos.xyz-s.pos.xyz;let d=length(delta);
    if(d<pos.w){light+=color.rgb*color.w*pow(1.0-d/pos.w,2.0)*(0.35+0.65*max(0.0,dot(normal,delta/max(d,0.01))));}
  }
  if(s.velocity.w==1.0||s.velocity.w==4.0){light=vec3f(2.2);}
  if(F.eye.w==3.0){light=vec3f(dot(light,vec3f(0.333)));}
  var o:Out;o.position=F.vp*vec4f(world,1);o.uv=c;o.color=vec4f(s.color.rgb*light,s.color.a);o.world=world;o.kind=s.velocity.w;
  if(F.eye.w==5.0){o.color=vec4f(normal*0.5+0.5,s.color.a);}
  return o;
}
@fragment fn fs(o:Out)->@location(0) vec4f {
  var alpha=o.color.a;
  if(o.kind!=2.0){alpha*=exp(-dot(o.uv,o.uv)*3.0)*(1.0-smoothstep(0.65,1.0,length(o.uv)));}
  if(o.kind==0.0){alpha*=smoothstep(-0.02,0.25,o.world.y);}
  if(F.eye.w==2.0){return vec4f(0.12,0.025,0.008,0.06);}
  if(F.eye.w==1.0){return vec4f(vec3f(alpha,alpha*0.4,1.0-alpha)*alpha,alpha);}
  return vec4f(o.color.rgb*alpha,alpha);
}
`

/** One instanced HDR draw. Non-debris extra vertices degenerate; debris gets six genuinely lit faces. */
export class ParticleRenderer {
  readonly uniforms=new Float32Array(88)
  private readonly buffer:GPUBuffer
  private readonly instances:GPUBuffer
  private readonly group:GPUBindGroup
  private readonly pipeline:GPURenderPipeline
  private readonly heat:GPURenderPipeline
  private count=0
  constructor(private readonly device:GPUDevice,depthFormat:GPUTextureFormat="depth24plus",samples=4){
    this.buffer=device.createBuffer({size:this.uniforms.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    this.instances=device.createBuffer({size:PARTICLE_CAPACITY*64,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}}]})
    this.group=device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:this.buffer}}]})
    const module=device.createShaderModule({code:particleShader,label:"kit particles"})
    const pipe=(heat:boolean)=>device.createRenderPipeline({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),
      vertex:{module,entryPoint:"vs",buffers:[{arrayStride:64,stepMode:"instance",attributes:[0,1,2,3].map(i=>({shaderLocation:i,offset:i*16,format:"float32x4"}))}]},
      fragment:{module,entryPoint:"fs",targets:[{format:"rgba16float",blend:{color:{srcFactor:"one",dstFactor:heat?"one":"one-minus-src-alpha"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}}}]},
      depthStencil:{format:depthFormat,depthWriteEnabled:false,depthCompare:"less-equal"},multisample:{count:samples}})
    this.pipeline=pipe(false);this.heat=pipe(true)
  }
  upload(p:Particles){p.prepare();this.count=p.count;this.device.queue.writeBuffer(this.buffer,0,this.uniforms);if(p.count)this.device.queue.writeBuffer(this.instances,0,p.instances.buffer,0,p.count*64)}
  draw(pass:GPURenderPassEncoder){if(!this.count)return;pass.setPipeline(this.uniforms[19]===2?this.heat:this.pipeline);pass.setBindGroup(0,this.group);pass.setVertexBuffer(0,this.instances);pass.draw(36,this.count)}
  destroy(){this.buffer.destroy();this.instances.destroy()}
}
