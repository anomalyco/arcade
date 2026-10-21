import type { Camera } from "@arcade/kit/client/camera"
import {
  FOLIAGE_MAX_ACTORS,
  FOLIAGE_WIND_FLOATS,
  foliageSettings,
  packFoliageActors,
  packFoliageGust,
  packFoliageUniforms,
} from "@arcade/kit/gpu/foliage"
import { LampGrid, type FrameInput, type Renderer, type VolumeInput } from "@arcade/kit/gpu/renderer"
import { FRAME_FLOATS } from "@arcade/kit/gpu/shaders"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_MAP_LIGHTS } from "@arcade/kit/limits"
import type { QualityProfile } from "@arcade/kit/quality"
import { raycast } from "@arcade/kit/sim/geom"
import { mat4 } from "wgpu-matrix"
import type { dayCycle } from "../../shared/day-cycle"

type DayCycleSample = ReturnType<typeof dayCycle>
import { flashlightColor } from "../../shared/flashlight"
import type { PeekInfo } from "../../shared/interact"
import { SIZE, type Lamp, type Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import type { WorldMode } from "../../shared/world"
import type { OutbreakVehicle } from "../../shared/vehicles"
import type { CoopView } from "../coop-view"
import type { BeamLook } from "../discovery/flashlight"
import { beamPose, beamScreenRect } from "../flashlight-beam"
import { packGroundCfgBits } from "../ground"
import { InteriorPresenter, SCONCE_LAMP_SLOT, SconceLights } from "../interiors"
import { TABLE_LAMP_SLOT, type TableLamp } from "../lightbake"
import {
  BEAM_QUALITY_TIERS,
  OUTBREAK_FOLIAGE_UNIFORM_OFFSET,
  OUTBREAK_VEG_GUST_UNIFORM_OFFSET,
  OUTBREAK_VEG_TREES_UNIFORM_OFFSET,
  OUTBREAK_INTERIOR_UNIFORM_OFFSET,
  OUTBREAK_LIGHTING_UNIFORM_FLOATS,
  OUTBREAK_REFLECT_LIGHTS_UNIFORM_END,
  OUTBREAK_REFLECT_LIGHTS_UNIFORM_OFFSET,
  OUTBREAK_REFLECT_UNIFORM_OFFSET,
  packOutbreakLightingUniforms,
  resolveLampLight,
  STREET_LAMP_POSTS,
  streetLampHead,
  type ResolvedLamp,
} from "../lighting"
import { originFurnishTown, propLamps } from "../props/furnish"
import { resolveBeamColor } from "../look/world"
import type { OutbreakSettings } from "../settings"
import type { Survivor } from "../survivor"
import { packReflectionLights } from "../reflections/lights"
import { applyStreetLens } from "../street-lamps/lens"
import { streetLensOn } from "../street-lamps/settings"
import { TableLampLights } from "../table-lamps"
import { vegetationGust } from "../vegetation/settings"
import { packVegetationTrees } from "../vegetation/trees"
import type { UnseenFrameEvaluation } from "../unseen"
import type { OutbreakSceneLevel } from "../world/scene-level"

const foliageActorPool = Array.from({ length: FOLIAGE_MAX_ACTORS }, () => ({ x: 0, z: 0 }))
const foliageActorOut: { x: number; z: number }[] = []
const foliageNearDist = new Float32Array(FOLIAGE_MAX_ACTORS - 1)
const foliageNearIdx = new Int32Array(FOLIAGE_MAX_ACTORS - 1)

/** Player first, then the nearest living zombies: grass and bushes bend away from them (presentation only, zero-alloc). */
function foliageActors(p: { x: number; y: number }, zombies: readonly { x: number; y: number; state: string }[]) {
  const maxOthers = FOLIAGE_MAX_ACTORS - 1
  const maxD2 = 24 * 24
  let found = 0
  for (let i = 0; i < zombies.length; i++) {
    const z = zombies[i]!
    if (z.state === "dead") continue
    const dx = z.x - p.x
    const dz = z.y - p.y
    const d2 = dx * dx + dz * dz
    if (d2 >= maxD2) continue
    if (found < maxOthers || d2 < foliageNearDist[found - 1]!) {
      let ins = found < maxOthers ? found++ : maxOthers - 1
      while (ins > 0 && foliageNearDist[ins - 1]! > d2) {
        foliageNearDist[ins] = foliageNearDist[ins - 1]!
        foliageNearIdx[ins] = foliageNearIdx[ins - 1]!
        ins--
      }
      foliageNearDist[ins] = d2
      foliageNearIdx[ins] = i
    }
  }
  foliageActorPool[0]!.x = p.x
  foliageActorPool[0]!.z = p.y
  foliageActorOut.length = 1 + found
  foliageActorOut[0] = foliageActorPool[0]!
  for (let k = 0; k < found; k++) {
    const z = zombies[foliageNearIdx[k]!]!
    const slot = foliageActorPool[k + 1]!
    slot.x = z.x
    slot.z = z.y
    foliageActorOut[k + 1] = slot
  }
  return foliageActorOut
}

const streetHeads = STREET_LAMP_POSTS.map(streetLampHead)
function nearestStreetHead(x: number, y: number, isStream = false): readonly [number, number, number] {
  const bx = isStream ? Math.floor(x / SIZE) * SIZE : 0
  const bz = isStream ? Math.floor(y / SIZE) * SIZE : 0
  let best = streetHeads[0]!
  for (const head of streetHeads) {
    if (Math.hypot(bx + head[0] - x, bz + head[2] - y) < Math.hypot(bx + best[0] - x, bz + best[2] - y)) best = head
  }
  return isStream ? [bx + best[0], best[1], bz + best[2]] : best
}

const zombieSlots: [number, number, number, number] = [-999, -999, -999, -999]
/** Two nearest living zombies within 12 m for analytic lamp shadows; unused slots stay far away. */
function nearestZombies(zombies: readonly { x: number; y: number; state: string }[], px: number, py: number) {
  let d0 = 144
  let d1 = 144
  zombieSlots.fill(-999)
  for (const z of zombies) {
    if (z.state === "dead") continue
    const d = (z.x - px) ** 2 + (z.y - py) ** 2
    if (d < d0) {
      d1 = d0
      zombieSlots[2] = zombieSlots[0]
      zombieSlots[3] = zombieSlots[1]
      d0 = d
      zombieSlots[0] = z.x
      zombieSlots[1] = z.y
    } else if (d < d1) {
      d1 = d
      zombieSlots[2] = z.x
      zombieSlots[3] = z.y
    }
  }
  return zombieSlots
}

const NO_TABLE_LAMPS: readonly TableLamp[] = []

function writeLightSlot(
  buf: Float32Array,
  slot: number,
  lx: number,
  lh: number,
  ly: number,
  r: number,
  cr: number,
  cg: number,
  cb: number,
  power: number,
  cx: number,
  cy: number,
  cz: number,
  cw: number,
  s0: number,
  s1: number,
  s2: number,
  s3: number,
): void {
  const o = slot * LIGHT_FLOATS
  buf[o] = lx
  buf[o + 1] = lh
  buf[o + 2] = ly
  buf[o + 3] = r
  buf[o + 4] = cr
  buf[o + 5] = cg
  buf[o + 6] = cb
  buf[o + 7] = power
  buf[o + 8] = cx
  buf[o + 9] = cy
  buf[o + 10] = cz
  buf[o + 11] = cw
  buf[o + 12] = s0
  buf[o + 13] = s1
  buf[o + 14] = s2
  buf[o + 15] = s3
}

export interface OutbreakFrameBeamState {
  count: number
  readonly flashlightSlot: number
  readonly flashlightHeight: number
  readonly flashlightAirLimit: number
  readonly flashlightYaw: number
  readonly beamReach: number
  readonly flashlightPitch: number | undefined
  readonly flashlightBounceHeight: number
  readonly flashRgb: readonly [number, number, number]
  readonly beamAim: number
  readonly beamRange: number
  readonly beamOutput: number
  readonly sightX: number
  readonly sightY: number
  readonly sightAim: number
  readonly sightCone: number
  readonly sightAwareness: number
}

/**
 * Owns Outbreak's per-frame light slot packing (sight light, player/co-op flashlights and vehicle headlights,
 * muzzle flash, street/room lamps with frustum + roof-cutout culling, wall sconces, table lamps), custom lighting
 * and foliage/interior uniform packing, volumetric beam screen bounds, and `FRAME_FLOATS` uniform packing.
 */
export class OutbreakFrameLighting {
  readonly frame = new Float32Array(FRAME_FLOATS)
  readonly lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  readonly lampPower = new Float32Array(MAX_MAP_LIGHTS)
  readonly lightingUniforms = new Float32Array(OUTBREAK_LIGHTING_UNIFORM_FLOATS)
  private readonly unshadowedLampBuf = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  private readonly tableLamps = new TableLampLights()
  readonly lampGrid = new LampGrid()
  private readonly scratchResolvedLamp: ResolvedLamp = {
    lx: 0,
    lh: 0,
    ly: 0,
    r: 0,
    rEff: 0,
    color: [0, 0, 0],
    power: 0,
    fixtureBrightness: 0,
    cone: [0, 0, 0, 0],
    softness: 0,
    castShadows: false,
  }
  private readonly flashlightBounce: [number, number] = [0, 0]
  private readonly flashlightOrigin: [number, number] = [0, 0]
  private readonly invViewProj = new Float32Array(16)
  private lastSightX = -1e3
  private lastSightY = -1e3
  private fieldWindowX = 0
  private fieldWindowY = 0

  resetForSession(): void {
    this.lastSightX = -1e3
    this.lastSightY = -1e3
  }

  beginFrameLights(input: {
    readonly p: { x: number; y: number; aim: number; flashlightOutput: number; seatIndex?: number }
    readonly town: Town
    readonly peek: PeekInfo | null
    readonly activePeek: PeekInfo | null
    readonly peekBlend: number
    /** Where sight looks from while a smooth peek eases (`PeekView.sight`); null keeps the linear blend. */
    readonly sight?: { x: number; y: number; aim: number; cone: number; awareness: number } | null
    readonly playerGroundY: number
    readonly localVehicle: OutbreakVehicle | undefined
    readonly drivingHeadlights: boolean
    readonly effectiveVisionAim: number
    readonly effectiveVisionSettings: { range: number; cone: number; awareness: number }
    readonly lowBeam: BeamLook
    readonly avatar: Survivor
    readonly coop: CoopView
    readonly settings: OutbreakSettings
    readonly sceneLevel: OutbreakSceneLevel
    readonly frameLightOccluders: number
  }): OutbreakFrameBeamState {
    const {
      p,
      town,
      peek,
      activePeek,
      peekBlend,
      playerGroundY,
      localVehicle,
      drivingHeadlights,
      effectiveVisionAim,
      effectiveVisionSettings,
      lowBeam,
      avatar,
      coop,
      settings,
      sceneLevel,
      frameLightOccluders,
    } = input
    const { blockers, lightOccluders, lightWalls } = sceneLevel
    this.lights.fill(0)
    const { sight } = input
    const sightX = sight ? sight.x : activePeek ? p.x + (activePeek.eyeX - p.x) * peekBlend : p.x
    const sightY = sight ? sight.y : activePeek ? p.y + (activePeek.eyeY - p.y) * peekBlend : p.y
    const sightAim = sight ? sight.aim : peek ? peek.aim : effectiveVisionAim
    const sightCone = sight
      ? sight.cone
      : activePeek
        ? effectiveVisionSettings.cone + (Math.max(effectiveVisionSettings.cone, activePeek.cone) - effectiveVisionSettings.cone) * peekBlend
        : effectiveVisionSettings.cone
    const sightAwareness = sight
      ? sight.awareness
      : activePeek
        ? effectiveVisionSettings.awareness + (Math.max(effectiveVisionSettings.awareness, activePeek.awareness) - effectiveVisionSettings.awareness) * peekBlend
        : effectiveVisionSettings.awareness
    writeLightSlot(
      this.lights,
      0,
      sightX,
      1.65 + supportHeight(town, p.x, p.y),
      sightY,
      effectiveVisionSettings.range,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      blockers.length,
      0.01,
      -1,
    )
    let count = 1
    let flashlightSlot = -1
    let flashlightHeight = 1.34 + playerGroundY
    let flashlightAirLimit = 0
    let flashlightYaw = p.aim
    let beamReach = 0
    let flashlightPitch: number | undefined
    let flashlightBounceHeight = playerGroundY + 0.3
    const rawFlashRgb = drivingHeadlights ? flashlightColor(settings.flashlight.flashlightWarmth) : lowBeam.color
    const flashRgb = resolveBeamColor(rawFlashRgb, settings.look.beamWarmth)
    const beamAim = drivingHeadlights && localVehicle ? localVehicle.h : p.aim
    const beamRange = drivingHeadlights ? settings.vehicle.headlightRange : lowBeam.range
    const beamOutput = drivingHeadlights ? 1.0 : p.flashlightOutput
    const beamIntensity = drivingHeadlights
      ? settings.vehicle.headlightPower * 0.85
      : settings.flashlight.flashlightIntensity
    if (beamOutput > 0.001 && beamIntensity > 0.001) {
      // Lens and direction from the posed rig on foot, or the vehicle front fascia when driving with headlights on.
      const beam =
        drivingHeadlights && localVehicle
          ? {
              x: localVehicle.x + Math.cos(beamAim) * (localVehicle.spec.length * 0.48),
              y: localVehicle.y + Math.sin(beamAim) * (localVehicle.spec.length * 0.48),
              h: 0.72 + playerGroundY,
              yaw: beamAim,
              pitch: -0.18,
            }
          : beamPose(avatar.light, p.x, p.y, p.aim, playerGroundY, settings.flashlight.beamPoolDistance, lightWalls)
      const fx = beam.x
      const fy = beam.y
      const fh = beam.h
      const dx = Math.cos(beam.yaw)
      const dy = Math.sin(beam.yaw)
      const cosHalf = Math.cos(((drivingHeadlights ? 68 : lowBeam.cone) * Math.PI) / 360)
      // cone.w 2: the scene's flashAttenuation shapes the 3D beam; rain and smoke still read the plan cone.
      const power = beamOutput * beamIntensity
      flashlightSlot = count
      flashlightHeight = fh
      this.flashlightOrigin[0] = fx
      this.flashlightOrigin[1] = fy
      flashlightYaw = beam.yaw
      flashlightPitch = beam.pitch
      const wall = raycast(fx, fy, dx, dy, lightWalls, beamRange)
      const reach = Math.max(0.5, (fh - playerGroundY) / Math.max(0.05, Math.tan(-beam.pitch)))
      const hit = Math.min(wall, reach, beamRange)
      this.flashlightBounce[0] = fx + dx * Math.max(0.3, hit - 0.15)
      this.flashlightBounce[1] = fy + dy * Math.max(0.3, hit - 0.15)
      flashlightAirLimit = wall
      beamReach = Math.min(beamRange, wall + 1.5, 13)
      flashlightBounceHeight = playerGroundY + (wall < reach ? 0.9 : 0.3)
      writeLightSlot(
        this.lights,
        count++,
        fx,
        fh,
        fy,
        beamRange,
        flashRgb[0],
        flashRgb[1],
        flashRgb[2],
        power,
        dx,
        dy,
        cosHalf,
        2,
        0,
        frameLightOccluders,
        0.06,
        -1,
      )
    }
    count = coop.flashlights(this.lights, count, town, settings, lightOccluders, lightWalls)
    return {
      count,
      flashlightSlot,
      flashlightHeight,
      flashlightAirLimit,
      flashlightYaw,
      beamReach,
      flashlightPitch,
      flashlightBounceHeight,
      flashRgb,
      beamAim,
      beamRange,
      beamOutput,
      sightX,
      sightY,
      sightAim,
      sightCone,
      sightAwareness,
    }
  }

  addMuzzleLight(muzzleLight: readonly [number, number, number, number] | null, count: number, lightOccluders: number): number {
    if (muzzleLight && count < MAX_LIGHTS) {
      const [mx, my, mz, mPower] = muzzleLight
      writeLightSlot(this.lights, count++, mx, my, mz, 9.5, 1.0, 0.78, 0.38, mPower, 0, 0, 0, 0, 0, lightOccluders, 0.14, -1)
    }
    return count
  }

  collectMapAndInteriorLights(input: {
    readonly town: Town
    readonly day: DayCycleSample
    readonly settings: OutbreakSettings
    readonly qProfile: QualityProfile
    readonly cam: Camera
    readonly camX: number
    readonly camY: number
    readonly cutX: number
    readonly cutY: number
    readonly inInteriorView: boolean
    readonly mode: WorldMode
    readonly sceneLevel: OutbreakSceneLevel
    readonly interiors: InteriorPresenter
    readonly count: number
    readonly shadowLightCount: number
    /** Adjusts a resolved map lamp before it is packed (Night lights' dying street lamps). */
    readonly lampTrim?: (lamp: Lamp, resolved: ResolvedLamp) => void
    /** Packs extra map-range lights after the table lamps (Night lights); returns the new count. */
    readonly extraLights?: (lights: Float32Array, count: number, max: number, lampPower: Float32Array) => number
  }): { count: number; shadowLightCount: number } {
    const {
      town,
      day,
      settings,
      qProfile,
      cam,
      camX,
      camY,
      cutX,
      cutY,
      inInteriorView,
      mode,
      sceneLevel,
      interiors,
    } = input
    let { count, shadowLightCount } = input
    const directLightCount = count
    const { lightOccluders } = sceneLevel
    const [vx0, vy0, vx1, vy1] = cam.groundRect(2.8)
    const vp = cam.viewProj
    const inLightFrustum = (lx: number, ly: number, r: number): boolean => {
      for (const [sx, sy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const a = vp[3]! + sx * vp[0]! + sy * vp[1]!
        const b = vp[7]! + sx * vp[4]! + sy * vp[5]!
        const c = vp[11]! + sx * vp[8]! + sy * vp[9]!
        const d = vp[15]! + sx * vp[12]! + sy * vp[13]!
        if (a * lx + c * ly + r * Math.hypot(a, c) + (b > 0 ? 2.8 * b : 0) + d < 0) return false
      }
      return true
    }
    let unshadowedCount = 0
    const maxUnshadowed = qProfile.maxUnshadowedLamps
    const lensLamps = streetLensOn(settings.streetLamps)
    for (let i = 0; i < town.lamps.length; i++) {
      const lamp = town.lamps[i]!
      const resolved = resolveLampLight(lamp, town.buildings, day.lamps, settings.lighting, inInteriorView, this.scratchResolvedLamp, settings.look.litWindows)
      input.lampTrim?.(lamp, resolved)
      this.lampPower[i] = resolved.fixtureBrightness
      if (resolved.power <= 0.001) continue
      if (lensLamps && lamp.kind === "street") applyStreetLens(lamp, resolved, settings.streetLamps, settings.lighting.lightFalloff)
      const { lx, lh, ly, r, rEff, color, power, cone, softness, castShadows } = resolved
      const dCam = Math.hypot(lx - camX, ly - camY)
      if (dCam > (lamp.kind === "street" ? 15.5 : 16.5)) continue
      if (inInteriorView && (!castShadows || lamp.kind === "street")) continue
      if (lx + rEff < vx0 || lx - rEff > vx1 || ly + rEff < vy0 || ly - rEff > vy1 || !inLightFrustum(lx, ly, rEff)) continue
      if (lamp.kind === "room") {
        let b: (typeof town.buildings)[number] | undefined
        for (let bIdx = 0; bIdx < town.buildings.length; bIdx++) {
          const bld = town.buildings[bIdx]!
          if (lamp.x >= bld.rect[0] && lamp.x <= bld.rect[2] && lamp.y >= bld.rect[1] && lamp.y <= bld.rect[3]) {
            b = bld
            break
          }
        }
        if (b) {
          const roofOpen =
            cutX > b.rect[0] - 0.1 && cutX < b.rect[2] + 0.1 && cutY > b.rect[1] - 0.1 && cutY < b.rect[3] + 0.1
          if (!roofOpen) continue
        }
      }
      // Lens street lamps (street-lamps/) cast polar shadows whose penumbra is the lens size.
      const usePolarShadow = castShadows && (lamp.kind === "room" || lamp.kind === "street")
      if (usePolarShadow) {
        if (count < MAX_LIGHTS) {
          writeLightSlot(this.lights, count++, lx, lh, ly, r, color[0], color[1], color[2], power, cone[0], cone[1], cone[2], cone[3], 0, lightOccluders, softness, i)
          shadowLightCount = count
        }
      } else if (unshadowedCount < maxUnshadowed) {
        writeLightSlot(this.unshadowedLampBuf, unshadowedCount++, lx, lh, ly, r, color[0], color[1], color[2], power, cone[0], cone[1], cone[2], cone[3], 0, 0, softness, i)
      }
    }
    for (let u = 0; u < unshadowedCount && count < MAX_LIGHTS; u++) {
      const srcOff = u * LIGHT_FLOATS
      const dstOff = count++ * LIGHT_FLOATS
      for (let f = 0; f < LIGHT_FLOATS; f++) this.lights[dstOff + f] = this.unshadowedLampBuf[srcOff + f]!
    }
    const sconceLevel = day.lamps * settings.lighting.lighting * settings.lighting.roomPower
    this.lampPower[SCONCE_LAMP_SLOT] = SconceLights.bulb(sconceLevel, interiors.settings)
    this.lampPower[TABLE_LAMP_SLOT] = sconceLevel * 0.5
    interiors.sconces.setSources(sceneLevel.activeSconces() as Float32Array[])
    count = interiors.sconces.write(
      this.lights,
      count,
      MAX_LIGHTS,
      inInteriorView ? (interiors.settings.sconceLights >= 0 ? interiors.settings.sconceLights : qProfile.maxSconceLights) : 0,
      cutX,
      cutY,
      sconceLevel,
      settings.lighting.practicalWarmth,
      interiors.settings,
    )
    this.tableLamps.setSources(mode === "procedural" ? NO_TABLE_LAMPS : propLamps(town), originFurnishTown(town))
    const tableLampCount = settings.look.tableLamps >= 0 ? settings.look.tableLamps : Math.min(2, qProfile.maxSconceLights)
    count = this.tableLamps.write(this.lights, count, MAX_LIGHTS, inInteriorView ? tableLampCount : 0, cutX, cutY, sconceLevel, settings.lighting.practicalWarmth, 0.55 * settings.look.tableLampPower)
    if (input.extraLights) count = input.extraLights(this.lights, count, MAX_LIGHTS, this.lampPower)
    const origin = sceneLevel.currentWindowOrigin
    this.lampGrid.update(this.lights, directLightCount, count, origin[0], origin[1])
    return { count, shadowLightCount }
  }

  packUniformsAndVolume(input: {
    readonly dt: number
    readonly p: { x: number; y: number; vx: number; vy: number }
    readonly town: Town
    readonly zombies: readonly { x: number; y: number; state: string }[]
    readonly playerGroundY: number
    readonly cam: Camera
    readonly camX: number
    readonly camY: number
    readonly inInteriorView: boolean
    readonly drivingHeadlights: boolean
    readonly lowBeam: BeamLook
    readonly beamState: OutbreakFrameBeamState
    readonly activeWeather:
      | {
          readonly wetness: number
          readonly puddleCoverage: number
          readonly rippleIntensity: number
          readonly snowAmount: number
          readonly wetGloss?: number
          readonly shroudLift?: number
          /** Extra beam air from rain and mist (0..2). */
          readonly air?: number
        }
      | undefined
    readonly unseenEval: UnseenFrameEvaluation
    readonly settings: OutbreakSettings
    readonly sceneLevel: OutbreakSceneLevel
    readonly interiors: InteriorPresenter
    readonly renderer: Renderer
    readonly lightCount: number
  }): VolumeInput | null {
    const {
      dt,
      p,
      town,
      zombies,
      playerGroundY,
      cam,
      camX,
      camY,
      inInteriorView,
      drivingHeadlights,
      lowBeam,
      beamState,
      activeWeather,
      unseenEval,
      settings,
      sceneLevel,
      interiors,
      renderer,
      lightCount,
    } = input
    const {
      flashlightSlot,
      flashlightHeight,
      flashlightAirLimit,
      flashlightYaw,
      beamReach,
      flashlightPitch,
      flashlightBounceHeight,
      flashRgb,
      beamAim,
      beamOutput,
      sightX,
      sightY,
    } = beamState
    // The visibility field is anchored to the streaming window: a new window origin starts it afresh.
    const { currentWindowOrigin, currentIsStreamWindow } = sceneLevel
    const fieldSnap = currentWindowOrigin[0] !== this.fieldWindowX || currentWindowOrigin[1] !== this.fieldWindowY
    if (fieldSnap) {
      renderer.clearVisibilityField()
      this.fieldWindowX = currentWindowOrigin[0]
      this.fieldWindowY = currentWindowOrigin[1]
    }
    // The lighting pack reads the tuned beam; a dying battery narrows and shortens it for this frame only.
    const tunedCone = settings.flashlight.flashlightCone
    const tunedRange = settings.flashlight.flashlightRange
    if (!drivingHeadlights) {
      settings.flashlight.flashlightCone = lowBeam.cone
      settings.flashlight.flashlightRange = lowBeam.range
    }
    const activeBuildings = sceneLevel.activeBuildings(town)
    packOutbreakLightingUniforms(
      {
        settings,
        playerX: p.x,
        playerY: p.y,
        playerH: playerGroundY,
        playerAim: beamAim,
        flashlightOutput: beamOutput,
        flashlightSlot,
        flashlightHeight,
        flashlightBounce: this.flashlightBounce,
        flashlightAirLimit,
        flashlightBounceHeight,
        flashlightOrigin: flashlightSlot >= 0 ? this.flashlightOrigin : undefined,
        flashlightYaw,
        flashlightPitch,
        invViewProj: mat4.inverse(cam.viewProj, this.invViewProj),
        beamReach,
        weatherAir: activeWeather?.air ?? 0,
        frameDt: fieldSnap || Math.hypot(sightX - this.lastSightX, sightY - this.lastSightY) > 2.5 ? 0 : dt,
        inInteriorView,
        streetHead: nearestStreetHead(camX, camY, currentIsStreamWindow),
        zombies: nearestZombies(zombies, p.x, p.y),
        weather: activeWeather,
        windowOrigin: currentWindowOrigin,
        isStreamWindow: currentIsStreamWindow,
        windowBuildings: activeBuildings,
        unseen: unseenEval,
        chunkFadeAlpha: currentIsStreamWindow ? sceneLevel.worldStreamer.chunkFadeAlpha : 0,
        nightSightWeight: sceneLevel.nightSightWeight,
        streetLamps: settings.streetLamps,
        windowRooms: settings.windowRooms,
      },
      flashRgb,
      this.lightingUniforms,
    )
    settings.flashlight.flashlightCone = tunedCone
    settings.flashlight.flashlightRange = tunedRange
    if (this.lightingUniforms[OUTBREAK_REFLECT_UNIFORM_OFFSET]! > 0) {
      packReflectionLights(this.lights, lightCount, activeBuildings, cam.groundRect(0.2), cam.eye, (x, z) => supportHeight(town, x, z), this.lightingUniforms, OUTBREAK_REFLECT_LIGHTS_UNIFORM_OFFSET)
    } else this.lightingUniforms.fill(0, OUTBREAK_REFLECT_LIGHTS_UNIFORM_OFFSET, OUTBREAK_REFLECT_LIGHTS_UNIFORM_END)
    packFoliageUniforms(foliageSettings, this.lightingUniforms, OUTBREAK_FOLIAGE_UNIFORM_OFFSET)
    packFoliageActors(foliageActors(p, zombies), this.lightingUniforms, OUTBREAK_FOLIAGE_UNIFORM_OFFSET + FOLIAGE_WIND_FLOATS)
    packFoliageGust(vegetationGust(settings.vegetation), this.lightingUniforms, OUTBREAK_VEG_GUST_UNIFORM_OFFSET)
    packVegetationTrees(settings.vegetation, town, p.x, p.y, this.lightingUniforms, OUTBREAK_VEG_TREES_UNIFORM_OFFSET)
    const deferRugWork = !inInteriorView && (Math.abs(p.vx) > 0.05 || Math.abs(p.vy) > 0.05)
    interiors.update(activeBuildings, town.houseSeed, p.x, p.y, performance.now(), deferRugWork)
    interiors.pack(this.lightingUniforms, OUTBREAK_INTERIOR_UNIFORM_OFFSET, activeBuildings, town.houseSeed)
    renderer.setCustomUniforms(this.lightingUniforms)
    this.lastSightX = sightX
    this.lastSightY = sightY
    const beamTier = BEAM_QUALITY_TIERS[Math.round(settings.flashlight.beamQuality)] ?? BEAM_QUALITY_TIERS[2]
    return flashlightSlot >= 0 && beamTier.downscale && (settings.flashlight.beamVisibility > 0.001 || settings.flashlight.beamGlare > 0.001)
      ? {
          downscale: beamTier.downscale,
          rect: beamScreenRect(
            (x, y, z) => cam.project(x, y, z, 1, 1),
            [this.flashlightOrigin[0], flashlightHeight, this.flashlightOrigin[1]],
            flashlightYaw,
            flashlightPitch ?? 0,
            ((drivingHeadlights ? settings.flashlight.flashlightCone : lowBeam.cone) * Math.PI) / 360,
            beamReach,
            playerGroundY,
          ),
        }
      : null
  }

  packFrameBuffer(input: {
    readonly cam: Camera
    readonly time: number
    readonly canvasWidth: number
    readonly canvasHeight: number
    readonly w: number
    readonly h: number
    readonly count: number
    readonly settings: OutbreakSettings
    readonly p: { x: number; y: number }
    readonly activePeek: PeekInfo | null
    readonly peekBlend: number
    readonly cutX: number
    readonly cutY: number
    readonly cutFlag: number
    readonly cutRadius: number
    readonly cutHeight: number
    readonly day: DayCycleSample
    readonly lightningFlash: number
    /** The weather's sky this frame: overcast, the flash's shroud lift and the direction its light comes from. */
    readonly weather?: { readonly overcast: number; readonly shroudLift: number; readonly strikeDir: readonly [number, number, number] }
    readonly sightAim: number
    readonly sightCone: number
    readonly sightAwareness: number
  }): void {
    const {
      cam,
      time,
      canvasWidth,
      canvasHeight,
      w,
      h,
      count,
      settings,
      p,
      activePeek,
      peekBlend,
      cutX,
      cutY,
      cutFlag,
      cutRadius,
      cutHeight,
      day,
      lightningFlash,
      weather,
      sightAim,
      sightCone,
      sightAwareness,
    } = input
    const { frame } = this
    frame.set(cam.viewProj, 0)
    frame[16] = cam.eye[0]!
    frame[17] = cam.eye[1]!
    frame[18] = cam.eye[2]!
    frame[19] = time
    const texCfgBits =
      ((settings.materials.textures & 3) >>> 0) |
      (((settings.materials.rugStyle & 3) << 2) >>> 0) |
      (((settings.materials.wallStyle & 3) << 4) >>> 0) |
      (((settings.materials.floorStyle & 3) << 6) >>> 0) |
      ((Math.round((settings.materials.texScale - 0.5) / 0.05) & 63) << 8) |
      ((Math.round(settings.materials.texContrast / 0.05) & 63) << 14) |
      ((Math.round(settings.world.weathering * 5) & 15) << 20)
    frame[20] = canvasWidth
    frame[21] = canvasHeight
    frame[22] = count
    frame[23] = texCfgBits
    frame[24] = cutX
    frame[25] = cutY
    frame[26] = cutFlag
    frame[27] = cutRadius
    // Rain brings cloud; lightning lights everything for a moment in cold blue-white, from the strike's side of the sky.
    const overcast = Math.max(settings.weather.weather, (weather?.overcast ?? 0) * 0.6)
    const ambScale = settings.lighting.skyFill * (1 - overcast * 0.3)
    const ambAdd = lightningFlash * 0.3
    frame[28] = day.ambient[0] * ambScale + ambAdd * 0.86
    frame[29] = day.ambient[1] * ambScale + ambAdd * 0.94
    frame[30] = day.ambient[2] * ambScale + ambAdd * 1.1
    frame[31] = day.strength * settings.lighting.moonFill * (1 - overcast * 0.85) + lightningFlash * 1.1
    const focusX = activePeek ? p.x + (activePeek.cutX - p.x) * peekBlend : p.x
    const focusY = activePeek ? p.y + (activePeek.cutY - p.y) * peekBlend : p.y
    const focus = cam.project(focusX, 1, focusY, w, h)
    frame[32] = (focus.x / w) * 2 - 1
    frame[33] = 1 - (focus.y / h) * 2
    frame[34] = cutHeight
    frame[35] = count
    const sky = weather && lightningFlash > 0.001 ? Math.min(1, lightningFlash * 1.5) : 0
    const dx = day.direction[0] + ((weather?.strikeDir[0] ?? 0) - day.direction[0]) * sky
    const dy = day.direction[1] + ((weather?.strikeDir[1] ?? 0) - day.direction[1]) * sky
    const dz = day.direction[2] + ((weather?.strikeDir[2] ?? 0) - day.direction[2]) * sky
    const dl = Math.hypot(dx, dy, dz) || 1
    frame[36] = dx / dl
    frame[37] = dy / dl
    frame[38] = dz / dl
    frame[39] = day.sun
    frame[40] = 1 / SIZE
    frame[41] = 1 / SIZE
    frame[42] = settings.view.diagnostic
    frame[43] = packGroundCfgBits(settings.ground)
    frame[44] = sightAim
    frame[45] = Math.cos((sightCone * Math.PI) / 360)
    frame[46] = sightAwareness
    frame[47] = settings.vision.shroud * (1 - (weather?.shroudLift ?? 0))
  }
}
