// Draws procedural office floors as SVG floor plans for eyeballing the generator.
// Usage: bun scripts/plan.ts [seed...] → /tmp/opencode/plans/<seed>.svg and an index.html
import { mkdirSync, writeFileSync } from "node:fs"
import { layout } from "../shared/maps/layout"
import { generateOffice } from "../shared/maps/office"
import { Rng } from "../shared/rng"
import { Nav } from "../shared/sim/nav"

const seeds = process.argv.slice(2).map(Number)
if (!seeds.length) seeds.push(1, 2, 3, 4, 5, 6)
const out = "/tmp/opencode/plans"
mkdirSync(out, { recursive: true })
const S = 10
const FLOOR: Record<string, string> = { carpet: "#1b2236", tile: "#26304a", wood: "#2e2a30", concrete: "#22262e", grate: "#1e2a3a" }
const svgs: string[] = []
for (const seed of seeds) {
  const t0 = performance.now()
  const m = generateOffice(seed)
  const ms = performance.now() - t0
  const R = (r: readonly number[], fill: string, extra = "") => `<rect x="${(r[0]! * S).toFixed(1)}" y="${(r[1]! * S).toFixed(1)}" width="${((r[2]! - r[0]!) * S).toFixed(1)}" height="${((r[3]! - r[1]!) * S).toFixed(1)}" fill="${fill}" ${extra}/>`
  const parts: string[] = []
  for (const f of m.floors) parts.push(R(f.rect, FLOOR[f.kind]!))
  // Corridor cells, from the same plan the generator starts with.
  const plan = layout(new Rng(seed))
  for (let i = 0; i < plan.gw * plan.gh; i++) {
    if (plan.zone[i] !== 0) continue
    const x = i % plan.gw
    const y = Math.floor(i / plan.gw)
    parts.push(R([plan.xs[x]!, plan.ys[y]!, plan.xs[x + 1]!, plan.ys[y + 1]!], "#33405e"))
  }
  for (const t of m.tape) parts.push(R(t, "#b8902a"))
  for (const l of m.lights) {
    const c = `rgb(${l.color.map((v) => Math.round(v * 255)).join(",")})`
    parts.push(`<circle cx="${l.x * S}" cy="${l.y * S}" r="${l.r * S * 0.7}" fill="${c}" opacity="${0.14 * l.power}"/>`)
    parts.push(`<circle cx="${l.x * S}" cy="${l.y * S}" r="3" fill="${c}"/>`)
  }
  for (const p of m.props) parts.push(R(p.rect, p.solid ? "#6b7590" : "#454d63"))
  for (const w of m.windows) parts.push(R(w, "#5aa0ff", 'opacity="0.6"'))
  const WALL: Record<string, string> = { partition: "#8a93aa", stall: "#8a93aa", core: "#3c4252", rack: "#2a4a9a", shelf: "#7a6a50", pillar: "#9aa0b0", wall: "#d8dce6" }
  for (const w of m.walls) parts.push(R(w.rect, WALL[w.style]!))
  for (const g of m.glass) parts.push(R(g, "#9fd4ff"))
  // Darkness: a black veil with holes where the lights reach (fades out at the light's radius).
  const holes = m.lights.map((l) => `<circle cx="${l.x * S}" cy="${l.y * S}" r="${l.r * S}" fill="url(#fade)" opacity="${Math.min(1, l.power)}"/>`).join("")
  parts.push(`<defs><radialGradient id="fade"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient><mask id="dark"><rect width="100%" height="100%" fill="#fff"/>${holes}</mask></defs><rect width="100%" height="100%" fill="#000" opacity="0.62" mask="url(#dark)"/>`)
  // Walkable floor that can't be reached from the spawns, in red.
  const nav = new Nav(m)
  const reach = nav.reachable(m.spawns[0]!)
  for (let i = 0; i < nav.grid.length; i++)
    if (!nav.grid[i] && !reach[i]) parts.push(R([(i % nav.w) * 0.5, Math.floor(i / nav.w) * 0.5, (i % nav.w) * 0.5 + 0.5, Math.floor(i / nav.w) * 0.5 + 0.5], "#ff2040", 'opacity="0.7"'))
  for (const s of m.spawns) parts.push(`<circle cx="${s.x * S}" cy="${s.y * S}" r="4" fill="none" stroke="#ff8a3a" stroke-width="1.5"/>`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${m.size[0] * S}" height="${m.size[1] * S + 20}" style="background:#0b0f1a"><rect width="100%" height="100%" fill="#0b0f1a"/>${parts.join("")}<text x="4" y="${m.size[1] * S + 15}" fill="#ccc" font-family="monospace" font-size="12">${m.name} seed=${seed} ${m.size[0].toFixed(0)}x${m.size[1].toFixed(0)}m lights=${m.lights.length} walls=${m.walls.length} props=${m.props.length} spawns=${m.spawns.length} ${ms.toFixed(0)}ms</text></svg>`
  writeFileSync(`${out}/${seed}.svg`, svg)
  svgs.push(svg)
  console.log(`seed ${seed}: ${m.size[0].toFixed(1)}x${m.size[1].toFixed(1)} lights=${m.lights.length} walls=${m.walls.length} props=${m.props.length} floors=${m.floors.length} spawns=${m.spawns.length} ${ms.toFixed(1)}ms`)
}
writeFileSync(`${out}/index.html`, `<body style="background:#000;margin:0;display:flex;flex-wrap:wrap;gap:8px">${svgs.join("")}</body>`)
