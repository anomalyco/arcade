import { distToRect, rayRect, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { chooseVignettes, vignetteScene } from "../../shared/discovery/vignettes"
import { buildingFootprint, EXTERIOR_VEHICLE_COLLIDERS, inBuildingFootprint, propShape, SIZE, type Building, type Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { BLOOD_VARIANTS, GRIME_VARIANTS, type BloodKind } from "./shapes"
import type { OutbreakBloodSettings } from "./settings"

/**
 * Where the town's old blood lies: a pure function of the town and the Blood settings, so every co-op client places
 * the same stains. Each house, shop and street chunk rolls from its own key (`town.seed`, `bloodSeed`, building id or
 * chunk corner), so a building's stains stay put while the streaming window moves. Houses where something happened
 * get a pool, a drag trail toward their door and prints on the nearest walls; the environmental vignettes' bodies
 * (`shared/discovery/vignettes.ts`) get the pools they lie in.
 */

export type BloodStamp = {
  kind: BloodKind
  variant: number
  x: number
  y: number
  z: number
  yaw: number
  scale: number
  /** Stood up on a wall: model +Z points down, the face looks along `yaw`'s +Z after the roll. */
  wall: boolean
  /** Grime overlay variant on top, or -1. */
  grime: number
}

export type AmbientBloodInput = Pick<OutbreakBloodSettings, "bloodWorld" | "bloodWorldDensity" | "bloodIncidents" | "bloodSeed" | "bloodGrime">

/** Floor stamps sit this far above the support height; each stamp adds a sub-millimetre layer so overlaps never fight. */
export const FLOOR_LIFT = 0.011
const LAYER = 0.0007
const LAYERS = 8
/** Wall stamps stand this far off the wall face. */
export const WALL_LIFT = 0.012

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return h >>> 0
}

export const bloodRng = (town: Pick<Town, "seed">, bloodSeed: number, key: string) =>
  new Rng(hash(`${town.seed}:blood:${bloodSeed}:${key}`) || 1)

const variantOf = (rng: Rng, kind: BloodKind) => Math.floor(rng.next() * BLOOD_VARIANTS[kind]) % BLOOD_VARIANTS[kind]

function pickKind(rng: Rng, weights: readonly (readonly [BloodKind, number])[]): BloodKind {
  let total = 0
  for (const w of weights) total += w[1]
  let t = rng.next() * total
  for (const w of weights) {
    t -= w[1]
    if (t <= 0) return w[0]
  }
  return weights[weights.length - 1]![0]
}

const INTERIOR_MARKS: readonly (readonly [BloodKind, number])[] = [
  ["drops", 0.32],
  ["stain", 0.3],
  ["smear", 0.22],
  ["splat", 0.16],
]
const STREET_MARKS: readonly (readonly [BloodKind, number])[] = [
  ["drops", 0.34],
  ["stain", 0.26],
  ["splat", 0.16],
  ["smear", 0.14],
  ["drag", 0.1],
]

/** Rough footprint radius of each kind at scale 1, for clearance checks. */
const RADIUS: Record<BloodKind, number> = {
  pool: 0.55,
  stain: 0.55,
  splat: 0.5,
  drops: 0.5,
  smear: 0.5,
  drag: 0.52,
  foot: 0.13,
  hand: 0.12,
  wallSplat: 0.45,
  wallSmear: 0.3,
}

class Placer {
  readonly out: BloodStamp[] = []
  private layer = 0

  constructor(
    readonly town: Town,
    readonly grime: number,
  ) {}

  floor(rng: Rng, kind: BloodKind, x: number, z: number, yaw: number, scale: number, variant = variantOf(rng, kind)): void {
    const r = RADIUS[kind] * scale * 0.7
    // Highest support under the stamp so it never sinks into a slope or a raised floor edge.
    let y = supportHeight(this.town, x, z)
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) y = Math.max(y, supportHeight(this.town, x + dx, z + dz))
    const grime = kind !== "foot" && rng.next() < this.grime ? Math.floor(rng.next() * GRIME_VARIANTS) % GRIME_VARIANTS : -1
    this.out.push({ kind, variant, x, y: y + FLOOR_LIFT + (this.layer++ % LAYERS) * LAYER, z, yaw, scale, wall: false, grime })
  }

  wall(rng: Rng, kind: BloodKind, x: number, y: number, z: number, nx: number, nz: number, scale: number): void {
    this.out.push({
      kind,
      variant: variantOf(rng, kind),
      x: x + nx * (WALL_LIFT + (this.layer++ % LAYERS) * LAYER),
      y,
      z: z + nz * (WALL_LIFT + (this.layer % LAYERS) * LAYER),
      yaw: Math.atan2(-nx, nz),
      scale,
      wall: true,
      grime: -1,
    })
  }
}

/** Static solids near a rect: walls, fences, doors, furniture and car wrecks. */
function solidsIn(town: Town, area: Rect, pad: number): Rect[] {
  const near = (r: Rect) => r[2] > area[0] - pad && r[0] < area[2] + pad && r[3] > area[1] - pad && r[1] < area[3] + pad
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

const clearOf = (solids: readonly Rect[], x: number, z: number, r: number) => {
  for (const s of solids) if (distToRect(x, z, s) < r) return false
  return true
}

const wallsIn = (town: Town, area: Rect): Rect[] =>
  town.barriers.filter((b) => b.kind === "wall" && b.rect[2] > area[0] && b.rect[0] < area[2] && b.rect[3] > area[1] && b.rect[1] < area[3]).map((b) => b.rect)

/** The point on a wall face nearest (x, z) that looks into the building, with its outward normal, or null. */
function wallFace(b: Building, wall: Rect, x: number, z: number): { x: number; z: number; nx: number; nz: number } | null {
  const horizontal = wall[2] - wall[0] > wall[3] - wall[1]
  if (horizontal) {
    if (wall[2] - wall[0] < 0.5) return null
    const fx = Math.max(wall[0] + 0.2, Math.min(wall[2] - 0.2, x))
    const side = z < (wall[1] + wall[3]) / 2 ? -1 : 1
    const fz = side < 0 ? wall[1] : wall[3]
    if (!inBuildingFootprint(b, fx, fz + side * 0.3)) return null
    return { x: fx, z: fz, nx: 0, nz: side }
  }
  if (wall[3] - wall[1] < 0.5) return null
  const fz = Math.max(wall[1] + 0.2, Math.min(wall[3] - 0.2, z))
  const side = x < (wall[0] + wall[2]) / 2 ? -1 : 1
  const fx = side < 0 ? wall[0] : wall[2]
  if (!inBuildingFootprint(b, fx + side * 0.3, fz)) return null
  return { x: fx, z: fz, nx: side, nz: 0 }
}

function interiorSpot(rng: Rng, b: Building, solids: readonly Rect[], clear: number): { x: number; z: number } | null {
  const fp = buildingFootprint(b)
  for (let i = 0; i < 24; i++) {
    const f = fp[Math.floor(rng.next() * fp.length) % fp.length]!
    const x = f[0] + clear + rng.next() * Math.max(0, f[2] - f[0] - clear * 2)
    const z = f[1] + clear + rng.next() * Math.max(0, f[3] - f[1] - clear * 2)
    if (inBuildingFootprint(b, x, z) && clearOf(solids, x, z, clear)) return { x, z }
  }
  return null
}

/** A drag trail from (x, z) toward a target, a stamp per stride, stopping at the first solid or after `max` metres. */
function dragTrail(p: Placer, rng: Rng, solids: readonly Rect[], inside: (x: number, z: number) => boolean, x: number, z: number, tx: number, tz: number, max: number): void {
  const d = Math.hypot(tx - x, tz - z)
  if (d < 1.2) return
  const dx = (tx - x) / d
  const dz = (tz - z) / d
  let hit = Math.min(d - 0.6, max)
  for (const s of solids) hit = Math.min(hit, rayRect(x, z, dx, dz, s, hit) - 0.3)
  const step = 0.86
  for (let t = 0.55; t + step * 0.5 < hit; t += step) {
    const cx = x + dx * (t + step * 0.5)
    const cz = z + dz * (t + step * 0.5)
    if (!inside(cx, cz)) break
    const wob = (rng.next() - 0.5) * 0.16
    p.floor(rng, "drag", cx - dz * wob * 0.3, cz + dx * wob * 0.3, Math.atan2(dz, dx) + wob, 0.9 * (1 - (t / Math.max(1, hit)) * 0.25))
  }
}

function houseBlood(p: Placer, town: Town, b: Building, s: AmbientBloodInput, bodies: readonly { x: number; y: number; who: string }[], scene: boolean): void {
  const rng = bloodRng(town, s.bloodSeed, `b:${b.id}`)
  const solids = solidsIn(town, b.rect, 0.5)
  const density = Math.max(0, s.bloodWorldDensity)
  const shop = b.kind !== "house" && !["house", "ranch", "cottage", "cabin"].includes(b.archetype ?? b.kind)
  const marks = Math.round(density * ((shop ? 1.8 : 1.3) + rng.next() * 2))
  for (let i = 0; i < marks; i++) {
    const kind = pickKind(rng, INTERIOR_MARKS)
    const scale = kind === "stain" ? 0.5 + rng.next() * 0.35 : 0.7 + rng.next() * 0.4
    const at = interiorSpot(rng, b, solids, RADIUS[kind] * scale * 0.8)
    if (at) p.floor(rng, kind, at.x, at.z, rng.next() * Math.PI * 2, scale)
  }

  for (const body of bodies) {
    if (!inBuildingFootprint(b, body.x, body.y) || density <= 0) continue
    const survivor = body.who === "survivor"
    p.floor(rng, survivor ? "pool" : "stain", body.x + (rng.next() - 0.5) * 0.2, body.y + (rng.next() - 0.5) * 0.2, rng.next() * 6.28, survivor ? 1.05 + rng.next() * 0.3 : 0.75 + rng.next() * 0.3)
  }

  // Vignette homes (broken into, someone hid) always count; the rest roll against Places where something happened.
  const roll = rng.next()
  if ((!scene && roll >= s.bloodIncidents) || (scene && s.bloodIncidents <= 0) || density <= 0) return
  // Something happened here: a body bled out, was dragged to the door, and someone braced on the walls.
  const at = interiorSpot(rng, b, solids, 0.75)
  if (!at) return
  const wet = rng.next() < 0.3
  p.floor(rng, wet ? "pool" : "stain", at.x, at.z, rng.next() * 6.28, (wet ? 1.15 : 1.3) + rng.next() * 0.4)
  const doors = town.doors.filter((d) => d.id.startsWith(`${b.id}-`))
  let best: { x: number; z: number } | null = null
  for (const d of doors) {
    const cx = (d.rect[0] + d.rect[2]) / 2
    const cz = (d.rect[1] + d.rect[3]) / 2
    if (!best || Math.hypot(cx - at.x, cz - at.z) < Math.hypot(best.x - at.x, best.z - at.z)) best = { x: cx, z: cz }
  }
  const nonDoor = solids.filter((r) => !doors.some((d) => d.rect === r))
  if (best && rng.next() < 0.75) dragTrail(p, rng, nonDoor, (x, z) => inBuildingFootprint(b, x, z), at.x, at.z, best.x, best.z, 7)
  else if (rng.next() < 0.7) {
    const yaw = rng.next() * Math.PI * 2
    p.floor(rng, "smear", at.x + Math.cos(yaw) * 0.9, at.z + Math.sin(yaw) * 0.9, yaw, 0.9 + rng.next() * 0.3)
  }
  for (let i = 0; i < 2 + Math.floor(rng.next() * 3); i++) {
    const a = rng.next() * Math.PI * 2
    const r = 0.8 + rng.next() * 1.4
    const x = at.x + Math.cos(a) * r
    const z = at.z + Math.sin(a) * r
    if (inBuildingFootprint(b, x, z) && clearOf(solids, x, z, 0.35)) p.floor(rng, "drops", x, z, rng.next() * 6.28, 0.6 + rng.next() * 0.3)
  }
  const walls = wallsIn(town, [at.x - 2.6, at.z - 2.6, at.x + 2.6, at.z + 2.6])
  const faces = walls
    .map((w) => wallFace(b, w, at.x, at.z))
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, c) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(c.x - at.x, c.z - at.z))
  const floorY = supportHeight(town, at.x, at.z)
  for (let i = 0; i < Math.min(faces.length, 1 + Math.floor(rng.next() * 3)); i++) {
    const f = faces[i]!
    const along = (rng.next() - 0.5) * 0.8
    const kind = pickKind(rng, [
      ["hand", 0.55],
      ["wallSmear", 0.25],
      ["wallSplat", 0.2],
    ])
    const h = kind === "hand" ? 0.85 + rng.next() * 0.55 : 0.7 + rng.next() * 0.6
    p.wall(rng, kind, f.x + Math.abs(f.nz) * along, floorY + h, f.z + Math.abs(f.nx) * along, f.nx, f.nz, kind === "hand" ? 1.6 + rng.next() * 0.3 : 0.85 + rng.next() * 0.3)
  }
}

const fold = (v: number) => (v >= 0 && v <= SIZE ? v : ((v % SIZE) + SIZE) % SIZE)
const ROAD = (v: number) => v >= 38 && v <= 50

function streetBlood(p: Placer, town: Town, chunk: Rect, s: AmbientBloodInput, bodies: readonly { x: number; y: number; who: string }[]): void {
  const rng = bloodRng(town, s.bloodSeed, `c:${chunk[0]},${chunk[1]}`)
  const solids = solidsIn(town, chunk, 1)
  const streaming = Boolean(town.activeChunkKeys)
  const nearBuilding = (x: number, z: number) => town.buildings.some((b) => x > b.rect[0] - 0.6 && x < b.rect[2] + 0.6 && z > b.rect[1] - 0.6 && z < b.rect[3] + 0.6)
  const marks = Math.round(Math.max(0, s.bloodWorldDensity) * (2.5 + rng.next() * 3))
  for (let i = 0; i < marks; i++) {
    const kind = pickKind(rng, STREET_MARKS)
    const scale = kind === "stain" ? 0.55 + rng.next() * 0.45 : 0.75 + rng.next() * 0.4
    for (let tries = 0; tries < 12; tries++) {
      const x = chunk[0] + 1 + rng.next() * (chunk[2] - chunk[0] - 2)
      const z = chunk[1] + 1 + rng.next() * (chunk[3] - chunk[1] - 2)
      const road = ROAD(streaming ? fold(x) : x) || ROAD(streaming ? fold(z) : z)
      if (!road && rng.next() > 0.4) continue
      if (nearBuilding(x, z) || !clearOf(solids, x, z, RADIUS[kind] * scale * 0.8)) continue
      const yaw = rng.next() * Math.PI * 2
      if (kind === "drag" || kind === "drops") {
        // A trail: two to four strides the same way.
        const n = 2 + Math.floor(rng.next() * 3)
        for (let k = 0; k < n; k++) {
          const cx = x + Math.cos(yaw) * k * 0.88 * scale
          const cz = z + Math.sin(yaw) * k * 0.88 * scale
          if (nearBuilding(cx, cz) || !clearOf(solids, cx, cz, 0.35)) break
          p.floor(rng, kind, cx, cz, yaw + (rng.next() - 0.5) * 0.2, scale)
        }
      } else p.floor(rng, kind, x, z, yaw, scale)
      break
    }
  }
  for (const body of bodies) {
    if (body.x < chunk[0] || body.x >= chunk[2] || body.y < chunk[1] || body.y >= chunk[3]) continue
    if (town.buildings.some((b) => inBuildingFootprint(b, body.x, body.y))) continue
    p.floor(rng, body.who === "survivor" ? "pool" : "stain", body.x, body.y, rng.next() * 6.28, 0.7 + rng.next() * 0.35)
  }
}

/** The ambient stains for a town (empty when Blood › Stains around the world is off). */
export function placeAmbientBlood(town: Town, s: AmbientBloodInput): BloodStamp[] {
  if (!s.bloodWorld || s.bloodWorldDensity <= 0) return []
  const p = new Placer(town, Math.max(0, Math.min(1, s.bloodGrime)))
  const bodies: { x: number; y: number; who: string }[] = []
  const scenes = new Set<string>()
  for (const v of chooseVignettes(town)) {
    const scene = vignetteScene(town, v.kind, v.target)
    if (!scene) continue
    for (const body of scene.bodies) bodies.push(body)
    if (v.kind === "broken-in" || v.kind === "hid") scenes.add(v.target)
  }
  for (const b of town.buildings) houseBlood(p, town, b, s, bodies, scenes.has(b.id))
  for (const c of town.chunks) streetBlood(p, town, c, s, bodies)
  return p.out
}

/** Cache key for a town's ambient stains: rebuild when the town, its streaming window or the settings change. */
export function ambientBloodKey(town: Town, s: AmbientBloodInput): string {
  const o = town.windowOrigin ?? [0, 0]
  return `${town.seed}:${town.houseSeed}:${o[0]},${o[1]}:${town.buildings.length}:${town.chunks.length}:${s.bloodWorld}:${s.bloodWorldDensity}:${s.bloodIncidents}:${s.bloodSeed}:${s.bloodGrime}`
}
