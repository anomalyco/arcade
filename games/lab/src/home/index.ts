import { popover } from "@arcade/knobs/ui"
import type { lab } from "@arcade/kit/lab/main"
import type { StationsController } from "@arcade/kit/lab/stations/workspace"
import type { LabStation } from "@arcade/kit/lab/stations/types"
import { createCatalog, type HomeLab } from "./catalog"
import { createHome } from "./home"

type LabApi = Awaited<ReturnType<typeof lab>>

const html = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

/**
 * Home and Labs (AR-25, D-16): the Lab opens on Home, every lab grouped by collection; opening one runs it through the
 * station workspace and shows where you are in the top bar. `H` comes back to Home, `⌥[` `⌥]` step through the
 * collection, and `?lab=<collection>/<id>` (or an old `?station=<id>`) opens a lab directly.
 */
export function startHome(api: LabApi, stations: StationsController, list: readonly LabStation[]) {
  let storage: Storage | null = null
  try { storage = localStorage } catch { /* private mode: labs made here last for the page */ }
  const catalog = createCatalog(list, storage)
  let current: HomeLab | null = null
  const isPage = () => current?.station().demo.kind === "page"

  const crumb = document.createElement("nav")
  crumb.className = "lab-crumb"
  crumb.setAttribute("aria-label", "Where you are")
  api.slots.root.querySelector(".lab-brand")?.after(crumb)

  const home = createHome({
    catalog,
    storage,
    hubHref: api.slots.root.querySelector<HTMLAnchorElement>(".lab-hub")?.href ?? "/",
    current: () => current,
    open,
  })
  home.onChange(showing => {
    // Nothing behind Home needs drawing; a page lab keeps the viewport suspended as it always does.
    api.suspend(showing || isPage())
    if (!showing) api.canvas.focus({ preventScroll: true })
    syncUrl()
  })

  async function open(lab: HomeLab): Promise<boolean> {
    if (api.workbench.getMode() === "play") api.workbench.setMode("edit")
    const ok = await stations.open(lab.station())
    if (!ok) return false
    current = lab
    api.suspend(home.open || isPage())
    renderCrumb()
    syncUrl()
    return true
  }

  function syncUrl() {
    const params = new URLSearchParams(location.search)
    params.delete("station")
    params.delete("overworld")
    if (current && !home.open) {
      params.set("lab", current.ref)
      params.delete("section")
    } else params.delete("lab")
    const query = params.toString()
    history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${current && !home.open ? "" : location.hash}`)
  }

  function renderCrumb() {
    crumb.replaceChildren()
    const button = (text: string, role: string, title: string, run: (b: HTMLButtonElement) => void) => {
      const b = document.createElement("button")
      b.type = "button"
      b.dataset.crumb = role
      b.textContent = text
      b.title = title
      b.addEventListener("click", () => run(b))
      crumb.append(b)
      return b
    }
    const sep = () => crumb.append(Object.assign(document.createElement("span"), { textContent: "›", ariaHidden: "true" }))
    button("Labs", "home", "All labs (H)", () => home.show())
    if (!current) return
    sep()
    button(current.collection.title, "collection", "All labs (H)", () => home.show())
    sep()
    button(current.title, "lab", "Other labs in this collection (⌥[ ⌥])", b => siblings(b))
  }

  function siblings(anchor: HTMLElement) {
    if (!current) return
    const labs = catalog.collections().find(c => c.id === current!.collection.id)?.labs ?? []
    const menu = document.createElement("div")
    menu.className = "lab-crumb-menu"
    for (const lab of labs) {
      const item = document.createElement("button")
      item.type = "button"
      item.setAttribute("role", "menuitem")
      item.dataset.active = String(lab.ref === current.ref)
      item.innerHTML = `<span>${html(lab.title)}</span><small>${html(lab.kind.label)}</small>`
      item.addEventListener("click", () => { void handle.close(); void open(lab) })
      menu.append(item)
    }
    const handle = popover(anchor, menu, { placement: "bottom-start", role: "menu", label: current.collection.title })
  }

  async function step(by: number) {
    if (!current) return
    const next = catalog.step(current.ref, by)
    if (next && next.ref !== current.ref) await open(next)
  }

  // H, ⌥[ and ⌥] from the viewport and the workbench chrome, never while typing, in Play or inside the Details panel.
  window.addEventListener("keydown", e => {
    if (home.open || e.metaKey || e.ctrlKey || e.repeat) return
    const t = e.composedPath()[0]
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)) return
    if (api.workbench.getMode() === "play" || api.panel.hasFocus()) return
    // A studio tour running over the Lab steps its own tabs with ⌥[ ⌥].
    if (e.altKey && (e.code === "BracketLeft" || e.code === "BracketRight") && !document.documentElement.hasAttribute("data-arcade-studio-open")) {
      e.preventDefault()
      e.stopImmediatePropagation()
      void step(e.code === "BracketLeft" ? -1 : 1)
    } else if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === "h") {
      e.preventDefault()
      e.stopImmediatePropagation()
      home.show()
    }
  }, true)

  api.workbench.commands.register({
    id: "lab.home",
    label: "Show All Labs",
    shortLabel: "Labs",
    category: "Navigation",
    shortcut: "H",
    enabled: () => true,
    run: () => { home.show(); return { home: true } },
  })
  api.workbench.commands.register({
    id: "lab.open",
    aliases: ["lab"],
    label: "Open Lab",
    shortLabel: "Open lab",
    category: "Navigation",
    args: { id: { type: "string", required: true, description: "Lab ref (collection/id) or id" } },
    enabled: () => api.workbench.getMode() !== "play",
    disabledReason: () => "Unavailable in Play mode. Run 'arcade release' first.",
    run: (_ctx, args) => {
      const key = String(args?.id ?? "").trim()
      const lab = catalog.find(key)
      if (!lab) throw new Error(`Unknown lab "${key}". Labs: ${catalog.all().map(l => l.ref).join(", ")}.`)
      void open(lab).then(ok => ok && home.hide())
      return { lab: lab.ref, title: lab.title }
    },
  })
  api.workbench.commands.register({
    id: "lab.list",
    label: "List Labs",
    shortLabel: "Labs",
    category: "Navigation",
    readOnly: true,
    enabled: () => true,
    run: () => ({
      current: current?.ref ?? null,
      home: home.open,
      collections: catalog.collections().map(c => ({ id: c.id, title: c.title, labs: c.labs.map(l => ({ ref: l.ref, title: l.title, kind: l.kind.id, status: l.status })) })),
    }),
  })
  for (const lab of catalog.all()) {
    api.workbench.commands.register({
      id: `lab.go.${lab.ref.replace("/", ".")}`,
      label: `Lab: ${lab.title}`,
      shortLabel: lab.title,
      description: lab.summary,
      category: "Navigation",
      enabled: () => api.workbench.getMode() !== "play",
      run: () => { void open(lab).then(ok => ok && home.hide()); return { lab: lab.ref } },
    })
  }

  renderCrumb()

  // Leaving the lab's section by hand (the World footer, ⌘K) leaves the lab too.
  stations.on(event => {
    if (event.kind === "station" && event.station === null && current) {
      current = null
      renderCrumb()
      syncUrl()
    }
  })

  return {
    home,
    catalog,
    open,
    current: () => current,
    /** Opens what the URL names: `?lab=`, an old `?station=`, or Home when it names nothing to show. */
    async start() {
      const params = new URLSearchParams(location.search)
      const key = params.get("lab") ?? params.get("station")
      const lab = key ? catalog.find(key) : undefined
      if (lab && (await open(lab))) return
      if (key) console.warn(`[labs] no lab "${key}"`)
      if (!params.has("section") && !location.hash) home.show()
    },
  }
}
