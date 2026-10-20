import type { Camera } from "@arcade/kit/client/camera"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, SPRITE_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import {
  boneIds,
  detach,
  type BoneId,
  type BonePose,
} from "@arcade/kit/human-pose"
import { humanProfiles, type HumanProfile } from "@arcade/kit/human-profile"
import {
  resolveDragFoot,
  shambleHandsFK,
  shambleTorsoModulation,
} from "@arcade/kit/shamble-crouch"
import {
  clamp,
  HIP,
  RIG,
  smooth,
  smoother,
  type Frame,
  type V3,
} from "@arcade/kit/rig"
import { angleDiff } from "@arcade/kit/sim/geom"
import type { AIAgent, AIConfig, NoiseEvent } from "../shared/ai"
import type { Vision } from "../shared/vision"
import { hex } from "./level"
import {
  townsfolkZombieMeshes,
  ZOMBIE_ARCHETYPES,
  ZOMBIE_BOOT,
  ZOMBIE_SLIPPERS,
  zombieCallingArchetype,
  zombiePalette,
} from "./look/refined-figure"
import { callingIndexOf, walksEmptyLeash, zombieHash } from "../shared/characters/callings"
import type { HabitKind } from "../shared/characters/sites"
import { CharacterAccessories } from "./characters/accessories"
import type { ZombieCharacterFrame } from "./characters/frame"
import { specialKindOf, SPECIAL_LURKER, type SpecialKind } from "../shared/specials/kinds"
import { applySpecialPalette, SpecialAccessories, specialCrouch, specialHeadLift, specialHunch, specialLook } from "./specials/figure"
import { zombieProfile, type ZombieTuning } from "./zombie-profile"
import { STRIKE_TIME, strikeEnvelope } from "./zombie-strikes"

export type DetachedDebrisPiece = {
  partIndex: number
  p: V3
  v: V3
  yaw: number
  pitchAngle: number
  rollAngle: number
  w: V3
  age: number
  life: number
}

/**
 * Body physics a client feature lays over the procedural zombie (`src/impact/`): directional hit reactions on the
 * living and ragdolls for the dead. Presentation only. Bones are this renderer's 15-frame layout.
 */
export interface ZombieBodyPhysics {
  /** × the canned stagger pose (1 = today's). */
  readonly cannedStagger: number
  /** Once per draw, before any zombie: advances reactions by the drawn (hit-stopped) `dt`. */
  begin(dt: number): void
  /** The hit reaction to layer on a living zombie facing `yaw` this frame, or null when it is at rest. */
  react(agentId: number, yaw: number): ZombieHitPose | null
  /**
   * Poses a dead zombie from its ragdoll into `bones` at `off` (which still holds the pose from two frames ago;
   * `prevBones` holds the last frame's). False leaves it to the canned collapse.
   */
  corpse(agent: AIAgent, bones: Float32Array, prevBones: Float32Array, off: number, dt: number, support: (x: number, z: number) => number): boolean
}

export type ZombieHitPose = { pitch: number; roll: number; twist: number; headPitch: number; headRoll: number; headYaw: number; drop: number }

const PART_COUNT = 9
const ARCH_COUNT = ZOMBIE_ARCHETYPES.length
const ARCH_PART_COUNT = 3
const ARCH_BUCKET_COUNT = ARCH_COUNT * ARCH_PART_COUNT
const MAX_INSTANCES_PER_ARCH = 1024
export const MAX_INSTANCES_PER_PART = 4096
const BONE_COUNT = 15
const BONE_STRIDE = BONE_COUNT * 12
const INITIAL_AGENT_CAPACITY = 512
const CALLING_ROBE = callingIndexOf("robe")
const CALLING_JOGGER = callingIndexOf("jogger")
const CALLING_BRIDE = callingIndexOf("bride")
const linearHex = (h: number): [number, number, number] => hex(h).map((c) => c ** 2.2) as [number, number, number]
const BOOT_TINT = linearHex(ZOMBIE_BOOT)

/**
 * A habit's pose this frame (AR-88), added on top of the standing shamble: torso and head offsets (rad; negative
 * pitch leans forward and looks down, as everywhere in this file) and where each hand goes, from the shoulder in the
 * torso's frame (forward, up, out), with a blend weight. Written by `habitPose`, read by the upright pass.
 */
type HabitPose = {
  torsoPitch: number
  torsoRoll: number
  headPitch: number
  headRoll: number
  headYaw: number
  hand: [Float64Array, Float64Array]
  handW: [number, number]
}

const KNOCK_PERIOD = 2.6
/** Three slow blows, timed to the soundscape's `scape.habit.knock` (struck once a cycle, at 0). */
const KNOCK_TIMES = [0.02, 0.64, 1.41] as const
const BED_PERIOD = (Math.PI * 2) / 0.9
const FENCE_PERIOD = 3.4
/** Waltz time: a sway each way per bar of the gramophone's 3/4 at 0.4 s a beat. */
const DANCE_PERIOD = 2.4

/** When in its cycle each habit makes the sound someone could hear (period, phase, both s); the wedding is a held loop. */
const HABIT_CUES: Partial<Record<HabitKind, readonly [number, number]>> = {
  knock: [KNOCK_PERIOD, 0],
  stove: [7.3, 2.1],
  // At the sway's peak, as the weight goes over onto the mattress.
  bed: [BED_PERIOD, BED_PERIOD / 4],
  // At the hardest pull on the wire.
  fence: [FENCE_PERIOD, FENCE_PERIOD / 4],
}

function crossed(p0: number, p1: number, at: number): boolean {
  return (p0 < at && p1 >= at) || (p1 < p0 && (at > p0 || at <= p1))
}

/** How far into a knock (0..1, 1 at the contact) the hand is at time `t` into the cycle. */
function knockEnvelope(t: number): number {
  let best = 0
  for (const k of KNOCK_TIMES) {
    const d = t - k
    if (d > -0.16 && d < 0.1) best = Math.max(best, d < 0 ? 1 - (-d / 0.16) ** 2 : 1 - d / 0.1)
  }
  return Math.max(0, best)
}

/** The clock a habit runs on: the wedding pair share the world's, everyone else is offset by their id. */
function habitTime(kind: HabitKind, time: number, id: number): number {
  return kind === "bride" || kind === "groom" ? time : time + (id % 7) * 0.37
}

/** Fills `out` with habit `kind`'s pose at time `t` (s) for a zombie whose dominant hand is `hand` (0 left, 1 right). */
function habitPose(kind: HabitKind, t: number, hand: 0 | 1, out: HabitPose): void {
  out.torsoPitch = out.torsoRoll = out.headPitch = out.headRoll = out.headYaw = 0
  out.handW[0] = out.handW[1] = 0
  const set = (i: 0 | 1, f: number, u: number, l: number, w: number) => {
    const h = out.hand[i]
    h[0] = f
    h[1] = u
    h[2] = l
    out.handW[i] = w
  }
  const other = (1 - hand) as 0 | 1
  if (kind === "knock") {
    // Three knocks, a rest, again: knuckles to the door at head height, forehead dropping toward the wood.
    const k = knockEnvelope(t % KNOCK_PERIOD)
    set(hand, 0.46 + 0.12 * k, 0.12 + 0.02 * k, 0.02, 1)
    set(other, 0.18, -0.42, 0.06, 0.55)
    out.torsoPitch = -0.1 - 0.03 * k
    out.headPitch = -0.28
    out.headRoll = 0.08
  } else if (kind === "fence") {
    // Both hands through the wire, rattling it; every few seconds a hard pull back.
    const tug = Math.max(0, Math.sin((t * Math.PI * 2) / FENCE_PERIOD)) ** 6
    const rattle = Math.sin(t * 43) * 0.018
    set(0, 0.54 - 0.12 * tug + rattle, -0.06, 0.08, 1)
    set(1, 0.54 - 0.12 * tug - rattle, -0.04, 0.08, 1)
    out.torsoPitch = -0.16 + 0.24 * tug
    out.headPitch = -0.08 + 0.12 * tug
  } else if (kind === "stove") {
    // Stirring a pan that is not there, slowly, looking down into it.
    const a = t * 1.7
    set(hand, 0.36 + 0.06 * Math.cos(a), -0.2, 0.06 * Math.sin(a), 1)
    set(other, 0.3, -0.26, -0.02, 0.8)
    out.torsoPitch = -0.18
    out.headPitch = -0.42
  } else if (kind === "bed") {
    // Standing over the bed, hands hanging, head bowed, swaying.
    set(0, 0.14, -0.5, 0.02, 0.85)
    set(1, 0.14, -0.5, 0.02, 0.85)
    out.torsoPitch = -0.3
    out.headPitch = -0.55
    out.torsoRoll = 0.06 * Math.sin((t * Math.PI * 2) / BED_PERIOD)
    out.headRoll = 0.1 * Math.sin((t * Math.PI * 2) / BED_PERIOD - 0.5)
  } else {
    // Bride and groom: slow-dancing, hands out to each other, swaying the same way in the world (mirrored in each).
    const sway = Math.sin((t * Math.PI * 2) / DANCE_PERIOD) * (kind === "bride" ? 1 : -1)
    set(0, 0.3, -0.08, -0.06, 0.9)
    set(1, 0.3, -0.08, -0.06, 0.9)
    out.torsoRoll = 0.07 * sway
    out.headRoll = 0.12 * sway
    out.headPitch = -0.1
  }
}

const BONE_TO_PART: Record<BoneId, number> = {
  pelvis: 0,
  torso: 1,
  head: 2,
  "left.upperArm": 3,
  "right.upperArm": 3,
  "left.foreArm": 4,
  "right.foreArm": 4,
  "left.thigh": 5,
  "right.thigh": 5,
  "left.shin": 6,
  "right.shin": 6,
  "left.foot": 7,
  "right.foot": 7,
  "left.toe": 8,
  "right.toe": 8,
}

const BONE_INDEX_TO_PART = [0, 1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]

const BONE_SUBTREE_MASK: Record<BoneId, number> = {
  pelvis: 0x7fff,
  torso: 0b0000001111110,
  head: 1 << 2,
  "left.upperArm": (1 << 3) | (1 << 5),
  "right.upperArm": (1 << 4) | (1 << 6),
  "left.foreArm": 1 << 5,
  "right.foreArm": 1 << 6,
  "left.thigh": (1 << 7) | (1 << 9) | (1 << 11) | (1 << 13),
  "right.thigh": (1 << 8) | (1 << 10) | (1 << 12) | (1 << 14),
  "left.shin": (1 << 9) | (1 << 11) | (1 << 13),
  "right.shin": (1 << 10) | (1 << 12) | (1 << 14),
  "left.foot": (1 << 11) | (1 << 13),
  "right.foot": (1 << 12) | (1 << 14),
  "left.toe": 1 << 13,
  "right.toe": 1 << 14,
}

function frameAngles(f: Frame): [number, number, number] {
  const p = Math.asin(clamp(f.x[1], -1, 1))
  const c = Math.cos(p)
  const yaw = c > 1e-4 ? Math.atan2(f.x[2], f.x[0]) : Math.atan2(-f.z[0], f.z[2])
  const r = c > 1e-4 ? Math.atan2(-f.z[1], f.y[1]) : 0
  return [yaw, p, r]
}

function writeYawFrame(buf: Float32Array, off: number, px: number, py: number, pz: number, yaw: number): void {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  buf[off] = px
  buf[off + 1] = py
  buf[off + 2] = pz
  buf[off + 3] = c
  buf[off + 4] = 0
  buf[off + 5] = s
  buf[off + 6] = 0
  buf[off + 7] = 1
  buf[off + 8] = 0
  buf[off + 9] = -s
  buf[off + 10] = 0
  buf[off + 11] = c
}

function turnAxisInPlace(buf: Float32Array, off: number, axisOff: number, a: number): void {
  if (Math.abs(a) < 1e-6) return
  const c = Math.cos(a)
  const s = Math.sin(a)
  const omc = 1 - c
  const kx = buf[off + axisOff]!
  const ky = buf[off + axisOff + 1]!
  const kz = buf[off + axisOff + 2]!
  for (let vOff = 3; vOff <= 9; vOff += 3) {
    const vx = buf[off + vOff]!
    const vy = buf[off + vOff + 1]!
    const vz = buf[off + vOff + 2]!
    const kvx = ky * vz - kz * vy
    const kvy = kz * vx - kx * vz
    const kvz = kx * vy - ky * vx
    const d = (kx * vx + ky * vy + kz * vz) * omc
    buf[off + vOff] = vx * c + kvx * s + kx * d
    buf[off + vOff + 1] = vy * c + kvy * s + ky * d
    buf[off + vOff + 2] = vz * c + kvz * s + kz * d
  }
}

function pitchInPlace(buf: Float32Array, off: number, a: number): void {
  turnAxisInPlace(buf, off, 9, a)
}

function rollInPlace(buf: Float32Array, off: number, a: number): void {
  turnAxisInPlace(buf, off, 3, a)
}

function writeLimbFrame(
  buf: Float32Array,
  off: number,
  ox: number,
  oy: number,
  oz: number,
  ex: number,
  ey: number,
  ez: number,
  rx: number,
  ry: number,
  rz: number,
  r2x: number,
  r2y: number,
  r2z: number,
): void {
  const dyx = ox - ex
  const dyy = oy - ey
  const dyz = oz - ez
  const yl = Math.hypot(dyx, dyy, dyz) || 1
  const yx = dyx / yl
  const yy = dyy / yl
  const yz = dyz / yl
  const dot1 = rx * yx + ry * yy + rz * yz
  let xx = rx - yx * dot1
  let xy = ry - yy * dot1
  let xz = rz - yz * dot1
  let xl = Math.hypot(xx, xy, xz)
  if (xl < 0.25) {
    const dot2 = r2x * yx + r2y * yy + r2z * yz
    xx = r2x - yx * dot2
    xy = r2y - yy * dot2
    xz = r2z - yz * dot2
    xl = Math.hypot(xx, xy, xz)
  }
  const invXl = 1 / (xl || 1)
  xx *= invXl
  xy *= invXl
  xz *= invXl
  buf[off] = ox
  buf[off + 1] = oy
  buf[off + 2] = oz
  buf[off + 3] = xx
  buf[off + 4] = xy
  buf[off + 5] = xz
  buf[off + 6] = yx
  buf[off + 7] = yy
  buf[off + 8] = yz
  buf[off + 9] = xy * yz - xz * yy
  buf[off + 10] = xz * yx - xx * yz
  buf[off + 11] = xx * yy - xy * yx
}

const ikScratch = new Float32Array(6)

function solveIkToScratch(
  ax: number,
  ay: number,
  az: number,
  tx: number,
  ty: number,
  tz: number,
  l1: number,
  l2: number,
  px: number,
  py: number,
  pz: number,
): void {
  const dx0 = tx - ax
  const dy0 = ty - ay
  const dz0 = tz - az
  const dl = Math.hypot(dx0, dy0, dz0) || 1e-4
  const invDl = 1 / dl
  const dirX = dx0 * invDl
  const dirY = dy0 * invDl
  const dirZ = dz0 * invDl
  const d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(l1 + l2 - 1e-3, dl))
  const ca = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)
  const sa = Math.sqrt(Math.max(0, 1 - ca * ca))
  const pDot = px * dirX + py * dirY + pz * dirZ
  let perpX = px - dirX * pDot
  let perpY = py - dirY * pDot
  let perpZ = pz - dirZ * pDot
  let perpLen = Math.hypot(perpX, perpY, perpZ)
  if (perpLen < 1e-4) {
    perpX = dirX * dirY
    perpY = -1 + dirY * dirY
    perpZ = dirZ * dirY
    perpLen = Math.hypot(perpX, perpY, perpZ)
  }
  const invPerp = 1 / (perpLen || 1)
  perpX *= invPerp
  perpY *= invPerp
  perpZ *= invPerp
  const l1ca = l1 * ca
  const l1sa = l1 * sa
  ikScratch[0] = ax + dirX * l1ca + perpX * l1sa
  ikScratch[1] = ay + dirY * l1ca + perpY * l1sa
  ikScratch[2] = az + dirZ * l1ca + perpZ * l1sa
  ikScratch[3] = ax + dirX * d
  ikScratch[4] = ay + dirY * d
  ikScratch[5] = az + dirZ * d
}

function readBonePose(buf: Float32Array, baseOff: number): BonePose {
  const out: BonePose = {}
  for (let i = 0; i < BONE_COUNT; i++) {
    const o = baseOff + i * 12
    out[boneIds[i]!] = {
      p: [buf[o]!, buf[o + 1]!, buf[o + 2]!],
      x: [buf[o + 3]!, buf[o + 4]!, buf[o + 5]!],
      y: [buf[o + 6]!, buf[o + 7]!, buf[o + 8]!],
      z: [buf[o + 9]!, buf[o + 10]!, buf[o + 11]!],
    }
  }
  return out
}

const scratchAgentTuning: ZombieTuning = {
  zombieVariant: 0,
  zombieLurch: 0,
  zombieAsymmetry: 0,
  zombieDrag: 0,
  zombieReach: 0,
}

/** Computes a zombie's dynamic HumanProfile from global Lab tuning + individual traits + AI state/speed. */
export function agentZombieProfile(agent: AIAgent, baseTuning: ZombieTuning, out?: HumanProfile): HumanProfile {
  const stateBoost =
    agent.state === "chase" || agent.state === "alert" || agent.state === "bash"
      ? 1.0
      : agent.state === "investigate" || agent.state === "search"
        ? 0.45
        : 0.0
  const speed = Math.hypot(agent.vx, agent.vy)
  const speedNorm = clamp(speed / 3.0, 0, 1)

  scratchAgentTuning.zombieVariant = baseTuning.zombieVariant
  scratchAgentTuning.zombieLurch = clamp(
    baseTuning.zombieLurch * (0.75 + 0.35 * agent.lurch) + 0.16 * stateBoost + (agent.limping ? 0.22 : 0),
    0,
    1,
  )
  scratchAgentTuning.zombieAsymmetry = clamp(
    baseTuning.zombieAsymmetry * (0.7 + 0.4 * agent.asymmetry) + (agent.limping ? 0.28 : 0),
    0,
    1,
  )
  scratchAgentTuning.zombieDrag = clamp(
    agent.limping ? Math.max(0.88, baseTuning.zombieDrag * agent.drag) : baseTuning.zombieDrag * agent.drag * (1 - 0.38 * stateBoost),
    0,
    0.96,
  )
  scratchAgentTuning.zombieReach = clamp(
    baseTuning.zombieReach * (0.65 + 0.35 * agent.reach) + 0.28 * stateBoost + 0.1 * speedNorm,
    0,
    1,
  )

  const profile = zombieProfile(
    scratchAgentTuning,
    agent.id === 1 && (baseTuning.zombieVariant ?? 0) === 0 ? 0 : agent.seed,
    out,
  )
  if (stateBoost > 0.5) {
    profile.chestHz = Math.min(8, profile.chestHz + 2.2)
    profile.headHz = Math.min(9, profile.headHz + 2.8)
  }
  return profile
}

/** Builds the 8 instanced zombie body-part meshes (pelvis, torso, head, upperArm, foreArm, thigh, shin, foot). */
export function buildZombiePartMeshes(): Mesh[] {
  const box = (w: number, y0: number, h: number, d: number, col: Rgb, bevel = 0) => {
    const m = new Mesh()
    if (bevel > 0) m.bevelBox(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, bevel, col, col, MAT.actor)
    else m.box(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, col, MAT.actor)
    return m
  }
  const skin = hex(0x7c906e)
  const forearmSkin = hex(0x647857)
  const jacket = hex(0x61594b)
  const collar = hex(0x786f5e)
  const trousers = hex(0x3a434c)
  const wound = hex(0x9c2024)
  const hair = hex(0x252b28)
  const boot = hex(0x28221e)

  const pelvis = box(0.25, -0.07, 0.18, 0.34, trousers)
  const torso = box(0.28, -0.02, 0.48, 0.4, jacket, 0.022)
  // Lighter shoulder/collar yolk so top-down silhouette reads clearly even in dim ambient
  torso.box(-0.145, 0.34, -0.205, 0.145, 0.47, 0.205, collar, MAT.actor)
  torso.box(0.11, 0.12, -0.12, 0.148, 0.36, 0.08, wound, MAT.actor)
  torso.box(-0.148, 0.16, -0.1, -0.11, 0.34, 0.1, hex(0x4a2a28), MAT.actor)

  const head = box(0.185, 0.01, 0.24, 0.185, skin, 0.024)
  head.box(-0.1, 0.19, -0.105, 0.1, 0.275, 0.105, hair, MAT.actor)
  for (const z of [-0.042, 0.042]) {
    head.box(0.086, 0.13, z - 0.017, 0.098, 0.158, z + 0.017, hex(0xbce858), MAT.glow, 0.72)
  }

  const upperArm = box(0.15, -0.29, 0.33, 0.15, jacket)
  const foreArm = box(0.115, -0.28, 0.3, 0.115, forearmSkin)
  foreArm.box(-0.04, -0.31, -0.046, 0.058, -0.255, 0.046, wound, MAT.actor)

  const thigh = box(0.17, -0.42, 0.46, 0.17, trousers)
  const shin = box(0.135, -0.41, 0.43, 0.14, trousers)
  const sole = hex(0x161210)
  const foot = new Mesh()
  foot.box(-0.075, -0.075, -0.068, 0.125, 0.015, 0.068, boot, MAT.actor)
  foot.box(-0.078, -0.085, -0.07, 0.128, -0.065, 0.07, sole, MAT.actor)
  const toe = new Mesh()
  toe.box(-0.008, 0.015, -0.065, 0.06, 0.082, 0.065, boot, MAT.actor)
  toe.box(-0.006, 0, -0.068, 0.065, 0.02, 0.068, sole, MAT.actor)

  return [pelvis, torso, head, upperArm, foreArm, thigh, shin, foot, toe]
}

export class ZombieCrowdRenderer {
  private readonly models: number[]
  /** Former Townsfolk look: shared limb/foot models (9 entries, 0..2 from archetype 0, 3..8 shared) + 18 archetype buckets (6 × pelvis/torso/head). */
  private refinedModels: number[] | null = null
  private archModels: number[] | null = null
  private v1RefinedModels: number[] | null = null
  private v1ArchModels: number[] | null = null
  private archPartData: Float32Array<ArrayBuffer>[] | null = null
  private readonly archPartCounts = new Int32Array(ARCH_BUCKET_COUNT)
  private archPoolBatches: Batch[] | null = null
  private archGhostPartData: Float32Array<ArrayBuffer>[] | null = null
  private readonly archGhostPartCounts = new Int32Array(ARCH_BUCKET_COUNT)
  private archGhostPoolBatches: Batch[] | null = null
  private refinedActive = false
  private currentArch = 0
  private readonly addModel: Pick<Renderer, "addModel">["addModel"]
  /** The current zombie's per-part tint (9 × rgb): all 1 for today's look, its seeded palette for the refined look. */
  private readonly partTint = new Float32Array(PART_COUNT * 3).fill(1)
  private readonly partData: Float32Array<ArrayBuffer>[]
  readonly partCounts = new Int32Array(PART_COUNT)
  private readonly poolBatches: Batch[]
  private readonly ghostPartData: Float32Array<ArrayBuffer>[]
  private readonly ghostPartCounts = new Int32Array(PART_COUNT)
  private readonly ghostPoolBatches: Batch[]
  private readonly scratchProfile: HumanProfile = { ...humanProfiles.zombie }
  private readonly scratchTorsoFrame: Frame = { p: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
  private readonly scratchHands: [V3, V3] = [
    [0, 0, 0],
    [0, 0, 0],
  ]
  readonly debris: DetachedDebrisPiece[] = []
  readonly batches: Batch[] = []
  /** Each foot contact of an animated zombie (plan x, y, body speed m/s, how much that foot drags, shamble variant). */
  onFootfall?: (agentId: number, x: number, y: number, speed: number, drag: number, variant: string) => void
  /** How charred each burning or burnt zombie is (0..1, by id), set each frame by the fire presenter's caller. */
  charred: ReadonlyMap<number, number> | null = null
  /** Seconds into each live strike lunge, by agent id (presentation only; see `strike`). */
  private readonly strikes = new Map<number, number>()
  /** Lab › Feel › Zombie strike lunge (0 = off). */
  strikeScale = 1
  /** Hit reactions and ragdolls (`src/impact/`), or null for today's canned stagger and collapse. */
  physics: ZombieBodyPhysics | null = null
  private overlayCanvas: HTMLCanvasElement | null = null
  private overlayCtx: CanvasRenderingContext2D | null = null
  /** Special zombies' helmets, shields, bellies and jaws (`src/specials/figure.ts`). */
  private readonly accessories: SpecialAccessories
  /** Characters this frame (AR-88: callings, wear, habits, leads, heads turning, flinches); `null` is Today. */
  characters: ZombieCharacterFrame | null = null
  private readonly charAccessories: CharacterAccessories
  /** Each foot's tint (left, right) for the shared white foot meshes: shoe leather, a slipper or a bare foot. */
  private readonly footTint = new Float32Array([...BOOT_TINT, ...BOOT_TINT])
  private readonly habit: HabitPose = {
    torsoPitch: 0,
    torsoRoll: 0,
    headPitch: 0,
    headRoll: 0,
    headYaw: 0,
    hand: [new Float64Array(3), new Float64Array(3)],
    handW: [0, 0],
  }
  /** The zombie being drawn: its whole-body scale about the ground point under it. */
  private agentScale = 1
  private agentOx = 0
  private agentOy = 0
  private agentOz = 0

  // Flat Structure-of-Arrays (SoA) per-agent animation state (zero per-frame heap allocations)
  private capacity = INITIAL_AGENT_CAPACITY
  private nextSlot = 0
  private readonly slotById = new Map<number, number>()
  private footPx = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footPy = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footPz = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footLiftX = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footLiftY = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footLiftZ = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footTargetX = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footTargetY = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footTargetZ = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footPrevU = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footYaw = new Float32Array(INITIAL_AGENT_CAPACITY * 2)
  private footPlanted = new Uint8Array(INITIAL_AGENT_CAPACITY * 2)
  private phase = new Float32Array(INITIAL_AGENT_CAPACITY)
  private yaw = new Float32Array(INITIAL_AGENT_CAPACITY)
  private lastX = new Float32Array(INITIAL_AGENT_CAPACITY)
  private lastY = new Float32Array(INITIAL_AGENT_CAPACITY)
  private svx = new Float32Array(INITIAL_AGENT_CAPACITY)
  private svy = new Float32Array(INITIAL_AGENT_CAPACITY)
  private leanXx = new Float32Array(INITIAL_AGENT_CAPACITY)
  private leanXv = new Float32Array(INITIAL_AGENT_CAPACITY)
  private leanYx = new Float32Array(INITIAL_AGENT_CAPACITY)
  private leanYv = new Float32Array(INITIAL_AGENT_CAPACITY)
  private reachDropX = new Float32Array(INITIAL_AGENT_CAPACITY)
  private reachDropV = new Float32Array(INITIAL_AGENT_CAPACITY)
  private twistX = new Float32Array(INITIAL_AGENT_CAPACITY)
  private twistV = new Float32Array(INITIAL_AGENT_CAPACITY)
  private chestX = new Float32Array(INITIAL_AGENT_CAPACITY)
  private chestV = new Float32Array(INITIAL_AGENT_CAPACITY)
  private headX = new Float32Array(INITIAL_AGENT_CAPACITY)
  private headV = new Float32Array(INITIAL_AGENT_CAPACITY)
  private collapse = new Float32Array(INITIAL_AGENT_CAPACITY)
  private collapseDir = new Float32Array(INITIAL_AGENT_CAPACITY)
  private hiddenMask = new Uint16Array(INITIAL_AGENT_CAPACITY)
  private currBones = new Float32Array(INITIAL_AGENT_CAPACITY * BONE_STRIDE)
  private prevBones = new Float32Array(INITIAL_AGENT_CAPACITY * BONE_STRIDE)
  private seenAt = new Float32Array(INITIAL_AGENT_CAPACITY).fill(-1e9)
  private seenX = new Float32Array(INITIAL_AGENT_CAPACITY)
  private seenY = new Float32Array(INITIAL_AGENT_CAPACITY)
  private seenBones = new Float32Array(INITIAL_AGENT_CAPACITY * BONE_STRIDE)
  /** AR-88 body language and habits: flinch age (s, <0 none), torch contact last frame, flinch cooldown end, knock clock. */
  private flinchAge = new Float32Array(INITIAL_AGENT_CAPACITY).fill(-1)
  private inBeam = new Uint8Array(INITIAL_AGENT_CAPACITY)
  private flinchReady = new Float32Array(INITIAL_AGENT_CAPACITY)
  /** Sim time of the last draw, for habit beats between frames. */
  private lastTime = Number.NaN
  /** Where each empty lead's collar is (plan x, y) and its springy velocity. */
  private collarX = new Float32Array(INITIAL_AGENT_CAPACITY)
  private collarY = new Float32Array(INITIAL_AGENT_CAPACITY)
  private collarVx = new Float32Array(INITIAL_AGENT_CAPACITY)
  private collarVy = new Float32Array(INITIAL_AGENT_CAPACITY)

  constructor(renderer: Pick<Renderer, "addModel">, maxAgents = INITIAL_AGENT_CAPACITY) {
    if (maxAgents > this.capacity) this.growCapacity(maxAgents)
    this.addModel = renderer.addModel.bind(renderer)
    this.models = buildZombiePartMeshes().map((m) => renderer.addModel(m))
    this.accessories = new SpecialAccessories(renderer)
    this.charAccessories = new CharacterAccessories(renderer)
    this.partData = Array.from({ length: PART_COUNT }, () => new Float32Array(MAX_INSTANCES_PER_PART * INST_FLOATS))
    this.poolBatches = Array.from({ length: PART_COUNT }, (_, i) => ({
      model: this.models[i]!,
      data: this.partData[i]!,
      count: 0,
    }))
    this.ghostPartData = Array.from({ length: PART_COUNT }, () => new Float32Array(MAX_INSTANCES_PER_PART * INST_FLOATS))
    this.ghostPoolBatches = Array.from({ length: PART_COUNT }, (_, i) => ({
      model: this.models[i]!,
      data: this.ghostPartData[i]!,
      count: 0,
      alpha: true,
    }))
  }

  private growCapacity(minCap: number): void {
    let nextCap = this.capacity
    while (nextCap < minCap) nextCap *= 2
    const growF32 = (old: Float32Array, mult = 1) => {
      const next = new Float32Array(nextCap * mult)
      next.set(old)
      return next
    }
    this.footPx = growF32(this.footPx, 2)
    this.footPy = growF32(this.footPy, 2)
    this.footPz = growF32(this.footPz, 2)
    this.footLiftX = growF32(this.footLiftX, 2)
    this.footLiftY = growF32(this.footLiftY, 2)
    this.footLiftZ = growF32(this.footLiftZ, 2)
    this.footTargetX = growF32(this.footTargetX, 2)
    this.footTargetY = growF32(this.footTargetY, 2)
    this.footTargetZ = growF32(this.footTargetZ, 2)
    this.footPrevU = growF32(this.footPrevU, 2)
    this.footYaw = growF32(this.footYaw, 2)
    const nextPlanted = new Uint8Array(nextCap * 2)
    nextPlanted.set(this.footPlanted)
    this.footPlanted = nextPlanted
    this.phase = growF32(this.phase)
    this.yaw = growF32(this.yaw)
    this.lastX = growF32(this.lastX)
    this.lastY = growF32(this.lastY)
    this.svx = growF32(this.svx)
    this.svy = growF32(this.svy)
    this.leanXx = growF32(this.leanXx)
    this.leanXv = growF32(this.leanXv)
    this.leanYx = growF32(this.leanYx)
    this.leanYv = growF32(this.leanYv)
    this.reachDropX = growF32(this.reachDropX)
    this.reachDropV = growF32(this.reachDropV)
    this.twistX = growF32(this.twistX)
    this.twistV = growF32(this.twistV)
    this.chestX = growF32(this.chestX)
    this.chestV = growF32(this.chestV)
    this.headX = growF32(this.headX)
    this.headV = growF32(this.headV)
    this.collapse = growF32(this.collapse)
    this.collapseDir = growF32(this.collapseDir)
    const nextHidden = new Uint16Array(nextCap)
    nextHidden.set(this.hiddenMask)
    this.hiddenMask = nextHidden
    this.currBones = growF32(this.currBones, BONE_STRIDE)
    this.prevBones = growF32(this.prevBones, BONE_STRIDE)
    const nextSeenAt = new Float32Array(nextCap).fill(-1e9)
    nextSeenAt.set(this.seenAt)
    this.seenAt = nextSeenAt
    this.seenX = growF32(this.seenX)
    this.seenY = growF32(this.seenY)
    this.seenBones = growF32(this.seenBones, BONE_STRIDE)
    const nextFlinch = new Float32Array(nextCap).fill(-1)
    nextFlinch.set(this.flinchAge)
    this.flinchAge = nextFlinch
    const nextBeam = new Uint8Array(nextCap)
    nextBeam.set(this.inBeam)
    this.inBeam = nextBeam
    this.flinchReady = growF32(this.flinchReady)
    this.collarX = growF32(this.collarX)
    this.collarY = growF32(this.collarY)
    this.collarVx = growF32(this.collarVx)
    this.collarVy = growF32(this.collarVy)
    this.capacity = nextCap
  }

  reset(): void {
    this.slotById.clear()
    this.nextSlot = 0
    this.seenAt.fill(-1e9)
    this.debris.length = 0
  }

  private maskToHiddenSet(mask: number): Set<BoneId> {
    const out = new Set<BoneId>()
    for (let i = 0; i < BONE_COUNT; i++) {
      if ((mask & (1 << i)) !== 0) out.add(boneIds[i]!)
    }
    return out
  }

  getAgentBones(agentId: number): { bones: BonePose; prevBones: BonePose; hiddenBones: Set<BoneId>; planted?: [boolean, boolean] } | undefined {
    const s = this.slotById.get(agentId)
    if (s === undefined) return undefined
    const bOff = s * BONE_STRIDE
    return {
      bones: readBonePose(this.currBones, bOff),
      prevBones: readBonePose(this.prevBones, bOff),
      hiddenBones: this.maskToHiddenSet(this.hiddenMask[s]!),
      planted: [this.footPlanted[s * 2] !== 0, this.footPlanted[s * 2 + 1] !== 0],
    }
  }

  /** Plays a strike lunge on this zombie (its attack just landed); restarts one already playing. */
  strike(agentId: number): void {
    this.strikes.set(agentId, 0)
  }

  /** Seconds into this zombie's strike lunge, or `undefined` when it is not striking (for tests and proofs). */
  strikeAge(agentId: number): number | undefined {
    return this.strikes.get(agentId)
  }

  detachAgentLimb(agent: AIAgent, root: BoneId, dt: number, impulseDir: V3): (ReturnType<typeof detach>[number])[] {
    const s = this.slotById.get(agent.id)
    if (s === undefined) return []
    const bOff = s * BONE_STRIDE
    const bones = readBonePose(this.currBones, bOff)
    const rawPrev = readBonePose(this.prevBones, bOff)
    const prevValid =
      rawPrev.pelvis &&
      bones.pelvis &&
      (rawPrev.pelvis.p[0] !== 0 || rawPrev.pelvis.p[1] !== 0 || rawPrev.pelvis.p[2] !== 0) &&
      Math.hypot(
        bones.pelvis.p[0] - rawPrev.pelvis.p[0],
        bones.pelvis.p[1] - rawPrev.pelvis.p[1],
        bones.pelvis.p[2] - rawPrev.pelvis.p[2],
      ) < 2.2
    const prev = prevValid ? rawPrev : bones
    const hidden = this.maskToHiddenSet(this.hiddenMask[s]!)
    const pieces = detach(bones, prev, Math.max(1 / 120, dt), root, hidden)
    this.hiddenMask[s] = this.hiddenMask[s]! | BONE_SUBTREE_MASK[root]
    if (!agent.detachedLimbs.includes(root)) {
      agent.detachedLimbs.push(root)
    }
    for (const part of pieces) {
      const [yaw, pitchAngle, rollAngle] = frameAngles(part.frame)
      const partIndex = BONE_TO_PART[part.bone]
      this.debris.push({
        partIndex,
        p: [...part.frame.p],
        v: [
          part.linear[0] * 0.35 + impulseDir[0] * 3.2,
          Math.max(1.2, part.linear[1] * 0.3 + 2.1),
          part.linear[2] * 0.35 + impulseDir[2] * 3.2,
        ],
        yaw,
        pitchAngle,
        rollAngle,
        w: [
          part.angular[0] * 0.3 + (impulseDir[2] || 0.5) * 4,
          part.angular[1] * 0.3 + 3.5,
          part.angular[2] * 0.3 - (impulseDir[0] || 0.5) * 4,
        ],
        age: 0,
        life: 14,
      })
    }
    return pieces
  }

  private ensureSlot(agent: AIAgent, support: (x: number, z: number) => number): number {
    let s = this.slotById.get(agent.id)
    if (s === undefined) {
      s = this.nextSlot++
      if (s >= this.capacity) this.growCapacity(s + 1)
      this.slotById.set(agent.id, s)
      const y0 = support(agent.x, agent.y)
      const f0 = s * 2
      const f1 = f0 + 1
      this.footPx[f0] = agent.x
      this.footPy[f0] = y0
      this.footPz[f0] = agent.y - 0.13
      this.footLiftX[f0] = agent.x
      this.footLiftY[f0] = y0
      this.footLiftZ[f0] = agent.y - 0.13
      this.footTargetX[f0] = agent.x
      this.footTargetY[f0] = y0
      this.footTargetZ[f0] = agent.y - 0.13
      this.footPrevU[f0] = 0
      this.footPlanted[f0] = 1
      this.footYaw[f0] = agent.aim

      this.footPx[f1] = agent.x
      this.footPy[f1] = y0
      this.footPz[f1] = agent.y + 0.13
      this.footLiftX[f1] = agent.x
      this.footLiftY[f1] = y0
      this.footLiftZ[f1] = agent.y + 0.13
      this.footTargetX[f1] = agent.x
      this.footTargetY[f1] = y0
      this.footTargetZ[f1] = agent.y + 0.13
      this.footPrevU[f1] = 0
      this.footPlanted[f1] = 1
      this.footYaw[f1] = agent.aim

      this.phase[s] = (agent.id * 0.27 + (agent.seed % 97) * 0.01) % 1
      this.yaw[s] = agent.aim
      this.lastX[s] = agent.x
      this.lastY[s] = agent.y
      this.svx[s] = 0
      this.svy[s] = 0
      this.leanXx[s] = 0
      this.leanXv[s] = 0
      this.leanYx[s] = 0
      this.leanYv[s] = 0
      this.reachDropX[s] = 0
      this.reachDropV[s] = 0
      this.twistX[s] = 0
      this.twistV[s] = 0
      this.chestX[s] = agent.aim
      this.chestV[s] = 0
      this.headX[s] = agent.aim
      this.headV[s] = 0
      this.collapse[s] = 0
      this.collapseDir[s] = (agent.id % 2 === 0 ? 1 : -1) * 0.35
      this.seenAt[s] = -1e9
      this.flinchAge[s] = -1
      this.inBeam[s] = 0
      this.flinchReady[s] = 0
      this.collarX[s] = agent.x + Math.cos(agent.aim) * 1.3
      this.collarY[s] = agent.y + Math.sin(agent.aim) * 1.3
      this.collarVx[s] = 0
      this.collarVy[s] = 0
      let mask = 0
      for (let i = 0; i < agent.detachedLimbs.length; i++) {
        mask |= BONE_SUBTREE_MASK[agent.detachedLimbs[i] as BoneId] ?? 0
      }
      this.hiddenMask[s] = mask
    }
    return s
  }

  private ensureTownsfolkPools(undead = true): void {
    if (!this.archPartData) {
      this.archPartData = Array.from({ length: ARCH_BUCKET_COUNT }, () => new Float32Array(MAX_INSTANCES_PER_ARCH * INST_FLOATS))
      this.archPoolBatches = Array.from({ length: ARCH_BUCKET_COUNT }, (_, i) => ({
        model: 0,
        data: this.archPartData![i]!,
        count: 0,
      }))
      this.archGhostPartData = Array.from({ length: ARCH_BUCKET_COUNT }, () => new Float32Array(MAX_INSTANCES_PER_ARCH * INST_FLOATS))
      this.archGhostPoolBatches = Array.from({ length: ARCH_BUCKET_COUNT }, (_, i) => ({
        model: 0,
        data: this.archGhostPartData![i]!,
        count: 0,
        alpha: true,
      }))
    }
    if (undead && this.refinedModels) return
    if (!undead && this.v1RefinedModels) return
    const { archetypes, shared } = townsfolkZombieMeshes(0.35, undead)
    const archModels: number[] = []
    for (const a of archetypes) {
      archModels.push(this.addModel(a.pelvis), this.addModel(a.torso), this.addModel(a.head))
    }
    const sharedModels = shared.map((m) => this.addModel(m))
    const refinedModels = [archModels[0]!, archModels[1]!, archModels[2]!, ...sharedModels]
    if (undead) {
      this.archModels = archModels
      this.refinedModels = refinedModels
    } else {
      this.v1ArchModels = archModels
      this.v1RefinedModels = refinedModels
    }
  }

  private emitUprightBone(
    bOff: number,
    boneIdx: number,
    partIndex: number,
    hiddenMask: number,
    yaw: number,
    tintR: number,
    tintG: number,
    tintB: number,
    flash: number,
    alpha: number,
  ): void {
    if ((hiddenMask & (1 << boneIdx)) !== 0) return
    const count = this.partCounts[partIndex]!
    if (count >= MAX_INSTANCES_PER_PART) return
    const fOff = bOff + boneIdx * 12
    const b = this.currBones
    let data: Float32Array
    let offset: number
    if (this.refinedActive && partIndex < ARCH_PART_COUNT) {
      const bucket = this.currentArch * ARCH_PART_COUNT + partIndex
      const aCount = this.archPartCounts[bucket]!
      if (aCount >= MAX_INSTANCES_PER_ARCH) return
      data = this.archPartData![bucket]!
      offset = aCount * INST_FLOATS
      this.archPartCounts[bucket] = aCount + 1
    } else {
      data = this.partData[partIndex]!
      offset = count * INST_FLOATS
    }
    const sc = this.agentScale
    data[offset] = this.agentOx + (b[fOff]! - this.agentOx) * sc
    data[offset + 1] = this.agentOy + (b[fOff + 1]! - this.agentOy) * sc
    data[offset + 2] = this.agentOz + (b[fOff + 2]! - this.agentOz) * sc
    data[offset + 3] = yaw
    data[offset + 4] = tintR * this.partTint[partIndex * 3]!
    data[offset + 5] = tintG * this.partTint[partIndex * 3 + 1]!
    data[offset + 6] = tintB * this.partTint[partIndex * 3 + 2]!
    data[offset + 7] = sc
    data[offset + 8] = 0
    data[offset + 9] = 0
    data[offset + 10] = alpha
    data[offset + 11] = flash
    this.partCounts[partIndex] = count + 1
  }

  private emitBone(
    bOff: number,
    boneIdx: number,
    partIndex: number,
    hiddenMask: number,
    tintR: number,
    tintG: number,
    tintB: number,
    flash: number,
    alpha: number,
  ): void {
    if ((hiddenMask & (1 << boneIdx)) !== 0) return
    const count = this.partCounts[partIndex]!
    if (count >= MAX_INSTANCES_PER_PART) return
    const fOff = bOff + boneIdx * 12
    const b = this.currBones
    const xx = b[fOff + 3]!
    const xy = b[fOff + 4]!
    const xz = b[fOff + 5]!
    const yy = b[fOff + 7]!
    const zx = b[fOff + 9]!
    const zy = b[fOff + 10]!
    const zz = b[fOff + 11]!
    const p = Math.asin(clamp(xy, -1, 1))
    const c = Math.cos(p)
    const yaw = c > 1e-4 ? Math.atan2(xz, xx) : Math.atan2(-zx, zz)
    const r = c > 1e-4 ? Math.atan2(-zy, yy) : 0
    let data: Float32Array
    let offset: number
    if (this.refinedActive && partIndex < ARCH_PART_COUNT) {
      const bucket = this.currentArch * ARCH_PART_COUNT + partIndex
      const aCount = this.archPartCounts[bucket]!
      if (aCount >= MAX_INSTANCES_PER_ARCH) return
      data = this.archPartData![bucket]!
      offset = aCount * INST_FLOATS
      this.archPartCounts[bucket] = aCount + 1
    } else {
      data = this.partData[partIndex]!
      offset = count * INST_FLOATS
    }
    const sc = this.agentScale
    data[offset] = this.agentOx + (b[fOff]! - this.agentOx) * sc
    data[offset + 1] = this.agentOy + (b[fOff + 1]! - this.agentOy) * sc
    data[offset + 2] = this.agentOz + (b[fOff + 2]! - this.agentOz) * sc
    data[offset + 3] = yaw
    const tint = this.refinedActive && partIndex >= 7 ? this.footTint : this.partTint
    const tOff = this.refinedActive && partIndex >= 7 ? ((boneIdx - 11) & 1) * 3 : partIndex * 3
    data[offset + 4] = tintR * tint[tOff]!
    data[offset + 5] = tintG * tint[tOff + 1]!
    data[offset + 6] = tintB * tint[tOff + 2]!
    data[offset + 7] = sc
    data[offset + 8] = p
    data[offset + 9] = r
    data[offset + 10] = alpha
    data[offset + 11] = flash
    this.partCounts[partIndex] = count + 1
  }

  private emitGhostBone(
    bOff: number,
    boneIdx: number,
    partIndex: number,
    hiddenMask: number,
    alpha: number,
  ): void {
    if ((hiddenMask & (1 << boneIdx)) !== 0) return
    const count = this.ghostPartCounts[partIndex]!
    if (count >= MAX_INSTANCES_PER_PART) return
    const fOff = bOff + boneIdx * 12
    const b = this.seenBones
    const xx = b[fOff + 3]!
    const xy = b[fOff + 4]!
    const xz = b[fOff + 5]!
    const yy = b[fOff + 7]!
    const zx = b[fOff + 9]!
    const zy = b[fOff + 10]!
    const zz = b[fOff + 11]!
    const p = Math.asin(clamp(xy, -1, 1))
    const c = Math.cos(p)
    const yaw = c > 1e-4 ? Math.atan2(xz, xx) : Math.atan2(-zx, zz)
    const r = c > 1e-4 ? Math.atan2(-zy, yy) : 0
    let data: Float32Array
    let offset: number
    if (this.refinedActive && partIndex < ARCH_PART_COUNT) {
      const bucket = this.currentArch * ARCH_PART_COUNT + partIndex
      const aCount = this.archGhostPartCounts[bucket]!
      if (aCount >= MAX_INSTANCES_PER_ARCH) return
      data = this.archGhostPartData![bucket]!
      offset = aCount * INST_FLOATS
      this.archGhostPartCounts[bucket] = aCount + 1
    } else {
      data = this.ghostPartData[partIndex]!
      offset = count * INST_FLOATS
    }
    data[offset] = b[fOff]!
    data[offset + 1] = b[fOff + 1]!
    data[offset + 2] = b[fOff + 2]!
    data[offset + 3] = yaw
    data[offset + 4] = 0.42
    data[offset + 5] = 0.48
    data[offset + 6] = 0.58
    data[offset + 7] = 1
    data[offset + 8] = p
    data[offset + 9] = r
    data[offset + 10] = alpha
    data[offset + 11] = 0
    this.ghostPartCounts[partIndex] = count + 1
  }

  private emitSpecial(kind: SpecialKind, bOff: number, hidden: number, shade: number, flash: number, alpha: number): void {
    this.accessories.emit(kind, this.currBones, bOff, hidden, this.agentScale, this.agentOx, this.agentOy, this.agentOz, shade, flash, alpha)
  }

  draw(
    agents: readonly AIAgent[],
    dt: number,
    support: (x: number, z: number) => number,
    vision: Vision,
    viewRect: readonly [number, number, number, number],
    zombieTune: ZombieTuning & {
      zombieLook?: number
      fogGhostDuration?: number
      hideUnseenZombies?: boolean
      unseenMode?: number
      unseenMemory?: number
    },
    debugOverlay: boolean,
    time = 0,
  ): Batch[] {
    dt = Math.max(0.0001, Math.min(0.1, dt))
    this.physics?.begin(dt)
    for (const [id, age] of this.strikes) {
      if (age + dt >= STRIKE_TIME) this.strikes.delete(id)
      else this.strikes.set(id, age + dt)
    }
    const lookMode = Math.round(zombieTune.zombieLook ?? 0)
    const refined = lookMode === 1 || lookMode === 2
    const undead = lookMode !== 2
    if (refined) {
      this.ensureTownsfolkPools(undead)
      const activeArchModels = undead ? this.archModels! : this.v1ArchModels!
      for (let i = 0; i < ARCH_BUCKET_COUNT; i++) {
        this.archPoolBatches![i]!.model = this.archGhostPoolBatches![i]!.model = activeArchModels[i]!
      }
    }
    this.refinedActive = refined
    this.currentArch = 0
    const models = refined ? (undead ? this.refinedModels! : this.v1RefinedModels!) : this.models
    for (let i = 0; i < PART_COUNT; i++) this.poolBatches[i]!.model = this.ghostPoolBatches[i]!.model = models[i]!
    if (!refined) this.partTint.fill(1)
    this.partCounts.fill(0)
    this.ghostPartCounts.fill(0)
    this.accessories.begin()
    this.charAccessories.begin()
    const chars = this.characters
    this.agentScale = 1
    if (refined) {
      this.archPartCounts.fill(0)
      this.archGhostPartCounts.fill(0)
    }
    const [vx0, vy0, vx1, vy1] = viewRect
    const hideUnseen = zombieTune.hideUnseenZombies ?? true
    const unseenMode = zombieTune.unseenMode ?? 0
    const hasStaleMemory = unseenMode === 4 || (zombieTune.unseenMemory ?? 0) > 0.25
    const baseGhostDuration = zombieTune.fogGhostDuration ?? 3.2
    const ghostDuration = hasStaleMemory ? Math.max(baseGhostDuration, 12.0) : baseGhostDuration

    // Step detached limb debris
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]!
      d.age += dt
      if (d.age >= d.life) {
        this.debris.splice(i, 1)
        continue
      }
      const floorY = support(d.p[0], d.p[2]) + 0.05
      if (d.p[1] > floorY || Math.hypot(d.v[0], d.v[1], d.v[2]) > 0.08) {
        d.v[1] -= 13.5 * dt
        d.p[0] += d.v[0] * dt
        d.p[1] += d.v[1] * dt
        d.p[2] += d.v[2] * dt
        d.yaw += d.w[0] * dt
        d.pitchAngle += d.w[1] * dt
        d.rollAngle += d.w[2] * dt
        if (d.p[1] <= floorY) {
          d.p[1] = floorY
          d.v[0] *= 0.45
          d.v[1] = -d.v[1] * 0.25
          d.v[2] *= 0.45
          d.w[0] *= 0.5
          d.w[1] *= 0.4
          d.w[2] *= 0.4
        }
      }
      const count = this.partCounts[d.partIndex]!
      if (count < MAX_INSTANCES_PER_PART) {
        let data: Float32Array
        let offset: number
        if (refined && d.partIndex < ARCH_PART_COUNT) {
          const aCount = this.archPartCounts[d.partIndex]!
          if (aCount >= MAX_INSTANCES_PER_ARCH) continue
          data = this.archPartData![d.partIndex]!
          offset = aCount * INST_FLOATS
          this.archPartCounts[d.partIndex] = aCount + 1
        } else {
          data = this.partData[d.partIndex]!
          offset = count * INST_FLOATS
        }
        data[offset] = d.p[0]
        data[offset + 1] = d.p[1]
        data[offset + 2] = d.p[2]
        data[offset + 3] = d.yaw
        const bootDebris = refined && d.partIndex >= 7
        data[offset + 4] = bootDebris ? BOOT_TINT[0] * 0.85 : 0.85
        data[offset + 5] = bootDebris ? BOOT_TINT[1] * 0.75 : 0.75
        data[offset + 6] = bootDebris ? BOOT_TINT[2] * 0.75 : 0.75
        data[offset + 7] = 1
        data[offset + 8] = d.pitchAngle
        data[offset + 9] = d.rollAngle
        data[offset + 10] = 1
        data[offset + 11] = 0
        this.partCounts[d.partIndex] = count + 1
      }
    }

    const expVel = 1 - Math.exp(-dt * 14)
    const yawStepCap = Math.min(1, dt * 9)
    const springSubsteps = Math.max(1, Math.ceil(dt / (1 / 240)))
    const springH = dt / springSubsteps
    const leanDamp = 2 * Math.sqrt(90) * 0.38
    const prevTmp = this.prevBones
    this.prevBones = this.currBones
    this.currBones = prevTmp
    const bBuf = this.currBones

    const prevTime = this.lastTime
    this.lastTime = time
    const beats = chars?.habits && Number.isFinite(prevTime) && time > prevTime && time - prevTime < 0.5

    for (let idx = 0; idx < agents.length; idx++) {
      const a = agents[idx]!
      if (beats && a.state === "wander" && Math.abs(a.vx) + Math.abs(a.vy) < 0.05) {
        // A habit is heard whether or not anyone can see who is at it.
        if (a.x > vx0 - 12 && a.x < vx1 + 12 && a.y > vy0 - 12 && a.y < vy1 + 12) {
          const site = chars!.habits!.at(a.x, a.y)
          const cue = site && HABIT_CUES[site.kind]
          if (site && cue) {
            const p0 = habitTime(site.kind, prevTime, a.id) % cue[0]
            const p1 = habitTime(site.kind, time, a.id) % cue[0]
            if (crossed(p0, p1, cue[1])) chars!.onBeat({ id: a.id, kind: site.kind, x: site.x, y: site.y })
          } else if (site && chars!.dancing.length < 4) chars!.dancing.push({ id: a.id, x: site.x, y: site.y })
        }
      }
      if (a.x < vx0 - 3 || a.x > vx1 + 3 || a.y < vy0 - 3 || a.y > vy1 + 3) continue
      if (refined) this.currentArch = zombieCallingArchetype(a.seed, a.id, chars?.callings ?? false)

      const visWeight = typeof vision.actorVisible === "function" ? vision.actorVisible(a.x, a.y) : vision.visible(a.x, a.y) ? 1 : 0
      const isVisible = visWeight > 0.02
      if (!isVisible && hideUnseen && !debugOverlay) {
        const s = this.slotById.get(a.id)
        if (s !== undefined && ghostDuration > 0.05 && a.state !== "dead") {
          const age = time - this.seenAt[s]!
          if (age >= 0 && age < ghostDuration) {
            const sx = this.seenX[s]!
            const sy = this.seenY[s]!
            if (Math.hypot(a.x - sx, a.y - sy) > 0.85 && vision.visible(sx, sy)) {
              this.seenAt[s] = -1e9
            } else {
              const gAlpha = Math.pow(1 - age / ghostDuration, 1.55) * (hasStaleMemory ? 0.68 : 0.56)
              if (gAlpha > 0.02) {
                const hidden = this.hiddenMask[s]!
                const bOff = s * BONE_STRIDE
                for (let b = 0; b < BONE_COUNT; b++) {
                  this.emitGhostBone(bOff, b, BONE_INDEX_TO_PART[b]!, hidden, gAlpha)
                }
              }
            }
          }
        }
        continue
      }

      const s = this.ensureSlot(a, support)
      if (refined) {
        zombiePalette(a.seed, this.partTint, a.id, undead, this.currentArch, chars?.wear ?? false)
        this.footTint.set(BOOT_TINT, 0)
        this.footTint.set(BOOT_TINT, 3)
        if (this.currentArch === CALLING_ROBE) {
          // One slipper, one bare foot.
          const h = zombieHash(a.seed ^ 0x51199e, a.id)
          const slipper = linearHex(ZOMBIE_SLIPPERS[h % ZOMBIE_SLIPPERS.length]!)
          const left = (h >>> 8) & 1
          for (let c = 0; c < 3; c++) {
            this.footTint[left * 3 + c] = slipper[c]!
            this.footTint[(1 - left) * 3 + c] = this.partTint[2 * 3 + c]!
          }
        }
      }
      const kind = specialKindOf(a.seed)
      const look = specialLook(kind)
      if (look && refined) applySpecialPalette(kind, this.partTint)
      this.agentScale = look ? look.scale : 1
      this.agentOx = a.x
      this.agentOy = look ? support(a.x, a.y) : 0
      this.agentOz = a.y
      let hidden = this.hiddenMask[s]!
      if (a.detachedLimbs.length > 0) {
        for (let i = 0; i < a.detachedLimbs.length; i++) {
          hidden |= BONE_SUBTREE_MASK[a.detachedLimbs[i] as BoneId] ?? 0
        }
        this.hiddenMask[s] = hidden
      }

      // A sleeping Lurker is a shadow until the light finds it.
      const shade = (0.88 + ((a.id * 19) % 7) * 0.035) * (kind === SPECIAL_LURKER && a.state === "wander" ? 0.45 : 1)
      const visFade = hideUnseen || !unseenMode ? Math.min(1.0, 0.25 + 0.75 * visWeight) : 1.0
      const char = this.charred?.get(a.id) ?? 0
      const tintR = !isVisible && debugOverlay ? 0.55 : shade * (1 - 0.8 * char) * (unseenMode > 0 ? visFade : 1.0)
      const tintG = !isVisible && debugOverlay ? 0.72 : shade * 0.98 * (1 - 0.86 * char) * (unseenMode > 0 ? visFade : 1.0)
      const tintB = !isVisible && debugOverlay ? 0.85 : shade * 0.94 * (1 - 0.9 * char) * (unseenMode > 0 ? visFade : 1.0)
      const alpha = !isVisible && debugOverlay ? 0.58 : unseenMode > 0 ? 1.0 : Math.min(1.0, 0.25 + 0.75 * visWeight)
      const bOff = s * BONE_STRIDE
      const pelvisOff = bOff
      const torsoOff = bOff + 12
      const headOff = bOff + 24

      if (a.state === "dead" && this.physics?.corpse(a, bBuf, this.prevBones, bOff, dt, support)) {
        this.seenAt[s] = -1e9
        this.collapse[s] = 1
        // Scale a special's body about the ground under where its ragdoll lies, not where it died.
        this.agentOx = bBuf[pelvisOff]!
        this.agentOz = bBuf[pelvisOff + 2]!
        this.agentOy = look ? support(this.agentOx, this.agentOz) : 0
        for (let b = 0; b < BONE_COUNT; b++) this.emitBone(bOff, b, BONE_INDEX_TO_PART[b]!, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        if (kind) this.emitSpecial(kind, bOff, hidden, tintR, a.hitFlash, alpha)
        continue
      }
      if (a.state === "dead" || a.state === "knockdown") {
        if (a.state === "dead") this.seenAt[s] = -1e9
        const isDead = a.state === "dead"
        const col = isDead
          ? Math.min(1, this.collapse[s]! + dt * 4.2)
          : a.timer > 0.55
            ? Math.min(0.9, this.collapse[s]! + dt * 5.4)
            : Math.max(0.18, this.collapse[s]! - dt * 2.1)
        this.collapse[s] = col
        const c = smoother(col)
        const groundY = support(a.x, a.y)
        const deathVar = isDead ? (a.deathVariant ?? (((a.seed >>> 8) & 3) as 0 | 1 | 2 | 3)) : 0
        const sideSign = a.id % 2 === 0 ? 1 : -1
        const syaw =
          isDead && deathVar === 2
            ? this.yaw[s]! + c * sideSign * 2.05
            : this.yaw[s]!

        let pelvisY = groundY + (HIP * (1 - c) + 0.14 * c)
        let pelvisPitch = -1.42 * c
        let pelvisRoll = this.collapseDir[s]! * c
        let torsoPitch = -1.48 * c
        let torsoRoll = 0
        let headPitch = -1.35 * c

        if (!isDead) {
          // Knockdown: propped on one elbow with head craned up, struggling to push up as timer expires
          const struggle = Math.sin(time * 5.2 + a.id * 1.7) * 0.14 + (a.timer < 0.85 ? (0.85 - a.timer) * 0.24 : 0)
          pelvisY = groundY + (HIP * (1 - c) + 0.16 * c)
          pelvisPitch = 1.18 * c
          pelvisRoll = sideSign * 0.46 * c
          torsoPitch = (1.02 - struggle) * c
          torsoRoll = sideSign * 0.42 * c
          headPitch = (0.48 - struggle * 1.1) * c
        } else if (deathVar === 1) {
          // Variant 1: fall backward onto spine
          pelvisPitch = 1.38 * c
          pelvisRoll = this.collapseDir[s]! * 0.65 * c
          torsoPitch = 1.44 * c
          headPitch = 1.18 * c
        } else if (deathVar === 2) {
          // Variant 2: spin and crumple onto side
          pelvisPitch = -1.28 * c
          pelvisRoll = sideSign * 0.82 * c
          torsoPitch = -1.34 * c
          torsoRoll = sideSign * 0.62 * c
          headPitch = -1.15 * c
        } else if (deathVar === 3) {
          // Variant 3: collapse to knees first, then slump forward
          const kneeStage = clamp(col / 0.55, 0, 1)
          const slumpStage = clamp((col - 0.45) / 0.55, 0, 1)
          const kSmooth = smoother(kneeStage)
          const sSmooth = smoother(slumpStage)
          pelvisY = groundY + HIP * (1 - kSmooth) + 0.36 * kSmooth * (1 - sSmooth) + 0.16 * sSmooth
          pelvisPitch = -0.35 * kSmooth - 1.05 * sSmooth
          torsoPitch = -0.28 * kSmooth - 1.22 * sSmooth
          headPitch = -0.45 * kSmooth - 0.9 * sSmooth
        }

        writeYawFrame(bBuf, pelvisOff, a.x, pelvisY, a.y, syaw)
        pitchInPlace(bBuf, pelvisOff, pelvisPitch)
        rollInPlace(bBuf, pelvisOff, pelvisRoll)

        const tx = bBuf[pelvisOff]! + bBuf[pelvisOff + 6]! * RIG.waist
        const ty = bBuf[pelvisOff + 1]! + bBuf[pelvisOff + 7]! * RIG.waist
        const tz = bBuf[pelvisOff + 2]! + bBuf[pelvisOff + 8]! * RIG.waist
        writeYawFrame(bBuf, torsoOff, tx, ty, tz, syaw)
        pitchInPlace(bBuf, torsoOff, torsoPitch)
        if (torsoRoll !== 0) rollInPlace(bBuf, torsoOff, torsoRoll)

        const hx = bBuf[torsoOff]! + bBuf[torsoOff + 3]! * 0.02 + bBuf[torsoOff + 6]! * RIG.neckY
        const hy = bBuf[torsoOff + 1]! + bBuf[torsoOff + 4]! * 0.02 + bBuf[torsoOff + 7]! * RIG.neckY
        const hz = bBuf[torsoOff + 2]! + bBuf[torsoOff + 5]! * 0.02 + bBuf[torsoOff + 8]! * RIG.neckY
        writeYawFrame(bBuf, headOff, hx, hy, hz, syaw)
        pitchInPlace(bBuf, headOff, headPitch)

        this.emitBone(bOff, 0, 0, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, 1, 1, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, 2, 2, hidden, tintR, tintG, tintB, a.hitFlash, alpha)

        const cosY = Math.cos(syaw)
        const sinY = Math.sin(syaw)
        const pxAxisX = bBuf[pelvisOff + 3]!
        const pxAxisY = bBuf[pelvisOff + 4]!
        const pxAxisZ = bBuf[pelvisOff + 5]!
        const pzAxisX = bBuf[pelvisOff + 9]!
        const pzAxisY = bBuf[pelvisOff + 10]!
        const pzAxisZ = bBuf[pelvisOff + 11]!
        const txAxisX = bBuf[torsoOff + 3]!
        const txAxisY = bBuf[torsoOff + 4]!
        const txAxisZ = bBuf[torsoOff + 5]!
        const tyAxisX = bBuf[torsoOff + 6]!
        const tyAxisY = bBuf[torsoOff + 7]!
        const tyAxisZ = bBuf[torsoOff + 8]!
        const tzAxisX = bBuf[torsoOff + 9]!
        const tzAxisY = bBuf[torsoOff + 10]!
        const tzAxisZ = bBuf[torsoOff + 11]!

        const legFwd = !isDead || deathVar === 1 ? 0.58 : deathVar === 3 ? -0.36 : -0.65
        const armFwd = !isDead ? -0.28 : deathVar === 1 ? -0.32 : 0.45

        for (let i = 0; i < 2; i++) {
          const side = i ? 1 : -1
          const legFwdI = !isDead ? (i === 0 ? 0.62 : 0.34) : legFwd
          const armFwdI = !isDead
            ? i === 0
              ? -0.34
              : 0.28 + 0.12 * Math.sin(time * 5.2 + a.id)
            : armFwd
          const armTargetY =
            !isDead && i === 1
              ? groundY + 0.16 + 0.08 * Math.max(0, Math.sin(time * 5.2 + a.id))
              : groundY + 0.08
          const hipZ = side * RIG.hipW
          const hipX = bBuf[pelvisOff]! + pzAxisX * hipZ
          const hipY = bBuf[pelvisOff + 1]! + pzAxisY * hipZ
          const hipZWorld = bBuf[pelvisOff + 2]! + pzAxisZ * hipZ
          const poleX = pxAxisX + pzAxisX * (side * 0.3)
          const poleY = pxAxisY + pzAxisY * (side * 0.3)
          const poleZ = pxAxisZ + pzAxisZ * (side * 0.3)
          solveIkToScratch(
            hipX,
            hipY,
            hipZWorld,
            a.x + cosY * legFwdI - sinY * side * 0.18,
            groundY + 0.09,
            a.y + sinY * legFwdI + cosY * side * 0.18,
            RIG.thigh,
            RIG.shin,
            poleX,
            poleY,
            poleZ,
          )
          const kx = ikScratch[0]!
          const ky = ikScratch[1]!
          const kz = ikScratch[2]!
          const ex = ikScratch[3]!
          const ey = ikScratch[4]!
          const ez = ikScratch[5]!
          const thighIdx = 7 + i
          const shinIdx = 9 + i
          const footIdx = 11 + i
          const toeIdx = 13 + i
          const footOff = bOff + footIdx * 12
          const toeOff = bOff + toeIdx * 12
          writeLimbFrame(bBuf, bOff + thighIdx * 12, hipX, hipY, hipZWorld, kx, ky, kz, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)
          writeLimbFrame(bBuf, bOff + shinIdx * 12, kx, ky, kz, ex, ey, ez, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)
          writeYawFrame(bBuf, footOff, ex, ey, ez, syaw)
          pitchInPlace(bBuf, footOff, (!isDead || deathVar === 1 ? 0.95 : -1.2) * c)
          const bx = ex + bBuf[footOff + 3]! * RIG.foot - bBuf[footOff + 6]! * RIG.ankle
          const by = ey + bBuf[footOff + 4]! * RIG.foot - bBuf[footOff + 7]! * RIG.ankle
          const bz = ez + bBuf[footOff + 5]! * RIG.foot - bBuf[footOff + 8]! * RIG.ankle
          writeYawFrame(bBuf, toeOff, bx, by, bz, syaw)
          pitchInPlace(bBuf, toeOff, (!isDead || deathVar === 1 ? 0.95 : -1.2) * c)
          this.emitBone(bOff, thighIdx, 5, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, shinIdx, 6, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, footIdx, 7, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, toeIdx, 8, hidden, tintR, tintG, tintB, a.hitFlash, alpha)

          const shZ = side * RIG.shoulderW
          const shX = tx + tyAxisX * RIG.shoulderY + tzAxisX * shZ
          const shY = ty + tyAxisY * RIG.shoulderY + tzAxisY * shZ
          const shZWorld = tz + tyAxisZ * RIG.shoulderY + tzAxisZ * shZ
          const aPoleX = txAxisX * -0.4 - tyAxisX + tzAxisX * side
          const aPoleY = txAxisY * -0.4 - tyAxisY + tzAxisY * side
          const aPoleZ = txAxisZ * -0.4 - tyAxisZ + tzAxisZ * side
          solveIkToScratch(
            shX,
            shY,
            shZWorld,
            a.x + cosY * armFwdI - sinY * side * 0.32,
            armTargetY,
            a.y + sinY * armFwdI + cosY * side * 0.32,
            RIG.upper,
            RIG.fore,
            aPoleX,
            aPoleY,
            aPoleZ,
          )
          const elx = ikScratch[0]!
          const ely = ikScratch[1]!
          const elz = ikScratch[2]!
          const wrx = ikScratch[3]!
          const wry = ikScratch[4]!
          const wrz = ikScratch[5]!
          const uaIdx = 3 + i
          const faIdx = 5 + i
          writeLimbFrame(bBuf, bOff + uaIdx * 12, shX, shY, shZWorld, elx, ely, elz, txAxisX, txAxisY, txAxisZ, tyAxisX, tyAxisY, tyAxisZ)
          writeLimbFrame(bBuf, bOff + faIdx * 12, elx, ely, elz, wrx, wry, wrz, txAxisX, txAxisY, txAxisZ, tyAxisX, tyAxisY, tyAxisZ)
          this.emitBone(bOff, uaIdx, 3, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, faIdx, 4, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        }
        if (kind) this.emitSpecial(kind, bOff, hidden, tintR, a.hitFlash, alpha)
        continue
      }

      if (a.state === "crawler") {
        const syaw = this.yaw[s]! + angleDiff(a.aim, this.yaw[s]!) * yawStepCap
        this.yaw[s] = syaw
        const speed = Math.hypot(a.vx, a.vy)
        const crawlRate = speed > 0.06 ? Math.max(0.55, speed * 1.45) : 0.28
        const prevPhase = this.phase[s]!
        const curPhase = (prevPhase + crawlRate * dt) % 1
        this.phase[s] = curPhase
        const crawlAngle = curPhase * Math.PI * 2
        const cosY = Math.cos(syaw)
        const sinY = Math.sin(syaw)
        const groundY = support(a.x, a.y)
        const pelvisY = groundY + 0.19 + 0.025 * Math.abs(Math.sin(crawlAngle))

        writeYawFrame(bBuf, pelvisOff, a.x, pelvisY, a.y, syaw + 0.14 * Math.sin(crawlAngle))
        pitchInPlace(bBuf, pelvisOff, -1.28)
        rollInPlace(bBuf, pelvisOff, 0.16 * Math.cos(crawlAngle))

        const tx = bBuf[pelvisOff]! + bBuf[pelvisOff + 6]! * RIG.waist
        const ty = bBuf[pelvisOff + 1]! + bBuf[pelvisOff + 7]! * RIG.waist
        const tz = bBuf[pelvisOff + 2]! + bBuf[pelvisOff + 8]! * RIG.waist
        writeYawFrame(bBuf, torsoOff, tx, ty, tz, syaw - 0.16 * Math.sin(crawlAngle))
        pitchInPlace(bBuf, torsoOff, -1.22 + 0.08 * Math.sin(crawlAngle * 2))
        rollInPlace(bBuf, torsoOff, 0.22 * Math.sin(crawlAngle))

        const hx = bBuf[torsoOff]! + bBuf[torsoOff + 3]! * 0.02 + bBuf[torsoOff + 6]! * RIG.neckY
        const hy = bBuf[torsoOff + 1]! + bBuf[torsoOff + 4]! * 0.02 + bBuf[torsoOff + 7]! * RIG.neckY
        const hz = bBuf[torsoOff + 2]! + bBuf[torsoOff + 5]! * 0.02 + bBuf[torsoOff + 8]! * RIG.neckY
        writeYawFrame(bBuf, headOff, hx, hy, hz, a.aim)
        pitchInPlace(bBuf, headOff, -0.38 + 0.08 * Math.cos(crawlAngle))

        this.emitBone(bOff, 0, 0, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, 1, 1, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, 2, 2, hidden, tintR, tintG, tintB, a.hitFlash, alpha)

        if (speed > 0.08 && ((prevPhase < 0.5 && curPhase >= 0.5) || curPhase < prevPhase)) {
          this.onFootfall?.(a.id, a.x, a.y, speed, 0.92, "crawler")
        }

        const pxAxisX = bBuf[pelvisOff + 3]!
        const pxAxisY = bBuf[pelvisOff + 4]!
        const pxAxisZ = bBuf[pelvisOff + 5]!
        const pzAxisX = bBuf[pelvisOff + 9]!
        const pzAxisY = bBuf[pelvisOff + 10]!
        const pzAxisZ = bBuf[pelvisOff + 11]!
        const txAxisX = bBuf[torsoOff + 3]!
        const txAxisY = bBuf[torsoOff + 4]!
        const txAxisZ = bBuf[torsoOff + 5]!
        const tyAxisX = bBuf[torsoOff + 6]!
        const tyAxisY = bBuf[torsoOff + 7]!
        const tyAxisZ = bBuf[torsoOff + 8]!
        const tzAxisX = bBuf[torsoOff + 9]!
        const tzAxisY = bBuf[torsoOff + 10]!
        const tzAxisZ = bBuf[torsoOff + 11]!

        for (let i = 0; i < 2; i++) {
          const side = i ? 1 : -1
          const hipZ = side * RIG.hipW
          const hipX = bBuf[pelvisOff]! + pzAxisX * hipZ
          const hipY = bBuf[pelvisOff + 1]! + pzAxisY * hipZ
          const hipZWorld = bBuf[pelvisOff + 2]! + pzAxisZ * hipZ
          const trail = 0.58 + 0.1 * Math.sin(crawlAngle + i * Math.PI)
          const poleX = pxAxisX + pzAxisX * (side * 0.35)
          const poleY = pxAxisY + pzAxisY * (side * 0.35)
          const poleZ = pxAxisZ + pzAxisZ * (side * 0.35)
          solveIkToScratch(
            hipX,
            hipY,
            hipZWorld,
            a.x - cosY * trail - sinY * side * 0.16,
            groundY + 0.08,
            a.y - sinY * trail + cosY * side * 0.16,
            RIG.thigh,
            RIG.shin,
            poleX,
            poleY,
            poleZ,
          )
          const kx = ikScratch[0]!
          const ky = ikScratch[1]!
          const kz = ikScratch[2]!
          const ex = ikScratch[3]!
          const ey = ikScratch[4]!
          const ez = ikScratch[5]!
          const thighIdx = 7 + i
          const shinIdx = 9 + i
          const footIdx = 11 + i
          const toeIdx = 13 + i
          const footOff = bOff + footIdx * 12
          const toeOff = bOff + toeIdx * 12
          writeLimbFrame(bBuf, bOff + thighIdx * 12, hipX, hipY, hipZWorld, kx, ky, kz, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)
          writeLimbFrame(bBuf, bOff + shinIdx * 12, kx, ky, kz, ex, ey, ez, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)
          writeYawFrame(bBuf, footOff, ex, ey, ez, syaw)
          pitchInPlace(bBuf, footOff, -1.25)
          const bx = ex + bBuf[footOff + 3]! * RIG.foot - bBuf[footOff + 6]! * RIG.ankle
          const by = ey + bBuf[footOff + 4]! * RIG.foot - bBuf[footOff + 7]! * RIG.ankle
          const bz = ez + bBuf[footOff + 5]! * RIG.foot - bBuf[footOff + 8]! * RIG.ankle
          writeYawFrame(bBuf, toeOff, bx, by, bz, syaw)
          pitchInPlace(bBuf, toeOff, -1.25)
          this.emitBone(bOff, thighIdx, 5, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, shinIdx, 6, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, footIdx, 7, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, toeIdx, 8, hidden, tintR, tintG, tintB, a.hitFlash, alpha)

          const shZ = side * RIG.shoulderW
          const shX = tx + tyAxisX * RIG.shoulderY + tzAxisX * shZ
          const shY = ty + tyAxisY * RIG.shoulderY + tzAxisY * shZ
          const shZWorld = tz + tyAxisZ * RIG.shoulderY + tzAxisZ * shZ
          const armAngle = crawlAngle + (i === 0 ? 0 : Math.PI)
          const reachFwd = 0.42 + 0.22 * Math.sin(armAngle)
          const handLift = Math.max(0, -Math.cos(armAngle)) * 0.1
          const aPoleX = -tyAxisX + tzAxisX * (side * 0.85)
          const aPoleY = -tyAxisY + tzAxisY * (side * 0.85)
          const aPoleZ = -tyAxisZ + tzAxisZ * (side * 0.85)
          solveIkToScratch(
            shX,
            shY,
            shZWorld,
            tx + cosY * reachFwd - sinY * side * 0.22,
            groundY + 0.06 + handLift,
            tz + sinY * reachFwd + cosY * side * 0.22,
            RIG.upper,
            RIG.fore,
            aPoleX,
            aPoleY,
            aPoleZ,
          )
          const elx = ikScratch[0]!
          const ely = ikScratch[1]!
          const elz = ikScratch[2]!
          const wrx = ikScratch[3]!
          const wry = ikScratch[4]!
          const wrz = ikScratch[5]!
          const uaIdx = 3 + i
          const faIdx = 5 + i
          writeLimbFrame(bBuf, bOff + uaIdx * 12, shX, shY, shZWorld, elx, ely, elz, txAxisX, txAxisY, txAxisZ, tyAxisX, tyAxisY, tyAxisZ)
          writeLimbFrame(bBuf, bOff + faIdx * 12, elx, ely, elz, wrx, wry, wrz, txAxisX, txAxisY, txAxisZ, tyAxisX, tyAxisY, tyAxisZ)
          this.emitBone(bOff, uaIdx, 3, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, faIdx, 4, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        }
        if (kind) this.emitSpecial(kind, bOff, hidden, tintR, a.hitFlash, alpha)
        continue
      }
      if (this.collapse[s]! > 0) {
        this.collapse[s] = Math.max(0, this.collapse[s]! - dt * 4.5)
      }

      const clamberLift = a.clamberWindowId
        ? Math.sin(clamp(a.clamberElapsed / Math.max(0.1, a.clamberDuration), 0, 1) * Math.PI) * 0.56
        : 0

      const prevX = this.lastX[s]!
      const prevY = this.lastY[s]!
      const teleport = Math.hypot(a.x - prevX, a.y - prevY) > 2.5
      this.lastX[s] = a.x
      this.lastY[s] = a.y
      if (teleport) {
        this.yaw[s] = a.aim
        this.svx[s] = a.vx
        this.svy[s] = a.vy
        this.chestX[s] = a.aim
        this.chestV[s] = 0
        this.headX[s] = a.aim
        this.headV[s] = 0
        this.reachDropX[s] = 0
        this.reachDropV[s] = 0
        this.twistX[s] = 0
        this.twistV[s] = 0
      }

      const profile = agentZombieProfile(a, zombieTune, this.scratchProfile)
      const strideScale = profile.strideScale
      const torsoLean = profile.torsoLean
      const chestHz = profile.chestHz
      const headHz = profile.headHz
      const timingBias = profile.timingBias
      const torsoRoll = profile.torsoRoll
      const headTilt = profile.headTilt
      const footDrag = profile.footDrag

      const oldSvx = this.svx[s]!
      const oldSvy = this.svy[s]!
      const vx = oldSvx + (a.vx - oldSvx) * expVel
      const vy = oldSvy + (a.vy - oldSvy) * expVel
      const targetLeanX = vx * 0.035 + ((vx - oldSvx) / dt) * 0.003
      const targetLeanY = vy * 0.035 + ((vy - oldSvy) / dt) * 0.003
      let lxx = this.leanXx[s]!
      let lxv = this.leanXv[s]!
      let lyx = this.leanYx[s]!
      let lyv = this.leanYv[s]!
      for (let step = 0; step < springSubsteps; step++) {
        lxv += (-(lxx - targetLeanX) * 90 - lxv * leanDamp) * springH
        lxx += lxv * springH
        lyv += (-(lyx - targetLeanY) * 90 - lyv * leanDamp) * springH
        lyx += lyv * springH
      }
      this.leanXx[s] = lxx
      this.leanXv[s] = lxv
      this.leanYx[s] = lyx
      this.leanYv[s] = lyv
      this.svx[s] = vx
      this.svy[s] = vy

      const speed = Math.hypot(vx, vy)
      const moving = Math.min(1, speed / 3.0)

      // AR-88 characters: a habit at the spot it stands on, a head turned to a noise, a flinch from the torch, an empty
      // lead. All presentation, derived from the seed, position and state every client already has.
      const hb = this.habit
      let habitKind: HabitKind | null = null
      let habitW = 0
      let noiseYaw = 0
      let noiseRoll = 0
      let flinchW = 0
      let leash = false
      const sideHand = ((a.seed >>> 5) & 1) as 0 | 1
      if (chars && !kind) {
        const site = chars.habits && a.state === "wander" && speed < 0.25 ? chars.habits.at(a.x, a.y) : null
        if (site) {
          habitKind = site.kind
          habitW = 1
          habitPose(site.kind, habitTime(site.kind, time, a.id), sideHand, hb)
        }
        if (chars.noiseTurn && (a.state === "wander" || a.state === "investigate" || a.state === "search")) {
          let bestAge = 2.5
          let bestAng = 0
          for (let n = 0; n < chars.noises.length; n++) {
            const ev = chars.noises[n]!
            if (ev.kind === "groan" || ev.sourceId.startsWith("zombie")) continue
            const age = time - ev.time
            if (age < 0 || age >= bestAge) continue
            const dx = ev.x - a.x
            const dy = ev.y - a.y
            const reach = Math.min(14, ev.radius * 1.2)
            if (dx * dx + dy * dy > reach * reach) continue
            bestAge = age
            bestAng = Math.atan2(dy, dx)
          }
          if (bestAge < 2.5) {
            // A beat late, then the head comes round and tilts, and slowly settles back.
            const w = smooth((bestAge - 0.12) / 0.25) * (1 - bestAge / 2.5)
            const diff = angleDiff(bestAng, a.aim)
            noiseYaw = clamp(diff, -1.15, 1.15) * w
            noiseRoll = (diff >= 0 ? 0.24 : -0.24) * w
            habitW *= 1 - 0.75 * w
          }
        }
        if (chars.flinch && isVisible && a.state !== "bash") {
          let lit = false
          for (const b of chars.beams) {
            if (!b.on) continue
            const dx = a.x - b.x
            const dy = a.y - b.y
            const d2 = dx * dx + dy * dy
            if (d2 > 81 || d2 < 0.25) continue
            const toZ = Math.atan2(dy, dx)
            if (Math.abs(angleDiff(toZ, b.aim)) > 0.3) continue
            if (Math.abs(angleDiff(toZ + Math.PI, a.aim)) > 1.2) continue
            lit = true
            break
          }
          if (lit && !this.inBeam[s] && time >= this.flinchReady[s]!) {
            this.flinchAge[s] = 0
            this.flinchReady[s] = time + 7
          }
          this.inBeam[s] = lit ? 1 : 0
        }
        const fa = this.flinchAge[s]!
        if (fa >= 0) {
          const age = fa + dt
          this.flinchAge[s] = age > 0.85 ? -1 : age
          flinchW = age < 0.12 ? smooth(age / 0.12) : 1 - smooth((age - 0.3) / 0.55)
        }
        leash = chars.leash && !habitKind && a.state === "wander" && walksEmptyLeash(a.seed, a.id)
        if (this.currentArch === CALLING_JOGGER && refined && isVisible && chars.earbuds.length < 8) chars.earbuds.push({ id: a.id, x: a.x, y: a.y })
      }
      let travel = speed > 0.25 ? Math.atan2(vy, vx) : a.aim
      if (Math.abs(angleDiff(travel, a.aim)) > 2.05) travel += Math.PI
      const want = a.aim + clamp(angleDiff(travel, a.aim), -1.05, 1.05)
      const syaw = this.yaw[s]! + angleDiff(want, this.yaw[s]!) * yawStepCap
      this.yaw[s] = syaw
      const cosY = Math.cos(syaw)
      const sinY = Math.sin(syaw)

      const f0 = s * 2
      const f1 = f0 + 1
      const rest0X = a.x + sinY * 0.13
      const rest0Z = a.y - cosY * 0.13
      const rest1X = a.x - sinY * 0.13
      const rest1Z = a.y + cosY * 0.13

      if (teleport) {
        const y0 = support(rest0X, rest0Z) + clamberLift
        const y1 = support(rest1X, rest1Z) + clamberLift
        this.footPx[f0] = rest0X
        this.footPy[f0] = y0
        this.footPz[f0] = rest0Z
        this.footLiftX[f0] = rest0X
        this.footLiftY[f0] = y0
        this.footLiftZ[f0] = rest0Z
        this.footTargetX[f0] = rest0X
        this.footTargetY[f0] = y0
        this.footTargetZ[f0] = rest0Z
        this.footPrevU[f0] = 0
        this.footPlanted[f0] = 1
        this.footYaw[f0] = syaw

        this.footPx[f1] = rest1X
        this.footPy[f1] = y1
        this.footPz[f1] = rest1Z
        this.footLiftX[f1] = rest1X
        this.footLiftY[f1] = y1
        this.footLiftZ[f1] = rest1Z
        this.footTargetX[f1] = rest1X
        this.footTargetY[f1] = y1
        this.footTargetZ[f1] = rest1Z
        this.footPrevU[f1] = 0
        this.footPlanted[f1] = 1
        this.footYaw[f1] = syaw
      }
      const actorSeed = a.id === 1 && (zombieTune.zombieVariant ?? 0) === 0 ? 0 : a.seed
      const dragFoot = resolveDragFoot(actorSeed)
      const needsStep =
        speed < 0.2 &&
        (!this.footPlanted[f0] ||
          !this.footPlanted[f1] ||
          Math.hypot(this.footPx[f0]! - rest0X, this.footPz[f0]! - rest0Z) > 0.22 ||
          Math.hypot(this.footPx[f1]! - rest1X, this.footPz[f1]! - rest1Z) > 0.22)
      const legH = RIG.thigh + RIG.shin
      const froude = (speed * speed) / (9.81 * legH)
      const run = smooth((froude - 0.36) / 0.28)
      const effSpeed = speed - 0.22 * Math.max(0, speed - 3.6) * smooth((speed - 3.0) / 3.3)
      const stride = ((legH * (effSpeed / Math.sqrt(9.81 * legH) + 0.665 - 0.015 * run)) / 0.83) * strideScale
      const duty = 0.56 - 0.12 * run - 0.2 * smooth((speed - 2.5) / 3)
      const dragSlow = 1 - 0.22 * clamp(footDrag, 0, 0.95) * (1 - 0.5 * run)
      const rate = speed >= 0.15 ? Math.max(0.72, (speed / stride) * dragSlow) : needsStep ? 1.25 : 0
      const curPhase = (this.phase[s]! + rate * dt) % 1
      this.phase[s] = curPhase

      for (let i = 0; i < 2; i++) {
        const fi = f0 + i
        const fo = f0 + (1 - i)
        const isDrag = i === dragFoot
        const dragAmt = isDrag ? clamp(footDrag, 0, 0.95) : 0
        const fPhase = (curPhase + i * (0.5 + timingBias * 0.22)) % 1
        if (rate > 0 && fPhase >= duty) {
          const u = (fPhase - duty) / (1 - duty)
          const e = smoother(u)
          const eHoriz = dragAmt > 0 ? e * (1 - 0.34 * dragAmt * (1 - u)) : e
          if (this.footPlanted[fi]) {
            this.footPlanted[fi] = 0
            this.footLiftX[fi] = this.footPx[fi]!
            this.footLiftY[fi] = this.footPy[fi]!
            this.footLiftZ[fi] = this.footPz[fi]!
            this.footPrevU[fi] = 0
          }
          const lead = Math.min(0.38, (1 - fPhase) / rate + (duty / rate) * 0.48) * (isDrag ? 1 - 0.18 * dragAmt : 1.06)
          let tx = (i ? rest1X : rest0X) + vx * lead
          let tz = (i ? rest1Z : rest0Z) + vy * lead
          const side = i ? 1 : -1
          const lat = (-(tx - this.footPx[fo]!) * sinY + (tz - this.footPz[fo]!) * cosY) * side
          if (lat < 0.16) {
            tx -= sinY * side * (0.16 - lat)
            tz += cosY * side * (0.16 - lat)
          }
          const ty = support(tx, tz) + clamberLift
          const prevU = this.footPrevU[fi]!
          const epPrev = smoother(prevU) * (dragAmt > 0 ? 1 - 0.34 * dragAmt * (1 - prevU) : 1)
          if (epPrev > 0 && epPrev < 0.96 && u < 0.78) {
            const curX = this.footLiftX[fi]! + (this.footTargetX[fi]! - this.footLiftX[fi]!) * epPrev
            const curY = this.footLiftY[fi]! + (this.footTargetY[fi]! - this.footLiftY[fi]!) * epPrev
            const curZ = this.footLiftZ[fi]! + (this.footTargetZ[fi]! - this.footLiftZ[fi]!) * epPrev
            this.footLiftX[fi] = (curX - tx * epPrev) / (1 - epPrev)
            this.footLiftY[fi] = (curY - ty * epPrev) / (1 - epPrev)
            this.footLiftZ[fi] = (curZ - tz * epPrev) / (1 - epPrev)
            this.footTargetX[fi] = tx
            this.footTargetY[fi] = ty
            this.footTargetZ[fi] = tz
          } else if (prevU === 0) {
            this.footTargetX[fi] = tx
            this.footTargetY[fi] = ty
            this.footTargetZ[fi] = tz
          }
          this.footPrevU[fi] = u
          const tgtX = this.footTargetX[fi]!
          const tgtY = this.footTargetY[fi]!
          const tgtZ = this.footTargetZ[fi]!
          const lx = this.footLiftX[fi]!
          const ly = this.footLiftY[fi]!
          const lz = this.footLiftZ[fi]!
          const clearance = isDrag ? Math.max(0.08, (1 - dragAmt) * 0.85) : 1.08
          const liftBell = 1.72 * Math.sin(Math.PI * u) ** 2 * (1 - u)
          const px = lx + (tgtX - lx) * eHoriz
          const pz = lz + (tgtZ - lz) * eHoriz
          const py = Math.max(
            support(px, pz) + clamberLift,
            ly + (tgtY - ly) * eHoriz + liftBell * (0.092 + 0.055 * moving) * clearance,
          )
          this.footPx[fi] = px
          this.footPy[fi] = py
          this.footPz[fi] = pz
          this.footYaw[fi] = this.footYaw[fi]! + angleDiff(syaw, this.footYaw[fi]!) * e
        } else if (!this.footPlanted[fi]) {
          this.footPlanted[fi] = 1
          this.footPrevU[fi] = 0
          const tx = this.footTargetX[fi]!
          const tz = this.footTargetZ[fi]!
          this.footPx[fi] = tx
          this.footPy[fi] = support(tx, tz) + clamberLift
          this.footPz[fi] = tz
          this.footYaw[fi] = syaw
          this.onFootfall?.(a.id, tx, tz, speed, dragAmt, profile.zombieVariant)
        }
      }

      const footSupport =
        (support(this.footPx[f0]!, this.footPz[f0]!) + support(this.footPx[f1]!, this.footPz[f1]!)) * 0.5 + clamberLift
      const supportY = (support(a.x, a.y) + clamberLift) * 0.65 + footSupport * 0.35
      const shambleGait = smooth((speed - 0.12) / 0.35)
      const shambleMod = shambleTorsoModulation(curPhase, shambleGait, profile, actorSeed)
      const limpDip = a.limping ? 0.068 * Math.max(0, Math.sin(curPhase * Math.PI * 2)) : 0
      const limpRoll = a.limping ? (dragFoot === 0 ? -1 : 1) * 0.16 * Math.sin(curPhase * Math.PI * 2) : 0
      const hr = this.physics?.react(a.id, syaw) ?? null
      const staggerU = a.state === "stagger" ? clamp(a.timer / 0.35, 0, 1) * (this.physics?.cannedStagger ?? 1) : 0
      const hitReaction = a.hitReaction ?? (((a.seed >>> 4) % 3) as 0 | 1 | 2)
      const staggerDrop =
        staggerU > 0 ? (hitReaction === 2 ? 0.16 : hitReaction === 1 ? 0.04 : 0.025) * staggerU : 0
      const baseHeight =
        supportY +
        HIP -
        0.012 * moving +
        shambleMod.pelvisBobAdd -
        0.016 * shambleGait * Math.sin(curPhase * Math.PI * 4 - 0.35) -
        limpDip -
        staggerDrop
      const d0 = Math.min(0.72, Math.hypot(this.footPx[f0]! - a.x, this.footPz[f0]! - a.y))
      const reach0 = Math.sqrt(Math.max(0, 0.822 * 0.822 - d0 * d0)) + RIG.ankle + this.footPy[f0]!
      const d1 = Math.min(0.72, Math.hypot(this.footPx[f1]! - a.x, this.footPz[f1]! - a.y))
      const reach1 = Math.sqrt(Math.max(0, 0.822 * 0.822 - d1 * d1)) + RIG.ankle + this.footPy[f1]!
      const desiredDrop = Math.max(
        0,
        Math.min(0.14, baseHeight - Math.min(reach0, reach1)),
      )
      const fdx = this.footPx[f1]! - this.footPx[f0]!
      const fdz = this.footPz[f1]! - this.footPz[f0]!
      const footFwd = fdx * cosY + fdz * sinY
      const targetTwist = clamp(footFwd * 0.28, -0.16, 0.16) * (profile.twistScale ?? 1.4)
      let rdx = this.reachDropX[s]!
      let rdv = this.reachDropV[s]!
      let twx = this.twistX[s]!
      let twv = this.twistV[s]!
      const reachDamp = 2 * Math.sqrt(120) * 0.88
      const twistDamp = 2 * Math.sqrt(110) * 0.85
      for (let step = 0; step < springSubsteps; step++) {
        rdv += (-(rdx - desiredDrop) * 120 - rdv * reachDamp) * springH
        rdx += rdv * springH
        twv += (-(twx - targetTwist) * 110 - twv * twistDamp) * springH
        twx += twv * springH
      }
      this.reachDropX[s] = rdx
      this.reachDropV[s] = rdv
      this.twistX[s] = twx
      this.twistV[s] = twv

      const height = baseHeight - rdx - (kind ? specialCrouch(kind, a.state) : 0)
      // A strike that just landed: the body lunges at its target, weight over the front foot, the torso pitches in
      // and both hands thrust out, the lead hand furthest.
      const strikeAge = this.strikes.get(a.id)
      const strikeU = strikeAge === undefined ? 0 : strikeEnvelope(strikeAge) * Math.max(0, this.strikeScale)
      const lungeX = Math.cos(a.aim) * 0.12 * strikeU
      const lungeZ = Math.sin(a.aim) * 0.12 * strikeU
      writeYawFrame(bBuf, pelvisOff, a.x + lungeX, height - 0.03 * strikeU - (hr ? hr.drop : 0), a.y + lungeZ, syaw + twx + (hr ? hr.twist * 0.3 : 0))
      rollInPlace(bBuf, pelvisOff, shambleMod.pelvisRollAdd + limpRoll)
      pitchInPlace(bBuf, pelvisOff, -0.06 * moving - 0.35 * shambleMod.torsoPitchAdd)
      const lean = lxx * Math.cos(a.aim) + lyx * Math.sin(a.aim)

      // Inline angleSpring for chest and head
      const chestGoal = a.aim - twx * 0.55 + shambleMod.torsoYawAdd
      const flinchSide = sideHand ? 1 : -1
      const headGoal = a.aim + shambleMod.headYawAdd + noiseYaw + habitW * hb.headYaw - flinchSide * 0.55 * flinchW
      const wChest = chestHz * Math.PI * 2
      const kChest = wChest * wChest
      const cChest = 2 * wChest * 0.85
      let cx = this.chestX[s]!
      let cv = this.chestV[s]!
      const wHead = headHz * Math.PI * 2
      const kHead = wHead * wHead
      const cHead = 2 * wHead * 0.85
      let hxAng = this.headX[s]!
      let hv = this.headV[s]!
      for (let step = 0; step < springSubsteps; step++) {
        cv += (angleDiff(chestGoal, cx) * kChest - cv * cChest) * springH
        cx += cv * springH
        hv += (angleDiff(headGoal, hxAng) * kHead - hv * cHead) * springH
        hxAng += hv * springH
      }
      this.chestX[s] = cx
      this.chestV[s] = cv
      this.headX[s] = hxAng
      this.headV[s] = hv

      const bashPulse =
        a.state === "bash" ? Math.pow(Math.max(0, Math.sin((a.stateTime * Math.PI * 2) / 0.9)), 3) * 0.34 : 0
      const sideSign = a.id % 2 ? 1 : -1
      const staggerRecoil =
        staggerU > 0
          ? (hitReaction === 2 ? 0.32 : hitReaction === 1 ? -0.24 : -0.44) * staggerU
          : -0.18 * a.hitFlash
      const staggerCant =
        staggerU > 0
          ? sideSign * (hitReaction === 1 ? 0.34 : hitReaction === 2 ? 0.26 : 0.18) * staggerU
          : 0
      const staggerYaw = staggerU > 0 && hitReaction === 1 ? sideSign * 0.58 * staggerU : 0

      const torsoPx = bBuf[pelvisOff]! + bBuf[pelvisOff + 6]! * RIG.waist
      const torsoPy = bBuf[pelvisOff + 1]! + bBuf[pelvisOff + 7]! * RIG.waist
      const torsoPz = bBuf[pelvisOff + 2]! + bBuf[pelvisOff + 8]! * RIG.waist
      writeYawFrame(bBuf, torsoOff, torsoPx, torsoPy, torsoPz, cx + staggerYaw + (hr ? hr.twist : 0))
      const hunch = kind ? specialHunch(kind, speed, a.state) : 0
      pitchInPlace(bBuf, torsoOff, -0.04 - lean - shambleMod.torsoPitchAdd - bashPulse - staggerRecoil - 0.42 * strikeU - hunch + (hr ? hr.pitch : 0) + habitW * hb.torsoPitch + 0.06 * flinchW)
      pitchInPlace(bBuf, torsoOff, -clamp(torsoLean, -0.15, 0.35))
      rollInPlace(bBuf, torsoOff, clamp(torsoRoll, -0.2, 0.2))
      rollInPlace(bBuf, torsoOff, shambleMod.torsoRollAdd + staggerCant + limpRoll * 0.75 + (hr ? hr.roll : 0) + habitW * hb.torsoRoll)

      const headPx = torsoPx + bBuf[torsoOff + 3]! * 0.02 + bBuf[torsoOff + 6]! * RIG.neckY
      const headPy = torsoPy + bBuf[torsoOff + 4]! * 0.02 + bBuf[torsoOff + 7]! * RIG.neckY
      const headPz = torsoPz + bBuf[torsoOff + 5]! * 0.02 + bBuf[torsoOff + 8]! * RIG.neckY
      writeYawFrame(bBuf, headOff, headPx, headPy, headPz, hxAng + staggerYaw * 0.8 + (hr ? hr.twist + hr.headYaw : 0))
      pitchInPlace(bBuf, headOff, -0.12 * torsoLean - shambleMod.headPitchAdd - staggerRecoil * 0.6 + (kind ? specialHeadLift(kind, hunch, a.state) : 0) + (hr ? hr.pitch + hr.headPitch : 0) + habitW * hb.headPitch - 0.32 * flinchW)
      rollInPlace(bBuf, headOff, headTilt + shambleMod.headRollAdd + staggerCant * 0.5 + (hr ? hr.roll + hr.headRoll : 0) + habitW * hb.headRoll + noiseRoll)

      this.emitBone(bOff, 0, 0, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
      this.emitBone(bOff, 1, 1, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
      this.emitBone(bOff, 2, 2, hidden, tintR, tintG, tintB, a.hitFlash, alpha)

      // Solve FK shamble arms in-place
      const txAxisX = bBuf[torsoOff + 3]!
      const txAxisY = bBuf[torsoOff + 4]!
      const txAxisZ = bBuf[torsoOff + 5]!
      const tyAxisX = bBuf[torsoOff + 6]!
      const tyAxisY = bBuf[torsoOff + 7]!
      const tyAxisZ = bBuf[torsoOff + 8]!
      const tzAxisX = bBuf[torsoOff + 9]!
      const tzAxisY = bBuf[torsoOff + 10]!
      const tzAxisZ = bBuf[torsoOff + 11]!

      const tf = this.scratchTorsoFrame
      tf.p[0] = torsoPx; tf.p[1] = torsoPy; tf.p[2] = torsoPz
      tf.x[0] = txAxisX; tf.x[1] = txAxisY; tf.x[2] = txAxisZ
      tf.y[0] = tyAxisX; tf.y[1] = tyAxisY; tf.y[2] = tyAxisZ
      tf.z[0] = tzAxisX; tf.z[1] = tzAxisY; tf.z[2] = tzAxisZ
      const runBlend = clamp((speed - 1.5) / 1.5, 0, 1)
      const [hL, hR] = shambleHandsFK(tf, curPhase, shambleGait, runBlend, profile, actorSeed, this.scratchHands)
      if (strikeU > 0) {
        for (let i = 0; i < 2; i++) {
          const hand = i === 0 ? hL : hR
          const k = strikeU * ((i === 0) === (sideSign < 0) ? 1 : 0.65)
          hand[0] += txAxisX * 0.36 * k + tyAxisX * 0.14 * k
          hand[1] += txAxisY * 0.36 * k + tyAxisY * 0.14 * k
          hand[2] += txAxisZ * 0.36 * k + tyAxisZ * 0.14 * k
        }
      }
      if (habitW > 0 || flinchW > 0 || leash) {
        for (let i = 0; i < 2; i++) {
          const side = i === 0 ? -1 : 1
          const hand = i === 0 ? hL : hR
          const shX = torsoPx + tyAxisX * RIG.shoulderY + tzAxisX * (side * RIG.shoulderW)
          const shY = torsoPy + tyAxisY * RIG.shoulderY + tzAxisY * (side * RIG.shoulderW)
          const shZ = torsoPz + tyAxisZ * RIG.shoulderY + tzAxisZ * (side * RIG.shoulderW)
          const reachTo = (f: number, u: number, l: number, w: number) => {
            if (w <= 0) return
            hand[0] += (shX + txAxisX * f + tyAxisX * u + tzAxisX * side * l - hand[0]) * w
            hand[1] += (shY + txAxisY * f + tyAxisY * u + tzAxisY * side * l - hand[1]) * w
            hand[2] += (shZ + txAxisZ * f + tyAxisZ * u + tzAxisZ * side * l - hand[2]) * w
          }
          const goal = hb.hand[i]!
          reachTo(goal[0]!, goal[1]!, goal[2]!, habitW * hb.handW[i]!)
          if (leash && i === sideHand) reachTo(0.3, -0.36, 0.03, 1)
          // The near hand comes up between the face and the light.
          if (i === sideHand) reachTo(0.26, 0.34, -0.12, flinchW)
        }
      }
      let leadX = 0
      let leadY = 0
      let leadZ = 0

      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1
        const shX = torsoPx + tyAxisX * RIG.shoulderY + tzAxisX * (side * RIG.shoulderW)
        const shY = torsoPy + tyAxisY * RIG.shoulderY + tzAxisY * (side * RIG.shoulderW)
        const shZ = torsoPz + tyAxisZ * RIG.shoulderY + tzAxisZ * (side * RIG.shoulderW)
        const target = i === 0 ? hL : hR
        const dwx = target[0] - shX
        const dwy = target[1] - shY
        const dwz = target[2] - shZ
        const dxDot = dwx * txAxisX + dwy * txAxisY + dwz * txAxisZ
        const dyDot = dwx * tyAxisX + dwy * tyAxisY + dwz * tyAxisZ
        const liftArm = clamp((dyDot + 0.35) / 0.45, 0, 1)
        const backArm = clamp((-dxDot + 0.10) / 0.35, 0, 1)
        const pxLocal = -0.95 - 0.25 * liftArm
        const pyLocal = -0.55 + 0.70 * backArm
        const pzLocal = side * (0.24 + 0.14 * liftArm)
        const poleX = txAxisX * pxLocal + tyAxisX * pyLocal + tzAxisX * pzLocal
        const poleY = txAxisY * pxLocal + tyAxisY * pyLocal + tzAxisY * pzLocal
        const poleZ = txAxisZ * pxLocal + tyAxisZ * pyLocal + tzAxisZ * pzLocal
        solveIkToScratch(shX, shY, shZ, target[0], target[1], target[2], RIG.upper, RIG.fore, poleX, poleY, poleZ)
        writeLimbFrame(bBuf, bOff + (3 + i) * 12, shX, shY, shZ, ikScratch[0]!, ikScratch[1]!, ikScratch[2]!, txAxisX, txAxisY, txAxisZ, tyAxisX, tyAxisY, tyAxisZ)
        writeLimbFrame(bBuf, bOff + (5 + i) * 12, ikScratch[0]!, ikScratch[1]!, ikScratch[2]!, ikScratch[3]!, ikScratch[4]!, ikScratch[5]!, txAxisX, txAxisY, txAxisZ, tyAxisX, tyAxisY, tyAxisZ)
        if (leash && i === sideHand) {
          // The hand's end of the lead: just past the wrist along the forearm.
          const ex = ikScratch[3]! - ikScratch[0]!
          const ey = ikScratch[4]! - ikScratch[1]!
          const ez = ikScratch[5]! - ikScratch[2]!
          const el = Math.max(1e-4, Math.hypot(ex, ey, ez))
          leadX = ikScratch[3]! + (ex / el) * 0.06
          leadY = ikScratch[4]! + (ey / el) * 0.06
          leadZ = ikScratch[5]! + (ez / el) * 0.06
        }
      }
      if (leash && (hidden & BONE_SUBTREE_MASK[sideHand ? "right.foreArm" : "left.foreArm"]) === 0) {
        // Nothing on the end: the collar trots ahead at a small dog's neck height, nosing side to side.
        const dir = speed > 0.2 ? Math.atan2(vy, vx) : a.aim
        const sniff = Math.sin(time * 0.8 + a.id * 1.3)
        const tx = a.x + Math.cos(dir) * 1.35 - Math.sin(dir) * 0.32 * sniff
        const ty = a.y + Math.sin(dir) * 1.35 + Math.cos(dir) * 0.32 * sniff
        const k = 22
        const c = 2 * Math.sqrt(k) * 0.75
        this.collarVx[s] = this.collarVx[s]! + ((tx - this.collarX[s]!) * k - this.collarVx[s]! * c) * dt
        this.collarVy[s] = this.collarVy[s]! + ((ty - this.collarY[s]!) * k - this.collarVy[s]! * c) * dt
        this.collarX[s] = this.collarX[s]! + this.collarVx[s]! * dt
        this.collarY[s] = this.collarY[s]! + this.collarVy[s]! * dt
        const cx = this.collarX[s]!
        const cz = this.collarY[s]!
        const trot = speed > 0.2 ? 0.02 * Math.abs(Math.sin(time * 8.5 + a.id)) : 0.006 * Math.sin(time * 2 + a.id)
        const cy = support(cx, cz) + 0.33 + trot
        const chord = Math.hypot(cx - leadX, cz - leadZ)
        this.charAccessories.lead(leadX, leadY, leadZ, cx, cy, cz, Math.max(0.02, 1.25 - chord) * 0.35, dir, tintR, alpha)
      } else if (chars && !leash) {
        this.collarX[s] = a.x + Math.cos(a.aim) * 1.3
        this.collarY[s] = a.y + Math.sin(a.aim) * 1.3
        this.collarVx[s] = this.collarVy[s] = 0
      }

      // Solve legs in-place
      const pxAxisX = bBuf[pelvisOff + 3]!
      const pxAxisY = bBuf[pelvisOff + 4]!
      const pxAxisZ = bBuf[pelvisOff + 5]!
      const pyAxisX = bBuf[pelvisOff + 6]!
      const pyAxisY = bBuf[pelvisOff + 7]!
      const pyAxisZ = bBuf[pelvisOff + 8]!
      const pzAxisX = bBuf[pelvisOff + 9]!
      const pzAxisY = bBuf[pelvisOff + 10]!
      const pzAxisZ = bBuf[pelvisOff + 11]!

      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1
        const fi = f0 + i
        const isDrag = i === dragFoot
        const dragAmt = isDrag ? clamp(footDrag, 0, 0.95) : 0
        const hipZ = side * RIG.hipW
        const hipX = a.x + lungeX + pzAxisX * hipZ
        const hipY = height - 0.03 * strikeU + pzAxisY * hipZ
        const hipZWorld = a.y + lungeZ + pzAxisZ * hipZ
        const ankX = this.footPx[fi]!
        const ankY = this.footPy[fi]! + RIG.ankle
        const ankZ = this.footPz[fi]!
        const poleX = pxAxisX + pyAxisX * 0.28 + pzAxisX * (side * 0.25)
        const poleY = pxAxisY + pyAxisY * 0.28 + pzAxisY * (side * 0.25)
        const poleZ = pxAxisZ + pyAxisZ * 0.28 + pzAxisZ * (side * 0.25)
        solveIkToScratch(hipX, hipY, hipZWorld, ankX, ankY, ankZ, RIG.thigh, RIG.shin, poleX, poleY, poleZ)
        const kx = ikScratch[0]!
        const ky = ikScratch[1]!
        const kz = ikScratch[2]!
        const ex = ikScratch[3]!
        const ey = ikScratch[4]!
        const ez = ikScratch[5]!
        const thighIdx = 7 + i
        const shinIdx = 9 + i
        const footIdx = 11 + i
        const toeIdx = 13 + i
        writeLimbFrame(bBuf, bOff + thighIdx * 12, hipX, hipY, hipZWorld, kx, ky, kz, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)
        writeLimbFrame(bBuf, bOff + shinIdx * 12, kx, ky, kz, ex, ey, ez, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)

        const footPhase = (curPhase + i * (0.5 + timingBias * 0.22)) % 1
        const planted = this.footPlanted[fi] !== 0
        const stanceFrac = planted ? clamp(footPhase / Math.max(0.1, duty), 0, 1) : 0
        const prevU = this.footPrevU[fi]!
        const stancePitch = isDrag
          ? -0.22 * smooth((stanceFrac - 0.58) / 0.42) * dragAmt * shambleGait
          : -0.24 * smooth((stanceFrac - 0.58) / 0.42) * shambleGait
        const swingPitch = isDrag
          ? -0.24 * Math.sin(Math.PI * (1 - prevU * 0.65)) * dragAmt
          : (-0.18 * Math.sin(Math.PI * clamp(prevU / 0.55, 0, 1)) +
              0.14 * Math.sin(Math.PI * clamp((prevU - 0.5) / 0.5, 0, 1))) *
            shambleGait
        const fyaw = this.footYaw[fi]!
        const fc = Math.cos(fyaw)
        const fs = Math.sin(fyaw)
        const footOff = bOff + footIdx * 12
        const toeOff = bOff + toeIdx * 12
        if (planted) {
          const ballX = this.footPx[fi]! + fc * RIG.foot
          const ballY = this.footPy[fi]!
          const ballZ = this.footPz[fi]! + fs * RIG.foot
          writeYawFrame(bBuf, footOff, 0, 0, 0, fyaw)
          pitchInPlace(bBuf, footOff, stancePitch)
          const offX = bBuf[footOff + 3]! * RIG.foot - bBuf[footOff + 6]! * RIG.ankle
          const offY = bBuf[footOff + 4]! * RIG.foot - bBuf[footOff + 7]! * RIG.ankle
          const offZ = bBuf[footOff + 5]! * RIG.foot - bBuf[footOff + 8]! * RIG.ankle
          bBuf[footOff] = ballX - offX
          bBuf[footOff + 1] = ballY - offY
          bBuf[footOff + 2] = ballZ - offZ
          // Planted toe stays locked on the ball at ground level while the heel rises (dorsiflexing relative to the foot)
          writeYawFrame(bBuf, toeOff, ballX, ballY, ballZ, fyaw)
        } else {
          writeYawFrame(bBuf, footOff, ex, ey, ez, fyaw)
          pitchInPlace(bBuf, footOff, swingPitch)
          const bx = ex + bBuf[footOff + 3]! * RIG.foot - bBuf[footOff + 6]! * RIG.ankle
          const by = ey + bBuf[footOff + 4]! * RIG.foot - bBuf[footOff + 7]! * RIG.ankle
          const bz = ez + bBuf[footOff + 5]! * RIG.foot - bBuf[footOff + 8]! * RIG.ankle
          // Dragged foot scrapes flat along the toe; swinging lead foot dorsiflexes toe for clearance
          const toeWorldPitch = isDrag
            ? swingPitch * (1 - 0.85 * dragAmt)
            : swingPitch + 0.18 * Math.sin(Math.PI * prevU) * shambleGait
          writeYawFrame(bBuf, toeOff, bx, Math.max(this.footPy[fi]!, by), bz, fyaw)
          pitchInPlace(bBuf, toeOff, toeWorldPitch)
        }

        this.emitBone(bOff, thighIdx, 5, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, shinIdx, 6, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, footIdx, 7, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, toeIdx, 8, hidden, tintR, tintG, tintB, a.hitFlash, alpha)

        const uaIdx = 3 + i
        const faIdx = 5 + i
        this.emitBone(bOff, uaIdx, 3, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, faIdx, 4, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
      }
      if (kind) this.emitSpecial(kind, bOff, hidden, tintR, a.hitFlash, alpha)

      if (isVisible) {
        this.seenAt[s] = time
        this.seenX[s] = a.x
        this.seenY[s] = a.y
        for (let f = 0; f < BONE_STRIDE; f++) {
          this.seenBones[bOff + f] = bBuf[bOff + f]!
        }
      }
    }

    this.agentScale = 1
    this.batches.length = 0
    this.batches.push(...this.accessories.collect())
    this.batches.push(...this.charAccessories.collect())
    if (refined) {
      for (let i = 0; i < ARCH_BUCKET_COUNT; i++) {
        const count = this.archPartCounts[i]!
        if (count > 0) {
          const b = this.archPoolBatches![i]!
          b.count = count
          this.batches.push(b)
        }
      }
      for (let i = ARCH_PART_COUNT; i < PART_COUNT; i++) {
        const count = this.partCounts[i]!
        if (count > 0) {
          const b = this.poolBatches[i]!
          b.count = count
          this.batches.push(b)
        }
      }
      for (let i = 0; i < ARCH_BUCKET_COUNT; i++) {
        const count = this.archGhostPartCounts[i]!
        if (count > 0) {
          const b = this.archGhostPoolBatches![i]!
          b.count = count
          this.batches.push(b)
        }
      }
      for (let i = ARCH_PART_COUNT; i < PART_COUNT; i++) {
        const count = this.ghostPartCounts[i]!
        if (count > 0) {
          const b = this.ghostPoolBatches[i]!
          b.count = count
          this.batches.push(b)
        }
      }
    } else {
      for (let i = 0; i < PART_COUNT; i++) {
        const count = this.partCounts[i]!
        if (count > 0) {
          const b = this.poolBatches[i]!
          b.count = count
          this.batches.push(b)
        }
      }
      for (let i = 0; i < PART_COUNT; i++) {
        const count = this.ghostPartCounts[i]!
        if (count > 0) {
          const b = this.ghostPoolBatches[i]!
          b.count = count
          this.batches.push(b)
        }
      }
    }
    return this.batches
  }

  /**
   * Appends AI debug overlay sprites (sight cones, hearing rings, noise events, paths, alert markers)
   * and renders crisp 2D state labels when aiDebugOverlay is enabled.
   */
  renderDebugOverlay(
    enabled: boolean,
    agents: readonly AIAgent[],
    noiseEvents: readonly NoiseEvent[],
    player: { x: number; y: number; noise: number },
    config: AIConfig,
    time: number,
    support: (x: number, z: number) => number,
    cam: Camera,
    screenW: number,
    screenH: number,
    alphaSprites: Float32Array,
    startAlphaCount: number,
  ): number {
    let alphaCount = startAlphaCount
    const maxSprites = Math.floor(alphaSprites.length / SPRITE_FLOATS)

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
      if (alphaCount >= maxSprites) return
      const o = alphaCount++ * SPRITE_FLOATS
      alphaSprites[o] = x
      alphaSprites[o + 1] = y
      alphaSprites[o + 2] = z
      alphaSprites[o + 3] = size
      alphaSprites[o + 4] = r
      alphaSprites[o + 5] = g
      alphaSprites[o + 6] = b
      alphaSprites[o + 7] = a
      alphaSprites[o + 8] = kind
      alphaSprites[o + 9] = rot
      alphaSprites[o + 10] = stretch
      alphaSprites[o + 11] = extra
    }

    // Even when full debug overlay is off, show subtle alert "!" marker on newly alerted zombies in LOS
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!
      if (a.state === "alert" && (enabled || a.hitFlash > 0.05)) {
        const gy = support(a.x, a.y)
        pushSprite(a.x, gy + 2.25, a.y, 0.22, 1.0, 0.32, 0.18, 0.92, 7, 0, 1, 0)
      }
    }

    if (!enabled) {
      if (this.overlayCanvas) this.overlayCanvas.hidden = true
      return alphaCount
    }

    // 1. Player continuous noise ring
    const py = support(player.x, player.y) + 0.05
    pushSprite(player.x, py, player.y, Math.max(0.8, player.noise), 0.35, 0.78, 0.95, 0.55, 5, time * 0.4, 0.04, 0)

    // 2. Active NoiseEvents on the bus
    for (let i = 0; i < noiseEvents.length; i++) {
      const ev = noiseEvents[i]!
      const age = Math.max(0, time - ev.time)
      const u = clamp(age / Math.max(0.2, ev.ttl), 0, 1)
      const ny = support(ev.x, ev.y) + 0.06
      const isLoud = ev.kind === "gunshot" || ev.kind === "bash" || ev.kind === "vault"
      const r = isLoud ? 1.0 : 0.35
      const g = isLoud ? 0.42 : 0.88
      const b = isLoud ? 0.2 : 0.98
      // Outer effective radius ring + expanding wave ring
      pushSprite(ev.x, ny, ev.y, ev.radius * config.hearingScale, r, g, b, (1 - u) * 0.45, 5, 0, 0.025, 0)
      pushSprite(
        ev.x,
        ny,
        ev.y,
        Math.max(0.6, ev.radius * config.hearingScale * (0.2 + 0.8 * u)),
        r,
        g,
        b,
        (1 - u) * 0.78,
        2,
        0,
        0.045,
        0,
      )
    }

    // 3. Per-zombie sight cones, proximity rings, and A* path segments (culled to camera neighborhood)
    const halfConeRad = (config.sightCone * Math.PI) / 360
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!
      if (a.state === "dead") continue
      if (Math.hypot(a.x - player.x, a.y - player.y) > 26) continue
      const ay = support(a.x, a.y) + 0.04
      const [cr, cg, cb] =
        a.state === "chase" || a.state === "alert" || a.state === "bash"
          ? [1.0, 0.28, 0.22]
          : a.state === "investigate" || a.state === "search"
            ? [1.0, 0.78, 0.22]
            : [0.32, 0.85, 0.52]

      // Sight cone wedge (kind 8)
      const coneRange = Math.min(9.5, config.sightRange * a.perceptionScale * 0.52)
      const coneAlpha = a.state === "wander" ? 0.18 : a.state === "investigate" || a.state === "search" ? 0.24 : 0.28
      pushSprite(a.x, ay, a.y, coneRange, cr, cg, cb, coneAlpha, 8, a.aim, 1, halfConeRad)

      // Proximity / hearing awareness ring (kind 5)
      pushSprite(
        a.x,
        ay,
        a.y,
        config.proximityRange * a.perceptionScale,
        cr,
        cg,
        cb,
        0.35,
        5,
        0,
        0.045,
        0,
      )

      // Path lines (kind 4)
      if (a.state === "chase" || a.state === "investigate" || a.state === "search") {
        const pts = [{ x: a.x, y: a.y }, ...a.path.slice(0, 5)]
        if (pts.length === 1) pts.push({ x: a.targetX, y: a.targetY })
        for (let pIdx = 0; pIdx < pts.length - 1; pIdx++) {
          const p0 = pts[pIdx]!
          const p1 = pts[pIdx + 1]!
          const dx = p1.x - p0.x
          const dy = p1.y - p0.y
          const segLen = Math.hypot(dx, dy)
          if (segLen < 0.25) continue
          const mx = (p0.x + p1.x) * 0.5
          const my = (p0.y + p1.y) * 0.5
          const segY = support(mx, my) + 0.05
          const ang = Math.atan2(dy, dx)
          pushSprite(mx, segY, my, segLen * 0.5, cr, cg, cb, 0.52, 4, ang, 0.045 / Math.max(0.4, segLen * 0.5), 0)
        }
      }
    }

    // 4. 2D screen-space labels for zombie states and noise sources
    if (!this.overlayCanvas && typeof document !== "undefined") {
      const c = document.createElement("canvas")
      c.id = "ai-debug"
      c.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5"
      document.body.appendChild(c)
      this.overlayCanvas = c
      this.overlayCtx = c.getContext("2d")
    }
    if (this.overlayCanvas && this.overlayCtx) {
      this.overlayCanvas.hidden = false
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      if (this.overlayCanvas.width !== Math.round(screenW * dpr) || this.overlayCanvas.height !== Math.round(screenH * dpr)) {
        this.overlayCanvas.width = Math.round(screenW * dpr)
        this.overlayCanvas.height = Math.round(screenH * dpr)
      }
      const ctx = this.overlayCtx
      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, screenW, screenH)
      ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace"
      ctx.textAlign = "center"

      for (let i = 0; i < agents.length; i++) {
        const a = agents[i]!
        if (a.state === "dead") continue
        const ay = support(a.x, a.y) + 2.05
        const proj = cam.project(a.x, ay, a.y, screenW, screenH)
        if (proj.x < -60 || proj.x > screenW + 60 || proj.y < -30 || proj.y > screenH + 30) continue

        const pct = Math.round(a.awareness * 100)
        const stim = a.targetKind !== "none" ? ` · ${a.targetKind}` : ""
        const text = `#${a.id} ${a.state.toUpperCase()} ${pct}%${stim}`
        const w = ctx.measureText(text).width + 10
        ctx.fillStyle = "rgba(10, 14, 16, 0.82)"
        ctx.fillRect(proj.x - w / 2, proj.y - 11, w, 16)
        ctx.strokeStyle =
          a.state === "chase" || a.state === "alert" || a.state === "bash"
            ? "#ff5a47"
            : a.state === "investigate" || a.state === "search"
              ? "#f5c242"
              : "#63d488"
        ctx.lineWidth = 1
        ctx.strokeRect(proj.x - w / 2, proj.y - 11, w, 16)
        ctx.fillStyle = ctx.strokeStyle
        ctx.fillText(text, proj.x, proj.y + 1)
      }

      for (let i = 0; i < noiseEvents.length; i++) {
        const ev = noiseEvents[i]!
        const ny = support(ev.x, ev.y) + 0.4
        const proj = cam.project(ev.x, ny, ev.y, screenW, screenH)
        if (proj.x < 0 || proj.x > screenW || proj.y < 0 || proj.y > screenH) continue
        const label = `🔊 ${ev.kind} (${ev.radius.toFixed(0)}m)`
        ctx.fillStyle = "rgba(12, 18, 22, 0.84)"
        const tw = ctx.measureText(label).width + 8
        ctx.fillRect(proj.x - tw / 2, proj.y - 9, tw, 14)
        ctx.fillStyle = "#7ce0ff"
        ctx.fillText(label, proj.x, proj.y + 2)
      }

      ctx.restore()
    }

    return alphaCount
  }
}
