import { type Archipelago, terrainHeight } from "../../shared/islands"
import { type Sea, seaHeight } from "../../shared/sea"
import { VEHICLES, type VehicleKind } from "../../shared/vehicles"
import { BoatWake } from "../render/boat-wake"
import { FLIGHT_FX, FlightFx, flightFxQuality, vapourAmount } from "../render/flight-fx"
import type { PlaneModels } from "../render/plane-glb"
import { HEAT_SOURCES } from "../render/post"
import type { Renderer } from "../render/renderer"
import type { WeaponFx } from "../render/weapon-fx"

const DEG = Math.PI / 180
const SPRAY: [number, number, number] = [0.93, 0.96, 0.99]
/** Jets further than this from the camera get no spray, condensation or shimmer (m). */
const NEAR_FX = 2500
/** Wake trail ids, clear of the boats' (BoatWake keys its trails by id). */
const WAKE_ID = 0x7a000

/** A jet as the juice needs it: centre, velocity, orientation (body → world), load factor and engine. */
export type JuiceJet = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  qx: number
  qy: number
  qz: number
  qw: number
  g: number
  throttle: number
  burner: number
  kind: VehicleKind
  /** Flying free (not on the deck, landing or crashed): only then condensation, cones and spray. */
  flying: boolean
}

type Heat = { ax: number; ay: number; bx: number; by: number; ra: number; rb: number; s: number; d: number }

/**
 * The flight juice for every jet drawn (src/render/flight-fx.ts and friends): air streaks and the burner FOV kick for
 * the pilot's own view, wingtip and over-wing vapour from g and angle of attack, the vapour cone and shock ring when a
 * jet passes its cone speed, heat shimmer behind the nozzles (the composite's distortion, post.ts), and spray and a
 * short wake on the sea when flying low. Remote jets get all of it from their relayed state.
 *
 * Per frame: `begin(...)`, `jet(...)` for each jet (it returns the wingtip vapour for PlaneFx), `streaks(...)` for the
 * pilot's own jet, then `end()`. Add it after the carriers' Wake (its BoatWake draws onto their wake field).
 */
export class FlightJuice {
  readonly fx: FlightFx
  readonly wake: BoatWake
  /** Called when a jet passes its cone speed (id, -1 for the pilot's own). */
  onBoom: ((id: number) => void) | null = null
  private armed = new Map<number, boolean>()
  private sprayDebt = new Map<number, number>()
  private eye = [0, 0, 0]
  private vp: ArrayLike<number> = new Float32Array(16)
  private focal = 1
  private w = 1
  private h = 1
  private t = 0
  private dt = 0
  private sea: Sea | null = null
  private arch: Archipelago | null = null
  private heats: Heat[] = []
  private kick = 0
  private ownBurner = false

  constructor(
    private renderer: Renderer,
    private models: PlaneModels,
    private wfx: WeaponFx | null,
  ) {
    this.wake = new BoatWake(renderer)
    this.fx = new FlightFx(renderer)
    renderer.addPass("alpha", this.wake)
    renderer.addPass("alpha", this.fx)
  }

  /** The FOV the camera adds on top of its own (radians): a short kick when the burner lights or the cone pops. */
  get fovKick(): number {
    return this.kick * FLIGHT_FX.fovKick * DEG
  }

  begin(eye: ArrayLike<number>, viewProj: ArrayLike<number>, fov: number, t: number, dt: number, sea: Sea | null, arch: Archipelago | null): void {
    this.eye[0] = eye[0]!
    this.eye[1] = eye[1]!
    this.eye[2] = eye[2]!
    this.vp = viewProj
    this.w = this.renderer.width
    this.h = this.renderer.height
    this.focal = (this.h * 0.5) / Math.tan(fov / 2)
    this.t = t
    this.dt = dt
    this.sea = sea
    this.arch = arch
    this.heats.length = 0
    this.fx.begin(eye, dt)
    this.wake.begin(t)
    this.kick *= Math.exp(-dt / 0.35)
  }

  /** The pilot's own view: streaks past the camera (flying at the jet's velocity) and the light-up kick. */
  streaks(j: JuiceJet | null, cockpit: boolean): void {
    if (!j || !j.flying) {
      this.fx.streaks(0, 0, 0, 0, cockpit)
      this.ownBurner = false
      return
    }
    const lit = j.burner > 0.5
    if (lit && !this.ownBurner) this.kick = Math.max(this.kick, 1)
    this.ownBurner = lit
    this.fx.streaks(j.vx, j.vy, j.vz, j.burner, cockpit)
  }

  /** One jet (model matrix `m`). Returns its wingtip vapour 0..1 (PlaneFx.plane's `vapour`). */
  jet(id: number, m: Float32Array, j: JuiceJet): number {
    const speed = Math.hypot(j.vx, j.vy, j.vz)
    const dist = Math.hypot(j.x - this.eye[0]!, j.y - this.eye[1]!, j.z - this.eye[2]!)
    // Angle of attack: the nose above the flight path, in the plane of the wings.
    const { qx, qy, qz, qw } = j
    const nx = 2 * (qx * qz + qw * qy)
    const ny = 2 * (qy * qz - qw * qx)
    const nz = 1 - 2 * (qx * qx + qy * qy)
    const ux = 2 * (qx * qy - qw * qz)
    const uy = 1 - 2 * (qx * qx + qz * qz)
    const uz = 2 * (qy * qz + qw * qx)
    const aoa = speed > 20 ? Math.atan2(-(j.vx * ux + j.vy * uy + j.vz * uz), j.vx * nx + j.vy * ny + j.vz * nz) / DEG : 0
    const vapour = j.flying && speed > 60 ? vapourAmount(j.g, aoa) : 0
    const near = dist < NEAR_FX
    if (near && vapour > 0) this.fx.wing(m, j.kind, vapour)

    // The vapour cone: once each time the jet passes its cone speed.
    const cone = FLIGHT_FX.coneSpeed * VEHICLES[j.kind].flight.boostSpeed
    const armed = this.armed.get(id)
    if (armed === undefined) this.armed.set(id, speed < cone)
    else if (armed && j.flying && speed >= cone) {
      this.armed.set(id, false)
      if (near) this.fx.boom(id, j.x, j.y, j.z, j.vx / speed, j.vy / speed, j.vz / speed)
      if (id < 0) this.kick = Math.max(this.kick, 1)
      this.onBoom?.(id)
    } else if (!armed && speed < cone - 12) this.armed.set(id, true)
    this.fx.cone(id, m, VEHICLES[j.kind].flight.centre)

    if (near) {
      this.heat(m, j, nx, ny, nz, dist)
      this.spray(id, j, speed, dist)
    }
    return vapour
  }

  /** Heat shimmer candidates: each nozzle's plume as a screen capsule, kept for the nearest few at `end`. */
  private heat(m: Float32Array, j: JuiceJet, nx: number, ny: number, nz: number, dist: number): void {
    if (!FLIGHT_FX.shimmer || flightFxQuality() < 0.4) return
    const hot = Math.max(0, j.throttle - 0.5) * 2 * 0.45 + j.burner
    if (hot < 0.05 || dist > 600) return
    const model = this.models[j.kind]
    const len = 3 + 4 * hot + 6 * j.burner
    for (const n of model.nozzles) {
      const ax = m[0]! * n[0] + m[4]! * n[1] + m[8]! * n[2] + m[12]!
      const ay = m[1]! * n[0] + m[5]! * n[1] + m[9]! * n[2] + m[13]!
      const az = m[2]! * n[0] + m[6]! * n[1] + m[10]! * n[2] + m[14]!
      const a = this.project(ax, ay, az)
      if (!a) continue
      let bx = ax - nx * len
      let by = ay - ny * len
      let bz = az - nz * len
      let b = this.project(bx, by, bz)
      if (!b) {
        // The plume runs past the camera: stop it just in front.
        const k = Math.max(0, (a[2] - 1) / Math.max(1e-3, a[2] - this.clipW(bx, by, bz)))
        bx = ax + (bx - ax) * k
        by = ay + (by - ay) * k
        bz = az + (bz - az) * k
        b = this.project(bx, by, bz)
        if (!b) continue
      }
      const r0 = model.nozzleRadius * 0.9
      const r1 = model.nozzleRadius * (2.2 + 1.5 * j.burner)
      this.heats.push({
        ax: a[0],
        ay: a[1],
        bx: b[0],
        by: b[1],
        ra: Math.min(this.h * 0.25, (r0 * this.focal) / a[2]),
        rb: Math.min(this.h * 0.35, (r1 * this.focal) / b[2]),
        s: FLIGHT_FX.shimmerPx * Math.min(1, hot) * Math.min(1, 60 / Math.max(dist, 1)) ** 0.5,
        d: dist,
      })
    }
  }

  private clipW(x: number, y: number, z: number): number {
    const v = this.vp
    return v[3]! * x + v[7]! * y + v[11]! * z + v[15]!
  }

  /** Screen pixels and clip w, or null behind the camera. */
  private project(x: number, y: number, z: number): [number, number, number] | null {
    const v = this.vp
    const w = this.clipW(x, y, z)
    if (w < 0.5) return null
    const cx = v[0]! * x + v[4]! * y + v[8]! * z + v[12]!
    const cy = v[1]! * x + v[5]! * y + v[9]! * z + v[13]!
    return [(cx / w * 0.5 + 0.5) * this.w, (0.5 - (cy / w) * 0.5) * this.h, w]
  }

  /** Low over open water: white spray thrown up under the jet and a short wake behind it. */
  private spray(id: number, j: JuiceJet, speed: number, dist: number): void {
    const sea = this.sea
    const H = FLIGHT_FX.sprayHeight
    if (!sea || !j.flying || H <= 0) return
    const seaY = seaHeight(sea, j.x, j.z, this.t)
    const h = j.y - VEHICLES[j.kind].flight.centre - seaY
    if (h > H * 4 || (this.arch && terrainHeight(this.arch, j.x, j.z) > seaY - 1)) return
    const k = h < H ? (1 - Math.max(0, h) / H) ** 1.2 * Math.min(1, Math.max(0, (speed - 40) / 100)) : 0
    if (FLIGHT_FX.wake) this.wake.boat(WAKE_ID + (id & 0xfff), { x: j.x, z: j.z, heading: Math.atan2(j.vx, -j.vz), u: speed, wet: 0, wetAft: k })
    const fx = this.wfx
    if (!fx || k <= 0.01) return
    const q = flightFxQuality() * Math.min(1, 400 / Math.max(dist, 1))
    let n = (this.sprayDebt.get(id) ?? 0) + FLIGHT_FX.sprayRate * k * q * this.dt
    const hx = speed > 1 ? j.vx / speed : 0
    const hz = speed > 1 ? j.vz / speed : 0
    while (n >= 1) {
      n--
      // A rooster tail of white water just behind the jet, thrown up and out, carried along with it.
      const back = Math.random() * 10 - 2
      const side = (Math.random() * 2 - 1) * (2 + 5 * k)
      const x = j.x - hx * back - hz * side
      const z = j.z - hz * back + hx * side
      const out = (3 + 9 * Math.random()) * Math.sign(side)
      const carry = 0.55 + 0.3 * Math.random()
      fx.spray(x, seaY, z, j.vx * carry - hz * out, 2 + (3 + 8 * Math.random()) * k, j.vz * carry + hx * out, 0.5 + 0.7 * Math.random(), 0.3 + 0.3 * k, 0.8 + 1.4 * k, 1.5)
      if (Math.random() < 0.15)
        fx.spawn(1, x, seaY + 0.5, z, x, seaY + 0.5, z, j.vx * 0.2, 1.5 + 3 * k, j.vz * 0.2, 1.2 + Math.random(), 1.5, 5 + 6 * k, SPRAY[0], SPRAY[1], SPRAY[2], 0.25 * k + 0.08, 0.9, -1)
    }
    this.sprayDebt.set(id, n)
  }

  end(): void {
    this.fx.upload()
    this.wake.upload()
    // The nearest plumes shimmer (the composite has HEAT_SOURCES slots); the rest are off.
    const heat = this.renderer.heat
    heat.fill(0)
    this.heats.sort((a, b) => a.d - b.d)
    for (let i = 0; i < Math.min(HEAT_SOURCES, this.heats.length); i++) {
      const s = this.heats[i]!
      heat.set([s.ax, s.ay, s.bx, s.by, s.ra, s.rb, s.s, 0], i * 8)
    }
    if (this.sprayDebt.size > 64) this.sprayDebt.clear()
    if (this.armed.size > 128) this.armed.clear()
  }
}
