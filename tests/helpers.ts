import { DT, LOADOUT_SECONDS } from "../shared/config"
import { Builder } from "../shared/maps/builder"
import type { MapDef } from "../shared/maps"
import { type Intent, NO_INTENT, type Player, World } from "../shared/sim/world"

/**
 * A small fixed map for rule tests, 40 x 20 m:
 * - a wall at x = 10 from y = 0 to 8
 * - a pendant lamp at (30, 15), radius 6.5
 * - a glass pane at x = 5, y = 12..16
 * - a grate at x = 34..38, y = 2..6
 */
export function testMap(): MapDef {
  const b = new Builder()
  b.floor("carpet", 0, 0, 40, 20)
  b.wall(0, 0, 40, 0.3)
  b.wall(0, 19.7, 40, 20)
  b.wall(0, 0, 0.3, 20)
  b.wall(39.7, 0, 40, 20)
  b.wall(10, 0, 10.3, 8)
  b.light({ kind: "pendant", x: 30, y: 15, h: 2.2, r: 6.5, power: 1, color: [1, 1, 1], shootable: true })
  b.pane(4.94, 12, 5.06, 16)
  b.noisy.push({ rect: [34, 2, 38, 6], kind: "grate" })
  b.spawns.push({ x: 3, y: 3 }, { x: 3, y: 17 }, { x: 18, y: 3 }, { x: 22, y: 17 })
  return b.build({ id: "test", seed: 0, name: "Test", blurb: "", size: [40, 20], ambient: [0, 0, 0] })
}

/** A world on the test map in its first live round with only the named humans (no bots, so nothing else makes noise). */
export function liveWorld(names: string[] = ["a", "b"], mode: "tdm" | "ffa" = "tdm"): World {
  const w = new World(11, testMap())
  for (const n of names) w.addHuman(n, n)
  w.start(mode, 3)
  for (const p of [...w.players.values()]) if (!p.human) w.remove(p.id)
  for (let i = 0; i < Math.round(LOADOUT_SECONDS / DT) + 2 && w.phase !== "live"; i++) w.step()
  w.takeEvents()
  return w
}

export function place(w: World, id: string, x: number, y: number): Player {
  const p = w.players.get(id)!
  p.x = x
  p.y = y
  p.vx = 0
  p.vy = 0
  return p
}

let seq = 1
/** Steps the world, feeding every human the intent from `f`. */
export function run(w: World, seconds: number, f: (tick: number, id: string) => Intent = () => NO_INTENT): void {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    seq++
    for (const p of w.players.values()) if (p.human) w.push(p.id, seq, f(i, p.id))
    w.step()
  }
}

export const intent = (over: Partial<Intent>): Intent => ({ ...NO_INTENT, ...over })
