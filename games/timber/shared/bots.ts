// Bots. Free-for-all: fell a tree onto a victim standing in a fall line, saw them up close, get out from under trees
// coming down. The hunt: the lumberjack tracks survivors by sight and sound, sneaks with the engine off, fells trees
// on them, refuels and executes the downed; survivors gather truck parts, go dark and flee the saw, revive each
// other and shove cut trees onto him. Simple steering with trunk avoidance and an unstick wobble.
import { active, type FeelConfig, type Jack, type JackInput, NO_INPUT, PART_KINDS, upright, type World } from "./sim"
import { inFallZone, predictedFall, type Tree } from "./trees"

export type BotBrain = {
  rng: number
  victim: number
  /** Tree being worked to drop on the victim (-1 none). */
  tree: number
  replan: number
  /** Unstick detour: seconds left and its side. */
  detour: number
  detourSide: number
  lastX: number
  lastY: number
  stuckT: number
  /** Duel: let go of the trigger for a beat to fling the victim. */
  letGo: number
  /** Hunt: where the quarry (or the threat) was last seen or heard, and when (−∞ never). */
  seenX: number
  seenY: number
  seenT: number
  /** Lumberjack: creeping with the engine off; seconds until the next pull is allowed. */
  sneak: boolean
  pullWait: number
  /** Wander goal. */
  goalX: number
  goalY: number
  /** Survivor: brave enough this plan to try dropping a tree on him. */
  bold: boolean
}

export function newBrain(seed = 1): BotBrain {
  return {
    rng: (seed * 2654435761) >>> 0, victim: -1, tree: -1, replan: 0, detour: 0, detourSide: 1, lastX: 0, lastY: 0, stuckT: 0, letGo: 0,
    seenX: 0, seenY: 0, seenT: -Infinity, sneak: false, pullWait: 0, goalX: 0, goalY: 0, bold: false,
  }
}

function roll(b: BotBrain): number {
  b.rng = (b.rng + 0x6d2b79f5) >>> 0
  let t = b.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Stable per bot and tree, so a bot either reacts to a given falling tree or doesn't. */
function reacts(j: Jack, t: Tree, chance: number): boolean {
  const h = (Math.imul(j.id + 1, 73856093) ^ Math.imul(t.id + 1, 19349663)) >>> 0
  return (h % 1000) / 1000 < chance
}

const idle = (j: Jack): JackInput => ({ ...NO_INPUT, aim: j.aim })
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

/** Where to stand to cut `t` so it falls on (vx, vy). */
function cutSpot(t: Tree, vx: number, vy: number): { x: number; y: number } {
  const dx = vx - t.x
  const dy = vy - t.y
  const l = Math.hypot(dx, dy) || 1
  return { x: t.x - (dx / l) * 0.78, y: t.y - (dy / l) * 0.78 }
}

/** The best standing tree to drop on the victim: in reach of them, close to us, ideally already cut. */
function pickTree(w: World, j: Jack, v: { x: number; y: number }, maxWalk = 14): number {
  let best = -1
  let bestScore = Infinity
  for (const t of w.trees) {
    if (t.state !== "standing") continue
    const dv = Math.hypot(v.x - t.x, v.y - t.y)
    if (dv < 2.5 || dv > t.h * 0.85) continue
    const spot = cutSpot(t, v.x, v.y)
    const dj = Math.hypot(spot.x - j.x, spot.y - j.y)
    if (dj > maxWalk) continue
    const score = dj + (1 - t.cut) * 6 + dv * 0.15
    if (score < bestScore) {
      bestScore = score
      best = t.id
    }
  }
  return best
}

/** Seek (gx, gy), steering round trunks ahead. */
function steer(w: World, j: Jack, gx: number, gy: number): { mx: number; my: number } {
  let dx = gx - j.x
  let dy = gy - j.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-3) return { mx: 0, my: 0 }
  dx /= d
  dy /= d
  let ax = 0
  let ay = 0
  for (const t of w.trees) {
    const ox = t.x - j.x
    const oy = t.y - j.y
    if (Math.abs(ox) > 2.2 || Math.abs(oy) > 2.2) continue
    const od = Math.hypot(ox, oy)
    if (od > 2.2 || od < 1e-3 || od > d + 0.5) continue
    const ahead = (ox * dx + oy * dy) / od
    if (ahead < 0.3) continue
    // Push sideways off the trunk, harder the closer and more dead-ahead it is.
    const side = ox * dy - oy * dx >= 0 ? 1 : -1
    const k = ((2.2 - od) / 2.2) * ahead * 1.6
    ax += dy * side * k
    ay += -dx * side * k
  }
  const b = j.brain
  if (b.detour > 0) {
    ax += -dy * b.detourSide * 1.3
    ay += dx * b.detourSide * 1.3
  }
  return { mx: dx + ax, my: dy + ay }
}

/** Walk to (gx, gy) facing where we go. */
function go(w: World, j: Jack, gx: number, gy: number, sprint = false): JackInput {
  const m = steer(w, j, gx, gy)
  return { ...NO_INPUT, mx: m.mx, my: m.my, aim: Math.hypot(m.mx, m.my) > 1e-3 ? Math.atan2(m.my, m.mx) : j.aim, sprint }
}

/** Timers and the unstick wobble: barely moved for a while → sidestep for a moment. */
function tick(j: Jack, dt: number): void {
  const b = j.brain
  b.replan -= dt
  b.detour = Math.max(0, b.detour - dt)
  b.letGo = Math.max(0, b.letGo - dt)
  b.pullWait = Math.max(0, b.pullWait - dt)
  b.stuckT += dt
  if (b.stuckT > 0.8) {
    const moved = Math.hypot(j.x - b.lastX, j.y - b.lastY)
    if (moved < 0.35 && !j.trigger) {
      b.detour = 0.7
      b.detourSide = roll(b) < 0.5 ? -1 : 1
    }
    b.stuckT = 0
    b.lastX = j.x
    b.lastY = j.y
  }
}

/** Get out from under anything coming down (not our own cut: we stand behind it). */
function dodge(w: World, j: Jack, feel: Readonly<FeelConfig>): JackInput | null {
  for (const t of w.trees) {
    const coming = t.state === "falling" || (t.state === "standing" && t.cut >= feel.warnAt && t.cut < 1 && t.cut > (t.notched ? feel.notchedCut + 0.01 : 0))
    if (!coming || !reacts(j, t, feel.botDodge)) continue
    const f = t.state === "falling" ? { x: t.fx, y: t.fy } : predictedFall(t, t.x - t.cdx, t.y - t.cdy, 0)
    if (!inFallZone(t, f.x, f.y, j.x, j.y, 0.9)) continue
    if (j.target?.kind === "tree" && j.target.id === t.id) continue
    const side = (j.x - t.x) * f.y - (j.y - t.y) * f.x >= 0 ? 1 : -1
    const revved = j.role === "lumberjack" && j.engine === "on"
    return { ...NO_INPUT, mx: f.y * side, my: -f.x * side, aim: Math.atan2(-f.x * side, f.y * side), saw: revved && t.state === "falling", dash: revved && j.dashCd <= 0 && t.state === "falling", sprint: true }
  }
  return null
}

export function thinkBot(w: World, j: Jack, dt: number, feel: Readonly<FeelConfig>): JackInput {
  if (!active(j) || w.phase !== "play") return idle(j)
  tick(j, dt)
  if (w.mode === "ffa") return thinkBrawler(w, j, dt, feel)
  return j.role === "lumberjack" ? thinkHunter(w, j, dt, feel) : thinkSurvivor(w, j, dt, feel)
}

// ── Free-for-all ────────────────────────────────────────────────────────────────────────────────────────────────

function pickVictim(w: World, j: Jack, feel: Readonly<FeelConfig>): number {
  const others = w.jacks.filter((o) => o !== j && o.alive)
  if (!others.length) return -1
  const human = others.find((o) => !o.bot)
  if (human && roll(j.brain) < feel.botFocus) return human.id
  let best = others[0]!
  for (const o of others) if (dist(o, j) < dist(best, j)) best = o
  return best.id
}

function thinkBrawler(w: World, j: Jack, dt: number, feel: Readonly<FeelConfig>): JackInput {
  const b = j.brain
  const dodging = dodge(w, j, feel)
  if (dodging) return dodging
  if (w.t < feel.botWarmup) {
    // Rev up and drift in at round start; nobody gets dropped on in the first seconds.
    const m = steer(w, j, j.x * 0.6, j.y * 0.6)
    return { ...NO_INPUT, mx: m.mx * 0.4, my: m.my * 0.4, aim: Math.atan2(-j.y, -j.x) }
  }
  if (b.replan <= 0 || !w.jacks[b.victim]?.alive) {
    b.replan = 2.5 + roll(b) * 1.5
    const keepTree = b.tree >= 0 && (w.trees[b.tree]?.cut ?? 0) > 0.55 && w.trees[b.tree]?.state === "standing"
    b.victim = pickVictim(w, j, feel)
    if (!keepTree) b.tree = -1
  }
  const v = w.jacks[b.victim]
  if (!v?.alive) return idle(j)
  return attack(w, j, v, dt, feel)
}

/** Close in and saw, or drop a tree on them from the far side. */
function attack(w: World, j: Jack, v: Jack, dt: number, feel: Readonly<FeelConfig>): JackInput {
  const b = j.brain
  const vd = dist(v, j)
  const toV = Math.atan2(v.y - j.y, v.x - j.x)
  const duelRange = 2 + feel.botAggro * 3
  const deepCut = b.tree >= 0 && w.trees[b.tree]?.state === "standing" && w.trees[b.tree]!.cut > 0.6
  if (vd < duelRange && !deepCut) {
    b.tree = -1
    const inReach = vd < feel.sawReach + 0.3 + (v.downed ? 0.3 : 0)
    if (j.contact > 0.9 && !v.downed && roll(b) < dt * 1.5) b.letGo = 0.25
    const lunge = !v.downed && vd > 1.6 && vd < 4 && j.dashCd <= 0 && roll(b) < dt * 3 * feel.botAggro
    const m = steer(w, j, v.x, v.y)
    // Rev on the way in: the lunge needs the saw screaming.
    const rev = inReach || (lunge && vd < 4.5)
    return { ...NO_INPUT, mx: inReach ? m.mx * 0.4 : m.mx, my: inReach ? m.my * 0.4 : m.my, aim: toV, saw: rev && b.letGo <= 0, dash: lunge, sprint: vd > 3 }
  }
  const cur = b.tree >= 0 ? w.trees[b.tree] : undefined
  if (!cur || cur.state !== "standing") b.tree = pickTree(w, j, v)
  else if (cur.cut < 0.6) {
    // Give up if the victim walked well out of the fall line.
    const f = predictedFall(cur, cur.x - (v.x - cur.x), cur.y - (v.y - cur.y), 0.25)
    if (!inFallZone(cur, f.x, f.y, v.x, v.y, 3)) b.tree = pickTree(w, j, v)
  }
  const t = b.tree >= 0 ? w.trees[b.tree] : undefined
  if (!t) return { ...go(w, j, v.x, v.y, true), aim: toV }
  // Once the cut is deep, finish from where we stand; otherwise line up behind it.
  const spot = t.cut > 0.6 ? { x: j.x, y: j.y } : cutSpot(t, v.x, v.y)
  const sd = dist(spot, j)
  const aim = Math.atan2(t.y - j.y, t.x - j.x)
  if (sd < 0.45) return { ...NO_INPUT, aim, saw: true }
  const m = steer(w, j, spot.x, spot.y)
  return { ...NO_INPUT, mx: m.mx, my: m.my, aim: sd < 2 ? aim : Math.atan2(m.my, m.mx), sprint: sd > 4 }
}

// ── The hunt: perception ────────────────────────────────────────────────────────────────────────────────────────

/** Standing trees round a point: cover that shrinks as the lumberjack clears the woods. */
export function cover(w: World, x: number, y: number): number {
  let n = 0
  for (const t of w.trees) if (t.state === "standing" && Math.abs(t.x - x) < 3.5 && Math.abs(t.y - y) < 3.5 && Math.hypot(t.x - x, t.y - y) < 3.5) n++
  return n
}

/** The lumberjack spots a survivor: far with a torch on, close in the dark, less through thick woods. */
export function spots(w: World, hunter: Jack, s: Jack, feel: Readonly<FeelConfig>): boolean {
  const d = dist(s, hunter)
  if (hunter.blind > 0) return d < 1.5
  if (d < 2.5) return true
  const sight = (s.torch ? feel.botSight : feel.botSightDark) / (1 + cover(w, s.x, s.y) * 0.12)
  return d < sight || d < s.noise * feel.hearRange
}

/** Anyone hears a body as far as its noise carries. */
export const hears = (listener: Jack, src: Jack, feel: Readonly<FeelConfig>) => dist(listener, src) < src.noise * feel.hearRange

// ── The hunt: lumberjack ────────────────────────────────────────────────────────────────────────────────────────

function thinkHunter(w: World, j: Jack, dt: number, feel: Readonly<FeelConfig>): JackInput {
  const b = j.brain
  if (j.stun > 0) return idle(j)
  // Pull the cord when the engine is off and we want it, without mashing (bots don't flood themselves).
  const pull = (want: boolean) => {
    if (!want || j.engine !== "off" || j.floodLock > 0 || b.pullWait > 0 || j.fuel <= 0) return false
    b.pullWait = feel.pullTime + 0.6 + roll(b) * 0.6
    return true
  }
  const dodging = dodge(w, j, feel)
  if (dodging) return { ...dodging, engine: pull(true) }
  if (w.t < feel.botWarmup) return { ...idle(j), engine: pull(true) }

  // Who can we see or hear?
  const quarry = w.jacks.filter((s) => s.role === "survivor" && active(s))
  let seen: Jack | null = null
  for (const s of quarry) if (!s.downed && spots(w, j, s, feel) && (!seen || dist(s, j) < dist(seen, j))) seen = s
  if (seen) {
    b.victim = seen.id
    b.seenX = seen.x
    b.seenY = seen.y
    b.seenT = w.t
  }
  if (b.replan <= 0) {
    b.replan = 3 + roll(b) * 2
    b.sneak = roll(b) < feel.botSneak
    b.goalX = (roll(b) * 2 - 1) * 18
    b.goalY = (roll(b) * 2 - 1) * 18
    // Camp where the survivors must go: an untaken part, or the truck.
    const parts = w.items.filter((i) => i.kind !== "gas" && !i.taken)
    if (roll(b) < 0.5 && parts.length) {
      const p = parts[Math.floor(roll(b) * parts.length)]!
      b.goalX = p.x
      b.goalY = p.y
    } else if (roll(b) < 0.3 && w.truck) {
      b.goalX = w.truck.x * 0.8
      b.goalY = w.truck.y * 0.8
    }
  }

  // Low on fuel: go to the nearest can. Dry, a dead saw is no use to anyone: go whatever we can see.
  if (j.fuel <= 0 || (j.fuel < feel.fuelMax * 0.22 && !seen)) {
    const cans = w.items.filter((i) => i.kind === "gas" && !i.taken).sort((a, c) => dist(a, j) - dist(c, j))
    if (cans[0]) return { ...go(w, j, cans[0].x, cans[0].y), engine: false }
  }

  // Finish off the downed if nobody stands over them.
  const downed = quarry.filter((s) => s.downed && dist(s, j) < 14).sort((a, c) => dist(a, j) - dist(c, j))[0]
  if (downed && (!seen || dist(seen, j) > 6 || dist(seen, downed) < 2)) {
    const d = dist(downed, j)
    const att = attack(w, j, downed, dt, feel)
    return { ...att, saw: att.saw && j.engine === "on", engine: pull(d < 8 || att.saw) }
  }

  if (seen) {
    const d = dist(seen, j)
    // Stalking from far with the engine off, then the pull-start when it's too late to run.
    if (b.sneak && d > 7 && d < 26 && !seen.sprinting) return { ...go(w, j, seen.x, seen.y), engine: j.engine === "on" }
    const att = attack(w, j, seen, dt, feel)
    return { ...att, saw: att.saw && j.engine === "on", dash: att.dash && j.engine === "on" && att.saw, engine: pull(true) }
  }
  // Last heard: go and look.
  if (w.t - b.seenT < 10 && dist({ x: b.seenX, y: b.seenY }, j) > 1.5) return { ...go(w, j, b.seenX, b.seenY), engine: pull(!b.sneak) }
  if (dist({ x: b.goalX, y: b.goalY }, j) < 2) b.replan = 0
  return { ...go(w, j, b.goalX, b.goalY), engine: pull(!b.sneak) }
}

// ── The hunt: survivors ─────────────────────────────────────────────────────────────────────────────────────────

/** A cut tree we could shove onto him: its fall line from our side covers him, and we can get to it in time. */
function trapTree(w: World, j: Jack, lj: Jack, feel: Readonly<FeelConfig>, reach: number): Tree | null {
  let best: Tree | null = null
  let bestD = Infinity
  for (const t of w.trees) {
    if (t.state !== "standing" || t.cut < feel.pushAt) continue
    const dt = dist(t, j)
    if (dt > reach) continue
    const dl = dist(t, lj)
    if (dl < 1.5 || dl > t.h * 0.9) continue
    const spot = cutSpot(t, lj.x, lj.y)
    // Our walk to the push spot must not cross under it.
    if (dist(spot, lj) < 3) continue
    if (dt < bestD) {
      bestD = dt
      best = t
    }
  }
  return best
}

function thinkSurvivor(w: World, j: Jack, dt: number, feel: Readonly<FeelConfig>): JackInput {
  const b = j.brain
  const lj = w.jacks.find((o) => o.role === "lumberjack" && active(o))
  if (b.replan <= 0) {
    b.replan = 2 + roll(b) * 2
    b.bold = roll(b) < feel.botDropTry
  }
  if (lj && (hears(j, lj, feel) || dist(lj, j) < 10)) {
    b.seenX = lj.x
    b.seenY = lj.y
    b.seenT = w.t
  }
  const fresh = w.t - b.seenT < 6
  const threat = { x: b.seenX, y: b.seenY }
  const threatD = fresh ? dist(threat, j) : Infinity
  // Go dark when he's hunting nearby; light the way otherwise.
  const torchWant = threatD > 20
  const torch = j.torch !== torchWant
  const out = (i: JackInput): JackInput => ({ ...i, torch })

  if (j.downed) {
    // Crawl away from him, towards the nearest friend.
    const friend = w.jacks.filter((o) => o !== j && o.role === "survivor" && upright(o)).sort((a, c) => dist(a, j) - dist(c, j))[0]
    const g = friend ?? { x: j.x + (j.x - threat.x), y: j.y + (j.y - threat.y) }
    return out(go(w, j, g.x, g.y))
  }
  const dodging = dodge(w, j, feel)
  if (dodging) return out({ ...dodging, sprint: true })

  // He's pinned under a tree: drop another on him if one is ready.
  if (lj && lj.stun > 0) {
    const t = trapTree(w, j, lj, feel, Math.min(14, lj.stun * feel.survivorWalk))
    if (t) return out(shove(w, j, t, lj))
  }
  // Bold: shove a cut tree onto him as he comes.
  if (lj && b.bold && fresh && threatD < 16) {
    const t = trapTree(w, j, lj, feel, 5)
    if (t) return out(shove(w, j, t, lj))
  }
  // Too close: a flare in his face, then run.
  if (lj && fresh && threatD < 4.5 && j.flares > 0 && lj.blind <= 0 && lj.engine === "on" && roll(b) < dt * 4) {
    return out({ ...NO_INPUT, aim: Math.atan2(lj.y - j.y, lj.x - j.x), flare: true })
  }
  if (threatD < 11) {
    const ax = j.x - threat.x
    const ay = j.y - threat.y
    const l = Math.hypot(ax, ay) || 1
    // Run away, bending towards the middle so we don't pin ourselves on the bank.
    const gx = j.x + (ax / l) * 8 - j.x * 0.25
    const gy = j.y + (ay / l) * 8 - j.y * 0.25
    return out(go(w, j, gx, gy, threatD < 8))
  }
  // Pick up a friend if he's not about.
  const down = w.jacks.filter((o) => o !== j && o.role === "survivor" && o.alive && o.downed && dist(o, threat) > 8).sort((a, c) => dist(a, j) - dist(c, j))[0]
  if (down && dist(down, j) < 25) {
    if (dist(down, j) < 1.2) return out({ ...NO_INPUT, aim: Math.atan2(down.y - j.y, down.x - j.x), use: true })
    return out(go(w, j, down.x, down.y, dist(down, j) > 6))
  }
  const tr = w.truck
  if (tr && (tr.started || j.carrying)) return out(go(w, j, tr.x, tr.y, dist(tr, j) < 12))
  // The nearest part nobody has, away from him.
  const parts = w.items.filter((i) => i.kind !== "gas" && !i.taken && PART_KINDS.includes(i.kind) && dist(i, threat) > (fresh ? 9 : 0))
  parts.sort((a, c) => dist(a, j) - dist(c, j))
  if (parts[0]) return out(go(w, j, parts[0].x, parts[0].y))
  // Nothing to do: wander near the truck.
  if (b.replan > 1.9 || dist({ x: b.goalX, y: b.goalY }, j) < 2) {
    b.goalX = (tr?.x ?? 0) * 0.6 + (roll(b) * 2 - 1) * 8
    b.goalY = (tr?.y ?? 0) * 0.6 + (roll(b) * 2 - 1) * 8
  }
  return out(go(w, j, b.goalX, b.goalY))
}

/** Walk to the far side of `t` from him and shove it over onto him. */
function shove(w: World, j: Jack, t: Tree, lj: Jack): JackInput {
  const spot = cutSpot(t, lj.x, lj.y)
  const aim = Math.atan2(t.y - j.y, t.x - j.x)
  if (dist(spot, j) < 0.5) return { ...NO_INPUT, aim, use: true }
  return { ...go(w, j, spot.x, spot.y, true), aim: dist(spot, j) < 2 ? aim : Math.atan2(spot.y - j.y, spot.x - j.x) }
}
