import { describe, expect, test } from "bun:test"
import { DEFAULT_PROGRESSION_TUNING } from "../shared/progression/tuning"
import {
  createTrainingState,
  leftTheHouse,
  PRACTICE_RESPAWN_SECONDS,
  TRAINING_CHAIN,
  TRAINING_DRESSER,
  TRAINING_HOUR,
  TRAINING_START,
  trainingDamage,
  type TrainingState,
} from "../shared/onboarding/training"
import { LocalSession } from "../shared/session"
import type { LoadoutId } from "../shared/loadout"
import { CoopRoomCore } from "../server/room-core"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { lobbyKeyAction } from "../src/lobby/keys"
import { BEATS, TrainingGuide } from "../src/onboarding/beats"
import { outbreakOnboardingFeature } from "../src/onboarding"
import { quietHint, startPractice, stepPractice } from "../src/onboarding/practice"
import { boardsUp, carryBoards, isPracticeSession, isTrainingSession, stageTrainingSession } from "../src/onboarding/session"
import { stageBeat } from "../src/onboarding/stage"
import {
  DEFAULT_TRAINING_SETTINGS,
  forgetTraining,
  PRACTICE_OFF,
  markTrainingDone,
  requestTraining,
  takeTrainingRequest,
  TRAINING_ALWAYS,
  TRAINING_FIRST_TIME,
  TRAINING_OFF,
  trainingDone,
} from "../src/onboarding/state"

const TICK = 1 / 60

function memory(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    },
  }
}

function room() {
  const session = stageTrainingSession(new LocalSession(7))
  const p = session.view.player
  const guide = new TrainingGuide()
  const step = (cmd: Record<string, unknown> = {}, n = 1) => {
    for (let i = 0; i < n; i++) {
      session.update(TICK, { mx: 0, my: 0, aim: p.aim, ...cmd } as never, 240)
      guide.step(session.sim, session.view.actorId, TICK)
    }
  }
  const at = (x: number, y: number, aim: number) => {
    Object.assign(p, { x, y, aim, vx: 0, vy: 0 })
    step({ aim })
  }
  return { session, p, guide, step, at }
}

describe("training room", () => {
  test("dawn held, one chained zombie, you beside the bed with no planks", () => {
    const { session, p, step } = room()
    expect(isTrainingSession(session)).toBe(true)
    expect([p.x, p.y]).toEqual([TRAINING_START.x, TRAINING_START.y])
    expect(session.sim.progression.ledger.count(session.view.actorId, "plank")).toBe(0)
    step({}, 60 * 20)
    expect(session.view.hour).toBeCloseTo(TRAINING_HOUR)
    expect(session.view.zombies.length).toBe(1)
    const z = session.view.zombies[0]!
    expect(Math.hypot(z.x - TRAINING_CHAIN.x, z.y - TRAINING_CHAIN.y)).toBeLessThanOrEqual(TRAINING_CHAIN.length + 1e-6)
  })

  test("the chain holds when you stand in reach of it", () => {
    const { session, p, step, at } = room()
    at(TRAINING_CHAIN.x, TRAINING_CHAIN.y + 3.2, -Math.PI / 2)
    step({ aim: -Math.PI / 2 }, 60 * 6)
    const z = session.view.zombies[0]!
    expect(Math.hypot(z.x - TRAINING_CHAIN.x, z.y - TRAINING_CHAIN.y)).toBeLessThanOrEqual(TRAINING_CHAIN.length + 1e-6)
    expect(p.health).toBeGreaterThan(0)
  })

  test("training never kills", () => {
    const state: TrainingState = { active: true, chained: 1, practice: false, respawnAt: -1 }
    expect(trainingDamage({ health: 100 }, 40, state)).toBe(10)
    expect(trainingDamage({ health: 21 }, 40, state)).toBe(1)
    expect(trainingDamage({ health: 15 }, 40, state)).toBe(0)
    expect(trainingDamage({ health: 100 }, 40, createTrainingState())).toBe(40)
  })

  test("a real run's sim is untouched by the feature", () => {
    const s = new LocalSession(7)
    expect(isTrainingSession(s)).toBe(false)
    const before = s.view.zombies.length
    for (let i = 0; i < 120; i++) s.update(TICK, { mx: 0, my: 0, aim: 0 } as never, 240)
    expect(s.view.zombies.length).toBeGreaterThanOrEqual(before)
    expect(s.view.hour).not.toBeCloseTo(TRAINING_HOUR)
  })

  test("walking the house completes every beat in order, then the street ends it", () => {
    const { session, p, guide, step, at } = room()
    const ledger = session.sim.progression.ledger
    const id = session.view.actorId
    expect(guide.current()).toBe("move")
    at(28.5, 27.2, 0)
    expect(guide.done.has("move")).toBe(true)
    step({ flashlight: true })
    expect(guide.done.has("light")).toBe(true)
    // The dresser: search it, then take what is in it.
    at(29.6, 26.0, -Math.PI / 2)
    expect(session.view.prompt?.id).toBe(TRAINING_DRESSER)
    expect(guide.current()).toBe("search")
    step({ interact: true, aim: -Math.PI / 2 })
    step({ aim: -Math.PI / 2 }, 60 * 3)
    expect(guide.done.has("search")).toBe(true)
    step({ interact: true, aim: -Math.PI / 2 })
    step({ aim: -Math.PI / 2 }, 30)
    expect(ledger.count(id, "plank")).toBe(2)
    expect(guide.done.has("take")).toBe(true)
    // Tab: the case opens (the client tells the guide; the sim never sees it).
    expect(guide.current()).toBe("case")
    guide.noteCase()
    // The recipe board filled in the bandage from the chemicals: make one at the bench.
    at(30.2, 27.4, -Math.PI / 4)
    expect(session.view.prompt?.kind).toBe("bench")
    step({ pick: { mode: "craft", index: session.sim.progression.craftable().findIndex((r) => r.id === "bandage") }, aim: p.aim })
    step({ aim: p.aim }, 60 * 4)
    expect(ledger.count(id, "bandage")).toBeGreaterThan(0)
    expect(guide.current()).toBe("door-open")
    // Through the hall door and shut it behind.
    at(27.7, 28.8, Math.PI / 2)
    step({ interact: true, aim: Math.PI / 2 })
    expect(guide.done.has("door-open")).toBe(true)
    at(27.7, 30.35, -Math.PI / 2)
    step({ interact: true, aim: -Math.PI / 2 })
    expect(guide.done.has("door-close")).toBe(true)
    // Crouch over the glass and board the window the dead came through.
    at(35.9, 30.2, 0)
    step({ crouch: true, aim: 0 }, 30)
    expect(guide.done.has("crouch")).toBe(true)
    expect(session.view.prompt?.id).toBe("ash-east")
    step({ barricade: true, aim: 0 })
    step({ aim: 0 }, Math.ceil((DEFAULT_PROGRESSION_TUNING.barricadeTime + 0.2) / TICK))
    expect(guide.done.has("board")).toBe(true)
    // Run for the front door.
    at(33, 33.5, Math.PI)
    step({ mx: -1, sprint: true, aim: Math.PI }, 60)
    expect(guide.done.has("sprint")).toBe(true)
    at(27.7, 34.6, Math.PI / 2)
    step({ interact: true, aim: Math.PI / 2 })
    expect(guide.done.has("front-door")).toBe(true)
    expect(guide.current()).toBe("melee")
    // Put the chained one down.
    session.view.zombies[0]!.hp = 0
    session.view.zombies[0]!.state = "dead"
    step()
    expect(guide.current()).toBeNull()
    expect(BEATS.every((b) => guide.done.has(b))).toBe(true)
    expect(leftTheHouse(p)).toBe(false)
    at(27.7, 42.5, Math.PI / 2)
    expect(leftTheHouse(p)).toBe(true)
    // The boards you nailed carry into the run.
    const boards = boardsUp(session)
    expect(boards).toEqual({ "ash-east": 1 })
    const run = new LocalSession(7)
    carryBoards(run, boards)
    expect(run.sim.ai.getBarricadePlanks("ash-east")).toBe(1)
  })

  test("reaching a place passes the beats before it", () => {
    const { session, guide, at, step } = room()
    at(27.7, 28.8, Math.PI / 2)
    step({ interact: true, aim: Math.PI / 2 })
    expect(guide.done.has("door-open")).toBe(true)
    expect(guide.current()).toBe("light")
    step({ flashlight: true })
    expect(guide.current()).toBe("door-close")
    expect(session.view.zombies.length).toBe(1)
  })
})

describe("beat staging (Lab station)", () => {
  test("every beat stages as the current one, with a hint", () => {
    for (const beat of BEATS) {
      const { session, guide, step } = room()
      stageBeat(session, guide, beat)
      step()
      expect([beat, guide.current()]).toEqual([beat, beat])
      expect(guide.hint(session.sim, session.view.actorId, beat)?.beat ?? beat).toBe(beat)
    }
  })
})

describe("when the training room runs", () => {
  test("first solo start only, unless forced; Off is Today; automation never asks", () => {
    const store = memory()
    expect(takeTrainingRequest(TRAINING_FIRST_TIME, store)).toBe(false)
    requestTraining()
    expect(takeTrainingRequest(TRAINING_FIRST_TIME, store)).toBe(true)
    markTrainingDone(store)
    expect(trainingDone(store)).toBe(true)
    requestTraining()
    expect(takeTrainingRequest(TRAINING_FIRST_TIME, store)).toBe(false)
    requestTraining()
    expect(takeTrainingRequest(TRAINING_ALWAYS, store)).toBe(true)
    requestTraining()
    expect(takeTrainingRequest(TRAINING_OFF, store)).toBe(false)
    requestTraining(true)
    expect(takeTrainingRequest(TRAINING_OFF, store)).toBe(true)
    forgetTraining(store)
    expect(trainingDone(store)).toBe(false)
  })
})

function practiceSpace(loadout: LoadoutId = "standard") {
  const pr = startPractice(new LocalSession(7), loadout)
  const { session } = pr
  const step = (cmd: Record<string, unknown> = {}, n = 1) => {
    for (let i = 0; i < n; i++) session.update(TICK, { mx: 0, my: 0, aim: session.view.player.aim, ...cmd } as never, 240)
  }
  return { pr, session, step, has: (item: string) => session.sim.progression.ledger.count(session.view.actorId, item) }
}

/** A stand-in for the lobby and room the session hook reads (`CoopView`). */
function fakeCoop(open: boolean, net: unknown = null) {
  const lobby = { isOpen: open, practice: false, loadout: "standard" as LoadoutId }
  return { lobby, net, coop: { lobby, net } as never }
}

function hookCtx(coop: never) {
  return {
    seed: 7,
    settings: { hud: { ...DEFAULT_TRAINING_SETTINGS } } as never,
    coop,
    make: (seed: number) => new LocalSession(seed),
    restart: () => {},
  }
}

describe("lobby practice space (Kit: \"While loading out you can train\")", () => {
  test("the training room's house, dawn and chained target, with the kit you picked", () => {
    const { session, step, has } = practiceSpace("breacher")
    expect(isPracticeSession(session)).toBe(true)
    expect(has("pistol")).toBe(1)
    expect(has("plank")).toBe(2)
    expect(has("pipe")).toBe(1)
    step({}, 60 * 5)
    expect(session.view.hour).toBeCloseTo(TRAINING_HOUR)
    expect(session.view.zombies.length).toBe(1)
  })

  test("changing the lobby's kit swaps it live, a fresh kit each time", () => {
    const { pr, has } = practiceSpace()
    expect(has("pipe")).toBe(0)
    stepPractice(pr, "breacher", TICK, false)
    expect([pr.loadout, has("pipe")]).toEqual(["breacher", 1])
    stepPractice(pr, "medic", TICK, false)
    expect([has("pipe"), has("bandage"), has("pistol")]).toEqual([0, 1, 1])
    stepPractice(pr, "medic", TICK, false)
    expect(has("bandage")).toBe(1)
  })

  test("the chained one comes back so there is always something to swing at", () => {
    const { session, step } = practiceSpace()
    const first = session.view.zombies[0]!
    first.hp = 0
    first.state = "dead"
    step({}, Math.ceil((PRACTICE_RESPAWN_SECONDS + 0.5) / TICK))
    const alive = session.view.zombies.filter((z) => z.state !== "dead")
    expect(alive.length).toBe(1)
    expect(alive[0]!.id).not.toBe(first.id)
    expect(Math.hypot(alive[0]!.x - TRAINING_CHAIN.x, alive[0]!.y - TRAINING_CHAIN.y)).toBeLessThanOrEqual(TRAINING_CHAIN.length + 0.5)
  })

  test("hints only suggest: the first one waits for the lobby to land, and the prompt quiets it in reach", () => {
    const { pr } = practiceSpace()
    expect(stepPractice(pr, "standard", 0.1, false)).toBeNull()
    expect(stepPractice(pr, "standard", 1, false)?.beat).toBe("move")
    const hint = { beat: "search", keys: [], at: "self", target: TRAINING_DRESSER } as const
    expect(quietHint(hint, { id: TRAINING_DRESSER, kind: "container" } as never)).toBeNull()
    expect(quietHint(hint, undefined)).toBe(hint)
  })

  test("the open lobby makes the practice session, kept while it stays open; the run is a fresh one", () => {
    const hook = outbreakOnboardingFeature.session!
    const solo = fakeCoop(true)
    const space = hook(hookCtx(solo.coop))
    expect(isPracticeSession(space)).toBe(true)
    expect(solo.lobby.practice).toBe(true)
    // Practice changes the house: boards up, the dresser emptied, hours of dawn.
    space!.sim.ai.addBarricadePlank("ash-east")
    expect(hook(hookCtx(solo.coop))).toBe(space)
    // Play Solo: the lobby closes and the run is the normal session, with nothing carried over.
    solo.lobby.isOpen = false
    expect(hook(hookCtx(solo.coop))).toBeNull()
    expect(solo.lobby.practice).toBe(false)
    const run = new LocalSession(7)
    expect(isTrainingSession(run) || isPracticeSession(run)).toBe(false)
    expect(run.sim.ai.getBarricadePlanks("ash-east")).toBe(0)
  })

  test("in a co-op room each player practises locally, and the room's run is the room's session", () => {
    const hook = outbreakOnboardingFeature.session!
    const room = fakeCoop(true)
    const space = hook(hookCtx(room.coop))
    expect(isPracticeSession(space)).toBe(true)
    room.lobby.isOpen = false
    expect(hook(hookCtx(fakeCoop(false, {}).coop))).toBeNull()
    // Off: today's paused lobby, no local session.
    const off = fakeCoop(true)
    const ctx = hookCtx(off.coop)
    ;(ctx.settings as { hud: { lobbyPractice: number } }).hud.lobbyPractice = PRACTICE_OFF
    expect(hook(ctx)).toBeNull()
    expect(off.lobby.practice).toBe(false)
  })

  test("the room's sim never turns into a practice space", () => {
    const room = new CoopRoomCore("practice", DEFAULT_COOP_ROOM, Date.now, "test")
    expect(room.sim.getFeatureState<TrainingState>("onboarding")).toMatchObject({ active: false, practice: false })
  })
})

describe("lobby keys over the practice space", () => {
  const coop = { mode: "coop" as const, practice: true, training: false, ready: false, canStart: false }
  test("the game keeps every key but Enter, so nothing practising leaves the room or blocks Ready", () => {
    for (const code of ["KeyW", "KeyE", "KeyF", "KeyB", "KeyR", "KeyC", "KeyH", "KeyT", "Tab", "Digit1", "Escape", "Space"]) {
      expect(lobbyKeyAction(code, coop)).toBeNull()
      expect(lobbyKeyAction(code, { ...coop, mode: "start" })).toBeNull()
    }
    expect(lobbyKeyAction("Enter", { ...coop, mode: "start" })).toEqual({ act: "solo" })
    expect(lobbyKeyAction("Enter", coop)).toEqual({ act: "ready" })
    expect(lobbyKeyAction("Enter", { ...coop, ready: true, canStart: true })).toEqual({ act: "start" })
    expect(lobbyKeyAction("Enter", { ...coop, ready: true })).toEqual({ act: "unready" })
  })

  test("without it, today's menu keys", () => {
    const menu = { ...coop, practice: false, training: true }
    expect(lobbyKeyAction("Digit2", menu)).toEqual({ act: "variant", variant: 1 })
    expect(lobbyKeyAction("KeyR", menu)).toEqual({ act: "ready" })
    expect(lobbyKeyAction("KeyC", menu)).toEqual({ act: "copy" })
    expect(lobbyKeyAction("Escape", menu)).toEqual({ act: "leave" })
    expect(lobbyKeyAction("Enter", menu)).toBeNull()
    expect(lobbyKeyAction("Enter", { ...menu, mode: "start" })).toEqual({ act: "solo" })
    expect(lobbyKeyAction("KeyT", { ...menu, mode: "start" })).toEqual({ act: "training" })
    expect(lobbyKeyAction("KeyH", { ...menu, mode: "start" })).toEqual({ act: "host" })
  })
})
