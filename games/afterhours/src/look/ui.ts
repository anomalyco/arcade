import type * as THREE from "three/webgpu"
import type { LabPanel, LabSettings } from "@arcade/kit/lab-panel"
import type { WorldContext } from "../world/context"
import { VIEWPOINTS } from "../world/layout"
import { CAMERA_PRESETS, LOOK_PRESETS, QUALITY, type CameraPreset } from "./presets"

// The Look Lab toolbar and overlays: A/B wipe between two settings snapshots, the concept reference overlay
// (side-by-side, wipe, onion skin, difference), the one-click look strip, the contact sheet and saved variants.

type Quality = keyof typeof QUALITY
type Mode = "live" | "ab" | "ref" | "sheet"
type RefMode = "side" | "wipe" | "onion" | "diff"
type Slot = "A" | "B"

export type LookUiDeps = {
  ctx: WorldContext
  stage: HTMLDivElement
  canvas: HTMLCanvasElement
  panel: LabPanel
  defaults: LabSettings
  state: { freeze: boolean; quality: Quality }
  setViewSize: (w: number, h: number) => void
  setCamera: (id: string) => void
  cameraNow: () => unknown
  renderStills: (variants: (LabSettings | null)[], targets: HTMLCanvasElement[]) => Promise<void>
  getCameraPreset: () => CameraPreset | null
}

const CONCEPTS = import.meta.glob("../../concept/r*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>
const conceptUrl = (file: string) => CONCEPTS[`../../concept/${file}`] ?? ""
const STORE = "afterhours.look.variants"
const UI_STORE = "afterhours.look.ui"

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag)
  const { cls, ...rest } = props
  if (cls) e.className = cls
  Object.assign(e, rest)
  e.append(...kids)
  return e
}

export function createLookUi(d: LookUiDeps) {
  const { ctx, stage, canvas, panel, defaults, state } = d
  const settings = ctx.settings

  // Keys that are performance, not look: presets and A/B leave them alone; the quality toggle owns them.
  const perfKeys = new Set<string>([
    ...ctx.controls.filter((c) => c.group === "Performance" || c.group === "Player").map((c) => c.key),
    ...Object.keys(QUALITY.max),
    ...Object.keys(QUALITY.fast),
  ])
  perfKeys.delete("forest.shadows")

  const ui = load<{ mode: Mode; refMode: RefMode; wipe: number; opacity: number; editing: Slot; slots: Record<Slot, LabSettings>; labels: Record<Slot, string> }>(UI_STORE)
  let mode: Mode = ui?.mode ?? "live"
  let refMode: RefMode = ui?.refMode ?? "wipe"
  let wipe = ui?.wipe ?? 0.5
  let opacity = ui?.opacity ?? 0.5
  let editing: Slot = ui?.editing ?? "A"
  const slots: Record<Slot, LabSettings> = {
    A: { ...defaults, ...(ui?.slots?.A ?? {}) },
    B: { ...defaults, ...(ui?.slots?.B ?? LOOK_PRESETS.find((p) => p.id === "concept")!.settings) },
  }
  const labels: Record<Slot, string> = ui?.labels ?? { A: "Game default", B: "Concept match" }
  let variants: Record<string, LabSettings> = load(STORE) ?? {}
  let concept = ""

  const replaceSettings = (next: LabSettings) => {
    for (const k of Object.keys(settings)) if (!(k in next) && !perfKeys.has(k)) delete settings[k]
    for (const [k, v] of Object.entries(next)) if (!perfKeys.has(k)) settings[k] = v
    panel.sync()
  }
  replaceSettings(slots[editing])
  const slotSettings = (s: Slot): LabSettings => (s === editing ? { ...settings } : { ...slots[s] })
  const lookFrom = (base: LabSettings, preset: LabSettings): LabSettings => {
    const out: LabSettings = { ...base }
    for (const [k, v] of Object.entries(defaults)) if (!perfKeys.has(k)) out[k] = v
    return Object.assign(out, preset)
  }
  const persist = () =>
    save(UI_STORE, { mode, refMode, wipe, opacity, editing, slots: { ...slots, [editing]: { ...settings } }, labels })

  // ------------------------------------------------------------------------------------------- DOM
  const bar = el("div", { id: "bar" })
  document.body.append(bar)
  const frame = el("div", { cls: "frame" })
  const side = el("div", { cls: "side", hidden: true }, el("img", { alt: "concept" }))
  stage.append(frame, side)
  const stillA = el("canvas", { cls: "still" })
  const stillB = el("canvas", { cls: "still" })
  const veil = el("canvas", { cls: "veil", hidden: true })
  const ref = el("img", { cls: "ref", alt: "concept" })
  const divider = el("div", { cls: "divider" })
  const tagL = el("div", { cls: "tag l" })
  const tagR = el("div", { cls: "tag r" })
  const badge = el("div", { cls: "badge", hidden: true })
  const sheet = el("div", { cls: "sheet", hidden: true })
  frame.append(canvas, stillA, stillB, ref, veil, sheet, divider, tagL, tagR, badge)

  const button = (label: string, title: string, onclick: () => void) => el("button", { textContent: label, title, onclick })
  const select = (options: [string, string][], value: string, onchange: (v: string) => void, title = "") => {
    const s = el("select", { title })
    for (const [v, l] of options) s.append(el("option", { value: v, textContent: l }))
    s.value = value
    s.onchange = () => onchange(s.value)
    return s
  }

  // Row 1: camera, mode, freeze, quality.
  const camSelect = select(
    [
      ...CAMERA_PRESETS.map((c) => [c.id, c.label] as [string, string]),
      ...Object.entries(VIEWPOINTS).map(([id, v]) => [id, `Game view: ${v.label}`] as [string, string]),
    ],
    "r3-01",
    (v) => setCamera(v),
    "Camera: concept-matched presets, then the game's viewpoints (fly with N, WASD, mouse)",
  )
  const modeButtons = new Map<Mode, HTMLButtonElement>()
  const modeRow: HTMLElement[] = []
  for (const [m, l, t] of [
    ["live", "Live", "Live view of the slot being edited"],
    ["ab", "A | B", "Split wipe between slots A and B on the same frame"],
    ["ref", "Reference", "Compare against the concept image for this camera"],
    ["sheet", "Contact sheet", "This view under every look preset and saved variant; click one to apply"],
  ] as [Mode, string, string][]) {
    const b = button(l, t, () => setMode(m))
    modeButtons.set(m, b)
    modeRow.push(b)
  }
  const freeze = el("input", { type: "checkbox", checked: state.freeze, onchange: () => ((state.freeze = freeze.checked), invalidate()) })
  const quality = select(
    [
      ["fast", "Fast"],
      ["balanced", "Balanced (game)"],
      ["max", "Max"],
    ],
    state.quality,
    (v) => ((state.quality = v as Quality), invalidate()),
    "Quality override for the Lab view (applies to every slot and still)",
  )
  const status = el("span", { cls: "status" })
  bar.append(
    el(
      "div",
      { cls: "row" },
      camSelect,
      button("Copy camera", "Copy the live camera as a preset (paste into src/look/presets.ts)", () => {
        const text = JSON.stringify(d.cameraNow())
        navigator.clipboard?.writeText(text).catch(() => {})
        flash(`camera ${text}`)
      }),
      el("span", { cls: "sep" }),
      ...modeRow,
      el("span", { cls: "sep" }),
      el("label", { title: "Freeze time and flicker so comparisons are stable" }, freeze, "Freeze"),
      el("label", {}, "Quality", quality),
      button("Refresh", "Re-render the stills", () => invalidate(true)),
      status,
    ),
  )

  // Row 2: look strip.
  const lookRow = el("div", { cls: "row" }, el("span", { textContent: `Look → ${editing}:` }))
  const lookLabel = lookRow.firstChild as HTMLSpanElement
  for (const p of LOOK_PRESETS) lookRow.append(button(p.label, p.note, () => applyLook(p.id)))
  bar.append(lookRow)

  // Row 3: slots and variants (A/B), reference controls.
  const slotButtons = { A: button("Edit A", "Lab panel edits slot A", () => setEditing("A")), B: button("Edit B", "Lab panel edits slot B", () => setEditing("B")) }
  const variantSelect = el("select", { title: "Saved variants" })
  const refreshVariants = () => {
    variantSelect.replaceChildren(el("option", { value: "", textContent: "— saved variants —" }))
    for (const name of Object.keys(variants).sort()) variantSelect.append(el("option", { value: name, textContent: name }))
  }
  refreshVariants()
  const importInput = el("input", { type: "file", accept: "application/json", hidden: true })
  importInput.onchange = async () => {
    const f = importInput.files?.[0]
    if (!f) return
    try {
      const data = JSON.parse(await f.text()) as { variants?: unknown; slots?: unknown }
      const vs = (data.variants ?? data) as Record<string, unknown>
      let n = 0
      for (const [name, v] of Object.entries(vs)) {
        if (!isSettings(v)) continue
        variants[name] = v
        n++
      }
      save(STORE, variants)
      refreshVariants()
      flash(`imported ${n} variants`)
    } catch (e) {
      flash(`import failed: ${e}`)
    }
    importInput.value = ""
  }
  const abRow = el(
    "div",
    { cls: "row ctx" },
    slotButtons.A,
    slotButtons.B,
    button("A → B", "Copy slot A into B", () => copySlot("A", "B")),
    button("B → A", "Copy slot B into A", () => copySlot("B", "A")),
    button("Swap", "Swap A and B", () => {
      const a = slotSettings("A")
      const b = slotSettings("B")
      ;[labels.A, labels.B] = [labels.B, labels.A]
      slots.A = b
      slots.B = a
      replaceSettings(slots[editing])
      changed()
    }),
    el("span", { cls: "sep" }),
    variantSelect,
    button("Load", "Load the selected variant into the edited slot", () => {
      const v = variants[variantSelect.value]
      if (v) setSlot(editing, { ...settings, ...v }, variantSelect.value)
    }),
    button("Save", "Save the edited slot as a named variant", () => {
      const name = prompt("Variant name", labels[editing].replace(/\*$/, ""))?.trim()
      if (!name) return
      variants[name] = lookOnly(settings)
      labels[editing] = name
      save(STORE, variants)
      refreshVariants()
      variantSelect.value = name
      changed()
    }),
    button("Delete", "Delete the selected variant", () => {
      if (!variantSelect.value) return
      delete variants[variantSelect.value]
      save(STORE, variants)
      refreshVariants()
    }),
    button("Export", "Download every saved variant and both slots as JSON", () => {
      const blob = new Blob([JSON.stringify({ version: 1, variants, slots: { A: lookOnly(slotSettings("A")), B: lookOnly(slotSettings("B")) } }, null, 2)], { type: "application/json" })
      const a = el("a", { href: URL.createObjectURL(blob), download: "afterhours-look-variants.json" })
      a.click()
      URL.revokeObjectURL(a.href)
    }),
    button("Import", "Import variants from JSON", () => importInput.click()),
    importInput,
  )
  const conceptSelect = select(
    Object.keys(CONCEPTS)
      .map((k) => k.split("/").pop()!)
      .sort()
      .map((f) => [f, f] as [string, string]),
    "",
    (v) => setConcept(v),
    "Concept image (follows the camera preset)",
  )
  const opacityInput = el("input", { type: "range", min: "0", max: "1", step: "0.01", value: String(opacity) })
  const refButtons = new Map<RefMode, HTMLButtonElement>()
  const refRow = el("div", { cls: "row ctx" }, conceptSelect)
  for (const [m, l] of [
    ["side", "Side by side"],
    ["wipe", "Wipe"],
    ["onion", "Onion skin"],
    ["diff", "Difference"],
  ] as [RefMode, string][]) {
    const b = button(l, "", () => {
      refMode = m
      if (m === "diff") opacityInput.value = String((opacity = 1))
      layout()
    })
    refButtons.set(m, b)
    refRow.append(b)
  }
  opacityInput.oninput = () => {
    opacity = Number(opacityInput.value)
    layout()
  }
  refRow.append(el("label", {}, "Opacity", opacityInput))
  bar.append(abRow, refRow)

  // ------------------------------------------------------------------------------------------- behaviour
  let flashTimer = 0
  let flashText = ""
  function flash(text: string) {
    flashText = text
    clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => (flashText = ""), 4000)
  }
  function lookOnly(s: LabSettings) {
    const out: LabSettings = {}
    for (const [k, v] of Object.entries(s)) if (!perfKeys.has(k)) out[k] = v
    return out
  }
  function setSlot(s: Slot, next: LabSettings, label: string) {
    labels[s] = label
    if (s === editing) replaceSettings(next)
    else slots[s] = next
    changed()
  }
  function copySlot(from: Slot, to: Slot) {
    setSlot(to, slotSettings(from), labels[from])
  }
  function setEditing(s: Slot) {
    if (s === editing) return
    slots[editing] = { ...settings }
    editing = s
    replaceSettings(slots[s])
    changed()
  }
  function applyLook(id: string) {
    const p = LOOK_PRESETS.find((x) => x.id === id)
    if (!p) return
    if (id === "max" || id === "fast") {
      state.quality = id
      quality.value = id
      invalidate()
      return
    }
    setSlot(editing, lookFrom(settings, p.settings), p.label)
  }
  function setCamera(id: string) {
    d.setCamera(id)
    camSelect.value = id
    const c = d.getCameraPreset()
    if (c?.concept) setConcept(c.concept)
    invalidate()
  }
  function setConcept(file: string) {
    concept = file
    conceptSelect.value = file
    const url = conceptUrl(file)
    ref.src = url
    ;(side.firstChild as HTMLImageElement).src = url
  }
  function setMode(m: Mode) {
    mode = m
    layout()
    invalidate(true)
  }

  // A/B stills follow the camera and both slots: while anything changes the live view shows, once it has been still
  // for a moment both stills re-render on the same frame.
  let capturedSig = ""
  let pendingSig = ""
  let pendingSince = 0
  let capturing = false
  let sheetSig = ""
  const camEls = (d.ctx.camera as THREE.PerspectiveCamera).matrixWorld.elements
  const signature = () =>
    [Array.from(camEls, (v) => v.toFixed(3)).join(","), d.ctx.camera.fov, JSON.stringify(settings), JSON.stringify(slots[editing === "A" ? "B" : "A"]), state.quality, state.freeze, canvas.width, canvas.height].join("|")
  function invalidate(force = false) {
    if (force) capturedSig = sheetSig = ""
    persist()
  }
  function changed() {
    persist()
    layout()
  }

  const sizeStill = (c: HTMLCanvasElement) => {
    if (c.width !== canvas.width || c.height !== canvas.height) {
      c.width = canvas.width
      c.height = canvas.height
    }
  }
  async function captureAB(sig: string) {
    capturing = true
    for (const c of [stillA, stillB, veil]) sizeStill(c)
    veil.hidden = false
    badge.hidden = false
    badge.textContent = "rendering A | B…"
    await d.renderStills([null, lookOnly(slotSettings("A")), lookOnly(slotSettings("B"))], [veil, stillA, stillB])
    capturing = false
    veil.hidden = true
    badge.hidden = true
    capturedSig = sig
    layout()
  }

  const cells: { canvas: HTMLCanvasElement; settings: LabSettings; label: string }[] = []
  async function captureSheet(sig: string) {
    capturing = true
    const list: { label: string; note: string; settings: LabSettings }[] = [{ label: `Current (${editing}: ${labels[editing]})`, note: "", settings: { ...settings } }]
    for (const p of LOOK_PRESETS) if (p.id !== "max" && p.id !== "fast" && p.id !== "default") list.push({ label: p.label, note: p.note, settings: lookFrom(settings, p.settings) })
    for (const [name, v] of Object.entries(variants)) list.push({ label: name, note: "saved variant", settings: { ...settings, ...v } })
    const shown = list.slice(0, 9)
    sheet.replaceChildren()
    cells.length = 0
    const w = Math.round(canvas.width / 3)
    const h = Math.round(canvas.height / 3)
    for (const item of shown) {
      const c = el("canvas", { width: w, height: h })
      const cell = el("div", { cls: "cell", title: item.note }, c, el("span", { textContent: item.label }))
      cell.onclick = () => {
        setSlot(editing, item.settings, item.label.startsWith("Current") ? labels[editing] : item.label)
        setMode("live")
      }
      sheet.append(cell)
      cells.push({ canvas: c, settings: item.settings, label: item.label })
    }
    badge.hidden = false
    badge.textContent = `rendering ${shown.length} variants…`
    await d.renderStills(
      shown.map((s) => lookOnly(s.settings)),
      cells.map((c) => c.canvas),
    )
    badge.hidden = true
    capturing = false
    sheetSig = sig
  }

  setInterval(() => {
    const sig = signature()
    const now = performance.now()
    if (sig !== pendingSig) {
      pendingSig = sig
      pendingSince = now
    }
    if (mode === "ab") {
      const stale = sig !== capturedSig
      stillA.hidden = stillB.hidden = stale && !capturing
      tagL.textContent = stale && !capturing ? `live: ${editing} · ${labels[editing]}` : `A · ${labels.A}`
      tagR.hidden = stale && !capturing
      divider.hidden = stale && !capturing
      if (stale && !capturing && now - pendingSince > 300) void captureAB(sig)
    }
    if (mode === "sheet" && !capturing && sig !== sheetSig && now - pendingSince > 300) void captureSheet(sig)
    const s = (globalThis as { __afterhours?: { frameMs: number[] } }).__afterhours?.frameMs ?? []
    const recent = s.slice(-30).sort((a, b) => a - b)
    const ms = recent.length ? recent[recent.length >> 1]!.toFixed(1) : "—"
    status.textContent = flashText || `${ms} ms · editing ${editing}: ${labels[editing]} · ${state.quality}${state.freeze ? " · frozen" : ""}`
  }, 100)

  // Mark the edited slot's label as modified when the panel changes it.
  let lastJson = JSON.stringify(settings)
  setInterval(() => {
    const j = JSON.stringify(settings)
    if (j === lastJson) return
    lastJson = j
    if (!labels[editing].endsWith("*")) labels[editing] += "*"
    persist()
  }, 500)

  // ------------------------------------------------------------------------------------------- layout
  let dragging = false
  divider.addEventListener("pointerdown", (e) => {
    dragging = true
    divider.setPointerCapture(e.pointerId)
  })
  divider.addEventListener("pointermove", (e) => {
    if (!dragging) return
    const r = frame.getBoundingClientRect()
    wipe = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    layout()
  })
  divider.addEventListener("pointerup", () => {
    dragging = false
    persist()
  })

  function fit() {
    const top = bar.getBoundingClientRect().height
    stage.style.top = `${top}px`
    const W = innerWidth - 16
    const H = innerHeight - top - 16
    const sideBySide = mode === "ref" && refMode === "side"
    const w = Math.min(sideBySide ? (W - 8) / 2 : W, H * 1.5)
    const h = w / 1.5
    for (const box of [frame, side]) {
      box.style.width = `${Math.round(w)}px`
      box.style.height = `${Math.round(h)}px`
    }
    d.setViewSize(w, h)
  }

  function layout() {
    for (const [m, b] of modeButtons) b.classList.toggle("on", m === mode)
    for (const [m, b] of refButtons) b.classList.toggle("on", m === refMode)
    for (const s of ["A", "B"] as Slot[]) slotButtons[s].classList.toggle("on", s === editing)
    lookLabel.textContent = `Look → ${editing}:`
    abRow.hidden = mode === "ref"
    refRow.hidden = mode !== "ref"
    fit()
    const pct = `${(wipe * 100).toFixed(2)}%`
    const ab = mode === "ab"
    const refOn = mode === "ref"
    stillA.hidden = stillB.hidden = !ab || capturedSig === ""
    stillA.style.clipPath = `inset(0 ${(100 - wipe * 100).toFixed(2)}% 0 0)`
    stillB.style.clipPath = `inset(0 0 0 ${pct})`
    side.hidden = !(refOn && refMode === "side")
    ref.hidden = !refOn || refMode === "side"
    ref.style.clipPath = refMode === "wipe" ? `inset(0 0 0 ${pct})` : ""
    ref.style.opacity = refMode === "onion" || refMode === "diff" ? String(opacity) : "1"
    ref.style.mixBlendMode = refMode === "diff" ? "difference" : "normal"
    divider.hidden = !(ab || (refOn && refMode === "wipe"))
    divider.style.left = pct
    sheet.hidden = mode !== "sheet"
    tagL.hidden = !(ab || refOn)
    tagR.hidden = !(ab || (refOn && refMode === "wipe"))
    tagL.textContent = ab ? `A · ${labels.A}` : `render · ${labels[editing]}`
    tagR.textContent = ab ? `B · ${labels.B}` : `concept · ${concept}`
  }
  addEventListener("resize", layout)
  layout()

  return { applyLook, setCamera, layout }
}

function isSettings(v: unknown): v is LabSettings {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => ["number", "string", "boolean"].includes(typeof x))
}
function load<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}
