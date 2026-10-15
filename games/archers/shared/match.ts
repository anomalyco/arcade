import type { RollbackSim } from "@arcade/kit/net/rollback"
import { botButtons } from "./bots"
import { MAX_PLAYERS } from "./config"
import type { Frame } from "./protocol"
import { DEFAULT_TUNING, type Tuning } from "./tuning"
import { type SimEvent, World } from "./world"

/** Each slot's colour name, shown for bots and for people who didn't give one. */
export const SLOT_NAMES = ["TEAL", "WINE", "MOSS", "OCHRE"] as const

/** An online match: four slots `a0`–`a3`, all bots until people take them. */
export function newMatch(seed: number, arena: string, t: Tuning = DEFAULT_TUNING): World {
  const w = World.create(seed, arena, t)
  for (let i = 0; i < MAX_PLAYERS; i++) w.add(`a${i}`, SLOT_NAMES[i]!, true)
  return w
}

/** One tick of a frame: seat changes first, then people's buttons by slot and bots' from their brains. */
export function runFrame(w: World, f: Frame): SimEvent[] {
  for (const c of f.c ?? []) {
    const a = w.s.archers.find((x) => x.slot === c.slot)
    if (!a) continue
    a.bot = !c.human
    a.name = c.name
    // A bot starts thinking afresh; a person drops the bot's mind.
    delete w.s.brains[a.id]
  }
  w.step((a) => (a.bot ? botButtons(w, a) : (f.i[a.slot] ?? 0)))
  return w.takeEvents()
}

/** FNV-1a over the world's JSON (which writes -0 as 0, harmless here): equal hashes, equal worlds. */
export function hashWorld(w: World): number {
  const j = JSON.stringify(w.s)
  let h = 0x811c9dc5
  for (let i = 0; i < j.length; i++) h = Math.imul(h ^ j.charCodeAt(i), 0x01000193)
  return h >>> 0
}

export const cloneWorld = (w: World) => new World(structuredClone(w.s), w.t)

/** Who each event is about, so a re-simulated one isn't shown twice (`RollbackSim.sig`). */
export function eventSig(e: SimEvent): string {
  switch (e.k) {
    case "stick":
      return `stick:${e.id}`
    case "kill":
      return `kill:${e.victim}`
    case "shoot":
    case "catch":
    case "laser":
    case "boom":
      return `${e.k}:${e.by}`
    case "chest":
      return `chest:${Math.round(e.x)}:${Math.round(e.y)}`
    case "bramble":
      return `bramble:${Math.round(e.x0)}:${Math.round(e.y0)}`
    case "phase":
      return `phase:${e.phase}`
    default:
      return `${e.k}:${e.id}`
  }
}

/** The rollback contract for a client sitting in `slot`. */
export function rollbackSim(slot: () => number): RollbackSim<World, Frame, SimEvent> {
  return {
    clone: cloneWorld,
    step: runFrame,
    predict(last, own) {
      const i = last.i.slice()
      const me = slot()
      if (own !== undefined && me >= 0) i[me] = own
      return { i }
    },
    sig: eventSig,
  }
}
