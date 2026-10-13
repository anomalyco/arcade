import { VEHICLE_BY_ID } from "../../../shared/config"
import type { City } from "../../../shared/sim/city"
import type { CarView } from "../../../shared/sim/world"
import type { Renderer } from "../../render/renderer"
import { propMesh, chunkMesh } from "../../render/props-mesh"
import { body, PropPhysics, type Body } from "./physics"
import { placeProps, PROP_KINDS, SPECS, type Placement, type PropKind } from "./placement"
import { PropParticles, type SpriteWriter } from "./particles"
import { mulberry32 } from "../../../shared/sim/rng"

type Prop = { body: Body; home: Placement; model: number; broken: boolean; touched: number; hitAt: number; fuse: number }
type Chunk = { body: Body; model: number; scale: number; life: number }
type Reaction = { x: number; y: number; z: number; age: number; water: boolean; acc: number }
export type PropInstanceWriter = (model: number, x: number, y: number, z: number, yaw: number, roll: number, pitch: number, scale: number) => void
export type PropLightWriter = (x: number, y: number, z: number, radius: number, r: number, g: number, b: number, intensity: number) => void
const MAX_CHUNKS = 384

export class StreetProps {
  readonly physics: PropPhysics
  readonly particles = new PropParticles()
  readonly models = new Map<PropKind, number>()
  readonly shadowless = new Set<number>()
  readonly props: Prop[] = []
  readonly reactions: Reaction[] = []
  readonly chunks: Chunk[] = []
  private byId = new Map<number, Prop>()
  private changed = new Set<Prop>()
  private chunkModels = new Map<PropKind, number>()
  private nextId = 0
  private time = 0
  private rng = mulberry32(179)
  private previous = new Map<number, { x: number; z: number }>()
  private layout: Placement[]
  stats = { cpuMs: 0, awake: 0, particles: 0, chunks: 0, hits: 0, explosions: 0 }
  shake = 0

  constructor(city: City, renderer: Pick<Renderer, "addModel">, readonly ground: (x: number, z: number) => number) {
    this.physics = new PropPhysics(ground, city.boxes)
    for (const kind of PROP_KINDS) {
      const model = renderer.addModel(propMesh(kind)), chunk = renderer.addModel(chunkMesh(SPECS[kind].color, ["bench", "pallet", "crate", "barrier", "sawhorse"].includes(kind)))
      this.models.set(kind, model); this.chunkModels.set(kind, chunk)
      this.shadowless.add(model); this.shadowless.add(chunk)
    }
    this.layout = placeProps(city)
    for (const p of this.layout) this.add(p)
  }
  private add(p: Placement) {
    const s = SPECS[p.kind], [w, h, d] = s.size
    const b = body(this.nextId++, p.x, p.y + h / 2, p.z, w / 2, h / 2, d / 2, s.mass, p.yaw)
    const prop = { body: b, home: p, model: this.models.get(p.kind)!, broken: false, touched: -1, hitAt: -1, fuse: -1 }
    this.props.push(prop); this.byId.set(b.id, prop); this.physics.add(b)
    return prop
  }
  reset() {
    for (const c of this.chunks) this.physics.remove(c.body)
    this.chunks.length = this.reactions.length = 0
    this.particles.reset(); this.previous.clear(); this.rng = mulberry32(179); this.time = 0; this.shake = 0
    for (const p of this.changed) this.restore(p)
    this.changed.clear(); this.stats.hits = this.stats.explosions = 0
  }
  private restore(p: Prop) {
    const b = p.body, h = p.home
    this.physics.remove(b)
    Object.assign(b, { x: h.x, y: h.y + b.hy, z: h.z, yaw: h.yaw, roll: 0, pitch: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, sleep: 0, awake: false, enabled: true })
    p.broken = false; p.touched = p.hitAt = p.fuse = -1
    this.physics.add(b)
  }
  private touch(p: Prop) { if (p.touched < 0) p.touched = this.time; this.changed.add(p) }

  update(cars: readonly CarView[], dt: number, focus: { x: number; z: number }, explosions: boolean, visible: (x: number, y: number, z: number, radius: number) => boolean) {
    const started = performance.now()
    dt = Math.max(0, Math.min(.05, dt)); this.time += dt; this.shake = 0
    if (dt > 0) for (const car of cars) {
      if (car.ghost) continue
      const spec = VEHICLE_BY_ID.get(car.vehicle)!, old = this.previous.get(car.id)
      const distance = old ? Math.hypot(car.x - old.x, car.z - old.z) : 0
      // Reject teleports; a real view's swept box is sampled more finely than a cone's footprint.
      const steps = old && distance < 8 ? Math.max(1, Math.ceil(distance / .5)) : 1
      for (let step = 1; step <= steps; step++) {
        const x = old && distance < 8 ? old.x + (car.x - old.x) * step / steps : car.x
        const z = old && distance < 8 ? old.z + (car.z - old.z) * step / steps : car.z
        this.physics.hash.query(x, z, spec.length / 2 + 2.5, b => {
          const p = this.byId.get(b.id)
          if (!p || p.broken || this.time - p.hitAt < .4) return
          if (b.y - b.hy > (car.y ?? 0) + 1.4 || b.y + b.hy < (car.y ?? 0)) return
          const dx = b.x - x, dz = b.z - z, c = Math.cos(car.h), s = Math.sin(car.h)
          const lx = dx * c - dz * s, lz = dx * s + dz * c
          const radius = Math.min(b.radius, Math.max(b.hx, b.hz))
          const ax = Math.max(0, Math.abs(lx) - spec.width / 2), az = Math.max(0, Math.abs(lz) - spec.length / 2)
          if (ax * ax + az * az > radius * radius) return
          const speed = Math.hypot(car.vx - b.vx, car.vz - b.vz)
          if (speed < 1.5) return
          this.hit(p, car.vx, car.vz, speed, spec.mass * 1000, explosions)
        })
      }
      this.previous.set(car.id, { x: car.x, z: car.z })
    }
    for (const p of this.changed) {
      if (p.fuse >= 0 && this.time >= p.fuse) {
        p.fuse = -1
        if (explosions && !p.broken) this.explode(p, focus)
      }
      if (this.time - p.touched > 35 && !visible(p.home.x, p.home.y + 1, p.home.z, 4) && !visible(p.body.x, p.body.y, p.body.z, 4)) {
        this.restore(p); this.changed.delete(p)
      }
    }
    this.physics.update(dt)
    // Props woken by flying bodies also belong to the recovery set.
    for (const b of this.physics.active) { const p = this.byId.get(b.id); if (p) this.touch(p) }
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i]!
      c.life -= dt
      if (c.life <= 0) { this.physics.remove(c.body); this.chunks[i] = this.chunks.at(-1)!; this.chunks.pop() }
    }
    this.particles.update(dt, this.ground)
    for (let i = this.reactions.length - 1; i >= 0; i--) {
      const r = this.reactions[i]!
      r.age += dt
      if (r.water && r.age < 10) {
        r.acc += dt * 100
        const count = Math.floor(r.acc); r.acc -= count
        this.particles.emit(11, r.x, r.y + .12, r.z, count, .6)
      }
      if (r.age > (r.water ? 22 : 30)) { this.reactions[i] = this.reactions.at(-1)!; this.reactions.pop() }
    }
    this.stats.cpuMs = performance.now() - started
    this.stats.awake = this.physics.active.size; this.stats.particles = this.particles.count; this.stats.chunks = this.chunks.length
  }

  private hit(p: Prop, vx: number, vz: number, speed: number, carMass: number, explosions: boolean) {
    const firstHit = p.hitAt < 0
    p.hitAt = this.time; this.touch(p); this.stats.hits++
    const b = p.body, spec = SPECS[p.home.kind], direction = Math.hypot(vx, vz) || 1
    // Car is an infinite presentation-only collider; transmitted speed still distinguishes heavy props.
    const launch = Math.min(28, speed * .7 * carMass / (carMass + spec.mass * 18))
    this.physics.impulse(b, vx / direction * launch * b.mass, Math.min(6, launch * .32) * b.mass, vz / direction * launch * b.mass, .55)
    if (spec.explosive && explosions && speed > 6) p.fuse = this.time + .035
    else if (speed > spec.breakSpeed) this.shatter(p, vx, vz)
    if (firstHit && p.home.kind === "hydrant" && this.reactions.filter(r => r.water).length < 12) {
      this.reactions.push({ x: p.home.x, y: p.home.y, z: p.home.z, age: 0, water: true, acc: 0 })
    }
    if (firstHit && ["bin", "dumpster", "mailbox", "newspaper"].includes(p.home.kind)) this.particles.emit(10, b.x, b.y + .3, b.z, p.home.kind === "dumpster" ? 40 : 24, .7, vx, vz)
    if (!["cone", "crate", "pallet", "planter", "sawhorse", "bench"].includes(p.home.kind)) this.particles.emit(6, b.x, b.y, b.z, 5, .8)
  }
  private shatter(p: Prop, vx: number, vz: number) {
    if (p.broken) return
    p.broken = true; this.touch(p); this.physics.remove(p.body)
    const board = ["bench", "pallet", "crate", "barrier", "sawhorse"].includes(p.home.kind)
    const n = p.home.kind === "dumpster" ? 12 : 8
    for (let i = 0; i < n && this.chunks.length < MAX_CHUNKS; i++) {
      const rand = this.rng, scale = .3 + rand() * .55
      const b = body(this.nextId++, p.body.x + (rand() - .5) * .8, p.body.y + rand() * .7, p.body.z + (rand() - .5) * .8, .5 * scale, (board ? .07 : .3) * scale, .22 * scale, 1.5)
      this.physics.add(b)
      this.physics.impulse(b, (vx * .35 + (rand() - .5) * 12) * b.mass, (3 + rand() * 6) * b.mass, (vz * .35 + (rand() - .5) * 12) * b.mass, 1)
      this.chunks.push({ body: b, model: this.chunkModels.get(p.home.kind)!, scale, life: 10 + rand() * 5 })
    }
  }
  private explode(p: Prop, focus: { x: number; z: number }) {
    const b = p.body, x = b.x, y = Math.max(.2, b.y), z = b.z
    this.stats.explosions++
    this.shatter(p, b.vx, b.vz)
    if (this.reactions.length >= 48) this.reactions.shift()
    this.reactions.push({ x, y: this.ground(x, z), z, age: 0, water: false, acc: 0 })
    this.particles.emit(12, x, y, z, 10, .65)
    this.particles.emit(6, x, y, z, 48, 2)
    this.particles.emit(1, x, y, z, 14, .9)
    this.shake = Math.max(this.shake, Math.max(0, 1 - Math.hypot(x - focus.x, z - focus.z) / 35) * .8)
    this.physics.hash.query(x, z, 10, other => {
      const dx = other.x - x, dz = other.z - z, dist = Math.hypot(dx, dz)
      if (dist > 9 || dist < .01) return
      const power = (1 - dist / 9) * 15
      this.physics.impulse(other, dx / dist * power * other.mass, power * .6 * other.mass, dz / dist * power * other.mass, .65)
      const q = this.byId.get(other.id)
      if (!q) return
      this.touch(q)
      if (SPECS[q.home.kind].explosive && !q.broken && q.fuse < 0) q.fuse = this.time + .12 + dist * .025
    })
  }

  draw(instance: PropInstanceWriter, sprite: SpriteWriter, light: PropLightWriter, focus: { x: number; z: number }, debug: boolean) {
    const drawBody = (b: Body, model: number, scale = 1) => {
      if (!b.enabled || (b.x - focus.x) ** 2 + (b.z - focus.z) ** 2 > 125 ** 2) return
      instance(model, b.x, b.y, b.z, b.yaw, b.roll, b.pitch, scale)
      sprite("a", b.x, this.ground(b.x, b.z) + .022, b.z, Math.max(b.hx, b.hz) * 1.3, 0, 0, 0, .45 / (1 + Math.max(0, b.y - b.hy)), 3)
      if (debug) sprite("d", b.x, this.ground(b.x, b.z) + .04, b.z, b.radius, b.awake ? 1 : .1, b.awake ? .3 : .8, .25, .85, 2)
    }
    for (const p of this.props) drawBody(p.body, p.model)
    for (const c of this.chunks) drawBody(c.body, c.model, c.scale * Math.min(1, c.life))
    for (const r of this.reactions) {
      if ((r.x - focus.x) ** 2 + (r.z - focus.z) ** 2 > 130 ** 2) continue
      if (r.water) {
        sprite("a", r.x, r.y + .028, r.z, Math.min(4, .6 + r.age * .5), .015, .03, .045, Math.min(.55, (22 - r.age) * .1), 3, 0, .8)
      } else {
        sprite("a", r.x, r.y + .027, r.z, 3.6, .015, .011, .008, Math.min(.8, (30 - r.age) * .1), 3)
        if (r.age < .55) sprite("d", r.x, r.y + .04, r.z, .5 + r.age * 20, 1, .58, .19, (1 - r.age / .55) * .85, 2)
        if (r.age < .22) {
          const flash = 1 - r.age / .22
          sprite("d", r.x, r.y + 1, r.z, 1.4 + r.age * 6, 1, .55, .13, flash * 2, 0)
          light(r.x, r.y + 2, r.z, 13, 1, .29, .035, flash * 12)
        }
      }
    }
    this.particles.draw(sprite)
  }

  /** Isolated presentation fixture for deterministic captures, never sent to the server. */
  fixture(kinds: PropKind[] | null, x: number, z: number) {
    this.reset()
    for (const p of this.props) this.physics.remove(p.body)
    this.props.length = 0; this.byId.clear()
    if (!kinds) { for (const p of this.layout) this.add(p); return }
    for (let i = 0; i < kinds.length; i++) this.add({ kind: kinds[i]!, x: x + (i % 2) * 1.25, z: z + i * 2, y: this.ground(x, z + i * 2), yaw: Math.PI / 2 })
  }
}
