import {
  BufferGeometry, Color, ConeGeometry, CylinderGeometry, DataTexture, Float32BufferAttribute, IcosahedronGeometry,
  MeshToonMaterial, NearestFilter, RedFormat, SphereGeometry, Vector3,
} from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"

/** Shared 3-step toon ramp for world props (trees, buildings, clouds). */
export function createToonRamp(): DataTexture {
  const data = new Uint8Array([90, 168, 230, 255])
  const tex = new DataTexture(data, data.length, 1, RedFormat)
  tex.minFilter = NearestFilter
  tex.magFilter = NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

/** Prepare a primitive for merging: drop uvs, bake a flat vertex color. */
export function painted(geometry: BufferGeometry, color: string | Color, shade = 1): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute("uv")
  const col = new Color(color).multiplyScalar(shade)
  const n = g.getAttribute("position").count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b }
  g.setAttribute("color", new Float32BufferAttribute(arr, 3))
  return g
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts, false)
  if (!g) throw new Error("merge failed")
  for (const p of parts) p.dispose()
  g.computeBoundingSphere()
  return g
}

function palm(detail: boolean): BufferGeometry {
  const parts: BufferGeometry[] = []
  const trunkCol = "#9a6b43"
  // Gently curved trunk from stacked, offset segments.
  const segs = detail ? 3 : 2
  const height = 11
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs
    const seg = new CylinderGeometry(0.32 - t1 * 0.1, 0.4 - t0 * 0.1, height / segs * 1.04, detail ? 5 : 3, 1, true)
    seg.translate(0, height * (t0 + t1) / 2, 0)
    const bend = Math.pow((t0 + t1) / 2, 2) * 1.4
    seg.translate(bend, 0, 0)
    parts.push(painted(seg, trunkCol, i % 2 === 0 ? 1 : 0.88))
  }
  const top = new Vector3(1.4, height, 0)
  // Drooping fronds: flattened, bent cones fanned around the crown.
  const fronds = detail ? 7 : 5
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + 0.3
    const leaf = new ConeGeometry(1.1, 6.2, 4, 1)
    leaf.scale(0.22, 1, 1)
    leaf.translate(0, 3.1, 0)
    leaf.rotateZ(-Math.PI / 2 - 0.3) // point outward and droop
    leaf.rotateY(a)
    leaf.translate(top.x, top.y, top.z)
    parts.push(painted(leaf, i % 2 === 0 ? "#3fae3c" : "#58c447"))
  }
  if (detail) {
    const nut = new SphereGeometry(0.75, 5, 3)
    nut.translate(top.x, top.y - 0.6, top.z)
    parts.push(painted(nut, "#6b4a2a"))
  }
  return merge(parts)
}

function broadleaf(detail: boolean): BufferGeometry {
  const parts: BufferGeometry[] = []
  const trunk = new CylinderGeometry(0.35, 0.55, 5, detail ? 5 : 3, 1, true)
  trunk.translate(0, 2.5, 0)
  parts.push(painted(trunk, "#7a5236"))
  const crownCol = "#4fae47"
  const crown = new IcosahedronGeometry(4.2, detail ? 1 : 0)
  crown.scale(1, 0.85, 1)
  crown.translate(0, 7.6, 0)
  parts.push(painted(crown, crownCol))
  if (detail) {
    const b1 = new IcosahedronGeometry(2.8, 0)
    b1.translate(2.4, 6.4, 0.8)
    parts.push(painted(b1, crownCol, 0.94))
    const b2 = new IcosahedronGeometry(2.6, 0)
    b2.translate(-1.9, 9.6, -0.9)
    parts.push(painted(b2, crownCol, 1.06))
  }
  return merge(parts)
}

function pine(detail: boolean): BufferGeometry {
  const parts: BufferGeometry[] = []
  const trunk = new CylinderGeometry(0.28, 0.42, 3.4, detail ? 5 : 3, 1, true)
  trunk.translate(0, 1.7, 0)
  parts.push(painted(trunk, "#6c4a33"))
  const tiers = detail ? 3 : 2
  for (let i = 0; i < tiers; i++) {
    const r = 3.6 - i * 0.9, h = 5.2 - i * 0.6
    const cone = new ConeGeometry(r, h, detail ? 8 : 6, 1)
    cone.translate(0, 3.6 + i * 2.9 + h / 2, 0)
    parts.push(painted(cone, "#2f7d45", 1 - i * 0.05))
  }
  return merge(parts)
}

export interface TreeResources {
  detailed: BufferGeometry[]
  simple: BufferGeometry[]
  material: MeshToonMaterial
  /** Distance fade uniforms (camera world position is provided by three as cameraPosition). */
  fade: { value: [number, number] }
  dispose(): void
}

export function createTreeResources(ramp: DataTexture): TreeResources {
  const detailed = [palm(true), broadleaf(true), pine(true)]
  const simple = [palm(false), broadleaf(false), pine(false)]
  const fade = { value: [2000, 2500] as [number, number] }
  const material = new MeshToonMaterial({ vertexColors: true, gradientMap: ramp, toneMapped: false })
  material.name = "World · trees"
  material.onBeforeCompile = shader => {
    shader.uniforms.treeFade = fade
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform vec2 treeFade;")
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 treeRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float treeGrow = 1.0 - smoothstep(treeFade.x, treeFade.y, distance(treeRoot.xz, cameraPosition.xz));
          transformed *= treeGrow;
        #endif`)
  }
  material.customProgramCacheKey = () => "world-trees-v1"
  return {
    detailed, simple, material, fade,
    dispose() {
      for (const g of [...detailed, ...simple]) g.dispose()
      material.dispose()
    },
  }
}
