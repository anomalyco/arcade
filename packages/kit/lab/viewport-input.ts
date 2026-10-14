export {
  createViewportCursorDOM,
  ensureViewportCursorStyles,
  isInteractiveFormElement,
  sampleGroundNormal,
  type GroundSurfaceSample,
  type ViewportCursorState,
  type ViewportCursorUpdate,
} from "./viewport-cursor"

export type TwoFingerScrollMode = "orbit" | "pan" | "zoom"

export type WheelGestureAction =
  | { kind: "ignore" }
  | { kind: "zoom"; factor: number; source: "pinch" | "wheel" }
  | { kind: "orbit"; dyaw: number; dpitch: number; source: "trackpad-scroll" }
  | { kind: "pan"; dx: number; dy: number; source: "trackpad-pan" }

export type ViewportWheelOptions = {
  /** Whether Ctrl+wheel (standard browser trackpad pinch) zooms the 3D camera inside the canvas. Default: true. */
  pinchZoom?: boolean
  /** Unmodified two-finger trackpad scroll action. Default: "orbit". */
  twoFingerScroll?: TwoFingerScrollMode
}

/** Minimum 1D pixel deltaY treated as a discrete physical mouse wheel notch in DOM_DELTA_PIXEL mode (standard notches are 100 or 120). */
export const MOUSE_WHEEL_MIN_DELTA_Y = 80

/** Pointer movement threshold (px) before a primary/middle button press becomes a drag. */
export const PRIMARY_DRAG_THRESHOLD_PX = 4

/** Pointer movement threshold (px) distinguishing an RMB / Ctrl+LMB tap (radial/context menu) from an orbit/pan drag. */
export const RADIAL_TAP_THRESHOLD_PX = 8

const TWO_FINGER_SCROLL_STORAGE_KEY = "arcade.viewport.twoFingerScroll.v1"
let currentTwoFingerScrollMode: "orbit" | "pan" = "orbit"

export function getTwoFingerScrollMode(): "orbit" | "pan" {
  try {
    const stored = globalThis.localStorage?.getItem(TWO_FINGER_SCROLL_STORAGE_KEY)
    if (stored === "orbit" || stored === "pan") {
      currentTwoFingerScrollMode = stored
    }
  } catch {}
  return currentTwoFingerScrollMode
}

export function setTwoFingerScrollMode(mode: "orbit" | "pan"): void {
  currentTwoFingerScrollMode = mode
  try {
    globalThis.localStorage?.setItem(TWO_FINGER_SCROLL_STORAGE_KEY, mode)
  } catch {}
}

export function clampWheelDelta(delta: number, limit = 120): number {
  if (!Number.isFinite(delta)) return 0
  return Math.max(-limit, Math.min(limit, delta))
}

/**
 * Documented heuristic distinguishing a physical mouse scroll wheel from a MacBook/Magic Trackpad two-finger scroll:
 * 1. Non-pixel `deltaMode` (`DOM_DELTA_LINE = 1` or `DOM_DELTA_PAGE = 2`) is always a discrete mouse wheel.
 * 2. In `DOM_DELTA_PIXEL` (`deltaMode === 0`), a purely vertical 1D step (`deltaX === 0`) with integer delta and
 *    `|deltaY| >= 80` (standard Chromium/WebKit mouse wheel notches are 100 or 120 px) is a physical mouse wheel.
 * 3. Any event with a horizontal `deltaX` component, fractional pixel delta, or continuous `|deltaY| < 80` is a trackpad scroll.
 */
export function isMouseWheelEvent(event: {
  deltaX?: number
  deltaY: number
  deltaMode?: number
}): boolean {
  const mode = event.deltaMode ?? 0
  if (mode !== 0) return true
  const rawDx = Number.isFinite(event.deltaX) ? (event.deltaX ?? 0) : 0
  const rawDy = Number.isFinite(event.deltaY) ? event.deltaY : 0
  if (rawDx !== 0) return false
  if (!Number.isInteger(rawDy)) return false
  return Math.abs(rawDy) >= MOUSE_WHEEL_MIN_DELTA_Y
}

/**
 * Shared wheel & trackpad classifier used across Lab, Catalogue, and Characters 3D viewports:
 * - Meta+wheel is never intercepted so browser/OS shortcuts stay untouched.
 * - Ctrl+wheel (W3C trackpad pinch) zooms the 3D camera inside the canvas when `pinchZoom !== false`.
 * - Shift + two-finger scroll (or Shift + wheel) pans the camera on the ground plane.
 * - Alt/Option + scroll or a physical mouse wheel (`isMouseWheelEvent`) zooms the camera.
 * - Unmodified two-finger trackpad scroll orbits (default), pans, or zooms according to `twoFingerScroll`.
 */
export function classifyWheelGesture(
  event: {
    deltaX?: number
    deltaY: number
    deltaMode?: number
    ctrlKey?: boolean
    metaKey?: boolean
    shiftKey?: boolean
    altKey?: boolean
  },
  options: ViewportWheelOptions = {},
): WheelGestureAction {
  if (event.metaKey) return { kind: "ignore" }

  const pinchZoom = options.pinchZoom ?? true
  const scrollMode = options.twoFingerScroll ?? "orbit"
  const dx = clampWheelDelta(event.deltaX ?? 0, 120)
  const dy = clampWheelDelta(event.deltaY ?? 0, 120)

  if (event.ctrlKey) {
    if (!pinchZoom) return { kind: "ignore" }
    return {
      kind: "zoom",
      factor: Math.exp(dy * 0.0045),
      source: "pinch",
    }
  }

  if (event.shiftKey) {
    return {
      kind: "pan",
      dx,
      dy,
      source: "trackpad-pan",
    }
  }

  if (event.altKey || scrollMode === "zoom" || isMouseWheelEvent(event)) {
    return {
      kind: "zoom",
      factor: Math.exp(dy * 0.003),
      source: "wheel",
    }
  }

  if (scrollMode === "pan") {
    return {
      kind: "pan",
      dx,
      dy,
      source: "trackpad-pan",
    }
  }

  return {
    kind: "orbit",
    dyaw: -dx * 0.0045,
    dpitch: dy * 0.0038,
    source: "trackpad-scroll",
  }
}

export type SafariGestureLike = Event & {
  scale?: number
  rotation?: number
  clientX?: number
  clientY?: number
}

export function bindSafariTrackpadGestures(
  canvas: HTMLElement,
  callbacks: {
    isEnabled?: () => boolean
    onPinchZoom: (factor: number) => void
    onRotateYaw?: (dyawRad: number) => void
  },
) {
  let lastScale = 1
  let lastRotation = 0

  const onStart = (event: Event) => {
    const g = event as SafariGestureLike
    // Always prevent Safari whole-page zoom when pinching inside the 3D canvas.
    event.preventDefault()
    if (callbacks.isEnabled && !callbacks.isEnabled()) return
    lastScale = typeof g.scale === "number" && g.scale > 0 ? g.scale : 1
    lastRotation = typeof g.rotation === "number" ? g.rotation : 0
  }

  const onChange = (event: Event) => {
    const g = event as SafariGestureLike
    event.preventDefault()
    if (callbacks.isEnabled && !callbacks.isEnabled()) return
    const scale = typeof g.scale === "number" && g.scale > 0 ? g.scale : 1
    const rotation = typeof g.rotation === "number" ? g.rotation : 0
    if (lastScale > 0 && Math.abs(scale - lastScale) > 1e-4) {
      const factor = Math.max(0.75, Math.min(1.35, lastScale / scale))
      callbacks.onPinchZoom(factor)
      lastScale = scale
    }
    if (callbacks.onRotateYaw && Math.abs(rotation - lastRotation) > 0.05) {
      const dDeg = rotation - lastRotation
      callbacks.onRotateYaw((-dDeg * Math.PI) / 180)
      lastRotation = rotation
    }
  }

  const onEnd = (event: Event) => {
    event.preventDefault()
    lastScale = 1
    lastRotation = 0
  }

  canvas.addEventListener("gesturestart", onStart, { passive: false })
  canvas.addEventListener("gesturechange", onChange, { passive: false })
  canvas.addEventListener("gestureend", onEnd, { passive: false })

  return () => {
    canvas.removeEventListener("gesturestart", onStart)
    canvas.removeEventListener("gesturechange", onChange)
    canvas.removeEventListener("gestureend", onEnd)
  }
}
