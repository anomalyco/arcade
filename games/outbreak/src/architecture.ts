import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { buildFoliageTree, emitGrassTuft, emitHydrangeaPanicles, foliageSettings } from "@arcade/kit/gpu/foliage"
import { Rng } from "@arcade/kit/sim/rng"
import type { Building, Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"
import { emitBuildingRugs, emitInteriorDecor } from "./interiors/mesh"

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
  m.quad([-.94,y+.004,2.16],[.94,y+.004,2.16],[.94,y+.004,-2.16],[-.94,y+.004,-2.16],[0,1,0],rgb(0x0e0d0b),MAT.lit)
  const paintSide=rgb(0x5c5850),paintTop=rgb(0x6e695f),paintRoof=rgb(0x787368),trim=rgb(0x22201d),glass=rgb(0x1c1e20),pillar=rgb(0x827c70)
  // Four wheels with dark tires and weathered steel rims
  for(const sx of [-.78,.78])for(const sz of [-1.28,1.22]){
    m.box(sx-.11,y+.01,sz-.31,sx+.11,y+.56,sz+.31,rgb(0x161513),MAT.lit)
    m.box(sx+(sx<0?-.12:.09),y+.14,sz-.19,sx+(sx<0?-.09:.12),y+.43,sz+.19,rgb(0x68645c),MAT.shiny)
  }
  // Lower body hull: long hood at north (-z), trunk deck at south (+z)
  m.bevelBox(-.84,y+.22,-2.04,.84,y+.76,2.02,.055,paintSide,paintTop,MAT.lit,MAT.lit)
  // Weathered grime/oxidation patches on hood & trunk + dark panel seams
  m.box(-.64,y+.761,-1.82,-.12,y+.766,-1.05,rgb(0x545048),MAT.lit)
  m.box(.14,y+.761,-1.65,.62,y+.766,-.88,rgb(0x585248),MAT.lit)
  m.box(-.58,y+.761,1.18,.48,y+.766,1.82,rgb(0x56524a),MAT.lit)
  m.box(-.72,y+.761,-1.92,.72,y+.768,-1.88,rgb(0x262420),MAT.lit)
  m.box(-.72,y+.761,1.12,.72,y+.768,1.15,rgb(0x262420),MAT.lit)
  // Front (-z) & rear (+z) wrap-around dark bumpers + side rub strips + door vertical seam
  m.box(-.86,y+.20,1.86,.86,y+.43,2.09,trim,MAT.lit)
  m.box(-.86,y+.20,-2.09,.86,y+.43,-1.86,trim,MAT.lit)
  m.box(-.86,y+.35,-1.86,.86,y+.41,1.86,trim,MAT.lit)
  m.box(-.85,y+.24,-.02,.85,y+.74,.02,trim,MAT.lit)
  // Hood creases (-z), cowl vent grille, windshield wipers & trunk lid seam (+z)
  for(const sx of [-.56,.56])m.box(sx-.024,y+.76,-1.94,sx+.024,y+.782,-.74,rgb(0x4e4a42),MAT.lit)
  m.box(-.018,y+.76,-1.96,.018,y+.784,-.74,rgb(0x7c776c),MAT.lit)
  m.box(-.68,y+.755,-.76,.68,y+.776,-.60,rgb(0x1c1a17),MAT.lit)
  for(const wx of [-.42,.12])m.box(wx,y+.775,-.72,wx+.36,y+.79,-.67,rgb(0x161513),MAT.lit)
  for(const sx of [-.72,.72])m.box(sx-.018,y+.758,1.08,sx+.018,y+.776,1.94,rgb(0x4a463f),MAT.lit)
  // Tapered cabin greenhouse: windshield at -z, roof in center, rear window at +z facing the street camera
  const bL=-.78,bR=.78,tL=-.65,tR=.65,y0=y+.75,y1=y+1.26
  const zRearBot=1.12,zRearTop=.48,zFrontTop=-.34,zFrontBot=-.76
  m.quadAuto([tL,y1,zRearTop],[tR,y1,zRearTop],[tR,y1,zFrontTop],[tL,y1,zFrontTop],paintRoof,MAT.lit)
  // Roof weathering patch & twin dark roof drip-rail channels
  m.box(-.46,y1+.001,-.22,.38,y1+.005,.36,rgb(0x605c53),MAT.lit)
  for(const rx of [tL+.03,tR-.03])m.box(rx-.018,y1,zFrontTop+.04,rx+.018,y1+.022,zRearTop-.04,trim,MAT.lit)
  m.quadAuto([bL,y0,zRearBot],[bR,y0,zRearBot],[tR,y1,zRearTop],[tL,y1,zRearTop],pillar,MAT.lit)
  m.quadAuto([tL,y1,zFrontTop],[tR,y1,zFrontTop],[bR,y0,zFrontBot],[bL,y0,zFrontBot],pillar,MAT.lit)
  m.quadAuto([bL,y0,zFrontBot],[bL,y0,zRearBot],[tL,y1,zRearTop],[tL,y1,zFrontTop],paintSide,MAT.lit)
  m.quadAuto([bR,y0,zRearBot],[bR,y0,zFrontBot],[tR,y1,zFrontTop],[tR,y1,zRearTop],paintSide,MAT.lit)
  // Inset rear window (+z, facing camera) & front windshield (-z)
  m.quadAuto([bL+.09,y0+.03,zRearBot+.006],[bR-.09,y0+.03,zRearBot+.006],[tR-.08,y1-.03,zRearTop+.006],[tL+.08,y1-.03,zRearTop+.006],glass,MAT.shiny)
  m.quadAuto([tL+.08,y1-.03,zFrontTop-.006],[tR-.08,y1-.03,zFrontTop-.006],[bR-.09,y0+.03,zFrontBot-.006],[bL+.09,y0+.03,zFrontBot-.006],glass,MAT.shiny)
  // Inset side door windows separated by B-pillar, plus front side mirrors near A-pillar (-z)
  for(const [za,zb,ta,tb] of [[.10,zRearBot-.10,.08,zRearTop-.06],[zFrontBot+.10,.03,zFrontTop+.06,.03]] as const){
    m.quadAuto([bL-.005,y0+.03,za],[bL-.005,y0+.03,zb],[tL-.005,y1-.03,tb],[tL-.005,y1-.03,ta],glass,MAT.shiny)
    m.quadAuto([bR+.005,y0+.03,zb],[bR+.005,y0+.03,za],[tR+.005,y1-.03,ta],[tR+.005,y1-.03,tb],glass,MAT.shiny)
  }
  for(const s of [-1,1])m.box(s*.84,y+.74,-.52,s*.97,y+.84,-.38,paintSide,MAT.lit)
  // Rear (+z, facing camera): tail-light clusters, amber turn strips, trunk garnish & recessed license plate
  m.box(-.22,y+.47,2.00,.22,y+.63,2.04,rgb(0x2c2a26),MAT.lit)
  m.box(-.16,y+.49,2.01,.16,y+.60,2.05,rgb(0x9e9888),MAT.lit)
  for(const sx of [-.56,.56]){
    m.box(sx-.22,y+.48,2.00,sx+.22,y+.65,2.04,rgb(0x7c261e),MAT.shiny)
    m.box(sx-.22,y+.58,2.005,sx+.22,y+.65,2.045,rgb(0x9e5e20),MAT.shiny)
    m.box(sx-.18,y+.48,-2.05,sx+.18,y+.66,-2.00,rgb(0x989488),MAT.shiny)
  }
  m.box(-.42,y+.47,-2.05,.42,y+.65,-2.00,rgb(0x1c1a17),MAT.lit)
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
  plantFootprints.push({x,z,radius,tree:h>2.1,ground})
  buildFoliageTree(m,x,z,h,radius,seed,ground,foliageSettings)
}

/** Ground footprints of every plant() since the level build cleared it; the floor map bakes their contact shade. */
export const plantFootprints:{x:number;z:number;radius:number;tree:boolean;ground:number}[]=[]

export type HouseFrontageOptions = {
  /** Decorative parked sedan in the driveway (the origin lots; streamed lots get a real vehicle instead). */
  sedan?: boolean
  /** Bedroom doorway architrave inside the house (the origin plan). */
  interiorTrim?: boolean
  /** South façade window spans; default the origin bungalow's. */
  windows?: readonly (readonly [number, number])[]
  decay?: HouseDecayState
}

export type HousePlantingOptions = {
  /** Plants a bush or tree; default plant(). Streamed chunks place cached templates instead. */
  plant?: (m: Mesh, x: number, z: number, h: number, radius: number, seed: number, ground: number) => void
  /** Whether a framing plant (driveway hedge, yard and woodland trees) may stand here; default everywhere. */
  keep?: (x: number, z: number, h: number, radius: number) => boolean
  /** Left edge of the 1.4 m front door; default x + 5. */
  doorX?: number
  /** South façade window spans; foundation bushes in front of them stay under the 0.85 m sill. */
  windows?: readonly (readonly [number, number])[]
  /** Bush seed; default houseSeed + id * 71. */
  seed?: number
  /** The corner trees across the street from origin house 0. */
  streetTrees?: boolean
}

/**
 * The street face of the L-plan bungalow: garden shed, porch canopy and columns, steps, mailbox, door casing, mat
 * and porch clutter, corner boards, louvered shutters, foundation vents, decay repairs and the utility meter.
 */
export function houseFrontage(m:Mesh,b:Building,id:number,town:Town,opts:HouseFrontageOptions={}) {
  const [x,z,r,e]=b.rect,trim=rgb(0xc8c4b8),roof=rgb(0x4e4b46)
  const cx=x+5.7
  if(opts.sedan)parkedSedan(m,x-1.68,e-1.35,.035)
  gardenShed(m,x-2.85,z+.55,x-1.15,z+2.25,.035)
  // Gabled porch canopy with valley flashing, shingle slopes, shadowed soffit, and weathered putty bargeboard rake trim.
  m.quadAuto([cx-1.56,2.48,e-.08],[cx,3.06,e-.08],[cx,3.06,e-.26],[cx-1.56,2.48,e-.26],rgb(0x2e2b27),MAT.roof,id)
  m.quadAuto([cx,3.06,e-.08],[cx+1.56,2.48,e-.08],[cx+1.56,2.48,e-.26],[cx,3.06,e-.26],rgb(0x2e2b27),MAT.roof,id)
  m.quadAuto([cx-1.56,2.48,e+1.28],[cx,3.04,e+1.28],[cx,3.04,e-.12],[cx-1.56,2.48,e-.12],roof,MAT.roof,id)
  m.quadAuto([cx,3.04,e+1.28],[cx+1.56,2.48,e+1.28],[cx+1.56,2.48,e-.12],[cx,3.04,e-.12],roof,MAT.roof,id)
  m.box(cx-.06,3.01,e-.12,cx+.06,3.08,e+1.30,rgb(0x5c5850),MAT.roof,id,rgb(0x767168))
  m.facet([cx-1.46,2.48,e+1.18],[cx,2.98,e+1.18],[cx+1.46,2.48,e+1.18],rgb(0x362f26),MAT.roof,id)
  m.quadAuto([cx-1.58,2.44,e+1.30],[cx,3.01,e+1.30],[cx,3.08,e+1.26],[cx-1.58,2.51,e+1.26],rgb(0x888173),MAT.roof,id)
  m.quadAuto([cx,3.01,e+1.30],[cx+1.58,2.44,e+1.30],[cx+1.58,2.51,e+1.26],[cx,3.08,e+1.26],rgb(0x888173),MAT.roof,id)
  m.box(cx-1.52,2.40,e+1.08,cx+1.52,2.48,e+1.24,rgb(0x726b5e),MAT.roof,id)
  // Craftsman porch columns with brick/stone plinth pedestals, recessed shaft panels, capital collars & side balustrades.
  for(const [side, px] of [[-1, cx-1.24], [1, cx+1.24]] as const){
    m.box(px-.16,.025,e+.98,px+.16,.44,e+1.30,rgb(0x523226),MAT.brick)
    m.box(px-.18,.44,e+.96,px+.18,.50,e+1.32,rgb(0x645e53),MAT.lit)
    m.box(px-.11,.50,e+1.03,px+.11,2.40,e+1.25,rgb(0x867e6e),MAT.lit)
    m.box(px-.07,.58,e+1.251,px+.07,2.28,e+1.265,rgb(0x645d50),MAT.lit)
    m.box(px-.14,2.34,e+1.00,px+.14,2.42,e+1.28,rgb(0x746d5f),MAT.roof,id)
    // Side porch balustrade (west & east edges, z = e+.06 .. e+1.02)
    m.box(px-.05,.76,e+.04,px+.05,.82,e+1.03,rgb(0x6c6558),MAT.lit,0,rgb(0x7c7466))
    m.box(px-.04,.24,e+.04,px+.04,.29,e+1.03,rgb(0x585247),MAT.lit)
    for(let bz=e+.14;bz<=e+.96;bz+=.16){
      m.box(px-.022,.29,bz-.02,px+.022,.76,bz+.02,rgb(0x645e52),MAT.lit)
    }
    // Short front return balustrade wing framing the central 1.56m step opening
    const rx0 = side < 0 ? px + .11 : cx + .78
    const rx1 = side < 0 ? cx - .78 : px - .11
    m.box(rx0,.76,e+1.10,rx1,.82,e+1.18,rgb(0x6c6558),MAT.lit,0,rgb(0x7c7466))
    m.box(rx0,.24,e+1.11,rx1,.29,e+1.17,rgb(0x585247),MAT.lit)
    for(const bx of [rx0+.08,(rx0+rx1)/2,rx1-.08]){
      m.box(bx-.02,.29,e+1.12,bx+.02,.76,e+1.16,rgb(0x645e52),MAT.lit)
    }
    // Brick & stone step cheek wall flanking the front steps
    const cx0 = side < 0 ? px - .14 : cx + .74
    const cx1 = side < 0 ? cx - .74 : px + .14
    m.box(cx0,.025,e+1.28,cx1,.30,e+1.64,rgb(0x4c2e23),MAT.brick)
    m.box(cx0-.02,.30,e+1.26,cx1+.02,.35,e+1.66,rgb(0x5c564c),MAT.lit)
  }
  // Porch deck perimeter brick skirt + two-tier step risers & bullnose shadow lines leading to front walkway.
  m.box(x+4.46,.02,e+.02,cx-1.36,.132,e+1.28,rgb(0x4a2c22),MAT.brick)
  m.box(cx+1.36,.02,e+.02,x+7.04,.132,e+1.28,rgb(0x4a2c22),MAT.brick)
  m.box(cx-.74,.08,e+1.26,cx+.74,.131,e+1.32,rgb(0x22201c),MAT.lit)
  m.box(cx-.74,.04,e+1.44,cx+.74,.131,e+1.49,rgb(0x1e1c18),MAT.lit)
  m.box(cx-.74,.015,e+1.60,cx+.74,.131,e+1.65,rgb(0x24221e),MAT.lit)
  // Cast-iron wall mailbox with brass slot & sticking-out rolled flyer, plus house number plaque beside the door.
  m.box(cx+1.00,1.18,e+.01,cx+1.22,1.44,e+.11,rgb(0x24282e),MAT.lit,0,rgb(0x323840))
  m.box(cx+1.03,1.36,e+.11,cx+1.19,1.385,e+.125,rgb(0xa88a4e),MAT.shiny)
  m.box(cx+1.04,1.43,e+.03,cx+1.17,1.49,e+.09,rgb(0xb8ae98),MAT.lit)
  // House number plaque ("247" / "251") on left pilaster
  m.box(cx-.92,1.42,e+.01,cx-.74,1.54,e+.04,rgb(0x1f2226),MAT.lit)
  for(let d=0;d<3;d++)m.box(cx-.89+d*.05,1.45,e+.041,cx-.86+d*.05,1.51,e+.05,rgb(0xb89654),MAT.shiny)
  // Door casing, recessed jambs, moulded pediment lintel, interior bedroom doorway architrave & rubber-bordered coir mat.
  for(const px of [x+4.89,x+6.41]){
    m.box(px,.13,e-.25,px+.10,2.38,e+.08,rgb(0x787062),MAT.lit)
    m.box(px+.02,.13,e-.02,px+.08,2.34,e+.095,rgb(0x5c554a),MAT.lit)
    if(opts.interiorTrim)m.box(px,.13,z+5.46,px+.10,2.36,z+5.74,rgb(0x787060),MAT.lit)
  }
  m.box(x+4.86,2.30,e-.25,x+6.54,2.42,e+.09,rgb(0x787062),MAT.lit)
  m.box(x+4.84,2.41,e-.24,x+6.56,2.47,e+.12,rgb(0x5e584c),MAT.lit)
  if(opts.interiorTrim)m.box(x+4.86,2.28,z+5.46,x+6.54,2.40,z+5.74,rgb(0x787060),MAT.lit)
  m.box(x+5,.13,e-.28,x+6.4,.152,e+.18,rgb(0x524c40),MAT.lit)
  // Rubber-bordered coir welcome mat with scraper ribs
  m.box(cx-.54,.131,e+.18,cx+.54,.148,e+.74,rgb(0x1c1a17),MAT.lit)
  m.box(cx-.48,.134,e+.23,cx+.48,.154,e+.69,rgb(0x463320),MAT.timber)
  for(let rz=e+.28;rz<=e+.64;rz+=.09)m.box(cx-.44,.154,rz,cx+.44,.158,rz+.03,rgb(0x322416),MAT.timber)
  // Porch clutter: slatted wood crate, storage chest on left porch, terracotta planter, muddy boots, leaning broom & parcel box
  m.bevelBox(x+4.46,.13,e+.16,cx-.82,.78,e+.86,.025,rgb(0x4e3a26),rgb(0x624a32),MAT.timber,MAT.timber)
  m.yawBox(cx-1.02,e+.98,.36,.30,.13,.38,.18,rgb(0x58422c),MAT.timber,0,rgb(0x6a5036))
  m.prism(cx-.92,e+.52,.14,.11,.78,1.02,7,rgb(0x683a24),MAT.lit)
  m.box(cx-.68,.13,e+.22,cx-.58,.28,e+.34,rgb(0x22201c),MAT.lit)
  m.box(cx-.67,.13,e+.30,cx-.59,.19,e+.42,rgb(0x2a2722),MAT.lit)
  m.yawBox(cx+.96,e+.34,.36,.28,.13,.36,-.22,rgb(0x5e4830),MAT.timber,0,rgb(0x72583c))
  m.yawBox(cx+1.02,e+.76,.32,.26,.13,.48,.14,rgb(0x4c3a26),MAT.timber,0,rgb(0x5e4830))
  // Leaning porch broom against right wall beside door
  m.quadAuto([cx+.82,.13,e+.18],[cx+.85,.13,e+.18],[cx+.76,1.28,e+.03],[cx+.73,1.28,e+.03],rgb(0x5c462e),MAT.timber)
  m.box(cx+.76,.13,e+.14,cx+.90,.32,e+.23,rgb(0x6e5a38),MAT.timber)
  for(const px of [x+.08,r-.14]){
    m.box(px,.12,e+.1,px+.07,2.77,e+.17,trim,MAT.timber)
    m.box(px,.1,e+.15,px+.07,.17,e+.5,trim,MAT.timber)
  }
  for(const px of [x,r-.10])m.box(px,.28,e-.015,px+.10,2.68,e+.025,rgb(0x787368),MAT.lit)
  // Louvered exterior window shutters, crawlspace foundation vents, utility meter & decay-driven repairs/barricades
  const decay = opts.decay ?? resolveHouseDecay(town, id)
  const shutterCol = rgb(0x202a27), slatCol = rgb(0x161d1b)
  for (const [winIdx, [wx0, wx1]] of (opts.windows ?? [[x + 1.5, x + 3.5], [r - 4.0, r - 1.5]]).entries()) {
    for (const [sideIdx, sx] of [[-1, wx0 - .36], [1, wx1 + .04]] as const) {
      const crooked = decay >= 2 && winIdx === 0 && sideIdx === 1
      const dy = crooked ? -.05 : 0
      m.box(sx, .82 + dy, e + .008, sx + .32, 2.18 + dy, e + .048, shutterCol, MAT.lit)
      for (let sy = .92 + dy; sy <= 2.08 + dy; sy += .14) {
        m.box(sx + .04, sy, e + .049, sx + .28, sy + .05, e + .062, slatCol, MAT.lit)
      }
    }
    // Cast-iron foundation crawlspace vent grate below each front window
    const vmx = (wx0 + wx1) / 2
    m.box(vmx - .22, .11, e + .025, vmx + .22, .27, e + .048, rgb(0x171a1e), MAT.lit)
    // Weathered water-stain drip streaks below window sill corners
    if (archSettings.weathering > 0.2) {
      for (const cxW of [wx0 + .06, wx1 - .06]) {
        m.box(cxW - .05, .36, e + .003, cxW + .05, .74, e + .012, rgb(0x46423a), MAT.lit)
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
}

/** Foundation shrubs around a house façade, anchored to its west corner, front door and east corner. */
const FOUNDATION_BUSHES: readonly (readonly ["x" | "door" | "r", number, number, number, number])[] = [
  // Left corner bush cluster wrapping around the corner by the driveway sedan
  ["x", -.24, -.35, 1.24, .82],
  ["x", .28, .56, 1.18, .80],
  ["x", .88, .96, .68, .56],
  // Irregular low-to-mid bushes under the left window (below 0.85m sill) + taller bush flanking the left porch column
  ["x", 1.52, .46, .72, .58],
  ["x", 2.28, .78, .54, .48],
  ["x", 2.95, .44, .66, .54],
  ["door", -1.88, .58, 1.08, .72],
  // Taller bush flanking the right porch column + irregular overgrown shrubs under the right window
  ["door", 1.78, .56, 1.12, .74],
  ["r", -6.52, .52, .94, .66],
  ["r", -5.72, .84, .58, .50],
  ["r", -4.95, .44, .68, .56],
  ["r", -4.08, .78, .56, .48],
  ["r", -3.35, .48, .74, .58],
  // Front-right corner hydrangea thicket
  ["r", -1.08, .62, 1.16, .84],
  ["r", -.22, 1.02, .76, .62],
]

/**
 * Overgrown, irregular foundation hedge & bramble thicket: organic soil discs (no straight rectangular bed) and
 * multi-height sprawling shrubs keeping window sills & porch columns clear while spilling wild weeds onto the lawn,
 * then the framing woodland, driveway hedge and street trees. Bushes are anchored to the west corner, the front door
 * and the east corner, so on a narrower façade those that would block the door are dropped and those in front of a
 * window stay under its sill. `keep` vetoes framing plants that would leave the lot.
 */
export function housePlanting(m:Mesh,b:Building,id:number,town:Town,opts:HousePlantingOptions={}) {
  const [x,z,r,e]=b.rect
  const doorX=opts.doorX ?? x+5, cx=doorX+.7
  const put=opts.plant ?? plant
  const keep=opts.keep ?? (() => true)
  const rng=new Rng(opts.seed ?? town.houseSeed+id*71)
  const kept:[number,number,number][]=[]
  let hydrangea=false
  for(const [anchor,dx,dz,h0,pr] of FOUNDATION_BUSHES){
    const px=(anchor==="x"?x:anchor==="r"?r:cx)+dx, pz=e+dz
    const seed=Math.floor(rng.next()*1e6)
    if(anchor!=="door"&&Math.abs(px-cx)<1.5)continue
    if(px<x-.5||px>r+.5||kept.some(([qx,qz,qr])=>Math.hypot(px-qx,pz-qz)<(pr+qr)*.45))continue
    const underSill=opts.windows?.some(([w0,w1])=>px>w0-.1&&px<w1+.1)
    const ph=underSill?Math.min(h0,.78):h0
    kept.push([px,pz,pr])
    if(anchor==="r"&&dx===-1.08)hydrangea=true
    const gy=supportHeight(town,px,pz)
    m.prism(px,pz,pr*1.05,pr*.95,gy+.006,gy+.018,7,rgb(0x14180f),MAT.ground,5)
    put(m,px,pz,ph,pr,seed,gy)
  }
  // Subtle, short, matted olive-ochre weed & turf tufts along the front margin of the foundation bushes
  for(let wx=x-.1;wx<=r+.1;wx+=.58+rng.next()*.42){
    if(wx>doorX-.85&&wx<doorX+2.15)continue
    const wz=e+.72+rng.next()*.68
    const gy=supportHeight(town,wx,wz)
    emitGrassTuft(m,wx,gy,wz,{
      bladeCount:3,
      radius:.16+rng.next()*.08,
      height:.11+rng.next()*.09,
      width:foliageSettings.bladeWidth*.88,
      curvature:Math.min(1,foliageSettings.bladeCurvature*1.15),
      leanAngle:Math.PI*.5+(rng.next()-.5)*1.4,
      rootColor:rgb(0x1c1e12),
      tipColor:rgb(rng.pick([0x3e3c24,0x484226,0x343820])),
      rng,
    })
  }
  // Delicate creamy-white blossom flecks on the front-right corner bush
  if(hydrangea)emitHydrangeaPanicles(m,r-1.08,supportHeight(town,r-1.08,e+.62),e+.62,1.16,.84,(opts.seed ?? town.houseSeed)+31)
  // Framing woodland & street trees + irregular driveway fence hedge matching target-sodium70s-street & target-sodium70s-open.
  for(const [px,pz,ph,pr] of [
    // Overgrown border hedge along the left driveway picket fence + overarching left woodland canopies
    [x-3.58,e+2.05,1.48,.96],
    [x-3.52,e+.55,1.42,.90],
    [x-3.55,e-.95,1.38,.86],
    [x-3.65,e-2.65,1.34,.82],
    [x-3.60,z+3.20,1.38,.86],
    [x-5.45,e+.60,6.80,3.10],
    [x-5.15,e-3.60,7.20,3.25],
    [x-4.80,z+3.20,6.60,2.95],
    // Right yard street tree & corner bush (keeping the north-south sidewalk x=38..40 open under the sodium streetlamp)
    [r+.52,e-2.40,5.80,2.35],
    [r+.52,e+.42,1.44,.92],
    [r+.48,e+1.65,1.38,.88],
    [r+1.82,e+3.05,1.52,1.04],
    [r-.45,e+1.95,.98,.68],
    // South-side street corner framing trees across the road (leaving south sidewalk & verge open)
    ...(opts.streetTrees ? [
      [x-5.40,e+14.50,6.80,3.05],
      [x-3.50,e+14.80,1.48,.98],
      [r+4.40,e+14.60,6.80,3.05],
      [r+2.80,e+14.80,1.46,.96],
    ] as const : []),
  ]){
    if(keep(px!,pz!,ph!,pr!))put(m,px!,pz!,ph!,pr!,town.houseSeed+Math.floor(pz!*43+px!*17),supportHeight(town,px!,pz!))
  }
}

/** Procedural bungalow over authoritative room and opening boundaries. */
export function house(m:Mesh,b:Building,id:number,town:Town) {
  const [x,z,r,e]=b.rect,mid=(z+e)/2,ridge=4.35+(town.houseSeed%3)*.12
  const trim=rgb(0xc8c4b8),roof=rgb(0x4e4b46),eaveTrim=rgb(0x524e47),gutterMetal=rgb(0x625d54),gutterDark=rgb(0x1c1a17)
  // Baked procedural rugs and the building's seeded interior theme (wainscoting, portraits, clock, fireplace).
  emitBuildingRugs(m,b,town)
  emitInteriorDecor(m,b,town)
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
  // Stepped north-east shingle roof wing (x+9.45 .. r-1.50, z+1.45 .. z+5.55) + exterior NE back-stoop alcove with wooden storage chest
  m.quadAuto([x+9.45, 3.46, z+5.55], [r-1.50, 3.46, z+5.55], [r-1.50, 2.84, z+1.45], [x+9.45, 2.84, z+1.45], roof, MAT.roof, id)
  m.quadAuto([r-1.55, slopeY(mid), mid], [r+.42, slopeY(mid), mid], [r+.42, 2.84, z+5.12], [r-1.55, 2.84, z+5.12], roof, MAT.roof, id)
  m.box(x+9.45, 2.70, z+1.38, r-1.45, 2.85, z+1.50, eaveTrim, MAT.roof, id)
  m.box(r-1.58, 2.70, z+1.38, r-1.46, 2.86, z+5.18, eaveTrim, MAT.roof, id)
  m.box(r-1.55, 2.70, z+5.08, r+.45, 2.85, z+5.20, eaveTrim, MAT.roof, id)
  // NE back-stoop clapboard alcove & weathered wooden storage chest (matching target-sodium70s-open top-right)
  m.bevelBox(r-1.42, .13, z+3.55, r-.32, .88, z+4.95, .03, rgb(0x5a4028), rgb(0x6e4e32), MAT.timber, MAT.timber)
  // Gable end triangles + stepped rake bargeboards
  for(const px of [x-.01,r+.01])m.facet([px,2.8,z+5.5],[px,ridge,mid],[px,2.8,e],rgb(b.color),MAT.roof,id)
  for(const [rx0,rx1] of [[x-.46,x-.36],[r+.36,r+.46]] as const){
    m.quadAuto([rx0,2.84,e+.44],[rx1,2.84,e+.44],[rx1,ridge+.03,mid],[rx0,ridge+.03,mid],rgb(0x625d54),MAT.roof,id)
    m.quadAuto([rx0,ridge+.03,mid],[rx1,ridge+.03,mid],[rx1,2.84,z+5.45],[rx0,2.84,z+5.45],rgb(0x545048),MAT.roof,id)
  }
  m.box(x+1.75,2.68,z-.42,x+9.78,2.84,z-.31,eaveTrim,MAT.roof,id)
  // Split south eave fascia, deep soffit shadow, half-round metal gutter with dark interior channel + brackets, and overlapping ridge cap tiles.
  for (let xi = 0; xi < 3; xi++) {
    const x0 = xCutsFront[xi]!, x1 = xCutsFront[xi + 1]!
    m.box(x0, 2.71, e+.34, x1, 2.85, e+.43, eaveTrim, MAT.roof, id)
    m.box(x0, 2.58, e+.01, x1, 2.70, e+.39, rgb(0x1c1916), MAT.roof, id)
    m.box(x0, 2.74, e+.42, x1, 2.81, e+.51, gutterMetal, MAT.roof, id)
    m.box(x0, 2.811, e+.43, x1, 2.825, e+.49, gutterDark, MAT.roof, id)
    m.box(x0, 2.79, e+.50, x1, 2.835, e+.525, rgb(0x7c766b), MAT.roof, id)
    // Overlapping saddle ridge-cap tiles with warm-slate top bevel
    let rx = x0
    let capIdx = 0
    while (rx < x1 - .02) {
      const nx = Math.min(x1, rx + .38)
      const capCol = capIdx % 2 === 0 ? rgb(0x5c5850) : rgb(0x4e4b44)
      m.box(rx, ridge - .03, mid - .12, nx, ridge + .045, mid + .12, capCol, MAT.roof, id, rgb(0x767168))
      rx = nx
      capIdx++
    }
  }
  for (let gx = x - .30; gx <= r + .30; gx += 1.15) {
    m.box(gx - .02, 2.73, e + .41, gx + .02, 2.84, e + .53, rgb(0x36332e), MAT.roof, id)
  }
  // Roof plumbing vent stacks & low-profile metal box louver attic vent
  for (const [vx, vz] of [[x + 3.4, mid + 1.15], [x + 8.1, mid - 1.05]] as const) {
    const vy = slopeY(vz) - .04
    m.box(vx - .14, vy, vz - .14, vx + .14, vy + .05, vz + .14, rgb(0x36332e), MAT.roof, id)
    m.prism(vx, vz, .055, .052, vy + .04, vy + .38, 6, rgb(0x58544c), MAT.roof, id)
    m.prism(vx, vz, .042, .042, vy + .38, vy + .395, 6, rgb(0x161412), MAT.roof, id)
  }
  {
    const ax = x + 5.8, az = mid - 1.35, ay = slopeY(az) - .03
    m.box(ax - .26, ay, az - .20, ax + .26, ay + .11, az + .20, rgb(0x46423c), MAT.roof, id, rgb(0x645f56))
    m.box(ax - .22, ay + .02, az - .21, ax + .22, ay + .08, az + .21, rgb(0x1e1c19), MAT.roof, id)
  }
  // Weathered brick chimney on upper-right slope with lead step-flashing, corbelled brick crown, stone cap & dark rectangular flue
  const chY0 = slopeY(mid + 1.3) - .18
  m.box(r-2.15,chY0,mid+.75,r-1.05,chY0+.22,mid+1.85,rgb(0x38342e),MAT.roof,id)
  m.box(r-2.08,3.18,mid+.82,r-1.12,4.72,mid+1.78,rgb(0x684536),MAT.brick,id)
  m.box(r-2.13,4.64,mid+.77,r-1.07,4.75,mid+1.83,rgb(0x583a2d),MAT.brick,id)
  m.box(r-2.17,4.75,mid+.73,r-1.03,4.86,mid+1.87,rgb(0x6c675d),MAT.roof,id,rgb(0x787266))
  m.box(r-1.90,4.86,mid+1.00,r-1.30,4.91,mid+1.60,rgb(0x161513),MAT.roof,id)
  // Dual metal downspouts at west & east front corners with gooseneck elbows and wall straps
  for (const [dx, side] of [[x + .04, -1], [r - .06, 1]] as const) {
    m.box(dx - .04, .14, e - .02, dx + .04, 2.74, e + .06, gutterMetal, MAT.lit)
    m.box(dx - .045, 2.58, e + .04, dx + .045, 2.76, e + .44, gutterMetal, MAT.roof, id)
    for (const sy of [.65, 1.45, 2.25]) m.box(dx - .05, sy, e - .025, dx + .05, sy + .04, e + .07, rgb(0x36332e), MAT.lit)
    m.box(dx - .04, .08, e + .02, dx + .04, .18, e + .26 + (side < 0 ? .04 : 0), gutterMetal, MAT.lit)
  }
  houseFrontage(m,b,id,town,{sedan:true,interiorTrim:true})
  housePlanting(m,b,id,town,{streetTrees:id===0})
  const decay = resolveHouseDecay(town, id)
  // Living room east media console, flatscreen TV, partition stub, and flanking potted houseplants
  m.box(x+4.86,.13,e-3.62,x+5.06,2.78,e-1.38,rgb(b.color),MAT.wall,20,rgb(0x4a4338))
  m.box(x+4.89,2.78,e-3.59,x+5.03,2.80,e-1.41,rgb(0x28231d),MAT.lit)
  m.bevelBox(x+4.44,.13,e-3.55,x+4.85,.62,e-1.45,.03,rgb(0x4a3624),rgb(0x5c442e),MAT.timber,MAT.timber)
  m.box(x+4.58,.62,e-2.85,x+4.72,.70,e-2.15,rgb(0x1a1e22))
  m.box(x+4.61,.70,e-3.20,x+4.70,1.38,e-1.80,rgb(0x14171c),MAT.shiny)
  for(const pz of [e-3.88,e-1.12]){
    m.prism(x+4.68,pz,.16,.12,.13,.42,7,rgb(0x633a28))
    plant(m,x+4.68,pz,.55,.32,town.houseSeed+Math.floor(pz*31),.38)
  }
  // North-wall kitchen run: 1970s harvest-almond refrigerator, warm-lit 4-pane window over double sink, honey-walnut cabinets, microwave & stove
  const kz=z+5.72
  const kLamp=Math.max(0,town.lamps.findIndex(l=>l.kind==="room"&&l.x>x+7&&l.x<r&&l.y>z+5.5&&l.y<e))
  const lLamp=Math.max(0,town.lamps.findIndex(l=>l.kind==="room"&&l.x>x&&l.x<x+5&&l.y>z+5.5&&l.y<e))
  // 1970s harvest-almond / warm-putty refrigerator with freezer seam, handles & magnet notes
  m.bevelBox(r-5.95,.13,kz,r-5.05,1.88,kz+.72,.03,rgb(0x7c715c),rgb(0x8a7e68))
  m.box(r-5.96,1.32,kz+.71,r-5.04,1.35,kz+.74,rgb(0x3a352c))
  m.box(r-5.16,.82,kz+.72,r-5.12,1.24,kz+.76,rgb(0x9a907c),MAT.shiny)
  m.box(r-5.16,1.40,kz+.72,r-5.12,1.72,kz+.76,rgb(0x9a907c),MAT.shiny)
  m.box(r-5.72,1.46,kz+.721,r-5.54,1.60,kz+.728,rgb(0xb2a890),MAT.lit)
  m.box(r-5.46,1.02,kz+.721,r-5.30,1.16,kz+.728,rgb(0x9e7e58),MAT.lit)
  // Honey-walnut base cabinets & warm sandstone/butcher-block countertop with stainless double sink
  m.box(r-5.00,.13,kz,r-2.25,.90,kz+.64,rgb(0x5e4228),MAT.timber)
  m.box(r-5.02,.90,kz-.01,r-2.23,.96,kz+.67,rgb(0x82745e),MAT.lit)
  for(let i=0;i<4;i++)m.box(r-4.92+i*.66,.20,kz+.64,r-4.34+i*.66,.84,kz+.66,rgb(0x725234),MAT.timber)
  m.box(r-4.18,.961,kz+.10,r-3.12,.972,kz+.54,rgb(0x6e7472),MAT.shiny)
  for(const sx of [r-4.10,r-3.60])m.box(sx,.973,kz+.15,sx+.42,.982,kz+.48,rgb(0x282e2e),MAT.shiny)
  m.box(r-3.67,.97,kz+.05,r-3.61,1.18,kz+.12,rgb(0x949a98),MAT.shiny)
  // 1970s countertop microwave on right end of counter + cutting board on left
  m.bevelBox(r-2.96,.96,kz+.08,r-2.32,1.32,kz+.52,.02,rgb(0x685e4e),rgb(0x786d5b),MAT.lit,MAT.lit)
  m.box(r-2.90,1.01,kz+.52,r-2.48,1.26,kz+.535,rgb(0x1e201e),MAT.shiny)
  m.yawBox(r-4.62,kz+.36,.34,.24,.96,.985,.12,rgb(0x7c5c3c),MAT.timber)
  // Range stove on right of north counter
  m.box(r-2.22,.13,kz,r-1.38,.94,kz+.68,rgb(0x5c564a))
  m.box(r-2.23,.94,kz-.01,r-1.37,.965,kz+.69,rgb(0x262826))
  for(const dx of [-.22,.22])for(const dz of [.18,.48])m.prism(r-1.80+dx,kz+dz,.11,.11,.966,.982,8,rgb(0x161818))
  m.prism(r-2.02,kz+.48,.13,.11,.98,1.05,8,rgb(0x222424),MAT.lit)
  m.prism(r-1.58,kz+.18,.09,.07,.98,1.10,7,rgb(0x7c4e2e),MAT.shiny)
  m.box(r-2.12,.26,kz+.68,r-1.48,.76,kz+.70,rgb(0x1c1e1e),MAT.shiny)
  // Warm-lit 4-pane kitchen window / backlit pass-through above the double sink (softly shaded tungsten panes without clipping)
  m.box(r-5.00,.96,kz,r-1.38,1.68,kz+.04,rgb(0x5e5444),MAT.lit)
  m.box(r-4.36,1.02,kz+.02,r-2.94,2.24,kz+.18,rgb(0x6e5034),MAT.timber)
  m.box(r-4.38,.98,kz+.04,r-2.92,1.06,kz+.28,rgb(0x886844),MAT.timber)
  m.box(r-4.26,1.08,kz+.15,r-3.04,1.60,kz+.21,rgb(0x8e5214),MAT.lamp,kLamp)
  m.box(r-4.26,1.62,kz+.15,r-3.04,2.14,kz+.21,rgb(0x6c3c0e),MAT.lamp,kLamp)
  for(const [cx0,cx1] of [[r-4.26,r-4.08],[r-3.22,r-3.04]] as const){
    m.box(cx0,1.08,kz+.211,cx1,2.14,kz+.225,rgb(0x4a2c10),MAT.lamp,kLamp)
  }
  m.box(r-3.68,1.08,kz+.212,r-3.62,2.14,kz+.245,rgb(0x4e3620),MAT.timber)
  m.box(r-4.26,1.58,kz+.212,r-3.04,1.64,kz+.245,rgb(0x4e3620),MAT.timber)
  m.box(r-5.00,1.68,kz+.06,r-4.38,1.72,kz+.24,rgb(0x985c1c),MAT.lamp,kLamp)
  m.box(r-2.92,1.68,kz+.06,r-2.32,1.72,kz+.24,rgb(0x985c1c),MAT.lamp,kLamp)
  m.box(r-5.00,1.72,kz,r-4.36,2.38,kz+.38,rgb(0x684a2e),MAT.timber)
  m.box(r-2.94,1.72,kz,r-1.38,2.38,kz+.38,rgb(0x684a2e),MAT.timber)
  for(let i=0;i<2;i++)m.box(r-2.88+i*.74,1.76,kz+.38,r-2.22+i*.74,2.32,kz+.40,rgb(0x7c5a3a),MAT.timber)
  // Warm-lit west living-room window behind the sofa (matching target-sodium70s-open left wall)
  m.box(x+.20,.88,e-2.95,x+.28,2.12,e-1.45,rgb(0x685238),MAT.timber)
  m.box(x+.22,.96,e-2.85,x+.26,2.04,e-1.55,rgb(0x8e5218),MAT.lamp,lLamp)
  m.box(x+.261,.96,e-2.23,x+.285,2.04,e-2.17,rgb(0x5c442c),MAT.timber)
  m.box(x+.261,1.48,e-2.85,x+.285,1.53,e-1.55,rgb(0x5c442c),MAT.timber)
  // Living room corner table lamp on the sofa end table (x+1.1, e-.62)
  m.prism(x+1.10,e-.62,.03,.025,.66,.92,6,rgb(0x4a3c2a))
  m.prism(x+1.10,e-.62,.21,.12,.90,1.16,9,rgb(0xc89248),MAT.lamp,lLamp)
  m.prism(x+1.10,e-.62,.17,.17,.89,.90,9,rgb(0xe2b46e),MAT.lamp,lLamp)
  // Bedroom north-wall shelf above headboard, second nightstand between bed & dresser, and framed hall print
  m.box(x+3.15,1.88,z+.22,x+4.35,1.94,z+.34,rgb(0x48321e),MAT.timber)
  m.bevelBox(x+5.05,.13,z+.68,x+5.68,.68,z+1.24,.02,rgb(0x583e26),rgb(0x6c4c30),MAT.timber,MAT.timber)
  m.box(x+5.12,.22,z+1.24,x+5.61,.60,z+1.26,rgb(0x785638),MAT.timber)
  // Framed landscape print on living room north wall to the left of the bedroom doorway
  m.box(x+3.88,1.58,z+5.71,x+4.52,2.02,z+5.76,rgb(0x6e6656),MAT.lit)
  m.box(x+3.95,1.64,z+5.761,x+4.45,1.96,z+5.77,rgb(0x3a3830),MAT.lit)
  // Potted plant in bedroom top-right corner beside the dresser
  m.prism(x+8.95,z+1.05,.17,.13,.13,.44,7,rgb(0x633b28))
  plant(m,x+8.95,z+1.05,.62,.36,town.houseSeed+91,.40)
  // Lived-in & ransacked survival-horror interior clutter (scaled by archSettings.clutterDensity & decay state)
  const density = archSettings.clutterDensity
  if (density > 0.05) {
    const cRng = new Rng(((town.houseSeed ^ (archSettings.clutterSeed * 2654435761)) + id * 1013) >>> 0)
    const isRansacked = decay >= 3
    // 1. Bedroom clutter: fallen books by nightstand, rumpled clothes by dresser
    m.yawBox(x+2.62,z+2.15,.26,.20,.132,.175,.42,rgb(0x786a52),MAT.lit,0,rgb(0x92846c))
    m.yawBox(x+2.85,z+2.42,.24,.18,.132,.168,-.35,rgb(0x68382a),MAT.lit,0,rgb(0x824838))
    m.yawBox(x+6.95,z+1.62,.42,.32,.132,.21,.62,rgb(0x4e463a),MAT.lit,0,rgb(0x62584a))
    // 2. Entry hallway & living room clutter: baskets/boxes along hallway north wall, fallen books by bookcase
    m.yawBox(x+6.82,z+5.96,.42,.32,.13,.34,.18,rgb(0x6e583e),MAT.timber,0,rgb(0x82684a))
    m.yawBox(x+7.58,z+5.98,.46,.36,.13,.38,-.14,rgb(0x5c4832),MAT.timber,0,rgb(0x70583e))
    m.prism(x+8.22,z+6.02,.18,.15,.13,.48,7,rgb(0x685238),MAT.timber)
    m.yawBox(x+2.38,z+6.12,.44,.38,.13,.46,-.18,rgb(0x685036),MAT.timber,0,rgb(0x7c6042))
    // Fallen books & magazines in front of the living room bookcase and beside coffee table
    for (const [bx, bz, byaw, bcol] of [
      [x+1.18, z+6.82, .38, 0x723c2c],
      [x+1.52, z+6.94, -.52, 0x485a52],
      [x+1.84, z+6.78, .21, 0x786c54],
      [x+1.35, z+7.22, -.28, 0x8a7e66],
    ] as const) {
      m.yawBox(bx, bz, .26, .20, .148, .185, byaw, rgb(bcol), MAT.lit, 0, rgb(0x988e78))
    }
    // Scattered letters & flyers near the front door and bookcase (keeping central hall wood planks clean)
    const paperCount = Math.min(8, Math.round((isRansacked ? 5 : 3) * density))
    for (let p = 0; p < paperCount; p++) {
      const px = x + 4.5 + cRng.next() * 1.8
      const pz = e - 1.6 + cRng.next() * 1.1
      const pyaw = (cRng.next() - 0.5) * 3.14
      const pcol = cRng.pick([0x9c927e, 0x8a806c, 0xa89e88])
      m.yawBox(px, pz, .22 + cRng.next() * .06, .16 + cRng.next() * .05, .133, .137, pyaw, rgb(pcol), MAT.lit)
    }
    // 3. Kitchen & dining room clutter: extra chair & corner storage box
    m.yawBox(r - 3.98, e - 2.85, .48, .48, .13, .54, .18, rgb(0x5c4228), MAT.timber, 0, rgb(0x6e5032))
    m.yawBox(r - 4.16, e - 2.85, .10, .48, .54, .98, .18, rgb(0x64482c), MAT.timber)
    m.yawBox(r - 1.12, e - .68, .46, .38, .13, .48, -.24, rgb(0x685036), MAT.timber, 0, rgb(0x7c6042))
  }
  // East-wall upper cupboards and framed art prints (MAT.lit/MAT.timber so they stay in fast fsSolid pipeline)
  m.box(r-.245,1.02,e-3.2,r-.23,1.67,e-.85,rgb(0x464d44),MAT.lit)
  m.box(r-.60,1.78,e-3.2,r-.25,2.37,e-1.2,rgb(0x4a3826),MAT.timber)
  for(let i=0;i<3;i++)m.box(r-.62,1.82,e-3.15+i*.64,r-.60,2.33,e-2.56+i*.64,rgb(0x5c4630),MAT.timber)
  // Radiator fins & framed paintings on bedroom north wall, living room west wall, and kitchen south wall
  for(let i=0;i<6;i++)m.box(x+5.4+i*.13,.3,z+.25,x+5.48+i*.13,.85,z+.42,rgb(0x5c5c52),MAT.lit)
  for(const [px,pz] of [[x+3.85,z+.23],[x+7.85,z+.23],[r-3,e-.27]]){
    m.box(px!-.52,1.28,pz!,px!+.52,1.98,pz!+.055,rgb(0x3a2c1e),MAT.lit)
    m.box(px!-.43,1.37,pz!+.056,px!+.43,1.89,pz!+.062,rgb(0x5e5a4b),MAT.lit)
  }
  for(const [py,pz] of [[1.32,e-2.6],[1.32,e-1.2]]){
    m.box(x+.22,py!,pz!-.44,x+.27,py!+.64,pz!+.44,rgb(0x3a2c1e),MAT.lit)
    m.box(x+.271,py!+.08,pz!-.36,x+.28,py!+.56,pz!+.36,rgb(0x5e5848),MAT.lit)
  }
  for(const barrier of town.barriers){
    const [a,c,d,f]=barrier.rect
    if(a<x||d>r||c<z||f>e||barrier.kind==="fence")continue
    m.box(a-.032,.025,c-.032,d+.032,.33,f+.032,rgb(0x523027),MAT.brick)
    m.box(a-.036,.33,c-.036,d+.036,.37,f+.036,rgb(0x6e685d),MAT.lit)
  }
}
