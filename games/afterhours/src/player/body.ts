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
  "body.back": 0.13,
  "body.lookBack": 0.1,
  "body.eyeGap": 0.03,
  "body.yawHz": 10,
  "body.turnStart": 60,
  "body.turnSpeed": 260,
  "body.velHz": 9,
  "body.walkAt": 1.6,
  "body.jogAt": 4,
  "body.sprintAt": 6,
  "body.moveFrom": 0.12,
  "body.fade": 0.2,
  "body.jumpStartAt": 0.42,
  "body.footIK": true,
  "body.footIKWeight": 1,
  "body.ikMax": 0.45,
  "body.ikHz": 18,
  "body.slopeAlign": 0.8,
  "body.eyeMatch": true,
  "body.spinePitch": 0.4,
  "body.spineYaw": 0.85,
  "body.torch": true,
  "body.torchRight": 0.2,
  "body.torchDown": 0.4,
  "body.torchFwd": 0.3,
  "body.torchAvoidBeam": true,
  "body.reachTime": 0.8,
  "body.ladderRung": 0.3,
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
  { key: "body.spinePitch", label: "Spine bend with the view pitch", group: G, subsection: "Facing", unit: "×", min: 0, max: 1, step: 0.05 },
  { key: "body.velHz", label: "Velocity smoothing", group: G, subsection: "Blend space", unit: "Hz", min: 1, max: 30, step: 0.5 },
  { key: "body.moveFrom", label: "Idle → move from", group: G, subsection: "Blend space", unit: "m/s", min: 0.02, max: 0.6, step: 0.01 },
  { key: "body.walkAt", label: "Full walk at", group: G, subsection: "Blend space", unit: "m/s", min: 0.5, max: 3, step: 0.05 },
  { key: "body.jogAt", label: "Full jog at", group: G, subsection: "Blend space", unit: "m/s", min: 2, max: 6, step: 0.05 },
  { key: "body.sprintAt", label: "Full sprint at", group: G, subsection: "Blend space", unit: "m/s", min: 4, max: 9, step: 0.1 },
  { key: "body.fade", label: "State cross-fade", group: G, subsection: "Blend space", unit: "s", min: 0.02, max: 0.6, step: 0.01 },
  { key: "body.jumpStartAt", label: "Jump start clip from", group: G, subsection: "Blend space", unit: "s", min: 0, max: 1, step: 0.01 },
  { key: "body.footIK", label: "Foot + pelvis IK", group: G, subsection: "IK", type: "toggle" },
  { key: "body.footIKWeight", label: "Foot IK weight", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.ikMax", label: "IK height range", group: G, subsection: "IK", unit: "m", min: 0, max: 0.6, step: 0.01 },
  { key: "body.ikHz", label: "IK smoothing", group: G, subsection: "IK", unit: "Hz", min: 2, max: 40, step: 1 },
  { key: "body.slopeAlign", label: "Boots align to slope", group: G, subsection: "IK", min: 0, max: 1, step: 0.05 },
  { key: "body.torch", label: "Hold the flashlight", group: G, subsection: "Hands", type: "toggle" },
  { key: "body.torchRight", label: "Torch hand right of the eye", group: G, subsection: "Hands", unit: "m", min: 0, max: 0.4, step: 0.01 },
  { key: "body.torchDown", label: "Torch hand below the eye", group: G, subsection: "Hands", unit: "m", min: 0.1, max: 0.7, step: 0.01 },
  { key: "body.torchFwd", label: "Torch hand ahead of the eye", group: G, subsection: "Hands", unit: "m", min: 0.1, max: 0.6, step: 0.01 },
  { key: "body.torchAvoidBeam", label: "Keep the torch hand out of the beam", group: G, subsection: "Hands", type: "toggle" },
  { key: "body.reachTime", label: "E reach duration", group: G, subsection: "Hands", unit: "s", min: 0.3, max: 1.5, step: 0.05 },
  { key: "body.ladderRung", label: "Ladder rung spacing", group: G, subsection: "Hands", unit: "m", min: 0.2, max: 0.4, step: 0.01 },
]

/** Locomotion loops in the blend space. */
const LOOPS = ["idle", "walk", "jog", "sprint", "walk_back", "strafe_l", "strafe_r", "crouch_idle", "crouch_walk"] as const
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
  state: string
  /** World-space velocity of the belt (treadmill), subtracted from foot velocity in the slide meter. */
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
  private loops = {} as Record<Loop, ClipInfo>
  private actions = new Map<string, THREE.AnimationAction>()
  private torchGrip: THREE.AnimationAction | null = null
  private torch = createTorch()
  private ground: GroundQuery
  // Motion state.
  private bodyYaw = Number.NaN
  private turning = false
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

    const neck = this.bones.neck_01.getWorldPosition(v3())
    this.eyeAboveNeck = 1.655 - neck.y
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
      const speeds: number[] = []
      let best = -Infinity
      let offset = 0
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N
        const low = fl[i]!.y < fr[i]!.y ? fl : fr
        speeds.push(Math.hypot(low[j]!.x - low[i]!.x, low[j]!.z - low[i]!.z) / (dur / N))
        const d = fr[i]!.y - fl[i]!.y
        if (d > best) {
          best = d
          offset = i / N
        }
      }
      speeds.sort((a, b) => a - b)
      return { action, dur, speed: speeds[N >> 1]!, offset }
    }
    for (const l of LOOPS) this.loops[l] = measure(l)
    this.loops.idle.speed = 0
    this.loops.crouch_idle.speed = 0
    for (const a of this.actions.values()) a.enabled = false
    mixer.update(0)
    scene.updateMatrixWorld(true)
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
      if (mesh.name.includes("short02")) mesh.layers.set(HEAD_LAYER)
      else splitHead(mesh, new Set<THREE.Object3D>([this.bones.head, this.bones.neck_01]), neck)
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
    const back = this.num("body.back") + Math.max(0, -Math.sin(s.pitch)) * this.num("body.lookBack")
    this.root.position.set(s.pos.x - aimF.x * back, s.pos.y, s.pos.z - aimF.z * back)
    this.root.rotation.set(0, this.bodyYaw, 0)
    this.root.updateMatrixWorld(true)

    // ------------------------------------------------------------------ blend space
    const vf = s.vel.x * fwd.x + s.vel.z * fwd.z
    const vr = s.vel.x * right.x + s.vel.z * right.z
    const kv = damp(this.num("body.velHz"), dt)
    this.lv.x += (vr - this.lv.x) * kv
    this.lv.y += (vf - this.lv.y) * kv
    let sp = this.lv.length()
    // Turning in place: a slow shuffle on the spot.
    const shuffle = this.turning ? 0.55 : 0
    if (sp < shuffle) sp = shuffle
    const dirA = this.lv.lengthSq() > 1e-4 ? Math.atan2(this.lv.x, this.lv.y) : 0
    const wF = Math.max(0, Math.cos(dirA))
    const wB = Math.max(0, -Math.cos(dirA))
    const wR = Math.max(0, Math.sin(dirA))
    const wL = Math.max(0, -Math.sin(dirA))
    const wSum = wF + wB + wR + wL || 1
    const move = smooth01(this.num("body.moveFrom") * 0.5, this.num("body.moveFrom") + 0.35, sp)
    const walkAt = this.num("body.walkAt")
    const jogAt = this.num("body.jogAt")
    const sprintAt = this.num("body.sprintAt")
    const jogK = smooth01(walkAt, jogAt, sp)
    const sprintK = smooth01(jogAt, sprintAt, sp)
    this.crouchW += ((s.crouch > 0.5 ? 1 : 0) - this.crouchW) * damp(8, dt)
    const cw = this.crouchW
    const W: Record<Loop, number> = {
      idle: (1 - move) * (1 - cw),
      walk: move * (1 - cw) * (wF / wSum) * (1 - jogK),
      jog: move * (1 - cw) * (wF / wSum) * jogK * (1 - sprintK),
      sprint: move * (1 - cw) * (wF / wSum) * jogK * sprintK,
      walk_back: move * (1 - cw) * (wB / wSum),
      strafe_l: move * (1 - cw) * (wL / wSum),
      strafe_r: move * (1 - cw) * (wR / wSum),
      crouch_idle: (1 - move) * cw,
      crouch_walk: move * cw,
    }
    // Crouch walking any direction uses the forward clip played backwards for the back half.
    const crouchRev = cw > 0 && this.lv.y < -0.05 && Math.abs(this.lv.y) > Math.abs(this.lv.x) ? -1 : 1
    // Phase rate: the weighted cycles per second that keep each clip's planted foot at ground speed.
    let rate = 0
    let wMove = 0
    for (const l of LOOPS) {
      const c = this.loops[l]
      if (c.speed <= 0 || W[l] <= 0) continue
      rate += W[l] * (sp / (c.speed * c.dur))
      wMove += W[l]
    }
    rate = wMove > 0 ? rate / wMove : 0
    this.phase = (this.phase + rate * dt) % 1
    this.idleT += dt

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
    const ground = 1 - Math.max(this.air, this.ladder * 0.8)
    for (const l of LOOPS) {
      const c = this.loops[l]
      const w = W[l] * ground
      c.action.enabled = w > 1e-3
      c.action.setEffectiveWeight(w)
      c.action.setEffectiveTimeScale(0)
      const ph = c.speed > 0 ? this.phase : (this.idleT / c.dur) % 1
      const dir = l === "crouch_walk" ? crouchRev : 1
      c.action.time = (((dir * ph + c.offset) % 1) + 1) % 1 * c.dur
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
    this.debug.state = s.onLadder ? "ladder" : airborne ? (this.jumpT >= 0 ? "jump" : "fall") : this.turning ? "turn" : moving ? (cw > 0.5 ? "crouch-walk" : "move") : cw > 0.5 ? "crouch" : "idle"
    mixer.update(dt)
    this.model.updateMatrixWorld(true)

    // ------------------------------------------------------------------ post: spine, pelvis, feet, arms
    const b = this.bones
    // Spine twist toward the aim (the root lags while turning in place) and bend with the view pitch.
    const yawK = this.num("body.spineYaw")
    const pitchK = this.num("body.spinePitch")
    const aimRight = new THREE.Vector3(Math.cos(aimYaw), 0, -Math.sin(aimYaw))
    const spine: [THREE.Bone, number, number][] = [
      [b.spine_01, 0.25, 0.25],
      [b.spine_02, 0.35, 0.3],
      [b.spine_03, 0.4, 0.3],
    ]
    const pitch = THREE.MathUtils.clamp(s.pitch, -1.2, 1) * (1 - this.ladder)
    for (const [bone, wy, wp] of spine) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, dYaw * yawK * wy)
      q.multiply(new THREE.Quaternion().setFromAxisAngle(aimRight, pitch * pitchK * wp))
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
    for (let i = 0; i < 2; i++) {
      worldPos(feet[i], footW[i]!)
      let want = 0
      if (ikOn) {
        const g = this.ground(footW[i]!.x, footW[i]!.z, rootY + ikMax)
        want = THREE.MathUtils.clamp(g - rootY, -ikMax, ikMax)
        normals[i] = this.normalAt(footW[i]!.x, footW[i]!.z, g, rootY + ikMax)
      }
      this.footOff[i]! += (want - this.footOff[i]!) * kIK
    }
    let pelvisWant = ikOn ? Math.min(this.footOff[0]!, this.footOff[1]!, 0) : 0
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
      if (Math.abs(target.y - worldPos(foot, v3()).y) > 1e-3) twoBoneIK(thigh, calf, foot, target, ikOn ? wIK : 1, fwd, false)
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
    if (this.ladder > 0.01) this.ladderPose(fwd, right)

    // Arms: torch in the right hand, E reach with a free hand.
    this.arms(s, dt, fwd)

    // ------------------------------------------------------------------ debug: foot slide while planted
    for (let i = 0; i < 2; i++) {
      const p = worldPos([b.ball_l, b.ball_r][i]!, v3())
      const g = this.ground(p.x, p.z, rootY + 0.5)
      const planted = s.grounded && p.y - g < 0.045
      if (this.hasPrev && dt > 0) {
        const vx = (p.x - this.prevFoot[i]!.x) / dt - this.debug.belt.x
        const vz = (p.z - this.prevFoot[i]!.z) / dt - this.debug.belt.z
        const v = planted ? Math.hypot(vx, vz) : 0
        if (planted) this.debug.slide[i] = this.debug.slide[i]! + (v - this.debug.slide[i]!) * damp(6, dt)
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
      // Hand below and right of the eye, ahead along the aim (the arm's pitch eased so looking at your feet keeps the
      // fist in front of the hips), barrel along the aim.
      const pa = THREE.MathUtils.clamp(s.pitch, -0.8, 0.5)
      const armAim = new THREE.Vector3(yawFwd.x * Math.cos(pa), Math.sin(pa), yawFwd.z * Math.cos(pa))
      const target = eye.clone().addScaledVector(yawRight, this.num("body.torchRight")).addScaledVector(armAim, this.num("body.torchFwd"))
      target.y -= this.num("body.torchDown")
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

  private ladderPose(fwd: THREE.Vector3, right: THREE.Vector3) {
    const b = this.bones
    const rung = this.num("body.ladderRung")
    const w = this.ladder
    const base = this.root.position
    // The ladder is in front: hands on rungs at shoulder height and above, feet on rungs below the hips.
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1
      const ph = this.ladderPhase + i * 0.5
      const u = ((ph % 1) + 1) % 1
      // Each limb holds a rung (u < 0.5), then moves up two rungs (u ≥ 0.5).
      const lift = u < 0.5 ? 0 : THREE.MathUtils.smoothstep(u, 0.5, 1)
      const hold = Math.floor(ph) * 2 * rung
      const handY = base.y + 1.45 + ((hold + lift * 2 * rung) % (2 * rung)) - rung * 0.5
      const footY = base.y + 0.25 + ((hold + rung + lift * 2 * rung) % (2 * rung)) - rung * 0.5
      const out = Math.sin(Math.PI * lift) * 0.08
      const hand = base.clone().addScaledVector(fwd, 0.36 - out).addScaledVector(right, side * 0.2)
      hand.y = handY
      const foot = base.clone().addScaledVector(fwd, 0.16 - out).addScaledVector(right, side * 0.13)
      foot.y = footY + out
      const sfx = i === 0 ? "l" : "r"
      twoBoneIK(b[`upperarm_${sfx}`], b[`lowerarm_${sfx}`], b[`hand_${sfx}`], hand, w, new THREE.Vector3(0, -1, 0).addScaledVector(right, side))
      twoBoneIK(b[`thigh_${sfx}`], b[`calf_${sfx}`], b[`foot_${sfx}`], foot, w, fwd, false)
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
 * Moves the head/neck triangles (and the collar right under the eyes) of a skinned mesh into their own mesh on
 * HEAD_LAYER, sharing the geometry buffers and the skeleton.
 */
function splitHead(mesh: THREE.SkinnedMesh, headBones: Set<THREE.Object3D>, neck: THREE.Vector3) {
  const geo = mesh.geometry
  const index = geo.index
  const joints = geo.getAttribute("skinIndex")
  const weights = geo.getAttribute("skinWeight")
  if (!index || !joints || !weights) return
  const headJoint = new Set<number>()
  mesh.skeleton.bones.forEach((b, i) => headBones.has(b) && headJoint.add(i))
  const isHead = new Uint8Array(joints.count)
  const pos = geo.getAttribute("position")
  const p = new THREE.Vector3()
  // Bind-pose metres in the model's own frame (before the root's turn).
  const toModel = mesh.parent ? new THREE.Matrix4().copy(mesh.parent.matrixWorld).invert().multiply(mesh.matrixWorld) : new THREE.Matrix4()
  const neckModel = neck.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.parent!.matrixWorld).invert())
  for (let i = 0; i < joints.count; i++) {
    let w = 0
    for (let k = 0; k < 4; k++) if (headJoint.has(joints.getComponent(i, k))) w += weights.getComponent(i, k)
    p.fromBufferAttribute(pos, i).applyMatrix4(toModel)
    const collar = (p.y > neckModel.y - 0.06 && Math.hypot(p.x - neckModel.x, p.z - neckModel.z) < 0.13) || p.y > neckModel.y + 0.02
    isHead[i] = w > 0.5 || collar ? 1 : 0
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
