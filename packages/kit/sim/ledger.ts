/**
 * Deterministic inventory, container, crafting, research, skill, and progression ledger.
 *
 * Everything held, counted, installed, or known is a `Stack` inside a constrained `Store`.
 * Every action (reload, search, loot, drop, barricade, bench prototype, manual study, skill XP,
 * supply-locker claim, and run-end meta unlock) is an atomic `Tx` applied to the `Ledger`.
 */

export type ItemId = string
export type StoreId = string
export type RuleId = string
export type ActorId = string
export type StatKey = string

export type StatMod = {
  add?: number
  mul?: number
}

export type ItemDef = {
  id: ItemId
  label: string
  shortLabel?: string
  /** Category tag matched against store `accepts` filters ("tool", "resource", "part", "manual", "knowledge", "skill", "upgrade"). */
  tag: string
  /** Max count per slot in a slotted store (default 1). */
  stack?: number
  /** Slots occupied in a slotted store (default 1; e.g. 2 for a heavy Car Battery). */
  slots?: number
  /** Default cap in a counter store when not overridden by `StoreSpec.caps`. */
  maxCount?: number
  /** Internal charge or magazine capacity (e.g. `{ max: 8, ammo: "ammo" }` for a pistol). */
  charge?: {
    max: number
    initial?: number
    ammo?: ItemId
  }
  /** Stat modifiers active while this item is held/known (or only while selected in a hotbar when `activeOnly: true`). */
  mods?: Readonly<Record<StatKey, number | StatMod>>
  activeOnly?: boolean
  /** Knowledge/recipe tokens automatically granted to `discoverStore` the first time any actor acquires this item. */
  discovers?: readonly ItemId[]
  /** Kit/bundle contents unpacked into the actor's stores when this item is taken (e.g. Supply Locker rack). */
  grants?: Readonly<Record<ItemId, number>>
}

export type Stack = {
  item: ItemId
  count: number
  charge?: number
  active?: boolean
}

export type StoreMode = "slots" | "counters"
export type StoreScope = "personal" | "shared" | "persistent"

export type StoreSpec = {
  id: StoreId
  mode: StoreMode
  scope?: StoreScope
  owner?: ActorId
  /** Slot capacity for `"slots"` stores. */
  size?: number
  /** Item tags accepted during auto-routing (`take`, `give`, `deposit`). */
  accepts?: readonly string[]
  /** Per-item count caps for `"counters"` stores. */
  caps?: Readonly<Record<ItemId, number>>
  /** Whether contents can be inspected/taken before a `reveal` transaction (default true). */
  revealed?: boolean
  /** Max items a single actor can take from this store (e.g. 1 for a 4-rack co-op Supply Locker). */
  claimLimit?: number
  /** World position for spatial stores (containers, workbenches, ground drops). */
  at?: { x: number; y: number }
  /** Initial contents. */
  initial?: readonly (Stack | null)[] | Readonly<Record<ItemId, number>>
}

export type ActorStoreTemplate = Omit<StoreSpec, "id" | "owner"> & {
  /** Store suffix appended as `${actorId}/${suffix}` (e.g. "hotbar", "belt", "pack", "skills"). */
  suffix: string
  /** If true, `deposit` can pull from this store when transferring supplies to a station. */
  depositable?: boolean
}

export type Rule = {
  id: RuleId
  label: string
  /** Channel duration in seconds (0 or omitted for instant execution). */
  duration?: number
  /** Stat key that multiplies duration (e.g. "craftTime", "studyTime", "healTime", "barricadeTime"). */
  durationStat?: StatKey
  /** Noise radius in metres emitted when executed. */
  noise?: number
  /** Stat key that multiplies noise radius (e.g. "barricadeNoise", "searchNoise"). */
  noiseStat?: StatKey
  /** Minimum illumination required (e.g. 0.35 for workbench research or manual reading). */
  lightMin?: number
  /** Required station store ID or prefix (e.g. "bench" matches "bench:ash"). */
  station?: string
  /** Items or knowledge tokens required (not consumed) across actor, station, and shared knowledge stores. */
  requires?: Readonly<Record<ItemId, number>>
  /** Items or knowledge tokens that must not already be present (prevents duplicate research/unlocks). */
  forbids?: Readonly<Record<ItemId, number>>
  /** Items consumed from the actor's stores (and the station store when `station` is active). */
  consume?: Readonly<Record<ItemId, number>>
  /** Items produced when the rule commits. */
  produce?: Readonly<Record<ItemId, number>>
  /** Destination for produced items: `"actor"` (default), `"station"`, `"target"`, or an explicit `StoreId`. */
  produceTo?: "actor" | "station" | "target" | StoreId
}

export type SkillRank = {
  xp: number
  grants: ItemId
}

export type SkillTrack = {
  xpItem: ItemId
  ranks: readonly SkillRank[]
}

export type LedgerTuning = {
  searchQuietTime: number
  searchQuietNoise: number
  searchSmashTime: number
  searchSmashNoise: number
  reloadTime: number
  reloadNoise: number
  craftTimeScale: number
  studyLightMin: number
  nightXpMultiplier: number
}

export const DEFAULT_LEDGER_TUNING: LedgerTuning = {
  searchQuietTime: 1.2,
  searchQuietNoise: 3.5,
  searchSmashTime: 0.35,
  searchSmashNoise: 14.0,
  reloadTime: 1.15,
  reloadNoise: 2.8,
  craftTimeScale: 1.0,
  studyLightMin: 0.35,
  nightXpMultiplier: 2.0,
}

export type LedgerCatalog = {
  items: readonly ItemDef[]
  actorStores: readonly ActorStoreTemplate[]
  stores?: readonly StoreSpec[]
  rules?: readonly Rule[]
  skills?: readonly SkillTrack[]
  /** Shared knowledge store ID where touch-to-discover tokens are recorded (default `"team/known"`). */
  discoverStore?: StoreId
  /** Additional shared stores consulted by `has()` and `stat()` for every actor (e.g. `["team/known", "host/meta"]`). */
  sharedKnowledgeStores?: readonly StoreId[]
}

export type StoreState = {
  id: StoreId
  mode: StoreMode
  scope: StoreScope
  owner?: ActorId
  size: number
  accepts: readonly string[]
  caps: Record<ItemId, number>
  revealed: boolean
  claimLimit?: number
  claims: Record<ActorId, number>
  at?: { x: number; y: number }
  selected: number
  slots: (Stack | null)[]
  counts: Record<ItemId, number>
  rev: number
}

export type ActiveChannel = {
  actor: ActorId
  tx: Tx
  label: string
  elapsed: number
  duration: number
  noise: number
  at?: { x: number; y: number }
}

export type LedgerEnv = {
  /** Local illumination at the actor's position (0..1.5, default 1). */
  light?: number
  /** Shared night/director threat (0..1, default 0). */
  threat?: number
  /** Optional per-call tuning overrides. */
  tuning?: Partial<LedgerTuning>
}

export type Tx =
  | { kind: "select"; actor: ActorId; slot?: number; delta?: number; store?: StoreId }
  | { kind: "reload"; actor: ActorId; weaponStore?: StoreId; ammoStore?: StoreId }
  | { kind: "useCharge"; actor: ActorId; item?: ItemId; amount?: number; store?: StoreId }
  | { kind: "reveal"; actor: ActorId; store: StoreId; mode?: "quiet" | "smash" }
  | { kind: "take"; actor: ActorId; from: StoreId; slot?: number; item?: ItemId; count?: number }
  | { kind: "deposit"; actor: ActorId; to: StoreId; items?: Readonly<Record<ItemId, number>> }
  | { kind: "drop"; actor: ActorId; items?: Readonly<Record<ItemId, number>>; slot?: number; at: { x: number; y: number } }
  | { kind: "run"; actor: ActorId; rule: RuleId; station?: StoreId; target?: StoreId }
  | { kind: "grant"; actor: ActorId; item: ItemId; count?: number; store?: StoreId; scaleWithNight?: boolean }
  | { kind: "drain"; store: StoreId; item: ItemId; count?: number; actor?: ActorId }
  | { kind: "bank"; actor: ActorId; from: StoreId; to: StoreId | readonly StoreId[]; item?: ItemId }

export type TxFailureReason =
  | "unknown_item"
  | "unknown_store"
  | "unknown_rule"
  | "unrevealed"
  | "already_revealed"
  | "already_known"
  | "claim_limit"
  | "low_light"
  | "wrong_station"
  | "missing_requirement"
  | "missing_item"
  | "full"
  | "empty"

export type TxCheck =
  | { ok: true; duration: number; noise: number; label: string }
  | { ok: false; reason: TxFailureReason; item?: ItemId; store?: StoreId; rule?: RuleId }

export type LedgerEvent =
  | { kind: "changed"; actor?: ActorId; store: StoreId; item: ItemId; delta: number; count: number }
  | { kind: "charged"; actor: ActorId; store: StoreId; slot: number; item: ItemId; delta: number; charge: number; capacity: number }
  | { kind: "selected"; actor: ActorId; store: StoreId; slot: number; item: ItemId | null }
  | { kind: "revealed"; actor: ActorId; store: StoreId; mode: "quiet" | "smash"; noise: number; items: Stack[] }
  | { kind: "dropped"; actor: ActorId; dropId: StoreId; at: { x: number; y: number }; items: Stack[] }
  | { kind: "unlocked"; actor: ActorId; store: StoreId; item: ItemId; label: string; source: "discover" | "rule" | "skill" }
  | { kind: "channel"; actor: ActorId; state: "started" | "progress" | "completed" | "cancelled"; label: string; progress: number; noise: number }
  | { kind: "rejected"; actor?: ActorId; reason: TxFailureReason; item?: ItemId; store?: StoreId; rule?: RuleId }

export type TxResult = {
  ok: boolean
  reason?: TxFailureReason
  item?: ItemId
  store?: StoreId
  dropId?: StoreId
  noise: number
  events: LedgerEvent[]
}

export type SnapshotFilter = {
  scope?: StoreScope | readonly StoreScope[]
  owner?: ActorId
}

export type SerializedStore = {
  id: StoreId
  mode: StoreMode
  scope: StoreScope
  owner?: ActorId
  size: number
  accepts: readonly string[]
  caps: Record<ItemId, number>
  revealed: boolean
  claimLimit?: number
  claims: Record<ActorId, number>
  at?: { x: number; y: number }
  selected: number
  slots?: (Stack | null)[]
  counts?: Record<ItemId, number>
  rev: number
}

export type LedgerSnapshot = {
  rev: number
  nextDropId: number
  stores: SerializedStore[]
  channels: ActiveChannel[]
}

export type LedgerDelta = {
  fromRev: number
  toRev: number
  nextDropId: number
  upserted: SerializedStore[]
  removed: StoreId[]
  channels: ActiveChannel[]
}

export class Ledger {
  readonly items = new Map<ItemId, ItemDef>()
  readonly rules = new Map<RuleId, Rule>()
  readonly skillsByXp = new Map<ItemId, SkillTrack>()
  readonly actorTemplates: readonly ActorStoreTemplate[]
  readonly discoverStoreId: StoreId
  readonly sharedKnowledgeStores: readonly StoreId[]
  readonly stores = new Map<StoreId, StoreState>()
  readonly channels = new Map<ActorId, ActiveChannel>()
  readonly actors = new Set<ActorId>()
  tuning: LedgerTuning
  rev = 0
  private nextDropId = 1
  private listeners = new Set<(ev: LedgerEvent) => void>()
  private removedStores = new Map<StoreId, number>()

  constructor(catalog: LedgerCatalog, tuning: Partial<LedgerTuning> = {}) {
    this.tuning = { ...DEFAULT_LEDGER_TUNING, ...tuning }
    for (const item of catalog.items) this.items.set(item.id, item)
    for (const rule of catalog.rules ?? []) this.rules.set(rule.id, rule)
    for (const track of catalog.skills ?? []) this.skillsByXp.set(track.xpItem, track)
    this.actorTemplates = catalog.actorStores
    this.discoverStoreId = catalog.discoverStore ?? "team/known"
    this.sharedKnowledgeStores = catalog.sharedKnowledgeStores ?? [this.discoverStoreId]

    for (const spec of catalog.stores ?? []) {
      this.createStore(spec)
    }
    if (!this.stores.has(this.discoverStoreId)) {
      this.createStore({ id: this.discoverStoreId, mode: "counters", scope: "shared", accepts: ["knowledge", "upgrade"] })
    }
  }

  /** Subscribes a listener (such as HUD callouts or audio) to every committed or rejected ledger event. */
  on(listener: (event: LedgerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Instantiates personal stores (`${actor}/hotbar`, `${actor}/belt`, `${actor}/pack`, `${actor}/skills`) for an actor. */
  addActor(actor: ActorId): void {
    this.actors.add(actor)
    for (const tpl of this.actorTemplates) {
      const id = `${actor}/${tpl.suffix}`
      if (!this.stores.has(id)) {
        this.createStore({
          ...tpl,
          id,
          owner: actor,
          scope: tpl.scope ?? "personal",
        })
      }
    }
  }

  createStore(spec: StoreSpec): StoreState {
    const size = spec.size ?? (Array.isArray(spec.initial) ? spec.initial.length : 0)
    const slots: (Stack | null)[] =
      spec.mode === "slots"
        ? Array.from({ length: size }, (_, i) => {
            const init = Array.isArray(spec.initial) ? spec.initial[i] : null
            return init ? this.normalizeStack(init) : null
          })
        : []
    const counts: Record<ItemId, number> = {}
    if (spec.mode === "counters" && spec.initial && !Array.isArray(spec.initial)) {
      for (const [k, v] of Object.entries(spec.initial as Record<ItemId, number>)) {
        if (v > 0) counts[k] = v
      }
    }
    const st: StoreState = {
      id: spec.id,
      mode: spec.mode,
      scope: spec.scope ?? (spec.owner ? "personal" : "shared"),
      owner: spec.owner,
      size,
      accepts: spec.accepts ?? [],
      caps: { ...(spec.caps ?? {}) },
      revealed: spec.revealed ?? true,
      claimLimit: spec.claimLimit,
      claims: {},
      at: spec.at ? { ...spec.at } : undefined,
      selected: 0,
      slots,
      counts,
      rev: ++this.rev,
    }
    this.stores.set(st.id, st)
    this.removedStores.delete(st.id)
    return st
  }

  store(id: StoreId): StoreState | undefined {
    return this.stores.get(id)
  }

  /** Returns the total count of `item` in a specific `StoreId` or across all personal stores of an `ActorId`. */
  count(storeOrActor: string, item: ItemId): number {
    const direct = this.stores.get(storeOrActor)
    if (direct) return this.countInStore(direct, item)
    let total = 0
    for (const tpl of this.actorTemplates) {
      const st = this.stores.get(`${storeOrActor}/${tpl.suffix}`)
      if (st) total += this.countInStore(st, item)
    }
    return total
  }

  /** Checks whether `actor` (including shared knowledge and optional `station`) holds at least `min` of `item`. */
  has(actor: ActorId, item: ItemId, min = 1, station?: StoreId): boolean {
    let total = this.count(actor, item)
    for (const sharedId of this.sharedKnowledgeStores) {
      const st = this.stores.get(sharedId)
      if (st) total += this.countInStore(st, item)
    }
    if (station) {
      const st = this.stores.get(station)
      if (st) total += this.countInStore(st, item)
    }
    return total >= min
  }

  /** Returns the currently selected stack in `${actor}/${hotbarSuffix}`. */
  activeItem(actor: ActorId, hotbarSuffix = "hotbar"): Stack | null {
    const st = this.stores.get(`${actor}/${hotbarSuffix}`)
    if (!st || st.mode !== "slots") return null
    return st.slots[st.selected] ?? null
  }

  /** Formats a compact HUD badge for a stack (e.g. `"9MM 8/24"` or `"MED ×2"`). */
  formatStack(actor: ActorId, stack: Stack | null): string {
    if (!stack) return "—"
    const def = this.items.get(stack.item)
    const label = def?.shortLabel ?? def?.label ?? stack.item
    if (def?.charge?.ammo) {
      const reserve = this.count(actor, def.charge.ammo)
      return `${label} ${stack.charge ?? 0}/${reserve}`
    }
    if ((def?.stack ?? 1) > 1 && stack.count > 1) {
      return `${label} ×${stack.count}`
    }
    return label
  }

  /**
   * Computes a derived numeric stat for `actor` by folding `mods` from the actor's stores and shared knowledge stores:
   * `(base + sum(add)) * prod(mul)`.
   */
  stat(actor: ActorId, key: StatKey, base: number, extraStores: readonly StoreId[] = []): number {
    let add = 0
    let mul = 1

    const foldItem = (itemId: ItemId, count: number, isActiveSlot: boolean) => {
      if (count <= 0) return
      const def = this.items.get(itemId)
      if (!def?.mods) return
      if (def.activeOnly && !isActiveSlot) return
      const mod = def.mods[key]
      if (mod === undefined) return
      if (typeof mod === "number") {
        add += mod
      } else {
        if (mod.add !== undefined) add += mod.add
        if (mod.mul !== undefined) mul *= mod.mul
      }
    }

    const inspectStore = (st: StoreState | undefined) => {
      if (!st) return
      if (st.mode === "slots") {
        for (let i = 0; i < st.slots.length; i++) {
          const s = st.slots[i]
          if (s) foldItem(s.item, s.count, i === st.selected)
        }
      } else {
        for (const [itemId, count] of Object.entries(st.counts)) {
          foldItem(itemId, count, false)
        }
      }
    }

    for (const tpl of this.actorTemplates) {
      inspectStore(this.stores.get(`${actor}/${tpl.suffix}`))
    }
    for (const sharedId of this.sharedKnowledgeStores) {
      inspectStore(this.stores.get(sharedId))
    }
    for (const extraId of extraStores) {
      inspectStore(this.stores.get(extraId))
    }

    return Number(((base + add) * mul).toFixed(6))
  }

  /** Effective capacity for `item` in a counter store, including any `cap:${item}` stat modifiers on its owner. */
  capFor(st: StoreState, item: ItemId): number {
    const def = this.items.get(item)
    const rawCap = st.caps[item] ?? def?.maxCount ?? Infinity
    if (!Number.isFinite(rawCap) || !st.owner) return rawCap
    return Math.max(0, Math.round(this.stat(st.owner, `cap:${item}`, rawCap)))
  }

  /** Used slot capacity in a `"slots"` store, accounting for multi-slot heavy items (`ItemDef.slots`). */
  usedSlots(st: StoreState): number {
    let used = 0
    for (const s of st.slots) {
      if (!s) continue
      const def = this.items.get(s.item)
      used += def?.slots ?? 1
    }
    return used
  }

  /** Validates whether `tx` can execute in `env` and returns its effective duration and noise. */
  canApply(tx: Tx, env: LedgerEnv = {}): TxCheck {
    const tuning = { ...this.tuning, ...(env.tuning ?? {}) }

    switch (tx.kind) {
      case "select": {
        const st = this.stores.get(tx.store ?? `${tx.actor}/hotbar`)
        if (!st || st.mode !== "slots") return { ok: false, reason: "unknown_store", store: tx.store }
        return { ok: true, duration: 0, noise: 0, label: "Select" }
      }

      case "reload": {
        const weaponInfo = this.findRechargeableWeapon(tx.actor, tx.weaponStore)
        if (!weaponInfo) return { ok: false, reason: "empty" }
        const { stack, def } = weaponInfo
        const ammoItem = def.charge!.ammo!
        const magCap = Math.round(this.stat(tx.actor, "magCapacity", def.charge!.max))
        if ((stack.charge ?? 0) >= magCap) return { ok: false, reason: "full", item: stack.item }
        if (this.count(tx.ammoStore ?? tx.actor, ammoItem) <= 0) {
          return { ok: false, reason: "missing_item", item: ammoItem }
        }
        return {
          ok: true,
          duration: this.stat(tx.actor, "reloadTime", tuning.reloadTime),
          noise: this.stat(tx.actor, "reloadNoise", tuning.reloadNoise),
          label: `Reload ${def.label}`,
        }
      }

      case "useCharge": {
        const st = this.stores.get(tx.store ?? `${tx.actor}/hotbar`)
        if (!st || st.mode !== "slots") return { ok: false, reason: "unknown_store" }
        const stack = tx.item ? st.slots.find((s) => s?.item === tx.item) : st.slots[st.selected]
        if (!stack) return { ok: false, reason: "empty", item: tx.item }
        const amount = tx.amount ?? 1
        if ((stack.charge ?? 0) < amount) return { ok: false, reason: "empty", item: stack.item }
        return { ok: true, duration: 0, noise: 0, label: stack.item }
      }

      case "reveal": {
        const st = this.stores.get(tx.store)
        if (!st) return { ok: false, reason: "unknown_store", store: tx.store }
        if (st.revealed) return { ok: false, reason: "already_revealed", store: tx.store }
        const smash = tx.mode === "smash"
        const baseDur = smash ? tuning.searchSmashTime : tuning.searchQuietTime
        const baseNoise = smash ? tuning.searchSmashNoise : tuning.searchQuietNoise
        return {
          ok: true,
          duration: this.stat(tx.actor, "searchTime", baseDur),
          noise: this.stat(tx.actor, "searchNoise", baseNoise),
          label: smash ? "Smashing container" : "Searching container",
        }
      }

      case "take": {
        const from = this.stores.get(tx.from)
        if (!from) return { ok: false, reason: "unknown_store", store: tx.from }
        if (!from.revealed) return { ok: false, reason: "unrevealed", store: tx.from }
        if (from.claimLimit !== undefined && (from.claims[tx.actor] ?? 0) >= from.claimLimit) {
          return { ok: false, reason: "claim_limit", store: tx.from }
        }
        const candidates = this.extractableStacks(from, tx.slot, tx.item, tx.count)
        if (!candidates.length) return { ok: false, reason: "empty", store: tx.from }
        const fitsAny = candidates.some((s) => this.canFitActor(tx.actor, s.item, 1))
        if (!fitsAny) return { ok: false, reason: "full", item: candidates[0]!.item }
        return { ok: true, duration: 0, noise: 0, label: "Take" }
      }

      case "deposit": {
        const to = this.stores.get(tx.to)
        if (!to) return { ok: false, reason: "unknown_store", store: tx.to }
        const plan = this.buildDepositPlan(tx.actor, to, tx.items)
        if (!Object.keys(plan).length) return { ok: false, reason: "empty", store: tx.to }
        return { ok: true, duration: 0, noise: 0, label: "Deposit supplies" }
      }

      case "drop": {
        if (tx.items) {
          for (const [item, count] of Object.entries(tx.items)) {
            if (count > 0 && this.count(tx.actor, item) < count) {
              return { ok: false, reason: "missing_item", item }
            }
          }
          return { ok: true, duration: 0, noise: 0, label: "Drop bundle" }
        }
        const hotbar = this.stores.get(`${tx.actor}/hotbar`)
        const slotIdx = tx.slot ?? hotbar?.selected ?? 0
        const stack = hotbar?.slots[slotIdx]
        if (!stack) return { ok: false, reason: "empty" }
        return { ok: true, duration: 0, noise: 0, label: `Drop ${stack.item}` }
      }

      case "run": {
        const rule = this.rules.get(tx.rule)
        if (!rule) return { ok: false, reason: "unknown_rule", rule: tx.rule }
        const lightMin = rule.lightMin !== undefined ? Math.min(rule.lightMin, tuning.studyLightMin || rule.lightMin) : undefined
        if (lightMin !== undefined && (env.light ?? 1) + 1e-6 < lightMin) {
          return { ok: false, reason: "low_light", rule: rule.id }
        }
        if (rule.station) {
          if (!tx.station || !(tx.station === rule.station || tx.station.startsWith(`${rule.station}:`))) {
            return { ok: false, reason: "wrong_station", rule: rule.id, store: tx.station }
          }
          if (!this.stores.has(tx.station)) {
            return { ok: false, reason: "unknown_store", rule: rule.id, store: tx.station }
          }
        }
        for (const [forbidItem, min] of Object.entries(rule.forbids ?? {})) {
          if (this.has(tx.actor, forbidItem, min, tx.station)) {
            return { ok: false, reason: "already_known", rule: rule.id, item: forbidItem }
          }
        }
        for (const [reqItem, min] of Object.entries(rule.requires ?? {})) {
          if (!this.has(tx.actor, reqItem, min, tx.station)) {
            return { ok: false, reason: "missing_requirement", rule: rule.id, item: reqItem }
          }
        }
        for (const [conItem, needed] of Object.entries(rule.consume ?? {})) {
          const avail = this.count(tx.actor, conItem) + (tx.station ? this.count(tx.station, conItem) : 0)
          if (avail < needed) {
            return { ok: false, reason: "missing_item", rule: rule.id, item: conItem }
          }
        }
        if (rule.produce) {
          const destCheck = this.canFitProduced(tx.actor, rule, tx.station, tx.target)
          if (!destCheck.ok) return destCheck
        }
        const baseDur = (rule.duration ?? 0) * tuning.craftTimeScale
        const duration = rule.durationStat ? this.stat(tx.actor, rule.durationStat, baseDur) : baseDur
        const baseNoise = rule.noise ?? 0
        const noise = rule.noiseStat ? this.stat(tx.actor, rule.noiseStat, baseNoise) : baseNoise
        return { ok: true, duration, noise, label: rule.label }
      }

      case "grant": {
        if (!this.items.has(tx.item)) return { ok: false, reason: "unknown_item", item: tx.item }
        return { ok: true, duration: 0, noise: 0, label: `Grant ${tx.item}` }
      }

      case "drain": {
        const st = this.stores.get(tx.store)
        if (!st) return { ok: false, reason: "unknown_store", store: tx.store }
        if (this.countInStore(st, tx.item) <= 0) return { ok: false, reason: "empty", store: tx.store, item: tx.item }
        return { ok: true, duration: 0, noise: 0, label: `Drain ${tx.item}` }
      }

      case "bank": {
        const from = this.stores.get(tx.from)
        if (!from) return { ok: false, reason: "unknown_store", store: tx.from }
        const targets = Array.isArray(tx.to) ? tx.to : [tx.to]
        for (const t of targets) {
          if (!this.stores.has(t)) return { ok: false, reason: "unknown_store", store: t }
        }
        const hasAny = tx.item ? this.countInStore(from, tx.item) > 0 : Object.values(from.counts).some((v) => v > 0)
        if (!hasAny) return { ok: false, reason: "empty", store: tx.from, item: tx.item }
        return { ok: true, duration: 0, noise: 0, label: "Bank samples" }
      }
    }
  }

  /**
   * Starts a timed channel if the transaction has `duration > 0` (e.g. searching, reloading, barricading,
   * bench prototyping, studying a manual, or field crafting), or commits immediately when `duration === 0`.
   */
  start(tx: Tx, env: LedgerEnv = {}, at?: { x: number; y: number }): TxResult {
    const check = this.canApply(tx, env)
    const actor = "actor" in tx ? tx.actor : undefined
    if (!check.ok) {
      const ev: LedgerEvent = {
        kind: "rejected",
        actor,
        reason: check.reason,
        item: check.item,
        store: check.store,
        rule: check.rule,
      }
      this.emit(ev)
      return { ok: false, reason: check.reason, item: check.item, store: check.store, noise: 0, events: [ev] }
    }
    if (!actor || check.duration <= 0) {
      return this.apply(tx, env)
    }
    const ch: ActiveChannel = {
      actor,
      tx,
      label: check.label,
      elapsed: 0,
      duration: check.duration,
      noise: check.noise,
      at,
    }
    this.channels.set(actor, ch)
    this.rev++
    const ev: LedgerEvent = {
      kind: "channel",
      actor,
      state: "started",
      label: ch.label,
      progress: 0,
      noise: ch.noise,
    }
    this.emit(ev)
    return { ok: true, noise: ch.noise, events: [ev] }
  }

  /** Cancels an actor's in-flight channel (e.g. when walking out of range or sprinting). */
  cancel(actor: ActorId): LedgerEvent | null {
    const ch = this.channels.get(actor)
    if (!ch) return null
    this.channels.delete(actor)
    this.rev++
    const ev: LedgerEvent = {
      kind: "channel",
      actor,
      state: "cancelled",
      label: ch.label,
      progress: ch.elapsed / Math.max(0.01, ch.duration),
      noise: 0,
    }
    this.emit(ev)
    return ev
  }

  /** Advances all active channels by `dt` seconds and commits any that reach completion. */
  step(dt: number, env: LedgerEnv = {}): LedgerEvent[] {
    if (dt <= 0 || !this.channels.size) return []
    const out: LedgerEvent[] = []
    for (const [actor, ch] of [...this.channels.entries()]) {
      ch.elapsed += dt
      if (ch.elapsed + 1e-6 >= ch.duration) {
        this.channels.delete(actor)
        const doneEv: LedgerEvent = {
          kind: "channel",
          actor,
          state: "completed",
          label: ch.label,
          progress: 1,
          noise: ch.noise,
        }
        this.emit(doneEv)
        out.push(doneEv)
        const res = this.apply(ch.tx, env)
        out.push(...res.events)
      } else {
        const progEv: LedgerEvent = {
          kind: "channel",
          actor,
          state: "progress",
          label: ch.label,
          progress: Math.min(1, ch.elapsed / Math.max(0.01, ch.duration)),
          noise: 0,
        }
        this.emit(progEv)
        out.push(progEv)
      }
    }
    return out
  }

  /** Atomically validates and commits `tx` immediately. */
  apply(tx: Tx, env: LedgerEnv = {}): TxResult {
    const check = this.canApply(tx, env)
    const actor = "actor" in tx ? tx.actor : undefined
    if (!check.ok) {
      const ev: LedgerEvent = {
        kind: "rejected",
        actor,
        reason: check.reason,
        item: check.item,
        store: check.store,
        rule: check.rule,
      }
      this.emit(ev)
      return { ok: false, reason: check.reason, item: check.item, store: check.store, noise: 0, events: [ev] }
    }

    const events: LedgerEvent[] = []
    const record = (ev: LedgerEvent) => {
      events.push(ev)
      this.emit(ev)
    }

    switch (tx.kind) {
      case "select": {
        const st = this.stores.get(tx.store ?? `${tx.actor}/hotbar`)!
        if (tx.slot !== undefined && Number.isInteger(tx.slot) && tx.slot >= 0 && tx.slot < st.size) {
          st.selected = tx.slot
        } else if (tx.delta) {
          const step = Number.isInteger(tx.delta) && Math.abs(tx.delta) <= st.size ? tx.delta : Math.sign(tx.delta)
          st.selected = (((st.selected + step) % st.size) + st.size) % st.size
        }
        st.rev = ++this.rev
        const selectedStack = st.slots[st.selected] ?? null
        record({ kind: "selected", actor: tx.actor, store: st.id, slot: st.selected, item: selectedStack?.item ?? null })
        return { ok: true, store: st.id, item: selectedStack?.item, noise: 0, events }
      }

      case "reload": {
        const weaponInfo = this.findRechargeableWeapon(tx.actor, tx.weaponStore)!
        const { store: weaponStore, slotIndex, stack, def } = weaponInfo
        const ammoItem = def.charge!.ammo!
        const magCap = Math.round(this.stat(tx.actor, "magCapacity", def.charge!.max))
        const needed = magCap - (stack.charge ?? 0)
        const avail = this.count(tx.ammoStore ?? tx.actor, ammoItem)
        const loaded = Math.min(needed, avail)
        this.consumeFromActor(tx.actor, ammoItem, loaded, tx.ammoStore, record)
        stack.charge = (stack.charge ?? 0) + loaded
        weaponStore.rev = ++this.rev
        record({
          kind: "charged",
          actor: tx.actor,
          store: weaponStore.id,
          slot: slotIndex,
          item: stack.item,
          delta: loaded,
          charge: stack.charge,
          capacity: magCap,
        })
        return { ok: true, store: weaponStore.id, item: stack.item, noise: check.noise, events }
      }

      case "useCharge": {
        const st = this.stores.get(tx.store ?? `${tx.actor}/hotbar`)!
        const slotIndex = tx.item ? st.slots.findIndex((s) => s?.item === tx.item) : st.selected
        const stack = st.slots[slotIndex]!
        const def = this.items.get(stack.item)!
        const amount = tx.amount ?? 1
        stack.charge = Math.max(0, (stack.charge ?? 0) - amount)
        st.rev = ++this.rev
        const cap = def.charge ? Math.round(this.stat(tx.actor, "magCapacity", def.charge.max)) : 1
        record({
          kind: "charged",
          actor: tx.actor,
          store: st.id,
          slot: slotIndex,
          item: stack.item,
          delta: -amount,
          charge: stack.charge,
          capacity: cap,
        })
        return { ok: true, store: st.id, item: stack.item, noise: 0, events }
      }

      case "reveal": {
        const st = this.stores.get(tx.store)!
        st.revealed = true
        st.rev = ++this.rev
        const items = this.snapshotStoreStacks(st)
        record({
          kind: "revealed",
          actor: tx.actor,
          store: st.id,
          mode: tx.mode ?? "quiet",
          noise: check.noise,
          items,
        })
        return { ok: true, store: st.id, noise: check.noise, events }
      }

      case "take": {
        const from = this.stores.get(tx.from)!
        let tookAny = false

        if (from.mode === "slots") {
          const indices = tx.slot !== undefined ? [tx.slot] : from.slots.map((_, i) => i)
          for (const idx of indices) {
            const s = from.slots[idx]
            if (!s) continue
            if (tx.item && s.item !== tx.item) continue
            const def = this.items.get(s.item)
            if (def?.grants) {
              // Bundle/Rack item: unpack all granted items into the actor's stores if they fit.
              const fitsAll = Object.entries(def.grants).every(([gItem, gCount]) =>
                this.canFitActor(tx.actor, gItem, gCount),
              )
              if (!fitsAll) continue
              from.slots[idx] = null
              from.rev = ++this.rev
              record({ kind: "changed", actor: tx.actor, store: from.id, item: s.item, delta: -s.count, count: 0 })
              for (const [gItem, gCount] of Object.entries(def.grants)) {
                this.giveToActor(tx.actor, { item: gItem, count: gCount }, record, env)
              }
              tookAny = true
            } else {
              const reqCount = tx.count !== undefined ? Math.min(s.count, tx.count) : s.count
              const added = this.giveToActor(tx.actor, { ...s, count: reqCount }, record, env)
              if (added > 0) {
                s.count -= added
                if (s.count <= 0) from.slots[idx] = null
                from.rev = ++this.rev
                record({
                  kind: "changed",
                  actor: tx.actor,
                  store: from.id,
                  item: s.item,
                  delta: -added,
                  count: this.countInStore(from, s.item),
                })
                tookAny = true
              }
            }
            if (from.claimLimit !== undefined && tookAny) {
              from.claims[tx.actor] = (from.claims[tx.actor] ?? 0) + 1
              if (from.claims[tx.actor]! >= from.claimLimit) break
            }
          }
        } else {
          const entries = tx.item ? [[tx.item, from.counts[tx.item] ?? 0] as const] : Object.entries(from.counts)
          for (const [itemId, avail] of entries) {
            if (avail <= 0) continue
            const reqCount = tx.count !== undefined ? Math.min(avail, tx.count) : avail
            const added = this.giveToActor(tx.actor, { item: itemId, count: reqCount }, record, env)
            if (added > 0) {
              this.adjustCounter(from, itemId, -added, tx.actor, record)
              tookAny = true
            }
          }
        }

        if (from.id.startsWith("drop:") && this.isStoreEmpty(from)) {
          this.stores.delete(from.id)
          this.removedStores.set(from.id, ++this.rev)
        }
        return { ok: tookAny, store: from.id, noise: 0, events }
      }

      case "deposit": {
        const to = this.stores.get(tx.to)!
        const plan = this.buildDepositPlan(tx.actor, to, tx.items)
        for (const [itemId, count] of Object.entries(plan)) {
          if (count <= 0) continue
          const added = this.addToStore(to, { item: itemId, count }, tx.actor, record)
          if (added > 0) {
            this.consumeFromActor(tx.actor, itemId, added, undefined, record)
          }
        }
        return { ok: true, store: to.id, noise: 0, events }
      }

      case "drop": {
        const dropId = `drop:${this.nextDropId++}`
        const droppedStacks: Stack[] = []
        if (tx.items) {
          for (const [itemId, count] of Object.entries(tx.items)) {
            if (count <= 0) continue
            this.consumeFromActor(tx.actor, itemId, count, undefined, record)
            droppedStacks.push(this.normalizeStack({ item: itemId, count }))
          }
        } else {
          const hotbar = this.stores.get(`${tx.actor}/hotbar`)!
          const slotIdx = tx.slot ?? hotbar.selected
          const stack = hotbar.slots[slotIdx]!
          const dropCount = (this.items.get(stack.item)?.stack ?? 1) > 1 ? 1 : stack.count
          const itemId = stack.item
          const droppedCharge = stack.charge
          stack.count -= dropCount
          if (stack.count <= 0) hotbar.slots[slotIdx] = null
          hotbar.rev = ++this.rev
          record({
            kind: "changed",
            actor: tx.actor,
            store: hotbar.id,
            item: itemId,
            delta: -dropCount,
            count: this.countInStore(hotbar, itemId),
          })
          droppedStacks.push({
            item: itemId,
            count: dropCount,
            ...(droppedCharge !== undefined ? { charge: droppedCharge } : {}),
          })
        }
        this.createStore({
          id: dropId,
          mode: "slots",
          scope: "shared",
          size: droppedStacks.length,
          at: tx.at,
          initial: droppedStacks,
        })
        record({ kind: "dropped", actor: tx.actor, dropId, at: { ...tx.at }, items: droppedStacks })
        return { ok: true, dropId, store: dropId, noise: 0, events }
      }

      case "run": {
        const rule = this.rules.get(tx.rule)!
        for (const [conItem, needed] of Object.entries(rule.consume ?? {})) {
          const fromActor = Math.min(needed, this.count(tx.actor, conItem))
          if (fromActor > 0) {
            this.consumeFromActor(tx.actor, conItem, fromActor, undefined, record)
          }
          const rem = needed - fromActor
          if (rem > 0 && tx.station) {
            const st = this.stores.get(tx.station)!
            this.removeFromStore(st, conItem, rem, tx.actor, record)
          }
        }

        const dest = rule.produceTo ?? "actor"
        for (const [prodItem, count] of Object.entries(rule.produce ?? {})) {
          if (dest === "actor") {
            this.giveToActor(tx.actor, { item: prodItem, count }, record, env)
          } else {
            const targetStoreId = dest === "station" ? tx.station! : dest === "target" ? tx.target! : dest
            const st = this.stores.get(targetStoreId)!
            const prev = this.countInStore(st, prodItem)
            this.addToStore(st, { item: prodItem, count }, tx.actor, record)
            const def = this.items.get(prodItem)
            if (prev === 0 && (def?.tag === "knowledge" || def?.tag === "upgrade")) {
              record({
                kind: "unlocked",
                actor: tx.actor,
                store: st.id,
                item: prodItem,
                label: def.label,
                source: "rule",
              })
            }
          }
        }
        return { ok: true, store: tx.station ?? tx.target, noise: check.noise, events }
      }

      case "grant": {
        const raw = tx.count ?? 1
        const mult =
          tx.scaleWithNight && (env.threat ?? 0) > 0
            ? 1 + Math.max(0, Math.min(1, env.threat!)) * (this.tuning.nightXpMultiplier - 1)
            : 1
        const amount = Math.max(1, Math.round(raw * mult))
        if (tx.store) {
          const st = this.stores.get(tx.store)!
          this.addToStore(st, { item: tx.item, count: amount }, tx.actor, record)
          this.checkDiscoveryAndSkills(tx.actor, st, tx.item, record)
        } else {
          this.giveToActor(tx.actor, { item: tx.item, count: amount }, record, env)
        }
        return { ok: true, item: tx.item, store: tx.store, noise: 0, events }
      }

      case "drain": {
        const st = this.stores.get(tx.store)!
        const removed = this.removeFromStore(st, tx.item, tx.count ?? 1, tx.actor, record)
        return { ok: removed > 0, item: tx.item, store: st.id, noise: 0, events }
      }

      case "bank": {
        const from = this.stores.get(tx.from)!
        const targets = Array.isArray(tx.to) ? tx.to : [tx.to]
        const itemsToBank = tx.item ? [tx.item] : Object.keys(from.counts)
        for (const itemId of itemsToBank) {
          const amount = this.countInStore(from, itemId)
          if (amount <= 0) continue
          this.removeFromStore(from, itemId, amount, tx.actor, record)
          // 100% shared credit: every target profile store receives the full banked amount.
          for (const targetId of targets) {
            const dst = this.stores.get(targetId)!
            this.addToStore(dst, { item: itemId, count: amount }, tx.actor, record)
          }
        }
        return { ok: true, store: from.id, item: tx.item, noise: 0, events }
      }
    }
  }

  // ── Snapshots & Deterministic Deltas ──────────────────────────────────────────────────────────────────────────

  snapshot(filter?: SnapshotFilter): LedgerSnapshot {
    const stores: SerializedStore[] = []
    const storeIds = [...this.stores.keys()].sort()
    for (const id of storeIds) {
      const st = this.stores.get(id)!
      if (!this.matchesFilter(st, filter)) continue
      stores.push(this.serializeStore(st))
    }
    const channels = [...this.channels.values()]
      .filter((c) => !filter?.owner || c.actor === filter.owner)
      .map((c) => ({ ...c, at: c.at ? { ...c.at } : undefined }))
    return {
      rev: this.rev,
      nextDropId: this.nextDropId,
      stores,
      channels,
    }
  }

  restore(snap: LedgerSnapshot): void {
    this.stores.clear()
    this.removedStores.clear()
    this.channels.clear()
    this.rev = snap.rev
    this.nextDropId = snap.nextDropId
    for (const s of snap.stores) {
      this.stores.set(s.id, this.deserializeStore(s))
    }
    for (const c of snap.channels) {
      this.channels.set(c.actor, { ...c, at: c.at ? { ...c.at } : undefined })
    }
  }

  /** Returns a compact delta of stores and channels changed since `sinceRev`, or `null` if nothing changed. */
  diff(sinceRev: number, filter?: SnapshotFilter): LedgerDelta | null {
    if (this.rev <= sinceRev) return null
    const upserted: SerializedStore[] = []
    const storeIds = [...this.stores.keys()].sort()
    for (const id of storeIds) {
      const st = this.stores.get(id)!
      if (st.rev <= sinceRev || !this.matchesFilter(st, filter)) continue
      upserted.push(this.serializeStore(st))
    }
    const removed: StoreId[] = []
    if (!filter?.owner) {
      for (const [id, rmRev] of this.removedStores) {
        if (rmRev > sinceRev) removed.push(id)
      }
      removed.sort()
    }
    const channels = [...this.channels.values()]
      .filter((c) => !filter?.owner || c.actor === filter.owner)
      .map((c) => ({ ...c, at: c.at ? { ...c.at } : undefined }))
    if (!upserted.length && !removed.length && !channels.length) return null
    return {
      fromRev: sinceRev,
      toRev: this.rev,
      nextDropId: this.nextDropId,
      upserted,
      removed,
      channels,
    }
  }

  applyDelta(delta: LedgerDelta): void {
    this.rev = Math.max(this.rev, delta.toRev)
    this.nextDropId = Math.max(this.nextDropId, delta.nextDropId)
    for (const id of delta.removed) {
      this.stores.delete(id)
    }
    for (const s of delta.upserted) {
      this.stores.set(s.id, this.deserializeStore(s))
    }
    this.channels.clear()
    for (const c of delta.channels) {
      this.channels.set(c.actor, { ...c, at: c.at ? { ...c.at } : undefined })
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────────────────────────────────────

  private emit(ev: LedgerEvent): void {
    for (const fn of this.listeners) fn(ev)
  }

  private matchesFilter(st: StoreState, filter?: SnapshotFilter): boolean {
    if (!filter) return true
    if (filter.owner !== undefined && st.owner !== filter.owner) return false
    if (filter.scope !== undefined) {
      const scopes = Array.isArray(filter.scope) ? filter.scope : [filter.scope]
      if (!scopes.includes(st.scope)) return false
    }
    return true
  }

  private serializeStore(st: StoreState): SerializedStore {
    return {
      id: st.id,
      mode: st.mode,
      scope: st.scope,
      owner: st.owner,
      size: st.size,
      accepts: [...st.accepts],
      caps: { ...st.caps },
      revealed: st.revealed,
      claimLimit: st.claimLimit,
      claims: { ...st.claims },
      at: st.at ? { ...st.at } : undefined,
      selected: st.selected,
      ...(st.mode === "slots" ? { slots: st.slots.map((s) => (s ? { ...s } : null)) } : { counts: { ...st.counts } }),
      rev: st.rev,
    }
  }

  private deserializeStore(s: SerializedStore): StoreState {
    return {
      id: s.id,
      mode: s.mode,
      scope: s.scope,
      owner: s.owner,
      size: s.size,
      accepts: [...s.accepts],
      caps: { ...s.caps },
      revealed: s.revealed,
      claimLimit: s.claimLimit,
      claims: { ...s.claims },
      at: s.at ? { ...s.at } : undefined,
      selected: s.selected,
      slots: s.slots ? s.slots.map((x) => (x ? { ...x } : null)) : [],
      counts: s.counts ? { ...s.counts } : {},
      rev: s.rev,
    }
  }

  private normalizeStack(s: Stack): Stack {
    const def = this.items.get(s.item)
    return {
      item: s.item,
      count: s.count,
      ...(def?.charge ? { charge: s.charge ?? def.charge.initial ?? def.charge.max } : s.charge !== undefined ? { charge: s.charge } : {}),
      ...(s.active !== undefined ? { active: s.active } : {}),
    }
  }

  private countInStore(st: StoreState, item: ItemId): number {
    if (st.mode === "counters") return st.counts[item] ?? 0
    let sum = 0
    for (const s of st.slots) {
      if (s?.item === item) sum += s.count
    }
    return sum
  }

  private isStoreEmpty(st: StoreState): boolean {
    if (st.mode === "counters") return Object.values(st.counts).every((v) => v <= 0)
    return st.slots.every((s) => s === null)
  }

  private snapshotStoreStacks(st: StoreState): Stack[] {
    if (st.mode === "slots") {
      return st.slots.filter((s): s is Stack => s !== null).map((s) => ({ ...s }))
    }
    return Object.entries(st.counts)
      .filter(([, count]) => count > 0)
      .map(([item, count]) => ({ item, count }))
  }

  private extractableStacks(from: StoreState, slot?: number, item?: ItemId, count?: number): Stack[] {
    if (from.mode === "slots") {
      if (slot !== undefined) {
        const s = from.slots[slot]
        return s && (!item || s.item === item) ? [{ ...s, count: count ? Math.min(s.count, count) : s.count }] : []
      }
      return from.slots
        .filter((s): s is Stack => s !== null && (!item || s.item === item))
        .map((s) => ({ ...s, count: count ? Math.min(s.count, count) : s.count }))
    }
    if (item) {
      const c = from.counts[item] ?? 0
      return c > 0 ? [{ item, count: count ? Math.min(c, count) : c }] : []
    }
    return Object.entries(from.counts)
      .filter(([, c]) => c > 0)
      .map(([k, c]) => ({ item: k, count: count ? Math.min(c, count) : c }))
  }

  private canFitInStore(st: StoreState, item: ItemId, count: number): number {
    const def = this.items.get(item)
    if (!def) return 0
    if (st.accepts.length > 0 && !st.accepts.includes(def.tag)) return 0
    if (st.mode === "counters") {
      const cap = this.capFor(st, item)
      const cur = st.counts[item] ?? 0
      return Math.max(0, Math.min(count, cap - cur))
    }
    const maxStack = def.stack ?? 1
    const itemSlots = def.slots ?? 1
    let capacity = 0
    if (maxStack > 1) {
      for (const s of st.slots) {
        if (s?.item === item && s.count < maxStack) {
          capacity += maxStack - s.count
        }
      }
    }
    let freeUnits = st.size - this.usedSlots(st)
    let emptySlots = st.slots.filter((s) => s === null).length
    while (freeUnits >= itemSlots && emptySlots > 0 && capacity < count) {
      capacity += maxStack
      freeUnits -= itemSlots
      emptySlots--
    }
    return Math.min(count, capacity)
  }

  private canFitActor(actor: ActorId, item: ItemId, count: number): boolean {
    const def = this.items.get(item)
    if (def?.grants) {
      return Object.entries(def.grants).every(([gItem, gCount]) => this.canFitActor(actor, gItem, gCount))
    }
    let rem = count
    for (const tpl of this.actorTemplates) {
      const st = this.stores.get(`${actor}/${tpl.suffix}`)
      if (!st) continue
      rem -= this.canFitInStore(st, item, rem)
      if (rem <= 0) return true
    }
    return false
  }

  private canFitProduced(actor: ActorId, rule: Rule, station?: StoreId, target?: StoreId): TxCheck {
    const dest = rule.produceTo ?? "actor"
    for (const [prodItem, count] of Object.entries(rule.produce ?? {})) {
      if (dest === "actor") {
        if (!this.canFitActor(actor, prodItem, count)) {
          return { ok: false, reason: "full", rule: rule.id, item: prodItem }
        }
      } else {
        const storeId = dest === "station" ? station : dest === "target" ? target : dest
        const st = storeId ? this.stores.get(storeId) : undefined
        if (!st) return { ok: false, reason: "unknown_store", rule: rule.id, store: storeId }
        if (this.canFitInStore(st, prodItem, count) < count) {
          return { ok: false, reason: "full", rule: rule.id, store: st.id, item: prodItem }
        }
      }
    }
    return { ok: true, duration: 0, noise: 0, label: rule.label }
  }

  private addToStore(st: StoreState, stack: Stack, actor: ActorId | undefined, record: (ev: LedgerEvent) => void): number {
    const def = this.items.get(stack.item)
    if (!def) return 0
    if (st.mode === "counters") {
      const fit = this.canFitInStore(st, stack.item, stack.count)
      if (fit <= 0) return 0
      this.adjustCounter(st, stack.item, fit, actor, record)
      return fit
    }

    const maxStack = def.stack ?? 1
    const itemSlots = def.slots ?? 1
    let rem = stack.count
    let added = 0

    if (maxStack > 1) {
      for (const s of st.slots) {
        if (rem <= 0) break
        if (s?.item === stack.item && s.count < maxStack) {
          const take = Math.min(rem, maxStack - s.count)
          s.count += take
          rem -= take
          added += take
        }
      }
    }

    while (rem > 0 && st.size - this.usedSlots(st) >= itemSlots) {
      const emptyIdx = st.slots.findIndex((s) => s === null)
      if (emptyIdx < 0) break
      const take = Math.min(rem, maxStack)
      st.slots[emptyIdx] = this.normalizeStack({ ...stack, count: take })
      rem -= take
      added += take
    }

    if (added > 0) {
      st.rev = ++this.rev
      record({
        kind: "changed",
        actor,
        store: st.id,
        item: stack.item,
        delta: added,
        count: this.countInStore(st, stack.item),
      })
    }
    return added
  }

  private giveToActor(actor: ActorId, stack: Stack, record: (ev: LedgerEvent) => void, _env: LedgerEnv): number {
    const def = this.items.get(stack.item)
    if (!def) return 0
    let rem = stack.count
    let totalAdded = 0
    for (const tpl of this.actorTemplates) {
      if (rem <= 0) break
      const st = this.stores.get(`${actor}/${tpl.suffix}`)
      if (!st) continue
      if (st.accepts.length > 0 && !st.accepts.includes(def.tag)) continue
      const added = this.addToStore(st, { ...stack, count: rem }, actor, record)
      if (added > 0) {
        rem -= added
        totalAdded += added
        this.checkDiscoveryAndSkills(actor, st, stack.item, record)
      }
    }
    return totalAdded
  }

  private checkDiscoveryAndSkills(
    actor: ActorId,
    st: StoreState,
    item: ItemId,
    record: (ev: LedgerEvent) => void,
  ): void {
    const def = this.items.get(item)
    if (def?.discovers?.length) {
      const knownStore = this.stores.get(this.discoverStoreId)
      if (knownStore) {
        for (const token of def.discovers) {
          if (this.countInStore(knownStore, token) === 0) {
            this.adjustCounter(knownStore, token, 1, actor, record)
            const tokenDef = this.items.get(token)
            record({
              kind: "unlocked",
              actor,
              store: knownStore.id,
              item: token,
              label: tokenDef?.label ?? token,
              source: "discover",
            })
          }
        }
      }
    }

    const track = this.skillsByXp.get(item)
    if (track) {
      const xpTotal = this.countInStore(st, item)
      for (const r of track.ranks) {
        if (xpTotal >= r.xp && this.countInStore(st, r.grants) === 0) {
          this.adjustCounter(st, r.grants, 1, actor, record)
          const rankDef = this.items.get(r.grants)
          record({
            kind: "unlocked",
            actor,
            store: st.id,
            item: r.grants,
            label: rankDef?.label ?? r.grants,
            source: "skill",
          })
        }
      }
    }
  }

  private removeFromStore(
    st: StoreState,
    item: ItemId,
    count: number,
    actor: ActorId | undefined,
    record: (ev: LedgerEvent) => void,
  ): number {
    if (count <= 0) return 0
    if (st.mode === "counters") {
      const cur = st.counts[item] ?? 0
      const removed = Math.min(cur, count)
      if (removed > 0) this.adjustCounter(st, item, -removed, actor, record)
      return removed
    }
    let rem = count
    let removed = 0
    for (let i = st.slots.length - 1; i >= 0 && rem > 0; i--) {
      const s = st.slots[i]
      if (!s || s.item !== item) continue
      const take = Math.min(rem, s.count)
      s.count -= take
      rem -= take
      removed += take
      if (s.count <= 0) st.slots[i] = null
    }
    if (removed > 0) {
      st.rev = ++this.rev
      record({
        kind: "changed",
        actor,
        store: st.id,
        item,
        delta: -removed,
        count: this.countInStore(st, item),
      })
    }
    return removed
  }

  private consumeFromActor(
    actor: ActorId,
    item: ItemId,
    count: number,
    explicitStore: StoreId | undefined,
    record: (ev: LedgerEvent) => void,
  ): number {
    if (explicitStore) {
      const st = this.stores.get(explicitStore)
      return st ? this.removeFromStore(st, item, count, actor, record) : 0
    }
    let rem = count
    for (const tpl of this.actorTemplates) {
      if (rem <= 0) break
      const st = this.stores.get(`${actor}/${tpl.suffix}`)
      if (!st) continue
      rem -= this.removeFromStore(st, item, rem, actor, record)
    }
    return count - rem
  }

  private adjustCounter(
    st: StoreState,
    item: ItemId,
    delta: number,
    actor: ActorId | undefined,
    record: (ev: LedgerEvent) => void,
  ): void {
    const next = Math.max(0, (st.counts[item] ?? 0) + delta)
    if (next === 0) delete st.counts[item]
    else st.counts[item] = next
    st.rev = ++this.rev
    record({ kind: "changed", actor, store: st.id, item, delta, count: next })
  }

  private findRechargeableWeapon(
    actor: ActorId,
    weaponStoreId?: StoreId,
  ): { store: StoreState; slotIndex: number; stack: Stack; def: ItemDef } | null {
    const st = this.stores.get(weaponStoreId ?? `${actor}/hotbar`)
    if (!st || st.mode !== "slots") return null
    const indices = [st.selected, ...st.slots.map((_, i) => i).filter((i) => i !== st.selected)]
    for (const idx of indices) {
      const s = st.slots[idx]
      if (!s) continue
      const def = this.items.get(s.item)
      if (def?.charge?.ammo) return { store: st, slotIndex: idx, stack: s, def }
    }
    return null
  }

  private buildDepositPlan(
    actor: ActorId,
    to: StoreState,
    explicitItems?: Readonly<Record<ItemId, number>>,
  ): Record<ItemId, number> {
    const plan: Record<ItemId, number> = {}
    if (explicitItems) {
      for (const [itemId, req] of Object.entries(explicitItems)) {
        const avail = this.count(actor, itemId)
        const fit = this.canFitInStore(to, itemId, Math.min(req, avail))
        if (fit > 0) plan[itemId] = fit
      }
      return plan
    }
    for (const tpl of this.actorTemplates) {
      if (!tpl.depositable) continue
      const st = this.stores.get(`${actor}/${tpl.suffix}`)
      if (!st) continue
      for (const s of this.snapshotStoreStacks(st)) {
        const def = this.items.get(s.item)
        if (!def) continue
        if (to.accepts.length > 0 && !to.accepts.includes(def.tag)) continue
        const fit = this.canFitInStore(to, s.item, (plan[s.item] ?? 0) + s.count)
        if (fit > 0) plan[s.item] = fit
      }
    }
    return plan
  }
}
