import * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import type { DoorSound } from "../doors"
import { Batch } from "./geo"
import { normal, point, tangent, type Facade } from "./shell"

// Facility door leaves for the shared door system (`ctx.doors`, world/doors.ts). Each leaf is its own small group of
// meshes using shared library materials (no new shaders), built in the leaf's local frame: hinge at the origin on the
// floor, the panel along local +x (or -x for a negative width), y up, thickness on z.

type Box6 = [number, number, number, number, number, number]

/** Leaf group from boxes in local coordinates, per material. */
function leafGroup(name: string, build: (box: (mat: Parameters<Batch["box"]>[0], ...b: Box6) => void, b: Batch) => void) {
  const g = new THREE.Group()
  g.name = name
  const b = new Batch()
  build((mat, x0, y0, z0, x1, y1, z1) => b.box(mat, x0, y0, z0, x1, y1, z1), b)
  b.flush(g, { name })
  return g
}

/** Painted steel door: panel, kick plates, lever handles both faces, a small wired-glass vision panel. */
export function steelLeaf(name: string, width: number, height: number, thickness = 0.045, vision = true) {
  const s = Math.sign(width) || 1
  const w = Math.abs(width)
  const X = (a: number) => a * s
  return leafGroup(name, (box) => {
    const t = thickness / 2
    box("door_steel", Math.min(0, X(w)), 0, -t, Math.max(0, X(w)), height, t)
    for (const z of [-1, 1]) {
      box("metal_galvanized", Math.min(X(0.04), X(w - 0.04)), 0.01, z * t - 0.003, Math.max(X(0.04), X(w - 0.04)), 0.26, z * t + 0.003)
      // Lever handle on the latch side.
      const hx = X(w - 0.1)
      box("metal_galvanized", Math.min(hx, hx - X(0.03)), 0.98, z * (t + 0.005), Math.max(hx, hx - X(0.03)), 1.1, z * (t + 0.03))
      box("metal_galvanized", Math.min(hx, hx - X(0.14)), 1.02, z * (t + 0.03), Math.max(hx, hx - X(0.14)), 1.05, z * (t + 0.05))
    }
    if (vision) {
      const c = X(w / 2)
      box("glass_dark", c - 0.1, 1.35, -t - 0.002, c + 0.1, 1.75, t + 0.002)
    }
  })
}

/** Aluminium storefront leaf with a full glass pane and a push bar. */
export function glassLeaf(name: string, width: number, height: number, glass: THREE.Material, frame: THREE.Material) {
  const s = Math.sign(width) || 1
  const w = Math.abs(width)
  const X = (a: number, b: number): [number, number] => [Math.min(a * s, b * s), Math.max(a * s, b * s)]
  return leafGroup(name, (box) => {
    const t = 0.025
    const rails: [number, number, number, number][] = [
      [0, 0, w, 0.18],
      [0, height - 0.12, w, height],
      [0, 0, 0.09, height],
      [w - 0.09, 0, w, height],
    ]
    for (const [a, y0, c, y1] of rails) {
      const [x0, x1] = X(a, c)
      box(frame, x0, y0, -t, x1, y1, t)
    }
    const [g0, g1] = X(0.09, w - 0.09)
    box(glass, g0, 0.18, -0.006, g1, height - 0.12, 0.006)
    const [b0, b1] = X(0.12, w - 0.12)
    for (const z of [-1, 1]) box(frame, b0, 0.98, z * t, b1, 1.04, z * (t + 0.05))
  })
}

/**
 * Roll-up curtain: horizontal ribbed slats from the sill (local y 0) to `height`, bottom rubber seal and lift handle.
 * The curtain is a child scaled by `coil(lifted)`, so as the leaf's bottom edge rises the slats wind into the head
 * box instead of sliding up through the wall.
 */
export function rollupLeaf(name: string, width: number, height: number) {
  const curtain = rollupCurtain(name, width, height)
  const leaf = new THREE.Group()
  leaf.name = name
  leaf.add(curtain)
  return { leaf, coil: (lifted: number) => curtain.scale.setY(Math.max(0.04, (height - lifted) / height)) }
}

function rollupCurtain(name: string, width: number, height: number) {
  return leafGroup(name, (box) => {
    for (let y = height; y > 0.01; y -= 0.16) {
      const yb = Math.max(0, y - 0.16)
      box("metal_painted", 0.05, yb, -0.02, width - 0.05, y - 0.01, 0.02)
      box("metal_painted", 0.05, yb + 0.03, -0.04, width - 0.05, y - 0.04, -0.02)
    }
    box("rubber", 0.05, -0.04, -0.04, width - 0.05, 0.04, 0.04)
    box("metal_dark", 0.6, 0.06, -0.1, 0.75, 0.16, -0.03)
  })
}

/** Closed-pose yaw so local +x runs along the facade's tangent. */
export const facadeYaw = (f: Facade) => (f.axis === "x" ? 0 : -Math.PI / 2)

/** Sign of `openAngle` that swings a leaf on facade `f` outward. */
export function outwardSign(f: Facade) {
  const yaw = facadeYaw(f)
  const n = normal(f)
  // d(local x)/d(yaw) = (-sin yaw, -cos yaw)
  return -Math.sin(yaw) * n.x - Math.cos(yaw) * n.z > 0 ? 1 : -1
}

export type FacadeDoor = {
  id: string
  f: Facade
  u0: number
  u1: number
  y0: number
  /** Depth of the leaf's centre plane in from the outer wall face. */
  depth: number
  height: number
  leaf: THREE.Object3D
  openAngle: number
  swing?: "auto" | "fixed"
  startOpen?: number
  sound: DoorSound
  slide?: { axis: readonly [number, number, number]; distance: number }
  thickness?: number
  double?: string
  onMove?: (t: number) => void
  panic?: boolean
  closer?: boolean
}

/** Registers a facade door: hinge at the u0 jamb (leaf runs along +tangent), closed pose along the wall. */
export function addFacadeDoor(ctx: WorldContext, root: THREE.Object3D, d: FacadeDoor) {
  const t = tangent(d.f)
  // Leaf local +x must follow +tangent; facadeYaw gives exactly that for both axes.
  void t
  const h = point(d.f, d.u0, d.y0, d.depth)
  d.leaf.rotation.y = facadeYaw(d.f)
  root.add(d.leaf)
  return ctx.doors.add({
    id: d.id,
    leaf: d.leaf,
    hinge: [h.x, h.y, h.z],
    width: d.u1 - d.u0,
    height: d.height,
    thickness: d.thickness ?? 0.045,
    openAngle: d.openAngle,
    swing: d.swing,
    startOpen: d.startOpen,
    sound: d.sound,
    slide: d.slide,
    double: d.double,
    onMove: d.onMove,
    panic: d.panic,
    closer: d.closer,
  })
}
