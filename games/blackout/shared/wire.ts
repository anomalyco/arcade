import type { Equip, Gun } from "./config"
import type { Kit } from "./sim/kit"
import type { ClaymoreView, GrenadeView, PlayerView, Snapshot, VehicleView } from "./sim/view"
import type { VehicleKind } from "./sim/vehicle"

/**
 * The snapshot on the wire: entity lists and `you` as positional arrays with floats rounded to what the client can
 * see (positions and velocities to 1 cm, aims to 0.01 rad, vehicle headings to 0.001 rad), everything else as is.
 * `unpackSnapshot` restores the exact `Snapshot` shape, so nothing downstream of `decodeServer` knows. Kits are never
 * rounded: client prediction times shots and steps with them.
 */
type PackedPlayer = [id: string, x: number, y: number, vx: number, vy: number, aim: number, flags: number, gun: Gun, health: number, veh?: number, seat?: number]
type PackedGrenade = [id: number, by: string, x: number, y: number, z: number, vx: number, vy: number, vz: number, fuse: number]
type PackedClaymore = [id: number, by: string, x: number, y: number, aim: number, flags: number]
type PackedVehicle = [id: number, kind: VehicleKind, x: number, y: number, h: number, vx: number, vy: number, w: number, hp: number, seats: string[], steer: number, thr: number, flags: number]
type PackedKit = [id: string, label: string, gun: Gun | null, mag: number, reload: boolean, auto: boolean, cooldown: number, damage: number, melee: boolean, equip: Equip | null, equipCount: number, walk: number, run: number, regen: boolean]
type PackedYou = [health: number, mag: number, reloading: number, respawnIn: number, pick: Gun, equip: Equip, equipLeft: number, equipPick: Equip, kit: PackedKit]

export type PackedSnapshot = Omit<Snapshot, "players" | "grenades" | "claymores" | "vehicles" | "you"> & {
  P: PackedPlayer[]
  G: PackedGrenade[]
  C: PackedClaymore[]
  V?: PackedVehicle[]
  Y: PackedYou | null
}

const r1 = (v: number) => Math.round(v * 10) / 10
const r2 = (v: number) => Math.round(v * 100) / 100
const r3 = (v: number) => Math.round(v * 1000) / 1000

function packPlayer(p: PlayerView): PackedPlayer {
  const row: PackedPlayer = [p.id, r3(p.x), r3(p.y), r3(p.vx), r3(p.vy), r2(p.aim), (p.alive ? 1 : 0) | (p.bare ? 2 : 0), p.gun, r1(p.health)]
  if (p.veh) row.push(p.veh, p.seat ?? 0)
  return row
}

function unpackPlayer(r: PackedPlayer): PlayerView {
  const [id, x, y, vx, vy, aim, flags, gun, health, veh, seat] = r
  return { id, x, y, vx, vy, aim, alive: !!(flags & 1), gun, health, ...(flags & 2 ? { bare: true } : {}), ...(veh ? { veh, seat: seat ?? 0 } : {}) }
}

const packVehicle = (v: VehicleView): PackedVehicle =>
  [v.id, v.kind, r3(v.x), r3(v.y), r3(v.h), r3(v.vx), r3(v.vy), r3(v.w), r1(v.hp), v.seats, r2(v.steer), r2(v.thr), (v.wreck ? 1 : 0) | (v.horn ? 2 : 0) | (v.hb ? 4 : 0)]

function unpackVehicle(r: PackedVehicle): VehicleView {
  const [id, kind, x, y, h, vx, vy, w, hp, seats, steer, thr, flags] = r
  return { id, kind, x, y, h, vx, vy, w, hp, seats, steer, thr, ...(flags & 1 ? { wreck: 1 as const } : {}), ...(flags & 2 ? { horn: 1 as const } : {}), ...(flags & 4 ? { hb: 1 as const } : {}) }
}

const packKit = (k: Kit): PackedKit => [k.id, k.label, k.gun, k.mag, k.reload, k.auto, k.cooldown, k.damage, k.melee, k.equip, k.equipCount, k.walk, k.run, k.regen]
function unpackKit(r: PackedKit): Kit {
  const [id, label, gun, mag, reload, auto, cooldown, damage, melee, equip, equipCount, walk, run, regen] = r
  return { id, label, gun, mag, reload, auto, cooldown, damage, melee, equip, equipCount, walk, run, regen }
}

export function packSnapshot(s: Snapshot): PackedSnapshot {
  const { players, grenades, claymores, vehicles, you, ...rest } = s
  return {
    ...rest,
    t: r3(s.t),
    left: r2(s.left),
    P: players.map(packPlayer),
    G: grenades.map((g) => [g.id, g.by, r2(g.x), r2(g.y), r2(g.z), r2(g.vx), r2(g.vy), r2(g.vz), r2(g.fuse)]),
    C: claymores.map((c) => [c.id, c.by, r2(c.x), r2(c.y), r2(c.aim), (c.armed ? 1 : 0) | (c.tripped ? 2 : 0)]),
    ...(vehicles ? { V: vehicles.map(packVehicle) } : {}),
    Y: you ? [r1(you.health), you.mag, r2(you.reloading), r2(you.respawnIn), you.pick, you.equip, you.equipLeft, you.equipPick, packKit(you.kit)] : null,
  }
}

export function unpackSnapshot(p: PackedSnapshot): Snapshot {
  const { P, G, C, V, Y, ...rest } = p
  const s: Snapshot = {
    ...rest,
    players: P.map(unpackPlayer),
    grenades: G.map(([id, by, x, y, z, vx, vy, vz, fuse]): GrenadeView => ({ id, by, x, y, z, vx, vy, vz, fuse })),
    claymores: C.map(([id, by, x, y, aim, flags]): ClaymoreView => ({ id, by, x, y, aim, armed: !!(flags & 1), tripped: !!(flags & 2) })),
    you: Y ? { health: Y[0], mag: Y[1], reloading: Y[2], respawnIn: Y[3], pick: Y[4], equip: Y[5], equipLeft: Y[6], equipPick: Y[7], kit: unpackKit(Y[8]) } : null,
  }
  if (V) s.vehicles = V.map(unpackVehicle)
  return s
}
