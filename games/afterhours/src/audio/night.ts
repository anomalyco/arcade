import { BUILDING, FENCE } from "../world/layout"
import type { LoopVoice, Sfx } from "./engine"
import type { SfxId } from "./sfx-manifest"

// The outdoor night, built from parts instead of one noise bed (the forest-night bed read as highway noise):
//  - wind in the pines: a very quiet, airy stereo bed (high-passed at build time, so no low roar) whose level gusts
//    on a slow random walk; gusts now and then shake a nearby bough (a rustle) or make a trunk creak;
//  - sparse one-shots in the trees around the player at random intervals: rustles, twig snaps, trunk creaks, a pine
//    cone dropping, a distant owl, very rarely a far-off coyote or dog. No insects: it is a cold, foggy night.
// One-shots are placed in the forest (beyond the compound's fence, at least MIN_DIST away), panned and attenuated by
// distance, duller the further away (air), with random pitch, gain and variant. The building muffles all of it: a
// source behind the building (as seen from the listener) is quieter and low-passed, and indoors everything is faint
// and dull. Trunk colliders are not counted as walls for these (they would bury every source in the trees).
// `?night=<s>` (automation only) sets the first one-shot's delay; `log` records what fired.

type Kind = {
  id: SfxId
  /** Mean seconds between events outdoors (exponential intervals). */
  every: number
  /** Distance range (m) from the listener, and height above the ear's ground. */
  near: number
  far: number
  height: [number, number]
  gain: number
  /** Panner reference distance (m) and rolloff: how far the take carries. Rolloffs under 1 compress distance, so the
   *  trees 25–110 m from the middle of the compound's clearing still reach the player. */
  ref: number
  rolloff: number
  jitter: number
}

const KINDS: Kind[] = [
  { id: "out-rustle", every: 11, near: 16, far: 45, height: [0.2, 4], gain: 0.55, ref: 6, rolloff: 0.45, jitter: 0.08 },
  { id: "out-twig", every: 17, near: 18, far: 50, height: [0, 0.3], gain: 0.6, ref: 6, rolloff: 0.45, jitter: 0.1 },
  { id: "out-creak", every: 21, near: 20, far: 60, height: [3, 12], gain: 0.55, ref: 10, rolloff: 0.4, jitter: 0.07 },
  { id: "out-cone", every: 34, near: 16, far: 40, height: [0, 1], gain: 0.55, ref: 5, rolloff: 0.5, jitter: 0.08 },
  { id: "out-owl", every: 55, near: 60, far: 140, height: [8, 18], gain: 0.5, ref: 30, rolloff: 0.5, jitter: 0.04 },
  { id: "out-far-animal", every: 200, near: 180, far: 200, height: [0, 2], gain: 0.4, ref: 60, rolloff: 0.6, jitter: 0.05 },
]

const MIN_DIST = 16
const MIN_GAP = 2.5
const WIND_LEVEL = 0.55
/** Building footprints (x/z) that shadow sources behind them. */
const BLOCKS = [BUILDING.main, BUILDING.annex]

export class NightOutdoors {
  private wind: LoopVoice
  private gust = 0.6
  private gustTarget = 0.6
  private nextGust = 0
  private next = new Map<SfxId, number>()
  private lastAny = -1e9
  private time = 0
  /** Automation: one-shots fired. */
  readonly log: { t: number; id: SfxId; d: number; muffled: boolean }[] = []

  constructor(
    private sfx: Sfx,
    params: URLSearchParams,
  ) {
    this.wind = sfx.loop("amb-pine-wind", { bus: "ambience" })
    const first = Number(params.get("night"))
    const start = params.has("night") && Number.isFinite(first) ? first : 6
    KINDS.forEach((k, i) => this.next.set(k.id, start + i * 1.5 + this.interval(k)))
    // The first event comes at `start`; the rest follow at their own rates.
    this.next.set(KINDS[0]!.id, start)
  }

  private interval(k: Kind) {
    return -Math.log(1 - Math.random()) * k.every
  }

  update(dt: number, ear: { x: number; y: number; z: number }, indoor: number) {
    this.time += dt
    const now = this.time
    const out = 1 - indoor

    // Wind: a slow random walk between calm and gusts, sheltered near the building's walls and dull indoors.
    if (now >= this.nextGust) {
      // Lulls (near still) and gusts alternate; each holds 3–9 s and the level glides between them.
      const lull = this.gustTarget > 0.5 ? Math.random() < 0.6 : Math.random() < 0.25
      this.nextGust = now + 3 + Math.random() * 6
      this.gustTarget = lull ? 0.1 + Math.random() * 0.2 : 0.6 + Math.random() * 0.4
      if (this.gustTarget > 0.85 && out > 0.5 && Math.random() < 0.5) this.fire(KINDS[Math.random() < 0.7 ? 0 : 2]!, ear, indoor, 12, 30)
    }
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-dt / 1.6))
    const shelter = 1 - 0.5 * Math.max(0, 1 - this.wallDistance(ear) / 10)
    this.wind.set(WIND_LEVEL * this.gust * shelter * (0.06 + 0.94 * out), 20000 * out + 900 * indoor)
    this.wind.update(dt, now)

    // One-shots: indoors only the carrying ones (owl, far animals) get through, faint and dull.
    for (const k of KINDS) {
      const at = this.next.get(k.id)!
      if (now < at) continue
      const rate = indoor > 0.5 ? (k.ref >= 25 ? 0.5 : 0) : 1
      this.next.set(k.id, now + this.interval(k) / Math.max(0.05, rate))
      if (rate === 0 || now - this.lastAny < MIN_GAP) continue
      this.fire(k, ear, indoor)
    }
  }

  private fire(k: Kind, ear: { x: number; y: number; z: number }, indoor: number, near = k.near, far = k.far) {
    const p = this.placeInTrees(ear, near, far)
    if (!p) return
    const ground = ear.y - 1.6
    const pos = { x: p.x, y: ground + k.height[0] + Math.random() * (k.height[1] - k.height[0]), z: p.z }
    const d = Math.hypot(pos.x - ear.x, pos.z - ear.z)
    const behind = this.blocked(ear, pos)
    let gain = k.gain * (0.7 + Math.random() * 0.45)
    // Air absorption: highs fall away with distance.
    let lowpass = 16000 / (1 + d / 45)
    if (behind) {
      gain *= 0.4
      lowpass = Math.min(lowpass, 1100)
    }
    gain *= 1 - 0.85 * indoor
    if (indoor > 0.5) lowpass = Math.min(lowpass, 600)
    const src = this.sfx.play(k.id, { bus: "ambience", pos, ref: k.ref, rolloff: k.rolloff, gain, lowpass, jitter: k.jitter, occlude: false })
    if (!src) return
    this.lastAny = this.time
    this.log.push({ t: +this.time.toFixed(1), id: k.id, d: Math.round(d), muffled: behind || indoor > 0.5 })
  }

  /** A point in the forest within [near, far]: the trees start 10–15 m beyond the fence, so from inside the compound
   *  the bearing leans towards the nearest treeline (best of three random bearings). */
  private placeInTrees(ear: { x: number; z: number }, near: number, far: number) {
    for (let tries = 0; tries < 8; tries++) {
      let dx = 0
      let dz = 0
      let exit = Infinity
      for (let k = 0; k < 3; k++) {
        const a = Math.random() * Math.PI * 2
        const e = this.exitDistance(ear, Math.cos(a), Math.sin(a))
        if (e < exit) [exit, dx, dz] = [e, Math.cos(a), Math.sin(a)]
      }
      const lo = Math.max(MIN_DIST, near, exit + (exit > 0 ? 14 : 0))
      const hi = Math.max(lo + 5, far, exit + 30)
      if (lo > 220) continue
      const d = lo + Math.random() * (hi - lo)
      return { x: ear.x + dx * d, z: ear.z + dz * d }
    }
    return null
  }

  private exitDistance(p: { x: number; z: number }, dx: number, dz: number) {
    const [x0, z0] = FENCE.min
    const [x1, z1] = FENCE.max
    if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) return 0
    const tx = dx > 0 ? (x1 - p.x) / dx : dx < 0 ? (x0 - p.x) / dx : Infinity
    const tz = dz > 0 ? (z1 - p.z) / dz : dz < 0 ? (z0 - p.z) / dz : Infinity
    return Math.min(tx, tz)
  }

  /** Whether the building stands between the listener and a source (2D segment vs footprint). */
  private blocked(a: { x: number; z: number }, b: { x: number; z: number }) {
    for (const r of BLOCKS) {
      let t0 = 0
      let t1 = 1
      const o = [a.x, a.z]
      const dd = [b.x - a.x, b.z - a.z]
      let hit = true
      for (let i = 0; i < 2 && hit; i++) {
        const lo = r.min[i]!
        const hi = r.max[i]!
        if (Math.abs(dd[i]!) < 1e-9) {
          if (o[i]! < lo || o[i]! > hi) hit = false
          continue
        }
        let u = (lo - o[i]!) / dd[i]!
        let v = (hi - o[i]!) / dd[i]!
        if (u > v) [u, v] = [v, u]
        t0 = Math.max(t0, u)
        t1 = Math.min(t1, v)
        if (t0 > t1) hit = false
      }
      if (hit && t0 > 0) return true
    }
    return false
  }

  /** Distance (m) from the listener to the nearest building wall (0 inside). */
  private wallDistance(p: { x: number; z: number }) {
    let best = Infinity
    for (const r of BLOCKS) {
      const dx = Math.max(r.min[0] - p.x, 0, p.x - r.max[0])
      const dz = Math.max(r.min[1] - p.z, 0, p.z - r.max[1])
      best = Math.min(best, Math.hypot(dx, dz))
    }
    return best
  }
}
