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
  if (opts.blood) applyCorpseBlood(root, opts.blood)
  body.traverse((o) => {
    o.matrixAutoUpdate = false
    const m = o as THREE.SkinnedMesh
    if (m.isSkinnedMesh) m.frustumCulled = false
  })
  return root
}

/** Pose metadata (kind, wall distance) and this character's chair seat / desk heights, for placing props. */
export async function corpseInfo(character: CorpseCharacter, pose: CorpsePose) {
  const { meta } = await loadShared()
  const ch = meta.characters[character]!
  const p = meta.poses[pose]!
  return { kind: p.kind, wallBehind: p.wallBehind !== undefined ? p.wallBehind * ch.hipRatio : undefined, ...ch.poses[pose] }
}
