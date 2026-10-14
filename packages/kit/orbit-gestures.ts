import { classifyWheelGesture } from "./lab/viewport-input"

export type OrbitCameraTarget = {
  orbit(dyaw: number, dpitch: number): void
  pan(dx: number, dz: number): void
  zoomBy(factor: number): void
}

export type OrbitGestureOptions = {
  target: OrbitCameraTarget
  onChange?: () => void
  onPrimaryClick?: (event: PointerEvent) => void
  onContextClick?: (x: number, y: number, event: PointerEvent) => void
  /** Return false to let primary pointer drags aim/interact instead of orbiting (e.g. while possessing). */
  canPrimaryOrbit?: (event: PointerEvent) => boolean
}

/**
 * Shared orbit/pan/zoom pointer and wheel grammar used across Catalogue and Characters viewers:
 * - Primary drag orbits (`canPrimaryOrbit` defaults to true)
 * - Shift-drag, middle-drag, or right-drag pans
 * - Wheel zooms (preserving Ctrl/Cmd pinch-zoom)
 * - Unmoved primary click triggers `onPrimaryClick`; unmoved right/Ctrl-click triggers `onContextClick`
 */
export function bindOrbitGestures(canvas: HTMLElement, options: OrbitGestureOptions) {
  const { target, onChange, onPrimaryClick, onContextClick, canPrimaryOrbit } = options
  let drag: {
    id: number
    x: number
    y: number
    startX: number
    startY: number
    pan: boolean
    orbit: boolean
    context: boolean
    moved: boolean
  } | undefined

  const change = (fn: () => void) => {
    fn()
    onChange?.()
  }

  canvas.addEventListener("pointerdown", event => {
    canvas.focus({ preventScroll: true })
    const context = event.button === 2 || (event.button === 0 && event.ctrlKey)
    const pan = event.shiftKey || event.button === 1 || event.button === 2
    const orbit = !pan && event.button === 0 && (canPrimaryOrbit ? canPrimaryOrbit(event) : true)
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      pan,
      orbit,
      context,
      moved: false,
    }
    if (event.button === 1) event.preventDefault()
    canvas.setPointerCapture(event.pointerId)
  })

  canvas.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 4) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    drag.x = event.clientX
    drag.y = event.clientY
    drag.moved = true
    if (drag.pan) change(() => target.pan(-dx, -dy))
    else if (drag.orbit) change(() => target.orbit(-dx * 0.0065, dy * 0.0055))
  })

  canvas.addEventListener("pointerup", event => {
    if (!drag || drag.id !== event.pointerId) return
    const { context, pan, moved } = drag
    drag = undefined
    if (context && !moved) onContextClick?.(event.clientX, event.clientY, event)
    else if (!context && !pan && !moved && event.button === 0) onPrimaryClick?.(event)
  })

  for (const name of ["pointercancel", "lostpointercapture"] as const) {
    canvas.addEventListener(name, () => { drag = undefined })
  }

  canvas.addEventListener("contextmenu", event => event.preventDefault())

  canvas.addEventListener("wheel", event => {
    const action = classifyWheelGesture(event, { pinchZoom: false, twoFingerScroll: "zoom" })
    if (action.kind === "ignore") return
    event.preventDefault()
    change(() => {
      if (action.kind === "zoom") target.zoomBy(action.factor)
      else if (action.kind === "pan") target.pan(action.dx, action.dy)
      else target.orbit(action.dyaw, action.dpitch)
    })
  }, { passive: false })

  return {
    cancelDrag() { drag = undefined },
  }
}
