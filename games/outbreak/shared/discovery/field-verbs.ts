import { distToRect, raycast } from "@arcade/kit/sim/geom"
import type { LedgerEvent } from "@arcade/kit/sim/ledger"
import { INTERACT_RANGE, type InteractAction, type InteractionHandler, type RawInteractCandidate } from "../interact"
import { sightRects } from "../map"
import { buildingAt } from "../progression/loot"
import type { ProgressionHost, ProgressionSlot, WorldContext } from "../progression/types"
import type { FoundKnowledge } from "./knowledge"
import type { RecipeBoard } from "./recipe-board"
import {
  carSites,
  carStoreId,
  closetSites,
  crossing,
  ds,
  hideStoreId,
  nearestPortal,
  portalCentre,
  portals,
  trappedDoors,
  tripLine,
  tripStoreId,
  type CarSite,
  type ClosetSite,
  type Portal,
} from "./verbs"
import { chooseVignettes, vignetteDropId, vignetteGlassId, vignetteScene, vignetteStoreId, type VignetteKind } from "./vignettes"

/** How far smashing a car window carries. */
const CAR_GLASS_NOISE = 9
/** How near a car a bottle must break to jolt it (and its alarm). */
const CAR_JOLT_RANGE = 2.5
/** How near a car a gunshot must be to set its alarm off. */
const CAR_SHOT_RANGE = 4
/** Seconds between a car alarm's wails. */
const ALARM_BEAT = 1.2
/** How near a tripwire's line, either side, a footfall must land to catch it. */
const TRIP_STRIDE = 0.25
/** Seconds broken glass lies before it is swept from the world. */
const GLASS_SECONDS = 90
/** How close to a patch of broken glass a foot has to land to crunch it. */
const GLASS_STEP = 0.4

/**
 * The field verbs at runtime (D-19 slices 4 and 5): closets to hide in, can tripwires across doorways, abandoned cars
 * and their alarms, thrown bottles and the glass they leave, crowbar repairs, and the vignettes' real traces. Pure site
 * finding lives in `verbs.ts` and `vignettes.ts`; every piece of state here is a ledger store (`hide:*`, `trip:*`,
 * `car:*`, `glass:*`, `vignette:*`), so it saves, streams and replicates with the rest of the ledger.
 */
export class FieldVerbs {
  /** Closets in the world (refreshed with the stores as buildings stream in). */
  readonly closets: ClosetSite[] = []
  /** Abandoned cars along the streets, about half with a working alarm. */
  readonly cars: CarSite[] = []

  constructor(
    private readonly host: ProgressionHost,
    private readonly board: RecipeBoard,
    private readonly knowledge: FoundKnowledge,
  ) {}

  handlers(): InteractionHandler[] {
    return [this.closetHandler(), this.tripwireHandler(), this.carHandler()]
  }

  /** The closet a survivor is hiding in, if any. */
  hiddenIn(actor: string): ClosetSite | null {
    for (const c of this.closets) {
      const st = this.host.ledger.store(hideStoreId(c.id))
      if (st && st.owner === actor && (st.counts.in ?? 0) > 0) return c
    }
    return null
  }

  /** E at a closet: squeeze in, the doors pulled to; E again to step back out. The flashlight goes off inside. */
  private closetHandler(): InteractionHandler {
    return {
      kind: "closet",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const slot = this.host.slotOf(actor)
        const inside = slot ? this.hiddenIn(slot.id) : null
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        const out: RawInteractCandidate[] = []
        for (const c of this.closets) {
          if (inside ? inside.id !== c.id : distToRect(actor.x, actor.y, c.rect) > 1.2 || buildingAt(town, c.x, c.y)?.id !== here) continue
          if (!inside && this.host.ledger.store(hideStoreId(c.id))) continue
          const primary: InteractAction = { id: "hide", label: inside ? "Leave" : "Hide" }
          out.push({ kind: "closet", id: c.id, label: "Closet", rect: c.rect, worldX: c.x, worldY: c.y, primary, actions: [primary], priority: inside ? 10 : 0 })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.host.slotOf(actor)
        const c = this.closets.find((x) => x.id === targetId)
        if (!slot || !c || action !== "hide") return { handled: false }
        return { handled: this.toggleHide(slot, c), kind: "closet", targetId, action }
      },
    }
  }

  /** Steps a hidden survivor back out of their closet. */
  leaveHiding(slot: ProgressionSlot): boolean {
    const c = this.hiddenIn(slot.id)
    return c ? this.toggleHide(slot, c) : false
  }

  private toggleHide(slot: ProgressionSlot, c: ClosetSite): boolean {
    const p = slot.survivor
    const id = hideStoreId(c.id)
    const st = this.host.ledger.store(id)
    if (st) {
      if (st.owner !== slot.id) return false
      this.host.ledger.deleteStore(id)
      p.x = c.out.x
      p.y = c.out.y
      return true
    }
    if (distToRect(p.x, p.y, c.rect) > INTERACT_RANGE) return false
    this.host.ledger.cancel(slot.id)
    this.host.ledger.createStore({ id, mode: "counters", scope: "shared", owner: slot.id, at: { x: c.x, y: c.y }, initial: { in: 1 } })
    p.x = c.x
    p.y = c.y
    p.flashlightOn = false
    return true
  }

  /**
   * Cans strung across a doorway, a stride from it (see `tripLine`). Armed: E takes them down without a rattle (and anyone who
   * does learns how they work). Sprung: E picks the cans up, holding E strings them back.
   */
  private tripwireHandler(): InteractionHandler {
    return {
      kind: "tripwire",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const out: RawInteractCandidate[] = []
        for (const p of portals(town)) {
          const st = this.host.ledger.store(tripStoreId(p.id))
          if (!st || st.counts.down) continue
          const line = tripLine(town, p)
          if (distToRect(actor.x, actor.y, line.rect) > 1.1) continue
          const armed = (st.counts.armed ?? 0) > 0
          const primary: InteractAction = { id: "disarm", label: armed ? "Disarm" : "Take" }
          const secondary: InteractAction | undefined = armed ? undefined : { id: "arm", label: "Re-string", hold: true }
          // The prompt floats a little further from the opening, so it never sits on top of the wire it is about.
          const c = portalCentre(p)
          const off = Math.hypot(line.x - c.x, line.y - c.y) || 1
          out.push({
            kind: "tripwire",
            id: p.id,
            label: "Cans",
            rect: line.rect,
            worldX: line.x + ((line.x - c.x) / off) * 0.8,
            worldY: line.y + ((line.y - c.y) / off) * 0.8,
            primary,
            secondary,
            actions: secondary ? [primary, secondary] : [primary],
            deferPrimary: Boolean(secondary),
          })
        }
        return out
      },
      execute: (town, actor, targetId, action) => {
        const slot = this.host.slotOf(actor)
        const p = portals(town).find((x) => x.id === targetId)
        const st = this.host.ledger.store(tripStoreId(targetId))
        if (!slot || !p || !st || st.counts.down) return { handled: false }
        const line = tripLine(town, p)
        if (action !== "disarm" && action !== "arm") return { handled: false }
        const armed = (st.counts.armed ?? 0) > 0
        // Taking sprung cans is instant; working an armed line loose, or stringing it again, takes a moment.
        if (action === "disarm" && !armed) {
          this.takeDownTripwire(slot, p, { x: line.x, y: line.y })
          return { handled: true, kind: "tripwire", targetId, action }
        }
        if (action === "arm" && armed) return { handled: false }
        const rule = action === "arm" ? "arm:tripwire" : "disarm:tripwire"
        const res = this.host.ledger.start({ kind: "run", actor: slot.id, rule, ref: p.id }, this.host.envFor(slot), { x: line.x, y: line.y })
        this.host.feedback(slot, res.events)
        return { handled: res.ok, kind: "tripwire", targetId, action }
      },
    }
  }

  private takeDownTripwire(slot: ProgressionSlot, p: Portal, at: { x: number; y: number }): void {
    const st = this.host.ledger.store(tripStoreId(p.id))
    if (!st) return
    st.counts.armed = 0
    st.counts.down = 1
    st.rev = ++this.host.ledger.rev
    this.host.ledger.apply({ kind: "grant", actor: slot.id, item: "cans", count: 1 })
    this.board.learnRecipe(slot, "tripwire", at, 0)
    this.host.project(slot)
  }

  /** Strings cans across `p` (a new line, or one that was sprung or taken down). */
  private armTripwire(p: Portal, owner: string | undefined): void {
    const id = tripStoreId(p.id)
    const st = this.host.ledger.store(id)
    if (st) {
      st.counts.armed = 1
      st.counts.down = 0
      st.rev = ++this.host.ledger.rev
      return
    }
    const c = { x: (p.rect[0] + p.rect[2]) / 2, y: (p.rect[1] + p.rect[3]) / 2 }
    this.host.ledger.createStore({ id, mode: "counters", scope: "shared", owner, at: c, initial: { armed: 1, down: 0 } })
  }

  /** Holding the cans, the primary button strings them across the nearest doorway or window. */
  setTripwire(slot: ProgressionSlot, world: WorldContext): void {
    const p = slot.survivor
    const portal = nearestPortal(world.town, p.x, p.y, INTERACT_RANGE)
    if (!portal) return
    const st = this.host.ledger.store(tripStoreId(portal.id))
    if (st && !st.counts.down) return
    const line = tripLine(world.town, portal)
    const res = this.host.ledger.start({ kind: "run", actor: slot.id, rule: "set:tripwire", ref: portal.id }, this.host.envFor(slot, world), { x: line.x, y: line.y })
    this.host.feedback(slot, res.events)
  }

  /** E at an abandoned car: put a window in. Some still have an alarm, and it wails until its battery dies. */
  private carHandler(): InteractionHandler {
    return {
      kind: "car",
      candidates: (_town, actor) => {
        if (actor.peekingWindowId) return []
        const out: RawInteractCandidate[] = []
        for (const car of this.cars) {
          if (distToRect(actor.x, actor.y, car.rect) > 1.1) continue
          if (this.host.ledger.store(carStoreId(car.key))?.counts.smashed) continue
          const primary: InteractAction = { id: "smash", label: "Smash" }
          out.push({ kind: "car", id: car.key, label: "Car", rect: car.rect, worldX: car.x, worldY: car.y, primary, actions: [primary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const car = this.cars.find((c) => c.key === targetId)
        if (!car || action !== "smash" || distToRect(actor.x, actor.y, car.rect) > INTERACT_RANGE) return { handled: false }
        if (this.host.ledger.store(carStoreId(car.key))?.counts.smashed) return { handled: false }
        this.smashCar(car, this.host.lastWorld?.time ?? 0, true)
        return { handled: true, kind: "car", targetId, action, noise: CAR_GLASS_NOISE, noiseKind: "glass" }
      },
    }
  }

  /** Breaks a car's window (`smash`) or just jolts it; an alarm car starts wailing if it never has. */
  private smashCar(car: CarSite, time: number, smash: boolean): void {
    const id = carStoreId(car.key)
    let st = this.host.ledger.store(id)
    if (!st) st = this.host.ledger.createStore({ id, mode: "counters", scope: "shared", at: { x: car.x, y: car.y }, initial: { smashed: 0, alarm: 0 } })
    if (smash) st.counts.smashed = 1
    if (car.alarm && !st.counts.alarm) {
      st.counts.alarm = 1
      st.counts.start = ds(time)
      st.counts.until = ds(time + this.host.tuning.alarmTime)
    }
    st.rev = ++this.host.ledger.rev
  }

  /** Whether a car's alarm is wailing at `time`. */
  alarmRinging(car: CarSite, time: number): boolean {
    const st = this.host.ledger.store(carStoreId(car.key))
    return Boolean(st?.counts.alarm) && ds(time) < (st!.counts.until ?? 0)
  }

  /** Throws the bottle in hand: it breaks where it lands, loud, and can set off a car alarm next to it. */
  throwBottle(slot: ProgressionSlot, world: WorldContext): void {
    const p = slot.survivor
    const res = this.host.ledger.apply({ kind: "run", actor: slot.id, rule: "throw:bottle" })
    if (!res.ok) return
    const dx = Math.cos(p.aim)
    const dy = Math.sin(p.aim)
    const range = this.host.tuning.bottleRange
    const reach = Math.max(0.6, Math.min(range, raycast(p.x, p.y, dx, dy, sightRects(world.town), range)) - 0.3)
    const x = Number((p.x + dx * reach).toFixed(2))
    const y = Number((p.y + dy * reach).toFixed(2))
    world.ai.emitNoise(x, y, this.host.tuning.bottleNoise, "glass", world.time, slot.id, 1.6)
    this.host.ledger.createStore({ id: `glass:${this.host.takeId()}`, mode: "counters", scope: "shared", at: { x, y }, initial: { t: ds(world.time) } })
    for (const car of this.cars) if (distToRect(x, y, car.rect) < CAR_JOLT_RANGE) this.smashCar(car, world.time, false)
    this.host.project(slot)
  }

  /** The tripwire stores and closet and car lists for whatever is in the world now. */
  ensureVerbStores(): void {
    const town = this.host.town
    this.closets.length = 0
    this.closets.push(...closetSites(town))
    this.cars.length = 0
    this.cars.push(...carSites(town))
    for (const id of trappedDoors(town)) {
      const door = town.doors.find((d) => d.id === id)!
      if (!this.host.ledger.store(tripStoreId(id))) this.armTripwire(door, undefined)
    }
    for (const v of chooseVignettes(town)) if (!this.host.ledger.store(vignetteStoreId(v.kind, v.target))) this.seedVignette(v.kind, v.target)
  }

  /**
   * Leaves a vignette's real traces once (D-19 slice 5): glass that never gets swept, the thing left behind as a ground
   * drop, a car's spent alarm. The marker store keeps it from being seeded again when its chunk streams back.
   */
  seedVignette(kind: VignetteKind, target: string): boolean {
    const ledger = this.host.ledger
    const scene = vignetteScene(this.host.town, kind, target)
    if (!scene) return false
    const id = vignetteStoreId(kind, target)
    if (ledger.store(id)) ledger.deleteStore(id)
    ledger.createStore({ id, mode: "counters", scope: "shared", at: { x: scene.x, y: scene.y }, initial: { on: 1 } })
    scene.glass.forEach((g, i) => {
      const gid = vignetteGlassId(kind, target, i)
      if (!ledger.store(gid)) ledger.createStore({ id: gid, mode: "counters", scope: "shared", at: g, initial: { keep: 1, t: 1 + i * 3 } })
    })
    const drop = scene.drop
    const did = vignetteDropId(kind, target)
    if (drop && !ledger.store(did)) ledger.createStore({ id: did, mode: "slots", scope: "shared", size: 1, at: { x: drop.x, y: drop.y }, initial: [{ item: drop.item, count: drop.count }] })
    if (scene.car) {
      const cid = carStoreId(scene.car)
      const car = this.cars.find((c) => c.key === scene.car)
      if (car && !ledger.store(cid)) ledger.createStore({ id: cid, mode: "counters", scope: "shared", at: { x: car.x, y: car.y }, initial: { smashed: 1, alarm: 1, until: 1, old: 1 } })
    }
    return true
  }

  /**
   * Once per tick: tripwires rattle when the dead or an upright survivor walks through (crouch to step over), car
   * alarms wail on a beat until their battery dies (and a gunshot beside one sets it off), and broken glass is swept.
   */
  step(dt: number, world: WorldContext): void {
    const ledger = this.host.ledger
    const tuning = this.host.tuning
    for (const p of portals(world.town)) {
      const st = ledger.store(tripStoreId(p.id))
      if (!st || !st.counts.armed) continue
      const line = tripLine(world.town, p)
      let sprung = false
      for (const z of world.ai.agents) {
        if (z.state !== "dead" && crossing(line, z.x, z.y, TRIP_STRIDE)) sprung = true
      }
      for (const s of world.slots) {
        const q = s.survivor
        const walking = Math.hypot(q.vx ?? 0, q.vy ?? 0) > 0.3
        if (q.health > 0 && walking && !q.crouching && !this.hiddenIn(s.id) && crossing(line, q.x, q.y, TRIP_STRIDE)) sprung = true
      }
      if (!sprung) continue
      st.counts.armed = 0
      st.rev = ++ledger.rev
      world.ai.emitNoise(line.x, line.y, tuning.tripNoise, "cans", world.time, "tripwire", 1.3)
    }
    for (const car of this.cars) {
      if (!car.alarm) continue
      const st = ledger.store(carStoreId(car.key))
      if (!st?.counts.alarm) {
        const shot = world.ai.noiseBus.events.some((e) => e.kind === "gunshot" && e.time > world.time - 0.5 && distToRect(e.x, e.y, car.rect) < CAR_SHOT_RANGE)
        if (shot) this.smashCar(car, world.time, false)
        continue
      }
      const start = (st.counts.start ?? 0) / 10
      if (ds(world.time) >= (st.counts.until ?? 0)) continue
      const beat = Math.floor((world.time - start) / ALARM_BEAT)
      const prev = Math.floor((world.time - dt - start) / ALARM_BEAT)
      if (world.time - dt < start || beat !== prev) world.ai.emitNoise(car.x, car.y, tuning.alarmNoise, "alarm", world.time, "alarm", 2)
    }
    // Glass: a survivor stepping onto it upright crunches it (crouch to step softly); a bottle's is swept after a while.
    const moving = world.slots.filter((s) => {
      const q = s.survivor
      return q.health > 0 && !q.crouching && Math.hypot(q.vx ?? 0, q.vy ?? 0) > 0.3 && !this.hiddenIn(s.id)
    })
    for (const st of [...ledger.stores.values()]) {
      if (!st.id.startsWith("glass:") || !st.at) continue
      for (const s of moving) {
        const q = s.survivor
        const now = Math.hypot(q.x - st.at.x, q.y - st.at.y)
        const before = Math.hypot(q.x - (q.vx ?? 0) * dt - st.at.x, q.y - (q.vy ?? 0) * dt - st.at.y)
        if (now > GLASS_STEP || before <= GLASS_STEP) continue
        st.counts.steps = (st.counts.steps ?? 0) + 1
        st.rev = ++ledger.rev
        world.ai.emitNoise(st.at.x, st.at.y, tuning.glassStepNoise, "glass", world.time, s.id, 1.1)
      }
      if (!st.counts.keep && ds(world.time) - (st.counts.t ?? 0) > GLASS_SECONDS * 10) ledger.deleteStore(st.id)
    }
  }

  /** Holding a crowbar, B re-nails a damaged barricade within reach; practice makes it faster and quieter. */
  startRepair(slot: ProgressionSlot, world: WorldContext): number | null {
    const p = slot.survivor
    let best: { id: string; x: number; y: number } | null = null
    let bestD = INTERACT_RANGE
    for (const o of portals(world.town)) {
      const st = world.ai.portalStates.get(o.id)
      if (!st || st.barricadePlanks <= 0 || st.barricadeHp >= st.barricadePlanks * 100 - 1) continue
      const d = distToRect(p.x, p.y, o.rect)
      if (d <= bestD) {
        bestD = d
        best = { id: o.id, x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 }
      }
    }
    if (!best) return null
    const res = this.host.ledger.start({ kind: "run", actor: slot.id, rule: "repair", ref: best.id }, this.host.envFor(slot, world), best)
    this.host.feedback(slot, res.events)
    if (!res.ok) return 0
    return this.knowledge.practised(slot, "repair", res.noise)
  }

  /** A finished repair or tripwire action: the barricade holds again, the cans are strung, or they come down. */
  ran(slot: ProgressionSlot, ev: Extract<LedgerEvent, { kind: "ran" }>, world: WorldContext): void {
    if (ev.rule === "repair" && ev.ref) {
      const st = world.ai.portalStates.get(ev.ref)
      if (st && st.barricadePlanks > 0) st.barricadeHp = Math.max(st.barricadeHp, st.barricadePlanks * 100)
      this.knowledge.worked(slot, "repair", world)
    }
    if ((ev.rule === "set:tripwire" || ev.rule === "arm:tripwire") && ev.ref) {
      const portal = portals(world.town).find((x) => x.id === ev.ref)
      if (portal) this.armTripwire(portal, slot.id)
    }
    if (ev.rule === "disarm:tripwire" && ev.ref) {
      const portal = portals(world.town).find((x) => x.id === ev.ref)
      if (portal) {
        const line = tripLine(world.town, portal)
        this.takeDownTripwire(slot, portal, { x: line.x, y: line.y })
      }
    }
  }
}
