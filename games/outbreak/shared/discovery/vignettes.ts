import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { EXTERIOR_VEHICLE_COLLIDERS, inBuildingFootprint, propShape, type Building, type Town } from "../map"
import { carSites, closetSites, type CarSite } from "./verbs"

/**
 * Environmental vignettes (D-19 slice 5): small scenes of what happened here, seeded per building and per car so a
 * few turn up in every district, each teaching one rule without a word.
 *
 * | Kind | Where | What you see | What it teaches |
 * | --- | --- | --- | --- |
 * | `broken-in` | a home | a side window put in, glass on the floor inside, a survivor down with a snapped bat, the zombie that came through | glass is loud (walk over it upright and it crunches); bats break |
 * | `hid` | a home with a bedroom closet | the dead in front of the closet, spent casings at its door, a battery left behind | closets save you |
 * | `lured` | a shop's front door (hardware, pharmacy, grocery, diner, gas station) | broken bottles leading away down the street, the dead bunched at the last one, a bottle by the door | a bottle pulls them away |
 * | `alarm-car` | an abandoned car with an alarm | its window in and its battery long dead, the dead piled round it | an alarm calls every zombie in earshot |
 *
 * The geometry is a pure function of the town, kind and target. The state is ledger stores: a marker
 * `vignette:<kind>:<target>` so a scene is seeded once (a battery taken stays taken when its chunk streams back),
 * glass stores that never get swept (`keep`), a real ground drop and, for a car, its store. Bodies and casings are
 * drawn by the client from the same geometry, so they cost the simulation nothing.
 */

export const VIGNETTE_KINDS = ["broken-in", "hid", "lured", "alarm-car"] as const
export type VignetteKind = (typeof VIGNETTE_KINDS)[number]

export type VignetteBody = { x: number; y: number; yaw: number; who: "zombie" | "survivor"; pose: number }

export type VignetteScene = {
  id: string
  kind: VignetteKind
  target: string
  x: number
  y: number
  bodies: VignetteBody[]
  glass: { x: number; y: number }[]
  casings: { x: number; y: number }[]
  drop?: { x: number; y: number; item: string; count: number }
  bat?: { x: number; y: number; yaw: number }
  /** The window that was put in. */
  pane?: string
  /** The car whose alarm already rang out. */
  car?: string
}

export const vignetteStoreId = (kind: VignetteKind, target: string) => `vignette:${kind}:${target}`
export const vignetteGlassId = (kind: VignetteKind, target: string, i: number) => `glass:v:${kind}:${target}:${i}`
export const vignetteDropId = (kind: VignetteKind, target: string) => `drop:v:${kind}:${target}`

/** The kind and target a `vignette:` store id names, or null. */
export function parseVignetteId(id: string): { kind: VignetteKind; target: string } | null {
  if (!id.startsWith("vignette:")) return null
  const rest = id.slice(9)
  const i = rest.indexOf(":")
  const kind = rest.slice(0, i) as VignetteKind
  if (i < 0 || !VIGNETTE_KINDS.includes(kind)) return null
  return { kind, target: rest.slice(i + 1) }
}

/** How often each kind turns up where it can. */
export const VIGNETTE_CHANCE = { "broken-in": 0.3, hid: 0.25, lured: 0.4, "alarm-car": 0.5 } as const

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

const roll = (town: Town, target: string) => hash01(`${town.seed}:vignette:${target}`)

/** Homes can be broken into or hidden in; shops are where bottles drew the dead away. */
const HOMES: readonly string[] = ["house", "ranch", "cottage", "cabin"]
const SHOPS: readonly string[] = ["hardware", "pharmacy", "grocery", "diner", "gas_station"]
const isHome = (b: Building) => HOMES.includes(b.archetype ?? b.kind)
const isShop = (b: Building) => SHOPS.includes(b.archetype ?? b.kind)

/** The scenes in the town as it is now: per house, per shop front and per alarm car, by a roll fixed per target. */
export function chooseVignettes(town: Town): { kind: VignetteKind; target: string }[] {
  const out: { kind: VignetteKind; target: string }[] = []
  for (const b of town.buildings) {
    const h = roll(town, b.id)
    if (isHome(b)) {
      if (h < VIGNETTE_CHANCE["broken-in"]) out.push({ kind: "broken-in", target: b.id })
      else if (h < VIGNETTE_CHANCE["broken-in"] + VIGNETTE_CHANCE.hid) out.push({ kind: "hid", target: b.id })
    } else if (isShop(b) && h < VIGNETTE_CHANCE.lured) {
      out.push({ kind: "lured", target: b.id })
    }
  }
  for (const car of carSites(town)) if (car.alarm && roll(town, car.key) < VIGNETTE_CHANCE["alarm-car"]) out.push({ kind: "alarm-car", target: car.key })
  return out.filter((v) => vignetteScene(town, v.kind, v.target))
}

/** Where everything in a scene lies, or null if the target is not in the world or there is no room for it. */
export function vignetteScene(town: Town, kind: VignetteKind, target: string): VignetteScene | null {
  if (kind === "alarm-car") {
    const car = carSites(town).find((c) => c.key === target)
    return car?.alarm ? alarmCar(town, car) : null
  }
  const b = town.buildings.find((x) => x.id === target)
  if (!b) return null
  if (kind === "broken-in") return isHome(b) ? brokenIn(town, b) : null
  if (kind === "hid") return isHome(b) ? hid(town, b) : null
  return isShop(b) ? lured(town, b) : null
}

// ── Room to lie down ──────────────────────────────────────────────────────────────────────────────────────────

/** Static solids near a point: walls and fences, every door whether open or shut, furniture and wrecks. */
function solidsNear(town: Town, x: number, y: number, range = 14): Rect[] {
  const near = (r: Rect) => distToRect(x, y, r) < range
  const out: Rect[] = []
  for (const b of town.barriers) if (near(b.rect)) out.push(b.rect)
  for (const d of town.doors) if (near(d.rect)) out.push(d.rect)
  for (const p of town.props) {
    const s = propShape(p)
    if (s && near(s.rect)) out.push(s.rect)
  }
  for (const v of town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) if (near(v)) out.push(v)
  return out
}

type Place = (x: number, y: number) => boolean

/**
 * How much floor a wall hides behind it from the camera, which looks north over it from the south: about 2.4 m
 * behind a full-height wall at the game's zoom.
 */
const WALL_SHADOW = 2.4

/** Walls running east-west near a point, the ones that can hide the floor north of them. */
function crossWallsNear(town: Town, x: number, y: number, range = 14): Rect[] {
  const out: Rect[] = []
  for (const b of town.barriers) {
    const r = b.rect
    if (b.kind === "wall" && r[2] - r[0] > r[3] - r[1] && distToRect(x, y, r) < range) out.push(r)
  }
  return out
}

/**
 * A test for a spot clear of solids by `r`, inside `b` (or outside every building when `b` is null), and where the
 * camera can see it: not in the strip of floor a wall to its south hides.
 */
function placer(town: Town, solids: readonly Rect[], b: Building | null, r: number, walls: readonly Rect[] = []): Place {
  return (x, y) => {
    for (const s of solids) if (distToRect(x, y, s) < r) return false
    for (const w of walls) if (x > w[0] - r && x < w[2] + r && w[1] > y && w[1] - y < WALL_SHADOW) return false
    if (b) return inBuildingFootprint(b, x, y) && inBuildingFootprint(b, x - r, y - r) && inBuildingFootprint(b, x + r, y + r)
    return !town.buildings.some((o) => distToRect(x, y, o.rect) < r)
  }
}

/** The nearest clear spot to `(x, y)` within `reach`, searched in rings `step` apart, or null. */
function settle(ok: Place, x: number, y: number, step = 0.45, reach = step * 2): { x: number; y: number } | null {
  if (ok(x, y)) return { x: round(x), y: round(y) }
  for (let r = step; r <= reach + 1e-6; r += step) {
    const n = Math.max(6, Math.round((2 * Math.PI * r) / step))
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const px = x + Math.cos(a) * r
      const py = y + Math.sin(a) * r
      if (ok(px, py)) return { x: round(px), y: round(py) }
    }
  }
  return null
}

const round = (n: number) => Number(n.toFixed(2))
const BODY = 0.42
const SMALL = 0.18

// ── Scenes ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A side window put in: it is east or west, so the camera sees the floor inside it (a south wall would hide it). */
function brokenIn(town: Town, b: Building): VignetteScene | null {
  const cx = (b.rect[0] + b.rect[2]) / 2
  const windows = town.windows
    .filter((w) => w.buildingId === b.id && w.rect[2] - w.rect[0] < w.rect[3] - w.rect[1])
    .sort((p, q) => q.rect[0] - p.rect[0] || (p.id < q.id ? -1 : 1))
  for (const w of windows) {
    const wx = (w.rect[0] + w.rect[2]) / 2
    const wy = (w.rect[1] + w.rect[3]) / 2
    const dx = Math.sign(cx - wx) || 1
    const solids = solidsNear(town, wx, wy)
    const walls = crossWallsNear(town, wx, wy)
    const body = placer(town, solids, b, BODY, walls)
    const small = placer(town, solids, b, SMALL, walls)
    const floor = placer(town, solids, b, SMALL)
    // Glass sprayed in from the window; the bodies a couple of metres in, clear of anything overhanging the wall and
    // where the camera can see them.
    const zombie = settle(body, wx + dx * 2.0, wy + 0.4, 0.3, 1.8)
    const survivor = zombie && settle((x, y) => body(x, y) && Math.hypot(x - zombie.x, y - zombie.y) > 1, wx + dx * 3.2, zombie.y + 0.4, 0.3, 1.8)
    const bat = survivor && settle(small, survivor.x + dx * 0.7, survivor.y + 0.6, 0.25, 1)
    const scrap = bat && settle(small, bat.x, bat.y + 0.3, 0.15, 0.6)
    // The glass lies in the room the dead came into, where the window opens onto it.
    const oy = Math.min(Math.max(zombie?.y ?? wy, w.rect[1] + 0.3), w.rect[3] - 0.3)
    const glass = [settle(floor, wx + dx * 0.5, oy - 0.1, 0.2), settle(floor, wx + dx * 1.2, oy + 0.35, 0.2), settle(floor, wx + dx * 0.95, oy + 0.75, 0.2)]
    if (!survivor || !zombie || !bat || !scrap || glass.some((g) => !g)) continue
    return {
      id: vignetteStoreId("broken-in", b.id),
      kind: "broken-in",
      target: b.id,
      x: round(wx + dx * 2.2),
      y: round(wy),
      bodies: [
        { ...survivor, yaw: dx > 0 ? Math.PI : 0, who: "survivor", pose: 0 },
        { ...zombie, yaw: dx > 0 ? 0.3 : Math.PI - 0.3, who: "zombie", pose: 1 },
      ],
      glass: glass as { x: number; y: number }[],
      casings: [],
      bat: { ...bat, yaw: 0.6 },
      drop: { ...scrap, item: "scrap", count: 1 },
      pane: w.id,
    }
  }
  return null
}

/** Someone held out in the bedroom closet: the dead lie in front of it, the casings at its door. */
function hid(town: Town, b: Building): VignetteScene | null {
  const closet = closetSites(town).find((c) => c.x >= b.rect[0] && c.x <= b.rect[2] && c.y >= b.rect[1] && c.y <= b.rect[3])
  if (!closet) return null
  const { x, y } = closet.out
  const solids = solidsNear(town, x, y)
  const walls = crossWallsNear(town, x, y)
  const body = placer(town, solids, b, BODY, walls)
  const small = placer(town, solids, b, SMALL, walls)
  const a = settle(body, x - 0.75, y + 1.45, 0.3, 1.5)
  const c = a && settle((px, py) => body(px, py) && Math.hypot(px - a.x, py - a.y) > 0.95, x + 0.65, y + 2.15, 0.3, 1.5)
  if (!a || !c) return null
  const casings = [[-0.2, 0.1], [0.15, 0.25], [0.3, -0.05], [-0.05, 0.4]].map(([dx, dy]) => settle(placer(town, solids, b, 0.05), x + dx!, y + dy!, 0.1)).filter((p) => p !== null)
  // Dropped a step out from the closet, beyond its own prompt's reach.
  const battery = settle(small, x + 1.0, y + 0.9, 0.2, 1)
  if (!battery) return null
  return {
    id: vignetteStoreId("hid", b.id),
    kind: "hid",
    target: b.id,
    x: round(x),
    y: round(y + 1),
    bodies: [
      { ...a, yaw: -Math.PI / 2 - 0.4, who: "zombie", pose: 0 },
      { ...c, yaw: -Math.PI / 2 + 0.5, who: "zombie", pose: 2 },
    ],
    glass: [],
    casings,
    drop: { ...battery, item: "battery", count: 1 },
  }
}

/** Bottles broken in a line away from a shop's front door, and the dead bunched at the last one. */
function lured(town: Town, b: Building): VignetteScene | null {
  const door = town.doors.find((d) => d.id === `${b.id}-front`)
  if (!door) return null
  const dx0 = (door.rect[0] + door.rect[2]) / 2
  const dy0 = (door.rect[1] + door.rect[3]) / 2
  const horizontal = door.rect[2] - door.rect[0] > door.rect[3] - door.rect[1]
  const cx = (b.rect[0] + b.rect[2]) / 2
  const cy = (b.rect[1] + b.rect[3]) / 2
  // Out of the door, and along the street to one side, fixed per shop.
  const out = horizontal ? { x: 0, y: Math.sign(dy0 - cy) || 1 } : { x: Math.sign(dx0 - cx) || 1, y: 0 }
  const solids = solidsNear(town, dx0 + out.x * 6, dy0 + out.y * 6, 18)
  const walls = crossWallsNear(town, dx0 + out.x * 6, dy0 + out.y * 6, 18)
  const body = placer(town, solids, null, BODY, walls)
  const small = placer(town, solids, null, SMALL, walls)
  const first = hash01(`${town.seed}:lured-side:${b.id}`) < 0.5 ? 1 : -1
  for (const sign of [first, -first]) {
    const side = { x: -out.y * sign, y: out.x * sign }
    const at = (o: number, s: number) => ({ x: dx0 + out.x * o + side.x * s, y: dy0 + out.y * o + side.y * s })
    const g = [at(2.4, 0.3), at(4.6, 2.2), at(6.4, 4.6)].map((p) => settle(small, p.x, p.y, 0.3))
    if (g.some((p) => !p)) continue
    const last = g[2]!
    const ring = [[1.0, 0.2], [-0.4, 1.05], [0.3, -1.0]].map(([u, v]) => settle(body, last.x + out.x * u! + side.x * v!, last.y + out.y * u! + side.y * v!, 0.3))
    const bodies = ring.filter((p) => p !== null)
    if (bodies.length < 2) continue
    // One left unthrown, by the first that broke: well clear of the door, so it never crowds the door's own prompts.
    const bottle = settle(small, at(3.2, -0.5).x, at(3.2, -0.5).y, 0.25)
    if (!bottle) continue
    return {
      id: vignetteStoreId("lured", b.id),
      kind: "lured",
      target: b.id,
      x: round(at(4, 2).x),
      y: round(at(4, 2).y),
      bodies: bodies.map((p, i) => ({ ...p, yaw: Math.atan2(last.y - p.y, last.x - p.x) + (i - 1) * 0.5, who: "zombie" as const, pose: i % 3 })),
      glass: g as { x: number; y: number }[],
      casings: [],
      drop: { ...bottle, item: "bottle", count: 1 },
    }
  }
  return null
}

/** A car that wailed until its battery died: its window in, and the dead it called piled round it. */
function alarmCar(town: Town, car: CarSite): VignetteScene | null {
  const [x0, y0, x1, y1] = car.rect
  const solids = solidsNear(town, car.x, car.y)
  const walls = crossWallsNear(town, car.x, car.y)
  const body = placer(town, solids, null, BODY, walls)
  const small = placer(town, solids, null, SMALL, walls)
  const spots = [
    [x0 - 0.6, car.y + 0.2],
    [x1 + 0.6, car.y - 0.3],
    [car.x - 0.9, y1 + 0.65],
    [car.x + 1.2, y0 - 0.6],
    [car.x + 0.4, y1 + 1.5],
  ]
  const bodies: VignetteBody[] = []
  for (const [sx, sy] of spots) {
    const p = settle(body, sx!, sy!, 0.25)
    if (!p || bodies.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.9)) continue
    bodies.push({ ...p, yaw: Math.atan2(car.y - p.y, car.x - p.x), who: "zombie", pose: bodies.length % 3 })
  }
  const glass = settle(small, car.x + 0.3, y1 + 0.45, 0.2)
  if (bodies.length < 2 || !glass) return null
  return {
    id: vignetteStoreId("alarm-car", car.key),
    kind: "alarm-car",
    target: car.key,
    x: car.x,
    y: car.y,
    bodies,
    glass: [glass],
    casings: [],
    car: car.key,
  }
}
