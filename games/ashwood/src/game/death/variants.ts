import * as THREE from "three/webgpu"
import type { Wendigo } from "../../creatures/wendigo"
import { aimBone, twoBoneIK } from "../../creatures/kit/ik"
import { encounterLights } from "../encounters/lights"

// Death jump scares (the Wendigo catching the player), three to compare (death-lab.html):
//   A  lunge and hold  it rushes in (~0.35 s), stops hard ~0.5 m from the face, holds with the jaw opening wide and a
//                      head twitch, then snaps forward into the red
//   B  grab and pull   clawed hands come in from both sides and grip, the view is yanked forward and tilted, the skull
//                      rises into frame from below, screams, red
//   C  slam down       knocked backward: the view drops and tilts to the floor, looking up as it looms over and lowers
//                      its skull toward the lens, screams, red
// Every variant keeps the face the subject: the skull centred and large (~50–70 % of the frame height at the
// climax), lit by a cold face light, jaws opening, the scream in sync. The camera never ends up in the creature: the
// skull's nearest point stays ≥ MIN_FACE m from the eye (the body is pushed back if it would come closer), and the
// creature material's close-up cut discards everything but the face that lies between the eye and the skull, and
// everything within NEAR_CUT of the eye.
//
//   await playDeath("A", { camera, wendigo, ground, from, tick, scream, flood, lights })   // then the death screen
//   clearDeath(wendigo, lights)                                                             // restart

export type DeathName = "charge" | "spin" | "maul" | "A" | "B" | "C"
/** The current set: the whole creature is seen for most of each. */
export const DEATHS_NEW = { charge: "Charge", spin: "Grab and turn" } as const
/** The first set (face-only close-ups), kept for comparison. */
export const DEATHS_OLD = { A: "Lunge and hold", B: "Grab and pull", C: "Slam down" } as const
/** In-game only (it starts from wherever the creature already is): the hunter caught you face to face. */
export const DEATHS_GAME = { maul: "Maul (in place)" } as const
export const DEATHS: Record<DeathName, string> = { ...DEATHS_NEW, ...DEATHS_GAME, ...DEATHS_OLD }
const NAMES = Object.keys(DEATHS) as DeathName[]
/** The hunter's catch uses this until the owner picks (death-lab.html "Use in game" stores the pick, dev only). */
export const DEATH_DEFAULT: DeathName = "charge"
const PICK_KEY = "ashwood.deathVariant"
export function deathVariant(): DeathName {
  try {
    const v = localStorage.getItem(PICK_KEY)
    if (v && (NAMES as string[]).includes(v)) return v as DeathName
  } catch {}
  return DEATH_DEFAULT
}
export function pickDeathVariant(v: DeathName) {
  try {
    localStorage.setItem(PICK_KEY, v)
  } catch {}
}

/** Closest the skull may come to the eye (m). */
export const MIN_FACE = 0.38
/** Everything nearer than this to the eye is cut (m). */
const NEAR_CUT = 0.3

export type DeathLights = { face: THREE.PointLight; body: THREE.SpotLight }
/**
 * Adds the death scenes' lights to the scene, dark (lights added later recompile every lit material: a stall): a cold
 * point light on the face at the climax, and a wide cold spot from beside the eye that catches the torso and limbs.
 */
export function prepareDeathLights(scene: THREE.Scene): DeathLights {
  // The boot-created lights (src/game/encounters/lights.ts): never added at runtime.
  const l = encounterLights(scene)
  return { face: l.face, body: l.body }
}

/** `body`: fraction of the creature's key points (feet, hands, hips, head, crown) inside the frame. */
export type DeathMeasure = { t: number; nearest: number; fill: number; cx: number; cy: number; phase: string; body: number }

export type DeathCtx = {
  camera: THREE.PerspectiveCamera
  /** A warmed creature (it is placed, posed and shown here). */
  wendigo: Wendigo
  /** Floor height under the player. */
  ground: number
  /** Where it comes from (world); default 2.6 m ahead of the eye. */
  from?: THREE.Vector3
  /** Per-frame hook before the frame renders (the game: flow.onUpdate). Returns an unsubscribe. */
  tick: (fn: (dt: number) => void) => () => void
  scream: () => void
  /** Teeth chattering / a bite snap (wen2-chatter), optional. */
  chatter?: () => void
  flood: () => void
  lights: DeathLights
  /** The creature's world velocity when the scene takes over (the maul carries it on). */
  velocity?: THREE.Vector3
  /** Ceiling over the floor (world y), so it stoops under it upright. */
  ceiling?: number
  /** Free distance from a point along a horizontal direction (walls), so a scene fits the room. */
  free?: (from: THREE.Vector3, dir: THREE.Vector3) => number
  /** The canvas (motion blur on fast forced turns). */
  canvas?: HTMLElement
  /** Automation / the lab: measurements each frame. */
  onMeasure?: (m: DeathMeasure) => void
}

/** Skull and jaw sample points (head-bone frame / jaw-bone frame, bind has no bone rotation). */
type FacePts = { skull: Float32Array; jaw: Float32Array; centre: THREE.Vector3 }
const faceCache = new WeakMap<object, FacePts>()
function facePoints(w: Wendigo): FacePts {
  const rig = w.rig!
  let f = faceCache.get(rig)
  if (f) return f
  const d = rig.data
  const pick = (part: string, bone: string) => {
    const p = d.parts.find((q) => q.name === part)
    const b = d.bones[rig.bones.indexOf(rig.byName.get(bone)!)]!.head
    const seen = new Set<number>()
    if (p) for (let k = p.start; k < p.start + p.count; k += 3) seen.add(d.indices[k]!)
    const out = new Float32Array(seen.size * 3)
    let i = 0
    for (const v of seen) {
      out[i++] = d.positions[v * 3]! - b[0]
      out[i++] = d.positions[v * 3 + 1]! - b[1]
      out[i++] = d.positions[v * 3 + 2]! - b[2]
    }
    return out
  }
  const skull = pick("skull", "head")
  const jaw = pick("jaw", "jaw")
  const centre = new THREE.Vector3()
  for (let i = 0; i < skull.length; i += 3) centre.x += skull[i]!, centre.y += skull[i + 1]!, centre.z += skull[i + 2]!
  centre.divideScalar(skull.length / 3)
  f = { skull, jaw, centre }
  faceCache.set(rig, f)
  return f
}

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const UP = new THREE.Vector3(0, 1, 0)
const ZERO = new THREE.Vector3()
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Shared per-frame machinery for the variants. */
class Scene {
  w: Wendigo
  cam: THREE.PerspectiveCamera
  eye0 = new THREE.Vector3()
  yaw0 = 0
  pitch0 = 0
  /** Camera pose this frame (set by the variant), plus shake added on top. */
  eye = new THREE.Vector3()
  yaw = 0
  pitch = 0
  roll = 0
  shake = 0
  centre = new THREE.Vector3()
  nearest = 99
  face: FacePts
  private m = new THREE.Matrix4()
  constructor(public c: DeathCtx) {
    this.w = c.wendigo
    this.cam = c.camera
    this.face = facePoints(this.w)
    this.cam.getWorldPosition(this.eye0)
    this.cam.getWorldDirection(_v)
    this.yaw0 = Math.atan2(-_v.x, -_v.z)
    this.pitch0 = Math.asin(Math.max(-1, Math.min(1, _v.y))) * 0.4
    this.eye.copy(this.eye0)
    this.yaw = this.yaw0
    this.pitch = this.pitch0
  }
  /** Horizontal forward / right of the starting view. */
  get fwd() {
    return new THREE.Vector3(-Math.sin(this.yaw0), 0, -Math.cos(this.yaw0))
  }
  get right() {
    return new THREE.Vector3(Math.cos(this.yaw0), 0, -Math.sin(this.yaw0))
  }
  /** Current view direction. */
  viewDir(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch))
  }
  applyCamera(t: number) {
    const s = this.shake
    this.cam.position.set(
      this.eye.x + (Math.sin(t * 61) + Math.sin(t * 37.3)) * 0.006 * s,
      this.eye.y + (Math.sin(t * 53.1) + Math.sin(t * 29.7)) * 0.006 * s,
      this.eye.z + Math.sin(t * 47.9) * 0.006 * s,
    )
    this.cam.rotation.set(this.pitch + Math.sin(t * 31) * 0.01 * s, this.yaw + Math.sin(t * 43) * 0.012 * s, this.roll + Math.sin(t * 39) * 0.012 * s, "YXZ")
    this.cam.updateMatrixWorld(true)
  }
  /** Eases the view toward the skull centre (keeps the face centred). */
  aimAtFace(k: number) {
    _v.subVectors(this.centre, this.eye)
    const yaw = Math.atan2(-_v.x, -_v.z)
    const pitch = Math.atan2(_v.y, Math.hypot(_v.x, _v.z))
    let dy = yaw - this.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.yaw += dy * k
    this.pitch += (pitch - this.pitch) * k
  }
  /**
   * Poses the body (animator), opens the jaw `jaw` rad more, turns the face toward the eye (`tilt` rad snout-down),
   * twitches it, then moves the whole creature so the skull centre lands on `target` (root height kept in [yMin, yMax])
   * and pushes it back if the skull would come within MIN_FACE of the eye.
   */
  pose(dt: number, o: { mode: "idle" | "lunge" | "rear" | "stalk"; stance: "quad" | "biped"; target: THREE.Vector3; tilt: number; jaw: number; twitch?: [number, number]; yMin: number; yMax: number; bend?: number; arms?: (s: Scene) => void }) {
    const w = this.w
    const rig = w.rig!
    // Face the eye (yaw only) before posing.
    _v.subVectors(this.eye, w.root.position)
    w.root.rotation.set(0, Math.atan2(_v.x, _v.z), 0)
    w.update(dt, { mode: o.mode, stance: o.stance, target: this.eye, velocity: ZERO, ceiling: this.c.ceiling })
    if (o.bend) rig.byName.get("hips")!.quaternion.premultiply(_q.setFromAxisAngle(_v2.set(1, 0, 0), o.bend))
    rig.byName.get("jaw")!.quaternion.multiply(_q.setFromEuler(_e.set(o.jaw, 0, 0)))
    w.root.updateMatrixWorld(true)
    const hb = rig.byName.get("head")!
    const hi = rig.bones.indexOf(hb)
    // Face toward the eye, snout tilted down so the long face shows.
    void hi
    this.faceOut(1, o.twitch, o.tilt)
    // Skull centre to the target.
    this.skullCentre(this.centre)
    const dx = o.target.x - this.centre.x
    const dz = o.target.z - this.centre.z
    const p = w.root.position
    p.x += dx
    p.z += dz
    p.y = Math.min(o.yMax, Math.max(o.yMin, p.y + o.target.y - this.centre.y))
    w.root.updateMatrixWorld(true)
    o.arms?.(this)
    // Keep the face off the lens.
    for (let it = 0; it < 3; it++) {
      this.nearest = this.faceNearest()
      if (this.nearest >= MIN_FACE) break
      _v.subVectors(this.centre, this.eye).setY(0).normalize()
      p.addScaledVector(_v, MIN_FACE - this.nearest + 0.01)
      w.root.updateMatrixWorld(true)
    }
    this.skullCentre(this.centre)
  }
  /**
   * The face always points out at the eye: the neck chain swings toward the eye (extended forward, `k` of the way),
   * then the skull's snout aims at the eye, tilted `tilt` rad (negative: snout up), and is clamped so it never points
   * steeply down (into its own chest).
   */
  faceOut(k = 1, twitch?: [number, number], tilt = -0.12) {
    const rig = this.w.rig!
    const bi = (n: string) => rig.bones.indexOf(rig.byName.get(n)!)
    for (const [n, wgt] of [
      ["neck1", 0.35],
      ["neck2", 0.55],
      ["neck3", 0.75],
    ] as const) {
      const b = rig.byName.get(n)!
      b.getWorldPosition(_v)
      _v2.subVectors(this.eye, _v)
      // Keep the neck reaching forward and a little up, not drooping.
      _v2.y = Math.max(_v2.y, -0.25 * Math.hypot(_v2.x, _v2.z))
      aimBone(rig, bi(n), _v2.normalize(), wgt * k)
    }
    const hb = rig.byName.get("head")!
    hb.getWorldPosition(_v)
    const to = _v2.subVectors(this.eye, _v).normalize()
    const side = new THREE.Vector3().crossVectors(to, UP).normalize()
    const down = new THREE.Vector3().crossVectors(side, to).negate()
    const dir = to.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(down, Math.sin(tilt))
    if (twitch) dir.addScaledVector(side, twitch[0]).addScaledVector(UP, twitch[1])
    dir.normalize()
    // Clamp: at most 20° below horizontal.
    const h = Math.hypot(dir.x, dir.z)
    const minY = -Math.tan(0.35) * h
    if (dir.y < minY) dir.y = minY
    aimBone(rig, rig.bones.indexOf(hb), dir.normalize(), k)
  }

  /** Opens the jaw `a` rad beyond the animator's. */
  openJaw(a: number) {
    const j = this.w.rig!.byName.get("jaw")!
    j.quaternion.multiply(_q.setFromEuler(_e.set(a, 0, 0)))
    j.updateMatrixWorld(true)
  }

  skullCentre(out: THREE.Vector3) {
    return out.copy(this.face.centre).applyMatrix4(this.headMatrix())
  }
  private headMatrix() {
    const hb = this.w.rig!.byName.get("head")!
    // Bone world matrix maps head-local (bind offsets from the bone head) to world.
    return this.m.copy(hb.matrixWorld)
  }
  /** Nearest skull or jaw point to the eye (m). */
  faceNearest() {
    const rig = this.w.rig!
    let best = Infinity
    const scan = (pts: Float32Array, bone: THREE.Bone) => {
      const e = bone.matrixWorld.elements
      for (let i = 0; i < pts.length; i += 6) {
        const x = pts[i]!
        const y = pts[i + 1]!
        const z = pts[i + 2]!
        const wx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!
        const wy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!
        const wz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!
        const d = Math.hypot(wx - this.eye.x, wy - this.eye.y, wz - this.eye.z)
        if (d < best) best = d
      }
    }
    scan(this.face.skull, rig.byName.get("head")!)
    scan(this.face.jaw, rig.byName.get("jaw")!)
    return best
  }
  /** Face and body light, the close-up cut (`cutOn`: the final moment only) and a measurement. */
  finish(t: number, light: number, phase: string, cutOn = true, bodyLight = 0) {
    const { face, body } = this.c.lights
    if (cutOn || phase === "strike") this.nearest = this.faceNearest()
    this.skullCentre(this.centre)
    _v.subVectors(this.centre, this.eye)
    // In front of the mouth, from above the eye line: the teeth catch it, the throat stays in shadow behind them.
    face.position.copy(this.eye).addScaledVector(_v, 0.6)
    face.position.y += 0.16
    face.intensity = 7 * light
    // Body light: from just above and right of the eye, onto the hips (wide enough for the whole creature).
    this.cam.getWorldDirection(_v2)
    body.position.copy(this.eye).addScaledVector(_v2, -0.2)
    body.position.y += 0.45
    this.w.rig!.byName.get("hips")!.getWorldPosition(body.target.position)
    body.target.updateMatrixWorld()
    body.intensity = 30 * bodyLight
    // Cut: the cone from the eye toward the skull, closer than the face's nearest point.
    const cut = this.w.cut
    if (cut && !cutOn) cut.cutOn.value = 0
    if (cut && cutOn) {
      this.cam.updateMatrixWorld(true)
      const view = _v2.copy(this.centre).applyMatrix4(this.cam.matrixWorldInverse)
      const dist = view.length()
      cut.cutOn.value = 1
      cut.cutDir.value.copy(view).normalize()
      cut.cutCos.value = Math.cos(Math.min(1.1, Math.atan2(0.42, dist)))
      cut.cutDist.value = Math.max(0, this.nearest - 0.03)
      cut.nearCut.value = NEAR_CUT
    }
    if (this.c.onMeasure) {
      // Screen box of the face (skull + jaw sample).
      const rig = this.w.rig!
      let y0 = 1
      let y1 = -1
      let x0 = 1
      let x1 = -1
      const proj = (pts: Float32Array, bone: THREE.Bone) => {
        for (let i = 0; i < pts.length; i += 12) {
          _v.set(pts[i]!, pts[i + 1]!, pts[i + 2]!).applyMatrix4(bone.matrixWorld).project(this.cam)
          if (_v.z > 1) continue
          y0 = Math.min(y0, _v.y)
          y1 = Math.max(y1, _v.y)
          x0 = Math.min(x0, _v.x)
          x1 = Math.max(x1, _v.x)
        }
      }
      proj(this.face.skull, rig.byName.get("head")!)
      proj(this.face.jaw, rig.byName.get("jaw")!)
      const c = _v.copy(this.centre).project(this.cam)
      // Whole-creature check: key points inside the frame.
      let inn = 0
      const keys = ["metaL", "metaR", "handL", "handR", "hips", "head"]
      for (const k of keys) {
        rig.byName.get(k)!.getWorldPosition(_v).project(this.cam)
        if (_v.z < 1 && Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1) inn++
      }
      // The crown (antlers ~0.9 m above the head joint).
      rig.byName.get("head")!.getWorldPosition(_v)
      _v.y += 0.9
      _v.project(this.cam)
      if (_v.z < 1 && Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1) inn++
      this.c.onMeasure({ t, body: +(inn / 7).toFixed(2), nearest: +this.nearest.toFixed(3), fill: +(Math.max(0, Math.min(1, y1) - Math.max(-1, y0)) / 2).toFixed(2), cx: +c.x.toFixed(2), cy: +c.y.toFixed(2), phase })
      void x0
      void x1
    }
  }
}

/** Plays a death scene; resolves once the red flood is up and the hit has settled (then show the death screen). */
export function playDeath(name: DeathName, ctx: DeathCtx): Promise<void> {
  const s = new Scene(ctx)
  const w = ctx.wendigo
  const a = w.animator!
  a.stoop = 0
  a.lungeStop = 0.1
  w.setShade(1)
  w.root.visible = true
  const script = { A: lungeHold, B: grabPull, C: slamDown, charge, spin, maul }[name](s)
  return new Promise((done) => {
    let t = 0
    const off = ctx.tick((dt) => {
      dt = Math.min(dt, 1 / 20)
      t += dt
      if (script(t, dt)) {
        off()
        done()
      }
      s.applyCamera(t)
    })
  })
}

/** After a restart: hides the creature and clears the close-up state. */
export function clearDeath(w: Wendigo | null, lights: DeathLights | null) {
  if (lights) lights.face.intensity = lights.body.intensity = 0
  if (!w) return
  w.root.visible = false
  w.setShade(1)
  if (w.cut) w.cut.cutOn.value = 0
  if (w.animator) {
    w.animator.stoop = 0
    w.animator.lungeStop = 3
  }
}

// ------------------------------------------------------------------------------------------------- A: lunge and hold

function lungeHold(s: Scene) {
  const c = s.c
  const fwd = s.fwd
  const start = c.from?.clone() ?? s.eye0.clone().addScaledVector(fwd, 2.6)
  const S0 = new THREE.Vector3(start.x, s.eye0.y - 0.15, start.z)
  const S1 = s.eye0.clone().addScaledVector(fwd, 0.95)
  S1.y -= 0.05
  const S2 = s.eye0.clone().addScaledVector(fwd, 0.62)
  S2.y -= 0.04
  const target = new THREE.Vector3()
  s.w.animator!.snapStance("quad")
  s.w.root.position.set(start.x, c.ground, start.z)
  let screamed = false
  let flooded = false
  return (t: number, dt: number) => {
    let phase = "rush"
    let jaw = 0.1
    let twitch: [number, number] | undefined
    if (t < 0.35) {
      const k = t / 0.35
      target.lerpVectors(S0, S1, 1 - (1 - k) ** 3)
      s.shake = 0.3
    } else if (t < 0.78) {
      phase = "hold"
      if (!screamed) {
        screamed = true
        c.scream()
      }
      target.copy(S1)
      const h = t - 0.35
      jaw = 0.1 + 0.85 * smooth(0, 0.25, h)
      // Two snaps of the head: hard, then decaying.
      const tw = (at: number, amp: number) => (h > at ? Math.exp(-(h - at) * 18) * amp : 0)
      twitch = [tw(0.08, 0.32) - tw(0.24, 0.26), tw(0.08, -0.12) + tw(0.24, 0.1)]
      s.shake = 0.6 + (h < 0.06 ? 3 : 0)
      // The hard stop jolts the view back a little.
      s.eye.copy(s.eye0).addScaledVector(fwd, -0.05 * Math.exp(-h * 9))
    } else {
      phase = "snap"
      const k = Math.min(1, (t - 0.78) / 0.1)
      target.lerpVectors(S1, S2, k * k)
      jaw = 0.95
      s.shake = 2.5 * Math.exp(-(t - 0.78) * 4)
      if (!flooded && t > 0.82) {
        flooded = true
        c.flood()
      }
    }
    s.pose(dt, { mode: "lunge", stance: "quad", target, tilt: 0.55, jaw, twitch, yMin: c.ground - 0.3, yMax: c.ground + 0.9 })
    s.aimAtFace(phase === "rush" ? 0.25 : 0.35)
    s.finish(t, phase === "rush" ? Math.min(1, t / 0.2) : 1, phase)
    return t > 1.3
  }
}

// ------------------------------------------------------------------------------------------------- B: grab and pull

function grabPull(s: Scene) {
  const c = s.c
  const fwd = s.fwd
  const right = s.right
  const rig = s.w.rig!
  const bi = (n: string) => rig.bones.indexOf(rig.byName.get(n)!)
  const target = new THREE.Vector3()
  const handL = new THREE.Vector3()
  const handR = new THREE.Vector3()
  const pole = new THREE.Vector3()
  s.w.animator!.snapStance("quad")
  const base = s.eye0.clone().addScaledVector(fwd, 1.3)
  s.w.root.position.set(base.x, c.ground, base.z)
  let screamed = false
  let flooded = false
  // Where the hands grip, relative to the (moving) eye.
  const grip = (side: number, out: THREE.Vector3, k: number) =>
    out
      .copy(s.eye)
      .addScaledVector(right, side * (0.95 - 0.58 * k))
      .addScaledVector(fwd, 0.62 - 0.18 * k)
      .add(_v.set(0, -0.12 + 0.06 * k, 0))
  const arms = (sc: Scene, k: number) => {
    for (const [n, side] of [
      ["L", 1],
      ["R", -1],
    ] as const) {
      const h = side > 0 ? handL : handR
      // Its left hand comes in on the view's right (it faces the eye).
      grip(-side, h, k)
      pole.copy(right).multiplyScalar(-side).add(_v.set(0, -0.6, 0))
      twoBoneIK(rig, bi(`uarm${n}`), bi(`farm${n}`), h, pole)
      aimBone(rig, bi(`hand${n}`), _v.subVectors(sc.eye, h).normalize().addScaledVector(right, side * 0.6).normalize())
    }
  }
  return (t: number, dt: number) => {
    let phase = "hands"
    let jaw = 0.15
    // Hands in from the sides (0–0.28 s), gripping.
    const kh = smooth(0, 0.28, t)
    // Yank (0.28–0.45 s): the eye pulled forward and tilted.
    const ky = smooth(0.28, 0.42, t)
    s.eye.copy(s.eye0).addScaledVector(fwd, 0.34 * ky)
    s.eye.y -= 0.12 * ky
    s.roll = 0.28 * ky
    // Skull rises from below into the centre (0.4–0.8 s).
    const kr = smooth(0.4, 0.78, t)
    target.copy(s.eye).addScaledVector(fwd, 0.9)
    target.y += -0.85 * (1 - kr) - 0.04
    if (t > 0.28) phase = "yank"
    if (t > 0.4) phase = "rise"
    if (t > 0.6) {
      phase = "scream"
      if (!screamed) {
        screamed = true
        c.scream()
      }
      jaw = 0.15 + 0.8 * smooth(0.6, 0.85, t)
    }
    s.shake = (t > 0.28 && t < 0.45 ? 2.2 : 0.4) + (t > 0.6 ? 0.8 : 0)
    if (!flooded && t > 1.05) {
      flooded = true
      c.flood()
      s.shake = 2.5
    }
    s.pose(dt, { mode: "lunge", stance: "quad", target, tilt: 0.5, jaw, yMin: c.ground - 0.4, yMax: c.ground + 0.9, arms: (sc) => arms(sc, kh) })
    // View: pitched down a little by the yank, then follows the face up.
    if (t < 0.45) s.pitch = s.pitch0 - 0.22 * ky
    else s.aimAtFace(0.18)
    s.finish(t, smooth(0.3, 0.6, t), phase)
    return t > 1.5
  }
}

// ------------------------------------------------------------------------------------------------- C: slam down

function slamDown(s: Scene) {
  const c = s.c
  const fwd = s.fwd
  const target = new THREE.Vector3()
  const rootAt = s.eye0.clone().addScaledVector(fwd, 1.05)
  s.w.animator!.snapStance("biped")
  s.w.root.position.set(rootAt.x, c.ground, rootAt.z)
  const floorEye = s.eye0.clone().addScaledVector(fwd, -0.55)
  floorEye.y = c.ground + 0.32
  let screamed = false
  let flooded = false
  const view = new THREE.Vector3()
  return (t: number, dt: number) => {
    let phase = "hit"
    // Knocked back (0.08–0.5 s): accelerating fall, hard stop on the floor.
    const kf = Math.min(1, Math.max(0, (t - 0.08) / 0.42)) ** 2
    s.eye.lerpVectors(s.eye0, floorEye, kf)
    s.roll = 0.22 * kf
    if (t < 0.5) s.pitch = s.pitch0 + 0.95 * kf
    s.shake = t < 0.5 ? 0.6 : t < 0.62 ? 3 : 0.5
    // It looms over and lowers its skull toward the lens.
    const kl = smooth(0.5, 1.05, t)
    const bend = 0.35 + 0.75 * kl
    s.w.animator!.stoop = 0.6 + 0.8 * kl
    s.viewDir(view)
    const dC = 1.9 - 1.0 * kl - (t > 1.05 ? 0.25 * smooth(1.05, 1.18, t) : 0)
    target.copy(s.eye).addScaledVector(view, dC)
    if (t > 0.5) phase = "loom"
    let jaw = 0.15
    if (t > 0.7) {
      phase = "scream"
      if (!screamed) {
        screamed = true
        c.scream()
      }
      jaw = 0.15 + 0.85 * smooth(0.7, 0.95, t)
    }
    if (!flooded && t > 1.12) {
      flooded = true
      c.flood()
      s.shake = 2.5
    }
    s.pose(dt, { mode: "rear", stance: "biped", target, tilt: 0.15, jaw, bend, yMin: c.ground - 0.35, yMax: c.ground + 0.15 })
    if (t > 0.5) s.aimAtFace(0.15)
    s.finish(t, smooth(0.35, 0.6, t), phase)
    return t > 1.6
  }
}

// ================================================================================================= whole-creature set
// Every one of these keeps the camera back so the whole Wendigo (feet to antlers) reads for most of the scene; the
// close-up cut and the minimum face distance only come in for the final strike (`strike`).

/** Faces the eye (yaw), steps the animator with an externally driven velocity, stoops under the ceiling. */
function drive(s: Scene, dt: number, mode: "idle" | "lunge" | "rear" | "stalk" | "freeze", stance: "quad" | "biped", vel: THREE.Vector3, face = 0, jaw = 0) {
  const w = s.w
  _v.subVectors(s.eye, w.root.position)
  w.root.rotation.set(0, Math.atan2(_v.x, _v.z), 0)
  w.update(dt, { mode, stance, target: s.eye, velocity: vel, ceiling: s.c.ceiling })
  w.root.updateMatrixWorld(true)
  if (jaw) s.openJaw(jaw)
  if (face > 0) s.faceOut(face)
  s.skullCentre(s.centre)
}

/** Eases the view toward a point between the hips and the head (keeps the whole body in frame). */
function frameBody(s: Scene, k: number, up = 0.45) {
  const rig = s.w.rig!
  rig.byName.get("hips")!.getWorldPosition(_v)
  rig.byName.get("head")!.getWorldPosition(_v2)
  _v.lerp(_v2, up)
  const saved = s.centre.clone()
  s.centre.copy(_v)
  s.aimAtFace(k)
  s.centre.copy(saved)
}

/**
 * Teeth: the jaw gapes and chatters (fast, uneven snaps), `amp` rad wide; calls `chatter` on each snap shut (rate
 * limited so the sound isn't a buzz).
 */
function chatterer(s: Scene) {
  let phase = 0
  let lastSnap = -1
  let wasClosed = false
  return (t: number, dt: number, amp: number, rate = 9) => {
    phase += dt * rate * (0.85 + 0.3 * Math.sin(t * 3.1))
    const o = Math.abs(Math.sin(phase * Math.PI))
    const open = amp * (0.35 + 0.65 * o ** 0.6)
    const closed = o < 0.2
    if (closed && !wasClosed && t - lastSnap > 0.22) {
      lastSnap = t
      s.c.chatter?.()
    }
    wasClosed = closed
    return open
  }
}

/** Room ahead of a point along a direction (default: open). */
const room = (s: Scene, from: THREE.Vector3, dir: THREE.Vector3, max: number) => Math.min(max, s.c.free ? s.c.free(from, dir) : max)

/**
 * The final strike shared by all three: from wherever the skull is, it snaps to ~0.62 m in front of the eye in
 * `dur` s, face first, jaws wide (the cut-away and minimum distance on), then the flood; resolves `RED_S` later.
 */
const RED_S = 0.32
function striker(s: Scene, stance: () => "quad" | "biped") {
  const from = new THREE.Vector3()
  const to = new THREE.Vector3()
  const tgt = new THREE.Vector3()
  let t0 = -1
  let flooded = false
  let snapped = false
  return (t: number, dt: number, dur = 0.3): boolean => {
    if (t0 < 0) {
      t0 = t
      from.copy(s.centre)
    }
    const k = Math.min(1, (t - t0) / dur)
    s.viewDir(to).multiplyScalar(0.66).add(s.eye)
    to.y += 0.02
    tgt.lerpVectors(from, to, 1 - (1 - k) ** 2.5)
    const g = s.c.ground
    // Gaping wide as it comes, then a bite snap shut at the lens on the last frames before the red.
    const bite = smooth(0.82, 1, k)
    if (bite > 0 && !snapped) {
      snapped = true
      s.c.chatter?.()
    }
    const jaw = 1.15 * (1 - bite) + 0.05
    s.pose(dt, { mode: "lunge", stance: stance(), target: tgt, tilt: -0.15, jaw, yMin: g - 0.8, yMax: g + 0.9 })
    s.aimAtFace(0.3)
    s.shake = 0.6 + 2 * k
    if (k >= 1 && !flooded) {
      flooded = true
      s.c.flood()
      s.shake = 3
    }
    s.finish(t, 1, "strike", true, 1)
    return flooded && t - t0 - dur > RED_S
  }
}

// ------------------------------------------------------------------------------------------------- 1: charge

/**
 * It comes down the corridor at you: the whole creature from ~12 m on all fours, fast, the camera held still; at
 * ~3.6 m it rears up (scream), filling the frame head to legs, then the strike.
 */
function charge(s: Scene) {
  const c = s.c
  // Come from the open side: toward where it actually was if there's room that way, else the view, else the
  // longest clear direction (a catch facing a wall would otherwise place it inside the next room).
  {
    const cands: THREE.Vector3[] = []
    if (c.from) cands.push(new THREE.Vector3(c.from.x - s.eye0.x, 0, c.from.z - s.eye0.z).normalize())
    cands.push(s.fwd)
    for (let k = 0; k < 8; k++) cands.push(new THREE.Vector3(Math.sin((k * Math.PI) / 4), 0, Math.cos((k * Math.PI) / 4)))
    let best = cands[0]!
    let bestFree = -1
    for (const d of cands) {
      const f = room(s, s.eye0, d, 12)
      if (f >= 6) {
        best = d
        break
      }
      if (f > bestFree) {
        bestFree = f
        best = d
      }
    }
    s.yaw0 = s.yaw = Math.atan2(-best.x, -best.z)
  }
  const fwd = s.fwd
  const D0 = Math.max(5, room(s, s.eye0, fwd, 9.5) - 1)
  s.w.animator!.snapStance("quad")
  s.w.root.position.copy(s.eye0).addScaledVector(fwd, D0)
  s.w.root.position.y = c.ground
  s.pitch = s.pitch0 = 0.02
  const vel = new THREE.Vector3()
  let speed = 0
  let rearAt = -1
  let screamed = false
  const strike = striker(s, () => "biped")
  const chat = chatterer(s)
  // Settle a pose before it's seen.
  for (let i = 0; i < 30; i++) drive(s, 1 / 30, "stalk", "quad", vel.set(0, 0, 0))
  return (t: number, dt: number) => {
    const d = Math.hypot(s.w.root.position.x - s.eye.x, s.w.root.position.z - s.eye.z)
    if (rearAt < 0) {
      // A beat of it standing there, then it goes: hard acceleration to ~7.5 m/s.
      speed = t < 0.2 ? 0 : Math.min(7.5, speed + dt * 14)
      vel.copy(fwd).multiplyScalar(-speed)
      s.w.root.position.addScaledVector(vel, dt)
      // Head up and out at you as it comes, teeth chattering from ~7 m.
      const near = 1 - Math.min(1, Math.max(0, (d - 2.5) / 5))
      drive(s, dt, t < 0.2 ? "idle" : "lunge", "quad", vel, 0.5 + 0.5 * near, near > 0 ? chat(t, dt, 0.35 + 0.6 * near) : 0)
      s.shake = 0.15 + 0.5 * Math.min(1, speed / 7.5) * (1 - Math.min(1, d / 10))
      frameBody(s, 0.06, 0.3)
      if (d < 3.7) rearAt = t
      s.finish(t, 0, "charge", false, 1.4)
      return false
    }
    const r = t - rearAt
    if (r < 0.5) {
      // Rears up, braking hard, to ~1.9 m: arms spread, the whole height of it over you.
      if (!screamed) {
        screamed = true
        c.scream()
      }
      speed = Math.max(0, speed - dt * 16)
      if (d < 1.9) speed = 0
      vel.copy(fwd).multiplyScalar(-speed)
      s.w.root.position.addScaledVector(vel, dt)
      drive(s, dt, "rear", "biped", vel, 1, chat(t, dt, 1.0, 11))
      frameBody(s, 0.12, 0.55)
      s.shake = 0.9
      s.finish(t, Math.min(1, r / 0.3), "rear", false, 1)
      return false
    }
    return strike(t, dt, 0.28)
  }
}

// ------------------------------------------------------------------------------------------------- 2: grab and turn

/**
 * A clawed hand clamps your shoulder from behind; the view is wrenched round 180° (motion blur) and shoved back, to
 * the whole creature standing over you, stooped under the ceiling. A held beat, then it lowers its skull to you.
 */
function spin(s: Scene) {
  const c = s.c
  // "Behind" is where it actually is (c.from) when given, else straight behind the view.
  const toward = c.from ? new THREE.Vector3(c.from.x - s.eye0.x, 0, c.from.z - s.eye0.z) : s.fwd.negate()
  const dist0 = toward.length()
  toward.normalize()
  const fwd = toward.clone().negate()
  const yawAway = Math.atan2(-fwd.x, -fwd.z)
  const right = new THREE.Vector3(Math.cos(yawAway), 0, -Math.sin(yawAway))
  // The turn: from the current view round to face it (the short way, at least a quarter turn of whip).
  let turn = Math.atan2(-toward.x, -toward.z) - s.yaw0
  turn = Math.atan2(Math.sin(turn), Math.cos(turn))
  const rig = s.w.rig!
  const bi = (n: string) => rig.bones.indexOf(rig.byName.get(n)!)
  const back = fwd.clone().negate()
  const behind = Math.max(1.2, Math.min(1.5, dist0 || 1.5, room(s, s.eye0, back, 1.5) - 0.3))
  s.w.animator!.snapStance("biped")
  s.w.root.position.copy(s.eye0).addScaledVector(back, behind)
  s.w.root.position.y = c.ground
  // It is shoved back along the original forward (away from the creature, which is behind).
  const shove = Math.max(0.6, Math.min(1.5, room(s, s.eye0, fwd, 2) - 0.5))
  const vel = new THREE.Vector3()
  for (let i = 0; i < 40; i++) drive(s, 1 / 30, "idle", "biped", vel)
  const grip = new THREE.Vector3()
  const pole = new THREE.Vector3()
  // The arm on the player's right side.
  const arm = (() => {
    const pL = rig.byName.get("uarmL")!.getWorldPosition(new THREE.Vector3())
    const pR = rig.byName.get("uarmR")!.getWorldPosition(new THREE.Vector3())
    return pL.dot(right) > pR.dot(right) ? "L" : "R"
  })()
  const yaw0 = s.yaw0
  let screamed = false
  const strike = striker(s, () => "biped")
  const chat = chatterer(s)
  return (t: number, dt: number) => {
    // 0–0.3 s: the hand comes over the shoulder and clamps. 0.3–0.72: wrenched round and shoved back. 0.72–1.5: it
    // stands over you. 1.5: it lowers its skull (scream) and strikes.
    const kg = smooth(0, 0.3, t)
    const ks = smooth(0.32, 0.72, t)
    s.eye.copy(s.eye0).addScaledVector(fwd, shove * ks)
    s.eye.y -= 0.18 * ks
    if (t < 1.5) {
      s.yaw = yaw0 + turn * ks
      s.pitch = s.pitch0 - 0.12 * kg * (1 - ks) + 0.1 * ks
      s.roll = Math.sin(Math.PI * ks) * 0.25
      // Motion blur through the turn.
      if (c.canvas) {
        const spd = t > 0.32 && t < 0.72 ? Math.sin(Math.PI * ((t - 0.32) / 0.4)) : 0
        c.canvas.style.filter = spd > 0.02 ? `blur(${(spd * 7).toFixed(1)}px)` : ""
      }
      drive(s, dt, t < 0.75 ? "idle" : "rear", "biped", vel, smooth(0.6, 0.9, t), t > 0.8 ? chat(t, dt, 0.4 + 0.6 * smooth(0.8, 1.5, t), 7) : 0)
      if (t < 0.6) {
        // Its hand on the shoulder (the eye's right, a touch forward and down), claws round it.
        grip.copy(s.eye).addScaledVector(right, 0.32 * (1 - ks) + 0.0).addScaledVector(fwd, 0.08 - 0.25 * (1 - kg)).add(_v.set(0, -0.24, 0))
        grip.addScaledVector(back, 0.5 * (1 - kg))
        pole.copy(right).add(_v.set(0, -0.8, 0))
        twoBoneIK(rig, bi(`uarm${arm}`), bi(`farm${arm}`), grip, pole)
        aimBone(rig, bi(`hand${arm}`), _v.copy(fwd).add(_v2.set(0, -0.8, 0)).normalize())
        rig.root.updateMatrixWorld(true)
      }
      if (t > 0.72) frameBody(s, 0.08, 0.55)
      s.shake = t > 0.28 && t < 0.4 ? 2.5 : t < 0.72 ? 1 : 0.3
      s.finish(t, t > 0.72 ? 0.8 : 0, t < 0.32 ? "grab" : t < 0.72 ? "turn" : "loom", false, t > 0.5 ? 1 : 0.4)
      return false
    }
    if (c.canvas) c.canvas.style.filter = ""
    if (!screamed) {
      screamed = true
      c.scream()
    }
    return strike(t, dt, 0.36)
  }
}

// ------------------------------------------------------------------------------------------------- maul (in game)

/**
 * The hunter caught you face to face: no reset, no run-up. The scene takes the creature exactly where it is, facing
 * and moving as it was; the view whips onto its face in ~0.12 s while it keeps coming at its own speed, teeth
 * chattering, and the moment the skull is within ~1.7 m it goes straight into the strike (scream, jaw snap, red).
 */
function maul(s: Scene) {
  const c = s.c
  const w = s.w
  const st = w.animator!.stance
  const vel = new THREE.Vector3()
  const dir = new THREE.Vector3()
  let speed = Math.min(6, Math.max(2.8, c.velocity ? Math.hypot(c.velocity.x, c.velocity.z) : 3.5))
  const strike = striker(s, () => st)
  const chat = chatterer(s)
  let striking = false
  return (t: number, dt: number) => {
    if (!striking) {
      dir.set(s.eye.x - w.root.position.x, 0, s.eye.z - w.root.position.z)
      const d = dir.length()
      dir.normalize()
      // It keeps coming (easing off as it arrives), face turning up to you.
      speed = Math.max(1.5, speed - dt * 4)
      vel.copy(dir).multiplyScalar(d > 0.6 ? speed : 0)
      w.root.position.addScaledVector(vel, dt)
      drive(s, dt, "lunge", st, vel, Math.min(1, t / 0.12), chat(t, dt, 0.5 + 0.5 * Math.min(1, t / 0.2), 11))
      // The whip: onto its face in ~0.12 s.
      s.aimAtFace(1 - Math.exp(-dt * 30))
      s.shake = 0.6
      const near = s.centre.distanceTo(s.eye)
      s.finish(t, Math.min(1, t / 0.15), "rush", false, Math.min(1, t / 0.2))
      if ((t >= 0.12 && near <= 1.7) || t > 0.4) {
        striking = true
        c.scream()
      }
      return false
    }
    return strike(t, dt, 0.26)
  }
}
