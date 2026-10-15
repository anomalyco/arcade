// menu(anchor, items) and contextMenu(target, items): a menu in the overlay layer. It grows from
// where it was asked for (the pointer, or its button's edge) on a snappy spring and softens out
// shorter, interruptibly; items take icons, shortcut chips, checks and radios, separators,
// destructive styling and submenus, which open on a hover intent kept by a safe triangle. It holds
// focus and is driven from the keys: ↑↓, Home/End, letters, Enter/Space, → and ← for submenus, Esc.
import { comboParts } from "../core/keys.js"
import type { UiLook } from "./look.js"
import { ICONS } from "./look.js"
import {
  type Anchor,
  anchorBox,
  focusReturn,
  layerElement,
  type Presence,
  presence,
  pushLayer,
  viewBox,
} from "./layer.js"
import {
  inTriangle,
  matchItem,
  type Placement,
  place,
  safeTriangle,
  stepItem,
} from "./overlay-model.js"

export interface MenuItem {
  readonly id?: string
  readonly label: string
  /** A glyph, or an `<svg>` string. */
  readonly icon?: string
  /** A key combination shown as chips ("Mod+D", "Backspace"); display only, it binds nothing. */
  readonly shortcut?: string
  /** Dim text at the end, before any shortcut. */
  readonly hint?: string
  readonly disabled?: boolean
  /** A check mark (`menuitemcheckbox`), or with `radio` a dot (`menuitemradio`). */
  readonly checked?: boolean
  readonly radio?: boolean
  /** Drawn in `--k-critical`, for what can't be taken back. */
  readonly destructive?: boolean
  /** A submenu (or a function read when it opens). */
  readonly items?: readonly MenuEntry[] | (() => readonly MenuEntry[])
  run?(): unknown
}
/** An item, `"-"` for a separator, or `null` / `false` for nothing (a conditional item). */
export type MenuEntry = MenuItem | "-" | null | false | undefined

export type MenuCloseReason = "select" | "escape" | "outside" | "close"

export interface MenuOptions {
  /** Where it opens beside its anchor (`bottom-start`; a point opens at its corner). */
  readonly placement?: Placement
  /** Px between the anchor and the menu (4; 0 at a point). */
  readonly offset?: number
  readonly label?: string
  readonly look?: UiLook
  /** The first item starts active (opened by a key rather than the pointer). */
  readonly keyboard?: boolean
  onClose?(reason: MenuCloseReason): void
  /** Each item chosen, beside its own `run`. */
  onSelect?(item: MenuItem): void
}

export interface Menu {
  readonly element: HTMLElement
  readonly open: boolean
  /** Closes it and any submenu (animated); resolves once they've gone. */
  close(): Promise<void>
}

interface Level {
  readonly el: HTMLElement
  readonly parent: Level | null
  child: Level | null
  /** Submenus opened from this level, by item. */
  readonly subs: Map<number, Level>
  rows: (Row | null)[]
  active: number
  readonly motion: Presence
  close(reason: MenuCloseReason, restoreParent?: boolean): Promise<void>
  setActive(i: number, by?: "key" | "pointer"): void
  openSub(i: number, focusFirst: boolean): void
}
interface Row {
  readonly el: HTMLElement
  readonly item: MenuItem
}

const HOVER_INTENT_MS = 110
const SAFE_MS = 320
let uid = 0

/** A menu beside `anchor` (a button, a rect or a point). */
export function menu(anchor: Anchor, items: readonly MenuEntry[], options: MenuOptions = {}): Menu {
  const doc =
    typeof (anchor as HTMLElement).ownerDocument === "object"
      ? (anchor as HTMLElement).ownerDocument
      : document
  const win = doc.defaultView!
  const point =
    typeof (anchor as HTMLElement).getBoundingClientRect !== "function" &&
    !("width" in (anchor as DOMRect))
  const giveBack = focusReturn(doc, doc.body)
  let open = true
  let closing: Promise<void> | undefined
  const levels: Level[] = []
  const owns = (n: Node | null) => !!n && levels.some((l) => l.el.contains(n))
  const anchorEl = anchor instanceof win.HTMLElement ? anchor : null
  anchorEl?.setAttribute("aria-expanded", "true")

  const closeAll = (reason: MenuCloseReason) => {
    if (closing) return closing
    open = false
    anchorEl?.setAttribute("aria-expanded", "false")
    const root = levels[0]!
    closing = root.close(reason)
    // Focus goes back first, so an item's action (a rename in place) starts where it was.
    if (reason !== "outside" || owns(doc.activeElement)) giveBack()
    options.onClose?.(reason)
    return closing
  }

  const build = (
    entries: readonly MenuEntry[],
    at: Anchor,
    parent: Level | null,
    keyboard: boolean,
  ): Level => {
    const el = layerElement(doc, "knobs-layer knobs-menu-layer", options.look)
    el.setAttribute("role", "menu")
    el.tabIndex = -1
    el.id = `knobs-menu-${++uid}`
    if (options.label && !parent) el.setAttribute("aria-label", options.label)
    const list = entries.filter((e): e is MenuItem | "-" => !!e)
    // Separators only between items: none leading, trailing or doubled.
    const clean = list.filter(
      (e, i) => e !== "-" || (i > 0 && i < list.length - 1 && list[i - 1] !== "-"),
    )
    const leading = clean.some((e) => e !== "-" && (e.icon || e.checked !== undefined))
    if (leading) el.dataset.leading = ""
    const rows: (Row | null)[] = clean.map((e, i) => {
      if (e === "-") {
        const sep = doc.createElement("div")
        sep.className = "knobs-menu-sep"
        sep.setAttribute("role", "separator")
        el.append(sep)
        return null
      }
      const row = doc.createElement("div")
      row.className = "knobs-mitem"
      row.id = `${el.id}-${i}`
      row.setAttribute(
        "role",
        e.checked === undefined ? "menuitem" : e.radio ? "menuitemradio" : "menuitemcheckbox",
      )
      if (e.checked !== undefined) row.setAttribute("aria-checked", String(e.checked))
      if (e.disabled) row.setAttribute("aria-disabled", "true")
      if (e.destructive) row.dataset.destructive = ""
      if (e.id) row.dataset.id = e.id
      if (leading) {
        const lead = doc.createElement("span")
        lead.className = "knobs-menu-lead"
        if (e.checked) lead.innerHTML = e.radio ? RADIO : CHECK
        else if (e.icon) {
          if (e.icon.trimStart().startsWith("<")) lead.innerHTML = e.icon
          else lead.textContent = e.icon
        }
        row.append(lead)
      }
      const label = doc.createElement("span")
      label.className = "knobs-menu-label"
      label.textContent = e.label
      row.append(label)
      if (e.hint) {
        const hint = doc.createElement("span")
        hint.className = "knobs-menu-hint"
        hint.textContent = e.hint
        row.append(hint)
      }
      if (e.shortcut && !e.items) {
        const keys = doc.createElement("span")
        keys.className = "knobs-menu-keys"
        row.setAttribute("aria-keyshortcuts", e.shortcut)
        for (const k of comboParts(e.shortcut)) {
          const kbd = doc.createElement("kbd")
          kbd.className = "knobs-kbd"
          kbd.textContent = k
          keys.append(kbd)
        }
        row.append(keys)
      }
      if (e.items) {
        row.setAttribute("aria-haspopup", "menu")
        row.setAttribute("aria-expanded", "false")
        const caret = doc.createElement("span")
        caret.className = "knobs-menu-caret"
        caret.innerHTML = ICONS.caret
        row.append(caret)
      }
      el.append(row)
      return { el: row, item: e }
    })

    // Placed beside its anchor; a submenu beside its item, its first item level with it.
    const box = anchorBox(at)
    const pad = 5
    const placed = place({
      anchor: parent ? { ...box, y: box.y - pad, h: box.h + pad * 2 } : box,
      size: { w: el.offsetWidth, h: el.offsetHeight },
      view: viewBox(doc),
      placement: parent ? "right-start" : (options.placement ?? "bottom-start"),
      offset: parent ? 2 : (options.offset ?? (point ? 0 : 4)),
    })
    el.style.left = `${placed.x}px`
    el.style.top = `${placed.y}px`
    el.style.transformOrigin =
      !parent && point
        ? `${box.x - placed.x}px ${box.y - placed.y}px`
        : `${placed.origin.x}px ${placed.origin.y}px`
    el.dataset.placement = placed.placement
    const side = placed.placement.split("-")[0]
    // kit-motion: snappy (.25 s, no bounce) in, softer and shorter out (blur ≤ 4px, scale .96).
    const motion = presence(el, { scale: 0.96, blur: 4, duration: 0.25, bounce: 0, exit: 0.2 })
    if (parent) motion.from(side === "right" ? -4 : 4, 0)
    else if (!point) motion.from(0, side === "top" ? 4 : side === "bottom" ? -4 : 0)

    let typed = ""
    let typedAt = 0
    let hoverTimer: ReturnType<typeof setTimeout> | undefined
    let lastPointer: { x: number; y: number } | null = null
    let safeUntil = 0
    const ok = (i: number) => {
      const r = rows[i]
      return !!r && !r.item.disabled
    }

    const level: Level = {
      el,
      parent,
      child: null,
      subs: new Map(),
      rows,
      active: -1,
      motion,
      setActive(i, by = "key") {
        if (level.active === i) return
        const was = rows[level.active]
        if (was) delete was.el.dataset.active
        level.active = i
        const row = rows[i]
        if (row) {
          row.el.dataset.active = ""
          el.setAttribute("aria-activedescendant", row.el.id)
          if (by === "key") row.el.scrollIntoView({ block: "nearest" })
        } else el.removeAttribute("aria-activedescendant")
      },
      openSub(i, focusFirst) {
        clearTimeout(hoverTimer)
        const row = rows[i]
        const open = level.child
        if (open && open === level.subs.get(i)) {
          if (focusFirst) {
            open.el.focus({ preventScroll: true })
            open.setActive(
              stepItem(
                open.rows.length,
                -1,
                1,
                (k) => !open.rows[k]?.item.disabled && !!open.rows[k],
              ),
            )
          }
          return
        }
        void level.child?.close("close")
        if (!row?.item.items || row.item.disabled) return
        const entries = typeof row.item.items === "function" ? row.item.items() : row.item.items
        const sub = build(entries, row.el, level, focusFirst)
        level.subs.set(i, sub)
        level.child = sub
        row.el.setAttribute("aria-expanded", "true")
        row.el.dataset.open = ""
        if (focusFirst) sub.el.focus({ preventScroll: true })
      },
      close(reason, restoreParent = false) {
        clearTimeout(hoverTimer)
        const child = level.child
        level.child = null
        const done = [child?.close(reason) ?? Promise.resolve()]
        if (parent) {
          parent.child = null
          for (const [k, l] of parent.subs)
            if (l === level) {
              const r = parent.rows[k]
              r?.el.setAttribute("aria-expanded", "false")
              if (r) delete r.el.dataset.open
              parent.subs.delete(k)
            }
          if (restoreParent) parent.el.focus({ preventScroll: true })
        }
        const i = levels.indexOf(level)
        if (i >= 0) levels.splice(i, 1)
        unstack()
        // Leaving, it's no longer a menu to anyone: it only fades.
        el.setAttribute("aria-hidden", "true")
        el.inert = true
        done.push(motion.hide().then(() => el.remove()))
        return Promise.all(done).then(() => {})
      },
    }
    levels.push(level)

    const activate = (i: number, by: "key" | "pointer") => {
      const row = rows[i]
      if (!row || row.item.disabled) return
      if (row.item.items) return level.openSub(i, by === "key")
      void closeAll("select")
      options.onSelect?.(row.item)
      row.item.run?.()
    }

    el.addEventListener("pointermove", (e) => {
      const p = { x: e.clientX, y: e.clientY }
      const target = (e.target as HTMLElement).closest(".knobs-mitem")
      const i = target ? rows.findIndex((r) => r?.el === target) : -1
      // Heading for the open submenu through the safe triangle: it stays a moment longer.
      const child = level.child
      if (child && lastPointer && i !== level.active) {
        const r = child.el.getBoundingClientRect()
        const [a, b, c] = safeTriangle(lastPointer, {
          x: r.left,
          y: r.top,
          w: r.width,
          h: r.height,
        })
        if (
          inTriangle(p, a, b, c) &&
          performance.now() < (safeUntil ||= performance.now() + SAFE_MS)
        ) {
          lastPointer = p
          return
        }
      }
      safeUntil = 0
      lastPointer = p
      if (i < 0 || i === level.active) return
      level.setActive(ok(i) ? i : -1, "pointer")
      clearTimeout(hoverTimer)
      if (child && !rows[i]?.item.items) {
        hoverTimer = setTimeout(
          () => void level.child?.close("close", level.child.el.contains(doc.activeElement)),
          HOVER_INTENT_MS,
        )
      } else if (rows[i]?.item.items && ok(i)) {
        hoverTimer = setTimeout(() => level.openSub(i, false), HOVER_INTENT_MS)
      }
    })
    el.addEventListener("pointerleave", () => {
      lastPointer = null
      if (!level.child) level.setActive(-1, "pointer")
    })
    el.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest(".knobs-mitem")
      const i = rows.findIndex((r) => r?.el === target)
      if (i >= 0) activate(i, e.detail === 0 ? "key" : "pointer")
    })
    // Right-clicking an item chooses it, as on macOS (the button goes down and comes up on it).
    el.addEventListener("contextmenu", (e) => e.preventDefault())
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return
      const n = rows.length
      const move = (to: number) => {
        e.preventDefault()
        e.stopPropagation()
        level.setActive(to)
      }
      if (e.key === "ArrowDown") return move(stepItem(n, level.active, 1, ok))
      if (e.key === "ArrowUp") return move(stepItem(n, level.active, -1, ok))
      if (e.key === "Home" || e.key === "PageUp") return move(stepItem(n, -1, 1, ok))
      if (e.key === "End" || e.key === "PageDown") return move(stepItem(n, -1, -1, ok))
      if (e.key === "Enter" || (e.key === " " && !typed)) {
        e.preventDefault()
        e.stopPropagation()
        return activate(level.active, "key")
      }
      if (e.key === "ArrowRight") {
        e.preventDefault()
        e.stopPropagation()
        if (rows[level.active]?.item.items) level.openSub(level.active, true)
        return
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        e.stopPropagation()
        if (parent) void level.close("close", true)
        else void level.child?.close("close")
        return
      }
      if (e.key === "Tab") {
        e.preventDefault()
        void closeAll("close")
        return
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const now = performance.now()
        typed = now - typedAt > 600 ? e.key : typed + e.key
        typedAt = now
        const labels = rows.map((r) => (r && !r.item.disabled ? r.item.label : null))
        const to = matchItem(labels, level.active, typed)
        if (to !== level.active) move(to)
        else {
          e.preventDefault()
          e.stopPropagation()
        }
      }
    })
    el.addEventListener("focusout", (e) => {
      const to = e.relatedTarget as Node | null
      if (to && !owns(to)) void closeAll("outside")
    })

    const unstack = pushLayer(doc, {
      el,
      inside: () => [anchorEl, ...levels.map((l) => l.el)],
      dismiss: (reason) => {
        // Esc closes the topmost menu (a submenu hands back to its parent); a click outside, all.
        if (reason === "escape" && parent) void level.close("escape", true)
        else void closeAll(reason)
      },
    })
    motion.show()
    if (!parent) el.focus({ preventScroll: true })
    if (keyboard) level.setActive(stepItem(rows.length, -1, 1, ok))
    return level
  }

  const root = build(items, anchor, null, options.keyboard ?? false)
  return {
    element: root.el,
    get open() {
      return open
    },
    close: () => closeAll("close"),
  }
}

export interface ContextMenuOptions
  extends Omit<MenuOptions, "placement" | "offset" | "keyboard"> {}

export interface ContextMenu {
  /** Opens it at a point (or the focused element), as a right-click or the menu key would. */
  open(at?: { readonly x: number; readonly y: number }): Menu | null
  readonly current: Menu | null
  dispose(): void
}

/**
 * A context menu for `target`: a right-click (or a two-finger click) opens it at the pointer, and
 * the menu key or ⇧F10 at the focused element. `items` may be a function of the event, read each
 * time (return `null` for no menu there, and the browser's own shows).
 */
export function contextMenu(
  target: HTMLElement,
  items:
    | readonly MenuEntry[]
    | ((event: MouseEvent | KeyboardEvent | null) => readonly MenuEntry[] | null | undefined),
  options: ContextMenuOptions = {},
): ContextMenu {
  const doc = target.ownerDocument
  let current: Menu | null = null
  const read = (e: MouseEvent | KeyboardEvent | null) =>
    typeof items === "function" ? items(e) : items
  const show = (at: { x: number; y: number }, list: readonly MenuEntry[], keyboard: boolean) => {
    // A second right-click while one is open moves it: the old one leaves as the new one comes.
    if (current?.open) void current.close()
    current = menu(at, list, { ...options, keyboard })
    return current
  }
  const focusedPoint = () => {
    const focus = doc.activeElement as HTMLElement | null
    const inTarget = focus && target.contains(focus)
    const active = inTarget ? focus.getAttribute("aria-activedescendant") : null
    const el = (active && doc.getElementById(active)) || (inTarget ? focus : target)
    const r = el.getBoundingClientRect()
    return { x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(r.height, 28) }
  }
  const onContext = (e: MouseEvent) => {
    const list = read(e)
    if (!list) return
    e.preventDefault()
    show({ x: e.clientX, y: e.clientY }, list, false)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return
    const list = read(e)
    if (!list) return
    e.preventDefault()
    e.stopPropagation()
    show(focusedPoint(), list, true)
  }
  target.addEventListener("contextmenu", onContext)
  target.addEventListener("keydown", onKey)
  return {
    open(at) {
      const list = read(null)
      return list ? show(at ?? focusedPoint(), list, !at) : null
    },
    get current() {
      return current?.open ? current : null
    },
    dispose() {
      target.removeEventListener("contextmenu", onContext)
      target.removeEventListener("keydown", onKey)
      void current?.close()
    },
  }
}

const CHECK =
  '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>'
const RADIO =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>'
