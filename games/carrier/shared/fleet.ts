// Ship damage: every carrier's health, its damage zones, fires, settling and sinking. Pure and DOM-free; the room
// (server/core.ts) owns one `Fleet`, applies hits to it and broadcasts every hull (`packHull`); clients unpack them to
// draw fires, smoke and the settle, show health and limit their own helm. Times are sea time (s).
//
// The model (tuning in `FLEET`):
// - HULL: health, `FLEET.hp` (1,000). A full gun overheat run (160 rounds) takes ~4%, a missile 5%, a direct bomb hit
//   17.5% (an F-35C's four bombs ≈ 70%), a bomb bursting in the water within `near` m of the hull 1.5–7%, a jet
//   crashing into the ship 5%. Friendly fire is off: only the other team's weapons (and jets) hurt a ship.
// - Zones, from where a hit lands in ship-local space (`hullZone`): the ISLAND (bridge) box, the DECK (on or above the
//   flight deck), else the HULL side. Island hits also damage the bridge (`island` 0..1): the ship's top speed and
//   rudder authority fall with it (`hullLimits`, up to 45% slower). Bombs and missiles on the deck start a deck fire:
//   no launching and no landing on that ship while it burns (`deckOpen`, `FLEET.deckFire` s after the last hit).
// - Fires: each missile or bomb hit leaves a fire at its ship-local point (at most `fires`); a fire burns for
//   `fireLife` s after its hit, and every fire stays lit while the hull is below `burning` of its health.
// - Repair: after `repairDelay` s without damage the crew repairs the hull at `repair` hp/s and the bridge at
//   `islandRepair` per second (back to full), like the jets' field repair.
// - Settle: as health falls the hull sits lower (up to `settle` m) and lists toward the side that took the hits (up to
//   `list` rad). Applied as an offset on the drawn and hit-tested pose (`settled`), never inside the shared buoyancy
//   physics, so every client and the room agree from health alone.
// - Sinking: at 0 health the ship starts sinking (`sinkAt`): engines stop, the helm is ignored, fires and explosions,
//   it goes down by the bow over `sinkTime` s (`settled` grows the offset), then the room scuttles it
//   (shared/crew.ts `scuttle`: its crew moves to another ship of the team; airborne pilots keep flying).

import { BEAM_WL, BOW_Z, DECK_Y, ISLAND, STERN_Z } from "./carrier-spec"
import type { WeaponKind } from "./weapons"

export const FLEET = {
  hp: 1000,
  /** Damage per gun round, missile, direct bomb hit, jet crash. */
  gun: 0.25,
  missile: 50,
  bomb: 175,
  crash: 50,
  /** A ship gun's shell when the caller gives no amount (gunnery passes its own). */
  shell: 20,
  /** A bomb bursting in the water this close to the hull's waterline (m) does `nearMax` at the hull down to `nearMin`. */
  near: 25,
  nearMax: 70,
  nearMin: 15,
  /** Bridge damage (of 1) per bomb, missile and gun round on the island. */
  islandBomb: 0.4,
  islandMissile: 0.15,
  islandGun: 0.0015,
  /** A wrecked bridge (island 1) leaves this share of top speed and rudder. */
  islandSpeed: 0.55,
  islandTurn: 0.6,
  /** A deck fire burns this long after the last bomb or missile on the deck (s). */
  deckFire: 15,
  fires: 8,
  fireLife: 45,
  /** Fires stay lit below this share of health. */
  burning: 0.6,
  repairDelay: 40,
  repair: 1.5,
  islandRepair: 0.01,
  /** Deepest settle (m) and list (rad) just before sinking. */
  settle: 3.2,
  list: (5 * Math.PI) / 180,
  /** The sinking: how long it takes (s), how deep it goes (m), bow-down pitch and extra list (rad) by the end. */
  sinkTime: 25,
  sinkDepth: 70,
  sinkPitch: (16 * Math.PI) / 180,
  sinkRoll: (14 * Math.PI) / 180,
  /** The repair shares hp changes this small are not broadcast (every hit is). */
  sendStep: 5,
} as const

export type HullZone = "hull" | "deck" | "island"

/** A fire on a ship: ship-local point and when it started (sea time). */
export type Fire = { x: number; y: number; z: number; t: number }

export type Hull = {
  id: number
  team: number
  hp: number
  /** Bridge damage 0..1. */
  island: number
  /** Sea time until which the deck burns (−Infinity: never). */
  deckFire: number
  /** Sea time the sinking began, or −1 afloat. */
  sinkAt: number
  /** Last damage: when, by whom (player id, −1 nobody). */
  hitAt: number
  by: number
  /** Sum of the hits' ship-local x weighted by damage: the list leans toward the side that took them. */
  side: number
  fires: Fire[]
}

export function makeHull(id: number, team: number): Hull {
  return { id, team, hp: FLEET.hp, island: 0, deckFire: -Infinity, sinkAt: -1, hitAt: -Infinity, by: -1, side: 0, fires: [] }
}

/** Which zone a ship-local point is in. */
export function hullZone(x: number, y: number, z: number): HullZone {
  if (x > ISLAND.x0 - 1 && x < ISLAND.x1 + 1 && z > ISLAND.z0 - 1 && z < ISLAND.z1 + 1 && y > DECK_Y + 0.5) return "island"
  if (y >= DECK_Y - 2) return "deck"
  return "hull"
}

/** Plan distance (m) from a ship-local point to the hull's waterline rectangle (0 inside it). */
export function waterlineDistance(x: number, z: number): number {
  const hx = BEAM_WL / 2
  const dx = Math.max(0, Math.abs(x) - hx)
  const dz = Math.max(0, z - BOW_Z, STERN_Z - z)
  return Math.hypot(dx, dz)
}

/** What can damage a ship: jet weapons, a jet crashing into it, and ship guns' shells (gunnery, by explicit amount). */
export type ShipDamageKind = WeaponKind | "crash" | "shell"

/** Damage a weapon does to a ship: a direct hit (near 0), or a bomb bursting in the water `near` m from the hull. */
export function shipDamage(w: ShipDamageKind, near = 0): number {
  if (w === "gun") return FLEET.gun
  if (w === "shell") return FLEET.shell
  if (w === "missile") return FLEET.missile
  if (w === "crash") return FLEET.crash
  if (near <= 0) return FLEET.bomb
  if (near > FLEET.near) return 0
  return FLEET.nearMax + (FLEET.nearMin - FLEET.nearMax) * (near / FLEET.near)
}

const ISLAND_DAMAGE: Record<ShipDamageKind, number> = { gun: FLEET.islandGun, missile: FLEET.islandMissile, bomb: FLEET.islandBomb, crash: FLEET.islandMissile, shell: FLEET.islandMissile * 0.4 }

/**
 * A hit on a ship, as the fleet applies it: (x, y, z) is the ship-local point; `near` > 0 for a bomb in the water; `n`
 * repeats it (rounds); `amount` overrides the per-hit damage (shells, whose gun decides).
 */
export type ShipHit = { ship: number; by: number; team: number; w: ShipDamageKind; x: number; y: number; z: number; near: number; n?: number; amount?: number }

export type FleetEvent =
  /** A hull's state changed enough to broadcast (a hit, a repair step, a fire, the sinking). */
  | { k: "hull"; ship: number }
  /** A ship started sinking: who dealt the final blow (−1 nobody). */
  | { k: "sinking"; ship: number; by: number }
  /** A sinking ship has gone under: the room scuttles it. */
  | { k: "sunk"; ship: number; by: number }

/**
 * Every ship's health. `add` when a ship is commissioned, `remove` when it is gone, `hit` for damage (friendly fire is
 * refused here), `step(t)` every room tick (repair, fires, sinking). Events accumulate in `events`.
 */
export class Fleet {
  readonly hulls = new Map<number, Hull>()
  readonly events: FleetEvent[] = []
  private sent = new Map<number, number>()

  add(id: number, team: number): Hull {
    const h = makeHull(id, team)
    this.hulls.set(id, h)
    this.sent.set(id, h.hp)
    return h
  }

  remove(id: number): void {
    this.hulls.delete(id)
    this.sent.delete(id)
  }

  /** Applies a hit at sea time t. Returns the damage done (0: refused, friendly, already sinking). */
  hit(h: ShipHit, t: number): number {
    const s = this.hulls.get(h.ship)
    if (!s || s.sinkAt >= 0 || h.team === s.team) return 0
    const zone = h.near > 0 ? "hull" : hullZone(h.x, h.y, h.z)
    const n = h.n ?? 1
    const dmg = (h.amount ?? shipDamage(h.w, h.near)) * n
    if (dmg <= 0) return 0
    s.hp = Math.max(0, s.hp - dmg)
    s.hitAt = t
    s.by = h.by
    s.side += Math.sign(h.x) * dmg
    if (zone === "island") s.island = Math.min(1, s.island + ISLAND_DAMAGE[h.w] * n)
    const big = h.w === "bomb" || h.w === "missile" || h.w === "crash" || (h.w === "shell" && dmg >= 20)
    if (big && zone === "deck") s.deckFire = t + FLEET.deckFire
    if (big && h.near <= 0) {
      s.fires.push({ x: h.x, y: Math.max(h.y, zone === "hull" ? 4 : h.y), z: h.z, t })
      if (s.fires.length > FLEET.fires) s.fires.shift()
    }
    this.sent.set(s.id, s.hp)
    this.events.push({ k: "hull", ship: s.id })
    if (s.hp <= 0) {
      s.sinkAt = t
      s.deckFire = Infinity
      this.events.push({ k: "sinking", ship: s.id, by: h.by })
    }
    return dmg
  }

  /** Repair, fires going out, sinking ships going under. */
  step(t: number, dt: number): void {
    for (const s of this.hulls.values()) {
      if (s.sinkAt >= 0) {
        if (t - s.sinkAt >= FLEET.sinkTime) {
          this.events.push({ k: "sunk", ship: s.id, by: s.by })
          s.sinkAt = -2
        }
        continue
      }
      const before = s.fires.length
      if (s.hp >= FLEET.hp * FLEET.burning) s.fires = s.fires.filter((f) => t - f.t < FLEET.fireLife)
      let changed = s.fires.length !== before
      if (t - s.hitAt > FLEET.repairDelay) {
        if (s.hp < FLEET.hp) s.hp = Math.min(FLEET.hp, s.hp + FLEET.repair * dt)
        if (s.island > 0) s.island = Math.max(0, s.island - FLEET.islandRepair * dt)
        if (s.hp >= FLEET.hp) s.side = 0
        if (Math.abs(s.hp - this.sent.get(s.id)!) >= FLEET.sendStep || (s.hp >= FLEET.hp && this.sent.get(s.id)! < FLEET.hp)) {
          this.sent.set(s.id, s.hp)
          changed = true
        }
      }
      if (changed) this.events.push({ k: "hull", ship: s.id })
    }
  }

  /** Sinking ships (−2: gone under, waiting to be scuttled) are skipped for hits; still listed for drawing. */
  sinking(id: number): boolean {
    return (this.hulls.get(id)?.sinkAt ?? -1) !== -1
  }
}

/** How much the bridge damage leaves of the ship's top speed and rudder (both 0 while sinking). */
export function hullLimits(h: Pick<Hull, "island" | "sinkAt"> | null | undefined): { speed: number; turn: number } {
  if (!h) return { speed: 1, turn: 1 }
  if (h.sinkAt !== -1) return { speed: 0, turn: 0 }
  return { speed: 1 - (1 - FLEET.islandSpeed) * h.island, turn: 1 - (1 - FLEET.islandTurn) * h.island }
}

/** Whether jets can launch from and land on the ship at sea time t: not burning on deck, not sinking. */
export const deckOpen = (h: Pick<Hull, "deckFire" | "sinkAt"> | null | undefined, t: number): boolean => !h || (h.sinkAt === -1 && t >= h.deckFire)

/** Whether the fires are lit at sea time t (each for fireLife after its hit, all of them while badly damaged). */
export const fireLit = (h: Pick<Hull, "hp" | "sinkAt">, f: Fire, t: number): boolean => h.sinkAt !== -1 || h.hp < FLEET.hp * FLEET.burning || t - f.t < FLEET.fireLife

/** The settle offset of a hull at sea time t: how much lower it rides, extra pitch (bow down −) and roll. */
export function settleOf(h: Pick<Hull, "hp" | "side" | "sinkAt">, t: number, out = { heave: 0, pitch: 0, roll: 0 }): { heave: number; pitch: number; roll: number } {
  const lost = 1 - Math.max(0, Math.min(1, h.hp / FLEET.hp))
  const side = h.side === 0 ? 1 : -Math.sign(h.side)
  // ship.ts roll > 0 is starboard (−X) down: hits on the port side (+X) list the ship to port.
  out.heave = -FLEET.settle * lost * lost
  out.pitch = 0
  out.roll = side * FLEET.list * lost
  if (h.sinkAt !== -1) {
    const u = h.sinkAt < 0 ? 1 : Math.max(0, Math.min(1, (t - h.sinkAt) / FLEET.sinkTime))
    out.heave -= FLEET.sinkDepth * u * u
    out.pitch -= FLEET.sinkPitch * Math.sqrt(u) * u
    out.roll += side * FLEET.sinkRoll * u * u
  }
  return out
}

/** A ship pose with the settle applied (a copy into `out`, for drawing and hit tests). */
export function settled<T extends { heave: number; pitch: number; roll: number }>(ship: T, h: Pick<Hull, "hp" | "side" | "sinkAt"> | null | undefined, t: number, out: T): T {
  if (out !== ship) Object.assign(out, ship)
  if (!h) return out
  const o = settleOf(h, t, sc)
  out.heave += o.heave
  out.pitch += o.pitch
  out.roll += o.roll
  return out
}
const sc = { heave: 0, pitch: 0, roll: 0 }

// ---- wire ---------------------------------------------------------------------------------------------------------------

/**
 * A hull on the wire: [id, hp, island ×1000, deck fire seconds left (0 none; −1 sinking), sea time the sinking began
 * (−1 afloat), list side (−1, 0, 1), then each fire as ship-local x, y, z and its age in whole seconds]. Fires are sent
 * as ages so a receiver's sea time decides when they go out.
 */
export type HullTuple = number[]
export const HULL_HEAD = 6

export function packHull(h: Hull, t: number): HullTuple {
  const out: HullTuple = [h.id, Math.round(h.hp * 10) / 10, Math.round(h.island * 1000), h.sinkAt !== -1 ? -1 : Math.max(0, Math.ceil(h.deckFire - t)), h.sinkAt === -1 ? -1 : Math.round(Math.max(0, h.sinkAt) * 100) / 100, Math.sign(h.side)]
  for (const f of h.fires) out.push(Math.round(f.x), Math.round(f.y), Math.round(f.z), Math.max(0, Math.round(t - f.t)))
  return out
}

/** A received hull at sea time t (team from the crew). */
export function unpackHull(v: HullTuple, t: number, team = -1, out: Hull = makeHull(0, team)): Hull {
  out.id = v[0]!
  out.team = team
  out.hp = v[1]!
  out.island = v[2]! / 1000
  out.deckFire = v[3]! < 0 ? Infinity : v[3]! > 0 ? t + v[3]! : -Infinity
  out.sinkAt = v[4]!
  out.side = v[5]!
  out.fires.length = 0
  for (let i = HULL_HEAD; i + 3 < v.length; i += 4) out.fires.push({ x: v[i]!, y: v[i + 1]!, z: v[i + 2]!, t: t - v[i + 3]! })
  return out
}

export function isHullTuple(v: unknown): v is HullTuple {
  if (!Array.isArray(v) || v.length < HULL_HEAD || (v.length - HULL_HEAD) % 4 !== 0 || v.length > HULL_HEAD + 4 * FLEET.fires) return false
  for (const n of v) if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e7) return false
  return Number.isInteger(v[0]) && v[0] >= 0
}
