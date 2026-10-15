import { storageKey, type StoragePort } from "../core/storage.js"

export function positionPanel(
  panel: HTMLElement,
  header: HTMLElement,
  anchor: HTMLElement,
  id: string,
  storage: () => StoragePort | null,
) {
  const doc = panel.ownerDocument
  const win = doc.defaultView!
  const bounds = anchor.getBoundingClientRect()
  const w = panel.offsetWidth || 288
  const clampX = (v: number) => Math.max(8, Math.min(v, win.innerWidth - w - 8))
  let x = bounds.right + w <= win.innerWidth - 8 ? bounds.right + 8 : clampX(bounds.left - w - 8)
  let y = Math.max(8, bounds.top)
  const key = storageKey(id, "position")
  let hasSaved = false
  try {
    const saved = JSON.parse(storage()?.getItem(key) ?? "null")
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      x = saved.x
      y = saved.y
      hasSaved = true
    }
  } catch {
    /* Position is optional; tuning and variant storage report their own errors. */
  }
  if (!hasSaved) {
    const others = [...doc.querySelectorAll<HTMLElement>(".knobs-panel:not(.knobs-inline)")]
      .filter((el) => el !== panel)
      .map((el) => el.getBoundingClientRect())
    if (others.length > 0) {
      const overlaps = (cx: number, cy: number) =>
        others.some((r) => Math.abs(cx - r.left) < w - 24 && Math.abs(cy - r.top) < 120)
      if (overlaps(x, y)) {
        const candidates = [
          bounds.right + 8,
          bounds.left - w - 8,
          bounds.left + 8,
          bounds.right - w - 8,
          ...others.flatMap((r) => [r.right + 12, r.left - w - 12]),
        ].map(clampX)
        const free = candidates.find((cx) => !overlaps(cx, y))
        if (free !== undefined) x = free
        else {
          x = clampX(x + others.length * 24)
          y = Math.max(8, y + others.length * 32)
        }
      }
    }
  }
  // x, y is where the panel wants to be; it shows clamped inside the viewport, so an editor
  // opening near the bottom lifts it and closing that editor lets it settle back.
  let shown = { x, y }
  const constrain = () => {
    shown = {
      x: Math.max(8, Math.min(x, win.innerWidth - panel.offsetWidth - 8)),
      y: Math.max(8, Math.min(y, win.innerHeight - panel.offsetHeight - 8)),
    }
    panel.style.left = `${shown.x}px`
    panel.style.top = `${shown.y}px`
  }
  let drag: { id: number; x: number; y: number; left: number; top: number } | undefined
  header.onpointerdown = (event) => {
    if (event.button !== 0 || (event.target as Element).closest("button,select,input")) return
    event.preventDefault()
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: shown.x, top: shown.y }
    header.setPointerCapture(event.pointerId)
  }
  header.onpointermove = (event) => {
    if (!drag || event.pointerId !== drag.id) return
    x = drag.left + event.clientX - drag.x
    y = drag.top + event.clientY - drag.y
    constrain()
  }
  header.onlostpointercapture = () => {
    if (!drag) return
    drag = undefined
    ;({ x, y } = shown)
    try {
      storage()?.setItem(key, JSON.stringify({ x, y }))
    } catch {
      /* Keep the live position. */
    }
  }
  const observer = new ResizeObserver(constrain)
  observer.observe(panel)
  win.addEventListener("resize", constrain)
  constrain()
  return {
    constrain,
    dispose() {
      observer.disconnect()
      win.removeEventListener("resize", constrain)
    },
  }
}
