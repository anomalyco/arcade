import { Rng } from "@arcade/kit/sim/rng"
import { SIZE, type Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { detailRng } from "./placement"
import { putSprite } from "./light-probe"
import type { OutbreakDetailSettings } from "./settings"

/**
 * Eyes under the trees: animals sitting at the foot of a tree out in the yards, seen only as a pair of eyes when a
 * torch finds them (the tapetum throws the light straight back). Caught in the beam they hold still a moment, blink,
 * turn and are gone; someone walking up or a gunshot sends them off sooner. They come back a few minutes later once
 * nobody is near. Where they sit is seeded from the town (co-op clients agree); when they bolt is each client's own.
 *
 * Once in a while, from the second night on, one pair sits higher than any animal's and does not run from the light.
 * It is simply not there any more when you get close.
 */

export type AnimalKind = "raccoon" | "fox" | "deer" | "cat" | "watcher"

type Species = { eyeY: number; spacing: number; size: number; tint: readonly [number, number, number]; gain: number; holdMin: number; holdMax: number; flee: number }

/** Eye spacing and size are wider and softer than life, so a pair still reads as two points from the game camera. */
export const SPECIES: Readonly<Record<AnimalKind, Species>> = {
  raccoon: { eyeY: 0.24, spacing: 0.08, size: 0.085, tint: [1, 0.78, 0.36], gain: 1, holdMin: 0.8, holdMax: 1.8, flee: 6 },
  fox: { eyeY: 0.34, spacing: 0.09, size: 0.085, tint: [1, 0.86, 0.5], gain: 1, holdMin: 0.5, holdMax: 1.2, flee: 8 },
  deer: { eyeY: 1.25, spacing: 0.16, size: 0.1, tint: [0.92, 1, 0.84], gain: 1.1, holdMin: 1.2, holdMax: 2.6, flee: 11 },
  cat: { eyeY: 0.2, spacing: 0.07, size: 0.075, tint: [0.84, 1, 0.62], gain: 0.9, holdMin: 1, holdMax: 3, flee: 5 },
  // Never fades from the light; gone without a sound when someone comes within `flee`.
  watcher: { eyeY: 1.62, spacing: 0.1, size: 0.075, tint: [0.95, 0.9, 0.78], gain: 0.55, holdMin: Infinity, holdMax: Infinity, flee: 9 },
}

export type AnimalDen = { key: string; kind: AnimalKind; x: number; z: number; seed: number }

const fold = (v: number) => ((v % SIZE) + SIZE) % SIZE
const onRoad = (x: number, z: number) => {
  const lx = fold(x)
  const lz = fold(z)
  return (lx > 37.5 && lx < 50.5) || (lz > 37.5 && lz < 50.5)
}

/** Dens at the crown's edge of yard trees well away from walls and roads; at most one watcher, at the loneliest tree. */
export function placeDens(town: Town, s: Pick<OutbreakDetailSettings, "lifeTouches" | "lfEyeshine" | "lfWatcher" | "dtSeed">): AnimalDen[] {
  const out: AnimalDen[] = []
  if (!s.lifeTouches) return out
  let lonely: { x: number; z: number; d: number; key: string } | null = null
  for (const p of town.props) {
    if (p.kind !== "tree" || onRoad(p.x, p.y)) continue
    let near = Infinity
    for (const b of town.buildings) {
      const r = b.rect
      const dx = Math.max(r[0] - p.x, 0, p.x - r[2])
      const dz = Math.max(r[1] - p.y, 0, p.y - r[3])
      near = Math.min(near, Math.hypot(dx, dz) - (b.kind === "house" ? 0 : 2))
    }
    if (near < 5) continue
    const key = `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`
    if (!lonely || near > lonely.d) lonely = { x: p.x, z: p.y, d: near, key }
    if (s.lfEyeshine <= 0) continue
    const r = detailRng(town, s.dtSeed, `den:${key}`)
    if (r.next() >= Math.min(0.9, 0.2 * s.lfEyeshine)) continue
    const pick = r.next()
    const kind: AnimalKind = pick < 0.38 ? "raccoon" : pick < 0.62 ? "fox" : pick < 0.86 ? "deer" : "cat"
    // At the edge of the crown on its south side: the camera looks north and down, so anything under the crown or
    // north of the trunk is hidden by the leaves.
    const a = Math.PI / 4 + r.next() * (Math.PI / 2)
    const d = 2.1 + r.next() * 0.8
    out.push({ key, kind, x: p.x + Math.cos(a) * d, z: p.y + Math.sin(a) * d, seed: Math.floor(r.next() * 4294967296) >>> 0 })
  }
  if (s.lfWatcher && lonely && lonely.d > 8) {
    const r = detailRng(town, s.dtSeed, `watcher:${lonely.key}`)
    if (r.next() < 0.5) {
      const a = Math.PI / 3 + r.next() * (Math.PI / 3)
      out.push({ key: `watcher:${lonely.key}`, kind: "watcher", x: lonely.x + Math.cos(a) * 2.2, z: lonely.z + Math.sin(a) * 2.2, seed: Math.floor(r.next() * 4294967296) >>> 0 })
    }
  }
  return out
}

function nearest(survivors: readonly { x: number; y: number }[], x: number, z: number): number {
  let d = Infinity
  for (const s of survivors) d = Math.min(d, Math.hypot(s.x - x, s.y - z))
  return d
}

type DenState = { den: AnimalDen; mode: "here" | "bolting" | "gone"; lit: number; hold: number; t: number; back: number; rng: Rng; lastBeam: number }

/** Seconds a bolting animal's eyes take to blink, turn and go. */
export const BOLT_TIME = 0.42
/** A bolted animal is back after this long (s, plus up to the same again), once nobody is within `DEN_CLEAR` m. */
export const DEN_RETURN = 150
export const DEN_CLEAR = 18

export type EyeFrame = {
  dt: number
  time: number
  /** 0..1, how dark it is: animals only sit out at night. */
  darkness: number
  /** Which night it is (the watcher waits for the second). */
  night: number
  survivors: readonly { x: number; y: number }[]
  noises: readonly { x: number; y: number; radius: number; kind: string }[]
  /** Torchlight at a point (BeamProbe), and the direction to the strongest torch's lens from there. */
  beam: (x: number, y: number, z: number) => number
  beamFrom: { x: number; z: number }
}

export class AnimalEyes {
  private readonly states = new Map<string, DenState>()
  private key = ""
  /** Called once when an animal bolts (rustle, scurry or hooves for the audio layer). */
  onBolt: ((x: number, z: number, kind: AnimalKind) => void) | null = null
  /** Readout: dens, eyes drawn last frame, bolts so far. */
  readonly shown = { dens: 0, eyes: 0, bolts: 0 }

  setDens(key: string, dens: readonly AnimalDen[]): void {
    if (key === this.key) return
    this.key = key
    const keep = new Map(this.states)
    this.states.clear()
    for (const d of dens) {
      const old = keep.get(d.key)
      if (old && old.den.x === d.x && old.den.z === d.z && old.den.kind === d.kind) this.states.set(d.key, old)
      else this.states.set(d.key, { den: d, mode: "here", lit: 0, hold: 0, t: 0, back: 0, rng: new Rng(d.seed || 1), lastBeam: 0 })
    }
    this.shown.dens = this.states.size
  }

  reset(): void {
    this.states.clear()
    this.key = ""
  }

  /** Mode of a den (tests and the harness). */
  modeOf(key: string): DenState["mode"] | undefined {
    return this.states.get(key)?.mode
  }

  step(f: EyeFrame): void {
    for (const st of this.states.values()) {
      const d = st.den
      const sp = SPECIES[d.kind]
      if (st.mode === "gone") {
        if (f.time > st.back && nearest(f.survivors, d.x, d.z) > DEN_CLEAR) {
          st.mode = "here"
          st.lit = 0
        }
        continue
      }
      if (st.mode === "bolting") {
        st.t += f.dt
        if (st.t > BOLT_TIME) this.leave(st, f.time)
        continue
      }
      const near = nearest(f.survivors, d.x, d.z)
      if (d.kind === "watcher") {
        if (near < sp.flee) this.leave(st, f.time)
        continue
      }
      st.lastBeam = f.darkness > 0.55 ? f.beam(d.x, sp.eyeY, d.z) : 0
      if (st.lastBeam > 0.12) {
        if (st.lit === 0) st.hold = sp.holdMin + st.rng.next() * (sp.holdMax - sp.holdMin)
        st.lit += f.dt
      } else st.lit = Math.max(0, st.lit - f.dt * 0.5)
      let loud = false
      for (const n of f.noises) if ((n.kind === "gunshot" || n.kind === "glass" || n.kind === "bash") && Math.hypot(n.x - d.x, n.y - d.z) < Math.min(24, n.radius * 0.7)) loud = true
      if (near < sp.flee || loud || (st.lit > 0 && st.lit > st.hold)) {
        st.mode = "bolting"
        st.t = 0
        this.shown.bolts++
        this.onBolt?.(d.x, d.z, d.kind)
      }
    }
  }

  private leave(st: DenState, time: number): void {
    st.mode = "gone"
    st.lit = 0
    // The watcher keeps away until another night; animals a few minutes.
    st.back = time + (st.den.kind === "watcher" ? 1e9 : DEN_RETURN * (1 + st.rng.next()))
  }

  /** The watcher comes back once per new night (the caller passes the night it last saw). */
  newNight(): void {
    for (const st of this.states.values()) if (st.den.kind === "watcher" && st.mode === "gone") st.back = 0
  }

  /**
   * Additive eye sprites for every den in `view` caught by a torch. The pair sits across the line to the torch, blinks
   * now and then, and while bolting flickers out as the head turns away. Returns the new sprite count.
   */
  write(f: EyeFrame, town: Town, view: readonly [number, number, number, number], sprites: Float32Array, n: number, gain: number): number {
    const [x0, z0, x1, z1] = view
    this.shown.eyes = 0
    for (const st of this.states.values()) {
      if (st.mode === "gone") continue
      const d = st.den
      if (d.x < x0 - 1 || d.x > x1 + 1 || d.z < z0 - 1 || d.z > z1 + 1) continue
      const sp = SPECIES[d.kind]
      if (d.kind === "watcher" && (f.night < 2 || f.darkness < 0.85)) continue
      if (f.darkness < 0.55) continue
      const gy = supportHeight(town, d.x, d.z)
      const beam = f.beam(d.x, gy + sp.eyeY, d.z)
      if (beam <= 0.04) continue
      // A blink every few seconds; bolting, the eyes go out, flash once as the head turns, and are gone.
      const phase = (d.seed % 1000) / 1000
      const cycle = f.time / (3.2 + phase * 3) + phase * 11
      const blink = cycle - Math.floor(cycle) < 0.035 ? 0 : 1
      let on = blink
      let shift = 0
      if (st.mode === "bolting") {
        const u = st.t / BOLT_TIME
        on = u < 0.3 ? 0 : u < 0.6 ? 0.45 : 0
        shift = u * 0.35
      }
      if (on <= 0) continue
      const tx = f.beamFrom.x - d.x
      const tz = f.beamFrom.z - d.z
      const tl = Math.hypot(tx, tz) || 1
      // Across the line to the torch, with a slow head tilt.
      const tilt = 0.25 * Math.sin(f.time * 0.4 + phase * 9)
      const ax = (-tz / tl) * Math.cos(tilt) - (tx / tl) * Math.sin(tilt) * 0.3
      const az = (tx / tl) * Math.cos(tilt) - (tz / tl) * Math.sin(tilt) * 0.3
      const cx = d.x + (-tx / tl) * shift
      const cz = d.z + (-tz / tl) * shift
      const k = (Math.min(1, beam * 1.6) * sp.gain * gain * on * 0.8) / 0.25
      const h = sp.spacing / 2
      const y = gy + sp.eyeY
      n = putSprite(sprites, n, cx - ax * h, y, cz - az * h, sp.size, sp.tint[0] * k, sp.tint[1] * k, sp.tint[2] * k, 0.25)
      n = putSprite(sprites, n, cx + ax * h, y, cz + az * h, sp.size, sp.tint[0] * k, sp.tint[1] * k, sp.tint[2] * k, 0.25)
      this.shown.eyes++
    }
    return n
  }
}
