import * as THREE from "three/webgpu"
import { abs, float, floor, hash, mix, normalWorldGeometry, positionWorld, sin, smoothstep, step, uv, vec2, vec3 } from "three/tsl"
import { type Band, M, STOREY_H, aaFade, aaLines, glow, paint } from "../../api"
import { interiorSurface } from "../../../../render/materials"

// Storey 4's own surfaces: three node materials for the whole storey (walnut panelling, broadloom carpet, survey
// map), everything else is shared Paint. Every pattern is filtered (aaLines / aaFade), so nothing crawls under TAA.

/** Lacquered walnut wall panelling: 600 mm boards with V-grooves, per-board tone, wavy vertical grain. */
export const WALNUT = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.42 })
  const n = normalWorldGeometry
  const along = mix(positionWorld.x, positionWorld.z, step(abs(n.z), abs(n.x)))
  const y = positionWorld.y
  const board = floor(along.div(0.6))
  const tone = hash(board.add(floor(y.div(STOREY_H)).mul(31)).add(7)).mul(0.28).add(0.82)
  const phase = along.mul(70).add(sin(y.mul(1.7).add(board.mul(3.1))).mul(2.4)).add(sin(y.mul(0.41).add(board)).mul(5))
  const grain = mix(float(0.5), sin(phase).mul(0.5).add(0.5), aaFade(phase.mul(1 / (Math.PI * 2))))
  const groove = aaLines(along.div(0.6), 0.012)
  m.colorNode = vec3(0.15, 0.078, 0.036).mul(tone).mul(grain.mul(0.32).add(0.78)).mul(float(1).sub(groove.mul(0.7)))
  m.roughnessNode = float(0.38).add(groove.mul(0.4)).add(grain.mul(0.08))
  const aged = interiorSurface(m.colorNode, m.roughnessNode)
  m.colorNode = aged.color
  m.roughnessNode = aged.rough
  m.name = "interior_s4_walnut"
  return m
})()

/** Executive broadloom: deep oxblood cut pile with fibre noise and soft traffic wear. */
export const BROADLOOM = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.97 })
  const p = positionWorld.xz
  const fibre = hash(floor(p.mul(240)).dot(vec2(1, 157)))
  const fine = mix(float(0.5), fibre, aaFade(positionWorld.x.mul(240)))
  const blot = hash(floor(p.mul(3)).dot(vec2(17, 61))).mul(0.06)
  m.colorNode = vec3(0.13, 0.034, 0.03).mul(fine.mul(0.22).add(0.89).sub(blot))
  m.colorNode = interiorSurface(m.colorNode, float(0.97), float(1), false).color
  m.name = "interior_s4_broadloom"
  return m
})()

/** Survey map in the quad's 0..1 UVs: contours, a graticule, a river, wooded tint. */
export const SURVEY_MAP = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 })
  const q = uv().mul(vec2(3, 2))
  const h = sin(q.x.mul(4.1).add(sin(q.y.mul(2.3)).mul(1.4))).mul(0.5).add(sin(q.y.mul(3.3).add(q.x.mul(1.7))).mul(0.5)).add(sin(q.x.add(q.y).mul(9)).mul(0.12))
  const contour = aaLines(h.mul(7), 0.07)
  const grid = aaLines(q.x.mul(4), 0.012).max(aaLines(q.y.mul(4), 0.012))
  const river = float(1).sub(smoothstep(0.004, 0.012, abs(q.y.sub(1).sub(sin(q.x.mul(2.2)).mul(0.25)))))
  const land = mix(vec3(0.6, 0.57, 0.45), vec3(0.44, 0.5, 0.36), smoothstep(-0.2, 0.5, h))
  const base = land.mul(float(1).sub(contour.mul(0.35))).mul(float(1).sub(grid.mul(0.3)))
  m.colorNode = mix(base, vec3(0.22, 0.32, 0.45), river.mul(0.8))
  m.name = "interior_s4_map"
  return m
})()

export const PLY = paint(0x8f6e46, 0.85)
export const PLY_PAINTED = paint(0x7d7868, 0.7)
export const TIMBER = paint(0x9a7a52, 0.8)
export const GYPSUM = paint(0xb9b6a9, 0.92)
export const ADHESIVE = paint(0x3a3220, 0.55)
export const SPRAY = paint(0xc8501a, 0.7)
export const SPRINKLER = paint(0x7a1a14, 0.5, 0.2)
export const BRASS = paint(0x8a6a2a, 0.3, 0.9)
export const LEATHER = paint(0x2a1610, 0.55)
export const CERAMIC = paint(0xc9c2ae, 0.3)
export const SHADE = paint(0xd9cfb0, 0.85)
export const SHADE_LIT = glow(0x6a5030, 0xffc070, 0.9, "s4_lamp_shade")
export const CHART = paint(0xd9d4bf, 0.9)
export const HARDHAT = paint(0xb8901a, 0.4)
export const HARDHAT_W = paint(0xc9c6bb, 0.4)
export const BLUEPRINT = paint(0x2c4a78, 0.85)
export const SELECTRIC = paint(0x6a5a3e, 0.45)
export const FROST = paint(0xe6ecef, 0.75)
export const RUST = paint(0x5a3220, 0.8, 0.3)
export const RUBBLE = paint(0x77746a, 0.95)
export const TRANSOM = glow(0x3a2a18, 0xffb868, 1.1, "s4_transom")
export const SPILL = glow(0x000000, 0xffa850, 0.6, "s4_door_spill")
export const LED_GREEN = glow(0x041004, 0x30ff40, 1.5, "s4_led_green")
export const LED_AMBER = glow(0x140a02, 0xffa020, 1.8, "s4_led_amber")
export const LED_RED = glow(0x140202, 0xff2010, 2, "s4_led_red")

/** Directorate corridor and room finish: dark skirting, walnut to the ceiling with a dado rail. */
export const EXEC_BANDS: Band[] = [
  [0, 0.12, M.veneerDark],
  [0.12, 0.88, WALNUT],
  [0.88, 0.93, M.veneerDark],
  [0.93, 99, WALNUT],
]
/** Construction side of the hoarding: raw plywood. */
export const PLY_BANDS: Band[] = [[0, 99, PLY]]
