import { describe, expect, test } from "bun:test"
import { DEFAULT_PROGRESSION_TUNING } from "../shared/progression/tuning"
import { LocalSession } from "../shared/session"
import { DEFAULT_HUD_SETTINGS } from "../src/hud/settings"
import { PROMPT_ACTIONS, promptGlyph } from "../src/hud/prompt-glyphs"
import { blockedByBoards, BOARD_UP, boardPrompt } from "../src/prompt-clarity/board"
import { bracketPath } from "../src/prompt-clarity/highlight"
import { clarityOn, PROMPT_CLARITY_TODAY, teachUses } from "../src/prompt-clarity/settings"
import { StateWatch, stampDrifts } from "../src/prompt-clarity/stamps"
import { actionKey, teachingWord } from "../src/prompt-clarity/teach"

const TICK = 1 / 60

function ash() {
  const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
  const p = session.view.player
  const step = (cmd: Record<string, unknown> = {}) => session.update(TICK, { mx: 0, my: 0, aim: p.aim, ...cmd } as never, 0)
  const pose = (x: number, y: number, aim: number) => {
    Object.assign(p, { x, y, aim, vx: 0, vy: 0 })
    step({ aim })
  }
  const planks = (n: number) => session.sim.progression.ledger.apply({ kind: "grant", actor: session.view.actorId, item: "plank", count: n })
  const ledger = session.sim.progression.ledger
  for (const st of ledger.stores.values()) if (st.id.startsWith(`${session.view.actorId}/`)) ledger.apply({ kind: "drain", store: st.id, item: "plank", count: 99 })
  return { session, p, step, pose, planks }
}

const towards = (p: { x: number; y: number }, x: number, y: number) => Math.atan2(y - p.y, x - p.x)

describe("which target E acts on", () => {
  test("between a window and a door, looking picks", () => {
    const { session, p, pose } = ash()
    // Inside Ash, 0.9 m from the south-west window and 1.2 m from the front door.
    pose(26.0, 34.6, 0)
    pose(26.0, 34.6, towards(p, 27.7, 35.4))
    expect(session.view.prompt?.id).toBe("ash-front")
    pose(26.0, 34.6, towards(p, 24.5, 35.4))
    expect(session.view.prompt?.id).toBe("ash-south-west")
  })

  test("B boards the opening the prompt points at, not just the nearest", () => {
    const { session, p, pose, step, planks } = ash()
    planks(2)
    pose(26.0, 34.6, 0)
    pose(26.0, 34.6, towards(p, 27.7, 35.4))
    expect(session.view.prompt?.id).toBe("ash-front")
    step({ barricade: true, aim: p.aim })
    expect(p.channel?.kind).toBe("barricade")
    for (let i = 0; i < Math.ceil((DEFAULT_PROGRESSION_TUNING.barricadeTime + 0.1) / TICK); i++) step({ aim: p.aim })
    expect(session.sim.ai.getBarricadePlanks("ash-front")).toBe(1)
    expect(session.sim.ai.getBarricadePlanks("ash-south-west")).toBe(0)
  })
})

describe("prompt state per action", () => {
  test("B shows only with planks, then counts the boards and refuses E on a boarded door", () => {
    const { session, p, pose, step, planks } = ash()
    pose(27.7, 34.4, Math.PI / 2)
    const target = session.view.prompt!
    expect(target.id).toBe("ash-front")
    expect(boardPrompt(session.view, target)).toEqual({ planks: 0, canBoard: false })
    planks(1)
    expect(boardPrompt(session.view, target)).toEqual({ planks: 0, canBoard: true })
    expect(blockedByBoards(target, boardPrompt(session.view, target))).toBe(false)
    step({ barricade: true, aim: p.aim })
    for (let i = 0; i < Math.ceil((DEFAULT_PROGRESSION_TUNING.barricadeTime + 0.1) / TICK); i++) step({ aim: p.aim })
    const after = boardPrompt(session.view, session.view.prompt)!
    expect(after).toEqual({ planks: 1, canBoard: false })
    expect(blockedByBoards(session.view.prompt!, after)).toBe(true)
  })

  test("a boarded window can still be peeked through", () => {
    const { session, pose } = ash()
    pose(24.5, 34.5, Math.PI / 2)
    const target = session.view.prompt!
    expect(target.kind).toBe("window")
    expect(blockedByBoards(target, { planks: 2, canBoard: false })).toBe(false)
  })

  test("containers, fences and drops get no B", () => {
    const { session } = ash()
    const fake = { kind: "container", id: "loot:1" } as never
    expect(boardPrompt(session.view, fake)).toBeNull()
  })

  test("every action keeps its verb for its first three uses, counted per action", () => {
    const open = { id: "toggle", label: "Open" } as const
    const close = { id: "toggle", label: "Close" } as const
    expect(actionKey("door", open)).not.toBe(actionKey("door", close))
    expect(actionKey("door", open)).not.toBe(actionKey("window", open))
    expect(teachingWord("door", open, 0, 3)).toBe("Open")
    expect(teachingWord("door", open, 2, 3)).toBe("Open")
    expect(teachingWord("door", open, 3, 3)).toBeNull()
    expect(teachingWord("door", open, 0, 0)).toBeNull()
    expect(teachingWord("drop", { id: "take", label: "Pick up 9mm Ammo" }, 0, 3)).toBe("9mm Ammo")
    expect(actionKey("drop", { id: "take", label: "Pick up 9mm Ammo" })).toBe(actionKey("drop", { id: "take", label: "Pick up Planks" }))
    expect(teachingWord("door", BOARD_UP, 1, 3)).toBe("Board up")
  })

  test("every prompt action, B included, has a glyph to fall back on once its verb fades", () => {
    expect(promptGlyph("window", BOARD_UP).glyph).toBe("board-up")
    expect(PROMPT_ACTIONS.filter(({ kind, action }) => !promptGlyph(kind, action).glyph)).toEqual([])
  })
})

describe("stamps and outline", () => {
  test("a door opening stamps once; the first frame and a new session record only", () => {
    const { session, pose, step } = ash()
    pose(27.7, 34.4, Math.PI / 2)
    const watch = new StateWatch()
    expect(watch.step(session.view, session)).toEqual([])
    step({ interact: true, aim: Math.PI / 2 })
    const events = watch.step(session.view, session)
    expect(events.map((e) => [e.key, e.glyph])).toEqual([["ash-front", "door-open"]])
    expect(watch.step(session.view, session)).toEqual([])
    expect(watch.step(session.view, {})).toEqual([])
  })

  test("a stamp drifts away from the prompt: down when it hangs over the target, up otherwise", () => {
    const prompt = { left: 300, top: 260, right: 700, bottom: 300 }
    expect(stampDrifts(560, 310, prompt)).toBe("down")
    expect(stampDrifts(560, 250, prompt)).toBe("up")
    expect(stampDrifts(900, 310, prompt)).toBe("up")
    expect(stampDrifts(560, 310, null)).toBe("up")
  })

  test("brackets sit outside the box", () => {
    const d = bracketPath({ x0: 100, y0: 100, x1: 160, y1: 140 }, 6)
    expect(d.startsWith("M94.0 ")).toBe(true)
    expect(d).toContain("H166.0")
  })
})

describe("settings", () => {
  test("on by default, Today one setting away", () => {
    const s = { ...DEFAULT_HUD_SETTINGS }
    expect(s.promptClarity).not.toBe(PROMPT_CLARITY_TODAY)
    expect(teachUses(s)).toBe(3)
    expect(clarityOn(s, "promptHighlight") && clarityOn(s, "promptBoardKey") && clarityOn(s, "promptStamp")).toBe(true)
    s.promptClarity = PROMPT_CLARITY_TODAY
    expect(teachUses(s)).toBe(0)
    expect(clarityOn(s, "promptHighlight") || clarityOn(s, "promptBoardKey") || clarityOn(s, "promptStamp")).toBe(false)
  })
})
