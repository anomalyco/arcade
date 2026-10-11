import type { World } from "../../shared/sim/world"

/**
 * Dev-only staged moments for screenshot comparisons against the concept art (`?stage=<name>`, add `&freeze`
 * to stop the simulation). Positions are around the intersection at (228, 152).
 */
export function applyStage(w: World, name: string) {
  const r = w.robber()
  if (!r) return
  w.phase = "chase"
  w.phaseT = 30
  w.t = 45
  const cops = w.cops()
  const park = (i: number) => Object.assign(cops[i]!.body, { x: -200, z: -200, vx: 0, vz: 0 })
  cops.forEach((_, i) => park(i))
  const put = (b: { x: number; z: number; h: number; vx: number; vz: number }, x: number, z: number, h: number, vx: number, vz: number) => Object.assign(b, { x, z, h, vx, vz })
  if (name === "chase") {
    // dir-d-lowpoly-1: robber drifting through the intersection, three cruisers strung out behind it, heli overhead.
    put(r.body, 236, 150, Math.PI / 2 - 0.75, 20, -4)
    const trail = [
      [214, 156, Math.PI / 2 + 0.15],
      [200, 149, Math.PI / 2 - 0.1],
      [186, 156, Math.PI / 2 + 0.05],
    ] as const
    trail.forEach(([x, z, h], i) => cops[i] && put(cops[i]!.body, x, z, h, 18, 0))
    Object.assign(w.heli, { active: true, x: 214, y: 30, z: 186, h: -0.6, sx: 238, sz: 150 })
  } else if (name === "roadblock") {
    // dir-d-lowpoly-2: suspect pinned by the spotlight, cruisers converging.
    put(r.body, 236, 156, 1.2, 9, 3)
    const ring = [
      [216, 140, 0.9],
      [222, 170, 2.3],
      [252, 168, -2.4],
    ] as const
    ring.forEach(([x, z, h], i) => cops[i] && put(cops[i]!.body, x, z, h, 4, 0))
    Object.assign(w.heli, { active: true, x: 252, y: 30, z: 128, h: 2.6, sx: 236, sz: 156 })
  }
}
