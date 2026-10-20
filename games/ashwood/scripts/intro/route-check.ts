// Checks the intro's drive (src/game/intro/route.ts) against the world: every 0.25 m of the car's travel, the car's
// footprint (its real pose: centre, heading, rear-axle tracking) must
//   - stay in its lane: on the county and access roads the car centre's offset from the centre line lies inside the
//     right-hand lane (body clear of the centre line by at most LANE_SLACK, and inside the asphalt edge); through the
//     junction every corner is on asphalt (road, or the kerb-radius flare); in the compound every corner is in the
//     lot or the road mouth, and it crosses the fence line inside the gate opening;
//   - not touch a tree trunk (the forest's own placement and trunk radii: src/world/forest/placement.ts, species.ts);
//   - not touch any collider (posts, poles, kerb stops, booth, boom, parked vehicles: dumped from the running game with
//     the gate and barrier open, cached in captures/intro/colliders.json; `--refresh` re-dumps);
//   - not clip the terrain: the surface under the tyres is where the body says, and nothing under the footprint rises
//     into the floor pan.
// Prints the worst offenders per check and exits 1 on any failure. `--trace` also writes a top-down SVG/PNG of the
// path over the roads, trees and colliders (captures/intro/route-trace.png).
//
//   bun scripts/intro/route-check.ts [--refresh] [--trace]
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { buildRoute, CAR, LANE, type RouteSample } from "../../src/game/intro/route"
import { placeTrees, VARIANTS } from "../../src/world/forest/placement"
import { buildTree } from "../../src/world/forest/species"
import { HA, HC } from "../../src/world/roads/surface"
import { FENCE, PARKING_LOT } from "../../src/world/layout"
import { heightAt } from "../../src/world/height"

const args = process.argv.slice(2)
const outDir = `${import.meta.dir}/../../captures/intro`
mkdirSync(outDir, { recursive: true })
const colliderFile = `${outDir}/colliders.json`
/** Forest placement constants (src/world/forest/textures.ts FOREST_SEED / FOREST_DENSITY; that module starts Workers on import). */
const FOREST = { seed: 1984, density: 1 }
/** How far the body may lean over the centre line (m) and the margin kept to the asphalt edge. */
const LANE_SLACK = 0.15
const EDGE_MARGIN = 0.05
/** Clearance around the body for trunks and colliders (m), and the floor pan's height above the road. */
const CLEAR = 0.15
const FLOOR = 0.14
const BODY_TOP = 1.42

type Box = { min: number[]; max: number[] }

const chromePath = () => {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  return readdirSync(cache)
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .sort()
    .reverse()
    .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
    .find(existsSync)
}

async function dumpColliders(): Promise<Box[]> {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
    await page.goto("http://localhost:5196/?shot=1&view=lot&body=0&copen=ctl-gate,ctl-boom")
    await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, undefined, { timeout: 240_000 })
    // The boom takes 4 s to rise once the compound's tick sees its button pressed.
    await page.waitForTimeout(6000)
    return await page.evaluate(() => {
      const p = (globalThis as unknown as { __ashwoodPlayer: { ctx: { colliders: Box[] } } }).__ashwoodPlayer
      return p.ctx.colliders.filter((b) => b.max[1] > -100).map((b) => ({ min: [...b.min], max: [...b.max] }))
    })
  } finally {
    await browser.close()
  }
}

let colliders: Box[]
if (args.includes("--refresh") || !existsSync(colliderFile)) {
  colliders = await dumpColliders()
  writeFileSync(colliderFile, JSON.stringify(colliders))
  console.log(`dumped ${colliders.length} colliders`)
} else colliders = JSON.parse(readFileSync(colliderFile, "utf8"))

// Trees (trunk circles) from the forest's own placement.
const trees = placeTrees(FOREST)
const radius = VARIANTS.map((v) => buildTree(v.kind, v.seed).baseRadius)
// The forest's per-camera collider pool duplicates trees near the dump's camera: drop boxes centred on a tree.
const treeKey = new Set<string>()
for (let k = 0; k < trees.count; k++) treeKey.add(`${trees.x[k]!.toFixed(1)},${trees.z[k]!.toFixed(1)}`)
colliders = colliders.filter((b) => !treeKey.has(`${((b.min[0]! + b.max[0]!) / 2).toFixed(1)},${((b.min[2]! + b.max[2]!) / 2).toFixed(1)}`))

const route = buildRoute()
const { surface } = route
// Only what the drive can reach.
const near = (x: number, z: number, r: number) => {
  for (const p of route.axle) if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r) return true
  return false
}
const nearTrees: number[] = []
for (let k = 0; k < trees.count; k++) if (near(trees.x[k]!, trees.z[k]!, 8)) nearTrees.push(k)
const nearBoxes = colliders.filter((b) => near((b.min[0]! + b.max[0]!) / 2, (b.min[2]! + b.max[2]!) / 2, 8 + Math.max(b.max[0]! - b.min[0]!, b.max[2]! - b.min[2]!) / 2))

type Fail = { check: string; s: number; x: number; z: number; amount: number; what: string }
const fails: Fail[] = []
const fail = (check: string, st: RouteSample, amount: number, what: string) => fails.push({ check, s: +st.s.toFixed(2), x: +st.x.toFixed(2), z: +st.z.toFixed(2), amount: +amount.toFixed(3), what })

const corners = (st: RouteSample, grow = 0) => {
  const fx = -Math.sin(st.yaw), fz = -Math.cos(st.yaw)
  const rx = Math.cos(st.yaw), rz = -Math.sin(st.yaw)
  const L = CAR.halfL + grow
  const W = CAR.halfW + grow
  return [
    [L, -W],
    [L, W],
    [-L, W],
    [-L, -W],
  ].map(([a, b]) => ({ x: st.x + fx * a! + rx * b!, z: st.z + fz * a! + rz * b! }))
}
/** Separating-axis test, car rectangle (grown by `grow`) vs an axis-aligned box: penetration depth (≤ 0 clear). */
function obbAabb(st: RouteSample, b: Box, grow: number) {
  const c = corners(st, grow)
  const axes = [
    { x: 1, z: 0 },
    { x: 0, z: 1 },
    { x: -Math.sin(st.yaw), z: -Math.cos(st.yaw) },
    { x: Math.cos(st.yaw), z: -Math.sin(st.yaw) },
  ]
  const bc = [
    { x: b.min[0]!, z: b.min[2]! },
    { x: b.max[0]!, z: b.min[2]! },
    { x: b.max[0]!, z: b.max[2]! },
    { x: b.min[0]!, z: b.max[2]! },
  ]
  let depth = Infinity
  for (const a of axes) {
    const pa = c.map((p) => p.x * a.x + p.z * a.z)
    const pb = bc.map((p) => p.x * a.x + p.z * a.z)
    const o = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb))
    if (o <= 0) return o
    depth = Math.min(depth, o)
  }
  return depth
}
/** Distance from a point to the car rectangle (0 inside). */
function pointRect(st: RouteSample, x: number, z: number) {
  const fx = -Math.sin(st.yaw), fz = -Math.cos(st.yaw)
  const rx = Math.cos(st.yaw), rz = -Math.sin(st.yaw)
  const dx = x - st.x, dz = z - st.z
  const a = Math.abs(dx * fx + dz * fz) - CAR.halfL
  const b = Math.abs(dx * rx + dz * rz) - CAR.halfW
  return Math.hypot(Math.max(a, 0), Math.max(b, 0)) + Math.min(Math.max(a, b), 0)
}

const j = surface.junction
// Flare (junction kerb fillets, radius 9 at the asphalt edge) in access/county lane coordinates.
const onAsphalt = (x: number, z: number) => {
  const a = surface.pa.project(x, z)
  const c = surface.pc.project(x, z)
  if (a.d <= HA - EDGE_MARGIN && a.s >= j.sStart - 0.5) return true
  if (c.d <= HC - EDGE_MARGIN) return true
  // Corner fillet: between the access edge and the county north edge, outside the 9 m kerb circle.
  // (The bands overlap the road strips so a corner on the seam isn't lost between the tests.)
  const ua = Math.max(0, Math.abs(a.u) - HA)
  const vc = Math.max(0, c.d - HC)
  if (Math.abs(a.u) - HA >= -1 && c.d - HC >= -1 && ua <= 9 && vc <= 9 && Math.hypot(9 - ua, 9 - vc) >= 9 + EDGE_MARGIN) return true
  return false
}
const inCompound = (z: number) => z <= FENCE.max[1] + 6
const inLotOrMouth = (x: number, z: number) =>
  (x >= PARKING_LOT.min[0] && x <= PARKING_LOT.max[0] && z >= PARKING_LOT.min[1] && z <= PARKING_LOT.max[1]) || onAsphalt(x, z)

const st: RouteSample = { x: 0, z: 0, yaw: 0, y: 0, pitch: 0, roll: 0, speed: 0, accel: 0, curvature: 0, s: 0 }
let samples = 0
let worstLane = { v: -Infinity, at: "" }
for (let d = 0; d <= route.length + 1e-6; d += 0.25) {
  route.at(d, st)
  samples++
  const cs = corners(st)
  // ---- lane
  const a = surface.pa.project(st.x, st.z)
  const c = surface.pc.project(st.x, st.z)
  // On the county road while still heading along it (westbound, yaw ≈ +90°); turning off it is the junction.
  const onCounty = c.d < HC + 1 && a.s < j.sStart && Math.abs(st.yaw - Math.PI / 2) < 0.15
  const onAccess = !onCounty && a.s > j.sMouth + 4 && st.z > FENCE.max[1] + 6
  if (onCounty || onAccess) {
    // County: travel is westbound, so the right-hand lane is -u on the east-running Line.
    const u = onCounty ? -c.u : a.u
    const half = onCounty ? HC : HA
    const lo = CAR.halfW - LANE_SLACK
    const hi = half - CAR.halfW - EDGE_MARGIN
    const off = Math.max(lo - u, u - hi)
    if (off > worstLane.v) worstLane = { v: off, at: `s ${st.s.toFixed(1)} u ${u.toFixed(2)} [${lo.toFixed(2)}, ${hi.toFixed(2)}]` }
    if (off > 0) fail("lane", st, off, `${onCounty ? "county" : "access"} offset ${u.toFixed(2)} outside [${lo.toFixed(2)}, ${hi.toFixed(2)}]`)
  } else if (!inCompound(st.z)) {
    const off = cs.filter((p) => !onAsphalt(p.x, p.z)).length
    if (off) fail("lane", st, off, `junction: ${off} corner(s) off the asphalt`)
  } else {
    const off = cs.filter((p) => !inLotOrMouth(p.x, p.z)).length
    if (off) fail("lane", st, off, `compound: ${off} corner(s) outside the lot / road`)
  }
  // Fence line: the whole body inside the gate opening while it crosses.
  const zs = cs.map((p) => p.z)
  if (Math.min(...zs) < FENCE.max[1] && Math.max(...zs) > FENCE.max[1]) {
    const xs = cs.map((p) => p.x)
    const off = Math.max(FENCE.gate.x0 + 0.3 - Math.min(...xs), Math.max(...xs) - (FENCE.gate.x1 - 0.3))
    if (off > 0) fail("gate", st, off, `body outside the gate opening by ${off.toFixed(2)} m`)
  }
  // ---- trees
  for (const k of nearTrees) {
    const r = radius[trees.variant[k]!]! * trees.scale[k]!
    const dist = pointRect(st, trees.x[k]!, trees.z[k]!) - r - CLEAR
    if (dist < 0) fail("tree", st, -dist, `trunk at (${trees.x[k]!.toFixed(1)}, ${trees.z[k]!.toFixed(1)}) r ${r.toFixed(2)}`)
  }
  // ---- colliders (anything between the floor pan and the roof)
  for (const b of nearBoxes) {
    if (b.max[1]! < st.y + FLOOR || b.min[1]! > st.y + BODY_TOP) continue
    const depth = obbAabb(st, b, CLEAR)
    if (depth > 0) fail("collider", st, depth, `box [${b.min.map((v) => v.toFixed(2))}]..[${b.max.map((v) => v.toFixed(2))}]`)
  }
  // ---- terrain: tyre contacts on the body plane, nothing under the footprint above the floor pan
  const fx = -Math.sin(st.yaw), fz = -Math.cos(st.yaw)
  const rx = Math.cos(st.yaw), rz = -Math.sin(st.yaw)
  const plane = (along: number, side: number) => st.y + along * Math.tan(st.pitch) + side * Math.tan(st.roll)
  const axleZ = -CAR.rear
  for (const [along, side] of [
    [axleZ, -CAR.track / 2],
    [axleZ, CAR.track / 2],
    [axleZ + CAR.wheelbase, -CAR.track / 2],
    [axleZ + CAR.wheelbase, CAR.track / 2],
  ] as const) {
    const g = surface.at(st.x + fx * along + rx * side, st.z + fz * along + rz * side)
    const gap = plane(along, side) - g
    if (Math.abs(gap) > 0.03) fail("terrain", st, Math.abs(gap), `tyre ${along > 0 ? "front" : "rear"} ${side > 0 ? "right" : "left"} ${gap > 0 ? "floats" : "sinks"} ${gap.toFixed(3)} m`)
  }
  for (let along = -CAR.halfL; along <= CAR.halfL + 1e-6; along += 0.5)
    for (let side = -CAR.halfW; side <= CAR.halfW + 1e-6; side += 0.5) {
      const x = st.x + fx * along + rx * side
      const z = st.z + fz * along + rz * side
      const g = Math.max(surface.at(x, z), heightAt(x, z))
      const clip = g - (plane(along, side) + FLOOR)
      if (clip > 0) fail("terrain", st, clip, `ground ${clip.toFixed(3)} m into the floor pan at (${x.toFixed(1)}, ${z.toFixed(1)})`)
    }
}

const byCheck = new Map<string, Fail[]>()
for (const f of fails) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f])
console.log(`route ${route.length.toFixed(1)} m, ${route.duration.toFixed(1)} s; ${samples} samples; ${nearTrees.length} trees and ${nearBoxes.length} colliders within reach`)
console.log(`lane: worst margin ${(-worstLane.v).toFixed(3)} m (${worstLane.at})`)
for (const check of ["lane", "gate", "tree", "collider", "terrain"]) {
  const list = byCheck.get(check) ?? []
  console.log(`${check.padEnd(9)} ${list.length ? `FAIL ${list.length} samples` : "ok"}`)
  for (const f of [...list].sort((a, b) => b.amount - a.amount).slice(0, 6)) console.log(`  s ${f.s} (${f.x}, ${f.z}) ${f.amount} — ${f.what}`)
}

if (args.includes("--trace")) {
  // Top-down trace: road ribbons, lot, fence/gate, trees (trunk + crown hint), colliders, the axle path and the body.
  const minX = -60, maxX = 60, minZ = 30, maxZ = 445
  const S = 4
  const W = (maxX - minX) * S, H = (maxZ - minZ) * S
  const X = (x: number) => ((x - minX) * S).toFixed(1)
  const Z = (z: number) => ((z - minZ) * S).toFixed(1)
  const parts: string[] = []
  const ribbon = (line: typeof surface.access, half: number) => {
    const l: string[] = [], r: string[] = []
    for (const p of line.pts) {
      if (p.x < minX - 5 || p.x > maxX + 5 || p.z < minZ - 5 || p.z > maxZ + 5) continue
      l.push(`${X(p.x - p.tz * -half)},${Z(p.z + p.tx * -half)}`)
      r.push(`${X(p.x - p.tz * half)},${Z(p.z + p.tx * half)}`)
    }
    parts.push(`<polygon points="${[...l, ...r.reverse()].join(" ")}" fill="#3a3d40"/>`)
    parts.push(`<polyline points="${line.pts.filter((p) => p.x > minX - 5 && p.x < maxX + 5 && p.z > minZ - 5 && p.z < maxZ + 5).map((p) => `${X(p.x)},${Z(p.z)}`).join(" ")}" fill="none" stroke="#c9a227" stroke-width="1" stroke-dasharray="6 6"/>`)
  }
  parts.push(`<rect width="${W}" height="${H}" fill="#14241c"/>`)
  ribbon(surface.county, HC)
  ribbon(surface.access, HA)
  parts.push(`<rect x="${X(PARKING_LOT.min[0])}" y="${Z(PARKING_LOT.min[1])}" width="${(PARKING_LOT.max[0] - PARKING_LOT.min[0]) * S}" height="${(PARKING_LOT.max[1] - PARKING_LOT.min[1]) * S}" fill="#33363a"/>`)
  parts.push(`<line x1="${X(FENCE.min[0])}" y1="${Z(FENCE.max[1])}" x2="${X(FENCE.gate.x0)}" y2="${Z(FENCE.max[1])}" stroke="#aaa" stroke-width="2"/><line x1="${X(FENCE.gate.x1)}" y1="${Z(FENCE.max[1])}" x2="${X(FENCE.max[0])}" y2="${Z(FENCE.max[1])}" stroke="#aaa" stroke-width="2"/>`)
  for (let k = 0; k < trees.count; k++) {
    const x = trees.x[k]!, z = trees.z[k]!
    if (x < minX || x > maxX || z < minZ || z > maxZ) continue
    const r = radius[trees.variant[k]!]! * trees.scale[k]!
    parts.push(`<circle cx="${X(x)}" cy="${Z(z)}" r="${Math.max(1.2, r * S)}" fill="#6b4a2a"/>`)
  }
  for (const b of colliders) {
    if (b.max[0]! < minX || b.min[0]! > maxX || b.max[2]! < minZ || b.min[2]! > maxZ || b.max[1]! - b.min[1]! > 30) continue
    parts.push(`<rect x="${X(b.min[0]!)}" y="${Z(b.min[2]!)}" width="${Math.max(1, (b.max[0]! - b.min[0]!) * S)}" height="${Math.max(1, (b.max[2]! - b.min[2]!) * S)}" fill="none" stroke="#5aa0d8" stroke-width="1"/>`)
  }
  for (let d = 0; d <= route.length; d += 6) {
    route.at(d, st)
    parts.push(`<polygon points="${corners(st).map((p) => `${X(p.x)},${Z(p.z)}`).join(" ")}" fill="none" stroke="#e8a254" stroke-opacity="0.55" stroke-width="1"/>`)
  }
  parts.push(`<polyline points="${route.axle.map((p) => `${X(p.x)},${Z(p.z)}`).join(" ")}" fill="none" stroke="#ff4040" stroke-width="1.5"/>`)
  for (const f of fails) parts.push(`<circle cx="${X(f.x)}" cy="${Z(f.z)}" r="5" fill="none" stroke="#ff00ff" stroke-width="2"/>`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`
  const svgFile = `${outDir}/route-trace.svg`
  writeFileSync(svgFile, svg)
  // Tiles ≤ 720 px tall (north first: the lot and gate, then the road, then the junction), one short-lived browser.
  const TILE = 700
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--mute-audio"] })
  try {
    const page = await browser.newPage({ viewport: { width: W, height: TILE } })
    await page.setContent(`<body style="margin:0;background:#000">${svg}</body>`)
    for (let k = 0, y = 0; y < H; k++, y += TILE) {
      const top = Math.min(y, H - TILE)
      await page.screenshot({ path: `${outDir}/route-trace-${k + 1}.png`, clip: { x: 0, y: top, width: W, height: TILE }, fullPage: true })
    }
  } finally {
    await browser.close()
  }
  console.log(`trace: ${svgFile} + route-trace-<n>.png (north → south)`)
}
process.exit(fails.length ? 1 : 0)
