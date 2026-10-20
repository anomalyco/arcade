import { DRAFTS } from "./drafts"
import { unlockSound } from "./sound"
import { createTyper, type TypeSettings } from "./typer"
import "./lab.css"

// Prelude Lab (dev only, temporary): the opening text typed out on one screen, in the title card's look. Four
// panels run different typing settings over the same text; the sidebar edits the selected panel. Click a panel for
// fullscreen (← → switch, Space replay, Esc close). "Copy JSON" exports the text and the selected panel's settings.

type State = { draft: string; text: string; panels: TypeSettings[]; selected: number; loop: boolean }

const PANEL_DEFAULTS: TypeSettings[] = [
  { label: "A", cps: 24, rhythm: "human", cursor: "bar", blink: "idle", cursorAfter: true, sound: "off", volume: 0.5, dwell: 6, fade: "fade", fadeTime: 2.5, align: "draft" },
  { label: "B", cps: 14, rhythm: "even", cursor: "block", blink: "idle", cursorAfter: true, sound: "off", volume: 0.5, dwell: 6, fade: "dim", fadeTime: 3, align: "draft" },
  { label: "C", cps: 40, rhythm: "teletype", cursor: "underscore", blink: "always", cursorAfter: false, sound: "off", volume: 0.5, dwell: 5, fade: "cut", fadeTime: 0.5, align: "draft" },
  { label: "D", cps: 30, rhythm: "line", cursor: "none", blink: "solid", cursorAfter: false, sound: "off", volume: 0.5, dwell: 6, fade: "lines", fadeTime: 3, align: "draft" },
]
const KEY = "preludeLab.v1"
const DEFAULTS: State = { draft: "card", text: DRAFTS[1]!.text, panels: PANEL_DEFAULTS, selected: 0, loop: true }
const state: State = (() => {
  try {
    const s = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<State>) }
    s.panels = PANEL_DEFAULTS.map((d, i) => ({ ...d, ...(s.panels[i] ?? {}) }))
    return s
  } catch {
    return structuredClone(DEFAULTS)
  }
})()
const save = () => localStorage.setItem(KEY, JSON.stringify(state))
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const draftAlign = () => DRAFTS.find((d) => d.id === state.draft)?.align ?? "center"
const opt = (pairs: [string, string][]) => pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")

const app = document.querySelector<HTMLDivElement>("#app")!
app.innerHTML = `
  <aside class="pl-side">
    <h1>Prelude Lab</h1>
    <p class="pl-help">Click a panel for fullscreen · ← → switch · Space replay · Esc close</p>
    <div class="pl-drafts" id="drafts"></div>
    <label class="pl-field pl-col">Text <small>(edits replay live; blank line = gap)</small><textarea id="text" rows="10" spellcheck="false"></textarea></label>
    <div class="pl-tabs" id="tabs"></div>
    <div class="pl-field">Speed <span class="pl-btns" id="speeds"><button data-cps="14">slow</button><button data-cps="24">medium</button><button data-cps="40">fast</button></span></div>
    <div class="pl-field">Chars / s <input id="cps" type="range" min="4" max="90" step="1"><output id="cps-o"></output></div>
    <div class="pl-field">Rhythm <select id="rhythm">${opt([["even", "Even typewriter"], ["human", "Human (irregular, pauses)"], ["teletype", "Teletype bursts"], ["line", "Per-line reveal"]])}</select></div>
    <div class="pl-field">Cursor <select id="cursor">${opt([["none", "None"], ["bar", "Bar |"], ["block", "Block █"], ["underscore", "Underscore _"]])}</select></div>
    <div class="pl-field">Blink <select id="blink">${opt([["idle", "Only when idle"], ["always", "Always"], ["solid", "Never (solid)"]])}</select></div>
    <label class="pl-check"><input type="checkbox" id="cursorAfter"> keep cursor after the last line</label>
    <div class="pl-field">Sound <select id="sound">${opt([["off", "Off"], ["typewriter", "Typewriter"], ["teletype", "Teletype"]])}</select></div>
    <div class="pl-field">Volume <input id="volume" type="range" min="0" max="1" step="0.05"><output id="volume-o"></output></div>
    <div class="pl-field">Dwell <input id="dwell" type="range" min="0" max="20" step="0.5"><output id="dwell-o"></output></div>
    <div class="pl-field">Fade out <select id="fade">${opt([["fade", "Fade to black"], ["lines", "Line by line"], ["dim", "Dim and hold"], ["cut", "Cut to black"], ["hold", "Hold (no fade)"]])}</select></div>
    <div class="pl-field">Fade time <input id="fadeTime" type="range" min="0.2" max="8" step="0.1"><output id="fadeTime-o"></output></div>
    <div class="pl-field">Align <select id="align">${opt([["draft", "Draft's own"], ["center", "Centred"], ["left", "Left block"]])}</select></div>
    <label class="pl-check"><input type="checkbox" id="loop"> loop</label>
    <div class="pl-actions"><button id="replay">Replay all</button><button id="copy">Copy JSON</button><button id="reset">Reset panels</button></div>
    <pre class="pl-json" id="json"></pre>
  </aside>
  <main class="pl-grid" id="grid"></main>
  <div class="pl-full" id="full" hidden><div class="pl-full-frame" id="full-frame"></div><div class="pl-full-bar" id="full-bar"></div></div>`
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

// Drafts.
const draftsEl = $<HTMLElement>("drafts")
function renderDrafts() {
  draftsEl.innerHTML =
    DRAFTS.map((d) => `<button data-id="${d.id}" class="${state.draft === d.id ? "on" : ""}">${esc(d.name)}</button>`).join("") +
    `<button data-id="custom" class="${state.draft === "custom" ? "on" : ""}" disabled>Custom (edited)</button>`
}
draftsEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]")
  const d = DRAFTS.find((x) => x.id === b?.dataset.id)
  if (!d) return
  state.draft = d.id
  state.text = d.text
  $<HTMLTextAreaElement>("text").value = d.text
  save()
  renderDrafts()
  replayAll()
})
let editTimer = 0
$<HTMLTextAreaElement>("text").addEventListener("input", (e) => {
  state.text = (e.target as HTMLTextAreaElement).value
  if (state.draft !== "custom" && DRAFTS.find((d) => d.id === state.draft)?.text !== state.text) {
    // Keep the edited draft's alignment.
    customAlign = draftAlign()
    state.draft = "custom"
    renderDrafts()
  }
  save()
  clearTimeout(editTimer)
  editTimer = window.setTimeout(replayAll, 400)
})
let customAlign: "center" | "left" = draftAlign()

// Panels.
let full: number | null = null
const grid = $<HTMLElement>("grid")
const panels = state.panels.map((_, i) => {
  const fig = document.createElement("figure")
  fig.className = "pl-card"
  fig.innerHTML = `<div class="pl-frame"><div class="pl-screen"></div></div><figcaption></figcaption>`
  grid.append(fig)
  const screen = fig.querySelector<HTMLElement>(".pl-screen")!
  const typer = createTyper(screen, () => (full === null ? state.selected === i : full === i))
  fig.addEventListener("click", () => {
    unlockSound()
    select(i)
    openFull(i)
  })
  return { fig, screen, typer, caption: fig.querySelector("figcaption")! }
})
const fullTyper = createTyper($<HTMLElement>("full-frame"), () => true)

const describe = (s: TypeSettings) =>
  `${s.cps} cps · ${{ even: "even", human: "human", teletype: "teletype", line: "per line" }[s.rhythm]} · cursor ${s.cursor}${s.cursor !== "none" ? ` (${s.blink})` : ""} · ${s.dwell}s then ${s.fade}${s.sound !== "off" ? ` · ${s.sound}` : ""}`
function captions() {
  panels.forEach((p, i) => {
    p.fig.classList.toggle("sel", i === state.selected)
    p.caption.innerHTML = `<b>${state.panels[i]!.label}</b> ${esc(describe(state.panels[i]!))}`
  })
  $<HTMLElement>("tabs").innerHTML = state.panels.map((p, i) => `<button data-i="${i}" class="${i === state.selected ? "on" : ""}">Edit ${p.label}</button>`).join("")
  $<HTMLPreElement>("json").textContent = exportJson()
}
$<HTMLElement>("tabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-i]")
  if (b) select(Number(b.dataset.i))
})

function textAlign() {
  return state.draft === "custom" ? customAlign : draftAlign()
}
function playPanel(i: number) {
  const p = panels[i]!
  p.screen.dataset.draftAlign = textAlign()
  p.typer.play(state.text, state.panels[i]!, state.loop)
}
function replayAll() {
  panels.forEach((_, i) => playPanel(i))
  if (full !== null) playFull()
  captions()
}

// Sidebar ↔ the selected panel.
const NUMS = ["cps", "volume", "dwell", "fadeTime"] as const
const SELECTS = ["rhythm", "cursor", "blink", "sound", "fade", "align"] as const
const UNITS: Record<(typeof NUMS)[number], (v: number) => string> = { cps: (v) => `${v}`, volume: (v) => `${Math.round(v * 100)}%`, dwell: (v) => `${v}s`, fadeTime: (v) => `${v}s` }
function syncControls() {
  const s = state.panels[state.selected]!
  for (const k of NUMS) {
    $<HTMLInputElement>(k).value = String(s[k])
    $<HTMLOutputElement>(`${k}-o`).textContent = UNITS[k](s[k])
  }
  for (const k of SELECTS) $<HTMLSelectElement>(k).value = String(s[k])
  $<HTMLInputElement>("cursorAfter").checked = s.cursorAfter
  $<HTMLInputElement>("loop").checked = state.loop
}
function select(i: number) {
  state.selected = i
  save()
  syncControls()
  captions()
}
function edited(replay = true) {
  save()
  syncControls()
  captions()
  if (replay) {
    playPanel(state.selected)
    if (full === state.selected) playFull()
  }
}
for (const k of NUMS)
  $<HTMLInputElement>(k).addEventListener("input", (e) => {
    state.panels[state.selected]![k] = Number((e.target as HTMLInputElement).value)
    edited(k !== "volume")
  })
for (const k of SELECTS)
  $<HTMLSelectElement>(k).addEventListener("change", (e) => {
    ;(state.panels[state.selected] as Record<string, unknown>)[k] = (e.target as HTMLSelectElement).value
    if (k === "sound") unlockSound()
    edited()
  })
$<HTMLInputElement>("cursorAfter").addEventListener("change", (e) => {
  state.panels[state.selected]!.cursorAfter = (e.target as HTMLInputElement).checked
  edited()
})
$<HTMLInputElement>("loop").addEventListener("change", (e) => {
  state.loop = (e.target as HTMLInputElement).checked
  save()
  replayAll()
})
$<HTMLElement>("speeds").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-cps]")
  if (!b) return
  state.panels[state.selected]!.cps = Number(b.dataset.cps)
  edited()
})
$<HTMLButtonElement>("replay").addEventListener("click", () => {
  unlockSound()
  replayAll()
})
$<HTMLButtonElement>("reset").addEventListener("click", () => {
  state.panels = structuredClone(PANEL_DEFAULTS)
  edited(false)
  replayAll()
})

function exportJson() {
  const { label: _label, ...settings } = state.panels[state.selected]!
  const align = settings.align === "draft" ? textAlign() : settings.align
  return JSON.stringify({ draft: state.draft, text: state.text, settings: { ...settings, align } }, null, 2)
}
$<HTMLButtonElement>("copy").addEventListener("click", async (e) => {
  const b = e.currentTarget as HTMLButtonElement
  const json = exportJson()
  try {
    await navigator.clipboard.writeText(json)
  } catch {
    const ta = document.createElement("textarea")
    ta.value = json
    document.body.append(ta)
    ta.select()
    document.execCommand("copy")
    ta.remove()
  }
  b.textContent = "Copied"
  setTimeout(() => (b.textContent = "Copy JSON"), 1200)
})

// Fullscreen.
const fullEl = $<HTMLElement>("full")
function rescale() {
  const card = grid.querySelector<HTMLElement>(".pl-frame")
  if (card) grid.style.setProperty("--scale", String(card.clientWidth / 1280))
  fullEl.style.setProperty("--scale", String(Math.min(innerWidth / 1280, (innerHeight - 44) / 720)))
}
new ResizeObserver(rescale).observe(grid)
addEventListener("resize", rescale)
function playFull() {
  if (full === null) return
  $<HTMLElement>("full-frame").dataset.draftAlign = textAlign()
  fullTyper.play(state.text, state.panels[full]!, state.loop)
  $<HTMLElement>("full-bar").innerHTML = `<b>${state.panels[full]!.label}</b><span>${esc(describe(state.panels[full]!))}</span><span class="pl-keys">← → switch · Space replay · Esc close</span>`
}
function openFull(i: number) {
  full = i
  fullEl.hidden = false
  rescale()
  playFull()
}
function closeFull() {
  full = null
  fullEl.hidden = true
  fullTyper.stop()
}
fullEl.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".pl-full-bar")) closeFull()
})
addEventListener("keydown", (e: KeyboardEvent) => {
  if (full === null || (e.target as HTMLElement).matches("textarea, input, select")) return
  unlockSound()
  if (e.key === "Escape") closeFull()
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    const i = (full + (e.key === "ArrowRight" ? 1 : panels.length - 1)) % panels.length
    select(i)
    openFull(i)
  } else if (e.key === " ") playFull()
  else return
  e.preventDefault()
})

// Font first, so the first layout uses the typewriter face.
const face = new FontFace("Static Type", `url(${new URL("fonts/SpecialElite-hud.woff2", document.baseURI).href})`)
document.fonts.add(face)
$<HTMLTextAreaElement>("text").value = state.text
renderDrafts()
syncControls()
void face
  .load()
  .catch(() => {})
  .then(() => {
    rescale()
    replayAll()
  })
;(globalThis as { __preludeLab?: unknown }).__preludeLab = { state, openFull, replayAll }
