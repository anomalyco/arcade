import { VEHICLE } from "./vehicle"
import type { Unit } from "./protocol"
import { UNIT_BODY, WORLD_H, WORLD_W, embedded, footGround, isSolid, type Mask } from "./terrain"

export const MOVE_PX = 4
export const MAX_DROP = 48
export const EDGE = 8

// One pixel of surface walking. Returns the new resting y, or null when blocked
// (wall or slope steeper than `climb`, low ceiling, cliff drop, map edge).
export function stepTo(mask: Mask, x: number, y: number, dir: -1 | 1, climb: number, maxDrop = MAX_DROP): { x: number; y: number } | null {
  const nx = Math.floor(x) + dir
  if (nx < EDGE || nx > WORLD_W - EDGE) return null
  const feet = Math.floor(y + UNIT_BODY)
  const from = feet - climb
  const g = footGround(mask, nx, from)
  // solid right at the top of the climb window means the wall continues upward
  if (g === from && (isSolid(mask, nx - 3, from - 1) || isSolid(mask, nx, from - 1) || isSolid(mask, nx + 3, from - 1))) return null
  if (g >= WORLD_H || g - feet > maxDrop) return null
  const ny = g - UNIT_BODY
  if (embedded(mask, nx, ny)) return null
  return { x: nx, y: ny }
}

// Walk up to `px` pixels along the surface without fuel. Used for vortex pulls and bots.
export function walk(mask: Mask, x: number, y: number, dir: -1 | 1, px: number, climb: number, maxDrop = MAX_DROP): { x: number; y: number; moved: number } {
  let cx = x
  let cy = y
  let moved = 0
  for (let i = 0; i < px; i++) {
    const next = stepTo(mask, cx, cy, dir, climb, maxDrop)
    if (!next) break
    cx = next.x
    cy = next.y
    moved++
  }
  return { x: cx, y: cy, moved }
}

// Player/bot driving during the aim phase. Advances a few px along the surface,
// climbing small steps, refusing steep slopes and drops, consuming fuel.
// Mutates the unit and returns whether it moved.
export function moveUnit(mask: Mask, unit: Unit, dir: -1 | 1): boolean {
  if (!unit.alive || unit.fuel <= 0) return false
  const climb = VEHICLE.climb
  // settle first in case the unit rests on a fractional y
  if (!embedded(mask, unit.x, unit.y)) {
    const g = footGround(mask, unit.x, Math.floor(unit.y + UNIT_BODY))
    if (g < WORLD_H && g - Math.floor(unit.y + UNIT_BODY) <= 2) unit.y = g - UNIT_BODY
  }
  let moved = false
  for (let i = 0; i < MOVE_PX; i++) {
    if (unit.fuel <= 0) break
    const next = stepTo(mask, unit.x, unit.y, dir, climb)
    if (!next) break
    const rise = Math.max(0, unit.y - next.y)
    unit.fuel = Math.max(0, unit.fuel - (1 + rise * 0.5))
    unit.x = next.x
    unit.y = next.y
    moved = true
  }
  return moved
}
