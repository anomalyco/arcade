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
  pitch,
  RIG,
  roll,
  smooth,
  smoother,
  yawFrame,
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
const POSE_FLOATS_PER_BONE = 6
const POSE_STRIDE = BONE_COUNT * POSE_FLOATS_PER_BONE

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

function reconstructBonePose(pose: Float32Array, baseOff: number): BonePose {
  const out: BonePose = {}
  for (let i = 0; i < BONE_COUNT; i++) {
    const o = baseOff + i * POSE_FLOATS_PER_BONE
    const px = pose[o]!
    const py = pose[o + 1]!
    const pz = pose[o + 2]!
    const yw = pose[o + 3]!
    const pt = pose[o + 4]!
    const rl = pose[o + 5]!
    out[boneIds[i]!] = roll(pitch(yawFrame([px, py, pz], yw), pt), rl)
  }
  return out
}

/** Builds the 8 instanced zombie body-part meshes (pelvis, torso, head, upperArm, foreArm, thigh, shin, foot). */
export function buildZombiePartMeshes(): Mesh[] {
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

  return [pelvis, torso, head, upperArm, foreArm, thigh, shin, foot]
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

/**
 * Data-Oriented (SoA) Crowd Animation + Instance Packing Renderer (`explore-own-it` `SoAZombieCrowdRenderer`):
 * 1. Raises `MAX_INSTANCES_PER_PART` from `256` (which silently dropped all limbs above 128 zombies) to `2048`.
 * 2. Stores all per-agent animation state in flat contiguous `Float32Array` SoA columns (`cap = 1024`).
 * 3. Solves 2-bone analytical limb transforms directly in registers and writes the 12-float instance data
 *    in-place into `partData[partIndex]`, with distance-based kinematic LOD beyond `26 m`.
 */
export class ZombieCrowdRenderer {
  private readonly models: number[]
  private readonly partData: Float32Array<ArrayBuffer>[]
  readonly partCounts = new Int32Array(PART_COUNT)
  private readonly poolBatches: Batch[]
  readonly debris: DetachedDebrisPiece[] = []
  readonly batches: Batch[] = []
  private overlayCanvas: HTMLCanvasElement | null = null
  private overlayCtx: CanvasRenderingContext2D | null = null

  // Flat SoA columns (capacity = 1024 agents)
  private readonly cap: number
  private readonly initialized: Uint8Array
  private readonly phase: Float32Array
  private readonly yaw: Float32Array
  private readonly lastX: Float32Array
  private readonly lastY: Float32Array
  private readonly svx: Float32Array
  private readonly svy: Float32Array
  private readonly leanX: Float32Array
  private readonly leanVX: Float32Array
  private readonly leanY: Float32Array
  private readonly leanVY: Float32Array
  private readonly chestX: Float32Array
  private readonly chestV: Float32Array
  private readonly headX: Float32Array
  private readonly headV: Float32Array
  private readonly collapse: Float32Array
  private readonly collapseDir: Float32Array
  private readonly hiddenMask: Uint16Array
  // Feet (2 per agent -> length = cap * 2)
  private readonly footX: Float32Array
  private readonly footY: Float32Array
  private readonly footZ: Float32Array
  private readonly liftX: Float32Array
  private readonly liftY: Float32Array
  private readonly liftZ: Float32Array
  private readonly footYaw: Float32Array
  private readonly planted: Uint8Array
  // Compact 6-float bone poses [px, py, pz, yaw, pitch, roll] for on-demand getAgentBones / detachAgentLimb
  private currPose: Float32Array
  private prevPose: Float32Array

  constructor(renderer: Pick<Renderer, "addModel">, maxAgents = 1024) {
    this.cap = maxAgents
    this.initialized = new Uint8Array(maxAgents)
    this.phase = new Float32Array(maxAgents)
    this.yaw = new Float32Array(maxAgents)
    this.lastX = new Float32Array(maxAgents)
    this.lastY = new Float32Array(maxAgents)
    this.svx = new Float32Array(maxAgents)
    this.svy = new Float32Array(maxAgents)
    this.leanX = new Float32Array(maxAgents)
    this.leanVX = new Float32Array(maxAgents)
    this.leanY = new Float32Array(maxAgents)
    this.leanVY = new Float32Array(maxAgents)
    this.chestX = new Float32Array(maxAgents)
    this.chestV = new Float32Array(maxAgents)
    this.headX = new Float32Array(maxAgents)
    this.headV = new Float32Array(maxAgents)
    this.collapse = new Float32Array(maxAgents)
    this.collapseDir = new Float32Array(maxAgents)
    this.hiddenMask = new Uint16Array(maxAgents)

    this.footX = new Float32Array(maxAgents * 2)
    this.footY = new Float32Array(maxAgents * 2)
    this.footZ = new Float32Array(maxAgents * 2)
    this.liftX = new Float32Array(maxAgents * 2)
    this.liftY = new Float32Array(maxAgents * 2)
    this.liftZ = new Float32Array(maxAgents * 2)
    this.footYaw = new Float32Array(maxAgents * 2)
    this.planted = new Uint8Array(maxAgents * 2)
    this.currPose = new Float32Array(maxAgents * POSE_STRIDE)
    this.prevPose = new Float32Array(maxAgents * POSE_STRIDE)

    this.models = buildZombiePartMeshes().map((m) => renderer.addModel(m))
    this.partData = Array.from({ length: PART_COUNT }, () => new Float32Array(MAX_INSTANCES_PER_PART * INST_FLOATS))
    this.poolBatches = Array.from({ length: PART_COUNT }, (_, i) => ({
      model: this.models[i]!,
      data: this.partData[i]!,
      count: 0,
    }))
  }

  reset(): void {
    this.initialized.fill(0)
    this.hiddenMask.fill(0)
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
    const slot = ((agentId % this.cap) + this.cap) % this.cap
    if (this.initialized[slot] === 0) return undefined
    const pOff = slot * POSE_STRIDE
    return {
      bones: reconstructBonePose(this.currPose, pOff),
      prevBones: reconstructBonePose(this.prevPose, pOff),
      hiddenBones: this.maskToHiddenSet(this.hiddenMask[slot]!),
    }
  }

  detachAgentLimb(agent: AIAgent, root: BoneId, dt: number, impulseDir: V3): (ReturnType<typeof detach>[number])[] {
    const slot = ((agent.id % this.cap) + this.cap) % this.cap
    if (this.initialized[slot] === 0) return []
    const pOff = slot * POSE_STRIDE
    const bones = reconstructBonePose(this.currPose, pOff)
    const prev = reconstructBonePose(this.prevPose, pOff)
    const hidden = this.maskToHiddenSet(this.hiddenMask[slot]!)
    const pieces = detach(bones, prev, Math.max(1 / 120, dt), root, hidden)
    this.hiddenMask[slot] = this.hiddenMask[slot]! | BONE_SUBTREE_MASK[root]
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

  private writePart(
    pOff: number,
    boneIdx: number,
    partIndex: number,
    hidden: number,
    px: number,
    py: number,
    pz: number,
    yaw: number,
    pitch: number,
    roll: number,
    tr: number,
    tg: number,
    tb: number,
    alpha: number,
    flash: number,
  ): void {
    const bOff = pOff + boneIdx * POSE_FLOATS_PER_BONE
    const cPose = this.currPose
    cPose[bOff] = px
    cPose[bOff + 1] = py
    cPose[bOff + 2] = pz
    cPose[bOff + 3] = yaw
    cPose[bOff + 4] = pitch
    cPose[bOff + 5] = roll
    if ((hidden & (1 << boneIdx)) !== 0) return
    const count = this.partCounts[partIndex]!
    if (count >= MAX_INSTANCES_PER_PART) return
    const off = count * INST_FLOATS
    const data = this.partData[partIndex]!
    data[off] = px
    data[off + 1] = py
    data[off + 2] = pz
    data[off + 3] = yaw
    data[off + 4] = tr
    data[off + 5] = tg
    data[off + 6] = tb
    data[off + 7] = 1
    data[off + 8] = pitch
    data[off + 9] = roll
    data[off + 10] = alpha
    data[off + 11] = flash
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
    const focusX = (vx0 + vx1) * 0.5
    const focusY = (vy0 + vy1) * 0.5

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

    const prevTmp = this.prevPose
    this.prevPose = this.currPose
    this.currPose = prevTmp

    const {
      cap,
      initialized,
      phase,
      yaw,
      lastX,
      lastY,
      svx,
      svy,
      leanX,
      leanVX,
      leanY,
      leanVY,
      chestX,
      chestV,
      headX,
      headV,
      collapse,
      collapseDir,
      hiddenMask,
      footX,
      footY,
      footZ,
      liftX,
      liftY,
      liftZ,
      footYaw,
      planted,
    } = this

    const velBlend = 1 - Math.exp(-dt * 14)
    const baseLurch = zombieTune.zombieLurch
    const baseDrag = zombieTune.zombieDrag
    const baseReach = zombieTune.zombieReach
    const legH = RIG.thigh + RIG.shin
    const invSqrtGLeg = 1 / Math.sqrt(9.81 * legH)

    for (let idx = 0; idx < agents.length; idx++) {
      const a = agents[idx]!
      const ax = a.x
      const ay = a.y
      if (ax < vx0 - 3 || ax > vx1 + 3 || ay < vy0 - 3 || ay > vy1 + 3) continue
      const isVisible = vision.visible(ax, ay)
      if (!isVisible && !debugOverlay) continue

      const slot = ((a.id % cap) + cap) % cap
      const f0 = slot * 2
      const f1 = f0 + 1
      const pOff = slot * POSE_STRIDE

      if (initialized[slot] === 0) {
        initialized[slot] = 1
        const y0 = support(ax, ay)
        phase[slot] = (a.id * 0.27) % 1
        yaw[slot] = a.aim
        lastX[slot] = ax
        lastY[slot] = ay
        svx[slot] = a.vx
        svy[slot] = a.vy
        chestX[slot] = a.aim
        headX[slot] = a.aim
        collapse[slot] = 0
        collapseDir[slot] = (a.id % 2 === 0 ? 1 : -1) * 0.35
        footX[f0] = liftX[f0] = ax
        footY[f0] = liftY[f0] = y0
        footZ[f0] = liftZ[f0] = ay - 0.13
        footYaw[f0] = a.aim
        planted[f0] = 1
        footX[f1] = liftX[f1] = ax
        footY[f1] = liftY[f1] = y0
        footZ[f1] = liftZ[f1] = ay + 0.13
        footYaw[f1] = a.aim
        planted[f1] = 1
      }

      let hidden = hiddenMask[slot]!
      if (a.detachedLimbs.length > 0) {
        for (let i = 0; i < a.detachedLimbs.length; i++) {
          hidden |= BONE_SUBTREE_MASK[a.detachedLimbs[i] as BoneId] ?? 0
        }
        hiddenMask[slot] = hidden
      }

      const shade = 0.86 + ((a.id * 19) % 7) * 0.035
      const tr = !isVisible && debugOverlay ? 0.55 : shade
      const tg = !isVisible && debugOverlay ? 0.72 : shade * 0.98
      const tb = !isVisible && debugOverlay ? 0.85 : shade * 0.94
      const alpha = !isVisible && debugOverlay ? 0.58 : 1.0
      const flash = a.hitFlash

      const groundY =
        support(ax, ay) +
        (a.clamberWindowId ? Math.sin(clamp(a.clamberElapsed / Math.max(0.1, a.clamberDuration), 0, 1) * Math.PI) * 0.56 : 0)

      if (a.state === "dead") {
        const col = Math.min(1, collapse[slot]! + dt * 4.2)
        collapse[slot] = col
        const c = smoother(col)
        const py = groundY + (HIP * (1 - c) + 0.14 * c)
        const yw = yaw[slot]!
        const cosY = Math.cos(yw)
        const sinY = Math.sin(yw)
        const pPitch = -1.42 * c
        const pRoll = collapseDir[slot]! * c
        this.writePart(pOff, 0, 0, hidden, ax, py, ay, yw, pPitch, pRoll, tr, tg, tb, alpha, flash)
        this.writePart(pOff, 1, 1, hidden, ax, py + RIG.waist * (1 - c * 0.8), ay, yw, -1.48 * c, pRoll, tr, tg, tb, alpha, flash)
        this.writePart(
          pOff,
          2,
          2,
          hidden,
          ax + cosY * 0.02,
          py + (RIG.waist + RIG.neckY) * (1 - c * 0.8),
          ay + sinY * 0.02,
          yw,
          -1.35 * c,
          pRoll,
          tr,
          tg,
          tb,
          alpha,
          flash,
        )
        for (let s = 0; s < 2; s++) {
          const side = s === 0 ? -1 : 1
          const oz = side * RIG.hipW
          const hx = ax - sinY * oz
          const hz = ay + cosY * oz
          this.writePart(pOff, 7 + s, 5, hidden, hx, py, hz, yw, pPitch, 0, tr, tg, tb, alpha, flash)
          this.writePart(pOff, 9 + s, 6, hidden, hx - cosY * 0.32, groundY + 0.12, hz - sinY * 0.32, yw, pPitch, 0, tr, tg, tb, alpha, flash)
          this.writePart(pOff, 11 + s, 7, hidden, hx - cosY * 0.65, groundY + 0.09, hz - sinY * 0.65, yw, -1.2 * c, 0, tr, tg, tb, alpha, flash)
          const sx = ax - sinY * (side * RIG.shoulderW)
          const sz = ay + cosY * (side * RIG.shoulderW)
          this.writePart(pOff, 3 + s, 3, hidden, sx, py + 0.25, sz, yw, -1.1 * c, 0, tr, tg, tb, alpha, flash)
          this.writePart(pOff, 5 + s, 4, hidden, sx + cosY * 0.25, groundY + 0.1, sz + sinY * 0.25, yw, -1.3 * c, 0, tr, tg, tb, alpha, flash)
        }
        continue
      }

      // Smooth velocity & springs in-place (zero object allocation)
      const vx = svx[slot]! + (a.vx - svx[slot]!) * velBlend
      const vy = svy[slot]! + (a.vy - svy[slot]!) * velBlend
      const axAcc = (vx - svx[slot]!) / dt
      const ayAcc = (vy - svy[slot]!) / dt
      svx[slot] = vx
      svy[slot] = vy

      // Critically damped spring step for leanX, leanY
      let lx = leanX[slot]!
      let lvx = leanVX[slot]!
      lvx += (vx * 0.035 + axAcc * 0.003 - lx * 90 - lvx * 7.2) * dt
      lx += lvx * dt
      leanX[slot] = lx
      leanVX[slot] = lvx

      let ly = leanY[slot]!
      let lvy = leanVY[slot]!
      lvy += (vy * 0.035 + ayAcc * 0.003 - ly * 90 - lvy * 7.2) * dt
      ly += lvy * dt
      leanY[slot] = ly
      leanVY[slot] = lvy

      const speed = Math.hypot(vx, vy)
      const moving = Math.min(1, speed / 3.0)
      let travel = speed > 0.25 ? Math.atan2(vy, vx) : a.aim
      if (Math.abs(angleDiff(travel, a.aim)) > 2.05) travel += Math.PI
      const wantYaw = a.aim + clamp(angleDiff(travel, a.aim), -1.05, 1.05)
      const curYaw = yaw[slot]! + angleDiff(wantYaw, yaw[slot]!) * Math.min(1, dt * 9)
      yaw[slot] = curYaw
      const cosY = Math.cos(curYaw)
      const sinY = Math.sin(curYaw)

      const strideScale = 0.72 + 0.16 * (1 - baseDrag * a.drag)
      const froude = (speed * speed) / (9.81 * legH)
      const run = smooth((froude - 0.36) / 0.28)
      const effSpeed = speed - 0.22 * Math.max(0, speed - 3.6) * smooth((speed - 3.0) / 3.3)
      const stride = ((legH * (effSpeed * invSqrtGLeg + 0.665 - 0.015 * run)) / 0.83) * strideScale
      const duty = 0.56 - 0.12 * run - 0.2 * smooth((speed - 2.5) / 3)
      const rate = speed > 0.2 ? Math.max(0.85, speed / stride) : 0
      const ph = (phase[slot]! + rate * dt) % 1
      phase[slot] = ph
      const timingBias = 0.12 * baseLurch * a.lurch

      // Distance from camera center for kinematic LOD:
      // Within 26m: full planted-foot terrain support; beyond 26m: reuse root groundY
      const distSqToFocus = (ax - focusX) * (ax - focusX) + (ay - focusY) * (ay - focusY)
      const nearLod = distSqToFocus < 26 * 26

      for (let i = 0; i < 2; i++) {
        const fi = f0 + i
        const side = i === 0 ? -1 : 1
        const rx = ax - sinY * (side * 0.13)
        const rz = ay + cosY * (side * 0.13)
        const fPhase = (ph + i * (0.5 + timingBias * 0.25)) % 1
        if (rate > 0 && fPhase >= duty) {
          if (planted[fi] === 1) {
            planted[fi] = 0
            liftX[fi] = footX[fi]!
            liftY[fi] = footY[fi]!
            liftZ[fi] = footZ[fi]!
          }
          const u = (fPhase - duty) / (1 - duty)
          const e = smoother(u)
          const lead = (1 - fPhase) / rate + (duty / rate) * 0.5
          const tx = rx + vx * lead
          const tz = rz + vy * lead
          const ty = nearLod ? support(tx, tz) : groundY
          const clearance = i === 1 ? 1 - baseDrag * a.drag * 0.55 : 1
          footX[fi] = liftX[fi]! + (tx - liftX[fi]!) * e
          footY[fi] = liftY[fi]! + (ty - liftY[fi]!) * e + Math.sin(Math.PI * u) * (0.05 + 0.08 * moving) * clearance
          footZ[fi] = liftZ[fi]! + (tz - liftZ[fi]!) * e
          footYaw[fi] = footYaw[fi]! + angleDiff(curYaw, footYaw[fi]!) * e
        } else if (planted[fi] === 0) {
          planted[fi] = 1
          footY[fi] = nearLod ? support(footX[fi]!, footZ[fi]!) : groundY
        }
      }

      const pelvisY = groundY + HIP - 0.05 * moving - 0.035 * moving * Math.cos(ph * Math.PI * 4)
      const lean = lx * Math.cos(a.aim) + ly * Math.sin(a.aim)

      // Angle springs for chest & head
      const cDiff = angleDiff(a.aim, chestX[slot]!)
      chestV[slot] = (chestV[slot]! + cDiff * 36 * dt) * Math.exp(-8.5 * dt)
      const cYaw = chestX[slot]! + chestV[slot]! * dt
      chestX[slot] = cYaw

      const hDiff = angleDiff(a.aim, headX[slot]!)
      headV[slot] = (headV[slot]! + hDiff * 42 * dt) * Math.exp(-9.2 * dt)
      const hYaw = headX[slot]! + headV[slot]! * dt
      headX[slot] = hYaw

      const bashPulse = a.state === "bash" ? Math.pow(Math.max(0, Math.sin((a.stateTime * Math.PI * 2) / 0.9)), 3) * 0.34 : 0
      const staggerRecoil = a.state === "stagger" ? -0.36 * clamp(a.timer / 0.3, 0, 1) : -0.18 * flash
      const staggerCant = a.state === "stagger" ? (a.id % 2 ? 1 : -1) * 0.22 * clamp(a.timer / 0.3, 0, 1) : 0
      const torsoPitch = -0.05 - lean - 0.22 * baseLurch * a.lurch - bashPulse - staggerRecoil
      const torsoRoll = 0.08 * a.asymmetry + staggerCant

      const torsoY = pelvisY + RIG.waist
      const cosC = Math.cos(cYaw)
      const sinC = Math.sin(cYaw)

      // 0: pelvis, 1: torso, 2: head
      this.writePart(pOff, 0, 0, hidden, ax, pelvisY, ay, curYaw, 0, 0, tr, tg, tb, alpha, flash)
      this.writePart(pOff, 1, 1, hidden, ax, torsoY, ay, cYaw, torsoPitch, torsoRoll, tr, tg, tb, alpha, flash)
      this.writePart(
        pOff,
        2,
        2,
        hidden,
        ax + cosC * 0.02,
        torsoY + RIG.neckY,
        ay + sinC * 0.02,
        hYaw,
        -staggerRecoil * 0.6,
        0.12 * a.asymmetry + staggerCant * 0.5,
        tr,
        tg,
        tb,
        alpha,
        flash,
      )

      // 3..6: Left and right upperArm & foreArm (zombie reach + shambling swing)
      const reachAmt = clamp(baseReach * (0.65 + 0.35 * a.reach) + (a.state === "chase" ? 0.28 : 0), 0, 1)
      const armPitchBase = -0.25 - reachAmt * 1.05
      const armSwing = Math.sin(ph * Math.PI * 2) * (0.28 * moving * (1 - reachAmt * 0.6))
      const shoulderY = torsoY + RIG.shoulderY
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1
        const sx = ax - sinC * (side * RIG.shoulderW)
        const sz = ay + cosC * (side * RIG.shoulderW)
        const uPitch = armPitchBase + side * armSwing
        const fPitch = uPitch - 0.38 - reachAmt * 0.25
        // Upper arm origin is at shoulder; forearm origin is at elbow
        const elbowDist = RIG.upper * Math.sin(-uPitch)
        const elbowDrop = RIG.upper * Math.cos(-uPitch)
        const ex = sx + cosC * elbowDist
        const ey = shoulderY - elbowDrop
        const ez = sz + sinC * elbowDist
        this.writePart(pOff, 3 + s, 3, hidden, sx, shoulderY, sz, cYaw, uPitch, side * 0.08, tr, tg, tb, alpha, flash)
        this.writePart(pOff, 5 + s, 4, hidden, ex, ey, ez, cYaw, fPitch, side * 0.05, tr, tg, tb, alpha, flash)
      }

      // 7..12: Left and right thigh, shin, and foot
      for (let i = 0; i < 2; i++) {
        const fi = f0 + i
        const side = i === 0 ? -1 : 1
        const hx = ax - sinY * (side * RIG.hipW)
        const hy = pelvisY
        const hz = ay + cosY * (side * RIG.hipW)
        const fx = footX[fi]!
        const fy = footY[fi]! + RIG.ankle
        const fz = footZ[fi]!

        // Analytical 2-bone leg pitch in sagittal plane
        const dx = fx - hx
        const dy = fy - hy
        const dz = fz - hz
        const fwd = dx * cosY + dz * sinY
        const d2 = clamp(dx * dx + dy * dy + dz * dz, 0.04, (RIG.thigh + RIG.shin - 0.005) ** 2)
        const d = Math.sqrt(d2)
        const cosKnee = clamp((RIG.thigh * RIG.thigh + RIG.shin * RIG.shin - d2) / (2 * RIG.thigh * RIG.shin), -1, 1)
        const cosHipBend = clamp((d2 + RIG.thigh * RIG.thigh - RIG.shin * RIG.shin) / (2 * d * RIG.thigh), -1, 1)
        const legChordPitch = Math.atan2(fwd, -dy)
        const thighPitch = legChordPitch + Math.acos(cosHipBend)
        const kneeAngle = Math.PI - Math.acos(cosKnee)
        const shinPitch = thighPitch - kneeAngle

        const kx = hx + cosY * (RIG.thigh * Math.sin(thighPitch))
        const ky = hy - RIG.thigh * Math.cos(thighPitch)
        const kz = hz + sinY * (RIG.thigh * Math.sin(thighPitch))

        this.writePart(pOff, 7 + i, 5, hidden, hx, hy, hz, curYaw, thighPitch, 0, tr, tg, tb, alpha, flash)
        this.writePart(pOff, 9 + i, 6, hidden, kx, ky, kz, curYaw, shinPitch, 0, tr, tg, tb, alpha, flash)
        this.writePart(pOff, 11 + i, 7, hidden, fx, footY[fi]! + 0.075, fz, footYaw[fi]!, 0, 0, tr, tg, tb, alpha, flash)
      }
    }

    this.batches.length = 0
    for (let p = 0; p < PART_COUNT; p++) {
      const count = this.partCounts[p]!
      if (count <= 0) continue
      const b = this.poolBatches[p]!
      b.count = count
      this.batches.push(b)
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
