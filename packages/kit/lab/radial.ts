import {
  RADIAL_COMPASS,
  type LabCommandContext,
  type LabCommandRegistry,
  type RadialContext,
  type RadialSlot,
  type ResolvedRadialSector,
} from "./commands"

export const RADIAL_DEAD_ZONE_PX = 14
export const RADIAL_RADIUS_PX = 96
export const RADIAL_OUTER_CANCEL_PX = 220
export const RADIAL_TAP_TIMEOUT_MS = 180
export const RADIAL_TAP_MOVE_PX = 8
export const RADIAL_EDGE_MARGIN_PX = 116

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
): { x: number; y: number } {
  const minX = Math.min(margin, viewportWidth / 2)
  const maxX = Math.max(minX, viewportWidth - margin)
  const minY = Math.min(margin, viewportHeight / 2)
  const maxY = Math.max(minY, viewportHeight - margin)
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
  }
}

export function createRadialMenuDOM(
  host: HTMLElement,
  stateMachine: RadialMenuStateMachine,
  onResult: (res: RadialReleaseResult) => void,
) {
  const root = document.createElement("div")
  root.className = "lab-radial"
  root.dataset.labRadial = ""
  root.hidden = true
  root.tabIndex = -1
  root.setAttribute("role", "menu")
  root.setAttribute("aria-label", "Contextual radial menu")

  const centerRing = document.createElement("div")
  centerRing.className = "lab-radial-center"
  const centerTitle = document.createElement("span")
  centerTitle.className = "lab-radial-target"
  centerTitle.dataset.radialTarget = ""
  const centerSub = document.createElement("span")
  centerSub.className = "lab-radial-sub"
  centerSub.dataset.radialSub = ""
  centerRing.append(centerTitle, centerSub)
  root.append(centerRing)

  const sectorButtons: HTMLButtonElement[] = RADIAL_COMPASS.map(({ slot, compass, angle }) => {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "lab-radial-sector"
    btn.setAttribute("role", "menuitem")
    btn.dataset.sector = String(slot)
    btn.dataset.compass = compass
    btn.dataset.angle = String(angle)
    const rad = (angle * Math.PI) / 180
    const sx = Math.round(Math.sin(rad) * RADIAL_RADIUS_PX * 100) / 100
    const sy = Math.round(-Math.cos(rad) * RADIAL_RADIUS_PX * 100) / 100
    btn.style.setProperty("--sector-x", `${sx}px`)
    btn.style.setProperty("--sector-y", `${sy}px`)
    btn.addEventListener("pointerenter", () => {
      if (stateMachine.phase === "latched") {
        stateMachine.activeSlot = slot
        stateMachine.zone = "ring"
        sync()
      }
    })
    btn.addEventListener("click", event => {
      event.stopPropagation()
      const res = stateMachine.selectSlot(slot)
      sync()
      onResult(res)
    })
    root.append(btn)
    return btn
  })

  host.append(root)

  function sync() {
    if (stateMachine.phase === "closed") {
      root.hidden = true
      root.dataset.phase = "closed"
      return
    }
    root.hidden = false
    root.dataset.phase = stateMachine.phase
    root.dataset.context = stateMachine.ringContext
    root.style.left = `${stateMachine.visualX}px`
    root.style.top = `${stateMachine.visualY}px`

    const picked = stateMachine.commandContext.pickedObject
    const hit = stateMachine.commandContext.groundHit
    centerTitle.textContent = picked
      ? picked.label
      : hit
        ? `Ground (${hit.x.toFixed(1)}, ${hit.z.toFixed(1)})`
        : "Ground"

    const activeSector = stateMachine.activeSlot !== null ? stateMachine.sectors[stateMachine.activeSlot] : null
    if (stateMachine.zone === "cancel") {
      centerSub.textContent = "Release to cancel"
    } else if (activeSector && !activeSector.enabled) {
      centerSub.textContent = activeSector.disabledReason ?? "Unavailable"
    } else if (activeSector) {
      centerSub.textContent = `${activeSector.command.label}`
    } else {
      centerSub.textContent = stateMachine.phase === "latched" ? "1–8 or Click · Esc cancel" : "Flick · Release in ring"
    }

    for (const sector of stateMachine.sectors) {
      const btn = sectorButtons[sector.slot]!
      const isActive = stateMachine.zone === "ring" && stateMachine.activeSlot === sector.slot
      btn.dataset.active = String(isActive)
      btn.setAttribute("aria-disabled", String(!sector.enabled))
      btn.title = sector.enabled
        ? `${sector.command.label}${sector.command.shortcut ? ` (${sector.command.shortcut})` : ""}`
        : `${sector.command.label} — ${sector.disabledReason}`
      btn.innerHTML = `<span class="lab-radial-slot">${sector.slot + 1}·${sector.compass}</span><span class="lab-radial-label">${sector.command.shortLabel}</span><kbd class="lab-radial-kbd">${sector.command.shortcut ?? ""}</kbd>`
    }
  }

  return {
    root,
    sectorButtons,
    sync,
  }
}
