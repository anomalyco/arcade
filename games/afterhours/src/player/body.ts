import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"
import { aimQuat, refresh, refreshTree, rotateWorld, setWorldQuat, twoBoneIK, worldPos, worldQuat } from "./ik"
import { createTorch } from "./torch"
import { createHand, LOOSE_FIST, newPose, relaxedPose, scaleFinger, TORCH_GRIP, type HandPose } from "./hands"
import { TORCH_BARREL_R } from "./torch"

// The player's body as a self-contained character component (full-body awareness, the way shipped first-person games
// do it): one root at the controller's feet, moved there every frame and turned to its yaw; everything else is local
// to that root. The controller owns where the body is; the body only animates.
//
//   1. Locomotion from authored clips (public/models/player/janitor.glb, see CREDITS.md), played by an AnimationMixer
//      at real time: gait by speed (idle · walk · jog · run, crouch idle/walk) × direction by travel angle (forward ·
//      back · left · right, real captured loops for walk and jog), playback rate = speed ÷ the clip's authored speed,
//      cross-faded by weight. The direction loops of a gait share normalized time. The controller's walk/run/crouch
//      speeds should match the clips' authored speeds (`clipInfo()`), so there is nothing to warp.
//   2. Light IK on top, vertical only: each boot lifted onto the surface under it (stairs, slopes), the pelvis lowered
//      only as far as a leg needs to reach its step. The root sits a fixed distance behind the eye (character space).
//   3. Upper body: the spine and head follow the view pitch and the aim's yaw; the right arm holds the flashlight
//      (IK to a pose that follows the aim, fingers in the torch clip's grip); E reaches a free hand out.
//
// Rendering: the body is on BODY_LAYER (the first-person camera sees it), its head/neck/hair on HEAD_LAYER (only
// shadows and debug cameras see it), so there is no head in your face but your silhouette has one.

export const BODY_LAYER = 3
export const HEAD_LAYER = 4

/** What the body reads every frame: the shape of the game's `PlayerState` (src/player.ts). */
export type BodyInput = {
  readonly pos: { readonly x: number; readonly y: number; readonly z: number }
  readonly vel: { readonly x: number; readonly y: number; readonly z: number }
  readonly eye: { readonly x: number; readonly y: number; readonly z: number }
  readonly yaw: number
  readonly pitch: number
  readonly crouch: number
  readonly grounded: boolean
  readonly onLadder: boolean
  readonly flashlight: boolean
  readonly fly: boolean
}

/** Highest walkable surface at (x, z) no higher than `maxY` (the controller's own ground query). */
export type GroundQuery = (x: number, z: number, maxY: number) => number

export const BODY_DEFAULTS = {
  "body.back": 0.08,
  "body.lookBack": 0.2,
  "body.yawHz": 10,
  "body.turnStart": 60,
  "body.turnSpeed": 260,
  "body.velHz": 9,
  "body.moveFrom": 0.12,
  "body.fade": 0.2,
  "body.rateMin": 0.6,
  "body.gaitBand": 0.08,
  "body.gaitHold": 1.35,
  "body.rateMax": 1.6,
  "body.jumpStartAt": 0.42,
  "body.footIK": true,
  "body.footIKWeight": 1,
  "body.ikMax": 0.65,
  "body.ikHz": 18,
  "body.pelvisFollow": 0.5,
  "body.slopeAlign": 0.8,
  "body.spinePitch": 0.12,
  "body.downLean": 0.25,
  "body.spineYaw": 0.85,
  "body.torch": true,
  "body.handPoses": true,
  "body.fingerCurl": 1.3,
  "body.thumbOppose": 30,
  "body.thumbAlong": -35,
  "body.thumbCurl": 15,
  "body.fingersTogether": 3,
  "body.carryShoulder": 22,
  "body.carryAcross": 18,
  "body.carryRaise": 26,
  "body.carrySwing": 4,
  "body.torchYaw": 35,
  "body.torsoRadius": 0.16,
  "body.reachTime": 0.8,
  "body.ladderRung": 0.3,
  "body.ladderGap": 0.32,
} satisfies LabSettings

const G = "Body"
export const BODY_CONTROLS: LabControl[] = [
  { key: "body.back", label: "Neck behind the eye", group: G, subsection: "First person", unit: "m", min: 0, max: 0.35, step: 0.01 },
  { key: "body.lookBack", label: "Extra back when looking down", group: G, subsection: "First person", unit: "m", min: 0, max: 0.3, step: 0.01 },
  { key: "body.yawHz", label: "Body yaw follow", group: G, subsection: "Facing", unit: "Hz", min: 1, max: 30, step: 0.5 },
  { key: "body.turnStart", label: "Turn in place beyond", group: G, subsection: "Facing", unit: "°", min: 10, max: 120, step: 1 },
  { key: "body.turnSpeed", label: "Turn-in-place speed", group: G, subsection: "Facing", unit: "°/s", min: 60, max: 720, step: 10 },
  { key: "body.spineYaw", label: "Spine twist toward the aim", group: G, subsection: "Facing", unit: "×", min: 0, max: 1, step: 0.05 },
  { key: "body.downLean", label: "Chest back when looking down", group: G, subsection: "First person", unit: "×", min: 0, max: 1, step: 0.05 },
  { key: "body.spinePitch", label: "Spine bend with the view pitch", group: G, subsection: "Facing", unit: "×", min: 0, max: 1, step: 0.05 },
  { key: "body.velHz", label: "Velocity smoothing", group: G, subsection: "Blend space", unit: "Hz", min: 1, max: 30, step: 0.5 },
  { key: "body.moveFrom", label: "Idle → move from", group: G, subsection: "Blend space", unit: "m/s", min: 0.02, max: 0.6, step: 0.01 },
  { key: "body.rateMin", label: "Playback rate min (× authored)", group: G, subsection: "Blend space", unit: "×", min: 0.3, max: 1, step: 0.05 },
  { key: "body.rateMax", label: "Playback rate max (× authored)", group: G, subsection: "Blend space", unit: "×", min: 1, max: 3, step: 0.05 },
  { key: "body.gaitHold", label: "Hold a gait up to (× its speed)", group: G, subsection: "Blend space", unit: "×", min: 1, max: 2, step: 0.05 },
  { key: "body.gaitBand", label: "Gait change band", group: G, subsection: "Blend space", unit: "m/s", min: 0.02, max: 0.6, step: 0.01 },
  { key: "body.fade", label: "State cross-fade", group: G, subsection: "Blend space", unit: "s", min: 0.02, max: 0.6, step: 0.01 },
  { key: "body.jumpStartAt", label: "Jump start clip from", group: G, subsection: "Blend space", unit: "s", min: 0, max: 1, step: 0.01 },
  { key: "body.footIK", label: "Foot + pelvis IK", group: G, subsection: "IK", type: "toggle" },
  { key: "body.footIKWeight", label: "Foot IK weight", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.ikMax", label: "IK height range", group: G, subsection: "IK", unit: "m", min: 0, max: 0.6, step: 0.01 },
  { key: "body.pelvisFollow", label: "Hips follow the lower foot", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.ikHz", label: "IK smoothing", group: G, subsection: "IK", unit: "Hz", min: 2, max: 40, step: 1 },
  { key: "body.slopeAlign", label: "Boots align to slope", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.handPoses", label: "Authored hand poses (off: clip fingers)", group: G, subsection: "Hands", type: "toggle" },
  { key: "body.fingerCurl", label: "Relaxed finger curl", group: G, subsection: "Hands", unit: "×", min: 0, max: 2.5, step: 0.05 },
  { key: "body.thumbOppose", label: "Thumb toward the palm", group: G, subsection: "Hands", unit: "°", min: -40, max: 70, step: 1 },
  { key: "body.thumbAlong", label: "Thumb along the index", group: G, subsection: "Hands", unit: "°", min: -40, max: 60, step: 1 },
  { key: "body.thumbCurl", label: "Thumb tip curl", group: G, subsection: "Hands", unit: "°", min: 0, max: 50, step: 1 },
  { key: "body.fingersTogether", label: "Fingers together", group: G, subsection: "Hands", unit: "°", min: -6, max: 12, step: 0.5 },
  { key: "body.torch", label: "Hold the flashlight", group: G, subsection: "Hands", type: "toggle" },
  { key: "body.carryShoulder", label: "Torch carry: upper arm forward", group: G, subsection: "Hands", unit: "°", min: 0, max: 60, step: 1 },
  { key: "body.carryAcross", label: "Torch carry: forearm across the body", group: G, subsection: "Hands", unit: "°", min: 0, max: 70, step: 1 },
  { key: "body.carryRaise", label: "Torch carry: forearm raised", group: G, subsection: "Hands", unit: "°", min: -30, max: 45, step: 1 },
  { key: "body.carrySwing", label: "Torch carry: swing with the walk", group: G, subsection: "Hands", unit: "°", min: 0, max: 15, step: 0.5 },
  { key: "body.torchYaw", label: "Torch aims ± (beyond: the beam leads)", group: G, subsection: "Hands", unit: "°", min: 0, max: 60, step: 1 },
  { key: "body.torsoRadius", label: "Torso clearance radius", group: G, subsection: "Hands", unit: "m", min: 0.1, max: 0.25, step: 0.005 },
  { key: "body.reachTime", label: "E reach duration", group: G, subsection: "Hands", unit: "s", min: 0.3, max: 1.5, step: 0.05 },
  { key: "body.ladderRung", label: "Ladder rung spacing", group: G, subsection: "Ladder", unit: "m", min: 0.2, max: 0.4, step: 0.01 },
  { key: "body.ladderGap", label: "Ladder ahead of the feet", group: G, subsection: "Ladder", unit: "m", min: 0.1, max: 0.6, step: 0.01 },
]

/** Locomotion loops. */
const LOOPS = ["idle", "walk", "walk_back", "strafe_l", "strafe_r", "jog", "jog_back", "jog_l", "jog_r", "run", "crouch_idle", "crouch_walk"] as const
type Loop = (typeof LOOPS)[number]
type Dir = "f" | "b" | "l" | "r"
/** One gait: its direction loops, which cycle together. */
type Gait = { clips: { loop: Loop; dir: Dir }[] }
const GAITS = {
  walk: { clips: [{ loop: "walk", dir: "f" }, { loop: "walk_back", dir: "b" }, { loop: "strafe_l", dir: "l" }, { loop: "strafe_r", dir: "r" }] },
  jog: { clips: [{ loop: "jog", dir: "f" }, { loop: "jog_back", dir: "b" }, { loop: "jog_l", dir: "l" }, { loop: "jog_r", dir: "r" }] },
  run: { clips: [{ loop: "run", dir: "f" }] },
  crouch: { clips: [{ loop: "crouch_walk", dir: "f" }] },
} satisfies Record<string, Gait>
type ClipInfo = { action: THREE.AnimationAction; dur: number; speed: number; offset: number; neck: number }

const BONES = [
  "root", "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head",
  "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r",
  "thigh_l", "calf_l", "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r",
  "index_01_r", "pinky_01_r", "middle_01_r",
] as const
type BoneName = (typeof BONES)[number]

const FINGER_R = /^(index|middle|ring|pinky|thumb)_0[123]_r$/
const UP = new THREE.Vector3(0, 1, 0)
const v3 = () => new THREE.Vector3()
const damp = (hz: number, dt: number) => 1 - Math.exp(-hz * dt)
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const smooth01 = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b)

export type BodyDebug = {
  /** Per foot: planted this frame, and the foot's world speed while planted (m/s, EMA). */
  planted: [boolean, boolean]
  slide: [number, number]
  /** Blend weights by clip name, the gait phase and the active state. */
  weights: Record<string, number>
  phase: number
  state: string
  /** Treadmill: the controller's velocity while the body stays put (a planted foot should move at minus this). */
  belt: THREE.Vector3
}

export class PlayerBody {
  /** At the controller's feet, turned to the body's yaw. */
  readonly root = new THREE.Group()
  readonly settings: LabSettings
  readonly ready: Promise<void>
  readonly debug: BodyDebug = { planted: [true, true], slide: [0, 0], weights: {}, phase: 0, state: "", belt: v3() }
  model: THREE.Object3D | null = null
  mixer: THREE.AnimationMixer | null = null
  private bones = {} as Record<BoneName, THREE.Bone>
  private handL: ReturnType<typeof createHand> | null = null
  private handR: ReturnType<typeof createHand> | null = null
  private restTRS = new Map<THREE.Object3D, { p: THREE.Vector3; q: THREE.Quaternion }>()
  private loops = {} as Record<Loop, ClipInfo>
  private actions = new Map<string, THREE.AnimationAction>()
  /** Authored flashlight grip: right finger local rotations (torch clip, first frame). */
  private grip: { bone: THREE.Object3D; q: THREE.Quaternion }[] = []
  private torch = createTorch()
  private ground: GroundQuery
  // Motion state.
  private bodyYaw = Number.NaN
  private turning = false
  private gaits: Record<keyof typeof GAITS, Gait> = GAITS
  private gaitW = { idle: 1, walk: 0, jog: 0, run: 0, crouch_idle: 0, crouch_walk: 0 }
  private legLen = 0.9
  private lv = new THREE.Vector2() // smoothed local velocity (x = right, y = forward)
  private phase = 0
  private air = 0
  private airT = 0
  private landT = -1
  private jumpT = -1
  private ladder = 0
  private ladderPhase = 0
  private crouchW = 0
  private torchW = 0
  private reachT = -1
  private footOff = [0, 0]
  private pelvisOff = 0
  private prevFoot = [v3(), v3()]
  private hasPrev = false
  private lastY = 0
  // Rig data measured at load.
  private eyeAboveNeck = 0.11
  private handAxis = v3() // pinky→index across the fist, hand-local
  private handBack = v3() // hand → wrist, hand-local
  private restFootH = [0.08, 0.08]

  constructor(opts: { url: string; settings?: LabSettings; ground: GroundQuery; compile?: (o: THREE.Object3D) => Promise<unknown> }) {
    this.settings = opts.settings ?? {}
    for (const [k, v] of Object.entries(BODY_DEFAULTS)) this.settings[k] ??= v
    this.ground = opts.ground
    this.root.name = "player-body"
    this.root.visible = false
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    this.ready = loader.loadAsync(opts.url).then(async (gltf) => {
      this.setup(gltf.scene, gltf.animations)
      if (opts.compile) await opts.compile(this.root).catch(() => {})
      this.model = gltf.scene
    })
  }

  private num(k: keyof typeof BODY_DEFAULTS) {
    return Number(this.settings[k] ?? BODY_DEFAULTS[k])
  }
  private on(k: keyof typeof BODY_DEFAULTS) {
    return this.settings[k] !== false && this.settings[k] !== 0
  }

  /** Triggers the E reach (a free hand out to handle height and back). */
  reach() {
    this.reachT = 0
  }

  /** Torch lens position and beam direction (world), for a light that should come out of the torch. */
  torchLens(pos: THREE.Vector3, dir: THREE.Vector3) {
    const lens = this.torch.userData.lens as THREE.Object3D
    lens.getWorldPosition(pos)
    dir.set(0, 0, -1).applyQuaternion(lens.getWorldQuaternion(new THREE.Quaternion()))
    return this.torch.visible
  }

  private setup(scene: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.root.add(scene)
    // The model faces +Z; the root's yaw convention is the controller's (forward = -Z at yaw 0).
    scene.rotation.y = Math.PI
    scene.updateMatrixWorld(true)
    const byName = new Map<string, THREE.Bone>()
    scene.traverse((o) => (o as THREE.Bone).isBone && byName.set(o.name, o as THREE.Bone))
    for (const b of byName.values()) this.restTRS.set(b, { p: b.position.clone(), q: b.quaternion.clone() })
    this.handL = createHand(byName, "l")
    this.handR = createHand(byName, "r")
    for (const n of BONES) {
      const b = byName.get(n)
      if (!b) throw new Error(`janitor.glb: missing bone ${n}`)
      this.bones[n] = b
    }
    const mixer = (this.mixer = new THREE.AnimationMixer(scene))
    for (const clip of clips) {
      const a = mixer.clipAction(clip)
      a.enabled = false
      a.play()
      this.actions.set(clip.name, a)
    }
    for (const name of ["jump_start", "jump_land"]) {
      const a = this.actions.get(name)
      if (a) {
        a.setLoop(THREE.LoopOnce, 1)
        a.clampWhenFinished = true
      }
    }
    this.eyeAboveNeck = 1.655 - this.bones.neck_01.getWorldPosition(v3()).y
    // Flashlight grip: pose the authored fist (hands.ts TORCH_GRIP) on the bind pose and measure it: the barrel axis
    // runs pinky → index knuckle through the fist, the hand's "back" axis runs to the knuckles, and the barrel sits in
    // the tunnel the curled middle phalanges and the thumb make.
    const torchClip = clips.find((c) => c.name === "torch")
    if (torchClip) {
      for (const t of torchClip.tracks) {
        const [bone, prop] = t.name.split(".")
        const node = byName.get(bone!)
        if (node && prop === "quaternion" && FINGER_R.test(bone!)) this.grip.push({ bone: node, q: new THREE.Quaternion().fromArray(t.values, 0) })
      }
    }
    this.fitGrip(scene, byName)
    this.bones.hand_r.add(this.torch)
    this.torch.traverse((o) => o.layers.set(BODY_LAYER))
    for (const [o, t] of this.restTRS) o.quaternion.copy(t.q)

    // Measure every loop: ground speed (planted foot), stride phase (left footfall), foot height at rest.
    const root = this.root
    root.updateMatrixWorld(true)
    const measure = (name: Loop): ClipInfo => {
      const action = this.actions.get(name)
      if (!action) throw new Error(`janitor.glb: missing clip ${name}`)
      const dur = action.getClip().duration
      const N = 48
      const fl: THREE.Vector3[] = []
      const fr: THREE.Vector3[] = []
      let neck = 0
      for (const a of this.actions.values()) a.enabled = false
      action.enabled = true
      action.setEffectiveWeight(1)
      for (let i = 0; i < N; i++) {
        action.time = (dur * i) / N
        mixer.update(0)
        scene.updateMatrixWorld(true)
        fl.push(this.bones.ball_l.getWorldPosition(v3()))
        fr.push(this.bones.ball_r.getWorldPosition(v3()))
        neck += this.bones.neck_01.getWorldPosition(v3()).y / N
      }
      action.enabled = false
      // Ground speed: how fast the supporting (lower) foot slides back under the in-place body, median over the cycle
      // (the 2 cm-above-lowest test it replaced caught only the flat-foot instant and doubled the jog's speed).
      // (A foot counts as supporting while it is the lower one and within 3 cm of its own lowest point, so a run's
      // flight phase — both feet up, the lower one swinging — is left out.)
      const v: number[] = []
      const minF = [Math.min(...fl.map((p) => p.y)), Math.min(...fr.map((p) => p.y))]
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N
        const li = fl[i]!.y <= fr[i]!.y ? 0 : 1
        const f = li === 0 ? fl : fr
        if ((fl[i]!.y <= fr[i]!.y) !== (fl[j]!.y <= fr[j]!.y)) continue
        if (f[i]!.y > minF[li]! + 0.03 || f[j]!.y > minF[li]! + 0.03) continue
        v.push(Math.hypot(f[j]!.x - f[i]!.x, f[j]!.z - f[i]!.z) / (dur / N))
      }
      v.sort((a, b) => a - b)
      const dist = v.length ? v[v.length >> 1]! : 0
      const time = 1
      // Phase origin: the left foot's touchdown (it reaches its stance height).
      const minL = Math.min(...fl.map((p) => p.y))
      let offset = 0
      for (let i = 0; i < N; i++) {
        const prev = (i + N - 1) % N
        if (fl[i]!.y <= minL + 0.02 && fl[prev]!.y > minL + 0.02) {
          offset = i / N
          break
        }
      }
      return { action, dur, speed: time > 0 ? dist / time : 0, offset, neck }
    }
    for (const l of LOOPS) this.loops[l] = measure(l)
    this.loops.idle.speed = 0
    this.loops.crouch_idle.speed = 0
    for (const a of this.actions.values()) a.enabled = false
    mixer.update(0)
    scene.updateMatrixWorld(true)
    this.legLen = this.bones.thigh_r.getWorldPosition(v3()).distanceTo(this.bones.calf_r.getWorldPosition(v3())) + this.bones.calf_r.getWorldPosition(v3()).distanceTo(this.bones.foot_r.getWorldPosition(v3()))
    this.restFootH = [this.bones.foot_l.getWorldPosition(v3()).y, this.bones.foot_r.getWorldPosition(v3()).y]

    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh
      if (!mesh.isSkinnedMesh) return
      mesh.frustumCulled = false
      mesh.castShadow = true
      mesh.receiveShadow = false
      mesh.layers.set(BODY_LAYER)
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.side = THREE.FrontSide
      mat.envMapIntensity = 0.5
      // Hair and the bare head/neck go to the head layer; clothes stay whole (a cut collar shows the inside of the shirt).
      if (/shoes/.test(mesh.name)) this.measureContacts(mesh, "boot")
      if (/casualsuit/.test(mesh.name)) this.measureContacts(mesh, "shin")
      if (mesh.name.includes("short02")) mesh.layers.set(HEAD_LAYER)
      else if (!/casualsuit|shoes/.test(mesh.name)) splitHead(mesh, new Set<THREE.Object3D>([this.bones.Head, this.bones.neck_01]))
    })
    this.root.visible = true
  }

  private pose = newPose()
  private relaxed() {
    return relaxedPose(this.num("body.fingerCurl"), this.num("body.thumbOppose"), this.num("body.thumbAlong"), this.num("body.thumbCurl"), this.num("body.fingersTogether"), this.pose)
  }

  /**
   * Acceptance check: the deepest any leg/boot vertex (skinned, this frame) sits below the walkable surface under it,
   * in metres (0 = nothing inside the floor or a tread), and how many vertices are more than 1 cm in.
   */
  penetration(ground: GroundQuery) {
    let worst = 0
    let count = 0
    let where = ""
    const v = new THREE.Vector3()
    const top = this.root.position.y + 0.9
    this.model?.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh || !/casualsuit|shoes/.test(m.name)) return
      const pos = m.geometry.getAttribute("position")
      const idx = m.geometry.index
      const used = new Uint8Array(pos.count)
      if (idx) for (let i = 0; i < idx.count; i++) used[idx.getX(i)] = 1
      for (let i = 0; i < pos.count; i += 2) {
        if (idx && !used[i]) continue
        m.getVertexPosition(i, v)
        v.applyMatrix4(m.matrixWorld)
        if (v.y > top) continue
        const g = ground(v.x, v.z, v.y + 0.02)
        // Only surfaces below the vertex count; a vertex in front of a riser is checked against the riser's tread.
        const above = ground(v.x, v.z, 99)
        const d = Math.max(g, above > v.y && above - v.y < 0.3 ? above : g) - v.y
        if (d > worst) {
          worst = d
          where = `${m.name} v${i} at ${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)} surface ${Math.max(g, above).toFixed(2)} root ${this.root.position.y.toFixed(2)} feet ${[this.bones.foot_l, this.bones.foot_r].map((b) => b.getWorldPosition(new THREE.Vector3()).toArray().map((x) => x.toFixed(2)).join(",")).join(" / ")}`
        }
        if (d > 0.01) count++
      }
    })
    return { worst, count, where }
  }

  /** A gait fading in: put its loops at the normalized time of the strongest moving gait already playing. */
  private syncIn(k: keyof PlayerBody["gaitW"]) {
    const moving: [keyof PlayerBody["gaitW"], Gait][] = [["walk", GAITS.walk], ["jog", GAITS.jog], ["run", GAITS.run], ["crouch_walk", GAITS.crouch]]
    const me = moving.find(([n]) => n === k)
    if (!me) return
    let best: Gait | null = null
    let bw = 1e-3
    for (const [n, g] of moving) if (n !== k && this.gaitW[n] > bw) [best, bw] = [g, this.gaitW[n]]
    const lead = best ? this.loops[best.clips[0]!.loop] : null
    const u = lead ? lead.action.time / lead.dur : 0
    for (const c of me[1].clips) this.loops[c.loop].action.time = u * this.loops[c.loop].dur
  }

  /** The flashlight grip fitted to this hand and barrel (see fitGrip). */
  private gripPose: HandPose = structuredClone(TORCH_GRIP)

  /**
   * Fits the flashlight grip to the actual skin: the barrel (34 mm, `TORCH_BARREL_R`) lies across the palm, its axis
   * pinky → index a barrel radius plus the palm's thickness in front of the knuckle line; then each finger (and the
   * thumb) curls by bisection to the most it can without any of its skinned vertices entering the barrel. The fingers
   * end up wrapped on the barrel's surface instead of through it.
   */
  private fitGrip(scene: THREE.Object3D, byName: Map<string, THREE.Bone>) {
    const at = (n: string) => (byName.get(n) as THREE.Object3D).getWorldPosition(v3())
    const hand = this.bones.hand_r
    scene.updateMatrixWorld(true)
    const across = at("index_01_r").sub(at("pinky_01_r")).normalize()
    const along = at("middle_01_r").sub(at("hand_r")).normalize()
    // Palm normal (toward the palm), as hands.ts measures it for the right hand.
    const palm = new THREE.Vector3().crossVectors(along, across.clone().negate()).normalize()
    const knuckles = at("index_01_r").add(at("pinky_01_r")).multiplyScalar(0.5)
    const centre = knuckles.addScaledVector(palm, TORCH_BARREL_R + 0.016).addScaledVector(along, -0.012)
    const skin = (() => {
      let m: THREE.SkinnedMesh | null = null
      scene.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.name === "Human") m = o as THREE.SkinnedMesh
      })
      return m as THREE.SkinnedMesh | null
    })()
    const fingers = ["index", "middle", "ring", "pinky", "thumb"] as const
    const verts: Record<string, number[]> = { index: [], middle: [], ring: [], pinky: [], thumb: [] }
    if (skin) {
      const ji = skin.geometry.getAttribute("skinIndex")
      const jw = skin.geometry.getAttribute("skinWeight")
      const names = skin.skeleton.bones.map((bn) => bn.name)
      for (let i = 0; i < ji.count; i++) {
        let best = 0
        let bi = -1
        for (let c = 0; c < 4; c++) if (jw.getComponent(i, c) > best) [best, bi] = [jw.getComponent(i, c), ji.getComponent(i, c)]
        const m = /^(index|middle|ring|pinky|thumb)_0[23]_r$/.exec(names[bi] ?? "")
        if (m) verts[m[1]!]!.push(i)
      }
    }
    const v = v3()
    const depth = (finger: string) => {
      scene.updateMatrixWorld(true)
      skin!.skeleton.update()
      let worst = -1
      for (const i of verts[finger]!) {
        skin!.getVertexPosition(i, v)
        v.applyMatrix4(skin!.matrixWorld)
        const rel = v.sub(centre)
        const r = rel.addScaledVector(across, -rel.dot(across)).length()
        worst = Math.max(worst, TORCH_BARREL_R + 0.0015 - r)
      }
      return worst
    }
    const pose = this.gripPose
    for (const f of fingers) {
      if (!skin || !verts[f]!.length) continue
      let lo = 0.2
      let hi = 1.5
      for (let it = 0; it < 12; it++) {
        const k = (lo + hi) / 2
        scaleFinger(pose, f, k)
        this.handR!.apply(pose)
        if (depth(f) > 0) hi = k
        else lo = k
      }
      scaleFinger(pose, f, lo)
    }
    this.handR!.apply(pose)
    scene.updateMatrixWorld(true)
    const inv = hand.getWorldQuaternion(new THREE.Quaternion()).invert()
    const hp = hand.getWorldPosition(v3())
    this.handAxis.copy(across).applyQuaternion(inv).normalize()
    this.handBack.copy(along).applyQuaternion(inv)
    this.handBack.addScaledVector(this.handAxis, -this.handBack.dot(this.handAxis)).normalize()
    const sc = hand.getWorldScale(v3()).x
    this.torch.position.copy(centre.clone().sub(hp).applyQuaternion(inv)).divideScalar(sc)
    this.torch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.handAxis)
    this.torch.scale.setScalar(1 / sc)
  }

  /** Names of the clips in the model. */
  clipNames() {
    return [...this.actions.keys()]
  }

  /**
   * Inspection: the raw clip `name` at `phase` (0..1 of its duration), no blending, IK or overlays, the root at
   * (x, y, z) facing `yaw`. Returns the clip time.
   */
  inspect(name: string, phase: number, x = 0, y = 0, z = 0, yaw = 0) {
    const a = this.actions.get(name)
    if (!this.mixer || !this.model) return 0
    for (const o of this.actions.values()) o.enabled = false
    if (!a) {
      // "rest": the bind pose.
      for (const [o, t] of this.restTRS) {
        o.position.copy(t.p)
        o.quaternion.copy(t.q)
      }
      this.root.position.set(x, y, z)
      this.root.rotation.set(0, yaw, 0)
      this.root.updateMatrixWorld(true)
      return 0
    }
    a.enabled = true
    a.setEffectiveWeight(1)
    a.setEffectiveTimeScale(0)
    a.time = phase * a.getClip().duration
    this.mixer.update(0)
    if (this.on("body.handPoses")) {
      this.handL?.apply(this.relaxed())
      this.handR?.apply(name === "torch" ? this.gripPose : this.relaxed())
    }
    this.root.position.set(x, y, z)
    this.root.rotation.set(0, yaw, 0)
    this.root.visible = true
    this.torch.visible = name === "torch"
    this.root.updateMatrixWorld(true)
    return a.time
  }

  /** Bone by name (inspection cameras). */
  bone(name: string) {
    return this.model?.getObjectByName(name) ?? null
  }

  /**
   * Contact hull per leg: ~40 boot vertices and ~24 lower-trouser (shin) vertices, spread evenly (farthest-point
   * sampling), each stored in its dominant bone's space with how much of an ankle lift reaches it (1 for the boot,
   * the fraction down the shin for the trousers). The foot IK lifts the ankle until every one of them is on or above
   * the walkable surface under it: no toe cap through a riser, no heel through a tread edge, no shin through a step.
   */
  private soles: [{ bone: THREE.Bone; p: THREE.Vector3; k: number }[], { bone: THREE.Bone; p: THREE.Vector3; k: number }[]] = [[], []]
  private measureContacts(mesh: THREE.SkinnedMesh, kind: "boot" | "shin") {
    const geo = mesh.geometry
    const pos = geo.getAttribute("position")
    const ji = geo.getAttribute("skinIndex")
    const jw = geo.getAttribute("skinWeight")
    const sk = mesh.skeleton
    const used = new Uint8Array(pos.count)
    if (geo.index) for (let i = 0; i < geo.index.count; i++) used[geo.index.getX(i)] = 1
    else used.fill(1)
    for (let side = 0; side < 2; side++) {
      const sfx = side === 0 ? "l" : "r"
      // Any vertex of the boot or the trouser leg below the knee, by its dominant bone (hems and boot collars are
      // shared between the shin and the foot).
      const want = [`calf_${sfx}`, `foot_${sfx}`, `ball_${sfx}`, `thigh_${sfx}`]
      const thighI = sk.bones.indexOf(this.bones[`thigh_${sfx}` as BoneName])
      const hip = new THREE.Vector3().setFromMatrixPosition(sk.boneInverses[thighI]!.clone().invert())
      const idx = want.map((n) => sk.bones.indexOf(this.bones[n as BoneName]))
      const knee = new THREE.Vector3().setFromMatrixPosition(sk.boneInverses[sk.bones.indexOf(this.bones[`calf_${sfx}` as BoneName])]!.clone().invert())
      const ankle = new THREE.Vector3().setFromMatrixPosition(sk.boneInverses[sk.bones.indexOf(this.bones[`foot_${sfx}` as BoneName])]!.clone().invert())
      const cand: { v: THREE.Vector3; bone: number }[] = []
      const v = new THREE.Vector3()
      for (let i = 0; i < pos.count; i++) {
        if (!used[i]) continue
        let best = -1
        let bw = 0
        for (let c = 0; c < 4; c++) {
          const w = jw.getComponent(i, c)
          if (w > bw) {
            bw = w
            best = ji.getComponent(i, c)
          }
        }
        if (!idx.includes(best)) continue
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix)
        // Thigh: only round the knee (the lower third).
        if (best === thighI && v.y > knee.y + (hip.y - knee.y) * 0.33) continue
        cand.push({ v: v.clone(), bone: best })
      }
      const n = kind === "boot" ? 64 : 32
      const pick: typeof cand = []
      if (cand.length) {
        pick.push(cand.reduce((a, c) => (c.v.y < a.v.y ? c : a)))
        const dist = cand.map((c) => c.v.distanceToSquared(pick[0]!.v))
        while (pick.length < Math.min(n, cand.length)) {
          let bi = 0
          for (let i = 1; i < cand.length; i++) if (dist[i]! > dist[bi]!) bi = i
          pick.push(cand[bi]!)
          for (let i = 0; i < cand.length; i++) dist[i] = Math.min(dist[i]!, cand[i]!.v.distanceToSquared(cand[bi]!.v))
        }
      }
      for (const c of pick) {
        const onFoot = sk.bones[c.bone] === this.bones[`foot_${sfx}` as BoneName] || sk.bones[c.bone] === this.bones[`ball_${sfx}` as BoneName]
        // How far an ankle lift carries the point: all of it on the foot, less up the shin; round the knee about half
        // (the knee rises as the leg folds).
        const k = onFoot ? 1 : c.bone === thighI ? 0.4 : THREE.MathUtils.clamp(1 - (c.v.y - ankle.y) / Math.max(0.05, knee.y - ankle.y), 0.4, 1)
        this.soles[side]!.push({ bone: sk.bones[c.bone]!, p: c.v.clone().applyMatrix4(sk.boneInverses[c.bone]!), k })
      }
    }
  }

  /** Loop speeds and phases measured from the clips (for the Lab readout). */
  clipInfo() {
    // Eye height ≈ the neck joint + the bind pose's eye-above-neck (mean over the cycle).
    return Object.fromEntries(LOOPS.map((l) => [l, { speed: +this.loops[l]?.speed.toFixed(2), cycle: +this.loops[l]?.dur.toFixed(2), stride: +(this.loops[l]?.speed * this.loops[l]?.dur).toFixed(2), eye: +(this.loops[l]!.neck + this.eyeAboveNeck).toFixed(2) }]))
  }

  update(dt: number, s: BodyInput) {
    const mixer = this.mixer
    if (!mixer || !this.model) return
    this.root.visible = !s.fly
    if (s.fly) {
      this.hasPrev = false
      this.bodyYaw = Number.NaN
      return
    }
    dt = Math.min(dt, 0.1)

    // ------------------------------------------------------------------ root: where the controller is
    const aimYaw = s.yaw
    if (!Number.isFinite(this.bodyYaw) || Math.hypot(s.pos.x - this.root.position.x, s.pos.z - this.root.position.z) > 3 || Math.abs(s.pos.y - this.lastY) > 2) {
      this.bodyYaw = aimYaw
      this.hasPrev = false
      this.lv.set(0, 0)
      this.footOff = [0, 0]
      this.pelvisOff = 0
    }
    this.lastY = s.pos.y
    const speed = Math.hypot(s.vel.x, s.vel.z)
    const moving = speed > this.num("body.moveFrom") && s.grounded
    let dYaw = wrap(aimYaw - this.bodyYaw)
    if (moving || s.onLadder || !s.grounded) {
      this.turning = false
      this.bodyYaw += dYaw * damp(this.num("body.yawHz"), dt)
    } else {
      if (Math.abs(dYaw) > (this.num("body.turnStart") * Math.PI) / 180) this.turning = true
      if (this.turning) {
        const step = ((this.num("body.turnSpeed") * Math.PI) / 180) * dt
        this.bodyYaw += Math.sign(dYaw) * Math.min(Math.abs(dYaw), step)
        if (Math.abs(dYaw) < 0.06) this.turning = false
      }
    }
    this.bodyYaw = wrap(this.bodyYaw)
    dYaw = wrap(aimYaw - this.bodyYaw)
    const fwd = new THREE.Vector3(-Math.sin(this.bodyYaw), 0, -Math.cos(this.bodyYaw))
    const right = new THREE.Vector3(Math.cos(this.bodyYaw), 0, -Math.sin(this.bodyYaw))
    // Eyes sit just behind the camera: the root goes back along the aim (more when looking down, where the real head
    // comes forward over the feet).
    const aimF = new THREE.Vector3(-Math.sin(aimYaw), 0, -Math.cos(aimYaw))
    const back = (this.num("body.back") + Math.max(0, -Math.sin(s.pitch)) * this.num("body.lookBack")) * (1 - this.ladder)
    this.root.position.set(s.pos.x - aimF.x * back, s.pos.y, s.pos.z - aimF.z * back)
    this.root.rotation.set(0, this.bodyYaw, 0)
    this.root.updateMatrixWorld(true)

    // ------------------------------------------------------------------ blend space
    // Everything in character space. The controller moves the root; the clips play as authored, at real time (a
    // playback rate of speed ÷ the clip's authored ground speed), and cross-fade by weight:
    //   gait (by speed between the clips' own authored speeds): idle · walk · jog · run   (crouched: crouch idle/walk)
    //   direction (by travel angle in the body's frame, fixed 4-way blend): forward · back · left · right
    // Within one gait the direction loops (all cut from left-foot contact) share normalized time: their playback rates
    // are set so they cycle together, and a gait joining the mix starts at the normalized time of the gait it fades in
    // over. Nothing is scrubbed, nothing is dragged in world space.
    const vf = s.vel.x * fwd.x + s.vel.z * fwd.z
    const vr = s.vel.x * right.x + s.vel.z * right.z
    const kv = damp(this.num("body.velHz"), dt)
    this.lv.x += (vr - this.lv.x) * kv
    this.lv.y += (vf - this.lv.y) * kv
    let sp = this.lv.length()
    let dirA = sp > 0.05 ? Math.atan2(this.lv.x, this.lv.y) : 0
    // Turning in place: slow steps on the spot (the walk at a low rate) while the root comes round.
    const shuffle = this.turning && sp < 0.4
    if (shuffle) {
      sp = 0.4
      dirA = 0
    }
    const cF = Math.max(0, Math.cos(dirA))
    const cB = Math.max(0, -Math.cos(dirA))
    const cR = Math.max(0, Math.sin(dirA))
    const cL = Math.max(0, -Math.sin(dirA))
    const cs = cF + cB + cR + cL || 1
    const dirW = { f: cF / cs, b: cB / cs, l: cL / cs, r: cR / cs }
    // Authored ground speed of each gait in this direction.
    const G = this.gaits
    const dirSpeed = (g: Gait) => g.clips.reduce((a, c) => a + dirW[c.dir] * this.loops[c.loop].speed, 0)
    const vWalk = dirSpeed(G.walk)
    const vJog = dirSpeed(G.jog)
    const vRun = Math.max(vJog + 0.3, this.loops.run.speed * dirW.f + vJog * (1 - dirW.f))
    // Gait weights: piecewise-linear between neighbouring authored speeds (idle at 0).
    const moveFrom = this.num("body.moveFrom")
    const target = { idle: 0, walk: 0, jog: 0, run: 0, crouch_idle: 0, crouch_walk: 0 }
    const crouched = s.crouch > 0.5
    if (crouched) {
      const k = THREE.MathUtils.clamp((sp - moveFrom) / Math.max(0.05, this.loops.crouch_walk.speed - moveFrom), 0, 1)
      target.crouch_idle = 1 - k
      target.crouch_walk = k
    } else {
      // One gait at a time wherever it can cover the speed by playback rate alone; the next gait takes over in a short
      // band around the switch speed (gaits of different cadence are only ever mixed while speeding up or slowing).
      const band = this.num("body.gaitBand")
      const hold = this.num("body.gaitHold")
      const walkTop = Math.min(vWalk * hold, vJog) + band
      const jogTop = Math.min(vJog * hold, vRun) + band
      const idleK = THREE.MathUtils.clamp((sp - moveFrom) / Math.max(0.05, Math.min(vWalk, 0.5) - moveFrom), 0, 1)
      const jogK = smooth01(walkTop - 2 * band, walkTop, sp)
      const runK = smooth01(jogTop - 2 * band, jogTop, sp) * dirW.f
      target.idle = 1 - idleK
      target.walk = idleK * (1 - jogK)
      target.jog = idleK * jogK * (1 - runK)
      target.run = idleK * jogK * runK
    }
    // Cross-fade: every gait weight eases to its target over "State cross-fade".
    const fadeK = damp(3 / Math.max(0.02, this.num("body.fade")), dt)
    for (const k of Object.keys(target) as (keyof typeof target)[]) {
      const was = this.gaitW[k]
      this.gaitW[k] += (target[k] - this.gaitW[k]) * fadeK
      // A gait fading in starts at the normalized time of the strongest moving gait (feet carry on in step).
      if (was < 1e-3 && this.gaitW[k] >= 1e-3) this.syncIn(k)
    }
    const gw = this.gaitW
    const wsum = Object.values(gw).reduce((a, v) => a + v, 0) || 1
    // Playback rates: each moving gait at (speed ÷ its authored speed in this direction), within sane bounds; the
    // direction loops of one gait cycle together (same normalized rate).
    const rateOf = (g: Gait, authored: number) => {
      const scale = THREE.MathUtils.clamp(sp / Math.max(0.05, authored), this.num("body.rateMin"), this.num("body.rateMax"))
      const cycle = g.clips.reduce((a, c) => a + dirW[c.dir] * this.loops[c.loop].dur, 0)
      return scale / Math.max(0.05, cycle) // normalized cycles per second
    }
    const setGait = (g: Gait, weight: number, authored: number, sign = 1) => {
      const r = rateOf(g, authored) * sign
      for (const c of g.clips) {
        const a = this.loops[c.loop].action
        a.enabled = true
        a.setEffectiveTimeScale(r * this.loops[c.loop].dur)
        const w = weight * (g.clips.length > 1 ? dirW[c.dir] : 1)
        a.setEffectiveWeight(w)
        this.debug.weights[c.loop] = w
      }
    }
    const ground = 1 - this.air
    setGait(G.walk, (gw.walk / wsum) * ground, shuffle ? 0.6 : vWalk)
    setGait(G.jog, (gw.jog / wsum) * ground, vJog)
    setGait(G.run, (gw.run / wsum) * ground, this.loops.run.speed)
    // Crouch: forward clip; a backward crouch-walk plays it in reverse.
    setGait(G.crouch, (gw.crouch_walk / wsum) * ground, this.loops.crouch_walk.speed, this.lv.y < -0.05 ? -1 : 1)
    for (const [k, loop] of [["idle", "idle"], ["crouch_idle", "crouch_idle"]] as const) {
      const a = this.loops[loop].action
      a.enabled = true
      a.setEffectiveTimeScale(1)
      a.setEffectiveWeight((gw[k] / wsum) * ground)
      this.debug.weights[loop] = a.getEffectiveWeight()
    }
    // Gait phase (debug, captures): normalized time of the strongest moving gait.
    const lead = ([["walk", "walk"], ["jog", "jog"], ["run", "run"], ["crouch_walk", "crouch_walk"]] as const).reduce((a, c) => (gw[c[0]] > gw[a[0]] ? c : a))
    this.phase = this.loops[lead[1]].action.time / this.loops[lead[1]].dur
    this.crouchW = (gw.crouch_idle + gw.crouch_walk) / wsum
    const cw = this.crouchW

    // ------------------------------------------------------------------ air, ladder
    if (!s.grounded && !s.onLadder) {
      if (this.airT === 0 && s.vel.y > 1) this.jumpT = 0
      this.airT += dt
    } else {
      if (this.airT > 0.25) this.landT = 0
      this.airT = 0
      this.jumpT = -1
    }
    const airborne = this.airT > (this.jumpT >= 0 ? 0 : 0.18)
    this.air += ((airborne ? 1 : 0) - this.air) * damp(1 / Math.max(0.02, this.num("body.fade")) * 2.2, dt)
    this.ladder += ((s.onLadder ? 1 : 0) - this.ladder) * damp(8, dt)
    if (s.onLadder) this.ladderPhase += (s.vel.y * dt) / (2 * this.num("body.ladderRung"))

    // ------------------------------------------------------------------ one-shot states
    const js = this.actions.get("jump_start")
    const ja = this.actions.get("jump_air")
    const jl = this.actions.get("jump_land")
    if (js && ja && jl) {
      if (this.jumpT >= 0) {
        if (this.jumpT === 0) js.time = this.num("body.jumpStartAt")
        this.jumpT += dt
      }
      const startK = this.jumpT >= 0 ? 1 - smooth01(0.25, 0.5, this.jumpT) : 0
      js.enabled = this.air * startK > 1e-3
      js.setEffectiveWeight(this.air * startK)
      js.setEffectiveTimeScale(1)
      ja.enabled = this.air * (1 - startK) > 1e-3
      ja.setEffectiveWeight(this.air * (1 - startK))
      ja.setEffectiveTimeScale(1)
      if (this.landT >= 0) {
        if (this.landT === 0) jl.time = 0.15
        this.landT += dt
        if (this.landT > 0.6) this.landT = -1
      }
      const lw = this.landT >= 0 ? Math.sin(Math.PI * Math.min(1, this.landT / 0.6)) * 0.7 * (1 - this.air) : 0
      jl.enabled = lw > 1e-3
      jl.setEffectiveWeight(lw)
      jl.setEffectiveTimeScale(1)
      this.debug.weights.jump_start = js.getEffectiveWeight()
      this.debug.weights.jump_air = ja.getEffectiveWeight()
      this.debug.weights.jump_land = lw
    }
    const holdTorch = s.flashlight && this.on("body.torch")
    this.torchW += ((holdTorch ? 1 : 0) - this.torchW) * damp(10, dt)
    this.debug.phase = this.phase
    this.debug.state = s.onLadder ? "ladder" : airborne ? (this.jumpT >= 0 ? "jump" : "fall") : this.turning ? "turn" : moving ? (cw > 0.3 ? "crouch-walk" : "move") : cw > 0.3 ? "crouch" : "idle"
    mixer.update(dt)
    // Fingers: authored poses (the clips' finger keys don't fit this hand); the torch hand closes round the barrel.
    if (this.on("body.handPoses")) {
      // Running: hands close to a loose fist.
      const relaxed = this.relaxed()
      const runK = Math.min(1, (this.gaitW.jog + this.gaitW.run) / Math.max(1e-3, Object.values(this.gaitW).reduce((a, v) => a + v, 0)))
      this.handL?.apply(relaxed, LOOSE_FIST, runK)
      if (this.torchW > 0.5) this.handR?.apply(relaxed, this.gripPose, this.torchW)
      else this.handR?.apply(relaxed, LOOSE_FIST, runK)
    }
    this.model.updateMatrixWorld(true)

    // ------------------------------------------------------------------ post: spine, pelvis, feet, arms
    const b = this.bones
    // Spine twist toward the aim (the root lags while turning in place) and bend with the view pitch.
    const yawK = this.num("body.spineYaw")
    const pitchK = this.num("body.spinePitch")
    const aimRight = new THREE.Vector3(Math.cos(aimYaw), 0, -Math.sin(aimYaw))
    const spine: [THREE.Bone, number, number][] = [
      [b.spine_01, 0.3, 0.25],
      [b.spine_02, 0.35, 0.3],
      [b.spine_03, 0.35, 0.3],
    ]
    const pitch = THREE.MathUtils.clamp(s.pitch, -1.2, 1) * (1 - this.ladder)
    // Aim offset (as shipped full-body FPS rigs layer on the clips): looking down, the chest leans back a little so you
    // see your legs past it.
    const downLean = Math.max(0, -pitch) * this.num("body.downLean")
    for (const [bone, wy, wp] of spine) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, dYaw * yawK * wy)
      q.multiply(new THREE.Quaternion().setFromAxisAngle(aimRight, (pitch * pitchK + downLean) * wp))
      rotateWorld(bone, q)
      refreshTree(bone)
    }
    // The arms hang from the shoulders under gravity: undo the trunk's lean/bend on the upper arms so leaning the chest
    // back (looking down) or forward (crouching) doesn't swing them out in front.
    const lean = (pitch * pitchK + downLean) * spine.reduce((a, [, , wp]) => a + wp, 0)
    if (Math.abs(lean) > 1e-4) {
      const undo = new THREE.Quaternion().setFromAxisAngle(aimRight, -lean)
      for (const ua of [b.upperarm_l, b.upperarm_r]) {
        rotateWorld(ua, undo)
        refreshTree(ua)
      }
    }
    // Head and neck take the rest of the view (for shadows and debug views; hidden in first person).
    const headQ = new THREE.Quaternion().setFromAxisAngle(UP, dYaw * (1 - yawK))
    headQ.multiply(new THREE.Quaternion().setFromAxisAngle(aimRight, pitch * (1 - pitchK)))
    rotateWorld(b.neck_01, headQ)
    refreshTree(b.neck_01)

    // Pelvis: low enough for each foot to reach its floor, and for the eyes to stay under the camera.
    const rootY = s.pos.y
    // Foot contact runs in the air too (it only ever lifts a boot out of a surface); the hips follow only on the ground.
    const ikOn = this.on("body.footIK") && !s.onLadder
    const grounded = s.grounded
    const ikMax = this.num("body.ikMax")
    const kIK = damp(this.num("body.ikHz"), dt)
    const feet = [b.foot_l, b.foot_r] as const
    const footW = [v3(), v3()]
    const normals = [UP.clone(), UP.clone()]
    const legFwd = fwd
    const contactW = [1, 1]
    for (let i = 0; i < 2; i++) {
      // The animated ankle, unchanged horizontally: IK only ever moves a foot up or down.
      worldPos(feet[i], footW[i]!)
      // How much this foot is in contact in the clip (on its floor → 1, swinging high → 0).
      const animH = footW[i]!.y - rootY - this.restFootH[i]!
      contactW[i] = 1 - smooth01(0.03, 0.2, animH)
      let want = 0
      if (ikOn) {
        const g = this.ground(footW[i]!.x, footW[i]!.z, rootY + ikMax)
        // A foot on its floor follows the floor's height; a swinging foot only clears what's under it (adding the
        // floor height to a high heel-kick put boots at hip height running up stairs).
        want = THREE.MathUtils.clamp(g - rootY, -ikMax, ikMax) * contactW[i]!
        normals[i] = this.normalAt(footW[i]!.x, footW[i]!.z, g, rootY + ikMax)
        // Every sole point (heel, mid-sole, ball tread, toe tip) on or above the surface under it: a toe over the next
        // riser lifts the boot onto the step's nosing instead of going into it. Also catches the clip's sole dipping
        // under a flat floor. The surface is searched up to the height the leg could lift to.
        const ankle0 = worldPos(feet[i], v3())
        const shift = footW[i]!.clone().sub(ankle0)
        const n = normals[i]!
        const tilt = n.y < 0.9999 ? new THREE.Quaternion().setFromUnitVectors(UP, n).slerp(new THREE.Quaternion(), 1 - this.num("body.slopeAlign")) : null
        for (const sp of this.soles[i]!) {
          const p = sp.p.clone().applyMatrix4(sp.bone.matrixWorld)
          if (tilt) p.sub(ankle0).applyQuaternion(tilt).add(ankle0)
          p.add(shift)
          // Surface under the point, dilated 1.5 cm along the boot so a vertex can't slip past a riser edge between
          // samples.
          let gp = this.ground(p.x, p.z, rootY + ikMax)
          gp = Math.max(gp, this.ground(p.x + legFwd.x * 0.025, p.z + legFwd.z * 0.025, rootY + ikMax), this.ground(p.x - legFwd.x * 0.025, p.z - legFwd.z * 0.025, rootY + ikMax))
          const need = (gp + 0.006 - p.y) / sp.k
          if (sp.k === 1) want = Math.max(want, (gp - rootY) * contactW[i]!)
          want = Math.max(want, need)
        }
        want = Math.min(want, ikMax)
      }
      // Up immediately (a lag here is a boot through a tread), down smoothly.
      if (want > this.footOff[i]!) this.footOff[i] = want
      else this.footOff[i]! += (want - this.footOff[i]!) * kIK
    }
    // Hips: down only as far as a leg needs to reach its foot's floor (plus a little weight onto the lower foot).
    let pelvisWant = 0
    if (ikOn && grounded) {
      const reach = this.legLen * 0.97
      for (let i = 0; i < 2; i++) {
        const hip = worldPos(i === 0 ? b.thigh_l : b.thigh_r, v3())
        const t = footW[i]!
        const ty = t.y + this.footOff[i]!
        const horiz = Math.hypot(t.x - hip.x, t.z - hip.z)
        const maxV = Math.sqrt(Math.max(0, reach * reach - horiz * horiz))
        pelvisWant = Math.min(pelvisWant, -Math.max(0, hip.y - ty - maxV))
      }
      // The hips ride at the height of the feet that carry weight (between two treads on stairs).
      const cw0 = contactW[0]! + 1e-3
      const cw1 = contactW[1]! + 1e-3
      const base = (this.footOff[0]! * cw0 + this.footOff[1]! * cw1) / (cw0 + cw1)
      pelvisWant += Math.min(0.15, base) * this.num("body.pelvisFollow")
      pelvisWant = Math.max(pelvisWant, -this.num("body.ikMax"))
    }
    this.pelvisOff += (pelvisWant - this.pelvisOff) * kIK
    if (Math.abs(this.pelvisOff) > 1e-4) {
      const wp = worldPos(b.pelvis, v3())
      wp.y += this.pelvisOff
      b.pelvis.position.copy(b.pelvis.parent!.worldToLocal(wp))
      refreshTree(b.pelvis)
    }
    // Legs: each ankle back to its animated height above its own floor.
    const wIK = this.num("body.footIKWeight")
    const align = this.num("body.slopeAlign")
    for (let i = 0; i < 2; i++) {
      const sfx = i === 0 ? "l" : "r"
      const thigh = b[`thigh_${sfx}`]
      const calf = b[`calf_${sfx}`]
      const foot = feet[i]
      const target = footW[i]!.clone()
      target.y += this.footOff[i]!
      const footQ = worldQuat(foot, new THREE.Quaternion())
      if (target.distanceToSquared(worldPos(foot, v3())) > 1e-6) twoBoneIK(thigh, calf, foot, target, ikOn ? wIK : 1, legFwd, false)
      // Boots flat on the slope while they're down.
      const h = footW[i]!.y - rootY - this.restFootH[i]!
      const contact = 1 - smooth01(0.02, 0.1, h)
      const n = normals[i]!
      if (contact > 0 && n.y < 0.9999 && align > 0) {
        const tilt = new THREE.Quaternion().setFromUnitVectors(UP, n)
        tilt.slerp(new THREE.Quaternion(), 1 - contact * align)
        setWorldQuat(foot, footQ.premultiply(tilt))
      } else setWorldQuat(foot, footQ)
      refreshTree(foot)
    }

    // Ladder: hands and feet on rungs, alternating with the climb.
    if (this.ladder > 0.01) this.ladderPose(fwd, right, s.pos.y)

    // Arms: torch in the right hand, E reach with a free hand.
    this.arms(s, dt, fwd)

    // ------------------------------------------------------------------ debug: foot slide while planted
    // The planted foot is the lower one, when it's on the floor; its horizontal world speed is the slide.
    const balls = [worldPos(b.ball_l, v3()), worldPos(b.ball_r, v3())]
    const hs = balls.map((p) => p.y - this.ground(p.x, p.z, rootY + 0.5))
    const low = hs[0]! <= hs[1]! ? 0 : 1
    for (let i = 0; i < 2; i++) {
      const p = balls[i]!
      // In contact: the lower foot, its ball joint within 4.5 cm of the floor (the joint sits ~2.5 cm up inside the boot)
      // and not still coming down (or lifting) faster than 0.15 m/s.
      const vy = this.hasPrev && dt > 0 ? (p.y - this.prevFoot[i]!.y) / dt : 0
      const planted = s.grounded && !s.onLadder && i === low && hs[i]! < 0.045 && Math.abs(vy) < 0.15
      if (this.hasPrev && dt > 0 && planted && this.debug.planted[i]) {
        const vx = (p.x - this.prevFoot[i]!.x) / dt + this.debug.belt.x
        const vz = (p.z - this.prevFoot[i]!.z) / dt + this.debug.belt.z
        this.debug.slide[i] = this.debug.slide[i]! + (Math.hypot(vx, vz) - this.debug.slide[i]!) * damp(6, dt)
      }
      this.debug.planted[i] = planted
      this.prevFoot[i]!.copy(p)
    }
    this.hasPrev = true
  }

  private normalAt(x: number, z: number, g: number, maxY: number) {
    const e = 0.12
    const hx1 = this.ground(x + e, z, maxY)
    const hx0 = this.ground(x - e, z, maxY)
    const hz1 = this.ground(x, z + e, maxY)
    const hz0 = this.ground(x, z - e, maxY)
    // Steps and kerbs are edges, not slopes.
    if (Math.max(hx1, hx0, hz1, hz0, g) - Math.min(hx1, hx0, hz1, hz0, g) > 0.08) return UP.clone()
    const n = new THREE.Vector3(-(hx1 - hx0) / (2 * e), 1, -(hz1 - hz0) / (2 * e)).normalize()
    return n.y < Math.cos(0.45) ? UP.clone() : n
  }

  private arms(s: BodyInput, dt: number, fwd: THREE.Vector3) {
    const b = this.bones
    const eye = new THREE.Vector3(s.eye.x, s.eye.y, s.eye.z)
    const camQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(s.pitch, s.yaw, 0, "YXZ"))
    const aim = new THREE.Vector3(0, 0, -1).applyQuaternion(camQ)
    const yawRight = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw))
    const yawFwd = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw))
    this.torch.visible = this.torchW > 0.5
    if (this.torchW > 1e-3 && this.ladder < 0.5) this.carryTorch(s, aim)
    // E: the free hand (left while holding the torch) out to handle height and back.
    if (this.reachT >= 0) {
      const T = this.num("body.reachTime")
      this.reachT += dt
      if (this.reachT > T) this.reachT = -1
    }
    if (this.reachT >= 0) {
      const k = Math.sin((Math.PI * this.reachT) / this.num("body.reachTime")) ** 2
      const left = this.torchW > 0.5
      const side = left ? -1 : 1
      const target = new THREE.Vector3(s.pos.x, s.pos.y + 1.02, s.pos.z).addScaledVector(yawFwd, 0.55).addScaledVector(yawRight, side * 0.14)
      const pole = yawRight.clone().multiplyScalar(side).add(new THREE.Vector3(0, -1, 0))
      if (left) twoBoneIK(b.upperarm_l, b.lowerarm_l, b.hand_l, target, k, pole)
      else twoBoneIK(b.upperarm_r, b.lowerarm_r, b.hand_r, target, k, pole)
      refreshTree(left ? b.hand_l : b.hand_r)
    }
    void fwd
  }

  /**
   * Flashlight carry, posed in character space (FK from the shoulder, the chest's frame), not solved toward a point
   * near the camera: upper arm hanging a little forward and out, elbow bent ~85°, forearm forward and across the body,
   * fist in front of the belly, barrel through the fist pointing along the aim. The aim adjusts it within limits:
   * pitch flexes the elbow/shoulder (the fist rises to look up, drops a little to look down), yaw beyond the chest's
   * twist turns the forearm up to ±`torchYaw`. Any torch, fist or forearm point that comes within the torso or a
   * thigh capsule is pushed out before the arm is set.
   */
  private carryTorch(s: BodyInput, aim: THREE.Vector3) {
    const b = this.bones
    const deg = Math.PI / 180
    const w = this.torchW
    // The chest's yaw: the body's yaw plus the twist the spine already took toward the aim.
    const chestYaw = this.bodyYaw + wrap(s.yaw - this.bodyYaw) * this.num("body.spineYaw")
    const F = new THREE.Vector3(-Math.sin(chestYaw), 0, -Math.cos(chestYaw))
    const R = new THREE.Vector3(Math.cos(chestYaw), 0, -Math.sin(chestYaw))
    const D = new THREE.Vector3(0, -1, 0)
    // Aim relative to the chest, clamped.
    const relYaw = THREE.MathUtils.clamp(wrap(s.yaw - chestYaw), -this.num("body.torchYaw") * deg, this.num("body.torchYaw") * deg)
    const pitch = THREE.MathUtils.clamp(s.pitch, -50 * deg, 40 * deg)
    // Upper arm: from straight down, swung forward (more as the aim rises) and a little out.
    const sh = worldPos(b.upperarm_r, v3())
    const l1 = sh.distanceTo(worldPos(b.lowerarm_r, v3()))
    const l2 = worldPos(b.lowerarm_r, v3()).distanceTo(worldPos(b.hand_r, v3()))
    // A slight swing with the walk (the carrying arm still moves with the gait, damped).
    const moveK = THREE.MathUtils.clamp(this.lv.length() / 1.2, 0, 1)
    const swing = Math.sin(this.phase * Math.PI * 2) * this.num("body.carrySwing") * moveK
    const fwdA = (this.num("body.carryShoulder") + swing + Math.max(0, pitch) * 0.6 * (180 / Math.PI)) * deg
    const outA = 10 * deg
    const d1 = D.clone().multiplyScalar(Math.cos(fwdA)).addScaledVector(F, Math.sin(fwdA)).addScaledVector(R, Math.sin(outA)).normalize()
    // Forearm: forward and across the body (the fist ends in front of the belly), raised by the elbow bend.
    const across = this.num("body.carryAcross") * deg
    // Looking down the wrist does most of the work (the elbow opens only a little); looking up the forearm lifts.
    const raise = (this.num("body.carryRaise") + pitch * (180 / Math.PI) * (pitch > 0 ? 0.7 : 0.3)) * deg
    const flat = F.clone().multiplyScalar(Math.cos(across)).addScaledVector(R, -Math.sin(across)).applyAxisAngle(UP, relYaw * 0.6)
    const d2 = flat.clone().multiplyScalar(Math.cos(raise)).add(new THREE.Vector3(0, Math.sin(raise), 0)).normalize()
    const elbow = sh.clone().addScaledVector(d1, l1)
    let hand = elbow.clone().addScaledVector(d2, l2)
    // Barrel: the aim, limited to the chest's ±torchYaw and the pitch range.
    const barrel = F.clone().applyAxisAngle(UP, relYaw).multiplyScalar(Math.cos(pitch)).add(new THREE.Vector3(0, Math.sin(pitch), 0)).normalize()
    // Clearance: push the fist out of the torso/thigh capsules (the torch hangs off it).
    const push = this.clearance(hand, barrel, elbow)
    if (push.lengthSq() > 0) hand = hand.add(push)
    // Pose: two-bone with the elbow bending toward its FK side (so it never folds behind the back), then the fist.
    const pole = elbow.clone().sub(sh.clone().lerp(hand, 0.5)).normalize()
    twoBoneIK(b.upperarm_r, b.lowerarm_r, b.hand_r, hand, w, pole)
    const fore = worldPos(b.hand_r, v3()).sub(worldPos(b.lowerarm_r, v3())).normalize()
    const backDir = fore.clone().addScaledVector(barrel, -fore.dot(barrel))
    if (backDir.lengthSq() < 1e-4) backDir.copy(R).negate()
    const q = aimQuat(this.handAxis, this.handBack, barrel, backDir.normalize(), new THREE.Quaternion())
    setWorldQuat(b.hand_r, worldQuat(b.hand_r, new THREE.Quaternion()).slerp(q, w))
    if (!this.on("body.handPoses")) for (const g of this.grip) g.bone.quaternion.slerp(g.q, w)
    refreshTree(b.hand_r)
    void aim
  }

  /** Torso capsule (pelvis → neck) and thigh capsules (hip → knee), world, current pose. */
  capsules() {
    const b = this.bones
    const P = (o: THREE.Object3D) => worldPos(o, v3())
    return [
      { a: P(b.pelvis).addScaledVector(UP, 0.05), b: P(b.neck_01).addScaledVector(UP, -0.08), r: this.num("body.torsoRadius") },
      { a: P(b.thigh_l), b: P(b.calf_l), r: 0.085 },
      { a: P(b.thigh_r), b: P(b.calf_r), r: 0.085 },
    ]
  }

  /** Points along the torch (lens, middle, tail) and forearm, for a fist at `hand` holding the barrel along `barrel`. */
  private torchPoints(hand: THREE.Vector3, barrel: THREE.Vector3, elbow: THREE.Vector3) {
    return [hand.clone().addScaledVector(barrel, 0.15), hand.clone().addScaledVector(barrel, 0.06), hand.clone(), hand.clone().addScaledVector(barrel, -0.1), hand.clone().lerp(elbow, 0.4)]
  }

  /** The smallest shift of the fist that keeps every torch/forearm point `margin` outside every capsule. */
  private clearance(hand: THREE.Vector3, barrel: THREE.Vector3, elbow: THREE.Vector3) {
    const push = v3()
    const margin = 0.03
    for (let it = 0; it < 3; it++) {
      let worst = 0
      const dir = v3()
      for (const c of this.capsules()) {
        for (const p of this.torchPoints(hand.clone().add(push), barrel, elbow)) {
          const ab = c.b.clone().sub(c.a)
          const t = THREE.MathUtils.clamp(p.clone().sub(c.a).dot(ab) / ab.lengthSq(), 0, 1)
          const q = c.a.clone().addScaledVector(ab, t)
          const d = p.distanceTo(q)
          const pen = c.r + margin - d
          if (pen > worst) {
            worst = pen
            dir.copy(p).sub(q).setY(0)
            if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1)
            dir.normalize()
          }
        }
      }
      if (worst <= 0) break
      push.addScaledVector(dir, worst)
    }
    return push
  }

  /** Acceptance: the smallest distance (m, negative = inside) from the torch, fist and forearm to the torso/thighs. */
  torchClearance() {
    if (!this.torch.visible) return Infinity
    const lens = this.torch.userData.lens as THREE.Object3D
    const pts = [lens.getWorldPosition(v3()), this.torch.getWorldPosition(v3()), worldPos(this.bones.hand_r, v3())]
    const tail = this.torch.getWorldPosition(v3()).multiplyScalar(2).sub(pts[0]!.clone().lerp(this.torch.getWorldPosition(v3()), 0.4))
    pts.push(tail, worldPos(this.bones.hand_r, v3()).lerp(worldPos(this.bones.lowerarm_r, v3()), 0.5))
    let min = Infinity
    for (const c of this.capsules()) {
      const ab = c.b.clone().sub(c.a)
      for (const p of pts) {
        const t = THREE.MathUtils.clamp(p.clone().sub(c.a).dot(ab) / ab.lengthSq(), 0, 1)
        min = Math.min(min, p.distanceTo(c.a.clone().addScaledVector(ab, t)) - c.r)
      }
    }
    return min
  }

  /**
   * Ladder: each limb holds a rung fixed in the world (rungs every `body.ladderRung` m) and, once the body has climbed
   * past it, moves up two rungs; hands and feet alternate (left hand with right foot). The ladder is taken to be
   * `ladderGap` m ahead of the feet (PlayerState doesn't carry the ladder's plane).
   */
  private ladderPose(fwd: THREE.Vector3, right: THREE.Vector3, feetY: number) {
    const b = this.bones
    const rung = this.num("body.ladderRung")
    const w = this.ladder
    const base = this.root.position
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1
      const sfx = i === 0 ? "l" : "r"
      // Hand i and the opposite foot share a cycle; the other pair is a rung out of step.
      const limb = (k: number, reachUp: number, gap: number, width: number, isHand: boolean) => {
        const s = (feetY + k * rung) / (2 * rung)
        const n = Math.floor(s)
        const u = s - n
        const hold = n * 2 * rung - k * rung
        const swing = THREE.MathUtils.smoothstep(u, 0.55, 1)
        const y = hold + swing * 2 * rung + reachUp
        const out = Math.sin(Math.PI * swing) * 0.07
        const p = base.clone().addScaledVector(fwd, gap - out).addScaledVector(right, side * width)
        p.y = y + (isHand ? 0 : out * 0.5)
        return p
      }
      const hand = limb(i, 1.5, this.num("body.ladderGap") + 0.12, 0.2, true)
      const foot = limb(1 - i, 0.12, this.num("body.ladderGap") - 0.1, 0.12, false)
      twoBoneIK(b[`upperarm_${sfx}`], b[`lowerarm_${sfx}`], b[`hand_${sfx}`], hand, w, new THREE.Vector3(0, -1, 0).addScaledVector(right, side).addScaledVector(fwd, -0.5))
      twoBoneIK(b[`thigh_${sfx}`], b[`calf_${sfx}`], b[`foot_${sfx}`], foot, w, fwd)
      refreshTree(b[`hand_${sfx}`])
      refreshTree(b[`foot_${sfx}`])
    }
  }
}

/**
 * Moves the head/neck triangles of a skinned mesh into their own mesh on
 * HEAD_LAYER, sharing the geometry buffers and the skeleton.
 */
function splitHead(mesh: THREE.SkinnedMesh, headBones: Set<THREE.Object3D>) {
  const geo = mesh.geometry
  const index = geo.index
  const joints = geo.getAttribute("skinIndex")
  const weights = geo.getAttribute("skinWeight")
  if (!index || !joints || !weights) return
  const headJoint = new Set<number>()
  mesh.skeleton.bones.forEach((b, i) => headBones.has(b) && headJoint.add(i))
  const isHead = new Uint8Array(joints.count)
  for (let i = 0; i < joints.count; i++) {
    let w = 0
    for (let k = 0; k < 4; k++) if (headJoint.has(joints.getComponent(i, k))) w += weights.getComponent(i, k)
    isHead[i] = w > 0.3 ? 1 : 0
  }
  const body: number[] = []
  const head: number[] = []
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2)
    ;(isHead[a]! + isHead[b]! + isHead[c]! >= 2 ? head : body).push(a, b, c)
  }
  if (!head.length) return
  const headGeo = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(geo.attributes)) headGeo.setAttribute(name, attr)
  headGeo.setIndex(head)
  geo.setIndex(body)
  const headMesh = new THREE.SkinnedMesh(headGeo, mesh.material)
  headMesh.name = `${mesh.name}-head`
  headMesh.bind(mesh.skeleton, mesh.bindMatrix)
  headMesh.frustumCulled = false
  headMesh.castShadow = true
  headMesh.layers.set(HEAD_LAYER)
  ;(mesh.parent as THREE.Object3D).add(headMesh)
}

export { refresh }
