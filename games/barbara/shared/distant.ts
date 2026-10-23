import { createCreature, type CreatureState } from "./creature"
import { lakeDistance, nextRandom, terrainHeight, treesNear, type WoodsWorld } from "./world"

/**
 * Sparse distant sounds, the woods' dread: a loon on the lake, a fox, an owl, a branch giving way, something heavy in
 * the brush, three knocks, a whistle, a radio, a car door much too far away, the camp's screen door.
 *
 * The schedule is plain seeded data (`DistantState`) stepped by `stepDistant`, using only + − × ÷ and `nextRandom`.
 * `stepWoods` owns it (the room's sim online, the local sim solo), so every player gets the same event: same sound, same take, same world position, same
 * emission time. Clients add their own travel delay (distance / 343 m/s), filtering and reverb.
 *
 * Pacing: the first comes after a minute or two; then they come a little more often and a little closer the longer the
 * group has been out and the further its furthest member is from camp. Never two at once, and never over a signal or a
 * friend's speech (`holdDistant`; the sim holds it while anyone signals).
 *
 * The uncanny tier (`UNCANNY_SOUNDS`) is rarer and stranger: sounds that are almost right and then wrong. None before
 * `UNCANNY_FIRST` (8 min); after that, when an ordinary sound is due, it may be one of these instead, more likely the
 * later it is and the further the group is from camp, each at most once a night. The mimic is different: it answers a
 * searcher's call for Barbara (`answerCall`), from the wrong side. Their choices draw on their own seeded stream
 * (`DistantState.odd`), so the ordinary schedule up to the first of them is unchanged.
 */

export const DISTANT_SOUNDS = ["far.loon", "far.fox", "far.owl", "far.snap", "far.steps", "far.knock", "far.whistle", "far.radio", "far.cardoor", "far.screendoor"] as const
/**
 * A howl that goes on past any breath and becomes something else, an animal getting got, a searcher's call answered
 * from the wrong side, the loon twice exactly the same, a big tree taking a slow climbing weight, every cricket
 * stopping at once before one knock.
 */
export const UNCANNY_SOUNDS = ["far.howl", "far.taken", "far.mimic", "far.echo", "far.climb", "far.stop"] as const
export type UncannySound = (typeof UNCANNY_SOUNDS)[number]
export type DistantSound = (typeof DISTANT_SOUNDS)[number] | UncannySound

/** Calls the mimic can answer (its takes, in this order: `far.mimic` take i is a processed copy of line i). */
export const MIMIC_LINES = ["walt.call.1", "walt.call.5", "joyce.call.1", "joyce.call.5", "gary.call.1", "dale.call.1", "dale.call.4", "tess.call.2", "tess.call.4"] as const

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
  /** The creature's sightings (`shared/creature.ts`): its own seeded stream, sharing `busyUntil` with the sounds. */
  creature: CreatureState
  /** The uncanny tier: its own seeded stream. */
  odd: UncannyState
}

export type UncannyState = {
  rng: { seed: number }
  /** Not before this sim time (s). */
  next: number
  /** Played tonight (each at most once). */
  played: UncannySound[]
  /** A mimic waiting to answer a call. */
  mimic: { at: number; take: number; x: number; y: number; z: number } | null
}

/** The uncanny tier's knobs (in `FEEL`); a room runs the defaults. */
export type UncannyFeel = { uncanny: boolean; uncannyRate: number }

/** None in the first eight minutes of a night (s). */
export const UNCANNY_FIRST = 480

/** `far` is like `beyond` but may land inside the map too (anywhere that far off). */
type Place = "lake" | "woods" | "tree" | "canopy" | "camp" | "beyond" | "far"
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
  // Uncanny: the weight picks among them once one is due; `seconds` is the longest take.
  "far.howl": { weight: 1.2, seconds: 12, place: "far", near: 260, far: 380, above: 1 },
  "far.taken": { weight: 1.2, seconds: 4.5, place: "woods", near: 90, far: 200, above: 0.4 },
  "far.mimic": { weight: 0, seconds: 5, place: "woods", near: 150, far: 240, above: 1.6 },
  "far.echo": { weight: 0.8, seconds: 15, place: "lake", near: 80, far: 260, above: 0.3 },
  "far.climb": { weight: 1, seconds: 10.5, place: "tree", near: 60, far: 150, above: 8 },
  "far.stop": { weight: 0.9, seconds: 7.5, place: "tree", near: 100, far: 220, above: 1.4 },
}

const isUncanny = (s: DistantSound): s is UncannySound => (UNCANNY_SOUNDS as readonly string[]).includes(s)

const SPEED_OF_SOUND = 343

export function createDistant(seed: number): DistantState {
  const rng = { seed: (seed * 2654435761) | 0 }
  const odd = { seed: (seed * 668265263) | 0 }
  return { rng, next: 70 + 50 * nextRandom(rng), seq: 0, recent: [], quietUntil: 0, busyUntil: 0, creature: createCreature(seed), odd: { rng: odd, next: UNCANNY_FIRST + 60 * nextRandom(odd), played: [], mimic: null } }
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

/** 0..1: the chance a due sound is uncanny at a dread level (none under 0.3; 8 min near camp is about 0.2). */
export const uncannyChance = (dread: number) => 0.7 * clamp((dread - 0.3) / 0.45, 0, 1)

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
    if (rule.place === "beyond" || rule.place === "far") return [x, ground(clamp(x, -half, half), clamp(z, -half, half)) + rule.above, z]
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
export function stepDistant(ds: DistantState, world: WoodsWorld, people: readonly { x: number; z: number }[], t: number, rate = 1, odd: UncannyFeel = { uncanny: true, uncannyRate: 1 }): DistantEvent | null {
  if (!people.length) return null
  const mimic = ds.odd.mimic
  if (mimic) {
    // Nothing else starts while it waits to answer; it answers once the woods are quiet, or not at all if the moment has passed.
    if (t < mimic.at) return null
    if (t < Math.max(ds.quietUntil, ds.busyUntil)) { if (t > mimic.at + 10) ds.odd.mimic = null; return null }
    ds.odd.mimic = null
    ds.odd.played.push("far.mimic")
    return emit(ds, "far.mimic", [mimic.x, mimic.y, mimic.z], mimic.take, people, t)
  }
  if (t < ds.next || rate <= 0) return null
  const wait = Math.max(ds.quietUntil, ds.busyUntil)
  if (t < wait) { ds.next = wait + 2 + 4 * nextRandom(ds.rng); return null }
  const { anchor, far } = anchorOf(world, people)
  const dread = distantDread(t, far)
  const strange = odd.uncanny && odd.uncannyRate > 0 ? uncanny(ds, world, people, anchor, dread, t, odd.uncannyRate) : null
  if (strange) { ds.next = t + (distantInterval(dread) * (0.6 + 0.8 * nextRandom(ds.rng))) / rate; return strange }
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
  ds.recent.push(sound)
  if (ds.recent.length > 3) ds.recent.shift()
  return emit(ds, sound, at, take, people, t)
}

/** The anchor is whoever is furthest from camp: the dread follows the one out on their own. */
function anchorOf(world: WoodsWorld, people: readonly { x: number; z: number }[]) {
  let anchor = people[0]!, far = -1
  for (const p of people) {
    const d = Math.sqrt((p.x - world.camp.x) * (p.x - world.camp.x) + (p.z - world.camp.z) * (p.z - world.camp.z))
    if (d > far) { far = d; anchor = p }
  }
  return { anchor, far }
}

function emit(ds: DistantState, sound: DistantSound, at: readonly number[], take: number, people: readonly { x: number; z: number }[], t: number): DistantEvent {
  // Busy until the furthest person could have heard all of it.
  let reach = 0
  for (const p of people) reach = Math.max(reach, Math.sqrt((p.x - at[0]!) * (p.x - at[0]!) + (p.z - at[2]!) * (p.z - at[2]!)))
  ds.busyUntil = t + Math.min(reach, 900) / SPEED_OF_SOUND + DISTANT_RULES[sound].seconds + 4
  const cm = (v: number) => Math.round(v * 100) / 100
  return { kind: "distant", sound, x: cm(at[0]!), y: cm(at[1]!), z: cm(at[2]!), at: Math.round(t * 1000) / 1000, take, seq: ds.seq++ }
}

const dist2 = (ax: number, az: number, bx: number, bz: number) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz)

/** Which uncanny sounds can happen here and now (each once a night; the mimic only answers calls). */
function uncannyEligible(ds: DistantState, world: WoodsWorld, people: readonly { x: number; z: number }[], anchor: { x: number; z: number }): UncannySound[] {
  const lakeD = Math.sqrt(dist2(anchor.x, anchor.z, world.lake.x, world.lake.z))
  // Every cricket stopping only means something where there are crickets: near camp or the shore.
  const crickets = people.some((p) => dist2(p.x, p.z, world.camp.x, world.camp.z) < 100 * 100 || lakeDistance(world.lake, p.x, p.z) < 1.6)
  return UNCANNY_SOUNDS.filter((s) => s !== "far.mimic" && !ds.odd.played.includes(s) && (s !== "far.echo" || lakeD < 360) && (s !== "far.stop" || crickets))
}

/** When an ordinary sound is due: maybe an uncanny one instead. */
function uncanny(ds: DistantState, world: WoodsWorld, people: readonly { x: number; z: number }[], anchor: { x: number; z: number }, dread: number, t: number, rate: number): DistantEvent | null {
  const o = ds.odd
  if (t < o.next || t < UNCANNY_FIRST) return null
  const roll = nextRandom(o.rng)
  if (roll >= uncannyChance(dread) * Math.min(1, rate)) { o.next = t + (30 + 30 * nextRandom(o.rng)) / rate; return null }
  const eligible = uncannyEligible(ds, world, people, anchor)
  if (!eligible.length) { o.next = t + 60; return null }
  let sum = 0
  for (const s of eligible) sum += DISTANT_RULES[s].weight
  let pick = nextRandom(o.rng) * sum, sound = eligible[0]!
  for (const s of eligible) { pick -= DISTANT_RULES[s].weight; if (pick <= 0) { sound = s; break } }
  const e = uncannyNow(ds, world, people, anchor, sound, dread, t)
  if (!e) { o.next = t + 20; return null }
  o.played.push(sound)
  o.next = t + (240 + 240 * nextRandom(o.rng)) / rate
  return e
}

/** Places an uncanny sound now (the schedule, and the Lab's Trigger). */
function uncannyNow(ds: DistantState, world: WoodsWorld, people: readonly { x: number; z: number }[], anchor: { x: number; z: number }, sound: UncannySound, dread: number, t: number): DistantEvent | null {
  const o = ds.odd, rule = DISTANT_RULES[sound]
  let at = sound === "far.taken" ? takenPlace(ds, world, anchor, t) : null
  at ??= place(rule, world, anchor.x, anchor.z, dread, o.rng)
  if (!at) return null
  const takes = sound === "far.echo" || sound === "far.climb" || sound === "far.stop" ? 2 : 3
  const take = Math.min(takes - 1, Math.floor(nextRandom(o.rng) * takes))
  if (sound === "far.taken") {
    // The woods tell a story: whatever did that is out there, and is seen again soon (if there's a light to cross).
    const cs = ds.creature
    cs.next = Math.min(cs.next, t + 50 + 60 * nextRandom(o.rng))
    cs.tryAt = Math.min(cs.tryAt, cs.next)
  }
  return emit(ds, sound, at, take, people, t)
}

/** An animal getting got happens where the creature last crossed, if that was lately and within earshot. */
function takenPlace(ds: DistantState, world: WoodsWorld, anchor: { x: number; z: number }, t: number): [number, number, number] | null {
  const last = ds.creature.last
  if (!last || t - last.at > 600) return null
  const d2 = dist2(last.x, last.z, anchor.x, anchor.z)
  if (d2 < 55 * 55 || d2 > 240 * 240) return null
  for (let i = 0; i < 12; i++) {
    const x = last.x + (nextRandom(ds.odd.rng) - 0.5) * 30, z = last.z + (nextRandom(ds.odd.rng) - 0.5) * 30
    if (lakeDistance(world.lake, x, z) < 1.25 || dist2(x, z, world.camp.x, world.camp.z) < world.camp.radius * world.camp.radius * 1.4) continue
    return [x, terrainHeight(world.terrain, x, z) + DISTANT_RULES["far.taken"].above, z]
  }
  return null
}

/**
 * A searcher (`caller`, a bot or nobody's searcher) just called for Barbara with one of `MIMIC_LINES`, `seconds` long.
 * Once a night, late and far enough out (the same odds as the rest of the uncanny tier), the same call comes back a
 * couple of seconds after it ends, from 150–240 m away on the far side of the person nearest the caller.
 */
export function answerCall(ds: DistantState, world: WoodsWorld, people: readonly { x: number; z: number }[], line: string, caller: { x: number; z: number }, seconds: number, t: number, odd: UncannyFeel = { uncanny: true, uncannyRate: 1 }, force = false): boolean {
  const o = ds.odd, take = (MIMIC_LINES as readonly string[]).indexOf(line)
  if (take < 0 || !people.length || o.mimic) return false
  if (!force) {
    if (!odd.uncanny || odd.uncannyRate <= 0 || t < UNCANNY_FIRST || o.played.includes("far.mimic")) return false
    const { far } = anchorOf(world, people)
    if (nextRandom(o.rng) >= uncannyChance(distantDread(t, far)) * Math.min(1, odd.uncannyRate)) return false
  }
  let near = people[0]!, nd = Infinity
  for (const p of people) { const d = dist2(p.x, p.z, caller.x, caller.z); if (d < nd) { nd = d; near = p } }
  const nl = Math.sqrt(nd)
  // Away from the caller, as seen from that person (straight away when they're on top of each other).
  const vx = nl > 1 ? (near.x - caller.x) / nl : 0, vz = nl > 1 ? (near.z - caller.z) / nl : 1
  const half = world.params.half - 6, rule = DISTANT_RULES["far.mimic"]
  for (let i = 0; i < 16; i++) {
    const side = (nextRandom(o.rng) - 0.5) * 2.4
    let dx = vx - vz * side, dz = vz + vx * side
    const l = Math.sqrt(dx * dx + dz * dz)
    dx /= l; dz /= l
    const r = rule.near + (rule.far - rule.near) * nextRandom(o.rng)
    const x = near.x + dx * r, z = near.z + dz * r
    if (x < -half || x > half || z < -half || z > half || lakeDistance(world.lake, x, z) < 1.25) continue
    if (dist2(x, z, world.camp.x, world.camp.z) < world.camp.radius * world.camp.radius * 1.4) continue
    const at = t + nl / SPEED_OF_SOUND + seconds + 1.2 + 1.6 * nextRandom(o.rng)
    o.mimic = { at: Math.round(at * 1000) / 1000, take, x: Math.round(x * 100) / 100, y: Math.round((terrainHeight(world.terrain, x, z) + rule.above) * 100) / 100, z: Math.round(z * 100) / 100 }
    return true
  }
  return false
}

/** The Lab's Trigger: an uncanny sound placed now by the schedule's rules, ignoring the hour and tonight's list. */
export function triggerUncanny(ds: DistantState, world: WoodsWorld, people: readonly { x: number; z: number }[], sound: Exclude<UncannySound, "far.mimic">, t: number): DistantEvent | null {
  if (!people.length) return null
  const { anchor, far } = anchorOf(world, people)
  return uncannyNow(ds, world, people, anchor, sound, Math.max(0.5, distantDread(t, far)), t)
}

/** An event of a chosen sound placed as the schedule would (auditions, the Lab, the listening page). */
export function placeDistant(world: WoodsWorld, sound: DistantSound, anchor: { x: number; z: number }, t: number, seed: number, dread = 0.5): DistantEvent | null {
  const rng = { seed }
  const at = place(DISTANT_RULES[sound], world, anchor.x, anchor.z, dread, rng)
  return at ? { kind: "distant", sound, x: at[0], y: at[1], z: at[2], at: t, take: Math.min(2, Math.floor(nextRandom(rng) * 3)), seq: -1 } : null
}
