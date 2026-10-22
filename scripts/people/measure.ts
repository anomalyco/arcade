// Mesh-side metrics for the realistic people on the shared rig (the rig's own gait numbers come from
// games/blackout/scripts/animation/gait-metrics.ts; the people layer does not change them):
//   bun scripts/people/measure.ts [cast-id]
// Planted-ball slip (flat walk), foot sink/float over rolling ground with a 30 cm log, swing-foot clearance over the
// log, torch-to-beam angle and CPU pose cost per person-frame.
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { animate, newAvatar } from "../../packages/kit/avatar/anim"
import { readPerson } from "../../packages/kit/people/asset"
import { newPose, personRest, posePerson, skinMatrices } from "../../packages/kit/people/retarget"
import { terrainFeet } from "../../packages/kit/people/terrain"
import { spring, type V3 } from "../../packages/kit/rig"
import { qRot } from "../../packages/kit/people/quat"
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

const id = process.argv[2] ?? "a-woods"
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
const asset = readPerson(await io.read(new URL(`../../packages/kit/people/assets/${id}.glb`, import.meta.url).pathname), id)
const rest = personRest(asset.skeleton)
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const bone = (n: string) => rest.idx[n]!
const mats = new Float32Array(asset.skeleton.names.length * 16)

function walk(seconds: number, speed: number, ground: (x: number, z: number) => number, each: (pose: ReturnType<typeof newPose>, a: ReturnType<typeof newAvatar>, t: number) => void, torch?: V3) {
  const s = rest.scale, a = newAvatar("measure", 0, 0, 0, "rifle")
  a.unarmed = true
  const pose = newPose(rest), terrain = { drop: spring(), init: false }
  const dt = 1 / 60
  let ms = 0
  for (let f = 0, x = 0; f < seconds * 60; f++, x += speed * dt) {
    animate(a, dt, f * dt, x / s, 0, speed / s, 0, 0)
    const t0 = performance.now()
    const { lift, feet, tilt } = terrainFeet(terrain, a, a.body!, s, ground, dt, rest.sole)
    posePerson(rest, { body: a.body!, lift, feet, tilt, torch: torch ? { side: 1, dir: torch } : undefined, breath: 1, breathPhase: f * dt * 1.6 }, pose)
    skinMatrices(rest, pose, mats)
    ms += performance.now() - t0
    each(pose, a, f * dt)
  }
  return ms / (seconds * 60)
}

const slips: number[] = []
const last: (V3 | null)[] = [null, null], lastPitch = [1, 1]
const flatMs = walk(6, 1.4, () => 0, (pose, a, t) => {
  for (let k = 0; k < 2; k++) {
    const ball = pose.pos[bone(k === 0 ? "ball_l" : "ball_r")]!
    const pitch = a.body!.ft[k]!.x[1]
    if (t > 1 && a.feet[k]!.planted && pitch < 0.002 && lastPitch[k]! < 0.002 && last[k]) slips.push(dist(ball, last[k]!))
    last[k] = a.feet[k]!.planted ? [...ball] : null
    lastPitch[k] = pitch
  }
})

const log = (x: number) => (Math.abs(x - 2) < 0.15 ? Math.sqrt(0.15 ** 2 - (x - 2) ** 2) * 2 : 0)
const ground = (x: number, z: number) => 0.08 * Math.sin(x * 0.9) + 0.05 * Math.sin(z * 1.3 + 1) + log(x)
let sink = 0, float = 0, clearance = Infinity
let worst: unknown = null, worstFloat: unknown = null
// The boot's sole under the ball and under the heel (mesh points), and the gap to the ground under each.
const soleGaps = (pose: ReturnType<typeof newPose>, k: number) => {
  const foot = bone(k === 0 ? "foot_l" : "foot_r"), ball = pose.pos[bone(k === 0 ? "ball_l" : "ball_r")]!
  const heel = add(pose.pos[foot]!, qRot(pose.rot[foot]!, rest.heel[k]!))
  const ballSole: V3 = [ball[0], ball[1] - rest.ballHeight, ball[2]]
  return [ballSole, heel].map((p) => p[1] - ground(p[0], p[2]))
}
walk(4, 1.2, ground, (pose, a) => {
  for (let k = 0; k < 2; k++) {
    const gaps = soleGaps(pose, k)
    if (-Math.min(...gaps) > sink) { sink = -Math.min(...gaps); worst = { planted: a.feet[k]!.planted, pitch: a.body!.ft[k]!.x[1], gaps, x: pose.pos[bone(k === 0 ? "ball_l" : "ball_r")]![0] } }
    // A flat planted boot (not heel strike or toe-off) touches the ground at its lowest sole point.
    const flat = a.feet[k]!.planted && Math.abs(a.body!.ft[k]!.x[1]) < 0.02
    if (flat && Math.min(...gaps) > float) { float = Math.min(...gaps); worstFloat = { gaps, x: pose.pos[bone(k === 0 ? "ball_l" : "ball_r")]![0], heelX: pose.pos[bone(k === 0 ? "foot_l" : "foot_r")]![0] } }
    else if (!a.feet[k]!.planted) {
      const ball = pose.pos[bone(k === 0 ? "ball_l" : "ball_r")]!
      if (Math.abs(ball[0] - 2) < 0.25) clearance = Math.min(clearance, Math.min(...gaps))
    }
  }
})

const beam: V3 = [Math.cos(-0.25), Math.sin(-0.25), 0]
let torchDeg = 0
walk(3, 1.4, () => 0, (pose) => {
  const x = pose.torch!.x
  torchDeg = Math.max(torchDeg, (Math.acos(Math.min(1, x[0] * beam[0] + x[1] * beam[1] + x[2] * beam[2])) * 180) / Math.PI)
}, beam)

slips.sort((a, b) => a - b)
const mm = (x: number) => Math.round(x * 10000) / 10
console.log(JSON.stringify({
  cast: id, joints: asset.skeleton.names.length, height: Math.round(rest.height * 1000) / 1000, rigScale: Math.round(rest.scale * 1000) / 1000,
  tris: asset.lods.map((l) => l.triangles),
  plantedBallSlipMm: { mean: mm(slips.reduce((s, x) => s + x, 0) / slips.length), p95: mm(slips[Math.floor(slips.length * 0.95)]!), max: mm(slips.at(-1)!) },
  logWalkMm: { worstSink: mm(sink), worstPlantedFloat: mm(float), minSwingGapNearLog: mm(clearance) },
  worstSinkAt: worst,
  worstFloatAt: worstFloat,
  torchToBeamMaxDeg: Math.round(torchDeg * 10) / 10,
  cpuPoseMsPerPerson: Math.round(flatMs * 1000) / 1000,
}, null, 2))
