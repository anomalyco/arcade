/**
 * The floating world prompt (`#prompt`): key caps and verbs over whatever the survivor faces, a container's strip,
 * or the finisher cue. It keeps one panel and changes what is in it. New content crossfades in while the panel
 * resizes around it (width leads), both faces stay put relative to the anchor while the panel's edges move, a new
 * target glides the panel from where it was, and leaving fades and softens instead of vanishing. Hold progress is
 * written in place, so holding E never rebuilds the markup. Everything runs on Web Animations, so the motion proof
 * can pause and step it.
 */
import { hudMotion, type HudMotion } from "./motion"

export type PromptFrame = {
  /** Identity of what the prompt points at; a new target glides the panel instead of jumping. */
  target: string
  /** Face markup, free of hold progress. */
  html: string
  /** Anchor in CSS pixels. */
  x: number
  y: number
  /** Above: the panel's bottom edge sits `gap` px over the anchor. Below: its top edge `gap` px under it. */
  place: "above" | "below"
  gap: number
  /** Overall opacity (the finisher cue fades after a couple of uses). */
  opacity?: number
  /** Hold progress 0..1 for any hold cap in the face. */
  hold?: number
}

type Size = { w: number; h: number }

export class PromptView {
  readonly anchor: HTMLElement
  private face: HTMLElement | null = null
  private html = ""
  private size: Size = { w: 0, h: 0 }
  private target = ""
  private place: "above" | "below" = "above"
  private gap = 0
  private at = { x: 0, y: 0 }
  private shown = false
  private exit: Animation | null = null
  private hold = -1

  constructor(
    readonly box: HTMLElement,
    private readonly motion: HudMotion = hudMotion,
    private readonly ratio: () => number = () => (typeof devicePixelRatio === "number" ? devicePixelRatio : 1),
  ) {
    this.anchor = document.createElement("div")
    this.anchor.className = "prompt-anchor"
    box.replaceWith(this.anchor)
    this.anchor.appendChild(box)
    box.replaceChildren()
    box.hidden = true
    box.classList.add("hud-panel")
  }

  /** Call every drawn frame; null hides the prompt (it fades out from where it was). */
  update(f: PromptFrame | null): void {
    if (!f) {
      this.hide()
      return
    }
    const dpr = this.ratio()
    const x = Math.round(f.x * dpr) / dpr
    const y = Math.round(f.y * dpr) / dpr
    const appearing = !this.shown
    if (!appearing && f.target !== this.target) this.glide(this.at.x - x, this.at.y - y)
    this.target = f.target
    this.at = { x, y }
    this.anchor.style.transform = `translate(${x}px, ${y}px)`
    const opacity = String(f.opacity ?? 1)
    if (this.anchor.style.opacity !== opacity) this.anchor.style.opacity = opacity
    if (f.place !== this.place || f.gap !== this.gap) this.setPlace(f.place, f.gap)
    // Unhide before measuring new content: a hidden panel measures 0 × 0.
    if (appearing) this.box.hidden = false
    if (f.html !== this.html) this.swap(f.html, !appearing)
    if (appearing) this.show()
    this.setHold(f.hold ?? 0)
  }

  private setPlace(place: "above" | "below", gap: number): void {
    this.place = place
    this.gap = gap
    const s = this.box.style
    if (place === "above") {
      s.top = ""
      s.bottom = `${gap}px`
    } else {
      s.bottom = ""
      s.top = `${gap}px`
    }
    this.box.dataset.place = place
  }

  private show(): void {
    this.shown = true
    const box = this.box
    box.hidden = false
    let from = 0
    if (this.exit) {
      from = Number(getComputedStyle(box).opacity)
      this.exit.cancel()
      this.exit = null
    }
    const origin = this.place === "above" ? "50% 100%" : "50% 0%"
    box.style.transformOrigin = origin
    this.motion.animate(
      box,
      [
        { opacity: from, transform: `scale(${from > 0 ? 0.98 : 0.96})`, filter: `blur(${from > 0 ? 1 : 3}px)` },
        { opacity: 1, transform: "none", filter: "blur(0px)" },
      ],
      "default",
    )
  }

  private hide(): void {
    if (!this.shown) return
    this.shown = false
    const box = this.box
    const a = this.motion.animate(
      box,
      [
        { opacity: Number(getComputedStyle(box).opacity), transform: "none", filter: "blur(0px)" },
        { opacity: 0, transform: "scale(0.96)", filter: "blur(3px)" },
      ],
      "snappy",
      { fill: "forwards" },
    )
    this.exit = a
    const done = () => {
      if (this.exit !== a) return
      this.exit = null
      box.hidden = true
      a?.cancel()
    }
    if (a) void a.finished.then(done, () => undefined)
    else done()
  }

  /** Moves the panel from `dx, dy` (where it was drawn, relative to the new anchor) back to rest. */
  private glide(dx: number, dy: number): void {
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    const box = this.box
    const now = getComputedStyle(box).translate
    let cx = 0
    let cy = 0
    if (now && now !== "none") {
      const [a, b] = now.split(" ").map((v) => parseFloat(v) || 0)
      cx = a ?? 0
      cy = b ?? 0
    }
    for (const a of box.getAnimations()) if (a.id === "glide") a.cancel()
    const anim = this.motion.animate(box, [{ translate: `${dx + cx}px ${dy + cy}px` }, { translate: "0px 0px" }], "calm")
    if (anim) anim.id = "glide"
  }

  /** Crossfades to new content while the panel resizes; both faces hold still relative to the anchor. */
  private swap(html: string, animate: boolean): void {
    this.html = html
    const box = this.box
    const old = this.face
    const face = document.createElement("div")
    face.className = "prompt-face"
    face.innerHTML = html
    box.appendChild(face)
    this.face = face
    this.hold = -1
    box.dataset.strip = String(face.firstElementChild?.classList.contains("strip") ?? false)
    const size = { w: face.offsetWidth, h: face.offsetHeight }
    const from = this.size
    this.size = size
    const left = (w: number) => -Math.round(w / 2)
    const cur = animate && old ? this.current() : null
    for (const a of box.getAnimations()) if (a.id === "size") a.cancel()
    box.style.width = `${size.w}px`
    box.style.height = `${size.h}px`
    box.style.left = `${left(size.w)}px`
    face.style.left = "0px"
    if (!animate || !old || !cur) {
      old?.remove()
      return
    }
    const px = (v: number) => `${v}px`
    // Width leads (default spring); height follows on the calm one. Faces counter the panel's left edge.
    const w = this.motion.animate(box, [{ width: px(cur.w), left: px(cur.left) }, { width: px(size.w), left: px(left(size.w)) }], "default")
    const h = this.motion.animate(box, [{ height: px(cur.h) }, { height: px(size.h) }], "calm")
    if (w) w.id = "size"
    if (h) h.id = "size"
    const oldLeft = left(from.w)
    this.motion.animate(face, [{ left: px(left(size.w) - cur.left) }, { left: "0px" }], "default")
    old.classList.add("leaving")
    old.style.left = px(oldLeft - left(size.w))
    this.motion.animate(old, [{ left: px(oldLeft - cur.left) }, { left: px(oldLeft - left(size.w)) }], "default")
    this.motion.animate(face, [{ opacity: 0, filter: "blur(3px)" }, { opacity: 0, filter: "blur(3px)", offset: 0.15 }, { opacity: 1, filter: "blur(0px)" }], "default")
    void this.motion.exit(old, "snappy").then(() => old.remove())
  }

  /** The panel's drawn width, height and left edge, including any resize in flight. */
  private current(): { w: number; h: number; left: number } {
    const cs = getComputedStyle(this.box)
    return { w: parseFloat(cs.width), h: parseFloat(cs.height), left: parseFloat(cs.left) }
  }

  private setHold(p: number): void {
    const v = Math.round(p * 1000) / 1000
    if (v === this.hold || !this.face) return
    this.hold = v
    for (const cap of this.face.querySelectorAll<HTMLElement>(".akc-hold")) {
      cap.style.setProperty("--akc-p", String(v))
      if (v > 0) cap.dataset.down = "true"
      else delete cap.dataset.down
    }
    for (const dual of this.face.querySelectorAll<HTMLElement>(".akp-dual")) dual.dataset.holding = String(v > 0)
  }
}
