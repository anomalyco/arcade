import { angleDiff, clearLine, distToRect, inRect, pushOut, rayRect, type Rect } from "@arcade/kit/sim/geom"
import type { AIAgent, AIState } from "../ai"
import type { BodiesState } from "../bodies/runtime"
import { dayCycle } from "../day-cycle"
import type { DeathState } from "../death/rules"
import { EXTERIOR_VEHICLE_COLLIDERS, inBuildingFootprint, sightRects, type Building } from "../map"
import type { OutbreakSim } from "../sim-types"
import { mix32 } from "../specials/kinds"
import { strikesBetween } from "../weather/lightning"
import { weatherTuning } from "../weather/schedule"
import {
  ACT_CLIMB_CAR,
  ACT_CLIMB_FENCE,
  ACT_FEED,
  ACT_FLINCH,
  ACT_FOLLOW,
  ACT_FREEZE,
  ACT_GIVE_UP,
  ACT_HERD,
  ACT_JOSTLED,
  ACT_LIGHT,
  ACT_LISTEN,
  ACT_NONE,
  ACT_PAUSE,
  ACT_PEER,
  ACT_REST_SIT,
  ACT_REST_SLUMP,
  ACT_REST_STAND,
  ACT_ROUSE,
  ACT_SEEK,
  ACT_SNAGGED,
  ACT_SNIFF,
  ACTIVITY_NAMES,
  attentionOf,
  holdsStill,
  isClimbing,
  isResting,
  type ZombieAttention,
} from "./activities"
import { zombiePersonality, type ZombiePersonality } from "./personality"
import { behaviourOn, DEFAULT_BEHAVIOUR_TUNING, type BehaviourTuning } from "./tuning"

/**
 * The behaviour layer's rules (AR-91). It never replaces the crowd's state machine (`@arcade/kit/sim/ai`): before the
 * crowd steps it gives each zombie an activity, a speed and senses multiplier for the tick (through
 * `ai.behaviour`), and nudges wander points and targets; after the crowd steps it reads what happened (who noticed,
 * who heard, who gave up) and reacts. Everything is a pure function of the sim, the seeds and the clock, kept in
 * plain JSON (`BehaviourState`), so offline, the room and bot rollouts agree. Only the activity codes go on the wire.
 */

export type ZombieMind = {
  /** The seed this mind was made for; a new seed is a new zombie. */
  seed: number
  act: number
  /** Sim time the activity ends. */
  until: number
  /** Where the activity points: the sound, the body, the window, the place it is going. */
  ax: number
  ay: number
  /** The crowd state after the last step. */
  last: AIState
  /** The last noise it turned to. */
  heard: number
  /** When it last had a survivor in sight (−1 never), where they were and which way they were going. */
  memT: number
  memX: number
  memY: number
  memVx: number
  memVy: number
  /** The building the survivor was in when last seen ("" outside). */
  memHouse: string
  /** Search rounds left before it gives up (−1 until it first loses you). */
  rounds: number
  /** The search point is a window or doorway to look in at. */
  peer: boolean
  /** No flinch, pause or feed again before this time. */
  cool: number
  /** Another zombie noticed something: follow at `followAt` to (fx, fy). 0 when nothing is pending. */
  followAt: number
  fx: number
  fy: number
  /** The herd leader it walks with (0 none) and when it last looked for one. */
  leader: number
  leaderAt: number
  /** The body it is going to or feeding on (store id or `fallen:` id), "" none, and where it will crouch. */
  food: string
  foodX: number
  foodY: number
}

export type BehaviourState = {
  minds: Record<number, ZombieMind>
  tuning: BehaviourTuning
  /** Sim time of the last step (for lightning strikes passed since). */
  lastTime: number
  /** Activities started, by name (harness, tests, the Lab readout). */
  started: Record<string, number>
}

export function createBehaviourState(): BehaviourState {
  return { minds: {}, tuning: DEFAULT_BEHAVIOUR_TUNING, lastTime: -1, started: {} }
}

export function behaviourOf(sim: OutbreakSim): BehaviourState | undefined {
  return sim.getFeatureState<BehaviourState>("behaviour")
}

/** What a zombie is doing now (an `ACT_*` code), for presentation and other features. */
export function zombieActivity(sim: OutbreakSim, id: number): number {
  return behaviourOf(sim)?.minds[id]?.act ?? ACT_NONE
}

/** The hook other features use: "noticed", "searching", "lost interest", "resting", "feeding", "following" or "none". */
export function zombieAttention(sim: OutbreakSim, id: number): ZombieAttention {
  return attentionOf(zombieActivity(sim, id))
}

const h01 = (seed: number, a: number, b = 0) =>
  mix32((seed ^ Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0) / 4294967296

/**
 * A co-op client's minds: just the replicated activity codes (sorted id/code pairs from the `behaviour` section).
 * The host runs the rules; the client only needs to know what each zombie is doing to pose and label it.
 */
export function applyReplicatedActivities(st: BehaviourState, acts: readonly number[]): void {
  for (const k in st.minds) delete st.minds[k]
  for (let i = 0; i < acts.length; i += 2) {
    const m = freshMind(REPLICA)
    m.act = acts[i + 1]!
    st.minds[acts[i]!] = m
  }
}

const REPLICA = { seed: 0, x: 0, y: 0, state: "wander", lastHeardNoiseId: -1 } as const

export function freshMind(a: Pick<AIAgent, "seed" | "x" | "y" | "state" | "lastHeardNoiseId">): ZombieMind {
  return {
    seed: a.seed >>> 0,
    act: ACT_NONE,
    until: 0,
    ax: a.x,
    ay: a.y,
    last: a.state,
    heard: a.lastHeardNoiseId,
    memT: -1,
    memX: 0,
    memY: 0,
    memVx: 0,
    memVy: 0,
    memHouse: "",
    rounds: -1,
    peer: false,
    cool: 0,
    followAt: 0,
    fx: 0,
    fy: 0,
    leader: 0,
    leaderAt: -1,
    food: "",
    foodX: 0,
    foodY: 0,
  }
}

const personality: ZombiePersonality = zombiePersonality(0)
const personalityOf = (a: AIAgent) => zombiePersonality(a.seed, personality)

function start(st: BehaviourState, m: ZombieMind, act: number, until: number, ax: number, ay: number): void {
  m.act = act
  m.until = until
  m.ax = ax
  m.ay = ay
  const name = ACTIVITY_NAMES[act] ?? String(act)
  st.started[name] = (st.started[name] ?? 0) + 1
}

/** Held in place by another feature (a dormant Lurker, a habit loop): the behaviour layer leaves it alone. */
const pinned = (a: AIAgent) => a.speedScale <= 0.01

const engaged = (s: AIState) => s === "alert" || s === "chase" || s === "bash"
const stunned = (s: AIState) => s === "stagger" || s === "knockdown" || s === "dead" || s === "crawler"

function turnToward(a: AIAgent, x: number, y: number, rate: number): void {
  if (Math.hypot(x - a.x, y - a.y) < 0.05) return
  const want = Math.atan2(y - a.y, x - a.x)
  a.aim += Math.max(-rate, Math.min(rate, angleDiff(want, a.aim)))
}

function nearestSurvivor(sim: OutbreakSim, x: number, y: number): { d: number; i: number } {
  let d = Infinity
  let i = -1
  for (let k = 0; k < sim.slots.length; k++) {
    const s = sim.slots[k]!.survivor
    const dd = Math.hypot(s.x - x, s.y - y)
    if (dd < d) {
      d = dd
      i = k
    }
  }
  return { d, i }
}

function buildingAt(sim: OutbreakSim, x: number, y: number): Building | undefined {
  for (const b of sim.town.buildings) if (inBuildingFootprint(b, x, y)) return b
  return undefined
}

/** A spot `r` metres out from (x, y) on a free side, clear of walls and furniture; null when there is none. */
function freeSpotNear(sim: OutbreakSim, x: number, y: number, r: number, salt: number): { x: number; y: number } | null {
  for (let k = 0; k < 6; k++) {
    const ang = salt + k * 1.047
    const p = { x: x + Math.cos(ang) * r, y: y + Math.sin(ang) * r }
    const q = { x: p.x, y: p.y }
    pushOut(q, 0.3, sim.solids)
    if (Math.hypot(q.x - p.x, q.y - p.y) < 0.05 && sim.ai.nav.walkable(q)) return q
  }
  return null
}

type Food = { id: string; x: number; y: number }
function foodSources(sim: OutbreakSim, out: Food[]): Food[] {
  out.length = 0
  const bodies = sim.getFeatureState<BodiesState>("bodies")
  if (bodies) {
    for (const b of bodies.sites) {
      const store = sim.progression.ledger.stores.get(b.id)
      if (store?.counts.rise) continue
      out.push({ id: b.id, x: b.x, y: b.y })
    }
  }
  const death = sim.getFeatureState<DeathState>("death")
  if (death) for (const b of death.bodies) out.push({ id: `fallen:${b.index}:${b.n}`, x: b.x, y: b.y })
  return out
}

const foodScratch: Food[] = []
const feeders = new Map<string, number>()

// ── Before the crowd steps ─────────────────────────────────────────────────────────────────────────────────────

export function stepBehaviourBefore(
  sim: OutbreakSim,
  st: BehaviourState,
  t: BehaviourTuning,
  features?: Readonly<Record<string, Record<string, unknown>>>,
): void {
  st.tuning = t
  const ai = sim.ai
  if (!behaviourOn(t)) {
    ai.behaviour.speed = undefined
    ai.behaviour.senses = undefined
    for (const k in st.minds) delete st.minds[k]
    st.lastTime = sim.time
    return
  }
  const minds = st.minds
  ai.behaviour.speed = (a) => {
    const m = minds[a.id]
    if (!m) return 1
    const act = m.act
    if (holdsStill(act)) return 0
    if (act === ACT_FLINCH) return 0.3
    if (act === ACT_HERD) return 0.82
    if (act === ACT_JOSTLED) return 0.7
    return 1
  }
  ai.behaviour.senses = (a) => {
    const m = minds[a.id]
    if (!m) return 1
    const act = m.act
    if (act === ACT_REST_SIT || act === ACT_REST_SLUMP) return 0.42
    if (act === ACT_REST_STAND) return 0.6
    if (act === ACT_FEED) return 0.5
    if (act === ACT_LISTEN || act === ACT_PEER) return 1.12
    return 1
  }

  const time = sim.time
  const dt = Math.max(1e-4, time - (st.lastTime < 0 ? time - 1 / 60 : st.lastTime))
  const darkness = dayCycle(sim.hour).darkness
  const agents = ai.agents

  // Lightning: every strike since the last step freezes the dead out in the open for a beat.
  let flash = 0
  if (t.zbLightning > 0 && st.lastTime >= 0) {
    const weather = weatherTuning(features)
    for (const s of strikesBetween(sim.town.seed, st.lastTime, time, sim.hour, weather)) flash = Math.max(flash, s.power)
  }
  st.lastTime = time

  feeders.clear()
  for (const k in minds) {
    const m = minds[k]!
    if (m.act === ACT_FEED && m.food) feeders.set(m.food, (feeders.get(m.food) ?? 0) + 1)
  }
  let food: Food[] | null = null

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!
    if (a.state === "dead") {
      if (minds[a.id]) delete minds[a.id]
      continue
    }
    let m = minds[a.id]
    if (!m || m.seed !== a.seed >>> 0) m = minds[a.id] = freshMind(a)
    if (pinned(a) || stunned(a.state)) {
      if (m.act !== ACT_NONE && !isClimbing(m.act)) m.act = ACT_NONE
      continue
    }
    const p = personalityOf(a)

    // ── Ending what it was doing ──
    if (m.act !== ACT_NONE) {
      const act = m.act
      if (isClimbing(act)) {
        if (!a.clamberWindowId) m.act = ACT_NONE
      } else if (isResting(act) || act === ACT_FEED) {
        // Disturbed (it heard or saw something, or was sent somewhere), or it is getting dark: it gets up.
        const restless = isResting(act) && darkness > 0.38 + 0.35 * p.torpor
        if (a.state !== "wander" || a.awareness >= 0.22 || restless || time >= m.until) {
          if (act === ACT_FEED) m.cool = time + 6
          start(st, m, ACT_ROUSE, time + (act === ACT_FEED ? 0.55 : 0.75 + 0.5 * (1 - p.freshness)), a.x, a.y)
          m.food = ""
        }
      } else if (act === ACT_SEEK || act === ACT_FOLLOW || act === ACT_LIGHT) {
        if (act === ACT_SEEK && a.state === "search") {
          // Arrived where it last had you: sniff the ground, or look in at the window.
          const hold = (m.peer ? 2.6 : 1.6) * (0.7 + 0.6 * p.persistence)
          start(st, m, m.peer ? ACT_PEER : ACT_SNIFF, time + hold, m.ax, m.ay)
        } else if (act === ACT_SEEK && (a.state === "wander" || (a.state === "investigate" && a.stateTime > 14))) {
          // It never got there (or lost the trail on the way): count it as a round searched where it stands.
          m.act = ACT_NONE
          a.state = "search"
          a.stateTime = 0
          a.timer = 0.4
          a.targetX = a.x
          a.targetY = a.y
        } else if (act === ACT_LIGHT ? a.state !== "wander" || Math.hypot(a.wanderX - m.ax, a.wanderY - m.ay) > 3.6 : a.state !== "investigate" || a.stateTime > 14) {
          m.act = ACT_NONE
        } else if (act === ACT_LIGHT && Math.hypot(a.x - a.wanderX, a.y - a.wanderY) < 1.2) {
          start(st, m, ACT_PAUSE, time + 2.5 + 3 * p.curiosity, m.ax, m.ay)
        } else if (act !== ACT_LIGHT) {
          // Keep the trail warm: the crowd would give up on a cold one within seconds.
          a.awareness = Math.max(a.awareness, 0.3)
        }
      } else if (act === ACT_HERD) {
        const lead = m.leader && a.state === "wander" && darkness >= 0.45 ? agents.find((x) => x.id === m.leader) : undefined
        if (!lead || lead.state !== "wander" || Math.hypot(lead.x - a.x, lead.y - a.y) > 14) {
          m.act = ACT_NONE
          m.leader = 0
        } else {
          followLeader(a, lead)
          m.ax = lead.x
          m.ay = lead.y
        }
      } else if (time >= m.until || (act !== ACT_FLINCH && act !== ACT_FREEZE && engaged(a.state))) {
        m.act = ACT_NONE
      } else if (act === ACT_LISTEN || act === ACT_PEER || act === ACT_SNIFF || act === ACT_PAUSE) {
        if (act === ACT_PAUSE && m.ax !== a.x) turnToward(a, m.ax, m.ay, dt * 1.6)
        else if (act !== ACT_PAUSE) turnToward(a, m.ax, m.ay, dt * (act === ACT_LISTEN ? 3.2 + 2.5 * p.curiosity : 2.4))
      } else if (act === ACT_GIVE_UP) {
        // A slow turn away from where it lost you.
        turnToward(a, 2 * a.x - m.ax, 2 * a.y - m.ay, dt * 1.1)
      }
    }

    // ── Lightning ──
    if (flash > 0 && m.act !== ACT_FREEZE && !isClimbing(m.act) && a.state !== "bash" && !buildingAt(sim, a.x, a.y)) {
      const ns = nearestSurvivor(sim, a.x, a.y)
      // Not in the middle of a bite: a freeze never gifts an escape from arm's reach.
      if (ns.d > 1.6 && h01(a.seed, Math.floor(time * 2), 41) < 0.85 * Math.min(1, t.zbLightning)) {
        start(st, m, ACT_FREEZE, time + (0.35 + 0.35 * h01(a.seed, 42)) * Math.min(1.6, t.zbLightning) * flash, a.x, a.y)
      }
    }

    // ── A follow that was waiting on its reaction time ──
    if (m.followAt > 0 && time >= m.followAt) {
      m.followAt = 0
      if (a.state === "wander" && (m.act === ACT_NONE || m.act === ACT_PAUSE || m.act === ACT_HERD || m.act === ACT_LISTEN || isResting(m.act))) {
        const wasResting = isResting(m.act)
        a.state = "investigate"
        a.stateTime = 0
        a.repathAt = 0
        a.awareness = Math.max(a.awareness, 0.3)
        a.targetX = m.fx
        a.targetY = m.fy
        a.targetKind = "noise"
        if (wasResting) start(st, m, ACT_ROUSE, time + 0.5, a.x, a.y)
        else start(st, m, ACT_FOLLOW, time + 14, m.fx, m.fy)
      }
    }

    // ── The torch in its face ──
    if (t.zbLight > 0 && m.act !== ACT_FLINCH && time >= m.cool && !isClimbing(m.act) && a.state !== "bash") {
      for (const slot of sim.slots) {
        const s = slot.survivor
        if (!s.flashlightOn || s.flashlightOutput < 0.55) continue
        const d = Math.hypot(a.x - s.x, a.y - s.y)
        if (d > 4.5 * Math.min(1.5, t.zbLight) || d < 1.1) continue
        const toZ = Math.atan2(a.y - s.y, a.x - s.x)
        if (Math.abs(angleDiff(toZ, s.aim)) > 0.32) continue
        if (Math.abs(angleDiff(toZ + Math.PI, a.aim)) > 1.0) continue
        if (!seesThrough(sim, s.x, s.y, a.x, a.y)) continue
        start(st, m, ACT_FLINCH, time + 0.42, s.x, s.y)
        m.cool = time + 4.5
        a.aim += (h01(a.seed, Math.floor(time)) < 0.5 ? -1 : 1) * 0.35
        break
      }
    }

    // ── Climbing after you: fences and car bonnets ──
    if (t.zbClimb > 0 && a.state === "chase" && !a.clamberWindowId && m.act !== ACT_FREEZE && (a.id + ai.tick) % 3 === 0) {
      tryClimb(sim, st, a, m, p, t)
    }

    if (a.state !== "wander" || m.act !== ACT_NONE) continue

    const slot2 = Math.floor(time / 2)
    const nearest = nearestSurvivor(sim, a.x, a.y).d

    // ── Day: the dead go still ──
    if (t.zbRest > 0 && darkness < 0.3 && a.awareness < 0.05 && nearest > 12 && a.hordeId === undefined) {
      if (h01(a.seed, slot2, 51) < Math.min(0.9, (0.04 + 0.16 * p.torpor) * t.zbRest)) {
        let pose = p.restPose === 0 ? ACT_REST_SIT : p.restPose === 1 ? ACT_REST_SLUMP : ACT_REST_STAND
        if (pose === ACT_REST_SLUMP && !wallBeside(sim, a)) pose = ACT_REST_SIT
        start(st, m, pose, time + 1e6, a.x, a.y)
        continue
      }
    }

    // ── Bodies: the smell draws them, they feed until disturbed ──
    if (t.zbFeed > 0 && time >= m.cool && a.awareness < 0.1) {
      if (m.food) {
        const f = (food ??= foodSources(sim, foodScratch)).find((x) => x.id === m.food)
        if (!f) m.food = ""
        else if (Math.hypot(a.x - f.x, a.y - f.y) < 0.95) {
          if ((feeders.get(f.id) ?? 0) >= 2) {
            // Two are already at it: shouldered off.
            start(st, m, ACT_JOSTLED, time + 1.6, f.x, f.y)
            m.food = ""
            m.cool = time + 20
            const ang = Math.atan2(a.y - f.y, a.x - f.x)
            a.wanderX = a.x + Math.cos(ang) * 4
            a.wanderY = a.y + Math.sin(ang) * 4
            a.timer = 4
          } else {
            feeders.set(f.id, (feeders.get(f.id) ?? 0) + 1)
            a.aim = Math.atan2(f.y - a.y, f.x - a.x)
            start(st, m, ACT_FEED, time + (18 + 40 * p.hunger) * Math.min(1.6, t.zbFeed), f.x, f.y)
          }
          continue
        } else {
          a.wanderX = m.foodX
          a.wanderY = m.foodY
          a.timer = Math.max(a.timer, 2)
        }
      } else if (h01(a.seed, slot2, 61) < 0.35 * p.hunger * Math.min(1.5, t.zbFeed)) {
        food ??= foodSources(sim, foodScratch)
        const reach = 14 * Math.min(1.5, t.zbFeed)
        let best: Food | null = null
        let bd = reach
        for (const f of food) {
          const d = Math.hypot(a.x - f.x, a.y - f.y)
          if (d < bd && (feeders.get(f.id) ?? 0) < 3) {
            bd = d
            best = f
          }
        }
        if (best) {
          const spot = freeSpotNear(sim, best.x, best.y, 0.62, h01(a.seed, 62) * Math.PI * 2)
          if (spot) {
            m.food = best.id
            m.foodX = spot.x
            m.foodY = spot.y
            a.wanderX = spot.x
            a.wanderY = spot.y
            a.timer = Math.max(a.timer, 3)
          }
        }
      }
      if (m.food) continue
    }

    // ── Night: drawn to lamps; drifting herds ──
    const repick = a.timer <= 0.1 || Math.hypot(a.wanderX - a.x, a.wanderY - a.y) < 1.1
    if (darkness > 0.6 && repick) {
      if (t.zbLight > 0 && h01(a.seed, Math.floor(time / 3), 71) < 0.22 * p.curiosity * Math.min(1.5, t.zbLight)) {
        const lamp = nearestLamp(sim, a.x, a.y, 20)
        if (lamp) {
          const spot = freeSpotNear(sim, lamp.x, lamp.y, 1.2 + 1.3 * h01(a.seed, 72), h01(a.seed, Math.floor(time), 73) * 6.283)
          if (spot) {
            a.wanderX = spot.x
            a.wanderY = spot.y
            a.timer = 12
            start(st, m, ACT_LIGHT, time + 12, lamp.x, lamp.y)
            continue
          }
        }
      }
      if (t.zbHerds > 0 && p.leader && a.hordeId === undefined) {
        // A herd leader drifts on along the street it is on rather than milling about.
        driftOn(sim, a, time)
      }
    }
    if (t.zbHerds > 0 && darkness > 0.55 && !p.leader && a.hordeId === undefined && p.sociability > 1 - 0.65 * Math.min(1.5, t.zbHerds)) {
      if (time - m.leaderAt > 2 + (a.id % 7) * 0.25) {
        m.leaderAt = time
        m.leader = findLeader(agents, minds, a, 9)
      }
      const lead = m.leader ? agents.find((x) => x.id === m.leader) : undefined
      if (lead && lead.state === "wander" && Math.hypot(lead.x - a.x, lead.y - a.y) < 14) {
        followLeader(a, lead)
        start(st, m, ACT_HERD, time + 1e6, lead.x, lead.y)
        continue
      }
      m.leader = 0
    }

    // ── The shambler's pause ──
    if (t.zbPause > 0 && time >= m.cool && Math.hypot(a.vx, a.vy) > 0.2) {
      if (h01(a.seed, Math.floor(time / 3), 91) < 0.1 * Math.min(2, t.zbPause)) {
        const look = a.aim + (h01(a.seed, Math.floor(time), 92) - 0.5) * 2.2
        start(st, m, ACT_PAUSE, time + 0.8 + 1.5 * h01(a.seed, Math.floor(time), 93), a.x + Math.cos(look) * 3, a.y + Math.sin(look) * 3)
        m.cool = time + 5
      }
    }
  }
}

/** Walks with its herd: the leader's next point, a little to one side of it (its own spot in the herd). */
function followLeader(a: AIAgent, lead: AIAgent): void {
  const ang = h01(a.seed, 81) * Math.PI * 2
  const r = 1.1 + 1.3 * h01(a.seed, 82)
  a.wanderX = lead.wanderX + Math.cos(ang) * r
  a.wanderY = lead.wanderY + Math.sin(ang) * r
  a.timer = Math.max(a.timer, 1)
}

function wallBeside(sim: OutbreakSim, a: AIAgent): boolean {
  for (const r of sim.solids) if (distToRect(a.x, a.y, r) < 0.75) return true
  for (const r of sim.vehicleSolids) if (distToRect(a.x, a.y, r) < 0.75) return true
  return false
}

function nearestLamp(sim: OutbreakSim, x: number, y: number, reach: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null
  let bd = reach
  for (const l of sim.town.lamps) {
    if (l.kind !== "street" && l.kind !== "porch") continue
    const d = Math.hypot(l.x - x, l.y - y)
    if (d < bd && d > 2.5) {
      bd = d
      best = l
    }
  }
  return best
}

/** Picks a herd leader's next point straight on along its heading, out in the open. */
function driftOn(sim: OutbreakSim, a: AIAgent, time: number): void {
  for (let k = 0; k < 4; k++) {
    const turn = (h01(a.seed, Math.floor(time), 100 + k) - 0.5) * (0.6 + k * 0.5)
    const ang = a.aim + turn
    const dist = 9 + 6 * h01(a.seed, Math.floor(time), 110 + k)
    const x = a.x + Math.cos(ang) * dist
    const y = a.y + Math.sin(ang) * dist
    if (!sim.ai.nav.walkable({ x, y }) || buildingAt(sim, x, y)) continue
    if (!clearLine(a.x, a.y, x, y, sightRects(sim.town))) continue
    a.wanderX = x
    a.wanderY = y
    a.timer = 7 + 3 * h01(a.seed, Math.floor(time), 120)
    return
  }
}

function findLeader(agents: readonly AIAgent[], minds: Record<number, ZombieMind>, a: AIAgent, reach: number): number {
  let best = 0
  let bd = reach
  for (const o of agents) {
    if (o === a || o.state !== "wander" || o.hordeId !== undefined) continue
    const d = Math.hypot(o.x - a.x, o.y - a.y)
    if (d >= bd) continue
    if (!zombiePersonality(o.seed, leaderScratch).leader) continue
    const om = minds[o.id]
    if (om && isResting(om.act)) continue
    bd = d
    best = o.id
  }
  return best
}
const leaderScratch = zombiePersonality(0)

/**
 * A chasing zombie with a fence or a parked car between it and the survivor it is after, close: it climbs over
 * (slower than a survivor vaults, and sometimes it snags) instead of walking the long way round.
 */
function tryClimb(sim: OutbreakSim, st: BehaviourState, a: AIAgent, m: ZombieMind, p: ZombiePersonality, t: BehaviourTuning): void {
  const slot = sim.slot(a.focusId) ?? sim.slots[nearestSurvivor(sim, a.x, a.y).i]
  if (!slot) return
  const s = slot.survivor
  const tx = s.x
  const ty = s.y
  const dist = Math.hypot(tx - a.x, ty - a.y)
  if (dist > 10 || dist < 0.8 || (!a.seesTarget && dist > 4)) return
  const ux = (tx - a.x) / dist
  const uy = (ty - a.y) / dist
  let best: Rect | null = null
  let bestT = 1.45
  let car = false
  for (const b of sim.town.barriers) {
    if (b.kind !== "fence") continue
    const r = b.rect
    if (a.x < r[0] - 1.5 || a.x > r[2] + 1.5 || a.y < r[1] - 1.5 || a.y > r[3] + 1.5) continue
    const hit = rayRect(a.x, a.y, ux, uy, r, Math.min(dist, 1.45))
    if (hit < bestT) {
      bestT = hit
      best = r
      car = false
    }
  }
  if (dist < 8) {
    for (const r of sim.town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) {
      const w = r[2] - r[0]
      const h = r[3] - r[1]
      if (Math.min(w, h) > 2.4) continue
      if (a.x < r[0] - 1.5 || a.x > r[2] + 1.5 || a.y < r[1] - 1.5 || a.y > r[3] + 1.5) continue
      const hit = rayRect(a.x, a.y, ux, uy, r, Math.min(dist, 1.45))
      if (hit < bestT) {
        // Over the short side only (the bonnet's width), never along the car.
        const across = w < h ? Math.abs(ux) > 0.6 : Math.abs(uy) > 0.6
        if (!across) continue
        bestT = hit
        best = r
        car = true
      }
    }
  }
  if (!best) return
  // Straight across the obstacle's thin axis to a clear spot beyond it.
  const horizontal = best[2] - best[0] > best[3] - best[1]
  const to = horizontal
    ? { x: a.x + ux * 0.2, y: uy > 0 ? best[3] + 0.5 : best[1] - 0.5 }
    : { x: ux > 0 ? best[2] + 0.5 : best[0] - 0.5, y: a.y + uy * 0.2 }
  const probe = { x: to.x, y: to.y }
  pushOut(probe, 0.3, sim.solids)
  pushOut(probe, 0.3, sim.vehicleSolids)
  if (Math.hypot(probe.x - to.x, probe.y - to.y) > 0.08 || !sim.ai.nav.walkable(probe)) return
  for (const r of sim.town.barriers) if (r.kind !== "fence" && inRect(probe.x, probe.y, r.rect, 0.25)) return
  // Only the fence or the car is in the way: never through a wall, a closed door or into a building.
  if (buildingAt(sim, probe.x, probe.y) !== buildingAt(sim, a.x, a.y) || !seesThrough(sim, a.x, a.y, probe.x, probe.y)) return
  const snag = !car && h01(a.seed, Math.floor(sim.time), 131) < 0.16 * Math.min(2, t.zbClimb)
  const base = car ? 1.5 + 0.8 * (1 - p.freshness) : 1.05 + 0.75 * (1 - p.freshness)
  const duration = base + (snag ? 1.4 + 0.8 * h01(a.seed, 132) : 0)
  a.clamberWindowId = car ? "climb:car" : "climb:fence"
  a.clamberFromX = a.x
  a.clamberFromY = a.y
  a.clamberToX = probe.x
  a.clamberToY = probe.y
  a.clamberElapsed = 0
  a.clamberDuration = duration
  a.path.length = 0
  start(st, m, snag ? ACT_SNAGGED : car ? ACT_CLIMB_CAR : ACT_CLIMB_FENCE, sim.time + duration, best[0], best[1])
}

// ── After the crowd steps ──────────────────────────────────────────────────────────────────────────────────────

let doorsAt = -1
let doorsOf: unknown = null
const shut: Rect[] = []

/** Nothing solid between the two points: walls, buildings and closed or boarded doors. */
function seesThrough(sim: OutbreakSim, x0: number, y0: number, x1: number, y1: number): boolean {
  if (!clearLine(x0, y0, x1, y1, sightRects(sim.town))) return false
  if (doorsAt !== sim.time || doorsOf !== sim.town) {
    doorsAt = sim.time
    doorsOf = sim.town
    shut.length = 0
    for (const d of sim.town.doors) if (!d.open || (sim.ai.getBarricadePlanks(d.id) ?? 0) > 0) shut.push(d.rect)
  }
  return clearLine(x0, y0, x1, y1, shut)
}

export function stepBehaviourAfter(sim: OutbreakSim, st: BehaviourState): void {
  const t = st.tuning
  if (!behaviourOn(t)) return
  const time = sim.time
  const agents = sim.ai.agents
  const minds = st.minds
  const darkness = dayCycle(sim.hour).darkness

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!
    const m = minds[a.id]
    if (!m || a.state === "dead") continue
    const prev = m.last
    const cur = a.state
    m.last = cur
    if (pinned(a)) continue
    const p = personalityOf(a)

    // Memory: where it last had you, which way you were going, and the house you were in.
    if (a.seesTarget) {
      const slot = sim.slot(a.focusId) ?? sim.slots[0]
      if (slot) {
        const s = slot.survivor
        m.memT = time
        m.memX = s.x
        m.memY = s.y
        m.memVx = s.vx
        m.memVy = s.vy
        m.memHouse = buildingAt(sim, s.x, s.y)?.id ?? ""
        m.rounds = -1
      }
    }

    // It just noticed you: the dead around it that see it go turn and follow, a beat later.
    // They go to where it was, not to you: they trail it rather than joining the hunt, and only one turns by day, so
    // the director's chasers still set the pressure.
    if (t.zbFollow > 0 && !engaged(prev) && (cur === "alert" || cur === "chase")) {
      const reach = 8 * Math.min(1.6, t.zbFollow)
      const most = darkness > 0.55 ? 3 : 1
      let recruited = 0
      for (let k = 0; k < agents.length && recruited < most; k++) {
        const o = agents[k]!
        if (o === a || o.state !== "wander" || pinned(o)) continue
        const d = Math.hypot(o.x - a.x, o.y - a.y)
        if (d > reach) continue
        const om = minds[o.id]
        if (!om || om.followAt > 0 || isClimbing(om.act) || om.act === ACT_FEED) continue
        const op = zombiePersonality(o.seed, leaderScratch)
        if (op.sociability < 1 - 0.75 * Math.min(1.3, t.zbFollow)) continue
        if (!seesThrough(sim, o.x, o.y, a.x, a.y)) continue
        om.followAt = time + op.reaction * (isResting(om.act) ? 1.6 : 1)
        om.fx = a.x
        om.fy = a.y
        recruited++
      }
    }

    // The search ran out: search again where you were going, or at the house you went into, or give up.
    if (t.zbSearch > 0 && prev === "search" && cur === "wander" && m.memT >= 0) {
      if (m.rounds < 0) m.rounds = Math.round(p.persistence * 3 * Math.min(2, t.zbSearch))
      const fresh = time - m.memT < 45 * Math.min(1.5, t.zbSearch)
      if (m.rounds > 0 && fresh) {
        m.rounds--
        const pt = searchPoint(sim, a, m, p)
        if (pt) {
          a.state = "investigate"
          a.stateTime = 0
          a.repathAt = 0
          a.awareness = 0.34
          a.targetX = pt.x
          a.targetY = pt.y
          a.targetKind = "noise"
          m.peer = pt.peer
          start(st, m, ACT_SEEK, time + 16, pt.ax, pt.ay)
          continue
        }
      }
      start(st, m, ACT_GIVE_UP, time + 1.1 + 0.8 * p.persistence, m.memX, m.memY)
      m.memT = -1
      m.memHouse = ""
      m.rounds = -1
      continue
    }

    // It heard something: it stops, turns to it and listens.
    if (t.zbListen > 0 && a.lastHeardNoiseId !== m.heard) {
      const id = a.lastHeardNoiseId
      m.heard = id
      // Still wandering (a faint sound), or just turned to investigate it: a beat to turn and listen before it goes.
      const starting = cur === "investigate" && (prev === "wander" || prev === "search")
      // Once every few seconds at most, so a noisy survivor is not shielded by a crowd that keeps stopping to listen.
      if ((cur === "wander" || starting) && time >= m.cool && (m.act === ACT_NONE || m.act === ACT_PAUSE || m.act === ACT_HERD || m.act === ACT_LIGHT)) {
        const ev = sim.ai.noiseBus.events.find((e) => e.id === id)
        if (ev && h01(a.seed, id, 141) < Math.min(1, (0.35 + 0.6 * p.curiosity) * t.zbListen)) {
          const hold = starting ? 0.3 + 0.4 * p.curiosity : 0.8 + 1.4 * p.curiosity
          start(st, m, ACT_LISTEN, time + hold * Math.min(1.5, t.zbListen), ev.x, ev.y)
          m.cool = time + hold + 5
        }
      }
    }
  }
}

/** Where to search next: a window or doorway of the house it saw you in, else ahead along the way you were going. */
function searchPoint(sim: OutbreakSim, a: AIAgent, m: ZombieMind, p: ZombiePersonality): { x: number; y: number; ax: number; ay: number; peer: boolean } | null {
  if (m.memHouse) {
    const b = sim.town.buildings.find((x) => x.id === m.memHouse)
    if (b) {
      const openings: Rect[] = []
      for (const w of sim.town.windows) if (w.buildingId === b.id) openings.push(w.rect)
      const [x0, y0, x1, y1] = b.rect
      for (const d of sim.town.doors) {
        // Outside doors only: on the building's edge, not between its rooms.
        const cx = (d.rect[0] + d.rect[2]) / 2
        const cy = (d.rect[1] + d.rect[3]) / 2
        if (distToRect(cx, cy, b.rect) > 0.4) continue
        if (Math.min(Math.abs(cx - x0), Math.abs(cx - x1), Math.abs(cy - y0), Math.abs(cy - y1)) < 0.5) openings.push(d.rect)
      }
      if (openings.length > 0) {
        const pick = openings[(Math.floor(h01(a.seed, 151) * openings.length) + m.rounds) % openings.length]!
        const cx = (pick[0] + pick[2]) / 2
        const cy = (pick[1] + pick[3]) / 2
        // Stand outside the opening, on the street side of the wall.
        const horizontal = pick[2] - pick[0] > pick[3] - pick[1]
        const outward = horizontal ? (cy > (b.rect[1] + b.rect[3]) / 2 ? 1 : -1) : cx > (b.rect[0] + b.rect[2]) / 2 ? 1 : -1
        const sx = horizontal ? cx : cx + outward * 0.75
        const sy = horizontal ? cy + outward * 0.75 : cy
        const q = { x: sx, y: sy }
        pushOut(q, 0.3, sim.solids)
        if (sim.ai.nav.walkable(q)) return { x: q.x, y: q.y, ax: cx, ay: cy, peer: true }
      }
    }
  }
  const sp = Math.hypot(m.memVx, m.memVy)
  const lead = sp > 0.3 ? (2 + 3 * p.persistence) / sp : 0
  const jitter = (h01(a.seed, 161, m.rounds) - 0.5) * 3
  const x = m.memX + m.memVx * lead + jitter
  const y = m.memY + m.memVy * lead + (h01(a.seed, 162, m.rounds) - 0.5) * 3
  const q = sim.ai.nav.nearest({ x, y })
  return { x: q.x, y: q.y, ax: q.x, ay: q.y, peer: false }
}
