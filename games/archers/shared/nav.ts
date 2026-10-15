import { type Arena, mod, solidAt } from "./arena"
import { BTN, type Buttons } from "./input"
import { DEFAULT_TUNING, type Tuning } from "./tuning"
import { type Archer, World, newArcher, newState } from "./world"

/**
 * A move a bot can make from a standing cell: walk one tile, or a scripted jump, drop or wall-jump chain. Scripted
 * moves were found by replaying the real movement code from that cell, so bots only try what the sim allows
 * (including ledge grabs and wall slides).
 */
export type Move = { kind: "walk"; dir: -1 | 1 } | { kind: "script"; s: Script }
export type Script =
  | { type: "jump"; dir: -1 | 0 | 1; hold: number; steer: number }
  | { type: "drop"; dir: -1 | 1; steer: number }
  | { type: "wall"; dir: -1 | 1 }
export type Edge = { to: number; cost: number; move: Move }

export type NavGraph = {
  arena: Arena
  /** Cell index (ty * w + tx) of every place an archer can stand, and the moves out of it. */
  edges: Map<number, Edge[]>
  /** Reverse edges, for distance fields toward a goal. */
  into: Map<number, (Edge & { from: number })[]>
}

export const cellOf = (a: Arena, x: number, y: number) => mod(Math.floor(y + 0.05), a.h) * a.w + mod(Math.floor(x), a.w)
export const cellX = (a: Arena, c: number) => (c % a.w) + 0.5
export const cellY = (a: Arena, c: number) => Math.floor(c / a.w)

export function standable(a: Arena, tx: number, ty: number): boolean {
  return !solidAt(a, tx, ty) && !solidAt(a, tx, ty + 1) && solidAt(a, tx, ty - 1)
}

/** Buttons for tick `i` of a scripted move, given the archer's live state (hangs climb, wall slides kick off). */
export function scriptButtons(s: Script, i: number, a: Archer): Buttons {
  const dirBtn = (d: number) => (d > 0 ? BTN.right : d < 0 ? BTN.left : 0)
  switch (s.type) {
    case "jump": {
      let b = i < s.steer ? dirBtn(s.dir) : 0
      if (i < s.hold) b |= BTN.jump
      // Caught a ledge: climb it.
      if (a.hang) b = i % 2 ? BTN.jump | dirBtn(a.hang) : dirBtn(a.hang)
      return b
    }
    case "drop":
      return i < s.steer ? dirBtn(s.dir) : 0
    case "wall": {
      // Jump at the wall, slide, kick off, steer back, repeat: climbs a single wall.
      if (a.hang) return i % 2 ? BTN.jump | dirBtn(a.hang) : dirBtn(a.hang)
      if (i < 10) return dirBtn(s.dir) | BTN.jump
      if (a.wall === s.dir && !(a.prev & BTN.jump)) return BTN.jump | dirBtn(-s.dir)
      if (a.lock > 0) return dirBtn(-s.dir) | BTN.jump
      return dirBtn(s.dir) | (a.vy > 0 ? BTN.jump : 0)
    }
  }
}

export const SCRIPTS: Script[] = (() => {
  const out: Script[] = []
  for (const dir of [-1, 0, 1] as const) for (const hold of [5, 40]) for (const steer of [7, 16, 999]) {
    if (dir === 0 && steer !== 999) continue
    out.push({ type: "jump", dir, hold, steer })
  }
  for (const dir of [-1, 1] as const) for (const steer of [9, 999]) out.push({ type: "drop", dir, steer })
  for (const dir of [-1, 1] as const) out.push({ type: "wall", dir })
  return out
})()

const MAX_TICKS = 150
const cache = new Map<string, NavGraph>()

/** The nav graph for an arena and tuning, built once (a few hundred ms at most) and cached. */
export function navGraph(arena: Arena, t: Tuning = DEFAULT_TUNING): NavGraph {
  const key = `${arena.id}:${JSON.stringify(t)}`
  const hit = cache.get(key)
  if (hit) return hit
  const w = new World(newState(1, arena.id), t)
  const edges = new Map<number, Edge[]>()
  const cells: number[] = []
  for (let ty = 0; ty < arena.h; ty++) for (let tx = 0; tx < arena.w; tx++) if (standable(arena, tx, ty)) cells.push(ty * arena.w + tx)
  const isCell = new Set(cells)
  const a = newArcher("nav", 0, "nav", true)
  for (const c of cells) {
    const tx = c % arena.w, ty = Math.floor(c / arena.w)
    const list: Edge[] = []
    for (const dir of [-1, 1] as const) {
      const n = ty * arena.w + mod(tx + dir, arena.w)
      if (isCell.has(n)) list.push({ to: n, cost: 9, move: { kind: "walk", dir } })
    }
    const best = new Map<number, Edge>()
    for (const s of SCRIPTS) {
      if (s.type === "drop" && isCell.has(ty * arena.w + mod(tx + s.dir, arena.w))) continue
      Object.assign(a, newArcher("nav", 0, "nav", true))
      a.alive = true
      a.x = tx + 0.5
      a.y = ty
      a.ground = true
      let left = false
      for (let i = 0; i < MAX_TICKS; i++) {
        w.stepSolo(a, scriptButtons(s, i, a))
        if (!a.ground) left = true
        if (left && a.ground) {
          const to = cellOf(arena, a.x, a.y)
          if (to !== c && isCell.has(to)) {
            const cost = i + 6
            const prev = best.get(to)
            if (!prev || prev.cost > cost) best.set(to, { to, cost, move: { kind: "script", s } })
          }
          break
        }
      }
    }
    list.push(...best.values())
    edges.set(c, list)
  }
  const into = new Map<number, (Edge & { from: number })[]>()
  for (const [from, list] of edges) for (const e of list) {
    let l = into.get(e.to)
    if (!l) into.set(e.to, (l = []))
    l.push({ ...e, from })
  }
  const g: NavGraph = { arena, edges, into }
  cache.set(key, g)
  // The Lab's move knobs make a graph per tuning they pass through; keep the newest few.
  while (cache.size > 6) cache.delete(cache.keys().next().value!)
  return g
}

/** Cost to reach `goal` from every cell (Dijkstra on reverse edges; graphs are small). */
export function distanceField(g: NavGraph, goal: number): Map<number, number> {
  const dist = new Map<number, number>([[goal, 0]])
  const open: [number, number][] = [[0, goal]]
  while (open.length) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (open[i]![0] < open[bi]![0]) bi = i
    const [d, c] = open.splice(bi, 1)[0]!
    if (d > (dist.get(c) ?? Infinity)) continue
    for (const e of g.into.get(c) ?? []) {
      const nd = d + e.cost
      if (nd < (dist.get(e.from) ?? Infinity)) {
        dist.set(e.from, nd)
        open.push([nd, e.from])
      }
    }
  }
  return dist
}

/** The standable cell nearest to a point (searching down first, since things rest on floors). */
export function nearestCell(g: NavGraph, x: number, y: number): number {
  const a = g.arena
  const tx = mod(Math.floor(x), a.w)
  for (let dy = 0; dy < a.h; dy++) {
    for (const ox of [0, -1, 1, -2, 2]) {
      const c = mod(Math.floor(y) - dy, a.h) * a.w + mod(tx + ox, a.w)
      if (g.edges.has(c)) return c
    }
  }
  return g.edges.keys().next().value ?? 0
}
