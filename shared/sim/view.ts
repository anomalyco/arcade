import type { Equip, Gun } from "../config"
import type { Phase, World } from "./world"

export type PlayerView = { id: string; x: number; y: number; vx: number; vy: number; aim: number; alive: boolean; gun: Gun; health: number }
export type GrenadeView = { id: number; by: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; fuse: number }
export type ClaymoreView = { id: number; by: string; x: number; y: number; aim: number; armed: boolean; tripped: boolean }
export type RosterRow = { id: string; name: string; human: boolean; kills: number; deaths: number }

export type Snapshot = {
  type: "snap"
  tick: number
  t: number
  /** Last input seq applied for you. */
  ack: number
  phase: Phase
  /** Seconds left in the match or the end screen. */
  left: number
  /** Seed of the office floor. */
  map: number
  players: PlayerView[]
  /** Everyone sees every frag and claymore. */
  grenades: GrenadeView[]
  claymores: ClaymoreView[]
  you: { health: number; mag: number; reloading: number; respawnIn: number; pick: Gun; equip: Equip; equipLeft: number; equipPick: Equip } | null
}

export function buildSnapshot(world: World, viewerId: string): Snapshot {
  const me = world.players.get(viewerId)
  return {
    type: "snap",
    tick: world.tick,
    t: world.time,
    ack: me?.ack ?? 0,
    phase: world.phase,
    left: Math.max(0, world.phaseEnd - world.time),
    map: world.map.seed,
    players: world.order.map((id) => {
      const p = world.players.get(id)!
      return { id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, aim: p.aim, alive: p.alive, gun: p.gun, health: p.health }
    }),
    grenades: world.grenades.map((g) => ({ id: g.id, by: g.by, x: g.x, y: g.y, z: g.z, vx: g.vx, vy: g.vy, vz: g.vz, fuse: Math.max(0, g.at - world.time) })),
    claymores: world.claymores.map((c) => ({ id: c.id, by: c.by, x: c.x, y: c.y, aim: c.aim, armed: world.time >= c.armAt, tripped: c.blowAt > 0 })),
    you: me ? { health: me.health, mag: me.mag, reloading: me.reloadUntil > 0 ? Math.max(0, me.reloadUntil - world.time) : 0, respawnIn: me.alive ? 0 : Math.max(0, me.respawnAt - world.time), pick: me.pick, equip: me.equip, equipLeft: me.equipLeft, equipPick: me.equipPick } : null,
  }
}

export function rosterOf(world: World): RosterRow[] {
  return world.order.map((id) => {
    const p = world.players.get(id)!
    return { id, name: p.name, human: p.human, kills: p.kills, deaths: p.deaths }
  })
}
