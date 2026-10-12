import {
  BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, MeshLambertMaterial,
} from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { PALETTE } from "./palette"

/** White marks "use the instance colour" (foliage); anything else keeps its own palette colour. */
const FOLIAGE = "#ffffff"

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
function blob(r: number, detail: number, seed: number): BufferGeometry {
  const g = new IcosahedronGeometry(r, detail)
  const pos = g.getAttribute("position")
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const k = 1 + 0.07 * Math.sin(x * 1.7 + seed) * Math.cos(z * 1.3 - seed) + 0.05 * Math.sin(y * 2.1 + seed * 2)
    pos.setXYZ(i, x * k, y * k * 0.88, z * k)
  }
  g.computeVertexNormals()
  return g
}

function palm(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const h = 12
  const segs = 4
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs
    const seg = new CylinderGeometry(0.42 - t1 * 0.12, 0.5 - t0 * 0.12, h / segs * 1.04, 5, 1, true)
    seg.translate(Math.pow((t0 + t1) / 2, 2) * 1.6, h * (t0 + t1) / 2, 0)
    parts.push(painted(seg, PALETTE.trunk))
  }
  const top = [1.6, h, 0] as const
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.4
    const leaf = new CylinderGeometry(0.05, 1.1, 6.5, 4, 1)
    leaf.scale(1, 1, 0.3)
    leaf.translate(0, 3.25, 0)
    leaf.rotateZ(-Math.PI / 2 - 0.45)
    leaf.rotateY(a)
    leaf.translate(top[0], top[1], top[2])
    parts.push(painted(leaf, PALETTE.palmLeaf))
  }
  return merge(parts)
}

/** Round broadleaf: chunky trunk + a cluster of three smooth canopy blobs. */
function round(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const trunk = new CylinderGeometry(0.55, 0.85, 6, 5, 1, true)
  trunk.translate(0, 3, 0)
  parts.push(painted(trunk, PALETTE.trunk))
  const c0 = blob(4.6, 1, 1.3); c0.translate(0, 9.2, 0)
  const c1 = blob(3.2, 1, 2.7); c1.translate(2.6, 7.4, 0.8)
  const c2 = blob(3.0, 1, 4.1); c2.translate(-2.2, 7.8, -1.1)
  for (const c of [c0, c1, c2]) parts.push(painted(c, FOLIAGE))
  return merge(parts)
}

/** Tall rounded tree: two stacked soft blobs (reads like a stylised poplar/cypress). */
function tall(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const trunk = new CylinderGeometry(0.45, 0.7, 4, 5, 1, true)
  trunk.translate(0, 2, 0)
  parts.push(painted(trunk, PALETTE.trunk))
  const c0 = blob(3.6, 1, 5.2); c0.scale(1, 1.35, 1); c0.translate(0, 8, 0)
  const c1 = blob(2.6, 1, 6.6); c1.scale(1, 1.3, 1); c1.translate(0, 12.6, 0)
  for (const c of [c0, c1]) parts.push(painted(c, FOLIAGE))
  return merge(parts)
}

export interface TreeResources {
  geometries: BufferGeometry[]
  material: MeshLambertMaterial
  /** Distance fade window (start, end) in metres. */
  fade: { value: [number, number] }
  dispose(): void
}

export function createTreeResources(): TreeResources {
  const geometries = [palm(), round(), tall()]
  const fade = { value: [2000, 2500] as [number, number] }
  const material = new MeshLambertMaterial({ vertexColors: true, toneMapped: false })
  material.name = "World · trees"
  material.onBeforeCompile = shader => {
    shader.uniforms.treeFade = fade
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform vec2 treeFade;")
      .replace("#include <color_vertex>", /* glsl */ `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb = (color.r > 0.99 && color.g > 0.99 && color.b > 0.99) ? instanceColor.rgb : color.rgb;
        #endif`)
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 treeRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          transformed *= 1.0 - smoothstep(treeFade.x, treeFade.y, distance(treeRoot.xz, cameraPosition.xz));
        #endif`)
  }
  material.customProgramCacheKey = () => "world-trees-smooth-v1"
  return {
    geometries, material, fade,
    dispose() {
      for (const g of geometries) g.dispose()
      material.dispose()
    },
  }
}
