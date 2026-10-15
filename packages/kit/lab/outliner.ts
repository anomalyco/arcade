import { popover, tree, type Tree } from "@arcade/knobs/ui"
import { arcadePreset } from "../lab-knobs"
import { tip } from "./overlays"
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

/** A node of the Outliner's tree: a type group, a fold of repeated kinds ("Cone ×5"), or one object. */
export type OutlinerNode = {
  id: string
  label: string
  type: "group" | "fold" | "object"
  group: OutlinerGroupId
  /** Objects at or under this node. */
  ids: string[]
  object?: LabWorldObject
  children?: OutlinerNode[]
}

/** The Outliner as a tree: type groups, repeated kinds folded under one node, single objects as leaves. */
export function buildOutlinerTree(objects: readonly LabWorldObject[], hiddenGroups: ReadonlySet<string> = new Set()): OutlinerNode[] {
  const nodes: OutlinerNode[] = []
  for (const def of OUTLINER_GROUPS) {
    if (hiddenGroups.has(def.id)) continue
    const inGroup = objects.filter(o => outlinerGroupOf(o) === def.id)
    if (!inGroup.length) continue
    const leaf = (o: LabWorldObject): OutlinerNode => ({ id: `obj:${o.id}`, label: o.label, type: "object", group: def.id, ids: [o.id], object: o })
    const byKind = new Map<string, LabWorldObject[]>()
    for (const o of inGroup) {
      const k = outlinerKindOf(o)
      byKind.set(k, [...(byKind.get(k) ?? []), o])
    }
    const children: OutlinerNode[] = []
    const emitted = new Set<string>()
    for (const o of inGroup) {
      const k = outlinerKindOf(o)
      const same = byKind.get(k)!
      if (same.length < 2) children.push(leaf(o))
      else if (!emitted.has(k)) {
        emitted.add(k)
        children.push({ id: `fold:${def.id}:${k}`, label: kindLabel(same), type: "fold", group: def.id, ids: same.map(x => x.id), children: same.map(leaf) })
      }
    }
    nodes.push({ id: `group:${def.id}`, label: def.label, type: "group", group: def.id, ids: inGroup.map(o => o.id), children })
  }
  return nodes
}

/** Objects a tree selection stands for: an object row is itself, a fold row is all of its members. */
export function selectedObjects(nodes: readonly OutlinerNode[], rowIds: readonly string[]): string[] {
  const byId = new Map<string, OutlinerNode>()
  const walk = (list: readonly OutlinerNode[]) => { for (const n of list) { byId.set(n.id, n); if (n.children) walk(n.children) } }
  walk(nodes)
  const out: string[] = []
  for (const id of rowIds) {
    const n = byId.get(id)
    if (!n || n.type === "group") continue
    for (const o of n.ids) if (!out.includes(o)) out.push(o)
  }
  return out
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

const LOCK = (locked: boolean) =>
  locked
    ? `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="currentColor"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`
    : `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 4.8-1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`

/**
 * The scene's objects in a knobs/ui `tree`: type groups, repeated kinds folded ("Cone ×5", selecting the fold selects
 * them all), a lock toggle per row, a text search and a type filter. Its selection is the workbench's selection.
 * Letters are the workbench's shortcuts here too (F frames, G moves, P plays), so the tree's type-ahead never sees them.
 */
export function createOutliner(host: HTMLElement, deps: OutlinerDeps) {
  const collapsed = new Set<string>()
  const hiddenGroups = new Set<string>()
  let query = ""
  let nodes: OutlinerNode[] = []
  let signature = ""
  let syncing = false

  host.innerHTML = `
    <div class="lab-panel-head">
      <span class="lab-panel-title">Outliner</span><span class="lab-panel-count" data-outliner-count></span>
      <span class="lab-fill"></span>
      <button type="button" class="lab-icon-btn" data-action="outliner-filter" aria-label="Filter Outliner by type" aria-haspopup="menu">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="lab-icon-btn" data-action="outliner-add" aria-label="Add from Library">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
    <label class="lab-search"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input type="search" data-control="outliner-search" aria-label="Search scene" placeholder="Search scene" /></label>
    <div class="lab-outliner-body" data-outliner-tree></div>
  `
  const countEl = host.querySelector<HTMLElement>("[data-outliner-count]")!
  const body = host.querySelector<HTMLElement>("[data-outliner-tree]")!
  const search = host.querySelector<HTMLInputElement>('[data-control="outliner-search"]')!
  const filterBtn = host.querySelector<HTMLButtonElement>('[data-action="outliner-filter"]')!
  const addButton = host.querySelector<HTMLButtonElement>('[data-action="outliner-add"]')!
  tip(filterBtn, "Filter by type")
  tip(addButton, "Add from Library", "Control+Space")

  const nodeById = new Map<string, OutlinerNode>()
  const icon = (n: OutlinerNode) => (n.type === "group" ? undefined : OUTLINER_GROUPS.find(g => g.id === n.group)!.icon)
  const outline: Tree<OutlinerNode> = tree<OutlinerNode>(body, {
    preset: arcadePreset,
    theme: "dark",
    items: [],
    label: "Scene objects",
    empty: "Nothing placed yet. Open the Library (Ctrl+Space) to add objects.",
    icon,
    detail: n => (n.type === "group" ? String(n.ids.length) : n.type === "fold" ? `×${n.ids.length}` : undefined),
    render: (n, row) => {
      const el = row.element
      if (n.object) el.dataset.objectId = n.object.id
      else delete el.dataset.objectId
      el.dataset.rowType = n.type
      return undefined
    },
    onSelect: (ids, primary) => {
      if (syncing) return
      const objects = selectedObjects(nodes, ids)
      // A group row is a heading: picking one leaves the scene's selection alone.
      if (!objects.length && ids.every(id => nodeById.get(id)?.type === "group")) return
      const p = primary ? nodeById.get(primary) : undefined
      deps.select(objects, p?.object?.id ?? p?.ids.at(-1) ?? null)
    },
    onToggle: (id, open) => {
      const n = nodeById.get(id)
      if (n?.type === "group") {
        if (open) collapsed.delete(n.group)
        else collapsed.add(n.group)
      }
    },
    onActivate: id => {
      const n = nodeById.get(id)
      if (!n) return
      if (n.type === "group") outline.expand(id, !outline.isExpanded(id))
      else deps.frame(n.object?.id ?? n.ids.at(-1)!)
    },
    toggles: [
      {
        id: "locked",
        label: "Lock: ignore in viewport picking and marquee",
        get: n => !n.ids.length || !n.ids.every(id => deps.isLocked(id)),
        set: (ids, unlocked) => {
          for (const id of ids) for (const o of nodeById.get(id)?.ids ?? []) if (deps.isLocked(o) === unlocked) deps.toggleLock(o)
          rebuild(true)
        },
        icon: on => LOCK(!on),
      },
    ],
  })
  const treeEl = outline.element
  treeEl.dataset.outlinerTree = ""

  // Letters are workbench shortcuts, not type-ahead: the tree never sees them, the workbench does.
  treeEl.addEventListener("keydown", e => {
    if (e.key.length !== 1 || e.key === " " || e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.target as Element).closest(".knobs-tree-edit")) return
    e.stopImmediatePropagation()
    e.preventDefault()
    window.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, shiftKey: e.shiftKey, repeat: e.repeat, bubbles: true, cancelable: true }))
  }, true)
  treeEl.addEventListener("keydown", e => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault()
      e.stopPropagation()
      deps.onExitToCanvas()
    } else if (e.key === "ArrowUp" && !e.shiftKey && outline.rows()[0] === outline.active) {
      e.preventDefault()
      e.stopPropagation()
      search.focus()
    }
  })
  treeEl.addEventListener("focusin", () => deps.onFocusChange(true))
  treeEl.addEventListener("focusout", e => {
    if (!treeEl.contains(e.relatedTarget as Node | null)) deps.onFocusChange(false)
  })

  const matchesQuery = (n: OutlinerNode) => {
    if (!n.object) return false
    const q = query.trim().toLowerCase()
    const def = OUTLINER_GROUPS.find(g => g.id === n.group)!
    return matches(n.object, def.label, q)
  }

  function rebuild(force = false) {
    const objects = deps.objects()
    countEl.textContent = String(objects.length)
    filterBtn.setAttribute("aria-pressed", String(hiddenGroups.size > 0))
    const sig = JSON.stringify([objects.map(o => [o.id, o.label, o.kind, o.category, o.vehicle, deps.isLocked(o.id)]), [...hiddenGroups]])
    if (force || sig !== signature) {
      const fresh = signature === ""
      signature = sig
      nodes = buildOutlinerTree(objects, hiddenGroups)
      nodeById.clear()
      const walk = (list: readonly OutlinerNode[]) => { for (const n of list) { nodeById.set(n.id, n); if (n.children) walk(n.children) } }
      walk(nodes)
      const had = new Set(outline.rows())
      outline.update(nodes)
      // Groups start open (unless closed by hand); folds start shut.
      for (const n of nodes) if ((fresh || !had.has(n.id)) && !collapsed.has(n.group)) outline.expand(n.id, true)
    }
    syncSelection()
  }

  /** The workbench's selection, shown on the object rows (a fold's members, not the fold). */
  function syncSelection() {
    const ids = deps.selectedIds()
    // A fold row standing for exactly these objects already shows them.
    const shown = selectedObjects(nodes, outline.selection)
    if (shown.length === ids.length && ids.every(id => shown.includes(id))) return
    const want = ids.map(id => `obj:${id}`).filter(id => nodeById.has(id))
    syncing = true
    try {
      outline.select(want, want.at(-1) ?? null)
    } finally {
      syncing = false
    }
  }

  search.addEventListener("input", () => {
    query = search.value
    outline.filter(query.trim() ? matchesQuery : null)
  })
  search.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (search.value) {
        search.value = ""
        query = ""
        outline.filter(null)
      } else deps.onExitToCanvas()
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      const first = outline.rows().map(id => nodeById.get(id)).find(n => n?.type === "object")
      if (first && event.key === "Enter") deps.select([first.object!.id], first.object!.id)
      outline.focus(first?.id)
    }
  })

  function typeMenu() {
    const menu = document.createElement("div")
    menu.className = "lab-outliner-menu"
    menu.setAttribute("role", "menu")
    const render = () => {
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
          render()
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
        render()
        rebuild()
      }
      menu.append(all)
    }
    render()
    popover(filterBtn, menu, { placement: "bottom-end", role: "menu", label: "Show types" })
  }
  filterBtn.addEventListener("click", typeMenu)

  return {
    el: host,
    tree: treeEl,
    search,
    addButton,
    render: () => rebuild(),
    /** Rows on show, top to bottom, as row ids (`group:…`, `fold:…`, `obj:…`). */
    get rows(): readonly string[] {
      return outline.rows()
    },
    focus() {
      outline.focus()
    },
    setGroupCollapsed(group: string, value: boolean) {
      if (value) collapsed.add(group)
      else collapsed.delete(group)
      outline.expand(`group:${group}`, !value)
    },
    setFoldExpanded(key: string, value: boolean) {
      outline.expand(key, value)
    },
    setQuery(next: string) {
      query = next
      search.value = next
      outline.filter(next.trim() ? matchesQuery : null)
    },
    get collapsedGroups(): string[] {
      return [...collapsed]
    },
    /** Opens an object's group and fold and scrolls it into view. */
    reveal(id: string) {
      const row = `obj:${id}`
      if (!nodeById.has(row)) return
      const obj = nodeById.get(row)!
      collapsed.delete(obj.group)
      outline.reveal(row)
    },
  }
}
