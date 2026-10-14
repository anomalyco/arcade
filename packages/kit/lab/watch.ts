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

export type WatchDeps = {
  /** Formatted current value plus whether it differs from its default. */
  read(pin: WatchPin): { text: string; modified: boolean; sectionLabel: string } | null
  reveal(pin: WatchPin): void
  unpin(pin: WatchPin): void
}

export type WatchList = ReturnType<typeof createWatchList>

/** Small on-viewport list of pinned settings with live values. */
export function createWatchList(host: HTMLElement, deps: WatchDeps) {
  const el = document.createElement("div")
  el.className = "lab-watch"
  el.dataset.labWatch = ""
  el.setAttribute("aria-label", "Watch")
  el.hidden = true
  host.append(el)
  let pins: WatchPin[] = []
  let signature = ""

  function render(next: readonly WatchPin[]) {
    pins = [...next]
    const values = pins.map(p => deps.read(p))
    const sig = JSON.stringify([pins.map(watchPinId), values])
    if (sig === signature) return
    signature = sig
    el.hidden = pins.length === 0
    el.replaceChildren()
    if (!pins.length) return
    const head = document.createElement("div")
    head.className = "lab-watch-head"
    head.innerHTML = `<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M6 2h4l-.6 4.2 2.4 2.3v1H4.2v-1l2.4-2.3z" fill="currentColor"/><path d="M8 9.5V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Watch</span><span class="lab-tcount">${pins.length}</span>`
    el.append(head)
    pins.forEach((pin, i) => {
      const v = values[i]
      const row = document.createElement("div")
      row.className = "lab-watch-row"
      row.dataset.watchKey = watchPinId(pin)
      row.dataset.modified = String(Boolean(v?.modified))
      row.dataset.stale = String(!v)
      const name = document.createElement("button")
      name.type = "button"
      name.className = "lab-watch-name"
      name.title = `Jump to ${pin.label} in Details`
      const src = document.createElement("span")
      src.className = "lab-watch-src"
      src.textContent = `${v?.sectionLabel ?? pin.sectionId} · `
      name.append(src, pin.label)
      name.onclick = () => deps.reveal(pin)
      const value = document.createElement("span")
      value.className = "lab-watch-value"
      value.textContent = v?.text ?? "—"
      const remove = document.createElement("button")
      remove.type = "button"
      remove.className = "lab-watch-x"
      remove.setAttribute("aria-label", `Unpin ${pin.label}`)
      remove.textContent = "×"
      remove.onclick = () => deps.unpin(pin)
      row.append(name, value, remove)
      el.append(row)
    })
  }

  return {
    el,
    render,
    refresh: () => render(pins),
  }
}
