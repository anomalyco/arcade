import {
  BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry,
} from "three"
import { MeshStandardNodeMaterial } from "three/webgpu"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { PALETTE } from "./palette"


/** Prepare a primitive for merging: non-indexed, no uvs, keeps smooth normals, one vertex colour. */
export function painted(geometry: BufferGeometry, color: string | Color): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute("uv")
  if (!g.getAttribute("normal")) g.computeVertexNormals()
  const col = new Color(color)
  const n = g.getAttribute("position").count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b }
  g.setAttribute("color", new Float32BufferAttribute(arr, 3))
  return g
}

export function merge(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts, false)
  if (!g) throw new Error("merge failed")
  for (const p of parts) p.dispose()
  g.computeBoundingSphere()
  return g
}

/** Smooth blob: icosphere with radius jitter so canopies look hand-shaped, not perfect spheres. */
/** Lumpy canopy blob: icosphere with multi-frequency displacement (irregular, cauliflower-like). */
function blob(r: number, detail: number, seed: number, flatten = 0.8): BufferGeometry {
  const g = new IcosahedronGeometry(r, detail)
  const pos = g.getAttribute("position")
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / r, y = pos.getY(i) / r, z = pos.getZ(i) / r
    const k = 1 + 0.16 * Math.sin(x * 3.1 + seed) * Math.cos(z * 2.7 - seed) + 0.1 * Math.sin(y * 4.3 + seed * 2) +
      0.08 * Math.sin((x + z) * 6.1 + seed * 3)
    // Flat-ish underside, domed top.
    const yy = y < 0 ? y * 0.45 : y * flatten
    pos.setXYZ(i, x * r * k, yy * r * k, z * r * k)
  }
  g.computeVertexNormals()
  return g
}

/** Shade a canopy part: darker toward the bottom/inside (fake occlusion), baked into vertex colours. */
function canopy(g: BufferGeometry, hex: string, top: number, bottom: number): BufferGeometry {
  const p = painted(g, hex)
  const pos = p.getAttribute("position"), col = p.getAttribute("color")
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, (pos.getY(i) - bottom) / Math.max(1e-3, top - bottom)))
    const k = 0.45 + 0.55 * t
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k)
  }
  return p
}

/** Coastal palm: curved trunk, a dense drooping crown of leaf fans. */
function palm(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const h = 14
  const segs = 4
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs
    const seg = new CylinderGeometry(0.38 - t1 * 0.1, 0.48 - t0 * 0.1, h / segs * 1.04, 5, 1, true)
    seg.translate(Math.pow((t0 + t1) / 2, 2) * 2.2, h * (t0 + t1) / 2, 0)
    parts.push(painted(seg, PALETTE.trunk))
  }
  const top = [2.2, h, 0] as const
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + (i % 2) * 0.2
    const leaf = new CylinderGeometry(0.05, 1.3, 7.5, 3, 1)
    leaf.scale(1, 1, 0.22)
    leaf.translate(0, 3.75, 0)
    leaf.rotateZ(-Math.PI / 2 - 0.55 - (i % 3) * 0.12)
    leaf.rotateY(a)
    leaf.translate(top[0], top[1], top[2])
    parts.push(canopy(leaf, PALETTE.palmLeaf, top[1] + 1, top[1] - 4))
  }
  return merge(parts)
}

/** Wide jungle broadleaf: short trunk under a broad, lumpy, layered canopy (5 blobs). `detail` 0 = distant LOD. */
function round(detail = 1): BufferGeometry {
  const parts: BufferGeometry[] = []
  const trunk = new CylinderGeometry(0.7, 1.1, 8, 5, 1, true)
  trunk.translate(0, 4, 0)
  parts.push(painted(trunk, PALETTE.trunk))
  const blobs: [number, number, number, number, number][] = [
    [0, 11.5, 0, 6.2, 1.1], [4.6, 9.6, 1.5, 4.4, 2.7], [-4.2, 10, -1.8, 4.6, 4.1], [1.2, 9.2, -4.4, 4.0, 5.3], [-1.5, 9.4, 4.2, 4.1, 6.4],
  ]
  for (const [x, y, z, r, sd] of blobs) {
    const b = blob(r, detail, sd, 0.62)
    b.translate(x, y, z)
    parts.push(canopy(b, PALETTE.treeMid, 15, 6))
  }
  return merge(parts)
}

/** Tall emergent rainforest tree: thin trunk with two stacked, offset canopy masses. */
function tall(detail = 1): BufferGeometry {
  const parts: BufferGeometry[] = []
  const trunk = new CylinderGeometry(0.5, 0.9, 13, 5, 1, true)
  trunk.translate(0, 6.5, 0)
  parts.push(painted(trunk, PALETTE.trunk))
  const masses: [number, number, number, number, number][] = [
    [0, 16, 0, 5.4, 7.7], [3.2, 13.6, 1.2, 3.8, 8.3], [-2.8, 14.2, -1.4, 3.6, 9.1], [0.8, 19.2, -0.6, 3.6, 9.9],
  ]
  for (const [x, y, z, r, sd] of masses) {
    const b = blob(r, detail, sd, 0.7)
    b.translate(x, y, z)
    parts.push(canopy(b, PALETTE.treeDeep, 22, 11))
  }
  return merge(parts)
}

export interface TreeResources {
  geometries: BufferGeometry[]
  /** Low-poly versions (≈¼ the triangles) for clusters beyond `lodDistance`. */
  lodGeometries: BufferGeometry[]
  lodDistance: number
  material: MeshStandardNodeMaterial
  /** Distance fade window (start, end) in metres. */
  fade: { value: [number, number] }
  dispose(): void
}

export function createTreeResources(): TreeResources {
  const geometries = [palm(), round(), tall()]
  const lodGeometries = [geometries[0], round(0), tall(0)]
  const fade = { value: [2000, 2500] as [number, number] }
  const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.48, metalness: 0 })
  material.name = "World · trees"
  return {
    geometries, lodGeometries, lodDistance: 400, material, fade,
    dispose() {
      for (const g of new Set([...geometries, ...lodGeometries])) g.dispose()
      material.dispose()
    },
  }
}
