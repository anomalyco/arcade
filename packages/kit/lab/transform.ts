import type { LabWorldObject } from "./types"

export type TransformMode = "move" | "rotate"
export type NumericAxis = "x" | "z" | "yaw"

export type TransformTargetOffset = {
  id: string
  dx: number
  dz: number
  origX: number
  origZ: number
  origYaw: number
}

export type ActiveTransformState = {
  mode: TransformMode
  primaryId: string
  origX: number
  origZ: number
  origYaw: number
  currentX: number
  currentZ: number
  currentYaw: number
  numericAxis: NumericAxis
  numericBuffer: string
  offsets: TransformTargetOffset[]
  viaHandle: boolean
}

export function snapGroundCoord(value: number, altKey: boolean, defaultSnap = 0.25, fineSnap = 0.05): number {
  const snap = altKey ? fineSnap : defaultSnap
  return Number((Math.round(value / snap) * snap).toFixed(3))
}

export function snapYawDeg(deg: number, shiftKey: boolean, altKey: boolean): number {
  const step = altKey ? 1 : shiftKey ? 15 : 5
  const snapped = Math.round(deg / step) * step
  // Normalize to [-180, 180]
  return ((((snapped + 180) % 360) + 360) % 360) - 180
}

export function snapYawRad(rad: number, shiftKey: boolean, altKey: boolean): number {
  const deg = (rad * 180) / Math.PI
  return (snapYawDeg(deg, shiftKey, altKey) * Math.PI) / 180
}

export function normalizeYawRad(rad: number): number {
  const deg = (rad * 180) / Math.PI
  const normDeg = ((((deg + 180) % 360) + 360) % 360) - 180
  return (normDeg * Math.PI) / 180
}

/**
 * Computes object yaw from a ground-plane pointer hit `(hitX, hitZ)` around `(pivotX, pivotZ)`.
 * Because Stage meshes transform local `+Z` forward to `[sin(yaw), cos(yaw)]`, `atan2(hitX - pivotX, hitZ - pivotZ)`
 * places the rotate handle and forward arrow directly under the pointer on the ground plane.
 * - Unmodified drag: continuous angle tracking the pointer 1:1
 * - `Shift`: 15° snap steps
 * - `Alt/Option`: 1° fine snap steps
 */
export function computePointerYawRad(
  pivotX: number,
  pivotZ: number,
  hitX: number,
  hitZ: number,
  shiftKey = false,
  altKey = false,
): number {
  const raw = Math.atan2(hitX - pivotX, hitZ - pivotZ)
  if (shiftKey || altKey) {
    return snapYawRad(raw, shiftKey, altKey)
  }
  return normalizeYawRad(raw)
}

export type ProjectedGroundRing = {
  visible: boolean
  screenX: number
  screenY: number
  ringPoints: { x: number; y: number }[]
  handleOffset: { x: number; y: number }
  handleScreen: { x: number; y: number }
}

/**
 * Projects a ground-plane circle of world `radius` around `(pivotX, pivotY, pivotZ)` into screen space
 * (matching the 3D selection ring ellipse) and computes the screen offset of the rotate handle at `yawRad`.
 */
export function projectGroundRotateRing(
  pivotX: number,
  pivotY: number,
  pivotZ: number,
  radius: number,
  yawRad: number,
  viewportWidth: number,
  viewportHeight: number,
  projectWorld: (x: number, y: number, z: number) => { u: number; v: number; visible: boolean },
  segments = 36,
): ProjectedGroundRing {
  const w = Math.max(1, viewportWidth)
  const h = Math.max(1, viewportHeight)
  const centerProj = projectWorld(pivotX, pivotY, pivotZ)
  const screenX = centerProj.u * w
  const screenY = centerProj.v * h
  const r = Math.max(0.5, radius)

  const ringPoints: { x: number; y: number }[] = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const p = projectWorld(pivotX + Math.sin(a) * r, pivotY, pivotZ + Math.cos(a) * r)
    ringPoints.push({
      x: p.u * w - screenX,
      y: p.v * h - screenY,
    })
  }

  const handleProj = projectWorld(pivotX + Math.sin(yawRad) * r, pivotY, pivotZ + Math.cos(yawRad) * r)
  const hx = handleProj.u * w
  const hy = handleProj.v * h

  return {
    visible: centerProj.visible,
    screenX,
    screenY,
    ringPoints,
    handleOffset: {
      x: hx - screenX,
      y: hy - screenY,
    },
    handleScreen: {
      x: hx,
      y: hy,
    },
  }
}

export function createTransformState(
  mode: TransformMode,
  primary: LabWorldObject,
  selectedObjects: readonly LabWorldObject[],
  viaHandle = false,
): ActiveTransformState {
  const movable = selectedObjects.filter(o => o.movable)
  const targets = movable.some(o => o.id === primary.id) ? movable : [primary]
  const offsets: TransformTargetOffset[] = targets.map(o => ({
    id: o.id,
    dx: o.x - primary.x,
    dz: o.z - primary.z,
    origX: o.x,
    origZ: o.z,
    origYaw: o.yaw ?? 0,
  }))
  return {
    mode,
    primaryId: primary.id,
    origX: primary.x,
    origZ: primary.z,
    origYaw: primary.yaw ?? 0,
    currentX: primary.x,
    currentZ: primary.z,
    currentYaw: primary.yaw ?? 0,
    numericAxis: mode === "rotate" ? "yaw" : "x",
    numericBuffer: "",
    offsets,
    viaHandle,
  }
}

export function applyNumericTransformKey(
  state: ActiveTransformState,
  key: string,
): { handled: boolean; updated: boolean } {
  if (key === "Tab" && state.mode === "move") {
    state.numericAxis = state.numericAxis === "x" ? "z" : "x"
    state.numericBuffer = ""
    return { handled: true, updated: false }
  }
  if ((key === "x" || key === "X") && state.mode === "move") {
    state.numericAxis = "x"
    state.numericBuffer = ""
    return { handled: true, updated: false }
  }
  if ((key === "z" || key === "Z") && state.mode === "move") {
    state.numericAxis = "z"
    state.numericBuffer = ""
    return { handled: true, updated: false }
  }
  if (key === "Backspace") {
    if (state.numericBuffer.length > 0) {
      state.numericBuffer = state.numericBuffer.slice(0, -1)
      applyNumericBufferValue(state)
      return { handled: true, updated: true }
    }
    return { handled: false, updated: false }
  }
  if (/^[0-9.-]$/.test(key)) {
    if (key === "-" && state.numericBuffer.length > 0) return { handled: true, updated: false }
    if (key === "." && state.numericBuffer.includes(".")) return { handled: true, updated: false }
    state.numericBuffer += key
    const updated = applyNumericBufferValue(state)
    return { handled: true, updated }
  }
  return { handled: false, updated: false }
}

function applyNumericBufferValue(state: ActiveTransformState): boolean {
  if (!state.numericBuffer || state.numericBuffer === "-" || state.numericBuffer === "." || state.numericBuffer === "-.") {
    return false
  }
  const num = Number(state.numericBuffer)
  if (!Number.isFinite(num)) return false
  if (state.mode === "rotate" || state.numericAxis === "yaw") {
    state.currentYaw = (num * Math.PI) / 180
  } else if (state.numericAxis === "x") {
    state.currentX = num
  } else if (state.numericAxis === "z") {
    state.currentZ = num
  }
  return true
}

export type TransformGizmoCallbacks = {
  onStartHandleDrag: (mode: TransformMode, pointerId: number, clientX: number, clientY: number) => void
  onCommitNumeric: (axis: NumericAxis, value: number) => void
  onHoverHandle?: (mode: TransformMode | null, clientX: number, clientY: number) => void
}

export function createTransformGizmoDOM(host: HTMLElement, callbacks: TransformGizmoCallbacks) {
  const root = document.createElement("div")
  root.className = "lab-gizmo"
  root.dataset.transformGizmo = ""
  root.hidden = true

  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  ring.setAttribute("class", "lab-gizmo-ring")
  ring.setAttribute("viewBox", "-240 -240 480 480")
  ring.setAttribute("aria-hidden", "true")

  const ringPoly = document.createElementNS("http://www.w3.org/2000/svg", "polygon")
  ringPoly.setAttribute("class", "lab-gizmo-ring-ellipse")

  const ringSpoke = document.createElementNS("http://www.w3.org/2000/svg", "line")
  ringSpoke.setAttribute("class", "lab-gizmo-ring-spoke")
  ringSpoke.setAttribute("x1", "0")
  ringSpoke.setAttribute("y1", "0")
  ringSpoke.setAttribute("x2", "0")
  ringSpoke.setAttribute("y2", "-42")

  ring.append(ringPoly, ringSpoke)

  const moveBtn = document.createElement("button")
  moveBtn.type = "button"
  moveBtn.className = "lab-gizmo-handle lab-gizmo-move"
  moveBtn.dataset.gizmoHandle = "move"
  moveBtn.setAttribute("aria-label", "Move handle")
  moveBtn.title = "Drag to move on ground (G · Alt fine snap)"
  moveBtn.textContent = "✥"

  const rotateBtn = document.createElement("button")
  rotateBtn.type = "button"
  rotateBtn.className = "lab-gizmo-handle lab-gizmo-rotate"
  rotateBtn.dataset.gizmoHandle = "rotate"
  rotateBtn.setAttribute("aria-label", "Rotate handle")
  rotateBtn.title = "Drag to rotate yaw (⇧R · Shift 15° snap)"
  rotateBtn.textContent = "↻"

  const numBar = document.createElement("div")
  numBar.className = "lab-gizmo-numeric"
  numBar.dataset.gizmoNumeric = ""

  function makeNumericField(axis: NumericAxis, labelText: string, step: string) {
    const wrap = document.createElement("label")
    wrap.className = "lab-gizmo-field"
    const span = document.createElement("span")
    span.textContent = labelText
    const input = document.createElement("input")
    input.type = "number"
    input.step = step
    input.className = "lab-gizmo-input"
    input.dataset.transformInput = axis
    input.setAttribute("aria-label", `Transform ${axis.toUpperCase()}`)
    input.addEventListener("pointerdown", e => e.stopPropagation())
    input.addEventListener("keydown", e => {
      e.stopPropagation()
      if (e.key === "Enter") {
        e.preventDefault()
        const v = Number(input.value)
        if (Number.isFinite(v)) callbacks.onCommitNumeric(axis, v)
        input.blur()
      } else if (e.key === "Escape") {
        e.preventDefault()
        input.blur()
      }
    })
    input.addEventListener("change", () => {
      const v = Number(input.value)
      if (Number.isFinite(v)) callbacks.onCommitNumeric(axis, v)
    })
    wrap.append(span, input)
    return { wrap, input }
  }

  const fieldX = makeNumericField("x", "X", "0.25")
  const fieldZ = makeNumericField("z", "Z", "0.25")
  const fieldYaw = makeNumericField("yaw", "°", "5")
  numBar.append(fieldX.wrap, fieldZ.wrap, fieldYaw.wrap)

  moveBtn.addEventListener("pointerenter", event => {
    callbacks.onHoverHandle?.("move", event.clientX, event.clientY)
  })
  moveBtn.addEventListener("pointermove", event => {
    callbacks.onHoverHandle?.("move", event.clientX, event.clientY)
  })
  moveBtn.addEventListener("pointerleave", event => {
    callbacks.onHoverHandle?.(null, event.clientX, event.clientY)
  })
  moveBtn.addEventListener("pointerdown", event => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    callbacks.onStartHandleDrag("move", event.pointerId, event.clientX, event.clientY)
  })

  rotateBtn.addEventListener("pointerenter", event => {
    callbacks.onHoverHandle?.("rotate", event.clientX, event.clientY)
  })
  rotateBtn.addEventListener("pointermove", event => {
    callbacks.onHoverHandle?.("rotate", event.clientX, event.clientY)
  })
  rotateBtn.addEventListener("pointerleave", event => {
    callbacks.onHoverHandle?.(null, event.clientX, event.clientY)
  })
  rotateBtn.addEventListener("pointerdown", event => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    callbacks.onStartHandleDrag("rotate", event.pointerId, event.clientX, event.clientY)
  })

  root.append(ring, moveBtn, rotateBtn, numBar)
  host.append(root)

  function sync(opts: {
    visible: boolean
    screenX: number
    screenY: number
    x: number
    z: number
    yawRad: number
    activeMode: TransformMode | null
    ringPoints?: readonly { x: number; y: number }[]
    handleOffset?: { x: number; y: number }
  }) {
    if (!opts.visible) {
      root.hidden = true
      return
    }
    root.hidden = false
    root.dataset.activeMode = opts.activeMode ?? "idle"
    root.style.left = `${Math.round(opts.screenX)}px`
    root.style.top = `${Math.round(opts.screenY)}px`

    const rx = opts.handleOffset ? Math.round(opts.handleOffset.x * 10) / 10 : Math.round(Math.sin(opts.yawRad) * 42 * 10) / 10
    const ry = opts.handleOffset ? Math.round(opts.handleOffset.y * 10) / 10 : Math.round(Math.cos(opts.yawRad) * 42 * 10) / 10
    rotateBtn.style.setProperty("--rot-x", `${rx}px`)
    rotateBtn.style.setProperty("--rot-y", `${ry}px`)
    ringSpoke.setAttribute("x2", String(rx))
    ringSpoke.setAttribute("y2", String(ry))

    if (opts.ringPoints && opts.ringPoints.length > 0) {
      ringPoly.setAttribute(
        "points",
        opts.ringPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "),
      )
      let maxY = 24
      for (const p of opts.ringPoints) {
        if (p.y > maxY) maxY = p.y
      }
      numBar.style.top = `${Math.round(Math.min(140, Math.max(42, maxY + 18)))}px`
    } else {
      const fallbackPts: string[] = []
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2
        fallbackPts.push(`${(Math.sin(a) * 42).toFixed(1)},${(Math.cos(a) * 42).toFixed(1)}`)
      }
      ringPoly.setAttribute("points", fallbackPts.join(" "))
      numBar.style.top = "52px"
    }

    if (document.activeElement !== fieldX.input) {
      fieldX.input.value = String(Number(opts.x.toFixed(2)))
    }
    if (document.activeElement !== fieldZ.input) {
      fieldZ.input.value = String(Number(opts.z.toFixed(2)))
    }
    if (document.activeElement !== fieldYaw.input) {
      const deg = Math.round(((opts.yawRad * 180) / Math.PI + 540) % 360) - 180
      fieldYaw.input.value = String(deg)
    }
  }

  return {
    root,
    moveBtn,
    rotateBtn,
    inputs: { x: fieldX.input, z: fieldZ.input, yaw: fieldYaw.input },
    sync,
  }
}

export {
  createViewportCursorDOM,
  ensureViewportCursorStyles,
  isInteractiveFormElement,
  sampleGroundNormal,
  type GroundSurfaceSample,
  type ViewportCursorState,
  type ViewportCursorUpdate,
} from "./viewport-cursor"


