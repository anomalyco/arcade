import type { LabCommandInvokeResult, LabCommandRegistry } from "../../lab-commands"
import type { Stage } from "../stage"
import { overviewCamera, plotAt, plotCamera, type OverworldCamera, type OverworldDiorama, type Plot } from "./diorama"
import { STATUS_LABEL, orderStations, type LabStation, type StationCommand, type StationVariant } from "./types"
import "./style.css"

/** What the overworld needs from the Lab page. */
export type OverworldHost = {
  stage: Stage
  viewport: HTMLElement
  canvas: HTMLCanvasElement
  commands: LabCommandRegistry
  hasSection(id: string): boolean
  select(id: string): void
  invoke(id: string, args?: Record<string, unknown>): LabCommandInvokeResult
  chrome: { visible(): boolean; set(visible: boolean): void }
  suspend(value: boolean): void
  render(): Promise<unknown>
  telemetry(): string
  mode(): "edit" | "play" | undefined
  /** The variation grid owns number keys while it's open. */
  gridOpen(): boolean
  /** Loads a game's Lab adapters on demand; resolves false when the game has none. */
  ensureGame(game: string): Promise<boolean>
}

export type StationChange = { sha: string; subject: string; when: string }
export type StationBranch = { name: string; ahead: number; subject: string; when: string }
export type StationChanges = { commits: StationChange[]; branches: StationBranch[] }

/** Dev-server extras: recent git activity and the voice-note recorder. Absent in production builds. */
export type OverworldDev = {
  changes(station: LabStation): Promise<StationChanges | null>
  /** Starts or finishes a voice note; returns false if the recorder isn't available. */
  toggleNote?(): boolean
  noteActive?(): boolean
}

export type OverworldView = "overworld" | "station"
export type OverworldEvent =
  | { kind: "station"; station: string | null }
  | { kind: "variant"; station: string; variant: string }
export type OverworldSnapshot = {
  view: OverworldView
  station: LabStation | null
  variant: StationVariant | null
  section: string | null
  camera: { yaw: number; pitch: number; distance: number; focus: [number, number, number] }
  url: string
}

const GLIDE_MS = 320
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const ease = (t: number) => 1 - Math.pow(1 - t, 3)
const html = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  parent?.append(e)
  return e
}

export function createOverworld(opts: { host: OverworldHost; diorama: OverworldDiorama; stations: readonly LabStation[]; dev?: OverworldDev }) {
  const { host, diorama } = opts
  const { stage } = host
  const ordered = orderStations(opts.stations)
  const byId = new Map(ordered.map(o => [o.station.id, o]))
  const plotOf = (id: string) => diorama.plots.find(p => p.station.id === id)!
  const listeners = new Set<(e: OverworldEvent) => void>()
  const emit = (e: OverworldEvent) => { for (const l of listeners) l(e) }

  let view: OverworldView = "overworld"
  let current: LabStation | null = null
  let highlighted: string | null = ordered[0]?.station.id ?? null
  let variant: StationVariant | null = null
  let missing: string | null = null
  let glide: { from: OverworldCamera; to: OverworldCamera; start: number; done: () => void } | null = null
  let travelToken = 0
  let abPending = false
  let frameTimes: number[] = []
  let changesFor: string | null = null

  // ── DOM ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const root = el("div", "ow-root", host.viewport)
  root.dataset.overworld = ""
  const labels = el("div", "ow-labels", root)
  const labelEls = new Map<string, HTMLButtonElement>()
  for (const { station, key } of ordered) {
    const b = el("button", "ow-label", labels)
    b.type = "button"
    b.dataset.station = station.id
    b.style.setProperty("--c", hex(station.color))
    b.innerHTML = `${key ? `<kbd>${key}</kbd>` : ""}<span>${html(station.title)}</span><i data-status="${station.status}"></i>`
    b.addEventListener("click", () => void travel(station.id))
    b.addEventListener("pointerenter", () => setHighlight(station.id))
    labelEls.set(station.id, b)
  }

  const top = el("div", "ow-top", root)
  const crumb = el("div", "ow-crumb", top)
  const hints = el("div", "ow-hints", top)

  const card = el("div", "ow-card", root)

  const panel = el("aside", "ow-panel", root)
  panel.setAttribute("aria-label", "Station")
  const page = el("div", "ow-page", root)
  page.hidden = true

  const strip = el("nav", "ow-strip", root)
  strip.setAttribute("aria-label", "Stations")
  const stripEls = new Map<string, HTMLButtonElement>()
  for (const { station, key } of ordered) {
    const b = el("button", "ow-chip", strip)
    b.type = "button"
    b.dataset.station = station.id
    b.style.setProperty("--c", hex(station.color))
    b.innerHTML = `${key ? `<kbd>${key}</kbd>` : ""}${html(station.title)}`
    b.title = `${station.title} · ${STATUS_LABEL[station.status]}`
    b.addEventListener("click", () => void travel(station.id))
    stripEls.set(station.id, b)
  }

  const toast = el("div", "ow-toast", root)
  toast.hidden = true
  let toastTimer = 0
  function say(text: string, error = false) {
    toast.textContent = text
    toast.dataset.error = String(error)
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => { toast.hidden = true }, error ? 6000 : 3200)
  }

  // ── camera ───────────────────────────────────────────────────────────────────────────────────────────────────
  const aspect = () => Math.max(0.5, host.canvas.clientWidth / Math.max(1, host.canvas.clientHeight))
  const overview = () => overviewCamera(diorama.plots, aspect())
  const readCamera = (): OverworldCamera => ({ yaw: stage.camYaw, pitch: stage.camPitch, distance: stage.camDist, focus: [stage.focus[0]!, stage.focus[1]!, stage.focus[2]!] })
  function writeCamera(c: OverworldCamera) {
    stage.camYaw = c.yaw; stage.camPitch = c.pitch; stage.camDist = c.distance
    stage.focus[0] = c.focus[0]; stage.focus[1] = c.focus[1]; stage.focus[2] = c.focus[2]
    stage.targetFocus[0] = c.focus[0]; stage.targetFocus[1] = c.focus[1]; stage.targetFocus[2] = c.focus[2]
    stage.camCustom = true; stage.hasDampedTarget = false
    stage.updateCamera()
  }
  /** Glides the camera; resolves when it lands or is interrupted. Reduced motion cuts straight there. */
  function glideTo(to: OverworldCamera): Promise<void> {
    glide?.done()
    if (reducedMotion()) { writeCamera(to); return Promise.resolve() }
    return new Promise(done => { glide = { from: readCamera(), to, start: performance.now(), done: () => { glide = null; done() } } })
  }
  function stepGlide(now: number) {
    if (!glide) return
    const t = Math.min(1, (now - glide.start) / GLIDE_MS), k = ease(t), { from, to } = glide
    let dyaw = to.yaw - from.yaw
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw))
    writeCamera({
      yaw: from.yaw + dyaw * k,
      pitch: from.pitch + (to.pitch - from.pitch) * k,
      distance: from.distance + (to.distance - from.distance) * k,
      focus: [0, 1, 2].map(i => from.focus[i]! + (to.focus[i]! - from.focus[i]!) * k) as [number, number, number],
    })
    if (t >= 1) glide.done()
  }
  const interrupt = () => { if (glide) glide.done() }
  host.canvas.addEventListener("pointerdown", interrupt)
  host.canvas.addEventListener("wheel", interrupt, { passive: true })

  /** Where the overworld camera starts when it comes back from a station: over that station's plot. */
  function returnCamera(): OverworldCamera {
    return current ? plotCamera(plotOf(current.id)) : overview()
  }

  // ── travel ───────────────────────────────────────────────────────────────────────────────────────────────────
  function setHighlight(id: string | null) {
    highlighted = id
    diorama.setHighlight(view === "overworld" ? id : null)
    for (const [sid, b] of labelEls) b.dataset.active = String(sid === id)
    renderCard()
  }

  function runCommands(list: readonly StationCommand[] | undefined, label: string) {
    for (const step of list ?? []) {
      const res = host.invoke(step.command, step.args)
      if (!res.ok) { say(`${label}: ${step.command} failed: ${res.error}`, true); return false }
    }
    return true
  }

  function applyCamera(station: LabStation) {
    if (station.demo.kind !== "section" || !station.demo.camera) return
    const c = station.demo.camera, deg = Math.PI / 180, t = c.target
    if (t) { stage.focus[0] = t[0]; stage.focus[1] = t[1]; stage.focus[2] = t[2] }
    if (c.yaw !== undefined) stage.camYaw = c.yaw * deg
    if (c.pitch !== undefined) stage.camPitch = c.pitch * deg
    if (c.distance !== undefined) stage.camDist = c.distance
    stage.camCustom = true; stage.hasDampedTarget = false
    stage.updateCamera()
  }

  async function open(station: LabStation) {
    missing = null
    variant = null
    abPending = false
    if (station.demo.kind === "section") {
      const { section, game } = station.demo
      if (!host.hasSection(section) && game) {
        say(`Loading ${game} adapters…`)
        await host.ensureGame(game)
      }
      if (!host.hasSection(section)) {
        missing = section
      } else {
        host.select(section)
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
    view = "station"
    current = station
    root.dataset.view = "station"
    setHighlight(station.id)
    syncUrl()
    renderPanel()
    emit({ kind: "station", station: station.id })
    void loadChanges(station)
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
  async function runInFrame(list: readonly StationCommand[] | undefined, label: string) {
    if (!list?.length) return
    const rt = await frameRuntime()
    if (!rt) return
    await new Promise(done => setTimeout(done, 300))
    for (const step of list) {
      const res = await rt.invokeLocal(step.command, step.args)
      if (!res.ok) { say(`${label}: ${step.command} failed: ${res.error ?? "unavailable"}`, true); return }
    }
  }
  /** Keys pressed inside an embedded page still reach the overworld: Esc back, [ ] travel, N voice note. */
  function forwardKeys(frame: HTMLIFrameElement) {
    frame.addEventListener("load", () => {
      const win = frame.contentWindow
      win?.addEventListener("keydown", e => {
        const t = e.composedPath()[0]
        if (e.metaKey || e.ctrlKey || e.altKey || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
        const n = /^Digit[1-9]$/.test(e.code) && !e.shiftKey ? Number(e.code.slice(5)) : null
        const v = n !== null ? current?.variants?.[n - 1] : undefined
        if (v) { e.preventDefault(); chooseVariant(v) }
        else if (e.key === "Escape" && !opts.dev?.noteActive?.()) { e.preventDefault(); void back() }
        else if ((e.key === "[" || e.key === "]") && !e.repeat) { e.preventDefault(); void travel(step(e.key === "]" ? 1 : -1)) }
        else if (e.key.toLowerCase() === "n" && !e.repeat && opts.dev?.toggleNote) { e.preventDefault(); opts.dev.toggleNote() }
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
    target.width = img.naturalWidth || 1; target.height = img.naturalHeight || 1
    target.getContext("2d")!.drawImage(img, 0, 0)
    return true
  }

  function closePage() {
    if (page.hidden) return
    page.replaceChildren()
    page.hidden = true
    host.suspend(false)
  }

  /** Goes to a station: glide over the map, then open it. Repeated presses retarget immediately. */
  async function travel(id: string) {
    const target = byId.get(id)?.station
    if (!target) { say(`No station "${id}"`, true); return }
    const token = ++travelToken
    if (view === "station") {
      if (current?.id === id) return
      closePage()
      leaveToMap()
    }
    setHighlight(id)
    await glideTo(plotCamera(plotOf(id)))
    if (token !== travelToken) return
    await open(target)
  }

  function leaveToMap() {
    view = "overworld"
    root.dataset.view = "overworld"
    host.select("overworld")
  }

  /** Back to the overworld from a station, gliding out over the map. */
  async function back() {
    if (view !== "station") return
    const token = ++travelToken
    closePage()
    leaveToMap()
    const was = current
    current = null
    variant = null
    missing = null
    setHighlight(was?.id ?? highlighted)
    syncUrl()
    renderPanel()
    emit({ kind: "station", station: null })
    await glideTo(overview())
    if (token !== travelToken) return
  }

  function step(delta: number) {
    const ids = ordered.map(o => o.station.id)
    const from = view === "station" ? current?.id : highlighted
    const i = Math.max(0, ids.indexOf(from ?? ids[0]!))
    return ids[(i + delta + ids.length) % ids.length]!
  }

  function chooseVariant(v: StationVariant) {
    if (!current) return
    if (current.demo.kind === "page") {
      const frame = page.querySelector("iframe")
      if (frame && v.url && frame.getAttribute("src") !== v.url) frame.src = v.url
      void runInFrame(v.setup, v.label)
      variant = v
      renderPanel()
      emit({ kind: "variant", station: current.id, variant: v.id })
      return
    }
    if (runCommands(v.setup, v.label)) {
      variant = v
      if (abPending) {
        abPending = false
        host.invoke("compare.wipe")
        say(`A/B wipe: A is the pinned state, B is ${v.label}`)
      }
      renderPanel()
      emit({ kind: "variant", station: current.id, variant: v.id })
    }
  }

  function syncUrl() {
    const params = new URLSearchParams(location.search)
    params.set("overworld", "")
    if (current) params.set("station", current.id)
    else params.delete("station")
    const query = params.toString().replace(/^overworld=(&|$)/, "overworld$1").replace(/&overworld=(&|$)/, "&overworld$1")
    history.replaceState(null, "", `${location.pathname}?${query}`)
  }

  // ── panels ───────────────────────────────────────────────────────────────────────────────────────────────────
  function renderCard() {
    const s = highlighted ? byId.get(highlighted) : null
    card.hidden = view !== "overworld" || !s
    if (!s) return
    const { station, key } = s
    card.style.setProperty("--c", hex(station.color))
    card.innerHTML = `<b>${html(station.title)}</b><span class="ow-status" data-status="${station.status}">${STATUS_LABEL[station.status]}</span>${station.board ? `<span class="ow-tag">${station.board.feature}</span>` : ""}<span class="ow-card-summary">${html(station.summary)}</span><span class="ow-card-foot">${key ? `<kbd>${key}</kbd>` : `<kbd>⏎</kbd>`} open</span>`
  }

  function renderTop() {
    if (view === "overworld") {
      crumb.innerHTML = `<b>Lab</b> · Overworld`
      hints.innerHTML = `<kbd>1</kbd>–<kbd>0</kbd> travel · <kbd>⌘K</kbd> search · <kbd>\`</kbd> workbench`
    } else {
      crumb.innerHTML = `<button type="button" class="ow-back" data-action="overworld">‹ Overworld</button> <span>›</span> <b>${html(current?.title ?? "")}</b>`
      crumb.querySelector("button")!.addEventListener("click", () => void back())
      const note = opts.dev?.toggleNote ? ` · <kbd>N</kbd> voice note` : ""
      hints.innerHTML = `<kbd>Esc</kbd> back · <kbd>[</kbd><kbd>]</kbd> prev/next · <kbd>1</kbd>–<kbd>9</kbd> variants${note}`
    }
  }

  function renderPanel() {
    renderTop()
    renderCard()
    for (const [sid, b] of stripEls) b.dataset.active = String(sid === current?.id)
    panel.hidden = view !== "station" || !current
    if (!current) return
    const s = current
    const key = byId.get(s.id)?.key
    const variants = s.variants ?? []
    const feature = s.board ? `<a class="ow-tag" href="https://opencode-team-board.anomalyco.workers.dev/?open=${s.board.feature}&project=arcade" target="_blank" rel="noreferrer">${s.board.feature} ↗</a>` : ""
    const demo = s.demo.kind === "section"
      ? missing
        ? `<p class="ow-missing">The <code>${html(missing)}</code> section isn't in this build yet. The station will run it once that branch merges.</p>`
        : `<div class="ow-row"><span>Runs</span><code>${html(s.demo.section)}</code>${s.demo.game ? ` <span class="ow-dim">(${html(s.demo.game)} adapters)</span>` : ""}</div>`
      : `<div class="ow-row"><span>Runs</span><a href="${html(s.demo.url)}">${html(s.demo.url)}</a></div>`
    panel.style.setProperty("--c", hex(s.color))
    panel.innerHTML = `
      <header class="ow-panel-head">
        <div class="ow-panel-title">${key ? `<kbd>${key}</kbd>` : ""}<h2>${html(s.title)}</h2>${feature}</div>
        <div class="ow-panel-status"><span class="ow-status" data-status="${s.status}">${STATUS_LABEL[s.status]}</span>${s.statusNote ? `<span class="ow-dim">${html(s.statusNote)}</span>` : ""}</div>
        <p>${html(s.summary)}</p>
        ${demo}
      </header>
      ${variants.length ? `<section><h3>Variants</h3><div class="ow-variants">${variants.map((v, i) => `<button type="button" class="ow-variant" data-variant="${v.id}" data-active="${variant?.id === v.id}" title="${html(v.note ?? v.label)}">${i < 9 ? `<kbd>${i + 1}</kbd>` : ""}<span>${html(v.label)}</span></button>`).join("")}</div></section>` : ""}
      ${s.demo.kind === "section" && !missing ? `<section><h3>Compare</h3><div class="ow-actions">
        ${s.grid ? `<button type="button" class="ow-btn" data-action="grid">⊞ Grid</button>` : ""}
        <button type="button" class="ow-btn" data-action="ab" title="Pin what you see now as A, then pick a variant for B">${abPending ? "Pick B…" : "A/B wipe"}</button>
        <button type="button" class="ow-btn" data-action="tune" title="Show the full workbench (Backquote)">Tune ⌁</button>
      </div></section>` : ""}
      <section><h3>Live</h3><div class="ow-live" data-live>—</div></section>
      ${s.metrics?.length ? `<section><h3>Measured</h3>${s.metrics.map(m => `<div class="ow-metric"><b>${html(m.value)}</b><span>${html(m.label)}</span>${m.source ? `<code>${html(m.source)}</code>` : ""}</div>`).join("")}</section>` : ""}
      <section data-changes hidden><h3>Recent changes</h3><div class="ow-changes"></div></section>
      ${s.links?.length ? `<section><h3>Links</h3><div class="ow-links">${s.links.map(l => `<a href="${html(l.href)}" target="_blank" rel="noreferrer">${html(l.label)} ↗</a>`).join("")}</div></section>` : ""}
      ${opts.dev?.toggleNote ? `<section class="ow-note-row"><button type="button" class="ow-btn ow-rec" data-action="note"><i></i>Voice note <kbd>N</kbd></button><span class="ow-dim">Talk and hold ⇧ to draw. It goes to ${s.board?.feature ?? "the board"}.</span></section>` : ""}`
    for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-variant]")) {
      b.addEventListener("click", () => { const v = variants.find(x => x.id === b.dataset.variant); if (v) chooseVariant(v) })
    }
    panel.querySelector('[data-action="grid"]')?.addEventListener("click", () => {
      const res = host.invoke("grid.open", { preset: s.grid })
      if (!res.ok) say(res.error, true)
      else say("Grid open: click a tile or press its number, Esc or G to close")
    })
    panel.querySelector('[data-action="ab"]')?.addEventListener("click", () => {
      const res = host.invoke("compare.pin-a")
      if (!res.ok) { say(res.error, true); return }
      abPending = true
      renderPanel()
      say("Pinned A. Pick a variant for B.")
    })
    panel.querySelector('[data-action="tune"]')?.addEventListener("click", () => host.chrome.set(true))
    panel.querySelector('[data-action="note"]')?.addEventListener("click", () => opts.dev?.toggleNote?.())
    if (changesFor === s.id && lastChanges) showChanges(lastChanges)
  }

  let lastChanges: StationChanges | null = null
  async function loadChanges(station: LabStation) {
    if (!opts.dev || (!station.paths?.length && !station.branches?.length)) return
    const id = station.id
    const changes = await opts.dev.changes(station).catch(() => null)
    if (!changes || current?.id !== id) return
    changesFor = id
    lastChanges = changes
    showChanges(changes)
  }
  function showChanges(c: StationChanges) {
    const box = panel.querySelector<HTMLElement>("[data-changes]")
    if (!box || (!c.commits.length && !c.branches.length)) return
    box.hidden = false
    box.querySelector(".ow-changes")!.innerHTML = [
      ...c.commits.map(x => `<div class="ow-change"><code>${html(x.sha)}</code><span>${html(x.subject)}</span><i>${html(x.when)}</i></div>`),
      ...c.branches.map(b => `<div class="ow-change ow-branch"><code>${html(b.name)}</code><span>+${b.ahead} · ${html(b.subject)}</span><i>${html(b.when)}</i></div>`),
    ].join("")
  }

  // ── per-frame: labels, glide, live readout ───────────────────────────────────────────────────────────────────
  let liveAt = 0
  function frame(now: number) {
    stepGlide(now)
    frameTimes.push(now)
    while (frameTimes.length && now - frameTimes[0]! > 1000) frameTimes.shift()
    if (view === "overworld" && !host.chrome.visible()) {
      labels.hidden = false
      const w = host.viewport.clientWidth, h = host.viewport.clientHeight
      for (const p of diorama.plots) {
        const b = labelEls.get(p.station.id)!
        const q = stage.projectWorld(p.x, 0.6, p.z + 5.9)
        b.hidden = !q.visible
        if (q.visible) b.style.transform = `translate(${(q.u * w).toFixed(1)}px, ${(q.v * h).toFixed(1)}px) translate(-50%, 0)`
      }
    } else labels.hidden = true
    if (view === "station" && now - liveAt > 500) {
      liveAt = now
      const live = panel.querySelector<HTMLElement>("[data-live]")
      if (live) {
        const gpu = stage.gpuMs
        const fps = frameTimes.length
        const first = (host.telemetry().split("\n")[0] ?? "").replace(/\s*\{.*$/, "")
        live.textContent = current?.demo.kind === "page" ? "Running in its own page" : `${gpu === null ? "GPU —" : `GPU ${gpu.toFixed(2)} ms`} · ${fps} fps${first ? ` · ${first}` : ""}`
      }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // Picking plots on the map: a click (no drag) opens, hovering outlines.
  let down: { x: number; y: number } | null = null
  const pick = (e: PointerEvent): Plot | null => {
    const r = host.canvas.getBoundingClientRect()
    const hit = stage.pickGround((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, () => 0.4)
    return hit ? plotAt(diorama.plots, hit.x, hit.z) : null
  }
  host.canvas.addEventListener("pointerdown", e => { if (e.button === 0) down = { x: e.clientX, y: e.clientY } })
  host.canvas.addEventListener("pointerup", e => {
    if (view !== "overworld" || !down || e.button !== 0) return
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    down = null
    if (moved > 4 || opts.dev?.noteActive?.()) return
    const p = pick(e)
    if (p) void travel(p.station.id)
  })
  host.canvas.addEventListener("pointermove", e => {
    if (view !== "overworld" || e.buttons) return
    const p = pick(e)
    if (p && p.station.id !== highlighted) setHighlight(p.station.id)
    host.canvas.style.cursor = p ? "pointer" : ""
  })

  // ── keyboard ─────────────────────────────────────────────────────────────────────────────────────────────────
  const typing = (e: KeyboardEvent) => {
    const t = e.composedPath()[0]
    return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)
  }
  const modalOpen = () => Boolean(document.querySelector(".lab-palette-backdrop:not([hidden]), .lab-modal-backdrop:not([hidden]), [data-ow-review]"))
  const digit = (e: KeyboardEvent) => (/^Digit[0-9]$/.test(e.code) ? Number(e.code.slice(5)) : null)
  const neighbour = (id: string, dx: number, dz: number) => {
    const p = plotOf(id)
    let best: Plot | null = null, bestD = Infinity
    for (const q of diorama.plots) {
      const vx = q.x - p.x, vz = q.z - p.z
      if (q === p || vx * dx + vz * dz <= 0.1) continue
      const d = Math.abs(vx * dz) + Math.abs(vz * dx) + Math.hypot(vx, vz)
      if (d < bestD) { bestD = d; best = q }
    }
    return best?.station.id ?? id
  }

  // Capture phase, so digits and arrows don't fall through to the workbench's Library and camera keys.
  window.addEventListener("keydown", e => {
    if (host.chrome.visible() || typing(e) || modalOpen() || e.metaKey || e.ctrlKey || e.altKey || host.mode() === "play") return
    const n = digit(e)
    if (view === "station") {
      if (n === null || e.shiftKey || host.gridOpen() || !current?.variants?.length) return
      const v = current.variants[n === 0 ? 9 : n - 1]
      if (v) { e.preventDefault(); e.stopImmediatePropagation(); chooseVariant(v) }
      return
    }
    if (n !== null && !e.shiftKey) {
      const target = ordered[n === 0 ? 9 : n - 1]
      if (target) { e.preventDefault(); e.stopImmediatePropagation(); void travel(target.station.id) }
      return
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const dir = arrows[e.key]
    if (dir && highlighted) { e.preventDefault(); e.stopImmediatePropagation(); setHighlight(neighbour(highlighted, dir[0], dir[1])); return }
    if (e.key === "Enter" && highlighted) { e.preventDefault(); e.stopImmediatePropagation(); void travel(highlighted) }
  }, { capture: true })

  // Bubble phase in a station: the workbench handles Esc first (selection, grid, Play) and we take what's left.
  window.addEventListener("keydown", e => {
    if (view !== "station" || e.defaultPrevented || typing(e) || modalOpen() || e.metaKey || e.ctrlKey || e.altKey) return
    if (host.mode() === "play") return
    if (e.key === "Escape" && !e.repeat) {
      if (opts.dev?.noteActive?.()) return
      if (host.chrome.visible()) { e.preventDefault(); host.chrome.set(false); return }
      e.preventDefault(); void back(); return
    }
    if (host.chrome.visible()) return
    if ((e.key === "[" || e.key === "]") && !e.repeat) { e.preventDefault(); void travel(step(e.key === "]" ? 1 : -1)) }
  })

  // Backquote shows the full workbench: hide our panels while it's open.
  new MutationObserver(() => { root.dataset.chrome = String(host.chrome.visible()) }).observe(host.viewport.closest("[data-lab-workbench]")!, { attributes: true, attributeFilter: ["data-closed"] })

  // ── commands (⌘K, radial, `arcade station`) ──────────────────────────────────────────────────────────────────
  host.commands.register({
    id: "station.open",
    aliases: ["station", "overworld.station"],
    label: "Open Lab Station",
    shortLabel: "Station",
    category: "Navigation",
    args: { id: { type: "string", required: true, description: `Station id: ${ordered.map(o => o.station.id).join(", ")}` } },
    enabled: () => host.mode() !== "play",
    disabledReason: () => "Unavailable in Play mode. Run 'arcade release' first.",
    run: (_ctx, args) => {
      const id = String(args?.id ?? "").trim().toLowerCase()
      const found = byId.get(id) ?? ordered.find(o => o.station.title.toLowerCase() === id)
      if (!found) throw new Error(`Unknown station "${id}". Stations: ${ordered.map(o => o.station.id).join(", ")}.`)
      void travel(found.station.id)
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
    run: () => ({ view, current: current?.id ?? null, stations: ordered.map(o => ({ id: o.station.id, key: o.key, title: o.station.title, status: o.station.status, board: o.station.board?.feature ?? null })) }),
  })
  host.commands.register({
    id: "station.variant",
    label: "Choose Station Variant",
    shortLabel: "Variant",
    category: "Navigation",
    args: { id: { type: "value", required: true, description: "Variant id, label or 1-based number" } },
    enabled: () => view === "station" && Boolean(current?.variants?.length),
    disabledReason: () => "Open a station with variants first.",
    run: (_ctx, args) => {
      const raw = String(args?.id ?? "").trim().toLowerCase()
      const list = current?.variants ?? []
      const v = list.find(x => x.id === raw || x.label.toLowerCase() === raw) ?? list[Number(raw) - 1]
      if (!v) throw new Error(`Unknown variant "${raw}". Variants: ${list.map(x => x.id).join(", ")}.`)
      chooseVariant(v)
      return { station: current?.id, variant: v.id }
    },
  })
  host.commands.register({
    id: "overworld.show",
    aliases: ["overworld"],
    label: "Back to the Lab Overworld",
    shortLabel: "Overworld",
    category: "Navigation",
    shortcut: "Esc",
    enabled: () => true,
    run: () => { void back(); return { view: "overworld" } },
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
      run: () => { void travel(station.id); return { station: station.id } },
    })
  }

  return {
    /** Shows the map (or opens `station` straight away) once the Lab has started. */
    async start(station?: string | null) {
      host.chrome.set(false)
      root.dataset.view = "overworld"
      root.dataset.chrome = "false"
      host.select("overworld")
      writeCamera(overview())
      setHighlight(highlighted)
      renderPanel()
      if (station && byId.has(station)) {
        writeCamera(plotCamera(plotOf(station)))
        await open(byId.get(station)!.station)
      }
    },
    travel,
    back,
    returnCamera,
    say,
    on(listener: (e: OverworldEvent) => void) { listeners.add(listener); return () => listeners.delete(listener) },
    snapshot(): OverworldSnapshot {
      return { view, station: current, variant, section: current?.demo.kind === "section" && !missing ? current.demo.section : null, camera: readCamera(), url: location.href }
    },
    capturePage,
    /** Re-renders the panel (the recorder calls this when it starts or stops). */
    refresh: () => renderPanel(),
    root,
  }
}

export type OverworldController = ReturnType<typeof createOverworld>
