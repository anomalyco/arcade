// CPU equivalent of Ashwood's shader-instanced undergrowth, for the offline bake only.
import * as THREE from "three"
import { vec3, float } from "three/tsl"

export const band = (lo: number, hi: number) => ({ lo, hi })
export const solidMaterial = (material: THREE.MeshStandardMaterial) => Object.assign(material.clone(), { colorNode: vec3(material.color.r,material.color.g,material.color.b), roughnessNode: float(material.roughness) })
export function foliageMaterial(_atlas: unknown, color: THREE.Color) {
  const material = new THREE.MeshStandardMaterial({ color })
  material.name = "undergrowth"
  return material
}
/** Every layer built during the bake, so the importer can also export the source's plant templates. */
export const layers: InstLayer[] = []
export class InstLayer {
  meshes: THREE.InstancedMesh[]
  constructor(readonly capacity: number, parts: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; name: string }[]) {
    layers.push(this)
    this.meshes = parts.map(p => {
      const mesh = new THREE.InstancedMesh(p.geometry, p.material, capacity)
      mesh.name = p.name
      return mesh
    })
  }
  set(i: number, x: number, y: number, z: number, scale: number, c: number, s: number, tint: number) {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x,y,z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), -Math.atan2(s,c)), new THREE.Vector3().setScalar(scale))
    for (const mesh of this.meshes) { mesh.setMatrixAt(i,matrix); mesh.setColorAt(i,new THREE.Color(tint,tint,tint)) }
  }
  commit(count: number) { for (const mesh of this.meshes) mesh.count=count }
}
