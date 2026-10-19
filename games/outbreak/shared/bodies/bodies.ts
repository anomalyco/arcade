import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import type { Stack } from "@arcade/kit/sim/ledger"
import { Rng } from "@arcade/kit/sim/rng"
import { carSites } from "../discovery/verbs"
import { chooseVignettes, vignetteScene } from "../discovery/vignettes"
import { EXTERIOR_VEHICLE_COLLIDERS, propShape, type Town } from "../map"

/**
 * Bodies To Search (AR-56, D-37 pick 7): survivors who did not make it, lying where they fell with what they carried.
 * Kneel and search one like a drawer (quieter than a smash, louder than nothing) and take what is left. Rarely, fixed
 * per body from the town seed, the body was only nearly dead: it rises as you reach for it, and what it carried falls
 * where it lay.
 *
 * Where: the survivor the `broken-in` vignette leaves on the floor, plus a few more on porches by their front doors and
 * beside abandoned cars. Each lies in an old blood pool (`src/blood/placement.ts`).
 *
 * | Store | Slots / counts | Meaning |
 * | --- | --- | --- |
 * | `body:<key>` | up to 4 stacks; `rise`, `risen` (deciseconds) | what it carries (revealed once searched); began to rise at `rise`; up and walking |
 * | `drop:body:<key>` | what it carried | left on the ground where it rose |
 */

export type BodiesTuning = {
  /** Seconds to search a body. */
  bodySearchTime: number
  /** How far searching a body carries to the dead, in metres. */
  bodySearchNoise: number
  /** Share of bodies that are not quite dead (fixed per body from the town seed). */
  bodyRiseChance: number
  /** Seconds from reaching for a rising body to it being on its feet. */
  bodyRiseDelay: number
}

export const DEFAULT_BODIES_TUNING: BodiesTuning = {
  bodySearchTime: 1.6,
  bodySearchNoise: 4,
  bodyRiseChance: 0.08,
  bodyRiseDelay: 0.7,
}

/** Lab controls for searchable bodies (Backquote › Bodies); the values live in the Discovery settings. */
export const bodiesControls = [
  { key: "bodySearchTime", label: "Search a body", group: "Bodies", min: 0.2, max: 6, step: 0.1, unit: "s" },
  { key: "bodySearchNoise", label: "Body search noise", group: "Bodies", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "bodyRiseChance", label: "Bodies that rise", group: "Bodies", min: 0, max: 1, step: 0.01, unit: "×" },
  { key: "bodyRiseDelay", label: "Rises after", group: "Bodies", min: 0.1, max: 3, step: 0.1, unit: "s" },
] as const

export type BodySite = {
  /** Ledger store id, `body:<key>`. */
  id: string
  key: string
  x: number
  y: number
  yaw: number
  /** How it lies (0..2), as the vignettes' bodies do. */
  pose: number
  /** The vignette draws this one itself (and it never rises). */
  vignette: boolean
  /** Its fixed roll in [0, 1): it rises when this is under the rise chance. */
  riseRoll: number
}

export const bodyStoreId = (key: string) => `body:${key}`
export const bodyDropId = (key: string) => `drop:body:${key}`
export const BODY_SLOTS = 4

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

const roll = (town: Pick<Town, "seed">, key: string) => hash01(`${town.seed}:body:${key}`)

/** Share of buildings with someone lying by the front door, and of abandoned cars with someone beside them. */
const PORCH_CHANCE = 0.16
const CAR_CHANCE = 0.12
const CLEAR = 0.45

/** Whether a body fits at `(x, y)`: outside every building, clear of walls, fences, doors, furniture and wrecks. */
function clearSpot(town: Town, x: number, y: number): boolean {
  for (const b of town.buildings) if (distToRect(x, y, b.rect) < CLEAR) return false
  for (const b of town.barriers) if (distToRect(x, y, b.rect) < CLEAR) return false
  for (const d of town.doors) if (distToRect(x, y, d.rect) < CLEAR) return false
  for (const p of town.props) {
    const s = propShape(p)
    if (s && distToRect(x, y, s.rect) < CLEAR) return false
  }
  for (const v of (town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) as readonly Rect[]) if (distToRect(x, y, v) < CLEAR) return false
  return true
}

const round = (n: number) => Number(n.toFixed(2))

/** Every body in the town as it is now. Deterministic, fixed per building and per car. */
export function bodySites(town: Town): BodySite[] {
  const out: BodySite[] = []
  const add = (key: string, x: number, y: number, vignette: boolean) => {
    out.push({ id: bodyStoreId(key), key, x: round(x), y: round(y), yaw: round(roll(town, `yaw:${key}`) * Math.PI * 2), pose: Math.floor(roll(town, `pose:${key}`) * 3), vignette, riseRoll: vignette ? 1 : roll(town, `rise:${key}`) })
  }
  for (const v of chooseVignettes(town)) {
    if (v.kind !== "broken-in") continue
    const scene = vignetteScene(town, v.kind, v.target)
    const body = scene?.bodies.find((b) => b.who === "survivor")
    if (body) out.push({ id: bodyStoreId(`v:${v.target}`), key: `v:${v.target}`, x: body.x, y: body.y, yaw: body.yaw, pose: body.pose, vignette: true, riseRoll: 1 })
  }
  for (const b of town.buildings) {
    if (roll(town, b.id) >= PORCH_CHANCE) continue
    const door = town.doors.find((d) => d.id === `${b.id}-front`)
    if (!door) continue
    const cx = (door.rect[0] + door.rect[2]) / 2
    const cy = (door.rect[1] + door.rect[3]) / 2
    const horizontal = door.rect[2] - door.rect[0] > door.rect[3] - door.rect[1]
    const bx = (b.rect[0] + b.rect[2]) / 2
    const by = (b.rect[1] + b.rect[3]) / 2
    const out1 = horizontal ? { x: 0, y: Math.sign(cy - by) || 1 } : { x: Math.sign(cx - bx) || 1, y: 0 }
    const side = roll(town, `side:${b.id}`) < 0.5 ? 1 : -1
    for (const [o, s] of [[1.7, 1.5 * side], [1.7, -1.5 * side], [2.6, 0.6 * side], [2.4, 2.4 * side]] as const) {
      const x = cx + out1.x * o - out1.y * s
      const y = cy + out1.y * o + out1.x * s
      if (!clearSpot(town, x, y)) continue
      add(`porch:${b.id}`, x, y, false)
      break
    }
  }
  for (const car of carSites(town)) {
    if (roll(town, car.key) >= CAR_CHANCE) continue
    const [x0, y0, x1, y1] = car.rect
    for (const [x, y] of [[x0 - 0.75, car.y + 0.2], [x1 + 0.75, car.y - 0.2], [car.x - 0.6, y1 + 0.75], [car.x + 0.6, y0 - 0.75]] as const) {
      if (!clearSpot(town, x, y)) continue
      add(`car:${car.key}`, x, y, false)
      break
    }
  }
  return out
}

/** What a dead survivor carried: a few rounds, something to patch up with, a flare, a tin of food, maybe a key. */
const BODY_LOOT: readonly { item: string; chance: number; min?: number; max?: number }[] = [
  { item: "ammo", chance: 0.6, min: 2, max: 6 },
  { item: "bandage", chance: 0.3 },
  { item: "flare", chance: 0.3 },
  { item: "food", chance: 0.3 },
  { item: "battery", chance: 0.25 },
  { item: "key", chance: 0.15 },
  { item: "knife", chance: 0.1 },
  { item: "noisemaker", chance: 0.1 },
]

/** A body's contents, fixed per body from the town seed. Never empty: there is always something on them. */
export function bodyLoot(town: Pick<Town, "seed">, key: string, lootRate: number): Stack[] {
  const rng = new Rng(Math.floor(roll(town, `loot:${key}`) * 0xffffffff) || 1)
  const out: Stack[] = []
  for (const r of BODY_LOOT) {
    if (out.length >= BODY_SLOTS) break
    const hit = rng.next() < r.chance * lootRate
    const n = (r.min ?? 1) + rng.int((r.max ?? r.min ?? 1) - (r.min ?? 1) + 1)
    if (hit) out.push({ item: r.item, count: n })
  }
  if (!out.length) out.push({ item: "ammo", count: 2 + rng.int(3) })
  return out
}
