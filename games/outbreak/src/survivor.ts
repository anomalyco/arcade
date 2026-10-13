import { Mesh, MAT } from "@arcade/kit/gpu/mesh"
import { Renderer, type Batch } from "@arcade/kit/gpu/renderer"
import { RIG, HIP, at, dirIn, emit, ik, limb, pitch, spring, stepSpring, smoother, yawFrame, type V3, type PushPart } from "@arcade/kit/rig"
import { angleDiff } from "@arcade/kit/sim/geom"
import type { Survivor as Pose } from "../shared/session"
import { hex } from "./level"

/** Blackout's joint pivots and planted-foot gait, with civilian meshes and no weapon clips. */
export class Survivor {
  private models: number[]
  private feet = [-1, 1].map(() => ({ p: [0, 0, 0] as V3, lift: [0, 0, 0] as V3, planted: true, yaw: 0 }))
  private phase = 0
  private yaw = 0
  private last: [number, number] = [Infinity, Infinity]
  private svx = 0
  private svy = 0
  private leanX = spring()
  private leanY = spring()
  private data = new Float32Array(15 * 12)
  readonly batches: Batch[] = []

  constructor(renderer: Renderer) {
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
    this.leanX = spring(); this.leanY = spring()
  }

  draw(p: Pose, dt: number, time: number): Batch[] {
    dt = Math.max(.0001, Math.min(.05, dt))
    const teleport = Math.hypot(p.x - this.last[0], p.y - this.last[1]) > 2.5
    this.last = [p.x, p.y]
    if (teleport) { this.yaw = p.aim; this.svx = p.vx; this.svy = p.vy; this.phase = 0 }
    const k = 1 - Math.exp(-dt * 14)
    const vx = this.svx + (p.vx - this.svx) * k, vy = this.svy + (p.vy - this.svy) * k
    stepSpring(this.leanX, 90, .38, dt, vx * .035 + (vx - this.svx) / dt * .003)
    stepSpring(this.leanY, 90, .38, dt, vy * .035 + (vy - this.svy) / dt * .003)
    this.svx = vx; this.svy = vy
    const speed = Math.hypot(vx, vy), moving = Math.min(1, speed / 3.4)
    let travel = speed > .35 ? Math.atan2(vy, vx) : p.aim
    if (Math.abs(angleDiff(travel, p.aim)) > 2.05) travel += Math.PI
    const want = p.aim + Math.max(-1.05, Math.min(1.05, angleDiff(travel, p.aim)))
    this.yaw += angleDiff(want, this.yaw) * Math.min(1, dt * 9)
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw)
    const rest = (i: number): V3 => [p.x - s * (i ? .13 : -.13), 0, p.y + c * (i ? .13 : -.13)]
    if (teleport) this.feet.forEach((f, i) => { f.p = rest(i); f.lift = [...f.p]; f.planted = true; f.yaw = this.yaw })
    const needsStep = this.feet.some((f, i) => Math.hypot(f.p[0] - rest(i)[0], f.p[2] - rest(i)[2]) > .2 || !f.planted)
    const rate = Math.max(speed / (.7 + .22 * speed), needsStep ? 1.7 : 0)
    this.phase = (this.phase + rate * dt) % 1
    const duty = .62 - .22 * moving
    this.feet.forEach((f, i) => {
      const phase = (this.phase + i * .5) % 1
      if (rate > 0 && phase >= duty) {
        if (f.planted) { f.planted = false; f.lift = [...f.p] }
        const u = (phase - duty) / (1 - duty), e = smoother(u)
        const lead = (1 - phase) / rate + duty / rate * .5
        const target = rest(i)
        target[0] += vx * lead; target[2] += vy * lead
        // Preserve Blackout's minimum side-step separation.
        const other = this.feet[1 - i]!, side = i ? 1 : -1
        const lat = (-(target[0] - other.p[0]) * s + (target[2] - other.p[2]) * c) * side
        if (lat < .16) { target[0] -= s * side * (.16 - lat); target[2] += c * side * (.16 - lat) }
        f.p = [f.lift[0] + (target[0] - f.lift[0]) * e, Math.sin(Math.PI * u) * (.06 + .09 * moving), f.lift[2] + (target[2] - f.lift[2]) * e]
        f.yaw += angleDiff(this.yaw, f.yaw) * e
      } else if (!f.planted) { f.planted = true; f.p[1] = 0 }
    })
    let height = HIP - .05 * moving - .035 * moving * Math.cos(this.phase * Math.PI * 4)
    for (const f of this.feet) {
      const distance = Math.hypot(f.p[0] - p.x, f.p[2] - p.y)
      height = Math.min(height, Math.sqrt(Math.max(0, .815 ** 2 - distance ** 2)) + RIG.ankle + f.p[1])
    }
    const pelvis = yawFrame([p.x, height + .13, p.y], this.yaw)
    const lean = this.leanX.x * Math.cos(p.aim) + this.leanY.x * Math.sin(p.aim)
    const torso = pitch(yawFrame(at(pelvis, 0, RIG.waist, 0), p.aim), -.05 - lean)
    const head = yawFrame(at(torso, .02, RIG.neckY, 0), p.aim)
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
      const ankle: V3 = [foot.p[0], foot.p[1] + RIG.ankle + .13, foot.p[2]]
      const pole = dirIn(pelvis, 1, 0, side * .3)
      const [knee, end] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
      draw(5, limb(hip, knee, pole, pelvis.x)); draw(6, limb(knee, end, pole, pelvis.x)); draw(7, yawFrame(end, foot.yaw))
      const shoulder = at(torso, 0, RIG.shoulderY, side * RIG.shoulderW)
      const swing = Math.sin(this.phase * Math.PI * 2 + i * Math.PI) * .22 * moving
      const hand = at(torso, swing + .07, -.02 + .015 * Math.sin(time * 2), side * .24)
      const [elbow, wrist] = ik(shoulder, hand, RIG.upper, RIG.fore, dirIn(torso, -.4, -1, side))
      draw(3, limb(shoulder, elbow, torso.x, torso.y)); draw(4, limb(elbow, wrist, torso.x, torso.y))
    }
    return this.batches
  }
}
