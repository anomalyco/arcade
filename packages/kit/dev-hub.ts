import { hubCommands, hubGames, gameHref } from "./dev-hub-model"
import type { SpawnFactory } from "./lab/spawn-types"
import "./dev-hub.css"

export type DevHubOptions = { spawn: SpawnFactory; metrics?(id: string): Readonly<Record<string, string>> }
const configKey = "arcade.dev-hub.previews.v1"
export function devHub(options: DevHubOptions) {
  document.body.innerHTML = `<header><strong>Dev Hub</strong><nav aria-label="Developer navigation"></nav></header>
    <main><section id="games"><h2>Games</h2><div class="games" data-games></div>
      <details><summary>Prototypes</summary><div class="games" data-prototypes></div></details>
      <details class="config"><summary>Local previews</summary><form><div data-config></div><button>Save</button><button type="button" data-reset>Use production</button><p class="status" role="status" data-config-status></p></form></details>
    </section><section id="catalogue" hidden>
      <div class="catalogue-toolbar"><input type="search" aria-label="Search assets" placeholder="Search assets"><select aria-label="Asset category"><option value="all">All</option><option value="vehicle">Vehicles</option><option value="prop">Props</option><option value="character">Characters</option></select></div>
      <div class="catalogue-layout"><div class="asset-grid" aria-label="Registered assets"></div><div class="viewer"><canvas tabindex="0" aria-label="Asset viewer"></canvas><p class="status" role="status" data-viewer-status>Loading catalogue…</p><div data-viewer-controls></div></div></div>
    </section></main>`
  const nav = document.querySelector("nav")!
  for (const command of hubCommands) {
    const link = document.createElement("a")
    link.href = command.href; link.textContent = command.label; link.dataset.page = command.id
    nav.append(link)
  }
  let overrides: Record<string, string> = {}
  try { const stored: unknown = JSON.parse(localStorage.getItem(configKey) ?? "{}"); if (stored && typeof stored === "object") for (const game of hubGames) { const value = Reflect.get(stored, game.id); if (typeof value === "string") overrides[game.id] = value } } catch { /* Storage is optional. */ }
  const inputs = new Map<string, HTMLInputElement>()
  for (const game of hubGames) {
    const label = document.createElement("label"), input = document.createElement("input")
    label.textContent = game.label; input.type = "url"; input.placeholder = `http://${game.id}-preview.localhost:1355/`; input.value = overrides[game.id] ?? ""
    label.append(input); document.querySelector("[data-config]")!.append(label); inputs.set(game.id, input)
  }
  function games() {
    for (const selector of ["[data-games]", "[data-prototypes]"]) document.querySelector(selector)!.replaceChildren()
    for (const game of hubGames) {
      const link = document.createElement("a"), name = document.createElement("strong"), source = document.createElement("small")
      link.className = "game"; link.href = gameHref(game.id, overrides); name.textContent = game.label
      source.textContent = link.href.startsWith("http:") ? "Local preview" : "Production"
      link.append(name, source); document.querySelector(game.prototype ? "[data-prototypes]" : "[data-games]")!.append(link)
    }
  }
  function save(reset = false) {
    const next: Record<string, string> = {}
    for (const [id, input] of inputs) {
      const value = reset ? "" : input.value.trim()
      if (value && !gameHref(id, { [id]: value }).startsWith("http:")) { document.querySelector("[data-config-status]")!.textContent = "Use a named Nexus URL: http://name.localhost:1355/"; input.focus(); return }
      input.value = value; if (value) next[id] = value
    }
    overrides = next; games()
    try { localStorage.setItem(configKey, JSON.stringify(next)); document.querySelector("[data-config-status]")!.textContent = "Saved locally" } catch { document.querySelector("[data-config-status]")!.textContent = "Applied for this session; storage unavailable" }
  }
  document.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); save() })
  document.querySelector("[data-reset]")!.addEventListener("click", () => save(true))
  games()
  let catalogue: Promise<unknown> | undefined
  function route() {
    const page = location.hash === "#catalogue" ? "catalogue" : "games"
    for (const id of ["games", "catalogue"]) document.getElementById(id)!.hidden = id !== page
    for (const link of nav.querySelectorAll("a")) { if (link.dataset.page === page) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current") }
    if (page === "catalogue") catalogue ??= import("./dev-hub-viewer").then(module => module.catalogueViewer(options)).catch(error => { document.querySelector("[data-viewer-status]")!.textContent = String(error) })
  }
  window.addEventListener("hashchange", route); route()
}
