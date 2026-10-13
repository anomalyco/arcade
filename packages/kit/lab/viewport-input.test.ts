import { expect, test } from "bun:test"
import { classifyWheelGesture } from "./viewport-input"

test("classifyWheelGesture handles trackpad two-finger orbit, Shift pan, Ctrl pinch zoom, and ignores Meta shortcuts", () => {
  // Meta+wheel is never hijacked
  expect(classifyWheelGesture({ deltaY: 50, metaKey: true })).toEqual({ kind: "ignore" })

  // Ctrl+wheel (trackpad pinch) zooms camera in Lab default mode
  const pinch = classifyWheelGesture({ deltaY: -40, ctrlKey: true })
  expect(pinch.kind).toBe("zoom")
  if (pinch.kind === "zoom") {
    expect(pinch.source).toBe("pinch")
    expect(pinch.factor).toBeLessThan(1)
  }

  // Ctrl+wheel is ignored when pinchZoom: false (Catalogue browser-zoom mode)
  expect(classifyWheelGesture({ deltaY: 40, ctrlKey: true }, { pinchZoom: false })).toEqual({ kind: "ignore" })

  // Two-finger scroll orbits by default in Lab
  const scrollOrbit = classifyWheelGesture({ deltaX: 30, deltaY: -20 })
  expect(scrollOrbit).toEqual({
    kind: "orbit",
    dyaw: -30 * 0.0045,
    dpitch: -20 * 0.0038,
    source: "trackpad-scroll",
  })

  // Shift + two-finger scroll pans
  const scrollPan = classifyWheelGesture({ deltaX: 20, deltaY: 40, shiftKey: true })
  expect(scrollPan).toEqual({
    kind: "pan",
    dx: -20 * 0.85,
    dy: -40 * 0.85,
    source: "trackpad-pan",
  })

  // Alt + wheel zooms
  const altZoom = classifyWheelGesture({ deltaY: 60, altKey: true })
  expect(altZoom.kind).toBe("zoom")
})
