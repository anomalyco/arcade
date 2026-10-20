import type { SecretRun } from "../../shared/secrets/select"
import { glanceSvg, type GlanceKind } from "./drawings"
import "./secrets.css"

/**
 * A secret held up close for a moment (the calendar, a clock, a photo, his notebook page, his map, the phone): a
 * drawing beside the survivor, as a read page is, with no words. Goes by itself.
 */
export class SecretGlance {
  private readonly el: HTMLElement | null
  private left = 0
  private total = 0
  /** On show, for proofs: the kind, or null. */
  showing: GlanceKind | null = null

  constructor(doc: Document | null = typeof document === "undefined" ? null : document) {
    this.el = doc ? doc.createElement("div") : null
    if (this.el && doc) {
      this.el.className = "osx-glance"
      this.el.setAttribute("aria-hidden", "true")
      this.el.hidden = true
      doc.body.append(this.el)
    }
  }

  show(kind: GlanceKind, run: SecretRun, seconds: number, variant = 0, seed = 0): void {
    this.showing = kind
    this.left = this.total = Math.max(0.2, seconds)
    if (!this.el) return
    this.el.dataset.kind = kind
    this.el.innerHTML = glanceSvg(kind, run, variant, seed)
    this.el.hidden = false
  }

  hide(): void {
    this.left = 0
    this.showing = null
    if (this.el) this.el.hidden = true
  }

  update(dt: number): void {
    if (this.left <= 0) return
    this.left = Math.max(0, this.left - Math.max(0, dt))
    if (this.el) {
      const t = this.total - this.left
      this.el.style.opacity = Math.min(1, t / 0.18, this.left / 0.4).toFixed(3)
      this.el.style.transform = `translate(-50%, -50%) rotate(${this.showing === "page" || this.showing === "map" ? -2 : 1.5}deg) scale(${(0.94 + 0.06 * Math.min(1, t / 0.25)).toFixed(3)})`
    }
    if (this.left <= 0) this.hide()
  }
}

/** The padlock's three dials while you stand at it: the digits, the one you are turning underlined. */
export class DialReadout {
  private readonly el: HTMLElement | null
  private html = ""
  constructor(doc: Document | null = typeof document === "undefined" ? null : document) {
    this.el = doc ? doc.createElement("div") : null
    if (this.el && doc) {
      this.el.className = "osx-dials"
      this.el.setAttribute("aria-hidden", "true")
      doc.body.append(this.el)
    }
  }

  update(at: { x: number; y: number } | null, dials: readonly number[], active: number): void {
    if (!this.el) return
    this.el.dataset.on = String(Boolean(at))
    if (!at) return
    const html = dials.map((d, i) => `<span${i === active ? ' class="on"' : ""}>${d}</span>`).join("")
    if (html !== this.html) {
      this.html = html
      this.el.innerHTML = html
    }
    this.el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -100%)`
  }
}
