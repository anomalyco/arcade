import { CELL, GRID, ROAD_HALF } from "../../../shared/config"
import type { City } from "../../../shared/sim/city"
import { mulberry32 } from "../../../shared/sim/rng"

export const PROP_KINDS = ["cone", "barrier", "sawhorse", "bin", "dumpster", "newspaper", "bench", "planter", "crate", "pallet", "sign", "hydrant", "meter", "mailbox", "propane", "canister", "fuel"] as const
export type PropKind = typeof PROP_KINDS[number]
export type PropSpec = { size: [number, number, number]; mass: number; breakSpeed: number; color: [number, number, number]; explosive?: boolean }
export const SPECS: Record<PropKind, PropSpec> = {
  cone: { size: [.65, .95, .65], mass: 3, breakSpeed: 35, color: [.95, .3, .045] },
  barrier: { size: [2.6, 1.45, .8], mass: 16, breakSpeed: 18, color: [.92, .56, .16] },
  sawhorse: { size: [2, 1.05, .7], mass: 10, breakSpeed: 15, color: [.55, .35, .15] },
  bin: { size: [.8, 1.15, .8], mass: 12, breakSpeed: 26, color: [.16, .35, .25] },
  dumpster: { size: [2.2, 1.6, 1.25], mass: 110, breakSpeed: 40, color: [.15, .31, .24] },
  newspaper: { size: [.7, 1.25, .7], mass: 18, breakSpeed: 22, color: [.64, .2, .12] },
  bench: { size: [2.4, 1, .8], mass: 35, breakSpeed: 23, color: [.48, .3, .16] },
  planter: { size: [1, 1.15, 1], mass: 45, breakSpeed: 18, color: [.55, .43, .34] },
  crate: { size: [1.1, 1.1, 1.1], mass: 14, breakSpeed: 14, color: [.58, .38, .18] },
  pallet: { size: [1.3, .22, 1.2], mass: 12, breakSpeed: 13, color: [.48, .32, .17] },
  sign: { size: [.9, 1.65, .7], mass: 9, breakSpeed: 22, color: [.93, .58, .08] },
  hydrant: { size: [.6, .95, .45], mass: 28, breakSpeed: 40, color: [.73, .16, .1] },
  meter: { size: [.32, 1.6, .32], mass: 12, breakSpeed: 24, color: [.35, .39, .4] },
  mailbox: { size: [.7, 1.4, .65], mass: 18, breakSpeed: 24, color: [.16, .32, .65] },
  propane: { size: [.65, 1.1, .65], mass: 22, breakSpeed: 12, color: [.75, .76, .72], explosive: true },
  canister: { size: [.55, .7, .36], mass: 10, breakSpeed: 14, color: [.68, .19, .09], explosive: true },
  fuel: { size: [.85, 1.25, .85], mass: 45, breakSpeed: 15, color: [.67, .27, .08], explosive: true },
}
export type Placement = { kind: PropKind; x: number; z: number; y: number; yaw: number }

/** Full bounding footprint, including yaw. Main roads and the rounded junction corners remain clear. */
export function placementClear(city: City, p: Placement) {
  const s = SPECS[p.kind].size, c = Math.abs(Math.cos(p.yaw)), sn = Math.abs(Math.sin(p.yaw))
  const hx = (s[0] * c + s[2] * sn) / 2 + .2, hz = (s[0] * sn + s[2] * c) / 2 + .2
  if (p.z < city.waterZ) {
    const x = ((p.x % CELL) + CELL) % CELL, z = ((p.z % CELL) + CELL) % CELL
    if (Math.min(x, CELL - x) < ROAD_HALF + hx || Math.min(z, CELL - z) < ROAD_HALF + hz) return false
    if (Math.min(x, CELL - x) < ROAD_HALF + 5 && Math.min(z, CELL - z) < ROAD_HALF + 5) return false
  }
  if (city.boxes.some(b => p.x + hx > b.x0 && p.x - hx < b.x1 && p.z + hz > b.z0 && p.z - hz < b.z1)) return false
  if (city.trees.some(t => Math.hypot(t.x - p.x, t.z - p.z) < Math.max(hx, hz) + 1.1)) return false
  if (city.lamps.some(l => Math.hypot((l.px ?? l.x) - p.x, (l.pz ?? l.z) - p.z) < Math.max(hx, hz) + .4)) return false
  if (city.shops.some(s => p.x + hx > s.bay.x0 && p.x - hx < s.bay.x1 && p.z + hz > s.bay.z0 && p.z - hz < s.bay.z1)) return false
  if (city.ramps.some(r => Math.hypot(p.x - r.x, p.z - r.z) < Math.hypot(r.width, r.length) / 2 + Math.max(hx, hz))) return false
  return true
}

export function placeProps(city: City): Placement[] {
  const rng = mulberry32(city.seed ^ 0x63a7b19), out: Placement[] = []
  const add = (kind: PropKind, x: number, z: number, yaw = 0, y = .16) => {
    const p = { kind, x, z, yaw, y }
    if (!placementClear(city, p)) return
    const radius = Math.hypot(SPECS[kind].size[0], SPECS[kind].size[2]) / 2
    if (out.some(q => Math.hypot(q.x - x, q.z - z) < radius + Math.hypot(SPECS[q.kind].size[0], SPECS[q.kind].size[2]) / 2 + .3)) return
    out.push(p)
  }
  const street: PropKind[] = ["bin", "bench", "hydrant", "meter", "mailbox", "newspaper", "planter", "cone"]
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
    for (const side of [-1, 1]) for (let k = 0; k < 5; k++) {
      const t = 17 + k * 10 + rng() * 2, edge = side < 0 ? ROAD_HALF + 1.5 : CELL - ROAD_HALF - 1.5
      add(street[Math.floor(rng() * street.length)]!, i * CELL + t, j * CELL + edge, side < 0 ? Math.PI : 0)
      add(street[Math.floor(rng() * street.length)]!, i * CELL + edge, j * CELL + t, side < 0 ? -Math.PI / 2 : Math.PI / 2)
    }
    // Small construction groups stay on the pavement, with fuel set back from the lane.
    if (rng() < .28) {
      const x = i * CELL + 20, z = j * CELL + ROAD_HALF + 2.8
      for (let k = 0; k < 4; k++) add("cone", x + k * 2, z - 1.8)
      add("barrier", x + 10, z, 0)
      add("sign", x + 14, z)
      add("propane", x + 17, z)
      add("canister", x + 18.4, z)
    }
  }
  for (const a of city.alleys) {
    const vertical = a.z1 - a.z0 > a.x1 - a.x0
    for (let t = 8; t < Math.max(a.z1 - a.z0, a.x1 - a.x0) - 5; t += 14) {
      const kind: PropKind = rng() < .45 ? "dumpster" : rng() < .5 ? "crate" : "pallet"
      add(kind, vertical ? a.x0 + 1.2 : a.x0 + t, vertical ? a.z0 + t : a.z0 + 1.2, vertical ? Math.PI / 2 : 0, 0)
    }
  }
  for (const p of city.parks) for (const side of [-1, 1]) for (let k = 0; k < 4; k++) {
    add(k % 2 ? "planter" : "bench", p.x0 + 10 + k * 12, side < 0 ? p.z0 + 2 : p.z1 - 2)
  }
  // The plaza has a broad lower promenade inside its tree row. Dress that usable
  // space rather than hiding every bench in the narrow gap beside a kerb tree.
  for (const p of city.parks) if (p.kind === "plaza") for (const side of [-1, 1]) for (let k = 0; k < 5; k++) {
    const x = side < 0 ? p.x0 + 6 : p.x1 - 6, z = p.z0 + 12 + k * 8
    add("bench", x, z, Math.PI / 2)
    add(k % 2 ? "newspaper" : "bin", x, z + 3, Math.PI / 2)
  }
  for (let x = 16; x < city.max - 10; x += 24) {
    // The quay beyond waterZ is behind the authoritative boundary wall. Dress its
    // accessible landward pavement, not the unreachable strip over the water.
    const z = GRID * CELL - ROAD_HALF - 3.3
    add("crate", x, z, .1)
    add("pallet", x + 2.4, z)
    add("fuel", x + 4.4, z)
    add("propane", x + 5.7, z)
    add("sawhorse", x + 9, z)
  }
  return out
}
