import { describe, expect, test } from "bun:test"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { animate, newAvatar } from "../avatar/anim"
import { spring, type V3 } from "../rig"
import { readPerson, SRC_FLOATS } from "./asset"
import { qRot } from "./quat"
import { gaitBody, newGait, type GaitState } from "./gait"
import type { HumanBody } from "../human-pose"
import { personHooks } from "./hooks"
import { newPose, personRest, posePerson, torchCarry, type PersonPose, type PersonRest } from "./retarget"
import type { TerrainLoco } from "./terrain"
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

test("the solved torch grip closes every finger on the barrel and the thumb over it", () => {
  const pose = newPose(rest)
  const a = newAvatar("grip", 0, 0, 0, "rifle")
  a.unarmed = true
  animate(a, 1 / 60, 0, 0, 0, 0, 0, 0)
  posePerson(rest, { body: a.body!, lift: 0, torch: { side: 1, dir: [1, -0.25, 0] } }, pose)
  const t = pose.torch!
  const off = (p: V3) => { const d: V3 = [p[0] - t.p[0], p[1] - t.p[1], p[2] - t.p[2]], u = d[0] * t.x[0] + d[1] * t.x[1] + d[2] * t.x[2]; return Math.hypot(d[0] - u * t.x[0], d[1] - u * t.x[1], d[2] - u * t.x[2]) }
  for (const f of ["index", "middle", "ring", "pinky", "thumb"]) {
    const j = [1, 2, 3].map((k) => pose.pos[at(rest, `${f}_0${k}_r`)]!)
    const tip: V3 = [0, 1, 2].map((k) => j[2]![k]! + (j[2]![k]! - j[1]![k]!) * 0.85) as V3
    // Finger centrelines one half-thickness outside an 18 mm barrel (never inside it), within 4 cm of its axis.
    for (const p of f === "thumb" ? [tip] : [j[1]!, j[2]!, tip]) {
      expect(off(p)).toBeGreaterThan(0.02)
      expect(off(p)).toBeLessThan(0.04)
    }
  }
})

test("a torch arm keeps its elbow bent wherever the beam points", () => {
  for (const [yaw, pitch] of [[0, -0.25], [0.5, 0], [-0.5, -0.5], [0.3, 0.4]] as const) {
    const ch = rest.arms[1]
    walk(2, 1.4, () => 0, (pose, a, t) => {
      a.reach = { r: torchCarry(pitch), k: 1 }
      if (t < 1) return
      const reach = dist(pose.pos[ch.end]!, pose.pos[ch.upper]!) / (ch.lu + ch.ll)
      expect(reach).toBeLessThan(0.87)
    }, [Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)])
  }
})

describe("mocap gait", () => {
  test("planted balls stay put walking, running and stopping", () => {
    for (const speedAt of [() => 1.9, () => 3.4, (t: number) => (t < 2 ? 1.9 : 0)]) {
      const s = rest.scale, a = newAvatar("gait", 0, 0, 0, "rifle")
      a.unarmed = true
      const pose = newPose(rest), terrain = { drop: spring(), init: false }, gait = newGait()
      const dt = 1 / 60, stance = [0, 0], prev: (V3 | null)[] = [null, null]
      let x = 0, worst = 0
      for (let f = 0; f < 60 * 4; f++) {
        const v = speedAt(f * dt)
        x += v * dt
        animate(a, dt, f * dt, x / s, 0, v / s, 0, 0)
        const { body, loco } = gaitBody(gait, a, a.body!, s, dt)
        posePerson(rest, { body, ...terrainFeet(terrain, loco, body, s, () => 0, dt, rest.sole) }, pose)
        if (f < 90) continue
        for (let k = 0; k < 2; k++) {
          const ball = pose.pos[at(rest, k ? "ball_r" : "ball_l")]!
          if (loco.feet[k].planted && prev[k]) stance[k]! += Math.hypot(ball[0] - prev[k]![0], ball[2] - prev[k]![2])
          if (!loco.feet[k].planted) stance[k] = 0
          prev[k] = loco.feet[k].planted ? [...ball] : null
          worst = Math.max(worst, stance[k]!)
        }
      }
      expect(worst).toBeLessThan(0.012)
    }
  })
})

// The six-person gait tests take about a second here; the timeout only keeps a loaded CI worker from failing them.
const CAST = await Promise.all(["a", "b", "c", "d", "e", "f"].map(async (id) => personRest(readPerson(await io.read(new URL(`./assets/${id}-woods.glb`, import.meta.url).pathname), `${id}-woods`).skeleton)))

type Move = { v: number; aim: number; dir?: number }
type Frame = { pose: PersonPose; loco: TerrainLoco; gait: GaitState; body: HumanBody; t: number; m: Move }
/** Drives a person the way `People.drive` does (mocap gait) through `scene(t)`: speed, aim and travel direction. */
function gaitRun(r: PersonRest, seconds: number, scene: (t: number) => Move, each: (f: Frame) => void) {
  const s = r.scale, a = newAvatar("gait", 0, 0, scene(0).aim, "rifle")
  a.unarmed = true
  const pose = newPose(r), terrain = { drop: spring(), init: false }, gait = newGait(), dt = 1 / 60
  let x = 0, z = 0
  for (let f = 0; f < seconds * 60; f++) {
    const t = f * dt, m = scene(t), dir = m.dir ?? m.aim
    const vx = Math.cos(dir) * m.v, vz = Math.sin(dir) * m.v
    x += vx * dt; z += vz * dt
    animate(a, dt, t, x / s, z / s, vx / s, vz / s, m.aim)
    const { body, loco } = gaitBody(gait, a, a.body!, s, dt)
    posePerson(r, { body, ...terrainFeet(terrain, loco, body, s, () => 0, dt, r.sole) }, pose)
    each({ pose, loco, gait, body, t, m })
  }
}
const startStop = (t: number): Move => ({ v: t % 3 < 1.5 ? 1.9 * Math.min(1, (t % 3) / 0.4) : 1.9 * Math.max(0, 1 - ((t % 3) - 1.5) / 0.4), aim: 0.7 })

describe("mocap gait, every woods cast member", () => {
  test("knees always bend forward through walk and run cycles, starts and stops", () => {
    const scenes: ((t: number) => Move)[] = [() => ({ v: 1.9, aim: 0.3 }), () => ({ v: 3.4, aim: -0.4 }), startStop, (t) => ({ v: 1.9, aim: t * 0.5 })]
    for (const r of CAST) for (const scene of scenes) {
      let worst = 0
      gaitRun(r, 6, scene, ({ pose, gait, t }) => {
        if (t < 0.5) return
        const fwd: V3 = [Math.cos(gait.yaw), 0, Math.sin(gait.yaw)]
        for (const ch of r.legs) {
          const hip = pose.pos[ch.upper]!, knee = pose.pos[ch.lower]!, ank = pose.pos[ch.end]!
          const d: V3 = [ank[0] - hip[0], ank[1] - hip[1], ank[2] - hip[2]], l = Math.hypot(...d)
          const u = ((knee[0] - hip[0]) * d[0] + (knee[1] - hip[1]) * d[1] + (knee[2] - hip[2]) * d[2]) / (l * l)
          const bend = [0, 1, 2].map((k) => knee[k]! - hip[k]! - d[k]! * u)
          worst = Math.min(worst, bend[0]! * fwd[0] + bend[2]! * fwd[2])
        }
      })
      // A knee behind the hip–ankle line by more than 5 mm has flipped.
      expect(worst).toBeGreaterThan(-0.005)
    }
  }, 60_000)

  test("the walk faces the rig's aim from idle, turning in place and backpedalling, so starting never whips the hips", () => {
    const r = CAST[0]!
    const scenes: ((t: number) => Move)[] = [
      // Spawned idle facing 1.2 rad, then walks off that way.
      (t) => ({ v: t < 1 ? 0 : 1.9, aim: 1.2 }),
      // Turns in place for a second, then walks off the new way.
      (t) => ({ v: t < 1.5 ? 0 : 1.9, aim: Math.min(1.5, t) * 1.4 }),
      // Backpedals, then walks forward.
      (t) => ({ v: t < 1.5 ? 1.2 : 1.9, aim: 0.5, dir: t < 1.5 ? 0.5 + Math.PI : 0.5 }),
    ]
    for (const scene of scenes) {
      let last: number | null = null, whip = 0, pinch = Infinity
      const hipW = (b: HumanBody) => Math.hypot(b.th[0].p[0] - b.th[1].p[0], b.th[0].p[2] - b.th[1].p[2])
      let ref = 0
      gaitRun(r, 3, scene, ({ body, t }) => {
        const yaw = Math.atan2(body.pelvis.x[2], body.pelvis.x[0])
        if (t < 0.1) { ref = hipW(body); last = yaw; return }
        whip = Math.max(whip, Math.abs(Math.atan2(Math.sin(yaw - last!), Math.cos(yaw - last!))))
        pinch = Math.min(pinch, hipW(body) / ref)
        last = yaw
      })
      // No more than 4° of pelvis yaw in one frame, and the hips never narrow by more than 12%.
      expect(whip).toBeLessThan(0.07)
      expect(pinch).toBeGreaterThan(0.88)
    }
  }, 60_000)

  test("a planted foot is on the ground walking and while the gait blends in and out", () => {
    for (const r of CAST) {
      let worst = 0
      gaitRun(r, 9, startStop, ({ pose, loco, t }) => {
        if (t < 0.5) return
        for (let k = 0; k < 2; k++) if (loco.feet[k].planted) {
          const ball = pose.pos[r.idx[k ? "ball_r" : "ball_l"]!]!, heel = pose.pos[r.idx[k ? "foot_r" : "foot_l"]!]!
          // The lower of ball and ankle over the ground, less its standing height.
          worst = Math.max(worst, Math.min(ball[1] - r.ballHeight, heel[1] - 0.09))
        }
      })
      // Was 4-8 cm where the rig and the cycle blend.
      expect(worst).toBeLessThan(0.025)
    }
  }, 60_000)
})

test("no knee or foot pops through standing, turning in place, walking off, a curve and a stop", () => {
  // As scripts/people/gait-clip.ts, without its rig-only backpedal.
  const scene = (t: number): Move => {
    if (t < 1) return { v: 0, aim: 0 }
    if (t < 2) return { v: 0, aim: Math.min(1, t - 1) * 1.2 }
    if (t < 4) return { v: 1.9 * Math.min(1, (t - 2) / 0.5), aim: 1.2 }
    if (t < 6) return { v: 1.9, aim: 1.2 + (t - 4) * 0.6 }
    return { v: 1.9 * Math.max(0, 1 - (t - 6) / 0.5), aim: 2.4 }
  }
  for (const r of CAST) {
    const watch = ["calf_l", "calf_r", "foot_l", "foot_r", "ball_l", "ball_r"].map((n) => r.idx[n]!)
    let prev: V3[] | null = null, worst = 0
    gaitRun(r, 7.5, scene, ({ pose, t }) => {
      const pel = pose.pos[r.idx.pelvis!]!
      const rel = watch.map((i): V3 => [pose.pos[i]![0] - pel[0], pose.pos[i]![1], pose.pos[i]![2] - pel[2]])
      if (prev && t > 0.2) for (let k = 0; k < rel.length; k++) worst = Math.max(worst, dist(rel[k]!, prev[k]!))
      prev = rel
    })
    // A swinging foot moves up to ~8 cm a frame relative to the hips at 1.9 m/s; the flips and hand-overs were 29-41.
    expect(worst).toBeLessThan(0.105)
  }
}, 60_000)

test("people keep a game's full direct light on their upright surfaces (no wall dimming)", () => {
  expect(personHooks({}).wallDirectScale).toBe("1.0")
  expect(personHooks({ wallDirectScale: "0.5" }).wallDirectScale).toBe("0.5")
})
