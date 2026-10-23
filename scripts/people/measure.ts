// Mesh-side metrics for the realistic people on the shared rig (the rig's own gait numbers come from
// scripts/animation/gait-metrics.ts; the people layer does not change them):
//   bun scripts/people/measure.ts [cast-id]
// Planted-ball slip (flat walk), foot sink/float over rolling ground with a 30 cm log, swing-foot clearance over the
// log, torch-to-beam angle, CPU pose cost per person-frame, and the backpack's fit (rest gap, clipping in motion).
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

const mm = (x: number) => Math.round(x * 10000) / 10
// The backpack against the back: per pack vertex near the torso, its nearest torso vertex in bind pose (body and
// clothes under it, not the arms), then per frame the signed gap along that torso vertex's skinned normal. Negative
// is the pack inside the torso. Walk, run and the standing weight shift (both ways), breathing throughout.
const lod = asset.lods[0]!, src = new Float32Array(lod.source), srcU = new Uint32Array(lod.source)
const SF = lod.source.byteLength / 4 / lod.vertices
const byPiece = (keep: (piece: string) => boolean) => {
  const out = new Set<number>()
  for (const r of lod.ranges) if (keep(asset.materials[r.material]!.piece)) for (let i = r.start; i < r.start + r.count; i++) out.add(lod.indices[i]!)
  return [...out]
}
const NOT_TORSO = new Set(["backpack", "straps", "hair", "brows", "eyes", "eye", "headlamp", "lens", "headband", "beanie", "hood"])
const armJoint = (v: number) => {
  const j = srcU[v * SF + 3]! & 255
  return /arm|hand|thumb|index|middle|ring|pinky|thigh|calf|foot|ball/.test(asset.skeleton.names[j]!)
}
const packV = byPiece((p) => p === "backpack")
let packClip: unknown = null
if (packV.length) {
  const P = (v: number): V3 => [src[v * SF]!, src[v * SF + 1]!, src[v * SF + 2]!]
  const lo = [0, 1, 2].map((k) => Math.min(...packV.map((v) => P(v)[k]!))), hi = [0, 1, 2].map((k) => Math.max(...packV.map((v) => P(v)[k]!)))
  const torsoV = byPiece((p) => !NOT_TORSO.has(p)).filter((v) => {
    const q = P(v)
    return !armJoint(v) && q[0] > lo[0]! - 0.05 && q[0] < hi[0]! + 0.05 && q[1] > lo[1]! - 0.05 && q[1] < hi[1]! + 0.05 && q[2] > lo[2]! - 0.03
  })
  const pairs: [number, number][] = []
  const restGap: number[] = []
  for (const v of packV) {
    const q = P(v)
    let best = -1, bd = 0.06
    for (const t of torsoV) { const d = dist(q, P(t)); if (d < bd) { bd = d; best = t } }
    if (best < 0) continue
    pairs.push([v, best])
    // Back-panel vertices (facing the body: +Z in model space, the way the person faces) at rest: their gap to the
    // back along its normal.
    if (src[v * SF + 6]! > 0.5) {
      const q = P(best), n: V3 = [src[best * SF + 4]!, src[best * SF + 5]!, src[best * SF + 6]!]
      restGap.push(((P(v)[0] - q[0]) * n[0] + (P(v)[1] - q[1]) * n[1] + (P(v)[2] - q[2]) * n[2]) / (Math.hypot(...n) || 1))
    }
  }
  const skin = (v: number, w: boolean): V3 => {
    const o = v * SF, x = src[o + (w ? 4 : 0)]!, y = src[o + (w ? 5 : 1)]!, z = src[o + (w ? 6 : 2)]!, t = w ? 0 : 1
    const out: V3 = [0, 0, 0]
    for (let k = 0; k < 4; k++) {
      const wk = src[o + 8 + k]!
      if (!wk) continue
      const m = ((srcU[o + 3]! >>> (8 * k)) & 255) * 16
      out[0] += wk * (mats[m]! * x + mats[m + 4]! * y + mats[m + 8]! * z + mats[m + 12]! * t)
      out[1] += wk * (mats[m + 1]! * x + mats[m + 5]! * y + mats[m + 9]! * z + mats[m + 13]! * t)
      out[2] += wk * (mats[m + 2]! * x + mats[m + 6]! * y + mats[m + 10]! * z + mats[m + 14]! * t)
    }
    return out
  }
  const worst = { walk: Infinity, run: Infinity, idle: Infinity }
  const where: Record<string, unknown> = {}
  const check = (k: keyof typeof worst) => {
    for (const [v, t] of pairs) {
      const a = skin(v, false), b = skin(t, false), n = skin(t, true), nl = Math.hypot(...n) || 1
      const g = ((a[0] - b[0]) * n[0] + (a[1] - b[1]) * n[1] + (a[2] - b[2]) * n[2]) / nl
      if (g < worst[k]) { worst[k] = g; where[k] = { pack: P(v).map((x) => Math.round(x * 100) / 100), torso: asset.materials[lod.ranges.find((r) => [...lod.indices.subarray(r.start, r.start + r.count)].includes(t))!.material]!.piece } }
    }
  }
  walk(3, 1.4, () => 0, () => check("walk"))
  walk(2, 3.6, () => 0, () => check("run"))
  {
    const a = newAvatar("idle", 0, 0, 0, "rifle")
    a.unarmed = true
    const pose = newPose(rest)
    for (let f = 0; f < 60 * 8; f++) {
      animate(a, 1 / 60, f / 60, 0, 0, 0, 0, 0)
      posePerson(rest, { body: a.body!, lift: 0, breath: 1, breathPhase: f / 60 * 1.6, shift: Math.sin(f / 60 * 0.8) }, pose)
      skinMatrices(rest, pose, mats)
      if (f % 4 === 0) check("idle")
    }
  }
  restGap.sort((a, b) => a - b)
  packClip = {
    restBackPanelGapMm: { median: mm(restGap[Math.floor(restGap.length / 2)] ?? 0), p95: mm(restGap[Math.floor(restGap.length * 0.95)] ?? 0) },
    // Most negative gap seen (mm): below zero the pack is inside the torso.
    minGapMm: { walk: mm(worst.walk), run: mm(worst.run), idle: mm(worst.idle) },
    minGapAt: where,
    sizeCm: [0, 1, 2].map((k) => Math.round((hi[k]! - lo[k]!) * 100)),
  }
}

slips.sort((a, b) => a - b)
console.log(JSON.stringify({
  cast: id, joints: asset.skeleton.names.length, height: Math.round(rest.height * 1000) / 1000, rigScale: Math.round(rest.scale * 1000) / 1000,
  tris: asset.lods.map((l) => l.triangles),
  plantedBallSlipMm: { mean: mm(slips.reduce((s, x) => s + x, 0) / slips.length), p95: mm(slips[Math.floor(slips.length * 0.95)]!), max: mm(slips.at(-1)!) },
  logWalkMm: { worstSink: mm(sink), worstPlantedFloat: mm(float), minSwingGapNearLog: mm(clearance) },
  worstSinkAt: worst,
  worstFloatAt: worstFloat,
  torchToBeamMaxDeg: Math.round(torchDeg * 10) / 10,
  pack: packClip,
  cpuPoseMsPerPerson: Math.round(flatMs * 1000) / 1000,
}, null, 2))
