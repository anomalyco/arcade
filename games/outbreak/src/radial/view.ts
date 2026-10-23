import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { hudMotion } from "../hud/motion"
import { promptGlyph, promptGlyphHtml } from "../hud/prompt-glyphs"
import { wedgeOffset, type RadialInteract } from "./state"
import "./radial.css"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The radial on screen: a held E cap in the middle and a chip per action around it, each with its number. */
export class RadialView {
  private readonly root: HTMLDivElement
  private built = ""
  private hover = -2
  /** Proof readout of what is on screen (null while closed). */
  shown: { labels: string[]; hover: number; x: number; y: number } | null = null

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement("div")
    this.root.className = "radial"
    this.root.hidden = true
    this.root.setAttribute("role", "menu")
    this.root.setAttribute("aria-label", "Actions")
    parent.append(this.root)
  }

  draw(radial: RadialInteract, radius: number): void {
    if (!radial.isOpen) {
      this.shown = null
      if (!this.root.hidden) {
        this.root.hidden = true
        this.built = ""
      }
      return
    }
    const opts = radial.options
    const key = `${radius}|${opts.map((o) => `${o.kind}:${o.action.id}:${o.action.label}`).join("|")}`
    if (key !== this.built) {
      this.built = key
      this.hover = -2
      const petals = opts
        .map((o, i) => {
          const { glyph, label } = promptGlyph(o.kind, o.action)
          const at = wedgeOffset(i, opts.length)
          // Chips to the side hang their inner edge off the ring, so a long verb never covers the hub.
          const ax = at.x > 0.3 ? 0 : at.x < -0.3 ? -100 : -50
          const r = ax === -50 ? radius : radius - 24
          return (
            `<div class="radial-petal" role="menuitem" data-i="${i}" style="--x:${(at.x * r).toFixed(1)}px;--y:${(at.y * r).toFixed(1)}px;--ax:${ax}%">` +
            `${glyph ? promptGlyphHtml(glyph, label, 24) : ""}<span class="radial-word">${esc(label)}</span>${keyCapHtml(`Digit${i + 1}`)}</div>`
          )
        })
        .join("")
      this.root.innerHTML = `<div class="radial-hub">${keyCapHtml("KeyE", { hold: true, progress: 1 })}</div>${petals}`
      this.root.dataset.reduced = String(hudMotion.reduced)
      this.root.hidden = false
    }
    this.root.style.transform = `translate(${radial.centre.x}px, ${radial.centre.y}px)`
    if (radial.hover !== this.hover) {
      this.hover = radial.hover
      for (const el of this.root.querySelectorAll<HTMLElement>(".radial-petal")) el.dataset.hover = String(Number(el.dataset.i) === radial.hover)
    }
    this.shown = { labels: opts.map((o) => o.action.label), hover: radial.hover, x: radial.centre.x, y: radial.centre.y }
  }
}
