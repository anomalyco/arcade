import type { Gun } from "../config"
import type { Phase, World } from "./world"

export type PlayerView = { id: string; x: number; y: number; vx: number; vy: number; aim: number; alive: boolean; gun: Gun; health: number }
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
  you: { health: number; mag: number; reloading: number; respawnIn: number; pick: Gun } | null
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
    you: me ? { health: me.health, mag: me.mag, reloading: me.reloadUntil > 0 ? Math.max(0, me.reloadUntil - world.time) : 0, respawnIn: me.alive ? 0 : Math.max(0, me.respawnAt - world.time), pick: me.pick } : null,
  }
}

export function rosterOf(world: World): RosterRow[] {
  return world.order.map((id) => {
    const p = world.players.get(id)!
    return { id, name: p.name, human: p.human, kills: p.kills, deaths: p.deaths }
  })
}
