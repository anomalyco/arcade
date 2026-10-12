// Draws procedural office floors as SVG floor plans for eyeballing the generator.
// Usage: bun scripts/plan.ts [seed...] → /tmp/opencode/plans/<seed>.svg and an index.html
import { mkdirSync, writeFileSync } from "node:fs"
import { generateOffice } from "../shared/maps/office"

const seeds = process.argv.slice(2).map(Number)
if (!seeds.length) seeds.push(1, 2, 3, 4, 5, 6)
const out = "/tmp/opencode/plans"
mkdirSync(out, { recursive: true })
const S = 16
const FLOOR: Record<string, string> = { carpet: "#1b2236", tile: "#26304a", wood: "#2e2a30", concrete: "#22262e", grate: "#1e2a3a" }
const svgs: string[] = []
for (const seed of seeds) {
  const t0 = performance.now()
  const m = generateOffice(seed)
  const ms = performance.now() - t0
  const R = (r: readonly number[], fill: string, extra = "") => `<rect x="${r[0]! * S}" y="${r[1]! * S}" width="${(r[2]! - r[0]!) * S}" height="${(r[3]! - r[1]!) * S}" fill="${fill}" ${extra}/>`
  const parts: string[] = []
  for (const f of m.floors) parts.push(R(f.rect, FLOOR[f.kind]!))
  for (const n of m.noisy) parts.push(R(n.rect, n.kind === "grate" ? "#3a4a60" : "#20406a", 'opacity="0.7"'))
  for (const t of m.tape) parts.push(R(t, "#b8902a"))
  for (const l of m.lights) {
    const c = `rgb(${l.color.map((v) => Math.round(v * 255)).join(",")})`
    parts.push(`<circle cx="${l.x * S}" cy="${l.y * S}" r="${l.r * S}" fill="${c}" opacity="${0.12 * l.power}"/>`)
    parts.push(`<circle cx="${l.x * S}" cy="${l.y * S}" r="4" fill="${c}"/>`)
  }
  for (const p of m.props) parts.push(R(p.rect, p.solid ? "#6b7590" : "#454d63"))
  for (const w of m.windows) parts.push(R(w, "#5aa0ff", 'opacity="0.5"'))
  for (const w of m.walls) parts.push(R(w.rect, w.style === "partition" || w.style === "stall" ? "#8a93aa" : w.style === "core" ? "#3c4252" : "#d8dce6"))
  for (const g of m.glass) parts.push(R(g.rect, "#9fd4ff"))
  for (const d of m.doors) parts.push(R(d.rect, m.openDoors.includes(d.id) ? "#7a5a30" : "#c08040"))
  for (const b of m.breakers) parts.push(`<rect x="${b.x * S - 4}" y="${b.y * S - 4}" width="8" height="8" fill="#ff0"/>`)
  for (const s of m.spawns) parts.push(`<circle cx="${s.x * S}" cy="${s.y * S}" r="5" fill="none" stroke="${s.x < m.size[0] / 2 ? "#ff8a3a" : "#38d0e8"}" stroke-width="2"/>`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${m.size[0] * S}" height="${m.size[1] * S + 20}" style="background:#0b0f1a"><text x="4" y="${m.size[1] * S + 15}" fill="#ccc" font-family="monospace" font-size="12">${m.name} seed=${seed} ${m.size[0]}x${m.size[1]} lights=${m.lights.length} walls=${m.walls.length} props=${m.props.length} doors=${m.doors.length} spawns=${m.spawns.length} ${ms.toFixed(0)}ms</text>${parts.join("")}</svg>`
  writeFileSync(`${out}/${seed}.svg`, svg)
  svgs.push(svg)
  console.log(`seed ${seed}: ${m.size[0]}x${m.size[1]} lights=${m.lights.length} walls=${m.walls.length} props=${m.props.length} spawns=${m.spawns.length} ${ms.toFixed(1)}ms`)
}
writeFileSync(`${out}/index.html`, `<body style="background:#000;margin:0;display:flex;flex-wrap:wrap;gap:8px">${svgs.join("")}</body>`)
