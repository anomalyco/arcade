import { DT, HEALTH, PLAYER_RADIUS, type Weapon } from "../config"
import { angleDiff, clearLine } from "../geom"
import type { VehicleSpawn } from "../maps/types"
import { overlaps } from "./gear"
import type { Rigid } from "./vehicle-collide"
import { type Drive, PARKED, type VehicleKind, type VehicleSpec, VEHICLES, boxOf, collideCars, collideWalls, distToBox, driveOf, driveStep, localToWorld, pushOutBox, rayBox, seatPos, speedOf } from "./vehicle"
import type { Intent, Player, World } from "./world"

/**
 * Vehicles in a match: parked where the map says at the start, entered and left with F, driven by whoever has seat 0,
 * shot up and blown up, and back at their spot a while after they burn out. The World calls these at its hooks.
 */

/**
 * reach: how close (m) to the bodywork you can get in, and below what speed. run: the speed that kills an enemy you
 * drive into. crash: impact speed above which a crash hurts the vehicle, and how much per m/s. wreck: seconds a wreck
 * burns as cover; respawn: seconds after the blast it's back. blast: radius of the explosion, lethal inside `kill`.
 */
export const VEH = { reach: 1.3, enterSpeed: 4, run: 4.5, crash: 7, crashDamage: 9, wreck: 8, respawn: 30, blast: 5, kill: 2.4, blastVehicle: 450 }

export type VehicleState = "ok" | "wreck" | "gone"

export type Vehicle = Rigid & {
  id: number
  kind: VehicleKind
  spec: VehicleSpec
  spawn: VehicleSpawn
  hp: number
  state: VehicleState
  /** Player ids by seat, "" for empty; seat 0 drives. */
  seats: string[]
  drive: Drive
  horn: boolean
  /** Whoever last damaged it, and whoever last drove it, for kill credit. */
  by: string
  lastDriver: string
  /** World time it blew up, and when it's back. */
  wreckAt: number
  respawnAt: number
}

function newVehicle(id: number, spawn: VehicleSpawn): Vehicle {
  const spec = VEHICLES[spawn.kind]
  return { id, kind: spawn.kind, spec, spawn, x: spawn.x, y: spawn.y, h: spawn.heading, vx: 0, vy: 0, w: 0, hp: spec.hp, state: "ok", seats: spec.seats.map(() => ""), drive: PARKED, horn: false, by: "", lastDriver: "", wreckAt: 0, respawnAt: 0 }
}

/** Parks the map's vehicles, fresh, at their spots (a new match or a new floor). */
export function resetVehicles(w: World): void {
  w.vehicles = (w.map.vehicles ?? []).map((s, i) => newVehicle(i + 1, s))
}

export const vehicleOf = (w: World, p: Player): Vehicle | null => (p.veh ? (w.vehicles.find((v) => v.id === p.veh && v.state === "ok") ?? null) : null)

/** How much of the damage a player takes: less behind the bodywork, least at the wheel. */
export function armorOf(w: World, p: Player): number {
  const v = vehicleOf(w, p)
  return v ? (v.spec.seats[p.seat]?.armor ?? 1) : 1
}

/** Gets out of the seat without moving: dying, respawning, leaving the room. */
export function leaveSeat(w: World, p: Player): void {
  if (!p.veh) return
  for (const v of w.vehicles) if (v.id === p.veh) v.seats = v.seats.map((s) => (s === p.id ? "" : s))
  p.veh = 0
  p.seat = 0
}

/** F: get in the nearest vehicle with room, or out of the one you're in. */
export function toggleSeat(w: World, p: Player): void {
  if (p.veh) exitVehicle(w, p)
  else enterVehicle(w, p)
}

/** The vehicle you'd get into from here, if any: the nearest one within reach, slow enough, with a free seat. */
export function enterable(w: World, p: Player): Vehicle | null {
  if (!w.mode.canRide(w, p)) return null
  let best: Vehicle | null = null
  let bd = VEH.reach
  for (const v of w.vehicles) {
    if (v.state !== "ok" || speedOf(v) > VEH.enterSpeed || !v.seats.includes("")) continue
    const d = distToBox(p.x, p.y, boxOf(v, v.spec))
    if (d <= bd) {
      bd = d
      best = v
    }
  }
  return best
}

export function enterVehicle(w: World, p: Player): boolean {
  const v = enterable(w, p)
  if (!v) return false
  // The wheel first if it's free, else the free seat nearest you.
  let seat = v.seats[0] === "" ? 0 : -1
  if (seat < 0) {
    let bd = Infinity
    v.seats.forEach((s, i) => {
      if (s) return
      const at = seatPos(v, v.spec, i)
      const d = Math.hypot(at.x - p.x, at.y - p.y)
      if (d < bd) {
        bd = d
        seat = i
      }
    })
  }
  v.seats[seat] = p.id
  p.veh = v.id
  p.seat = seat
  p.vx = 0
  p.vy = 0
  p.swingAt = 0
  if (seat === 0) v.lastDriver = p.id
  sit(v, p)
  w.events.push({ k: "veh", what: "enter", id: v.id, by: p.id, seat })
  return true
}

/** Gets out to the side of your seat, else the other side, the back or the front; stays in when all are blocked. */
export function exitVehicle(w: World, p: Player): boolean {
  const v = vehicleOf(w, p)
  if (!v) {
    leaveSeat(w, p)
    return true
  }
  const spec = v.spec
  const seat = spec.seats[p.seat]!
  const [hl, hw] = [spec.length / 2, spec.width / 2]
  const side = seat.s < 0 ? -1 : 1
  const out = PLAYER_RADIUS + 0.25
  const spots = [
    [seat.f, side * (hw + out)],
    [seat.f, -side * (hw + out)],
    [-(hl + out), 0],
    [hl + out, 0],
    [seat.f, side * (hw + out + 1)],
  ] as const
  for (const [f, s] of spots) {
    const at = localToWorld(v, f, s)
    if (overlaps(at.x, at.y, PLAYER_RADIUS, w.solids) || !clearLine(v.x, v.y, at.x, at.y, w.solids)) continue
    if (w.vehicles.some((o) => o.state !== "gone" && distToBox(at.x, at.y, boxOf(o, o.spec)) < PLAYER_RADIUS)) continue
    leaveSeat(w, p)
    p.x = at.x
    p.y = at.y
    p.vx = v.vx * 0.3
    p.vy = v.vy * 0.3
    w.events.push({ k: "veh", what: "exit", id: v.id, by: p.id, seat: p.seat })
    return true
  }
  return false
}

/** Keeps a rider on their seat. */
function sit(v: Vehicle, p: Player): void {
  const at = seatPos(v, v.spec, p.seat)
  p.x = at.x
  p.y = at.y
  p.vx = v.vx
  p.vy = v.vy
}

/**
 * A rider's intent: the driver's moves drive (a tick with no fresh input from them keeps the last controls), and nobody
 * aboard walks, sprints, plants or swings; the driver can't shoot or throw either. Players who may not ride (the
 * infected) are put out.
 */
export function rideIntent(w: World, p: Player, i: Intent, fresh: boolean): Intent {
  const v = vehicleOf(w, p)
  if (!v || !w.mode.canRide(w, p)) {
    leaveSeat(w, p)
    return i
  }
  const driver = p.seat === 0
  if (driver) {
    if (fresh) v.drive = driveOf(i)
    v.horn = !!i.horn
    v.lastDriver = p.id
  }
  return { ...i, mx: 0, my: 0, sprint: false, use: false, melee: false, fire: driver ? false : i.fire, equip: driver ? false : i.equip }
}

/** Walkers can't go through vehicles or wrecks. */
export function pushOutVehicles(w: World, p: Player): void {
  for (const v of w.vehicles) if (v.state !== "gone") pushOutBox(p, PLAYER_RADIUS, boxOf(v, v.spec))
}

function driverOf(w: World, v: Vehicle): Player | null {
  const p = v.seats[0] ? w.players.get(v.seats[0]) : undefined
  return p?.alive ? p : null
}

/** Whether a vehicle carries any ally of `p` (rounds and blasts from them pass it by). */
export function friendly(w: World, v: Vehicle, p: Player): boolean {
  return v.seats.some((id) => {
    if (!id || id === p.id) return false
    const q = w.players.get(id)
    return !!q && w.allies(p, q)
  })
}

/**
 * One tick of every vehicle: wrecks burn out and come back, the rest drive and hit walls, each other and people.
 * Hard crashes hurt the vehicle; driving into an enemy fast kills them, anyone else is shoved aside.
 */
export function stepVehicles(w: World): void {
  for (const v of w.vehicles) {
    if (v.state === "wreck" && w.time >= v.wreckAt + VEH.wreck) v.state = "gone"
    if (v.state === "gone" && w.time >= v.respawnAt) respawn(w, v)
  }
  const live = w.vehicles.filter((v) => v.state === "ok")
  for (const v of live) {
    const driver = driverOf(w, v)
    if (!driver) {
      v.drive = PARKED
      v.horn = false
    }
    const impact = driveStep(v, v.drive, v.spec, DT, w.solids)
    if (impact > 2) w.events.push({ k: "crash", id: v.id, x: v.x, y: v.y, v: impact })
    if (impact > VEH.crash) damageVehicle(w, v, (impact - VEH.crash) * VEH.crashDamage, driver ?? w.players.get(v.by) ?? null, "vehicle")
  }
  const solid = w.vehicles.filter((v) => v.state !== "gone")
  for (let i = 0; i < solid.length; i++)
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i]!
      const b = solid[j]!
      const impact = collideCars(a, a.spec, b, b.spec, DT, a.state !== "ok", b.state !== "ok")
      if (impact <= 0) continue
      for (const v of [a, b]) if (v.state === "ok") collideWalls(v, v.spec, w.solids)
      if (impact > 2) w.events.push({ k: "crash", id: a.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: impact })
      if (impact > VEH.crash) {
        const da = driverOf(w, a)
        const db = driverOf(w, b)
        damageVehicle(w, a, (impact - VEH.crash) * VEH.crashDamage * (b.spec.mass / a.spec.mass) ** 0.5, db ?? da, "vehicle")
        damageVehicle(w, b, (impact - VEH.crash) * VEH.crashDamage * (a.spec.mass / b.spec.mass) ** 0.5, da ?? db, "vehicle")
      }
    }
  for (const v of w.vehicles) {
    if (v.state !== "ok") continue
    for (const id of v.seats) {
      const p = id ? w.players.get(id) : undefined
      if (p) sit(v, p)
    }
  }
  // People in the way.
  for (const q of w.players.values()) {
    if (!q.alive || q.veh) continue
    for (const v of solid) {
      if (v.state === "gone") continue
      const box = boxOf(v, v.spec)
      if (distToBox(q.x, q.y, box) >= PLAYER_RADIUS) continue
      const driver = v.state === "ok" ? (driverOf(w, v) ?? w.players.get(v.lastDriver) ?? null) : null
      if (driver && driver !== q && !w.allies(driver, q) && speedOf(v) >= VEH.run && closing(v, q)) {
        w.kill(q, driver, "roadkill", v.x, v.y)
        break
      }
      pushOutBox(q, PLAYER_RADIUS, box)
    }
  }
}

/** Whether the vehicle is moving toward someone touching it (not just scraping past them sideways or away). */
function closing(v: Vehicle, q: Player): boolean {
  const s = speedOf(v)
  if (s < 1e-6) return false
  return Math.abs(angleDiff(Math.atan2(q.y - v.y, q.x - v.x), Math.atan2(v.vy, v.vx))) < 1.4
}

/** Back at its spot once nobody's standing there. */
function respawn(w: World, v: Vehicle): void {
  const fresh = newVehicle(v.id, v.spawn)
  const box = boxOf(fresh, fresh.spec)
  const blocked = [...w.players.values()].some((p) => p.alive && distToBox(p.x, p.y, box) < PLAYER_RADIUS + 0.3) || w.vehicles.some((o) => o !== v && o.state !== "gone" && Math.hypot(o.x - v.spawn.x, o.y - v.spawn.y) < (o.spec.length + fresh.spec.length) / 2)
  if (blocked) {
    v.respawnAt = w.time + 1
    return
  }
  Object.assign(v, fresh)
}

/** Damage to a vehicle; at 0 it blows up. `by` is credited with anything the blast kills. */
export function damageVehicle(w: World, v: Vehicle, dmg: number, by: Player | null, how: Weapon): void {
  if (v.state !== "ok" || dmg <= 0) return
  v.hp -= dmg
  if (by) v.by = by.id
  if (v.hp <= 0) wreck(w, v, by, how)
}

/**
 * The vehicle explodes: everyone aboard dies, people nearby are hurt like by a frag (walls stop it), and other vehicles
 * close by take a beating, which can set them off too. It stays as a burning wreck for a while.
 */
function wreck(w: World, v: Vehicle, by: Player | null, _how: Weapon): void {
  v.state = "wreck"
  v.hp = 0
  v.wreckAt = w.time
  v.respawnAt = w.time + VEH.respawn
  v.drive = PARKED
  v.horn = false
  v.vx *= 0.3
  v.vy *= 0.3
  v.w *= 0.3
  w.events.push({ k: "wreck", id: v.id, by: by?.id ?? "", x: v.x, y: v.y, h: v.h, kind: v.kind })
  const riders = v.seats.map((id) => (id ? w.players.get(id) : undefined)).filter((p): p is Player => !!p)
  v.seats = v.seats.map(() => "")
  for (const p of riders) {
    p.veh = 0
    p.seat = 0
    if (p.alive) w.kill(p, by ?? p, "vehicle", v.x, v.y)
  }
  for (const q of [...w.players.values()]) {
    if (!q.alive || riders.includes(q)) continue
    const d = Math.max(0, distToBox(q.x, q.y, boxOf(v, v.spec)))
    if (d > VEH.blast || !clearLine(v.x, v.y, q.x, q.y, w.blockers)) continue
    const u = Math.max(0, (d - VEH.kill) / (VEH.blast - VEH.kill))
    w.damage(q, (d <= VEH.kill ? HEALTH * 2 : 10 + (HEALTH - 15) * (1 - u)) * armorOf(w, q), by ?? q, "vehicle", v.x, v.y)
  }
  blastVehicles(w, v.x, v.y, VEH.blast, VEH.blastVehicle, by, "vehicle", v)
}

/** An explosion at (x, y) hurts vehicles within `radius`, up to `dmg` at the centre, except ones carrying the owner's allies. */
export function blastVehicles(w: World, x: number, y: number, radius: number, dmg: number, by: Player | null, how: Weapon, skip?: Vehicle): void {
  for (const v of w.vehicles) {
    if (v === skip || v.state !== "ok" || (by && friendly(w, v, by))) continue
    const d = distToBox(x, y, boxOf(v, v.spec))
    if (d > radius || !clearLine(x, y, v.x, v.y, w.blockers)) continue
    damageVehicle(w, v, dmg * (1 - (d / radius) * 0.75), by, how)
  }
}

/**
 * The first vehicle a bullet from `p` along (dx, dy) runs into before `maxT`: where it enters and leaves. Rounds pass
 * the vehicle you're in, and ones carrying your allies.
 */
export function rayVehicles(w: World, p: Player, ox: number, oy: number, dx: number, dy: number, maxT: number): { v: Vehicle; t: number; out: number } | null {
  let best: { v: Vehicle; t: number; out: number } | null = null
  for (const v of w.vehicles) {
    if (v.state === "gone" || v.id === p.veh || (v.state === "ok" && friendly(w, v, p))) continue
    const hit = rayBox(ox, oy, dx, dy, boxOf(v, v.spec), best ? best.t : maxT)
    if (hit && (!best || hit[0] < best.t)) best = { v, t: hit[0], out: hit[1] }
  }
  return best
}
