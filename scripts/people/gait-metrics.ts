// Foot contact of a cast member walking the way `People.drive` poses them (mocap gait, or the rig with --rig), on a
// flat floor: planted ball slip over the ground per stance, and how often a planted leg is pulled straight.
//   bun scripts/people/gait-metrics.ts [cast-id] [--rig]
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { animate, newAvatar } from "../../packages/kit/avatar/anim"
import { readPerson } from "../../packages/kit/people/asset"
import { gaitBody, newGait } from "../../packages/kit/people/gait"
import { newPose, personRest, posePerson, torchCarry } from "../../packages/kit/people/retarget"
import { terrainFeet } from "../../packages/kit/people/terrain"
import { spring } from "../../packages/kit/rig"

const id = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "a-woods"
const rig = process.argv.includes("--rig")
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
const asset = readPerson(await io.read(new URL(`../../packages/kit/people/assets/${id}.glb`, import.meta.url).pathname), id)
const rest = personRest(asset.skeleton), s = rest.scale
const ball = [rest.idx.ball_l!, rest.idx.ball_r!]

/** Scenarios: world speed (m/s) and turn rate (rad/s) over time. */
const SCENES: Record<string, (t: number) => [number, number]> = {
  "walk 1.9": () => [1.9, 0],
  "run 3.4": () => [3.4, 0],
  "start/stop": (t) => [t % 4 < 2 ? 1.9 * Math.min(1, (t % 4) / 0.6) : 1.9 * Math.max(0, 1 - ((t % 4) - 2) / 0.6), 0],
  "walk to run": (t) => [1.9 + 1.5 * (0.5 - 0.5 * Math.cos(t * 0.8)), 0],
  "turn r=4 m": () => [1.9, 1.9 / 4],
}
const out: Record<string, unknown> = {}
for (const [name, at] of Object.entries(SCENES)) {
  const a = newAvatar("g", 0, 0, 0, "rifle")
  a.unarmed = true
  const pose = newPose(rest), terrain = { drop: spring(), init: false }, gait = newGait()
  const dt = 1 / 60
  let x = 0, z = 0, yaw = 0
  const stance: number[] = [], per: number[] = []
  const acc = [0, 0], prev: ([number, number] | null)[] = [null, null]
  let straight = 0, planted = 0
  for (let f = 0; f < 60 * 8; f++) {
    const t = f * dt, [v, w] = at(t)
    yaw += w * dt
    const vx = Math.cos(yaw) * v, vz = Math.sin(yaw) * v
    x += vx * dt; z += vz * dt
    a.reach = { r: torchCarry(-0.25), k: 1 }
    animate(a, dt, t, x / s, z / s, vx / s, vz / s, yaw)
    const { body, loco } = rig ? { body: a.body!, loco: a } : gaitBody(gait, a, a.body!, s, dt)
    const tf = terrainFeet(terrain, loco, body, s, () => 0, dt, rest.sole)
    posePerson(rest, { body, ...tf, torch: { side: 1, dir: [Math.cos(yaw), -0.25, Math.sin(yaw)] } }, pose)
    if (t < 1.5) continue
    for (let k = 0; k < 2; k++) {
      const p = pose.pos[ball[k]!]!
      if (loco.feet[k].planted) {
        planted++
        if (prev[k]) {
          const d = Math.hypot(p[0] - prev[k]![0], p[2] - prev[k]![1]); acc[k]! += d; per.push(d)
          const ft = body.ft[k]!, rb = [(ft.p[0] + ft.x[0] * 0.125 - ft.y[0] * 0.085) * s, (ft.p[2] + ft.x[2] * 0.125 - ft.y[2] * 0.085) * s]
          if (process.env.DEBUG === name && d > 0.004) console.error("   rig ball", rb.map((q) => q.toFixed(3)).join(","), "mesh ball", p[0].toFixed(3), p[2].toFixed(3), "ankle y", (ft.p[1] * s).toFixed(3), "pitch", ft.x[1].toFixed(2))
          if (process.env.DEBUG === name && d > 0.004) console.error(name, t.toFixed(2), k, "slip", (d * 1000).toFixed(1), "v", v.toFixed(2), "move", gait.move.toFixed(2), "run", gait.run.toFixed(2), "phase", gait.phase.toFixed(2), "off", Math.hypot(...gait.lock[k]!.off).toFixed(3), "lock", gait.lock[k]!.on)
        }
        prev[k] = [p[0], p[2]]
        // A planted leg pulled straight: thigh to ankle at 99.5% of the mesh's leg.
        const L = rest.legs[k]!, hip = pose.pos[L.upper]!, ank = pose.pos[L.end]!
        if (Math.hypot(hip[0] - ank[0], hip[1] - ank[1], hip[2] - ank[2]) > 0.995 * (L.lu + L.ll)) straight++
      } else {
        if (prev[k]) stance.push(acc[k]!)
        acc[k] = 0; prev[k] = null
      }
    }
  }
  stance.sort((p, q) => p - q); per.sort((p, q) => p - q)
  const mm = (v: number) => Math.round(v * 10000) / 10
  out[name] = { stanceSlipMm: { median: mm(stance[stance.length >> 1] ?? 0), max: mm(stance.at(-1) ?? 0) }, frameSlipP95Mm: mm(per[Math.floor(per.length * 0.95)] ?? 0), plantedLegStraightPct: Math.round((100 * straight) / Math.max(1, planted)) }
}
console.log(JSON.stringify({ cast: id, gait: rig ? "rig" : "mocap", ...out }, null, 1))
