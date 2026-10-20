import { actionGlyphHtml } from "@arcade/kit/client/action-glyphs"
import type { Camera } from "@arcade/kit/client/camera"
import { keyCapHtml } from "@arcade/kit/client/key-cap"
import type { SessionView } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import type { BeatHint } from "./beats"
import "./onboarding.css"

/** One hint's markup: its key caps (WASD as a cluster) and glyph. No words. */
export function hintHtml(hint: Pick<BeatHint, "keys" | "glyph">): string {
  const codes = hint.keys.map((k) => k.code)
  const cluster = codes.join() === "KeyW,KeyA,KeyS,KeyD"
  const caps = cluster
    ? `<span class="ob-wasd"><span>${keyCapHtml("KeyW")}</span><span>${keyCapHtml("KeyA")}${keyCapHtml("KeyS")}${keyCapHtml("KeyD")}</span></span>`
    : hint.keys.map((k) => keyCapHtml(k.code, k.hold ? { hold: true } : undefined)).join("")
  const glyph = hint.glyph ? actionGlyphHtml(hint.glyph, { size: 22 }) : ""
  return `${caps}${glyph}`
}

/**
 * The training room's one hint at a time: key caps and a glyph over the thing to use (or over the survivor for a
 * skill), breathing gently so the eye finds it, with a small tick pointing down at the spot.
 */
export class HintView {
  readonly root: HTMLElement
  private html = ""
  private shown = false
  private beat = ""

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement("div")
    this.root.className = "ob-hint"
    this.root.setAttribute("aria-hidden", "true")
    this.root.hidden = true
    parent.appendChild(this.root)
  }

  update(view: SessionView, cam: Camera, w: number, h: number, hint: BeatHint | null): void {
    if (!hint) {
      if (this.shown) {
        this.shown = false
        this.root.dataset.leaving = "true"
        this.root.style.opacity = "0"
      }
      return
    }
    const p = view.player
    const at = hint.at === "self" ? { x: p.x, y: p.y, z: 2.15 } : hint.at
    const proj = cam.project(at.x, at.z + supportHeight(view.town, at.x, at.y), at.y, w, h)
    if (!proj.ok) {
      this.root.style.opacity = "0"
      return
    }
    const html = hintHtml(hint)
    if (html !== this.html || hint.beat !== this.beat) {
      this.html = html
      this.beat = hint.beat
      this.root.innerHTML = `<div class="ob-hint-chip">${html}</div>`
      this.root.dataset.beat = hint.beat
      this.root.animate?.([{ opacity: 0, transform: "translateY(6px) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" })
    }
    this.shown = true
    this.root.hidden = false
    delete this.root.dataset.leaving
    this.root.style.opacity = "1"
    const ratio = typeof devicePixelRatio === "number" ? devicePixelRatio : 1
    this.root.style.translate = `${Math.round(proj.x * ratio) / ratio}px ${Math.round(proj.y * ratio) / ratio}px`
  }

  get current(): string | null {
    return this.shown ? this.beat : null
  }
}

/** Hold Esc to leave the training room: a ringed Esc cap that fills, top right. */
export class SkipChip {
  readonly root: HTMLElement

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement("div")
    this.root.className = "ob-skip hud-panel"
    this.root.hidden = true
    this.root.innerHTML = `${keyCapHtml("Escape", { hold: true })}<span>Skip</span>`
    parent.appendChild(this.root)
  }

  update(visible: boolean, progress: number): void {
    this.root.hidden = !visible
    const cap = this.root.querySelector<HTMLElement>(".akc-hold")
    if (!cap) return
    cap.style.setProperty("--akc-p", progress.toFixed(3))
    if (progress > 0) cap.dataset.down = "true"
    else delete cap.dataset.down
  }
}

/** The cut from dawn to the run: black, the run's hour, then the street. */
export class Fade {
  readonly root: HTMLElement

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement("div")
    this.root.className = "ob-fade"
    this.root.hidden = true
    parent.appendChild(this.root)
  }

  /** Fades to black showing `clock`, calls `between`, then fades back in. */
  play(clock: string, between: () => void): void {
    const el = this.root
    el.hidden = false
    el.innerHTML = `<span>${clock}</span>`
    const out = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 650, easing: "ease-in", fill: "forwards" })
    void out.finished.then(() => {
      between()
      const back = el.animate([{ opacity: 1 }, { opacity: 1, offset: 0.45 }, { opacity: 0 }], { duration: 1400, easing: "ease-out", fill: "forwards" })
      void back.finished.then(() => {
        el.hidden = true
        out.cancel()
        back.cancel()
      })
    })
  }
}
