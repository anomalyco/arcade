import { wgslStruct } from "../gpu/wgsl"
import { reactivePipelineDescriptor } from "../gpu/reactive"
import { PARTICLE_CAPACITY, Particles } from "./particles"

/**
 * Typed WGSL layout for `ParticleRenderer` frame uniforms (120 floats / 480 bytes).
 * Keeps the original `[vp(16), eye(3), debug(1), ambient(3), lightCount(1), lights(64)]` prefix, then one plan cone per
 * light (`[dirX, dirZ, cosHalf, on]`, written only when `setFrame` is asked for `spotCones`).
 */
export const ParticleFrameStruct = wgslStruct("Frame", {
  vp: "mat4x4f",
  eye: "vec3f",
  debug: "f32",
  ambient: "vec3f",
  lightCount: "f32",
  lights: "array<vec4f, 16>",
  cones: "array<vec4f, 8>",
})

export type ParticleLightInput = {
  x: number
  y: number
  z: number
  radius: number
  r: number
  g: number
  b: number
  power: number
}

export type ParticleFrameInput = {
  vp?: ArrayLike<number>
  eye?: ArrayLike<number>
  debug?: number
  ambient?: ArrayLike<number>
  lights?: readonly ParticleLightInput[] | Float32Array
  lightCount?: number
  lightStride?: number
  minLightPower?: number
  /**
   * Read each light's plan cone from floats 8..11 of its stride (`[dirX, dirZ, cosHalf, w]`, a spot when 0.5 < w):
   * spot lights then only light particles inside their cone, with a soft edge. Off by default (every light a point).
   */
  spotCones?: boolean
}

export const blackbodyFireWgsl = /* wgsl */ `
fn blackbodyFire(T: f32) -> vec3f {
  var c = mix(vec3f(0.95, 0.048, 0.004), vec3f(2.75, 0.52, 0.032), smoothstep(0.16, 0.44, T));
  c = mix(c, vec3f(4.8, 2.35, 0.38), smoothstep(0.44, 0.80, T));
  c = mix(c, vec3f(7.4, 6.4, 4.6), smoothstep(0.80, 1.35, T));
  return c;
}
`

export function makeParticleShader(bindGroupIndex = 0): string {
  return /* wgsl */ `
${ParticleFrameStruct.wgsl}
@group(${bindGroupIndex}) @binding(0) var<uniform> F: Frame;
struct In { @location(0) pos: vec4f, @location(1) color: vec4f, @location(2) velocity: vec4f, @location(3) misc: vec4f }
struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) world: vec3f,
  @location(3) @interpolate(flat) kind: f32,
  @location(4) @interpolate(flat) misc: vec4f,
  @location(5) @interpolate(flat) emit: f32,
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
${blackbodyFireWgsl}
@vertex fn vs(@builtin(vertex_index) i:u32,s:In)->Out {
  let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let c=corners[i%6];let toward=normalize(F.eye-s.pos.xyz);
  var right=normalize(cross(vec3f(0,1,0),toward));var up=cross(toward,right);var size=vec2f(s.pos.w);
  let kind=s.velocity.w;
  if(kind==1.0||kind==3.0){
    let v=s.velocity.xyz;let speed=length(v);
    if(speed>0.1){up=v/speed;right=normalize(cross(up,toward));size.y*=1.0+min(9.0,speed*0.25);size.x*=0.4;}
  } else if((kind==5.0&&s.misc.z<0.5)||kind==6.0){
    let angle=s.misc.x;let cs=cos(angle);let sn=sin(angle);
    right=vec3f(cs,0.0,-sn);up=vec3f(sn,0.0,cs);
  } else if(kind==5.0||kind==7.0){
    let spin=select(-1.0,1.0,fract(s.misc.x*0.37)>0.5);
    let angle=s.misc.x+s.misc.y*spin*1.05;
    let cs=cos(angle);let sn=sin(angle);
    let r0=right;let u0=up;
    right=r0*cs-u0*sn;up=r0*sn+u0*cs;
  }
  var world=s.pos.xyz+(right*c.x*size.x+up*c.y*size.y);
  var normal=select(toward,vec3f(0.0,1.0,0.0),(kind==5.0&&s.misc.z<0.5)||kind==6.0);
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
  var light=F.ambient;
  for(var l=0;l<min(8,i32(F.lightCount));l++){
    let pos=F.lights[l*2];let color=F.lights[l*2+1];let delta=pos.xyz-s.pos.xyz;let d=length(delta);
    if(d<pos.w){
      var k=color.w*pow(1.0-d/pos.w,2.0)*(0.35+0.65*max(0.0,dot(normal,delta/max(d,0.01))));
      let cone=F.cones[l];
      if(cone.w>0.5){
        let plan=-delta.xz;let pl=length(plan);
        if(pl>0.05){k*=smoothstep(cone.z-0.07,cone.z+0.05,dot(plan/pl,cone.xy));}
      }
      light+=color.rgb*k;
    }
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
  } else if(kind==9.0){
    light=vec3f(1.0);
  }
  if(F.debug==3.0){light=vec3f(dot(light,vec3f(0.333)));}
  var o:Out;
  let clipWorld=select(world,world+toward*(s.pos.w*1.35*max(0.0,1.0-0.30*dot(c,c))),kind==7.0);
  o.position=F.vp*vec4f(clipWorld,1);o.uv=c;
  o.color=vec4f(select(s.color.rgb*light,light,kind==7.0),s.color.a);
  o.world=world;o.kind=kind;o.misc=s.misc;
  // A fireball's red channel scales its incandescence (1 in every explosion preset).
  o.emit=select(1.0,s.color.r,kind==7.0);
  if(F.debug==5.0){o.color=vec4f(normal*0.5+0.5,s.color.a);}
  return o;
}
@fragment fn fs(o:Out)->@location(0) vec4f {
  var alpha=o.color.a;
  if(o.kind==7.0){
    let r=length(o.uv);
    if(r>=0.98){discard;}
    let seed=o.misc.x;let age=clamp(o.misc.y,0.0,1.0);
    let tempScale=max(0.1,o.misc.z);let turb=max(0.25,o.misc.w);
    let q=o.uv*(1.85+turb*0.72)+vec2f(cos(seed*1.3)*3.7,sin(seed*1.7)*3.7-age*1.85);
    let warp=vec2f(vnoise(q*1.25+vec2f(0.0,-age*2.1)),vnoise(q*1.25+vec2f(7.4,age*1.8)))-0.5;
    let n1=vnoise(q+warp*(0.95*turb));
    let n2=vnoise(q*2.25-warp*1.15+vec2f(age*1.6,-age*2.5));
    let n3=vnoise(q*4.6+vec2f(-seed*2.1,age*3.6));
    let billow=n1*0.52+n2*0.32+n3*0.16;
    let lobeRadius=0.72+(billow-0.48)*(0.38+turb*0.18);
    let edgeSoft=mix(0.10,0.22,age);
    let shapeMask=(1.0-smoothstep(lobeRadius-edgeSoft,lobeRadius+edgeSoft,r))*(1.0-smoothstep(0.84,1.0,r));
    let groundSoft=select(1.0,smoothstep(0.01,0.22,o.world.y),o.world.y<0.25&&o.world.y>-0.5);
    let smokeHandoff=1.0-smoothstep(0.72,1.0,age+(1.0-billow)*0.14);
    alpha*=shapeMask*groundSoft*smokeHandoff;
    if(alpha<0.003){discard;}
    let ridge=clamp(n1*0.64+n2*0.36,0.0,1.0);
    let crevice=pow(1.0-ridge,1.28);
    let radialCore=1.0-smoothstep(0.0,0.80,r);
    // Outer convex billow domes cool into dark carbon soot first while crevices and core roar yellow-orange.
    let heatDistribution=mix(radialCore*0.74+crevice*0.56,radialCore*0.16+crevice*1.08,smoothstep(0.04,0.34,age));
    let coolEnvelope=pow(max(0.0,1.0-age),1.38);
    let flashSpike=pow(max(0.0,1.0-age*4.4),2.0)*radialCore*1.05;
    let T=clamp((heatDistribution*coolEnvelope*1.42+flashSpike)*tempScale,0.0,2.0);
    let puffUp=clamp(0.38+0.44*o.uv.y+0.38*(ridge-0.5),0.12,1.0);
    // Exterior soot crust has dark charcoal crevices and warm-grey top-lit billow domes matching the nascent smoke column.
    let extLight=clamp(o.color.rgb,vec3f(0.20,0.21,0.23),vec3f(0.96,0.90,0.84));
    let sootTint=mix(vec3f(0.036,0.033,0.031),vec3f(0.22,0.22,0.23),clamp(age*0.82+puffUp*0.26,0.0,1.0));
    let sootRgb=sootTint*extLight*(0.42+0.88*puffUp);
    let blackbody=blackbodyFire(T)*o.emit;
    let incand=smoothstep(0.16,0.36,T);
    let rgb=mix(sootRgb,blackbody,incand);
    if(F.debug==2.0){return vec4f(0.12,0.025,0.008,0.06);}
    if(F.debug==1.0){return vec4f(vec3f(alpha,alpha*0.4,1.0-alpha)*alpha,alpha);}
    if(F.debug==3.0){return vec4f(extLight*puffUp*alpha,alpha);}
    return vec4f(rgb*alpha,alpha);
  }
  if(o.kind==9.0){
    // Glow: the warm air round a flame. Unlit and purely additive (alpha 0), a soft core with a long tail.
    let r2=dot(o.uv,o.uv);
    if(r2>=0.98){discard;}
    let a=o.color.a*(exp(-r2*3.2)*0.7+exp(-r2*10.0)*0.3)*(1.0-smoothstep(0.6,0.98,r2));
    if(a<0.0004){discard;}
    if(F.debug==2.0){return vec4f(0.12,0.025,0.008,0.06);}
    if(F.debug==1.0){return vec4f(vec3f(a,a*0.4,1.0-a)*a,a);}
    return vec4f(o.color.rgb*a,0.0);
  }
  if(o.kind==8.0){
    // Lit smoke: the fireball's warped billow lobes without its heat, softer edged and slower, thinning as it ages.
    let r=length(o.uv);
    if(r>=0.98){discard;}
    let seed=o.misc.x;let age=clamp(o.misc.y,0.0,1.0);let turb=max(0.2,o.misc.w);
    let q=o.uv*(1.55+turb*0.55)+vec2f(cos(seed*1.3)*3.7,sin(seed*1.7)*3.7-age*1.1);
    let warp=vec2f(vnoise(q*1.1+vec2f(0.0,-age*1.3)),vnoise(q*1.1+vec2f(7.4,age*1.1)))-0.5;
    let n1=vnoise(q+warp*(0.9*turb));
    let n2=vnoise(q*2.15-warp*1.05+vec2f(age*1.0,-age*1.6));
    let billow=n1*0.62+n2*0.38;
    let lobe=0.6+(billow-0.48)*(0.46+turb*0.22);
    let soft=mix(0.2,0.36,age);
    let shapeMask=(1.0-smoothstep(lobe-soft,lobe+soft,r))*(1.0-smoothstep(0.78,1.0,r));
    let groundSoft=select(1.0,smoothstep(0.0,0.28,o.world.y),o.world.y<0.3&&o.world.y>-0.5);
    alpha*=shapeMask*groundSoft*(0.6+0.4*billow);
    if(alpha<0.003){discard;}
    let shade=clamp(0.78+0.55*(billow-0.5)+0.2*o.uv.y,0.35,1.2);
    if(F.debug==2.0){return vec4f(0.12,0.025,0.008,0.06);}
    if(F.debug==1.0){return vec4f(vec3f(alpha,alpha*0.4,1.0-alpha)*alpha,alpha);}
    return vec4f(o.color.rgb*shade*alpha,alpha);
  }
  if(o.kind==5.0){
    let r=length(o.uv);
    if(r>=0.98){discard;}
    let n=fbm3(o.uv*3.4+vec2f(o.misc.x,o.misc.y*2.2));
    let waveR=0.74+(n-0.5)*0.15;
    let ring=exp(-pow((r-waveR)/0.105,2.0))*0.88+smoothstep(waveR,waveR-0.36,r)*smoothstep(0.20,waveR-0.08,r)*0.34;
    alpha*=ring*(0.45+0.75*n)*(1.0-smoothstep(0.88,1.0,r));
    if(alpha<0.003){discard;}
    let flashBoost=max(0.0,1.0-o.misc.y*2.6);
    let dustRgb=o.color.rgb+vec3f(1.75,0.82,0.32)*flashBoost*exp(-pow((r-waveR)/0.08,2.0));
    if(F.debug==2.0){return vec4f(0.12,0.025,0.008,0.06);}
    if(F.debug==1.0){return vec4f(vec3f(alpha,alpha*0.4,1.0-alpha)*alpha,alpha);}
    return vec4f(dustRgb*alpha,alpha);
  }
  if(o.kind==6.0){
    let r=length(o.uv);
    if(r>=0.98){discard;}
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
    if(F.debug==2.0){return vec4f(0.12,0.025,0.008,0.06);}
    if(F.debug==1.0){return vec4f(vec3f(alpha,alpha*0.4,1.0-alpha)*alpha,alpha);}
    return vec4f(scorchRgb*alpha,alpha);
  }
  if(o.kind!=2.0){alpha*=exp(-dot(o.uv,o.uv)*3.0)*(1.0-smoothstep(0.65,1.0,length(o.uv)));}
  if(o.kind==0.0){alpha*=smoothstep(-0.02,0.25,o.world.y);}
  if(F.debug==2.0){return vec4f(0.12,0.025,0.008,0.06);}
  if(F.debug==1.0){return vec4f(vec3f(alpha,alpha*0.4,1.0-alpha)*alpha,alpha);}
  return vec4f(o.color.rgb*alpha,alpha);
}
`
}

export const particleShader = makeParticleShader(0)

export type ParticleRendererOptions = {
  depthFormat?: GPUTextureFormat
  samples?: number
  depthCompare?: GPUCompareFunction
  bindGroupIndex?: number
  extraBindGroupLayouts?: readonly GPUBindGroupLayout[]
}

const EYE_OFFSET = ParticleFrameStruct.offsetOf("eye")
const DEBUG_OFFSET = ParticleFrameStruct.offsetOf("debug")
const AMBIENT_OFFSET = ParticleFrameStruct.offsetOf("ambient")
const LIGHT_COUNT_OFFSET = ParticleFrameStruct.offsetOf("lightCount")
const LIGHTS_OFFSET = ParticleFrameStruct.offsetOf("lights")
const CONES_OFFSET = ParticleFrameStruct.offsetOf("cones")

/** One instanced HDR draw. Non-debris extra vertices degenerate; debris gets six genuinely lit faces. */
export class ParticleRenderer {
  readonly uniforms = ParticleFrameStruct.createBuffer()
  private readonly buffer: GPUBuffer
  private readonly instances: GPUBuffer
  private readonly group: GPUBindGroup
  private readonly bindGroupIndex: number
  private readonly pipeline: GPURenderPipeline
  private readonly heat: GPURenderPipeline
  private motionPipeline?: GPURenderPipeline
  private readonly keepPipelines: (GPURenderPipeline | undefined)[] = []
  private readonly makePipe: (heat: boolean, motion: boolean, keepColour?: boolean) => GPURenderPipeline
  private readonly describe: (heat: boolean, motion: boolean, keepColour?: boolean) => GPURenderPipelineDescriptor
  private reactivePipe?: GPURenderPipeline
  private count = 0
  constructor(
    private readonly device: GPUDevice,
    depthFormatOrOpts: GPUTextureFormat | ParticleRendererOptions = "depth24plus",
    samples = 4,
  ) {
    const opts: ParticleRendererOptions =
      typeof depthFormatOrOpts === "string" ? { depthFormat: depthFormatOrOpts, samples } : depthFormatOrOpts
    const depthFormat = opts.depthFormat ?? "depth24plus"
    const sampleCount = opts.samples ?? samples
    const depthCompare = opts.depthCompare ?? "less-equal"
    this.bindGroupIndex = opts.bindGroupIndex ?? 0
    this.buffer = device.createBuffer({
      size: this.uniforms.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.instances = device.createBuffer({
      size: PARTICLE_CAPACITY * 64,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    })
    this.group = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.buffer } }],
    })
    const module = device.createShaderModule({
      code: this.bindGroupIndex === 0 ? particleShader : makeParticleShader(this.bindGroupIndex),
      label: "kit particles",
    })
    const bindGroupLayouts = opts.extraBindGroupLayouts ? [...opts.extraBindGroupLayouts, layout] : [layout]
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts })
    this.describe = (heat: boolean, motion: boolean, keepColour = false) => ({
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: "vs",
          buffers: [
            {
              arrayStride: 64,
              stepMode: "instance",
              attributes: [0, 1, 2, 3].map(i => ({
                shaderLocation: i,
                offset: i * 16,
                format: "float32x4" as const,
              })),
            },
          ],
        },
        fragment: {
          module,
          entryPoint: "fs",
          targets: [
            {
              format: "rgba16float",
              blend: {
                color: { srcFactor: "one", dstFactor: heat ? "one" : "one-minus-src-alpha" },
                alpha: keepColour
                  ? { srcFactor: "zero", dstFactor: "one-minus-src-alpha" }
                  : { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              },
            },
            ...(motion ? [{ format: "rgba16float" as const, writeMask: 0 }] : []),
          ],
        },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare },
        multisample: { count: sampleCount },
      })
    this.makePipe = (heat, motion, keepColour) => device.createRenderPipeline(this.describe(heat, motion, keepColour))
    this.pipeline = this.makePipe(false, false)
    this.heat = this.makePipe(true, false)
  }

  /** Updates frame uniforms using named fields instead of raw float offsets. */
  setFrame(input: ParticleFrameInput): void {
    const u = this.uniforms
    if (input.vp) {
      for (let i = 0; i < 16; i++) u[i] = input.vp[i] ?? 0
    }
    if (input.eye) {
      u[EYE_OFFSET] = input.eye[0] ?? 0
      u[EYE_OFFSET + 1] = input.eye[1] ?? 0
      u[EYE_OFFSET + 2] = input.eye[2] ?? 0
    }
    if (input.debug !== undefined) {
      u[DEBUG_OFFSET] = input.debug
    }
    if (input.ambient) {
      u[AMBIENT_OFFSET] = input.ambient[0] ?? 0
      u[AMBIENT_OFFSET + 1] = input.ambient[1] ?? 0
      u[AMBIENT_OFFSET + 2] = input.ambient[2] ?? 0
    }
    if (input.lights !== undefined) {
      u.fill(0, LIGHTS_OFFSET)
      const cones = input.spotCones && input.lights instanceof Float32Array && (input.lightStride ?? 8) >= 12
      let written = 0
      if (input.lights instanceof Float32Array) {
        const stride = input.lightStride ?? 8
        const total = input.lightCount ?? Math.floor(input.lights.length / stride)
        const minPower = input.minLightPower ?? 0.001
        for (let i = 0; i < total && written < 8; i++) {
          const k = i * stride
          if (input.lights[k + 7]! <= minPower) continue
          for (let j = 0; j < 8; j++) u[LIGHTS_OFFSET + written * 8 + j] = input.lights[k + j]!
          if (cones) for (let j = 0; j < 4; j++) u[CONES_OFFSET + written * 4 + j] = input.lights[k + 8 + j]!
          written++
        }
      } else {
        const total = Math.min(8, input.lightCount ?? input.lights.length)
        for (let i = 0; i < total; i++) {
          const l = input.lights[i]!
          const o = LIGHTS_OFFSET + written * 8
          u[o] = l.x
          u[o + 1] = l.y
          u[o + 2] = l.z
          u[o + 3] = l.radius
          u[o + 4] = l.r
          u[o + 5] = l.g
          u[o + 6] = l.b
          u[o + 7] = l.power
          written++
        }
      }
      u[LIGHT_COUNT_OFFSET] = input.minLightPower === -Infinity && input.lightCount !== undefined ? input.lightCount : written
    } else if (input.lightCount !== undefined) {
      u[LIGHT_COUNT_OFFSET] = input.lightCount
    }
  }

  upload(p: Particles) {
    p.prepare()
    this.count = p.count
    this.device.queue.writeBuffer(this.buffer, 0, this.uniforms)
    if (p.count) this.device.queue.writeBuffer(this.instances, 0, p.instances.buffer, 0, p.count * 64)
  }
  /**
   * `keepColour` lowers destination alpha by each particle's coverage instead of compositing it over, for hosts whose
   * Look reads HDR alpha as one minus a colour mask (Outbreak's Noir): fire and the smoke it lights keep their colour.
   */
  draw(pass: GPURenderPassEncoder, motion = false, keepColour = false) {
    if (!this.count) return
    if (motion && !this.motionPipeline) this.motionPipeline = this.makePipe(false, true)
    const keep = keepColour ? (this.keepPipelines[motion ? 1 : 0] ??= this.makePipe(false, motion, true)) : null
    pass.setPipeline(this.uniforms[DEBUG_OFFSET] === 2 ? this.heat : keep ?? (motion ? this.motionPipeline! : this.pipeline))
    pass.setBindGroup(this.bindGroupIndex, this.group)
    pass.setVertexBuffer(0, this.instances)
    pass.draw(36, this.count)
  }
  /** Redraws this frame's particles into the temporal reactive mask (`@arcade/kit/gpu/reactive`). */
  drawReactive(pass: GPURenderPassEncoder) {
    if (!this.count) return
    this.reactivePipe ??= this.device.createRenderPipeline(reactivePipelineDescriptor(this.describe(false, false)))
    pass.setPipeline(this.reactivePipe)
    pass.setBindGroup(this.bindGroupIndex, this.group)
    pass.setVertexBuffer(0, this.instances)
    pass.draw(36, this.count)
  }
  destroy() {
    this.buffer.destroy()
    this.instances.destroy()
  }
}
