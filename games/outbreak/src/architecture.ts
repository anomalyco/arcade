import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { buildFoliageTree, emitHydrangeaPanicles, foliageSettings } from "@arcade/kit/gpu/foliage"
import { Rng } from "@arcade/kit/sim/rng"
import type { Building, Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"

const rgb = (v:number):Rgb => [(v>>16&255)/255,(v>>8&255)/255,(v&255)/255]
type Point = [number,number,number]

export const archSettings = {
  houseDecay: 0,
  clutterDensity: 1.0,
  weathering: 1.0,
  clutterSeed: 17,
}

export type HouseDecayState = 1 | 2 | 3 | 4 // 1=Tidy, 2=Abandoned, 3=Ransacked, 4=Barricaded

export function resolveHouseDecay(town: Town, id: number): HouseDecayState {
  if (archSettings.houseDecay >= 1 && archSettings.houseDecay <= 4) {
    return archSettings.houseDecay as HouseDecayState
  }
  if (town.houseSeed === 7) return id === 0 ? 3 : 4
  return ((((town.houseSeed + id * 3) % 4) + 4) % 4 + 1) as HouseDecayState
}

/** Weathered clapboard garden shed with hipped shingle roof, slightly ajar door & leaning boards in the NW side yard. */
function gardenShed(m:Mesh,x0:number,z0:number,x1:number,z1:number,ground:number) {
  const y=ground, wallCol=rgb(0x464f5a), trimCol=rgb(0x636b75), roofCol=rgb(0x28313f), ridgeCol=rgb(0x364254)
  const mx=(x0+x1)/2, mz=(z0+z1)/2, eave=y+1.52, peak=y+2.10
  m.box(x0,y+.02,z0,x1,eave,z1,wallCol,MAT.timber)
  m.box(x0-.02,y+.01,z0-.02,x1+.02,y+.22,z1+.02,rgb(0x2a2f28),MAT.timber)
  for(const px of [x0,x1-.06])for(const pz of [z0,z1-.06])m.box(px,y+.02,pz,px+.06,eave,pz+.06,trimCol,MAT.lit)
  // Dark interior gap + weathered double shed doors on south face (+z) with cross-buck Z braces
  m.box(mx-.44,y+.04,z1-.01,mx+.44,eave-.10,z1+.01,rgb(0x101318),MAT.lit)
  m.box(mx-.42,y+.06,z1+.01,mx-.04,eave-.12,z1+.04,rgb(0x3b434d),MAT.timber)
  m.box(mx+.04,y+.06,z1+.01,mx+.42,eave-.12,z1+.05,rgb(0x363e48),MAT.timber)
  for(const dy of [.28,1.18])m.box(mx-.40,y+dy,z1+.04,mx+.40,y+dy+.05,z1+.06,trimCol,MAT.lit)
  // Leaning weathered salvage planks against east shed wall
  m.quadAuto([x1+.16,y+.02,z0+.35],[x1+.16,y+.02,z0+.58],[x1+.02,y+1.18,z0+.56],[x1+.02,y+1.18,z0+.33],rgb(0x584632),MAT.timber)
  // Four-sided hipped roof with overhanging eaves & dark fascia
  const ox0=x0-.15,ox1=x1+.15,oz0=z0-.15,oz1=z1+.15,top:Point=[mx,peak,mz]
  m.box(ox0,eave-.05,oz0,ox1,eave+.01,oz1,rgb(0x222730),MAT.lit)
  m.facet([ox0,eave,oz1],[ox1,eave,oz1],top,roofCol,MAT.lit)
  m.facet([ox1,eave,oz0],[ox0,eave,oz0],top,roofCol,MAT.lit)
  m.facet([ox0,eave,oz0],[ox0,eave,oz1],top,ridgeCol,MAT.lit)
  m.facet([ox1,eave,oz1],[ox1,eave,oz0],top,ridgeCol,MAT.lit)
}
function parkedSedan(m:Mesh,cx:number,cz:number,ground:number) {
  const y=ground, from=m.length
  // Soft contact shadow under chassis
  m.quad([-.94,y+.004,2.16],[.94,y+.004,2.16],[.94,y+.004,-2.16],[-.94,y+.004,-2.16],[0,1,0],rgb(0x0c0f14),MAT.lit)
  const paintSide=rgb(0x3a424e),paintTop=rgb(0x475160),paintRoof=rgb(0x4d5868),trim=rgb(0x1b1f26),glass=rgb(0x161e28),pillar=rgb(0x566172)
  // Four wheels with dark tires and weathered steel/alloy rims
  for(const sx of [-.78,.78])for(const sz of [-1.28,1.22]){
    m.box(sx-.11,y+.01,sz-.31,sx+.11,y+.56,sz+.31,rgb(0x14161a),MAT.lit)
    m.box(sx+(sx<0?-.12:.09),y+.14,sz-.19,sx+(sx<0?-.09:.12),y+.43,sz+.19,rgb(0x525864),MAT.shiny)
  }
  // Lower body hull: long hood at north (-z), trunk deck at south (+z)
  m.bevelBox(-.84,y+.22,-2.04,.84,y+.76,2.02,.055,paintSide,paintTop,MAT.lit,MAT.lit)
  // Weathered grime/oxidation patches on hood & trunk + dark panel seams so the car reads as abandoned/weathered
  m.box(-.64,y+.761,-1.82,-.12,y+.766,-1.05,rgb(0x363c44),MAT.lit)
  m.box(.14,y+.761,-1.65,.62,y+.766,-.88,rgb(0x3c3834),MAT.lit)
  m.box(-.58,y+.761,1.18,.48,y+.766,1.82,rgb(0x383f4a),MAT.lit)
  m.box(-.72,y+.761,-1.92,.72,y+.768,-1.88,rgb(0x1e232a),MAT.lit)
  m.box(-.72,y+.761,1.12,.72,y+.768,1.15,rgb(0x1e232a),MAT.lit)
  // Front (-z) & rear (+z) wrap-around dark bumpers + side rub strips + door vertical seam
  m.box(-.86,y+.20,1.86,.86,y+.43,2.09,trim,MAT.lit)
  m.box(-.86,y+.20,-2.09,.86,y+.43,-1.86,trim,MAT.lit)
  m.box(-.86,y+.35,-1.86,.86,y+.41,1.86,trim,MAT.lit)
  m.box(-.85,y+.24,-.02,.85,y+.74,.02,trim,MAT.lit)
  // Hood creases (-z), cowl vent grille, windshield wipers & trunk lid seam (+z)
  for(const sx of [-.56,.56])m.box(sx-.024,y+.76,-1.94,sx+.024,y+.782,-.74,rgb(0x323944),MAT.lit)
  m.box(-.018,y+.76,-1.96,.018,y+.784,-.74,rgb(0x5c687a),MAT.lit)
  m.box(-.68,y+.755,-.76,.68,y+.776,-.60,rgb(0x16191f),MAT.lit)
  for(const wx of [-.42,.12])m.box(wx,y+.775,-.72,wx+.36,y+.79,-.67,rgb(0x12151a),MAT.lit)
  for(const sx of [-.72,.72])m.box(sx-.018,y+.758,1.08,sx+.018,y+.776,1.94,rgb(0x2e3540),MAT.lit)
  // Tapered cabin greenhouse: windshield at -z, roof in center, rear window at +z facing the street camera
  const bL=-.78,bR=.78,tL=-.65,tR=.65,y0=y+.75,y1=y+1.26
  const zRearBot=1.12,zRearTop=.48,zFrontTop=-.34,zFrontBot=-.76
  m.quadAuto([tL,y1,zRearTop],[tR,y1,zRearTop],[tR,y1,zFrontTop],[tL,y1,zFrontTop],paintRoof,MAT.lit)
  // Roof weathering patch & twin dark roof drip-rail channels / crossbars
  m.box(-.46,y1+.001,-.22,.38,y1+.005,.36,rgb(0x3a414d),MAT.lit)
  for(const rx of [tL+.03,tR-.03])m.box(rx-.018,y1,zFrontTop+.04,rx+.018,y1+.022,zRearTop-.04,trim,MAT.lit)
  for(const rz of [-.16,.26])m.box(tL+.02,y1+.015,rz-.02,tR-.02,y1+.032,rz+.02,rgb(0x252a32),MAT.lit)
  m.quadAuto([bL,y0,zRearBot],[bR,y0,zRearBot],[tR,y1,zRearTop],[tL,y1,zRearTop],pillar,MAT.lit)
  m.quadAuto([tL,y1,zFrontTop],[tR,y1,zFrontTop],[bR,y0,zFrontBot],[bL,y0,zFrontBot],pillar,MAT.lit)
  m.quadAuto([bL,y0,zFrontBot],[bL,y0,zRearBot],[tL,y1,zRearTop],[tL,y1,zFrontTop],paintSide,MAT.lit)
  m.quadAuto([bR,y0,zRearBot],[bR,y0,zFrontBot],[tR,y1,zFrontTop],[tR,y1,zRearTop],paintSide,MAT.lit)
  // Inset rear window (+z, facing camera) & front windshield (-z) with dark glass + defroster lines
  m.quadAuto([bL+.09,y0+.03,zRearBot+.006],[bR-.09,y0+.03,zRearBot+.006],[tR-.08,y1-.03,zRearTop+.006],[tL+.08,y1-.03,zRearTop+.006],glass,MAT.shiny)
  m.quadAuto([tL+.08,y1-.03,zFrontTop-.006],[tR-.08,y1-.03,zFrontTop-.006],[bR-.09,y0+.03,zFrontBot-.006],[bL+.09,y0+.03,zFrontBot-.006],glass,MAT.shiny)
  // Inset side door windows separated by B-pillar, plus front side mirrors near A-pillar (-z)
  for(const [za,zb,ta,tb] of [[.10,zRearBot-.10,.08,zRearTop-.06],[zFrontBot+.10,.03,zFrontTop+.06,.03]] as const){
    m.quadAuto([bL-.005,y0+.03,za],[bL-.005,y0+.03,zb],[tL-.005,y1-.03,tb],[tL-.005,y1-.03,ta],glass,MAT.shiny)
    m.quadAuto([bR+.005,y0+.03,zb],[bR+.005,y0+.03,za],[tR+.005,y1-.03,ta],[tR+.005,y1-.03,tb],glass,MAT.shiny)
  }
  for(const s of [-1,1])m.box(s*.84,y+.74,-.52,s*.97,y+.84,-.38,paintSide,MAT.lit)
  // Rear (+z, facing camera): tail-light clusters, amber turn strips, trunk garnish & recessed license plate
  m.box(-.22,y+.47,2.00,.22,y+.63,2.04,rgb(0x232830),MAT.lit)
  m.box(-.16,y+.49,2.01,.16,y+.60,2.05,rgb(0x8e8a7e),MAT.lit)
  for(const sx of [-.56,.56]){
    m.box(sx-.22,y+.48,2.00,sx+.22,y+.65,2.04,rgb(0x6e201c),MAT.shiny)
    m.box(sx-.22,y+.58,2.005,sx+.22,y+.65,2.045,rgb(0x8e521c),MAT.shiny)
    m.box(sx-.18,y+.48,-2.05,sx+.18,y+.66,-2.00,rgb(0x8892a0),MAT.shiny)
  }
  m.box(-.42,y+.47,-2.05,.42,y+.65,-2.00,rgb(0x14171c),MAT.lit)
  // Slight natural parking yaw (~3 deg) and translate to driveway
  const yaw=-.055, c=Math.cos(yaw), s=Math.sin(yaw)
  for(let i=from;i<m.v.length;i+=11){
    const vx=m.v[i]!,vz=m.v[i+2]!,nx=m.v[i+3]!,nz=m.v[i+5]!
    m.v[i]=vx*c-vz*s+cx; m.v[i+2]=vx*s+vz*c+cz
    m.v[i+3]=nx*c-nz*s; m.v[i+5]=nx*s+nz*c
  }
}

/** Broadleaf scaffold: layered bough clusters, bent-normal peripheral leaf rosettes, interior canopy AO and base grass tufts. */
export function plant(m:Mesh,x:number,z:number,h:number,radius:number,seed:number,ground:number) {
  buildFoliageTree(m,x,z,h,radius,seed,ground,foliageSettings)
}

/** Procedural bungalow over authoritative room and opening boundaries. */
export function house(m:Mesh,b:Building,id:number,town:Town) {
  const [x,z,r,e]=b.rect,mid=(z+e)/2,ridge=4.35+(town.houseSeed%3)*.12
  const trim=rgb(0xc8c4b8),roof=rgb(0x364152),eaveTrim=rgb(0x323944),gutterMetal=rgb(0x414a56),gutterDark=rgb(0x14181f)
  if(b.kind!=="house"){
    const sc=rgb(0x3a403d),parapet=rgb(0x4a504c)
    m.box(x+.36,2.8,z+.36,r-.36,2.94,e-.36,sc,MAT.roof,id)
    m.box(x-.15,2.8,z-.15,r+.15,3.02,z+.36,parapet,MAT.roof,id)
    m.box(x-.15,2.8,e-.36,r+.15,3.02,e+.15,parapet,MAT.roof,id)
    m.box(x-.15,2.8,z+.36,x+.36,3.02,e-.36,parapet,MAT.roof,id)
    m.box(r-.36,2.8,z+.36,r+.15,3.02,e-.36,parapet,MAT.roof,id)
    return
  }
  const slopeY = (pz: number) => 2.88 + (ridge - 2.88) * (1 - Math.abs(pz - mid) / (mid - (z - .42)))
  // Front roof slope (mid .. e+.42) spans full width; north slope steps in at x+9.5 and r-1.6 to match the L-shaped plan.
  const xCutsFront = [x - .42, x + .36, r - .36, r + .42]
  for (const [z0, z1] of [[e + .42, e - .36], [e - .36, mid]] as const) {
    const y0 = slopeY(z0), y1 = slopeY(z1)
    for (let xi = 0; xi < 3; xi++) {
      const x0 = xCutsFront[xi]!, x1 = xCutsFront[xi + 1]!
      m.quadAuto([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1], roof, MAT.roof, id)
    }
  }
  const xCutsBack = [x + 1.85, x + 2.35, x + 9.15, x + 9.75]
  for (const [z0, z1] of [[mid, z + .36], [z + .36, z - .42]] as const) {
    const y0 = slopeY(z0), y1 = slopeY(z1)
    for (let xi = 0; xi < 3; xi++) {
      const x0 = xCutsBack[xi]!, x1 = xCutsBack[xi + 1]!
      m.quadAuto([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1], roof, MAT.roof, id)
    }
  }
  // Left roof wing alongside the west bedroom wall (x-.42 .. x+2.05, z+1.2 .. z+5.55), meeting the living room north wall cleanly
  m.quadAuto([x-.42, 2.84, z+1.2], [x-.42, 2.84, z+5.55], [x+2.05, 3.48, z+5.55], [x+2.05, 3.48, z+1.2], roof, MAT.roof, id)
  m.box(x-.45, 2.70, z+1.15, x+2.05, 2.84, z+1.25, eaveTrim, MAT.roof, id)
  m.box(x-.48, 2.72, z+1.18, x-.40, 2.84, z+5.55, eaveTrim, MAT.roof, id)
  // Stepped north-east shingle roof wing spanning all the way to r+.42 so the NE utility alcove is properly roofed
  m.quadAuto([x+9.45, 3.46, z+5.55], [r+.42, 3.46, z+5.55], [r+.42, 2.84, z+1.38], [x+9.45, 2.84, z+1.38], roof, MAT.roof, id)
  m.quadAuto([r-1.60, slopeY(mid), mid], [r+.42, slopeY(mid), mid], [r+.42, 3.46, z+5.55], [r-1.60, 3.46, z+5.55], roof, MAT.roof, id)
  m.box(x+9.45, 2.70, z+1.32, r+.45, 2.84, z+1.43, eaveTrim, MAT.roof, id)
  m.box(r+.36, 2.72, z+1.35, r+.46, 2.86, z+5.55, eaveTrim, MAT.roof, id)
  // Gable end triangles + stepped moonlit rake bargeboards & dark under-rake shadow molding
  for(const px of [x-.01,r+.01])m.facet([px,2.8,z+5.5],[px,ridge,mid],[px,2.8,e],rgb(b.color),MAT.roof,id)
  for(const [rx0,rx1] of [[x-.46,x-.36],[r+.36,r+.46]] as const){
    m.quadAuto([rx0,2.84,e+.44],[rx1,2.84,e+.44],[rx1,ridge+.03,mid],[rx0,ridge+.03,mid],rgb(0x465160),MAT.roof,id)
    m.quadAuto([rx0,ridge+.03,mid],[rx1,ridge+.03,mid],[rx1,2.84,z+5.45],[rx0,2.84,z+5.45],rgb(0x3b4554),MAT.roof,id)
  }
  m.box(x+1.75,2.68,z-.42,x+9.78,2.84,z-.31,eaveTrim,MAT.roof,id)
  // Split south eave fascia, deep soffit shadow, half-round metal gutter with dark interior channel + brackets, and overlapping ridge cap tiles.
  for (let xi = 0; xi < 3; xi++) {
    const x0 = xCutsFront[xi]!, x1 = xCutsFront[xi + 1]!
    // Dark weathered fascia & deep recessed soffit shadow
    m.box(x0, 2.71, e+.34, x1, 2.85, e+.43, eaveTrim, MAT.roof, id)
    m.box(x0, 2.58, e+.01, x1, 2.70, e+.39, rgb(0x141820), MAT.roof, id)
    // Gutter body, dark interior water trough, and thin moonlit outer lip
    m.box(x0, 2.74, e+.42, x1, 2.81, e+.51, gutterMetal, MAT.roof, id)
    m.box(x0, 2.811, e+.43, x1, 2.825, e+.49, gutterDark, MAT.roof, id)
    m.box(x0, 2.79, e+.50, x1, 2.835, e+.525, rgb(0x586474), MAT.roof, id)
    // Overlapping saddle ridge-cap tiles with moonlit top bevel
    let rx = x0
    let capIdx = 0
    while (rx < x1 - .02) {
      const nx = Math.min(x1, rx + .38)
      const capCol = capIdx % 2 === 0 ? rgb(0x3a4556) : rgb(0x303a49)
      m.box(rx, ridge - .03, mid - .12, nx, ridge + .045, mid + .12, capCol, MAT.roof, id, rgb(0x526076))
      rx = nx
      capIdx++
    }
  }
  // Gutter mounting brackets & rafter-tail shadow blocks along front eave (on outer non-cut spans + inner span)
  for (let gx = x - .30; gx <= r + .30; gx += 1.15) {
    m.box(gx - .02, 2.73, e + .41, gx + .02, 2.84, e + .53, rgb(0x252b34), MAT.roof, id)
  }
  // Roof plumbing vent stacks & low-profile metal box louver attic vent (MAT.roof + id so they cut away cleanly)
  for (const [vx, vz] of [[x + 3.4, mid + 1.15], [x + 8.1, mid - 1.05]] as const) {
    const vy = slopeY(vz) - .04
    m.box(vx - .14, vy, vz - .14, vx + .14, vy + .05, vz + .14, rgb(0x232932), MAT.roof, id)
    m.prism(vx, vz, .055, .052, vy + .04, vy + .38, 6, rgb(0x3e4652), MAT.roof, id)
    m.prism(vx, vz, .042, .042, vy + .38, vy + .395, 6, rgb(0x101318), MAT.roof, id)
  }
  {
    const ax = x + 5.8, az = mid - 1.35, ay = slopeY(az) - .03
    m.box(ax - .26, ay, az - .20, ax + .26, ay + .11, az + .20, rgb(0x2c3440), MAT.roof, id, rgb(0x465264))
    m.box(ax - .22, ay + .02, az - .21, ax + .22, ay + .08, az + .21, rgb(0x161a20), MAT.roof, id)
  }
  // Weathered brick chimney on upper-right slope with lead step-flashing, corbelled brick crown, soot-stained cap & terracotta flue pot.
  const chY0 = slopeY(mid + 1.3) - .18
  m.box(r-2.15,chY0,mid+.75,r-1.05,chY0+.22,mid+1.85,rgb(0x242a32),MAT.roof,id)
  m.box(r-2.08,3.18,mid+.82,r-1.12,4.72,mid+1.78,rgb(0x583329),MAT.brick,id)
  // Corbelled brick necking + soot-darkened upper courses
  m.box(r-2.13,4.64,mid+.77,r-1.07,4.75,mid+1.83,rgb(0x462820),MAT.brick,id)
  m.box(r-2.17,4.75,mid+.73,r-1.03,4.85,mid+1.87,rgb(0x34383e),MAT.roof,id,rgb(0x3e434b))
  m.box(r-1.92,4.85,mid+.98,r-1.28,4.90,mid+1.62,rgb(0x14171c),MAT.roof,id)
  m.box(r-1.76,4.88,mid+1.14,r-1.44,5.08,mid+1.46,rgb(0x4e2f24),MAT.roof,id,rgb(0x12151a))
  // Dual metal downspouts at west & east front corners with gooseneck elbows and wall straps
  for (const [dx, side] of [[x + .04, -1], [r - .06, 1]] as const) {
    m.box(dx - .04, .14, e - .02, dx + .04, 2.74, e + .06, gutterMetal, MAT.lit)
    m.box(dx - .045, 2.58, e + .04, dx + .045, 2.76, e + .44, gutterMetal, MAT.roof, id)
    for (const sy of [.65, 1.45, 2.25]) m.box(dx - .05, sy, e - .025, dx + .05, sy + .04, e + .07, rgb(0x232830), MAT.lit)
    m.box(dx - .04, .08, e + .02, dx + .04, .18, e + .26 + (side < 0 ? .04 : 0), gutterMetal, MAT.lit)
  }
  const cx=x+5.7
  parkedSedan(m,x-1.68,e-1.35,.035)
  gardenShed(m,x-2.85,z+.55,x-1.15,z+2.25,.035)
  // Gabled porch canopy with dark valley flashing, dark shingle slopes, shadowed soffit, and weathered bargeboard rake trim.
  m.quadAuto([cx-1.56,2.48,e-.08],[cx,3.06,e-.08],[cx,3.06,e-.26],[cx-1.56,2.48,e-.26],rgb(0x1f252e),MAT.roof,id)
  m.quadAuto([cx,3.06,e-.08],[cx+1.56,2.48,e-.08],[cx+1.56,2.48,e-.26],[cx,3.06,e-.26],rgb(0x1f252e),MAT.roof,id)
  m.quadAuto([cx-1.56,2.48,e+1.28],[cx,3.04,e+1.28],[cx,3.04,e-.12],[cx-1.56,2.48,e-.12],roof,MAT.roof,id)
  m.quadAuto([cx,3.04,e+1.28],[cx+1.56,2.48,e+1.28],[cx+1.56,2.48,e-.12],[cx,3.04,e-.12],roof,MAT.roof,id)
  m.box(cx-.06,3.01,e-.12,cx+.06,3.08,e+1.30,rgb(0x3c4758),MAT.roof,id,rgb(0x526076))
  m.facet([cx-1.46,2.48,e+1.18],[cx,2.98,e+1.18],[cx+1.46,2.48,e+1.18],rgb(0x282420),MAT.roof,id)
  m.quadAuto([cx-1.58,2.44,e+1.30],[cx,3.01,e+1.30],[cx,3.08,e+1.26],[cx-1.58,2.51,e+1.26],rgb(0x64686e),MAT.roof,id)
  m.quadAuto([cx,3.01,e+1.30],[cx+1.58,2.44,e+1.30],[cx+1.58,2.51,e+1.26],[cx,3.08,e+1.26],rgb(0x64686e),MAT.roof,id)
  m.box(cx-1.52,2.40,e+1.08,cx+1.52,2.48,e+1.24,rgb(0x4a4e54),MAT.roof,id)
  // Craftsman porch columns with brick/stone plinth pedestals, recessed shaft panels, capital collars & side balustrades.
  for(const [side, px] of [[-1, cx-1.24], [1, cx+1.24]] as const){
    // Brick plinth pedestal & stone cap
    m.box(px-.16,.025,e+.98,px+.16,.44,e+1.30,rgb(0x58342a),MAT.brick)
    m.box(px-.18,.44,e+.96,px+.18,.50,e+1.32,rgb(0x6e695f),MAT.lit)
    // Tapered timber shaft with recessed inner panel & capital collar
    m.box(px-.11,.50,e+1.03,px+.11,2.40,e+1.25,rgb(0x8c8578),MAT.lit)
    m.box(px-.07,.58,e+1.251,px+.07,2.28,e+1.265,rgb(0x645e53),MAT.lit)
    m.box(px-.14,2.34,e+1.00,px+.14,2.42,e+1.28,rgb(0x787266),MAT.roof,id)
    // Side porch balustrade (west & east edges, z = e+.06 .. e+1.02)
    m.box(px-.05,.76,e+.04,px+.05,.82,e+1.03,rgb(0x7d776b),MAT.lit,0,rgb(0x918a7c))
    m.box(px-.04,.24,e+.04,px+.04,.29,e+1.03,rgb(0x686358),MAT.lit)
    for(let bz=e+.14;bz<=e+.96;bz+=.16){
      m.box(px-.022,.29,bz-.02,px+.022,.76,bz+.02,rgb(0x746e62),MAT.lit)
    }
    // Short front return balustrade wing framing the central 1.56m step opening
    const rx0 = side < 0 ? px + .11 : cx + .78
    const rx1 = side < 0 ? cx - .78 : px - .11
    m.box(rx0,.76,e+1.10,rx1,.82,e+1.18,rgb(0x7d776b),MAT.lit,0,rgb(0x918a7c))
    m.box(rx0,.24,e+1.11,rx1,.29,e+1.17,rgb(0x686358),MAT.lit)
    for(const bx of [rx0+.08,(rx0+rx1)/2,rx1-.08]){
      m.box(bx-.02,.29,e+1.12,bx+.02,.76,e+1.16,rgb(0x746e62),MAT.lit)
    }
    // Brick & stone step cheek wall flanking the front steps
    const cx0 = side < 0 ? px - .14 : cx + .74
    const cx1 = side < 0 ? cx - .74 : px + .14
    m.box(cx0,.025,e+1.28,cx1,.30,e+1.64,rgb(0x543228),MAT.brick)
    m.box(cx0-.02,.30,e+1.26,cx1+.02,.35,e+1.66,rgb(0x666158),MAT.lit)
  }
  // Porch deck perimeter brick skirt + two-tier step risers & bullnose shadow lines leading to front walkway.
  m.box(x+4.46,.02,e+.02,cx-1.36,.132,e+1.28,rgb(0x4e2e25),MAT.brick)
  m.box(cx+1.36,.02,e+.02,x+7.04,.132,e+1.28,rgb(0x4e2e25),MAT.brick)
  m.box(cx-.74,.08,e+1.26,cx+.74,.131,e+1.32,rgb(0x22201d),MAT.lit)
  m.box(cx-.74,.04,e+1.44,cx+.74,.131,e+1.49,rgb(0x1e1c19),MAT.lit)
  m.box(cx-.74,.015,e+1.60,cx+.74,.131,e+1.65,rgb(0x24221e),MAT.lit)
  // Cast-iron wall mailbox with brass slot & sticking-out rolled flyer, plus house number plaque beside the door.
  m.box(cx+1.00,1.18,e+.01,cx+1.22,1.44,e+.11,rgb(0x21262c),MAT.lit,0,rgb(0x2f353d))
  m.box(cx+1.03,1.36,e+.11,cx+1.19,1.385,e+.125,rgb(0xa88b52),MAT.shiny)
  m.box(cx+1.04,1.43,e+.03,cx+1.17,1.49,e+.09,rgb(0xc8c0ae),MAT.lit)
  // House number plaque ("247" / "251") on left pilaster
  m.box(cx-.92,1.42,e+.01,cx-.74,1.54,e+.04,rgb(0x1d2024),MAT.lit)
  for(let d=0;d<3;d++)m.box(cx-.89+d*.05,1.45,e+.041,cx-.86+d*.05,1.51,e+.05,rgb(0xc4a25e),MAT.shiny)
  // Door casing, recessed dark jambs, moulded pediment lintel, weathered threshold sill & rubber-bordered coir mat.
  for(const px of [x+4.89,x+6.41]){
    m.box(px,.13,e-.25,px+.10,2.38,e+.08,rgb(0x888174),MAT.wall)
    m.box(px+.02,.13,e-.02,px+.08,2.34,e+.095,rgb(0x666055),MAT.wall)
    m.box(px,.13,z+5.48,px+.08,2.34,z+5.72,rgb(0x787062),MAT.wall)
  }
  m.box(x+4.86,2.30,e-.25,x+6.54,2.42,e+.09,rgb(0x888174),MAT.wall)
  m.box(x+4.84,2.41,e-.24,x+6.56,2.47,e+.12,rgb(0x6e685c),MAT.wall)
  m.box(x+5,.13,e-.28,x+6.4,.152,e+.18,rgb(0x585246),MAT.lit)
  // Rubber-bordered coir welcome mat with scraper ribs
  m.box(cx-.54,.131,e+.18,cx+.54,.148,e+.74,rgb(0x1c1b19),MAT.lit)
  m.box(cx-.48,.134,e+.23,cx+.48,.154,e+.69,rgb(0x4a3623),MAT.timber)
  for(let rz=e+.28;rz<=e+.64;rz+=.09)m.box(cx-.44,.154,rz,cx+.44,.158,rz+.03,rgb(0x362718),MAT.timber)
  // Porch clutter: slatted wood crate, terracotta planter with dead stems, muddy boots, leaning broom & parcel box
  m.yawBox(cx-1.02,e+.36,.38,.32,.13,.42,.18,rgb(0x4e3b28),MAT.timber,0,rgb(0x3b2c1d))
  m.prism(cx-.98,e+.78,.15,.11,.13,.38,7,rgb(0x6e3d26),MAT.lit)
  m.prism(cx-.98,e+.78,.13,.13,.36,.39,7,rgb(0x241d16),MAT.lit)
  m.box(cx-.68,.13,e+.22,cx-.58,.28,e+.34,rgb(0x22201d),MAT.lit)
  m.box(cx-.67,.13,e+.30,cx-.59,.19,e+.42,rgb(0x2a2723),MAT.lit)
  m.yawBox(cx+.96,e+.34,.32,.26,.13,.32,-.22,rgb(0x685238),MAT.timber,0,rgb(0x7a6244))
  // Leaning porch broom against right wall beside door
  m.quadAuto([cx+.82,.13,e+.18],[cx+.85,.13,e+.18],[cx+.76,1.28,e+.03],[cx+.73,1.28,e+.03],rgb(0x5c462e),MAT.timber)
  m.box(cx+.76,.13,e+.14,cx+.90,.32,e+.23,rgb(0x6e5a38),MAT.timber)
  // Grouped foundation planting: natural soil bed without toothed brick edging, boxwood pair by porch, corner shrubs and hydrangea.
  const rng=new Rng(town.houseSeed+id*71)
  for(const [a,d] of [[x+.15,x+4.35],[x+7.15,r-.15]]){
    m.quad([a!,.022,e+.92],[d!,.022,e+.92],[d!,.022,e+.05],[a!,.022,e+.05],[0,1,0],rgb(0x28291f),MAT.ground,5)
  }
  // Left corner shrub cluster + low under-window shrubs + twin boxwood globes + flowering hydrangea
  for(const [px,pz,ph,pr] of [
    [x+.28,e+.54,1.38,.88],
    [x-.28,e-.35,1.22,.78],
    [x+1.45,e+.44,.64,.44],
    [x+2.52,e+.46,.52,.38],
    [x+3.65,e+.38,.56,.40],
    // Two distinct compact rounded boxwood globes right of the porch column (h/r >= 1.65 triggers globe habit)
    [x+7.42,e+.50,.88,.50],
    [x+8.68,e+.52,.84,.48],
    // Low border shrubs under the right window
    [x+10.05,e+.42,.52,.38],
    [x+11.25,e+.44,.56,.40],
    // Lush flowering Hydrangea bush at the front-right corner
    [r-1.05,e+.62,1.12,.88],
  ])plant(m,px!,pz!,ph!,pr!,Math.floor(rng.next()*1e6),supportHeight(town,px!,pz!))
  // Multi-floret creamy-white hydrangea corymb panicles on the front-right corner bush
  emitHydrangeaPanicles(m,r-1.05,supportHeight(town,r-1.05,e+.62),e+.62,1.12,.88,town.houseSeed+31)
  for(const px of [x+.08,r-.14]){
    m.box(px,.12,e+.1,px+.07,2.77,e+.17,trim,MAT.timber)
    m.box(px,.1,e+.15,px+.07,.17,e+.5,trim,MAT.timber)
  }
  for(const px of [x,r-.10])m.box(px,.28,e-.015,px+.10,2.68,e+.025,rgb(0x787368),MAT.wall)
  // Louvered exterior window shutters, crawlspace foundation vents, utility meter & decay-driven repairs/barricades
  const decay = resolveHouseDecay(town, id)
  const shutterCol = rgb(0x202a27), slatCol = rgb(0x161d1b)
  for (const [winIdx, [wx0, wx1]] of [[0, [x + 1.5, x + 3.5]], [1, [r - 4.0, r - 1.5]]] as const) {
    for (const [sideIdx, sx] of [[-1, wx0 - .36], [1, wx1 + .04]] as const) {
      const crooked = decay >= 2 && winIdx === 0 && sideIdx === 1
      const dy = crooked ? -.05 : 0
      m.box(sx, .82 + dy, e + .008, sx + .32, 2.18 + dy, e + .048, shutterCol, MAT.wall)
      for (let sy = .92 + dy; sy <= 2.08 + dy; sy += .14) {
        m.box(sx + .04, sy, e + .049, sx + .28, sy + .05, e + .062, slatCol, MAT.wall)
      }
    }
    // Cast-iron foundation crawlspace vent grate below each front window
    const vmx = (wx0 + wx1) / 2
    m.box(vmx - .22, .11, e + .025, vmx + .22, .27, e + .048, rgb(0x171a1e), MAT.lit)
    // Weathered water-stain drip streaks below window sill corners
    if (archSettings.weathering > 0.2) {
      for (const cxW of [wx0 + .06, wx1 - .06]) {
        m.box(cxW - .05, .36, e + .003, cxW + .05, .74, e + .012, rgb(0x46423a), MAT.wall)
      }
    }
    // Exterior barricade planks across windows when house decay is Barricaded (4) or on right window in Ransacked/Abandoned
    if (decay === 4 || (decay === 2 && winIdx === 0)) {
      m.quadAuto([wx0 - .12, 1.02, e + .07], [wx1 + .12, 1.24, e + .07], [wx1 + .12, 1.40, e + .07], [wx0 - .12, 1.18, e + .07], rgb(0x5e462e), MAT.timber)
      m.quadAuto([wx0 - .10, 1.78, e + .075], [wx1 + .10, 1.56, e + .075], [wx1 + .10, 1.72, e + .075], [wx0 - .10, 1.94, e + .075], rgb(0x523c26), MAT.timber)
    }
  }
  // Mismatched siding repair patch & utility meter + conduit pipe on side wall
  if (decay >= 2) {
    m.box(x + 3.62, .48, e + .004, x + 4.46, .96, e + .018, rgb(0x5e5648), MAT.timber)
    m.box(r - 1.38, .42, e + .004, r - .42, .82, e + .018, rgb(0x565044), MAT.timber)
  }
  m.box(x - .08, 1.15, z + 6.8, x + .01, 1.52, z + 7.12, rgb(0x3a4046), MAT.lit)
  m.box(x - .04, .35, z + 6.93, x + .01, 2.68, z + 6.99, rgb(0x4a5058), MAT.lit)
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
    // South-side street corner framing shrubs across the road (for the hero north-west lot)
    ...(id===0 ? [
      [x-6.35,e+16.4,5.60,2.25],
      [r+3.35,e+16.6,1.48,.96],
    ] as const : []),
  ])plant(m,px!,pz!,ph!,pr!,town.houseSeed+Math.floor(pz!*43+px!*17),supportHeight(town,px!,pz!))
  // Patterned Persian/Oriental area rugs in the living room and bedroom, plus a woven kitchen runner.
  // Living room Oriental rug with warm cream border, slate-sage field, terracotta guard, corner motifs & diamond medallion
  {
    const rx0=x+1.55,rz0=e-4.35,rx1=x+4.42,rz1=e-.85,rmx=(rx0+rx1)/2,rmz=(rz0+rz1)/2
    m.box(rx0,.132,rz0,rx1,.138,rz1,rgb(0xcabaa0))
    m.box(rx0+.10,.1385,rz0+.10,rx1-.10,.141,rz1-.10,rgb(0x3a4a4c))
    m.box(rx0+.20,.1415,rz0+.20,rx1-.20,.144,rz1-.20,rgb(0xa85e44))
    m.box(rx0+.31,.1445,rz0+.31,rx1-.31,.147,rz1-.31,rgb(0x52645c))
    m.box(rmx-.50,.1475,rmz-.74,rmx+.50,.150,rmz+.74,rgb(0xb06246))
    m.box(rmx-.32,.1505,rmz-.48,rmx+.32,.152,rmz+.48,rgb(0xd4b282))
    m.box(rmx-.14,.1525,rmz-.22,rmx+.14,.154,rmz+.22,rgb(0x3a4a4c))
  }
  // Bedroom burgundy Persian rug placed beside the bed in the open bedroom floor
  {
    const bx0=x+4.92,bz0=z+1.35,bx1=x+6.82,bz1=z+4.25,bmx=(bx0+bx1)/2,bmz=(bz0+bz1)/2
    m.box(bx0,.132,bz0,bx1,.138,bz1,rgb(0xc6ae8a))
    m.box(bx0+.09,.1385,bz0+.09,bx1-.09,.141,bz1-.09,rgb(0x2e3642))
    m.box(bx0+.18,.1415,bz0+.18,bx1-.18,.145,bz1-.18,rgb(0x944234))
    m.box(bmx-.40,.1455,bmz-.65,bmx+.40,.148,bmz+.65,rgb(0xb86e4a))
    m.box(bmx-.22,.1485,bmz-.36,bmx+.22,.151,bmz+.36,rgb(0xd8b480))
    m.box(bmx-.09,.1515,bmz-.16,bmx+.09,.153,bmz+.16,rgb(0x4a241c))
  }
  // Kitchen woven runner mat in front of the north sink/stove run
  m.box(r-4.95,.132,z+6.45,r-2.25,.139,z+7.22,rgb(0xa49b86))
  m.box(r-4.86,.1395,z+6.53,r-2.34,.144,z+7.14,rgb(0x4c564e))
  // Living room east media console, flatscreen TV, partition stub, and flanking potted houseplants
  m.box(x+4.86,.13,e-3.62,x+5.06,2.78,e-1.38,rgb(b.color),MAT.wall,20,rgb(0x1b2028))
  m.box(x+4.89,2.78,e-3.59,x+5.03,2.80,e-1.41,rgb(0x2a2e36),MAT.lit)
  m.bevelBox(x+4.44,.13,e-3.55,x+4.85,.62,e-1.45,.03,rgb(0x6e533a),rgb(0x856648),MAT.timber,MAT.timber)
  m.box(x+4.58,.62,e-2.85,x+4.72,.70,e-2.15,rgb(0x22262b))
  m.box(x+4.61,.70,e-3.20,x+4.70,1.38,e-1.80,rgb(0x181c22),MAT.shiny)
  for(const pz of [e-3.88,e-1.12]){
    m.prism(x+4.68,pz,.16,.12,.13,.42,7,rgb(0x8c543a))
    plant(m,x+4.68,pz,.55,.32,town.houseSeed+Math.floor(pz*31),.38)
  }
  // North-wall kitchen run: cream refrigerator, base cabinets, stainless double sink, 4-burner stove & upper cabinets
  const kz=z+5.72
  // Cream-white refrigerator on left of kitchen run
  m.bevelBox(r-5.95,.13,kz,r-5.05,1.88,kz+.72,.03,rgb(0xc6c2b4),rgb(0xd4d0c2))
  m.box(r-5.96,1.32,kz+.71,r-5.04,1.35,kz+.74,rgb(0x5a5850))
  m.box(r-5.16,.82,kz+.72,r-5.12,1.24,kz+.76,rgb(0x7a786e))
  m.box(r-5.16,1.40,kz+.72,r-5.12,1.72,kz+.76,rgb(0x7a786e))
  // Base cabinets & warm butcher/stone countertop with stainless double sink
  m.box(r-5.00,.13,kz,r-2.25,.90,kz+.64,rgb(0x6e5840),MAT.timber)
  m.box(r-5.02,.90,kz-.01,r-2.23,.96,kz+.67,rgb(0xb8b2a2))
  for(let i=0;i<4;i++)m.box(r-4.92+i*.66,.20,kz+.64,r-4.34+i*.66,.84,kz+.66,rgb(0x856c50),MAT.timber)
  m.box(r-4.18,.961,kz+.10,r-3.12,.972,kz+.54,rgb(0x8c9698),MAT.shiny)
  for(const sx of [r-4.10,r-3.60])m.box(sx,.973,kz+.15,sx+.42,.982,kz+.48,rgb(0x3a4446),MAT.shiny)
  m.box(r-3.67,.97,kz+.05,r-3.61,1.18,kz+.12,rgb(0xb0b8ba),MAT.shiny)
  // White 4-burner range stove on right of north counter
  m.box(r-2.22,.13,kz,r-1.38,.94,kz+.68,rgb(0xc2beb0))
  m.box(r-2.23,.94,kz-.01,r-1.37,.965,kz+.69,rgb(0x323838))
  for(const dx of [-.22,.22])for(const dz of [.18,.48])m.prism(r-1.80+dx,kz+dz,.11,.11,.966,.982,8,rgb(0x1b2022))
  m.box(r-2.12,.26,kz+.68,r-1.48,.76,kz+.70,rgb(0x282e30),MAT.shiny)
  // Warm tiled backsplash, under-cabinet warm light strip & upper wall cupboards above north kitchen run
  const kLamp=Math.max(0,town.lamps.findIndex(l=>l.kind==="room"&&l.x>x+7&&l.x<r&&l.y>z+5.5&&l.y<e))
  const lLamp=Math.max(0,town.lamps.findIndex(l=>l.kind==="room"&&l.x>x&&l.x<x+5&&l.y>z+5.5&&l.y<e))
  m.box(r-5.00,.96,kz,r-1.38,1.68,kz+.04,rgb(0x9e8c6c),MAT.wall)
  m.box(r-4.92,1.69,kz+.06,r-2.32,1.72,kz+.24,rgb(0xffd896),MAT.lamp,kLamp)
  m.box(r-5.00,1.72,kz,r-2.25,2.38,kz+.38,rgb(0x7c664c),MAT.timber)
  for(let i=0;i<4;i++)m.box(r-4.94+i*.67,1.76,kz+.38,r-4.35+i*.67,2.32,kz+.40,rgb(0x947b5c),MAT.timber)
  // Living room corner table lamp on the sofa end table (x+1.1, e-.62)
  m.prism(x+1.10,e-.62,.03,.025,.66,.92,6,rgb(0x5a4b35))
  m.prism(x+1.10,e-.62,.21,.12,.90,1.16,9,rgb(0xe8b86b),MAT.lamp,lLamp)
  m.prism(x+1.10,e-.62,.17,.17,.89,.90,9,rgb(0xffdca0),MAT.lamp,lLamp)
  // Potted plant in bedroom top-right corner beside the dresser
  m.prism(x+8.95,z+.85,.17,.13,.13,.44,7,rgb(0x885238))
  plant(m,x+8.95,z+.85,.62,.36,town.houseSeed+91,.40)
  // East-wall upper cupboards and framed art prints (within the L-shaped bedroom & kitchen walls)
  m.box(r-.245,1.02,e-3.2,r-.23,1.67,e-.85,rgb(0x727d70),MAT.wall)
  m.box(r-.60,1.78,e-3.2,r-.25,2.37,e-1.2,rgb(0x7c664c),MAT.timber)
  for(let i=0;i<3;i++)m.box(r-.62,1.82,e-3.15+i*.64,r-.60,2.33,e-2.56+i*.64,rgb(0x947b5c),MAT.timber)
  // Framed paintings on bedroom north wall (x+2..x+9.5), living room west wall, and kitchen south wall
  for(let i=0;i<6;i++)m.box(x+5.4+i*.13,.3,z+.25,x+5.48+i*.13,.85,z+.42,rgb(0x87877a),MAT.wall)
  for(const [px,pz] of [[x+3.85,z+.23],[x+7.85,z+.23],[r-3,e-.27]]){
    m.box(px!-.52,1.28,pz!,px!+.52,1.98,pz!+.055,rgb(0x4e3d2c),MAT.wall)
    m.box(px!-.43,1.37,pz!+.056,px!+.43,1.89,pz!+.062,rgb(0x8c8872),MAT.wall)
  }
  for(const [py,pz] of [[1.32,e-2.6],[1.32,e-1.2]]){
    m.box(x+.22,py!,pz!-.44,x+.27,py!+.64,pz!+.44,rgb(0x4e3d2c),MAT.wall)
    m.box(x+.271,py!+.08,pz!-.36,x+.28,py!+.56,pz!+.36,rgb(0x8e8670),MAT.wall)
  }
  for(const barrier of town.barriers){
    const [a,c,d,f]=barrier.rect
    if(a<x||d>r||c<z||f>e||barrier.kind==="fence")continue
    m.box(a-.032,.025,c-.032,d+.032,.33,f+.032,rgb(0x523027),MAT.brick)
    m.box(a-.036,.33,c-.036,d+.036,.37,f+.036,rgb(0x6e685d),MAT.wall)
  }
}
