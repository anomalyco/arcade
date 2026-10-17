import * as THREE from "three/webgpu"

// How near a module's content is to the player, to stream what's around you first. Bounding spheres alone don't work:
// merged world-spanning meshes (road network, fences) contain every viewpoint. Meshes whose sphere is closer than the
// best so far are refined by sampling their vertices (or instance positions), a few thousand points at most.

const MAX_SAMPLES = 2048
const sphere = new THREE.Sphere()
const v = new THREE.Vector3()
const m = new THREE.Matrix4()

export function distanceTo(root: THREE.Object3D, eye: THREE.Vector3): number {
  root.updateMatrixWorld(true)
  let best = Infinity
  let unbounded = false
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    const g = mesh.geometry
    const pos = g?.getAttribute?.("position") as THREE.BufferAttribute | undefined
    if (!pos) return
    // Unculled drawables (custom-instanced forest parts, wires) have no meaningful bounds.
    if (!o.frustumCulled) {
      unbounded = true
      return
    }
    if (!g.boundingSphere) g.computeBoundingSphere()
    const inst = o as THREE.InstancedMesh
    if (inst.isInstancedMesh) {
      if (!inst.boundingSphere) inst.computeBoundingSphere()
      sphere.copy(inst.boundingSphere!).applyMatrix4(o.matrixWorld)
      if (sphere.distanceToPoint(eye) >= best) return
      const r = g.boundingSphere!.radius
      const step = Math.max(1, Math.ceil(inst.count / MAX_SAMPLES))
      for (let i = 0; i < inst.count; i += step) {
        inst.getMatrixAt(i, m)
        v.copy(g.boundingSphere!.center).applyMatrix4(m).applyMatrix4(o.matrixWorld)
        best = Math.min(best, Math.max(0, v.distanceTo(eye) - r))
      }
      return
    }
    sphere.copy(g.boundingSphere!).applyMatrix4(o.matrixWorld)
    const d = sphere.distanceToPoint(eye)
    if (d >= best) return
    if (sphere.radius < 20) {
      best = Math.max(0, d)
      return
    }
    const step = Math.max(1, Math.ceil(pos.count / MAX_SAMPLES))
    for (let i = 0; i < pos.count; i += step) best = Math.min(best, v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).distanceTo(eye))
  })
  // A module made only of unbounded parts (the forest) is all around you.
  return best === Infinity && unbounded ? 0 : best
}
