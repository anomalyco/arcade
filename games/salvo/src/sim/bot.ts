import { hypot } from "./ballistics"
import { moveUnit } from "./move"
import { traceShot } from "./predict"
import type { Crate, Unit } from "./protocol"
import { rng, type Rand } from "./rng"
import { SHOP, applyPurchase, type Loadout } from "./shop"
import type { Mask } from "./terrain"
import { WEAPONS, type WeaponId } from "./weapons"

export interface BotInput {
  mask: Mask
  units: Unit[]
  crates: Crate[]
  me: Unit
  wind: number
  seed: number
  // 0 (clumsy) .. 1 (sharp)
  skill: number
}

export interface BotPlan {
  angle: number
  power: number
  weapon: WeaponId
  // target point, for debugging/visuals
  tx: number
  ty: number
}

function gauss(r: Rand): number {
  return (r() + r() + r() + r() - 2) * 0.87
}

interface Target {
  x: number
  y: number
  unit: Unit | null
  weight: number
}

function pickTarget(input: BotInput, r: Rand): Target | null {
  const { me, units, crates } = input
  const targets: Target[] = []
  for (const u of units) {
    if (!u.alive || u.team === me.team) continue
    const d = Math.abs(u.x - me.x)
    // prefer weak and near enemies, but anyone can be picked
    targets.push({ x: u.x, y: u.y, unit: u, weight: (1.4 - u.hp / Math.max(1, u.maxHp)) * (1 + 300 / (d + 120)) })
  }
  if (targets.length === 0) return null
  for (const c of crates) if (r() < 0.25) targets.push({ x: c.x, y: c.y, unit: null, weight: 0.5 })
  const total = targets.reduce((s, t) => s + t.weight, 0)
  let pick = r() * total
  for (const t of targets) {
    pick -= t.weight
    if (pick <= 0) return t
  }
  return targets[targets.length - 1]!
}

function friendlyRisk(input: BotInput, x: number, y: number): number {
  let risk = 0
  for (const u of input.units) {
    if (!u.alive || u.team !== input.me.team) continue
    const d = hypot(u.x - x, u.y - y)
    if (d < 60) risk += (60 - d) * (u.id === input.me.id ? 3 : 2)
  }
  return risk
}

function search(input: BotInput, t: Target): { angle: number; power: number; miss: number; direct: boolean } {
  const { me, mask, wind, units } = input
  const left = t.x < me.x
  let best = { angle: left ? Math.PI * 0.75 : Math.PI * 0.25, power: 60, miss: Infinity, direct: false }
  const evalShot = (angle: number, power: number) => {
    const tr = traceShot(mask, me, angle, power, wind, units)
    if (tr.hit === -2) return
    const direct = t.unit !== null && tr.hit === t.unit.id
    const miss = direct ? 0 : hypot(tr.x - t.x, tr.y - t.y)
    const score = miss + friendlyRisk(input, tr.x, tr.y)
    if (score < best.miss) best = { angle, power, miss: score, direct }
  }
  for (let i = 0; i < 12; i++) {
    const elev = 0.2 + (i / 11) * 1.25
    const angle = left ? Math.PI - elev : elev
    for (let power = 12; power <= 100; power += 8) evalShot(angle, power)
  }
  const coarse = best
  for (let da = -0.06; da <= 0.06; da += 0.03) {
    for (let dp = -6; dp <= 6; dp += 2) evalShot(coarse.angle + da, Math.min(100, Math.max(0, coarse.power + dp)))
  }
  return best
}

function chooseWeapon(input: BotInput, r: Rand, t: Target, miss: number): WeaponId {
  const { me, units } = input
  const has = (w: WeaponId) => (me.ammo[w] ?? 0) > 0
  if (has("shield") && me.hp < me.maxHp * 0.35 && r() < 0.4) return "shield"
  const crowd = units.filter((u) => u.alive && u.team !== me.team && Math.abs(u.x - t.x) < 70).length
  const opts: Array<[WeaponId, number]> = [["shell", 3]]
  if (miss > 35 && has("drill")) opts.push(["drill", 4])
  if (miss > 35 && has("buster")) opts.push(["buster", 3])
  if (crowd >= 2 && has("cluster")) opts.push(["cluster", 4])
  if (crowd >= 2 && has("airstrike")) opts.push(["airstrike", 4])
  if (has("mirv")) opts.push(["mirv", crowd >= 2 ? 3 : 1])
  if (has("cluster")) opts.push(["cluster", 1])
  if (has("napalm")) opts.push(["napalm", 1.5])
  if (has("gravity")) opts.push(["gravity", 1])
  if (has("bouncer")) opts.push(["bouncer", 1])
  if (has("airstrike")) opts.push(["airstrike", 1])
  if (t.unit === null) return "shell"
  const total = opts.reduce((s, o) => s + o[1], 0)
  let pick = r() * total
  for (const [w, weight] of opts) {
    pick -= weight
    if (pick <= 0) return w
  }
  return "shell"
}

export function planBot(input: BotInput): BotPlan {
  const r = rng(input.seed ^ 0xb0757)
  const me = input.me
  const t = pickTarget(input, r)
  if (!t) return { angle: me.angle, power: 50, weapon: "shell", tx: me.x, ty: me.y }
  const best = search(input, t)
  const weapon = chooseWeapon(input, r, t, best.miss)
  const err = 1 - Math.min(1, Math.max(0, input.skill))
  const angle = best.angle + gauss(r) * (0.015 + err * 0.07)
  const power = Math.min(100, Math.max(5, best.power + gauss(r) * (1 + err * 7)))
  return { angle, power, weapon: WEAPONS[weapon] ? weapon : "shell", tx: t.x, ty: t.y }
}

// Optional repositioning before aiming: drives with moveUnit (mutates `me`). Returns px moved.
export function botReposition(input: BotInput): number {
  const r = rng(input.seed ^ 0x40e)
  if (r() > 0.35) return 0
  const me = input.me
  let nearest: Unit | null = null
  for (const u of input.units) {
    if (!u.alive || u.team === me.team) continue
    if (!nearest || Math.abs(u.x - me.x) < Math.abs(nearest.x - me.x)) nearest = u
  }
  let dir: -1 | 1 = r() < 0.5 ? -1 : 1
  if (nearest) {
    const away: -1 | 1 = nearest.x < me.x ? 1 : -1
    dir = Math.abs(nearest.x - me.x) < 160 ? away : r() < 0.5 ? away : ((-away) as -1 | 1)
  }
  const x0 = me.x
  const calls = 3 + Math.floor(r() * 10)
  for (let i = 0; i < calls; i++) if (!moveUnit(input.mask, me, dir)) break
  return Math.abs(me.x - x0)
}

// shop picks between battles; mutates the loadout, returns bought item ids
export function botShop(l: Loadout, seed: number): string[] {
  const r = rng(seed ^ 0x5409)
  const bought: string[] = []
  for (let tries = 0; tries < 12; tries++) {
    const affordable = SHOP.filter((i) => i.price <= l.credits)
    if (affordable.length === 0) break
    if (r() < 0.2 && bought.length > 0) break
    const item = affordable[Math.floor(r() * affordable.length)]!
    if (applyPurchase(l, item.id) === null) bought.push(item.id)
  }
  return bought
}
