import { SIZE, type Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { putSprite, smoothstep } from "./light-probe"
import { isHome } from "./placement"

/**
 * After rain: water running off the eaves and the trees falls in drops for a long while, and each drop rings the
 * puddle or wet paving below. Drip points sit along the front eaves of the homes (heavier at the downpipe corners) and
 * under tree canopies; each drips on its own period, a pure function of the clock, so nothing is kept per drop. The
 * rings are only seen in light, like the rain.
 */

export type DripPoint = { x: number; y: number; z: number; period: number; phase: number; heavy: boolean }

/** Seconds a ring takes to spread and fade, and its widest size (m). */
export const RING_LIFE = 0.6
export const RING_SIZE = 0.2

const fract = (v: number) => v - Math.floor(v)
const r01 = (a: number, b: number) => fract(Math.sin(a * 12.9898 + b * 78.233) * 43758.5453)

/** How hard the eaves and trees drip (0..1) for the weather now: once the ground is soaked, strongest as the rain eases. */
export function dripLevel(wetness: number, rain: number): number {
  return smoothstep(0.25, 0.7, wetness) * (1 - 0.6 * smoothstep(0.4, 0.9, rain))
}

/** The town's drip points: along each home's front eave line (0.35 m out), and a few under every yard tree. */
export function placeDrips(town: Town, density: number): DripPoint[] {
  const out: DripPoint[] = []
  if (density <= 0) return out
  for (const b of town.buildings) {
    if (!isHome(b)) continue
    const [x0, , x1, z1] = b.rect
    const z = z1 + 0.35
    for (let x = x0 + 0.35, i = 0; x < x1 - 0.3; x += 0.62, i++) {
      const corner = x === x0 + 0.35 || x + 0.62 >= x1 - 0.3
      const roll = r01(x * 3.1 + town.seed, z * 1.7)
      if (!corner && roll > 0.4 * density) continue
      out.push({ x, y: supportHeight(town, x, z + 0.05), z: z + 0.05, period: corner ? 0.35 + roll * 0.25 : 0.9 + roll * 1.8, phase: r01(x, i + 3), heavy: corner })
    }
  }
  for (const p of town.props) {
    if (p.kind !== "tree") continue
    const n = Math.round(3 * density)
    for (let i = 0; i < n; i++) {
      const a = r01(p.x + i, p.y) * Math.PI * 2
      const d = 0.6 + r01(p.y + i, p.x) * 1.3
      const x = p.x + Math.cos(a) * d
      const z = p.y + Math.sin(a) * d
      if (fold(x) > 39.6 && fold(x) < 48.4 && fold(z) > 39.6 && fold(z) < 48.4) continue
      out.push({ x, y: supportHeight(town, x, z), z, period: 1.4 + r01(x, z) * 2.6, phase: r01(z, x), heavy: false })
    }
  }
  return out
}

const fold = (v: number) => ((v % SIZE) + SIZE) % SIZE

/**
 * Ripple rings (ground-plane ring sprites, alpha) and a splash fleck at each drip point in `view` whose drop is
 * landing now. `level` is `dripLevel`; slower drips at lower levels, none at 0. `light(x, z)` 0..1.
 */
export function writeDrips(points: readonly DripPoint[], level: number, time: number, light: (x: number, z: number) => number, view: readonly [number, number, number, number], sprites: Float32Array, n: number, cap: number): number {
  if (level <= 0.02) return n
  const [x0, z0, x1, z1] = view
  let drawn = 0
  for (const p of points) {
    if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue
    // As the eaves run dry the drops come further apart.
    const period = p.period / (0.25 + 0.75 * level)
    const u = fract(time / period + p.phase) * (period / RING_LIFE)
    if (u >= 1) continue
    const lit = light(p.x, p.z)
    if (lit <= 0.03) continue
    const k = 0.75 * lit
    const a = (1 - u) ** 1.6 * (p.heavy ? 0.5 : 0.38) * lit * Math.min(1, level * 1.6)
    const size = 0.03 + RING_SIZE * Math.sqrt(u) * (p.heavy ? 1.2 : 1)
    n = putSprite(sprites, n, p.x, p.y + 0.012, p.z, size, k, k * 1.01, k * 1.03, a, 2, 0, 0.16)
    if (u < 0.18) n = putSprite(sprites, n, p.x, p.y + 0.03 + u * 0.25, p.z, 0.035, k, k, k, a * 0.8)
    if (++drawn >= cap) break
  }
  return n
}
