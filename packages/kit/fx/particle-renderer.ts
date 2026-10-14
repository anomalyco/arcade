import { PARTICLE_CAPACITY, Particles } from "./particles"

export const particleShader = /* wgsl */ `
struct Frame { vp: mat4x4f, eye: vec4f, ambient: vec4f, lights: array<vec4f,16> }
@group(0) @binding(0) var<uniform> F: Frame;
struct In { @location(0) pos: vec4f, @location(1) color: vec4f, @location(2) velocity: vec4f, @location(3) misc: vec4f }
struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) world: vec3f,
  @location(3) @interpolate(flat) kind: f32,
  @location(4) @interpolate(flat) misc: vec4f,
}
fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x),
    mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x),
    u.y
  );
}
fn fbm3(p: vec2f) -> f32 {
  return vnoise(p) * 0.54 + vnoise(p * 2.07 + vec2f(17.3, -9.1)) * 0.31 + vnoise(p * 4.23 + vec2f(-11.7, 23.5)) * 0.15;
}
@vertex fn vs(@builtin(vertex_index) i:u32,s:In)->Out {
  let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let c=corners[i%6];let toward=normalize(F.eye.xyz-s.pos.xyz);
  var right=normalize(cross(vec3f(0,1,0),toward));var up=cross(toward,right);var size=vec2f(s.pos.w);
  let kind=s.velocity.w;
  if(kind==1.0||kind==3.0){
    let v=s.velocity.xyz;let speed=length(v);
    if(speed>0.1){up=v/speed;right=normalize(cross(up,toward));size.y*=1.0+min(9.0,speed*0.25);size.x*=0.4;}
  } else if(kind==5.0||kind==6.0){
    let angle=s.misc.x;let cs=cos(angle);let sn=sin(angle);
    right=vec3f(cs,0.0,-sn);up=vec3f(sn,0.0,cs);
  } else if(kind==7.0){
    let spin=select(-1.0,1.0,fract(s.misc.x*0.37)>0.5);
    let angle=s.misc.x+s.misc.y*spin*1.05;
    let cs=cos(angle);let sn=sin(angle);
    let r0=right;let u0=up;
    right=r0*cs-u0*sn;up=r0*sn+u0*cs;
  }
  var world=s.pos.xyz+(right*c.x*size.x+up*c.y*size.y);
  var normal=select(toward,vec3f(0.0,1.0,0.0),kind==5.0||kind==6.0);
  if(kind==7.0){normal=normalize(toward+vec3f(0.0,0.75,0.0));}
  if(kind==2.0){
    let face=i/6;let axis=face/2;let sign=select(-1.0,1.0,face%2==0);
    var p=vec3f(c,sign);normal=vec3f(0,0,sign);
    if(axis==1){p=vec3f(sign,c);normal=vec3f(sign,0,0);}
    if(axis==2){p=vec3f(c.x,sign,c.y);normal=vec3f(0,sign,0);}
    // Elongate explosion shrapnel shards (when s.misc.w > 0) so they read as jagged splinters rather than cubes.
    if(s.misc.w>0.0){p*=vec3f(0.42,1.55,0.68);}
    let a1=s.misc.x;let c1=cos(a1);let s1=sin(a1);
    let a2=s.misc.x*0.73+1.1;let c2=cos(a2);let s2=sin(a2);
    let py=p.y*c2-p.z*s2;let pz=p.y*s2+p.z*c2;
    p=vec3f(p.x*c1-pz*s1,py,p.x*s1+pz*c1);world=s.pos.xyz+p*s.pos.w;
    let ny=normal.y*c2-normal.z*s2;let nz=normal.y*s2+normal.z*c2;
    normal=vec3f(normal.x*c1-nz*s1,ny,normal.x*s1+nz*c1);
  } else if(i>=6){world=s.pos.xyz;}
  var light=F.ambient.rgb;
  for(var l=0;l<min(8,i32(F.ambient.w));l++){
    let pos=F.lights[l*2];let color=F.lights[l*2+1];let delta=pos.xyz-s.pos.xyz;let d=length(delta);
    if(d<pos.w){light+=color.rgb*color.w*pow(1.0-d/pos.w,2.0)*(0.35+0.65*max(0.0,dot(normal,delta/max(d,0.01))));}
  }
  if(kind==2.0&&s.misc.w>0.0){light=min(light,vec3f(1.45,1.25,1.05));}
  if(kind==1.0){
    if(s.misc.z>0.0){
      let cool=clamp(s.misc.y,0.0,1.0);
      let hot=mix(vec3f(4.2,3.4,1.9),vec3f(2.4,0.95,0.18),smoothstep(0.0,0.45,cool));
      light=mix(hot,vec3f(1.2,0.22,0.03),smoothstep(0.45,0.95,cool))*s.misc.z;
    }else{light=vec3f(2.2);}
  } else if(kind==4.0){
    light=vec3f(2.2);
  }
  if(F.eye.w==3.0){light=vec3f(dot(light,vec3f(0.333)));}
  var o:Out;o.position=F.vp*vec4f(world,1);o.uv=c;
  o.color=vec4f(select(s.color.rgb*light,light,kind==7.0),s.color.a);
  o.world=world;o.kind=kind;o.misc=s.misc;
  if(F.eye.w==5.0){o.color=vec4f(normal*0.5+0.5,s.color.a);}
  return o;
}
@fragment fn fs(o:Out)->@location(0) vec4f {
  var alpha=o.color.a;
  if(o.kind==7.0){
    let seed=o.misc.x;let age=clamp(o.misc.y,0.0,1.0);
    let tempScale=max(0.1,o.misc.z);let turb=max(0.25,o.misc.w);
    let r=length(o.uv);
    let q=o.uv*(1.75+turb*0.65)+vec2f(cos(seed*1.3)*3.7,sin(seed*1.7)*3.7-age*1.65);
    let warp=vec2f(vnoise(q*1.25+vec2f(0.0,-age*2.1)),vnoise(q*1.25+vec2f(7.4,age*1.8)))-0.5;
    let n1=vnoise(q+warp*(0.95*turb));
    let n2=vnoise(q*2.25-warp*1.15+vec2f(age*1.6,-age*2.5));
    let n3=vnoise(q*4.6+vec2f(-seed*2.1,age*3.6));
    let billow=n1*0.52+n2*0.32+n3*0.16;
    let lobeRadius=0.73+(billow-0.48)*(0.36+turb*0.18);
    let edgeSoft=mix(0.11,0.24,age);
    let shapeMask=(1.0-smoothstep(lobeRadius-edgeSoft,lobeRadius+edgeSoft,r))*(1.0-smoothstep(0.84,1.0,r));
    let groundSoft=smoothstep(0.01,0.22,o.world.y);
    alpha*=shapeMask*groundSoft;
    if(alpha<0.003){discard;}
    let ridge=clamp(n1*0.64+n2*0.36,0.0,1.0);
    let crevice=1.0-ridge;
    let radialCore=1.0-smoothstep(0.0,0.84,r);
    // Outer convex billow domes cool into dark carbon soot first while crevices and core roar orange-yellow.
    let heatDistribution=mix(radialCore*0.72+crevice*0.56,radialCore*0.24+crevice*1.02,smoothstep(0.05,0.44,age));
    let coolEnvelope=pow(max(0.0,1.0-age),1.28);
    let flashSpike=pow(max(0.0,1.0-age*4.2),2.0)*radialCore*0.95;
    let T=clamp((heatDistribution*coolEnvelope*1.45+flashSpike)*tempScale,0.0,2.0);
    let puffUp=clamp(0.42+0.42*o.uv.y+0.34*(ridge-0.5),0.12,1.0);
    // Exterior soot crust is self-occluded from the internal blast flash; clamp scene light so soot stays deep charcoal.
    let extLight=clamp(o.color.rgb,vec3f(0.18),vec3f(0.95,0.88,0.82));
    let sootTint=mix(vec3f(0.032,0.028,0.026),vec3f(0.18,0.17,0.165),clamp(age*0.85,0.0,1.0));
    let sootRgb=sootTint*extLight*(0.45+0.85*puffUp);
    var blackbody=mix(vec3f(0.92,0.042,0.003),vec3f(2.65,0.48,0.028),smoothstep(0.14,0.42,T));
    blackbody=mix(blackbody,vec3f(4.6,2.25,0.36),smoothstep(0.42,0.80,T));
    blackbody=mix(blackbody,vec3f(7.2,6.2,4.4),smoothstep(0.80,1.35,T));
    let incand=smoothstep(0.14,0.34,T);
    let rgb=mix(sootRgb,blackbody,incand);
    if(F.eye.w==2.0){return vec4f(0.12,0.025,0.008,0.06);}
    if(F.eye.w==1.0){return vec4f(vec3f(alpha,alpha*0.4,1.0-alpha)*alpha,alpha);}
    if(F.eye.w==3.0){return vec4f(extLight*puffUp*alpha,alpha);}
    return vec4f(rgb*alpha,alpha);
  }
  if(o.kind==5.0){
    let r=length(o.uv);
    let n=fbm3(o.uv*3.4+vec2f(o.misc.x,o.misc.y*2.2));
    let waveR=0.74+(n-0.5)*0.15;
    let ring=exp(-pow((r-waveR)/0.105,2.0))*0.88+smoothstep(waveR,waveR-0.36,r)*smoothstep(0.20,waveR-0.08,r)*0.34;
    alpha*=ring*(0.45+0.75*n)*(1.0-smoothstep(0.88,1.0,r));
    if(alpha<0.003){discard;}
    let flashBoost=max(0.0,1.0-o.misc.y*2.6);
    let dustRgb=o.color.rgb+vec3f(1.75,0.82,0.32)*flashBoost*exp(-pow((r-waveR)/0.08,2.0));
    if(F.eye.w==2.0){return vec4f(0.12,0.025,0.008,0.06);}
    if(F.eye.w==1.0){return vec4f(vec3f(alpha,alpha*0.4,1.0-alpha)*alpha,alpha);}
    return vec4f(dustRgb*alpha,alpha);
  }
  if(o.kind==6.0){
    let r=length(o.uv);
    let angle=atan2(o.uv.y,o.uv.x);
    let spokes=0.5+0.3*sin(angle*7.0+o.misc.x)+0.2*cos(angle*13.0-o.misc.x*1.7);
    let n=fbm3(o.uv*3.8+vec2f(o.misc.x,o.misc.x*0.5));
    let innerChar=1.0-smoothstep(0.12,0.46+(n-0.5)*0.18,r);
    let sootApron=(1.0-smoothstep(0.24,0.88,r+(0.5-n)*0.22-spokes*0.12))*(0.45+0.55*n);
    let scorchMask=clamp(innerChar*0.92+sootApron*0.58,0.0,1.0)*(1.0-smoothstep(0.86,1.0,r));
    alpha*=scorchMask;
    if(alpha<0.003){discard;}
    let fresh=max(0.0,1.0-o.misc.y*7.0)*smoothstep(0.66,0.88,n)*innerChar;
    let scorchRgb=o.color.rgb*mix(0.32,1.0,sootApron)+vec3f(2.2,0.52,0.06)*fresh;
    if(F.eye.w==2.0){return vec4f(0.12,0.025,0.008,0.06);}
    if(F.eye.w==1.0){return vec4f(vec3f(alpha,alpha*0.4,1.0-alpha)*alpha,alpha);}
    return vec4f(scorchRgb*alpha,alpha);
  }
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
