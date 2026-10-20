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

const cache = new Map<string, Promise<CreatureData | null>>()

/**
 * The baked creature at `url`, fetched and parsed once per page (every spawn shares it). If the file is missing,
 * fails to parse, or is older than `version`, it is logged and `generate` (if given) runs in a Web Worker, never on
 * the main thread: a stale-but-valid bake is used meanwhile only when there is no worker result. Resolves null when
 * there is nothing usable (callers skip the creature).
 */
export function loadCreatureData(url: string, o: { version?: number; generate?: () => Worker } = {}): Promise<CreatureData | null> {
  let p = cache.get(url)
  if (p) return p
  p = (async () => {
    let data: CreatureData | null = null
    let why = ""
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = decodeCreature(await res.arrayBuffer())
      if (o.version !== undefined && (data.version ?? 0) < o.version) why = `stale bake (version ${data.version ?? 0} < ${o.version})`
    } catch (e) {
      why = `unusable bake (${e instanceof Error ? e.message : e})`
    }
    if (!why) return data
    console.warn(`creature: ${url}: ${why}`)
    if (!o.generate) return data
    try {
      const generated = await inWorker(o.generate())
      console.info(`creature: ${url} generated in a worker`)
      return generated
    } catch (e) {
      console.warn(`creature: worker generation failed (${e instanceof Error ? e.message : e})${data ? "; using the stale bake" : "; skipping the creature"}`)
      return data
    }
  })()
  cache.set(url, p)
  return p
}

function inWorker(w: Worker): Promise<CreatureData> {
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<{ ok: boolean; bytes?: ArrayBuffer; error?: string }>) => {
      w.terminate()
      if (e.data.ok && e.data.bytes) resolve(decodeCreature(e.data.bytes))
      else reject(new Error(e.data.error ?? "worker failed"))
    }
    w.onerror = (e) => {
      w.terminate()
      reject(new Error(e.message))
    }
    w.postMessage("go")
  })
}

const geoCache = new WeakMap<CreatureData, THREE.BufferGeometry>()

/** `material` may be an array, indexed by each baked part's `material` slot. */
export function buildCreature(data: CreatureData, material: THREE.Material | THREE.Material[]): CreatureRig {
  // One geometry per baked creature, shared by every instance (skinning is per mesh, the vertex data isn't).
  let g = geoCache.get(data)
  if (!g) {
    g = buildGeometry(data, Array.isArray(material))
    geoCache.set(data, g)
  }
  return buildRig(data, g, material)
}

function buildGeometry(data: CreatureData, groups: boolean) {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3))
  g.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3))
  g.setAttribute("skinIndex", new THREE.BufferAttribute(data.skinIndex, 4))
  g.setAttribute("skinWeight", new THREE.BufferAttribute(data.skinWeight, 4, true))
  g.setAttribute("attrA", new THREE.BufferAttribute(data.attrA, 4, true))
  g.setAttribute("attrB", new THREE.BufferAttribute(data.attrB, 4, true))
  g.setAttribute("fiber", new THREE.BufferAttribute(data.fiber, 4, true))
  // 1 on the face (the skull and jaw parts): close-up kills keep it while cutting what's between it and the eye.
  const face = new Float32Array(data.positions.length / 3)
  for (const p of data.parts) if (p.name === "skull" || p.name === "jaw") for (let k = p.start; k < p.start + p.count; k++) face[data.indices[k]!] = 1
  g.setAttribute("face", new THREE.BufferAttribute(face, 1))
  g.setIndex(new THREE.BufferAttribute(data.indices, 1))
  if (groups) for (const p of data.parts) g.addGroup(p.start, p.count, p.material ?? 0)
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return g
}

function buildRig(data: CreatureData, g: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): CreatureRig {

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
