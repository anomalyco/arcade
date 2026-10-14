import {
  bindSafariTrackpadGestures,
  classifyWheelGesture,
  getTwoFingerScrollMode,
  isMouseWheelEvent,
  MOUSE_WHEEL_MIN_DELTA_Y,
  PRIMARY_DRAG_THRESHOLD_PX,
  RADIAL_TAP_THRESHOLD_PX,
  setTwoFingerScrollMode,
  type SafariGestureLike,
  type TwoFingerScrollMode,
  type ViewportWheelOptions,
  type WheelGestureAction,
} from "./lab/viewport-input"

export {
  bindSafariTrackpadGestures,
  classifyWheelGesture,
  getTwoFingerScrollMode,
  isMouseWheelEvent,
  MOUSE_WHEEL_MIN_DELTA_Y,
  PRIMARY_DRAG_THRESHOLD_PX,
  RADIAL_TAP_THRESHOLD_PX,
  setTwoFingerScrollMode,
  type SafariGestureLike,
  type TwoFingerScrollMode,
  type ViewportWheelOptions,
  type WheelGestureAction,
}

export type OrbitCameraTarget = {
  orbit(dyaw: number, dpitch: number, smooth?: boolean): void
  pan(dx: number, dz: number, smooth?: boolean): void
  zoomBy(factor: number, smooth?: boolean): void
}

export type OrbitMarqueeCallbacks = {
  /** Return true when a primary (LMB) drag should draw a marquee selection box instead of orbiting. */
  shouldMarquee: (event: PointerEvent) => boolean
  onStart?: (startX: number, startY: number, event: PointerEvent) => void
  onMove: (startX: number, startY: number, currentX: number, currentY: number, event: PointerEvent) => void
  onEnd: (startX: number, startY: number, endX: number, endY: number, event: PointerEvent) => void
  onCancel?: () => void
}

export type OrbitGestureOptions = {
  target: OrbitCameraTarget
  /** Pass true to request smooth damped camera updates on target.orbit/pan/zoomBy (used by Lab Stage). */
  smooth?: boolean
  /** Return false when the viewport is in Play/Possess mode so camera gestures yield to gameplay. */
  isEnabled?: () => boolean
  onChange?: () => void
  onPrimaryClick?: (event: PointerEvent) => void
  onContextClick?: (x: number, y: number, event: PointerEvent) => void
  /** Return false to let primary pointer drags aim/interact instead of orbiting (e.g. while possessing). */
  canPrimaryOrbit?: (event: PointerEvent) => boolean
  /** Optional custom interceptor on pointerdown (e.g. to resolve an already-latched radial menu). Return true if consumed. */
  onPointerDownIntercept?: (event: PointerEvent) => boolean
  /** Optional hook during pointermove when not dragging the camera or marquee (e.g. hover reticles, ghosts, modal transforms). */
  onHoverMove?: (event: PointerEvent) => void
  /** Optional hook when camera orbits or pans via pointer drag (e.g. to update custom viewport cursor state). */
  onCameraDragMove?: (mode: "orbit" | "pan", event: PointerEvent) => void
  /** Optional marquee box-selection handlers (used by Lab Workbench where multi-object selection exists). */
  marquee?: OrbitMarqueeCallbacks
  /** Optional wheel classifier overrides or dynamic getter. */
  wheelOptions?: ViewportWheelOptions | (() => ViewportWheelOptions)
}

/**
 * Applies standard keyboard arrow orbit (`ArrowLeft`/`Right`/`Up`/`Down`) or pan (`Shift + Arrows`) to an `OrbitCameraTarget`.
 * Returns true if `event.key` was an arrow key and the camera was updated.
 */
export function applyArrowCameraKey(
  target: OrbitCameraTarget,
  event: { key: string; shiftKey?: boolean },
  smooth = false,
): boolean {
  if (!event.key.startsWith("Arrow")) return false
  const sign = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1
  const vertical = event.key === "ArrowUp" || event.key === "ArrowDown"
  if (event.shiftKey) {
    target.pan(vertical ? 0 : sign * 40, vertical ? sign * 40 : 0, smooth)
  } else {
    target.orbit(vertical ? 0 : sign * 0.25, vertical ? sign * -0.12 : 0, smooth)
  }
  return true
}

/**
 * Shared 3D viewport gesture grammar used across Lab, Catalogue, and Characters:
 * - Trackpad two-finger scroll orbits (or pans when configured); Shift + two-finger scroll pans
 * - Trackpad pinch (`Ctrl+wheel` and Safari `gesture*`) zooms (`preventDefault` scoped strictly to `canvas`)
 * - Physical mouse wheel (`deltaMode !== 0` or 1D `|deltaY| >= 80`) zooms
 * - Primary click (`<= 4px`) triggers `onPrimaryClick` (including `Shift+click` for multi-select)
 * - Primary drag (`> 4px`) box-selects when `marquee.shouldMarquee` is true (Lab on empty space with objects), else orbits (`Shift+drag` pans)
 * - RMB / MMB / Option+LMB drag orbits; with `Shift` pans
 * - Unmoved RMB tap or `Ctrl+click` (`<= 8px`) triggers `onContextClick` (radial / context menu)
 */
export function bindOrbitGestures(canvas: HTMLElement, options: OrbitGestureOptions) {
  const {
    target,
    smooth = false,
    isEnabled,
    onChange,
    onPrimaryClick,
    onContextClick,
    canPrimaryOrbit,
    onPointerDownIntercept,
    onHoverMove,
    onCameraDragMove,
    marquee,
    wheelOptions,
  } = options

  if (canvas.style) {
    canvas.style.overscrollBehavior = "none"
  }

  let drag: {
    id: number
    button: number
    x: number
    y: number
    startX: number
    startY: number
    isContextCandidate: boolean
    isSecondaryButton: boolean
    isMarquee: boolean
    threshold: number
    moved: boolean
  } | undefined

  const enabled = () => (isEnabled ? isEnabled() : true)

  const change = (fn: () => void) => {
    fn()
    onChange?.()
  }

  canvas.addEventListener("pointerdown", event => {
    canvas.focus({ preventScroll: true })
    if (!enabled()) return
    if (onPointerDownIntercept?.(event)) return
    if (event.button === 1) event.preventDefault()

    const isContextCandidate = event.button === 2 || (event.button === 0 && event.ctrlKey && !event.metaKey)
    const isSecondaryButton = event.button === 1 || event.button === 2 || isContextCandidate
    const isMarquee = !isSecondaryButton && event.button === 0 && Boolean(marquee?.shouldMarquee(event))
    const threshold = isContextCandidate ? RADIAL_TAP_THRESHOLD_PX : PRIMARY_DRAG_THRESHOLD_PX

    drag = {
      id: event.pointerId,
      button: event.button,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      isContextCandidate,
      isSecondaryButton,
      isMarquee,
      threshold,
      moved: false,
    }
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointer events in unit/headless tests may not have an active pointerId
    }
  })

  canvas.addEventListener("pointermove", event => {
    if (!enabled()) {
      onHoverMove?.(event)
      return
    }
    if (!drag || drag.id !== event.pointerId) {
      onHoverMove?.(event)
      return
    }
    if (!drag.moved) {
      const dist = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
      if (dist <= drag.threshold) return
      drag.moved = true
      if (drag.isMarquee) {
        marquee?.onStart?.(drag.startX, drag.startY, event)
      }
    }
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    drag.x = event.clientX
    drag.y = event.clientY

    if (drag.isMarquee) {
      marquee?.onMove(drag.startX, drag.startY, event.clientX, event.clientY, event)
      return
    }

    if (event.shiftKey) {
      change(() => target.pan(-dx, -dy, smooth))
      onCameraDragMove?.("pan", event)
    } else if (drag.isSecondaryButton || (drag.button === 0 && (canPrimaryOrbit ? canPrimaryOrbit(event) : true))) {
      change(() => target.orbit(-dx * 0.0065, dy * 0.0055, smooth))
      onCameraDragMove?.("orbit", event)
    }
  })

  canvas.addEventListener("pointerup", event => {
    if (!drag || drag.id !== event.pointerId) return
    const cur = drag
    drag = undefined

    if (cur.isMarquee && cur.moved) {
      marquee?.onEnd(cur.startX, cur.startY, event.clientX, event.clientY, event)
      return
    }
    if (cur.isMarquee && !cur.moved) {
      marquee?.onCancel?.()
    }

    if (!cur.moved) {
      if (cur.isContextCandidate) {
        onContextClick?.(event.clientX, event.clientY, event)
      } else if (cur.button === 0) {
        onPrimaryClick?.(event)
      }
    }
  })

  const cancelDrag = () => {
    if (drag?.isMarquee && drag.moved) {
      marquee?.onCancel?.()
    }
    drag = undefined
  }

  for (const name of ["pointercancel", "lostpointercapture"] as const) {
    canvas.addEventListener(name, cancelDrag)
  }

  canvas.addEventListener("contextmenu", event => event.preventDefault())

  canvas.addEventListener("wheel", event => {
    const dynamicOpts = typeof wheelOptions === "function" ? wheelOptions() : wheelOptions
    const action = classifyWheelGesture(event, {
      pinchZoom: true,
      twoFingerScroll: getTwoFingerScrollMode(),
      ...dynamicOpts,
    })
    if (action.kind === "ignore") return
    // Always prevent browser page zoom / back-swipe inside the 3D canvas.
    event.preventDefault()
    if (!enabled()) return
    change(() => {
      if (action.kind === "zoom") target.zoomBy(action.factor, smooth)
      else if (action.kind === "pan") target.pan(action.dx, action.dy, smooth)
      else target.orbit(action.dyaw, action.dpitch, smooth)
    })
  }, { passive: false })

  bindSafariTrackpadGestures(canvas, {
    isEnabled: enabled,
    onPinchZoom: factor => change(() => target.zoomBy(factor, smooth)),
    onRotateYaw: dyaw => change(() => target.orbit(dyaw, 0, smooth)),
  })

  return {
    cancelDrag,
    isDragging() {
      return Boolean(drag?.moved)
    },
    hasActivePointer() {
      return Boolean(drag)
    },
  }
}
