/**
 * HUD motion tokens: Kit's spring palette (duration / bounce, docs/outbreak-hud.md "Design system") sampled into CSS
 * `linear()` easings with knobs' solver, so CSS transitions and Web Animations share one set of curves. Every HUD
 * surface animates through `HudMotion`; reduced motion drops travel and keeps a short fade.
 */
import { springCss, type SpringValue } from "@arcade/knobs"

export const SPRINGS = {
  /** Pointer-tied and value ticks. */
  instant: { duration: 0.1, bounce: 0 },
  /** Small controls and exits. */
  snappy: { duration: 0.25, bounce: 0 },
  /** Most state changes: a prompt's content, a selected slot. */
  default: { duration: 0.3, bounce: 0 },
  /** Layout moves and rolling numbers: siblings sliding into a gap. */
  calm: { duration: 0.4, bounce: 0 },
  /** Panels. */
  smooth: { duration: 0.45, bounce: 0 },
  /** Chip → panel, as in knobs' morph.ts. */
  morphOpen: { duration: 0.42, bounce: 0.16 },
  morphClose: { duration: 0.38, bounce: 0.08 },
  /** Dimming an idle HUD. */
  slow: { duration: 0.85, bounce: 0 },
} as const satisfies Record<string, SpringValue>

export type MotionName = keyof typeof SPRINGS

/** Exit softening (kit-motion principle 4): a few pixels of blur and a slight shrink, 10–25 % shorter than entry. */
export const EXIT = { blur: 3, scale: 0.96 }
/** The fade kept under reduced motion. */
export const REDUCED_FADE_MS = 180

type Curve = { easing: string; duration: number }

export class HudMotion {
  /** Multiplies every duration (Lab › HUD › Motion speed). */
  speed = 1
  /** Forces reduced motion on (Lab); the media query also turns it on. */
  forceReduced = false
  private readonly curves = new Map<string, Curve>()
  private readonly media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null

  get reduced(): boolean {
    return this.forceReduced || Boolean(this.media?.matches)
  }

  /** The easing and duration (ms) for a palette spring at the current speed. */
  curve(name: MotionName): Curve {
    let c = this.curves.get(name)
    if (!c) {
      c = springCss(SPRINGS[name])
      this.curves.set(name, c)
    }
    if (this.reduced) return { easing: "linear", duration: REDUCED_FADE_MS }
    return { easing: c.easing, duration: Math.round(c.duration / Math.max(0.1, this.speed)) }
  }

  /** Writes `--m-<name>` (easing) and `--m-<name>-ms` (duration) on `root` for CSS transitions. */
  install(root: HTMLElement): void {
    for (const name of Object.keys(SPRINGS) as MotionName[]) {
      const c = this.curve(name)
      root.style.setProperty(`--m-${name}`, c.easing)
      root.style.setProperty(`--m-${name}-ms`, `${c.duration}ms`)
    }
    root.dataset.reducedMotion = String(this.reduced)
  }

  /**
   * Plays keyframes on `el` with a palette spring. Under reduced motion transforms and filters are dropped, so only
   * opacity (and colour) animates. Returns null when nothing is left to animate.
   */
  animate(el: Element, frames: Keyframe[], name: MotionName, options: { delay?: number; fill?: FillMode; composite?: CompositeOperation; pseudoElement?: string } = {}): Animation | null {
    if (typeof el.animate !== "function") return null
    const c = this.curve(name)
    const keyframes = this.reduced ? frames.map(({ transform: _t, filter: _f, translate: _tr, scale: _s, ...rest }) => rest) : frames
    if (!keyframes.some((k) => Object.keys(k).some((p) => p !== "offset" && p !== "easing" && p !== "composite"))) return null
    return el.animate(keyframes, { duration: c.duration, easing: c.easing, delay: options.delay ?? 0, fill: options.fill ?? "none", composite: options.composite, pseudoElement: options.pseudoElement })
  }

  /** Entry: from slightly small, blurred and transparent to rest. */
  enter(el: Element, name: MotionName = "default", from: { x?: number; y?: number } = {}): Animation | null {
    const t = `translate(${from.x ?? 0}px, ${from.y ?? 0}px) scale(${EXIT.scale})`
    return this.animate(el, [{ opacity: 0, transform: t, filter: `blur(${EXIT.blur}px)` }, { opacity: 1, transform: "none", filter: "blur(0px)" }], name)
  }

  /** Exit: the reverse of `enter`, shorter. Resolves once finished so the caller can remove the element. */
  exit(el: Element, name: MotionName = "snappy", to: { x?: number; y?: number } = {}): Promise<void> {
    const t = `translate(${to.x ?? 0}px, ${to.y ?? 0}px) scale(${EXIT.scale})`
    const a = this.animate(el, [{ opacity: 1, transform: "none", filter: "blur(0px)" }, { opacity: 0, transform: t, filter: `blur(${EXIT.blur}px)` }], name, { fill: "forwards" })
    return a ? a.finished.then(() => undefined, () => undefined) : Promise.resolve()
  }
}

/** The one motion instance every HUD surface shares. */
export const hudMotion = new HudMotion()

/**
 * FLIP for keyed children: call `measure()` before a DOM change and `play()` after; each element that moved slides
 * from where it was drawn (including any motion still in flight) to its new place.
 */
export function flip(els: Iterable<HTMLElement>, motion: HudMotion = hudMotion, name: MotionName = "calm") {
  const before = new Map<HTMLElement, DOMRect>()
  for (const el of els) before.set(el, el.getBoundingClientRect())
  return {
    play(after: Iterable<HTMLElement> = before.keys()) {
      if (motion.reduced) return
      for (const el of after) {
        const was = before.get(el)
        if (!was || !el.isConnected) continue
        const now = el.getBoundingClientRect()
        const dx = was.left - now.left
        const dy = was.top - now.top
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
        for (const a of el.getAnimations()) if ((a as Animation & { id: string }).id === "flip") a.cancel()
        const anim = motion.animate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], name, { composite: "add" })
        if (anim) anim.id = "flip"
      }
    },
  }
}

/** Snaps `el`'s left/top edges to whole device pixels with a `translate` nudge, so text at rest stays crisp. */
export function snapToPixels(el: HTMLElement, ratio = typeof devicePixelRatio === "number" ? devicePixelRatio : 1): void {
  el.style.translate = ""
  const r = el.getBoundingClientRect()
  const dx = Math.round(r.left * ratio) / ratio - r.left
  const dy = Math.round(r.top * ratio) / ratio - r.top
  if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) el.style.translate = `${dx.toFixed(3)}px ${dy.toFixed(3)}px`
}

/**
 * A number drawn as digit reels that roll to a new value (`@kitlangton/rolling-number`'s idea, in plain DOM). Leading
 * reels show a blank instead of zero, so the width stays fixed for up to `digits` digits and nothing beside it moves.
 */
export class RollingNumber {
  readonly el: HTMLElement
  private reels: HTMLElement[] = []
  private value = Number.NaN

  constructor(
    private readonly digits = 2,
    className = "roll",
  ) {
    this.el = document.createElement("span")
    this.el.className = className
    this.el.setAttribute("role", "text")
    for (let i = 0; i < digits; i++) {
      const reel = document.createElement("span")
      reel.className = "roll-reel"
      reel.setAttribute("aria-hidden", "true")
      const strip = document.createElement("span")
      strip.className = "roll-strip"
      strip.innerHTML = `<span> </span>${Array.from({ length: 10 }, (_, d) => `<span>${d}</span>`).join("")}`
      reel.appendChild(strip)
      this.el.appendChild(reel)
      this.reels.push(strip)
    }
  }

  /** Sets the value; `animate` false (first paint, direct input) snaps instead of rolling. */
  set(n: number, animate = true): void {
    const v = Math.max(0, Math.min(10 ** this.digits - 1, Math.round(n)))
    if (v === this.value) return
    const first = Number.isNaN(this.value)
    this.value = v
    this.el.setAttribute("aria-label", String(v))
    const text = String(v).padStart(this.digits, " ")
    this.reels.forEach((strip, i) => {
      const ch = text[i]!
      const index = ch === " " ? 0 : Number(ch) + 1
      strip.style.transition = first || !animate ? "none" : ""
      strip.style.transform = `translateY(${-index}lh)`
      if (first || !animate) void strip.offsetWidth
    })
    this.el.dataset.value = String(v)
  }
}
