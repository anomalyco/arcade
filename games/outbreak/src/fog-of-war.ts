import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import type { BoneId, BonePose } from "@arcade/kit/human-pose"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { AIAgent, NoiseEvent } from "../shared/ai"
import type { SceneryMemory } from "../shared/scenery-memory"
import { FOG_CELL, FOG_SIZE, type Vision } from "../shared/vision"

export type FogStyleId = 0 | 1 | 2

export type FogOfWarSettings = {
  fogStyle: FogStyleId
  fogEdgeSoftness: number
  fogMemoryDim: number
  fogUnknownGrain: number
  fogSoundCues: number
  fogGhostDuration: number
}

export const DEFAULT_FOG_OF_WAR: FogOfWarSettings = {
  fogStyle: 1,
  fogEdgeSoftness: 0.78,
  fogMemoryDim: 0.42,
  fogUnknownGrain: 0.48,
  fogSoundCues: 1.0,
  fogGhostDuration: 3.2,
}

export const FOG_STYLE_OPTIONS: readonly { label: string; value: FogStyleId }[] = [
  { label: "Noir Memory + Echo", value: 1 },
  { label: "Stark Cone + Pulse", value: 2 },
  { label: "Soft Shroud (Classic)", value: 0 },
] as const

export const fogOfWarControls: LabControl[] = [
  {
    key: "fogStyle",
    label: "Fog of war style",
    group: "Vision",
    options: FOG_STYLE_OPTIONS,
  },
  {
    key: "fogEdgeSoftness",
    label: "LOS edge feather",
    group: "Vision",
    min: 0.05,
    max: 1.5,
    step: 0.05,
    unit: "",
  },
  {
    key: "fogMemoryDim",
    label: "Memory brightness",
    group: "Vision",
    min: 0.1,
    max: 0.9,
    step: 0.02,
    unit: "×",
  },
  {
    key: "fogUnknownGrain",
    label: "Unknown area grain",
    group: "Vision",
    min: 0.0,
    max: 1.0,
    step: 0.02,
    unit: "",
  },
  {
    key: "fogSoundCues",
    label: "Sound ripple cues",
    group: "Vision",
    min: 0.0,
    max: 1.5,
    step: 0.05,
    unit: "×",
  },
  {
    key: "fogGhostDuration",
    label: "Last-known fade",
    group: "Vision",
    min: 0.0,
    max: 8.0,
    step: 0.2,
    unit: "s",
  },
]

/**
 * Combines persistent outdoor/indoor cell exploration (`vision.explored`) and discovered room footprints
 * (`scenery.mask`) into a smooth 3x3-filtered R8 visibility/memory texture (`FOG_SIZE x FOG_SIZE`).
 */
export class CombinedFogMemory {
  readonly raw = new Uint8Array(FOG_SIZE * FOG_SIZE)
  readonly filtered = new Uint8Array(FOG_SIZE * FOG_SIZE)
  private dirty = true

  markDirty(): void {
    this.dirty = true
  }

  reset(): void {
    this.raw.fill(0)
    this.filtered.fill(0)
    this.dirty = true
  }

  update(vision: Vision, scenery: SceneryMemory, force = false): boolean {
    if (!force && !this.dirty) return false
    this.dirty = false
    const exp = vision.explored
    const room = scenery.mask
    const n = FOG_SIZE * FOG_SIZE
    for (let i = 0; i < n; i++) {
      // Discovered interior rooms get 220; directly ray-seen cells get 255
      const v = exp[i]! > 0 ? 255 : room[i]! > 0 ? 220 : 0
      if (v > this.raw[i]!) this.raw[i] = v
    }

    // Fast 3x3 box blur so remembered boundaries never show 0.5m grid stair-stepping
    const w = FOG_SIZE
    const h = FOG_SIZE
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1) * w
      const y1 = y * w
      const y2 = Math.min(h - 1, y + 1) * w
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1)
        const x2 = Math.min(w - 1, x + 1)
        const sum =
          this.raw[y0 + x0]! +
          this.raw[y0 + x]! * 2 +
          this.raw[y0 + x2]! +
          this.raw[y1 + x0]! * 2 +
          this.raw[y1 + x]! * 4 +
          this.raw[y1 + x2]! * 2 +
          this.raw[y2 + x0]! +
          this.raw[y2 + x]! * 2 +
          this.raw[y2 + x2]!
        this.filtered[y1 + x] = (sum + 8) >> 4
      }
    }
    return true
  }
}

export type ZombieLastKnownGhost = {
  id: number
  x: number
  y: number
  yaw: number
  bones: BonePose
  hiddenBones: Set<BoneId>
  seenAt: number
}

/**
 * Tracks last-known positions & poses of zombies when they were in the player's authoritative LOS.
 * Once a zombie steps out of sight, its frozen memory silhouette fades over `fogGhostDuration` seconds,
 * and clears immediately if the player regains line of sight to that spot and sees the zombie is gone.
 */
export class ZombieMemoryTracker {
  private readonly ghosts = new Map<number, ZombieLastKnownGhost>()

  reset(): void {
    this.ghosts.clear()
  }

  recordSeen(
    id: number,
    x: number,
    y: number,
    yaw: number,
    bones: BonePose,
    hiddenBones: Set<BoneId>,
    time: number,
  ): void {
    const clonedBones: BonePose = {}
    for (const [k, f] of Object.entries(bones)) {
      if (f) {
        clonedBones[k as BoneId] = {
          p: [...f.p],
          x: [...f.x],
          y: [...f.y],
          z: [...f.z],
        }
      }
    }
    this.ghosts.set(id, {
      id,
      x,
      y,
      yaw,
      bones: clonedBones,
      hiddenBones: new Set(hiddenBones),
      seenAt: time,
    })
  }

  remove(id: number): void {
    this.ghosts.delete(id)
  }

  /**
   * Returns active fading memory ghosts for zombies currently outside LOS.
   */
  getActiveGhost(
    agent: AIAgent,
    vision: Vision,
    time: number,
    maxDuration: number,
  ): { ghost: ZombieLastKnownGhost; alpha: number } | null {
    if (maxDuration <= 0.05 || agent.state === "dead") {
      this.ghosts.delete(agent.id)
      return null
    }
    const g = this.ghosts.get(agent.id)
    if (!g) return null
    const age = Math.max(0, time - g.seenAt)
    if (age >= maxDuration) {
      this.ghosts.delete(agent.id)
      return null
    }
    // If the player can currently see the last-known spot and the zombie has moved away from it, clear the memory
    if (Math.hypot(agent.x - g.x, agent.y - g.y) > 0.85 && vision.visible(g.x, g.y)) {
      this.ghosts.delete(agent.id)
      return null
    }
    const u = age / maxDuration
    const alpha = Math.pow(1 - u, 1.55) * 0.56
    if (alpha <= 0.02) return null
    return { ghost: g, alpha }
  }
}

function hashPair(a: number, b: number): number {
  let x = ((a * 374761393 + b * 668265263) ^ 0x5bf03635) >>> 0
  x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

/**
 * Computes deterministically jittered sound-cue position for an unseen zombie or noise event,
 * adding +/-0.8..1.4m spatial uncertainty so acoustic ripples alert the player without revealing exact coordinates.
 */
export function jitteredSoundOrigin(
  id: number,
  trueX: number,
  trueY: number,
  bucket: number,
  uncertaintyMeters = 1.15,
): [number, number] {
  const h1 = hashPair(id, bucket * 2 + 1)
  const h2 = hashPair(id * 17 + 3, bucket * 2 + 2)
  const angle = h1 * Math.PI * 2
  const r = (0.45 + 0.55 * h2) * uncertaintyMeters
  return [
    Number((trueX + Math.cos(angle) * r).toFixed(3)),
    Number((trueY + Math.sin(angle) * r).toFixed(3)),
  ]
}

/**
 * Appends Noir fog-of-war sound ripples & echo markers for out-of-sight zombies and noise events
 * into `alphaSprites` (even when `aiDebugOverlay` is off).
 */
export function collectFogSoundSprites(
  agents: readonly AIAgent[],
  noiseEvents: readonly NoiseEvent[],
  player: { x: number; y: number },
  vision: Vision,
  time: number,
  support: (x: number, z: number) => number,
  settings: Partial<FogOfWarSettings>,
  alphaSprites: Float32Array,
  startAlphaCount: number,
): number {
  const cueStrength = settings.fogSoundCues ?? DEFAULT_FOG_OF_WAR.fogSoundCues
  const fogStyle = settings.fogStyle ?? DEFAULT_FOG_OF_WAR.fogStyle
  if (cueStrength <= 0.01) return startAlphaCount
  // Classic soft shroud (style 0) only shows loud impact/bash events, at reduced intensity
  const styleMult = fogStyle === 0 ? 0.45 : fogStyle === 2 ? 1.25 : 1.0
  const maxSprites = Math.floor(alphaSprites.length / SPRITE_FLOATS)
  let alphaCount = startAlphaCount

  const pushSprite = (
    x: number,
    y: number,
    z: number,
    size: number,
    r: number,
    g: number,
    b: number,
    a: number,
    kind: number,
    rot: number,
    stretch: number,
    extra: number,
  ) => {
    if (alphaCount >= maxSprites || a <= 0.01) return
    const o = alphaCount++ * SPRITE_FLOATS
    alphaSprites[o] = x
    alphaSprites[o + 1] = y
    alphaSprites[o + 2] = z
    alphaSprites[o + 3] = size
    alphaSprites[o + 4] = r
    alphaSprites[o + 5] = g
    alphaSprites[o + 6] = b
    alphaSprites[o + 7] = Math.min(0.95, a * cueStrength * styleMult)
    alphaSprites[o + 8] = kind
    alphaSprites[o + 9] = rot
    alphaSprites[o + 10] = stretch
    alphaSprites[o + 11] = extra
  }

  // 1. Active NoiseEvents occurring out of sight (door/window bashes, glass, footsteps)
  for (let i = 0; i < noiseEvents.length; i++) {
    const ev = noiseEvents[i]!
    if (ev.sourceId === "player" && ev.kind === "sprint") continue
    const dist = Math.hypot(ev.x - player.x, ev.y - player.y)
    if (dist > 26 || vision.visible(ev.x, ev.y)) continue
    const age = Math.max(0, time - ev.time)
    const ttl = Math.max(0.35, ev.ttl)
    if (age >= ttl) continue
    const u = age / ttl
    const [jx, jy] = jitteredSoundOrigin(i + 500, ev.x, ev.y, Math.floor(ev.time * 2), 0.75)
    const gy = support(jx, jy) + 0.07
    const isUrgent = ev.kind === "bash" || ev.kind === "gunshot" || ev.kind === "glass"
    const r = isUrgent ? 0.96 : 0.72
    const g = isUrgent ? 0.42 : 0.80
    const b = isUrgent ? 0.28 : 0.92
    const maxR = Math.min(3.4, Math.max(1.2, ev.radius * 0.16))
    // Expanding jagged tremor ring (kind 3) + inner echo ring (kind 2)
    pushSprite(jx, gy, jy, 0.35 + maxR * u, r, g, b, (1 - u) * 0.68, 3, u * 1.2, 0.055, i * 1.7)
    if (u > 0.18) {
      const u2 = (u - 0.18) / 0.82
      pushSprite(jx, gy, jy, 0.25 + maxR * 0.65 * u2, r, g, b, (1 - u2) * 0.48, 2, 0, 0.04, 0)
    }
  }

  if (fogStyle === 0) return alphaCount

  // 2. Unseen zombies shuffling, groaning, chasing, or bashing within hearing range (<= 16m, capped to 3 nearest so fog stays clean)
  const candidates: { agent: AIAgent; dist: number; isUrgent: boolean; isMoving: boolean }[] = []
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!
    if (a.state === "dead") continue
    const dist = Math.hypot(a.x - player.x, a.y - player.y)
    const speed = Math.hypot(a.vx, a.vy)
    const isUrgent = a.state === "chase" || a.state === "bash" || a.state === "alert"
    const isMoving = speed > 0.15 || isUrgent || a.state === "investigate" || a.state === "search"
    const maxHearDist = isUrgent ? 18 : isMoving ? 14 : 10.5
    if (dist > maxHearDist || dist < 1.0) continue
    if (vision.actorVisible(a.x, a.y) > 0.05) continue
    candidates.push({ agent: a, dist, isUrgent, isMoving })
  }
  candidates.sort((a, b) => (Number(b.isUrgent) - Number(a.isUrgent)) || a.dist - b.dist)
  const maxCues = fogStyle === 2 ? 3 : 2

  for (let cIdx = 0; cIdx < Math.min(candidates.length, maxCues); cIdx++) {
    const { agent: a, dist, isUrgent, isMoving } = candidates[cIdx]!
    const period = isUrgent ? 1.15 : isMoving ? 1.65 : 2.6
    const phaseOffset = (a.id * 0.37) % 1
    const cycle = time / period + phaseOffset
    const bucket = Math.floor(cycle)
    const u = cycle - bucket
    // Intermittent acoustic pulse window (active for first 68% of cycle, silent pause between footsteps/groans)
    if (!isUrgent && u > 0.68) continue
    const pulseU = isUrgent ? u : u / 0.68

    // Uncertainty scales with distance (0.7m close .. 1.35m far)
    const uncertainty = 0.7 + Math.min(0.65, dist * 0.035)
    const [jx, jy] = jitteredSoundOrigin(a.id, a.x, a.y, bucket, uncertainty)
    // Never place a sound ripple inside the player's clear LOS where they can see nothing is there
    if (vision.visible(jx, jy)) continue

    const gy = support(jx, jy) + 0.065
    const distAtten = Math.max(0.22, 1 - dist / 19)
    const env = Math.sin(pulseU * Math.PI) * (1 - pulseU * 0.4) * distAtten
    const baseR = isUrgent ? 1.15 : isMoving ? 0.85 : 0.62

    // Muted bone-silver Noir ripple for shuffles/groans; warm amber-crimson for urgent chase/bash
    const colR = isUrgent ? 0.92 : 0.62
    const colG = isUrgent ? 0.44 : 0.72
    const colB = isUrgent ? 0.28 : 0.84

    // Outer acoustic ripple (kind 3)
    pushSprite(
      jx,
      gy,
      jy,
      0.20 + baseR * pulseU,
      colR,
      colG,
      colB,
      env * (isUrgent ? 0.48 : 0.30),
      3,
      bucket * 0.9 + pulseU * 0.6,
      0.045,
      a.id * 1.3,
    )
    // In Variant 2 ("Stark Cone + Pulse"), add a subtle Odradek-style dashed echo ring (kind 5)
    if (fogStyle === 2) {
      pushSprite(
        jx,
        gy + 0.01,
        jy,
        0.30 + baseR * 0.72 * pulseU,
        colR,
        colG,
        colB,
        env * 0.34,
        5,
        -time * 0.6 + a.id,
        0.035,
        0,
      )
    }
  }

  return alphaCount
}

export const outbreakFogOfWarDeclarationsWgsl = /* wgsl */ `
fn eyeVisible(p: vec2f) -> f32 {
  let delta = p - lights[0].pos.xz;
  let d2 = dot(delta, delta);
  let r = lights[0].pos.w;
  if (d2 >= r * r) { return 0.0; }
  let distance = sqrt(d2);
  let soft = clamp(select(0.78, OL.u10.y, OL.u10.y > 0.01), 0.05, 1.5);
  let facing = dot(delta / max(distance, 0.001), vec2f(cos(F.effects.x), sin(F.effects.x)));
  let coneFeather = 0.04 + 0.14 * soft;
  let cone = smoothstep(F.effects.y - coneFeather * 0.35, F.effects.y + coneFeather * 0.65, facing);
  let near = (1.0 - smoothstep(0.35, F.effects.z + 0.55 * soft, distance)) * 0.42;
  let mask = max(cone, near);
  if (mask <= 0.0) { return 0.0; }
  let range = 1.0 - smoothstep(r - (1.0 + 1.5 * soft), r, distance);
  let a = (atan2(delta.y, delta.x) + TAU) % TAU;
  let f = a / TAU * f32(RAYS) - 0.5;
  let r0 = u32(i32(floor(f)) + i32(RAYS)) % RAYS;
  let r1 = (r0 + 1u) % RAYS;
  let h0 = polar[r0 * 2u].x;
  let h1 = polar[r1 * 2u].x;
  let pen = 0.08 + 0.18 * soft;
  let v0 = 1.0 - smoothstep(h0 + 0.02, h0 + pen, distance);
  let v1 = 1.0 - smoothstep(h1 + 0.02, h1 + pen, distance);
  return mix(v0, v1, fract(f)) * mask * range;
}

/**
 * Evaluates 3-state survival-horror Fog of War:
 * - State 1 (Live LOS, visible -> 1): Full scene lighting & flashlight colour restoration.
 * - State 2 (Remembered SceneryMemory, visible == 0, explored > 0): Desaturated cold steel-ash blueprint memory.
 * - State 3 (Unexplored Shroud, visible == 0, explored == 0): Deep Limbo charcoal ink with subtle animated static grain.
 */
fn applyOutbreakFogOfWar(
  colIn: vec3f,
  world: vec3f,
  n: vec3f,
  baseColor: vec3f,
  inRoom: bool,
  mat: i32,
  warmth: f32,
) -> vec3f {
  let visible = eyeVisible(world.xz + n.xz * 0.06);
  if (visible >= 0.995 && mat != 2) {
    return colIn;
  }
  let explored = textureSampleLevel(exploredTex, floorSamp, (world.xz + n.xz * 0.24 - OL.win.xy) * F.map.xy, 0.0).r;
  let fogStyle = i32(floor(OL.u10.x * 0.25 + 1e-4));
  let baseMemDim = select(0.42, OL.u10.z, OL.u10.z > 0.01);
  let memDim = clamp(
    select(select(baseMemDim, baseMemDim * 0.52, fogStyle == 2), max(baseMemDim, 0.66), fogStyle == 0),
    0.10,
    0.92
  );

  if (mat == 2) {
    var lampCol = colIn * 0.88;
    if (inRoom && world.y < 2.8) {
      lampCol *= max(explored * memDim, visible);
    } else {
      lampCol *= mix(memDim * (0.55 + 0.45 * explored), 1.0, visible);
    }
    return lampCol;
  }

  let luminance = dot(colIn, vec3f(0.2126, 0.7152, 0.0722));
  let warmBias = clamp((colIn.r - colIn.b * 1.15) / max(colIn.r + 0.005, 1e-4), 0.0, 1.0);
  let memTint = mix(vec3f(0.74, 0.86, 1.06), vec3f(0.98, 0.94, 0.86), warmth * 0.65);
  let memSat = select(0.06, 0.28, fogStyle == 0) + 0.14 * warmBias * warmth;
  let memoryTone = mix(vec3f(luminance) * memTint, colIn, memSat) * memDim;

  if (inRoom && world.y < 2.8) {
    let unknownGrainAmt = clamp(select(0.48, fract(OL.u10.x), OL.u10.z > 0.01), 0.0, 1.0) * select(1.0, 1.35, fogStyle == 2);
    let tSalt = floor(F.cam.w * 16.0) * 7.3;
    let shroudNoise = (hash2(floor(world.xz * 12.0) + vec2f(tSalt, -tSalt)) - 0.5) * unknownGrainAmt * 0.014;
    let unknownShroud = max(vec3f(0.0015, 0.0022, 0.0038), baseColor * 0.010 + vec3f(0.0035, 0.0048, 0.0072) + vec3f(shroudNoise));
    let shroudScale = clamp(F.effects.w * 2.2, 0.35, 1.0);
    let roomMem = memoryTone * shroudScale;
    let unrevealed = mix(unknownShroud, roomMem, explored);
    return mix(unrevealed, colIn, visible);
  }

  return mix(memoryTone * (0.76 + 0.24 * explored), colIn, visible);
}
`
