import * as THREE from "three/webgpu"
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js"
import { createTorch } from "./torch"
import { measureHands, skinVsCyl, wrapFingers, unpenetrate, type Cyl } from "./grip"

// The first-person viewmodel: what the player sees of their own flashlight hand. A copy of the character's left
// forearm and hand (same skin, same materials, cut above the elbow) and a flashlight, in ONE authored pose baked once
// per character: a hammer grip seen side-on, barrel through the fist, lens forward, the tail in the heel of the palm,
// the thumb along the top, the knuckles facing out to the left, the fingers wrapped underneath (closed onto the
// barrel with the contact grip, grip.ts). Every frame it only follows the view (sway, bob, crouch, landing kick, a
// small lag on fast turns, a drop when looking far down): no IK, no wrist solve, nothing to flip.
//
// Rendered by the main camera on its own layer (VIEW_LAYER; mirrors and shadow maps never see it), scaled about the
// eye (VIEW_SCALE) so it sits nearer than the player's collision radius and never clips into walls; the perspective
// is identical, so it looks full size. The full body keeps its clip-based carry for shadows, mirrors and third person
// (its left forearm, hand and torch are hidden from the view camera while the viewmodel shows).

export const VIEW_LAYER = 6
const VIEW_SCALE = 0.75

/** Where the flashlight sits relative to the eye (m, real scale): ahead, below, to the left; and its tilt (rad). */
const FRAME = { ahead: 0.36, down: 0.135, left: 0.15, toeIn: 0.07, up: 0.07, palmDown: 0.2, foreUp: 0.75, foreIn: 0.4 }
const BARREL_R = 0.0172
const ARM = /^Left(ForeArm|Hand)/
const DROP_MESHES = /hair|lash|eye|hat|cap|beanie|helmet|glasses/i

export type ViewmodelSource = {
  model: THREE.Object3D
  /** The carry-idle clip (the arm's starting pose and the fist), already retargeted to this character. */
  carry: THREE.AnimationClip | null
  /** The flashlight's transform relative to the left hand bone in the clip's fist (placeTorch). */
  torchPos: THREE.Vector3
  torchQuat: THREE.Quaternion
  ik: (a: THREE.Object3D, b: THREE.Object3D, c: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) => void
}

export type ViewState = {
  eye: { x: number; y: number; z: number }
  yaw: number
  pitch: number
  vel: { x: number; y: number; z: number }
  crouch: number
  grounded: boolean
  /** Gait phase 0..1 (one stride) and smoothed speed (m/s). */
  phase: number
  speed: number
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt)
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

export class Viewmodel {
  /** Placed at the eye each frame; add it to the scene. */
  readonly root = new THREE.Group()
  private motion = new THREE.Group()
  private inner = new THREE.Group()
  readonly torch = createTorch()
  /** Automation: the grip's contact numbers at bake time. */
  readonly debug: Record<string, unknown> = {}
  present = 0
  private last = { yaw: Number.NaN, pitch: 0, vy: 0, grounded: true }
  private sway = new THREE.Vector2()
  private kick = { y: 0, v: 0 }
  private t = 0
  private torchQuat = new THREE.Quaternion()

  constructor() {
    this.root.name = "viewmodel"
    this.root.add(this.motion)
    this.motion.add(this.inner)
    this.root.scale.setScalar(VIEW_SCALE)
    this.root.visible = false
    this.torch.visible = true
    this.torch.traverse((o) => {
      o.layers.set(VIEW_LAYER)
      const m = o as THREE.Mesh
      if (m.isMesh) m.castShadow = false
    })
  }

  /** Builds the arm for a character (call on load and on a character switch). */
  build(src: ViewmodelSource) {
    for (const c of [...this.inner.children]) if (c !== this.torch) this.inner.remove(c)
    const model = cloneSkinned(src.model) as THREE.Object3D
    model.traverse((o) => {
      if (o.name === "torch") o.removeFromParent()
    })
    model.position.set(0, 0, 0)
    model.quaternion.identity()
    model.updateMatrixWorld(true)
    const bones: Record<string, THREE.Bone> = {}
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone
    })
    const B = bones
    if (!B.LeftArm || !B.LeftForeArm || !B.LeftHand || !B.Head) return
    // The clip's carry pose (shoulder, arm and the fist's fingers).
    if (src.carry) {
      const mixer = new THREE.AnimationMixer(model)
      const a = mixer.clipAction(src.carry)
      a.play()
      a.time = 0
      mixer.update(0)
      a.stop()
      mixer.uncacheRoot(model)
    }
    model.updateMatrixWorld(true)

    // The view frame in model space (the model faces +Z, +X is its left).
    const fwd = new THREE.Vector3(0, 0, 1)
    const left = new THREE.Vector3(1, 0, 0)
    const up = new THREE.Vector3(0, 1, 0)
    const eye = B.Head.getWorldPosition(new THREE.Vector3()).addScaledVector(up, 0.07).addScaledVector(fwd, 0.09)
    const grip = eye.clone().addScaledVector(fwd, FRAME.ahead).addScaledVector(up, -FRAME.down).addScaledVector(left, FRAME.left)
    // The barrel: forward, toed in a little towards the centre line and up a touch (a relaxed carry, not a rifle).
    const dir = fwd.clone().addScaledVector(left, -FRAME.toeIn).addScaledVector(up, FRAME.up).normalize()
    // Torch frame (placeTorch): -Z = lens, the index side; +Y = from the fist's centre towards the wrist. A hammer grip
    // carried forward: the wrist below and a little outside the fist, so the thumb is on top and the back of the hand
    // faces out to the left.
    const Zt = dir.clone().negate()
    const Yt = up.clone().negate().addScaledVector(left, FRAME.palmDown)
    Yt.addScaledVector(Zt, -Yt.dot(Zt)).normalize()
    const Xt = new THREE.Vector3().crossVectors(Yt, Zt)
    const torchQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xt, Yt, Zt))
    this.torchQuat.copy(torchQ)
    const handQ0 = torchQ.clone().multiply(src.torchQuat.clone().invert())
    const handQ = handQ0.clone()
    const hs = B.LeftHand.getWorldScale(new THREE.Vector3()).x
    const palmDir = Yt.clone()
    const lu = B.LeftArm.getWorldPosition(new THREE.Vector3()).distanceTo(B.LeftForeArm.getWorldPosition(new THREE.Vector3()))
    const lf = B.LeftForeArm.getWorldPosition(new THREE.Vector3()).distanceTo(B.LeftHand.getWorldPosition(new THREE.Vector3()))
    // The forearm comes in from below, behind and outside the wrist (elbow low and out); the upper arm hangs from a
    // shoulder placed to suit (it is cut away), so the arm is never stretched straight to reach the framing spot.
    const foreDir = fwd.clone().addScaledVector(up, FRAME.foreUp).addScaledVector(left, -FRAME.foreIn).normalize()
    const upperDir = up.clone().negate().addScaledVector(fwd, 0.45).addScaledVector(left, 0.25).normalize()
    const place = (shift: number) => {
      const wrist = grip.clone().addScaledVector(palmDir, shift).sub(src.torchPos.clone().multiplyScalar(hs).applyQuaternion(handQ))
      const elbow = wrist.clone().addScaledVector(foreDir, -lf)
      const shoulder = elbow.clone().addScaledVector(upperDir, -lu * 0.98)
      B.LeftArm!.position.copy(B.LeftArm!.parent!.worldToLocal(shoulder))
      B.LeftArm!.updateWorldMatrix(false, true)
      const pole = elbow.clone().sub(shoulder.clone().add(wrist).multiplyScalar(0.5))
      src.ik(B.LeftArm!, B.LeftForeArm!, B.LeftHand!, wrist, pole)
      // The elbow onto the wanted side: a turn of the whole arm about the shoulder–wrist line.
      {
        const A = B.LeftArm!.getWorldPosition(new THREE.Vector3())
        const k = B.LeftHand!.getWorldPosition(new THREE.Vector3()).sub(A).normalize()
        const pb = B.LeftForeArm!.getWorldPosition(new THREE.Vector3()).sub(A)
        pb.addScaledVector(k, -pb.dot(k))
        const pp = elbow.clone().sub(A)
        pp.addScaledVector(k, -pp.dot(k))
        const ang = Math.atan2(k.dot(new THREE.Vector3().crossVectors(pb, pp)), pb.dot(pp))
        const arm = B.LeftArm!
        const pq = arm.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()
        arm.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(k.clone().applyQuaternion(pq), ang))
        arm.updateWorldMatrix(false, true)
      }
      this.debug.ikElbow = B.LeftForeArm!.getWorldPosition(new THREE.Vector3()).toArray().map((x) => +x.toFixed(3))
      this.debug.wantElbow = elbow.toArray().map((x) => +x.toFixed(3))
      this.debug.ikWrist = B.LeftHand!.getWorldPosition(new THREE.Vector3()).toArray().map((x) => +x.toFixed(3))
      this.debug.wantWrist = wrist.toArray().map((x) => +x.toFixed(3))
      // Half the hand's roll about the forearm taken by the forearm (no candy-wrapped wrist).
      const fa = B.LeftForeArm!
      const local = fa.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(handQ)
      if (local.w < 0) local.set(-local.x, -local.y, -local.z, -local.w)
      const tw = 2 * Math.atan2(local.y, local.w)
      fa.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), wrap(tw) * 0.5))
      fa.updateWorldMatrix(false, true)
      B.LeftHand!.quaternion.copy(fa.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(handQ))
      model.updateMatrixWorld(true)
    }
    // The barrel lies in the palm: the hand moved along the palm normal until the palm and the knuckles' skin touch
    // it, the fingers closed onto it; the hand turned a little about the palm normal (searched) so the knuckle line
    // runs along the barrel and no finger base cuts into it. Contact measured on the character's own mesh.
    const skin = measureHands(model)
    const cyl: Cyl = { p: grip, a: dir, r: BARREL_R, lo: -0.105, hi: 0.075 }
    let shift = 0
    place(shift)
    if (skin) {
      // The palm-side contact set: the hand's own vertices plus each finger's first centimetre from its knuckle.
      const contact = [...skin.palm.Left]
      {
        const m = skin.mesh, bn = m.skeleton.bones, si = m.geometry.attributes.skinIndex!, sw = m.geometry.attributes.skinWeight!
        m.skeleton.update()
        const v = new THREE.Vector3()
        for (const i of skin.all.Left) {
          let best = 0, bw = 0
          for (let k = 0; k < 4; k++) { const ww = sw.getComponent(i, k); if (ww > bw) { bw = ww; best = si.getComponent(i, k) } }
          const bone = bn[best]!
          if (!/^LeftHand(Index|Middle|Ring|Pinky)1$/.test(bone.name)) continue
          m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld)
          if (v.distanceTo(bone.getWorldPosition(new THREE.Vector3())) < 0.012) contact.push(i)
        }
      }
      const fingerBones = Object.values(B).filter((b) => /^LeftHand(Index|Middle|Ring|Pinky|Thumb)\d$/.test(b.name))
      const rest = new Map(fingerBones.map((b) => [b, b.quaternion.clone()]))
      const attempt = (theta: number, roll: number) => {
        for (const [b, q] of rest) b.quaternion.copy(q)
        handQ.copy(handQ0).premultiply(new THREE.Quaternion().setFromAxisAngle(palmDir, theta)).premultiply(new THREE.Quaternion().setFromAxisAngle(dir, roll))
        shift = 0
        place(shift)
        for (let it = 0; it < 8; it++) {
          const m = skinVsCyl(skin, contact, cyl)
          const e = 0.0008 - m.min
          if (Math.abs(e) < 0.0003) break
          shift += e
          place(shift)
        }
        wrapFingers(B, "Left", cyl, skin.fingerR, 0.0028)
        model.updateMatrixWorld(true)
        unpenetrate(skin, B, "Left", cyl)
        model.updateMatrixWorld(true)
        // Anything still inside (the palm's own skin, which the fingers can't fix): the hand moved out by that much.
        for (let k = 0; k < 3; k++) {
          const r = skinVsCyl(skin, skin.all.Left, cyl)
          if (r.inside === 0 && r.min >= 0) break
          const keep = new Map(fingerBones.map((b) => [b, b.quaternion.clone()]))
          shift += 0.0008 - r.min
          place(shift)
          for (const [b, q] of keep) b.quaternion.copy(q)
          model.updateMatrixWorld(true)
          unpenetrate(skin, B, "Left", cyl)
          model.updateMatrixWorld(true)
        }
        const all = skinVsCyl(skin, skin.all.Left, cyl)
        const palm = skinVsCyl(skin, skin.palm.Left, cyl)
        return { theta, roll, inside: all.inside, skinMin: all.min, palmGap: palm.min, score: all.inside * 10 + Math.max(0, palm.min - 0.002) * 1000 + Math.abs(theta) + Math.abs(roll) * 2 }
      }
      let best = attempt(0, 0)
      for (const theta of [-0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6]) {
        for (const roll of [-0.15, 0, 0.15]) {
          if (theta === 0 && roll === 0) continue
          const r = attempt(theta, roll)
          if (r.score < best.score) best = r
        }
      }
      const fin = attempt(best.theta, best.roll)
      this.torchQuat.copy(handQ).multiply(src.torchQuat)
      Object.assign(this.debug, { theta: +best.theta.toFixed(2), roll: best.roll, shift: +(shift * 1000).toFixed(1), palmGap: +(fin.palmGap * 1000).toFixed(1), skinMin: +(fin.skinMin * 1000).toFixed(1), inside: fin.inside, verts: skin.all.Left.length })
    }

    {
      const r = (v: THREE.Vector3) => v.toArray().map((x) => +x.toFixed(3))
      Object.assign(this.debug, { eye: r(eye), grip: r(grip), arm: r(B.LeftArm.getWorldPosition(new THREE.Vector3())), elbow: r(B.LeftForeArm.getWorldPosition(new THREE.Vector3())), hand: r(B.LeftHand.getWorldPosition(new THREE.Vector3())), lu: +lu.toFixed(3), lf: +lf.toFixed(3) })
    }
    // Keep only the forearm and hand (and their sleeve): every triangle with a vertex mostly on those bones.
    const drop: THREE.Object3D[] = []
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isMesh) return
      if (!m.isSkinnedMesh || DROP_MESHES.test(m.name)) return void drop.push(m)
      const geo = m.geometry.clone()
      const si = geo.attributes.skinIndex!
      const sw = geo.attributes.skinWeight!
      const armIdx = new Set(m.skeleton.bones.flatMap((b, i) => (ARM.test(b.name) ? [i] : [])))
      const onArm = (v: number) => {
        let w = 0
        for (let k = 0; k < 4; k++) if (armIdx.has(si.getComponent(v, k))) w += sw.getComponent(v, k)
        return w > 0.5
      }
      const idx = geo.index
      if (!idx) return void drop.push(m)
      const keep: number[] = []
      for (let t = 0; t < idx.count; t += 3) {
        const a = idx.getX(t)
        const b = idx.getX(t + 1)
        const c = idx.getX(t + 2)
        if (+onArm(a) + +onArm(b) + +onArm(c) >= 2) keep.push(a, b, c)
      }
      if (!keep.length) return void drop.push(m)
      // One material group (groups index the old index buffer).
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      geo.clearGroups()
      geo.setIndex(keep)
      m.geometry = geo
      m.material = mats[0]!
      m.layers.set(VIEW_LAYER)
      m.castShadow = false
      m.receiveShadow = true
      m.frustumCulled = false
    })
    for (const d of drop) d.removeFromParent()

    // The flashlight at the grip, in model space; the eye at the inner group's origin, facing -Z.
    this.torch.position.copy(grip)
    this.torch.quaternion.copy(this.torchQuat)
    this.torch.scale.setScalar(1)
    this.inner.add(model, this.torch)
    this.inner.rotation.set(0, Math.PI, 0)
    this.inner.position.copy(eye).applyAxisAngle(up, Math.PI).negate()
    this.present = 0
    this.last.yaw = Number.NaN
  }

  /** Lens position (world) for the beam, or false while hidden. */
  lens(pos: THREE.Vector3) {
    if (!this.root.visible || this.present < 0.5) return false
    const lens = this.torch.userData.lens as THREE.Object3D
    lens.updateWorldMatrix(true, false)
    lens.getWorldPosition(pos)
    return true
  }

  /** Per frame: `show` brings it in (slides up from below), then it follows the view with procedural motion. */
  update(dt: number, show: boolean, s: ViewState) {
    this.present += ((show ? 1 : 0) - this.present) * damp(show ? 9 : 14, dt)
    if (!show && this.present < 0.01) this.present = 0
    this.root.visible = this.present > 0.01
    if (!this.root.visible) {
      this.last.yaw = Number.NaN
      return
    }
    this.t += dt
    // Turn lag: the hand trails fast yaw/pitch a little (a spring towards zero offset).
    if (!Number.isNaN(this.last.yaw) && dt > 0 && dt < 0.25) {
      const dy = wrap(s.yaw - this.last.yaw) / dt
      const dp = (s.pitch - this.last.pitch) / dt
      const want = new THREE.Vector2(THREE.MathUtils.clamp(-dy * 0.012, -0.06, 0.06), THREE.MathUtils.clamp(-dp * 0.01, -0.05, 0.05))
      this.sway.lerp(want, damp(10, dt))
    }
    this.last.yaw = s.yaw
    this.last.pitch = s.pitch
    // Landing kick: a drop on touchdown, sprung back.
    if (s.grounded && !this.last.grounded) this.kick.v -= Math.min(0.6, Math.abs(this.last.vy) * 0.08)
    this.last.grounded = s.grounded
    this.last.vy = s.vel.y
    this.kick.v += (-140 * this.kick.y - 18 * this.kick.v) * Math.min(dt, 0.05)
    this.kick.y += this.kick.v * Math.min(dt, 0.05)
    // Walk / run bob: down at each footfall, side to side once per stride; scaled by speed.
    const amp = Math.min(1, s.speed / 1.6) * 0.008 + smooth(2, 4, s.speed) * 0.01
    const ph = s.phase * Math.PI * 2
    const bobY = -amp * (0.5 + 0.5 * Math.cos(2 * ph)) + 0.0015 * Math.sin(this.t * 1.3)
    const bobX = amp * 0.7 * Math.sin(ph)
    // Looking far down the hand drops and comes back a little, so it doesn't fill the view.
    const down = smooth(0.45, 1.35, -s.pitch)
    const crouch = smooth(0.2, 0.8, s.crouch)
    const hide = 1 - smooth(0, 1, this.present)
    this.motion.position.set(bobX - 0.01 * crouch, bobY - 0.06 * down - 0.012 * crouch - 0.3 * hide + this.kick.y, 0.04 * down)
    this.motion.rotation.set(this.sway.y + 0.06 * down + 0.4 * hide, this.sway.x, bobX * 1.5, "YXZ")
    // At the eye, along the view.
    this.root.position.set(s.eye.x, s.eye.y, s.eye.z)
    this.root.rotation.set(s.pitch, s.yaw, 0, "YXZ")
    this.root.updateMatrixWorld(true)
  }
}
