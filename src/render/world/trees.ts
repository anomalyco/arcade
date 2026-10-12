import {
  BufferGeometry, Color, ConeGeometry, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, MeshLambertMaterial,
} from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { applyGoldenHaze } from "./atmosphere"
import { PALETTE } from "./palette"

/** White marks "use the instance colour" (foliage); anything else keeps its own palette colour. */
const FOLIAGE = "#ffffff"

/** Prepare a primitive for merging: non-indexed, no uvs/normals (flat shading), one vertex colour. */
export function painted(geometry: BufferGeometry, color: string | Color): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute("uv")
  g.deleteAttribute("normal")
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

function palm(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const h = 12
  for (let i = 0; i < 2; i++) {
    const seg = new CylinderGeometry(0.45 - i * 0.12, 0.6 - i * 0.12, h / 2 * 1.04, 5, 1, true)
    seg.translate(i * 0.7, h * (0.25 + i * 0.5), 0)
    parts.push(painted(seg, PALETTE.trunk))
  }
  const top = [1.2, h, 0] as const
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4
    const leaf = new ConeGeometry(1.6, 7, 3, 1)
    leaf.scale(1, 1, 0.35)
    leaf.translate(0, 3.5, 0)
    leaf.rotateZ(-Math.PI / 2 - 0.35)
    leaf.rotateY(a)
    leaf.translate(top[0], top[1], top[2])
    parts.push(painted(leaf, FOLIAGE))
  }
  return merge(parts)
}

function round(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const trunk = new CylinderGeometry(0.6, 0.9, 5, 5, 1, true)
  trunk.translate(0, 2.5, 0)
  parts.push(painted(trunk, PALETTE.trunk))
  const crown = new IcosahedronGeometry(5.2, 0)
  crown.scale(1, 0.9, 1)
  crown.translate(0, 8.6, 0)
  parts.push(painted(crown, FOLIAGE))
  return merge(parts)
}

function cone(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const trunk = new CylinderGeometry(0.5, 0.7, 3, 5, 1, true)
  trunk.translate(0, 1.5, 0)
  parts.push(painted(trunk, PALETTE.trunk))
  const c1 = new ConeGeometry(4.6, 9, 6, 1)
  c1.translate(0, 7, 0)
  parts.push(painted(c1, FOLIAGE))
  const c2 = new ConeGeometry(3.3, 6.5, 6, 1)
  c2.translate(0, 12, 0)
  parts.push(painted(c2, FOLIAGE))
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
  const geometries = [palm(), round(), cone()]
  const fade = { value: [2000, 2500] as [number, number] }
  const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true, toneMapped: false })
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
  material.customProgramCacheKey = () => "world-trees-lowpoly-v1"
  applyGoldenHaze(material)
  return {
    geometries, material, fade,
    dispose() {
      for (const g of geometries) g.dispose()
      material.dispose()
    },
  }
}
