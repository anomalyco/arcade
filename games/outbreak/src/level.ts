import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { LevelChunk, LevelData } from "@arcade/kit/gpu/level"
import { CHUNK, SIZE, BUILDING_RECTS, frontageEnd, propShape, type Town, type Prop } from "../shared/map"
import { terrainVertex, supportHeight } from "../shared/terrain"
import { house, plant } from "./architecture"
import { Rng } from "@arcade/kit/sim/rng"
import { distToRect } from "@arcade/kit/sim/geom"
import { scatterClusteredGroundCover } from "@arcade/kit/gpu/surface-materials"

export const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
const floor = (m: Mesh, x: number, z: number, r: number, b: number, h: number, color: number, kind: number) => m.quad([x, h, b], [r, h, b], [r, h, z], [x, h, z], [0, 1, 0], hex(color), MAT.ground, kind === 8 ? 0 : kind === 5 ? 1 : kind === 2 ? 4 : kind === 7 ? 3 : kind === 3 ? 6 : 2)

function furniture(m: Mesh, p: Prop, town: Town): void {
  const { x, y: z, kind } = p
  if (kind === "tree") {
    plant(m,x,z,4.6+p.variant*1.8,2.05+p.variant*.75,Math.floor(p.variant*1e6),supportHeight(town,x,z))
    return
  }
  const wood = hex(0x7a5c3e), legs = hex(0x3b352e)
  if (kind === "bed") {
    // Honey-oak frame, headboard & footboard, crisp white sheets/pillows, and quilted olive-green blanket
    m.box(x - .82, .12, z - 1.22, x + .82, .42, z + 1.22, wood, MAT.timber)
    m.box(x - .86, .15, z - 1.30, x + .86, 1.06, z - 1.16, hex(0x8c6b48), MAT.timber)
    m.box(x - .84, .14, z + 1.16, x + .84, .58, z + 1.26, hex(0x826242), MAT.timber)
    m.bevelBox(x - .78, .42, z - 1.15, x + .78, .64, z + 1.15, .06, hex(0xcfc8b8), hex(0xe0dacb))
    // Quilted olive bedspread over lower two-thirds + cream fold-back sheet strip
    m.bevelBox(x - .80, .44, z - .38, x + .80, .67, z + 1.16, .05, hex(0x42523b), hex(0x526449))
    m.box(x - .79, .65, z - .48, x + .79, .68, z - .32, hex(0xdad4c4))
    for (const qz of [z - .02, z + .38, z + .78]) m.box(x - .76, .668, qz, x + .76, .676, qz + .03, hex(0x364430))
    // Two plump white pillows
    for (const px of [x - .38, x + .38]) m.bevelBox(px - .31, .64, z - 1.06, px + .31, .78, z - .62, .04, hex(0xd4cebf), hex(0xeae4d6))
  } else if (kind === "sofa") {
    // Warm olive-sage 3-cushion sofa with rolled arms, rust & ochre throw pillows, and side lamp table
    m.box(x-.56,.20,z-1.26,x+.56,.45,z+1.26,hex(0x58604e))
    m.bevelBox(x-.62,.35,z-1.32,x-.34,1.02,z+1.32,.06,hex(0x636c58),hex(0x78826a))
    for(const dz of [-.74,0,.74]){
      m.bevelBox(x-.32,.44,z+dz-.35,x+.53,.62,z+dz+.35,.055,hex(0x68725d),hex(0x808a72))
      m.bevelBox(x-.38,.60,z+dz-.34,x-.16,.96,z+dz+.34,.045,hex(0x6e7862),hex(0x848e76))
    }
    for(const s of [-1,1])m.bevelBox(x-.56,.40,z+s*1.18-.14,x+.56,.84,z+s*1.18+.14,.04,hex(0x5f6854),hex(0x747e68))
    for(const dx of [-.42,.42])for(const dz of [-1.05,1.05])m.box(x+dx-.04,.13,z+dz-.04,x+dx+.04,.22,z+dz+.04,legs)
    // Rust-orange throw pillow at north end + cream cushion & draped throw at south end
    m.bevelBox(x-.24,.62,z-.98,x+.22,.84,z-.58,.045,hex(0x8f4326),hex(0xa85232))
    m.bevelBox(x-.24,.62,z+.60,x+.24,.83,z+1.02,.045,hex(0xb5a482),hex(0xcfc09e))
    // End table at south arm of sofa under the living room table lamp
    m.bevelBox(x-.32,.13,z+1.38,x+.32,.66,z+1.96,.025,wood,hex(0x8f6d4a),MAT.timber,MAT.timber)
  } else if(kind==="coffee") {
    m.bevelBox(x-.52,.42,z-.78,x+.52,.52,z+.78,.035,wood,hex(0x8c6a46),MAT.timber,MAT.timber)
    for(const dx of [-.42,.42])for(const dz of [-.65,.65])m.box(x+dx-.035,.13,z+dz-.035,x+dx+.035,.43,z+dz+.035,legs)
    // Open book, ceramic mug, and small potted centerpiece plant on coffee table
    m.box(x-.22,.52,z+.14,x+.20,.56,z+.52,hex(0xd8d2c0))
    m.prism(x-.16,z-.38,.07,.065,.52,.63,8,hex(0xc8c0aa))
    m.prism(x+.14,z-.22,.12,.09,.52,.66,8,hex(0x7c4a32))
    m.prism(x+.14,z-.22,.18,.08,.64,.82,7,hex(0x465c36),MAT.foliage)
  } else if(kind==="nightstand") {
    m.bevelBox(x-.28,.14,z-.28,x+.28,.66,z+.28,.02,wood,hex(0x8e6c48),MAT.timber,MAT.timber)
    m.box(x-.23,.36,z+.28,x+.23,.60,z+.30,hex(0x987652),MAT.timber)
    m.box(x-.055,.48,z+.30,x+.055,.51,z+.33,hex(0xc4ab78))
  } else if(kind==="stove") {
    m.box(x-.36,.13,z-.4,x+.36,.92,z+.4,hex(0x74583c),MAT.timber)
    m.box(x-.38,.92,z-.42,x+.38,.96,z+.42,hex(0xa8a292))
  } else if(kind==="counter"||kind==="dresser"||kind==="fridge") {
    const {rect:[a,c,r,e],height}=propShape(p)!
    const pale=kind==="fridge"?0x786044:0x765a3e
    m.box(a,.13,c,r,height-.06,e,hex(pale),MAT.timber)
    m.box(a-.02,height-.06,c-.02,r+.02,height,e+.02,hex(kind==="counter"?0xb2ac9c:0x8c6c4a),MAT.timber)
    if(kind==="counter"){
      for(const dz of [-.85,.0,.85])m.box(a-.01,.2,z+dz-.32,a-.005,.88,z+dz+.32,hex(0x8e704e),MAT.timber)
    }else if(kind==="fridge"){
      m.box(a-.015,.22,c+.05,a,height-.12,e-.05,hex(0x8c6e4c),MAT.timber)
    }else {
      for(let i=0;i<3;i++)for(const [da,dr] of [[a+.05,(a+r)/2-.03],[(a+r)/2+.03,r-.05]]){
        m.box(da!,.20+i*.27,e+.002,dr!,.43+i*.27,e+.022,hex(0x8e6e4c),MAT.timber)
        const mx=(da!+dr!)/2
        m.box(mx-.08,.30+i*.27,e+.022,mx+.08,.34+i*.27,e+.055,hex(0xc2a874))
      }
      // Potted plant & keepsake box on top of the bedroom dresser
      m.prism(a+.42,c+.35,.12,.09,height,height+.16,7,hex(0x7e4c34))
      m.prism(a+.42,c+.35,.19,.08,height+.14,height+.36,7,hex(0x485e38),MAT.foliage)
    }
  } else if(kind==="chair") {
    m.box(x-.26,.50,z-.26,x+.26,.58,z+.26,hex(0x826242),MAT.timber)
    m.box(x-.26,.58,z+.19,x+.26,1.04,z+.26,hex(0x8c6b48),MAT.timber)
    for(const dx of [-.21,.21])for(const dz of [-.21,.21])m.box(x+dx-.025,.13,z+dz-.025,x+dx+.025,.50,z+dz+.025,legs)
  } else if (kind === "table") {
    // Rich walnut dining/study table with beveled plank top and fruit bowl centerpiece
    m.bevelBox(x - .72, .72, z - .95, x + .72, .82, z + .95, .03, wood, hex(0x8e6b46), MAT.timber, MAT.timber)
    for (const dx of [-.60, .60]) for (const dz of [-.80, .80]) m.box(x + dx - .045, .13, z + dz - .045, x + dx + .045, .72, z + dz + .045, legs)
    m.prism(x, z, .20, .14, .82, .91, 8, hex(0x63482e), MAT.timber)
    m.prism(x - .05, z - .03, .07, .05, .89, .96, 6, hex(0xd4882e))
    m.prism(x + .06, z + .04, .065, .045, .89, .95, 6, hex(0x789438))
  } else {
    for (const dx of [-.8, .8]) m.box(x + dx - .06, .1, z - .38, x + dx + .06, 1.8, z + .38, legs)
    for (const h of [.3, .85, 1.4]) {
      m.box(x - .85, h, z - .4, x + .85, h + .07, z + .4, wood, MAT.timber)
      for (let i = 0; i < 5; i++) {
        const px = x - .68 + i * .3
        m.box(px, h + .07, z - .25, px + .2, h + .2 + (p.variant + i * .13) % .27, z + .25, hex(i % 2 ? 0xa39b7c : 0x5a7973))
      }
    }
  }
}

/** Cache immutable static generation; doors and actors stay in dynamic batches. */
const levelCache = new Map<string, LevelData>()
export function buildLevel(town: Town): LevelData {
  const key=`${town.seed}/${town.houseSeed}/${town.terrain}/${town.foliageDensity??1}`
  const cached=levelCache.get(key)
  if(cached)return cached
  const level=compileLevel(town)
  if(levelCache.size>=3)levelCache.delete(levelCache.keys().next().value!)
  levelCache.set(key,level)
  return level
}

function compileLevel(town: Town): LevelData {
  const meshes = town.chunks.map(() => new Mesh()), glasses = town.chunks.map(() => new Mesh()), props: Mesh[]=[]
  const at = (x: number, z: number, glass = false) => (glass ? glasses : meshes)[Math.min(2, Math.max(0, Math.floor(z / CHUNK))) * 3 + Math.min(2, Math.max(0, Math.floor(x / CHUNK)))]!
  for (let z=0;z<SIZE;z++) for(let x=0;x<SIZE;x++) {
    if((x>=40&&x<48)||(z>=40&&z<48)||town.buildings.some(b=>x>=b.rect[0]&&x+1<=b.rect[2]&&z>=b.rect[1]&&z+1<=b.rect[3]))continue
    const m=at(x,z), a=[x,terrainVertex(town,x,z),z], b=[x+1,terrainVertex(town,x+1,z),z], c=[x+1,terrainVertex(town,x+1,z+1),z+1], d=[x,terrainVertex(town,x,z+1),z+1]
    m.facet(a,c,b,hex(0x586044),MAT.ground,0); m.facet(a,d,c,hex(0x586044),MAT.ground,0)
  }
  const tufts = scatterClusteredGroundCover({
    seed: town.seed ^ 0x453a,
    bounds: [0.5, 0.5, SIZE - 0.5, SIZE - 0.5],
    clusterCount: Math.round(210 * (town.foliageDensity ?? 1)),
    tuftsPerCluster: 4,
    avoid: (x, z) =>
      (x > 37.8 && x < 50.2) ||
      (z > 37.8 && z < 50.2) ||
      town.buildings.some(b => x > b.rect[0] - 3.1 && x < b.rect[2] + 0.3 && z > b.rect[1] - 0.4 && z < b.rect[3] + 1.8),
  })
  for (const t of tufts) {
    const { x, z, radius: r, height: h, tint: c } = t
    const y = supportHeight(town, x, z), m = at(x, z)
    m.facet([x - r * .7, y, z - r * .3], [x + r * .2, y + h, z + r * .3], [x + r * .8, y, z - r * .2], c, MAT.foliage)
    m.facet([x - r * .2, y, z - r * .8], [x - r * .3, y + h * .85, z + r * .2], [x + r * .4, y, z + r * .7], c, MAT.foliage)
  }
  // Clustered curb-verge & front-lawn edge ground cover with natural gaps.
  const vergeRng = new Rng(town.seed ^ 0x91e1)
  for (let v = 2; v < SIZE - 2; v += 0.95 + vergeRng.next() * 1.45) {
    if (v > 37.5 && v < 50.5) continue
    for (const zBase of [37.82, 39.55, 48.45, 50.18]) {
      if (vergeRng.next() < 0.24) continue
      if (town.buildings.some(b => Math.abs(v - (b.rect[0] + 5.7)) < 1.0 || (v > b.rect[0] - 3.2 && v < b.rect[0] - 0.2))) continue
      const count = zBase > 39 && zBase < 49 ? 3 : 2
      for (let k = 0; k < count; k++) {
        const x = v + (vergeRng.next() - 0.5) * 0.62, z = zBase + (vergeRng.next() - 0.5) * 0.22
        const y = supportHeight(town, x, z), m = at(x, z), r = 0.10 + vergeRng.next() * 0.12, h = 0.11 + vergeRng.next() * 0.14
        const c = hex(vergeRng.pick([0x5a6840, 0x4d5c37, 0x6f7348, 0x7b7846]))
        m.facet([x - r, y, z], [x + r * .2, y + h, z + r * .4], [x + r, y, z - r * .2], c, MAT.foliage)
        m.facet([x, y, z - r], [x - r * .4, y + h * .85, z], [x + r * .2, y, z + r], c, MAT.foliage)
      }
    }
  }
  // Segment streets at chunk edges to retain useful culling.
  for (let v = 0; v < SIZE; v += CHUNK) {
    floor(at(44, v), 40, v, 48, v + CHUNK, .014, 0x454d5c, 5)
    for(const [a,b] of [[0,40],[48,96]]) {
      const x0=Math.max(v,a!),x1=Math.min(v+CHUNK,b!)
      if(x1>x0) floor(at(v,44),x0,40,x1,48,.014,0x454d5c,5)
    }
  }
  for(let v=0;v<SIZE;v++) {
    if(v>=38 && v<50) continue
    for(const s of [38,48]) {
      const a=s===38?s:s+.25,b=s===38?s+1.75:s+2
      floor(at(s,v),a,v,b,v+1,.1,0x868a94,6)
      floor(at(v,s),v,a,v+1,b,.1,0x868a94,6)
      const edge=s===38?40:48, inner=s===38?39.75:48.25, m=at(s,v)
      m.quadAuto([edge,.014,v],[edge,.014,v+1],[inner,.1,v+1],[inner,.1,v],hex(0x9296a0),MAT.ground,2)
      at(v,s).quadAuto([v,.014,edge],[v+1,.014,edge],[v+1,.1,inner],[v,.1,inner],hex(0x9296a0),MAT.ground,2)
    }
  }
  for(const [x,z] of [[33.8,40.08],[48.1,31],[59,48.1],[39.8,63]]) {
    const m=at(x!,z!); m.box(x!-.42,.018,z!-.14,x!+.42,.024,z!+.14,hex(0x14181c))
    for(let i=0;i<7;i++) m.box(x!-.38+i*.12,.024,z!-.12,x!-.33+i*.12,.028,z!+.12,hex(0x454a52))
  }
  for (let v = 52; v < SIZE; v += 5) {
    const m = at(v, 44)
    m.box(v, .025, 43.9, v + 2.4, .027, 44.02, hex(0xb9ab7a))
    at(44, v).box(43.9, .025, v, 44.02, .027, v + 2.4, hex(0xb9ab7a))
  }
  for (const [id,b] of town.buildings.entries()) {
    const [x, z, r, end] = b.rect, m = at(x, z)
    floor(m, x, z, r, end, .13, b.kind === "house" ? 0x765a3e : 0x89968b, b.kind === "house" ? 2 : 1)
    floor(m, x + 4.5, end, x + 7, end + 1.3, .13, 0x847f73, 6)
    floor(m,x+5,end+1.3,x+6.4,frontageEnd(b)+2,.13,0x8a8579,6)
    floor(m,x-3,z,x-.35,frontageEnd(b)+2,.035,0x747678,7)
    // Concrete curb-cut ramp flare at the street edge of the driveway
    if(b.kind==="house"&&end<40){
      m.quadAuto([x-3.18,.015,40.0],[x-.18,.015,40.0],[x-.30,.101,39.75],[x-3.05,.101,39.75],hex(0x888b94),MAT.lit)
    }
    const gravel=new Rng(town.seed+id*177)
    for(let k=0;k<36;k++) {
      const px=x-3+gravel.next()*2.65,pz=z+gravel.next()*(frontageEnd(b)+2-z),size=.025+gravel.next()*.045
      m.prism(px,pz,size,size*.5,.036,.055,5,hex(gravel.pick([0x949084,0x65685f,0x79776a,0x585a50])))
    }
    house(m,b,id,town)
    if (b.kind !== "house") {
      const color = hex(b.kind === "pharmacy" ? 0x406d62 : 0x8b593d)
      m.box(x + .3, 2.05, end + .01, r - .3, 2.6, end + .2, color, MAT.wall)
      // Hardware pegboard / pharmacy cross in geometry, readable at street scale.
      if (b.kind === "pharmacy") {
        m.box(x + 1.2, 2.1, end + .21, x + 1.5, 2.55, end + .23, hex(0xcad8b7))
        m.box(x + 1.05, 2.23, end + .21, x + 1.65, 2.4, end + .23, hex(0xcad8b7))
      }
    }
  }
  for (const b of town.barriers) {
    const [x, z, r, end] = b.rect, m = at(x, z), color = hex(b.color)
    if (b.kind === "wall") {
      m.box(x,.13,z,r,2.78,end,color,MAT.wall,20,hex(0x303744))
      m.box(x+.03,2.78,z+.03,r-.03,2.80,end-.03,hex(0xb8b0a0),MAT.lit)
      m.box(x - .02, .14, z - .02, r + .02, .28, end + .02, hex(0x594836), MAT.lit)
    } else if (b.kind === "window") {
      m.box(x, .13, z, r, .85, end, color, MAT.wall,20)
      m.box(x, 2.15, z, r, 2.78, end, color, MAT.wall,20, hex(0x303744))
      m.box(x+.03, 2.78, z+.03, r-.03, 2.80, end-.03, hex(0xb8b0a0), MAT.lit)
      m.box(x-.08,.78,z-.06,r+.08,.87,end+.12,hex(0xd8d5cb),MAT.wall)
      m.box(x-.07,2.13,z-.06,r+.07,2.23,end+.08,hex(0xd8d5cb),MAT.wall)
      const g = at(x, z, true)
      g.box(x + .025, .87, z + .025, r - .025, 2.14, end - .025, hex(0x809c9e), MAT.glass)
      const owner=town.buildings.findIndex(h=>x>=h.rect[0]-.01&&r<=h.rect[2]+.01&&z>=h.rect[1]&&end<=h.rect[3])
      const house=town.buildings[owner]!
      const lamp=town.lamps.findIndex(l=>l.kind==="room"&&l.x>house.rect[0]&&l.x<house.rect[2]&&l.y>house.rect[1]&&l.y<house.rect[3])
      // Warm interior window glow with darker curtain side drapes and crisp white mullions/sills.
      if(r-x>1) {
        m.box(x+.05,.88,z+.02,r-.05,1.46,end+.012,hex(0x9e6228),MAT.lamp,lamp)
        m.box(x+.05,1.48,z+.02,r-.05,2.11,end+.004,hex(0x6e441d),MAT.lamp,lamp)
        m.box(x+.04,.871,end+.005,r-.04,.884,end+.11,hex(0x825428),MAT.lamp,lamp)
        const doubleWin = r - x > 2.2
        const panes = doubleWin ? [[x+.06, (x+r)/2-.07], [(x+r)/2+.07, r-.06]] : [[x+.06, r-.06]]
        for (const [wx0, wx1] of panes) {
          for (const px of [wx0!, wx1! - .22]) {
            m.box(px, .89, z+.03, px + .22, 2.10, end+.018, hex(0x4a3119), MAT.lamp, lamp)
          }
          const midX = (wx0! + wx1!) / 2
          m.box(midX - .018, .87, z - .01, midX + .018, 2.15, end + .035, hex(0xdcd9cf), MAT.wall)
        }
        m.box(x+.04,1.45,z-.01,r-.04,1.50,end+.04,hex(0xdcd9cf),MAT.wall)
      }else for(const pz of [z+.1,end-.45])m.box(x+.07,.9,pz,x+.10,2.1,pz+.35,hex(0x784d22),MAT.lamp,lamp)
      if (r - x > 1) {
        const divW = r - x > 2.2 ? .06 : .035
        for (const [px, w] of [[x, .06], [(x + r) / 2 - divW, divW * 2], [r - .06, .06]] as const) {
          m.box(px, .85, z - .03, px + w, 2.2, end + .045, hex(0xdcd9cf), MAT.wall)
        }
      } else {
        for (const pz of [z, (z + end) / 2, end - .06]) m.box(x - .03, .85, pz, r + .03, 2.2, pz + .06, hex(0xdcd9cf), MAT.wall)
      }
    } else {
      const horizontal = r - x > end - z, length = horizontal ? r - x : end - z
      const picketCol = hex(0x8e8c83), railCol = hex(0x7c7a71)
      for (let d = 0; d < length; d += .35) {
        const px = x + (horizontal ? d : 0), pz = z + (horizontal ? 0 : d)
        m.box(px, .05, pz, px + (horizontal ? .15 : .08), 1.16, pz + (horizontal ? .08 : .15), picketCol, MAT.lit)
      }
      for (const h of [.32, .86]) m.box(x, h, z, r, h + .07, end, railCol, MAT.lit)
    }
  }
  for (const p of town.props) { const mesh=new Mesh(); furniture(mesh,p,town); props.push(mesh) }
  for (const [id, p] of town.lamps.entries()) {
    if(p.kind==="window")continue
    const m = at(p.x, p.y)
    if(p.kind!=="street") {
      if(p.kind==="room") {
        if(p.h>2.3) continue
        if(p.h>2)m.prism(p.x,p.y,.012,.012,p.h,2.75,5,hex(0x4f5047))
        else m.prism(p.x,p.y,.027,.025,p.h<1.2?.65:.13,p.h-.15,6,hex(0x5a4b35))
        m.prism(p.x,p.y,.23,.125,p.h-.13,p.h+.16,9,hex(0xe8b86b),MAT.lamp,id)
        m.prism(p.x,p.y,.19,.19,p.h-.14,p.h-.13,9,hex(0xffdca0),MAT.lamp,id)
      } else {
        // Warm porch sconce beside the door + warm overhead porch bulb under the gable arch
        const sx=p.x+.86, sz=p.y-.38
        m.box(sx-.06,1.68,sz,sx+.06,1.88,sz+.12,hex(0xffcf88),MAT.lamp,id)
        m.box(sx-.09,1.88,sz-.02,sx+.09,1.93,sz+.14,hex(0x2d3238),MAT.lit)
        m.prism(p.x,p.y-.22,.10,.08,2.24,2.38,7,hex(0xffe0a6),MAT.lamp,id)
      }
      continue
    }
    m.prism(p.x, p.y, .13, .07, .1, 3.8, 8, hex(0x353d3c))
    m.box(p.x - .08, 3.65, p.y - .08, p.x + .7, 3.8, p.y + .08, hex(0x353d3c))
    m.box(p.x + .3, 3.55, p.y - .18, p.x + .8, 3.65, p.y + .18, hex(0xffc980), MAT.lamp, id)
  }
  const chunks = (list: Mesh[], split = false): LevelChunk[] => list.filter(m => m.count).flatMap(source => {
    if (!split) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, top = 0
      for (let i = 0; i < source.v.length; i += 11) {
        x0 = Math.min(x0, source.v[i]!); x1 = Math.max(x1, source.v[i]!)
        z0 = Math.min(z0, source.v[i + 2]!); z1 = Math.max(z1, source.v[i + 2]!); top = Math.max(top, source.v[i + 1]!)
      }
      return [{ data: source.pack(), box: [x0, z0, x1, z1] as const, cutBox: [x0, 0, z0, x1, top, z1] }]
    }
    const opaque = new Mesh()
    const screen = new Mesh()
    const customByBuilding = BUILDING_RECTS.map(() => new Mesh())
    const interiorCapByBuilding = BUILDING_RECTS.map(() => new Mesh())
    for (let i = 0; i < source.v.length; i += 33) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
      let hasRoof = false, hasScreen = false, hasFoliage = false
      for (const j of [0, 11, 22]) {
        const vx = source.v[i + j]!, vy = source.v[i + j + 1]!, vz = source.v[i + j + 2]!
        const mat = Math.round(source.v[i + j + 9]!)
        minX = Math.min(minX, vx); maxX = Math.max(maxX, vx)
        minY = Math.min(minY, vy); maxY = Math.max(maxY, vy)
        minZ = Math.min(minZ, vz); maxZ = Math.max(maxZ, vz)
        if (mat === 21) hasRoof = true
        if (mat === 22 || mat === 24) hasFoliage = true
        if ((mat === 4 || mat === 9 || mat === 11) && maxY > 1.0) hasScreen = true
      }
      let customId = -1
      let strictlyInsideCutout = false
      if (hasRoof) {
        const id = Math.max(0, Math.min(BUILDING_RECTS.length - 1, Math.round(source.v[i + 10]!)))
        const b = BUILDING_RECTS[id]!
        customId = id
        strictlyInsideCutout = minX > b[0] + .35 && maxX < b[2] - .35 && minZ > b[1] + .35 && maxZ < b[3] + 1.65
      } else if (maxY > 2.8 && !hasFoliage) {
        for (let id = 0; id < BUILDING_RECTS.length; id++) {
          const b = BUILDING_RECTS[id]!
          if (maxX > b[0] + .25 && minX < b[2] - .25 && maxZ > b[1] + .25 && minZ < b[3] + 1.65) {
            customId = id
            strictlyInsideCutout = minX > b[0] + .35 && maxX < b[2] - .35 && minZ > b[1] + .35 && maxZ < b[3] + 1.65 && minY > 2.801
            break
          }
        }
      }
      if (customId >= 0) {
        ;(strictlyInsideCutout ? interiorCapByBuilding[customId]! : customByBuilding[customId]!).v.push(...source.v.slice(i, i + 33))
      } else if (hasScreen) {
        screen.v.push(...source.v.slice(i, i + 33))
      } else {
        opaque.v.push(...source.v.slice(i, i + 33))
      }
    }
    const pack = (m: Mesh, cutBox?: readonly number[], customCutaway?: boolean | "outside"): LevelChunk[] => {
      if (!m.count) return []
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, top = 0, z1 = -Infinity
      for (let i = 0; i < m.v.length; i += 11) {
        x0 = Math.min(x0, m.v[i]!); x1 = Math.max(x1, m.v[i]!)
        top = Math.max(top, m.v[i + 1]!)
        z0 = Math.min(z0, m.v[i + 2]!); z1 = Math.max(z1, m.v[i + 2]!)
      }
      return [{ data: m.pack(), box: [x0, z0, x1, z1] as const, cutBox: cutBox ?? (customCutaway ? [x0, 0, z0, x1, top, z1] : undefined), customCutaway }]
    }
    const screenChunk = (): LevelChunk[] => {
      if (!screen.count) return []
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, top = 0, z1 = -Infinity
      for (let i = 0; i < screen.v.length; i += 11) {
        x0 = Math.min(x0, screen.v[i]!); x1 = Math.max(x1, screen.v[i]!)
        top = Math.max(top, screen.v[i + 1]!)
        z0 = Math.min(z0, screen.v[i + 2]!); z1 = Math.max(z1, screen.v[i + 2]!)
      }
      return [{ data: screen.pack(), box: [x0, z0, x1, z1] as const, cutBox: [x0, 0, z0, x1, top, z1] }]
    }
    const customChunks = BUILDING_RECTS.flatMap((b, id) => {
      const bounds = [b[0] - .1, 0, b[1] - .1, b[2] + .1, 5, b[3] + 1.7] as const
      return [
        ...pack(interiorCapByBuilding[id]!, bounds, "outside"),
        ...pack(customByBuilding[id]!, bounds, true),
      ]
    })
    return [...pack(opaque), ...screenChunk(), ...customChunks]
  })
  // Indoor sky mask: roofs are cut away, but rooms still receive only subdued daylight.
  const resolution=384, scale=SIZE/resolution, data = new Uint8Array(resolution * resolution * 2)
  const furnitureContacts=town.props.flatMap(p=>{const s=propShape(p);return s?[s.rect]:[]})
  for (let z = 0; z < resolution; z++) for (let x = 0; x < resolution; x++) {
    const px=(x+.5)*scale,pz=(z+.5)*scale
    const indoor = town.buildings.some(b => px >= b.rect[0] && px < b.rect[2] && pz >= b.rect[1] && pz < b.rect[3])
    let contact=0
    for(const wall of town.barriers) if(wall.kind!=="fence") contact=Math.max(contact,Math.exp(-distToRect(px,pz,wall.rect)*4)*.8)
    for(const p of town.props) {
      if(p.kind==="tree") contact=Math.max(contact,Math.exp(-((px-p.x)**2+(pz-p.y)**2)/1.5)*.65)
    }
    for(const rect of furnitureContacts)contact=Math.max(contact,Math.exp(-distToRect(px,pz,rect)*5)*.85)
    data[(z * resolution + x) * 2] = Math.round(contact*255)
    data[(z * resolution + x) * 2 + 1] = indoor ? 32 : 255
  }
  return { chunks: chunks([...meshes,...props],true), glass: chunks(glasses), floor: { data, w: resolution, h: resolution }, bounce: { data: new Uint8Array([0, 0, 0, 255]), w: 1, h: 1 } }
}
