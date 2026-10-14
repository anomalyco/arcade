import {
  RADIAL_COMPASS,
  type LabCommandContext,
  type LabCommandIcon,
  type LabCommandRegistry,
  type RadialContext,
  type RadialSlot,
  type ResolvedRadialSector,
} from "./commands"

export const RADIAL_DEAD_ZONE_PX = 14
export const RADIAL_OUTER_CANCEL_PX = 220
export const RADIAL_TAP_TIMEOUT_MS = 180
export const RADIAL_TAP_MOVE_PX = 8
/** Ring geometry: hub disc, wedge band and the label circle inside it. */
export const RADIAL_HUB_PX = 34
export const RADIAL_INNER_PX = 40
export const RADIAL_OUTER_PX = 112
export const RADIAL_LABEL_PX = 77
/** Space reserved under the ring for the active-item caption. */
export const RADIAL_CAPTION_PX = 30
export const RADIAL_EDGE_MARGIN_PX = RADIAL_OUTER_PX + 12

export type RadialZone = "deadzone" | "ring" | "cancel"

export function classifyRadialDisplacement(
  dx: number,
  dy: number,
  deadZonePx = RADIAL_DEAD_ZONE_PX,
  outerCancelPx = RADIAL_OUTER_CANCEL_PX,
): { zone: RadialZone; slot: RadialSlot | null; distance: number; angleDeg: number } {
  const distance = Math.hypot(dx, dy)
  if (distance < deadZonePx) {
    return { zone: "deadzone", slot: null, distance, angleDeg: 0 }
  }
  if (distance > outerCancelPx) {
    return { zone: "cancel", slot: null, distance, angleDeg: 0 }
  }
  const rad = Math.atan2(dx, -dy)
  const angleDeg = ((rad * 180) / Math.PI + 360) % 360
  const slot = (((Math.round(rad / (Math.PI / 4)) % 8) + 8) % 8) as RadialSlot
  return { zone: "ring", slot, distance, angleDeg }
}

export function clampRadialCenter(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = RADIAL_EDGE_MARGIN_PX,
  bottomMargin = margin + RADIAL_CAPTION_PX,
): { x: number; y: number } {
  const minX = Math.min(margin, viewportWidth / 2)
  const maxX = Math.max(minX, viewportWidth - margin)
  const minY = Math.min(margin, viewportHeight / 2)
  const maxY = Math.max(minY, viewportHeight - bottomMargin)
  return {
    x: Math.max(minX, Math.min(maxX, x)),
    y: Math.max(minY, Math.min(maxY, y)),
  }
}

export type RadialReleaseResult =
  | { outcome: "latched" }
  | { outcome: "execute"; sector: ResolvedRadialSector }
  | { outcome: "disabled"; sector: ResolvedRadialSector }
  | { outcome: "cancel" }

export class RadialMenuStateMachine {
  phase: "closed" | "holding" | "latched" = "closed"
  ringContext: RadialContext = "ground"
  commandContext: LabCommandContext = { pickedObject: null, groundHit: null }
  sectors: readonly ResolvedRadialSector[] = []
  openTime = 0
  anchorX = 0
  anchorY = 0
  visualX = 0
  visualY = 0
  maxDisplacement = 0
  activeSlot: RadialSlot | null = null
  zone: RadialZone = "deadzone"
  /** Pointer bearing from the menu centre (degrees clockwise from north) while outside the dead zone. */
  pointerAngle: number | null = null

  constructor(private readonly registry: LabCommandRegistry) {}

  openPointer(
    x: number,
    y: number,
    viewportWidth: number,
    viewportHeight: number,
    now: number,
    ctx: LabCommandContext,
  ): void {
    this.phase = "holding"
    this.ringContext = ctx.pickedObject ? "object" : "ground"
    this.commandContext = ctx
    this.sectors = this.registry.resolveRadialRing(this.ringContext, ctx)
    this.openTime = now
    this.anchorX = x
    this.anchorY = y
    const clamped = clampRadialCenter(x, y, viewportWidth, viewportHeight)
    this.visualX = clamped.x
    this.visualY = clamped.y
    this.maxDisplacement = 0
    this.activeSlot = null
    this.zone = "deadzone"
    this.pointerAngle = null
  }

  openKeyboard(
    x: number,
    y: number,
    viewportWidth: number,
    viewportHeight: number,
    now: number,
    ctx: LabCommandContext,
  ): void {
    this.openPointer(x, y, viewportWidth, viewportHeight, now, ctx)
    this.phase = "latched"
    const firstEnabled = this.sectors.find(s => s.enabled)?.slot ?? 0
    this.activeSlot = firstEnabled
    this.zone = "ring"
  }

  movePointer(x: number, y: number): void {
    if (this.phase === "closed") return
    const originX = this.phase === "holding" ? this.anchorX : this.visualX
    const originY = this.phase === "holding" ? this.anchorY : this.visualY
    const dx = x - originX
    const dy = y - originY
    this.maxDisplacement = Math.max(this.maxDisplacement, Math.hypot(x - this.anchorX, y - this.anchorY))
    const classified = classifyRadialDisplacement(dx, dy)
    this.zone = classified.zone
    this.activeSlot = classified.slot
    this.pointerAngle = classified.zone === "ring" ? classified.angleDeg : null
  }

  releasePointer(x: number, y: number, now: number): RadialReleaseResult {
    if (this.phase === "closed") return { outcome: "cancel" }
    this.movePointer(x, y)
    const elapsed = now - this.openTime
    if (this.phase === "holding" && elapsed < RADIAL_TAP_TIMEOUT_MS && this.maxDisplacement < RADIAL_TAP_MOVE_PX) {
      this.phase = "latched"
      this.activeSlot = this.sectors.find(s => s.enabled)?.slot ?? 0
      this.zone = "ring"
      return { outcome: "latched" }
    }
    if (this.zone === "ring" && this.activeSlot !== null) {
      const sector = this.sectors[this.activeSlot]!
      this.close()
      if (sector.enabled) {
        return { outcome: "execute", sector }
      }
      return { outcome: "disabled", sector }
    }
    this.close()
    return { outcome: "cancel" }
  }

  selectSlot(slot: RadialSlot): RadialReleaseResult {
    if (this.phase === "closed") return { outcome: "cancel" }
    const sector = this.sectors[slot]
    if (!sector) {
      this.close()
      return { outcome: "cancel" }
    }
    this.close()
    if (sector.enabled) return { outcome: "execute", sector }
    return { outcome: "disabled", sector }
  }

  handleKey(eventKey: string): RadialReleaseResult | { outcome: "navigate"; slot: RadialSlot } | null {
    if (this.phase === "closed") return null
    if (eventKey === "Escape") {
      this.close()
      return { outcome: "cancel" }
    }
    if (eventKey === "ArrowRight" || eventKey === "ArrowDown") {
      const next = (((this.activeSlot ?? -1) + 1) % 8) as RadialSlot
      this.activeSlot = next
      this.zone = "ring"
      return { outcome: "navigate", slot: next }
    }
    if (eventKey === "ArrowLeft" || eventKey === "ArrowUp") {
      const prev = (((this.activeSlot ?? 1) + 7) % 8) as RadialSlot
      this.activeSlot = prev
      this.zone = "ring"
      return { outcome: "navigate", slot: prev }
    }
    if (eventKey === "Enter") {
      if (this.activeSlot !== null) return this.selectSlot(this.activeSlot)
      this.close()
      return { outcome: "cancel" }
    }
    if (eventKey >= "1" && eventKey <= "8") {
      const slot = (Number(eventKey) - 1) as RadialSlot
      return this.selectSlot(slot)
    }
    const norm = eventKey === " " ? "space" : eventKey.toLowerCase()
    for (const sector of this.sectors) {
      const accels = sector.command.accelerators ?? (sector.command.shortcut ? [sector.command.shortcut.toLowerCase()] : [])
      if (accels.some(a => a.toLowerCase() === norm)) {
        return this.selectSlot(sector.slot)
      }
    }
    return null
  }

  close(): void {
    this.phase = "closed"
    this.activeSlot = null
    this.zone = "deadzone"
    this.pointerAngle = null
  }
}

const SVG_NS = "http://www.w3.org/2000/svg"
const RING_BOX = RADIAL_OUTER_PX + 6

/** 24 px Lucide-style strokes, drawn at 16 px. */
const ICON_PATHS: Record<LabCommandIcon, string> = {
  zap: "M13 2 4 14h7l-1 8 9-12h-7l1-8z",
  gamepad:
    "M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7a4 4 0 0 0-4 3.6l-.9 7.4A3 3 0 0 0 4.8 19.5c1 0 1.9-.5 2.4-1.3l1.3-1.7h7l1.3 1.7c.5.8 1.4 1.3 2.4 1.3a3 3 0 0 0 3-3.5l-.9-7.4a4 4 0 0 0-4-3.6z",
  copy: "M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM4 16a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  reset: "M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5",
  move: "M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20",
  frame: "M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  "pin-plus": "M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12zM12 7v6M9 10h6",
  "user-plus": "M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M19 8v6M16 11h6",
  light: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2v.3h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z",
  eraser: "M7 21 2.7 16.7a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21M22 21H7M5 11l9 9",
  shuffle:
    "M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22M18 2l4 4-4 4M2 6h1.9c1.5 0 2.9.9 3.6 2.2M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8M18 14l4 4-4 4",
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

function polar(r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180
  return [+(Math.sin(rad) * r).toFixed(2), +(-Math.cos(rad) * r).toFixed(2)]
}

/** Annular sector centred on north, inset by `gap` px along both radial edges. */
export function radialWedgePath(inner: number, outer: number, halfDeg: number, gap = 0): string {
  const inIn = (Math.asin(Math.min(1, gap / inner)) * 180) / Math.PI
  const inOut = (Math.asin(Math.min(1, gap / outer)) * 180) / Math.PI
  const [ax, ay] = polar(outer, -halfDeg + inOut)
  const [bx, by] = polar(outer, halfDeg - inOut)
  const [cx, cy] = polar(inner, halfDeg - inIn)
  const [dx, dy] = polar(inner, -halfDeg + inIn)
  return `M${ax} ${ay}A${outer} ${outer} 0 0 1 ${bx} ${by}L${cx} ${cy}A${inner} ${inner} 0 0 0 ${dx} ${dy}Z`
}

function arcPath(r: number, fromDeg: number, toDeg: number): string {
  const [ax, ay] = polar(r, fromDeg)
  const [bx, by] = polar(r, toDeg)
  return `M${ax} ${ay}A${r} ${r} 0 0 1 ${bx} ${by}`
}

function ringSvg(className: string) {
  const svg = svgEl("svg", {
    class: className,
    viewBox: `${-RING_BOX} ${-RING_BOX} ${RING_BOX * 2} ${RING_BOX * 2}`,
    width: RING_BOX * 2,
    height: RING_BOX * 2,
    "aria-hidden": "true",
  })
  return svg
}

function iconSvg(icon: LabCommandIcon | undefined) {
  const svg = svgEl("svg", { class: "lab-radial-icon", viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true" })
  if (icon) svg.append(svgEl("path", { d: ICON_PATHS[icon] }))
  else svg.append(svgEl("circle", { cx: 12, cy: 12, r: 2.5 }))
  return svg
}

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Ring of 8 equal wedges. Static parts (disc, separators, labels) are built once per open; pointer moves only
 * rotate the highlight wedge and direction pointer (compositor transforms) and retarget two label states.
 */
export function createRadialMenuDOM(
  host: HTMLElement,
  stateMachine: RadialMenuStateMachine,
  onResult: (res: RadialReleaseResult) => void,
) {
  const root = document.createElement("div")
  root.className = "lab-radial"
  root.dataset.labRadial = ""
  root.dataset.phase = "closed"
  root.hidden = true
  root.tabIndex = -1
  root.setAttribute("role", "menu")
  root.setAttribute("aria-label", "Contextual radial menu")

  const body = document.createElement("div")
  body.className = "lab-radial-body"

  const disc = ringSvg("lab-radial-disc")
  disc.append(
    svgEl("circle", { class: "lab-radial-band", r: RADIAL_OUTER_PX }),
  )
  for (let i = 0; i < 8; i++) {
    const [x1, y1] = polar(RADIAL_INNER_PX + 6, 22.5 + i * 45)
    const [x2, y2] = polar(RADIAL_OUTER_PX - 10, 22.5 + i * 45)
    disc.append(svgEl("line", { class: "lab-radial-sep", x1, y1, x2, y2 }))
  }
  disc.append(svgEl("circle", { class: "lab-radial-hub", r: RADIAL_HUB_PX }))

  const highlightSvg = ringSvg("lab-radial-highlight")
  highlightSvg.append(
    svgEl("path", { class: "lab-radial-wedge", d: radialWedgePath(RADIAL_INNER_PX + 2, RADIAL_OUTER_PX - 2, 22.5, 1.5) }),
    svgEl("path", { class: "lab-radial-lip", d: arcPath(RADIAL_OUTER_PX - 3.5, -19, 19) }),
  )

  const pointerSvg = ringSvg("lab-radial-pointer")
  pointerSvg.append(
    svgEl("path", { class: "lab-radial-pointer-arc", d: arcPath(RADIAL_HUB_PX, -24, 24) }),
    svgEl("path", { class: "lab-radial-pointer-tip", d: `M-4 ${-RADIAL_HUB_PX - 1}L0 ${-RADIAL_HUB_PX - 6}L4 ${-RADIAL_HUB_PX - 1}Z` }),
  )

  const centerRing = document.createElement("div")
  centerRing.className = "lab-radial-center"
  const centerTitle = document.createElement("span")
  centerTitle.className = "lab-radial-target"
  centerTitle.dataset.radialTarget = ""
  const centerSub = document.createElement("span")
  centerSub.className = "lab-radial-sub"
  centerSub.dataset.radialSub = ""
  centerRing.append(centerTitle, centerSub)

  const caption = document.createElement("div")
  caption.className = "lab-radial-caption"
  caption.dataset.radialCaption = ""
  caption.setAttribute("aria-live", "polite")
  const captionText = document.createElement("span")
  captionText.className = "lab-radial-caption-text"
  const captionKbd = document.createElement("kbd")
  captionKbd.className = "lab-radial-kbd"
  caption.append(captionText, captionKbd)

  body.append(disc, highlightSvg, pointerSvg, centerRing)

  const sectorButtons: HTMLButtonElement[] = RADIAL_COMPASS.map(({ slot, compass, angle }) => {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.tabIndex = -1
    btn.className = "lab-radial-sector"
    btn.setAttribute("role", "menuitem")
    btn.dataset.sector = String(slot)
    btn.dataset.compass = compass
    btn.dataset.angle = String(angle)
    const [sx, sy] = polar(RADIAL_LABEL_PX, angle)
    btn.style.setProperty("--sector-x", `${sx}px`)
    btn.style.setProperty("--sector-y", `${sy}px`)
    body.append(btn)
    return btn
  })
  body.append(caption)
  root.append(body)
  host.append(root)

  // The whole disc is one target: a press anywhere selects by direction from the centre, like the canvas.
  root.addEventListener("pointerdown", event => {
    if (stateMachine.phase !== "latched") return
    event.preventDefault()
    event.stopPropagation()
    const rect = host.getBoundingClientRect()
    const res = stateMachine.releasePointer(event.clientX - rect.left, event.clientY - rect.top, performance.now())
    sync()
    onResult(res)
  })
  root.addEventListener("contextmenu", event => event.preventDefault())

  let renderedSectors: readonly ResolvedRadialSector[] | null = null
  let renderedActive = -1
  let renderedHighlight = ""
  let renderedPointer = ""
  let renderedCaption = ""
  let renderedPhase = ""

  function setText(el: HTMLElement, text: string) {
    if (el.textContent !== text) el.textContent = text
  }

  function renderOpen() {
    const picked = stateMachine.commandContext.pickedObject
    const hit = stateMachine.commandContext.groundHit
    root.dataset.context = stateMachine.ringContext
    setText(centerTitle, picked ? picked.label : "Ground")
    setText(centerSub, picked ? picked.category : hit ? `${hit.x.toFixed(1)}, ${hit.z.toFixed(1)}` : "")
    centerRing.title = picked ? picked.label : hit ? `Ground (${hit.x.toFixed(1)}, ${hit.z.toFixed(1)})` : "Ground"
    for (const sector of stateMachine.sectors) {
      const btn = sectorButtons[sector.slot]!
      btn.dataset.active = "false"
      btn.setAttribute("aria-disabled", String(!sector.enabled))
      btn.setAttribute(
        "aria-label",
        sector.enabled
          ? `${sector.command.label}${sector.command.shortcut ? ` (${sector.command.shortcut})` : ""}`
          : `${sector.command.label}, unavailable: ${sector.disabledReason}`,
      )
      const label = document.createElement("span")
      label.className = "lab-radial-label"
      label.textContent = sector.command.shortLabel
      btn.replaceChildren(iconSvg(sector.command.icon), label)
    }
    renderedActive = -1
    renderedHighlight = ""
    renderedPointer = ""
    renderedCaption = ""
    if (!prefersReducedMotion()) {
      body.animate(
        [
          { opacity: 0.5, transform: "scale(0.94)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 140, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      )
    }
  }

  function sync() {
    if (stateMachine.phase === "closed") {
      if (!root.hidden) root.hidden = true
      root.dataset.phase = "closed"
      renderedSectors = null
      renderedPhase = "closed"
      return
    }
    const opening = renderedSectors !== stateMachine.sectors
    root.style.transform = `translate3d(${stateMachine.visualX}px, ${stateMachine.visualY}px, 0)`
    if (opening) {
      renderedSectors = stateMachine.sectors
      root.hidden = false
      renderOpen()
    }
    if (renderedPhase !== stateMachine.phase) {
      renderedPhase = stateMachine.phase
      root.dataset.phase = stateMachine.phase
    }

    const inRing = stateMachine.zone === "ring" && stateMachine.activeSlot !== null
    const active = inRing ? stateMachine.activeSlot! : -1
    const activeSector = active >= 0 ? stateMachine.sectors[active] : null
    if (active !== renderedActive) {
      if (renderedActive >= 0) sectorButtons[renderedActive]!.dataset.active = "false"
      if (active >= 0) sectorButtons[active]!.dataset.active = "true"
      renderedActive = active
    }

    const highlightKey = activeSector ? `${activeSector.angle}:${activeSector.enabled}` : ""
    if (highlightKey !== renderedHighlight) {
      renderedHighlight = highlightKey
      root.dataset.highlight = activeSector ? (activeSector.enabled ? "on" : "disabled") : "off"
      if (activeSector) highlightSvg.style.transform = `rotate(${activeSector.angle}deg)`
    }

    const angle = stateMachine.pointerAngle ?? (activeSector ? activeSector.angle : null)
    const pointerKey = angle === null ? "" : angle.toFixed(1)
    if (pointerKey !== renderedPointer) {
      renderedPointer = pointerKey
      root.dataset.pointer = angle === null ? "off" : "on"
      if (angle !== null) pointerSvg.style.transform = `rotate(${pointerKey}deg)`
    }

    let text: string
    let kbd = ""
    let tone = "hint"
    if (stateMachine.zone === "cancel") {
      text = "Release to cancel"
    } else if (activeSector && !activeSector.enabled) {
      text = activeSector.disabledReason ?? "Unavailable"
      tone = "disabled"
    } else if (activeSector) {
      text = activeSector.command.label
      kbd = activeSector.command.shortcut ?? ""
      tone = "active"
    } else {
      text = stateMachine.phase === "latched" ? "Click a direction · 1–8 · Esc" : "Flick toward an action, release"
    }
    const captionKey = `${tone}|${text}|${kbd}`
    if (captionKey !== renderedCaption) {
      renderedCaption = captionKey
      caption.dataset.tone = tone
      setText(captionText, text)
      setText(captionKbd, kbd)
      captionKbd.hidden = !kbd
    }
  }

  return {
    root,
    sectorButtons,
    sync,
  }
}
