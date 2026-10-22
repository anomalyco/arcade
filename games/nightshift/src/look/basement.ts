import { Mesh, hex } from "@arcade/kit/gpu/mesh"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import type { FogLamp } from "@arcade/kit/gpu/fog-scatter"
import { hash01, lampFlicker } from "@arcade/kit/gpu/lights/flicker"
import { SURFACE, box, tube } from "../world"
import { BASEMENT_X as X } from "../descent/state"

/** Rack rows along each side of the corridor (descent/room.ts): rack z, CRT bank 1.42 m beyond it at 45°. */
const ROWS = Array.from({ length: 7 }, (_, row) => ({ row, z: 5.6 - row * 2.9 }))
const DOOR_Z = -15.9
const shell = [hex(0x8f8a6d), hex(0x6d715c), hex(0x7c7963)]

/**
 * The basement, darker and stranger (AR-129): extra CRT tiers so every bank is a wall of screens, and thick cable
 * bundles snaking along the floor from every bank to the lit door. Screens are SURFACE.hallScreen (procedural text,
 * shared sync); the cables carry no colliders and stay out of the walkable aisle's middle.
 */
export function basementDressing(): Mesh {
  const m = new Mesh()
  for (const side of [-1, 1]) for (const { row, z } of ROWS) {
    const cx = X + side * 2.05, cz = z + 1.42, yaw = -side * Math.PI / 4, cos = Math.cos(yaw), sin = Math.sin(yaw)
    for (let tier = row % 2 ? 2 : 3; tier < 4; tier++) {
      const first = m.v.length, cy = .06 + tier * .62, cw = .62 + hash01(row * 7 + tier, side + 3) * .14, ch = .44
      box(m, cx, cy, cz, cw + .1, ch + .08, .5, shell[(row + tier) % 3]!, SURFACE.plastic, .025)
      box(m, cx, cy + .04, cz + .255, cw, ch, .03, hex(0x101410), SURFACE.metal, .02)
      box(m, cx, cy + .07, cz + .272, cw - .07, ch - .06, .004, hex(0x0b1a10), SURFACE.hallScreen)
      for (let i = first; i < m.v.length; i += 11) {
        const dx = m.v[i]! - cx, dz = m.v[i + 2]! - cz, nx = m.v[i + 3]!, nz = m.v[i + 5]!
        m.v[i] = cx + cos * dx + sin * dz; m.v[i + 2] = cz - sin * dx + cos * dz
        m.v[i + 3] = cos * nx + sin * nz; m.v[i + 5] = -sin * nx + cos * nz
      }
    }
    // Four to six cables leave each bank, drop to the floor and join the trunk along the rack fronts; the trunks
    // converge on the door over the last few metres.
    const count = 4 + Math.floor(hash01(row, side + 11) * 3)
    for (let k = 0; k < count; k++) {
      const r = .012 + hash01(row * 13 + k, side) * .01, wob = hash01(row, k + 40) * 6
      const lane = X + side * (1.45 - k * .035), start = [cx - side * .42, .02, cz - .2], steps = 40
      const at = (t: number) => {
        const z = start[2]! + (DOOR_Z - start[2]!) * t, join = Math.min(1, t * 12), toDoor = Math.max(0, Math.min(1, (z + 12.5) / -3.2))
        const along = start[0]! + (lane - start[0]!) * join * join * (3 - 2 * join)
        const x = along + (X + side * (.12 + k * .035) - along) * toDoor * toDoor + Math.sin(z * 1.7 + wob) * .025
        return [x, r + (k % 2) * r * 1.5 * (1 - toDoor), z]
      }
      for (let j = 0; j < steps; j++) tube(m, at(j / steps), at((j + 1) / steps), r, hex(k % 3 ? 0x1b1e19 : 0x26251f), SURFACE.plastic, 6)
    }
  }
  // Light from beyond the door: a wired-glass pane, the gaps around the leaf and a hot line under it.
  const dz = -15.995
  box(m, X - .1, 1.15, dz, .34, .62, .006, hex(0xe6b36d), SURFACE.doorGlow)
  box(m, X - .578, .02, dz, .008, 2.24, .006, hex(0xe6b36d), SURFACE.doorGlow)
  // Ajar: the latch side shows a hot strip of the room beyond.
  box(m, X + .56, .02, dz, .035, 2.24, .006, hex(0xe6b36d), SURFACE.doorGlow)
  box(m, X, 2.27, dz, 1.15, .008, .006, hex(0xe6b36d), SURFACE.doorGlow)
  box(m, X, .001, -15.97, 1.1, .002, .05, hex(0xe6b36d), SURFACE.doorGlow)
  return m
}

/** Lamp ids the basement look recognises by position (descent/room.ts owns them). */
const isCeiling = (l: SceneLight) => l.h === 2.7
const isCrt = (l: SceneLight) => l.h === 1.1 && l.color[1] > .6
const isSconce = (l: SceneLight) => l.h === 2.1
const isDoor = (l: SceneLight) => l.id === 39

/**
 * Basement light: the practicals fail. The ceiling fitting by the car stutters, the middle one goes out as you walk
 * under it, the far one is dead; sconces are dim; the screens' own glow does most of the lighting; the door is the
 * brightest thing. Returns the two ceiling fittings' levels for their emissive panels.
 */
export class BasementLight {
  private outAt = NaN
  levels: [number, number] = [1, 1]
  apply(lamps: SceneLight[], time: number, eye: readonly number[], wrong: number, sync: number) {
    if (!(wrong > 0)) this.outAt = NaN
    if (Number.isNaN(this.outAt) && wrong > 0 && Math.abs(eye[2]! + 2) < 2.6) this.outAt = time
    const near = .3 + .7 * lampFlicker("fluorescent", 63, time, 1.4).level
    const mid = tubeOut(time - this.outAt)
    this.levels = [near, mid]
    for (const l of lamps) {
      if (isCeiling(l)) l.power *= l.y > 3 ? .3 * near : l.y > -5 ? .4 * mid : 0
      else if (isCrt(l)) l.power *= 5 * sync
      else if (isSconce(l)) l.power *= l.y > 0 && l.y < 7 ? .35 * lampFlicker("fluorescent", 71, time, .6).level : .3
      else if (isDoor(l)) l.power *= 3
    }
  }
  reset() { this.outAt = NaN; this.levels = [1, 1] }
}

/** The screen walls' glow in the haze: one fog lamp per bank nearest the door, as far as the fog budget allows. */
export function basementFogLamps(time: number, sync: number, budget: number): FogLamp[] {
  if (budget <= 0) return []
  // The door's own halo first, so it always makes the budget.
  const out: FogLamp[] = [{ id: 59, x: X, y: 1.2, z: -15.7, range: 4.5, color: [1, .5, .18], intensity: .9, size: .5 }]
  for (const { row, z } of ROWS) for (const side of [-1, 1]) {
    if (out.length >= budget) return out
    out.push({ id: 60 + row * 2 + (side > 0 ? 1 : 0), x: X + side * 1.75, y: 1.1, z: z + 1.42, range: 2.6, color: [.3, .85, .45], intensity: .22 * sync * (.92 + .08 * Math.sin(time * 3.1 + row)), size: .6 })
  }
  return out
}

/** The middle ceiling fitting's last sputters, then dark (NaN elapsed: still on). */
export function tubeOut(elapsed: number) {
  if (!(elapsed >= 0)) return 1
  if (elapsed > .9) return 0
  return hash01(Math.floor(elapsed * 22), 5) > .35 + elapsed * .6 ? 1 - elapsed : 0
}
