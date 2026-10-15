import { Mesh, MAT } from "@arcade/kit/gpu/mesh"
import { Renderer, type Batch } from "@arcade/kit/gpu/renderer"
import type { LabControl } from "@arcade/kit/lab-panel"
import {
  RIG,
  HIP,
  at,
  clamp,
  dirIn,
  dot,
  emit,
  ik,
  kick,
  lerp3,
  limb,
  moved,
  pitch,
  roll,
  smooth,
  spring,
  stepSpring,
  smoother,
   sub,
  yawFrame,
  type Frame,
  type Spring,
  type V3,
  type PushPart,
} from "@arcade/kit/rig"
import { angleSpring, gaitAt, stepHash, stiffness } from "@arcade/kit/human-locomotion"
import { humanProfiles, profileHands, profileTorso, type HumanProfile } from "@arcade/kit/human-profile"
import { poseArms, poseUnarmedArms, unarmedHands, type BonePose } from "@arcade/kit/human-pose"
import { shambleHandsFK, shambleTorsoModulation } from "@arcade/kit/shamble-crouch"
import { angleDiff } from "@arcade/kit/sim/geom"
import { PISTOL_RELOAD_TIME } from "../shared/combat"
import type { Survivor as Pose } from "../shared/session"
import { hex } from "./level"

export const PISTOL_MUZZLE = 0.20
export const PISTOL_HOLD = { fwd: 0.375, up: 1.35, side: 0.045 } as const
export const PISTOL_LOW_READY = { fwd: 0.28, up: 1.13, side: 0.165 } as const
const REST_SHOULDER_Y = HIP + RIG.waist + RIG.shoulderY
const BLADE_PISTOL = 0.235

/** Lab-tunable parameters for the survivor's pistol ready, aim, recoil and upper-body twist. */
export const survivorAimTuning = {
  aimRaiseTime: 0.15,
  aimHoldTime: 2.5,
  aimRecoil: 1.0,
  aimTwistLimit: 1.05,
}
export type SurvivorAimTuning = typeof survivorAimTuning

export const survivorAimControls: LabControl[] = [
  { key: "aimRaiseTime", label: "Raise time", group: "Survivor aim", min: 0.08, max: 0.35, step: 0.01, unit: "s" },
  { key: "aimHoldTime", label: "Hold time", group: "Survivor aim", min: 0.5, max: 5.0, step: 0.1, unit: "s" },
  { key: "aimRecoil", label: "Recoil", group: "Survivor aim", min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "aimTwistLimit", label: "Twist limit · rad", group: "Survivor aim", min: 0.45, max: 1.55, step: 0.05, unit: "rad" },
]

export type SurvivorDrawPose = Pick<Pose, "x" | "y" | "vx" | "vy" | "aim"> &
  Partial<
    Pick<Pose, "equippedItem" | "fireCooldown" | "reloadRemaining" | "recoil" | "shoveAnim" | "sprinting" | "channel">
  > & {
    /** Optional deterministic override to hold raised aim without firing a shot. */
    aiming?: boolean
  }

type ReloadGunKey = readonly [t: number, pitch: number, roll: number, pull: number, drop: number, yaw: number]
type ReloadHandKey =
  | readonly [t: number, space: "home"]
  | readonly [t: number, space: "gun" | "torso" | "pelvis", x: number, y: number, z: number]

const PISTOL_RELOAD_GUN: readonly ReloadGunKey[] = [
  [0.00, 0.00, 0.00, 0.00, 0.00, 0.00],
  [0.12, 0.24, 0.68, 0.11, 0.07, 0.32],
  [0.54, 0.28, 0.74, 0.12, 0.08, 0.36],
  [0.64, 0.14, 0.42, 0.09, 0.04, 0.22],
  [0.78, 0.06, 0.16, 0.13, 0.03, 0.12],
  [0.90, -0.02, 0.04, 0.03, 0.01, 0.02],
  [1.00, 0.00, 0.00, 0.00, 0.00, 0.00],
]

const PISTOL_RELOAD_LEFT: readonly ReloadHandKey[] = [
  [0.00, "home"],
  [0.12, "gun", -0.02, -0.11, -0.03],
  [0.26, "pelvis", -0.01, 0.01, -0.12],
  [0.38, "pelvis", 0.01, 0.02, -0.12],
  [0.52, "gun", -0.02, -0.13, -0.02],
  [0.62, "gun", 0.00, -0.045, -0.01],
  [0.74, "gun", 0.02, 0.048, -0.018],
  [0.82, "gun", -0.045, 0.048, -0.018],
  [0.94, "home"],
  [1.00, "home"],
]

function keyedReload<T extends readonly [number, ...unknown[]]>(keys: readonly T[], t: number): [T, T, number] {
  let i = 0
  while (i < keys.length - 1 && keys[i + 1]![0] <= t) i++
  const a = keys[i]!
  const b = keys[Math.min(i + 1, keys.length - 1)]!
  const span = b[0] - a[0]
  return [a, b, span > 0 ? smooth((t - a[0]) / span) : 1]
}

/**
 * Outbreak's survivor rig: planted-foot terrain gait + Blackout's stabilised shoulder weapon frame,
 * low-ready pistol carry, fast anticipation-free raise to two-handed aim on fire, per-shot recoil,
 * configurable post-shot aim hold, and keyframed magazine-to-grip reload.
 */
export class Survivor {
  /** Optional presentation override; does not change the Session's player or movement. */
  profile?: HumanProfile
  aimTuning: SurvivorAimTuning = { ...survivorAimTuning }
  /** Automation-only flag for before/after visual comparisons. */
  legacyUnarmedPistol = false
  seed = 17
  bones: BonePose = {}
  gun: Frame | null = null
  mag: Frame | null = null
  /**
   * Where the flashlight sits this frame and the way it points: the pistol's light under the barrel when a pistol is
   * drawn (it follows low-ready, raised aim, recoil and reload), otherwise the right hand pointing along the aim.
   */
  readonly light: { p: V3; d: V3; mounted: boolean } = { p: [0, 1.3, 0], d: [1, 0, 0], mounted: false }
  aimWeight = 0
  holdRemaining = 0
  recBack = spring()
  recPitch = spring()
  recYaw = spring()
  recRoll = spring()
  torsoKick = spring()
  private chest = spring()
  private head = spring()
  private reachDrop = spring()
  private twist = spring()
  private arms = [spring(), spring()] as const
  private hands = [spring(), spring()] as const
  private aimSpring = spring()
  private weaponYaw = spring()
  private gunPos: [Spring, Spring, Spring] = [spring(), spring(), spring()]
  private gunInit = false
  private prevSupportY = 0
  private prevAim = 0
  private prevFireCooldown = 0
  private prevRecoil = 0
  private prevReloadRemaining = 0
  private remoteReloadElapsed = 0
  private sinceShot = 10
  private shotCount = 0
  private back = false
  private models: number[]
  private feet = [-1, 1].map(() => ({
    p: [0, 0, 0] as V3,
    lift: [0, 0, 0] as V3,
    target: [0, 0, 0] as V3,
    prevU: 0,
    planted: true,
    yaw: 0,
    stepReach: 1,
    stepLat: 0,
    stepLift: 1,
    stepToe: 0,
  }))
  private stepCount = 0
  private phase = 0
  private yaw = 0
  private last: [number, number] = [Infinity, Infinity]
  private svx = 0
  private svy = 0
  private leanX = spring()
  private leanY = spring()
  private data = new Float32Array(15 * 12)
  readonly batches: Batch[] = []
  /** Each foot contact (plan x, y and body speed in m/s): footstep sounds land on the rig's own gait. */
  onFootfall?: (x: number, y: number, speed: number) => void

  /** `palette` recolours the jacket and trousers (co-op seats); the default is the offline survivor. */
  constructor(
    renderer: Pick<Renderer, "addModel">,
    palette: { torso: number; legs: number } = { torso: 0x8c6b42, legs: 0x41474b },
  ) {
    const box = (w: number, y0: number, h: number, d: number, color: number) => {
      const m = new Mesh()
      m.box(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, hex(color), MAT.actor)
      return m
    }
    const pelvis = box(0.25, -0.07, 0.18, 0.34, palette.legs)
    const torso = box(0.28, -0.02, 0.48, 0.4, palette.torso)
    torso.box(-0.29, 0.07, -0.15, -0.14, 0.4, 0.15, hex(0x4d6259), MAT.actor)
    torso.box(-0.3, 0.28, -0.14, -0.28, 0.32, 0.14, hex(0xa3a48a), MAT.actor)
    const head = box(0.18, 0.01, 0.24, 0.18, 0xad8266)
    head.box(-0.1, 0.19, -0.11, 0.1, 0.28, 0.11, hex(0x3b342d), MAT.actor)
    const foot = box(0.21, -0.075, 0.09, 0.14, 0x3b3029)

    // Compact 9mm semi-auto pistol (grip at origin, barrel along +x, muzzle at +0.20 m)
    const pistol = new Mesh()
    pistol.box(-0.035, -0.095, -0.018, 0.03, 0.005, 0.018, hex(0x25282a), MAT.actor)
    pistol.box(-0.045, 0.005, -0.022, 0.18, 0.052, 0.022, hex(0x43494e), MAT.actor)
    pistol.box(0.18, 0.014, -0.012, 0.202, 0.042, 0.012, hex(0x222528), MAT.actor)
    pistol.box(0.155, 0.052, -0.006, 0.175, 0.064, 0.006, hex(0xe2d6c0), MAT.actor)
    pistol.box(-0.035, 0.052, -0.014, -0.015, 0.062, 0.014, hex(0x9ea49a), MAT.actor)

    // 9mm box magazine with brass top cartridge (visible in left hand during reload)
    const mag = new Mesh()
    mag.box(-0.022, -0.095, -0.014, 0.022, 0.0, 0.014, hex(0x2d3135), MAT.actor)
    mag.box(-0.018, 0.0, -0.011, 0.018, 0.012, 0.011, hex(0xd4a448), MAT.actor)

    this.models = [
      pelvis,
      torso,
      head,
      box(0.15, -0.29, 0.33, 0.15, palette.torso),
      box(0.11, -0.28, 0.3, 0.11, 0x9b7858),
      box(0.17, -0.42, 0.46, 0.17, palette.legs),
      box(0.13, -0.41, 0.43, 0.14, palette.legs),
      foot,
      pistol,
      mag,
    ].map(m => renderer.addModel(m))
  }

  reset(): void {
    this.last = [Infinity, Infinity]
    this.phase = this.yaw = this.svx = this.svy = this.stepCount = 0
    this.leanX = spring()
    this.leanY = spring()
    this.reachDrop = spring()
    this.twist = spring()
    this.arms[0].x = this.arms[0].v = this.arms[1].x = this.arms[1].v = 0
    this.hands[0].x = this.hands[0].v = this.hands[1].x = this.hands[1].v = 0
    this.chest = spring()
    this.head = spring()
    this.aimSpring = spring()
    this.weaponYaw = spring()
    this.gunPos = [spring(), spring(), spring()]
    this.gunInit = false
    this.prevSupportY = 0
    this.prevAim = 0
    this.prevFireCooldown = 0
    this.prevRecoil = 0
    this.prevReloadRemaining = 0
    this.remoteReloadElapsed = 0
    this.sinceShot = 10
    this.shotCount = 0
    this.back = false
    this.aimWeight = 0
    this.holdRemaining = 0
    this.recBack = spring()
    this.recPitch = spring()
    this.recYaw = spring()
    this.recRoll = spring()
    this.torsoKick = spring()
    this.bones = {}
    this.gun = null
    this.mag = null
  }

  draw(
    p: SurvivorDrawPose,
    dt: number,
    time: number,
    support: (x: number, z: number) => number,
    tuning?: Partial<SurvivorAimTuning>,
  ): Batch[] {
    dt = Math.max(0.0001, Math.min(0.2, dt))
    if (tuning) Object.assign(this.aimTuning, tuning)
    const tune = this.aimTuning
    const prevX = this.last[0]
    const prevY = this.last[1]
    const teleport = Math.hypot(p.x - prevX, p.y - prevY) > 2.5
    this.last = [p.x, p.y]

    const profile = this.profile
    const isZombie = Boolean(profile && profile.handPose === "reach")
    const isStaff = Boolean(profile && profile.handPose === "staff")
    const isPistol = p.equippedItem === "pistol" && !isZombie && !isStaff && !p.channel && !this.legacyUnarmedPistol

    if (teleport) {
      this.yaw = p.aim
      this.prevAim = p.aim
      this.svx = p.vx
      this.svy = p.vy
      this.phase = 0
      this.back = false
      this.chest = { x: p.aim, v: 0 }
      this.head = { x: p.aim, v: 0 }
      this.weaponYaw = { x: p.aim, v: 0 }
      this.reachDrop = spring()
      this.twist = spring()
      this.arms[0].x = this.arms[0].v = this.arms[1].x = this.arms[1].v = 0
      this.hands[0].x = this.hands[0].v = this.hands[1].x = this.hands[1].v = 0
      this.gunInit = false
    }

    const totalDAim = teleport ? 0 : angleDiff(p.aim, this.prevAim)
    this.prevAim = p.aim

    // Detect newly fired shots from either fireCooldown (local) or recoil jump (local & co-op remote snapshots)
    const cooldownNow = p.fireCooldown ?? 0
    const recoilNow = p.recoil ?? 0
    const reloadNow = p.reloadRemaining ?? 0
    const fired =
      isPistol &&
      (cooldownNow > this.prevFireCooldown + 0.01 ||
        (recoilNow > this.prevRecoil + 0.08 && this.sinceShot > 0.08) ||
        (recoilNow > 0.75 && this.prevRecoil <= 0.75 && this.sinceShot > 0.08))
    this.prevFireCooldown = cooldownNow
    this.prevRecoil = recoilNow

    const raiseTime = clamp(tune.aimRaiseTime, 0.08, 0.35)
    const holdTime = clamp(tune.aimHoldTime, 0.5, 5.0)
    const recoilScale = clamp(tune.aimRecoil, 0, 2.5)
    const twistLimit = clamp(tune.aimTwistLimit, 0.45, 1.55)

    if (fired) {
      const sc = ++this.shotCount
      const j = stepHash(this.seed, sc, 7)
      kick(this.recBack, recoilScale * 0.052, 1200)
      kick(this.recPitch, recoilScale * 0.24, 1100)
      kick(this.recYaw, recoilScale * j * 0.02, 1100)
      kick(this.recRoll, recoilScale * j * 0.038, 1100)
      kick(this.torsoKick, recoilScale * 0.038, 280)
      this.holdRemaining = holdTime
      this.sinceShot = 0
      if (this.aimSpring.x < 0.85) {
        this.aimSpring.v = Math.max(this.aimSpring.v, 0.85 / raiseTime)
      }
    }

    // Track reload clip progress (0..1) for both local countdown and remote co-op boolean snapshot
    let reloadClipT: number | null = null
    if (isPistol && reloadNow > 0) {
      if (this.prevReloadRemaining <= 0) {
        this.remoteReloadElapsed = 0
      } else if (Math.abs(reloadNow - this.prevReloadRemaining) < 1e-4) {
        this.remoteReloadElapsed += dt
      }
      if (Math.abs(reloadNow - 0.5) < 1e-4 && this.remoteReloadElapsed > 0) {
        reloadClipT = clamp((this.remoteReloadElapsed / PISTOL_RELOAD_TIME) % 1, 0, 0.999)
      } else {
        reloadClipT = clamp(1 - reloadNow / PISTOL_RELOAD_TIME, 0, 1)
      }
      this.holdRemaining = Math.max(this.holdRemaining, 0.9)
    } else {
      this.remoteReloadElapsed = 0
    }
    this.prevReloadRemaining = reloadNow

    if (p.aiming && isPistol) {
      if (this.holdRemaining <= 0 && this.aimSpring.x < 0.05) {
        this.aimSpring.v = Math.max(this.aimSpring.v, 0.95 / raiseTime)
      }
      this.holdRemaining = Math.max(this.holdRemaining, holdTime)
    } else if (!isPistol) {
      this.holdRemaining = 0
    }

    const steps = teleport ? 1 : Math.max(1, Math.ceil(dt / (1 / 60) - 1e-4))
    const h = dt / steps
    const dAimStep = totalDAim / steps
    let moving = 0

    for (let step = 1; step <= steps; step++) {
      const uStep = step / steps
      const sx = teleport ? p.x : prevX + (p.x - prevX) * uStep
      const sy = teleport ? p.y : prevY + (p.y - prevY) * uStep
      const k = 1 - Math.exp(-h * 14)
      const vx = this.svx + (p.vx - this.svx) * k
      const vy = this.svy + (p.vy - this.svy) * k
      const speed = Math.hypot(vx, vy)
      moving = Math.min(1, speed / 3.4)
      const activeProfile = profile ?? humanProfiles.soldier
      const curGait = gaitAt(speed, false, 0, activeProfile)
      const runBlend = curGait.run
      const leanScale = 0.25 + 0.75 * runBlend
      stepSpring(this.leanX, 90, 0.38, h, vx * 0.028 * leanScale + ((vx - this.svx) / h) * 0.003)
      stepSpring(this.leanY, 90, 0.38, h, vy * 0.028 * leanScale + ((vy - this.svy) / h) * 0.003)
      this.svx = vx
      this.svy = vy

      const effTwistLimit = isPistol ? twistLimit : 1.05
      let travel = speed > 0.35 ? Math.atan2(vy, vx) : p.aim
      const rawTravelDiff = Math.abs(angleDiff(travel, p.aim))
      if (this.back ? rawTravelDiff < 1.72 : rawTravelDiff > 2.05) this.back = !this.back
      if (this.back) travel += Math.PI
      const want = p.aim + clamp(angleDiff(travel, p.aim), -effTwistLimit, effTwistLimit)
      this.yaw += angleDiff(want, this.yaw) * Math.min(1, h * 9)
      this.yaw = p.aim + clamp(angleDiff(this.yaw, p.aim), -effTwistLimit, effTwistLimit)

      const c = Math.cos(this.yaw)
      const s = Math.sin(this.yaw)
      const rest = (i: number): V3 => {
        const x = sx - s * (i ? 0.145 : -0.145)
        const z = sy + c * (i ? 0.145 : -0.145)
        return [x, support(x, z), z]
      }
      if (teleport && step === 1) {
        this.feet.forEach((f, i) => {
          f.p = rest(i)
          f.lift = [...f.p]
          f.target = [...f.p]
          f.prevU = 0
          f.planted = true
          f.yaw = this.yaw
        })
      }
      const isZombiePose = profile?.handPose === "reach"
      const needsStep = this.feet.some(
        (f, i) => Math.hypot(f.p[0] - rest(i)[0], f.p[2] - rest(i)[2]) > 0.2 || !f.planted,
      )
      const dragSlow = isZombiePose ? 1 - 0.22 * clamp(profile?.footDrag ?? 0, 0, 0.95) * (1 - 0.5 * runBlend) : 1
      const rate = speed > 0.2 ? Math.max(0.72, (speed / curGait.stride) * dragSlow) : needsStep ? 1.7 : 0
      this.phase = (this.phase + rate * h) % 1
      const duty = curGait.duty
      this.feet.forEach((f, i) => {
        const phase = (this.phase + i * (0.5 + (profile?.timingBias ?? 0) * 0.25)) % 1
        if (rate > 0 && phase >= duty) {
          const u = (phase - duty) / (1 - duty)
          const e = smoother(u)
          const firstSwingFrame = f.planted
          if (f.planted) {
            f.planted = false
            f.lift = [...f.p]
            f.prevU = 0
            const sc = ++this.stepCount
            const varAmt = clamp(profile?.stepVariation ?? 0.35, 0, 1)
            const blue = 0.65 * stepHash(this.seed, sc, 1) - 0.55 * stepHash(this.seed, sc - 2, 1)
            f.stepReach = 1 + varAmt * 0.065 * blue
            f.stepLat = varAmt * 0.016 * stepHash(this.seed, sc, 2)
            f.stepLift = 1 + varAmt * 0.15 * stepHash(this.seed, sc, 3)
            f.stepToe = varAmt * 0.06 * stepHash(this.seed, sc, 4)
          }
          if (firstSwingFrame || u < 0.75) {
            const lead = Math.min(0.34, (1 - phase) / rate + (duty / rate) * 0.48) * f.stepReach
            const target = rest(i)
            target[0] += vx * lead - s * f.stepLat
            target[2] += vy * lead + c * f.stepLat
            // Preserve Blackout's minimum side-step separation.
            const other = this.feet[1 - i]!
            const side = i ? 1 : -1
            const lat = (-(target[0] - other.p[0]) * s + (target[2] - other.p[2]) * c) * side
            if (lat < 0.16) {
              target[0] -= s * side * (0.16 - lat)
              target[2] += c * side * (0.16 - lat)
            }
            target[1] = support(target[0], target[2])
            const ep = smoother(f.prevU)
            if (!firstSwingFrame && ep > 0 && ep < 0.95) {
              const curX = f.lift[0] + (f.target[0] - f.lift[0]) * ep
              const curY = f.lift[1] + (f.target[1] - f.lift[1]) * ep
              const curZ = f.lift[2] + (f.target[2] - f.lift[2]) * ep
              f.lift = [
                (curX - target[0] * ep) / (1 - ep),
                (curY - target[1] * ep) / (1 - ep),
                (curZ - target[2] * ep) / (1 - ep),
              ]
            }
            f.target = target
          }
          f.prevU = u
          const target = f.target
          const clearance = (i === 1 ? 1 - (profile?.footDrag ?? 0) : 1) * f.stepLift
          // Mid-swing terrain clearance boost & floor guard (Lamplight arachnid/mod.rs & walk.rs:1419, 1446)
          const midY = support((f.lift[0] + target[0]) * 0.5, (f.lift[2] + target[2]) * 0.5)
          const boost = Math.max(0, midY - Math.max(f.lift[1], target[1]))
          const px = f.lift[0] + (target[0] - f.lift[0]) * e
          const pz = f.lift[2] + (target[2] - f.lift[2]) * e
          const liftBell = 1.72 * Math.sin(Math.PI * u) ** 2 * (1 - u)
          const py = Math.max(
            support(px, pz),
            f.lift[1] + (target[1] - f.lift[1]) * e + liftBell * ((0.085 + 0.125 * runBlend) * clearance + boost),
          )
          f.p = [px, py, pz]
          f.yaw += angleDiff(this.yaw + f.stepToe, f.yaw) * e
        } else if (!f.planted) {
          f.planted = true
          f.prevU = 0
          f.p[1] = support(f.p[0], f.p[2])
          this.onFootfall?.(f.p[0], f.p[2], speed)
        }
      })
      // Anticipatory support floor: blend root terrain support with foot terrain heights (never airborne swing height).
      const footSupport =
        (support(this.feet[0]!.p[0], this.feet[0]!.p[2]) + support(this.feet[1]!.p[0], this.feet[1]!.p[2])) * 0.5
      const supportY = support(sx, sy) * 0.65 + footSupport * 0.35
      const bobPhase = this.phase * Math.PI * 4 + (1 - runBlend) * 1.15
      const baseHeight = supportY + HIP - 0.012 * moving - (0.021 + 0.008 * runBlend) * moving * Math.sin(bobPhase)
      let desiredDrop = 0
      for (const f of this.feet) {
        const distance = Math.min(0.72, Math.hypot(f.p[0] - sx, f.p[2] - sy))
        const reachY = Math.sqrt(Math.max(0, 0.825 ** 2 - distance ** 2)) + RIG.ankle + f.p[1]
        desiredDrop = Math.max(desiredDrop, Math.max(0, Math.min(0.18, baseHeight - reachY)))
      }
      stepSpring(this.reachDrop, 140, 0.85, h, desiredDrop)
      const fdx = this.feet[1]!.p[0] - this.feet[0]!.p[0]
      const fdz = this.feet[1]!.p[2] - this.feet[0]!.p[2]
      const footFwd = fdx * c + fdz * s
      stepSpring(this.twist, 160, 0.85, h, clamp(footFwd * 0.32, -0.17, 0.17) * (profile?.twistScale ?? 1.2))
      const gait = smooth((speed - 0.15) / 0.35)
      const footNorm = clamp(footFwd / Math.max(0.35, curGait.stride * 0.44), -1, 1)
      const armLead = 0.22 + 1.06 * runBlend
      const phaseArm = -Math.cos(this.phase * Math.PI * 2 + armLead) * gait
      const armSignal = speed > 0.2 ? footNorm * 0.25 + phaseArm * 0.75 : footNorm
      const armAmp = (0.16 + 0.22 * runBlend) * (profile?.armSwing ?? 1) * gait
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1
        stepSpring(this.arms[i]!, 2400, 0.85, h, -side * armSignal * armAmp)
        stepSpring(this.hands[i]!, 1600, 0.82, h, this.arms[i]!.x)
      }

      // Step weapon raise/hold timer, recoil springs, and weapon yaw spring
      const prevSinceShot = this.sinceShot
      this.sinceShot += h
      if (this.holdRemaining > 0 && !p.aiming && reloadClipT === null) {
        this.holdRemaining = Math.max(0, this.holdRemaining - h)
      }
      const aimGoal = isPistol && (this.holdRemaining > 0 || reloadClipT !== null) ? 1 : 0
      if (aimGoal > 0) {
        const wRaise = 2.55 / raiseTime
        stepSpring(this.aimSpring, wRaise * wRaise, 0.74, h, 1)
      } else {
        stepSpring(this.aimSpring, 64, 0.96, h, 0)
      }

      if (prevSinceShot >= 1 / 60) {
        for (const sp of [this.recBack, this.recPitch, this.recYaw, this.recRoll]) {
          stepSpring(sp, 1100, 0.45, h, 0)
        }
      }
      stepSpring(this.torsoKick, 280, 0.50, h, 0)

      this.weaponYaw.x += dAimStep
      angleSpring(this.weaponYaw, p.aim, 16, h)
    }

    this.aimWeight = isPistol ? clamp(this.aimSpring.x, 0, 1.08) : 0
    const aimW = clamp(this.aimWeight, 0, 1)
    const settleOver = Math.max(0, this.aimWeight - 1)

    const curSpeed = Math.hypot(this.svx, this.svy)
    const gait = smooth((curSpeed - 0.15) / 0.35)
    const curGait = gaitAt(curSpeed, false, 0, profile ?? humanProfiles.soldier)
    const runBlend = curGait.run
    const shambleMod = isZombie && profile ? shambleTorsoModulation(this.phase, gait, profile, 0) : null
    const crouchT = clamp(((profile?.crouchDepth ?? 0) - 0.082) / 0.015, 0, 1) * runBlend
    const crouchDrop = crouchT * 0.055
    const footSupport =
      (support(this.feet[0]!.p[0], this.feet[0]!.p[2]) + support(this.feet[1]!.p[0], this.feet[1]!.p[2])) * 0.5
    const curSupportY = support(p.x, p.y) * 0.65 + footSupport * 0.35
    const bobPhase = this.phase * Math.PI * 4 + (1 - runBlend) * 1.15
    const bobOffset = (0.021 + 0.008 * runBlend) * gait * Math.sin(bobPhase)
    const height =
      curSupportY +
      HIP -
      (0.008 + 0.022 * runBlend) * gait -
      crouchDrop +
      (shambleMod?.pelvisBobAdd ?? 0) * 0.45 -
      bobOffset -
      this.reachDrop.x
    let pelvis = roll(
      yawFrame([p.x, height, p.y], this.yaw + this.twist.x),
      Math.cos(this.phase * Math.PI * 2) * (0.07 + 0.03 * (profile?.hipDrop ?? 0)) * moving +
        (shambleMod?.pelvisRollAdd ?? 0),
    )
    if (crouchT > 0 || shambleMod) {
      pelvis = pitch(pelvis, -0.22 * crouchT - 0.35 * (shambleMod?.torsoPitchAdd ?? 0))
    }

    const ca = Math.cos(p.aim)
    const sa = Math.sin(p.aim)
    const lean = this.leanX.x * ca + this.leanY.x * sa
    const sideLean = (-this.leanX.x * sa + this.leanY.x * ca) * (profile?.turnBank ?? 1)

    const blade = isPistol ? BLADE_PISTOL * (0.18 + 0.82 * aimW) : 0
    const counterTwist = this.twist.x * 0.65 * (1 - 0.68 * aimW)
    const rawChestGoal = p.aim + blade - counterTwist + (shambleMod?.torsoYawAdd ?? 0)
    const clampedChestGoal = isPistol
      ? this.yaw + blade + clamp(angleDiff(rawChestGoal, this.yaw + blade), -twistLimit, twistLimit)
      : rawChestGoal

    if (profile) {
      angleSpring(this.chest, clampedChestGoal, profile.chestHz, dt)
      angleSpring(this.head, p.aim + (shambleMod?.headYawAdd ?? 0), profile.headHz, dt)
    } else {
      angleSpring(this.chest, clampedChestGoal, 7 + 4 * aimW, dt)
      angleSpring(this.head, p.aim, 9 + 4 * aimW, dt)
    }

    const torsoYaw =
      (profile ? this.chest.x : isPistol ? this.chest.x : p.aim - this.twist.x * 0.65) + this.recYaw.x * 0.35
    const tb = torsoYaw - p.aim
    const reloadLook =
      reloadClipT !== null
        ? reloadClipT < 0.12
          ? smooth(reloadClipT / 0.12) * 0.28
          : reloadClipT < 0.78
            ? 0.28
            : (1 - smooth((reloadClipT - 0.78) / 0.22)) * 0.28
        : 0
    const reloadHunch = reloadLook * 0.22
    const posturePitch = 0.14 * runBlend * (profile?.runPosture ?? 0.18) * (1 - 0.35 * aimW)
    const fwdPitch =
      0.05 +
      lean +
      (shambleMod?.torsoPitchAdd ?? 0) +
      posturePitch +
      0.24 * crouchT +
      reloadHunch -
      this.torsoKick.x
    const sideRoll = sideLean * 0.75 + (shambleMod?.torsoRollAdd ?? 0)

    let torso = yawFrame(at(pelvis, 0, RIG.waist, 0), torsoYaw)
    if (isPistol) {
      torso = pitch(torso, -(fwdPitch * Math.cos(tb) + sideRoll * Math.sin(tb)))
      torso = roll(torso, sideRoll * Math.cos(tb) - fwdPitch * Math.sin(tb) * 0.85)
    } else {
      torso = roll(pitch(torso, -fwdPitch), sideRoll)
    }
    if (profile) torso = profileTorso(torso, profile)

    let head = pitch(
      yawFrame(at(torso, 0.02, RIG.neckY, 0), profile ? this.head.x : p.aim),
      lean * 0.35 * (profile?.headStability ?? 0.75) -
        (shambleMod?.headPitchAdd ?? 0) -
        reloadLook -
        this.torsoKick.x * 0.55,
    )
    if (profile) head = roll(head, profile.headTilt + (shambleMod?.headRollAdd ?? 0))

    let arms: ReturnType<typeof poseArms>
    if (isPistol) {
      // Anchor the pistol to the stabilised shoulder frame (root + lean/posture, without hip sway, pelvic roll or gait twist)
      const steadyHeight =
        curSupportY +
        HIP -
        (0.008 + 0.022 * runBlend) * gait -
        crouchDrop -
        bobOffset * 0.2 -
        this.reachDrop.x
      const steadyPelvis = yawFrame([p.x, steadyHeight, p.y], this.yaw)
      const steadyYaw =
        this.yaw + blade + clamp(angleDiff(p.aim + blade, this.yaw + blade), -twistLimit, twistLimit) + this.recYaw.x * 0.35
      const steadyTb = steadyYaw - p.aim
      const steadyFwd = 0.05 + lean + posturePitch + 0.24 * crouchT + reloadHunch - this.torsoKick.x
      let steadyTorso = yawFrame(at(steadyPelvis, 0, RIG.waist, 0), steadyYaw)
      steadyTorso = pitch(steadyTorso, -(steadyFwd * Math.cos(steadyTb) + sideRoll * Math.sin(steadyTb)))
      steadyTorso = roll(steadyTorso, sideRoll * Math.cos(steadyTb) - steadyFwd * Math.sin(steadyTb) * 0.85)
      if (profile) steadyTorso = profileTorso(steadyTorso, profile)
      const gunShoulder = at(steadyTorso, 0, RIG.shoulderY, 0)

      const lowSwingFwd = 0.035 * this.arms[1]!.x * (1 - aimW)
      const holdFwd =
        PISTOL_LOW_READY.fwd + (PISTOL_HOLD.fwd - 0.02 * runBlend - PISTOL_LOW_READY.fwd) * aimW + lowSwingFwd
      const holdUp = PISTOL_LOW_READY.up + (PISTOL_HOLD.up - PISTOL_LOW_READY.up) * aimW + settleOver * 0.12
      const holdSide = PISTOL_LOW_READY.side + (PISTOL_HOLD.side - PISTOL_LOW_READY.side) * aimW

      const gy = this.weaponYaw.x
      const ga = Math.cos(gy)
      const gs = Math.sin(gy)
      const targetGunPos: V3 = [
        gunShoulder[0] + ga * holdFwd - gs * holdSide,
        gunShoulder[1] + holdUp - REST_SHOULDER_Y,
        gunShoulder[2] + gs * holdFwd + ga * holdSide,
      ]

      if (teleport || !this.gunInit) {
        for (let i = 0; i < 3; i++) {
          this.gunPos[i]!.x = targetGunPos[i]!
          this.gunPos[i]!.v = 0
        }
        this.gunInit = true
      } else {
        this.gunPos[0].x += p.x - prevX
        this.gunPos[1].x += curSupportY - this.prevSupportY
        this.gunPos[2].x += p.y - prevY
        const kGun = stiffness(14)
        for (let i = 0; i < 3; i++) {
          stepSpring(this.gunPos[i]!, kGun, 1, dt, targetGunPos[i]!)
        }
      }

      let gunPitch = 0
      let gunRoll = 0
      let gunPull = 0
      let gunDrop = 0
      let gunYaw = 0
      if (reloadClipT !== null) {
        const [k0, k1, u] = keyedReload(PISTOL_RELOAD_GUN, reloadClipT)
        gunPitch = k0[1] + (k1[1] - k0[1]) * u
        gunRoll = k0[2] + (k1[2] - k0[2]) * u
        gunPull = k0[3] + (k1[3] - k0[3]) * u
        gunDrop = k0[4] + (k1[4] - k0[4]) * u
        gunYaw = k0[5] + (k1[5] - k0[5]) * u
      }

      const lowPitch = (-0.48 + 0.14 * this.arms[1]!.x) * (1 - aimW)
      const lowYaw = (0.08 - 0.05 * this.arms[1]!.x) * (1 - aimW)
      const lowRoll = 0.16 * (1 - aimW)

      const yaw = gy + this.recYaw.x - gunYaw - lowYaw
      let gunF = yawFrame([this.gunPos[0].x, this.gunPos[1].x - gunDrop, this.gunPos[2].x], yaw)
      gunF = pitch(gunF, this.recPitch.x + gunPitch + lowPitch + settleOver * 0.25)
      gunF = roll(gunF, this.recRoll.x + gunRoll + lowRoll)
      gunF = moved(gunF, at(gunF, -this.recBack.x - gunPull, 0, 0))
      this.gun = gunF

      // Hand targets: right hand anchored to pistol grip; left hand cups grip in aim, swings/guards in low ready, or executes reload clip
      const handR = at(gunF, 0, -0.035, 0)
      const supportL = at(gunF, 0.025, -0.04, -0.022)
      let handL: V3
      let gripBlend = smooth(clamp((aimW - 0.05) / 0.85, 0, 1))

      if (reloadClipT !== null) {
        const [k0, k1, u] = keyedReload(PISTOL_RELOAD_LEFT, reloadClipT)
        const evalKey = (key: ReloadHandKey): V3 => {
          if (key[1] === "home") return supportL
          const [, sp, x, y, z] = key
          return at(sp === "gun" ? gunF : sp === "torso" ? torso : pelvis, x, y, z)
        }
        handL = lerp3(evalKey(k0), evalKey(k1), u)
        gripBlend = 1
      } else {
        const [unarmedL] = unarmedHands(
          {
            gait,
            motion: { run: runBlend, crouch: { x: crouchT * 0.09 }, arms: this.arms, hands: this.hands } as never,
          },
          torso,
          time * 2,
        )
        const guardL = at(torso, 0.20, RIG.shoulderY - 0.30, -0.17)
        const lowReadyL = lerp3(guardL, unarmedL, clamp(gait * 1.15, 0, 1))
        handL = lerp3(lowReadyL, supportL, gripBlend)
      }

      if ((p.shoveAnim ?? 0) > 0) {
        const shoveU = Math.sin(clamp((p.shoveAnim ?? 0) / 0.28, 0, 1) * Math.PI)
        handL = lerp3(handL, at(torso, 0.48, RIG.shoulderY - 0.04, -0.10), shoveU)
      }

      if (gripBlend >= 0.999) {
        arms = poseArms(torso, handL, handR)
      } else {
        const armedArms = poseArms(torso, handL, handR)
        const shL = at(torso, 0, RIG.shoulderY, -RIG.shoulderW)
        const dWorld = sub(handL, shL)
        const dx = dot(dWorld, torso.x)
        const dy = dot(dWorld, torso.y)
        const lift = clamp((dy + 0.35) / 0.45, 0, 1)
        const back = clamp((-dx + 0.10) / 0.35, 0, 1)
        const freePole = dirIn(torso, -0.95 - 0.25 * lift, -0.55 + 0.70 * back, -(0.24 + 0.14 * lift))
        const aimPole = dirIn(torso, -0.15, -1, -1.1)
        const poleL = lerp3(freePole, aimPole, gripBlend)
        const [eL, hL] = ik(shL, handL, RIG.upper, RIG.fore, poleL)
        const uaL = limb(shL, eL, torso.x, torso.y)
        const faL = limb(eL, hL, lerp3(torso.x, [0, 1, 0], gripBlend), lerp3(torso.y, torso.x, gripBlend))
        arms = {
          ua: [uaL, armedArms.ua[1]],
          fa: [faL, armedArms.fa[1]],
        }
      }

      if (reloadClipT !== null && reloadClipT >= 0.28 && reloadClipT < 0.64) {
        this.mag = moved(gunF, at(arms.fa[0], 0, -RIG.fore - 0.01, 0))
      } else {
        this.mag = null
      }
    } else {
      this.gun = null
      this.mag = null
      const rawHands = profile && profileHands(torso, profile)
      let hands = rawHands
      if (rawHands && profile?.handPose === "reach") {
        hands = shambleHandsFK(torso, this.phase, gait, runBlend, profile, 0)
      }
      const unarmed = poseUnarmedArms(
        torso,
        ...unarmedHands(
          {
            gait,
            motion: { run: runBlend, crouch: { x: crouchT * 0.09 }, arms: this.arms, hands: this.hands } as never,
          },
          torso,
          time * 2,
        ),
      )
      arms = hands ? (profile?.handPose === "reach" ? poseUnarmedArms(torso, ...hands) : poseArms(torso, ...hands)) : unarmed
    }

    this.prevSupportY = curSupportY
    if (this.gun) {
      this.light.p = at(this.gun, 0.15, -0.025, 0)
      this.light.d = [this.gun.x[0], this.gun.x[1], this.gun.x[2]]
      this.light.mounted = true
    } else {
      this.light.p = at(arms.fa[1]!, 0, -RIG.fore - 0.04, 0)
      this.light.d = [Math.cos(p.aim), 0, Math.sin(p.aim)]
      this.light.mounted = false
    }
    this.bones = { pelvis, torso, head }
    ;(this.bones as BonePose & { gun?: Frame | null }).gun = this.gun
    this.batches.length = 0
    let index = 0
    const push: PushPart = (model, x, y, z, yaw, tint, pitchAng, rollAng, flash, alpha = 1) => {
      const data = this.data.subarray(index * 12, ++index * 12)
      data.set([x, y, z, yaw, ...tint, 1, pitchAng, rollAng, alpha, flash])
      this.batches.push({ model, data, count: 1 })
    }
    const draw = (id: number, frame: ReturnType<typeof yawFrame>) => emit(push, this.models[id]!, frame, [1, 1, 1], 0)
    draw(0, pelvis)
    draw(1, torso)
    draw(2, head)
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1
      const foot = this.feet[i]!
      const hip = at(pelvis, 0, 0, side * RIG.hipW)
      const u = foot.planted ? 0 : foot.prevU
      const sinU = Math.sin(Math.PI * u)
      const lateTaper = 1 - smooth((u - 0.74) / 0.18)
      const kickBell = sinU * sinU * (0.42 + 0.92 * Math.pow(u, 0.80)) * lateTaper
      const tuckBell = sinU * sinU * Math.pow(u, 0.95) * 1.65 * lateTaper
      const clearance = (i === 1 ? 1 - (profile?.footDrag ?? 0) : 1) * foot.stepLift
      const crouchKickScale = 1 - 0.55 * crouchT
      const heelKick = foot.planted ? 0 : (0.018 * (1 - runBlend) + 0.22 * runBlend * crouchKickScale) * clearance * kickBell
      const heelTuck =
        foot.planted ? 0 : (0.025 * (1 - runBlend) + 0.24 * runBlend * (1 - 0.35 * crouchT)) * clearance * tuckBell
      const fc = Math.cos(foot.yaw)
      const fs = Math.sin(foot.yaw)
      const ankle: V3 = [foot.p[0] - fc * heelTuck, foot.p[1] + RIG.ankle + heelKick, foot.p[2] - fs * heelTuck]
      const chordX =
        (ankle[0] - hip[0]) * pelvis.x[0] + (ankle[1] - hip[1]) * pelvis.x[1] + (ankle[2] - hip[2]) * pelvis.x[2]
      const backKick = runBlend * kickBell * clamp(-chordX / 0.35, 0, 1)
      const pole = dirIn(pelvis, 1, 0.28 - 0.65 * backKick, side * (0.25 - 0.17 * runBlend * kickBell))
      const [knee, end] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
      const thigh = limb(hip, knee, pole, pelvis.x)
      const shin = limb(knee, end, pole, pelvis.x)
      // Terrain-conforming boot pitch in stance + plantarflexed push-off and dorsiflexed recovery in swing.
      const groundSlope = clamp(
        (support(foot.p[0] + fc * 0.12, foot.p[2] + fs * 0.12) -
          support(foot.p[0] - fc * 0.08, foot.p[2] - fs * 0.08)) /
          0.20,
        -0.45,
        0.45,
      )
      const footPhase = (this.phase + i * (0.5 + (profile?.timingBias ?? 0) * 0.25)) % 1
      const dutyNow = curGait.duty
      const stanceFrac = foot.planted ? clamp(footPhase / Math.max(0.1, dutyNow), 0, 1) : 0
      const stancePitch = groundSlope - (0.18 + 0.06 * runBlend) * smooth((stanceFrac - 0.58) / 0.42) * gait
      const shinPitch = -Math.atan2(shin.y[0] * fc + shin.y[2] * fs, shin.y[1])
      const swingRel =
        -(0.20 + 0.15 * runBlend) * (1 - smooth((u - 0.50) / 0.34)) +
        (0.04 + 0.16 * runBlend) * smooth((u - 0.60) / 0.28)
      const footPitch = foot.planted
        ? stancePitch
        : stancePitch + (shinPitch + swingRel - stancePitch) * smooth(u / 0.10) * (1 - smooth((u - 0.78) / 0.18))
      let boot = pitch(yawFrame(end, foot.yaw), footPitch)
      if (foot.planted) {
        const toeWorld: V3 = [foot.p[0] + fc * 0.19, foot.p[1], foot.p[2] + fs * 0.19]
        const f0 = pitch(yawFrame([0, 0, 0], foot.yaw), stancePitch)
        const off = at(f0, 0.19, -RIG.ankle, 0)
        boot = { ...f0, p: [toeWorld[0] - off[0], toeWorld[1] - off[1], toeWorld[2] - off[2]] }
      }
      const name = i === 0 ? "left" : "right"
      this.bones[`${name}.thigh`] = thigh
      this.bones[`${name}.shin`] = shin
      this.bones[`${name}.foot`] = boot
      draw(5, thigh)
      draw(6, shin)
      draw(7, boot)
      const upper = arms.ua[i]!
      const fore = arms.fa[i]!
      this.bones[`${name}.upperArm`] = upper
      this.bones[`${name}.foreArm`] = fore
      draw(3, upper)
      draw(4, fore)
    }
    if (this.gun) draw(8, this.gun)
    if (this.mag) draw(9, this.mag)
    return this.batches
  }
}
