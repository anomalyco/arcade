import type { ChipOptions, Controls } from "../core/store.js"
import type { Schema } from "../core/schema.js"
import { iconSvg } from "./icons.js"
import type { Panel } from "./panel.js"
import { readSession, writeSession } from "./session.js"
import { injectStyles } from "./styles.js"

export function attach<S extends Schema>(
  controls: Controls<S>,
  element: HTMLElement,
  options: ChipOptions = {},
): () => void {
  if (!controls.enabled) return () => {}
  const doc = element.ownerDocument
  const win = doc.defaultView!
  injectStyles(doc)
  const label = options.label ?? controls.chip.label
  const reveal = options.reveal ?? controls.chip.reveal
  const shortcut = options.shortcut ?? controls.chip.shortcut
  const chip = doc.createElement("button")
  chip.className = "knobs-chip"
  chip.dataset.theme = controls.theme
  chip.type = "button"
  /** The cog, with the label beside it when there is one. */
  const renderFace = (text: string | undefined) => {
    const face: Node[] = [iconSvg(doc, "gear")]
    if (text) {
      const span = doc.createElement("span")
      span.textContent = text
      face.push(span)
    }
    chip.replaceChildren(...face)
    chip.toggleAttribute("data-label", Boolean(text))
  }
  renderFace(label)
  chip.setAttribute("aria-label", `Tune ${controls.id}`)
  chip.setAttribute("aria-expanded", "false")
  // The chip fades and scales in/out (CSS), so it stays in the DOM and toggles data-shown.
  chip.dataset.shown = "false"
  const setShown = (shown: boolean) => {
    chip.dataset.shown = String(shown)
    chip.tabIndex = shown ? 0 : -1
  }
  doc.body.append(chip)
  const addedTabIndex =
    !element.hasAttribute("tabindex") && !element.matches("a[href],button,input,select,textarea")
  if (addedTabIndex) element.tabIndex = 0
  let hovered = element.matches(":hover")
  let disposed = false
  let loading = false
  let panel: Panel | undefined
  /** A panel collapsing into the chip: clicking the chip again reverses it. */
  let leaving: Panel | undefined
  const revealed = () => reveal !== "shortcut" || knobsMode(win)
  const position = () => {
    const box = element.getBoundingClientRect()
    chip.style.left = `${Math.max(4, Math.min(win.innerWidth - chip.offsetWidth - 4, box.right - chip.offsetWidth - 6))}px`
    chip.style.top = `${Math.max(4, box.top + 6)}px`
  }
  const update = () => {
    // While its panel is open the chip has become the panel, so it stays hidden.
    const shown =
      controls.enabled &&
      revealed() &&
      !panel &&
      (reveal === "always" ||
        hovered ||
        element.contains(doc.activeElement) ||
        doc.activeElement === chip)
    if (shown) position()
    setShown(shown)
    if (!controls.enabled) {
      panel?.dispose()
      leaving?.dispose()
      panel = leaving = undefined
    }
  }
  const enter = () => {
    hovered = true
    update()
  }
  const leave = (event: PointerEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      (element.contains(event.relatedTarget) || chip.contains(event.relatedTarget))
    )
      return
    hovered = false
    update()
  }
  const focusOut = () => {
    queueMicrotask(update)
  }
  for (const node of [element, chip]) {
    node.addEventListener("pointerenter", enter)
    node.addEventListener("pointerleave", leave)
    node.addEventListener("focusin", update)
    node.addEventListener("focusout", focusOut)
  }
  // A press squeezes the chip (CSS); the morph reads when it began and carries the squeeze on.
  const unpress = () => delete chip.dataset.pressed
  chip.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !panel) chip.dataset.pressed = String(performance.now())
  })
  chip.addEventListener("pointerleave", unpress)
  chip.addEventListener("pointercancel", unpress)
  // Which panels are open survives a reload in this tab, so editing the library doesn't close them.
  const remember = controls.storage !== null
  const close = (refocus = true) => {
    const closing = panel
    if (!closing) return
    panel = undefined
    leaving = closing
    position()
    closing.dismiss()
    if (remember) writeSession(controls.id, { open: false })
    chip.setAttribute("aria-expanded", "false")
    if (refocus && revealed()) {
      setShown(true)
      chip.focus({ preventScroll: true })
    } else update()
  }
  const open = async (restored = false) => {
    if (panel) {
      unpress()
      panel.focus()
      return
    }
    if (leaving?.reopen()) {
      unpress()
      panel = leaving
      leaving = undefined
      if (remember) writeSession(controls.id, { open: true })
      chip.setAttribute("aria-expanded", "true")
      update()
      panel.focus()
      return
    }
    leaving = undefined
    if (loading) return
    loading = true
    try {
      const { createPanel } = await import("./panel.js")
      if (disposed || !controls.enabled || panel) return
      panel = createPanel(controls, element, close, { restored, chip })
      if (remember) writeSession(controls.id, { open: true })
      chip.setAttribute("aria-expanded", "true")
      update()
      if (!restored) panel.focus()
    } catch (cause) {
      chip.title = String(cause)
      renderFace("Retry knobs")
    } finally {
      loading = false
      unpress()
    }
  }
  // The chip toggles: mid-morph it reverses the shape from wherever it is.
  chip.onclick = () => (panel ? close() : void open())
  if (remember && readSession(controls.id).open && revealed()) void open(true)
  const observer = new ResizeObserver(position)
  observer.observe(element)
  win.addEventListener("scroll", position, true)
  win.addEventListener("resize", position)
  // Knobs mode: the shortcut turns "shortcut" chips on and off for the whole tab.
  const onMode = () => {
    if (!revealed()) close(false)
    update()
  }
  const offShortcut =
    reveal === "shortcut" ? listenForShortcut(win, shortcut, controls.theme) : undefined
  win.addEventListener(MODE_EVENT, onMode)
  const unsubscribe = controls.subscribe(update)
  update()
  return () => {
    disposed = true
    unsubscribe()
    panel?.dispose()
    leaving?.dispose()
    observer.disconnect()
    offShortcut?.()
    win.removeEventListener(MODE_EVENT, onMode)
    win.removeEventListener("scroll", position, true)
    win.removeEventListener("resize", position)
    for (const node of [element, chip]) {
      node.removeEventListener("pointerenter", enter)
      node.removeEventListener("pointerleave", leave)
      node.removeEventListener("focusin", update)
      node.removeEventListener("focusout", focusOut)
    }
    chip.remove()
    if (addedTabIndex && element.getAttribute("tabindex") === "0")
      element.removeAttribute("tabindex")
  }
}

const MODE_KEY = "knobs:mode"
const MODE_EVENT = "knobs-mode"

/** Whether knobs mode is on in this tab. */
function knobsMode(win: Window): boolean {
  try {
    return win.sessionStorage.getItem(MODE_KEY) === "on"
  } catch {
    return false
  }
}

/** Parses `"Alt+Shift+D"` into a test for keydown events. Letters and digits match by key position. */
export function matchShortcut(shortcut: string): (event: KeyboardEvent) => boolean {
  const parts = shortcut.split("+").map((p) => p.trim().toLowerCase())
  const key = parts.pop() ?? ""
  const has = (...names: string[]) => parts.some((p) => names.includes(p))
  const alt = has("alt", "option", "opt", "⌥")
  const shift = has("shift", "⇧")
  const ctrl = has("ctrl", "control", "⌃")
  const meta = has("meta", "cmd", "command", "⌘")
  // ⌥ changes what a letter types on a Mac (⌥⇧D is "Î"), so letters and digits match by code.
  const code = /^[a-z]$/.test(key)
    ? `Key${key.toUpperCase()}`
    : /^\d$/.test(key)
      ? `Digit${key}`
      : ""
  return (event) =>
    event.altKey === alt &&
    event.shiftKey === shift &&
    event.ctrlKey === ctrl &&
    event.metaKey === meta &&
    (code ? event.code === code : event.key.toLowerCase() === key)
}

/**
 * Toggles knobs mode on `shortcut` from anywhere on the page, except while typing in a field.
 * Several stores may listen for the same key: the first to see a press claims it.
 */
function listenForShortcut(win: Window, shortcut: string, theme: string): () => void {
  const matches = matchShortcut(shortcut)
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || !matches(event)) return
    const target = event.target as Element | null
    if (target?.closest?.("input,textarea,select,[contenteditable]:not([contenteditable=false])"))
      return
    event.preventDefault()
    const on = !knobsMode(win)
    try {
      win.sessionStorage.setItem(MODE_KEY, on ? "on" : "off")
    } catch {
      /* The mode still applies until reload. */
    }
    showStatus(win.document, on ? "knobs on" : "knobs off", theme)
    win.dispatchEvent(new CustomEvent(MODE_EVENT))
  }
  win.addEventListener("keydown", onKey, true)
  return () => win.removeEventListener("keydown", onKey, true)
}

const statusTimers = new WeakMap<Document, ReturnType<typeof setTimeout>>()

/** A small transient status at the bottom of the page. */
function showStatus(doc: Document, text: string, theme: string) {
  let toast = doc.querySelector<HTMLElement>(".knobs-toast")
  if (!toast) {
    toast = doc.createElement("div")
    toast.className = "knobs-toast"
    toast.setAttribute("role", "status")
    toast.dataset.shown = "false"
    doc.body.append(toast)
    toast.getBoundingClientRect()
  }
  toast.dataset.theme = theme
  toast.textContent = text
  toast.dataset.shown = "true"
  clearTimeout(statusTimers.get(doc))
  const el = toast
  statusTimers.set(
    doc,
    setTimeout(() => (el.dataset.shown = "false"), 1200),
  )
}
