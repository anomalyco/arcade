import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { buildFoliageTree, foliageSettings } from "@arcade/kit/gpu/foliage"
import { Rng } from "@arcade/kit/sim/rng"
import type { Building, Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"

const rgb = (v:number):Rgb => [(v>>16&255)/255,(v>>8&255)/255,(v&255)/255]

/** Broadleaf scaffold: layered bough clusters, bent-normal peripheral leaf rosettes, interior canopy AO and base grass tufts. */
export function plant(m:Mesh,x:number,z:number,h:number,radius:number,seed:number,ground:number) {
  buildFoliageTree(m,x,z,h,radius,seed,ground,foliageSettings)
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
  // Framing side-yard trees, sidewalk-overhanging street canopies, corner shrubs, and driveway border hedges.
  for(const [px,pz,ph,pr] of [
    // Continuous dark border hedge & overarching woodland trees along the left driveway fence
    [x-3.62,e+2.05,1.46,.92],
    [x-3.58,e+.55,1.42,.86],
    [x-3.55,e-.95,1.38,.82],
    [x-3.65,e-2.80,1.34,.78],
    [x-3.60,z+3.20,1.38,.80],
    [x-5.25,e-.60,6.35,2.55],
    [x-4.85,z+3.60,6.65,2.65],
    // Multi-layered broadleaf street & side-yard trees overhanging the right lawn and north-south sidewalk
    [r+2.45,z+1.60,6.40,2.45],
    [r+2.95,z+5.80,6.85,2.65],
    [r+2.55,e-2.10,6.15,2.35],
    [r+.85,e+.40,1.48,.94],
    // Rounded dark-green shrub at the front-right lawn corner inside the sidewalk intersection + border companion
    [r+2.75,e+2.45,1.46,.94],
    [r+1.15,e+2.60,1.06,.74],
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
