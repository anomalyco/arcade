import type { LabLibraryCategory } from "./types"
import { libraryIconFor, libraryIconSvg } from "./library-icons"
import { gridNeighbor, isFilterKey, type GridMove } from "./library-nav"

export const LIBRARY_CATEGORIES: readonly { id: LabLibraryCategory; label: string; icon: string }[] = [
  { id: "effects", label: "Effects", icon: "✺" },
  { id: "objects", label: "Objects", icon: "▣" },
  { id: "lighting", label: "Lighting", icon: "✦" },
  { id: "audio", label: "Audio", icon: "♪" },
  { id: "materials", label: "Materials", icon: "◩" },
  { id: "foliage", label: "Foliage", icon: "♣" },
  { id: "looks", label: "Looks", icon: "◑" },
]

/** The subset of a workbench catalog entry the Library needs. */
export type LibraryEntry = {
  id: string
  label: string
  group: string
  category: string
  tag: string
  sectionId: string
  isActive?: () => boolean
}

/** Map a catalog entry to its drawer category. Section ids win over the entry's legacy category. */
export function libraryCategoryOf(entry: Pick<LibraryEntry, "id" | "category" | "sectionId" | "tag">): LabLibraryCategory {
  const tag = entry.tag.toLowerCase()
  if (entry.id.startsWith("material-recipe:") || entry.sectionId === "materials" || tag === "material") return "materials"
  if (entry.sectionId === "foliage" || tag === "foliage") return "foliage"
  if (entry.sectionId === "looks" || tag === "look" || tag === "looks") return "looks"
  if (LIBRARY_CATEGORIES.some(c => c.id === entry.category)) return entry.category as LabLibraryCategory
  return "objects"
}

/** Default drawer category for a section that registers no explicit Library metadata. */
export function sectionLibraryCategory(id: string): LabLibraryCategory {
  const s = id.toLowerCase()
  if (/foliage|tree|grass/.test(s)) return "foliage"
  if (/look|grade/.test(s)) return "looks"
  if (/material/.test(s)) return "materials"
  if (/audio|sound/.test(s)) return "audio"
  if (/light/.test(s)) return "lighting"
  if (/effect|fx|splatter|fire|water|explosion|smoke|vignette/.test(s)) return "effects"
  return "objects"
}

/** Entries the drawer shows: scene objects live in the Outliner and commands in ⌘K. */
export function isLibraryAsset(entry: Pick<LibraryEntry, "id">): boolean {
  return !entry.id.startsWith("scene-obj:") && !entry.id.startsWith("cmd:")
}

export function filterLibrary<T extends LibraryEntry>(entries: readonly T[], view: { category: LabLibraryCategory; group?: string | null; query?: string }): T[] {
  const q = view.query?.trim().toLowerCase() ?? ""
  return entries.filter(e => {
    if (!isLibraryAsset(e)) return false
    if (q) return `${e.label} ${e.group} ${e.tag} ${libraryCategoryOf(e)}`.toLowerCase().includes(q)
    if (libraryCategoryOf(e) !== view.category) return false
    return !view.group || e.group === view.group
  })
}

/** Catalog ids that can be dropped at a ground point. */
export function isPlaceable(id: string): boolean {
  return id.startsWith("spawn-prop:") || id.startsWith("spawn-light:") || id.startsWith("spawn-char:")
}

export type LibraryView = "tiles" | "list"
const VIEW_KEY = "arcade.lab.library-view"

export type LibraryDeps<T extends LibraryEntry> = {
  entries(): T[]
  run(entry: T): void
  /** Pointer drag of a tile over the page; return true when the point is a valid drop target. */
  dragOver(entry: T, clientX: number, clientY: number): boolean
  drop(entry: T, clientX: number, clientY: number): void
  dragCancel(entry: T): void
  onOpenChange(open: boolean): void
  /** Focus entered (true) or left (false) the Library: bar, collections or items. */
  onFocusChange(focused: boolean): void
  onExitToCanvas(): void
  /** A cached preview image (data URL) for the entry, if one was rendered. */
  thumbnail?(entry: T): string | null
  /** Whether a viewport preview means something for this entry (scene-level items, not single props). */
  previewable?(entry: T): boolean
  /** Renders previews for these entries through the Lab's own viewport. */
  renderPreviews?(entries: T[], progress: (done: number, total: number) => void): Promise<void>
}

export type Library = ReturnType<typeof createLibrary>

const SEARCH_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
const TILES_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor"><rect x="2" y="2.5" width="5" height="4.5" rx="1"/><rect x="9" y="2.5" width="5" height="4.5" rx="1"/><rect x="2" y="9" width="5" height="4.5" rx="1"/><rect x="9" y="9" width="5" height="4.5" rx="1"/></svg>`
const LIST_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor"><rect x="2" y="3" width="2" height="2" rx=".5"/><rect x="5.5" y="3.2" width="8.5" height="1.6" rx=".8"/><rect x="2" y="7" width="2" height="2" rx=".5"/><rect x="5.5" y="7.2" width="8.5" height="1.6" rx=".8"/><rect x="2" y="11" width="2" height="2" rx=".5"/><rect x="5.5" y="11.2" width="8.5" height="1.6" rx=".8"/></svg>`

/** A tag that repeats its group heading ("Tree" under "Tree presets") adds nothing, so it is hidden. */
function tagIsRedundant(tag: string, heading: string): boolean {
  const t = tag.trim().toLowerCase()
  return !t || heading.toLowerCase().includes(t) || heading.toLowerCase().includes(t.replace(/s$/, ""))
}

function loadView(): LibraryView {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "tiles"
  } catch {
    return "tiles"
  }
}

export function createLibrary<T extends LibraryEntry>(host: HTMLElement, deps: LibraryDeps<T>, initialOpen: boolean) {
  let open = initialOpen
  let category: LabLibraryCategory = "effects"
  let group: string | null = null
  let query = ""
  let view: LibraryView = loadView()
  /** The keyboard cursor: the item that holds the grid's tab stop and that Enter in search runs. */
  let cursorId: string | null = null
  let structure = ""
  let stateSig = ""
  let visible: T[] = []
  let focused = false
  let rebuilding = false
  let previewing: { done: number; total: number } | null = null

  // Printable keys typed in the Library filter it, so global letter shortcuts (M mute, N voice note) skip it.
  host.dataset.typeahead = ""
  host.innerHTML = `
    <div class="lab-drawer-bar">
      <button type="button" class="lab-drawer-toggle" data-action="library-toggle" aria-expanded="false" aria-label="Toggle Library drawer" title="Toggle Library (Ctrl+Space)">
        <span class="lab-drawer-chev" aria-hidden="true">⌃</span><span class="lab-panel-title">Library</span>
      </button>
      <span class="lab-drawer-hint"><kbd>Ctrl</kbd><kbd>Space</kbd></span>
      <div class="lab-drawer-cats" role="tablist" aria-label="Library categories"></div>
      <span class="lab-fill"></span>
      <label class="lab-search lab-drawer-search">${SEARCH_ICON}<input type="search" class="lab-input" data-control="library-search" aria-label="Search library" placeholder="Search library" /></label>
      <div class="lab-drawer-views" role="group" aria-label="Library view">
        <button type="button" class="lab-btn lab-icon-btn" data-view="tiles" aria-label="Tiles view" title="Tiles with previews">${TILES_ICON}</button>
        <button type="button" class="lab-btn lab-icon-btn" data-view="list" aria-label="List view" title="Compact list">${LIST_ICON}</button>
      </div>
    </div>
    <div class="lab-drawer-body">
      <div class="lab-drawer-side">
        <nav class="lab-drawer-groups" aria-label="Library collections"></nav>
        <button type="button" class="lab-drawer-previews" data-action="library-previews" hidden></button>
      </div>
      <div class="lab-drawer-grid lab-catalog-list" role="listbox" aria-label="Catalog items"></div>
    </div>
  `
  const toggleBtn = host.querySelector<HTMLButtonElement>('[data-action="library-toggle"]')!
  const catsEl = host.querySelector<HTMLElement>(".lab-drawer-cats")!
  const groupsEl = host.querySelector<HTMLElement>(".lab-drawer-groups")!
  const grid = host.querySelector<HTMLElement>(".lab-drawer-grid")!
  const search = host.querySelector<HTMLInputElement>('[data-control="library-search"]')!
  const previewsBtn = host.querySelector<HTMLButtonElement>('[data-action="library-previews"]')!
  const viewBtns = [...host.querySelectorAll<HTMLButtonElement>("[data-view]")]
  const ghost = document.createElement("div")
  ghost.className = "lab-drag-ghost"
  ghost.hidden = true
  document.body.append(ghost)

  const catButtons = LIBRARY_CATEGORIES.map(c => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = "lab-drawer-cat"
    b.dataset.cat = c.id
    b.setAttribute("role", "tab")
    b.setAttribute("aria-label", `Category ${c.label}`)
    b.innerHTML = `<span class="lab-ticon">${libraryIconSvg(libraryIconFor({ id: "", label: "", tag: "", group: "" }, c.id), 12)}</span><span>${c.label}</span><span class="lab-tcount"></span>`
    b.onclick = () => selectCategory(c.id)
    catsEl.append(b)
    return b
  })

  function selectCategory(id: LabLibraryCategory) {
    category = id
    group = null
    cursorId = null
    if (query) {
      query = ""
      search.value = ""
    }
    setOpen(true)
    render(true)
  }

  function setOpen(next: boolean) {
    if (open === next) return
    open = next
    host.dataset.open = String(open)
    toggleBtn.setAttribute("aria-expanded", String(open))
    deps.onOpenChange(open)
    render(true)
  }
  host.dataset.open = String(open)
  toggleBtn.setAttribute("aria-expanded", String(open))
  toggleBtn.onclick = () => setOpen(!open)

  function setView(next: LibraryView) {
    if (view === next) return
    view = next
    try {
      localStorage.setItem(VIEW_KEY, view)
    } catch {}
    render(true)
  }
  for (const b of viewBtns) b.onclick = () => setView(b.dataset.view as LibraryView)

  let dragLock = false

  const tiles = () => [...grid.querySelectorAll<HTMLButtonElement>(".lab-tile")]
  const tileFor = (id: string | null) => (id ? grid.querySelector<HTMLButtonElement>(`.lab-tile[data-catalog-id="${CSS.escape(id)}"]`) : null)
  const groupButtons = () => [...groupsEl.querySelectorAll<HTMLButtonElement>(".lab-drawer-group")]
  const categoryLabel = (id: LabLibraryCategory) => LIBRARY_CATEGORIES.find(c => c.id === id)!.label

  function render(force = false) {
    if (dragLock) return
    const all = deps.entries()
    const assets = all.filter(isLibraryAsset)
    visible = filterLibrary(all, { category, group, query })
    if (cursorId && !visible.some(e => e.id === cursorId)) cursorId = null
    const counts = new Map<LabLibraryCategory, number>()
    for (const e of assets) counts.set(libraryCategoryOf(e), (counts.get(libraryCategoryOf(e)) ?? 0) + 1)
    const thumbs = visible.map(e => (deps.thumbnail?.(e) ? 1 : 0)).join("")
    const sig = JSON.stringify([open, category, group, query, view, visible.map(e => e.id + e.label), [...counts], thumbs, previewing])
    if (force || sig !== structure) {
      structure = sig
      rebuild(assets, counts)
    }
    syncState()
  }

  /** Cheap per-call state: which items are active and where the cursor is. No DOM is rebuilt. */
  function syncState() {
    const active = visible.filter(e => e.isActive?.()).map(e => e.id)
    const searchCursor = document.activeElement === search ? (cursorId ?? visible[0]?.id ?? null) : null
    const sig = `${active.join(",")}|${cursorId}|${searchCursor}`
    if (sig === stateSig) return
    stateSig = sig
    for (const t of tiles()) {
      const id = t.dataset.catalogId!
      const isActive = active.includes(id)
      if (t.getAttribute("aria-selected") !== String(isActive)) t.setAttribute("aria-selected", String(isActive))
      t.toggleAttribute("data-cursor", id === searchCursor)
    }
    const stop = tileFor(cursorId) ?? tiles()[0]
    for (const t of tiles()) t.tabIndex = t === stop ? 0 : -1
  }

  function rebuild(assets: T[], counts: Map<LabLibraryCategory, number>) {
    const focusIn = host.contains(document.activeElement) && document.activeElement !== search
    const focusedRole = focusIn ? (document.activeElement as HTMLElement).closest(".lab-tile") ? "tile" : (document.activeElement as HTMLElement).closest(".lab-drawer-group") ? "group" : (document.activeElement as HTMLElement).closest(".lab-drawer-cat") ? "cat" : "other" : null
    rebuilding = true
    try {
      host.dataset.view = view
      for (const b of viewBtns) b.setAttribute("aria-pressed", String(b.dataset.view === view))
      for (const b of catButtons) {
        const id = b.dataset.cat as LabLibraryCategory
        const n = counts.get(id) ?? 0
        const selected = open && !query && id === category
        b.setAttribute("aria-selected", String(selected))
        b.setAttribute("aria-pressed", String(selected))
        b.tabIndex = id === category ? 0 : -1
        b.dataset.empty = String(n === 0)
        b.querySelector(".lab-tcount")!.textContent = n ? String(n) : ""
      }
      if (!open) return
      renderGroups(assets)
      renderPreviewsButton()
      renderGrid()
    } finally {
      rebuilding = false
    }
    if (focusedRole === "tile") (tileFor(cursorId) ?? tiles()[0] ?? grid).focus({ preventScroll: true })
    else if (focusedRole === "group") groupButtons().find(b => b.tabIndex === 0)?.focus({ preventScroll: true })
    else if (focusedRole === "cat") catButtons.find(b => b.tabIndex === 0)?.focus({ preventScroll: true })
    tileFor(cursorId)?.scrollIntoView({ block: "nearest" })
  }

  function renderGroups(assets: T[]) {
    groupsEl.replaceChildren()
    const inCat = assets.filter(e => libraryCategoryOf(e) === category)
    const groups = [...new Set(inCat.map(e => e.group))]
    const make = (label: string, count: number, value: string | null) => {
      const b = document.createElement("button")
      b.type = "button"
      b.className = "lab-drawer-group"
      if (value) b.dataset.group = value
      const pressed = (group ?? null) === value && !query
      b.setAttribute("aria-pressed", String(pressed))
      b.tabIndex = (group ?? null) === value ? 0 : -1
      b.title = `${label} · ${count}`
      b.innerHTML = `<span></span><span class="lab-tcount">${count}</span>`
      b.firstElementChild!.textContent = label
      b.onclick = () => selectGroup(value)
      groupsEl.append(b)
    }
    make(`All ${categoryLabel(category).toLowerCase()}`, inCat.length, null)
    for (const g of groups) make(g, inCat.filter(e => e.group === g).length, g)
  }

  function selectGroup(value: string | null) {
    group = value
    cursorId = null
    if (query) {
      query = ""
      search.value = ""
    }
    render(true)
  }

  function previewTargets(): T[] {
    return deps.previewable ? visible.filter(e => deps.previewable!(e)) : []
  }

  function renderPreviewsButton() {
    const targets = previewTargets()
    previewsBtn.hidden = !deps.renderPreviews || !targets.length || view === "list"
    if (previewsBtn.hidden) return
    const missing = targets.filter(e => !deps.thumbnail?.(e)).length
    previewsBtn.disabled = Boolean(previewing)
    previewsBtn.textContent = previewing ? `Rendering ${previewing.done}/${previewing.total}` : missing ? "Render previews" : "Refresh previews"
    previewsBtn.title = `${missing ? `Render ${missing} missing preview${missing === 1 ? "" : "s"}` : `Render all ${targets.length} previews again`} through the Lab viewport; images are kept in this browser`
  }

  previewsBtn.onclick = async () => {
    if (!deps.renderPreviews || previewing) return
    const targets = previewTargets()
    const missing = targets.filter(e => !deps.thumbnail?.(e))
    const list = missing.length ? missing : targets
    previewing = { done: 0, total: list.length }
    render(true)
    try {
      await deps.renderPreviews(list, (done, total) => {
        previewing = { done, total }
        render(true)
      })
    } finally {
      previewing = null
      render(true)
    }
  }

  function renderGrid() {
    grid.replaceChildren()
    grid.dataset.view = view
    if (!visible.length) {
      const empty = document.createElement("div")
      empty.className = "lab-tree-empty"
      empty.textContent = query ? "Nothing in the Library matches" : `No ${categoryLabel(category)} registered on this page yet`
      grid.append(empty)
      return
    }
    let last = ""
    for (const entry of visible) {
      const cat = libraryCategoryOf(entry)
      const heading = query ? categoryLabel(cat) : entry.group
      if (heading !== last && (!group || query)) {
        last = heading
        const h = document.createElement("div")
        h.className = "lab-drawer-heading lab-catalog-group"
        h.textContent = heading
        grid.append(h)
      }
      const context = group && !query ? group : heading
      const tile = document.createElement("button")
      tile.type = "button"
      tile.className = "lab-tile lab-catalog-item"
      tile.dataset.catalogId = entry.id
      tile.dataset.placeable = String(isPlaceable(entry.id))
      tile.tabIndex = -1
      tile.setAttribute("role", "option")
      tile.setAttribute("aria-selected", "false")
      tile.setAttribute("aria-label", `${entry.label}, ${entry.tag}, ${entry.group}`)
      tile.title = isPlaceable(entry.id) ? `${entry.label} · ${entry.group} · click for a placement ghost, or drag into the viewport` : `${entry.label} · ${entry.group} · ${entry.tag}`
      const art = document.createElement("span")
      art.className = "lab-tile-art"
      const thumb = view === "tiles" ? deps.thumbnail?.(entry) : null
      if (thumb) {
        const img = document.createElement("img")
        img.alt = ""
        img.decoding = "async"
        img.src = thumb
        art.dataset.thumb = "true"
        art.append(img)
      } else art.innerHTML = libraryIconSvg(libraryIconFor(entry, cat), view === "tiles" ? 18 : 14)
      const text = document.createElement("span")
      text.className = "lab-tile-text"
      const name = document.createElement("span")
      name.className = "lab-tile-name"
      name.textContent = entry.label
      text.append(name)
      if (!tagIsRedundant(entry.tag, context)) {
        const tag = document.createElement("span")
        tag.className = "lab-tile-tag lab-catalog-tag"
        tag.textContent = entry.tag
        text.append(tag)
      }
      tile.append(art, text)
      bindTile(tile, entry)
      grid.append(tile)
    }
  }

  function bindTile(tile: HTMLButtonElement, entry: T) {
    let start: { x: number; y: number; id: number } | null = null
    let dragging = false
    let suppressClick = false
    tile.addEventListener("pointerdown", event => {
      if (event.button !== 0) return
      start = { x: event.clientX, y: event.clientY, id: event.pointerId }
      dragging = false
      try {
        tile.setPointerCapture(event.pointerId)
      } catch {}
    })
    tile.addEventListener("pointermove", event => {
      if (!start || event.pointerId !== start.id) return
      if (!dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
        dragging = true
        dragLock = true
        ghost.textContent = entry.label
        ghost.hidden = false
        host.dataset.dragging = "true"
      }
      if (dragging) {
        ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 10}px)`
        ghost.dataset.valid = String(deps.dragOver(entry, event.clientX, event.clientY))
      }
    })
    const finish = (event: PointerEvent, cancelled: boolean) => {
      if (!start || event.pointerId !== start.id) return
      if (dragging) {
        suppressClick = true
        ghost.hidden = true
        host.dataset.dragging = "false"
        dragLock = false
        if (!cancelled && ghost.dataset.valid === "true") deps.drop(entry, event.clientX, event.clientY)
        else deps.dragCancel(entry)
        render(true)
      }
      start = null
      dragging = false
    }
    tile.addEventListener("pointerup", event => finish(event, false))
    tile.addEventListener("pointercancel", event => finish(event, true))
    tile.addEventListener("focus", () => {
      if (cursorId !== entry.id) {
        cursorId = entry.id
        syncState()
      }
    })
    tile.addEventListener("click", event => {
      if (suppressClick) {
        suppressClick = false
        event.preventDefault()
        return
      }
      cursorId = entry.id
      apply(entry)
    })
  }

  function apply(entry: T) {
    deps.run(entry)
    render(true)
  }

  function focusGrid(id = cursorId) {
    if (!open) setOpen(true)
    const tile = tileFor(id) ?? tiles()[0]
    if (!tile) return false
    cursorId = tile.dataset.catalogId!
    syncState()
    tile.focus({ preventScroll: true })
    tile.scrollIntoView({ block: "nearest" })
    return true
  }

  function moveInGrid(from: HTMLButtonElement, move: GridMove) {
    const list = tiles()
    const rects = list.map(t => t.getBoundingClientRect())
    const rows = Math.max(1, Math.floor(grid.clientHeight / Math.max(1, rects[0]?.height ?? 1)) - 1)
    const next = gridNeighbor(rects, list.indexOf(from), move, rows)
    if (next >= 0) focusGrid(list[next]!.dataset.catalogId!)
  }

  /** Type-to-filter: a printable key typed anywhere in the Library goes to the search field. */
  function typeIntoSearch(text: string | null) {
    if (!open) setOpen(true)
    search.focus()
    if (text === null) search.value = search.value.slice(0, -1)
    else search.value += text
    search.dispatchEvent(new Event("input", { bubbles: true }))
  }

  const MOVES: Record<string, GridMove> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Home: "home", End: "end", PageUp: "pageUp", PageDown: "pageDown" }

  host.addEventListener("keydown", event => {
    const target = event.target as HTMLElement
    if (target === search) return onSearchKey(event)
    if (event.metaKey || event.ctrlKey) return
    let handled = true
    const tile = target.closest<HTMLButtonElement>(".lab-tile")
    const groupBtn = target.closest<HTMLButtonElement>(".lab-drawer-group")
    const catBtn = target.closest<HTMLButtonElement>(".lab-drawer-cat")
    if (event.key === "Escape") deps.onExitToCanvas()
    else if (tile && (event.key === "Enter" || event.key === " ")) {
      if (!event.repeat) {
        const entry = visible.find(e => e.id === tile.dataset.catalogId)
        if (entry) apply(entry)
      }
    } else if (tile && MOVES[event.key]) moveInGrid(tile, MOVES[event.key]!)
    else if (groupBtn && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")) {
      const list = groupButtons()
      const i = list.indexOf(groupBtn)
      const j = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : Math.max(0, Math.min(list.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)))
      if (j !== i) selectGroup(list[j]!.dataset.group ?? null)
    } else if (groupBtn && (event.key === "ArrowRight" || event.key === "Enter")) focusGrid()
    else if (catBtn && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")) {
      const i = catButtons.indexOf(catBtn)
      const n = catButtons.length
      const j = event.key === "Home" ? 0 : event.key === "End" ? n - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + n) % n
      selectCategory(catButtons[j]!.dataset.cat as LabLibraryCategory)
    } else if (catBtn && event.key === "ArrowDown") focusGrid()
    else if (event.key === "Backspace" && search.value) typeIntoSearch(null)
    else if (isFilterKey(event)) typeIntoSearch(event.key)
    else if (event.key === "Enter" || event.key === " ") {
      // Buttons in the bar activate natively; keep the key from reaching canvas shortcuts (Space retriggers).
      event.stopPropagation()
      return
    } else handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  })

  function onSearchKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      event.stopPropagation()
      focusGrid(cursorId ?? visible[0]?.id ?? null)
    } else if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      const chosen = visible.find(e => e.id === cursorId) ?? visible[0]
      if (chosen) deps.run(chosen)
      deps.onExitToCanvas()
      render(true)
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (search.value) {
        search.value = ""
        query = ""
        render(true)
      } else deps.onExitToCanvas()
    }
  }

  host.addEventListener("focusin", () => {
    if (focused) return
    focused = true
    deps.onFocusChange(true)
    syncState()
  })
  host.addEventListener("focusout", event => {
    if (rebuilding || host.contains(event.relatedTarget as Node | null)) return
    focused = false
    deps.onFocusChange(false)
    syncState()
  })
  search.addEventListener("focus", () => syncState())
  search.addEventListener("input", () => {
    query = search.value
    cursorId = null
    if (query && !open) setOpen(true)
    render(true)
  })

  render(true)

  return {
    el: host,
    search,
    get open() {
      return open
    },
    get category() {
      return category
    },
    get query() {
      return query
    },
    get view() {
      return view
    },
    get focused() {
      return focused
    },
    get cursor() {
      return cursorId
    },
    get visibleIds(): string[] {
      return visible.map(e => e.id)
    },
    setOpen,
    setView,
    toggle: () => setOpen(!open),
    setCategory(next: LabLibraryCategory, openDrawer = false) {
      category = next
      group = null
      cursorId = null
      if (openDrawer) setOpen(true)
      render(true)
    },
    setGroup: (next: string | null) => selectGroup(next),
    setQuery(next: string) {
      query = next
      search.value = next
      cursorId = null
      if (next && !open) setOpen(true)
      render(true)
    },
    focusSearch() {
      if (!open) setOpen(true)
      search.focus()
      search.select()
    },
    /** Moves keyboard focus to the item grid (the cursor item, or the first). */
    focusGrid: (id?: string) => focusGrid(id ?? cursorId),
    render: () => render(),
  }
}
