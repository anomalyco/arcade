import { MINE_ARM, type Gadget, type Mode, type Stance, type Weapon } from "../config"
import type { Noise, Phase, Player, SimEvent, Stats, World } from "./world"

export type RosterRow = { id: string; name: string; team: number; key: string; human: boolean; connected: boolean; alive: boolean; inRound: boolean; look: number; stats: Stats }

export type YouView = {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  alive: boolean
  inRound: boolean
  stance: Stance
  weapon: Weapon
  mag: number
  reserve: number
  reloadLeft: number
  windupLeft: number
  gadgets: [{ kind: Gadget; left: number }, { kind: Gadget; left: number }]
  /** 0..1, for your visibility meter. */
  exposure: number
  lit: boolean
  seen: boolean
  noise: Noise
  mines: { x: number; y: number; armed: boolean }[]
}

export type OtherView = { id: string; x: number; y: number; aim: number; stance: Stance; moving: boolean; windup: boolean; team: number; key: string; look: number; weapon: Weapon }

export type ThrownView = { id: number; kind: "flare" | "decoy"; sx: number; sy: number; x: number; y: number; thrownAt: number; landAt: number; endAt: number }

export type Snapshot = {
  type: "snap"
  tick: number
  t: number
  ack: number
  phase: Phase
  /** Seconds left: the round clock while live, the phase timer otherwise. */
  left: number
  roundNo: number
  rounds: number
  mode: Mode
  /** Seed of the current office floor; clients generate the same floor from it. */
  map: number
  wins: Record<string, number>
  host: string
  lastWinner: string | null
  you: YouView | null
  others: OtherView[]
  /** Per map light: [flags (1 broken, 2 off), dimUntil, failAt]. Power is derived from these and the clock. */
  lamps: number[]
  doors: number[]
  glass: number[]
  thrown: ThrownView[]
  bolts: { x: number; y: number }[]
  corpses: { id: string; x: number; y: number; team: number; key: string; aim: number }[]
}

/**
 * The visibility filter. A snapshot carries your own state, teammates, and the enemies you can see under the rules
 * in World.sees. Hidden enemies never leave the server, not even dimmed. The dead see their living teammates only.
 */
export function buildSnapshot(world: World, viewerId: string): Snapshot {
  const me = world.players.get(viewerId) ?? null
  const others: OtherView[] = []
  if (me) {
    for (const q of world.players.values()) {
      if (q.id === me.id || !q.alive) continue
      const visible = me.alive ? world.sees(me, q) : world.mode === "tdm" && me.inRound && !world.enemy(me, q)
      if (!visible) continue
      others.push({
        id: q.id,
        x: q.x,
        y: q.y,
        aim: q.aim,
        stance: q.stance,
        moving: Math.hypot(q.vx, q.vy) > 0.3,
        windup: q.windupUntil > 0,
        team: q.team,
        key: world.keyOf(q),
        look: q.loadout.look,
        weapon: q.loadout.weapon,
      })
    }
  }
  const lamps: number[] = []
  for (const s of world.level.lamps) lamps.push((s.broken ? 1 : 0) | (s.off ? 2 : 0), s.dimUntil, s.failAt)
  const left = world.phase === "live" ? world.roundEnd - world.time : world.phase === "lobby" ? 0 : world.phaseEnd - world.time
  return {
    type: "snap",
    tick: world.tick,
    t: world.time,
    ack: me?.ack ?? 0,
    phase: world.phase,
    left: Math.max(0, left),
    roundNo: world.roundNo,
    rounds: world.rounds,
    mode: world.mode,
    map: world.map.seed,
    wins: world.wins,
    host: world.host,
    lastWinner: world.lastWinner,
    you: me ? youView(world, me) : null,
    others,
    lamps,
    doors: world.level.doorsOpen.map((o) => (o ? 1 : 0)),
    glass: world.level.glassBroken.map((b) => (b ? 1 : 0)),
    thrown: world.things
      .filter((t): t is typeof t & { kind: "flare" | "decoy" } => t.kind !== "mine")
      .map((t) => ({ id: t.id, kind: t.kind, sx: t.sx, sy: t.sy, x: t.x, y: t.y, thrownAt: t.thrownAt, landAt: t.landAt, endAt: t.endAt })),
    bolts: world.bolts.map((b) => ({ x: b.x, y: b.y })),
    corpses: world.corpses.map((c) => ({ ...c })),
  }
}

function youView(world: World, p: Player): YouView {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    aim: p.aim,
    alive: p.alive,
    inRound: p.inRound,
    stance: p.stance,
    weapon: p.loadout.weapon,
    mag: p.mag,
    reserve: p.reserve,
    reloadLeft: p.reloadUntil > 0 ? Math.max(0, p.reloadUntil - world.time) : 0,
    windupLeft: p.windupUntil > 0 ? Math.max(0, p.windupUntil - world.time) : 0,
    gadgets: [
      { kind: p.loadout.gadgets[0], left: p.gadgets[0] },
      { kind: p.loadout.gadgets[1], left: p.gadgets[1] },
    ],
    exposure: world.exposureOf(p),
    lit: p.lit,
    seen: p.seen,
    noise: p.noise,
    mines: world.things.filter((t) => t.kind === "mine" && t.key === world.keyOf(p)).map((t) => ({ x: t.x, y: t.y, armed: world.time >= t.landAt + MINE_ARM && world.time >= t.disabledUntil })),
  }
}

export function rosterOf(world: World): RosterRow[] {
  return world.order.map((id) => {
    const p = world.players.get(id)!
    return { id: p.id, name: p.name, team: p.team, key: world.keyOf(p), human: p.human, connected: p.connected, alive: p.alive, inRound: p.inRound, look: p.loadout.look, stats: { ...p.stats } }
  })
}

/** Events a viewer may receive. Rings, kills and round results are public; tracers and killcams are addressed. */
export function eventsFor(events: readonly SimEvent[], viewerId: string): SimEvent[] {
  return events.filter((e) => !("to" in e) || e.to.includes(viewerId))
}
