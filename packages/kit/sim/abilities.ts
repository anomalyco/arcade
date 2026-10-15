import { type Rect, angleDiff, clearLine, pushOut, raycast } from "./geom"
import type { Prop, PropEvent, Props } from "./props"

/**
 * Data-driven, server-authoritative abilities for top-down action games. A character is a list of `AbilityDef`s
 * (wind-up, cooldown, optional channel and recovery, then effects); effects compose melee swings, projectiles, bursts,
 * lingering zones (traps, slicks, smoke), seeking swarms, dashes with trails, grabs and throws, blinks, decoys, swaps
 * and status effects (slow, stun, root, slide, shield, haste). The game owns damage and knockback (`AbilityHost.hit`)
 * and movement; this module owns everything between pressing the key and the hit. Deterministic: no randomness and a
 * fixed dt, so the same inputs replay the same match in the Durable Object, tests and client prediction.
 */

export type StatusKind = "slow" | "stun" | "root" | "slide" | "shield" | "haste"
export type StatusDef = { kind: StatusKind; time: number; amount?: number }
export type Status = { kind: StatusKind; until: number; amount: number; by: string }

/** What a hit does; the host turns it into damage and knockback. `from` picks the knockback origin. */
export type HitDef = { damage: number; knock: number; status?: StatusDef[]; from?: "source" | "caster" }

/** Where an effect starts: the caster, the aim point (clamped to the ability's range), or wherever the parent effect is. */
export type Place = "self" | "aim" | "here"

export type TrailDef = { look: string; radius: number; life: number; every: number; status?: StatusDef[]; slick?: boolean }

export type EffectDef =
  | { kind: "melee"; range: number; arc: number; hit: HitDef; props?: number }
  | {
      kind: "projectile"
      look: string
      speed: number
      radius: number
      range: number
      count?: number
      spread?: number
      /** Arcs to the aim point over everything and lands there (runs `onEnd`). */
      lob?: boolean
      pierce?: boolean
      hit?: HitDef
      /** Impulse (m/s) given to props it strikes. */
      props?: number
      onHit?: EffectDef[]
      onEnd?: EffectDef[]
    }
  | { kind: "burst"; look: string; at?: Place; offset?: number; radius: number; hit: HitDef; props?: number }
  | {
      kind: "zone"
      look: string
      at?: Place
      radius: number
      life: number
      /** Statuses applied (and refreshed) while inside. */
      status?: StatusDef[]
      /** A hit every `every` seconds to anyone inside (not the caster). */
      tick?: HitDef
      every?: number
      /** Disperses swarms. */
      smoke?: boolean
      /** Makes props slide. */
      slick?: boolean
      /** Affects the caster too. */
      self?: boolean
    }
  | { kind: "swarm"; look: string; at?: Place; count: number; speed: number; turn: number; life: number; radius: number; seek: number; hit: HitDef; every: number }
  | { kind: "dash"; speed: number; time: number; hit?: HitDef; props?: number; trail?: TrailDef; then?: EffectDef[] }
  | { kind: "status"; status: StatusDef[] }
  | { kind: "decoy"; life: number }
  /** Only as a projectile's `onHit`: the caster and the struck actor trade places. */
  | { kind: "swap" }
  | { kind: "grab"; range: number; arc: number; hold: number; throwSpeed: number; hit: HitDef }
  | { kind: "blink"; range: number }

export type AbilityDef = {
  id: string
  name: string
  blurb: string
  windup: number
  cooldown: number
  /** Repeats the effects every `every` seconds for `time` after the wind-up. */
  channel?: { time: number; every: number }
  /** Locked out after the release (and channel). */
  recover?: number
  /** Movement speed scale while winding up, channelling and recovering (default 0.45). */
  moveScale?: number
  /** Aim point distance clamp. */
  range?: number
  effects: EffectDef[]
  /** For bots: use at roughly this distance to a target. */
  botRange?: number
}

export type Cast = { slot: number; at: number; release: number; end: number; ax: number; ay: number; ticks: number }
export type Dash = { vx: number; vy: number; until: number; def: Extract<EffectDef, { kind: "dash" }>; struck: string[]; trailAt: number; slot: number }
export type Carry = { kind: "actor" | "prop"; id: string; until: number; def: Extract<EffectDef, { kind: "grab" }> }

/** Per-actor ability state; create with `abilityState(slots)`. */
export type AbilityState = { ready: number[]; cast: Cast | null; status: Status[]; dash: Dash | null; carry: Carry | null; carriedBy: string }

export const abilityState = (slots: number): AbilityState => ({ ready: new Array(slots).fill(0), cast: null, status: [], dash: null, carry: null, carriedBy: "" })

function cloneHitDef(h: HitDef): HitDef {
  return {
    ...h,
    ...(h.status ? { status: h.status.map((s) => ({ ...s })) } : {}),
  }
}

function cloneTrailDef(t: TrailDef): TrailDef {
  return {
    ...t,
    ...(t.status ? { status: t.status.map((s) => ({ ...s })) } : {}),
  }
}

export function cloneEffectDef<E extends EffectDef>(e: E): E {
  switch (e.kind) {
    case "melee":
    case "burst":
    case "swarm":
    case "grab":
      return { ...e, hit: cloneHitDef(e.hit) }
    case "projectile":
      return {
        ...e,
        ...(e.hit ? { hit: cloneHitDef(e.hit) } : {}),
        ...(e.onHit ? { onHit: e.onHit.map((x) => cloneEffectDef(x)) } : {}),
        ...(e.onEnd ? { onEnd: e.onEnd.map((x) => cloneEffectDef(x)) } : {}),
      }
    case "zone":
      return {
        ...e,
        ...(e.status ? { status: e.status.map((s) => ({ ...s })) } : {}),
        ...(e.tick ? { tick: cloneHitDef(e.tick) } : {}),
      }
    case "dash":
      return {
        ...e,
        ...(e.hit ? { hit: cloneHitDef(e.hit) } : {}),
        ...(e.trail ? { trail: cloneTrailDef(e.trail) } : {}),
        ...(e.then ? { then: e.then.map((x) => cloneEffectDef(x)) } : {}),
      }
    case "status":
      return { ...e, status: e.status.map((s) => ({ ...s })) }
    case "decoy":
    case "swap":
    case "blink":
      return { ...e }
  }
}

export function cloneAbilityState(ab: AbilityState): AbilityState {
  return {
    ready: [...ab.ready],
    cast: ab.cast ? { ...ab.cast } : null,
    status: ab.status.map((s) => ({ ...s })),
    dash: ab.dash ? { ...ab.dash, def: cloneEffectDef(ab.dash.def), struck: [...ab.dash.struck] } : null,
    carry: ab.carry ? { ...ab.carry, def: cloneEffectDef(ab.carry.def) } : null,
    carriedBy: ab.carriedBy,
  }
}

export type AbilitiesSnapshot = {
  next: number
  projectiles: Projectile[]
  swarms: Swarm[]
  zones: Zone[]
  decoys: Decoy[]
  events: AbilityEvent[]
}

export interface AbilityActor {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  alive: boolean
  radius: number
  ab: AbilityState
}

export type Projectile = { id: number; look: string; by: string; slot: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; left: number; t: number; def: Extract<EffectDef, { kind: "projectile" }>; struck: string[] }
export type Swarm = { id: number; look: string; by: string; x: number; y: number; vx: number; vy: number; count: number; full: number; end: number; target: string; nextHit: number; scatter: boolean; def: Extract<EffectDef, { kind: "swarm" }> }
export type Zone = { id: number; look: string; by: string; x: number; y: number; radius: number; born: number; end: number; nextTick: number; def: Extract<EffectDef, { kind: "zone" }> }
export type Decoy = { id: number; by: string; x: number; y: number; aim: number; end: number }

export type AbilityEvent =
  | { k: "cast"; by: string; slot: number; x: number; y: number; ax: number; ay: number }
  | { k: "release"; by: string; slot: number; x: number; y: number }
  | { k: "burst"; by: string; look: string; x: number; y: number; r: number }
  | { k: "melee"; by: string; x: number; y: number; aim: number; range: number }
  | { k: "proj-end"; id: number; look: string; x: number; y: number; hit: boolean }
  | { k: "swap"; a: string; b: string }
  | { k: "blink"; by: string; x0: number; y0: number; x1: number; y1: number }
  | { k: "grab"; by: string; target: string; kind: "actor" | "prop" }
  | { k: "throw"; by: string; target: string; kind: "actor" | "prop" }
  | { k: "pop"; id: number; x: number; y: number }
  | { k: "scatter"; id: number; x: number; y: number }
  | { k: "ab-hit"; by: string; target: string; x: number; y: number; damage: number }
  | PropEvent

export interface AbilityHost<A extends AbilityActor> {
  readonly time: number
  readonly dt: number
  /** What stops projectiles and swarms (and bodies, unless `bodySolids` says otherwise). */
  readonly solids: readonly Rect[]
  /** What stops dashing, blinking and thrown bodies: add ropes or curbs that projectiles fly over. */
  readonly bodySolids?: readonly Rect[]
  readonly actors: Iterable<A>
  readonly props: Props | null
  abilities(a: A): readonly AbilityDef[]
  /** Damage and knockback. Knockback points from (fromX, fromY) to the target. `scale` weakens swarm stings. */
  hit(target: A, hit: HitDef, by: A | null, fromX: number, fromY: number, scale: number): void
  /** Whether `a` may hurt `b` (default: anyone else). */
  hostile?(a: A, b: A): boolean
  /** Whether `a` can be hit at all right now (respawn invulnerability, falling off the stage). */
  targetable?(a: A): boolean
}

const has = (a: AbilityActor, kind: StatusKind, now: number) => a.ab.status.some((s) => s.kind === kind && s.until > now)
const amount = (a: AbilityActor, kind: StatusKind, now: number) => a.ab.status.reduce((m, s) => (s.kind === kind && s.until > now ? Math.max(m, s.amount) : m), 0)

/** How statuses and casting change movement this tick. */
export function movement(a: AbilityActor, defs: readonly AbilityDef[], now: number): { speed: number; accel: number; canMove: boolean; canCast: boolean } {
  const stunned = has(a, "stun", now) || !!a.ab.carriedBy
  const rooted = has(a, "root", now)
  const cast = a.ab.cast
  const castScale = cast && now < cast.end ? (defs[cast.slot]?.moveScale ?? 0.68) : 1
  const speed = (1 - amount(a, "slow", now)) * (1 + amount(a, "haste", now)) * castScale
  const accel = has(a, "slide", now) ? 0.12 : 1
  return { speed, accel, canMove: !stunned && !rooted && !a.ab.dash, canCast: !stunned && !a.ab.dash && !a.ab.carry && !(cast && now < cast.end) }
}

/** Damage and knockback multiplier from shields. */
export const shieldScale = (a: AbilityActor, now: number) => 1 - amount(a, "shield", now)

export function applyStatus(a: AbilityActor, list: readonly StatusDef[] | undefined, now: number, by: string): void {
  for (const s of list ?? []) {
    const old = a.ab.status.find((o) => o.kind === s.kind)
    const until = now + s.time
    if (old) {
      old.until = Math.max(old.until, until)
      old.amount = Math.max(old.until > now ? old.amount : 0, s.amount ?? 1)
      old.by = by
    } else a.ab.status.push({ kind: s.kind, until, amount: s.amount ?? 1, by })
  }
}

type Ctx = { x: number; y: number; ax: number; ay: number; aim: number; slot: number; target?: AbilityActor }

/** All live ability entities in a match, and the rules that move them. */
export class Abilities<A extends AbilityActor> {
  projectiles: Projectile[] = []
  swarms: Swarm[] = []
  zones: Zone[] = []
  decoys: Decoy[] = []
  events: AbilityEvent[] = []
  private next = 0

  constructor(private host: AbilityHost<A>) {}

  clear(): void {
    this.projectiles = []
    this.swarms = []
    this.zones = []
    this.decoys = []
  }

  toSnapshot(): AbilitiesSnapshot {
    return {
      next: this.next,
      projectiles: this.projectiles.map((p) => ({ ...p, def: cloneEffectDef(p.def), struck: [...p.struck] })),
      swarms: this.swarms.map((s) => ({ ...s, def: cloneEffectDef(s.def) })),
      zones: this.zones.map((z) => ({ ...z, def: cloneEffectDef(z.def) })),
      decoys: this.decoys.map((d) => ({ ...d })),
      events: this.events.map((e) => ({ ...e })),
    }
  }

  restoreSnapshot(snap: AbilitiesSnapshot): void {
    this.next = snap.next
    this.projectiles = snap.projectiles.map((p) => ({ ...p, def: cloneEffectDef(p.def), struck: [...p.struck] }))
    this.swarms = snap.swarms.map((s) => ({ ...s, def: cloneEffectDef(s.def) }))
    this.zones = snap.zones.map((z) => ({ ...z, def: cloneEffectDef(z.def) }))
    this.decoys = snap.decoys.map((d) => ({ ...d }))
    this.events = snap.events.map((e) => ({ ...e }))
  }

  /** Drops everything an actor owns or holds (they left or were knocked out). */
  forget(a: A): void {
    this.release(a)
    a.ab.cast = null
    a.ab.dash = null
    a.ab.status = []
    for (const o of this.host.actors) if (o.ab.carry?.id === a.id) this.drop(o)
    this.decoys = this.decoys.filter((d) => d.by !== a.id)
  }

  private get now() {
    return this.host.time
  }

  private hostile(a: A, b: A): boolean {
    return a !== b && b.alive && !b.ab.carriedBy && (this.host.targetable?.(b) ?? true) && (this.host.hostile?.(a, b) ?? true)
  }

  private actor(id: string): A | undefined {
    for (const a of this.host.actors) if (a.id === id) return a
    return undefined
  }

  /** Starts slot `slot` aimed at (ax, ay) if it's ready and the actor can act. Returns whether it started. */
  cast(a: A, slot: number, ax: number, ay: number): boolean {
    const defs = this.host.abilities(a)
    const def = defs[slot]
    const now = this.now
    if (!def || !a.alive || now < (a.ab.ready[slot] ?? 0) || !movement(a, defs, now).canCast) return false
    const range = def.range ?? 1e9
    const dx = ax - a.x, dy = ay - a.y, d = Math.hypot(dx, dy)
    if (d > range) {
      ax = a.x + (dx / d) * range
      ay = a.y + (dy / d) * range
    }
    const release = now + def.windup
    const end = release + (def.channel?.time ?? 0) + (def.recover ?? 0)
    a.ab.cast = { slot, at: now, release, end, ax, ay, ticks: 0 }
    a.ab.ready[slot] = now + def.cooldown
    if (d > 0.05) a.aim = Math.atan2(dy, dx)
    this.events.push({ k: "cast", by: a.id, slot, x: a.x, y: a.y, ax, ay })
    return true
  }

  /** One tick for one actor: wind-ups release, channels repeat, dashes move, carried things follow. Call after movement. */
  stepActor(a: A): void {
    const now = this.now
    a.ab.status = a.ab.status.filter((s) => s.until > now)
    if (!a.alive) return
    const c = a.ab.cast
    if (c) {
      const def = this.host.abilities(a)[c.slot]!
      const ch = def.channel
      if (has(a, "stun", now) && now < c.release) a.ab.cast = null
      else if (now >= c.release) {
        const due = ch ? Math.min(Math.floor((now - c.release) / ch.every) + 1, Math.ceil(ch.time / ch.every)) : 1
        while (c.ticks < due) {
          if (c.ticks === 0) this.events.push({ k: "release", by: a.id, slot: c.slot, x: a.x, y: a.y })
          c.ticks++
          this.run(def.effects, a, { x: a.x, y: a.y, ax: c.ax, ay: c.ay, aim: Math.atan2(c.ay - a.y, c.ax - a.x), slot: c.slot })
        }
        if (now >= c.end) a.ab.cast = null
      }
    }
    this.stepDash(a)
    this.stepCarry(a)
  }

  private run(effects: readonly EffectDef[], a: A, ctx: Ctx): void {
    for (const e of effects) this.effect(e, a, ctx)
  }

  private place(at: Place | undefined, a: A, ctx: Ctx, offset = 0): { x: number; y: number } {
    if (at === "aim") return this.reach(ctx.x, ctx.y, ctx.ax, ctx.ay, 0.3)
    if (at === "here") return { x: ctx.x, y: ctx.y }
    if (offset) return this.reach(a.x, a.y, a.x + Math.cos(ctx.aim) * offset, a.y + Math.sin(ctx.aim) * offset, 0.3)
    return { x: a.x, y: a.y }
  }

  private get bodySolids(): readonly Rect[] {
    return this.host.bodySolids ?? this.host.solids
  }

  /** The farthest point toward (bx, by) a wall allows, kept `pad` short of it. */
  private reach(ax: number, ay: number, bx: number, by: number, pad: number, walls = this.host.solids): { x: number; y: number } {
    const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy)
    if (d < 1e-6) return { x: ax, y: ay }
    const t = Math.min(d, Math.max(0, raycast(ax, ay, dx / d, dy / d, walls, d + pad) - pad))
    return { x: ax + (dx / d) * t, y: ay + (dy / d) * t }
  }

  private reachBody(ax: number, ay: number, bx: number, by: number, pad: number): { x: number; y: number } {
    return this.reach(ax, ay, bx, by, pad, this.bodySolids)
  }

  private strike(target: A, hit: HitDef | undefined, by: A, fx: number, fy: number, scale = 1): void {
    if (!hit) return
    const from = hit.from === "caster" ? by : { x: fx, y: fy }
    this.host.hit(target, hit, by, from.x, from.y, scale)
    applyStatus(target, hit.status, this.now, by.id)
    this.events.push({ k: "ab-hit", by: by.id, target: target.id, x: target.x, y: target.y, damage: hit.damage * scale })
  }

  private shove(p: Prop, ix: number, iy: number, by: string, lift = 0): void {
    const props = this.host.props
    if (props && ix * ix + iy * iy > 0) props.impulse(p, ix, iy, lift, by)
  }

  private effect(e: EffectDef, a: A, ctx: Ctx): void {
    const now = this.now
    switch (e.kind) {
      case "melee": {
        const dirX = Math.cos(ctx.aim), dirY = Math.sin(ctx.aim)
        this.events.push({ k: "melee", by: a.id, x: a.x, y: a.y, aim: ctx.aim, range: e.range })
        for (const q of this.host.actors) {
          if (!this.hostile(a, q)) continue
          const d = Math.hypot(q.x - a.x, q.y - a.y)
          if (d > e.range + q.radius || Math.abs(angleDiff(Math.atan2(q.y - a.y, q.x - a.x), ctx.aim)) > e.arc / 2 + (d < 0.6 ? Math.PI : 0)) continue
          if (!clearLine(a.x, a.y, q.x, q.y, this.host.solids)) continue
          this.strike(q, e.hit, a, a.x, a.y)
        }
        this.popDecoys(a, a.x + dirX * e.range * 0.6, a.y + dirY * e.range * 0.6, e.range * 0.6)
        for (const p of this.host.props?.list ?? []) {
          if (!p.alive || p.held) continue
          const d = Math.hypot(p.x - a.x, p.y - a.y)
          if (d > e.range + 0.4 || Math.abs(angleDiff(Math.atan2(p.y - a.y, p.x - a.x), ctx.aim)) > e.arc / 2) continue
          this.shove(p, dirX * (e.props ?? e.hit.knock * 0.8), dirY * (e.props ?? e.hit.knock * 0.8), a.id)
          this.host.props!.damage(p, e.hit.damage, a.id, this.events as PropEvent[])
        }
        return
      }
      case "projectile": {
        const n = e.count ?? 1
        for (let i = 0; i < n; i++) {
          const ang = ctx.aim + (n > 1 ? ((i / (n - 1)) - 0.5) * 2 * (e.spread ?? 0.15) : 0)
          const lead = e.lob ? 0 : 0.4
          const dist = e.lob ? Math.min(e.range, Math.hypot(ctx.ax - ctx.x, ctx.ay - ctx.y)) : e.range
          const t = dist / e.speed
          this.projectiles.push({
            id: ++this.next, look: e.look, by: a.id, slot: ctx.slot, x: ctx.x + Math.cos(ang) * lead, y: ctx.y + Math.sin(ang) * lead, z: e.lob ? 1.2 : 1,
            vx: Math.cos(ang) * e.speed, vy: Math.sin(ang) * e.speed, vz: e.lob ? (9 * t) / 2 - 1.2 / Math.max(t, 0.05) : 0, left: dist, t: 0, def: e, struck: [],
          })
        }
        return
      }
      case "burst": {
        const at = this.place(e.at, a, ctx, e.offset)
        this.events.push({ k: "burst", by: a.id, look: e.look, x: at.x, y: at.y, r: e.radius })
        for (const q of this.host.actors) {
          if (!this.hostile(a, q) || Math.hypot(q.x - at.x, q.y - at.y) > e.radius + q.radius) continue
          if (!clearLine(at.x, at.y, q.x, q.y, this.host.solids)) continue
          this.strike(q, e.hit, a, at.x, at.y)
        }
        this.popDecoys(a, at.x, at.y, e.radius)
        if (e.props) this.host.props?.blast(at.x, at.y, e.radius + 0.6, e.props, a.id)
        for (const p of this.host.props?.list ?? []) if (p.alive && Math.hypot(p.x - at.x, p.y - at.y) < e.radius) this.host.props!.damage(p, e.hit.damage, a.id, this.events as PropEvent[])
        return
      }
      case "zone": {
        const at = this.place(e.at, a, ctx)
        this.zones.push({ id: ++this.next, look: e.look, by: a.id, x: at.x, y: at.y, radius: e.radius, born: now, end: now + e.life, nextTick: now, def: e })
        if (this.zones.length > 96) this.zones.shift()
        return
      }
      case "swarm": {
        const at = this.place(e.at, a, ctx)
        this.swarms.push({ id: ++this.next, look: e.look, by: a.id, x: at.x + Math.cos(ctx.aim) * 0.6, y: at.y + Math.sin(ctx.aim) * 0.6, vx: Math.cos(ctx.aim) * e.speed, vy: Math.sin(ctx.aim) * e.speed, count: e.count, full: e.count, end: now + e.life, target: "", nextHit: now + 0.3, scatter: false, def: e })
        return
      }
      case "dash": {
        const dx = Math.cos(ctx.aim), dy = Math.sin(ctx.aim)
        a.ab.dash = { vx: dx * e.speed, vy: dy * e.speed, until: now + e.time, def: e, struck: [], trailAt: now, slot: ctx.slot }
        a.vx = dx * e.speed
        a.vy = dy * e.speed
        return
      }
      case "status":
        applyStatus(a, e.status, now, a.id)
        return
      case "decoy":
        this.decoys = this.decoys.filter((d) => d.by !== a.id)
        this.decoys.push({ id: ++this.next, by: a.id, x: a.x, y: a.y, aim: a.aim, end: now + e.life })
        return
      case "swap": {
        const b = ctx.target
        if (!b || b === a || !b.alive) return
        const ax = a.x, ay = a.y
        a.x = b.x
        a.y = b.y
        b.x = ax
        b.y = ay
        a.vx = a.vy = b.vx = b.vy = 0
        this.events.push({ k: "swap", a: a.id, b: b.id })
        return
      }
      case "blink": {
        const to = this.reachBody(a.x, a.y, a.x + Math.cos(ctx.aim) * Math.min(e.range, Math.hypot(ctx.ax - a.x, ctx.ay - a.y) || e.range), a.y + Math.sin(ctx.aim) * Math.min(e.range, Math.hypot(ctx.ax - a.x, ctx.ay - a.y) || e.range), a.radius + 0.05)
        this.events.push({ k: "blink", by: a.id, x0: a.x, y0: a.y, x1: to.x, y1: to.y })
        a.x = to.x
        a.y = to.y
        pushOut(a, a.radius, this.bodySolids)
        return
      }
      case "grab": {
        let best: { kind: "actor" | "prop"; id: string; d: number } | null = null
        for (const q of this.host.actors) {
          if (!this.hostile(a, q)) continue
          const d = Math.hypot(q.x - a.x, q.y - a.y)
          if (d > e.range + q.radius || Math.abs(angleDiff(Math.atan2(q.y - a.y, q.x - a.x), ctx.aim)) > e.arc / 2 + (d < 0.7 ? Math.PI : 0)) continue
          if (!best || d < best.d) best = { kind: "actor", id: q.id, d }
        }
        for (const p of this.host.props?.list ?? []) {
          if (!p.alive || p.held || p.z > 0.5 || this.host.props!.def(p).heavy) continue
          const d = Math.hypot(p.x - a.x, p.y - a.y) - 0.3
          if (d > e.range || Math.abs(angleDiff(Math.atan2(p.y - a.y, p.x - a.x), ctx.aim)) > e.arc / 2) continue
          if (!best || d < best.d - 0.4) best = { kind: "prop", id: String(p.id), d }
        }
        if (!best) return
        a.ab.carry = { kind: best.kind, id: best.id, until: now + e.hold, def: e }
        if (best.kind === "actor") {
          const q = this.actor(best.id)!
          q.ab.carriedBy = a.id
          q.ab.cast = null
          q.ab.dash = null
        } else this.host.props!.get(Number(best.id))!.held = a.id
        this.events.push({ k: "grab", by: a.id, target: best.id, kind: best.kind })
        return
      }
    }
  }

  private popDecoys(a: A, x: number, y: number, r: number): void {
    for (const d of [...this.decoys]) {
      if (d.by === a.id || Math.hypot(d.x - x, d.y - y) > r + 0.4) continue
      this.decoys = this.decoys.filter((o) => o !== d)
      this.events.push({ k: "pop", id: d.id, x: d.x, y: d.y })
    }
  }

  private stepDash(a: A): void {
    const d = a.ab.dash
    if (!d) return
    const now = this.now
    const dt = this.host.dt
    const sp = Math.hypot(d.vx, d.vy)
    const ahead = raycast(a.x, a.y, d.vx / sp, d.vy / sp, this.bodySolids, sp * dt + a.radius)
    const step = Math.max(0, Math.min(sp * dt, ahead - a.radius))
    a.x += (d.vx / sp) * step
    a.y += (d.vy / sp) * step
    a.vx = d.vx
    a.vy = d.vy
    pushOut(a, a.radius, this.bodySolids)
    for (const q of this.host.actors) {
      if (!this.hostile(a, q) || d.struck.includes(q.id) || Math.hypot(q.x - a.x, q.y - a.y) > a.radius + q.radius + 0.15) continue
      d.struck.push(q.id)
      this.strike(q, d.def.hit, a, a.x - d.vx * 0.05, a.y - d.vy * 0.05)
    }
    if (d.def.props) for (const p of this.host.props?.list ?? []) {
      if (!p.alive || p.held || p.z > 0.5 || Math.hypot(p.x - a.x, p.y - a.y) > a.radius + 0.55) continue
      this.shove(p, (d.vx / sp) * d.def.props, (d.vy / sp) * d.def.props, a.id, d.def.props * 0.15)
    }
    const t = d.def.trail
    if (t && now >= d.trailAt) {
      d.trailAt = now + t.every
      this.zones.push({ id: ++this.next, look: t.look, by: a.id, x: a.x, y: a.y, radius: t.radius, born: now, end: now + t.life, nextTick: now, def: { kind: "zone", look: t.look, radius: t.radius, life: t.life, status: t.status, slick: t.slick } })
      if (this.zones.length > 96) this.zones.shift()
    }
    if (now >= d.until || ahead < a.radius + 0.02) {
      a.ab.dash = null
      a.vx *= 0.3
      a.vy *= 0.3
      if (d.def.then) this.run(d.def.then, a, { x: a.x, y: a.y, ax: a.x + d.vx, ay: a.y + d.vy, aim: Math.atan2(d.vy, d.vx), slot: d.slot })
    }
  }

  /** Where a carried thing sits: in front of the carrier, overhead. */
  private stepCarry(a: A): void {
    const c = a.ab.carry
    if (!c) return
    const x = a.x + Math.cos(a.aim) * 0.35
    const y = a.y + Math.sin(a.aim) * 0.35
    if (c.kind === "actor") {
      const q = this.actor(c.id)
      if (!q || !q.alive) return void (a.ab.carry = null)
      q.x = x
      q.y = y
      q.vx = a.vx
      q.vy = a.vy
    } else {
      const p = this.host.props?.get(Number(c.id))
      if (!p || !p.alive) return void (a.ab.carry = null)
      p.x = x
      p.y = y
      p.z = 1.5
      p.vx = p.vy = p.vz = 0
      p.h = a.aim
    }
    if (this.now >= c.until || has(a, "stun", this.now)) this.throw(a)
  }

  /** Throws what an actor carries along its aim. */
  throw(a: A): void {
    const c = a.ab.carry
    if (!c) return
    a.ab.carry = null
    const dx = Math.cos(a.aim), dy = Math.sin(a.aim)
    this.events.push({ k: "throw", by: a.id, target: c.id, kind: c.kind })
    if (c.kind === "actor") {
      const q = this.actor(c.id)
      if (!q) return
      q.ab.carriedBy = ""
      q.x = a.x + dx * (a.radius + q.radius + 0.1)
      q.y = a.y + dy * (a.radius + q.radius + 0.1)
      pushOut(q, q.radius, this.bodySolids)
      this.strike(q, c.def.hit, a, a.x, a.y)
    } else {
      const p = this.host.props?.get(Number(c.id))
      if (!p) return
      p.held = ""
      p.x = a.x + dx * 0.9
      p.y = a.y + dy * 0.9
      p.vx = dx * c.def.throwSpeed
      p.vy = dy * c.def.throwSpeed
      p.vz = 3
      p.w = 4
      p.by = a.id
    }
  }

  /** Lets go without a throw (the carrier was knocked out). */
  private drop(a: A): void {
    const c = a.ab.carry
    if (!c) return
    a.ab.carry = null
    if (c.kind === "actor") {
      const q = this.actor(c.id)
      if (q) q.ab.carriedBy = ""
    } else {
      const p = this.host.props?.get(Number(c.id))
      if (p) p.held = ""
    }
  }

  private release(a: A): void {
    this.drop(a)
    if (a.ab.carriedBy) {
      const by = this.actor(a.ab.carriedBy)
      if (by?.ab.carry?.id === a.id) by.ab.carry = null
      a.ab.carriedBy = ""
    }
  }

  /** One tick for every projectile, swarm, zone and decoy, and for props flying into people. Call after `stepActor`. */
  step(): void {
    const now = this.now
    const dt = this.host.dt
    this.stepProjectiles(dt)
    this.stepSwarms(dt, now)
    this.stepZones(now)
    for (const d of this.decoys) if (now >= d.end) this.events.push({ k: "pop", id: d.id, x: d.x, y: d.y })
    this.decoys = this.decoys.filter((d) => now < d.end)
    this.propImpacts()
  }

  private stepProjectiles(dt: number): void {
    for (const p of [...this.projectiles]) {
      const by = this.actor(p.by) ?? null
      const sp = Math.hypot(p.vx, p.vy)
      const move = Math.min(sp * dt, p.left)
      p.t += dt
      let end = false
      let struck: A | null = null
      if (p.def.lob) {
        p.x += (p.vx / sp) * move
        p.y += (p.vy / sp) * move
        p.vz -= 9 * dt
        p.z = Math.max(0, p.z + p.vz * dt)
        p.left -= move
        if (p.left <= 1e-6) end = true
      } else {
        const wall = raycast(p.x, p.y, p.vx / sp, p.vy / sp, this.host.solids, move + p.def.radius * 0.5)
        const step = Math.min(move, wall)
        // Swept hits against actors along this tick's segment.
        let best = step
        for (const q of this.host.actors) {
          if (!by || !this.hostile(by, q) || p.struck.includes(q.id)) continue
          const t = (q.x - p.x) * (p.vx / sp) + (q.y - p.y) * (p.vy / sp)
          const off = Math.abs(-(q.x - p.x) * (p.vy / sp) + (q.y - p.y) * (p.vx / sp))
          if (t >= -q.radius && t <= best + q.radius && off <= q.radius + p.def.radius) {
            if (p.def.pierce) {
              p.struck.push(q.id)
              this.strike(q, p.def.hit, by, p.x, p.y)
              for (const e of p.def.onHit ?? []) this.effect(e, by, { x: q.x, y: q.y, ax: q.x, ay: q.y, aim: Math.atan2(p.vy, p.vx), slot: p.slot, target: q })
            } else if (!struck || t < best) {
              struck = q
              best = Math.max(0, t)
            }
          }
        }
        for (const d of this.decoys) {
          if (d.by === p.by) continue
          const t = (d.x - p.x) * (p.vx / sp) + (d.y - p.y) * (p.vy / sp)
          const off = Math.abs(-(d.x - p.x) * (p.vy / sp) + (d.y - p.y) * (p.vx / sp))
          if (t >= -0.3 && t <= best + 0.3 && off <= 0.35 + p.def.radius) {
            this.decoys = this.decoys.filter((o) => o !== d)
            this.events.push({ k: "pop", id: d.id, x: d.x, y: d.y })
            best = Math.max(0, t)
            end = !p.def.pierce
            break
          }
        }
        p.x += (p.vx / sp) * best
        p.y += (p.vy / sp) * best
        p.left -= best
        if (!end && !struck) {
          for (const pr of this.host.props?.list ?? []) {
            if (!pr.alive || pr.held || pr.z > 1.2) continue
            const b = this.host.props!.bounds(pr)
            if (p.x < b[0] - p.def.radius || p.x > b[2] + p.def.radius || p.y < b[1] - p.def.radius || p.y > b[3] + p.def.radius) continue
            this.shove(pr, (p.vx / sp) * (p.def.props ?? 3), (p.vy / sp) * (p.def.props ?? 3), p.by)
            this.host.props!.damage(pr, p.def.hit?.damage ?? 0, p.by, this.events as PropEvent[])
            end = !p.def.pierce
            break
          }
        }
        if (struck && by) {
          this.strike(struck, p.def.hit, by, p.x - p.vx * 0.02, p.y - p.vy * 0.02)
          for (const e of p.def.onHit ?? []) this.effect(e, by, { x: p.x, y: p.y, ax: p.x, ay: p.y, aim: Math.atan2(p.vy, p.vx), slot: p.slot, target: struck })
          end = true
        }
        if (wall <= move + p.def.radius * 0.5 && best >= step - 1e-6) end = true
        if (p.left <= 1e-6) end = true
      }
      if (!end) continue
      this.projectiles = this.projectiles.filter((o) => o !== p)
      this.events.push({ k: "proj-end", id: p.id, look: p.look, x: p.x, y: p.y, hit: !!struck })
      if (by && p.def.onEnd) this.run(p.def.onEnd, by, { x: p.x, y: p.y, ax: p.x, ay: p.y, aim: Math.atan2(p.vy, p.vx), slot: p.slot })
    }
  }

  private stepSwarms(dt: number, now: number): void {
    for (const s of [...this.swarms]) {
      const by = this.actor(s.by) ?? null
      const e = s.def
      // Seek the nearest foe (or a decoy, which swarms can't tell apart) within reach; keep the lock while it lasts.
      let tx = NaN, ty = NaN
      let best = e.seek
      let target = ""
      for (const q of this.host.actors) {
        if (!by || !this.hostile(by, q)) continue
        const d = Math.hypot(q.x - s.x, q.y - s.y) * (q.id === s.target ? 0.7 : 1)
        if (d < best) {
          best = d
          tx = q.x
          ty = q.y
          target = q.id
        }
      }
      for (const d of this.decoys) {
        if (d.by === s.by) continue
        const dd = Math.hypot(d.x - s.x, d.y - s.y) * 0.8
        if (dd < best) {
          best = dd
          tx = d.x
          ty = d.y
          target = `decoy${d.id}`
        }
      }
      s.target = target
      const sp = Math.hypot(s.vx, s.vy) || 1
      let want = Math.atan2(s.vy, s.vx)
      if (target) want = Math.atan2(ty - s.y, tx - s.x)
      // Smoke scatters the swarm: it turns away and loses bees fast.
      let smoked = false
      for (const z of this.zones) {
        if (!z.def.smoke || Math.hypot(z.x - s.x, z.y - s.y) > z.radius + e.radius) continue
        smoked = true
        want = Math.atan2(s.y - z.y, s.x - z.x)
      }
      const cur = Math.atan2(s.vy, s.vx)
      let heading = cur + Math.max(-e.turn * dt, Math.min(e.turn * dt, angleDiff(want, cur)))
      // Feel ahead for walls and slide along them.
      if (raycast(s.x, s.y, Math.cos(heading), Math.sin(heading), this.host.solids, 0.9) < 0.8) {
        const l = heading + 0.9, r = heading - 0.9
        heading = raycast(s.x, s.y, Math.cos(l), Math.sin(l), this.host.solids, 1.2) > raycast(s.x, s.y, Math.cos(r), Math.sin(r), this.host.solids, 1.2) ? l : r
      }
      const speed = e.speed * (target && best < 1 ? 0.6 : 1)
      s.vx = Math.cos(heading) * speed
      s.vy = Math.sin(heading) * speed
      const step = Math.min(speed * dt, raycast(s.x, s.y, s.vx / sp, s.vy / sp, this.host.solids, speed * dt + 0.2) - 0.2)
      s.x += Math.cos(heading) * Math.max(0, step)
      s.y += Math.sin(heading) * Math.max(0, step)
      // Once smoked, the swarm keeps breaking up even after it flees the cloud.
      if (smoked) s.scatter = true
      if (s.scatter) {
        s.count = Math.max(0, s.count - s.full * dt * 1.6)
        if (s.count <= 0.5) this.events.push({ k: "scatter", id: s.id, x: s.x, y: s.y })
      }
      if (now >= s.nextHit && by) {
        s.nextHit = now + e.every
        for (const q of this.host.actors) {
          if (!this.hostile(by, q) || Math.hypot(q.x - s.x, q.y - s.y) > e.radius + q.radius) continue
          this.strike(q, e.hit, by, s.x - s.vx * 0.1, s.y - s.vy * 0.1, s.count / s.full)
        }
        for (const d of [...this.decoys]) if (d.by !== s.by && Math.hypot(d.x - s.x, d.y - s.y) < e.radius) this.popDecoys(by, d.x, d.y, 0.1)
      }
      if (now >= s.end || s.count <= 0.5 || !by) this.swarms = this.swarms.filter((o) => o !== s)
    }
  }

  private stepZones(now: number): void {
    this.zones = this.zones.filter((z) => now < z.end)
    for (const z of this.zones) {
      const by = this.actor(z.by) ?? null
      for (const q of this.host.actors) {
        if (!q.alive || q.ab.carriedBy || Math.hypot(q.x - z.x, q.y - z.y) > z.radius + q.radius * 0.5) continue
        if (q.id === z.by ? !z.def.self : by ? !this.hostile(by, q) && !z.def.self : false) continue
        applyStatus(q, z.def.status, now, z.by)
        if (z.def.tick && by && now >= z.nextTick && q.id !== z.by) this.strike(q, z.def.tick, by, z.x, z.y)
      }
      if (z.def.tick && now >= z.nextTick) z.nextTick = now + (z.def.every ?? 0.5)
      if (z.def.slick) for (const p of this.host.props?.list ?? []) if (p.alive && Math.hypot(p.x - z.x, p.y - z.y) < z.radius + 0.3) p.slick = Math.max(p.slick, 0.3)
    }
  }

  /** Thrown, blasted or sliding props hurt whoever they fly into, credited to whoever sent them. */
  private propImpacts(): void {
    const props = this.host.props
    if (!props) return
    for (const p of props.list) {
      if (!p.alive || p.held) continue
      const sp = Math.hypot(p.vx, p.vy)
      if (sp < 6) continue
      const d = props.def(p)
      for (const q of this.host.actors) {
        if (!q.alive || q.ab.carriedBy || q.id === p.by || !(this.host.targetable?.(q) ?? true)) continue
        if (Math.hypot(q.x - p.x, q.y - p.y) > q.radius + Math.max(d.hl, d.hw) * 0.9 || p.z > 1.8) continue
        const by = this.actor(p.by) ?? null
        const dmg = Math.min(20, sp * 0.9) * Math.min(1.5, d.mass / 40)
        this.host.hit(q, { damage: dmg, knock: sp * 0.9 }, by, p.x - p.vx * 0.05, p.y - p.vy * 0.05, 1)
        this.events.push({ k: "ab-hit", by: p.by, target: q.id, x: q.x, y: q.y, damage: dmg })
        p.vx *= -0.25
        p.vy *= -0.25
        props.damage(p, dmg, p.by, this.events as PropEvent[])
        break
      }
    }
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * Compact replication: one numeric tuple per entity, positions in centimetres-ish precision, and looks/owners as
 * indices the client resolves from the roster and character data. Everything a client needs to draw the effects.
 */
export type AbilityView = {
  /** [id, look, by, x, y, z] */
  p: [number, string, string, number, number, number][]
  /** [id, look, by, x, y, count, full] */
  s: [number, string, string, number, number, number, number][]
  /** [id, look, by, x, y, radius, age, life] */
  z: [number, string, string, number, number, number, number, number][]
  /** [id, by, x, y, aim] */
  d: [number, string, number, number, number][]
}

export function abilityView<A extends AbilityActor>(ab: Abilities<A>, now: number): AbilityView {
  return {
    p: ab.projectiles.map((p) => [p.id, p.look, p.by, r2(p.x), r2(p.y), r2(p.z)]),
    s: ab.swarms.map((s) => [s.id, s.look, s.by, r2(s.x), r2(s.y), Math.round(s.count), s.full]),
    z: ab.zones.map((z) => [z.id, z.look, z.by, r2(z.x), r2(z.y), r2(z.radius), r2(now - z.born), r2(z.end - z.born)]),
    d: ab.decoys.map((d) => [d.id, d.by, r2(d.x), r2(d.y), r2(d.aim)]),
  }
}

/** Seconds until each slot is ready, and the active cast, for a HUD. */
export function cooldowns(a: AbilityActor, now: number): number[] {
  return a.ab.ready.map((r) => Math.max(0, r2(r - now)))
}
