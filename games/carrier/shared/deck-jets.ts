// Jets parked on deck: every ready aircraft slot (shared/ops.ts: not flown, not recharging) is a jet standing on its
// carrier's apron, and enemies can destroy it there. Pure and DOM-free; the room (server/core.ts) owns one `DeckJets`
// (the parked jets' health), clients draw the parked set from the crew they already have.
//
// - Where: each catalogue slot that flies (the Hornets, then the F-35C; never the boat's) has its own bay, the
//   carrier-spec `PARKING` jet spots in order, on the starboard apron clear of the runway, the catapult track and the
//   landing path. Extra slots (made for pilots rescued from a sunk carrier) have no bay and are never parked.
// - Which: `parkedJets(ship, now)` = the slots with a bay that are ready at room time `now`. A launch takes the slot (the
//   jet leaves its bay; the catapult run is drawn as before), a landing frees it at once (the jet is back in its bay), a
//   loss leaves it recharging (an empty bay until it is ready again).
// - Health: `DECK_JET.hp`, kept only by the room. Rounds (jet gun, CIWS, boat cannon) are reported by the shooter
//   (`parkedAt` tells which parked jet a round that struck the deck hit) and checked against the same budgets and
//   ranges as rounds on a hull; bursts (bombs, missiles, 5-inch shells, SAMs) and crashing jets hurt every enemy parked
//   jet within reach (`blastOnDeck`). A parked jet left alone for `repairDelay` s is whole again. Friendly fire is off:
//   only another carrier's weapons hurt a ship's parked jets.
// - Destroyed: a `kill` event; the room puts the slot into its normal loss recharge (shared/crew.ts `wreckParked`, the
//   same as a crash) and tells everyone (`deckkill`), whose clients blow the jet apart on their copy of the deck.

import { DECK_Y, PARKING, type ParkingSpot } from "./carrier-spec"
import type { Crew, CrewShip } from "./crew"
import { makeSlots, opById, slotReady } from "./ops"
import { type ShipPoseLike, shipToWorld } from "./plane"
import type { VehicleKind } from "./vehicles"
import { BOAT_DAMAGE } from "./boat"
import { GUNNERY } from "./gunnery"
import { type KillWeapon, WEAPONS } from "./weapons"

export const DECK_JET = {
  /** Health of a parked jet: a solid strafing pass (30 gun rounds), a bomb within ~15 m or a missile on it. */
  hp: 60,
  /** Round hit box around the bay's centre, in the jet's own frame (m): half span, half length, height above the deck. */
  halfSpan: 7,
  halfLength: 9.5,
  height: 5.5,
  /** Bursts measure their distance to this point above the bay's centre (m above the deck). */
  centreY: 2,
  /** A jet crashing within this distance (m) of a parked one destroys it. */
  crash: 16,
  /** Damage is forgotten after this long without another hit (room ms). */
  repairDelay: 20_000,
} as const

/** Weapons that hurt parked jets: every kill weapon, and a jet crashing onto them. */
export type DeckJetWeapon = KillWeapon | "crash"
export const DECK_JET_WEAPONS: readonly DeckJetWeapon[] = ["gun", "missile", "bomb", "ciws", "sam", "shell", "cannon", "crash"]

/** Round sources a shooter reports on a parked jet (`deckhits.w`): the jet gun, a CIWS, the boat's 25 mm. */
export const DECK_ROUND = { gun: 0, ciws: 1, cannon: 2 } as const
export type DeckRound = (typeof DECK_ROUND)[keyof typeof DECK_ROUND]
/** Damage per round on a parked jet: what the same round does to a flying jet. */
export const DECK_JET_ROUND_DAMAGE = { gun: WEAPONS.gun.damage, ciws: GUNNERY.ciws.damage, cannon: BOAT_DAMAGE.cannonJet } as const
export const deckRoundWeapon = (w: DeckRound): "gun" | "ciws" | "cannon" => (w === 0 ? "gun" : w === 1 ? "ciws" : "cannon")

/** The aircraft bays, in catalogue order of the slots that fly. */
export const DECK_BAYS: readonly ParkingSpot[] = PARKING.filter((p) => p.kind === "jet")

/** How many slots a ship is built with (later ones are extras for rescued pilots). */
const BASE_SLOTS = makeSlots().length

/** Bay index of slot `slot` of ship `s`, or -1 (the boat's, an extra slot, or more slots than bays). */
export function bayOf(s: CrewShip, slot: number): number {
  if (slot < 0 || slot >= BASE_SLOTS || slot >= s.aircraft.length) return -1
  let k = 0
  for (let i = 0; i < slot; i++) if (!opById(s.aircraft[i]!.op)?.boat) k++
  const op = opById(s.aircraft[slot]!.op)
  if (!op || op.boat || !op.vehicle) return -1
  return k < DECK_BAYS.length ? k : -1
}

/** A jet standing in its bay: the slot it belongs to, its type and its bay. */
export type ParkedJet = { slot: number; kind: VehicleKind; bay: ParkingSpot }

/** Whether slot `slot` of ship `s` has a jet in its bay at room time `now`. */
export function isParked(s: CrewShip, slot: number, now: number): boolean {
  const a = s.aircraft[slot]
  return !!a && slotReady(a, now) && bayOf(s, slot) >= 0
}

/** Every jet parked on ship `s` at room time `now`, in slot order. */
export function parkedJets(s: CrewShip, now: number, out: ParkedJet[] = []): ParkedJet[] {
  out.length = 0
  for (let i = 0; i < s.aircraft.length; i++) {
    if (!isParked(s, i, now)) continue
    out.push({ slot: i, kind: opById(s.aircraft[i]!.op)!.vehicle!, bay: DECK_BAYS[bayOf(s, i)]! })
  }
  return out
}

/** A ship-local point in bay `b`'s own frame: [across (+ the jet's left), along (+ its nose)]. */
function inBay(b: ParkingSpot, x: number, z: number): [number, number] {
  const dx = x - b.x
  const dz = z - b.z
  const s = Math.sin(b.yaw)
  const c = Math.cos(b.yaw)
  return [dx * c - dz * s, dx * s + dz * c]
}

/** Whether a ship-local point lies inside bay `b`'s round hit box. */
export function inBayBox(b: ParkingSpot, x: number, y: number, z: number): boolean {
  if (y < DECK_Y - 1.5 || y > DECK_Y + DECK_JET.height) return false
  const [across, along] = inBay(b, x, z)
  return Math.abs(across) <= DECK_JET.halfSpan && Math.abs(along) <= DECK_JET.halfLength
}

/** The parked jet of ship `s` a round striking ship-local (x, y, z) hit at room time `now` (its slot), or -1. */
export function parkedAt(s: CrewShip, now: number, x: number, y: number, z: number): number {
  for (let i = 0; i < s.aircraft.length; i++) if (isParked(s, i, now) && inBayBox(DECK_BAYS[bayOf(s, i)]!, x, y, z)) return i
  return -1
}

/** The ship-local corners of bay `b`'s hit box (plan), for layout checks. */
export function bayCorners(b: ParkingSpot): [number, number][] {
  const s = Math.sin(b.yaw)
  const c = Math.cos(b.yaw)
  const out: [number, number][] = []
  for (const [a, l] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const across = a * DECK_JET.halfSpan
    const along = l * DECK_JET.halfLength
    out.push([b.x + across * c + along * s, b.z - across * s + along * c])
  }
  return out
}

/** World position of bay `b`'s centre on ship pose `ship`, `up` m above the deck. */
export const bayWorld = (ship: ShipPoseLike, b: ParkingSpot, up: number, out: [number, number, number] = [0, 0, 0]) => shipToWorld(ship, b.x, DECK_Y + up, b.z, out) as [number, number, number]

export type DeckJetEvent =
  /** Parked jet `slot` of ship `ship` was destroyed by player `by` (−1 nobody) with `w`. */
  { k: "kill"; ship: number; slot: number; kind: VehicleKind; by: number; w: DeckJetWeapon }

/** A ship as the room hit-tests it: its settled pose, crew id and team. */
export type DeckShip = ShipPoseLike & { id?: number; team?: number }

type Damage = { hp: number; at: number; by: number }

const key = (ship: number, slot: number) => ship * 64 + slot

/**
 * The room's parked-jet health. `hit` damages one parked jet, `blast` every enemy one near a burst, `step` repairs and
 * forgets jets that left their bay. Destroyed jets become `kill` events (the room drains `events`).
 */
export class DeckJets {
  private damage = new Map<number, Damage>()
  readonly events: DeckJetEvent[] = []

  /** Health of parked jet `slot` of ship `ship` (full when undamaged or unknown). */
  health(ship: number, slot: number): number {
    return this.damage.get(key(ship, slot))?.hp ?? DECK_JET.hp
  }

  /**
   * `dmg` to parked jet `slot` of ship `shipId` from player `by` of team `team` with `w` at room time `now`. Refused
   * (0) unless that slot has a jet in its bay and it is an enemy's. Returns the damage applied.
   */
  hit(crew: Crew, shipId: number, slot: number, dmg: number, by: number, team: number, w: DeckJetWeapon, now: number): number {
    const s = crew.ships.find((x) => x.id === shipId)
    if (!s || s.team === team || !(dmg > 0) || !isParked(s, slot, now)) return 0
    const k = key(shipId, slot)
    const d = this.damage.get(k) ?? { hp: DECK_JET.hp, at: now, by }
    // Already destroyed: the wreck stays out of play until its slot leaves the bay (the room's recharge).
    if (d.hp <= 0) return 0
    const done = Math.min(d.hp, dmg)
    d.hp -= done
    d.at = now
    d.by = by
    this.damage.set(k, d)
    if (d.hp > 0) return done
    this.events.push({ k: "kill", ship: shipId, slot, kind: opById(s.aircraft[slot]!.op)!.vehicle!, by, w })
    return done
  }

  /**
   * A burst at world (x, y, z) by player `by` of team `team`: every enemy parked jet takes `falloff(distance)` (m from
   * its bay's centre on the ship's settled pose in `ships`). Returns how many jets it hurt.
   */
  blast(crew: Crew, ships: readonly DeckShip[], x: number, y: number, z: number, by: number, team: number, w: DeckJetWeapon, falloff: (d: number) => number, now: number): number {
    let n = 0
    for (const sh of ships) {
      if (sh.id === undefined || sh.team === team || Math.abs(x - sh.x) > 220 || Math.abs(z - sh.z) > 220) continue
      const s = crew.ships.find((c) => c.id === sh.id)
      if (!s) continue
      for (const p of parkedJets(s, now, parked)) {
        const c = bayWorld(sh, p.bay, DECK_JET.centreY, at)
        const dmg = falloff(Math.hypot(c[0] - x, c[1] - y, c[2] - z))
        if (dmg > 0 && this.hit(crew, sh.id, p.slot, dmg, by, team, w, now) > 0) n++
      }
    }
    return n
  }

  /** Forgets jets no longer in their bay (launched, lost, sunk) and repairs those left alone long enough. */
  step(crew: Crew, now: number): void {
    for (const [k, d] of this.damage) {
      const s = crew.ships.find((x) => x.id === Math.floor(k / 64))
      if (!s || !isParked(s, k % 64, now) || (d.hp > 0 && now - d.at >= DECK_JET.repairDelay)) this.damage.delete(k)
    }
  }
}

const parked: ParkedJet[] = []
const at: [number, number, number] = [0, 0, 0]

/** A crashing jet's falloff on parked jets: destroyed within `DECK_JET.crash` m. */
export const crashFalloff = (d: number): number => (d <= DECK_JET.crash ? DECK_JET.hp : 0)
