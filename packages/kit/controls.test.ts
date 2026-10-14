import { afterEach, describe, expect, test } from "bun:test"
import {
  STANDARD_BINDINGS,
  fallbackCodeLabel,
  keyLabel,
  matchesAction,
  moveClusterLabel,
  observeKeyLayout,
  onKeyLayoutChange,
  refreshKeyLayout,
  setKeyLayoutMapForTest,
} from "./client/controls"
import { Input } from "./client/input"

afterEach(() => {
  setKeyLayoutMapForTest(null)
})

describe("controls standard and layout-aware prompt labels", () => {
  test("fallbackCodeLabel and default QWERTY labels", () => {
    expect(fallbackCodeLabel("KeyE")).toBe("E")
    expect(fallbackCodeLabel("KeyW")).toBe("W")
    expect(fallbackCodeLabel("ShiftLeft")).toBe("SHIFT")
    expect(fallbackCodeLabel("Space")).toBe("SPACE")
    expect(fallbackCodeLabel("Tab")).toBe("TAB")
    expect(fallbackCodeLabel("Escape")).toBe("ESC")
    expect(fallbackCodeLabel("Digit3")).toBe("3")
    expect(keyLabel("KeyE")).toBe("E")
    expect(moveClusterLabel()).toBe("WASD")
    expect(matchesAction("KeyE", "interact")).toBe(true)
    expect(matchesAction("KeyF", "interact")).toBe(true)
    expect(matchesAction("ShiftLeft", "sprint")).toBe(true)
    expect(STANDARD_BINDINGS.interact[0]).toBe("KeyE")
  })

  test("navigator.keyboard.getLayoutMap() resolves Dvorak labels for physical WASD and E", async () => {
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator")
    const dvorak = new Map<string, string>([
      ["KeyW", ","],
      ["KeyA", "a"],
      ["KeyS", "o"],
      ["KeyD", "e"],
      ["KeyE", "."],
      ["KeyF", "u"],
      ["KeyR", "p"],
      ["KeyQ", "'"],
    ])
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        keyboard: {
          getLayoutMap: async () => dvorak,
        },
      },
    })
    let notified = 0
    const unsub = onKeyLayoutChange(() => {
      notified++
    })
    try {
      await refreshKeyLayout()
      expect(notified).toBeGreaterThan(0)
      expect(keyLabel("KeyE")).toBe(".")
      expect(keyLabel("KeyF")).toBe("U")
      expect(keyLabel("KeyR")).toBe("P")
      expect(keyLabel("KeyQ")).toBe("'")
      expect(moveClusterLabel()).toBe(",AOE")
    } finally {
      unsub()
      if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav)
      else Reflect.deleteProperty(globalThis, "navigator")
    }
  })

  test("observeKeyLayout learns unshifted layout characters from key events", () => {
    observeKeyLayout({ code: "KeyE", key: "." })
    observeKeyLayout({ code: "KeyW", key: "," })
    observeKeyLayout({ code: "KeyS", key: "o" })
    observeKeyLayout({ code: "KeyD", key: "e" })
    // Shifted or modified keys must not overwrite the base layout label.
    observeKeyLayout({ code: "KeyW", key: "<", shiftKey: true })
    expect(keyLabel("KeyE")).toBe(".")
    expect(moveClusterLabel()).toBe(",AOE")
  })

  test("Input binds by physical KeyboardEvent.code on Dvorak without KeyD/KeyE collision", () => {
    const fakeWin = new EventTarget()
    const globals = {
      window: fakeWin,
      parent: fakeWin,
      innerWidth: 1000,
      innerHeight: 800,
      location: { search: "", origin: "http://localhost" },
      document: { referrer: "" },
    }
    const previous = new Map<string, PropertyDescriptor | undefined>()
    for (const [key, value] of Object.entries(globals)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }
    try {
      const canvas = Object.assign(new EventTarget(), { tabIndex: 0, focus() {} }) as unknown as HTMLElement
      const input = new Input(canvas)
      input.enabled = true

      const dispatch = (kind: "keydown" | "keyup", code: string, key: string) => {
        fakeWin.dispatchEvent(Object.assign(new Event(kind), { code, key, repeat: false, preventDefault() {} }))
      }

      // Dvorak physical D (code: KeyD, key: "e") moves right and never triggers interact (KeyE).
      dispatch("keydown", "KeyD", "e")
      expect(input.move()).toEqual({ mx: 1, my: 0 })
      expect(input.takeEnter()).toBe(false)
      expect(input.interactHeld).toBe(false)
      dispatch("keyup", "KeyD", "e")
      expect(input.move()).toEqual({ mx: 0, my: 0 })

      // Dvorak physical E (code: KeyE, key: ".") triggers interact and never moves right.
      dispatch("keydown", "KeyE", ".")
      expect(input.move()).toEqual({ mx: 0, my: 0 })
      expect(input.interactHeld).toBe(true)
      expect(input.takeEnter()).toBe(true)
      expect(input.takeEnter()).toBe(false)
      expect(keyLabel("KeyE")).toBe(".")
      dispatch("keyup", "KeyE", ".")
      expect(input.interactHeld).toBe(false)

      // Physical KeyF alias also triggers interact without moving.
      dispatch("keydown", "KeyF", "u")
      expect(input.move()).toEqual({ mx: 0, my: 0 })
      expect(input.takeEnter()).toBe(true)
      dispatch("keyup", "KeyF", "u")

      // Dvorak physical W (code: KeyW, key: ",") + ShiftLeft sprints forward; releasing after Shift changes key to "<" still releases cleanly.
      dispatch("keydown", "ShiftLeft", "Shift")
      dispatch("keydown", "KeyW", ",")
      expect(input.move()).toEqual({ mx: 0, my: -1 })
      expect(input.sprinting).toBe(true)
      dispatch("keyup", "KeyW", "<")
      dispatch("keyup", "ShiftLeft", "Shift")
      expect(input.move()).toEqual({ mx: 0, my: 0 })
      expect(input.sprinting).toBe(false)
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  })
})
