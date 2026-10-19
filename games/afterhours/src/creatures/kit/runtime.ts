import * as THREE from "three/webgpu"
import { decodeCreature, type CreatureData } from "./format"

// Runtime side of a baked creature: geometry + skeleton → one SkinnedMesh (one draw call, plus its shadow pass).
// Bind-pose bones carry no rotation (they are authored world-aligned), so a bone's rest direction in its own frame
// is simply tail − head, which the IK and look-at helpers use.

export type CreatureRig = {
  root: THREE.Group
  mesh: THREE.SkinnedMesh
  bones: THREE.Bone[]
  byName: Map<string, THREE.Bone>
  /** Rest-pose local position of each bone. */
  rest: THREE.Vector3[]
  /** Unit rest direction (head → tail) in the bone's own frame. */
  dir: THREE.Vector3[]
  /** Rest length head → tail. */
  length: number[]
  data: CreatureData
}

export async function loadCreatureData(url: string, fallback?: () => Promise<CreatureData>): Promise<CreatureData> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status}`)
    return decodeCreature(await res.arrayBuffer())
  } catch (e) {
    if (!fallback) throw e
    console.warn(`creature: ${url} missing (${e}); generating in the browser`)
    return fallback()
  }
}

/** `material` may be an array, indexed by each baked part's `material` slot. */
export function buildCreature(data: CreatureData, material: THREE.Material | THREE.Material[]): CreatureRig {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3))
  g.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3))
  g.setAttribute("skinIndex", new THREE.BufferAttribute(data.skinIndex, 4))
  g.setAttribute("skinWeight", new THREE.BufferAttribute(data.skinWeight, 4, true))
  g.setAttribute("attrA", new THREE.BufferAttribute(data.attrA, 4, true))
  g.setAttribute("attrB", new THREE.BufferAttribute(data.attrB, 4, true))
  g.setAttribute("fiber", new THREE.BufferAttribute(data.fiber, 4, true))
  g.setIndex(new THREE.BufferAttribute(data.indices, 1))
  if (Array.isArray(material)) for (const p of data.parts) g.addGroup(p.start, p.count, p.material ?? 0)
  g.computeBoundingSphere()
  g.computeBoundingBox()

  const bones: THREE.Bone[] = []
  const rest: THREE.Vector3[] = []
  const dir: THREE.Vector3[] = []
  const length: number[] = []
  const byName = new Map<string, THREE.Bone>()
  for (const b of data.bones) {
    const bone = new THREE.Bone()
    bone.name = b.name
    const p = data.bones[b.parent]
    bone.position.set(b.head[0] - (p ? p.head[0] : 0), b.head[1] - (p ? p.head[1] : 0), b.head[2] - (p ? p.head[2] : 0))
    rest.push(bone.position.clone())
    const d = new THREE.Vector3(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2])
    length.push(d.length())
    dir.push(d.normalize())
    if (b.parent >= 0) bones[b.parent]!.add(bone)
    bones.push(bone)
    byName.set(b.name, bone)
  }
  const mesh = new THREE.SkinnedMesh(g, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  const root = new THREE.Group()
  root.add(bones[0]!)
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton(bones), mesh.matrixWorld)
  return { root, mesh, bones, byName, rest, dir, length, data }
}
