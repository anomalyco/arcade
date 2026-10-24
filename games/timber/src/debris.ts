// What a chainsaw throws: flat, irregular flakes and thin slivers of pale fresh wood, a few with a skin of dark bark on
// one side, curled a little as they come off the chain. Unit size; the host scales each by its chip size.
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"

/** Fresh sapwood, its torn edge, and bark. Linear albedo. */
const PALE: Rgb = [0.62, 0.47, 0.29]
const EDGE: Rgb = [0.45, 0.32, 0.19]
const BARK: Rgb = [0.07, 0.045, 0.03]

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A thin slab over an outline in the x–z plane, `thick` deep, curled up by `curl` along x. The top is pale wood; the
 * underside is bark when `bark`, else pale too.
 */
function slab(m: Mesh, outline: [number, number][], thick: number, curl: number, bark: boolean): void {
  const lift = (x: number) => curl * x * x
  const top = outline.map(([x, z]): number[] => [x, lift(x) + thick / 2, z])
  const bot = outline.map(([x, z]): number[] => [x, lift(x) - thick / 2, z])
  const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length
  const cz = outline.reduce((s, p) => s + p[1], 0) / outline.length
  const ct = [cx, lift(cx) + thick / 2, cz]
  const cb = [cx, lift(cx) - thick / 2, cz]
  const n = outline.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    m.facet(ct, top[j]!, top[i]!, PALE, MAT.lit)
    m.facet(cb, bot[i]!, bot[j]!, bark ? BARK : [PALE[0] * 0.92, PALE[1] * 0.92, PALE[2] * 0.92], MAT.lit)
    m.quadAuto(top[i]!, top[j]!, bot[j]!, bot[i]!, EDGE, MAT.lit)
  }
}

/** A chip: an irregular flake about 1 × 0.6, 0.07 thick, curled; `bark` puts bark on its underside. */
export function flakeMesh(seed: number, bark: boolean): Mesh {
  const r = rng(seed)
  const m = new Mesh()
  const n = 6 + Math.floor(r() * 3)
  const outline: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.5
    const rad = 0.32 + r() * 0.22
    outline.push([Math.cos(a) * rad * 1.05, Math.sin(a) * rad * 0.62])
  }
  slab(m, outline, 0.07, 0.35 + r() * 0.4, bark)
  return m
}

/** A sliver: a long, narrow, tapering strip about 1 × 0.18, torn ragged at the ends. */
export function sliverMesh(seed: number, bark: boolean): Mesh {
  const r = rng(seed)
  const m = new Mesh()
  const w = 0.07 + r() * 0.05
  const outline: [number, number][] = [
    [-0.5, (r() - 0.5) * w],
    [-0.32, -w * (0.6 + r() * 0.4)],
    [0.1, -w],
    [0.5, -w * 0.25],
    [0.44 + r() * 0.06, w * 0.3],
    [0.05, w],
    [-0.35, w * (0.5 + r() * 0.4)],
  ]
  slab(m, outline, 0.05, 0.2 + r() * 0.3, bark)
  return m
}
