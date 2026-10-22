import { describe, expect, test } from "bun:test"
import type { InteractTarget } from "../shared/interact"
import { packCommand, unpackCommand } from "../shared/net-protocol"
import { DEFAULT_HUD_SETTINGS } from "../src/hud/settings"
import { DEFAULT_RADIAL_SETTINGS, INTERACT_MENU_RADIAL } from "../src/radial/settings"
import { pickWedge, RadialInteract, radialOptions } from "../src/radial/state"

// Playtest (Oct 21, 1:45:21): "It should be that radial thing where you press E and then it gives you the radial
// thing to pick what action you want to do and you can just click it. Probably the smoothest."
const door = (planks = 0, planksInBelt = 1) => ({
  view: {
    actorId: "me",
    progression: { ledger: { count: () => planksInBelt }, selected: () => null },
    barricadePlanks: () => planks,
  } as never,
  target: {
    kind: "door",
    id: "d1",
    rect: [0, 0, 1, 1],
    worldX: 0,
    worldY: 0,
    primary: { id: "toggle", label: "Open" },
    secondary: { id: "lock", label: "Lock", hold: true },
    alt: { id: "peek", label: "Peek", modifier: "shift" },
    actions: [],
  } as unknown as InteractTarget,
})

describe("radial E menu", () => {
  test("is on by default, with Today one setting away", () => {
    expect(DEFAULT_HUD_SETTINGS).toMatchObject(DEFAULT_RADIAL_SETTINGS)
    expect(DEFAULT_RADIAL_SETTINGS.interactMenu).toBe(INTERACT_MENU_RADIAL)
  })

  test("offers E's tap, its hold, Shift+E and B, as the prompt does; one action means no menu", () => {
    const { view, target } = door()
    expect(radialOptions(view, target).map((o) => [o.slot, o.action.label])).toEqual([
      ["primary", "Open"],
      ["secondary", "Lock"],
      ["alt", "Peek"],
      ["board", "Board up"],
    ])
    expect(radialOptions(door(0, 0).view, target).map((o) => o.slot)).toEqual(["primary", "secondary", "alt"])
    const single = { ...target, secondary: undefined, alt: undefined }
    expect(radialOptions(door(0, 0).view, single)).toEqual([])
    // A boarded door refuses E, so its tap isn't offered.
    expect(radialOptions(door(2, 0).view, target).map((o) => o.slot)).toEqual(["secondary", "alt"])
    // A primary that is itself a hold (hotwiring) keeps Today's hold.
    expect(radialOptions(view, { ...target, primary: { id: "install", label: "Hotwire", hold: true } })).toEqual([])
  })

  test("every choice survives the co-op wire as the same action", () => {
    const { view, target } = door()
    for (const o of radialOptions(view, target)) {
      const back = unpackCommand(packCommand({ mx: 0, my: 0, aim: 0, interact: false, ...o.send }))
      expect(back.interactAction).toBe(o.send.interactAction)
    }
  })

  test("wedge 0 is up and the rest go clockwise; the middle picks nothing", () => {
    expect(pickWedge(0, -40, 4)).toBe(0)
    expect(pickWedge(40, 0, 4)).toBe(1)
    expect(pickWedge(0, 40, 4)).toBe(2)
    expect(pickWedge(-40, 0, 4)).toBe(3)
    expect(pickWedge(30, 30, 3)).toBe(1)
    expect(pickWedge(4, 4, 4)).toBe(-1)
  })

  test("a quick tap takes E's own action; a hold opens the ring and releasing over a wedge takes it", () => {
    const { view, target } = door()
    const options = radialOptions(view, target)
    const r = new RadialInteract()
    const c = { x: 500, y: 300 }
    expect(r.press(0, options, "d1", c, 1)).toBe(true)
    expect(r.frame(80, true, c, "d1", 0.2)).toBeNull()
    expect(r.frame(120, false, c, "d1", 0.2)).toEqual({ interact: true, interactAction: "toggle" })
    expect(r.phase).toBe("idle")

    r.press(0, options, "d1", c, 1)
    r.frame(250, true, c, "d1", 0.2)
    expect(r.isOpen).toBe(true)
    r.frame(260, true, { x: 540, y: 300 }, "d1", 0.2)
    expect(r.hover).toBe(1)
    expect(r.frame(270, false, { x: 540, y: 300 }, "d1", 0.2)).toEqual({ interact: true, interactAction: "lock" })
  })

  test("releasing in the middle cancels; a click or number takes a wedge and waits for E to come up", () => {
    const { view, target } = door()
    const options = radialOptions(view, target)
    const r = new RadialInteract()
    const c = { x: 0, y: 0 }
    r.press(0, options, "d1", c, 0)
    r.frame(300, true, c, "d1", 0.2)
    expect(r.frame(310, false, c, "d1", 0.2)).toBeNull()
    r.press(0, options, "d1", c, 0)
    r.frame(300, true, c, "d1", 0.2)
    expect(r.choose(3)).toEqual({ interact: true, interactAction: "barricade" })
    expect(r.busy).toBe(true)
    expect(r.frame(320, true, c, "d1", 0.2)).toBeNull()
    r.frame(330, false, c, "d1", 0.2)
    expect(r.busy).toBe(false)
  })

  test("losing the target closes it without acting", () => {
    const { view, target } = door()
    const r = new RadialInteract()
    r.press(0, radialOptions(view, target), "d1", { x: 0, y: 0 }, 0)
    r.frame(300, true, { x: 0, y: -50 }, "d1", 0.2)
    expect(r.frame(310, true, { x: 0, y: -50 }, "other", 0.2)).toBeNull()
    expect(r.frame(320, false, { x: 0, y: -50 }, "other", 0.2)).toBeNull()
    expect(r.busy).toBe(false)
  })
})
