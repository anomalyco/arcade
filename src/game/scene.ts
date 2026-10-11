import { vec4 } from "wgpu-matrix"
import { VEHICLE_BY_ID, VEHICLES } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import type { CarView, WorldView } from "../../shared/sim/world"
import { buildCarVariants, buildHeli, buildRotor } from "../render/car-mesh"
import { buildPuff } from "../render/puff"
import { buildCityMesh, type LampLight } from "../render/city-mesh"
import { MAT, Mesh } from "../render/mesh"
import { FRAME_FLOATS, INST_FLOATS, type InstanceBatch, type Renderer, SPRITE_FLOATS } from "../render/renderer"
import { MAX_LIGHTS } from "../render/shaders"
import type { Camera } from "./camera"
import { Fx } from "./fx"

const MAX_SPRITES_PER_LIST = 3000
const ROBBER_TINT: [number, number, number] = [1.0, 0.55, 0.12]
const COP_TINT: [number, number, number] = [0.25, 0.5, 1.0]
const SPOT_GROUND_RADIUS = 7.5
const HELI_SCALE = 0.8
const MOON = normalizeV([-0.55, 0.62, -0.55])

function normalizeV(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!)
  return [v[0]! / l, v[1]! / l, v[2]! / l]
}

type Vis = { roll: number; pitch: number; speed: number; h: number; fuel: number; smokeAcc: number }

/** Matches the shader's siren strobe so glows and lights flash in sync with the lamp geometry. */
export function sirenOn(phase: number, red: boolean) {
  if (phase < 0) return 0
  const t = phase - Math.floor(phase)
  const a = red ? (t <= 0.5 ? 1 : 0) : t >= 0.5 ? 1 : 0
  const strobe = (t * 4) % 1 >= 0.5 ? 1 : 0
  return a * (0.5 + 0.5 * strobe)
}

export class Scene {
  readonly fx = new Fx()
  private lamps: LampLight[]
  private models = new Map<string, number>()
  private variants = new Map<string, number[]>()
  private heliModel: number
  private rotorModel: number
  private puffModel: number
  private vis = new Map<number, Vis>()
  private frame = new Float32Array(FRAME_FLOATS)
  private lights = new Float32Array(MAX_LIGHTS * 12)
  private alpha = new Float32Array(MAX_SPRITES_PER_LIST * SPRITE_FLOATS)
  private add = new Float32Array(MAX_SPRITES_PER_LIST * SPRITE_FLOATS)
  private time = 0
  /** Camera shake requests from impacts on the followed car. */
  shake = 0

  constructor(
    private renderer: Renderer,
    readonly city: City,
  ) {
    const built = buildCityMesh(city)
    renderer.setCity(built.mesh)
    this.lamps = built.lamps
    for (const v of VEHICLES) {
      const ids = buildCarVariants(v).map((m) => renderer.addModel(m))
      this.variants.set(v.id, ids)
      this.models.set(v.id, ids[0]!)
    }
    this.heliModel = renderer.addModel(buildHeli())
    this.rotorModel = renderer.addModel(buildRotor())
    this.puffModel = renderer.addModel(buildPuff())
  }

  private visOf(c: CarView) {
    let v = this.vis.get(c.id)
    if (!v) {
      v = { roll: 0, pitch: 0, speed: c.speed, h: c.h, fuel: c.boost, smokeAcc: 0 }
      this.vis.set(c.id, v)
    }
    return v
  }

  /** Per-car visual dynamics (body roll, pitch) and particle emission. */
  private animate(view: WorldView, dt: number, focusId: number | null) {
    for (const c of view.cars) {
      if (c.ghost) continue
      const v = this.visOf(c)
      const spec = VEHICLE_BY_ID.get(c.vehicle)!
      let dh = c.h - v.h
      dh = Math.atan2(Math.sin(dh), Math.cos(dh))
      const yawRate = dt > 0 ? dh / dt : 0
      const accel = dt > 0 ? (c.speed - v.speed) / dt : 0
      const k = 1 - Math.exp(-dt * 8)
      v.roll += (Math.max(-0.11, Math.min(0.11, yawRate * c.speed * 0.0035)) - v.roll) * k
      v.pitch += (Math.max(-0.06, Math.min(0.06, -accel * 0.004)) - v.pitch) * k
      v.speed = c.speed
      v.h = c.h
      const fx = Math.sin(c.h)
      const fz = Math.cos(c.h)
      const rx = Math.cos(c.h)
      const rz = -Math.sin(c.h)
      const back = spec.length * 0.36
      const side = spec.width * 0.4
      if (c.drift > 4 && c.speed > 7) {
        const intensity = Math.min(1, (c.drift - 3) / 8)
        for (const s of [-1, 1]) this.fx.skid(c.x - fx * back + rx * side * s, c.z - fz * back + rz * side * s, Math.atan2(c.vx, c.vz), 0.45 * intensity + 0.15)
        v.smokeAcc += dt * 16 * intensity
        while (v.smokeAcc > 1) {
          v.smokeAcc -= 1
          const s = Math.random() < 0.5 ? -1 : 1
          this.fx.smoke(c.x - fx * back + rx * side * s, c.z - fz * back + rz * side * s, c.vx, c.vz, intensity)
        }
      }
      if (c.boost < v.fuel - 1e-4 && c.speed > 4) {
        for (const s of spec.id === "bike" ? [0] : [-0.35, 0.35]) this.fx.flame(c.x - fx * (spec.length / 2 + 0.2) + rx * s, 0.5, c.z - fz * (spec.length / 2 + 0.2) + rz * s, -fx * 8, -fz * 8)
      }
      v.fuel = c.boost
      if (c.impact > 5) {
        const sp = Math.hypot(c.vx, c.vz) || 1
        this.fx.sparks(c.x + (c.vx / sp) * spec.length * 0.45, c.z + (c.vz / sp) * spec.length * 0.45, -c.vx / sp, -c.vz / sp, Math.min(24, Math.floor(c.impact)))
        if (c.id === focusId) this.shake = Math.max(this.shake, Math.min(1, c.impact / 18))
      }
    }
    this.fx.update(dt)
  }

  draw(view: WorldView, cam: Camera, w: number, h: number, dt: number, focus: CarView | null, opts: { bloom?: number; flash?: number } = {}) {
    this.time += dt
    this.animate(view, dt, focus?.id ?? null)
    const t = this.time
    const vp = cam.matrices(w / h)
    const f = this.frame
    f.set(vp, 0)
    // Shadow camera: orthographic from the moon, centered on the camera focus.
    const lightEye = [cam.fx + MOON[0] * 300, MOON[1] * 300, cam.fz + MOON[2] * 300]
    f.set(lightMatrix(lightEye, [cam.fx, 0, cam.fz]), 16)
    let o = 32
    const put = (a: number, b: number, c: number, d: number) => {
      f[o++] = a
      f[o++] = b
      f[o++] = c
      f[o++] = d
    }
    put(cam.eye[0], cam.eye[1], cam.eye[2], t)
    const fp = focus ? [focus.x, 1, focus.z] : [cam.fx, 1, cam.fz]
    put(fp[0]!, fp[1]!, fp[2]!, focus ? 0.24 : 0)
    put(w, h, 0, t)
    put(MOON[0], MOON[1], MOON[2], 0.6)
    const heli = view.heli
    if (heli.active) {
      const ox = heli.x + Math.sin(heli.h) * 1.7
      const oz = heli.z + Math.cos(heli.h) * 1.7
      const dir = normalizeV([heli.sx - ox, -heli.y - 0.4, heli.sz - oz])
      put(ox, heli.y + 0.4, oz, 1)
      const reach = Math.hypot(heli.sx - ox, heli.y, heli.sz - oz)
      put(dir[0], dir[1], dir[2], Math.cos(Math.atan(SPOT_GROUND_RADIUS / reach)) - 0.003)
    } else {
      put(0, 0, 0, 0)
      put(0, -1, 0, 1)
    }
    put(0.035, 0.045, 0.085, 0.0035)
    const clip = vec4.transformMat4([fp[0]!, fp[1]!, fp[2]!, 1], vp)
    put(clip[0]! / clip[3]!, clip[1]! / clip[3]!, clip[2]! / clip[3]!, 0)

    // Lights: cars first (they matter most), then the street lamps nearest to the camera focus.
    const L = this.lights
    let n = 0
    const light = (x: number, y: number, z: number, radius: number, r: number, g: number, b: number, intensity: number, dx = 0, dy = 0, dz = 0, cone = -2) => {
      if (n >= MAX_LIGHTS) return
      const i = n * 12
      L[i] = x
      L[i + 1] = y
      L[i + 2] = z
      L[i + 3] = radius
      L[i + 4] = r
      L[i + 5] = g
      L[i + 6] = b
      L[i + 7] = intensity
      L[i + 8] = dx
      L[i + 9] = dy
      L[i + 10] = dz
      L[i + 11] = cone
      n++
    }

    const alpha = this.alpha
    const add = this.add
    let ai = 0
    let di = 0
    const sprite = (list: "a" | "d", x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot = 0, stretch = 1, extra = 0) => {
      if (list === "a") {
        if (ai < MAX_SPRITES_PER_LIST) Fx.write(alpha, ai++, { x, y, z, size, r, g, b, a, kind, rot, stretch, seed: extra })
      } else if (di < MAX_SPRITES_PER_LIST) Fx.write(add, di++, { x, y, z, size, r, g, b, a, kind, rot, stretch, seed: extra })
    }

    const beams = new Mesh()
    const batches = new Map<number, number[]>()
    const ghosts = new Map<number, number[]>()
    const inst = (model: number, map: Map<number, number[]>, vals: number[]) => {
      let arr = map.get(model)
      if (!arr) map.set(model, (arr = []))
      arr.push(...vals)
    }

    const chasing = view.phase === "chase" || view.phase === "headstart" || view.phase === "end"
    for (const c of view.cars) {
      const spec = VEHICLE_BY_ID.get(c.vehicle)!
      const vs = this.variants.get(c.vehicle)!
      const model = vs[c.id % vs.length]!
      const tint = c.role === "robber" ? ROBBER_TINT : COP_TINT
      if (c.ghost) {
        // Last-seen ping for cops: a pulsing ring and a faint silhouette where the suspect was.
        const pulse = (t * 1.2) % 1
        sprite("d", c.x, 0.15, c.z, 3 + pulse * 9, 1, 0.2, 0.15, 1.6 * (1 - pulse), 2)
        sprite("d", c.x, 0.12, c.z, 5, 1, 0.2, 0.15, 0.4, 3)
        continue
      }
      const v = this.visOf(c)
      const siren = c.role === "cop" ? t * 1.7 + c.id * 0.37 : -1
      const braking = c.speed > 2 && c.speed < v.speed - 0.05 ? 1 : 0
      const vals = [c.x, 0, c.z, c.h, v.roll, v.pitch, siren, braking, tint[0], tint[1], tint[2], 1]
      inst(model, batches, vals)
      inst(model, ghosts, vals)

      const fx = Math.sin(c.h)
      const fz = Math.cos(c.h)
      const rx = Math.cos(c.h)
      const rz = -Math.sin(c.h)
      const half = spec.length / 2
      // Headlights: one spot per car, plus lens glows and a soft pool on the road ahead.
      light(c.x + fx * (half + 0.5), 1.3, c.z + fz * (half + 0.5), 36, 1, 0.92, 0.78, 3.2, fx * 0.95, -0.3, fz * 0.95, 0.8)
      const hw = spec.width / 2 - 0.25
      for (const s of spec.id === "bike" ? [0] : [-1, 1]) {
        sprite("d", c.x + fx * (half + 0.1) + rx * hw * s, 0.75, c.z + fz * (half + 0.1) + rz * hw * s, 0.55, 1, 0.95, 0.85, 1.4, 0)
        sprite("d", c.x - fx * (half + 0.05) + rx * hw * s, 0.75, c.z - fz * (half + 0.05) + rz * hw * s, braking ? 0.9 : 0.55, 1, 0.12, 0.08, braking ? 2.2 : 1.1, 0)
      }
      // No beam geometry: the spot light lights the road, plus a faint soft pool ahead of the car.
      sprite("d", c.x + fx * (half + 6), 0.06, c.z + fz * (half + 6), 2.6, 1, 0.9, 0.72, 0.1, 3, c.h, 2.2)
      light(c.x - fx * (half + 0.6), 0.9, c.z - fz * (half + 0.6), 7, 1, 0.1, 0.06, braking ? 3 : 1.2)
      if (siren >= 0) {
        const red = sirenOn(siren, true)
        const blue = sirenOn(siren, false)
        const y = spec.id === "swat" ? 2.9 : 1.9
        // Siren light sits low and to the sides so it paints the road and walls, not the car's own livery.
        light(c.x - rx * 2.2, y - 1.2, c.z - rz * 2.2, 14, 1, 0.08, 0.08, 3 * red)
        light(c.x + rx * 2.2, y - 1.2, c.z + rz * 2.2, 14, 0.15, 0.3, 1, 3.6 * blue)
        if (red > 0) sprite("d", c.x - rx * 0.45, y, c.z - rz * 0.45, 0.9, 1, 0.1, 0.1, 1.5 * red, 0)
        if (blue > 0) sprite("d", c.x + rx * 0.45, y, c.z + rz * 0.45, 0.9, 0.2, 0.35, 1, 1.7 * blue, 0)
        // Colored wash on the road around the cruiser.
        sprite("d", c.x, 0.08, c.z, 7, red > blue ? 1 : 0.2, 0.15, red > blue ? 0.15 : 1, 0.12 * Math.max(red, blue), 3)
      }
    }

    for (const p of this.city.parked) {
      if ((p.x - cam.fx) ** 2 + (p.z - cam.fz) ** 2 > 260 * 260) continue
      inst(this.models.get(p.model)!, batches, [p.x, 0, p.z, p.h, 0, 0, -1, 0, 0, 0, 0, 1])
    }

    // Helicopter with spinning rotor and its spotlight beam.
    if (heli.active) {
      inst(this.heliModel, batches, [heli.x, heli.y, heli.z, heli.h, 0.05, 0.08, -1, 0, 1, 1, 1, HELI_SCALE])
      inst(this.rotorModel, batches, [heli.x, heli.y + 3.1 * HELI_SCALE / 1.2, heli.z, t * 25, 0, 0, -1, 0, 1, 1, 1, HELI_SCALE])
      inst(this.rotorModel, batches, [heli.x + Math.sin(heli.h) * -7.9 * HELI_SCALE / 1.2, heli.y + 2.3 * HELI_SCALE / 1.2, heli.z + Math.cos(heli.h) * -7.9 * HELI_SCALE / 1.2, t * 40, 0, 0, -1, 0, 1, 1, 1, 0.1])
      const sx = heli.x + Math.sin(heli.h) * 1.7
      const sz = heli.z + Math.cos(heli.h) * 1.7
      cone(beams, [sx, heli.y + 0.4, sz], [heli.sx, 0, heli.sz], SPOT_GROUND_RADIUS, [0.75, 0.85, 1], 0.32)
      sprite("d", heli.sx, 0.1, heli.sz, SPOT_GROUND_RADIUS * 1.3, 0.85, 0.92, 1, 0.1, 3)
      sprite("d", heli.x, heli.y - 0.5, heli.z, 1.6, 1, 1, 1, 2.5, 0)
      if (Math.floor(t * 1.5) % 2 === 0) sprite("d", heli.x, heli.y + 1.6, heli.z, 1.2, 1, 0.1, 0.1, 2, 0)
    }

    // Bust ring around a boxed-in robber.
    const robber = view.cars.find((c) => c.ownerId === view.robberId && !c.ghost)
    if (robber && view.bust > 0.01) {
      sprite("d", robber.x, 0.15, robber.z, 5.5, 0.25, 0.55, 1, 1 + view.bust * 2, 2, -t * 2)
    }

    // Street lamps: glows for all nearby, real lights for the closest.
    const near = this.lamps
      .map((l) => ({ l, d: (l.x - cam.fx) ** 2 + (l.z - cam.fz) ** 2 }))
      .filter((e) => e.d < 230 * 230)
      .sort((a, b) => a.d - b.d)
    for (const { l } of near) {
      sprite("d", l.x, l.y + 0.4, l.z, l.small ? 0.6 : 0.9, 1, 0.75, 0.45, 1.6, 0)
    }
    for (const { l } of near) light(l.x, l.y, l.z, l.small ? 10 : 17, 1, 0.58, 0.26, l.small ? 3 : 5)
    f[32 + 8 + 2] = n

    const puffs = this.fx.puffInstances()
    if (puffs.length) batches.set(this.puffModel, puffs)
    const fxc = this.fx.emit(alpha, ai, add, di, MAX_SPRITES_PER_LIST)
    const pack = (map: Map<number, number[]>): InstanceBatch[] => [...map].map(([model, arr]) => ({ model, data: new Float32Array(arr), count: arr.length / INST_FLOATS }))
    const beamData = beams.toArray()
    this.renderer.setBeams(beamData, beams.count)
    this.renderer.render({
      frame: f,
      lights: L,
      batches: pack(batches),
      ghosts: pack(ghosts).filter((b) => b.model !== this.heliModel && b.model !== this.rotorModel && b.model !== this.puffModel),
      sprites: { alpha, alphaCount: fxc.alpha, add, addCount: fxc.add },
      bloom: opts.bloom ?? 0.9,
      flash: opts.flash ?? 0,
    })
  }
}

/** Open cone from apex to a ground ellipse; uv.x runs 0 at the apex to 1 at the base, uv.y is strength. */
function cone(m: Mesh, apex: number[], base: number[], radius: number, color: [number, number, number], strength: number, sides = 20) {
  const ax = base[0]! - apex[0]!, ay = base[1]! - apex[1]!, az = base[2]! - apex[2]!
  const len = Math.hypot(ax, ay, az)
  const d = [ax / len, ay / len, az / len]
  const up = Math.abs(d[1]!) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalizeV([d[1]! * up[2]! - d[2]! * up[1]!, d[2]! * up[0]! - d[0]! * up[2]!, d[0]! * up[1]! - d[1]! * up[0]!])
  const w = [d[1]! * u[2] - d[2]! * u[1], d[2]! * u[0] - d[0]! * u[2], d[0]! * u[1] - d[1]! * u[0]]
  const ring = (a: number) => {
    const c = Math.cos(a), s = Math.sin(a)
    const off = [u[0] * c + w[0]! * s, u[1] * c + w[1]! * s, u[2] * c + w[2]! * s]
    return { p: [base[0]! + off[0]! * radius, base[1]! + off[1]! * radius, base[2]! + off[2]! * radius], n: off }
  }
  for (let i = 0; i < sides; i++) {
    const a = ring((i / sides) * Math.PI * 2)
    const b = ring(((i + 1) / sides) * Math.PI * 2)
    const nm = normalizeV([a.n[0]! + b.n[0]!, a.n[1]! + b.n[1]!, a.n[2]! + b.n[2]!])
    m.vert(apex[0]!, apex[1]!, apex[2]!, nm[0], nm[1], nm[2], color, MAT.lit, 0, strength)
    m.vert(a.p[0]!, a.p[1]!, a.p[2]!, a.n[0]!, a.n[1]!, a.n[2]!, color, MAT.lit, 1, strength)
    m.vert(b.p[0]!, b.p[1]!, b.p[2]!, b.n[0]!, b.n[1]!, b.n[2]!, color, MAT.lit, 1, strength)
  }
}

function lightMatrix(eye: number[], target: number[]) {
  const z = normalizeV([eye[0]! - target[0]!, eye[1]! - target[1]!, eye[2]! - target[2]!])
  const x = normalizeV([z[2], 0, -z[0]])
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  const S = 150
  const near = 50
  const far = 600
  // Column-major ortho * lookAt, depth 0..1.
  const view = [x[0], y[0]!, z[0], 0, x[1], y[1]!, z[1], 0, x[2], y[2]!, z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]
  const proj = [1 / S, 0, 0, 0, 0, 1 / S, 0, 0, 0, 0, -1 / (far - near), 0, 0, 0, -near / (far - near), 1]
  return mul(proj, view)
}

function dot(a: number[], b: number[]) {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
}

function mul(a: number[], b: number[]) {
  const r = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr]! += a[k * 4 + rr]! * b[c * 4 + k]!
  return r
}
