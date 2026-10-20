import corridor from "../hud-lab/bg/corridor.jpg"
import room308 from "../hud-lab/bg/room-308.jpg"
import lot from "../hud-lab/bg/lot.jpg"
import mapBg from "../hud-lab/bg/map.jpg"
import { CONTROLS, VARIANTS, controlsHtml, type CapStyle, type Fade, type View } from "./variants"
import "./lab.css"

// Controls Lab (dev only, temporary): how the controls are shown on screen, over the HUD lab's frozen frames, with the
// picked objective style (centred title settling into the top-left small caps). One stage, or every variant at once.
// Captures: scripts/controls-lab/shots.ts (Playwright stays out of src/).

const BGS = { corridor: ["Corridor", corridor], room: ["3-08 with the bodies", room308], lot: ["Dark lot", lot], map: ["Clipboard map (M)", mapBg] } as const
type Bg = keyof typeof BGS
type State = {
  bg: Bg
  variant: string
  style: CapStyle
  size: number
  opacity: number
  dx: number
  dy: number
  fade: Fade
  fadeSeconds: number
  grid: boolean
}
const KEY = "controlsLab.v1"
const DEFAULTS: State = { bg: "corridor", variant: "strip", style: "outline", size: 1, opacity: 0.8, dx: 0, dy: 0, fade: "always", fadeSeconds: 10, grid: false }
const state: State = (() => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<State>) }
  } catch {
    return { ...DEFAULTS }
  }
})()
const save = () => localStorage.setItem(KEY, JSON.stringify(state))
/** Session only: what's been used, recall open, the contextual key, the timed fade. */
const used = new Set<string>()
let recalled = false
let context: string | null = null
let faded = false
let fadeTimer = 0

for (const [family, file] of [["Ashwood Type", "SpecialElite-hud.woff2"], ["Caveat Map", "Caveat-map.woff2"], ["Archivo Map", "ArchivoBlack-Regular-map.woff2"]] as const) {
  const f = new FontFace(family, `url(${new URL(`fonts/${file}`, document.baseURI).href})`)
  document.fonts.add(f)
  void f.load().catch(() => {})
}

const opt = (pairs: [string, string][]) => pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")
const app = document.querySelector<HTMLDivElement>("#app")!
app.innerHTML = `
  <aside class="cl-side">
    <h1>Controls Lab</h1>
    <p class="cl-help">How the controls show on screen. H / Tab = recall, Esc = pause screen (variant 10).</p>
    <div class="cl-field">Frame <select id="bg">${opt(Object.entries(BGS).map(([k, [n]]) => [k, n]))}</select></div>
    <div class="cl-field">Variant <select id="variant">${opt(VARIANTS.map((v) => [v.id, v.name]))}</select></div>
    <p class="cl-note" id="note"></p>
    <div class="cl-field">Key caps <select id="style">${opt([["outline", "Outlined"], ["filled", "Filled"], ["typewriter", "Typewriter key"], ["bracket", "Plain [E] text"]])}</select></div>
    <div class="cl-field">Size <input id="size" type="range" min="0.7" max="1.6" step="0.05"><output id="size-o"></output></div>
    <div class="cl-field">Opacity <input id="opacity" type="range" min="0.2" max="1" step="0.05"><output id="opacity-o"></output></div>
    <div class="cl-field">Offset X <input id="dx" type="range" min="-200" max="200" step="2"><output id="dx-o"></output></div>
    <div class="cl-field">Offset Y <input id="dy" type="range" min="-200" max="200" step="2"><output id="dy-o"></output></div>
    <div class="cl-field">Fade <select id="fade">${opt([["always", "Always shown"], ["seconds", "Fade after N seconds"], ["firstUse", "Fade after first use"]])}</select></div>
    <div class="cl-field">N seconds <input id="fadeSeconds" type="range" min="3" max="60" step="1"><output id="fadeSeconds-o"></output></div>
    <h2>Simulate</h2>
    <div class="cl-btns">
      <button id="start">Run starts (replay)</button>
      <button id="recall">Recall (H / Tab / Esc)</button>
      ${["crouch", "torch", "map", "jump", "use", "search"].map((id) => `<button data-use="${id}">Use ${CONTROLS.find((c) => c.id === id)!.word}</button>`).join("")}
      <button data-ctx="torch">Context: dark</button>
      <button data-ctx="crouch">Context: low space</button>
      <button data-ctx="jump">Context: ledge</button>
      <button data-ctx="search">Context: searchable</button>
      <button id="objective">Objective arrives</button>
      <button id="reset">Reset use</button>
    </div>
    <label class="cl-check"><input type="checkbox" id="grid"> show all variants at once</label>
    <div class="cl-btns"><button id="copy" class="accent">Copy JSON</button></div>
    <pre class="cl-json" id="json"></pre>
  </aside>
  <main class="cl-main" id="main"></main>`
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const main = $<HTMLElement>("main")

const OBJECTIVE = "Find the radio room: 3-08"
function stage(variant: string, label?: string) {
  const v: View = { style: state.style, used, recalled, context, faded, fade: state.fade }
  return `<figure class="cl-card"><div class="cl-frame"><div class="cl-stage" style="background-image:url(${BGS[state.bg][1]});--s:${state.size};--o:${state.opacity};--dx:${state.dx}px;--dy:${state.dy}px">
      <div class="obj-corner"><small>Objective</small><span>${OBJECTIVE}</span></div>
      <div class="obj-title"></div>
      <div class="ctl-layer">${controlsHtml(variant, v)}</div>
    </div></div>${label ? `<figcaption>${label}</figcaption>` : ""}</figure>`
}

function render() {
  main.classList.toggle("grid", state.grid)
  main.innerHTML = state.grid ? VARIANTS.map((v) => stage(v.id, v.name)).join("") : stage(state.variant)
  rescale()
  $<HTMLElement>("note").textContent = VARIANTS.find((v) => v.id === state.variant)?.note ?? ""
  for (const k of ["size", "opacity", "dx", "dy", "fadeSeconds"] as const)
    $<HTMLOutputElement>(`${k}-o`).textContent = k === "opacity" ? `${Math.round(state[k] * 100)}%` : k === "size" ? `${state[k].toFixed(2)}×` : k === "fadeSeconds" ? `${state[k]}s` : `${state[k]}`
  $<HTMLPreElement>("json").textContent = exportJson()
}
function rescale() {
  const f = main.querySelector<HTMLElement>(".cl-frame")
  if (f) main.style.setProperty("--scale", String(f.clientWidth / 1600))
}
new ResizeObserver(rescale).observe(main)

/** A run starting: the timed fade restarts (the cheat card always uses N seconds, ~10 by default). */
function start() {
  faded = false
  recalled = false
  clearTimeout(fadeTimer)
  render()
  main.querySelectorAll(".ctl").forEach((e) => e.classList.add("enter"))
  if (state.fade === "seconds" || state.variant === "card" || state.grid)
    fadeTimer = window.setTimeout(() => ((faded = true), render()), state.fadeSeconds * 1000)
}

/** The picked objective: types in centred, holds, fades; the corner line brightens. */
function objective() {
  for (const t of main.querySelectorAll<HTMLElement>(".obj-title")) {
    const corner = t.parentElement!.querySelector<HTMLElement>(".obj-corner")!
    corner.classList.add("hidden")
    t.classList.remove("out")
    t.classList.add("on")
    let n = 0
    const id = setInterval(() => {
      t.textContent = OBJECTIVE.slice(0, ++n)
      if (n >= OBJECTIVE.length) {
        clearInterval(id)
        setTimeout(() => {
          t.classList.add("out")
          setTimeout(() => corner.classList.remove("hidden"), 1000)
        }, 3500)
      }
    }, 45)
  }
}

function sync() {
  for (const k of ["bg", "variant", "style", "fade"] as const) $<HTMLSelectElement>(k).value = state[k]
  for (const k of ["size", "opacity", "dx", "dy", "fadeSeconds"] as const) $<HTMLInputElement>(k).value = String(state[k])
  $<HTMLInputElement>("grid").checked = state.grid
}
for (const k of ["bg", "variant", "style", "fade"] as const)
  $<HTMLSelectElement>(k).addEventListener("change", (e) => {
    ;(state as Record<string, unknown>)[k] = (e.target as HTMLSelectElement).value
    save()
    if (k === "variant" || k === "fade") start()
    else render()
  })
for (const k of ["size", "opacity", "dx", "dy", "fadeSeconds"] as const)
  $<HTMLInputElement>(k).addEventListener("input", (e) => {
    state[k] = Number((e.target as HTMLInputElement).value)
    save()
    render()
  })
$<HTMLInputElement>("grid").addEventListener("change", (e) => {
  state.grid = (e.target as HTMLInputElement).checked
  save()
  start()
})
$<HTMLButtonElement>("start").addEventListener("click", start)
const toggleRecall = () => ((recalled = !recalled), render())
$<HTMLButtonElement>("recall").addEventListener("click", toggleRecall)
$<HTMLButtonElement>("objective").addEventListener("click", objective)
app.querySelectorAll<HTMLButtonElement>("[data-use]").forEach((b) =>
  b.addEventListener("click", () => {
    used.add(b.dataset.use!)
    if (context === b.dataset.use) context = null
    render()
  }),
)
app.querySelectorAll<HTMLButtonElement>("[data-ctx]").forEach((b) =>
  b.addEventListener("click", () => {
    context = b.dataset.ctx!
    used.delete(context)
    render()
    main.querySelectorAll(".ctl-context").forEach((e) => e.classList.add("enter"))
  }),
)
$<HTMLButtonElement>("reset").addEventListener("click", () => {
  used.clear()
  context = null
  start()
})
addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.target as HTMLElement).matches("select, input")) return
  if (e.code === "KeyH" || e.code === "Tab" || e.code === "Escape") {
    e.preventDefault()
    toggleRecall()
  }
})

function exportJson() {
  const { grid: _g, bg: _b, ...rest } = state
  return JSON.stringify(rest, null, 2)
}
$<HTMLButtonElement>("copy").addEventListener("click", async (e) => {
  const b = e.currentTarget as HTMLButtonElement
  await navigator.clipboard.writeText(exportJson()).catch(() => {})
  b.textContent = "Copied"
  setTimeout(() => (b.textContent = "Copy JSON"), 1200)
})

sync()
void document.fonts.ready.then(start)
;(globalThis as { __controlsLab?: unknown }).__controlsLab = { state, start, objective, recall: toggleRecall, use: (id: string) => (used.add(id), render()), setContext: (id: string) => ((context = id), render()) }
