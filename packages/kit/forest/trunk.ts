/**
 * Where a drawn trunk is: pure queries over the same rings, lobes and instance transform `buildForest` draws trees
 * with, so a game can fit things to the bark you see (flagging tape, blazes, nails) without reading GPU buffers.
 */
import { mulberry } from "../sim/forest-demo"
import type { ForestTree } from "../sim/forest-world"
import { intSeed, TREE_SINK, treePlacement, treeVariant, trunkLobes, trunkRings } from "./build"

const TAU = Math.PI * 2

/** The ground as the terrain mesh draws it at (x, z): the game's height on the 1 m grid, read back over its triangles. */
export function drawnGround(height: (x: number, z: number) => number, x: number, z: number): number {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j
  const a = height(i, j), b = height(i + 1, j), c = height(i + 1, j + 1), d = height(i, j + 1)
  return fz > fx ? a + fz * (d - a) + fx * (c - d) : a + fx * (b - a) + fz * (c - b)
}

export type DrawnTrunk = {
  /** World y of the instance's origin (it stands `TREE_SINK` into the drawn ground). */
  base: number
  /** Total height (m) and the instance's wind phase (`forestTrunkSway`). */
  height: number
  phase: number
  /**
   * The horizontal cross-section at world height `y`: the polygon (world x, z pairs in order round the trunk) where
   * that plane cuts the trunk mesh, before wind (a trunk sways ~1 mm at chest height). `near` picks the full-detail
   * trunk (drawn within the quality's `near` distance) or the far one.
   */
  section(y: number, near?: boolean): [number, number][]
  /** The bark's height share at world height `y` as its vertices carry it (`forestTrunkSway`'s `share`). */
  swayShare(y: number): number
}

/**
 * One of a `ForestWorld`'s trees (0..1 or integer seed) as drawn; `worldSeed` and `height` are the world's, `smooth`
 * the build's `smoothTrunks`.
 */
export function drawnTrunk(worldSeed: number, height: (x: number, z: number) => number, tree: ForestTree, smooth = false): DrawnTrunk {
  const t = { ...tree, seed: intSeed(tree.seed) }
  const p = treePlacement(t)
  const v = treeVariant(worldSeed, t.species, p.variant)
  const base = drawnGround(height, t.x, t.z) - TREE_SINK
  const shapes = { near: trunkRings(v, 0, true, mulberry(v.seed), smooth), far: trunkRings(v, 0, false, mulberry(v.seed)) }
  const s = p.trunkScale, c = Math.cos(p.yaw), sn = Math.sin(p.yaw)
  const ringAt = (y: number, near: boolean) => {
    const { ringPts } = near ? shapes.near : shapes.far
    const ty = (y - base) / p.heightScale
    let k = 0
    while (k < ringPts.length - 2 && ringPts[k + 1]!.c[1] < ty) k++
    const a = ringPts[k]!, b = ringPts[k + 1]!
    return { a, b, f: (ty - a.c[1]) / (b.c[1] - a.c[1]) }
  }
  return {
    base, height: t.h, phase: p.phase,
    swayShare(y) {
      // Vertex colour g is the ring's height share, stored as a byte and interpolated between rings.
      const { a, b, f } = ringAt(y, true)
      const g = (ring: typeof a) => Math.round(Math.min(1, Math.max(0, ring.y / v.h)) * 255) / 255
      return g(a) + (g(b) - g(a)) * f
    },
    section(y, near = true) {
      const { s01, sides } = near ? shapes.near : shapes.far
      const { a, b, f } = ringAt(y, near)
      const at = (ring: typeof a, i: number): [number, number] => {
        const th = (i / sides) * TAU, rr = ring.r * trunkLobes(th, ring.y, s01)
        return [ring.c[0] + Math.cos(th) * rr, ring.c[2] + Math.sin(th) * rr]
      }
      const world = (q: [number, number], r: [number, number]): [number, number] => {
        const x = (q[0] + (r[0] - q[0]) * f) * s, z = (q[1] + (r[1] - q[1]) * f) * s
        return [x * c - z * sn + t.x, x * sn + z * c + t.z]
      }
      // Each side's quad is two triangles split along (i, a)–(i + 1, b): the plane crosses the side edge, then that diagonal.
      const out: [number, number][] = []
      for (let i = 0; i < sides; i++) {
        out.push(world(at(a, i), at(b, i)))
        out.push(world(at(a, i), at(b, i + 1)))
      }
      return out
    },
  }
}
