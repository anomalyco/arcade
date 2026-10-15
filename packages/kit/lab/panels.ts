/**
 * Resizable workbench panels: drag handles between the viewport and the Outliner, Details, Library drawer and
 * station dock, plus the station widget slots inside the side columns. Sizes and collapsed state persist per
 * layout: the plain workbench, or each station by id (`root.dataset.station`).
 */

export type PanelId = "left" | "right" | "drawer" | "dock" | "leftSlot" | "rightSlot"
export const PANEL_IDS: readonly PanelId[] = ["left", "right", "drawer", "dock", "leftSlot", "rightSlot"]

export type PanelLayout = { sizes: Partial<Record<PanelId, number>>; collapsed: Partial<Record<PanelId, boolean>> }
export type PanelStore = { version: 1; layouts: Record<string, PanelLayout> }

export const PANELS_KEY = "arcade.lab.panels.v1"
export const WORKBENCH_LAYOUT = "workbench"
/** The viewport never gets narrower or shorter than this while a panel grows. */
export const MIN_VIEWPORT = { width: 360, height: 180 }
/** Width (or height) of the bar a collapsed panel shrinks to; matches `.lab-rail` in style.css. */
const RAIL = 22

type Bounds = { min: number; max: number }

/** Clamp a panel size to its bounds; a max below the min (tiny window) yields the min. */
export function clampPanelSize(size: number, bounds: Bounds): number {
  return Math.round(Math.max(bounds.min, Math.min(Math.max(bounds.min, bounds.max), size)))
}

/** Reads the stored layouts, keeping only finite sizes and boolean collapsed flags for known panels. */
export function parsePanelStore(raw: unknown): PanelStore {
  const store: PanelStore = { version: 1, layouts: {} }
  if (!raw || typeof raw !== "object" || (raw as PanelStore).version !== 1) return store
  const layouts = (raw as PanelStore).layouts
  if (!layouts || typeof layouts !== "object") return store
  for (const [key, layout] of Object.entries(layouts)) {
    if (!layout || typeof layout !== "object") continue
    const clean: PanelLayout = { sizes: {}, collapsed: {} }
    for (const id of PANEL_IDS) {
      const size = layout.sizes?.[id]
      if (typeof size === "number" && Number.isFinite(size) && size > 0 && size < 10000) clean.sizes[id] = Math.round(size)
      if (layout.collapsed?.[id] === true) clean.collapsed[id] = true
    }
    if (Object.keys(clean.sizes).length || Object.keys(clean.collapsed).length) store.layouts[key] = clean
  }
  return store
}

function loadStore(): PanelStore {
  try {
    return parsePanelStore(JSON.parse(localStorage.getItem(PANELS_KEY) ?? "null"))
  } catch {
    return { version: 1, layouts: {} }
  }
}

type Spec = {
  id: PanelId
  label: string
  axis: "x" | "y"
  /** +1 when dragging right/down grows the panel. */
  sign: 1 | -1
  cssVar: string
  collapsible: boolean
  /** The element whose size the handle controls. */
  target(): HTMLElement | null
  bounds(): Bounds
  /** Whether the panel is on screen; a hidden panel hides its handle. */
  shown(): boolean
}

export type PanelsDeps = {
  root: HTMLElement
  /** Drawer collapse is the Library's own open state. */
  library: { readonly open: boolean; setOpen(open: boolean): void }
  /** After any size or collapse change (drag frames included). */
  onChange?(): void
}

export type Panels = ReturnType<typeof createPanels>
/** Dispatched on the workbench root after any panel size or collapse change. */
export const PANELS_CHANGE_EVENT = "lab-panels-change"

export function createPanels(deps: PanelsDeps) {
  const { root, library } = deps
  const changed = () => {
    root.dispatchEvent(new Event(PANELS_CHANGE_EVENT))
    deps.onChange?.()
  }
  let store = loadStore()
  let layoutKey = root.dataset.station ?? WORKBENCH_LAYOUT
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)
  const outliner = q(".lab-outliner")!
  const inspector = q(".lab-inspector")!
  const libraryEl = q(".lab-library")!
  const dock = q('[data-station-slot="dock"]')!
  const leftSlot = q('[data-station-slot="left"]')!
  const rightSlot = q('[data-station-slot="right"]')!
  const rootSize = () => ({ width: root.clientWidth, height: root.clientHeight })
  const drawerBody = () => libraryEl.querySelector<HTMLElement>(".lab-drawer-body")
  const columnSpace = (col: HTMLElement, slot: HTMLElement) => col.clientHeight - (slot.offsetHeight || 0)

  const specs: Record<PanelId, Spec> = {
    left: {
      id: "left", label: "Outliner", axis: "x", sign: 1, cssVar: "--lw", collapsible: true,
      target: () => outliner,
      bounds: () => ({ min: 168, max: Math.min(560, rootSize().width - inspector.offsetWidth - MIN_VIEWPORT.width) }),
      shown: () => true,
    },
    right: {
      id: "right", label: "Details", axis: "x", sign: -1, cssVar: "--rw", collapsible: true,
      target: () => inspector,
      bounds: () => ({ min: 232, max: Math.min(680, rootSize().width - outliner.offsetWidth - MIN_VIEWPORT.width) }),
      shown: () => true,
    },
    drawer: {
      id: "drawer", label: "Library", axis: "y", sign: -1, cssVar: "--drawer-h", collapsible: true,
      target: drawerBody,
      bounds: () => ({ min: 64, max: Math.min(rootSize().height * 0.62, rootSize().height - 34 - 22 - 28 - dock.offsetHeight - MIN_VIEWPORT.height) }),
      shown: () => true,
    },
    dock: {
      id: "dock", label: "Station dock", axis: "y", sign: -1, cssVar: "--dock-h", collapsible: true,
      target: () => dock,
      bounds: () => ({ min: 72, max: Math.min(rootSize().height * 0.5, rootSize().height - 34 - 22 - libraryEl.offsetHeight - MIN_VIEWPORT.height) }),
      shown: () => !dock.hidden,
    },
    leftSlot: {
      id: "leftSlot", label: "Station widgets (left)", axis: "y", sign: 1, cssVar: "--slot-left-h", collapsible: false,
      target: () => leftSlot,
      bounds: () => ({ min: 48, max: leftSlot.offsetHeight + columnSpace(outliner, leftSlot) - 120 }),
      shown: () => !leftSlot.hidden && !isCollapsed("left"),
    },
    rightSlot: {
      id: "rightSlot", label: "Station widgets (right)", axis: "y", sign: 1, cssVar: "--slot-right-h", collapsible: false,
      target: () => rightSlot,
      bounds: () => ({ min: 60, max: rightSlot.offsetHeight + columnSpace(inspector, rightSlot) - 140 }),
      shown: () => !rightSlot.hidden && !isCollapsed("right"),
    },
  }

  const layout = (): PanelLayout => (store.layouts[layoutKey] ??= { sizes: {}, collapsed: {} })
  const dataKey = (id: PanelId) => `collapsed${id[0]!.toUpperCase()}${id.slice(1)}`

  function isCollapsed(id: PanelId): boolean {
    if (id === "drawer") return !library.open
    return root.dataset[dataKey(id)] === "true"
  }

  function persist() {
    for (const [key, l] of Object.entries(store.layouts)) {
      if (!Object.keys(l.sizes).length && !Object.keys(l.collapsed).length) delete store.layouts[key]
    }
    try {
      localStorage.setItem(PANELS_KEY, JSON.stringify(store))
    } catch {}
  }

  /** Writes a size as the panel's CSS variable; null returns it to the stylesheet's default. */
  function writeSize(id: PanelId, size: number | null) {
    const spec = specs[id]
    if (size === null) root.style.removeProperty(spec.cssVar)
    else root.style.setProperty(spec.cssVar, `${size}px`)
  }

  function writeCollapsed(id: PanelId, collapsed: boolean) {
    if (id === "drawer") {
      if (library.open === collapsed) library.setOpen(!collapsed)
      return
    }
    if (collapsed) root.dataset[dataKey(id)] = "true"
    else delete root.dataset[dataKey(id)]
    rails[id]?.setAttribute("aria-expanded", String(!collapsed))
  }

  // Handles. Column and dock handles are absolutely positioned grid children placed on their panel's grid area;
  // slot handles are flex siblings right under their slot.
  const handles = {} as Record<PanelId, HTMLElement>
  const rails: Partial<Record<PanelId, HTMLButtonElement>> = {}
  for (const id of PANEL_IDS) {
    const spec = specs[id]
    const h = document.createElement("div")
    h.className = "lab-splitter"
    h.dataset.splitter = id
    h.dataset.axis = spec.axis
    h.tabIndex = 0
    h.setAttribute("role", "separator")
    h.setAttribute("aria-orientation", spec.axis === "x" ? "vertical" : "horizontal")
    h.setAttribute("aria-label", `Resize ${spec.label}`)
    h.title = `Drag to resize ${spec.label} · double-click to reset${spec.collapsible ? " · Enter collapses" : ""}`
    if (spec.collapsible) {
      const b = document.createElement("button")
      b.type = "button"
      b.className = "lab-splitter-btn"
      b.tabIndex = -1
      b.setAttribute("aria-label", `Collapse ${spec.label}`)
      b.addEventListener("pointerdown", e => e.stopPropagation())
      b.addEventListener("click", e => {
        e.stopPropagation()
        setCollapsed(id, !isCollapsed(id))
      })
      h.append(b)
    }
    bindDrag(h, spec)
    handles[id] = h
    if (id === "leftSlot") leftSlot.after(h)
    else if (id === "rightSlot") rightSlot.after(h)
    else root.append(h)
  }
  // Thin bars a collapsed side column or dock shrinks to; click to expand.
  for (const id of ["left", "right", "dock"] as const) {
    const spec = specs[id]
    const rail = document.createElement("button")
    rail.type = "button"
    rail.className = "lab-rail"
    rail.dataset.rail = id
    rail.setAttribute("aria-expanded", "true")
    rail.setAttribute("aria-label", `Expand ${spec.label}`)
    rail.title = `Expand ${spec.label}`
    rail.innerHTML = `<span>${spec.label}</span>`
    rail.onclick = () => setCollapsed(id, false)
    rails[id] = rail
    root.append(rail)
  }

  function syncHandles() {
    for (const id of PANEL_IDS) {
      const shown = specs[id].shown()
      if (handles[id].hidden === shown) handles[id].hidden = !shown
      handles[id].dataset.collapsed = String(isCollapsed(id))
      const btn = handles[id].querySelector("button")
      btn?.setAttribute("aria-label", `${isCollapsed(id) ? "Expand" : "Collapse"} ${specs[id].label}`)
    }
  }

  function apply() {
    const l = store.layouts[layoutKey]
    for (const id of PANEL_IDS) {
      writeSize(id, l?.sizes[id] ?? null)
      if (id !== "drawer") writeCollapsed(id, Boolean(l?.collapsed[id]))
    }
    syncHandles()
    changed()
  }

  function setSize(id: PanelId, size: number | null, save = true) {
    if (size === null) {
      delete layout().sizes[id]
      writeSize(id, null)
    } else {
      const next = clampPanelSize(size, specs[id].bounds())
      layout().sizes[id] = next
      writeSize(id, next)
    }
    if (save) persist()
    changed()
  }

  function setCollapsed(id: PanelId, collapsed: boolean, save = true) {
    if (!specs[id].collapsible) return
    writeCollapsed(id, collapsed)
    if (id !== "drawer") {
      if (collapsed) layout().collapsed[id] = true
      else delete layout().collapsed[id]
      if (save) persist()
    }
    syncHandles()
    changed()
  }

  function reset(id?: PanelId) {
    for (const p of id ? [id] : PANEL_IDS) {
      delete layout().sizes[p]
      writeSize(p, null)
      if (p !== "drawer" && specs[p].collapsible) {
        delete layout().collapsed[p]
        writeCollapsed(p, false)
      }
    }
    persist()
    syncHandles()
    changed()
  }

  function currentSize(spec: Spec): number {
    const el = spec.target()
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return spec.axis === "x" ? r.width : r.height
  }

  function bindDrag(h: HTMLElement, spec: Spec) {
    let drag: { start: number; size: number; bounds: Bounds; pointer: number } | null = null
    let pending: number | null = null
    let raf = 0
    const flush = () => {
      raf = 0
      if (!drag || pending === null) return
      const raw = pending
      pending = null
      // Dragging well past the minimum collapses a collapsible panel; dragging back out expands it.
      const collapse = spec.collapsible && raw < drag.bounds.min - 48
      if (collapse !== isCollapsed(spec.id)) setCollapsed(spec.id, collapse, false)
      if (!collapse) {
        const next = clampPanelSize(raw, drag.bounds)
        layout().sizes[spec.id] = next
        writeSize(spec.id, next)
        changed()
      }
    }
    h.addEventListener("pointerdown", e => {
      if (e.button !== 0) return
      e.preventDefault()
      const collapsedAtStart = isCollapsed(spec.id)
      // A closed Library opens at its last height under the pointer; a collapsed bar grows from its rail.
      if (collapsedAtStart && spec.id === "drawer") library.setOpen(true)
      drag = {
        start: spec.axis === "x" ? e.clientX : e.clientY,
        size: collapsedAtStart && spec.id !== "drawer" ? RAIL : currentSize(spec),
        bounds: spec.bounds(),
        pointer: e.pointerId,
      }
      h.setPointerCapture(e.pointerId)
      root.dataset.resizing = spec.axis
      h.dataset.active = "true"
    })
    h.addEventListener("pointermove", e => {
      if (!drag || e.pointerId !== drag.pointer) return
      const delta = (spec.axis === "x" ? e.clientX : e.clientY) - drag.start
      pending = drag.size + spec.sign * delta
      if (!raf) raf = requestAnimationFrame(flush)
    })
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointer) return
      if (raf) {
        cancelAnimationFrame(raf)
        flush()
      }
      drag = null
      delete root.dataset.resizing
      delete h.dataset.active
      persist()
      syncHandles()
    }
    h.addEventListener("pointerup", end)
    h.addEventListener("pointercancel", end)
    h.addEventListener("lostpointercapture", end)
    h.addEventListener("dblclick", e => {
      e.preventDefault()
      reset(spec.id)
    })
    h.addEventListener("keydown", e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const back = spec.axis === "x" ? "ArrowLeft" : "ArrowUp"
      const fwd = spec.axis === "x" ? "ArrowRight" : "ArrowDown"
      const step = e.shiftKey ? 64 : 16
      const size = isCollapsed(spec.id) ? specs[spec.id].bounds().min : currentSize(spec)
      let handled = true
      if (e.key === back || e.key === fwd) {
        if (isCollapsed(spec.id)) setCollapsed(spec.id, false)
        setSize(spec.id, size + spec.sign * (e.key === fwd ? step : -step))
      } else if (e.key === "Home") setSize(spec.id, spec.bounds().min)
      else if (e.key === "End") setSize(spec.id, spec.bounds().max)
      else if (e.key === "Enter" && spec.collapsible) setCollapsed(spec.id, !isCollapsed(spec.id))
      else if (e.key === "Escape") {
        h.blur()
        root.querySelector<HTMLCanvasElement>(".lab-viewport canvas")?.focus({ preventScroll: true })
      } else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
        updateAria(spec)
      }
    })
    h.addEventListener("focus", () => updateAria(spec))
  }

  function updateAria(spec: Spec) {
    const b = spec.bounds()
    const h = handles[spec.id]
    h.setAttribute("aria-valuemin", String(Math.round(b.min)))
    h.setAttribute("aria-valuemax", String(Math.round(Math.max(b.min, b.max))))
    h.setAttribute("aria-valuenow", String(Math.round(isCollapsed(spec.id) ? 0 : currentSize(spec))))
  }

  // A station opening or closing switches to its layout.
  const stationObserver = new MutationObserver(() => {
    const next = root.dataset.station ?? WORKBENCH_LAYOUT
    if (next === layoutKey) return
    layoutKey = next
    apply()
  })
  stationObserver.observe(root, { attributes: true, attributeFilter: ["data-station"] })
  // Slots and the dock appear with a station; their handles follow.
  const slotObserver = new MutationObserver(() => {
    syncHandles()
    changed()
  })
  for (const el of [dock, leftSlot, rightSlot]) slotObserver.observe(el, { attributes: true, attributeFilter: ["hidden"] })

  // A smaller window clamps stored sizes for display without forgetting them.
  let lastRoot = { width: 0, height: 0 }
  const rootObserver = new ResizeObserver(entries => {
    const box = entries[0]?.contentRect
    if (!box) return
    const shrank = box.width < lastRoot.width || box.height < lastRoot.height
    lastRoot = { width: box.width, height: box.height }
    if (!shrank) return
    const l = store.layouts[layoutKey]
    if (!l) return
    for (const id of PANEL_IDS) {
      const stored = l.sizes[id]
      if (stored !== undefined) writeSize(id, clampPanelSize(stored, specs[id].bounds()))
    }
  })
  rootObserver.observe(root)

  apply()

  return {
    get layoutKey() {
      return layoutKey
    },
    handles,
    setSize: (id: PanelId, size: number | null) => setSize(id, size),
    setCollapsed: (id: PanelId, collapsed: boolean) => setCollapsed(id, collapsed),
    isCollapsed,
    reset,
    /** The persisted sizes and collapsed state for the current layout, and the rendered sizes. */
    state() {
      const l = store.layouts[layoutKey]
      const rendered: Partial<Record<PanelId, number>> = {}
      for (const id of PANEL_IDS) if (specs[id].shown() && !isCollapsed(id)) rendered[id] = Math.round(currentSize(specs[id]))
      return {
        layout: layoutKey,
        sizes: { ...(l?.sizes ?? {}) },
        collapsed: Object.fromEntries(PANEL_IDS.filter(id => specs[id].collapsible).map(id => [id, isCollapsed(id)])),
        rendered,
      }
    },
    sync: syncHandles,
    dispose() {
      stationObserver.disconnect()
      slotObserver.disconnect()
      rootObserver.disconnect()
    },
  }
}
