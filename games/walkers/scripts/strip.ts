// Draws a saved policy's run as an onion-skin SVG strip (one pose every --every seconds), for checking a gait without
// a browser. bun scripts/strip.ts <policy.json> [--out strip.svg] [--every 0.2] [--task room] [--stage 4]

import { parseArgs } from "node:util"
import { Episode } from "../shared/episode"
import { Policy } from "../shared/policy"
import { policyShape } from "../shared/episode"
import { envFor, type TaskId } from "../shared/tasks"
import { parsePolicy } from "../shared/trainer"

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" }, every: { type: "string", default: "0.2" }, task: { type: "string" }, stage: { type: "string" } } })
const saved = parsePolicy(await Bun.file(positionals[0]!).json())
if (!saved) throw new Error("not a walkers policy")
const env = values.task ? envFor(values.task as TaskId) : { ...saved.env }
if (values.stage) env.stage = Number(values.stage)
const task = env.task
const ep = new Episode(saved.creature, env, new Policy(policyShape(saved.creature, saved.hidden), Float64Array.from(saved.params)))
const every = Math.round(Number(values.every) * 60)
const S = 60
const frames: string[] = []
let minX = Infinity, maxX = -Infinity
const pose = () => {
  const parts: string[] = []
  const alpha = 0.25 + 0.75 * (ep.time / ep.seconds)
  for (const b of ep.world.bodies) {
    if (b.kind === 1) {
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const lx = u! * b.hx, ly = v! * b.hy; return `${((b.x + b.c * lx - b.s * ly) * S).toFixed(1)},${(-(b.y + b.s * lx + b.c * ly) * S).toFixed(1)}` })
      parts.push(`<polygon points="${pts.join(" ")}" fill="none" stroke="#c9a46a" stroke-opacity="${alpha.toFixed(2)}" stroke-width="2"/>`)
      continue
    }
    const ex = b.c * b.hl, ey = b.s * b.hl
    minX = Math.min(minX, b.x - 1)
    maxX = Math.max(maxX, b.x + 1)
    parts.push(`<line x1="${((b.x - ex) * S).toFixed(1)}" y1="${(-(b.y - ey) * S).toFixed(1)}" x2="${((b.x + ex) * S).toFixed(1)}" y2="${(-(b.y + ey) * S).toFixed(1)}" stroke="hsl(${200 - 160 * (ep.time / ep.seconds)},70%,55%)" stroke-opacity="${alpha.toFixed(2)}" stroke-width="${(2 * b.r * S).toFixed(1)}" stroke-linecap="round"/>`)
  }
  frames.push(parts.join(""))
}
pose()
while (!ep.done) {
  ep.step()
  if (ep.steps % every === 0 || ep.done) pose()
}
const poly = (ps: readonly (readonly [number, number])[]) => ps.map(([x, y]) => `${(x * S).toFixed(1)},${(-y * S).toFixed(1)}`).join(" ")
const pts = poly(ep.level.floor)
const blocks = ep.level.blocks.map((b) => `<polygon points="${poly(b)}" fill="#2a3240"/>`).join("")
const lasers = ep.level.lasers.flatMap((l) => (l.kind === "beam" ? [`<line x1="${l.x1 * S}" y1="${-l.y1 * S}" x2="${l.x2 * S}" y2="${-l.y2 * S}" stroke="#ff2a3a" stroke-width="2" stroke-dasharray="${l.on ? "6 4" : "none"}"/>`] : [`<rect x="${l.x1 * S}" y="${-(l.y + l.amp) * S}" width="${(l.x2 - l.x1) * S}" height="${2 * l.amp * S}" fill="#ff2a3a" fill-opacity="0.15"/>`])).join("")
const gem = ep.level.gem ? `<circle cx="${ep.level.gem.x * S}" cy="${-ep.level.gem.y * S}" r="6" fill="#5ff"/>` : ""
const w = (maxX - minX) * S
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX * S} ${-3.1 * S} ${w} ${3.5 * S}" width="${Math.min(4000, w)}" height="${(3.5 * S * Math.min(4000, w)) / w}"><rect x="${minX * S}" y="${-3.1 * S}" width="${w}" height="${3.5 * S}" fill="#10141c"/>${blocks}<polyline points="${pts}" fill="none" stroke="#8a96a8" stroke-width="2"/>${lasers}${gem}${frames.join("")}<text x="${minX * S + 10}" y="${-2.8 * S}" fill="#fff" font-size="20" font-family="monospace">${saved.creature} ${task}: ${ep.distance.toFixed(2)} m in ${ep.time.toFixed(1)} s, fitness ${ep.fitness.toFixed(2)}${ep.outcome === "finished" ? "" : ` (${ep.outcome})`}${ep.carrying ? " with gem" : ""}</text></svg>`
const out = values.out ?? positionals[0]!.replace(/\.json$/, ".svg")
await Bun.write(out, svg)
console.log(`${out}: ${ep.distance.toFixed(2)} m in ${ep.time.toFixed(1)} s, fitness ${ep.fitness.toFixed(3)} (saved ${saved.fitness.toFixed(3)})`)
