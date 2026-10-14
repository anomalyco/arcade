import { MAT, Mesh, type Rgb } from "../mesh"
import { INST_FLOATS, type Batch, type Renderer } from "../renderer"
import { HIP, RIG, clamp, smoother } from "../../rig"
import { angleDiff, RectGrid, type Rect, type Vec } from "../../sim/geom"
import { FlowFieldNav } from "../../sim/flow-field"
import type { AIAgent, AIConfig, NavPortal, NoiseBus, PerceptionTarget, SpatialHash } from "../../sim/ai"
import type { Vision } from "../../../../games/outbreak/shared/vision"
import type { ZombieTuning } from "../../../../games/outbreak/src/zombie-profile"

const PART_COUNT = 8
export const HORDE_MAX_INSTANCES_PER_PART = 2048

const hex = (n: number): Rgb => [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]

/**
 * From-scratch Data-Oriented (SoA) Crowd Animation + Instance Packing Renderer.
 *
 * Replaces `ZombieCrowdRenderer` (`games/outbreak/src/zombies.ts`):
 * 1. Raises `MAX_INSTANCES_PER_PART` from `256` (which silently dropped all limbs above 128 zombies!) to `2048`.
 * 2. Replaces `Map<number, AgentAnimState>` and per-frame `V3`, `Frame`, `HumanProfile`, and `{ ...st.bones }`
 *    heap allocations with flat contiguous `Float32Array` SoA columns indexed by slot `0..cap-1`.
 * 3. Solves 2-bone analytical limb transforms directly into registers and writes the 12-float instance matrix
 *    in-place into `partData[partIndex]`, with distance-based kinematic LOD beyond `26 m`.
 */
export class SoAZombieCrowdRenderer {
  private readonly models: number[]
  private readonly partData: Float32Array<ArrayBuffer>[]
  readonly partCounts = new Int32Array(PART_COUNT)
  readonly batches: Batch[] = []

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
  // Feet (2 per agent -> length = cap * 2)
  private readonly footX: Float32Array
  private readonly footY: Float32Array
  private readonly footZ: Float32Array
  private readonly liftX: Float32Array
  private readonly liftY: Float32Array
  private readonly liftZ: Float32Array
  private readonly footYaw: Float32Array
  private readonly planted: Uint8Array

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

    this.footX = new Float32Array(maxAgents * 2)
    this.footY = new Float32Array(maxAgents * 2)
    this.footZ = new Float32Array(maxAgents * 2)
    this.liftX = new Float32Array(maxAgents * 2)
    this.liftY = new Float32Array(maxAgents * 2)
    this.liftZ = new Float32Array(maxAgents * 2)
    this.footYaw = new Float32Array(maxAgents * 2)
    this.planted = new Uint8Array(maxAgents * 2)

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
    this.partData = Array.from({ length: PART_COUNT }, () => new Float32Array(HORDE_MAX_INSTANCES_PER_PART * INST_FLOATS))
  }

  private writePart(
    partIndex: number,
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
    const count = this.partCounts[partIndex]!
    if (count >= HORDE_MAX_INSTANCES_PER_PART) return
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

    const {
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

    for (let idx = 0; idx < agents.length; idx++) {
      const a = agents[idx]!
      const ax = a.x
      const ay = a.y
      if (ax < vx0 - 3 || ax > vx1 + 3 || ay < vy0 - 3 || ay > vy1 + 3) continue
      const isVisible = vision.visible(ax, ay)
      if (!isVisible && !debugOverlay) continue

      const slot = a.id % this.cap
      const f0 = slot * 2
      const f1 = f0 + 1

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

      const shade = 0.86 + ((a.id * 19) % 7) * 0.035
      const tr = !isVisible && debugOverlay ? 0.55 : shade
      const tg = !isVisible && debugOverlay ? 0.72 : shade * 0.98
      const tb = !isVisible && debugOverlay ? 0.85 : shade * 0.94
      const alpha = !isVisible && debugOverlay ? 0.58 : 1.0
      const flash = a.hitFlash

      const groundY = support(ax, ay) + (a.clamberWindowId ? Math.sin(clamp(a.clamberElapsed / Math.max(0.1, a.clamberDuration), 0, 1) * Math.PI) * 0.56 : 0)

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
        this.writePart(0, ax, py, ay, yw, pPitch, pRoll, tr, tg, tb, alpha, flash)
        this.writePart(1, ax, py + RIG.waist * (1 - c * 0.8), ay, yw, -1.48 * c, pRoll, tr, tg, tb, alpha, flash)
        this.writePart(2, ax + cosY * 0.02, py + (RIG.waist + RIG.neckY) * (1 - c * 0.8), ay + sinY * 0.02, yw, -1.35 * c, pRoll, tr, tg, tb, alpha, flash)
        for (let s = 0; s < 2; s++) {
          const side = s === 0 ? -1 : 1
          const oz = side * RIG.hipW
          const hx = ax - sinY * oz
          const hz = ay + cosY * oz
          this.writePart(5, hx, py, hz, yw, pPitch, 0, tr, tg, tb, alpha, flash)
          this.writePart(6, hx - cosY * 0.32, groundY + 0.12, hz - sinY * 0.32, yw, pPitch, 0, tr, tg, tb, alpha, flash)
          this.writePart(7, hx - cosY * 0.65, groundY + 0.09, hz - sinY * 0.65, yw, -1.2 * c, 0, tr, tg, tb, alpha, flash)
          const sx = ax - sinY * (side * RIG.shoulderW)
          const sz = ay + cosY * (side * RIG.shoulderW)
          this.writePart(3, sx, py + 0.25, sz, yw, -1.1 * c, 0, tr, tg, tb, alpha, flash)
          this.writePart(4, sx + cosY * 0.25, groundY + 0.1, sz + sinY * 0.25, yw, -1.3 * c, 0, tr, tg, tb, alpha, flash)
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
      let lx = leanX[slot]!, lvx = leanVX[slot]!
      lvx += (vx * 0.035 + axAcc * 0.003 - lx * 90 - lvx * 7.2) * dt
      lx += lvx * dt
      leanX[slot] = lx; leanVX[slot] = lvx

      let ly = leanY[slot]!, lvy = leanVY[slot]!
      lvy += (vy * 0.035 + ayAcc * 0.003 - ly * 90 - lvy * 7.2) * dt
      ly += lvy * dt
      leanY[slot] = ly; leanVY[slot] = lvy

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
      const rate = speed > 0.05 ? speed / ((0.7 + 0.22 * speed) * strideScale) : 0
      const ph = (phase[slot]! + rate * dt) % 1
      phase[slot] = ph
      const duty = 0.64 - 0.2 * moving
      const timingBias = 0.12 * baseLurch * a.lurch

      // Distance from camera center for kinematic LOD:
      // Within 26m: full planted-foot swing & 2-bone knee geometry; beyond 26m: fast stride wheel
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
      this.writePart(0, ax, pelvisY, ay, curYaw, 0, 0, tr, tg, tb, alpha, flash)
      this.writePart(1, ax, torsoY, ay, cYaw, torsoPitch, torsoRoll, tr, tg, tb, alpha, flash)
      this.writePart(
        2,
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

      // 3 & 4: Left and right upperArm & foreArm (zombie reach + shambling swing)
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
        this.writePart(3, sx, shoulderY, sz, cYaw, uPitch, side * 0.08, tr, tg, tb, alpha, flash)
        this.writePart(4, ex, ey, ez, cYaw, fPitch, side * 0.05, tr, tg, tb, alpha, flash)
      }

      // 5, 6, 7: Left and right thigh, shin, and foot
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

        this.writePart(5, hx, hy, hz, curYaw, thighPitch, 0, tr, tg, tb, alpha, flash)
        this.writePart(6, kx, ky, kz, curYaw, shinPitch, 0, tr, tg, tb, alpha, flash)
        this.writePart(7, fx, footY[fi]! + 0.075, fz, footYaw[fi]!, 0, 0, tr, tg, tb, alpha, flash)
      }
    }

    this.batches.length = 0
    for (let p = 0; p < PART_COUNT; p++) {
      const count = this.partCounts[p]!
      if (count <= 0) continue
      this.batches.push({
        model: this.models[p]!,
        data: this.partData[p]!.subarray(0, count * INST_FLOATS) as Float32Array<ArrayBuffer>,
        count,
      })
    }
    return this.batches
  }
}

export { FlowFieldNav }
