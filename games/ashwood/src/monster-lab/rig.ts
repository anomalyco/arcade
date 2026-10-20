import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import type { Monster, StandInShape } from "./monsters"

// Loads a monster: its real glb if present, otherwise the grey-clay stand-in (the Mixamo mannequin re-proportioned per
// bone). Every clip is prepared in place (the Hips' horizontal drift removed, its ground speed measured), so the lab
// moves the root itself: along the scene path, or at the clip's own root-motion speed.

const BASE = import.meta.env.BASE_URL
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
let animsPromise: Promise<THREE.AnimationClip[]> | null = null
const mixamoClips = () => (animsPromise ??= loader.loadAsync(`${BASE}models/characters/anims.glb`).then((g) => g.animations))
/** Remy's hip height in the clips (metres), from public/models/characters/roster.json. */
const REF_HIPS = 0.98

export type PreparedClip = {
  clip: THREE.AnimationClip
  /** Forward ground speed of the clip's own root motion (m/s in model units at timeScale 1); 0 if in place. */
  rootSpeed: number
  /** Where it came from, for the UI. */
  source: "model" | "stand-in"
}

export type Rig = {
  monster: Monster
  standIn: boolean
  /** Placed in the world by the lab (position, yaw). Its child `scaler` carries the height scale. */
  root: THREE.Group
  scaler: THREE.Group
  model: THREE.Object3D
  mixer: THREE.AnimationMixer
  clips: Map<string, PreparedClip>
  missing: string[]
  /** Model units → metres at scale slider 1. */
  baseScale: number
  /** Leg length relative to Remy's (in metres, at scale 1): ground speeds scale with it. */
  gait: number
  head: THREE.Object3D
  neck: THREE.Object3D | null
  jaw: THREE.Bone | null
  spine: THREE.Bone[]
  /** Rest quaternions of the bones the lab overrides after the mixer. */
  hips: THREE.Bone | null
}

const clay = () => new THREE.MeshStandardNodeMaterial({ color: 0x8b8781, roughness: 0.72, metalness: 0 })

export async function loadRig(monster: Monster): Promise<Rig> {
  const real = await loader.loadAsync(`${BASE}${monster.glb}`).catch(() => null)
  const gltf = real ?? (await loader.loadAsync(`${BASE}models/characters/remy.glb`))
  const model = gltf.scene
  const standIn = !real
  const bones = new Map<string, THREE.Bone>()
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name.replace(/^mixamorig:?/, ""), o as THREE.Bone)
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.castShadow = true
    m.receiveShadow = true
    m.frustumCulled = false
    if (standIn) {
      if (/eye|lash/i.test(m.name)) m.visible = false
      m.material = clay()
    }
  })
  const p = new THREE.Vector3()
  const hipsBone = bones.get("Hips") ?? null
  const footAt = () => {
    model.updateMatrixWorld(true)
    return Math.min(...["LeftToeBase", "RightToeBase"].map((n) => bones.get(n)?.getWorldPosition(p).y ?? 0))
  }
  const hipsAt = () => (hipsBone ? hipsBone.getWorldPosition(p).y : 1)
  const foot0 = footAt()
  const hipsY = hipsAt()
  let hipRatio = 1
  if (standIn) {
    reshape(model, bones, monster.standIn)
    // Longer legs: raise the hips (and every clip's Hips translation) by the same ratio so the toes stay on the floor.
    hipRatio = (hipsY - footAt()) / (hipsY - foot0)
    if (hipsBone) hipsBone.position.y *= hipRatio
  }
  const footY = footAt()
  const box = new THREE.Box3()
  const crown = bones.get("HeadTop_End")
  let top: number
  if (crown) top = crown.getWorldPosition(p).y
  else {
    box.setFromObject(model, true)
    top = box.max.y
  }
  const legLen = Math.max(hipsAt() - footY, 0.1)
  const baseScale = monster.height / Math.max(top - Math.min(0, footY), 0.1)

  const scaler = new THREE.Group()
  scaler.scale.setScalar(baseScale)
  scaler.add(model)
  const root = new THREE.Group()
  root.name = monster.id
  root.add(scaler)

  const mixer = new THREE.AnimationMixer(model)
  const clips = new Map<string, PreparedClip>()
  const missing: string[] = []
  const own = new Map(gltf.animations.map((a) => [a.name, a]))
  const mixamoRig = bones.has("Hips") && bones.has("LeftUpLeg") && bones.has("Spine")
  const anims = mixamoRig ? new Map((await mixamoClips()).map((a) => [a.name, a])) : new Map<string, THREE.AnimationClip>()
  const prefix = [...model.getObjectsByProperty("isBone", true)].some((b) => b.name.startsWith("mixamorig")) ? findPrefix(model) : ""
  for (const c of monster.clips) {
    const mine = real && c.file ? own.get(c.file) : undefined
    const src = mine ?? anims.get(c.standIn)
    if (!src) {
      missing.push(c.id)
      continue
    }
    clips.set(c.id, prepare(src, mine ? 1 : hipRatio, mine ? "" : prefix, mine ? "model" : "stand-in", bones))
  }

  const b = monster.bones ?? {}
  const pick = (name: string | undefined, fallback: string) => (name ? (model.getObjectByName(name) ?? bones.get(name)) : undefined) ?? bones.get(fallback)
  const head = pick(b.head, "Head") ?? model
  const jawName = b.jaw
  let jaw: THREE.Bone | null = null
  model.traverse((o) => {
    if (!jaw && (o as THREE.Bone).isBone && (o.name === jawName || /jaw/i.test(o.name))) jaw = o as THREE.Bone
  })
  const spine = (b.spine ?? ["Spine", "Spine1", "Spine2"]).map((n) => bones.get(n) ?? (model.getObjectByName(n) as THREE.Bone | undefined)).filter((x): x is THREE.Bone => !!x)
  return {
    monster,
    standIn,
    root,
    scaler,
    model,
    mixer,
    clips,
    missing,
    baseScale,
    gait: (legLen * baseScale) / REF_HIPS,
    head,
    neck: pick(b.neck, "Neck") ?? null,
    jaw,
    spine,
    hips: hipsBone,
  }
}

function findPrefix(model: THREE.Object3D) {
  let pre = ""
  model.traverse((o) => {
    const m = /^(mixamorig:?)Hips$/.exec(o.name)
    if (m) pre = m[1]!
  })
  return pre
}

/**
 * Rotation tracks as they are; Hips translation scaled by `ratio` with its forward/sideways drift removed (a straight
 * line from the first to the last frame is subtracted, so a root-motion loop plays in place and keeps its sway).
 */
function prepare(src: THREE.AnimationClip, ratio: number, prefix: string, source: PreparedClip["source"], bones: Map<string, THREE.Bone>): PreparedClip {
  let rootSpeed = 0
  const tracks: THREE.KeyframeTrack[] = []
  for (const t of src.tracks) {
    const [node, prop] = t.name.split(".") as [string, string]
    const bare = node.replace(/^mixamorig:?/, "")
    if (source === "stand-in" && !bones.has(bare)) continue
    const name = source === "stand-in" ? `${prefix}${bare}.${prop}` : t.name
    if (prop === "quaternion") {
      const c = t.clone()
      c.name = name
      tracks.push(c)
    } else if (prop === "position" && bare === "Hips") {
      const c = t.clone()
      c.name = name
      const v = c.values
      const n = v.length / 3
      for (let i = 0; i < v.length; i++) v[i]! *= ratio
      const dx = v[(n - 1) * 3]! - v[0]!
      const dz = v[(n - 1) * 3 + 2]! - v[2]!
      const dur = Math.max(src.duration, 1e-3)
      rootSpeed = Math.hypot(dx, dz) / dur
      for (let k = 0; k < n; k++) {
        const f = n > 1 ? k / (n - 1) : 0
        v[k * 3] = v[k * 3]! - dx * f
        v[k * 3 + 2] = v[k * 3 + 2]! - dz * f
      }
      tracks.push(c)
    } else if (source === "model") tracks.push(t)
  }
  return { clip: new THREE.AnimationClip(src.name, src.duration, tracks), rootSpeed, source }
}

/**
 * Re-proportions a skinned Mixamo mannequin without shearing: each bone gets a scale in its own frame (`length` along
 * the bone, `girth` across it) folded into the skin's inverse bind matrices, and its children's offsets are scaled the
 * same way, so joints meet and the bone hierarchy stays rigid (animation rotations play unmodified).
 */
function reshape(model: THREE.Object3D, bones: Map<string, THREE.Bone>, s: StandInShape) {
  const thin = s.thin ?? 1
  const limbThin = s.limbThin ?? thin
  const spec = (name: string): [number, number] | null => {
    if (/^(Left|Right)Hand(Index|Middle|Ring|Pinky|Thumb)\d$/.test(name)) return [s.fingers ?? 1, limbThin]
    if (/^(Left|Right)Hand$/.test(name)) return [s.hands ?? 1, limbThin]
    if (/^(Left|Right)ForeArm$/.test(name)) return [s.forearms ?? 1, limbThin]
    if (/^(Left|Right)Arm$/.test(name)) return [s.arms ?? 1, limbThin]
    if (/^(Left|Right)Shoulder$/.test(name)) return [1, thin]
    if (/^(Left|Right)UpLeg$/.test(name)) return [s.thighs ?? 1, limbThin]
    if (/^(Left|Right)Leg$/.test(name)) return [s.shins ?? 1, limbThin]
    if (/^(Left|Right)(Foot|ToeBase)$/.test(name)) return [1, limbThin]
    if (/^Spine\d?$/.test(name)) return [s.spine ?? 1, thin]
    if (name === "Hips") return [1, thin]
    if (name === "Neck") return [s.neck ?? 1, thin]
    if (name === "Head") return [s.head ?? 1, s.head ?? 1]
    return null
  }
  const local = new Map<THREE.Bone, THREE.Matrix4>()
  const d = new THREE.Vector3()
  for (const [name, bone] of bones) {
    const sp = spec(name)
    if (!sp) continue
    const [len, girth] = sp
    const child = bone.children.find((c) => (c as THREE.Bone).isBone && /Spine|Neck|Head|ForeArm|Hand|Leg|Foot|Toe|\d$/.test(c.name) && !/Shoulder|UpLeg/.test(c.name))
    if (child && child.position.lengthSq() > 1e-10) d.copy(child.position).normalize()
    else d.set(0, 1, 0)
    // M = girth·I + (len − girth)·d dᵀ
    const k = len - girth
    const m = new THREE.Matrix4().set(
      girth + k * d.x * d.x, k * d.x * d.y, k * d.x * d.z, 0,
      k * d.y * d.x, girth + k * d.y * d.y, k * d.y * d.z, 0,
      k * d.z * d.x, k * d.z * d.y, girth + k * d.z * d.z, 0,
      0, 0, 0, 1,
    )
    local.set(bone, m)
  }
  for (const [bone, m] of local) for (const c of bone.children) if ((c as THREE.Bone).isBone) c.position.applyMatrix4(m)
  const seen = new Set<THREE.Skeleton>()
  model.traverse((o) => {
    const sk = (o as THREE.SkinnedMesh).skeleton
    if (!sk || seen.has(sk)) return
    seen.add(sk)
    sk.bones.forEach((b, i) => {
      const m = local.get(b)
      if (m) sk.boneInverses[i] = m.clone().multiply(sk.boneInverses[i]!)
    })
  })
}
