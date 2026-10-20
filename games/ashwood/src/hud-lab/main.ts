import corridor from "./bg/corridor.jpg"
import room308 from "./bg/room-308.jpg"
import lot from "./bg/lot.jpg"
import mapBg from "./bg/map.jpg"
import { HINT_KEYS, HINT_VARIANTS, OBJECTIVES, OBJECTIVE_VARIANTS, PROMPT_VARIANTS, hintsHtml, objectiveHtml, promptHtml } from "./variants"
import "./lab.css"

// HUD Lab (dev only, temporary): objective, hint and E-prompt variants over frozen game frames (src/hud-lab/bg,
// rendered by capture-bg.ts). One big stage with the picked combination, or a grid of every objective variant.
// Entrance buttons replay a new objective arriving and a hint appearing. "Copy JSON" exports the pick.

const BGS = { corridor: ["Corridor", corridor], room: ["3-08 with the bodies", room308], lot: ["Dark lot", lot], map: ["Clipboard map (M)", mapBg] } as const
type Bg = keyof typeof BGS
type State = { bg: Bg; objective: string; hints: string; prompt: string; text: number; showPrompt: boolean; verb: string; grid: boolean; used: string[] }
const KEY = "hudLab.v1"
const DEFAULTS: State = { bg: "room", objective: "note", hints: "context", prompt: "current", text: 0, showPrompt: true, verb: "Move the body", grid: false, used: [] }
const state: State = (() => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<State>) }
  } catch {
    return { ...DEFAULTS }
  }
})()
const save = () => localStorage.setItem(KEY, JSON.stringify(state))
const opt = (list: { id: string; name: string }[]) => list.map((v) => `<option value="${v.id}">${v.name}</option>`).join("")

for (const [family, file] of [["Afterhours Type", "SpecialElite-hud.woff2"], ["Caveat Map", "Caveat-map.woff2"], ["Archivo Map", "ArchivoBlack-Regular-map.woff2"], ["Oswald Map", "Oswald-map.woff2"]] as const) {
  const f = new FontFace(family, `url(${new URL(`fonts/${file}`, document.baseURI).href})`)
  document.fonts.add(f)
  void f.load().catch(() => {})
}

const app = document.querySelector<HTMLDivElement>("#app")!
app.innerHTML = `
  <aside class="hl-side">
    <h1>HUD Lab</h1>
    <p class="hl-help">Only crouch and flashlight (and maybe the map) are taught; E prompts are contextual.</p>
    <div class="hl-field">Frame <select id="bg">${Object.entries(BGS).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join("")}</select></div>
    <div class="hl-field">Objective <select id="objective">${opt(OBJECTIVE_VARIANTS)}</select></div>
    <p class="hl-note" id="obj-note"></p>
    <div class="hl-field">Text <select id="text">${OBJECTIVES.map((t, i) => `<option value="${i}">${t}</option>`).join("")}</select></div>
    <div class="hl-field">Hints <select id="hints">${opt(HINT_VARIANTS)}</select></div>
    <p class="hl-note" id="hint-note"></p>
    <div class="hl-field">E prompt <select id="prompt">${opt(PROMPT_VARIANTS)}</select></div>
    <div class="hl-field">Prompt verb <select id="verb">${["Open", "Move the body", "Search", "Locked", "Take keys"].map((v) => `<option>${v}</option>`).join("")}</select></div>
    <label class="hl-check"><input type="checkbox" id="showPrompt"> show the E prompt</label>
    <h2>Play</h2>
    <div class="hl-btns">
      <button id="next">New objective arrives</button>
      <button id="recall">M (recall objective)</button>
      <button id="hintC">Hint: C appears</button>
      <button id="hintF">Hint: F appears</button>
      <button id="useC">Use C</button>
      <button id="useF">Use F</button>
      <button id="mapHint">Map unlocked (adds M)</button>
      <button id="resetUse">Reset hints</button>
    </div>
    <label class="hl-check"><input type="checkbox" id="grid"> compare every objective variant</label>
    <div class="hl-btns"><button id="copy" class="accent">Copy JSON</button></div>
    <pre class="hl-json" id="json"></pre>
  </aside>
  <main class="hl-main" id="main"></main>`
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const main = $<HTMLElement>("main")

let context: number | null = null
let contextTimer = 0
let fadeTimer = 0

function stageHtml(objective: string, label?: string) {
  const used = new Set(state.used)
  return `<figure class="hl-card"><div class="hl-frame"><div class="hl-stage" style="background-image:url(${BGS[state.bg][1]})">
      <div class="layer obj-layer">${objectiveHtml(objective, OBJECTIVES[state.text]!)}</div>
      <div class="layer">${hintsHtml(state.hints, used, context)}</div>
      ${state.showPrompt && state.bg !== "map" ? `<div class="layer">${promptHtml(state.prompt, state.verb)}</div>` : ""}
    </div></div>${label ? `<figcaption>${label}</figcaption>` : ""}</figure>`
}

function render(arrive = false) {
  main.classList.toggle("grid", state.grid)
  main.innerHTML = state.grid
    ? OBJECTIVE_VARIANTS.map((v) => stageHtml(v.id, v.name)).join("")
    : stageHtml(state.objective)
  rescale()
  if (arrive) for (const el of main.querySelectorAll<HTMLElement>(".obj")) enter(el)
  $<HTMLElement>("obj-note").textContent = OBJECTIVE_VARIANTS.find((v) => v.id === state.objective)?.note ?? ""
  $<HTMLElement>("hint-note").textContent = HINT_VARIANTS.find((v) => v.id === state.hints)?.note ?? ""
  $<HTMLPreElement>("json").textContent = exportJson()
}

/** An objective arriving: its variant's CSS entrance, plus typing for the typed ones. */
function enter(el: HTMLElement) {
  el.classList.remove("enter")
  void el.offsetWidth
  el.classList.add("enter")
  const typed = el.querySelector<HTMLElement>(".typed")
  if (typed) {
    const full = typed.dataset.text ?? ""
    let i = 0
    typed.textContent = ""
    const id = setInterval(() => {
      typed.textContent = full.slice(0, ++i)
      if (i >= full.length) clearInterval(id)
    }, el.classList.contains("obj-teletype") ? 28 : 45)
  }
  if (el.classList.contains("obj-transient")) {
    clearTimeout(fadeTimer)
    el.classList.remove("out")
    fadeTimer = window.setTimeout(() => main.querySelectorAll(".obj-transient").forEach((e) => e.classList.add("out")), 4500)
  }
}

function rescale() {
  const f = main.querySelector<HTMLElement>(".hl-frame")
  if (f) main.style.setProperty("--scale", String(f.clientWidth / 1600))
}
new ResizeObserver(rescale).observe(main)

function sync() {
  for (const k of ["bg", "objective", "hints", "prompt", "verb"] as const) $<HTMLSelectElement>(k).value = state[k]
  $<HTMLSelectElement>("text").value = String(state.text)
  $<HTMLInputElement>("showPrompt").checked = state.showPrompt
  $<HTMLInputElement>("grid").checked = state.grid
}
for (const k of ["bg", "objective", "hints", "prompt", "verb"] as const)
  $<HTMLSelectElement>(k).addEventListener("change", (e) => {
    ;(state as Record<string, unknown>)[k] = (e.target as HTMLSelectElement).value
    save()
    render(k === "objective")
  })
$<HTMLSelectElement>("text").addEventListener("change", (e) => {
  state.text = Number((e.target as HTMLSelectElement).value)
  save()
  render(true)
})
for (const k of ["showPrompt", "grid"] as const)
  $<HTMLInputElement>(k).addEventListener("change", (e) => {
    state[k] = (e.target as HTMLInputElement).checked
    save()
    render()
  })
$<HTMLButtonElement>("next").addEventListener("click", () => {
  state.text = (state.text + 1) % OBJECTIVES.length
  sync()
  save()
  render(true)
})
$<HTMLButtonElement>("recall").addEventListener("click", () => render(true))
const showContext = (i: number) => {
  context = i
  clearTimeout(contextTimer)
  render()
  main.querySelectorAll<HTMLElement>(".hint").forEach((h) => h.classList.add("enter"))
  contextTimer = window.setTimeout(() => {
    main.querySelectorAll(".hint-context").forEach((h) => h.classList.add("out"))
    setTimeout(() => ((context = null), render()), 900)
  }, 5000)
}
$<HTMLButtonElement>("hintC").addEventListener("click", () => showContext(0))
$<HTMLButtonElement>("hintF").addEventListener("click", () => showContext(1))
const use = (k: string) => {
  if (!state.used.includes(k)) state.used.push(k)
  save()
  render()
}
$<HTMLButtonElement>("useC").addEventListener("click", () => use("C"))
$<HTMLButtonElement>("useF").addEventListener("click", () => use("F"))
$<HTMLButtonElement>("mapHint").addEventListener("click", () => {
  use("withMap")
  showContext(2)
})
$<HTMLButtonElement>("resetUse").addEventListener("click", () => {
  state.used = []
  context = null
  save()
  render()
})

function exportJson() {
  return JSON.stringify({ objective: state.objective, hints: state.hints, prompt: state.prompt }, null, 2)
}
$<HTMLButtonElement>("copy").addEventListener("click", async (e) => {
  const b = e.currentTarget as HTMLButtonElement
  await navigator.clipboard.writeText(exportJson()).catch(() => {})
  b.textContent = "Copied"
  setTimeout(() => (b.textContent = "Copy JSON"), 1200)
})
addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.target as HTMLElement).matches("select, input")) return
  if (e.code === "KeyM") render(true)
})

sync()
void document.fonts.ready.then(() => render(true))
;(globalThis as { __hudLab?: unknown }).__hudLab = { state, render, showContext }
