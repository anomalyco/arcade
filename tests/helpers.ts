import { DT, LOADOUT_SECONDS } from "../shared/config"
import { type Intent, NO_INTENT, type Player, World } from "../shared/sim/world"

/** A world in its first live round with only the named humans: bots are removed so nothing else makes noise. */
export function liveWorld(names: string[] = ["a", "b"], mode: "tdm" | "ffa" = "tdm"): World {
  const w = new World(11)
  for (const n of names) w.addHuman(n, n)
  w.start(mode, 3)
  for (const p of [...w.players.values()]) if (!p.human) w.remove(p.id)
  for (let i = 0; i < Math.round(LOADOUT_SECONDS / DT) + 2 && w.phase !== "live"; i++) w.step()
  w.takeEvents()
  return w
}

/** Turns every light off so only the rules under test light anything. */
export function darken(w: World): void {
  for (const s of w.level.lamps) s.broken = true
  w.step()
  w.takeEvents()
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
/** Steps the world, feeding every human the intent from `f` (tick index → intent). */
export function run(w: World, seconds: number, f: (tick: number, id: string) => Intent = () => NO_INTENT): void {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    seq++
    for (const p of w.players.values()) if (p.human) w.push(p.id, seq, f(i, p.id))
    w.step()
  }
}

export const intent = (over: Partial<Intent>): Intent => ({ ...NO_INTENT, ...over })

/** An empty, unlit spot on the office map for isolated tests. */
export const SPOT = { x: 12.5, y: 18 }
