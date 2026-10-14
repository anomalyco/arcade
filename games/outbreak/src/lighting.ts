import type { LabControl } from "@arcade/kit/lab-panel"
import type { LookPresetId } from "@arcade/kit/look"
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
  exposure: 1.04,
  skyFill: 0.88,
  moonFill: 0.98,
  lighting: 1.0,
  practicalWarmth: 0.88,
  porchPower: 0.62,
  windowPower: 0.76,
  roomPower: 0.78,
  streetPower: 0.96,
  lightFalloff: 1.15,
  flashlightHaze: 0.22,
  wetSpecular: 0.56,
  rimStrength: 0.72,
  vignetteDarkness: 0.34,
}

/** Preset lighting profiles so switching `@arcade/kit/look` presets in the Lab dials in the base lighting primitives too. */
export const OUTBREAK_LOOK_LIGHTING_PRESETS: Readonly<Record<LookPresetId, Partial<OutbreakLightingSettings>>> = {
  current: { ...DEFAULT_OUTBREAK_LIGHTING },
  sodium_70s: { ...DEFAULT_OUTBREAK_LIGHTING },
  noir: {
    exposure: 0.88,
    skyFill: 0.38,
    moonFill: 0.85,
    practicalWarmth: 0.32,
    porchPower: 0.38,
    windowPower: 0.42,
    roomPower: 0.50,
    streetPower: 0.15,
    lightFalloff: 1.45,
    flashlightHaze: 1.15,
    wetSpecular: 0.84,
    rimStrength: 0.95,
    vignetteDarkness: 0.78,
  },
  cinematic_dusk: {
    exposure: 0.96,
    skyFill: 0.68,
    moonFill: 0.95,
    practicalWarmth: 0.52,
    porchPower: 0.54,
    windowPower: 0.64,
    roomPower: 0.68,
    streetPower: 0.45,
    lightFalloff: 1.20,
    flashlightHaze: 0.65,
    wetSpecular: 0.62,
    rimStrength: 0.75,
    vignetteDarkness: 0.55,
  },
  painterly: {
    exposure: 1.12,
    skyFill: 1.15,
    moonFill: 1.15,
    practicalWarmth: 0.65,
    porchPower: 0.72,
    windowPower: 0.82,
    roomPower: 0.85,
    streetPower: 0.65,
    lightFalloff: 0.92,
    flashlightHaze: 0.35,
    wetSpecular: 0.25,
    rimStrength: 0.60,
    vignetteDarkness: 0.25,
  },
  cozy_golden_hour: {
    exposure: 1.10,
    skyFill: 1.08,
    moonFill: 1.25,
    practicalWarmth: 0.88,
    porchPower: 0.68,
    windowPower: 0.78,
    roomPower: 0.82,
    streetPower: 0.55,
    lightFalloff: 0.95,
    flashlightHaze: 0.40,
    wetSpecular: 0.35,
    rimStrength: 0.80,
    vignetteDarkness: 0.32,
  },
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
  const dirX = Math.cos(state.playerAim)
  const dirY = Math.sin(state.playerAim)
  const handX = state.playerX + dirX * 0.24
  const handY = state.playerY + dirY * 0.24
  const halfRad = (Math.max(18, Math.min(90, s.flashlightCone * 0.55)) * Math.PI) / 360

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
  out[17] = state.inInteriorView ? Math.min(s.flashlightRange, 5.2) : Math.min(s.flashlightRange, 9.5)
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
  castShadows: boolean
}

/**
 * Resolves 2100K high-pressure sodium streetlamps and warm 2500K-2700K tungsten porch/window/room practicals.
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
    // Route the two intersection/avenue streetlamp slots to the Ash House street corner (40.6, 42.4) & NE sidewalk (39.2, 24.6)
    let lx = lamp.x + 0.55
    let ly = lamp.y
    let lh = lamp.h
    let r = lamp.radius * 0.92 * invTight
    let pMult = 1.0
    if (lamp.x === 52 && lamp.y === 39) {
      lx = 40.6
      ly = 42.4
      lh = 3.65
      r = 6.8 * invTight
      pMult = 1.65
    } else if (lamp.x === 50 && lamp.y === 8) {
      lx = 39.2
      ly = 24.6
      lh = 3.65
      r = 6.8 * invTight
      pMult = 1.75
    }
    const power = master * lamp.power * s.streetPower * pMult
    // 2100K High-Pressure Sodium deep orange-gold (shadowless open-street pool for fast GPU evaluation)
    return {
      lx,
      lh,
      ly,
      r,
      rEff: r * 0.88,
      color: [1.0, 0.46 - 0.05 * w, 0.10 - 0.03 * w],
      power,
      fixtureBrightness: master * s.streetPower * 0.95,
      cone: [0, 0, 0, 0],
      softness: 0.22,
      castShadows: false,
    }
  }

  if (lamp.kind === "porch") {
    const interiorDim = inInteriorView ? 0.48 : 1.0
    const power = master * lamp.power * s.porchPower * interiorDim
    const r = lamp.radius * (inInteriorView ? 0.52 : 0.62) * invTight
    return {
      lx: lamp.x,
      lh: 2.24,
      ly: lamp.y - 0.14,
      r,
      rEff: r * 0.85,
      color: [1.0, 0.52 - 0.05 * w, 0.14 - 0.04 * w],
      power,
      fixtureBrightness: master * s.porchPower * interiorDim * 0.72,
      cone: [0, 0, 0, -1],
      softness: 0.18,
      castShadows: !inInteriorView,
    }
  }

  if (lamp.kind === "window") {
    const interiorDim = inInteriorView ? 0.48 : 1.0
    const power = master * lamp.power * s.windowPower * interiorDim
    const r = lamp.radius * 0.76 * invTight
    return {
      lx: lamp.x,
      lh: 1.42,
      ly: lamp.y + 0.06,
      r,
      rEff: r * 0.85,
      color: [1.0, 0.50 - 0.05 * w, 0.13 - 0.04 * w],
      power,
      fixtureBrightness: master * s.windowPower * interiorDim * 0.78,
      cone: [0, 1, -0.65, 1],
      softness: 0.20,
      castShadows: !inInteriorView,
    }
  }

  // Room practicals: selective choreography per room role inside each house
  const b = buildings.find(
    (bld) => lamp.x >= bld.rect[0] && lamp.x <= bld.rect[2] && lamp.y >= bld.rect[1] && lamp.y <= bld.rect[3],
  )
  let lx = lamp.x
  let ly = lamp.y
  let lh = lamp.h
  let rScale = 0.76
  let pScale = 0.62
  let fixtureScale = 0.65
  let castShadows = false
  let color: [number, number, number] = [1.0, 0.50 - 0.05 * w, 0.13 - 0.04 * w]

  if (b && b.kind === "house") {
    const relX = lamp.x - b.rect[0]
    const relY = lamp.y - b.rect[1]
    if (relX < 4.0 && relY < 3.0) {
      // #1 NW bedroom nightstand lamp: warm primary focal pool next to bed
      lx = b.rect[0] + 2.75
      ly = b.rect[1] + 1.25
      lh = 1.28
      rScale = 0.96
      pScale = 1.15
      fixtureScale = 1.25
      castShadows = true
      color = [1.0, 0.54 - 0.05 * w, 0.14 - 0.04 * w]
    } else if (relX > 4.0 && relY < 4.5) {
      // #4 NE bedroom dresser / rug fill
      lx = b.rect[0] + 6.85
      ly = b.rect[1] + 2.15
      lh = 1.55
      rScale = 0.68
      pScale = 0.42
      fixtureScale = 0.25
      color = [1.0, 0.48 - 0.04 * w, 0.12 - 0.03 * w]
    } else if (relX < 4.5 && relY >= 4.5) {
      // #2 SW living room: warm pool over Oriental rug & coffee table
      lx = b.rect[0] + 2.75
      ly = b.rect[3] - 2.35
      lh = 1.42
      rScale = 0.72
      pScale = 0.52
      fixtureScale = 0.25
      color = [1.0, 0.48 - 0.04 * w, 0.12 - 0.03 * w]
    } else {
      // #3 SE kitchen/dining: warm pool over kitchen sink counter & dining table
      lx = b.rect[2] - 3.35
      ly = b.rect[3] - 3.15
      lh = 1.68
      rScale = 0.86
      pScale = 0.88
      fixtureScale = 0.52
      color = [1.0, 0.52 - 0.05 * w, 0.14 - 0.04 * w]
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
    softness: 0.16,
    castShadows,
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

/**
 * Temperature-balanced twilight sky fill: smoothly transitions between cool steel-blue night (practicalWarmth -> 0)
 * and 1970s suburban warm olive-ochre-slate twilight (practicalWarmth -> 0.8) without crushing shadows.
 */
fn outbreakSkyAmbient(n: vec3f, rawSky: vec3f) -> vec3f {
  let w = clamp(OL.u0.z, 0.0, 1.0);
  let skyLum = dot(rawSky, vec3f(0.299, 0.587, 0.114));
  let suburbanSky = vec3f(skyLum) * vec3f(1.18, 0.90, 0.62);
  let sky = mix(rawSky, suburbanSky, w * 0.92);
  return mix(sky * 0.42, sky, n.y * 0.5 + 0.5);
}

/**
 * Albedo-multiplying indirect bounce & localized bulb halation for sodium streetlamps and tungsten practicals.
 * Multiplies surfCol (which already contains full procedural cracks, plank joints, rug motifs, and texture detail)
 * so light pools sharpen surface detail rather than washing it out with flat fog.
 */
fn applySceneLightBounceAndHaze(world: vec3f, n: vec3f, surfCol: vec3f, baseColor: vec3f, inRoom: bool, mat: i32) -> vec3f {
  var col = surfCol;
  let w = clamp(OL.u0.z, 0.0, 1.0);
  let isInView = OL.u5.w > 0.5;
  let groundMask = smoothstep(2.6, 0.35, world.y) * select(1.0, 0.22, mat == 22 && world.y > 0.85);
  let grit = 0.72 + 0.56 * surfaceNoise(world.xz * 6.5 + vec2f(1.9, 4.3));
  let texAlbedo = (surfCol * 1.45 + baseColor * 0.22 * grit);

  if (!inRoom) {
    // 1. High-pressure sodium streetlamp (2100K) albedo-multiplying ground pool + tight bulb halation
    let sScale = OL.u1.w;
    if (sScale > 0.001) {
      let sPos = select(vec2f(41.2, 42.4), vec2f(39.0, 25.0), isInView);
      let dvS = (world.xz - sPos) * select(vec2f(0.85, 0.90), vec2f(1.10, 0.44), isInView);
      let dS2 = dot(dvS, dvS);
      if (dS2 < 95.0) {
        let sodiumCol = vec3f(1.0, 0.40, 0.06);
        let poolS = exp(-dS2 / select(20.0, 28.0, isInView)) * groundMask;
        let rawD2 = dot(world.xz - sPos, world.xz - sPos);
        let bulbCore = exp(-rawD2 / 0.65) * select(0.09, 0.14, isInView) * step(world.y, 0.55);
        col += texAlbedo * sodiumCol * poolS * select(1.35, 2.85, isInView) * sScale + sodiumCol * bulbCore * sScale;
      }
    }

    // 2. Warm 2500K tungsten window & porch bounce across the front yard, shrubs, and sidewalk
    let pScale = OL.u1.x;
    let wScale = OL.u1.y;
    if ((pScale > 0.001 || wScale > 0.001) && world.z > 34.8 && world.z < 50.0 && world.x > 16.5 && world.x < 40.5) {
      let dWinL2 = dot((world.xz - vec2f(24.5, 36.8)) * vec2f(0.75, 0.65), (world.xz - vec2f(24.5, 36.8)) * vec2f(0.75, 0.65));
      let dWinR2 = dot((world.xz - vec2f(34.25, 36.8)) * vec2f(0.75, 0.65), (world.xz - vec2f(34.25, 36.8)) * vec2f(0.75, 0.65));
      let dPorch2 = dot((world.xz - vec2f(27.7, 37.8)) * vec2f(0.68, 0.52), (world.xz - vec2f(27.7, 37.8)) * vec2f(0.68, 0.52));
      let cutZoneScale = select(0.88, select(0.52, 1.08, world.z > 38.0), isInView);
      let spill = ((exp(-dWinL2 / 14.0) + exp(-dWinR2 / 14.0)) * wScale * 0.68 + exp(-dPorch2 / 16.0) * pScale * 0.78) * cutZoneScale * groundMask;
      col += texAlbedo * vec3f(1.0, 0.44, 0.07) * spill * w;
    }

    // 3. Warm golden-amber porch/lantern road pool around the survivor on the street (z = 40.0..46.0)
    let dp = world.xz - vec2f(OL.u6.x, OL.u6.y + 0.85);
    let dp2 = dot(dp * vec2f(0.60, 0.76), dp * vec2f(0.60, 0.76));
    if (!isInView && dp2 < 26.0 && world.y < 0.45 && world.z > 39.9) {
      let pPool = exp(-dp2 / 7.8);
      col += texAlbedo * vec3f(1.0, 0.48, 0.11) * pPool * 1.15 * (0.4 + 0.6 * w);
    }
  } else if (world.y < 2.72) {
    // Interior indirect room bounce & wall-wash halos (albedo-multiplying so wood planks, rugs & tiles retain full texture contrast)
    let roomScale = OL.u1.z;
    if (roomScale > 0.001) {
      let warmTungsten = vec3f(1.0, 0.42, 0.07);
      // NW Bedroom bedside lamp wall wash & bed/rug bounce
      let vNW = (world.xz - vec2f(25.1, 25.4)) * vec2f(0.66, 0.74);
      let dNW2 = dot(vNW, vNW);
      if (dNW2 < 18.0) {
        let nwPool = exp(-dNW2 / 4.8);
        let wallBoost = select(0.55, 1.35, abs(n.y) < 0.45 && world.z < 26.8);
        col += (surfCol * 1.45 + vec3f(0.011, 0.0042, 0.0006)) * warmTungsten * nwPool * wallBoost * roomScale;
      }

      // NE Bedroom dresser & rug bounce
      let vNE = (world.xz - vec2f(29.0, 26.2)) * vec2f(0.70, 0.76);
      let dNE2 = dot(vNE, vNE);
      if (dNE2 < 15.0) {
        let nePool = exp(-dNE2 / 4.4);
        let wallBoost = select(0.48, 1.05, abs(n.y) < 0.45 && world.z < 26.2);
        col += (surfCol * 1.15 + vec3f(0.0055, 0.0022, 0.0003)) * warmTungsten * nePool * wallBoost * roomScale;
      }

      // SE Kitchen north sink-window glow (33.5, 30.0) and warm tile/dining bounce
      let vSink = (world.xz - vec2f(33.4, 30.1)) * vec2f(0.66, 0.76);
      let dSink2 = dot(vSink, vSink);
      if (dSink2 < 20.0) {
        let sinkPool = exp(-dSink2 / 4.8);
        let sinkWinBoost = select(0.55, 1.45, abs(n.y) < 0.45 && world.z < 30.4 && world.y > 0.85);
        col += (surfCol * 1.35 + vec3f(0.010, 0.0040, 0.0006)) * warmTungsten * sinkPool * sinkWinBoost * roomScale;
      }
      let vDin = (world.xz - vec2f(33.8, 32.8)) * vec2f(0.60, 0.64);
      let dDin2 = dot(vDin, vDin);
      if (dDin2 < 20.0) {
        let dinPool = exp(-dDin2 / 5.2);
        col += (surfCol * 1.25 + vec3f(0.008, 0.0032, 0.0005)) * warmTungsten * dinPool * roomScale;
      }

      // SW Living room Oriental rug & coffee table warm bounce
      let vSW = (world.xz - vec2f(25.0, 32.8)) * vec2f(0.64, 0.64);
      let dSW2 = dot(vSW, vSW);
      if (dSW2 < 16.0) {
        let swPool = exp(-dSW2 / 4.5);
        col += (surfCol * 0.95 + vec3f(0.0048, 0.0019, 0.0003)) * warmTungsten * swPool * roomScale;
      }

      // Central hallway warm walnut floorboard bounce
      let vHall = (world.xz - vec2f(28.2, 32.6)) * vec2f(0.66, 0.56);
      let dHall2 = dot(vHall, vHall);
      if (dHall2 < 16.0) {
        let hallPool = exp(-dHall2 / 4.8);
        col += (surfCol * 1.25 + vec3f(0.0072, 0.0028, 0.0005)) * warmTungsten * hallPool * roomScale;
      }
    }
  }
  return col;
}

/**
 * Forward-aimed volumetric flashlight mist scatter & ground specular response.
 */
fn evalFlashlightBeam(world: vec3f, n: vec3f, baseAlbedo: vec3f, inRoom: bool, mat: i32) -> vec3f {
  if (OL.u4.z <= 0.001 || OL.u4.w < 0.5 || OL.u2.x <= 0.01) { return vec3f(0.0); }
  let fSlot = u32(round(OL.u4.w));
  let fOrig = OL.u3.xy;
  let fDir = OL.u3.zw;
  let fSide = vec2f(-fDir.y, fDir.x);
  let rel = world.xz - fOrig;
  let along = dot(rel, fDir);
  let across = abs(dot(rel, fSide));
  let tanHalf = max(0.12, OL.u4.x);
  let fRange = max(2.8, OL.u4.y);
  let coneR = 0.12 + max(0.0, along) * tanHalf;
  if (along < -0.15 || along > fRange || across > coneR * 1.35 || world.y > 1.75) {
    return vec3f(0.0);
  }
  if (mat == 12 && length(world.xz - OL.u6.xy) < 0.55) {
    return vec3f(0.0);
  }
  let radial = exp(-pow(across / (coneR * 0.68), 2.0)) * (1.0 - smoothstep(coneR * 0.65, coneR * 1.28, across));
  let axial = smoothstep(-0.05, 0.20, along) * pow(clamp(1.0 - along / fRange, 0.0, 1.0), 1.4);
  let profile = radial * axial;
  if (profile <= 0.01) { return vec3f(0.0); }

  let vis = shadowAt(fSlot, fOrig, lights[fSlot].pos.y, 0.05, world.xz + n.xz * 0.03, min(world.y, 1.05));
  if (vis <= 0.001) { return vec3f(0.0); }

  let surfW = select(0.12 * max(0.0, dot(n.xz, -fDir)), 1.0, world.y < 0.25 && n.y > 0.7);
  let beamCol = vec3f(1.0, 0.62, 0.24);
  let mist = profile / (0.55 + max(0.0, along) * 0.32) * OL.u2.x * 0.14 * surfW;
  return (baseAlbedo * 0.75 + beamCol * 0.06) * beamCol * OL.u4.z * mist * vis;
}
`
