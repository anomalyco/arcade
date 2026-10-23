import { describe, expect, test } from "bun:test"
import { isQuickSwitchCode, QuickSwitch, type QuickSwitchTarget } from "./lab-quickswitch"

const choice = (key: string, label: string, values: string[], start = values[0]!) => {
  const state = { value: start as string | number }
  const target: QuickSwitchTarget = {
    key, label,
    options: () => values.map(v => ({ value: v, label: v.toUpperCase() })),
    get: () => state.value,
    set: v => { state.value = v },
  }
  return { state, target }
}

describe("QuickSwitch", () => {
  test("steps through the current group's presets and wraps", () => {
    const q = new QuickSwitch()
    const look = choice("look", "Look", ["today", "moonlit", "fog"])
    q.add(look.target)
    q.step(1)
    expect(look.state.value).toBe("moonlit")
    q.step(1)
    q.step(1)
    expect(look.state.value).toBe("today")
    q.step(-1)
    expect(look.state.value).toBe("fog")
    expect(q.view()).toMatchObject({ group: "Look", preset: "FOG", index: 2, count: 3 })
  })

  test("a value outside the options starts from the first (next) or last (previous)", () => {
    const q = new QuickSwitch()
    const look = choice("look", "Look", ["a", "b", "c"], "zzz")
    q.add(look.target)
    q.step(-1)
    expect(look.state.value).toBe("c")
  })

  test("groups change which choice the keys step; values stay", () => {
    const q = new QuickSwitch()
    const look = choice("look", "Look", ["a", "b"]), camera = choice("camera", "Camera", ["eyes", "vhs", "hi8"])
    q.add(look.target)
    q.add(camera.target)
    expect(q.view()?.nextGroup).toBe("Camera")
    q.group(1)
    q.step(1)
    expect(camera.state.value).toBe("vhs")
    expect(look.state.value).toBe("a")
    q.group(1)
    expect(q.current?.key).toBe("look")
    q.group(-1)
    expect(q.current?.key).toBe("camera")
  })

  test("swap flips between the current preset and the one before (A/B)", () => {
    const q = new QuickSwitch()
    const look = choice("look", "Look", ["a", "b", "c"])
    q.add(look.target)
    expect(q.swap()).toBe(false)
    q.step(1)
    q.step(1)
    expect(look.state.value).toBe("c")
    expect(q.view()?.back).toBe("B")
    q.swap()
    expect(look.state.value).toBe("b")
    expect(q.view()?.back).toBe("C")
    q.swap()
    expect(look.state.value).toBe("c")
  })

  test("a change made elsewhere (the panel) becomes what swap goes back to", () => {
    const q = new QuickSwitch()
    const look = choice("look", "Look", ["a", "b", "c"])
    q.add(look.target)
    look.state.value = "c"
    expect(q.view()?.back).toBe("A")
    q.swap()
    expect(look.state.value).toBe("a")
  })

  test("order puts named groups first and starts on the first; remove keeps the current group sane", () => {
    const q = new QuickSwitch()
    for (const k of ["creature", "camera", "look", "quality"]) q.add(choice(k, k, ["x", "y"]).target)
    q.order(["look", "camera", "creature"])
    expect(q.keys).toEqual(["look", "camera", "creature", "quality"])
    expect(q.current?.key).toBe("look")
    q.select("quality")
    q.remove("quality")
    expect(q.current?.key).toBe("creature")
    q.remove("look")
    expect(q.current?.key).toBe("creature")
  })

  test("its keys are the brackets, semicolon, quote and backslash, by physical code", () => {
    for (const code of ["BracketLeft", "BracketRight", "Semicolon", "Quote", "Backslash"]) expect(isQuickSwitchCode(code)).toBe(true)
    for (const code of ["KeyW", "Digit1", "Backquote", "KeyQ", "Minus", "Equal"]) expect(isQuickSwitchCode(code)).toBe(false)
  })
})
