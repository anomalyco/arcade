import * as THREE from "three/webgpu"
import type { WorldContext } from "../world/context"

// Placeholder sky and fog. Replaced by the full atmosphere (height fog, night sky, in-scattering inputs).

export function createAtmosphere(ctx: WorldContext) {
  ctx.scene.background = new THREE.Color(0x0b1715)
  ctx.scene.fog = new THREE.FogExp2(0x0e1d1a, 0.018)
  return { update(_dt: number, _time: number) {} }
}
