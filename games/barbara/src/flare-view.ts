import { FLARE_DEFAULTS, FLARE_RANGES, FlareFx, flareFogLamp, flareOnBody, flareSceneLight, type FlareLight, type FlareSettings } from "@arcade/kit/fx/flare"
import { Particles } from "@arcade/kit/fx/particles"
import type { FogLamp } from "@arcade/kit/gpu/fog-scatter"
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { FLOATS_PER_VERT, MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import type { ForestGlow } from "@arcade/kit/forest/view"
import type { LabControl } from "@arcade/kit/lab-panel"
import { flareTable, handFlare, type Flare } from "../shared/flares"
import type { Feel, WoodsState } from "../shared/sim"
import { groundHeight, type WoodsWorld } from "../shared/world"
import { gustAt, WIND_DIR } from "./audio/space"

/**
 * Road flares as drawn: each one's `FlareFx` (flame, sparks, slag and smoke in one kit `Particles` pool, lit only by
 * the flares), its light on the forest (a point a hand over the flame, red on bark, ferns and litter, trunks casting
 * polar shadows), its glow in the mist, a point glow for far off, the sticks (in hands, in the air, on the ground and
 * the spares on the camp table). The sim (`shared/flares.ts`) says where each flare is and when it caught; the burn's
 * look follows the page's own clock, re-synced to the room's when it drifts.
 */

export type FlareLook = {
  /** Full-burn light (cd-like, the forest torch is 70) and reach (m). */
  power: number
  reach: number
  /** Glow in the mist (×) and how far round the flare the mist is lit (m). */
  fog: number
  fogRange: number
  /** A far flare's point glow (×). */
  glow: number
  /** A far flare's lit air: the red haze over it seen through the trunks (×). */
  haze: number
  /** Trunks cast shadows from the nearest flares (polar shadows). */
  shadows: boolean
  /** Smoke drift with the gusts (m/s at a full gust). */
  drift: number
  /**
   * How far round the flame its smoke glows (m): the smoke takes the flare's light by inverse square with this soft
   * core, so the column is red over the flame and goes dim and grey up it, and hides what is behind it. 0 lights the
   * whole column almost evenly, which made it glow like a lamp shade and lifted the woods behind it.
   */
  smokeCore: number
}

/**
 * A fusee is about 100 cd against a 1990s two-cell torch's ~3000 at its hot spot; the forest's torch is 70, so a flare is
 * a few. Deep red, it lights a broad pool dimly where the torch lights a small spot brightly.
 */
export const FLARE_LOOK: FlareLook = { power: 4, reach: 18, fog: 2, fogRange: 18, glow: 1, haze: 1, shadows: true, drift: 1.3, smokeCore: 1 }
/** Your own flare is a hand from your eyes: its glow in the mist and its smoke past your face are cut so the night stays dark. */
const OWN_FOG = 0.15
const OWN_SMOKE = 0.05
const OWN_HALO = 0

const STICK = 0.24
const RED: Rgb = [0.32, 0.035, 0.03]
const CAP: Rgb = [0.12, 0.11, 0.1]
const SLAG: Rgb = [0.09, 0.075, 0.07]
const NO_COLLIDERS: never[] = []
/** Lights the flares may add (nearest first). */
const MAX_LIGHTS = 6

/** A fusee along +x, its burning end at the origin: a red paper tube with a slag-crusted end. */
function stickMesh(lit: boolean): Mesh {
  const m = new Mesh()
  const from = m.length
  m.prism(0, 0, 0.0125, 0.0125, -STICK, -0.025, 8, RED, MAT.lit)
  m.prism(0, 0, 0.0125, 0.011, -0.025, 0, 8, lit ? SLAG : CAP, MAT.lit)
  // Stood up along y; lie it along x (a quarter turn about z: y → x, x → −y).
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    for (const o of [0, 3]) {
      const x = m.v[i + o]!, y = m.v[i + o + 1]!
      m.v[i + o] = y; m.v[i + o + 1] = -x
    }
  }
  return m
}

type Shown = { fx: FlareFx; light: FlareLight; lit: number; seen: boolean; own: boolean }

export class FlareView {
  readonly pool = new Particles()
  readonly settings: FlareSettings = { ...FLARE_DEFAULTS }
  readonly look: FlareLook = { ...FLARE_LOOK }
  private shown = new Map<number, Shown>()
  private litModel: number
  private sparesModel: number
  private scene: SceneLight[] = []
  private fog: FogLamp[] = []
  private glows: ForestGlow[] = []
  private particleLights: SceneLight[] = []
  /** What `update` returns, the same object every frame. */
  private out = { scene: this.scene, fog: this.fog, glows: this.glows, particles: { pool: this.pool, lights: this.particleLights, falloff: FLARE_LOOK.smokeCore } }
  private ground: ((x: number, z: number) => number) | null = null
  private groundOf: WoodsWorld | null = null
  private order: { s: Shown; d: number }[] = []

  constructor(renderer: Renderer) {
    this.litModel = renderer.addModel(stickMesh(true))
    this.sparesModel = renderer.addModel(stickMesh(false))
  }

  /** Lab rows: the flare's look (kit settings), its light on the forest, and the room's burn time (`feel`). */
  controls(group: string): LabControl[] {
    const rows: LabControl[] = (Object.keys(FLARE_RANGES) as (keyof FlareSettings)[]).filter((k) => k !== "burnTime").map((key) => {
      const [min, max, step, unit, label] = FLARE_RANGES[key]
      return { key: `woods.flare.${key}`, field: key, label, group, subsection: "Flame and smoke", type: "range", min, max, step, unit }
    })
    return rows
  }
  lookControls(group: string): LabControl[] {
    const r = (key: keyof FlareLook, label: string, min: number, max: number, step: number, unit: string): LabControl =>
      ({ key: `woods.flare.${key}`, field: key, label, group, subsection: "Light", type: "range", min, max, step, unit })
    return [
      r("power", "Light", 0, 120, 1, "cd×"),
      r("reach", "Reach", 6, 60, 1, "m"),
      r("fog", "Glow in the mist", 0, 4, 0.05, "×"),
      r("fogRange", "Mist lit round it", 4, 60, 1, "m"),
      r("glow", "Far glow", 0, 4, 0.05, "×"),
      r("haze", "Far haze", 0, 4, 0.05, "×"),
      { key: "woods.flare.shadows", field: "shadows", label: "Trunk shadows", group, subsection: "Light", type: "toggle" },
      r("drift", "Smoke drift in a gust", 0, 4, 0.05, "m/s"),
      r("smokeCore", "Smoke glows within", 0, 3, 0.05, "m"),
    ]
  }

  /**
   * Steps every flare's fire and smoke to the room time `now` and returns its lights. `hand` places your own held
   * flare in view (camera space: eye, yaw, pitch); others hold theirs where the sim says.
   */
  update(state: WoodsState, world: WoodsWorld, me: number, now: number, dt: number, eye: readonly number[], hand: { yaw: number; pitch: number }, feel: Feel, wind: { wind: number }, shadowed = 3) {
    this.settings.burnTime = feel.flareBurn
    for (const s of this.shown.values()) s.seen = false
    let nearest: { x: number; z: number } | null = null, nearestD = Infinity
    for (const f of state.flares.list) {
      let s = this.shown.get(f.id)
      // Ids start again each night: a different strike under an old id is a new flare.
      if (!s || s.lit !== f.lit) {
        s = { fx: new FlareFx(f.seed, this.settings), light: { x: 0, y: 0, z: 0, r: 1, g: 0, b: 0, level: 0 }, lit: f.lit, seen: true, own: false }
        s.fx.strike(now - f.lit)
        this.shown.set(f.id, s)
      }
      s.seen = true
      s.own = f.by === me && !f.body
      this.place(s.fx, f, state, world, me, eye, hand)
      const d = Math.hypot(s.fx.x - eye[0]!, s.fx.z - eye[2]!)
      if (d < nearestD && s.fx.age > 0) { nearestD = d; nearest = s.fx }
    }
    for (const [id, s] of this.shown) if (!s.seen) this.shown.delete(id)

    // Smoke settles onto the wind at the nearest flare: the gust you hear in the canopy leans it, a lull lets it stand.
    if (nearest) {
      const g = gustAt(nearest.x, nearest.z, now) * this.look.drift * wind.wind
      this.pool.windX = WIND_DIR[0] * g
      this.pool.windZ = WIND_DIR[1] * g
    }
    if (this.pool.count > 0) {
      if (this.groundOf !== world) { this.groundOf = world; this.ground = (x, z) => groundHeight(world, x, z) }
      this.pool.update(dt, NO_COLLIDERS, this.ground!)
    }
    for (const s of this.shown.values()) {
      // The page's clock runs the burn; the room's corrects it if they drift apart (a hitch, a hidden tab).
      Object.assign(s.fx.settings, this.settings)
      if (s.own) { s.fx.settings.smoke *= OWN_SMOKE; s.fx.settings.halo *= OWN_HALO }
      const want = now - s.lit
      if (Math.abs(s.fx.age + dt - want) > 0.3) s.fx.age = want - dt
      s.fx.step(dt, this.pool)
      s.fx.light(s.light)
    }
    return this.lights(eye, shadowed)
  }

  /** Where a flare's burning end is and which way it jets: in your hand, a friend's, flying or lying on the ground. */
  private place(fx: FlareFx, f: Flare, state: WoodsState, world: WoodsWorld, me: number, eye: readonly number[], hand: { yaw: number; pitch: number }) {
    if (f.body) { flareOnBody(fx, f.body, STICK / 2); return }
    const fx0 = -Math.sin(hand.yaw), fz0 = -Math.cos(hand.yaw)
    if (f.by === me) {
      // Held out low on the right where you can see it, burning end up and away.
      const lift = Math.sin(hand.pitch) * 0.2
      fx.x = eye[0]! + fx0 * 0.62 - fz0 * 0.3
      fx.y = eye[1]! - 0.22 + lift
      fx.z = eye[2]! + fz0 * 0.62 + fx0 * 0.3
      const l = Math.hypot(0.35, 0.9)
      fx.dx = (fx0 * 0.35 + -fz0 * 0.08) / l; fx.dy = 0.9 / l; fx.dz = (fz0 * 0.35 + fx0 * 0.08) / l
    } else {
      const p = state.players.find((q) => q.id === f.by)
      if (!p) return
      const [x, y, z] = handFlare(world, p)
      const pf = -Math.sin(p.yaw), pz = -Math.cos(p.yaw)
      fx.x = x; fx.y = y; fx.z = z
      const l = Math.hypot(0.4, 0.9)
      fx.dx = pf * 0.4 / l; fx.dy = 0.9 / l; fx.dz = pz * 0.4 / l
    }
    fx.vx = fx.vy = fx.vz = 0
  }

  private lights(eye: readonly number[], shadowed: number) {
    const L = this.look
    this.scene.length = 0; this.fog.length = 0; this.glows.length = 0; this.particleLights.length = 0
    this.order.length = 0
    this.out.particles.falloff = L.smokeCore
    for (const s of this.shown.values()) if (s.light.level > 0.001) this.order.push({ s, d: Math.hypot(s.light.x - eye[0]!, s.light.y - eye[1]!, s.light.z - eye[2]!) })
    this.order.sort((a, b) => a.d - b.d)
    let id = 0
    for (const { s, d } of this.order) {
      const l = s.light
      const n = id++
      if (n < MAX_LIGHTS) {
        if (L.power > 0) this.scene.push(flareSceneLight(l, L.power, L.reach, L.shadows && n < shadowed, 5000 + n))
        // Past 70 m the mist's own glow is all behind trunks; the far haze below stands in for it.
        if (L.fog > 0 && d < 70) this.fog.push(flareFogLamp(l, L.power * 5 * L.fog * (s.own ? OWN_FOG : 1), L.fogRange, 5000 + n))
      }
      if (n < 8) this.particleLights.push(flareSceneLight(l, L.power, Math.max(L.reach, 12), false, 6000 + n))
      // Far off, the flame itself is under a pixel: a point glow carries it (faded in past 8 m, where the particles stop reading).
      const far = Math.min(1, Math.max(0, (d - 8) / 12))
      if (far > 0 && L.glow > 0) {
        // As bright for its power as the ridge beacon's (power 4, glow 400).
        const k = 100 * L.power * L.glow * l.level * far
        this.glows.push({ x: l.x, y: l.y - 0.18, z: l.z, radius: 0.35, color: [l.r * k, l.g * k, l.b * k] })
      }
      // Past the mist's own reach the lit air round it is a faint red haze over the flare, cut up by the trunks in front.
      // Its peak radiance was set by eye in the woods at 60 and 120 m (`scripts/flare-proof.ts`).
      const haze = Math.min(1, Math.max(0, (d - 40) / 40))
      if (haze > 0 && L.haze > 0) {
        const k = 0.5 * L.power * L.fog * L.haze * l.level * haze
        this.glows.push({ x: l.x, y: l.y + 3.5, z: l.z, radius: 11, color: [l.r * k, l.g * k, l.b * k], soft: true })
      }
    }
    return this.out
  }

  /** The sticks: burning ones where their fire is, and the spares lying on the camp table. */
  draw(fp: FrameParts, state: WoodsState, world: WoodsWorld) {
    for (const s of this.shown.values()) {
      const f = s.fx
      // The model's +x runs from the stick to the burning end: pitch lifts it, yaw turns it.
      const pitch = Math.asin(Math.max(-1, Math.min(1, f.dy))), yaw = Math.atan2(f.dz, f.dx)
      fp.push(this.litModel, f.x, f.y, f.z, yaw, [1, 1, 1], pitch, 0, 0)
    }
    const t = flareTable(world)
    for (let i = 0; i < state.flares.spares; i++) fp.push(this.sparesModel, t.x - 0.1 + i * 0.07, t.y + 0.0125, t.z - 0.05 + i * 0.03, 0.3 + i * 0.2, [1, 1, 1], 0, 0, 0)
  }

  /** Lit flares and particles in use (telemetry). */
  stats() {
    return { flares: this.shown.size, particles: this.pool.count, lights: this.scene.length }
  }
}
