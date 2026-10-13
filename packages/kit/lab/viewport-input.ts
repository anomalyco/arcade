export {
  createViewportCursorDOM,
  ensureViewportCursorStyles,
  isInteractiveFormElement,
  sampleGroundNormal,
  type GroundSurfaceSample,
  type ViewportCursorState,
  type ViewportCursorUpdate,
} from "./viewport-cursor"

export type WheelGestureAction =
  | { kind: "ignore" }
  | { kind: "zoom"; factor: number; source: "pinch" | "wheel" }
  | { kind: "orbit"; dyaw: number; dpitch: number; source: "trackpad-scroll" }
  | { kind: "pan"; dx: number; dy: number; source: "trackpad-pan" }

export type ViewportWheelOptions = {
  /** Whether Ctrl+wheel (standard browser trackpad pinch) zooms the 3D camera inside the canvas. Default: true in Lab. */
  pinchZoom?: boolean
  /** Unmodified two-finger trackpad scroll action. Default: "orbit" in Lab ("zoom" in single-asset Catalogue). */
  twoFingerScroll?: "orbit" | "pan" | "zoom"
}

export function clampWheelDelta(delta: number, limit = 120): number {
  if (!Number.isFinite(delta)) return 0
  return Math.max(-limit, Math.min(limit, delta))
}

/**
 * Shared wheel & trackpad classifier used across Lab and Catalogue viewports.
 * - Meta+wheel is never intercepted so browser/OS shortcuts stay untouched.
 * - Ctrl+wheel (W3C trackpad pinch) zooms the 3D camera when `pinchZoom !== false`.
 * - Shift + two-finger scroll pans the camera on the ground plane.
 * - Alt + scroll zooms the camera.
 * - Unmodified two-finger scroll orbits (default in Lab), pans, or zooms according to `twoFingerScroll`.
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
      dx: -dx * 0.85,
      dy: -dy * 0.85,
      source: "trackpad-pan",
    }
  }

  if (event.altKey || scrollMode === "zoom") {
    return {
      kind: "zoom",
      factor: Math.exp(dy * 0.003),
      source: "wheel",
    }
  }

  if (scrollMode === "pan") {
    return {
      kind: "pan",
      dx: -dx * 0.85,
      dy: -dy * 0.85,
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
    if (callbacks.isEnabled && !callbacks.isEnabled()) return
    const g = event as SafariGestureLike
    event.preventDefault()
    lastScale = typeof g.scale === "number" && g.scale > 0 ? g.scale : 1
    lastRotation = typeof g.rotation === "number" ? g.rotation : 0
  }

  const onChange = (event: Event) => {
    if (callbacks.isEnabled && !callbacks.isEnabled()) return
    const g = event as SafariGestureLike
    event.preventDefault()
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
    if (callbacks.isEnabled && !callbacks.isEnabled()) return
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
