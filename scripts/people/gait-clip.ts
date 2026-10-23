// A cast member through the gait's hand-overs, as `People.drive` poses them: idle, a turn in place, walking off, a
// curve, a stop, a backpedal and a restart. Writes one OBJ per 1/30 s (pelvis-relative, for walk-render.py) and the
// largest frame-to-frame jump of a knee, ankle or ball relative to the pelvis (a pop shows as centimetres).
//   bun scripts/people/gait-clip.ts <cast-id> <out-dir> [--no-mesh]
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { animate, newAvatar } from "../../packages/kit/avatar/anim"
import { readPerson } from "../../packages/kit/people/asset"
import { gaitBody, newGait } from "../../packages/kit/people/gait"
import { newPose, personRest, posePerson, skinMatrices } from "../../packages/kit/people/retarget"
import { terrainFeet } from "../../packages/kit/people/terrain"
import { spring } from "../../packages/kit/rig"

const [id = "a-woods", out = "captures/people/gait"] = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const mesh = !process.argv.includes("--no-mesh")
mkdirSync(out, { recursive: true })
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
const asset = readPerson(await io.read(new URL(`../../packages/kit/people/assets/${id}.glb`, import.meta.url).pathname), id)
const rest = personRest(asset.skeleton), s = rest.scale, lod = asset.lods[0]!
const src = new Float32Array(lod.source), srcU = new Uint32Array(lod.source), SF = lod.source.byteLength / 4 / lod.vertices
const mats = new Float32Array(asset.skeleton.names.length * 16)
writeFileSync(join(out, `${id}.mtl`), asset.materials.map((m, i) => `newmtl m${i}\nKd ${m.color.slice(0, 3).map((x) => Math.min(1, x * m.mean)).join(" ")}\nNs 10\n`).join("\n"))

/** Speed (m/s), aim and travel direction (rad) over time. */
const scene = (t: number): { v: number; aim: number; dir: number; label: string } => {
  if (t < 1) return { v: 0, aim: 0, dir: 0, label: "idle" }
  if (t < 2) { const aim = Math.min(1, t - 1) * 1.2; return { v: 0, aim, dir: aim, label: "turn in place" } }
  if (t < 4) return { v: 1.9 * Math.min(1, (t - 2) / 0.5), aim: 1.2, dir: 1.2, label: "walk off" }
  if (t < 6) { const aim = 1.2 + (t - 4) * 0.6; return { v: 1.9, aim, dir: aim, label: "curve" } }
  if (t < 7) return { v: 1.9 * Math.max(0, 1 - (t - 6) / 0.5), aim: 2.4, dir: 2.4, label: "stop" }
  if (t < 8.5) return { v: 1.1 * Math.min(1, (t - 7) / 0.4), aim: 2.4, dir: 2.4 + Math.PI, label: "backpedal" }
  return { v: 1.9 * Math.min(1, (t - 8.5) / 0.5), aim: 2.4, dir: 2.4, label: "walk off" }
}

const a = newAvatar("clip", 0, 0, 0, "rifle")
a.unarmed = true
const pose = newPose(rest), terrain = { drop: spring(), init: false }, gait = newGait(), dt = 1 / 60
const watch = ["calf_l", "calf_r", "foot_l", "foot_r", "ball_l", "ball_r"].map((n) => rest.idx[n]!)
let x = 0, z = 0, written = 0, prev: number[][] | null = null
const worst = { jump: 0, at: 0, label: "" }, bySegment: Record<string, number> = {}
for (let f = 0; f < 60 * 10; f++) {
  const t = f * dt, m = scene(t)
  const vx = Math.cos(m.dir) * m.v, vz = Math.sin(m.dir) * m.v
  x += vx * dt; z += vz * dt
  animate(a, dt, t, x / s, z / s, vx / s, vz / s, m.aim)
  const { body, loco } = gaitBody(gait, a, a.body!, s, dt)
  posePerson(rest, { body, ...terrainFeet(terrain, loco, body, s, () => 0, dt, rest.sole) }, pose)
  const pel = pose.pos[rest.idx.pelvis!]!
  const rel = watch.map((i) => [pose.pos[i]![0] - pel[0], pose.pos[i]![1], pose.pos[i]![2] - pel[2]])
  if (prev && t > 0.2) for (let k = 0; k < rel.length; k++) {
    const d = Math.hypot(rel[k]![0]! - prev[k]![0]!, rel[k]![1]! - prev[k]![1]!, rel[k]![2]! - prev[k]![2]!)
    if (d > worst.jump) Object.assign(worst, { jump: d, at: +t.toFixed(2), label: m.label })
    bySegment[m.label] = Math.max(bySegment[m.label] ?? 0, +(d * 100).toFixed(1))
  }
  prev = rel
  if (f % 2 || !mesh) continue
  skinMatrices(rest, pose, mats)
  const v: string[] = []
  for (let i = 0; i < lod.vertices; i++) {
    const o = i * SF, p = [0, 0, 0]
    for (let k = 0; k < 4; k++) {
      const w = src[o + 8 + k]!
      if (!w) continue
      const mm = ((srcU[o + 3]! >>> (8 * k)) & 255) * 16
      for (let r = 0; r < 3; r++) p[r]! += w * (mats[mm + r]! * src[o]! + mats[mm + 4 + r]! * src[o + 1]! + mats[mm + 8 + r]! * src[o + 2]! + mats[mm + 12 + r]!)
    }
    v.push(`v ${(p[0]! - pel[0]).toFixed(4)} ${p[1]!.toFixed(4)} ${(p[2]! - pel[2]).toFixed(4)}`)
  }
  const fc: string[] = []
  for (const r of lod.ranges) {
    fc.push(`usemtl m${r.material}`)
    for (let t3 = r.start; t3 < r.start + r.count; t3 += 3) fc.push(`f ${lod.indices[t3]! + 1} ${lod.indices[t3 + 1]! + 1} ${lod.indices[t3 + 2]! + 1}`)
  }
  writeFileSync(join(out, `gait-${written++}.obj`), [`mtllib ${id}.mtl`, ...v, ...fc].join("\n"))
}
console.log(JSON.stringify({ frames: written, worstJumpCm: +(worst.jump * 100).toFixed(1), at: worst.at, during: worst.label, bySegmentCm: bySegment }))
