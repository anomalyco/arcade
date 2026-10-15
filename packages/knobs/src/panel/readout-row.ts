// Readout rows: a live value, sparkline, graph, meter, table or log in a panel. The view (and
// what it draws) comes from knobs/ui; the row gives it a label and a ↑↓ stop, follows the store's
// pushes, and hands the GPU overlay the view's layers, texts and buttons.
import type { ReadoutState } from "../core/readout.js"
import type { ReadoutField } from "../core/schema.js"
import { injectUiStyles } from "../ui/look.js"
import { createReadout, type ReadoutView } from "../ui/readouts.js"
import type { EditorRow } from "./editors.js"
import type { GpuReadoutRow, RowWave } from "./gpu/renderer.js"

export interface ReadoutRow extends EditorRow {
  readonly view: ReadoutView
  /** Something new arrived for this key. */
  notify(): void
  swap(field: ReadoutField, display: string): void
}

const BLOCKS = new Set(["graph", "table", "log"])

export function readoutRow(c: {
  doc: Document
  key: string
  display: string
  field: ReadoutField
  state: ReadoutState
  wave: RowWave
  wake(): void
  gpu(): boolean
}): ReadoutRow {
  injectUiStyles(c.doc)
  const block = BLOCKS.has(c.field.kind)
  const row = c.doc.createElement("div")
  row.className = `knobs-row knobs-rd-row${block ? " knobs-rd-rowblock" : ""}`
  row.dataset.field = c.key
  row.dataset.kind = c.field.kind
  const label = c.doc.createElement("span")
  label.textContent = c.display
  const view = createReadout({
    doc: c.doc,
    field: c.field,
    state: c.state,
    ...(block ? { label } : {}),
    gpu: c.gpu,
    wake: c.wake,
  })
  if (block) row.append(view.element)
  else row.append(label, view.element)
  const input = view.focusTarget
  input.tabIndex = 0
  input.setAttribute("aria-label", c.display)
  // A sparkline focused reads its extent, as hovered.
  const hover = (view as ReadoutView & { hover?(on: boolean): void }).hover
  if (hover) {
    input.addEventListener("focus", () => hover(true))
    input.addEventListener("blur", () => hover(false))
  }
  const gpu: GpuReadoutRow = {
    kind: "readout",
    key: c.key,
    display: c.display,
    row,
    labelEl: label,
    view,
    wave: c.wave,
    isModified: () => false,
  }
  return {
    row,
    labelEl: label,
    input,
    view,
    stops: () => [input],
    update() {},
    notify: () => view.notify(),
    swap(field, display) {
      if (display !== gpu.display) {
        gpu.display = display
        label.textContent = display
        input.setAttribute("aria-label", display)
      }
      view.retune(field)
    },
    dispose: () => view.dispose(),
    tracks: [],
    gpu: [gpu],
  }
}
