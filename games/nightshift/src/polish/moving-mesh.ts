import type { PassContext, ScenePass } from "@arcade/kit/gpu/pass-graph"
import { makeSceneShader, type SceneHooks } from "@arcade/kit/gpu/shaders"
import { TEXTURED_VERTEX_LAYOUT } from "@arcade/kit/gpu/textured-mesh"
import type { SpotShadowCaster } from "@arcade/kit/gpu/shadows/spot-shadows"

export type MovingMesh={kind:"chair"|"paper"|"drawer";x:number;z:number;data:ArrayBuffer}
/** Vertex changes and shadow casters share the exact buffer; dirty only while moving. */
export class MovingMeshPass implements ScenePass {
  readonly casters:SpotShadowCaster[]=[]
  private pipe:GPURenderPipeline
  private states:{source:ArrayBuffer;output:ArrayBuffer;pose:string}[]=[]
  constructor(private ctx:PassContext,meshes:MovingMesh[],hooks:SceneHooks) {
    const d=ctx.device,module=d.createShaderModule({code:makeSceneShader(hooks),label:"Night Shift moving props"})
    this.pipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[ctx.frameLayout]}),vertex:{module,entryPoint:"vsStatic",buffers:[{arrayStride:24,attributes:[...TEXTURED_VERTEX_LAYOUT.attributes].slice(0,4)}]},fragment:{module,entryPoint:"fsSolid",targets:[{format:ctx.color}]},primitive:{topology:"triangle-list"},depthStencil:{format:ctx.depth,depthWriteEnabled:true,depthCompare:ctx.depthCompare??"less-equal"},multisample:{count:ctx.samples}})
    for(const m of meshes){const buffer=d.createBuffer({size:m.data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(buffer,0,m.data);this.casters.push({buffer,count:m.data.byteLength/24,stride:24});this.states.push({source:m.data,output:m.data.slice(0),pose:""})}
  }
  transform(index:number,pivotX:number,pivotZ:number,dx:number,dz:number,yaw:number,lift=0):boolean {
    const state=this.states[index],pose=[dx,dz,yaw,lift].join(":")
    if(pose===state.pose)return false
    state.pose=pose
    transformPacked(state.source,state.output,24,pivotX,pivotZ,dx,dz,yaw,lift)
    this.ctx.device.queue.writeBuffer(this.casters[index].buffer,0,state.output);return true
  }
  draw(pass:GPURenderPassEncoder){pass.setPipeline(this.pipe);for(const c of this.casters){pass.setVertexBuffer(0,c.buffer);pass.draw(c.count)}}
  dispose(){for(const c of this.casters)c.buffer.destroy()}
}
/** Rest-source transform prevents accumulated drift. Paper lift bends about its rear edge. */
export function transformPacked(source:ArrayBuffer,out:ArrayBuffer,stride:number,px:number,pz:number,dx:number,dz:number,yaw:number,lift=0){
  const a=new Float32Array(source),b=new Float32Array(out),na=new Int8Array(source),nb=new Int8Array(out),step=stride/4,c=Math.cos(yaw),s=Math.sin(yaw)
  for(let i=0;i<a.length;i+=step){
    const x=a[i]-px,z=a[i+2]-pz
    b[i]=px+c*x+s*z+dx;b[i+2]=pz-s*x+c*z+dz
    const bend=Math.max(0,Math.min(1,(z+.14)/.28))
    b[i+1]=a[i+1]+lift*bend*bend
    const n=i*4+12,nx=na[n],ny=na[n+1],nz=na[n+2]-ny*lift*2*bend/.28,len=Math.hypot(nx,ny,nz)||1
    nb[n]=Math.round((c*nx+s*nz)/len*127);nb[n+1]=Math.round(ny/len*127);nb[n+2]=Math.round((-s*nx+c*nz)/len*127)
  }
}
