import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { Rng } from "@arcade/kit/sim/rng"
import type { Building, Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"

const rgb = (v:number):Rgb => [(v>>16&255)/255,(v>>8&255)/255,(v&255)/255]
type Point = [number,number,number]

function branch(m:Mesh,a:Point,b:Point,r:number) {
  const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2],len=Math.hypot(dx,dy,dz)
  const axis=[dx/len,dy/len,dz/len],side=Math.hypot(dx,dz)
  const u=side<.001?[1,0,0]:[-dz/side,0,dx/side]
  const v=[axis[1]!*u[2]!-axis[2]!*u[1]!,axis[2]!*u[0]!-axis[0]!*u[2]!,axis[0]!*u[1]!-axis[1]!*u[0]!]
  const p=(end:number,i:number)=>{const q=end?b:a,s=r*(end?.4:1),c=Math.cos(i*6.283/5),n=Math.sin(i*6.283/5);return q.map((x,j)=>x+s*(u[j]!*c+v[j]!*n))}
  for(let i=0;i<5;i++)m.quadAuto(p(0,i),p(1,i),p(1,i+1),p(0,i+1),rgb(0x484332),MAT.timber)
}

/** Shadowed inner foliage core + peripheral ruffled leaf rosettes for fine organic silhouettes. */
function leafRosette(m:Mesh,px:number,py:number,pz:number,size:number,tiltX:number,tiltZ:number,rng:Rng,tone:Rgb) {
  const a=rng.next()*6.283,w=size*(.76+rng.next()*.22)
  const f=[Math.cos(a)*size,Math.sin(a)*size],side=[-Math.sin(a)*w,Math.cos(a)*w]
  const dome=size*.34,droop=size*.18
  const center:Point=[px+tiltX*.05,py+dome,pz+tiltZ*.05]
  const a0:Point=[px-f[0]!,py-droop*.5-tiltX*f[0]!*.22,pz-f[1]!]
  const a1:Point=[px+side[0]!,py-droop-tiltZ*side[1]!*.22,pz+side[1]!]
  const a2:Point=[px+f[0]!,py-droop*.7+tiltX*f[0]!*.22,pz+f[1]!]
  const a3:Point=[px-side[0]!,py-droop+tiltZ*side[1]!*.22,pz-side[1]!]
  const k=.88+rng.next()*.26,col:Rgb=[tone[0]*k,tone[1]*k,tone[2]*k]
  for(const [p0,p1] of [[a0,a1],[a1,a2],[a2,a3],[a3,a0]])m.facet(center,p0!,p1!,col,MAT.foliage)
}

function foliageCluster(m:Mesh,cx:number,cy:number,cz:number,rx:number,ry:number,rng:Rng,base:Rgb,rosettes:number) {
  // Compact dark inner shadow core so the cluster has volume without looking like a balloon.
  const segs=5,top:Point=[cx,cy+ry*.55,cz],ring:Point[]=[]
  const dark:Rgb=[base[0]*.52,base[1]*.55,base[2]*.48]
  for(let i=0;i<segs;i++){
    const a=(i/segs)*6.283+(rng.next()-.5)*.28,r=rx*(.52+rng.next()*.18)
    ring.push([cx+Math.cos(a)*r,cy-ry*.18,cz+Math.sin(a)*r])
  }
  for(let i=0;i<segs;i++)m.facet(top,ring[i]!,ring[(i+1)%segs]!,dark,MAT.foliage)
  // Peripheral overlapping leaf rosettes break the silhouette into crisp leafy lobes.
  for(let s=0;s<rosettes;s++){
    const a=s*(6.283/rosettes)+(rng.next()-.5)*.55
    const radial=rx*(s===0?.18:.48+rng.next()*.44)
    const ox=Math.cos(a)*radial,oz=Math.sin(a)*radial
    const oy=s===0?ry*.48:ry*(.24-(radial/rx)*.36+(rng.next()-.5)*.22)
    const sz=rx*(s===0?.46:.34+rng.next()*.22)
    const lift=s===0?1.12:.86+(1-radial/rx)*.28
    const tone:Rgb=[Math.min(1,base[0]*lift),Math.min(1,base[1]*lift),Math.min(1,base[2]*lift)]
    leafRosette(m,cx+ox,cy+oy,cz+oz,sz,Math.cos(a),Math.sin(a),rng,tone)
  }
}

/** Broadleaf scaffold: layered bough clusters, dark inner cores, ruffled peripheral leaf sprays and crown gaps. */
export function plant(m:Mesh,x:number,z:number,h:number,radius:number,seed:number,ground:number) {
  const rng=new Rng(seed),tree=h>2.1,boughs=tree?6:4,gapAngle=rng.next()*6.283
  const leanX=(rng.next()-.5)*(tree?.22:.04),leanZ=(rng.next()-.5)*(tree?.22:.04)
  if(tree)branch(m,[x,ground,z],[x+leanX,ground+h*.72,z+leanZ],.16)
  // sRGB palette: rich olive, warm autumn-ochre green, deep forest green, and sunlit sage.
  const palette:Rgb[]=[[0.36,0.44,0.24],[0.44,0.48,0.26],[0.28,0.37,0.19],[0.49,0.50,0.27],[0.32,0.41,0.22]]
  for(let b=0;b<boughs;b++){
    const baseAngle=b*6.283/boughs+(rng.next()-.5)*.45
    const gapDelta=Math.abs(Math.atan2(Math.sin(baseAngle-gapAngle),Math.cos(baseAngle-gapAngle)))
    const inGap=gapDelta<.55
    const tierFrac=b/(boughs-1)
    const reach=radius*(inGap?.36:.52+(1-tierFrac*.25)*(.30+rng.next()*.26))
    const startH=ground+h*(tree?.28+tierFrac*.22:.10+tierFrac*.12)
    const tipH=ground+h*(tree?.50+tierFrac*.34+(rng.next()-.4)*.08:.42+tierFrac*.36)
    const start:Point=[x+leanX*.35,startH,z+leanZ*.35]
    const tip:Point=[x+Math.cos(baseAngle)*reach,tipH,z+Math.sin(baseAngle)*reach]
    if(tree)branch(m,start,tip,.068*(1-tierFrac*.28))
    const clusterTone=palette[(b+Math.floor(rng.next()*2))%palette.length]!
    const rx=radius*(tree?(inGap?.34:.46+rng.next()*.16):.46+rng.next()*.16)
    const ry=h*(tree?.16+rng.next()*.06:.28+rng.next()*.10)
    foliageCluster(m,tip[0],tip[1],tip[2],rx,ry,rng,clusterTone,tree?5:4)
    if(tree&&!inGap&&b%2===0){
      const subA=baseAngle+(rng.next()-.5)*.65,subR=reach*.58
      const sx=x+Math.cos(subA)*subR,sz=z+Math.sin(subA)*subR,sy=tip[1]+h*.12
      foliageCluster(m,sx,sy,sz,rx*.76,ry*.85,rng,palette[(b+3)%palette.length]!,4)
    }
  }
  const crownTone=palette[seed%palette.length]!
  foliageCluster(m,x+leanX*.45,ground+h*(tree?.84:.68),z+leanZ*.45,radius*(tree?.44:.48),h*(tree?.15:.24),rng,crownTone,tree?5:4)
  const coverCount=tree?4:2
  for(let c=0;c<coverCount;c++){
    const a=gapAngle+1.2+c*1.45+(rng.next()-.5)*.35,d=radius*(tree?.26:.42)*(0.65+rng.next()*.45)
    const gx=x+Math.cos(a)*d,gz=z+Math.sin(a)*d,sz=(tree?.24:.15)+rng.next()*.09,gh=(tree?.16:.11)+rng.next()*.06
    const col:Rgb=[.30+.08*rng.next(),.38+.08*rng.next(),.19+.05*rng.next()]
    const top=[gx,ground+gh,gz]
    for(let k=0;k<3;k++){
      const ka=a+k*2.09,ka2=ka+1.15
      m.facet(top,[gx+Math.cos(ka)*sz,ground+.01,gz+Math.sin(ka)*sz],[gx+Math.cos(ka2)*sz,ground+.01,gz+Math.sin(ka2)*sz],col,MAT.foliage)
    }
  }
}

/** Procedural bungalow over authoritative room and opening boundaries. */
export function house(m:Mesh,b:Building,id:number,town:Town) {
  const [x,z,r,e]=b.rect,mid=(z+e)/2,ridge=4.35+(town.houseSeed%3)*.12
  const trim=rgb(0xd4d2c8),roof=rgb(0x3d4758),brick=rgb(0x684339)
  if(b.kind!=="house"){m.box(x-.15,2.8,z-.15,r+.15,2.94,e+.15,rgb(0x555a54),MAT.roof,id);return}
  const slopeY = (pz: number) => 2.88 + (ridge - 2.88) * (1 - Math.abs(pz - mid) / (mid - (z - .42)))
  const xCuts = [x - .42, x + .36, r - .36, r + .42]
  for (const [z0, z1] of [[e + .42, e - .36], [e - .36, mid], [mid, z + .36], [z + .36, z - .42]] as const) {
    const y0 = slopeY(z0), y1 = slopeY(z1)
    for (let xi = 0; xi < 3; xi++) {
      const x0 = xCuts[xi]!, x1 = xCuts[xi + 1]!
      m.quadAuto([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1], roof, MAT.roof, id)
    }
  }
  for(const px of [x-.01,r+.01])m.facet([px,2.8,z],[px,ridge,mid],[px,2.8,e],rgb(b.color),MAT.roof,id)
  m.box(x-.45,2.68,z-.42,r+.45,2.86,z-.31,trim,MAT.roof,id)
  m.box(x-.45,2.72,e+.34,r+.45,2.87,e+.44,trim,MAT.roof,id)
  // Dark soffit and half-round gutter read as a crisp eave border with trim fascia.
  m.box(x-.42,2.63,e+.02,r+.42,2.71,e+.40,rgb(0x282e38),MAT.roof,id)
  m.box(x-.48,2.76,e+.43,r+.48,2.83,e+.50,rgb(0x9da4b0),MAT.roof,id)
  for (let xi = 0; xi < 3; xi++) {
    m.box(xCuts[xi]!, ridge - .04, mid - .1, xCuts[xi + 1]!, ridge + .04, mid + .1, rgb(0x4b5668), MAT.roof, id)
  }
  // Brick chimney on upper-right slope with stone cap and dark flue.
  m.box(r-2.05,3.20,mid+.85,r-1.15,4.78,mid+1.75,brick,MAT.brick)
  m.box(r-2.13,4.74,mid+.77,r-1.07,4.86,mid+1.83,rgb(0x888b90))
  m.box(r-1.88,4.86,mid+1.02,r-1.32,4.88,mid+1.58,rgb(0x181c22))
  const cx=x+5.7
  // Gabled porch canopy with dark shingle slopes, shadowed tympanum and crisp white rake trim (^).
  m.quadAuto([cx-1.62,2.46,e+1.58],[cx,3.22,e+1.58],[cx,3.22,e-.15],[cx-1.62,2.46,e-.15],roof,MAT.roof,id)
  m.quadAuto([cx,3.22,e+1.58],[cx+1.62,2.46,e+1.58],[cx+1.62,2.46,e-.15],[cx,3.22,e-.15],roof,MAT.roof,id)
  m.facet([cx-1.52,2.46,e+1.48],[cx,3.16,e+1.48],[cx+1.52,2.46,e+1.48],rgb(0x2c323d),MAT.roof,id)
  m.quadAuto([cx-1.64,2.42,e+1.60],[cx,3.19,e+1.60],[cx,3.26,e+1.56],[cx-1.64,2.49,e+1.56],trim,MAT.roof,id)
  m.quadAuto([cx,3.19,e+1.60],[cx+1.64,2.42,e+1.60],[cx+1.64,2.49,e+1.56],[cx,3.26,e+1.56],trim,MAT.roof,id)
  m.box(cx-1.58,2.38,e+1.36,cx+1.58,2.46,e+1.52,trim,MAT.roof,id)
  for(const px of [cx-1.32,cx+1.32]){
    m.box(px-.09,.34,e+1.20,px+.09,2.42,e+1.38,rgb(0xeae4d7),MAT.wall)
    m.box(px-.14,.13,e+1.15,px+.14,.34,e+1.43,rgb(0xd8d2c5),MAT.wall)
  }
  // Porch steps leading to the front walkway, plus wall mailbox next to the door.
  m.box(cx-.85,.08,e+1.28,cx+.85,.135,e+1.52,rgb(0xb8b2a4),MAT.wall)
  m.box(cx+1.02,1.22,e+.01,cx+1.22,1.44,e+.10,rgb(0x2b3036),MAT.wall)
  // Door casing, lintel, sill and supported coir mat share the real 1.4m opening.
  for(const px of [x+4.92,x+6.40])m.box(px,.13,e-.24,px+.09,2.38,e+.07,rgb(0xeae4d7),MAT.wall)
  m.box(x+4.92,2.30,e-.24,x+6.49,2.42,e+.07,rgb(0xeae4d7),MAT.wall)
  m.box(x+5,.13,e-.28,x+6.4,.15,e+.18,rgb(0x9a9382))
  m.box(cx-.52,.132,e+.20,cx+.52,.155,e+.74,rgb(0x523f2c),MAT.timber)
  // Grouped foundation planting: natural soil bed without toothed brick edging, boxwood pair by porch, corner shrubs and hydrangea.
  const rng=new Rng(town.houseSeed+id*71)
  for(const [a,d] of [[x+.15,x+4.35],[x+7.15,r-.15]]){
    m.quad([a!,.022,e+.92],[d!,.022,e+.92],[d!,.022,e+.05],[a!,.022,e+.05],[0,1,0],rgb(0x28291f),MAT.ground,5)
  }
  // Left corner shrub cluster + low under-window shrubs
  for(const [px,pz,ph,pr] of [
    [x+.45,e+.48,1.08,.74],
    [x-.28,e-.35,1.18,.78],
    [x+1.35,e+.44,.68,.48],
    [x+2.45,e+.46,.52,.42],
    [x+3.65,e+.38,.58,.44],
    // Two distinct rounded boxwood shrubs right of the porch column
    [x+7.55,e+.48,.88,.58],
    [x+8.62,e+.50,.84,.56],
    // Low border shrubs under the right window
    [x+10.1,e+.42,.52,.42],
    [x+11.4,e+.44,.56,.44],
    // Hydrangea bush at the front-right corner
    [r-1.05,e+.58,.96,.76],
  ])plant(m,px!,pz!,ph!,pr!,Math.floor(rng.next()*1e6),supportHeight(town,px!,pz!))
  // Creamy-white hydrangea flower clusters on the front-right corner bush
  for(let i=0;i<14;i++){
    const a=i*2.399,dist=.12+(i%4)*.15,px=r-1.05+Math.cos(a)*dist,pz=e+.58+Math.sin(a)*dist*.82
    const py=.48+(1-(i%4)*.18)*.42+(i%2)*.05
    m.prism(px,pz,.075,.055,py,py+.09,6,rgb(i%3===0?0xdde3d5:0xc5cebc))
  }
  for(const px of [x+.08,r-.14]){
    m.box(px,.12,e+.1,px+.07,2.77,e+.17,trim,MAT.timber)
    m.box(px,.1,e+.15,px+.07,.17,e+.5,trim,MAT.timber)
  }
  for(const px of [x,r-.10])m.box(px,.28,e-.015,px+.10,2.68,e+.025,trim,MAT.wall)
  // Framing side-yard trees and border hedges along the driveway and east side of the house.
  for(const [px,pz,ph,pr] of [
    [x-3.55,e-.4,1.35,.78],
    [x-3.65,e-2.8,1.28,.72],
    [x-3.60,z+3.2,1.35,.74],
    [r+1.05,z+1.8,4.4,1.25],
    [r+1.15,z+5.8,4.8,1.35],
    [r+1.05,e-2.6,4.2,1.22],
    [r+.55,e+.35,1.38,.82],
  ])plant(m,px!,pz!,ph!,pr!,town.houseSeed+Math.floor(pz!*43+px!*17),supportHeight(town,px!,pz!))
  // Two furnished zones, with the 1.4m entrance-to-bedroom circulation lane kept empty.
  const rug=(a:number,c:number,d:number,f:number,color:number)=>{
    m.box(a,.132,c,d,.14,f,rgb(0x796449));m.box(a+.10,.141,c+.10,d-.10,.145,f-.10,rgb(color))
    for(let t=0;t<3;t++)m.box(a+.16+t*.08,.146,c+.15,a+.20+t*.08,.15,f-.15,rgb(0x8f7956))
  }
  rug(x+.45,e-3.7,x+4.5,e-.5,0x514d3f)
  rug(x+3.05,z+.65,x+5.05,z+4.2,0x6c5545)
  // Upper kitchen cupboards and a tiled splashback, supported by the east wall.
  m.box(r-.245,1.02,e-3.2,r-.23,1.67,e-.85,rgb(0x727d70),MAT.wall)
  m.box(r-.65,1.78,e-3.2,r-.25,2.37,e-1.2,rgb(0x85785e),MAT.wall)
  for(let i=0;i<3;i++)m.box(r-.67,1.82,e-3.15+i*.64,r-.65,2.33,e-2.56+i*.64,rgb(0x998769),MAT.wall)
  // Radiator and framed print occupy a wall, rather than adding another partition.
  for(let i=0;i<8;i++)m.box(r-3.7+i*.13,.3,z+.25,r-3.62+i*.13,.85,z+.42,rgb(0x87877a),MAT.wall)
  for(const [px,pz] of [[x+3,z+.23],[r-3,e-.27]]){
    m.box(px!-.55,1.25,pz!,px!+.55,2,pz!+.055,rgb(0x534838),MAT.wall)
    m.box(px!-.46,1.34,pz!+.056,px!+.46,1.91,pz!+.062,rgb(0x81856f),MAT.wall)
  }
  for(const barrier of town.barriers){
    const [a,c,d,f]=barrier.rect
    if(a<x||d>r||c<z||f>e||barrier.kind==="fence")continue
    m.box(a-.018,.025,c-.018,d+.018,.28,f+.018,brick,MAT.brick)
    m.box(a,.28,c,d,.32,f,trim,MAT.wall)
  }
}
