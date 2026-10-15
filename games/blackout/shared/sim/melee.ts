import { clearLine } from "../geom"
import { angleDiff } from "../geom"
import { type Player, type World, rewindable } from "./world"

/**
 * Melee: a swipe that lands `windup` seconds after the press and kills the nearest enemy within `range` metres
 * (centre to centre) and `arc` radians either side of the aim, with no wall between. Then `cooldown` seconds until
 * the next swing, counted from the press.
 */
export const MELEE = { windup: 0.15, cooldown: 0.6, range: 1.5, arc: 1.05 }

/** Whether a swing can start now. */
export const canSwing = (p: Player, now: number): boolean => p.alive && p.kit.melee && p.swingAt === 0 && now >= p.meleeReadyAt

/** Starts a swing: it lands after the wind-up. */
export function startSwing(w: World, p: Player, view?: number): void {
  p.swingAt = w.time + MELEE.windup
  p.swingView = view !== undefined && p.human ? view + MELEE.windup : undefined
  p.meleeReadyAt = w.time + MELEE.cooldown
  w.events.push({ k: "swing", by: p.id })
}

/** Who a swing from `p` along its aim would hit right now, or null. */
export function swingTarget(w: World, p: Player): Player | null {
  let best: Player | null = null
  let bd = Infinity
  for (const q of w.players.values()) {
    if (!q.alive || q === p || w.allies(p, q)) continue
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d > MELEE.range || d >= bd) continue
    if (d > 0.05 && Math.abs(angleDiff(Math.atan2(q.y - p.y, q.x - p.x), p.aim)) > MELEE.arc) continue
    if (!clearLine(p.x, p.y, q.x, q.y, w.blockers)) continue
    best = q
    bd = d
  }
  return best
}

/** A pending swing lands once its wind-up is over: one hit kills. */
export function stepSwing(w: World, p: Player): void {
  if (p.swingAt === 0 || w.time < p.swingAt) return
  p.swingAt = 0
  const view = p.swingView
  p.swingView = undefined
  if (w.spells) w.spells.bonk(w, p)
  const q =
    view !== undefined
      ? w.rewind.withRewoundPositions([...w.players.values()].filter(rewindable), view, () => swingTarget(w, p), p.id)
      : swingTarget(w, p)
  if (q) w.damage(q, w.spells ? p.kit.damage : q.health + 1000, p, "melee", p.x, p.y)
}
