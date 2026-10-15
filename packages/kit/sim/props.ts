import type { Rect } from "./geom"
import { type Mass, type Response, STATIC, boxMass, collideShapesXY, orientedShapeXY, rectShapeXY, resolveXY, separateXY } from "./obb"

/**
 * Shoveable top-down props: oriented boxes on the floor plan (x, y, heading h) that slide with friction, spin, collide
 * with walls and each other through the shared OBB solver (`sim/obb`), get shoved by walking bodies, can be lifted,
 * carried and thrown (a ballistic height z), knocked about by blasts, and break or explode. Deterministic: no
 * randomness, fixed dt from the caller. Pure data in and out, so it runs on the server and in client prediction.
 */

export type PropKindDef = {
  /** Half length (along the heading) and half width, metres. */
  hl: number
  hw: number
  /** Height (m), for shadows, throws and what clears it. */
  height: number
  mass: number
  /** Ground friction deceleration, m/s². Ice divides it. */
  friction: number
  /** Hit points; 0 never breaks. */
  hp: number
  /** Blows up when broken: radius (m) and impulse (m/s at the centre). */
  explode?: { radius: number; impulse: number }
  /** Too heavy to lift (still shoves and gets blasted). */
  heavy?: boolean
}

export type Prop = {
  id: number
  kind: string
  x: number
  y: number
  h: number
  vx: number
  vy: number
  w: number
  /** Height above the floor and vertical speed while airborne (thrown or blasted). */
  z: number
  vz: number
  hp: number
  /** Who carries it ("" none); a carried prop ignores physics. */
  held: string
  /** Who last threw or blasted it, for credit when it hits someone. */
  by: string
  /** Seconds left of reduced friction (ice, grease). */
  slick: number
  alive: boolean
}

/** A walking body that shoves props: centre, radius, velocity. Its own velocity is not changed. */
export type Pusher = { x: number; y: number; vx: number; vy: number; radius: number }

export type PropEvent =
  | { k: "prop-hit"; id: number; x: number; y: number; v: number }
  | { k: "prop-break"; id: number; kind: string; x: number; y: number; by: string }
  | { k: "prop-boom"; id: number; x: number; y: number; radius: number; by: string }

const PROP_PROP: Response = { restitution: 0.3, friction: 0.3 }
const PROP_WALL: Response = { restitution: 0.35, friction: 0.25 }
const GRAVITY = 18
const SPIN_DAMP = 3

export class Props {
  readonly list: Prop[] = []
  private next = 0
  private mass = new Map<string, Mass>()

  constructor(readonly kinds: Readonly<Record<string, PropKindDef>>) {
    for (const [k, d] of Object.entries(kinds)) this.mass.set(k, boxMass(d.mass, d.hl * 2, d.hw * 2))
  }

  add(kind: string, x: number, y: number, h = 0): Prop {
    const d = this.kinds[kind]
    if (!d) throw Error(`unknown prop kind ${kind}`)
    const p: Prop = { id: ++this.next, kind, x, y, h, vx: 0, vy: 0, w: 0, z: 0, vz: 0, hp: d.hp, held: "", by: "", slick: 0, alive: true }
    this.list.push(p)
    return p
  }

  get(id: number): Prop | undefined {
    return this.list.find((p) => p.id === id)
  }

  clear(): void {
    this.list.length = 0
  }

  def(p: Prop): PropKindDef {
    return this.kinds[p.kind]!
  }

  /** A shape for solids queries: the prop's axis-aligned bounds (for walking bodies treat it via `push`). */
  bounds(p: Prop): Rect {
    const d = this.def(p)
    const c = Math.abs(Math.cos(p.h)), s = Math.abs(Math.sin(p.h))
    const ex = d.hl * c + d.hw * s, ey = d.hl * s + d.hw * c
    return [p.x - ex, p.y - ey, p.x + ex, p.y + ey]
  }

  /** Adds a velocity change, scaled by the prop's lightness (a 40 kg reference moves by the full impulse). */
  impulse(p: Prop, ix: number, iy: number, lift = 0, by = ""): void {
    if (p.held) return
    const k = Math.min(2, 40 / this.def(p).mass)
    p.vx += ix * k
    p.vy += iy * k
    p.w += (ix * 0.3 - iy * 0.3) * k * 0.5
    if (lift > 0) p.vz = Math.max(p.vz, lift * k)
    if (by) p.by = by
  }

  /** Radial blast: pushes and lifts every prop within `radius`, falling off linearly. */
  blast(x: number, y: number, radius: number, speed: number, by = ""): void {
    for (const p of this.list) {
      if (!p.alive || p.held) continue
      const dx = p.x - x, dy = p.y - y, d = Math.hypot(dx, dy)
      if (d >= radius) continue
      const f = speed * (1 - d / radius)
      this.impulse(p, (dx / (d || 1)) * f, (dy / (d || 1)) * f, f * 0.45, by)
    }
  }

  /** Damages a prop; breaking it may explode (the caller applies the blast to bodies from the event). */
  damage(p: Prop, amount: number, by: string, events: PropEvent[]): void {
    const d = this.def(p)
    if (!p.alive || d.hp <= 0) return
    p.hp -= amount
    if (p.hp > 0) return
    p.alive = false
    p.held = ""
    events.push({ k: "prop-break", id: p.id, kind: p.kind, x: p.x, y: p.y, by })
    if (d.explode) {
      events.push({ k: "prop-boom", id: p.id, x: p.x, y: p.y, radius: d.explode.radius, by })
      this.blast(p.x, p.y, d.explode.radius * 1.6, d.explode.impulse, by)
    }
  }

  /**
   * One tick: carried props follow nothing (the caller places them), airborne props fly and land, grounded props
   * slide with friction, walking bodies shove them, and contacts with walls and other props resolve. `low` walls
   * (ropes, curbs) only stop props flying lower than `lowHeight`.
   */
  step(dt: number, walls: readonly Rect[], pushers: readonly Pusher[], events: PropEvent[], low: readonly Rect[] = [], lowHeight = 0.5): void {
    const list = this.list.filter((p) => p.alive && !p.held)
    for (const p of list) {
      const d = this.def(p)
      if (p.z > 0 || p.vz > 0) {
        p.vz -= GRAVITY * dt
        p.z += p.vz * dt
        if (p.z <= 0) {
          const v = -p.vz
          p.z = 0
          p.vz = v > 3 ? v * 0.3 : 0
          if (v > 3) events.push({ k: "prop-hit", id: p.id, x: p.x, y: p.y, v })
        }
      } else {
        const sp = Math.hypot(p.vx, p.vy)
        if (sp > 0) {
          const fr = d.friction / (p.slick > 0 ? 8 : 1)
          const k = Math.max(0, sp - fr * dt) / sp
          p.vx *= k
          p.vy *= k
        }
        p.w *= Math.exp(-SPIN_DAMP * dt * (p.slick > 0 ? 0.25 : 1))
      }
      p.slick = Math.max(0, p.slick - dt)
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.h += p.w * dt
    }
    // Shoves: a body overlapping a grounded prop moves it out of the way at the body's speed into it.
    for (const b of pushers) {
      for (const p of list) {
        if (p.z > 0.5) continue
        const d = this.def(p)
        if (d.heavy && Math.hypot(b.vx, b.vy) < 1) continue
        const c = collideShapesXY(orientedShapeXY(b.x, b.y, 0, b.radius * 0.85, b.radius * 0.85), orientedShapeXY(p.x, p.y, p.h, d.hl, d.hw))
        if (!c) continue
        const into = b.vx * c.nx + b.vy * c.ny
        const k = Math.min(1, 40 / d.mass) * (d.heavy ? 0.35 : 1)
        const dv = into * k - (p.vx * c.nx + p.vy * c.ny)
        if (into > 0 && dv > 0) {
          p.vx += c.nx * dv
          p.vy += c.ny * dv
        }
        p.x += c.nx * c.depth * 0.5
        p.y += c.ny * c.depth * 0.5
      }
    }
    // Contacts: props against walls (static) and each other. Airborne props clear anything lower than they fly.
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!
      const da = this.def(a)
      const ma = this.mass.get(a.kind)!
      const sa = orientedShapeXY(a.x, a.y, a.h, da.hl, da.hw)
      for (const r of a.z > lowHeight ? walls : low.length ? [...walls, ...low] : walls) {
        if (a.x + 3 < r[0] || a.x - 3 > r[2] || a.y + 3 < r[1] || a.y - 3 > r[3]) continue
        const c = collideShapesXY(sa, rectShapeXY(r))
        if (!c) continue
        const hit = resolveXY(a, ma, null, STATIC, c, PROP_WALL)
        separateXY(a, ma, null, STATIC, c, 0.005)
        if (hit.impact > 3) events.push({ k: "prop-hit", id: a.id, x: hit.x, y: hit.y, v: hit.impact })
        sa.x = a.x
        sa.y = a.y
      }
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!
        if (Math.abs(a.x - b.x) > 3 || Math.abs(a.y - b.y) > 3) continue
        const db = this.def(b)
        if (Math.abs(a.z - b.z) > Math.max(da.height, db.height)) continue
        const c = collideShapesXY(orientedShapeXY(a.x, a.y, a.h, da.hl, da.hw), orientedShapeXY(b.x, b.y, b.h, db.hl, db.hw))
        if (!c) continue
        const mb = this.mass.get(b.kind)!
        const hit = resolveXY(a, ma, b, mb, c, PROP_PROP)
        separateXY(a, ma, b, mb, c, 0.005)
        if (hit.impact > 3) events.push({ k: "prop-hit", id: a.id, x: hit.x, y: hit.y, v: hit.impact })
      }
    }
  }
}
