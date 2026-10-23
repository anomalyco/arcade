// The match brain's decisions (shared/bots.ts behavior "match"): what a bot playing the objective wants, as pure
// functions of what it can see. server/bots.ts asks these and then flies, sails or drives toward the answer with the
// same autopilots, weapons and messages as every other behavior, so the decisions here never touch the room.
//
// - Helms (`helmPlan`): sail for a capture zone (shared/objective.ts) and hold it, circling near its centre; switch to
//   the next zone once it is revealed if staying would make them late; prefer zones they hold or can take alone
//   (aggression makes contested ones acceptable); ram an enemy carrier sharing the zone when healthier by enough; run
//   from the enemy when badly hurt and come back once repaired.
// - The side's strike target (`strikeTarget`): one enemy carrier per side, chosen from the own carrier's position so
//   every jet and boat of a side agrees and focuses it: the zone holder and the score leader first, then the closest
//   and the most damaged.
// - Jets (`jetMission`): return to land and rearm when hurt or (F-35C) out of bombs; defend the own carrier against
//   jets near it; intercept jets close by; else strike (the F-35C always, a Hornet by its aggression) or fly CAP.

import { type BotSettings } from "../shared/bots"
import { FLEET } from "../shared/fleet"
import { type Archipelago, terrainHeight } from "../shared/islands"
import { OPEN, clearLine, findRoute, navGrid } from "./bot-nav"
import { type ObjectiveState, type Zone } from "../shared/objective"
import { SHIP } from "../shared/ship"
import { COLLIDE } from "../shared/ship-collide"

/** A carrier as the brain sees it (the room's settled pose and its hull). */
export type MatchShip = { id: number; team: number; x: number; z: number; heading: number; vx: number; vz: number; hp: number; sinking: boolean }

export type MatchView = { t: number; ships: readonly MatchShip[]; objective: ObjectiveState | null }

/** What a helm keeps between steps: retreating, its last clear heading (and when, and to which side it turned), and
 *  how long it has been stuck (aground or pinned) and backing off until when. */
export type HelmMemory = { retreat: boolean; navAt: number; nav: number; side: number; stuck: number; backUntil: number; route: { x: number; z: number }[]; routeAt: number; routeX: number; routeZ: number }

export const helmMemory = (): HelmMemory => ({ retreat: false, navAt: -Infinity, nav: 0, side: 1, stuck: 0, backUntil: -Infinity, route: [], routeAt: -Infinity, routeX: 0, routeZ: 0 })

/**
 * The heading toward `to` over open water: straight when the line is clear, else along a route round the islands
 * (server/bot-nav.ts), re-planned every 6 s or when the goal moves.
 */
export function routeHeading(arch: Archipelago, me: { x: number; z: number }, to: { x: number; z: number }, t: number, mem: HelmMemory): number {
  const g = navGrid(arch)
  if (clearLine(g, me.x, me.z, to.x, to.z)) {
    mem.route.length = 0
    return bearing(me.x, me.z, to.x, to.z)
  }
  if (t - mem.routeAt > 6 || Math.hypot(to.x - mem.routeX, to.z - mem.routeZ) > 400 || !mem.route.length) {
    mem.route = findRoute(g, me.x, me.z, to.x, to.z)
    mem.routeAt = t
    mem.routeX = to.x
    mem.routeZ = to.z
  }
  const r = mem.route
  while (r.length > 1 && (dist(me, r[0]!) < 250 || clearLine(g, me.x, me.z, r[1]!.x, r[1]!.z))) r.shift()
  const w = r[0] ?? to
  return bearing(me.x, me.z, w.x, w.z)
}

const FEELERS = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.3, 1.6, 2.0, 2.5, 3.1]

/**
 * Steers round islands: the heading nearest `want` whose next `reach` m are open water (feelers every 150 m on headings
 * fanning out from it, the side it last turned to first so it doesn't dither), re-planned twice a second. If nothing
 * is clear it takes the longest clear run. A ship that has not moved for 8 s under power backs off for 8 s.
 */
export function steerClear(arch: Archipelago, me: { x: number; z: number; heading: number; u: number }, want: number, throttle: number, t: number, mem: HelmMemory): { heading: number; throttle: number } {
  if (t < mem.backUntil) return { heading: me.heading + mem.side * 0.8, throttle: -1 }
  if (t - mem.navAt < 0.5) return { heading: mem.nav, throttle }
  const dt = Number.isFinite(mem.navAt) ? t - mem.navAt : 0
  mem.navAt = t
  mem.stuck = throttle > 0.25 && Math.abs(me.u) < 1.5 ? mem.stuck + dt : 0
  if (mem.stuck > 8) {
    mem.stuck = 0
    mem.backUntil = t + 8
    mem.side = -mem.side
    return { heading: me.heading, throttle: -1 }
  }
  const reach = 300 + Math.max(0, me.u) * 25
  const run = (h: number): number => {
    for (let d = 150; d <= reach; d += 150) if (terrainHeight(arch, me.x + Math.sin(h) * d, me.z - Math.cos(h) * d) > OPEN) return d
    return Infinity
  }
  let best = want
  let bestRun = -1
  for (const off of FEELERS) {
    for (const sign of off === 0 ? [1] : [mem.side, -mem.side]) {
      const h = want + off * sign
      const r = run(h)
      if (r === Infinity) {
        if (off > 0) mem.side = sign
        mem.nav = h
        return { heading: h, throttle }
      }
      if (r > bestRun) {
        bestRun = r
        best = h
      }
    }
  }
  mem.nav = best
  // Boxed in: slow down while it turns toward the longest clear run.
  return { heading: best, throttle: Math.min(throttle, 0.35) }
}

/** `to`: the point it is sailing for (route it round islands), null while holding or ramming (steer `heading`). */
export type HelmPlan = { heading: number; throttle: number; note: string; zone: number; ram: number; to: { x: number; z: number } | null }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
/** Heading (0 north, π/2 east) from (x, z) toward (tx, tz). */
export const bearing = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, -(tz - z))
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)
const km = (m: number) => `${(m / 1000).toFixed(1)} km`
const ZONE_NAMES = "AB"

/** Ships stay inside this radius of the map's centre (the objective's play area plus a margin). */
const ARENA = 5600

/** The zone a helm should be heading for (and whether it is one of the revealed next ones), or null. */
export function pickZone(view: MatchView, me: MatchShip, s: BotSettings): { zone: Zone; next: boolean } | null {
  const o = view.objective
  if (!o || o.end >= 0 || !o.zones.length) return null
  const speed = SHIP.topSpeed
  const enemies = view.ships.filter((x) => x.team !== me.team && !x.sinking)
  const inside = (z: Zone, x: MatchShip) => dist(x, z) <= z.r
  const cost = (z: Zone): number => {
    let c = dist(me, z) / speed
    for (const e of enemies) {
      if (inside(z, e)) c += 15 + 60 * (1 - s.aggression)
      else if (dist(e, z) < z.r + 1500) c += 20 * (1 - s.aggression)
    }
    if (z.holder === me.team) c -= 30
    else if (z.holder >= 0) c += 10
    if (z.cap === me.team) c -= 10 * z.progress
    return c
  }
  const best = (list: readonly Zone[]) => list.reduce<Zone | null>((a, z) => (!a || cost(z) < cost(a) ? z : a), null)
  const now = best(o.zones)!
  if (o.next.length) {
    const nxt = best(o.next)!
    const left = o.moveAt - view.t
    // Skilled helms leave early enough to arrive as it opens; anyone not already holding goes now.
    const margin = 5 + 25 * s.skill
    if (dist(me, nxt) / speed + margin >= left || !inside(now, me)) return { zone: nxt, next: true }
  }
  return { zone: now, next: false }
}

/** One decision of a match helm: the heading and throttle to hold now. */
export function helmPlan(view: MatchView, me: MatchShip, s: BotSettings, mem: HelmMemory): HelmPlan {
  const hp = me.hp / FLEET.hp
  const enemies = view.ships.filter((x) => x.team !== me.team && !x.sinking)
  if (mem.retreat && hp > 0.6) mem.retreat = false
  else if (!mem.retreat && hp < 0.15 + 0.2 * (1 - s.aggression)) mem.retreat = true
  if (mem.retreat) {
    // Away from the nearest enemy carrier (the jets come anyway, but the guns and rams don't), kept in the arena.
    let ax = 0
    let az = 0
    for (const e of enemies) {
      const d = Math.max(300, dist(me, e))
      ax += (me.x - e.x) / (d * d)
      az += (me.z - e.z) / (d * d)
    }
    const n = Math.hypot(ax, az)
    let tx = n > 0 ? me.x + (ax / n) * 2500 : 0
    let tz = n > 0 ? me.z + (az / n) * 2500 : 0
    const r = Math.hypot(tx, tz)
    if (Math.hypot(me.x, me.z) > ARENA * 0.85) {
      tx = 0
      tz = 0
    } else if (r > ARENA) {
      tx = (tx / r) * ARENA
      tz = (tz / r) * ARENA
    }
    return { heading: bearing(me.x, me.z, tx, tz), throttle: 1, note: `retreat ${Math.round(hp * 100)}%`, zone: -1, ram: -1, to: { x: tx, z: tz } }
  }
  const pick = pickZone(view, me, s)
  if (!pick) return { heading: bearing(me.x, me.z, 0, 0), throttle: Math.hypot(me.x, me.z) > 800 ? 0.6 : 0.2, note: "no zone", zone: -1, ram: -1, to: { x: 0, z: 0 } }
  const { zone: z, next } = pick
  const name = `${next ? "next " : ""}${ZONE_NAMES[z.id] ?? z.id}`
  const d = dist(me, z)
  // Ram an enemy carrier contesting the zone when a full-speed ram should sink it (shared/ship-collide.ts: up to
  // harmMax to it, and up to (1 - rammer) of that back to us) and we would come out of it with a margin.
  const blow = COLLIDE.harmMax
  if (s.aggression > 0.35 && me.hp > blow * (1 - COLLIDE.rammer) + 300 * (1.2 - s.aggression)) {
    let target: MatchShip | null = null
    let td = Infinity
    for (const e of enemies) {
      const de = dist(me, e)
      if (dist(e, z) > z.r || e.hp > blow * (0.5 + 0.6 * s.aggression) || de > 2500) continue
      if (de < td) {
        td = de
        target = e
      }
    }
    if (target) {
      const lead = clamp(td / 30, 0, 30)
      return { heading: bearing(me.x, me.z, target.x + target.vx * lead, target.z + target.vz * lead), throttle: 1, note: `ram #${target.id} ${km(td)}`, zone: z.id, ram: target.id, to: null }
    }
  }
  // Hold where the zone is ours alone: its centre; with enemies in or at it, the far side from them (a contest is
  // still a contest, but carriers circling the same spot only grind each other down).
  let hx = z.x
  let hz = z.z
  let R = z.r * 0.35
  const rivals = enemies.filter((e) => dist(e, z) < z.r + 400)
  if (rivals.length) {
    const ex = rivals.reduce((a, e) => a + e.x, 0) / rivals.length
    const ez = rivals.reduce((a, e) => a + e.z, 0) / rivals.length
    const n = Math.hypot(z.x - ex, z.z - ez)
    const ux = n > 1 ? (z.x - ex) / n : (me.x - z.x) / (d || 1)
    const uz = n > 1 ? (z.z - ez) / n : (me.z - z.z) / (d || 1)
    hx = z.x + ux * z.r * 0.4
    hz = z.z + uz * z.r * 0.4
    R = 200
  }
  const dh = Math.hypot(me.x - hx, me.z - hz)
  if (dh > R + 250) {
    const throttle = d > 1500 ? 1 : 0.55 + 0.45 * Math.min(1, dh / 1500)
    return { heading: bearing(me.x, me.z, hx, hz), throttle, note: `→ zone ${name} ${km(d)}`, zone: z.id, ram: -1, to: { x: hx, z: hz } }
  }
  // Hold: circle the hold point clockwise, turned in or out by the radius error.
  const rx = me.x - hx
  const rz = me.z - hz
  const r = Math.hypot(rx, rz) || 1
  const err = clamp((r - R) / 200, -1, 1)
  const tx = -rz / r - (rx / r) * err
  const tz = rx / r - (rz / r) * err
  return { heading: Math.atan2(tx, -tz), throttle: 0.3, note: `hold zone ${name}${rivals.length ? " (contested)" : ""}`, zone: z.id, ram: -1, to: null }
}

/**
 * Bends a wanted heading away from other carriers (no accidental rams): away from any closer than 550 m, and away from
 * the closest point of approach of any due to pass within 450 m in the next 45 s (carriers turn wide at speed).
 */
export function avoid(view: MatchView, me: MatchShip, heading: number): number {
  let vx = Math.sin(heading)
  let vz = -Math.cos(heading)
  for (const o of view.ships) {
    if (o.id === me.id || o.sinking) continue
    const px = o.x - me.x
    const pz = o.z - me.z
    const d = Math.hypot(px, pz)
    if (d < 1) continue
    if (d < 550) {
      const k = ((550 - d) / 550) * 2.5
      vx -= (px / d) * k
      vz -= (pz / d) * k
    }
    const rvx = o.vx - me.vx
    const rvz = o.vz - me.vz
    const v2 = rvx * rvx + rvz * rvz
    const tca = v2 > 1 ? -(px * rvx + pz * rvz) / v2 : -1
    if (tca <= 0 || tca > 45) continue
    const cx = px + rvx * tca
    const cz = pz + rvz * tca
    const cd = Math.hypot(cx, cz)
    if (cd > 450) continue
    // Pass on the side we are already on (head-on: to starboard).
    const k = ((450 - cd) / 450) * 3 * (1 - tca / 45)
    const sx = cd > 1 ? -cx / cd : Math.cos(heading)
    const sz = cd > 1 ? -cz / cd : Math.sin(heading)
    vx += sx * k
    vz += sz * k
  }
  return Math.atan2(vx, -vz)
}

/** The enemy carrier side `team` strikes, judged from its own carrier at (x, z) (so all its bots agree), or null. */
export function strikeTarget(view: MatchView, team: number, x: number, z: number): MatchShip | null {
  const o = view.objective
  const lead = o ? o.scores.reduce((a, v, i) => (v > (o.scores[a] ?? 0) ? i : a), 0) : -1
  let best: MatchShip | null = null
  let score = Infinity
  for (const e of view.ships) {
    if (e.team === team || e.sinking) continue
    let c = Math.hypot(e.x - x, e.z - z) / 1000 + (e.hp / FLEET.hp) * 2
    if (o && lead === e.team && (o.scores[lead] ?? 0) > 0) c -= 1.5
    if (o?.zones.some((zz) => zz.holder === e.team && Math.hypot(e.x - zz.x, e.z - zz.z) <= zz.r)) c -= 2.5
    if (c < score) {
      score = c
      best = e
    }
  }
  return best
}

export type JetMission = "cap" | "defend" | "intercept" | "strike" | "rtb"

/** What a jet sees for its mission choice. Distances in metres; `hp` 0..100. */
export type JetSituation = {
  vehicle: "hornet" | "f35"
  hp: number
  missiles: number
  bombs: number
  /** Nearest enemy jet to us and to our carrier (Infinity: none). */
  nearMe: number
  nearHome: number
  /** Per-bot 0..1 coin: Hornets split between strike and CAP by it and their aggression. */
  coin: number
}

/**
 * The mission for a match jet now (`was`: the one it flies). Going home sticks until it lands, unless the field repair
 * (Hornet: back above 90) or the rails (F-35C: three bombs back in the bay) make it pointless first.
 */
export function jetMission(j: JetSituation, s: BotSettings, was: JetMission | "" = ""): JetMission {
  const rtbHp = 25 + 20 * (1 - s.aggression)
  if (was === "rtb" && j.nearMe > 1200 && (j.vehicle === "f35" ? j.bombs < 3 : j.hp < 90)) return "rtb"
  if (j.hp < rtbHp && j.nearMe > 1500) return "rtb"
  if (j.vehicle === "f35") {
    // A bomber presses its attack (breaks and flares still come first); with the bombs gone it fights its way home.
    if (j.bombs > 0 && was !== "rtb") return "strike"
    return j.nearMe < 1500 && j.missiles > 0 ? "intercept" : "rtb"
  }
  if (j.nearHome < 3500) return "defend"
  if (j.nearMe < 2500) return "intercept"
  return j.coin < 0.25 + 0.5 * s.aggression ? "strike" : "cap"
}
