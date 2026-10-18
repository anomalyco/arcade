import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import BAKED from "./clips.json"
import { createTorch } from "./torch"

// Body B: the janitor (public/models/playerb/janitor_b.glb), a MakeHuman man on his own skeleton in his natural bind
// pose, with every clip retargeted OFFLINE in Blender (scripts/playerb/): CMU mocap for walk, jog, run, backpedal,
// sidesteps, idle and jump; Quaternius UAL for crouch; authored right-arm poses for the flashlight carry. At runtime
// the clips play as they are (no retargeting, no limb IK): locomotion is a distance-driven phase shared by all loops,
// a speed blend within a direction set and a direction blend across sets by the local velocity. The only correction
// is a small, smoothed pelvis height offset that keeps the planted foot on the ground it stands on.

/** The PlayerState fields the body reads (src/player.ts PlayerState is a superset). */
export type BodyBState = {
  readonly pos: { x: number; y: number; z: number }
  readonly vel: { x: number; y: number; z: number }
  readonly yaw: number
  readonly crouch: number
  readonly grounded: boolean
  readonly onLadder: boolean
  /** View pitch (rad, + up) and flashlight on: the right hand carries the torch and aims it with the view. */
  readonly pitch?: number
  readonly flashlight?: boolean
}

type CarryMeta = Record<string, { beam_pitch: number }>
const CARRY = ["Carry_Level", "Carry_Up", "Carry_Down", "Carry_Run", "Carry_Crouch"] as const
const TORSO = new Set(["pelvis", "spine_01", "spine_02", "spine_03"])
const THIGHS = new Set(["thigh_l", "thigh_r"])
const HIDE_Y = 1.49

export type GroundFn = (x: number, z: number, maxY: number) => number

type Loop = {
  name: string
  action: THREE.AnimationAction
  duration: number
  /** Measured ground speed of the planted foot (m/s); 0 for idles. */
  speed: number
  /** Clip time of the left heel strike. */
  offset: number
  weight: number
  /** Local travel direction (rad, 0 forward, +right). */
  dir: number
}

type DirSet = { dir: number; loops: Loop[]; reverse?: boolean }

// M_* loops are CMU mocap retargeted offline (scripts/playerb/mocap.py); each starts at a left-foot touchdown and its
// ground speed and travel direction come from the bake (clips.json). The rest are UAL clips, measured at load.
const LOOPS = {
  idle: "M_Idle",
  walk: "M_Walk",
  brisk: "M_WalkBrisk",
  jog: "M_Jog",
  run: "M_Run",
  back: "M_WalkBack",
  left: "M_WalkLeft",
  right: "M_WalkRight",
  crouchIdle: "Crouch_Idle_Loop",
  crouchWalk: "Crouch_Fwd_Loop",
} as const
// Jump: CMU 16_02 (a standing vertical jump) cut into push-off, flight and landing. The flight pose is driven by the
// vertical velocity (rising → apex → falling), so any jump height or fall plays the whole tuck-and-reach.
const ONESHOTS = { jumpStart: "M_JumpStart", jumpAir: "M_JumpAir", jumpLand: "M_JumpLand" } as const
const JUMP_V = Math.sqrt(2 * 9.81 * 0.48)

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt)

export class PlayerBodyB {
  readonly root = new THREE.Group()
  model: THREE.Object3D | null = null
  readonly ready: Promise<void>
  readonly debug = {
    state: "idle",
    phase: 0,
    weights: {} as Record<string, number>,
    pelvis: 0,
    clips: {} as Record<string, { speed: number; offset: number; duration: number }>,
    /** Planted-foot slide (m/s, smoothed) and planted flags, left/right. */
    slide: [0, 0],
    planted: [false, false],
  }
  private lastFoot = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  private hasLastFoot = false
  /** Bind-pose heights of the ankle and ball joints above the soles' floor. */
  private restFoot = [0.08, 0.02]
  private mixer: THREE.AnimationMixer | null = null
  private loops = new Map<string, Loop>()
  private shots = new Map<string, THREE.AnimationAction>()
  private standing: DirSet[] = []
  private crouching: DirSet[] = []
  private phase = 0
  private bones: Record<string, THREE.Bone> = {}
  private rootY = Number.NaN
  private air = 0
  private land = 1
  private wasGrounded = true
  private shotT = new Map<string, number>()
  private smoothVel = new THREE.Vector2()
  private dirW = new Map<DirSet, number>()
  private pose: { clip: string; phase: number } | null = null
  private ground: GroundFn
  private clips = new Map<string, THREE.AnimationClip>()
  /** Authored carry poses: bone -> local rotation, per Carry_* clip. */
  private carry = new Map<string, Map<string, THREE.Quaternion>>()
  private carryW = 0
  private carryRun = 0
  readonly torch = createTorch()
  /** First-person view: collapse the head (and the hair, eyes and brows bound to it) into the neck. */
  hideHead = false
  /** Head-and-neck draw parts (those triangles of the skin and shirt, hair, eyes, brows, lashes), hidden in first person. */
  private headParts: { visible: boolean }[] = []
  /** First person: shift the body (smoothed, horizontal) so its eyes stay under the camera instead of the feet. */
  eyeAnchor = false
  private eyeOff = new THREE.Vector2()
  /** Skinned torso/thigh vertices for the clearance test: [mesh, vertex index, axis kind]. */
  private probe: { mesh: THREE.SkinnedMesh; idx: number[]; kind: number[] }[] = []
  private posed = false

  constructor(opts: { url: string; ground: GroundFn }) {
    this.ground = opts.ground
    this.ready = new GLTFLoader().loadAsync(opts.url).then((gltf) => this.init(gltf))
  }

  private init(gltf: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }) {
    const model = gltf.scene
    this.model = model
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if ((o as THREE.Bone).isBone) this.bones[o.name] = o as THREE.Bone
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = true
      m.frustumCulled = false
      m.material = nodeMaterial(m.material as THREE.MeshStandardMaterial)
    })
    this.root.add(model)
    model.updateMatrixWorld(true)
    const v = new THREE.Vector3()
    this.restFoot = [this.bones.foot_l!.getWorldPosition(v).y, this.bones.ball_l!.getWorldPosition(v).y]
    const mixer = new THREE.AnimationMixer(model)
    this.mixer = mixer
    const clips = new Map(gltf.animations.map((c) => [c.name, c]))
    this.clips = clips
    for (const name of CARRY) {
      const clip = clips.get(name)
      if (!clip) continue
      const pose = new Map<string, THREE.Quaternion>()
      for (const t of clip.tracks) {
        const [bone, prop] = t.name.split(".") as [string, string]
        if (prop !== "quaternion" || !/_r$/.test(bone) || !/^(upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)/.test(bone)) continue
        pose.set(bone, new THREE.Quaternion().fromArray(t.values as unknown as number[], 0))
      }
      this.carry.set(name, pose)
    }
    // The torch rides on the right hand at the authored grip (model-space rest matrix from the build: its barrel axis
    // is the torch's -Z, the lens side). The hand is in its bind pose here, so the rest offset is exact.
    const g = (BAKED as unknown as { carry: { grip?: { pos: number[]; x: number[]; barrel: number[]; z: number[] } } }).carry.grip
    if (g) {
      model.updateMatrixWorld(true)
      const V = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2])
      const bz = V(g.barrel).negate()
      const bx = V(g.x)
      const by = new THREE.Vector3().crossVectors(bz, bx).normalize()
      bx.crossVectors(by, bz).normalize()
      const M = new THREE.Matrix4().makeBasis(bx, by, bz).setPosition(V(g.pos))
      const hand = this.bones.hand_r!
      M.premultiply(model.matrixWorld).premultiply(hand.matrixWorld.clone().invert())
      M.decompose(this.torch.position, this.torch.quaternion, this.torch.scale)
      hand.add(this.torch)
    }
    // First-person head hiding without collapsing bones: the skin mesh's triangles dominated by the head bone go in
    // their own draw group with their own (hideable) material; hair, eyes, brows and lashes are separate meshes.
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh) return
      const mat = m.material as THREE.Material
      if (["hair", "eyes", "brows", "lashes"].includes(mat.name)) return void this.headParts.push(m)
      if ((mat.name !== "skin" && mat.name !== "suit") || !m.geometry.index) return
      // Head, neck and the collar above HIDE_Y in the bind pose (they ring the camera when looking down).
      const upper = new Set(["Head", "neck_01", "spine_03", "clavicle_l", "clavicle_r"])
      const hb = new Set(m.skeleton.bones.flatMap((b, i) => (upper.has(b.name) ? [i] : [])))
      const pos = m.geometry.attributes.position!
      const bind = m.bindMatrix
      const pv = new THREE.Vector3()
      const si = m.geometry.attributes.skinIndex!
      const sw = m.geometry.attributes.skinWeight!
      const isHead = (v: number) => {
        let w = 0
        for (let k = 0; k < 4; k++) if (hb.has(si.getComponent(v, k))) w += sw.getComponent(v, k)
        return w > 0.5 && pv.fromBufferAttribute(pos, v).applyMatrix4(bind).y > HIDE_Y
      }
      const idx = m.geometry.index.array
      const a: number[] = []
      const b: number[] = []
      for (let i = 0; i < idx.length; i += 3) (isHead(idx[i]!) && isHead(idx[i + 1]!) && isHead(idx[i + 2]!) ? b : a).push(idx[i]!, idx[i + 1]!, idx[i + 2]!)
      m.geometry.setIndex([...a, ...b])
      m.geometry.clearGroups()
      m.geometry.addGroup(0, a.length, 0)
      m.geometry.addGroup(a.length, b.length, 1)
      const headMat = mat.clone()
      m.material = [mat, headMat]
      this.headParts.push(headMat)
    })
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh || !/^Human(\.?male_casualsuit01)?(_\d+)?$/.test(m.name)) return
      const si = m.geometry.attributes.skinIndex!
      const sw = m.geometry.attributes.skinWeight!
      const idx: number[] = []
      const kind: number[] = []
      for (let i = 0; i < si.count; i += 2) {
        let best = 0
        for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k
        const bone = m.skeleton.bones[si.getComponent(i, best)]!.name
        if (TORSO.has(bone)) kind.push(0)
        else if (THIGHS.has(bone)) kind.push(bone === "thigh_l" ? 1 : 2)
        else continue
        idx.push(i)
      }
      this.probe.push({ mesh: m, idx, kind })
    })
    // Measure each loop on the skeleton itself: the planted foot's backward speed and the left heel strike.
    const probe = new THREE.Vector3()
    for (const name of Object.values(LOOPS)) {
      const clip = clips.get(name)
      if (!clip) continue
      const action = mixer.clipAction(clip)
      action.play()
      action.timeScale = 0
      action.setEffectiveWeight(0)
      const baked = (BAKED as unknown as Record<string, { speed: number; dir: number }>)[name]
      // Forward loops: the planted foot's measured speed on this skeleton (the bake's stride solve is a fallback for
      // the side/back loops the forward-only measure can't read).
      const meas = this.measure(action, clip, probe)
      const m = baked ? { speed: meas.speed > 0.3 ? meas.speed : baked.speed, offset: 0 } : meas
      this.loops.set(name, { name, action, duration: clip.duration, speed: m.speed, offset: m.offset, weight: 0, dir: baked ? (-baked.dir * Math.PI) / 180 : 0 })
      const mm = meas
      this.debug.clips[name] = { speed: +m.speed.toFixed(3), offset: +(m.offset / clip.duration).toFixed(3), duration: +clip.duration.toFixed(3), measured: +mm.speed.toFixed(3) } as never
    }
    for (const name of Object.values(ONESHOTS)) {
      const clip = clips.get(name)
      if (!clip) continue
      const action = mixer.clipAction(clip)
      action.play()
      action.timeScale = 0
      action.setEffectiveWeight(0)
      this.shots.set(name, action)
    }
    const L = (n: string) => this.loops.get(n)
    const set = (dir: number, names: string[], reverse = false): DirSet | null => {
      const loops = names.map(L).filter((l): l is Loop => !!l)
      return loops.length ? { dir, loops, reverse } : null
    }
    const fwd = set(0, [LOOPS.walk, LOOPS.brisk, LOOPS.jog, LOOPS.run])!
    const back = set(Math.PI, [LOOPS.back]) ?? { ...fwd, dir: Math.PI, reverse: true }
    this.standing = [fwd, back]
    for (const n of [LOOPS.left, LOOPS.right]) {
      const l = L(n)
      if (l) this.standing.push({ dir: l.dir, loops: [l] })
    }
    const cf = set(0, [LOOPS.crouchWalk])!
    this.crouching = [cf, { ...cf, dir: Math.PI, reverse: true }]
  }

  /** Planted-foot speed and left heel-strike time of a loop, from its own foot bones (model space, +Z forward). */
  private measure(action: THREE.AnimationAction, clip: THREE.AnimationClip, v: THREE.Vector3) {
    const mixer = this.mixer!
    const N = 120
    const foot = this.bones.foot_l!
    const footR = this.bones.foot_r!
    const z: number[] = []
    const y: number[] = []
    const zr: number[] = []
    const yr: number[] = []
    action.setEffectiveWeight(1)
    for (let i = 0; i < N; i++) {
      action.time = (i / N) * clip.duration
      mixer.update(0)
      this.model!.updateMatrixWorld(true)
      foot.getWorldPosition(v)
      z.push(v.z)
      y.push(v.y)
      footR.getWorldPosition(v)
      zr.push(v.z)
      yr.push(v.y)
    }
    action.setEffectiveWeight(0)
    // Contact point per foot: whichever of ankle / ball is nearer its own floor height; stance = within 1.5 cm.
    const bl = this.bones.ball_l!
    const br = this.bones.ball_r!
    void bl
    void br
    const dt = clip.duration / N
    const speeds: number[] = []
    for (const [zz, yy] of [
      [z, y],
      [zr, yr],
    ] as const) {
      const ymin = Math.min(...yy)
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N
        if (yy[i]! < ymin + 0.015 && yy[j]! < ymin + 0.015) speeds.push(-(zz[j]! - zz[i]!) / dt)
      }
    }
    speeds.sort((a, b) => a - b)
    const speed = speeds.length ? Math.max(0, speeds[speeds.length >> 1]!) : 0
    let best = 0
    for (let i = 1; i < N; i++) if (z[i]! - zr[i]! > z[best]! - zr[best]!) best = i
    return { speed: speed < 0.15 ? 0 : speed, offset: (best / N) * clip.duration }
  }

  /** Automation: hold one loop at a normalized phase (0 = left heel strike), or null to resume. */
  setPose(p: { clip: string; phase: number } | null) {
    this.pose = p
  }

  /**
   * Layers the authored flashlight carry over the locomotion on the right arm (a mask: upper arm, forearm, hand,
   * fingers). Aim offset: Carry_Level/Up/Down blended by the view pitch to their measured beam pitches; running
   * blends toward Carry_Run. Beyond the poses' range the arm stops and the beam leads (the light follows the view).
   */
  private applyCarry(dt: number, s: BodyBState, speed: number) {
    this.carryW += ((s.flashlight ? 1 : 0) - this.carryW) * damp(9, dt)
    this.torch.visible = this.carryW > 0.5
    if (this.carryW < 1e-3 || !this.carry.size) return
    const meta = (BAKED as unknown as { carry: CarryMeta }).carry
    const pitch = THREE.MathUtils.radToDeg(s.pitch ?? 0)
    const lv = meta.Carry_Level!.beam_pitch
    const up = meta.Carry_Up!.beam_pitch
    const dn = meta.Carry_Down!.beam_pitch
    const tUp = THREE.MathUtils.clamp((pitch - lv) / (up - lv), 0, 1)
    const tDn = THREE.MathUtils.clamp((lv - pitch) / (lv - dn), 0, 1)
    this.carryRun += (smooth(2.4, 3.6, s.grounded ? speed : 0) - this.carryRun) * damp(6, dt)
    const L = this.carry.get("Carry_Level")!
    const U = this.carry.get("Carry_Up")!
    const D = this.carry.get("Carry_Down")!
    const R = this.carry.get("Carry_Run")!
    const K = this.carry.get("Carry_Crouch")
    const crouch = smooth(0.15, 0.7, s.crouch)
    // Unsmoothed: the thighs swing higher the moment the stride lengthens.
    const strideW = (this.loops.get(LOOPS.jog)?.weight ?? 0) + (this.loops.get(LOOPS.run)?.weight ?? 0)
    const fast = Math.max(this.carryRun, smooth(1.9, 2.8, speed), Math.min(1, strideW * 1.5))
    const q = new THREE.Quaternion()
    for (const [bone, ql] of L) {
      const b = this.bones[bone]
      if (!b) continue
      q.copy(ql)
      if (tUp > 0) q.slerp(U.get(bone)!, tUp)
      // Running, the thighs swing up to the hand: the arm only lowers the torch a little (the beam leads the rest).
      if (tDn > 0) q.slerp(D.get(bone)!, tDn * (1 - 0.85 * fast))
      if (this.carryRun > 0) q.slerp(R.get(bone)!, this.carryRun * (1 - 0.5 * Math.max(tUp, tDn)))
      if (K && crouch > 0) q.slerp(K.get(bone)!, crouch)
      // A carried arm still moves a little with the body: keep a trace of the gait's swing at the shoulder.
      const keep = bone === "upperarm_r" ? 0.1 : 0
      b.quaternion.slerp(q, this.carryW * (1 - keep))
    }
  }

  /** Lens position and beam direction (world), or false while the torch is put away. */
  torchLens(pos: THREE.Vector3, dir: THREE.Vector3) {
    if (!this.torch.visible) return false
    const lens = this.torch.userData.lens as THREE.Object3D
    lens.updateWorldMatrix(true, false)
    lens.getWorldPosition(pos)
    dir.set(0, 0, -1).transformDirection(lens.matrixWorld)
    return true
  }

  /**
   * Automation: signed clearance (m) between the carrying arm/torch and the skinned torso and thighs: forearm,
   * hand and torch sample points (minus their own radius) against the nearest skin/shirt vertex along its outward
   * normal (from the torso or thigh axis). Negative = interpenetration.
   */
  clearance() {
    if (!this.model) return null
    const B = this.bones
    const P = (n: string) => B[n]!.getWorldPosition(new THREE.Vector3())
    const pts: [string, THREE.Vector3, number][] = []
    const e = P("lowerarm_r")
    const w = P("hand_r")
    for (const t of [0.35, 0.6, 0.85]) pts.push([`forearm${t}`, e.clone().lerp(w, t), 0.042])
    pts.push(["hand", w.clone().lerp(P("middle_01_r"), 0.6), 0.03])
    if (this.torch.visible) {
      for (const z of [0.1, 0, -0.08, -0.15]) pts.push([`torch${z}`, this.torch.localToWorld(new THREE.Vector3(0, 0, z)), z < -0.09 ? 0.027 : 0.018])
    }
    // Surface radius along the ray from the body axis through each sample point: the largest radial distance of a
    // torso/thigh vertex lying within ~14° of that ray and within 3 cm of the same axis height.
    const axes = [
      [P("pelvis"), P("neck_01")],
      [P("thigh_l"), P("calf_l")],
      [P("thigh_r"), P("calf_r")],
    ] as const
    const v = new THREE.Vector3()
    const c = new THREE.Vector3()
    const d = new THREE.Vector3()
    const seg = new THREE.Line3()
    const rays = pts.map(([, p]) =>
      axes.map(([a0, a1]) => {
        seg.set(a0, a1)
        const t = seg.closestPointToPointParameter(p, true)
        const cp = seg.at(t, new THREE.Vector3())
        const r = p.distanceTo(cp)
        return { t, len: a0.distanceTo(a1), r, dir: p.clone().sub(cp).divideScalar(r || 1), surf: 0 }
      }),
    )
    for (const pr of this.probe) {
      pr.mesh.updateMatrixWorld()
      for (let k = 0; k < pr.idx.length; k++) {
        pr.mesh.getVertexPosition(pr.idx[k]!, v)
        v.applyMatrix4(pr.mesh.matrixWorld)
        const ai = pr.kind[k]!
        const [a0, a1] = axes[ai]!
        seg.set(a0, a1)
        const t = seg.closestPointToPointParameter(v, true)
        seg.at(t, c)
        const r = v.distanceTo(c)
        d.subVectors(v, c).divideScalar(r || 1)
        for (const ray of rays) {
          const q = ray[ai]!
          if (Math.abs(t - q.t) * q.len > 0.03 || d.dot(q.dir) < 0.97) continue
          if (r > q.surf) q.surf = r
        }
      }
    }
    const best = rays.map((ray, j) => ({
      s: Math.min(...ray.map((q) => (q.surf > 0 && q.t > 0 && q.t < 1 ? q.r - q.surf - pts[j]![2] : Infinity))),
    }))
    // The torch against its own forearm (the tail must pass under the wrist, not through it): barrel points behind
    // the grip vs the elbow→wrist segment, forearm radius ~3.2 cm at the wrist.
    if (this.torch.visible) {
      seg.set(e, w)
      for (const z of [0.105, 0.07, 0.04]) {
        const p = this.torch.localToWorld(new THREE.Vector3(0, 0, z))
        const t = seg.closestPointToPointParameter(p, true)
        const s2 = p.distanceTo(seg.at(t, c)) - 0.018 - (0.032 + 0.012 * (1 - t))
        rays.push([])
        pts.push([`tail${z}`, p, 0])
        best.push({ s: t > 0.02 && t < 0.999 ? s2 : Infinity })
      }
    }
    let min = Infinity
    let at = ""
    for (let j = 0; j < pts.length; j++)
      if (best[j]!.s < min) {
        min = best[j]!.s
        const q = rays[j]!.length ? rays[j]!.reduce((a, b) => (b.surf > 0 && b.r - b.surf < a.r - a.surf ? b : a)) : null
        at = q ? `${pts[j]![0]} r${(q.r * 100).toFixed(0)}/surf${(q.surf * 100).toFixed(0)}cm` : `${pts[j]![0]} vs forearm`
      }
    return { min, at }
  }

  /** Automation: model-space joint positions over one cycle of a clip (+Z forward). */
  trace(name: string, n = 60, joints = ["foot_l", "foot_r", "ball_l", "ball_r", "pelvis"]) {
    const clip = this.clips.get(name)
    const mixer = this.mixer
    if (!clip || !mixer || !this.model) return null
    const saved = this.root.matrix.clone()
    this.root.position.set(0, 0, 0)
    this.root.rotation.set(0, 0, 0)
    this.root.updateMatrixWorld(true)
    mixer.stopAllAction()
    const a = mixer.clipAction(clip)
    a.play()
    a.timeScale = 0
    a.setEffectiveWeight(1)
    const out: Record<string, number[][]> = {}
    const v = new THREE.Vector3()
    for (let i = 0; i < n; i++) {
      a.time = (i / n) * clip.duration
      mixer.update(0)
      this.model.updateMatrixWorld(true)
      for (const j of joints) {
        this.bones[j]?.getWorldPosition(v)
        ;(out[j] ??= []).push([+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)])
      }
    }
    mixer.stopAllAction()
    this.posed = true
    saved.decompose(this.root.position, this.root.quaternion, this.root.scale)
    return { duration: clip.duration, out }
  }

  clipNames() {
    return [...this.loops.keys(), ...this.shots.keys()]
  }

  update(dt: number, s: BodyBState) {
    const mixer = this.mixer
    if (!mixer || !this.model) return
    this.root.position.set(s.pos.x, Number.isNaN(this.rootY) ? s.pos.y : this.rootY, s.pos.z)
    this.root.rotation.y = s.yaw + Math.PI
    for (const l of this.loops.values()) l.weight = 0
    const w = this.debug.weights
    for (const k in w) w[k] = 0

    if (this.pose) {
      const clip = this.clips.get(this.pose.clip)
      const l = this.loops.get(this.pose.clip)
      mixer.stopAllAction()
      if (clip) {
        const a = mixer.clipAction(clip)
        a.play()
        a.timeScale = 0
        a.setEffectiveWeight(1)
        a.time = l ? (l.offset + this.pose.phase * l.duration) % l.duration : Math.min(this.pose.phase, 0.999) * clip.duration
      }
      mixer.update(0)
      this.posed = true
      this.rootY = s.pos.y
      this.root.position.y = s.pos.y
      this.debug.state = `pose ${this.pose.clip}`
      return
    }
    if (this.posed) {
      this.posed = false
      mixer.stopAllAction()
      for (const l of this.loops.values()) l.action.play()
      for (const a of this.shots.values()) a.play()
    }

    // Local velocity (smoothed a little so blends don't flicker on key taps).
    const sy = Math.sin(s.yaw)
    const cy = Math.cos(s.yaw)
    const vf = -sy * s.vel.x - cy * s.vel.z
    const vs = cy * s.vel.x - sy * s.vel.z
    this.smoothVel.lerp(new THREE.Vector2(vf, vs), damp(14, dt))
    const speed = this.smoothVel.length()
    const ang = Math.atan2(this.smoothVel.y, this.smoothVel.x)
    const crouch = s.crouch

    // Direction weights: each set's angular proximity (sets 90° apart cross-fade linearly).
    const sets = [...this.standing, ...this.crouching]
    const dirs = new Map<DirSet, number>()
    // Circular 1D blend: the two sets whose directions bracket the travel direction, weighted linearly by angle.
    const addDirs = (group: DirSet[], gw: number) => {
      const sorted = [...group].sort((x, y) => x.dir - y.dir)
      if (sorted.length === 1) return void dirs.set(sorted[0]!, gw)
      const wrap = (x: number) => ((x % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i]!
        const b = sorted[(i + 1) % sorted.length]!
        const span = wrap(b.dir - a.dir) || Math.PI * 2
        const off = wrap(ang - a.dir)
        if (off <= span) {
          const t = off / span
          dirs.set(a, (dirs.get(a) ?? 0) + (1 - t) * gw)
          dirs.set(b, (dirs.get(b) ?? 0) + t * gw)
          return
        }
      }
    }
    addDirs(this.standing, 1 - crouch)
    addDirs(this.crouching, crouch)
    for (const g of sets) {
      const prev = this.dirW.get(g) ?? 0
      this.dirW.set(g, prev + ((dirs.get(g) ?? 0) - prev) * damp(10, dt))
    }

    // Speed blend within each set, and the shared cycle length.
    let cycle = 0
    let moveW = 0
    const per: [DirSet, number, [Loop, number][]][] = []
    for (const g of sets) {
      const gw = this.dirW.get(g) ?? 0
      if (gw < 1e-3) continue
      const ls = g.loops
      const tiers: [Loop, number][] = []
      if (speed <= ls[0]!.speed || ls.length === 1) tiers.push([ls[0]!, 1])
      else if (speed >= ls[ls.length - 1]!.speed) tiers.push([ls[ls.length - 1]!, 1])
      else
        for (let i = 0; i < ls.length - 1; i++) {
          const a = ls[i]!
          const b = ls[i + 1]!
          if (speed >= a.speed && speed <= b.speed) {
            const t = (speed - a.speed) / (b.speed - a.speed)
            tiers.push([a, 1 - t], [b, t])
          }
        }
      per.push([g, gw, tiers])
      for (const [l, tw] of tiers) cycle += gw * tw * l.speed * l.duration
      moveW += gw
    }
    cycle /= moveW || 1
    const moving = per.length ? smooth(0.08, 0.5, speed) : 0
    if (cycle > 0.05) this.phase = (this.phase + (speed * dt) / cycle) % 1
    this.debug.phase = this.phase

    // Airborne / landing.
    if (!s.grounded && this.wasGrounded) {
      this.shotT.set(ONESHOTS.jumpStart, 0)
      this.air = 0
    }
    if (s.grounded && !this.wasGrounded) {
      this.land = 0
      this.shotT.set(ONESHOTS.jumpLand, 0)
    }
    this.wasGrounded = s.grounded
    this.air += ((s.grounded ? 0 : 1) - this.air) * damp(s.grounded ? 12 : 16, dt)
    const landDur = this.shots.get(ONESHOTS.jumpLand)?.getClip().duration ?? 0.4
    this.land = Math.min(1, this.land + dt / landDur)
    // Landing absorption: full at touchdown, easing out over the clip; lighter when landing into a walk or run.
    const landW = s.grounded && this.land < 1 ? (1 - smooth(0.35, 1, this.land)) * (1 - moving * 0.55) : 0

    const ground = (1 - this.air) * (1 - landW)
    const idleW = ground * (1 - moving)
    const idle = this.loops.get(LOOPS.idle)
    const cidle = this.loops.get(LOOPS.crouchIdle)
    if (idle) idle.weight += idleW * (1 - crouch)
    if (cidle) cidle.weight += idleW * crouch
    for (const [g, gw, tiers] of per) {
      for (const [l, tw] of tiers) {
        l.weight += (ground * moving * gw * tw) / (moveW || 1)
        const p = g.reverse ? 1 - this.phase : this.phase
        l.action.time = (l.offset + p * l.duration) % l.duration
      }
    }
    for (const l of [idle, cidle]) if (l) l.action.time = (l.action.time + dt) % l.duration
    for (const l of this.loops.values()) {
      l.action.setEffectiveWeight(l.weight)
      if (l.weight > 0.01) w[l.name] = (w[l.name] ?? 0) + l.weight
    }

    // One-shots: start → air loop while airborne, land on touchdown.
    const st = this.shots.get(ONESHOTS.jumpStart)
    const al = this.shots.get(ONESHOTS.jumpAir)
    const ld = this.shots.get(ONESHOTS.jumpLand)
    const advance = (a: THREE.AnimationAction | undefined, loop: boolean) => {
      if (!a) return 0
      const d = a.getClip().duration
      const n = a.getClip().name
      const t = (this.shotT.get(n) ?? d) + dt
      this.shotT.set(n, loop ? t % d : Math.min(t, d))
      a.time = loop ? t % d : Math.min(t, d - 1e-3)
      return t / d
    }
    const stp = advance(st, false)
    if (al) al.time = Math.min(1, Math.max(0, 0.5 - s.vel.y / (2 * JUMP_V))) * (al.getClip().duration - 1e-3)
    advance(ld, false)
    const stW = this.air * Math.max(0, 1 - stp)
    st?.setEffectiveWeight(stW)
    al?.setEffectiveWeight(this.air - stW)
    ld?.setEffectiveWeight((1 - this.air) * landW)
    if (stW > 0.01) w.jump_start = stW
    if (this.air - stW > 0.01) w.jump_air = this.air - stW
    if (landW > 0.01) w.land = landW
    this.debug.state = !s.grounded ? "air" : speed < 0.1 ? (crouch > 0.5 ? "crouch" : "idle") : crouch > 0.5 ? "crouch walk" : "move"

    mixer.update(0)
    this.applyCarry(dt, s, speed)
    if (this.eyeAnchor) {
      // Eyes ≈ 9 cm above and 9 cm in front of the head joint; keep them under the camera (low-passed so the gait's
      // sway stays in the body and the feet stay planted).
      this.model.updateMatrixWorld(true)
      const e = this.bones.Head!.localToWorld(new THREE.Vector3(0, 0, 0))
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.quaternion)
      e.addScaledVector(fwd, 0.09)
      // Looking down, the body steps back under the eye (up to 12 cm) so the view falls on the chest, belly and
      // the torch, not into the neck opening.
      const back = 0.12 * Math.max(0, -Math.sin(s.pitch ?? 0))
      const tx = -(e.x - this.root.position.x) - fwd.x * back
      const tz = -(e.z - this.root.position.z) - fwd.z * back
      this.eyeOff.x += (tx - this.eyeOff.x) * damp(4, dt)
      this.eyeOff.y += (tz - this.eyeOff.y) * damp(4, dt)
    } else this.eyeOff.set(0, 0)
    this.root.position.x = s.pos.x + this.eyeOff.x
    this.root.position.z = s.pos.z + this.eyeOff.y
    for (const m of this.headParts) m.visible = !this.hideHead

    // Pelvis height: the root follows the ground under the planted foot (lower foot weighs more), smoothed.
    this.model.updateMatrixWorld(true)
    const fl = this.bones.foot_l!.getWorldPosition(new THREE.Vector3())
    const fr = this.bones.foot_r!.getWorldPosition(new THREE.Vector3())
    // Slide meter: the planted foot's contact point (heel/ankle or ball, whichever moves less) should not move over
    // the ground (root-relative motion + body motion).
    if (dt > 0) {
      const pts = [fl, fr, this.bones.ball_l!.getWorldPosition(new THREE.Vector3()), this.bones.ball_r!.getWorldPosition(new THREE.Vector3())]
      const v: number[] = []
      for (let i = 0; i < 4; i++) {
        const rel = pts[i]!.clone().sub(this.root.position)
        v.push(this.hasLastFoot ? Math.hypot((rel.x - this.lastFoot[i]!.x) / dt + s.vel.x, (rel.z - this.lastFoot[i]!.z) / dt + s.vel.z) : 0)
        this.lastFoot[i]!.copy(rel)
      }
      for (let i = 0; i < 2; i++) {
        // Contact height: ankle or ball, whichever is nearer its bind-pose height (flat foot on the floor).
        const h = Math.min(pts[i]!.y - this.restFoot[0], pts[i + 2]!.y - this.restFoot[1]) - this.root.position.y
        const planted = this.hasLastFoot && s.grounded && h < 0.02
        this.debug.planted[i] = planted
        this.debug.slide[i] = planted ? this.debug.slide[i]! + (Math.min(v[i]!, v[i + 2]!) - this.debug.slide[i]!) * damp(20, dt) : 0
      }
      this.hasLastFoot = true
    }
    const base = this.root.position.y
    const top = s.pos.y + 0.45
    const gl = this.ground(fl.x, fl.z, top)
    const gr = this.ground(fr.x, fr.z, top)
    const hl = fl.y - base
    const hr = fr.y - base
    const k = 1 / (1 + Math.exp((hl - hr) / 0.02))
    let target = s.grounded ? k * gl + (1 - k) * gr : s.pos.y
    if (!s.grounded || s.onLadder) target = s.pos.y
    if (Number.isNaN(this.rootY) || Math.abs(target - this.rootY) > 1) this.rootY = target
    this.rootY += (target - this.rootY) * damp(s.grounded ? 18 : 40, dt)
    this.root.position.y = this.rootY
    this.debug.pelvis = this.rootY - s.pos.y
  }
}

function nodeMaterial(src: THREE.MeshStandardMaterial) {
  const m = new THREE.MeshStandardNodeMaterial({
    map: src.map,
    normalMap: src.normalMap,
    roughness: src.roughness,
    metalness: src.metalness,
    color: src.color,
  })
  m.name = src.name
  if (src.alphaTest > 0 || src.transparent || ["hair", "brows", "lashes"].includes(src.name)) {
    m.alphaTest = 0.5
    m.side = THREE.DoubleSide
  }
  if (src.name === "eyes") m.roughness = 0.15
  return m
}
