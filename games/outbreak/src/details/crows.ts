import { Rng } from "@arcade/kit/sim/rng"
import type { CrowFlock } from "./placement"

/**
 * Crows on the ground that take off when someone comes close or a gun goes off nearby: presentation only, each
 * client's own (where the flocks sit is seeded in `placeCrowFlocks`; when they fly is local). On the ground the birds
 * peck and hop; startled, each flies out away from the threat and up, flapping, and is gone after a few seconds. A
 * flock comes back a minute or so later once nobody is near.
 */

export type CrowPose = { x: number; y: number; z: number; yaw: number; pitch: number; wings: "folded" | "up" | "down" }

type Bird = { ox: number; oz: number; yaw: number; phase: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }

type FlockState = { flock: CrowFlock; mode: "ground" | "flying" | "gone"; t: number; back: number; birds: Bird[]; rng: Rng }

/** Seconds a startled flock flies before it is out of sight. */
export const CROW_FLIGHT = 3.2
/** A gone flock returns after this long (s, plus up to the same again), once nobody is within `CROW_RETURN_CLEAR` m. */
export const CROW_RETURN = 45
export const CROW_RETURN_CLEAR = 16

export type CrowThreat = { x: number; y: number }
export type CrowNoise = { x: number; y: number; radius: number; kind: string }

export class CrowFlocks {
  private readonly states = new Map<string, FlockState>()
  private key = ""
  /** Called once when a flock takes off (the frame renderer plays wing flaps there). */
  onScatter: ((x: number, z: number, birds: number) => void) | null = null

  /** Replaces the flocks when the town or settings change; flocks that are still there keep their state. */
  setFlocks(key: string, flocks: readonly CrowFlock[]): void {
    if (key === this.key) return
    this.key = key
    const keep = new Map(this.states)
    this.states.clear()
    for (const f of flocks) {
      const old = keep.get(f.key)
      if (old && old.flock.x === f.x && old.flock.z === f.z && old.birds.length === f.birds) {
        this.states.set(f.key, old)
        continue
      }
      const rng = new Rng(f.seed || 1)
      const birds: Bird[] = []
      for (let i = 0; i < f.birds; i++) {
        const a = rng.next() * Math.PI * 2
        const d = 0.25 + rng.next() * 0.9
        const ox = Math.cos(a) * d
        const oz = Math.sin(a) * d
        birds.push({ ox, oz, yaw: rng.next() * Math.PI * 2, phase: rng.next(), x: f.x + ox, y: 0, z: f.z + oz, vx: 0, vy: 0, vz: 0 })
      }
      this.states.set(f.key, { flock: f, mode: "ground", t: 0, back: 0, birds, rng })
    }
  }

  reset(): void {
    this.states.clear()
    this.key = ""
  }

  /** Advances every flock: `threats` are survivors, `noises` this tick's noise events (gunshots scatter within their radius). */
  step(dt: number, time: number, scare: number, threats: readonly CrowThreat[], noises: readonly CrowNoise[]): void {
    for (const st of this.states.values()) {
      const f = st.flock
      if (st.mode === "ground") {
        let threat: CrowThreat | null = null
        for (const t of threats) if (Math.hypot(t.x - f.x, t.y - f.z) < scare) threat = t
        for (const n of noises) {
          const loud = n.kind === "gunshot" || n.kind === "glass" || n.kind === "bash"
          if (loud && Math.hypot(n.x - f.x, n.y - f.z) < Math.min(26, Math.max(scare * 2, n.radius * 0.6))) threat = { x: n.x, y: n.y }
        }
        if (threat) this.scatter(st, threat)
        else this.hop(st, dt, time)
      } else if (st.mode === "flying") {
        st.t += dt
        for (const b of st.birds) {
          b.vy = Math.max(0.6, b.vy - dt * 0.6)
          b.x += b.vx * dt
          b.y += b.vy * dt
          b.z += b.vz * dt
        }
        if (st.t > CROW_FLIGHT) {
          st.mode = "gone"
          st.back = time + CROW_RETURN * (1 + st.rng.next())
        }
      } else if (time > st.back && threats.every((t) => Math.hypot(t.x - f.x, t.y - f.z) > CROW_RETURN_CLEAR)) {
        st.mode = "ground"
        for (const b of st.birds) {
          b.x = f.x + b.ox
          b.z = f.z + b.oz
          b.y = 0
        }
      }
    }
  }

  private scatter(st: FlockState, from: CrowThreat): void {
    st.mode = "flying"
    st.t = 0
    const f = st.flock
    const away = Math.atan2(f.z - from.y, f.x - from.x)
    for (const b of st.birds) {
      const a = away + (st.rng.next() - 0.5) * 1.6
      const speed = 4.5 + st.rng.next() * 2.5
      b.vx = Math.cos(a) * speed
      b.vz = Math.sin(a) * speed
      b.vy = 2.2 + st.rng.next() * 1.4
      b.yaw = a
    }
    this.onScatter?.(f.x, f.z, st.birds.length)
  }

  /** Pecking and the odd hop: each bird turns and shuffles about its spot every couple of seconds. */
  private hop(st: FlockState, dt: number, time: number): void {
    const f = st.flock
    for (const b of st.birds) {
      const beat = Math.floor(time / (1.6 + b.phase * 1.8) + b.phase * 7)
      const r = fract(Math.sin(beat * 12.9898 + b.phase * 78.233) * 43758.5453)
      const tx = f.x + b.ox + (r - 0.5) * 0.5
      const tz = f.z + b.oz + (fract(r * 7.13) - 0.5) * 0.5
      const k = Math.min(1, dt * 6)
      b.x += (tx - b.x) * k
      b.z += (tz - b.z) * k
      b.yaw = r * Math.PI * 2
      b.y = 0
    }
  }

  /** Poses of every visible bird inside `view` ([x0, z0, x1, z1] with a margin), for drawing. */
  poses(time: number, view: readonly [number, number, number, number], out: CrowPose[]): CrowPose[] {
    out.length = 0
    const [x0, z0, x1, z1] = view
    for (const st of this.states.values()) {
      if (st.mode === "gone") continue
      for (const b of st.birds) {
        if (b.x < x0 - 3 || b.x > x1 + 3 || b.z < z0 - 3 || b.z > z1 + 3) continue
        if (st.mode === "ground") {
          // Peck: tip forward in short dips.
          const peck = Math.max(0, Math.sin(time * 5.5 + b.phase * 40)) ** 6
          out.push({ x: b.x, y: 0, z: b.z, yaw: b.yaw, pitch: -0.7 * peck, wings: "folded" })
        } else {
          const flap = Math.floor((st.t * 9 + b.phase) * 2) % 2 === 0
          out.push({ x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: 0.15, wings: flap ? "up" : "down" })
        }
      }
    }
    return out
  }

  /** Readout: flocks on the ground, flying and gone. */
  counts(): { ground: number; flying: number; gone: number } {
    const c = { ground: 0, flying: 0, gone: 0 }
    for (const st of this.states.values()) c[st.mode]++
    return c
  }
}

const fract = (v: number) => v - Math.floor(v)
