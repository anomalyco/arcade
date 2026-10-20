// Draws a saved policy's run as an onion-skin SVG strip (one pose every --every seconds), for checking a gait without
// a browser. bun scripts/strip.ts <policy.json> [--out strip.svg] [--every 0.2] [--task room]

import { parseArgs } from "node:util"
import { Episode } from "../shared/episode"
import { Policy } from "../shared/policy"
import { policyShape } from "../shared/episode"
import { TASKS, type TaskId } from "../shared/tasks"
import { parsePolicy } from "../shared/trainer"

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" }, every: { type: "string", default: "0.2" }, task: { type: "string" } } })
const saved = parsePolicy(await Bun.file(positionals[0]!).json())
if (!saved) throw new Error("not a walkers policy")
const task = (values.task ?? saved.task) as TaskId
const ep = new Episode(saved.creature, task, new Policy(policyShape(saved.creature, saved.hidden), Float64Array.from(saved.params)))
const every = Math.round(Number(values.every) * 60)
const S = 60
const frames: string[] = []
let minX = Infinity, maxX = -Infinity
const pose = () => {
  const parts: string[] = []
  const alpha = 0.25 + 0.75 * (ep.time / ep.reward.seconds)
  for (const b of ep.world.bodies) {
    const ex = b.c * b.hl, ey = b.s * b.hl
    minX = Math.min(minX, b.x - 1)
    maxX = Math.max(maxX, b.x + 1)
    parts.push(`<line x1="${((b.x - ex) * S).toFixed(1)}" y1="${(-(b.y - ey) * S).toFixed(1)}" x2="${((b.x + ex) * S).toFixed(1)}" y2="${(-(b.y + ey) * S).toFixed(1)}" stroke="hsl(${200 - 160 * (ep.time / ep.reward.seconds)},70%,55%)" stroke-opacity="${alpha.toFixed(2)}" stroke-width="${(2 * b.r * S).toFixed(1)}" stroke-linecap="round"/>`)
  }
  frames.push(parts.join(""))
}
pose()
while (!ep.done) {
  ep.step()
  if (ep.steps % every === 0 || ep.done) pose()
}
const pts = TASKS[task].points.map(([x, y]) => `${(x * S).toFixed(1)},${(-y * S).toFixed(1)}`).join(" ")
const w = (maxX - minX) * S
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX * S} ${-2.2 * S} ${w} ${2.6 * S}" width="${Math.min(4000, w)}" height="${(2.6 * S * Math.min(4000, w)) / w}"><rect x="${minX * S}" y="${-2.2 * S}" width="${w}" height="${2.6 * S}" fill="#10141c"/><polyline points="${pts}" fill="none" stroke="#8a96a8" stroke-width="2"/>${frames.join("")}<text x="${minX * S + 10}" y="${-2 * S}" fill="#fff" font-size="20" font-family="monospace">${saved.creature} ${task}: ${ep.distance.toFixed(2)} m in ${ep.time.toFixed(1)} s, fitness ${ep.fitness.toFixed(2)}${ep.fell ? " (fell)" : ""}</text></svg>`
const out = values.out ?? positionals[0]!.replace(/\.json$/, ".svg")
await Bun.write(out, svg)
console.log(`${out}: ${ep.distance.toFixed(2)} m in ${ep.time.toFixed(1)} s, fitness ${ep.fitness.toFixed(3)} (saved ${saved.fitness.toFixed(3)})`)
