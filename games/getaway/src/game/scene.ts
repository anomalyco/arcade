import { vec4 } from "wgpu-matrix"
import { CELL, GRID, ROAD_HALF, VEHICLE_BY_ID, VEHICLES } from "../../shared/config"
import { rampSurface, type City } from "../../shared/sim/city"
import type { CarView, WorldView } from "../../shared/sim/world"
import { buildCarVariants, buildHeli, buildRotor } from "../render/car-mesh"
import { EmissionState, VehicleEmissions } from "./vehicle-emissions"
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
import { Chassis, wheelRotation, type AxlePoint } from "./chassis"
import { splitChassis } from "../render/chassis-mesh"
import { HEADLIGHT, LIGHT_DEFAULTS, lampMounts, type LightSettings, type LightStyle } from "../render/car-lights"
import { bodyPoint } from "./car-pose"
import { StreetProps } from "./props"

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
  emissions: EmissionState
  chassis: Chassis
  roll: number; pitch: number; speed: number; h: number; sparkAcc: number
  scrapeAcc: number; wheels: { x: number; z: number }[]; height: number; springV: number; ground: number
  backfire: number; crash: number; impactCool: number; braking: boolean
  brakeHold: number; landings: number; landY: number; landV: number; vy: number
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
  readonly lightSettings: LightSettings = { ...LIGHT_DEFAULTS, style: 4 }
  onBackfire?: (car: CarView) => void
  readonly fx = new Fx()
  readonly emissions = new VehicleEmissions()
  readonly trail = this.emissions.trail
  readonly clutter: StreetProps
  private lamps: LampLight[]
  private spills: ShopSpill[]
  private models = new Map<string, number>()
  private variants = new Map<string, number[]>()
  private chassisModels = new Map<string, { bodies: number[]; wheels: (AxlePoint & { model: number })[] }>()
  get lightStyle() { return this.lightSettings.style }
  private meshStyle: LightStyle
  private heliModel: number
  private rotorModel: number
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
    this.emissions.reset()
    this.clutter.reset()
    this.fx.add.length = 0
    this.fx.clearSkids()
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
    lightStyle: LightStyle = 4,
  ) {
    this.lightSettings.style = lightStyle
    this.meshStyle = lightStyle
    const built = buildCityMesh(city)
    this.trail.seedWind(city.seed)
    renderer.setCity(built.mesh)
    this.lamps = built.lamps
    this.spills = built.spills
    for (const v of VEHICLES) {
      const meshes = buildCarVariants(v, lightStyle)
      const ids = meshes.map((m) => renderer.addModel(m))
      const parts = meshes.map(splitChassis)
      const wheelModels = new Map<number, number>()
      const wheels = parts[0]!.wheels.map(p => {
        let model = wheelModels.get(p.side)
        if (model === undefined) { model = renderer.addModel(p.mesh); wheelModels.set(p.side, model) }
        return { x: p.x, y: p.y, z: p.z, model }
      })
      this.chassisModels.set(v.id, { bodies: parts.map(p => renderer.addModel(p.body)), wheels })
      this.variants.set(v.id, ids)
      this.models.set(v.id, ids[0]!)
    }
    this.heliModel = renderer.addModel(buildHeli())
    this.rotorModel = renderer.addModel(buildRotor())
    this.spikeModel = renderer.addModel(buildSpikeStrip())
    this.clutter = new StreetProps(city, renderer, (x, z) => this.groundAt(x, z))
  }

  setLightStyle(style: LightStyle) {
    this.lightSettings.style = style
    this.useCarStyle()
  }

  private useCarStyle() {
    const style = this.lightStyle
    if (style === this.meshStyle) return
    // Lamp geometry changes; keep the existing wheel models, contacts and spring state.
    for (const vehicle of VEHICLES) {
      const variants = this.variants.get(vehicle.id)!
      const bodies = this.chassisModels.get(vehicle.id)!.bodies
      buildCarVariants(vehicle, style).forEach((mesh, i) => {
        this.renderer.replaceModel(variants[i]!, mesh)
        this.renderer.replaceModel(bodies[i]!, splitChassis(mesh).body)
      })
    }
    this.meshStyle = style
  }

  private visOf(c: CarView) {
    let v = this.vis.get(c.id)
    if (v && v.chassis.axles !== this.chassisModels.get(c.vehicle)!.wheels) v.chassis = new Chassis(c, this.chassisModels.get(c.vehicle)!.wheels)
    if (!v) {
      v = { chassis: new Chassis(c, this.chassisModels.get(c.vehicle)!.wheels), emissions: new EmissionState(), roll: 0, pitch: 0, speed: c.speed, h: c.h, sparkAcc: 0, scrapeAcc: 0, wheels: Array.from({length:4},()=>({x:0,z:0})), height: 0, springV: 0, ground: 0, backfire: 0, crash: 0, impactCool: 1, braking: false, brakeHold: 0, landings: c.landings ?? 0, landY: 0, landV: 0, vy: c.vy ?? 0 }
      v.emissions.speed = c.speed
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

  backfire(car: CarView): void {
    this.visOf(car).emissions.pop = 0.11
    this.onBackfire?.(car)
  }

  /** Per-car visual dynamics (body roll, pitch) and particle emission. */
  private animate(view: WorldView, dt: number, focusId: number | null) {
    this.fx.update(dt)
    this.hitStopCool = Math.max(0, this.hitStopCool - dt)
    this.emissions.update(dt)
    this.emissions.city = this.city
    this.emissions.skids = this.fx
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
      v.chassis.update(c, spec, this.city, dt, juice, input)
      // Snapshot speed derivatives alternate between zero and spikes. Lights follow controls, never that derivative.
      const brake = input ? input.brake > 0.1 || input.handbrake || input.throttle < 0 && c.vx * Math.sin(c.h) + c.vz * Math.cos(c.h) > 0.5 : !!c.braking
      v.brakeHold = brake ? 0.1 : Math.max(0, v.brakeHold - dt)
      v.braking = v.brakeHold > 0
      if ((c.landings ?? 0) > v.landings) {
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
      const k = 1 - Math.exp(-dt * 8)
      v.roll += (Math.max(-0.11, Math.min(0.11, yawRate * c.speed * 0.0035)) - v.roll) * k
      v.pitch += (Math.max(-0.06, Math.min(0.06, -accel * 0.004)) - v.pitch) * k
      v.speed = c.speed
      v.h = c.h
      const fx = Math.sin(c.h)
      const fz = Math.cos(c.h)
      const rx = Math.cos(c.h)
      const rz = -Math.sin(c.h)
      const side = spec.width * 0.4
      const wheels = v.wheels
      for (let i = 0; i < 4; i++) {
        const a = i >= 2 ? -1 : 1, s = i % 2 ? 1 : -1
        wheels[i]!.x = c.x + fx * spec.length * 0.32 * a + rx * side * s
        wheels[i]!.z = c.z + fz * spec.length * 0.32 * a + rz * side * s
      }
      const ground = wheels.reduce((sum, p) => sum + this.groundAt(p.x, p.z), 0) / wheels.length
      if (ground !== v.ground && c.speed > 2) v.springV += Math.min(1.6, c.speed * 0.06) * Math.abs(ground - v.ground) / KERB_H
      // Substep the damped second-order suspension; stable even on a slow render frame.
      for (let left = dt; left > 0;) {
        const step = Math.min(left, 1 / 120)
        v.springV += ((ground - v.height) * 180 - v.springV * 15) * step
        v.height += v.springV * step
        left -= step
      }
      v.ground = ground
      const pops = this.emissions.pops
      this.emissions.car(c, spec, v.emissions, input, dt, v.height, true, true)
      if (this.emissions.pops > pops) this.onBackfire?.(c)
      v.backfire = v.emissions.pop
      if (c.impact > 0.35 && c.speed > 4) {
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
        v.crash = 0.06
        const sp = Math.hypot(c.vx, c.vz) || 1
        this.fx.sparks(c.x + (c.vx / sp) * spec.length * 0.45, c.z + (c.vz / sp) * spec.length * 0.45, -c.vx / sp, -c.vz / sp, Math.min(24, Math.floor(c.impact)))
        if (c.id === focusId) {
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
    this.useCarStyle()
    this.time += dt
    this.animate(view, dt, focus?.id ?? null)
    const t = this.time
    const vp = cam.matrices(w / h)
    if (juice.clutter) {
      this.clutter.update(view.cars, dt, focus ?? { x: cam.fx, z: cam.fz }, juice.explosions, (x, y, z, radius) => {
        const clip = vec4.transformMat4([x, y, z, 1], vp)
        const margin = radius * 4
        return clip[3]! > 0 && Math.abs(clip[0]!) < clip[3]! + margin && Math.abs(clip[1]!) < clip[3]! + margin && clip[2]! < clip[3]! + margin
      })
      this.shake = Math.max(this.shake, this.clutter.shake)
    }
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
    put(MOON[0], MOON[1], MOON[2], 0.36)
    const heli = view.heli
    if (heli.active) {
      const ox = heli.x + Math.sin(heli.h) * 1.7
      const oz = heli.z + Math.cos(heli.h) * 1.7
      const dir = normalizeV([heli.sx - ox, -heli.y - 0.4, heli.sz - oz])
      put(ox, heli.y + 0.4, oz, 1)
      const reach = Math.hypot(heli.sx - ox, heli.y, heli.sz - oz)
      put(dir[0], dir[1], dir[2], Math.cos(Math.atan(SPOT_GROUND_RADIUS / reach)) - 0.003)
    } else {
      put(0, 0, 0, 0)
      put(0, -1, 0, 1)
    }
    put(0.035, 0.045, 0.085, 0.0035)
    const clip = vec4.transformMat4([fp[0]!, fp[1]!, fp[2]!, 1], vp)
    put(clip[0]! / clip[3]!, clip[1]! / clip[3]!, clip[2]! / clip[3]!, 0)

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

    if (juice.clutter) this.clutter.draw(
      (model, x, y, z, yaw, roll, pitch, scale) => pushInst(model, false, x, y, z, yaw, roll, pitch, -1, -1, 0, 0, 0, scale),
      sprite, light, { x: cam.fx, z: cam.fz }, juice.physicsDebug,
    )

    for (const c of view.cars) {
      const spec = VEHICLE_BY_ID.get(c.vehicle)!
      const vs = this.variants.get(c.vehicle)!
      const parts = this.chassisModels.get(c.vehicle)!
      const model = juice.visibleWheels ? parts.bodies[c.id % parts.bodies.length]! : vs[c.id % vs.length]!
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
      const ch = v.chassis
      const springBody = juice.suspension || juice.vehicleFeel
      const bodyRoll = (springBody ? 0 : v.roll) + (springBody || juice.wheelContact ? ch.roll.x : 0)
      const bodyPitch = (springBody ? 0 : v.pitch) + (springBody || juice.wheelContact ? ch.pitch.x : 0)
      const braking = v.braking ? 1 : 0
      const altitude = c.y ?? 0
      let shadowGround = v.ground
      for (const ramp of this.city.ramps) shadowGround = Math.max(shadowGround, rampSurface(ramp, c.x, c.z)?.y ?? 0)
      const clearance = Math.max(0, altitude - shadowGround)
      sprite("a", c.x, shadowGround + 0.035, c.z, spec.width * (0.76 + clearance * 0.14), 0, 0, 0, 0.82 / (1 + clearance * 0.24), 9, c.h, spec.length / spec.width * 0.92, clearance)
      // Popped tires: the body sags at those corners (roll toward the flat side, nose or tail down) and shimmies a little.
      const wm = c.wheels ?? 0
      let sagRoll = 0
      let sagPitch = 0
      let sagY = (juice.wheelContact ? ch.lift.x : v.height + (juice.suspension ? ch.lift.x : 0)) + altitude + (juice.suspension ? 0 : v.landY)
      if (wm) {
        const left = (wm & 1) + ((wm >> 2) & 1)
        const right = ((wm >> 1) & 1) + ((wm >> 3) & 1)
        const front = (wm & 1) + ((wm >> 1) & 1)
        const rear = ((wm >> 2) & 1) + ((wm >> 3) & 1)
        sagRoll = -0.06 * (right - left) + 0.012 * Math.sin(t * (6 + c.speed * 0.8) + c.id) * Math.min(1, c.speed / 8)
        sagPitch = 0.025 * (front - rear)
        sagY -= 0.045 * (left + right)
      }
      const jumpPitch = juice.wheelContact && !c.airborne ? 0 : Math.max(-0.2, Math.min(0.2, -(c.vy ?? 0) / Math.max(15, c.speed)))
      const pose = { height: sagY, roll: bodyRoll + sagRoll, pitch: bodyPitch + sagPitch + jumpPitch }
      if (juice.visibleWheels) for (let i = 0; i < parts.wheels.length; i++) {
        const p = parts.wheels[i], wheel = ch.contacts[i]
        const flatBit = (p.z > 0 ? 0 : 2) + (p.x > 0 ? 1 : 0)
        let x = wheel.x, y = wheel.y - (wm & (1 << flatBit) ? 0.08 : 0), z = wheel.z
        const roll = c.airborne ? bodyRoll + sagRoll : spec.id === "bike" && juice.vehicleFeel ? bodyRoll : 0
        const pitch = c.airborne ? bodyPitch + sagPitch + jumpPitch : 0
        if (c.airborne) {
          ;[x, y, z] = bodyPoint(c, pose, [p.x, p.y, p.z])
        }
        const silhouette = !c.engineOff || c.id === focus?.id
        wheelRotation(wheel, c.h, roll, pitch, p.z > 0 ? ch.steer : 0, wheel.spin)
        pushInst(p.model, silhouette, x, y, z, wheel.yaw, wheel.roll, wheel.pitch, -1, -1, silhouette ? tint[0] : 0, silhouette ? tint[1] : 0, silhouette ? tint[2] : 0, 1)
      }
      if (c.engineOff) {
        // Engine off: exactly like a parked car (same instance params, no lights, glows or silhouette), so it blends in.
        const isFocus = c.id === focus?.id
        pushInst(model, isFocus, c.x, sagY, c.z, c.h, sagRoll + (springBody || juice.wheelContact ? bodyRoll : 0), sagPitch + (springBody || juice.wheelContact ? bodyPitch : 0) + jumpPitch, -1, -1, isFocus ? tint[0] : 0, isFocus ? tint[1] : 0, isFocus ? tint[2] : 0, 1)
        continue
      }
      pushInst(model, true, c.x, pose.height, c.z, c.h, pose.roll, pose.pitch, siren, braking, tint[0], tint[1], tint[2], 1)

      const half = spec.length / 2
      if (v.crash > 0) light(...bodyPoint(c, pose, [0, 0.7, half]), 7, 1, 0.35, 0.06, 5 * v.crash / 0.06)
      if (this.emissions.visible && v.backfire > 0) light(...bodyPoint(c, pose, [0, 0.65, -(half + 0.3)]), 2, 1, 0.3, 0.04, v.backfire / 0.11)
      if (this.lightStyle === 0) {
        // Original reference: one spot per car, plus lens glows and a soft pool on the road ahead.
        const head = bodyPoint(c, pose, [0, 1.3, half + 0.5])
        const aim = bodyPoint(c, pose, [0, 1, half + 1.45])
        const dir = normalizeV([aim[0] - head[0], aim[1] - head[1], aim[2] - head[2]])
        light(...head, 36, 1, 0.92, 0.78, 3.2, ...dir, 0.8)
        const hw = spec.width / 2 - 0.25
        for (const s of spec.id === "bike" ? [0] : [-1, 1]) {
          sprite("d", ...bodyPoint(c, pose, [hw * s, 0.75, half + 0.1]), 0.55, 1, 0.95, 0.85, 1.4, 0)
          sprite("d", ...bodyPoint(c, pose, [hw * s, 0.75, -(half + 0.05)]), braking ? 0.9 : 0.55, 1, 0.12, 0.08, braking ? 2.2 : 1.1, 0)
        }
        // Ground decals project from the moving lamp; they are not rigid attachments floating above the road.
        if (dir[1] < -0.03) {
          const reach = Math.min(18, Math.max(0, (head[1] - v.ground) / -dir[1]))
          const x = head[0] + dir[0] * reach, z = head[2] + dir[2] * reach
          sprite("d", x, this.groundAt(x, z) + 0.06, z, 2.6 + clearance * 0.65, 1, 0.9, 0.72, 0.1 / (1 + clearance * 0.12), 3, Math.atan2(dir[0], dir[2]), 2.2)
        }
        const tail = bodyPoint(c, pose, [0, 0.9, -(half + 0.6)])
        light(...tail, 7, 1, 0.1, 0.06, braking ? 3 : 1.2)
      } else {
        const style = this.lightStyle
        const tuned = style === 4
        const settings = this.lightSettings
        const mount = lampMounts(spec)
        const cool = style === 2
        const green = tuned ? HEADLIGHT[1] : cool ? 0.94 : 0.84, blue = tuned ? HEADLIGHT[2] : cool ? 1 : 0.6
        const front = bodyPoint(c, pose, [0, mount.frontY, half + 0.08])
        const drop = tuned ? mount.frontY / settings.poolAhead : 0.28
        const aim = bodyPoint(c, pose, [0, mount.frontY - drop, half + 1.08])
        const dir = normalizeV([aim[0] - front[0], aim[1] - front[1], aim[2] - front[2]])
        const beamYaw = Math.atan2(dir[0], dir[2])
        const rearIntensity = tuned ? (braking ? settings.brakeIntensity : settings.tailGlow) : (braking ? 1.9 : 0.75)
        light(...front, tuned ? settings.beamLength + settings.poolSize * 2 : style === 3 ? 22 : 18, 1, green, blue, tuned ? settings.poolIntensity * 21 : 2.1, ...dir, 0.82)
        light(...bodyPoint(c, pose, [0, mount.rearY, -half - 0.28]), 4, 1, 0.055, 0.025, tuned ? rearIntensity * 0.9 : braking ? 1.8 : 0.65)
        // Low, local fill catches the bevels around the lamp, rather than washing the whole body red.
        light(...bodyPoint(c, pose, [0, mount.frontY + 0.5, half + 0.16]), 1.8, 1, green, blue, 0.65)
        light(...bodyPoint(c, pose, [0, mount.rearY + 0.4, -half - 0.14]), 1.6, 1, 0.08, 0.035, tuned ? rearIntensity * 0.45 : braking ? 0.9 : 0.35)
        for (const s of spec.id === "bike" ? [0] : [-1, 1]) {
          const head = bodyPoint(c, pose, [mount.frontX * s, mount.frontY + 0.02, half + 0.065])
          const tail = bodyPoint(c, pose, [mount.rearX * s, mount.rearY + 0.02, -half - 0.075])
          sprite("d", ...head, tuned ? settings.glowSize : 0.25, 1, green, blue, tuned ? settings.glowIntensity : 0.8, 15, c.h, 0.3)
          sprite("d", ...tail, 0.23, 1, 0.055, 0.02, rearIntensity, 15, c.h, 0.3)
          const reach = tuned ? settings.beamLength : style === 3 ? 12 : cool ? 10 : 8
          const spread = tuned ? settings.beamWidth + settings.beamSpread : cool ? 2.4 : 1.9
          // Kind 14 is an origin-anchored trapezoid, not a centred ellipse six metres away.
          // Fade its ground footprint in flight; real spots and mounted lenses still follow the car.
          const grounded = Math.max(0, 1 - altitude / 1.2)
          sprite("d", head[0], 0.035 + this.groundAt(head[0], head[2]), head[2], spread, 1, green, blue, (tuned ? settings.beamIntensity : style === 3 ? 0.15 : 0.11) * grounded, tuned ? 18 : 14, beamYaw, reach / spread, tuned ? settings.beamWidth / spread : 0)
          if (tuned) {
            // Project the posed lamp's aim onto the road. Brake dive brings the pool closer;
            // the broad, zero-slope edge overlaps the beam's long fade instead of capping it.
            {
              // Body pitch only nudges the pool: squat under throttle flattens the beam, and projecting it
              // exactly would fling the pool tens of metres ahead.
              const flat = Math.hypot(dir[0], dir[2]) || 1
              const exact = dir[1] < -0.01 ? ((head[1] - this.groundAt(head[0], head[2])) / -dir[1]) * flat : Infinity
              const distance = Math.min(settings.poolAhead * 1.15, Math.max(settings.poolAhead * 0.85, exact))
              const x = head[0] + (dir[0] / flat) * distance, z = head[2] + (dir[2] / flat) * distance
              sprite("d", x, this.groundAt(x, z) + 0.045, z, settings.poolSize, 1, green, blue, settings.poolIntensity * grounded, 19, beamYaw, 1.65)
            }
            sprite("d", ...head, settings.glowSize, 1, green, blue, settings.glowIntensity * 0.24, 0)
          }
          if (style === 3 || tuned) {
            const toCam = Math.hypot(cam.eye[0] - head[0], cam.eye[2] - head[2]) || 1
            const facing = Math.max(0.15, ((cam.eye[0] - head[0]) * dir[0] + (cam.eye[2] - head[2]) * dir[2]) / toCam)
            sprite("d", ...head, tuned ? 0.65 : 0.85, 1, green, blue, (tuned ? settings.flareStrength : 0.18) * facing, 16, 0, 0.045)
            sprite("d", ...tail, braking ? 0.9 : 0.5, 1, 0.07, 0.03, tuned ? rearIntensity * 0.08 : braking ? 0.3 : 0.13, 16, 0, 0.05)
            if (style === 3 && braking && c.speed > 4) {
              const length = Math.min(2.5, c.speed * 0.07)
              const yaw = Math.atan2(-c.vx, -c.vz)
              sprite("d", ...tail, 0.08, 1, 0.04, 0.015, 0.32, 17, yaw, length / 0.08)
            }
          }
        }
        if (style === 2 && spec.id !== "bike") sprite("d", ...bodyPoint(c, pose, [0, mount.rearY + 0.03, -half - 0.08]), spec.width * 0.42, 1, 0.045, 0.015, braking ? 1.25 : 0.55, 15, c.h, 0.045)
      }
      if (siren >= 0) {
        const red = sirenOn(siren, true)
        const blue = sirenOn(siren, false)
        const y = spec.id === "swat" ? 2.9 : 1.9
        // Siren light sits low and to the sides so it paints the road and walls, not the car's own livery.
        light(...bodyPoint(c, pose, [-2.2, y - 1.2, 0]), 14, 1, 0.08, 0.08, 3 * red)
        light(...bodyPoint(c, pose, [2.2, y - 1.2, 0]), 14, 0.15, 0.3, 1, 3.6 * blue)
        if (red > 0) sprite("d", ...bodyPoint(c, pose, [-0.45, y, 0]), 0.9, 1, 0.1, 0.1, 1.5 * red, 0)
        if (blue > 0) sprite("d", ...bodyPoint(c, pose, [0.45, y, 0]), 0.9, 0.2, 0.35, 1, 1.7 * blue, 0)
        // Colored wash on the road around the cruiser.
        const roof = bodyPoint(c, pose, [0, y, 0])
        sprite("d", roof[0], this.groundAt(roof[0], roof[2]) + 0.08, roof[2], 7 + clearance * 0.8, red > blue ? 1 : 0.2, 0.15, red > blue ? 0.15 : 1, 0.12 * Math.max(red, blue) / (1 + clearance * 0.15), 3)
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
      cone(beams, [sx, heli.y + 0.4, sz], [heli.sx, 0, heli.sz], SPOT_GROUND_RADIUS, [0.75, 0.85, 1], 0.32)
      sprite("d", heli.sx, 0.1, heli.sz, SPOT_GROUND_RADIUS * 1.3, 0.85, 0.92, 1, 0.1, 3)
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

    for (const s of this.spills) {
      if ((s.x - cam.fx) ** 2 + (s.z - cam.fz) ** 2 > 125 ** 2) continue
      sprite("d", s.x, KERB_H + 0.014, s.z, s.width + 0.4, 1, 0.39, 0.085, 0.14, 8, s.yaw, 2.5 / (s.width + 0.4))
    }
    {
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
      if (d < 120 * 120) light(l.x, l.y, l.z, l.small ? 6 : 10.5, 1, 0.48, 0.15, l.small ? 5 : 18)
    }
    f[32 + 8 + 2] = n
    this.lightCount = n

    const fxc = this.fx.emit(alpha, ai, add, di, MAX_SPRITES_PER_LIST, this.emissions.visible)
    this.emissions.emit(alpha, fxc.alpha, add, fxc.add, MAX_SPRITES_PER_LIST, this.emissions.visible)
    fxc.alpha = this.emissions.alphaCount; fxc.add = this.emissions.addCount
    const batches = this.batchOut
    batches.length = 0
    for (const [model, slot] of this.batchMap) {
      if (slot.count > 0) {
        batches.push({ model, data: slot.data, count: slot.count, ghostCount: slot.ghostCount, noShadow: this.clutter.shadowless.has(model) })
      }
    }
    if (beams.v.length > this.beamBuf.length) {
      this.beamBuf = new Float32Array(new ArrayBuffer(beams.v.length * 2 * 4))
    }
    for (let i = 0; i < beams.v.length; i++) this.beamBuf[i] = beams.v[i]!
    this.renderer.setBeams(this.beamBuf, beams.count)
    this.trail.prepare()
    this.renderer.setSmoke(this.trail, this.emissions.visible)
    this.renderer.render({
      frame: f,
      lights: L,
      batches,
      sprites: { alpha, alphaCount: fxc.alpha, add, addCount: fxc.add },
      bloom: opts.bloom ?? 0.9,
      flash: opts.flash ?? 0,
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
    // The perpendicular rim straddles the road when the beam tilts. Its raised half
    // ended visibly across the pool. Continue each cone ray below the road instead;
    // the shader's world-height fade now reaches zero before any triangle ends.
    const rx = ax + off[0]! * radius, ry = ay + off[1]! * radius, rz = az + off[2]! * radius
    const t = (base[1]! - 0.5 - apex[1]!) / Math.min(-0.01, ry)
    return { p: [apex[0]! + rx * t, base[1]! - 0.5, apex[2]! + rz * t], n: off }
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
