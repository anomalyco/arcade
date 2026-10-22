import { describe, expect, test } from "bun:test"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { animate, newAvatar } from "../avatar/anim"
import { spring, type V3 } from "../rig"
import { readPerson } from "./asset"
import { qRot } from "./quat"
import { newPose, personRest, posePerson, type PersonRest } from "./retarget"
import { terrainFeet } from "./terrain"

await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
const asset = readPerson(await io.read(new URL("./assets/hiker-a.glb", import.meta.url).pathname), "hiker-a")
const rest = personRest(asset.skeleton)
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const at = (r: PersonRest, n: string) => r.idx[n]!

/** Walks a person `seconds` at `speed` m/s over `ground`, calling `each` with the pose every frame. */
function walk(seconds: number, speed: number, ground: (x: number, z: number) => number, each: (pose: ReturnType<typeof newPose>, a: ReturnType<typeof newAvatar>, t: number) => void, torch?: V3) {
  const s = rest.scale, a = newAvatar("test", 0, 0, 0, "rifle")
  a.unarmed = true
  const pose = newPose(rest), terrain = { drop: spring(), init: false }
  const dt = 1 / 60
  for (let f = 0, x = 0; f < seconds * 60; f++, x += speed * dt) {
    animate(a, dt, f * dt, x / s, 0, speed / s, 0, 0)
    const { lift, feet, tilt } = terrainFeet(terrain, a, a.body!, s, ground, dt)
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
    // A 0.3 m log across the path at x = 2.
    const log = (x: number) => (Math.abs(x - 2) < 0.15 ? Math.sqrt(0.15 ** 2 - (x - 2) ** 2) * 2 : 0)
    const ground = (x: number, z: number) => 0.08 * Math.sin(x * 0.9) + 0.05 * Math.sin(z * 1.3 + 1) + log(x)
    let worstSink = 0, worstFloat = 0
    walk(4, 1.2, ground, (pose, a) => {
      for (let k = 0; k < 2; k++) {
        const ball = pose.pos[at(rest, k === 0 ? "ball_l" : "ball_r")]!
        const foot = pose.pos[at(rest, k === 0 ? "foot_l" : "foot_r")]!
        const g = Math.max(ground(ball[0], ball[2]), ground(foot[0], foot[2]))
        // Bone origins sit inside the boot: ankle ~7 cm, ball ~1 cm above the sole.
        worstSink = Math.max(worstSink, g - Math.min(foot[1] - 0.06, ball[1]))
        if (a.feet[k]!.planted) worstFloat = Math.max(worstFloat, Math.min(ball[1], foot[1] - 0.06) - g)
      }
    })
    expect(worstSink).toBeLessThan(0.05)
    expect(worstFloat).toBeLessThan(0.06)
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
})
