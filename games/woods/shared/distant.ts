import { lakeDistance, nextRandom, terrainHeight, treesNear, type WoodsWorld } from "./world"

/**
 * Sparse distant sounds, the woods' dread: a loon on the lake, a fox, an owl, a branch giving way, something heavy in
 * the brush, three knocks, a whistle, a radio, a car door much too far away, the camp's screen door.
 *
 * The schedule is plain seeded data (`DistantState`) stepped by `stepDistant`, using only + − × ÷ and `nextRandom`, so
 * the sim (or a server) owns it and every player gets the same event: same sound, same take, same world position, same
 * emission time. Clients add their own travel delay (distance / 343 m/s), filtering and reverb.
 *
 * Pacing: the first comes after a minute or two; then they come a little more often and a little closer the longer the
 * group has been out and the further its furthest member is from camp. Never two at once, and never over a signal or a
 * friend's speech (`holdDistant`).
 */

export const DISTANT_SOUNDS = ["far.loon", "far.fox", "far.owl", "far.snap", "far.steps", "far.knock", "far.whistle", "far.radio", "far.cardoor", "far.screendoor"] as const
export type DistantSound = (typeof DISTANT_SOUNDS)[number]

export type DistantEvent = {
  kind: "distant"
  sound: DistantSound
  /** Where it happens (m). */
  x: number
  y: number
  z: number
  /** Sim time it is emitted at the source (s); a listener d metres away hears it d / 343 s later. */
  at: number
  /** Which recorded take (0..2), so everyone hears the same one. */
  take: number
  seq: number
}

export type DistantState = {
  rng: { seed: number }
  /** Sim time of the next event (s). */
  next: number
  seq: number
  /** The last few sounds, never repeated back to back. */
  recent: DistantSound[]
  /** No event before this (signals, speech). */
  quietUntil: number
  /** The last event is still sounding until about here, travel time included. */
  busyUntil: number
}

/** Shared tuning: how often (×). Loudness is each client's mix. */
export const DISTANT_FEEL = { distantRate: 1 }

type Place = "lake" | "woods" | "tree" | "canopy" | "camp" | "beyond"
type Rule = {
  weight: number
  /** Seconds the sound lasts, at most (with its tail). */
  seconds: number
  place: Place
  /** Distance band from the anchor (m) at no dread; dread pulls it in by up to 35%. */
  near: number
  far: number
  /** Only from this dread on (0..1). */
  dread?: number
  /** Height above the ground at the spot (m). */
  above: number
}

export const DISTANT_RULES: Readonly<Record<DistantSound, Rule>> = {
  "far.loon": { weight: 1.3, seconds: 5.5, place: "lake", near: 80, far: 260, above: 0.3 },
  "far.fox": { weight: 1, seconds: 3.5, place: "woods", near: 140, far: 260, above: 0.4 },
  "far.owl": { weight: 1.3, seconds: 4.5, place: "canopy", near: 70, far: 170, above: 12 },
  "far.snap": { weight: 1, seconds: 3.5, place: "tree", near: 50, far: 150, above: 7 },
  "far.steps": { weight: 0.8, seconds: 6.5, place: "woods", near: 38, far: 75, dread: 0.25, above: 0.2 },
  "far.knock": { weight: 0.7, seconds: 4, place: "tree", near: 90, far: 200, dread: 0.15, above: 1.4 },
  "far.whistle": { weight: 0.6, seconds: 3.5, place: "woods", near: 160, far: 300, dread: 0.2, above: 1.6 },
  "far.radio": { weight: 0.5, seconds: 2.5, place: "woods", near: 60, far: 150, dread: 0.35, above: 1.2 },
  "far.cardoor": { weight: 0.45, seconds: 2.5, place: "beyond", near: 480, far: 760, dread: 0.3, above: 1 },
  "far.screendoor": { weight: 0.5, seconds: 2.5, place: "camp", near: 0, far: 0, above: 1 },
}

const SPEED_OF_SOUND = 343

export function createDistant(seed: number): DistantState {
  const rng = { seed: (seed * 2654435761) | 0 }
  return { rng, next: 70 + 50 * nextRandom(rng), seq: 0, recent: [], quietUntil: 0, busyUntil: 0 }
}

/** Keep the woods quiet until `until` (a signal, a friend speaking); a due event waits for it. */
export function holdDistant(ds: DistantState, until: number): void {
  ds.quietUntil = Math.max(ds.quietUntil, until)
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** 0..1: how long the group has been out (most of it by 25 min) and how far the furthest is from camp (by 180 m). */
export function distantDread(t: number, campDistance: number): number {
  return clamp(0.6 * clamp(t / 1500, 0, 1) + 0.4 * clamp(campDistance / 180, 0, 1), 0, 1)
}

/** Seconds between events at a dread level: about 2.7 minutes at first, 75 s deep in. */
export const distantInterval = (dread: number) => 160 - 85 * dread

/** A random unit direction from rejection sampling (no trig, so every engine agrees). */
function direction(rng: { seed: number }): [number, number] {
  for (let i = 0; i < 16; i++) {
    const x = nextRandom(rng) * 2 - 1, z = nextRandom(rng) * 2 - 1
    const l = Math.sqrt(x * x + z * z)
    if (l > 0.2 && l <= 1) return [x / l, z / l]
  }
  return [1, 0]
}

function place(rule: Rule, world: WoodsWorld, ax: number, az: number, dread: number, rng: { seed: number }): [number, number, number] | null {
  const ground = (x: number, z: number) => terrainHeight(world.terrain, x, z)
  const pull = 1 - 0.35 * dread
  const half = world.params.half - 6
  if (rule.place === "camp") {
    const cabins = world.buildings.filter((b) => b.kind === "cabin" || b.kind === "mess-hall")
    const b = cabins[Math.floor(nextRandom(rng) * cabins.length)]!
    const x = (b.rect[0] + b.rect[2]) / 2, z = b.rect[3] + 0.1
    return [x, ground(x, z) + rule.above, z]
  }
  if (rule.place === "lake") {
    // Somewhere out on the water, preferring the far side from the anchor.
    const L = world.lake
    for (let i = 0; i < 24; i++) {
      const [dx, dz] = direction(rng)
      const r = 0.25 + 0.6 * nextRandom(rng)
      const x = L.x + dx * L.rx * r, z = L.z + dz * L.rz * r
      const d = Math.sqrt((x - ax) * (x - ax) + (z - az) * (z - az))
      if (d >= rule.near * pull && d <= rule.far * 1.6) return [x, L.level + rule.above, z]
    }
    return [L.x, L.level + rule.above, L.z + L.rz * 0.4]
  }
  for (let i = 0; i < 24; i++) {
    const [dx, dz] = direction(rng)
    const d = (rule.near + (rule.far - rule.near) * nextRandom(rng)) * pull
    let x = ax + dx * d, z = az + dz * d
    if (rule.place === "beyond") return [x, ground(clamp(x, -half, half), clamp(z, -half, half)) + rule.above, z]
    if (x < -half || x > half || z < -half || z > half) continue
    if (lakeDistance(world.lake, x, z) < 1.25) continue
    if ((x - world.camp.x) * (x - world.camp.x) + (z - world.camp.z) * (z - world.camp.z) < world.camp.radius * world.camp.radius * 1.4) continue
    if (rule.place === "tree" || rule.place === "canopy") {
      const near = treesNear(world, x, z, 9)
      if (!near.length) continue
      let best = near[0]!, bd = Infinity
      for (const t of near) { const e = (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z); if (e < bd) { bd = e; best = t } }
      x = best.x; z = best.z
      const y = rule.place === "canopy" ? best.y + Math.min(best.height * 0.75, rule.above) : best.y + Math.min(best.height * 0.5, rule.above)
      return [x, y, z]
    }
    return [x, ground(x, z) + rule.above, z]
  }
  return null
}

/**
 * Advances the schedule to sim time `t` with the people out there (any order; bots may be included or not, as long as
 * every machine passes the same list). Returns the event that starts now, if any.
 */
export function stepDistant(ds: DistantState, world: WoodsWorld, people: readonly { x: number; z: number }[], t: number, rate = DISTANT_FEEL.distantRate): DistantEvent | null {
  if (t < ds.next || !people.length || rate <= 0) return null
  const wait = Math.max(ds.quietUntil, ds.busyUntil)
  if (t < wait) { ds.next = wait + 2 + 4 * nextRandom(ds.rng); return null }
  // The anchor is whoever is furthest from camp: the dread follows the one out on their own.
  let anchor = people[0]!, far = -1
  for (const p of people) {
    const d = Math.sqrt((p.x - world.camp.x) * (p.x - world.camp.x) + (p.z - world.camp.z) * (p.z - world.camp.z))
    if (d > far) { far = d; anchor = p }
  }
  const dread = distantDread(t, far)
  const lakeD = Math.sqrt((anchor.x - world.lake.x) * (anchor.x - world.lake.x) + (anchor.z - world.lake.z) * (anchor.z - world.lake.z))
  const eligible = DISTANT_SOUNDS.filter((s) => {
    const r = DISTANT_RULES[s]
    if (ds.recent.includes(s) || dread < (r.dread ?? 0)) return false
    if (r.place === "lake" && lakeD > 360) return false
    if (r.place === "camp" && far < 70) return false
    return true
  })
  let sum = 0
  for (const s of eligible) sum += DISTANT_RULES[s].weight
  let pick = nextRandom(ds.rng) * sum, sound: DistantSound = eligible[0] ?? "far.owl"
  for (const s of eligible) { pick -= DISTANT_RULES[s].weight; if (pick <= 0) { sound = s; break } }
  const rule = DISTANT_RULES[sound]
  const at = place(rule, world, anchor.x, anchor.z, dread, ds.rng)
  ds.next = t + (distantInterval(dread) * (0.6 + 0.8 * nextRandom(ds.rng))) / rate
  if (!at) return null
  const take = Math.min(2, Math.floor(nextRandom(ds.rng) * 3))
  // Busy until the furthest person could have heard all of it.
  let reach = 0
  for (const p of people) reach = Math.max(reach, Math.sqrt((p.x - at[0]) * (p.x - at[0]) + (p.z - at[2]) * (p.z - at[2])))
  ds.busyUntil = t + Math.min(reach, 900) / SPEED_OF_SOUND + rule.seconds + 4
  ds.recent.push(sound)
  if (ds.recent.length > 3) ds.recent.shift()
  return { kind: "distant", sound, x: at[0], y: at[1], z: at[2], at: t, take, seq: ds.seq++ }
}

/** An event of a chosen sound placed as the schedule would (auditions, the Lab, the listening page). */
export function placeDistant(world: WoodsWorld, sound: DistantSound, anchor: { x: number; z: number }, t: number, seed: number, dread = 0.5): DistantEvent | null {
  const rng = { seed }
  const at = place(DISTANT_RULES[sound], world, anchor.x, anchor.z, dread, rng)
  return at ? { kind: "distant", sound, x: at[0], y: at[1], z: at[2], at: t, take: Math.min(2, Math.floor(nextRandom(rng) * 3)), seq: -1 } : null
}
