import { createRemoteControls, type ControlDescriptor } from "@arcade/knobs"
import { mountPanel } from "@arcade/knobs/panel"
import { LAB_LOOK } from "../lab-knobs"

export type WatchPin = {
  sectionId: string
  key: string
  label: string
  group: string
}

const STORAGE_KEY = "arcade.lab.watch.v1"

export function loadWatchPins(): WatchPin[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (p): p is WatchPin =>
        Boolean(p) && typeof p.sectionId === "string" && typeof p.key === "string" && typeof p.label === "string" && typeof p.group === "string",
    )
  } catch {
    return []
  }
}

export function saveWatchPins(pins: readonly WatchPin[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pins))
  } catch {}
}

export function watchPinId(pin: Pick<WatchPin, "sectionId" | "key">) {
  return `${pin.sectionId}:${pin.key}`
}

/** A pinned setting now: its raw value, the text Details shows for it, and whether it differs from its default. */
export type WatchReading = {
  value: number | string
  text: string
  modified: boolean
  sectionLabel: string
  /** Formats a number the way Details does (numeric settings only). */
  format?: (value: number) => string
}

export type WatchDeps = {
  read(pin: WatchPin): WatchReading | null
  reveal(pin: WatchPin): void
  unpin(pin: WatchPin): void
}

export type WatchList = ReturnType<typeof createWatchList>

/**
 * Pinned settings over the viewport, as knobs readouts: a numeric setting is a sparkline of the values it has had, any
 * other a watch of its text. Values are pushed only when they change (`refresh`), so an idle list costs nothing per
 * frame and its rows sleep. A row's label jumps to the setting in Details; its × unpins it.
 */
export function createWatchList(host: HTMLElement, deps: WatchDeps) {
  const el = document.createElement("div")
  el.className = "lab-watch"
  el.dataset.labWatch = ""
  el.setAttribute("aria-label", "Watch")
  el.hidden = true
  host.append(el)
  const store = createRemoteControls("lab-watch", [], { storage: null, persist: "none", theme: "dark" })
  let pins: WatchPin[] = []
  let shape = ""
  let marks = ""
  const pushed = new Map<string, number | string>()
  const modified = new Set<string>()
  const removers = new Map<string, HTMLButtonElement>()

  const accessory = (key: string) => {
    const pin = pins.find(p => watchPinId(p) === key)
    if (!pin) return null
    let node = removers.get(key)
    if (!node) {
      node = document.createElement("button")
      node.type = "button"
      node.className = "lab-watch-x"
      node.setAttribute("aria-label", `Unpin ${pin.label}`)
      node.textContent = "×"
      node.onclick = () => deps.unpin(pin)
      removers.set(key, node)
    }
    node.dataset.modified = String(modified.has(key))
    return node
  }
  const panel = mountPanel(store, el, {
    title: false,
    header: false,
    ...LAB_LOOK,
    renderer: "dom",
    variants: false,
    haptics: false,
    session: false,
    rowAccessory: accessory,
  })
  // A row's label jumps to its setting in Details.
  el.addEventListener("click", event => {
    const target = event.target as HTMLElement
    if (target.closest(".knobs-accessory")) return
    const row = target.closest<HTMLElement>(".knobs-row[data-field]")
    const pin = row && pins.find(p => watchPinId(p) === row.dataset.field)
    if (pin) deps.reveal(pin)
  })

  /** Pushes each pin's value when it changed; rebuilds the rows only when the pins (or their kinds) changed. */
  function render(next: readonly WatchPin[]) {
    pins = [...next]
    const readings = pins.map(p => deps.read(p))
    // The section only shows when the pins come from more than one.
    const several = new Set(pins.map(p => p.sectionId)).size > 1
    const descriptors: ControlDescriptor[] = pins.map((pin, i) => {
      const r = readings[i]
      const key = watchPinId(pin)
      const label = several ? `${r?.sectionLabel ?? pin.sectionId} · ${pin.label}` : pin.label
      return typeof r?.value === "number"
        ? { kind: "sparkline", key, label, group: "watch", groupLabel: "Watch", history: 48, ...(r.format ? { format: r.format } : {}) }
        : { kind: "watch", key, label, group: "watch", groupLabel: "Watch" }
    })
    const nextShape = JSON.stringify(descriptors)
    if (nextShape !== shape) {
      shape = nextShape
      pushed.clear()
      for (const key of [...removers.keys()]) if (!pins.some(p => watchPinId(p) === key)) removers.delete(key)
      store.update(descriptors, {})
      el.hidden = pins.length === 0
    }
    modified.clear()
    pins.forEach((pin, i) => {
      const key = watchPinId(pin)
      const r = readings[i]
      if (r?.modified) modified.add(key)
      const value = r ? (typeof r.value === "number" ? r.value : r.text) : "—"
      if (pushed.get(key) === value) return
      pushed.set(key, value)
      store.watch(key, value)
    })
    const nextMarks = [...modified].join("|")
    if (nextMarks !== marks) {
      marks = nextMarks
      panel.updateAccessories()
    }
  }

  return {
    el,
    render,
    refresh: () => render(pins),
  }
}
