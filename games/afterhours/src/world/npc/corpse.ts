import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import { type CorpseBlood, applyCorpseBlood } from "./blood"
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js"

// Posed NPC corpses (public/models/npc/, built by scripts/playerb/npc.ts from gitignored Mixamo sources; the files
// are gitignored too, so callers must handle a failed load). A corpse is the character's skinned mesh with one pose
// written straight into its bones once (no mixer, no per-frame animation): the bones' matrices are then frozen, so
// the per-frame cost is the GPU skinning of a static pose plus the draw.
//
// Poses (npc.json `poses`), each anchored at the floor (y = 0) at the anchor position, turned by `yaw`:
//   lying:  collapse-back, knocked-out-back, face-down, electrocuted, fall-forward-side, lying-still. The body is
//           centred between head and feet, and the head points along +Z before the yaw.
//   slump:  slump-wall, slump-wall-idle. The hips face +Z and are over the anchor; the wall is `wallBehind` metres
//           behind the anchor (−Z).
//   chair:  slump-chair. Seated and folded forward onto a desk in front (+Z). The feet are on the floor, and the
//           anchor is under the hips. The chair seat and desk-top heights the pose needs (per character) are in
//           npc.json `characters[id].poses["slump-chair"]` as `seat` and `desk` (also from corpseInfo); the desk's
//           near edge is about 0.27 m in front of the anchor.

export type CorpsePose =
  | "collapse-back"
  | "knocked-out-back"
  | "face-down"
  | "electrocuted"
  | "fall-forward-side"
  | "lying-still"
  | "slump-wall"
  | "slump-wall-idle"
  | "slump-chair"
export type CorpseCharacter = "joe" | "brian" | "lewis" | "martha" | "roth" | "elizabeth"
export type CorpseAnchor = { x: number; y: number; z: number; yaw: number }

type NpcMeta = {
  poses: Record<string, { kind: string; wallBehind?: number }>
  characters: Record<string, { hipRatio: number; poses: Record<string, { y: number; seat: number | null; desk: number | null; extremities: Record<string, number> }> }>
}

const BASE = `${import.meta.env.BASE_URL}models/npc/`
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
let shared: Promise<{ meta: NpcMeta; poses: Map<string, THREE.AnimationClip> }> | null = null
const models = new Map<string, Promise<THREE.Object3D>>()

function loadShared() {
  shared ??= Promise.all([fetch(`${BASE}npc.json`).then((r) => r.json() as Promise<NpcMeta>), loader.loadAsync(`${BASE}poses.glb`)]).then(([meta, g]) => ({
    meta,
    poses: new Map(g.animations.map((a) => [a.name, a])),
  }))
  return shared
}

function loadModel(id: string) {
  let p = models.get(id)
  if (!p) {
    p = loader.loadAsync(`${BASE}${id}.glb`).then((g) => {
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.castShadow = true
        m.receiveShadow = true
        for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
          if (mat.transparent || /hair|lash/i.test(mat.name)) {
            mat.transparent = false
            mat.alphaTest = 0.4
            mat.side = THREE.DoubleSide
          }
        }
      })
      return g.scene
    })
    models.set(id, p)
  }
  return p
}

/** Close-cropped hair painted on the scalp where the model's hair cards are only a front fringe (blood.ts). */
const SCALP: Partial<Record<CorpseCharacter, readonly [number, number, number]>> = { lewis: [0.022, 0.017, 0.013] }

/** Preload a character (and the shared poses) without spawning. */
export function preloadCorpse(character: CorpseCharacter) {
  return Promise.all([loadShared(), loadModel(character)]).then(() => undefined)
}

/**
 * A posed, frozen corpse at `anchor` (floor point, yaw in radians about +Y). Add the returned group to the scene.
 * `blood`: wounds in bone space, drawn into per-corpse copies of its materials (./blood.ts).
 */
export async function spawnCorpse(character: CorpseCharacter, pose: CorpsePose, anchor: CorpseAnchor, opts: { blood?: CorpseBlood } = {}) {
  const [{ meta, poses }, model] = await Promise.all([loadShared(), loadModel(character)])
  const ch = meta.characters[character]
  const clip = poses.get(pose)
  if (!ch || !clip) throw new Error(`corpse: unknown ${character}/${pose}`)
  const body = cloneSkinned(model)
  const bones = new Map<string, THREE.Object3D>()
  body.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o)
  })
  for (const t of clip.tracks) {
    const [name, prop] = t.name.split(".") as [string, string]
    const b = bones.get(name)
    if (!b) continue
    if (prop === "quaternion") b.quaternion.fromArray(t.values, 0)
    else if (prop === "position" && name === "Hips") b.position.fromArray(t.values, 0).multiplyScalar(ch.hipRatio)
  }
  const root = new THREE.Group()
  root.name = `corpse-${character}-${pose}`
  root.position.set(anchor.x, anchor.y + (ch.poses[pose]?.y ?? 0), anchor.z)
  root.rotation.y = anchor.yaw
  root.add(body)
  root.updateMatrixWorld(true)
  // Always converted: the copies also give the skin its dead pallor (blood.ts); wounds are optional.
  applyCorpseBlood(root, { scalp: SCALP[character], ...(opts.blood ?? { wounds: [] }) })
  // The pose never changes, so bake it into plain meshes: a GPU-skinned corpse shimmers along every silhouette under
  // TAA (the stand-still flicker sweep flagged the 3-08 bodies; static copies measure clean), and skips skinning cost.
  // The skinned originals stay in the hierarchy, hidden, for callers that read the bones or raycast and measure the
  // skinned meshes (badges, blood pools, colliders).
  const skinned: THREE.SkinnedMesh[] = []
  body.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh)
  })
  const toRoot = new THREE.Matrix4()
  const rootInv = root.matrixWorld.clone().invert()
  for (const s of skinned) {
    toRoot.multiplyMatrices(rootInv, s.matrixWorld)
    const hair = ([s.material].flat() as THREE.Material[]).some((m) => /hair/i.test(m.name))
    // Characters whose short hair is painted on the scalp (SCALP) drop their hair cards: lewis's cards are a sparse
    // fringe and tufts that read as a striped ring floating over the painted crop.
    if (hair && SCALP[character]) {
      s.visible = false
      continue
    }
    const mesh = new THREE.Mesh(bakePose(s, toRoot, hair ? 0.0012 : 0), s.material)
    mesh.name = s.name
    mesh.castShadow = s.castShadow
    mesh.receiveShadow = s.receiveShadow
    mesh.renderOrder = s.renderOrder
    root.add(mesh)
    s.visible = false
    mesh.updateMatrix()
    mesh.matrixAutoUpdate = false
  }
  body.traverse((o) => {
    o.matrixAutoUpdate = false
  })
  return root
}

/** The skinned mesh's current pose as a static geometry in the frame `to` maps its local space into. */
/** `inflate` pushes vertices out along their normals (metres): hair cards on short-cropped characters sit almost on
 *  the scalp and z-fight into it once baked, leaving the head bald with a fringe poking out at the edges. */
function bakePose(s: THREE.SkinnedMesh, to: THREE.Matrix4, inflate = 0) {
  const g = s.geometry.clone()
  // The GLBs are quantised (KHR_mesh_quantization: normalised int16 positions/normals). Baked values are in the
  // corpse root's frame (metres, often > 1 m: a seated head is ~1.1 m up), so writing them back into a normalised
  // int16 attribute clamps everything past ±1 — the slumped bodies lost the top of the head and back in a jagged cut.
  // Bake into float copies.
  for (const name of ["position", "normal", "tangent"]) {
    const a = g.getAttribute(name) as THREE.BufferAttribute | undefined
    if (!a || a.array instanceof Float32Array) continue
    const f = new Float32Array(a.count * a.itemSize)
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) f[i * a.itemSize + k] = a.getComponent(i, k)
    g.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize))
  }
  const P = g.attributes.position as THREE.BufferAttribute
  const N = g.attributes.normal as THREE.BufferAttribute | undefined
  const Tn = g.attributes.tangent as THREE.BufferAttribute | undefined
  const si = g.attributes.skinIndex as THREE.BufferAttribute
  const sw = g.attributes.skinWeight as THREE.BufferAttribute
  s.skeleton.update()
  const bones = s.skeleton.boneMatrices!
  const blend = new THREE.Matrix4()
  const full = new THREE.Matrix4()
  const nm = new THREE.Matrix3()
  const v = new THREE.Vector3()
  const e = blend.elements
  for (let i = 0; i < P.count; i++) {
    e.fill(0)
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k)
      if (!w) continue
      const o = si.getComponent(i, k) * 16
      for (let j = 0; j < 16; j++) e[j]! += w * bones[o + j]!
    }
    full.multiplyMatrices(to, s.bindMatrixInverse).multiply(blend).multiply(s.bindMatrix)
    P.setXYZ(i, ...v.fromBufferAttribute(P, i).applyMatrix4(full).toArray())
    if (N || Tn) nm.getNormalMatrix(full)
    if (N) {
      N.setXYZ(i, ...v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize().toArray())
      if (inflate) P.setXYZ(i, P.getX(i) + v.x * inflate, P.getY(i) + v.y * inflate, P.getZ(i) + v.z * inflate)
    }
    if (Tn) {
      v.set(Tn.getX(i), Tn.getY(i), Tn.getZ(i)).transformDirection(full)
      Tn.setXYZ(i, v.x, v.y, v.z)
    }
  }
  g.deleteAttribute("skinIndex")
  g.deleteAttribute("skinWeight")
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/** Pose metadata (kind, wall distance) and this character's chair seat / desk heights, for placing props. */
export async function corpseInfo(character: CorpseCharacter, pose: CorpsePose) {
  const { meta } = await loadShared()
  const ch = meta.characters[character]!
  const p = meta.poses[pose]!
  return { kind: p.kind, wallBehind: p.wallBehind !== undefined ? p.wallBehind * ch.hipRatio : undefined, ...ch.poses[pose] }
}
