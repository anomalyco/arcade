import { arcadePreset } from "@arcade/kit/lab-knobs"
import { split, tooltip, tree, type Split, type Tree } from "@arcade/knobs/ui"
import { matches, type Catalog, type HomeCollection, type HomeLab } from "./catalog"
import "./home.css"

type Row = { id: string; label: string; children?: Row[]; lab?: HomeLab; count?: number }

const look = { preset: arcadePreset, theme: "dark" as const }
const FOLDED_KEY = "arcade.lab.home.folded"

const html = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const hex = (n: number | undefined) => (n === undefined ? "var(--tx3)" : `#${n.toString(16).padStart(6, "0")}`)
const STATUS: Record<string, string> = { live: "Live", "in-progress": "In progress", review: "In review", planned: "Planned" }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  parent?.append(e)
  return e
}

export type HomeOptions = {
  catalog: Catalog
  /** Opens a lab; Home hides once it resolves true. */
  open(lab: HomeLab): Promise<boolean>
  /** The lab open behind Home, if any: Esc goes back to it. */
  current(): HomeLab | null
  storage?: Storage | null
  hubHref: string
}

/**
 * The Lab's Home: every lab, grouped by collection, in a searchable outliner, with the selected lab described beside
 * it. Enter or a double-click opens a lab; Home covers the workbench (which stops drawing) until then.
 */
export function createHome(options: HomeOptions) {
  const { catalog, storage = null } = options
  const root = el("div", "lh")
  root.dataset.labHome = ""
  root.hidden = true
  root.setAttribute("role", "dialog")
  root.setAttribute("aria-label", "Labs")

  const frame = el("div", "lh-frame", root)
  const top = el("header", "lh-top", frame)
  const hub = el("a", "lh-hub", top, "Hub")
  hub.href = options.hubHref
  el("b", "lh-brand", top, "Lab")
  const count = el("span", "lh-count", top)
  const back = el("button", "lh-back", top)
  back.type = "button"
  back.hidden = true
  back.addEventListener("click", () => leave())
  tooltip(back, { text: "Back to the open lab", shortcut: "Escape" })

  const searchRow = el("label", "lh-search", frame)
  searchRow.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.3 10.3 13.6 13.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
  const search = el("input", "lh-search-input", searchRow)
  search.type = "search"
  search.placeholder = "Search labs"
  search.setAttribute("aria-label", "Search labs")
  search.spellcheck = false
  el("kbd", "lh-kbd", searchRow, "/")

  const body = el("div", "lh-body", frame)
  const panes: Split = split(body, {
    ...look,
    id: "lab-home",
    storage,
    panes: [
      { id: "labs", min: 300 },
      { id: "about", size: 340, min: 260, max: 480, collapsible: true, rail: "About" },
    ],
  })
  const about = el("div", "lh-about", panes.pane("about").body)
  const foot = el("footer", "lh-foot", frame)
  foot.innerHTML = "<span><kbd>↑</kbd><kbd>↓</kbd> Move</span><span><kbd>←</kbd><kbd>→</kbd> Fold</span><span><kbd>↵</kbd> Open</span><span><kbd>/</kbd> Search</span><span data-back-hint><kbd>Esc</kbd> Back to the lab</span>"

  const folded = new Set<string>(read())
  function read(): string[] {
    try { return JSON.parse(storage?.getItem(FOLDED_KEY) ?? "[]") as string[] } catch { return [] }
  }

  let collections: HomeCollection[] = []
  let rows: Row[] = []
  let byId = new Map<string, HomeLab>()
  let query = ""

  const outline: Tree<Row> = tree<Row>(panes.pane("labs").body, {
    ...look,
    items: [],
    label: "Labs",
    empty: "No lab matches",
    icon: row => {
      if (!row.lab) return undefined
      const dot = document.createElement("span")
      dot.className = "lh-dot"
      dot.style.setProperty("--c", hex(row.lab.color))
      return dot
    },
    detail: row => (row.lab ? row.lab.kind.label : String(row.count)),
    onSelect: (_ids, primary) => describe(primary ? byId.get(primary) ?? null : null),
    onActivate: id => {
      const lab = byId.get(id)
      if (lab) void go(lab)
      else outline.expand(id, !outline.isExpanded(id))
    },
    onToggle: (id, open) => {
      if (open) folded.delete(id)
      else folded.add(id)
      try { storage?.setItem(FOLDED_KEY, JSON.stringify([...folded])) } catch { /* private mode */ }
    },
  })

  function load() {
    collections = catalog.collections()
    byId = new Map(collections.flatMap(c => c.labs.map(l => [l.ref, l] as const)))
    rows = collections.map(c => ({ id: `collection:${c.id}`, label: c.title, count: c.labs.length, children: c.labs.map(l => ({ id: l.ref, label: l.title, lab: l })) }))
    outline.update(rows)
    for (const c of rows) outline.expand(c.id, !folded.has(c.id))
    const labs = byId.size
    count.textContent = `${labs} lab${labs === 1 ? "" : "s"} · ${collections.length} collection${collections.length === 1 ? "" : "s"}`
    applyFilter()
  }

  function applyFilter() {
    outline.filter(query ? (row: Row) => (row.lab ? matches(row.lab, query) : false) : null)
    const first = firstVisibleLab()
    if (query && first && !visible().includes(outline.active ?? "")) outline.select([first.ref], first.ref)
  }

  const visible = () => outline.rows()
  const firstVisibleLab = () => visible().map(id => byId.get(id)).find(Boolean)

  function describe(lab: HomeLab | null) {
    if (!lab) {
      about.innerHTML = `<p class="lh-empty">Pick a lab to see what it holds.</p>`
      return
    }
    const variants = lab.variants
      .slice(0, 9)
      .map((v, i) => `<li><kbd>${i + 1}</kbd>${html(v.label)}</li>`)
      .join("")
    const more = lab.variants.length > 9 ? `<li class="lh-more">and ${lab.variants.length - 9} more</li>` : ""
    const status = lab.status === "draft" ? "Draft" : lab.status === "archived" ? "Archived" : null
    about.innerHTML = `
      <div class="lh-about-head" style="--c:${hex(lab.color)}">
        <h2>${html(lab.title)}</h2>
        <p class="lh-meta">${html(lab.kind.label)} lab<span>·</span>${html(lab.collection.title)}${status ? `<span>·</span>${status}` : ""}${lab.source === "edited" ? "<span>·</span>Edited here" : ""}</p>
      </div>
      ${lab.summary ? `<p class="lh-summary">${html(lab.summary)}</p>` : ""}
      ${variants ? `<h3>Variants</h3><ol class="lh-variants">${variants}${more}</ol>` : ""}
      <button type="button" class="lh-open" data-open>Open<kbd>↵</kbd></button>`
    about.querySelector<HTMLButtonElement>("[data-open]")!.addEventListener("click", () => void go(lab))
  }

  async function go(lab: HomeLab) {
    root.dataset.opening = lab.ref
    try {
      if (await options.open(lab)) hide()
    } finally {
      delete root.dataset.opening
    }
  }

  function leave() {
    if (options.current()) hide()
  }

  // ── keys: Home owns every key while it shows ───────────────────────────────────────────────────────────────────
  search.addEventListener("input", () => {
    query = search.value.trim()
    applyFilter()
  })
  search.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault()
      const target = (outline.active && visible().includes(outline.active) ? outline.active : null) ?? firstVisibleLab()?.ref
      outline.focus(target ?? undefined)
    } else if (e.key === "Enter") {
      e.preventDefault()
      const lab = (outline.active ? byId.get(outline.active) : undefined) ?? firstVisibleLab()
      if (lab) void go(lab)
    } else if (e.key === "Escape" && search.value) {
      e.preventDefault()
      e.stopPropagation()
      search.value = ""
      query = ""
      applyFilter()
    }
  })
  // Capture: Home's own keys come before the outliner's (which would take "/" and Esc for itself).
  root.addEventListener("keydown", e => {
    const inSearch = e.target === search
    const mod = e.metaKey || e.ctrlKey
    const take = () => { e.preventDefault(); e.stopPropagation() }
    if (mod && e.key.toLowerCase() === "k") {
      take()
      search.focus()
      search.select()
    } else if (!inSearch && !mod && !e.altKey && e.key === "/") {
      take()
      search.focus()
      search.select()
    } else if (e.key === "Escape" && !(inSearch && search.value)) {
      take()
      if (inSearch) outline.focus()
      else leave()
    } else if (!inSearch && e.key === "ArrowUp" && visible()[0] === outline.active) {
      take()
      search.focus()
    }
  }, true)
  // Nothing behind Home sees a key while it shows; browser shortcuts still work.
  root.addEventListener("keydown", e => {
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation()
  })
  // Keys aimed at something behind Home (after a click on its backdrop) come back to it.
  window.addEventListener("keydown", e => {
    if (root.hidden || root.contains(e.target as Node) || e.metaKey || e.ctrlKey) return
    e.stopImmediatePropagation()
    outline.focus()
  }, true)

  // ── show / hide ────────────────────────────────────────────────────────────────────────────────────────────────
  const listeners = new Set<(open: boolean) => void>()
  function show() {
    load()
    const current = options.current()
    back.hidden = !current
    foot.querySelector<HTMLElement>("[data-back-hint]")!.hidden = !current
    back.innerHTML = current ? `<span>Back to</span> ${html(current.title)}` : ""
    const target = current && byId.has(current.ref) ? current.ref : (outline.active && byId.has(outline.active) ? outline.active : firstVisibleLab()?.ref)
    root.hidden = false
    document.documentElement.dataset.labHome = ""
    if (target) {
      outline.reveal(target)
      outline.select([target], target)
    }
    describe(target ? byId.get(target) ?? null : null)
    outline.focus(target ?? undefined)
    for (const l of listeners) l(true)
  }
  function hide() {
    if (root.hidden) return
    root.hidden = true
    delete document.documentElement.dataset.labHome
    for (const l of listeners) l(false)
  }

  document.body.append(root)
  return {
    element: root,
    show,
    hide,
    get open() { return !root.hidden },
    onChange(listener: (open: boolean) => void) { listeners.add(listener); return () => listeners.delete(listener) },
    /** Labs on show (after the search filter), top to bottom. */
    visibleLabs: () => visible().filter(id => byId.has(id)),
    search(text: string) { search.value = text; query = text.trim(); applyFilter() },
  }
}

export type Home = ReturnType<typeof createHome>
