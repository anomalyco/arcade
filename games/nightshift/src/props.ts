import { imageTexture, loadGltf } from "@arcade/kit/gpu/gltf"
import { packTexturedVerts, TexturedMeshPass, type TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import { Mesh, MAT } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { propHooks } from "./shaders"
import { CRADLE, RECEIVER_PAD, PHONE_INDICATOR } from "./world"

export const PROP_DEFINITIONS=[
  {kind:"crt",file:"period/crt",at:[-.74,.795,-5.65],size:[.52,.50,.57],yaw:0,generated:true},
  {kind:"mouse",file:"computer",at:[-.74,.795,-5.62],size:[.94,.56,.58],yaw:0,generated:false},
  {kind:"pen-cup",file:"pen-cup",at:[1.02,.795,-5.35],size:[.15,.25,.14],yaw:.3,generated:false},
  {kind:"mug",file:"period/mug",at:[.62,.795,-5.48],size:[.09,.115,.125],yaw:-.7,generated:true},
  {kind:"chair",file:"period/chair",at:[1.04,0,-4.55],size:[.62,1.02,.65],yaw:-.3,generated:true},
  {kind:"phone",file:"period/phone-base",at:[.12,.79,-5.4],size:[.40,.13,.38],yaw:0,generated:true},
  {kind:"rolodex",file:"period/rolodex",at:[1.34,.795,-5.55],size:[.23,.19,.23],yaw:-.15,generated:true},
]

/** Fit the two ear pads to the actual base, rather than a guessed world height. */
export function phoneSurface(primitives:{vertices:ArrayBuffer}[],x:number,z:number) {
    let y=-Infinity
    for(const p of primitives) {
      const v=new Float32Array(p.vertices)
      for(let i=0;i<v.length;i+=24) {
        const ax=v[i],az=v[i+2],bx=v[i+8],bz=v[i+10],cx=v[i+16],cz=v[i+18]
        const det=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz)
        if(Math.abs(det)<1e-10)continue
        const u=((bz-cz)*(x-cx)+(cx-bx)*(z-cz))/det,w=((cz-az)*(x-cx)+(ax-cx)*(z-cz))/det
        if(u>=0&&w>=0&&u+w<=1)y=Math.max(y,u*v[i+1]+w*v[i+9]+(1-u-w)*v[i+17])
      }
    }
    if(!Number.isFinite(y))throw new Error(`Phone contact lies outside the base at ${x}, ${z}`)
    return y
}
export function cradleOn(primitives:{vertices:ArrayBuffer}[]) {
  const top=(x:number,z:number)=>phoneSurface(primitives,x,z)
  let roll=0,front=0,back=0
  for(let i=0;i<4;i++) {
    front=top(CRADLE[0],CRADLE[2]+RECEIVER_PAD*Math.cos(roll)-.025*Math.sin(roll))
    back=top(CRADLE[0],CRADLE[2]-RECEIVER_PAD*Math.cos(roll)-.025*Math.sin(roll))
    roll=Math.asin(Math.max(-.6,Math.min(.6,(back-front)/(2*RECEIVER_PAD))))
  }
  return {position:[CRADLE[0],(front+back)/2+.025*Math.cos(roll)+.0007,CRADLE[2]],roll,supports:{front,back},gap:.0007}
}

async function carpet(device:GPUDevice):Promise<TexturedPrimitive> {
  const texture=async(name:string,srgb:boolean,normal=false)=>{
    const response=await fetch(`${import.meta.env.BASE_URL}props/carpet-${name}.webp`)
    if(!response.ok)throw new Error(`Carpet ${name}: ${response.status}`)
    return imageTexture(device,new Uint8Array(await response.arrayBuffer()),srgb,"image/webp",undefined,normal)
  }
  const [base,normal,orm]=await Promise.all([texture("color",true),texture("normal",false,true),texture("orm",false)])
  const m=new Mesh()
  m.quad([-4,0,-9],[-4,0,9],[6,0,9],[6,0,-9],[0,1,0],[.45,.43,.36],MAT.lit,2)
  const uv:number[]=[]
  for(let i=0;i<m.v.length;i+=11)uv.push(m.v[i]/1.2,m.v[i+2]/1.2)
  return {vertices:packTexturedVerts(m.v,uv),base,normal,orm,color:[1,1,1,1],roughness:1,metalness:0,normalScale:.6,blend:false}
}

function screenCoordinates(p:TexturedPrimitive) {
  const v=new Float32Array(p.vertices)
  const xs:number[]=[],ys:number[]=[]
  for(let i=0;i<v.length;i+=8){xs.push(v[i]);ys.push(v[i+1])}
  const left=Math.min(...xs),bottom=Math.min(...ys),width=Math.max(...xs)-left,height=Math.max(...ys)-bottom
  // The generated mesh already supplies curvature; preserve its topology.
  for(let i=0;i<v.length;i+=8){v[i+6]=(v[i]-left)/width;v[i+7]=(v[i+1]-bottom)/height}
  p.roughness=.17
}

/** Licensed static props use the shared textured/physical-light/shadow path. */
export async function officeProps(renderer:Renderer) {
  let cradle={position:[...CRADLE],roll:0,supports:{front:0,back:0},gap:0}
  const indicator=[PHONE_INDICATOR[0],0,PHONE_INDICATOR[1]]
  const assets=await Promise.all(PROP_DEFINITIONS.map(async def=>{
    const asset=await loadGltf(renderer.passContext.device,`${import.meta.env.BASE_URL}props/${def.file}.glb`)
    // Generated phone base contains no receiver; the scene owns that moving part.
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity]
    for(const p of asset.primitives){const f=new Float32Array(p.vertices);for(let i=0;i<f.length;i+=8)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],f[i+k]);hi[k]=Math.max(hi[k],f[i+k])}}
    if(def.kind==="mouse")asset.primitives=asset.primitives.filter((_,i)=>i===1)
    for(const p of asset.primitives) {
      const f=new Float32Array(p.vertices),n=new Int8Array(p.vertices),half=new Uint16Array(p.vertices)
      const scale=def.size.map((v,k)=>v/(hi[k]-lo[k])),c=Math.cos(def.yaw),s=Math.sin(def.yaw)
      const screen=def.kind==="crt"&&p.color[0]<.1&&p.color[1]>.5&&p.color[2]>.7
      if(!def.generated){p.metalness=0;p.roughness=.65}
      if(def.kind==="chair")p.color=[1.7,1.7,1.55,1]
      if(def.kind==="phone")p.color=[1.5,1.4,1.15,1]
      for(let i=0;i<f.length;i+=8) {
        const x=(f[i]-(lo[0]+hi[0])/2)*scale[0],z=(f[i+2]-(lo[2]+hi[2])/2)*scale[2]
        f[i]=def.at[0]+c*x+s*z;f[i+1]=def.at[1]+(f[i+1]-lo[1])*scale[1];f[i+2]=def.at[2]-s*x+c*z
        const j=i*4+12,nx=n[j]/scale[0],ny=n[j+1]/scale[1],nz=n[j+2]/scale[2],len=Math.hypot(nx,ny,nz)
        n[j]=Math.round((c*nx+s*nz)/len*127);n[j+1]=Math.round(ny/len*127);n[j+2]=Math.round((-s*nx+c*nz)/len*127)
        if(screen)half[i*2+11]=0x4800 // aux = half-float 8, the CRT recipe.
      }
      if(screen)screenCoordinates(p)
    }
    if(def.kind==="phone") {
      cradle=cradleOn(asset.primitives)
      indicator[1]=phoneSurface(asset.primitives,indicator[0],indicator[2])+.0007
    }
    return asset
  }))
  const pass=new TexturedMeshPass(renderer.passContext,[...assets.flatMap(a=>a.primitives),await carpet(renderer.passContext.device)],propHooks)
  renderer.addPass("opaque",pass)
  return {casters:pass.shadowCasters(),cradle,indicator}
}
