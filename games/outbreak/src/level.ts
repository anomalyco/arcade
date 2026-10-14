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
  const wood = hex(0x75604b), legs = hex(0x3b3934)
  if (kind === "bed") {
    m.box(x - .8, .12, z - 1.2, x + .8, .45, z + 1.2, wood, MAT.timber)
    m.bevelBox(x - .78, .45, z - 1.15, x + .78, .65, z + 1.15, .07, hex(0x637578), hex(0x889c9b))
    m.box(x - .65, .66, z - 1.0, x + .65, .77, z - .6, hex(0xc0baab))
    m.box(x - .86, .15, z - 1.3, x + .86, 1, z - 1.17, wood, MAT.timber)
  } else if (kind === "sofa") {
    m.box(x-.55,.22,z-1.25,x+.55,.46,z+1.25,hex(0x555d50))
    m.bevelBox(x-.6,.35,z-1.3,x-.36,1.0,z+1.3,.055,hex(0x5d6557),hex(0x6a7160))
    for(const dz of [-.72,0,.72])m.bevelBox(x-.32,.45,z+dz-.33,x+.51,.61,z+dz+.33,.06,hex(0x626b5b),hex(0x747b68))
    for(const s of [-1,1])m.box(x-.55,.4,z+s*1.17-.12,x+.55,.83,z+s*1.17+.12,hex(0x5d6557))
    for(const dx of [-.4,.4])for(const dz of [-1,1])m.box(x+dx-.04,.13,z+dz-.04,x+dx+.04,.23,z+dz+.04,legs)
    m.bevelBox(x-.27,.63,z+.65,x+.23,.82,z+1.02,.045,hex(0x9b8360),hex(0x9b8360))
  } else if(kind==="coffee") {
    m.bevelBox(x-.55,.43,z-.75,x+.55,.52,z+.75,.035,wood,hex(0x887554),MAT.timber,MAT.timber)
    for(const dx of [-.43,.43])for(const dz of [-.63,.63])m.box(x+dx-.035,.13,z+dz-.035,x+dx+.035,.43,z+dz+.035,legs)
    m.box(x-.2,.52,z+.1,x+.19,.56,z+.48,hex(0x9e987f))
    m.prism(x+.2,z-.32,.09,.085,.52,.65,8,hex(0xb2aa8e))
  } else if(kind==="nightstand") {
    m.box(x-.275,.15,z-.275,x+.275,.65,z+.275,wood,MAT.timber)
    m.box(x-.23,.36,z+.276,x+.23,.6,z+.29,hex(0x927957),MAT.timber)
    m.box(x-.055,.48,z+.29,x+.055,.51,z+.32,hex(0xab9c77))
  } else if(kind==="stove") {
    m.box(x-.375,.13,z-.4,x+.375,.94,z+.4,hex(0x878b7e))
    m.box(x-.39,.94,z-.41,x+.39,.95,z+.41,hex(0x424a44))
    for(const dx of [-.17,.17])for(const dz of [-.2,.2])m.prism(x+dx,z+dz,.11,.11,.951,.965,8,hex(0x242c2b))
    m.box(x-.38,.3,z-.3,x-.376,.76,z+.3,hex(0x343c39))
  } else if(kind==="counter"||kind==="dresser"||kind==="fridge") {
    const {rect:[a,c,r,e],height}=propShape(p)!
    const pale=kind==="fridge"?0x8a9187:0x82765f
    m.box(a,.13,c,r,height-.06,e,hex(pale),MAT.timber)
    m.box(a-.02,height-.06,c-.02,r+.02,height,e+.02,hex(kind==="counter"?0x929387:0x7e7460))
    if(kind==="counter"){
      m.box(a+.1,height+.002,z-.65,r-.1,height+.008,z-.05,hex(0x353f3d))
      m.box(a+.18,height+.009,z-.57,r-.18,height+.015,z-.13,hex(0x616e68))
      m.box(r-.15,height,z-.4,r-.10,height+.25,z-.35,hex(0x858d85))
      for(const dz of [-.85,.0,.85])m.box(a-.01,.2,z+dz-.32,a-.005,.88,z+dz+.32,hex(0x94856a),MAT.timber)
    }else if(kind==="fridge"){
      m.box(a-.015,1.35,c+.03,a,1.37,e-.03,hex(0x3d4541));m.box(a-.055,.88,e-.15,a,1.2,e-.11,hex(0x565f59))
    }else for(let i=0;i<3;i++){
      m.box(a+.04,.22+i*.26,e+.002,r-.04,.44+i*.26,e+.02,hex(0x988366),MAT.timber)
      m.box(x-.12,.3+i*.26,e+.02,x+.12,.34+i*.26,e+.065,hex(0xaea079))
    }
  } else if(kind==="chair") {
    m.box(x-.27,.52,z-.27,x+.27,.60,z+.27,wood,MAT.timber)
    m.box(x-.27,.6,z+.20,x+.27,1.05,z+.27,wood,MAT.timber)
    for(const dx of [-.21,.21])for(const dz of [-.21,.21])m.box(x+dx-.025,.13,z+dz-.025,x+dx+.025,.52,z+dz+.025,legs)
  } else if (kind === "table") {
    m.box(x - .75, .7, z - .5, x + .75, .82, z + .5, wood, MAT.timber)
    for (const dx of [-.65, .65]) for (const dz of [-.4, .4]) m.box(x + dx - .05, .1, z + dz - .05, x + dx + .05, .7, z + dz + .05, legs)
    m.box(x - .2, .82, z - .15, x + .2, .87, z + .15, hex(0xb5b0a0))
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
  for (let v = 2; v < SIZE - 2; v += 1.4 + vergeRng.next() * 2.2) {
    if (v > 37 && v < 51) continue
    for (const zBase of [37.75, 39.82, 48.18, 50.25]) {
      if (vergeRng.next() < 0.32) continue
      if (town.buildings.some(b => Math.abs(v - (b.rect[0] + 5.7)) < 1.1 || (v > b.rect[0] - 3.1 && v < b.rect[0] - 0.2))) continue
      for (let k = 0; k < 2; k++) {
        const x = v + (vergeRng.next() - 0.5) * 0.55, z = zBase + (vergeRng.next() - 0.5) * 0.16
        const y = supportHeight(town, x, z), m = at(x, z), r = 0.08 + vergeRng.next() * 0.09, h = 0.09 + vergeRng.next() * 0.12
        const c = hex(vergeRng.pick([0x5a6840, 0x4d5c37, 0x6f7348]))
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
      floor(at(s,v),a,v,b,v+1,.1,0x989ba4,6)
      floor(at(v,s),v,a,v+1,b,.1,0x989ba4,6)
      const edge=s===38?40:48, inner=s===38?39.75:48.25, m=at(s,v)
      m.quadAuto([edge,.014,v],[edge,.014,v+1],[inner,.1,v+1],[inner,.1,v],hex(0xa4a7b0),MAT.ground,2)
      at(v,s).quadAuto([v,.014,edge],[v+1,.014,edge],[v+1,.1,inner],[v,.1,inner],hex(0xa4a7b0),MAT.ground,2)
    }
  }
  for(const [x,z] of [[32,39.8],[48.1,31],[59,48.1],[39.8,63]]) {
    const m=at(x!,z!); m.box(x!-.45,.023,z!-.1,x!+.45,.027,z!+.1,hex(0x262e2c))
    for(let i=0;i<8;i++) m.box(x!-.43+i*.11,.028,z!-.1,x!-.4+i*.11,.032,z!+.1,hex(0x696b62))
  }
  for (let v = 2; v < SIZE; v += 5) {
    if (v > 37 && v < 51) continue
    const m = at(v, 44)
    m.box(v, .025, 43.9, v + 2.4, .027, 44.02, hex(0xb9ab7a))
    at(44, v).box(43.9, .025, v, 44.02, .027, v + 2.4, hex(0xb9ab7a))
  }
  for (const [id,b] of town.buildings.entries()) {
    const [x, z, r, end] = b.rect, m = at(x, z)
    floor(m, x, z, r, end, .13, b.kind === "house" ? 0x765a3e : 0x89968b, b.kind === "house" ? 2 : 1)
    floor(m, x + 4.5, end, x + 7, end + 1.3, .13, 0xa29d90, 6)
    floor(m,x+5,end+1.3,x+6.4,frontageEnd(b)+2,.13,0xa6a194,6)
    floor(m,x-3,z,x-.35,frontageEnd(b)+2,.035,0x646659,7)
    const gravel=new Rng(town.seed+id*177)
    for(let k=0;k<45;k++) {
      const px=x-3+gravel.next()*2.65,pz=z+gravel.next()*(frontageEnd(b)+2-z),size=.025+gravel.next()*.045
      m.prism(px,pz,size,size*.5,.036,.055,5,hex(gravel.pick([0x949084,0x65685f,0x79776a])))
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
      m.box(x,.13,z,r,2.8,end,color,MAT.wall,20,hex(0xb5ad99))
      m.box(x - .02, .14, z - .02, r + .02, .3, end + .02, hex(0x4b4a41), MAT.wall)
    } else if (b.kind === "window") {
      m.box(x, .13, z, r, .85, end, color, MAT.wall,20)
      m.box(x, 2.15, z, r, 2.8, end, color, MAT.wall,20)
      m.box(x-.08,.78,z-.06,r+.08,.87,end+.12,hex(0xd4cfc2),MAT.wall)
      m.box(x-.07,2.13,z-.06,r+.07,2.23,end+.08,hex(0xd4cfc2),MAT.wall)
      const g = at(x, z, true)
      g.box(x + .025, .87, z + .025, r - .025, 2.14, end - .025, hex(0x809c9e), MAT.glass)
      const owner=town.buildings.findIndex(h=>x>=h.rect[0]-.01&&r<=h.rect[2]+.01&&z>=h.rect[1]&&end<=h.rect[3])
      const house=town.buildings[owner]!
      const lamp=town.lamps.findIndex(l=>l.kind==="room"&&l.x>house.rect[0]&&l.x<house.rect[2]&&l.y>house.rect[1]&&l.y<house.rect[3])
      // Warm interior window glow flush with the outer sash and sill so it reads clearly from the top-down camera.
      if(r-x>1) {
        m.box(x+.05,.88,z+.02,r-.05,1.46,end+.015,hex(0xf2a649),MAT.lamp,lamp)
        m.box(x+.05,1.48,z+.02,r-.05,2.11,end+.005,hex(0xc98238),MAT.lamp,lamp)
        m.box(x+.04,.872,end+.005,r-.04,.885,end+.11,hex(0xdba056),MAT.lamp,lamp)
        for(const px of [x+.08,r-.38])for(let i=0;i<3;i++)m.box(px+i*.08,.89,z+.03,px+i*.08+.065,2.11,end+.02,hex(i%2?0xab783c:0x8f6230),MAT.lamp,lamp)
        m.box(x+.06,1.44,z-.01,r-.06,1.50,end+.04,hex(0xd8d4c8),MAT.wall)
      }else for(const pz of [z+.1,end-.45])m.box(x+.07,.9,pz,x+.10,2.1,pz+.35,hex(0xc98238),MAT.lamp,lamp)
      if (r - x > 1) {
        for (const px of [x, (x + r) / 2 - .03, r - .06]) m.box(px, .85, z - .03, px + .06, 2.2, end + .04, hex(0xd8d4c8), MAT.wall)
      } else {
        for (const pz of [z, (z + end) / 2, end - .06]) m.box(x - .03, .85, pz, r + .03, 2.2, pz + .06, hex(0xd8d4c8), MAT.wall)
      }
    } else {
      const horizontal = r - x > end - z, length = horizontal ? r - x : end - z
      for (let d = 0; d < length; d += .45) {
        const px = x + (horizontal ? d : 0), pz = z + (horizontal ? 0 : d)
        m.box(px, .05, pz, px + .09, 1.1, pz + .09, color)
      }
      for (const h of [.35, .8]) m.box(x, h, z, r, h + .08, end, color)
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
        m.box(p.x-.1,p.h-.18,p.y-.08,p.x+.1,p.h+.18,p.y+.08,hex(0xffd49a),MAT.lamp,id)
        m.box(p.x-.15,p.h+.18,p.y-.12,p.x+.15,p.h+.24,p.y+.12,hex(0x343b38))
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
        if (mat === 4 || mat === 9 || mat === 2 || mat === 11) hasScreen = true
      }
      let customId = -1
      let strictlyInsideCutout = false
      if (hasRoof) {
        const id = Math.max(0, Math.min(BUILDING_RECTS.length - 1, Math.round(source.v[i + 10]!)))
        const b = BUILDING_RECTS[id]!
        customId = id
        strictlyInsideCutout = minX > b[0] + .35 && maxX < b[2] - .35 && minZ > b[1] + .35 && maxZ < b[3] - .35
      } else if (maxY > 2.8 && !hasFoliage) {
        for (let id = 0; id < BUILDING_RECTS.length; id++) {
          const b = BUILDING_RECTS[id]!
          if (maxX > b[0] + .25 && minX < b[2] - .25 && maxZ > b[1] + .25 && minZ < b[3] - .25) {
            customId = id
            strictlyInsideCutout = minX > b[0] + .35 && maxX < b[2] - .35 && minZ > b[1] + .35 && maxZ < b[3] - .35 && minY > 2.801
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
      const bounds = [b[0] - .1, 0, b[1] - .1, b[2] + .1, 5, b[3] + .1] as const
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
