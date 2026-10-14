import type { LabControl } from "@arcade/kit/lab-panel"
import type { Building, Lamp } from "../shared/map"

export type OutbreakLightingSettings = {
  exposure: number
  skyFill: number
  moonFill: number
  lighting: number
  practicalWarmth: number
  porchPower: number
  windowPower: number
  roomPower: number
  streetPower: number
  lightFalloff: number
  flashlightHaze: number
  wetSpecular: number
  rimStrength: number
  vignetteDarkness: number
}

export const DEFAULT_OUTBREAK_LIGHTING: OutbreakLightingSettings = {
  exposure: 0.88,
  skyFill: 0.38,
  moonFill: 0.85,
  lighting: 1.0,
  practicalWarmth: 0.62,
  porchPower: 0.42,
  windowPower: 0.44,
  roomPower: 0.48,
  streetPower: 0.15,
  lightFalloff: 1.45,
  flashlightHaze: 1.15,
  wetSpecular: 0.78,
  rimStrength: 0.85,
  vignetteDarkness: 0.75,
}

export const outbreakLightingControls: LabControl[] = [
  { key: "exposure", label: "Exposure", group: "Look", min: 0.5, max: 2, step: 0.02, unit: "×" },
  { key: "skyFill", label: "Sky fill", group: "Look", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "moonFill", label: "Moonlight fill", group: "Look", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "lighting", label: "Practical lights", group: "Look", min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "practicalWarmth", label: "Practical warmth", group: "Lighting", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "porchPower", label: "Porch light power", group: "Lighting", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "windowPower", label: "Window spill power", group: "Lighting", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "roomPower", label: "Interior lamp power", group: "Lighting", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "streetPower", label: "Streetlamp power", group: "Lighting", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "lightFalloff", label: "Light pool tightness", group: "Lighting", min: 0.5, max: 2.5, step: 0.05, unit: "×" },
  { key: "flashlightHaze", label: "Flashlight cone haze", group: "Lighting", min: 0, max: 2.0, step: 0.05, unit: "×" },
  { key: "wetSpecular", label: "Wet specular sheen", group: "Lighting", min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "rimStrength", label: "Moonlight rim", group: "Lighting", min: 0, max: 2.0, step: 0.05, unit: "×" },
  { key: "vignetteDarkness", label: "Peripheral darkness", group: "Lighting", min: 0, max: 1.2, step: 0.05, unit: "×" },
]

export const OUTBREAK_LIGHTING_UNIFORM_FLOATS = 32

export type OutbreakLightingFrameState = {
  settings: OutbreakLightingSettings & {
    flashlightIntensity: number
    flashlightRange: number
    flashlightCone: number
    flashlightWarmth: number
  }
  playerX: number
  playerY: number
  playerH: number
  playerAim: number
  flashlightOutput: number
  flashlightSlot: number
  inInteriorView: boolean
}

/**
 * Packs 32 floats (8 vec4f) into Renderer's custom uniform buffer (@group(0) @binding(13)):
 * u0: skyFill, moonFill, practicalWarmth, lightFalloff
 * u1: porchPower, windowPower, roomPower, streetPower
 * u2: flashlightHaze, wetSpecular, rimStrength, vignetteDarkness
 * u3: flashOriginX, flashOriginY, flashDirX, flashDirY
 * u4: flashTanHalf, flashRange, flashPower, flashSlot
 * u5: flashColorR, flashColorG, flashColorB, inInteriorView (1 or 0)
 * u6: playerX, playerY, playerH, exposure
 * u7: reserved
 */
export function packOutbreakLightingUniforms(
  state: OutbreakLightingFrameState,
  flashColor: readonly [number, number, number],
  out: Float32Array<ArrayBuffer> = new Float32Array(OUTBREAK_LIGHTING_UNIFORM_FLOATS),
): Float32Array<ArrayBuffer> {
  const { settings: s } = state
  // When facing the static north pose (-PI/2) at rest, angle the left-hand beam down-left into the street/hallway
  // matching the Noir & Dusk paint-overs; when actively aiming elsewhere, follow playerAim.
  const isNorthRestPose = Math.abs(state.playerAim - -Math.PI / 2) < 0.04
  const beamAngle = isNorthRestPose ? (state.inInteriorView ? 2.04 : 2.03) : state.playerAim
  const dirX = Math.cos(beamAngle)
  const dirY = Math.sin(beamAngle)
  const handX = state.playerX + (isNorthRestPose ? -0.16 : dirX * 0.24)
  const handY = state.playerY + (isNorthRestPose ? 0.10 : dirY * 0.24)
  const halfRad = (Math.max(18, Math.min(90, s.flashlightCone * 0.62)) * Math.PI) / 360

  // u0
  out[0] = s.skyFill
  out[1] = s.moonFill
  out[2] = s.practicalWarmth
  out[3] = s.lightFalloff
  // u1
  out[4] = s.porchPower
  out[5] = s.windowPower
  out[6] = s.roomPower
  out[7] = s.streetPower
  // u2
  out[8] = s.flashlightHaze
  out[9] = s.wetSpecular
  out[10] = s.rimStrength
  out[11] = s.vignetteDarkness
  // u3
  out[12] = handX
  out[13] = handY
  out[14] = dirX
  out[15] = dirY
  // u4
  out[16] = Math.tan(halfRad)
  out[17] = state.inInteriorView ? Math.min(s.flashlightRange, 6.8) : Math.min(s.flashlightRange, 11.8)
  out[18] = state.flashlightOutput * s.flashlightIntensity
  out[19] = state.flashlightSlot
  // u5
  out[20] = flashColor[0]
  out[21] = flashColor[1]
  out[22] = flashColor[2]
  out[23] = state.inInteriorView ? 1 : 0
  // u6
  out[24] = state.playerX
  out[25] = state.playerY
  out[26] = state.playerH
  out[27] = s.exposure
  return out
}

export type ResolvedLamp = {
  lx: number
  lh: number
  ly: number
  r: number
  rEff: number
  color: [number, number, number]
  power: number
  fixtureBrightness: number
  cone: [number, number, number, number]
  softness: number
}

/**
 * Resolves selective, warmer, tighter practical light parameters for each town lamp.
 */
export function resolveLampLight(
  lamp: Lamp,
  buildings: readonly Building[],
  dayLamps: number,
  s: OutbreakLightingSettings,
  inInteriorView: boolean,
): ResolvedLamp {
  const master = dayLamps * s.lighting
  const w = Math.max(0, Math.min(1, s.practicalWarmth))
  const tight = Math.max(0.5, s.lightFalloff)
  const invTight = 1 / Math.sqrt(tight)

  if (lamp.kind === "street") {
    const power = master * lamp.power * s.streetPower
    const r = lamp.radius * 0.78 * invTight
    return {
      lx: lamp.x + 0.55,
      lh: lamp.h,
      ly: lamp.y,
      r,
      rEff: r * 0.85,
      color: [1.0, 0.68 - 0.10 * w, 0.38 - 0.14 * w],
      power,
      fixtureBrightness: master * s.streetPower * 0.35,
      cone: [0, 0, 0, 0],
      softness: 0.2,
    }
  }

  if (lamp.kind === "porch") {
    const interiorDim = inInteriorView ? 0.52 : 1.0
    const power = master * lamp.power * s.porchPower * interiorDim
    const r = lamp.radius * (inInteriorView ? 0.48 : 0.58) * invTight
    return {
      lx: lamp.x,
      lh: 2.22,
      ly: lamp.y - 0.18,
      r,
      rEff: r * 0.85,
      color: [1.0, 0.58 - 0.08 * w, 0.22 - 0.08 * w],
      power,
      fixtureBrightness: master * s.porchPower * interiorDim * 0.62,
      cone: [0, 0, 0, -1],
      softness: 0.16,
    }
  }

  if (lamp.kind === "window") {
    const interiorDim = inInteriorView ? 0.42 : 1.0
    const power = master * lamp.power * s.windowPower * interiorDim
    const r = lamp.radius * 0.68 * invTight
    return {
      lx: lamp.x,
      lh: 1.38,
      ly: lamp.y - 0.04,
      r,
      rEff: r * 0.82,
      color: [1.0, 0.52 - 0.08 * w, 0.16 - 0.06 * w],
      power,
      fixtureBrightness: master * s.windowPower * interiorDim * 0.65,
      cone: [0, 1, -0.55, 1],
      softness: 0.18,
    }
  }

  // Room practicals: selective choreography per room role inside each house
  const b = buildings.find(
    (bld) => lamp.x >= bld.rect[0] && lamp.x <= bld.rect[2] && lamp.y >= bld.rect[1] && lamp.y <= bld.rect[3],
  )
  let lx = lamp.x
  let ly = lamp.y
  let lh = lamp.h
  let rScale = 0.72
  let pScale = 0.65
  let fixtureScale = 0.65
  let color: [number, number, number] = [1.0, 0.56 - 0.08 * w, 0.20 - 0.06 * w]

  if (b && b.kind === "house") {
    const relX = lamp.x - b.rect[0]
    const relY = lamp.y - b.rect[1]
    if (relX < 4.0 && relY < 3.0) {
      // #1 NW bedroom nightstand lamp: warm primary focal pool next to bed
      lx = b.rect[0] + 2.65
      ly = b.rect[1] + 1.15
      lh = 1.18
      rScale = 0.92
      pScale = 1.05
      fixtureScale = 1.15
      color = [1.0, 0.62 - 0.06 * w, 0.24 - 0.06 * w]
    } else if (relX > 4.0 && relY < 4.5) {
      // #4 NE bedroom dresser candle/accent: shifted to the dresser at (x+7.55, z+1.15), tight warm pool
      lx = b.rect[0] + 7.45
      ly = b.rect[1] + 1.25
      lh = 1.32
      rScale = 0.56
      pScale = 0.46
      fixtureScale = 0.25
      color = [1.0, 0.54 - 0.06 * w, 0.16 - 0.04 * w]
    } else if (relX < 4.5 && relY >= 4.5) {
      // #2 SW living room: low warm candle pool on the coffee table (x+2.7, b-2.2), keeping corners moody
      lx = b.rect[0] + 2.7
      ly = b.rect[3] - 2.2
      lh = 0.92
      rScale = 0.52
      pScale = 0.34
      fixtureScale = 0.12
      color = [1.0, 0.48 - 0.06 * w, 0.14 - 0.04 * w]
    } else {
      // #3 SE kitchen/dining: small localized warm pool over the wooden dining table (r-3.2, b-2.8)
      lx = b.rect[2] - 3.2
      ly = b.rect[3] - 2.8
      lh = 1.35
      rScale = 0.48
      pScale = 0.28
      fixtureScale = 0.15
      color = [1.0, 0.52 - 0.06 * w, 0.16 - 0.04 * w]
    }
  }

  const r = lamp.radius * rScale * invTight
  const power = master * lamp.power * s.roomPower * pScale
  return {
    lx,
    lh,
    ly,
    r,
    rEff: r * 0.85,
    color,
    power,
    fixtureBrightness: master * s.roomPower * fixtureScale,
    cone: [0, 0, 0, -1],
    softness: 0.14,
  }
}

export const outbreakLightingDeclarationsWgsl = /* wgsl */ `
struct OutbreakLightingUniforms {
  u0: vec4f, // skyFill, moonFill, practicalWarmth, lightFalloff
  u1: vec4f, // porchPower, windowPower, roomPower, streetPower
  u2: vec4f, // flashlightHaze, wetSpecular, rimStrength, vignetteDarkness
  u3: vec4f, // flashOriginX, flashOriginY, flashDirX, flashDirY
  u4: vec4f, // flashTanHalf, flashRange, flashPower, flashSlot
  u5: vec4f, // flashColorR, flashColorG, flashColorB, inInteriorView
  u6: vec4f, // playerX, playerY, playerH, exposure
  u7: vec4f, // reserved
}
@group(0) @binding(13) var<uniform> OL: OutbreakLightingUniforms;
`
