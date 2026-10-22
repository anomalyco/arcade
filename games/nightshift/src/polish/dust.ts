import { hash01 } from "@arcade/kit/gpu/lights/flicker"
import { common } from "@arcade/kit/gpu/shaders"
import { spotShadowWgsl } from "@arcade/kit/gpu/shadows/spot-shadows"
import type { PassContext, ScenePass } from "@arcade/kit/gpu/pass-graph"
import { officeUniform } from "../office-uniform"
import { blindCookieWgsl } from "../blind-cookie"

export const MOTE_COUNT=1200
/** World cells, never camera-relative. Same slow orbit principle as Outbreak's beam dust. */
export function dustAt(i:number,time:number):[number,number,number] {
  return [-3.5+hash01(i,1)*6+Math.sin(time*.12+i)*.05,.25+hash01(i,2)*2.4+Math.sin(time*.17+i*3)*.03,-6+hash01(i,3)*13]
}
export class DustField {
  readonly data=new Float32Array(MOTE_COUNT*4)
  readonly offsets=new Float64Array(MOTE_COUNT*4)
  private previous?:[number,number]
  step(dt:number,time:number,x:number,z:number,wake:number) {
    const old=this.previous??[x,z];this.previous=[x,z]
    const distance=Math.hypot(x-old[0],z-old[1]),speed=distance<.3?distance/Math.max(dt,.001):0
    const vx=distance<.3?(x-old[0])/Math.max(dt,.001):0,vz=distance<.3?(z-old[1])/Math.max(dt,.001):0
    for(let i=0;i<MOTE_COUNT;i++) {
      const j=i*4,p=dustAt(i,time),dx=p[0]+this.offsets[j]-x,dz=p[2]+this.offsets[j+1]-z
      const influence=Math.exp(-(dx*dx+dz*dz)*3)*Math.min(speed,2)*wake
      // A damped two-component velocity field: entrainment along travel plus a curl around the body.
      const steps=Math.max(1,Math.ceil(dt*120)),h=dt/steps
      for(let k=0;k<steps;k++) {
        this.offsets[j+2]+=(influence*(vx-dz*.8)-this.offsets[j]*.65)*h
        this.offsets[j+3]+=(influence*(vz+dx*.8)-this.offsets[j+1]*.65)*h
        this.offsets[j+2]*=Math.exp(-2*h);this.offsets[j+3]*=Math.exp(-2*h)
        this.offsets[j]+=this.offsets[j+2]*h;this.offsets[j+1]+=this.offsets[j+3]*h
      }
      this.data.set([p[0]+this.offsets[j],p[1],p[2]+this.offsets[j+1],hash01(i,4)],j)
    }
  }
}

export const dustShader=/* wgsl */ `${common}
${officeUniform}
${spotShadowWgsl}
${blindCookieWgsl}
struct Dust { knobs: vec4f, slots: vec4f }
@group(1) @binding(0) var<uniform> D: Dust;
struct Out { @builtin(position) pos:vec4f, @location(0) q:vec2f, @location(1) world:vec3f, @location(2) energy:f32 }
@vertex fn vs(@builtin(vertex_index) vi:u32,@location(0) mote:vec4f)->Out {
  let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  var o:Out;o.world=mote.xyz;o.q=corners[vi];o.energy=0.0;
  let clip=F.viewProj*vec4f(mote.xyz,1.0);o.pos=vec4f(2,2,2,1);
  if(clip.w<=0.0||mote.w>D.knobs.x){return o;}
  let p11=length(vec3f(F.viewProj[0][1],F.viewProj[1][1],F.viewProj[2][1]));
  let radius=D.knobs.y*F.screen.y*p11/(2.0*clip.w);
  let pixels=max(radius,.85);
  o.pos=clip+vec4f(corners[vi]*pixels*2.0/F.screen.xy*clip.w,0,0);
  o.energy=pow(radius/pixels,2.0)*D.knobs.z*smoothstep(.15,.65,clip.w);
  return o;
}
@fragment fn fs(o:Out)->@location(0) vec4f {
  var lit=vec3f(0);
  for(var j=0u;j<2u;j++) {
    let index=u32(D.slots[j]);let L=lights[index];let delta=o.world-L.pos.xyz;let d=length(delta);
    var mapped=false;
    // A fading-in map blends surface shadows toward unshadowed light. Motes must
    // wait for full coverage, otherwise they shine through desks during selection.
    for(var k=0u;k<u32(SPOTS.head.x);k++){if(u32(SPOTS.slots[k].params.x)==index&&SPOTS.slots[k].params.y>=.999){mapped=true;}}
    if(!mapped||d>=L.pos.w){continue;}
    let axis=select(normalize(vec3f(.9,-.5,-.5)),normalize(vec3f(.6,-.25,-.72)),j==1u);
    let cone=smoothstep(select(.45,.88,j==1u),select(.75,.97,j==1u),dot(delta/max(d,.001),axis));
    let cookie=blindCookieAt(o.world,L.pos.xyz,D.knobs.y);
    let shadow=spotShadowVis(index,o.world,normalize(-delta));
    lit+=L.color.rgb*L.color.w*cone*cookie*shadow/(1.0+d*d);
  }
  let a=pow(max(0.0,1.0-length(o.q)),2.4);
  return vec4f(lit*a*o.energy,0);
}`

/** Outbreak's additive, depth-tested billboard path, using the office's real spot maps. */
export class BeamDust implements ScenePass {
  private pipe:GPURenderPipeline
  private buffer:GPUBuffer
  private uniform:GPUBuffer
  private group:GPUBindGroup
  enabled=false
  constructor(private ctx:PassContext) {
    const d=ctx.device,layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{}}]})
    this.buffer=d.createBuffer({size:MOTE_COUNT*16,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    this.uniform=d.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    this.group=d.createBindGroup({layout,entries:[{binding:0,resource:{buffer:this.uniform}}]})
    const module=d.createShaderModule({code:dustShader,label:"Night Shift shadowed motes"})
    this.pipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[ctx.frameLayout,layout]}),vertex:{module,entryPoint:"vs",buffers:[{arrayStride:16,stepMode:"instance",attributes:[{shaderLocation:0,offset:0,format:"float32x4"}]}]},fragment:{module,entryPoint:"fs",targets:[{format:ctx.color,blend:{color:{srcFactor:"one",dstFactor:"one",operation:"add"},alpha:{srcFactor:"zero",dstFactor:"one",operation:"add"}}}]},primitive:{topology:"triangle-list"},depthStencil:{format:ctx.depth,depthWriteEnabled:false,depthCompare:ctx.depthCompare??"less-equal"},multisample:{count:ctx.samples}})
  }
  frame(data:Float32Array<ArrayBuffer>,amount:number,radius:number,brightness:number,slots:number[]) {
    this.enabled=amount>0
    if(!this.enabled)return
    this.ctx.device.queue.writeBuffer(this.buffer,0,data)
    this.ctx.device.queue.writeBuffer(this.uniform,0,new Float32Array([amount,radius,brightness,0,...slots,0,0]))
  }
  draw(pass:GPURenderPassEncoder){if(!this.enabled)return;pass.setPipeline(this.pipe);pass.setBindGroup(1,this.group);pass.setVertexBuffer(0,this.buffer);pass.draw(6,MOTE_COUNT)}
  dispose(){this.buffer.destroy();this.uniform.destroy()}
}
