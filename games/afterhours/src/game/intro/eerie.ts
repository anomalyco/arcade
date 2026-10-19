import * as THREE from "three/webgpu"
import { float, length, smoothstep, uv } from "three/tsl"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { compoundDistance, heightAt, roadEdgeDistance } from "../../world/height"
import { HA } from "../../world/roads/surface"
import { flat } from "../../world/compound/mats"
import { materialFor } from "../../render/materials"
import { lathe } from "../../world/compound/geo"
import { accessLine } from "./route"
import { renderState } from "../../render/shared"

// Things in the woods, for whoever looks out of the side windows during the drive. Nothing ever moves towards the car,
// nothing makes a noise except one twig, and everything is gone the next time you look:
//   - eye-shine: 4 pairs, of 12 spots along the access road, 12–22 m off the road and ~2 m up (too high for a deer),
//     ~12 cm apart (too wide for one). Pale green or amber, lit only by the headlamps' spill as they sweep past at
//     28–55° off the car's nose (so a driver looking ahead never sees them). Each pair shines a second or two, may
//     blink, and is gone for good; one also goes out if stared at.
//   - a tall dark figure: 1 of 4 spots, ~16 m off the road between trunks, half lost in the fog. Once it has been looked at (near the centre of view
//     for a moment) it's gone as soon as the view leaves it; a twig snaps out there.
//   - a dropped hard hat on the right-hand shoulder: 1 of 4 spots, caught by the headlamps as the car passes.
// Spots are fixed (derived from the road's centre line); each run picks among them at random.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

const PAIRS = 4
const EYE_SPACING = 0.12
const EYE_SIZE = 0.06
const GREEN = new THREE.Color(0.55, 1, 0.62)
const AMBER = new THREE.Color(1, 0.62, 0.22)
/** Peak eye brightness (linear, before fog), and how it falls with distance. */
const EYE_GAIN = 110

type Pair = { pos: THREE.Vector3; color: THREE.Color; state: "idle" | "shining" | "gone"; t: number; life: number; blinkAt: number; stare: number; level: number }
type Figure = { pos: THREE.Vector3; yaw: number; state: "waiting" | "seen" | "gone"; look: number }

/** Spots along the access road (arc length, side, lateral offset). Deterministic; runs pick among them. */
function eyeSpots() {
  const line = accessLine()
  const out: THREE.Vector3[] = []
  for (let k = 0; k < 12; k++) {
    const s = 45 + k * 21
    const side = k % 3 === 1 ? -1 : 1
    const u = side * (12 + ((k * 7) % 11))
    const [x, z] = line.offset(s, u)
    if (roadEdgeDistance(x, z) < 7 || compoundDistance(x, z) < 15) continue
    out.push(new THREE.Vector3(x, heightAt(x, z) + 1.95 + ((k * 13) % 5) * 0.05, z))
  }
  return out
}
function figureSpots() {
  const line = accessLine()
  return [
    // Between trunks with a clear sightline from the lane and lighter fog behind it. These spots measured best for
    // silhouette contrast from 20 m in-game; against dark trunks or crowns it doesn't read at all.
    [196, 13],
    [226, -14],
    [192, 15],
    [246, 15],
  ].map(([s, u]) => {
    const [x, z] = line.offset(s!, u!)
    const p = line.at(s!)
    // Facing the road.
    return { pos: new THREE.Vector3(x, heightAt(x, z), z), yaw: Math.atan2(-(p.x - x), -(p.z - z)) }
  })
}
function hatSpots() {
  const line = accessLine()
  return [72, 148, 203, 247].map((s, k) => {
    const [x, z] = line.offset(s, HA + 0.55 + (k % 2) * 0.3)
    return new THREE.Vector3(x, heightAt(x, z) + 0.03, z)
  })
}

/** A gaunt standing figure, ~2.45 m: long legs, narrow shoulders, arms hanging past the knees, head a little bowed. */
function figureGeometry() {
  const parts: THREE.BufferGeometry[] = []
  const cap = (r: number, len: number, x: number, y: number, z: number, rz = 0, rx = 0, sx = 1, sz = 1) => {
    const g = new THREE.CapsuleGeometry(r, len, 4, 10)
    g.scale(sx, 1, sz)
    g.rotateX(rx)
    g.rotateZ(rz)
    g.translate(x, y, z)
    parts.push(g)
  }
  cap(0.06, 1.0, -0.1, 0.56, 0, 0.02) // legs
  cap(0.06, 1.0, 0.1, 0.56, 0.02, -0.03)
  cap(0.15, 0.62, 0, 1.5, 0, 0, 0.06, 1.15, 0.7) // torso
  cap(0.045, 0.98, -0.25, 1.22, 0.02, 0.06) // arms
  cap(0.045, 1.04, 0.25, 1.19, 0.03, -0.05)
  cap(0.05, 0.12, 0, 2.08, 0.03, 0, 0.3) // neck
  const head = new THREE.SphereGeometry(0.11, 12, 10)
  head.scale(0.85, 1.25, 0.95)
  head.rotateX(0.32)
  head.translate(0.02, 2.25, 0.08)
  parts.push(head)
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!
  g.deleteAttribute("uv")
  const n = g.attributes.position!.count
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2))
  return g
}

/** A white-ish fibreglass hard hat (full brim), lying on its side. */
function hatGeometry() {
  const g = lathe(
    [
      [0, 0.125],
      [0.045, 0.122],
      [0.085, 0.108],
      [0.112, 0.08],
      [0.128, 0.045],
      [0.132, 0.02],
      [0.165, 0.008],
      [0.168, 0.0],
      [0.13, 0.004],
    ],
    24,
  )
  g.scale(1, 1, 1.18)
  return g
}

export class Eerie {
  readonly group = new THREE.Group()
  private eyes: THREE.InstancedMesh
  private figure: THREE.Mesh
  private hat: THREE.Mesh
  private pairs: Pair[] = []
  private fig: Figure | null = null
  private eyeSpots = eyeSpots()
  readonly figSpots = figureSpots()
  private hatSpots = hatSpots()
  private twig: ((p: THREE.Vector3) => void) | null = null
  private m = new THREE.Matrix4()
  private v = new THREE.Vector3()
  private c = new THREE.Color()
  /** Automation: brightness multiplier (captures that need to find them). */
  gain = 1

  constructor() {
    this.group.name = "intro-eerie"
    // Eye-shine: small unlit discs that write depth (the post chain's fog is depth-based, so they fog at their own
    // distance; trunks in front hide them). The disc edge is cut by alpha test, the centre brighter than the rim.
    const mat = new THREE.MeshBasicNodeMaterial({ alphaTest: 0.5 })
    const r = length((uv() as N).sub(0.5)).mul(2)
    mat.opacityNode = (smoothstep(1, 0.55, r) as N).add(0.25)
    mat.colorNode = (float(0.35) as N).add((smoothstep(1, 0, r) as N).mul(0.65))
    mat.name = "intro-eyeshine"
    this.eyes = new THREE.InstancedMesh(new THREE.PlaneGeometry(EYE_SIZE, EYE_SIZE), mat, PAIRS * 2)
    this.eyes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PAIRS * 2 * 3), 3)
    this.eyes.frustumCulled = false
    this.eyes.castShadow = this.eyes.receiveShadow = false
    this.eyes.renderOrder = 4
    this.eyes.name = "intro-eyes"
    this.group.add(this.eyes)
    this.figure = new THREE.Mesh(figureGeometry(), flat(0x070807, 0.95))
    this.figure.name = "intro-figure"
    this.figure.castShadow = false
    this.group.add(this.figure)
    const hatMat = materialFor("flat", { color: 0xc8c2ad, roughness: 0.45, side: THREE.DoubleSide })
    this.hat = new THREE.Mesh(hatGeometry(), hatMat)
    this.hat.name = "intro-hardhat"
    this.hat.castShadow = true
    this.group.add(this.hat)
  }

  /** Everything visible at a level, for shader warm-up (call `start` before use). */
  warmPose(at: THREE.Vector3) {
    this.figure.position.copy(at)
    this.hat.position.copy(at)
    for (let i = 0; i < PAIRS * 2; i++) {
      this.eyes.setMatrixAt(i, this.m.makeTranslation(at.x, at.y + 1, at.z))
      this.eyes.setColorAt(i, GREEN)
    }
    this.eyes.instanceMatrix.needsUpdate = true
    this.eyes.instanceColor!.needsUpdate = true
    this.group.visible = true
    this.figure.visible = this.hat.visible = true
  }

  /** New run: pick the spots. `twig` plays the one sound (at a world position). */
  start(twig: ((p: THREE.Vector3) => void) | null) {
    this.twig = twig
    const pick = <T>(list: T[], n: number) => [...list].sort(() => Math.random() - 0.5).slice(0, n)
    this.pairs = pick(this.eyeSpots, PAIRS).map((pos) => ({
      pos,
      color: Math.random() < 0.6 ? GREEN : AMBER,
      state: "idle" as const,
      t: 0,
      life: 1.1 + Math.random() * 1.4,
      blinkAt: Math.random() < 0.5 ? 0.35 + Math.random() * 0.4 : 9,
      stare: 0,
      level: 0,
    }))
    const f = pick(this.figSpots, 1)[0]!
    this.fig = { pos: f.pos, yaw: f.yaw, state: "waiting", look: 0 }
    this.figure.position.copy(f.pos)
    this.figure.rotation.set(0, f.yaw, 0)
    this.figure.visible = true
    const h = pick(this.hatSpots, 1)[0]!
    this.hat.position.copy(h)
    // On its side, crown towards the road, a little rolled.
    this.hat.rotation.set(1.42 + Math.random() * 0.2, Math.random() * Math.PI * 2, 0.15, "YXZ")
    this.hat.position.y += 0.125
    this.hat.visible = true
    this.group.visible = true
    this.writeEyes(null)
  }

  /** Per frame while driving: `beamPos`/`beamDir` the headlamps (null when off), the camera for looks. */
  update(dt: number, camera: THREE.Camera, beamPos: THREE.Vector3 | null, beamDir: THREE.Vector3 | null) {
    const cam = camera.getWorldPosition(this.v.clone())
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    for (const p of this.pairs) {
      if (p.state === "gone") continue
      // Headlamp spill reaching the eyes: off the nose by 28–55°, 12–42 m away.
      let lit = 0
      if (beamPos && beamDir) {
        const to = this.v.copy(p.pos).sub(beamPos)
        const d = to.length()
        const flatDot = (to.x * beamDir.x + to.z * beamDir.z) / (Math.hypot(to.x, to.z) * Math.hypot(beamDir.x, beamDir.z) || 1)
        const ang = Math.acos(Math.max(-1, Math.min(1, flatDot)))
        lit = smooth01((ang - 0.45) / 0.08) * (1 - smooth01((ang - 0.88) / 0.1)) * smooth01((d - 10) / 3) * (1 - smooth01((d - 28) / 5))
      }
      if (p.state === "idle" && lit > 0.4) p.state = "shining"
      if (p.state === "shining") {
        p.t += dt
        const blink = Math.abs(p.t - p.blinkAt) < 0.07
        const open = Math.min(1, p.t / 0.12) * (blink ? 0 : 1) * (1 - smooth01((p.t - p.life) / 0.1))
        // Stared at: they go out.
        const to = this.v.copy(p.pos).sub(cam).normalize()
        if (to.dot(fwd) > Math.cos(0.07)) p.stare += dt
        if (p.stare > 0.4 && p.life > p.t + 0.12) p.life = p.t + 0.05
        p.level = lit * open
        if (p.t > p.life + 0.15 || (p.t > 0.3 && lit < 0.05)) p.state = "gone"
      } else p.level = 0
    }
    this.writeEyes(camera)
    // The figure: looked at (near the centre of view, within 70 m, for a moment), then gone once the view leaves it.
    const f = this.fig
    if (f && f.state !== "gone") {
      const to = this.v.copy(f.pos).add(UP_HALF).sub(cam)
      const d = to.length()
      const dot = to.normalize().dot(fwd)
      if (f.state === "waiting" && d < 75 && dot > Math.cos(0.16)) {
        f.look += dt
        if (f.look > 0.45) f.state = "seen"
      } else if (f.state === "seen" && dot < Math.cos(0.45)) {
        f.state = "gone"
        this.figure.visible = false
        this.twig?.(f.pos)
      }
    }
  }

  private writeEyes(camera: THREE.Camera | null) {
    const q = camera ? camera.quaternion : new THREE.Quaternion()
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    right.y = 0
    right.normalize()
    for (let i = 0; i < PAIRS; i++) {
      const p = this.pairs[i]
      for (const k of [0, 1]) {
        const idx = i * 2 + k
        if (!p || p.level <= 0.002) {
          this.eyes.setMatrixAt(idx, this.m.makeScale(0, 0, 0))
          this.eyes.setColorAt(idx, this.c.setRGB(0, 0, 0))
          continue
        }
        const pos = this.v.copy(p.pos).addScaledVector(right, (k ? 0.5 : -0.5) * EYE_SPACING)
        // A point light source: never smaller than ~2.5 render pixels (else TAA and the alpha cut lose it), its
        // brightness spread over the larger disc so its total stays the same.
        const d = camera ? pos.distanceTo(camera.position) : 10
        const grow = Math.max(1, (d * renderState.pixelAngle * 2.5) / EYE_SIZE)
        this.m.compose(pos, q, tmpS.setScalar(grow))
        this.eyes.setMatrixAt(idx, this.m)
        // Spread over a larger disc: the total stays the same, its fogged contrast at least survives as a dim dot.
        // Retroreflectors send the beam straight back, so they hold up with distance better than the fog suggests.
        this.eyes.setColorAt(idx, this.c.copy(p.color).multiplyScalar((p.level * EYE_GAIN * this.gain * (1 + (d / 14) ** 2)) / grow))
      }
    }
    this.eyes.instanceMatrix.needsUpdate = true
    this.eyes.instanceColor!.needsUpdate = true
  }

  /** Debug/automation: where things are this run. */
  info() {
    return { eyes: this.pairs.map((p) => ({ pos: p.pos.toArray().map((v) => +v.toFixed(1)), state: p.state })), figure: this.fig && { pos: this.fig.pos.toArray().map((v) => +v.toFixed(1)), state: this.fig.state }, hat: this.hat.position.toArray().map((v) => +v.toFixed(1)) }
  }

  stop() {
    this.group.visible = false
    this.pairs = []
    this.fig = null
  }
}

const tmpS = new THREE.Vector3()
const UP_HALF = new THREE.Vector3(0, 1.6, 0)
const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
