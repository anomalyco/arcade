/**
 * CPU layout dump of the first N homes in the streamed world (no browser): footprint, plan and dressing per house, plus
 * how many distinct shapes there are. `bun scripts/house-variety-dump.ts [--count 30] [--seed 7] [--ascii]`.
 */
import { generateWorldChunk, type WorldChunk } from "../shared/world"
import type { Building } from "../shared/map"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1]! : d
}
const count = Number(arg("count", "30"))
const seed = Number(arg("seed", "7"))
const ascii = process.argv.includes("--ascii")

const HOMES = new Set(["house", "ranch", "cottage", "cabin"])
type Row = { b: Building; chunk: WorldChunk }
const rows: Row[] = []
// Spiral out from the origin so the sample is the town a player actually walks.
outer: for (let ring = 0; ring < 40; ring++) {
  for (let cy = -ring; cy <= ring; cy++) {
    for (let cx = -ring; cx <= ring; cx++) {
      if (Math.max(Math.abs(cx), Math.abs(cy)) !== ring) continue
      const chunk = generateWorldChunk(seed, seed, cx, cy, "streaming")
      for (const b of chunk.buildings) {
        if (!HOMES.has(b.archetype ?? b.kind) && !b.style) continue
        rows.push({ b, chunk })
        if (rows.length >= count) break outer
      }
    }
  }
}

const r1 = (v: number) => v.toFixed(1)
const sigs = new Map<string, number>()
const layoutSigs = new Map<string, number>()
console.log("id                      arch     form          w×d       fp doors win props  roof    siding     storeys porch     extras")
for (const { b, chunk } of rows) {
  const [x, y, r, e] = b.rect
  const doors = chunk.doors.filter((d) => d.rect[0] >= x - 0.1 && d.rect[2] <= r + 0.1 && d.rect[1] >= y - 0.1 && d.rect[3] <= e + 0.1)
  const wins = chunk.windows.filter((w) => w.buildingId === b.id)
  const props = chunk.props.filter((p) => p.kind !== "tree" && p.x >= x && p.x <= r && p.y >= y && p.y <= e)
  const fp = b.footprint ?? [b.rect]
  const s = b.style
  const fpSig = fp.map((f) => `${r1(f[0] - x)},${r1(f[1] - y)},${r1(f[2] - x)},${r1(f[3] - y)}`).join("|")
  const propSig = props.map((p) => `${p.kind}@${r1(p.x - x)},${r1(p.y - y)}`).sort().join(" ")
  const layout = `${fpSig}/${doors.map((d) => `${r1(d.rect[0] - x)},${r1(d.rect[1] - y)}`).join(";")}/${propSig}`
  layoutSigs.set(layout, (layoutSigs.get(layout) ?? 0) + 1)
  const look = `${layout}/${b.color}/${s ? JSON.stringify(s) : ""}`
  sigs.set(look, (sigs.get(look) ?? 0) + 1)
  const boarded = wins.filter((w) => w.boarded).length
  const extras = s ? [s.condition !== "kept" ? s.condition.toUpperCase() : "", s.household, s.chimney ? "chimney" : "", s.garage !== "none" ? s.garage : "", s.fence !== "none" ? s.fence : "", ...s.yard.map((y) => y.kind), boarded ? `boarded×${boarded}` : "", `rooms:${s.rooms.map((r) => r.type).join("/")}`].filter(Boolean).join(",") : ""
  console.log(
    `${b.id.padEnd(24)}${(b.archetype ?? b.kind).padEnd(9)}${(s?.form ?? "-").padEnd(14)}${`${r1(r - x)}×${r1(e - y)}`.padEnd(10)}${String(fp.length).padEnd(3)}${String(doors.length).padEnd(6)}${String(wins.length).padEnd(4)}${String(props.length).padEnd(7)}${(s?.roof ?? "gable").padEnd(8)}${(s?.siding ?? "clapboard").padEnd(11)}${String(s?.storeys ?? 1).padEnd(8)}${(s?.porch ?? "gable").padEnd(10)}${extras}`,
  )
  if (ascii) {
    const W = Math.ceil(r - x) + 1, H = Math.ceil(e - y) + 1
    const g = Array.from({ length: H }, () => Array.from({ length: W }, () => " "))
    for (const f of fp) for (let zz = Math.floor(f[1] - y); zz < Math.ceil(f[3] - y); zz++) for (let xx = Math.floor(f[0] - x); xx < Math.ceil(f[2] - x); xx++) g[zz]![xx] = "."
    for (const w of chunk.barriers) {
      if (w.kind === "fence" || w.rect[0] < x - 0.1 || w.rect[2] > r + 0.1 || w.rect[1] < y - 0.1 || w.rect[3] > e + 0.1) continue
      for (let zz = Math.floor(w.rect[1] - y); zz < Math.ceil(w.rect[3] - y); zz++) for (let xx = Math.floor(w.rect[0] - x); xx < Math.ceil(w.rect[2] - x); xx++) if (g[zz]?.[xx] !== undefined) g[zz]![xx] = w.kind === "window" ? "=" : "#"
    }
    for (const d of doors) g[Math.floor((d.rect[1] + d.rect[3]) / 2 - y)]![Math.floor((d.rect[0] + d.rect[2]) / 2 - x)] = "D"
    for (const p of props) { const row = g[Math.floor(p.y - y)]; if (row) row[Math.floor(p.x - x)] = p.kind[0]! }
    console.log(g.map((row) => "    " + row.join("")).join("\n"))
  }
}
const colours = new Set(rows.map((r) => r.b.color)).size
const dims = new Set(rows.map((r) => `${r1(r.b.rect[2] - r.b.rect[0])}x${r1(r.b.rect[3] - r.b.rect[1])}`)).size
console.log(`\n${rows.length} homes: ${layoutSigs.size} distinct layouts (footprint+doors+furniture), ${sigs.size} distinct looks, ${dims} footprint sizes, ${colours} wall colours`)
const top = [...layoutSigs.values()].sort((a, b) => b - a)[0] ?? 0
console.log(`most common layout repeats ${top}× (${Math.round((100 * top) / Math.max(1, rows.length))}%)`)
