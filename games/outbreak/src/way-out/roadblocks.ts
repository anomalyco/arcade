import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import type { RoadblockKind } from "../../shared/way-out/roadblocks"
import { hex } from "../level"

/**
 * Roadblock meshes (AR-64). Frame: +x along the route, +z to the right of travel, the road's centre line at the
 * origin; each spans z −12..12 with the people's gap at z −7.3..−6.1 (drawn turned half round when the gap is on the
 * other kerb). Standing: wrecks, police barriers or a chained gate. Gone: the same pushed aside, swung open or burnt.
 */

const BURNT = hex(0x2c2826)
const RUST = hex(0x5c3a28)
const SOOT = hex(0x161412)
const CONCRETE = hex(0x9a988e)
const STRIPE_W = hex(0xd8d2c0)
const STRIPE_R = hex(0xb4382a)
const STEEL = hex(0x6c7074)

/** A burnt-out car on its own frame (long axis along x), tipped a little. */
function wreck(m: Mesh, cx: number, cz: number, yaw: number, tone = BURNT): void {
  m.yawBox(cx, cz, 4.1, 1.8, 0.28, 0.95, yaw, tone, MAT.shiny)
  m.yawBox(cx - Math.cos(yaw) * 0.25, cz - Math.sin(yaw) * 0.25, 2.1, 1.6, 0.95, 1.45, yaw, SOOT, MAT.shiny)
  for (const [f, s] of [[1.35, 0.85], [1.35, -0.85], [-1.35, 0.85], [-1.35, -0.85]] as const) {
    const x = cx + Math.cos(yaw) * f - Math.sin(yaw) * s
    const z = cz + Math.sin(yaw) * f + Math.cos(yaw) * s
    m.yawBox(x, z, 0.62, 0.22, 0, 0.5, yaw, hex(0x101010), MAT.lit)
  }
  m.yawBox(cx + Math.cos(yaw) * 0.6, cz + Math.sin(yaw) * 0.6, 1.2, 1.7, 0.95, 0.99, yaw, RUST, MAT.lit)
}

/** A run of striped sawhorses between z0 and z1. */
function sawhorses(m: Mesh, z0: number, z1: number): void {
  for (let z = z0; z + 1.6 <= z1 + 0.01; z += 1.8) {
    for (const leg of [z + 0.1, z + 1.5]) m.box(-0.35, 0, leg - 0.05, 0.35, 0.9, leg + 0.05, hex(0x5a5248), MAT.timber)
    for (let i = 0; i < 4; i++) m.box(-0.06, 0.62, z + i * 0.4, 0.06, 0.9, z + i * 0.4 + 0.4, i % 2 ? STRIPE_W : STRIPE_R, MAT.lit)
  }
}

/** Chain-link fence between z0 and z1: posts, rails and a dim mesh. */
function fence(m: Mesh, z0: number, z1: number, h = 2.1): void {
  for (let z = z0; z <= z1 + 0.01; z += Math.max(0.5, (z1 - z0) / Math.max(1, Math.round((z1 - z0) / 2.4)))) m.box(-0.05, 0, z - 0.05, 0.05, h, z + 0.05, STEEL, MAT.shiny)
  m.box(-0.03, h - 0.06, z0, 0.03, h, z1, STEEL, MAT.shiny)
  m.box(-0.015, 0.05, z0, 0.015, h - 0.06, z1, hex(0x4a4e52), MAT.cloth)
}

function scorch(m: Mesh, z0: number, z1: number): void {
  m.box(-2.4, 0.012, z0, 2.4, 0.02, z1, SOOT, MAT.floor)
}

export function standingBlockMesh(kind: RoadblockKind): Mesh {
  const m = new Mesh()
  if (kind === "wreck") {
    wreck(m, -0.3, -3.8, 1.35)
    wreck(m, 0.5, 0.2, 1.75, RUST)
    wreck(m, -0.2, 4.1, 1.5)
    for (const [x, z, h] of [[0.8, -5.6, 0.5], [-0.9, 2.3, 0.4], [0.6, 6.0, 0.35]] as const) m.yawBox(x, z, 0.9, 0.7, 0, h, z, hex(0x3a3634), MAT.shiny)
    sawhorses(m, -12, -7.4)
    sawhorses(m, 6.4, 12)
  } else if (kind === "police") {
    for (let z = -6; z < 6; z += 2) {
      m.box(-0.55, 0, z + 0.03, 0.55, 0.35, z + 1.97, CONCRETE, MAT.wall)
      m.box(-0.3, 0.35, z + 0.03, 0.3, 0.85, z + 1.97, CONCRETE, MAT.wall)
      m.box(-0.31, 0.6, z + 0.03, 0.31, 0.72, z + 1.97, STRIPE_R, MAT.lit)
    }
    sawhorses(m, -12, -7.4)
    sawhorses(m, 6.2, 12)
    // Light stands at both ends of the barrier: the lamps blink red and blue (`roadblockLights`).
    for (const z of [-6.6, 6.6]) {
      m.box(-0.05, 0, z - 0.05, 0.05, 1.7, z + 0.05, hex(0x2a2a2a), MAT.shiny)
      m.box(-0.12, 1.7, z - 0.32, 0.12, 1.85, z + 0.32, hex(0x1a1a1a), MAT.lit)
      m.box(-0.13, 1.72, z - 0.3, 0.13, 1.83, z - 0.02, hex(0xff2a20), MAT.accent)
      m.box(-0.13, 1.72, z + 0.02, 0.13, 1.83, z + 0.3, hex(0x2a5aff), MAT.accent)
    }
    m.box(-0.04, 0.9, -1.2, 0.04, 1.45, 1.2, hex(0xe8e4d8), MAT.lit)
    m.box(-0.05, 1.05, -1.0, 0.05, 1.3, 1.0, STRIPE_R, MAT.lit)
  } else {
    fence(m, -12, -7.4)
    fence(m, 6.2, 12)
    for (const z of [-6.05, 6.05]) m.box(-0.1, 0, z - 0.1, 0.1, 2.4, z + 0.1, hex(0x4a4e52), MAT.shiny)
    for (const [z0, z1] of [[-5.9, -0.05], [0.05, 5.9]] as const) {
      m.box(-0.04, 0.1, z0, 0.04, 0.16, z1, STEEL, MAT.shiny)
      m.box(-0.04, 1.9, z0, 0.04, 1.96, z1, STEEL, MAT.shiny)
      m.box(-0.04, 0.1, z0, 0.04, 1.96, z0 + 0.06, STEEL, MAT.shiny)
      m.box(-0.04, 0.1, z1 - 0.06, 0.04, 1.96, z1, STEEL, MAT.shiny)
      m.box(-0.012, 0.16, z0, 0.012, 1.9, z1, hex(0x4a4e52), MAT.cloth)
    }
    // The chain and padlock where the leaves meet, both faces; a road-closed plate.
    for (const x of [-0.12, 0.12]) {
      m.box(x - 0.03, 0.95, -0.35, x + 0.03, 1.05, 0.35, hex(0x8a8a84), MAT.shiny)
      m.box(x - 0.06, 0.78, -0.08, x + 0.06, 0.95, 0.08, hex(0xb89a3a), MAT.shiny)
    }
    m.box(-0.08, 1.25, -1.3, -0.05, 1.75, -0.2, hex(0xe8e4d8), MAT.lit)
    m.box(-0.09, 1.38, -1.2, -0.08, 1.62, -0.3, STRIPE_R, MAT.lit)
  }
  return m
}

export function clearedBlockMesh(kind: RoadblockKind): Mesh {
  const m = new Mesh()
  if (kind === "wreck") {
    wreck(m, 1.5, -9.6, 0.25)
    wreck(m, -1.8, 9.2, -0.35, RUST)
    wreck(m, 2.8, 10.4, 0.6)
    sawhorses(m, -12, -11)
  } else if (kind === "police") {
    for (const [x, z, yaw] of [[1.6, -8.4, 0.5], [-2.2, -9.6, 1.2], [2.4, 8.8, -0.4], [-1.4, 10.2, 0.9]] as const) m.yawBox(x, z, 1.1, 2, 0, 0.8, yaw, CONCRETE, MAT.wall)
    for (const z of [-11.6, 11.6]) m.box(-0.05, 0, z - 0.05, 0.05, 1.7, z + 0.05, hex(0x2a2a2a), MAT.shiny)
  } else {
    fence(m, -12, -7.4)
    fence(m, 6.2, 12)
    for (const z of [-6.05, 6.05]) m.box(-0.1, 0, z - 0.1, 0.1, 2.4, z + 0.1, hex(0x4a4e52), MAT.shiny)
    // Both leaves swung wide, along the verges.
    for (const s of [-1, 1]) {
      const z = s * 5.95
      m.box(0.05, 0.1, z - 0.04, 5.9, 1.96, z + 0.04, hex(0x4a4e52), MAT.cloth)
      m.box(0.05, 1.9, z - 0.05, 5.9, 1.96, z + 0.05, STEEL, MAT.shiny)
      m.box(5.84, 0.1, z - 0.05, 5.9, 1.96, z + 0.05, STEEL, MAT.shiny)
    }
    m.box(0.15, 0.02, -0.4, 0.45, 0.06, 0.3, hex(0x8a8a84), MAT.shiny)
  }
  return m
}

export function scorchMesh(): Mesh {
  const m = new Mesh()
  scorch(m, -6.5, 6.5)
  return m
}
