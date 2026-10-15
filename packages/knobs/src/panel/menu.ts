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
  "surface-hi",
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
  for (const t of ["--k-font", "--k-mono", "--k-unit", "--k-shadow"])
    menu.style.setProperty(t, cs.getPropertyValue(t))
  menu.style.colorScheme = cs.colorScheme

  let active = -1
  const enabled = (i: number) => !items[i]?.disabled
  const nodes = items.map((item, i) => {
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
    node.append(label)
    if (item.shortcut) {
      const key = doc.createElement("kbd")
      key.textContent = item.shortcut
      node.append(key)
    }
    node.onpointermove = () => setActive(enabled(i) ? i : -1)
    node.onpointerleave = () => setActive(-1)
    node.onclick = () => activate(i)
    menu.append(node)
    return node
  })
  const setActive = (i: number) => {
    if (i === active) return
    nodes[active]?.removeAttribute("data-active")
    active = i
    nodes[active]?.setAttribute("data-active", "")
  }
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
  // Opens away from the edges, growing out of the corner nearest the pointer.
  const w = menu.offsetWidth
  const h = menu.offsetHeight
  const left = at.x + w > win.innerWidth - 6 ? Math.max(6, at.x - w) : at.x
  const top = at.y + h > win.innerHeight - 6 ? Math.max(6, at.y - h) : at.y
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.transformOrigin = `${left < at.x ? "right" : "left"} ${top < at.y ? "bottom" : "top"}`
  if (!reduced(doc))
    menu.animate(
      [
        { opacity: 0, transform: "scale(.92)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 150, easing: "cubic-bezier(.2,.8,.2,1)" },
    )
  menu.focus({ preventScroll: true })
  if (options.active !== undefined && enabled(options.active)) setActive(options.active)
  else if (options.keyboard) setActive(step(-1, 1))

  let closed = false
  const close = (restore = true) => {
    if (closed) return
    closed = true
    doc.removeEventListener("pointerdown", outside, true)
    win.removeEventListener("blur", blur)
    win.removeEventListener("resize", blur)
    menu.style.pointerEvents = "none"
    if (restore && previous?.isConnected && doc.activeElement === menu)
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
    let handled = true
    if (key === "ArrowDown") setActive(step(active, 1))
    else if (key === "ArrowUp") setActive(step(active < 0 ? items.length : active, -1))
    else if (key === "Home") setActive(step(-1, 1))
    else if (key === "End") setActive(step(items.length, -1))
    else if (key === "Enter" || key === " ") activate(active)
    else if (key === "Escape" || key === "Tab" || key === "ContextMenu") close()
    else if (/^[a-z]$/i.test(key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
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
