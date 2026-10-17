// Floor coverage audit. Loads the frozen audit build, reads ctx.floors / ctx.colliders / the room registry once the
// world is complete, then for every storey (and annex, core, roof, fire escape) samples a grid and reports places a
// player's centre can stand (≥ 0.3 m from any collider in the body band, like Player.move) where the ground the
// player would snap to (Player.groundAt: highest floor ≤ y + 0.45, else terrain) is more than 0.45 m below the
// expected level: a fall. Holes are flood-filled from a seed per area (only reachable holes count) and clustered.
//
//   bun scripts/audit/floors.ts [--step 0.25] [--json out.json]
import { writeFileSync, mkdirSync } from "node:fs"
import { launch, open, inPage, OUT } from "./lib"
import { BUILDING, CORE, FIRE_ESCAPE, ROOF_Y, storeyY } from "../../src/world/layout"
import { heightAt } from "../../src/world/height"

const args = process.argv.slice(2)
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`)
  return i < 0 ? d : args[i + 1]
}
const STEP = Number(flag("step", "0.25"))
const jsonOut = flag("json")

type F = { min: [number, number]; max: [number, number]; y: number }
type B = { min: [number, number, number]; max: [number, number, number] }
type Room = { id: string; storey: number; name: string; rect: { x0: number; x1: number; z0: number; z1: number } }

const browser = await launch()
const { page, log } = await open(browser, "shot=1&view=corridor")
const data = await inPage(page, (g) => ({
  floors: g.ctx.floors.map((f: F) => ({ min: [...f.min], max: [...f.max], y: f.y })),
  colliders: g.ctx.colliders.map((b: B) => ({ min: [...b.min], max: [...b.max] })),
  rooms: g.reg.rooms.map((r: Room) => ({ id: r.id, storey: r.storey, name: r.name, rect: r.rect })),
  lift: (() => {
    const l = g.interior?.lift
    return l ? Object.keys(l) : null
  })(),
}), 0) as { floors: F[]; colliders: B[]; rooms: Room[]; lift: string[] | null }
await browser.close()
console.log(`floors ${data.floors.length}, colliders ${data.colliders.length}, rooms ${data.rooms.length}; lift api ${data.lift}`)
if (log.page.length) console.log("page errors:", log.page.slice(0, 5))

// Spatial hash of colliders and floors (2 m cells).
const CELL = 2
const hash = <T extends { min: readonly number[]; max: readonly number[] }>(items: T[], xi: number, zi: number) => {
  const m = new Map<string, T[]>()
  for (const it of items)
    for (let gx = Math.floor((it.min[xi]! - 0.4) / CELL); gx <= Math.floor((it.max[xi]! + 0.4) / CELL); gx++)
      for (let gz = Math.floor((it.min[zi]! - 0.4) / CELL); gz <= Math.floor((it.max[zi]! + 0.4) / CELL); gz++) {
        const k = `${gx},${gz}`
        let l = m.get(k)
        if (!l) m.set(k, (l = []))
        l.push(it)
      }
  return (x: number, z: number) => m.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []
}
const colAt = hash(data.colliders, 0, 2)
const floorAt = hash(data.floors, 0, 1)

const R = 0.3
/** Like Player.move: blocked if any collider overlapping the body band [y+0.45, y+1.75] is within R of (x, z). */
const blocked = (x: number, z: number, y: number) => {
  for (const b of colAt(x, z)) {
    if (b.max[1] < y + 0.45 || b.min[1] > y + 1.75) continue
    const cx = Math.max(b.min[0], Math.min(x, b.max[0]))
    const cz = Math.max(b.min[2], Math.min(z, b.max[2]))
    if ((x - cx) ** 2 + (z - cz) ** 2 < R * R) return true
  }
  return false
}
/** Player.groundAt. */
const ground = (x: number, z: number, maxY: number) => {
  let g = heightAt(x, z)
  for (const f of floorAt(x, z)) if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && f.y <= maxY && f.y > g) g = f.y
  return g
}

type Area = { name: string; owner: string; y: number; x0: number; x1: number; z0: number; z1: number; seeds: [number, number][]; skip?: (x: number, z: number) => boolean }
const SH = { x0: -54.65, x1: 34.65, z0: -21.65, z1: 21.65 }
const inRect = (x: number, z: number, r: { min: readonly number[]; max: readonly number[] }) => x >= r.min[0]! && x <= r.max[0]! && z >= r.min[1]! && z <= r.max[1]!
const areas: Area[] = []
for (let i = 0; i < BUILDING.main.storeys; i++) {
  const y = storeyY(i) + 0.01
  areas.push({
    name: `storey ${i}`,
    owner: `src/world/interior/storeys/s${i}.ts (+ core.ts hall/lobby/slabs)`,
    y,
    ...SH,
    // Stair flights and the lift shaft are audited separately (heights vary / car moves).
    skip: (x, z) => inRect(x, z, { min: [CORE.stair.min[0] - 0.2, 18.66], max: [CORE.stair.max[0], 25] }) || inRect(x, z, { min: CORE.lift.min, max: CORE.lift.max }),
    seeds: [[-20, 0], [10, 0], [-40.2, 10], [-37.9, 17.9], [0, 15]],
  })
  // Storey landing in the stair (z 16.2..18.66) is inside the shell rect above; the tower part beyond the shell:
  areas.push({ name: `storey ${i} stair landing`, owner: "src/world/interior/core.ts landing()", y, x0: CORE.stair.min[0], x1: CORE.stair.max[0], z0: 16.2, z1: 18.6, seeds: [[-41.5, 17.4]] })
}
areas.push({ name: "annex", owner: "src/world/facility/shell.ts / annex.ts", y: storeyY(0), x0: 35.35, x1: 61.65, z0: -37.65, z1: 5.65, seeds: [[48, -16], [40, -8]] })
areas.push({
  name: "roof deck",
  owner: "src/world/facility/shell.ts buildRoofDecks() / roof.ts",
  y: ROOF_Y,
  x0: -54.65,
  x1: 34.65,
  z0: -21.65,
  z1: 21.65,
  seeds: [[-20, -10], [10, 10], [-41, 14]],
})
areas.push({ name: "roof stair head", owner: "src/world/interior/core.ts landing(5) / facility shell.ts", y: ROOF_Y + 0.01, x0: CORE.stair.min[0], x1: CORE.lift.max[0], z0: 16.2, z1: 19.6, seeds: [[-41.5, 17.4]] })
for (let i = 1; i < BUILDING.main.storeys; i++)
  areas.push({
    name: `fire escape landing ${i}`,
    owner: "src/world/facility/firescape.ts landing()",
    y: storeyY(i),
    x0: FIRE_ESCAPE.x - FIRE_ESCAPE.depth,
    x1: FIRE_ESCAPE.x,
    z0: FIRE_ESCAPE.z0,
    z1: FIRE_ESCAPE.z1,
    seeds: [[FIRE_ESCAPE.x - 0.4, 0]],
    // The outer half's flight-arrival hole is railed (intentional).
    skip: (x) => x < FIRE_ESCAPE.x - FIRE_ESCAPE.depth / 2,
  })

const roomAt = (storey: number, x: number, z: number) =>
  data.rooms.filter((r) => r.storey === storey && x >= r.rect.x0 && x <= r.rect.x1 && z >= r.rect.z0 && z <= r.rect.z1).map((r) => `${r.id} ${r.name}`)

type Hole = { x: number; z: number; g: number }
const report: { area: string; owner: string; y: number; cells: number; reachable: number; holes: number; raised: number; clusters: { x0: number; x1: number; z0: number; z1: number; n: number; ground: number; rooms: string[] }[]; raisedClusters: { x0: number; x1: number; z0: number; z1: number; n: number; y: number; rooms: string[] }[] }[] = []

for (const a of areas) {
  const nx = Math.floor((a.x1 - a.x0) / STEP)
  const nz = Math.floor((a.z1 - a.z0) / STEP)
  const X = (i: number) => a.x0 + (i + 0.5) * STEP
  const Z = (j: number) => a.z0 + (j + 0.5) * STEP
  const free = new Uint8Array(nx * nz)
  let cells = 0
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const x = X(i)
      const z = Z(j)
      if (a.skip?.(x, z)) continue
      if (blocked(x, z, a.y)) continue
      free[i * nz + j] = 1
      cells++
    }
  // Flood from seeds over free cells (holes are traversable: you walk onto them and fall).
  const seen = new Uint8Array(nx * nz)
  const q: number[] = []
  for (const [sx, sz] of a.seeds) {
    const i = Math.floor((sx - a.x0) / STEP)
    const j = Math.floor((sz - a.z0) / STEP)
    if (i < 0 || j < 0 || i >= nx || j >= nz) continue
    // Nearest free cell to the seed.
    let best = -1
    for (let r = 0; r < 8 && best < 0; r++)
      for (let di = -r; di <= r && best < 0; di++)
        for (let dj = -r; dj <= r; dj++) {
          const ii = i + di
          const jj = j + dj
          if (ii >= 0 && jj >= 0 && ii < nx && jj < nz && free[ii * nz + jj]) {
            best = ii * nz + jj
            break
          }
        }
    if (best >= 0 && !seen[best]) {
      seen[best] = 1
      q.push(best)
    }
  }
  const holes: Hole[] = []
  const raised: (Hole & { y: number })[] = []
  let reach = 0
  while (q.length) {
    const c = q.pop()!
    reach++
    const i = Math.floor(c / nz)
    const j = c % nz
    const x = X(i)
    const z = Z(j)
    const g = ground(x, z, a.y + 0.45)
    if (g < a.y - 0.45) holes.push({ x, z, g })
    else if (g > a.y + 0.1) raised.push({ x, z, g, y: g })
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ii = i + di
      const jj = j + dj
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue
      const k = ii * nz + jj
      if (free[k] && !seen[k]) {
        seen[k] = 1
        q.push(k)
      }
    }
  }
  // Cluster (8-connected) holes and raised cells.
  const cluster = <T extends Hole>(list: T[]) => {
    const key = (x: number, z: number) => `${Math.round(x / STEP)},${Math.round(z / STEP)}`
    const m = new Map(list.map((h) => [key(h.x, h.z), h]))
    const done = new Set<string>()
    const out: T[][] = []
    for (const h of list) {
      const k0 = key(h.x, h.z)
      if (done.has(k0)) continue
      const grp: T[] = []
      const st = [h]
      done.add(k0)
      while (st.length) {
        const c = st.pop()!
        grp.push(c)
        for (let di = -1; di <= 1; di++)
          for (let dj = -1; dj <= 1; dj++) {
            const k = key(c.x + di * STEP, c.z + dj * STEP)
            const n = m.get(k)
            if (n && !done.has(k)) {
              done.add(k)
              st.push(n)
            }
          }
      }
      out.push(grp)
    }
    return out
  }
  const storey = a.name.startsWith("storey") ? Number(a.name.split(" ")[1]) : a.name === "annex" ? 0 : -1
  const box = (g: Hole[]) => ({
    x0: +(Math.min(...g.map((h) => h.x)) - STEP / 2).toFixed(2),
    x1: +(Math.max(...g.map((h) => h.x)) + STEP / 2).toFixed(2),
    z0: +(Math.min(...g.map((h) => h.z)) - STEP / 2).toFixed(2),
    z1: +(Math.max(...g.map((h) => h.z)) + STEP / 2).toFixed(2),
    n: g.length,
  })
  const clusters = cluster(holes)
    .map((g) => ({ ...box(g), ground: +Math.max(...g.map((h) => h.g)).toFixed(2), rooms: storey >= 0 ? [...new Set(g.flatMap((h) => roomAt(storey, h.x, h.z)))] : [] }))
    .sort((p, q2) => q2.n - p.n)
  const raisedClusters = cluster(raised)
    .map((g) => ({ ...box(g), y: +(Math.max(...g.map((h) => h.g)) - a.y).toFixed(2), rooms: storey >= 0 ? [...new Set(g.flatMap((h) => roomAt(storey, h.x, h.z)))] : [] }))
    .sort((p, q2) => q2.n - p.n)
  report.push({ area: a.name, owner: a.owner, y: +a.y.toFixed(2), cells, reachable: reach, holes: holes.length, raised: raised.length, clusters, raisedClusters })
  console.log(`\n== ${a.name} (y ${a.y.toFixed(2)}): ${cells} free cells, ${reach} reachable, ${holes.length} hole cells in ${clusters.length} clusters; ${raised.length} raised cells`)
  for (const c of clusters.slice(0, 25)) console.log(`  HOLE x ${c.x0}..${c.x1} z ${c.z0}..${c.z1} (${(c.n * STEP * STEP).toFixed(2)} m², falls to ${c.ground}) ${c.rooms.join("; ")}`)
  for (const c of raisedClusters.slice(0, 12)) console.log(`  raised +${c.y} x ${c.x0}..${c.x1} z ${c.z0}..${c.z1} (${(c.n * STEP * STEP).toFixed(2)} m²) ${c.rooms.join("; ")}`)
  if (reach < cells * 0.5) console.log(`  note: only ${((reach / cells) * 100).toFixed(0)}% of free cells reachable from the seeds`)
  // Free space not reachable from the seeds (sealed rooms, chases): report pockets ≥ 3 m².
  const pockets: Hole[] = []
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) if (free[i * nz + j] && !seen[i * nz + j]) pockets.push({ x: X(i), z: Z(j), g: ground(X(i), Z(j), a.y + 0.45) })
  const sealed = cluster(pockets)
    .filter((g) => g.length * STEP * STEP >= 3)
    .map((g) => ({ ...box(g), rooms: storey >= 0 ? [...new Set(g.flatMap((h) => roomAt(storey, h.x, h.z)))] : [] }))
    .sort((p, q2) => q2.n - p.n)
  ;(report[report.length - 1] as { sealed?: unknown }).sealed = sealed
  for (const c of sealed.slice(0, 12)) console.log(`  sealed ${(c.n * STEP * STEP).toFixed(1)} m² x ${c.x0}..${c.x1} z ${c.z0}..${c.z1} ${c.rooms.join("; ")}`)
}

// Stair flights: along each flight centre line, the ground the player snaps to must rise in steps ≤ 0.45 m.
console.log("\n== stair flights (centre lines, walking up)")
const stairIssues: string[] = []
for (let i = 0; i < BUILDING.main.storeys; i++) {
  let y = storeyY(i) + 0.01
  // West flight south from the storey landing, across the mid landing, east flight north to the next storey landing.
  const path: [number, number][] = []
  for (let z = 17.5; z <= 24.5; z += 0.05) path.push([-42.3, z])
  for (let x = -42.3; x <= -40.5; x += 0.05) path.push([x, 24.5])
  for (let z = 24.5; z >= 17.5; z -= 0.05) path.push([-40.5, z])
  let worst = 0
  for (const [x, z] of path) {
    const g = ground(x, z, y + 0.45)
    const d = g - y
    if (d < -0.5) {
      stairIssues.push(`storey ${i}: drop ${d.toFixed(2)} m at ${x.toFixed(2)},${z.toFixed(2)} (from ${y.toFixed(2)})`)
      break
    }
    worst = Math.max(worst, d)
    y = g
  }
  const end = storeyY(i + 1) + 0.01
  const ok = Math.abs(y - end) < 0.2
  console.log(`  storey ${i} → ${i + 1}: reached y ${y.toFixed(2)} (want ${end.toFixed(2)}) ${ok ? "ok" : "FAIL"}; largest step ${worst.toFixed(2)}`)
  if (!ok) stairIssues.push(`storey ${i} → ${i + 1}: climb ends at ${y.toFixed(2)}, want ${end.toFixed(2)}`)
}
for (const s of stairIssues) console.log(`  ${s}`)

mkdirSync(OUT, { recursive: true })
writeFileSync(jsonOut ?? `${OUT}/floors.json`, JSON.stringify({ report, stairIssues, pageErrors: log.page, console: log.console.slice(0, 50) }, null, 1))
process.exit(0)
