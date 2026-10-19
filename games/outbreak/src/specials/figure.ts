import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { clamp } from "@arcade/kit/rig"
import {
  SPECIAL_BLOATER,
  SPECIAL_BRUTE,
  SPECIAL_LURKER,
  SPECIAL_RIOT,
  SPECIAL_RUNNER,
  SPECIAL_SCREAMER,
  type SpecialKind,
} from "../../shared/specials/kinds"
import { hex } from "../level"

/**
 * How each special zombie reads inside the blocky Former Townsfolk figure: a body scale, a posture, a palette and a few
 * bone-attached accessories (helmet and shield, swollen belly, hanging jaw, broad shoulders, glowing eyes). The crowd
 * renderer (`src/zombies.ts`) asks `specialLook` per zombie and draws the accessories through `SpecialAccessories`.
 */
export type SpecialLook = {
  /** Whole-body scale about the feet. */
  scale: number
  /** Extra forward pitch of the torso (rad; negative leans back) standing, and moving at full speed. */
  hunch: number
  runHunch: number
  /** How far the hips drop (m). */
  crouch: number
  /** Cloth/skin colours (sRGB) for the refined look: trousers, shirt, skin. */
  trousers: number
  shirt: number
  skin: number
  /** Accessories, by `ACCESSORIES` index. */
  parts: readonly number[]
}

const BIB = 0
const HELMET = 1
const SHIELD = 2
const SHOULDERS = 3
const BELLY = 4
const JAW = 5
const EYES = 6

/** Which bone each accessory rides: 1 torso, 2 head. */
const ACCESSORY_BONE = [1, 2, 1, 1, 1, 2, 2] as const

export const SPECIAL_LOOKS: Readonly<Record<Exclude<SpecialKind, 0>, SpecialLook>> = {
  [SPECIAL_RUNNER]: { scale: 0.96, hunch: 0.08, runHunch: 0.34, crouch: 0, trousers: 0x23262b, shirt: 0x9c3326, skin: 0x9aa18b, parts: [BIB] },
  [SPECIAL_BRUTE]: { scale: 1.28, hunch: 0.14, runHunch: 0.2, crouch: 0.02, trousers: 0x3a3934, shirt: 0x55603f, skin: 0x7b8364, parts: [SHOULDERS] },
  [SPECIAL_SCREAMER]: { scale: 1.0, hunch: 0.02, runHunch: 0.12, crouch: 0, trousers: 0x9a9c90, shirt: 0xb5b6ab, skin: 0xb3baa6, parts: [JAW] },
  [SPECIAL_BLOATER]: { scale: 1.1, hunch: -0.1, runHunch: -0.06, crouch: 0.03, trousers: 0x4a4434, shirt: 0x8f8a58, skin: 0xa3a65e, parts: [BELLY] },
  [SPECIAL_RIOT]: { scale: 1.04, hunch: 0.1, runHunch: 0.18, crouch: 0.02, trousers: 0x1b2230, shirt: 0x1f2a3a, skin: 0x7c8670, parts: [HELMET, SHIELD] },
  [SPECIAL_LURKER]: { scale: 1.0, hunch: 0.62, runHunch: 0.5, crouch: 0.17, trousers: 0x121314, shirt: 0x151617, skin: 0x5d6158, parts: [EYES] },
}

export function specialLook(kind: SpecialKind): SpecialLook | null {
  return kind === 0 ? null : SPECIAL_LOOKS[kind]
}

const linear = (h: number): [number, number, number] => hex(h).map((c) => c ** 2.2) as [number, number, number]
const paletteCache = new Map<number, Float32Array>()

/** Writes a special's palette over the zombie's own (`out` is the renderer's 9 × rgb part tint). */
export function applySpecialPalette(kind: SpecialKind, out: Float32Array): void {
  const look = specialLook(kind)
  if (!look) return
  let p = paletteCache.get(kind)
  if (!p) {
    const t = linear(look.trousers)
    const s = linear(look.shirt)
    const k = linear(look.skin)
    p = new Float32Array([...t, ...s, ...k, ...s, ...k, ...t, ...t, 1, 1, 1, 1, 1, 1])
    paletteCache.set(kind, p)
  }
  out.set(p)
}

/** The extra forward torso pitch for a special moving at `speed` m/s (shrieking Screamers rear back). */
export function specialHunch(kind: SpecialKind, speed: number, state: string): number {
  const look = specialLook(kind)
  if (!look) return 0
  if (kind === SPECIAL_SCREAMER && state === "alert") return -0.5
  const u = clamp(speed / 3.5, 0, 1)
  return look.hunch + (look.runHunch - look.hunch) * u
}

/** How far the head tips back (rad, world pitch): enough to keep a hunched face up; a shrieking Screamer throws it back. */
export function specialHeadLift(kind: SpecialKind, hunch: number, state: string): number {
  if (kind === SPECIAL_SCREAMER && state === "alert") return 0.75
  return hunch * 0.55
}

/** A sleeping Lurker sits lower than an awake one. */
export function specialCrouch(kind: SpecialKind, state: string): number {
  const look = specialLook(kind)
  if (!look) return 0
  return kind === SPECIAL_LURKER && state !== "wander" ? look.crouch * 0.4 : look.crouch
}

/** Bone-local accessory meshes (x forward, y up the bone, z to the side), sized to the Former Townsfolk torso and head. */
function buildAccessories(): Mesh[] {
  const A = MAT.actor
  const bib = new Mesh()
  bib.box(0.15, 0.17, -0.085, 0.163, 0.34, 0.085, hex(0xd8d3c2), A)
  bib.box(0.163, 0.23, -0.04, 0.167, 0.28, 0.04, hex(0x2a2a2a), A)

  const navy = hex(0x1c2432)
  const helmet = new Mesh()
  helmet.bevelBox(-0.095, 0.1, -0.112, 0.135, 0.27, 0.112, 0.035, navy, hex(0x26324a), A)
  helmet.box(0.118, 0.01, -0.1, 0.152, 0.16, 0.1, hex(0x46586c), MAT.glass)
  helmet.box(-0.115, -0.01, -0.1, -0.075, 0.13, 0.1, navy, A)

  const shield = new Mesh()
  const poly = hex(0x29323e)
  shield.box(0.25, -0.44, -0.27, 0.295, 0.6, 0.27, poly, A)
  shield.box(0.295, 0.32, -0.2, 0.3, 0.46, 0.2, hex(0x50627a), MAT.glass)
  shield.box(0.295, 0.08, -0.25, 0.302, 0.15, 0.25, hex(0xb9c1ca), A)

  const shoulders = new Mesh()
  const olive = hex(0x4c5639)
  shoulders.bevelBox(-0.2, 0.28, -0.31, 0.14, 0.53, 0.31, 0.05, olive, hex(0x5a6545), A)
  shoulders.bevelBox(-0.25, 0.08, -0.19, -0.1, 0.5, 0.19, 0.04, olive, olive, A)

  const belly = new Mesh()
  const sick = hex(0x9da15a)
  belly.bevelBox(0.04, -0.02, -0.25, 0.34, 0.4, 0.25, 0.07, sick, hex(0xaeb267), A)
  belly.bevelBox(-0.2, 0.02, -0.29, 0.12, 0.34, 0.29, 0.06, sick, sick, A)
  for (const [y, z] of [
    [0.28, -0.1],
    [0.14, 0.12],
    [0.06, -0.04],
  ] as const) {
    belly.box(0.335, y, z - 0.03, 0.352, y + 0.05, z + 0.03, hex(0xd6dc6c), MAT.glow, 0.35)
  }

  const jaw = new Mesh()
  jaw.box(0.104, -0.02, -0.055, 0.124, 0.05, 0.055, hex(0x2b0f0f), A)
  jaw.box(0.04, -0.15, -0.062, 0.135, -0.015, 0.062, hex(0xa9b19c), A)
  jaw.box(-0.095, -0.22, -0.1, -0.055, 0.2, 0.1, hex(0x2b2621), A)
  for (const z of [-1, 1]) jaw.box(-0.06, -0.14, z * 0.095 - 0.012, 0.05, 0.17, z * 0.095 + 0.012, hex(0x2b2621), A)

  const eyes = new Mesh()
  for (const z of [-0.04, 0.04]) eyes.box(0.112, 0.088, z - 0.019, 0.126, 0.118, z + 0.019, hex(0xffb347), MAT.glow, 1.0)
  return [bib, helmet, shield, shoulders, belly, jaw, eyes]
}

const MAX_PER_ACCESSORY = 256

/** Instanced accessory batches for the crowd renderer, refilled every frame. */
export class SpecialAccessories {
  private readonly batches: Batch[]
  private readonly out: Batch[] = []

  constructor(renderer: Pick<Renderer, "addModel">) {
    this.batches = buildAccessories().map((m) => ({
      model: renderer.addModel(m),
      data: new Float32Array(MAX_PER_ACCESSORY * INST_FLOATS),
      count: 0,
    }))
  }

  begin(): void {
    for (const b of this.batches) b.count = 0
  }

  /**
   * Adds `kind`'s accessories for one zombie from its bone frames (`bones` at `bOff`, 12 floats a bone: p, x, y, z),
   * scaled by `scale` about `(ox, oy, oz)`. `hiddenMask` skips accessories on a lost head.
   */
  emit(
    kind: SpecialKind,
    bones: Float32Array,
    bOff: number,
    hiddenMask: number,
    scale: number,
    ox: number,
    oy: number,
    oz: number,
    shade: number,
    flash: number,
    alpha: number,
  ): void {
    const look = specialLook(kind)
    if (!look) return
    for (const part of look.parts) {
      const bone = ACCESSORY_BONE[part as 0]
      if ((hiddenMask & (1 << bone)) !== 0) continue
      const batch = this.batches[part]!
      if (batch.count >= MAX_PER_ACCESSORY) continue
      const f = bOff + bone * 12
      const xy = bones[f + 4]!
      const p = Math.asin(clamp(xy, -1, 1))
      const c = Math.cos(p)
      const yaw = c > 1e-4 ? Math.atan2(bones[f + 5]!, bones[f + 3]!) : Math.atan2(-bones[f + 9]!, bones[f + 11]!)
      const r = c > 1e-4 ? Math.atan2(-bones[f + 10]!, bones[f + 7]!) : 0
      const o = batch.count++ * INST_FLOATS
      const d = batch.data
      d[o] = ox + (bones[f]! - ox) * scale
      d[o + 1] = oy + (bones[f + 1]! - oy) * scale
      d[o + 2] = oz + (bones[f + 2]! - oz) * scale
      d[o + 3] = yaw
      d[o + 4] = shade
      d[o + 5] = shade
      d[o + 6] = shade
      d[o + 7] = scale
      d[o + 8] = p
      d[o + 9] = r
      d[o + 10] = alpha
      d[o + 11] = flash
    }
  }

  collect(): readonly Batch[] {
    this.out.length = 0
    for (const b of this.batches) if (b.count > 0) this.out.push(b)
    return this.out
  }
}

/** Accessory meshes as built, for tests (`[bib, helmet, shield, shoulders, belly, jaw, eyes]`). */
export function specialAccessoryMeshes(): Mesh[] {
  return buildAccessories()
}
