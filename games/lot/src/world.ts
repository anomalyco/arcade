import { buildFoliageTree, foliageSettings, TREE_PRESETS, FOLIAGE_BUILD_TODAY } from "@arcade/kit/gpu/foliage"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { mulberry32 } from "@arcade/kit/sim/rng"
import type { Rect } from "@arcade/kit/sim/geom"

export const START = { x: -26, z: 114, yaw: -0.65, pitch: 0.1 }
export const CAR = { x: -16, z: 87, yaw: 1.53 }
export const walls: Rect[] = [[-55, -22, 35, 22], [-81, -90, -79, 124], [81, -90, 83, 124], [-81, 122, 83, 124], [-81, -90, 83, -88], [-18.7, 85.9, -13.3, 88.1], [-8.4, 99.7, -7.8, 100.3]]

export function buildWorld() {
  const m = new Mesh(), ground = new Mesh()
  ground.quad([-42, 0.04, 112], [42, 0.04, 112], [42, 0.04, 38], [-42, 0.04, 38], [0, 1, 0], [1, 1, 1], MAT.ground)
  m.box(-200, -0.3, -130, 200, -0.02, 250, [0.16, 0.19, 0.15])
  // Tall background cube, inward-facing; its glow material is replaced with the shared sky shader.
  const sky = new Mesh()
  sky.box(-180, -20, -100, 180, 170, 240, [1, 1, 1], MAT.glow, -1, undefined, true)
  for (let i = 0; i < sky.v.length; i += 33) {
    for (const k of [2, 1, 0]) m.v.push(...sky.v.slice(i + k * 11, i + (k + 1) * 11))
  }
  const concrete: Rgb = [0.36, 0.37, 0.35]
  m.box(-55, 0, -22, 35, 19.6, 22, concrete)
  m.box(-43.45, 0, 22, -35.95, 20.2, 25.2, [0.3, 0.31, 0.29])
  for (let floor = 0; floor < 5; floor++) {
    const y = 1.1 + floor * 3.8
    for (let x = -51; x < 34; x += 4.2) {
      if (x > -45 && x < -34) continue
      m.box(x, y, 22.01, x + 2.7, y + 1.8, 22.08, [0.08, 0.12, 0.13], MAT.shiny)
      m.box(x - 0.05, y - 0.12, 22, x + 2.75, y, 22.2, [0.42, 0.43, 0.4])
    }
    m.box(-55, y + 2.3, 22, 35, y + 2.46, 22.17, [0.25, 0.26, 0.24])
  }
  m.box(-2, 0, 22, 2, 2.8, 22.12, [0.05, 0.09, 0.1], MAT.shiny)
  m.box(-3.8, 2.8, 22, 3.8, 3.1, 26, [0.23, 0.25, 0.25])
  // Worn stall lines, wheel stops and a low curb. Geometry breaks prevent ruler-clean paint.
  const rand = mulberry32(103)
  for (const x of [-37, -32, -27, -22, -17, -12, 12, 17, 22, 27, 32, 37]) {
    for (const z of [46, 65, 84, 104]) {
      for (let s = 0; s < 5; s += 0.35) if (rand() > 0.12) m.box(x, 0.041, z - s - 0.28, x + 0.09, 0.047, z - s, [0.48, 0.46, 0.36])
      m.box(x + 1, 0.04, z - 4.9, x + 3, 0.18, z - 4.65, [0.37, 0.36, 0.31])
    }
  }
  for (const x of [-42.25, 42]) m.box(x, 0, 38, x + 0.25, 0.15, 112, [0.35, 0.35, 0.32])
  // Galvanised diamond mesh, explicit ribbons rather than transparency sorting or a bespoke renderer.
  const fence = (x0: number, z0: number, x1: number, z1: number) => {
    const length = Math.hypot(x1 - x0, z1 - z0), dx = (x1 - x0) / length, dz = (z1 - z0) / length
    const p = (s: number, y: number) => [x0 + dx * s, y, z0 + dz * s]
    for (let s = 0; s <= length; s += 3) m.prism(x0 + dx * s, z0 + dz * s, 0.045, 0.04, 0, 2.6, 6, [0.36, 0.39, 0.37], MAT.shiny)
    for (const sign of [-1, 1]) for (let s = -2.5; s < length + 2.5; s += 0.16) {
      const a = Math.max(0, sign > 0 ? -s : s - length), b = Math.min(2.5, sign > 0 ? length - s : s)
      if (b <= a) continue
      m.quad(p(s + sign * a - 0.009, a), p(s + sign * b - 0.009, b), p(s + sign * b + 0.009, b), p(s + sign * a + 0.009, a), [-dz, 0, dx], [0.32, 0.35, 0.33], MAT.shiny)
    }
  }
  fence(-80, 122, 82, 122); fence(-80, -88, -80, 122); fence(82, 122, 82, -88)
  const lamp = (x: number, z: number, lit: boolean) => {
    m.prism(x, z, 0.23, 0.18, 0, 0.5, 8, [0.36, 0.35, 0.31])
    m.prism(x, z, 0.085, 0.05, 0.5, 9.2, 10, [0.28, 0.3, 0.29], MAT.shiny)
    m.box(x, 9.08, z - 0.06, x + 1.6, 9.2, z + 0.06, [0.25, 0.26, 0.25], MAT.shiny)
    m.box(x + 1.2, 8.98, z - 0.22, x + 2, 9.2, z + 0.22, [0.25, 0.26, 0.25])
    m.box(x + 1.25, 8.96, z - 0.18, x + 1.95, 8.99, z + 0.18, [1, 0.7, 0.32], MAT.glow, lit ? 7 : 0.02, undefined, true)
  }
  lamp(-8.1, 100, true); lamp(19.8, 56, false)
  const treeParams = { ...foliageSettings, ...TREE_PRESETS.pine.values }
  for (let i = 0; i < 160; i++) {
    const side = i % 3, x = side === 0 ? -88 - rand() * 35 : side === 1 ? 90 + rand() * 35 : -115 + rand() * 230
    const z = side === 2 ? 135 + rand() * 40 : -70 + rand() * 230
    buildFoliageTree(m, x, z, 10 + rand() * 14, 2.4 + rand() * 2.3, i * 31 + 5, 0, treeParams, "conical", { ...FOLIAGE_BUILD_TODAY, quality: 0 })
  }
  return { mesh: m, ground }
}
