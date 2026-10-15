import { clamp, Spring } from "./motion.js"
import { springMotion } from "../core/spring.js"

// Dynamic Island: a floating panel grows out of its chip as one shape and collapses back into it.
// One spring drives the shape (0 at the chip, 1 at the panel); the chip's label, the content's
// top-to-bottom reveal and the chrome all follow from it, so a reversal mid-morph keeps its
// velocity and every part retraces its path. The GPU overlay samples the same frame.
const OPEN = springMotion({ duration: 0.42, bounce: 0.16 })
const CLOSE = springMotion({ duration: 0.38, bounce: 0.08 })
/** The chip's label is gone by this far into the morph. */
const LABEL_END = 0.32
/** The content's reveal starts this far in, after the shape leads. */
const CONTENT_START = 0.12
/** Height (px, at most half the panel) over which content fades in, top first. */
const FADE_BAND = 140

export interface MorphFrame {
  /** The shape, in viewport px. */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly radius: number
  /** 0 at the chip, 1 at the panel; overshoots a little on the bounce. */
  readonly progress: number
  /** Content is fully shown above `fadeTop` and hidden below `fadeBottom` (viewport y). */
  readonly fadeTop: number
  readonly fadeBottom: number
}

export interface PanelMorph {
  /** The shape at `now` (a frame time), or undefined while the panel rests open. */
  frame(now: number): MorphFrame | undefined
  /** Grows out of the chip, or reverses a collapse from wherever it is. */
  open(): void
  /** Collapses into the chip, then calls `done`. */
  close(done: () => void): void
  readonly closing: boolean
  dispose(): void
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export function morphFromChip(
  chip: HTMLElement,
  root: HTMLElement,
  wake: () => void,
  restored: boolean,
): PanelMorph {
  const doc = root.ownerDocument
  const win = doc.defaultView!
  const spring = new Spring(restored ? 1 : 0, OPEN.omega, OPEN.zeta, 1e-6)
  let last = 0
  let raf = 0
  let done: (() => void) | undefined
  let shape: HTMLElement | undefined
  let current: MorphFrame | undefined
  let frameAt = -1
  // The chip keeps its spot while hidden (its transform aside), so read its layout box.
  const from = (): Box => ({
    x: parseFloat(chip.style.left) || 0,
    y: parseFloat(chip.style.top) || 0,
    w: chip.offsetWidth,
    h: chip.offsetHeight,
  })
  let to: Box = { x: 0, y: 0, w: 0, h: 0 }
  let panelRadius = 12
  let span = 1

  const active = () => !(spring.target === 1 && spring.x === 1 && spring.v === 0)

  const sample = (now: number): MorphFrame | undefined => {
    if (!active()) return undefined
    if (now === frameAt && current) return current
    if (last && now > last) spring.step((now - last) / 1000)
    last = Math.max(last, now)
    // Both ends are read live, so a scrolled chip or a dragged panel stays joined to the shape.
    const a = from()
    const r = root.getBoundingClientRect()
    to = { x: r.left, y: r.top, w: r.width, h: r.height }
    span = Math.max(1, Math.abs(to.w - a.w), Math.abs(to.h - a.h), Math.abs(to.x - a.x))
    // Settles once the remaining motion is under a third of a pixel.
    if (Math.abs(spring.x - spring.target) * span < 0.3 && Math.abs(spring.v) * span < 6)
      spring.snap(spring.target)
    const p = spring.x
    const k = clamp(p, 0, 1)
    const w = Math.max(0, lerp(a.w, to.w, p))
    const h = Math.max(0, lerp(a.h, to.h, p))
    const radius = Math.min(lerp(a.h / 2, panelRadius, k), w / 2, h / 2)
    const c = clamp((p - CONTENT_START) / (1 - CONTENT_START), 0, 1)
    const band = Math.min(FADE_BAND, to.h / 2)
    const fadeBottom = to.y + c * (to.h + band)
    frameAt = now
    current = {
      x: lerp(a.x, to.x, p),
      y: lerp(a.y, to.y, p),
      w,
      h,
      radius,
      progress: p,
      fadeTop: fadeBottom - band,
      fadeBottom,
    }
    return current
  }

  /** The chrome (fill, border, shadow, glass) moves to a shape beside the panel while it morphs. */
  const ensureShape = () => {
    if (shape) return shape
    const cs = getComputedStyle(root)
    panelRadius = parseFloat(cs.getPropertyValue("--kv-panel-radius")) || panelRadius
    shape = doc.createElement("div")
    shape.className = "knobs-morph"
    shape.setAttribute("aria-hidden", "true")
    for (const t of ["bg", "line", "rim", "glass", "glass-tone"])
      shape.style.setProperty(`--kv-${t}`, cs.getPropertyValue(`--kv-${t}`))
    shape.style.setProperty("--k-shadow", cs.getPropertyValue("--k-shadow"))
    root.before(shape)
    // The morph is the entrance: the CSS one mustn't start once the chrome comes back.
    root.style.animation = "none"
    root.dataset.morphing = ""
    chip.dataset.morph = ""
    return shape
  }

  const clear = () => {
    shape?.remove()
    shape = undefined
    delete root.dataset.morphing
    root.style.removeProperty("clip-path")
    root.style.removeProperty("mask-image")
    root.style.removeProperty("-webkit-mask-image")
    if ("morph" in chip.dataset) {
      // The chip takes its chrome back at once: the shape has it in exactly that spot.
      chip.style.transition = "none"
      delete chip.dataset.morph
      chip.style.removeProperty("opacity")
      chip.getBoundingClientRect()
      chip.style.removeProperty("transition")
      // It stays above the overlay canvas until the canvas has drawn a frame without the shape.
      win.requestAnimationFrame(() =>
        win.requestAnimationFrame(() => {
          if (!("morph" in chip.dataset)) chip.style.removeProperty("z-index")
        }),
      )
    }
  }

  const apply = (f: MorphFrame) => {
    const el = ensureShape()
    // With the overlay drawing the card and the content, the DOM keeps only the clip, which
    // still decides what the pointer can reach.
    const gpu = root.dataset.gpuActive === "true"
    const z = Number(root.style.zIndex) || 2147480001
    const set = (node: HTMLElement, name: string, value: string) => {
      if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value)
    }
    set(el, "display", gpu ? "none" : "block")
    set(el, "z-index", String(z))
    if (!gpu) {
      el.style.transform = `translate(${f.x}px,${f.y}px)`
      el.style.width = `${f.w}px`
      el.style.height = `${f.h}px`
      el.style.borderRadius = `${f.radius}px`
      el.style.setProperty("--p", clamp(f.progress, 0, 1).toFixed(4))
    }
    const r = to
    const inset = [f.y - r.y, r.x + r.w - f.x - f.w, r.y + r.h - f.y - f.h, f.x - r.x]
    root.style.clipPath = `inset(${inset.map((v) => `${v.toFixed(2)}px`).join(" ")} round ${f.radius.toFixed(2)}px)`
    const mask = gpu
      ? ""
      : `linear-gradient(to bottom,#000 ${(f.fadeTop - r.y).toFixed(2)}px,transparent ${(f.fadeBottom - r.y).toFixed(2)}px)`
    set(root, "mask-image", mask)
    set(root, "-webkit-mask-image", mask)
    set(chip, "opacity", (1 - clamp(f.progress / LABEL_END, 0, 1)).toFixed(3))
    // The label sits on the shape, above the overlay canvas too.
    set(chip, "z-index", String(Math.max(z + 1, 2147480003)))
  }

  const tick = (now: number) => {
    raf = 0
    const f = sample(now)
    if (f && !(spring.target === 0 && spring.x === 0 && spring.v === 0)) {
      apply(f)
      raf = win.requestAnimationFrame(tick)
    } else {
      clear()
      current = undefined
      if (spring.target === 0) {
        const finish = done
        done = undefined
        finish?.()
      }
    }
    wake()
  }

  const run = (target: 0 | 1) => {
    const m = target === 1 ? OPEN : CLOSE
    spring.omega = m.omega
    spring.zeta = m.zeta
    spring.set(target)
    if (!raf) {
      last = performance.now()
      const f = sample(last)
      if (f) apply(f)
      raf = win.requestAnimationFrame(tick)
    }
    wake()
  }

  return {
    frame: sample,
    open() {
      done = undefined
      run(1)
    },
    close(onDone) {
      done = onDone
      run(0)
    },
    get closing() {
      return spring.target === 0
    },
    dispose() {
      if (raf) win.cancelAnimationFrame(raf)
      raf = 0
      done = undefined
      clear()
    },
  }
}
