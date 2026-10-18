import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"
import { aimQuat, refresh, refreshTree, rotateWorld, setWorldQuat, twoBoneIK, worldPos, worldQuat } from "./ik"
import { createTorch } from "./torch"
import { createHand, LOOSE_FIST, newPose, relaxedPose, TORCH_GRIP } from "./hands"

// The player's body as a self-contained character component (full-body awareness, the way shipped first-person games
// do it): one root at the controller's feet, moved there every frame and turned to its yaw; everything else is local
// to that root. The controller owns where the body is; the body only animates.
//
//   1. Locomotion from authored clips (public/models/player/janitor.glb, see CREDITS.md): an AnimationMixer driven by
//      a 2D blend space over the controller's local velocity (forward/back/left/right × idle/walk/jog/sprint, crouch
//      idle/walk), all loops phase-synced on the left footfall and played at the rate that matches their stride to the
//      ground speed (so feet don't skate). Jump start/air/land and a ladder climb are states cross-faded over it.
//   2. Light IK on top: pelvis drop + per-foot two-bone IK onto the real floor (stairs, slopes), clamped and smoothed;
//      the eyes kept just behind and below the camera (crouch, looking down).
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
  "body.eyeGap": 0.03,
  "body.yawHz": 10,
  "body.turnStart": 60,
  "body.turnSpeed": 260,
  "body.velHz": 9,
  "body.walkAt": 1.9,
  "body.jogAt": 4.4,
  "body.sprintAt": 9,
  "body.strideWarp": 0.5,
  "body.strideMax": 1.25,
  "body.sideStepMax": 1.0,
  "body.moveFrom": 0.12,
  "body.fade": 0.2,
  "body.crouchDepth": 0,
  "body.crouchLean": 60,
  "body.warpMax": 90,
  "body.counterMax": 55,
  "body.warpHz": 10,
  "body.backEnter": 112,
  "body.backExit": 95,
  "body.jumpStartAt": 0.42,
  "body.footIK": true,
  "body.footIKWeight": 1,
  "body.ikMax": 0.65,
  "body.ikHz": 18,
  "body.pelvisFollow": 0.5,
  "body.stairStride": 0.9,
  "body.slopeAlign": 0.8,
  "body.eyeMatch": true,
  "body.spinePitch": 0.12,
  "body.downLean": 0.25,
  "body.spineYaw": 0.85,
  "body.torch": true,
  "body.handPoses": true,
  "body.fingerCurl": 1,
  "body.thumbOppose": 80,
  "body.thumbAlong": -50,
  "body.thumbCurl": 35,
  "body.fingersTogether": 7,
  "body.torchRight": 0.15,
  "body.torchDown": 0.46,
  "body.torchFwd": 0.36,
  "body.torchAvoidBeam": false,
  "body.reachTime": 0.8,
  "body.ladderRung": 0.3,
  "body.ladderGap": 0.32,
} satisfies LabSettings

const G = "Body"
export const BODY_CONTROLS: LabControl[] = [
  { key: "body.back", label: "Neck behind the eye", group: G, subsection: "First person", unit: "m", min: 0, max: 0.35, step: 0.01 },
  { key: "body.lookBack", label: "Extra back when looking down", group: G, subsection: "First person", unit: "m", min: 0, max: 0.3, step: 0.01 },
  { key: "body.eyeMatch", label: "Lower the body to the eye (crouch)", group: G, subsection: "First person", type: "toggle" },
  { key: "body.eyeGap", label: "Eye clearance below the camera", group: G, subsection: "First person", unit: "m", min: 0, max: 0.2, step: 0.005 },
  { key: "body.yawHz", label: "Body yaw follow", group: G, subsection: "Facing", unit: "Hz", min: 1, max: 30, step: 0.5 },
  { key: "body.turnStart", label: "Turn in place beyond", group: G, subsection: "Facing", unit: "°", min: 10, max: 120, step: 1 },
  { key: "body.turnSpeed", label: "Turn-in-place speed", group: G, subsection: "Facing", unit: "°/s", min: 60, max: 720, step: 10 },
  { key: "body.spineYaw", label: "Spine twist toward the aim", group: G, subsection: "Facing", unit: "×", min: 0, max: 1, step: 0.05 },
  { key: "body.downLean", label: "Chest back when looking down", group: G, subsection: "First person", unit: "×", min: 0, max: 1, step: 0.05 },
  { key: "body.spinePitch", label: "Spine bend with the view pitch", group: G, subsection: "Facing", unit: "×", min: 0, max: 1, step: 0.05 },
  { key: "body.velHz", label: "Velocity smoothing", group: G, subsection: "Blend space", unit: "Hz", min: 1, max: 30, step: 0.5 },
  { key: "body.moveFrom", label: "Idle → move from", group: G, subsection: "Blend space", unit: "m/s", min: 0.02, max: 0.6, step: 0.01 },
  { key: "body.walkAt", label: "Walk clip at (controller walk speed)", group: G, subsection: "Blend space", unit: "m/s", min: 0.8, max: 3, step: 0.05 },
  { key: "body.jogAt", label: "Jog clip at (controller run speed)", group: G, subsection: "Blend space", unit: "m/s", min: 2, max: 7, step: 0.05 },
  { key: "body.sprintAt", label: "Sprint clip at", group: G, subsection: "Blend space", unit: "m/s", min: 5, max: 12, step: 0.1 },
  { key: "body.strideWarp", label: "Speed into stride length (vs cadence)", group: G, subsection: "Blend space", min: 0, max: 1, step: 0.05 },
  { key: "body.strideMax", label: "Stride scale max", group: G, subsection: "Blend space", unit: "×", min: 1, max: 2, step: 0.05 },
  { key: "body.sideStepMax", label: "Side-steps up to (then hips turn)", group: G, subsection: "Blend space", unit: "m/s", min: 0.3, max: 2.5, step: 0.05 },
  { key: "body.warpMax", label: "Leg warp limit (strafe)", group: G, subsection: "Blend space", unit: "°", min: 0, max: 90, step: 1 },
  { key: "body.counterMax", label: "Spine counter-twist limit", group: G, subsection: "Blend space", unit: "°", min: 0, max: 90, step: 1 },
  { key: "body.warpHz", label: "Leg warp follow", group: G, subsection: "Blend space", unit: "Hz", min: 1, max: 30, step: 0.5 },
  { key: "body.backEnter", label: "Backpedal beyond", group: G, subsection: "Blend space", unit: "°", min: 90, max: 170, step: 1 },
  { key: "body.backExit", label: "Forward again under", group: G, subsection: "Blend space", unit: "°", min: 60, max: 150, step: 1 },
  { key: "body.crouchLean", label: "Crouch: trunk forward", group: G, subsection: "Blend space", unit: "°", min: 0, max: 60, step: 1 },
  { key: "body.crouchDepth", label: "Crouch depth (crouch clip weight)", group: G, subsection: "Blend space", min: 0.2, max: 1, step: 0.05 },
  { key: "body.fade", label: "State cross-fade", group: G, subsection: "Blend space", unit: "s", min: 0.02, max: 0.6, step: 0.01 },
  { key: "body.jumpStartAt", label: "Jump start clip from", group: G, subsection: "Blend space", unit: "s", min: 0, max: 1, step: 0.01 },
  { key: "body.footIK", label: "Foot + pelvis IK", group: G, subsection: "IK", type: "toggle" },
  { key: "body.footIKWeight", label: "Foot IK weight", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.ikMax", label: "IK height range", group: G, subsection: "IK", unit: "m", min: 0, max: 0.6, step: 0.01 },
  { key: "body.pelvisFollow", label: "Hips follow the lower foot", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.stairStride", label: "Shorter steps on stairs", group: G, subsection: "IK", unit: "×grade", min: 0, max: 1.5, step: 0.05 },
  { key: "body.ikHz", label: "IK smoothing", group: G, subsection: "IK", unit: "Hz", min: 2, max: 40, step: 1 },
  { key: "body.slopeAlign", label: "Boots align to slope", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.handPoses", label: "Authored hand poses (off: clip fingers)", group: G, subsection: "Hands", type: "toggle" },
  { key: "body.fingerCurl", label: "Relaxed finger curl", group: G, subsection: "Hands", unit: "×", min: 0, max: 2.5, step: 0.05 },
  { key: "body.thumbOppose", label: "Thumb toward the palm", group: G, subsection: "Hands", unit: "°", min: -40, max: 70, step: 1 },
  { key: "body.thumbAlong", label: "Thumb along the index", group: G, subsection: "Hands", unit: "°", min: -40, max: 60, step: 1 },
  { key: "body.thumbCurl", label: "Thumb tip curl", group: G, subsection: "Hands", unit: "°", min: 0, max: 50, step: 1 },
  { key: "body.fingersTogether", label: "Fingers together", group: G, subsection: "Hands", unit: "°", min: -6, max: 12, step: 0.5 },
  { key: "body.torch", label: "Hold the flashlight", group: G, subsection: "Hands", type: "toggle" },
  { key: "body.torchRight", label: "Torch hand right of the eye", group: G, subsection: "Hands", unit: "m", min: 0, max: 0.4, step: 0.01 },
  { key: "body.torchDown", label: "Torch hand below the eye", group: G, subsection: "Hands", unit: "m", min: 0.1, max: 0.7, step: 0.01 },
  { key: "body.torchFwd", label: "Torch hand ahead of the eye", group: G, subsection: "Hands", unit: "m", min: 0.1, max: 0.6, step: 0.01 },
  { key: "body.reachTime", label: "E reach duration", group: G, subsection: "Hands", unit: "s", min: 0.3, max: 1.5, step: 0.05 },
  { key: "body.ladderRung", label: "Ladder rung spacing", group: G, subsection: "Ladder", unit: "m", min: 0.2, max: 0.4, step: 0.01 },
  { key: "body.ladderGap", label: "Ladder ahead of the feet", group: G, subsection: "Ladder", unit: "m", min: 0.1, max: 0.6, step: 0.01 },
]

/** Locomotion loops in the blend space; "~" is the same clip played in reverse (a backpedal). */
const LOOPS = ["idle", "walk", "walk_back", "strafe_l", "strafe_r", "jog", "sprint", "jog~", "crouch_idle", "crouch_walk", "crouch_walk~"] as const
type Loop = (typeof LOOPS)[number]
type ClipInfo = { action: THREE.AnimationAction; dur: number; speed: number; offset: number }

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
  /** Orientation warp of the legs toward travel (degrees). */
  warp: number
  state: string
  /** Treadmill: the controller's velocity while the body stays put (a planted foot should move at minus this). */
  belt: THREE.Vector3
}

export class PlayerBody {
  /** At the controller's feet, turned to the body's yaw. */
  readonly root = new THREE.Group()
  readonly settings: LabSettings
  readonly ready: Promise<void>
  readonly debug: BodyDebug = { planted: [true, true], slide: [0, 0], weights: {}, phase: 0, warp: 0, state: "", belt: v3() }
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
  private back = false
  private warp = 0
  private strideK = 1
  private stairK = 1
  /** Travel direction relative to the legs (radians, 0 forward, +π/2 right). */
  private travelLocal = 0
  private legLen = 0.9
  private lv = new THREE.Vector2() // smoothed local velocity (x = right, y = forward)
  private phase = 0
  private idleT = 0
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
    // Backpedal loops: their own actions on clones of the forward clips (played with reversed phase).
    for (const name of ["jog", "crouch_walk"]) {
      const clip = clips.find((c) => c.name === name)
      if (!clip) continue
      const rev = clip.clone()
      rev.name = `${name}~`
      const a = mixer.clipAction(rev)
      a.enabled = false
      a.play()
      this.actions.set(rev.name, a)
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
    this.handR.apply(TORCH_GRIP)
    scene.updateMatrixWorld(true)
    const hand = this.bones.hand_r
    const inv = hand.getWorldQuaternion(new THREE.Quaternion()).invert()
    const hp = hand.getWorldPosition(v3())
    const at = (n: string) => (byName.get(n) as THREE.Object3D).getWorldPosition(v3())
    this.handAxis.subVectors(at("index_01_r"), at("pinky_01_r")).applyQuaternion(inv).normalize()
    this.handBack.subVectors(at("middle_01_r"), hp).applyQuaternion(inv)
    this.handBack.addScaledVector(this.handAxis, -this.handBack.dot(this.handAxis)).normalize()
    // The barrel's centre: midway between the knuckles (MCP) and the curled fingertips' joints (DIP), which wrap it.
    const hole = at("index_01_r").add(at("ring_01_r")).add(at("index_03_r")).add(at("ring_03_r")).multiplyScalar(0.25)
    this.torch.position.copy(hole.sub(hp).applyQuaternion(inv)).divideScalar(hand.getWorldScale(v3()).x)
    this.torch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.handAxis)
    this.torch.scale.setScalar(1 / hand.getWorldScale(v3()).x)
    hand.add(this.torch)
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
      for (const a of this.actions.values()) a.enabled = false
      action.enabled = true
      action.setEffectiveWeight(1)
      for (let i = 0; i < N; i++) {
        action.time = (dur * i) / N
        mixer.update(0)
        scene.updateMatrixWorld(true)
        fl.push(this.bones.ball_l.getWorldPosition(v3()))
        fr.push(this.bones.ball_r.getWorldPosition(v3()))
      }
      action.enabled = false
      // Ground speed: how fast the supporting (lower) foot slides back under the in-place body, median over the cycle
      // (the 2 cm-above-lowest test it replaced caught only the flat-foot instant and doubled the jog's speed).
      const v: number[] = []
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N
        const f = fl[i]!.y <= fr[i]!.y ? fl : fr
        if ((fl[i]!.y <= fr[i]!.y) !== (fl[j]!.y <= fr[j]!.y)) continue
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
      return { action, dur, speed: time > 0 ? dist / time : 0, offset }
    }
    for (const l of LOOPS) if (!l.endsWith("~")) this.loops[l] = measure(l)
    for (const l of LOOPS) if (l.endsWith("~")) this.loops[l] = { ...this.loops[l.slice(0, -1) as Loop], action: this.actions.get(l)! }
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
      this.handR?.apply(name === "torch" ? TORCH_GRIP : this.relaxed())
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
    return Object.fromEntries(LOOPS.map((l) => [l, { speed: +this.loops[l]?.speed.toFixed(2), stride: +(this.loops[l]?.speed * this.loops[l]?.dur).toFixed(2), offset: +this.loops[l]?.offset.toFixed(2) }]))
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
    // 2D blend over the controller's velocity in the body's frame. Walking: real motion-capture loops for each
    // direction (forward, backward, side-step left/right), weighted by the travel angle relative to the legs. Faster
    // than a person side-steps (and at a run, and crouched), the legs turn toward travel (orientation warping, the
    // spine turns back to the aim) and the forward/back loops carry it. All loops share one phase from the left
    // footfall; playback rate and a stride scale on the stance foot match ground speed, so the feet don't skate.
    const vf = s.vel.x * fwd.x + s.vel.z * fwd.z
    const vr = s.vel.x * right.x + s.vel.z * right.z
    const kv = damp(this.num("body.velHz"), dt)
    this.lv.x += (vr - this.lv.x) * kv
    this.lv.y += (vf - this.lv.y) * kv
    let sp = this.lv.length()
    let dirA = sp > 0.05 ? Math.atan2(this.lv.x, this.lv.y) : 0
    // Turning in place: short steps on the spot while the root comes round.
    const shuffle = this.turning && sp < 0.6
    if (shuffle) {
      sp = 0.6
      dirA = 0
    }
    const deg = Math.PI / 180
    if (sp > 0.15) {
      if (!this.back && Math.abs(dirA) > this.num("body.backEnter") * deg) this.back = true
      else if (this.back && Math.abs(dirA) < this.num("body.backExit") * deg) this.back = false
    }
    const move = smooth01(this.num("body.moveFrom") * 0.5, this.num("body.moveFrom") + 0.35, sp)
    const walkAt = this.num("body.walkAt")
    const jogAt = this.num("body.jogAt")
    const sprintAt = this.num("body.sprintAt")
    const jogK = smooth01(walkAt, jogAt, sp)
    const sprintK = smooth01(jogAt, sprintAt, sp)
    // The crouch clips are a deep sneak; blended with the standing loops at "Crouch depth" they match the eye height.
    this.crouchW += ((s.crouch > 0.5 ? this.num("body.crouchDepth") : 0) - this.crouchW) * damp(8, dt)
    const cw = this.crouchW
    // How much the legs turn toward travel: none for a slow side-step, fully at a run, crouched, or faster than a
    // side-step goes.
    const sideMax = this.num("body.sideStepMax")
    const warpK = Math.max(smooth01(sideMax, sideMax * 1.6, sp), jogK, smooth01(0.05, 0.3, cw))
    const legGoal = this.back ? wrap(dirA - Math.PI) : dirA
    const limit = this.num("body.warpMax") * deg
    const warpGoal = THREE.MathUtils.clamp(legGoal, -limit, limit) * move * warpK
    this.warp += wrap(warpGoal - this.warp) * damp(this.num("body.warpHz"), dt)
    // Travel relative to the legs.
    const t = wrap(dirA - this.warp)
    const cF = Math.max(0, Math.cos(t))
    const cB = Math.max(0, -Math.cos(t))
    const cR = Math.max(0, Math.sin(t))
    const cL = Math.max(0, -Math.sin(t))
    const cs = cF + cB + cR + cL || 1
    // At a run there are no side clips: the lateral share folds into forward/back.
    const runF = cF + cB > 1e-4 ? cF / (cF + cB) : 1
    const walkW = move * (1 - cw) * (1 - jogK)
    const runW = move * (1 - cw) * jogK
    const W: Record<Loop, number> = {
      idle: (1 - move) * (1 - cw),
      walk: walkW * (cF / cs),
      walk_back: walkW * (cB / cs),
      strafe_r: walkW * (cR / cs),
      strafe_l: walkW * (cL / cs),
      jog: runW * runF * (1 - sprintK),
      sprint: runW * runF * sprintK,
      "jog~": runW * (1 - runF),
      crouch_idle: (1 - move) * cw,
      crouch_walk: move * cw * runF,
      "crouch_walk~": move * cw * (1 - runF),
    }
    // Phase rate: all loops share one phase, so the blended planted foot moves at the weighted mean stride per cycle;
    // cycles per second = ground speed / (that stride × the stride scale).
    let stride = 0
    let natural = 0
    let wMove = 0
    for (const l of LOOPS) {
      const c = this.loops[l]
      if (c.speed <= 0 || W[l] <= 0) continue
      stride += W[l] * c.speed * c.dur
      natural += W[l] * c.speed
      wMove += W[l]
    }
    natural = wMove > 0 ? natural / wMove : 0
    // Stride scaling only for walking: the run clip's legs are already at full reach (scaling them split the legs);
    // a run goes faster by cadence alone.
    // Crouched: shorter, careful steps.
    const crouchStride = 1 - 0.35 * THREE.MathUtils.smoothstep(s.crouch, 0, 1)
    const strideGoal = !shuffle && natural > 0 && sp > 0.05 ? THREE.MathUtils.clamp((sp / natural) ** this.num("body.strideWarp"), 0.7, this.num("body.strideMax")) : 1
    this.strideK += (THREE.MathUtils.lerp(1, strideGoal, move * (1 - jogK)) * crouchStride - this.strideK) * damp(4, dt)
    // Stairs and steep ground: shorter steps (people don't stride a metre up a flight), taken faster.
    const tx = this.travelLocal
    const tdir = fwd.clone().applyAxisAngle(UP, -this.warp - tx)
    const gy = s.pos.y + 0.6
    const ahead = this.ground(s.pos.x + tdir.x * 0.45, s.pos.z + tdir.z * 0.45, gy)
    const behind = this.ground(s.pos.x - tdir.x * 0.45, s.pos.z - tdir.z * 0.45, gy)
    const grade = sp > 0.1 ? Math.abs(ahead - behind) / 0.9 : 0
    const stairGoal = 1 - THREE.MathUtils.clamp(grade * this.num("body.stairStride"), 0, 0.45)
    this.stairK += (stairGoal - this.stairK) * damp(5, dt)
    const rate = wMove > 0 ? (shuffle ? 0.9 / this.loops.walk.dur : sp / ((stride / wMove) * this.strideK * this.stairK)) : 0
    this.phase = (this.phase + rate * dt) % 1
    this.idleT += dt
    this.debug.warp = this.warp / deg
    this.travelLocal = t

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

    // ------------------------------------------------------------------ mixer weights
    const ground = 1 - this.air
    for (const l of LOOPS) {
      const c = this.loops[l]
      const w = W[l] * ground
      c.action.enabled = w > 1e-3
      c.action.setEffectiveWeight(w)
      c.action.setEffectiveTimeScale(0)
      const ph = c.speed > 0 ? this.phase : (this.idleT / c.dur) % 1
      const dir = l.endsWith("~") ? -1 : 1
      c.action.time = ((((dir * ph + c.offset) % 1) + 1) % 1) * c.dur
      this.debug.weights[l] = w
    }
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
      const fist = this.debug.weights.jog ?? 0
      const runK = Math.min(1, fist + (this.debug.weights.sprint ?? 0) + (this.debug.weights["jog~"] ?? 0))
      this.handL?.apply(relaxed, LOOSE_FIST, runK)
      if (this.torchW > 0.5) this.handR?.apply(relaxed, TORCH_GRIP, this.torchW)
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
    // Orientation warp: the pelvis (and so the legs) turns toward travel, the spine turns back.
    const warp = this.warp * (1 - this.ladder) * (1 - this.air)
    // The chest turns back toward the aim, up to a human twist; beyond it the shoulders face partly toward travel.
    const cmax = this.num("body.counterMax") * (Math.PI / 180)
    const counter = THREE.MathUtils.clamp(warp, -cmax, cmax)
    if (Math.abs(warp) > 1e-4) {
      rotateWorld(b.pelvis, new THREE.Quaternion().setFromAxisAngle(UP, -warp))
      refreshTree(b.pelvis)
    }
    // Looking down, the chest leans back out of the view a little (as shipped full-body FPS rigs do), so you see your
    // legs and boots past it rather than your shirt front.
    // Crouching (the walk/idle clips with the hips lowered by IK to the controller's crouched eye height): the trunk
    // folds forward from the hips, the way people crouch-walk under something.
    const crouchLean = -THREE.MathUtils.smoothstep(s.crouch, 0, 1) * this.num("body.crouchLean") * (Math.PI / 180)
    const downLean = Math.max(0, -pitch) * this.num("body.downLean") + crouchLean
    for (const [bone, wy, wp] of spine) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, (dYaw * yawK + counter) * wy)
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
    const legFwd = fwd.clone().applyAxisAngle(UP, -warp)
    const travelDir = legFwd.clone().applyAxisAngle(UP, -this.travelLocal)
    let reachDrop = 0
    const contactW = [1, 1]
    for (let i = 0; i < 2; i++) {
      worldPos(feet[i], footW[i]!)
      const scaleK = this.strideK * this.stairK
      // How much this foot is in contact in the clip (on its floor → 1, swinging high → 0).
      const animH = footW[i]!.y - rootY - this.restFootH[i]!
      contactW[i] = 1 - smooth01(0.03, 0.2, animH)
      if (Math.abs(scaleK - 1) > 1e-3) {
        const hip = worldPos(i === 0 ? b.thigh_l : b.thigh_r, v3())
        const d = footW[i]!.clone().sub(hip).dot(travelDir)
        footW[i]!.addScaledVector(travelDir, d * (scaleK - 1))
        const reach = this.legLen * 0.985
        const horiz = Math.hypot(footW[i]!.x - hip.x, footW[i]!.z - hip.z)
        const maxV = Math.sqrt(Math.max(0, reach * reach - horiz * horiz))
        reachDrop = Math.min(reachDrop, -Math.max(0, hip.y - footW[i]!.y - maxV))
      }
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
    let pelvisWant = reachDrop
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
    // Crouching: hips down until the eyes sit under the crouched camera. Only for the crouch — the camera's
    // step-smoothing spring lags behind the feet on stairs, and following it squatted the body on every flight.
    if (this.on("body.eyeMatch") && s.crouch > 0.02) {
      const neck = worldPos(b.neck_01, v3())
      const over = neck.y + this.eyeAboveNeck + this.num("body.eyeGap") - s.eye.y
      if (over > 0) pelvisWant = Math.min(pelvisWant, -Math.min(over, 0.55) * THREE.MathUtils.smoothstep(s.crouch, 0.02, 0.4))
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
    if (this.torchW > 1e-3 && this.ladder < 0.5) {
      // Held the way people carry a flashlight at the chest: elbow down at the side, forearm across the front of the
      // body, wrist straight, lens forward past the thumb. The fist's barrel axis is set to the aim; its back axis
      // continues the forearm (made square to the aim), so the wrist never bends more than the aim asks for.
      // Placed in the body's yaw frame (pitching that frame swung the fist into the chest when looking down); looking
      // up raises it a little.
      const target = eye.clone().addScaledVector(yawRight, this.num("body.torchRight")).addScaledVector(yawFwd, this.num("body.torchFwd"))
      target.y -= this.num("body.torchDown") - Math.max(0, s.pitch) * 0.15
      const pole = yawRight.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, -1, 0)).addScaledVector(yawFwd, -0.2)
      twoBoneIK(b.upperarm_r, b.lowerarm_r, b.hand_r, target, this.torchW, pole)
      const fore = worldPos(b.hand_r, v3()).sub(worldPos(b.lowerarm_r, v3())).normalize()
      const backDir = fore.clone().addScaledVector(aim, -fore.dot(aim))
      if (backDir.lengthSq() < 1e-4) backDir.copy(yawRight).negate()
      const q = aimQuat(this.handAxis, this.handBack, aim, backDir.normalize(), new THREE.Quaternion())
      setWorldQuat(b.hand_r, worldQuat(b.hand_r, new THREE.Quaternion()).slerp(q, this.torchW))
      if (!this.on("body.handPoses")) for (const g of this.grip) g.bone.quaternion.slerp(g.q, this.torchW)
      refreshTree(b.hand_r)
    }
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
