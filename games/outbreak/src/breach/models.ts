import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { hex } from "../level"
import { DOOR_WIDTH } from "../world/door-leaf"

/**
 * Box-built pieces for damaged doors and breaches, in the door leaf's own frame (hinge at x 0, latch at 1.4, up y,
 * faces at z ±0.1 with the panels proud to 0.122): crack overlays per wear stage, a punched-through panel, the arms
 * that reach through it, and the pieces a breach throws (splinters, chunks, frame, planks, glass) plus shadows of feet.
 */

const CRACK = hex(0x0b0806)
const RAW = hex(0xa98058)
const PALE = hex(0xc29c6c)
const FRONT = [0.1235, 0.1275] as const
const BACK = [-0.1045, -0.1005] as const

type Pt = readonly [number, number]

function hashN(k: number): number {
  let h = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** A jagged crack from `from` heading `angle`, drawn on both faces as short boxes, with a pale lip on one side. */
function crack(m: Mesh, from: Pt, angle: number, length: number, seed: number, width = 0.014): void {
  let [x, y] = from
  let a = angle
  const steps = Math.max(2, Math.round(length / 0.06))
  for (let i = 0; i < steps; i++) {
    a += (hashN(seed * 31 + i) - 0.5) * 0.9
    const nx = Math.max(0.02, Math.min(DOOR_WIDTH - 0.02, x + Math.cos(a) * 0.06))
    const ny = Math.max(0.16, Math.min(2.27, y + Math.sin(a) * 0.06))
    const w = width * (1 - (i / steps) * 0.6)
    const x0 = Math.min(x, nx) - w * 0.5
    const x1 = Math.max(x, nx) + w * 0.5
    const y0 = Math.min(y, ny) - w * 0.5
    const y1 = Math.max(y, ny) + w * 0.5
    for (const [z0, z1] of [FRONT, BACK]) {
      m.box(x0, y0, z0, x1, y1, z1, CRACK, MAT.timber)
      m.box(x0, y1, z0 - 0.001, x1, y1 + w * 0.6, z1 - 0.001, RAW, MAT.timber)
    }
    x = nx
    y = ny
    // Branch now and then.
    if (i === Math.floor(steps / 2) && length > 0.3) crack(m, [x, y], a + (hashN(seed + 9) < 0.5 ? 0.9 : -0.9), length * 0.45, seed * 7 + 3, w)
  }
}

/** Bare wood teeth round a broken edge or hole, proud of both faces. */
function splinters(m: Mesh, x0: number, y0: number, x1: number, y1: number, seed: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const u = hashN(seed * 13 + i)
    const v = hashN(seed * 17 + i * 3)
    const onTop = i % 4
    const x = onTop < 2 ? x0 + u * (x1 - x0) : onTop === 2 ? x0 : x1
    const y = onTop < 2 ? (onTop === 0 ? y0 : y1) : y0 + u * (y1 - y0)
    const len = 0.03 + v * 0.07
    const tall = onTop >= 2
    m.box(x - (tall ? len : 0.012), y - (tall ? 0.012 : len), -0.1, x + (tall ? len : 0.012), y + (tall ? 0.012 : len), 0.12, i % 3 ? RAW : PALE, MAT.timber)
  }
}

/** Stage 1: cracks spreading from the latch, where the hits land. */
export function cracksMesh(stage: 1 | 2 | 3): Mesh {
  const m = new Mesh()
  crack(m, [1.12, 1.1], Math.PI * 0.85, 0.55, 1)
  crack(m, [1.1, 1.2], Math.PI * 0.3, 0.4, 2)
  crack(m, [1.05, 0.95], -Math.PI * 0.7, 0.35, 3)
  if (stage >= 2) {
    // A panel split down the middle stile, bowed in, raw wood showing along the split.
    crack(m, [0.72, 0.3], Math.PI * 0.5, 1.5, 4, 0.02)
    m.box(0.705, 0.34, FRONT[0] - 0.01, 0.735, 1.85, FRONT[1], PALE, MAT.timber)
    splinters(m, 0.7, 0.36, 0.74, 1.8, 5, 8)
    crack(m, [0.9, 1.7], Math.PI * 1.1, 0.5, 6)
    crack(m, [0.4, 0.6], Math.PI * 0.2, 0.45, 7)
    crack(m, [1.2, 0.5], Math.PI * 0.9, 0.4, 8)
  }
  if (stage >= 3) {
    // Failing: cracks everywhere, the lock plate sprung and the hinges bending away from the frame.
    for (let i = 0; i < 6; i++) crack(m, [0.2 + hashN(40 + i) * 1.0, 0.3 + hashN(50 + i) * 1.8], hashN(60 + i) * Math.PI * 2, 0.35 + hashN(70 + i) * 0.4, 10 + i)
    m.box(1.12, 0.94, 0.12, 1.26, 1.3, 0.14, hex(0x5a4a2c), MAT.shiny)
    splinters(m, 1.08, 0.9, 1.3, 1.34, 11, 10)
    for (const y of [0.42, 1.22, 2.02]) {
      m.box(-0.02, y - 0.07, -0.11, 0.05, y + 0.07, -0.09, hex(0x4b4c4e), MAT.shiny)
      m.box(0.0, y - 0.09, -0.115, 0.03, y + 0.09, 0.115, CRACK, MAT.timber)
    }
  }
  return m
}

/** A panel punched through: a ragged black hole in the upper latch-side panel with splintered teeth round it. */
export function holeMesh(): Mesh {
  const m = new Mesh()
  m.box(0.8, 1.12, -0.106, 1.18, 1.6, 0.13, hex(0x030202), MAT.actor)
  splinters(m, 0.8, 1.12, 1.18, 1.6, 21, 18)
  crack(m, [0.8, 1.2], Math.PI, 0.35, 22)
  crack(m, [1.0, 1.6], Math.PI * 0.45, 0.4, 23)
  return m
}

/** Where the hole is in the leaf (centre x, y). */
export const HOLE_AT = { x: 0.99, y: 1.36 } as const

/** One of the dead's forearms and grasping hand, reaching along +z from z 0. */
export function armMesh(): Mesh {
  const m = new Mesh()
  const skin = hex(0x707a5c)
  const dark = hex(0x4c523e)
  m.box(-0.06, -0.06, -0.12, 0.06, 0.06, 0.08, hex(0x2c2824), MAT.cloth)
  m.box(-0.045, -0.045, 0.06, 0.045, 0.045, 0.42, skin, MAT.actor)
  m.box(-0.06, -0.02, 0.4, 0.06, 0.03, 0.52, skin, MAT.actor)
  for (const x of [-0.045, -0.015, 0.015, 0.045]) m.box(x - 0.011, -0.03, 0.5, x + 0.011, 0.0, 0.6, dark, MAT.actor)
  m.box(0.05, -0.03, 0.42, 0.075, 0.0, 0.5, dark, MAT.actor)
  return m
}

/** A splinter of door wood. */
export function splinterMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.09, -0.012, -0.01, 0.09, 0.012, 0.01, RAW, MAT.timber)
  m.box(0.06, -0.008, -0.011, 0.11, 0.008, 0.011, PALE, MAT.timber)
  return m
}

/** A chunk of door or panel. */
export function chunkMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.16, -0.06, -0.035, 0.16, 0.06, 0.035, hex(0x322216), MAT.timber)
  m.box(0.13, -0.06, -0.036, 0.17, 0.05, 0.036, PALE, MAT.timber)
  m.box(-0.17, -0.04, -0.036, -0.13, 0.06, 0.036, RAW, MAT.timber)
  return m
}

/** A length of door frame (jamb), painted trim with a raw broken end. */
export function jambMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.045, -1.0, -0.06, 0.045, 1.0, 0.06, hex(0x8a8478), MAT.wall)
  m.box(-0.046, 0.95, -0.061, 0.046, 1.05, 0.061, PALE, MAT.timber)
  return m
}

/** A barricade board thrown loose, nails still in. */
export function plankMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.78, -0.065, -0.025, 0.78, 0.065, 0.025, hex(0x8e6f48), MAT.timber)
  m.box(-0.68, -0.02, -0.032, -0.64, 0.02, 0.032, hex(0x353738), MAT.actor)
  m.box(0.64, -0.02, -0.032, 0.68, 0.02, 0.032, hex(0x353738), MAT.actor)
  return m
}

/** A shard of window glass. */
export function glassMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.07, -0.002, -0.05, 0.07, 0.002, 0.05, hex(0xb8d0d4), MAT.glass)
  return m
}

/** The shadow of a foot in the light under a door: a dark smear on the floor. */
export function footShadowMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.13, 0, -0.05, 0.13, 0.004, 0.05, hex(0x050505), MAT.actor)
  m.box(-0.08, 0, -0.07, 0.08, 0.003, 0.07, hex(0x0a0a0a), MAT.actor)
  return m
}
