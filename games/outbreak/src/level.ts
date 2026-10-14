import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { LevelChunk, LevelData } from "@arcade/kit/gpu/level"
import { CHUNK, SIZE, BUILDING_RECTS, buildingFootprint, frontageEnd, inBuildingFootprint, propShape, type Town, type Prop } from "../shared/map"
import { terrainVertex, supportHeight } from "../shared/terrain"
import { house, plant, archSettings } from "./architecture"
import { Rng } from "@arcade/kit/sim/rng"
import { distToRect } from "@arcade/kit/sim/geom"
import { emitCurvedGrassBlade, emitGrassTuft, foliageSettings, scatterGrassClumps } from "@arcade/kit/gpu/foliage"

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
    // Readable warm sage-olive 3-cushion sofa with rolled arms, terracotta & cream throw pillows, and side lamp table
    m.box(x-.56,.20,z-1.26,x+.56,.45,z+1.26,hex(0x646e58))
    m.bevelBox(x-.62,.35,z-1.32,x-.34,1.02,z+1.32,.06,hex(0x707b63),hex(0x889478))
    for(const dz of [-.74,0,.74]){
      m.bevelBox(x-.32,.44,z+dz-.35,x+.53,.62,z+dz+.35,.055,hex(0x768268),hex(0x909c80))
      m.bevelBox(x-.38,.60,z+dz-.34,x-.16,.96,z+dz+.34,.045,hex(0x7c886e),hex(0x94a084))
    }
    for(const s of [-1,1])m.bevelBox(x-.56,.40,z+s*1.18-.14,x+.56,.84,z+s*1.18+.14,.04,hex(0x6c765f),hex(0x849076))
    for(const dx of [-.42,.42])for(const dz of [-1.05,1.05])m.box(x+dx-.04,.13,z+dz-.04,x+dx+.04,.22,z+dz+.04,legs)
    // Bright terracotta throw pillow at north end + cream cushion at south end
    m.bevelBox(x-.24,.62,z-.98,x+.22,.84,z-.58,.045,hex(0xa24c2c),hex(0xc25e38))
    m.bevelBox(x-.24,.62,z+.60,x+.24,.83,z+1.02,.045,hex(0xc4b28e),hex(0xdfd0ae))
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
  const key=`${town.seed}/${town.houseSeed}/${town.terrain}/${town.foliageDensity??1}/${archSettings.houseDecay}/${archSettings.clutterDensity}/${archSettings.weathering}/${archSettings.clutterSeed}`
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
    if((x>=40&&x<48)||(z>=40&&z<48)||town.buildings.some(b=>buildingFootprint(b).some(f=>x>=f[0]&&x+1<=f[2]&&z>=f[1]&&z+1<=f[3])))continue
    const m=at(x,z), a=[x,terrainVertex(town,x,z),z], b=[x+1,terrainVertex(town,x+1,z),z], c=[x+1,terrainVertex(town,x+1,z+1),z+1], d=[x,terrainVertex(town,x,z+1),z+1]
    m.facet(a,c,b,hex(0x586044),MAT.ground,0); m.facet(a,d,c,hex(0x586044),MAT.ground,0)
  }
  const grassRng = new Rng(town.seed ^ 0x73c9)
  const tufts = scatterGrassClumps({
    seed: town.seed ^ 0x453a,
    bounds: [1.5, 1.5, SIZE - 1.5, SIZE - 1.5],
    clusterCount: Math.round(95 * (town.foliageDensity ?? 1)),
    tuftsPerCluster: 3,
    params: foliageSettings,
    avoid: (x, z) =>
      (x > 38.0 && x < 50.0) ||
      (z > 38.0 && z < 50.0) ||
      town.buildings.some(
        b =>
          (inBuildingFootprint(b, x, z) || (x > b.rect[0] - 3.05 && x < b.rect[0] + 0.2 && z > b.rect[1] - 0.3 && z < b.rect[3] + 0.88) || (x >= b.rect[0] && x <= b.rect[2] && z >= b.rect[3] && z < b.rect[3] + 0.88)) ||
          (x > b.rect[0] + 4.35 && x < b.rect[0] + 7.15 && z >= b.rect[3] && z < frontageEnd(b) + 2.1),
      ),
  })
  for (const t of tufts) {
    const y = supportHeight(town, t.x, t.z), m = at(t.x, t.z)
    emitGrassTuft(m, t.x, y, t.z, {
      bladeCount: 2,
      radius: t.radius * 1.15,
      height: t.height * 1.12,
      width: t.width * 1.15,
      curvature: t.curvature,
      leanAngle: t.leanAngle,
      rootColor: t.rootColor,
      tipColor: t.tipColor,
      rng: grassRng,
    })
  }
  // Dense front-lawn, walkway-edge & side-yard grass clumps + 3-layer volumetric fur shells around every building frontage.
  for (const [bIdx, b] of town.buildings.entries()) {
    const [bx0, bz0, bx1, bz1] = b.rect
    const sidewalkZ = frontageEnd(b) - 0.08
    const lawnPatches: readonly [number, number, number, number, number][] = [
      [bx0 + 0.25, bz1 + 0.90, bx0 + 4.85, sidewalkZ, 22],
      [bx0 + 6.55, bz1 + 0.90, Math.min(37.7, bx1 - 0.25), sidewalkZ, 24],
      [Math.max(2.0, bx0 - 7.5), bz0 + 0.5, bx0 - 3.15, sidewalkZ, 18],
      [bx1 + 0.35, bz0 + 0.5, Math.min(37.7, bx1 + 3.2), sidewalkZ, 14],
    ]
    for (const [pIdx, [lx0, lz0, lx1, lz1, count]] of lawnPatches.entries()) {
      if (lz1 <= lz0 + 0.2 || lx1 <= lx0 + 0.2 || (lx0 > 37.8 && lx0 < 50.2)) continue
      const patchClumps = scatterGrassClumps({
        seed: (town.seed ^ (bIdx * 4099 + pIdx * 613)) >>> 0,
        bounds: [lx0, lz0, lx1, lz1],
        clusterCount: Math.max(2, Math.round(count * (town.foliageDensity ?? 1))),
        tuftsPerCluster: 3,
        params: foliageSettings,
        avoid: (gx, gz) => (gx > 37.8 && gx < 50.2) || (gz > 37.8 && gz < 50.2),
      })
      for (const t of patchClumps) {
        const y = supportHeight(town, t.x, t.z), m = at(t.x, t.z)
        emitGrassTuft(m, t.x, y, t.z, {
          bladeCount: 3,
          radius: t.radius * 1.25,
          height: t.height * 1.22,
          width: t.width * 1.25,
          curvature: t.curvature,
          leanAngle: t.leanAngle,
          rootColor: t.rootColor,
          tipColor: t.tipColor,
          rng: grassRng,
        })
      }
    }
  }
  // Shadowed root-collar tussock tufts around every exterior street/yard tree.
  for (const [pIdx, p] of town.props.entries()) {
    if (p.kind !== "tree") continue
    const treeRng = new Rng((town.seed ^ (pIdx * 2749 + 0x517c)) >>> 0)
    const collarCount = Math.max(3, Math.round(6 * (town.foliageDensity ?? 1)))
    for (let c = 0; c < collarCount; c++) {
      const a = c * 2.39996 + treeRng.next() * 0.45
      const d = 0.42 + treeRng.next() * 1.25
      const tx = p.x + Math.cos(a) * d
      const tz = p.y + Math.sin(a) * d
      if ((tx > 37.9 && tx < 50.1) || (tz > 37.9 && tz < 50.1)) continue
      const y = supportHeight(town, tx, tz), m = at(tx, tz)
      emitGrassTuft(m, tx, y, tz, {
        bladeCount: 3,
        radius: 0.16 + treeRng.next() * 0.10,
        height: foliageSettings.bladeHeight * (0.95 + treeRng.next() * 0.45),
        width: foliageSettings.bladeWidth * 1.2,
        curvature: foliageSettings.bladeCurvature,
        leanAngle: a + (treeRng.next() - 0.5) * 0.5,
        rootColor: [foliageSettings.rootColorR * 0.85, foliageSettings.rootColorG * 0.85, foliageSettings.rootColorB * 0.85],
        tipColor: [foliageSettings.tipColorR * 1.05, foliageSettings.tipColorG * 1.08, foliageSettings.tipColorB * 0.95],
        rng: treeRng,
      })
    }
  }
  // Radiating rosette grass tussocks along curb verges, sidewalk borders, front walkways, and gravel driveways.
  const vergeRng = new Rng(town.seed ^ 0x91e1)
  for (let v = 2.5; v < SIZE - 2.5; v += 0.72 + vergeRng.next() * 0.68) {
    if (v > 37.5 && v < 50.5) continue
    for (const zBase of [37.88, 39.55, 48.45, 50.12]) {
      if (vergeRng.next() < 0.14) continue
      if (town.buildings.some(b => Math.abs(v - (b.rect[0] + 5.7)) < 0.95 || (v > b.rect[0] - 3.1 && v < b.rect[0] - 0.25))) continue
      const inCurbStrip = zBase > 39 && zBase < 49
      const x = v + (vergeRng.next() - 0.5) * 0.28
      const z = zBase + (vergeRng.next() - 0.5) * 0.12
      const y = inCurbStrip ? 0.10 : supportHeight(town, x, z)
      const m = at(x, z)
      const h = (inCurbStrip ? 0.24 + vergeRng.next() * 0.16 : 0.18 + vergeRng.next() * 0.14) * (foliageSettings.bladeHeight / 0.30)
      const rootCol = hex(vergeRng.pick([0x182610, 0x14200d, 0x1e2812]))
      const tipCol = hex(vergeRng.pick([0x4c6828, 0x3e5822, 0x5c682c]))
      emitGrassTuft(m, x, y, z, {
        bladeCount: inCurbStrip ? 4 : 3,
        radius: inCurbStrip ? 0.22 + vergeRng.next() * 0.08 : 0.16 + vergeRng.next() * 0.06,
        height: h,
        width: foliageSettings.bladeWidth * 1.28,
        curvature: Math.min(1.0, foliageSettings.bladeCurvature * 1.15),
        leanAngle: vergeRng.next() * Math.PI * 2,
        rootColor: rootCol,
        tipColor: tipCol,
        rng: vergeRng,
      })
    }
  }
  for (const b of town.buildings) {
    const [bx0, bz0, , bz1] = b.rect
    const walkEnd = frontageEnd(b) - 0.12
    for (let wz = bz1 + 1.15; wz < walkEnd; wz += 0.62 + vergeRng.next() * 0.45) {
      for (const wx of [bx0 + 4.92, bx0 + 6.48]) {
        const gx = wx + (vergeRng.next() - 0.5) * 0.14
        const gz = wz + (vergeRng.next() - 0.5) * 0.18
        const y = supportHeight(town, gx, gz)
        emitGrassTuft(at(gx, gz), gx, y, gz, {
          bladeCount: 3,
          radius: 0.18,
          height: (0.20 + vergeRng.next() * 0.12) * (foliageSettings.bladeHeight / 0.30),
          width: foliageSettings.bladeWidth * 1.20,
          curvature: foliageSettings.bladeCurvature,
          leanAngle: wx < bx0 + 5.5 ? 0.15 : Math.PI - 0.15,
          rootColor: hex(0x182610),
          tipColor: hex(0x4a6428),
          rng: vergeRng,
        })
      }
    }
    for (let dz = bz0 + 1.2; dz < walkEnd; dz += 0.85 + vergeRng.next() * 0.65) {
      for (const dx of [bx0 - 2.94, bx0 - 1.68, bx0 - 0.42]) {
        if (dx === bx0 - 1.68 && vergeRng.next() < 0.48) continue
        const gx = dx + (vergeRng.next() - 0.5) * 0.18
        const gz = dz + (vergeRng.next() - 0.5) * 0.22
        const y = supportHeight(town, gx, gz)
        emitCurvedGrassBlade(
          at(gx, gz),
          gx,
          y,
          gz,
          0.18 + vergeRng.next() * 0.12,
          foliageSettings.bladeWidth * 1.18,
          foliageSettings.bladeCurvature,
          vergeRng.next() * Math.PI * 2,
          hex(0x182410),
          hex(0x465c26),
        )
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
    for (const [fx0, fz0, fx1, fz1] of buildingFootprint(b)) {
      floor(m, fx0, fz0, fx1, fz1, .13, b.kind === "house" ? 0x5d442c : 0x89968b, b.kind === "house" ? 2 : 1)
    }
    floor(m, x + 4.5, end, x + 7, end + 1.3, .13, 0x3d3830, 6)
    floor(m,x+5,end+1.3,x+6.4,frontageEnd(b)+2,.13,0x58534a,6)
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
      m.box(x,.13,z,r,2.78,end,color,MAT.wall,20,hex(0x1b2028))
      m.box(x+.03,2.78,z+.03,r-.03,2.80,end-.03,hex(0x2a2e36),MAT.lit)
      m.box(x - .02, .14, z - .02, r + .02, .26, end + .02, hex(0x36281c), MAT.timber)
    } else if (b.kind === "window") {
      // Lower wall apron and upper wall header around the 0.85..2.15m window opening
      m.box(x, .13, z, r, .84, end, color, MAT.wall, 20)
      m.box(x, 2.16, z, r, 2.78, end, color, MAT.wall, 20, hex(0x1b2028))
      m.box(x+.03, 2.78, z+.03, r-.03, 2.80, end-.03, hex(0x2a2e36), MAT.lit)
      const owner=town.buildings.findIndex(h=>x>=h.rect[0]-.01&&r<=h.rect[2]+.01&&z>=h.rect[1]&&end<=h.rect[3])
      const house=town.buildings[owner]!
      const lamp=town.lamps.findIndex(l=>l.kind==="room"&&l.x>house.rect[0]&&l.x<house.rect[2]&&l.y>house.rect[1]&&l.y<house.rect[3])
      const g = at(x, z, true)
      if (r - x > 1) {
        const zm = (z + end) / 2
        const isLeftWin = x < house.rect[0] + 5
        // Projecting weathered stone/wood sill + dark water-stain apron, and deep interior walnut sill
        m.box(x-.08, .79, z+.04, r+.08, .86, end+.14, hex(0x8e887a), MAT.wall)
        m.box(x-.05, .72, end, r+.05, .79, end+.08, hex(0x46423b), MAT.wall)
        m.box(x-.06, .80, z-.10, r+.06, .86, z+.06, hex(0x6e5236), MAT.timber)
        // Recessed window header & deep side jamb reveals
        m.box(x-.07, 2.14, z-.05, r+.07, 2.23, end+.09, hex(0x8e887a), MAT.wall)
        for (const px of [x, r - .07]) {
          m.box(px, .84, z-.04, px+.07, 2.16, end+.06, hex(0x8e887a), MAT.wall)
        }
        // Subdued warm amber sill bounce (rich saturation without clipping to white)
        m.box(x+.08, .861, zm-.05, r-.08, .874, zm+.06, hex(isLeftWin ? 0x522608 : 0x68320c), MAT.lamp, lamp)
        const doubleWin = r - x > 2.2
        if (doubleWin) {
          const mid = (x + r) / 2
          m.box(mid - .05, .85, z-.03, mid + .05, 2.16, end+.05, hex(0x8e887a), MAT.wall)
        }
        const panes = doubleWin ? [[x+.07, (x+r)/2-.05], [(x+r)/2+.05, r-.07]] : [[x+.07, r-.07]]
        for (const [pIdx, [wx0, wx1]] of panes.entries()) {
          // Deep amber-orange inner glow + half-drawn blind/curtain silhouettes for moody depth
          const lowGlow = isLeftWin ? (pIdx === 0 ? 0x482208 : 0x381a06) : (pIdx === 0 ? 0x56280a : 0x622e0c)
          const hiGlow = isLeftWin ? 0x2c1304 : 0x3c1b07
          m.box(wx0!+.18, .88, z-.06, wx1!-.18, 1.44, z-.03, hex(lowGlow), MAT.lamp, lamp)
          m.box(wx0!+.18, 1.48, z-.06, wx1!-.18, 2.10, z-.03, hex(hiGlow), MAT.lamp, lamp)
          for (const [cx0, cx1] of [[wx0!, wx0! + .24], [wx1! - .24, wx1!]]) {
            m.box(cx0!, .87, z-.04, cx1!, 2.13, z+.03, hex(0x24170d), MAT.wall)
          }
          // Recessed vertical & horizontal sash muntins at the window mid-plane zm
          const midX = (wx0! + wx1!) / 2
          m.box(midX - .018, .86, zm - .024, midX + .018, 2.14, zm + .024, hex(0x9a9486), MAT.wall)
          // See-through glass pane recessed at zm
          g.box(wx0!, .86, zm - .01, wx1!, 2.14, zm + .01, hex(0x463628), MAT.glass)
        }
        // Recessed horizontal meeting rail across the sash mid-plane
        m.box(x+.06, 1.46, zm - .026, r-.06, 1.51, zm + .026, hex(0x9a9486), MAT.wall)
      } else {
        const xm = (x + r) / 2
        // East wall window: projecting exterior sill, deep interior wooden sill, recessed jambs, side drapes & see-through glass
        m.box(x+.04, .79, z-.08, r+.14, .86, end+.08, hex(0x8e887a), MAT.wall)
        m.box(x-.10, .80, z-.06, x+.06, .86, end+.06, hex(0x6e5236), MAT.timber)
        m.box(x-.05, 2.14, z-.07, r+.09, 2.23, end+.07, hex(0x8e887a), MAT.wall)
        for (const pz of [z, end - .07]) m.box(x-.04, .84, pz, r+.06, 2.16, pz+.07, hex(0x8e887a), MAT.wall)
        m.box(xm-.04, .861, z+.08, xm+.05, .872, end-.08, hex(0x78481a), MAT.lamp, lamp)
        for (const [cz0, cz1] of [[z+.08, z+.30], [end-.30, end-.08]]) {
          m.box(x-.03, .87, cz0!, x+.03, 2.13, cz1!, hex(0x5e3a18), MAT.lamp, lamp)
        }
        const midZ = (z + end) / 2
        m.box(xm - .026, .86, midZ - .03, xm + .026, 2.14, midZ + .03, hex(0x9a9486), MAT.wall)
        m.box(xm - .024, 1.46, z+.06, xm + .024, 1.51, end-.06, hex(0x9a9486), MAT.wall)
        g.box(xm - .01, .86, z+.07, xm + .01, 2.14, end-.07, hex(0x6e888c), MAT.glass)
      }
    } else {
      // Weathered & partially damaged timber picket fence with 4x4 posts, height/yaw jitter, missing/snapped pickets & mossy rot
      const horizontal = r - x > end - z, length = horizontal ? r - x : end - z
      const fenceRng = new Rng((town.houseSeed ^ Math.floor(x * 31 + z * 59)) >>> 0)
      const wMult = archSettings.weathering
      const railCol = hex(0x524d43), rotCol = hex(0x282b22)
      let pIdx = 0
      for (let d = 0; d < length; d += .34, pIdx++) {
        const px = x + (horizontal ? d : 0), pz = z + (horizontal ? 0 : d)
        // Heavy 4x4 structural post every 7 pickets
        if (pIdx % 7 === 0) {
          m.box(px - .02, .03, pz - .02, px + .12, 1.22, pz + .12, hex(0x4a453c), MAT.timber, 0, hex(0x635d52))
          continue
        }
        const roll = fenceRng.next()
        // Occasional missing picket gap when weathered
        if (wMult > 0.25 && roll < 0.11 * Math.min(1.5, wMult)) continue
        const broken = wMult > 0.2 && roll > 0.88
        const topH = broken ? 0.56 + fenceRng.next() * 0.32 : 1.08 + (fenceRng.next() - 0.5) * 0.12
        const pCol = hex(fenceRng.pick([0x6c685d, 0x5e5a50, 0x767266, 0x524e45]))
        const w = horizontal ? .14 : .07, dp = horizontal ? .07 : .14
        const yaw = (fenceRng.next() - 0.5) * 0.14 * Math.min(1.5, wMult)
        m.yawBox(px + w / 2, pz + dp / 2, w, dp, .04, topH, yaw, pCol, MAT.timber, 0, hex(0x7c776b))
        // Dark mossy rot at picket base
        m.box(px, .03, pz, px + w, .20, pz + dp, rotCol, MAT.timber)
      }
      for (const h of [.30, .84]) m.box(x, h, z, r, h + .065, end, railCol, MAT.timber)
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
        // Twin flanking dark-iron coach lantern sconces beside the front door + recessed gable ceiling fixture
        for (const side of [-1, 1] as const) {
          const sx = p.x + side * 0.94, sz = p.y - 0.46
          // Wall mounting backplate & top/bottom iron bracket
          m.box(sx - .05, 1.62, sz - .02, sx + .05, 1.92, sz + .02, hex(0x1e2228), MAT.lit)
          m.box(sx - .08, 1.88, sz, sx + .08, 1.93, sz + .15, hex(0x1e2228), MAT.lit)
          m.box(sx - .06, 1.63, sz + .01, sx + .06, 1.67, sz + .13, hex(0x1e2228), MAT.lit)
          // Warm amber lantern glass cage
          m.box(sx - .055, 1.67, sz + .02, sx + .055, 1.88, sz + .13, hex(0xffc470), MAT.lamp, id)
        }
        // Tucked-up overhead porch ceiling fixture inside the gable soffit
        m.prism(p.x, p.y - .18, .08, .06, 2.46, 2.54, 6, hex(0xffd896), MAT.lamp, id)
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
      const strictlyInsideHouse = (id: number, minX: number, maxX: number, minZ: number, maxZ: number) => {
        const b = BUILDING_RECTS[id]!
        if (id >= 2) return minX > b[0] + .35 && maxX < b[2] - .35 && minZ > b[1] + .35 && maxZ < b[3] + 1.65
        const inSouth = minX > b[0] + .35 && maxX < b[2] - .35 && minZ > b[1] + 5.55 && maxZ < b[3] + 1.65
        const inNorth = minX > b[0] + 2.25 && maxX < b[0] + 9.25 && minZ > b[1] + .35 && maxZ < b[3] + 1.65
        return inSouth || inNorth
      }
      if (hasRoof) {
        const id = Math.max(0, Math.min(BUILDING_RECTS.length - 1, Math.round(source.v[i + 10]!)))
        customId = id
        strictlyInsideCutout = strictlyInsideHouse(id, minX, maxX, minZ, maxZ)
      } else if (maxY > 2.8 && !hasFoliage) {
        for (let id = 0; id < BUILDING_RECTS.length; id++) {
          const b = BUILDING_RECTS[id]!
          if (maxX > b[0] + .25 && minX < b[2] - .25 && maxZ > b[1] + .25 && minZ < b[3] + 1.65) {
            customId = id
            strictlyInsideCutout = strictlyInsideHouse(id, minX, maxX, minZ, maxZ) && minY > 2.801
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
    const screenChunks = (): LevelChunk[] => {
      if (!screen.count) return []
      // Bucket cuttable walls into 4m Z-bands so north/partition/south walls don't merge into one room-spanning cutBox.
      const bands = new Map<number, Mesh>()
      for (let i = 0; i < screen.v.length; i += 33) {
        const zBand = Math.floor(Math.min(screen.v[i + 2]!, screen.v[i + 13]!, screen.v[i + 24]!) / 4)
        let bm = bands.get(zBand)
        if (!bm) { bm = new Mesh(); bands.set(zBand, bm) }
        bm.v.push(...screen.v.slice(i, i + 33))
      }
      return [...bands.values()].flatMap(bm => pack(bm, undefined, undefined)).map(c => ({ ...c, cutBox: [c.box[0], 0, c.box[1], c.box[2], 2.85, c.box[3]] }))
    }
    const customChunks = BUILDING_RECTS.flatMap((b, id) => {
      const bounds = [b[0] - .1, 0, b[1] - .1, b[2] + .1, 5, b[3] + 1.7] as const
      return [
        ...pack(interiorCapByBuilding[id]!, bounds, "outside"),
        ...pack(customByBuilding[id]!, bounds, true),
      ]
    })
    return [...pack(opaque), ...screenChunks(), ...customChunks]
  })
  // Indoor sky/moon mask (fd.g) with inward window moonlight shafts, plus rectangular exterior window-spill in bounce.a.
  const resolution=384, scale=SIZE/resolution, data = new Uint8Array(resolution * resolution * 2)
  const windows = town.barriers.filter(b => b.kind === "window")
  const furnitureContacts=town.props.flatMap(p=>{const s=propShape(p);return s?[s.rect]:[]})
  for (let z = 0; z < resolution; z++) for (let x = 0; x < resolution; x++) {
    const px=(x+.5)*scale,pz=(z+.5)*scale
    const indoor = town.buildings.some(b => inBuildingFootprint(b, px, pz))
    let contact=0
    for(const wall of town.barriers) if(wall.kind!=="fence") contact=Math.max(contact,Math.exp(-distToRect(px,pz,wall.rect)*4)*.8)
    for(const p of town.props) {
      if(p.kind==="tree") contact=Math.max(contact,Math.exp(-((px-p.x)**2+(pz-p.y)**2)/1.5)*.65)
    }
    for(const rect of furnitureContacts)contact=Math.max(contact,Math.exp(-distToRect(px,pz,rect)*5)*.85)
    data[(z * resolution + x) * 2] = Math.round(contact*255)
    data[(z * resolution + x) * 2 + 1] = indoor ? 14 : 255
  }
  // Stamp inward moonlight shafts only within each window's local 3m interior footprint (1000x faster than full-grid scan).
  for (const w of windows) {
    const [wx0, wz0, wx1, wz1] = w.rect
    const x0 = Math.max(0, Math.floor((wx0 - 2.8) / scale)), x1 = Math.min(resolution - 1, Math.ceil((wx1 + 0.6) / scale))
    const z0 = Math.max(0, Math.floor((wz0 - 2.8) / scale)), z1 = Math.min(resolution - 1, Math.ceil((wz1 + 0.6) / scale))
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const idx = (z * resolution + x) * 2 + 1
      if (data[idx] === 255) continue
      const px = (x + .5) * scale, pz = (z + .5) * scale
      if (wx1 - wx0 > 1) {
        const dz = wz0 - pz
        if (dz > -0.1 && dz < 2.6) {
          const xShift = px + dz * 0.18, half = (wx1 - wx0) * 0.46, mid = (wx0 + wx1) * 0.5
          const dx = Math.max(0, Math.abs(xShift - mid) - half)
          if (dx < 0.45) {
            const along = Math.max(0, 1 - Math.max(0, dz) / 2.5), across = Math.max(0, 1 - dx / 0.42)
            const mullion = 1 - 0.35 * Math.exp(-(((xShift - mid) / 0.08) ** 2))
            data[idx] = Math.max(data[idx]!, Math.round(14 + 215 * along * along * across * mullion))
          }
        }
      } else {
        const dx = wx0 - px
        if (dx > -0.1 && dx < 2.6) {
          const zShift = pz - dx * 0.15, half = (wz1 - wz0) * 0.46, mid = (wz0 + wz1) * 0.5
          const dz = Math.max(0, Math.abs(zShift - mid) - half)
          if (dz < 0.45) {
            const along = Math.max(0, 1 - Math.max(0, dx) / 2.5), across = Math.max(0, 1 - dz / 0.42)
            const mullion = 1 - 0.35 * Math.exp(-(((zShift - mid) / 0.08) ** 2))
            data[idx] = Math.max(data[idx]!, Math.round(14 + 215 * along * along * across * mullion))
          }
        }
      }
    }
  }
  return { chunks: chunks([...meshes,...props],true), glass: chunks(glasses), floor: { data, w: resolution, h: resolution }, bounce: { data: new Uint8Array([0, 0, 0, 255]), w: 1, h: 1 } }
}
