import { Rng } from "@arcade/kit/sim/rng"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"

export const CHUNK = 32
export const SIZE = CHUNK * 3
export type Barrier = { rect: Rect; kind: "wall" | "window" | "fence"; color: number }
export type Door = { id: string; rect: Rect; open: boolean }
export type Building = { id: string; kind: "house" | "hardware" | "pharmacy"; rect: Rect; color: number }
export type Prop = { x: number; y: number; kind: "bed" | "sofa" | "table" | "shelf" | "tree" | "coffee" | "counter" | "fridge" | "dresser" | "chair" | "nightstand" | "stove"; variant: number }
export type Lamp = { x: number; y: number; h: number; radius: number; power: number; kind: "street" | "porch" | "room" | "window" }
export type Town = { seed: number; houseSeed: number; terrain: number; foliageDensity: number; chunks: Rect[]; buildings: Building[]; barriers: Barrier[]; doors: Door[]; props: Prop[]; lamps: Lamp[] }

/** One footprint source for geometry, collision, roof cutaways and room memory. */
export const BUILDING_RECTS = [[22,24,37,35.5],[21,54,36,65.5],[53,23,73,38],[53,54,72,68]] as const
export const frontageEnd = (b: Building) => b.kind === "house" ? b.rect[3] + 2.5 : b.rect[3]
export function propShape(p: Prop): { rect: Rect; height: number } | undefined {
  const shapes = {bed:[1.72,2.6,1],sofa:[1.2,2.6,1.1],table:[1.5,1,.82],shelf:[1.7,.8,1.8],coffee:[1.1,1.5,.52],counter:[.8,2.4,1.02],fridge:[.8,.9,1.9],dresser:[2.2,.7,1.1],chair:[.55,.55,1.05],nightstand:[.55,.55,.65],stove:[.75,.8,.95]} as const
  if(p.kind==="tree") return undefined
  const [w,d,h]=shapes[p.kind]
  return {rect:[p.x-w/2,p.y-d/2,p.x+w/2,p.y+d/2],height:h}
}

/** Fixed street topology; seeded house palettes, trees and shelf stock. All dimensions are metres. */
export function makeTown(seed: number, houseSeed = seed, terrain = .22, foliageDensity = 1): Town {
  const rng = new Rng(seed)
  const houses = new Rng(houseSeed)
  const town: Town = { seed, houseSeed, terrain, foliageDensity, chunks: [], buildings: [], barriers: [], doors: [], props: [], lamps: [] }
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) town.chunks.push([x * CHUNK, y * CHUNK, (x + 1) * CHUNK, (y + 1) * CHUNK])
  const wall = (rect: Rect, color: number, kind: Barrier["kind"] = "wall") => town.barriers.push({ rect, color, kind })
  const building = (id: string, kind: Building["kind"], rect: Rect) => {
    const [x, y, r, b] = rect
    const color = kind === "house" ? houses.pick([0xb3afa0, 0x899d95, 0xb4a181, 0x9caaa9]) : kind === "hardware" ? 0x8e7564 : 0x718b82
    town.buildings.push({ id, kind, rect, color })
    // South entrance and two glazed openings, plus a window on the east wall.
    const doorX = x + 5
    wall([x, y, r, y + .22], color)
    wall([x, y, x + .22, b], color)
    wall([r - .22, y, r, y + 4], color)
    wall([r - .22, y + 4, r, y + 6.5], color, "window")
    wall([r - .22, y + 6.5, r, b], color)
    wall([x, b - .22, x + 1.5, b], color)
    wall([x + 1.5, b - .22, x + 3.5, b], color, "window")
    wall([x + 3.5, b - .22, doorX, b], color)
    town.doors.push({ id: `${id}-front`, rect: [doorX, b - .22, doorX + 1.4, b], open: false })
    wall([doorX + 1.4, b - .22, r - 4, b], color)
    wall([r - 4, b - .22, r - 1.5, b], color, "window")
    wall([r - 1.5, b - .22, r, b], color)
    // Bedroom / store stockroom, with an internal door facing the entrance.
    const split = y + 5.5
    wall([x, split, doorX, split + .2], color)
    town.doors.push({ id: `${id}-room`, rect: [doorX, split, doorX + 1.4, split + .2], open: false })
    wall([doorX + 1.4, split, r, split + .2], color)
    const prop = (px: number, py: number, type: Prop["kind"]) => town.props.push({ x: px, y: py, kind: type, variant: rng.next() })
    if (kind === "house") {
      prop(x+4,y+2,"bed");prop(r-2.3,y+1.1,"dresser")
      prop(x+2.7,y+2,"nightstand");prop(x+7.7,y+.7,"shelf")
      prop(r-4,y+3,"table");prop(r-4,y+3.9,"chair")
      prop(x+1.1,b-2.2,"sofa");prop(x+2.7,b-2.2,"coffee");prop(x+4.2,b-1.1,"chair")
      prop(r-.8,b-2,"counter");prop(r-.8,b-4,"fridge")
      prop(r-.8,b-.65,"stove")
      prop(r-3.2,b-2.8,"table");prop(r-3.2,b-1.8,"chair");prop(r-3.2,b-3.7,"chair")
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
    town.lamps.push({x:x+5.7,y:e+.42,h:2.35,radius:5.8,power:.68,kind:"porch"})
    town.lamps.push({x:x+2.6,y:z+1.85,h:1.24,radius:4.0,power:.30,kind:"room"})
    town.lamps.push({x:x+1.25,y:e-1.25,h:1.42,radius:4.5,power:.34,kind:"room"})
    town.lamps.push({x:r-3.2,y:e-3.6,h:2.10,radius:4.6,power:.30,kind:"room"})
    town.lamps.push({x:x+6.1,y:z+4.2,h:2.38,radius:4.2,power:.22,kind:"room"})
    if(b.kind==="house")for(const wx of [x+2.5,r-2.75])town.lamps.push({x:wx,y:e+.18,h:1.35,radius:2.8,power:.24,kind:"window"})
  }
  return town
}

/** Windows/fences remain movement blockers but never eye-height sight blockers. */
export const sightRects = (town: Town): Rect[] => [...town.barriers.filter(b => b.kind === "wall").map(b => b.rect), ...town.doors.filter(d => !d.open).map(d => d.rect)]
export const solidRects = (town: Town): Rect[] => [...town.barriers.map(b => b.rect), ...town.doors.filter(d => !d.open).map(d => d.rect), ...town.props.flatMap(p=>{const s=propShape(p);return s?[s.rect]:[]})]

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
