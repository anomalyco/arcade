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
  const beamAngle = isNorthRestPose ? (state.inInteriorView ? 1.80 : 1.98) : state.playerAim
  const dirX = Math.cos(beamAngle)
  const dirY = Math.sin(beamAngle)
  const handX = state.playerX + (isNorthRestPose ? (state.inInteriorView ? -0.06 : -0.22) : dirX * 0.24)
  const handY = state.playerY + (isNorthRestPose ? (state.inInteriorView ? 0.22 : 0.28) : dirY * 0.24)
  const halfRad = (Math.max(18, Math.min(90, s.flashlightCone * (state.inInteriorView ? 0.50 : 0.64))) * Math.PI) / 360

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
  out[17] = state.inInteriorView ? Math.min(s.flashlightRange, 4.3) : Math.min(s.flashlightRange, 8.6)
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
      castShadows: true,
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
      castShadows: true,
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
  let rScale = 0.72
  let pScale = 0.65
  let fixtureScale = 0.65
  let castShadows = false
  let color: [number, number, number] = [1.0, 0.56 - 0.08 * w, 0.20 - 0.06 * w]

  if (b && b.kind === "house") {
    const relX = lamp.x - b.rect[0]
    const relY = lamp.y - b.rect[1]
    if (relX < 4.0 && relY < 3.0) {
      // #1 NW bedroom nightstand lamp: warm primary focal pool next to bed
      lx = b.rect[0] + 2.75
      ly = b.rect[1] + 1.25
      lh = 1.26
      rScale = 0.98
      pScale = 1.28
      fixtureScale = 1.20
      castShadows = true
      color = [1.0, 0.62 - 0.05 * w, 0.24 - 0.05 * w]
    } else if (relX > 4.0 && relY < 4.5) {
      // #4 NE bedroom dresser candle/accent: warm pool over dresser & north-east rug
      lx = b.rect[0] + 7.35
      ly = b.rect[1] + 1.35
      lh = 1.38
      rScale = 0.64
      pScale = 0.68
      fixtureScale = 0.35
      color = [1.0, 0.56 - 0.05 * w, 0.18 - 0.04 * w]
    } else if (relX < 4.5 && relY >= 4.5) {
      // #2 SW living room: warm candle pool on the coffee table (x+2.7, b-2.2)
      lx = b.rect[0] + 2.7
      ly = b.rect[3] - 2.2
      lh = 1.05
      rScale = 0.56
      pScale = 0.46
      fixtureScale = 0.15
      color = [1.0, 0.50 - 0.05 * w, 0.15 - 0.04 * w]
    } else {
      // #3 SE kitchen/dining: warm pool over the wooden dining table (r-3.2, b-2.6)
      lx = b.rect[2] - 3.15
      ly = b.rect[3] - 2.65
      lh = 1.42
      rScale = 0.60
      pScale = 0.52
      fixtureScale = 0.18
      color = [1.0, 0.52 - 0.05 * w, 0.16 - 0.04 * w]
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

fn evalFlashlightBeam(world: vec3f, n: vec3f, baseAlbedo: vec3f, inRoom: bool, mat: i32) -> vec3f {
  if (OL.u4.z <= 0.001 || OL.u4.w < 0.5) { return vec3f(0.0); }
  let fSlot = u32(round(OL.u4.w));
  let fOrig = OL.u3.xy;
  let fDir = OL.u3.zw;
  let fSide = vec2f(-fDir.y, fDir.x);
  let rel = world.xz - fOrig;
  let along = dot(rel, fDir);
  let across = abs(dot(rel, fSide));
  let tanHalf = max(0.12, OL.u4.x);
  let fRange = max(2.8, OL.u4.y);
  if (along < -0.22 || along > fRange || across > (0.28 + max(0.0, along) * tanHalf * 1.85) || world.y > 1.75) {
    return vec3f(0.0);
  }

  // Crisp neutral-cool white-halogen beam colour (5200K-5600K)
  let beamTint = mix(vec3f(0.94, 0.95, 0.98), OL.u5.xyz, 0.16);
  let hazeAmt = OL.u2.x;
  let wetAmt = OL.u2.y;
  let fPower = OL.u4.z * 2.25;

  // On the player's own body (within 0.55m of player XY), only illuminate a tiny point at the left hand
  if (mat == 12) {
    let dPlayer = length(world.xz - OL.u6.xy);
    if (dPlayer < 0.55) {
      let handPos3 = vec3f(fOrig.x, OL.u6.z + 0.92, fOrig.y);
      let dHand3 = length(world - handPos3);
      return beamTint * fPower * exp(-(dHand3 * dHand3) / 0.012) * 1.35;
    }
  }

  let coneR = 0.09 + max(0.0, along) * tanHalf;
  let radialCore = exp(-pow(across / (coneR * select(0.58, 0.48, inRoom)), 2.0));
  let radialAura = exp(-pow(across / (coneR * select(1.12, 0.88, inRoom)), 1.55)) * (1.0 - smoothstep(coneR * 0.82, coneR * 1.65, across));
  let radialEdge = 1.0 - smoothstep(coneR * 0.62, coneR * 1.32, across);
  let axialIn = smoothstep(-0.08, 0.16, along);
  let axialOut = pow(clamp(1.0 - along / fRange, 0.0, 1.0), select(1.32, 1.38, inRoom));
  let vis = shadowAt(fSlot, fOrig, lights[fSlot].pos.y, 0.045, world.xz + n.xz * 0.03, min(world.y, 1.05));
  if (vis <= 0.001) { return vec3f(0.0); }

  // Suppress volumetric mist on vertical partition walls & doors so the beam doesn't paint a bright bar beside the player
  let isTrueFloor = world.y < 0.165 && n.y > 0.75;
  let surfWeight = select(0.0, 1.0, isTrueFloor || mat == 12);

  // 1. Tight ground/air origin point right under the hand
  let d2Orig = dot(rel, rel);
  let handOriginGlow = exp(-d2Orig / 0.024) * 1.15 * step(world.y, 0.20) * surfWeight;

  // 2. Volumetric air mist cone scatter
  let airNoise = 0.84 + 0.32 * surfaceNoise(world.xz * 2.4 + vec2f(1.3, 4.7));
  let mist = (radialCore * radialEdge * 0.72 + radialAura * 0.38) * axialIn * axialOut / (0.38 + max(0.0, along) * 0.22) * airNoise * surfWeight;
  var add = beamTint * fPower * (mist * hazeAmt * select(0.30, 0.26, inRoom) + handOriginGlow);

  // 3. Tilted flashlight beam striking wet road asphalt / damp interior floorboards
  if (isTrueFloor) {
    let grit = 0.48 + 1.05 * (surfaceNoise(world.xz * 5.6 + vec2f(1.7, 3.9)) * 0.58 + surfaceNoise(world.xz * 16.0) * 0.42);
    let strikePeak = select(
      exp(-pow((along - 2.65) / 2.25, 2.0)) * 1.18 + 0.42,
      exp(-pow((along - 1.55) / 1.25, 2.0)) * 1.32 + 0.46,
      inRoom
    );
    var groundSpot = (radialCore * radialEdge + radialAura * 0.34) * axialIn * axialOut * strikePeak / (0.28 + max(0.0, along) * 0.14 + along * along * 0.016) * grit;
    if (inRoom) {
      let plankSeam = 0.36 + 0.64 * smoothstep(0.0, 0.075, abs(fract(world.z / 0.165 + 0.5) - 0.5));
      groundSpot *= plankSeam;
    }
    let specTint = select(vec3f(0.95, 0.92, 0.84), vec3f(0.90, 0.94, 0.95), inRoom);
    add += (baseAlbedo * 1.80 + specTint * 0.155 * wetAmt) * fPower * groundSpot * select(1.18, 1.42, inRoom);
  }
  return add * vis;
}

fn evalInteriorWallWash(world: vec3f, n: vec3f, baseAlbedo: vec3f) -> vec3f {
  // Fast analytical linear-HDR warm wall-wash & indirect bounce (zero extra noise fetches)
  let roomScale = OL.u1.z;
  if (roomScale <= 0.001) { return vec3f(0.0); }
  var add = vec3f(0.0);

  // 1. NW Bedroom bedside lamp wall wash (north & west walls around x=24.6, z=24.2..26.5) + warm bed/floor bounce
  let vNW = (world.xz - vec2f(25.2, 25.4)) * vec2f(0.72, 0.82);
  let dNW2 = dot(vNW, vNW);
  if (dNW2 < 16.0) {
    let nwPool = exp(-dNW2 / 4.2);
    let wallBoost = select(0.58, 1.55, abs(n.y) < 0.45 && world.z < 26.8);
    add += (baseAlbedo * 0.072 + vec3f(0.018, 0.010, 0.0036)) * nwPool * wallBoost * roomScale;
  }

  // 2. NE Bedroom dresser candle wall wash (around x=29.5, z=24.8)
  let vNE = (world.xz - vec2f(29.4, 25.2)) * vec2f(0.82, 0.88);
  let dNE2 = dot(vNE, vNE);
  if (dNE2 < 12.0) {
    let nePool = exp(-dNE2 / 3.4);
    let wallBoost = select(0.52, 1.42, abs(n.y) < 0.45 && world.z < 26.2);
    add += (baseAlbedo * 0.056 + vec3f(0.012, 0.0072, 0.0028)) * nePool * wallBoost * roomScale;
  }

  // 3. East kitchen window warm sill & counter spill (around x=36.6, z=28.0..30.6) + dining table bounce
  let vEW = (world.xz - vec2f(36.4, 29.2)) * vec2f(0.65, 0.70);
  let dEW2 = dot(vEW, vEW);
  if (dEW2 < 16.0) {
    let winSpill = exp(-dEW2 / 3.8) * smoothstep(2.4, 0.1, world.y);
    add += (baseAlbedo * 0.058 + vec3f(0.0105, 0.0064, 0.0028)) * winSpill * roomScale;
  }
  let vDin = (world.xz - vec2f(33.6, 32.5)) * vec2f(0.70, 0.70);
  let dDin2 = dot(vDin, vDin);
  if (dDin2 < 12.0) {
    let dinPool = exp(-dDin2 / 3.6);
    add += (baseAlbedo * 0.052 + vec3f(0.0082, 0.0050, 0.0024)) * dinPool * roomScale;
  }

  // 4. SW Living room coffee table warm bounce (around x=24.7, z=33.3)
  let vSW = (world.xz - vec2f(24.7, 33.1)) * vec2f(0.72, 0.72);
  let dSW2 = dot(vSW, vSW);
  if (dSW2 < 11.0) {
    let swPool = exp(-dSW2 / 3.2);
    add += (baseAlbedo * 0.045 + vec3f(0.0062, 0.0038, 0.0018)) * swPool * roomScale;
  }
  return add;
}
`
