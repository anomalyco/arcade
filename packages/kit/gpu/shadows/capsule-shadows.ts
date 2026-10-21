import type { LabControl } from "../../lab-panel"
import { LIGHT_FLOATS, MAX_LIGHTS } from "../../limits"

/**
 * Soft character shadows from analytic capsules (Íñigo Quílez's published sphere/capsule occlusion and soft-shadow
 * closed forms, re-derived here; no Shadertoy code is copied).
 *
 * Each character is a dozen capsules taken from its rig bones (`addBoneFrames`, `addBonePose`) or a lying-body
 * approximation (`addLyingBody`). Per frame the CPU picks the few strongest lights reaching each character from the
 * frame's packed lights (sources inside the body, like its own torch or its own flames, are skipped) and rasterises
 * each character into a coarse plan grid around the view: its contact disc plus the plan swept shadow away from each
 * picked light. A pixel reads one grid cell; when characters touch it, it evaluates
 *
 * - contact occlusion: the cosine-weighted solid angle of each capsule's nearest sphere, `cosθ · (r / l)²`, which
 *   gives the soft dark patch under feet, between legs and under a lying body, applied like baked AO (full on
 *   ambient, half on direct light, so darkness stays dark);
 * - a directional soft shadow per picked light: the closest approach `h` between the shadow ray and each capsule
 *   at distance `t` along it, compared with the light's angular radius θ = size / distance, so the penumbra is
 *   `h / t` against θ. It is sharp at the feet (small t), widens toward the tip, and softens as the light comes
 *   closer (contact hardening sized by light distance).
 *
 * The light loop multiplies `capsuleLightVis(i)` into each light's visibility (`SceneHooks.lightVisibility`), so the
 * shadow only exists where that light actually lands. A character never shadows itself, only other bodies do
 * (`capsulePrepare(..., onCharacter)`): boxy meshes poke out of their capsules, so self terms would be acne.
 *
 * Scene binding (group 0): 23 the packed storage buffer (`Renderer.setCapsuleShadows`). WGSL: `capsuleShadowWgsl`.
 */

export const CAPSULE_SHADOW_BINDING = 23
/** Characters per frame; the cells store their index in a byte. */
export const MAX_SHADOW_CHARACTERS = 160
/** Capsules per frame (a standing human is 14). */
export const MAX_SHADOW_CAPSULES = MAX_SHADOW_CHARACTERS * 14
/** Plan grid size (cells per side) and how many characters one cell can list. */
export const CAPSULE_GRID = 32
export const CAPSULE_CELL_SLOTS = 15
/** Lights per character. */
export const CAPSULE_CHARACTER_LIGHTS = 4

const HEADER_VEC4 = 4
const CELLS_AT = HEADER_VEC4
const CHARS_AT = CELLS_AT + CAPSULE_GRID * CAPSULE_GRID
const CAPS_AT = CHARS_AT + MAX_SHADOW_CHARACTERS * 2
/** u32 words in the whole buffer. */
export const CAPSULE_SHADOW_WORDS = (CAPS_AT + MAX_SHADOW_CAPSULES * 2) * 4

export type CapsuleShadowSettings = {
  /** 0 Today (off), 1 soft capsule shadows. */
  mode: number
  /** × contact occlusion under and around bodies (0 none). */
  contact: number
  /** × directional shadow from each light (0 none). */
  shadow: number
  /** × each light's fixture size for the penumbra (larger is softer). */
  lightSize: number
  /** Smallest angular radius a light is treated as, radians (keeps tiny bulbs from cutting razor shadows). */
  minAngle: number
  /** Longest shadow, metres; it fades out over the last 40%. */
  reach: number
  /** Lights per character (1–4), strongest first. */
  lights: number
  /** Weakest light (estimated irradiance at the body) that still casts. */
  minLight: number
  /** × shadow away from the sun or moon (the scene's directional light, `finish(..., sun)`), 0 none. */
  sun: number
  /** Angular radius of the sun or moon for its penumbra, radians (overcast skies want it wide). */
  sunAngle: number
}

export const CAPSULE_SHADOW_DEFAULTS: Readonly<CapsuleShadowSettings> = {
  mode: 0,
  contact: 1,
  shadow: 0.85,
  lightSize: 2.5,
  minAngle: 0.035,
  reach: 5,
  lights: 3,
  minLight: 0.06,
  sun: 0.7,
  sunAngle: 0.06,
}

export function capsuleShadowControls(group: string, subsection?: string): LabControl[] {
  const s = subsection ? { subsection } : {}
  return [
    {
      key: "mode",
      label: "Character shadows",
      group,
      ...s,
      type: "select",
      options: [
        { value: 0, label: "Today (lamp blob + boot AO)" },
        { value: 1, label: "Soft capsule shadows" },
      ],
    },
    { key: "contact", label: "Contact shadow under bodies", group, ...s, min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "shadow", label: "Shadow from each light", group, ...s, min: 0, max: 1, step: 0.05, unit: "×" },
    { key: "lightSize", label: "Light size (penumbra)", group, ...s, min: 0.25, max: 8, step: 0.05, unit: "× fixture" },
    { key: "minAngle", label: "Softest edge floor", group, ...s, min: 0, max: 0.2, step: 0.005, unit: "rad" },
    { key: "reach", label: "Longest shadow", group, ...s, min: 1, max: 12, step: 0.25, unit: "m" },
    { key: "lights", label: "Lights per character", group, ...s, min: 1, max: CAPSULE_CHARACTER_LIGHTS, step: 1 },
    { key: "minLight", label: "Weakest light that casts", group, ...s, min: 0, max: 1, step: 0.01, unit: "" },
    { key: "sun", label: "Shadow from the sun and moon", group, ...s, min: 0, max: 1, step: 0.05, unit: "×" },
    { key: "sunAngle", label: "Sun and moon softness", group, ...s, min: 0.005, max: 0.3, step: 0.005, unit: "rad" },
  ]
}

/** One capsule in bone space: bone index (`boneIds` order), end a, end b, radius. */
type BoneCapsule = readonly [bone: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number]

/**
 * The shared human rig as 14 capsules (`boneIds` order: pelvis 0, torso 1, head 2, upper arms 3/4, forearms 5/6,
 * thighs 7/8, shins 9/10, feet 11/12). Limbs run down their bone's −y; the torso's z is its width; feet point +x.
 */
export const HUMAN_CAPSULES: readonly BoneCapsule[] = [
  [0, 0, 0.02, -0.08, 0, 0.02, 0.08, 0.1],
  [1, 0, 0.06, 0, 0, 0.36, 0, 0.13],
  [1, 0, 0.38, -0.13, 0, 0.38, 0.13, 0.085],
  [2, 0.01, 0.15, 0, 0.01, 0.15, 0, 0.11],
  [3, 0, 0, 0, 0, -0.29, 0, 0.05],
  [4, 0, 0, 0, 0, -0.29, 0, 0.05],
  [5, 0, 0, 0, 0, -0.27, 0, 0.045],
  [6, 0, 0, 0, 0, -0.27, 0, 0.045],
  [7, 0, -0.03, 0, 0, -0.42, 0, 0.075],
  [8, 0, -0.03, 0, 0, -0.42, 0, 0.075],
  [9, 0, 0, 0, 0, -0.41, 0, 0.055],
  [10, 0, 0, 0, 0, -0.41, 0, 0.055],
  [11, -0.04, -0.05, 0, 0.15, -0.06, 0, 0.045],
  [12, -0.04, -0.05, 0, 0.15, -0.06, 0, 0.045],
]

/** Bone order of `HUMAN_CAPSULES` and `addBoneFrames` (the shared rig's `boneIds`). */
const BONE_NAMES = ["pelvis", "torso", "head", "left.upperArm", "right.upperArm", "left.foreArm", "right.foreArm", "left.thigh", "right.thigh", "left.shin", "right.shin", "left.foot", "right.foot"] as const

/** A body lying along its local +x (head) on the ground: torso, head, legs, arms at its side (`yaw` as instance yaw). */
const LYING_CAPSULES: readonly (readonly [number, number, number, number, number, number, number])[] = [
  [-0.02, 0.11, 0, 0.5, 0.11, 0, 0.15],
  [0.72, 0.1, 0.02, 0.72, 0.1, 0.02, 0.1],
  [-0.84, 0.07, -0.12, -0.04, 0.08, -0.1, 0.075],
  [-0.84, 0.07, 0.12, -0.04, 0.08, 0.1, 0.075],
  [0.08, 0.06, -0.26, 0.5, 0.06, -0.24, 0.05],
  [0.08, 0.06, 0.26, 0.5, 0.06, 0.24, 0.05],
]

export type BoneFrameLike = { p: readonly number[]; x: readonly number[]; y: readonly number[]; z: readonly number[] }

/**
 * CPU half: collects characters each frame, picks their lights and fills the grid. Pure (no GPU), so tests and the
 * GPU wrapper share it. Call `begin`, add bodies, then `finish` with the frame's packed lights.
 */
export class CapsuleShadowPacker {
  readonly words = new Uint32Array(CAPSULE_SHADOW_WORDS)
  readonly floats = new Float32Array(this.words.buffer)
  private chars = 0
  private caps = 0
  /** Characters added this frame (some may have been dropped at the limit). */
  get characterCount(): number {
    return this.chars
  }
  get capsuleCount(): number {
    return this.caps
  }
  private readonly lo = new Float32Array(MAX_SHADOW_CHARACTERS * 3)
  private readonly hi = new Float32Array(MAX_SHADOW_CHARACTERS * 3)
  /** Plan rect (x0, z0, x1, z1) the grid covers this frame. */
  private rect: readonly [number, number, number, number] = [0, 0, 1, 1]
  private open = false
  private charStart = 0

  /** Starts a frame over the plan rect the camera sees (x, z). */
  begin(rect: readonly [number, number, number, number]): void {
    this.rect = rect
    this.chars = 0
    this.caps = 0
    this.open = false
  }

  private startCharacter(): boolean {
    if (this.chars >= MAX_SHADOW_CHARACTERS || this.caps + 16 > MAX_SHADOW_CAPSULES) return false
    this.open = true
    this.charStart = this.caps
    const i = this.chars * 3
    this.lo[i] = this.lo[i + 1] = this.lo[i + 2] = Infinity
    this.hi[i] = this.hi[i + 1] = this.hi[i + 2] = -Infinity
    return true
  }

  private capsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): void {
    const o = (CAPS_AT + this.caps * 2) * 4
    const f = this.floats
    f[o] = ax
    f[o + 1] = ay
    f[o + 2] = az
    f[o + 3] = r
    f[o + 4] = bx
    f[o + 5] = by
    f[o + 6] = bz
    f[o + 7] = 0
    this.caps++
    const i = this.chars * 3
    const lo = this.lo
    const hi = this.hi
    lo[i] = Math.min(lo[i]!, ax - r, bx - r)
    lo[i + 1] = Math.min(lo[i + 1]!, ay - r, by - r)
    lo[i + 2] = Math.min(lo[i + 2]!, az - r, bz - r)
    hi[i] = Math.max(hi[i]!, ax + r, bx + r)
    hi[i + 1] = Math.max(hi[i + 1]!, ay + r, by + r)
    hi[i + 2] = Math.max(hi[i + 2]!, az + r, bz + r)
  }

  private endCharacter(): void {
    if (!this.open) return
    this.open = false
    if (this.caps === this.charStart) return
    const i = this.chars * 3
    const cx = (this.lo[i]! + this.hi[i]!) / 2
    const cy = (this.lo[i + 1]! + this.hi[i + 1]!) / 2
    const cz = (this.lo[i + 2]! + this.hi[i + 2]!) / 2
    const r = Math.hypot(this.hi[i]! - cx, this.hi[i + 1]! - cy, this.hi[i + 2]! - cz)
    const o = (CHARS_AT + this.chars * 2) * 4
    this.floats[o] = cx
    this.floats[o + 1] = cy
    this.floats[o + 2] = cz
    this.floats[o + 3] = r
    this.words[o + 4] = 0
    this.words[o + 5] = this.charStart
    this.words[o + 6] = this.caps - this.charStart
    this.words[o + 7] = 0
    this.chars++
  }

  /**
   * A rig body from flat bone frames (12 floats per bone: p, x, y, z, in `boneIds` order from `off`). Bones whose bit
   * is set in `hidden` (1 << bone index) are skipped. `scale` scales the body about `origin` (a special's size).
   */
  addBoneFrames(buf: ArrayLike<number>, off: number, hidden = 0, scale = 1, origin?: readonly [number, number, number]): void {
    if (!this.startCharacter()) return
    const ox = origin?.[0] ?? 0
    const oy = origin?.[1] ?? 0
    const oz = origin?.[2] ?? 0
    for (const c of HUMAN_CAPSULES) {
      const bone = c[0]
      if (hidden & (1 << bone)) continue
      const o = off + bone * 12
      const px = buf[o]!
      const py = buf[o + 1]!
      const pz = buf[o + 2]!
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue
      const at = (lx: number, ly: number, lz: number, k: number) => {
        const w = buf[o + 3]! * lx + buf[o + 6]! * ly + buf[o + 9]! * lz
        const v = buf[o + 4]! * lx + buf[o + 7]! * ly + buf[o + 10]! * lz
        const u = buf[o + 5]! * lx + buf[o + 8]! * ly + buf[o + 11]! * lz
        const x = px + w
        const y = py + v
        const z = pz + u
        return k === 0 ? ox + (x - ox) * scale : k === 1 ? oy + (y - oy) * scale : oz + (z - oz) * scale
      }
      this.capsule(at(c[1], c[2], c[3], 0), at(c[1], c[2], c[3], 1), at(c[1], c[2], c[3], 2), at(c[4], c[5], c[6], 0), at(c[4], c[5], c[6], 1), at(c[4], c[5], c[6], 2), c[7] * scale)
    }
    this.endCharacter()
  }

  private readonly scratch = new Float32Array(BONE_NAMES.length * 12)

  /** A rig body from a pose object (`BonePose`); missing bones are skipped. */
  addBonePose(pose: Partial<Record<string, BoneFrameLike | null | undefined>>, hidden = 0): void {
    const s = this.scratch
    let mask = hidden
    for (let b = 0; b < BONE_NAMES.length; b++) {
      const f = pose[BONE_NAMES[b]!]
      if (!f) {
        mask |= 1 << b
        continue
      }
      const o = b * 12
      s[o] = f.p[0]!
      s[o + 1] = f.p[1]!
      s[o + 2] = f.p[2]!
      s[o + 3] = f.x[0]!
      s[o + 4] = f.x[1]!
      s[o + 5] = f.x[2]!
      s[o + 6] = f.y[0]!
      s[o + 7] = f.y[1]!
      s[o + 8] = f.y[2]!
      s[o + 9] = f.z[0]!
      s[o + 10] = f.z[1]!
      s[o + 11] = f.z[2]!
    }
    this.addBoneFrames(s, 0, mask)
  }

  /** A body lying on the ground at (x, y, z) with its head along instance `yaw` (the kit's part yaw). */
  addLyingBody(x: number, y: number, z: number, yaw: number, scale = 1): void {
    if (!this.startCharacter()) return
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    for (const k of LYING_CAPSULES) {
      this.capsule(
        x + (k[0] * c - k[2] * s) * scale,
        y + k[1] * scale,
        z + (k[0] * s + k[2] * c) * scale,
        x + (k[3] * c - k[5] * s) * scale,
        y + k[4] * scale,
        z + (k[3] * s + k[5] * c) * scale,
        k[6] * scale,
      )
    }
    this.endCharacter()
  }

  /**
   * Picks each character's lights from the frame's packed lights (`LIGHT_FLOATS` each, `count` of them), fills the
   * grid and the header. `sun` is the unit direction toward the sun or moon (null for none). Returns how many u32
   * words to upload (the header alone when off).
   */
  finish(lights: Float32Array, count: number, settings: CapsuleShadowSettings, sun: readonly [number, number, number] | null = null): number {
    this.endCharacter()
    const f = this.floats
    const w = this.words
    const on = settings.mode > 0.5 && this.chars > 0
    const [x0, z0, x1, z1] = this.rect
    const extent = Math.max(x1 - x0, z1 - z0, 1)
    const cell = Math.max(1.5, extent / CAPSULE_GRID)
    // Centre the grid on the view rect.
    const gx = (x0 + x1) / 2 - (cell * CAPSULE_GRID) / 2
    const gz = (z0 + z1) / 2 - (cell * CAPSULE_GRID) / 2
    f[0] = gx
    f[1] = gz
    f[2] = 1 / cell
    f[3] = on ? CAPSULE_GRID : 0
    f[4] = Math.max(0, settings.contact)
    f[5] = Math.max(0, Math.min(1, settings.shadow))
    f[6] = Math.max(0, settings.lightSize)
    f[7] = Math.max(0, settings.minAngle)
    f[8] = Math.max(0.5, settings.reach)
    f[10] = this.chars
    f[11] = 0
    // The sun or moon: direction toward it and its angular radius (0 off). Below ~8° its shadows would run off forever.
    const sunOn = !!sun && sun[1] > 0.14 && settings.sun > 0
    f[12] = sunOn ? sun[0] : 0
    f[13] = sunOn ? sun[1] : 1
    f[14] = sunOn ? sun[2] : 0
    f[15] = sunOn ? Math.max(0.002, settings.sunAngle) : 0
    f[9] = sunOn ? Math.min(1, settings.sun) : 0
    if (!on) return HEADER_VEC4 * 4
    w.fill(0, CELLS_AT * 4, CHARS_AT * 4)
    const maxLights = Math.max(1, Math.min(CAPSULE_CHARACTER_LIGHTS, Math.round(settings.lights)))
    const n = Math.min(count, MAX_LIGHTS)
    const pickI = [0, 0, 0, 0]
    const pickS = [0, 0, 0, 0]
    for (let c = 0; c < this.chars; c++) {
      const o = (CHARS_AT + c * 2) * 4
      const cx = f[o]!
      const cy = f[o + 1]!
      const cz = f[o + 2]!
      const br = f[o + 3]!
      const top = cy + br * 0.85
      let picked = 0
      for (let i = 0; i < n; i++) {
        const L = i * LIGHT_FLOATS
        const power = lights[L + 7]!
        if (!(power > 0.001)) continue
        const lx = lights[L]!
        const lh = lights[L + 1]!
        const lz = lights[L + 2]!
        const radius = lights[L + 3]!
        const dx = cx - lx
        const dz = cz - lz
        const dPlan2 = dx * dx + dz * dz
        if (dPlan2 >= radius * radius) continue
        // A source inside the body (its own torch, its own flames) would shadow everything around it.
        if (dPlan2 < 0.6 * 0.6 && lh < top + 0.3) continue
        const coneKind = lights[L + 11]!
        if (coneKind > 0.5 && coneKind < 4.5 && dPlan2 > 1e-6) {
          const d = Math.sqrt(dPlan2)
          const along = (dx * lights[L + 8]! + dz * lights[L + 9]!) / d
          if (coneKind < 1.5 && along < lights[L + 10]! - 0.2) continue
          if (along < -0.2) continue
        }
        const dy = lh - cy
        const d3 = Math.max(0.5, Math.sqrt(dPlan2 + dy * dy))
        const win = (1 - dPlan2 / (radius * radius)) ** 2
        const strength = (power * win * 2.6) / (1 + d3 * d3 * 0.3)
        if (strength < settings.minLight) continue
        // Insert into the strongest-first pick list.
        let k = Math.min(picked, maxLights - 1)
        if (picked === maxLights && strength <= pickS[k]!) continue
        while (k > 0 && pickS[k - 1]! < strength) {
          pickS[k] = pickS[k - 1]!
          pickI[k] = pickI[k - 1]!
          k--
        }
        pickS[k] = strength
        pickI[k] = i
        if (picked < maxLights) picked++
      }
      let packed = 0
      for (let k = 0; k < picked; k++) packed |= (pickI[k]! + 1) << (k * 8)
      w[o + 4] = packed >>> 0
      // Contact disc, then the plan shadow away from each light.
      this.raster(c, cx, cz, cx, cz, br + 0.35, cell, gx, gz)
      for (let k = 0; k < picked; k++) {
        const L = pickI[k]! * LIGHT_FLOATS
        const lx = lights[L]!
        const lh = lights[L + 1]!
        const lz = lights[L + 2]!
        const dx = cx - lx
        const dz = cz - lz
        const d = Math.hypot(dx, dz)
        if (d < 1e-3) continue
        const len = lh > top + 0.05 ? Math.min(settings.reach, (d * top) / (lh - top)) : settings.reach
        const ex = cx + (dx / d) * len
        const ez = cz + (dz / d) * len
        this.raster(c, cx, cz, ex, ez, br + 0.25 + len * 0.15, cell, gx, gz)
      }
      if (sunOn) {
        const horiz = Math.hypot(sun[0], sun[2])
        if (horiz > 1e-3) {
          const len = Math.min(settings.reach, (top * horiz) / sun[1])
          this.raster(c, cx, cz, cx - (sun[0] / horiz) * len, cz - (sun[2] / horiz) * len, br + 0.2 + len * settings.sunAngle, cell, gx, gz)
        }
      }
    }
    return (CAPS_AT + this.caps * 2) * 4
  }

  /** Lists character `c` in every cell within `rad` of the plan segment (ax, az)–(bx, bz). */
  private raster(c: number, ax: number, az: number, bx: number, bz: number, rad: number, cell: number, gx: number, gz: number): void {
    const half = cell * 0.7072
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - rad - gx) / cell))
    const i1 = Math.min(CAPSULE_GRID - 1, Math.floor((Math.max(ax, bx) + rad - gx) / cell))
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - rad - gz) / cell))
    const j1 = Math.min(CAPSULE_GRID - 1, Math.floor((Math.max(az, bz) + rad - gz) / cell))
    const vx = bx - ax
    const vz = bz - az
    const vv = vx * vx + vz * vz
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = gx + (i + 0.5) * cell
        const pz = gz + (j + 0.5) * cell
        const t = vv > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / vv)) : 0
        if (Math.hypot(px - ax - vx * t, pz - az - vz * t) > rad + half) continue
        this.list(CELLS_AT + j * CAPSULE_GRID + i, c)
      }
    }
  }

  private list(cellVec: number, c: number): void {
    const w = this.words
    const o = cellVec * 4
    const n = w[o]! & 0xff
    // Already listed (the contact disc and a shadow overlap): the last entry is this character, as they come in order.
    if (n > 0) {
      const last = (w[o + ((n) >> 2)]! >>> ((n & 3) * 8)) & 0xff
      if (last === c) return
    }
    if (n >= CAPSULE_CELL_SLOTS) return
    const slot = n + 1
    w[o + (slot >> 2)] = (w[o + (slot >> 2)]! | (c << ((slot & 3) * 8))) >>> 0
    w[o] = ((w[o]! & ~0xff) | (n + 1)) >>> 0
  }
}

/** GPU half: owns the storage buffer bound at `CAPSULE_SHADOW_BINDING` and uploads what `finish` filled. */
export class CapsuleShadows extends CapsuleShadowPacker {
  readonly buffer: GPUBuffer

  constructor(private readonly device: GPUDevice) {
    super()
    this.buffer = device.createBuffer({ label: "capsule shadows", size: CAPSULE_SHADOW_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  }

  /** Picks lights, fills the grid and uploads the used part. */
  upload(lights: Float32Array, count: number, settings: CapsuleShadowSettings, sun: readonly [number, number, number] | null = null): void {
    const words = this.finish(lights, count, settings, sun)
    this.device.queue.writeBuffer(this.buffer, 0, this.words.buffer, 0, words * 4)
  }
}

/**
 * WGSL for scenes that bind the buffer. Call `capsulePrepare(world, n, onCharacter)` once per fragment before the light
 * loop (Outbreak: the `material` hook), multiply `capsuleOcclusion` into ambient occlusion (`SceneHooks.occlusion`)
 * and `capsuleLightVis(i)` into each light's visibility (`SceneHooks.lightVisibility`). Needs the kit's `lights`.
 */
export const capsuleShadowWgsl = /* wgsl */ `
@group(0) @binding(${CAPSULE_SHADOW_BINDING}) var<storage, read> capsuleShadow: array<vec4u>;
/** Light index + 1 per tracked light this fragment (0 = none) and its capsule visibility. */
var<private> capsuleLights: vec4u;
var<private> capsuleVisAt: vec4f;
/** Contact occlusion from nearby bodies (1 = none). */
var<private> capsuleOcclusion: f32;
/** Visibility of the sun or moon past nearby bodies (1 = none). */
var<private> capsuleSun: f32;

fn capsuleF(i: u32) -> vec4f { return bitcast<vec4f>(capsuleShadow[i]); }

/** True when soft capsule shadows are on this frame. */
fn capsuleShadowsOn() -> bool { return capsuleF(0u).w > 0.5; }

/** Closest point on the segment a..b to p. */
fn capsuleNearest(p: vec3f, a: vec3f, b: vec3f) -> vec3f {
  let ba = b - a;
  return a + ba * clamp(dot(p - a, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
}

/**
 * Soft visibility of a light of angular radius theta along the unit ray o + rd·t (t ≤ tMax) past one capsule: the
 * gap h between the ray and the capsule at their closest approach, as an angle h / t against theta.
 */
fn capsuleSoftVis(o: vec3f, rd: vec3f, tMax: f32, a: vec3f, b: vec3f, r: f32, theta: f32) -> f32 {
  let ba = b - a;
  let oa = o - a;
  let baba = max(dot(ba, ba), 1e-8);
  let bard = dot(ba, rd);
  let den = baba - bard * bard;
  var s = 0.0;
  if (den > 1e-6) {
    let t0 = (bard * dot(ba, oa) - dot(rd, oa) * baba) / den;
    s = clamp((dot(ba, oa) + bard * t0) / baba, 0.0, 1.0);
  }
  let q = a + ba * s;
  let t = clamp(dot(q - o, rd), 1e-3, tMax);
  if (t >= tMax) { return 1.0; }
  let h = length(o + rd * t - q) - r;
  let k = clamp(0.5 + 0.5 * h / (t * theta), 0.0, 1.0);
  return k * k * (3.0 - 2.0 * k);
}

fn capsuleTrack(li: u32, v: f32) {
  for (var m = 0u; m < 4u; m++) {
    if (capsuleLights[m] == li) { capsuleVisAt[m] *= v; return; }
    if (capsuleLights[m] == 0u) { capsuleLights[m] = li; capsuleVisAt[m] = v; return; }
  }
}

/**
 * Contact occlusion and per-light capsule visibility at a surface point. onCharacter: the surface is a body, so the
 * body it belongs to is skipped (only other bodies shadow it).
 */
fn capsulePrepare(world: vec3f, n: vec3f, onCharacter: bool) {
  capsuleLights = vec4u(0u);
  capsuleVisAt = vec4f(1.0);
  capsuleOcclusion = 1.0;
  capsuleSun = 1.0;
  let head = capsuleF(0u);
  if (head.w < 0.5) { return; }
  let gn = i32(head.w);
  let cellXY = vec2i(floor((world.xz - head.xy) * head.z));
  if (any(cellXY < vec2i(0)) || any(cellXY >= vec2i(gn))) { return; }
  let cell = capsuleShadow[${CELLS_AT}u + u32(cellXY.y * gn + cellXY.x)];
  let count = cell.x & 0xffu;
  if (count == 0u) { return; }
  let P = capsuleF(1u);
  let P2 = capsuleF(2u);
  let reach = P2.x;
  let sun = capsuleF(3u);
  let o = world + n * 0.03;
  var occ = 1.0;
  for (var k = 1u; k <= count; k++) {
    let ci = (cell[k >> 2u] >> ((k & 3u) * 8u)) & 0xffu;
    let base = ${CHARS_AT}u + ci * 2u;
    let bound = capsuleF(base);
    let info = capsuleShadow[base + 1u];
    let first = ${CAPS_AT}u + info.y * 2u;
    let nCaps = info.z;
    let rel = world - bound.xyz;
    // A body never shadows itself: its boxy mesh pokes out of the capsules, so self terms would be acne.
    if (onCharacter && dot(rel, rel) < (bound.w + 0.15) * (bound.w + 0.15)) {
      var own = false;
      for (var c = 0u; c < nCaps; c++) {
        let A = capsuleF(first + c * 2u);
        if (length(capsuleNearest(world, A.xyz, capsuleF(first + c * 2u + 1u).xyz) - world) < A.w + 0.12) { own = true; break; }
      }
      if (own) { continue; }
    }
    // Contact: each capsule's nearest sphere, cosine-weighted solid angle (r / l)².
    if (P.x > 0.0 && dot(rel, rel) < (bound.w + 0.5) * (bound.w + 0.5)) {
      for (var c = 0u; c < nCaps; c++) {
        let A = capsuleF(first + c * 2u);
        let B = capsuleF(first + c * 2u + 1u);
        let d = capsuleNearest(world, A.xyz, B.xyz) - world;
        let l = max(length(d), 1e-4);
        let r = A.w / max(l, A.w);
        occ *= 1.0 - clamp(max(dot(d / l, n), 0.0) * r * r * P.x, 0.0, 1.0);
      }
    }
    let fade = 1.0 - smoothstep(reach * 0.6, reach, length(rel.xz));
    if (fade <= 0.0) { continue; }
    if (sun.w > 0.0) {
      let tc = max(dot(bound.xyz - o, sun.xyz), 0.0);
      if (length(o + sun.xyz * tc - bound.xyz) < bound.w + sun.w * tc + 0.05) {
        var v = 1.0;
        for (var c = 0u; c < nCaps; c++) {
          let A = capsuleF(first + c * 2u);
          let B = capsuleF(first + c * 2u + 1u);
          v = min(v, capsuleSoftVis(o, sun.xyz, 1e4, A.xyz, B.xyz, A.w, sun.w));
        }
        capsuleSun *= mix(1.0, v, P2.y * fade);
      }
    }
    if (P.y <= 0.0) { continue; }
    for (var j = 0u; j < ${CAPSULE_CHARACTER_LIGHTS}u; j++) {
      let li = (info.x >> (j * 8u)) & 0xffu;
      if (li == 0u) { break; }
      let L = lights[li - 1u];
      let toL = L.pos.xyz - o;
      let tl = length(toL);
      if (tl < 0.05) { continue; }
      let rd = toL / tl;
      let theta = max(L.extra.z * P.z / tl, P.w);
      // The shadow ray misses the body's bounding sphere (with its penumbra): nothing to do.
      let tc = clamp(dot(bound.xyz - o, rd), 0.0, tl);
      if (length(o + rd * tc - bound.xyz) > bound.w + theta * tc + 0.05) { continue; }
      var v = 1.0;
      for (var c = 0u; c < nCaps; c++) {
        let A = capsuleF(first + c * 2u);
        let B = capsuleF(first + c * 2u + 1u);
        v = min(v, capsuleSoftVis(o, rd, tl, A.xyz, B.xyz, A.w, theta));
      }
      if (v < 0.999) { capsuleTrack(li, mix(1.0, v, P.y * fade)); }
    }
  }
  capsuleOcclusion = occ;
}

/** Capsule visibility of light i at this fragment (1 when no tracked body shadows it). */
fn capsuleLightVis(i: u32) -> f32 {
  if (capsuleLights.x == 0u) { return 1.0; }
  let k = i + 1u;
  return select(1.0, capsuleVisAt.x, capsuleLights.x == k) * select(1.0, capsuleVisAt.y, capsuleLights.y == k)
    * select(1.0, capsuleVisAt.z, capsuleLights.z == k) * select(1.0, capsuleVisAt.w, capsuleLights.w == k);
}
`
