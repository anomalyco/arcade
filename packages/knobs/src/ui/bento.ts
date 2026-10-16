import { Spring, springMotion } from "../core/spring.js"
import {
  fitRect,
  motionBlur,
  neighbour,
  planBento,
  windowOf,
  type BentoDirection,
  type BentoPlan,
  type BentoRect,
} from "./bento-model.js"
import { applyLook, frameLoop, reducedMotion, syncFrame, type UiLook } from "./look.js"

export interface BentoItem {
  readonly id: string
  /** Width / height. Images without one take their natural size. */
  readonly aspect?: number
  /** An image. */
  readonly src?: string
  /** Responsive candidates for the image; the tile's size picks one, and a zoom a larger one. */
  readonly srcset?: string
  readonly alt?: string
  /**
   * Your own content (a live canvas, a prototype), drawn into `el` when the tile comes into view;
   * return a cleanup for when it leaves. Zoomed, it takes the pointer.
   */
  readonly render?: (el: HTMLElement) => void | (() => void)
  /** Shown as type on hover. */
  readonly label?: string
  /** Items in the same group sit together under its name (the set then scrolls). */
  readonly group?: string
  /** Asks to be the large tile when the set fits one screen. */
  readonly hero?: boolean
}

export interface BentoOptions extends UiLook {
  readonly items: readonly BentoItem[]
  /** Between tiles, px (2). */
  readonly gap?: number
  /** Around the tiles, px (the gap). */
  readonly padding?: number
  /** How far a tile may be cropped to fill a row (.08). */
  readonly tolerance?: number
  /** Scrolling rows' target height, px (about a third of the view). */
  readonly rowHeight?: number
  /** Whether a few items may lay out on one screen (true). */
  readonly fit?: boolean
  /** The most a zooming or sliding tile blurs with its speed, px (2.5; 0 for none). */
  readonly blur?: number
  readonly picks?: Iterable<string>
  /** Space toggles a pick; the picks in the items' order. */
  readonly onPick?: (ids: readonly string[]) => void
  readonly onZoom?: (id: string | null) => void
  readonly onActive?: (id: string | null) => void
  /** The grid's accessible name. */
  readonly label?: string
}

export interface Bento {
  readonly element: HTMLElement
  /** New items: tiles that stay glide to their places, new ones come in, gone ones soften out. */
  update(items: readonly BentoItem[]): void
  /** Zooms an item to fill the view (`null` zooms back out). */
  zoom(id: string | null): void
  readonly zoomed: string | null
  readonly active: string | null
  focus(id?: string): void
  readonly picks: readonly string[]
  pick(ids: Iterable<string>): void
  readonly plan: BentoPlan
  /** Whether anything is moving (the frame loop runs only then). */
  readonly moving: boolean
  /** Frames stepped, and the script time each took (ms), for perf checks. */
  stats(): { frames: number; p50: number; p95: number; max: number }
  dispose(): void
}

// Kit's palette, duration / bounce: layout moves calm, the zoom smooth and its return shorter,
// a neighbour's slide default, exits snappy, and fades under reduced motion.
const LAYOUT = springMotion({ duration: 0.4, bounce: 0 })
const ZOOM_IN = springMotion({ duration: 0.45, bounce: 0 })
const ZOOM_OUT = springMotion({ duration: 0.38, bounce: 0 })
const SLIDE = springMotion({ duration: 0.3, bounce: 0 })
const SLIDE_OUT = springMotion({ duration: 0.25, bounce: 0 })
const ENTER = springMotion({ duration: 0.3, bounce: 0 })
const EXIT = springMotion({ duration: 0.25, bounce: 0 })
const WASH = springMotion({ duration: 0.25, bounce: 0 })
const FADE = springMotion({ duration: 0.18, bounce: 0 })
/** A mouse wheel's notches under ⌘ step the zoom on the instant spring rather than jump. */
const INSTANT = springMotion({ duration: 0.1, bounce: 0 })
/** A neighbour slides this share of the view's width. */
const SLIDE_BY = 0.12
const EXIT_BLUR = 3

type Motion = { omega: number; zeta: number }
const px = (x: number) => new Spring(x, LAYOUT.omega, LAYOUT.zeta, 0.05)
const unit = (x: number) => new Spring(x, ENTER.omega, ENTER.zeta, 0.0005)
const drive = (s: Spring, m: Motion, target: number) => {
  s.omega = m.omega
  s.zeta = m.zeta
  return s.set(target)
}

interface Tile {
  id: string
  item: BentoItem
  el: HTMLElement
  img: HTMLImageElement | null
  cleanup: (() => void) | undefined
  x: Spring
  y: Spring
  w: Spring
  h: Spring
  /** Presence: 0 → 1 coming in, 1 → 0 going. */
  life: Spring
  leaving: boolean
  boxW: number
  boxH: number
  drawn: string
}

interface Focus {
  tile: Tile
  /** Grid (0) → filling the view (1). */
  z: Spring
  /** The neighbour slide, px. */
  dx: Spring
  alpha: Spring
  /** Whether `alpha` veils the scrim too (reduced motion's fades). */
  veil: boolean
  /** Sliding away for a neighbour. */
  out: boolean
  /** The hand's speed while a pinch drives `z` (1/s). */
  hand: number
}

const probed = new Map<string, number>()
/** The smallest candidate in a srcset: enough to learn an image's shape, and what a tile shows. */
const smallest = (srcset: string | undefined) => {
  let best: { url: string; w: number } | undefined
  for (const part of srcset?.split(/,\s+/) ?? []) {
    const [url, size] = part.trim().split(/\s+/)
    const w = Number.parseFloat(size ?? "") || Number.POSITIVE_INFINITY
    if (url && (!best || w < best.w)) best = { url, w }
  }
  return best?.url
}

/**
 * An ideas grid: a bento of images and live content, laid out to show as much as possible, that
 * zooms an item to fill the view. See `planBento` for the layout. Click or Enter zooms; Esc, a
 * click or a pinch out returns to the exact grid place; ←/→ (or a swipe) step through neighbours
 * while zoomed; ⌘-scroll or a pinch zooms by hand. Arrows move a wash through the grid by
 * geometry, Space picks, 1–9 jump. Offscreen tiles aren't in the page, and the frame loop sleeps
 * when nothing moves.
 */
export function bento(container: HTMLElement, options: BentoOptions): Bento {
  const doc = container.ownerDocument
  const win = doc.defaultView!
  const gap = options.gap ?? 2
  const maxBlur = options.blur ?? 2.5
  const pad = options.padding ?? gap
  let items = options.items
  let index = new Map<string, number>()
  const reindex = () => {
    index = new Map(items.map((it, i) => [it.id, i]))
  }
  reindex()
  let picks = new Set(options.picks ?? [])
  let active: string | null = null
  let plan: BentoPlan = planBento([], { width: 0, height: 0 })
  let vw = 0
  let vh = 0
  let ready = false
  let frames = 0
  const times: number[] = []

  const root = doc.createElement("div")
  root.className = "knobs-bento"
  root.tabIndex = 0
  root.setAttribute("role", "listbox")
  root.setAttribute("aria-multiselectable", "true")
  root.setAttribute("aria-label", options.label ?? "Ideas")
  applyLook(root, options)
  const space = doc.createElement("div")
  space.className = "knobs-bento-space"
  const scrim = doc.createElement("div")
  scrim.className = "knobs-bento-scrim"
  const wash = doc.createElement("div")
  wash.className = "knobs-bento-wash"
  space.append(scrim, wash)
  root.append(space)
  container.append(root)

  const uid = `kb${Math.random().toString(36).slice(2, 7)}`
  const tiles = new Map<string, Tile>()
  const focuses: Focus[] = []
  const heads = new Map<string, { el: HTMLElement; y: Spring }>()
  const washR = { x: px(0), y: px(0), w: px(1), h: px(1), shown: false }
  const motionQuery = win.matchMedia?.("(prefers-reduced-motion: reduce)")
  const reduced = () => motionQuery?.matches ?? reducedMotion(win)
  let serial = 0

  const aspectOf = (it: BentoItem) => {
    const a = it.aspect ?? (it.src ? probed.get(it.src) : undefined)
    return a && Number.isFinite(a) && a > 0 ? a : it.render ? 4 / 3 : 1
  }
  const heroIndex = () => items.findIndex((it) => it.hero)

  // ---- Natural sizes ----------------------------------------------------------------------
  let pendingProbes = 0
  const probe = (it: BentoItem) => {
    if (it.aspect || !it.src || probed.has(it.src)) return
    const src = it.src
    probed.set(src, Number.NaN)
    pendingProbes++
    const img = new Image()
    img.decoding = "async"
    const done = () => {
      pendingProbes--
      probed.set(
        src,
        img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1,
      )
      if (ready) relayout("glide")
      else if (!pendingProbes) start()
    }
    img.onload = done
    img.onerror = done
    img.src = smallest(it.srcset) ?? src
  }
  for (const it of items) probe(it)

  // ---- Tiles ------------------------------------------------------------------------------
  const rectOf = (id: string) => {
    const i = index.get(id)
    return i === undefined ? undefined : plan.rects[i]
  }
  const setBox = (t: Tile, w: number, h: number) => {
    if (Math.abs(w - t.boxW) < 0.25 && Math.abs(h - t.boxH) < 0.25) return
    t.boxW = Math.max(1, w)
    t.boxH = Math.max(1, h)
    t.el.style.width = `${t.boxW}px`
    t.el.style.height = `${t.boxH}px`
    if (t.img) t.img.sizes = `${Math.ceil(t.boxW)}px`
  }
  const mount = (it: BentoItem, r: BentoRect, from?: BentoRect, enter = false) => {
    const el = doc.createElement("div")
    el.className = "knobs-bento-tile"
    el.id = `${uid}-${serial++}`
    el.dataset.id = it.id
    el.setAttribute("role", "option")
    el.setAttribute("aria-selected", String(picks.has(it.id)))
    if (it.label) el.setAttribute("aria-label", it.label)
    let img: HTMLImageElement | null = null
    let cleanup: (() => void) | undefined
    if (it.src) {
      img = doc.createElement("img")
      img.className = "knobs-bento-img"
      img.decoding = "async"
      img.draggable = false
      img.alt = it.alt ?? it.label ?? ""
      img.sizes = `${Math.ceil(r.w)}px`
      if (it.srcset) img.srcset = it.srcset
      img.src = it.src
      el.append(img)
      const t0 = performance.now()
      const shown = () => {
        if (performance.now() - t0 < 50) el.dataset.instant = ""
        el.dataset.ready = ""
      }
      img.decode().then(shown, shown)
    } else if (it.render) {
      el.dataset.live = ""
      const body = doc.createElement("div")
      body.className = "knobs-bento-body"
      el.append(body)
      cleanup = it.render(body) || undefined
    }
    if (it.label) {
      const label = doc.createElement("span")
      label.className = "knobs-bento-label"
      label.textContent = it.label
      el.append(label)
    }
    const f = from ?? r
    const t: Tile = {
      id: it.id,
      item: it,
      el,
      img,
      cleanup,
      x: px(f.x).set(r.x),
      y: px(f.y).set(r.y),
      w: px(f.w).set(r.w),
      h: px(f.h).set(r.h),
      life: unit(1),
      leaving: false,
      boxW: 0,
      boxH: 0,
      drawn: "",
    }
    if (enter && !reduced()) drive(t.life.snap(0), ENTER, 1)
    else if (enter) drive(t.life.snap(0), FADE, 1)
    if (reduced() || !from) for (const s of [t.x, t.y, t.w, t.h]) s.snap(s.target)
    setBox(t, r.w, r.h)
    if (it.id === active) el.dataset.active = ""
    tiles.set(it.id, t)
    space.append(el)
    draw(t)
    return t
  }
  const unmount = (t: Tile) => {
    t.cleanup?.()
    t.el.remove()
    tiles.delete(t.id)
  }
  const resting = (t: Tile) =>
    t.x.resting && t.y.resting && t.w.resting && t.h.resting && t.life.resting
  const focusOf = (t: Tile) => focuses.find((f) => f.tile === t)

  /** Where a focused tile fills the view, in content coordinates. */
  const fitOf = (t: Tile): BentoRect => {
    const f = fitRect(aspectOf(t.item), vw, vh, pad)
    return { x: f.x, y: f.y + root.scrollTop, w: f.w, h: f.h }
  }

  const draw = (t: Tile) => {
    let x = t.x.x
    let y = t.y.x
    let w = t.w.x
    let h = t.h.x
    let opacity = 1
    let blur = 0
    const life = Math.min(1, Math.max(0, t.life.x))
    if (life < 1) {
      opacity = life
      if (!reduced()) {
        const s = 0.96 + 0.04 * life
        x += (w * (1 - s)) / 2
        y += (h * (1 - s)) / 2
        w *= s
        h *= s
        blur = (1 - life) * EXIT_BLUR
      }
    }
    const f = focusOf(t)
    if (f) {
      const fit = fitOf(t)
      const z = f.z.x
      const dist =
        Math.hypot(fit.x + fit.w / 2 - (x + w / 2), fit.y + fit.h / 2 - (y + h / 2)) +
        Math.abs(fit.w - w) / 2
      x += (fit.x - x) * z + f.dx.x
      y += (fit.y - y) * z
      w += (fit.w - w) * z
      h += (fit.h - h) * z
      opacity *= Math.min(1, Math.max(0, f.alpha.x))
      // Under the hand it blurs half as much: the fingers already say where it's going.
      const speed =
        (f.hand ? Math.abs(f.hand) * 0.5 : Math.abs(f.z.v)) * dist + Math.abs(f.dx.v) * 2
      blur = Math.max(blur, motionBlur(speed, maxBlur))
    }
    const transform = `translate3d(${x}px,${y}px,0) scale(${w / t.boxW},${h / t.boxH})`
    const o = opacity >= 0.999 ? "" : String(Math.round(opacity * 1000) / 1000)
    const filter = blur ? `blur(${Math.round(blur * 4) / 4}px)` : ""
    const key = `${transform}|${o}|${filter}`
    if (key === t.drawn) return
    t.drawn = key
    t.el.style.transform = transform
    t.el.style.opacity = o
    t.el.style.filter = filter
  }

  const scrimLevel = () => {
    let level = 0
    for (const f of focuses)
      level = Math.max(level, Math.min(1, f.z.x) * (f.veil ? Math.max(0, f.alpha.x) : 1))
    return level
  }
  let scrimDrawn = ""
  const drawScrim = () => {
    const level = scrimLevel()
    const key = `${root.scrollTop}|${vh}|${level.toFixed(3)}`
    if (key === scrimDrawn) return
    scrimDrawn = key
    scrim.style.height = `${vh}px`
    scrim.style.transform = `translateY(${root.scrollTop}px)`
    scrim.style.opacity = String(Math.round(level * 0.97 * 1000) / 1000)
    scrim.style.visibility = level > 0 ? "" : "hidden"
  }

  const drawWash = () => {
    const { x, y, w, h } = washR
    wash.style.transform = `translate3d(${x.x}px,${y.x}px,0) scale(${w.x / 100},${h.x / 100})`
  }
  const aimWash = (snap: boolean) => {
    const r = active ? rectOf(active) : undefined
    if (!r) {
      delete wash.dataset.on
      washR.shown = false
      return
    }
    wash.dataset.on = ""
    const s = snap || !washR.shown || reduced()
    for (const [spring, v] of [
      [washR.x, r.x],
      [washR.y, r.y],
      [washR.w, r.w],
      [washR.h, r.h],
    ] as const) {
      if (s) spring.snap(v)
      else drive(spring, WASH, v)
    }
    washR.shown = true
    drawWash()
    loop.wake()
  }

  // ---- Headings ---------------------------------------------------------------------------
  const syncHeads = (snap: boolean) => {
    const seen = new Set<string>()
    for (const head of plan.headers) {
      seen.add(head.group)
      let h = heads.get(head.group)
      if (!h) {
        const el = doc.createElement("div")
        el.className = "knobs-bento-head"
        el.textContent = head.group
        space.append(el)
        h = { el, y: px(head.y) }
        heads.set(head.group, h)
        snap = true
      }
      h.el.style.height = "28px"
      h.el.style.left = `${pad}px`
      if (snap || reduced()) h.y.snap(head.y)
      else drive(h.y, LAYOUT, head.y)
      h.el.style.transform = `translateY(${h.y.x}px)`
    }
    for (const [group, h] of heads)
      if (!seen.has(group)) {
        h.el.remove()
        heads.delete(group)
      }
  }

  // ---- Layout and the window of mounted tiles ---------------------------------------------
  /** Where tiles were before a relayout: those coming into view glide in from there. */
  type Before = { plan: BentoPlan; index: Map<string, number> }
  const syncWindow = (before?: Before, entering?: Set<string>) => {
    const top = root.scrollTop
    const want = new Set<number>(windowOf(plan, top - vh * 0.6, top + vh * 1.6))
    for (const i of want) {
      const it = items[i]!
      if (tiles.has(it.id)) continue
      const was = before?.index.get(it.id)
      mount(
        it,
        plan.rects[i]!,
        was === undefined ? undefined : before!.plan.rects[was],
        entering?.has(it.id),
      )
    }
    for (const t of tiles.values()) {
      const i = index.get(t.id)
      if (t.leaving || (i !== undefined && want.has(i))) continue
      if (t.id === active || focusOf(t) || !resting(t)) continue
      unmount(t)
    }
  }

  const relayout = (
    how: "snap" | "glide",
    before: Before = { plan, index },
    entering?: Set<string>,
  ) => {
    syncFrame(root)
    vw = root.clientWidth
    vh = root.clientHeight
    const hero = heroIndex()
    plan = planBento(items.map(aspectOf), {
      width: vw,
      height: vh,
      gap,
      padding: pad,
      tolerance: options.tolerance,
      rowHeight: options.rowHeight,
      fit: options.fit,
      groups: items.some((it) => it.group !== undefined) ? items.map((it) => it.group) : undefined,
      hero: hero >= 0 ? hero : undefined,
    })
    root.dataset.mode = plan.mode
    space.style.height = `${Math.max(plan.height, vh)}px`
    const snap = how === "snap" || reduced()
    for (const t of tiles.values()) {
      if (t.leaving) continue
      const r = rectOf(t.id)
      if (!r) continue
      for (const [s, v] of [
        [t.x, r.x],
        [t.y, r.y],
        [t.w, r.w],
        [t.h, r.h],
      ] as const) {
        if (snap) s.snap(v)
        else drive(s, LAYOUT, v)
      }
      const f = focusOf(t)
      if (f) {
        const fit = fitOf(t)
        setBox(t, fit.w, fit.h)
      } else setBox(t, r.w, r.h)
      draw(t)
    }
    syncHeads(snap)
    syncWindow(snap ? undefined : before, entering)
    aimWash(snap)
    drawScrim()
    loop.wake()
  }

  const start = () => {
    if (ready) return
    ready = true
    delete root.dataset.pending
    relayout("snap")
  }

  // ---- The frame loop ---------------------------------------------------------------------
  const frame = (dt: number) => {
    const t0 = performance.now()
    frames++
    let moving = false
    for (const t of [...tiles.values()]) {
      if (!resting(t)) {
        t.x.step(dt)
        t.y.step(dt)
        t.w.step(dt)
        t.h.step(dt)
        t.life.step(dt)
        moving = true
        draw(t)
        if (t.leaving && t.life.resting && t.life.target === 0) unmount(t)
      }
    }
    for (const f of [...focuses]) {
      if (!(f.z.resting && f.dx.resting && f.alpha.resting) || f.hand) {
        f.z.step(dt)
        f.dx.step(dt)
        f.alpha.step(dt)
        f.hand *= Math.exp(-dt * 24)
        if (Math.abs(f.hand) < 0.01) f.hand = 0
        moving = true
      }
      draw(f.tile)
      const gone =
        (f.out && f.alpha.resting && f.alpha.target === 0) ||
        (f.veil && f.alpha.resting && f.alpha.target === 0) ||
        (!f.out && !f.veil && hand?.f !== f && f.z.resting && f.z.target === 0)
      if (gone) endFocus(f)
    }
    for (const s of [washR.x, washR.y, washR.w, washR.h])
      if (!s.resting) {
        s.step(dt)
        moving = true
      }
    if (moving) drawWash()
    for (const h of heads.values())
      if (!h.y.resting) {
        h.y.step(dt)
        h.el.style.transform = `translateY(${h.y.x}px)`
        moving = true
      }
    drawScrim()
    if (hand) moving = true
    if (!moving) syncWindow()
    times.push(performance.now() - t0)
    if (times.length > 600) times.splice(0, times.length - 600)
    return moving
  }
  const loop = frameLoop(win, frame)

  // ---- Zoom ---------------------------------------------------------------------------------
  const current = () =>
    focuses.find((f) => !f.out && !(f.veil && f.alpha.target === 0) && f.z.target === 1) ?? null
  const ensure = (id: string) => {
    const t = tiles.get(id)
    if (t && !t.leaving) return t
    const r = rectOf(id)
    const i = index.get(id)
    if (!r || i === undefined) return null
    return mount(items[i]!, r)
  }
  const setActive = (id: string | null) => {
    if (active === id) return
    if (active) {
      const prev = tiles.get(active)
      if (prev) delete prev.el.dataset.active
    }
    active = id
    const t = id ? tiles.get(id) : undefined
    if (t) t.el.dataset.active = ""
    if (t) root.setAttribute("aria-activedescendant", t.el.id)
    else root.removeAttribute("aria-activedescendant")
    options.onActive?.(id)
  }
  const beginFocus = (t: Tile): Focus => {
    const f: Focus = {
      tile: t,
      z: unit(0),
      dx: px(0),
      alpha: unit(1),
      veil: false,
      out: false,
      hand: 0,
    }
    focuses.push(f)
    t.el.dataset.focus = ""
    t.el.style.willChange = "transform,filter"
    const fit = fitOf(t)
    setBox(t, fit.w, fit.h)
    t.drawn = ""
    return f
  }
  const endFocus = (f: Focus) => {
    const i = focuses.indexOf(f)
    if (i >= 0) focuses.splice(i, 1)
    const t = f.tile
    delete t.el.dataset.focus
    t.el.style.willChange = ""
    const r = rectOf(t.id)
    if (r) setBox(t, r.w, r.h)
    // Back in its place under the scrim: it fades in rather than appearing.
    if (f.out || f.veil) drive(t.life.snap(0), reduced() ? FADE : ENTER, 1)
    t.drawn = ""
    draw(t)
    syncZoomed()
  }
  let reported: string | null = null
  const syncZoomed = () => {
    const z = current()?.tile.id ?? null
    if (z) root.dataset.zoomed = ""
    else delete root.dataset.zoomed
    if (z !== reported) {
      reported = z
      options.onZoom?.(z)
    }
  }
  const zoomIn = (id: string) => {
    const t = ensure(id)
    if (!t) return
    setActive(id)
    const now = current()
    if (now && now.tile !== t) return go(index.get(id)! > index.get(now.tile.id)! ? 1 : -1, id)
    let f = focusOf(t)
    if (!f) f = beginFocus(t)
    f.out = false
    if (reduced()) {
      f.z.snap(1)
      f.dx.snap(0)
      f.veil = true
      drive(f.alpha.snap(f.alpha.target === 0 ? f.alpha.x : 0), FADE, 1)
    } else {
      f.veil = false
      drive(f.z, ZOOM_IN, 1)
      drive(f.dx, SLIDE, 0)
      drive(f.alpha, ENTER, 1)
    }
    syncZoomed()
    root.focus({ preventScroll: true })
    loop.wake()
  }
  /** Scrolls the grid, under the zoom, so `id`'s place is in view; the zoomed tile stays put. */
  const revealUnder = (id: string) => {
    const r = rectOf(id)
    if (!r || plan.mode !== "rows") return
    const top = root.scrollTop
    if (r.y >= top + pad && r.y + r.h <= top + vh - pad) return
    root.scrollTop = Math.max(0, r.y - (vh - r.h) / 2)
    onScroll()
  }
  const zoomOut = () => {
    let f = current()
    if (hand) {
      win.clearTimeout(hand.timer)
      f = hand.f
      f.z.v = f.hand
      f.hand = 0
      hand = null
    }
    if (!f) return
    revealUnder(f.tile.id)
    if (reduced()) {
      f.veil = true
      drive(f.alpha, FADE, 0)
    } else drive(f.z, ZOOM_OUT, 0)
    syncZoomed()
    loop.wake()
  }
  /** While zoomed: the next (1) or previous (-1) item, or `to`, slides in. */
  const go = (dir: 1 | -1, to?: string) => {
    const cur = current()
    if (!cur) return
    const at = index.get(cur.tile.id)!
    const id = to ?? items[at + dir]?.id
    if (!id || id === cur.tile.id) return
    const t = ensure(id)
    if (!t) return
    const by = reduced() ? 0 : vw * SLIDE_BY
    cur.out = true
    cur.veil = false
    drive(cur.dx, SLIDE_OUT, -dir * by)
    drive(cur.alpha, reduced() ? FADE : SLIDE_OUT, 0)
    let f = focusOf(t)
    if (!f) {
      f = beginFocus(t)
      f.z.snap(1)
      f.dx.snap(dir * by)
      f.alpha.snap(0)
    }
    f.out = false
    f.veil = false
    drive(f.z, ZOOM_IN, 1)
    drive(f.dx, SLIDE, 0)
    drive(f.alpha, reduced() ? FADE : SLIDE, 1)
    setActive(id)
    syncZoomed()
    loop.wake()
  }

  // ---- Zooming by hand: ⌘-scroll, a trackpad pinch, two fingers --------------------------
  let hand: { f: Focus; z0: number; k: number; last: number; timer: number } | null = null
  const tileAt = (cx: number, cy: number) => {
    const el = doc.elementFromPoint(cx, cy)?.closest<HTMLElement>(".knobs-bento-tile")
    return el && root.contains(el) ? tiles.get(el.dataset.id!) : undefined
  }
  const pinch = (factor: number, cx: number, cy: number, stepped = false) => {
    if (!Number.isFinite(factor) || factor <= 0) return
    if (!hand) {
      let f = current()
      if (!f) {
        if (factor <= 1) return
        const t = tileAt(cx, cy)
        if (!t || t.leaving) return
        setActive(t.id)
        f = focusOf(t) ?? beginFocus(t)
        f.out = false
        f.veil = false
        f.alpha.snap(1)
      }
      hand = { f, z0: f.z.x, k: 1, last: performance.now(), timer: 0 }
    }
    const h = hand
    const t = h.f.tile
    const r = rectOf(t.id)
    if (!r) return
    h.k *= factor
    // The tile follows the fingers 1:1: its width is where the pinch began times the pinch.
    const fw = fitOf(t).w
    const span = Math.max(1, fw - r.w)
    const w0 = r.w + (fw - r.w) * h.z0
    const z = Math.min(1.04, Math.max(0, (w0 * h.k - r.w) / span))
    const now = performance.now()
    const dt = Math.max(0.004, (now - h.last) / 1000)
    h.last = now
    if (stepped) drive(h.f.z, INSTANT, z)
    else {
      h.f.hand = h.f.hand * 0.5 + ((z - h.f.z.x) / dt) * 0.5
      h.f.z.snap(z)
    }
    win.clearTimeout(h.timer)
    h.timer = win.setTimeout(release, 140)
    root.dataset.zoomed = ""
    draw(t)
    drawScrim()
    loop.wake()
  }
  const release = () => {
    const h = hand
    if (!h) return
    hand = null
    const f = h.f
    const v = f.hand || f.z.v
    f.hand = 0
    f.z.v = v
    const open = f.z.x + v * 0.08 > 0.5
    if (open) {
      drive(f.z, ZOOM_IN, 1)
      setActive(f.tile.id)
    } else {
      revealUnder(f.tile.id)
      drive(f.z, ZOOM_OUT, 0)
    }
    syncZoomed()
    loop.wake()
  }

  // ---- Input --------------------------------------------------------------------------------
  let swipe = { sum: 0, locked: false, timer: 0 }
  const onWheel = (e: WheelEvent) => {
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh : 1
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      pinch(Math.exp(-e.deltaY * k * 0.01), e.clientX, e.clientY, Math.abs(e.deltaY * k) >= 40)
      return
    }
    if (!current() && !hand) return
    e.preventDefault()
    win.clearTimeout(swipe.timer)
    swipe.timer = win.setTimeout(() => (swipe = { sum: 0, locked: false, timer: 0 }), 160)
    if (swipe.locked || Math.abs(e.deltaX) < Math.abs(e.deltaY)) return
    swipe.sum += e.deltaX * k
    if (Math.abs(swipe.sum) > 40) {
      swipe.locked = true
      go(swipe.sum > 0 ? 1 : -1)
    }
  }
  // Safari's trackpad pinch.
  let gestureScale = 1
  const onGesture = (e: Event) => {
    e.preventDefault()
    const g = e as Event & { scale: number; clientX: number; clientY: number }
    if (e.type === "gesturestart") gestureScale = 1
    if (e.type !== "gesturechange") return
    pinch(g.scale / gestureScale, g.clientX, g.clientY)
    gestureScale = g.scale
  }
  // Touch: two fingers pinch, one swipes while zoomed.
  const touches = new Map<number, { x: number; y: number; x0: number }>()
  let pinchD = 0
  const spread = () => {
    const [a, b] = [...touches.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX })
    if (touches.size === 2) pinchD = spread()
  }
  const onPointerMove = (e: PointerEvent) => {
    const p = touches.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    if (touches.size === 2 && pinchD > 0) {
      const d = spread()
      const [a, b] = [...touches.values()]
      pinch(d / pinchD, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2)
      pinchD = d
      suppressClick = true
    }
  }
  const onPointerUp = (e: PointerEvent) => {
    const p = touches.get(e.pointerId)
    if (!p) return
    touches.delete(e.pointerId)
    if (!touches.size && pinchD === 0 && current() && Math.abs(p.x - p.x0) > 50) {
      go(p.x < p.x0 ? 1 : -1)
      suppressClick = true
    }
    if (touches.size < 2) pinchD = touches.size ? -1 : 0
  }

  let suppressClick = false
  const onClick = (e: MouseEvent) => {
    if (suppressClick) {
      suppressClick = false
      return
    }
    delete root.dataset.keyboard
    const el = (e.target as Element).closest<HTMLElement>(".knobs-bento-tile")
    const t = el ? tiles.get(el.dataset.id!) : undefined
    if (current()) {
      // A zoomed prototype keeps its clicks; a click anywhere else returns to the grid.
      if (t && focusOf(t) && t.item.render && !t.item.src) return
      zoomOut()
      return
    }
    if (!t || t.leaving) return
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setActive(t.id)
      togglePick(t.id)
      return
    }
    zoomIn(t.id)
  }

  const typing = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    target !== root &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  const reveal = (id: string) => {
    const r = rectOf(id)
    if (!r) return
    const top = root.scrollTop
    if (r.y < top + pad) root.scrollTop = r.y - pad
    else if (r.y + r.h > top + vh - pad) root.scrollTop = r.y + r.h - vh + pad
  }
  const move = (id: string) => {
    ensure(id)
    setActive(id)
    reveal(id)
    syncWindow()
    aimWash(false)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" && typing(e.target)) return
    if (e.altKey || ((e.metaKey || e.ctrlKey) && e.key !== "Escape")) return
    const zoomed = current()
    const at = active !== null ? index.get(active) : undefined
    const dirs: Record<string, BentoDirection> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    }
    const dir = dirs[e.key]
    let handled = true
    if (dir) {
      if (zoomed) {
        if (dir === "left" || dir === "right") go(dir === "right" ? 1 : -1)
      } else if (at === undefined) {
        const first = windowOf(plan, root.scrollTop, root.scrollTop + vh).find(
          (i) => plan.rects[i]!.y >= root.scrollTop - 1,
        )
        if (items[first ?? 0]) move(items[first ?? 0]!.id)
      } else {
        const next = neighbour(plan.rects, at, dir)
        if (items[next]) move(items[next]!.id)
      }
    } else if (e.key === "Enter") {
      if (zoomed) zoomOut()
      else if (active) zoomIn(active)
      else if (items[0]) move(items[0].id)
    } else if (e.key === "Escape") {
      if (zoomed || hand) zoomOut()
      else handled = false
    } else if (e.key === " ") {
      if (active) togglePick(active)
    } else if (/^[1-9]$/.test(e.key)) {
      const it = items[Number(e.key) - 1]
      if (!it) return
      if (zoomed) zoomIn(it.id)
      else move(it.id)
    } else if (e.key === "Home" || e.key === "End") {
      const it = e.key === "Home" ? items[0] : items.at(-1)
      if (!it) return
      if (zoomed) zoomIn(it.id)
      else move(it.id)
    } else handled = false
    if (!handled) return
    e.preventDefault()
    e.stopPropagation()
    root.dataset.keyboard = ""
  }
  const onPointerMoveAny = () => {
    if (root.dataset.keyboard !== undefined) delete root.dataset.keyboard
  }
  const onScroll = () => {
    syncWindow()
    if (focuses.length) for (const f of focuses) draw(f.tile)
    drawScrim()
  }

  const togglePick = (id: string) => {
    if (picks.has(id)) picks.delete(id)
    else picks.add(id)
    tiles.get(id)?.el.setAttribute("aria-selected", String(picks.has(id)))
    options.onPick?.(orderedPicks())
  }
  const orderedPicks = () => items.filter((it) => picks.has(it.id)).map((it) => it.id)

  root.addEventListener("wheel", onWheel, { passive: false })
  root.addEventListener("gesturestart", onGesture)
  root.addEventListener("gesturechange", onGesture)
  root.addEventListener("gestureend", onGesture)
  root.addEventListener("pointerdown", onPointerDown)
  root.addEventListener("pointermove", onPointerMove)
  root.addEventListener("pointerup", onPointerUp)
  root.addEventListener("pointercancel", onPointerUp)
  root.addEventListener("mousemove", onPointerMoveAny)
  root.addEventListener("click", onClick)
  root.addEventListener("keydown", onKey)
  root.addEventListener("scroll", onScroll, { passive: true })
  root.addEventListener("knobs-restyle", () => relayout("snap"))
  let lastSize = ""
  const ro = new win.ResizeObserver(() => {
    const size = `${root.clientWidth}x${root.clientHeight}`
    if (size === lastSize || !ready) return
    lastSize = size
    relayout("glide")
  })
  ro.observe(root)

  // The first paint is the resting state: wait (briefly) for images' natural sizes.
  if (pendingProbes) {
    root.dataset.pending = ""
    win.setTimeout(start, 700)
  } else start()
  lastSize = `${root.clientWidth}x${root.clientHeight}`

  return {
    element: root,
    update(next) {
      const before: Before = { plan, index }
      const ids = new Set(next.map((it) => it.id))
      const entering = new Set(next.filter((it) => !index.has(it.id)).map((it) => it.id))
      for (const t of tiles.values()) {
        if (ids.has(t.id)) {
          if (t.leaving) {
            t.leaving = false
            drive(t.life, ENTER, 1)
          }
          t.item = next.find((it) => it.id === t.id) ?? t.item
          continue
        }
        if (t.leaving) continue
        const f = focusOf(t)
        if (f) endFocus(f)
        t.leaving = true
        drive(t.life, reduced() ? FADE : EXIT, 0)
      }
      items = next
      reindex()
      for (const it of items) probe(it)
      for (const id of picks) if (!index.has(id)) picks.delete(id)
      if (active && !index.has(active)) setActive(null)
      if (ready) relayout("glide", before, entering)
      loop.wake()
    },
    zoom(id) {
      if (id === null) zoomOut()
      else if (index.has(id)) zoomIn(id)
    },
    get zoomed() {
      return current()?.tile.id ?? null
    },
    get active() {
      return active
    },
    focus(id) {
      root.focus({ preventScroll: true })
      if (id && index.has(id)) move(id)
    },
    get picks() {
      return orderedPicks()
    },
    pick(ids) {
      picks = new Set(ids)
      for (const t of tiles.values()) t.el.setAttribute("aria-selected", String(picks.has(t.id)))
    },
    get plan() {
      return plan
    },
    get moving() {
      return loop.running
    },
    stats() {
      const s = [...times].sort((a, b) => a - b)
      const q = (p: number) => Math.round((s[Math.floor(p * (s.length - 1))] ?? 0) * 1000) / 1000
      return { frames, p50: q(0.5), p95: q(0.95), max: q(1) }
    },
    dispose() {
      loop.stop()
      ro.disconnect()
      win.clearTimeout(swipe.timer)
      if (hand) win.clearTimeout(hand.timer)
      for (const t of [...tiles.values()]) unmount(t)
      root.remove()
    },
  }
}
