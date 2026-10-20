import type { ActionGlyph } from "@arcade/kit/client/action-glyphs"
import type { CoopSim } from "../../shared/coop-sim"
import {
  TRAINING_BENCH,
  TRAINING_CHAIN,
  TRAINING_DRESSER,
  TRAINING_FRONT_DOOR,
  TRAINING_GLASS,
  TRAINING_ROOM_DOOR,
  TRAINING_START,
  TRAINING_WINDOW,
  type TrainingState,
} from "../../shared/onboarding/training"

/** The training room's beats in the order the house lays them out: bedroom, hall door, kitchen window, front yard. */
export const BEATS = ["move", "light", "search", "take", "craft", "door-open", "door-close", "crouch", "board", "sprint", "front-door", "melee"] as const
export type BeatId = (typeof BEATS)[number]

/**
 * Beats that are places, not skills: doing one means the player has moved on, so the beats before it are passed
 * rather than nagged about. Moving, the light, crouching and sprinting can happen any time and skip nothing.
 */
const MILESTONES: ReadonlySet<BeatId> = new Set(["search", "door-open", "board", "front-door", "melee"])

/** A key in a hint: its physical code, drawn as the shared key cap (hold for crouch). */
export type HintKey = { code: string; hold?: boolean }

/** What the room shows for the current beat: key caps and a glyph, on the survivor or over the thing to use. */
export type BeatHint = {
  beat: BeatId
  keys: readonly HintKey[]
  glyph?: ActionGlyph
  /** Over a place (world x, height, y) or on the survivor. */
  at: { x: number; y: number; z: number } | "self"
  /** The prompt's target id (or kind) that makes this hint redundant: the world prompt already says it there. */
  target?: string
  targetKind?: string
}

const MOVE: readonly HintKey[] = [{ code: "KeyW" }, { code: "KeyA" }, { code: "KeyS" }, { code: "KeyD" }]

function portalCentre(sim: CoopSim, id: string, z: number): { x: number; y: number; z: number } {
  const o = sim.town.doors.find((d) => d.id === id) ?? sim.town.windows.find((w) => w.id === id)
  const r = o?.rect ?? [0, 0, 0, 0]
  return { x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2, z }
}

/**
 * Follows a player through the training room: which beats are done (sticky), which one to hint, and when the house
 * is behind them. Pure over the sim and the frame time, so tests drive it with a `LocalSession`.
 */
export class TrainingGuide {
  readonly done = new Set<BeatId>()
  private sprintFor = 0
  private crouchFor = 0

  step(sim: CoopSim, actorId: string, dt: number): BeatId | null {
    const slot = sim.slot(actorId)
    if (!slot) return null
    const p = slot.survivor
    const ledger = sim.progression.ledger
    const door = (id: string) => sim.town.doors.find((d) => d.id === id)
    const mark = (beat: BeatId, ok: boolean) => {
      if (ok) this.done.add(beat)
    }
    if (p.sprinting && Math.hypot(p.vx, p.vy) > 0.5) this.sprintFor += dt
    const nearGlass = Math.hypot(p.x - TRAINING_GLASS.x, p.y - TRAINING_GLASS.y) < 2.6
    if (p.crouching && nearGlass) this.crouchFor += dt
    mark("move", Math.hypot(p.x - TRAINING_START.x, p.y - TRAINING_START.y) > 1.5)
    mark("light", Boolean(p.flashlightOn))
    mark("search", Boolean(ledger.store(TRAINING_DRESSER)?.revealed))
    mark("take", this.done.has("search") && (ledger.count(actorId, "plank") > 0 || ledger.count(actorId, "chem") > 0))
    mark("craft", ledger.count(actorId, "bandage") > 0)
    mark("door-open", Boolean(door(TRAINING_ROOM_DOOR)?.open))
    mark("door-close", this.done.has("door-open") && !door(TRAINING_ROOM_DOOR)?.open && p.y > 30)
    mark("crouch", this.crouchFor > 0.3)
    mark("board", sim.ai.getBarricadePlanks(TRAINING_WINDOW) > 0)
    mark("sprint", this.sprintFor > 0.6)
    mark("front-door", Boolean(door(TRAINING_FRONT_DOOR)?.open) || p.y > 35.8)
    mark("melee", !this.chainedAlive(sim))
    return this.current()
  }

  /** The beat to hint: the first not done, unless a later place has been reached past it. */
  current(): BeatId | null {
    let furthest = -1
    BEATS.forEach((b, i) => {
      if (MILESTONES.has(b) && this.done.has(b)) furthest = i
    })
    for (let i = 0; i < BEATS.length; i++) {
      const b = BEATS[i]!
      if (this.done.has(b)) continue
      if (i < furthest && !["move", "light", "sprint"].includes(b)) continue
      return b
    }
    return null
  }

  private chainedAlive(sim: CoopSim): boolean {
    const state = sim.getFeatureState<TrainingState>("onboarding")
    const z = state ? sim.ai.agents.find((a) => a.id === state.chained) : undefined
    return Boolean(z && z.state !== "dead")
  }

  /** Where and how the current beat is shown, or null for none (the yard needs no pointer). */
  hint(sim: CoopSim, actorId: string, beat: BeatId | null): BeatHint | null {
    if (!beat) return null
    const p = sim.slot(actorId)?.survivor
    if (!p) return null
    const ledger = sim.progression.ledger
    const dresser = ledger.store(TRAINING_DRESSER)?.at
    const atDresser = dresser ? { x: dresser.x, y: dresser.y, z: 1.25 } : "self"
    switch (beat) {
      case "move":
        return { beat, keys: MOVE, at: "self" }
      case "light":
        return { beat, keys: [{ code: "KeyF" }], glyph: "light-on", at: "self" }
      case "search":
        return { beat, keys: [{ code: "KeyE" }], glyph: "search", at: atDresser, target: TRAINING_DRESSER }
      case "take":
        return { beat, keys: [{ code: "KeyE" }], glyph: "take-all", at: atDresser, target: TRAINING_DRESSER }
      case "craft": {
        const bench = ledger.store(TRAINING_BENCH)?.at
        return { beat, keys: [{ code: "KeyE" }], glyph: "tinker", at: bench ? { x: bench.x, y: bench.y, z: 1.3 } : "self", targetKind: "bench" }
      }
      case "door-open":
        return { beat, keys: [{ code: "KeyE" }], glyph: "door-open", at: portalCentre(sim, TRAINING_ROOM_DOOR, 1.5), target: TRAINING_ROOM_DOOR }
      case "door-close":
        // Shut it behind you, once through.
        return p.y > 30 ? { beat, keys: [{ code: "KeyE" }], glyph: "door-close", at: portalCentre(sim, TRAINING_ROOM_DOOR, 1.5), target: TRAINING_ROOM_DOOR } : null
      case "crouch":
        return Math.hypot(p.x - TRAINING_GLASS.x, p.y - TRAINING_GLASS.y) < 4.5 ? { beat, keys: [{ code: "ControlLeft", hold: true }], at: "self" } : null
      case "board":
        // No planks yet: back to the dresser that has them.
        if (ledger.count(actorId, "plank") <= 0) return { beat, keys: [{ code: "KeyE" }], glyph: "search", at: atDresser, target: TRAINING_DRESSER }
        return { beat, keys: [{ code: "KeyB" }], glyph: "board-up", at: portalCentre(sim, TRAINING_WINDOW, 1.6), target: TRAINING_WINDOW }
      case "sprint":
        return Math.hypot(p.vx, p.vy) > 0.4 ? { beat, keys: [{ code: "ShiftLeft" }], at: "self" } : null
      case "front-door":
        return { beat, keys: [{ code: "KeyE" }], glyph: "door-open", at: portalCentre(sim, TRAINING_FRONT_DOOR, 1.5), target: TRAINING_FRONT_DOOR }
      case "melee": {
        const state = sim.getFeatureState<TrainingState>("onboarding")
        const z = state ? sim.ai.agents.find((a) => a.id === state.chained) : undefined
        return { beat, keys: [{ code: "KeyV" }], glyph: "smash", at: z ? { x: z.x, y: z.y, z: 2.0 } : { x: TRAINING_CHAIN.x, y: TRAINING_CHAIN.y, z: 2.0 } }
      }
    }
  }
}
