import type { CraftKind, PickupClass } from "@arcade/kit/audio"
import type { StoreState } from "@arcade/kit/sim/ledger"
import { dayCycle } from "../../shared/day-cycle"
import { DEFAULT_DOG_TUNING } from "../../shared/dogs/dogs"
import { matStoreId, TINKER_MATERIALS } from "../../shared/discovery/tinker"
import { RECIPES } from "../../shared/progression"
import type { SoundActor, SoundEvent } from "./types"

/** A sound held for as long as something lasts (a craft, a noisemaker, the generator), at a plan position. */
export type SoundHold = { key: string; id: string; x: number; y: number }

/** What the inventory sounds read: the ledger (the room's, or a co-op client's mirror), pings, lures and benches. */
export type SoundProgression = {
  ledger: { readonly stores: ReadonlyMap<string, StoreState> }
  pings: readonly { id: number; x: number; y: number }[]
  lures: readonly { id: number; x: number; y: number }[]
  benches: readonly { id: string; bench: { x: number; y: number } }[]
}

/** The pickup sound for each item (`pickup.ammo` and `pickup.item` predate the class table). */
export const PICKUP_SOUND: Readonly<Record<string, `pickup.${PickupClass | "ammo" | "item"}`>> = {
  ammo: "pickup.ammo",
  plank: "pickup.plank",
  scrap: "pickup.scrap",
  chem: "pickup.medical",
  battery: "pickup.battery",
  key: "pickup.key",
  crowbar: "pickup.tool",
  "spiked-board": "pickup.tool",
  bat: "pickup.tool",
  pipe: "pickup.tool",
  knife: "pickup.tool",
  machete: "pickup.tool",
  axe: "pickup.tool",
  hammer: "pickup.tool",
  "fire-axe": "pickup.tool",
  pistol: "pickup.tool",
  flashlight: "pickup.tool",
  medkit: "pickup.medical",
  bandage: "pickup.medical",
  noisemaker: "pickup.item",
  bottle: "pickup.item",
  cans: "pickup.item",
  toolbox: "pickup.part",
  "car-battery": "pickup.part",
}

/** Which crafting sound each recipe makes. */
export const CRAFT_KIND: Readonly<Record<string, CraftKind>> = { bandage: "medical", lure: "tinker", "spiked-board": "wood", battery: "tinker", tripwire: "tinker" }

/** Channel kinds with a held sound, and what plays when one finishes rather than being cancelled. */
function channelSound(kind: string, label: string): { loop: string; done: string | null } | null {
  if (kind === "craft") {
    const recipe = RECIPES.find((r) => label.endsWith(r.label))
    const craft = CRAFT_KIND[recipe?.id ?? ""] ?? "tinker"
    return { loop: `craft.${craft}.loop`, done: `craft.${craft}.done` }
  }
  if (kind === "research") return { loop: "bench.research.loop", done: "bench.research.done" }
  // How a try ends depends on the mat afterwards (`tinkerDone`).
  if (kind === "tinker") return { loop: "bench.research.loop", done: TINKER_DONE }
  if (kind === "heal") return { loop: "craft.medical.loop", done: "craft.medical.done" }
  if (kind === "pry") return { loop: "door.pry.loop", done: null }
  return null
}

const TINKER_DONE = "tinker"

/** A finished try: what it made lies on the mat (the research chime), or the materials clatter back down. */
function tinkerDone(progression: SoundProgression | undefined, x: number, y: number): string {
  const bench = progression?.benches.find((b) => Math.hypot(b.bench.x - x, b.bench.y - y) < 0.5)
  const mat = bench ? progression?.ledger.stores.get(matStoreId(bench.id)) : undefined
  const made = mat?.slots.some((s) => s && !(TINKER_MATERIALS as readonly string[]).includes(s.item))
  return made ? "bench.research.done" : "item.drop"
}

/** A finished channel had run this much of its duration when last seen (snapshots and frames skip its last tick). */
const FINISHED = 0.8
const PERSONAL = ["belt", "hotbar", "pack"] as const

function storeTotals(st: StoreState | undefined, into: Map<string, number>): void {
  if (!st) return
  for (const [item, n] of Object.entries(st.counts)) into.set(item, (into.get(item) ?? 0) + n)
  for (const s of st.slots) if (s) into.set(s.item, (into.get(s.item) ?? 0) + s.count)
}

type Memory = { revs: string; totals: Map<string, number>; channel: { loop: string; done: string | null; progress: number; x: number; y: number } | null; battery: number }

/**
 * Inventory and workbench sounds from ledger state: pickups by item class (container strips, drops, the stash), drops
 * landing, deposits at a bench, crafting, research, healing and prying held for as long as the channel runs and
 * finished with their own sound, battery swaps, squad pings, noisemakers and the generator. Like the director it only
 * diffs state, so offline play and a co-op client's mirror sound the same; a client hears its own pickups.
 */
export class InventorySounds {
  private actors = new Map<string, Memory>()
  private benches = new Map<string, { rev: number; total: number; generator: boolean }>()
  private drops = new Set<string>()
  private pings = new Set<number>()
  private lures = new Set<number>()
  /** D-19 verbs: glass already heard (and how many steps on it), each tripwire's last armed state, cars already smashed. */
  private glass = new Map<string, number>()
  private trips = new Map<string, number>()
  private smashed = new Set<string>()
  /** House radios (AR-56): each one's last on/broken state, for the switch's click and the thud when it is knocked down. */
  private radios = new Map<string, { on: number; broken: number }>()
  /** World interactions (AR-56): lamps, flares, dogs and bodies as last heard. */
  private world = new Map<string, { a: number; b: number; c: number }>()
  private started = false
  readonly holds: SoundHold[] = []

  reset(): void {
    this.actors.clear()
    this.benches.clear()
    this.drops.clear()
    this.pings.clear()
    this.lures.clear()
    this.glass.clear()
    this.trips.clear()
    this.smashed.clear()
    this.radios.clear()
    this.world.clear()
    this.started = false
  }

  observe(progression: SoundProgression | undefined, hour: number, survivors: readonly { id: string; survivor: SoundActor }[], out: SoundEvent[], time = 0): void {
    const holds = this.holds
    holds.length = 0
    const emit = this.started ? (e: SoundEvent) => out.push(e) : () => {}
    const stores = progression?.ledger.stores

    for (const { id, survivor: a } of survivors) {
      const prev = this.actors.get(id)
      const at = { x: a.x, y: a.y, source: id }
      // Timed actions: a held loop while the channel runs, its finishing sound if it ran out rather than stopped.
      const ch = a.channel ? channelSound(a.channel.kind, a.channel.label) : null
      const channel = ch && a.channel ? { ...ch, progress: a.channel.elapsed / Math.max(0.01, a.channel.duration), x: a.channel.x, y: a.channel.y } : null
      let finished = false
      if (prev?.channel && (!channel || channel.loop !== prev.channel.loop)) {
        if (prev.channel.done && prev.channel.progress >= FINISHED) {
          const done = prev.channel.done === TINKER_DONE ? tinkerDone(progression, prev.channel.x, prev.channel.y) : prev.channel.done
          emit({ id: done, x: prev.channel.x, y: prev.channel.y, source: id })
          finished = true
        }
      }
      if (channel) holds.push({ key: `channel:${id}`, id: channel.loop, x: channel.x, y: channel.y })
      if (prev && a.battery > prev.battery + 0.3) emit({ id: "flashlight.battery", ...at })

      // Pickups: anything new on the survivor's belt, hotbar or pack, by item class (one or two sounds a frame).
      let revs = ""
      const totals = prev?.totals ?? new Map<string, number>()
      if (stores) {
        revs = PERSONAL.map((s) => stores.get(`${id}/${s}`)?.rev ?? -1).join()
        if (!prev || revs !== prev.revs) {
          const now = new Map<string, number>()
          for (const s of PERSONAL) storeTotals(stores.get(`${id}/${s}`), now)
          if (prev && !finished) {
            const sounds = new Set<string>()
            for (const [item, n] of now) if (n > (totals.get(item) ?? 0)) sounds.add(PICKUP_SOUND[item] ?? "pickup.item")
            let delay = 0
            for (const sound of [...sounds].slice(0, 2)) emit({ id: sound, ...at, delay: (delay += 0.12) - 0.12 })
          }
          this.actors.set(id, { revs, totals: now, channel, battery: a.battery })
          continue
        }
      }
      this.actors.set(id, { revs, totals, channel, battery: a.battery })
    }
    for (const id of this.actors.keys()) if (!survivors.some((s) => s.id === id)) this.actors.delete(id)

    if (progression && stores) {
      const night = dayCycle(hour).lamps > 0.5
      for (const b of progression.benches) {
        const st = stores.get(b.id)
        let bench = this.benches.get(b.id)
        if (!bench || bench.rev !== (st?.rev ?? -1)) {
          const totals = new Map<string, number>()
          storeTotals(st, totals)
          let total = 0
          for (const n of totals.values()) total += n
          if (bench && total > bench.total) emit({ id: "bench.deposit", x: b.bench.x, y: b.bench.y, source: "bench" })
          bench = { rev: st?.rev ?? -1, total, generator: (totals.get("car-battery") ?? 0) > 0 }
          this.benches.set(b.id, bench)
        }
        if (night && bench.generator) holds.push({ key: `generator:${b.id}`, id: "generator.loop", x: b.bench.x, y: b.bench.y })
      }
      // Drops, pings and lures are few; only rebuild what was seen when something new appears or goes.
      let dropCount = 0
      let newDrop = false
      for (const [sid, st] of stores) {
        if (sid.startsWith("radio:")) {
          this.radioSound(sid, st, time, emit)
          continue
        }
        if (sid.startsWith("lamp:") || sid.startsWith("flare:") || sid.startsWith("dog:") || sid.startsWith("body:")) {
          this.worldSound(sid, st, time, emit)
          continue
        }
        if (sid.startsWith("glass:") || sid.startsWith("trip:") || sid.startsWith("car:")) {
          this.verbSound(sid, st, time, emit)
          continue
        }
        if (!sid.startsWith("drop:")) continue
        dropCount++
        if (this.drops.has(sid)) continue
        newDrop = true
        if (st.at && !sid.startsWith("drop:v:")) emit({ id: "item.drop", x: st.at.x, y: st.at.y, source: "drop" })
      }
      if (newDrop || dropCount !== this.drops.size) this.drops = new Set([...stores.keys()].filter((k) => k.startsWith("drop:")))
      let newPing = false
      for (const p of progression.pings) if (!this.pings.has(p.id)) (newPing = true), emit({ id: "ui.ping", x: p.x, y: p.y, source: "ping" })
      if (newPing || progression.pings.length !== this.pings.size) this.pings = new Set(progression.pings.map((p) => p.id))
      let newLure = false
      for (const l of progression.lures) {
        if (!this.lures.has(l.id)) (newLure = true), emit({ id: "lure.land", x: l.x, y: l.y, source: "lure" })
        holds.push({ key: `lure:${l.id}`, id: "lure.loop", x: l.x, y: l.y })
      }
      if (newLure || progression.lures.length !== this.lures.size) this.lures = new Set(progression.lures.map((l) => l.id))
    }
    this.started = true
  }

  /** A house radio: its switch clicks, it plays while it has battery, and it lands with a thud when the dead knock it down. */
  private radioSound(sid: string, st: StoreState, time: number, emit: (e: SoundEvent) => void): void {
    const at = st.at
    if (!at) return
    const on = st.counts.on ?? 0
    const broken = st.counts.broken ?? 0
    const prev = this.radios.get(sid)
    // A radio running flat goes quiet without a click; only a hand on the switch makes one.
    if (prev && on !== prev.on && !broken && (on || (st.counts.left ?? 0) > 0)) emit({ id: "flashlight.click", x: at.x, y: at.y, source: "radio" })
    if (prev && broken && !prev.broken) emit({ id: "item.drop", x: at.x, y: at.y, source: "radio", gain: 1.3 })
    this.radios.set(sid, { on, broken })
    if (on && !broken && time * 10 < (st.counts.until ?? 0)) this.holds.push({ key: `radio:${sid}`, id: "radio.loop", x: at.x, y: at.y })
  }

  /**
   * World interactions (AR-56): a lamp's glass popping when it is shot out and its switch clicking; a flare striking
   * and hissing while it burns; a chained dog barking on its beat, yelping when the dead kill it and eating when fed;
   * a body that stirs under the hand groaning.
   */
  private worldSound(sid: string, st: StoreState, time: number, emit: (e: SoundEvent) => void): void {
    const at = st.at
    if (!at) return
    const prev = this.world.get(sid)
    const c = st.counts
    if (sid.startsWith("lamp:")) {
      if (prev && c.broken && !prev.a) emit({ id: "impact.bullet.glass", x: at.x, y: at.y, source: "lamp", gain: 1.4 })
      if (prev && !c.broken && (c.off ?? 0) !== prev.b) emit({ id: "flashlight.click", x: at.x, y: at.y, source: "lamp" })
      this.world.set(sid, { a: c.broken ?? 0, b: c.off ?? 0, c: 0 })
    } else if (sid.startsWith("flare:")) {
      if (!prev) emit({ id: "flare.ignite", x: at.x, y: at.y, source: "flare" })
      this.world.set(sid, { a: 1, b: 0, c: 0 })
      if (time * 10 < (c.until ?? 0)) this.holds.push({ key: `flare:${sid}`, id: "flare.loop", x: at.x, y: at.y })
    } else if (sid.startsWith("dog:")) {
      // Barks keep the dog's beat from when it started; the store only says it is barking.
      const beat = c.bark && !c.dead ? Math.floor(Math.max(0, time - (c.since ?? 0) / 10) / DEFAULT_DOG_TUNING.dogBeat) + 1 : 0
      if (prev && beat > prev.a) emit({ id: "dog.bark", x: at.x, y: at.y, source: "dog" })
      if (prev && c.dead && !prev.b) emit({ id: "dog.yelp", x: at.x, y: at.y, source: "dog" })
      if (prev && (c.hush ?? 0) > prev.c) emit({ id: "dog.eat", x: at.x, y: at.y, source: "dog" })
      this.world.set(sid, { a: beat, b: c.dead ?? 0, c: c.hush ?? 0 })
    } else {
      if (prev && c.rise && !prev.a) emit({ id: "zombie.groan.idle", x: at.x, y: at.y, source: "body", gain: 1.2 })
      this.world.set(sid, { a: c.rise ?? 0, b: 0, c: 0 })
    }
  }

  /** A bottle breaking, cans strung across a doorway rattling as someone walks through, a car window going in and its alarm wailing. */
  private verbSound(sid: string, st: StoreState, time: number, emit: (e: SoundEvent) => void): void {
    const at = st.at
    if (!at) return
    if (sid.startsWith("glass:")) {
      // Glass a vignette left is already broken; a foot on any glass crunches it.
      const steps = st.counts.steps ?? 0
      const heard = this.glass.get(sid)
      if (heard === undefined && !st.counts.keep) emit({ id: "glass.break", x: at.x, y: at.y, source: "bottle" })
      if (heard !== undefined && steps > heard) emit({ id: "glass.break", x: at.x, y: at.y, source: "glass-step", gain: 0.35 })
      this.glass.set(sid, steps)
    } else if (sid.startsWith("trip:")) {
      const armed = st.counts.armed ?? 0
      if (this.trips.get(sid) === 1 && !armed && !st.counts.down) emit({ id: "lure.land", x: at.x, y: at.y, source: "tripwire", gain: 1.2 })
      this.trips.set(sid, armed)
    } else {
      if (st.counts.smashed && !this.smashed.has(sid)) {
        if (!st.counts.old) emit({ id: "glass.break", x: at.x, y: at.y, source: "car" })
        this.smashed.add(sid)
      }
      // A vignette's car (`old`) rang out long ago; only an alarm someone set off wails.
      if (st.counts.alarm && !st.counts.old && time * 10 < (st.counts.until ?? 0)) this.holds.push({ key: `alarm:${sid}`, id: "lure.loop", x: at.x, y: at.y })
    }
  }
}
