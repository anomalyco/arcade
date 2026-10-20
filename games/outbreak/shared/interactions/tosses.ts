import type { AIAgent } from "@arcade/kit/sim/ai"
import type { Rect } from "@arcade/kit/sim/geom"
import type { StoreState } from "@arcade/kit/sim/ledger"
import { sightRects, solidRects, type WindowOpening } from "../map"
import type { Command, OutbreakSim, SurvivorSlot } from "../sim-types"
import { throwableSite } from "./toss-sites"
import { DEFAULT_INTERACTIONS_TUNING, type InteractionsTuning } from "./tuning"
import {
  isThrowable,
  isTossStore,
  OUT_BONK,
  OUT_HIT,
  OUT_SHATTER,
  OUT_WALL,
  OUT_WINDOW,
  planToss,
  ROLL_SECONDS,
  THROWABLE_ITEMS,
  THROWABLES,
  throwPower,
  TOSS_RING,
  tossId,
  tossItem,
  type ThrowableItem,
  type ThrowableDef,
  type TossPlan,
} from "./throwables"

export type TossState = {
  /** Sim time each seat started winding up, while the button is held with a throwable in hand. */
  wind: Record<string, number>
  /** Houses whose throwable has been put out (once each, so one picked up never comes back). */
  seeded: Record<string, 1>
  /** The town's buildings when last seeded, to skip the work while nothing streamed. */
  siteKey: string
}

export const createTossState = (): TossState => ({ wind: {}, seeded: {}, siteKey: "" })

/** Puts each streamed-in house's throwable out, once (`sites.ts`). */
export function seedThrowables(sim: OutbreakSim, state: TossState, t: InteractionsTuning): void {
  const town = sim.town
  const key = `${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}:${t.throwYard}`
  if (key === state.siteKey) return
  state.siteKey = key
  const ledger = sim.progression.ledger
  const solids = solidRects(town)
  for (const b of town.buildings) {
    if (state.seeded[b.id]) continue
    state.seeded[b.id] = 1
    const site = throwableSite(town, b, t.throwYard, solids)
    if (!site || ledger.store(site.id)) continue
    ledger.createStore({ id: site.id, mode: "slots", scope: "shared", size: 1, at: { x: site.x, y: site.y }, initial: [{ item: site.item, count: 1 }] })
  }
}

const ds = (s: number) => Math.round(s * 10)
const cm = (m: number) => Math.round(m * 100) || 0
/** How far a window breaking carries. */
const WINDOW_NOISE = 14

/** Walls a throw stops at (walls, shut doors, boarded windows) and the shut windows it may go through. */
export function tossWorld(sim: OutbreakSim): { walls: Rect[]; windows: WindowOpening[] } {
  const walls = [...sightRects(sim.town)]
  // Abandoned cars catch a throw too (and their alarms go off).
  for (const car of sim.progression.verbs.cars) walls.push(car.rect)
  const windows: WindowOpening[] = []
  for (const w of sim.town.windows) {
    if (w.open) continue
    if (w.boarded || sim.ai.getBarricadePlanks(w.id) > 0) walls.push(w.rect)
    else windows.push(w)
  }
  return { walls, windows }
}

/** Where `slot` would throw what it holds now at `power` (for the arc preview and the throw itself). */
export function planFor(sim: OutbreakSim, slot: SurvivorSlot, item: ThrowableItem, power: number, t: InteractionsTuning): TossPlan {
  const p = slot.survivor
  const { walls, windows } = tossWorld(sim)
  const def = defOf(sim, item)
  return planToss(p.x, p.y, p.aim, power, def, t.throwRange, walls, windows, sim.ai.agents)
}

/** A throwable's rules; a bottle's reach and noise are progression's (`bottleRange`, `bottleNoise`), as before. */
function defOf(sim: OutbreakSim, item: ThrowableItem): ThrowableDef {
  if (item !== "bottle") return THROWABLES[item]
  const t = sim.progression.tuning
  return { ...THROWABLES.bottle, range: t.bottleRange, noise: t.bottleNoise }
}

function ensureRule(sim: OutbreakSim, item: ThrowableItem): string {
  const id = `throw:${item}`
  const rules = sim.progression.ledger.rules
  if (!rules.has(id)) rules.set(id, { id, label: "Throw", consume: { [item]: 1 } })
  return id
}

function ringSlot(sim: OutbreakSim): StoreState {
  const ledger = sim.progression.ledger
  let oldest: StoreState | null = null
  for (let k = 0; k < TOSS_RING; k++) {
    const id = tossId(k)
    const st = ledger.store(id)
    if (!st) return ledger.createStore({ id, mode: "counters", scope: "shared", at: { x: 0, y: 0 }, initial: {} })
    if (!st.counts.t || (st.counts.done ?? 0) >= 2) return st
    if (!oldest || (st.counts.t ?? 0) < (oldest.counts.t ?? 0)) oldest = st
  }
  // Every slot holds a throw in the air: the oldest lands at once.
  landNow(sim, oldest!)
  return oldest!
}

/** Throws what `slot` holds at `power`. Returns whether it went. */
export function throwHeld(sim: OutbreakSim, slot: SurvivorSlot, power: number, t: InteractionsTuning): boolean {
  const item = sim.progression.selected(slot.id)?.item
  if (!isThrowable(item)) return false
  const ledger = sim.progression.ledger
  const plan = planFor(sim, slot, item, power, t)
  const st = ringSlot(sim)
  if (!ledger.apply({ kind: "run", actor: slot.id, rule: ensureRule(sim, item) }).ok) return false
  const p = slot.survivor
  const def = defOf(sim, item)
  let out = 0
  if (plan.hit) out |= OUT_HIT | (def.bonk && plan.head ? OUT_BONK : 0)
  if (plan.window && def.breaksWindows) out |= OUT_WINDOW
  if (plan.wall) out |= OUT_WALL
  if (def.shatters) out |= OUT_SHATTER
  st.at = { x: Number(plan.rx.toFixed(2)), y: Number(plan.ry.toFixed(2)) }
  st.counts = {
    t: Math.max(1, ds(sim.time)),
    fl: Math.max(1, ds(plan.flight)),
    it: THROWABLE_ITEMS.indexOf(item),
    sx: cm(p.x + Math.cos(p.aim) * 0.35 - st.at.x),
    sy: cm(p.y + Math.sin(p.aim) * 0.35 - st.at.y),
    ix: cm(plan.ix - st.at.x),
    iy: cm(plan.iy - st.at.y),
    pk: cm(plan.peak),
    out,
    z: plan.hit ? plan.hit.id + 1 : 0,
    w: plan.window && def.breaksWindows ? sim.town.windows.indexOf(plan.window) + 1 : 0,
    done: 0,
  }
  st.owner = slot.id
  st.rev = ++ledger.rev
  sim.progression.project(slot)
  return true
}

function agentById(sim: OutbreakSim, id: number): AIAgent | undefined {
  for (const a of sim.ai.agents) if (a.id === id) return a
  return undefined
}

/** The impact: the one it hit is hurt, staggered or bonked down; a window breaks; the landing is heard. */
function impact(sim: OutbreakSim, st: StoreState, t: InteractionsTuning): boolean {
  const item = tossItem(st)
  const def = defOf(sim, item)
  const out = st.counts.out ?? 0
  const at = st.at!
  const ix = at.x + (st.counts.ix ?? 0) / 100
  const iy = at.y + (st.counts.iy ?? 0) / 100
  const by = st.owner ?? "throw"
  const throwNoise = Math.max(0, t.throwNoise)
  let topology = false
  if (out & OUT_HIT) {
    const a = agentById(sim, (st.counts.z ?? 0) - 1)
    if (a && a.state !== "dead" && Math.hypot(a.x - ix, a.y - iy) < 1.6) {
      const sx = at.x + (st.counts.sx ?? 0) / 100
      const sy = at.y + (st.counts.sy ?? 0) / 100
      const ang = Math.atan2(iy - sy, ix - sx)
      a.hp = Math.max(0, a.hp - def.damage * Math.max(0, t.throwDamage))
      a.hitFlash = 1
      a.lastHitBy = by
      a.awareness = Math.max(a.awareness, 0.7)
      a.targetX = sx
      a.targetY = sy
      if (a.hp <= 0) {
        a.state = "dead"
        a.stateTime = 0
        a.staggerVx = Math.cos(ang) * 2.4
        a.staggerVy = Math.sin(ang) * 2.4
      } else if (a.state !== "crawler" && a.state !== "knockdown") {
        a.state = out & OUT_BONK ? "knockdown" : "stagger"
        a.stateTime = 0
        a.timer = def.stagger
        a.staggerVx = Math.cos(ang) * (out & OUT_BONK ? 1.6 : 1.1)
        a.staggerVy = Math.sin(ang) * (out & OUT_BONK ? 1.6 : 1.1)
      }
    }
  }
  if (out & OUT_WINDOW) {
    const w = sim.town.windows[(st.counts.w ?? 0) - 1]
    if (w && !w.open && !w.boarded && sim.ai.getBarricadePlanks(w.id) === 0) {
      w.open = true
      topology = true
      sim.ai.emitNoise(ix, iy, WINDOW_NOISE * throwNoise, "glass", sim.time, by, 1.6)
      glassAt(sim, ix, iy)
    }
  }
  if (out & OUT_SHATTER) {
    sim.ai.emitNoise(ix, iy, def.noise * throwNoise, "glass", sim.time, by, 1.6)
    glassAt(sim, at.x, at.y)
    for (const car of sim.progression.verbs.cars) {
      const r = car.rect
      const dx = Math.max(r[0] - at.x, 0, at.x - r[2])
      const dy = Math.max(r[1] - at.y, 0, at.y - r[3])
      if (Math.hypot(dx, dy) < 2.5) sim.progression.verbs.jolt(car, sim.time)
    }
  } else {
    sim.ai.emitNoise(ix, iy, def.noise * throwNoise, item === "tin-can" ? "cans" : "thud", sim.time, by, item === "tin-can" ? 1.3 : 1)
  }
  return topology
}

/** Broken glass on the ground: the field verbs' `glass:*` store, so it crunches underfoot and is swept like a bottle's. */
function glassAt(sim: OutbreakSim, x: number, y: number): void {
  const host = sim.progression
  host.ledger.createStore({ id: `glass:${host.takeId()}`, mode: "counters", scope: "shared", at: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) }, initial: { t: ds(sim.time) } })
}

/** Leaves what survived the throw lying where it stopped, as a ground drop anyone can pick up. */
function rest(sim: OutbreakSim, st: StoreState): void {
  const item = tossItem(st)
  if ((st.counts.out ?? 0) & OUT_SHATTER) return
  const ledger = sim.progression.ledger
  const id = `drop:t:${st.id.slice(5)}:${st.counts.t}`
  if (ledger.store(id)) return
  ledger.createStore({ id, mode: "slots", scope: "shared", size: 1, at: { ...st.at! }, initial: [{ item, count: 1 }] })
}

function landNow(sim: OutbreakSim, st: StoreState): void {
  if ((st.counts.done ?? 0) < 1) impact(sim, st, DEFAULT_INTERACTIONS_TUNING)
  rest(sim, st)
  st.counts.done = 2
  st.rev = ++sim.progression.ledger.rev
}

/**
 * Tracks the wind-up of a seat holding a throwable and throws on release (or at once at full strength for a command
 * that only presses, as the bots send). Runs while predicting too, so the client's arc preview knows the wind-up;
 * only the room throws.
 */
export function stepWindup(sim: OutbreakSim, slot: SurvivorSlot, command: Command, predict: boolean, state: TossState, t: InteractionsTuning): void {
  const item = sim.progression.selected(slot.id)?.item
  const armed = t.throwables > 0 && isThrowable(item) && !slot.survivor.vehicleId && (item !== "bottle" || sim.progression.tossBottles)
  const start = state.wind[slot.id]
  if (!armed) {
    delete state.wind[slot.id]
    return
  }
  // A press with nothing held (a bot's, or a click inside one frame) throws at full strength at once. The wire drops
  // a false `fireHeld`, so a release reads as `undefined` there.
  if (command.fire && !command.fireHeld && start === undefined) {
    if (!predict) throwHeld(sim, slot, 1, t)
    return
  }
  if (command.fireHeld) {
    if (start === undefined) state.wind[slot.id] = sim.time
    return
  }
  if (start === undefined) return
  delete state.wind[slot.id]
  if (!predict) throwHeld(sim, slot, throwPower(sim.time - start, t), t)
}

/** Lands what is due. Returns whether a window broke (topology changed). */
export function stepTosses(sim: OutbreakSim, t: InteractionsTuning): boolean {
  const ledger = sim.progression.ledger
  let topology = false
  for (let k = 0; k < TOSS_RING; k++) {
    const st = ledger.store(tossId(k))
    if (!st || !st.counts.t || (st.counts.done ?? 0) >= 2 || !st.at || !isTossStore(st.id)) continue
    const age = sim.time - st.counts.t / 10
    const fl = (st.counts.fl ?? 5) / 10
    if ((st.counts.done ?? 0) < 1 && age >= fl) {
      if (impact(sim, st, t)) topology = true
      st.counts.done = 1
      st.rev = ++ledger.rev
    }
    if ((st.counts.done ?? 0) >= 1 && age >= fl + ROLL_SECONDS) {
      rest(sim, st)
      st.counts.done = 2
      st.rev = ++ledger.rev
    }
  }
  return topology
}
