import { cosApprox, sinApprox } from "./creature"
import { nextRandom, trailDistance, treesNear, type Tree, type WoodsWorld } from "./world"

/**
 * Signs of the spider, placed from a seed so every machine puts them in the same spots (pure: + − × ÷ √ and
 * `nextRandom`). A web strung across the trail between two trunks with torn pink search tape caught in it, and
 * silk-wrapped bundles hanging high in the canopy near it: one the length of a person, the rest smaller.
 *
 * Placement is here and drawing is in `src/spider-signs-view.ts`, so anything that needs the evidence (the night's
 * ending, a clue, the map) can call `placeSpiderSigns(world, seed)` and get the same web and bundles the woods show.
 */

/** A web across a gap between two trunks (world metres). The web hangs in the vertical plane through both trunks. */
export type SpiderWeb = {
  /** Its two anchor trees (`world.trees` ids). */
  trees: readonly [number, number]
  /** Where the web's hub is, and how far its frame reaches from the hub. */
  x: number
  y: number
  z: number
  radius: number
  /** Unit direction from the first anchor towards the second (the web's plane holds it and +y). */
  ux: number
  uz: number
  /** Torn strips of search tape caught in it. */
  tape: number
  seed: number
}

/** A silk-wrapped bundle hanging on a strand from a branch, high in a tree. */
export type SilkBundle = {
  tree: number
  /** Its middle (m); the strand runs straight up from its top by `strand` m. */
  x: number
  y: number
  z: number
  length: number
  radius: number
  strand: number
  /** "person" is the length of one; the rest are deer or smaller. */
  size: "person" | "deer" | "small"
  seed: number
}

export type SpiderSigns = { webs: SpiderWeb[]; bundles: SilkBundle[] }

/** The web is on the trail between these shares of its length (0 at camp), between trunks 2.5–7 m apart. */
const WEB_ALONG: readonly [number, number] = [0.35, 0.9]
const WEB_GAP: readonly [number, number] = [2.5, 7]
/** Bundles are 12–40 m from the web, on trees at least 14 m tall, hung from 8–12 m up. */
const BUNDLE_RANGE: readonly [number, number] = [12, 40]

const pick = <T>(rng: { seed: number }, list: readonly T[]): T | undefined => list[Math.floor(nextRandom(rng) * list.length) % Math.max(1, list.length)]

/** Two trunks either side of the trail, 2.5–7 m apart, the trail running between them. */
function webOnTrail(world: WoodsWorld, rng: { seed: number }): SpiderWeb | null {
  const pts = world.trail.points, n = pts.length - 1
  const scratch: Tree[] = []
  for (let attempt = 0; attempt < 24; attempt++) {
    const s = WEB_ALONG[0] + (WEB_ALONG[1] - WEB_ALONG[0]) * nextRandom(rng)
    const i = Math.min(n - 1, Math.floor(s * n)), f = s * n - i
    const a = pts[i]!, b = pts[i + 1]!
    const cx = a[0] + (b[0] - a[0]) * f, cz = a[1] + (b[1] - a[1]) * f
    const near = treesNear(world, cx, cz, WEB_GAP[1], scratch).slice()
    let best: [Tree, Tree] | null = null, bestScore = Infinity
    for (let p = 0; p < near.length; p++) for (let q = p + 1; q < near.length; q++) {
      const t = near[p]!, u = near[q]!
      const gap = Math.sqrt((t.x - u.x) ** 2 + (t.z - u.z) ** 2) - t.radius - u.radius
      if (gap < WEB_GAP[0] || gap > WEB_GAP[1]) continue
      // The trail runs between them: its nearest point lies near the middle of the gap.
      const mx = (t.x + u.x) / 2, mz = (t.z + u.z) / 2
      const off = trailDistance(world.trail, mx, mz).d
      if (off > 1.2) continue
      const da = trailDistance(world.trail, t.x, t.z).d, db = trailDistance(world.trail, u.x, u.z).d
      if (da < 0.8 || db < 0.8) continue
      const score = off + Math.abs(gap - 4) * 0.3
      if (score < bestScore) { bestScore = score; best = [t, u] }
    }
    if (!best) continue
    const [t, u] = best
    const dx = u.x - t.x, dz = u.z - t.z, d = Math.sqrt(dx * dx + dz * dz)
    const ux = dx / d, uz = dz / d
    // The hub sits between the bark faces, a little nearer one side.
    const span = d - t.radius - u.radius
    const hub = t.radius + span * (0.42 + 0.16 * nextRandom(rng))
    const radius = Math.min(span * 0.5, 2.1)
    const x = t.x + ux * hub, z = t.z + uz * hub
    const ground = Math.min(t.y, u.y)
    return { trees: [t.id, u.id], x, y: ground + radius + 0.35 + 0.4 * nextRandom(rng), z, radius, ux, uz, tape: 2, seed: nextRandom(rng) }
  }
  return null
}

function bundlesNear(world: WoodsWorld, rng: { seed: number }, x: number, z: number): SilkBundle[] {
  const tall = treesNear(world, x, z, BUNDLE_RANGE[1]).filter((t) => {
    const d = Math.sqrt((t.x - x) ** 2 + (t.z - z) ** 2)
    return t.height >= 14 && d >= BUNDLE_RANGE[0] && t.species !== "snag"
  })
  const out: SilkBundle[] = []
  const sizes: SilkBundle["size"][] = ["person", "deer", "small"]
  for (const size of sizes) {
    const t = pick(rng, tall.filter((c) => !out.some((b) => b.tree === c.id)))
    if (!t) break
    const a = nextRandom(rng) * 6.283185307179586
    // Out along a branch: 1.2–2.2 m from the trunk.
    const reach = t.radius + 1.2 + nextRandom(rng)
    const length = size === "person" ? 1.75 + 0.15 * nextRandom(rng) : size === "deer" ? 1.3 + 0.2 * nextRandom(rng) : 0.6 + 0.2 * nextRandom(rng)
    const radius = size === "person" ? 0.27 : size === "deer" ? 0.32 : 0.16
    const top = t.y + Math.min(t.height * 0.6, 8 + 4 * nextRandom(rng))
    const strand = 0.3 + 0.9 * nextRandom(rng)
    out.push({ tree: t.id, x: t.x + cosApprox(a) * reach, y: top - strand - length / 2, z: t.z + sinApprox(a) * reach, length, radius, strand, size, seed: nextRandom(rng) })
  }
  return out
}

/** The night's signs of the spider (the same for a world and seed on every machine). */
export function placeSpiderSigns(world: WoodsWorld, seed: number): SpiderSigns {
  const rng = { seed: (seed ^ 0x51c5) * 2654435761 | 0 }
  const web = webOnTrail(world, rng)
  const at = web ?? { x: world.trail.points[world.trail.points.length - 1]![0], z: world.trail.points[world.trail.points.length - 1]![1] }
  return { webs: web ? [web] : [], bundles: bundlesNear(world, rng, at.x, at.z) }
}
