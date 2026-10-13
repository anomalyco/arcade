import type { DebugBody, LabContext, LabSection, PhysicsAdapter } from "./types"

const shader=/* wgsl */`
@group(0) @binding(0) var<uniform> vp:mat4x4f;
struct Out {@builtin(position) p:vec4f,@location(0) color:vec3f}
@vertex fn vs(@location(0) p:vec3f,@location(1) color:vec3f)->Out {var o:Out;o.p=vp*vec4f(p,1);o.color=color;return o;}
@fragment fn fs(o:Out)->@location(0) vec4f {return vec4f(o.color,1);}
`
const edges=[0,1,0,2,0,4,1,3,1,5,2,3,2,6,3,7,4,5,4,6,5,7,6,7]
const capacity=512
/** Client solver plugs in here; the Lab owns only bounded collider visualization. */
export function createPhysics(context:LabContext,initial?:PhysicsAdapter) {
  let adapter=initial,count=0,total=0,awake=0
  const settings={playing:true,colliders:true,sleeping:true}
  const d=context.device,vertices=new Float32Array(capacity*24*6),corners=new Float32Array(24)
  const buffer=d.createBuffer({size:vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
  const uniform=d.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
  const module=d.createShaderModule({code:shader,label:"Lab colliders"})
  const pipeline=d.createRenderPipeline({layout:"auto",vertex:{module,entryPoint:"vs",buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"}]}]},
    fragment:{module,entryPoint:"fs",targets:[{format:"rgba16float"}]},primitive:{topology:"line-list"},depthStencil:{format:"depth24plus",depthWriteEnabled:false,depthCompare:"less-equal"},multisample:{count:4}})
  const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]})
  function box(body:DebugBody) {
    const cy=Math.cos(body.yaw),sy=Math.sin(body.yaw),cp=Math.cos(body.pitch),sp=Math.sin(body.pitch),cr=Math.cos(body.roll),sr=Math.sin(body.roll)
    // Local roll Z, pitch X, then yaw Y; game adapters may convert their orientation convention.
    for(let i=0;i<8;i++){
      const x=(i&1?1:-1)*body.hx,y=(i&2?1:-1)*body.hy,z=(i&4?1:-1)*body.hz
      const rx=x*cr-y*sr,ry=x*sr+y*cr,py=ry*cp-z*sp,pz=ry*sp+z*cp
      corners[i*3]=body.x+rx*cy+pz*sy;corners[i*3+1]=body.y+py;corners[i*3+2]=body.z-rx*sy+pz*cy
    }
    for(const i of edges){const at=count++*6;vertices[at]=corners[i*3];vertices[at+1]=corners[i*3+1];vertices[at+2]=corners[i*3+2];vertices[at+3]=body.awake?1:0.2;vertices[at+4]=body.awake?0.45:0.75;vertices[at+5]=body.awake?0.12:1}
  }
  const section:LabSection={id:"physics",label:"Physics",settings,controls:[
    {key:"playing",label:"Play"},{key:"colliders",label:"Colliders"},{key:"sleeping",label:"Sleeping bodies"},
    {key:"reset",label:"Reset",type:"action",run:()=>adapter?.reset()},
    {key:"wake",label:"Wake all",type:"action",run:()=>adapter?.wakeAll?.()},
  ],update:dt=>{if(settings.playing)adapter?.update(dt)},prepare:()=>{
    adapter?.prepare?.()
    count=0;total=0;awake=0
    for(const body of adapter?.bodies??[]){if(!body.enabled)continue;total++;if(body.awake)awake++;if(settings.colliders&&(body.awake||settings.sleeping)&&count<capacity*24)box(body)}
    d.queue.writeBuffer(uniform,0,context.stage.viewProj)
    if(count)d.queue.writeBuffer(buffer,0,vertices.buffer,0,count*24)
  },draw:pass=>{if(count){pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setVertexBuffer(0,buffer);pass.draw(count)}},
    telemetry:()=>adapter?`${total} bodies · ${awake} awake · ${total-awake} sleeping\n${count/24}/${capacity} colliders · orange awake / cyan sleeping`:"Physics · adapter pending\n0 bodies"}
  return {section,attach:(next:PhysicsAdapter)=>{adapter=next}}
}
