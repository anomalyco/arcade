import { Rng } from "@arcade/kit/sim/rng"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"

export const CHUNK = 32
export const SIZE = CHUNK * 3
export type Barrier = { rect: Rect; kind: "wall" | "window" | "fence"; color: number }
/** `keyed` doors start locked and open only with a key or a crowbar. */
export type Door = { id: string; rect: Rect; open: boolean; locked?: boolean; keyed?: boolean }
export type WindowOpening = { id: string; buildingId: string; buildingIndex: number; rect: Rect; open: boolean; openable: boolean }
export type Building = {
  id: string
  kind: "house" | "hardware" | "pharmacy"
  archetype?: string
  district?: string
  rect: Rect
  color: number
  footprint?: readonly Rect[]
  chunkKey?: string
}
export type Prop = { x: number; y: number; kind: "bed" | "sofa" | "table" | "shelf" | "tree" | "coffee" | "counter" | "fridge" | "dresser" | "chair" | "nightstand" | "stove" | "workbench" | "stash"; variant: number }
export type Lamp = { x: number; y: number; h: number; radius: number; power: number; kind: "street" | "porch" | "room" | "window" }
export type Town = {
  seed: number
  houseSeed: number
  terrain: number
  foliageDensity: number
  chunks: Rect[]
  buildings: Building[]
  barriers: Barrier[]
  doors: Door[]
  windows: WindowOpening[]
  props: Prop[]
  lamps: Lamp[]
  vehicles?: Rect[]
  worldBounds?: Rect
  windowOrigin?: readonly [number, number]
  activeChunkKeys?: string[]
}

/** One footprint source for geometry, collision, roof cutaways and room memory. */
export const BUILDING_RECTS = [[22,24,37,35.5],[21,54,36,65.5],[53,23,73,38],[53,54,72,68]] as const
/** Authoritative collision footprints for parked driveway sedans and abandoned street vehicles. */
export const EXTERIOR_VEHICLE_COLLIDERS: readonly Rect[] = [
  [19.45, 32.10, 21.20, 36.20], // Ash driveway sedan
  [18.45, 62.10, 20.20, 66.20], // Elm driveway sedan
  [10.25, 45.25, 14.15, 47.25], // West street abandoned sedan
  [53.45, 40.35, 57.35, 42.35], // East street (hardware frontage) abandoned coupe
  [45.45, 56.55, 47.45, 60.45], // South avenue abandoned sedan
  [40.55, 15.85, 42.55, 19.75], // North avenue abandoned cruiser
]
export const frontageEnd = (b: Building) => b.kind === "house" ? b.rect[3] + 2.5 : b.rect[3]
/** Authoritative union-of-rects floor footprint: houses have an L-shaped plan (stepped-in north bedroom block + stepped north-east wing + full-width south block). */
export function buildingFootprint(b: Building): readonly Rect[] {
  if (b.footprint) return b.footprint
  const [x, z, r, e] = b.rect
  return b.kind === "house" ? [[x, z + 5.5, r, e], [x + 2, z, x + 9.5, z + 5.5], [x + 9.5, z + 1.5, r, z + 5.5]] : [b.rect]
}
export function inBuildingFootprint(b: Building, px: number, pz: number): boolean {
  for (const [x0, z0, x1, z1] of buildingFootprint(b)) {
    if (px >= x0 && px <= x1 && pz >= z0 && pz <= z1) return true
  }
  return false
}
export function propShape(p: Prop): { rect: Rect; height: number } | undefined {
  const shapes = {bed:[1.72,2.6,1],sofa:[1.2,2.6,1.1],table:[1.5,1,.82],shelf:[1.7,.8,1.8],coffee:[1.1,1.5,.52],counter:[.8,2.4,1.02],fridge:[.8,.9,1.9],dresser:[2.2,.7,1.1],chair:[.55,.55,1.05],nightstand:[.55,.55,.65],stove:[.75,.8,.95],workbench:[.7,1.6,.95],stash:[.6,.9,1.25]} as const
  if(p.kind==="tree") return undefined
  const [w,d,h]=shapes[p.kind]
  return {rect:[p.x-w/2,p.y-d/2,p.x+w/2,p.y+d/2],height:h}
}

/** Fixed street topology; seeded house palettes, trees and shelf stock. All dimensions are metres. */
export function makeTown(seed: number, houseSeed = seed, terrain = .22, foliageDensity = 1): Town {
  const rng = new Rng(seed)
  const houses = new Rng(houseSeed)
  const town: Town = { seed, houseSeed, terrain, foliageDensity, chunks: [], buildings: [], barriers: [], doors: [], windows: [], props: [], lamps: [] }
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) town.chunks.push([x * CHUNK, y * CHUNK, (x + 1) * CHUNK, (y + 1) * CHUNK])
  const wall = (rect: Rect, color: number, kind: Barrier["kind"] = "wall") => town.barriers.push({ rect, color, kind })
  const building = (id: string, kind: Building["kind"], rect: Rect) => {
    const [x, y, r, b] = rect
    const buildingIndex = town.buildings.length
    const color = kind === "house" ? houses.pick([0xb3afa0, 0x899d95, 0xb4a181, 0x9caaa9]) : kind === "hardware" ? 0x8e7564 : 0x718b82
    town.buildings.push({ id, kind, rect, color })
    const addWindow = (winId: string, wRect: Rect, openable = true) => {
      wall(wRect, color, "window")
      town.windows.push({ id: `${id}-${winId}`, buildingId: id, buildingIndex, rect: wRect, open: false, openable })
    }
    const doorX = x + 5, split = y + 5.5
    wall([x, b - .22, x + 1.5, b], color)
    addWindow("south-west", [x + 1.5, b - .22, x + 3.5, b], kind === "house")
    wall([x + 3.5, b - .22, doorX, b], color)
    town.doors.push({ id: `${id}-front`, rect: [doorX, b - .22, doorX + 1.4, b], open: false })
    wall([doorX + 1.4, b - .22, r - 4, b], color)
    addWindow("south-east", [r - 4, b - .22, r - 1.5, b], kind === "house")
    wall([r - 1.5, b - .22, r, b], color)
    if (kind === "house") {
      // L-shaped house plan: stepped-in north bedroom block [x+2..x+9.5, y..split] + stepped north-east wing + full-width south block [x..r, split..b]
      const bx0 = x + 2, bx1 = x + 9.5
      wall([bx0, y, bx1, y + .22], color)
      wall([bx0, y, bx0 + .22, split], color)
      wall([bx1 - .22, y, bx1, split], color)
      wall([bx1, y + 1.5, r, y + 1.72], color)
      wall([x, split, bx0 + .22, split + .2], color)
      wall([bx0 + .22, split, doorX, split + .2], color)
      town.doors.push({ id: `${id}-room`, rect: [doorX, split, doorX + 1.4, split + .2], open: false })
      wall([doorX + 1.4, split, bx1, split + .2], color)
      wall([bx1 - .22, split, r - .22, split + .22], color)
      wall([x, split, x + .22, b], color)
      wall([r - .22, y + 1.5, r, y + 4], color)
      addWindow("east", [r - .22, y + 4, r, y + 6.5], true)
      wall([r - .22, y + 6.5, r, b], color)
    } else {
      wall([x, y, r, y + .22], color)
      wall([x, y, x + .22, b], color)
      wall([r - .22, y, r, y + 4], color)
      addWindow("east", [r - .22, y + 4, r, y + 6.5], true)
      wall([r - .22, y + 6.5, r, b], color)
      wall([x, split, doorX, split + .2], color)
      // Stores keep their back room locked: a key or a crowbar gets you to the parts on its shelves.
      town.doors.push({ id: `${id}-room`, rect: [doorX, split, doorX + 1.4, split + .2], open: false, locked: true, keyed: true })
      wall([doorX + 1.4, split, r, split + .2], color)
    }
    const prop = (px: number, py: number, type: Prop["kind"]) => town.props.push({ x: px, y: py, kind: type, variant: rng.next() })
    if (kind === "house") {
      prop(x+3.85,y+2,"bed");prop(x+7.55,y+.95,"dresser")
      prop(x+2.65,y+1.1,"nightstand");prop(x+1.35,y+6.15,"shelf")
      prop(x+3.45,y+6.15,"table");prop(x+8.75,y+3.8,"chair")
      prop(x+1.1,b-2.2,"sofa");prop(x+2.7,b-2.2,"coffee");prop(x+4.2,b-1.1,"chair")
      prop(r-.8,b-2,"counter");prop(r-.8,b-4,"fridge")
      prop(r-.8,b-.65,"stove")
      prop(r-3.2,b-2.8,"table");prop(r-3.2,b-1.8,"chair");prop(r-3.2,b-3.7,"chair")
      // Safehouse corner in the back bedroom: a workbench on the east wall and the squad's stash by the west wall.
      // Fixed variants keep the seeded furniture after them unchanged.
      town.props.push({ x: x + 8.9, y: y + 2.3, kind: "workbench", variant: .5 }, { x: x + 2.55, y: y + 4.6, kind: "stash", variant: .5 })
    } else {
      for (let px = x + 2; px < r - 1; px += 3) { prop(px, y + 2, "shelf"); prop(px, b - 4, "shelf") }
    }
  }
  building("ash", "house", BUILDING_RECTS[0])
  building("elm", "house", BUILDING_RECTS[1])
  building("hardware", "hardware", BUILDING_RECTS[2])
  building("pharmacy", "pharmacy", BUILDING_RECTS[3])
  for (const y of [20, 71]) wall([18, y, 39, y + .12], 0x756b51, "fence")
  wall([18, 20, 18.12, 39], 0x756b51, "fence")
  wall([18, 52, 18.12, 71], 0x756b51, "fence")
  for (let i = 0; i < 65; i++) {
    const x = 4 + rng.next() * 88, y = 4 + rng.next() * 88
    if ((x > 36 && x < 53) || (y > 36 && y < 53) || town.buildings.some(b => distToRect(x, y, b.rect) < 4.5)) continue
    town.props.push({ x, y, kind: "tree", variant: rng.next() })
  }
  for(const [x,y] of [[12.8,24.5],[15.6,29.4],[11.5,33.2],[15.4,35.8],[13.8,49.2],[14,59],[12,63]]) town.props.push({x:x!,y:y!,kind:"tree",variant:rng.next()})
  town.props.push({x:16.4,y:32.6,kind:"tree",variant:.46})
  for (const p of [8, 52, 78]) for (const [x,y] of [[p,39],[p,51],[50,p]]) town.lamps.push({x:x!,y:y!,h:3.55,radius:5.8,power:.28,kind:"street"})
  for (const b of town.buildings) {
    const [x,z,r,e]=b.rect
    town.lamps.push({x:x+5.7,y:e+.55,h:2.42,radius:8.8,power:1.05,kind:"porch"})
    town.lamps.push({x:x+2.65,y:z+1.15,h:1.08,radius:3.6,power:.30,kind:"room"})
    town.lamps.push({x:x+1.95,y:e-1.75,h:2.32,radius:4.6,power:.44,kind:"room"})
    town.lamps.push({x:r-3.45,y:e-3.35,h:2.38,radius:4.5,power:.36,kind:"room"})
    town.lamps.push({x:x+5.75,y:z+2.85,h:2.38,radius:4.2,power:.32,kind:"room"})
    if(b.kind==="house")for(const wx of [x+2.5,r-2.75])town.lamps.push({x:wx,y:e+.12,h:1.45,radius:3.5,power:.44,kind:"window"})
  }
  return town
}

/** Windows/fences remain movement blockers but never eye-height sight blockers. */
export const sightRects = (town: Town): Rect[] => [...town.barriers.filter(b => b.kind === "wall").map(b => b.rect), ...town.doors.filter(d => !d.open).map(d => d.rect)]
export const solidRects = (town: Town): Rect[] => [...town.barriers.map(b => b.rect), ...town.doors.filter(d => !d.open).map(d => d.rect), ...town.props.flatMap(p=>{const s=propShape(p);return s?[s.rect]:[]}), ...(town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS)]

export function nearbyDoor(town: Town, x: number, y: number): Door | undefined {
  return town.doors.filter(d => distToRect(x, y, d.rect) <= 1.8).sort((a, b) => distToRect(x, y, a.rect) - distToRect(x, y, b.rect))[0]
}

export function toggleDoor(town: Town, x: number, y: number): Door | undefined {
  const door = nearbyDoor(town, x, y)
  // Do not close a door through the survivor.
  if (!door || (door.open && distToRect(x, y, door.rect) < .35)) return undefined
  door.open = !door.open
  return door
}
