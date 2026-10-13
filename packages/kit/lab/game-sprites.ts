import type { LabContext } from "./types"

const shader=/* wgsl */`
struct Frame {vp:mat4x4f,eye:vec4f}
@group(0) @binding(0) var<uniform> F:Frame;
struct Out {@builtin(position) p:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f,@location(2) kind:f32}
@vertex fn vs(@builtin(vertex_index) i:u32,@location(0) p:vec4f,@location(1) color:vec4f,@location(2) shape:vec4f)->Out {
 let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));let uv=corners[i];
 let toEye=normalize(F.eye.xyz-p.xyz);var right=normalize(cross(vec3f(0,1,0),toEye));var up=cross(toEye,right);
 var localY=uv.y*max(.01,shape.z);
 if(shape.x==1.0||shape.x==2.0||shape.x==3.0||shape.x==5.0||shape.x==6.0){
   let cr=cos(shape.y);let sr=sin(shape.y);
   right=vec3f(cr,0,-sr);up=vec3f(sr,0,cr);
   if(shape.x==6.0){localY=(uv.y*0.5+0.5)*max(.01,shape.z);}
 }
 var o:Out;o.p=F.vp*vec4f(p.xyz+(right*uv.x+up*localY)*p.w,1);o.uv=uv;o.color=color;o.kind=shape.x;return o;
}
@fragment fn fs(o:Out)->@location(0) vec4f {
 let d=length(o.uv);var a=exp(-d*d*3.5)*smoothstep(1.0,.65,d);
 if(o.kind==1.0){a=smoothstep(1.0,.75,d);}
 if(o.kind==2.0){a=smoothstep(.13,.025,abs(d-.82));}
 if(o.kind==3.0){a=smoothstep(1.0,.4,abs(o.uv.x))*smoothstep(1.0,.7,abs(o.uv.y));}
 if(o.kind==4.0){a=1.0-smoothstep(.75,1.0,max(abs(o.uv.x),abs(o.uv.y)));}
 if(o.kind==5.0){
   let q=abs(o.uv);
   let rounded=length(max(q-vec2f(0.24,0.34),vec2f(0.0)));
   let body=1.0-smoothstep(0.10,0.62,rounded);
   let wheel=1.0-smoothstep(0.02,0.21,length((q-vec2f(0.70,0.57))*vec2f(1.0,1.3)));
   a=min(1.0,body*0.84+wheel*0.36);
 }
 if(o.kind==6.0){
   let t=o.uv.y*0.5+0.5;
   let w=mix(0.22,1.0,t);
   let side=1.0-smoothstep(0.0,1.0,abs(o.uv.x)/w);
   a=side*side*(1.0-smoothstep(0.12,1.0,t))*smoothstep(0.0,0.02,t);
 }
 return vec4f(o.color.rgb,o.color.a*a);
}`

/** Adapts production sprite batches (not replacement simulations) to the Lab pass. */
export class GameSprites {
  private data=new Float32Array(8192*12)
  private buffer:GPUBuffer
  private uniform:GPUBuffer
  private frame=new Float32Array(20)
  private group:GPUBindGroup
  private alpha:GPURenderPipeline
  private add:GPURenderPipeline
  private count=0
  private split=0
  constructor(private context:LabContext){
    const d=context.device,module=d.createShaderModule({code:shader,label:"Game Lab sprites"})
    this.buffer=d.createBuffer({size:this.data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    this.uniform=d.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:"uniform"}}]})
    const pipeline=(add:boolean)=>d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[layout]}),vertex:{module,entryPoint:"vs",buffers:[{arrayStride:48,stepMode:"instance",attributes:[0,1,2].map(i=>({shaderLocation:i,offset:i*16,format:"float32x4"}))}]},fragment:{module,entryPoint:"fs",targets:[{format:"rgba16float",blend:{color:{srcFactor:"src-alpha",dstFactor:add?"one":"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},depthStencil:{format:"depth24plus",depthCompare:"less-equal",depthWriteEnabled:false},multisample:{count:4}})
    this.alpha=pipeline(false);this.add=pipeline(true)
    this.group=d.createBindGroup({layout,entries:[{binding:0,resource:{buffer:this.uniform}}]})
  }
  reset(){this.count=this.split=0}
  push(x:number,y:number,z:number,size:number,r:number,g:number,b:number,a:number,kind=0,rot=0,stretch=1){
    if(this.count===8192)return
    this.data.set([x,y,z,size,r,g,b,a,kind,rot,stretch,0],this.count++*12)
  }
  additive(){this.split=this.count}
  batch(data:Float32Array,count:number,game:"blackout"|"getaway"){
    for(let i=0;i<count;i++){
      const o=i*12,k=data[o+8],planar=game==="blackout"?[2,5,6,7].includes(k):[2,3,4,9,19].includes(k)
      const beam=game==="blackout"?k===4:k===4||k===12||k===13||k===15
      const fan=game==="getaway"&&(k===14||k===17||k===18)
      const shape=fan?6:game==="getaway"&&k===9?5:beam?3:planar?(k===2||game==="blackout"&&k===5?2:1):game==="getaway"&&k===20?4:0
      this.push(data[o],data[o+1],data[o+2],data[o+3],data[o+4],data[o+5],data[o+6],data[o+7],shape,data[o+9],data[o+10]||1)
    }
  }
  upload(){const {stage,device}=this.context;this.frame.set(stage.viewProj);this.frame.set(stage.eye,16);device.queue.writeBuffer(this.uniform,0,this.frame);if(this.count)device.queue.writeBuffer(this.buffer,0,this.data.buffer,0,this.count*48)}
  draw=(pass:GPURenderPassEncoder)=>{pass.setBindGroup(0,this.group);pass.setVertexBuffer(0,this.buffer);if(this.split){pass.setPipeline(this.alpha);pass.draw(6,this.split)}if(this.count>this.split){pass.setPipeline(this.add);pass.draw(6,this.count-this.split,0,this.split)}}
}
