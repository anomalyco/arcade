import { DT, SAMPLE_EVERY, SELF_GRACE, clampAngle, clampPower, hypot, integrate, launchVelocity, ms, muzzle, windAccel } from "./ballistics"
import { passiveOf } from "./classes"
import { walk } from "./move"
import { rng, type Rand } from "./rng"
import {
  UNIT_BODY,
  UNIT_R,
  WORLD_H,
  WORLD_W,
  carveCircle,
  columnGround,
  embedded,
  fillRect,
  findIslands,
  footGround,
  isSolid,
  islandScratch,
  liftOut,
  packBits,
  supported,
  type IslandScratch,
  type Mask,
} from "./terrain"
import { WEAPONS, type WeaponDef, type WeaponId } from "./weapons"
import type { Crate, PathOut, PowerupId, Shot, SimEvent, Unit, VolleyResult } from "./protocol"

export type { PathOut, Shot, SimEvent, Unit, VolleyResult }
export { DT, GRAVITY, WIND_ACCEL, clampAngle, clampPower, launchVelocity, muzzle } from "./ballistics"
export { UNIT_BODY, UNIT_R } from "./terrain"

// All `dur` fields in events are milliseconds.
export interface VolleyInput {
  mask: Mask
  units: Unit[]
  shots: Shot[]
  wind: number
  seed: number
  // crates on the field; claimed crates are removed from this array, the rest are settled and marked landed
  crates?: Crate[]
  // sudden-death line; units below it die
  hazardY?: number
}

const MAX_STEPS = Math.round(26 / DT)
const FALL_SAFE = 26
const FALL_RATE = 0.7
const UNIT_G = 700
const FIRE_TICK = 0.5
const FIRE_LIFE = 3.2
const WELL_DUR = 1.5
const WELL_R = 150
const DRILL_TIME = 3
const DRILL_SPEED = 150
const DRILL_CARVE = 8
const BUSTER_DEPTH = 40
const BUSTER_SPEED = 260
const BUSTER_FUSE = 0.3
const CHAIN_DELAY = 0.3
const CHAIN_R = 28
const CHAIN_DMG = 22
const BOOST = 1.5
const COLLAPSE_EVERY = 6
const MAX_CHUNKS = 48
const MAX_CHUNK_PIXELS = 40000
const MAX_CHUNK_W = 420
const MAX_CHUNK_H = 300
const CRATE_HALF = 6
const CRATE_GRAB = 11
const MAX_SLIDES = 6
const CRATE_WEAPONS: WeaponId[] = ["cluster", "mirv", "drill", "napalm", "gravity", "airstrike", "bouncer", "buster", "teleport", "builder", "shield"]

type Mode = "fly" | "drill" | "pen" | "fuse" | "flow"

interface Proj {
  id: number
  owner: number
  kind: WeaponId | "bomblet"
  x: number
  y: number
  vx: number
  vy: number
  wind: number
  age: number
  steps: number
  alive: boolean
  split: boolean
  pts: number[]
  t0: number
  mode: Mode
  drillT: number
  pen: number
  fuseAt: number
  bounces: number
  // airstrike: 0 = flare, 1 = bomb
  stage: number
  settled: boolean
}

interface Fire {
  x0: number
  x1: number
  y: number
  until: number
  owner: number
  nextTick: number
}

interface Napalm {
  owner: number
  drops: Proj[]
}

interface Well {
  x: number
  y: number
  r: number
  owner: number
  s0: number
  s1: number
  carved: number
}

interface Action {
  step: number
  seq: number
  run: () => void
}

interface PendingChunk {
  ev: Extract<SimEvent, { type: "chunk" }>
  bits: Uint8Array
  land: number
  cause: number
  count: number
  riders: Set<number>
}

interface Motion {
  kind: "fall" | "ride" | "slide" | "pull" | "lift"
  x0: number
  y0: number
  x1: number
  y1: number
  s0: number
  s1: number
  cause: number
  scale: number
}

interface Ctx {
  mask: Mask
  units: Unit[]
  byId: Map<number, Unit>
  crates: Crate[]
  wind: number
  rand: Rand
  events: SimEvent[]
  projs: Proj[]
  all: Proj[]
  fires: Fire[]
  napalms: Napalm[]
  wells: Well[]
  actions: Action[]
  chunks: PendingChunk[]
  motions: Map<number, Motion>
  slides: Map<number, number>
  boost: Set<number>
  volleyShield: Map<number, number>
  hazardY: number
  step: number
  nextId: number
  chunkId: number
  chunkCount: number
  seq: number
  lastOwner: number
  terrainDirty: boolean
  collapseDirty: boolean
  motionEnded: boolean
  lastCollapse: number
  scratch: IslandScratch
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return hypot(ax - bx, ay - by)
}

function steps(seconds: number): number {
  return Math.max(1, Math.round(seconds / DT))
}

function emit(ctx: Ctx, ev: SimEvent): void {
  ctx.events.push(ev)
}

function now(ctx: Ctx): number {
  return ms(ctx.step)
}

function schedule(ctx: Ctx, delay: number, run: () => void): void {
  const a: Action = { step: ctx.step + Math.max(1, delay), seq: ctx.seq++, run }
  let i = ctx.actions.length
  while (i > 0 && (ctx.actions[i - 1]!.step > a.step || (ctx.actions[i - 1]!.step === a.step && ctx.actions[i - 1]!.seq > a.seq))) i--
  ctx.actions.splice(i, 0, a)
}

function weaponOf(kind: Proj["kind"]): WeaponDef {
  return WEAPONS[kind === "bomblet" ? "cluster" : kind]
}

export function carveRadius(def: WeaponDef): number {
  return def.radius * (0.4 + 0.25 * def.terrain)
}

function dmgMult(ctx: Ctx, owner: number): number {
  const u = ctx.byId.get(owner)
  if (!u) return 1
  return passiveOf(u.cls).damage * (ctx.boost.has(owner) ? BOOST : 1)
}

// ---------------------------------------------------------------------------
// damage

function applyDamage(ctx: Ctx, unit: Unit, raw: number, killer: number): void {
  if (!unit.alive) return
  let amount = Math.round(raw)
  if (amount <= 0) return
  if (unit.shield > 0) {
    const a = Math.min(unit.shield, amount)
    unit.shield -= a
    const vs = ctx.volleyShield.get(unit.id) ?? 0
    if (vs > 0) ctx.volleyShield.set(unit.id, vs - Math.min(vs, a))
    emit(ctx, { t: now(ctx), type: "absorb", unit: unit.id, amount: a })
    amount -= a
    if (amount <= 0) return
  }
  unit.hp = Math.max(0, unit.hp - amount)
  const kill = unit.hp <= 0
  emit(ctx, { t: now(ctx), type: "hit", unit: unit.id, amount, x: unit.x, y: unit.y - UNIT_BODY, killer, kill })
  if (!kill) return
  unit.alive = false
  ctx.motions.delete(unit.id)
  if (killer !== unit.id) {
    const k = ctx.byId.get(killer)
    if (k) k.kills++
  }
  // the wreck cooks off: secondary explosion
  const x = unit.x
  const y = unit.y
  if (y < WORLD_H) schedule(ctx, steps(CHAIN_DELAY), () => boom(ctx, x, y, CHAIN_R, CHAIN_DMG, killer, "shell", CHAIN_R * 0.5))
}

function carve(ctx: Ctx, x: number, y: number, r: number, owner: number): void {
  if (r <= 0) return
  if (carveCircle(ctx.mask, x, y, r)) {
    emit(ctx, { t: now(ctx), type: "carve", x, y, r })
    ctx.terrainDirty = true
    ctx.collapseDirty = true
    ctx.lastOwner = owner
  }
}

function fill(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, owner: number): void {
  if (fillRect(ctx.mask, x0, y0, x1, y1)) {
    emit(ctx, { t: now(ctx), type: "fill", x0, y0, x1, y1 })
    ctx.terrainDirty = true
    ctx.collapseDirty = true
    ctx.lastOwner = owner
  }
}

function boom(ctx: Ctx, x: number, y: number, r: number, damage: number, owner: number, kind: WeaponId, carveR: number): void {
  emit(ctx, { t: now(ctx), type: "boom", x, y, r, kind, owner })
  carve(ctx, x, y, carveR, owner)
  if (damage > 0) {
    const mult = dmgMult(ctx, owner)
    for (const u of ctx.units) {
      if (!u.alive) continue
      const d = dist(u.x, u.y, x, y)
      const reach = r + UNIT_R
      if (d >= reach) continue
      const falloff = 1 - d / reach
      applyDamage(ctx, u, damage * mult * (0.35 + 0.65 * falloff), owner)
    }
  }
  if (r > 0) {
    for (const c of ctx.crates.slice()) if (dist(c.x, c.y, x, y) < r + CRATE_HALF + 2) claimCrate(ctx, c, owner)
    // sympathetic detonation of shells caught in the blast
    for (const p of ctx.projs) {
      if (!p.alive || p.mode !== "fly" || p.age < 0.15) continue
      if (dist(p.x, p.y, x, y) < r * 0.6) impact(ctx, p, "force")
    }
  }
}

// ---------------------------------------------------------------------------
// crates

function claimCrate(ctx: Ctx, crate: Crate, owner: number): void {
  const idx = ctx.crates.indexOf(crate)
  if (idx < 0) return
  ctx.crates.splice(idx, 1)
  const u = ctx.byId.get(owner)
  if (!u) return
  let detail = ""
  const kind: PowerupId = crate.kind
  if (kind === "credits") detail = "+150 CREDITS"
  else if (kind === "weapon") {
    const w = CRATE_WEAPONS[Math.floor(ctx.rand() * CRATE_WEAPONS.length)]!
    u.ammo[w] = (u.ammo[w] ?? 0) + 1
    detail = `+1 ${WEAPONS[w].name}`
  } else if (kind === "shield") {
    u.shield += 25
    detail = "+25 SHIELD"
  } else if (kind === "boost") {
    u.boost += 1
    detail = "DAMAGE BOOST x1.5"
  } else if (kind === "repair") {
    const heal = u.alive ? Math.min(40, u.maxHp - u.hp) : 0
    u.hp += heal
    detail = `+${heal} HP`
  } else if (kind === "preview") {
    u.preview = (u.preview ?? 0) + 1
    detail = "LONG SIGHT"
  } else {
    u.fuel += 60
    detail = "+60 FUEL"
  }
  emit(ctx, { t: now(ctx), type: "crate", crate: crate.id, unit: owner, kind, detail })
}

// ---------------------------------------------------------------------------
// projectiles

function addProj(ctx: Ctx, owner: number, kind: Proj["kind"], x: number, y: number, vx: number, vy: number, wind: number, mode: Mode = "fly", stage = 0): Proj {
  const p: Proj = { id: ctx.nextId++, owner, kind, x, y, vx, vy, wind, age: 0, steps: 0, alive: true, split: false, pts: [x, y], t0: ctx.step, mode, drillT: 0, pen: 0, fuseAt: 0, bounces: 0, stage, settled: false }
  ctx.all.push(p)
  if (mode !== "flow") ctx.projs.push(p)
  return p
}

function kill(p: Proj): void {
  p.alive = false
  const n = p.pts.length
  if (n < 2 || p.pts[n - 2] !== p.x || p.pts[n - 1] !== p.y) p.pts.push(p.x, p.y)
}

function launch(ctx: Ctx, shot: Shot): void {
  const unit = ctx.byId.get(shot.unit)
  if (!unit || !unit.alive) return
  let weapon: WeaponId = WEAPONS[shot.weapon] ? shot.weapon : "shell"
  if (weapon !== "shell" && (unit.ammo[weapon] ?? 0) <= 0) weapon = "shell"
  if (weapon !== "shell") unit.ammo[weapon]--
  const angle = clampAngle(shot.angle)
  const power = clampPower(shot.power)
  unit.angle = angle
  if (weapon === "shield") {
    unit.shield += 40
    ctx.volleyShield.set(unit.id, (ctx.volleyShield.get(unit.id) ?? 0) + 40)
    emit(ctx, { t: now(ctx), type: "shieldUp", unit: unit.id, hp: unit.shield })
    return
  }
  const m = muzzle(unit, angle)
  const v = launchVelocity(angle, power, unit.cls)
  addProj(ctx, unit.id, weapon, m.x, m.y, v.vx, v.vy, windAccel(ctx.wind, unit.cls))
}

function explode(ctx: Ctx, p: Proj): void {
  kill(p)
  const def = weaponOf(p.kind)
  boom(ctx, p.x, p.y, def.radius, def.damage, p.owner, p.kind === "bomblet" ? "cluster" : p.kind, carveRadius(def))
}

function impact(ctx: Ctx, p: Proj, how: "terrain" | "unit" | "force"): void {
  if (!p.alive) return
  switch (p.kind) {
    case "cluster":
      kill(p)
      splitCluster(ctx, p, true)
      return
    case "drill":
      if (how === "terrain" && p.mode === "fly") {
        p.mode = "drill"
        const s = hypot(p.vx, p.vy) || 1
        p.vx = (p.vx / s) * DRILL_SPEED
        p.vy = (p.vy / s) * DRILL_SPEED
        carve(ctx, p.x, p.y, DRILL_CARVE, p.owner)
        return
      }
      explode(ctx, p)
      return
    case "buster":
      if (how === "terrain" && p.mode === "fly") {
        p.mode = "pen"
        const s = hypot(p.vx, p.vy) || 1
        p.vx = (p.vx / s) * BUSTER_SPEED
        p.vy = (p.vy / s) * BUSTER_SPEED
        return
      }
      explode(ctx, p)
      return
    case "bouncer":
      if (how === "terrain" && p.bounces < 3) {
        bounce(ctx, p)
        return
      }
      explode(ctx, p)
      return
    case "napalm":
      napalm(ctx, p)
      return
    case "gravity":
      openWell(ctx, p)
      return
    case "builder":
      buildWall(ctx, p)
      return
    case "airstrike":
      if (p.stage === 0) callStrike(ctx, p)
      else explode(ctx, p)
      return
    case "teleport":
      teleport(ctx, p)
      return
    default:
      explode(ctx, p)
  }
}

function splitCluster(ctx: Ctx, p: Proj, ground: boolean): void {
  p.split = true
  for (let k = 0; k < 6; k++) {
    const spread = (k - 2.5) * 34 + (ctx.rand() - 0.5) * 30
    const vx = ground ? spread * 1.4 : p.vx * 0.6 + spread
    const vy = ground ? -120 - ctx.rand() * 80 : -50 - ctx.rand() * 70
    addProj(ctx, p.owner, "bomblet", p.x, ground ? p.y - 4 : p.y, vx, vy, p.wind)
  }
  emit(ctx, { t: now(ctx), type: "boom", x: p.x, y: p.y, r: 6, kind: "cluster", owner: p.owner })
}

function splitMirv(ctx: Ctx, p: Proj): void {
  p.split = true
  kill(p)
  for (let k = 0; k < 3; k++) {
    const w = addProj(ctx, p.owner, "mirv", p.x, p.y, p.vx + (k - 1) * 62, 10 + ctx.rand() * 20, p.wind)
    w.split = true
  }
  emit(ctx, { t: now(ctx), type: "boom", x: p.x, y: p.y, r: 5, kind: "mirv", owner: p.owner })
}

function normalAt(mask: Mask, x: number, y: number): { nx: number; ny: number } {
  let nx = 0
  let ny = 0
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      if (dx * dx + dy * dy > 25) continue
      if (isSolid(mask, x + dx, y + dy)) {
        nx -= dx
        ny -= dy
      }
    }
  }
  const l = hypot(nx, ny)
  if (l === 0) return { nx: 0, ny: -1 }
  return { nx: nx / l, ny: ny / l }
}

function bounce(ctx: Ctx, p: Proj): void {
  p.x -= p.vx * DT
  p.y -= p.vy * DT
  const n = normalAt(ctx.mask, p.x, p.y)
  const dot = p.vx * n.nx + p.vy * n.ny
  if (dot < 0) {
    p.vx -= 2 * dot * n.nx
    p.vy -= 2 * dot * n.ny
  }
  p.vx *= 0.72
  p.vy *= 0.72
  p.bounces++
  if (hypot(p.vx, p.vy) < 40) explode(ctx, p)
}

function napalm(ctx: Ctx, p: Proj): void {
  kill(p)
  boom(ctx, p.x, p.y, WEAPONS.napalm.radius, 8, p.owner, "napalm", 6)
  const group: Napalm = { owner: p.owner, drops: [] }
  for (let k = 0; k < 8; k++) {
    const x = Math.min(WORLD_W - 3, Math.max(3, p.x + (k - 3.5) * 3))
    const g = columnGround(ctx.mask, x, p.y - 12)
    if (g >= WORLD_H) continue
    const vx = p.vx * 0.25 + (k - 3.5) * 24 + (ctx.rand() - 0.5) * 24
    group.drops.push(addProj(ctx, p.owner, "napalm", x, g, vx, 0, 0, "flow"))
  }
  if (group.drops.length > 0) ctx.napalms.push(group)
}

function flowDrop(ctx: Ctx, d: Proj): void {
  if (d.settled) return
  const gl = columnGround(ctx.mask, d.x - 2, d.y - 8)
  const gr = columnGround(ctx.mask, d.x + 2, d.y - 8)
  if (gl < WORLD_H && gr < WORLD_H) d.vx += ((gr - gl) / 4) * 520 * DT
  d.vx *= 0.982
  const nx = Math.min(WORLD_W - 2, Math.max(2, d.x + d.vx * DT))
  const ng = columnGround(ctx.mask, nx, d.y - 8)
  if (ng >= WORLD_H) {
    d.x = nx
    d.y = WORLD_H
    d.settled = true
    kill(d)
    return
  }
  if (ng < d.y - 6) d.vx = -d.vx * 0.3
  else {
    d.x = nx
    d.y = ng
  }
  d.age += DT
  d.steps++
  if (d.steps % SAMPLE_EVERY === 0) d.pts.push(d.x, d.y)
  if ((d.age > 0.25 && Math.abs(d.vx) < 6) || d.age > 1.2) {
    d.settled = true
    kill(d)
  }
}

function igniteGroup(ctx: Ctx, g: Napalm): void {
  const drops = g.drops.filter((d) => d.y < WORLD_H).sort((a, b) => a.x - b.x || a.id - b.id)
  let seg: { x0: number; x1: number; y: number } | null = null
  const segs: Array<{ x0: number; x1: number; y: number }> = []
  for (const d of drops) {
    if (seg && d.x - seg.x1 < 18 && Math.abs(d.y - seg.y) < 14) {
      seg.x1 = d.x
      seg.y = Math.max(seg.y, d.y)
    } else {
      seg = { x0: d.x, x1: d.x, y: d.y }
      segs.push(seg)
    }
  }
  const life = steps(FIRE_LIFE)
  for (const s of segs) {
    const x0 = s.x0 - 10
    const x1 = s.x1 + 10
    emit(ctx, { t: now(ctx), type: "fire", x0, x1, y: s.y, dur: ms(ctx.step + life) - now(ctx), owner: g.owner })
    ctx.fires.push({ x0, x1, y: s.y, until: ctx.step + life, owner: g.owner, nextTick: ctx.step + steps(FIRE_TICK * 0.5) })
  }
}

function tickFires(ctx: Ctx): void {
  for (const f of ctx.fires) {
    if (ctx.step >= f.until || ctx.step < f.nextTick) continue
    f.nextTick = ctx.step + steps(FIRE_TICK)
    const dmg = WEAPONS.napalm.damage * dmgMult(ctx, f.owner)
    for (const u of ctx.units) {
      if (!u.alive) continue
      if (u.x < f.x0 - 4 || u.x > f.x1 + 4) continue
      if (Math.abs(u.y + UNIT_BODY - f.y) > 16) continue
      applyDamage(ctx, u, dmg, f.owner)
    }
  }
  ctx.fires = ctx.fires.filter((f) => ctx.step < f.until)
}

function openWell(ctx: Ctx, p: Proj): void {
  kill(p)
  const dur = steps(WELL_DUR)
  emit(ctx, { t: now(ctx), type: "well", x: p.x, y: p.y, r: WELL_R, dur: ms(ctx.step + dur) - now(ctx), owner: p.owner })
  ctx.wells.push({ x: p.x, y: p.y, r: WELL_R, owner: p.owner, s0: ctx.step, s1: ctx.step + dur, carved: 0 })
  const reach = WELL_R * 0.85
  for (const u of ctx.units) {
    if (!u.alive || ctx.motions.has(u.id)) continue
    const d = dist(u.x, u.y, p.x, p.y)
    if (d >= reach || Math.abs(u.x - p.x) < 3) continue
    const px = Math.round((1 - d / reach) * 70)
    const dir: -1 | 1 = p.x > u.x ? 1 : -1
    const res = walk(ctx.mask, u.x, u.y, dir, Math.min(px, Math.floor(Math.abs(p.x - u.x))), 6, 200)
    if (res.moved < 2) continue
    startMotion(ctx, u, "pull", res.x, res.y, Math.round(dur * 0.8), p.owner, 1)
  }
}

function tickWells(ctx: Ctx): void {
  const cavity = WEAPONS.gravity.radius
  for (const w of ctx.wells) {
    const k = Math.floor(((ctx.step - w.s0) / (w.s1 - w.s0)) * 5)
    while (w.carved < Math.min(5, k + 1)) {
      w.carved++
      carve(ctx, w.x, w.y, (cavity * w.carved) / 5, w.owner)
    }
    if (ctx.step >= w.s1) {
      const def = WEAPONS.gravity
      boom(ctx, w.x, w.y, def.radius * 1.2, def.damage, w.owner, "gravity", cavity)
    }
  }
  ctx.wells = ctx.wells.filter((w) => ctx.step < w.s1)
}

function wellAccel(ctx: Ctx, p: Proj): { ax: number; ay: number } {
  let ax = 0
  let ay = 0
  for (const w of ctx.wells) {
    const dx = w.x - p.x
    const dy = w.y - p.y
    const d = hypot(dx, dy)
    if (d >= w.r || d === 0) continue
    const a = 42000 / Math.max(d, 20)
    ax += (dx / d) * a
    ay += (dy / d) * a
  }
  return { ax, ay }
}

function buildWall(ctx: Ctx, p: Proj): void {
  kill(p)
  const x = Math.min(WORLD_W - 24, Math.max(24, p.x))
  let g = columnGround(ctx.mask, x, p.y - 6)
  if (g >= WORLD_H) g = Math.min(WORLD_H - 1, p.y + 20)
  let bottom = g
  for (let c = x - 20; c <= x + 20; c += 2) {
    const cg = columnGround(ctx.mask, c, g - 30)
    if (cg < WORLD_H && cg <= g + 40) bottom = Math.max(bottom, cg)
  }
  bottom = Math.round(bottom + 3)
  const top = Math.round(g - 64)
  const h = bottom - top
  emit(ctx, { t: now(ctx), type: "builder", x, y: bottom, w: 40, h })
  const owner = p.owner
  for (let k = 0; k < 5; k++) {
    const y1 = bottom - Math.round((h * k) / 5)
    const y0 = bottom - Math.round((h * (k + 1)) / 5)
    schedule(ctx, 1 + k * 10, () => fill(ctx, x - 20, y0, x + 20, y1, owner))
  }
}

function callStrike(ctx: Ctx, p: Proj): void {
  kill(p)
  emit(ctx, { t: now(ctx), type: "boom", x: p.x, y: p.y, r: 6, kind: "airstrike", owner: p.owner })
  const dir = p.vx >= 0 ? 1 : -1
  const x = p.x
  for (let k = 0; k < 5; k++) {
    const bx = Math.min(WORLD_W - 10, Math.max(10, x + (k - 2) * 42 * dir))
    schedule(ctx, 36 + k * 9, () => addProj(ctx, p.owner, "airstrike", bx, -30, 0, 240, p.wind, "fly", 1))
  }
}

function teleport(ctx: Ctx, p: Proj): void {
  kill(p)
  const u = ctx.byId.get(p.owner)
  if (!u || !u.alive) return
  const x = Math.min(WORLD_W - 8, Math.max(8, Math.round(p.x)))
  const y = liftOut(ctx.mask, x, Math.round(p.y - UNIT_BODY))
  emit(ctx, { t: now(ctx), type: "teleport", unit: u.id, x0: u.x, y0: u.y, x, y })
  ctx.motions.delete(u.id)
  u.x = x
  u.y = y
  ctx.terrainDirty = true
}

function hitsUnit(ctx: Ctx, p: Proj): boolean {
  for (const u of ctx.units) {
    if (!u.alive) continue
    if (u.id === p.owner && p.age < SELF_GRACE) continue
    if (dist(p.x, p.y, u.x, u.y) < UNIT_R + 3) return true
  }
  return false
}

function sample(p: Proj): void {
  p.age += DT
  p.steps++
  if (p.steps % SAMPLE_EVERY === 0) p.pts.push(p.x, p.y)
}

function stepProj(ctx: Ctx, p: Proj): void {
  if (!p.alive) return
  if (p.mode === "fuse") {
    p.age += DT
    if (ctx.step >= p.fuseAt) explode(ctx, p)
    return
  }
  if (p.mode === "drill" || p.mode === "pen") {
    if (p.mode === "drill") {
      p.vy += 60 * DT
      const s = hypot(p.vx, p.vy) || 1
      p.vx = (p.vx / s) * DRILL_SPEED
      p.vy = (p.vy / s) * DRILL_SPEED
      p.drillT += DT
    }
    p.x += p.vx * DT
    p.y += p.vy * DT
    sample(p)
    if (p.y >= WORLD_H - 2 || p.x < 0 || p.x >= WORLD_W) {
      explode(ctx, p)
      return
    }
    if (hitsUnit(ctx, p)) {
      explode(ctx, p)
      return
    }
    if (p.mode === "drill") {
      if (p.steps % 3 === 0) carve(ctx, p.x, p.y, DRILL_CARVE, p.owner)
      if (p.drillT >= DRILL_TIME) explode(ctx, p)
      else if (!isSolid(ctx.mask, p.x, p.y) && !isSolid(ctx.mask, p.x + p.vx * 0.05, p.y + p.vy * 0.05)) p.mode = "fly"
    } else {
      p.pen += BUSTER_SPEED * DT
      if (p.steps % 2 === 0) carve(ctx, p.x, p.y, 5, p.owner)
      if (p.pen >= BUSTER_DEPTH) {
        p.mode = "fuse"
        p.fuseAt = ctx.step + steps(BUSTER_FUSE)
      }
    }
    return
  }
  const w = ctx.wells.length > 0 ? wellAccel(ctx, p) : { ax: 0, ay: 0 }
  integrate(p, p.wind, w.ax, w.ay)
  sample(p)
  if (p.x < -250 || p.x > WORLD_W + 250 || p.y > WORLD_H + 60) {
    kill(p)
    return
  }
  for (const well of ctx.wells) {
    if (dist(p.x, p.y, well.x, well.y) < 9) {
      kill(p)
      emit(ctx, { t: now(ctx), type: "collide", x: p.x, y: p.y })
      return
    }
  }
  if (!p.split && p.age > 0.2 && p.vy >= 0) {
    if (p.kind === "mirv") {
      splitMirv(ctx, p)
      return
    }
    if (p.kind === "cluster") {
      kill(p)
      splitCluster(ctx, p, false)
      return
    }
  }
  for (const c of ctx.crates) {
    if (dist(p.x, p.y, c.x, c.y) < CRATE_GRAB) {
      claimCrate(ctx, c, p.owner)
      impact(ctx, p, "force")
      return
    }
  }
  if (hitsUnit(ctx, p)) {
    impact(ctx, p, "unit")
    return
  }
  if (isSolid(ctx.mask, p.x, p.y)) impact(ctx, p, "terrain")
}

function collideMidAir(ctx: Ctx): void {
  const live = ctx.projs.filter((p) => p.alive && p.mode === "fly" && p.kind !== "bomblet")
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!
      const b = live[j]!
      if (!a.alive || !b.alive || a.owner === b.owner) continue
      if (dist(a.x, a.y, b.x, b.y) < 7) {
        const x = (a.x + b.x) / 2
        const y = (a.y + b.y) / 2
        kill(a)
        kill(b)
        emit(ctx, { t: now(ctx), type: "collide", x, y })
        boom(ctx, x, y, 14, 8, a.owner, "shell", 7)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// units: falling, sliding, riding chunks

function startMotion(ctx: Ctx, u: Unit, kind: Motion["kind"], x1: number, y1: number, dur: number, cause: number, scale: number): void {
  const d = Math.max(1, dur)
  ctx.motions.set(u.id, { kind, x0: u.x, y0: u.y, x1, y1, s0: ctx.step, s1: ctx.step + d, cause, scale })
  emit(ctx, { t: now(ctx), type: "move", unit: u.id, x: x1, y: y1, dur: ms(ctx.step + d) - now(ctx) })
}

function fallSteps(dy: number): number {
  return Math.max(3, Math.round(Math.sqrt((2 * Math.max(1, dy)) / UNIT_G) / DT))
}

function stepMotions(ctx: Ctx): void {
  for (const u of ctx.units) {
    const m = ctx.motions.get(u.id)
    if (!m) continue
    if (!u.alive) {
      ctx.motions.delete(u.id)
      continue
    }
    const f = Math.min(1, (ctx.step - m.s0) / (m.s1 - m.s0))
    const fy = m.kind === "fall" || m.kind === "ride" ? f * f : f
    u.x = m.x0 + (m.x1 - m.x0) * f
    u.y = m.y0 + (m.y1 - m.y0) * fy
    if (ctx.step < m.s1) continue
    ctx.motions.delete(u.id)
    ctx.motionEnded = true
    u.x = m.x1
    u.y = m.y1
    if (m.kind !== "fall" && m.kind !== "ride") continue
    const dy = m.y1 - m.y0
    const dmg = dy > FALL_SAFE ? (dy - FALL_SAFE) * FALL_RATE * m.scale * passiveOf(u.cls).fallDamage : 0
    emit(ctx, { t: now(ctx), type: "fall", unit: u.id, x: u.x, y: Math.min(u.y, WORLD_H), dy: Math.round(dy), dmg: Math.round(dmg) })
    const culprit = m.cause >= 0 ? m.cause : u.id
    if (u.y >= WORLD_H) applyDamage(ctx, u, u.hp + u.shield, culprit)
    else if (dmg > 0) applyDamage(ctx, u, dmg, culprit)
  }
}

function slopeAt(ctx: Ctx, x: number, y: number): number {
  const feet = Math.floor(y + UNIT_BODY)
  const gl = columnGround(ctx.mask, x - 5, feet - 12)
  const gr = columnGround(ctx.mask, x + 5, feet - 12)
  if (gl >= WORLD_H || gr >= WORLD_H) return 0
  return (gr - gl) / 10
}

function trySlide(ctx: Ctx, u: Unit): boolean {
  const limit = passiveOf(u.cls).slide
  const slope = slopeAt(ctx, u.x, u.y)
  if (Math.abs(slope) <= limit) return false
  if ((ctx.slides.get(u.id) ?? 0) >= MAX_SLIDES) return false
  const dir = slope > 0 ? 1 : -1
  let cx = Math.floor(u.x)
  let cy = Math.floor(u.y + UNIT_BODY)
  let moved = 0
  for (let k = 0; k < 140; k++) {
    const nx = cx + dir
    if (nx < 6 || nx > WORLD_W - 6) break
    const ng = columnGround(ctx.mask, nx, cy - 3)
    if (ng < cy - 1) break
    cx = nx
    moved++
    if (ng >= WORLD_H || ng > cy + 16) break
    cy = ng
    if (moved >= 6 && Math.abs(slopeAt(ctx, cx, cy - UNIT_BODY)) <= limit * 0.7) break
  }
  if (moved < 2) return false
  let ty = footGround(ctx.mask, cx, cy - 4)
  ty = ty >= WORLD_H ? cy - UNIT_BODY : ty - UNIT_BODY
  ty = liftOut(ctx.mask, cx, ty)
  ctx.slides.set(u.id, (ctx.slides.get(u.id) ?? 0) + 1)
  startMotion(ctx, u, "slide", cx, ty, Math.max(8, Math.round(moved / 110 / DT)), ctx.lastOwner, 1)
  return true
}

function settleUnits(ctx: Ctx): void {
  for (const u of ctx.units) {
    if (!u.alive || ctx.motions.has(u.id)) continue
    u.x = Math.min(WORLD_W - 6, Math.max(6, u.x))
    if (u.y > ctx.hazardY) {
      applyDamage(ctx, u, u.hp + u.shield, u.id)
      continue
    }
    if (embedded(ctx.mask, u.x, u.y)) {
      startMotion(ctx, u, "lift", u.x, liftOut(ctx.mask, u.x, u.y), steps(0.12), -1, 1)
      continue
    }
    if (!supported(ctx.mask, u.x, u.y)) {
      const g = footGround(ctx.mask, u.x, Math.floor(u.y + UNIT_BODY))
      const target = g >= WORLD_H ? WORLD_H + 30 : g - UNIT_BODY
      startMotion(ctx, u, "fall", u.x, target, fallSteps(target - u.y), ctx.lastOwner, 1)
      continue
    }
    trySlide(ctx, u)
  }
}

// ---------------------------------------------------------------------------
// terrain collapse

function collapse(ctx: Ctx): void {
  ctx.collapseDirty = false
  ctx.lastCollapse = ctx.step
  if (ctx.chunkCount >= MAX_CHUNKS) return
  const islands = findIslands(ctx.mask, ctx.scratch)
  for (const island of islands) {
    if (ctx.chunkCount >= MAX_CHUNKS) break
    if (island.count > MAX_CHUNK_PIXELS || island.w > MAX_CHUNK_W || island.h > MAX_CHUNK_H) continue
    const { x: ix, y: iy, w, h } = island
    const bits = new Uint8Array(w * h)
    for (const i of island.pixels) {
      const x = i % WORLD_W
      const y = (i - x) / WORLD_W
      bits[(y - iy) * w + (x - ix)] = 1
      ctx.mask[i] = 0
    }
    let dy = Infinity
    for (let lx = 0; lx < w; lx++) {
      for (let ly = 0; ly < h; ly++) {
        if (bits[ly * w + lx] !== 1) continue
        if (ly + 1 < h && bits[(ly + 1) * w + lx] === 1) continue
        const y = iy + ly
        const g = columnGround(ctx.mask, ix + lx, y + 1)
        if (g < WORLD_H) dy = Math.min(dy, g - (y + 1))
      }
    }
    const fallsOut = !Number.isFinite(dy)
    const fall = fallsOut ? WORLD_H - iy + 20 : dy
    const dur = fallSteps(Math.min(fall, WORLD_H))
    const ev: PendingChunk["ev"] = { t: now(ctx), type: "chunk", id: ++ctx.chunkId, x: ix, y: iy, w, h, bits: packBits(bits), dy: fall, dur: ms(ctx.step + dur) - now(ctx) }
    emit(ctx, ev)
    ctx.chunkCount++
    const pend: PendingChunk = { ev, bits, land: ctx.step + dur, cause: ctx.lastOwner, count: island.count, riders: new Set() }
    ctx.chunks.push(pend)
    ctx.terrainDirty = true
    for (const u of ctx.units) {
      if (!u.alive || ctx.motions.has(u.id)) continue
      const row = Math.floor(u.y + UNIT_BODY) - iy
      if (row < 0 || row >= h) continue
      let on = false
      for (const dx of [-3, 0, 3]) {
        const col = Math.floor(u.x) + dx - ix
        if (col >= 0 && col < w && bits[row * w + col] === 1) on = true
      }
      if (!on) continue
      pend.riders.add(u.id)
      startMotion(ctx, u, "ride", u.x, fallsOut ? WORLD_H + 30 : u.y + fall, dur, pend.cause, 0.5)
    }
  }
}

function landChunks(ctx: Ctx, all = false): void {
  if (ctx.chunks.length === 0) return
  const due = all ? ctx.chunks.slice().sort((a, b) => a.land - b.land || a.ev.id - b.ev.id) : ctx.chunks.filter((c) => c.land === ctx.step)
  if (due.length === 0) return
  ctx.chunks = all ? [] : ctx.chunks.filter((c) => c.land !== ctx.step)
  for (const c of due) {
    const { x, y, w, h, dy } = c.ev
    let changed = false
    for (let ly = 0; ly < h; ly++) {
      const wy = y + dy + ly
      if (wy < 0 || wy >= WORLD_H) continue
      for (let lx = 0; lx < w; lx++) {
        if (c.bits[ly * w + lx] !== 1) continue
        const wx = x + lx
        if (wx < 0 || wx >= WORLD_W) continue
        if (ctx.mask[wy * WORLD_W + wx] === 0) {
          ctx.mask[wy * WORLD_W + wx] = 1
          changed = true
        }
      }
    }
    if (!changed) continue
    ctx.terrainDirty = true
    ctx.collapseDirty = true
    for (const u of ctx.units) {
      if (!u.alive || c.riders.has(u.id)) continue
      let crushed = false
      for (let row = Math.floor(u.y - 5); row <= Math.floor(u.y + UNIT_BODY - 1) && !crushed; row++) {
        const ly = row - (y + dy)
        if (ly < 0 || ly >= h) continue
        for (let col = Math.floor(u.x) - 4; col <= Math.floor(u.x) + 4; col += 2) {
          const lx = col - x
          if (lx >= 0 && lx < w && c.bits[ly * w + lx] === 1) {
            crushed = true
            break
          }
        }
      }
      if (!crushed) continue
      ctx.motions.delete(u.id)
      applyDamage(ctx, u, 18 + Math.min(42, dy * 0.1 + c.count / 300), c.cause >= 0 ? c.cause : u.id)
    }
  }
}

// ---------------------------------------------------------------------------

function idle(ctx: Ctx): boolean {
  return ctx.projs.length === 0 && ctx.fires.length === 0 && ctx.wells.length === 0 && ctx.napalms.length === 0 && ctx.actions.length === 0 && ctx.chunks.length === 0 && ctx.motions.size === 0
}

function settleCrates(ctx: Ctx): void {
  for (const c of ctx.crates.slice()) {
    let y = Math.round(c.y)
    while (y > 0 && isSolid(ctx.mask, c.x, y + CRATE_HALF - 1)) y--
    const g = columnGround(ctx.mask, c.x, y + CRATE_HALF - 1)
    if (g >= WORLD_H || g - CRATE_HALF > ctx.hazardY) {
      ctx.crates.splice(ctx.crates.indexOf(c), 1)
      continue
    }
    c.y = g - CRATE_HALF
    c.landed = true
  }
}

export function runVolley(input: VolleyInput): VolleyResult {
  const ctx: Ctx = {
    mask: input.mask,
    units: input.units,
    byId: new Map(input.units.map((u) => [u.id, u])),
    crates: input.crates ?? [],
    wind: input.wind,
    rand: rng(input.seed),
    events: [],
    projs: [],
    all: [],
    fires: [],
    napalms: [],
    wells: [],
    actions: [],
    chunks: [],
    motions: new Map(),
    slides: new Map(),
    boost: new Set(input.units.filter((u) => u.boost > 0).map((u) => u.id)),
    volleyShield: new Map(),
    hazardY: input.hazardY ?? WORLD_H + 100,
    step: 0,
    nextId: 1,
    chunkId: 0,
    chunkCount: 0,
    seq: 0,
    lastOwner: -1,
    terrainDirty: false,
    collapseDirty: false,
    motionEnded: false,
    lastCollapse: 0,
    scratch: islandScratch(),
  }
  if (ctx.hazardY < WORLD_H) emit(ctx, { t: 0, type: "hazard", y: ctx.hazardY })
  const shots = [...input.shots].sort((a, b) => a.unit - b.unit)
  for (const shot of shots) launch(ctx, shot)
  settleUnits(ctx)
  while (ctx.step < MAX_STEPS) {
    landChunks(ctx)
    while (ctx.actions.length > 0 && ctx.actions[0]!.step <= ctx.step) ctx.actions.shift()!.run()
    stepMotions(ctx)
    for (const p of ctx.projs.slice()) stepProj(ctx, p)
    for (const g of ctx.napalms) for (const d of g.drops) flowDrop(ctx, d)
    for (const g of ctx.napalms.filter((g) => g.drops.every((d) => d.settled))) igniteGroup(ctx, g)
    ctx.napalms = ctx.napalms.filter((g) => !g.drops.every((d) => d.settled))
    collideMidAir(ctx)
    tickWells(ctx)
    tickFires(ctx)
    if (ctx.collapseDirty && ctx.step - ctx.lastCollapse >= COLLAPSE_EVERY) collapse(ctx)
    if (ctx.terrainDirty || ctx.motionEnded) {
      ctx.terrainDirty = false
      ctx.motionEnded = false
      settleUnits(ctx)
    }
    ctx.projs = ctx.projs.filter((p) => p.alive)
    ctx.step++
    if (idle(ctx)) {
      if (ctx.collapseDirty) collapse(ctx)
      settleUnits(ctx)
      ctx.terrainDirty = false
      ctx.motionEnded = false
      if (idle(ctx)) break
    }
  }
  // safety cap reached: land whatever is still falling so the mask matches the replay contract
  landChunks(ctx, true)
  for (const [id, left] of ctx.volleyShield) {
    const u = ctx.byId.get(id)
    if (u) u.shield = Math.max(0, u.shield - left)
  }
  settleCrates(ctx)
  for (const u of input.units) {
    if (u.hp < 0) u.hp = 0
    if (!u.alive) u.shield = 0
  }
  const paths: PathOut[] = ctx.all.map((p) => {
    if (p.alive) kill(p)
    return { id: p.id, owner: p.owner, kind: p.kind, t0: ms(p.t0), dt: Math.round(SAMPLE_EVERY * DT * 1000), pts: p.pts }
  })
  return {
    events: ctx.events,
    paths,
    durationMs: ms(ctx.step) + 150,
    hash: hashState(input.mask, input.units),
  }
}

export function hashState(mask: Mask, units: Unit[]): number {
  let h = 0x811c9dc5
  for (let i = 0; i < mask.length; i++) {
    h ^= mask[i]!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  for (const u of units) {
    const s = `${u.id}:${u.x.toFixed(3)}:${u.y.toFixed(3)}:${u.hp}:${u.alive ? 1 : 0}:${u.shield}`
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return h >>> 0
}
