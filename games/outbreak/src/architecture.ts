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

/** Broadleaf scaffold: exposed forks, separated shoots and folded leaf sprays. No opaque crown spheres. */
export function plant(m:Mesh,x:number,z:number,h:number,radius:number,seed:number,ground:number) {
  const rng=new Rng(seed),tree=h>2,tiers=tree?3:2,branches=3
  if(tree)branch(m,[x,ground,z],[x+.12,ground+h*.85,z-.15],.16)
  for(let tier=0;tier<tiers;tier++)for(let j=0;j<branches;j++){
    const angle=j*6.283/branches+tier*1.1+rng.next()*.5
    const reach=radius*(.7+rng.next()*.3)*(1-tier*.12)
    const start:Point=[x,ground+h*(tree?.3+tier*.17:.12),z]
    const tip:Point=[x+Math.cos(angle)*reach,ground+h*(.6+tier*.14),z+Math.sin(angle)*reach]
    branch(m,start,tip,tree?.07:.018)
    // Each shoot carries an offset pair of sprays; empty branch intervals preserve crown gaps.
    for(let shoot=0;shoot<2;shoot++){
      const t=.63+shoot*.36,cx=start[0]+(tip[0]-start[0])*t,cy=start[1]+(tip[1]-start[1])*t,cz=start[2]+(tip[2]-start[2])*t
      for(let leaf=0;leaf<6;leaf++){
        const a=angle+leaf*2.4,spread=radius*.29*Math.sqrt((leaf+1)/6)
        const px=cx+Math.cos(a)*spread,pz=cz+Math.sin(a)*spread,py=cy+(rng.next()-.45)*h*.13
        const size=(tree?.3:.11)+rng.next()*(tree?.28:.09),width=size*.64
        const f=[Math.cos(a)*size,Math.sin(a)*size],s=[-Math.sin(a)*width,Math.cos(a)*width]
        const center=[px,py+.05,pz],a0=[px-f[0]!,py,pz-f[1]!],a1=[px+s[0]!,py-.03,pz+s[1]!],a2=[px+f[0]!,py-.02,pz+f[1]!],a3=[px-s[0]!,py-.04,pz-s[1]!]
        const k=.75+rng.next()*.35,col:Rgb=[.28*k,.34*k,.18*k]
        for(const [a,b] of [[a0,a1],[a1,a2],[a2,a3],[a3,a0]])m.facet(center,a!,b!,col,MAT.foliage)
      }
    }
  }
}

/** Procedural bungalow over authoritative room and opening boundaries. */
export function house(m:Mesh,b:Building,id:number,town:Town) {
  const [x,z,r,e]=b.rect,mid=(z+e)/2,ridge=4.35+(town.houseSeed%3)*.12
  const trim=rgb(0x96978b),roof=rgb(0x495260),brick=rgb(0x624b40)
  if(b.kind!=="house"){m.box(x-.15,2.8,z-.15,r+.15,2.94,e+.15,rgb(0x555a54),MAT.roof,id);return}
  m.quadAuto([x-.42,2.88,e+.42],[r+.42,2.88,e+.42],[r+.42,ridge,mid],[x-.42,ridge,mid],roof,MAT.roof,id)
  m.quadAuto([x-.42,ridge,mid],[r+.42,ridge,mid],[r+.42,2.88,z-.42],[x-.42,2.88,z-.42],roof,MAT.roof,id)
  for(const px of [x-.01,r+.01])m.facet([px,2.8,z],[px,ridge,mid],[px,2.8,e],rgb(b.color),MAT.roof,id)
  m.box(x-.45,2.68,z-.42,r+.45,2.86,z-.31,trim,MAT.roof,id)
  m.box(x-.45,2.68,e+.31,r+.45,2.86,e+.42,trim,MAT.roof,id)
  // Dark soffit and half-round gutter read as a thin sheltered edge, not a white outline.
  m.box(x-.42,2.65,e+.03,r+.42,2.7,e+.4,rgb(0x555b55),MAT.roof,id)
  m.box(x-.48,2.74,e+.4,r+.48,2.80,e+.49,rgb(0x686f6b),MAT.roof,id)
  m.box(x-.42,ridge-.04,mid-.1,r+.42,ridge+.04,mid+.1,roof,MAT.roof,id)
  m.box(r-1.8,3.25,mid+1.1,r-1.15,4.7,mid+1.75,brick,MAT.brick)
  m.box(r-1.88,4.67,mid+1.02,r-1.07,4.78,mid+1.83,rgb(0x79796e))
  m.box(r-1.68,4.78,mid+1.22,r-1.27,4.79,mid+1.63,rgb(0x1e2427))
  const cx=x+5.7
  m.quadAuto([cx-1.5,2.5,e+1.6],[cx,3.15,e+1.6],[cx,3.15,e-.15],[cx-1.5,2.5,e-.15],roof,MAT.roof,id)
  m.quadAuto([cx,3.15,e+1.6],[cx+1.5,2.5,e+1.6],[cx+1.5,2.5,e-.15],[cx,3.15,e-.15],roof,MAT.roof,id)
  for(const px of [cx-1.3,cx+1.3]){
    m.box(px-.075,.13,e+1.22,px+.075,2.5,e+1.37,trim,MAT.wall)
    m.box(px-.12,.13,e+1.17,px+.12,.3,e+1.42,brick,MAT.brick)
  }
  // Door casing, lintel, sill and supported coir mat share the real 1.4m opening.
  for(const px of [x+4.94,x+6.4])m.box(px,.13,e-.24,px+.08,2.36,e+.06,trim,MAT.wall)
  m.box(x+4.94,2.3,e-.24,x+6.48,2.4,e+.06,trim,MAT.wall)
  m.box(x+5,.13,e-.28,x+6.4,.15,e+.18,rgb(0x7f7865))
  m.box(cx-.48,.132,e+.22,cx+.48,.155,e+.7,rgb(0x655740),MAT.timber)
  // Grouped foundation planting: dark soil, irregular species-scale clusters, intentional gaps.
  const rng=new Rng(town.houseSeed+id*71)
  for(const [a,d] of [[x+.3,x+4.4],[x+7.2,r-.3]]){
    m.quad([a!,.025,e+1.05],[d!,.025,e+1.05],[d!,.025,e+.1],[a!,.025,e+.1],[0,1,0],rgb(0x37352b),MAT.ground,5)
    let px=a!+.35
    while(px<d!-.25){const h=.42+rng.next()*.43;plant(m,px,e+.48+(rng.next()-.5)*.32,h,.38+rng.next()*.18,Math.floor(rng.next()*1e6),supportHeight(town,px,e+.5));px+=.65+rng.next()*.6}
    for(let px=a!;px<d!;px+=.5)m.box(px,.015,e+1.01,px+.42,.055,e+1.12,rgb(0x555c4b),MAT.brick)
  }
  for(const px of [x+.08,r-.14]){
    m.box(px,.12,e+.1,px+.07,2.77,e+.17,trim,MAT.timber)
    m.box(px,.1,e+.15,px+.07,.17,e+.5,trim,MAT.timber)
  }
  for(const px of [x,r-.10])m.box(px,.28,e-.015,px+.10,2.68,e+.025,trim,MAT.wall)
  // Narrow side-yard planting follows the gravel edge and leaves the drive/passages open.
  for(const [px,pz] of [[x-3.4,e-.9],[x-3.5,e-3.2],[r+.45,z+2.8],[r+.4,z+5.4]])plant(m,px!,pz!,1.1,.5,town.houseSeed+Math.floor(pz!*43),supportHeight(town,px!,pz!))
  for(let i=0;i<9;i++){
    const a=i*2.4,px=r-.85+Math.cos(a)*.35,pz=e+.62+Math.sin(a)*.25
    m.prism(px,pz,.055,.04,.6+(i%3)*.06,.68+(i%3)*.06,5,rgb(0xa9af92))
  }
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
  // A modest wood bench beside the porch, leaving the entrance and swing clear.
  m.box(x+7.7,.53,e+.2,x+9.3,.61,e+.63,rgb(0x6f6248),MAT.timber)
  for(const px of [x+7.85,x+9.15])m.box(px,.03,e+.27,px+.08,.53,e+.55,rgb(0x424737),MAT.timber)
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
