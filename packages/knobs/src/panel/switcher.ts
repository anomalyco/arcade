import type { ChoiceKey } from "../core/adapter.js"
import { equal, type Schema, type Values } from "../core/schema.js"
import type { Controls } from "../core/store.js"

export type { ChoiceKey }

export interface SwitcherOptions<S extends Schema> {
  readonly field?: ChoiceKey<S>
  readonly label?: string
  readonly onUpdate?: (activeName: string) => void
}

let hoveredPreview: { element: HTMLElement; target: Element } | null = null
const lastAppliedByControls = new WeakMap<Controls<any>, string>()
const interactive = "a[href],button,input,select,textarea,[contenteditable=true]"

export function getSwitcherOptions<S extends Schema>(
  controls: Controls<S>,
  field?: ChoiceKey<S>,
): {
  options: { id: string; name: string; values?: Values<S>; choose(): void }[]
  index: number
  activeName: string
} {
  const values = controls.get()
  const definition = field ? controls.schema[field] : undefined
  let variants: readonly { id: string; name?: string; values: Values<S> }[] = []
  if (!field && controls.enabled) {
    try {
      variants = controls.variants.list()
    } catch {
      variants = []
    }
  }
  const options: { id: string; name: string; values?: Values<S>; choose(): void }[] =
    definition?.kind === "choice"
      ? definition.options.map((value) => ({
          id: value,
          name: value,
          choose: () => controls.set({ [field!]: value } as Partial<Values<S>>),
        }))
      : [
          ...Object.entries(controls.presets).map(([id, preset]) => ({
            id: `p:${id}`,
            name: id,
            values: preset,
            choose: () => {
              lastAppliedByControls.set(controls, `p:${id}`)
              controls.preset(id)
            },
          })),
          ...variants.map((v) => ({
            id: `v:${v.id}`,
            name: v.name ?? v.id.slice(0, 8),
            values: v.values,
            choose: () => {
              lastAppliedByControls.set(controls, `v:${v.id}`)
              controls.variants.load(v.id)
            },
          })),
        ]
  let index = -1
  if (field) {
    index = options.findIndex((o) => o.id === values[field])
  } else {
    const pinnedId = lastAppliedByControls.get(controls)
    if (pinnedId) {
      const pinnedIdx = options.findIndex(
        (o) => o.id === pinnedId && o.values !== undefined && equal(o.values, values),
      )
      if (pinnedIdx >= 0) index = pinnedIdx
    }
    if (index < 0) {
      index = options.findIndex((o) => o.values !== undefined && equal(o.values, values))
    }
  }
  return {
    options,
    index,
    activeName: options[index]?.name ?? "custom",
  }
}

export function attachVariantSwitcher<S extends Schema>(
  element: HTMLElement,
  controls: Controls<S>,
  switcherOptions: SwitcherOptions<S> = {},
): () => void {
  if (!controls.enabled) return () => {}
  const doc = element.ownerDocument
  const win = doc.defaultView!
  const { field, label, onUpdate } = switcherOptions

  element.dataset.knobsSwitcher = controls.id
  if (!element.hasAttribute("role")) element.setAttribute("role", "group")
  const addedTabIndex = !element.hasAttribute("tabindex")
  if (addedTabIndex) element.tabIndex = 0

  const sync = () => {
    const { activeName } = getSwitcherOptions(controls, field)
    element.setAttribute(
      "aria-label",
      label ?? `${controls.id} ${field ?? "variant"}: ${activeName}. Use 1–9 or left/right arrows.`,
    )
    onUpdate?.(activeName)
  }

  const cycle = (direction: number) => {
    const { options, index } = getSwitcherOptions(controls, field)
    if (!options.length) return
    options[(index + direction + options.length) % options.length]?.choose()
  }

  const onPointerOver = (event: PointerEvent) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-knobs-switcher]") === element
    )
      hoveredPreview = { element, target: event.target }
  }

  const onPointerLeave = (event: PointerEvent) => {
    if (hoveredPreview?.element !== element) return
    const target = event.relatedTarget instanceof Element ? event.relatedTarget : null
    const parent = target?.closest<HTMLElement>("[data-knobs-switcher]")
    hoveredPreview = parent && target ? { element: parent, target } : null
  }

  const onElementKeyDown = (event: KeyboardEvent) => {
    if (event.target === element && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault()
      cycle(1)
    }
  }

  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    )
      return
    const focused = doc.activeElement?.closest("[data-knobs-switcher]")
    const active = hoveredPreview?.element ?? focused
    if (
      active !== element ||
      (event.target instanceof Element && event.target.closest(interactive)) ||
      hoveredPreview?.target.closest(interactive)
    )
      return
    if (win.getSelection()?.isCollapsed === false) return
    const { options } = getSwitcherOptions(controls, field)
    const selection = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1
    if (selection >= 0 && options[selection]) {
      event.preventDefault()
      options[selection].choose()
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault()
      cycle(event.key === "ArrowLeft" ? -1 : 1)
    }
  }

  element.addEventListener("pointerover", onPointerOver)
  element.addEventListener("pointerleave", onPointerLeave)
  element.addEventListener("keydown", onElementKeyDown)
  win.addEventListener("keydown", onWindowKeyDown)
  const unsubscribe = controls.subscribe(sync)
  sync()

  return () => {
    unsubscribe()
    element.removeEventListener("pointerover", onPointerOver)
    element.removeEventListener("pointerleave", onPointerLeave)
    element.removeEventListener("keydown", onElementKeyDown)
    win.removeEventListener("keydown", onWindowKeyDown)
    if (hoveredPreview?.element === element) hoveredPreview = null
    delete element.dataset.knobsSwitcher
    if (addedTabIndex && element.getAttribute("tabindex") === "0")
      element.removeAttribute("tabindex")
  }
}
