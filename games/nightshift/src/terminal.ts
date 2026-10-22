import { Mesh, MAT } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts, TexturedMeshPass, type TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { propHooks } from "./shaders"
import { COLLEAGUES, CONTINUITY_MONITOR } from "./world"
export class Terminal {
  readonly texture:GPUTexture
  private canvas=new OffscreenCanvas(512,384)
  private paint=this.canvas.getContext("2d")!
  private tick=-1
  private version=-1
  constructor(private device:GPUDevice,private colleague=false){
    this.texture=device.createTexture({size:[512,384],format:"rgba8unorm-srgb",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT})
    this.update(colleague?10:0,colleague?0:1)
  }
  update(time:number,tokens:number,version=0){
    const tick=Math.floor(Math.min(time,6)*20);if(tick===this.tick&&version===this.version)return;this.tick=tick;this.version=version
    const p=this.paint,empty=tokens<=.001,red=this.colleague||time>=3
    p.fillStyle=red?"#160606":"#03110b";p.fillRect(0,0,512,384)
    p.fillStyle=red?"#ac3c30":"#65b47e";p.font="18px monospace";p.textBaseline="top"
    p.fillText("SESSION 087    02:13",34,28)
    p.fillRect(34,54,444,1)
    const lines=["> read working directory", "  indexing files...", "> continue the session", "  checking changes...", "  awaiting response", "  writing output...", "  processing request..."]
    const offset=this.colleague?2+Math.round(version)*2:Math.floor(Math.min(time,3)*3)
    for(let i=0;i<6;i++){p.globalAlpha=.30+.10*i;p.fillText(lines[(offset+i)%lines.length],34,76+i*23)}p.globalAlpha=1
    if(red){p.font="bold 23px monospace";p.fillText("usage limit reached",34,235)}
    p.font="18px monospace";p.fillText("TOKENS",34,291);p.textAlign="right";p.fillText(empty?"0":String(Math.ceil(tokens*8192)),478,291);p.textAlign="left"
    p.strokeRect(34.5,321.5,443,23);if(tokens>0)p.fillRect(38,325,436*tokens,16)
    // Fine phosphor scanlines stay anchored to the glass, not the viewport.
    p.fillStyle="#000000";p.globalAlpha=.15;for(let y=0;y<384;y+=3)p.fillRect(0,y,512,1);p.globalAlpha=1
    this.device.queue.copyExternalImageToTexture({source:this.canvas},{texture:this.texture},[512,384])
  }
}
export function colleagueScreens(renderer:Renderer){
  const d=renderer.passContext.device,screen=new Terminal(d,true),changedScreen=new Terminal(d,true)
  const texture=(rgba:number[])=>{const t=d.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});d.queue.writeTexture({texture:t},new Uint8Array(rgba),{},[1,1]);return t}
  const normal=texture([128,128,255,255]),orm=texture([255,160,0,255])
  const primitives:TexturedPrimitive[]=COLLEAGUES.map(station=>{
    const {x,z}=station,watched=station===CONTINUITY_MONITOR
    const m=new Mesh(),y=.795+.19,left=x-.174,right=x+.174,front=z-.155
    m.quad([left,y,front],[left,y+.256,front],[right,y+.256,front],[right,y,front],[0,0,-1],[1,1,1],MAT.lit,watched?14:8)
    const uv:number[]=[];for(let i=0;i<m.v.length;i+=11)uv.push(1-(m.v[i]-left)/.348,1-(m.v[i+1]-y)/.256)
    return {vertices:packTexturedVerts(m.v,uv),base:watched?changedScreen.texture:screen.texture,normal,orm,color:[1,1,1,1],roughness:.24,metalness:0,normalScale:0,blend:false}
  })
  const pass=new TexturedMeshPass(renderer.passContext,primitives,propHooks);renderer.addPass("opaque",pass)
  return {pass,update(version:number){changedScreen.update(10,0,version)}}
}
