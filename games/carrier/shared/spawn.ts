import { type Archipelago, terrainHeight } from "./islands"
import { hash3 } from "./rng"
import { headingTo } from "./ship"

/**
 * Where a team's ships enter the world: spread around the archipelago instead of all at the origin. The two teams
 * start on opposite sides of a ring (radius SPAWN_RING, a seeded bearing per room), each team's ships SLOT_SPREAD
 * radians apart along it, every one in deep open water and heading in toward the middle. Deterministic per world
 * seed, so the room and every client agree.
 */
export const SPAWN_RING = 4800
const SLOT_SPREAD = 0.42
/** Clear water needed around the spawn point: deeper than this everywhere within CLEAR_RADIUS. */
const CLEAR_DEPTH = -25
const CLEAR_RADIUS = 280

function clearWater(arch: Archipelago, x: number, z: number): boolean {
  if (terrainHeight(arch, x, z) > CLEAR_DEPTH) return false
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    for (const r of [CLEAR_RADIUS * 0.5, CLEAR_RADIUS]) {
      if (terrainHeight(arch, x + Math.cos(a) * r, z + Math.sin(a) * r) > CLEAR_DEPTH) return false
    }
  }
  return true
}

export function fleetSpawn(arch: Archipelago, team: number, slot: number): { x: number; z: number; heading: number } {
  const base = hash3(arch.seed, 0x5a, 0x17) * Math.PI * 2
  const bearing = base + team * Math.PI + (slot - 0.5) * SLOT_SPREAD
  // Search outward from the ideal point for open water: nudge the radius first, then the bearing.
  for (let ring = 0; ring < 14; ring++) {
    const dr = (ring % 2 ? 1 : -1) * Math.ceil(ring / 2) * 350
    for (let step = 0; step < 9; step++) {
      const da = (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 0.04
      const r = SPAWN_RING + dr
      const a = bearing + da
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      if (clearWater(arch, x, z)) return { x, z, heading: headingTo(x, z, 0, 0) }
    }
  }
  const x = Math.cos(bearing) * SPAWN_RING
  const z = Math.sin(bearing) * SPAWN_RING
  return { x, z, heading: headingTo(x, z, 0, 0) }
}
