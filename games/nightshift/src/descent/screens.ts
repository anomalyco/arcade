import { Mesh, MAT } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts, TexturedMeshPass, type TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { propHooks } from "../shaders"
import type { HallScreen } from "./room"
import { BASEMENT_X } from "./state"

const prompts=["make it pop","why is CI red","you're absolutely right","just one small change","please fix the last fix","sorry, one more thing","make it feel more human","remove the extra finger","can you explain this diff","this should be simple","yes, run the tests","thank you. thank you.","undo that","no, the other left","we shipped this yesterday","please don't delete that"]
export function hallScreens(renderer:Renderer,screens:HallScreen[]){
  const d=renderer.passContext.device,canvas=new OffscreenCanvas(1024,1024),p=canvas.getContext("2d")!
  const atlas=d.createTexture({size:[1024,1024],format:"rgba8unorm-srgb",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT})
  const pixel=(v:number[])=>{const t=d.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});d.queue.writeTexture({texture:t},new Uint8Array(v),{},[1,1]);return t}
  const normal=pixel([128,128,255,255]),orm=pixel([255,180,0,255]),m=new Mesh(),uv:number[]=[]
  for(const s of screens){
    const from=m.v.length,x=-s.width/2,y=s.y,slot=s.index%16,col=slot%4,row=Math.floor(slot/4),cos=Math.cos(s.yaw),sin=Math.sin(s.yaw)
    m.quad([x,y,0],[x+s.width,y,0],[x+s.width,y+s.height,0],[x,y+s.height,0],[0,0,1],[1,1,1],MAT.lit,8)
    for(let i=from;i<m.v.length;i+=11){
      uv.push((col+(m.v[i]-x)/s.width)/4,(row+1-(m.v[i+1]-y)/s.height)/4)
      const dx=m.v[i];m.v[i]=s.x+cos*dx;m.v[i+2]=s.z-sin*dx;m.v[i+3]=sin;m.v[i+5]=cos
    }
  }
  const primitive:TexturedPrimitive={vertices:packTexturedVerts(m.v,uv),base:atlas,normal,orm,color:[1,1,1,1],roughness:.3,metalness:0,normalScale:0,blend:false}
  const pass=new TexturedMeshPass(renderer.passContext,[primitive],propHooks);renderer.addPass("opaque",pass)
  let last=-1
  const update=(time:number,reduced=false)=>{
    const tick=Math.floor(time*(reduced?2:10));if(tick===last)return;last=tick
    for(let slot=0;slot<16;slot++){
      const x=(slot%4)*256,y=Math.floor(slot/4)*256,offset=reduced?0:(time*(5+slot%4))%18
      p.save();p.beginPath();p.rect(x,y,256,256);p.clip();p.fillStyle="#05100a";p.fillRect(x,y,256,256)
      p.font="11px monospace";p.textBaseline="top"
      for(let line=-1;line<16;line++){
        const index=(line+32+slot+Math.floor(time*(5+slot%4)/18))%prompts.length
        p.fillStyle=line%5===0?"#a8b77a":"#557e4f"
        p.fillText((line%5===0?"> ":"  ")+prompts[index],x+8,y+line*18-offset,240)
      }
      p.fillStyle="#020805";p.globalAlpha=.20;for(let scan=0;scan<256;scan+=3)p.fillRect(x,y+scan,256,1);p.restore()
    }
    d.queue.copyExternalImageToTexture({source:canvas},{texture:atlas},[1024,1024])
  };update(0)
  return {pass,update}
}

/** B and the car's descending floor lights use the same surface in both copies of the car. */
export function carDisplay(renderer:Renderer){
  const d=renderer.passContext.device,c=new OffscreenCanvas(256,128),p=c.getContext("2d")!
  const tex=d.createTexture({size:[256,128],format:"rgba8unorm-srgb",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT})
  const pixel=(v:number[])=>{const t=d.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});d.queue.writeTexture({texture:t},new Uint8Array(v),{},[1,1]);return t}
  const m=new Mesh(),uv:number[]=[]
  for(const ox of [0,BASEMENT_X]){
    let first=m.v.length
    m.quad([ox-.22,2.13,10.781],[ox-.22,2.34,10.781],[ox+.22,2.34,10.781],[ox+.22,2.13,10.781],[0,0,-1],[1,1,1],MAT.lit,8)
    for(let i=first;i<m.v.length;i+=11)uv.push(1-(m.v[i]-ox+.22)/.44,1-(m.v[i+1]-2.13)/.21)
    first=m.v.length
    m.quad([ox+.899,1.13,9.55],[ox+.899,1.235,9.55],[ox+.899,1.235,9.65],[ox+.899,1.13,9.65],[-1,0,0],[1,1,1],MAT.lit,8)
    for(let i=first;i<m.v.length;i+=11)uv.push(.78+(m.v[i+2]-9.55)/.10*.22,1-(m.v[i+1]-1.13)/.105)
  }
  const primitive:TexturedPrimitive={vertices:packTexturedVerts(m.v,uv),base:tex,normal:pixel([128,128,255,255]),orm:pixel([255,200,0,255]),color:[1,1,1,1],roughness:.5,metalness:0,normalScale:0,blend:false}
  const pass=new TexturedMeshPass(renderer.passContext,[primitive],propHooks);renderer.addPass("opaque",pass)
  let last=""
  return {pass,update(progress:number,arrived:boolean){
    const current=arrived?3:Math.min(2,Math.floor(progress*3)),key=`${current}`;if(key===last)return;last=key
    p.fillStyle="#0d0a05";p.fillRect(0,0,256,128);p.textAlign="center";p.textBaseline="middle";p.font="36px monospace"
    for(let i=0;i<3;i++){p.fillStyle=i===current?"#e8a94f":"#4c3417";p.fillText(String(3-i),32+i*60,64)}
    p.fillStyle="#e8a94f";p.fillText("B",228,64)
    d.queue.copyExternalImageToTexture({source:c},{texture:tex},[256,128])
  }}
}
