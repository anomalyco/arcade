import { wrapDelta } from "./arena"
import { DT } from "./config"
import { BTN, type Buttons, DIAG } from "./input"
import { SCRIPTS, type NavGraph, cellOf, cellX, distanceField, navGraph, nearestCell, scriptButtons } from "./nav"
import { type Archer, type BrainState, HH, HW, World } from "./world"

const DIRS: readonly [number, number, Buttons][] = [
  [1, 0, BTN.right], [-1, 0, BTN.left], [0, 1, BTN.up], [0, -1, BTN.down],
  [DIAG, DIAG, BTN.right | BTN.up], [-DIAG, DIAG, BTN.left | BTN.up], [DIAG, -DIAG, BTN.right | BTN.down], [-DIAG, -DIAG, BTN.left | BTN.down],
]

const fields = new WeakMap<NavGraph, Map<number, Map<number, number>>>()
function field(g: NavGraph, goal: number): Map<number, number> {
  let m = fields.get(g)
  if (!m) fields.set(g, (m = new Map()))
  let f = m.get(goal)
  if (!f) m.set(goal, (f = distanceField(g, goal)))
  return f
}

function rand(b: BrainState): number {
  b.rng = (b.rng + 0x6d2b79f5) >>> 0
  let t = b.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function newBrain(seed: number, skill: number): BrainState {
  return { rng: seed >>> 0, script: -1, scriptAt: 0, goal: -1, goalAt: -99, draw: 0, aim: 0, dodgeAt: -99, skill }
}

/** Where an arrow loosed from `a` along (dx, dy) first meets an enemy, tracing its real arc; null if a wall comes first. */
function shotHits(w: World, a: Archer, dx: number, dy: number): Archer | null {
  const t = w.t
  let x = a.x + dx * 0.45, y = a.y + 0.72 + dy * 0.5
  let vx = dx * t.arrowSpeed, vy = dy * t.arrowSpeed
  for (let i = 0, age = 0; i < 48; i++, age += DT) {
    vy -= t.arrowGravity * DT * (age < 0.15 ? 0.3 : 1)
    x += vx * DT
    y += vy * DT
    if (w.pointSolid(x, y)) return null
    for (const v of w.s.archers) {
      if (!v.alive || v === a) continue
      const ex = wrapDelta(x - v.x, w.arena.w), ey = wrapDelta(y - v.y, w.arena.h)
      if (Math.abs(ex) < HW + 0.3 && ey > -0.3 && ey < HH + 0.3) return v
    }
  }
  return null
}

/**
 * Bots play with the same buttons as people: they dodge (and catch) arrows they see coming, shoot along clear lines
 * in 8 ways, collect arrows when empty, open chests, go for stomps, and travel with jumps, drops, ledge climbs and
 * wall-jump chains from the nav graph. Their state lives in the sim, so they replay exactly under rollback.
 */
export function botButtons(w: World, a: Archer): Buttons {
  const s = w.s
  const br = (s.brains[a.id] ??= newBrain(a.slot * 7919 + 17, [0.75, 0.6, 0.85, 0.5][a.slot % 4]!))
  if (!a.alive || s.phase === "count") return 0
  const g = navGraph(w.arena, w.t)
  const W = w.arena.w, H = w.arena.h
  const cx = a.x, cy = a.y + HH / 2

  // 1. Arrows about to hit: dodge, timed to catch when sharp enough.
  if (a.dodge <= 0 && a.dodgeCd <= 0 && s.time - br.dodgeAt > 0.25) {
    for (const r of s.arrows) {
      if (r.state !== "fly" || (r.by === a.id && r.age < 0.6)) continue
      const px = wrapDelta(r.x - cx, W), py = wrapDelta(r.y - cy, H)
      const vv = r.vx * r.vx + r.vy * r.vy
      if (vv < 1) continue
      const tc = -(px * r.vx + py * r.vy) / vv
      if (tc < 0 || tc > 0.2) continue
      const mx = px + r.vx * tc, my = py + r.vy * tc
      if (mx * mx + my * my > 0.9) continue
      // React late enough for a catch; slower bots react early (plain dodge) or not at all.
      const window = 0.05 + 0.08 * br.skill
      if (tc > window && rand(br) > 0.2) continue
      br.dodgeAt = s.time
      if (rand(br) > 0.3 + 0.6 * br.skill) break
      br.draw = 0
      br.script = -1
      const up = rand(br) < 0.5
      return BTN.dodge | (up ? BTN.up : 0) | (r.vx > 0 ? BTN.left : BTN.right)
    }
  }

  // 2. Bow: keep drawing, then release along the chosen line.
  if (br.draw > 0) {
    br.draw--
    return br.draw > 0 ? BTN.shoot | br.aim : br.aim
  }
  if (a.quiver.length && !a.hang && s.phase === "play" && s.tick % 3 === a.slot % 3) {
    for (const [dx, dy, bits] of DIRS) {
      if (dy < 0 && a.ground) continue
      if (!shotHits(w, a, dx, dy)) continue
      if (rand(br) > 0.35 + 0.6 * br.skill) break
      br.draw = 2 + Math.floor(rand(br) * (2 + 6 * (1 - br.skill)))
      br.aim = bits
      br.script = -1
      return BTN.shoot | bits
    }
  }

  // 3. Goal: arrows when empty, items and chests nearby, otherwise the nearest enemy.
  if (s.time - br.goalAt > 0.35 || br.goal < 0) {
    br.goalAt = s.time
    br.goal = pickGoal(w, a, br, g)
  }

  // A running scripted move plays out until it lands.
  if (br.script >= 0) {
    const i = s.tick - br.scriptAt
    if ((i > 3 && a.ground) || i > 150) br.script = -1
    else return scriptButtons(SCRIPTS[br.script]!, i, a)
  }

  // Stomp: fall onto a head below you.
  if (!a.ground && !a.hang) {
    for (const v of s.archers) {
      if (!v.alive || v === a) continue
      const dx = wrapDelta(v.x - a.x, W), dy = wrapDelta(v.y + HH - a.y, H)
      if (dy < 0 && dy > -5 && Math.abs(dx) < 2.5) return (dx > 0.15 ? BTN.right : dx < -0.15 ? BTN.left : 0) | BTN.down
    }
  }

  if (a.hang) return BTN.jump | (a.hang > 0 ? BTN.right : BTN.left)
  const goalX = goalPoint(w, a, br)
  if (!a.ground) {
    const dx = wrapDelta(goalX - a.x, W)
    return dx > 0.3 ? BTN.right : dx < -0.3 ? BTN.left : 0
  }
  const cur = cellOf(w.arena, a.x, a.y)
  const f = field(g, br.goal)
  if (cur === br.goal) {
    const dx = wrapDelta(goalX - a.x, W)
    return dx > 0.12 ? BTN.right : dx < -0.12 ? BTN.left : 0
  }
  const out = g.edges.get(cur) ?? []
  let best: (typeof out)[number] | null = null
  let bestCost = f.get(cur) ?? Infinity
  for (const e of out) {
    const c = e.cost + (f.get(e.to) ?? Infinity)
    if (c < bestCost - 1e-6) {
      bestCost = c
      best = e
    }
  }
  if (!best) {
    // Unreachable from here: wander with a random move.
    if (!out.length) return rand(br) < 0.5 ? BTN.left : BTN.right
    best = out[Math.floor(rand(br) * out.length)]!
  }
  if (best.move.kind === "walk") return best.move.dir > 0 ? BTN.right : BTN.left
  const dx = wrapDelta(cellX(w.arena, cur) - a.x, W)
  if (Math.abs(dx) > 0.16 || Math.abs(a.vx) > 1.4) return Math.abs(dx) < 0.16 ? 0 : dx > 0 ? BTN.right : BTN.left
  br.script = SCRIPTS.indexOf(best.move.s)
  br.scriptAt = s.tick
  return scriptButtons(best.move.s, 0, a)
}

function pickGoal(w: World, a: Archer, br: BrainState, g: NavGraph): number {
  const s = w.s
  const W = w.arena.w, H = w.arena.h
  const dist = (x: number, y: number) => Math.hypot(wrapDelta(x - a.x, W), wrapDelta(y - a.y, H))
  let tx = a.x, ty = a.y, best = Infinity
  const consider = (x: number, y: number, weight: number) => {
    const d = dist(x, y) * weight
    if (d < best) {
      best = d
      tx = x
      ty = y
    }
  }
  if (!a.quiver.length) for (const r of s.arrows) if (r.state !== "fly") consider(r.x, r.y, 1)
  for (const p of s.pickups) if (p.age > 0.3) consider(p.x, p.y - 0.5, 0.7)
  for (const c of s.chests) if (!c.open) consider(c.x, c.y, 1.3)
  if (best === Infinity || (a.quiver.length && best > 9)) {
    for (const v of s.archers) if (v.alive && v !== a) consider(v.x, v.y, 1)
  }
  if (rand(br) < 0.06) {
    const keys = [...g.edges.keys()]
    return keys[Math.floor(rand(br) * keys.length)]!
  }
  return nearestCell(g, tx, ty + 0.2)
}

function goalPoint(w: World, a: Archer, br: BrainState): number {
  const s = w.s
  let x = cellX(w.arena, br.goal), bd = Infinity
  for (const r of s.arrows) {
    if (r.state === "fly") continue
    const d = Math.abs(wrapDelta(r.x - x, w.arena.w))
    if (d < 1 && d < bd && cellOf(w.arena, r.x, r.y) === br.goal) {
      bd = d
      x = r.x
    }
  }
  void a
  return x
}
