import { FIRE_EXPOSE_SECONDS, MINE_ARM, WEAPONS, type Gadget, type Mode, type Stance, type Weapon } from "../config"
import type { Award, Phase, Player, SimEvent, Stats, World } from "./world"

export type RosterRow = {
  id: string
  name: string
  team: number
  key: string
  human: boolean
  connected: boolean
  alive: boolean
  inRound: boolean
  stats: Stats
}

export type YouView = {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  alive: boolean
  spectator: boolean
  stance: Stance
  weapon: Weapon
  mag: number
  reserve: number
  reloadLeft: number
  windupLeft: number
  cooldownLeft: number
  gadgets: { kind: Gadget; left: number }[]
  /** 0..1 exposure for the HUD meter. */
  exposure: number
  lit: boolean
  noise: Player["noise"]
  mines: { x: number; y: number; armed: boolean }[]
}

export type OtherView = { id: string; name: string; team: number; key: string; x: number; y: number; aim: number; fresh: boolean; moving: boolean }

export type LightView = { id: number; kind: "lamp" | "flare"; x: number; y: number; r: number; power: number; color: readonly [number, number, number]; failing: boolean; broken: boolean }

export type ProjView = { kind: "flare" | "decoy"; x: number; y: number; left: number; landed: boolean }

export type Snapshot = {
  type: "snap"
  tick: number
  t: number
  ack: number
  phase: Phase
  /** Seconds left in the phase; the round timer while live. */
  left: number
  roundNo: number
  rounds: number
  mode: Mode
  map: string
  wins: Record<string, number>
  host: string
  lastWinner: string | null
  you: YouView | null
  others: OtherView[]
  lights: LightView[]
  doors: { id: number; open: boolean }[]
  projectiles: ProjView[]
  bolts: { x: number; y: number }[]
  roster: RosterRow[]
  awards: Award[]
}

/**
 * The visibility filter. Hidden players never leave the server: only the viewer's own state and the enemies (and
 * friends) the viewer can see are included. Dead viewers and spectators see no living players at all.
 */
export function buildSnapshot(world: World, viewerId: string, ack: number): Snapshot {
  const me = world.players.get(viewerId) ?? null
  const others: OtherView[] = []
  if (me) {
    for (const q of world.players.values()) {
      if (!world.canSee(me, q)) continue
      others.push({ id: q.id, name: q.name, team: q.team, key: world.teamKey(q), x: q.x, y: q.y, aim: q.aim, fresh: world.time - q.lastFireAt < FIRE_EXPOSE_SECONDS, moving: Math.hypot(q.vx, q.vy) > 0.3 })
    }
  }
  const lights: LightView[] = []
  for (const l of world.lights()) {
    const lamp = l.kind === "lamp" ? world.lamps.find((x) => x.id === l.id) : undefined
    lights.push({ id: l.id, kind: l.kind, x: l.x, y: l.y, r: l.radius, power: l.power, color: l.color, failing: lamp ? lamp.failAt > 0 : false, broken: lamp ? lamp.broken : false })
  }
  const projectiles: ProjView[] = world.things
    .filter((t) => t.kind !== "mine" && world.time < t.endAt)
    .map((t) => ({ kind: t.kind === "flare" ? "flare" : "decoy", x: t.x, y: t.y, left: Math.max(0, t.landAt - world.time), landed: world.time >= t.landAt }))
  const mines = world.things.filter((t) => t.kind === "mine" && t.owner === viewerId && t.pings === 0).map((t) => ({ x: t.x, y: t.y, armed: world.time >= t.landAt + MINE_ARM }))
  const you = me ? youView(world, me, mines) : null
  const roster: RosterRow[] = world.order.map((id) => {
    const p = world.players.get(id)!
    return { id: p.id, name: p.name, team: p.team, key: world.teamKey(p), human: p.human, connected: p.connected, alive: p.alive, inRound: p.inRound, stats: p.stats }
  })
  const left = world.phase === "live" ? world.roundEnd - world.time : world.phase === "lobby" ? 0 : Math.max(0, world.phaseEnd - world.time)
  return {
    type: "snap",
    tick: world.tick,
    t: world.time,
    ack,
    phase: world.phase,
    left: Math.max(0, left),
    roundNo: world.roundNo,
    rounds: world.rounds,
    mode: world.mode,
    map: world.map.id,
    wins: world.wins,
    host: world.host,
    lastWinner: world.lastWinner,
    you,
    others,
    lights,
    doors: world.doors.map((d) => ({ id: d.id, open: d.open })),
    projectiles,
    bolts: world.bolts.map((b) => ({ x: b.x, y: b.y })),
    roster,
    awards: world.phase === "match" ? world.awards() : [],
  }
}

function youView(world: World, p: Player, mines: YouView["mines"]): YouView {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    aim: p.aim,
    alive: p.alive,
    spectator: p.spectator || (!p.inRound && world.phase === "live"),
    stance: p.stance,
    weapon: p.loadout.weapon,
    mag: p.mag,
    reserve: p.reserve,
    reloadLeft: p.reloadUntil > 0 ? Math.max(0, p.reloadUntil - world.time) : 0,
    windupLeft: p.windup ? Math.max(0, p.windup.until - world.time) : 0,
    cooldownLeft: Math.max(0, p.cooldownUntil - world.time),
    gadgets: [
      { kind: p.loadout.gadgets[0], left: p.gadgets[0] },
      { kind: p.loadout.gadgets[1], left: p.gadgets[1] },
    ],
    exposure: world.exposureOf(p),
    lit: p.lit,
    noise: p.noise,
    mines,
  }
}

/** Events a viewer should hear. Ripples and kills are public. Tracers and killcams are addressed. */
export function eventsFor(events: readonly SimEvent[], viewerId: string): SimEvent[] {
  return events.filter((e) => !("to" in e) || e.to.includes(viewerId))
}
