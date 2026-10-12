import { DT, LOADOUT_SECONDS } from "../shared/config"
import { type Intent, NO_INTENT, type Player, World } from "../shared/sim/world"

/** A world in its first live round with only the given humans (bots removed so their noise doesn't leak into assertions). */
export function liveWorld(names: string[] = ["a", "b"], seed = 11): World {
  const w = new World(seed, "tdm", 3)
  for (const n of names) w.addHuman(n, n)
  w.startMatch("tdm", 3)
  for (let i = 0; i < Math.round(LOADOUT_SECONDS / DT) + 2 && w.phase !== "live"; i++) w.step()
  for (const p of [...w.players.values()]) if (!p.human) w.removePlayer(p.id)
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

export function run(w: World, seconds: number, intent: (tick: number) => Intent = () => NO_INTENT): void {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    for (const p of w.players.values()) {
      if (!p.human) continue
      w.push(p.id, w.tick * 10 + 1 + i, intent(i))
    }
    w.step()
  }
}

export function intent(over: Partial<Intent>): Intent {
  return { ...NO_INTENT, ...over }
}
