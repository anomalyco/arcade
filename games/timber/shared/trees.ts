// Trees: standing, cut, falling over a hinge at the stump, landing and lying as obstacles. Pure plan-space maths
// (x, y on the ground, height up), shared by the sim, the bots and the ground preview.

/** Height of the cut above the ground: the stump stays, the rest pivots here. */
export const HINGE = 0.55

export type TreeState = "standing" | "falling" | "down"

export type Tree = {
  id: number
  x: number
  y: number
  /** Trunk radius. */
  r: number
  /** Length from the hinge to the tip. */
  h: number
  /** Crown radius and where it starts, as a fraction of `h`. */
  crownR: number
  crown0: number
  /** Cut progress, 0..1; 1 fells it. */
  cut: number
  /** Accumulated push from the cutters' side (falls away from them). */
  cdx: number
  cdy: number
  state: TreeState
  /** Lean from vertical (rad) and its rate. */
  theta: number
  omega: number
  /** Unit fall direction, fixed once it starts to fall. */
  fx: number
  fy: number
  warned: boolean
  /** Spawned partly cut (rotten or notched): domino fodder. */
  notched: boolean
  /** Lumberjack credited with what it crushes (-1 none). */
  credit: number
  bounces: number
  /** Trees this one has already struck on its way down. */
  touched: number[]
  /** Lumberjacks it already crushed. */
  crushed: number[]
  /** Place in a domino chain: 0 for a tree cut through, n for the n-th knocked over after it. */
  chain: number
}

export type FallFeel = {
  warnAt: number
  leanMax: number
  fallGravity: number
  fallKick: number
  bounce: number
  dominoThreshold: number
  dominoTransfer: number
  crushScale: number
}

/** Angle at which the trunk, pivoting at the stump top, lies on the ground. */
export const landAngle = (t: Pick<Tree, "h">) => Math.PI / 2 + Math.atan(HINGE / t.h)

/** Where a tree would fall now: its accumulated cut side, else away from (fromX, fromY). */
export function predictedFall(t: Tree, fromX: number, fromY: number, weight = 0.25): { x: number; y: number } {
  if (t.state !== "standing") return { x: t.fx, y: t.fy }
  let dx = t.x - fromX
  let dy = t.y - fromY
  const l = Math.hypot(dx, dy) || 1
  dx = t.cdx + (dx / l) * weight
  dy = t.cdy + (dy / l) * weight
  const m = Math.hypot(dx, dy)
  return m > 1e-6 ? { x: dx / m, y: dy / m } : { x: 1, y: 0 }
}

/** A point relative to a fall line from the tree: distance along it and to the side. */
export function alongFall(t: Pick<Tree, "x" | "y">, fx: number, fy: number, px: number, py: number): { s: number; d: number } {
  const dx = px - t.x
  const dy = py - t.y
  return { s: dx * fx + dy * fy, d: Math.abs(dx * fy - dy * fx) }
}

/** Half-width the tree sweeps at distance `s` along its fall line (trunk below the crown, crown above). */
export function sweepHalfWidth(t: Pick<Tree, "h" | "r" | "crownR" | "crown0">, s: number, crushScale = 1): number {
  const c0 = t.crown0 * t.h
  if (s < c0) return t.r
  // Conifer crown: widest at its base, narrowing to the tip.
  const k = Math.min(1, (s - c0) / Math.max(1e-3, t.h - c0))
  return t.r + t.crownR * (1 - k * 0.75) * crushScale
}

/** Is (px, py) inside the strip a tree falling along (fx, fy) will land on? `pad` widens it. */
export function inFallZone(t: Tree, fx: number, fy: number, px: number, py: number, pad = 0): boolean {
  const { s, d } = alongFall(t, fx, fy, px, py)
  if (s < -pad || s > t.h + HINGE + pad) return false
  return d < sweepHalfWidth(t, Math.max(0, s)) + pad
}

/** Height of the falling trunk above the ground at distance `s` along the fall line (Infinity past its reach). */
export function trunkHeightAt(t: Tree, s: number): number {
  const sin = Math.sin(t.theta)
  const reach = t.h * sin
  if (s > reach || s < 0 || sin < 1e-6) return Infinity
  // Past horizontal (it lands below the hinge) cos goes negative and the trunk slopes down to the ground.
  return Math.max(0, HINGE + (s * Math.cos(t.theta)) / sin)
}

/** Tip of a fallen or falling tree in plan. */
export function tipOf(t: Tree): { x: number; y: number } {
  const reach = t.h * Math.sin(Math.min(t.theta, Math.PI / 2))
  return { x: t.x + t.fx * reach, y: t.y + t.fy * reach }
}

/** Start a tree falling along (fx, fy). */
export function fell(t: Tree, fx: number, fy: number, theta: number, omega: number, credit: number): void {
  const l = Math.hypot(fx, fy) || 1
  t.state = "falling"
  t.fx = fx / l
  t.fy = fy / l
  t.theta = Math.max(t.theta, theta)
  t.omega = Math.max(t.omega, omega)
  t.cut = Math.max(t.cut, 1)
  t.credit = credit
}

/** Lean of a standing tree from its cut: none until the warning, then a creaking tilt toward its fall. */
export function standingLean(t: Tree, feel: Pick<FallFeel, "warnAt" | "leanMax">): number {
  if (t.cut < feel.warnAt) return 0
  return feel.leanMax * Math.min(1, (t.cut - feel.warnAt) / Math.max(1e-3, 1 - feel.warnAt))
}

/**
 * Rigid rod hinged at its base: theta'' = (3 g / 2 L) sin(theta). Slow start, fast end. Returns "land" on the first
 * ground strike and "settle" when it comes to rest.
 */
export function stepFall(t: Tree, dt: number, feel: Pick<FallFeel, "fallGravity" | "bounce">): "land" | "settle" | null {
  if (t.state !== "falling") return null
  const k = (1.5 * feel.fallGravity) / t.h
  t.omega += k * Math.sin(t.theta) * dt
  t.theta += t.omega * dt
  const ground = landAngle(t)
  if (t.theta < ground) return null
  t.theta = ground
  if (t.bounces === 0 && t.omega > 0.4 && feel.bounce > 0) {
    t.bounces = 1
    t.omega = -t.omega * feel.bounce
    return "land"
  }
  const first = t.bounces === 0
  t.omega = 0
  t.state = "down"
  return first ? "land" : "settle"
}
