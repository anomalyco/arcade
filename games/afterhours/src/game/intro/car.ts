import * as THREE from "three/webgpu"
import { color as tslColor, dot, smoothstep, texture, uniform, uv, vec3 } from "three/tsl"
import type { Box, Lamp, WorldContext } from "../../world/context"
import { loadModel } from "../../render/models"
import { renderState } from "../../render/shared"
import { shadowLayer } from "../../world/compound/mats"
import type { SeatOptions } from "../../playerb/seat"
import PARTS from "./car-parts.json"

// The player's car: a 1980 four-door government-fleet sedan (the shared `car_sedan_b` model, "Negotiator '80", CC BY 4.0
// Daniel Zhabotinsky; see public/models/CREDITS.md). The shipped model is one baked mesh; it is split here, by the
// per-triangle part map that scripts/intro/car-parts.ts builds from the original source, into a body, the driver's door
// (hinged), the steering wheel (turns on its column) and four wheels (spin; the fronts steer). Same material and
// shaders as every other parked car, so the split costs no new pipelines; only the lit lenses and the dash glow add one
// small material each (warmed in `prepare` before the drive).
//
// Lights: two headlamps and two tail lamps (with brake level), plus the instrument glow, are `ctx.lamps` fixtures, so
// the light rig gives them clustered light, emitter halos and fog in-scattering like every other lamp; the rig reads
// a lamp's position every frame and its direction only once, so the car turns their cones itself (`aimLamp`). The one
// real *shadowed* beam is the rig's flashlight spot, borrowed while the car's lights are on (`borrowBeam`).
//
// Model space: metres, front -Z, driver on the left (-X), wheels on the ground at y = 0.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

const MODEL = "car_sedan_b" as const
/** Model bounds (MODELS.car_sedan_b.size). */
export const CAR_SIZE = { width: 1.997, height: 1.424, length: 5.1 }

/** Seats: eye point in model space (where a seated adult's eyes are) and the door that serves it. */
export type Seat = { id: string; eye: readonly [number, number, number]; door: "door_fl" | null; driver: boolean }
export const SEATS: readonly Seat[] = [
  { id: "driver", eye: [-0.37, 1.18, 0.22], door: "door_fl", driver: true },
  { id: "front-passenger", eye: [0.38, 1.12, 0.14], door: null, driver: false },
  { id: "rear-left", eye: [-0.4, 1.1, 1.05], door: null, driver: false },
  { id: "rear-right", eye: [0.4, 1.1, 1.05], door: null, driver: false },
]

const bounds = PARTS.bounds as Record<string, { min: number[]; max: number[] }>
const centre = (name: string) => {
  const b = bounds[name]!
  return new THREE.Vector3((b.min[0]! + b.max[0]!) / 2, (b.min[1]! + b.max[1]!) / 2, (b.min[2]! + b.max[2]!) / 2)
}
/** Door hinge line (vertical) at the door's front edge, a little inside its outer skin. */
const HINGE = new THREE.Vector3(bounds.door_fl!.min[0]! + 0.06, 0, bounds.door_fl!.min[2]! + 0.03)
/** Fully open door angle (rad). */
export const DOOR_OPEN = 1.12
const WHEEL_R = (bounds.wheel_rl!.max[1]! - bounds.wheel_rl!.min[1]!) / 2
/** Overall steering ratio (wheel turns per road-wheel turn) for a late-70s full-size car with power steering. */
const STEER_RATIO = 15
const WHEELBASE = centre("wheel_rl").z - centre("wheel_fl").z

/** Headlamp and tail lamp emitters (model space). */
const HEAD = [
  [-0.55, 0.672, -2.33],
  [0.55, 0.672, -2.33],
] as const
const TAIL = [
  [-0.6, 0.632, 2.36],
  [0.6, 0.632, 2.36],
] as const
const DASH = [-0.36, 0.93, -0.66] as const

export type CarLights = { head: number; tail: number; brake: number; dash: number }

/**
 * Anchors for the seated body (src/playerb/seat.ts `SeatOptions`), in car model space. Hip: the driver's H-point;
 * handle: the pull lever on the door card; edge: where the palm pushes the door, high on the card near its free edge.
 * The door card's inner face is at x ≈ -0.668, its top at y ≈ 0.93 (car-parts.json `nodes`).
 */
const RIG = {
  hip: [-0.37, 0.53, 0.08],
  handle: [-0.655, 0.83, -0.48],
  edge: [-0.655, 0.88, 0.02],
} as const
/** Steering-wheel rim: radius to the centre of the rim tube, and the tube's own radius (m; 0.163 outer). */
const WHEEL_RADIUS = 0.147
const WHEEL_TUBE = 0.016

type Lit = { lamp: Lamp; pos: number[]; dir: THREE.Vector3 | null; local: THREE.Vector3; localDir: THREE.Vector3 | null; base: number }

export class PlayerCar {
  /** World placement (yaw about Y); `body` carries suspension pitch/roll/heave under it. */
  readonly root = new THREE.Group()
  readonly body = new THREE.Group()
  readonly door = new THREE.Group()
  readonly steering = new THREE.Group()
  private wheels: { steer: THREE.Group; spin: THREE.Group; front: boolean }[] = []
  private lit: Lit[] = []
  private lensMats: { u: N; color: THREE.Color; key: keyof CarLights; scale: number }[] = []
  private shadow = new THREE.Group()
  private collider: Box | null = null
  readonly lights: CarLights = { head: 0, tail: 0, brake: 0, dash: 0 }
  /** Door open fraction 0..1 (eased swing applied in `update`). */
  doorAmount = 0
  /** Steering-wheel angle (rad, + = turned left) and road-wheel angle derived from it. */
  private steerAngle = 0
  private spin = 0
  private ready: Promise<void> | null = null
  /** Driver's seat anchors (children of the body / door groups, so they ride the suspension and swing with the door). */
  private anchors = { hip: new THREE.Object3D(), eye: new THREE.Object3D(), handle: new THREE.Object3D(), edge: new THREE.Object3D() }
  private ctx: WorldContext
  private beam = { borrowed: false, saved: null as typeof renderState.torchLens, settings: {} as Record<string, unknown> }

  constructor(ctx: WorldContext) {
    this.ctx = ctx
    this.root.name = "player-car"
    this.root.add(this.body)
    this.body.add(this.door, this.steering)
    const a = this.anchors
    a.hip.position.set(...RIG.hip)
    a.eye.position.set(...SEATS[0]!.eye)
    a.hip.name = "seat-hip"
    a.eye.name = "seat-eye"
    a.handle.name = "door-handle"
    a.edge.name = "door-edge"
    this.body.add(a.hip, a.eye)
    // The door group sits at the hinge: its children are model space minus the hinge.
    a.handle.position.set(RIG.handle[0] - HINGE.x, RIG.handle[1], RIG.handle[2] - HINGE.z)
    a.edge.position.set(RIG.edge[0] - HINGE.x, RIG.edge[1], RIG.edge[2] - HINGE.z)
    this.door.add(a.handle, a.edge)
    this.root.add(this.shadow)
    this.shadow.visible = false
  }

  /** Loads and splits the model, registers the lamps (dark) and compiles everything with `warm`. Idempotent. */
  prepare(warm: (o: THREE.Object3D) => Promise<unknown>) {
    this.ready ??= (async () => {
      const model = await loadModel(MODEL)
      this.split(model)
      this.addLamps()
      // The rig gives exterior spots a little spill (bounce) outside their cones, re-applied whenever a lamp moves;
      // for car lamps that would light the cabin and body from inside, so zero it after the rig, before the frame.
      renderState.beforeRender.push(() => {
        for (const l of this.lit) {
          const rig = rigOf(l.lamp)
          if (rig?.point) rig.point.userData.spill = 0
        }
      })
      this.addShadow()
      this.root.updateMatrixWorld(true)
      // Warm with every emitter at a non-zero level so the node graphs match what the drive draws.
      await warm(this.root)
    })()
    return this.ready
  }

  private split(model: THREE.Group) {
    model.updateMatrixWorld(true)
    const meshes: THREE.Mesh[] = []
    model.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh))
    const names = PARTS.parts
    for (const prim of PARTS.primitives) {
      const mesh = meshes.find((m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position!.count) / 3 === prim.tris)
      if (!mesh) {
        console.warn(`intro car: no ${MODEL} mesh with ${prim.tris} triangles; the model changed, re-run scripts/intro/car-parts.ts`)
        continue
      }
      const src = mesh.geometry
      const index = src.index
      // Triangle lists per label.
      const lists = new Map<number, number[]>()
      let tri = 0
      for (let k = 0; k < prim.labels.length; k += 2) {
        const label = prim.labels[k]!
        const count = prim.labels[k + 1]!
        let list = lists.get(label)
        if (!list) lists.set(label, (list = []))
        for (let c = 0; c < count; c++, tri++) {
          for (let v = 0; v < 3; v++) list.push(index ? index.getX(tri * 3 + v) : tri * 3 + v)
        }
      }
      for (const [label, idx] of lists) {
        const name = label === 0 ? "body" : names[label - 1]!
        const geo = new THREE.BufferGeometry()
        for (const [key, attr] of Object.entries(src.attributes)) geo.setAttribute(key, attr)
        const maxIndex = idx.reduce((a, b) => Math.max(a, b), 0)
        geo.setIndex(maxIndex > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
        geo.boundingBox = src.boundingBox
        geo.boundingSphere = src.boundingSphere ?? (src.computeBoundingSphere(), src.boundingSphere)
        const part = new THREE.Mesh(geo, mesh.material)
        part.name = `car-${name}`
        part.castShadow = mesh.castShadow
        part.receiveShadow = true
        part.applyMatrix4(mesh.matrixWorld)
        this.attach(name, part)
      }
    }
  }

  private attach(name: string, part: THREE.Mesh) {
    const pivoted = (parent: THREE.Object3D, pivot: THREE.Vector3) => {
      part.position.sub(pivot)
      parent.add(part)
    }
    if (name === "door_fl") {
      this.door.position.copy(HINGE)
      pivoted(this.door, HINGE)
    } else if (name === "steering") {
      const c = new THREE.Vector3(...(PARTS.steering.centre as [number, number, number]))
      const axis = new THREE.Vector3(...(PARTS.steering.axis as [number, number, number])).normalize()
      this.steering.position.copy(c)
      this.steering.userData.axis = axis
      pivoted(this.steering, c)
    } else if (name.startsWith("wheel_")) {
      const c = centre(name)
      const steer = new THREE.Group()
      const spin = new THREE.Group()
      steer.position.copy(c)
      steer.add(spin)
      pivoted(spin, c)
      this.wheels.push({ steer, spin, front: name.endsWith("fl") || name.endsWith("fr") })
      // Wheels belong to the unsprung mass: they stay on the road while the body pitches and rolls.
      this.root.add(steer)
    } else if (name === "headlight" || name === "stoplight" || name === "turnsignal" || name === "reverse") {
      const key: keyof CarLights | null = name === "headlight" ? "head" : name === "stoplight" ? "tail" : null
      if (key) {
        const glow = name === "headlight" ? new THREE.Color(1, 0.86, 0.66) : new THREE.Color(1, 0.04, 0.015)
        part.material = this.lens(part.material as THREE.Material, glow, key, name === "headlight" ? 6 : 3)
      }
      this.body.add(part)
    } else if (name === "dashboard") {
      this.body.add(part)
      // Backlit instruments: the dash surface facing the driver, around the column, glows faintly through its own
      // markings (the atlas colour as the mask), additive over the lit surface.
      const overlay = this.gauges(part)
      if (overlay) this.body.add(overlay)
    } else this.body.add(part)
  }

  /** A clone of a lens material that glows with `glow` × the light's level. */
  private lens(base: THREE.Material, glow: THREE.Color, key: keyof CarLights, scale: number) {
    const m = base.clone() as THREE.MeshStandardNodeMaterial
    const u = uniform(new THREE.Color(0, 0, 0))
    ;(m as N).emissiveNode = u
    m.name = `car-lens-${key}`
    this.lensMats.push({ u, color: glow, key, scale })
    return m
  }

  private gauges(dash: THREE.Mesh) {
    const geo = dash.geometry
    const pos = geo.attributes.position!
    const idx = geo.index!
    const keep: number[] = []
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3()
    // Positions may be quantised: the mesh matrix carries their scale and offset.
    dash.updateMatrix()
    const m = dash.matrix
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t)).applyMatrix4(m)
      b.fromBufferAttribute(pos, idx.getX(t + 1)).applyMatrix4(m)
      c.fromBufferAttribute(pos, idx.getX(t + 2)).applyMatrix4(m)
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize()
      const cx = (a.x + b.x + c.x) / 3
      const cy = (a.y + b.y + c.y) / 3
      // The instrument cluster: behind the wheel, upper dash, facing back towards the driver.
      if (Math.abs(cx - DASH[0]) < 0.26 && cy > 0.78 && Math.abs(n.z) > 0.3) keep.push(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2))
    }
    if (!keep.length) return null
    const g = new THREE.BufferGeometry()
    for (const [key, attr] of Object.entries(geo.attributes)) g.setAttribute(key, attr)
    g.setIndex(keep)
    g.boundingSphere = geo.boundingSphere
    const src = dash.material as THREE.MeshStandardNodeMaterial
    const level = uniform(0)
    const tint = tslColor(0.3, 0.95, 0.78)
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    // The atlas colour as the mask: pale needles and numerals glow, the dark faces barely do.
    const lum = src.map ? dot(texture(src.map, uv()).rgb, vec3(0.3, 0.55, 0.15)) : 0.5
    mat.colorNode = (smoothstep(0.32, 0.7, lum as N) as N).add(0.012).mul(tint).mul(level)
    mat.name = "car-gauges"
    this.lensMats.push({ u: level, color: new THREE.Color(1, 1, 1), key: "dash", scale: 1.6 })
    const mesh = new THREE.Mesh(g, mat)
    mesh.position.copy(dash.position)
    mesh.quaternion.copy(dash.quaternion)
    mesh.scale.copy(dash.scale)
    // A few millimetres towards the driver so it never depth-fights the dash face it copies.
    mesh.position.z += 0.003
    mesh.renderOrder = 3
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = "car-gauges"
    return mesh
  }

  private addLamps() {
    const add = (lamp: Lamp, local: readonly number[], localDir: readonly number[] | null, base: number) => {
      this.ctx.lamps.push(lamp)
      this.lit.push({
        lamp,
        pos: lamp.position as unknown as number[],
        dir: null,
        local: new THREE.Vector3(local[0], local[1], local[2]),
        localDir: localDir ? new THREE.Vector3(localDir[0], localDir[1], localDir[2]).normalize() : null,
        base,
      })
    }
    for (const h of HEAD) {
      add({ kind: "incandescent", position: [...h], direction: [0, -0.06, -1], color: [1, 0.84, 0.62], intensity: 0, range: 48, angle: 0.5, penumbra: 0.75, size: 0.11 }, h, [0, -0.06, -1], 1)
    }
    for (const t of TAIL) {
      add({ kind: "incandescent", position: [t[0], t[1], t[2] + 0.04], direction: [0, -0.15, 1], color: [1, 0.035, 0.012], intensity: 0, range: 5, angle: 1.25, penumbra: 0.9, size: 0.07 }, [t[0], t[1], t[2] + 0.04], [0, -0.15, 1], 1)
    }
    // Instrument light on the driver's hands, the wheel rim and the headliner (a "window" lamp: no emitter halo).
    add({ kind: "window", position: [...DASH], direction: [0, 0.35, 1], color: [0.3, 0.92, 0.75], intensity: 0, range: 0.7, angle: 1.0, penumbra: 1 }, DASH, [0, 0.35, 1], 1)
  }

  /** Soft contact shadow under the parked car (the moving car drives over road crown, where a decal would cut in). */
  private addShadow() {
    const layer = shadowLayer()
    const rr = (w: number, d: number, r: number) => {
      const s = new THREE.Shape()
      const x = w / 2 - r
      const z = d / 2 - r
      s.absarc(x, z, r, 0, Math.PI / 2, false)
      s.absarc(-x, z, r, Math.PI / 2, Math.PI, false)
      s.absarc(-x, -z, r, Math.PI, Math.PI * 1.5, false)
      s.absarc(x, -z, r, Math.PI * 1.5, Math.PI * 2, false)
      const g = new THREE.ShapeGeometry(s, 4)
      g.rotateX(-Math.PI / 2)
      return g
    }
    for (let k = 0; k < 4; k++) {
      const grow = 0.5 - k * 0.18
      const m = new THREE.Mesh(rr(CAR_SIZE.width + grow, CAR_SIZE.length + grow, CAR_SIZE.width * 0.25 + grow * 0.4), layer)
      m.position.y = 0.006 + k * 0.001
      m.renderOrder = 2
      m.receiveShadow = false
      this.shadow.add(m)
    }
    for (const name of ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"]) {
      const c = centre(name)
      for (let k = 0; k < 3; k++) {
        const g = new THREE.CircleGeometry(1, 16)
        g.scale(0.2 - k * 0.05, 0.36 - k * 0.09, 1)
        g.rotateX(-Math.PI / 2)
        const m = new THREE.Mesh(g, layer)
        m.position.set(c.x, 0.011 + k * 0.001, c.z)
        m.renderOrder = 2
        m.receiveShadow = false
        this.shadow.add(m)
      }
    }
  }

  /** Places the car (ground height under its centre, heading as a model yaw). */
  place(x: number, y: number, z: number, yaw: number, pitch = 0, roll = 0) {
    this.root.position.set(x, y, z)
    this.root.rotation.set(pitch, yaw, roll, "YXZ")
  }

  /**
   * Per frame: wheel spin from `speed` (m/s), steering from path `curvature` (1/m, + left), body pitch from `accel` and
   * roll from lateral acceleration, a little road texture; door swing; lights and their lamps.
   */
  update(dt: number, time: number, speed: number, accel: number, curvature: number) {
    // Steering: Ackermann angle for the curvature, the wheel lagging the road slightly as a driver's hands would.
    const road = Math.atan(WHEELBASE * curvature)
    const want = road * STEER_RATIO
    this.steerAngle += (want - this.steerAngle) * (1 - Math.exp(-dt * 6))
    const steerRoad = this.steerAngle / STEER_RATIO
    this.spin -= (speed * dt) / WHEEL_R
    for (const w of this.wheels) {
      w.steer.rotation.y = w.front ? steerRoad : 0
      w.spin.rotation.x = this.spin
    }
    const axis = this.steering.userData.axis as THREE.Vector3 | undefined
    if (axis) this.steering.quaternion.setFromAxisAngle(axis, -this.steerAngle)
    // Suspension: soft 70s springs. Nose dives under braking, squats under power, leans out of turns, and the road
    // works through it at speed.
    const lat = speed * speed * curvature
    const rough = Math.min(1, speed / 12)
    const bump = (Math.sin(time * 7.3) * 0.5 + Math.sin(time * 11.9 + 1.3) * 0.3 + Math.sin(time * 3.1 + 0.4) * 0.6) * rough
    const pitchT = -accel * 0.011 + bump * 0.0016
    const rollT = -lat * 0.012 + Math.sin(time * 5.7 + 2) * 0.0012 * rough
    const k = 1 - Math.exp(-dt * 5)
    this.body.rotation.x += (pitchT - this.body.rotation.x) * k
    this.body.rotation.z += (rollT - this.body.rotation.z) * k
    this.body.position.y = bump * 0.004
    // Door: a heavy door swings out quickly and checks at its detent.
    const t = this.doorAmount
    this.door.rotation.y = -DOOR_OPEN * Math.min(1, Math.max(0, t))
    this.updateLights()
    this.placeMarkers()
  }

  private updateLights() {
    this.root.updateMatrixWorld(true)
    const m = this.body.matrixWorld
    const q = new THREE.Quaternion().setFromRotationMatrix(m)
    const p = new THREE.Vector3()
    const d = new THREE.Vector3()
    this.lit.forEach((l, i) => {
      const level = i < 2 ? this.lights.head : i < 4 ? this.lights.tail + this.lights.brake * 3 : this.lights.dash
      const nominal = i < 2 ? 1300 : i < 4 ? 5 : 0.25
      l.lamp.intensity = nominal * level
      p.copy(l.local).applyMatrix4(m)
      l.pos[0] = p.x
      l.pos[1] = p.y
      l.pos[2] = p.z
      if (l.localDir) aimLamp(l.lamp, d.copy(l.localDir).applyQuaternion(q))
    })
    for (const lm of this.lensMats) {
      const level = lm.key === "tail" ? this.lights.tail + this.lights.brake * 2.5 : this.lights[lm.key]
      const v = level * lm.scale
      if (lm.u.value instanceof THREE.Color) lm.u.value.copy(lm.color).multiplyScalar(v)
      else lm.u.value = v
    }
    if (this.beam.borrowed) this.beamIntensity()
  }

  /**
   * The driver's seat for `body.seat(...)` (src/playerb/seat.ts): live anchors on the car, so pass it once. Then each
   * frame `body.steer(car.steeringAngle)`.
   */
  seatOptions(): SeatOptions {
    const a = this.anchors
    return { hip: a.hip, eye: a.eye, wheel: { object: this.steering, radius: WHEEL_RADIUS, tube: WHEEL_TUBE }, doorHandle: a.handle, doorEdge: a.edge }
  }

  /** An anchor's position in the car body's frame (model space as the body sits): where the driver looks. */
  anchorLocal(name: "handle" | "edge" | "eye", out: THREE.Vector3) {
    this.anchors[name].getWorldPosition(out)
    return this.body.worldToLocal(out)
  }

  private markers: THREE.Mesh[] | null = null
  /** Debug (`?introRig`): small dots on the rig points (hip, eye, wheel rim/top, handle, edge). */
  showRig(scene: THREE.Object3D) {
    if (this.markers) return
    const geo = new THREE.SphereGeometry(0.015, 8, 6)
    const mk = (c: number) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicNodeMaterial({ color: c, depthTest: false }))
      m.renderOrder = 10
      scene.add(m)
      return m
    }
    this.markers = [mk(0xff2020), mk(0x20ff20), mk(0x2080ff), mk(0xffffff), mk(0xffff00), mk(0xff00ff), mk(0x00ffff), mk(0x00ffff)]
  }
  private placeMarkers() {
    const m = this.markers
    if (!m) return
    const a = this.anchors
    const axis = this.steering.userData.axis as THREE.Vector3
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(axis, -axis.y).normalize()
    const side = new THREE.Vector3().crossVectors(axis, up)
    a.hip.getWorldPosition(m[0]!.position)
    this.steering.getWorldPosition(m[1]!.position)
    m[2]!.position.copy(up).multiplyScalar(WHEEL_RADIUS).applyMatrix4(this.steering.matrixWorld)
    a.eye.getWorldPosition(m[3]!.position)
    a.handle.getWorldPosition(m[4]!.position)
    a.edge.getWorldPosition(m[5]!.position)
    m[6]!.position.copy(side).multiplyScalar(WHEEL_RADIUS).applyMatrix4(this.steering.matrixWorld)
    m[7]!.position.copy(side).multiplyScalar(-WHEEL_RADIUS).applyMatrix4(this.steering.matrixWorld)
  }

  /** Steering-wheel angle (rad, + left). */
  /** Steering-wheel angle (rad, + = turned left); what `body.steer` takes. */
  get wheelAngle() {
    return this.steerAngle
  }

  get steeringAngle() {
    return this.steerAngle
  }

  /** The headlamps' beam (world), or false while they're off. */
  headlamps(pos: THREE.Vector3, dir: THREE.Vector3) {
    return this.lights.head > 0.05 && this.beamAt(pos, dir)
  }

  /** World position + direction of the shadowed beam (between the headlamps, aimed down the road). */
  private beamAt(pos: THREE.Vector3, dir: THREE.Vector3) {
    pos.set(0, 0.7, -2.62).applyMatrix4(this.body.matrixWorld)
    dir.set(0, -0.042, -1).applyQuaternion(this.body.getWorldQuaternion(tmpQ)).normalize()
    return true
  }

  private beamIntensity() {
    const s = this.ctx.settings
    s["flash.intensity"] = 4200 * this.lights.head
  }

  /**
   * Borrows the light rig's flashlight spot (the one shadowed, fog-scattering beam it keeps in every material's light
   * list, so using it compiles nothing) as the headlamps' shadowed beam. `release` restores the torch and its settings.
   */
  borrowBeam(player: { flashlight: boolean }) {
    if (this.beam.borrowed) return
    const s = this.ctx.settings
    const keys = ["flash.intensity", "flash.angle", "flash.range", "flash.lag", "flash.scatter", "flash.near", "flash.shadows"]
    for (const k of keys) this.beam.settings[k] = s[k]
    this.beam.saved = renderState.torchLens
    renderState.torchLens = (pos, dir) => this.beamAt(pos, dir)
    s["flash.angle"] = 40
    s["flash.range"] = 70
    s["flash.lag"] = 0
    s["flash.scatter"] = 0.16
    s["flash.near"] = 1.5
    s["flash.shadows"] = true
    this.beam.borrowed = true
    this.beamIntensity()
    this.beam.settings.__flashlight = player.flashlight
    player.flashlight = true
  }

  releaseBeam(player: { flashlight: boolean }) {
    if (!this.beam.borrowed) return
    const s = this.ctx.settings
    for (const [k, v] of Object.entries(this.beam.settings)) if (k !== "__flashlight") s[k] = v as never
    renderState.torchLens = this.beam.saved
    player.flashlight = this.beam.settings.__flashlight === true
    this.beam.borrowed = false
  }

  /** Model-space seat eye to world. */
  seatWorld(seat: Seat | string, out = new THREE.Vector3()) {
    const s = typeof seat === "string" ? SEATS.find((x) => x.id === seat)! : seat
    return out.set(s.eye[0], s.eye[1], s.eye[2]).applyMatrix4(this.body.matrixWorld)
  }

  /** Parked: contact shadow on, and solid (a collider for the player and the lamps' glow occlusion). */
  park() {
    this.shadow.visible = true
    if (this.collider) this.unparkCollider()
    const yaw = this.root.rotation.y
    const hx = CAR_SIZE.width / 2 - 0.08
    const hz = CAR_SIZE.length / 2 - 0.08
    const c = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw))
    const ex = hx * c + hz * sn
    const ez = hx * sn + hz * c
    const { x, y, z } = this.root.position
    this.collider = { min: [x - ex, y, z - ez], max: [x + ex, y + CAR_SIZE.height - 0.05, z + ez] }
    this.ctx.colliders.push(this.collider)
  }

  /** The parked car's collider (null while driving). */
  footprint(): Box | null {
    return this.collider
  }

  /** Driving again (a replayed intro): no contact shadow, not a collider. */
  unpark() {
    this.shadow.visible = false
    this.unparkCollider()
  }

  private unparkCollider() {
    if (!this.collider) return
    const i = this.ctx.colliders.indexOf(this.collider)
    if (i >= 0) this.ctx.colliders.splice(i, 1)
    this.collider = null
  }

  /** Requests a shadow refresh from the static lamp shadow maps whose cones the car is in (they render on demand). */
  refreshShadows(scene: THREE.Object3D) {
    const at = this.root.position
    for (const o of scene.children) {
      const l = o as THREE.SpotLight
      if (!l.isSpotLight || !l.castShadow || l.intensity <= 0 || l.shadow.autoUpdate) continue
      const dx = at.x - l.position.x
      const dy = at.y + 0.7 - l.position.y
      const dz = at.z - l.position.z
      const dist = Math.hypot(dx, dy, dz)
      if (dist > l.distance + 3) continue
      tmpV.copy(l.target.position).sub(l.position).normalize()
      if ((dx * tmpV.x + dy * tmpV.y + dz * tmpV.z) / dist < Math.cos(l.angle + 0.25)) continue
      l.shadow.needsUpdate = true
    }
  }
}

const tmpQ = new THREE.Quaternion()
const tmpV = new THREE.Vector3()

/**
 * Turns a registered lamp's cone. The rig (render/lighting.ts) copies `Lamp.direction` once when it adopts the lamp,
 * into its own direction vector and the clustered light's cone; both are found through `renderState.lamps`.
 */
function aimLamp(lamp: Lamp, dir: THREE.Vector3) {
  const d = lamp.direction as unknown as number[] | undefined
  if (d) {
    d[0] = dir.x
    d[1] = dir.y
    d[2] = dir.z
  }
  const rig = rigOf(lamp)
  if (!rig) return
  rig.dir?.copy(dir)
  const cone = rig.point?.userData.cone as { dir: number[] } | undefined
  if (cone) {
    cone.dir[0] = dir.x
    cone.dir[1] = dir.y
    cone.dir[2] = dir.z
  }
}
type RigRef = (typeof renderState.lamps)[number] & { point?: THREE.PointLight }
const rigs = new Map<Lamp, RigRef>()
/** The light rig's runtime entry for a lamp (adopted the frame after it is registered). */
function rigOf(lamp: Lamp): RigRef | undefined {
  let rig = rigs.get(lamp)
  if (!rig) {
    rig = renderState.lamps.find((r) => r.lamp === lamp) as RigRef | undefined
    if (rig) rigs.set(lamp, rig)
  }
  return rig
}
