import * as THREE from "three/webgpu"
import type { DocumentId, DocumentPlacement } from "../../../../render/documents"
import * as THREE_ from "three/webgpu"
import { materialFor } from "../../../../render/materials"
import { type Builder, type Mat, CEIL_Y, FLOOR_Y, LAYER, T } from "../../api"
import type { Rnd } from "./props"

/** What every storey-4 section builds into: the storey builder, a near-only builder for small vignette props, the
 *  storey's paperwork (one merged draw) and a seeded random stream. */
export type S4 = { b: Builder; sb: Builder; docs: DocumentPlacement[]; rnd: Rnd }

/** Paper on a wall (normal points out of the wall) or flat on a surface (normal +Y). */
export function paper(s: S4, id: DocumentId, position: readonly [number, number, number], normal: readonly [number, number, number], o: Omit<DocumentPlacement, "id" | "position" | "normal"> = {}) {
  s.docs.push({ id, position, normal, ...o })
}

/** Dusty contractor's polythene: milkier than the kit's clear sheet, so a work light reads on it (shared flat class). */
export const POLY = materialFor("flat", { color: 0xdde2da, roughness: 0.32, transparent: 0.38, side: THREE_.DoubleSide, name: "interior_s4_poly" })

/** Hanging polythene sheet along x at z (`axis` "x") or along z at x (`axis` "z"), `gap` short of the floor. */
export function plasticX(b: Builder, z: number, x0: number, x1: number, rnd: Rnd, gap = 0.05, axis: "x" | "z" = "x") {
  const w = x1 - x0
  const h = CEIL_Y - FLOOR_Y - gap
  const g = new THREE.PlaneGeometry(w, h, Math.max(8, Math.round(w * 2.5)), 10)
  const pos = g.getAttribute("position")
  const ph = rnd() * 6
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i)
    const v = pos.getY(i)
    pos.setZ(i, Math.sin(u * 5.3 + ph) * 0.05 + Math.sin(u * 13 + v * 3 + ph) * 0.015 + (0.5 - v / h) * 0.05 * Math.sin(u * 2 + ph))
  }
  g.computeVertexNormals()
  g.applyMatrix4(axis === "x" ? T((x0 + x1) / 2, CEIL_Y - h / 2, z) : T(z, CEIL_Y - h / 2, (x0 + x1) / 2, Math.PI / 2))
  b.add(POLY, g, { worldUV: false, cast: false })
  // Batten stapled to the grid along the top.
  if (axis === "x") b.box("metal_galvanized", x0, CEIL_Y - 0.03, z - 0.015, x1, CEIL_Y - 0.006, z + 0.015, { cast: false })
  else b.box("metal_galvanized", z - 0.015, CEIL_Y - 0.03, x0, z + 0.015, CEIL_Y - 0.006, x1, { cast: false })
}

/** Thin floor patches (carpet adhesive, vinyl or carpet remnants) inside a rect, each on its own layer. */
export function floorPatches(b: Builder, r: { x0: number; x1: number; z0: number; z1: number }, mat: Mat, n: number, rnd: Rnd, layer0 = 1) {
  for (let k = 0; k < n; k++) {
    const w = 0.5 + rnd() * Math.min(3, r.x1 - r.x0 - 0.4)
    const d = 0.4 + rnd() * Math.min(2.5, r.z1 - r.z0 - 0.4)
    const x = r.x0 + 0.2 + rnd() * Math.max(0, r.x1 - r.x0 - 0.4 - w)
    const z = r.z0 + 0.2 + rnd() * Math.max(0, r.z1 - r.z0 - 0.4 - d)
    const y = FLOOR_Y + LAYER * (layer0 + (k % 4) * 0.6)
    b.box(mat, x, FLOOR_Y, z, x + w, y, z + d, { cast: false, skip: "y" })
  }
}

/** Flat cable on the floor through a list of (x, z) points. */
export function floorCable(b: Builder, pts: readonly (readonly [number, number])[], mat: Mat, r = 0.011) {
  for (let i = 1; i < pts.length; i++) b.rod(mat, [pts[i - 1]![0], FLOOR_Y + r, pts[i - 1]![1]], [pts[i]![0], FLOOR_Y + r, pts[i]![1]], r, 6, { cast: false })
}
