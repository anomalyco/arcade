import type { Camera } from "@arcade/kit/client/camera"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, SPRITE_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { angleSpring } from "@arcade/kit/human-locomotion"
import {
  boneVisible,
  detach,
  poseArms,
  poseUnarmedArms,
  type BoneId,
  type BonePose,
} from "@arcade/kit/human-pose"
import { humanProfiles, profileHands, profileTorso, type HumanProfile } from "@arcade/kit/human-profile"
import {
  resolveDragFoot,
  shambleHandsFK,
  shambleTorsoModulation,
} from "@arcade/kit/shamble-crouch"
import {
  at,
  clamp,
  dirIn,
  HIP,
  ik,
  limb,
  pitch,
  RIG,
  roll,
  smooth,
  smoother,
  spring,
  stepSpring,
  yawFrame,
  type Frame,
  type V3,
} from "@arcade/kit/rig"
import { angleDiff } from "@arcade/kit/sim/geom"
import type { AIAgent, AIConfig, NoiseEvent } from "../shared/ai"
import type { Vision } from "../shared/vision"
import { hex } from "./level"
import { zombieProfile, type ZombieTuning } from "./zombie-profile"

type AgentAnimState = {
  feet: { p: V3; lift: V3; target: V3; prevU: number; planted: boolean; yaw: number }[]
  phase: number
  yaw: number
  last: [number, number]
  svx: number
  svy: number
  leanX: { x: number; v: number }
  leanY: { x: number; v: number }
  reachDrop: { x: number; v: number }
  twist: { x: number; v: number }
  chest: { x: number; v: number }
  head: { x: number; v: number }
  bones: BonePose
  prevBones: BonePose
  hiddenBones: Set<BoneId>
  collapse: number
  collapseDir: number
}

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
const MAX_INSTANCES_PER_PART = 256

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

function frameAngles(f: Frame): [number, number, number] {
  const p = Math.asin(clamp(f.x[1], -1, 1))
  const c = Math.cos(p)
  const yaw = c > 1e-4 ? Math.atan2(f.x[2], f.x[0]) : Math.atan2(-f.z[0], f.z[2])
  const r = c > 1e-4 ? Math.atan2(-f.z[1], f.y[1]) : 0
  return [yaw, p, r]
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

export class ZombieCrowdRenderer {
  private readonly models: number[]
  private readonly partData: Float32Array<ArrayBuffer>[]
  private readonly partCounts = new Int32Array(PART_COUNT)
  private readonly anims = new Map<number, AgentAnimState>()
  private readonly scratchProfile: HumanProfile = { ...humanProfiles.zombie }
  readonly debris: DetachedDebrisPiece[] = []
  readonly batches: Batch[] = []
  private overlayCanvas: HTMLCanvasElement | null = null
  private overlayCtx: CanvasRenderingContext2D | null = null

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
  }

  reset(): void {
    this.anims.clear()
    this.debris.length = 0
  }

  getAgentBones(agentId: number): { bones: BonePose; prevBones: BonePose; hiddenBones: Set<BoneId>; planted?: [boolean, boolean] } | undefined {
    const st = this.anims.get(agentId)
    if (!st) return undefined
    return {
      bones: st.bones,
      prevBones: st.prevBones,
      hiddenBones: st.hiddenBones,
      planted: [st.feet[0]!.planted, st.feet[1]!.planted],
    }
  }

  detachAgentLimb(agent: AIAgent, root: BoneId, dt: number, impulseDir: V3): ( ReturnType<typeof detach>[number] )[] {
    const st = this.anims.get(agent.id)
    if (!st) return []
    const pieces = detach(st.bones, st.prevBones, Math.max(1 / 120, dt), root, st.hiddenBones)
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

  private ensureAnim(agent: AIAgent, support: (x: number, z: number) => number): AgentAnimState {
    let st = this.anims.get(agent.id)
    if (!st) {
      const y0 = support(agent.x, agent.y)
      st = {
        feet: [-1, 1].map((side) => ({
          p: [agent.x, y0, agent.y + side * 0.13] as V3,
          lift: [agent.x, y0, agent.y + side * 0.13] as V3,
          target: [agent.x, y0, agent.y + side * 0.13] as V3,
          prevU: 0,
          planted: true,
          yaw: agent.aim,
        })),
        phase: (agent.id * 0.27 + (agent.seed % 97) * 0.01) % 1,
        yaw: agent.aim,
        last: [agent.x, agent.y],
        svx: 0,
        svy: 0,
        leanX: spring(),
        leanY: spring(),
        reachDrop: spring(),
        twist: spring(),
        chest: { x: agent.aim, v: 0 },
        head: { x: agent.aim, v: 0 },
        bones: {},
        prevBones: {},
        hiddenBones: new Set<BoneId>(agent.detachedLimbs as BoneId[]),
        collapse: 0,
        collapseDir: (agent.id % 2 === 0 ? 1 : -1) * 0.35,
      }
      this.anims.set(agent.id, st)
    }
    return st
  }

  private pushPart(partIndex: number, frame: Frame, tint: Rgb, flash: number, alpha = 1): void {
    const count = this.partCounts[partIndex]!
    if (count >= MAX_INSTANCES_PER_PART) return
    const [yaw, p, r] = frameAngles(frame)
    const offset = count * INST_FLOATS
    const data = this.partData[partIndex]!
    data[offset] = frame.p[0]
    data[offset + 1] = frame.p[1]
    data[offset + 2] = frame.p[2]
    data[offset + 3] = yaw
    data[offset + 4] = tint[0]
    data[offset + 5] = tint[1]
    data[offset + 6] = tint[2]
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
        data.set([d.p[0], d.p[1], d.p[2], d.yaw, 0.85, 0.75, 0.75, 1, d.pitchAngle, d.rollAngle, 1, 0], offset)
        this.partCounts[d.partIndex] = count + 1
      }
    }

    for (let idx = 0; idx < agents.length; idx++) {
      const a = agents[idx]!
      if (a.x < vx0 - 3 || a.x > vx1 + 3 || a.y < vy0 - 3 || a.y > vy1 + 3) continue

      const isVisible = vision.visible(a.x, a.y)
      if (!isVisible && !debugOverlay) continue

      const st = this.ensureAnim(a, support)
      for (const limbId of a.detachedLimbs) {
        st.hiddenBones.add(limbId as BoneId)
      }

      // Compute individual colour variation
      const shade = 0.86 + ((a.id * 19) % 7) * 0.035
      const tint: Rgb = !isVisible && debugOverlay ? [0.55, 0.72, 0.85] : [shade, shade * 0.98, shade * 0.94]
      const alpha = !isVisible && debugOverlay ? 0.58 : 1.0

      if (a.state === "dead") {
        st.collapse = Math.min(1, st.collapse + dt * 4.2)
        const c = smoother(st.collapse)
        const groundY = support(a.x, a.y)
        const pelvisY = groundY + (HIP * (1 - c) + 0.14 * c)
        let pelvis = yawFrame([a.x, pelvisY, a.y], st.yaw)
        pelvis = pitch(pelvis, -1.42 * c)
        pelvis = roll(pelvis, st.collapseDir * c)
        const torso = pitch(yawFrame(at(pelvis, 0, RIG.waist, 0), st.yaw), -1.48 * c)
        const head = pitch(yawFrame(at(torso, 0.02, RIG.neckY, 0), st.yaw), -1.35 * c)

        if (boneVisible("pelvis", st.hiddenBones)) this.pushPart(0, pelvis, tint, a.hitFlash, alpha)
        if (boneVisible("torso", st.hiddenBones)) this.pushPart(1, torso, tint, a.hitFlash, alpha)
        if (boneVisible("head", st.hiddenBones)) this.pushPart(2, head, tint, a.hitFlash, alpha)
        for (let i = 0; i < 2; i++) {
          const side = i ? 1 : -1
          const name = i === 0 ? "left" : "right"
          const hip = at(pelvis, 0, 0, side * RIG.hipW)
          const footTarget: V3 = [
            a.x - Math.cos(st.yaw) * 0.65,
            groundY + 0.09,
            a.y - Math.sin(st.yaw) * 0.65 + side * 0.16,
          ]
          const pole = dirIn(pelvis, 1, 0, side * 0.3)
          const [knee, end] = ik(hip, footTarget, RIG.thigh, RIG.shin, pole)
          if (boneVisible(`${name}.thigh` as BoneId, st.hiddenBones))
            this.pushPart(5, limb(hip, knee, pole, pelvis.x), tint, a.hitFlash, alpha)
          if (boneVisible(`${name}.shin` as BoneId, st.hiddenBones))
            this.pushPart(6, limb(knee, end, pole, pelvis.x), tint, a.hitFlash, alpha)
          if (boneVisible(`${name}.foot` as BoneId, st.hiddenBones))
            this.pushPart(7, pitch(yawFrame(end, st.yaw), -1.2 * c), tint, a.hitFlash, alpha)

          const shoulder = at(torso, 0, RIG.shoulderY, side * RIG.shoulderW)
          const handTarget: V3 = [
            a.x + Math.cos(st.yaw) * 0.45,
            groundY + 0.08,
            a.y + Math.sin(st.yaw) * 0.45 + side * 0.25,
          ]
          const [elbow, wrist] = ik(shoulder, handTarget, RIG.upper, RIG.fore, dirIn(torso, -0.4, -1, side))
          if (boneVisible(`${name}.upperArm` as BoneId, st.hiddenBones))
            this.pushPart(3, limb(shoulder, elbow, torso.x, torso.y), tint, a.hitFlash, alpha)
          if (boneVisible(`${name}.foreArm` as BoneId, st.hiddenBones))
            this.pushPart(4, limb(elbow, wrist, torso.x, torso.y), tint, a.hitFlash, alpha)
        }
        continue
      }

      for (const k in st.bones) {
        st.prevBones[k as BoneId] = st.bones[k as BoneId]
      }
      const clamberLift = a.clamberWindowId
        ? Math.sin(clamp(a.clamberElapsed / Math.max(0.1, a.clamberDuration), 0, 1) * Math.PI) * 0.56
        : 0
      const supportAt = (x: number, z: number) => support(x, z) + clamberLift

      const prevX = st.last[0]
      const prevY = st.last[1]
      const teleport = Math.hypot(a.x - prevX, a.y - prevY) > 2.5
      st.last = [a.x, a.y]
      if (teleport) {
        st.yaw = a.aim
        st.svx = a.vx
        st.svy = a.vy
        st.chest = { x: a.aim, v: 0 }
        st.head = { x: a.aim, v: 0 }
      }

      const profile = agentZombieProfile(a, zombieTune, this.scratchProfile)
      const k = 1 - Math.exp(-dt * 14)
      const vx = st.svx + (a.vx - st.svx) * k
      const vy = st.svy + (a.vy - st.svy) * k
      stepSpring(st.leanX, 90, 0.38, dt, vx * 0.035 + ((vx - st.svx) / dt) * 0.003)
      stepSpring(st.leanY, 90, 0.38, dt, vy * 0.035 + ((vy - st.svy) / dt) * 0.003)
      st.svx = vx
      st.svy = vy
      const speed = Math.hypot(vx, vy)
      const moving = Math.min(1, speed / 3.0)
      let travel = speed > 0.25 ? Math.atan2(vy, vx) : a.aim
      if (Math.abs(angleDiff(travel, a.aim)) > 2.05) travel += Math.PI
      const want = a.aim + clamp(angleDiff(travel, a.aim), -1.05, 1.05)
      st.yaw += angleDiff(want, st.yaw) * Math.min(1, dt * 9)
      const cosY = Math.cos(st.yaw)
      const sinY = Math.sin(st.yaw)
      const rest = (i: number): V3 => {
        const rx = a.x - sinY * (i ? 0.13 : -0.13)
        const rz = a.y + cosY * (i ? 0.13 : -0.13)
        return [rx, supportAt(rx, rz), rz]
      }
      if (teleport) {
        st.feet.forEach((f, i) => {
          f.p = rest(i)
          f.lift = [...f.p]
          f.target = [...f.p]
          f.prevU = 0
          f.planted = true
          f.yaw = st.yaw
        })
        st.reachDrop = spring()
        st.twist = spring()
      }
      const actorSeed = a.id === 1 && (zombieTune.zombieVariant ?? 0) === 0 ? 0 : a.seed
      const dragFoot = resolveDragFoot(actorSeed)
      const needsStep =
        speed < 0.2 &&
        st.feet.some((f, i) => Math.hypot(f.p[0] - rest(i)[0], f.p[2] - rest(i)[2]) > 0.22 || !f.planted)
      const stride = (0.98 + 0.34 * speed) * profile.strideScale
      const rate = speed >= 0.15 ? speed / stride : needsStep ? 1.25 : 0
      st.phase = (st.phase + rate * dt) % 1
      const duty = 0.62 - 0.18 * moving
      st.feet.forEach((f, i) => {
        const isDrag = i === dragFoot
        const drag = isDrag ? clamp(profile.footDrag, 0, 0.95) : 0
        const phase = (st.phase + i * (0.5 + profile.timingBias * 0.22)) % 1
        if (rate > 0 && phase >= duty) {
          const u = (phase - duty) / (1 - duty)
          const e = smoother(u)
          const eHoriz = drag > 0 ? e * (1 - 0.34 * drag * (1 - u)) : e
          if (f.planted) {
            f.planted = false
            f.lift = [...f.p]
            f.prevU = 0
          }
          const lead = Math.min(0.38, (1 - phase) / rate + (duty / rate) * 0.48) * (isDrag ? 1 - 0.18 * drag : 1.06)
          const target = rest(i)
          target[0] += vx * lead
          target[2] += vy * lead
          const other = st.feet[1 - i]!
          const side = i ? 1 : -1
          const lat = (-(target[0] - other.p[0]) * sinY + (target[2] - other.p[2]) * cosY) * side
          if (lat < 0.16) {
            target[0] -= sinY * side * (0.16 - lat)
            target[2] += cosY * side * (0.16 - lat)
          }
          target[1] = supportAt(target[0], target[2])
          const epPrev = smoother(f.prevU) * (drag > 0 ? 1 - 0.34 * drag * (1 - f.prevU) : 1)
          if (epPrev > 0 && epPrev < 0.96 && u < 0.78) {
            const curX = f.lift[0] + (f.target[0] - f.lift[0]) * epPrev
            const curY = f.lift[1] + (f.target[1] - f.lift[1]) * epPrev
            const curZ = f.lift[2] + (f.target[2] - f.lift[2]) * epPrev
            f.lift = [
              (curX - target[0] * epPrev) / (1 - epPrev),
              (curY - target[1] * epPrev) / (1 - epPrev),
              (curZ - target[2] * epPrev) / (1 - epPrev),
            ]
            f.target = target
          } else if (f.prevU === 0) {
            f.target = target
          }
          f.prevU = u
          const tgt = f.target
          const clearance = isDrag ? Math.max(0.08, (1 - drag) * 0.85) : 1.08
          const liftBell = 1.72 * Math.sin(Math.PI * u) ** 2 * (1 - u)
          const px = f.lift[0] + (tgt[0] - f.lift[0]) * eHoriz
          const pz = f.lift[2] + (tgt[2] - f.lift[2]) * eHoriz
          const py = Math.max(
            supportAt(px, pz),
            f.lift[1] + (tgt[1] - f.lift[1]) * eHoriz + liftBell * (0.092 + 0.055 * moving) * clearance,
          )
          f.p = [px, py, pz]
          f.yaw += angleDiff(st.yaw, f.yaw) * e
        } else if (!f.planted) {
          f.planted = true
          f.prevU = 0
          f.p = [f.target[0], supportAt(f.target[0], f.target[2]), f.target[2]]
          f.yaw = st.yaw
        }
      })

      const footSupport =
        (supportAt(st.feet[0]!.p[0], st.feet[0]!.p[2]) + supportAt(st.feet[1]!.p[0], st.feet[1]!.p[2])) * 0.5
      const supportY = supportAt(a.x, a.y) * 0.65 + footSupport * 0.35
      const shambleGait = smooth((speed - 0.12) / 0.35)
      const shambleMod = shambleTorsoModulation(st.phase, shambleGait, profile, actorSeed)
      const baseHeight =
        supportY +
        HIP -
        0.012 * moving +
        shambleMod.pelvisBobAdd -
        0.016 * shambleGait * Math.sin(st.phase * Math.PI * 4 - 0.35)
      let desiredDrop = 0
      for (const f of st.feet) {
        const d = Math.min(0.72, Math.hypot(f.p[0] - a.x, f.p[2] - a.y))
        const reachY = Math.sqrt(Math.max(0, 0.822 ** 2 - d ** 2)) + RIG.ankle + f.p[1]
        desiredDrop = Math.max(desiredDrop, Math.max(0, Math.min(0.14, baseHeight - reachY)))
      }
      stepSpring(st.reachDrop, 120, 0.88, dt, desiredDrop)
      const fdx = st.feet[1]!.p[0] - st.feet[0]!.p[0]
      const fdz = st.feet[1]!.p[2] - st.feet[0]!.p[2]
      const footFwd = fdx * cosY + fdz * sinY
      stepSpring(st.twist, 110, 0.85, dt, clamp(footFwd * 0.28, -0.16, 0.16) * (profile.twistScale ?? 1.4))

      const height = baseHeight - st.reachDrop.x
      let pelvis = yawFrame([a.x, height, a.y], st.yaw + st.twist.x)
      pelvis = roll(pelvis, shambleMod.pelvisRollAdd)
      pelvis = pitch(pelvis, -0.06 * moving - 0.35 * shambleMod.torsoPitchAdd)
      const lean = st.leanX.x * Math.cos(a.aim) + st.leanY.x * Math.sin(a.aim)
      angleSpring(st.chest, a.aim - st.twist.x * 0.55 + shambleMod.torsoYawAdd, profile.chestHz, dt)
      angleSpring(st.head, a.aim + shambleMod.headYawAdd, profile.headHz, dt)

      // Add a lunge pitch during door bashing or backward flinch during bullet/shove stagger
      const bashPulse =
        a.state === "bash" ? Math.pow(Math.max(0, Math.sin((a.stateTime * Math.PI * 2) / 0.9)), 3) * 0.34 : 0
      const staggerRecoil =
        a.state === "stagger" ? -0.36 * clamp(a.timer / 0.3, 0, 1) : -0.18 * a.hitFlash
      const staggerCant =
        a.state === "stagger" ? (a.id % 2 ? 1 : -1) * 0.22 * clamp(a.timer / 0.3, 0, 1) : 0
      let torso = pitch(
        yawFrame(at(pelvis, 0, RIG.waist, 0), st.chest.x),
        -0.04 - lean - shambleMod.torsoPitchAdd - bashPulse - staggerRecoil,
      )
      torso = roll(profileTorso(torso, profile), shambleMod.torsoRollAdd + staggerCant)
      let head = yawFrame(at(torso, 0.02, RIG.neckY, 0), st.head.x)
      head = roll(
        pitch(head, -0.12 * profile.torsoLean - shambleMod.headPitchAdd - staggerRecoil * 0.6),
        profile.headTilt + shambleMod.headRollAdd + staggerCant * 0.5,
      )
      const runBlend = clamp((speed - 1.5) / 1.5, 0, 1)
      const hands = shambleHandsFK(torso, st.phase, shambleGait, runBlend, profile, actorSeed)
      const arms = poseUnarmedArms(torso, ...hands)

      st.bones.pelvis = pelvis
      st.bones.torso = torso
      st.bones.head = head
      if (boneVisible("pelvis", st.hiddenBones)) this.pushPart(0, pelvis, tint, a.hitFlash, alpha)
      if (boneVisible("torso", st.hiddenBones)) this.pushPart(1, torso, tint, a.hitFlash, alpha)
      if (boneVisible("head", st.hiddenBones)) this.pushPart(2, head, tint, a.hitFlash, alpha)

      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1
        const isDrag = i === dragFoot
        const drag = isDrag ? clamp(profile.footDrag, 0, 0.95) : 0
        const foot = st.feet[i]!
        const hip = at(pelvis, 0, 0, side * RIG.hipW)
        const ankle: V3 = [foot.p[0], foot.p[1] + RIG.ankle, foot.p[2]]
        const pole = dirIn(pelvis, 1, 0.28, side * 0.25)
        const [knee, end] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
        const thigh = limb(hip, knee, pole, pelvis.x)
        const shin = limb(knee, end, pole, pelvis.x)
        const footPhase = (st.phase + i * (0.5 + profile.timingBias * 0.22)) % 1
        const stanceFrac = foot.planted ? clamp(footPhase / Math.max(0.1, duty), 0, 1) : 0
        const stancePitch = isDrag
          ? -0.22 * smooth((stanceFrac - 0.58) / 0.42) * drag * shambleGait
          : -0.20 * smooth((stanceFrac - 0.62) / 0.38) * shambleGait
        const swingPitch = isDrag
          ? -0.24 * Math.sin(Math.PI * (1 - foot.prevU * 0.65)) * drag
          : (-0.18 * Math.sin(Math.PI * clamp(foot.prevU / 0.55, 0, 1)) +
              0.14 * Math.sin(Math.PI * clamp((foot.prevU - 0.5) / 0.5, 0, 1))) *
            shambleGait
        const fc = Math.cos(foot.yaw)
        const fs = Math.sin(foot.yaw)
        let boot: Frame
        if (foot.planted) {
          // Lock the planted toe in world space while rolling heel-off in terminal stance
          const f0 = pitch(yawFrame([0, 0, 0], foot.yaw), stancePitch)
          const off = at(f0, 0.19, -RIG.ankle, 0)
          f0.p[0] = foot.p[0] + fc * 0.19 - off[0]
          f0.p[1] = foot.p[1] - off[1]
          f0.p[2] = foot.p[2] + fs * 0.19 - off[2]
          boot = f0
        } else {
          boot = pitch(yawFrame(end, foot.yaw), swingPitch)
        }
        const name = i === 0 ? "left" : "right"
        st.bones[`${name}.thigh` as BoneId] = thigh
        st.bones[`${name}.shin` as BoneId] = shin
        st.bones[`${name}.foot` as BoneId] = boot
        if (boneVisible(`${name}.thigh` as BoneId, st.hiddenBones)) this.pushPart(5, thigh, tint, a.hitFlash, alpha)
        if (boneVisible(`${name}.shin` as BoneId, st.hiddenBones)) this.pushPart(6, shin, tint, a.hitFlash, alpha)
        if (boneVisible(`${name}.foot` as BoneId, st.hiddenBones)) this.pushPart(7, boot, tint, a.hitFlash, alpha)

        const upper = arms.ua[i]!
        const fore = arms.fa[i]!
        st.bones[`${name}.upperArm` as BoneId] = upper
        st.bones[`${name}.foreArm` as BoneId] = fore
        if (boneVisible(`${name}.upperArm` as BoneId, st.hiddenBones)) this.pushPart(3, upper, tint, a.hitFlash, alpha)
        if (boneVisible(`${name}.foreArm` as BoneId, st.hiddenBones)) this.pushPart(4, fore, tint, a.hitFlash, alpha)
      }
    }

    this.batches.length = 0
    for (let i = 0; i < PART_COUNT; i++) {
      const count = this.partCounts[i]!
      if (count > 0) {
        this.batches.push({
          model: this.models[i]!,
          data: this.partData[i]!,
          count,
        })
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
