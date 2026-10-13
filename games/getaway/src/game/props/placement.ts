import { CELL, GRID, ROAD_HALF } from "../../../shared/config"
import type { City } from "../../../shared/sim/city"
import { mulberry32 } from "../../../shared/sim/rng"
import { PROP_SIZE } from "./dimensions"

export const PROP_KINDS = ["cone", "barrier", "sawhorse", "bin", "dumpster", "newspaper", "bench", "planter", "crate", "pallet", "sign", "hydrant", "meter", "mailbox", "propane", "canister", "fuel"] as const
export type PropKind = typeof PROP_KINDS[number]
export type PropSpec = { size: readonly [number, number, number]; mass: number; breakSpeed: number; color: [number, number, number]; explosive?: boolean }
export const SPECS: Record<PropKind, PropSpec> = {
  cone: { size: PROP_SIZE.cone, mass: 3, breakSpeed: 35, color: [.95, .3, .045] },
  barrier: { size: PROP_SIZE.barrier, mass: 16, breakSpeed: 18, color: [.92, .56, .16] },
  sawhorse: { size: PROP_SIZE.sawhorse, mass: 10, breakSpeed: 15, color: [.55, .35, .15] },
  bin: { size: PROP_SIZE.bin, mass: 12, breakSpeed: 26, color: [.16, .35, .25] },
  dumpster: { size: PROP_SIZE.dumpster, mass: 110, breakSpeed: 40, color: [.15, .31, .24] },
  newspaper: { size: PROP_SIZE.newspaper, mass: 18, breakSpeed: 22, color: [.64, .2, .12] },
  bench: { size: PROP_SIZE.bench, mass: 35, breakSpeed: 23, color: [.48, .3, .16] },
  planter: { size: PROP_SIZE.planter, mass: 45, breakSpeed: 18, color: [.55, .43, .34] },
  crate: { size: PROP_SIZE.crate, mass: 14, breakSpeed: 14, color: [.58, .38, .18] },
  pallet: { size: PROP_SIZE.pallet, mass: 12, breakSpeed: 13, color: [.48, .32, .17] },
  sign: { size: PROP_SIZE.sign, mass: 9, breakSpeed: 22, color: [.93, .58, .08] },
  hydrant: { size: PROP_SIZE.hydrant, mass: 28, breakSpeed: 40, color: [.73, .16, .1] },
  meter: { size: PROP_SIZE.meter, mass: 12, breakSpeed: 24, color: [.35, .39, .4] },
  mailbox: { size: PROP_SIZE.mailbox, mass: 18, breakSpeed: 24, color: [.16, .32, .65] },
  propane: { size: PROP_SIZE.propane, mass: 22, breakSpeed: 12, color: [.75, .76, .72], explosive: true },
  canister: { size: PROP_SIZE.canister, mass: 10, breakSpeed: 14, color: [.68, .19, .09], explosive: true },
  fuel: { size: PROP_SIZE.fuel, mass: 45, breakSpeed: 15, color: [.67, .27, .08], explosive: true },
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
