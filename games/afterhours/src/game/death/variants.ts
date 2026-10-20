import * as THREE from "three/webgpu"
import type { Wendigo } from "../../creatures/wendigo"
import { aimBone, twoBoneIK } from "../../creatures/kit/ik"

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

export type DeathName = "A" | "B" | "C"
export const DEATHS: Record<DeathName, string> = { A: "Lunge and hold", B: "Grab and pull", C: "Slam down" }
/** The hunter's catch uses this until the owner picks (death-lab.html "Use in game" stores the pick, dev only). */
export const DEATH_DEFAULT: DeathName = "A"
const PICK_KEY = "afterhours.deathVariant"
export function deathVariant(): DeathName {
  try {
    const v = localStorage.getItem(PICK_KEY)
    if (v === "A" || v === "B" || v === "C") return v
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

export type DeathLights = { face: THREE.PointLight }
/** Adds the death scenes' light to the scene, dark (lights added later recompile every lit material: a stall). */
export function prepareDeathLights(scene: THREE.Scene): DeathLights {
  const face = new THREE.PointLight(0xc6d4de, 0, 3.2, 2)
  face.castShadow = false
  face.position.set(0, -90, 0)
  scene.add(face)
  return { face }
}

export type DeathMeasure = { t: number; nearest: number; fill: number; cx: number; cy: number; phase: string }

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
  flood: () => void
  lights: DeathLights
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
    w.update(dt, { mode: o.mode, stance: o.stance, target: this.eye, velocity: ZERO })
    if (o.bend) rig.byName.get("hips")!.quaternion.premultiply(_q.setFromAxisAngle(_v2.set(1, 0, 0), o.bend))
    rig.byName.get("jaw")!.quaternion.multiply(_q.setFromEuler(_e.set(o.jaw, 0, 0)))
    w.root.updateMatrixWorld(true)
    const hb = rig.byName.get("head")!
    const hi = rig.bones.indexOf(hb)
    // Face toward the eye, snout tilted down so the long face shows.
    hb.getWorldPosition(_v)
    const to = _v2.subVectors(this.eye, _v).normalize()
    const side = new THREE.Vector3().crossVectors(to, UP).normalize()
    const down = new THREE.Vector3().crossVectors(side, to).negate()
    const dir = to.clone().multiplyScalar(Math.cos(o.tilt)).addScaledVector(down, Math.sin(o.tilt))
    if (o.twitch) dir.addScaledVector(side, o.twitch[0]).addScaledVector(UP, o.twitch[1]).normalize()
    aimBone(rig, hi, dir)
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
  /** Face light, the close-up cut and a measurement. */
  finish(t: number, light: number, phase: string) {
    const { face } = this.c.lights
    _v.subVectors(this.centre, this.eye)
    face.position.copy(this.eye).addScaledVector(_v, 0.45)
    face.position.y += 0.28
    face.intensity = 7 * light
    // Cut: the cone from the eye toward the skull, closer than the face's nearest point.
    const cut = this.w.cut
    if (cut) {
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
      this.c.onMeasure({ t, nearest: +this.nearest.toFixed(3), fill: +(Math.max(0, Math.min(1, y1) - Math.max(-1, y0)) / 2).toFixed(2), cx: +c.x.toFixed(2), cy: +c.y.toFixed(2), phase })
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
  const script = name === "A" ? lungeHold(s) : name === "B" ? grabPull(s) : slamDown(s)
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
  if (lights) lights.face.intensity = 0
  if (!w) return
  w.root.visible = false
  w.setShade(1)
  if (w.cut) w.cut.cutOn.value = 0
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
