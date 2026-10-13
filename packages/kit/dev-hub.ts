import { gameLink, hubCommands, hubGames, hubTargets, parseHubHash } from "./dev-hub-model"
import type { SpawnFactory } from "./lab/spawn-types"
import "./dev-hub.css"

export type DevHubOptions = { spawn: SpawnFactory; metrics?(id: string): Readonly<Record<string, string>> }

export function devHub(options: DevHubOptions) {
  const targets = hubTargets(location.pathname, document.querySelector<HTMLMetaElement>('meta[name="arcade-dev-router"]')?.content)
  const environment = targets.kind === "router" ? "Local" : "Production"
  document.body.innerHTML = `<header class="hub-bar"><a class="hub-name" href="dev.html#games">Arcade</a><nav aria-label="Developer"></nav><span class="hub-env" data-env="${environment.toLowerCase()}">${environment}</span></header>
    <main>
      <section id="games" class="games-page" aria-label="Games">
        <div class="games" data-games></div>
        <details class="prototypes"><summary>Prototypes</summary><div class="games" data-prototypes></div></details>
        <p class="hub-note" data-note hidden></p>
      </section>
      <section id="catalogue" class="catalogue" aria-label="Catalogue" hidden>
        <div class="catalogue-list">
          <div class="catalogue-filter"><input type="search" aria-label="Search assets" placeholder="Search" autocomplete="off" spellcheck="false"><select aria-label="Asset category"><option value="all">All</option><option value="vehicle">Vehicles</option><option value="prop">Props</option><option value="character">Characters</option></select></div>
          <div class="asset-list" role="listbox" aria-label="Assets"></div>
        </div>
        <div class="viewer"><canvas tabindex="0" aria-label="Asset viewer"></canvas><div class="viewer-tools" data-viewer-tools></div><p class="viewer-status" role="status" data-viewer-status>Loading…</p></div>
        <aside class="inspector" aria-label="Asset" data-inspector></aside>
      </section>
    </main>`
  const nav = document.querySelector("nav")!
  for (const command of hubCommands) {
    const link = document.createElement("a")
    link.href = command.id === "characters" && !location.pathname.startsWith("/arcade/blackout/") ? `${gameLink("blackout", targets).href}characters.html` : command.href
    link.textContent = command.label; link.dataset.page = command.id
    nav.append(link)
  }
  for (const game of hubGames) {
    const link = document.createElement("a"), name = document.createElement("span"), path = document.createElement("small")
    const target = gameLink(game.id, targets)
    link.className = "game"; link.href = target.href; link.dataset.game = game.id; link.dataset.source = target.source
    name.textContent = game.label; path.textContent = target.source === "production" && targets.kind === "router" ? "Production ↗" : `/arcade/${game.id}/`
    link.append(name, path); document.querySelector(game.prototype ? "[data-prototypes]" : "[data-games]")!.append(link)
  }
  const note = document.querySelector<HTMLElement>("[data-note]")!
  if (targets.kind === "standalone") { note.hidden = false; note.innerHTML = "Games open in production. For local games, run <code>bun run dev</code> at the repository root." }
  if (targets.kind === "router" && !targets.workers) { note.hidden = false; note.innerHTML = "Online play needs Workers: <code>bun run dev --workers</code>" }

  let catalogue: Promise<unknown> | undefined
  function route() {
    const { page } = parseHubHash(location.hash)
    for (const id of ["games", "catalogue"]) document.getElementById(id)!.hidden = id !== page
    document.body.dataset.page = page
    for (const link of nav.querySelectorAll("a")) { if (link.dataset.page === page) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current") }
    if (page === "catalogue") catalogue ??= import("./dev-hub-viewer").then(module => module.catalogueViewer(options)).catch(error => { document.querySelector("[data-viewer-status]")!.textContent = error instanceof Error ? error.message : String(error) })
  }
  window.addEventListener("hashchange", route); route()
}
