import { angleDiff, clearLine, distToRect, raycast, type Rect } from "@arcade/kit/sim/geom"
import {
  Ledger,
  type ItemId,
  type LedgerEnv,
  type LedgerEvent,
  type Stack,
  type StoreSpec,
  type StoreState,
  type Tx,
} from "@arcade/kit/sim/ledger"
import { Rng } from "@arcade/kit/sim/rng"
import { isMeleeWeapon, MELEE_WEAPONS, type MeleeDurabilityHandle, type MeleeWeaponId } from "../combat"
import { dayCycle } from "../day-cycle"
import { FieldVerbs } from "../discovery/field-verbs"
import { FoundKnowledge } from "../discovery/knowledge"
import { RecipeBoard } from "../discovery/recipe-board"
import { INTERACT_RANGE, type InteractAction, type InteractActorState, type InteractionHandler, type RawInteractCandidate } from "../interact"
import { DEFAULT_LOADOUT, loadoutSpec, type LoadoutId } from "../loadout"
import { sightRects, type Door, type Town } from "../map"
import { ACTOR_STORES, CATALOG, ITEMS, RECIPES, type Recipe } from "./catalog"
import { bagLootRng, benchSites, buildingAt, CONTAINER_SLOTS, LOOT_TABLES, lootSites, rareLootRng, rollBagLoot, rollExtraLoot, rollRareLoot, type BenchSite, type LootSite } from "./loot"
import { defaultSeatName, giveTarget, type SeatNames } from "./give"
import { caseSize, MAX_POUCHES, POUCH, STARTING_BAG, type BagDef } from "./shapes"
import { CHANNEL_SLACK, pickProgressionTuning, progressionRules, type ProgressionTuning } from "./tuning"
import type {
  HeldUse,
  Lure,
  NoticeKind,
  OutbreakProgressionSnapshot,
  Ping,
  PistolAmmo,
  ProgressionActor,
  ProgressionCommand,
  ProgressionHost,
  ProgressionSlot,
  WorldContext,
} from "./types"

/**
 * Outbreak's inventory and safehouse progression, on top of `@arcade/kit/sim/ledger`.
 *
 * Furniture containers are stores you search (quiet or smash) and then see into; ground drops are stores too. Each
 * house has a workbench and a stash sharing one store: installing parts adds recipes to the board. What the squad finds
 * out for themselves (the recipe board, pages, practice, the field verbs) is built from the discovery parts
 * in `shared/discovery/`, which work on this ledger through `ProgressionHost`.
 *
 * The sim calls `act` for a survivor's command, `step` once per tick, and reads `notices` for feedback. Everything
 * here is deterministic and shared by the room, the offline session and the client mirror (which only applies deltas).
 */

const DROP_RANGE = 1.6
const PING_SECONDS = 6
const BUNDLE = { ammo: 6, plank: 2 } as const
const LURE_RANGE = 11
/** Light at a bench: one flashlight plus the room lamp clears the bench threshold at night; the generator alone does. */
const BENCH_LIGHT_FLASHLIGHT = 0.2
const BENCH_LIGHT_LAMP = 0.2
const GENERATOR_LIGHT = 0.8
/** Items whose primary button a feature handles in its own survivor action (`shared/fire`). */
const FEATURE_ITEMS: ReadonlySet<ItemId> = new Set(["flamethrower", "dynamite", "firecrackers", "molotov", "flare-gun", "bear-trap", "baseball", "brick", "rock", "tin-can"])

export class OutbreakProgression implements ProgressionHost {
  readonly ledger: Ledger
  readonly containers: LootSite[]
  readonly benches: BenchSite[]
  readonly pings: Ping[] = []
  readonly lures: Lure[] = []
  tuning: ProgressionTuning
  private nextId = 1
  private generatorAt = new Map<string, number>()
  /** The world as of the last command or tick, for interactions that need light (bench crafting). */
  private world: WorldContext | undefined
  private actorOf = new WeakMap<object, ProgressionSlot>()
  /** The bench's recipe board and its corkboard (`shared/discovery/recipe-board.ts`). */
  readonly board = new RecipeBoard(this)
  /** Pages, practice, study and held-out buildings (`shared/discovery/knowledge.ts`). */
  readonly knowledge = new FoundKnowledge(this, this.board)
  /** Closets, tripwires, cars, bottles, glass, repairs and vignettes (`shared/discovery/field-verbs.ts`). */
  readonly verbs = new FieldVerbs(this, this.board, this.knowledge)
  /** Bottles are wound up and thrown by `shared/throwables` (its tuning sets this; off is Today's fixed-range throw). */
  tossBottles = true
  /** One B keeps nailing boards until the opening is full, the planks run out or you walk off (`shared/interactions`). */
  chainBoards = true

  snapshot(): OutbreakProgressionSnapshot {
    return {
      tuning: { ...this.tuning },
      nextId: this.nextId,
      generatorAt: [...this.generatorAt.entries()],
      pings: this.pings.map((p) => ({ ...p })),
      lures: this.lures.map((l) => ({ ...l })),
      searchedContainers: this.containers.map((c) => [c.id, Boolean(c.searched)]),
      ledger: this.ledger.snapshot(),
      ...this.knowledge.snapshot(),
    }
  }

  restore(snap: OutbreakProgressionSnapshot, slots: readonly ProgressionSlot[] = []): void {
    this.tuning = { ...snap.tuning }
    this.ledger.setRules(progressionRules(this.tuning))
    this.nextId = snap.nextId
    this.generatorAt.clear()
    for (const [k, v] of snap.generatorAt) this.generatorAt.set(k, v)
    this.pings.length = 0
    for (const p of snap.pings) this.pings.push({ ...p })
    this.lures.length = 0
    for (const l of snap.lures) this.lures.push({ ...l })
    this.ledger.restore(snap.ledger)
    const searchedMap = new Map(snap.searchedContainers)
    for (const c of this.containers) {
      if (searchedMap.has(c.id)) c.searched = searchedMap.get(c.id)
      const st = this.ledger.store(c.id)
      if (st?.revealed) c.searched = true
    }
    this.knowledge.restore(snap)
    this.ensureContainerStores()
    for (const slot of slots) {
      this.actorOf.set(slot.survivor, slot)
      this.project(slot)
    }
  }

  constructor(
    readonly town: Town,
    tuning: object = {},
  ) {
    this.tuning = pickProgressionTuning(tuning)
    const loot = lootSites(town, this.tuning)
    this.containers = loot.sites
    this.benches = benchSites(town)
    this.ledger = new Ledger({
      items: CATALOG,
      actorStores: ACTOR_STORES,
      stores: [
        ...loot.stores,
        ...this.benches.map((b): StoreSpec => ({ id: b.id, mode: "counters", scope: "shared", accepts: ["resource", "part", "tool"], at: { x: b.bench.x, y: b.bench.y } })),
      ],
      rules: progressionRules(this.tuning),
      knowledgeStore: "team/known",
    })
    // Nothing is announced: a new material, a lesson or a better bench shows on the bench and its corkboard (D-19).
    this.knowledge.ensurePageStores()
    this.verbs.ensureVerbStores()
  }

  slotOf(actor: object): ProgressionSlot | undefined {
    return this.actorOf.get(actor)
  }

  takeId(): number {
    return this.nextId++
  }

  get lastWorld(): WorldContext | undefined {
    return this.world
  }

  /** Applies Lab tuning: recipe costs and times change at once; a new loot rate restocks unsearched containers. */
  setTuning(tuning: object): void {
    const next = pickProgressionTuning(tuning, this.tuning)
    if (JSON.stringify(next) === JSON.stringify(this.tuning)) return
    const restock = next.lootRate !== this.tuning.lootRate
    this.tuning = next
    this.ledger.setRules(progressionRules(next))
    if (restock) this.restock()
  }

  /** Re-rolls every container nobody has searched yet with the current loot rate. */
  restock(): void {
    for (const spec of lootSites(this.town, this.tuning).stores) {
      const st = this.ledger.store(spec.id)
      if (!st || st.revealed) continue
      st.slots = Array.from({ length: st.size }, (_, i) => (spec.initial as readonly (Stack | null)[])[i] ?? null).map((x) => (x ? { ...x } : null))
      st.rev = ++this.ledger.rev
    }
  }

  /** Ensures ledger stores exist for any newly streamed chunk containers and syncs their `searched` flag. */
  ensureContainerStores(): void {
    this.knowledge.ensurePageStores()
    this.verbs.ensureVerbStores()
    for (const c of this.containers) {
      let st = this.ledger.store(c.id)
      if (!st) {
        const initial: Stack[] = []
        if ((c.ammo ?? 0) > 0) initial.push({ item: "ammo", count: c.ammo! })
        if ((c.planks ?? 0) > 0) initial.push({ item: "plank", count: c.planks! })
        const bld = c.buildingId ? this.town.buildings.find((b) => b.id === c.buildingId) : buildingAt(this.town, c.x, c.y)
        const tableKey = c.table ?? bld?.archetype ?? bld?.kind ?? "house"
        const table = LOOT_TABLES[tableKey] ?? LOOT_TABLES[bld?.kind ?? "house"] ?? LOOT_TABLES.house!
        const cRng = new Rng((this.town.seed ^ Math.imul(c.propIndex + 31, 0x9e3779b9)) >>> 0)
        for (const roll of table[c.kind] ?? []) {
          if (initial.length >= CONTAINER_SLOTS) break
          if (initial.some((s) => s.item === roll.item)) continue
          if (cRng.next() < roll.chance * this.tuning.lootRate) {
            const n = (roll.min ?? 1) + cRng.int((roll.max ?? roll.min ?? 1) - (roll.min ?? 1) + 1)
            initial.push({ item: roll.item, count: n })
          }
        }
        rollExtraLoot(initial, tableKey, c.kind, cRng, this.tuning.lootRate)
        rollRareLoot(initial, tableKey, c.kind, rareLootRng(this.town.seed, c.propIndex), this.tuning.lootRate)
        rollBagLoot(initial, tableKey, c.kind, bagLootRng(this.town.seed, c.propIndex), this.tuning.lootRate)
        st = this.ledger.createStore({
          id: c.id,
          mode: "slots",
          scope: "shared",
          size: CONTAINER_SLOTS,
          revealed: Boolean(c.searched),
          at: { x: c.x, y: c.y },
          initial,
        })
      } else if (c.searched && !st.revealed) {
        st.revealed = true
      } else if (st.revealed) {
        c.searched = true
      }
    }
  }

  addActor(slot: ProgressionSlot): void {
    this.actorOf.set(slot.survivor, slot)
    if (this.ledger.store(`${slot.id}/hotbar`)) return
    this.ledger.addActor(slot.id)
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "fists" })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: STARTING_BAG })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "pistol" })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "ammo", count: 6 })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "plank", count: 2 })
    this.ledger.apply({ kind: "select", actor: slot.id, slot: 1 })
    this.project(slot)
  }

  /** Applies a starting loadout kit (`shared/loadout.ts`) to a fresh survivor before the run starts. */
  setLoadout(slot: ProgressionSlot, loadout: LoadoutId = DEFAULT_LOADOUT): void {
    this.ledger.removeActor(slot.id)
    this.addActor(slot)
    const spec = loadoutSpec(loadout)
    if (spec.bag) this.ledger.apply({ kind: "grant", actor: slot.id, item: spec.bag })
    this.syncCase(slot.id)
    for (const grant of spec.items) {
      this.ledger.apply({ kind: "grant", actor: slot.id, item: grant.item, count: grant.count })
      if (grant.charge !== undefined) {
        this.ledger.apply({ kind: "setCharge", actor: slot.id, item: grant.item, charge: grant.charge })
      }
    }
    this.ledger.apply({ kind: "select", actor: slot.id, slot: 1 })
    this.project(slot)
  }

  /** Forgets a survivor; with `dropAt`, what they carried stays there for the squad. */
  removeActor(id: string, dropAt?: { x: number; y: number }): void {
    this.ledger.removeActor(id, dropAt)
  }

  // ── Queries for presentation ──────────────────────────────────────────────────────────────────────────────

  hotbar(id: string): StoreState | undefined {
    return this.ledger.store(`${id}/hotbar`)
  }

  selected(id: string): Stack | null {
    return this.ledger.activeItem(id)
  }

  /** What the primary button does with the selected item. */
  heldUse(id: string): HeldUse {
    const item = this.selected(id)?.item
    if (isMeleeWeapon(item)) return "melee"
    if (item === "medkit" || item === "bandage") return "heal"
    if (item === "bottle" && this.tossBottles) return "use"
    if (item === "noisemaker" || item === "bottle" || item === "flare") return "throw"
    if (item === "cans") return "set"
    // The flamethrower, dynamite, firecrackers, molotovs, the flare gun and bear traps are used by `shared/fire`.
    if (item && FEATURE_ITEMS.has(item)) return "use"
    if (item === "pistol") return "fire"
    // Bare hands, an empty slot and food (for a chained dog, `shared/dogs`) shove: everyone always has a melee.
    return "shove"
  }

  /** Returns the currently selected melee weapon id, or null when holding pistol/consumable/hands. */
  heldMeleeWeapon(id: string): MeleeWeaponId | null {
    const item = this.selected(id)?.item
    return isMeleeWeapon(item) ? item : null
  }

  /** Handle to inspect and spend durability on the currently held melee weapon in the ledger. */
  melee(id: string): MeleeDurabilityHandle | null {
    const l = this.ledger
    const sel = this.selected(id)
    if (!sel || !isMeleeWeapon(sel.item)) return null
    const weaponId = sel.item
    const def = MELEE_WEAPONS[weaponId]
    return {
      weapon: weaponId,
      get durability() {
        const cur = l.activeItem(id)
        return cur?.item === weaponId ? (cur.charge ?? def.durability) : 0
      },
      maxDurability: def.durability,
      spend: (amount: number) => {
        const stack = l.activeItem(id)
        if (!stack || stack.item !== weaponId) return { remaining: 0, broke: false, low: false }
        const before = stack.charge ?? def.durability
        const lowThresh = Math.max(4, Math.ceil(def.durability * 0.35))
        const next = Math.max(0, before - amount)
        if (next <= 0) {
          const hb = l.store(`${id}/hotbar`)
          if (hb) {
            hb.slots[hb.selected] = null
            hb.rev = ++l.rev
          }
          return { remaining: 0, broke: true, low: false }
        }
        l.apply({ kind: "setCharge", actor: id, item: weaponId, charge: next })
        return { remaining: next, broke: false, low: next <= lowThresh }
      },
    }
  }

  /** Contents of the store behind an interaction target, in pick order (digit 1 = index 0). */
  contents(storeId: string): Stack[] {
    const st = this.ledger.store(storeId)
    if (!st) return []
    if (st.mode === "slots") return st.slots.filter((s): s is Stack => s !== null)
    return ITEMS.filter((d) => (st.counts[d.id] ?? 0) > 0).map((d) => ({ item: d.id, count: st.counts[d.id]! }))
  }

  /** The store an interaction target reads from, for strips (containers, drops, the stash and the bench). */
  storeFor(target: { kind: string; id: string } | undefined): string | null {
    if (!target) return null
    // `body`: a dead survivor searched like a container (`shared/bodies`).
    if (target.kind === "container" || target.kind === "drop" || target.kind === "body" || target.kind === "fallen") return target.id
    if (target.kind === "bench" || target.kind === "stash") return target.id.replace(/#.*$/, "")
    return null
  }

  learned(recipe: string): boolean {
    return this.ledger.count("team/known", `learned:${recipe}`) > 0
  }

  seen(material: ItemId): boolean {
    return this.ledger.count("team/known", `seen:${material}`) > 0
  }

  tier(benchId: string): number {
    return 1 + (this.ledger.count(benchId, "toolbox") > 0 ? 1 : 0) + (this.ledger.count(benchId, "car-battery") > 0 ? 1 : 0)
  }

  /** Recipes the squad has learned, in board order (digit 1 = index 0). Bench recipes only make at a workbench. */
  craftable(): Recipe[] {
    return RECIPES.filter((r) => r.produces && this.learned(r.id))
  }

  /** Light at a bench: daylight indoors, the room lamp at night, the generator, and flashlights of survivors at it. */
  benchLight(benchId: string, hour: number, survivors: readonly { x: number; y: number; flashlightOn: boolean; flashlightOutput: number }[]): number {
    const site = this.benches.find((b) => b.id === benchId)
    if (!site) return 0
    const day = dayCycle(hour)
    let light = day.sun * 0.9 + day.lamps * BENCH_LIGHT_LAMP
    if (this.ledger.count(benchId, "car-battery") > 0) light += GENERATOR_LIGHT
    for (const s of survivors) {
      if (s.flashlightOn && s.flashlightOutput > 0.2 && Math.hypot(s.x - site.bench.x, s.y - site.bench.y) < 3.2) light += BENCH_LIGHT_FLASHLIGHT
    }
    return light
  }

  // ── Interaction handlers ──────────────────────────────────────────────────────────────────────────────────

  /** Containers, ground drops, workbenches and stashes as interaction targets. */
  handlers(): InteractionHandler[] {
    return [
      this.containerHandler(),
      this.dropHandler(),
      this.board.benchHandler(),
      this.stashHandler(),
      this.knowledge.pageHandler(),
      ...this.verbs.handlers(),
    ]
  }

  private containerHandler(): InteractionHandler {
    return {
      kind: "container",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const out: RawInteractCandidate[] = []
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        let walls: Rect[] | null = null
        for (const c of this.containers) {
          if (c.buildingId !== here || distToRect(actor.x, actor.y, c.rect) > 1.45) continue
          const nx = Math.max(c.rect[0], Math.min(c.rect[2], actor.x))
          const ny = Math.max(c.rect[1], Math.min(c.rect[3], actor.y))
          walls ??= town.barriers.filter((b) => b.kind === "wall").map((b) => b.rect)
          if (!clearLine(actor.x, actor.y, nx, ny, walls)) continue
          const st = this.ledger.store(c.id)
          if (!st) continue
          let primary: InteractAction
          let alt: InteractAction | undefined
          if (!st.revealed) {
            primary = { id: "search", label: "Search" }
            alt = { id: "smash", label: "Smash", modifier: "shift" }
          } else if (this.contents(c.id).length) primary = { id: "take", label: "Take all" }
          else continue
          out.push({ kind: "container", id: c.id, label: c.label, rect: c.rect, worldX: c.x, worldY: c.y, primary, alt, actions: alt ? [primary, alt] : [primary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        const c = this.containers.find((x) => x.id === targetId)
        if (!slot || !c || distToRect(actor.x, actor.y, c.rect) > INTERACT_RANGE) return { handled: false }
        if (action === "search" || action === "smash") {
          const smash = action === "smash"
          const t = this.tuning
          const res = this.ledger.start(
            {
              kind: "reveal",
              actor: slot.id,
              store: c.id,
              duration: smash ? t.searchSmashTime : t.searchQuietTime,
              noise: smash ? t.searchSmashNoise : t.searchQuietNoise,
              label: `${smash ? "Smashing" : "Searching"} ${c.label.toLowerCase()}`,
            },
            {},
            { x: c.x, y: c.y },
          )
          this.feedback(slot, res.events)
          return { handled: res.ok, kind: "container", targetId: c.id, action, noise: res.noise, noiseKind: smash ? "glass" : "search" }
        }
        if (action === "take") return { handled: this.take(slot, c.id), kind: "container", targetId: c.id, action }
        return { handled: false }
      },
    }
  }

  private dropHandler(): InteractionHandler {
    return {
      kind: "drop",
      candidates: (_town, actor) => {
        const out: RawInteractCandidate[] = []
        for (const st of this.ledger.stores.values()) {
          if (!st.id.startsWith("drop:") || !st.at) continue
          if (Math.hypot(actor.x - st.at.x, actor.y - st.at.y) > DROP_RANGE) continue
          const stacks = this.contents(st.id)
          if (!stacks.length) continue
          const label = stacks.length === 1 ? this.stackLabel(stacks[0]!) : "Supplies"
          const primary: InteractAction = { id: "take", label: stacks.length === 1 ? `Pick up ${label}` : "Pick up all" }
          const r = 0.3
          out.push({ kind: "drop", id: st.id, label, rect: [st.at.x - r, st.at.y - r, st.at.x + r, st.at.y + r], worldX: st.at.x, worldY: st.at.y, primary, actions: [primary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        if (!slot || action !== "take") return { handled: false }
        // A single item on the floor swaps for what is in hand when there is no room for it.
        const one = this.contents(targetId).length === 1
        return { handled: one ? this.take(slot, targetId, 0, true) : this.take(slot, targetId), kind: "drop", targetId, action }
      },
    }
  }

  /**
   * The gear in the case that can come to hand (guns, tools, parts; not supplies), as pack slot indices in slot order:
   * Today's Tab sheet lists these and digit n picks the nth.
   */
  packPicks(actor: string): number[] {
    const st = this.ledger.store(`${actor}/pack`)
    if (!st) return []
    const out: number[] = []
    st.slots.forEach((s, i) => {
      const tag = s ? this.ledger.items.get(s.item)?.tag : undefined
      if (tag === "gun" || tag === "tool" || tag === "part") out.push(i)
    })
    return out
  }

  /** Bench parts (toolbox, car battery) the survivor carries. */
  partsOn(actor: string): ItemId[] {
    return this.contents(`${actor}/pack`)
      .filter((s) => this.ledger.items.get(s.item)?.tag === "part")
      .map((s) => s.item)
  }

  private stashHandler(): InteractionHandler {
    return {
      kind: "stash",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        const out: RawInteractCandidate[] = []
        for (const b of this.benches) {
          if (b.buildingId !== here || distToRect(actor.x, actor.y, b.stash.rect) > 1.45) continue
          const primary: InteractAction = { id: "store", label: "Store held item" }
          const secondary: InteractAction = { id: "deposit", label: "Deposit supplies", hold: true }
          out.push({ kind: "stash", id: `${b.id}#stash`, label: "House stash · shared with the bench", rect: b.stash.rect, worldX: b.stash.x, worldY: b.stash.y, primary, secondary, actions: [primary, secondary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        const benchId = targetId.replace(/#.*$/, "")
        if (!slot || !this.ledger.store(benchId)) return { handled: false }
        if (action === "deposit") return { handled: this.deposit(slot, benchId), kind: "stash", targetId, action }
        if (action !== "store") return { handled: false }
        const hotbar = this.hotbar(slot.id)!
        const held = hotbar.slots[hotbar.selected]
        if (!held || this.ledger.isBound(held.item)) {
          this.notify(slot, "Nothing in hand", "info")
          return { handled: false }
        }
        if (held.item === "pistol") {
          this.notify(slot, `Keep the ${this.ledger.label(held.item).toLowerCase()}`, "info")
          return { handled: false }
        }
        const res = this.ledger.apply({ kind: "deposit", actor: slot.id, to: benchId, from: { store: hotbar.id, slot: hotbar.selected } })
        if (res.ok) this.notify(slot, `Stored ${this.ledger.label(held.item)}`, "result")
        this.feedback(slot, res.events)
        return { handled: res.ok, kind: "stash", targetId, action }
      },
    }
  }

  // ── Doors with keys and crowbars ──────────────────────────────────────────────────────────────────────────

  /** How this actor can get through a keyed door: with a key, by prying, or not at all. */
  doorAccess(actor: InteractActorState): { key: boolean; pry: boolean } {
    const slot = this.actorOf.get(actor)
    if (!slot) return { key: false, pry: false }
    return { key: this.ledger.count(slot.id, "key") > 0, pry: this.ledger.count(slot.id, "crowbar") > 0 }
  }

  /** Opens a keyed door with a key (instant) or starts prying it. Returns the noise made. */
  openKeyed(actor: InteractActorState, door: Door, how: "unlock" | "pry"): { handled: boolean; noise?: number } {
    const slot = this.actorOf.get(actor)
    if (!slot) return { handled: false }
    if (how === "unlock") {
      const res = this.ledger.apply({ kind: "run", actor: slot.id, rule: "unlock", ref: door.id })
      if (!res.ok) {
        this.notify(slot, "No key", "warning")
        return { handled: false }
      }
      door.locked = false
      door.keyed = false
      this.notify(slot, "Unlocked", "result", "portal")
      return { handled: true, noise: 1.5 }
    }
    const cx = (door.rect[0] + door.rect[2]) / 2
    const cy = (door.rect[1] + door.rect[3]) / 2
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule: "pry", ref: door.id }, {}, { x: cx, y: cy })
    this.feedback(slot, res.events)
    return { handled: res.ok, noise: res.noise }
  }

  /** Starts prying one board off a door or window (hold E at it, `shared/interactions`). Returns the noise made. */
  startUnboard(actor: InteractActorState, portal: { id: string; rect: readonly number[] }): { handled: boolean; noise?: number } {
    const slot = this.actorOf.get(actor)
    if (!slot) return { handled: false }
    const at = { x: (portal.rect[0]! + portal.rect[2]!) / 2, y: (portal.rect[1]! + portal.rect[3]!) / 2 }
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule: "unboard", ref: portal.id, label: "Prying a board off" }, this.envFor(slot), at)
    this.feedback(slot, res.events)
    return { handled: res.ok, noise: res.noise }
  }

  // ── Actions ───────────────────────────────────────────────────────────────────────────────────────────────

  select(slot: ProgressionSlot, index?: number, delta?: number): void {
    this.ledger.apply({ kind: "select", actor: slot.id, slot: index, delta })
  }

  /** The survivor's progression verbs for one command. Returns noise the caller should emit, if any. */
  act(slot: ProgressionSlot, cmd: ProgressionCommand, world: WorldContext, target: { kind: string; id: string } | undefined): { noise: number; noiseKind: string } {
    this.world = world
    const p = slot.survivor
    let noise = 0
    let noiseKind = "door"
    const loud = (n: number, kind: string) => {
      if (n > noise) {
        noise = n
        noiseKind = kind
      }
    }
    if (cmd.pick) this.pick(slot, cmd.pick, world, target)
    // The caller decides when R means a fresh battery (`batteryReload`) rather than a magazine.
    if (cmd.reload) this.swapBattery(slot)
    if (cmd.barricade) loud(this.startBarricade(slot, world, target), "barricade")
    if (cmd.fire) {
      const use = this.heldUse(slot.id)
      if (use === "heal") this.startHeal(slot)
      else if (use === "throw") {
        // A road flare is thrown by its own feature (`shared/flares`, a survivor action after this one).
        const item = this.selected(slot.id)?.item
        if (item === "bottle") this.verbs.throwBottle(slot, world)
        else if (item === "noisemaker") this.throwLure(slot, world)
      } else if (use === "set") this.verbs.setTripwire(slot, world)
    }
    // G near a standing teammate hands it to them; otherwise it goes on the floor.
    const mate = cmd.drop || cmd.bundle ? giveTarget(slot, world.slots) : null
    if (cmd.drop) this.dropHeld(slot, mate)
    if (cmd.bundle) this.dropBundle(slot, mate)
    if (cmd.ping) this.ping(slot, world, target)
    return { noise, noiseKind }
  }

  /** A pistol view for combat: loaded rounds, capacity, belt reserve, spending and reloading. */
  pistol(id: string): PistolAmmo {
    const l = this.ledger
    const stack = () => l.store(`${id}/hotbar`)?.slots.find((s) => s?.item === "pistol") ?? null
    return {
      get loaded() {
        return stack()?.charge ?? 0
      },
      get capacity() {
        return stack() ? 8 : 0
      },
      get reserve() {
        return l.count(id, "ammo")
      },
      spend: () => l.apply({ kind: "useCharge", actor: id, item: "pistol" }).ok,
      reload: () => l.apply({ kind: "reload", actor: id, item: "pistol" }).ok,
      fill: () => void l.apply({ kind: "setCharge", actor: id, item: "pistol", charge: 8 }),
    }
  }

  /** Melee modifiers from the held tool. */
  shoveMods(id: string): { damage: number; stagger: number; range: number } {
    return {
      damage: this.ledger.stat(id, "shoveDamage", 15),
      stagger: this.ledger.stat(id, "shoveStagger", 1),
      range: this.ledger.stat(id, "shoveRange", 0),
    }
  }

  /**
   * Takes everything from a store, or the `index`th stack in pick order. With `swap`, a hand item that has no room is
   * swapped for what is in hand: the held item goes on the floor here and the new one comes up (playtest: "my
   * inventory is full"). A full take always says what is in the way and how to clear it.
   */
  take(slot: ProgressionSlot, storeId: string, index?: number, swap = false): boolean {
    let tx: Tx = { kind: "take", actor: slot.id, from: storeId }
    const wanted = index !== undefined ? this.contents(storeId)[index] : undefined
    if (index !== undefined) {
      const st = this.ledger.store(storeId)
      if (!st || !wanted) return false
      if (st.mode === "slots") tx = { ...tx, slot: st.slots.indexOf(wanted) }
      else tx = { ...tx, item: wanted.item }
    }
    const before = this.carried(slot.id)
    let res = this.ledger.apply(tx, this.envFor(slot, undefined))
    let swapped: string | null = null
    if (!res.ok && res.reason === "full" && swap && wanted && this.canSwap(slot.id, wanted.item)) {
      const held = this.selected(slot.id)!
      const dropped = this.ledger.apply({ kind: "drop", actor: slot.id, at: this.dropPoint(slot.survivor) })
      res = this.ledger.apply(tx, this.envFor(slot, undefined))
      if (res.ok) {
        swapped = this.ledger.label(held.item)
        const hotbar = this.hotbar(slot.id)!
        const at = hotbar.slots.findIndex((s) => s?.item === wanted.item)
        if (at >= 0) this.ledger.apply({ kind: "select", actor: slot.id, slot: at })
      } else if (dropped.dropId) this.ledger.apply({ kind: "take", actor: slot.id, from: dropped.dropId })
    }
    if (res.ok) {
      const gained = this.diffCarried(before, this.carried(slot.id))
      if (gained) this.notify(slot, swapped ? `Swapped your ${swapped} for ${gained}` : gained, "result", `take:${storeId}`)
      this.project(slot)
    }
    const full = (res.ok && (res.left ?? 0) > 0) || (!res.ok && res.reason === "full")
    this.feedback(slot, full ? res.events.filter((e) => !(e.kind === "rejected" && e.reason === "full")) : res.events)
    if (full) {
      const left = res.ok ? this.contents(storeId)[0] : (wanted ?? this.contents(storeId).find((s) => this.ledger.room(slot.id, s.item, 1) <= 0))
      this.notify(slot, this.noRoom(slot.id, left?.item, res.ok), "warning", "full")
    }
    return res.ok
  }

  /** A hand item that has no room can be swapped for what is in hand (anything but bare hands). */
  canSwap(actor: string, item: ItemId): boolean {
    const def = this.ledger.items.get(item)
    const held = this.selected(actor)
    if (!def || (def.tag !== "gun" && def.tag !== "tool") || !held || this.ledger.isBound(held.item)) return false
    return !def.unique || held.item === item || this.ledger.count(actor, item) === 0
  }

  /** What is in the way of a take, and the key that clears it. */
  private noRoom(actor: string, item: ItemId | undefined, partial: boolean): string {
    const def = item ? this.ledger.items.get(item) : undefined
    const what = def ? this.ledger.label(def.id) : "That"
    const lead = partial ? `No room for ${what.toLowerCase()}` : `No room for ${what}`
    if (def?.unique && this.ledger.count(actor, def.id) > 0) return `You already carry a ${what}`
    if (def?.tag === "bag") return `You already wear a ${what}`
    if (def && (def.tag === "ammo" || def.tag === "resource" || def.tag === "key")) return `No room in your case for ${this.ledger.label(def.id, true)}. Tab to make room`
    const held = this.selected(actor)
    if (held && !this.ledger.isBound(held.item)) return `${lead}: hands and case full. G drops your ${this.ledger.label(held.item)}`
    return `${lead}: hands and case full. Tab to make room`
  }

  private deposit(slot: ProgressionSlot, benchId: string): boolean {
    const before = this.carried(slot.id)
    const res = this.ledger.apply({ kind: "deposit", actor: slot.id, to: benchId })
    if (!res.ok) {
      this.notify(slot, res.reason === "full" ? "The stash is full" : "Nothing to deposit", "info", "deposit")
      return false
    }
    const moved = this.diffCarried(this.carried(slot.id), before)
    this.notify(slot, moved ? `Deposited ${moved}` : "Deposited", "result", "deposit")
    return true
  }

  /** Sets the parts the survivor carries on the bench. The toolbox on the bench top and the wired generator say the rest. */
  install(slot: ProgressionSlot, benchId: string): boolean {
    const parts = this.partsOn(slot.id)
    if (!parts.length) return false
    const res = this.ledger.apply({ kind: "deposit", actor: slot.id, to: benchId, items: Object.fromEntries(parts.map((p) => [p, 1])) })
    this.feedback(slot, res.events)
    return res.ok
  }

  private pick(slot: ProgressionSlot, pick: NonNullable<ProgressionCommand["pick"]>, world: WorldContext, target: { kind: string; id: string } | undefined): void {
    if (pick.mode === "take") {
      const store = this.storeFor(target)
      if (!store || target?.kind === "bench") return
      const stack = this.contents(store)[pick.index]
      if (target?.kind === "stash" && stack && this.ledger.items.get(stack.item)?.tag === "part") {
        this.notify(slot, "That part is installed in the bench", "info")
        return
      }
      this.take(slot, store, pick.index, true)
      return
    }
    if (pick.mode === "pack") {
      const from = this.packPicks(slot.id)[pick.index]
      if (from === undefined) return
      const hotbar = this.hotbar(slot.id)!
      // Bare hands stay put: with them selected, the pack item goes to a free hand slot instead.
      const held = hotbar.slots[hotbar.selected]
      const into = held && this.ledger.isBound(held.item) ? hotbar.slots.findIndex((s) => s === null) : hotbar.selected
      if (into < 0) {
        this.notify(slot, "Hands full", "info", "pack")
        return
      }
      const res = this.ledger.apply({ kind: "swap", actor: slot.id, a: { store: `${slot.id}/pack`, slot: from }, b: { store: hotbar.id, slot: into } })
      if (!res.ok) this.notify(slot, res.reason === "full" ? "That goes in the pack, not your hands" : "Empty pack slot", "info", "pack")
      else {
        if (into !== hotbar.selected) this.ledger.apply({ kind: "select", actor: slot.id, slot: into })
        this.project(slot)
      }
      return
    }
    if (pick.mode === "craft") {
      const recipe = this.craftable()[pick.index]
      if (!recipe) return
      const station = target?.kind === "bench" || target?.kind === "stash" ? this.storeFor(target)! : undefined
      const res = this.ledger.start({ kind: "run", actor: slot.id, rule: `craft:${recipe.id}`, station }, this.envFor(slot, world), { x: slot.survivor.x, y: slot.survivor.y })
      this.feedback(slot, res.events)
      return
    }
  }

  private startBarricade(slot: ProgressionSlot, world: WorldContext, target?: { kind: string; id: string }): number {
    const p = slot.survivor
    if (this.selected(slot.id)?.item === "crowbar") {
      const repaired = this.verbs.startRepair(slot, world)
      if (repaired !== null) return repaired
    }
    const best = this.barricadeTarget(p, world, target)
    if (!best) return 0
    if (world.ai.getBarricadePlanks(best.id) >= 3) {
      this.notify(slot, "Fully boarded", "info", "barricade")
      return 0
    }
    const reinforced = this.ledger.canApply({ kind: "run", actor: slot.id, rule: "barricade:reinforced" }).ok
    const rule = reinforced ? "barricade:reinforced" : "barricade"
    const label = `Boarding up ${world.town.doors.some((d) => d.id === best.id) ? "door" : "window"}`
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule, ref: best.id, label }, this.envFor(slot, world), { x: best.x, y: best.y })
    if (!res.ok && res.reason === "missing_item") this.notify(slot, "No planks", "warning", "barricade")
    else this.feedback(slot, res.events)
    if (!res.ok) return 0
    // Practice: hands that have nailed a few boards do it faster and quieter. Nothing on screen says so.
    return this.knowledge.practised(slot, "barricade", res.noise)
  }

  /** After a board goes up, the next one starts on the same opening (`chainBoards`), at its noise. */
  private chainBoard(slot: ProgressionSlot, portalId: string, world: WorldContext): void {
    if (!this.chainBoards || world.ai.getBarricadePlanks(portalId) >= 3 || this.ledger.count(slot.id, "plank") <= 0) return
    if (this.selected(slot.id)?.item === "crowbar") return
    const door = world.town.doors.find((d) => d.id === portalId)
    const o = door ?? world.town.windows.find((w) => w.id === portalId)
    if (!o || distToRect(slot.survivor.x, slot.survivor.y, o.rect) > INTERACT_RANGE) return
    const kind = door ? "door" : "window"
    const noise = this.startBarricade(slot, world, { kind, id: portalId })
    if (noise > 0) world.ai.emitNoise(slot.survivor.x, slot.survivor.y, noise, "barricade", world.time, slot.id)
  }

  /**
   * The opening B boards: the door or window the prompt points at (what the player sees highlighted), else the nearest
   * one in reach that is not yet fully boarded, else the nearest one.
   */
  private barricadeTarget(p: ProgressionActor, world: WorldContext, target?: { kind: string; id: string }): { id: string; x: number; y: number } | null {
    if (target && (target.kind === "door" || target.kind === "window")) {
      const o = target.kind === "door" ? world.town.doors.find((d) => d.id === target.id) : world.town.windows.find((w) => w.id === target.id)
      if (o && distToRect(p.x, p.y, o.rect) <= INTERACT_RANGE) return { id: o.id, x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 }
    }
    let best: { id: string; x: number; y: number } | null = null
    let bestDist = INTERACT_RANGE
    for (const o of [...world.town.doors, ...world.town.windows]) {
      const d = distToRect(p.x, p.y, o.rect)
      if (d <= bestDist && world.ai.getBarricadePlanks(o.id) < 3) {
        bestDist = d
        best = { id: o.id, x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 }
      }
    }
    if (best) return best
    for (const o of [...world.town.doors, ...world.town.windows]) {
      if (distToRect(p.x, p.y, o.rect) <= INTERACT_RANGE) return { id: o.id, x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 }
    }
    return null
  }

  private startHeal(slot: ProgressionSlot): void {
    const item = this.selected(slot.id)!.item
    const p = slot.survivor
    if (p.health >= p.maxHealth) {
      this.notify(slot, "Not hurt", "info", "heal")
      return
    }
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule: `heal:${item}` })
    this.feedback(slot, res.events)
  }

  private throwLure(slot: ProgressionSlot, world: WorldContext): void {
    const p = slot.survivor
    const res = this.ledger.apply({ kind: "run", actor: slot.id, rule: "throw:lure" })
    if (!res.ok) return
    const dx = Math.cos(p.aim)
    const dy = Math.sin(p.aim)
    const reach = Math.max(0.6, Math.min(LURE_RANGE, raycast(p.x, p.y, dx, dy, sightRects(world.town), LURE_RANGE)) - 0.35)
    this.lures.push({ id: this.nextId++, x: p.x + dx * reach, y: p.y + dy * reach, until: world.time + 1 + this.tuning.lureSeconds, next: world.time + 1 })
    this.notify(slot, "Noisemaker thrown", "result", "lure")
  }

  private swapBattery(slot: ProgressionSlot): void {
    const p = slot.survivor
    if (p.battery > 0.95 && !p.batteryDepleted) {
      this.notify(slot, "Battery is full", "info", "flashlight")
      return
    }
    const res = this.ledger.apply({ kind: "run", actor: slot.id, rule: "swap:battery" })
    if (!res.ok) {
      this.notify(slot, "No spare battery", "warning", "flashlight")
      return
    }
    p.battery = 1
    p.batteryDepleted = false
    this.notify(slot, "Fresh battery", "result", "flashlight")
  }

  private dropHeld(slot: ProgressionSlot, mate: ProgressionSlot | null = null): void {
    const p = slot.survivor
    const held = this.selected(slot.id)
    if (!held || this.ledger.isBound(held.item)) {
      this.notify(slot, "Nothing in hand", "info", "drop")
      return
    }
    const res = this.ledger.apply({ kind: "drop", actor: slot.id, at: mate ? this.feetOf(mate.survivor) : this.dropPoint(p) })
    if (!res.ok) return
    if (mate && res.dropId) this.handOver(slot, mate, res.dropId)
    else this.notify(slot, `Dropped ${this.ledger.label(held.item)}`, "info", "drop")
  }

  /** Seat names for notices that name a teammate; the co-op room sets real names. */
  names: SeatNames = defaultSeatName

  private feetOf(p: ProgressionActor): { x: number; y: number } {
    return { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)) }
  }

  /** The teammate picks up what was just dropped at their feet; what doesn't fit stays there for them. */
  handOver(from: ProgressionSlot, to: ProgressionSlot, dropId: string): void {
    const what = this.describe(this.contents(dropId))
    const before = this.carried(to.id)
    const res = this.ledger.apply({ kind: "take", actor: to.id, from: dropId })
    const got = this.diffCarried(before, this.carried(to.id))
    this.project(to)
    const left = this.ledger.store(dropId) ? this.describe(this.contents(dropId)) : ""
    const giver = this.names(from.index)
    const taker = this.names(to.index)
    if (got) {
      this.notify(from, `Gave ${got} to ${taker}`, "result", "give")
      this.notify(to, `${giver} gave you ${got}`, "result", "give")
    }
    if (left) {
      this.notify(from, `${taker} has no room: ${left} left at their feet`, "warning", "give")
      this.notify(to, `${giver} left ${left} at your feet: no room`, "warning", "give")
    }
    if (!res.ok && !got && !left) this.notify(from, `Couldn't give ${what}`, "info", "give")
  }

  private dropBundle(slot: ProgressionSlot, mate: ProgressionSlot | null = null): void {
    const items: Record<ItemId, number> = {}
    for (const [item, n] of Object.entries(BUNDLE)) {
      const have = this.ledger.count(slot.id, item)
      if (have > 0) items[item] = Math.min(n, have)
    }
    if (!Object.keys(items).length) {
      this.notify(slot, "No ammo or planks to share", "info", "drop")
      return
    }
    const res = this.ledger.apply({ kind: "drop", actor: slot.id, items, at: mate ? this.feetOf(mate.survivor) : this.dropPoint(slot.survivor) })
    if (!res.ok) return
    if (mate && res.dropId) this.handOver(slot, mate, res.dropId)
    else this.notify(slot, `Left ${this.describe(Object.entries(items).map(([item, count]) => ({ item, count })))}`, "result", "drop")
  }

  private dropPoint(p: ProgressionActor): { x: number; y: number } {
    const d = Math.max(0.25, Math.min(0.8, raycast(p.x, p.y, Math.cos(p.aim), Math.sin(p.aim), sightRects(this.town), 0.8) - 0.25))
    return { x: Number((p.x + Math.cos(p.aim) * d).toFixed(3)), y: Number((p.y + Math.sin(p.aim) * d).toFixed(3)) }
  }

  private ping(slot: ProgressionSlot, world: WorldContext, target: { kind: string; id: string } | undefined): void {
    const p = slot.survivor
    let at: { x: number; y: number; label: string } | null = null
    const store = this.storeFor(target)
    if (target && store) {
      const st = this.ledger.store(store)
      const stacks = this.contents(store)
      const site = this.containers.find((c) => c.id === store)
      const name = target.kind === "drop" ? "Supplies" : target.kind === "bench" ? "Workbench" : target.kind === "stash" ? "Stash" : (site?.label ?? "Here")
      const what = st && !st.revealed ? "unsearched" : stacks.length ? this.describe(stacks.slice(0, 2)) : "empty"
      const pos = st?.at ?? { x: p.x, y: p.y }
      at = { x: pos.x, y: pos.y, label: `${name}: ${what}` }
    } else if (target && (target.kind === "door" || target.kind === "window")) {
      const o = [...world.town.doors, ...world.town.windows].find((x) => x.id === target.id)
      if (o) at = { x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2, label: `${target.kind === "door" ? "Door" : "Window"} ${world.ai.getBarricadePlanks(o.id)}/3` }
    }
    if (!at) {
      let best: { x: number; y: number; d: number } | null = null
      for (const z of world.ai.agents) {
        if (z.state === "dead") continue
        const d = Math.hypot(z.x - p.x, z.y - p.y)
        if (d > 18 || Math.abs(angleDiff(Math.atan2(z.y - p.y, z.x - p.x), p.aim)) > 0.35) continue
        if (!best || d < best.d) best = { x: z.x, y: z.y, d }
      }
      at = best ? { x: best.x, y: best.y, label: "Zombie" } : { x: p.x + Math.cos(p.aim) * 5, y: p.y + Math.sin(p.aim) * 5, label: "Over here" }
    }
    const mine = this.pings.findIndex((x) => x.by === slot.index)
    if (mine >= 0) this.pings.splice(mine, 1)
    this.pings.push({ id: this.nextId++, by: slot.index, x: Number(at.x.toFixed(2)), y: Number(at.y.toFixed(2)), label: at.label, until: world.time + PING_SECONDS })
  }

  // ── Step ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Once per tick: channels (cancelled by walking off or sprinting), lures, the generator hum, and projections. */
  step(dt: number, world: WorldContext): { topologyChanged: boolean } {
    this.world = world
    let topologyChanged = false
    for (const slot of world.slots) {
      const ch = this.ledger.channel(slot.id)
      const p = slot.survivor
      if (!ch) continue
      const away = ch.at && Math.hypot(p.x - ch.at.x, p.y - ch.at.y) > INTERACT_RANGE + CHANNEL_SLACK
      if (away || (p.sprinting && ch.tx.kind === "run" && !ch.tx.rule.startsWith("craft:"))) this.ledger.cancel(slot.id)
      else if (p.sprinting) this.ledger.cancel(slot.id)
    }
    const bySlot = new Map(world.slots.map((s) => [s.id, s]))
    const events = this.ledger.step(dt, (actor) => {
      const slot = bySlot.get(actor)
      return slot ? this.envFor(slot, world) : {}
    })
    for (const ev of events) {
      const slot = "actor" in ev && ev.actor ? bySlot.get(ev.actor) : undefined
      if (!slot) continue
      if (ev.kind === "ran") topologyChanged = this.applyEffect(slot, ev, world) || topologyChanged
      this.feedback(slot, [ev])
    }
    for (let i = this.lures.length - 1; i >= 0; i--) {
      const lure = this.lures[i]!
      if (world.time >= lure.until) {
        this.lures.splice(i, 1)
        continue
      }
      if (world.time >= lure.next) {
        world.ai.emitNoise(lure.x, lure.y, this.tuning.lureNoise, "lure", world.time, "lure", 1.4)
        lure.next = world.time + 1.5
      }
    }
    for (let i = this.pings.length - 1; i >= 0; i--) if (world.time >= this.pings[i]!.until) this.pings.splice(i, 1)
    const night = dayCycle(world.hour).lamps > 0.5
    for (const b of this.benches) {
      if (!night || this.ledger.count(b.id, "car-battery") <= 0) continue
      const next = this.generatorAt.get(b.id) ?? 0
      if (world.time >= next) {
        world.ai.emitNoise(b.bench.x, b.bench.y, this.tuning.generatorNoise, "generator", world.time, "generator", 1.2)
        this.generatorAt.set(b.id, world.time + 3)
      }
    }
    if (this.knowledge.boardHeldOut(world.town, world.ai)) {
      world.ai.rebuildTopology(world.town)
      topologyChanged = true
    }
    this.board.fillIn()
    this.knowledge.stepStudy(dt, world)
    this.verbs.step(dt, world)
    for (const slot of world.slots) this.project(slot)
    return { topologyChanged }
  }

  /**
   * The case grows to the biggest bag the survivor wears, a row per pouch (`shapes.ts`). Deterministic from the
   * replicated `worn` store, so the room and a predicting client grow it alike; it never shrinks.
   */
  syncCase(actor: string): boolean {
    const pack = this.ledger.store(`${actor}/pack`)
    const worn = this.ledger.store(`${actor}/worn`)
    if (!pack?.grid || !worn) return false
    const size = caseSize((item) => worn.counts[item] ?? 0)
    return this.ledger.growGrid(pack.id, size)
  }

  /** The bag the survivor wears and the pouches on it. */
  bagOf(actor: string): { bag: BagDef; pouches: number; cols: number; rows: number } {
    const worn = this.ledger.store(`${actor}/worn`)
    const size = caseSize((item) => worn?.counts[item] ?? 0)
    return { bag: size.bag, pouches: Math.min(MAX_POUCHES, worn?.counts[POUCH] ?? 0), cols: size.cols, rows: size.rows }
  }

  /** Writes the ledger's view onto the survivor's legacy fields (HUD, wire, combat animation). */
  project(slot: ProgressionSlot): void {
    this.syncCase(slot.id)
    const p = slot.survivor
    const pistol = this.pistol(slot.id)
    p.magAmmo = pistol.loaded
    p.magCapacity = pistol.capacity || 8
    p.reserveAmmo = pistol.reserve
    p.planks = this.ledger.count(slot.id, "plank")
    const sel = this.selected(slot.id)
    const wpn = sel && isMeleeWeapon(sel.item) ? sel.item : null
    p.meleeWeapon = wpn
    p.meleeDurability = wpn ? (sel!.charge ?? MELEE_WEAPONS[wpn].durability) : 0
    p.meleeMaxDurability = wpn ? MELEE_WEAPONS[wpn].durability : 0
    p.equippedItem = wpn ? wpn : sel?.item === "pistol" ? "pistol" : "hands"
    const ch = this.ledger.channel(slot.id)
    if (!ch) p.channel = null
    else {
      const ref = ch.tx.kind === "run" ? (ch.tx.ref ?? ch.tx.station ?? "") : ch.tx.kind === "reveal" ? ch.tx.store : ""
      const kind = ch.tx.kind === "reveal" ? "search" : ch.tx.kind === "run" ? ch.tx.rule.split(":")[0]! : ch.tx.kind
      p.channel = { kind, targetId: ref, label: ch.label, x: ch.at?.x ?? p.x, y: ch.at?.y ?? p.y, elapsed: ch.elapsed, duration: ch.duration }
    }
  }

  // ── Effects and feedback ──────────────────────────────────────────────────────────────────────────────────

  envFor(slot: ProgressionSlot, world: WorldContext | undefined = this.world): LedgerEnv {
    return {
      light: world ? this.lightFor(slot, world) : 1,
      check: (tx) => {
        if (tx.kind !== "run") return null
        if (!world) return null
        if (tx.rule.startsWith("barricade") && tx.ref && world.ai.getBarricadePlanks(tx.ref) >= 3) return "fully boarded"
        if (tx.rule === "unboard" && tx.ref && world.ai.getBarricadePlanks(tx.ref) <= 0) return "not boarded"
        if (tx.rule.startsWith("heal:") && slot.survivor.health >= slot.survivor.maxHealth) return "not hurt"
        if (tx.rule === "pry") {
          const door = world.town.doors.find((d) => d.id === tx.ref)
          if (!door?.locked) return "already open"
        }
        return null
      },
    }
  }

  private lightFor(slot: ProgressionSlot, world: WorldContext): number {
    const ch = this.ledger.channel(slot.id)
    const station = ch?.tx.kind === "run" && ch.tx.station ? ch.tx.station : undefined
    const bench = station ?? this.benches.find((b) => Math.hypot(slot.survivor.x - b.bench.x, slot.survivor.y - b.bench.y) < 3)?.id
    return bench ? this.benchLight(bench, world.hour, world.slots.map((s) => s.survivor)) : dayCycle(world.hour).sun
  }

  private applyEffect(slot: ProgressionSlot, ev: Extract<LedgerEvent, { kind: "ran" }>, world: WorldContext): boolean {
    const p = slot.survivor
    if (ev.rule.startsWith("barricade") && ev.ref) {
      const hp = ev.rule === "barricade:reinforced" ? this.tuning.reinforcedPlankHp : 100
      if (!world.ai.addBarricadePlank(ev.ref, hp)) return false
      const door = world.town.doors.find((d) => d.id === ev.ref)
      if (door) door.open = false
      const win = world.town.windows.find((w) => w.id === ev.ref)
      if (win) win.open = false
      world.ai.rebuildTopology(world.town)
      this.notify(slot, `Boarded ${world.ai.getBarricadePlanks(ev.ref)}/3`, "result", "barricade")
      this.knowledge.worked(slot, "barricade", world)
      this.chainBoard(slot, ev.ref, world)
      return true
    }
    if (ev.rule === "unboard" && ev.ref) {
      if (!world.ai.removeBarricadePlank(ev.ref)) return false
      this.ledger.apply({ kind: "grant", actor: slot.id, item: "plank" })
      world.ai.rebuildTopology(world.town)
      const left = world.ai.getBarricadePlanks(ev.ref)
      this.notify(slot, left > 0 ? `Boards ${left}/3` : "Boards off", "result", "barricade")
      return true
    }
    if (ev.rule.startsWith("heal:")) {
      const amount = ev.rule === "heal:medkit" ? this.tuning.medkitHeal : this.tuning.bandageHeal
      const before = p.health
      p.health = Math.min(p.maxHealth, p.health + amount)
      this.notify(slot, `+${Math.round(p.health - before)} HP`, "result", "heal")
      return false
    }
    if (ev.rule === "pry" && ev.ref) {
      const door = world.town.doors.find((d) => d.id === ev.ref)
      if (!door) return false
      door.locked = false
      door.keyed = false
      door.open = true
      world.ai.rebuildTopology(world.town)
      this.notify(slot, "Pried open", "result", "portal")
      return true
    }
    if (ev.rule.startsWith("craft:")) {
      const recipe = RECIPES.find((r) => `craft:${r.id}` === ev.rule)
      if (recipe) this.notify(slot, `Crafted ${recipe.label}`, "result", "craft")
    }
    this.verbs.ran(slot, ev, world)
    return false
  }

  /** Turns ledger events into notices: discoveries, lessons, rejections and search results. */
  feedback(slot: ProgressionSlot, events: readonly LedgerEvent[]): void {
    for (const ev of events) {
      if (ev.kind === "revealed") {
        this.notify(slot, ev.items.length ? `Found ${this.describe(ev.items)}` : "Nothing here", ev.items.length ? "result" : "info", "search")
      } else if (ev.kind === "rejected") {
        const text = this.rejectionText(ev)
        if (text) this.notify(slot, text, "warning", `rejected:${ev.rule ?? ev.reason}`)
      }
    }
  }

  private rejectionText(ev: Extract<LedgerEvent, { kind: "rejected" }>): string | null {
    switch (ev.reason) {
      case "full":
        return ev.store?.startsWith("bench:") ? "The stash is full" : "Inventory full"
      case "low_light":
        return "Too dark"
      case "wrong_station":
        return "At a workbench"
      case "missing_item":
        return ev.item ? `Need ${this.ledger.label(ev.item, true).toLowerCase()}` : "Missing materials"
      case "missing_requirement":
        if (ev.item === "toolbox") return "Needs the toolbox installed"
        if (ev.item === "car-battery") return "Needs the generator wired in"
        if (ev.item === "pressure-tank") return "Needs a pressure tank installed"
        if (ev.item === "crowbar") return "Needs a crowbar"
        return "Not learned yet"
      case "already_known":
        return "Already learned"
      case "blocked":
        return ev.detail === "not hurt" ? "Not hurt" : ev.detail === "fully boarded" ? "Fully boarded" : null
      default:
        return null
    }
  }

  notify(slot: ProgressionSlot, text: string, kind: NoticeKind, key?: string): void {
    slot.notices.push({ text, kind, key })
    if (slot.notices.length > 24) slot.notices.splice(0, slot.notices.length - 24)
    slot.survivor.lootMessage = text
    slot.survivor.lootMessageUntil = Infinity
  }

  private allSlots: () => readonly ProgressionSlot[] = () => []
  /** The squad, for notices everyone hears (recipes learned, bench tiers). */
  bindSquad(slots: () => readonly ProgressionSlot[]): void {
    this.allSlots = slots
  }

  private notifyAll(text: string, kind: NoticeKind, key?: string): void {
    for (const s of this.allSlots()) this.notify(s, text, kind, key)
  }

  /** "9mm ×6" for belt supplies, "First Aid Kit ×2" for things you hold. */
  stackLabel(s: Stack): string {
    const label = this.ledger.label(s.item, Boolean(this.ledger.items.get(s.item)?.maxCount))
    return s.count > 1 ? `${label} ×${s.count}` : label
  }

  describe(stacks: readonly Stack[]): string {
    return stacks.map((s) => (s.count > 1 ? `${s.count} ${this.ledger.label(s.item, true)}` : this.ledger.label(s.item))).join(", ")
  }

  private carried(id: string): Map<ItemId, number> {
    const out = new Map<ItemId, number>()
    for (const t of ACTOR_STORES) {
      const st = this.ledger.store(`${id}/${t.suffix}`)
      if (!st) continue
      for (const s of this.contents(st.id)) out.set(s.item, (out.get(s.item) ?? 0) + s.count)
    }
    return out
  }

  /** "+6 9mm, Medkit" for what `after` has over `before`. */
  private diffCarried(before: Map<ItemId, number>, after: Map<ItemId, number>): string {
    const parts: Stack[] = []
    for (const [item, n] of after) {
      const d = n - (before.get(item) ?? 0)
      if (d > 0) parts.push({ item, count: d })
    }
    return parts.map((s) => (this.ledger.items.get(s.item)?.maxCount ? `+${s.count} ${this.ledger.label(s.item, true)}` : this.ledger.label(s.item))).join(", ")
  }
}
