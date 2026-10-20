import bg from "./home-bg.jpg"
import { FONTS, GROUPS, loadFonts } from "./fonts"
import "./lab.css"

// Title Lab (dev only, temporary): the home screen at thumbnail size for every name × font, over a freeze frame of the
// real menu view (scripts/title-lab/capture-bg.ts), with the menu's overlays. Style controls are CSS variables and classes
// on the root, so only names / fonts / case / filters rebuild the grid. State persists in localStorage.

type Treatment = "plain" | "glow" | "vhs" | "jitter" | "tracking" | "typewriter" | "crt"
const TREATMENTS: { id: Treatment; label: string }[] = [
  { id: "plain", label: "Plain" },
  { id: "glow", label: "Faint glow" },
  { id: "vhs", label: "VHS chromatic offset" },
  { id: "jitter", label: "Signal jitter" },
  { id: "tracking", label: "Tracking flicker" },
  { id: "typewriter", label: "Typewriter strike" },
  { id: "crt", label: "Burned-in CRT" },
]
const COLORS = { white: ["Off-white", "234 238 230"], amber: ["Amber", "240 170 84"], green: ["Pale green", "176 238 196"], red: ["Red", "222 74 58"] } as const
type ColorKey = keyof typeof COLORS
const SUBTITLES = ["", "ASHWOOD STATION · 1984", "OUTPOST 7 · OCTOBER 1984", "A TRANSMISSION"]
const DEFAULT_NAMES = ["ASHWOOD"]
/** Bumped when the defaults change; saved state from older versions gets the new names and subtitles once. */
const NAMES_VERSION = 3

type State = {
  names: string
  fonts: string[]
  size: number
  spacing: number
  upper: boolean
  weight: number
  treatment: Treatment
  color: ColorKey
  subtitle: number
  snow: boolean
  veil: boolean
  osd: boolean
  menu: boolean
  favourites: string[]
  favOnly: boolean
  columns: number
  order: "name" | "font"
  namesVersion: number
}
const KEY = "titleLab.v1"
const DEFAULTS: State = {
  names: DEFAULT_NAMES.join("\n"),
  fonts: FONTS.map((f) => f.family),
  size: 164,
  spacing: 0.42,
  upper: true,
  weight: 200,
  treatment: "vhs",
  color: "white",
  subtitle: 1,
  snow: true,
  veil: true,
  osd: true,
  menu: true,
  favourites: [],
  favOnly: false,
  columns: 4,
  order: "name",
  namesVersion: NAMES_VERSION,
}
const state: State = (() => {
  let saved: Partial<State> = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<State>
  } catch {}
  const s = { ...DEFAULTS, ...saved }
  // State saved before the current defaults (the name was picked): ASHWOOD, the new subtitles, no favourites filter.
  // Favourites, fonts and styling are kept.
  if ((saved.namesVersion ?? 1) < NAMES_VERSION) {
    s.names = DEFAULTS.names
    s.subtitle = DEFAULTS.subtitle
    s.favOnly = false
    s.namesVersion = NAMES_VERSION
  }
  return s
})()
const save = () => localStorage.setItem(KEY, JSON.stringify(state))

loadFonts()
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())
const favKey = (name: string, font: string) => `${name}|${font}`

// A noise tile for the snow overlay (the menu's light static).
const noiseUrl = (() => {
  const c = document.createElement("canvas")
  c.width = c.height = 256
  const g = c.getContext("2d")!
  const img = g.createImageData(256, 256)
  const px = new Uint32Array(img.data.buffer)
  for (let i = 0; i < px.length; i++) {
    const v = (Math.random() ** 1.6 * 255) | 0
    px[i] = (255 << 24) | (v << 16) | (v << 8) | v
  }
  g.putImageData(img, 0, 0)
  return c.toDataURL()
})()

const root = document.querySelector<HTMLDivElement>("#app")!
root.innerHTML = `
  <aside class="tl-side">
    <h1>Title Lab</h1>
    <p class="tl-help">Click a card for fullscreen · ← → step · F favourite · Esc close</p>
    <label class="tl-field">Names <small>(one per line)</small><textarea id="names" rows="9" spellcheck="false"></textarea></label>
    <div class="tl-field">Size <input id="size" type="range" min="48" max="300" step="2"><output id="size-o"></output></div>
    <div class="tl-field">Letter spacing <input id="spacing" type="range" min="-0.05" max="0.8" step="0.01"><output id="spacing-o"></output></div>
    <div class="tl-field">Weight <input id="weight" type="range" min="100" max="900" step="100"><output id="weight-o"></output></div>
    <div class="tl-field">Case <select id="case"><option value="upper">UPPER</option><option value="title">Title</option></select></div>
    <div class="tl-field">Treatment <select id="treatment">${TREATMENTS.map((t) => `<option value="${t.id}">${t.label}</option>`).join("")}</select></div>
    <div class="tl-field">Colour <select id="color">${Object.entries(COLORS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("")}</select></div>
    <div class="tl-field">Subtitle <select id="subtitle">${SUBTITLES.map((s, i) => `<option value="${i}">${s || "none"}</option>`).join("")}</select></div>
    <div class="tl-checks">
      <label><input type="checkbox" id="snow"> snow</label><label><input type="checkbox" id="veil"> scanlines</label>
      <label><input type="checkbox" id="osd"> CH 03 / date</label><label><input type="checkbox" id="menu"> menu</label>
    </div>
    <div class="tl-field">Columns <input id="columns" type="range" min="1" max="6" step="1"><output id="columns-o"></output></div>
    <div class="tl-field">Order <select id="order"><option value="name">by name</option><option value="font">by font</option></select></div>
    <label class="tl-fav-only"><input type="checkbox" id="favOnly"> ★ Favourites only <span id="fav-count"></span></label>
    <div class="tl-fonts" id="fonts"></div>
  </aside>
  <main class="tl-grid" id="grid"></main>
  <div class="tl-full" id="full" hidden><div class="tl-full-frame"></div><div class="tl-full-bar"></div></div>`

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const grid = $<HTMLElement>("grid")
const full = $<HTMLElement>("full")
document.documentElement.style.setProperty("--bg", `url(${bg})`)
document.documentElement.style.setProperty("--noise", `url(${noiseUrl})`)

// Fonts list, grouped, with all/none per group.
const fontsEl = $<HTMLElement>("fonts")
fontsEl.innerHTML = GROUPS.map((g) => {
  const items = FONTS.filter((f) => f.group === g)
  return `<fieldset><legend>${esc(g)} <button data-group="${esc(g)}" data-on="1">all</button><button data-group="${esc(g)}" data-on="0">none</button></legend>${items
    .map((f) => `<label style="font-family:'${f.family}'"><input type="checkbox" value="${esc(f.family)}"> ${esc(f.family)}${f.note ? ` <em>${esc(f.note)}</em>` : ""}</label>`)
    .join("")}</fieldset>`
}).join("")
fontsEl.addEventListener("change", () => {
  state.fonts = [...fontsEl.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value)
  save()
  build()
})
fontsEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-group]")
  if (!b) return
  for (const i of b.closest("fieldset")!.querySelectorAll<HTMLInputElement>("input")) i.checked = b.dataset.on === "1"
  fontsEl.dispatchEvent(new Event("change"))
})

function syncControls() {
  $<HTMLTextAreaElement>("names").value = state.names
  for (const k of ["size", "spacing", "weight", "columns"] as const) $<HTMLInputElement>(k).value = String(state[k])
  $<HTMLSelectElement>("case").value = state.upper ? "upper" : "title"
  $<HTMLSelectElement>("treatment").value = state.treatment
  $<HTMLSelectElement>("color").value = state.color
  $<HTMLSelectElement>("subtitle").value = String(state.subtitle)
  $<HTMLSelectElement>("order").value = state.order
  for (const k of ["snow", "veil", "osd", "menu", "favOnly"] as const) $<HTMLInputElement>(k).checked = state[k]
  for (const i of fontsEl.querySelectorAll<HTMLInputElement>("input")) i.checked = state.fonts.includes(i.value)
}

/** Style-only state → CSS variables and classes on <html>. */
function applyStyle() {
  const r = document.documentElement
  r.style.setProperty("--t-size", `${state.size}px`)
  r.style.setProperty("--t-spacing", `${state.spacing}em`)
  r.style.setProperty("--t-weight", String(state.weight))
  r.style.setProperty("--t-c", COLORS[state.color][1])
  r.style.setProperty("--cols", String(state.columns))
  r.dataset.treatment = state.treatment
  for (const k of ["snow", "veil", "osd", "menu"] as const) r.classList.toggle(`no-${k}`, !state[k])
  $<HTMLOutputElement>("size-o").textContent = `${state.size}px`
  $<HTMLOutputElement>("spacing-o").textContent = `${state.spacing.toFixed(2)}em`
  $<HTMLOutputElement>("weight-o").textContent = String(state.weight)
  $<HTMLOutputElement>("columns-o").textContent = String(state.columns)
  for (const s of document.querySelectorAll<HTMLElement>(".tl-sub")) s.textContent = SUBTITLES[state.subtitle]!
  rescale()
}

function screen(name: string, family: string) {
  const text = state.upper ? name.toUpperCase() : titleCase(name)
  // Per-letter offsets for the typewriter strike (fixed per name so they don't reshuffle).
  let seed = [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  const letters = [...text].map((c) => `<span class="l" style="--ly:${(rnd() * 0.022).toFixed(3)}em;--lr:${(rnd() * 1.6).toFixed(2)}deg;--lo:${(0.8 + 0.2 * Math.abs(rnd())).toFixed(2)}">${c === " " ? "&nbsp;" : esc(c)}</span>`).join("")
  return `<div class="tl-screen">
    <div class="tl-snow"></div><div class="tl-veil"></div>
    <div class="tl-osd tl-osd-tl">CH 03</div><div class="tl-osd tl-osd-bl">OCT 19 1984  01:52</div>
    <div class="tl-main">
      <h1 class="tl-title" data-text="${esc(text)}" style="font-family:'${family}', sans-serif">${letters}</h1>
      <div class="tl-sub">${esc(SUBTITLES[state.subtitle]!)}</div>
      <nav class="tl-nav"><b>Play</b><span>Character</span><span>Settings</span><span>Credits</span></nav>
    </div>
  </div>`
}

type Combo = { name: string; family: string }
let combos: Combo[] = []

function build() {
  const names = state.names
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  const fonts = FONTS.filter((f) => state.fonts.includes(f.family))
  combos = []
  if (state.order === "name") for (const n of names) for (const f of fonts) combos.push({ name: n, family: f.family })
  else for (const f of fonts) for (const n of names) combos.push({ name: n, family: f.family })
  if (state.favOnly) combos = combos.filter((c) => state.favourites.includes(favKey(c.name, c.family)))
  $<HTMLElement>("fav-count").textContent = `(${state.favourites.length})`
  grid.innerHTML = combos.length
    ? combos
        .map((c, i) => {
          const f = FONTS.find((x) => x.family === c.family)!
          const fav = state.favourites.includes(favKey(c.name, c.family))
          return `<figure class="tl-card" data-i="${i}"><div class="tl-frame">${screen(c.name, c.family)}</div><figcaption><button class="tl-star${fav ? " on" : ""}" data-i="${i}" title="Favourite">★</button><span>${esc(c.name)}</span><span class="tl-font">${esc(c.family)}${f.note ? ` · <em>${esc(f.note)}</em>` : ""}</span></figcaption></figure>`
        })
        .join("")
    : `<p class="tl-empty">${state.favOnly ? "No favourites yet: star a card." : "Pick a name and a font."}</p>`
  rescale()
  if (!full.hidden) openFull(Math.min(current, combos.length - 1))
}

function rescale() {
  const card = grid.querySelector<HTMLElement>(".tl-frame")
  if (card) grid.style.setProperty("--scale", String(card.clientWidth / 1920))
  if (!full.hidden) {
    const s = Math.min(innerWidth / 1920, (innerHeight - 44) / 1080)
    full.style.setProperty("--scale", String(s))
  }
}
new ResizeObserver(rescale).observe(grid)
addEventListener("resize", rescale)

function toggleFav(i: number) {
  const c = combos[i]
  if (!c) return
  const k = favKey(c.name, c.family)
  state.favourites = state.favourites.includes(k) ? state.favourites.filter((x) => x !== k) : [...state.favourites, k]
  save()
  const on = state.favourites.includes(k)
  grid.querySelector(`.tl-star[data-i="${i}"]`)?.classList.toggle("on", on)
  $<HTMLElement>("fav-count").textContent = `(${state.favourites.length})`
  if (!full.hidden) openFull(i)
}

let current = 0
function openFull(i: number) {
  const c = combos[i]
  if (!c) return closeFull()
  current = i
  full.hidden = false
  document.documentElement.classList.add("full-open")
  full.querySelector(".tl-full-frame")!.innerHTML = screen(c.name, c.family)
  const fav = state.favourites.includes(favKey(c.name, c.family))
  const note = FONTS.find((x) => x.family === c.family)?.note
  full.querySelector(".tl-full-bar")!.innerHTML = `<button class="tl-star${fav ? " on" : ""}" data-full="1">★</button><b>${esc(c.name)}</b><span>${esc(c.family)}${note ? ` · <em>${esc(note)}</em>` : ""}</span><span class="tl-count">${i + 1} / ${combos.length}</span><span class="tl-keys">← → step · F favourite · Esc close</span>`
  rescale()
}
function closeFull() {
  full.hidden = true
  document.documentElement.classList.remove("full-open")
}

grid.addEventListener("click", (e) => {
  const t = e.target as HTMLElement
  const star = t.closest<HTMLElement>(".tl-star")
  if (star) return toggleFav(Number(star.dataset.i))
  const card = t.closest<HTMLElement>(".tl-card")
  if (card) openFull(Number(card.dataset.i))
})
full.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest(".tl-star")) return toggleFav(current)
  if ((e.target as HTMLElement).closest(".tl-full-bar")) return
  closeFull()
})
addEventListener("keydown", (e: KeyboardEvent) => {
  if (full.hidden || (e.target as HTMLElement).matches("textarea, input, select")) return
  if (e.key === "Escape") closeFull()
  else if (e.key === "ArrowRight" || e.key === "ArrowDown") openFull((current + 1) % combos.length)
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") openFull((current - 1 + combos.length) % combos.length)
  else if (e.key === "f" || e.key === "F") toggleFav(current)
  else return
  e.preventDefault()
})

// Controls.
let nameTimer = 0
$<HTMLTextAreaElement>("names").addEventListener("input", (e) => {
  state.names = (e.target as HTMLTextAreaElement).value
  save()
  clearTimeout(nameTimer)
  nameTimer = window.setTimeout(build, 250)
})
for (const k of ["size", "spacing", "weight", "columns"] as const)
  $<HTMLInputElement>(k).addEventListener("input", (e) => {
    state[k] = Number((e.target as HTMLInputElement).value)
    save()
    applyStyle()
  })
for (const k of ["snow", "veil", "osd", "menu"] as const)
  $<HTMLInputElement>(k).addEventListener("change", (e) => {
    state[k] = (e.target as HTMLInputElement).checked
    save()
    applyStyle()
  })
$<HTMLInputElement>("favOnly").addEventListener("change", (e) => {
  state.favOnly = (e.target as HTMLInputElement).checked
  save()
  build()
})
$<HTMLSelectElement>("case").addEventListener("change", (e) => {
  state.upper = (e.target as HTMLSelectElement).value === "upper"
  save()
  build()
})
$<HTMLSelectElement>("order").addEventListener("change", (e) => {
  state.order = (e.target as HTMLSelectElement).value as State["order"]
  save()
  build()
})
$<HTMLSelectElement>("treatment").addEventListener("change", (e) => {
  state.treatment = (e.target as HTMLSelectElement).value as Treatment
  save()
  applyStyle()
})
$<HTMLSelectElement>("color").addEventListener("change", (e) => {
  state.color = (e.target as HTMLSelectElement).value as ColorKey
  save()
  applyStyle()
})
$<HTMLSelectElement>("subtitle").addEventListener("change", (e) => {
  state.subtitle = Number((e.target as HTMLSelectElement).value)
  save()
  applyStyle()
})

syncControls()
build()
applyStyle()
;(globalThis as { __titleLab?: unknown }).__titleLab = { state, openFull, combos: () => combos }
