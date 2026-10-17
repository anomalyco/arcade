import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import { ik, limb, RIG, type Frame, type V3 } from "@arcade/kit/rig"
import type { WorldContext } from "../world/context"
import { heightAt } from "../world/height"
import type { Player } from "../player"
import { Gait, type GaitPose } from "./gait"
import { createTorch } from "./torch"
import { createDemo } from "./demo"

// The player's own body: a rigged, clothed MakeHuman janitor (public/models/player/janitor.glb, CC0) driven by the arcade
// kit's procedural locomotion (gait.ts) and per-foot ground IK, so looking down shows your torso, legs and boots with
// feet planted on the floor, steps, slopes and the lift. Reads the Player's state only (position, yaw, pitch,
// flashlight, fly).
//
// Visibility and shadows use layers so nothing here changes how the world renders:
//   - BODY layer: the body. The view camera sees it; lamp shadow maps include it; the flashlight's map excludes it (the
//     beam starts at the face, so the body would otherwise shadow everything you point it at).
//   - HEAD layer: head, neck and hair. Not seen by the view camera (no head in your face), still in lamp shadows, so
//     the silhouette a lamp throws has a head.
// Lamp shadow maps are static (render/lighting.ts re-renders them only when the world changes), so while the body is
// in a shadowed lamp's cone it asks that map to re-render (Player → "Body in lamp shadows").

export const BODY_LAYER = 3
const HEAD_LAYER = 4
/** A layer nothing uses: gives the flashlight's shadow camera its own mask (layer 0 alone means "copy the view's"). */
const SPARE_LAYER = 5
const EYE = 1.65
const STEP = 0.45
const KIT_LEG = RIG.thigh + RIG.shin
/** Length of the E reach (out and back), seconds. */
const REACH_S = 0.75
/** Forearm pronation from the rest pose's palms-forward to palms-on-the-thighs (radians). */
const PALM_IN = -1.2

type Settings = { show: boolean; back: number; lookBack: number; lampShadows: boolean }

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const tv = (p: V3) => new THREE.Vector3(p[0], p[1], p[2])
const basis = new THREE.Matrix4()
function frameQuat(f: Frame, out: THREE.Quaternion) {
  basis.makeBasis(tv(f.x), tv(f.y), tv(f.z))
  return out.setFromRotationMatrix(basis)
}

/** Facing frame of the model at rest: it faces +Z, so its right is -X. */
const REST: Frame = { p: [0, 0, 0], x: [0, 0, 1], y: [0, 1, 0], z: [-1, 0, 0] }

const BONES = [
  "Root", "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head",
  "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r",
  "thigh_l", "calf_l", "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r",
] as const
type BoneName = (typeof BONES)[number]
const FINGERS = ["index", "middle", "ring", "pinky"] as const

export function createBody(ctx: WorldContext, player: Player) {
  const params = ctx.params
  ctx.settings["player.body"] ??= params.get("body") !== "0"
  ctx.settings["player.bodyBack"] ??= 0.1
  ctx.settings["player.bodyLookBack"] ??= 0.12
  ctx.settings["player.bodyLampShadows"] ??= true
  ctx.controls.push(
    { key: "player.body", label: "Show body", group: "Player", type: "toggle" },
    { key: "player.bodyBack", label: "Body behind the eyes", group: "Player", unit: "m", min: 0, max: 0.3, step: 0.01 },
    { key: "player.bodyLookBack", label: "Hips back when looking down", group: "Player", unit: "m", min: 0, max: 0.3, step: 0.01 },
    { key: "player.bodyLampShadows", label: "Body in lamp shadows", group: "Player", type: "toggle" },
  )
  const settings = (): Settings => ({
    show: ctx.settings["player.body"] !== false,
    back: Number(ctx.settings["player.bodyBack"] ?? 0.1),
    lookBack: Number(ctx.settings["player.bodyLookBack"] ?? 0.12),
    lampShadows: ctx.settings["player.bodyLampShadows"] !== false,
  })

  const camera = ctx.camera
  camera.layers.enable(BODY_LAYER)
  const demo = createDemo(ctx, player, groundAt)
  if (demo.thirdPerson) camera.layers.enable(HEAD_LAYER)

  let rig: Rig | null = null
  const root = new THREE.Group()
  root.name = "player-body"
  const torch = createTorch()
  torch.layers.set(BODY_LAYER)
  torch.traverse((o) => o.layers.set(BODY_LAYER))
  root.add(torch)

  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  loader
    .loadAsync(`${import.meta.env.BASE_URL}models/player/janitor.glb`)
    .then(async (gltf) => {
      const r = new Rig(gltf.scene)
      root.add(gltf.scene)
      root.visible = false
      // Compile off the critical path, then show.
      // Compile with a camera that sees the head layer too (the view camera keeps rendering meanwhile).
      const probe = camera.clone()
      probe.layers.enable(HEAD_LAYER)
      await ctx.renderer.compileAsync(root, probe, ctx.scene).catch(() => {})
      ctx.scene.add(root)
      rig = r
      gait.reset()
    })
    .catch((e: unknown) => console.error("player body:", e))

  const gait = new Gait()
  let baseY = Number.NaN
  let drop = 0
  const ground: [number, number] = [0, 0]
  const lift: [number, number] = [0, 0]
  const normals = [v(0, 1, 0), v(0, 1, 0)]
  let wasFly = false
  const tmp = { fwd: v(), q: new THREE.Quaternion(), m: new THREE.Matrix4() }

  /** Highest walkable surface at (x, z) no higher than `maxY`, the same query the Player walks on. */
  function groundAt(x: number, z: number, maxY: number) {
    let g = heightAt(x, z)
    for (const f of ctx.floors) {
      if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && f.y <= maxY && f.y > g) g = f.y
    }
    return g
  }
  /** Ground and, on bare terrain, its normal (floors are level). */
  function groundNormal(x: number, z: number, maxY: number, out: THREE.Vector3) {
    const g = groundAt(x, z, maxY)
    const h = heightAt(x, z)
    if (Math.abs(g - h) > 1e-3) return { g, n: out.set(0, 1, 0) }
    const e = 0.12
    const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e)
    const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e)
    return { g, n: out.set(-dx, 1, -dz).normalize() }
  }

  const shadowed = createShadowHook(ctx, player)
  // E (doors, the lift): a hand reaches out to the handle height in front and comes back.
  let reachT = -1
  if (!params.has("shot")) {
    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyE" && !e.repeat && !(e.target instanceof HTMLInputElement)) reachT = 0
    })
  }

  function update(dt: number) {
    demo.update(dt)
    const s = settings()
    const visible = s.show && !player.fly && rig !== null
    root.visible = visible
    if (player.fly) wasFly = true
    if (!visible || !rig) return
    if (wasFly) {
      wasFly = false
      gait.reset()
      baseY = Number.NaN
    }
    dt = Math.min(dt, 0.05)
    const sc = rig.scale
    const fwd = tmp.fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw))
    // The body stands a little behind the eyes (the eyes are in front of the neck); fed to the kit as the root so a
    // turn moves the hips by stepping, never by sliding planted boots.
    const rx = player.pos.x - fwd.x * s.back
    const rz = player.pos.z - fwd.z * s.back
    const aim = Math.atan2(fwd.z, fwd.x)
    const pose = gait.step(dt, rx / sc, rz / sc, aim, player.pitch)

    // Ground: the player's height, eased so a stair snap doesn't jolt the hips; feet find their own floor.
    const py = player.pos.y
    if (!Number.isFinite(baseY) || Math.abs(py - baseY) > 1.5) baseY = py
    baseY += (py - baseY) * (1 - Math.exp(-dt * 14))
    const maxY = py + STEP
    for (let i = 0; i < 2; i++) {
      const f = pose.feet[i]!
      if (f.planted) {
        const gn = groundNormal(f.p[0] * sc, f.p[2] * sc, maxY, normals[i]!)
        ground[i] = gn.g
        lift[i] = gn.g
      } else {
        const t = pose.targets[i]!
        const g1 = groundAt(t[0] * sc, t[2] * sc, maxY)
        const u = pose.swing[i]!
        const e = u * u * (3 - 2 * u)
        ground[i] = lift[i]! + (g1 - lift[i]!) * e + Math.sin(Math.PI * u) * Math.abs(g1 - lift[i]!) * 0.45
        normals[i]!.lerp(UP, Math.min(1, dt * 10)).normalize()
      }
    }

    // Looking down, the head comes forward over the toes: the hips and chest settle back under the eyes instead.
    const steep = THREE.MathUtils.smoothstep(-player.pitch, 1.1, 1.45)
    const lookBack = Math.max(0, -Math.sin(player.pitch)) * s.lookBack + steep * 0.1
    rig.pose(pose, sc, baseY, ground, normals, fwd.clone().multiplyScalar(-lookBack), (need) => {
      // Lower the hips just enough for both legs to reach (stairs down, a foot on a lower step), eased.
      const k = need > drop ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 6)
      drop += (need - drop) * k
      return drop
    })
    if (reachT >= 0) reachT = reachT + dt > REACH_S ? -1 : reachT + dt
    if (demo.reach >= 0) reachT = demo.reach
    rig.hands(pose, sc, player.flashlight && demo.hold, player, torch, reachT < 0 ? 0 : Math.sin((Math.PI * reachT) / REACH_S) ** 2)
    rig.finish()
    if (s.lampShadows) shadowed(rig.pelvisWorld)
    demo.after(rig.pelvisWorld, player.yaw)
  }

  return { root, update, layer: BODY_LAYER }
}

const UP = v(0, 1, 0)

/** Bone rig: rest data and the mapping from kit frames to bone world rotations. */
class Rig {
  readonly bones = {} as Record<BoneName, THREE.Bone>
  /** World rotation = frameQuat(kit frame) * offset (rest kit frame → rest bone rotation). */
  private offset = {} as Record<BoneName, THREE.Quaternion>
  private restLocal = new Map<THREE.Bone, THREE.Quaternion>()
  readonly scale: number
  private lens: { thigh: number; shin: number; upper: number; fore: number }
  /** Pelvis bone position relative to the hip-joint midpoint at rest. */
  private pelvisFromHips = v()
  private hipHalf: number
  /** Finger chains and their curl axes (in each bone's parent space). */
  private curls: { bone: THREE.Bone; axis: THREE.Vector3; side: 0 | 1; joint: number; thumb: boolean }[] = []
  /** Hand rest basis for the torch grip: x = pinky→index (barrel axis), y = back up the arm. */
  private gripOffset: [THREE.Quaternion, THREE.Quaternion]
  readonly pelvisWorld = v()
  private q = new THREE.Quaternion()
  private q2 = new THREE.Quaternion()
  private pq = new THREE.Quaternion()
  private p = v()
  private s = v()

  constructor(readonly scene: THREE.Object3D) {
    scene.updateMatrixWorld(true)
    const byName = new Map<string, THREE.Bone>()
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone)
    })
    for (const n of BONES) {
      const b = byName.get(n)
      if (!b) throw new Error(`janitor.glb: missing bone ${n}`)
      this.bones[n] = b
    }
    byName.forEach((b) => this.restLocal.set(b, b.quaternion.clone()))
    const wp = (n: BoneName | string) => (byName.get(n) as THREE.Bone).getWorldPosition(v())
    const wq = (n: BoneName) => this.bones[n].getWorldQuaternion(new THREE.Quaternion())
    const V = (a: THREE.Vector3): V3 => [a.x, a.y, a.z]

    const hipL = wp("thigh_l"), hipR = wp("thigh_r"), kneeR = wp("calf_r"), ankR = wp("foot_r")
    const shR = wp("upperarm_r"), elR = wp("lowerarm_r"), wrR = wp("hand_r")
    this.lens = {
      thigh: hipR.distanceTo(kneeR),
      shin: kneeR.distanceTo(ankR),
      upper: shR.distanceTo(elR),
      fore: elR.distanceTo(wrR),
    }
    this.scale = (this.lens.thigh + this.lens.shin) / KIT_LEG
    const mid = hipL.clone().add(hipR).multiplyScalar(0.5)
    this.pelvisFromHips.copy(wp("pelvis")).sub(mid)
    this.hipHalf = hipL.distanceTo(hipR) / 2

    const FWD: V3 = [0, 0, 1], UPV: V3 = [0, 1, 0]
    const restFrame = (n: BoneName): Frame => {
      const limbOf = (a: string, b: string) => limb(V(wp(a)), V(wp(b)), FWD, UPV)
      switch (n) {
        case "thigh_l": return limbOf("thigh_l", "calf_l")
        case "thigh_r": return limbOf("thigh_r", "calf_r")
        case "calf_l": return limbOf("calf_l", "foot_l")
        case "calf_r": return limbOf("calf_r", "foot_r")
        case "upperarm_l": return limbOf("upperarm_l", "lowerarm_l")
        case "upperarm_r": return limbOf("upperarm_r", "lowerarm_r")
        case "lowerarm_l": return limbOf("lowerarm_l", "hand_l")
        case "lowerarm_r": return limbOf("lowerarm_r", "hand_r")
        default: return REST
      }
    }
    for (const n of BONES) {
      const rf = frameQuat(restFrame(n), new THREE.Quaternion()).invert()
      this.offset[n] = rf.multiply(wq(n))
    }

    // Fingers: curl toward the palm. The palm faces the thigh at rest (A-pose), i.e. medial and a little down.
    const grip = (side: 0 | 1) => {
      const sfx = side === 0 ? "_l" : "_r"
      const hand = wp(`hand${sfx}`)
      const index = wp(`index_01${sfx}`), pinky = wp(`pinky_01${sfx}`), middle = wp(`middle_01${sfx}`)
      const along = middle.clone().sub(hand).normalize()
      const palm = v(-Math.sign(hand.x), -0.6, 0).normalize()
      for (const f of [...FINGERS, "thumb"] as const) {
        for (let j = 1; j <= 3; j++) {
          const b = byName.get(`${f}_0${j}${sfx}`)
          if (!b) continue
          const child = byName.get(`${f}_0${j + 1}${sfx}`)
          const dir = (child ? child.getWorldPosition(v()) : b.getWorldPosition(v()).add(along.clone().multiplyScalar(0.02))).sub(b.getWorldPosition(v())).normalize()
          const axis = dir.clone().cross(palm).normalize()
          // Into the parent's rest space, where the curl is applied on top of the rest rotation.
          const parentQ = (b.parent as THREE.Object3D).getWorldQuaternion(new THREE.Quaternion())
          axis.applyQuaternion(parentQ.invert())
          this.curls.push({ bone: b, axis, side, joint: j, thumb: f === "thumb" })
        }
      }
      const x = index.clone().sub(pinky)
      const y = along.clone().negate()
      x.addScaledVector(y, -x.dot(y)).normalize()
      const z = x.clone().cross(y)
      const rest = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)).invert()
      return rest.multiply(this.bones[`hand${sfx}` as BoneName].getWorldQuaternion(new THREE.Quaternion()))
    }
    this.gripOffset = [grip(0), grip(1)]

    const headBones = new Set<THREE.Object3D>([byName.get("head")!, byName.get("neck_01")!])
    const neck = wp("neck_01")
    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh
      if (!mesh.isSkinnedMesh) return
      mesh.frustumCulled = false
      mesh.castShadow = true
      // Lamp maps are sized for rooms, not sleeves: self-shadowing came out as acne stripes on the cloth.
      mesh.receiveShadow = false
      mesh.layers.set(BODY_LAYER)
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.envMapIntensity = 0.5
      // Blender exports double-sided; from the eyes the insides of the collar and sleeves must not render.
      mat.side = THREE.FrontSide
      if (mesh.name.includes("short02")) {
        mesh.layers.set(HEAD_LAYER)
        return
      }
      splitHead(mesh, headBones, neck)
    })
  }

  private setWorld(n: BoneName | THREE.Bone, q: THREE.Quaternion, pos?: THREE.Vector3) {
    const b = typeof n === "string" ? this.bones[n] : n
    const parent = b.parent as THREE.Object3D
    parent.matrixWorld.decompose(this.p, this.pq, this.s)
    b.quaternion.copy(this.pq.invert()).multiply(q)
    if (pos) b.position.copy(pos).applyMatrix4(this.q2Mat.copy(parent.matrixWorld).invert())
    this.refresh(b)
  }
  private q2Mat = new THREE.Matrix4()
  private refresh(b: THREE.Object3D) {
    b.updateMatrix()
    b.matrixWorld.multiplyMatrices((b.parent as THREE.Object3D).matrixWorld, b.matrix)
  }
  private worldPos(n: BoneName, out: THREE.Vector3) {
    return out.setFromMatrixPosition(this.bones[n].matrixWorld)
  }
  private frame(n: BoneName, f: Frame) {
    return frameQuat(f, this.q).multiply(this.offset[n])
  }

  /** Pelvis, spine, neck/head and both legs. `fit(need)` returns the eased hip drop for the drop the legs need. */
  pose(pose: GaitPose, sc: number, baseY: number, ground: [number, number], normals: THREE.Vector3[], shift: THREE.Vector3, fit: (need: number) => number) {
    const kitToWorld = (p: V3, y0: number, out: THREE.Vector3) => out.set(p[0] * sc, y0 + p[1] * sc, p[2] * sc)
    // Hip drop: how far the pelvis must come down so each ankle is reachable with the mesh's leg length.
    const reach = (this.lens.thigh + this.lens.shin) * 0.995
    const pelvisAt = kitToWorld(pose.pelvis.p, baseY, v()).add(shift)
    let need = 0
    const ankle = [v(), v()]
    for (let i = 0; i < 2; i++) {
      kitToWorld(pose.ft[i]!.p, ground[i]!, ankle[i]!)
      const side = i === 0 ? -1 : 1
      const hx = pelvisAt.x + pose.pelvis.z[0] * side * this.hipHalf
      const hz = pelvisAt.z + pose.pelvis.z[2] * side * this.hipHalf
      const hy = pelvisAt.y + pose.pelvis.z[1] * side * this.hipHalf
      const horiz = Math.hypot(ankle[i]!.x - hx, ankle[i]!.z - hz)
      const maxH = Math.sqrt(Math.max(0, reach * reach - horiz * horiz))
      need = Math.max(need, hy - ankle[i]!.y - maxH)
    }
    pelvisAt.y -= fit(Math.max(0, need))
    this.pelvisWorld.copy(pelvisAt)

    // Pelvis: the kit frame's origin is the hip-joint centre.
    const qp = this.frame("pelvis", pose.pelvis).clone()
    const deltaP = frameQuat(pose.pelvis, this.q2).multiply(frameQuat(REST, new THREE.Quaternion()).invert())
    const pelvisPos = this.pelvisFromHips.clone().applyQuaternion(deltaP).add(pelvisAt)
    this.refresh(this.bones.Root)
    this.setWorld("pelvis", qp, pelvisPos)

    const qP = frameQuat(pose.pelvis, new THREE.Quaternion())
    const qT = frameQuat(pose.torso, new THREE.Quaternion())
    const qH = frameQuat(pose.head, new THREE.Quaternion())
    const spine = (n: BoneName, from: THREE.Quaternion, to: THREE.Quaternion, t: number) =>
      this.setWorld(n, this.q.copy(from).slerp(to, t).multiply(this.offset[n]))
    spine("spine_01", qP, qT, 0.45)
    spine("spine_02", qP, qT, 0.8)
    spine("spine_03", qP, qT, 1)
    spine("neck_01", qT, qH, 0.5)
    spine("head", qT, qH, 1)

    for (let i = 0; i < 2; i++) {
      const sfx = i === 0 ? "_l" : "_r"
      const thigh = `thigh${sfx}` as BoneName, calf = `calf${sfx}` as BoneName
      const foot = `foot${sfx}` as BoneName, ball = `ball${sfx}` as BoneName
      const hip = this.worldPos(thigh, v())
      // Knee bends toward the kit's knee (its pole), with this mesh's bone lengths.
      const kitKnee = pose.sh[i]!.p, kitHip = pose.th[i]!.p
      const pole: V3 = [kitKnee[0] - kitHip[0], kitKnee[1] - kitHip[1], kitKnee[2] - kitHip[2]]
      const [knee, ank] = ik([hip.x, hip.y, hip.z], [ankle[i]!.x, ankle[i]!.y, ankle[i]!.z], this.lens.thigh, this.lens.shin, pole)
      const hipV: V3 = [hip.x, hip.y, hip.z]
      this.setWorld(thigh, this.frame(thigh, limb(hipV, knee, pose.th[i]!.x, pose.pelvis.x)))
      this.setWorld(calf, this.frame(calf, limb(knee, ank, pose.sh[i]!.x, pose.pelvis.x)))
      // Boots: the kit's roll and yaw, tilted to the slope while the foot is down.
      const qf = this.frame(foot, pose.ft[i]!)
      const n = normals[i]!
      if (n.y < 0.9999) qf.premultiply(this.q2.setFromUnitVectors(UP, n))
      this.setWorld(foot, qf.clone())
      const qb = this.frame(ball, pose.toe[i]!)
      if (n.y < 0.9999) qb.premultiply(this.q2.setFromUnitVectors(UP, n))
      this.setWorld(ball, qb.clone())
    }
  }

  /** Arms: the kit's unarmed swing, or the right hand holding the flashlight out along the beam. */
  hands(pose: GaitPose, sc: number, hold: boolean, player: Player, torch: THREE.Object3D, reach: number) {
    const kitArm = (RIG.upper + RIG.fore) * sc
    const armK = (this.lens.upper + this.lens.fore) / kitArm
    const torsoX = pose.torso.x, torsoY = pose.torso.y
    for (let i = 0; i < 2; i++) {
      const sfx = i === 0 ? "_l" : "_r"
      const clav = `clavicle${sfx}` as BoneName
      this.bones[clav].quaternion.copy(this.restLocal.get(this.bones[clav])!)
      this.refresh(this.bones[clav])
      const sh = this.worldPos(`upperarm${sfx}` as BoneName, v())
      const [kSh, kEl, kHand] = pose.arms[i]!
      const side = i === 0 ? -1 : 1
      // Same reach from this mesh's shoulder, a touch wider so knuckles clear the trouser seam.
      const target = v((kHand[0] - kSh[0]) * sc * armK, (kHand[1] - kSh[1]) * sc * armK, (kHand[2] - kSh[2]) * sc * armK).add(sh)
      target.addScaledVector(tv(pose.torso.z), side * 0.025)
      let pole: V3 = [kEl[0] - kSh[0], kEl[1] - kSh[1], kEl[2] - kSh[2]]
      const holding = i === 1 && hold
      let barrel: THREE.Vector3 | null = null
      if (holding) {
        // Torch low at the right hip-front, pointing where you look (pitch eased so looking at your feet keeps the hand
        // in front of you). It stays below the beam's cone (render/lighting.ts emits the beam from 0.22 right, 0.28
        // down, 0.1 ahead of the eye), or the beam would blow out the fist at point-blank range.
        const yaw = player.yaw
        const pitchArm = THREE.MathUtils.clamp(player.pitch, -0.7, 0.4)
        const cf = v(-Math.sin(yaw) * Math.cos(pitchArm), Math.sin(pitchArm), -Math.cos(yaw) * Math.cos(pitchArm))
        const right = v(Math.cos(yaw), 0, -Math.sin(yaw))
        const eye = v(player.pos.x, player.pos.y + EYE, player.pos.z)
        target.copy(eye).addScaledVector(right, 0.2).addScaledVector(cf, 0.2)
        target.y -= 0.55 + 0.08 * Math.max(0, -pitchArm)
        pole = [right.x * 0.7, -1, right.z * 0.7]
        barrel = v(-Math.sin(yaw) * Math.cos(player.pitch), Math.sin(player.pitch), -Math.cos(yaw) * Math.cos(player.pitch))
      }
      // Reaching hand: the free one (left while the right holds the torch).
      if (reach > 0 && i === (hold ? 0 : 1)) {
        const yaw = player.yaw
        const goal = v(player.pos.x - Math.sin(yaw) * 0.55 + Math.cos(yaw) * side * 0.12, player.pos.y + 1.02, player.pos.z - Math.cos(yaw) * 0.55 - Math.sin(yaw) * side * 0.12)
        target.lerp(goal, reach)
        pole = [pole[0] * (1 - reach) + side * Math.cos(yaw) * reach, pole[1] * (1 - reach) - reach, pole[2] * (1 - reach) - side * Math.sin(yaw) * reach]
      }
      const shV: V3 = [sh.x, sh.y, sh.z]
      const [el, wr] = ik(shV, [target.x, target.y, target.z], this.lens.upper, this.lens.fore, pole)
      const ua = `upperarm${sfx}` as BoneName, fa = `lowerarm${sfx}` as BoneName, hand = `hand${sfx}` as BoneName
      this.setWorld(ua, this.frame(ua, limb(shV, el, torsoX, torsoY)))
      // The forearm turns the palm in toward the thigh (the rest pose has it facing forward); a torch hand turns less.
      const tw = (holding ? 0.4 : 1) * PALM_IN * side
      const ref: V3 = [torsoX[0] * Math.cos(tw) + pose.torso.z[0] * Math.sin(tw), torsoX[1] * Math.cos(tw) + pose.torso.z[1] * Math.sin(tw), torsoX[2] * Math.cos(tw) + pose.torso.z[2] * Math.sin(tw)]
      this.setWorld(fa, this.frame(fa, limb(el, wr, ref, torsoY)))
      if (barrel) {
        // Hammer grip: the barrel runs pinky→index through the fist, the hand continues the forearm.
        const x = barrel.clone()
        const y = v(el[0] - wr[0], el[1] - wr[1], el[2] - wr[2]).normalize()
        y.addScaledVector(x, -y.dot(x)).normalize()
        const z = x.clone().cross(y)
        const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)).multiply(this.gripOffset[1])
        this.setWorld(hand, q)
        const hp = this.worldPos(hand, v())
        // Barrel through the palm: a few cm down the hand and toward the palm.
        const handAlong = y.clone().negate()
        const palm = z.clone().negate()
        torch.position.copy(hp).addScaledVector(handAlong, 0.085).addScaledVector(palm, 0.025)
        torch.quaternion.setFromUnitVectors(v(0, 0, -1), barrel)
      } else {
        this.bones[hand].quaternion.copy(this.restLocal.get(this.bones[hand])!)
        this.refresh(this.bones[hand])
      }
      this.curl(i as 0 | 1, holding ? 1 : 0.5 + 0.2 * pose.run)
    }
    torch.visible = hold
  }

  private curl(side: 0 | 1, amount: number) {
    const per = [0, 0.9, 1.25, 0.8]
    for (const c of this.curls) {
      if (c.side !== side) continue
      const a = (c.thumb ? 0.35 : per[c.joint]!) * amount
      c.bone.quaternion.setFromAxisAngle(c.axis, a).multiply(this.restLocal.get(c.bone)!)
    }
  }

  finish() {
    this.bones.pelvis.updateMatrixWorld(true)
  }
}

/**
 * Moves the head/neck/hair triangles of a skinned mesh into their own mesh on HEAD_LAYER (same geometry buffers, same
 * skeleton): the view camera never sees them, lamp shadows still do.
 */
function splitHead(mesh: THREE.SkinnedMesh, headBones: Set<THREE.Object3D>, neck: THREE.Vector3) {
  const geo = mesh.geometry
  const index = geo.index
  const joints = geo.getAttribute("skinIndex")
  const weights = geo.getAttribute("skinWeight")
  if (!index || !joints || !weights) return
  const bones = mesh.skeleton.bones
  const headJoint = new Set<number>()
  bones.forEach((b, i) => headBones.has(b) && headJoint.add(i))
  const isHead = new Uint8Array(joints.count)
  const pos = geo.getAttribute("position")
  const p = new THREE.Vector3()
  for (let i = 0; i < joints.count; i++) {
    let w = 0
    for (let k = 0; k < 4; k++) if (headJoint.has(joints.getComponent(i, k))) w += weights.getComponent(i, k)
    // The collar and the tops of the shoulders right under the eyes go too (bind pose, metres).
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix)
    const collar = (p.y > neck.y - 0.06 && Math.hypot(p.x - neck.x, p.z - neck.z) < 0.13) || p.y > neck.y + 0.02
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

/**
 * Lamp/flashlight shadow cameras: the flashlight's map gets its own mask without the body (its beam starts at your
 * face), lamp maps add the body and head layers and re-render while the body stands in their cone.
 */
function createShadowHook(ctx: WorldContext, player: Player) {
  let lights: THREE.SpotLight[] = []
  let frame = 0
  const p = v()
  const d = v()
  return (pelvis: THREE.Vector3) => {
    if (frame++ % 30 === 0) {
      lights = []
      for (const o of ctx.scene.children) {
        const l = o as THREE.SpotLight
        if (!l.isSpotLight || !l.castShadow) continue
        // The flashlight is the shadowed spot that rides at the player's head.
        const flash = Math.hypot(l.position.x - player.pos.x, l.position.z - player.pos.z) < 1 && Math.abs(l.position.y - player.pos.y - EYE) < 1
        l.userData.bodyFlash = flash
        if (!flash) lights.push(l)
        const mask = l.shadow.camera.layers
        if (flash) mask.mask = (1 << 0) | (1 << SPARE_LAYER)
        else mask.mask = (1 << 0) | (1 << BODY_LAYER) | (1 << HEAD_LAYER)
      }
    }
    for (const l of lights) {
      if (l.intensity <= 0) continue
      l.getWorldPosition(p)
      const dist = p.distanceTo(pelvis)
      if (dist > l.distance) continue
      d.copy(pelvis).sub(p).normalize()
      const dir = l.target.getWorldPosition(v()).sub(p).normalize()
      if (d.dot(dir) < Math.cos(l.angle + 0.15)) continue
      l.shadow.needsUpdate = true
    }
  }
}

export { EYE }
