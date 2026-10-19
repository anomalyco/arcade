import type { AIAgent } from "@arcade/kit/sim/ai"
import { clearLine, distToRect, raycast, type Rect } from "@arcade/kit/sim/geom"
import type { Ledger, StoreState } from "@arcade/kit/sim/ledger"
import { dayCycle } from "../day-cycle"
import { DEFAULT_FLARE_TUNING, FLARE_STRIKE_NOISE, type FlareTuning } from "../flares/flares"
import { pullToward } from "../flares/runtime"
import { sightRects, type Door, type Town } from "../map"
import type { Command, OutbreakSim, SurvivorSlot } from "../sim-types"
import {
  BURN_RING,
  burnZombie,
  CRACK_BEAT,
  CRACK_RING,
  cm,
  crackerPops,
  crackerAt,
  DEFAULT_FIRE_TUNING,
  ds,
  DYN_RING,
  FIRE_RING,
  fireHash,
  fireLit,
  flamerId,
  ringId,
  SCORCH_RING,
  TRAP_RING,
  type FireTuning,
} from "./fire"

/** What the server keeps per survivor (never on the wire: what everyone sees is ledger stores). */
type Seat = { drain: number; refuelUntil: number; beat: number; patchAt: number; scorchAt: number; lastOn: number; emptyAt: number }

/** Per-sim fire state: per-seat spraying, the beats of popping firecrackers, and a deterministic random stream. */
export type FireState = { tuning: FireTuning; seats: Record<string, Seat>; beats: Record<string, number>; rng: number }

export function createFireState(seed: number): FireState {
  return { tuning: DEFAULT_FIRE_TUNING, seats: {}, beats: {}, rng: (seed ^ 0x3c6ef372) >>> 0 || 1 }
}

export function fireTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): FireTuning {
  return (features?.fire as FireTuning | undefined) ?? DEFAULT_FIRE_TUNING
}

function flareTuningOf(features: Readonly<Record<string, Record<string, unknown>>> | undefined): FlareTuning {
  return (features?.flares as FlareTuning | undefined) ?? DEFAULT_FLARE_TUNING
}

/** Mulberry32 on the state, so forks and snapshots stay in step. */
function rand(state: FireState): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0
  let t = state.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const hash01 = fireHash

const seatOf = (state: FireState, id: string): Seat =>
  (state.seats[id] ??= { drain: 0, refuelUntil: -1e9, beat: -1e9, patchAt: -1e9, scorchAt: -1e9, lastOn: -1e9, emptyAt: -1e9 })

const touch = (ledger: Ledger, st: StoreState) => {
  st.rev = ++ledger.rev
}

/**
 * The slot of a ring to reuse: an empty or spent one, else the oldest that `evictable` allows (null if none). Stores are
 * made once and never deleted, so the ledger stays the same size however much burns.
 */
function ringSlot(ledger: Ledger, prefix: string, size: number, spent: (st: StoreState) => boolean, evictable: (st: StoreState) => boolean = () => true): StoreState | null {
  let oldest: StoreState | null = null
  for (let k = 0; k < size; k++) {
    const id = ringId(prefix, k)
    const st = ledger.store(id)
    if (!st) return ledger.createStore({ id, mode: "counters", scope: "shared", at: { x: 0, y: 0 }, initial: {} })
    if (spent(st)) return st
    if (evictable(st) && (!oldest || (st.counts.t ?? 0) < (oldest.counts.t ?? 0))) oldest = st
  }
  return oldest
}

function setRing(ledger: Ledger, st: StoreState, at: { x: number; y: number }, counts: Record<string, number>, owner?: string): void {
  st.at = { x: Number(at.x.toFixed(2)), y: Number(at.y.toFixed(2)) }
  st.counts = counts
  st.owner = owner
  touch(ledger, st)
}

const alive = (a: AIAgent) => a.state !== "dead"

function agentById(sim: OutbreakSim, id: number): AIAgent | undefined {
  for (const a of sim.ai.agents) if (a.id === id) return a
  return undefined
}

function kill(a: AIAgent, by: string): void {
  a.hp = 0
  a.state = "dead"
  a.stateTime = 0
  a.lastHitBy = by
}

function hurtSurvivor(slot: SurvivorSlot, damage: number): void {
  const p = slot.survivor
  if (damage <= 0 || p.vehicleId) return
  p.health = Math.max(0, p.health - damage)
  p.regenCooldown = Math.max(p.regenCooldown ?? 0, 0.6)
}

/** Where a throw from `slot` lands: along the aim, short of the first wall. */
function landing(sim: OutbreakSim, slot: SurvivorSlot, range: number): { x: number; y: number; dx: number; dy: number; reach: number } {
  const p = slot.survivor
  const dx = Math.cos(p.aim)
  const dy = Math.sin(p.aim)
  const reach = Math.max(0.6, Math.min(range, raycast(p.x, p.y, dx, dy, sightRects(sim.town), range)) - 0.3)
  return { x: p.x + dx * reach, y: p.y + dy * reach, dx, dy, reach }
}

// ── Burning ────────────────────────────────────────────────────────────────────────────────────────────────────────

const burnFree = (time: number) => (st: StoreState) => !st.counts.z || (!st.counts.dead && ds(time) >= (st.counts.until ?? 0))

/**
 * Sets a zombie alight (or keeps it burning): it lurches in panic and burns for `burnSeconds`. Returns false when every
 * burn slot is already on a burning zombie (the bound on how much can burn at once).
 */
export function ignite(sim: OutbreakSim, a: AIAgent, by: string, t: FireTuning): boolean {
  if (!alive(a)) return false
  const ledger = sim.progression.ledger
  const now = ds(sim.time)
  for (let k = 0; k < BURN_RING; k++) {
    const st = ledger.store(ringId("burn", k))
    if (!st || burnZombie(st) !== a.id || st.counts.dead || now >= (st.counts.until ?? 0)) continue
    const until = ds(sim.time + t.burnSeconds)
    // Topping a burn up only goes on the wire once it has burnt half a second down.
    if (until - (st.counts.until ?? 0) >= 5) {
      st.counts.until = until
      touch(ledger, st)
    }
    return true
  }
  const st = ringSlot(ledger, "burn", BURN_RING, burnFree(sim.time), (s) => Boolean(s.counts.dead) || now >= (s.counts.until ?? 0))
  if (!st) return false
  setRing(ledger, st, { x: a.x, y: a.y }, { z: a.id + 1, t: now, until: ds(sim.time + t.burnSeconds) }, by)
  a.lastHitBy = by
  a.awareness = 1
  panic(a, 0.55, hash01(a.id, now) * Math.PI * 2, 2.2)
  return true
}

function panic(a: AIAgent, seconds: number, angle: number, speed: number): void {
  if (a.state === "knockdown" || a.state === "crawler" || a.state === "dead" || a.state === "bash") return
  a.state = "stagger"
  a.stateTime = 0
  a.timer = seconds
  a.staggerVx = Math.cos(angle) * speed
  a.staggerVy = Math.sin(angle) * speed
}

/** Once a tick, after the crowd moved: the burning burn down, lurch, fall charred, and set alight who they brush. */
function stepBurning(sim: OutbreakSim, state: FireState, t: FireTuning, dt: number): void {
  const ledger = sim.progression.ledger
  const now = ds(sim.time)
  for (let k = 0; k < BURN_RING; k++) {
    const st = ledger.store(ringId("burn", k))
    if (!st || !st.counts.z || st.counts.dead || now >= (st.counts.until ?? 0)) continue
    const a = agentById(sim, burnZombie(st))
    if (!a) {
      st.counts = {}
      touch(ledger, st)
      continue
    }
    if (!alive(a)) {
      st.counts.dead = Math.max(1, now)
      touch(ledger, st)
      continue
    }
    const by = st.owner ?? "fire"
    a.hp = Math.max(0, a.hp - t.burnDps * dt)
    a.hitFlash = Math.max(a.hitFlash, 0.25)
    if (a.hp <= 0) {
      kill(a, by)
      st.counts.dead = Math.max(1, now)
      touch(ledger, st)
      continue
    }
    const beat = Math.floor((sim.time - (st.counts.t ?? 0) / 10) / Math.max(0.2, t.burnPanic))
    const prevBeat = Math.floor((sim.time - dt - (st.counts.t ?? 0) / 10) / Math.max(0.2, t.burnPanic))
    if (beat > prevBeat) panic(a, 0.32, hash01(a.id, beat + 17) * Math.PI * 2, 1.8)
    if (t.burnSpread <= 0 || t.burnSpreadRate <= 0) continue
    for (const b of sim.ai.agents) {
      if (b === a || !alive(b) || Math.abs(b.x - a.x) > t.burnSpread || Math.abs(b.y - a.y) > t.burnSpread) continue
      if (Math.hypot(b.x - a.x, b.y - a.y) > t.burnSpread) continue
      if (rand(state) < t.burnSpreadRate * dt) ignite(sim, b, by, t)
    }
  }
}

// ── Fire on the ground and scorch marks ───────────────────────────────────────────────────────────────────────────

/** Puts fire on the ground: `src` 0 for the stream, 1 for a molotov, 2 for fire spreading. Returns the store. */
export function placeFire(sim: OutbreakSim, x: number, y: number, radius: number, seconds: number, src: number, by?: string): StoreState | null {
  const ledger = sim.progression.ledger
  const now = ds(sim.time)
  const st = ringSlot(ledger, "fire", FIRE_RING, (s) => now >= (s.counts.until ?? 0))
  if (!st) return null
  setRing(ledger, st, { x, y }, { t: now, until: ds(sim.time + seconds), r: cm(radius), src }, by)
  return st
}

/** Leaves a scorch mark (or, with `crater`, a blast crater). */
export function placeScorch(sim: OutbreakSim, x: number, y: number, radius: number, crater = false): void {
  const ledger = sim.progression.ledger
  const st = ringSlot(ledger, "scorch", SCORCH_RING, (s) => !s.counts.r)
  if (!st) return
  setRing(ledger, st, { x, y }, { t: Math.max(1, ds(sim.time)), r: cm(radius), ...(crater ? { crater: 1 } : {}) })
}

function stepGroundFire(sim: OutbreakSim, state: FireState, t: FireTuning, dt: number): void {
  const ledger = sim.progression.ledger
  const blockers = t.fireSpread > 0 ? sightRects(sim.town) : null
  for (let k = 0; k < FIRE_RING; k++) {
    const st = ledger.store(ringId("fire", k))
    if (!st || !fireLit(st, sim.time)) continue
    const { x, y } = st.at!
    const r = (st.counts.r ?? 0) / 100
    const by = st.owner ?? "fire"
    for (const a of sim.ai.agents) {
      if (!alive(a) || Math.abs(a.x - x) > r || Math.abs(a.y - y) > r || Math.hypot(a.x - x, a.y - y) > r) continue
      ignite(sim, a, by, t)
    }
    for (const s of sim.slots) {
      const p = s.survivor
      if (Math.hypot(p.x - x, p.y - y) <= r * 0.85) hurtSurvivor(s, t.groundFireDps * dt)
    }
    // Lab only: fire creeping across the ground beside itself, still bounded by the ring.
    if (blockers && rand(state) < t.fireSpread * dt) {
      const ang = rand(state) * Math.PI * 2
      const nx = x + Math.cos(ang) * r * 1.6
      const ny = y + Math.sin(ang) * r * 1.6
      if (clearLine(x, y, nx, ny, blockers)) placeFire(sim, nx, ny, Math.max(0.5, r * 0.9), t.groundFireSeconds * 1.4, 2, by)
    }
  }
}

// ── The flamethrower ─────────────────────────────────────────────────────────────────────────────────────────────

function setFlamer(sim: OutbreakSim, seat: string, on: boolean): void {
  const ledger = sim.progression.ledger
  const id = flamerId(seat)
  let st = ledger.store(id)
  if (!st) {
    if (!on) return
    st = ledger.createStore({ id, mode: "counters", scope: "shared", owner: seat, initial: {} })
  }
  if (Boolean(st.counts.on) === on) return
  st.counts = on ? { on: 1, t: Math.max(1, ds(sim.time)) } : {}
  touch(ledger, st)
}

/** A stream's reach from `(x, y)` along `aim`: its range, cut short by the first wall (the client draws the same). */
export function reachFrom(town: Town, x: number, y: number, aim: number, range: number): number {
  return Math.max(0.4, Math.min(range, raycast(x, y, Math.cos(aim), Math.sin(aim), sightRects(town), range)))
}

/** The stream's reach from `slot` this tick. */
export function streamReach(sim: OutbreakSim, slot: SurvivorSlot, t: FireTuning): number {
  const p = slot.survivor
  return reachFrom(sim.town, p.x, p.y, p.aim, t.flameRange)
}

/** Whether `(x, y)` is in the cone of a stream from `p` reaching `reach`, with `pad` metres of slack for a body. */
export function inStream(p: { x: number; y: number; aim: number }, x: number, y: number, reach: number, coneDeg: number, pad: number): boolean {
  const rx = x - p.x
  const ry = y - p.y
  const along = rx * Math.cos(p.aim) + ry * Math.sin(p.aim)
  if (along < -0.2 || along > reach + pad) return false
  const side = Math.abs(-rx * Math.sin(p.aim) + ry * Math.cos(p.aim))
  return side <= Math.max(0.25, along) * Math.tan((coneDeg * Math.PI) / 180) + pad
}

/** Refuels from a gas can on the belt. */
function refuel(sim: OutbreakSim, slot: SurvivorSlot, seat: Seat): boolean {
  const progression = sim.progression
  const res = progression.ledger.apply({ kind: "run", actor: slot.id, rule: "refuel:flamethrower" })
  if (!res.ok) {
    if (sim.time - seat.emptyAt > 2.5) {
      seat.emptyAt = sim.time
      progression.notify(slot, "Out of fuel. A gas can refills it", "warning", "fuel")
    }
    return false
  }
  progression.ledger.apply({ kind: "setCharge", actor: slot.id, item: "flamethrower", charge: 100 })
  seat.refuelUntil = sim.time + 0.9
  seat.drain = 0
  progression.notify(slot, "Refuelled", "result", "fuel")
  progression.project(slot)
  return true
}

/**
 * One command of a survivor holding the flamethrower: the button held sprays (draining fuel, setting the dead in the
 * cone alight, burning teammates in it, leaving fire and scorch where the stream lands, roaring and lighting up the
 * street); R or an empty tank refuels from a gas can.
 */
export function stepFlamethrower(sim: OutbreakSim, slot: SurvivorSlot, command: Command, dt: number, state: FireState, t: FireTuning): void {
  const progression = sim.progression
  const seat = seatOf(state, slot.id)
  const held = progression.selected(slot.id)
  const p = slot.survivor
  const holding = held?.item === "flamethrower"
  const fuel = holding ? (held!.charge ?? 0) : 0
  const pressing = holding && Boolean(command.fireHeld ?? command.fire)
  if (holding && sim.time >= seat.refuelUntil && fuel < 100 && (command.reload || (pressing && fuel <= 0 && command.fire))) refuel(sim, slot, seat)
  const on = pressing && fuel > 0 && sim.time >= seat.refuelUntil && !p.vehicleId && !p.vault && p.health > 0
  if (!on) {
    if (seat.lastOn < sim.time) setFlamer(sim, slot.id, false)
    return
  }
  seat.lastOn = sim.time
  setFlamer(sim, slot.id, true)
  seat.drain += (dt * 100) / Math.max(0.5, t.flameFuelSeconds)
  const whole = Math.floor(seat.drain)
  if (whole > 0) {
    seat.drain -= whole
    progression.ledger.apply({ kind: "setCharge", actor: slot.id, item: "flamethrower", charge: Math.max(0, fuel - whole) })
  }
  p.channel = null
  const reach = streamReach(sim, slot, t)
  const blockers = sightRects(sim.town)
  for (const a of sim.ai.agents) {
    if (!alive(a) || !inStream(p, a.x, a.y, reach, t.flameCone, 0.35) || !clearLine(p.x, p.y, a.x, a.y, blockers)) continue
    a.hp = Math.max(0, a.hp - t.flameDps * dt)
    a.hitFlash = Math.max(a.hitFlash, 0.3)
    // Alight first, so one the stream kills outright still falls charred.
    ignite(sim, a, slot.id, t)
    if (a.hp <= 0) kill(a, slot.id)
  }
  for (const other of sim.slots) {
    if (other === slot) continue
    const o = other.survivor
    if (inStream(p, o.x, o.y, reach, t.flameCone, 0.25) && clearLine(p.x, p.y, o.x, o.y, blockers)) hurtSurvivor(other, t.flameFriendlyDps * dt)
  }
  const dx = Math.cos(p.aim)
  const dy = Math.sin(p.aim)
  // Fire licking along the ground where the stream comes down, and the black it leaves.
  if (sim.time - seat.patchAt >= 0.14) {
    seat.patchAt = sim.time
    const along = reach * (0.55 + 0.45 * rand(state)) - 0.2
    const side = (rand(state) - 0.5) * along * Math.tan((t.flameCone * Math.PI) / 180) * 1.2
    placeFire(sim, p.x + dx * along - dy * side, p.y + dy * along + dx * side, 0.55 + 0.25 * rand(state), t.groundFireSeconds, 0, slot.id)
  }
  if (sim.time - seat.scorchAt >= 0.5) {
    seat.scorchAt = sim.time
    const along = reach * (0.45 + 0.5 * rand(state))
    placeScorch(sim, p.x + dx * along, p.y + dy * along, 0.6 + 0.4 * rand(state))
  }
  // The roar carries; the light pulls in the dead who see it (most at night).
  if (sim.time - seat.beat >= 0.5) {
    seat.beat = sim.time
    p.noise = Math.max(p.noise, t.flameNoise)
    sim.ai.emitNoise(p.x, p.y, t.flameNoise, "flamethrower", sim.time, slot.id, 1.8)
    if (t.flameReach > 0) pullToward(sim, blockers, p.x + dx * reach * 0.6, p.y + dy * reach * 0.6, t.flameReach * (0.45 + 0.55 * dayCycle(sim.hour).darkness))
  }
}

// ── Thrown things: dynamite, firecrackers, molotovs ─────────────────────────────────────────────────────────────

export function throwDynamite(sim: OutbreakSim, slot: SurvivorSlot, t: FireTuning): boolean {
  const ledger = sim.progression.ledger
  if (!ledger.apply({ kind: "run", actor: slot.id, rule: "throw:dynamite" }).ok) return false
  const p = slot.survivor
  const at = landing(sim, slot, t.dynThrow)
  const now = ds(sim.time)
  const st = ringSlot(ledger, "dyn", DYN_RING, (s) => !s.counts.t || (Boolean(s.counts.done) && now - (s.counts.boom ?? 0) > 30), (s) => Boolean(s.counts.done))
  if (!st) {
    // Every ring slot holds a lit fuse: this one goes off in hand-throw range at once rather than vanish.
    explode(sim, at.x, at.y, slot.id, t)
    return true
  }
  setRing(ledger, st, at, { t: Math.max(1, now), boom: ds(sim.time + t.dynFuse), fx: cm(p.x - at.x), fy: cm(p.y - at.y) }, slot.id)
  sim.ai.emitNoise(p.x, p.y, FLARE_STRIKE_NOISE, "fuse", sim.time, slot.id, 0.5)
  sim.progression.project(slot)
  return true
}

/**
 * The blast: the dead in the radius are thrown down (the near ones killed, and set alight), survivors in it are hurt
 * too, barricades and doors near it are blown in, a crater is left, and the whole town hears it. Returns whether
 * doors or barricades changed.
 */
export function explode(sim: OutbreakSim, x: number, y: number, by: string, t: FireTuning): boolean {
  const R = Math.max(0.5, t.dynRadius)
  const blockers = sightRects(sim.town)
  sim.ai.emitNoise(x, y, t.dynNoise, "explosion", sim.time, by, 3)
  for (const a of sim.ai.agents) {
    if (!alive(a)) continue
    const d = Math.hypot(a.x - x, a.y - y)
    if (d > R || !clearLine(x, y, a.x, a.y, blockers)) continue
    const f = 1 - d / R
    const ang = d > 0.05 ? Math.atan2(a.y - y, a.x - x) : hash01(a.id, 3) * Math.PI * 2
    const push = t.dynKnockback * (0.35 + 0.65 * f)
    a.hp = Math.max(0, a.hp - t.dynDamage * f)
    // The near ones are set alight (before the blast kills them, so they fall charred).
    if (f > 0.4) ignite(sim, a, by, t)
    a.hitFlash = 1
    a.awareness = 1
    a.lastHitBy = by
    a.staggerVx = Math.cos(ang) * push
    a.staggerVy = Math.sin(ang) * push
    if (a.hp <= 0) {
      kill(a, by)
      a.staggerVx = Math.cos(ang) * push * 1.3
      a.staggerVy = Math.sin(ang) * push * 1.3
    } else if (a.state !== "crawler") {
      a.state = "knockdown"
      a.stateTime = 0
      a.timer = 1.6 + f * 1.4
    }
  }
  for (const s of sim.slots) {
    const p = s.survivor
    const d = Math.hypot(p.x - x, p.y - y)
    if (d > R || !clearLine(x, y, p.x, p.y, blockers)) continue
    hurtSurvivor(s, t.dynDamage * 0.3 * (1 - d / R))
    p.stamina = Math.max(0, p.stamina - 0.4 * (1 - d / R))
  }
  let topology = false
  const doors = new Set(sim.town.doors)
  for (const o of [...sim.town.doors, ...sim.town.windows]) {
    const d = distToRect(x, y, o.rect)
    if (d > R) continue
    const pst = sim.ai.portalStates.get(o.id)
    if (!pst) continue
    const dmg = t.dynBreach * (1 - d / R)
    pst.lastBashTime = sim.time
    if (pst.barricadePlanks > 0) {
      const perPlank = pst.barricadeHp / pst.barricadePlanks
      pst.barricadeHp = Math.max(0, pst.barricadeHp - dmg)
      const planks = Math.max(0, Math.min(pst.barricadePlanks, Math.ceil(pst.barricadeHp / perPlank - 1e-9)))
      if (planks !== pst.barricadePlanks) {
        pst.barricadePlanks = planks
        topology = true
      }
    } else if (doors.has(o as Door) && !o.open) {
      // Blown in: a door the blast reaches with enough left in it, locked or not.
      const door = o as Door
      pst.integrity = Math.max(0, pst.integrity - dmg)
      if (pst.integrity <= 0) {
        door.open = true
        door.locked = false
        door.keyed = false
        pst.integrity = 100
        topology = true
      }
    }
  }
  placeScorch(sim, x, y, R * 0.42, true)
  for (let i = 0; i < 3; i++) {
    const ang = hash01(Math.round(x * 100), i) * Math.PI * 2
    const r = R * 0.25 * (0.6 + hash01(Math.round(y * 100), i))
    placeFire(sim, x + Math.cos(ang) * r, y + Math.sin(ang) * r, 0.6, 1.4 + i * 0.4, 2, by)
  }
  return topology
}

function stepDynamite(sim: OutbreakSim, t: FireTuning): boolean {
  const ledger = sim.progression.ledger
  const now = ds(sim.time)
  let topology = false
  for (let k = 0; k < DYN_RING; k++) {
    const st = ledger.store(ringId("dyn", k))
    if (!st || !st.counts.t || st.counts.done || now < (st.counts.boom ?? 0)) continue
    st.counts.done = 1
    touch(ledger, st)
    topology = explode(sim, st.at!.x, st.at!.y, st.owner ?? "fire", t) || topology
  }
  return topology
}

const CRACKER_THROW = 10

export function throwFirecrackers(sim: OutbreakSim, slot: SurvivorSlot, t: FireTuning): boolean {
  const ledger = sim.progression.ledger
  if (!ledger.apply({ kind: "run", actor: slot.id, rule: "throw:firecrackers" }).ok) return false
  const at = landing(sim, slot, CRACKER_THROW)
  const travel = Math.max(0, Math.min(t.crackTravel, raycast(at.x, at.y, at.dx, at.dy, sightRects(sim.town), t.crackTravel) - 0.3))
  const now = ds(sim.time)
  const st = ringSlot(ledger, "crack", CRACK_RING, (s) => now >= (s.counts.until ?? 0))
  if (st) setRing(ledger, st, at, { t: Math.max(1, now), until: ds(sim.time + t.crackSeconds), ex: cm(at.dx * travel), ey: cm(at.dy * travel) }, slot.id)
  sim.progression.project(slot)
  return true
}

/** Popping firecrackers: on each irregular beat a burst of pops where the string has skittered to. */
function stepFirecrackers(sim: OutbreakSim, state: FireState, t: FireTuning): void {
  const ledger = sim.progression.ledger
  for (let k = 0; k < CRACK_RING; k++) {
    const id = ringId("crack", k)
    const st = ledger.store(id)
    if (!st || !fireLit(st, sim.time)) {
      delete state.beats[id]
      continue
    }
    const since = sim.time - (st.counts.t ?? 0) / 10
    const due = Math.floor(since / CRACK_BEAT)
    if ((state.beats[id] ?? -1) >= due) continue
    state.beats[id] = due
    // Irregular: skip about a third of the beats.
    if (!crackerPops(st.counts.t ?? 0, due)) continue
    const at = crackerAt(st, sim.time)
    sim.ai.emitNoise(at.x, at.y, t.crackNoise, "firecracker", sim.time, st.owner ?? "fire", 1.5)
  }
}

export function throwMolotov(sim: OutbreakSim, slot: SurvivorSlot, t: FireTuning): boolean {
  const ledger = sim.progression.ledger
  if (!ledger.apply({ kind: "run", actor: slot.id, rule: "throw:molotov" }).ok) return false
  const p = slot.survivor
  let at = landing(sim, slot, t.molotovThrow)
  // It breaks on the first of the dead in its path.
  for (const a of sim.ai.agents) {
    if (!alive(a)) continue
    const rx = a.x - p.x
    const ry = a.y - p.y
    const along = rx * at.dx + ry * at.dy
    if (along < 1 || along > at.reach) continue
    if (Math.abs(-rx * at.dy + ry * at.dx) < 0.45) at = { ...at, x: p.x + at.dx * along, y: p.y + at.dy * along, reach: along }
  }
  sim.ai.emitNoise(at.x, at.y, 14, "glass", sim.time, slot.id, 1.4)
  placeFire(sim, at.x, at.y, t.molotovRadius, t.molotovSeconds, 1, slot.id)
  placeScorch(sim, at.x, at.y, t.molotovRadius * 1.05)
  sim.progression.project(slot)
  return true
}

// ── The flare gun and the bear trap ──────────────────────────────────────────────────────────────────────────────

function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number {
  const fx = ox - cx
  const fy = oy - cy
  const b = fx * dx + fy * dy
  const c = fx * fx + fy * fy - r * r
  const h = b * b - c
  if (h < 0) return Infinity
  const tt = -b - Math.sqrt(h)
  return tt >= 0 ? tt : Infinity
}

/** Fires the flare gun: the flare sets the first of the dead it hits alight and burns where it lands (a road flare). */
export function fireFlareGun(sim: OutbreakSim, slot: SurvivorSlot, t: FireTuning, flares: FlareTuning): boolean {
  const progression = sim.progression
  const ledger = progression.ledger
  const held = progression.selected(slot.id)
  if (held?.item !== "flare-gun") return false
  const shots = held.charge ?? 0
  if (shots <= 0) return false
  const p = slot.survivor
  const dx = Math.cos(p.aim)
  const dy = Math.sin(p.aim)
  const ox = p.x + dx * 0.35
  const oy = p.y + dy * 0.35
  let reach = Math.max(0.4, Math.min(t.flareGunRange, raycast(ox, oy, dx, dy, sightRects(sim.town), t.flareGunRange)) - 0.25)
  let hit: AIAgent | null = null
  for (const a of sim.ai.agents) {
    if (!alive(a)) continue
    const d = rayCircle(ox, oy, dx, dy, a.x, a.y, 0.42)
    if (d < reach) {
      reach = d
      hit = a
    }
  }
  if (hit) {
    hit.hp = Math.max(0, hit.hp - 35)
    hit.hitFlash = 1
    if (hit.hp <= 0) kill(hit, slot.id)
    ignite(sim, hit, slot.id, t)
  }
  const x = ox + dx * reach
  const y = oy + dy * reach
  const now = ds(sim.time)
  const flare = ledger.createStore({
    id: `flare:${progression.takeId()}`,
    mode: "counters",
    scope: "shared",
    owner: slot.id,
    at: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) },
    initial: { t: now, until: ds(sim.time + flares.flareSeconds), gun: 1 },
  })
  // Where it was fired from, for the streak (counts set after creation may be negative).
  flare.counts.fx = cm(ox - x)
  flare.counts.fy = cm(oy - y)
  p.recoil = 1
  p.noise = Math.max(p.noise, 16)
  sim.ai.emitNoise(p.x, p.y, 16, "gunshot", sim.time, slot.id, 1.6)
  if (shots - 1 <= 0) {
    // The last shell: the gun is thrown away rather than carried empty.
    const hb = progression.hotbar(slot.id)
    if (hb) {
      hb.slots[hb.selected] = null
      hb.rev = ++ledger.rev
    }
    progression.notify(slot, "Last flare", "info", "flare-gun")
  } else ledger.apply({ kind: "setCharge", actor: slot.id, item: "flare-gun", charge: shots - 1 })
  progression.project(slot)
  return true
}

/** Sets a bear trap on the ground just ahead. */
export function setBearTrap(sim: OutbreakSim, slot: SurvivorSlot): boolean {
  const ledger = sim.progression.ledger
  if (!ledger.apply({ kind: "run", actor: slot.id, rule: "set:bear-trap" }).ok) return false
  const at = landing(sim, slot, 0.9)
  const now = ds(sim.time)
  const st = ringSlot(ledger, "trap", TRAP_RING, (s) => !s.counts.t || (Boolean(s.counts.snap) && now >= (s.counts.until ?? 0)))
  if (st) setRing(ledger, st, at, { t: Math.max(1, now) }, slot.id)
  sim.ai.emitNoise(at.x, at.y, 4, "trap", sim.time, slot.id, 0.6)
  sim.progression.project(slot)
  return true
}

/** Set traps snap on the first of the dead to step in; a sprung trap holds its catch where it stands. */
function stepTraps(sim: OutbreakSim, t: FireTuning): void {
  const ledger = sim.progression.ledger
  const now = ds(sim.time)
  for (let k = 0; k < TRAP_RING; k++) {
    const st = ledger.store(ringId("trap", k))
    if (!st?.at || !st.counts.t) continue
    const { x, y } = st.at
    if (!st.counts.snap) {
      for (const a of sim.ai.agents) {
        if (!alive(a) || Math.abs(a.x - x) > 0.5 || Math.abs(a.y - y) > 0.5 || Math.hypot(a.x - x, a.y - y) > 0.45) continue
        st.counts.z = a.id + 1
        st.counts.snap = Math.max(1, now)
        st.counts.until = ds(sim.time + t.trapHold)
        touch(ledger, st)
        a.hp = Math.max(0, a.hp - t.trapDamage)
        a.hitFlash = 1
        a.lastHitBy = st.owner ?? "trap"
        if (a.hp <= 0) kill(a, st.owner ?? "trap")
        sim.ai.emitNoise(x, y, 9, "trap", sim.time, st.owner ?? "trap", 1.2)
        break
      }
      continue
    }
    if (now >= (st.counts.until ?? 0)) continue
    const a = agentById(sim, (st.counts.z ?? 0) - 1)
    if (!a || !alive(a)) continue
    a.x = x
    a.y = y
    a.vx = 0
    a.vy = 0
    a.staggerVx = 0
    a.staggerVy = 0
  }
}

// ── Per tick ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A survivor's command: whichever fire & explosives item is in hand. */
export function stepFireActions(sim: OutbreakSim, slot: SurvivorSlot, command: Command, dt: number, state: FireState, features: Readonly<Record<string, Record<string, unknown>>> | undefined): void {
  const t = state.tuning
  const item = sim.progression.selected(slot.id)?.item
  stepFlamethrower(sim, slot, command, dt, state, t)
  if (!command.fire || slot.survivor.vehicleId) return
  if (item === "dynamite") throwDynamite(sim, slot, t)
  else if (item === "firecrackers") throwFirecrackers(sim, slot, t)
  else if (item === "molotov") throwMolotov(sim, slot, t)
  else if (item === "flare-gun") fireFlareGun(sim, slot, t, flareTuningOf(features))
  else if (item === "bear-trap") setBearTrap(sim, slot)
}

/** Fuses and blasts (doors and barricades may change, so before the crowd steps). */
export function stepFireWorld(sim: OutbreakSim, state: FireState): boolean {
  const t = state.tuning
  // A seat that stopped sending commands mid-spray (gone, or in a car) stops spraying.
  for (const st of sim.progression.ledger.stores.values()) {
    if (!st.id.startsWith("flamer:") || !st.counts.on) continue
    const seat = st.id.slice(7)
    if ((state.seats[seat]?.lastOn ?? -1e9) < sim.time - 0.25) setFlamer(sim, seat, false)
  }
  stepFirecrackers(sim, state, t)
  return stepDynamite(sim, t)
}

/** After the crowd moved: burning, fire on the ground and traps. */
export function stepFireLate(sim: OutbreakSim, state: FireState, dt: number): void {
  const t = state.tuning
  stepBurning(sim, state, t, dt)
  stepGroundFire(sim, state, t, dt)
  stepTraps(sim, t)
}
