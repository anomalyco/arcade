import { vec4 } from "wgpu-matrix"
import { CELL, GRID, ROAD_HALF, VEHICLE_BY_ID, VEHICLES } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import type { CarView, WorldView } from "../../shared/sim/world"
import { buildCarVariants, buildHeli, buildRotor } from "../render/car-mesh"
import { buildPuff } from "../render/puff"
import { buildSpikeStrip } from "../render/spike"
import { buildCityMesh, type LampLight } from "../render/city-mesh"
import { MAT, Mesh } from "../render/mesh"
import { FRAME_FLOATS, INST_FLOATS, type InstanceBatch, type Renderer, SPRITE_FLOATS } from "../render/renderer"
import { MAX_LIGHTS } from "../render/shaders"
import type { Camera } from "./camera"
import { Fx } from "./fx"
import { juice } from "../ui/debug-overlay"
import { KERB_H } from "../render/city/streets"
import type { Input } from "../../shared/sim/vehicle"
import type { ShopSpill } from "../render/city/types"

const MAX_SPRITES_PER_LIST = 3000
const ROBBER_TINT: [number, number, number] = [1.0, 0.55, 0.12]
const COP_TINT: [number, number, number] = [0.25, 0.5, 1.0]
const SPOT_GROUND_RADIUS = 7.5
const HELI_SCALE = 0.8
const MOON = normalizeV([-0.55, 0.62, -0.55])

function normalizeV(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!)
  return [v[0]! / l, v[1]! / l, v[2]! / l]
}

type Vis = {
  roll: number; pitch: number; speed: number; h: number; fuel: number; smokeAcc: number; sparkAcc: number
  scrapeAcc: number; wheels: { x: number; z: number }[]; height: number; springV: number; ground: number
  boosting: boolean; throttle: number; backfire: number; crash: number; impactCool: number; braking: boolean
  boostHold: number; brakeHold: number; launch: number; landings: number; landY: number; landV: number; vy: number; flameAcc: number
}

/** Matches the shader's siren strobe so glows and lights flash in sync with the lamp geometry. */
export function sirenOn(phase: number, red: boolean) {
  if (phase < 0) return 0
  const t = phase - Math.floor(phase)
  const a = red ? (t <= 0.5 ? 1 : 0) : t >= 0.5 ? 1 : 0
  const strobe = (t * 4) % 1 >= 0.5 ? 1 : 0
  return a * (0.5 + 0.5 * strobe)
}

export class Scene {
  readonly fx = new Fx()
  private lamps: LampLight[]
  private spills: ShopSpill[]
  private models = new Map<string, number>()
  private variants = new Map<string, number[]>()
  private heliModel: number
  private rotorModel: number
  private puffModel: number
  private spikeModel: number
  private vis = new Map<number, Vis>()
  private frame = new Float32Array(FRAME_FLOATS)
  private lights = new Float32Array(MAX_LIGHTS * 12)
  private alpha = new Float32Array(MAX_SPRITES_PER_LIST * SPRITE_FLOATS)
  private add = new Float32Array(MAX_SPRITES_PER_LIST * SPRITE_FLOATS)
  private beams = new Mesh()
  private beamBuf = new Float32Array<ArrayBuffer>(new ArrayBuffer(4096 * 4))
  private batchMap = new Map<number, { data: Float32Array<ArrayBuffer>; count: number; ghostCount: number }>()
  private batchOut: InstanceBatch[] = []
  private nearLamps: { l: LampLight; d: number }[] = []
  private time = 0
  /** Camera shake requests from impacts on the followed car. */
  shake = 0
  hitStop = 0
  private hitStopCool = 0
  punch = 0
  lightCount = 0
  input: Input | null = null

  resetBench() {
    this.fx.puffs.length = 0
    this.fx.alpha.length = 0
    this.fx.add.length = 0
    this.fx.skids.length = 0
    this.vis.clear()
    this.time = 0
    this.shake = 0
    this.hitStop = 0
    this.hitStopCool = 0
    this.punch = 0
  }

  constructor(
    private renderer: Renderer,
    readonly city: City,
  ) {
    const built = buildCityMesh(city)
    renderer.setCity(built.mesh)
    this.lamps = built.lamps
    this.spills = built.spills
    for (const v of VEHICLES) {
      const ids = buildCarVariants(v).map((m) => renderer.addModel(m))
      this.variants.set(v.id, ids)
      this.models.set(v.id, ids[0]!)
    }
    this.heliModel = renderer.addModel(buildHeli())
    this.rotorModel = renderer.addModel(buildRotor())
    this.puffModel = renderer.addModel(buildPuff())
    this.spikeModel = renderer.addModel(buildSpikeStrip())
  }

  private visOf(c: CarView) {
    let v = this.vis.get(c.id)
    if (!v) {
      v = { roll: 0, pitch: 0, speed: c.speed, h: c.h, fuel: c.boost, smokeAcc: 0, sparkAcc: 0, scrapeAcc: 0, wheels: [], height: 0, springV: 0, ground: 0, boosting: false, throttle: 0, backfire: 0, crash: 0, impactCool: 1, braking: false, boostHold: 0, brakeHold: 0, launch: 0, landings: c.landings ?? 0, landY: 0, landV: 0, vy: c.vy ?? 0, flameAcc: 0 }
      this.vis.set(c.id, v)
    }
    return v
  }

  private groundAt(x: number, z: number) {
    const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL)
    if (ix < 0 || iz < 0 || ix >= GRID || iz >= GRID) return 0
    const a = x - ix * CELL - ROAD_HALF, b = z - iz * CELL - ROAD_HALF
    const width = CELL - ROAD_HALF * 2
    if (a < 0 || b < 0 || a > width || b > width) return 0
    const dx = Math.max(3 - a, a - (width - 3), 0), dz = Math.max(3 - b, b - (width - 3), 0)
    if (dx * dx + dz * dz > 9) return 0
    if (this.city.alleys.some((g) => x > g.x0 && x < g.x1 && z > g.z0 && z < g.z1)) return 0
    const park = this.city.parks.some((p) => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1)
    return park || Math.min(a, b, width - a, width - b) <= this.city.sidewalk ? KERB_H : 0
  }

  /** Presentation-only lab probes; never mutate the authoritative vehicle. */
  testEffect(key: string, car: CarView): void {
    const v = this.visOf(car), spec = VEHICLE_BY_ID.get(car.vehicle)!
    const fx = Math.sin(car.h), fz = Math.cos(car.h), rx = Math.cos(car.h), rz = -Math.sin(car.h)
    if (key === "sparks" || key === "scrape") {
      this.fx.sparks(car.x + fx * spec.length * 0.45, car.z + fz * spec.length * 0.45, -fx * 8, -fz * 8, 24, 0.3)
      v.crash = 0.06
    } else if (key === "backfire") {
      v.backfire = 0.07
      this.fx.backfire(car.x - fx * (spec.length / 2 + 0.3), 0.5 + v.height, car.z - fz * (spec.length / 2 + 0.3), -fx * 7, -fz * 7)
    } else if (key === "curb") v.springV = 2.5
    else if (key === "landing") { v.landV = -2.5; this.punch = 0.8 }
    else if (key === "trauma") { this.shake = 1; this.hitStop = 0.045 }
    else if (key === "skids") for (const a of [-1, 1]) for (const s of [-1, 1]) {
      const x = car.x + fx * spec.length * 0.32 * a + rx * spec.width * 0.4 * s
      const z = car.z + fz * spec.length * 0.32 * a + rz * spec.width * 0.4 * s
      this.fx.skidSegment(x - fx * 1.5, z - fz * 1.5, x, z, 0.6)
    }
  }

  /** Per-car visual dynamics (body roll, pitch) and particle emission. */
  private animate(view: WorldView, dt: number, focusId: number | null) {
    this.fx.update(dt)
    this.hitStopCool = Math.max(0, this.hitStopCool - dt)
    if (!juice.skids) this.fx.skids.length = 0
    for (const c of view.cars) {
      if (c.ghost) continue
      const v = this.visOf(c)
      const spec = VEHICLE_BY_ID.get(c.vehicle)!
      let dh = c.h - v.h
      dh = Math.atan2(Math.sin(dh), Math.cos(dh))
      const yawRate = dt > 0 ? dh / dt : 0
      const accel = dt > 0 ? (c.speed - v.speed) / dt : 0
      v.backfire = Math.max(0, v.backfire - dt)
      v.crash = Math.max(0, v.crash - dt)
      v.impactCool = Math.max(0, v.impactCool - dt)
      const input = c.id === focusId ? this.input : null
      // Snapshot speed derivatives alternate between zero and spikes. Lights follow controls, never that derivative.
      const brake = input ? input.brake > 0.1 || input.handbrake || input.throttle < 0 && c.vx * Math.sin(c.h) + c.vz * Math.cos(c.h) > 0.5 : !!c.braking
      v.brakeHold = brake ? 0.1 : Math.max(0, v.brakeHold - dt)
      v.braking = v.brakeHold > 0
      const boost = input ? input.boost && c.boost > 0 && c.stun <= 0 && !c.engineOff && !c.airborne : c.boosting ?? c.boost < v.fuel - 1e-4
      v.boostHold = boost ? 0.1 : Math.max(0, v.boostHold - dt)
      const boosting = v.boostHold > 0 && !c.engineOff
      if (boosting && !v.boosting && c.speed < 24 && !c.airborne) v.launch = 0.45
      else v.launch = Math.max(0, v.launch - dt)
      if ((c.landings ?? 0) > v.landings && juice.landing) {
        const impact = Math.max(c.landing ?? 0, Math.abs(v.vy))
        v.landV = -Math.min(2.8, impact * 0.22)
        if (impact > 8) this.fx.sparks(c.x, c.z, -c.vx, -c.vz, Math.min(10, Math.floor(impact * 0.6)), 0.08)
        if (c.id === focusId) this.punch = Math.min(1, impact / 14)
      }
      v.landings = c.landings ?? 0
      v.vy = c.vy ?? 0
      for (let left = dt; left > 0;) {
        const step = Math.min(left, 1 / 120)
        v.landV += (-v.landY * 180 - v.landV * 12) * step
        v.landY += v.landV * step
        left -= step
      }
      if (!juice.landing) v.landY = v.landV = 0
      const k = 1 - Math.exp(-dt * 8)
      v.roll += (Math.max(-0.11, Math.min(0.11, yawRate * c.speed * 0.0035)) - v.roll) * k
      v.pitch += (Math.max(-0.06, Math.min(0.06, -accel * 0.004)) - v.pitch) * k
      v.speed = c.speed
      v.h = c.h
      const fx = Math.sin(c.h)
      const fz = Math.cos(c.h)
      const rx = Math.cos(c.h)
      const rz = -Math.sin(c.h)
      const back = spec.length * 0.36
      const side = spec.width * 0.4
      const wheels = [-1, 1].flatMap((a) => [-1, 1].map((s) => ({ x: c.x + fx * spec.length * 0.32 * a + rx * side * s, z: c.z + fz * spec.length * 0.32 * a + rz * side * s })))
      const drift = c.drift > 4 && c.speed > 7
      const spin = !!input && input.throttle > 0.9 && c.speed < 9 && accel > 3
      if (juice.skids && !c.airborne && (c.y ?? 0) < 0.1 && (drift || v.braking || spin || v.launch > 0)) {
        wheels.forEach((wheel, i) => {
          if (v.launch > 0 && !drift && !v.braking && i >= 2) return
          const prev = v.wheels[i]
          if (prev) this.fx.skidSegment(prev.x, prev.z, wheel.x, wheel.z, drift ? 0.5 : v.launch > 0 ? 0.62 : 0.38, this.groundAt(wheel.x, wheel.z) + 0.025)
        })
      }
      v.wheels = wheels
      const ground = wheels.reduce((sum, p) => sum + this.groundAt(p.x, p.z), 0) / wheels.length
      if (juice.curb) {
        if (ground !== v.ground && c.speed > 2) v.springV += Math.min(1.6, c.speed * 0.06) * Math.abs(ground - v.ground) / KERB_H
        // Substep the damped second-order suspension; stable even on a slow render frame.
        for (let left = dt; left > 0;) {
          const step = Math.min(left, 1 / 120)
          v.springV += ((ground - v.height) * 180 - v.springV * 15) * step
          v.height += v.springV * step
          left -= step
        }
      } else { v.height = 0; v.springV = 0 }
      v.ground = ground
      if (!c.airborne && (c.y ?? 0) < 0.1 && (drift || juice.skids && v.launch > 0)) {
        const intensity = drift ? Math.min(1, (c.drift - 3) / 8) : 0.7
        v.smokeAcc += dt * 16 * intensity
        while (v.smokeAcc > 1) {
          v.smokeAcc -= 1
          const s = Math.random() < 0.5 ? -1 : 1
          this.fx.smoke(c.x - fx * back + rx * side * s, c.z - fz * back + rz * side * s, c.vx, c.vz, intensity)
        }
      }
      if (juice.backfire && ((boosting && !v.boosting) || (input && v.throttle > 0.9 && input.throttle < 0.2 && c.speed > 22))) {
        v.backfire = 0.07
        this.fx.backfire(c.x - fx * (spec.length / 2 + 0.3), 0.5 + v.height + (c.y ?? 0), c.z - fz * (spec.length / 2 + 0.3), -fx * 7, -fz * 7)
      }
      v.boosting = boosting
      v.throttle = input?.throttle ?? 0
      if (boosting) {
        v.flameAcc += dt * 30
        while (v.flameAcc >= 1) {
          v.flameAcc--
          for (const s of spec.id === "bike" ? [0] : [-0.35, 0.35]) this.fx.flame(c.x - fx * (spec.length / 2 + 0.2) + rx * s, 0.5 + v.height + (c.y ?? 0), c.z - fz * (spec.length / 2 + 0.2) + rz * s, -fx * 8, -fz * 8)
        }
      } else v.flameAcc = 0
      v.fuel = c.boost
      if (juice.scrape && c.impact > 0.35 && c.speed > 4) {
        v.scrapeAcc += dt * (12 + Math.min(c.speed, 40))
        const count = Math.floor(v.scrapeAcc)
        v.scrapeAcc -= count
        if (count) this.fx.sparks(c.x + fx * spec.length * 0.4, c.z + fz * spec.length * 0.4, -c.vx, -c.vz, count, 0.18)
      } else v.scrapeAcc = 0
      // On the rims: sparks trail off the bare wheels.
      if (!c.airborne && c.wheels === 15 && c.speed > 2) {
        v.sparkAcc += dt * (4 + c.speed * 1.5)
        const along = spec.length * 0.32
        const side = spec.width * 0.4
        while (v.sparkAcc > 1) {
          v.sparkAcc -= 1
          const k = Math.floor(Math.random() * 4)
          const a = k < 2 ? along : -along
          const s = k % 2 ? side : -side
          this.fx.sparks(c.x + fx * a + rx * s, c.z + fz * a + rz * s, -fx, -fz, 2, 0.1)
        }
      }
      if (c.impact > 5 && v.impactCool === 0) {
        v.impactCool = 0.15
        if (juice.sparks) v.crash = 0.06
        const sp = Math.hypot(c.vx, c.vz) || 1
        this.fx.sparks(c.x + (c.vx / sp) * spec.length * 0.45, c.z + (c.vz / sp) * spec.length * 0.45, -c.vx / sp, -c.vz / sp, Math.min(24, Math.floor(c.impact)))
        if (c.id === focusId && juice.trauma) {
          this.shake = Math.max(this.shake, Math.min(1, c.impact / 18))
          if (c.impact > 9 && this.hitStopCool === 0) {
            this.hitStop = 0.045
            this.hitStopCool = 1
          }
        }
      }
    }
  }

  draw(view: WorldView, cam: Camera, w: number, h: number, dt: number, focus: CarView | null, opts: { bloom?: number; flash?: number } = {}) {
    this.time += dt
    this.animate(view, dt, focus?.id ?? null)
    const t = this.time
    const vp = cam.matrices(w / h)
    const f = this.frame
    f.set(vp, 0)
    // Shadow camera: orthographic from the moon, centered on the camera focus.
    const lightEye = [cam.fx + MOON[0] * 300, MOON[1] * 300, cam.fz + MOON[2] * 300]
    f.set(lightMatrix(lightEye, [cam.fx, 0, cam.fz]), 16)
    let o = 32
    const put = (a: number, b: number, c: number, d: number) => {
      f[o++] = a
      f[o++] = b
      f[o++] = c
      f[o++] = d
    }
    put(cam.eye[0], cam.eye[1], cam.eye[2], t)
    const fp = focus ? [focus.x, 1, focus.z] : [cam.fx, 1, cam.fz]
    put(fp[0]!, fp[1]!, fp[2]!, focus ? 0.24 : 0)
    put(w, h, 0, t)
    put(MOON[0], MOON[1], MOON[2], juice.tightPools ? 0.36 : 0.6)
    const heli = view.heli
    if (heli.active) {
      const ox = heli.x + Math.sin(heli.h) * 1.7
      const oz = heli.z + Math.cos(heli.h) * 1.7
      const dir = normalizeV([heli.sx - ox, -heli.y - 0.4, heli.sz - oz])
      put(ox, heli.y + 0.4, oz, 1)
      const reach = Math.hypot(heli.sx - ox, heli.y, heli.sz - oz)
      put(dir[0], dir[1], dir[2], Math.cos(Math.atan(SPOT_GROUND_RADIUS * juice.spotlightRadius / reach)) - 0.003)
    } else {
      put(0, 0, 0, 0)
      put(0, -1, 0, 1)
    }
    put(0.035, 0.045, 0.085, 0.0035)
    const clip = vec4.transformMat4([fp[0]!, fp[1]!, fp[2]!, 1], vp)
    put(clip[0]! / clip[3]!, clip[1]! / clip[3]!, clip[2]! / clip[3]!, 0)
    put(juice.spotlightSoftness, juice.flatGround ? 0.035 : juice.roadSheen, +juice.tightPools, +juice.wallGradients)
    put(+juice.shopSpill, +juice.grounding, 0, 0)

    // Lights: cars first (they matter most), then the street lamps nearest to the camera focus.
    const L = this.lights
    let n = 0
    const light = (x: number, y: number, z: number, radius: number, r: number, g: number, b: number, intensity: number, dx = 0, dy = 0, dz = 0, cone = -2) => {
      if (n >= MAX_LIGHTS) return
      const i = n * 12
      L[i] = x
      L[i + 1] = y
      L[i + 2] = z
      L[i + 3] = radius
      L[i + 4] = r
      L[i + 5] = g
      L[i + 6] = b
      L[i + 7] = intensity
      L[i + 8] = dx
      L[i + 9] = dy
      L[i + 10] = dz
      L[i + 11] = cone
      n++
    }

    const alpha = this.alpha
    const add = this.add
    let ai = 0
    let di = 0
    const sprite = (list: "a" | "d", x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot = 0, stretch = 1, extra = 0) => {
      if (list === "a") {
        if (ai < MAX_SPRITES_PER_LIST) Fx.write(alpha, ai++, { x, y, z, size, r, g, b, a, kind, rot, stretch, seed: extra })
      } else if (di < MAX_SPRITES_PER_LIST) Fx.write(add, di++, { x, y, z, size, r, g, b, a, kind, rot, stretch, seed: extra })
    }

    const beams = this.beams
    beams.v.length = 0
    for (const slot of this.batchMap.values()) {
      slot.count = 0
      slot.ghostCount = 0
    }
    const pushInst = (
      model: number,
      ghost: boolean,
      x: number,
      y: number,
      z: number,
      yaw: number,
      roll: number,
      pitch: number,
      siren: number,
      brake: number,
      tr: number,
      tg: number,
      tb: number,
      scale: number,
    ) => {
      let slot = this.batchMap.get(model)
      if (!slot) {
        slot = { data: new Float32Array(new ArrayBuffer(64 * INST_FLOATS * 4)), count: 0, ghostCount: 0 }
        this.batchMap.set(model, slot)
      }
      if ((slot.count + 1) * INST_FLOATS > slot.data.length) {
        const next = new Float32Array(new ArrayBuffer(slot.data.length * 2 * 4))
        next.set(slot.data)
        slot.data = next
      }
      const b = slot.data
      const o = slot.count * INST_FLOATS
      b[o] = x
      b[o + 1] = y
      b[o + 2] = z
      b[o + 3] = yaw
      b[o + 4] = roll
      b[o + 5] = pitch
      b[o + 6] = siren
      b[o + 7] = brake
      b[o + 8] = tr
      b[o + 9] = tg
      b[o + 10] = tb
      b[o + 11] = scale
      slot.count++
      if (ghost) slot.ghostCount = slot.count
    }

    for (const c of view.cars) {
      const spec = VEHICLE_BY_ID.get(c.vehicle)!
      const vs = this.variants.get(c.vehicle)!
      const model = vs[c.id % vs.length]!
      const tint = c.role === "robber" ? ROBBER_TINT : COP_TINT
      if (c.ghost) {
        // Last-seen ping for cops: a pulsing ring and a faint silhouette where the suspect was.
        const pulse = (t * 1.2) % 1
        sprite("d", c.x, 0.15, c.z, 3 + pulse * 9, 1, 0.2, 0.15, 1.6 * (1 - pulse), 2)
        sprite("d", c.x, 0.12, c.z, 5, 1, 0.2, 0.15, 0.4, 3)
        continue
      }

      const v = this.visOf(c)
      const siren = c.role === "cop" ? t * 1.7 + c.id * 0.37 : -1
      const braking = v.braking ? 1 : 0
      const altitude = c.y ?? 0
      if (juice.grounding || altitude > 0.1) sprite("a", c.x, v.ground + 0.018, c.z, spec.width * (juice.grounding ? 0.85 : 0.55) / (1 + altitude * 0.06), 0, 0, 0, (juice.grounding ? 0.7 : 0.55) / (1 + altitude * 0.45), juice.grounding ? 9 : 7, c.h, spec.length / spec.width * (juice.grounding ? 0.85 : 1), altitude)
      // Popped tires: the body sags at those corners (roll toward the flat side, nose or tail down) and shimmies a little.
      const wm = c.wheels ?? 0
      let sagRoll = 0
      let sagPitch = 0
      let sagY = v.height + altitude + v.landY
      if (wm) {
        const left = (wm & 1) + ((wm >> 2) & 1)
        const right = ((wm >> 1) & 1) + ((wm >> 3) & 1)
        const front = (wm & 1) + ((wm >> 1) & 1)
        const rear = ((wm >> 2) & 1) + ((wm >> 3) & 1)
        sagRoll = -0.06 * (right - left) + 0.012 * Math.sin(t * (6 + c.speed * 0.8) + c.id) * Math.min(1, c.speed / 8)
        sagPitch = 0.025 * (front - rear)
        sagY -= 0.045 * (left + right)
      }
      if (c.engineOff) {
        // Engine off: exactly like a parked car (same instance params, no lights, glows or silhouette), so it blends in.
        const isFocus = c.id === focus?.id
        pushInst(model, isFocus, c.x, sagY, c.z, c.h, sagRoll, sagPitch + Math.max(-0.2, Math.min(0.2, -(c.vy ?? 0) / Math.max(15, c.speed))), -1, -1, isFocus ? tint[0] : 0, isFocus ? tint[1] : 0, isFocus ? tint[2] : 0, 1)
        continue
      }
      const jumpPitch = Math.max(-0.2, Math.min(0.2, -(c.vy ?? 0) / Math.max(15, c.speed)))
      pushInst(model, true, c.x, sagY, c.z, c.h, v.roll + sagRoll, v.pitch + sagPitch + jumpPitch, siren, braking, tint[0], tint[1], tint[2], 1)

      const fx = Math.sin(c.h)
      const fz = Math.cos(c.h)
      const rx = Math.cos(c.h)
      const rz = -Math.sin(c.h)
      const half = spec.length / 2
      if (juice.sparks && v.crash > 0) light(c.x + fx * half, 0.7 + v.height, c.z + fz * half, 7, 1, 0.35, 0.06, 5 * v.crash / 0.06)
      if (juice.backfire && v.backfire > 0) light(c.x - fx * (half + 0.3), 0.65 + v.height, c.z - fz * (half + 0.3), 4, 0.45, 0.55, 1, 3 * v.backfire / 0.07)
      // Headlights: one spot per car, plus lens glows and a soft pool on the road ahead.
      light(c.x + fx * (half + 0.5), 1.3 + sagY, c.z + fz * (half + 0.5), 36, 1, 0.92, 0.78, 3.2, fx * 0.95, -0.3, fz * 0.95, 0.8)
      const hw = spec.width / 2 - 0.25
      for (const s of spec.id === "bike" ? [0] : [-1, 1]) {
        sprite("d", c.x + fx * (half + 0.1) + rx * hw * s, 0.75 + sagY, c.z + fz * (half + 0.1) + rz * hw * s, 0.55, 1, 0.95, 0.85, 1.4, 0)
        sprite("d", c.x - fx * (half + 0.05) + rx * hw * s, 0.75 + sagY, c.z - fz * (half + 0.05) + rz * hw * s, braking ? 0.9 : 0.55, 1, 0.12, 0.08, braking ? 2.2 : 1.1, 0)
      }
      // No beam geometry: the spot light lights the road, plus a faint soft pool ahead of the car.
      sprite("d", c.x + fx * (half + 6), 0.06, c.z + fz * (half + 6), 2.6, 1, 0.9, 0.72, 0.1, 3, c.h, 2.2)
      light(c.x - fx * (half + 0.6), 0.9 + sagY, c.z - fz * (half + 0.6), 7, 1, 0.1, 0.06, braking ? 3 : 1.2)
      if (siren >= 0) {
        const red = sirenOn(siren, true)
        const blue = sirenOn(siren, false)
        const y = (spec.id === "swat" ? 2.9 : 1.9) + sagY
        // Siren light sits low and to the sides so it paints the road and walls, not the car's own livery.
        light(c.x - rx * 2.2, y - 1.2, c.z - rz * 2.2, 14, 1, 0.08, 0.08, 3 * red)
        light(c.x + rx * 2.2, y - 1.2, c.z + rz * 2.2, 14, 0.15, 0.3, 1, 3.6 * blue)
        if (red > 0) sprite("d", c.x - rx * 0.45, y, c.z - rz * 0.45, 0.9, 1, 0.1, 0.1, 1.5 * red, 0)
        if (blue > 0) sprite("d", c.x + rx * 0.45, y, c.z + rz * 0.45, 0.9, 0.2, 0.35, 1, 1.7 * blue, 0)
        // Colored wash on the road around the cruiser.
        sprite("d", c.x, 0.08, c.z, 7, red > blue ? 1 : 0.2, 0.15, red > blue ? 0.15 : 1, 0.12 * Math.max(red, blue), 3)
      }
    }

    for (const p of this.city.parked) {
      if ((p.x - cam.fx) ** 2 + (p.z - cam.fz) ** 2 > 260 * 260) continue
      // Parked cars have their lamps off (brake param -1), the same as an engine-off player car.
      pushInst(this.models.get(p.model)!, false, p.x, 0, p.z, p.h, 0, 0, -1, -1, 0, 0, 0, 1)
    }

    // Deployed spike strips: the model plus blinking red end glows so they read at a glance.
    for (const p of view.props ?? []) {
      if (p.kind !== "spike") continue
      pushInst(this.spikeModel, false, p.x, 0, p.z, p.h, 0, 0, -1, 0, 0, 0, 0, 1)
      const blink = Math.floor(t * 3 + p.id) % 2 === 0 ? 1.8 : 0.6
      const ax = Math.cos(p.h) * p.r
      const az = -Math.sin(p.h) * p.r
      for (const s of [-1, 1]) sprite("d", p.x + ax * s, 0.3, p.z + az * s, 0.9, 1, 0.12, 0.08, blink, 0)
      sprite("d", p.x, 0.06, p.z, p.r * 1.1, 1, 0.75, 0.2, 0.08, 3, p.h, 0.25)
    }

    // Helicopter with spinning rotor and its spotlight beam.
    if (heli.active) {
      pushInst(this.heliModel, false, heli.x, heli.y, heli.z, heli.h, 0.05, 0.08, -1, 0, 1, 1, 1, HELI_SCALE)
      pushInst(this.rotorModel, false, heli.x, heli.y + (3.1 * HELI_SCALE) / 1.2, heli.z, t * 25, 0, 0, -1, 0, 1, 1, 1, HELI_SCALE)
      pushInst(
        this.rotorModel,
        false,
        heli.x + (Math.sin(heli.h) * -7.9 * HELI_SCALE) / 1.2,
        heli.y + (2.3 * HELI_SCALE) / 1.2,
        heli.z + (Math.cos(heli.h) * -7.9 * HELI_SCALE) / 1.2,
        t * 40,
        0,
        0,
        -1,
        0,
        1,
        1,
        1,
        0.1,
      )
      const sx = heli.x + Math.sin(heli.h) * 1.7
      const sz = heli.z + Math.cos(heli.h) * 1.7
      cone(beams, [sx, heli.y + 0.4, sz], [heli.sx, 0, heli.sz], SPOT_GROUND_RADIUS * juice.spotlightRadius, [0.75, 0.85, 1], 0.32)
      sprite("d", heli.sx, 0.1, heli.sz, SPOT_GROUND_RADIUS * juice.spotlightRadius * 1.3, 0.85, 0.92, 1, 0.1, 3)
      sprite("d", heli.x, heli.y - 0.5, heli.z, 1.6, 1, 1, 1, 2.5, 0)
      if (Math.floor(t * 1.5) % 2 === 0) sprite("d", heli.x, heli.y + 1.6, heli.z, 1.2, 1, 0.1, 0.1, 2, 0)
    }

    // Repair bays: a soft teal pulse on each working bay floor for a driver with flat tires.
    if (focus && focus.ownerId === view.robberId && focus.wheels && view.phase === "chase") {
      const pulse = (t * 0.8) % 1
      this.city.shops.forEach((s, i) => {
        if ((view.shopCool?.[i] ?? 0) > 0) return
        if ((s.x - cam.fx) ** 2 + (s.z - cam.fz) ** 2 > 200 * 200) return
        sprite("d", s.x, 0.25, s.z, 4.5, 0.25, 1, 0.8, 0.22 + 0.12 * Math.sin(t * 3), 3)
        sprite("d", s.x, 0.25, s.z, 2.5 + pulse * 4, 0.25, 1, 0.8, 1.2 * (1 - pulse), 2)
      })
    }

    // Bust ring around a boxed-in robber.
    const robber = view.cars.find((c) => c.ownerId === view.robberId && !c.ghost)
    if (robber && view.bust > 0.01) {
      sprite("d", robber.x, 0.15, robber.z, 5.5, 0.25, 0.55, 1, 1 + view.bust * 2, 2, -t * 2)
    }

    if (juice.shopSpill) for (const s of this.spills) {
      if ((s.x - cam.fx) ** 2 + (s.z - cam.fz) ** 2 > 125 ** 2) continue
      sprite("d", s.x, KERB_H + 0.014, s.z, s.width + 0.4, 1, 0.39, 0.085, 0.14, 8, s.yaw, 2.5 / (s.width + 0.4))
    }
    if (juice.grounding) {
      for (const b of this.city.boxes) {
        const x = (b.x0 + b.x1) / 2, z = (b.z0 + b.z1) / 2
        if ((x - cam.fx) ** 2 + (z - cam.fz) ** 2 > 125 ** 2) continue
        const hx = (b.x1 - b.x0) / 2, hz = (b.z1 - b.z0) / 2
        for (const side of [-1, 1]) {
          sprite("a", x, KERB_H + 0.012, z + side * hz, hx + 0.6, 0, 0, 0, 0.42, 8, 0, 0.95 / (hx + 0.6))
          sprite("a", x + side * hx, KERB_H + 0.012, z, 0.95, 0, 0, 0, 0.42, 8, 0, (hz + 0.6) / 0.95)
        }
      }
      for (const t of this.city.trees) {
        if ((t.x - cam.fx) ** 2 + (t.z - cam.fz) ** 2 > 125 ** 2) continue
        sprite("a", t.x, t.planter ? KERB_H + 0.556 : 0.425, t.z, 1.15 * t.s, 0, 0, 0, 0.55, 3)
      }
    }
    // Street lamps: glows for all nearby, real lights for the closest.
    const near = this.nearLamps
    near.length = 0
    for (let i = 0; i < this.lamps.length; i++) {
      const l = this.lamps[i]!
      const d = (l.x - cam.fx) ** 2 + (l.z - cam.fz) ** 2
      if (d < 230 * 230) near.push({ l, d })
    }
    near.sort((a, b) => a.d - b.d)
    for (let i = 0; i < near.length; i++) {
      const l = near[i]!.l
      sprite("d", l.x, l.y, l.z, l.small ? 0.6 : 0.9, 1, 0.75, 0.45, 1.6, 0)
    }
    // Real lights only for lamps that can light what's on screen; the rest just glow.
    for (let i = 0; i < near.length; i++) {
      const { l, d } = near[i]!
      if (d < 120 * 120) light(l.x, l.y, l.z, juice.tightPools ? (l.small ? 6 : 10.5) : (l.small ? 10 : 17), 1, juice.tightPools ? 0.48 : 0.58, juice.tightPools ? 0.15 : 0.26, juice.tightPools ? (l.small ? 5 : 18) : (l.small ? 3 : 5))
    }
    f[32 + 8 + 2] = n
    this.lightCount = n

    const puffs = this.fx.puffInstances()
    for (let i = 0; i < puffs.length; i += INST_FLOATS) {
      pushInst(
        this.puffModel,
        false,
        puffs[i]!,
        puffs[i + 1]!,
        puffs[i + 2]!,
        puffs[i + 3]!,
        puffs[i + 4]!,
        puffs[i + 5]!,
        puffs[i + 6]!,
        puffs[i + 7]!,
        puffs[i + 8]!,
        puffs[i + 9]!,
        puffs[i + 10]!,
        puffs[i + 11]!,
      )
    }
    const fxc = this.fx.emit(alpha, ai, add, di, MAX_SPRITES_PER_LIST)
    const batches = this.batchOut
    batches.length = 0
    for (const [model, slot] of this.batchMap) {
      if (slot.count > 0) {
        batches.push({ model, data: slot.data, count: slot.count, ghostCount: slot.ghostCount })
      }
    }
    if (beams.v.length > this.beamBuf.length) {
      this.beamBuf = new Float32Array(new ArrayBuffer(beams.v.length * 2 * 4))
    }
    for (let i = 0; i < beams.v.length; i++) this.beamBuf[i] = beams.v[i]!
    this.renderer.setBeams(this.beamBuf, beams.count)
    this.renderer.render({
      frame: f,
      lights: L,
      batches,
      ghosts: [],
      sprites: { alpha, alphaCount: fxc.alpha, add, addCount: fxc.add },
      bloom: opts.bloom ?? 0.9,
      flash: opts.flash ?? 0,
      colourGrade: juice.colourGrade,
    })
  }
}

/** Open cone from apex to a ground ellipse; uv.x runs 0 at the apex to 1 at the base, uv.y is strength. */
function cone(m: Mesh, apex: number[], base: number[], radius: number, color: [number, number, number], strength: number, sides = 20) {
  const ax = base[0]! - apex[0]!, ay = base[1]! - apex[1]!, az = base[2]! - apex[2]!
  const len = Math.hypot(ax, ay, az)
  const d = [ax / len, ay / len, az / len]
  const up = Math.abs(d[1]!) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalizeV([d[1]! * up[2]! - d[2]! * up[1]!, d[2]! * up[0]! - d[0]! * up[2]!, d[0]! * up[1]! - d[1]! * up[0]!])
  const w = [d[1]! * u[2] - d[2]! * u[1], d[2]! * u[0] - d[0]! * u[2], d[0]! * u[1] - d[1]! * u[0]]
  const ring = (a: number) => {
    const c = Math.cos(a), s = Math.sin(a)
    const off = [u[0] * c + w[0]! * s, u[1] * c + w[1]! * s, u[2] * c + w[2]! * s]
    return { p: [base[0]! + off[0]! * radius, base[1]! + off[1]! * radius, base[2]! + off[2]! * radius], n: off }
  }
  for (let i = 0; i < sides; i++) {
    const a = ring((i / sides) * Math.PI * 2)
    const b = ring(((i + 1) / sides) * Math.PI * 2)
    const nm = normalizeV([a.n[0]! + b.n[0]!, a.n[1]! + b.n[1]!, a.n[2]! + b.n[2]!])
    m.vert(apex[0]!, apex[1]!, apex[2]!, nm[0], nm[1], nm[2], color, MAT.lit, 0, strength)
    m.vert(a.p[0]!, a.p[1]!, a.p[2]!, a.n[0]!, a.n[1]!, a.n[2]!, color, MAT.lit, 1, strength)
    m.vert(b.p[0]!, b.p[1]!, b.p[2]!, b.n[0]!, b.n[1]!, b.n[2]!, color, MAT.lit, 1, strength)
  }
}

function lightMatrix(eye: number[], target: number[]) {
  const z = normalizeV([eye[0]! - target[0]!, eye[1]! - target[1]!, eye[2]! - target[2]!])
  const x = normalizeV([z[2], 0, -z[0]])
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  const S = 150
  const near = 50
  const far = 600
  const step = (2 * S) / 2048
  const tx = Math.round(-dot(x, eye) / step) * step
  const ty = Math.round(-dot(y, eye) / step) * step
  // Column-major ortho * lookAt, depth 0..1.
  const view = [x[0], y[0]!, z[0], 0, x[1], y[1]!, z[1], 0, x[2], y[2]!, z[2], 0, tx, ty, -dot(z, eye), 1]
  const proj = [1 / S, 0, 0, 0, 0, 1 / S, 0, 0, 0, 0, -1 / (far - near), 0, 0, 0, -near / (far - near), 1]
  return mul(proj, view)
}

function dot(a: number[], b: number[]) {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
}

function mul(a: number[], b: number[]) {
  const r = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr]! += a[k * 4 + rr]! * b[c * 4 + k]!
  return r
}
