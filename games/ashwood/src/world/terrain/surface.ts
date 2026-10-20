import type * as THREE from "three/webgpu"
import { attribute, dot, float, mix, vec3 } from "three/tsl"
import { material } from "../../render/materials"

// Ground material: the library forest floor, recoloured toward dry verge grass and bare dirt by a per-vertex
// `surface` attribute (x = grass weight, y = dirt weight). Blending the full grass/dirt scans as well would exceed the
// 16-textures-per-stage WebGPU default; real grass tufts on the verges (forest/undergrowth.ts) carry the grass look.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export function groundMaterial() {
  const base = material("forest_floor") as THREE.MeshStandardNodeMaterial
  const out = base.clone()
  out.name = "terrain_ground"
  const w = attribute("surface", "vec2") as N
  const floor: N = base.colorNode ?? vec3(base.color.r, base.color.g, base.color.b)
  const l = dot(floor, vec3(0.2126, 0.7152, 0.0722)) as N
  const grass = l.mul(vec3(1.35, 1.3, 0.78)).mul(1.15)
  const dirt = l.mul(vec3(1.25, 1.05, 0.85)).mul(1.05)
  out.colorNode = mix(mix(floor, grass, w.x), dirt, w.y)
  const rough: N = base.roughnessNode ?? float(base.roughness)
  out.roughnessNode = mix(rough, float(0.95), w.x.mul(0.6))
  return out
}
