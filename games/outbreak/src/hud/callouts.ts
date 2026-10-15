import { keyCapHtml } from "@arcade/kit/client/key-cap"

/**
 * World-anchored action callouts: short labels stacked on one side of an actor (below the feet by default).
 *
 * `CalloutModel` holds timing and stacking and has no DOM, so it is unit-tested directly. `CalloutLayer` wraps it
 * with a pooled DOM view that is projected once per frame. Any actor (the local survivor, a remote co-op player)
 * can own callouts; the caller supplies a screen anchor per actor id when rendering.
 *
 *   layer.callout("p1", "+6 9mm", "result")
 *   layer.callout("p1", "Reloading", "progress", { key: "reload", progress: 0.4 })  // upsert each frame
 *   layer.end("p1", "reload")
 *   layer.render(dt, (id) => ({ ...screenPointBelowFeet(id), ax: -0.5, ay: 0, sy: 1 }))
 */

export type CalloutKind = "progress" | "result" | "info" | "warning" | "danger" | "noise"

export type CalloutOptions = {
  /** Seconds the callout stays before fading. Progress callouts expire this long after their last update. */
  duration?: number
  /** 0..1 fill for progress callouts. */
  progress?: number
  /** Upsert key: a second call with the same actor and key updates the existing callout instead of stacking. */
  key?: string
  /** Draws `label` inside the text as the shared key cap for physical `code` ("Empty, R to reload"). */
  keyCap?: { code: string; label: string }
}

export type Callout = {
  readonly id: number
  readonly actorId: string
  key: string
  text: string
  kind: CalloutKind
  born: number
  until: number
  progress: number
  keyCap: { code: string; label: string } | null
  /** Stacking order; refreshed pops move back to the top. */
  order: number
  /** Stack slot the view animates toward; 0 sits nearest the body. */
  slot: number
  /** Animated slot position. */
  y: number
}

export type CalloutTuning = {
  /** Multiplies every default duration. */
  durationScale: number
  /** Most callouts shown per actor; older non-progress callouts are dropped first. */
  maxVisible: number
}

export const FADE_OUT = 0.32
export const FADE_IN = 0.12

const DEFAULT_DURATION: Record<CalloutKind, number> = {
  progress: 0.3,
  result: 1.6,
  info: 1.2,
  warning: 2.0,
  danger: 1.4,
  noise: 1.1,
}

export class CalloutModel {
  readonly items: Callout[] = []
  now = 0
  private nextId = 1

  constructor(readonly tuning: CalloutTuning = { durationScale: 1, maxVisible: 3 }) {}

  callout(actorId: string, text: string, kind: CalloutKind, options: number | CalloutOptions = {}): Callout {
    const opts = typeof options === "number" ? (kind === "progress" ? { progress: options } : { duration: options }) : options
    const key = opts.key ?? `${kind}:${text}`
    const base = opts.duration ?? DEFAULT_DURATION[kind]
    const duration = kind === "progress" && opts.duration === undefined ? base : base * this.tuning.durationScale
    const existing = this.items.find((c) => c.actorId === actorId && c.key === key && c.until > this.now)
    if (existing) {
      const resolved = existing.kind === "progress" && kind !== "progress"
      existing.text = text
      existing.kind = kind
      existing.keyCap = opts.keyCap ?? null
      existing.until = this.now + duration
      if (opts.progress !== undefined) existing.progress = clamp01(opts.progress)
      if (resolved) {
        // A finished action turns into its result in the same slot, already fully visible.
        existing.born = this.now - FADE_IN
        existing.order = Math.min(...this.items.filter((c) => c.actorId === actorId).map((c) => c.order)) - 1
      } else if (kind !== "progress" && this.now - existing.born > FADE_IN) {
        // A repeated pop restarts its entrance and moves to the top so the player sees it happen again.
        existing.born = this.now
        existing.order = this.nextId++
      }
      this.restack(actorId)
      return existing
    }
    const id = this.nextId++
    const item: Callout = {
      id,
      order: id,
      actorId,
      key,
      text,
      kind,
      keyCap: opts.keyCap ?? null,
      born: this.now,
      until: this.now + duration,
      progress: clamp01(opts.progress ?? 0),
      slot: 0,
      y: -1,
    }
    this.items.push(item)
    this.restack(actorId)
    return item
  }

  /** Starts the fade-out of a keyed callout now. */
  end(actorId: string, key: string): void {
    for (const c of this.items) {
      if (c.actorId === actorId && c.key === key && c.until > this.now) c.until = this.now
    }
  }

  clear(actorId?: string): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (actorId === undefined || this.items[i]!.actorId === actorId) this.items.splice(i, 1)
    }
  }

  /** Advances presentation time, drops finished callouts and settles stack slots. */
  advance(dt: number, reducedMotion = false): void {
    this.now += Math.max(0, dt)
    let removed = false
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.now >= this.items[i]!.until + FADE_OUT) {
        this.items.splice(i, 1)
        removed = true
      }
    }
    if (removed) for (const id of new Set(this.items.map((c) => c.actorId))) this.restack(id)
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 16)
    for (const c of this.items) c.y = c.y < 0 ? c.slot : c.y + (c.slot - c.y) * k
  }

  /** Opacity 0..1 from entrance and exit fades. */
  alpha(c: Callout): number {
    const fadeIn = clamp01((this.now - c.born) / FADE_IN)
    const fadeOut = clamp01((c.until + FADE_OUT - this.now) / FADE_OUT)
    return Math.min(fadeIn, fadeOut)
  }

  /** Extra drift in slot units, away from the body: result and danger pops float outward as they age. */
  drift(c: Callout, reducedMotion = false): number {
    if (reducedMotion || c.kind === "progress") return 0
    const age = this.now - c.born
    const enter = (1 - clamp01(age / FADE_IN)) * -0.25
    const float = c.kind === "result" || c.kind === "danger" ? Math.min(age, 2.5) * 0.18 : 0
    return enter + float
  }

  forActor(actorId: string): Callout[] {
    return this.items.filter((c) => c.actorId === actorId)
  }

  /**
   * Inside-out order: in-progress actions sit nearest the body, then older to newer, so the newest pop is outermost.
   * Fading callouts keep their slot until they are gone, so nothing slides under them. When more than `maxVisible`
   * live callouts exist, the oldest non-progress ones are removed at once.
   */
  private restack(actorId: string): void {
    const mine = this.items.filter((c) => c.actorId === actorId)
    mine.sort((a, b) => (a.kind === "progress" ? 0 : 1) - (b.kind === "progress" ? 0 : 1) || a.order - b.order)
    let overflow = mine.filter((c) => c.until > this.now).length - Math.max(1, Math.round(this.tuning.maxVisible))
    let slot = 0
    for (const c of mine) {
      if (overflow > 0 && c.kind !== "progress" && c.until > this.now) {
        overflow--
        this.items.splice(this.items.indexOf(c), 1)
        continue
      }
      c.slot = slot++
    }
  }
}

export type ScreenPoint = {
  x: number
  y: number
  /** Label alignment as fractions of its own size: -0.5/-1 hangs it centred above the point (the default). */
  ax?: number
  ay?: number
  /** Direction the stack grows in rows: -1 up (default), 1 down. */
  sy?: number
  /** Size multiplier for this actor, such as a smaller teammate. */
  scale?: number
}

export type CalloutView = {
  /** CSS pixel font size. */
  size: number
  reducedMotion: boolean
  /** Device pixels per CSS pixel; positions snap to it so glyphs land on whole device pixels. Default devicePixelRatio. */
  pixelRatio?: number
}

/** Rounds a CSS-pixel coordinate to the nearest device pixel. */
export function snapToDevice(v: number, ratio: number): number {
  return Math.round(v * ratio) / ratio
}

type Node = {
  el: HTMLDivElement
  body: HTMLDivElement
  text: HTMLSpanElement
  kind: string
  label: string
  transform: string
  opacity: string
  progress: string
  font: string
  /** Measured label size in CSS pixels; 0 until measured, reset when the text or size changes. */
  w: number
  h: number
}

/** Pooled DOM renderer for a `CalloutModel`. Only visible callouts touch the DOM; an idle layer writes nothing. */
export class CalloutLayer {
  readonly model: CalloutModel
  readonly root: HTMLDivElement
  private nodes = new Map<number, Node>()
  private pool: Node[] = []
  private reducedQuery: MediaQueryList | null

  constructor(
    parent: HTMLElement,
    tuning: CalloutTuning,
    readonly view: CalloutView = { size: 12, reducedMotion: false },
  ) {
    this.model = new CalloutModel(tuning)
    this.root = document.createElement("div")
    this.root.className = "callouts"
    this.root.setAttribute("aria-live", "polite")
    parent.append(this.root)
    this.reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null
  }

  callout(actorId: string, text: string, kind: CalloutKind, options?: number | CalloutOptions): Callout {
    return this.model.callout(actorId, text, kind, options)
  }

  end(actorId: string, key: string): void {
    this.model.end(actorId, key)
  }

  clear(actorId?: string): void {
    this.model.clear(actorId)
  }

  get reducedMotion(): boolean {
    return this.view.reducedMotion || Boolean(this.reducedQuery?.matches)
  }

  /** Advances and projects. `anchor` returns the CSS-pixel point the stack starts from, or null if off screen. */
  render(dt: number, anchor: (actorId: string) => ScreenPoint | null): void {
    const reduced = this.reducedMotion
    this.model.advance(dt, reduced)
    const items = this.model.items
    if (!items.length && !this.nodes.size) return
    const rowBase = this.view.size * 1.95
    const ratio = this.view.pixelRatio ?? (typeof devicePixelRatio === "number" ? devicePixelRatio : 1)
    const anchors = new Map<string, ScreenPoint | null>()
    const seen = new Set<number>()
    const live: [Callout, Node, ScreenPoint][] = []
    // Pass 1, writes: content, kind and font size. Text is never scaled with a transform; a smaller actor gets a
    // smaller font, so glyphs are rasterised at their final size.
    for (const c of items) {
      let a = anchors.get(c.actorId)
      if (a === undefined) {
        a = anchor(c.actorId)
        anchors.set(c.actorId, a)
      }
      if (!a) continue
      seen.add(c.id)
      let node = this.nodes.get(c.id)
      if (!node) {
        node = this.pool.pop() ?? this.createNode()
        this.nodes.set(c.id, node)
        this.root.append(node.el)
      }
      if (node.kind !== c.kind) {
        node.kind = c.kind
        node.el.dataset.kind = c.kind
        node.w = 0
      }
      const label = c.keyCap ? `${c.text}\u0000${c.keyCap.code}` : c.text
      if (node.label !== label) {
        node.label = label
        node.w = 0
        const cap = c.keyCap
        const at = cap ? c.text.indexOf(cap.label) : -1
        if (cap && at >= 0) {
          node.text.innerHTML = `${escapeHtml(c.text.slice(0, at))}${keyCapHtml(cap.code, { label: cap.label })}${escapeHtml(c.text.slice(at + cap.label.length))}`
        } else node.text.textContent = c.text
      }
      const scale = a.scale ?? 1
      const font = scale === 1 ? "" : `${Math.round(this.view.size * scale * 2) / 2}px`
      if (node.font !== font) {
        node.font = font
        node.w = 0
        if (font) node.body.style.setProperty("--callout-size", font)
        else node.body.style.removeProperty("--callout-size")
      }
      live.push([c, node, a])
    }
    // Pass 2, reads: measure only labels whose text or size changed, all in one layout.
    for (const [, node] of live) {
      if (node.w) continue
      node.w = node.body.offsetWidth
      node.h = node.body.offsetHeight
    }
    // Pass 3, writes: the label's top-left corner, snapped to a device pixel.
    for (const [c, node, a] of live) {
      const scale = a.scale ?? 1
      const sy = a.sy ?? -1
      const y = a.y + sy * (c.y + this.model.drift(c, reduced)) * Math.round(rowBase * scale)
      const left = snapToDevice(a.x + (a.ax ?? -0.5) * node.w, ratio)
      const top = snapToDevice(y + (a.ay ?? -1) * node.h, ratio)
      const transform = `translate(${left}px,${top}px)`
      if (node.transform !== transform) {
        node.transform = transform
        node.el.style.transform = transform
      }
      const opacity = this.model.alpha(c).toFixed(2)
      if (node.opacity !== opacity) {
        node.opacity = opacity
        node.el.style.opacity = opacity
      }
      if (c.kind === "progress") {
        const p = c.progress.toFixed(3)
        if (node.progress !== p) {
          node.progress = p
          node.el.style.setProperty("--p", p)
        }
      }
    }
    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue
      this.nodes.delete(id)
      node.el.remove()
      node.label = ""
      node.transform = ""
      node.opacity = ""
      node.progress = ""
      this.pool.push(node)
    }
  }

  /** Sets the font size; layout scales with it. */
  setSize(px: number): void {
    if (this.view.size !== px) this.invalidate()
    this.view.size = px
    this.root.style.setProperty("--callout-size", `${px}px`)
  }

  /** Re-measures every label on the next render (after a look or font change). */
  invalidate(): void {
    for (const node of this.nodes.values()) node.w = 0
  }

  private createNode(): Node {
    const el = document.createElement("div")
    el.className = "callout"
    const inner = document.createElement("div")
    inner.className = "callout-body"
    const ring = document.createElement("i")
    ring.className = "callout-ring"
    const text = document.createElement("span")
    inner.append(ring, text)
    el.append(inner)
    return { el, body: inner, text, kind: "", label: "", transform: "", opacity: "", progress: "", font: "", w: 0, h: 0 }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
