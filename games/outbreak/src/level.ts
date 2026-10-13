import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { LevelChunk, LevelData } from "@arcade/kit/gpu/level"
import { CHUNK, SIZE, type Town, type Prop } from "../shared/map"
import { terrainVertex, supportHeight } from "../shared/terrain"
import { house, plant } from "./architecture"
import { Rng } from "@arcade/kit/sim/rng"
import { distToRect } from "@arcade/kit/sim/geom"

export const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
const floor = (m: Mesh, x: number, z: number, r: number, b: number, h: number, color: number, kind: number) => m.quad([x, h, b], [r, h, b], [r, h, z], [x, h, z], [0, 1, 0], hex(color), MAT.ground, kind === 8 ? 0 : kind === 5 ? 1 : kind === 2 ? 4 : kind === 7 ? 3 : 2)

function furniture(m: Mesh, p: Prop, town: Town): void {
  const { x, y: z, kind } = p
  if (kind === "tree") {
    plant(m,x,z,4.4+p.variant*1.6,1.7+p.variant*.5,Math.floor(p.variant*1e6),supportHeight(town,x,z))
    return
  }
  const wood = hex(0x75604b), legs = hex(0x3b3934)
  if (kind === "bed") {
    m.box(x - .8, .12, z - 1.2, x + .8, .45, z + 1.2, wood)
    m.bevelBox(x - .78, .45, z - 1.15, x + .78, .65, z + 1.15, .07, hex(0x637578), hex(0x889c9b))
    m.box(x - .65, .66, z - 1.0, x + .65, .77, z - .6, hex(0xc0baab))
    m.box(x - .86, .15, z - 1.3, x + .86, 1, z - 1.17, wood)
  } else if (kind === "sofa") {
    m.box(x - .55, .15, z - 1.25, x + .55, .62, z + 1.25, hex(0x705c49))
    m.box(x + .35, .5, z - 1.3, x + .65, 1.1, z + 1.3, hex(0x82715e))
    for (const s of [-1, 1]) m.box(x - .55, .4, z + s * 1.17 - .12, x + .55, .88, z + s * 1.17 + .12, hex(0x82715e))
  } else if (kind === "table") {
    m.box(x - .75, .7, z - .5, x + .75, .82, z + .5, wood)
    for (const dx of [-.65, .65]) for (const dz of [-.4, .4]) m.box(x + dx - .05, .1, z + dz - .05, x + dx + .05, .7, z + dz + .05, legs)
    m.box(x - .2, .82, z - .15, x + .2, .87, z + .15, hex(0xb5b0a0))
  } else {
    for (const dx of [-.8, .8]) m.box(x + dx - .06, .1, z - .38, x + dx + .06, 1.8, z + .38, legs)
    for (const h of [.3, .85, 1.4]) {
      m.box(x - .85, h, z - .4, x + .85, h + .07, z + .4, wood)
      for (let i = 0; i < 5; i++) {
        const px = x - .68 + i * .3
        m.box(px, h + .07, z - .25, px + .2, h + .2 + (p.variant + i * .13) % .27, z + .25, hex(i % 2 ? 0xa39b7c : 0x5a7973))
      }
    }
  }
}

/** Nine logical 32m chunks; each render chunk retains real bounds for overhanging geometry. */
export function buildLevel(town: Town): LevelData {
  const meshes = town.chunks.map(() => new Mesh()), glasses = town.chunks.map(() => new Mesh())
  const at = (x: number, z: number, glass = false) => (glass ? glasses : meshes)[Math.min(2, Math.max(0, Math.floor(z / CHUNK))) * 3 + Math.min(2, Math.max(0, Math.floor(x / CHUNK)))]!
  for (let z=0;z<SIZE;z++) for(let x=0;x<SIZE;x++) {
    const m=at(x,z), a=[x,terrainVertex(town,x,z),z], b=[x+1,terrainVertex(town,x+1,z),z], c=[x+1,terrainVertex(town,x+1,z+1),z+1], d=[x,terrainVertex(town,x,z+1),z+1]
    m.facet(a,c,b,hex(0x586044),MAT.ground,0); m.facet(a,d,c,hex(0x586044),MAT.ground,0)
  }
  const foliage=new Rng(town.seed^0x453a)
  for(let i=0;i<14000;i++) {
    const x=foliage.next()*SIZE,z=foliage.next()*SIZE
    if((x>37.8&&x<50.2)||(z>37.8&&z<50.2)||town.buildings.some(b=>x>b.rect[0]-3.2&&x<b.rect[2]+.4&&z>b.rect[1]-.5&&z<b.rect[3]+2.2)) continue
    if(Math.sin(x*1.3+z*.9)+Math.cos(z*.6-x*.7)<-.1) continue
    const y=supportHeight(town,x,z),m=at(x,z),h=.08+foliage.next()*.17,c=hex(foliage.pick([0x707851,0x626f49,0x8a895a]))
    m.facet([x-.025,y,z],[x+.015,y+h,z+.02],[x+.035,y,z],c,MAT.foliage)
    m.facet([x,y,z-.035],[x-.04,y+h*.8,z],[x,y,z+.025],c,MAT.foliage)
  }
  // Segment streets at chunk edges to retain useful culling.
  for (let v = 0; v < SIZE; v += CHUNK) {
    floor(at(44, v), 40, v, 48, v + CHUNK, .014, 0x34383b, 5)
    for(const [a,b] of [[0,40],[48,96]]) {
      const x0=Math.max(v,a!),x1=Math.min(v+CHUNK,b!)
      if(x1>x0) floor(at(v,44),x0,40,x1,48,.014,0x34383b,5)
    }
  }
  for(let v=0;v<SIZE;v++) {
    if(v>=38 && v<50) continue
    for(const s of [38,48]) {
      const a=s===38?s:s+.25,b=s===38?s+1.75:s+2
      floor(at(s,v),a,v,b,v+1,.1,0x8b8b7c,6)
      floor(at(v,s),v,a,v+1,b,.1,0x8b8b7c,6)
      const edge=s===38?40:48, inner=s===38?39.75:48.25, m=at(s,v)
      m.quadAuto([edge,.014,v],[edge,.014,v+1],[inner,.1,v+1],[inner,.1,v],hex(0x99988a),MAT.ground,2)
      at(v,s).quadAuto([v,.014,edge],[v+1,.014,edge],[v+1,.1,inner],[v,.1,inner],hex(0x99988a),MAT.ground,2)
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
    floor(m, x, z, r, end, .13, b.kind === "house" ? 0x8d7760 : 0x89968b, b.kind === "house" ? 2 : 1)
    floor(m, x + 4.5, end, x + 7, end + 2, .13, 0x777b74, 3)
    floor(m,x-3,z,x-.35,end+2,.035,0x747166,7)
    const gravel=new Rng(town.seed+id*177)
    for(let k=0;k<160;k++) {
      const px=x-3+gravel.next()*2.65,pz=z+gravel.next()*(end+2-z),size=.025+gravel.next()*.045
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
      m.box(x-.08,.8,z-.08,r+.08,.88,end+.08,hex(0xc4bfab),MAT.wall)
      m.box(x-.07,2.13,z-.07,r+.07,2.23,end+.07,hex(0xc4bfab),MAT.wall)
      const g = at(x, z, true)
      g.box(x + .025, .87, z + .025, r - .025, 2.14, end - .025, hex(0x809c9e), MAT.glass)
      const owner=town.buildings.findIndex(h=>x>=h.rect[0]-.01&&r<=h.rect[2]+.01&&z>=h.rect[1]&&end<=h.rect[3])
      const lamp=12+owner*3+2
      // A warm recessed curtain, behind the glass and frame, with open gaps for sight.
      if(r-x>1) for(const px of [x+.1,r-.45]) m.box(px,.9,z+.07,px+.35,2.1,z+.10,hex(0xcbaa76),MAT.lamp,lamp)
      else for(const pz of [z+.1,end-.45]) m.box(x+.07,.9,pz,x+.10,2.1,pz+.35,hex(0xcbaa76),MAT.lamp,lamp)
      if (r - x > 1) {
        for (const px of [x, (x + r) / 2, r - .06]) m.box(px, .85, z - .03, px + .06, 2.2, end + .03, hex(0xc4bfab), MAT.wall)
      } else {
        for (const pz of [z, (z + end) / 2, end - .06]) m.box(x - .03, .85, pz, r + .03, 2.2, pz + .06, hex(0xc4bfab), MAT.wall)
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
  for (const p of town.props) furniture(at(p.x, p.y), p,town)
  for (const [id, p] of town.lamps.entries()) {
    const m = at(p.x, p.y)
    if(p.kind!=="street") {
      if(p.kind==="room") {
        m.prism(p.x,p.y,.04,.035,.13,p.h-.15,8,hex(0x5a4b35))
        m.prism(p.x,p.y,.3,.17,p.h-.2,p.h+.17,10,hex(0xf4d394),MAT.lamp,id)
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
  const chunks = (list: Mesh[]): LevelChunk[] => list.filter(m => m.count).map(m => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, top = 0
    for (let i = 0; i < m.v.length; i += 11) {
      x0 = Math.min(x0, m.v[i]!); x1 = Math.max(x1, m.v[i]!)
      z0 = Math.min(z0, m.v[i + 2]!); z1 = Math.max(z1, m.v[i + 2]!); top = Math.max(top, m.v[i + 1]!)
    }
    return { data: m.pack(), box: [x0, z0, x1, z1], cutBox: [x0, 0, z0, x1, top, z1] }
  })
  // Indoor sky mask: roofs are cut away, but rooms still receive only subdued daylight.
  const resolution=384, scale=SIZE/resolution, data = new Uint8Array(resolution * resolution * 2)
  for (let z = 0; z < resolution; z++) for (let x = 0; x < resolution; x++) {
    const px=(x+.5)*scale,pz=(z+.5)*scale
    const indoor = town.buildings.some(b => px >= b.rect[0] && px < b.rect[2] && pz >= b.rect[1] && pz < b.rect[3])
    let contact=0
    for(const wall of town.barriers) if(wall.kind!=="fence") contact=Math.max(contact,Math.exp(-distToRect(px,pz,wall.rect)*4)*.8)
    for(const p of town.props) if(p.kind==="tree") contact=Math.max(contact,Math.exp(-((px-p.x)**2+(pz-p.y)**2)/1.5)*.65)
    data[(z * resolution + x) * 2] = Math.round(contact*255)
    data[(z * resolution + x) * 2 + 1] = indoor ? 32 : 255
  }
  return { chunks: chunks(meshes), glass: chunks(glasses), floor: { data, w: resolution, h: resolution }, bounce: { data: new Uint8Array([0, 0, 0, 255]), w: 1, h: 1 } }
}
