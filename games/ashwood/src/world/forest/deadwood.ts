import { compoundDistance, fbm, heightAt, roadEdgeDistance } from "../height"
import { VIEWPOINTS, WORLD_HALF, northTrackDistance } from "../layout"
import { VARIANTS, type Trees } from "./placement"
import { hash3 } from "./rng"

// Where fallen logs and stumps lie. Pure (no three.js) so the density can be checked from a script.
// Dead wood follows the stand: most logs lie near snags and big old trees (often the snag's own fallen top), few in
// young regrowth, none on road verges, near the compound, across a viewpoint or through a standing trunk, and only
// on ground flat enough for a straight trunk to rest on.

/** Log meshes: length (m), butt radius (m). Several so neighbours never repeat. */
export const LOG_SHAPES = [
  { len: 4.2, r: 0.16 },
  { len: 6.5, r: 0.22 },
  { len: 8.5, r: 0.3 },
  { len: 11, r: 0.36 },
  { len: 14, r: 0.45 },
  { len: 3.2, r: 0.4 },
] as const
export const STUMP_SHAPES = 2

export type Deadwood = { kind: "log" | "stump"; shape: number; x: number; y: number; z: number; scale: number; yaw: number }

const kindOf = VARIANTS.map((v) => v.kind)
const VIEW_POINTS = Object.values(VIEWPOINTS).map((v) => [v.pos[0], v.pos[2]] as const)

/** Calls `f(k)` for trees within `r` of (x, z). */
function nearTrees(trees: Trees, x: number, z: number, r: number, f: (k: number) => void) {
  const g = trees.grid
  const i0 = Math.max(0, Math.floor((x - r + WORLD_HALF) / g.size))
  const i1 = Math.min(g.n - 1, Math.floor((x + r + WORLD_HALF) / g.size))
  const j0 = Math.max(0, Math.floor((z - r + WORLD_HALF) / g.size))
  const j1 = Math.min(g.n - 1, Math.floor((z + r + WORLD_HALF) / g.size))
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const c = j * g.n + i
      for (let o = g.cellStart[c]!; o < g.cellStart[c + 1]!; o++) {
        const k = g.order[o]!
        if ((trees.x[k]! - x) ** 2 + (trees.z[k]! - z) ** 2 <= r * r) f(k)
      }
    }
}

function clearOfTrunks(trees: Trees, ax: number, az: number, bx: number, bz: number, rad: number) {
  const mx = (ax + bx) / 2
  const mz = (az + bz) / 2
  const half = Math.hypot(bx - ax, bz - az) / 2
  let ok = true
  nearTrees(trees, mx, mz, half + 1.5, (k) => {
    if (!ok || kindOf[trees.variant[k]!] === "sapling") return
    const px = trees.x[k]! - ax
    const pz = trees.z[k]! - az
    const dx = bx - ax
    const dz = bz - az
    const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / (dx * dx + dz * dz || 1)))
    if (Math.hypot(px - dx * t, pz - dz * t) < rad + 0.25 + 0.4 * trees.scale[k]!) ok = false
  })
  return ok
}

/** Dead wood whose anchor lies in the `size`-metre cell (ci, cj). */
export function deadwoodInCell(trees: Trees, ci: number, cj: number, size: number): Deadwood[] {
  const out: Deadwood[] = []
  const x0 = ci * size
  const z0 = cj * size
  const cx = x0 + size / 2
  const cz = z0 + size / 2
  if (roadEdgeDistance(cx, cz) < 4 || compoundDistance(cx, cz) < 4) return out

  // Stand around the cell: snags, big old trees, young regrowth.
  let snag = -1
  let old = 0
  let young = 0
  let mature = 0
  nearTrees(trees, cx, cz, 13, (k) => {
    const kind = kindOf[trees.variant[k]!]
    if (kind === "snag") snag = k
    else if (kind === "young" || kind === "sapling") young++
    else {
      mature++
      if (trees.scale[k]! > 1.02) old++
    }
  })
  const youngShare = young / (young + mature + 1)
  // Patchy at a larger scale too, so dead wood comes in clusters rather than an even scatter.
  const patch = fbm(cx, cz, 2, 1 / 60, 71) * 0.5 + 0.5
  const pLog = ((snag >= 0 ? 0.42 : 0.04) + 0.035 * Math.min(old, 3)) * (1 - youngShare * 0.8) * (0.35 + patch * 1.3)

  if (hash3(ci, cj, 90) < pLog) {
    const shape = Math.floor(hash3(ci, cj, 93) * LOG_SHAPES.length)
    const L = LOG_SHAPES[shape]!
    const scale = 0.8 + hash3(ci, cj, 95) * 0.45
    const len = L.len * scale
    const rad = L.r * scale
    let x: number
    let z: number
    let yaw = hash3(ci, cj, 94) * Math.PI * 2
    if (snag >= 0 && hash3(ci, cj, 89) < 0.6) {
      // The snag's broken-off top, lying where it fell (thinner, near its base).
      const d = len / 2 + 0.8 + hash3(ci, cj, 88) * 2
      x = trees.x[snag]! + Math.cos(yaw) * d
      z = trees.z[snag]! + Math.sin(yaw) * d
    } else {
      x = x0 + hash3(ci, cj, 91) * size
      z = z0 + hash3(ci, cj, 92) * size
    }
    const dx = (Math.cos(yaw) * len) / 2
    const dz = (Math.sin(yaw) * len) / 2
    const ha = heightAt(x - dx, z - dz)
    const hb = heightAt(x + dx, z + dz)
    const hm = heightAt(x, z)
    const road = Math.min(roadEdgeDistance(x, z), roadEdgeDistance(x + dx, z + dz), roadEdgeDistance(x - dx, z - dz))
    const comp = Math.min(compoundDistance(x + dx, z + dz), compoundDistance(x - dx, z - dz), northTrackDistance(x, z) - 2)
    const onView = VIEW_POINTS.some(([vx, vz]) => Math.hypot(vx - x, vz - z) < len / 2 + 4)
    const flat = Math.abs(ha - hb) < 0.35 + rad && Math.abs(hm - (ha + hb) / 2) < 0.3 + rad * 0.5
    if (road > 6 && comp > 8 && !onView && flat && clearOfTrunks(trees, x - dx, z - dz, x + dx, z + dz, rad)) {
      // Settled into the duff: the axis sits at 45-60 % of the radius above the lowest ground under it.
      const y = Math.min(ha, hb, hm) + rad * (0.45 + hash3(ci, cj, 87) * 0.15)
      out.push({ kind: "log", shape, x, y, z, scale, yaw })
    }
  }

  const pStump = (snag >= 0 ? 0.05 : 0.02) + 0.01 * Math.min(old, 3)
  if (hash3(ci, cj, 80) < pStump) {
    const x = x0 + hash3(ci, cj, 96) * size
    const z = z0 + hash3(ci, cj, 97) * size
    if (roadEdgeDistance(x, z) > 4 && compoundDistance(x, z) > 6 && northTrackDistance(x, z) > 3 && clearOfTrunks(trees, x, z, x + 0.01, z, 0.5)) {
      out.push({ kind: "stump", shape: hash3(ci, cj, 86) < 0.5 ? 0 : 1, x, y: heightAt(x, z), z, scale: 0.6 + hash3(ci, cj, 98) * 0.7, yaw: hash3(ci, cj, 99) * 6.28 })
    }
  }
  return out
}
