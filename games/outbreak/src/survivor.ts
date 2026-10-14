import { Mesh, MAT } from "@arcade/kit/gpu/mesh"
import { Renderer, type Batch } from "@arcade/kit/gpu/renderer"
import { RIG, HIP, at, clamp, dirIn, emit, ik, limb, pitch, roll, spring, stepSpring, smoother, yawFrame, type V3, type PushPart } from "@arcade/kit/rig"
import { angleSpring } from "@arcade/kit/human-locomotion"
import { profileHands, profileTorso, type HumanProfile } from "@arcade/kit/human-profile"
import { poseArms, type BonePose } from "@arcade/kit/human-pose"
import { angleDiff } from "@arcade/kit/sim/geom"
import type { Survivor as Pose } from "../shared/session"
import { hex } from "./level"

/** Blackout's joint pivots and planted-foot gait, with civilian meshes and no weapon clips. */
export class Survivor {
  /** Optional presentation override; does not change the Session's player or movement. */
  profile?: HumanProfile
  bones: BonePose = {}
  private chest = spring()
  private head = spring()
  private reachDrop = spring()
  private twist = spring()
  private arms = [spring(), spring()] as const
  private hands = [spring(), spring()] as const
  private models: number[]
  private feet = [-1, 1].map(() => ({ p: [0, 0, 0] as V3, lift: [0, 0, 0] as V3, target: [0, 0, 0] as V3, prevU: 0, planted: true, yaw: 0 }))
  private phase = 0
  private yaw = 0
  private last: [number, number] = [Infinity, Infinity]
  private svx = 0
  private svy = 0
  private leanX = spring()
  private leanY = spring()
  private data = new Float32Array(15 * 12)
  readonly batches: Batch[] = []

  constructor(renderer: Pick<Renderer, "addModel">) {
    const box = (w: number, y0: number, h: number, d: number, color: number) => {
      const m = new Mesh(); m.box(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, hex(color), MAT.actor); return m
    }
    const pelvis = box(.25, -.07, .18, .34, 0x41474b)
    const torso = box(.28, -.02, .48, .4, 0x8c6b42)
    torso.box(-.29, .07, -.15, -.14, .4, .15, hex(0x4d6259), MAT.actor)
    torso.box(-.3, .28, -.14, -.28, .32, .14, hex(0xa3a48a), MAT.actor)
    const head = box(.18, .01, .24, .18, 0xad8266)
    head.box(-.1, .19, -.11, .1, .28, .11, hex(0x3b342d), MAT.actor)
    const foot = box(.21, -.075, .09, .14, 0x3b3029)
    this.models = [pelvis, torso, head, box(.15, -.29, .33, .15, 0x8c6b42), box(.11, -.28, .3, .11, 0x9b7858), box(.17, -.42, .46, .17, 0x41474b), box(.13, -.41, .43, .14, 0x41474b), foot].map(m => renderer.addModel(m))
  }

  reset(): void {
    this.last = [Infinity, Infinity]
    this.phase = this.yaw = this.svx = this.svy = 0
    this.leanX = spring(); this.leanY = spring(); this.reachDrop = spring(); this.twist = spring()
    this.arms[0].x = this.arms[0].v = this.arms[1].x = this.arms[1].v = 0
    this.hands[0].x = this.hands[0].v = this.hands[1].x = this.hands[1].v = 0
    this.chest = spring(); this.head = spring(); this.bones = {}
  }

  draw(p: Pose, dt: number, time: number, support: (x:number,z:number)=>number): Batch[] {
    dt = Math.max(.0001, Math.min(.2, dt))
    const prevX = this.last[0], prevY = this.last[1]
    const teleport = Math.hypot(p.x - prevX, p.y - prevY) > 2.5
    this.last = [p.x, p.y]
    if (teleport) {
      this.yaw = p.aim; this.svx = p.vx; this.svy = p.vy; this.phase = 0
      this.chest = { x: p.aim, v: 0 }; this.head = { x: p.aim, v: 0 }; this.reachDrop = spring(); this.twist = spring()
      this.arms[0].x = this.arms[0].v = this.arms[1].x = this.arms[1].v = 0
      this.hands[0].x = this.hands[0].v = this.hands[1].x = this.hands[1].v = 0
    }
    const profile = this.profile
    const steps = teleport ? 1 : Math.max(1, Math.ceil(dt / (1 / 60) - 1e-4))
    const h = dt / steps
    let moving = 0
    for (let step = 1; step <= steps; step++) {
      const uStep = step / steps
      const sx = teleport ? p.x : prevX + (p.x - prevX) * uStep
      const sy = teleport ? p.y : prevY + (p.y - prevY) * uStep
      const k = 1 - Math.exp(-h * 14)
      const vx = this.svx + (p.vx - this.svx) * k, vy = this.svy + (p.vy - this.svy) * k
      stepSpring(this.leanX, 90, .38, h, vx * .035 + (vx - this.svx) / h * .003)
      stepSpring(this.leanY, 90, .38, h, vy * .035 + (vy - this.svy) / h * .003)
      this.svx = vx; this.svy = vy
      const speed = Math.hypot(vx, vy)
      moving = Math.min(1, speed / 3.4)
      let travel = speed > .35 ? Math.atan2(vy, vx) : p.aim
      if (Math.abs(angleDiff(travel, p.aim)) > 2.05) travel += Math.PI
      const want = p.aim + Math.max(-1.05, Math.min(1.05, angleDiff(travel, p.aim)))
      this.yaw += angleDiff(want, this.yaw) * Math.min(1, h * 9)
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw)
      const rest = (i: number): V3 => { const x=sx-s*(i?.13:-.13),z=sy+c*(i?.13:-.13); return [x,support(x,z),z] }
      if (teleport && step === 1) this.feet.forEach((f, i) => { f.p = rest(i); f.lift = [...f.p]; f.target = [...f.p]; f.prevU = 0; f.planted = true; f.yaw = this.yaw })
      const needsStep = this.feet.some((f, i) => Math.hypot(f.p[0] - rest(i)[0], f.p[2] - rest(i)[2]) > .2 || !f.planted)
      const rate = Math.max(speed / ((.7 + .22 * speed) * (profile?.strideScale ?? 1)), needsStep ? 1.7 : 0)
      this.phase = (this.phase + rate * h) % 1
      const duty = .62 - .22 * moving
      this.feet.forEach((f, i) => {
        const phase = (this.phase + i * (.5 + (profile?.timingBias ?? 0) * .25)) % 1
        if (rate > 0 && phase >= duty) {
          const u = (phase - duty) / (1 - duty), e = smoother(u)
          if (f.planted) { f.planted = false; f.lift = [...f.p]; f.prevU = 0 }
          const lead = Math.min(.32, (1 - phase) / rate + duty / rate * .5)
          const target = rest(i)
          target[0] += vx * lead; target[2] += vy * lead
          // Preserve Blackout's minimum side-step separation.
          const other = this.feet[1 - i]!, side = i ? 1 : -1
          const lat = (-(target[0] - other.p[0]) * s + (target[2] - other.p[2]) * c) * side
          if (lat < .16) { target[0] -= s * side * (.16 - lat); target[2] += c * side * (.16 - lat) }
          target[1]=support(target[0],target[2])
          const ep = smoother(f.prevU)
          if (ep > 0 && ep < .95) {
            const curX = f.lift[0] + (f.target[0] - f.lift[0]) * ep
            const curY = f.lift[1] + (f.target[1] - f.lift[1]) * ep
            const curZ = f.lift[2] + (f.target[2] - f.lift[2]) * ep
            f.lift = [(curX - target[0] * ep) / (1 - ep), (curY - target[1] * ep) / (1 - ep), (curZ - target[2] * ep) / (1 - ep)]
          }
          f.target = target; f.prevU = u
          const clearance = i === 1 ? 1 - (profile?.footDrag ?? 0) : 1
          // Mid-swing terrain clearance boost & floor guard (Lamplight arachnid/mod.rs & walk.rs:1419, 1446)
          const midY = support((f.lift[0] + target[0]) * .5, (f.lift[2] + target[2]) * .5)
          const boost = Math.max(0, midY - Math.max(f.lift[1], target[1]))
          const px = f.lift[0] + (target[0] - f.lift[0]) * e, pz = f.lift[2] + (target[2] - f.lift[2]) * e
          const py = Math.max(support(px, pz), f.lift[1] + (target[1] - f.lift[1]) * e + Math.sin(Math.PI * u) * ((.06 + .09 * moving) * clearance + boost))
          f.p = [px, py, pz]
          f.yaw += angleDiff(this.yaw, f.yaw) * e
        } else if (!f.planted) { f.planted = true; f.prevU = 0; f.p[1] = support(f.p[0],f.p[2]) }
      })
      // Anticipatory support floor: blend root support with foot landing/planted heights (Lamplight arachnid/mod.rs:502)
      const footSupport = (this.feet[0]!.p[1] + this.feet[1]!.p[1]) * .5
      const supportY = support(sx, sy) * .65 + footSupport * .35
      const baseHeight = supportY + HIP - .05 * moving - .035 * moving * Math.cos(this.phase * Math.PI * 4)
      let desiredDrop = 0
      for (const f of this.feet) {
        const distance = Math.min(.72, Math.hypot(f.p[0] - sx, f.p[2] - sy))
        const reachY = Math.sqrt(Math.max(0, .815 ** 2 - distance ** 2)) + RIG.ankle + f.p[1]
        desiredDrop = Math.max(desiredDrop, Math.max(0, Math.min(.18, baseHeight - reachY)))
      }
      stepSpring(this.reachDrop, 140, .85, h, desiredDrop)
      const fdx = this.feet[1]!.p[0] - this.feet[0]!.p[0], fdz = this.feet[1]!.p[2] - this.feet[0]!.p[2]
      const footFwd = fdx * c + fdz * s
      stepSpring(this.twist, 160, .85, h, clamp(footFwd * .32, -.17, .17) * (profile?.twistScale ?? 1.2))
      const armAmp = (.24 + .10 * moving) * (profile?.armSwing ?? 1) * moving
      const footNorm = clamp(footFwd / .42, -1, 1)
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1
        stepSpring(this.arms[i]!, 220, .85, h, -side * footNorm * armAmp)
        stepSpring(this.hands[i]!, 150, .78, h, this.arms[i]!.x)
      }
    }
    const footSupport = (this.feet[0]!.p[1] + this.feet[1]!.p[1]) * .5
    const height = (support(p.x,p.y) * .65 + footSupport * .35) + HIP - .05 * moving - .035 * moving * Math.cos(this.phase * Math.PI * 4) - this.reachDrop.x
    const pelvis = roll(yawFrame([p.x, height, p.y], this.yaw + this.twist.x), Math.cos(this.phase * Math.PI * 2) * (.07 + .03 * (profile?.hipDrop ?? 0)) * moving)
    const ca = Math.cos(p.aim), sa = Math.sin(p.aim)
    const lean = this.leanX.x * ca + this.leanY.x * sa
    const sideLean = (-this.leanX.x * sa + this.leanY.x * ca) * (profile?.turnBank ?? 1)
    if (profile) { angleSpring(this.chest, p.aim - this.twist.x * .65, profile.chestHz, dt); angleSpring(this.head, p.aim, profile.headHz, dt) }
    const torsoYaw = profile ? this.chest.x : p.aim - this.twist.x * .65
    let torso = roll(pitch(yawFrame(at(pelvis, 0, RIG.waist, 0), torsoYaw), -.05 - lean - .14 * moving * (profile?.runPosture ?? .18)), sideLean * .75)
    if (profile) torso = profileTorso(torso, profile)
    let head = pitch(yawFrame(at(torso, .02, RIG.neckY, 0), profile ? this.head.x : p.aim), lean * .35 * (profile?.headStability ?? .75))
    if (profile) head = roll(head, profile.headTilt)
    const rawHands = profile && profileHands(torso, profile)
    let hands = rawHands
    if (rawHands && profile?.handPose === "reach" && moving > 0) {
      const th = this.phase * Math.PI * 2
      const lurch = Math.sin(th) * .055 * moving, claw = Math.cos(th) * .035 * moving
      hands = [
        [rawHands[0][0] + torso.x[0] * lurch, rawHands[0][1] + claw, rawHands[0][2] + torso.x[2] * lurch],
        [rawHands[1][0] - torso.x[0] * lurch * .7, rawHands[1][1] - claw * .8, rawHands[1][2] - torso.x[2] * lurch * .7],
      ]
    }
    const arms = hands ? poseArms(torso, ...hands) : null
    this.bones = { pelvis, torso, head }
    this.batches.length = 0
    let index = 0
    const push: PushPart = (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) => {
      const data = this.data.subarray(index * 12, ++index * 12)
      data.set([x, y, z, yaw, ...tint, 1, pitch, roll, alpha, flash])
      this.batches.push({ model, data, count: 1 })
    }
    const draw = (id: number, frame: ReturnType<typeof yawFrame>) => emit(push, this.models[id]!, frame, [1, 1, 1], 0)
    draw(0, pelvis); draw(1, torso); draw(2, head)
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1, foot = this.feet[i]!
      const hip = at(pelvis, 0, 0, side * RIG.hipW)
      const ankle: V3 = [foot.p[0], foot.p[1] + RIG.ankle, foot.p[2]]
      const pole = dirIn(pelvis, 1, .28, side * .25)
      const [knee, end] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
      const thigh = limb(hip, knee, pole, pelvis.x), shin = limb(knee, end, pole, pelvis.x), boot = yawFrame(end, foot.yaw)
      const name = i === 0 ? "left" : "right"
      this.bones[`${name}.thigh`] = thigh; this.bones[`${name}.shin`] = shin; this.bones[`${name}.foot`] = boot
      draw(5, thigh); draw(6, shin); draw(7, boot)
      const shoulder = at(torso, 0, RIG.shoulderY, side * RIG.shoulderW)
      const sw = this.arms[i]!.x, hw = this.hands[i]!.x
      const fwd = .05 + (hw >= 0 ? hw * 1.15 : hw * .92) + .06 * moving
      const up = -.09 + (sw >= 0 ? sw * (.36 + .24 * moving) : -sw * .12) + .04 * moving - side * .015 * Math.sin(time * 2)
      const inward = Math.max(0, sw) * (.12 + .08 * moving)
      const hand = at(torso, fwd, up, side * (.23 - inward))
      const [elbow, wrist] = ik(shoulder, hand, RIG.upper, RIG.fore, dirIn(torso, -.65, -1, side * .18))
      const upper = arms?.ua[i] ?? limb(shoulder, elbow, torso.x, torso.y), fore = arms?.fa[i] ?? limb(elbow, wrist, torso.x, torso.y)
      this.bones[`${name}.upperArm`] = upper; this.bones[`${name}.foreArm`] = fore
      draw(3, upper); draw(4, fore)
    }
    return this.batches
  }
}
