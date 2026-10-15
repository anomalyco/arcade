// Ship operations: what a member of a ship can do aboard it, as data. The DEPLOY menu (src/ui/ops-menu.ts)
// lists them and is the only way to take the helm or launch; the room validates every request with `opError` and runs
// it with shared/crew.ts `runOp`. Pure; imports only types, so shared/crew.ts can build ships from the catalogue.
//
// - `helm`: TAKE HELM. One per ship, only while nobody has it; a pilot on deck can take it.
// - `vehicle`: LAUNCH a vehicle. Each vehicle operation gives every ship `cap` slots (shared/crew.ts `Aircraft`,
//   tagged with the operation id), so at most `cap` of that vehicle are out at once. A slot is ready when nobody flies
//   it and its `readyAt` has passed. A vehicle that is destroyed (crashed, shot down) leaves its slot recharging for
//   `recharge` seconds; one that lands on its carrier frees it at once. There is no other way out of a flight, so a
//   pilot who wants the helm lands first (or dies): TAKE HELM reads AIRBORNE while they fly. The helm launching hands
//   off the helm.
// - `gun`: man one of the ship's guns (shared/gunnery.ts; the mounts of carrier-spec `WEAPON_MOUNTS`): CIWS PORT/STBD,
//   SAM PORT/STBD, 5-INCH GUN. One gunner per mount (cap 1), no recharge to take the seat (ammo and reload are the
//   weapon's). Taking a gun frees your previous role (the helm hands off; a pilot on deck or another gun switches);
//   picking any other operation leaves the gun. A gunner is a crew member like a pilot on deck (`CrewPlayer.mount`).
// - The boat (`boat: true` vehicle, LAUNCH BOAT, shared/boat.ts): one per ship, craned over the port side at the
//   elevator. A driver holds its slot like a pilot holds a jet's (`plane` is the slot), but the room ends the sortie
//   itself: brought back alongside its carrier ("landed": the slot frees at once) or sunk ("crashed": it recharges 40 s).
//   Either way the driver goes back to the role they launched from (the helm or their gun, if still free; shared/crew.ts).
// - Who may run one: a member of the ship, not already out in a vehicle (in the air or at sea the menu is read-only).
//
// Adding a vehicle type: one entry here (its id is the `op` of its slots and what the client's vehicle module keys
// on) plus that module. A new kind of seat: an `OpKind`, its `opError` and `shipOps` cases and its `runOp` (crew.ts).

import type { Aircraft, Crew, CrewError, CrewShip } from "./crew"
import { WEAPON_MOUNTS } from "./carrier-spec"
import type { VehicleKind } from "./vehicles"

export type { VehicleKind }
export type OpKind = "helm" | "vehicle" | "gun"

export type Op = {
  id: string
  /** The menu's line, "LAUNCH HORNET". */
  label: string
  /** Short, for slots and the HUD's state line, "HORNET". */
  name: string
  kind: OpKind
  vehicle?: VehicleKind
  /** The interceptor boat (shared/boat.ts) rather than an aircraft. */
  boat?: boolean
  /** The gun's mount (index into carrier-spec `WEAPON_MOUNTS`), for `gun` operations. */
  mount?: number
  /** At most this many in use at once per ship. */
  cap: number
  /** Seconds a slot recharges after its vehicle is destroyed (0: never). */
  recharge: number
}

/** The catalogue, in menu order (the number keys follow it). */
export const OPS: readonly Op[] = [
  { id: "helm", label: "TAKE HELM", name: "HELM", kind: "helm", cap: 1, recharge: 0 },
  { id: "hornet", label: "LAUNCH HORNET", name: "HORNET", kind: "vehicle", vehicle: "hornet", cap: 2, recharge: 30 },
  // One strike jet per ship: the stealth bomber is the scarcer, heavier asset, so losing it costs longer than a Hornet.
  { id: "f35", label: "LAUNCH F-35C", name: "F-35C", kind: "vehicle", vehicle: "f35", cap: 1, recharge: 45 },
  // One fast interceptor per ship, lowered over the port side at the elevator.
  { id: "boat", label: "LAUNCH BOAT", name: "BOAT", kind: "vehicle", boat: true, cap: 1, recharge: 40 },
  ...gunOps(),
]

/** One `gun` operation per weapon mount, in a fixed order: the CIWS pair, the SAM pair, the 5-inch gun. */
function gunOps(): Op[] {
  const order: [kind: string, side: string, id: string, label: string, name: string][] = [
    ["ciws", "port", "ciws-port", "CIWS PORT", "CIWS PORT"],
    ["ciws", "starboard", "ciws-stbd", "CIWS STBD", "CIWS STBD"],
    ["sam", "port", "sam-port", "SAM PORT", "SAM PORT"],
    ["sam", "starboard", "sam-stbd", "SAM STBD", "SAM STBD"],
    ["gun", "starboard", "gun-5in", "5-INCH GUN", "5-INCH"],
  ]
  return order.flatMap(([kind, side, id, label, name]) => {
    const mount = WEAPON_MOUNTS.findIndex((m) => m.kind === kind && m.side === side)
    return mount < 0 ? [] : [{ id, label, name, kind: "gun" as const, mount, cap: 1, recharge: 0 }]
  })
}

/** The `gun` operation of mount `mount`. */
export const gunOp = (mount: number): Op | undefined => OPS.find((o) => o.kind === "gun" && o.mount === mount)

/** Who mans mount `mount` of ship `s` (null: nobody). */
export function gunnerAt(c: Crew, s: CrewShip, mount: number): number | null {
  return c.players.find((p) => p.ship === s.id && p.role === "gunner" && p.mount === mount)?.id ?? null
}

export const opById = (id: string): Op | undefined => OPS.find((o) => o.id === id)
export const isOpId = (v: unknown): v is string => typeof v === "string" && OPS.some((o) => o.id === v)

/** Whether slot `slot` of ship `s` is the boat's. */
export const slotIsBoat = (s: CrewShip | undefined, slot: number): boolean => !!(s && opById(s.aircraft[slot]?.op ?? "")?.boat)

/** Whether player `id` is out in (or holds the slot of) their ship's boat. */
export function playerBoat(c: Crew | null, id: number): boolean {
  const p = c?.players.find((x) => x.id === id)
  return !!p && p.plane >= 0 && slotIsBoat(c!.ships.find((x) => x.id === p.ship), p.plane)
}

/** The aircraft type flown from slot `slot` of ship `s` (the Hornet for an unknown slot or op, and for the boat's). */
export const slotVehicle = (s: CrewShip | undefined, slot: number): VehicleKind => (s && opById(s.aircraft[slot]?.op ?? "")?.vehicle) || "hornet"

/** The aircraft type player `id` flies (or last held a slot in), from the crew. */
export function playerVehicle(c: Crew | null, id: number): VehicleKind {
  const p = c?.players.find((x) => x.id === id)
  return slotVehicle(p ? c!.ships.find((x) => x.id === p.ship) : undefined, p?.plane ?? -1)
}

/** A new ship's vehicle slots: `cap` per vehicle operation, in catalogue order, all ready. */
export function makeSlots(): Aircraft[] {
  return OPS.filter((o) => o.kind === "vehicle").flatMap((o) => Array.from({ length: o.cap }, (): Aircraft => ({ op: o.id, pilot: null, readyAt: 0 })))
}

/** Whether slot `a` can launch at room time `now`. */
export const slotReady = (a: Aircraft, now: number): boolean => a.pilot === null && a.readyAt <= now

/** Ship `s`'s slots for operation `op`, with their indices into `s.aircraft`. */
export const slotsOf = (s: CrewShip, op: string): { a: Aircraft; i: number }[] => s.aircraft.flatMap((a, i) => (a.op === op ? [{ a, i }] : []))

/** The ready slot a launch of `op` takes: the lowest index. -1 if none. */
export const readySlot = (s: CrewShip, op: string, now: number): number => slotsOf(s, op).find(({ a }) => slotReady(a, now))?.i ?? -1

/** Why player `id` can't run operation `opId` on their ship at `now`, or null if they can. */
export function opError(c: Crew, id: number, opId: string, now: number): CrewError | null {
  const p = c.players.find((x) => x.id === id)
  if (!p) return "no-player"
  const s = c.ships.find((x) => x.id === p.ship)
  if (!s) return "no-ship"
  const op = opById(opId)
  if (!op) return "bad-op"
  if (p.plane >= 0) return "flying"
  if (op.kind === "helm") {
    if (p.role === "helm") return "at-helm"
    return s.helm === null ? null : "helm-taken"
  }
  if (op.kind === "gun") {
    const at = gunnerAt(c, s, op.mount ?? -1)
    return at === null ? null : at === id ? "at-gun" : "in-use"
  }
  if (readySlot(s, op.id, now) < 0) return slotsOf(s, op.id).some(({ a }) => a.pilot === null) ? "recharging" : "in-use"
  // One catapult per ship: a jet waits until the last one has left the bow (shared/launch.ts).
  return !op.boat && s.catapultUntil > now ? "catapult-busy" : null
}

/** What the menu shows for an operation, from one player's point of view. */
export type OpState = "available" | "active" | "in-use" | "recharging" | "unavailable"
/** One slot: who uses it (null: nobody), and ms until it is ready again (0: ready or in use). */
export type OpSlot = { player: number | null; readyIn: number }
export type OpView = {
  op: Op
  state: OpState
  slots: OpSlot[]
  /** Ms until the first slot is ready (recharging), else 0. */
  readyIn: number
  /** Why it can't run now (null when available). */
  reason: CrewError | null
}

/** Every operation on player `id`'s ship as the menu shows it, or null if they aren't aboard one. */
export function shipOps(c: Crew, id: number, now: number): OpView[] | null {
  const p = c.players.find((x) => x.id === id)
  const s = p && c.ships.find((x) => x.id === p.ship)
  if (!p || !s) return null
  return OPS.map((op) => {
    const slots: OpSlot[] =
      op.kind === "helm" ? [{ player: s.helm, readyIn: 0 }] : op.kind === "gun" ? [{ player: gunnerAt(c, s, op.mount ?? -1), readyIn: 0 }] : slotsOf(s, op.id).map(({ a }) => ({ player: a.pilot, readyIn: a.pilot === null ? Math.max(0, a.readyAt - now) : 0 }))
    const reason = opError(c, id, op.id, now)
    const mine = slots.some((x) => x.player === id)
    const waits = slots.filter((x) => x.player === null).map((x) => x.readyIn)
    const readyIn = waits.length && Math.min(...waits) > 0 ? Math.min(...waits) : 0
    const state: OpState = mine ? "active" : !reason ? "available" : reason === "recharging" ? "recharging" : reason === "in-use" || reason === "helm-taken" ? "in-use" : "unavailable"
    return { op, state, slots, readyIn, reason }
  })
}
