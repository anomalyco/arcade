import { terrainHeight, type WoodsWorld } from "./world"

/**
 * The night's distant sounds: a seeded schedule every player hears at the same time and world position. Hook for the
 * audio layer: `stepWoods` emits `{ kind: "sound", sound }` when the room's clock passes each one (rooms broadcast it
 * with the other events), and `soundsBetween` lists what is coming for scheduling ahead. Pure and O(1) per sound, so a
 * late joiner, the room and every client agree without sending the schedule.
 *
 * `kind` is a cue name for the audio agent to map onto real sounds; positions are metres in world space (x east,
 * z south, y up).
 */
export const DISTANT_KINDS = ["owl", "loon", "branch-crack", "coyote", "knock", "camp-bell", "radio-static"] as const
export type DistantKind = (typeof DISTANT_KINDS)[number]
export type DistantSound = { id: number; kind: DistantKind; at: number; x: number; y: number; z: number; /** 0..1 loudness at the source. */ gain: number }

/** Seconds between sounds on average; each sits at a seeded point inside its own slot, so the order never changes. */
export const SOUND_SPACING = 32
const FIRST = 20

function hash(seed: number, k: number, salt: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(k | 0, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const WEIGHTS: readonly [DistantKind, number][] = [["owl", 5], ["branch-crack", 4], ["loon", 3], ["knock", 2], ["coyote", 2], ["camp-bell", 1], ["radio-static", 1]]
const TOTAL = WEIGHTS.reduce((a, w) => a + w[1], 0)

/** The `k`th distant sound of a night seeded `seed`. */
export function soundAt(seed: number, k: number, world: WoodsWorld): DistantSound {
  const at = FIRST + k * SOUND_SPACING + hash(seed, k, 1) * SOUND_SPACING * 0.85
  let pick = hash(seed, k, 2) * TOTAL, kind: DistantKind = "owl"
  for (const [name, w] of WEIGHTS) { if (pick < w) { kind = name; break } pick -= w }
  const u = hash(seed, k, 3) * 2 - 1, v = hash(seed, k, 4) * 2 - 1, h = world.params.half
  let x = u * (h - 10), z = v * (h - 10), up = 4 + hash(seed, k, 5) * 8, gain = 0.5 + hash(seed, k, 6) * 0.5
  const L = world.lake, c = world.camp, r = world.ridgeLight
  // Some sounds belong to a place.
  if (kind === "loon") { x = L.x + u * L.rx * 0.8; z = L.z + v * L.rz * 0.8; up = 0.3 }
  else if (kind === "camp-bell") { x = c.x - 18; z = c.z - 9; up = 3.5; gain = 0.8 }
  else if (kind === "radio-static") { x = r.x; z = r.z; up = 2; gain = 0.6 }
  else if (kind === "coyote") { const s = Math.abs(u) > Math.abs(v) ? Math.sign(u) : 0, t = s ? 0 : Math.sign(v) || 1; x = s ? s * (h - 4) : x; z = t && !s ? t * (h - 4) : z; up = 1 }
  else if (kind === "branch-crack" || kind === "knock") up = 1 + hash(seed, k, 5) * 3
  return { id: k, kind, at, x, y: terrainHeight(world.terrain, x, z) + up, z, gain }
}

/** Every sound with `from ≤ at < to` (for scheduling ahead of the room's events). */
export function soundsBetween(seed: number, from: number, to: number, world: WoodsWorld): DistantSound[] {
  const out: DistantSound[] = []
  let k = Math.max(0, Math.floor((from - FIRST) / SOUND_SPACING) - 1)
  for (;; k++) {
    const s = soundAt(seed, k, world)
    if (s.at >= to) break
    if (s.at >= from) out.push(s)
  }
  return out
}
