import { SPRITE_FLOATS, type VisibilityFieldShader } from "@arcade/kit/gpu/renderer"
import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import { common } from "@arcade/kit/gpu/shaders"
import type { BoneId, BonePose } from "@arcade/kit/human-pose"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { AIAgent, NoiseEvent } from "../shared/ai"
import type { SceneryMemory } from "../shared/scenery-memory"
import { SIZE } from "../shared/map"
import { FOG_CELL, FOG_SIZE, type Vision } from "../shared/vision"
import { outbreakLightingStructWgsl } from "./lighting"
import { outbreakUnseenFieldWgsl, outbreakUnseenSceneWgsl } from "./unseen"

export type FogStyleId = 0 | 1 | 2

export type FogOfWarSettings = {
  fogStyle: FogStyleId
  fogEdgeSoftness: number
  fogMemoryDim: number
  fogUnknownGrain: number
  fogSoundCues: number
  fogGhostDuration: number
  fogMemorySaturation: number
  fogMemoryWarmth: number
  fogPenumbra: number
  fogPenumbraGrowth: number
  fogRevealTime: number
  fogFadeTime: number
}

export const DEFAULT_FOG_OF_WAR: FogOfWarSettings = {
  fogStyle: 1,
  fogEdgeSoftness: 0.78,
  fogMemoryDim: 0.5,
  fogUnknownGrain: 0,
  fogSoundCues: 0,
  fogGhostDuration: 3.2,
  fogMemorySaturation: 0.22,
  fogMemoryWarmth: 0.6,
  fogPenumbra: 0.22,
  fogPenumbraGrowth: 0.05,
  fogRevealTime: 0.07,
  fogFadeTime: 0.25,
}

export const FOG_STYLE_OPTIONS: readonly { label: string; value: FogStyleId }[] = [
  { label: "Soft memory", value: 1 },
  { label: "Stark cone", value: 2 },
  { label: "Light shroud", value: 0 },
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
    label: "Unknown area grain (off by default)",
    group: "Vision",
    min: 0.0,
    max: 1.0,
    step: 0.02,
    unit: "",
  },
  {
    key: "fogSoundCues",
    label: "Sound ripple cues (off by default)",
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
  { key: "fogMemorySaturation", label: "Memory saturation", group: "Vision", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "fogMemoryWarmth", label: "Memory warmth", group: "Vision", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "fogPenumbra", label: "LOS penumbra at the eye", group: "Vision", min: 0, max: 1.5, step: 0.02, unit: "m" },
  { key: "fogPenumbraGrowth", label: "LOS penumbra growth", group: "Vision", min: 0, max: 0.2, step: 0.005, unit: "m/m" },
  { key: "fogRevealTime", label: "Reveal time", group: "Vision", min: 0.01, max: 0.5, step: 0.01, unit: "s" },
  { key: "fogFadeTime", label: "Fade-to-memory time", group: "Vision", min: 0.01, max: 1.5, step: 0.01, unit: "s" },
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

/** Visibility field: 768² texels over the 96 m map window (12.5 cm), updated in a 512² window around the eye. */
export const VIS_FIELD_SIZE = 768
export const VIS_FIELD_DISPATCH = 512

/**
 * Soft line-of-sight field. Each texel takes the vision cone and awareness circle with feathered edges, then filters
 * the eye's polar blocker distances across a lateral penumbra that widens with distance (7 Gaussian-weighted
 * interpolated rays, radially tight so light never leaks through a wall), and eases toward that target with separate
 * reveal and fade times. `y` keeps the brightest value ever seen as soft fine-grained memory. Gameplay visibility stays
 * in shared/vision.ts; this only shades.
 */
export const visibilityFieldShader: VisibilityFieldShader = {
  size: VIS_FIELD_SIZE,
  dispatch: VIS_FIELD_DISPATCH,
  code: /* wgsl */ `
${common}
${foliageWindDeclarationsWgsl}
${outbreakLightingStructWgsl}
@group(0) @binding(14) var<storage, read_write> fieldState: array<vec2f>;
@group(0) @binding(15) var fieldOut: texture_storage_2d<rgba8unorm, write>;
const FIELD_SIZE: i32 = ${VIS_FIELD_SIZE};
const FIELD_HALF: i32 = ${VIS_FIELD_DISPATCH / 2};
const FIELD_CELL: f32 = ${(SIZE / VIS_FIELD_SIZE).toFixed(6)};

fn rayVis(f: f32, d: f32) -> f32 {
  let lo = floor(f);
  let r0 = u32(i32(lo) + i32(RAYS) * 4) % RAYS;
  let r1 = (r0 + 1u) % RAYS;
  let h0 = polar[r0 * 2u].x;
  let h1 = polar[r1 * 2u].x;
  let v0 = 1.0 - smoothstep(h0 - 0.03, h0 + 0.09, d);
  let v1 = 1.0 - smoothstep(h1 - 0.03, h1 + 0.09, d);
  return mix(v0, v1, f - lo);
}

${outbreakUnseenFieldWgsl}

fn softSight(p: vec2f) -> f32 {
  let eye = lights[0].pos.xz;
  let r = lights[0].pos.w;
  let delta = p - eye;
  let d2 = dot(delta, delta);
  let maxR = select(r, max(r, OL.u4.y), OL.unseen.flashActive > 0.5 && OL.u4.z > 0.005);
  if (d2 >= maxR * maxR) { return 0.0; }
  if (d2 < 0.0064) { return 1.0; }
  let d = sqrt(d2);
  let unseenActive = OL.unseen.mode >= 0.5 && OL.unseen.strength > 0.001;
  let soft = clamp(select(OL.u10.y, OL.unseen.edgeSoftness, unseenActive), 0.05, 2.0);
  let facing = dot(delta, vec2f(cos(F.effects.x), sin(F.effects.x))) / d;
  // Darkwood (v8): a crisp ~5° cone edge and a body halo that ends at the awareness radius.
  let sharp = clamp(OL.v8.x, 0.0, 1.0);
  let feather = mix(0.05 + 0.2 * soft, 0.035, sharp);
  let cone = smoothstep(F.effects.y - feather, F.effects.y + feather, facing);
  let nearScale = select(0.6, 1.0, unseenActive);
  let nearIn = mix(F.effects.z * 0.5, F.effects.z * 0.72, sharp);
  let nearOut = mix(F.effects.z + 0.8 + 1.2 * soft, F.effects.z + 0.35, sharp);
  let near = nearScale * (1.0 - smoothstep(nearIn, nearOut, d));
  let mask = max(cone, near) * step(d, r);
  var canFlash = false;
  if (unseenActive && OL.unseen.flashActive > 0.5 && OL.u4.z > 0.005) {
    let fDelta = p - OL.u3.xy;
    let fDist = length(fDelta);
    if (fDist < OL.u4.y) {
      let fFacing = select(1.0, dot(fDelta / max(fDist, 1e-4), OL.u3.zw), fDist > 0.12);
      canFlash = fFacing >= (OL.unseen.flashCosHalf - (0.04 + 0.16 * soft));
    }
  }
  if (mask <= 0.0 && !canFlash) { return 0.0; }
  let range = 1.0 - smoothstep(r - (1.5 + 3.0 * soft), r, d);
  let a = atan2(delta.y, delta.x);
  let f = a / TAU * f32(RAYS) - 0.5;
  let halfWidth = OL.u15.x + OL.u15.y * d;
  let stepRays = halfWidth / (3.0 * d) / TAU * f32(RAYS);
  let v0 = rayVis(f, d);
  let vL2 = rayVis(f - 2.0 * stepRays, d);
  let vR2 = rayVis(f + 2.0 * stepRays, d);
  var eyeRayVis: f32;
  if (v0 >= 0.999 && vL2 >= 0.999 && vR2 >= 0.999) {
    eyeRayVis = 1.0;
  } else if (v0 <= 0.001 && vL2 <= 0.001 && vR2 <= 0.001) {
    eyeRayVis = 0.0;
  } else {
    let vL1 = rayVis(f - stepRays, d);
    let vR1 = rayVis(f + stepRays, d);
    let vL3 = rayVis(f - 3.0 * stepRays, d);
    let vR3 = rayVis(f + 3.0 * stepRays, d);
    eyeRayVis = v0 * 0.28537 + (vL1 + vR1) * 0.22225 + (vL2 + vR2) * 0.10498 + (vL3 + vR3) * 0.03008;
  }
  let coneSight = mask * range * eyeRayVis;
  if (!canFlash) { return coneSight; }
  return max(coneSight, evalUnseenFlashCone(p, soft, eyeRayVis));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let origin = vec2i(floor((lights[0].pos.xz - OL.win.xy) / FIELD_CELL)) - vec2i(FIELD_HALF);
  let tx = origin + vec2i(gid.xy);
  if (any(tx < vec2i(0)) || any(tx >= vec2i(FIELD_SIZE))) { return; }
  let idx = u32(tx.y * FIELD_SIZE + tx.x);
  let p = (vec2f(tx) + 0.5) * FIELD_CELL + OL.win.xy;
  let goal = softSight(p);
  let prev = fieldState[idx];
  if (goal <= 0.0005 && prev.x <= 0.0005 && OL.u15.w < 0.99 && OL.unseen.mode < 0.5) { return; }
  var s = prev;
  s.x = select(mix(s.x, goal, select(OL.u15.w, OL.u15.z, goal > s.x)), 0.0, s.x < 0.0005 && goal <= 0.0005);
  s.y = max(s.y, s.x);
  fieldState[idx] = s;
  var edgeD = 0.0;
  if (OL.unseen.mode >= 0.5 && OL.unseen.strength > 0.001 && s.x < 0.998) {
    edgeD = evalUnseenEdgeDepth(s.x, s.y, p);
  }
  textureStore(fieldOut, tx, vec4f(s.x, s.y, edgeD, 1.0));
}
`,
}

export const outbreakFogOfWarDeclarationsWgsl = /* wgsl */ `
${outbreakUnseenSceneWgsl}
/** Live sight (x) and soft fine-grained memory (y) from the visibility field, gated to the current sight range. */
fn fieldSight(world: vec3f, n: vec3f) -> vec2f {
  let uv = (world.xz + n.xz * 0.09 - OL.win.xy) * F.map.xy;
  let inWin = select(1.0, 0.0, OL.win.z > 0.5 && (any(uv < vec2f(0.003)) || any(uv > vec2f(0.997))));
  let fv = textureSampleLevel(visField, floorSamp, uv, 0.0).rg * inWin;
  let dEyeV = world.xz - lights[0].pos.xz;
  let r0 = max(0.0, lights[0].pos.w - 0.6);
  let r1 = lights[0].pos.w + 0.4;
  let gate = 1.0 - smoothstep(r0 * r0, r1 * r1, dot(dEyeV, dEyeV));
  return vec2f(fv.x * gate, fv.y);
}

/**
 * Blends the lit frame into memory where the survivor can't see: remembered places become a dim, desaturated, warm
 * wash; unexplored interiors a deep ink. The live field is soft, so there are no polygon edges. Leaves the live
 * visibility in outbreakSeen for the flashlight and the colour mask.
 */
fn applyOutbreakFogOfWar(
  colIn: vec3f,
  world: vec3f,
  n: vec3f,
  inRoom: bool,
  mat: i32,
  warmth: f32,
) -> vec3f {
  let sight = fieldSight3(world, n);
  let visible = sight.x;
  let edgeDepth = sight.z;
  outbreakSeen = visible;
  outbreakUnseenAlpha = 0.0;
  if (visible >= 0.992 && mat != 2) {
    return colIn;
  }
  let expUv = (world.xz + n.xz * 0.24 - OL.win.xy) * F.map.xy;
  let inExpWin = select(1.0, 0.0, OL.win.z > 0.5 && (any(expUv < vec2f(0.003)) || any(expUv > vec2f(0.997))));
  let explored = max(textureSampleLevel(exploredTex, floorSamp, expUv, 0.0).r * inExpWin, sight.y);
  let isOverhaul = OL.round.x > 0.5 || OL.round.z > 0.5;
  let isV5 = (OL.round.x > 3.5 && OL.round.x < 4.5) || (OL.round.z > 3.5 && OL.round.z < 4.5);
  let isV6 = OL.round.x > 4.5 || OL.round.z > 4.5;
  let isV7 = OL.round.x > 5.5 || OL.round.z > 5.5;
  let sunVal = clamp(F.monitorBounds.w, 0.0, 1.0);
  let duskVal = select(0.0, smoothstep(0.42, 0.22, F.monitorBounds.y) * (1.0 - smoothstep(0.25, 0.75, sunVal)), isV7);
  let dayOrDusk = max(sunVal, duskVal * 0.88);
  let shroudDark = clamp(OL.shroud.x, 0.0, 2.0);
  let unlitDesat = clamp(OL.shroud.y, 0.0, 1.5);
  let sightDark = clamp(OL.shroud.z, 0.0, 2.0);
  outbreakKnown = select(1.0, select(explored, max(explored, outbreakLitMask * 0.92), isOverhaul), inRoom && world.y < 2.8);
  let fogStyle = i32(floor(OL.u10.x * 0.25 + 1e-4));
  let baseMemDim = OL.u10.z;
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
    return applyOutbreakUnseenScene(colIn, lampCol, world, n, inRoom, mat, visible, explored, edgeDepth);
  }

  let luminance = dot(colIn, vec3f(0.2126, 0.7152, 0.0722));
  let baseMemTint = mix(vec3f(0.86, 0.92, 1.04), vec3f(1.08, 0.98, 0.84), clamp(OL.u16.x, 0.0, 1.0));
  let v6UnlitTint = mix(vec3f(0.52, 0.86, 1.56), vec3f(0.93, 0.96, 1.02), clamp(unlitDesat, 0.0, 1.0));
  let overhaulUnlitTint = select(vec3f(0.52, 0.86, 1.56), v6UnlitTint, isV6);
  let v7LitMemTint = mix(mix(vec3f(1.08, 0.94, 0.74), vec3f(1.22, 0.88, 0.58), duskVal), vec3f(1.02, 0.99, 0.95), sunVal);
  let memTint = select(baseMemTint, mix(overhaulUnlitTint, select(vec3f(1.08, 0.94, 0.74), v7LitMemTint, isV7), outbreakLitMask), isOverhaul);
  // Remembered scenery lit by a real light keeps its colour for the grade (the light-colour rule); unlit memory desaturates heavily in v6.
  let v6MemSatScale = select(clamp(1.0 - 0.85 * unlitDesat, 0.0, 1.0), mix(clamp(1.0 - 0.85 * unlitDesat, 0.0, 1.0), clamp(0.88 - 0.26 * unlitDesat, 0.36, 0.94), dayOrDusk), isV7 && !inRoom);
  let baseMemSat = select(OL.u10.w, max(OL.u10.w, 0.32), fogStyle == 0) * select(1.0, v6MemSatScale, isV6);
  let memSat = mix(baseMemSat, select(1.0, mix(1.0, 0.78, sunVal * (1.0 - visible)), isV7 && !inRoom), outbreakLitMask);
  let v6MemUnlit = memDim * clamp(0.90 - 0.34 * sightDark, 0.20, 1.0);
  let v7DayMemUnlit = mix(v6MemUnlit, clamp(0.76 - 0.12 * (sightDark - 1.0), 0.52, 0.94), dayOrDusk);
  let v6MemLit = mix(memDim * 0.86, 1.0, clamp(1.0 - 0.22 * sightDark, 0.45, 1.0));
  let effMemDim = select(
    memDim,
    mix(
      select(memDim * select(0.76, 0.90, !inRoom && isV5), select(v6MemUnlit, v7DayMemUnlit, isV7 && !inRoom), isV6),
      select(select(memDim * 0.94, 1.0, isV5), v6MemLit, isV6),
      outbreakLitMask,
    ),
    isOverhaul,
  );
  let memoryTone = mix(vec3f(luminance) * memTint, colIn, memSat) * effMemDim;

  var baseFowCol: vec3f;
  if (inRoom && world.y < 2.8) {
    let shroudScale = clamp(F.effects.w * 2.2, 0.35, 1.0);
    let v6RoomScale = mix(shroudScale * clamp(0.84 - 0.30 * sightDark, 0.22, 1.0), clamp(0.76 - 0.20 * sightDark, 0.32, 0.90), outbreakLitMask);
    let roomMem = memoryTone * select(shroudScale, select(mix(shroudScale * 0.68, 0.62, outbreakLitMask), v6RoomScale, isV6), isOverhaul);
    if (explored >= 0.992 && OL.unseen.mode < 0.5) {
      return mix(roomMem, colIn, visible);
    }
    let unknownGrainAmt = fract(OL.u10.x) * select(1.0, 1.35, fogStyle == 2);
    var shroudNoise = 0.0;
    if (unknownGrainAmt > 0.001) {
      let tSalt = floor(F.cam.w * 16.0) * 7.3;
      shroudNoise = (hash2(floor(world.xz * 12.0) + vec2f(tSalt, -tSalt)) - 0.5) * unknownGrainAmt * select(0.014, 0.002, isOverhaul);
    }
    let legacyShroud = max(vec3f(0.0015, 0.0018, 0.0024), outbreakAlbedo * 0.012 + vec3f(0.0042, 0.0040, 0.0040) + vec3f(shroudNoise));
    let v6ShroudColIn = mix(colIn, vec3f(luminance), clamp(0.88 * unlitDesat, 0.0, 0.98) * (1.0 - outbreakLitMask * 0.72));
    let v6DarkMult = clamp(1.36 - 0.56 * shroudDark, 0.18, 1.5);
    let v6ShroudUnlit = vec3f(0.036, 0.042, 0.052) * v6DarkMult;
    let v6ShroudLit = vec3f(0.24, 0.19, 0.14) * clamp(1.26 - 0.38 * sightDark, 0.28, 1.35);
    let v6ShroudAlb = vec3f(0.0007, 0.0009, 0.0012) * v6DarkMult;
    let overhaulShroud = max(
      vec3f(0.00010, 0.00022, 0.00055),
      select(colIn, v6ShroudColIn, isV6) * mix(
        select(select(vec3f(0.04, 0.08, 0.18), vec3f(0.12, 0.20, 0.42), isV5), v6ShroudUnlit, isV6),
        select(select(vec3f(0.22, 0.18, 0.14), vec3f(0.44, 0.35, 0.24), isV5), v6ShroudLit, isV6),
        outbreakLitMask,
      ) + outbreakAlbedo * select(select(vec3f(0.0004, 0.0008, 0.0018), vec3f(0.0035, 0.0070, 0.0160), isV5), v6ShroudAlb, isV6),
    );
    let unknownShroud = select(legacyShroud, overhaulShroud, isOverhaul);
    let unrevealed = mix(unknownShroud, roomMem, explored);
    baseFowCol = mix(unrevealed, colIn, visible);
  } else {
    let v4Ext = mix(0.60, 0.88, outbreakLitMask) + (0.40 - 0.12 * outbreakLitMask) * explored;
    let v5Ext = mix(0.88, 1.0, outbreakLitMask) + (0.12 - 0.12 * outbreakLitMask) * explored;
    let v6ExtUnlit = clamp((0.46 + 0.18 * explored) * clamp(1.32 - 0.42 * sightDark, 0.24, 1.35), 0.16, 1.0);
    let v6ExtLit = clamp((0.76 + 0.14 * explored) * clamp(1.16 - 0.22 * sightDark, 0.42, 1.20), 0.35, 1.0);
    let v7DayExt = mix(clamp(0.78 + 0.12 * explored - 0.12 * (sightDark - 1.0), 0.52, 0.98), clamp(0.92 + 0.06 * explored, 0.75, 1.0), outbreakLitMask);
    let v6Ext = select(mix(v6ExtUnlit, v6ExtLit, outbreakLitMask), mix(mix(v6ExtUnlit, v6ExtLit, outbreakLitMask), v7DayExt, dayOrDusk), isV7);
    let extUnexp = select(0.78 + 0.22 * explored, select(select(v4Ext, v5Ext, isV5), v6Ext, isV6), isOverhaul);
    baseFowCol = mix(memoryTone * extUnexp, colIn, visible);
  }

  return applyOutbreakUnseenScene(colIn, baseFowCol, world, n, inRoom, mat, visible, explored, edgeDepth);
}
`
