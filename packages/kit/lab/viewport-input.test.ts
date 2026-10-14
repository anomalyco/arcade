import { expect, test } from "bun:test"
import {
  applyArrowCameraKey,
  bindOrbitGestures,
  bindSafariTrackpadGestures,
  classifyWheelGesture,
  getTwoFingerScrollMode,
  isMouseWheelEvent,
  MOUSE_WHEEL_MIN_DELTA_Y,
  PRIMARY_DRAG_THRESHOLD_PX,
  RADIAL_TAP_THRESHOLD_PX,
  setTwoFingerScrollMode,
} from "../orbit-gestures"

class FakeCanvas {
  style: Record<string, string> = {}
  listeners = new Map<string, ((event: any) => void)[]>()
  focused = false

  addEventListener(type: string, fn: (event: any) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: (event: any) => void) {
    const list = this.listeners.get(type)
    if (!list) return
    const idx = list.indexOf(fn)
    if (idx >= 0) list.splice(idx, 1)
  }

  focus() {
    this.focused = true
  }

  setPointerCapture() {}

  dispatch(type: string, init: Record<string, any> = {}) {
    let defaultPrevented = false
    const event = {
      type,
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...init,
      get defaultPrevented() {
        return defaultPrevented
      },
      preventDefault() {
        defaultPrevented = true
      },
    }
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event)
    }
    return event
  }
}

test("classifyWheelGesture handles trackpad two-finger orbit/pan, Shift pan, Ctrl pinch zoom, and ignores Meta shortcuts", () => {
  // Meta+wheel is never hijacked (even with ctrlKey or shiftKey)
  expect(classifyWheelGesture({ deltaY: 50, metaKey: true })).toEqual({ kind: "ignore" })
  expect(classifyWheelGesture({ deltaY: -40, metaKey: true, ctrlKey: true })).toEqual({ kind: "ignore" })

  // Ctrl+wheel (trackpad pinch) zooms camera by default
  const pinchIn = classifyWheelGesture({ deltaY: -40, ctrlKey: true })
  expect(pinchIn.kind).toBe("zoom")
  if (pinchIn.kind === "zoom") {
    expect(pinchIn.source).toBe("pinch")
    expect(pinchIn.factor).toBeLessThan(1)
  }
  const pinchOut = classifyWheelGesture({ deltaY: 40, ctrlKey: true })
  expect(pinchOut.kind).toBe("zoom")
  if (pinchOut.kind === "zoom") {
    expect(pinchOut.source).toBe("pinch")
    expect(pinchOut.factor).toBeGreaterThan(1)
  }

  // Ctrl+wheel is ignored when pinchZoom: false explicitly
  expect(classifyWheelGesture({ deltaY: 40, ctrlKey: true }, { pinchZoom: false })).toEqual({ kind: "ignore" })

  // Two-finger scroll orbits by default
  const scrollOrbit = classifyWheelGesture({ deltaX: 30, deltaY: -20 })
  expect(scrollOrbit).toEqual({
    kind: "orbit",
    dyaw: -30 * 0.0045,
    dpitch: -20 * 0.0038,
    source: "trackpad-scroll",
  })

  // Two-finger scroll pans when twoFingerScroll: "pan" is selected
  const modePan = classifyWheelGesture({ deltaX: 30, deltaY: -20 }, { twoFingerScroll: "pan" })
  expect(modePan).toEqual({
    kind: "pan",
    dx: -30 * 0.85,
    dy: 20 * 0.85,
    source: "trackpad-pan",
  })

  // Shift + two-finger scroll (or Shift + wheel) always pans
  const scrollPan = classifyWheelGesture({ deltaX: 20, deltaY: 40, shiftKey: true })
  expect(scrollPan).toEqual({
    kind: "pan",
    dx: -20 * 0.85,
    dy: -40 * 0.85,
    source: "trackpad-pan",
  })

  // Alt/Option + scroll always zooms
  const altZoom = classifyWheelGesture({ deltaY: 30, altKey: true })
  expect(altZoom).toEqual({
    kind: "zoom",
    factor: Math.exp(30 * 0.003),
    source: "wheel",
  })
})

test("isMouseWheelEvent and classifyWheelGesture distinguish physical mouse wheel from trackpad scroll via deltaMode and magnitude", () => {
  // 1. Non-pixel deltaMode (DOM_DELTA_LINE = 1, DOM_DELTA_PAGE = 2) is always a physical mouse wheel
  expect(isMouseWheelEvent({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(true)
  expect(isMouseWheelEvent({ deltaX: 0, deltaY: 1, deltaMode: 2 })).toBe(true)
  expect(classifyWheelGesture({ deltaX: 0, deltaY: -3, deltaMode: 1 }, { twoFingerScroll: "orbit" })).toEqual({
    kind: "zoom",
    factor: Math.exp(-3 * 0.003),
    source: "wheel",
  })

  // 2. DOM_DELTA_PIXEL (0) with 1D integer |deltaY| >= 80 (e.g. 100 or 120) is a physical mouse wheel notch
  expect(MOUSE_WHEEL_MIN_DELTA_Y).toBe(80)
  expect(isMouseWheelEvent({ deltaX: 0, deltaY: -120, deltaMode: 0 })).toBe(true)
  expect(isMouseWheelEvent({ deltaX: 0, deltaY: 100, deltaMode: 0 })).toBe(true)
  expect(isMouseWheelEvent({ deltaX: 0, deltaY: 80, deltaMode: 0 })).toBe(true)
  const wheelNotch = classifyWheelGesture({ deltaX: 0, deltaY: -120, deltaMode: 0 }, { twoFingerScroll: "orbit" })
  expect(wheelNotch.kind).toBe("zoom")
  if (wheelNotch.kind === "zoom") {
    expect(wheelNotch.source).toBe("wheel")
    expect(wheelNotch.factor).toBeLessThan(1)
  }

  // 3. DOM_DELTA_PIXEL with small continuous |deltaY| < 80, fractional deltaY, or non-zero deltaX is a trackpad two-finger scroll
  expect(isMouseWheelEvent({ deltaX: 0, deltaY: -24, deltaMode: 0 })).toBe(false)
  expect(isMouseWheelEvent({ deltaX: 0, deltaY: 79, deltaMode: 0 })).toBe(false)
  expect(isMouseWheelEvent({ deltaX: 0, deltaY: 100.25, deltaMode: 0 })).toBe(false)
  expect(isMouseWheelEvent({ deltaX: 8, deltaY: -120, deltaMode: 0 })).toBe(false)

  const verticalTrackpad = classifyWheelGesture({ deltaX: 0, deltaY: -24, deltaMode: 0 }, { twoFingerScroll: "orbit" })
  expect(verticalTrackpad).toEqual({
    kind: "orbit",
    dyaw: -0,
    dpitch: -24 * 0.0038,
    source: "trackpad-scroll",
  })
})

test("bindSafariTrackpadGestures handles gesturestart/gesturechange/gestureend and always prevents page zoom on canvas", () => {
  const canvas = new FakeCanvas()
  let enabled = true
  const zooms: number[] = []
  const yaws: number[] = []

  const unbind = bindSafariTrackpadGestures(canvas as unknown as HTMLElement, {
    isEnabled: () => enabled,
    onPinchZoom: f => zooms.push(f),
    onRotateYaw: dy => yaws.push(dy),
  })

  const startEvt = canvas.dispatch("gesturestart", { scale: 1, rotation: 0 })
  expect(startEvt.defaultPrevented).toBe(true)

  // Spread two fingers (scale 1 -> 1.25) zooms in (factor < 1); rotate 15 deg orbits yaw
  const changeEvt = canvas.dispatch("gesturechange", { scale: 1.25, rotation: 15 })
  expect(changeEvt.defaultPrevented).toBe(true)
  expect(zooms.length).toBe(1)
  expect(zooms[0]).toBeCloseTo(1 / 1.25, 4)
  expect(yaws.length).toBe(1)
  expect(yaws[0]).toBeCloseTo((-15 * Math.PI) / 180, 4)

  // When disabled (e.g. Play mode), preventDefault() still blocks Safari page zoom, but camera callbacks do not fire
  enabled = false
  const disabledStart = canvas.dispatch("gesturestart", { scale: 1, rotation: 0 })
  const disabledChange = canvas.dispatch("gesturechange", { scale: 1.5, rotation: 30 })
  expect(disabledStart.defaultPrevented).toBe(true)
  expect(disabledChange.defaultPrevented).toBe(true)
  expect(zooms.length).toBe(1)
  expect(yaws.length).toBe(1)

  const endEvt = canvas.dispatch("gestureend")
  expect(endEvt.defaultPrevented).toBe(true)
  unbind()
})

test("bindOrbitGestures unifies LMB click/box-select/orbit, RMB/MMB orbit + Shift pan, RMB/Ctrl tap radial threshold, and arrow keys", () => {
  const canvas = new FakeCanvas()
  const log: string[] = []
  let allowMarquee = false

  const target = {
    orbit: (dyaw: number, dpitch: number) => log.push(`orbit:${dyaw.toFixed(3)},${dpitch.toFixed(3)}`),
    pan: (dx: number, dz: number) => log.push(`pan:${dx},${dz}`),
    zoomBy: (f: number) => log.push(`zoom:${f.toFixed(3)}`),
  }

  setTwoFingerScrollMode("orbit")
  expect(getTwoFingerScrollMode()).toBe("orbit")

  bindOrbitGestures(canvas as unknown as HTMLElement, {
    target,
    marquee: {
      shouldMarquee: () => allowMarquee,
      onMove: (x0, y0, x1, y1) => log.push(`marquee-move:${x0},${y0}->${x1},${y1}`),
      onEnd: (x0, y0, x1, y1, e) => log.push(`marquee-end:${x0},${y0}->${x1},${y1}:shift=${e.shiftKey}`),
    },
    onPrimaryClick: e => log.push(`click:shift=${e.shiftKey}`),
    onContextClick: (x, y) => log.push(`radial:${x},${y}`),
  })

  expect(canvas.style.overscrollBehavior).toBe("none")
  expect(PRIMARY_DRAG_THRESHOLD_PX).toBe(4)
  expect(RADIAL_TAP_THRESHOLD_PX).toBe(8)

  // 1. Primary click (<= 4px) and Shift+click trigger onPrimaryClick
  canvas.dispatch("pointerdown", { button: 0, clientX: 100, clientY: 100 })
  canvas.dispatch("pointermove", { button: 0, clientX: 102, clientY: 101 })
  canvas.dispatch("pointerup", { button: 0, clientX: 102, clientY: 101 })
  expect(log).toEqual(["click:shift=false"])
  log.length = 0

  canvas.dispatch("pointerdown", { button: 0, clientX: 100, clientY: 100, shiftKey: true })
  canvas.dispatch("pointerup", { button: 0, clientX: 100, clientY: 100, shiftKey: true })
  expect(log).toEqual(["click:shift=true"])
  log.length = 0

  // 2. Primary drag (> 4px) orbits when marquee is off, or box-selects when marquee is on
  canvas.dispatch("pointerdown", { button: 0, clientX: 100, clientY: 100 })
  canvas.dispatch("pointermove", { button: 0, clientX: 120, clientY: 110 })
  canvas.dispatch("pointerup", { button: 0, clientX: 120, clientY: 110 })
  expect(log[0]?.startsWith("orbit:")).toBe(true)
  log.length = 0

  allowMarquee = true
  canvas.dispatch("pointerdown", { button: 0, clientX: 50, clientY: 50 })
  canvas.dispatch("pointermove", { button: 0, clientX: 150, clientY: 140 })
  canvas.dispatch("pointerup", { button: 0, clientX: 150, clientY: 140, shiftKey: true })
  expect(log).toEqual(["marquee-move:50,50->150,140", "marquee-end:50,50->150,140:shift=true"])
  log.length = 0

  // 3. RMB tap (<= 8px) and Ctrl+LMB tap (<= 8px) open radial/context menu; RMB drag (> 8px) orbits (Shift+RMB pans)
  canvas.dispatch("pointerdown", { button: 2, clientX: 200, clientY: 200 })
  canvas.dispatch("pointermove", { button: 2, clientX: 205, clientY: 204 }) // hypot(5,4) = 6.4 <= 8
  canvas.dispatch("pointerup", { button: 2, clientX: 205, clientY: 204 })
  expect(log).toEqual(["radial:205,204"])
  log.length = 0

  canvas.dispatch("pointerdown", { button: 0, ctrlKey: true, clientX: 210, clientY: 220 })
  canvas.dispatch("pointerup", { button: 0, ctrlKey: true, clientX: 210, clientY: 220 })
  expect(log).toEqual(["radial:210,220"])
  log.length = 0

  canvas.dispatch("pointerdown", { button: 2, clientX: 200, clientY: 200 })
  canvas.dispatch("pointermove", { button: 2, clientX: 230, clientY: 210 }) // > 8px -> orbits, no radial menu
  canvas.dispatch("pointerup", { button: 2, clientX: 230, clientY: 210 })
  expect(log.length).toBe(1)
  expect(log[0]?.startsWith("orbit:")).toBe(true)
  log.length = 0

  canvas.dispatch("pointerdown", { button: 2, shiftKey: true, clientX: 200, clientY: 200 })
  canvas.dispatch("pointermove", { button: 2, shiftKey: true, clientX: 230, clientY: 210 })
  canvas.dispatch("pointerup", { button: 2, shiftKey: true, clientX: 230, clientY: 210 })
  expect(log).toEqual(["pan:-30,-10"])
  log.length = 0

  // 4. Arrow camera helper orbits by default and pans with Shift
  expect(applyArrowCameraKey(target, { key: "ArrowLeft" })).toBe(true)
  expect(applyArrowCameraKey(target, { key: "ArrowUp", shiftKey: true })).toBe(true)
  expect(log).toEqual(["orbit:-0.250,0.000", "pan:0,-40"])
})
