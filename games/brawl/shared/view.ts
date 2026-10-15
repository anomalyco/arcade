import { type AbilityView, abilityView, cooldowns, movement } from "@arcade/kit/sim/abilities"
import type { Phase, World } from "./world"

/** Bit flags on a fighter view. */
export const F = { alive: 1, falling: 2, invuln: 4, launched: 8, carried: 16, carrying: 32, dashing: 64, stunned: 128, rooted: 256, slide: 512, shield: 1024, slow: 2048, haste: 4096 } as const

/** A fighter: id, character, position, velocity, aim, damage %, stocks, flags, and its cast [slot, seconds since start]. */
export type FighterView = { i: string; c: string; x: number; y: number; vx: number; vy: number; a: number; d: number; s: number; f: number; k?: [number, number] }
/** A prop: [id, kind, x, y, heading, height]. Broken and fallen props drop out. */
export type PropView = [number, string, number, number, number, number]
export type RosterRow = { id: string; name: string; human: boolean; char: string; pick: string; ready: boolean; kos: number; falls: number; stocks: number; slot: number; host?: true }

export type Snapshot = {
  type: "snap"
  tick: number
  t: number
  ack: number
  phase: Phase
  /** Seconds left in the phase, and until the round's countdown ends. */
  left: number
  go: number
  round: number
  winner: string
  f: FighterView[]
  p: PropView[]
  ab: AbilityView
  /** Your cooldowns (seconds per slot) and how statuses scale your movement, for prediction and the HUD. */
  you: { cd: number[]; speed: number; accel: number; move: boolean } | null
}

const r2 = (v: number) => Math.round(v * 100) / 100
const r3 = (v: number) => Math.round(v * 1000) / 1000

export function snapshotEntities(w: World): Pick<Snapshot, "f" | "p" | "ab"> {
  const now = w.time
  return {
    f: w.actors.map((f) => {
      const has = (k: string) => f.ab.status.some((s) => s.kind === k && s.until > now)
      const flags =
        (f.alive ? F.alive : 0) | (f.fallAt ? F.falling : 0) | (now < f.invulnUntil ? F.invuln : 0) | (now < f.launchUntil ? F.launched : 0) |
        (f.ab.carriedBy ? F.carried : 0) | (f.ab.carry ? F.carrying : 0) | (f.ab.dash ? F.dashing : 0) | (has("stun") ? F.stunned : 0) |
        (has("root") ? F.rooted : 0) | (has("slide") ? F.slide : 0) | (has("shield") ? F.shield : 0) | (has("slow") ? F.slow : 0) | (has("haste") ? F.haste : 0)
      const c = f.ab.cast
      return { i: f.id, c: f.char, x: r3(f.x), y: r3(f.y), vx: r3(f.vx), vy: r3(f.vy), a: r3(f.aim), d: Math.round(f.damage), s: f.stocks, f: flags, ...(c ? { k: [c.slot, r2(now - c.at)] as [number, number] } : {}) }
    }),
    p: w.props.list.filter((p) => p.alive).map((p) => [p.id, p.kind, r3(p.x), r3(p.y), r3(p.h), r2(p.z)]),
    ab: abilityView(w.abilitySystem, now),
  }
}

export function buildSnapshot(w: World, viewer: string, entities = snapshotEntities(w)): Snapshot {
  const me = w.players.get(viewer)
  const mv = me ? movement(me, w.def(me).abilities, w.time) : null
  return {
    type: "snap",
    tick: w.tick,
    t: r3(w.time),
    ack: me?.ack ?? 0,
    phase: w.phase,
    left: r2(Math.max(0, w.phaseEnd - w.time)),
    go: r2(Math.max(0, w.goAt - w.time)),
    round: w.round,
    winner: w.winner,
    ...entities,
    you: me && mv ? { cd: cooldowns(me, w.time), speed: r2(mv.speed), accel: r2(mv.accel), move: mv.canMove && w.time >= me.launchUntil && !me.fallAt } : null,
  }
}

export function rosterOf(w: World): RosterRow[] {
  return w.actors.map((f) => ({ id: f.id, name: f.name, human: f.human, char: f.char, pick: f.pick, ready: f.ready, kos: f.kos, falls: f.falls, stocks: f.stocks, slot: f.slot, ...(w.host === f.id ? { host: true as const } : {}) }))
}
