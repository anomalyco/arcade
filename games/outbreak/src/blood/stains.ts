import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { rayRect, type Rect } from "@arcade/kit/sim/geom"
import type { Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { ambientBloodKey, FLOOR_LIFT, placeAmbientBlood, WALL_LIFT, type BloodStamp } from "./placement"
import type { OutbreakBloodSettings } from "./settings"
import { BLOOD_VARIANTS, buildBloodMeshes, GRIME_VARIANTS, type BloodKind } from "./shapes"

/** Most fight stains the ring can ever hold (Blood › Fight stain budget picks how many of them are used). */
export const BLOOD_RING_MAX = 512

type ZombieLike = { readonly id: number; readonly x: number; readonly y: number; readonly hp: number; readonly state: string }
type Point = { readonly x: number; readonly y: number }

export type BloodFrame = {
  readonly dt: number
  readonly town: Town
  readonly zombies: readonly ZombieLike[]
  /** Every survivor (attackers for the spray direction). */
  readonly survivors: readonly Point[]
  /** The local survivor: footprints and the drops when they are hurt. */
  readonly player: Point & { readonly health: number; readonly vehicleId?: number | null }
  readonly settings: OutbreakBloodSettings
}

/** One persistent fight stain: a slot in the ring, reused oldest-first. */
type FightStain = {
  kind: BloodKind
  variant: number
  x: number
  y: number
  z: number
  yaw: number
  scale: number
  born: number
  grow: number
  wall: boolean
  grime: number
}

type Tracked = { hp: number; state: string; ax: number; ay: number; hits: number; dirX: number; dirY: number; seen: number }

const PITCH_WALL = 0
const ROLL_WALL = Math.PI / 2

/** Small deterministic hash for per-event variants (no Math.random in presentation that proofs compare). */
function mix32(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/**
 * Outbreak's persistent blood (Blood in the Lab): the town's seeded old stains plus the stains fights leave behind,
 * drawn as painted flat meshes through the scene shader, so they take colour only where light lands and go grey
 * in the shroud like the floor under them. Fight stains live in a fixed ring of `bloodBudget` slots that reuses the
 * oldest, pools spread under bodies over `bloodPoolSpread` seconds, crawlers smear drag trails, a survivor who steps
 * in a pool prints a few fading shoe prints, and a hit next to a wall throws a splat up it. The wet transient spray
 * stays the kit Splatter in `combat-fx.ts`.
 */
export class BloodStains {
  private readonly models = new Map<string, number>()
  private readonly batchData = new Map<number, { data: Float32Array<ArrayBuffer>; count: number }>()
  private readonly batches: Batch[] = []
  private builtValue = Number.NaN

  private ambientKey = ""
  private ambient: BloodStamp[] = []
  private ambientPools: BloodStamp[] = []

  private readonly ring: FightStain[] = []
  private head = 0
  private used = 0
  private clock = 0
  private frame = 0

  private readonly tracked = new Map<number, Tracked>()
  private prevHealth = -1
  private footLeft = 0
  private footSide = 0
  private footAx = 0
  private footAy = 0
  private footArmed = false

  /** Proof readout. */
  readonly counts = { ambient: 0, fight: 0, drawn: 0, emitted: 0, recycled: 0 }

  constructor(private readonly renderer: Pick<Renderer, "addModel" | "setModel">) {
    for (let i = 0; i < BLOOD_RING_MAX; i++)
      this.ring.push({ kind: "splat", variant: 0, x: 0, y: 0, z: 0, yaw: 0, scale: 0, born: 0, grow: 0, wall: false, grime: -1 })
    this.ensureModels(1)
  }

  private ensureModels(value: number): void {
    if (value === this.builtValue) return
    this.builtValue = value
    for (const b of buildBloodMeshes(value)) {
      const key = `${b.kind}:${b.variant}`
      const existing = this.models.get(key)
      if (existing === undefined) this.models.set(key, this.renderer.addModel(b.mesh))
      else this.renderer.setModel(existing, b.mesh)
    }
  }

  /** Clears the fight stains and the edge state (a new session or a regenerated town); the seeded stains stay. */
  reset(): void {
    this.head = 0
    this.used = 0
    this.tracked.clear()
    this.prevHealth = -1
    this.footLeft = 0
    this.footArmed = false
    this.counts.fight = 0
    this.counts.emitted = 0
    this.counts.recycled = 0
  }

  /** Live fight stains, oldest first (tests and proofs). */
  fightStains(): readonly Readonly<FightStain>[] {
    const out: FightStain[] = []
    const n = this.used
    for (let i = 0; i < n; i++) out.push(this.ring[(this.head - n + i + BLOOD_RING_MAX * 2) % BLOOD_RING_MAX]!)
    return out
  }

  ambientStamps(): readonly BloodStamp[] {
    return this.ambient
  }

  /** Writes one fight stain into the ring, reusing the oldest slot once `budget` are live. */
  stamp(kind: BloodKind, x: number, y: number, z: number, yaw: number, scale: number, opts: { variant?: number; grow?: number; wall?: boolean; grime?: number; budget: number }): void {
    const budget = Math.max(1, Math.min(BLOOD_RING_MAX, Math.round(opts.budget)))
    if (this.used >= budget) {
      this.counts.recycled++
      this.used = budget - 1
    }
    const slot = this.ring[this.head]!
    this.head = (this.head + 1) % BLOOD_RING_MAX
    this.used++
    slot.kind = kind
    slot.variant = (opts.variant ?? 0) % BLOOD_VARIANTS[kind]
    slot.x = x
    slot.y = y
    slot.z = z
    slot.yaw = yaw
    slot.scale = scale
    slot.born = this.clock
    slot.grow = opts.grow ?? 0
    slot.wall = opts.wall ?? false
    slot.grime = opts.grime ?? -1
    this.counts.emitted++
  }

  private floorStamp(f: BloodFrame, kind: BloodKind, x: number, z: number, yaw: number, scale: number, key: number, grow = 0): void {
    const s = f.settings
    const r = 0.4 * scale
    let y = supportHeight(f.town, x, z)
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) y = Math.max(y, supportHeight(f.town, x + dx, z + dz))
    const layer = (this.counts.emitted % 8) * 0.0007
    const grime = kind !== "foot" && kind !== "pool" && mix32(key, 91) < s.bloodGrime * 0.6 ? Math.floor(mix32(key, 92) * GRIME_VARIANTS) : -1
    this.stamp(kind, x, y + FLOOR_LIFT + 0.0035 + layer, z, yaw, scale, {
      variant: Math.floor(mix32(key, 7) * 97),
      grow,
      grime,
      budget: s.bloodBudget,
    })
  }

  /** A pool spreading under a survivor who went down or died (AR-61). */
  survivorPool(town: Town, settings: OutbreakBloodSettings, x: number, y: number, key: number): void {
    if (settings.bloodPoolSize <= 0) return
    const sc = settings.bloodPoolSize * (1 + mix32(key, 8) * 0.3)
    this.floorStamp({ dt: 0, town, zombies: [], survivors: [], player: { x, y, health: 0 }, settings }, "pool", x, y, mix32(key, 9) * 6.28, sc, key ^ 0x51, Math.max(0.1, settings.bloodPoolSpread))
  }

  /** A smear behind a downed survivor dragging themselves from (x0, y0) to (x1, y1). */
  survivorDrag(town: Town, settings: OutbreakBloodSettings, x0: number, y0: number, x1: number, y1: number, key: number): void {
    if (!settings.bloodTrails) return
    this.floorStamp({ dt: 0, town, zombies: [], survivors: [], player: { x: x1, y: y1, health: 0 }, settings }, "drag", (x0 + x1) / 2, (y0 + y1) / 2, Math.atan2(y1 - y0, x1 - x0), 0.62, key ^ 0x77)
  }

  /** A splat up the first wall or shut door within reach of a hit, facing back toward it. */
  private wallSplat(f: BloodFrame, x: number, y: number, dx: number, dy: number, key: number): void {
    const reach = 1.7
    let best = reach
    let hitRect: Rect | null = null
    const consider = (r: Rect) => {
      if (r[2] < x - reach || r[0] > x + reach || r[3] < y - reach || r[1] > y + reach) return
      const t = rayRect(x, y, dx, dy, r, best)
      if (t < best) {
        best = t
        hitRect = r
      }
    }
    for (const b of f.town.barriers) if (b.kind === "wall") consider(b.rect)
    for (const d of f.town.doors) if (!d.open) consider(d.rect)
    const r = hitRect as Rect | null
    if (!r || best < 0.05) return
    const px = x + dx * best
    const pz = y + dy * best
    const e = 0.02
    const nx = Math.abs(px - r[0]) < e ? -1 : Math.abs(px - r[2]) < e ? 1 : 0
    const nz = nx !== 0 ? 0 : Math.abs(pz - r[1]) < e ? -1 : Math.abs(pz - r[3]) < e ? 1 : 0
    if (nx === 0 && nz === 0) return
    const ground = supportHeight(f.town, x, y)
    const h = ground + 0.55 + mix32(key, 3) * 0.75
    const kind: BloodKind = mix32(key, 4) < 0.8 ? "wallSplat" : "wallSmear"
    this.stamp(kind, px + nx * WALL_LIFT, h, pz + nz * WALL_LIFT, Math.atan2(-nx, nz), 0.75 + mix32(key, 5) * 0.45 * (1.7 - best) / 1.7, {
      variant: Math.floor(mix32(key, 6) * 97),
      wall: true,
      budget: f.settings.bloodBudget,
    })
  }

  /** Watches the zombies and the local survivor for the moments that leave blood behind. */
  observe(f: BloodFrame): void {
    this.clock += Math.max(0, f.dt)
    this.frame++
    const s = f.settings
    if (!s.bloodPersist) {
      this.tracked.clear()
      this.prevHealth = f.player.health
      return
    }
    for (const z of f.zombies) {
      const t = this.tracked.get(z.id)
      if (!t) {
        this.tracked.set(z.id, { hp: z.hp, state: z.state, ax: z.x, ay: z.y, hits: 0, dirX: 1, dirY: 0, seen: this.frame })
        continue
      }
      t.seen = this.frame
      const key = Math.imul(z.id + 1, 0x9e3779b1) ^ (this.counts.emitted * 0x85ebca6b)
      const hit = z.hp < t.hp - 0.01 && t.state !== "dead"
      const died = z.state === "dead" && t.state !== "dead"
      if (hit || died) {
        let ax = z.x - 1
        let ay = z.y
        let bd = Infinity
        for (const v of f.survivors) {
          const d = Math.hypot(z.x - v.x, z.y - v.y)
          if (d < bd) {
            bd = d
            ax = v.x
            ay = v.y
          }
        }
        const len = Math.hypot(z.x - ax, z.y - ay) || 1
        t.dirX = (z.x - ax) / len
        t.dirY = (z.y - ay) / len
        t.hits++
        const yaw = Math.atan2(t.dirY, t.dirX)
        const sc = 0.75 + mix32(key, 1) * 0.4
        this.floorStamp(f, "splat", z.x + t.dirX * 0.42 * sc, z.y + t.dirY * 0.42 * sc, yaw + (mix32(key, 2) - 0.5) * 0.4, sc, key)
        this.wallSplat(f, z.x, z.y, t.dirX, t.dirY, key)
      }
      if (died && s.bloodPoolSize > 0) {
        const sc = s.bloodPoolSize * (0.9 + mix32(key, 8) * 0.35)
        this.floorStamp(f, "pool", z.x + t.dirX * 0.35, z.y + t.dirY * 0.35, mix32(key, 9) * 6.28, sc, key ^ 0x51, Math.max(0.1, s.bloodPoolSpread))
      }
      const moved = Math.hypot(z.x - t.ax, z.y - t.ay)
      if (z.state === "crawler" && s.bloodTrails) {
        if (moved > 0.55) {
          const yaw = Math.atan2(z.y - t.ay, z.x - t.ax)
          this.floorStamp(f, "drag", (z.x + t.ax) / 2, (z.y + t.ay) / 2, yaw, 0.62, key ^ 0x77)
          t.ax = z.x
          t.ay = z.y
        }
      } else if (z.state !== "dead" && t.hits > 0 && moved > 1.3) {
        // Wounded walkers drip as they come.
        if (mix32(key, 10) < 0.55) this.floorStamp(f, "drops", (z.x + t.ax) / 2, (z.y + t.ay) / 2, Math.atan2(z.y - t.ay, z.x - t.ax), 0.6, key ^ 0x33)
        t.ax = z.x
        t.ay = z.y
      } else if (moved > 1.3) {
        t.ax = z.x
        t.ay = z.y
      }
      t.hp = z.hp
      t.state = z.state
    }
    if (this.frame % 30 === 0) for (const [id, t] of this.tracked) if (t.seen !== this.frame) this.tracked.delete(id)

    const p = f.player
    if (this.prevHealth >= 0 && p.health < this.prevHealth - 0.1) {
      const key = this.counts.emitted * 31 + 5
      this.floorStamp(f, "drops", p.x, p.y, mix32(key, 1) * 6.28, 0.65, key)
    }
    this.prevHealth = p.health
    this.footprints(f)
    this.counts.fight = this.used
  }

  /** True when `(x, y)` lies inside an ambient or active fight blood pool. */
  poolUnder(x: number, y: number): boolean {
    for (const a of this.ambientPools) {
      const r = 0.42 * a.scale
      if (Math.abs(a.x - x) < r && Math.abs(a.z - y) < r && Math.hypot(a.x - x, a.z - y) < r) return true
    }
    for (let i = 0; i < this.used; i++) {
      const st = this.ring[(this.head - 1 - i + BLOOD_RING_MAX) % BLOOD_RING_MAX]!
      if (st.kind !== "pool") continue
      const r = 0.42 * this.scaleAt(st)
      if (Math.hypot(st.x - x, st.z - y) < r) return true
    }
    return false
  }

  private footprints(f: BloodFrame): void {
    const n = Math.round(f.settings.bloodFootprints)
    const p = f.player
    if (n <= 0 || p.vehicleId != null) {
      this.footLeft = 0
      this.footArmed = false
      return
    }
    if (this.poolUnder(p.x, p.y)) {
      this.footLeft = n
      if (!this.footArmed) {
        this.footAx = p.x
        this.footAy = p.y
      }
      this.footArmed = true
      return
    }
    if (!this.footArmed) return
    const d = Math.hypot(p.x - this.footAx, p.y - this.footAy)
    if (d > 3) {
      // Teleported or respawned: drop the trail.
      this.footAx = p.x
      this.footAy = p.y
      return
    }
    if (d < 0.68) return
    const dx = (p.x - this.footAx) / d
    const dy = (p.y - this.footAy) / d
    if (this.footLeft > 0) {
      const side = this.footSide ? 1 : -1
      const strength = this.footLeft > (n * 2) / 3 ? 0 : this.footLeft > n / 3 ? 1 : 2
      const fx = p.x - dy * side * 0.1
      const fy = p.y + dx * side * 0.1
      const key = this.counts.emitted * 13 + this.footLeft
      this.floorStamp(f, "foot", fx, fy, Math.atan2(dy, dx), 1, key)
      // Variant encodes side and strength (shapes.ts: side * 3 + strength).
      const last = this.ring[(this.head - 1 + BLOOD_RING_MAX) % BLOOD_RING_MAX]!
      last.variant = (this.footSide ? 0 : 3) + strength
      last.grime = -1
      this.footSide ^= 1
      this.footLeft--
    } else this.footArmed = false
    this.footAx = p.x
    this.footAy = p.y
  }

  private scaleAt(st: FightStain): number {
    if (st.grow <= 0) return st.scale
    const t = Math.min(1, (this.clock - st.born) / st.grow)
    const e = 1 - (1 - t) * (1 - t) * (1 - t)
    return st.scale * (0.2 + 0.8 * e)
  }

  private put(key: string, x: number, y: number, z: number, yaw: number, scale: number, wall: boolean): void {
    const model = this.models.get(key)
    if (model === undefined) return
    let b = this.batchData.get(model)
    if (!b) this.batchData.set(model, (b = { data: new Float32Array(64 * INST_FLOATS), count: 0 }))
    if ((b.count + 1) * INST_FLOATS > b.data.length) {
      const grown = new Float32Array(b.data.length * 2)
      grown.set(b.data)
      b.data = grown
    }
    const o = b.count++ * INST_FLOATS
    const d = b.data
    d[o] = x
    d[o + 1] = y
    d[o + 2] = z
    d[o + 3] = yaw
    d[o + 4] = 1
    d[o + 5] = 1
    d[o + 6] = 1
    d[o + 7] = scale
    d[o + 8] = wall ? PITCH_WALL : 0
    d[o + 9] = wall ? ROLL_WALL : 0
    d[o + 10] = 1
    d[o + 11] = 0
  }

  /** Instanced batches for the stains in view (frustum-culled to the camera's ground rect). */
  collect(town: Town, view: readonly [number, number, number, number], s: OutbreakBloodSettings): readonly Batch[] {
    this.ensureModels(Math.round(s.bloodValue * 100) / 100)
    const key = ambientBloodKey(town, s)
    if (key !== this.ambientKey) {
      this.ambientKey = key
      this.ambient = placeAmbientBlood(town, s)
      this.ambientPools = this.ambient.filter((a) => a.kind === "pool")
      this.counts.ambient = this.ambient.length
    }
    for (const b of this.batchData.values()) b.count = 0
    this.batches.length = 0
    const m = 1.2
    const [x0, y0, x1, y1] = view
    let drawn = 0
    for (const a of this.ambient) {
      if (a.x < x0 - m || a.x > x1 + m || a.z < y0 - m || a.z > y1 + m) continue
      this.put(`${a.kind}:${a.variant}`, a.x, a.y, a.z, a.yaw, a.scale, a.wall)
      if (a.grime >= 0) this.put(`grime:${a.grime}`, a.x, a.y + 0.0004, a.z, a.yaw + 1.3, a.scale * 0.9, false)
      drawn++
    }
    if (s.bloodPersist) {
      for (let i = 0; i < this.used; i++) {
        const st = this.ring[(this.head - this.used + i + BLOOD_RING_MAX) % BLOOD_RING_MAX]!
        if (st.x < x0 - m || st.x > x1 + m || st.z < y0 - m || st.z > y1 + m) continue
        const sc = this.scaleAt(st)
        this.put(`${st.kind}:${st.variant}`, st.x, st.y, st.z, st.yaw, sc, st.wall)
        if (st.grime >= 0) this.put(`grime:${st.grime}`, st.x, st.y + 0.0004, st.z, st.yaw + 1.3, sc * 0.9, false)
        drawn++
      }
    }
    this.counts.drawn = drawn
    for (const [model, b] of this.batchData) if (b.count > 0) this.batches.push({ model, data: b.data, count: b.count })
    return this.batches
  }

  stats(): Record<string, unknown> {
    const byKind: Record<string, number> = {}
    for (const a of this.ambient) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1
    return { ...this.counts, ambientByKind: byKind, models: this.models.size }
  }
}

let current: BloodStains | null = null

/** Registers the live presenter so the feature's harness slice can read it. */
export function setCurrentBloodStains(b: BloodStains): void {
  current = b
}

export const currentBloodStains = (): BloodStains | null => current
