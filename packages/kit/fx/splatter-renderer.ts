import { Splatter, SPLATTER_DECALS, SPLATTER_PARTICLES, SPLATTER_RECEIVERS, PARTICLE_STRIDE, DECAL_STRIDE } from "./splatter"

const shader=/* wgsl */`
struct Frame {vp:mat4x4f,eye:vec4f}
struct Splat {position:vec4f,tangent:vec4f,normal:vec4f,color:vec4f,clipA:vec4f,clipB:vec4f}
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<storage,read> instances:array<Splat>;
struct Out {@builtin(position) p:vec4f,@location(0) uv:vec2f,@location(1) @interpolate(flat) color:vec4f,@location(2) @interpolate(flat) a:vec4f,@location(3) @interpolate(flat) b:vec4f,@location(4) @interpolate(flat) kind:f32}
@vertex fn vs(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Out {
 let s=instances[i];let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));let q=corners[v];
 var right=s.tangent.xyz;var up=cross(s.normal.xyz,right);
 if(s.normal.w==0.0){let view=normalize(F.eye.xyz-s.position.xyz);up=normalize(right+vec3f(.00001,.00001,0));right=normalize(cross(up,view));}
 let world=s.position.xyz+right*q.x*s.position.w+up*q.y*s.tangent.w+s.normal.xyz*.0015;
 var o:Out;o.p=F.vp*vec4f(world,1);o.uv=q;o.color=s.color;o.a=s.clipA;o.b=s.clipB;o.kind=s.normal.w;return o;
}
fn cross2(a:vec2f,b:vec2f)->f32{return a.x*b.y-a.y*b.x;}
@fragment fn fs(o:Out)->@location(0) vec4f {
 let uv=o.uv;let aa=max(length(fwidth(uv))*.65,.005);var coverage=0.0;
 if(o.kind==1.0){
   let a=o.a.xy;let b=o.a.zw;let c=o.b.xy;
   let sign=select(-1.0,1.0,cross2(b-a,c-a)>0.0);
   if(cross2(b-a,uv-a)*sign<-.00001||cross2(c-b,uv-b)*sign<-.00001||cross2(a-c,uv-c)*sign<-.00001){discard;}
   let seed=o.b.z;let angle=atan2(uv.y,uv.x);let edge=.075*sin(angle*5.0+seed)+.035*sin(angle*11.0-seed*2.0);
   let core=.59-length(uv*vec2f(1.04,1.18))+edge;
   let lobe1=.31-length((uv-vec2f(.39,.14))*vec2f(1.2,1.0));
   let lobe2=.27-length((uv+vec2f(.3,.32))*vec2f(.85,1.3));
   let lobe3=.19-length((uv-vec2f(-.34,.4))*vec2f(1.1,.9));
   let density=max(max(core,lobe1),max(lobe2,lobe3));coverage=smoothstep(-aa,aa,density);
 }else{coverage=1.0-smoothstep(.65-aa,1.0,length(uv*vec2f(1.0,.8)));}
 if(coverage<.01){discard;}
 let grain=.88+.12*sin(uv.x*17.0+o.b.z)*sin(uv.y*13.0-o.b.z);
 return vec4f(o.color.rgb*grain,o.color.a*coverage);
}`

/** One matte alpha draw. Triangles clip every decal to its receiving mesh; no projection volume or glow. */
export class SplatterRenderer {
  private readonly data=new Float32Array((SPLATTER_DECALS*SPLATTER_RECEIVERS+SPLATTER_PARTICLES)*24)
  private readonly frame=new Float32Array(20)
  private readonly uniform:GPUBuffer
  private readonly storage:GPUBuffer
  private readonly group:GPUBindGroup
  private readonly pipeline:GPURenderPipeline
  private motionPipeline?:GPURenderPipeline
  private readonly descriptor:GPURenderPipelineDescriptor
  count=0
  constructor(private readonly device:GPUDevice){
    this.uniform=device.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    this.storage=device.createBuffer({size:this.data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})
    const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:"read-only-storage"}}]})
    this.group=device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.storage}}]})
    const module=device.createShaderModule({code:shader,label:"Matte surface splatter"})
    this.descriptor={layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint:"fs",targets:[{format:"rgba16float",blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}}}]},depthStencil:{format:"depth24plus",depthWriteEnabled:false,depthCompare:"less-equal"},multisample:{count:4}}
    this.pipeline=device.createRenderPipeline(this.descriptor)
  }
  prepare(s:Splatter,vp:ArrayLike<number>,eye:ArrayLike<number>,motion=false){
    if(motion&&!this.motionPipeline)this.motionPipeline=this.device.createRenderPipeline({...this.descriptor,fragment:{...this.descriptor.fragment!,targets:[...this.descriptor.fragment!.targets,{format:"rgba16float",writeMask:0}]}})
    this.count=0
    for(let i=0;i<16;i++)this.frame[i]=vp[i];for(let i=0;i<3;i++)this.frame[16+i]=eye[i]
    const d=s.decals,p=this.data,tri=s.surfaces.triangles
    for(let i=0;i<SPLATTER_DECALS;i++){
      const k=i*DECAL_STRIDE;if(d[k+7]<=0)continue
      const grow=1+d[k+19]*(1-Math.exp(-d[k+15]*1.8)),rx=d[k+3]*grow,ry=d[k+11]*grow,tx=d[k+4],ty=d[k+5],tz=d[k+6],nx=d[k+8],ny=d[k+9],nz=d[k+10],ux=ny*tz-nz*ty,uy=nz*tx-nx*tz,uz=nx*ty-ny*tx
      for(let j=0;j<s.receiverCounts[i];j++){
        const o=this.count++*24,t=s.receivers[i*SPLATTER_RECEIVERS+j]*16
        p[o]=d[k];p[o+1]=d[k+1];p[o+2]=d[k+2];p[o+3]=rx;p[o+4]=tx;p[o+5]=ty;p[o+6]=tz;p[o+7]=ry
        p[o+8]=nx;p[o+9]=ny;p[o+10]=nz;p[o+11]=1;p[o+12]=d[k+12];p[o+13]=d[k+13];p[o+14]=d[k+14];p[o+15]=d[k+16]*Math.min(1,d[k+7]/Math.min(3,d[k+18]*.25))
        for(let v=0;v<3;v++){const e=v===0?0:v===1?4:8,x=tri[t]+(v?tri[t+e]:0)-d[k],y=tri[t+1]+(v?tri[t+e+1]:0)-d[k+1],z=tri[t+2]+(v?tri[t+e+2]:0)-d[k+2];p[o+16+v*2]=(x*tx+y*ty+z*tz)/rx;p[o+17+v*2]=(x*ux+y*uy+z*uz)/ry}
        p[o+22]=d[k+17];p[o+23]=0
      }
    }
    const drops=s.particles
    for(let i=0;i<SPLATTER_PARTICLES;i++){
      const k=i*PARTICLE_STRIDE;if(drops[k+7]<=0)continue
      const o=this.count++*24,speed=Math.hypot(drops[k+4],drops[k+5],drops[k+6])||1
      p[o]=drops[k];p[o+1]=drops[k+1];p[o+2]=drops[k+2];p[o+3]=drops[k+3];p[o+4]=drops[k+4]/speed;p[o+5]=drops[k+5]/speed;p[o+6]=drops[k+6]/speed;p[o+7]=drops[k+3]*(1+Math.min(2,speed*.12))
      p[o+8]=p[o+9]=p[o+10]=p[o+11]=0;p[o+12]=drops[k+8];p[o+13]=drops[k+9];p[o+14]=drops[k+10];p[o+15]=drops[k+11];p[o+22]=drops[k+12]
    }
    this.device.queue.writeBuffer(this.uniform,0,this.frame)
    if(this.count)this.device.queue.writeBuffer(this.storage,0,this.data.buffer,0,this.count*96)
  }
  draw(pass:GPURenderPassEncoder,motion=false){if(!this.count)return;pass.setPipeline(motion?this.motionPipeline!:this.pipeline);pass.setBindGroup(0,this.group);pass.draw(6,this.count)}
}
