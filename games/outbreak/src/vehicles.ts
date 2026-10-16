import { LIGHT_FLOATS, MAX_LIGHTS } from "@arcade/kit/limits"
import { INST_FLOATS, SPRITE_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { angleDiff } from "@arcade/kit/sim/geom"
import { instanceRotation, type BodyPose } from "@arcade/kit/vehicle/body-pose"
import { Chassis, wheelRotation } from "@arcade/kit/vehicle/chassis"
import { DrivingFx } from "@arcade/kit/vehicle/driving-fx"
import { EmissionState, TYRE_SURFACE, VehicleEmissions, type WheelContact } from "@arcade/kit/vehicle/emissions"
import { kinematicContacts } from "@arcade/kit/vehicle/slip"
import { Fx } from "@arcade/kit/vehicle/fx"
import { drawLamps, LIGHT_DEFAULTS, type LightSettings } from "@arcade/kit/vehicle/lights"
import type { Controls, SpriteSink, VehicleSpec as KitVehicleSpec, VehicleView as KitVehicleView } from "@arcade/kit/vehicle/types"
import { inBuildingFootprint, SIZE, type Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"
import {
  DEFAULT_VEHICLE_TUNING,
  forwardSpeed,
  lateralSpeed,
  localToWorld,
  VEHICLES,
  type OutbreakVehicle,
  type OutbreakVehicleSpec,
  type VehicleKind,
  type VehicleTuning,
} from "../shared/vehicles"
import { VehicleHud } from "./hud/vehicle-hud"
import { createVehicleModels, LAMPS, WHEELS } from "./vehicle-mesh"

type Rgb3 = [number, number, number]

const fold = (v: number) => (v >= 0 && v <= SIZE ? v : ((v % SIZE) + SIZE) % SIZE)

/**
 * What a tyre is on, mirroring `supportHeight` and the ground shader: the 38–50 m road and sidewalk bands on both
 * axes, driveways and front walks are paved; lawns and verges are dirt. Paved ground is wet above half wetness.
 */
export function tyreSurfaceAt(town: Town, x: number, z: number, wetness = 0): number {
  const lx = town.activeChunkKeys ? fold(x) : x
  const lz = town.activeChunkKeys ? fold(z) : z
  let paved = (lx >= 38 && lx <= 50) || (lz >= 38 && lz <= 50)
  if (!paved) {
    for (const b of town.buildings) {
      const [a, c, , e] = b.rect
      if (x < a - 3.5 || x > b.rect[2] + 0.5 || z < c - 0.5 || z > e + 8) continue
      if (inBuildingFootprint(b, x, z) || (x >= a - 3 && x <= a - 0.35 && z >= c) || (x >= a + 4.4 && x <= a + 7 && z >= e)) {
        paved = true
        break
      }
    }
  }
  return paved ? (wetness > 0.5 ? TYRE_SURFACE.wet : TYRE_SURFACE.road) : TYRE_SURFACE.dirt
}

export function toKitVehicleSpec(kind: VehicleKind): KitVehicleSpec {
  const s = VEHICLES[kind]
  const l = LAMPS[kind]
  const wheels = WHEELS[kind].map((w) => ({ x: -w.s, z: w.f }))
  return {
    id: kind,
    width: s.width,
    length: s.length,
    mass: s.mass / 1000,
    accel: s.accel,
    grip: s.grip,
    boost: 0,
    drivetrain: kind === "pickup" ? "awd" : "rwd",
    popSpeed: s.maxSpeed * 0.55,
    wheels,
    lamps: {
      frontX: Math.abs(l.head[0]![1]),
      frontY: l.h,
      frontZ: l.head[0]![0] - 0.06,
      rearX: Math.abs(l.tail[0]![1]),
      rearY: l.h,
      rearZ: l.tail[0]![0] + 0.06,
    },
  }
}

export { instanceRotation }

export type VehicleDraw = {
  id: number
  kind: VehicleKind
  spec: OutbreakVehicleSpec
  kitSpec: KitVehicleSpec
  view: KitVehicleView
  input: Controls
  emissions: EmissionState
  contacts: WheelContact[]
  chassis: Chassis<Town>
  pose: BodyPose
  x: number
  y: number
  h: number
  vx: number
  vy: number
  w: number
  flash: number
  lastBangCount: number
  lastCrashAt: number
}

export type VehicleLightResult = {
  lightCount: number
  shadowLightCount: number
  alphaCount: number
  addCount: number
}

/**
 * Outbreak client vehicle presentation & HUD:
 * - Suspension & wheel contact over Outbreak's terrain (`Chassis` + `supportHeight`)
 * - Headlights & taillights via `@arcade/kit/vehicle/lights` (`drawLamps`) casting dynamic lights in Noir
 * - Skid marks, tyre smoke (`SmokeRenderer`), exhaust pops & crash sparks (`VehicleEmissions` + `Fx`)
 * - Vehicle HUD strip with `@arcade/kit/client/key-cap` prompts
 */
export class OutbreakVehicleRenderer {
  readonly draws = new Map<number, VehicleDraw>()
  readonly emissions = new VehicleEmissions<Town>((town, x, z) => (town ? 1 : 1))
  readonly fx = new Fx()
  /** Tyre marks, smoke and slip rules (Lab › Driving FX). Marks persist for the session, ring-buffered. */
  readonly drivingFx = new DrivingFx()
  /** Ground wetness 0–1 from the weather, for wet-road marks. */
  wetness = 0
  private readonly models: Record<
    VehicleKind,
    { body: number; wreck: number; wheel: number; lens: number; tail: number; bar: number | null }
  >
  private readonly partBuffers = new Map<number, Float32Array<ArrayBuffer>>()
  private readonly partCounts = new Map<number, number>()
  private readonly kitAlpha = new Float32Array(2048 * 12)
  private readonly kitAdd = new Float32Array(2048 * 12)
  private readonly rotScratch = { yaw: 0, roll: 0, pitch: 0 }
  private hud: VehicleHud | null = null
  onPop?: (v: OutbreakVehicle) => void
  onCrash?: (v: OutbreakVehicle, impact: number) => void
  onBang?: (v: OutbreakVehicle) => void

  constructor(
    private readonly renderer: Pick<Renderer, "addModel"> & Partial<Pick<Renderer, "setSmoke">>,
    parent: HTMLElement = document.body,
  ) {
    const raw = createVehicleModels()
    const out = {} as typeof this.models
    const reg = (m: Parameters<Renderer["addModel"]>[0], cap = 32) => {
      const id = renderer.addModel(m)
      this.partBuffers.set(id, new Float32Array(cap * INST_FLOATS))
      this.partCounts.set(id, 0)
      return id
    }
    for (const kind of Object.keys(raw) as VehicleKind[]) {
      const k = raw[kind]
      out[kind] = {
        body: reg(k.body, 24),
        wreck: reg(k.wreck, 24),
        wheel: reg(k.wheel, 96),
        lens: reg(k.lens, 24),
        tail: reg(k.tail, 24),
        bar: k.bar ? reg(k.bar, 16) : null,
      }
    }
    this.models = out
    this.initHud(parent)
  }

  private initHud(parent: HTMLElement): void {
    if (typeof document === "undefined") return
    let el = document.querySelector<HTMLElement>("#vehicle-hud")
    if (!el) {
      el = document.createElement("div")
      el.id = "vehicle-hud"
      el.hidden = true
      const hudRoot = document.querySelector<HTMLElement>("#hud") ?? parent
      hudRoot. prepend(el)
    }
    this.hud = new VehicleHud(el)
  }

  reset(): void {
    this.draws.clear()
    this.fx.clearSkids()
    this.drivingFx.marks.clear()
    this.fx.add.length = 0
    this.emissions.reset()
    this.hud?.update(null)
  }

  private pushPart(
    model: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    tint: Rgb3,
    pitch: number,
    roll: number,
    flash: number,
    alpha = 1,
  ): void {
    const buf = this.partBuffers.get(model)
    if (!buf) return
    const c = this.partCounts.get(model) ?? 0
    const cap = Math.floor(buf.length / INST_FLOATS)
    if (c >= cap) return
    this.partCounts.set(model, c + 1)
    const o = c * INST_FLOATS
    buf[o] = x
    buf[o + 1] = y
    buf[o + 2] = z
    buf[o + 3] = yaw
    buf[o + 4] = tint[0]
    buf[o + 5] = tint[1]
    buf[o + 6] = tint[2]
    buf[o + 7] = 1
    buf[o + 8] = pitch
    buf[o + 9] = roll
    buf[o + 10] = alpha
    buf[o + 11] = flash
  }

  private ensureDraw(v: OutbreakVehicle): VehicleDraw {
    let d = this.draws.get(v.id)
    if (!d || d.kind !== v.kind) {
      const kitSpec = toKitVehicleSpec(v.kind)
      const view: KitVehicleView = {
        id: v.id,
        vehicle: v.kind,
        x: v.x,
        z: v.y,
        h: Math.PI / 2 - v.h,
        vx: v.vx,
        vz: v.vy,
        speed: 0,
        drift: 0,
        impact: 0,
        stun: 0,
        boost: 0,
      }
      const chassis = new Chassis<Town>(
        view,
        WHEELS[v.kind].map((w) => ({ x: -w.s, y: w.r, z: w.f })),
        (t, x, z) => supportHeight(t, x, z),
      )
      d = {
        id: v.id,
        kind: v.kind,
        spec: v.spec,
        kitSpec,
        view,
        input: { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false },
        emissions: new EmissionState(),
        contacts: [],
        chassis,
        pose: { height: 0, roll: 0, pitch: 0 },
        x: v.x,
        y: v.y,
        h: v.h,
        vx: v.vx,
        vy: v.vy,
        w: v.w,
        flash: 0,
        lastBangCount: v.bangCount,
        lastCrashAt: v.lastCrashAt,
      }
      this.draws.set(v.id, d)
    }
    return d
  }

  /**
   * Updates all active vehicles, collects instanced 3D batches, packs headlight & taillight dynamic lights,
   * and emits skid marks, tyre smoke & crash sparks.
   */
  collect(
    dt: number,
    time: number,
    town: Town,
    vehicles: readonly OutbreakVehicle[],
    localVehicleId: number | null | undefined,
    viewRect: readonly [number, number, number, number],
    eye: ArrayLike<number>,
    lights: Float32Array,
    lightCount: number,
    shadowLightCount: number,
    lightOccluders: number,
    alphaSprites: Float32Array,
    alphaCount: number,
    addSprites: Float32Array,
    addCount: number,
    tuning: VehicleTuning = DEFAULT_VEHICLE_TUNING,
  ): { batches: Batch[]; lights: VehicleLightResult } {
    for (const k of this.partCounts.keys()) this.partCounts.set(k, 0)
    const driving = this.drivingFx
    driving.apply()
    this.fx.update(dt)
    driving.marks.update(dt)
    this.emissions.city = town
    this.emissions.skids = tuning.vehicleSmoke && driving.settings.skidMarks ? driving.marks : null
    this.emissions.update(dt)
    const ground = (gx: number, gz: number) => supportHeight(town, gx, gz)
    const surface = (gx: number, gz: number) => tyreSurfaceAt(town, gx, gz, this.wetness)

    const liveIds = new Set<number>()
    const [vx0, vy0, vx1, vy1] = viewRect
    const suspensionOn = Boolean(tuning.vehicleSuspension)
    const smokeOn = Boolean(tuning.vehicleSmoke)
    const tyreSmokeOn = smokeOn && driving.settings.tyreSmoke

    const lightSettings: LightSettings = {
      ...LIGHT_DEFAULTS,
      style: 4,
      beamLength: tuning.headlightRange * 0.6,
      poolAhead: Math.min(12, tuning.headlightRange * 0.32),
      poolIntensity: 0.045 * tuning.headlightPower,
      beamIntensity: 0.13 * tuning.headlightPower,
    }

    const pushSpriteRaw = (
      isAdd: boolean,
      x: number,
      y: number,
      z: number,
      size: number,
      r: number,
      g: number,
      b: number,
      a: number,
      kind: number,
      rot = 0,
      stretch = 1,
      extra = 0,
    ) => {
      const arr = isAdd ? addSprites : alphaSprites
      const max = Math.floor(arr.length / SPRITE_FLOATS)
      const idx = isAdd ? addCount : alphaCount
      if (idx >= max || a <= 0.002) return
      if (isAdd) addCount++
      else alphaCount++
      const o = idx * SPRITE_FLOATS
      arr[o] = x
      arr[o + 1] = y
      arr[o + 2] = z
      arr[o + 3] = size
      arr[o + 4] = r
      arr[o + 5] = g
      arr[o + 6] = b
      arr[o + 7] = a
      arr[o + 8] = kind
      arr[o + 9] = rot
      arr[o + 10] = stretch
      arr[o + 11] = extra
    }

    const sharedSprite: SpriteSink = (list, x, y, z, size, r, g, b, a, kind, rot = 0, stretch = 1, extra = 0) => {
      pushSpriteRaw(list === "d", x, y, z, size, r, g, b, a, kind + 32, rot, stretch, extra)
    }

    const deferredUnshadowedLights: number[][] = []

    for (const v of vehicles) {
      liveIds.add(v.id)
      const d = this.ensureDraw(v)
      const isLocal = v.id === localVehicleId
      const snap = Math.hypot(v.x - d.x, v.y - d.y) > 4 || isLocal
      const kSmooth = snap ? 1 : 1 - Math.exp(-dt * 18)
      d.x += (v.x - d.x) * kSmooth
      d.y += (v.y - d.y) * kSmooth
      d.h += angleDiff(v.h, d.h) * kSmooth
      d.vx = v.vx
      d.vy = v.vy
      d.w = v.w

      if (v.bangCount > d.lastBangCount) {
        d.lastBangCount = v.bangCount
        d.flash = 0.85
        d.view.impact = Math.max(d.view.impact, 6.5)
        this.onBang?.(v)
      }
      if (v.lastCrashAt > d.lastCrashAt + 1e-3) {
        d.lastCrashAt = v.lastCrashAt
        d.flash = 1.0
        d.view.impact = Math.max(d.view.impact, v.lastCrashImpact)
        const front = localToWorld(d, v.spec.length * 0.45, 0)
        this.fx.sparks(front.x, front.y, -Math.cos(d.h), -Math.sin(d.h), Math.min(14, v.lastCrashImpact), 0.5)
        this.onCrash?.(v, v.lastCrashImpact)
      }
      d.flash = Math.max(0, d.flash - dt * 5.5)

      const vf = forwardSpeed(d)
      const groundY = supportHeight(town, d.x, d.y)
      const kv = d.view
      kv.x = d.x
      kv.z = d.y
      kv.y = groundY
      kv.h = Math.PI / 2 - d.h
      kv.vx = d.vx
      kv.vz = d.vy
      kv.speed = Math.hypot(d.vx, d.vy)
      kv.drift = Math.abs(lateralSpeed(d))
      kv.engineOff = !v.engineOn || v.wreck
      kv.braking = !kv.engineOff && ((v.drive.throttle < 0 && vf > 0.5) || v.drive.handbrake)

      d.input.throttle = kv.engineOff ? 0 : v.drive.throttle < 0 && vf > 0.5 ? 0 : Math.abs(v.drive.throttle)
      d.input.brake = kv.braking ? 1 : 0
      d.input.steer = -v.drive.steer
      d.input.handbrake = v.drive.handbrake

      d.chassis.update(
        kv,
        d.kitSpec,
        town,
        dt,
        { suspension: suspensionOn && !v.wreck, vehicleFeel: suspensionOn && !v.wreck, wheelContact: true, visibleWheels: true },
        d.input,
      )
      const idleVib = v.engineOn && !v.wreck ? Math.sin(time * 42 + v.id) * 0.0035 : 0
      d.pose.height = groundY + d.chassis.lift.x + idleVib
      d.pose.roll = d.chassis.roll.x
      d.pose.pitch = d.chassis.pitch.x
      kv.impact = 0

      // Per-wheel slip from the replicated body motion (every client sees the same marks), then backfire pops.
      // The view's y already holds the ground height, so the exhaust gets no extra height.
      kinematicContacts(d.contacts, kv, d.kitSpec, -d.w, null, d.input, ground, surface, driving.slip)
      this.emissions.contacts(kv, d.emissions, d.contacts, dt, smokeOn)
      const popsBefore = this.emissions.pops
      this.emissions.exhaust(kv, d.kitSpec, d.emissions, d.input, dt, 0, true)
      if (this.emissions.pops > popsBefore) this.onPop?.(v)

      // Frustum cull distant vehicles for mesh & lamp submission
      const inView = d.x >= vx0 - 4.5 && d.x <= vx1 + 4.5 && d.y >= vy0 - 4.5 && d.y <= vy1 + 4.5
      if (!inView) continue

      const M = this.models[d.kind]
      instanceRotation(this.rotScratch, kv.h, d.pose.roll ?? 0, d.pose.pitch ?? 0)
      const { yaw, pitch, roll } = this.rotScratch
      const hy = d.pose.height ?? groundY

      this.pushPart(v.wreck ? M.wreck : M.body, kv.x, hy, kv.z, yaw, [1, 1, 1], pitch, roll, v.wreck ? 0 : d.flash * 0.14)

      // 4 wheels with independent spin & steering
      for (let i = 0; i < d.chassis.contacts.length; i++) {
        const w = d.chassis.contacts[i]!
        const p = d.chassis.axles[i]!
        wheelRotation(w, kv.h, 0, 0, p.z > 0 ? d.chassis.steer : 0, w.spin)
        instanceRotation(this.rotScratch, w.yaw, w.roll, w.pitch)
        this.pushPart(M.wheel, w.x, w.y, w.z, this.rotScratch.yaw, [1, 1, 1], this.rotScratch.pitch, this.rotScratch.roll, 0)
      }

      // Soft contact shadow under chassis
      pushSpriteRaw(false, d.x, groundY + 0.012, d.y, d.spec.length * 0.56, 0, 0, 0, v.wreck ? 0.72 : 0.52, 4, d.h, d.spec.width / d.spec.length)

      // Headlights & taillights
      const lightsActive = !v.wreck && v.hasBattery && v.headlights && (v.engineOn || v.seats.some(Boolean))
      const braking = v.engineOn && ((v.drive.throttle < 0 && vf > 0.5) || v.drive.handbrake)
      const reversing = v.engineOn && vf < -0.5

      this.pushPart(M.lens, kv.x, hy, kv.z, yaw, lightsActive ? [4.2, 3.8, 3.0] : [0.06, 0.06, 0.06], pitch, roll, 0)
      this.pushPart(
        M.tail,
        kv.x,
        hy,
        kv.z,
        yaw,
        !lightsActive ? [0.08, 0.02, 0.02] : braking ? [5.0, 0.22, 0.12] : reversing ? [3.2, 3.2, 3.2] : [1.5, 0.06, 0.04],
        pitch,
        roll,
        0,
      )

      if (M.bar !== null) {
        const barOn = !v.wreck && v.engineOn
        const pulse = barOn ? 0.55 + 0.45 * Math.abs(Math.sin(time * 7.5 + v.id)) : 0.06
        const isRed = Math.sin(time * 7.5 + v.id) >= 0
        const barCol: Rgb3 = barOn ? (isRed ? [2.2 * pulse, 0.2, 0.15] : [0.2, 0.55, 2.4 * pulse]) : [0.08, 0.08, 0.12]
        this.pushPart(M.bar, kv.x, hy, kv.z, yaw, barCol, pitch, roll, 0)
      }

      if (lightsActive) {
        let emittedPrimaryCone = false
        drawLamps(
          kv,
          d.pose,
          d.kitSpec,
          lightSettings,
          Number(braking),
          groundY,
          0,
          eye,
          (gx, gz) => supportHeight(town, gx, gz),
          sharedSprite,
          (lx, lh, lz, radius, red, green, blue, power, dx = 0, _dy = 0, dz = 0, cone = -2) => {
            const len = Math.hypot(dx, dz) || 1
            const hasCone = cone > -1
            const effRadius = hasCone ? tuning.headlightRange : radius
            const effPower = hasCone ? power * tuning.headlightPower : power
            // Cast polar shadows for the primary headlight cone if shadow light slots are available
            const castShadow = hasCone && !emittedPrimaryCone && shadowLightCount < MAX_LIGHTS - 4
            const packed = [
              lx,
              lh,
              lz,
              effRadius,
              red,
              green,
              blue,
              effPower,
              hasCone ? dx / len : 0,
              hasCone ? dz / len : 0,
              hasCone ? cone : 0,
              hasCone ? 1 : 0,
              0,
              castShadow ? lightOccluders : 0,
              0.12,
              -1,
            ]
            if (castShadow) {
              emittedPrimaryCone = true
              // Unshadowed lamps already follow the shadowed slots: move the one in this slot to the end, don't drop it.
              if (shadowLightCount < lightCount && lightCount < MAX_LIGHTS) {
                lights.copyWithin(lightCount * LIGHT_FLOATS, shadowLightCount * LIGHT_FLOATS, (shadowLightCount + 1) * LIGHT_FLOATS)
                lightCount++
              }
              lights.set(packed, shadowLightCount * LIGHT_FLOATS)
              shadowLightCount++
              lightCount = Math.max(lightCount, shadowLightCount)
            } else {
              deferredUnshadowedLights.push(packed)
            }
          },
        )
      }
    }

    for (const key of [...this.draws.keys()]) {
      if (!liveIds.has(key)) this.draws.delete(key)
    }

    for (const packed of deferredUnshadowedLights) {
      if (lightCount >= MAX_LIGHTS) break
      lights.set(packed, lightCount++ * LIGHT_FLOATS)
    }

    // Emit skids, wisps and flames from Fx and VehicleEmissions into sprite buffers
    const fxCounts = this.fx.emit(this.kitAlpha, 0, this.kitAdd, 0, 2048, smokeOn)
    this.emissions.emit(this.kitAlpha, fxCounts.alpha, this.kitAdd, fxCounts.add, 2048, true)
    for (const [data, count, list] of [
      [this.kitAlpha, this.emissions.alphaCount, "a"],
      [this.kitAdd, this.emissions.addCount, "d"],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const o = i * 12
        sharedSprite(
          list,
          data[o]!,
          data[o + 1]!,
          data[o + 2]!,
          data[o + 3]!,
          data[o + 4]!,
          data[o + 5]!,
          data[o + 6]!,
          data[o + 7]!,
          data[o + 8]!,
          data[o + 9]!,
          data[o + 10]!,
          data[o + 11]!,
        )
      }
    }
    this.emissions.trail.prepare()
    this.renderer.setSmoke?.(this.emissions.trail, tyreSmokeOn)

    const batches: Batch[] = []
    for (const [model, count] of this.partCounts) {
      if (count > 0) {
        batches.push({ model, data: this.partBuffers.get(model)!, count })
      }
    }

    return {
      batches,
      lights: { lightCount, shadowLightCount, alphaCount, addCount },
    }
  }

  /** The car's loudest slipping tyre, for the screech (the same slip that lays its marks). */
  tyreAudio(id: number): { slip: number; slipSpeed: number; surface: number } | undefined {
    const d = this.draws.get(id)
    if (!d) return undefined
    let best = d.contacts[0]
    for (const c of d.contacts) if (best && c.slip > best.slip) best = c
    return best ? { slip: best.slip, slipSpeed: best.slipSpeed, surface: best.surface } : undefined
  }

  telemetry() {
    const wheels: number[] = []
    let emitting = 0
    for (const d of this.draws.values()) {
      for (const w of d.emissions.wheels) wheels.push(w.slip)
      emitting += d.emissions.emittingWheels
    }
    const m = this.drivingFx.marks
    return { skids: m.count, skidsWritten: m.written, skidsAlive: m.alive(), smoke: this.emissions.trail.count, sparks: this.fx.add.length, emittingWheels: emitting, slip: wheels }
  }

  /** The seated HUD: a dashboard gauge and key-cap hints (src/hud/vehicle-hud.ts). */
  syncHud(v: OutbreakVehicle | undefined, seatIndex = 0): void {
    if (!this.hud) return
    if (!v || v.wreck) {
      this.hud.update(null)
      return
    }
    const warning = !v.hasBattery ? "No battery" : !v.hasKeys ? "No keys" : v.fuel <= 0 ? "Empty tank" : null
    this.hud.update({ driver: seatIndex === 0, fuel: v.fuel / v.maxFuel, body: v.hp / v.maxHp, headlights: v.headlights, warning })
  }
}
