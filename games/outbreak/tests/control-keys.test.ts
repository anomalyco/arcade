import { describe, expect, test } from "bun:test"
import { guardsClose } from "../src/controls/index"
import { CROUCH_CTRL, crouchCodes, DEFAULT_CONTROL_SETTINGS, MAP_ON_N, mapCodes, muteOnM } from "../src/controls/settings"
import { DEFAULT_HUD_SETTINGS } from "../src/hud/settings"
import { TrainingGuide } from "../src/onboarding/beats"
import { TRAINING_GLASS } from "../shared/onboarding/training"

// Playtest (Oct 21): "I always accidentally end up hitting Ctrl W in these games, I'm trying to crouch and move
// forward" (1:19:28), and "the map doesn't pop up if I press it. It mutes" (1:43:52).
describe("control keys", () => {
  test("crouch is Z by default, never a modifier that turns W into closing the tab; Today's Ctrl is one setting away", () => {
    expect(DEFAULT_HUD_SETTINGS).toMatchObject(DEFAULT_CONTROL_SETTINGS)
    expect(crouchCodes(DEFAULT_CONTROL_SETTINGS)).toEqual(["KeyZ"])
    expect(crouchCodes({ crouchKey: CROUCH_CTRL })).toEqual(["ControlLeft", "ControlRight"])
  })

  test("M opens the map and no longer mutes; N still opens it; Today keeps N for the map and M for mute", () => {
    expect(mapCodes(DEFAULT_CONTROL_SETTINGS)).toEqual(["KeyM", "KeyN"])
    expect(muteOnM(DEFAULT_CONTROL_SETTINGS)).toBe(false)
    expect(mapCodes({ mapKey: MAP_ON_N })).toEqual(["KeyN"])
    expect(muteOnM({ mapKey: MAP_ON_N })).toBe(true)
  })

  test("Z crouch is free: no other on-foot binding uses it", () => {
    const taken = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyF", "KeyQ", "KeyR", "KeyV", "KeyB", "KeyG", "KeyC", "KeyH", "Tab", "Space", "ShiftLeft", ...mapCodes(DEFAULT_CONTROL_SETTINGS)]
    expect(taken).not.toContain(crouchCodes(DEFAULT_CONTROL_SETTINGS)[0])
  })

  test("the training room's crouch hint shows the bound key", () => {
    const sim = { slot: () => ({ survivor: { ...TRAINING_GLASS, vx: 0, vy: 0 } }), progression: { ledger: { store: () => undefined } } } as never
    const guide = new TrainingGuide()
    expect(guide.hint(sim, "me", "crouch")?.keys).toEqual([{ code: "KeyZ", hold: true }])
    guide.crouchKey = "ControlLeft"
    expect(guide.hint(sim, "me", "crouch")?.keys).toEqual([{ code: "ControlLeft", hold: true }])
  })

  test("closing the tab asks first only while a night is on: in a room, or half a minute into a solo run", () => {
    const on = DEFAULT_CONTROL_SETTINGS
    const at = { inRoom: false, menuOpen: false, runOver: false, played: 0 }
    expect(guardsClose(on, at)).toBe(false)
    expect(guardsClose(on, { ...at, played: 31 })).toBe(true)
    expect(guardsClose(on, { ...at, inRoom: true })).toBe(true)
    expect(guardsClose(on, { ...at, inRoom: true, menuOpen: true })).toBe(false)
    expect(guardsClose(on, { ...at, played: 600, runOver: true })).toBe(false)
    expect(guardsClose({ askBeforeClose: false }, { ...at, inRoom: true })).toBe(false)
  })
})
