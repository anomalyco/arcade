import type { LabLibraryCategory } from "./types"

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

export type LibraryDeps<T extends LibraryEntry> = {
  entries(): T[]
  run(entry: T): void
  /** Pointer drag of a tile over the page; return true when the point is a valid drop target. */
  dragOver(entry: T, clientX: number, clientY: number): boolean
  drop(entry: T, clientX: number, clientY: number): void
  dragCancel(entry: T): void
  onOpenChange(open: boolean): void
  onFocusChange(focused: boolean): void
  onExitToCanvas(): void
}

export type Library = ReturnType<typeof createLibrary>

export function createLibrary<T extends LibraryEntry>(host: HTMLElement, deps: LibraryDeps<T>, initialOpen: boolean) {
  let open = initialOpen
  let category: LabLibraryCategory = "effects"
  let group: string | null = null
  let query = ""
  let highlighted = 0
  let signature = ""
  let visible: T[] = []

  host.innerHTML = `
    <div class="lab-drawer-bar">
      <button type="button" class="lab-drawer-toggle" data-action="library-toggle" aria-expanded="false" aria-label="Toggle Library drawer" title="Toggle Library (Ctrl+Space)">
        <span class="lab-drawer-chev" aria-hidden="true">⌃</span><span class="lab-panel-title">Library</span>
      </button>
      <span class="lab-drawer-hint"><kbd>Ctrl</kbd><kbd>Space</kbd></span>
      <div class="lab-drawer-cats" role="group" aria-label="Library categories"></div>
      <span class="lab-fill"></span>
      <label class="lab-search lab-drawer-search"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input type="search" class="lab-input" data-control="library-search" aria-label="Search library" placeholder="Search library" /></label>
    </div>
    <div class="lab-drawer-body">
      <nav class="lab-drawer-groups" aria-label="Library collections"></nav>
      <div class="lab-drawer-grid lab-catalog-list" role="listbox" aria-label="Catalog items"></div>
    </div>
  `
  const toggleBtn = host.querySelector<HTMLButtonElement>('[data-action="library-toggle"]')!
  const catsEl = host.querySelector<HTMLElement>(".lab-drawer-cats")!
  const groupsEl = host.querySelector<HTMLElement>(".lab-drawer-groups")!
  const grid = host.querySelector<HTMLElement>(".lab-drawer-grid")!
  const search = host.querySelector<HTMLInputElement>('[data-control="library-search"]')!
  const ghost = document.createElement("div")
  ghost.className = "lab-drag-ghost"
  ghost.hidden = true
  document.body.append(ghost)

  const catButtons = LIBRARY_CATEGORIES.map(c => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = "lab-drawer-cat"
    b.dataset.cat = c.id
    b.setAttribute("aria-label", `Category ${c.label}`)
    b.innerHTML = `<span class="lab-ticon">${c.icon}</span><span>${c.label}</span><span class="lab-tcount"></span>`
    b.onclick = () => {
      category = c.id
      group = null
      highlighted = 0
      if (query) {
        query = ""
        search.value = ""
      }
      setOpen(true)
      render(true)
    }
    catsEl.append(b)
    return b
  })

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

  let dragLock = false

  function render(force = false) {
    if (dragLock) return
    const all = deps.entries()
    const assets = all.filter(isLibraryAsset)
    visible = filterLibrary(all, { category, group, query })
    highlighted = Math.max(0, Math.min(highlighted, visible.length - 1))
    const counts = new Map<LabLibraryCategory, number>()
    for (const e of assets) counts.set(libraryCategoryOf(e), (counts.get(libraryCategoryOf(e)) ?? 0) + 1)
    const active = visible.filter(e => e.isActive?.()).map(e => e.id)
    const sig = JSON.stringify([open, category, group, query, highlighted, visible.map(e => e.id + e.label), active, [...counts]])
    if (!force && sig === signature) return
    signature = sig
    for (const b of catButtons) {
      const id = b.dataset.cat as LabLibraryCategory
      const n = counts.get(id) ?? 0
      b.setAttribute("aria-pressed", String(open && !query && id === category))
      b.dataset.empty = String(n === 0)
      b.querySelector(".lab-tcount")!.textContent = n ? String(n) : ""
    }
    if (!open) return
    groupsEl.replaceChildren()
    const inCat = assets.filter(e => libraryCategoryOf(e) === category)
    const groups = [...new Set(inCat.map(e => e.group))]
    const allBtn = document.createElement("button")
    allBtn.type = "button"
    allBtn.className = "lab-drawer-group"
    allBtn.setAttribute("aria-pressed", String(!group && !query))
    allBtn.innerHTML = `<span>All ${LIBRARY_CATEGORIES.find(c => c.id === category)!.label.toLowerCase()}</span><span class="lab-tcount">${inCat.length}</span>`
    allBtn.onclick = () => {
      group = null
      render(true)
    }
    groupsEl.append(allBtn)
    for (const g of groups) {
      const b = document.createElement("button")
      b.type = "button"
      b.className = "lab-drawer-group"
      b.dataset.group = g
      b.setAttribute("aria-pressed", String(group === g && !query))
      b.innerHTML = `<span></span><span class="lab-tcount">${inCat.filter(e => e.group === g).length}</span>`
      b.firstElementChild!.textContent = g
      b.onclick = () => {
        group = g
        if (query) {
          query = ""
          search.value = ""
        }
        render(true)
      }
      groupsEl.append(b)
    }
    grid.replaceChildren()
    if (!visible.length) {
      const empty = document.createElement("div")
      empty.className = "lab-tree-empty"
      empty.textContent = query
        ? "Nothing in the Library matches"
        : `No ${LIBRARY_CATEGORIES.find(c => c.id === category)!.label} registered on this page yet`
      grid.append(empty)
      return
    }
    let last = ""
    visible.forEach((entry, idx) => {
      const heading = query ? LIBRARY_CATEGORIES.find(c => c.id === libraryCategoryOf(entry))!.label : entry.group
      if (heading !== last && (!group || query)) {
        last = heading
        const h = document.createElement("div")
        h.className = "lab-drawer-heading lab-catalog-group"
        h.textContent = heading
        grid.append(h)
      }
      const tile = document.createElement("button")
      tile.type = "button"
      tile.className = "lab-tile lab-catalog-item"
      tile.dataset.catalogId = entry.id
      tile.dataset.placeable = String(isPlaceable(entry.id))
      tile.setAttribute("role", "option")
      tile.setAttribute("aria-selected", String(Boolean(entry.isActive?.()) || (idx === highlighted && document.activeElement === search)))
      tile.title = isPlaceable(entry.id) ? `${entry.label} · click for a placement ghost, or drag into the viewport` : `${entry.label} · ${entry.group}`
      const art = document.createElement("span")
      art.className = "lab-tile-art"
      art.textContent = LIBRARY_CATEGORIES.find(c => c.id === libraryCategoryOf(entry))!.icon
      const name = document.createElement("span")
      name.className = "lab-tile-name"
      name.textContent = entry.label
      const tag = document.createElement("span")
      tag.className = "lab-tile-tag lab-catalog-tag"
      tag.textContent = entry.tag
      tile.append(art, name, tag)
      bindTile(tile, entry)
      grid.append(tile)
    })
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
    tile.addEventListener("click", event => {
      if (suppressClick) {
        suppressClick = false
        event.preventDefault()
        return
      }
      deps.run(entry)
      render(true)
    })
  }

  search.addEventListener("focus", () => deps.onFocusChange(true))
  search.addEventListener("blur", () => deps.onFocusChange(false))
  search.addEventListener("input", () => {
    query = search.value
    highlighted = 0
    if (query && !open) setOpen(true)
    render(true)
  })
  search.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const n = visible.length
      highlighted = n ? (highlighted + (event.key === "ArrowDown" ? 1 : -1) + n) % n : 0
      render(true)
      grid.querySelectorAll<HTMLElement>(".lab-tile")[highlighted]?.scrollIntoView({ block: "nearest" })
    } else if (event.key === "Enter") {
      event.preventDefault()
      const chosen = visible[highlighted]
      if (chosen) deps.run(chosen)
      deps.onExitToCanvas()
      render(true)
    } else if (event.key === "Escape") {
      event.preventDefault()
      if (search.value) {
        search.value = ""
        query = ""
        render(true)
      } else deps.onExitToCanvas()
    }
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
    get visibleIds(): string[] {
      return visible.map(e => e.id)
    },
    setOpen,
    toggle: () => setOpen(!open),
    setCategory(next: LabLibraryCategory, openDrawer = false) {
      category = next
      group = null
      if (openDrawer) setOpen(true)
      render(true)
    },
    setQuery(next: string) {
      query = next
      search.value = next
      if (next && !open) setOpen(true)
      render(true)
    },
    focusSearch() {
      if (!open) setOpen(true)
      search.focus()
      search.select()
    },
    render: () => render(),
  }
}
