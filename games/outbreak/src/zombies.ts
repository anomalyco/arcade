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
import { zombieProfile, type ZombieTuning } from "./zombie-profile"

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

const PART_COUNT = 8
export const MAX_INSTANCES_PER_PART = 2048
const BONE_COUNT = 13
const BONE_STRIDE = BONE_COUNT * 12
const INITIAL_AGENT_CAPACITY = 512

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
}

const BONE_INDEX_TO_PART = [0, 1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]

const BONE_SUBTREE_MASK: Record<BoneId, number> = {
  pelvis: 0x1fff,
  torso: 0b0000001111110,
  head: 1 << 2,
  "left.upperArm": (1 << 3) | (1 << 5),
  "right.upperArm": (1 << 4) | (1 << 6),
  "left.foreArm": 1 << 5,
  "right.foreArm": 1 << 6,
  "left.thigh": (1 << 7) | (1 << 9) | (1 << 11),
  "right.thigh": (1 << 8) | (1 << 10) | (1 << 12),
  "left.shin": (1 << 9) | (1 << 11),
  "right.shin": (1 << 10) | (1 << 12),
  "left.foot": 1 << 11,
  "right.foot": 1 << 12,
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

  const lurch = clamp(baseTuning.zombieLurch * (0.75 + 0.35 * agent.lurch) + 0.16 * stateBoost, 0, 1)
  const asymmetry = clamp(baseTuning.zombieAsymmetry * (0.7 + 0.4 * agent.asymmetry), 0, 1)
  const drag = clamp(baseTuning.zombieDrag * agent.drag * (1 - 0.38 * stateBoost), 0, 1)
  const reach = clamp(baseTuning.zombieReach * (0.65 + 0.35 * agent.reach) + 0.28 * stateBoost + 0.1 * speedNorm, 0, 1)

  const profile = zombieProfile(
    {
      zombieVariant: baseTuning.zombieVariant,
      zombieLurch: lurch,
      zombieAsymmetry: asymmetry,
      zombieDrag: drag,
      zombieReach: reach,
    },
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
  torso.box(-0.148, 0.16, -0.1, -0.11, 0.38, 0.12, wound, MAT.actor)

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
  const foot = box(0.21, -0.075, 0.09, 0.14, boot)

  return [pelvis, torso, head, upperArm, foreArm, thigh, shin, foot]
}

export class ZombieCrowdRenderer {
  private readonly models: number[]
  private readonly partData: Float32Array<ArrayBuffer>[]
  readonly partCounts = new Int32Array(PART_COUNT)
  private readonly poolBatches: Batch[]
  private readonly ghostPartData: Float32Array<ArrayBuffer>[]
  private readonly ghostPartCounts = new Int32Array(PART_COUNT)
  private readonly ghostPoolBatches: Batch[]
  private readonly scratchProfile: HumanProfile = { ...humanProfiles.zombie }
  private readonly scratchTorsoFrame: Frame = { p: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
  readonly debris: DetachedDebrisPiece[] = []
  readonly batches: Batch[] = []
  private overlayCanvas: HTMLCanvasElement | null = null
  private overlayCtx: CanvasRenderingContext2D | null = null

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

  constructor(renderer: Pick<Renderer, "addModel">, maxAgents = INITIAL_AGENT_CAPACITY) {
    if (maxAgents > this.capacity) this.growCapacity(maxAgents)
    this.models = buildZombiePartMeshes().map((m) => renderer.addModel(m))
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

  detachAgentLimb(agent: AIAgent, root: BoneId, dt: number, impulseDir: V3): (ReturnType<typeof detach>[number])[] {
    const s = this.slotById.get(agent.id)
    if (s === undefined) return []
    const bOff = s * BONE_STRIDE
    const bones = readBonePose(this.currBones, bOff)
    const prev = readBonePose(this.prevBones, bOff)
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
      let mask = 0
      for (let i = 0; i < agent.detachedLimbs.length; i++) {
        mask |= BONE_SUBTREE_MASK[agent.detachedLimbs[i] as BoneId] ?? 0
      }
      this.hiddenMask[s] = mask
    }
    return s
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
    const offset = count * INST_FLOATS
    const data = this.partData[partIndex]!
    data[offset] = b[fOff]!
    data[offset + 1] = b[fOff + 1]!
    data[offset + 2] = b[fOff + 2]!
    data[offset + 3] = yaw
    data[offset + 4] = tintR
    data[offset + 5] = tintG
    data[offset + 6] = tintB
    data[offset + 7] = 1
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
    const offset = count * INST_FLOATS
    const data = this.partData[partIndex]!
    data[offset] = b[fOff]!
    data[offset + 1] = b[fOff + 1]!
    data[offset + 2] = b[fOff + 2]!
    data[offset + 3] = yaw
    data[offset + 4] = tintR
    data[offset + 5] = tintG
    data[offset + 6] = tintB
    data[offset + 7] = 1
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
    const offset = count * INST_FLOATS
    const data = this.ghostPartData[partIndex]!
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

  draw(
    agents: readonly AIAgent[],
    dt: number,
    support: (x: number, z: number) => number,
    vision: Vision,
    viewRect: readonly [number, number, number, number],
    zombieTune: ZombieTuning & { fogGhostDuration?: number },
    debugOverlay: boolean,
    time = 0,
  ): Batch[] {
    dt = Math.max(0.0001, Math.min(0.1, dt))
    this.partCounts.fill(0)
    this.ghostPartCounts.fill(0)
    const [vx0, vy0, vx1, vy1] = viewRect
    const ghostDuration = zombieTune.fogGhostDuration ?? 3.2

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
        const offset = count * INST_FLOATS
        const data = this.partData[d.partIndex]!
        data[offset] = d.p[0]
        data[offset + 1] = d.p[1]
        data[offset + 2] = d.p[2]
        data[offset + 3] = d.yaw
        data[offset + 4] = 0.85
        data[offset + 5] = 0.75
        data[offset + 6] = 0.75
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

    for (let idx = 0; idx < agents.length; idx++) {
      const a = agents[idx]!
      if (a.x < vx0 - 3 || a.x > vx1 + 3 || a.y < vy0 - 3 || a.y > vy1 + 3) continue

      const visWeight = typeof vision.actorVisible === "function" ? vision.actorVisible(a.x, a.y) : vision.visible(a.x, a.y) ? 1 : 0
      const isVisible = visWeight > 0.02
      if (!isVisible && !debugOverlay) {
        const s = this.slotById.get(a.id)
        if (s !== undefined && ghostDuration > 0.05 && a.state !== "dead") {
          const age = time - this.seenAt[s]!
          if (age >= 0 && age < ghostDuration) {
            const sx = this.seenX[s]!
            const sy = this.seenY[s]!
            if (Math.hypot(a.x - sx, a.y - sy) > 0.85 && vision.visible(sx, sy)) {
              this.seenAt[s] = -1e9
            } else {
              const gAlpha = Math.pow(1 - age / ghostDuration, 1.55) * 0.56
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
      let hidden = this.hiddenMask[s]!
      if (a.detachedLimbs.length > 0) {
        for (let i = 0; i < a.detachedLimbs.length; i++) {
          hidden |= BONE_SUBTREE_MASK[a.detachedLimbs[i] as BoneId] ?? 0
        }
        this.hiddenMask[s] = hidden
      }

      const shade = 0.88 + ((a.id * 19) % 7) * 0.035
      const tintR = !isVisible && debugOverlay ? 0.55 : shade
      const tintG = !isVisible && debugOverlay ? 0.72 : shade * 0.98
      const tintB = !isVisible && debugOverlay ? 0.85 : shade * 0.94
      const alpha = !isVisible && debugOverlay ? 0.58 : Math.min(1.0, 0.25 + 0.75 * visWeight)
      const bOff = s * BONE_STRIDE
      const pelvisOff = bOff
      const torsoOff = bOff + 12
      const headOff = bOff + 24

      if (a.state === "dead") {
        this.seenAt[s] = -1e9
        const col = Math.min(1, this.collapse[s]! + dt * 4.2)
        this.collapse[s] = col
        const c = smoother(col)
        const groundY = support(a.x, a.y)
        const pelvisY = groundY + (HIP * (1 - c) + 0.14 * c)
        const syaw = this.yaw[s]!

        writeYawFrame(bBuf, pelvisOff, a.x, pelvisY, a.y, syaw)
        pitchInPlace(bBuf, pelvisOff, -1.42 * c)
        rollInPlace(bBuf, pelvisOff, this.collapseDir[s]! * c)

        const tx = bBuf[pelvisOff]! + bBuf[pelvisOff + 6]! * RIG.waist
        const ty = bBuf[pelvisOff + 1]! + bBuf[pelvisOff + 7]! * RIG.waist
        const tz = bBuf[pelvisOff + 2]! + bBuf[pelvisOff + 8]! * RIG.waist
        writeYawFrame(bBuf, torsoOff, tx, ty, tz, syaw)
        pitchInPlace(bBuf, torsoOff, -1.48 * c)

        const hx = bBuf[torsoOff]! + bBuf[torsoOff + 3]! * 0.02 + bBuf[torsoOff + 6]! * RIG.neckY
        const hy = bBuf[torsoOff + 1]! + bBuf[torsoOff + 4]! * 0.02 + bBuf[torsoOff + 7]! * RIG.neckY
        const hz = bBuf[torsoOff + 2]! + bBuf[torsoOff + 5]! * 0.02 + bBuf[torsoOff + 8]! * RIG.neckY
        writeYawFrame(bBuf, headOff, hx, hy, hz, syaw)
        pitchInPlace(bBuf, headOff, -1.35 * c)

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

        for (let i = 0; i < 2; i++) {
          const side = i ? 1 : -1
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
            a.x - cosY * 0.65,
            groundY + 0.09,
            a.y - sinY * 0.65 + side * 0.16,
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
          writeLimbFrame(bBuf, bOff + thighIdx * 12, hipX, hipY, hipZWorld, kx, ky, kz, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)
          writeLimbFrame(bBuf, bOff + shinIdx * 12, kx, ky, kz, ex, ey, ez, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)
          writeYawFrame(bBuf, bOff + footIdx * 12, ex, ey, ez, syaw)
          pitchInPlace(bBuf, bOff + footIdx * 12, -1.2 * c)
          this.emitBone(bOff, thighIdx, 5, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, shinIdx, 6, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
          this.emitBone(bOff, footIdx, 7, hidden, tintR, tintG, tintB, a.hitFlash, alpha)

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
            a.x + cosY * 0.45,
            groundY + 0.08,
            a.y + sinY * 0.45 + side * 0.25,
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
        continue
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
        }
      }

      const footSupport =
        (support(this.footPx[f0]!, this.footPz[f0]!) + support(this.footPx[f1]!, this.footPz[f1]!)) * 0.5 + clamberLift
      const supportY = (support(a.x, a.y) + clamberLift) * 0.65 + footSupport * 0.35
      const shambleGait = smooth((speed - 0.12) / 0.35)
      const shambleMod = shambleTorsoModulation(curPhase, shambleGait, profile, actorSeed)
      const baseHeight =
        supportY +
        HIP -
        0.012 * moving +
        shambleMod.pelvisBobAdd -
        0.016 * shambleGait * Math.sin(curPhase * Math.PI * 4 - 0.35)
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

      const height = baseHeight - rdx
      writeYawFrame(bBuf, pelvisOff, a.x, height, a.y, syaw + twx)
      rollInPlace(bBuf, pelvisOff, shambleMod.pelvisRollAdd)
      pitchInPlace(bBuf, pelvisOff, -0.06 * moving - 0.35 * shambleMod.torsoPitchAdd)
      const lean = lxx * Math.cos(a.aim) + lyx * Math.sin(a.aim)

      // Inline angleSpring for chest and head
      const chestGoal = a.aim - twx * 0.55 + shambleMod.torsoYawAdd
      const headGoal = a.aim + shambleMod.headYawAdd
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
      const staggerRecoil =
        a.state === "stagger" ? -0.36 * clamp(a.timer / 0.3, 0, 1) : -0.18 * a.hitFlash
      const staggerCant =
        a.state === "stagger" ? (a.id % 2 ? 1 : -1) * 0.22 * clamp(a.timer / 0.3, 0, 1) : 0

      const torsoPx = bBuf[pelvisOff]! + bBuf[pelvisOff + 6]! * RIG.waist
      const torsoPy = bBuf[pelvisOff + 1]! + bBuf[pelvisOff + 7]! * RIG.waist
      const torsoPz = bBuf[pelvisOff + 2]! + bBuf[pelvisOff + 8]! * RIG.waist
      writeYawFrame(bBuf, torsoOff, torsoPx, torsoPy, torsoPz, cx)
      pitchInPlace(bBuf, torsoOff, -0.04 - lean - shambleMod.torsoPitchAdd - bashPulse - staggerRecoil)
      pitchInPlace(bBuf, torsoOff, -clamp(torsoLean, -0.15, 0.35))
      rollInPlace(bBuf, torsoOff, clamp(torsoRoll, -0.2, 0.2))
      rollInPlace(bBuf, torsoOff, shambleMod.torsoRollAdd + staggerCant)

      const headPx = torsoPx + bBuf[torsoOff + 3]! * 0.02 + bBuf[torsoOff + 6]! * RIG.neckY
      const headPy = torsoPy + bBuf[torsoOff + 4]! * 0.02 + bBuf[torsoOff + 7]! * RIG.neckY
      const headPz = torsoPz + bBuf[torsoOff + 5]! * 0.02 + bBuf[torsoOff + 8]! * RIG.neckY
      writeYawFrame(bBuf, headOff, headPx, headPy, headPz, hxAng)
      pitchInPlace(bBuf, headOff, -0.12 * torsoLean - shambleMod.headPitchAdd - staggerRecoil * 0.6)
      rollInPlace(bBuf, headOff, headTilt + shambleMod.headRollAdd + staggerCant * 0.5)

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
      const [hL, hR] = shambleHandsFK(tf, curPhase, shambleGait, runBlend, profile, actorSeed)

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
        const hipX = a.x + pzAxisX * hipZ
        const hipY = height + pzAxisY * hipZ
        const hipZWorld = a.y + pzAxisZ * hipZ
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
        writeLimbFrame(bBuf, bOff + thighIdx * 12, hipX, hipY, hipZWorld, kx, ky, kz, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)
        writeLimbFrame(bBuf, bOff + shinIdx * 12, kx, ky, kz, ex, ey, ez, poleX, poleY, poleZ, pxAxisX, pxAxisY, pxAxisZ)

        const footPhase = (curPhase + i * (0.5 + timingBias * 0.22)) % 1
        const planted = this.footPlanted[fi] !== 0
        const stanceFrac = planted ? clamp(footPhase / Math.max(0.1, duty), 0, 1) : 0
        const prevU = this.footPrevU[fi]!
        const stancePitch = isDrag
          ? -0.22 * smooth((stanceFrac - 0.58) / 0.42) * dragAmt * shambleGait
          : -0.20 * smooth((stanceFrac - 0.62) / 0.38) * shambleGait
        const swingPitch = isDrag
          ? -0.24 * Math.sin(Math.PI * (1 - prevU * 0.65)) * dragAmt
          : (-0.18 * Math.sin(Math.PI * clamp(prevU / 0.55, 0, 1)) +
              0.14 * Math.sin(Math.PI * clamp((prevU - 0.5) / 0.5, 0, 1))) *
            shambleGait
        const fyaw = this.footYaw[fi]!
        const footOff = bOff + footIdx * 12
        if (planted) {
          const fc = Math.cos(fyaw)
          const fs = Math.sin(fyaw)
          writeYawFrame(bBuf, footOff, 0, 0, 0, fyaw)
          pitchInPlace(bBuf, footOff, stancePitch)
          const offX = bBuf[footOff + 3]! * 0.19 - bBuf[footOff + 6]! * RIG.ankle
          const offY = bBuf[footOff + 4]! * 0.19 - bBuf[footOff + 7]! * RIG.ankle
          const offZ = bBuf[footOff + 5]! * 0.19 - bBuf[footOff + 8]! * RIG.ankle
          bBuf[footOff] = this.footPx[fi]! + fc * 0.19 - offX
          bBuf[footOff + 1] = this.footPy[fi]! - offY
          bBuf[footOff + 2] = this.footPz[fi]! + fs * 0.19 - offZ
        } else {
          writeYawFrame(bBuf, footOff, ex, ey, ez, fyaw)
          pitchInPlace(bBuf, footOff, swingPitch)
        }

        this.emitBone(bOff, thighIdx, 5, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, shinIdx, 6, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, footIdx, 7, hidden, tintR, tintG, tintB, a.hitFlash, alpha)

        const uaIdx = 3 + i
        const faIdx = 5 + i
        this.emitBone(bOff, uaIdx, 3, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, faIdx, 4, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
      }

      if (isVisible) {
        this.seenAt[s] = time
        this.seenX[s] = a.x
        this.seenY[s] = a.y
        for (let f = 0; f < BONE_STRIDE; f++) {
          this.seenBones[bOff + f] = bBuf[bOff + f]!
        }
      }
    }

    this.batches.length = 0
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
