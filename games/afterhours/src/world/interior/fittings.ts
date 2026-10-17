import * as THREE from "three/webgpu"
import type { Lamp } from "../context"
import { MODELS } from "../../render/models"
import { type Builder, CEIL_Y, FLOOR_Y, M, T, TUBE } from "./kit"
import { fluoroLamp, rigLevelOf } from "./lights"
import { placeModels } from "./props"

// Wall fittings shared by every storey (moved from the retired ground-floor corridor builder). Every fitting takes the
// wall's face coordinate and works on either side: zWall < 0 is the north spine wall (fitting faces +z), > 0 south.

/** Rig flicker level for a lamp (panels follow their light). */
export const rigLevel = rigLevelOf

/** Downward troffer lamp (legacy signature: flicker before intensity). */
export const fluoro = (x: number, z: number, flicker?: number, intensity = 4): Lamp => fluoroLamp(x, z, intensity, { flicker })

export function hazardLight(b: Builder, x: number, zWall: number, lit: boolean) {
  const y = FLOOR_Y + 2.55
  const n = zWall < 0 ? 1 : -1
  const z = zWall
  const zc = z + n * 0.1
  b.box("metal_dark", x - 0.08, y - 0.1, Math.min(z, z + n * 0.08), x + 0.08, y - 0.06, Math.max(z, z + n * 0.08))
  b.cyl(lit ? M.hazardRed : M.hazardOff, T(x, y, zc), 0.055, 0.06, 0.14, 12, { cast: false })
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    b.box("metal_dark", x + Math.cos(a) * 0.065 - 0.004, y - 0.07, zc + Math.sin(a) * 0.065 - 0.004, x + Math.cos(a) * 0.065 + 0.004, y + 0.08, zc + Math.sin(a) * 0.065 + 0.004)
  }
  b.cyl("metal_dark", T(x, y + 0.085, zc), 0.07, 0.07, 0.02, 12)
}

/** Recessed-look extinguisher cabinet (steel frame, felt back, glass front) with the extinguisher model inside, on a
 *  wall at zWall facing the corridor; signal panel above. Works on either corridor wall. */
export function extinguisher(b: Builder, x: number, zWall: number) {
  const y0 = FLOOR_Y + 0.9
  const s = zWall < 0 ? 1 : -1
  const z = zWall
  const d = 0.21
  const z1 = z + s * d
  const lo = Math.min(z, z1)
  const hi = Math.max(z, z1)
  b.box(M.frame, x - 0.3, y0, lo, x + 0.3, y0 + 0.03, hi)
  b.box(M.frame, x - 0.3, y0 + 0.77, lo, x + 0.3, y0 + 0.8, hi)
  b.box(M.frame, x - 0.3, y0 + 0.03, lo, x - 0.27, y0 + 0.77, hi)
  b.box(M.frame, x + 0.27, y0 + 0.03, lo, x + 0.3, y0 + 0.77, hi)
  b.box(M.felt, x - 0.27, y0 + 0.03, z + s * 0.004, x + 0.27, y0 + 0.77, z + s * 0.006, { cast: false })
  b.quad(M.glass, T(x, y0 + 0.4, z1 - s * 0.004, s > 0 ? 0 : Math.PI), 0.54, 0.74, { cast: false })
  b.box(M.steel, x + 0.2, y0 + 0.34, z1, x + 0.24, y0 + 0.46, z1 + s * 0.015)
  b.box(M.red, x - 0.18, y0 + 0.86, z, x + 0.18, y0 + 0.98, z + s * 0.02)
  placeModels(b, "fire_extinguisher", [
    { position: [x, y0 + 0.06, z + s * (0.02 + MODELS.fire_extinguisher.size[2] / 2)], yaw: s > 0 ? Math.PI : 0, collide: false, blob: 0 },
  ])
  b.collide(x - 0.3, y0, lo, x + 0.3, y0 + 0.8, hi)
}

/** Wall-hung steel drinking fountain (library model), back to the wall at zWall. */
export function fountain(b: Builder, x: number, zWall: number) {
  const s = zWall < 0 ? 1 : -1
  const [, , d] = MODELS.drinking_fountain.size
  placeModels(b, "drinking_fountain", [{ position: [x, FLOOR_Y + 0.3, zWall + (s * d) / 2], yaw: s > 0 ? Math.PI : 0, collide: false, blob: 0 }])
  b.collide(x - 0.24, FLOOR_Y, Math.min(zWall, zWall + s * d), x + 0.24, FLOOR_Y + 0.95, Math.max(zWall, zWall + s * d))
}

/** Cork notice board with pinned papers on a wall at zWall (either spine wall). */
export function bulletin(b: Builder, x: number, zWall: number) {
  const y0 = FLOOR_Y + 1.05
  const n = zWall < 0 ? 1 : -1
  const z = zWall
  const w = 1.6
  const h = 0.95
  const zz = (d: number) => z + n * d
  b.box(M.wood, x - w / 2 - 0.03, y0 - 0.03, Math.min(z, zz(0.03)), x + w / 2 + 0.03, y0 + h + 0.03, Math.max(z, zz(0.03)))
  b.box(M.cork, x - w / 2, y0, Math.min(zz(0.03), zz(0.032)), x + w / 2, y0 + h, Math.max(zz(0.03), zz(0.032)), { cast: false })
  const papers = [
    [-0.55, 0.62, 0.22, 0.28, 0.03],
    [-0.25, 0.58, 0.22, 0.28, -0.04],
    [0.12, 0.66, 0.28, 0.2, 0.02],
    [0.5, 0.55, 0.22, 0.28, 0.06],
    [-0.5, 0.24, 0.3, 0.22, -0.02],
    [-0.08, 0.22, 0.22, 0.28, 0.0],
    [0.36, 0.25, 0.22, 0.28, -0.05],
  ] as const
  papers.forEach(([px, py, pw, ph, r], i) => {
    b.quad(M.paper, T(x - n * px, y0 + py, zz(0.034 + i * 0.0004), n > 0 ? 0 : Math.PI, 0, r), pw, ph, { cast: false })
  })
}
