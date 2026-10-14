import type { LabWorldObject } from "./types"

export type OutlinerGroupId = "characters" | "vehicles" | "props" | "emitters" | "lights" | "specimens"

export const OUTLINER_GROUPS: readonly { id: OutlinerGroupId; label: string; icon: string }[] = [
  { id: "characters", label: "Characters", icon: "♟" },
  { id: "vehicles", label: "Vehicles", icon: "◧" },
  { id: "props", label: "Props", icon: "▣" },
  { id: "emitters", label: "Emitters", icon: "✺" },
  { id: "lights", label: "Lights", icon: "✦" },
  { id: "specimens", label: "Fixtures", icon: "◇" },
]

export type OutlinerRow =
  | { type: "group"; key: string; group: OutlinerGroupId; label: string; count: number; collapsed: boolean }
  | { type: "fold"; key: string; group: OutlinerGroupId; label: string; kind: string; count: number; ids: string[]; expanded: boolean }
  | { type: "object"; key: string; group: OutlinerGroupId; object: LabWorldObject; depth: 1 | 2 }

export type OutlinerViewState = {
  query?: string
  collapsed?: ReadonlySet<string>
  expanded?: ReadonlySet<string>
  hiddenGroups?: ReadonlySet<string>
}

export function outlinerGroupOf(object: LabWorldObject): OutlinerGroupId {
  switch (object.category) {
    case "character":
      return object.vehicle ? "vehicles" : "characters"
    case "prop":
      return "props"
    case "emitter":
      return "emitters"
    case "light":
      return "lights"
    default:
      return "specimens"
  }
}

/** Repeat key: the object's catalog kind, or its label without a trailing instance number. */
export function outlinerKindOf(object: LabWorldObject): string {
  if (object.kind) return object.kind
  return object.label.replace(/\s*(#\d+|\(\d+\)|\d+)$/, "").trim().toLowerCase()
}

function kindLabel(objects: readonly LabWorldObject[]): string {
  const base = objects[0]!.label.replace(/\s*(#\d+|\(\d+\)|\d+)$/, "").trim()
  return base || objects[0]!.label
}

function matches(object: LabWorldObject, group: string, q: string): boolean {
  return `${object.label} ${object.id} ${object.kind ?? ""} ${object.category} ${group}`.toLowerCase().includes(q)
}

/** Flattened tree rows: type groups with counts, repeated kinds folded into "Cone ×5" rows. */
export function buildOutlinerRows(objects: readonly LabWorldObject[], view: OutlinerViewState = {}): OutlinerRow[] {
  const q = view.query?.trim().toLowerCase() ?? ""
  const rows: OutlinerRow[] = []
  for (const def of OUTLINER_GROUPS) {
    if (view.hiddenGroups?.has(def.id)) continue
    const inGroup = objects.filter(o => outlinerGroupOf(o) === def.id && (!q || matches(o, def.label, q)))
    if (!inGroup.length) continue
    const collapsed = !q && Boolean(view.collapsed?.has(def.id))
    rows.push({ type: "group", key: `group:${def.id}`, group: def.id, label: def.label, count: inGroup.length, collapsed })
    if (collapsed) continue
    const byKind = new Map<string, LabWorldObject[]>()
    for (const o of inGroup) {
      const k = outlinerKindOf(o)
      const list = byKind.get(k)
      if (list) list.push(o)
      else byKind.set(k, [o])
    }
    const emitted = new Set<string>()
    for (const o of inGroup) {
      const k = outlinerKindOf(o)
      const same = byKind.get(k)!
      if (same.length < 2) {
        rows.push({ type: "object", key: `obj:${o.id}`, group: def.id, object: o, depth: 1 })
        continue
      }
      if (emitted.has(k)) continue
      emitted.add(k)
      const foldKey = `fold:${def.id}:${k}`
      const expanded = Boolean(q) || Boolean(view.expanded?.has(foldKey))
      rows.push({ type: "fold", key: foldKey, group: def.id, label: kindLabel(same), kind: k, count: same.length, ids: same.map(s => s.id), expanded })
      if (expanded) for (const s of same) rows.push({ type: "object", key: `obj:${s.id}`, group: def.id, object: s, depth: 2 })
    }
  }
  return rows
}

/** Object ids covered by a row (a fold selects all of its members). */
export function rowObjectIds(row: OutlinerRow): string[] {
  if (row.type === "object") return [row.object.id]
  if (row.type === "fold") return [...row.ids]
  return []
}

/** Shift-click range between two rows, in visible order. */
export function rangeSelection(rows: readonly OutlinerRow[], anchorKey: string, targetKey: string): string[] {
  const a = rows.findIndex(r => r.key === anchorKey)
  const b = rows.findIndex(r => r.key === targetKey)
  if (a < 0 || b < 0) return b >= 0 ? rowObjectIds(rows[b]!) : []
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const ids: string[] = []
  for (let i = lo; i <= hi; i++) for (const id of rowObjectIds(rows[i]!)) if (!ids.includes(id)) ids.push(id)
  return ids
}

export type OutlinerDeps = {
  objects(): readonly LabWorldObject[]
  selectedIds(): readonly string[]
  isLocked(id: string): boolean
  /** Replace the selection. `primary` is the row the user acted on. */
  select(ids: string[], primary: string | null): void
  toggleLock(id: string): void
  frame(id: string): void
  onFocusChange(focused: boolean): void
  onExitToCanvas(): void
}

export type Outliner = ReturnType<typeof createOutliner>

export function createOutliner(host: HTMLElement, deps: OutlinerDeps) {
  const collapsed = new Set<string>()
  const expanded = new Set<string>()
  const hiddenGroups = new Set<string>()
  let query = ""
  let activeKey: string | null = null
  let anchorKey: string | null = null
  let rows: OutlinerRow[] = []
  let signature = ""

  host.innerHTML = `
    <div class="lab-panel-head">
      <span class="lab-panel-title">Outliner</span><span class="lab-panel-count" data-outliner-count></span>
      <span class="lab-fill"></span>
      <button type="button" class="lab-icon-btn" data-action="outliner-filter" aria-label="Filter Outliner by type" aria-haspopup="menu" title="Filter by type">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="lab-icon-btn" data-action="outliner-add" aria-label="Add from Library" title="Add from Library (Ctrl+Space)">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="lab-outliner-menu" data-outliner-menu role="menu" aria-label="Show types" hidden></div>
    <label class="lab-search"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input type="search" data-control="outliner-search" aria-label="Search scene" placeholder="Search scene" /></label>
    <div class="lab-tree" role="tree" aria-label="Scene objects" aria-multiselectable="true" tabindex="0" data-outliner-tree></div>
  `
  const countEl = host.querySelector<HTMLElement>("[data-outliner-count]")!
  const tree = host.querySelector<HTMLElement>("[data-outliner-tree]")!
  const search = host.querySelector<HTMLInputElement>('[data-control="outliner-search"]')!
  const filterBtn = host.querySelector<HTMLButtonElement>('[data-action="outliner-filter"]')!
  const menu = host.querySelector<HTMLElement>("[data-outliner-menu]")!

  function rebuild(force = false) {
    const objects = deps.objects()
    rows = buildOutlinerRows(objects, { query, collapsed, expanded, hiddenGroups })
    const sel = new Set(deps.selectedIds())
    const sig = JSON.stringify([
      rows.map(r => (r.type === "object" ? [r.key, r.object.label, deps.isLocked(r.object.id)] : [r.key, r.count, r.type === "group" ? r.collapsed : r.expanded])),
      [...sel],
      activeKey,
      query,
    ])
    countEl.textContent = String(objects.length)
    filterBtn.setAttribute("aria-pressed", String(hiddenGroups.size > 0))
    if (!force && sig === signature) return
    signature = sig
    if (activeKey && !rows.some(r => r.key === activeKey)) activeKey = null
    tree.replaceChildren()
    if (!rows.length) {
      const empty = document.createElement("div")
      empty.className = "lab-tree-empty"
      empty.textContent = query ? "Nothing in the scene matches" : "Nothing placed yet. Open the Library (Ctrl+Space) to add objects."
      tree.append(empty)
      tree.removeAttribute("aria-activedescendant")
      return
    }
    for (const row of rows) tree.append(renderRow(row, sel))
    if (activeKey) tree.setAttribute("aria-activedescendant", domId(activeKey))
    else tree.removeAttribute("aria-activedescendant")
  }

  function domId(key: string) {
    return `lab-ol-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`
  }

  function renderRow(row: OutlinerRow, sel: ReadonlySet<string>): HTMLElement {
    const el = document.createElement("div")
    el.id = domId(row.key)
    el.className = "lab-trow"
    el.dataset.rowKey = row.key
    el.dataset.rowType = row.type
    el.setAttribute("role", "treeitem")
    el.dataset.active = String(row.key === activeKey)
    const chev = document.createElement("span")
    chev.className = "lab-tchev"
    const name = document.createElement("span")
    name.className = "lab-tname"
    if (row.type === "group") {
      const def = OUTLINER_GROUPS.find(g => g.id === row.group)!
      el.classList.add("lab-tgroup")
      el.setAttribute("aria-level", "1")
      el.setAttribute("aria-expanded", String(!row.collapsed))
      chev.textContent = row.collapsed ? "›" : "⌄"
      name.textContent = def.label
      const count = document.createElement("span")
      count.className = "lab-tcount"
      count.textContent = String(row.count)
      el.append(chev, name, count)
      return el
    }
    const def = OUTLINER_GROUPS.find(g => g.id === row.group)!
    const icon = document.createElement("span")
    icon.className = "lab-ticon"
    icon.textContent = def.icon
    if (row.type === "fold") {
      el.classList.add("lab-tfold")
      el.setAttribute("aria-level", "2")
      el.setAttribute("aria-expanded", String(row.expanded))
      el.style.setProperty("--depth", "1")
      chev.textContent = row.expanded ? "⌄" : "›"
      name.textContent = row.label
      const times = document.createElement("span")
      times.className = "lab-tx"
      times.textContent = `×${row.count}`
      name.append(" ", times)
      const selectedCount = row.ids.filter(id => sel.has(id)).length
      el.setAttribute("aria-selected", String(selectedCount > 0 && selectedCount === row.ids.length))
      el.dataset.partial = String(selectedCount > 0 && selectedCount < row.ids.length)
      el.append(chev, icon, name)
      return el
    }
    const o = row.object
    el.classList.add("lab-tobj")
    el.dataset.objectId = o.id
    el.setAttribute("aria-level", String(row.depth + 1))
    el.style.setProperty("--depth", String(row.depth))
    el.setAttribute("aria-selected", String(sel.has(o.id)))
    const locked = deps.isLocked(o.id)
    el.dataset.locked = String(locked)
    chev.classList.add("lab-tchev-sp")
    name.textContent = o.label
    name.title = `${o.label} · ${o.id}`
    const lock = document.createElement("button")
    lock.type = "button"
    lock.className = "lab-tcol"
    lock.dataset.action = "outliner-lock"
    lock.tabIndex = -1
    lock.setAttribute("aria-pressed", String(locked))
    lock.setAttribute("aria-label", `${locked ? "Unlock" : "Lock"} ${o.label}`)
    lock.title = locked ? "Locked: not pickable in the viewport (click to unlock)" : "Lock: ignore in viewport picking and marquee"
    lock.innerHTML = locked
      ? `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="currentColor"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`
      : `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 4.8-1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`
    el.append(chev, icon, name, lock)
    return el
  }

  function rowOf(el: Element | null): OutlinerRow | undefined {
    const key = el?.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey
    return key ? rows.find(r => r.key === key) : undefined
  }

  function toggleRow(row: OutlinerRow, open?: boolean) {
    if (row.type === "group") {
      const willOpen = open ?? row.collapsed
      if (willOpen) collapsed.delete(row.group)
      else collapsed.add(row.group)
    } else if (row.type === "fold") {
      const willOpen = open ?? !row.expanded
      if (willOpen) expanded.add(row.key)
      else expanded.delete(row.key)
    }
    rebuild()
  }

  function activate(row: OutlinerRow, mode: "replace" | "toggle" | "range") {
    activeKey = row.key
    const ids = rowObjectIds(row)
    if (!ids.length) {
      rebuild()
      return
    }
    const current = [...deps.selectedIds()]
    let next: string[]
    if (mode === "range" && anchorKey) {
      next = [...new Set([...current, ...rangeSelection(rows, anchorKey, row.key)])]
    } else if (mode === "toggle") {
      const allIn = ids.every(id => current.includes(id))
      next = allIn ? current.filter(id => !ids.includes(id)) : [...current, ...ids.filter(id => !current.includes(id))]
      anchorKey = row.key
    } else {
      next = ids
      anchorKey = row.key
    }
    deps.select(next, row.type === "object" ? row.object.id : ids.at(-1) ?? null)
    rebuild()
  }

  tree.addEventListener("pointerdown", event => {
    const target = event.target as HTMLElement
    if (target.closest('[data-action="outliner-lock"]')) return
    const row = rowOf(target)
    if (!row || event.button !== 0) return
    event.preventDefault()
    tree.focus({ preventScroll: true })
    const onChevron = Boolean(target.closest(".lab-tchev"))
    if (row.type === "group" || (row.type === "fold" && onChevron)) {
      activeKey = row.key
      toggleRow(row)
      return
    }
    activate(row, event.shiftKey ? "range" : event.metaKey || event.ctrlKey ? "toggle" : "replace")
  })
  tree.addEventListener("click", event => {
    const lock = (event.target as HTMLElement).closest<HTMLElement>('[data-action="outliner-lock"]')
    if (!lock) return
    const row = rowOf(lock)
    if (row?.type === "object") {
      deps.toggleLock(row.object.id)
      rebuild(true)
    }
  })
  tree.addEventListener("dblclick", event => {
    const row = rowOf(event.target as HTMLElement)
    if (row?.type === "object") deps.frame(row.object.id)
    else if (row?.type === "fold") deps.frame(row.ids.at(-1)!)
  })
  tree.addEventListener("focus", () => {
    if (!activeKey) {
      const sel = deps.selectedIds()
      activeKey = rows.find(r => r.type === "object" && sel.includes(r.object.id))?.key ?? rows[0]?.key ?? null
      rebuild()
    }
    deps.onFocusChange(true)
  })
  tree.addEventListener("blur", () => deps.onFocusChange(false))
  tree.addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const idx = rows.findIndex(r => r.key === activeKey)
    const row = idx >= 0 ? rows[idx] : undefined
    const go = (next: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, next))]
      if (!target) return
      if (target.type === "group") {
        activeKey = target.key
        rebuild()
      } else activate(target, event.shiftKey ? "range" : "replace")
      tree.querySelector(`#${domId(target.key)}`)?.scrollIntoView({ block: "nearest" })
    }
    let handled = true
    switch (event.key) {
      case "ArrowDown":
        go(idx + 1)
        break
      case "ArrowUp":
        go(idx < 0 ? rows.length - 1 : idx - 1)
        break
      case "Home":
        go(0)
        break
      case "End":
        go(rows.length - 1)
        break
      case "ArrowRight":
        if (row && (row.type === "group" ? row.collapsed : row.type === "fold" && !row.expanded)) toggleRow(row, true)
        else go(idx + 1)
        break
      case "ArrowLeft":
        if (row && (row.type === "group" ? !row.collapsed : row.type === "fold" && row.expanded)) toggleRow(row, false)
        else if (row) {
          const parent = rows.slice(0, idx).reverse().find(r => (row.type === "object" && row.depth === 2 ? r.type === "fold" : r.type === "group"))
          if (parent) {
            activeKey = parent.key
            rebuild()
          }
        }
        break
      case "Enter":
        if (row?.type === "group") toggleRow(row)
        else if (row?.type === "object") deps.frame(row.object.id)
        else if (row?.type === "fold") toggleRow(row)
        break
      case " ":
        if (row?.type === "group") toggleRow(row)
        else if (row) activate(row, "toggle")
        break
      case "Escape":
        deps.onExitToCanvas()
        break
      default:
        handled = false
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  })

  search.addEventListener("input", () => {
    query = search.value
    rebuild()
  })
  search.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (search.value) {
        search.value = ""
        query = ""
        rebuild()
      } else deps.onExitToCanvas()
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      tree.focus({ preventScroll: true })
      const first = rows.find(r => r.type !== "group")
      if (first && event.key === "Enter") activate(first, "replace")
    }
  })

  function renderMenu() {
    menu.replaceChildren()
    for (const def of OUTLINER_GROUPS) {
      const item = document.createElement("button")
      item.type = "button"
      item.className = "lab-menu-item"
      item.setAttribute("role", "menuitemcheckbox")
      item.setAttribute("aria-checked", String(!hiddenGroups.has(def.id)))
      item.dataset.group = def.id
      item.innerHTML = `<span class="lab-menu-check">${hiddenGroups.has(def.id) ? "" : "✓"}</span><span class="lab-ticon">${def.icon}</span><span>${def.label}</span>`
      item.onclick = () => {
        if (hiddenGroups.has(def.id)) hiddenGroups.delete(def.id)
        else hiddenGroups.add(def.id)
        renderMenu()
        rebuild()
      }
      menu.append(item)
    }
    const all = document.createElement("button")
    all.type = "button"
    all.className = "lab-menu-item"
    all.innerHTML = `<span class="lab-menu-check"></span><span></span><span>Show all types</span>`
    all.onclick = () => {
      hiddenGroups.clear()
      renderMenu()
      rebuild()
    }
    menu.append(all)
  }
  filterBtn.addEventListener("click", () => {
    menu.hidden = !menu.hidden
    if (!menu.hidden) renderMenu()
  })
  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !menu.contains(event.target as Node) && !filterBtn.contains(event.target as Node)) menu.hidden = true
  })

  return {
    el: host,
    tree,
    search,
    addButton: host.querySelector<HTMLButtonElement>('[data-action="outliner-add"]')!,
    render: () => rebuild(),
    get rows(): readonly OutlinerRow[] {
      return rows
    },
    focus() {
      tree.focus({ preventScroll: true })
    },
    setGroupCollapsed(group: string, value: boolean) {
      if (value) collapsed.add(group)
      else collapsed.delete(group)
      rebuild()
    },
    setFoldExpanded(key: string, value: boolean) {
      if (value) expanded.add(key)
      else expanded.delete(key)
      rebuild()
    },
    setQuery(next: string) {
      query = next
      search.value = next
      rebuild()
    },
    get collapsedGroups(): string[] {
      return [...collapsed]
    },
    /** Reveal an object row (expand its group/fold) and mark it active. */
    reveal(id: string) {
      const obj = deps.objects().find(o => o.id === id)
      if (!obj) return
      const group = outlinerGroupOf(obj)
      collapsed.delete(group)
      const kind = outlinerKindOf(obj)
      expanded.add(`fold:${group}:${kind}`)
      activeKey = `obj:${id}`
      rebuild()
      tree.querySelector(`#${domId(activeKey)}`)?.scrollIntoView({ block: "nearest" })
    },
  }
}
