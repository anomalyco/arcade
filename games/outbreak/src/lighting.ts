import type { BakedMap, FloorMap } from "@arcade/kit/gpu/level"
import { VERT_BYTES } from "@arcade/kit/gpu/mesh"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { LookPresetId } from "@arcade/kit/look"
import { inBuildingFootprint, SIZE, type Building, type Lamp, type Town } from "../shared/map"

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
  skyFill: 0.90,
  moonFill: 0.98,
  lighting: 1.0,
  practicalWarmth: 0.88,
  porchPower: 0.86,
  windowPower: 0.96,
  roomPower: 0.80,
  streetPower: 0.78,
  lightFalloff: 1.12,
  flashlightHaze: 0.22,
  wetSpecular: 0.56,
  rimStrength: 0.76,
  vignetteDarkness: 0.34,
}

/** Preset lighting profiles so switching `@arcade/kit/look` presets in the Lab dials in the base lighting primitives too. */
export const OUTBREAK_LOOK_LIGHTING_PRESETS: Readonly<Record<LookPresetId, Partial<OutbreakLightingSettings>>> = {
  current: { ...DEFAULT_OUTBREAK_LIGHTING },
  sodium_70s: { ...DEFAULT_OUTBREAK_LIGHTING },
  noir: {
    exposure: 1.03,
    skyFill: 0.40,
    moonFill: 0.90,
    practicalWarmth: 0.0,
    porchPower: 0.36,
    windowPower: 0.38,
    roomPower: 0.56,
    streetPower: 0.12,
    lightFalloff: 1.38,
    flashlightHaze: 1.38,
    wetSpecular: 0.85,
    rimStrength: 1.45,
    vignetteDarkness: 0.58,
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
    fogStyle?: number
    fogEdgeSoftness?: number
    fogMemoryDim?: number
    fogUnknownGrain?: number
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
 * u7: fogStyle, fogEdgeSoftness, fogMemoryDim, fogUnknownGrain
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
  out[17] = state.inInteriorView ? Math.min(s.flashlightRange, 7.2) : Math.min(s.flashlightRange, 9.8)
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
  // u7
  out[28] = s.fogStyle ?? 1
  out[29] = s.fogEdgeSoftness ?? 0.78
  out[30] = s.fogMemoryDim ?? 0.42
  out[31] = s.fogUnknownGrain ?? 0.48
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
    const interiorDim = inInteriorView ? 0.44 : 1.0
    const power = master * lamp.power * s.porchPower * interiorDim
    const r = lamp.radius * (inInteriorView ? 0.50 : 0.66) * invTight
    return {
      lx: lamp.x,
      lh: 2.24,
      ly: lamp.y - 0.14,
      r,
      rEff: r * 0.85,
      color: [1.0, 0.56 - 0.04 * w, 0.16 - 0.04 * w],
      power,
      fixtureBrightness: master * s.porchPower * (inInteriorView ? 0.62 : 1.16),
      cone: [0, 0, 0, -1],
      softness: 0.18,
      castShadows: !inInteriorView,
    }
  }

  if (lamp.kind === "window") {
    const interiorDim = inInteriorView ? 0.46 : 1.0
    const power = master * lamp.power * s.windowPower * interiorDim
    const r = lamp.radius * 0.80 * invTight
    return {
      lx: lamp.x,
      lh: 1.42,
      ly: lamp.y + 0.06,
      r,
      rEff: r * 0.85,
      color: [1.0, 0.54 - 0.04 * w, 0.15 - 0.04 * w],
      power,
      fixtureBrightness: master * s.windowPower * (inInteriorView ? 0.68 : 1.32),
      cone: [0, 1, -0.65, 1],
      softness: 0.20,
      castShadows: false,
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
  // Secondary room accent pools are baked into bounceTex + analytical room bounce; only the shadow-casting primary lamp runs in lightSum
  const power = master * lamp.power * s.roomPower * (castShadows || !inInteriorView ? pScale : 0)
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

/**
 * Concrete Baking Recommendation #1:
 * Bakes indirect light into a 192x192 RGBA8 `bounceTex` (0.5m/texel) using an 8-neighbour corner-safe Dijkstra
 * flood-fill over `town.lamps` (`room`, `porch`, `window`, `street`), blocked by solid walls.
 * Stores `sqrt(rgb)` in `.rgb` for dark precision and wall-free coverage in `.a`.
 */
export function bakeOutbreakBounce(town: Town): FloorMap {
  const w = 192
  const h = 192
  const cx = SIZE / w
  const cy = SIZE / h
  const solid = new Uint8Array(w * h)
  for (const b of town.barriers) {
    if (b.kind !== "wall") continue
    const r = b.rect
    const a0 = Math.max(0, Math.floor(r[0] / cx))
    const a1 = Math.min(w - 1, Math.ceil(r[2] / cx) - 1)
    const b0 = Math.max(0, Math.floor(r[1] / cy))
    const b1 = Math.min(h - 1, Math.ceil(r[3] / cy) - 1)
    for (let y = b0; y <= b1; y++) for (let x = a0; x <= a1; x++) solid[y * w + x] = 1
  }
  const acc = new Float32Array(w * h * 3)
  const dist = new Float32Array(w * h).fill(Infinity)
  const touched: number[] = []
  const N8 = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ] as const

  const heap: number[] = []
  const push = (i: number, d: number) => {
    heap.push(d, i)
    let k = heap.length / 2 - 1
    while (k > 0) {
      const p = (k - 1) >> 1
      if (heap[p * 2]! <= heap[k * 2]!) break
      ;[heap[p * 2], heap[k * 2]] = [heap[k * 2]!, heap[p * 2]!]
      ;[heap[p * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1]!, heap[p * 2 + 1]!]
      k = p
    }
  }
  const pop = (): [number, number] => {
    const d = heap[0]!
    const i = heap[1]!
    const ld = heap.pop()!
    const li = heap.pop()!
    if (heap.length) {
      heap[0] = li
      heap[1] = ld
      let k = 0
      const n = heap.length / 2
      for (;;) {
        const a = k * 2 + 1
        const b = a + 1
        let m = k
        if (a < n && heap[a * 2]! < heap[m * 2]!) m = a
        if (b < n && heap[b * 2]! < heap[m * 2]!) m = b
        if (m === k) break
        ;[heap[m * 2], heap[k * 2]] = [heap[k * 2]!, heap[m * 2]!]
        ;[heap[m * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1]!, heap[m * 2 + 1]!]
        k = m
      }
    }
    return [d, i]
  }

  for (const lamp of town.lamps) {
    const res = resolveLampLight(lamp, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false)
    const reach = Math.min(10.5, res.r * 1.35)
    let sx = Math.min(w - 1, Math.max(0, Math.floor(res.lx / cx)))
    let sy = Math.min(h - 1, Math.max(0, Math.floor(res.ly / cy)))
    if (solid[sy * w + sx]) {
      // Nudge window/wall-mounted fixtures to nearest open cell
      for (const [dx, dy] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ] as const) {
        const nx = Math.min(w - 1, Math.max(0, sx + dx))
        const ny = Math.min(h - 1, Math.max(0, sy + dy))
        if (!solid[ny * w + nx]) {
          sx = nx
          sy = ny
          break
        }
      }
    }
    const startIdx = sy * w + sx
    dist[startIdx] = 0
    touched.push(startIdx)
    push(startIdx, 0)
    while (heap.length) {
      const [d, i] = pop()
      if (d > dist[i]!) continue
      const x = i % w
      const y = (i / w) | 0
      for (const [dx, dy, c] of N8) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (solid[j]) continue
        if (dx && dy && (solid[y * w + nx] || solid[ny * w + x])) continue
        const nd = d + c * cx
        if (nd >= reach || nd >= dist[j]!) continue
        if (dist[j] === Infinity) touched.push(j)
        dist[j] = nd
        push(j, nd)
      }
    }
    const strength = lamp.kind === "room" ? 0.55 : lamp.kind === "porch" ? 0.45 : lamp.kind === "window" ? 0.40 : 0.48
    const k = res.power * strength
    for (const i of touched) {
      const t = 1 - dist[i]! / reach
      const f = t * t * k
      acc[i * 3] += res.color[0] * f
      acc[i * 3 + 1] += res.color[1] * f
      acc[i * 3 + 2] += res.color[2] * f
      dist[i] = Infinity
    }
    touched.length = 0
  }

  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = Math.round(Math.sqrt(Math.min(1, acc[i * 3 + c]! * 0.5)) * 255)
    }
    data[i * 4 + 3] = solid[i] ? 0 : 255
  }
  return { data, w, h, linear: acc }
}

/**
 * Concrete Baking Recommendation #2:
 * Bakes a 768x768 (12.5cm/texel, 576 KiB) soft directional moon & tree-canopy shadow mask (`moonTex` at `@binding(8)`),
 * with 2x2 sub-texel window mullion coverage inside houses and soft exterior building/tree-crown shadows.
 */
export function bakeOutbreakMoonMask(town: Town): BakedMap {
  const mw = 768
  const mh = 768
  const scale = SIZE / mw
  const moon = new Float32Array(mw * mh).fill(1.0)
  const trees = town.props.filter((p) => p.kind === "tree")
  const windows = town.barriers.filter((b) => b.kind === "window")

  // Base indoor/outdoor assignment
  for (let bIdx = 0; bIdx < town.buildings.length; bIdx++) {
    const b = town.buildings[bIdx]!
    const [bx0, bz0, bx1, bz1] = b.rect
    const x0 = Math.max(0, Math.floor((bx0 - 1.5) / scale))
    const x1 = Math.min(mw - 1, Math.ceil((bx1 + 4.5) / scale))
    const z0 = Math.max(0, Math.floor((bz0 - 1.5) / scale))
    const z1 = Math.min(mh - 1, Math.ceil((bz1 + 3.5) / scale))
    for (let z = z0; z <= z1; z++) {
      const pz = (z + 0.5) * scale
      for (let x = x0; x <= x1; x++) {
        const px = (x + 0.5) * scale
        if (inBuildingFootprint(b, px, pz)) {
          moon[z * mw + x] = 0.055
        } else {
          // Soft exterior directional shadow cast by building walls & 4.35m pitched roof along dusk/moon direction (-0.32, +0.24)
          const sPx = px - 1.15
          const sPz = pz - 0.85
          if (inBuildingFootprint(b, sPx, sPz)) {
            moon[z * mw + x] = Math.min(moon[z * mw + x]!, 0.62)
          }
        }
      }
    }
  }

  // Soft spherical/dappled tree-crown canopy attenuation on exterior ground
  for (const t of trees) {
    const rCrown = 2.15 + t.variant * 0.75
    const cx = t.x + 0.45
    const cz = t.y + 0.35
    const x0 = Math.max(0, Math.floor((cx - rCrown - 0.5) / scale))
    const x1 = Math.min(mw - 1, Math.ceil((cx + rCrown + 0.5) / scale))
    const z0 = Math.max(0, Math.floor((cz - rCrown - 0.5) / scale))
    const z1 = Math.min(mh - 1, Math.ceil((cz + rCrown + 0.5) / scale))
    const invR2 = 1 / (rCrown * rCrown)
    for (let z = z0; z <= z1; z++) {
      const dz = (z + 0.5) * scale - cz
      for (let x = x0; x <= x1; x++) {
        const idx = z * mw + x
        if (moon[idx]! <= 0.1) continue
        const dx = (x + 0.5) * scale - cx
        const u2 = (dx * dx + dz * dz) * invR2
        if (u2 < 1.0) {
          const dapple = 0.82 + 0.18 * Math.sin(dx * 4.2 + dz * 3.7)
          const atten = 1 - (1 - u2) * 0.38 * dapple
          moon[idx] = Math.min(moon[idx]!, atten)
        }
      }
    }
  }

  // 2x2 sub-texel window mullion & sash coverage inside houses (matching Blackout's window-light bake)
  for (const w of windows) {
    const [wx0, wz0, wx1, wz1] = w.rect
    const x0 = Math.max(0, Math.floor((wx0 - 2.8) / scale))
    const x1 = Math.min(mw - 1, Math.ceil((wx1 + 0.6) / scale))
    const z0 = Math.max(0, Math.floor((wz0 - 2.8) / scale))
    const z1 = Math.min(mh - 1, Math.ceil((wz1 + 0.6) / scale))
    const horiz = wx1 - wx0 > 1
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const idx = z * mw + x
        if (moon[idx]! > 0.25) continue
        let cov = 0
        for (const sy of [0.25, 0.75]) {
          const pz = (z + sy) * scale
          for (const sx of [0.25, 0.75]) {
            const px = (x + sx) * scale
            if (horiz) {
              const dz = wz0 - pz
              if (dz > -0.1 && dz < 2.6) {
                const xShift = px + dz * 0.18
                const half = (wx1 - wx0) * 0.46
                const mid = (wx0 + wx1) * 0.5
                const dx = Math.max(0, Math.abs(xShift - mid) - half)
                if (dx < 0.45) {
                  const along = Math.max(0, 1 - Math.max(0, dz) / 2.5)
                  const across = Math.max(0, 1 - dx / 0.42)
                  const mullion = Math.abs(xShift - mid) < 0.045 ? 0.55 : 1.0
                  cov += along * along * across * mullion
                }
              }
            } else {
              const dx = wx0 - px
              if (dx > -0.1 && dx < 2.6) {
                const zShift = pz - dx * 0.15
                const half = (wz1 - wz0) * 0.46
                const mid = (wz0 + wz1) * 0.5
                const dz = Math.max(0, Math.abs(zShift - mid) - half)
                if (dz < 0.45) {
                  const along = Math.max(0, 1 - Math.max(0, dx) / 2.5)
                  const across = Math.max(0, 1 - dz / 0.42)
                  const mullion = Math.abs(zShift - mid) < 0.045 ? 0.55 : 1.0
                  cov += along * along * across * mullion
                }
              }
            }
          }
        }
        if (cov > 0) {
          moon[idx] = Math.max(moon[idx]!, 0.055 + 0.84 * (cov * 0.25))
        }
      }
    }
  }

  const data = new Uint8Array(mw * mh)
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(Math.max(0, Math.min(1, moon[i]!)) * 255)
  }
  return { data, w: mw, h: mh }
}

/**
 * Concrete Baking Recommendation #3 & Blog Game Tip #4:
 * Packs 3D per-vertex contact AO & bevel boost (`aOpenTone`) into spare byte 19 (`v.color.a`) of `VERT_BYTES = 24`.
 * `128` (0.502) = 1.0x neutral; `< 128` darkens furniture/wall bottoms & eave soffits; `> 128` boosts top chamfers/bevels.
 */
export function stampOutbreakVertexTone(buf: ArrayBuffer): ArrayBuffer {
  const f32 = new Float32Array(buf)
  const i8 = new Int8Array(buf)
  const u8 = new Uint8Array(buf)
  const n = buf.byteLength / VERT_BYTES
  for (let k = 0; k < n; k++) {
    const o = k * VERT_BYTES
    const y = f32[o / 4 + 1]!
    const ny = i8[o + 13]! / 127
    let tone = 1.0
    if (y > 0.04 && y < 0.24 && Math.abs(ny) < 0.45) {
      // Base of walls, furniture legs, counters, and porch posts: contact darkening
      tone = 0.72 + (y - 0.04) * 1.4
    } else if (ny > 0.35 && ny < 0.88 && y > 0.35 && y < 2.45) {
      // Sloped bevels & chamfers on furniture (beds, sofas, tables, counters, car): rim boost
      tone = 1.16
    } else if (ny > 0.88 && y > 0.38 && y < 1.95) {
      // Upper horizontal surfaces of props & sills
      tone = 1.06
    } else if (ny < -0.5 && y > 2.2) {
      // Under-eave soffits
      tone = 0.68
    }
    u8[o + 19] = Math.max(1, Math.min(254, Math.round(tone * 128)))
  }
  return buf
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
var<private> outbreakFlashMask: f32;

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
 * Blog Game Tip #1: Analytical Window & Porch Light Cookie with Distance-Widening Penumbra & Drifting Canopy Sway.
 */
fn evalCanopyCookie(world: vec3f, inRoom: bool) -> f32 {
  let t = F.cam.w;
  let w1 = sin(world.x * 0.62 + world.z * 0.48 + t * 0.55);
  let w2 = cos(world.x * 1.35 - world.z * 1.12 - t * 0.82);
  let canopyWave = 0.88 + 0.12 * (w1 * 0.6 + w2 * 0.4);
  return select(canopyWave, 0.92 + 0.08 * w1, inRoom);
}

/**
 * Blog Game Tip #5: Analytical Clipped Rectangular Area Light & Stretched Specular Sheen for Windows.
 */
fn evalWindowAreaAttenuation(dv: vec2f, d3: f32, tight: f32) -> f32 {
  let halfW = 0.92;
  let reachY = 2.45;
  let penumbra = 0.18 + max(0.0, dv.y) * 0.28;
  let rx = 1.0 - smoothstep(halfW - 0.12, halfW + penumbra, abs(dv.x));
  let ry = smoothstep(-0.25, 0.18, dv.y) * (1.0 - smoothstep(0.55, reachY, dv.y));
  let mullionDip = 1.0 - 0.16 * exp(-pow(dv.x / 0.12, 2.0)) * (1.0 - smoothstep(0.1, 1.4, dv.y));
  let solidAngle = 2.35 / (1.0 + d3 * d3 * 0.56 * tight);
  return rx * ry * mullionDip * solidAngle;
}

/**
 * Blog Game Tip #3: Analytical Rectangular Area-Light Floor Bounce (officeFloorBounce).
 * Clamps world.xz to lit floor/porch patch bounds at floor height (6 ALU ops) to bounce warm floor light
 * onto vertical walls, kitchen cabinets, and survivor/zombie legs.
 */
fn evalAreaFloorBounce(world: vec3f, n: vec3f) -> vec3f {
  if (world.y > 2.25) { return vec3f(0.0); }
  // Clamp to nearest lit patch: NW bedroom (23.2..26.8, 24.4..27.4), SE kitchen/dining (31.8..36.2, 29.8..34.2), or front porch (26.2..29.2, 35.4..38.8)
  let litBox = select(
    select(vec4f(26.2, 29.2, 35.4, 38.8), vec4f(31.8, 36.2, 29.8, 34.2), world.x > 30.2),
    vec4f(23.2, 26.8, 24.4, 27.4),
    world.z < 28.8
  );
  let nearest = vec3f(clamp(world.x, litBox.x, litBox.y), 0.13, clamp(world.z, litBox.z, litBox.w));
  let toFloor = nearest - world;
  let d2 = dot(toFloor, toFloor);
  if (d2 > 9.0) { return vec3f(0.0); }
  let facing = max(0.0, dot(n, normalize(toFloor + vec3f(0.0, -1e-4, 0.0))));
  let lowRoom = 1.0 - smoothstep(0.1, 2.1, world.y);
  let bounceFactor = lowRoom * (facing * 0.85 + 0.15) / (1.0 + d2 * 0.65);
  return vec3f(0.016, 0.0085, 0.0025) * bounceFactor * OL.u1.z;
}

/**
 * Blog Game Tip #9: Fast Triplanar Nyquist-Filtered Grain & Wear on MAT.timber (24) & MAT.lit (0) Props/Cars.
 */
fn evalTriplanarPropMod(world: vec3f, n: vec3f) -> f32 {
  let freq = 11.0;
  let fade = 1.0 - smoothstep(0.08, 0.45, surfaceFootprint * freq * 0.1);
  let uv = vec2f(world.x + world.z * 0.85, world.y * 1.6 + world.z * 0.35);
  let fibre = (hash2(floor(uv * freq)) - 0.5) * fade;
  return 1.0 + fibre * 0.16;
}

/**
 * Albedo-multiplying indirect bounce & localized bulb halation for sodium streetlamps and tungsten practicals,
 * plus Blog Game Tip #5 elongated window floor/driveway reflection sheen (openGlassSheen).
 */
fn applySceneLightBounceAndHaze(world: vec3f, n: vec3f, surfCol: vec3f, baseColor: vec3f, inRoom: bool, mat: i32) -> vec3f {
  var col = surfCol;
  let w = clamp(OL.u0.z, 0.0, 1.0);
  let isInView = OL.u5.w > 0.5;
  let groundMask = smoothstep(2.6, 0.35, world.y) * select(1.0, 0.32, mat == 22);
  let texAlbedo = (surfCol * 1.48 + baseColor * 0.21);

  if (!inRoom) {
    // 1. High-pressure sodium streetlamp (2100K) albedo-multiplying ground pool
    let sScale = OL.u1.w;
    if (sScale > 0.20) {
      let sPos = select(vec2f(41.2, 42.4), vec2f(39.0, 25.0), isInView);
      let dvS = (world.xz - sPos) * select(vec2f(0.85, 0.90), vec2f(1.10, 0.44), isInView);
      let dS2 = dot(dvS, dvS);
      if (dS2 < 95.0) {
        let sodiumCol = vec3f(1.0, 0.45, 0.09);
        let poolS = exp(-dS2 / select(20.0, 28.0, isInView)) * groundMask;
        col += texAlbedo * sodiumCol * poolS * select(1.12, 2.75, isInView) * sScale;
      }
    }

    // 2. Warm 2500K tungsten window & porch bounce + elongated rectangular window sheen (openGlassSheen)
    let pScale = OL.u1.x;
    let wScale = OL.u1.y;
    if (w > 0.01 && (pScale > 0.001 || wScale > 0.001) && world.z > 34.2 && world.z < 50.0 && world.x > 16.5 && world.x < 40.5) {
      let dWinL2 = dot((world.xz - vec2f(24.5, 36.0)) * vec2f(0.72, 0.64), (world.xz - vec2f(24.5, 36.0)) * vec2f(0.72, 0.64));
      let dWinR2 = dot((world.xz - vec2f(34.25, 36.0)) * vec2f(0.72, 0.64), (world.xz - vec2f(34.25, 36.0)) * vec2f(0.72, 0.64));
      let dPorch2 = dot((world.xz - vec2f(27.7, 36.4)) * vec2f(0.68, 0.52), (world.xz - vec2f(27.7, 36.4)) * vec2f(0.68, 0.52));
      let cutZoneScale = select(1.02, select(1.18, 0.96, world.z > 38.0), isInView);
      let spill = ((exp(-dWinL2 / 14.5) + exp(-dWinR2 / 14.5)) * wScale * 0.88 + exp(-dPorch2 / 15.5) * pScale * 1.05) * cutZoneScale * groundMask;
      col += texAlbedo * vec3f(1.0, 0.54, 0.14) * spill * w;
    }

    // 3. Warm golden-amber porch/lantern road pool around the survivor on the street (z = 40.0..46.0) — scaled by w*w so Noir street stays dark outside the flashlight
    let dp = world.xz - vec2f(OL.u6.x, OL.u6.y + 0.85);
    let dp2 = dot(dp * vec2f(0.60, 0.76), dp * vec2f(0.60, 0.76));
    if (!isInView && dp2 < 26.0 && world.y < 0.45 && world.z > 39.9 && w > 0.15) {
      let pPool = exp(-dp2 / 7.5);
      col += texAlbedo * vec3f(1.0, 0.54, 0.16) * pPool * 0.68 * (w * w);
    }
  } else if (world.y < 2.72) {
    col += evalAreaFloorBounce(world, n) * surfCol * 8.0;
    // Interior indirect room bounce & wall-wash halos (partitioned by quadrant so only 1 exp() runs per interior pixel)
    let roomScale = OL.u1.z;
    if (roomScale > 0.001) {
      let warmTungsten = vec3f(1.0, 0.50, 0.08);
      let roomAlbedo = surfCol * 1.35 + baseColor * 0.18;
      if (world.z < 29.6) {
        if (world.x < 27.2) {
          let vNW = (world.xz - vec2f(25.1, 25.4)) * vec2f(0.66, 0.74);
          let nwPool = exp(-dot(vNW, vNW) / 4.8);
          let wallBoost = select(0.55, 1.35, abs(n.y) < 0.45 && world.z < 26.8);
          col += (surfCol * 1.35 + vec3f(0.011, 0.0042, 0.0006)) * warmTungsten * nwPool * wallBoost * roomScale;
        } else {
          let vNE = (world.xz - vec2f(29.0, 26.2)) * vec2f(0.70, 0.76);
          let nePool = exp(-dot(vNE, vNE) / 4.8);
          let wallBoost = select(0.62, 1.25, abs(n.y) < 0.45 && world.z < 26.2);
          col += (roomAlbedo * 1.15 + vec3f(0.012, 0.0048, 0.0008)) * warmTungsten * nePool * wallBoost * roomScale;
        }
      } else if (world.x > 30.6) {
        let vSink = (world.xz - vec2f(33.4, 30.1)) * vec2f(0.66, 0.76);
        let sinkPool = exp(-dot(vSink, vSink) / 5.2) * select(0.75, 1.65, abs(n.y) < 0.45 && world.z < 30.4 && world.y > 0.85);
        let vDin = (world.xz - vec2f(33.8, 32.8)) * vec2f(0.58, 0.62);
        let dinPool = exp(-dot(vDin, vDin) / 5.8);
        col += (roomAlbedo * 1.68 + vec3f(0.022, 0.0088, 0.0014)) * warmTungsten * (sinkPool + dinPool) * roomScale;
      } else if (world.x < 27.0) {
        let vSW = (world.xz - vec2f(25.0, 32.8)) * vec2f(0.62, 0.62);
        let swPool = exp(-dot(vSW, vSW) / 5.2);
        col += (roomAlbedo * 1.28 + vec3f(0.014, 0.0056, 0.0009)) * warmTungsten * swPool * roomScale;
      } else {
        let vHall = (world.xz - vec2f(28.2, 32.6)) * vec2f(0.66, 0.56);
        let hallPool = exp(-dot(vHall, vHall) / 4.5);
        col += (roomAlbedo * 0.65 + vec3f(0.005, 0.0020, 0.0003)) * warmTungsten * hallPool * roomScale;
      }
    }
  }
  return col;
}

/**
 * Blog Game Tip #2: Analytical Ray-Cone Volumetric Flashlight + Shadow-Gated 3D Drifting Dust Motes (dustAt).
 * Always 100% live on polar slot 1 (shadowAt).
 */
fn evalFlashlightBeam(world: vec3f, n: vec3f, baseAlbedo: vec3f, inRoom: bool, mat: i32) -> vec3f {
  outbreakFlashMask = 0.0;
  if (OL.u4.z <= 0.001 || OL.u4.w < 0.5 || OL.u2.x <= 0.01) { return vec3f(0.0); }
  let fOrig = OL.u3.xy;
  let fDir = OL.u3.zw;
  let fSide = vec2f(-fDir.y, fDir.x);
  let rel = world.xz - fOrig;
  let along = dot(rel, fDir);
  let across = abs(dot(rel, fSide));
  let tanHalf = max(0.16, OL.u4.x * 1.18);
  let fRange = max(2.8, OL.u4.y);
  let coneR = 0.18 + max(0.0, along) * tanHalf;
  if (along < -0.55 || along > fRange || across > coneR * 1.45 || world.y > 1.85) {
    return vec3f(0.0);
  }
  let d0 = length(rel);
  var footAdd = vec3f(0.0);
  if (inRoom && world.y < 0.35 && d0 < 2.2) {
    let footSpill = (1.0 - d0 / 2.2) * (1.0 - min(1.0, across / 1.1));
    footAdd = baseAlbedo * vec3f(0.28, 0.20, 0.11) * footSpill;
    outbreakFlashMask = clamp(footSpill * 1.1, 0.0, 0.85);
  }
  if (along < -0.12 || (mat == 12 && length(world.xz - OL.u6.xy) < 0.55)) {
    return footAdd;
  }
  let fSlot = u32(round(OL.u4.w));
  let radial = exp(-pow(across / (coneR * 0.78), 2.0)) * (1.0 - smoothstep(coneR * 0.72, coneR * 1.45, across));
  let axial = smoothstep(-0.12, 0.18, along) * pow(clamp(1.0 - along / fRange, 0.0, 1.0), 1.25);
  let profile = radial * axial;
  if (profile <= 0.008) { return footAdd; }

  let aF = (atan2(rel.y, rel.x) + TAU) % TAU;
  let rayF = u32(i32(floor(aF / TAU * f32(RAYS))) + i32(RAYS)) % RAYS;
  let hitF = polar[(fSlot * RAYS + rayF) * 2u].x;
  let vis = 1.0 - smoothstep(hitF - 0.05, hitF + 0.20, d0);
  if (vis <= 0.001) { return footAdd; }

  outbreakFlashMask = max(outbreakFlashMask, clamp(profile * vis * 3.4, 0.0, 1.0));

  let moteCell = floor(world.xz * 7.5 + vec2f(F.cam.w * 0.18, -F.cam.w * 0.14));
  let moteHash = hash2(moteCell);
  let moteGlint = smoothstep(0.92, 0.99, moteHash) * (0.5 + 0.5 * sin(F.cam.w * 2.4 + moteHash * 31.0));

  let surfW = select(0.36 + 0.58 * max(0.0, dot(n.xz, -fDir)), 1.0, world.y < 0.32 && n.y > 0.65);
  let w = clamp(OL.u0.z, 0.0, 1.0);
  let beamCol = mix(vec3f(1.08, 0.96, 0.78), vec3f(1.0, 0.62, 0.24), w * 0.78);
  let mist = (profile / (0.38 + max(0.0, along) * 0.22) + moteGlint * 0.18) * OL.u2.x * 0.28 * surfW;
  var beamAlbedo = baseAlbedo;
  if (mat == 22 || mat == 20) {
    beamAlbedo = mix(baseAlbedo, baseAlbedo * vec3f(0.95, 1.35, 0.74), outbreakFlashMask * 0.48);
  }
  return footAdd + (beamAlbedo * 1.65 + beamCol * 0.05) * beamCol * OL.u4.z * mist * vis;
}
`
