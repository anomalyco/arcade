import { describe, expect, test } from "bun:test"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { animate, newAvatar } from "../avatar/anim"
import { spring, type V3 } from "../rig"
import { readPerson, SRC_FLOATS } from "./asset"
import { qRot } from "./quat"
import { newPose, personRest, posePerson, type PersonRest } from "./retarget"
import { terrainFeet } from "./terrain"
import { idleShift, personLod } from "./view"

await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
const asset = readPerson(await io.read(new URL("./assets/a-woods.glb", import.meta.url).pathname), "a-woods")
const rest = personRest(asset.skeleton)
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const at = (r: PersonRest, n: string) => r.idx[n]!

/** Walks a person `seconds` at `speed` m/s over `ground`, calling `each` with the pose every frame. */
function walk(seconds: number, speed: number, ground: (x: number, z: number) => number, each: (pose: ReturnType<typeof newPose>, a: ReturnType<typeof newAvatar>, t: number) => void, torch?: V3, start: [number, number] = [0, 0]) {
  const s = rest.scale, a = newAvatar("test", start[0] / s, start[1] / s, 0, "rifle")
  a.unarmed = true
  const pose = newPose(rest), terrain = { drop: spring(), init: false }
  const dt = 1 / 60
  for (let f = 0, x = start[0]; f < seconds * 60; f++, x += speed * dt) {
    animate(a, dt, f * dt, x / s, start[1] / s, speed / s, 0, 0)
    const { lift, feet, tilt } = terrainFeet(terrain, a, a.body!, s, ground, dt, rest.sole)
    posePerson(rest, { body: a.body!, lift, feet, tilt, torch: torch ? { side: 1, dir: torch } : undefined }, pose)
    each(pose, a, f * dt)
  }
}

describe("people", () => {
  test("the cast GLB reads as a 53-bone skeleton with two LODs inside the triangle budget", () => {
    expect(asset.skeleton.names.length).toBe(53)
    expect(asset.lods.length).toBe(2)
    expect(asset.lods[0]!.triangles).toBeLessThan(32_000)
    expect(asset.lods[1]!.triangles).toBeLessThan(9_000)
    expect(rest.height).toBeGreaterThan(1.55)
    expect(rest.height).toBeLessThan(2.0)
    expect(rest.scale).toBeGreaterThan(0.9)
    expect(rest.scale).toBeLessThan(1.15)
  })

  test("bones keep their lengths and planted feet do not slide (flat walk)", () => {
    const lengths = rest.local.pos.map((p) => Math.hypot(...p))
    let worstLen = 0, worstSlip = 0
    const last: (V3 | null)[] = [null, null]
    const lastPitch = [1, 1]
    walk(4, 1.4, () => 0, (pose, a, t) => {
      for (let i = 0; i < pose.pos.length; i++) {
        const p = rest.skeleton.parent[i]!
        if (p < 0 || i === at(rest, "pelvis")) continue
        worstLen = Math.max(worstLen, Math.abs(dist(pose.pos[i]!, pose.pos[p]!) - lengths[i]!))
      }
      for (let k = 0; k < 2; k++) {
        const ball = pose.pos[at(rest, k === 0 ? "ball_l" : "ball_r")]!
        const pitch = a.body!.ft[k]!.x[1]
        if (t > 1 && a.feet[k]!.planted && pitch < 0.002 && lastPitch[k]! < 0.002 && last[k]) worstSlip = Math.max(worstSlip, dist(ball, last[k]!))
        last[k] = a.feet[k]!.planted ? [...ball] : null
        lastPitch[k] = pitch
      }
    })
    expect(worstLen).toBeLessThan(1e-4)
    // The ball of a flat planted foot stays put to well under a millimetre a frame.
    expect(worstSlip).toBeLessThan(0.002)
  })

  test("feet stand on the ground and step over a log instead of through it", () => {
    // A 0.3 m log across the path at x = 2, on rolling ground.
    const log = (x: number) => (Math.abs(x - 2) < 0.15 ? Math.sqrt(0.15 ** 2 - (x - 2) ** 2) * 2 : 0)
    const ground = (x: number, z: number) => 0.08 * Math.sin(x * 0.9) + 0.05 * Math.sin(z * 1.3 + 1) + log(x)
    let worstSink = 0, worstFloat = 0, swingGap = Infinity
    walk(4, 1.2, ground, (pose, a) => {
      for (let k = 0; k < 2; k++) {
        // The sole under the ball and under the heel (mesh points), and their gaps to the ground.
        const foot = at(rest, k === 0 ? "foot_l" : "foot_r"), ball = pose.pos[at(rest, k === 0 ? "ball_l" : "ball_r")]!
        const h = qRot(pose.rot[foot]!, rest.heel[k]!), heel: V3 = [pose.pos[foot]![0] + h[0], pose.pos[foot]![1] + h[1], pose.pos[foot]![2] + h[2]]
        const gaps = [[ball[0], ball[1] - rest.ballHeight, ball[2]] as V3, heel].map((p) => p[1] - ground(p[0], p[2]))
        worstSink = Math.max(worstSink, -Math.min(...gaps))
        if (a.feet[k]!.planted && Math.abs(a.body!.ft[k]!.x[1]) < 0.02) worstFloat = Math.max(worstFloat, Math.min(...gaps))
        if (!a.feet[k]!.planted && Math.abs(ball[0] - 2) < 0.25) swingGap = Math.min(swingGap, ...gaps)
      }
    })
    // Heel strikes on the slope press in about a centimetre; nothing goes through the log.
    expect(worstSink).toBeLessThan(0.02)
    // A flat planted boot touches the ground (or the log) somewhere along its sole.
    expect(worstFloat).toBeLessThan(0.005)
    expect(swingGap).toBeGreaterThan(0)
  })

  test("standing still, the weight shifts from leg to leg without moving the feet", () => {
    const idle = { still: 0, phase: 0, rate: 1 }
    const shifts: number[] = []
    for (let f = 0; f < 60 * 20; f++) shifts.push(idleShift(idle, 0, true, 1 / 60))
    expect(Math.max(...shifts)).toBeGreaterThan(0.9)
    expect(Math.min(...shifts)).toBeLessThan(-0.9)
    // A step eases it out within a quarter second.
    for (let f = 0; f < 15; f++) idleShift(idle, 1.2, false, 1 / 60)
    expect(Math.abs(idleShift(idle, 1.2, false, 1 / 60))).toBeLessThan(0.1)
    // Posed at full shift, planted balls stay put and the hips slide over the loaded leg.
    const a = newAvatar("idle", 0, 0, 0, "rifle")
    a.unarmed = true
    for (let f = 0; f < 120; f++) animate(a, 1 / 60, f / 60, 0, 0, 0, 0, 0)
    const still = newPose(rest), shifted = newPose(rest)
    posePerson(rest, { body: a.body!, lift: 0, shift: 0 }, still)
    posePerson(rest, { body: a.body!, lift: 0, shift: 1 }, shifted)
    for (const b of ["ball_l", "ball_r"]) expect(dist(shifted.pos[at(rest, b)]!, still.pos[at(rest, b)]!)).toBeLessThan(0.002)
    expect(dist(shifted.pos[at(rest, "pelvis")]!, still.pos[at(rest, "pelvis")]!)).toBeGreaterThan(0.025)
  })

  test("a torch points along its beam from the hand", () => {
    const beam: V3 = [Math.cos(-0.25), Math.sin(-0.25), 0]
    let worst = 0, reach = 0
    walk(2, 1.4, () => 0, (pose) => {
      const x = pose.torch!.x
      worst = Math.max(worst, Math.acos(Math.min(1, x[0] * beam[0] + x[1] * beam[1] + x[2] * beam[2])))
      reach = Math.max(reach, dist(pose.torch!.p, pose.pos[at(rest, "hand_r")]!))
    }, beam)
    expect(worst).toBeLessThan(0.15)
    expect(reach).toBeLessThan(0.15)
  })

  test("hand rest measures a barrel across the palm", () => {
    const hr = rest.hands[1]
    const along = qRot(rest.skeleton.bindRot[at(rest, "hand_r")]!, hr.barrel)
    expect(Math.hypot(...along)).toBeCloseTo(1, 5)
  })

  test("level of detail follows the person, not the skeleton root, far from the origin", () => {
    let pose: ReturnType<typeof newPose> | null = null
    walk(1, 1.4, () => 0, (p) => { pose = p }, undefined, [500, -300])
    const at500: V3 = [pose!.pos[at(rest, "pelvis")]![0] + 2, 1.6, -300]
    expect(personLod(rest, pose!, at500, 0, 9)).toBe(0)
    expect(personLod(rest, pose!, [0, 1.6, 0], 0, 9)).toBe(1)
    // Hysteresis: once far, it stays far until 10% inside the distance.
    expect(personLod(rest, pose!, [at500[0] + 8.5, 1.6, -300], 1, 9)).toBe(1)
  })

  test("every baked vertex has a finite position, a unit normal and weights summing to one", () => {
    let bad = 0
    for (const lod of asset.lods) {
      const f = new Float32Array(lod.source)
      for (let o = 0; o < f.length; o += SRC_FLOATS) {
        const nl = Math.hypot(f[o + 4]!, f[o + 5]!, f[o + 6]!), ws = f[o + 8]! + f[o + 9]! + f[o + 10]! + f[o + 11]!
        if (![f[o]!, f[o + 1]!, f[o + 2]!].every(Number.isFinite) || Math.abs(nl - 1) > 1e-3 || Math.abs(ws - 1) > 1e-3) bad++
      }
    }
    expect(bad).toBe(0)
  })
})
