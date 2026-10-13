import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { Rng } from "@arcade/kit/sim/rng"
import type { Building, Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"

const rgb = (v:number):Rgb => [(v>>16&255)/255,(v>>8&255)/255,(v&255)/255]

/** Layered, irregular crowns with little leaf clusters, all world-seeded and static. */
export function plant(m:Mesh, x:number, z:number, h:number, radius:number, seed:number, ground:number) {
  const rng=new Rng(seed), bark=rgb(0x514333)
  if(h>2) {
    m.prism(x,z,.18,.08,ground,ground+h*.65,7,bark,MAT.timber)
    for(let i=0;i<3;i++) { const a=i*2.1+rng.next(); m.yawBox(x+Math.cos(a)*.3,z+Math.sin(a)*.3,.8,.09,ground+h*.45,ground+h*.45+.13,a,bark,MAT.timber) }
  }
  const cluster=(cx:number,cy:number,cz:number,rx:number,ry:number,rz:number,col:Rgb) => {
    const rings=4,sides=9
    const point=(r:number,s:number) => { const a=r/rings*Math.PI, b=s/sides*Math.PI*2; return [cx+Math.sin(a)*Math.cos(b)*rx,cy+Math.cos(a)*ry,cz+Math.sin(a)*Math.sin(b)*rz] }
    for(let r=0;r<rings;r++) for(let s=0;s<sides;s++) {
      const a=point(r,s+1),b=point(r+1,s+1),c=point(r+1,s),d=point(r,s)
      for(const p of [a,b,c,a,c,d]) {
        const n=[(p[0]!-cx)/rx**2,(p[1]!-cy)/ry**2,(p[2]!-cz)/rz**2],length=Math.hypot(...n)
        m.vert(p,n.map(v=>v/length),col,MAT.foliage)
      }
    }
  }
  for(let i=0;i<8;i++) {
    const a=i*2.4, spread=i===0?0:radius*.65
    const cx=x+Math.cos(a)*spread, cz=z+Math.sin(a)*spread, cy=ground+h*(.65+rng.next()*.16)
    const tint=.8+rng.next()*.35
    const col:Rgb=[.34*tint,.42*tint,.22*tint]
    cluster(cx,cy,cz,radius*(.5+rng.next()*.2),h*.24,radius*.58,col)
    for(let j=0;j<32;j++) {
      const u=rng.next()*6.28, v=rng.next()*2.3, scale=.14+rng.next()*.10
      const px=cx+Math.cos(u)*radius*.6*Math.sin(v), pz=cz+Math.sin(u)*radius*.6*Math.sin(v), py=cy+Math.cos(v)*h*.24
      m.quad([px-scale,py,pz],[px,py+.07,pz+scale],[px+scale,py,pz],[px,py-.03,pz-scale],[0,1,0],[col[0]*1.1,col[1]*1.1,col[2]],MAT.foliage)
    }
  }
}

/** House-specific form over the authoritative footprint. Material recipes live in kit. */
export function house(m:Mesh,b:Building,id:number,town:Town) {
  const [x,z,r,e]=b.rect, mid=(z+e)/2, ridge=4.35+(town.houseSeed%3)*.12
  const trim=rgb(0xbcb9a9), roof=rgb(0x3c4246), brick=rgb(0x755044)
  if(b.kind==="house") {
    m.quadAuto([x-.4,2.87,e+.4],[r+.4,2.87,e+.4],[r+.4,ridge,mid],[x-.4,ridge,mid],roof,MAT.roof,id)
    m.quadAuto([x-.4,ridge,mid],[r+.4,ridge,mid],[r+.4,2.87,z-.4],[x-.4,2.87,z-.4],roof,MAT.roof,id)
    for(const px of [x-.01,r+.01]) m.facet([px,2.8,z-.05],[px,ridge,mid],[px,2.8,e+.05],rgb(b.color),MAT.roof,id)
    m.box(x-.45,2.72,z-.4,r+.45,2.89,z-.27,trim,MAT.roof,id)
    m.box(x-.45,2.72,e+.27,r+.45,2.89,e+.4,trim,MAT.roof,id)
    m.box(r-2.4,3.5,z+3,r-1.5,5.3,z+3.75,brick,MAT.brick)
    m.box(r-2.5,5.25,z+2.9,r-1.4,5.4,z+3.85,rgb(0x77766b))
    m.box(r-2.29,5.4,z+3.1,r-1.61,5.41,z+3.65,rgb(0x252c2c))
    m.box(x-.42,ridge-.04,mid-.1,r+.42,ridge+.04,mid+.1,roof,MAT.roof,id)
    // Small pitched porch; the existing threshold stays at 13cm, with no blocking stair.
    const cx=x+5.7
    m.quadAuto([cx-1.5,2.5,e+1.6],[cx,3.15,e+1.6],[cx,3.15,e-.1],[cx-1.5,2.5,e-.1],roof,MAT.roof,id)
    m.quadAuto([cx,3.15,e+1.6],[cx+1.5,2.5,e+1.6],[cx+1.5,2.5,e-.1],[cx,3.15,e-.1],roof,MAT.roof,id)
    for(const px of [cx-1.3,cx+1.3]) m.box(px-.07,.13,e+1.35,px+.07,2.5,e+1.49,trim,MAT.wall)
    // Side-drive gravel and porch planting leave the approach clear.
    for(const px of [x+.65,x+2.4,r-2.7,r-.7]) plant(m,px,e+.55,.9,.55,town.houseSeed+Math.floor(px*91),supportHeight(town,px,e+.55))
    for(const px of [x+.08,r-.14]) {
      m.box(px,.25,e+.07,px+.07,2.76,e+.15,trim,MAT.timber)
      m.box(px,.12,e+.1,px+.07,.22,e+.6,trim,MAT.timber)
    }
    // Restrained domestic furniture and fixtures, not a new floor plan.
    m.box(r-1.05,.13,z+6.9,r-.3,.94,z+9.5,rgb(0x857963),MAT.timber)
    m.box(r-1.1,.94,z+6.85,r-.25,1.01,z+9.55,rgb(0xb7b6a7))
    m.box(r-1.12,1.015,z+7.2,r-.3,1.025,z+7.8,rgb(0x515e5d))
    for(let d=0;d<3;d++) m.box(r-1.07,.2,z+7+d*.8,r-1.06,.87,z+7.7+d*.8,rgb(0xaaa18b))
    m.box(r-1.1,.13,z+10,r-.25,1.9,z+11,rgb(0xb0b4a9))
    m.box(r-4.5,.142,e-5.7,r-1.2,.15,e-2.7,rgb(0x6d5140))
    for(let k=0;k<4;k++) m.box(r-4.4+k*.13,.151,e-5.6,r-4.35+k*.13,.154,e-2.8,rgb(0xa88e62))
    // Dining corner, wall prints and a bedroom dresser, away from both door approaches.
    const wood=rgb(0x88714f)
    m.box(x+1.7,.72,e-5,x+3.7,.83,e-3.7,wood,MAT.timber)
    for(const px of [x+1.8,x+3.6]) for(const pz of [e-4.9,e-3.8]) m.box(px-.04,.13,pz-.04,px+.04,.73,pz+.04,wood,MAT.timber)
    for(const pz of [e-5.4,e-3.3]) for(const px of [x+2.1,x+3.3]) {
      m.box(px-.24,.48,pz-.24,px+.24,.56,pz+.24,wood,MAT.timber)
      m.box(px-.24,.5,pz-.25,px+.24,1.12,pz-.19,wood,MAT.timber)
      for(const dx of [-.19,.19]) m.box(px+dx-.025,.13,pz-.18,px+dx+.025,.48,pz+.18,wood,MAT.timber)
    }
    m.box(r-4,.13,z+.3,r-1.5,1.15,z+1,wood,MAT.timber)
    for(let d=0;d<3;d++) {
      m.box(r-3.95,.22+d*.29,z+1.01,r-1.55,.45+d*.29,z+1.04,rgb(0x9a8361),MAT.timber)
      m.box(r-2.9,.3+d*.29,z+1.04,r-2.6,.34+d*.29,z+1.08,rgb(0xc1b080))
    }
    for(const px of [x+2,r-3]) {
      m.box(px-.55,1.3,z+.225,px+.55,2.1,z+.28,wood,MAT.wall)
      m.box(px-.47,1.38,z+.285,px+.47,2.02,z+.3,rgb(0x7a8c7a),MAT.wall)
    }
    // Border-woven rugs have broad, stable details rather than tiny noisy textures.
    m.box(x+5,.135,z+1.1,x+8,.145,z+4.4,rgb(0x745047))
    m.box(x+5.15,.146,z+1.25,x+7.85,.15,z+4.25,rgb(0x9d865f))
    m.box(x+5.22,.151,z+1.32,x+7.78,.155,z+4.18,rgb(0x645449))
  } else {
    m.box(x-.15,2.8,z-.15,r+.15,2.94,e+.15,rgb(0x555a54),MAT.roof,id)
  }
  // Foundation is visible only beneath solid walls, so openings remain usable.
  for(const barrier of town.barriers) {
    const [a,c,d,f]=barrier.rect
    if(a<x || d>r || c<z || f>e || barrier.kind==="fence") continue
    m.box(a-.025,.08,c-.025,d+.025,.34,f+.025,brick,MAT.brick)
    m.box(a+.03,.34,c+.03,d-.03,.4,f-.03,trim,MAT.wall)
  }
}
