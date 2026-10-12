// Draws procedural office floors as SVG floor plans for eyeballing the generator.
// Usage: bun scripts/plan.ts [seed...] → $PLANS (default /tmp/opencode/plans)/<seed>.svg, grid.svg and index.html
import { mkdirSync, writeFileSync } from "node:fs"
import { layout } from "../shared/maps/layout"
import { generateOffice } from "../shared/maps/office"
import { Rng } from "../shared/rng"
import { Nav } from "../shared/sim/nav"

const seeds = process.argv.slice(2).map(Number)
if (!seeds.length) seeds.push(1, 2, 3, 4, 5, 6)
const out = process.env.PLANS ?? "/tmp/opencode/plans"
mkdirSync(out, { recursive: true })
const S = 16
// DARK=0.2 lifts the night veil to read the layout; DOORS=1 marks doorways (green) and open stretches (yellow).
const dark = Number(process.env.DARK ?? 0.62)
const doors = process.env.DOORS === "1"
const FLOOR: Record<string, string> = { carpet: "#1b2236", tile: "#26304a", wood: "#2e2a30", concrete: "#22262e", grate: "#1e2a3a" }
const svgs: string[] = []
for (const seed of seeds) {
  const t0 = performance.now()
  const m = generateOffice(seed)
  const ms = performance.now() - t0
  const R = (r: readonly number[], fill: string, extra = "") => `<rect x="${(r[0]! * S).toFixed(1)}" y="${(r[1]! * S).toFixed(1)}" width="${((r[2]! - r[0]!) * S).toFixed(1)}" height="${((r[3]! - r[1]!) * S).toFixed(1)}" fill="${fill}" ${extra}/>`
  const parts: string[] = []
  for (const f of m.floors) parts.push(R(f.rect, FLOOR[f.kind]!))
  // Outside the building (terraces, light wells), hatched dark.
  for (const v of m.voids ?? []) parts.push(R(v, "#070a12"))
  // Corridors and room labels, from the same plan the generator starts with.
  const plan = layout(new Rng(seed))
  for (const c of plan.corridors) parts.push(R(c, "#33405e"))
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
  const holes = m.lights.map((l) => `<circle cx="${l.x * S}" cy="${l.y * S}" r="${l.r * S}" fill="url(#fade${seed})" opacity="${Math.min(1, l.power)}"/>`).join("")
  parts.push(`<defs><radialGradient id="fade${seed}"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient><mask id="dark${seed}"><rect width="100%" height="100%" fill="#fff"/>${holes}</mask></defs><rect width="100%" height="100%" fill="#000" opacity="${dark}" mask="url(#dark${seed})"/>`)
  if (doors) for (const o of plan.openings) if (o.kind !== "glass") parts.push(`<line x1="${o.x0 * S}" y1="${o.y0 * S}" x2="${o.x1 * S}" y2="${o.y1 * S}" stroke="${o.kind === "door" ? "#3cff7a" : "#ffd23c"}" stroke-width="3"/>`)
  // Walkable floor that can't be reached from the spawns, in red.
  const nav = new Nav(m)
  const reach = nav.reachable(m.spawns[0]!)
  for (let i = 0; i < nav.grid.length; i++)
    if (!nav.grid[i] && !reach[i]) parts.push(R([(i % nav.w) * 0.5, Math.floor(i / nav.w) * 0.5, (i % nav.w) * 0.5 + 0.5, Math.floor(i / nav.w) * 0.5 + 0.5], "#ff2040", 'opacity="0.7"'))
  for (const room of plan.rooms) parts.push(`<text x="${((room.rect[0] + room.rect[2]) / 2) * S}" y="${((room.rect[1] + room.rect[3]) / 2) * S + 4}" fill="#8fa0c8" font-family="monospace" font-size="10" text-anchor="middle">${room.kind}</text>`)
  for (const s of m.spawns) parts.push(`<circle cx="${s.x * S}" cy="${s.y * S}" r="4" fill="none" stroke="#ff8a3a" stroke-width="1.5"/>`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${m.size[0] * S}" height="${m.size[1] * S + 20}" style="background:#0b0f1a"><rect width="100%" height="100%" fill="#0b0f1a"/>${parts.join("")}<text x="4" y="${m.size[1] * S + 15}" fill="#ccc" font-family="monospace" font-size="12">${m.name} ${plan.archetype} [${plan.tags.join(" ")}] seed=${seed} ${m.size[0].toFixed(0)}x${m.size[1].toFixed(0)}m lights=${m.lights.length} walls=${m.walls.length} props=${m.props.length} spawns=${m.spawns.length} ${ms.toFixed(0)}ms</text></svg>`
  writeFileSync(`${out}/${seed}.svg`, svg)
  svgs.push(svg)
  console.log(`seed ${seed} ${plan.archetype} [${plan.tags.join(" ")}]: ${m.size[0].toFixed(1)}x${m.size[1].toFixed(1)} lights=${m.lights.length} walls=${m.walls.length} props=${m.props.length} floors=${m.floors.length} spawns=${m.spawns.length} ${ms.toFixed(1)}ms`)
}
// A contact sheet of every floor, two across at half scale.
const cells = svgs.map((svg, k) => `<g transform="translate(${(k % 2) * 480},${Math.floor(k / 2) * 360}) scale(0.5)">${svg}</g>`)
writeFileSync(`${out}/grid.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${Math.ceil(svgs.length / 2) * 360}" style="background:#000">${cells.join("")}</svg>`)
writeFileSync(`${out}/index.html`, `<body style="background:#000;margin:0;display:flex;flex-wrap:wrap;gap:8px">${svgs.join("")}</body>`)
