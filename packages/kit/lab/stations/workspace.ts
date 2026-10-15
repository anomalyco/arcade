import type { LabCommandInvokeResult, LabCommandRegistry } from "../../lab-commands"
import type { LabPanel } from "../../lab-panel"
import type { Stage } from "../stage"
import { addWidget, featuredGroups, findWidget, moveWidget, nudgeWidget, parseLayout, removeWidget, resolveLayout, saveLayout, savedLayout, stationLayout, toStationLayout, updateWidget, type GroupInfo, type PlacedWidget, type ResolvedLayout } from "./layout"
import { STATION_SLOTS, STATUS_LABEL, WIDGET_KINDS, orderStations, type LabStation, type StationCommand, type StationEvent, type StationSlot, type StationSnapshot, type StationVariant, type StationWidgetKind } from "./types"
import { renderWidget, WIDGET_HINTS, WIDGET_TITLES, type StationChanges, type WidgetContext, type WidgetInstance } from "./widgets"
import "./style.css"

/** What stations need from the Lab page. */
export type StationHost = {
  stage: Stage
  viewport: HTMLElement
  canvas: HTMLCanvasElement
  /** The workbench root (`data-station` and edit state go here) and the slots it reserves for stations. */
  root: HTMLElement
  slots: { list: HTMLElement; left: HTMLElement; right: HTMLElement; dock: HTMLElement }
  panel: LabPanel
  commands: LabCommandRegistry
  hasSection(id: string): boolean
  /** The section's Details groups in order with their tuning-slider counts, for controls widgets. */
  groups(section: string): GroupInfo[]
  activeSection(): string
  select(id: string): void
  onSection(listener: (id: string) => void): void
  invoke(id: string, args?: Record<string, unknown>): LabCommandInvokeResult
  suspend(value: boolean): void
  mode(): "edit" | "play" | undefined
  /** Number keys from the workbench (outside text fields, Play, the grid and the radial): true if used. */
  onDigit(handler: (n: number, shift: boolean) => boolean): void
  /** Loads a game's Lab adapters on demand; resolves false when the game has none. */
  ensureGame(game: string): Promise<boolean>
  libraryOpen(): boolean
}

/** Dev-server extras: recent git activity and the voice-note recorder. Absent in production builds. */
export type StationDev = {
  changes(station: LabStation): Promise<StationChanges | null>
  toggleNote?(): boolean
  noteActive?(): boolean
}

export type { StationChanges } from "./widgets"

const hex = (n: number | undefined) => (n === undefined ? "#4d8dff" : `#${n.toString(16).padStart(6, "0")}`)
const html = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const SLOT_LABEL: Record<StationSlot, string> = { left: "Left", right: "Right", dock: "Dock" }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  parent?.append(e)
  return e
}

/**
 * Stations as workspaces inside the Lab: a station runs its section and setup, then lays its widgets out around the
 * viewport (Outliner column, top of Details, a dock under the viewport). Kit rearranges and configures widgets with
 * ✎; the layout is saved per station in this browser and can be copied into the station file.
 */
export function createStations(opts: { host: StationHost; stations: readonly LabStation[]; dev?: StationDev; storage?: Storage | null }) {
  const { host } = opts
  const storage = opts.storage === undefined ? (() => { try { return localStorage } catch { return null } })() : opts.storage
  const ordered = orderStations(opts.stations)
  const byId = new Map(ordered.map(o => [o.station.id, o]))
  const listeners = new Set<(e: StationEvent) => void>()
  const emit = (e: StationEvent) => { for (const l of listeners) l(e) }

  let current: LabStation | null = null
  let variant: StationVariant | null = null
  let missing: string | null = null
  let layout: ResolvedLayout | null = null
  let editing = false
  let abPending = false
  let opening = 0
  let libraryWasOpen: boolean | null = null
  let selecting = false
  const instances = new Map<string, WidgetInstance>()
  const frameTimes: number[] = []

  // ── station list (top of the Outliner) ─────────────────────────────────────────────────────────────────────────────
  const list = host.slots.list
  list.hidden = ordered.length === 0
  const head = el("div", "ls-list-head", list)
  const headTitle = el("button", "ls-list-title", head)
  headTitle.type = "button"
  const headTools = el("span", "ls-list-tools", head)
  const editBtn = el("button", "ls-icon", headTools, "✎")
  editBtn.type = "button"
  editBtn.title = "Edit this station's layout"
  editBtn.setAttribute("aria-label", "Edit station layout")
  const closeBtn = el("button", "ls-icon", headTools, "✕")
  closeBtn.type = "button"
  closeBtn.title = "Close the station"
  closeBtn.setAttribute("aria-label", "Close station")
  const chips = el("div", "ls-stations", list)
  const chipEls = new Map<string, HTMLButtonElement>()
  for (const { station, key } of ordered) {
    const b = el("button", "ls-station", chips)
    b.type = "button"
    b.dataset.station = station.id
    b.style.setProperty("--c", hex(station.color))
    b.innerHTML = `${key ? `<kbd>${key}</kbd>` : "<kbd></kbd>"}<span>${html(station.title)}</span><i data-status="${station.status}" title="${STATUS_LABEL[station.status]}"></i>`
    b.title = `${station.title} · ${STATUS_LABEL[station.status]}${key ? ` · ${key}` : ""}`
    b.addEventListener("click", () => void open(station.id))
    chipEls.set(station.id, b)
  }
  let listFolded = storage?.getItem("arcade.lab.stations-folded") === "true"
  headTitle.addEventListener("click", () => {
    listFolded = !listFolded
    try { storage?.setItem("arcade.lab.stations-folded", String(listFolded)) } catch { /* private */ }
    renderList()
  })
  editBtn.addEventListener("click", () => setEditing(!editing))
  closeBtn.addEventListener("click", () => close())

  function renderList() {
    const key = current ? byId.get(current.id)?.key : null
    headTitle.innerHTML = `<span class="ls-caret">${listFolded ? "▸" : "▾"}</span><b>Stations</b>${current ? `<span class="ls-current">${key ? `<kbd>${key}</kbd>` : ""}${html(current.title)}</span>` : `<span class="ls-dim">${ordered.length}</span>`}`
    headTitle.setAttribute("aria-expanded", String(!listFolded))
    chips.hidden = listFolded
    editBtn.hidden = closeBtn.hidden = !current
    editBtn.dataset.active = String(editing)
    for (const [id, b] of chipEls) b.dataset.active = String(id === current?.id)
  }

  // ── toast and page demos (in the viewport) ─────────────────────────────────────────────────────────────────────────
  const toast = el("div", "ls-toast", host.viewport)
  toast.hidden = true
  let toastTimer = 0
  function say(text: string, error = false) {
    toast.textContent = text
    toast.dataset.error = String(error)
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => { toast.hidden = true }, error ? 6000 : 3200)
  }
  const page = el("div", "ls-page", host.viewport)
  page.dataset.stationPage = ""
  page.hidden = true

  // ── widgets ────────────────────────────────────────────────────────────────────────────────────────────────────
  const slotEl = (slot: StationSlot) => host.slots[slot]

  const context = (station: LabStation): WidgetContext => ({
    station,
    section: station.demo.kind === "section" && !missing ? station.demo.section : null,
    missing,
    panel: host.panel,
    variant: () => variant,
    chooseVariant,
    invoke: (command, args) => {
      const res = host.invoke(command, args)
      return res.ok ? { ok: true } : { ok: false, error: res.error }
    },
    say,
    live,
    changes: opts.dev ? () => opts.dev!.changes(station) : null,
    note: opts.dev?.toggleNote ? { toggle: () => void opts.dev!.toggleNote!(), active: () => Boolean(opts.dev!.noteActive?.()) } : null,
    storage,
    abPending: { get: () => abPending, set: on => { abPending = on } },
  })

  function disposeWidgets() {
    for (const instance of instances.values()) instance.dispose?.()
    instances.clear()
    for (const slot of STATION_SLOTS) slotEl(slot).replaceChildren()
  }

  function renderLayout() {
    disposeWidgets()
    const station = current
    if (!station || !layout) {
      for (const slot of STATION_SLOTS) slotEl(slot).hidden = true
      return
    }
    const ctx = context(station)
    for (const slot of STATION_SLOTS) {
      const container = slotEl(slot)
      container.dataset.slot = slot
      for (const widget of layout[slot]) container.append(card(widget, slot, ctx))
      if (editing) container.append(addButton(slot))
      container.hidden = !editing && layout[slot].length === 0
    }
    if (editing) slotEl("dock").prepend(editBar())
  }

  function card(widget: PlacedWidget, slot: StationSlot, ctx: WidgetContext) {
    const section = el("section", "ls-card")
    section.dataset.widget = widget.widget
    section.dataset.widgetId = widget.id
    section.style.setProperty("--c", hex(ctx.station.color))
    const top = el("header", "ls-card-head", section)
    el("span", "ls-card-title", top, widget.title ?? WIDGET_TITLES[widget.widget])
    if (editing) {
      const tools = el("span", "ls-card-tools", top)
      const grip = el("span", "ls-grip", tools, "⠿")
      grip.title = "Drag to move"
      section.draggable = true
      section.addEventListener("dragstart", e => {
        e.dataTransfer?.setData("text/x-station-widget", widget.id)
        e.dataTransfer!.effectAllowed = "move"
        section.dataset.dragging = "true"
      })
      section.addEventListener("dragend", () => { delete section.dataset.dragging })
      const more = el("button", "ls-icon", tools, "⋯")
      more.type = "button"
      more.setAttribute("aria-label", `${WIDGET_TITLES[widget.widget]} options`)
      more.addEventListener("click", e => { e.stopPropagation(); menu(more, widget, slot) })
    }
    const body = el("div", "ls-card-body", section)
    try { instances.set(widget.id, renderWidget(body, widget, ctx)) }
    catch (error) { body.innerHTML = `<p class="ls-missing">${html(String(error))}</p>` }
    return section
  }

  // ── layout editing ─────────────────────────────────────────────────────────────────────────────────────────────
  function setEditing(on: boolean) {
    editing = on && Boolean(current)
    host.root.toggleAttribute("data-station-editing", editing)
    closeMenu()
    renderList()
    renderLayout()
  }

  function commit(next: ResolvedLayout) {
    if (!current) return
    layout = next
    saveLayout(storage, current.id, toStationLayout(next))
    renderLayout()
  }

  function editBar() {
    const bar = el("div", "ls-editbar")
    const saved = current && savedLayout(storage, current.id)
    el("span", "ls-dim", bar, saved ? "Layout saved in this browser" : current?.layout ? "Layout from the station file" : "Default layout")
    bar.append(
      Object.assign(el("button", "ls-btn", undefined, "Copy JSON"), {
        type: "button",
        title: "Copy the layout block for this station's file",
        onclick: () => void navigator.clipboard.writeText(JSON.stringify(toStationLayout(layout!), null, 2)).then(() => say("Layout copied. Paste it as `layout` in the station file."), () => say("Clipboard unavailable", true)),
      }),
      Object.assign(el("button", "ls-btn", undefined, "Reset"), {
        type: "button",
        title: "Forget this browser's edits and use the station file's layout",
        onclick: () => { if (!current) return; saveLayout(storage, current.id, null); layout = stationLayout(current, groupsOf(current), storage); renderLayout() },
      }),
      Object.assign(el("button", "ls-btn ls-primary", undefined, "Done"), { type: "button", onclick: () => setEditing(false) }),
    )
    return bar
  }

  function addButton(slot: StationSlot) {
    const b = el("button", "ls-add", undefined, "+ Widget")
    b.type = "button"
    b.addEventListener("click", e => {
      e.stopPropagation()
      const items = WIDGET_KINDS.map(kind => ({ label: WIDGET_TITLES[kind], hint: WIDGET_HINTS[kind], run: () => add(kind, slot) }))
      openMenu(b, items)
    })
    return b
  }

  function add(kind: StationWidgetKind, slot: StationSlot) {
    if (!layout || !current) return
    const groups = kind === "controls" ? groupsOf(current).slice(0, 1) : undefined
    commit(addWidget(layout, { widget: kind, ...(groups?.length ? { groups } : {}) }, slot))
  }

  function menu(anchor: HTMLElement, widget: PlacedWidget, slot: StationSlot) {
    if (!layout) return
    const at = findWidget(layout, widget.id)
    openMenu(anchor, [
      ...STATION_SLOTS.filter(s => s !== slot).map(s => ({ label: `Move to ${SLOT_LABEL[s]}`, run: () => commit(moveWidget(layout!, widget.id, s)) })),
      ...(at && at.index > 0 ? [{ label: "Move earlier", run: () => commit(nudgeWidget(layout!, widget.id, -1)) }] : []),
      ...(at && at.index < layout[slot].length - 1 ? [{ label: "Move later", run: () => commit(nudgeWidget(layout!, widget.id, 1)) }] : []),
      { label: "Configure…", run: () => configure(widget) },
      { label: "Remove", run: () => commit(removeWidget(layout!, widget.id)) },
    ])
  }

  let menuEl: HTMLElement | null = null
  function closeMenu() { menuEl?.remove(); menuEl = null }
  function openMenu(anchor: HTMLElement, items: { label: string; hint?: string; run: () => void }[]) {
    closeMenu()
    const m = el("div", "ls-menu", document.body)
    m.setAttribute("role", "menu")
    for (const item of items) {
      const b = el("button", "ls-menu-item", m)
      b.type = "button"
      b.setAttribute("role", "menuitem")
      b.innerHTML = `<span>${html(item.label)}</span>${item.hint ? `<small>${html(item.hint)}</small>` : ""}`
      b.addEventListener("click", () => { closeMenu(); item.run() })
    }
    const r = anchor.getBoundingClientRect()
    m.style.left = `${Math.max(8, Math.min(innerWidth - 248, r.left))}px`
    m.style.top = `${Math.min(innerHeight - m.offsetHeight - 8, r.bottom + 4)}px`
    menuEl = m
    m.querySelector<HTMLButtonElement>("button")?.focus()
  }
  document.addEventListener("pointerdown", e => { if (menuEl && !menuEl.contains(e.target as Node)) closeMenu() }, { capture: true })
  document.addEventListener("keydown", e => { if (menuEl && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu() } }, { capture: true })

  function configure(widget: PlacedWidget) {
    if (!current) return
    const back = el("div", "ls-dialog-back", document.body)
    const dialog = el("div", "ls-dialog", back)
    dialog.setAttribute("role", "dialog")
    dialog.setAttribute("aria-label", `Configure ${WIDGET_TITLES[widget.widget]}`)
    el("h3", "", dialog, `${WIDGET_TITLES[widget.widget]} widget`)
    const titleRow = el("label", "ls-field", dialog)
    el("span", "", titleRow, "Title")
    const title = el("input", "", titleRow)
    title.type = "text"
    title.value = widget.title ?? ""
    title.placeholder = WIDGET_TITLES[widget.widget]
    const picks: HTMLInputElement[] = []
    if (widget.widget === "controls") {
      el("p", "ls-dim", dialog, "Details groups to show, in this order:")
      const box = el("div", "ls-checks", dialog)
      const chosen = new Set(widget.groups ?? [])
      const all = [...new Set([...(widget.groups ?? []), ...allGroups(current).map(g => g.name)])]
      for (const group of all) {
        const row = el("label", "ls-check", box)
        const input = el("input", "", row)
        input.type = "checkbox"
        input.value = group
        input.checked = chosen.has(group)
        el("span", "", row, group)
        picks.push(input)
      }
    }
    const foot = el("div", "ls-dialog-foot", dialog)
    const done = () => { back.remove(); host.canvas.focus({ preventScroll: true }) }
    const save = el("button", "ls-btn ls-primary", foot, "Save")
    save.type = "button"
    save.onclick = () => {
      if (!layout) return done()
      const groups = picks.filter(p => p.checked).map(p => p.value)
      commit(updateWidget(layout, widget.id, { title: title.value.trim() || undefined, ...(widget.widget === "controls" ? { groups } : {}) }))
      done()
    }
    const cancel = el("button", "ls-btn", foot, "Cancel")
    cancel.type = "button"
    cancel.onclick = done
    back.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done() }
      else if (e.key === "Enter" && e.target === title) { e.preventDefault(); save.click() }
    })
    title.focus()
  }

  // Drag and drop between slots: the drop lands before the card under the pointer.
  for (const slot of STATION_SLOTS) {
    const container = slotEl(slot)
    container.addEventListener("dragover", e => {
      if (!editing || !e.dataTransfer?.types.includes("text/x-station-widget")) return
      e.preventDefault()
      container.dataset.drop = "true"
    })
    container.addEventListener("dragleave", e => { if (!container.contains(e.relatedTarget as Node)) delete container.dataset.drop })
    container.addEventListener("drop", e => {
      delete container.dataset.drop
      const id = e.dataTransfer?.getData("text/x-station-widget")
      if (!editing || !id || !layout) return
      e.preventDefault()
      const cards = [...container.querySelectorAll<HTMLElement>(".ls-card:not([data-dragging])")]
      const horizontal = slot === "dock"
      const index = cards.findIndex(c => {
        const r = c.getBoundingClientRect()
        return horizontal ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2
      })
      commit(moveWidget(layout, id, slot, index < 0 ? cards.length : index))
    })
  }

  // ── opening and closing ────────────────────────────────────────────────────────────────────────────────────────
  function allGroups(station: LabStation): GroupInfo[] {
    return station.demo.kind === "section" && host.hasSection(station.demo.section) ? host.groups(station.demo.section) : []
  }
  /** The groups a default controls card shows. */
  const groupsOf = (station: LabStation) => featuredGroups(allGroups(station))

  function runCommands(commands: readonly StationCommand[] | undefined, label: string) {
    for (const step of commands ?? []) {
      const res = host.invoke(step.command, step.args)
      if (!res.ok) { say(`${label}: ${step.command} failed: ${res.error}`, true); return false }
    }
    return true
  }

  function applyCamera(station: LabStation) {
    if (station.demo.kind !== "section" || !station.demo.camera) return
    const { stage } = host
    const c = station.demo.camera, deg = Math.PI / 180, t = c.target
    if (t) { stage.focus[0] = t[0]; stage.focus[1] = t[1]; stage.focus[2] = t[2] }
    if (c.yaw !== undefined) stage.camYaw = c.yaw * deg
    if (c.pitch !== undefined) stage.camPitch = c.pitch * deg
    if (c.distance !== undefined) stage.camDist = c.distance
    stage.camCustom = true
    stage.hasDampedTarget = false
    stage.updateCamera()
  }

  type FrameRuntime = { invokeLocal(command: string, args?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> }
  /** The embedded page's dev-control runtime, when the page is served by the dev router. */
  async function frameRuntime(timeoutMs = 6000): Promise<FrameRuntime | null> {
    const frame = page.querySelector("iframe")
    for (const start = performance.now(); frame && performance.now() - start < timeoutMs;) {
      const rt = (frame.contentWindow as unknown as { __arcadeDevControl?: Partial<FrameRuntime> } | null)?.__arcadeDevControl
      if (rt?.invokeLocal && frame.contentDocument?.readyState === "complete") return rt as FrameRuntime
      await new Promise(done => setTimeout(done, 150))
    }
    return null
  }
  async function runInFrame(commands: readonly StationCommand[] | undefined, label: string) {
    if (!commands?.length) return
    const rt = await frameRuntime()
    if (!rt) return
    await new Promise(done => setTimeout(done, 300))
    for (const step of commands) {
      const res = await rt.invokeLocal(step.command, step.args)
      if (!res.ok) { say(`${label}: ${step.command} failed: ${res.error ?? "unavailable"}`, true); return }
    }
  }
  /** Keys pressed inside an embedded page still reach the station: number keys, ⇧ variants and N. */
  function forwardKeys(frame: HTMLIFrameElement) {
    frame.addEventListener("load", () => {
      frame.contentWindow?.addEventListener("keydown", e => {
        const t = e.composedPath()[0]
        if (e.metaKey || e.ctrlKey || e.altKey || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
        const n = /^Digit[0-9]$/.test(e.code) ? Number(e.code.slice(5)) : null
        // A page lists the physical keys it binds itself (`<html data-page-keys="KeyN">`); those stay with the page.
        const owned = frame.contentDocument?.documentElement.dataset.pageKeys?.split(" ").includes(e.code)
        if (n !== null && digit(n, e.shiftKey)) e.preventDefault()
        else if (e.key.toLowerCase() === "n" && !owned && !e.repeat && opts.dev?.toggleNote) { e.preventDefault(); opts.dev.toggleNote() }
        else if (e.key === "Escape" && opts.dev?.noteActive?.()) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape" }))
      }, { capture: true })
    })
  }
  /** A picture of the embedded page for voice notes; false when no page station is showing. */
  async function capturePage(target: HTMLCanvasElement): Promise<boolean> {
    if (page.hidden) return false
    const rt = await frameRuntime(1000)
    const res = rt ? await rt.invokeLocal("screenshot", { maxSize: 1280, raw: true }) : null
    const url = (res?.result as { dataUrl?: string } | undefined)?.dataUrl
    if (!url) return false
    const img = new Image()
    await new Promise(done => { img.onload = done; img.onerror = done; img.src = url })
    target.width = img.naturalWidth || 1
    target.height = img.naturalHeight || 1
    target.getContext("2d")!.drawImage(img, 0, 0)
    return true
  }
  function closePage() {
    if (page.hidden) return
    page.replaceChildren()
    page.hidden = true
    host.suspend(false)
  }

  function syncUrl() {
    const params = new URLSearchParams(location.search)
    params.delete("overworld")
    if (current) params.set("station", current.id)
    else params.delete("station")
    const query = params.toString()
    history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`)
  }

  /** Opens a station in place: its section and setup run, then its widgets fill their slots. */
  async function open(id: string) {
    const entry = byId.get(id) ?? ordered.find(o => o.station.title.toLowerCase() === id.toLowerCase())
    if (!entry) { say(`No station "${id}"`, true); return false }
    const station = entry.station
    const token = ++opening
    closeMenu()
    closePage()
    disposeWidgets()
    missing = null
    variant = null
    abPending = false
    if (station.demo.kind === "section") {
      const { section, game } = station.demo
      if (!host.hasSection(section) && game) {
        say(`Loading ${game} adapters…`)
        await host.ensureGame(game)
        if (token !== opening) return false
      }
      if (!host.hasSection(section)) missing = section
      else {
        selecting = true
        try { host.select(section) } finally { selecting = false }
        applyCamera(station)
        runCommands(station.demo.setup, station.title)
        variant = station.variants?.find(v => v.id === station.defaultVariant) ?? null
      }
    } else {
      host.suspend(true)
      const frame = document.createElement("iframe")
      frame.src = station.demo.url
      frame.title = station.title
      frame.allow = "autoplay; fullscreen"
      forwardKeys(frame)
      page.replaceChildren(frame)
      page.hidden = false
      variant = station.variants?.find(v => v.id === station.defaultVariant) ?? null
      void runInFrame(variant?.setup, station.title)
    }
    const first = !current
    current = station
    if (first) libraryWasOpen = host.libraryOpen()
    if (host.libraryOpen()) host.invoke("library.toggle", { open: false })
    host.root.dataset.station = station.id
    layout = stationLayout(station, groupsOf(station), storage)
    renderList()
    renderLayout()
    syncUrl()
    emit({ kind: "station", station: station.id })
    return true
  }

  /** Back to the plain workbench: widgets go, the Library comes back if it was open. */
  function close() {
    if (!current) return
    opening++
    closeMenu()
    closePage()
    disposeWidgets()
    if (editing) { editing = false; host.root.removeAttribute("data-station-editing") }
    current = null
    variant = null
    missing = null
    layout = null
    abPending = false
    delete host.root.dataset.station
    for (const slot of STATION_SLOTS) slotEl(slot).hidden = true
    if (libraryWasOpen) host.invoke("library.toggle", { open: true })
    libraryWasOpen = null
    renderList()
    syncUrl()
    emit({ kind: "station", station: null })
  }

  function chooseVariant(v: StationVariant) {
    if (!current) return
    if (current.demo.kind === "page") {
      const frame = page.querySelector("iframe")
      if (frame && v.url && frame.getAttribute("src") !== v.url) frame.src = v.url
      void runInFrame(v.setup, v.label)
    } else if (!runCommands(v.setup, v.label)) return
    variant = v
    if (abPending && current.demo.kind === "section") {
      abPending = false
      const res = host.invoke("compare.wipe")
      if (res.ok) say(`A/B wipe: A is the pinned state, B is ${v.label}`)
      else say(res.error, true)
    }
    for (const instance of instances.values()) instance.refresh?.()
    emit({ kind: "variant", station: current.id, variant: v.id })
  }

  /** Number keys open stations; ⇧ with a number picks the open station's variant. */
  function digit(n: number, shift: boolean) {
    if (host.mode() === "play") return false
    if (shift) {
      const v = current?.variants?.[n === 0 ? 9 : n - 1]
      if (!v) return false
      chooseVariant(v)
      return true
    }
    const target = ordered[n === 0 ? 9 : n - 1]
    if (!target) return false
    if (target.station.id !== current?.id) void open(target.station.id)
    return true
  }
  host.onDigit(digit)

  // Choosing another section by hand leaves the station.
  host.onSection(id => {
    if (selecting || !current || current.demo.kind !== "section") return
    if (id !== current.demo.section) close()
  })

  // ── live readouts ──────────────────────────────────────────────────────────────────────────────────────────────
  /** Frame rate plus the Lab's own telemetry line (section counts and GPU time), as the status bar shows it. */
  function live() {
    if (current?.demo.kind === "page") return "Running in its own page"
    const telemetry = host.panel.header.textContent?.trim()
    const gpu = host.stage.gpuMs
    return `${frameTimes.length} fps · ${telemetry ? telemetry.replace(/\n/g, " · ") : gpu === null ? "GPU —" : `GPU ${gpu.toFixed(2)} ms`}`
  }
  const countFrame = (now: number) => {
    frameTimes.push(now)
    while (frameTimes.length && now - frameTimes[0]! > 1000) frameTimes.shift()
    if (current) requestAnimationFrame(countFrame)
    else frameTimes.length = 0
  }
  let counting = false
  // Widgets tick twice a second while a station is open; nothing runs without one.
  window.setInterval(() => {
    if (!current || document.hidden) { counting = false; return }
    if (!counting) { counting = true; requestAnimationFrame(countFrame) }
    for (const instance of instances.values()) instance.tick?.()
  }, 500)

  // ── commands (⌘K, radial, `arcade station`) ────────────────────────────────────────────────────────────────────
  const ids = () => ordered.map(o => o.station.id).join(", ")
  host.commands.register({
    id: "station.open",
    aliases: ["station", "overworld.station"],
    label: "Open Lab Station",
    shortLabel: "Station",
    category: "Navigation",
    args: { id: { type: "string", required: true, description: `Station id: ${ids()}` } },
    enabled: () => host.mode() !== "play",
    disabledReason: () => "Unavailable in Play mode. Run 'arcade release' first.",
    run: (_ctx, args) => {
      const id = String(args?.id ?? "").trim().toLowerCase()
      const found = byId.get(id) ?? ordered.find(o => o.station.title.toLowerCase() === id)
      if (!found) throw new Error(`Unknown station "${id}". Stations: ${ids()}.`)
      void open(found.station.id)
      return { station: found.station.id, title: found.station.title }
    },
  })
  host.commands.register({
    id: "station.list",
    label: "List Lab Stations",
    shortLabel: "Stations",
    category: "Navigation",
    readOnly: true,
    enabled: () => true,
    run: () => ({ current: current?.id ?? null, variant: variant?.id ?? null, stations: ordered.map(o => ({ id: o.station.id, key: o.key, title: o.station.title, status: o.station.status, board: o.station.board?.feature ?? null })) }),
  })
  host.commands.register({
    id: "station.variant",
    label: "Choose Station Variant",
    shortLabel: "Variant",
    category: "Navigation",
    args: { id: { type: "value", required: true, description: "Variant id, label or 1-based number" } },
    enabled: () => Boolean(current?.variants?.length),
    disabledReason: () => "Open a station with variants first.",
    run: (_ctx, args) => {
      const raw = String(args?.id ?? "").trim().toLowerCase()
      const variants = current?.variants ?? []
      const v = variants.find(x => x.id === raw || x.label.toLowerCase() === raw) ?? variants[Number(raw) - 1]
      if (!v) throw new Error(`Unknown variant "${raw}". Variants: ${variants.map(x => x.id).join(", ")}.`)
      chooseVariant(v)
      return { station: current?.id, variant: v.id }
    },
  })
  host.commands.register({
    id: "station.close",
    aliases: ["overworld.show", "overworld"],
    label: "Close Lab Station",
    shortLabel: "Close station",
    category: "Navigation",
    enabled: () => Boolean(current),
    disabledReason: () => "No station is open.",
    run: () => { close(); return { station: null } },
  })
  host.commands.register({
    id: "station.layout",
    label: "Station Layout",
    shortLabel: "Layout",
    category: "Navigation",
    description: "Read the open station's widget layout, replace it (layout), edit it (edit: true/false) or reset it to the station file (reset: true)",
    args: {
      layout: { type: "string", description: "Layout JSON: { left?, right?, dock? } lists of { widget, groups?, keys?, title? }" },
      reset: { type: "boolean", description: "Forget this browser's edits" },
      edit: { type: "boolean", description: "Show or hide the layout editor" },
    },
    enabled: () => Boolean(current),
    disabledReason: () => "Open a station first.",
    run: (_ctx, args) => {
      if (!current || !layout) throw new Error("Open a station first.")
      if (args?.reset === true) { saveLayout(storage, current.id, null); layout = stationLayout(current, groupsOf(current), storage); renderLayout() }
      if (typeof args?.layout === "string") {
        let raw: unknown
        try { raw = JSON.parse(args.layout) } catch { throw new Error("layout must be JSON") }
        const parsed = parseLayoutStrict(raw)
        commit(resolveLayout(parsed))
      }
      if (typeof args?.edit === "boolean") setEditing(args.edit)
      return { station: current.id, editing, saved: Boolean(savedLayout(storage, current.id)), layout: toStationLayout(layout) }
    },
  })
  for (const { station, key } of ordered) {
    host.commands.register({
      id: `station.go.${station.id}`,
      label: `Station: ${station.title}`,
      shortLabel: station.title,
      description: station.summary,
      category: "Navigation",
      shortcut: key ?? undefined,
      enabled: () => host.mode() !== "play",
      run: () => { void open(station.id); return { station: station.id } },
    })
  }

  renderList()
  for (const slot of STATION_SLOTS) slotEl(slot).hidden = true

  return {
    open,
    close,
    chooseVariant,
    say,
    capturePage,
    on(listener: (e: StationEvent) => void) { listeners.add(listener); return () => listeners.delete(listener) },
    snapshot(): StationSnapshot {
      return { view: current ? "station" : "lab", station: current, variant, section: current?.demo.kind === "section" && !missing ? current.demo.section : null, url: location.href }
    },
    /** The open station's layout, as a station file writes it. */
    layout: () => (layout ? toStationLayout(layout) : null),
    get editing() { return editing },
    setEditing,
    /** Re-renders widgets (the recorder calls this when it starts or stops). */
    refresh: () => { for (const instance of instances.values()) instance.tick?.() },
  }
}

function parseLayoutStrict(raw: unknown) {
  const parsed = parseLayout(raw)
  if (!parsed) throw new Error("layout must be { left?, right?, dock? } lists of { widget, id?, title?, groups?, keys? } with known widgets")
  return parsed
}

export type StationsController = ReturnType<typeof createStations>
