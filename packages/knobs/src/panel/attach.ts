import type { Controls } from "../core/store.js"
import type { Schema } from "../core/schema.js"
import type { Panel } from "./panel.js"
import { readSession, writeSession } from "./session.js"
import { injectStyles } from "./styles.js"

export function attach<S extends Schema>(controls: Controls<S>, element: HTMLElement): () => void {
  if (!controls.enabled) return () => {}
  const doc = element.ownerDocument
  const win = doc.defaultView!
  injectStyles(doc)
  const chip = doc.createElement("button")
  chip.className = "knobs-chip"
  chip.dataset.theme = controls.theme
  chip.type = "button"
  chip.textContent = "⚙ knobs"
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
  const position = () => {
    const box = element.getBoundingClientRect()
    chip.style.left = `${Math.max(4, Math.min(win.innerWidth - chip.offsetWidth - 4, box.right - chip.offsetWidth - 6))}px`
    chip.style.top = `${Math.max(4, box.top + 6)}px`
  }
  const update = () => {
    // While its panel is open the chip has become the panel, so it stays hidden.
    const shown =
      controls.enabled &&
      !panel &&
      (hovered || element.contains(doc.activeElement) || doc.activeElement === chip)
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
  // Which panels are open survives a reload in this tab, so editing the library doesn't close them.
  const remember = controls.storage !== null
  const close = () => {
    const closing = panel
    if (!closing) return
    panel = undefined
    leaving = closing
    position()
    closing.dismiss()
    if (remember) writeSession(controls.id, { open: false })
    chip.setAttribute("aria-expanded", "false")
    setShown(true)
    chip.focus({ preventScroll: true })
  }
  const open = async (restored = false) => {
    if (panel) {
      panel.focus()
      return
    }
    if (leaving?.reopen()) {
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
      chip.textContent = "Retry knobs"
    } finally {
      loading = false
    }
  }
  // The chip toggles: mid-morph it reverses the shape from wherever it is.
  chip.onclick = () => (panel ? close() : void open())
  if (remember && readSession(controls.id).open) void open(true)
  const observer = new ResizeObserver(position)
  observer.observe(element)
  win.addEventListener("scroll", position, true)
  win.addEventListener("resize", position)
  const unsubscribe = controls.subscribe(update)
  update()
  return () => {
    disposed = true
    unsubscribe()
    panel?.dispose()
    leaving?.dispose()
    observer.disconnect()
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
