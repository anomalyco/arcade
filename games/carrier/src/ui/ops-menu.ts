import "./ops-menu.css"
import type { CrewError } from "../../shared/crew"
import type { OpView } from "../../shared/ops"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** An E press shorter than this pins the menu open (or closes it). */
const TAP_MS = 220

/**
 * E by physical position only: the "e" character sits on Dvorak's D key (right rudder/strafe), so matching the character
 * would steal a movement key (docs/game-notes.md). Free in flight (V cycles weapons, F flares, X free look, C camera).
 */
const isKey = (e: KeyboardEvent) => e.code === "KeyE"

const REASON: Partial<Record<CrewError, string>> = {
  flying: "AIRBORNE",
  "in-use": "IN USE",
  "helm-taken": "IN USE",
}

export type OpsInfo = { ship: string; color: string; name: (id: number) => string }

/**
 * SHIP OPERATIONS: the one place to take the helm, launch a vehicle or man a gun. Hold E to see it, tap E to keep it open, Esc
 * or another tap closes it; main.ts frees the mouse while it is open. Each operation (shared/ops.ts) is a row with its number key,
 * its slots (who has each, or a recharge ring) and its state: AVAILABLE, IN USE, RECHARGING with a countdown, or why
 * not. Click a row or press its number to run it; the menu closes. In the air it is read-only.
 */
export class OpsMenu {
  private el: HTMLElement
  private held = false
  private pinned = false
  private downAt = 0
  private key = ""
  private views: OpView[] | null = null
  private info: OpsInfo | null = null
  /** Off while the load screen shows. */
  enabled = true
  /** While flying, E is right rudder (src/flight/input.ts), so the menu leaves the key alone. */
  airborne = false
  /** Out in the boat: the menu opens, read-only (every operation says AT SEA). */
  atSea = false
  onToggle: ((open: boolean) => void) | null = null

  constructor(
    parent: HTMLElement,
    private run: (op: string) => void,
  ) {
    this.el = document.createElement("div")
    this.el.className = "om"
    this.el.hidden = true
    parent.append(this.el)
    // Capture phase, so the number keys that run an operation never also reach the helm's throttle presets.
    addEventListener(
      "keydown",
      (e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || !this.enabled || this.airborne || e.metaKey || e.ctrlKey) return
        if (isKey(e)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          if (e.repeat || this.held) return
          if (this.pinned) {
            this.pinned = false
            return this.refresh()
          }
          if (!this.views) return
          this.held = true
          this.downAt = performance.now()
          return this.refresh()
        }
        if (!this.open) return
        if (e.code === "Escape") {
          this.close()
          return
        }
        const n = /^Digit([1-9])$|^Numpad([1-9])$/.exec(e.code)
        const d = n ? Number(n[1] ?? n[2]) : /^[1-9]$/.test(e.key) ? Number(e.key) : 0
        if (!d) return
        e.preventDefault()
        e.stopImmediatePropagation()
        this.choose(d - 1)
      },
      true,
    )
    addEventListener(
      "keyup",
      (e) => {
        if (!isKey(e) || !this.held) return
        e.stopImmediatePropagation()
        this.held = false
        if (performance.now() - this.downAt < TAP_MS) this.pinned = true
        this.refresh()
      },
      true,
    )
    addEventListener("blur", () => {
      this.held = false
      this.refresh()
    })
    this.el.addEventListener("pointerdown", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-op]")
      if (!t || e.button !== 0) return
      e.preventDefault()
      this.choose(Number(t.dataset.op))
    })
  }

  get open(): boolean {
    return this.held || this.pinned
  }

  /** Pins it open, or closes it. */
  pin(open: boolean): void {
    this.pinned = open && !!this.views
    if (!open) this.held = false
    this.refresh()
  }

  close(): void {
    this.pin(false)
  }

  /** The operations on my ship (null: not aboard, the menu closes), names and colours for them, every frame. */
  update(views: OpView[] | null, info: OpsInfo | null): void {
    this.views = views
    this.info = info
    if (!views && this.open) this.close()
    if (this.open) this.render()
  }

  private choose(i: number): void {
    const v = this.views?.[i]
    if (!v || v.state !== "available") return
    this.run(v.op.id)
    this.close()
  }

  private refresh(): void {
    const open = this.open
    if (open === !this.el.hidden) {
      if (open) this.render()
      return
    }
    this.el.hidden = !open
    this.key = ""
    // Before the render: the owner suspends Pointer Lock while the menu is open.
    this.onToggle?.(open)
    if (open) this.render()
  }

  private render(): void {
    const views = this.views
    const info = this.info
    if (!views || !info) return
    const secs = (ms: number) => Math.ceil(ms / 1000)
    const key = JSON.stringify([info.ship, info.color, this.atSea, views.map((v) => [v.state, v.reason, secs(v.readyIn), v.slots.map((s) => [s.player === null ? "" : info.name(s.player), secs(s.readyIn)])])])
    if (key !== this.key) {
      this.key = key
      this.el.style.setProperty("--tc", info.color)
      this.el.innerHTML = `<div class="om-panel">
        <div class="om-head"><b>SHIP OPERATIONS</b><span>${esc(info.ship)}</span></div>
        ${views.map((v, i) => this.row(v, i, info)).join("")}
      </div>`
    }
    // The recharge rings sweep every frame; the text only changes each second.
    const rings = this.el.querySelectorAll<HTMLElement>(".om-slot.charging")
    let k = 0
    for (const v of views)
      for (const s of v.slots) {
        if (s.player !== null || s.readyIn <= 0) continue
        const el = rings[k++]
        if (el) el.style.setProperty("--p", (1 - s.readyIn / (v.op.recharge * 1000 || 1)).toFixed(3))
      }
  }

  private row(v: OpView, i: number, info: OpsInfo): string {
    const slots = v.slots
      .map((s) => {
        if (s.player !== null) return `<span class="om-slot used"><i></i>${esc(info.name(s.player))}</span>`
        if (s.readyIn > 0) return `<span class="om-slot charging"><i></i>${Math.ceil(s.readyIn / 1000)}S</span>`
        return `<span class="om-slot ready"><i></i>${v.op.kind === "vehicle" ? "READY" : "FREE"}</span>`
      })
      .join("")
    const state =
      v.state === "available"
        ? "AVAILABLE"
        : v.state === "active"
          ? v.op.kind !== "vehicle"
            ? "YOU HAVE IT"
            : "YOU'RE UP"
          : v.state === "recharging"
            ? `RECHARGING ${Math.ceil(v.readyIn / 1000)}S`
            : v.state === "in-use"
              ? "IN USE"
              : v.reason === "flying" && this.atSea
                ? "AT SEA"
                : (REASON[v.reason!] ?? "UNAVAILABLE")
    // The guns sit under a hairline, after the helm and the aircraft.
    const sep = v.op.kind === "gun" && this.views?.[i - 1]?.op.kind !== "gun" ? " sep" : ""
    return `<div class="om-op ${v.state}${sep}" ${v.state === "available" ? `data-op="${i}"` : ""}>
      <kbd>${i + 1}</kbd><span class="om-label">${esc(v.op.label)}</span><span class="om-slots">${slots}</span><span class="om-state">${state}</span>
    </div>`
  }
}
