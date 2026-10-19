export type ViewportCursorState =
  | "hidden"
  | "default"
  | "orbit"
  | "pan"
  | "hover"
  | "place"
  | "marquee"
  | "move"
  | "rotate"
  | "radial"
  | "disabled"

export type GroundSurfaceSample = {
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  pitch: number
  roll: number
  slopeDeg: number
}

/**
 * Computes ground elevation and finite-difference surface normal (nx, ny, nz)
 * so placement reticles and ground markers align with ramps and sloped terrain.
 */
export function sampleGroundNormal(
  x: number,
  z: number,
  groundFn: (x: number, z: number) => number = () => 0,
  eps = 0.2,
): GroundSurfaceSample {
  const y = groundFn(x, z)
  const hx1 = groundFn(x + eps, z)
  const hx0 = groundFn(x - eps, z)
  const hz1 = groundFn(x, z + eps)
  const hz0 = groundFn(x, z - eps)
  const dhdx = (hx1 - hx0) / (2 * eps)
  const dhdz = (hz1 - hz0) / (2 * eps)
  const len = Math.hypot(dhdx, 1, dhdz) || 1
  const nx = -dhdx / len
  const ny = 1 / len
  const nz = -dhdz / len
  const slopeDeg = (Math.acos(Math.max(-1, Math.min(1, ny))) * 180) / Math.PI
  const pitch = Math.atan2(-dhdz, 1)
  const roll = Math.atan2(dhdx, 1)
  return {
    x,
    y,
    z,
    nx: Number(nx.toFixed(4)),
    ny: Number(ny.toFixed(4)),
    nz: Number(nz.toFixed(4)),
    pitch: Number(pitch.toFixed(4)),
    roll: Number(roll.toFixed(4)),
    slopeDeg: Number(slopeDeg.toFixed(2)),
  }
}

export function isInteractiveFormElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement ||
    target.isContentEditable
  ) {
    return true
  }
  return Boolean(target.closest("input, textarea, select, button, [contenteditable='true'], [data-lab]"))
}

const CURSOR_STYLE_ID = "arcade-viewport-cursor-style"

const CURSOR_CSS = /* css */ `
.lab-viewport-cursor {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  pointer-events: none;
  user-select: none;
  z-index: 80;
  will-change: transform;
}

.lab-viewport-cursor-glyph {
  position: absolute;
  left: -16px;
  top: -16px;
  width: 32px;
  height: 32px;
  overflow: visible;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.85));
  transition: transform 90ms cubic-bezier(0.22, 1, 0.36, 1), opacity 80ms ease;
}

@media (prefers-reduced-motion: reduce) {
  .lab-viewport-cursor-glyph,
  .lab-viewport-cursor-tag {
    transition: none !important;
  }
}

.lab-viewport-cursor .vc-halo {
  fill: none;
  stroke: #070a0ee8;
  stroke-width: 3.4px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lab-viewport-cursor .vc-fg {
  fill: none;
  stroke: #eef6fc;
  stroke-width: 1.6px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lab-viewport-cursor[data-cursor-state="hover"] .vc-fg,
.lab-viewport-cursor[data-cursor-state="marquee"] .vc-fg,
.lab-viewport-cursor[data-cursor-state="move"] .vc-fg {
  stroke: #7ee0f5;
}

.lab-viewport-cursor[data-cursor-state="place"] .vc-fg {
  stroke: #68f0b2;
}

.lab-viewport-cursor[data-cursor-state="rotate"] .vc-fg {
  stroke: #ffbe6b;
}

.lab-viewport-cursor[data-cursor-state="disabled"] .vc-fg {
  stroke: #ff7a7a;
}

.lab-viewport-cursor[data-cursor-state="radial"] .vc-fg {
  stroke: #9de2f2;
}

.lab-viewport-cursor-tag {
  position: absolute;
  left: 14px;
  top: 10px;
  padding: 1.5px 6px;
  border-radius: 4px;
  background: #0d131ae8;
  border: 1px solid #2f4050;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
  color: #e6f1f8;
  font: 500 9.5px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 90ms ease, transform 90ms ease;
}

.lab-viewport-cursor-tag[data-visible="true"] {
  opacity: 1;
  transform: translateY(0);
}

canvas[data-custom-cursor="active"] {
  cursor: none !important;
}

/* The drawn glyph lives in the viewport HUD, which is hidden with the workbench chrome (Backquote, Overworld). */
.lab-workbench[data-closed="true"] canvas[data-custom-cursor="active"] {
  cursor: default !important;
}

.lab-workbench[data-closed="true"] canvas[data-custom-cursor="active"][data-hover-target="true"] {
  cursor: pointer !important;
}
`

export function ensureViewportCursorStyles(doc: Document = document): void {
  if (doc.getElementById(CURSOR_STYLE_ID)) return
  const style = doc.createElement("style")
  style.id = CURSOR_STYLE_ID
  style.textContent = CURSOR_CSS
  doc.head.append(style)
}

function buildCursorSvgMarkup(
  state: ViewportCursorState,
  normal?: { nx: number; ny: number; nz: number },
  radialVec?: { dx: number; dy: number },
): string {
  const dual = (d: string) => `<path class="vc-halo" d="${d}"/><path class="vc-fg" d="${d}"/>`
  const dualCircle = (cx: number, cy: number, r: number, dash = "") =>
    `<circle class="vc-halo" cx="${cx}" cy="${cy}" r="${r}" ${dash}/><circle class="vc-fg" cx="${cx}" cy="${cy}" r="${r}" ${dash}/>`

  switch (state) {
    case "default": {
      const nx = (normal?.nx ?? 0) * 6
      const nz = (normal?.nz ?? 0) * 6
      const ry = Math.max(2.5, 5.5 * (normal?.ny ?? 1)).toFixed(1)
      return [
        `<ellipse class="vc-halo" cx="16" cy="16" rx="6.5" ry="${ry}" stroke-dasharray="2.5 2.5"/>`,
        `<ellipse class="vc-fg" cx="16" cy="16" rx="6.5" ry="${ry}" stroke-dasharray="2.5 2.5"/>`,
        dual(`M 16 16 L ${(16 + nx).toFixed(1)} ${(10 + nz).toFixed(1)}`),
        dualCircle(16, 16, 1.4),
      ].join("")
    }
    case "hover":
      return [
        dual("M 7 11 L 7 7 L 11 7"),
        dual("M 21 7 L 25 7 L 25 11"),
        dual("M 25 21 L 25 25 L 21 25"),
        dual("M 11 25 L 7 25 L 7 21"),
        dualCircle(16, 16, 1.8),
      ].join("")
    case "place": {
      const nx = (normal?.nx ?? 0) * 7
      const nz = (normal?.nz ?? 0) * 7
      const ry = Math.max(3, 7 * (normal?.ny ?? 1)).toFixed(1)
      return [
        `<ellipse class="vc-halo" cx="16" cy="18" rx="8" ry="${ry}"/>`,
        `<ellipse class="vc-fg" cx="16" cy="18" rx="8" ry="${ry}"/>`,
        dual(`M 16 18 L ${(16 + nx).toFixed(1)} ${(8 + nz).toFixed(1)}`),
        dual("M 13.5 10.5 L 16 8 L 18.5 10.5"),
        dual("M 10 18 L 22 18"),
      ].join("")
    }
    case "move":
      return [
        dual("M 16 5 L 16 27 M 5 16 L 27 16"),
        dual("M 13.5 7.5 L 16 5 L 18.5 7.5"),
        dual("M 13.5 24.5 L 16 27 L 18.5 24.5"),
        dual("M 7.5 13.5 L 5 16 L 7.5 18.5"),
        dual("M 24.5 13.5 L 27 16 L 24.5 18.5"),
      ].join("")
    case "rotate":
      return [
        dual("M 8.5 19 A 8.5 8.5 0 1 1 23.5 19"),
        dual("M 21 15.5 L 24 19.5 L 19.5 20.5"),
        dualCircle(16, 16, 1.5),
      ].join("")
    case "marquee":
      return [
        dual("M 6 12 L 6 6 L 12 6"),
        dual("M 20 6 L 26 6 L 26 12"),
        dual("M 26 20 L 26 26 L 20 26"),
        dual("M 12 26 L 6 26 L 6 20"),
        dual("M 13 16 L 19 16 M 16 13 L 16 19"),
      ].join("")
    case "pan":
      return [
        dual("M 16 6 L 16 26 M 6 16 L 26 16"),
        dual("M 14 8 L 16 6 L 18 8 M 14 24 L 16 26 L 18 24"),
        dual("M 8 14 L 6 16 L 8 18 M 24 14 L 26 16 L 24 18"),
        dualCircle(16, 16, 2.5),
      ].join("")
    case "orbit":
      return [
        dual("M 6 16 A 10 5.5 0 1 0 26 16"),
        dual("M 9 11 A 9 9 0 0 1 23 11"),
        dual("M 23.5 13.5 L 26 16 L 23 18"),
        dual("M 8.5 13.5 L 6 16 L 9 18"),
        dualCircle(16, 16, 1.6),
      ].join("")
    case "radial": {
      const dx = radialVec?.dx ?? 0
      const dy = radialVec?.dy ?? -8
      const len = Math.hypot(dx, dy) || 1
      const ux = (dx / len) * Math.min(10, Math.max(4, len * 0.18))
      const uy = (dy / len) * Math.min(10, Math.max(4, len * 0.18))
      return [
        dualCircle(16, 16, 5, 'stroke-dasharray="2 2"'),
        dual(`M 16 16 L ${(16 + ux).toFixed(1)} ${(16 + uy).toFixed(1)}`),
        dualCircle(16 + ux, 16 + uy, 1.8),
      ].join("")
    }
    case "disabled":
      return [
        dualCircle(16, 16, 7.5),
        dual("M 10.8 10.8 L 21.2 21.2"),
      ].join("")
    default:
      return ""
  }
}

export type ViewportCursorUpdate = {
  state: ViewportCursorState
  x?: number
  y?: number
  label?: string
  immediateLabel?: boolean
  normal?: { nx: number; ny: number; nz: number }
  radialVec?: { dx: number; dy: number }
  /** Report the state but show the OS cursor (zero-latency) instead of the drawn glyph. */
  native?: boolean
}

const FALLBACK_CURSOR: Record<ViewportCursorState, string> = {
  hidden: "default",
  default: "crosshair",
  orbit: "grabbing",
  pan: "move",
  hover: "pointer",
  place: "crosshair",
  marquee: "crosshair",
  move: "move",
  rotate: "ew-resize",
  radial: "default",
  disabled: "not-allowed",
}

export function createViewportCursorDOM(
  host: HTMLElement,
  options: { canvas?: HTMLCanvasElement; hoverDelayMs?: number } = {},
) {
  ensureViewportCursorStyles(host.ownerDocument)
  const hoverDelayMs = options.hoverDelayMs ?? 180

  const el = document.createElement("div")
  el.className = "lab-viewport-cursor"
  el.dataset.viewportCursor = ""
  el.dataset.cursorState = "hidden"
  el.hidden = true

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 32 32")
  svg.setAttribute("class", "lab-viewport-cursor-glyph")
  svg.setAttribute("aria-hidden", "true")

  const tag = document.createElement("span")
  tag.className = "lab-viewport-cursor-tag"
  tag.dataset.cursorTag = ""
  tag.dataset.visible = "false"
  tag.hidden = true

  el.append(svg, tag)
  host.append(el)

  let lastState: ViewportCursorState = "hidden"
  let lastHoverLabel = ""
  let hoverTimer = 0
  let labelReady = false
  let lastX = 0
  let lastY = 0

  function clearHoverTimer() {
    if (hoverTimer) {
      window.clearTimeout(hoverTimer)
      hoverTimer = 0
    }
  }

  function update(opts: ViewportCursorUpdate) {
    const nextState = opts.state
    if (!opts.native && opts.x !== undefined && opts.y !== undefined) {
      lastX = opts.x
      lastY = opts.y
      el.style.transform = `translate3d(${Math.round(lastX)}px, ${Math.round(lastY)}px, 0)`
    }

    if (nextState === "hidden") {
      clearHoverTimer()
      labelReady = false
      lastHoverLabel = ""
      el.dataset.cursorState = "hidden"
      el.hidden = true
      tag.dataset.visible = "false"
      tag.hidden = true
      if (options.canvas) {
        options.canvas.dataset.customCursor = "off"
        options.canvas.style.cursor = "default"
      }
      lastState = "hidden"
      return
    }

    if (opts.native) {
      clearHoverTimer()
      labelReady = false
      lastHoverLabel = ""
      if (el.dataset.cursorState !== nextState) el.dataset.cursorState = nextState
      if (!el.hidden) el.hidden = true
      tag.dataset.visible = "false"
      if (!tag.hidden) tag.hidden = true
      if (options.canvas) {
        if (options.canvas.dataset.customCursor !== "off") options.canvas.dataset.customCursor = "off"
        const cursor = FALLBACK_CURSOR[nextState]
        if (options.canvas.style.cursor !== cursor) options.canvas.style.cursor = cursor
      }
      lastState = nextState
      return
    }

    el.hidden = false
    el.dataset.cursorState = nextState
    if (options.canvas) {
      options.canvas.dataset.customCursor = "active"
      options.canvas.style.cursor = FALLBACK_CURSOR[nextState]
    }

    if (
      nextState !== lastState ||
      nextState === "default" ||
      nextState === "place" ||
      nextState === "radial"
    ) {
      svg.innerHTML = buildCursorSvgMarkup(nextState, opts.normal, opts.radialVec)
    }

    const label = opts.label ?? ""
    if (!label || nextState === "orbit" || nextState === "pan" || nextState === "default") {
      clearHoverTimer()
      labelReady = false
      lastHoverLabel = ""
      tag.dataset.visible = "false"
      tag.hidden = true
    } else if (opts.immediateLabel || nextState !== "hover" || hoverDelayMs <= 0) {
      clearHoverTimer()
      labelReady = true
      lastHoverLabel = label
      tag.textContent = label
      tag.hidden = false
      tag.dataset.visible = "true"
    } else if (label !== lastHoverLabel) {
      clearHoverTimer()
      lastHoverLabel = label
      labelReady = false
      tag.textContent = label
      tag.hidden = false
      tag.dataset.visible = "false"
      hoverTimer = window.setTimeout(() => {
        labelReady = true
        tag.dataset.visible = "true"
      }, hoverDelayMs)
    } else if (labelReady) {
      tag.textContent = label
      tag.hidden = false
      tag.dataset.visible = "true"
    }

    lastState = nextState
  }

  return {
    el,
    svg,
    tag,
    update,
  }
}
