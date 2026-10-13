import { frameShader } from "./stage-shader"

const shader=frameShader+/* wgsl */`
struct Out {@builtin(position) p:vec4f,@location(0) world:vec3f,@location(1) normal:vec3f,@location(2) color:vec3f,@location(3) emission:f32,@location(4) alpha:f32}
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) color:vec3f,@location(3) emission:f32,
 @location(4) a:vec4f,@location(5) b:vec4f,@location(6) c:vec4f,@location(7) d:vec4f,@location(8) tint:vec4f)->Out {
 let m=mat4x4f(a,b,c,d);var o:Out;o.world=(m*vec4f(p,1)).xyz;o.p=F.vp*vec4f(o.world,1);o.normal=normalize((m*vec4f(n,0)).xyz);o.color=color*select(vec3f(1),tint.rgb,emission<0.0);o.emission=abs(emission);o.alpha=tint.w;return o;
}
@fragment fn fs(o:Out)->@location(0) vec4f {
 let n=normalize(o.normal);var light=F.ambient.rgb+vec3f(.48,.61,.9)*F.moon.w*max(0.0,dot(n,normalize(F.moon.xyz)));
 for(var i=0;i<min(8,i32(F.options.x));i++){
   let p=F.lights[i*3];let c=F.lights[i*3+1];let cone=F.lights[i*3+2];let delta=p.xyz-o.world;let dist=length(delta);let dir=delta/max(.001,dist);
   var attenuation=pow(max(0.0,1.0-dist/p.w),2.0)*c.w;
   if(cone.w > -1.0){attenuation*=smoothstep(cone.w,min(1.0,cone.w+.08),dot(-dir,cone.xyz));}
   light+=c.rgb*attenuation*(.15+.85*max(0.0,dot(n,dir)));
 }
 var color=o.color*(light+o.emission);
 if(F.options.z==3.0){color=light;}if(F.options.z==5.0){color=n*.5+.5;}
 return vec4f(color,o.alpha);
}
`
type Model={vertices:GPUBuffer;instances:GPUBuffer;data:Float32Array;count:number;verts:number;opacity:number}
/** Game adapters normalize their meshes to position/normal/RGB/emission; transforms use local Z, X, Y rotation. */
export class LabMeshes {
  private models:Model[]=[]
  private pipeline:GPURenderPipeline
  private group:GPUBindGroup
  private uniform:GPUBuffer
  constructor(private device:GPUDevice){
    const d=device,module=d.createShaderModule({code:shader,label:"Lab spawn meshes"})
    this.uniform=d.createBuffer({size:592,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    this.pipeline=d.createRenderPipeline({layout:"auto",vertex:{module,entryPoint:"vs",buffers:[
      {arrayStride:40,attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"},{shaderLocation:2,offset:24,format:"float32x3"},{shaderLocation:3,offset:36,format:"float32"}]},
      {arrayStride:80,stepMode:"instance",attributes:[0,1,2,3,4].map(i=>({shaderLocation:4+i,offset:i*16,format:"float32x4"}))},
    ]},fragment:{module,entryPoint:"fs",targets:[{format:"rgba16float",blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}}}]},depthStencil:{format:"depth24plus",depthWriteEnabled:true,depthCompare:"less-equal"},multisample:{count:4}})
    this.group=d.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}}]})
  }
  add(vertices:readonly number[],stride=10,emission:(material:number)=>number=code=>code,opacity=1){
    const data=new Float32Array(vertices.length/stride*10)
    for(let i=0,j=0;i<vertices.length;i+=stride,j+=10){for(let k=0;k<9;k++)data[j+k]=vertices[i+k];data[j+9]=emission(vertices[i+9])}
    const buffer=this.device.createBuffer({size:Math.max(4,data.byteLength),usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    if(data.byteLength)this.device.queue.writeBuffer(buffer,0,data)
    const instances=this.device.createBuffer({size:512*80,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    return this.models.push({vertices:buffer,instances,data:new Float32Array(512*20),count:0,verts:data.length/10,opacity})-1
  }
  reset(){for(const m of this.models)m.count=0}
  /** Rebuild seeded scenery in-place; keep its instance allocation and release the old geometry. */
  replace(model:number,vertices:readonly number[],stride=10,emission:(material:number)=>number=code=>code){
    const m=this.models[model];if(!m)throw new Error(`Unknown Lab model ${model}`)
    const data=new Float32Array(vertices.length/stride*10)
    for(let i=0,j=0;i<vertices.length;i+=stride,j+=10){for(let k=0;k<9;k++)data[j+k]=vertices[i+k];data[j+9]=emission(vertices[i+9])}
    m.vertices.destroy();m.vertices=this.device.createBuffer({size:Math.max(4,data.byteLength),usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    if(data.byteLength)this.device.queue.writeBuffer(m.vertices,0,data)
    m.verts=data.length/10;m.count=0
  }
  instance(model:number,x:number,y:number,z:number,yaw=0,roll=0,pitch=0,scale=1,tint:readonly number[]=[1,1,1]){
    const m=this.models[model];if(!m||m.count===512)return
    const p=m.data,o=m.count++*20,cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),cr=Math.cos(roll),sr=Math.sin(roll)
    p[o]=(cy*cr+sy*sp*sr)*scale;p[o+1]=cp*sr*scale;p[o+2]=(-sy*cr+cy*sp*sr)*scale;p[o+3]=0
    p[o+4]=(-cy*sr+sy*sp*cr)*scale;p[o+5]=cp*cr*scale;p[o+6]=(sy*sr+cy*sp*cr)*scale;p[o+7]=0
    p[o+8]=sy*cp*scale;p[o+9]=-sp*scale;p[o+10]=cy*cp*scale;p[o+11]=0
    p[o+12]=x;p[o+13]=y;p[o+14]=z;p[o+15]=1;p[o+16]=tint[0];p[o+17]=tint[1];p[o+18]=tint[2];p[o+19]=m.opacity
  }
  upload(frame:Float32Array<ArrayBuffer>){this.device.queue.writeBuffer(this.uniform,0,frame);for(const m of this.models)if(m.count)this.device.queue.writeBuffer(m.instances,0,m.data.buffer,0,m.count*80)}
  draw(pass:GPURenderPassEncoder){pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);for(const transparent of [false,true])for(const m of this.models)if(m.count&&(m.opacity<1)===transparent){pass.setVertexBuffer(0,m.vertices);pass.setVertexBuffer(1,m.instances);pass.draw(m.verts,m.count)}}
}
