export interface MenuItem {
  readonly label: string
  /** Shown right-aligned, as macOS menus show key equivalents. */
  readonly shortcut?: string
  readonly disabled?: boolean
  /** Draws a hairline above the item. */
  readonly separated?: boolean
  /** Marks the current option, as a pop-up menu's check mark does. */
  readonly checked?: boolean
  run(): void
}

export interface Menu {
  readonly element: HTMLElement
  /** `restore` returns focus to where it was before the menu opened (or `returnTo`). */
  close(restore?: boolean): void
}

/** Tokens the menu borrows from its panel, so it matches the panel's theme and any overrides. */
const TOKENS = [
  "bg",
  "surface",
  "surface-hi",
  "seg-bg",
  "line",
  "text",
  "label",
  "dim",
  "accent",
  "font-size",
  "radius",
  "row",
  "rim",
]

const reduced = (doc: Document) =>
  doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false

/**
 * A context menu over everything at (`x`, `y`): it scales and fades out of that corner and back
 * into it. It holds focus itself and marks the active item, so it's driven entirely from the
 * keyboard (↑↓, Home/End, Enter, Esc, a letter to jump) as well as the pointer.
 */
export function openMenu(
  doc: Document,
  panel: HTMLElement,
  items: readonly MenuItem[],
  at: { x: number; y: number },
  options: {
    keyboard?: boolean
    returnTo?: HTMLElement
    onClose?: () => void
    /** The item marked active on open (a pop-up menu starts on its current option). */
    active?: number
    /** At least this wide (px), e.g. the button it drops from. */
    minWidth?: number
    /**
     * A search field over the items: typing filters them (by any part of their label), ↑↓
     * move through what's left, Enter picks, Esc closes. For long choice lists.
     */
    search?: boolean
  } = {},
): Menu {
  const win = doc.defaultView!
  const previous = options.returnTo ?? (doc.activeElement as HTMLElement | null)
  const menu = doc.createElement("div")
  menu.className = "knobs-menu"
  menu.setAttribute("role", "menu")
  menu.tabIndex = -1
  const cs = win.getComputedStyle(panel)
  for (const t of TOKENS) menu.style.setProperty(`--kv-${t}`, cs.getPropertyValue(`--kv-${t}`))
  for (const t of [
    "--k-font",
    "--k-mono",
    "--k-unit",
    "--k-shadow",
    "--k-font-weight",
    "--k-title-weight",
  ])
    menu.style.setProperty(t, cs.getPropertyValue(t))
  menu.style.colorScheme = cs.colorScheme

  let active = -1
  const enabled = (i: number) => !items[i]?.disabled && !nodes[i]?.hidden
  const list = doc.createElement("div")
  list.className = "knobs-menu-list"
  let input: HTMLInputElement | undefined
  if (options.search) {
    input = doc.createElement("input")
    input.type = "search"
    input.className = "knobs-menu-search"
    input.placeholder = "Search"
    input.spellcheck = false
    input.autocomplete = "off"
    input.setAttribute("aria-label", "Search options")
    menu.append(input)
  }
  menu.append(list)
  const empty = doc.createElement("div")
  empty.className = "knobs-menu-empty"
  empty.textContent = "No matches"
  empty.hidden = true
  const nodes: HTMLElement[] = []
  items.forEach((item, i) => {
    const node = doc.createElement("div")
    node.className = "knobs-menu-item"
    node.setAttribute("role", "menuitem")
    if (item.disabled) node.setAttribute("aria-disabled", "true")
    if (item.separated) node.dataset.separated = ""
    if (item.checked !== undefined) {
      node.setAttribute("role", "menuitemradio")
      node.setAttribute("aria-checked", String(item.checked))
    }
    const label = doc.createElement("span")
    label.textContent = item.label
    // The whole label, where the menu's width truncates it.
    node.title = item.label
    node.append(label)
    if (item.shortcut) {
      const key = doc.createElement("kbd")
      key.textContent = item.shortcut
      node.append(key)
    }
    node.onpointermove = () => setActive(enabled(i) ? i : -1)
    node.onpointerleave = () => setActive(-1)
    node.onclick = () => activate(i)
    list.append(node)
    nodes.push(node)
  })
  list.append(empty)
  const setActive = (i: number, reveal = false) => {
    if (i === active) return
    nodes[active]?.removeAttribute("data-active")
    active = i
    nodes[active]?.setAttribute("data-active", "")
    if (reveal) nodes[active]?.scrollIntoView({ block: "nearest" })
  }
  /** Shows the items whose labels contain the query, the matched part marked. */
  const filter = () => {
    const query = input?.value.trim().toLowerCase() ?? ""
    let first = -1
    items.forEach((item, i) => {
      const node = nodes[i]!
      const at = query ? item.label.toLowerCase().indexOf(query) : 0
      node.hidden = at < 0
      const label = node.firstElementChild as HTMLElement
      if (query && at >= 0) {
        const mark = doc.createElement("mark")
        mark.textContent = item.label.slice(at, at + query.length)
        label.replaceChildren(item.label.slice(0, at), mark, item.label.slice(at + query.length))
      } else if (label.childElementCount) label.textContent = item.label
      if (at >= 0 && first < 0 && !item.disabled) first = i
    })
    empty.hidden = first >= 0
    const keep = active >= 0 && enabled(active) && !query ? active : -1
    setActive(-1)
    setActive(keep >= 0 ? keep : first, true)
  }
  input?.addEventListener("input", filter)
  const step = (from: number, dir: 1 | -1) => {
    for (let n = 1; n <= items.length; n++) {
      const i = (((from + dir * n) % items.length) + items.length) % items.length
      if (enabled(i)) return i
    }
    return -1
  }

  if (items.some((item) => item.checked !== undefined)) menu.dataset.checks = ""
  if (options.minWidth) menu.style.minWidth = `${Math.round(options.minWidth)}px`
  doc.body.append(menu)
  // Opens away from the edges, growing out of the corner nearest the pointer. Opened upward,
  // it's held by its bottom edge, so a search that shortens it stays by its button.
  const w = menu.offsetWidth
  const h = menu.offsetHeight
  // A search keeps the width it opened at, so the menu doesn't jump while it narrows.
  if (input) menu.style.width = `${w}px`
  // A drop-down too wide for the room on the right lines up with its button's right edge.
  const left =
    at.x + w > win.innerWidth - 6 ? Math.max(6, at.x + (options.minWidth ?? 0) - w) : at.x
  const above = at.y + h > win.innerHeight - 6 && at.y - h >= 6
  menu.style.left = `${left}px`
  if (above) menu.style.bottom = `${win.innerHeight - at.y}px`
  else menu.style.top = `${Math.max(6, Math.min(at.y, win.innerHeight - 6 - h))}px`
  menu.style.transformOrigin = `${left < at.x ? "right" : "left"} ${above ? "bottom" : "top"}`
  if (!reduced(doc))
    menu.animate(
      [
        { opacity: 0, transform: "scale(.92)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 150, easing: "cubic-bezier(.2,.8,.2,1)" },
    )
  ;(input ?? menu).focus({ preventScroll: true })
  if (options.active !== undefined && enabled(options.active)) setActive(options.active, true)
  else if (options.keyboard || input) setActive(step(-1, 1))

  let closed = false
  const close = (restore = true) => {
    if (closed) return
    closed = true
    doc.removeEventListener("pointerdown", outside, true)
    win.removeEventListener("blur", blur)
    win.removeEventListener("resize", blur)
    menu.style.pointerEvents = "none"
    if (restore && previous?.isConnected && menu.contains(doc.activeElement))
      previous.focus({ preventScroll: true })
    options.onClose?.()
    if (reduced(doc)) return menu.remove()
    const opacity = win.getComputedStyle(menu).opacity
    menu
      .animate(
        [
          { opacity, transform: win.getComputedStyle(menu).transform },
          { opacity: 0, transform: "scale(.96)" },
        ],
        { duration: 110, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" },
      )
      .finished.then(
        () => menu.remove(),
        () => menu.remove(),
      )
  }
  const activate = (i: number) => {
    const item = items[i]
    if (!item || item.disabled) return
    close()
    item.run()
  }
  const outside = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) close(false)
  }
  const blur = () => close(false)
  doc.addEventListener("pointerdown", outside, true)
  win.addEventListener("blur", blur)
  win.addEventListener("resize", blur)

  menu.addEventListener("contextmenu", (event) => event.preventDefault())
  menu.addEventListener("keydown", (event) => {
    if (event.isComposing) return
    const key = event.key
    const typing = event.target === input
    let handled = true
    if (key === "ArrowDown") setActive(step(active, 1), true)
    else if (key === "ArrowUp") setActive(step(active < 0 ? items.length : active, -1), true)
    else if (key === "Home" && !typing) setActive(step(-1, 1), true)
    else if (key === "End" && !typing) setActive(step(items.length, -1), true)
    else if (key === "Enter" || (key === " " && !typing)) activate(active)
    else if (key === "Escape" || key === "Tab" || key === "ContextMenu") close()
    else if (typing) {
      // The search field keeps its own keys, and the page doesn't hear them.
      event.stopPropagation()
      return
    } else if (/^[a-z]$/i.test(key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Type to jump: the next item starting with that letter.
      const letter = key.toLowerCase()
      for (let n = 1; n <= items.length; n++) {
        const i = (Math.max(active, -1) + n) % items.length
        if (enabled(i) && items[i]!.label.toLowerCase().startsWith(letter)) {
          setActive(i)
          break
        }
      }
    } else handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  })
  return { element: menu, close }
}
