import { clamp, Spring } from "./motion.js"
import { springMotion } from "../core/spring.js"

// Liquid glass: a floating panel grows out of its chip as one shape and collapses back into it.
//
// Press: the chip gives under the finger (scale 0.94 over 50 ms) before it lets go; its icon
// then dissolves into the glass (scale 0.8, blur 4 px, fading) and condenses back on return.
// Travel: each of the shape's four edges rides its own spring, 0 at the chip and 1 at the panel.
// The edges facing the way the shape travels lead on a stiff spring, as stiff as their axis carries
// the travel, and the rest trail on a softer one, so the glass stretches toward where it's going
// and the trailing sides catch up, settling with a small overshoot.
// Content: a separate spring brings it in a beat behind the glass (blur 8 px → 0, opacity, scale
// 0.97 → 1, revealed top first) and takes it out first on the way back, before the glass goes.
//
// Every spring keeps its velocity when the panel is toggled mid-flight. The GPU overlay samples
// the same frame through its mask.
const OPEN = {
  lead: springMotion({ duration: 0.16, bounce: 0.2 }),
  trail: springMotion({ duration: 0.2, bounce: 0.1 }),
}
const CLOSE = {
  lead: springMotion({ duration: 0.1, bounce: 0.08 }),
  trail: springMotion({ duration: 0.13, bounce: 0.1 }),
}
const CONTENT_IN = springMotion({ duration: 0.14, bounce: 0 })
const CONTENT_OUT = springMotion({ duration: 0.07, bounce: 0 })
/** The squeeze lets go on this as the glass heads home. */
const RELAX = springMotion({ duration: 0.12, bounce: 0 })
/**
 * How long the press takes to squeeze the chip, and how far (the chip's CSS matches). It eases in
 * and out, so the glass sets off from rest without a kink.
 */
export const ANTICIPATION_MS = 50
export const SQUEEZE = 0.94
/** Content starts coming in this long after the glass sets off. */
const CONTENT_DELAY = 20
/** Closing, the glass waits this long (at full content) while the content leaves. */
const GLASS_DELAY = 35
const BLUR = 8
const CONTENT_SCALE = 0.97
/** The chip's icon dissolves into the glass (shrinking, blurring, fading) over this much of it. */
const ICON_END = 0.6
const ICON_SCALE = 0.8
const ICON_BLUR = 4
/** Height (px, at most half the panel) of the band content fades in over, top first. */
const FADE_BAND = 120
/** Peak alpha of the specular ring the glass wears while it deforms. */
const SPECULAR = 0.1

export interface MorphFrame {
  /** The shape, in viewport px. */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly radius: number
  /** 0 at the chip, 1 at the panel (by size); overshoots a little on the bounce. */
  readonly progress: number
  /** Content is fully shown above `fadeTop` and hidden below `fadeBottom` (viewport y). */
  readonly fadeTop: number
  readonly fadeBottom: number
  /** The content's blur (px), opacity and scale about (originX, originY), in viewport px. */
  readonly blur: number
  readonly opacity: number
  readonly scale: number
  readonly originX: number
  readonly originY: number
  /** Alpha of the glass's specular ring. */
  readonly specular: number
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

type Pending = { at: number; target: 0 | 1 }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export function morphFromChip(
  chip: HTMLElement,
  root: HTMLElement,
  wake: () => void,
  restored: boolean,
): PanelMorph {
  const doc = root.ownerDocument
  const win = doc.defaultView!
  const start = restored ? 1 : 0
  /** Left, top, right and bottom, each 0 at the chip and 1 at the panel. */
  const edges = [0, 1, 2, 3].map(() => new Spring(start, OPEN.lead.omega, OPEN.lead.zeta, 1e-6))
  const content = new Spring(start, CONTENT_IN.omega, CONTENT_IN.zeta, 1e-6)
  const squeeze = new Spring(1, RELAX.omega, RELAX.zeta, 1e-6)
  /** Where the edges are headed, once `glassAt` (if any) has passed. */
  let glassTarget: 0 | 1 = start
  let glassAt: Pending | undefined
  let contentAt: Pending | undefined
  /** The press being anticipated: the chip squeezes from `pressAt` until the glass lets go. */
  let pressAt: number | undefined
  let last = 0
  let raf = 0
  let done: (() => void) | undefined
  let shape: HTMLElement | undefined
  let current: MorphFrame | undefined
  let frameAt = -1
  let panelRadius = 12
  /** The scale (and its origin, local px) applied to the DOM panel, so its own box can be read. */
  let applied = { scale: 1, ox: 0, oy: 0 }
  // The chip keeps its spot while hidden (its transform aside), so read its layout box.
  const from = (): Box => ({
    x: parseFloat(chip.style.left) || 0,
    y: parseFloat(chip.style.top) || 0,
    w: chip.offsetWidth,
    h: chip.offsetHeight,
  })
  /** The panel's box without the content scale this morph put on it. */
  const panelBox = (): Box => {
    const r = root.getBoundingClientRect()
    const { scale: s, ox, oy } = applied
    if (s === 1) return { x: r.left, y: r.top, w: r.width, h: r.height }
    return { x: r.left - ox * (1 - s), y: r.top - oy * (1 - s), w: r.width / s, h: r.height / s }
  }

  /** The leading edges get the stiff spring, the trailing ones the soft one, per axis of travel. */
  const assignRoles = (target: 0 | 1) => {
    const a = from()
    const b = panelBox()
    const sign = target === 1 ? 1 : -1
    const dx = (b.x + b.w / 2 - (a.x + a.w / 2)) * sign
    const dy = (b.y + b.h / 2 - (a.y + a.h / 2)) * sign
    const len = Math.hypot(dx, dy) || 1
    const { lead, trail } = target === 1 ? OPEN : CLOSE
    // A leading edge is as stiff as its axis carries the travel; trailing edges stay soft.
    const tune = (spring: Spring, leads: boolean, weight: number) => {
      const w = leads ? weight : 0
      spring.omega = lerp(trail.omega, lead.omega, w)
      spring.zeta = lerp(trail.zeta, lead.zeta, w)
    }
    const wx = Math.abs(dx) / len
    const wy = Math.abs(dy) / len
    tune(edges[0]!, dx < 0, wx)
    tune(edges[2]!, dx >= 0, wx)
    tune(edges[1]!, dy < 0, wy)
    tune(edges[3]!, dy >= 0, wy)
  }

  const retargetGlass = (target: 0 | 1) => {
    glassAt = undefined
    glassTarget = target
    assignRoles(target)
    for (const e of edges) e.set(target)
    if (target === 0) {
      squeeze.omega = RELAX.omega
      squeeze.zeta = RELAX.zeta
      squeeze.set(1)
    }
  }
  const retargetContent = (target: 0 | 1) => {
    contentAt = undefined
    const m = target === 1 ? CONTENT_IN : CONTENT_OUT
    content.omega = m.omega
    content.zeta = m.zeta
    content.set(target)
  }

  /** Steps every spring to `now`, applying scheduled retargets at their own times. */
  const advance = (now: number) => {
    const stepTo = (t: number) => {
      if (t <= last) return
      const dt = (t - last) / 1000
      for (const e of edges) e.step(dt)
      content.step(dt)
      squeeze.step(dt)
      last = t
    }
    for (;;) {
      const next = [glassAt, contentAt]
        .filter((p): p is Pending => p !== undefined && p.at <= now)
        .sort((x, y) => x.at - y.at)[0]
      if (!next) break
      stepTo(next.at)
      if (next === glassAt) retargetGlass(next.target)
      else retargetContent(next.target)
    }
    stepTo(now)
    // The press: the chip squeezes, easing in, until the glass lets go.
    if (pressAt !== undefined) {
      const u = clamp((now - pressAt) / ANTICIPATION_MS, 0, 1)
      squeeze.snap(1 - (1 - SQUEEZE) * u * u * (3 - 2 * u))
      if (!glassAt) pressAt = undefined
    }
  }

  const restingOpen = () =>
    !glassAt &&
    !contentAt &&
    glassTarget === 1 &&
    content.x === 1 &&
    content.v === 0 &&
    edges.every((e) => e.x === 1 && e.v === 0)
  const restingClosed = () =>
    !glassAt &&
    glassTarget === 0 &&
    squeeze.x === 1 &&
    squeeze.v === 0 &&
    edges.every((e) => e.x === 0 && e.v === 0)

  const sample = (now: number): MorphFrame | undefined => {
    if (restingOpen()) return undefined
    if (now === frameAt && current) return current
    if (now > last) advance(now)
    // Both ends are read live, so a scrolled chip or a dragged panel stays joined to the shape.
    const a = from()
    const b = panelBox()
    const s = squeeze.x
    const cx = a.x + a.w / 2
    const cy = a.y + a.h / 2
    const chipEdges = [
      cx - (a.w * s) / 2,
      cy - (a.h * s) / 2,
      cx + (a.w * s) / 2,
      cy + (a.h * s) / 2,
    ]
    const panelEdges = [b.x, b.y, b.x + b.w, b.y + b.h]
    // Each edge settles once it's within a third of a pixel and barely moving.
    for (const [i, e] of edges.entries()) {
      const span = Math.max(1, Math.abs(panelEdges[i]! - chipEdges[i]!))
      if (Math.abs(e.x - e.target) * span < 0.3 && Math.abs(e.v) * span < 6) e.snap(e.target)
    }
    if (Math.abs(content.x - content.target) < 0.004 && Math.abs(content.v) < 0.05)
      content.snap(content.target)
    if (Math.abs(squeeze.x - squeeze.target) < 0.0005 && Math.abs(squeeze.v) < 0.01)
      squeeze.snap(squeeze.target)
    const [l, t, r, btm] = edges.map((e, i) => lerp(chipEdges[i]!, panelEdges[i]!, e.x)) as [
      number,
      number,
      number,
      number,
    ]
    const w = Math.max(0, r - l)
    const h = Math.max(0, btm - t)
    const grow = (size: number, chipSize: number, panelSize: number) =>
      Math.abs(panelSize - chipSize) < 1 ? 1 : (size - chipSize) / (panelSize - chipSize)
    const p = (grow(w, a.w, b.w) + grow(h, a.h, b.h)) / 2
    const k = clamp(p, 0, 1)
    const radius = Math.max(0, Math.min(lerp((a.h * s) / 2, panelRadius, k), w / 2, h / 2))
    const c = clamp(content.x, 0, 1)
    const band = Math.min(FADE_BAND, b.h / 2)
    const fadeBottom = b.y + clamp(c * 1.5, 0, 1) * (b.h + band)
    frameAt = now
    current = {
      x: l,
      y: t,
      w,
      h,
      radius,
      progress: p,
      fadeTop: fadeBottom - band,
      fadeBottom,
      blur: BLUR * (1 - c) ** 1.5,
      opacity: c,
      scale: CONTENT_SCALE + (1 - CONTENT_SCALE) * c,
      // Content grows from the panel's point nearest the chip.
      originX: clamp(cx, b.x, b.x + b.w),
      originY: clamp(cy, b.y, b.y + b.h),
      specular: SPECULAR * 4 * k * (1 - k),
    }
    return current
  }

  /** The chrome (fill, border, shadow, glass) moves to a shape beside the panel while it morphs. */
  const ensureShape = () => {
    if (shape) return shape
    const cs = getComputedStyle(root)
    // A square panel (radius 0, as labPreset's) stays square: 0 is a radius, not a missing one.
    const r = parseFloat(cs.getPropertyValue("--kv-panel-radius"))
    if (Number.isFinite(r)) panelRadius = r
    shape = doc.createElement("div")
    shape.className = "knobs-morph"
    shape.setAttribute("aria-hidden", "true")
    for (const t of ["bg", "line", "rim", "edge", "glass", "glass-tone"])
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
    for (const name of [
      "clip-path",
      "mask-image",
      "-webkit-mask-image",
      "filter",
      "opacity",
      "scale",
      "transform-origin",
    ])
      root.style.removeProperty(name)
    applied = { scale: 1, ox: 0, oy: 0 }
    if ("morph" in chip.dataset) {
      // The chip takes its chrome back at once: the shape has it in exactly that spot.
      chip.style.transition = "none"
      delete chip.dataset.morph
      chip.style.removeProperty("opacity")
      chip.style.removeProperty("scale")
      chip.style.removeProperty("filter")
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
    // still decides what the pointer can reach; the overlay blurs and scales the content itself.
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
      el.style.setProperty("--spec", f.specular.toFixed(4))
    }
    // The panel's own box, and the content scale about the origin, in its local px.
    const b = panelBox()
    const s = gpu ? 1 : f.scale
    const ox = f.originX - b.x
    const oy = f.originY - b.y
    // A viewport point in the panel's local px, undoing the content scale.
    const lx = (x: number) => ox + (x - f.originX) / s
    const ly = (y: number) => oy + (y - f.originY) / s
    const px = (v: number) => `${v.toFixed(2)}px`
    const inset = [ly(f.y), b.w - lx(f.x + f.w), b.h - ly(f.y + f.h), lx(f.x)]
    root.style.clipPath = `inset(${inset.map(px).join(" ")} round ${px(f.radius / s)})`
    const mask = gpu
      ? ""
      : `linear-gradient(to bottom,#000 ${px(ly(f.fadeTop))},transparent ${px(ly(f.fadeBottom))})`
    set(root, "mask-image", mask)
    set(root, "-webkit-mask-image", mask)
    set(root, "filter", !gpu && f.blur > 0.01 ? `blur(${f.blur.toFixed(2)}px)` : "")
    set(root, "opacity", !gpu && f.opacity < 1 ? f.opacity.toFixed(3) : "")
    set(root, "scale", s < 1 ? s.toFixed(4) : "")
    set(root, "transform-origin", s < 1 ? `${px(ox)} ${px(oy)}` : "")
    applied = s < 1 ? { scale: s, ox, oy } : { scale: 1, ox: 0, oy: 0 }
    // The icon dissolves into the glass as it leaves, and condenses back out of it on return,
    // arriving whole just as the glass settles.
    const q = clamp(f.progress / ICON_END, 0, 1)
    const iconScale = squeeze.x * (1 - (1 - ICON_SCALE) * q)
    set(chip, "opacity", (1 - q * q * (3 - 2 * q)).toFixed(3))
    set(chip, "filter", q > 0.001 ? `blur(${(ICON_BLUR * q).toFixed(2)}px)` : "")
    set(chip, "scale", iconScale < 1 ? iconScale.toFixed(4) : "")
    // The icon sits on the shape, above the overlay canvas too.
    set(chip, "z-index", String(Math.max(z + 1, 2147480003)))
  }

  const tick = (now: number) => {
    raf = 0
    const f = sample(now)
    if (f && !restingClosed()) {
      apply(f)
      raf = win.requestAnimationFrame(tick)
    } else {
      clear()
      current = undefined
      if (glassTarget === 0) {
        const finish = done
        done = undefined
        finish?.()
      }
    }
    wake()
  }

  const kick = () => {
    if (!raf) {
      const f = sample(last)
      if (f) apply(f)
      raf = win.requestAnimationFrame(tick)
    }
    wake()
  }

  const meanEdge = () => edges.reduce((sum, e) => sum + e.x, 0) / edges.length

  return {
    frame: sample,
    open() {
      done = undefined
      const now = performance.now()
      if (!raf) last = now
      else advance(now)
      if (restingClosed()) {
        // From rest the chip squeezes first: from its press if there was one (the chip notes
        // it), so a held press has already done the anticipating, otherwise starting now.
        const pressed = Number(chip.dataset.pressed)
        const at = pressed > now - 1000 && pressed <= now ? pressed : now
        pressAt = at
        const go = Math.max(now, at + ANTICIPATION_MS)
        glassAt = { at: go, target: 1 }
        contentAt = { at: go + CONTENT_DELAY, target: 1 }
        advance(now)
      } else {
        pressAt = undefined
        retargetGlass(1)
        contentAt = { at: now + CONTENT_DELAY * (1 - clamp(meanEdge(), 0, 1)), target: 1 }
      }
      kick()
    },
    close(onDone) {
      done = onDone
      const now = performance.now()
      if (!raf) last = now
      else advance(now)
      if (glassAt?.target === 1) {
        // Still squeezing: let go without ever leaving the chip.
        pressAt = undefined
        glassAt = undefined
        contentAt = undefined
        retargetGlass(0)
        retargetContent(0)
      } else {
        const delay = GLASS_DELAY * clamp(content.x, 0, 1)
        retargetContent(0)
        if (delay < 1) retargetGlass(0)
        else glassAt = { at: now + delay, target: 0 }
      }
      kick()
    },
    get closing() {
      return (glassAt?.target ?? glassTarget) === 0
    },
    dispose() {
      if (raf) win.cancelAnimationFrame(raf)
      raf = 0
      done = undefined
      clear()
    },
  }
}
