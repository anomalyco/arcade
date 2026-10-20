import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import ROSTER from "./roster.json"
import { createTorch } from "./torch"
import { Viewmodel, VIEW_LAYER } from "./viewmodel"
import { SeatRig, type SeatHost, type SeatOptions } from "./seat"
import { cylDist as cylDistX, measureHands, skinVsCyl, wrapFingers, type Cyl, type HandSkin } from "./grip"

/**
 * Albedo scale for the body while it sits inside the car: the cabin's roof and pillars occlude the many unshadowed
 * clustered lamps (only a couple of lamps have shadow maps), which otherwise light the driver's hands and arms as if
 * they stood in the open. 1 = outside.
 */
const cabinShade = { value: 1 }
const shadedMats: THREE.MeshStandardNodeMaterial[] = []
function applyCabinShade() {
  for (const m of shadedMats) m.color.copy(m.userData.baseColor as THREE.Color).multiplyScalar(cabinShade.value)
}
const CABIN_SHADE = 0.3

// The player's body: one of the roster characters (public/models/characters/<id>.glb), all re-bound offline to one
// shared skeleton, so the shared clips (anims.glb, Mixamo motion capture) play on any of them unmodified; only the
// Hips translation is scaled to the character's hip height. Built by scripts/playerb/characters.ts.
//
// Runtime: one AnimationMixer, clip times set directly each frame (no mixer clock).
//   - Locomotion: walk / jog / run gaits, each a circle of direction clips (fwd, back, left, right) blended by the
//     local travel direction; gaits blend by speed. All loops share one distance-driven phase (a stride per cycle at
//     each clip's measured ground speed), so playback is speed-matched and feet don't skate. Crouch has its own circle.
//   - Idle with turn-in-place (90° clips, their extracted root yaw drives the body's facing).
//   - Stairs up/down while the feet climb (the clips are in place; the controller provides the height), ladder climb
//     phase-locked to the climbed height, the climb onto the top scrubbed by height, jump scrubbed by vertical
//     velocity, falling.
//   - Upper-body layers sampled after the mixer (bone masks): E presses a button or reaches for a door handle with the
//     right arm; the flashlight is carried in the left fist, the arm placed by IK along the view. Spine, neck and
//     head share the view's pitch and its yaw away from the feet, so shadows and mirrors look where you look.
// The only other procedural correction is a small smoothed pelvis height offset onto the planted foot's ground.
//
// Rendering: everything is on BODY_LAYER; the head, neck, hair, eyes and hat on HEAD_LAYER, which the first-person
// camera leaves out (shadow maps and mirrors include it), so there is no head in your face but your silhouette has one.

export const BODY_LAYER = 3
export const HEAD_LAYER = 4

/** The PlayerState fields the body reads (src/player.ts PlayerState is a superset). */
export type BodyState = {
  readonly pos: { x: number; y: number; z: number }
  readonly vel: { x: number; y: number; z: number }
  readonly yaw: number
  readonly pitch: number
  readonly crouch: number
  readonly grounded: boolean
  readonly onLadder: boolean
  readonly flashlight: boolean
  /** The camera (first person); E aims the hand at the crosshair from here. */
  readonly eye?: { x: number; y: number; z: number }
  /**
   * A mantle in progress (src/player.ts): t 0..1, the feet's start and end, the ledge height above the start, whether
   * it ends crouched; `face` (optional) is where the feet stop short of the ledge face.
   */
  readonly mantle?: {
    t: number
    duration: number
    height: number
    from: readonly [number, number, number]
    to: readonly [number, number, number]
    crouch: boolean
    face?: readonly [number, number, number]
  } | null
  /** The ladder's rung plane (normal towards the climber, normal·p = plane) while climbing. */
  readonly ladder?: { normal: readonly [number, number, number]; plane: number } | null
}

export type GroundFn = (x: number, z: number, maxY: number) => number
/** Top (the arrival floor height) of the ladder at a point, or null. */
export type LadderTopFn = (x: number, y: number, z: number) => number | null

export type BodyOptions = {
  character: string
  ground: GroundFn
  ladderTop?: LadderTopFn
  base?: string
  /** Compiles a new character's pipelines before it replaces the current one (no hitch on a switch). */
  compile?: (root: THREE.Object3D) => Promise<unknown>
}

export type Interaction = "button" | "door"

type ClipMeta = {
  ledge?: number
  kind: string
  duration: number
  velocity?: number[]
  speed?: number
  rise?: number
  takeoff?: number
  land?: number
  root?: number[][]
  yawTotal?: number
}
type CharMeta = { id: string; name: string; height: number; hips: number; hipRatio: number; head: number }
const META = ROSTER as unknown as { characters: Record<string, CharMeta>; anims: { refHips: number; fps: number; clips: Record<string, ClipMeta> } }

export const CHARACTERS = Object.values(META.characters)
  .map((c) => ({ id: c.id, name: c.name }))
  .sort((a, b) => a.name.localeCompare(b.name))

/** The picked character, shared by the game and bodyb.html (localStorage). */
const CHARACTER_KEY = "afterhours.character"
export const DEFAULT_CHARACTER = META.characters.remy ? "remy" : CHARACTERS[0]!.id
export function savedCharacter() {
  try {
    const id = localStorage.getItem(CHARACTER_KEY)
    if (id && META.characters[id]) return id
  } catch {}
  return DEFAULT_CHARACTER
}
export function saveCharacter(id: string) {
  try {
    localStorage.setItem(CHARACTER_KEY, id)
  } catch {}
}

/** Ground speeds (m/s) of the locomotion clips for a character, for the controller's walk/jog/run/crouch speeds. */
export function clipSpeeds(id: string) {
  const c = META.characters[id]!
  const k = c.hips / META.anims.refHips
  const out: Record<string, number> = {}
  for (const [n, m] of Object.entries(META.anims.clips)) if (m.speed && m.kind === "loop") out[n] = +(m.speed * k).toFixed(3)
  for (const [n, m] of Object.entries(META.anims.clips)) if (m.kind === "climb") out[`${n} (rise)`] = +((m.rise ?? 0) * k).toFixed(3)
  return out
}

const GAITS = {
  walk: ["walking", "walking-backwards", "left-strafe-walking", "right-strafe-walking"],
  jog: ["jog-forward", "jog-backward", "jog-strafe-left", "jog-strafe-right"],
  run: ["running"],
  // crouched-walking (1.29 m/s) matches the other crouch directions (1.13–1.32 m/s); crouch-walk-forward is 1.63 m/s.
  crouch: ["crouched-walking", "crouch-walk-back", "crouch-walk-left", "crouch-walk-right"],
}
const IDLE = "breathing-idle"
/** The crouch idle that matches the crouch walks (crouching-idle is a deep squat, its eyes at ~0.8 m). */
const CROUCH_IDLE = "crouch-idle"
const TORCH_ARM = /^Left(Shoulder|Arm|ForeArm|Hand)/
/** The jump clip flings the arms out sideways; in the air they are pulled most of the way to the idle's. */
/** Mantle clips, by the ledge height they're picked for (see mantleWeights). */
const MANTLES = ["mantle-step-up", "mantle-run-jump-high", "mantle-hang-to-crouch"]
/** Share of the mantle's camera taken by the body's eyes (the rest stays on the controller's eye path). */
const MANTLE_VIEW = 0.85
const CALM_ARMS = /^(Left|Right)(Shoulder|Arm|ForeArm)$/
const ARM_CALM = 0.9
/** Flashlight carry: the hand's aim stays within ±AIM_YAW of the body's facing; aim and joints turn at most this fast. */
const AIM_YAW = (70 * Math.PI) / 180
/** The body's yaw rate limit (rad/s). */
const FACING_RATE = 11
/** Most the view may lead the body's front (rad): past it the body is carried round with the view at once. */
const BODY_LEAD = (25 * Math.PI) / 180
/** Flashlight grip: the palm faces inward (GRIP_IN) and down (GRIP_DOWN), around the barrel. */
const GRIP_IN = 0.75
const GRIP_DOWN = 0.65
/** The body catches the view up to BODY_LEAD at this rate (rad/s): fast, but a 150° gap after a mantle is a turn. */
const LEAD_RATE = 22
/** Torch hand IK target limits (body frame): wrist speed (m/s) and fist turn rate (rad/s). */
const WRIST_SPEED = 4
const HAND_RATE = 30
/** The chest and head's turn towards the view, max rate (rad/s). */
const LOOK_RATE = 7
const TWIST_MAX = (85 * Math.PI) / 180
/** Arm joints may turn at most this fast (rad/s, local): a hand flip becomes a quick turn instead of a pop. */
const ARM_RATE = 40
const ARM_BONES = ["LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "RightShoulder", "RightArm", "RightForeArm", "RightHand"]
/** The flashlight carry clips (Mixamo Torch series, left hand) and the locomotion state each one stands for. */
const CARRY_CLIPS: [string, string][] = [
  ["carry-idle", "idle"],
  ["carry-walk-forward", "fwd"],
  ["carry-walk-back", "back"],
  ["carry-walk-left", "left"],
  ["carry-walk-right", "right"],
  ["carry-run-forward", "run"],
  ["carry-crouch-idle", "cidle"],
  ["carry-crouch-walk-forward", "cwalk"],
]
const CARRY_ARM = /^Left(Shoulder|Arm|ForeArm|Hand)/
/** The old hand-built IK carry (kept for reference; off). */
const CARRY_IK = false
/** Aim correction on the carried flashlight (wrist + forearm), at most this (rad). */
const CARRY_AIM = (25 * Math.PI) / 180
/** First-person nudge of the carrying hand (m): towards the body's centre line and down. */
const CARRY_IN = 0.15
const CARRY_DOWN = 0.03
/** The barrel's droop below level in the carry grip (rad). */
const CARRY_TILT = (12 * Math.PI) / 180
/** First-person grip spot from the eye, in the view's frame (m): ahead, below, left. */
const FP_GRIP = [0.4, 0.2, 0.16] as const
/** Wrist limits for the carried flashlight (rad): flexion, deviation, twist kept in the hand; barrel-off tolerance. */
const WRIST_FLEX = (35 * Math.PI) / 180
const WRIST_DEV = (15 * Math.PI) / 180
const WRIST_TWIST = (20 * Math.PI) / 180
const FP_AIM_TOL = (10 * Math.PI) / 180
const TORCH_DEV = 0
/** The old full-body first-person arm solve (replaced by the viewmodel, viewmodel.ts). */
const FP_ARM_SOLVE = false
const TORCH_FLEX = 0
/** How far the fist may roll about the barrel from its knuckles-up grip (rad). */
const FP_ROLL_MAX = (70 * Math.PI) / 180
const FP_ROLL_RATE = 3
/** The flashlight barrel's radius at the grip (torch.ts knurl: 17.2 mm), and the palm's touch distance (m). */
const BARREL_R = 0.0172
const PALM_TOUCH = 0.0008
/** Torch +Y (barrel axis → palm) in the view frame: right, up. */
const FP_ROLL = [0.6, -0.8]
const FINGERS = /^LeftHand(Thumb|Index|Middle|Ring|Pinky)/
const REACH_ARM = /^Right(Shoulder|Arm|ForeArm|Hand)/
/** E: the part of each clip that is the reach (clip seconds) and its playback rate. */
const INTERACT: Record<Interaction, { clip: string; t0: number; t1: number; rate: number }> = {
  button: { clip: "button-pushing", t0: 0.75, t1: 2.45, rate: 1.35 },
  door: { clip: "opening-door-inwards", t0: 0.45, t1: 2.6, rate: 1.5 },
}
/** Share of the view's pitch / of its yaw away from the feet taken by each bone (spine to head). */
const LOOK: [string, number, number][] = [
  ["Spine", 0.03, 0.15],
  ["Spine1", 0.05, 0.15],
  ["Spine2", 0.08, 0.2],
  ["Neck", 0.33, 0.22],
  ["Head", 0.4, 0.28],
]
/** Bones whose triangles move to the head mesh (HEAD_LAYER), and whole meshes that go there by name. */
const HEAD_BONES = /^(Head|Neck|HeadTop_End|LeftEye|RightEye)$/
const HEAD_MESHES = /hair|lash|eye|hat|cap|beanie|helmet|glasses/i

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt)
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

type Loop = { name: string; action: THREE.AnimationAction; duration: number; speed: number; dir: number; offset: number; w: number }
type Gait = { name: string; loops: Loop[] }

let animsPromise: Promise<THREE.AnimationClip[]> | null = null
const loader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)

type Sampler = { bone: THREE.Bone; interp: THREE.Interpolant }
const interpOf = (k: THREE.KeyframeTrack) => (k as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant()

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _qa = new THREE.Quaternion()
const _left = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _v4 = new THREE.Vector3()
const _v5 = new THREE.Vector3()
const _v6 = new THREE.Vector3()
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _qb = new THREE.Quaternion()
const _qc = new THREE.Quaternion()
const _qd = new THREE.Quaternion()
const _qe = new THREE.Quaternion()
const UP = new THREE.Vector3(0, 1, 0)

export class CharacterBody {
  readonly root = new THREE.Group()
  model: THREE.Object3D | null = null
  character = ""
  ready: Promise<void>
  readonly torch = createTorch()
  readonly debug = {
    state: "idle",
    phase: 0,
    weights: {} as Record<string, number>,
    pelvis: 0,
    clips: {} as Record<string, { speed: number; dir: number; duration: number; offset: number }>,
    slide: [0, 0],
    planted: [false, false],
    eye: 0,
  }
  /** First person: keep the eyes over the camera (the view camera leaves HEAD_LAYER out). */
  eyeAnchor = false
  /**
   * First person: the eyes' distance ahead of the Head bone (the top of the neck), and how far the head leans forward
   * looking straight down (the body moves back under the fixed camera by less), so the chest, hands and toes come
   * into view the way they do when you look down.
   */
  eyeAhead = 0.09
  lookDownLean = 0
  /** Extra distance the neck sits behind the camera looking nearly straight down, so the collar stays out of view. */
  steepBack = 0.16
  /** Spine/neck/head follow the view (0..1). */
  look = 1

  private opts: BodyOptions
  private base: string
  private mixer: THREE.AnimationMixer | null = null
  private bones: Record<string, THREE.Bone> = {}
  private loops = new Map<string, Loop>()
  private shots = new Map<string, THREE.AnimationAction>()
  private gaits: Record<string, Gait> = {}
  private clips = new Map<string, THREE.AnimationClip>()
  private k = 1
  private phase = 0
  private gaitW = { walk: 1, jog: 0, run: 0 }
  private smoothVel = new THREE.Vector2()
  private rootY = Number.NaN
  private facing = 0
  private turn: { clip: string; t: number; from: number; sign: number; scale: number } | null = null
  private air = 0
  private airT = 0
  private landT = 9
  private wasGrounded = true
  private stairW = 0
  private stairDir = 0
  private stairPhase = 0
  private mantleWarp = new Map<string, { ys: number[]; L: number; t0: number; tTop: number; dur: number; fps: number }>()
  /** Share of the mantle clips in the pose, and of the hands on the ledge. */
  private mantleW = 0
  /** Hands on a ledge (0..1): the game tips the view down to them (src/playerb/game.ts). */
  mantleHandsW = 0
  private wasMantle = false
  private topW = 0
  /** Share of the jump / fall clips in the pose (their arms are toned down towards the idle's). */
  private airW = 0
  private armSamplers: Sampler[] = []
  /** First person: where the camera should be when the body, not the controller, places the head (ladders). */
  readonly view = { weight: 0, eye: new THREE.Vector3() }
  private ladderT = 0
  private ladderW = 0
  private ladderGap = 0.35
  private top = { rise: [] as number[], times: [] as number[], total: 0, f0: 0, fEnd: 0, tEnd: 0 }
  /** The climb onto the top: scrubbed by height while on the rungs, then played out after the step off. */
  private topT = -1
  private topOut = -1
  private yOff = 0
  private idleT = 0
  private act: { kind: Interaction; t: number } | null = null
  private reachAt: THREE.Vector3 | null = null
  private reachGoal = new THREE.Vector3()
  private reach: Record<Interaction, Sampler[]> = { button: [], door: [] }
  private carryW = 0
  private torchSamplers: { bone: THREE.Bone; idle: THREE.Interpolant; walk: THREE.Interpolant }[] = []
  private eyeOff = new THREE.Vector2()
  private lastFoot = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  private hasLastFoot = false
  private restFoot = [0.1, 0.03]
  private pose: { clip: string; phase: number } | null = null
  private lastY = Number.NaN
  private dy = 0
  private vy = 0
  private torchIdleT = 0
  private bindQ = new Map<THREE.Bone, THREE.Quaternion>()
  private loadSeq = 0
  private seatRig: SeatRig | null = null
  private seatAction: THREE.AnimationAction | null = null
  /** False while the torch hand is busy (a mantle): the beam then follows the view (lighting.ts fallback). */
  private torchHeld = true
  /** Measured eye heights above the feet (m): standing idle, crouch idle, crouch walk. */
  eyes = { stand: 1.62, crouch: 1.15, crouchWalk: 1.25 }

  constructor(opts: BodyOptions) {
    this.opts = opts
    this.base = opts.base ?? `${import.meta.env.BASE_URL}models/characters/`
    this.root.name = "player-body"
    this.torch.traverse((o) => o.layers.set(BODY_LAYER))
    this.ready = this.load(opts.character)
  }

  /** Switch to another roster character (keeps state; resolves when the new model is in). */
  setCharacter(id: string) {
    if (id === this.character && this.model) return this.ready
    this.ready = this.load(id)
    return this.ready
  }

  private async load(id: string) {
    const meta = META.characters[id]
    if (!meta) throw new Error(`unknown character ${id}`)
    const seq = ++this.loadSeq
    animsPromise ??= loader()
      .loadAsync(`${this.base}anims.glb`)
      .then((g) => g.animations)
    const [gltf, anims] = await Promise.all([loader().loadAsync(`${this.base}${id}.glb`), animsPromise])
    if (seq !== this.loadSeq) return
    const model = gltf.scene
    this.prepare(model, meta)
    if (this.opts.compile) {
      // The torch too, so the first F doesn't compile it.
      const torchVis = this.torch.visible
      const torchParent = this.torch.parent
      model.add(this.torch)
      this.torch.visible = true
      await this.opts.compile(model).catch((e: unknown) => console.warn("body compile:", e))
      this.torch.visible = torchVis
      if (torchParent) torchParent.add(this.torch)
      else model.remove(this.torch)
    }
    if (seq !== this.loadSeq) return
    if (this.model) {
      this.root.remove(this.model)
      this.mixer?.stopAllAction()
      this.mixer?.uncacheRoot(this.model)
    }
    this.character = id
    this.init(model, anims, meta)
  }

  /** Materials, shadows, layers and the head split, on the model at its own origin. */
  private prepare(model: THREE.Object3D, meta: CharMeta) {
    model.updateMatrixWorld(true)
    const split: THREE.SkinnedMesh[] = []
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = true
      m.frustumCulled = false
      m.material = nodeMaterial(m.material as THREE.MeshStandardMaterial)
      m.layers.set(HEAD_MESHES.test(m.name) ? HEAD_LAYER : BODY_LAYER)
      if (m.isSkinnedMesh && !HEAD_MESHES.test(m.name)) split.push(m)
    })
    for (const m of split) splitHead(m, meta.head - 0.16)
    // The left forearm and hand in their own meshes: hidden from the view camera while the viewmodel shows.
    this.armParts = []
    this.vmActive = false
    this.armsHidden = false
    for (const m of split) {
      const a = splitArm(m, /^Left(Arm|ForeArm|Hand)/)
      if (a) this.armParts.push(a)
      // The right forearm and hand too: in first person no hand is ever seen (owner decision), even looking down.
      const r = splitArm(m, /^Right(Arm|ForeArm|Hand)/)
      if (r) this.armParts.push(r)
    }
  }

  private init(model: THREE.Object3D, anims: THREE.AnimationClip[], meta: CharMeta) {
    this.model = model
    this.bones = {}
    this.loops.clear()
    this.shots.clear()
    this.clips.clear()
    this.hasLastFoot = false
    this.act = null
    this.topT = this.topOut = -1
    this.k = meta.hips / META.anims.refHips
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones[o.name] = o as THREE.Bone
    })
    this.root.add(model)
    this.bindQ = new Map(Object.values(this.bones).map((b) => [b, b.quaternion.clone()]))
    this.atOrigin(() => {
      this.restFoot = [this.bones.LeftFoot!.getWorldPosition(_v).y, this.bones.LeftToeBase!.getWorldPosition(_v).y]
    })

    // Clips for this character: rotations as they are; only the Hips keep a translation, scaled to its hips.
    const mixer = new THREE.AnimationMixer(model)
    this.mixer = mixer
    for (const src of anims) {
      const tracks: THREE.KeyframeTrack[] = []
      for (const t of src.tracks) {
        const [node, prop] = t.name.split(".") as [string, string]
        if (!this.bones[node]) continue
        if (prop === "quaternion") tracks.push(t)
        else if (prop === "position" && node === "Hips") {
          const c = t.clone()
          for (let i = 0; i < c.values.length; i++) c.values[i]! *= meta.hipRatio
          tracks.push(c)
        }
      }
      const clip = new THREE.AnimationClip(src.name, src.duration, tracks)
      this.clips.set(src.name, clip)
    }
    const act = (name: string) => {
      const a = mixer.clipAction(this.clips.get(name)!)
      a.play()
      a.timeScale = 0
      a.setEffectiveWeight(0)
      return a
    }
    for (const [g, names] of Object.entries(GAITS)) {
      const loops: Loop[] = []
      for (const n of names) {
        const m = META.anims.clips[n]
        if (!m || !this.clips.has(n)) continue
        const action = act(n)
        const g = this.groundVelocity(action, m.duration)
        const l: Loop = { name: n, action, duration: m.duration, speed: Math.hypot(g.x, g.y), dir: Math.atan2(g.x, g.y), offset: 0, w: 0 }
        l.offset = this.leftContact(action, l.duration)
        loops.push(l)
        this.loops.set(n, l)
        this.debug.clips[n] = { speed: +l.speed.toFixed(3), dir: +((l.dir * 180) / Math.PI).toFixed(0), duration: +l.duration.toFixed(3), offset: +(l.offset / l.duration).toFixed(3) }
      }
      this.gaits[g] = { name: g, loops }
    }
    this.prepLadder()
    this.eyes = { stand: this.eyeY(IDLE), crouch: this.eyeY(CROUCH_IDLE), crouchWalk: this.eyeY("crouched-walking") }
    for (const n of [IDLE, CROUCH_IDLE, "ascending-stairs", "descending-stairs", "descending-stairs-run", "climbing-ladder", "falling-idle"]) {
      if (!this.clips.has(n)) continue
      const m = META.anims.clips[n]!
      const l: Loop = { name: n, action: act(n), duration: m.duration, speed: (m.speed ?? 0) * this.k, dir: 0, offset: 0, w: 0 }
      this.loops.set(n, l)
    }
    for (const n of ["jump", "left-turn-90", "right-turn-90", "climbing-to-top", ...MANTLES]) if (this.clips.has(n)) this.shots.set(n, act(n))
    this.mantleWarp = new Map()
    for (const n of MANTLES) {
      const m = META.anims.clips[n]
      if (!m?.root || !this.clips.has(n)) continue
      const ys = m.root.map((r) => r[3] ?? 0)
      const L = m.ledge ?? ys[ys.length - 1]!
      const fps = META.anims.fps
      let f0 = 0
      for (let f = 0; f < ys.length; f++) if (ys[f]! < 0.02 * L) f0 = f
      let fTop = ys.findIndex((y) => y >= 0.98 * L)
      if (fTop < 0) fTop = ys.length - 1
      this.mantleWarp.set(n, { ys, L, t0: f0 / fps, tTop: fTop / fps, dur: m.duration, fps })
    }

    // Upper-body layers: tracks sampled directly and applied after the mixer (bone masks).
    for (const kind of Object.keys(INTERACT) as Interaction[]) {
      const clip = this.clips.get(INTERACT[kind].clip)
      this.reach[kind] = clip ? this.samplers(clip, REACH_ARM) : []
    }
    const idleClip = this.clips.get(IDLE)
    this.armSamplers = idleClip ? this.samplers(idleClip, CALM_ARMS) : []
    this.torchSamplers = []
    const ti = this.clips.get("torch-idle")
    const tw = this.clips.get("torch-walk-forward")
    if (ti && tw) {
      for (const s of this.samplers(ti, TORCH_ARM)) {
        const w = tw.tracks.find((x) => x.name === `${s.bone.name}.quaternion`)
        if (w) this.torchSamplers.push({ bone: s.bone, idle: s.interp, walk: interpOf(w) })
      }
    }
    // The carry layer: Mixamo's Torch series (left hand), left shoulder → fingertips, one per locomotion state.
    this.carry2 = []
    for (const [name, role] of CARRY_CLIPS) {
      const clip = this.clips.get(name)
      if (!clip) continue
      const m = META.anims.clips[name]
      const offset = m?.kind === "loop" ? this.leftContact(mixer.clipAction(clip), clip.duration) : 0
      this.carry2.push({ name, role, clip, offset, samplers: this.samplers(clip, CARRY_ARM), w: 0 })
    }
    if (this.carry2.length || (ti && tw)) this.placeTorch()
    this.viewmodel.build({ model, carry: this.clips.get("carry-idle") ?? null, torchPos: this.torchPosBase.clone(), torchQuat: this.torchBase.clone(), ik: twoBoneIK })
    mixer.update(0)
  }

  private samplers(clip: THREE.AnimationClip, mask: RegExp): Sampler[] {
    const out: Sampler[] = []
    for (const t of clip.tracks) {
      const [node, prop] = t.name.split(".") as [string, string]
      if (prop === "quaternion" && mask.test(node) && this.bones[node]) out.push({ bone: this.bones[node]!, interp: interpOf(t) })
    }
    return out
  }

  /** Runs `fn` with the body root at the origin, unrotated (model space = world space), then restores it. */
  private atOrigin<T>(fn: () => T): T {
    const p = this.root.position.clone()
    const q = this.root.quaternion.clone()
    this.root.position.set(0, 0, 0)
    this.root.quaternion.identity()
    this.root.updateMatrixWorld(true)
    try {
      return fn()
    } finally {
      this.root.position.copy(p)
      this.root.quaternion.copy(q)
      this.root.updateMatrixWorld(true)
    }
  }

  /** Model-space joint positions over a clip (n samples), with every other action at weight 0. */
  private sample(clip: THREE.AnimationClip, n: number, joints: string[]) {
    const mixer = this.mixer!
    return this.atOrigin(() => {
      const actions = [...this.loops.values()].map((l) => l.action).concat([...this.shots.values()])
      const saved = actions.map((a) => a.getEffectiveWeight())
      for (const a of actions) a.setEffectiveWeight(0)
      const a = mixer.clipAction(clip)
      const scheduled = a.isScheduled()
      a.play()
      a.setEffectiveWeight(1)
      const out: Record<string, THREE.Vector3[]> = {}
      for (const j of joints) out[j] = []
      for (let i = 0; i < n; i++) {
        a.time = (i / n) * clip.duration
        mixer.update(0)
        this.model!.updateMatrixWorld(true)
        for (const j of joints) out[j]!.push(this.bones[j]!.getWorldPosition(new THREE.Vector3()))
      }
      a.setEffectiveWeight(0)
      if (!scheduled) a.stop()
      actions.forEach((x, i) => x.setEffectiveWeight(saved[i]!))
      return out
    })
  }

  /**
   * Ladder clips. The climb loop is recentred (its Hips carry an offset from the source file): the lower foot's mean
   * height to the feet, the hips over the feet; its hands' mean reach sets how far the body stands off the rungs. The
   * climb onto the top keeps its rise, measured as a function of time so it can be scrubbed by the climbed height.
   */
  private prepLadder() {
    const FEET = ["LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase"]
    const low = (s: Record<string, THREE.Vector3[]>, i: number) => Math.min(...FEET.map((f) => s[f]![i]!.y))
    const climb = this.clips.get("climbing-ladder")
    if (climb) {
      const N = 24
      const reach = (s: Record<string, THREE.Vector3[]>) => {
        let fy = 0
        let hx = 0
        let hz = 0
        let z = 0
        for (let i = 0; i < N; i++) {
          fy += low(s, i)
          hx += s.Hips![i]!.x
          hz += s.Hips![i]!.z
          z += (s.LeftHand![i]!.z + s.RightHand![i]!.z + s.LeftFoot![i]!.z + s.RightFoot![i]!.z) / 4
        }
        return { fy: fy / N, hx: hx / N, hz: hz / N, z: z / N - hz / N }
      }
      const joints = [...FEET, "LeftHand", "RightHand", "Hips"]
      let r = reach(this.sample(climb, N, joints))
      const track = climb.tracks.find((t) => t.name === "Hips.position")
      if (r.z < 0) {
        // Rungs behind the hips: the source faces -Z. Turn the clip round (a half turn of the Hips about up).
        const half = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI)
        // (Quaternion tracks are shared by every character's clips: turn a copy.)
        const qi = climb.tracks.findIndex((t) => t.name === "Hips.quaternion")
        const hq = qi >= 0 ? climb.tracks[qi]!.clone() : null
        if (hq) climb.tracks[qi] = hq
        if (hq) for (let i = 0; i < hq.values.length; i += 4) {
          _q.fromArray(hq.values, i).premultiply(half).toArray(hq.values, i)
        }
        if (track) for (let i = 0; i < track.values.length; i += 3) {
          track.values[i] = -track.values[i]!
          track.values[i + 2] = -track.values[i + 2]!
        }
        this.mixer!.uncacheAction(climb)
        r = reach(this.sample(climb, N, joints))
      }
      if (track) for (let i = 0; i < track.values.length; i += 3) {
        track.values[i]! -= r.hx
        track.values[i + 1]! -= r.fy
        track.values[i + 2]! -= r.hz
      }
      this.ladderGap = THREE.MathUtils.clamp(r.z, 0.2, 0.6)
      this.mixer!.uncacheAction(climb)
    }
    const top = this.clips.get("climbing-to-top")
    const track = top?.tracks.find((t) => t.name === "Hips.position")
    if (top && track) {
      const y0 = track.values[1]!
      const rise: number[] = []
      let m = 0
      for (let i = 0; i < track.times.length; i++) rise.push((m = Math.max(m, track.values[i * 3 + 1]! - y0)))
      const total = rise[rise.length - 1]!
      const iEnd = rise.findIndex((r) => r >= total - 0.01)
      const n = 40
      const s = this.sample(top, n, FEET)
      this.top = { rise, times: Array.from(track.times), total, f0: low(s, 0), fEnd: low(s, n - 1), tEnd: track.times[iEnd]! }
    }
  }

  /** Eye height above the feet in a clip's first frame: the Head bone plus the eyes' rise above it (~7 cm). */
  private eyeY(name: string) {
    const clip = this.clips.get(name)
    if (!clip) return 0
    return +(this.sample(clip, 1, ["Head"]).Head![0]!.y + 0.072).toFixed(3)
  }

  /** Clip time of the climb onto the top at which its hips have risen `r` metres (and the rise there). */
  private topAt(r: number) {
    const { rise, times } = this.top
    let i = 0
    while (i < rise.length - 1 && rise[i + 1]! < r) i++
    const j = Math.min(rise.length - 1, i + 1)
    const span = rise[j]! - rise[i]!
    const f = span > 1e-6 ? THREE.MathUtils.clamp((r - rise[i]!) / span, 0, 1) : 0
    return times[i]! + (times[j]! - times[i]!) * f
  }

  private riseAt(t: number) {
    const { rise, times } = this.top
    let i = 0
    while (i < times.length - 1 && times[i + 1]! < t) i++
    const j = Math.min(times.length - 1, i + 1)
    const span = times[j]! - times[i]!
    const f = span > 1e-6 ? THREE.MathUtils.clamp((t - times[i]!) / span, 0, 1) : 0
    return rise[i]! + (rise[j]! - rise[i]!) * f
  }

  /**
   * Ground velocity of an in-place loop on this skeleton: minus the planted contact point's velocity (heel or ball,
   * whichever is lower, while within 1.2 cm of the foot's lowest). x = rightward, y = forward (m/s).
   */
  private groundVelocity(action: THREE.AnimationAction, duration: number) {
    const N = 60
    const dt = duration / N
    const s = this.sample(action.getClip(), N, ["LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"])
    const vx: number[] = []
    const vz: number[] = []
    for (const [F, T] of [
      [s.LeftFoot!, s.LeftToeBase!],
      [s.RightFoot!, s.RightToeBase!],
    ] as const) {
      const h = F.map((f, i) => Math.min(f.y, T[i]!.y))
      const lo = Math.min(...h)
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N
        if (h[i]! > lo + 0.012 || h[j]! > lo + 0.012) continue
        const [a, b] = F[i]!.y < T[i]!.y ? [F[i]!, F[j]!] : [T[i]!, T[j]!]
        vx.push((b.x - a.x) / dt)
        vz.push((b.z - a.z) / dt)
      }
    }
    const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1]! : 0)
    // Model space: +Z forward, +X the character's left.
    return { x: med(vx), y: -med(vz) }
  }

  /** Clip time of the left foot's mid-stance (its lowest point relative to the right foot): the shared phase 0. */
  private leftContact(action: THREE.AnimationAction, duration: number) {
    const N = 48
    const s = this.sample(action.getClip(), N, ["LeftFoot", "RightFoot"])
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < N; i++) {
      const d = s.LeftFoot![i]!.y - s.RightFoot![i]!.y
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return (best / N) * duration
  }

  /**
   * The torch in the left fist (torch clips' grip): the barrel axis runs through the curled fingers' proximal
   * segments (index side = lens), its centre a little toward the palm from them.
   */
  private placeTorch() {
    const mixer = this.mixer!
    const a = mixer.clipAction(this.clips.get(this.clips.has("carry-idle") ? "carry-idle" : "torch-idle")!)
    this.atOrigin(() => {
      a.play()
      a.setEffectiveWeight(1)
      a.time = 0
      mixer.update(0)
      this.model!.updateMatrixWorld(true)
      const P = (n: string) => this.bones[n]!.getWorldPosition(new THREE.Vector3())
      const mid = (f: string) => P(`LeftHand${f}1`).lerp(P(`LeftHand${f}2`), 0.5)
      const idx = mid("Index")
      const pky = mid("Pinky")
      const centre = idx.clone().add(mid("Middle")).add(mid("Ring")).add(pky).multiplyScalar(0.25)
      const axis = idx.clone().sub(pky).normalize()
      const toPalm = P("LeftHand").sub(centre)
      toPalm.addScaledVector(axis, -toPalm.dot(axis)).normalize()
      centre.addScaledVector(toPalm, 0.012).addScaledVector(axis, 0.01)
      // Torch local: -Z = lens; build a basis with -Z along the axis.
      const z = axis.clone().negate()
      const x = new THREE.Vector3().crossVectors(toPalm, z).normalize()
      const y = new THREE.Vector3().crossVectors(z, x)
      const M = new THREE.Matrix4().makeBasis(x, y, z).setPosition(centre)
      const hand = this.bones.LeftHand!
      M.premultiply(hand.matrixWorld.clone().invert())
      M.decompose(this.torch.position, this.torch.quaternion, this.torch.scale)
      this.torch.scale.setScalar(1 / hand.getWorldScale(new THREE.Vector3()).x)
      hand.add(this.torch)
      // The fist's frame in the hand bone's space: the barrel axis (index side = lens) and the palm normal (for a
      // left hand cross(fingers, index − pinky) points out of the palm).
      const inv = hand.matrixWorld.clone().invert()
      const fing = P("LeftHandMiddle1").sub(P("LeftHand")).normalize()
      const across = P("LeftHandIndex1").sub(P("LeftHandPinky1")).normalize()
      this.gripAxisLocal.copy(axis).transformDirection(inv)
      this.palmLocal.copy(new THREE.Vector3().crossVectors(fing, across)).transformDirection(inv)
      this.torch.updateMatrixWorld(true)
      const fw = P("LeftForeArm").sub(P("LeftHand")).normalize()
      this.forearmLocal.copy(fw).transformDirection(this.torch.matrixWorld.clone().invert())
      // The Torch clips hold a torch upright in the fist (knuckles forward). A flashlight is the same fist with the
      // wrist flexed (knuckles down, thumb on top): one fixed hand rotation, in the hand's frame, taking the barrel
      // from the clip's upright to the body's forward, a little below level. Model space here is world (+Z forward).
      const want = new THREE.Vector3(0, -Math.sin(CARRY_TILT), Math.cos(CARRY_TILT))
      const turn = new THREE.Quaternion().setFromUnitVectors(axis.clone(), want)
      const hq = hand.getWorldQuaternion(new THREE.Quaternion())
      this.carryFix.copy(hq).invert().multiply(turn).multiply(hq)
      // The barrel turned in the fist about the palm normal (hand frame) so a straight wrist points it along the view
      // (the fist holds it slightly across, as a real grip does): one fixed offset.
      const kI = this.bones.LeftHandIndex1!.position
      const kP = this.bones.LeftHandPinky1!.position
      const kM = this.bones.LeftHandMiddle1!.position
      const devAxis = new THREE.Vector3().crossVectors(kM.clone().normalize(), kI.clone().sub(kP).normalize()).normalize()
      const flexAxis = kI.clone().sub(kP).normalize()
      this.torchBase.copy(this.torch.quaternion)
      this.torchPosBase.copy(this.torch.position)
      this.devAxisHand.copy(devAxis)
      this.flexAxisHand.copy(flexAxis)
      this.applyTorchOffset()
      a.setEffectiveWeight(0)
      a.stop()
    })
  }

  /** Automation: hold a clip at a phase (loops: 0 = left mid-stance), or null to resume. */
  setPose(p: { clip: string; phase: number } | null) {
    this.pose = p
    if (!p && this.mixer) for (const a of [...this.loops.values()].map((l) => l.action).concat([...this.shots.values()])) a.play()
  }

  /**
   * E: press a button, or reach for a door handle (right hand; the torch stays in the left). `target` (world) is what
   * the hand goes for; without one it goes for the crosshair at arm's length.
   */
  interact(kind: Interaction = "button", target?: { x: number; y: number; z: number }) {
    // Never while seated (the driver's hands are on the wheel; a reach queued then would also fire on standing up).
    if (this.seatRig) return
    if (this.act && this.act.t < 0.6) return
    this.act = { kind, t: 0 }
    this.reachAt = target ? new THREE.Vector3(target.x, target.y, target.z) : null
  }

  /** Seated driving mode (src/playerb/seat.ts has the full API doc). */
  seat(opts: SeatOptions) {
    if (this.seatRig) this.seatRig.opts = opts
    else this.seatRig = new SeatRig(this.seatHost(), opts)

    this.view.weight = 0
  }
  /** Steering-wheel angle (rad, + left) while seated. */
  steer(angle: number) {
    this.seatRig?.steer(angle)
  }
  /**
   * The step-out from the driver's seat (Mixamo driving-exit-car), `t` seconds in (0..5.8). Returns the door's opening
   * angle (rad) the left hand implies, or null before it reaches the door. Then `unseat()` (src/playerb/seat.ts).
   */
  exitCar(t: number) {
    return this.seatRig?.exit(t) ?? null
  }
  /** Seated: the left hand opens the door, t 0→1. */
  reachDoor(t: number) {
    this.seatRig?.reachDoor(t)
  }
  /** Back to the standing body driven by the PlayerState. */
  unseat() {
    if (!this.seatRig) return
    this.seatRig = null
    this.armPrev.clear()
    this.prevFacing = Number.NaN
    this.seatAction?.setEffectiveWeight(0)
    this.seatAction = null
    const e = new THREE.Euler().setFromQuaternion(this.root.quaternion, "YXZ")
    this.facing = e.y
    this.root.rotation.set(0, this.facing, 0)
    this.rootY = Number.NaN
    this.lastY = Number.NaN
    this.eyeOff.set(0, 0)
  }
  /** Seated: the head's eye point (world), where the first-person camera belongs. */
  seatEye(out: THREE.Vector3) {
    if (!this.seatRig || !this.model) return false
    this.seatRig.eye(out)
    return true
  }
  get seated() {
    return this.seatRig !== null
  }

  private seatHost(): SeatHost {
    return {
      root: this.root,
      torch: this.torch,
      bones: () => this.bones,
      model: () => this.model,
      poseIdle: (dt, name) => {
        const mixer = this.mixer
        if (!mixer) return
        this.idleT += dt
        for (const l of this.loops.values()) l.action.setEffectiveWeight(0)
        for (const a of this.shots.values()) a.setEffectiveWeight(0)
        const clip = (name && this.clips.get(name)) || null
        if (clip) {
          const a = mixer.clipAction(clip)
          if (!a.isRunning()) a.play()
          a.timeScale = 0
          a.setEffectiveWeight(1)
          a.time = this.idleT % clip.duration
          this.seatAction = a
        } else {
          const idle = this.loops.get(IDLE)
          if (idle) {
            idle.action.setEffectiveWeight(1)
            idle.action.time = this.idleT % idle.duration
          }
        }
        mixer.update(0)
      },
      clipPose: (name, t) => {
        const mixer = this.mixer
        const clip = this.clips.get(name)
        if (!mixer || !clip) return
        for (const l of this.loops.values()) l.action.setEffectiveWeight(0)
        for (const a of this.shots.values()) a.setEffectiveWeight(0)
        this.seatAction?.setEffectiveWeight(0)
        const a = mixer.clipAction(clip)
        if (!a.isRunning()) a.play()
        a.timeScale = 0
        a.setEffectiveWeight(1)
        a.time = Math.min(t, clip.duration - 1e-3)
        this.seatAction = a
        mixer.update(0)
      },
      clipRoot: (name, t) => {
        const m = META.anims.clips[name]
        if (!m?.root) return { x: 0, z: 0, yaw: 0 }
        const f = Math.min(m.root.length - 1, (t / m.duration) * (m.root.length - 1))
        const r = sampleRoot(m.root, f)
        return { x: r[0]! * this.k, z: r[1]! * this.k, yaw: r[2]! }
      },
      fist: (side, w) => {
        if (w < 1e-3) return
        const ti = this.clips.get("torch-idle")
        if (!ti) return
        const t = this.torchIdleT % ti.duration
        for (const smp of this.torchSamplers) {
          if (!FINGERS.test(smp.bone.name)) continue
          _q.fromArray(smp.idle.evaluate(t) as unknown as number[])
          if (side === "Left") smp.bone.quaternion.slerp(_q, w)
          else {
            // Mirrored across the body's mid-plane (Mixamo's left/right bone frames mirror in local X).
            const b = this.bones[`Right${smp.bone.name.slice(4)}`]
            if (b) b.quaternion.slerp(_q.set(_q.x, -_q.y, -_q.z, _q.w), w)
          }
        }
      },
      atOrigin: (fn) => this.atOrigin(fn),
      ik: (a, b, c, t, p) => twoBoneIK(a, b, c, t, p),
    }
  }

  update(dt: number, s: BodyState) {
    this.lastDt = dt
    const vcp = Math.cos(s.pitch)
    this.viewDir.set(-Math.sin(s.yaw) * vcp, Math.sin(s.pitch), -Math.cos(s.yaw) * vcp)
    const mixer = this.mixer
    if (!mixer || !this.model) return
    // Inside the car the cabin shades the driver; out of it (and stepping out, as the body clears the door) it doesn't.
    const shadeWant = this.seatRig ? CABIN_SHADE + (1 - CABIN_SHADE) * this.seatRig.outside() : 1
    const before = cabinShade.value
    cabinShade.value += (shadeWant - cabinShade.value) * damp(6, dt)
    if (Math.abs(shadeWant - cabinShade.value) < 1e-3) cabinShade.value = shadeWant
    if (cabinShade.value !== before) applyCabinShade()
    if (this.seatRig) {
      if (this.root.parent && new URLSearchParams(location.search).has("introRig")) this.seatRig.showMarkers(this.root.parent)
      this.seatRig.update(dt)
      this.updateViewmodel(dt, s, false)
      this.view.weight = 0
      this.debug.state = "seated"
      return
    }
    const yawGoal = s.yaw + Math.PI
    this.root.position.set(s.pos.x, Number.isNaN(this.rootY) ? s.pos.y : this.rootY, s.pos.z)
    const w = this.debug.weights
    for (const key in w) delete w[key]

    if (this.pose) {
      mixer.stopAllAction()
      const clip = this.clips.get(this.pose.clip)
      if (clip && this.pose.clip !== "bind") {
        const a = mixer.clipAction(clip)
        a.play()
        a.setEffectiveWeight(1)
        const l = this.loops.get(this.pose.clip)
        a.time = l ? (l.offset + this.pose.phase * l.duration) % l.duration : Math.min(0.999, this.pose.phase) * clip.duration
      }
      if (this.pose.clip === "bind") for (const [b, q] of this.bindQ) b.quaternion.copy(q)
      else mixer.update(0)
      this.root.rotation.y = yawGoal
      this.rootY = s.pos.y
      this.root.position.y = s.pos.y
      this.torch.visible = false
      this.debug.state = `pose ${this.pose.clip}`
      return
    }

    // Local velocity (smoothed so key taps don't flicker the blend).
    const sy = Math.sin(s.yaw)
    const cy = Math.cos(s.yaw)
    const vf = -sy * s.vel.x - cy * s.vel.z
    const vs = cy * s.vel.x - sy * s.vel.z
    const kv = damp(12, dt)
    this.smoothVel.x += (vs - this.smoothVel.x) * kv
    this.smoothVel.y += (vf - this.smoothVel.y) * kv
    const speed = this.smoothVel.length()
    const ang = Math.atan2(this.smoothVel.x, this.smoothVel.y)
    // The controller ducks in ~0.15 s (its eye); the body's crouch pose blends a little slower so the spine doesn't snap.
    this.crouchS += (s.crouch - this.crouchS) * damp(9, dt)
    const crouch = smooth(0.2, 0.8, this.crouchS)
    for (const l of this.loops.values()) l.w = 0

    // Vertical speed of the feet's ground (stairs, ladders) from the controller's position (its vel.y is the jump).
    this.dy = Number.isNaN(this.lastY) || Math.abs(s.pos.y - this.lastY) > 1 ? 0 : s.pos.y - this.lastY
    if (dt > 0) this.vy += (this.dy / dt - this.vy) * damp(4, dt)
    this.lastY = s.pos.y

    // Gait weights: speeds of each gait in this direction (circle blend of its direction clips).
    const dirW = (g: Gait) => circle(g.loops, ang)
    const gaitSpeed = (g: Gait, ws: Map<Loop, number>) => [...ws].reduce((a, [l, x]) => a + l.speed * x, 0) || g.loops[0]?.speed || 1
    const walk = this.gaits.walk!
    const jog = this.gaits.jog!
    const run = this.gaits.run!
    const cr = this.gaits.crouch!
    const wW = dirW(walk)
    const wJ = dirW(jog)
    const fwdness = Math.max(0, Math.cos(ang))
    const wR = new Map<Loop, number>(run.loops.length ? [[run.loops[0]!, 1]] : [])
    const sW = gaitSpeed(walk, wW)
    const sJ = gaitSpeed(jog, wJ)
    const sR = run.loops.length ? run.loops[0]!.speed : sJ
    let gw = { walk: 1, jog: 0, run: 0 }
    if (speed > sW) {
      if (speed < sJ) {
        const t = smooth(0, 1, (speed - sW) / (sJ - sW))
        gw = { walk: 1 - t, jog: t, run: 0 }
      } else {
        // Running is forward only; sideways and backwards stay on the jog circle.
        const t = smooth(0, 1, (speed - sJ) / (sR - sJ)) * smooth(0.5, 0.9, fwdness)
        gw = { walk: 0, jog: 1 - t, run: t }
      }
    }
    for (const key of ["walk", "jog", "run"] as const) this.gaitW[key] += (gw[key] - this.gaitW[key]) * damp(8, dt)
    const wC = dirW(cr)

    const moving = s.grounded && !s.onLadder ? smooth(0.06, 0.45, speed) : 0
    const stand = (1 - crouch) * moving
    const set: [Map<Loop, number>, number][] = [
      [wW, stand * this.gaitW.walk],
      [wJ, stand * this.gaitW.jog],
      [wR, stand * this.gaitW.run],
      [wC, crouch * moving],
    ]
    // One stride per cycle: the cycle length is the weighted stride (speed × duration) of the active loops.
    let stride = 0
    let tot = 0
    for (const [ws, gwt] of set) for (const [l, x] of ws) {
      stride += l.speed * l.duration * x * gwt
      tot += x * gwt
    }
    stride = tot > 0 ? stride / tot : 1
    if (tot > 0 && stride > 0.05) this.phase = (this.phase + (speed * dt) / stride) % 1

    // Stairs: the feet's ground rising or falling while walking (|vy| over ~0.12 m/s) swaps in the stair clips (in
    // place; the controller provides the height). Their phase follows the height climbed, one cycle per clip rise, so
    // the steps match the treads whatever the walking speed. Going down fast blends in the stair run.
    if (Math.abs(this.vy) > 0.12) this.stairDir = Math.sign(this.vy)
    const isClimb = (n: string) => META.anims.clips[n]?.kind === "climb" && this.loops.has(n)
    const downOk = isClimb("descending-stairs")
    const climbing = moving * smooth(0.12, 0.3, Math.abs(this.vy)) * (1 - crouch) * (this.stairDir >= 0 || downOk ? 1 : 0)
    this.stairW += (climbing - this.stairW) * damp(6, dt)
    const flat = 1 - this.stairW
    for (const [ws, gwt] of set) for (const [l, x] of ws) l.w += x * gwt * flat
    if (this.stairW > 1e-3) {
      const runDown = this.stairDir < 0 && isClimb("descending-stairs-run") ? smooth(0.8, 1.3, -this.vy) : 0
      const pick: [string, number][] = this.stairDir >= 0 ? [["ascending-stairs", 1]] : [["descending-stairs", 1 - runDown], ["descending-stairs-run", runDown]]
      let perCycle = 0
      for (const [n, x] of pick) {
        const m = META.anims.clips[n]
        if (m) perCycle += Math.abs((m.rise ?? 0.33) * m.duration * this.k) * x
      }
      this.stairPhase = (this.stairPhase + (Math.abs(this.vy) * dt) / Math.max(0.1, perCycle)) % 1
      for (const [n, x] of pick) {
        const l = this.loops.get(n)
        if (!l || x < 1e-3) continue
        l.w += this.stairW * x
        l.action.time = this.stairPhase * l.duration
      }
    }

    // Airborne: the jump clip scrubbed between take-off and landing by vertical velocity; long falls loop falling.
    const jm = META.anims.clips.jump
    const mantle = s.mantle ?? null
    // A mantle is neither a jump nor a landing (the controller has the feet off the ground throughout).
    if (mantle || this.wasMantle) this.wasGrounded = true
    if (!s.grounded && !s.onLadder && !mantle && this.wasGrounded) this.airT = 0
    if (s.grounded && !this.wasGrounded && this.topOut < 0) this.landT = 0
    const leftLadder = this.ladderW > 0.5 && !s.onLadder
    this.wasGrounded = s.grounded || s.onLadder || !!mantle
    this.wasMantle = !!mantle
    const inAir = !s.grounded && !s.onLadder && !mantle
    this.air += ((inAir ? 1 : 0) - this.air) * damp(inAir ? 18 : 14, dt)
    this.airT += dt
    this.landT += dt
    const jump = this.shots.get("jump")
    const fall = this.loops.get("falling-idle")
    let jumpW = 0
    if (jump && jm?.takeoff !== undefined && jm.land !== undefined) {
      const v0 = Math.sqrt(2 * 9.81 * 0.48)
      const air01 = THREE.MathUtils.clamp(0.5 - s.vel.y / (2 * v0), 0, 1)
      const falling = smooth(4.5, 7, -s.vel.y)
      if (inAir || this.air > 0.02) jump.time = jm.takeoff + air01 * (jm.land - jm.takeoff)
      jumpW = this.air * (1 - falling)
      if (fall) {
        fall.w += this.air * falling
        fall.action.time = this.airT % fall.duration
      }
      // Landing: play on from the touchdown frame for the absorption.
      const landDur = Math.min(0.5, jump.getClip().duration - jm.land)
      if (!inAir && this.landT < landDur) {
        const lw = (1 - this.landT / landDur) * (1 - moving * 0.6)
        jump.time = jm.land + this.landT
        jumpW = Math.max(jumpW, lw)
      }
    }
    const groundW = 1 - Math.max(this.air, 0)
    this.airW = Math.min(1, jumpW + (fall?.w ?? 0))

    // Ladder: the climb loop phase-locked to the height climbed (one cycle per clip rise; reversed going down). The
    // last metre and a half to the top scrubs the climb onto the top by height, which plays out after the step off.
    const ladder = this.loops.get("climbing-ladder")
    const topShot = this.shots.get("climbing-to-top")
    this.ladderW += ((s.onLadder ? 1 : 0) - this.ladderW) * damp(14, dt)
    this.yOff = 0
    let topW = 0
    const T = this.top
    if (s.onLadder) {
      const topY = this.opts.ladderTop?.(s.pos.x, s.pos.y, s.pos.z)
      const u = topY == null || !topShot ? -1 : T.total - (topY - s.pos.y)
      if (u > 0) {
        this.topT = this.topAt(u)
        topW = smooth(0, 0.2, u)
        const r = this.riseAt(this.topT)
        // The feet: on the rung at the start, on the floor at the end of the rise.
        this.yOff = -(r + T.f0 + ((T.fEnd - T.total - T.f0) * r) / Math.max(0.1, T.total)) * topW
      } else this.topT = -1
      this.topOut = -1
      if (ladder) {
        const rise = (META.anims.clips["climbing-ladder"]?.rise ?? 0.7) * this.k
        this.ladderT += this.dy / Math.max(0.1, rise)
        ladder.action.time = (((this.ladderT % 1) + 1) % 1) * ladder.duration
        ladder.w = 1 - topW
      }
    } else if (leftLadder && this.topT >= 0 && s.grounded) this.topOut = this.topT
    if (this.topOut >= 0 && topShot) {
      this.topOut += dt * 1.6
      const end = topShot.getClip().duration
      this.topT = Math.min(this.topOut, end - 1e-3)
      topW = 1 - smooth(end - 0.5, end, this.topOut)
      this.yOff = -T.fEnd * topW
      if (this.topOut >= end || moving > 0.6 || inAir) this.topOut = this.topT = -1
    } else if (!s.onLadder) this.topT = -1
    if (topShot && this.topT >= 0) topShot.time = this.topT
    const ladderW = s.onLadder ? 1 : 0

    // Idle and turn in place: standing still, the body keeps its facing until the view turns past 60°, then steps
    // round with a 90° turn clip whose own root yaw rotates the body.
    const idleW = (1 - moving) * groundW * (1 - ladderW)
    const idle = this.loops.get(IDLE)
    const cidle = this.loops.get(CROUCH_IDLE)
    this.idleT += dt
    if (idle) {
      idle.w += idleW * (1 - crouch)
      idle.action.time = this.idleT % idle.duration
    }
    if (cidle) {
      cidle.w += idleW * crouch
      cidle.action.time = this.idleT % cidle.duration
    }
    let turnW = 0
    const mw = this.mantleWeights(mantle)
    if (mantle) {
      // Square to the ledge.
      this.turn = null
      const face = Math.atan2(mantle.to[0] - mantle.from[0], mantle.to[2] - mantle.from[2])
      this.facing += wrapPi(face - this.facing) * damp(16, dt)
    } else if (s.onLadder && s.ladder) {
      this.turn = null
      const face = Math.atan2(-s.ladder.normal[0], -s.ladder.normal[2])
      this.facing += wrapPi(face - this.facing) * damp(12, dt)
    } else if (moving > 0.3 || s.onLadder || inAir || this.topOut >= 0) {
      this.turn = null
      const k = damp(moving > 0.3 ? 10 : this.topOut >= 0 ? 4 : 30, dt)
      this.facing += wrapPi(yawGoal - this.facing) * k
    } else if (this.turn) {
      const shot = this.shots.get(this.turn.clip)!
      const m = META.anims.clips[this.turn.clip]!
      this.turn.t += dt * 1.15
      const T = m.duration
      const fi = Math.min(m.root!.length - 1, (this.turn.t / T) * (m.root!.length - 1))
      const yawNow = sampleRoot(m.root!, fi)[2]!
      this.facing = this.turn.from + yawNow * this.turn.scale
      shot.time = Math.min(this.turn.t, T - 1e-3)
      turnW = idleW * (1 - smooth(T - 0.2, T, this.turn.t)) * smooth(0, 0.12, this.turn.t)
      if (this.turn.t >= T) this.turn = null
    } else {
      const d = wrapPi(yawGoal - this.facing)
      if (Math.abs(d) > (60 * Math.PI) / 180 && crouch < 0.5) {
        const clip = d > 0 ? "left-turn-90" : "right-turn-90"
        const m = META.anims.clips[clip]
        if (m?.root && this.shots.has(clip)) {
          const total = m.root[m.root.length - 1]![2]!
          this.turn = { clip, t: 0, from: this.facing, sign: Math.sign(d), scale: d / total }
        } else this.facing = yawGoal
      } else if (Math.abs(d) > (60 * Math.PI) / 180) this.facing += wrapPi(yawGoal - this.facing) * damp(6, dt)
    }
    // The body turns at most FACING_RATE (an airborne snap, a hand-back from a mantle or a fast spin stays a turn).
    if (dt > 0 && dt < 0.25 && !Number.isNaN(this.prevFacing) && !this.pose) {
      const d = wrapPi(this.facing - this.prevFacing)
      const m = FACING_RATE * dt
      if (Math.abs(d) > m) this.facing = this.prevFacing + Math.sign(d) * m
    }
    // The body never lets the view get more than BODY_LEAD from its front (walking, standing, turning in place): the
    // hand and torch can then always point along the view. Not on a ladder, mantling or climbing over a ladder top.
    if (!s.onLadder && !s.mantle && this.topOut < 0 && !this.pose) {
      const off = wrapPi(this.facing - yawGoal)
      if (Math.abs(off) > BODY_LEAD) {
        const want = yawGoal + Math.sign(off) * BODY_LEAD
        const d = wrapPi(want - this.facing)
        const m = LEAD_RATE * Math.min(dt, 0.1)
        this.facing += Math.abs(d) > m ? Math.sign(d) * m : d
      }
    }
    this.prevFacing = this.facing
    this.root.rotation.y = this.facing

    // Apply weights: the one-shots take their share from everything else.
    const over = Math.min(1, turnW + jumpW + (s.onLadder ? 0 : topW) + this.mantleW)
    const rest = 1 - over
    for (const l of this.loops.values()) {
      const wt = l.w * (l.name === "falling-idle" ? 1 : rest)
      l.action.setEffectiveWeight(wt)
      if (wt > 0.01) w[l.name] = wt
      if (GAITS.walk.includes(l.name) || GAITS.jog.includes(l.name) || GAITS.run.includes(l.name) || GAITS.crouch.includes(l.name)) l.action.time = (l.offset + this.phase * l.duration) % l.duration
    }
    for (const [n, a] of this.shots) {
      const wt = n === "jump" ? jumpW : n === "climbing-to-top" ? topW : this.turn?.clip === n ? turnW : (mw.get(n) ?? 0) * this.mantleW
      a.setEffectiveWeight(wt)
      if (wt > 0.01) w[n] = wt
    }
    this.debug.phase = this.phase
    this.debug.state = mantle ? `mantle ${mantle.t.toFixed(2)}` : this.topT >= 0 ? "ladder top" : inAir ? "air" : s.onLadder ? "ladder" : this.turn ? "turn" : speed < 0.1 ? (crouch > 0.5 ? "crouch" : "idle") : crouch > 0.5 ? "crouch walk" : this.stairW > 0.5 ? "stairs" : "move"
    mixer.update(0)
    this.root.updateMatrixWorld(true)

    this.calmArms()
    this.topW = topW
    this.applyLook(s, (1 - ladderW) * (1 - topW) * (1 - this.mantleW))
    this.applyInteract(dt, s, ladderW)
    this.applyMantleHands(s)
    this.limitArms(dt)
    if (this.act) w[`E ${this.act.kind}`] = 1
    this.groundFeet(dt, s, inAir)
    // The torch arm last: it is placed relative to the camera, after the body has been moved under it.
    this.root.updateMatrixWorld(true)
    this.applyTorch(dt, s, moving)
    this.updateViewmodel(dt, s, this.carryW > 0.6 && this.torchHeld && !s.onLadder && !s.mantle && this.topT < 0)
  }

  /**
   * The first-person flashlight hand (viewmodel.ts): shown while the torch is carried; meanwhile the body's own left
   * forearm, hand and torch go to HEAD_LAYER (shadows and mirrors still see them, the view camera doesn't).
   */
  private updateViewmodel(dt: number, s: BodyState, show: boolean) {
    const vm = this.viewmodel
    if (this.root.parent && vm.root.parent !== this.root.parent) this.root.parent.add(vm.root)
    const eye = s.eye ?? this.root.position.clone().setY(this.root.position.y + 1.6)
    vm.update(dt, show, { eye, yaw: s.yaw, pitch: s.pitch, vel: s.vel, crouch: s.crouch, grounded: s.grounded, phase: this.phase, speed: this.smoothVel.length() })
    // In first person no hand or forearm is ever seen (owner decision; the flashlight's head alone pokes in) except
    // on the steering wheel: both forearms and hands go to HEAD_LAYER (shadows, mirrors and the debug third-person
    // camera still see them), and so does the body's own torch while the viewmodel shows.
    const active = vm.root.visible
    const hideArms = !this.seatRig
    if (active !== this.vmActive || hideArms !== this.armsHidden) {
      this.vmActive = active
      this.armsHidden = hideArms
      for (const m of this.armParts) m.layers.set(hideArms ? HEAD_LAYER : BODY_LAYER)
      this.torch.traverse((o) => o.layers.set(active ? HEAD_LAYER : BODY_LAYER))
  }
  }

  /**
   * Mantle: the clip(s) for this ledge height and their times. Each clip is time-warped onto the controller's timing:
   * up to t = 0.7 the clip time is where its hips' climb (`root` y, monotonic) has reached the share of the rise the
   * controller has done; after that the clip's way over the top plays out to its end by t = 1. The clips are in place
   * (their root path is removed) and the body stands at the controller's feet, so the climb stretches to the real
   * height. step-up below ~0.6 m, run-jump-high ~0.85–1.3 m, hang-to-crouch above that or when it ends crouched.
   */
  private mantleWeights(m: BodyState["mantle"] | null) {
    const out = new Map<string, number>()
    const target = m ? smooth(0, 0.1, m.t) * (1 - smooth(0.9, 1, m.t)) : 0
    // In fast, out with the landing (the controller's crouch and idle take over).
    this.mantleW = m ? target : this.mantleW * 0.8
    if (!m) return out
    const h = m.height
    let wS = 1 - smooth(0.6, 0.85, h)
    let wR = smooth(0.6, 0.85, h) * (1 - smooth(1.25, 1.45, h))
    let wH = smooth(1.25, 1.45, h)
    if (m.crouch && h > 0.8) [wS, wR, wH] = [0, 0, 1]
    const ws: [string, number][] = [
      ["mantle-step-up", wS],
      ["mantle-run-jump-high", wR],
      ["mantle-hang-to-crouch", wH],
    ]
    let tot = 0
    for (const [n, x] of ws) if (this.mantleWarp.has(n)) tot += x
    const ss = (v: number) => {
      const c = THREE.MathUtils.clamp(v, 0, 1)
      return c * c * (3 - 2 * c)
    }
    for (const [n, x] of ws) {
      const W = this.mantleWarp.get(n)
      const a = this.shots.get(n)
      if (!W || !a || tot <= 0 || x <= 0) continue
      out.set(n, x / tot)
      let time: number
      if (m.t < 0.7) {
        const goal = ss(m.t / 0.7) * W.L
        let f = Math.floor(W.t0 * W.fps)
        while (f < W.ys.length - 1 && W.ys[f + 1]! < goal) f++
        const y0 = W.ys[f]!
        const y1 = W.ys[Math.min(W.ys.length - 1, f + 1)]!
        time = Math.max(W.t0, (f + (y1 > y0 ? THREE.MathUtils.clamp((goal - y0) / (y1 - y0), 0, 1) : 0)) / W.fps)
        time = Math.min(time, W.tTop)
      } else time = W.tTop + (W.dur - W.tTop) * ((m.t - 0.7) / 0.3)
      a.time = Math.min(time, W.dur - 1e-3)
    }
    return out
  }

  /**
   * Mantle: both palms on the real ledge edge (in from the face, a shoulder width apart) while the body rises and
   * starts over the top, for ledges above ~0.75 m (lower ones are stepped up without hands).
   */
  private applyMantleHands(s: BodyState) {
    const m = s.mantle
    const want = m && m.height > 0.7 ? smooth(0.04, 0.16, m.t) * (1 - smooth(0.68, 0.86, m.t)) * smooth(0.7, 0.8, m.height) : 0
    this.mantleHandsW = want
    const B = this.bones
    if (!m || want < 1e-3 || !B.LeftArm || !B.RightArm) return
    const d = _v.set(m.to[0] - m.from[0], 0, m.to[2] - m.from[2])
    if (d.lengthSq() < 1e-6) d.set(Math.sin(this.facing), 0, Math.cos(this.facing))
    d.normalize()
    // The face: where the controller stopped short of it (0.32 m), else 0.25 m back from the spot on top.
    const edge = new THREE.Vector3()
    if (m.face) edge.set(m.face[0], 0, m.face[2]).addScaledVector(d, 0.32)
    else edge.set(m.to[0], 0, m.to[2]).addScaledVector(d, -0.25)
    edge.y = m.to[1]
    const left = new THREE.Vector3(d.z, 0, -d.x)
    for (const [side, sgn] of [["Left", 1], ["Right", -1]] as const) {
      const arm = B[`${side}Arm`]!
      const fore = B[`${side}ForeArm`]!
      const hand = B[`${side}Hand`]!
      // Palm on top, 6 cm in from the edge; the wrist a little behind and above it.
      const palm = edge.clone().addScaledVector(left, sgn * 0.21).addScaledVector(d, 0.06)
      palm.y += 0.02
      const wrist = palm.addScaledVector(d, -0.07).addScaledVector(UP, 0.05)
      const cur = hand.getWorldPosition(new THREE.Vector3())
      wrist.lerp(cur, 1 - want)
      // Elbows out to the side and back.
      const pole = new THREE.Vector3().copy(d).multiplyScalar(-0.6).addScaledVector(left, sgn * 0.8).addScaledVector(UP, -0.3)
      twoBoneIK(arm, fore, hand, wrist, pole)
    }
    this.model!.updateMatrixWorld(true)
  }

  /** Jump and fall: the arms most of the way to the breathing idle's (the clip's arms fly out like a T). */
  private calmArms() {
    const k = this.airW * ARM_CALM
    if (k < 1e-3) return
    const idle = this.loops.get(IDLE)
    const t = idle ? this.idleT % idle.duration : 0
    for (const smp of this.armSamplers) {
      _q.fromArray(smp.interp.evaluate(t) as unknown as number[])
      smp.bone.quaternion.slerp(_q, k)
    }
    this.model!.updateMatrixWorld(true)
  }

  /**
   * Continuity filter for the arms after every layer: each joint's local rotation kept in the previous frame's
   * quaternion hemisphere and turned at most ARM_RATE towards this frame's (a pose discontinuity, wherever it comes
   * from, becomes a fast but continuous turn). Reset after a gap (load, seat hand-back, teleport-sized dt).
   */
  private limitArms(dt: number) {
    if (dt <= 0) return
    const fresh = dt > 0.25 || this.armPrevFor !== this.model
    this.armPrevFor = this.model
    const max = ARM_RATE * dt
    for (const n of ARM_BONES) {
      const b = this.bones[n]
      if (!b) continue
      // The torch arm is solved exactly onto the view each frame (continuous by construction): there the limit fades out
      // as the carry comes in fully, so it never drags the barrel off the beam (a binding limit averages two IK
      // solutions into a wrong pose), but still smooths the hand-back from a ladder or a mantle.
      // (The torch arm's continuity is enforced on its IK targets instead: see applyTorch.)
      if (n.startsWith("Left") && this.carryW > 1e-3 && this.mantleHandsW < 1e-3) {
        this.armPrev.get(n)?.copy(b.quaternion)
        continue
      }
      const lim = max
      let p = this.armPrev.get(n)
      if (!p) this.armPrev.set(n, (p = b.quaternion.clone()))
      else if (!fresh) {
        if (p.dot(b.quaternion) < 0) b.quaternion.set(-b.quaternion.x, -b.quaternion.y, -b.quaternion.z, -b.quaternion.w)
        const ang = p.angleTo(b.quaternion)
        if (ang > lim) {
          const goal = b.quaternion.clone()
          b.quaternion.copy(p).rotateTowards(goal, lim)
        }
      }
      p.copy(b.quaternion)
    }
    this.model!.updateMatrixWorld(true)
  }
  private armPrev = new Map<string, THREE.Quaternion>()
  private lookRel = 0
  /** The first-person flashlight hand. */
  readonly viewmodel = new Viewmodel()
  private armParts: THREE.Mesh[] = []
  private vmActive = false
  private armsHidden = false
  /** The view's forward (world), from the controller's yaw/pitch. */
  private viewDir = new THREE.Vector3(0, 0, -1)
  private crouchS = 0
  private lookOut = 0
  private lastDt = 1 / 60
  private prevFacing = Number.NaN
  private armPrevFor: THREE.Object3D | null = null

  /** Rotates a bone by `angle` about a world axis (its parent's world matrix must be current). */
  private rotWorld(bone: THREE.Bone, axis: THREE.Vector3, angle: number) {
    if (Math.abs(angle) < 1e-5) return
    bone.parent!.getWorldQuaternion(_q2)
    _v2.copy(axis).applyQuaternion(_q2.invert())
    bone.quaternion.premultiply(_qa.setFromAxisAngle(_v2, angle))
    bone.updateWorldMatrix(false, false)
  }

  /** Spine, neck and head share the view's pitch and the view's yaw away from the feet. */
  private applyLook(s: BodyState, weight: number) {
    const k = this.look * weight
    if (k < 1e-3) return
    const pitch = THREE.MathUtils.clamp(s.pitch, -1.25, 1.1) * k
    // The view's yaw away from the feet, unwrapped against last frame's (a view behind the body doesn't flip the
    // chest from one shoulder to the other as it crosses ±180°), then clamped.
    const raw = s.yaw + Math.PI - this.facing
    this.lookRel += wrapPi(raw - this.lookRel)
    if (Math.abs(this.lookRel) > Math.PI * 1.5) this.lookRel = wrapPi(this.lookRel)
    // Turned at a bounded rate: when the view swings round behind the body (an ambiguous shoulder) the chest swings
    // across in ~0.4 s instead of popping.
    const want = THREE.MathUtils.clamp(this.lookRel, -1.3, 1.3)
    const m = LOOK_RATE * Math.max(0, Math.min(0.1, this.lastDt))
    this.lookOut += THREE.MathUtils.clamp(want - this.lookOut, -m, m)
    const yaw = this.lookOut * k
    // Model +X is the character's left: a negative turn about it tips the face up.
    const leftAxis = _left.set(1, 0, 0).applyQuaternion(this.root.quaternion)
    for (const [name, kp, ky] of LOOK) {
      const b = this.bones[name]
      if (!b) continue
      this.rotWorld(b, UP, yaw * ky)
      this.rotWorld(b, leftAxis, -pitch * kp)
    }
  }

  /** E: the right arm from the button / door clip's reach, faded in and out over the mixer's pose. */
  private applyInteract(dt: number, s: BodyState, ladderW: number) {
    if (!this.act) return
    const spec = INTERACT[this.act.kind]
    this.act.t += dt * spec.rate
    const len = spec.t1 - spec.t0
    if (this.act.t >= len) {
      this.act = null
      return
    }
    const wt = smooth(0, 0.3, this.act.t) * (1 - smooth(len - 0.45, len, this.act.t)) * (1 - ladderW)
    const t = spec.t0 + this.act.t
    for (const smp of this.reach[this.act.kind]) {
      _q.fromArray(smp.interp.evaluate(t) as unknown as number[])
      smp.bone.quaternion.slerp(_q, wt)
    }
    this.model!.updateMatrixWorld(true)
    // Aim: turn the upper arm so the clip's hand points at the target (the clip keeps its elbow and wrist), most at
    // the reach's furthest point.
    const goal = this.reachAt ?? this.crosshair(s, this.reachGoal)
    const arm = this.bones.RightArm
    const hand = this.bones.RightHand
    if (!arm || !hand || !goal) return
    const sh = arm.getWorldPosition(new THREE.Vector3())
    const toHand = hand.getWorldPosition(new THREE.Vector3()).sub(sh)
    const toGoal = goal.clone().sub(sh)
    const reach = toHand.length()
    if (reach < 0.05 || toGoal.lengthSq() < 1e-4) return
    // Out of reach: the hand stops at arm's length along the line to the target.
    _q.setFromUnitVectors(toHand.normalize(), toGoal.normalize())
    _q2.identity().slerp(_q, wt * smooth(0.15, 0.55, reach))
    arm.parent!.getWorldQuaternion(_qa)
    const local = _qa.clone().invert().multiply(_q2).multiply(_qa)
    arm.quaternion.premultiply(local)
    this.model!.updateMatrixWorld(true)
  }

  /** The point at arm's length under the crosshair (from the eye, along the view). */
  private crosshair(s: BodyState, out: THREE.Vector3) {
    const e = s.eye
    if (!e) return null
    const cp = Math.cos(s.pitch)
    return out.set(e.x - Math.sin(s.yaw) * cp * 0.6, e.y + Math.sin(s.pitch) * 0.6 - 0.05, e.z - Math.cos(s.yaw) * cp * 0.6)
  }

  /**
   * The flashlight carry. The Mixamo torch clips hold a burning torch aloft, out to the side, which reads wrong for a
   * flashlight; they give the fist (the torch-idle finger pose, which the torch is fitted to). The arm is placed by
   * two-bone IK: relaxed, low and forward on the left, the barrel along the view (lagging it a little), swinging a
   * little with the gait. The right hand stays free for E.
   */
  private applyTorch(dt: number, s: BodyState, moving: number) {
    if (!CARRY_IK && this.carry2.length) return this.applyCarry(dt, s)
    this.applyTorchIK(dt, s, moving)
  }

  /**
   * The flashlight carry from recorded motion: the Torch-series clips play on the left shoulder, arm, hand and fingers,
   * weighted by the same locomotion blend as the legs (idle / walk 4 directions / run / crouch) and on their phase;
   * then a gentle first-person nudge of the hand (in and down, by swinging the upper arm) and an aim correction on
   * the forearm and wrist (≤ CARRY_AIM) so the barrel follows the view. The beam itself comes from the view.
   */
  private applyCarry(dt: number, s: BodyState) {
    const climbing = !!s.mantle && this.mantleW > 0.3
    this.carryW += ((s.flashlight && !s.onLadder && this.topT < 0 && !s.mantle ? 1 : 0) - this.carryW) * damp(climbing ? 10 : 7, dt)
    this.torch.visible = this.carryW > 0.7 || (s.flashlight && !!s.mantle)
    this.torchHeld = !climbing
    const B = this.bones
    if (this.carryW < 1e-3 || !this.torch.parent || !B.LeftArm || !B.LeftForeArm || !B.LeftHand) return
    const w = smooth(0, 1, this.carryW)
    this.torchIdleT += dt
    // Weights from the locomotion loops' current weights (their names → the carry role).
    const lw = (n: string) => this.loops.get(n)?.w ?? 0
    const role: Record<string, number> = {
      idle: lw(IDLE),
      cidle: lw(CROUCH_IDLE),
      fwd: lw("walking") + lw("ascending-stairs") + lw("descending-stairs") + lw("descending-stairs-run"),
      back: lw("walking-backwards") + lw("jog-backward"),
      left: lw("left-strafe-walking") + lw("jog-strafe-left"),
      right: lw("right-strafe-walking") + lw("jog-strafe-right"),
      run: lw("jog-forward") + lw("running"),
      cwalk: lw("crouched-walking") + lw("crouch-walk-back") + lw("crouch-walk-left") + lw("crouch-walk-right"),
    }
    let tot = 0
    for (const c of this.carry2) tot += (c.w = role[c.role] ?? 0)
    if (tot < 1e-4) {
      const idle = this.carry2.find((c) => c.role === "idle")
      if (idle) idle.w = tot = 1
    }
    // Blend the clips' rotations per bone (sign-aligned, normalised), then over the pose by the carry weight.
    const acc = new Map<THREE.Bone, THREE.Quaternion>()
    for (const c of this.carry2) {
      if (c.w <= 1e-4) continue
      const k = c.w / tot
      const t = c.role === "idle" || c.role === "cidle" ? this.torchIdleT % c.clip.duration : (c.offset + this.phase * c.clip.duration) % c.clip.duration
      for (const smp of c.samplers) {
        _q.fromArray(smp.interp.evaluate(t) as unknown as number[])
        let a = acc.get(smp.bone)
        if (!a) acc.set(smp.bone, (a = new THREE.Quaternion(0, 0, 0, 0)))
        if (a.x * _q.x + a.y * _q.y + a.z * _q.z + a.w * _q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w)
        a.set(a.x + _q.x * k, a.y + _q.y * k, a.z + _q.z * k, a.w + _q.w * k)
      }
    }
    for (const [bone, q] of acc) bone.quaternion.slerp(q.normalize(), w)
    // The fist always closed round the barrel: the fingers from the carry-idle clip's grip at frame 0 (the walk and
    // run takes loosen the fingers mid-swing, which reads as the flashlight slipping).
    const grip0 = this.carry2.find((c) => c.role === "idle")
    if (grip0) {
      for (const smp of grip0.samplers) {
        if (!FINGERS.test(smp.bone.name)) continue
        _q.fromArray(smp.interp.evaluate(0) as unknown as number[])
        smp.bone.quaternion.slerp(_q, w)
      }
    }
    this.model!.updateMatrixWorld(true)
    if (w > 0.5) this.closeGrip()
    B.LeftHand.quaternion.multiply(_q.identity().slerp(this.carryFix, w))
    this.model!.updateMatrixWorld(true)

    if (!FP_ARM_SOLVE) {
      // Third person (and shadows, mirrors): the clip's carry, the barrel turned towards the view by at most
      // CARRY_AIM, 40 % at the forearm and the rest at the wrist. First person sees the viewmodel instead.
      const barrel = new THREE.Vector3(0, 0, -1).transformDirection(this.torch.matrixWorld)
      const ang = barrel.angleTo(this.viewDir)
      const axis = new THREE.Vector3().crossVectors(barrel, this.viewDir)
      if (ang > 1e-4 && axis.lengthSq() > 1e-12) {
        axis.normalize()
        const turn = Math.min(ang, CARRY_AIM) * w
        this.rotWorld(B.LeftForeArm, axis, turn * 0.4)
        B.LeftForeArm.updateWorldMatrix(false, true)
        this.rotWorld(B.LeftHand, axis, turn * 0.6)
        B.LeftHand.updateWorldMatrix(false, true)
      }
      return
    }
    // First person: the fist placed at a fixed spot low-left in the view (only the forearm enters the frame) with the
    // barrel exactly along the view (tail nearest the eye, the head and lens leading away), knuckles up, thumb on
    // top; arm by two-bone IK from the clip's shoulder, elbow down and out. The body renders once for every pass, so
    // third person shows the same: the clip's carry arm, raised to point the light where the player looks.
    const fw = this.viewDir
    const yawV = s.yaw
    const right = new THREE.Vector3(Math.cos(yawV), 0, -Math.sin(yawV))
    const upv = new THREE.Vector3().crossVectors(right, fw).normalize()
    const eye = s.eye ? new THREE.Vector3(s.eye.x, s.eye.y, s.eye.z) : B.Head!.getWorldPosition(new THREE.Vector3()).addScaledVector(UP, 0.07)
    const grip = eye.clone().addScaledVector(fw, FP_GRIP[0]).addScaledVector(upv, -FP_GRIP[1]).addScaledVector(right, -FP_GRIP[2])
    // Torch frame: -Z along the view; +Y (axis → palm) towards the body's centre and a little down: palm in, thumb up.
    const Zt = fw.clone().negate()
    const Yt = right.clone().multiplyScalar(FP_ROLL[0]).addScaledVector(upv, FP_ROLL[1])
    Yt.addScaledVector(Zt, -Yt.dot(Zt)).normalize()
    const Xt = new THREE.Vector3().crossVectors(Yt, Zt)
    const torchQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xt, Yt, Zt))
    const handQ = torchQ.multiply(this.torch.quaternion.clone().invert())
    const hs = B.LeftHand.getWorldScale(new THREE.Vector3()).x
    const target = grip.clone().sub(this.torch.position.clone().multiplyScalar(hs).applyQuaternion(handQ))
    const curQ = B.LeftHand.getWorldQuaternion(new THREE.Quaternion())
    handQ.slerpQuaternions(curQ, handQ.clone(), w)
    // The aim spread along the arm: first where the arm would put the fist with a straight wrist (the forearm along
    // the hand's own neutral line: hand rotation = its bind rotation relative to the forearm), then towards the framing
    // spot only as far as the wrist stays within WRIST_FLEX / WRIST_DEV; forearm twist takes the roll (half of it, then
    // the rest the hand keeps within the twist clamp). Whatever is left the barrel may sit off the view (≤ ~10°).
    const fa = B.LeftForeArm
    const shoulder = B.LeftArm.getWorldPosition(new THREE.Vector3())
    const lu = shoulder.distanceTo(fa.getWorldPosition(new THREE.Vector3()))
    const lf = fa.getWorldPosition(new THREE.Vector3()).distanceTo(B.LeftHand.getWorldPosition(new THREE.Vector3()))
    const bindH = this.bindQ.get(B.LeftHand) ?? new THREE.Quaternion()
    const neutralFore = handQ.clone().multiply(bindH.clone().invert())
    const fdir = new THREE.Vector3(0, 1, 0).applyQuaternion(neutralFore)
    const toE = target.clone().addScaledVector(fdir, -lf).sub(shoulder)
    const elbowS = shoulder.clone().addScaledVector(toE.normalize(), lu)
    const straight = elbowS.clone().addScaledVector(fdir, lf)
    // The elbow where a straight wrist wants it (behind the wrist along the forearm's neutral line), as far as the
    // arm's lengths allow: the pole points from the shoulder–wrist line towards it.
    void elbowS
    const poleFor = (wr: THREE.Vector3) => wr.clone().addScaledVector(fdir, -lf).sub(shoulder.clone().add(wr).multiplyScalar(0.5))
    // Wrist axes in the hand's own frame (from its knuckles, which are rigid in it): flexion about the knuckle line
    // (index ↔ pinky), deviation about the palm normal.
    const kI = B.LeftHandIndex1?.position ?? new THREE.Vector3(1, 0, 0)
    const kP = B.LeftHandPinky1?.position ?? new THREE.Vector3(-1, 0, 0)
    const kM = B.LeftHandMiddle1?.position ?? new THREE.Vector3(0, 1, 0)
    const flexAxisL = kI.clone().sub(kP).normalize()
    const devAxisL = new THREE.Vector3().crossVectors(kM.clone().normalize(), flexAxisL).normalize()
    const straightGrip = straight.clone().add(this.torch.position.clone().multiplyScalar(hs).applyQuaternion(handQ))
    const pose = (k: number) => {
      const goal = straightGrip.clone().lerp(grip, k)
      const wrist = straight.clone().lerp(target, k).lerp(B.LeftHand.getWorldPosition(new THREE.Vector3()), 1 - w)
      let r = this.wristPose(wrist, poleFor(wrist), handQ, bindH, flexAxisL, devAxisL)
      // The clamped wrist turns the fist off its ideal: move the wrist so the flashlight still sits at the goal.
      for (let it = 0; it < 3; it++) {
        const t = this.torch.getWorldPosition(new THREE.Vector3())
        const e = goal.clone().sub(t)
        if (e.length() < 0.004) break
        wrist.add(e.multiplyScalar(w))
        r = this.wristPose(wrist, poleFor(wrist), handQ, bindH, flexAxisL, devAxisL)
      }
      return r
    }
    // The furthest towards the framing spot that keeps the barrel within FP_AIM_TOL of the view.
    // The fist stays at the framing spot; the hand's roll about the barrel is free (the knuckles may turn a little
    // in or out): the roll that leaves the barrel closest to the view once the wrist is clamped wins (searched round
    // last frame's, so it moves smoothly), then the arm towards a straighter pose only if still beyond FP_AIM_TOL.
    const baseQ = handQ.clone()
    const evalRoll = (r: number, k = 1) => {
      handQ.copy(baseQ).premultiply(new THREE.Quaternion().setFromAxisAngle(fw, r))
      return pose(k)
    }
    let bestR = this.fpRoll
    let bestOff = Infinity
    for (let d = -0.16; d <= 0.161; d += 0.04) {
      const r = THREE.MathUtils.clamp(this.fpRoll + d, -FP_ROLL_MAX, FP_ROLL_MAX)
      const o = evalRoll(r).off
      if (o < bestOff - 0.002) {
        bestOff = o
        bestR = r
      }
    }
    // Eased, and at most FP_ROLL_RATE: the roll never pops between two near-equal solutions.
    const dr = (bestR - this.fpRoll) * damp(6, dt)
    this.fpRoll += THREE.MathUtils.clamp(dr, -FP_ROLL_RATE * dt, FP_ROLL_RATE * dt)
    let res = evalRoll(this.fpRoll)
    let kUsed = 1
    for (const k of [0.75, 0.5]) {
      if (res.off < FP_AIM_TOL) break
      res = evalRoll(this.fpRoll, (kUsed = k))
    }
    ;(this.debug as Record<string, unknown>).wristK = [kUsed, +((this.fpRoll * 180) / Math.PI).toFixed(0)]
    this.foreTwist = this.foreTwistNext
    const d = (r: number) => +((r * 180) / Math.PI).toFixed(1)
    ;(this.debug as Record<string, unknown>).wrist = { flex: d(res.flex), dev: d(res.dev), twist: d(res.twist), barrelOff: d(res.off), wantFlex: d(res.flexRaw), wantDev: d(res.devRaw) }
    const barrel = new THREE.Vector3(0, 0, -1).transformDirection(this.torch.matrixWorld)
    const ang = barrel.angleTo(this.viewDir)
    ;(this.debug as Record<string, unknown>).carry = { aimErr: +((ang * 180) / Math.PI).toFixed(1) }
  }

  private applyTorchIK(dt: number, s: BodyState, moving: number) {
    // Mantling the torch stays in the left fist on the ledge (the beam falls back to the view; see torchLens).
    const climbing = !!s.mantle && this.mantleW > 0.3
    this.carryW += ((s.flashlight && !s.onLadder && this.topT < 0 && !s.mantle ? 1 : 0) - this.carryW) * damp(climbing ? 10 : 7, dt)
    this.torch.visible = this.carryW > 0.7 || (s.flashlight && !!s.mantle)
    this.torchHeld = !climbing
    const B = this.bones
    if (this.carryW < 1e-3 || !this.torch.parent || !B.LeftArm || !B.LeftForeArm || !B.LeftHand || !B.Head) {
      this.tPrev = null
      return
    }
    const w = smooth(0, 1, this.carryW)
    this.torchIdleT += dt
    const ti = this.clips.get("torch-idle")!
    const tIdle = this.torchIdleT % ti.duration
    for (const smp of this.torchSamplers) {
      if (!FINGERS.test(smp.bone.name)) continue
      _q.fromArray(smp.idle.evaluate(tIdle) as unknown as number[])
      smp.bone.quaternion.slerp(_q, w)
    }
    this.model!.updateMatrixWorld(true)

    // Aim: the view direction, lagged a little (the hand follows the head).
    const c = this.carry
    // The aim is the view itself (the body keeps the view within BODY_LEAD of its front, so the arm can follow it):
    // its yaw only clamped to ±AIM_YAW of the body as a safety net. No smoothing: the torch points where you look.
    const bodyYaw = this.facing + Math.PI
    const rel = THREE.MathUtils.clamp(wrapPi(s.yaw - bodyYaw), -AIM_YAW, AIM_YAW)
    const ay = bodyYaw + rel
    const apt = THREE.MathUtils.clamp(s.pitch, -1.45, 1.45)
    const cp = Math.cos(apt)
    c.aim.set(-Math.sin(ay) * cp, Math.sin(apt), -Math.cos(ay) * cp)
    const aim = c.aim

    // The arm, built forward from the shoulder (so the pose reads in mirrors and shadows, not only in first person):
    // the upper arm hangs down, swung forward with the aim (and when looking down, so the hand is in view); the
    // forearm points forward and down from the elbow, rising as the aim rises. A fist holds the barrel across the
    // forearm, so a forearm angled ~55° down plus a little wrist cock points the barrel level along the view.
    // The arm's frame is the body's (its facing), so the shoulder, elbow and pole stay continuous whatever the view does.
    const yawF = _v.set(-Math.sin(bodyYaw), 0, -Math.cos(bodyYaw))
    const left = _left.set(-Math.cos(bodyYaw), 0, Math.sin(bodyYaw))
    const ap = Math.asin(THREE.MathUtils.clamp(aim.y, -1, 1))
    const ph = this.phase * Math.PI * 2
    const swing = moving * 0.07 * Math.sin(ph)
    const shoulder = B.LeftArm.getWorldPosition(new THREE.Vector3())
    const lu = shoulder.distanceTo(B.LeftForeArm.getWorldPosition(_v3))
    const lf = B.LeftForeArm.getWorldPosition(_v3).distanceTo(B.LeftHand.getWorldPosition(_v4))
    // Upper arm: angle forward of straight down (rad).
    const upFwd = c.upper + 0.55 * Math.max(0, ap) + 0.6 * smooth(0.2, 1.0, -ap) + swing
    const elbow = new THREE.Vector3()
      .copy(shoulder)
      .addScaledVector(UP, -Math.cos(upFwd) * lu)
      .addScaledVector(yawF, Math.sin(upFwd) * lu * 0.96)
      .addScaledVector(left, c.out * lu)
    // Forearm elevation (rad, + up): follows the aim, clamped to what an elbow does.
    const fe = THREE.MathUtils.clamp(ap - c.wrist, -1.45, 0.35)
    const inward = c.inward
    const fdir = new THREE.Vector3().copy(yawF).multiplyScalar(Math.cos(fe)).addScaledVector(UP, Math.sin(fe)).addScaledVector(left, -inward).normalize()
    const wrist = new THREE.Vector3().copy(elbow).addScaledVector(fdir, lf)

    // The grip, solved explicitly on the hand (the torch-idle clip holds a burning torch upright; only its fist shape
    // is used): the fist's barrel axis (index side = lens) along the aim, and its palm facing in and down, wrapped
    // under and around the barrel, so the back of the hand faces out and up, the thumb lies over the top towards the
    // lens and the knuckles point forward and out. The torch is fixed in the fist, so its lens points along the aim.
    const handQ = _q2
    const A = _z.copy(aim)
    const Np = _y.copy(left).multiplyScalar(-GRIP_IN).addScaledVector(UP, -GRIP_DOWN)
    Np.addScaledVector(A, -Np.dot(A))
    if (Np.lengthSq() < 1e-4) Np.copy(yawF).addScaledVector(A, -A.dot(yawF))
    Np.normalize()
    const l1 = _v5.copy(this.gripAxisLocal).normalize()
    const l2 = _v6.copy(this.palmLocal).addScaledVector(l1, -this.palmLocal.dot(l1)).normalize()
    const l3 = new THREE.Vector3().crossVectors(l1, l2)
    const w3 = _x.crossVectors(A, Np)
    _m.makeBasis(A, Np, w3).multiply(new THREE.Matrix4().makeBasis(l1, l2, l3).transpose())
    handQ.setFromRotationMatrix(_m)
    c.grip.copy(wrist)
    const cur = B.LeftHand.getWorldPosition(new THREE.Vector3())
    wrist.lerp(cur, 1 - w)
    handQ.slerpQuaternions(B.LeftHand.getWorldQuaternion(new THREE.Quaternion()), handQ.clone(), w)
    // Continuity of the targets, in the body's frame: the wrist moves at most WRIST_SPEED and the fist turns at most
    // HAND_RATE per second (a hand-back or an ambiguous pose becomes a quick move, never a pop); the IK below is exact.
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert()
    const rq = this.root.getWorldQuaternion(new THREE.Quaternion())
    const wl = wrist.clone().applyMatrix4(rootInv)
    const ql = rq.clone().invert().multiply(handQ)
    if (this.tPrev && dt > 0 && dt < 0.25) {
      const dp = wl.clone().sub(this.tPrev.p)
      const mp = WRIST_SPEED * dt
      if (dp.length() > mp) wl.copy(this.tPrev.p).addScaledVector(dp.normalize(), mp)
      if (this.tPrev.q.dot(ql) < 0) ql.set(-ql.x, -ql.y, -ql.z, -ql.w)
      const mq = HAND_RATE * dt
      if (this.tPrev.q.angleTo(ql) > mq) {
        const goal = ql.clone()
        ql.copy(this.tPrev.q).rotateTowards(goal, mq)
      }
      wrist.copy(wl).applyMatrix4(this.root.matrixWorld)
      handQ.copy(rq).multiply(ql)
    }
    this.tPrev = { p: wl, q: ql }
    const pole = elbow.clone().sub(shoulder.clone().add(wrist).multiplyScalar(0.5))
    twoBoneIK(B.LeftArm, B.LeftForeArm, B.LeftHand, wrist, pole)
    // The fist's orientation, half of its twist taken by the forearm (no candy-wrapped wrist).
    const fa = B.LeftForeArm
    const local = _qb.copy(fa.getWorldQuaternion(_qc)).invert().multiply(handQ)
    const curLocal = B.LeftHand.quaternion
    _qd.copy(local)
    void curLocal
    if (_qd.w < 0) _qd.set(-_qd.x, -_qd.y, -_qd.z, -_qd.w)
    // Twist about the forearm (Mixamo bone axis Y), clamped to the forearm's pronation range.
    let twa = 2 * Math.atan2(_qd.y, _qd.w)
    twa = THREE.MathUtils.clamp(wrapPi(twa), -TWIST_MAX, TWIST_MAX)
    const tw = _qe.setFromAxisAngle(_v5.set(0, 1, 0), twa)
    const half = _qc.identity().slerp(tw, 0.5)
    fa.quaternion.multiply(half)
    fa.updateWorldMatrix(false, false)
    _qb.copy(fa.getWorldQuaternion(_qc)).invert().multiply(handQ)
    B.LeftHand.quaternion.copy(_qb)
    B.LeftArm.updateWorldMatrix(false, true)
    // The thumb over the top of the barrel, pointing along it towards the lens.
    const t1 = B.LeftHandThumb1
    const t4 = B.LeftHandThumb4
    if (t1 && t4 && w > 0.5) {
      const top = _v5.copy(UP).addScaledVector(A, -A.y).normalize()
      const goal = this.torch.getWorldPosition(new THREE.Vector3()).addScaledVector(A, 0.055).addScaledVector(top, 0.024).addScaledVector(left, -0.006)
      const base = t1.getWorldPosition(new THREE.Vector3())
      const cur = t4.getWorldPosition(new THREE.Vector3()).sub(base)
      const want = goal.sub(base)
      const ax = new THREE.Vector3().crossVectors(cur, want)
      if (ax.lengthSq() > 1e-12) this.rotWorld(t1, ax.normalize(), Math.min(1.6, cur.angleTo(want)) * w)
      t1.updateWorldMatrix(false, true)
    }
  }

  /**
   * One flashlight-arm pose: two-bone IK of the left arm to `wrist`, then the forearm twist (60 % of the hand's roll,
   * unwrapped against last frame) and the hand at `handQ` with the wrist clamped to WRIST_FLEX / WRIST_DEV and
   * WRIST_TWIST. Returns the barrel's angle off the view and the wrist angles (rad).
   */
  private wristPose(wrist: THREE.Vector3, pole: THREE.Vector3, handQ: THREE.Quaternion, bindH: THREE.Quaternion, flexAxisL: THREE.Vector3, devAxisL: THREE.Vector3) {
    const B = this.bones
    const fa = B.LeftForeArm!
    twoBoneIK(B.LeftArm!, fa, B.LeftHand!, wrist, pole)
    // Forearm twist: half the hand's roll about the forearm.
    const local = fa.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(handQ)
    const rel0 = bindH.clone().invert().multiply(local)
    if (rel0.w < 0) rel0.set(-rel0.x, -rel0.y, -rel0.z, -rel0.w)
    // Unwrapped against last frame's (a roll near a half turn never flips the forearm from one side to the other).
    const raw = 2 * Math.atan2(rel0.y, rel0.w)
    const twa = THREE.MathUtils.clamp(this.foreTwist + wrapPi(raw - this.foreTwist), -TWIST_MAX, TWIST_MAX)
    this.foreTwistNext = twa
    fa.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(_v5.set(0, 1, 0), twa * 0.6))
    fa.updateWorldMatrix(false, true)
    // The wrist: the hand's rotation relative to its bind, split into twist (≤ WRIST_TWIST) and swing; the swing
    // clamped to flexion ±WRIST_FLEX and deviation ±WRIST_DEV.
    const rel = bindH.clone().invert().multiply(fa.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(handQ))
    if (rel.w < 0) rel.set(-rel.x, -rel.y, -rel.z, -rel.w)
    const tw = new THREE.Quaternion(0, rel.y, 0, rel.w).normalize()
    const swing = rel.clone().multiply(tw.clone().invert())
    const sa = 2 * Math.acos(THREE.MathUtils.clamp(swing.w, -1, 1))
    const sv = new THREE.Vector3(swing.x, swing.y, swing.z)
    if (sv.lengthSq() > 1e-12) sv.normalize().multiplyScalar(sa)
    else sv.set(0, 0, 0)
    const flex = sv.dot(flexAxisL)
    const dev = sv.dot(devAxisL)
    const flexC = THREE.MathUtils.clamp(flex, -WRIST_FLEX, WRIST_FLEX)
    const devC = THREE.MathUtils.clamp(dev, -WRIST_DEV, WRIST_DEV)
    const svC = flexAxisL.clone().multiplyScalar(flexC).addScaledVector(devAxisL, devC)
    const twaH = THREE.MathUtils.clamp(wrapPi(2 * Math.atan2(tw.y, tw.w)), -WRIST_TWIST, WRIST_TWIST)
    const swingC = svC.lengthSq() > 1e-12 ? new THREE.Quaternion().setFromAxisAngle(svC.clone().normalize(), svC.length()) : new THREE.Quaternion()
    const relC = swingC.multiply(new THREE.Quaternion().setFromAxisAngle(_v5.set(0, 1, 0), twaH))
    B.LeftHand.quaternion.copy(bindH).multiply(relC)
    B.LeftArm.updateWorldMatrix(false, true)
    const barrel = new THREE.Vector3(0, 0, -1).transformDirection(this.torch.matrixWorld)
    return { off: barrel.angleTo(this.viewDir), flex: flexC, dev: devC, twist: twaH, flexRaw: flex, devRaw: dev }
  }

  /**
   * Flashlight carry: upper arm forward of hanging (rad) and out (× its length), forearm elevation below the aim (rad;
   * the barrel is held across the fist) and how far it points across the body.
   */
  readonly carry = { upper: 0.8, out: 0.2, wrist: 0.2, inward: 0.3, aim: new THREE.Vector3(), grip: new THREE.Vector3() }
  /** Torch-local direction from the wrist to the elbow in the torch-idle grip (placeTorch). */
  private forearmLocal = new THREE.Vector3(0, 1, 0)
  /** Fixed hand rotation (hand-local) turning the clip's upright torch grip into a forward flashlight grip. */
  private carryFix = new THREE.Quaternion()
  private foreTwist = 0
  private handSkin: HandSkin | null = null
  /** The barrel's stand-off from its fitted spot along the palm normal (m), servoed so the palm touches it. */
  private palmOff = 0
  /**
   * The flashlight held in a closed fist, by contact (grip.ts): the barrel moved along the palm normal until the
   * palm's skin touches it (no gap, nothing through the hand), then each finger curled onto it and the thumb kept
   * off it. All hand-relative (the torch is a child of the hand), so done before the arm is aimed.
   */
  private closeGrip() {
    const B = this.bones
    if (!this.model || !B.LeftHand) return
    if (!this.handSkin || this.handSkin.mesh.parent === null || !this.model.getObjectById(this.handSkin.mesh.id)) this.handSkin = measureHands(this.model)
    const skin = this.handSkin
    if (!skin) return
    const hand = B.LeftHand
    const hs = hand.getWorldScale(new THREE.Vector3()).x
    const cyl = (): Cyl => {
      this.torch.position.copy(this.torchPosBase).addScaledVector(this.palmLocal, this.palmOff / hs)
      this.torch.updateMatrixWorld(true)
      return { p: this.torch.getWorldPosition(new THREE.Vector3()), a: new THREE.Vector3(0, 0, -1).transformDirection(this.torch.matrixWorld), r: BARREL_R, lo: -0.07, hi: 0.105 }
    }
    for (let it = 0; it < 4; it++) {
      const cc = cyl()
      const m = skinVsCyl(skin, skin.palm.Left, cc)
      if (!Number.isFinite(m.min)) break
      // Also clear of the knuckles (the fingers' base joints): the barrel lies in the palm, the fingers close over it.
      let e = PALM_TOUCH - m.min
      for (const f of ["Index", "Middle", "Ring", "Pinky"]) {
        const k = B[`LeftHand${f}1`]
        if (!k) continue
        const need = (skin.fingerR[`Left${f}`] ?? 0.01) * 1.3 + 0.001
        e = Math.max(e, need - cylDistX(cc, k.getWorldPosition(new THREE.Vector3())))
      }
      if (Math.abs(e) < 0.0003) break
      this.palmOff = THREE.MathUtils.clamp(this.palmOff + e, -0.04, 0.04)
    }
    const c = cyl()
    wrapFingers(B, "Left", c, skin.fingerR)
    this.model.updateMatrixWorld(true)
    const palm = skinVsCyl(skin, skin.palm.Left, c)
    const all = skinVsCyl(skin, skin.all.Left, c)
    if ((globalThis as { __gripDbg?: boolean }).__gripDbg) {
      const m = skin.mesh, bones = m.skeleton.bones, si = m.geometry.attributes.skinIndex!, sw = m.geometry.attributes.skinWeight!
      const v = new THREE.Vector3()
      const per: Record<string, number[]> = {}
      for (const i of skin.all.Left) {
        let best = 0, bw = 0
        for (let k = 0; k < 4; k++) { const ww = sw.getComponent(i, k); if (ww > bw) { bw = ww; best = si.getComponent(i, k) } }
        m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld)
        const t = v.clone().sub(c.p).dot(c.a)
        const d = cylDistX(c, v)
        const nm = bones[best]!.name
        if (d < 0) (per[nm] ??= []).push(+(d * 1000).toFixed(0), +(t * 1000).toFixed(0))
      }
      ;(this.debug as Record<string, unknown>).gripInside = Object.fromEntries(Object.entries(per).map(([k, arr]) => [k, [arr.length / 2, Math.min(...arr.filter((_, j) => j % 2 === 0))]]))
    }
    ;(this.debug as Record<string, unknown>).grip = { palmGap: +(palm.min * 1000).toFixed(1), skinMin: +(all.min * 1000).toFixed(1), inside: all.inside, verts: skin.all.Left.length }
  }
  private torchBase = new THREE.Quaternion()
  private torchPosBase = new THREE.Vector3()
  private devAxisHand = new THREE.Vector3(0, 0, 1)
  private flexAxisHand = new THREE.Vector3(1, 0, 0)
  /** The barrel's fixed turn in the fist (rad): about the palm normal and about the knuckle line. */
  torchOffset = { dev: TORCH_DEV, flex: TORCH_FLEX }
  applyTorchOffset() {
    const r = new THREE.Quaternion().setFromAxisAngle(this.devAxisHand, this.torchOffset.dev).multiply(new THREE.Quaternion().setFromAxisAngle(this.flexAxisHand, this.torchOffset.flex))
    this.torch.quaternion.copy(r).multiply(this.torchBase)
    // Turned about its own grip point (the barrel stays through the fist).
    this.torch.position.copy(this.torchPosBase)
  }
  private fpRoll = 0
  private foreTwistNext = 0
  private carry2: { name: string; role: string; clip: THREE.AnimationClip; offset: number; samplers: Sampler[]; w: number }[] = []
  private gripAxisLocal = new THREE.Vector3(0, 0, 1)
  private palmLocal = new THREE.Vector3(0, -1, 0)
  /** Last frame's torch-hand IK targets (body frame). */
  private tPrev: { p: THREE.Vector3; q: THREE.Quaternion } | null = null

  /** Pelvis height onto the planted foot's ground, first-person eye anchoring, ladder placement and the slide meter. */
  private groundFeet(dt: number, s: BodyState, inAir: boolean) {
    this.model!.updateMatrixWorld(true)
    const B = this.bones
    const fl = B.LeftFoot!.getWorldPosition(new THREE.Vector3())
    const fr = B.RightFoot!.getWorldPosition(new THREE.Vector3())
    const tl = B.LeftToeBase!.getWorldPosition(new THREE.Vector3())
    const tr = B.RightToeBase!.getWorldPosition(new THREE.Vector3())
    if (dt > 0) {
      const pts = [fl, fr, tl, tr]
      const v: number[] = []
      for (let i = 0; i < 4; i++) {
        const rel = _v.copy(pts[i]!).sub(this.root.position)
        v.push(this.hasLastFoot ? Math.hypot((rel.x - this.lastFoot[i]!.x) / dt + s.vel.x, (rel.z - this.lastFoot[i]!.z) / dt + s.vel.z) : 0)
        this.lastFoot[i]!.copy(rel)
      }
      const hs = [0, 1].map((i) => Math.min(pts[i]!.y - this.restFoot[0]!, pts[i + 2]!.y - this.restFoot[1]!) - this.root.position.y)
      for (let i = 0; i < 2; i++) {
        // The supporting foot: the lower one (a swing foot can skim the floor, it isn't standing on it).
        const h = hs[i]!
        const planted = this.hasLastFoot && s.grounded && h < 0.02 && h <= hs[1 - i]! + 0.005
        this.debug.planted[i] = planted
        this.debug.slide[i] = planted ? this.debug.slide[i]! + (Math.min(v[i]!, v[i + 2]!) - this.debug.slide[i]!) * damp(20, dt) : 0
      }
      this.hasLastFoot = true
    }
    const base = this.root.position.y
    const top = s.pos.y + 0.45
    const gl = this.opts.ground(fl.x, fl.z, top)
    const gr = this.opts.ground(fr.x, fr.z, top)
    const k = 1 / (1 + Math.exp((fl.y - base - (fr.y - base)) / 0.02))
    let target = k * gl + (1 - k) * gr
    const ladderish = s.onLadder || this.topT >= 0 || !!s.mantle
    if (inAir || ladderish || this.stairW > 0.3) target = s.pos.y + this.yOff
    if (Number.isNaN(this.rootY) || Math.abs(target - this.rootY) > 1 || ladderish) this.rootY = target
    this.rootY += (target - this.rootY) * damp(inAir ? 40 : this.stairW > 0.3 ? 8 : 18, dt)
    this.root.position.y = this.rootY
    this.debug.pelvis = this.rootY - s.pos.y

    // First person: the eye point (ahead of the Head bone) under the camera. Not on a ladder (the hands must reach the
    // rungs there).
    const anchor = this.eyeAnchor && this.ladderW < 0.5 && this.topT < 0 && this.mantleW < 0.5
    if (anchor) {
      const e = B.Head!.getWorldPosition(_v)
      // The head faces the view (applyLook), so the eyes are ahead of it along the view's heading.
      const fx = -Math.sin(s.yaw)
      const fz = -Math.cos(s.yaw)
      const ahead = this.eyeAhead - this.lookDownLean * Math.max(0, -Math.sin(s.pitch)) + this.steepBack * smooth(0.7, 1.4, -s.pitch)
      const tx = -(e.x - this.root.position.x + fx * ahead)
      const tz = -(e.z - this.root.position.z + fz * ahead)
      const ke = damp(10, dt)
      this.eyeOff.x += (tx - this.eyeOff.x) * ke
      this.eyeOff.y += (tz - this.eyeOff.y) * ke
      this.debug.eye = e.y - this.root.position.y
    } else this.eyeOff.multiplyScalar(1 - damp(8, dt))
    let x = s.pos.x + this.eyeOff.x
    let z = s.pos.z + this.eyeOff.y
    // Ladder: the feet on the rung plane's climber side, the hands' reach off it.
    if (s.ladder && this.ladderW > 1e-3) {
      const n = s.ladder.normal
      const d = n[0] * s.pos.x + n[2] * s.pos.z - s.ladder.plane
      const lx = s.pos.x + n[0] * (this.ladderGap - d)
      const lz = s.pos.z + n[2] * (this.ladderGap - d)
      x += (lx - x) * this.ladderW
      z += (lz - z) * this.ladderW
    }
    this.root.position.x = x
    this.root.position.z = z

    // On a ladder (and climbing over its top) the body places the head: the camera belongs at its eyes, not on the
    // rung plane where the controller stands.
    // A mantle too: the camera rides with the head as it comes over the edge (no camera inside the arms or chest).
    const vw = Math.max(this.ladderW, this.topW, this.mantleW * MANTLE_VIEW)
    this.view.weight = vw
    if (vw > 1e-3) {
      this.root.updateMatrixWorld(true)
      const e = B.Head!.getWorldPosition(_v)
      e.y += 0.07
      e.x += Math.sin(this.facing) * 0.1
      e.z += Math.cos(this.facing) * 0.1
      if (this.view.eye.lengthSq() === 0 || this.view.eye.distanceToSquared(e) > 1) this.view.eye.copy(e)
      else this.view.eye.lerp(e, damp(14, dt))
    } else this.view.eye.set(0, 0, 0)
  }

  /** Lens position and beam direction (world), or false while the torch is put away. */
  torchLens(pos: THREE.Vector3, dir: THREE.Vector3) {
    // First person: from the viewmodel's lens.
    if (this.viewmodel.lens(pos)) {
      dir.copy(this.viewDir)
      return true
    }
    if (!this.torch.visible || !this.torch.parent || !this.torchHeld) return false
    const lens = this.torch.userData.lens as THREE.Object3D
    lens.updateWorldMatrix(true, false)
    lens.getWorldPosition(pos)
    // The beam goes where the player looks (the camera's forward), from the lens; the hand only places the emitter.
    dir.copy(this.viewDir)
    return true
  }

  /** Automation: model-space joint positions over one cycle of a clip. */
  trace(name: string, n = 60, joints = ["LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase", "Hips"]) {
    const clip = this.clips.get(name)
    if (!clip || !this.mixer || !this.model) return null
    const s = this.sample(clip, n, joints)
    const out: Record<string, number[][]> = {}
    for (const j of joints) out[j] = s[j]!.map((v) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)])
    return { duration: clip.duration, out }
  }

  /**
   * Automation: signed clearance (m) between the torch and the torso/thighs (capsules from the bones: torso radius
   * ~0.15 m, thigh ~0.085 m), minimum over the torch's sample points. Negative = interpenetration.
   */
  clearance() {
    if (!this.model || !this.torch.visible) return null
    const P = (n: string) => this.bones[n]!.getWorldPosition(new THREE.Vector3())
    const caps: [THREE.Vector3, THREE.Vector3, number, string][] = [
      [P("Hips"), P("Neck"), 0.15, "torso"],
      [P("LeftUpLeg"), P("LeftLeg"), 0.085, "thighL"],
      [P("RightUpLeg"), P("RightLeg"), 0.085, "thighR"],
    ]
    const seg = new THREE.Line3()
    const c = new THREE.Vector3()
    let min = Infinity
    let at = ""
    for (const z of [0.1, 0.05, 0, -0.08, -0.15]) {
      const p = this.torch.localToWorld(new THREE.Vector3(0, 0, z))
      for (const [a, b, r, n] of caps) {
        seg.set(a, b).closestPointToPoint(p, true, c)
        const d = p.distanceTo(c) - r - (z < -0.09 ? 0.027 : 0.018)
        if (d < min) {
          min = d
          at = `torch${z} vs ${n}`
        }
      }
    }
    return { min, at }
  }

  /** Automation: the measured clip speeds and ladder fit for this character. */
  info() {
    return { character: this.character, k: +this.k.toFixed(4), eyes: this.eyes, clips: this.debug.clips, ladderGap: +this.ladderGap.toFixed(3), top: { total: +this.top.total.toFixed(3), f0: +this.top.f0.toFixed(3), fEnd: +this.top.fEnd.toFixed(3), tEnd: this.top.tEnd } }
  }
}

/** Rotates a bone about a world axis through its own origin (its parent's world matrix must be current). */
function turnWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number) {
  if (Math.abs(angle) < 1e-6 || axis.lengthSq() < 1e-10) return
  const pq = bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()
  const a = axis.clone().normalize().applyQuaternion(pq)
  bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(a, angle))
  bone.updateWorldMatrix(false, true)
}

/**
 * Two-bone IK (upper a, lower b, end c): bends b so |c − a| = |target − a| (clamped to reach), swings a so c lands on
 * the target, then turns the chain about a→target so the middle joint points towards `pole` (world direction).
 */
export function twoBoneIK(a: THREE.Object3D, b: THREE.Object3D, c: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) {
  a.updateWorldMatrix(true, true)
  const A = a.getWorldPosition(new THREE.Vector3())
  const Bp = b.getWorldPosition(new THREE.Vector3())
  const C = c.getWorldPosition(new THREE.Vector3())
  const lab = A.distanceTo(Bp)
  const lbc = Bp.distanceTo(C)
  const T = target.clone()
  const at = T.clone().sub(A)
  const lat = THREE.MathUtils.clamp(at.length(), Math.abs(lab - lbc) + 1e-3, (lab + lbc) * 0.999)
  T.copy(A).addScaledVector(at.normalize(), lat)
  // 1. Bend at b.
  const u = Bp.clone().sub(A)
  const v = C.clone().sub(Bp)
  let n = new THREE.Vector3().crossVectors(u, v)
  if (n.lengthSq() < 1e-8) n = new THREE.Vector3().crossVectors(T.clone().sub(A), pole)
  const theta0 = Math.PI - u.angleTo(v)
  const theta1 = Math.acos(THREE.MathUtils.clamp((lab * lab + lbc * lbc - lat * lat) / (2 * lab * lbc), -1, 1))
  turnWorld(b, n, theta0 - theta1)
  // 2. Swing a onto the target.
  c.getWorldPosition(C)
  const ac = C.clone().sub(A)
  const aT = T.clone().sub(A)
  turnWorld(a, new THREE.Vector3().crossVectors(ac, aT), ac.angleTo(aT))
  // 3. Twist about a→target so the elbow points at the pole.
  const k = aT.normalize()
  b.getWorldPosition(Bp)
  const pb = Bp.sub(A)
  pb.addScaledVector(k, -pb.dot(k))
  const pp = pole.clone().addScaledVector(k, -pole.dot(k))
  if (pb.lengthSq() > 1e-8 && pp.lengthSq() > 1e-8) turnWorld(a, k, Math.atan2(k.dot(new THREE.Vector3().crossVectors(pb, pp)), pb.dot(pp)))
}

/** Moves the left forearm and hand triangles of a skinned mesh into their own mesh (same layer), sharing buffers. */
function splitArm(mesh: THREE.SkinnedMesh, bonesRe: RegExp) {
  const geo = mesh.geometry
  const index = geo.index
  const si = geo.getAttribute("skinIndex")
  const sw = geo.getAttribute("skinWeight")
  if (!index || !si || !sw) return null
  const arm = new Set(mesh.skeleton.bones.flatMap((b, i) => (bonesRe.test(b.name) ? [i] : [])))
  if (!arm.size) return null
  const on = new Uint8Array(si.count)
  for (let v = 0; v < si.count; v++) {
    let w = 0
    for (let k = 0; k < 4; k++) if (arm.has(si.getComponent(v, k))) w += sw.getComponent(v, k)
    on[v] = w > 0.5 ? 1 : 0
  }
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index.count, materialIndex: 0 }]
  const body: number[] = []
  const part: number[] = []
  const bodyGroups: [number, number, number][] = []
  const partGroups: [number, number, number][] = []
  for (const g of groups) {
    const b0 = body.length
    const p0 = part.length
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2)
      ;(on[a]! + on[b]! + on[c]! >= 2 ? part : body).push(a, b, c)
    }
    bodyGroups.push([b0, body.length - b0, g.materialIndex ?? 0])
    partGroups.push([p0, part.length - p0, g.materialIndex ?? 0])
  }
  if (!part.length) return null
  const pg = new THREE.BufferGeometry()
  for (const [n, a] of Object.entries(geo.attributes)) pg.setAttribute(n, a)
  pg.setIndex(part)
  geo.setIndex(body)
  if (geo.groups.length) {
    geo.clearGroups()
    for (const [s0, c, m] of bodyGroups) if (c) geo.addGroup(s0, c, m)
    for (const [s0, c, m] of partGroups) if (c) pg.addGroup(s0, c, m)
  }
  const pm = new THREE.SkinnedMesh(pg, mesh.material)
  pm.name = `${mesh.name}-arm`
  pm.bind(mesh.skeleton, mesh.bindMatrix)
  pm.frustumCulled = false
  pm.castShadow = mesh.castShadow
  pm.receiveShadow = true
  pm.layers.mask = mesh.layers.mask
  pm.position.copy(mesh.position)
  pm.quaternion.copy(mesh.quaternion)
  pm.scale.copy(mesh.scale)
  mesh.parent!.add(pm)
  return pm
}

/**
 * Moves the head/neck triangles of a skinned mesh (all three corners mostly weighted to head bones and above `minY` in
 * the bind pose) into their own mesh on HEAD_LAYER, sharing the geometry's attributes, materials and skeleton.
 */
function splitHead(mesh: THREE.SkinnedMesh, minY: number) {
  const geo = mesh.geometry
  const index = geo.index
  const si = geo.getAttribute("skinIndex")
  const sw = geo.getAttribute("skinWeight")
  const pos = geo.getAttribute("position")
  if (!index || !si || !sw || !pos) return
  const hb = new Set(mesh.skeleton.bones.flatMap((b, i) => (HEAD_BONES.test(b.name) ? [i] : [])))
  if (!hb.size) return
  const p = new THREE.Vector3()
  const isHead = new Uint8Array(si.count)
  for (let v = 0; v < si.count; v++) {
    let w = 0
    for (let k = 0; k < 4; k++) if (hb.has(si.getComponent(v, k))) w += sw.getComponent(v, k)
    if (w < 0.5) continue
    // Skinned (the files' positions may be quantized, dequantized by the bind matrix).
    mesh.getVertexPosition(v, p).applyMatrix4(mesh.matrixWorld)
    isHead[v] = p.y > minY ? 1 : 0
  }
  const idx = index.array
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: idx.length, materialIndex: 0 }]
  const body: number[] = []
  const head: number[] = []
  const bodyGroups: [number, number, number][] = []
  const headGroups: [number, number, number][] = []
  for (const g of groups) {
    const b0 = body.length
    const h0 = head.length
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const a = idx[i]!
      const b = idx[i + 1]!
      const c = idx[i + 2]!
      ;(isHead[a]! && isHead[b]! && isHead[c]! ? head : body).push(a, b, c)
    }
    bodyGroups.push([b0, body.length - b0, g.materialIndex ?? 0])
    headGroups.push([h0, head.length - h0, g.materialIndex ?? 0])
  }
  if (!head.length) return
  const headGeo = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(geo.attributes)) headGeo.setAttribute(name, attr)
  headGeo.setIndex(head)
  geo.setIndex(body)
  if (geo.groups.length) {
    geo.clearGroups()
    for (const [s, c, m] of bodyGroups) if (c) geo.addGroup(s, c, m)
    for (const [s, c, m] of headGroups) if (c) headGeo.addGroup(s, c, m)
  }
  const headMesh = new THREE.SkinnedMesh(headGeo, mesh.material)
  headMesh.name = `${mesh.name}-head`
  headMesh.bind(mesh.skeleton, mesh.bindMatrix)
  headMesh.frustumCulled = false
  headMesh.castShadow = true
  headMesh.receiveShadow = true
  headMesh.layers.set(HEAD_LAYER)
  headMesh.position.copy(mesh.position)
  headMesh.quaternion.copy(mesh.quaternion)
  headMesh.scale.copy(mesh.scale)
  mesh.parent!.add(headMesh)
}

/** Circle blend: weights of the two direction loops bracketing `ang` (rad, 0 forward, + right), linear in angle. */
function circle(loops: Loop[], ang: number) {
  const out = new Map<Loop, number>()
  if (!loops.length) return out
  if (loops.length === 1) return out.set(loops[0]!, 1)
  const sorted = [...loops].sort((a, b) => a.dir - b.dir)
  const wrap = (x: number) => ((x % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    const b = sorted[(i + 1) % sorted.length]!
    const span = wrap(b.dir - a.dir) || Math.PI * 2
    const off = wrap(ang - a.dir)
    if (off <= span) {
      const t = off / span
      out.set(a, (out.get(a) ?? 0) + 1 - t)
      out.set(b, (out.get(b) ?? 0) + t)
      return out
    }
  }
  return out
}

function sampleRoot(root: number[][], f: number) {
  const i = Math.floor(f)
  const j = Math.min(root.length - 1, i + 1)
  const t = f - i
  return root[i]!.map((v, k) => v + (root[j]![k]! - v) * t)
}

function nodeMaterial(src: THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[]): THREE.Material | THREE.Material[] {
  if (Array.isArray(src)) return src.map((m) => nodeMaterial(m) as THREE.Material)
  const m = new THREE.MeshStandardNodeMaterial({
    map: src.map,
    normalMap: src.normalMap,
    roughnessMap: src.roughnessMap,
    metalnessMap: src.metalnessMap,
    roughness: src.roughness,
    metalness: src.metalness,
    color: src.color,
  })
  m.name = src.name
  if (src.normalMap) m.normalScale.copy(src.normalScale)
  // The cabin shade scales the albedo colour (a uniform the material already has: no new pipelines).
  m.userData.baseColor = m.color.clone()
  shadedMats.push(m)
  if (src.transparent || src.alphaTest > 0 || /hair|lash/i.test(src.name)) {
    m.alphaTest = 0.4
    m.alphaToCoverage = true
    m.side = THREE.DoubleSide
    m.transparent = false
  }
  return m
}
