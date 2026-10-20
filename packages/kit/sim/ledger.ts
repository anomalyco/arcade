/**
 * Deterministic inventory ledger: everything a game counts (held tools, belt supplies, container contents, ground
 * drops, station stock, learned recipes) is a `Stack` in a constrained `Store`, and every change is an atomic `Tx`.
 *
 *   const ledger = new Ledger(catalog)
 *   ledger.addActor("p1")                                     // creates p1/belt, p1/hotbar, … from the catalog
 *   ledger.start({ kind: "reveal", actor: "p1", store: "loot:4", duration: 1.2 }, env, at)
 *   ledger.step(dt, (actor) => env)                           // completes channels, re-validating them first
 *   ledger.apply({ kind: "take", actor: "p1", from: "loot:4" }) // routes items into p1's stores by tag
 *   ledger.diff(sinceRev, { visibleTo: "p1" })                // what changed, for a network snapshot
 *
 * Invariants: counts are positive integers (empty entries are removed); slotted stores never exceed `size` (multi-slot
 * items count `slots` each); counter stores never exceed their cap; a transaction validates everything before it
 * mutates anything; a channel re-validates when it completes, so two actors racing for one thing cannot both get it.
 * The ledger has no randomness, clock or game nouns; games supply the catalog and run their own effects on `ran`.
 */

export type ItemId = string
export type StoreId = string
export type RuleId = string
export type ActorId = string
export type StatKey = string

export type StatMod = { add?: number; mul?: number }

export type ItemDef = {
  id: ItemId
  label: string
  shortLabel?: string
  /** Category matched against store `accepts` filters, e.g. "tool", "ammo", "resource", "part", "knowledge". */
  tag: string
  /** Max count per slot in a slotted store (default 1). */
  stack?: number
  /** Slots taken in a slotted store (default 1; 2 for a heavy item). */
  slots?: number
  /** Cells taken in a grid store, long side across (default 1×1). A placed stack can be turned a quarter. */
  grid?: { w: number; h: number }
  /** Default cap in a counter store when the store sets none. */
  maxCount?: number
  /** Preferred slot index in stores with `preferSlots`, used when that slot is free. */
  slot?: number
  /** Internal charge, e.g. a magazine `{ max: 8, ammo: "ammo" }` reloaded from the owner's `ammo` count. */
  charge?: { max: number; initial?: number; ammo?: ItemId }
  /** Stat modifiers while held or known; with `activeOnly`, only while selected in a slotted store. */
  mods?: Readonly<Record<StatKey, number | StatMod>>
  activeOnly?: boolean
  /** Tokens added to the catalog's discover store the first time anyone acquires this item. */
  discovers?: readonly ItemId[]
  /** Part of the actor (bare hands): never dropped, deposited or left behind by `removeActor`. */
  bound?: boolean
  /** An actor carries at most one (a second pistol stays where it was instead of muddling the ammo count). */
  unique?: boolean
}

export type Stack = { item: ItemId; count: number; charge?: number }

/** A grid store's size in cells. */
export type GridSize = { cols: number; rows: number }

/** Where a stack sits in a grid store: its top-left cell, and `r` when turned a quarter (its footprint's w and h swap). */
export type Place = { x: number; y: number; r?: 1 }

export type StoreMode = "slots" | "counters"
export type StoreScope = "personal" | "shared"

export type StoreSpec = {
  id: StoreId
  mode: StoreMode
  scope?: StoreScope
  owner?: ActorId
  /** Slot capacity for `"slots"` stores. */
  size?: number
  /**
   * A `"slots"` store laid out as cells (an attaché case): every stack takes its item's `grid` footprint at a place,
   * fits only where its cells are free, and the store's size is `cols × rows` (one stack per cell at most).
   */
  grid?: GridSize
  /** Item tags this store takes when items are routed into it (empty: anything). */
  accepts?: readonly string[]
  /** Per-item caps for `"counters"` stores. */
  caps?: Readonly<Record<ItemId, number>>
  /** Whether contents can be taken before a `reveal` (default true). */
  revealed?: boolean
  /** Items go to their `ItemDef.slot` when it is free (a hotbar with fixed places for tools). */
  preferSlots?: boolean
  /** World position for spatial stores (containers, stations, ground drops). */
  at?: { x: number; y: number }
  initial?: readonly (Stack | null)[] | Readonly<Record<ItemId, number>>
}

export type ActorStoreTemplate = Omit<StoreSpec, "id" | "owner"> & {
  /** Store id is `${actor}/${suffix}`. Templates are searched in order when routing items to an actor. */
  suffix: string
  /** `deposit` may move items out of this store into a station. */
  depositable?: boolean
}

export type Rule = {
  id: RuleId
  label: string
  /** Channel seconds; 0 or omitted commits at once. */
  duration?: number
  /** Stat that scales the duration, folded with `stat(actor, durationStat, duration)`. */
  durationStat?: StatKey
  /** Noise radius in metres reported when the rule starts. */
  noise?: number
  /** Minimum `env.light` needed. */
  lightMin?: number
  /** Station store id or prefix ("bench" matches "bench:ash") the rule must run at. */
  station?: string
  /** Items that must be in the station store, not consumed (installed parts). */
  installed?: Readonly<Record<ItemId, number>>
  /** Items or tokens the actor must have (own stores, shared knowledge, or the station), not consumed. */
  requires?: Readonly<Record<ItemId, number>>
  /** Items or tokens that must not be present yet (stops learning a recipe twice). */
  forbids?: Readonly<Record<ItemId, number>>
  /** Consumed from the station first, then the actor. */
  consume?: Readonly<Record<ItemId, number>>
  produce?: Readonly<Record<ItemId, number>>
  /** Where produced items go: the actor (routed by tag, default), the station, or a store id. */
  produceTo?: "actor" | "station" | StoreId
}

export type LedgerCatalog = {
  items: readonly ItemDef[]
  actorStores: readonly ActorStoreTemplate[]
  stores?: readonly StoreSpec[]
  rules?: readonly Rule[]
  /** Shared store that receives `discovers` tokens and is consulted by `has` and `stat` (default "team/known"). */
  knowledgeStore?: StoreId
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
  preferSlots?: boolean
  at?: { x: number; y: number }
  selected: number
  slots: (Stack | null)[]
  /** Grid stores: the cells, and each slot's place (meaningful only while its slot holds a stack). */
  grid?: GridSize
  places?: (Place | null)[]
  counts: Record<ItemId, number>
  rev: number
}

export type Channel = {
  actor: ActorId
  tx: Tx
  label: string
  elapsed: number
  duration: number
  noise: number
  at?: { x: number; y: number }
}

export type LedgerEnv = {
  /** Illumination where the actor stands (0..1+, default 1). */
  light?: number
  /** Game-side veto checked with every validation, e.g. "the window already holds 3 planks". */
  check?: (tx: Tx) => string | null
}

export type Tx =
  | { kind: "select"; actor: ActorId; slot?: number; delta?: number }
  /** Moves the charge item's ammo from the actor into the first chargeable stack in the hotbar (selected first). */
  | { kind: "reload"; actor: ActorId; item?: ItemId }
  | { kind: "useCharge"; actor: ActorId; item?: ItemId; amount?: number }
  | { kind: "setCharge"; actor: ActorId; item: ItemId; charge: number }
  | { kind: "reveal"; actor: ActorId; store: StoreId; duration?: number; noise?: number; label?: string }
  | { kind: "take"; actor: ActorId; from: StoreId; slot?: number; item?: ItemId; count?: number }
  /** Moves supplies from the actor's depositable stores into a station, or one of the stack in `from` (e.g. the held item). */
  | { kind: "deposit"; actor: ActorId; to: StoreId; items?: Readonly<Record<ItemId, number>>; from?: { store: StoreId; slot: number }; count?: number }
  /** Drops `items` from anywhere on the actor, or one of the stack in `store` (default hotbar) `slot` (default selected). */
  | { kind: "drop"; actor: ActorId; at: { x: number; y: number }; items?: Readonly<Record<ItemId, number>>; store?: StoreId; slot?: number; count?: number }
  /** Swaps two slots between two of the actor's slotted stores (e.g. a pack item into the hand). */
  | { kind: "swap"; actor: ActorId; a: { store: StoreId; slot: number }; b: { store: StoreId; slot: number } }
  /** `ref` is passed through to the `ran` event for the game's own effect; `label` names the channel. */
  | { kind: "run"; actor: ActorId; rule: RuleId; station?: StoreId; ref?: string; label?: string }
  /**
   * Puts a stack (or `count` of it) at a place in one of the actor's grid stores: moved or turned within it, or brought
   * in from their own stores or a revealed shared one. Onto a stack of the same item it tops that stack up instead.
   */
  | { kind: "place"; actor: ActorId; from: { store: StoreId; slot: number }; to: StoreId; x: number; y: number; r?: boolean; count?: number }
  | { kind: "grant"; actor: ActorId; item: ItemId; count?: number; store?: StoreId }
  | { kind: "drain"; store: StoreId; item: ItemId; count?: number; actor?: ActorId }

export type TxFailureReason =
  | "unknown_item"
  | "unknown_store"
  | "unknown_rule"
  | "unrevealed"
  | "already_revealed"
  | "already_known"
  | "low_light"
  | "wrong_station"
  | "missing_requirement"
  | "missing_item"
  | "full"
  | "empty"
  | "blocked"

export type TxCheck =
  | { ok: true; duration: number; noise: number; label: string }
  | { ok: false; reason: TxFailureReason; item?: ItemId; store?: StoreId; rule?: RuleId; detail?: string }

export type LedgerEvent =
  | { kind: "changed"; actor?: ActorId; store: StoreId; item: ItemId; delta: number; count: number }
  | { kind: "charged"; actor: ActorId; store: StoreId; slot: number; item: ItemId; delta: number; charge: number; capacity: number }
  | { kind: "selected"; actor: ActorId; store: StoreId; slot: number; item: ItemId | null }
  | { kind: "revealed"; actor: ActorId; store: StoreId; items: Stack[] }
  | { kind: "dropped"; actor: ActorId; dropId: StoreId; at: { x: number; y: number }; items: Stack[] }
  | { kind: "unlocked"; actor: ActorId; store: StoreId; item: ItemId; label: string; source: "discover" | "rule" }
  | { kind: "channel"; actor: ActorId; state: "started" | "completed" | "cancelled"; label: string; tx: Tx; noise: number }
  | { kind: "ran"; actor: ActorId; rule: RuleId; station?: StoreId; ref?: string }
  | { kind: "rejected"; actor?: ActorId; reason: TxFailureReason; item?: ItemId; store?: StoreId; rule?: RuleId; detail?: string }

export type TxResult = {
  ok: boolean
  reason?: TxFailureReason
  item?: ItemId
  store?: StoreId
  detail?: string
  dropId?: StoreId
  /** Items a `take` could not fit and left behind. */
  left?: number
  duration: number
  noise: number
  events: LedgerEvent[]
}

export type SnapshotFilter = {
  scope?: StoreScope
  owner?: ActorId
  /** Shared stores plus the stores this actor owns. */
  visibleTo?: ActorId
}

export type SerializedStore = Omit<StoreState, "slots" | "counts"> & {
  slots?: (Stack | null)[]
  counts?: Record<ItemId, number>
}

export type LedgerSnapshot = {
  rev: number
  nextDropId: number
  stores: SerializedStore[]
  channels?: Channel[]
  removedStores?: [StoreId, number][]
}

export type LedgerDelta = { toRev: number; nextDropId: number; upserted: SerializedStore[]; removed: StoreId[] }

type Record_ = (ev: LedgerEvent) => void

export class Ledger {
  readonly items = new Map<ItemId, ItemDef>()
  readonly rules = new Map<RuleId, Rule>()
  readonly stores = new Map<StoreId, StoreState>()
  readonly channels = new Map<ActorId, Channel>()
  readonly actorTemplates: readonly ActorStoreTemplate[]
  readonly knowledgeStore: StoreId
  rev = 0
  private nextDropId = 1
  private listeners = new Set<(ev: LedgerEvent) => void>()
  private removedStores = new Map<StoreId, number>()

  constructor(catalog: LedgerCatalog) {
    for (const item of catalog.items) this.items.set(item.id, item)
    this.setRules(catalog.rules ?? [])
    this.actorTemplates = catalog.actorStores
    this.knowledgeStore = catalog.knowledgeStore ?? "team/known"
    for (const spec of catalog.stores ?? []) this.createStore(spec)
    if (!this.stores.has(this.knowledgeStore)) {
      this.createStore({ id: this.knowledgeStore, mode: "counters", scope: "shared", accepts: ["knowledge"] })
    }
  }

  /** Replaces the rule table (e.g. after Lab tuning changed a cost). In-flight channels keep their tx. */
  setRules(rules: readonly Rule[]): void {
    this.rules.clear()
    for (const rule of rules) this.rules.set(rule.id, rule)
  }

  /** Receives every committed or rejected event, in order. */
  on(listener: (event: LedgerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  addActor(actor: ActorId): void {
    for (const tpl of this.actorTemplates) {
      const id = `${actor}/${tpl.suffix}`
      if (!this.stores.has(id)) this.createStore({ ...tpl, id, owner: actor, scope: tpl.scope ?? "personal" })
    }
  }

  /** Deletes an actor's stores. With `dropAt`, everything they carried is left there as one ground drop. */
  removeActor(actor: ActorId, dropAt?: { x: number; y: number }): StoreId | null {
    this.channels.delete(actor)
    const carried: Stack[] = []
    for (const tpl of this.actorTemplates) {
      const st = this.stores.get(`${actor}/${tpl.suffix}`)
      if (!st) continue
      carried.push(...this.stacksOf(st).filter((s) => !this.isBound(s.item)))
      this.deleteStore(st.id)
    }
    if (!dropAt || !carried.length) return null
    const dropId = `drop:${this.nextDropId++}`
    this.createStore({ id: dropId, mode: "slots", scope: "shared", size: carried.length, at: dropAt, initial: carried })
    return dropId
  }

  createStore(spec: StoreSpec): StoreState {
    const grid = spec.mode === "slots" && spec.grid ? { cols: Math.max(1, spec.grid.cols | 0), rows: Math.max(1, spec.grid.rows | 0) } : undefined
    const size = grid ? grid.cols * grid.rows : (spec.size ?? (Array.isArray(spec.initial) ? spec.initial.length : 0))
    const slots: (Stack | null)[] =
      spec.mode === "slots"
        ? Array.from({ length: size }, (_, i) => {
            const init = !grid && Array.isArray(spec.initial) ? (spec.initial as (Stack | null)[])[i] : null
            return init && init.count > 0 ? this.normalizeStack(init) : null
          })
        : []
    const counts: Record<ItemId, number> = {}
    if (spec.mode === "counters" && spec.initial && !Array.isArray(spec.initial)) {
      for (const [k, v] of Object.entries(spec.initial as Record<ItemId, number>)) if (v > 0) counts[k] = Math.floor(v)
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
      ...(spec.preferSlots ? { preferSlots: true } : {}),
      at: spec.at ? { ...spec.at } : undefined,
      selected: 0,
      slots,
      counts,
      ...(grid ? { grid, places: slots.map(() => null) } : {}),
      rev: ++this.rev,
    }
    this.stores.set(st.id, st)
    this.removedStores.delete(st.id)
    if (grid && Array.isArray(spec.initial)) for (const s of spec.initial as (Stack | null)[]) if (s && s.count > 0) this.addToStore(st, s, undefined, () => {})
    return st
  }

  /**
   * Grows a grid store to `grid` (never smaller: nothing placed is moved or lost). Every stack keeps its place; the new
   * cells are free. Returns whether the size changed.
   */
  growGrid(id: StoreId, grid: GridSize): boolean {
    const st = this.stores.get(id)
    if (!st?.grid || !st.places) return false
    const cols = Math.max(st.grid.cols, grid.cols | 0)
    const rows = Math.max(st.grid.rows, grid.rows | 0)
    if (cols === st.grid.cols && rows === st.grid.rows) return false
    st.grid = { cols, rows }
    const size = cols * rows
    while (st.slots.length < size) st.slots.push(null)
    while (st.places.length < size) st.places.push(null)
    st.size = size
    st.rev = ++this.rev
    return true
  }

  /** A stack's cells across and down, turned or not. */
  footprint(item: ItemId, turned = false): { w: number; h: number } {
    const g = this.items.get(item)?.grid
    const w = Math.max(1, g?.w ?? 1)
    const h = Math.max(1, g?.h ?? 1)
    return turned ? { w: h, h: w } : { w, h }
  }

  /** Which slot fills each cell of a grid store (-1 free), row-major; `skip` leaves one slot out. */
  occupancy(st: StoreState, skip = -1): number[] {
    const g = st.grid
    if (!g || !st.places) return []
    const occ = new Array<number>(g.cols * g.rows).fill(-1)
    st.slots.forEach((s, i) => {
      const p = st.places![i]
      if (!s || !p || i === skip) return
      const fp = this.footprint(s.item, p.r === 1)
      for (let y = p.y; y < p.y + fp.h; y++) for (let x = p.x; x < p.x + fp.w; x++) if (x < g.cols && y < g.rows) occ[y * g.cols + x] = i
    })
    return occ
  }

  /** Whether a `w`×`h` footprint is inside the grid and on free cells at (`x`, `y`). */
  private freeAt(occ: readonly number[], g: GridSize, x: number, y: number, w: number, h: number): boolean {
    if (x < 0 || y < 0 || x + w > g.cols || y + h > g.rows) return false
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (occ[yy * g.cols + xx] !== -1) return false
    return true
  }

  /** The first free place for `item`, top-left first, as it lies and then turned (`prefer` is tried before both). */
  findPlace(st: StoreState, item: ItemId, occ: readonly number[] = this.occupancy(st), prefer?: Place | null): Place | null {
    const g = st.grid
    if (!g) return null
    if (prefer) {
      for (const turned of prefer.r === 1 ? [true, false] : [false, true]) {
        const fp = this.footprint(item, turned)
        if (this.freeAt(occ, g, prefer.x, prefer.y, fp.w, fp.h)) return { x: prefer.x, y: prefer.y, ...(turned ? { r: 1 as const } : {}) }
      }
    }
    for (const turned of [false, true]) {
      const fp = this.footprint(item, turned)
      if (turned && fp.w === fp.h) break
      for (let y = 0; y + fp.h <= g.rows; y++) for (let x = 0; x + fp.w <= g.cols; x++) if (this.freeAt(occ, g, x, y, fp.w, fp.h)) return { x, y, ...(turned ? { r: 1 as const } : {}) }
    }
    return null
  }

  private markPlace(occ: number[], g: GridSize, p: Place, item: ItemId, slot: number): void {
    const fp = this.footprint(item, p.r === 1)
    for (let y = p.y; y < p.y + fp.h; y++) for (let x = p.x; x < p.x + fp.w; x++) occ[y * g.cols + x] = slot
  }

  deleteStore(id: StoreId): void {
    if (!this.stores.delete(id)) return
    this.removedStores.set(id, ++this.rev)
  }

  store(id: StoreId): StoreState | undefined {
    return this.stores.get(id)
  }

  /** Count of `item` in one store, or across all of an actor's stores when given an actor id. */
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

  /** Whether the actor (with shared knowledge and an optional station) holds at least `min` of `item`. */
  has(actor: ActorId, item: ItemId, min = 1, station?: StoreId): boolean {
    let total = this.count(actor, item)
    const known = this.stores.get(this.knowledgeStore)
    if (known) total += this.countInStore(known, item)
    if (station) {
      const st = this.stores.get(station)
      if (st) total += this.countInStore(st, item)
    }
    return total >= min
  }

  /** The selected stack in `${actor}/${suffix}`. */
  activeItem(actor: ActorId, suffix = "hotbar"): Stack | null {
    const st = this.stores.get(`${actor}/${suffix}`)
    if (!st || st.mode !== "slots") return null
    return st.slots[st.selected] ?? null
  }

  label(item: ItemId, short = false): string {
    const def = this.items.get(item)
    return (short ? def?.shortLabel : undefined) ?? def?.label ?? item
  }

  /** `(base + Σadd) · Πmul` over mods on the actor's items, shared knowledge, and any extra stores. */
  stat(actor: ActorId, key: StatKey, base: number, extraStores: readonly StoreId[] = []): number {
    let add = 0
    let mul = 1
    const fold = (itemId: ItemId, count: number, selected: boolean) => {
      if (count <= 0) return
      const def = this.items.get(itemId)
      const mod = def?.mods?.[key]
      if (mod === undefined || (def!.activeOnly && !selected)) return
      if (typeof mod === "number") add += mod
      else {
        if (mod.add !== undefined) add += mod.add
        if (mod.mul !== undefined) mul *= mod.mul
      }
    }
    const inspect = (st: StoreState | undefined) => {
      if (!st) return
      if (st.mode === "slots") st.slots.forEach((s, i) => s && fold(s.item, s.count, i === st.selected))
      else for (const [itemId, count] of Object.entries(st.counts)) fold(itemId, count, false)
    }
    for (const tpl of this.actorTemplates) inspect(this.stores.get(`${actor}/${tpl.suffix}`))
    inspect(this.stores.get(this.knowledgeStore))
    for (const id of extraStores) inspect(this.stores.get(id))
    return Number(((base + add) * mul).toFixed(6))
  }

  /** Cap for `item` in a counter store, including `cap:${item}` mods on its owner. */
  capFor(st: StoreState, item: ItemId): number {
    const raw = st.caps[item] ?? this.items.get(item)?.maxCount ?? Infinity
    if (!Number.isFinite(raw) || !st.owner) return raw
    return Math.max(0, Math.round(this.stat(st.owner, `cap:${item}`, raw)))
  }

  usedSlots(st: StoreState): number {
    let used = 0
    for (const s of st.slots) if (s) used += this.items.get(s.item)?.slots ?? 1
    return used
  }

  /** How many of `item` the actor could receive right now. */
  room(actor: ActorId, item: ItemId, count: number): number {
    let rem = count
    for (const tpl of this.actorTemplates) {
      const st = this.stores.get(`${actor}/${tpl.suffix}`)
      if (st) rem -= this.fitInStore(st, item, rem)
      if (rem <= 0) break
    }
    return count - Math.max(0, rem)
  }

  roomIn(store: StoreId, item: ItemId, count: number): number {
    const st = this.stores.get(store)
    return st ? this.fitInStore(st, item, count) : 0
  }

  channel(actor: ActorId): Channel | undefined {
    return this.channels.get(actor)
  }

  // ── Validation ──────────────────────────────────────────────────────────────────────────────────────────────

  canApply(tx: Tx, env: LedgerEnv = {}): TxCheck {
    const check = this.validate(tx, env)
    if (!check.ok) return check
    const veto = env.check?.(tx)
    if (veto) return { ok: false, reason: "blocked", detail: veto, rule: tx.kind === "run" ? tx.rule : undefined }
    return check
  }

  private validate(tx: Tx, env: LedgerEnv): TxCheck {
    switch (tx.kind) {
      case "select": {
        const st = this.stores.get(`${tx.actor}/hotbar`)
        if (!st || st.mode !== "slots") return { ok: false, reason: "unknown_store" }
        return { ok: true, duration: 0, noise: 0, label: "Select" }
      }
      case "reload": {
        const found = this.findChargeable(tx.actor, tx.item)
        if (!found) return { ok: false, reason: "empty", item: tx.item }
        const ammo = found.def.charge!.ammo!
        const cap = this.chargeCap(tx.actor, found.def)
        if ((found.stack.charge ?? 0) >= cap) return { ok: false, reason: "full", item: found.stack.item }
        if (this.count(tx.actor, ammo) <= 0) return { ok: false, reason: "missing_item", item: ammo }
        return { ok: true, duration: 0, noise: 0, label: `Reload ${this.label(found.stack.item)}` }
      }
      case "useCharge": {
        const st = this.stores.get(`${tx.actor}/hotbar`)
        if (!st) return { ok: false, reason: "unknown_store" }
        const stack = tx.item ? st.slots.find((s) => s?.item === tx.item) : st.slots[st.selected]
        if (!stack || (stack.charge ?? 0) < (tx.amount ?? 1)) return { ok: false, reason: "empty", item: tx.item ?? stack?.item }
        return { ok: true, duration: 0, noise: 0, label: stack.item }
      }
      case "setCharge": {
        const st = this.stores.get(`${tx.actor}/hotbar`)
        if (!st?.slots.some((s) => s?.item === tx.item)) return { ok: false, reason: "missing_item", item: tx.item }
        return { ok: true, duration: 0, noise: 0, label: tx.item }
      }
      case "reveal": {
        const st = this.stores.get(tx.store)
        if (!st) return { ok: false, reason: "unknown_store", store: tx.store }
        if (st.revealed) return { ok: false, reason: "already_revealed", store: tx.store }
        return { ok: true, duration: tx.duration ?? 0, noise: tx.noise ?? 0, label: tx.label ?? "Search" }
      }
      case "take": {
        const from = this.stores.get(tx.from)
        if (!from) return { ok: false, reason: "unknown_store", store: tx.from }
        if (!from.revealed) return { ok: false, reason: "unrevealed", store: tx.from }
        const candidates = this.extractable(from, tx.slot, tx.item, tx.count)
        if (!candidates.length) return { ok: false, reason: "empty", store: tx.from }
        if (!candidates.some((s) => this.room(tx.actor, s.item, 1) > 0)) {
          return { ok: false, reason: "full", store: tx.from, item: candidates[0]!.item }
        }
        return { ok: true, duration: 0, noise: 0, label: "Take" }
      }
      case "deposit": {
        const to = this.stores.get(tx.to)
        if (!to) return { ok: false, reason: "unknown_store", store: tx.to }
        if (tx.from) {
          const st = this.stores.get(tx.from.store)
          const s = st?.owner === tx.actor ? st.slots[tx.from.slot] : undefined
          if (!s || this.isBound(s.item)) return { ok: false, reason: "empty", store: tx.from.store }
          if (this.fitInStore(to, s.item, 1) < 1) return { ok: false, reason: "full", item: s.item, store: tx.to }
          return { ok: true, duration: 0, noise: 0, label: "Store" }
        }
        if (!Object.keys(this.depositPlan(tx.actor, to, tx.items)).length) return { ok: false, reason: "empty", store: tx.to }
        return { ok: true, duration: 0, noise: 0, label: "Deposit" }
      }
      case "drop": {
        if (tx.items) {
          let any = false
          for (const [item, count] of Object.entries(tx.items)) {
            if (count <= 0) continue
            any = true
            if (this.isBound(item) || this.count(tx.actor, item) < count) return { ok: false, reason: "missing_item", item }
          }
          return any ? { ok: true, duration: 0, noise: 0, label: "Drop" } : { ok: false, reason: "empty" }
        }
        const st = this.stores.get(tx.store ?? `${tx.actor}/hotbar`)
        if (!st || st.owner !== tx.actor) return { ok: false, reason: "unknown_store", store: tx.store }
        const held = st.slots[tx.slot ?? st.selected]
        if (!held || this.isBound(held.item)) return { ok: false, reason: "empty", store: st.id }
        return { ok: true, duration: 0, noise: 0, label: "Drop" }
      }
      case "swap": {
        const a = this.stores.get(tx.a.store)
        const b = this.stores.get(tx.b.store)
        if (!a || !b || a.owner !== tx.actor || b.owner !== tx.actor || a.mode !== "slots" || b.mode !== "slots") {
          return { ok: false, reason: "unknown_store" }
        }
        const sa = a.slots[tx.a.slot]
        const sb = b.slots[tx.b.slot]
        if (sa === undefined || sb === undefined) return { ok: false, reason: "unknown_store" }
        if (!sa && !sb) return { ok: false, reason: "empty" }
        if (a === b && a.grid) return { ok: true, duration: 0, noise: 0, label: "Swap" }
        if (!this.canPlace(b, tx.b.slot, sa, sb) || !this.canPlace(a, tx.a.slot, sb, sa)) {
          return { ok: false, reason: "full", item: (sa ?? sb)!.item }
        }
        return { ok: true, duration: 0, noise: 0, label: "Swap" }
      }
      case "place": {
        const plan = this.planPlace(tx)
        return plan.ok ? { ok: true, duration: 0, noise: 0, label: "Place" } : plan
      }
      case "run":
        return this.validateRule(tx, env)
      case "grant": {
        if (!this.items.has(tx.item)) return { ok: false, reason: "unknown_item", item: tx.item }
        const count = tx.count ?? 1
        const fit = tx.store ? this.roomIn(tx.store, tx.item, count) : this.room(tx.actor, tx.item, count)
        if (fit < count) return { ok: false, reason: "full", item: tx.item, store: tx.store }
        return { ok: true, duration: 0, noise: 0, label: "Grant" }
      }
      case "drain": {
        const st = this.stores.get(tx.store)
        if (!st) return { ok: false, reason: "unknown_store", store: tx.store }
        if (this.countInStore(st, tx.item) <= 0) return { ok: false, reason: "empty", store: tx.store, item: tx.item }
        return { ok: true, duration: 0, noise: 0, label: "Drain" }
      }
    }
  }

  private validateRule(tx: Extract<Tx, { kind: "run" }>, env: LedgerEnv): TxCheck {
    const rule = this.rules.get(tx.rule)
    if (!rule) return { ok: false, reason: "unknown_rule", rule: tx.rule }
    const fail = (reason: TxFailureReason, extra: { item?: ItemId; store?: StoreId } = {}): TxCheck => ({ ok: false, reason, rule: rule.id, ...extra })
    let station: StoreState | undefined
    if (rule.station) {
      if (!tx.station || !(tx.station === rule.station || tx.station.startsWith(`${rule.station}:`))) return fail("wrong_station", { store: tx.station })
      station = this.stores.get(tx.station)
      if (!station) return fail("unknown_store", { store: tx.station })
    } else if (tx.station) {
      // A rule that runs anywhere may still draw on a station's stock when run at one.
      station = this.stores.get(tx.station)
    }
    for (const [item, min] of Object.entries(rule.forbids ?? {})) if (this.has(tx.actor, item, min, tx.station)) return fail("already_known", { item })
    for (const [item, min] of Object.entries(rule.installed ?? {})) {
      if (!station || this.countInStore(station, item) < min) return fail("missing_requirement", { item, store: tx.station })
    }
    for (const [item, min] of Object.entries(rule.requires ?? {})) if (!this.has(tx.actor, item, min, tx.station)) return fail("missing_requirement", { item })
    for (const [item, needed] of Object.entries(rule.consume ?? {})) {
      const avail = this.count(tx.actor, item) + (station ? this.countInStore(station, item) : 0)
      if (avail < needed) return fail("missing_item", { item })
    }
    if (rule.lightMin !== undefined && (env.light ?? 1) + 1e-6 < rule.lightMin) return fail("low_light")
    const dest = rule.produceTo ?? "actor"
    for (const [item, count] of Object.entries(rule.produce ?? {})) {
      // Inputs leave before outputs arrive, so a consumed stack's slot counts as free.
      const fit = dest === "actor" ? this.roomAfterConsume(tx.actor, rule, item, count) : this.roomIn(dest === "station" ? tx.station ?? "" : dest, item, count)
      if (fit < count) return fail("full", { item })
    }
    const base = rule.duration ?? 0
    const duration = rule.durationStat ? this.stat(tx.actor, rule.durationStat, base) : base
    return { ok: true, duration, noise: rule.noise ?? 0, label: tx.label ?? rule.label }
  }

  // ── Commit ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Starts a timed channel when the transaction has a duration, or commits it at once. Replaces any channel. */
  start(tx: Tx, env: LedgerEnv = {}, at?: { x: number; y: number }): TxResult {
    const check = this.canApply(tx, env)
    const actor = "actor" in tx ? tx.actor : undefined
    if (!check.ok) return this.reject(actor, check)
    if (!actor || check.duration <= 0) return this.apply(tx, env)
    const events: LedgerEvent[] = []
    if (this.channels.has(actor)) events.push(this.cancel(actor)!)
    const ch: Channel = { actor, tx, label: check.label, elapsed: 0, duration: check.duration, noise: check.noise, at: at ? { ...at } : undefined }
    this.channels.set(actor, ch)
    const ev: LedgerEvent = { kind: "channel", actor, state: "started", label: ch.label, tx, noise: ch.noise }
    this.emit(ev)
    events.push(ev)
    return { ok: true, duration: ch.duration, noise: ch.noise, events }
  }

  cancel(actor: ActorId): LedgerEvent | null {
    const ch = this.channels.get(actor)
    if (!ch) return null
    this.channels.delete(actor)
    const ev: LedgerEvent = { kind: "channel", actor, state: "cancelled", label: ch.label, tx: ch.tx, noise: 0 }
    this.emit(ev)
    return ev
  }

  /** Advances channels and commits the finished ones, re-validating each in its actor's current environment. */
  step(dt: number, envOf: (actor: ActorId) => LedgerEnv = () => ({})): LedgerEvent[] {
    if (dt <= 0 || !this.channels.size) return []
    const out: LedgerEvent[] = []
    for (const [actor, ch] of [...this.channels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      ch.elapsed += dt
      if (ch.elapsed + 1e-6 < ch.duration) continue
      this.channels.delete(actor)
      const res = this.apply(ch.tx, envOf(actor))
      if (res.ok) {
        const done: LedgerEvent = { kind: "channel", actor, state: "completed", label: ch.label, tx: ch.tx, noise: ch.noise }
        this.emit(done)
        out.push(done)
      }
      out.push(...res.events)
    }
    return out
  }

  /** Validates and commits `tx` at once, all or nothing. */
  apply(tx: Tx, env: LedgerEnv = {}): TxResult {
    const check = this.canApply(tx, env)
    const actor = "actor" in tx ? tx.actor : undefined
    if (!check.ok) return this.reject(actor, check)
    const events: LedgerEvent[] = []
    const record: Record_ = (ev) => {
      events.push(ev)
      this.emit(ev)
    }
    const done = (extra: Partial<TxResult> = {}): TxResult => ({ ok: true, duration: 0, noise: check.noise, events, ...extra })

    switch (tx.kind) {
      case "select": {
        const st = this.stores.get(`${tx.actor}/hotbar`)!
        if (tx.slot !== undefined && Number.isInteger(tx.slot) && tx.slot >= 0 && tx.slot < st.size) st.selected = tx.slot
        else if (tx.delta) {
          const step = Number.isInteger(tx.delta) && Math.abs(tx.delta) <= st.size ? tx.delta : Math.sign(tx.delta)
          st.selected = (((st.selected + step) % st.size) + st.size) % st.size
        }
        st.rev = ++this.rev
        const item = st.slots[st.selected]?.item ?? null
        record({ kind: "selected", actor: tx.actor, store: st.id, slot: st.selected, item })
        return done({ store: st.id, item: item ?? undefined })
      }
      case "reload": {
        const { store, slotIndex, stack, def } = this.findChargeable(tx.actor, tx.item)!
        const ammo = def.charge!.ammo!
        const cap = this.chargeCap(tx.actor, def)
        const loaded = Math.min(cap - (stack.charge ?? 0), this.count(tx.actor, ammo))
        this.consumeFromActor(tx.actor, ammo, loaded, record)
        stack.charge = (stack.charge ?? 0) + loaded
        store.rev = ++this.rev
        record({ kind: "charged", actor: tx.actor, store: store.id, slot: slotIndex, item: stack.item, delta: loaded, charge: stack.charge, capacity: cap })
        return done({ store: store.id, item: stack.item })
      }
      case "useCharge":
      case "setCharge": {
        const st = this.stores.get(`${tx.actor}/hotbar`)!
        const slotIndex = tx.item ? st.slots.findIndex((s) => s?.item === tx.item) : st.selected
        const stack = st.slots[slotIndex]!
        const def = this.items.get(stack.item)
        const before = stack.charge ?? 0
        const cap = def?.charge ? this.chargeCap(tx.actor, def) : 1
        stack.charge = tx.kind === "useCharge" ? Math.max(0, before - (tx.amount ?? 1)) : Math.max(0, Math.min(cap, tx.charge))
        st.rev = ++this.rev
        record({ kind: "charged", actor: tx.actor, store: st.id, slot: slotIndex, item: stack.item, delta: stack.charge - before, charge: stack.charge, capacity: cap })
        return done({ store: st.id, item: stack.item })
      }
      case "reveal": {
        const st = this.stores.get(tx.store)!
        st.revealed = true
        st.rev = ++this.rev
        record({ kind: "revealed", actor: tx.actor, store: st.id, items: this.stacksOf(st) })
        return done({ store: st.id })
      }
      case "take": {
        const from = this.stores.get(tx.from)!
        let left = 0
        for (const s of this.extractable(from, tx.slot, tx.item, tx.count)) {
          const added = this.giveToActor(tx.actor, { ...s }, record)
          if (added > 0) this.removeFromStore(from, s.item, added, tx.actor, record, s.charge)
          left += s.count - added
        }
        if (from.id.startsWith("drop:") && this.isEmpty(from)) this.deleteStore(from.id)
        if (left > 0) {
          const ev: LedgerEvent = { kind: "rejected", actor: tx.actor, reason: "full", store: from.id }
          record(ev)
        }
        return done({ store: from.id, left })
      }
      case "deposit": {
        const to = this.stores.get(tx.to)!
        if (tx.from) {
          const st = this.stores.get(tx.from.store)!
          const s = { ...st.slots[tx.from.slot]! }
          const want = tx.count && tx.count > 0 ? Math.min(tx.count, s.count) : 1
          const n = this.fitInStore(to, s.item, want)
          this.removeFromSlot(st, tx.from.slot, n, tx.actor, record)
          this.addToStore(to, { ...s, count: n }, tx.actor, record)
          return done({ store: to.id, item: s.item })
        }
        for (const [item, count] of Object.entries(this.depositPlan(tx.actor, to, tx.items))) {
          const moved = this.takeFromActor(tx.actor, item, count, record, true)
          for (const s of moved) this.addToStore(to, s, tx.actor, record)
        }
        return done({ store: to.id })
      }
      case "drop": {
        const stacks: Stack[] = []
        if (tx.items) {
          for (const [item, count] of Object.entries(tx.items)) if (count > 0) stacks.push(...this.takeFromActor(tx.actor, item, count, record, false))
        } else {
          const st = this.stores.get(tx.store ?? `${tx.actor}/hotbar`)!
          const idx = tx.slot ?? st.selected
          const stack = st.slots[idx]!
          const count = tx.count && tx.count > 0 ? Math.min(tx.count, stack.count) : (this.items.get(stack.item)?.stack ?? 1) > 1 ? 1 : stack.count
          stack.count -= count
          if (stack.count <= 0) st.slots[idx] = null
          st.rev = ++this.rev
          record({ kind: "changed", actor: tx.actor, store: st.id, item: stack.item, delta: -count, count: this.countInStore(st, stack.item) })
          stacks.push({ item: stack.item, count, ...(stack.charge !== undefined ? { charge: stack.charge } : {}) })
        }
        const dropId = `drop:${this.nextDropId++}`
        this.createStore({ id: dropId, mode: "slots", scope: "shared", size: stacks.length, at: tx.at, initial: stacks })
        record({ kind: "dropped", actor: tx.actor, dropId, at: { ...tx.at }, items: stacks.map((s) => ({ ...s })) })
        return done({ dropId, store: dropId })
      }
      case "swap": {
        const a = this.stores.get(tx.a.store)!
        const b = this.stores.get(tx.b.store)!
        const sa = a.slots[tx.a.slot] ?? null
        const sb = b.slots[tx.b.slot] ?? null
        if (a === b && a.places) {
          const pa = a.places[tx.a.slot] ?? null
          a.places[tx.a.slot] = a.places[tx.b.slot] ?? null
          a.places[tx.b.slot] = pa
        } else {
          const pa = a.places && sb ? this.swapPlace(a, tx.a.slot, sb, sa) : null
          const pb = b.places && sa ? this.swapPlace(b, tx.b.slot, sa, sb) : null
          if (a.places) a.places[tx.a.slot] = pa
          if (b.places) b.places[tx.b.slot] = pb
        }
        a.slots[tx.a.slot] = sb
        b.slots[tx.b.slot] = sa
        a.rev = ++this.rev
        b.rev = ++this.rev
        const sel = this.stores.get(`${tx.actor}/hotbar`)
        record({ kind: "selected", actor: tx.actor, store: `${tx.actor}/hotbar`, slot: sel?.selected ?? 0, item: sel?.slots[sel.selected]?.item ?? null })
        return done()
      }
      case "place": {
        const plan = this.planPlace(tx) as { merge?: number; place?: Place; moved: number }
        const from = this.stores.get(tx.from.store)!
        const to = this.stores.get(tx.to)!
        const s = from.slots[tx.from.slot]!
        const moved = plan.moved
        if (plan.place && from === to && moved === s.count) {
          to.places![tx.from.slot] = plan.place
          to.rev = ++this.rev
          return done({ store: to.id, item: s.item })
        }
        const carried = { ...s, count: moved }
        this.removeFromSlot(from, tx.from.slot, moved, tx.actor, record)
        if (plan.merge !== undefined) to.slots[plan.merge]!.count += moved
        else {
          const idx = to.slots.indexOf(null)
          to.slots[idx] = this.normalizeStack(carried)
          to.places![idx] = plan.place!
        }
        to.rev = ++this.rev
        record({ kind: "changed", actor: tx.actor, store: to.id, item: s.item, delta: moved, count: this.countInStore(to, s.item) })
        if (from.owner !== tx.actor) {
          this.discover(tx.actor, s.item, record)
          if (from.id.startsWith("drop:") && this.isEmpty(from)) this.deleteStore(from.id)
        }
        return done({ store: to.id, item: s.item })
      }
      case "run": {
        const rule = this.rules.get(tx.rule)!
        const station = tx.station ? this.stores.get(tx.station) : undefined
        for (const [item, needed] of Object.entries(rule.consume ?? {})) {
          const fromStation = station ? this.removeFromStore(station, item, needed, tx.actor, record) : 0
          if (needed > fromStation) this.consumeFromActor(tx.actor, item, needed - fromStation, record)
        }
        const dest = rule.produceTo ?? "actor"
        for (const [item, count] of Object.entries(rule.produce ?? {})) {
          if (dest === "actor") {
            this.giveToActor(tx.actor, { item, count }, record)
            continue
          }
          const st = this.stores.get(dest === "station" ? tx.station! : dest)!
          const before = this.countInStore(st, item)
          this.addToStore(st, { item, count }, tx.actor, record)
          if (before === 0 && this.items.get(item)?.tag === "knowledge") {
            record({ kind: "unlocked", actor: tx.actor, store: st.id, item, label: this.label(item), source: "rule" })
          }
        }
        record({ kind: "ran", actor: tx.actor, rule: rule.id, station: tx.station, ref: tx.ref })
        return done({ store: tx.station })
      }
      case "grant": {
        const stack = { item: tx.item, count: tx.count ?? 1 }
        if (tx.store) this.addToStore(this.stores.get(tx.store)!, stack, tx.actor, record)
        else this.giveToActor(tx.actor, stack, record)
        return done({ item: tx.item, store: tx.store })
      }
      case "drain": {
        const st = this.stores.get(tx.store)!
        this.removeFromStore(st, tx.item, tx.count ?? 1, tx.actor, record)
        return done({ item: tx.item, store: st.id })
      }
    }
  }

  // ── Snapshots and deltas ────────────────────────────────────────────────────────────────────────────────────

  snapshot(filter?: SnapshotFilter): LedgerSnapshot {
    const stores = [...this.stores.keys()]
      .sort()
      .map((id) => this.stores.get(id)!)
      .filter((st) => this.matches(st, filter))
      .map((st) => this.serialize(st))
    const channels =
      !filter && this.channels.size > 0
        ? [...this.channels.keys()]
            .sort()
            .map((actor) => {
              const ch = this.channels.get(actor)!
              return {
                ...ch,
                tx: { ...ch.tx },
                ...(ch.at ? { at: { ...ch.at } } : {}),
              }
            })
        : undefined
    const removedStores =
      !filter && this.removedStores.size > 0
        ? [...this.removedStores.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        : undefined
    return {
      rev: this.rev,
      nextDropId: this.nextDropId,
      stores,
      ...(channels ? { channels } : {}),
      ...(removedStores ? { removedStores } : {}),
    }
  }

  /** Replaces all stores (and active channels if present in the snapshot) with a snapshot's. */
  restore(snap: LedgerSnapshot): void {
    this.stores.clear()
    this.removedStores.clear()
    this.channels.clear()
    this.rev = snap.rev
    this.nextDropId = snap.nextDropId
    for (const s of snap.stores) this.stores.set(s.id, this.deserialize(s))
    if (snap.channels) {
      for (const ch of snap.channels) {
        this.channels.set(ch.actor, {
          ...ch,
          tx: { ...ch.tx },
          ...(ch.at ? { at: { ...ch.at } } : {}),
        })
      }
    }
    if (snap.removedStores) {
      for (const [id, at] of snap.removedStores) {
        this.removedStores.set(id, at)
      }
    }
  }

  /** Stores changed or removed since `sinceRev` (0 for everything), or null when nothing changed. */
  diff(sinceRev: number, filter?: SnapshotFilter): LedgerDelta | null {
    if (this.rev <= sinceRev) return null
    const upserted: SerializedStore[] = []
    for (const id of [...this.stores.keys()].sort()) {
      const st = this.stores.get(id)!
      if (st.rev > sinceRev && this.matches(st, filter)) upserted.push(this.serialize(st))
    }
    const removed: StoreId[] = []
    for (const [id, at] of this.removedStores) if (at > sinceRev) removed.push(id)
    removed.sort()
    if (!upserted.length && !removed.length) return null
    return { toRev: this.rev, nextDropId: this.nextDropId, upserted, removed }
  }

  applyDelta(delta: LedgerDelta): void {
    this.rev = Math.max(this.rev, delta.toRev)
    this.nextDropId = Math.max(this.nextDropId, delta.nextDropId)
    for (const id of delta.removed) this.stores.delete(id)
    for (const s of delta.upserted) this.stores.set(s.id, this.deserialize(s))
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────────────────────────

  private reject(actor: ActorId | undefined, check: Extract<TxCheck, { ok: false }>): TxResult {
    const ev: LedgerEvent = { kind: "rejected", actor, reason: check.reason, item: check.item, store: check.store, rule: check.rule, detail: check.detail }
    this.emit(ev)
    return { ok: false, reason: check.reason, item: check.item, store: check.store, detail: check.detail, duration: 0, noise: 0, events: [ev] }
  }

  private emit(ev: LedgerEvent): void {
    for (const fn of this.listeners) fn(ev)
  }

  private matches(st: StoreState, filter?: SnapshotFilter): boolean {
    if (!filter) return true
    if (filter.visibleTo !== undefined && st.scope !== "shared" && st.owner !== filter.visibleTo) return false
    if (filter.owner !== undefined && st.owner !== filter.owner) return false
    if (filter.scope !== undefined && st.scope !== filter.scope) return false
    return true
  }

  private serialize(st: StoreState): SerializedStore {
    const { slots, counts, ...rest } = st
    return {
      ...rest,
      accepts: [...st.accepts],
      caps: { ...st.caps },
      at: st.at ? { ...st.at } : undefined,
      ...(st.mode === "slots" ? { slots: slots.map((s) => (s ? { ...s } : null)) } : { counts: { ...counts } }),
      ...(st.grid && st.places ? { grid: { ...st.grid }, places: st.places.map((p, i) => (p && slots[i] ? { ...p } : null)) } : {}),
    }
  }

  private deserialize(s: SerializedStore): StoreState {
    return {
      ...s,
      accepts: [...s.accepts],
      caps: { ...s.caps },
      at: s.at ? { ...s.at } : undefined,
      slots: s.slots ? s.slots.map((x) => (x ? { ...x } : null)) : [],
      counts: s.counts ? { ...s.counts } : {},
      ...(s.grid ? { grid: { ...s.grid }, places: (s.places ?? []).map((p) => (p ? { ...p } : null)) } : {}),
    }
  }

  private normalizeStack(s: Stack): Stack {
    const def = this.items.get(s.item)
    const charge = s.charge ?? (def?.charge ? (def.charge.initial ?? def.charge.max) : undefined)
    return { item: s.item, count: s.count, ...(charge !== undefined ? { charge } : {}) }
  }

  private countInStore(st: StoreState, item: ItemId): number {
    if (st.mode === "counters") return st.counts[item] ?? 0
    let sum = 0
    for (const s of st.slots) if (s?.item === item) sum += s.count
    return sum
  }

  private isEmpty(st: StoreState): boolean {
    return st.mode === "counters" ? Object.keys(st.counts).length === 0 : st.slots.every((s) => s === null)
  }

  /** Bare hands and the like: they stay with the actor (`ItemDef.bound`). */
  isBound(item: ItemId): boolean {
    return Boolean(this.items.get(item)?.bound)
  }

  private stacksOf(st: StoreState): Stack[] {
    if (st.mode === "slots") return st.slots.filter((s): s is Stack => s !== null).map((s) => ({ ...s }))
    return Object.entries(st.counts).map(([item, count]) => ({ item, count }))
  }

  private extractable(from: StoreState, slot?: number, item?: ItemId, count?: number): Stack[] {
    const cut = (s: Stack): Stack => ({ ...s, count: count ? Math.min(s.count, count) : s.count })
    if (from.mode === "slots") {
      if (slot !== undefined) {
        const s = from.slots[slot]
        return s && (!item || s.item === item) ? [cut(s)] : []
      }
      return from.slots.filter((s): s is Stack => s !== null && (!item || s.item === item)).map(cut)
    }
    if (item) return (from.counts[item] ?? 0) > 0 ? [cut({ item, count: from.counts[item]! })] : []
    return Object.entries(from.counts).map(([k, c]) => cut({ item: k, count: c }))
  }

  private accepts(st: StoreState, def: ItemDef): boolean {
    return st.accepts.length === 0 || st.accepts.includes(def.tag)
  }

  private fitInStore(st: StoreState, item: ItemId, count: number): number {
    const def = this.items.get(item)
    if (!def || count <= 0 || !this.accepts(st, def)) return 0
    if (def.unique && st.owner !== undefined && this.count(st.owner, item) > 0) return 0
    if (st.mode === "counters") return Math.max(0, Math.min(count, this.capFor(st, item) - (st.counts[item] ?? 0)))
    const maxStack = def.stack ?? 1
    const itemSlots = def.slots ?? 1
    let capacity = 0
    if (maxStack > 1) for (const s of st.slots) if (s?.item === item && s.count < maxStack) capacity += maxStack - s.count
    if (st.grid) {
      const occ = this.occupancy(st)
      let empty = st.slots.filter((s) => s === null).length
      while (capacity < count && empty > 0) {
        const p = this.findPlace(st, item, occ)
        if (!p) break
        this.markPlace(occ, st.grid, p, item, st.slots.length)
        capacity += maxStack
        empty--
      }
      return Math.min(count, capacity)
    }
    let freeUnits = st.size - this.usedSlots(st)
    let empty = st.slots.filter((s) => s === null).length
    while (freeUnits >= itemSlots && empty > 0 && capacity < count) {
      capacity += maxStack
      freeUnits -= itemSlots
      empty--
    }
    return Math.min(count, capacity)
  }

  /** Room for a rule's output once its inputs are gone: a consumed single stack frees its slot. */
  private roomAfterConsume(actor: ActorId, rule: Rule, item: ItemId, count: number): number {
    const direct = this.room(actor, item, count)
    if (direct >= count) return direct
    for (const [consumed, n] of Object.entries(rule.consume ?? {})) {
      if (this.items.get(consumed)?.tag === this.items.get(item)?.tag && this.count(actor, consumed) <= n) return count
    }
    return direct
  }

  private canPlace(st: StoreState, slot: number, incoming: Stack | null, outgoing: Stack | null): boolean {
    if (!incoming) return true
    const def = this.items.get(incoming.item)
    if (!def || !this.accepts(st, def)) return false
    if (st.grid) return slot < st.size && this.swapPlace(st, slot, incoming, outgoing) !== null
    const freed = outgoing ? (this.items.get(outgoing.item)?.slots ?? 1) : 0
    return this.usedSlots(st) - freed + (def.slots ?? 1) <= st.size && slot < st.size
  }

  /** Where `incoming` goes in a grid store when it takes `slot`'s place: where the outgoing stack lay, else anywhere. */
  private swapPlace(st: StoreState, slot: number, incoming: Stack, outgoing: Stack | null): Place | null {
    const prefer = outgoing ? (st.places?.[slot] ?? null) : null
    return this.findPlace(st, incoming.item, this.occupancy(st, slot), prefer)
  }

  private addToStore(st: StoreState, stack: Stack, actor: ActorId | undefined, record: Record_): number {
    const def = this.items.get(stack.item)
    if (!def) return 0
    const fit = this.fitInStore(st, stack.item, stack.count)
    if (fit <= 0) return 0
    if (st.mode === "counters") {
      this.adjustCounter(st, stack.item, fit, actor, record)
      return fit
    }
    const maxStack = def.stack ?? 1
    let rem = fit
    if (maxStack > 1) {
      for (const s of st.slots) {
        if (rem <= 0) break
        if (s?.item !== stack.item || s.count >= maxStack) continue
        const take = Math.min(rem, maxStack - s.count)
        s.count += take
        rem -= take
      }
    }
    const occ = st.grid ? this.occupancy(st) : null
    while (rem > 0) {
      const preferred = st.preferSlots && def.slot !== undefined && def.slot < st.size && st.slots[def.slot] === null ? def.slot : -1
      const idx = preferred >= 0 ? preferred : st.slots.findIndex((s) => s === null)
      if (idx < 0) break
      let place: Place | null = null
      if (occ && st.grid) {
        place = this.findPlace(st, stack.item, occ)
        if (!place) break
        this.markPlace(occ, st.grid, place, stack.item, idx)
      }
      const take = Math.min(rem, maxStack)
      st.slots[idx] = this.normalizeStack({ ...stack, count: take })
      if (st.places) st.places[idx] = place
      rem -= take
    }
    st.rev = ++this.rev
    record({ kind: "changed", actor, store: st.id, item: stack.item, delta: fit - rem, count: this.countInStore(st, stack.item) })
    return fit - rem
  }

  private giveToActor(actor: ActorId, stack: Stack, record: Record_): number {
    let rem = stack.count
    for (const tpl of this.actorTemplates) {
      if (rem <= 0) break
      const st = this.stores.get(`${actor}/${tpl.suffix}`)
      if (!st) continue
      const added = this.addToStore(st, { ...stack, count: rem }, actor, record)
      if (added > 0) rem -= added
    }
    const given = stack.count - rem
    if (given > 0) this.discover(actor, stack.item, record)
    return given
  }

  private discover(actor: ActorId, item: ItemId, record: Record_): void {
    const tokens = this.items.get(item)?.discovers
    const known = this.stores.get(this.knowledgeStore)
    if (!tokens?.length || !known) return
    for (const token of tokens) {
      if (this.countInStore(known, token) > 0) continue
      this.adjustCounter(known, token, 1, actor, record)
      record({ kind: "unlocked", actor, store: known.id, item: token, label: this.label(token), source: "discover" })
    }
  }

  /** Removes `count` from one slot (emptying it when nothing is left). */
  private removeFromSlot(st: StoreState, slot: number, count: number, actor: ActorId | undefined, record: Record_): number {
    const s = st.slots[slot]
    if (!s || count <= 0) return 0
    const n = Math.min(count, s.count)
    s.count -= n
    if (s.count <= 0) st.slots[slot] = null
    st.rev = ++this.rev
    record({ kind: "changed", actor, store: st.id, item: s.item, delta: -n, count: this.countInStore(st, s.item) })
    return n
  }

  /** What a `place` would do: top up a stack at the place, or set the stack (or part of it) down on free cells. */
  private planPlace(tx: Extract<Tx, { kind: "place" }>): TxCheck & { merge?: number; place?: Place; moved?: number } {
    const from = this.stores.get(tx.from.store)
    const to = this.stores.get(tx.to)
    if (!from || !to || from.mode !== "slots" || !to.grid || to.owner !== tx.actor) return { ok: false, reason: "unknown_store" }
    if (from.owner !== tx.actor && (from.scope !== "shared" || !from.revealed || from.at === undefined)) return { ok: false, reason: "unknown_store", store: from.id }
    const s = from.slots[tx.from.slot]
    if (!s || this.isBound(s.item)) return { ok: false, reason: "empty", store: from.id }
    const def = this.items.get(s.item)
    if (!def || !this.accepts(to, def)) return { ok: false, reason: "full", item: s.item, store: to.id }
    if (def.unique && from.owner !== tx.actor && this.count(tx.actor, s.item) > 0) return { ok: false, reason: "full", item: s.item, store: to.id }
    const moving = tx.count && tx.count > 0 ? Math.min(tx.count, s.count) : s.count
    const x = tx.x | 0
    const y = tx.y | 0
    const g = to.grid
    const self = from === to ? tx.from.slot : -1
    const occ = this.occupancy(to, moving === s.count ? self : -1)
    const under = x >= 0 && y >= 0 && x < g.cols && y < g.rows ? occ[y * g.cols + x]! : -1
    const max = def.stack ?? 1
    const top = under >= 0 ? to.slots[under] : null
    if (top && under !== tx.from.slot && top.item === s.item && max > 1) {
      const room = max - top.count
      if (room <= 0) return { ok: false, reason: "full", item: s.item, store: to.id }
      return { ok: true, duration: 0, noise: 0, label: "Place", merge: under, moved: Math.min(room, moving) }
    }
    const fp = this.footprint(s.item, Boolean(tx.r))
    if (!this.freeAt(occ, g, x, y, fp.w, fp.h)) return { ok: false, reason: "full", item: s.item, store: to.id }
    if (!(moving === s.count && from === to) && !to.slots.includes(null)) return { ok: false, reason: "full", item: s.item, store: to.id }
    return { ok: true, duration: 0, noise: 0, label: "Place", place: { x, y, ...(tx.r ? { r: 1 as const } : {}) }, moved: moving }
  }

  /** Removes up to `count`, newest slots first; `charge` prefers the stack holding that charge. */
  private removeFromStore(st: StoreState, item: ItemId, count: number, actor: ActorId | undefined, record: Record_, charge?: number): number {
    if (count <= 0) return 0
    if (st.mode === "counters") {
      const removed = Math.min(st.counts[item] ?? 0, count)
      if (removed > 0) this.adjustCounter(st, item, -removed, actor, record)
      return removed
    }
    const order = st.slots.map((_, i) => st.slots.length - 1 - i)
    if (charge !== undefined) order.sort((a, b) => Number(st.slots[b]?.charge === charge) - Number(st.slots[a]?.charge === charge))
    let rem = count
    for (const i of order) {
      const s = st.slots[i]
      if (rem <= 0) break
      if (!s || s.item !== item) continue
      const take = Math.min(rem, s.count)
      s.count -= take
      rem -= take
      if (s.count <= 0) st.slots[i] = null
    }
    const removed = count - rem
    if (removed > 0) {
      st.rev = ++this.rev
      record({ kind: "changed", actor, store: st.id, item, delta: -removed, count: this.countInStore(st, item) })
    }
    return removed
  }

  private consumeFromActor(actor: ActorId, item: ItemId, count: number, record: Record_): number {
    let rem = count
    for (const tpl of this.actorTemplates) {
      if (rem <= 0) break
      const st = this.stores.get(`${actor}/${tpl.suffix}`)
      if (st) rem -= this.removeFromStore(st, item, rem, actor, record)
    }
    return count - rem
  }

  /** Removes items from the actor and returns them as stacks, keeping charges (a dropped pistol keeps its rounds). */
  private takeFromActor(actor: ActorId, item: ItemId, count: number, record: Record_, depositableOnly: boolean): Stack[] {
    const out: Stack[] = []
    let rem = count
    for (const tpl of this.actorTemplates) {
      if (rem <= 0) break
      if (depositableOnly && !tpl.depositable) continue
      const st = this.stores.get(`${actor}/${tpl.suffix}`)
      if (!st) continue
      if (st.mode === "counters") {
        const n = this.removeFromStore(st, item, rem, actor, record)
        if (n > 0) out.push({ item, count: n })
        rem -= n
        continue
      }
      for (let i = st.slots.length - 1; i >= 0 && rem > 0; i--) {
        const s = st.slots[i]
        if (s?.item !== item) continue
        const n = Math.min(rem, s.count)
        out.push({ item, count: n, ...(s.charge !== undefined ? { charge: s.charge } : {}) })
        rem -= this.removeFromStore(st, item, n, actor, record, s.charge)
      }
    }
    return out
  }

  private adjustCounter(st: StoreState, item: ItemId, delta: number, actor: ActorId | undefined, record: Record_): void {
    const next = Math.max(0, (st.counts[item] ?? 0) + delta)
    if (next === 0) delete st.counts[item]
    else st.counts[item] = next
    st.rev = ++this.rev
    record({ kind: "changed", actor, store: st.id, item, delta, count: next })
  }

  private chargeCap(actor: ActorId, def: ItemDef): number {
    return Math.round(this.stat(actor, `capacity:${def.id}`, def.charge?.max ?? 1))
  }

  private findChargeable(actor: ActorId, item?: ItemId): { store: StoreState; slotIndex: number; stack: Stack; def: ItemDef } | null {
    const st = this.stores.get(`${actor}/hotbar`)
    if (!st || st.mode !== "slots") return null
    const order = [st.selected, ...st.slots.map((_, i) => i).filter((i) => i !== st.selected)]
    for (const i of order) {
      const s = st.slots[i]
      const def = s && this.items.get(s.item)
      if (s && def?.charge?.ammo && (!item || s.item === item)) return { store: st, slotIndex: i, stack: s, def }
    }
    return null
  }

  private depositPlan(actor: ActorId, to: StoreState, explicit?: Readonly<Record<ItemId, number>>): Record<ItemId, number> {
    const plan: Record<ItemId, number> = {}
    const candidates: [ItemId, number][] = explicit
      ? Object.entries(explicit).map(([item, n]) => [item, Math.min(n, this.depositable(actor, item))])
      : this.actorTemplates
          .filter((t) => t.depositable)
          .flatMap((t) => {
            const st = this.stores.get(`${actor}/${t.suffix}`)
            return st ? this.stacksOf(st).map((s) => [s.item, s.count] as [ItemId, number]) : []
          })
    for (const [item, n] of candidates) {
      if (n <= 0) continue
      const fit = this.fitInStore(to, item, (plan[item] ?? 0) + n)
      if (fit > 0) plan[item] = fit
    }
    return plan
  }

  private depositable(actor: ActorId, item: ItemId): number {
    let n = 0
    for (const t of this.actorTemplates) {
      const st = t.depositable ? this.stores.get(`${actor}/${t.suffix}`) : undefined
      if (st) n += this.countInStore(st, item)
    }
    return n
  }
}
