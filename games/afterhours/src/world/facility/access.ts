import * as THREE from "three/webgpu"
import { Fn, float, fract, max, step, uv } from "three/tsl"
import type { WorldContext } from "../context"
import { Batch } from "./geo"

// Shared steel access pieces: caged ladders (climbable volumes for the player), little crossover steps inside a
// parapet so you can get from a roof deck up onto the coping where a ladder arrives, and the bar-grating material for
// fire-escape landings and treads.

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

export type LadderSpec = {
  /** Wall face point at the ladder's centre line (x, z) and the outward wall normal (unit, along ±x or ±z). */
  x: number
  z: number
  nx: number
  nz: number
  /** Bottom of the rails and top of the rails (stiles extend ~1 m above the arrival level). */
  y0: number
  y1: number
  /** Level the climber steps off at the top (coping or landing); the climb volume reaches just above it. */
  arrive: number
  /** Height where the safety cage starts (none below; omit for no cage). */
  cageFrom?: number
  /** Standoff of the rails from the wall. */
  standoff?: number
  mat?: "metal_galvanized" | "metal_dark"
}

/** A steel ladder on wall brackets with an optional hooped safety cage; registers its climb volume. */
export function cagedLadder(ctx: WorldContext, b: Batch, s: LadderSpec) {
  const mat = s.mat ?? "metal_galvanized"
  const n = V(s.nx, 0, s.nz)
  const t = V(-s.nz, 0, s.nx)
  const off = s.standoff ?? 0.2
  const at = (along: number, y: number, out: number) => V(s.x + t.x * along + n.x * out, y, s.z + t.z * along + n.z * out)
  // Stiles (flat bar) and round rungs every 0.3 m.
  for (const a of [-0.22, 0.22]) b.strut(mat, at(a, s.y0, off), at(a, s.y1, off), 0.055)
  for (let y = s.y0 + 0.3; y < s.y1 - 0.05; y += 0.3) b.strut(mat, at(-0.22, y, off), at(0.22, y, off), 0.028, true)
  // Wall brackets every 1.8 m.
  for (let y = s.y0 + 0.6; y < s.y1 - 0.3; y += 1.8) for (const a of [-0.22, 0.22]) b.strut(mat, at(a, y, 0), at(a, y, off), 0.05)
  // Top: stiles curve over as grab rails (a short horizontal return towards the wall).
  for (const a of [-0.22, 0.22]) b.strut(mat, at(a, s.y1, off), at(a, s.y1, -0.05), 0.045, true)
  if (s.cageFrom !== undefined) {
    const r = 0.36
    const hoop = (y: number) => {
      const g = new THREE.TorusGeometry(r, 0.016, 5, 12, Math.PI)
      // Arc in the XY plane from +X through +Y; lay it flat and face it outwards from the wall.
      g.rotateX(Math.PI / 2)
      const m = new THREE.Matrix4().makeBasis(t, V(0, 1, 0), n.clone().negate())
      m.setPosition(at(0, y, off + 0.12))
      b.add(mat, g, m, 1, false)
      // Ends tie back to the stiles.
      for (const a of [-1, 1]) b.strut(mat, at(a * r, y, off + 0.12), at(a * 0.22, y, off), 0.02)
    }
    const yTop = s.y1 - 0.05
    for (let y = s.cageFrom; y <= yTop; y += 0.75) hoop(y)
    for (let k = 0; k < 5; k++) {
      const a = (k / 4) * Math.PI
      const along = Math.cos(a) * r
      const out = off + 0.12 + Math.sin(a) * r
      b.strut(mat, at(along, s.cageFrom, out), at(along, yTop, out), 0.035)
    }
  }
  const lo = at(-0.36, s.y0 - 0.1, 0.05)
  const hi = at(0.36, s.arrive + 0.12, 0.75)
  ctx.ladders.push({
    min: [Math.min(lo.x, hi.x), Math.max(0, s.y0 - 1.6), Math.min(lo.z, hi.z)],
    max: [Math.max(lo.x, hi.x), s.arrive + 0.12, Math.max(lo.z, hi.z)],
  })
}

/**
 * Three steel steps inside a parapet, from a roof deck at `y0` up to the coping top at `y1`, running inward from the
 * wall face at (x, z) along -normal (n points out of the building through that wall).
 */
export function crossover(ctx: WorldContext, b: Batch, x: number, z: number, nx: number, nz: number, y0: number, y1: number, inner: number) {
  const steps = Math.max(1, Math.ceil((y1 - y0) / 0.4) - 1)
  const rise = (y1 - y0) / (steps + 1)
  const n = V(nx, 0, nz)
  const t = V(-nz, 0, nx)
  for (let i = 0; i < steps; i++) {
    const y = y0 + rise * (i + 1)
    // Step i sits `inner + (steps-1-i)*0.3` from the wall face (lowest furthest in).
    const d0 = inner + (steps - 1 - i) * 0.3
    const d1 = d0 + 0.3
    const p0 = V(x - n.x * d0 + t.x * -0.45, 0, z - n.z * d0 + t.z * -0.45)
    const p1 = V(x - n.x * d1 + t.x * 0.45, 0, z - n.z * d1 + t.z * 0.45)
    const [ax, bx] = [Math.min(p0.x, p1.x), Math.max(p0.x, p1.x)]
    const [az, bz] = [Math.min(p0.z, p1.z), Math.max(p0.z, p1.z)]
    b.box(GRATING, ax, y - 0.04, az, bx, y, bz)
    b.box("metal_dark", ax, y - 0.08, az, bx, y - 0.04, az + 0.03)
    b.box("metal_dark", ax, y - 0.08, bz - 0.03, bx, y - 0.04, bz)
    ctx.floors.push({ min: [ax, az], max: [bx, bz], y })
  }
  // Side stringers down to the deck.
  for (const a of [-0.47, 0.47]) {
    const top = V(x - n.x * inner + t.x * a, y1 - rise, z - n.z * inner + t.z * a)
    const bot = V(x - n.x * (inner + steps * 0.3) + t.x * a, y0, z - n.z * (inner + steps * 0.3) + t.z * a)
    b.strut("metal_dark", top, bot, 0.06)
    b.strut("metal_dark", top.clone().setY(y0), top, 0.05)
  }
}

/** Welded bar grating: bearing bars 30 mm apart, cross rods every 100 mm, alpha-tested so you see through it. */
function gratingMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x2b2a27, roughness: 0.6, metalness: 0.7, side: THREE.DoubleSide, alphaTest: 0.5 })
  m.opacityNode = Fn(() => {
    const p = uv()
    const bar = step(0.62, fract(p.x.div(0.03)))
    const rod = step(0.8, fract(p.y.div(0.1)))
    return max(bar, rod).add(float(0))
  })()
  m.name = "facility_grating"
  return m
}

export const GRATING = gratingMaterial()
