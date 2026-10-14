import { Mesh, MAT } from "@arcade/kit/gpu/mesh"
import { Renderer, type Batch } from "@arcade/kit/gpu/renderer"
import { RIG, HIP, at, clamp, dirIn, emit, ik, limb, pitch, roll, smooth, spring, stepSpring, smoother, yawFrame, type V3, type PushPart } from "@arcade/kit/rig"
import { angleSpring, gaitAt, stepHash } from "@arcade/kit/human-locomotion"
import { humanProfiles, profileHands, profileTorso, type HumanProfile } from "@arcade/kit/human-profile"
import { poseArms, poseUnarmedArms, unarmedHands, type BonePose } from "@arcade/kit/human-pose"
import { angleDiff } from "@arcade/kit/sim/geom"
import type { Survivor as Pose } from "../shared/session"
import { hex } from "./level"

/** Blackout's joint pivots and planted-foot gait, with civilian meshes and no weapon clips. */
export class Survivor {
  /** Optional presentation override; does not change the Session's player or movement. */
  profile?: HumanProfile
  seed = 17
  bones: BonePose = {}
  private chest = spring()
  private head = spring()
  private reachDrop = spring()
  private twist = spring()
  private arms = [spring(), spring()] as const
  private hands = [spring(), spring()] as const
  private models: number[]
  private feet = [-1, 1].map(() => ({ p: [0, 0, 0] as V3, lift: [0, 0, 0] as V3, target: [0, 0, 0] as V3, prevU: 0, planted: true, yaw: 0, stepReach: 1, stepLat: 0, stepLift: 1, stepToe: 0 }))
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

  /** `palette` recolours the jacket and trousers (co-op seats); the default is the offline survivor. */
  constructor(renderer: Pick<Renderer, "addModel">, palette: { torso: number; legs: number } = { torso: 0x8c6b42, legs: 0x41474b }) {
    const box = (w: number, y0: number, h: number, d: number, color: number) => {
      const m = new Mesh(); m.box(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, hex(color), MAT.actor); return m
    }
    const pelvis = box(.25, -.07, .18, .34, palette.legs)
    const torso = box(.28, -.02, .48, .4, palette.torso)
    torso.box(-.29, .07, -.15, -.14, .4, .15, hex(0x4d6259), MAT.actor)
    torso.box(-.3, .28, -.14, -.28, .32, .14, hex(0xa3a48a), MAT.actor)
    const head = box(.18, .01, .24, .18, 0xad8266)
    head.box(-.1, .19, -.11, .1, .28, .11, hex(0x3b342d), MAT.actor)
    const foot = box(.21, -.075, .09, .14, 0x3b3029)
    this.models = [pelvis, torso, head, box(.15, -.29, .33, .15, palette.torso), box(.11, -.28, .3, .11, 0x9b7858), box(.17, -.42, .46, .17, palette.legs), box(.13, -.41, .43, .14, palette.legs), foot].map(m => renderer.addModel(m))
  }

  reset(): void {
    this.last = [Infinity, Infinity]
    this.phase = this.yaw = this.svx = this.svy = this.stepCount = 0
    this.leanX = spring(); this.leanY = spring(); this.reachDrop = spring(); this.twist = spring()
    this.arms[0].x = this.arms[0].v = this.arms[1].x = this.arms[1].v = 0
    this.hands[0].x = this.hands[0].v = this.hands[1].x = this.hands[1].v = 0
    this.chest = spring(); this.head = spring(); this.bones = {}
  }

  draw(p: Pick<Pose, "x" | "y" | "vx" | "vy" | "aim">, dt: number, time: number, support: (x:number,z:number)=>number): Batch[] {
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
      const speed = Math.hypot(vx, vy)
      moving = Math.min(1, speed / 3.4)
      const activeProfile = profile ?? humanProfiles.soldier
      const curGait = gaitAt(speed, false, 0, activeProfile)
      const runBlend = curGait.run
      const leanScale = 0.25 + 0.75 * runBlend
      stepSpring(this.leanX, 90, .38, h, vx * .028 * leanScale + (vx - this.svx) / h * .003)
      stepSpring(this.leanY, 90, .38, h, vy * .028 * leanScale + (vy - this.svy) / h * .003)
      this.svx = vx; this.svy = vy
      let travel = speed > .35 ? Math.atan2(vy, vx) : p.aim
      if (Math.abs(angleDiff(travel, p.aim)) > 2.05) travel += Math.PI
      const want = p.aim + Math.max(-1.05, Math.min(1.05, angleDiff(travel, p.aim)))
      this.yaw += angleDiff(want, this.yaw) * Math.min(1, h * 9)
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw)
      const rest = (i: number): V3 => { const x=sx-s*(i?.145:-.145),z=sy+c*(i?.145:-.145); return [x,support(x,z),z] }
      if (teleport && step === 1) this.feet.forEach((f, i) => { f.p = rest(i); f.lift = [...f.p]; f.target = [...f.p]; f.prevU = 0; f.planted = true; f.yaw = this.yaw })
      const needsStep = this.feet.some((f, i) => Math.hypot(f.p[0] - rest(i)[0], f.p[2] - rest(i)[2]) > .2 || !f.planted)
      const rate = speed > .2 ? Math.max(.85, speed / curGait.stride) : (needsStep ? 1.7 : 0)
      this.phase = (this.phase + rate * h) % 1
      const duty = curGait.duty
      this.feet.forEach((f, i) => {
        const phase = (this.phase + i * (.5 + (profile?.timingBias ?? 0) * .25)) % 1
        if (rate > 0 && phase >= duty) {
          const u = (phase - duty) / (1 - duty), e = smoother(u)
          const firstSwingFrame = f.planted
          if (f.planted) {
            f.planted = false; f.lift = [...f.p]; f.prevU = 0
            const sc = ++this.stepCount
            const varAmt = clamp(profile?.stepVariation ?? .35, 0, 1)
            const blue = 0.65 * stepHash(this.seed, sc, 1) - 0.55 * stepHash(this.seed, sc - 2, 1)
            f.stepReach = 1 + varAmt * .065 * blue
            f.stepLat = varAmt * .016 * stepHash(this.seed, sc, 2)
            f.stepLift = 1 + varAmt * .15 * stepHash(this.seed, sc, 3)
            f.stepToe = varAmt * .06 * stepHash(this.seed, sc, 4)
          }
          if (firstSwingFrame || u < .75) {
            const lead = Math.min(.34, (1 - phase) / rate + duty / rate * .48) * f.stepReach
            const target = rest(i)
            target[0] += vx * lead - s * f.stepLat; target[2] += vy * lead + c * f.stepLat
            // Preserve Blackout's minimum side-step separation.
            const other = this.feet[1 - i]!, side = i ? 1 : -1
            const lat = (-(target[0] - other.p[0]) * s + (target[2] - other.p[2]) * c) * side
            if (lat < .16) { target[0] -= s * side * (.16 - lat); target[2] += c * side * (.16 - lat) }
            target[1] = support(target[0], target[2])
            const ep = smoother(f.prevU)
            if (!firstSwingFrame && ep > 0 && ep < .95) {
              const curX = f.lift[0] + (f.target[0] - f.lift[0]) * ep
              const curY = f.lift[1] + (f.target[1] - f.lift[1]) * ep
              const curZ = f.lift[2] + (f.target[2] - f.lift[2]) * ep
              f.lift = [(curX - target[0] * ep) / (1 - ep), (curY - target[1] * ep) / (1 - ep), (curZ - target[2] * ep) / (1 - ep)]
            }
            f.target = target
          }
          f.prevU = u
          const target = f.target
          const clearance = (i === 1 ? 1 - (profile?.footDrag ?? 0) : 1) * f.stepLift
          // Mid-swing terrain clearance boost & floor guard (Lamplight arachnid/mod.rs & walk.rs:1419, 1446)
          const midY = support((f.lift[0] + target[0]) * .5, (f.lift[2] + target[2]) * .5)
          const boost = Math.max(0, midY - Math.max(f.lift[1], target[1]))
          const px = f.lift[0] + (target[0] - f.lift[0]) * e, pz = f.lift[2] + (target[2] - f.lift[2]) * e
          const liftBell = 1.72 * Math.sin(Math.PI * u) ** 2 * (1 - u)
          const py = Math.max(support(px, pz), f.lift[1] + (target[1] - f.lift[1]) * e + liftBell * ((.085 + .125 * runBlend) * clearance + boost))
          f.p = [px, py, pz]
          f.yaw += angleDiff(this.yaw + f.stepToe, f.yaw) * e
        } else if (!f.planted) { f.planted = true; f.prevU = 0; f.p[1] = support(f.p[0],f.p[2]) }
      })
      // Anticipatory support floor: blend root terrain support with foot terrain heights (never airborne swing height).
      const footSupport = (support(this.feet[0]!.p[0], this.feet[0]!.p[2]) + support(this.feet[1]!.p[0], this.feet[1]!.p[2])) * .5
      const supportY = support(sx, sy) * .65 + footSupport * .35
      const bobPhase = this.phase * Math.PI * 4 + (1 - runBlend) * 1.15
      const baseHeight = supportY + HIP - .012 * moving - (.021 + .008 * runBlend) * moving * Math.sin(bobPhase)
      let desiredDrop = 0
      for (const f of this.feet) {
        const distance = Math.min(.72, Math.hypot(f.p[0] - sx, f.p[2] - sy))
        const reachY = Math.sqrt(Math.max(0, .825 ** 2 - distance ** 2)) + RIG.ankle + f.p[1]
        desiredDrop = Math.max(desiredDrop, Math.max(0, Math.min(.18, baseHeight - reachY)))
      }
      stepSpring(this.reachDrop, 140, .85, h, desiredDrop)
      const fdx = this.feet[1]!.p[0] - this.feet[0]!.p[0], fdz = this.feet[1]!.p[2] - this.feet[0]!.p[2]
      const footFwd = fdx * c + fdz * s
      stepSpring(this.twist, 160, .85, h, clamp(footFwd * .32, -.17, .17) * (profile?.twistScale ?? 1.2))
      const gait = smooth((speed - .15) / .35)
      const footNorm = clamp(footFwd / Math.max(.35, curGait.stride * .44), -1, 1)
      const armLead = .22 + 1.06 * runBlend
      const phaseArm = -Math.cos(this.phase * Math.PI * 2 + armLead) * gait
      const armSignal = speed > .2 ? footNorm * .25 + phaseArm * .75 : footNorm
      const armAmp = (.16 + .22 * runBlend) * (profile?.armSwing ?? 1) * gait
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1
        stepSpring(this.arms[i]!, 2400, .85, h, -side * armSignal * armAmp)
        stepSpring(this.hands[i]!, 1600, .82, h, this.arms[i]!.x)
      }
    }
    const curSpeed = Math.hypot(this.svx, this.svy)
    const gait = smooth((curSpeed - .15) / .35)
    const curGait = gaitAt(curSpeed, false, 0, profile ?? humanProfiles.soldier)
    const runBlend = curGait.run
    const footSupport = (support(this.feet[0]!.p[0], this.feet[0]!.p[2]) + support(this.feet[1]!.p[0], this.feet[1]!.p[2])) * .5
    const bobPhase = this.phase * Math.PI * 4 + (1 - runBlend) * 1.15
    const height = (support(p.x,p.y) * .65 + footSupport * .35) + HIP - (.008 + .022 * runBlend) * gait - (.021 + .008 * runBlend) * gait * Math.sin(bobPhase) - this.reachDrop.x
    const pelvis = roll(yawFrame([p.x, height, p.y], this.yaw + this.twist.x), Math.cos(this.phase * Math.PI * 2) * (.07 + .03 * (profile?.hipDrop ?? 0)) * moving)
    const ca = Math.cos(p.aim), sa = Math.sin(p.aim)
    const lean = this.leanX.x * ca + this.leanY.x * sa
    const sideLean = (-this.leanX.x * sa + this.leanY.x * ca) * (profile?.turnBank ?? 1)
    if (profile) { angleSpring(this.chest, p.aim - this.twist.x * .65, profile.chestHz, dt); angleSpring(this.head, p.aim, profile.headHz, dt) }
    const torsoYaw = profile ? this.chest.x : p.aim - this.twist.x * .65
    let torso = roll(pitch(yawFrame(at(pelvis, 0, RIG.waist, 0), torsoYaw), -.05 - lean - .14 * runBlend * (profile?.runPosture ?? .18)), sideLean * .75)
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
    const unarmed = poseUnarmedArms(
      torso,
      ...unarmedHands({ gait, motion: { run: runBlend, arms: this.arms, hands: this.hands } }, torso, time * 2),
    )
    const arms = hands ? poseArms(torso, ...hands) : unarmed
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
      const u = foot.planted ? 0 : foot.prevU
      const sinU = Math.sin(Math.PI * u)
      const lateTaper = 1 - smooth((u - .74) / .18)
      const kickBell = sinU * sinU * (.42 + .92 * Math.pow(u, .80)) * lateTaper
      const tuckBell = sinU * sinU * Math.pow(u, .95) * 1.65 * lateTaper
      const clearance = (i === 1 ? 1 - (profile?.footDrag ?? 0) : 1) * foot.stepLift
      const heelKick = foot.planted ? 0 : (.018 * (1 - runBlend) + .22 * runBlend) * clearance * kickBell
      const heelTuck = foot.planted ? 0 : (.025 * (1 - runBlend) + .24 * runBlend) * clearance * tuckBell
      const fc = Math.cos(foot.yaw), fs = Math.sin(foot.yaw)
      const ankle: V3 = [foot.p[0] - fc * heelTuck, foot.p[1] + RIG.ankle + heelKick, foot.p[2] - fs * heelTuck]
      const chordX = (ankle[0] - hip[0]) * pelvis.x[0] + (ankle[1] - hip[1]) * pelvis.x[1] + (ankle[2] - hip[2]) * pelvis.x[2]
      const backKick = runBlend * kickBell * clamp(-chordX / .35, 0, 1)
      const pole = dirIn(pelvis, 1, .28 - .65 * backKick, side * (.25 - .17 * runBlend * kickBell))
      const [knee, end] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
      const thigh = limb(hip, knee, pole, pelvis.x), shin = limb(knee, end, pole, pelvis.x)
      // Terrain-conforming boot pitch in stance + plantarflexed push-off and dorsiflexed recovery in swing.
      const groundSlope = clamp((support(foot.p[0] + fc * .12, foot.p[2] + fs * .12) - support(foot.p[0] - fc * .08, foot.p[2] - fs * .08)) / .20, -.45, .45)
      const footPhase = (this.phase + i * (.5 + (profile?.timingBias ?? 0) * .25)) % 1
      const dutyNow = curGait.duty
      const stanceFrac = foot.planted ? clamp(footPhase / Math.max(.1, dutyNow), 0, 1) : 0
      const stancePitch = groundSlope - (.18 + .06 * runBlend) * smooth((stanceFrac - .58) / .42) * gait
      const shinPitch = -Math.atan2(shin.y[0] * fc + shin.y[2] * fs, shin.y[1])
      const swingRel = -(.20 + .15 * runBlend) * (1 - smooth((u - .50) / .34)) + (.04 + .16 * runBlend) * smooth((u - .60) / .28)
      const footPitch = foot.planted ? stancePitch : stancePitch + (shinPitch + swingRel - stancePitch) * smooth(u / .10) * (1 - smooth((u - .78) / .18))
      const boot = pitch(yawFrame(end, foot.yaw), footPitch)
      const name = i === 0 ? "left" : "right"
      this.bones[`${name}.thigh`] = thigh; this.bones[`${name}.shin`] = shin; this.bones[`${name}.foot`] = boot
      draw(5, thigh); draw(6, shin); draw(7, boot)
      const upper = arms.ua[i]!, fore = arms.fa[i]!
      this.bones[`${name}.upperArm`] = upper; this.bones[`${name}.foreArm`] = fore
      draw(3, upper); draw(4, fore)
    }
    return this.batches
  }
}
