import { Stage } from "./lab/stage"
import { LabInput } from "./lab/input"
import { Particles } from "./fx/particles"
import { SmokeVolumes } from "./fx/volume"
import { SmokeTrail } from "./fx/smoke-trail"
import { LabPanel } from "./lab-panel"
import type { LabContext } from "./lab/types"
import type { LabCharacter } from "./lab/spawn-types"
import { catalogueHash, catalogueLights, filterAssets, parseHubHash, type CatalogueAsset } from "./dev-hub-model"
import { bindOrbitGestures } from "./orbit-gestures"
import type { DevHubOptions } from "./dev-hub"

const assetKey = "arcade.catalogue.asset.v1", lightingKey = "arcade.catalogue.lighting.v1"
const categoryLabel = { vehicle: "Vehicle", prop: "Prop", character: "Character" } as const
const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); return true } catch { return false } }

export async function catalogueViewer(options: DevHubOptions) {
  const canvas = document.querySelector<HTMLCanvasElement>(".viewer canvas")!
  const status = document.querySelector<HTMLElement>("[data-viewer-status]")!
  const tools = document.querySelector<HTMLElement>("[data-viewer-tools]")!
  const inspector = document.querySelector<HTMLElement>("[data-inspector]")!
  const list = document.querySelector<HTMLElement>(".asset-list")!
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search assets"]')!
  const category = document.querySelector<HTMLSelectElement>('[aria-label="Asset category"]')!
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "low-power" })
  if (!adapter) throw new Error("WebGPU unavailable")
  const device = await adapter.requestDevice()
  const gpu = canvas.getContext("webgpu")!, format = navigator.gpu.getPreferredCanvasFormat()
  gpu.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST })
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
  const byId = (id: string | null | undefined) => assets.find(asset => asset.id === id)
  let selected = byId(parseHubHash(location.hash).assetId) ?? byId(read(assetKey)) ?? assets[0]!
  let character: LabCharacter | undefined, disposed = false, dirty = true, raf = 0

  tools.innerHTML = `<button type="button" data-frame aria-label="Frame" title="Frame · F">Frame</button><span class="tool-sep"></span><button type="button" data-left aria-label="Orbit left" title="Orbit left · ←">↺</button><button type="button" data-right aria-label="Orbit right" title="Orbit right · →">↻</button><span class="tool-sep"></span><button type="button" data-near aria-label="Zoom in" title="Zoom in · +">+</button><button type="button" data-far aria-label="Zoom out" title="Zoom out · −">−</button>`
  inspector.innerHTML = `<div class="inspector-head"><h2 data-asset-label></h2><code data-asset-id></code></div>
    <dl class="facts" data-metrics></dl>
    <div class="inspector-panel" data-light-panel></div>
    <label class="field">Feedback<textarea aria-label="Asset feedback" maxlength="10000" rows="4"></textarea></label>
    <div class="row"><button type="button" data-copy>Copy feedback</button><button type="button" data-export>Export feedback</button></div>
    <p class="legend"><kbd>Drag</kbd><span>Orbit</span><kbd>⇧ Drag</kbd><span>Pan</span><kbd>Scroll</kbd><span>Zoom</span><kbd>F</kbd><span>Frame</span></p>
    <dialog aria-label="Feedback JSON"><textarea aria-label="Feedback JSON content" readonly></textarea><div class="row"><button type="button" data-close>Close</button></div></dialog>`
  const menu = document.createElement("div")
  menu.className = "context-menu"; menu.popover = "auto"; menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Asset actions")
  menu.innerHTML = `<button type="button" role="menuitem" data-menu-frame>Frame<kbd>F</kbd></button><button type="button" role="menuitem" data-menu-copy>Copy feedback</button><button type="button" role="menuitem" data-menu-export>Export feedback</button>`
  document.body.append(menu)
  const note = inspector.querySelector<HTMLTextAreaElement>('[aria-label="Asset feedback"]')!
  const draftKey = () => `arcade.asset-feedback.v1:${selected.id}`

  const stored = read(lightingKey)
  const lightingSettings = { setup: stored && stored in catalogueLights ? stored : "neutral" }
  function lights() { Object.assign(stage.lighting, catalogueLights[lightingSettings.setup as keyof typeof catalogueLights]); write(lightingKey, lightingSettings.setup); dirty = true; schedule() }
  const panel = new LabPanel(lightingSettings, [{ key: "setup", label: "Setup", group: "Lighting", type: "select", options: Object.keys(catalogueLights).map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })), change: lights }], new URLSearchParams(), () => {}, { open: true, presets: false, shortcut: false, capture: "focus", layout: "inspector", groupActions: false })
  panel.header.hidden = true // A demand-driven viewer has no frame-rate sampling.
  inspector.querySelector("[data-light-panel]")!.append(panel.host)

  function frame() { stage.frameTarget(0, .8, 0, selected.category === "vehicle" ? 11 : 6); dirty = true; schedule() }
  function select(asset: CatalogueAsset, history: "replace" | "none" = "replace") {
    character?.leave?.(); character = undefined; registry.items.clear(); selected = asset
    if (asset.category === "prop") registry.items.spawn(asset.id.slice("getaway:prop:".length), { x: 0, y: 0, z: 0, yaw: 0 })
    else character = registry.characters.find(item => item.id === asset.id)!.create(context, { x: 0, y: 0, z: 0, yaw: 0 })
    inspector.querySelector("[data-asset-label]")!.textContent = asset.label
    inspector.querySelector("[data-asset-id]")!.textContent = asset.id
    const metrics = inspector.querySelector("[data-metrics]")!; metrics.replaceChildren()
    const facts: Record<string, string> = { Type: categoryLabel[asset.category], ...options.metrics?.(asset.id), Geometry: "Production", Shading: "Shared Lab" }
    for (const [label, value] of Object.entries(facts)) { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value; metrics.append(dt, dd) }
    note.value = read(draftKey()) ?? ""
    write(assetKey, asset.id)
    if (history === "replace" && parseHubHash(location.hash).assetId !== asset.id) window.history.replaceState(null, "", catalogueHash(asset.id))
    status.textContent = ""
    stage.showMarkers = false
    frame(); renderList()
  }
  function renderList() {
    const filtered = filterAssets(assets, search.value, category.value)
    list.replaceChildren()
    for (const asset of filtered) {
      const option = document.createElement("button"), label = document.createElement("span"), kind = document.createElement("small")
      option.type = "button"; option.setAttribute("role", "option"); option.dataset.assetId = asset.id; option.title = asset.id
      option.setAttribute("aria-selected", String(asset.id === selected.id)); option.tabIndex = asset.id === selected.id ? 0 : -1
      label.textContent = asset.label; kind.textContent = categoryLabel[asset.category]
      option.append(label, kind); list.append(option)
    }
    if (filtered.length && !filtered.some(asset => asset.id === selected.id)) (list.firstElementChild as HTMLElement).tabIndex = 0
    if (!filtered.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No assets"; list.append(empty) }
  }
  list.addEventListener("click", event => {
    const option = (event.target as Element).closest<HTMLElement>("[data-asset-id]"); const asset = byId(option?.dataset.assetId)
    if (asset) { select(asset); list.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(asset.id)}"]`)?.focus() }
  })
  list.addEventListener("keydown", event => {
    const options = [...list.querySelectorAll<HTMLElement>("[data-asset-id]")], index = options.indexOf(document.activeElement as HTMLElement)
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : -2
    if (next === -2 || !options.length) return
    event.preventDefault()
    const option = options[Math.max(0, Math.min(options.length - 1, next))]!, asset = byId(option.dataset.assetId)!
    select(asset); list.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(asset.id)}"]`)?.focus()
  })
  search.addEventListener("input", renderList); category.addEventListener("change", renderList)
  search.addEventListener("keydown", event => { if (event.key === "ArrowDown") { event.preventDefault(); list.querySelector<HTMLElement>("[data-asset-id]")?.focus() } })

  const visible = () => !disposed && !document.hidden && parseHubHash(location.hash).page === "catalogue"
  async function render() {
    if (!visible()) return
    canvas.width = Math.max(1, Math.round(canvas.clientWidth)); canvas.height = Math.max(1, Math.round(canvas.clientHeight)) // 1× like the Lab.
    stage.resize(canvas.width, canvas.height); stage.updateCamera(); stage.meshes.reset(); stage.transients.reset()
    character?.prepare(); registry.items.prepare()
    await stage.render(particles, volume, trail, 0)
  }
  // Demand-driven: no simulation and no frames while hidden or on another hub page.
  function schedule() {
    if (raf || !visible()) return
    raf = requestAnimationFrame(() => { raf = 0; if (dirty) { dirty = false; void render().catch(error => { status.textContent = String(error) }) } })
  }
  function change(action: () => void) { action(); dirty = true; schedule() }
  tools.querySelector("[data-frame]")!.addEventListener("click", frame)
  tools.querySelector("[data-left]")!.addEventListener("click", () => change(() => stage.orbit(-.25, 0)))
  tools.querySelector("[data-right]")!.addEventListener("click", () => change(() => stage.orbit(.25, 0)))
  tools.querySelector("[data-near]")!.addEventListener("click", () => change(() => stage.zoomBy(.85)))
  tools.querySelector("[data-far]")!.addEventListener("click", () => change(() => stage.zoomBy(1.15)))

  // Same camera grammar as the Lab: drag orbits; Shift, middle or right drag pans. A right/Control click opens actions.
  const gestures = bindOrbitGestures(canvas, {
    target: stage,
    onChange: () => { dirty = true; schedule() },
    onContextClick: (x, y) => openMenu(x, y),
  })
  canvas.addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key
    if (key.toLowerCase() === "f") { event.preventDefault(); frame() }
    else if (key === "Escape") { gestures.cancelDrag(); search.focus() }
    else if (key === "ContextMenu") { event.preventDefault(); const box = canvas.getBoundingClientRect(); openMenu(box.left + box.width / 2, box.top + box.height / 2) }
    else if (key === "+" || key === "=" || key === "-") { event.preventDefault(); change(() => stage.zoomBy(key === "-" ? 1.15 : .85)) }
    else if (key.startsWith("Arrow")) {
      event.preventDefault()
      const sign = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1, vertical = key === "ArrowUp" || key === "ArrowDown"
      change(() => event.shiftKey ? stage.pan(vertical ? 0 : sign * 40, vertical ? sign * 40 : 0) : stage.orbit(vertical ? 0 : sign * .25, vertical ? sign * -.12 : 0))
    }
  })

  note.addEventListener("input", () => { if (!write(draftKey(), note.value)) status.textContent = "Draft storage unavailable; export to keep feedback" })
  function feedback() { return JSON.stringify({ version: 1, assetId: selected.id, feedback: note.value, seed: 7, camera: { focus: [...stage.focus], yaw: stage.camYaw, pitch: stage.camPitch, distance: stage.camDist }, lighting: { setup: lightingSettings.setup, ...stage.lighting }, geometry: "production-adapter", shading: "shared-lab" }, null, 2) }
  const dialog = inspector.querySelector<HTMLDialogElement>('[aria-label="Feedback JSON"]')!
  function exportFeedback() { dialog.querySelector("textarea")!.value = feedback(); dialog.showModal() }
  function copyFeedback() { void Promise.resolve().then(() => navigator.clipboard.writeText(feedback())).then(() => { status.textContent = "Feedback copied" }).catch(exportFeedback) }
  inspector.querySelector("[data-export]")!.addEventListener("click", exportFeedback)
  inspector.querySelector("[data-copy]")!.addEventListener("click", copyFeedback)
  inspector.querySelector("[data-close]")!.addEventListener("click", () => dialog.close())
  function openMenu(x: number, y: number) {
    menu.style.left = `${Math.min(x, innerWidth - 200)}px`; menu.style.top = `${Math.min(y, innerHeight - 140)}px`
    menu.showPopover(); menu.querySelector<HTMLElement>("button")!.focus()
  }
  function fromMenu(action: () => void) { menu.hidePopover(); action(); canvas.focus({ preventScroll: true }) }
  menu.querySelector("[data-menu-frame]")!.addEventListener("click", () => fromMenu(frame))
  menu.querySelector("[data-menu-copy]")!.addEventListener("click", () => fromMenu(copyFeedback))
  menu.querySelector("[data-menu-export]")!.addEventListener("click", () => { menu.hidePopover(); exportFeedback() })
  menu.addEventListener("keydown", event => {
    const items = [...menu.querySelectorAll<HTMLElement>("button")], index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]!.focus() }
  })
  menu.addEventListener("toggle", event => { if ((event as ToggleEvent).newState === "closed" && menu.contains(document.activeElement)) canvas.focus({ preventScroll: true }) })

  const resize = new ResizeObserver(() => change(() => {})); resize.observe(canvas)
  document.addEventListener("visibilitychange", () => { if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; gestures.cancelDrag() } else change(() => {}) })
  window.addEventListener("hashchange", () => {
    gestures.cancelDrag()
    const asset = byId(parseHubHash(location.hash).assetId)
    if (asset && asset.id !== selected.id) select(asset, "none")
    else if (parseHubHash(location.hash).page === "catalogue" && !parseHubHash(location.hash).assetId) window.history.replaceState(null, "", catalogueHash(selected.id))
    change(() => {})
  })
  window.addEventListener("pagehide", event => {
    cancelAnimationFrame(raf); raf = 0; gestures.cancelDrag(); input.release()
    if (!event.persisted) { disposed = true; resize.disconnect(); character?.leave?.(); device.destroy() }
  })
  window.addEventListener("pageshow", () => change(() => {}))
  device.addEventListener("uncapturederror", event => { status.textContent = event.error.message })
  lights(); select(selected)
}
