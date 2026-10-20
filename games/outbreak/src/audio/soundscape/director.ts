import { EXTERIOR_VEHICLE_COLLIDERS, SIZE, inBuildingFootprint, type Building, type Town } from "../../../shared/map"
import { scapeSound, type ScapeLayer } from "./catalog"
import { smoothNoise } from "./dsp"
import { distToBuilding, hash01, housePlan, housePowered, type HousePlan } from "./houses"
import { STREET_PUDDLES } from "../space"

/** What the soundscape reads each frame. All of it is shared in co-op (town, sim time, hour, weather, survivors). */
export type ScapeInput = {
  town: Town
  /** Sim seconds: the clock every event is seeded on. */
  time: number
  dt: number
  hour: number
  /** Continuous game hours since the run's first midnight (`ScapeHours`). */
  absHour: number
  listener: { readonly x: number; readonly y: number }
  /** Every survivor (phones stop and music boxes start for anyone, so co-op players hear the same thing). */
  survivors: readonly { readonly x: number; readonly y: number }[]
  /** 0..1 rainfall, ground wetness and storm, from the weather cycle. */
  rain: number
  wetness: number
  storm: number
  /** Broken glass in the world (`glass:` stores): a pane shot or smashed near a window lets the wind in. */
  glass: readonly { readonly x: number; readonly y: number }[]
  /** 0 street, 1 indoors, eased (from `OutbreakAudio`). */
  indoor: number
}

/** Linear level per layer (0 = off) after the Lab's master, group levels and toggles. */
export type ScapeLevels = Record<ScapeLayer, number>

/** One sound to start: positional at (x, y), or `far` (placed by bearing, already panned and filtered). */
export type ScapeShot = {
  id: string
  x: number
  y: number
  gain: number
  rate: number
  delay: number
  far: boolean
  pan: number
  cutoffHz: number
}

/** A loop wanted this frame, keyed so it carries on from frame to frame; `score` ranks it for the voice budget. */
export type ScapeHold = {
  key: string
  id: string
  x: number
  y: number
  gain: number
  rate: number
  far: boolean
  pan: number
  cutoffHz: number
  score: number
}

/** Hours to the first night: night `n` runs from noon of day `n - 1` to the next noon, so a 17:30 start is night 1. */
export function nightOf(absHour: number): number {
  return Math.max(1, Math.floor((absHour - 12) / 24) + 1)
}

/** The day cycle's daylight curve (`shared/day-cycle.ts`), without its allocations. */
export function daylightAt(hour: number): number {
  const h = ((hour % 24) + 24) % 24
  const v = Math.max(0, Math.min(1, (Math.sin(((h - 6) / 24) * Math.PI * 2) + 0.02) / 0.54))
  return v * v * (3 - 2 * v)
}

/** Seeded wind 0..1 (gusts every few seconds, stronger in a storm). */
export function windAt(seed: number, time: number, rain: number, storm: number): number {
  const s = seed & 0xffff
  const slow = smoothNoise(time / 11, s)
  const gust = smoothNoise(time / 2.6, s + 17)
  return Math.max(0, Math.min(1, 0.12 + 0.42 * slow + 0.38 * gust * gust * gust + 0.3 * storm + 0.12 * rain))
}

/**
 * Integrates the game clock: the offline sim knows its elapsed hours; a co-op client only sees the hour, so it counts
 * the hour's progress itself from when it joined.
 */
export class ScapeHours {
  private last = Number.NaN
  private abs = 0
  update(hour: number, simElapsedHours: number, startHour: number): number {
    if (simElapsedHours > 0) {
      this.abs = startHour + simElapsedHours
    } else if (Number.isNaN(this.last)) {
      this.abs = hour
    } else {
      let d = hour - this.last
      if (d < -12) d += 24
      if (d > 0 && d < 6) this.abs += d
    }
    this.last = hour
    return this.abs
  }
  reset(): void {
    this.last = Number.NaN
    this.abs = 0
  }
}

type DistantEvent = { start: number; length: number; bearing: number; variant: number; dist: number; k: number }

// Layers seeded on the shared sim clock in fixed windows: each window may hold one event.
const SALT = { siren: 101, gunfire: 102, alarm: 103, owl: 104, creak: 105, pipe: 106, settle: 107, phone: 108, chimes: 109 } as const

const PENTATONIC = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2] as const
const MAX_SHOTS = 48
const MAX_HOLDS = 48
const HOUSE_RADIUS = 18
const NEAR_TREE = 13
const NEAR_CAR = 13
const NEAR_PUDDLE = 11

/** Siren chance per 50 s window, by night: busy on the first, rarer, the last ones winding down, then never again. */
export const SIREN_CHANCE = [0, 0.6, 0.28, 0.1] as const
/** Other survivors' gunfire chance per 34 s window, by night: it thins out and stops after the fourth. */
export const GUNFIRE_CHANCE = [0, 0.5, 0.36, 0.22, 0.1] as const
/** A zombie bumping a car streets away, per 150 s window: batteries die as the nights go on. */
export const ALARM_CHANCE = [0, 0.16, 0.12, 0.07, 0.04, 0.02] as const

const chance = (table: readonly number[], night: number) => (night < table.length ? table[night]! : 0)

/**
 * The soundscape's director: a pure function of the town, the shared clock, weather and survivors (plus the little it
 * remembers about secrets already sprung) that says which ambient sounds start this frame and which loops should be
 * playing. The game's `Soundscape` plays its output through the `AudioRuntime`; the offline reel renders the same
 * output into a WAV. Reuses its output arrays every frame.
 */
export class ScapeDirector {
  readonly shots: ScapeShot[] = Array.from({ length: MAX_SHOTS }, () => ({ id: "", x: 0, y: 0, gain: 0, rate: 1, delay: 0, far: false, pan: 0, cutoffHz: 18000 }))
  readonly holds: ScapeHold[] = Array.from({ length: MAX_HOLDS }, () => ({ key: "", id: "", x: 0, y: 0, gain: 0, rate: 1, far: false, pan: 0, cutoffHz: 18000, score: 0 }))
  shotCount = 0
  holdCount = 0
  private prevTime = Number.NaN
  private prevHour = Number.NaN
  private prevWind = 0
  private prevAbs = 0
  private now = 0
  /** Sounds due later (rings, strikes, bursts): held back so they are placed against the listener when they start. */
  private readonly pending: (ScapeShot & { at: number; live: boolean })[] = Array.from({ length: 64 }, () => ({
    id: "", x: 0, y: 0, gain: 0, rate: 1, delay: 0, far: false, pan: 0, cutoffHz: 18000, at: 0, live: false,
  }))
  private near: HousePlan[] = []
  private nearAt = -1
  private trees: { x: number; y: number }[] = []
  private car: { x: number; y: number; d: number } = { x: 0, y: 0, d: Infinity }
  private puddle: { x: number; y: number; d: number } = { x: 0, y: 0, d: Infinity }
  private tree: { x: number; y: number; d: number } = { x: 0, y: 0, d: Infinity }
  private church: { x: number; y: number; d: number } = { x: 0, y: 0, d: Infinity }
  /** Music boxes already played, by house id → night. */
  private readonly musicPlayed = new Map<string, number>()
  /** The haunted phone's ringing: when it started, and when (if) someone walked up to it. */
  private ringing: { house: HousePlan; start: number; stoppedAt: number; machineAt: number } | null = null
  private readonly ev: DistantEvent = { start: 0, length: 0, bearing: 0, variant: 0, dist: 0, k: 0 }
  /** Events started, by layer (harness and tests). */
  readonly counts: Record<string, number> = {}

  reset(): void {
    this.prevTime = Number.NaN
    this.prevHour = Number.NaN
    this.near.length = 0
    this.nearAt = -1
    this.musicPlayed.clear()
    this.ringing = null
    for (const p of this.pending) p.live = false
    for (const k of Object.keys(this.counts)) delete this.counts[k]
  }

  step(input: ScapeInput, levels: ScapeLevels): void {
    this.shotCount = 0
    this.holdCount = 0
    const t = input.time
    const prev = Number.isNaN(this.prevTime) || t < this.prevTime || t - this.prevTime > 2 ? t : this.prevTime
    const prevHour = Number.isNaN(this.prevHour) ? input.hour : this.prevHour
    if (Number.isNaN(this.prevTime)) this.prevAbs = input.absHour
    this.now = t
    this.prevTime = t
    this.prevHour = input.hour
    const seed = input.town.seed >>> 0
    const night = nightOf(input.absHour)
    const daylight = daylightAt(input.hour)
    const dark = 1 - daylight
    const wind = windAt(seed, t, input.rain, input.storm)
    // How fast the wind is rising (per second): a gust arriving.
    const gustRise = t > prev ? (wind - this.prevWind) / (t - prev) : 0
    this.prevWind = wind

    this.refreshNear(input)
    for (const plan of this.near) this.house(plan, input, levels, prev, prevHour, night, dark, wind, gustRise)
    this.haunting(input, levels, prev, prevHour, night)
    this.bell(input, levels, prevHour, night)
    this.outdoors(input, levels, prev, daylight, wind, gustRise)
    this.distance(input, levels, prev, night, dark)
    this.prevAbs = input.absHour
    this.flush(t)
  }

  private flush(t: number): void {
    for (const p of this.pending) {
      if (!p.live || p.at > t) continue
      p.live = false
      if (this.shotCount >= MAX_SHOTS) continue
      const s = this.shots[this.shotCount++]!
      s.id = p.id
      s.x = p.x
      s.y = p.y
      s.gain = p.gain
      s.rate = p.rate
      s.delay = 0
      s.far = p.far
      s.pan = p.pan
      s.cutoffHz = p.cutoffHz
    }
  }

  // -------------------------------------------------------------------------------------------------------------

  private shot(id: string, x: number, y: number, gain: number, rate = 1, delay = 0): ScapeShot | null {
    if (gain <= 0.0005) return null
    this.counts[id] = (this.counts[id] ?? 0) + 1
    if (delay > 0.25) {
      const p = this.pending.find((q) => !q.live)
      if (!p) return null
      p.live = true
      p.at = this.now + delay
      p.id = id
      p.x = x
      p.y = y
      p.gain = gain
      p.rate = rate
      p.delay = 0
      p.far = false
      p.pan = 0
      p.cutoffHz = 18000
      return p
    }
    if (this.shotCount >= MAX_SHOTS) return null
    const s = this.shots[this.shotCount++]!
    s.id = id
    s.x = x
    s.y = y
    s.gain = gain
    s.rate = rate
    s.delay = delay
    s.far = false
    s.pan = 0
    s.cutoffHz = 18000
    return s
  }

  private hold(key: string, id: string, x: number, y: number, gain: number, rate = 1): ScapeHold | null {
    if (gain <= 0.0005 || this.holdCount >= MAX_HOLDS) return null
    const h = this.holds[this.holdCount++]!
    h.key = key
    h.id = id
    h.x = x
    h.y = y
    h.gain = gain
    h.rate = rate
    h.far = false
    h.pan = 0
    h.cutoffHz = 18000
    const def = scapeSound(id)
    const d = Math.hypot(x - this.lx, y - this.ly)
    h.score = gain * (def?.gain ?? 0.2) / (1 + (d / Math.max(1, def?.range.ref ?? 1)) ** 2)
    return h
  }

  private lx = 0
  private ly = 0

  /** Houses within earshot, refreshed four times a second (the town's buildings change only as chunks stream). */
  private refreshNear(input: ScapeInput): void {
    this.lx = input.listener.x
    this.ly = input.listener.y
    if (this.nearAt >= 0 && Math.abs(input.time - this.nearAt) < 0.25) return
    this.nearAt = input.time
    this.near.length = 0
    const town = input.town
    this.church.d = Infinity
    for (const b of town.buildings) {
      const d = distToBuilding(b, this.lx, this.ly)
      if (d < HOUSE_RADIUS) this.near.push(housePlan(town, b))
      if ((b.archetype ?? b.kind) === "church" && d < this.church.d) setNear(this.church, (b.rect[0] + b.rect[2]) / 2, (b.rect[1] + b.rect[3]) / 2, d)
    }
    // Nearest tree, car and puddle for rain on things and insects.
    this.tree.d = this.car.d = this.puddle.d = Infinity
    this.trees.length = 0
    for (const p of town.props) {
      if (p.kind !== "tree") continue
      const d = Math.hypot(p.x - this.lx, p.y - this.ly)
      if (d < NEAR_TREE * 1.8 && this.trees.length < 6) this.trees.push(p)
      if (d < this.tree.d) setNear(this.tree, p.x, p.y, d)
    }
    for (const v of town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) {
      const x = Math.max(v[0], Math.min(v[2], this.lx))
      const y = Math.max(v[1], Math.min(v[3], this.ly))
      const d = Math.hypot(x - this.lx, y - this.ly)
      if (d < this.car.d) setNear(this.car, (v[0] + v[2]) / 2, (v[1] + v[3]) / 2, d)
    }
    const ox = Math.floor(this.lx / SIZE) * SIZE
    const oy = Math.floor(this.ly / SIZE) * SIZE
    for (let bx = -1; bx <= 1; bx++) {
      for (let by = -1; by <= 1; by++) {
        for (const [px, py] of STREET_PUDDLES) {
          const x = ox + bx * SIZE + px
          const y = oy + by * SIZE + py
          const d = Math.hypot(x - this.lx, y - this.ly)
          if (d < this.puddle.d) setNear(this.puddle, x, y, d)
        }
      }
    }
  }

  private house(plan: HousePlan, input: ScapeInput, L: ScapeLevels, prev: number, prevHour: number, night: number, dark: number, wind: number, gustRise: number): void {
    const t = input.time
    const powered = housePowered(plan, input.absHour)
    for (const c of plan.clocks) {
      if (L.clocks > 0) this.hold(c.key, c.id, c.x, c.y, L.clocks, c.rate)
      // A mantel clock strikes the hour, each a little late in its own way: nobody has set them in days.
      if (c.chime && L.clocks > 0) {
        const struck = hourOnBoundary(prevHour, input.hour)
        if (struck >= 0) {
          const n = struck % 12 === 0 ? 12 : struck % 12
          for (let k = 0; k < n; k++) this.shot("scape.clock.chime", c.x, c.y, L.clocks, c.rate > 0.8 ? 1 : 0.84, 0.4 + c.chimeOffset + k * 1.7)
        }
      }
    }
    if (L.taps > 0) {
      for (const tap of plan.taps) {
        // Drips at a steady period with a wobble, deterministic in sim time: k-th drip at phase + k·period (+ jitter).
        const k1 = Math.floor((t - tap.phase) / tap.period)
        const k0 = Math.floor((prev - tap.phase) / tap.period)
        for (let k = k0 + 1; k <= k1 && k - k0 < 4; k++) {
          const jitter = (hash01(plan.seed, 200, k) - 0.5) * 0.18 * tap.period
          const when = tap.phase + k * tap.period + jitter
          const delay = Math.max(0, when - t)
          const rate = 0.9 + hash01(plan.seed, 201, k) * 0.22
          this.shot("scape.tap.drip", tap.x, tap.y, L.taps * (0.75 + 0.25 * hash01(plan.seed, 202, k)), rate, Math.min(0.1, delay))
          if (tap.double && hash01(plan.seed, 203, k) < 0.5) this.shot("scape.tap.drip", tap.x, tap.y, L.taps * 0.5, rate * 1.12, Math.min(0.1, delay) + 0.21)
        }
      }
    }
    if (plan.fridge && L.fridge > 0) {
      if (powered) this.hold(plan.fridge.key, "scape.fridge.hum", plan.fridge.x, plan.fridge.y, L.fridge)
      // The moment the power fails here.
      else if (plan.powerLoss > 0 && Number.isFinite(plan.powerLoss) && crossed(this.prevAbs, input.absHour, plan.powerLoss)) {
        this.shot("scape.fridge.off", plan.fridge.x, plan.fridge.y, L.fridge)
      }
    }
    if (L.creaks > 0) {
      // Old timber talks more at night as it cools, and in the wind.
      const busy = 0.18 + 0.25 * dark + 0.25 * wind
      this.windowed(plan.seed, SALT.creak, 7, prev, t, busy, (k, r) => {
        const [x0, y0, x1, y1] = plan.building.rect
        const x = x0 + 0.6 + r(1) * (x1 - x0 - 1.2)
        const y = y0 + 0.6 + r(2) * (y1 - y0 - 1.2)
        this.shot(`scape.house.creak.${Math.floor(r(3) * 3)}`, x, y, L.creaks * (0.5 + 0.5 * r(4)), 0.85 + r(5) * 0.3)
        void k
      })
      this.windowed(plan.seed, SALT.settle, 23, prev, t, 0.2 + 0.2 * dark, (_k, r) => {
        const [x0, y0, x1, y1] = plan.building.rect
        this.shot("scape.house.settle", x0 + r(1) * (x1 - x0), y0 + r(2) * (y1 - y0), L.creaks * (0.6 + 0.4 * r(3)), 0.9 + r(4) * 0.2)
      })
      if (powered || plan.powerLoss > input.absHour - 12) {
        this.windowed(plan.seed, SALT.pipe, 45, prev, t, 0.22, (_k, r) => this.shot("scape.pipe.knock", plan.pipe.x, plan.pipe.y, L.creaks * (0.6 + 0.4 * r(1)), 0.9 + r(2) * 0.2))
      }
    }
    if (L.wind > 0) this.windows(plan, input, L, prev, wind, gustRise)
    if (plan.chimes && L.chimes > 0) {
      // A gust knocks the tubes together: the faster it rises, the more of them, each tube keeping its pitch.
      const p = Math.min(0.85, Math.max(0, (gustRise - 0.03) * 6) + Math.max(0, wind - 0.55) * 0.5)
      const chimes = plan.chimes
      this.windowed(plan.seed, SALT.chimes, 0.45, prev, t, p, (_k, r) => {
        const tube = Math.floor(r(1) * PENTATONIC.length)
        this.shot("scape.chime", chimes.x, chimes.y, L.chimes * (0.45 + 0.55 * wind) * (0.55 + 0.45 * r(2)), PENTATONIC[tube]! * 0.75)
      })
    }
    if (plan.musicBox && L.oddities > 0 && dark > 0.6) {
      // The music box plays once a night, the first time anyone steps inside, and runs down mid-tune.
      const id = plan.building.id
      if ((this.musicPlayed.get(id) ?? 0) < night && anyInside(plan.building, input.survivors)) {
        this.musicPlayed.set(id, night)
        this.shot("scape.musicbox", plan.musicBox.x, plan.musicBox.y, L.oddities, 1, 1.2)
      }
    }
    if (plan.phone && !plan.phone.haunted && L.oddities > 0 && powered) {
      // Somebody still calls. Fewer every night.
      this.windowed(plan.seed, SALT.phone, 300, prev, t, 0.05 / night, (_k, r) => {
        const rings = 3 + Math.floor(r(1) * 4)
        for (let k = 0; k < rings; k++) this.shot("scape.phone.ring", plan.phone!.x, plan.phone!.y, L.oddities * 0.85, 1, k * 6)
        if (r(2) < 0.5) this.shot("scape.phone.machine", plan.phone!.x, plan.phone!.y, L.oddities * 0.8, 1, rings * 6 + 0.3)
      })
    }
  }

  /** Open and broken windows: wind whistling through the gap and the curtain lifting on a gust. */
  private windows(plan: HousePlan, input: ScapeInput, L: ScapeLevels, prev: number, wind: number, gustRise: number): void {
    const t = input.time
    const town = input.town
    const id = plan.building.id
    for (let i = 0; i < town.windows.length; i++) {
      const w = town.windows[i]!
      if (w.buildingId !== id) continue
      const x = (w.rect[0] + w.rect[2]) / 2
      const y = (w.rect[1] + w.rect[3]) / 2
      let broken = false
      for (const g of input.glass) if (Math.abs(g.x - x) < 1.6 && Math.abs(g.y - y) < 1.6) broken = true
      if (!w.open && !broken) continue
      const c = inwardOf(plan.building, x, y)
      this.hold(`${w.id}:wind`, "scape.wind.whistle", c.x, c.y, L.wind * wind * wind * (broken ? 1.15 : 0.8), 0.92 + hash01(plan.seed, 400, i) * 0.16)
      const p = Math.min(0.7, Math.max(0, (gustRise - 0.04) * 5))
      this.windowed(plan.seed + i, 401, 1.6, prev, t, p, (_k, r) => this.shot("scape.curtain", c.x, c.y, L.wind * (0.5 + wind * 0.6), 0.85 + r(1) * 0.3))
    }
  }

  /**
   * The church bell strikes the hours for the blocks around it. At midnight on the third night it strikes thirteen.
   */
  private bell(input: ScapeInput, L: ScapeLevels, prevHour: number, night: number): void {
    if (L.clocks <= 0 || this.church.d > 140) return
    const struck = hourOnBoundary(prevHour, input.hour)
    if (struck < 0) return
    const n = struck === 0 && night === 3 ? 13 : struck % 12 === 0 ? 12 : struck % 12
    for (let k = 0; k < n; k++) this.shot("scape.church.bell", this.church.x, this.church.y, L.clocks, 1, 0.3 + k * 2.7)
    if (n === 13) this.counts.thirteen = (this.counts.thirteen ?? 0) + 1
  }

  /** The haunted phone: at three in the morning it rings in an empty house until somebody walks up to it. */
  private haunting(input: ScapeInput, L: ScapeLevels, prev: number, prevHour: number, night: number): void {
    const t = input.time
    if (L.oddities <= 0) {
      this.ringing = null
      return
    }
    if (!this.ringing && hourOnBoundary(prevHour, input.hour) === 3) {
      let best: HousePlan | null = null
      for (const plan of this.near) if (plan.phone?.haunted && (!best || distToBuilding(plan.building, this.lx, this.ly) < distToBuilding(best.building, this.lx, this.ly))) best = plan
      if (best) this.ringing = { house: best, start: t, stoppedAt: -1, machineAt: -1 }
    }
    const r = this.ringing
    if (!r) return
    const phone = r.house.phone!
    const rings = 7
    const end = r.start + rings * 6
    if (r.stoppedAt < 0) {
      // Six-second cadence: two seconds of bell, four of nothing.
      const k0 = Math.floor((prev - r.start) / 6)
      const k1 = Math.floor((t - r.start) / 6)
      if ((prev < r.start && t >= r.start) || (t >= r.start && k1 > k0 && k0 >= 0 && k1 < rings)) this.shot("scape.phone.ring", phone.x, phone.y, L.oddities, 1)
      let close = false
      for (const s of input.survivors) if (Math.hypot(s.x - phone.x, s.y - phone.y) < 3.2) close = true
      if (close || t >= end) {
        r.stoppedAt = t
        r.machineAt = t + (close ? 0.9 : 0.4)
      }
    }
    if (r.machineAt > 0 && prev < r.machineAt && t >= r.machineAt) {
      this.shot("scape.phone.machine", phone.x, phone.y, L.oddities, 1)
      this.counts.haunted = (this.counts.haunted ?? 0) + 1
    }
    if (r.machineAt > 0 && t > r.machineAt + 10) this.ringing = null
    void night
  }

  private outdoors(input: ScapeInput, L: ScapeLevels, prev: number, daylight: number, wind: number, _gustRise: number): void {
    const t = input.time
    const rain = input.rain
    if (L.rain > 0 && rain > 0.03) {
      const level = L.rain * Math.min(1, rain * 2.2)
      if (this.car.d < NEAR_CAR) this.hold("rain:car", "scape.rain.metal", this.car.x, this.car.y, level, 1)
      if (this.puddle.d < NEAR_PUDDLE) this.hold("rain:puddle", "scape.rain.puddle", this.puddle.x, this.puddle.y, level, 1)
      if (this.tree.d < NEAR_TREE) this.hold("rain:leaves", "scape.rain.leaves", this.tree.x, this.tree.y, level * (0.8 + 0.3 * wind), 1)
    }
    // After the rain: gutters and downpipes drip for as long as the ground stays wet.
    const after = Math.max(0, input.wetness - 0.15) * Math.max(0, 1 - rain * 5)
    if (L.gutters > 0 && after > 0.02) {
      for (const plan of this.near) {
        for (let g = 0; g < plan.gutters.length; g++) {
          const p = plan.gutters[g]!
          if (Math.hypot(p.x - this.lx, p.y - this.ly) > 12) continue
          const period = (0.7 + hash01(plan.seed, 500, g) * 2.2) / Math.min(1, after * 2.5)
          const phase = hash01(plan.seed, 501, g) * period
          const k0 = Math.floor((prev - phase) / period)
          const k1 = Math.floor((t - phase) / period)
          if (k1 > k0) this.shot("scape.gutter.drip", p.x, p.y, L.gutters * (0.6 + 0.4 * hash01(plan.seed, 502, k1)), 0.88 + hash01(plan.seed, 503, k1) * 0.25)
        }
      }
    }
    // Insects in the trees by day; the night is quiet.
    if (L.insects > 0 && daylight > 0.35 && rain < 0.2) {
      const level = L.insects * Math.min(1, (daylight - 0.35) / 0.4) * (1 - rain * 5)
      let n = 0
      for (const tr of this.trees) {
        const k = Math.floor(tr.x * 7.1 + tr.y * 3.3)
        if (hash01(input.town.seed, 600, k) > 0.55) continue
        this.hold(`insects:${k}`, "scape.insects", tr.x, tr.y, level, 0.9 + hash01(input.town.seed, 601, k) * 0.2)
        if (++n >= 2) break
      }
    }
  }

  /** The far-off town: sirens, other survivors' gunfire, a car alarm, an owl. Placed by bearing, not position. */
  private distance(input: ScapeInput, L: ScapeLevels, prev: number, night: number, dark: number): void {
    const t = input.time
    const seed = input.town.seed >>> 0
    const muffle = 1 - input.indoor * 0.55
    const cut = (hz: number) => hz * Math.pow(700 / hz, input.indoor)
    if (L.sirens > 0) {
      const p = chance(SIREN_CHANCE, night)
      for (let k = Math.floor(t / 50) - 1; k <= Math.floor(t / 50); k++) {
        if (!this.distant(seed, SALT.siren, 50, k, p, 16, 22)) continue
        const e = this.ev
        if (t < e.start || t > e.start + e.length) continue
        const u = t - e.start
        // The last sirens wind down mid-wail, as if whatever powered them gave out.
        const dying = night >= 3
        const env = Math.min(1, u / 3) * Math.min(1, (e.start + e.length - t) / (dying ? 2.5 : 5))
        const rate = (0.95 + e.variant * 0.1) * (dying ? 1 - 0.4 * Math.max(0, (u - e.length * 0.6) / (e.length * 0.4)) : 1)
        const h = this.hold(`siren:${k}`, "scape.siren", 0, 0, L.sirens * env * e.dist * muffle, rate)
        if (h) this.place(h, e.bearing, cut(1800 * e.dist + 600))
        if (u < 0.05) this.counts["scape.siren"] = (this.counts["scape.siren"] ?? 0) + 1
      }
    }
    if (L.carAlarm > 0) {
      const p = chance(ALARM_CHANCE, night)
      for (let k = Math.floor(t / 150) - 1; k <= Math.floor(t / 150); k++) {
        if (!this.distant(seed, SALT.alarm, 150, k, p, 18, 26)) continue
        const e = this.ev
        if (t < e.start || t > e.start + e.length) continue
        // Alarms stop dead.
        const env = Math.min(1, (t - e.start) / 0.3) * Math.min(1, (e.start + e.length - t) / 0.08)
        const h = this.hold(`alarm:${k}`, "scape.caralarm", 0, 0, L.carAlarm * env * e.dist * muffle, 0.97 + e.variant * 0.06)
        if (h) this.place(h, e.bearing, cut(2200 * e.dist + 500))
      }
    }
    if (L.gunfire > 0) {
      const p = chance(GUNFIRE_CHANCE, night)
      const k = Math.floor(t / 34)
      if (this.distant(seed, SALT.gunfire, 34, k, p, 0, 0) && crossed(prev, t, this.ev.start)) {
        const e = this.ev
        const r = (salt: number, j = 0) => hash01(seed, SALT.gunfire, k * 31 + salt, j)
        const kinds = ["scape.gunshot.pistol", "scape.gunshot.shotgun", "scape.gunshot.rifle"] as const
        const kind = kinds[Math.floor(e.variant * 3)]!
        const level = L.gunfire * e.dist * muffle
        // The fourth night's shots are somebody's last: three, a long wait, then one.
        const pattern =
          night >= 4
            ? [0, 0.42, 0.9, 6.5]
            : Array.from({ length: 1 + Math.floor(r(1) * 5) }, (_, j) => j * (kind === "scape.gunshot.shotgun" ? 0.9 : 0.25) + r(2, j) * 0.35)
        for (let j = 0; j < pattern.length; j++) {
          const s = this.shot(kind, 0, 0, level * (0.75 + 0.25 * r(3, j)), 0.94 + r(4, j) * 0.12, pattern[j]!)
          if (s) this.place(s, e.bearing + (r(5, j) - 0.5) * 0.1, cut(1600 * e.dist + 500))
        }
      }
    }
    if (L.owl > 0 && dark > 0.8 && night >= 2) {
      const k = Math.floor(t / 40)
      if (this.distant(seed, SALT.owl, 40, k, 0.3, 0, 0) && crossed(prev, t, this.ev.start)) {
        const s = this.shot("scape.owl", 0, 0, L.owl * (0.5 + 0.5 * this.ev.dist) * muffle, 0.96 + this.ev.variant * 0.08)
        if (s) this.place(s, this.ev.bearing, cut(1500))
        // Sometimes another answers from the other side of town.
        if (this.ev.variant < 0.35) {
          const a = this.shot("scape.owl", 0, 0, L.owl * 0.35 * muffle, 1.05, 5.5)
          if (a) this.place(a, this.ev.bearing + Math.PI * 0.8, cut(1100))
        }
      }
    }
  }

  /** Window `k` of a layer: whether it holds an event (with chance `p`) and, if so, its timing and placement in `ev`. */
  private distant(seed: number, salt: number, window: number, k: number, p: number, minLen: number, spanLen: number): boolean {
    if (p <= 0 || hash01(seed, salt, k, 0) >= p) return false
    const e = this.ev
    e.k = k
    e.start = k * window + hash01(seed, salt, k, 1) * window * 0.8
    e.length = minLen + hash01(seed, salt, k, 2) * spanLen
    e.bearing = hash01(seed, salt, k, 3) * Math.PI * 2
    e.variant = hash01(seed, salt, k, 4)
    e.dist = 0.45 + 0.55 * hash01(seed, salt, k, 5)
    return true
  }

  /** Places a far sound by bearing: panned across the screen (the camera looks north, +x right) and rounded off. */
  private place(s: { far: boolean; pan: number; cutoffHz: number; x: number; y: number }, bearing: number, cutoffHz: number): void {
    s.far = true
    s.pan = Math.cos(bearing) * 0.65
    s.cutoffHz = cutoffHz
    s.x = this.lx + Math.cos(bearing) * 120
    s.y = this.ly + Math.sin(bearing) * 120
  }

  /** Runs `fire` for each window of `period` seconds whose seeded event time falls in (prev, t]. */
  private windowed(seed: number, salt: number, period: number, prev: number, t: number, p: number, fire: (k: number, r: (j: number) => number) => void): void {
    const k0 = Math.floor(prev / period)
    const k1 = Math.floor(t / period)
    for (let k = k0; k <= k1; k++) {
      if (hash01(seed, salt, k, 0) >= p) continue
      const when = k * period + hash01(seed, salt, k, 1) * period
      if (!crossed(prev, t, when)) continue
      fire(k, (j) => hash01(seed, salt, k, 10 + j))
    }
  }
}

const crossed = (a: number, b: number, at: number) => a < at && b >= at

function setNear(o: { x: number; y: number; d: number }, x: number, y: number, d: number): void {
  o.x = x
  o.y = y
  o.d = d
}

/** The whole hour struck between two hour readings (`-1` if none). */
export function hourOnBoundary(prevHour: number, hour: number): number {
  if (hour === prevHour) return -1
  const a = Math.floor(prevHour)
  const b = Math.floor(hour)
  if (b === a) return -1
  // Wrapped past midnight, or moved forward by less than an hour.
  if (b === (a + 1) % 24) return b
  return -1
}

function anyInside(b: Building, survivors: readonly { x: number; y: number }[]): boolean {
  for (const s of survivors) if (inBuildingFootprint(b, s.x, s.y)) return true
  return false
}

/** A point just inside a building from a spot on its wall. */
function inwardOf(b: Building, x: number, y: number): { x: number; y: number } {
  const [x0, y0, x1, y1] = b.rect
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const d = Math.hypot(cx - x, cy - y) || 1
  return { x: x + ((cx - x) / d) * 0.5, y: y + ((cy - y) / d) * 0.5 }
}
