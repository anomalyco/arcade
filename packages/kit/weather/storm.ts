import { FlashLimiter, makeStrike, pickStrikeLights, rng, strikeEnd, type BoltKind, type Strike, type StrikeLight, type Vec3 } from "./lightning"

/**
 * When and where lightning strikes around a listener, and the thunder each strike sends back: Poisson arrivals at a
 * rate, a near/far distance band, cloud-to-cloud share, Strike now requests, the WCAG flash limiter and the Reduced and
 * Off flash modes. Pure apart from its own clock, so the same calls give the same storm.
 *
 * Bearing is clockwise from north (−z), as `makeStrike` lays it out: a view yaw of `y` (forward −sin y, −cos y) looks
 * along bearing −y.
 */

export const SPEED_OF_SOUND = 343

/**
 * Lightning flashes: Full (one scene-light pulse per strike, the channel flickers with its restrikes), Reduced (slow,
 * dim, one soft swell, never two within 3 s) or Off (no bolt and no flash; the thunder stays).
 */
export type StormFlashes = "full" | "reduced" | "off"

export type StormStrikeSettings = {
  /** Strikes a minute (0 = only what is asked for). */
  rate: number
  /** Share of strikes that are cloud to cloud. */
  cloud: number
  /** Ground strikes land between these distances (m). */
  near: number
  far: number
  flashes: StormFlashes
}

export const STORM_STRIKE_DEFAULTS: Readonly<StormStrikeSettings> = { rate: 0, cloud: 0.25, near: 250, far: 3000, flashes: "full" }

/** A strike asked for now: anything left out is picked (in view, at the band's distances). */
export type StrikeRequest = { kind?: BoltKind; distance?: number; bearing?: number; power?: number; seed?: number; dark?: boolean }

/** Thunder on its way: emitted at the return stroke from the channel's nearest stretch, arriving `slant / 343` later. */
export type ThunderEvent = {
  id: number
  kind: BoltKind
  /** Slant distance from the listener to the channel's nearest stretch (m). */
  distance: number
  bearing: number
  /** Where the crack comes from. */
  position: Vec3
  /** Storm clock (s) of the return stroke, and of the thunder reaching the listener. */
  emitted: number
  arrives: number
  power: number
}

export type StormStrikeFrame = {
  /** Storm clock (s). */
  time: number
  /** The channel to draw this frame (or none) and its brightness; null when flashes are off. */
  bolt: Strike | null
  light: StrikeLight
  /** Scene light 0..~1.4 of the strike lighting the scene most (0 with flashes off), toward `dir` from the listener. */
  scene: number
  dir: Vec3
  /** Thunder emitted this step (a game schedules each once) and every strike still alive. */
  thunder: readonly ThunderEvent[]
  strikes: readonly Strike[]
}

const DARK: StrikeLight = { channel: 0, branches: 0, front: 0, leader: 0, scene: 0, after: 0 }

export class StormStrikes {
  readonly limiter = new FlashLimiter()
  private time = 0
  private strikes: Strike[] = []
  private serial = 0
  private nextAt = 4
  private requests: StrikeRequest[] = []
  private readonly fresh: ThunderEvent[] = []
  /** Strikes heard but not seen (`dark` requests): thunder only. */
  private readonly unseen = new WeakSet<Strike>()

  /** `ceiling`: cloud base height above the listener's ground (m), where the channel disappears. */
  constructor(private readonly seed = 1, readonly ceiling = 210) {}

  /** A strike on the next step (after its leader). */
  request(r: StrikeRequest = {}): void { this.requests.push(r) }

  get clock(): number { return this.time }
  get live(): readonly Strike[] { return this.strikes }

  step(dt: number, s: Readonly<StormStrikeSettings>, eye: readonly number[], viewBearing: number, groundY: number): StormStrikeFrame {
    this.time += Math.max(0, Math.min(0.1, dt))
    this.fresh.length = 0
    const reduce = s.flashes === "reduced", dark = s.flashes === "off"
    for (const r of this.requests.splice(0)) {
      const k = this.add(this.plan(r, viewBearing, s), eye, groundY, reduce)
      if (r.dark) this.unseen.add(k)
    }
    // Poisson arrivals at least 6 s apart (Reduced: a third of the rate, 15 s apart).
    const rate = s.rate * (reduce ? 0.35 : 1)
    if (rate > 0 && this.time >= this.nextAt) {
      this.add(this.plan({}, viewBearing, s, true), eye, groundY, reduce)
      const r = rng(0xbeef + this.serial * 31 + this.seed)
      this.nextAt = this.time + Math.max(reduce ? 15 : 6, -Math.log(1 - r() * 0.999) * 60 / rate)
    } else if (rate <= 0) this.nextAt = this.time + 2
    this.strikes = this.strikes.filter(k => strikeEnd(k) > this.time)
    const pick = pickStrikeLights(this.strikes.filter(k => !this.unseen.has(k)), this.time, reduce)
    let dir: Vec3 = [0, 1, 0], scene = 0
    // The direction is known from the leader on (the strike that will light the scene), so a shadow map can be ready.
    const lighting = pick.scene && pick.sceneLight > 0 ? pick.scene : pick.bolt
    if (lighting && !dark) {
      const k = lighting, p = k.position
      // A ground strike lights the scene from the channel's lower half, a cloud flash from the cloud.
      const mid: Vec3 = [p[0] - eye[0]!, (k.kind === "cloud" ? p[1] : groundY + this.ceiling * 0.6) - eye[1]!, p[2] - eye[2]!]
      const l = Math.hypot(...mid) || 1
      dir = [mid[0] / l, mid[1] / l, mid[2] / l]
      scene = pick.sceneLight * (reduce ? 0.5 : 1)
    }
    return { time: this.time, bolt: dark ? null : pick.bolt, light: dark ? DARK : pick.light, scene, dir, thunder: this.fresh, strikes: this.strikes }
  }

  reset(): void {
    this.strikes = []; this.requests = []; this.fresh.length = 0
    this.limiter.reset()
  }

  /** A strike's plan: in view 60% of the time; distance across the band, nearer strikes rarer (∝ area). */
  private plan(r: StrikeRequest, viewBearing: number, s: Readonly<StormStrikeSettings>, scheduled = false) {
    const g = rng(0xa11 + this.serial * 104729 + this.seed * 7919)
    const cloud = r.kind ? r.kind === "cloud" : scheduled && g() < s.cloud
    const near = Math.max(80, Math.min(s.near, s.far)), far = Math.max(near, s.far)
    const inView = !scheduled || g() < 0.6
    const bearing = r.bearing ?? (inView ? viewBearing + (g() - 0.5) * (scheduled ? 1.6 : 0.7) : g() * Math.PI * 2)
    // Uniform over the annulus: d = √(near² + u (far² − near²)).
    const distance = r.distance ?? (cloud ? 250 + 300 * g() : Math.sqrt(near * near + g() * (far * far - near * near)))
    const power = r.power ?? (distance > 1500 ? 0.45 : 0.75 + 0.25 * g())
    return { seed: r.seed ?? ((this.serial + 1) * 2654435761 + this.seed) >>> 0, kind: (cloud ? "cloud" : "ground") as BoltKind, bearing, distance, power }
  }

  private add(plan: ReturnType<StormStrikes["plan"]>, eye: readonly number[], groundY: number, reduce: boolean) {
    this.serial++
    // One scene-light pulse per strike; the shared limiter keeps overlapping strikes to three a second. Reduced: only
    // once the last swell has faded (3 s), so swells never stack and dip.
    const k = makeStrike(plan, this.time + 0.1, eye[0]!, eye[2]!, groundY, groundY + this.ceiling, this.limiter, 1, reduce ? 3 : 0)
    this.strikes.push(k)
    const slant = Math.hypot(plan.distance, k.kind === "cloud" ? this.ceiling * 0.85 : 60)
    const [px, , pz] = k.position
    this.fresh.push({ id: this.serial, kind: k.kind, distance: slant, bearing: plan.bearing, position: [px, groundY + (k.kind === "cloud" ? this.ceiling * 0.85 : 60), pz], emitted: k.t, arrives: k.t + slant / SPEED_OF_SOUND, power: plan.power })
    return k
  }
}
