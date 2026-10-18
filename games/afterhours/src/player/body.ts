import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"
import { aimQuat, refresh, refreshTree, rotateWorld, setWorldQuat, twoBoneIK, worldPos, worldQuat } from "./ik"
import { createTorch } from "./torch"

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
  "body.back": 0.12,
  "body.lookBack": 0.12,
  "body.eyeGap": 0.03,
  "body.yawHz": 10,
  "body.turnStart": 60,
  "body.turnSpeed": 260,
  "body.velHz": 9,
  "body.walkAt": 2.4,
  "body.jogAt": 3.8,
  "body.sprintAt": 8,
  "body.moveFrom": 0.12,
  "body.fade": 0.2,
  "body.crouchDepth": 0.75,
  "body.warpMax": 75,
  "body.strideWarp": 0.5,
  "body.strideMin": 0.75,
  "body.strideMax": 1.45,
  "body.warpHz": 10,
  "body.backEnter": 112,
  "body.backExit": 95,
  "body.jumpStartAt": 0.42,
  "body.footIK": true,
  "body.footIKWeight": 1,
  "body.ikMax": 0.45,
  "body.ikHz": 18,
  "body.slopeAlign": 0.8,
  "body.eyeMatch": true,
  "body.spinePitch": 0.12,
  "body.downLean": 0.35,
  "body.spineYaw": 0.85,
  "body.torch": true,
  "body.torchRight": 0.2,
  "body.torchDown": 0.27,
  "body.torchFwd": 0.26,
  "body.torchAvoidBeam": true,
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
  { key: "body.walkAt", label: "Full walk at", group: G, subsection: "Blend space", unit: "m/s", min: 0.5, max: 3, step: 0.05 },
  { key: "body.jogAt", label: "Full jog at", group: G, subsection: "Blend space", unit: "m/s", min: 2, max: 6, step: 0.05 },
  { key: "body.sprintAt", label: "Full sprint at", group: G, subsection: "Blend space", unit: "m/s", min: 4, max: 10, step: 0.1 },
  { key: "body.warpMax", label: "Leg warp limit (strafe)", group: G, subsection: "Blend space", unit: "°", min: 0, max: 90, step: 1 },
  { key: "body.warpHz", label: "Leg warp follow", group: G, subsection: "Blend space", unit: "Hz", min: 1, max: 30, step: 0.5 },
  { key: "body.backEnter", label: "Backpedal beyond", group: G, subsection: "Blend space", unit: "°", min: 90, max: 170, step: 1 },
  { key: "body.backExit", label: "Forward again under", group: G, subsection: "Blend space", unit: "°", min: 60, max: 150, step: 1 },
  { key: "body.strideWarp", label: "Speed into stride length (vs cadence)", group: G, subsection: "Blend space", min: 0, max: 1, step: 0.05 },
  { key: "body.strideMin", label: "Stride scale min", group: G, subsection: "Blend space", unit: "×", min: 0.5, max: 1, step: 0.05 },
  { key: "body.strideMax", label: "Stride scale max", group: G, subsection: "Blend space", unit: "×", min: 1, max: 2, step: 0.05 },
  { key: "body.crouchDepth", label: "Crouch depth (crouch clip weight)", group: G, subsection: "Blend space", min: 0.2, max: 1, step: 0.05 },
  { key: "body.fade", label: "State cross-fade", group: G, subsection: "Blend space", unit: "s", min: 0.02, max: 0.6, step: 0.01 },
  { key: "body.jumpStartAt", label: "Jump start clip from", group: G, subsection: "Blend space", unit: "s", min: 0, max: 1, step: 0.01 },
  { key: "body.footIK", label: "Foot + pelvis IK", group: G, subsection: "IK", type: "toggle" },
  { key: "body.footIKWeight", label: "Foot IK weight", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.ikMax", label: "IK height range", group: G, subsection: "IK", unit: "m", min: 0, max: 0.6, step: 0.01 },
  { key: "body.ikHz", label: "IK smoothing", group: G, subsection: "IK", unit: "Hz", min: 2, max: 40, step: 1 },
  { key: "body.slopeAlign", label: "Boots align to slope", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.torch", label: "Hold the flashlight", group: G, subsection: "Hands", type: "toggle" },
  { key: "body.torchRight", label: "Torch hand right (view space)", group: G, subsection: "Hands", unit: "m", min: 0, max: 0.4, step: 0.01 },
  { key: "body.torchDown", label: "Torch hand down (view space)", group: G, subsection: "Hands", unit: "m", min: 0.1, max: 0.7, step: 0.01 },
  { key: "body.torchFwd", label: "Torch hand ahead (view space)", group: G, subsection: "Hands", unit: "m", min: 0.1, max: 0.6, step: 0.01 },
  { key: "body.torchAvoidBeam", label: "Keep the torch hand out of the beam", group: G, subsection: "Hands", type: "toggle" },
  { key: "body.reachTime", label: "E reach duration", group: G, subsection: "Hands", unit: "s", min: 0.3, max: 1.5, step: 0.05 },
  { key: "body.ladderRung", label: "Ladder rung spacing", group: G, subsection: "Ladder", unit: "m", min: 0.2, max: 0.4, step: 0.01 },
  { key: "body.ladderGap", label: "Ladder ahead of the feet", group: G, subsection: "Ladder", unit: "m", min: 0.1, max: 0.6, step: 0.01 },
]

/** Locomotion loops in the blend space; "~" is the same clip played in reverse (a backpedal). */
const LOOPS = ["idle", "walk", "jog", "sprint", "walk~", "jog~", "crouch_idle", "crouch_walk", "crouch_walk~"] as const
type Loop = (typeof LOOPS)[number]
type ClipInfo = { action: THREE.AnimationAction; dur: number; speed: number; offset: number }

const BONES = [
  "Root", "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head",
  "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r",
  "thigh_l", "calf_l", "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r",
  "index_01_r", "pinky_01_r", "middle_01_r",
] as const
type BoneName = (typeof BONES)[number]

const RIGHT_HAND = /^(hand_r|(index|middle|ring|pinky|thumb)_0\d_r)\./
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
  /** Stride warp scale. */
  stride: number
  state: string
  /** Treadmill: the controller's velocity while the body stays put (a planted foot should move at minus this). */
  belt: THREE.Vector3
}

export class PlayerBody {
  /** At the controller's feet, turned to the body's yaw. */
  readonly root = new THREE.Group()
  readonly settings: LabSettings
  readonly ready: Promise<void>
  readonly debug: BodyDebug = { planted: [true, true], slide: [0, 0], weights: {}, phase: 0, warp: 0, stride: 1, state: "", belt: v3() }
  model: THREE.Object3D | null = null
  mixer: THREE.AnimationMixer | null = null
  private bones = {} as Record<BoneName, THREE.Bone>
  private loops = {} as Record<Loop, ClipInfo>
  private actions = new Map<string, THREE.AnimationAction>()
  private torchGrip: THREE.AnimationAction | null = null
  private torch = createTorch()
  private ground: GroundQuery
  // Motion state.
  private bodyYaw = Number.NaN
  private turning = false
  private back = false
  private backK = 0
  private warp = 0
  private strideK = 1
  private drift = 0
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
    for (const name of ["walk", "jog", "crouch_walk"]) {
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
    // The torch clip's right hand only: the grip (fingers round the barrel); the arm itself is IK.
    const torch = clips.find((c) => c.name === "torch")
    if (torch) {
      const grip = new THREE.AnimationClip("torch_grip", torch.duration, torch.tracks.filter((t) => RIGHT_HAND.test(t.name)))
      this.torchGrip = mixer.clipAction(grip)
      this.torchGrip.enabled = false
      this.torchGrip.play()
    }

    this.eyeAboveNeck = 1.655 - this.bones.neck_01.getWorldPosition(v3()).y
    // Hand-local axes for the torch grip: across the fist and back along the hand.
    const hand = this.bones.hand_r
    const inv = hand.getWorldQuaternion(new THREE.Quaternion()).invert()
    const hp = hand.getWorldPosition(v3())
    const index = this.bones.index_01_r.getWorldPosition(v3())
    const pinky = this.bones.pinky_01_r.getWorldPosition(v3())
    const middle = this.bones.middle_01_r.getWorldPosition(v3())
    this.handAxis.subVectors(index, pinky).applyQuaternion(inv).normalize()
    this.handBack.subVectors(hp, middle).applyQuaternion(inv).normalize()
    // Torch in the fist: barrel along the fist axis, through the palm below the knuckles.
    const palmSide = v3().crossVectors(this.handAxis, this.handBack).normalize()
    const knuckles = middle.clone().sub(hp).applyQuaternion(inv)
    this.torch.position.copy(knuckles).multiplyScalar(0.55).addScaledVector(palmSide, -0.03)
    this.torch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.handAxis)
    this.torch.scale.setScalar(1 / hand.getWorldScale(v3()).x)
    hand.add(this.torch)
    this.torch.traverse((o) => o.layers.set(BODY_LAYER))

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
      // Ground speed: the travel of each foot while it is within 2 cm of its lowest point (stance), per second.
      let dist = 0
      let time = 0
      for (const f of [fl, fr]) {
        const min = Math.min(...f.map((p) => p.y))
        for (let i = 0; i < N; i++) {
          const j = (i + 1) % N
          if (f[i]!.y > min + 0.02 || f[j]!.y > min + 0.02) continue
          dist += Math.hypot(f[j]!.x - f[i]!.x, f[j]!.z - f[i]!.z)
          time += dur / N
        }
      }
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
      if (mesh.name.includes("short02")) mesh.layers.set(HEAD_LAYER)
      else if (!/casualsuit|shoes/.test(mesh.name)) splitHead(mesh, new Set<THREE.Object3D>([this.bones.head, this.bones.neck_01]))
    })
    this.root.visible = true
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
    // Local velocity → direction group (forward loops, or the same loops reversed for a backpedal) × speed band
    // (idle / walk / jog / sprint), plus orientation warping: the legs turn toward the travel direction (up to "Warp
    // limit") and the spine turns back to the aim, so strafes and diagonals come from the forward/back loops.
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
    this.backK += ((this.back ? 1 : 0) - this.backK) * damp(1 / Math.max(0.02, this.num("body.fade")) * 2.2, dt)
    const legDir = this.back ? wrap(dirA - Math.PI) : dirA
    const limit = this.num("body.warpMax") * deg
    const move = smooth01(this.num("body.moveFrom") * 0.5, this.num("body.moveFrom") + 0.35, sp)
    const warpGoal = THREE.MathUtils.clamp(legDir, -limit, limit) * move
    this.warp += wrap(warpGoal - this.warp) * damp(this.num("body.warpHz"), dt)
    // The legs move along their own heading; what's left of the travel angle is sideways drift.
    const resid = THREE.MathUtils.clamp(wrap(legDir - this.warp), -0.7, 0.7)
    const along = sp * Math.max(0.2, Math.cos(resid))
    this.drift = Math.tan(resid) * move
    const walkAt = this.num("body.walkAt")
    const jogAt = this.num("body.jogAt")
    const sprintAt = this.num("body.sprintAt")
    const jogK = smooth01(walkAt, jogAt, along)
    const sprintK = smooth01(jogAt, sprintAt, along)
    // The crouch clips are a deep sneak; blended with the standing loops at "Crouch depth" they match the eye height.
    this.crouchW += ((s.crouch > 0.5 ? this.num("body.crouchDepth") : 0) - this.crouchW) * damp(8, dt)
    const cw = this.crouchW
    const fK = 1 - this.backK
    const bK = this.backK
    const W: Record<Loop, number> = {
      idle: (1 - move) * (1 - cw),
      walk: move * (1 - cw) * fK * (1 - jogK),
      jog: move * (1 - cw) * fK * jogK * (1 - sprintK),
      sprint: move * (1 - cw) * fK * jogK * sprintK,
      "walk~": move * (1 - cw) * bK * (1 - jogK),
      "jog~": move * (1 - cw) * bK * jogK,
      crouch_idle: (1 - move) * cw,
      crouch_walk: move * cw * fK,
      "crouch_walk~": move * cw * bK,
    }
    // Phase rate: all loops share one phase, so the blended planted foot moves at the weighted mean stride per cycle;
    // cycles per second = ground speed / that stride.
    let stride = 0
    let wMove = 0
    for (const l of LOOPS) {
      const c = this.loops[l]
      if (c.speed <= 0 || W[l] <= 0) continue
      stride += W[l] * c.speed * c.dur
      wMove += W[l]
    }
    // Speed beyond (or short of) the clips' authored speed goes partly into longer (shorter) steps, the rest into cadence.
    let natural = 0
    for (const l of LOOPS) {
      const c = this.loops[l]
      if (c.speed > 0 && W[l] > 0) natural += W[l] * c.speed
    }
    natural = wMove > 0 ? natural / wMove : 0
    const strideGoal = shuffle ? this.num("body.strideMin") * 0.4 : natural > 0 && along > 0.05 ? THREE.MathUtils.clamp((along / natural) ** this.num("body.strideWarp"), this.num("body.strideMin"), this.num("body.strideMax")) : 1
    this.strideK += (THREE.MathUtils.lerp(1, strideGoal, move) - this.strideK) * damp(6, dt)
    const rate = wMove > 0 ? along / ((stride / wMove) * this.strideK) : 0
    this.phase = (this.phase + rate * dt) % 1
    this.idleT += dt
    this.debug.warp = this.warp / deg
    this.debug.stride = this.strideK

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
    if (this.torchGrip) {
      this.torchGrip.enabled = this.torchW > 1e-3
      this.torchGrip.setEffectiveWeight(this.torchW)
      this.torchGrip.setEffectiveTimeScale(0)
      this.torchGrip.time = 0.2
    }
    this.debug.phase = this.phase
    this.debug.state = s.onLadder ? "ladder" : airborne ? (this.jumpT >= 0 ? "jump" : "fall") : this.turning ? "turn" : moving ? (cw > 0.3 ? "crouch-walk" : "move") : cw > 0.3 ? "crouch" : "idle"
    mixer.update(dt)
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
    if (Math.abs(warp) > 1e-4) {
      rotateWorld(b.pelvis, new THREE.Quaternion().setFromAxisAngle(UP, -warp))
      refreshTree(b.pelvis)
    }
    // Looking down, the chest leans back out of the view a little (as shipped full-body FPS rigs do), so you see your
    // legs and boots past it rather than your shirt front.
    const downLean = Math.max(0, -pitch) * this.num("body.downLean")
    for (const [bone, wy, wp] of spine) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, (dYaw * yawK + warp) * wy)
      q.multiply(new THREE.Quaternion().setFromAxisAngle(aimRight, (pitch * pitchK + downLean) * wp))
      rotateWorld(bone, q)
      refreshTree(bone)
    }
    // Head and neck take the rest of the view (for shadows and debug views; hidden in first person).
    const headQ = new THREE.Quaternion().setFromAxisAngle(UP, dYaw * (1 - yawK))
    headQ.multiply(new THREE.Quaternion().setFromAxisAngle(aimRight, pitch * (1 - pitchK)))
    rotateWorld(b.neck_01, headQ)
    refreshTree(b.neck_01)

    // Pelvis: low enough for each foot to reach its floor, and for the eyes to stay under the camera.
    const rootY = s.pos.y
    const ikOn = this.on("body.footIK") && s.grounded && !s.onLadder
    const ikMax = this.num("body.ikMax")
    const kIK = damp(this.num("body.ikHz"), dt)
    const feet = [b.foot_l, b.foot_r] as const
    const footW = [v3(), v3()]
    const normals = [UP.clone(), UP.clone()]
    // Stride warping: the ankles' offsets from their hips along the legs' heading scale by `strideK`, so a clip can
    // cover more (or less) ground per step than authored at a natural cadence.
    const legFwd = fwd.clone().applyAxisAngle(UP, -warp)
    const legRight = new THREE.Vector3().crossVectors(legFwd, UP)
    const hipW = [worldPos(b.thigh_l, v3()), worldPos(b.thigh_r, v3())]
    let reachDrop = 0
    for (let i = 0; i < 2; i++) {
      worldPos(feet[i], footW[i]!)
      if (Math.abs(this.strideK - 1) > 1e-3 || Math.abs(this.drift) > 1e-3) {
        const d = footW[i]!.clone().sub(hipW[i]!).dot(legFwd)
        footW[i]!.addScaledVector(legFwd, d * (this.strideK - 1))
        // Travel the legs' heading can't turn to (beyond the warp limit): the stance foot runs diagonally under the hip.
        footW[i]!.addScaledVector(legRight, d * this.strideK * this.drift)
        // The leg must still reach: lower the hips if the new ankle is out of range.
        const reach = this.legLen * 0.995
        const dx = footW[i]!.x - hipW[i]!.x
        const dz = footW[i]!.z - hipW[i]!.z
        const maxDown = Math.sqrt(Math.max(0, reach * reach - dx * dx - dz * dz))
        reachDrop = Math.min(reachDrop, hipW[i]!.y - footW[i]!.y > maxDown ? maxDown - (hipW[i]!.y - footW[i]!.y) : 0)
      }
      let want = 0
      if (ikOn) {
        const g = this.ground(footW[i]!.x, footW[i]!.z, rootY + ikMax)
        want = THREE.MathUtils.clamp(g - rootY, -ikMax, ikMax)
        normals[i] = this.normalAt(footW[i]!.x, footW[i]!.z, g, rootY + ikMax)
      }
      this.footOff[i]! += (want - this.footOff[i]!) * kIK
    }
    let pelvisWant = Math.min(ikOn ? Math.min(this.footOff[0]!, this.footOff[1]!, 0) : 0, reachDrop)
    if (this.on("body.eyeMatch")) {
      const neck = worldPos(b.neck_01, v3())
      const over = neck.y + this.eyeAboveNeck + this.num("body.eyeGap") - s.eye.y
      if (over > 0) pelvisWant = Math.min(pelvisWant, -Math.min(over, 0.5))
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
      if (target.distanceToSquared(worldPos(foot, v3())) > 1e-6) twoBoneIK(thigh, calf, foot, target, ikOn ? wIK : 1, fwd, false)
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
      // In contact: the lower foot, within 2 cm of the floor and not still coming down (or lifting) faster than 0.15 m/s.
      const vy = this.hasPrev && dt > 0 ? (p.y - this.prevFoot[i]!.y) / dt : 0
      const planted = s.grounded && !s.onLadder && i === low && hs[i]! < 0.02 && Math.abs(vy) < 0.15
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
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camQ)
    const yawRight = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw))
    const yawFwd = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw))
    this.torch.visible = this.torchW > 0.5
    if (this.torchW > 1e-3 && this.ladder < 0.5) {
      // Hand in the lower right of the view, in a camera frame whose pitch is eased (so looking at your feet keeps the
      // fist in front of the hips rather than at the knees); barrel along the aim.
      const pa = THREE.MathUtils.clamp(s.pitch, -0.75, 0.5)
      const holdQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(pa, s.yaw, 0, "YXZ"))
      const target = new THREE.Vector3(this.num("body.torchRight"), -this.num("body.torchDown"), -this.num("body.torchFwd")).applyQuaternion(holdQ).add(eye)
      if (this.on("body.torchAvoidBeam")) outOfBeam(target, eye, camQ, aim)
      const pole = yawRight.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, -1, 0)).addScaledVector(yawFwd, -0.3)
      twoBoneIK(b.upperarm_r, b.lowerarm_r, b.hand_r, target, this.torchW, pole)
      // Hand: the fist's axis along the aim, the hand continuing the forearm.
      const elbow = worldPos(b.lowerarm_r, v3())
      const wrist = worldPos(b.hand_r, v3())
      const toElbow = elbow.sub(wrist).normalize()
      const q = aimQuat(this.handAxis, this.handBack, aim, toElbow, new THREE.Quaternion())
      const cur = worldQuat(b.hand_r, new THREE.Quaternion())
      setWorldQuat(b.hand_r, cur.slerp(q, this.torchW))
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
    void camRight
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

const BEAM_FROM = new THREE.Vector3(0.22, -0.28, -0.1)
const OUT_DIR = new THREE.Vector3(0.45, -1, 0)
/**
 * render/lighting.ts emits the flashlight from a fixed point by the eye (camera-local 0.22, -0.28, -0.1), not from the
 * torch: keep the fist just outside that cone, toward the lower right, or the beam blows it out at point-blank range.
 */
function outOfBeam(p: THREE.Vector3, eye: THREE.Vector3, camQ: THREE.Quaternion, dir: THREE.Vector3) {
  const from = BEAM_FROM.clone().applyQuaternion(camQ).add(eye)
  const rel = p.clone().sub(from)
  const t = rel.dot(dir)
  if (t <= 0) return
  const perp = rel.addScaledVector(dir, -t)
  const need = t * Math.tan((38 * Math.PI) / 180) + 0.05
  if (perp.length() >= need) return
  const out = OUT_DIR.clone().applyQuaternion(camQ)
  out.addScaledVector(dir, -out.dot(dir)).normalize()
  p.copy(from).addScaledVector(dir, t).addScaledVector(out, need)
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
