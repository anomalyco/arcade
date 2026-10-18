import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import ROSTER from "./roster.json"
import { createTorch } from "./torch"

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
//     right arm; the flashlight is the torch clips' left arm, raised and lowered with the view pitch. Spine, neck and
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
  steepBack = 0.05
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
    for (const n of [IDLE, CROUCH_IDLE, "ascending-stairs", "descending-stairs", "climbing-ladder", "falling-idle"]) {
      if (!this.clips.has(n)) continue
      const m = META.anims.clips[n]!
      const l: Loop = { name: n, action: act(n), duration: m.duration, speed: (m.speed ?? 0) * this.k, dir: 0, offset: 0, w: 0 }
      this.loops.set(n, l)
    }
    for (const n of ["jump", "left-turn-90", "right-turn-90", "climbing-to-top"]) if (this.clips.has(n)) this.shots.set(n, act(n))

    // Upper-body layers: tracks sampled directly and applied after the mixer (bone masks).
    for (const kind of Object.keys(INTERACT) as Interaction[]) {
      const clip = this.clips.get(INTERACT[kind].clip)
      this.reach[kind] = clip ? this.samplers(clip, REACH_ARM) : []
    }
    this.torchSamplers = []
    const ti = this.clips.get("torch-idle")
    const tw = this.clips.get("torch-walk-forward")
    if (ti && tw) {
      for (const s of this.samplers(ti, TORCH_ARM)) {
        const w = tw.tracks.find((x) => x.name === `${s.bone.name}.quaternion`)
        if (w) this.torchSamplers.push({ bone: s.bone, idle: s.interp, walk: interpOf(w) })
      }
      this.placeTorch()
    }
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
    const a = mixer.clipAction(this.clips.get("torch-idle")!)
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
    if (this.act && this.act.t < 0.6) return
    this.act = { kind, t: 0 }
    this.reachAt = target ? new THREE.Vector3(target.x, target.y, target.z) : null
  }

  update(dt: number, s: BodyState) {
    const mixer = this.mixer
    if (!mixer || !this.model) return
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
    const crouch = smooth(0.2, 0.8, s.crouch)
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

    // Stairs: the feet's ground rising or falling while walking (|vy| over ~0.12 m/s) swaps in the stair clips.
    // Going down uses the flat gait (with the pelvis offset): the downloaded "descending-stairs" is a single step into
    // a squat, not a stair loop (scripts/playerb/mixamo.py marks it "broken"), until a real one is downloaded.
    if (Math.abs(this.vy) > 0.12) this.stairDir = Math.sign(this.vy)
    const downOk = META.anims.clips["descending-stairs"]?.kind === "climb"
    const climbing = moving * smooth(0.12, 0.3, Math.abs(this.vy)) * (1 - crouch) * (this.stairDir >= 0 || downOk ? 1 : 0)
    this.stairW += (climbing - this.stairW) * damp(6, dt)
    const stairs = this.loops.get(this.stairDir >= 0 ? "ascending-stairs" : "descending-stairs")
    const flat = 1 - this.stairW
    for (const [ws, gwt] of set) for (const [l, x] of ws) l.w += x * gwt * flat
    if (stairs) {
      stairs.w += this.stairW
      stairs.action.time = (this.phase * stairs.duration + stairs.offset) % stairs.duration
    }

    // Airborne: the jump clip scrubbed between take-off and landing by vertical velocity; long falls loop falling.
    const jm = META.anims.clips.jump
    if (!s.grounded && !s.onLadder && this.wasGrounded) this.airT = 0
    if (s.grounded && !this.wasGrounded && this.topOut < 0) this.landT = 0
    const leftLadder = this.ladderW > 0.5 && !s.onLadder
    this.wasGrounded = s.grounded || s.onLadder
    const inAir = !s.grounded && !s.onLadder
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
    if (s.onLadder && s.ladder) {
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
    this.root.rotation.y = this.facing

    // Apply weights: the one-shots take their share from everything else.
    const over = Math.min(1, turnW + jumpW + (s.onLadder ? 0 : topW))
    const rest = 1 - over
    for (const l of this.loops.values()) {
      const wt = l.w * (l.name === "falling-idle" ? 1 : rest)
      l.action.setEffectiveWeight(wt)
      if (wt > 0.01) w[l.name] = wt
      if (GAITS.walk.includes(l.name) || GAITS.jog.includes(l.name) || GAITS.run.includes(l.name) || GAITS.crouch.includes(l.name)) l.action.time = (l.offset + this.phase * l.duration) % l.duration
    }
    for (const [n, a] of this.shots) {
      const wt = n === "jump" ? jumpW : n === "climbing-to-top" ? topW : this.turn?.clip === n ? turnW : 0
      a.setEffectiveWeight(wt)
      if (wt > 0.01) w[n] = wt
    }
    this.debug.phase = this.phase
    this.debug.state = this.topT >= 0 ? "ladder top" : inAir ? "air" : s.onLadder ? "ladder" : this.turn ? "turn" : speed < 0.1 ? (crouch > 0.5 ? "crouch" : "idle") : crouch > 0.5 ? "crouch walk" : this.stairW > 0.5 ? "stairs" : "move"
    mixer.update(0)
    this.root.updateMatrixWorld(true)

    this.applyLook(s, (1 - ladderW) * (1 - topW))
    this.applyInteract(dt, s, ladderW)
    this.applyTorch(dt, s, moving)
    if (this.act) w[`E ${this.act.kind}`] = 1
    this.groundFeet(dt, s, inAir)
  }

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
    const yaw = THREE.MathUtils.clamp(wrapPi(s.yaw + Math.PI - this.facing), -1.3, 1.3) * k
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
   * two-bone IK: the fist ahead of the chest on the left, below the eyes, the barrel along the view (lagging it a
   * little), swaying with the gait, the elbow down and out. The right hand stays free for E.
   */
  private applyTorch(dt: number, s: BodyState, moving: number) {
    this.carryW += ((s.flashlight && !s.onLadder && this.topT < 0 ? 1 : 0) - this.carryW) * damp(7, dt)
    this.torch.visible = this.carryW > 0.35
    const B = this.bones
    if (this.carryW < 1e-3 || !this.torch.parent || !B.LeftArm || !B.LeftForeArm || !B.LeftHand || !B.Head) return
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
    const cp = Math.cos(s.pitch)
    _v.set(-Math.sin(s.yaw) * cp, Math.sin(s.pitch), -Math.cos(s.yaw) * cp)
    if (c.aim.lengthSq() < 0.5) c.aim.copy(_v)
    else c.aim.lerp(_v, damp(14, dt)).normalize()
    const aim = c.aim

    // Grip point: offsets from the eyes in a frame pitched by part of the view pitch.
    const yawF = _v.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw))
    const left = _left.set(-Math.cos(s.yaw), 0, Math.sin(s.yaw))
    const pk = THREE.MathUtils.clamp(s.pitch, -1.2, 1.0) * c.pitchFollow
    const fwd = _v2.copy(yawF).multiplyScalar(Math.cos(pk)).addScaledVector(UP, Math.sin(pk))
    const up = _v3.copy(UP).multiplyScalar(Math.cos(pk)).addScaledVector(yawF, -Math.sin(pk))
    const eye = B.Head.getWorldPosition(_v4).addScaledVector(UP, 0.07).addScaledVector(yawF, 0.09)
    const ph = this.phase * Math.PI * 2
    const bob = moving * (0.012 * Math.sin(2 * ph) + (this.gaitW.run + this.gaitW.jog) * 0.012 * Math.sin(2 * ph))
    const sway = moving * 0.012 * Math.sin(ph)
    const grip = c.grip
      .copy(eye)
      .addScaledVector(fwd, c.forward)
      .addScaledVector(up, -c.down + bob)
      .addScaledVector(left, c.side + sway)

    // Torch frame: -Z along the aim; +Y (from the curled fingers to the palm) inward and a little down (thumb on top),
    // then rolled towards the forearm's line once the arm is placed (less wrist bend).
    const z = _z.copy(aim).negate()
    const y = _y.set(0, -c.palmDown, 0).addScaledVector(left, -1)
    const x = _x
    const handQ = _q2
    const hs = B.LeftHand.getWorldScale(_v4).x
    const cur = B.LeftHand.getWorldPosition(_v5).clone()
    // Elbow: down, out to the left and back.
    const pole = _v6.set(0, -1, 0).addScaledVector(left, 0.5).addScaledVector(yawF, -0.6).clone()
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) {
        const fore = _v3.copy(B.LeftForeArm.getWorldPosition(_v4)).sub(B.LeftHand.getWorldPosition(_v5))
        fore.addScaledVector(z, -fore.dot(z))
        if (fore.lengthSq() > 1e-6) y.lerp(fore.normalize(), c.followForearm)
      }
      y.addScaledVector(z, -y.dot(z)).normalize()
      x.crossVectors(y, z)
      _m.makeBasis(x, y, z)
      handQ.setFromRotationMatrix(_m).multiply(_qa.copy(this.torch.quaternion).invert())
      const handPos = _v4.copy(this.torch.position).multiplyScalar(hs).applyQuaternion(handQ).negate().add(grip)
      // Blend from the clip's arm by moving the target from where the hand was.
      handPos.lerp(cur, 1 - w)
      twoBoneIK(B.LeftArm, B.LeftForeArm, B.LeftHand, handPos, pole)
    }
    // The fist's orientation, half of its twist taken by the forearm (no candy-wrapped wrist).
    const fa = B.LeftForeArm
    const local = _qb.copy(fa.getWorldQuaternion(_qc)).invert().multiply(handQ)
    const curLocal = B.LeftHand.quaternion
    _qd.copy(curLocal).slerp(local, w)
    const tw = _qe.set(0, _qd.y, 0, _qd.w).normalize()
    const half = _qc.identity().slerp(tw, 0.5)
    fa.quaternion.multiply(half)
    fa.updateWorldMatrix(false, false)
    _qb.copy(fa.getWorldQuaternion(_qc)).invert().multiply(handQ)
    B.LeftHand.quaternion.slerp(_qb, w)
    B.LeftArm.updateWorldMatrix(false, true)
  }

  /**
   * Flashlight carry: grip ahead of / below / left of the eyes (m) in a frame that takes `pitchFollow` of the view
   * pitch (you see the hand and torch when you look down), roll towards the forearm, palm down vs inward.
   */
  readonly carry = { forward: 0.37, down: 0.24, side: 0.15, pitchFollow: 0.9, followForearm: 0.4, palmDown: 0.4, aim: new THREE.Vector3(), grip: new THREE.Vector3() }

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
    const ladderish = s.onLadder || this.topT >= 0
    if (inAir || ladderish || this.stairW > 0.3) target = s.pos.y + this.yOff
    if (Number.isNaN(this.rootY) || Math.abs(target - this.rootY) > 1 || ladderish) this.rootY = target
    this.rootY += (target - this.rootY) * damp(inAir ? 40 : this.stairW > 0.3 ? 8 : 18, dt)
    this.root.position.y = this.rootY
    this.debug.pelvis = this.rootY - s.pos.y

    // First person: the eye point (ahead of the Head bone) under the camera. Not on a ladder (the hands must reach the
    // rungs there).
    const anchor = this.eyeAnchor && this.ladderW < 0.5 && this.topT < 0
    if (anchor) {
      const e = B.Head!.getWorldPosition(_v)
      // The head faces the view (applyLook), so the eyes are ahead of it along the view's heading.
      const fx = -Math.sin(s.yaw)
      const fz = -Math.cos(s.yaw)
      const ahead = this.eyeAhead - this.lookDownLean * Math.max(0, -Math.sin(s.pitch)) + this.steepBack * smooth(1.15, 1.45, -s.pitch)
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
  }

  /** Lens position and beam direction (world), or false while the torch is put away. */
  torchLens(pos: THREE.Vector3, dir: THREE.Vector3) {
    if (!this.torch.visible || !this.torch.parent) return false
    const lens = this.torch.userData.lens as THREE.Object3D
    lens.updateWorldMatrix(true, false)
    lens.getWorldPosition(pos)
    dir.set(0, 0, -1).transformDirection(lens.matrixWorld)
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
function twoBoneIK(a: THREE.Object3D, b: THREE.Object3D, c: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) {
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
  if (src.transparent || src.alphaTest > 0 || /hair|lash/i.test(src.name)) {
    m.alphaTest = 0.4
    m.alphaToCoverage = true
    m.side = THREE.DoubleSide
    m.transparent = false
  }
  return m
}
