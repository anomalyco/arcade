// One gait cycle of a cast member three ways, as OBJ sequences for scripts/people/walk-compare.sh: the procedural
// rig (`animate`), the mocap gait people ship with (`gaitBody`, as `People.drive` runs it), and the mocap's own
// joints as a stick figure (the reference).
//   bun scripts/people/walk-compare.ts <cast-id> <out-dir> [--speed 1.9] [--take cmu:07_12 | 100style:Neutral_FW] [--fps 30]
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { animate, newAvatar } from "../../packages/kit/avatar/anim"
import { readPerson } from "../../packages/kit/people/asset"
import { gaitBody, newGait } from "../../packages/kit/people/gait"
import { newPose, personRest, posePerson, skinMatrices, type PersonPose } from "../../packages/kit/people/retarget"
import { terrainFeet } from "../../packages/kit/people/terrain"
import { spring } from "../../packages/kit/rig"
import { findSteadyWindow, load100Style, loadCmu, normaliseClip, parse100Style, parseCmu } from "../../games/blackout/scripts/animation/open-mocap"
import type { V3 } from "../../packages/kit/rig"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const [id = "a-woods", out = "captures/people/walk"] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"))
const speed = Number(arg("--speed", "1.9")), take = arg("--take", "cmu:07_12"), fps = Number(arg("--fps", "30"))
mkdirSync(out, { recursive: true })

await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
const asset = readPerson(await io.read(new URL(`../../packages/kit/people/assets/${id}.glb`, import.meta.url).pathname), id)
const rest = personRest(asset.skeleton), s = rest.scale
const lod = asset.lods[0]!
const src = new Float32Array(lod.source), srcU = new Uint32Array(lod.source)
const SF = lod.source.byteLength / 4 / lod.vertices
const mats = new Float32Array(asset.skeleton.names.length * 16)

// The mocap: a steady window at this speed, cut into one cycle (left foot forward peak to the next), in place.
const [source, trial] = take.split(":") as [string, string]
const raw = source === "cmu" ? parseCmu(await loadCmu(trial)) : parse100Style(await load100Style(trial))
const win = raw.frames.length * raw.dt > 2 ? findSteadyWindow(raw, speed, Math.min(2.5, raw.frames.length * raw.dt * 0.8)) : { start: 0, end: raw.frames.length, speed: 0 }
const norm = normaliseClip(raw, win.start, win.end)
const f = norm.frames
const lead = f.map((p) => p.Foot_L![0] - p.Hips![0])
const peaks: number[] = []
for (let i = 2; i < lead.length - 2; i++) if ([-2, -1, 1, 2].every((d) => lead[i]! >= lead[i + d]!) && lead[i]! > 0.05 && (!peaks.length || i - peaks.at(-1)! >= 10)) peaks.push(i)
const cut = f.slice(peaks[0]!, peaks[1]!)
const minFootY = Math.min(...cut.map((p) => Math.min(p.Foot_L![1], p.Foot_R![1], p.Toes_L![1], p.Toes_R![1])))
const clipDur = cut.length * norm.dt
const clipSpeed = Math.hypot(f[peaks[1]!]!.Hips![0] - f[peaks[0]!]!.Hips![0], f[peaks[1]!]!.Hips![2] - f[peaks[0]!]!.Hips![2]) / clipDur
// The raw mocap (metres, its own proportions), in place, for the stick figure.
const rawCycle = cut.map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, [v[0] - p.Hips![0], v[1] - minFootY, v[2] - p.Hips![2]] as V3])))

const rate = speed / clipSpeed
const mtl = asset.materials.map((m, i) => `newmtl m${i}_${m.piece}\nKd ${m.color.slice(0, 3).map((x) => Math.min(1, x * m.mean)).join(" ")}\nNs 10\n`).join("\n")
writeFileSync(join(out, `${id}.mtl`), mtl + "\nnewmtl bone\nKd 0.9 0.55 0.15\nNs 10\n")

function writeMesh(path: string, pose: PersonPose, dx: number) {
  skinMatrices(rest, pose, mats)
  const v: string[] = [], body: string[] = [`mtllib ${id}.mtl`]
  for (let i = 0; i < lod.vertices; i++) {
    const o = i * SF, p = [0, 0, 0]
    for (let k = 0; k < 4; k++) {
      const w = src[o + 8 + k]!
      if (!w) continue
      const m = ((srcU[o + 3]! >>> (8 * k)) & 255) * 16
      for (let r = 0; r < 3; r++) p[r] += w * (mats[m + r]! * src[o]! + mats[m + 4 + r]! * src[o + 1]! + mats[m + 8 + r]! * src[o + 2]! + mats[m + 12 + r]!)
    }
    v.push(`v ${(p[0]! - dx).toFixed(4)} ${p[1]!.toFixed(4)} ${p[2]!.toFixed(4)}`)
  }
  for (const r of lod.ranges) {
    body.push(`usemtl m${r.material}_${asset.materials[r.material]!.piece}`)
    for (let t = r.start; t < r.start + r.count; t += 3) body.push(`f ${lod.indices[t]! + 1} ${lod.indices[t + 1]! + 1} ${lod.indices[t + 2]! + 1}`)
  }
  writeFileSync(path, [body[0], ...v, ...body.slice(1)].join("\n"))
}

const BONES: [string, string][] = [["Hips", "Chest"], ["Chest", "Neck"], ["Neck", "Head"], ["Head", "Head_End"],
  ...(["L", "R"] as const).flatMap((sd) => [[`UpperArm_${sd}`, `LowerArm_${sd}`], [`LowerArm_${sd}`, `Hand_${sd}`], [`Neck`, `UpperArm_${sd}`],
    [`Hips`, `UpperLeg_${sd}`], [`UpperLeg_${sd}`, `LowerLeg_${sd}`], [`LowerLeg_${sd}`, `Foot_${sd}`], [`Foot_${sd}`, `Toes_${sd}`]] as [string, string][])]
function writeSticks(path: string, j: Record<string, V3>) {
  const v: string[] = [], fc: string[] = [`mtllib ${id}.mtl`, "usemtl bone"]
  for (const [a, b] of BONES) {
    const p = j[a], q = j[b]
    if (!p || !q) continue
    const d: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], l = Math.hypot(...d)
    const up: V3 = Math.abs(d[1] / l) > 0.9 ? [1, 0, 0] : [0, 1, 0]
    const c1 = norm3(cross3(d, up)), c2 = norm3(cross3(d, c1)), r = 0.018, base = v.length + 1
    for (const e of [p, q]) for (let k = 0; k < 6; k++) {
      const a2 = (k / 6) * Math.PI * 2
      v.push(`v ${[0, 1, 2].map((i) => (e[i]! + (c1[i]! * Math.cos(a2) + c2[i]! * Math.sin(a2)) * r).toFixed(4)).join(" ")}`)
    }
    for (let k = 0; k < 6; k++) fc.push(`f ${base + k} ${base + ((k + 1) % 6)} ${base + 6 + ((k + 1) % 6)} ${base + 6 + k}`)
  }
  writeFileSync(path, [fc[0], ...v, ...fc.slice(1)].join("\n"))
}
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm3 = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

// Settle 2 s, then one cycle's worth of frames: the rig's body, and the mocap gait from the same avatar. Both drawn
// in place (the root subtracted); the reference at the gait's own phase.
const frames = Math.round((clipDur / rate) * fps)
const a = newAvatar("walk", 0, 0, 0, "rifle")
a.unarmed = true
const proc = newPose(rest), moc = newPose(rest), gait = newGait(), terrain = { drop: spring(), init: false }
const dt = 1 / 60
let x = 0, written = 0
for (let n = 0; written < frames; n++) {
  const t = n * dt
  x += speed * dt
  animate(a, dt, t, x / s, 0, speed / s, 0, 0)
  const g = gaitBody(gait, a, a.body!, s, dt)
  const tf = terrainFeet(terrain, g.loco, g.body, s, () => 0, dt, rest.sole)
  if (n < 120 || (n - 120) % Math.round(60 / fps)) continue
  posePerson(rest, { body: a.body!, lift: 0, breath: 1, breathPhase: t * 1.6 }, proc)
  writeMesh(join(out, `proc-${written}.obj`), proc, proc.pos[rest.idx.pelvis!]![0])
  posePerson(rest, { body: g.body, ...tf, breath: 1, breathPhase: t * 1.6 }, moc)
  writeMesh(join(out, `mocap-${written}.obj`), moc, moc.pos[rest.idx.pelvis!]![0])
  writeSticks(join(out, `ref-${written}.obj`), rawCycle[Math.floor(gait.phase * rawCycle.length) % rawCycle.length]!)
  written++
}
console.log(JSON.stringify({ take, window: win, clipSpeed: +clipSpeed.toFixed(2), clipDur: +clipDur.toFixed(3), rate: +rate.toFixed(3), frames }))
