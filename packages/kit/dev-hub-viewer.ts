import { Stage } from "./lab/stage"
import { LabInput } from "./lab/input"
import { Particles } from "./fx/particles"
import { SmokeVolumes } from "./fx/volume"
import { SmokeTrail } from "./fx/smoke-trail"
import { LabPanel } from "./lab-panel"
import type { LabContext } from "./lab/types"
import type { LabCharacter } from "./lab/spawn-types"
import { catalogueLights, filterAssets, type CatalogueAsset } from "./dev-hub-model"
import type { DevHubOptions } from "./dev-hub"

export async function catalogueViewer(options: DevHubOptions) {
  const canvas = document.querySelector<HTMLCanvasElement>(".viewer canvas")!
  const status = document.querySelector<HTMLElement>("[data-viewer-status]")!
  const controls = document.querySelector<HTMLElement>("[data-viewer-controls]")!
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "low-power" })
  if (!adapter) throw new Error("WebGPU unavailable. Games and Sandbox links remain available.")
  const device = await adapter.requestDevice()
  const gpu = canvas.getContext("webgpu")!, format = navigator.gpu.getPreferredCanvasFormat()
  gpu.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST })
  // Stage's real orbit camera is enabled before the first draw.
  const stage = new Stage(device, gpu, format, () => {})
  stage.sceneMode = 3
  const input = new LabInput(canvas), particles = new Particles(), volume = new SmokeVolumes(), trail = new SmokeTrail()
  const context: LabContext = { device, stage, input, particles, volume, trail, sync() {} }
  const registry = options.spawn(context)
  const assets: CatalogueAsset[] = [
    ...registry.characters.map(character => ({ id: character.id, label: character.label, category: (character.id.startsWith("getaway:") ? "vehicle" : "character") as "vehicle" | "character" })),
    ...registry.items.items.map(item => ({ id: `getaway:prop:${item.id}`, label: item.label, category: "prop" as const })),
  ]
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) throw new Error("Duplicate catalogue ID")
  let selected = assets[0]!, character: LabCharacter | undefined, disposed = false, dirty = true, raf = 0
  const grid = document.querySelector<HTMLElement>(".asset-grid")!
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search assets"]')!
  const category = document.querySelector<HTMLSelectElement>('[aria-label="Asset category"]')!
  controls.innerHTML = `<div class="viewer-tools"><button data-frame>Frame · F</button><button data-left aria-label="Orbit left">↶</button><button data-right aria-label="Orbit right">↷</button><button data-near aria-label="Zoom in">+</button><button data-far aria-label="Zoom out">−</button></div>
    <p class="gesture-hint">Option-drag orbit · Shift-drag / middle-drag pan · Scroll zoom</p>
    <code data-asset-id></code><dl data-metrics></dl><div data-light-panel></div>
    <div class="feedback"><label>Feedback<textarea aria-label="Asset feedback" maxlength="10000"></textarea></label><button data-export>Export feedback</button><button data-copy>Copy feedback</button></div>
    <dialog aria-label="Feedback JSON"><textarea aria-label="Feedback JSON content" readonly></textarea><button data-close>Close</button></dialog>
    <dialog aria-label="Asset actions" data-actions><button data-context-frame>Frame · F</button><button data-context-export>Export feedback</button><button data-context-close>Close · Esc</button></dialog>`
  const note = controls.querySelector<HTMLTextAreaElement>('[aria-label="Asset feedback"]')!
  function draftKey() { return `arcade.asset-feedback.v1:${selected.id}` }
  const lightingSettings = { setup: "neutral" }
  function lights() { Object.assign(stage.lighting, catalogueLights[lightingSettings.setup as keyof typeof catalogueLights]); dirty = true; schedule() }
  const panel = new LabPanel(lightingSettings, [{ key: "setup", label: "Setup", group: "Lighting", type: "select", options: Object.keys(catalogueLights).map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })), change: lights }], new URLSearchParams(), () => {}, { open: true, presets: false, shortcut: false, capture: "focus", layout: "inspector" })
  panel.header.hidden = true // No frame-rate/perf sampling in a demand-driven viewer.
  controls.querySelector("[data-light-panel]")!.append(panel.host)
  function frame() { stage.frameTarget(0, .8, 0, selected.category === "vehicle" ? 11 : 6); dirty = true; schedule() }
  function select(asset: CatalogueAsset) {
    character?.leave?.(); character = undefined; registry.items.clear(); selected = asset
    if (asset.category === "prop") registry.items.spawn(asset.id.slice("getaway:prop:".length), { x: 0, y: 0, z: 0, yaw: 0 })
    else character = registry.characters.find(item => item.id === asset.id)!.create(context, { x: 0, y: 0, z: 0, yaw: 0 })
    controls.querySelector("[data-asset-id]")!.textContent = asset.id
    const metrics = controls.querySelector("[data-metrics]")!; metrics.replaceChildren()
    for (const [label, value] of Object.entries(options.metrics?.(asset.id) ?? {})) { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value; metrics.append(dt, dd) }
    try { note.value = localStorage.getItem(draftKey()) ?? "" } catch { note.value = "" }
    status.textContent = "Real game geometry · shared Lab shading"
    stage.showMarkers = false; stage.markers.splice(0, stage.markers.length, { x: 0, y: 0, z: 0, radius: asset.category === "vehicle" ? 3 : 1 })
    frame(); list()
  }
  function list() {
    grid.replaceChildren()
    const filtered = filterAssets(assets, search.value, category.value)
    for (const asset of filtered) {
      const button = document.createElement("button"), label = document.createElement("span"), id = document.createElement("small")
      label.textContent = asset.label; id.textContent = asset.id; button.append(label, id); button.setAttribute("aria-pressed", String(asset.id === selected.id)); button.dataset.assetId = asset.id
      button.addEventListener("click", () => { select(asset); grid.querySelector<HTMLButtonElement>(`[data-asset-id="${asset.id}"]`)?.focus() }); grid.append(button)
    }
    if (!filtered.length) { const empty = document.createElement("p"); empty.textContent = "No assets"; grid.append(empty) }
  }
  search.addEventListener("input", list); category.addEventListener("change", list)
  async function render() {
    if (disposed || document.hidden || location.hash !== "#catalogue") return
    canvas.width = Math.max(1, Math.round(canvas.clientWidth)); canvas.height = Math.max(1, Math.round(canvas.clientHeight))
    stage.resize(canvas.width, canvas.height); stage.updateCamera(); stage.meshes.reset(); stage.transients.reset()
    character?.prepare(); registry.items.prepare()
    await stage.render(particles, volume, trail, 0)
  }
  // Demand-driven: zero ongoing simulation, no RAF loop in hidden pages or Games.
  function schedule() {
    if (raf || disposed || document.hidden || location.hash !== "#catalogue") return
    raf = requestAnimationFrame(() => { raf = 0; if (dirty) { dirty = false; void render().catch(error => { status.textContent = String(error) }) } })
  }
  function change(action: () => void) { action(); dirty = true; schedule() }
  controls.querySelector("[data-frame]")!.addEventListener("click", frame)
  controls.querySelector("[data-left]")!.addEventListener("click", () => change(() => stage.orbit(-.25, 0)))
  controls.querySelector("[data-right]")!.addEventListener("click", () => change(() => stage.orbit(.25, 0)))
  controls.querySelector("[data-near]")!.addEventListener("click", () => change(() => stage.zoomBy(.85)))
  controls.querySelector("[data-far]")!.addEventListener("click", () => change(() => stage.zoomBy(1.15)))
  let drag: { id: number; x: number; y: number; pan: boolean } | undefined
  canvas.addEventListener("pointerdown", event => {
    if (event.ctrlKey || event.button === 2) return
    if (event.button !== 1 && !event.altKey && !event.shiftKey) { change(() => { stage.showMarkers = true }); return } // Single focused asset; orbit is explicit.
    event.preventDefault(); canvas.setPointerCapture(event.pointerId)
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 1 }
  })
  canvas.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y; drag.x = event.clientX; drag.y = event.clientY
    change(() => { if (drag!.pan) stage.pan(-dx, -dy); else stage.orbit(-dx * .008, dy * .008) })
  })
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.addEventListener(name, () => { drag = undefined })
  canvas.addEventListener("wheel", event => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); change(() => stage.zoomBy(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * .003))) }, { passive: false })
  canvas.addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.toLowerCase() === "f") { event.preventDefault(); frame() }
    if (event.key === "Escape") { drag = undefined; change(() => { stage.showMarkers = false }); search.focus() }
    if (["ArrowLeft", "ArrowRight", "+", "-"].includes(event.key)) { event.preventDefault(); change(() => event.key === "+" || event.key === "-" ? stage.zoomBy(event.key === "+" ? .85 : 1.15) : stage.orbit(event.key === "ArrowLeft" ? -.25 : .25, 0)) }
  })
  note.addEventListener("input", () => { try { localStorage.setItem(draftKey(), note.value) } catch { status.textContent = "Draft storage unavailable; export to keep feedback" } })
  function feedback() { return JSON.stringify({ version: 1, assetId: selected.id, feedback: note.value, seed: 7, camera: { focus: [...stage.focus], yaw: stage.camYaw, pitch: stage.camPitch, distance: stage.camDist }, lighting: { setup: lightingSettings.setup, ...stage.lighting }, geometry: "production-adapter", shading: "shared-lab" }, null, 2) }
  const dialog = controls.querySelector<HTMLDialogElement>('[aria-label="Feedback JSON"]')!
  function exportFeedback() { dialog.querySelector("textarea")!.value = feedback(); dialog.showModal() }
  controls.querySelector("[data-export]")!.addEventListener("click", exportFeedback)
  controls.querySelector("[data-close]")!.addEventListener("click", () => dialog.close())
  controls.querySelector("[data-copy]")!.addEventListener("click", () => { void Promise.resolve().then(() => navigator.clipboard.writeText(feedback())).then(() => { status.textContent = "Feedback copied" }).catch(exportFeedback) })
  const actions = controls.querySelector<HTMLDialogElement>("[data-actions]")!
  canvas.addEventListener("contextmenu", event => { event.preventDefault(); drag = undefined; actions.showModal() })
  controls.querySelector("[data-context-frame]")!.addEventListener("click", () => { actions.close(); frame(); canvas.focus() })
  controls.querySelector("[data-context-export]")!.addEventListener("click", () => { actions.close(); exportFeedback() })
  controls.querySelector("[data-context-close]")!.addEventListener("click", () => { actions.close(); canvas.focus() })
  const resize = new ResizeObserver(() => change(() => {})); resize.observe(canvas)
  document.addEventListener("visibilitychange", () => { if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; drag = undefined } else change(() => {}) })
  window.addEventListener("hashchange", () => { drag = undefined; change(() => {}) })
  window.addEventListener("pagehide", event => {
    cancelAnimationFrame(raf); raf = 0; drag = undefined; input.release()
    if (!event.persisted) { disposed = true; resize.disconnect(); character?.leave?.(); device.destroy() }
  })
  window.addEventListener("pageshow", () => change(() => {}))
  device.addEventListener("uncapturederror", event => { status.textContent = event.error.message })
  lights(); select(selected)
}
