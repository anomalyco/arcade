import { afterEach, describe, expect, test } from "bun:test"
import {
  KeyStateTracker,
  STANDARD_BINDINGS,
  KEY_LABEL_STORAGE_KEY,
  isEditableEventTarget,
  isMetaKey,
  isNavigationKey,
  keyLabel,
  keyLabelMode,
  keyLabelSetting,
  matchesAction,
  moveClusterLabel,
  observeKeyLayout,
  onKeyLayoutChange,
  qwertyKeyLabel,
  refreshKeyLayout,
  setKeyLabelMode,
  setKeyLayoutMapForTest,
} from "./client/controls"
import { keyCapHtml, keyPromptHtml } from "./client/key-cap"
import { Input } from "./client/input"
import { LabInput } from "./lab/input"

afterEach(() => {
  setKeyLayoutMapForTest(null, "qwerty")
})

const DVORAK = new Map<string, string>([
  ["KeyW", ","],
  ["KeyA", "a"],
  ["KeyS", "o"],
  ["KeyD", "e"],
  ["KeyE", "."],
  ["KeyF", "u"],
  ["KeyR", "p"],
  ["KeyQ", "'"],
])

async function withLayoutMap(map: Map<string, string>, run: () => Promise<void>): Promise<void> {
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { keyboard: { getLayoutMap: async () => map } },
  })
  try {
    await run()
  } finally {
    if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
}

describe("controls standard and QWERTY prompt labels", () => {
  test("qwertyKeyLabel and default QWERTY labels", () => {
    expect(keyLabelMode()).toBe("qwerty")
    expect(qwertyKeyLabel("KeyE")).toBe("E")
    expect(qwertyKeyLabel("KeyR")).toBe("R")
    expect(qwertyKeyLabel("KeyW")).toBe("W")
    expect(qwertyKeyLabel("Backquote")).toBe("`")
    expect(qwertyKeyLabel("ShiftLeft")).toBe("Shift")
    expect(qwertyKeyLabel("ShiftRight")).toBe("Shift")
    expect(qwertyKeyLabel("Space")).toBe("Space")
    expect(qwertyKeyLabel("Tab")).toBe("Tab")
    expect(qwertyKeyLabel("Escape")).toBe("Esc")
    expect(qwertyKeyLabel("Digit3")).toBe("3")
    expect(qwertyKeyLabel("Mouse0")).toBe("LMB")
    expect(qwertyKeyLabel("Mouse2")).toBe("RMB")
    expect(keyLabel("KeyE")).toBe("E")
    expect(moveClusterLabel()).toBe("WASD")
    expect(matchesAction("KeyE", "interact")).toBe(true)
    expect(matchesAction("KeyF", "interact")).toBe(true)
    expect(matchesAction("ShiftLeft", "sprint")).toBe(true)
    expect(STANDARD_BINDINGS.interact[0]).toBe("KeyE")
  })

  test("Dvorak keeps QWERTY labels by default, even after the layout map and key events arrive", async () => {
    await withLayoutMap(DVORAK, async () => {
      let notified = 0
      const unsub = onKeyLayoutChange(() => notified++)
      try {
        await refreshKeyLayout()
        observeKeyLayout({ code: "KeyE", key: "." })
        observeKeyLayout({ code: "KeyR", key: "p" })
        expect(notified).toBe(0)
        expect(keyLabel("KeyE")).toBe("E")
        expect(keyLabel("KeyR")).toBe("R")
        expect(keyLabel("KeyF")).toBe("F")
        expect(keyLabel("KeyQ")).toBe("Q")
        expect(keyLabel("Backquote")).toBe("`")
        expect(keyLabel("ShiftLeft")).toBe("Shift")
        expect(moveClusterLabel()).toBe("WASD")
      } finally {
        unsub()
      }
    })
  })

  test("the opt-in layout mode resolves Dvorak labels through getLayoutMap() and notifies listeners", async () => {
    await withLayoutMap(DVORAK, async () => {
      let notified = 0
      const unsub = onKeyLayoutChange(() => notified++)
      try {
        setKeyLabelMode("layout", false)
        await refreshKeyLayout()
        expect(notified).toBeGreaterThan(0)
        expect(keyLabel("KeyE")).toBe(".")
        expect(keyLabel("KeyF")).toBe("U")
        expect(keyLabel("KeyR")).toBe("P")
        expect(keyLabel("KeyQ")).toBe("'")
        expect(keyLabel("ShiftLeft")).toBe("Shift")
        expect(moveClusterLabel()).toBe(",AOE")
        const before = notified
        setKeyLabelMode("qwerty", false)
        expect(notified).toBe(before + 1)
        expect(keyLabel("KeyE")).toBe("E")
        expect(moveClusterLabel()).toBe("WASD")
      } finally {
        unsub()
      }
    })
  })

  test("observeKeyLayout learns unshifted layout characters for layout mode only", () => {
    observeKeyLayout({ code: "KeyE", key: "." })
    observeKeyLayout({ code: "KeyW", key: "," })
    observeKeyLayout({ code: "KeyS", key: "o" })
    observeKeyLayout({ code: "KeyD", key: "e" })
    // Shifted or modified keys must not overwrite the base layout label.
    observeKeyLayout({ code: "KeyW", key: "<", shiftKey: true })
    expect(keyLabel("KeyE")).toBe("E")
    expect(moveClusterLabel()).toBe("WASD")
    setKeyLabelMode("layout", false)
    expect(keyLabel("KeyE")).toBe(".")
    expect(moveClusterLabel()).toBe(",AOE")
  })

  test("the Key labels setting persists the opt-in and defaults to QWERTY", () => {
    const store = new Map<string, string>()
    const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    })
    try {
      const { settings, control } = keyLabelSetting()
      expect(settings.keyLabels).toBe("qwerty")
      expect(control.options.map((o) => o.label)).toEqual(["QWERTY", "My keyboard layout"])
      control.change("layout")
      expect(store.get(KEY_LABEL_STORAGE_KEY)).toBe("layout")
      expect(keyLabelMode()).toBe("layout")
      control.change("qwerty")
      expect(store.get(KEY_LABEL_STORAGE_KEY)).toBe("qwerty")
      expect(keyLabelMode()).toBe("qwerty")
    } finally {
      if (prev) Object.defineProperty(globalThis, "localStorage", prev)
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  })

  test("key caps render QWERTY labels, wide caps, mouse icons and the hold ring", () => {
    setKeyLayoutMapForTest(DVORAK, "qwerty")
    expect(keyCapHtml("KeyE")).toContain(">E<")
    expect(keyCapHtml("KeyR")).toContain(">R<")
    expect(keyCapHtml("Space")).toContain("akc-space")
    expect(keyCapHtml("ShiftLeft")).toContain("akc-wide")
    expect(keyCapHtml("ShiftLeft")).toContain(">Shift<")
    expect(keyCapHtml("Mouse0")).toContain('aria-label="Left mouse button"')
    expect(keyCapHtml("Mouse2")).toContain("akc-mouse")
    const hold = keyCapHtml("KeyE", { hold: true, progress: 0.42 })
    expect(hold).toContain("akc-hold")
    expect(hold).toContain("--akc-p:0.420")
    expect(hold).toContain('data-down="true"')
    expect(hold).toContain('aria-label="Hold E"')
    expect(keyCapHtml("KeyE", { hold: true })).not.toContain("data-down")
    expect(keyCapHtml("KeyE", { hold: true, progress: 3 })).toContain("--akc-p:1.000")
    expect(keyPromptHtml("KeyE", "<Open>")).toContain("&#60;Open&#62;")
    setKeyLabelMode("layout", false)
    expect(keyCapHtml("KeyE")).toContain(">.<")
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
      expect(keyLabel("KeyE")).toBe("E")
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

  test("LabInput handles QWERTY and Dvorak physical WASD codes, body-focus fallback, F8 eject release, and panel focus release", () => {
    const fakeWin = new EventTarget()
    const fakeDoc = new EventTarget() as EventTarget & {
      activeElement: unknown
      body: object
      documentElement: object
    }
    const bodyObj = {}
    const docElObj = {}
    let focusedCanvas = false
    const canvas = Object.assign(new EventTarget(), {
      tabIndex: 0,
      focus() {
        focusedCanvas = true
        fakeDoc.activeElement = canvas
      },
    }) as unknown as HTMLCanvasElement
    fakeDoc.body = bodyObj
    fakeDoc.documentElement = docElObj
    fakeDoc.activeElement = bodyObj

    const prevWin = Object.getOwnPropertyDescriptor(globalThis, "window")
    const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document")
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWin })
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDoc })

    try {
      const labInput = new LabInput(canvas)
      labInput.enabled = true

      const dispatch = (kind: "keydown" | "keyup", code: string, key: string, target: unknown = canvas) => {
        const ev = Object.assign(new Event(kind), {
          code,
          key,
          repeat: false,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          composedPath: () => [target],
          preventDefault() {},
        })
        fakeWin.dispatchEvent(ev)
      }

      // 1. Even if document.activeElement starts on document.body, pressing Dvorak W (code: KeyW, key: ",") focuses canvas and drives forward
      dispatch("keydown", "KeyW", ",")
      expect(focusedCanvas).toBe(true)
      expect(labInput.up).toBe(true)
      expect(moveClusterLabel()).toBe("WASD")

      // 2. Dvorak S (KeyS, "o"), A (KeyA, "a"), D (KeyD, "e"), Space, ShiftLeft
      dispatch("keydown", "KeyS", "o")
      dispatch("keydown", "KeyA", "a")
      dispatch("keydown", "KeyD", "e")
      dispatch("keydown", "Space", " ")
      dispatch("keydown", "ShiftLeft", "Shift")
      expect(labInput.down).toBe(true)
      expect(labInput.left).toBe(true)
      expect(labInput.right).toBe(true)
      expect(labInput.space).toBe(true)
      expect(labInput.shift).toBe(true)
      expect(moveClusterLabel()).toBe("WASD")
      setKeyLabelMode("layout", false)
      expect(moveClusterLabel()).toBe(",AOE")

      // 3. F8 Eject releases held keys immediately
      dispatch("keydown", "F8", "F8")
      expect(labInput.up).toBe(false)
      expect(labInput.down).toBe(false)
      expect(labInput.left).toBe(false)
      expect(labInput.right).toBe(false)
      expect(labInput.space).toBe(false)
      expect(labInput.shift).toBe(false)

      // 4. QWERTY WASD codes
      setKeyLayoutMapForTest(null, "qwerty")
      dispatch("keydown", "KeyW", "w")
      dispatch("keydown", "KeyD", "d")
      expect(labInput.up).toBe(true)
      expect(labInput.right).toBe(true)
      expect(moveClusterLabel()).toBe("WASD")

      // 5. Focusing an external panel (e.g. LabPanel host) releases held keys
      fakeDoc.activeElement = { tagName: "ASIDE" }
      fakeDoc.dispatchEvent(new Event("focusin"))
      expect(labInput.up).toBe(false)
      expect(labInput.right).toBe(false)
    } finally {
      if (prevWin) Object.defineProperty(globalThis, "window", prevWin)
      else Reflect.deleteProperty(globalThis, "window")
      if (prevDoc) Object.defineProperty(globalThis, "document", prevDoc)
      else Reflect.deleteProperty(globalThis, "document")
    }
  })

  test("isEditableEventTarget, isNavigationKey, isMetaKey, and KeyStateTracker handle physical codes and release", () => {
    expect(isEditableEventTarget(null)).toBe(false)
    expect(isEditableEventTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true)
    expect(isEditableEventTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true)
    expect(isEditableEventTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true)
    expect(isEditableEventTarget({ tagName: "CANVAS" } as unknown as EventTarget)).toBe(false)
    expect(isNavigationKey("Space")).toBe(true)
    expect(isNavigationKey("ArrowUp")).toBe(true)
    expect(isNavigationKey("KeyW")).toBe(false)
    expect(isMetaKey("MetaLeft")).toBe(true)
    expect(isMetaKey("ShiftLeft")).toBe(false)

    const fakeWin = new EventTarget()
    const prevWin = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWin })
    try {
      let released = 0
      const tracker = new KeyStateTracker({ onRelease: () => released++ })
      fakeWin.dispatchEvent(Object.assign(new Event("keydown"), { code: "KeyW", key: ",", preventDefault() {} }))
      expect(tracker.held("KeyW")).toBe(true)
      expect(tracker.pressed("KeyW")).toBe(true)
      tracker.clearDowns()
      expect(tracker.pressed("KeyW")).toBe(false)
      expect(tracker.held("KeyW")).toBe(true)
      fakeWin.dispatchEvent(Object.assign(new Event("keyup"), { code: "MetaLeft", key: "Meta" }))
      expect(tracker.held("KeyW")).toBe(false)
      expect(released).toBe(1)
    } finally {
      if (prevWin) Object.defineProperty(globalThis, "window", prevWin)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})
