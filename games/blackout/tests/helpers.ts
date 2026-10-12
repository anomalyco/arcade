import { DT } from "../shared/config"
import { Builder } from "../shared/maps/builder"
import type { MapDef } from "../shared/maps"
import { type Intent, NO_INTENT, type Player, World } from "../shared/sim/world"

/** A 40 x 20 m test room with a wall at x = 10 from y = 0 to 8. */
export function testMap(): MapDef {
  const b = new Builder()
  b.floor("carpet", 0, 0, 40, 20)
  b.wall(0, 0, 40, 0.3)
  b.wall(0, 19.7, 40, 20)
  b.wall(0, 0, 0.3, 20)
  b.wall(39.7, 0, 40, 20)
  b.wall(10, 0, 10.3, 8)
  b.spawns.push({ x: 3, y: 3 }, { x: 3, y: 17 }, { x: 37, y: 3 }, { x: 37, y: 17 })
  return b.build({ id: "test", seed: 0, name: "Test", size: [40, 20] })
}

/** A world on the test map with only the named humans (no bots). */
export function world(names: string[] = ["a", "b"]): World {
  const w = new World(11, testMap())
  for (const n of names) w.addHuman(n, n)
  for (const p of [...w.players.values()]) if (!p.human) w.remove(p.id)
  w.step()
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
export function run(w: World, seconds: number, f: (id: string) => Partial<Intent> = () => ({})): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    seq++
    for (const p of w.players.values()) if (p.human) w.push(p.id, seq, { ...NO_INTENT, ...f(p.id) })
    w.step()
  }
}
