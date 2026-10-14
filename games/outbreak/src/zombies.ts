import type { Camera } from "@arcade/kit/client/camera"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, SPRITE_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import {
  boneIds,
  detach,
  type BoneId,
  type BonePose,
} from "@arcade/kit/human-pose"
import { type HumanProfile } from "@arcade/kit/human-profile"
import {
  clamp,
  HIP,
  RIG,
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
const MAX_INSTANCES_PER_PART = 2048
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
export function agentZombieProfile(agent: AIAgent, baseTuning: ZombieTuning): HumanProfile {
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

  const profile = zombieProfile({
    zombieLurch: lurch,
    zombieAsymmetry: asymmetry,
    zombieDrag: drag,
    zombieReach: reach,
  })
  if (stateBoost > 0.5) {
    profile.chestHz = Math.min(8, profile.chestHz + 2.2)
    profile.headHz = Math.min(9, profile.headHz + 2.8)
  }
  return profile
}

export class ZombieCrowdRenderer {
  private readonly models: number[]
  private readonly partData: Float32Array<ArrayBuffer>[]
  private readonly partCounts = new Int32Array(PART_COUNT)
  private readonly poolBatches: Batch[]
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
  private chestX = new Float32Array(INITIAL_AGENT_CAPACITY)
  private chestV = new Float32Array(INITIAL_AGENT_CAPACITY)
  private headX = new Float32Array(INITIAL_AGENT_CAPACITY)
  private headV = new Float32Array(INITIAL_AGENT_CAPACITY)
  private collapse = new Float32Array(INITIAL_AGENT_CAPACITY)
  private collapseDir = new Float32Array(INITIAL_AGENT_CAPACITY)
  private hiddenMask = new Uint16Array(INITIAL_AGENT_CAPACITY)
  private currBones = new Float32Array(INITIAL_AGENT_CAPACITY * BONE_STRIDE)
  private prevBones = new Float32Array(INITIAL_AGENT_CAPACITY * BONE_STRIDE)

  constructor(renderer: Pick<Renderer, "addModel">) {
    const box = (w: number, y0: number, h: number, d: number, col: Rgb) => {
      const m = new Mesh()
      m.box(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, col, MAT.actor)
      return m
    }
    const skin = hex(0x6c7d60)
    const forearmSkin = hex(0x4e5d45)
    const jacket = hex(0x454137)
    const trousers = hex(0x2b3136)
    const wound = hex(0x581416)
    const hair = hex(0x212623)
    const boot = hex(0x26201c)

    const pelvis = box(0.25, -0.07, 0.18, 0.34, trousers)
    const torso = box(0.28, -0.02, 0.48, 0.4, jacket)
    torso.box(0.11, 0.12, -0.12, 0.145, 0.36, 0.08, wound, MAT.actor)
    torso.box(-0.145, 0.16, -0.1, -0.11, 0.38, 0.12, wound, MAT.actor)

    const head = box(0.18, 0.01, 0.24, 0.18, skin)
    head.box(-0.1, 0.19, -0.11, 0.1, 0.28, 0.11, hair, MAT.actor)
    for (const z of [-0.042, 0.042]) {
      head.box(0.086, 0.13, z - 0.016, 0.095, 0.155, z + 0.016, hex(0x98d838), MAT.glow, 0.55)
    }

    const upperArm = box(0.15, -0.29, 0.33, 0.15, jacket)
    const foreArm = box(0.11, -0.28, 0.3, 0.11, forearmSkin)
    foreArm.box(-0.04, -0.31, -0.045, 0.055, -0.26, 0.045, wound, MAT.actor)

    const thigh = box(0.17, -0.42, 0.46, 0.17, trousers)
    const shin = box(0.13, -0.41, 0.43, 0.14, trousers)
    const foot = box(0.21, -0.075, 0.09, 0.14, boot)

    this.models = [pelvis, torso, head, upperArm, foreArm, thigh, shin, foot].map((m) => renderer.addModel(m))
    this.partData = Array.from({ length: PART_COUNT }, () => new Float32Array(MAX_INSTANCES_PER_PART * INST_FLOATS))
    this.poolBatches = Array.from({ length: PART_COUNT }, (_, i) => ({
      model: this.models[i]!,
      data: this.partData[i]!,
      count: 0,
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
    this.capacity = nextCap
  }

  reset(): void {
    this.slotById.clear()
    this.nextSlot = 0
    this.debris.length = 0
  }

  private maskToHiddenSet(mask: number): Set<BoneId> {
    const out = new Set<BoneId>()
    for (let i = 0; i < BONE_COUNT; i++) {
      if ((mask & (1 << i)) !== 0) out.add(boneIds[i]!)
    }
    return out
  }

  getAgentBones(agentId: number): { bones: BonePose; prevBones: BonePose; hiddenBones: Set<BoneId> } | undefined {
    const s = this.slotById.get(agentId)
    if (s === undefined) return undefined
    const bOff = s * BONE_STRIDE
    return {
      bones: readBonePose(this.currBones, bOff),
      prevBones: readBonePose(this.prevBones, bOff),
      hiddenBones: this.maskToHiddenSet(this.hiddenMask[s]!),
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
      this.footPlanted[f0] = 1
      this.footYaw[f0] = agent.aim

      this.footPx[f1] = agent.x
      this.footPy[f1] = y0
      this.footPz[f1] = agent.y + 0.13
      this.footLiftX[f1] = agent.x
      this.footLiftY[f1] = y0
      this.footLiftZ[f1] = agent.y + 0.13
      this.footPlanted[f1] = 1
      this.footYaw[f1] = agent.aim

      this.phase[s] = (agent.id * 0.27) % 1
      this.yaw[s] = agent.aim
      this.lastX[s] = agent.x
      this.lastY[s] = agent.y
      this.svx[s] = 0
      this.svy[s] = 0
      this.leanXx[s] = 0
      this.leanXv[s] = 0
      this.leanYx[s] = 0
      this.leanYv[s] = 0
      this.chestX[s] = agent.aim
      this.chestV[s] = 0
      this.headX[s] = agent.aim
      this.headV[s] = 0
      this.collapse[s] = 0
      this.collapseDir[s] = (agent.id % 2 === 0 ? 1 : -1) * 0.35
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

  draw(
    agents: readonly AIAgent[],
    dt: number,
    support: (x: number, z: number) => number,
    vision: Vision,
    viewRect: readonly [number, number, number, number],
    zombieTune: ZombieTuning,
    debugOverlay: boolean,
  ): Batch[] {
    dt = Math.max(0.0001, Math.min(0.1, dt))
    this.partCounts.fill(0)
    const [vx0, vy0, vx1, vy1] = viewRect

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

      const isVisible = vision.visible(a.x, a.y)
      if (!isVisible && !debugOverlay) continue

      const s = this.ensureSlot(a, support)
      let hidden = this.hiddenMask[s]!
      if (a.detachedLimbs.length > 0) {
        for (let i = 0; i < a.detachedLimbs.length; i++) {
          hidden |= BONE_SUBTREE_MASK[a.detachedLimbs[i] as BoneId] ?? 0
        }
        this.hiddenMask[s] = hidden
      }

      const shade = 0.86 + ((a.id * 19) % 7) * 0.035
      const tintR = !isVisible && debugOverlay ? 0.55 : shade
      const tintG = !isVisible && debugOverlay ? 0.72 : shade * 0.98
      const tintB = !isVisible && debugOverlay ? 0.85 : shade * 0.94
      const alpha = !isVisible && debugOverlay ? 0.58 : 1.0
      const bOff = s * BONE_STRIDE
      const pelvisOff = bOff
      const torsoOff = bOff + 12
      const headOff = bOff + 24

      if (a.state === "dead") {
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
      }

      // Compute scalar zombie profile values without allocating a HumanProfile object
      const stateBoost =
        a.state === "chase" || a.state === "alert" || a.state === "bash"
          ? 1.0
          : a.state === "investigate" || a.state === "search"
            ? 0.45
            : 0.0
      const rawSpeed = Math.hypot(a.vx, a.vy)
      const speedNorm = clamp(rawSpeed / 3.0, 0, 1)
      const lurch = clamp(zombieTune.zombieLurch * (0.75 + 0.35 * a.lurch) + 0.16 * stateBoost, 0, 1)
      const asymmetry = clamp(zombieTune.zombieAsymmetry * (0.7 + 0.4 * a.asymmetry), 0, 1)
      const drag = clamp(zombieTune.zombieDrag * a.drag * (1 - 0.38 * stateBoost), 0, 1)
      const reach = clamp(zombieTune.zombieReach * (0.65 + 0.35 * a.reach) + 0.28 * stateBoost + 0.1 * speedNorm, 0, 1)
      const strideScale = 0.94 - 0.24 * lurch
      const torsoLean = 0.05 + 0.24 * lurch
      const chestHz = stateBoost > 0.5 ? Math.min(8, 5 - 3 * lurch + 2.2) : 5 - 3 * lurch
      const headHz = stateBoost > 0.5 ? Math.min(9, 7 - 5.8 * lurch + 2.8) : 7 - 5.8 * lurch
      const timingBias = 0.28 * asymmetry
      const torsoRoll = 0.12 * asymmetry
      const headTilt = 0.2 * asymmetry
      const armAsymmetry = 0.13 * asymmetry
      const footDrag = 0.95 * drag
      const armReach = 0.2 + 0.32 * reach

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
        this.footPlanted[f0] = 1
        this.footYaw[f0] = syaw

        this.footPx[f1] = rest1X
        this.footPy[f1] = y1
        this.footPz[f1] = rest1Z
        this.footLiftX[f1] = rest1X
        this.footLiftY[f1] = y1
        this.footLiftZ[f1] = rest1Z
        this.footPlanted[f1] = 1
        this.footYaw[f1] = syaw
      }

      const needsStep =
        !this.footPlanted[f0] ||
        !this.footPlanted[f1] ||
        Math.hypot(this.footPx[f0]! - rest0X, this.footPz[f0]! - rest0Z) > 0.2 ||
        Math.hypot(this.footPx[f1]! - rest1X, this.footPz[f1]! - rest1Z) > 0.2
      const rate = Math.max(speed / ((0.7 + 0.22 * speed) * strideScale), needsStep ? 1.5 : 0)
      const curPhase = (this.phase[s]! + rate * dt) % 1
      this.phase[s] = curPhase
      const duty = 0.64 - 0.2 * moving

      for (let i = 0; i < 2; i++) {
        const fi = f0 + i
        const fo = f0 + (1 - i)
        const fPhase = (curPhase + i * (0.5 + timingBias * 0.25)) % 1
        if (rate > 0 && fPhase >= duty) {
          if (this.footPlanted[fi]) {
            this.footPlanted[fi] = 0
            this.footLiftX[fi] = this.footPx[fi]!
            this.footLiftY[fi] = this.footPy[fi]!
            this.footLiftZ[fi] = this.footPz[fi]!
          }
          const u = (fPhase - duty) / (1 - duty)
          const e = smoother(u)
          const lead = (1 - fPhase) / rate + (duty / rate) * 0.5
          let tx = (i ? rest1X : rest0X) + vx * lead
          let tz = (i ? rest1Z : rest0Z) + vy * lead
          const side = i ? 1 : -1
          const lat = (-(tx - this.footPx[fo]!) * sinY + (tz - this.footPz[fo]!) * cosY) * side
          if (lat < 0.16) {
            tx -= sinY * side * (0.16 - lat)
            tz += cosY * side * (0.16 - lat)
          }
          const ty = support(tx, tz) + clamberLift
          const clearance = i === 1 ? 1 - footDrag : 1
          const lx = this.footLiftX[fi]!
          const ly = this.footLiftY[fi]!
          const lz = this.footLiftZ[fi]!
          this.footPx[fi] = lx + (tx - lx) * e
          this.footPy[fi] = ly + (ty - ly) * e + Math.sin(Math.PI * u) * (0.05 + 0.08 * moving) * clearance
          this.footPz[fi] = lz + (tz - lz) * e
          this.footYaw[fi] = this.footYaw[fi]! + angleDiff(syaw, this.footYaw[fi]!) * e
        } else if (!this.footPlanted[fi]) {
          this.footPlanted[fi] = 1
          this.footPy[fi] = support(this.footPx[fi]!, this.footPz[fi]!) + clamberLift
        }
      }

      let height = support(a.x, a.y) + clamberLift + HIP - 0.05 * moving - 0.035 * moving * Math.cos(curPhase * Math.PI * 4)
      const d0 = Math.hypot(this.footPx[f0]! - a.x, this.footPz[f0]! - a.y)
      height = Math.min(height, Math.sqrt(Math.max(0, 0.815 * 0.815 - d0 * d0)) + RIG.ankle + this.footPy[f0]!)
      const d1 = Math.hypot(this.footPx[f1]! - a.x, this.footPz[f1]! - a.y)
      height = Math.min(height, Math.sqrt(Math.max(0, 0.815 * 0.815 - d1 * d1)) + RIG.ankle + this.footPy[f1]!)

      writeYawFrame(bBuf, pelvisOff, a.x, height, a.y, syaw)
      const lean = lxx * Math.cos(a.aim) + lyx * Math.sin(a.aim)

      // Inline angleSpring for chest and head
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
        cv += (angleDiff(a.aim, cx) * kChest - cv * cChest) * springH
        cx += cv * springH
        hv += (angleDiff(a.aim, hxAng) * kHead - hv * cHead) * springH
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
      pitchInPlace(bBuf, torsoOff, -0.05 - lean - bashPulse - staggerRecoil)
      pitchInPlace(bBuf, torsoOff, -clamp(torsoLean, -0.15, 0.35))
      rollInPlace(bBuf, torsoOff, clamp(torsoRoll, -0.2, 0.2))
      rollInPlace(bBuf, torsoOff, staggerCant)

      const headPx = torsoPx + bBuf[torsoOff + 3]! * 0.02 + bBuf[torsoOff + 6]! * RIG.neckY
      const headPy = torsoPy + bBuf[torsoOff + 4]! * 0.02 + bBuf[torsoOff + 7]! * RIG.neckY
      const headPz = torsoPz + bBuf[torsoOff + 5]! * 0.02 + bBuf[torsoOff + 8]! * RIG.neckY
      writeYawFrame(bBuf, headOff, headPx, headPy, headPz, hxAng)
      pitchInPlace(bBuf, headOff, -staggerRecoil * 0.6)
      rollInPlace(bBuf, headOff, headTilt + staggerCant * 0.5)

      this.emitUprightBone(bOff, 0, 0, hidden, syaw, tintR, tintG, tintB, a.hitFlash, alpha)
      this.emitBone(bOff, 1, 1, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
      this.emitBone(bOff, 2, 2, hidden, tintR, tintG, tintB, a.hitFlash, alpha)

      // Solve arms (profileHands("reach") + poseArms) in-place
      const txAxisX = bBuf[torsoOff + 3]!
      const txAxisY = bBuf[torsoOff + 4]!
      const txAxisZ = bBuf[torsoOff + 5]!
      const tyAxisX = bBuf[torsoOff + 6]!
      const tyAxisY = bBuf[torsoOff + 7]!
      const tyAxisZ = bBuf[torsoOff + 8]!
      const tzAxisX = bBuf[torsoOff + 9]!
      const tzAxisY = bBuf[torsoOff + 10]!
      const tzAxisZ = bBuf[torsoOff + 11]!

      const asym = clamp(armAsymmetry, -0.18, 0.18)
      const rch = clamp(armReach, 0.2, 0.52)
      const lxLocal = clamp(rch + asym * 0.45, 0.2, 0.54)
      const lyLocal = 0.35 + asym
      const lzLocal = -0.15
      const rxLocal = clamp(rch - asym * 0.55, 0.18, 0.52)
      const ryLocal = 0.27 - asym * 0.85
      const rzLocal = 0.2

      const handLX = torsoPx + txAxisX * lxLocal + tyAxisX * lyLocal + tzAxisX * lzLocal
      const handLY = torsoPy + txAxisY * lxLocal + tyAxisY * lyLocal + tzAxisY * lzLocal
      const handLZ = torsoPz + txAxisZ * lxLocal + tyAxisZ * lyLocal + tzAxisZ * lzLocal
      const handRX = torsoPx + txAxisX * rxLocal + tyAxisX * ryLocal + tzAxisX * rzLocal
      const handRY = torsoPy + txAxisY * rxLocal + tyAxisY * ryLocal + tzAxisY * rzLocal
      const handRZ = torsoPz + txAxisZ * rxLocal + tyAxisZ * ryLocal + tzAxisZ * rzLocal

      const shLX = torsoPx + tyAxisX * RIG.shoulderY - tzAxisX * RIG.shoulderW
      const shLY = torsoPy + tyAxisY * RIG.shoulderY - tzAxisY * RIG.shoulderW
      const shLZ = torsoPz + tyAxisZ * RIG.shoulderY - tzAxisZ * RIG.shoulderW
      const shRX = torsoPx + tyAxisX * RIG.shoulderY + tzAxisX * RIG.shoulderW
      const shRY = torsoPy + tyAxisY * RIG.shoulderY + tzAxisY * RIG.shoulderW
      const shRZ = torsoPz + tyAxisZ * RIG.shoulderY + tzAxisZ * RIG.shoulderW

      const poleLX = txAxisX * -0.15 - tyAxisX - tzAxisX * 1.1
      const poleLY = txAxisY * -0.15 - tyAxisY - tzAxisY * 1.1
      const poleLZ = txAxisZ * -0.15 - tyAxisZ - tzAxisZ * 1.1
      solveIkToScratch(shLX, shLY, shLZ, handLX, handLY, handLZ, RIG.upper, RIG.fore, poleLX, poleLY, poleLZ)
      writeLimbFrame(bBuf, bOff + 3 * 12, shLX, shLY, shLZ, ikScratch[0]!, ikScratch[1]!, ikScratch[2]!, txAxisX, txAxisY, txAxisZ, tyAxisX, tyAxisY, tyAxisZ)
      writeLimbFrame(bBuf, bOff + 5 * 12, ikScratch[0]!, ikScratch[1]!, ikScratch[2]!, ikScratch[3]!, ikScratch[4]!, ikScratch[5]!, 0, 1, 0, txAxisX, txAxisY, txAxisZ)

      const poleRX = txAxisX * -0.5 - tyAxisX + tzAxisX * 0.8
      const poleRY = txAxisY * -0.5 - tyAxisY + tzAxisY * 0.8
      const poleRZ = txAxisZ * -0.5 - tyAxisZ + tzAxisZ * 0.8
      solveIkToScratch(shRX, shRY, shRZ, handRX, handRY, handRZ, RIG.upper, RIG.fore, poleRX, poleRY, poleRZ)
      writeLimbFrame(bBuf, bOff + 4 * 12, shRX, shRY, shRZ, ikScratch[0]!, ikScratch[1]!, ikScratch[2]!, txAxisX, txAxisY, txAxisZ, tyAxisX, tyAxisY, tyAxisZ)
      writeLimbFrame(bBuf, bOff + 6 * 12, ikScratch[0]!, ikScratch[1]!, ikScratch[2]!, ikScratch[3]!, ikScratch[4]!, ikScratch[5]!, 0, 1, 0, txAxisX, txAxisY, txAxisZ)

      // Solve legs in-place
      const pxAxisX = bBuf[pelvisOff + 3]!
      const pxAxisY = bBuf[pelvisOff + 4]!
      const pxAxisZ = bBuf[pelvisOff + 5]!
      const pzAxisX = bBuf[pelvisOff + 9]!
      const pzAxisY = bBuf[pelvisOff + 10]!
      const pzAxisZ = bBuf[pelvisOff + 11]!

      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1
        const fi = f0 + i
        const hipZ = side * RIG.hipW
        const hipX = a.x + pzAxisX * hipZ
        const hipY = height + pzAxisY * hipZ
        const hipZWorld = a.y + pzAxisZ * hipZ
        const ankX = this.footPx[fi]!
        const ankY = this.footPy[fi]! + RIG.ankle
        const ankZ = this.footPz[fi]!
        const poleX = pxAxisX + pzAxisX * (side * 0.3)
        const poleY = pxAxisY + pzAxisY * (side * 0.3)
        const poleZ = pxAxisZ + pzAxisZ * (side * 0.3)
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
        writeYawFrame(bBuf, bOff + footIdx * 12, ex, ey, ez, this.footYaw[fi]!)

        this.emitBone(bOff, thighIdx, 5, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, shinIdx, 6, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitUprightBone(bOff, footIdx, 7, hidden, this.footYaw[fi]!, tintR, tintG, tintB, a.hitFlash, alpha)

        const uaIdx = 3 + i
        const faIdx = 5 + i
        this.emitBone(bOff, uaIdx, 3, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
        this.emitBone(bOff, faIdx, 4, hidden, tintR, tintG, tintB, a.hitFlash, alpha)
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

    // Even when full debug overlay is off, show subtle alert "!" marker on newly alerted zombies
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!
      if (a.state === "alert") {
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
