/**
 * Furnishes Outbreak's houses from the shared prop library. Client-only presentation: every anchor stands on an
 * existing gameplay prop (its collider, search spot and light slab are unchanged), and the extra clutter is thin
 * wall pieces, corner pieces and tabletop items that keep off colliders, doorways and walk space. Nothing here reaches
 * the sim, so co-op, bots and determinism are untouched.
 */
import { Mesh } from "@arcade/kit/gpu/mesh"
import { propSpec, type PropRoom } from "@arcade/kit/props/catalogue"
import type { PropInstance } from "@arcade/kit/props/models"
import { dressSurfaces, footprintOf, furnishRoom, placementTriangles, type PlacedProp, type Rect, type Surface, type WallSide } from "@arcade/kit/props/placement"
import { hash2 } from "@arcade/kit/sim/rng"
import { makeTown, propShape, type Building, type Town } from "../../shared/map"
import { emitInteriorDecor } from "../interiors/mesh"
import type { TableLamp } from "../lightbake"
import { furnishedHouse, propDressingState, REPLACED_KINDS } from "./state"

/** Clutter stops being added to a room past this many LOD0 triangles (anchors always draw). */
export const ROOM_TRIANGLE_BUDGET = 40000

const WALL_YAW: Record<WallSide, number> = { n: 0, s: Math.PI, w: -Math.PI / 2, e: Math.PI / 2 }

type Zone = { rect: Rect; room: PropRoom; walls: Partial<Record<WallSide, boolean>> }

/** Rooms of the standard L-shaped house (shared/map.ts): bedroom block, north-east wing, and the open-plan south block. */
function houseZones(b: Building): Zone[] {
  const [x, y, r, e] = b.rect
  const split = y + 5.5, t = 0.22
  return [
    { rect: [x + 2 + t, y + t, x + 9.5 - t, split], room: "bedroom", walls: {} },
    { rect: [x + 9.5, y + 1.5 + t, r - t, split], room: "study", walls: { w: true } },
    { rect: [x + t, split + 0.2, x + 4.7, e - t], room: "living", walls: { e: false } },
    { rect: [x + 4.7, split + 0.2, x + 6.9, e - t], room: "hall", walls: { w: false, e: false } },
    { rect: [x + 6.9, split + 0.2, r - t, e - t], room: "kitchen", walls: { w: false } },
  ]
}

const zoneOf = (zones: Zone[], px: number, pz: number) => zones.find(z => px >= z.rect[0] - 0.3 && px <= z.rect[2] + 0.3 && pz >= z.rect[1] - 0.3 && pz <= z.rect[3] + 0.3)

/** Which wall a collider stands against (smallest gap under 0.6 m), optionally only the given sides. */
function wallSide(rect: Rect, walls: readonly Rect[], sides: readonly WallSide[] = ["n", "s", "w", "e"]): WallSide | null {
  let best: WallSide | null = null, gap = 0.6
  for (const w of walls) {
    const xo = Math.min(rect[2], w[2]) - Math.max(rect[0], w[0])
    const zo = Math.min(rect[3], w[3]) - Math.max(rect[1], w[1])
    const tests: [WallSide, number, boolean][] = [
      ["n", rect[1] - w[3], xo > 0.15],
      ["s", w[1] - rect[3], xo > 0.15],
      ["w", rect[0] - w[2], zo > 0.15],
      ["e", w[0] - rect[2], zo > 0.15],
    ]
    for (const [side, g, ok] of tests) if (ok && sides.includes(side) && g > -0.05 && g < gap) { gap = g; best = side }
  }
  return best
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const snap90 = (a: number) => Math.round(a / (Math.PI / 2)) * (Math.PI / 2)

/** A catalogue piece standing in a collider, back to `side` (or centred and turned to `yaw` when free-standing). */
function fitAnchor(id: string, rect: Rect, side: WallSide | null, yaw?: number, scale?: number): PlacedProp {
  const spec = propSpec(id)
  const [w, , d] = spec.size
  const cx = (rect[0] + rect[2]) / 2, cz = (rect[1] + rect[3]) / 2
  const rx = rect[2] - rect[0], rz = rect[3] - rect[1]
  let x = cx, z = cz
  let a = yaw ?? 0
  let s = scale ?? 1
  if (side) {
    a = WALL_YAW[side]
    const along = side === "n" || side === "s" ? rx : rz
    const across = side === "n" || side === "s" ? rz : rx
    s = scale ?? clamp(Math.min(along / w, across / d), 0.8, 1.15)
    const half = (d * s) / 2
    if (side === "n") z = rect[1] + half
    else if (side === "s") z = rect[3] - half
    else if (side === "w") x = rect[0] + half
    else x = rect[2] - half
  } else if (scale === undefined) {
    const turned = Math.abs(Math.sin(a)) > 0.5
    s = clamp(Math.min((turned ? rz : rx) / w, (turned ? rx : rz) / d), 0.8, 1.15)
  }
  return { id, x, y: 0, z, yaw: a, scale: s, footprint: footprintOf(x, z, w * s, d * s, a), spec }
}

export type HouseFurnishing = { building: string; anchors: PlacedProp[]; clutter: PlacedProp[]; triangles: number }

export function furnishHouse(b: Building, town: Town, density: number, seed: number): HouseFurnishing {
  const [bx0, bz0, bx1, bz1] = b.rect
  const inB = (r: Rect) => r[0] >= bx0 - 0.05 && r[2] <= bx1 + 0.05 && r[1] >= bz0 - 0.05 && r[3] <= bz1 + 0.05
  const walls = town.barriers.filter(w => w.kind !== "fence" && inB(w.rect)).map(w => w.rect)
  const props = town.props.filter(p => p.kind !== "tree" && p.x > bx0 && p.x < bx1 && p.y > bz0 && p.y < bz1)
  const zones = houseZones(b)
  const anchors: PlacedProp[] = []
  const surfaces: Surface[] = []
  const tables = props.filter(p => p.kind === "table" || p.kind === "coffee" || p.kind === "sofa")
  for (const p of props) {
    if (!REPLACED_KINDS.has(p.kind)) continue
    const rect = propShape(p)!.rect
    const zone = zoneOf(zones, p.x, p.y)
    const room = zone?.room ?? "living"
    const long = rect[3] - rect[1] > rect[2] - rect[0] ? "z" : "x"
    let a: PlacedProp
    switch (p.kind) {
      case "sofa": a = fitAnchor("chesterfield-sofa", rect, wallSide(rect, walls, long === "z" ? ["w", "e"] : ["n", "s"])); break
      case "bed": a = fitAnchor("bed", rect, wallSide(rect, walls, long === "z" ? ["n", "s"] : ["w", "e"])); break
      case "coffee": a = fitAnchor("coffee-table", rect, null, long === "z" ? Math.PI / 2 : 0); break
      case "shelf": a = fitAnchor("bookcase", rect, wallSide(rect, walls)); break
      case "dresser": a = fitAnchor(rect[2] - rect[0] > 1.7 || rect[3] - rect[1] > 1.7 ? "sideboard" : "dresser", rect, wallSide(rect, walls)); break
      case "nightstand": a = fitAnchor("nightstand", rect, wallSide(rect, walls)); break
      case "counter": a = fitAnchor("kitchen-counter", rect, wallSide(rect, walls)); break
      case "fridge": a = fitAnchor("fridge-1970s", rect, wallSide(rect, walls)); break
      case "stove": a = fitAnchor("stove", rect, wallSide(rect, walls)); break
      case "table": {
        const side = room === "living" ? wallSide(rect, walls) : null
        a = side ? fitAnchor("sideboard", rect, side) : fitAnchor("dining-table", rect, null, long === "z" ? Math.PI / 2 : 0)
        break
      }
      case "chair": {
        const near = tables.map(t => ({ t, d: Math.hypot(t.x - p.x, t.y - p.y) })).filter(o => o.d < 2.4).sort((m, n) => m.d - n.d)[0]?.t
        const yaw = near ? snap90(Math.atan2(-(near.x - p.x), near.y - p.y)) : 0
        a = room === "living" || room === "study" ? fitAnchor("leather-armchair", rect, null, yaw, 0.82) : fitAnchor("dining-chair", rect, null, yaw, 1)
        break
      }
      default: continue
    }
    anchors.push(a)
    const top = a.spec.surface
    if (top && a.id !== "bed") {
      surfaces.push({ x: a.x, z: a.z, yaw: a.yaw, w: a.spec.size[0] * a.scale * 0.9, d: a.spec.size[2] * a.scale * 0.8, h: top * a.scale, room })
    }
  }

  // Standing pieces the themed decor already put on the walls (fireplace, clock, desk), so clutter keeps off them.
  const decor: Rect[] = []
  emitInteriorDecor(new Mesh(), b, town, undefined, undefined, decor)
  const exclude = new Set<string>(decor.length ? ["grandfather-clock", "typewriter"] : [])
  const lamps: Rect[] = town.lamps.filter(l => l.kind === "room" && l.x > bx0 && l.x < bx1 && l.y > bz0 && l.y < bz1).map(l => [l.x - 0.3, l.y - 0.3, l.x + 0.3, l.y + 0.3])
  const occupied: Rect[] = [...props.map(p => propShape(p)!.rect), ...anchors.map(a => a.footprint), ...decor, ...lamps]
  const doors = town.doors.filter(d => d.id.startsWith(`${b.id}-`)).map(d => d.rect)
  const windows = town.windows.filter(w => w.buildingId === b.id).map(w => w.rect)
  const clutter: PlacedProp[] = []
  const salt = hash2(seed, bx0 * 7 + bz0 * 131) >>> 0
  zones.forEach((zone, i) => {
    const inZone = (p: { x: number; z: number }) => p.x >= zone.rect[0] && p.x <= zone.rect[2] && p.z >= zone.rect[1] && p.z <= zone.rect[3]
    let tris = placementTriangles(anchors.filter(inZone))
    const add = (list: PlacedProp[]) => {
      for (const p of list) {
        const t = p.spec.lod[0]
        if (tris + t > ROOM_TRIANGLE_BUDGET) continue
        tris += t
        clutter.push(p)
        occupied.push(p.footprint)
      }
    }
    if (density <= 0) return
    add(furnishRoom({ rect: zone.rect, room: zone.room, doors, windows, walls: zone.walls, occupied }, { seed: (salt + i * 7919) >>> 0, density, exclude }))
    add(dressSurfaces(surfaces.filter(s => inZone(s)), { seed: (salt ^ (i * 104729)) >>> 0, density, exclude }))
  })
  return { building: b.id, anchors, clutter, triangles: placementTriangles(anchors) + placementTriangles(clutter) }
}

export const instancesOf = (f: HouseFurnishing): PropInstance[] => [...f.anchors, ...f.clutter]

let planned: { key: string; houses: HouseFurnishing[] } = { key: "", houses: [] }
let cachedOrigin: { key: string; town: Town } | null = null

/** Full origin-block town (`ash` and `elm` with all walls/props) even when `StreamingWorld` has shifted active chunks. */
export function originFurnishTown(town: Town): Town {
  if (!town.activeChunkKeys && town.buildings.some(b => b.id === "ash") && town.buildings.some(b => b.id === "elm")) return town
  const key = `${town.seed}/${town.houseSeed}/${town.terrain}/${town.foliageDensity ?? 1}`
  if (cachedOrigin?.key !== key) {
    cachedOrigin = { key, town: makeTown(town.seed, town.houseSeed, town.terrain, town.foliageDensity) }
  }
  return cachedOrigin.town
}

/** The furnished houses for the current `propDressingState`, planned once per town, density and seed; [] when off. */
export function furnishedHouses(town: Town): HouseFurnishing[] {
  const { on, density, seed } = propDressingState
  if (!on) return []
  const full = originFurnishTown(town)
  const key = `${full.seed}/${full.houseSeed}/${density}/${seed}`
  if (key !== planned.key) planned = { key, houses: full.buildings.filter(furnishedHouse).map(b => furnishHouse(b, full, density, seed)) }
  return planned.houses
}

/** Clutter standing on the floor taller than this is grounded in the floor bake like furniture. */
const GROUNDED_HEIGHT = 0.3

/** Footprints of floor clutter over 0.3 m (crates, boxes, pots, radiator, clock, piano, TV) for the floor contact bake. */
export const propFloorFootprints = (town: Town): { rect: Rect; height: number }[] =>
  furnishedHouses(town).flatMap(h => h.clutter)
    .filter(p => p.y < 0.01 && p.spec.size[1] * p.scale > GROUNDED_HEIGHT)
    .map(p => ({ rect: p.footprint, height: p.spec.size[1] * p.scale }))

/** Table lamps the dressing placed, with their shade centre height, for the bounce bake (`bakeOutbreakBounce`). */
export const propLamps = (town: Town): TableLamp[] =>
  furnishedHouses(town).flatMap(h => h.clutter)
    .filter(p => p.spec.shade !== undefined)
    .map(p => ({ x: p.x, z: p.z, h: p.y + ((1 + p.spec.shade!) / 2) * p.spec.size[1] * p.scale }))
