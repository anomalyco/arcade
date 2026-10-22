// Poses a cast member on the shared rig and writes the skinned mesh (LOD0 or LOD1) as OBJ + MTL, for close
// inspection in Blender (scripts/people/pose-render.py):
//   bun scripts/people/pose-obj.ts <cast-id> <out-dir> [--lod 0|1] [--speed 1.4] [--frames 30,45] [--torch]
// Each frame is <out-dir>/<cast-id>-<frame>.obj in world space (metres, y up), materials by piece with their albedo.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { animate, newAvatar } from "../../packages/kit/avatar/anim"
import { readPerson } from "../../packages/kit/people/asset"
import { newPose, personRest, posePerson, RELAXED, skinMatrices, TORCH_GRIP, torchCarry, type HandPose } from "../../packages/kit/people/retarget"
import { terrainFeet } from "../../packages/kit/people/terrain"
import { spring, type V3 } from "../../packages/kit/rig"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const [id = "a-woods", out = "captures/people/pose"] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"))
const lodIndex = Number(arg("--lod", "0")), speed = Number(arg("--speed", "1.4"))
const frames = arg("--frames", "60").split(",").map(Number)
const torch = process.argv.includes("--torch")
// --hand '{"index":[30,45,20],...}': overrides merged into RELAXED (or TORCH_GRIP when held) instead of the solved grip.
const handOver = JSON.parse(arg("--hand", "{}")) as Partial<HandPose>
const tag = arg("--tag", "")
mkdirSync(out, { recursive: true })

await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
const asset = readPerson(await io.read(new URL(`../../packages/kit/people/assets/${id}.glb`, import.meta.url).pathname), id)
const rest = personRest(asset.skeleton)
const lod = asset.lods[lodIndex]!
const src = new Float32Array(lod.source), srcU = new Uint32Array(lod.source)
const SF = lod.source.byteLength / 4 / lod.vertices
const mats = new Float32Array(asset.skeleton.names.length * 16)

const mtl = asset.materials.map((m, i) => {
  const c = m.color.slice(0, 3).map((x) => Math.min(1, x * m.mean))
  return `newmtl m${i}_${m.piece}\nKd ${c.join(" ")}\nNs 10\n`
}).join("\n")
writeFileSync(join(out, `${id}.mtl`), mtl + "\nnewmtl torch\nKd 0.05 0.05 0.05\nNs 10\n")

const s = rest.scale, a = newAvatar("pose", 0, 0, 0, "rifle")
a.unarmed = true
const pose = newPose(rest), terrain = { drop: spring(), init: false }
const dt = 1 / 60
const beam: V3 = [Math.cos(-0.25), Math.sin(-0.25), 0]
const last = Math.max(...frames)
for (let f = 0, x = 0; f <= last; f++, x += speed * dt) {
  if (torch) a.reach = { r: process.argv.includes("--old-carry") ? [0.4, 0.12, 0.17] : torchCarry(-0.25), k: 1 }
  animate(a, dt, f * dt, x / s, 0, speed / s, 0, 0)
  const tf = terrainFeet(terrain, a, a.body!, s, () => 0, dt, rest.sole)
  posePerson(rest, { body: a.body!, ...tf, torch: torch ? { side: 1, dir: beam } : undefined, grip: Object.keys(handOver).length ? [{ ...RELAXED, ...handOver }, { ...(torch ? TORCH_GRIP : RELAXED), ...handOver }] : undefined, breath: 1, breathPhase: f * dt * 1.6 }, pose)
  if (!frames.includes(f)) continue
  skinMatrices(rest, pose, mats)
  const v: string[] = [], vn: string[] = [], body: string[] = [`mtllib ${id}.mtl`]
  for (let i = 0; i < lod.vertices; i++) {
    const o = i * SF
    const p = [0, 0, 0], n = [0, 0, 0]
    for (let k = 0; k < 4; k++) {
      const w = src[o + 8 + k]!
      if (!w) continue
      const m = ((srcU[o + 3]! >>> (8 * k)) & 255) * 16
      for (let r = 0; r < 3; r++) {
        p[r] += w * (mats[m + r]! * src[o]! + mats[m + 4 + r]! * src[o + 1]! + mats[m + 8 + r]! * src[o + 2]! + mats[m + 12 + r]!)
        n[r] += w * (mats[m + r]! * src[o + 4]! + mats[m + 4 + r]! * src[o + 5]! + mats[m + 8 + r]! * src[o + 6]!)
      }
    }
    v.push(`v ${p.map((x) => x.toFixed(5)).join(" ")}`)
    vn.push(`vn ${n.map((x) => x.toFixed(4)).join(" ")}`)
  }
  // The held torch: a 36 mm × 200 mm barrel along the torch frame, centred on the grip.
  if (pose.torch) {
    const t = pose.torch, base = v.length + 1, seg = 16
    for (let e = 0; e < 2; e++) for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2, c = Math.cos(a) * 0.018, sn = Math.sin(a) * 0.018, u = (e - 0.35) * 0.2
      v.push(`v ${[0, 1, 2].map((r) => (t.p[r]! + t.x[r]! * u + t.y[r]! * c + t.z[r]! * sn).toFixed(5)).join(" ")}`)
      vn.push(`vn ${[0, 1, 2].map((r) => (t.y[r]! * Math.cos(a) + t.z[r]! * Math.sin(a)).toFixed(4)).join(" ")}`)
    }
    body.push("usemtl torch")
    for (let k = 0; k < seg; k++) {
      const a = base + k, b = base + ((k + 1) % seg)
      body.push(`f ${a}//${a} ${b}//${b} ${b + seg}//${b + seg} ${a + seg}//${a + seg}`)
    }
  }
  for (const r of lod.ranges) {
    body.push(`usemtl m${r.material}_${asset.materials[r.material]!.piece}`)
    for (let t = r.start; t < r.start + r.count; t += 3) {
      const [i0, i1, i2] = [lod.indices[t]! + 1, lod.indices[t + 1]! + 1, lod.indices[t + 2]! + 1]
      body.push(`f ${i0}//${i0} ${i1}//${i1} ${i2}//${i2}`)
    }
  }
  writeFileSync(join(out, `${id}-${f}${tag}.obj`), [...body.slice(0, 1), ...v, ...vn, ...body.slice(1)].join("\n"))
  const bone = (n: string) => pose.pos[rest.idx[n]!]!
  console.log(JSON.stringify({ frame: f, hand_l: bone("hand_l").map((x) => +x.toFixed(3)), hand_r: bone("hand_r").map((x) => +x.toFixed(3)), pelvis: bone("pelvis").map((x) => +x.toFixed(3)) }))
}
