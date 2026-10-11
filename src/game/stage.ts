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
    // dir-d-lowpoly-1: robber drifting up the x=228 avenue (screen up-right), three cruisers strung out behind
    // toward the screen's lower left, heli off to the upper left with its beam on the road ahead.
    put(r.body, 226, 150, 0.1, 2, 21)
    const trail = [
      [222, 128, 0.25],
      [231, 112, -0.1],
      [225, 96, 0.05],
    ] as const
    trail.forEach(([x, z, h], i) => cops[i] && put(cops[i]!.body, x, z, h, 0, 18))
    Object.assign(w.heli, { active: true, x: 250, y: 16, z: 160, h: -1.6, sx: 238, sz: 186 })
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
