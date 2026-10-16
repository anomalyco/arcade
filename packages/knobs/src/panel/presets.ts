import { arrowOf } from "./prefs.js"
import { equal, type Schema, type Values } from "../core/schema.js"
import type { Controls } from "../core/store.js"
import { Edges, Spring } from "./motion.js"
import { tick } from "./haptics.js"
import { cue } from "./sound.js"
import { measure } from "./measure.js"
import { smearPill } from "./smear.js"
import { livePill, panOptions } from "./swipe.js"

export interface PresetEntry<V = Record<string, unknown>> {
  readonly id: string
  readonly kind: "preset" | "variant"
  readonly rawId: string
  readonly label: string
  readonly values: V
  /** Applies it (making it the active preset); `coalesce` folds it into the last undo step. */
  apply(coalesce?: boolean): void
}

export interface ActivePresetState {
  readonly activeId: string
  readonly activeIndex: number
  readonly isCustom: boolean
  /** The active preset's chip, while the values have moved off it (its modified mark). */
  readonly drifted?: boolean
}

/** How strong the selection pill stays on the active preset once the values drift off it. */
export const DRIFTED_PILL = 0.5

/** The strip's id for the store's active preset (`p:` a preset, `v:` a saved variant), if any. */
export function activeEntryId(controls: Controls<any>): string | null {
  const ref = controls.activePreset()
  return ref ? `${ref.kind === "preset" ? "p" : "v"}:${ref.id}` : null
}

/**
 * Resolves which preset or variant is currently active.
 * The store's active preset (`baseId`) holds the selection however far the values drift from it.
 * Without one, `lastAppliedId` is honoured when its values still match `currentValues`, so
 * cycling never gets stuck when a saved variant has the exact same values as a built-in preset.
 */
export function resolveActivePresetEntry<V extends Record<string, any>>(
  entries: readonly PresetEntry<V>[],
  currentValues: V,
  lastAppliedId: string | null,
  baseId: string | null = null,
): ActivePresetState {
  if (baseId !== null) {
    const at = entries.findIndex((e) => e.id === baseId)
    if (at >= 0)
      return {
        activeId: baseId,
        activeIndex: at,
        isCustom: false,
        drifted: !equal(entries[at]!.values, currentValues),
      }
  }
  if (lastAppliedId !== null) {
    const pinnedIdx = entries.findIndex((e) => e.id === lastAppliedId)
    if (pinnedIdx >= 0 && equal(entries[pinnedIdx]!.values, currentValues)) {
      return {
        activeId: entries[pinnedIdx]!.id,
        activeIndex: pinnedIdx,
        isCustom: false,
      }
    }
  }
  const matchIdx = entries.findIndex((e) => equal(e.values, currentValues))
  if (matchIdx >= 0) {
    return {
      activeId: entries[matchIdx]!.id,
      activeIndex: matchIdx,
      isCustom: false,
    }
  }
  return {
    activeId: "custom",
    activeIndex: -1,
    isCustom: true,
  }
}

export function nextPresetIndex(count: number, activeIndex: number, direction: number): number {
  if (count <= 0) return -1
  if (activeIndex < 0) return direction > 0 ? 0 : count - 1
  return (((activeIndex + direction) % count) + count) % count
}

export interface PresetStrip {
  readonly element: HTMLElement
  readonly track: HTMLElement
  readonly pill: HTMLElement
  /** Trailing "+" chip that saves the current values as a new variant (absent when variants are off). */
  readonly saveButton: HTMLButtonElement | null
  /** The selected pill's left and right edges (track px); the edge facing the move leads. */
  readonly pillEdges: Edges
  readonly pillY: Spring
  readonly pillAlpha: Spring
  getEntries(): readonly PresetEntry<any>[]
  getButtons(): readonly HTMLButtonElement[]
  getActiveState(): ActivePresetState
  cycle(direction: -1 | 1): void
  selectById(id: string): void
  /** Saves the current values as "Variant N" and opens its name to typing; returns a status message. */
  save(): string
  /** Opens the active chip's name to typing, when it's a saved variant; returns a status message. */
  rename(): string | undefined
  /** The name field while a chip's name is being typed. */
  readonly nameField: () => HTMLInputElement | null
  /** Deletes the selected chip when it's a saved variant; returns a status message. */
  deleteActive(): string | undefined
  update(): void
  dispose(): void
}

export function createPresetStrip<S extends Schema>(
  doc: Document,
  controls: Controls<S>,
  showVariants: boolean,
  run: (action: () => unknown) => void,
  onAfterChange?: () => void,
  /** What a preset's chip says (its id stays its identity); `controls.presetLabel` by default. */
  presetLabel: (id: string) => string = (id) => controls.presetLabel(id),
): PresetStrip {
  const wake = () => onAfterChange?.()
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const node = doc.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }

  const root = el("div", "knobs-presets")
  root.tabIndex = 0
  root.setAttribute("role", "radiogroup")
  root.setAttribute("aria-label", "Preset or variant")

  const track = el("div", "knobs-presets-track")
  const pill = el("div", "knobs-presets-pill")
  smearPill(pill, 8)
  pill.setAttribute("aria-hidden", "true")
  const saveButton = showVariants ? el("button", "knobs-preset-chip knobs-preset-save", "+") : null
  if (saveButton) {
    saveButton.type = "button"
    saveButton.tabIndex = -1
    saveButton.setAttribute("aria-label", "Save as variant")
    saveButton.setAttribute("aria-keyshortcuts", "Shift+S")
    saveButton.dataset.hint = "Save"
    saveButton.onclick = () => run(save)
  }
  track.append(pill)
  root.append(track)
  if (saveButton) root.append(saveButton)

  const pillEdges = new Edges()
  const pillY = new Spring(0, 28, 0.86)
  const pillAlpha = new Spring(1, 26, 0.9)

  let entries: PresetEntry<Values<S>>[] = []
  let buttons: HTMLButtonElement[] = []
  let signature = ""
  let lastVariantsRef: readonly unknown[] | null = null
  let lastAppliedId: string | null = null
  let activeState: ActivePresetState = { activeId: "p:default", activeIndex: 0, isCustom: false }
  let prevActiveId = ""
  let prevActiveIndex = -2
  let prevIsCustom = false
  let prevDrifted = false
  let initializedPill = false
  /** While the pill slides to a new chip, a resize retargets it instead of snapping it there. */
  let slideUntil = 0

  function buildEntries(): PresetEntry<Values<S>>[] {
    const presetEntries: PresetEntry<Values<S>>[] = Object.entries(controls.presets).map(
      ([id, presetValues]) => ({
        id: `p:${id}`,
        kind: "preset",
        rawId: id,
        label: presetLabel(id),
        values: presetValues,
        apply: (coalesce) => controls.preset(id, { coalesce }),
      }),
    )
    if (!showVariants) return presetEntries
    const variants = controls.variants.list()
    const variantEntries: PresetEntry<Values<S>>[] = variants.map((v) => ({
      id: `v:${v.id}`,
      kind: "variant",
      rawId: v.id,
      label: v.name ?? v.id.slice(0, 8),
      values: v.values,
      apply: (coalesce) => controls.variants.load(v.id, { coalesce }),
    }))
    return [...presetEntries, ...variantEntries]
  }

  function measurePill(snap = false) {
    // A pan holds the pill with the fingers until it ends.
    if (livePill(track)) return
    const idx = activeState.activeIndex
    const btn = idx >= 0 ? buttons[idx] : undefined
    if (!btn || activeState.isCustom) {
      if (snap) pillAlpha.snap(0)
      pill.style.opacity = "0"
      pill.style.scale = "0.92"
      return
    }
    measure(
      () => ({
        left: btn.offsetLeft,
        width: btn.offsetWidth,
        top: btn.offsetTop,
        height: btn.offsetHeight,
        trackWidth: track.clientWidth,
      }),
      (box) => placePill(box, snap),
    )
    placeName()
  }
  function placePill(
    box: { left: number; width: number; top: number; height: number; trackWidth: number },
    snap: boolean,
  ) {
    // The pill is placed by its edges so each can move on its own curve: the edge facing the
    // move leads and the other trails, stretching the pill toward its destination.
    const { left, top } = box
    const right = left + Math.max(20, box.width)
    const first = snap || !initializedPill
    if (first) {
      pillEdges.snap(left, right)
      pillY.snap(top)
      pillAlpha.snap(1)
      initializedPill = true
      pill.style.transition = "none"
    } else {
      const at = parseFloat(pill.style.left) || 0
      if (left !== at) {
        pill.dataset.dir = left > at ? "right" : "left"
        slideUntil = performance.now() + 400
      }
    }
    pill.style.left = `${left}px`
    pill.style.right = `${box.trackWidth - right}px`
    pill.style.top = `${top}px`
    pill.style.height = `${box.height}px`
    pill.style.opacity = activeState.drifted ? String(DRIFTED_PILL) : "1"
    pill.style.scale = ""
    if (first) doc.defaultView?.requestAnimationFrame(() => (pill.style.transition = ""))
  }

  const resolve = () =>
    resolveActivePresetEntry(entries, controls.get(), lastAppliedId, activeEntryId(controls))
  function syncSelection(snap = false) {
    activeState = resolve()
    if (lastAppliedId !== null && activeState.activeId !== lastAppliedId) {
      lastAppliedId = null
    }
    const drifted = Boolean(activeState.drifted)
    if (
      !snap &&
      initializedPill &&
      activeState.activeId === prevActiveId &&
      activeState.activeIndex === prevActiveIndex &&
      activeState.isCustom === prevIsCustom &&
      drifted === prevDrifted
    ) {
      return
    }
    prevActiveId = activeState.activeId
    prevActiveIndex = activeState.activeIndex
    prevIsCustom = activeState.isCustom
    prevDrifted = drifted
    root.dataset.activePreset = activeState.activeId
    root.dataset.value = activeState.activeId
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i]!
      const checked = i === activeState.activeIndex
      b.setAttribute("aria-checked", String(checked))
      b.classList.toggle("knobs-preset-active", checked)
      // The active preset's modified mark, as a row's dot says it differs from its base.
      if (b.hasAttribute("data-drifted") !== (checked && drifted))
        b.toggleAttribute("data-drifted", checked && drifted)
      const label = entries[i]?.label ?? ""
      const aria = checked && drifted ? `${label}, modified` : label
      if (b.getAttribute("aria-label") !== aria) b.setAttribute("aria-label", aria)
    }
    measurePill(snap)
  }

  function selectAt(index: number, coalesce = false) {
    const entry = entries[index]
    if (!entry) return
    // A scrub's later stops are detents; a fresh pick lands.
    cue(root, coalesce ? "select" : "preset", { direction: index - activeState.activeIndex })
    lastAppliedId = entry.id
    // A scrub is one gesture, so it lands in history as one step.
    run(() => entry.apply(coalesce))
    syncSelection(false)
    onAfterChange?.()
  }

  function selectById(id: string) {
    const idx = entries.findIndex((e) => e.id === id || e.rawId === id || e.label === id)
    if (idx >= 0) selectAt(idx)
  }

  function cycle(direction: -1 | 1) {
    if (entries.length === 0) return
    const current = resolve()
    const nextIdx = nextPresetIndex(entries.length, current.activeIndex, direction)
    if (nextIdx >= 0) selectAt(nextIdx)
  }

  function update() {
    run(() => {
      const variantsRef = showVariants ? controls.variants.list() : null
      if (signature !== "" && variantsRef === lastVariantsRef) {
        syncSelection(false)
        return
      }
      lastVariantsRef = variantsRef
      const nextEntries = buildEntries()
      const nextSig = JSON.stringify(nextEntries.map((e) => [e.id, e.label]))
      const shouldShow = nextEntries.length > 1 || showVariants
      root.hidden = !shouldShow
      if (nextSig !== signature) {
        signature = nextSig
        entries = nextEntries
        buttons = entries.map((entry, idx) => {
          const b = el("button", "knobs-preset-chip", entry.label)
          b.type = "button"
          b.tabIndex = -1
          b.dataset.presetId = entry.id
          b.dataset.presetKind = entry.kind
          b.dataset.presetName = entry.label
          b.setAttribute("role", "radio")
          b.setAttribute("aria-label", entry.label)
          b.onclick = (e) => {
            e.preventDefault()
            focusQuietly()
            // The active chip again brings its values back once they've drifted.
            if (idx !== activeState.activeIndex || activeState.drifted) selectAt(idx)
          }
          return b
        })
        track.replaceChildren(pill, ...buttons)
        fitColumns()
        syncSelection(true)
      } else {
        entries = nextEntries
        syncSelection(false)
      }
    })
  }

  // Pointer selections keep keyboard focus in the strip without drawing a keyboard focus ring.
  // Called before selecting: focusing reads style, which a preset's writes would leave dirty.
  function focusQuietly() {
    root.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
  }

  // Columns are as wide as the longest name, so a label never spills into its neighbour;
  // narrower panels wrap to more rows instead.
  function fitColumns() {
    let widest = 0
    const range = doc.createRange()
    for (const b of buttons) {
      if (b.hidden || !b.firstChild) continue
      range.selectNodeContents(b)
      widest = Math.max(widest, range.getBoundingClientRect().width)
    }
    // Room for the bolder selected weight plus the chip's side padding.
    if (widest > 0) track.style.setProperty("--k-preset-min", `${Math.ceil(widest * 1.06 + 14)}px`)
  }

  function save() {
    finishName(true)
    const used = new Set(controls.variants.list().map((v) => v.name))
    let n = 1
    while (used.has(`Variant ${n}`)) n++
    const variant = controls.variants.save(`Variant ${n}`)
    // The saved values become the active preset: Reset comes back to them, Random roams near.
    controls.variants.load(variant.id)
    lastAppliedId = `v:${variant.id}`
    update()
    startName(
      entries.findIndex((e) => e.id === `v:${variant.id}`),
      true,
    )
    onAfterChange?.()
    return `Saved “Variant ${n}”. Type a name, or Enter to keep it.`
  }

  // Naming: a field over the chip, its name selected so typing replaces it. Enter (or leaving
  // it) keeps what's typed; Esc keeps the name it had. The strip keeps focus afterwards.
  let naming: {
    input: HTMLInputElement
    id: string
    was: string
  } | null = null
  function placeName() {
    if (!naming) return
    const btn = buttons[entries.findIndex((e) => e.id === naming!.id)]
    if (!btn) return void finishName(false)
    // A rebuilt strip has new chips; the one being named keeps its name hidden under the field.
    if (!btn.hasAttribute("data-naming")) btn.toggleAttribute("data-naming", true)
    const { input } = naming
    measure(
      () => ({
        left: track.offsetLeft + btn.offsetLeft,
        top: track.offsetTop + btn.offsetTop,
        width: btn.offsetWidth,
        height: btn.offsetHeight,
      }),
      (box) => {
        input.style.left = `${box.left}px`
        input.style.top = `${box.top}px`
        input.style.width = `${box.width}px`
        input.style.height = `${box.height}px`
      },
    )
  }
  function startName(index: number, fresh = false) {
    const entry = entries[index]
    if (!entry || entry.kind !== "variant") return false
    finishName(true)
    const input = el("input", "knobs-preset-name")
    input.type = "text"
    input.value = entry.label
    input.maxLength = 100
    input.spellcheck = false
    input.autocomplete = "off"
    input.setAttribute("aria-label", fresh ? "Name the saved preset" : `Rename ${entry.label}`)
    naming = { input, id: entry.id, was: entry.label }
    root.append(input)
    placeName()
    input.focus({ preventScroll: true })
    input.select()
    input.onkeydown = (event) => {
      // Typing stays in the field: the panel's keys wait until the name is in.
      event.stopPropagation()
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault()
        run(() => finishName(event.key === "Enter", true))
      }
    }
    input.onblur = () => run(() => finishName(true))
    input.onpointerdown = (event) => event.stopPropagation()
    onAfterChange?.()
    return true
  }
  function finishName(keep: boolean, refocus = false) {
    if (!naming) return undefined
    const { input, id, was } = naming
    naming = null
    input.onblur = null
    const name = input.value.trim()
    const entry = entries.find((e) => e.id === id)
    for (const b of buttons) b.removeAttribute("data-naming")
    // The field lets go on the way out (see .knobs-preset-name[data-leaving]).
    input.dataset.leaving = ""
    input.blur()
    setTimeout(() => input.remove(), 140)
    if (refocus) focusQuietly()
    let message: string | undefined
    if (keep && entry?.kind === "variant" && name && name !== was) {
      controls.variants.rename(entry.rawId, name)
      update()
      message = `Named “${name}”.`
    }
    onAfterChange?.()
    return message
  }
  function rename() {
    const index = activeState.activeIndex
    const entry = entries[index]
    if (!entry || activeState.isCustom) return undefined
    if (entry.kind !== "variant") return "Built-in presets keep their names."
    startName(index)
    return undefined
  }

  function deleteActive() {
    const entry = entries[activeState.activeIndex]
    if (!entry || entry.kind !== "variant") return undefined
    controls.variants.remove(entry.rawId)
    lastAppliedId = null
    update()
    onAfterChange?.()
    return `Deleted “${entry.label}”.`
  }

  // Pointer scrubbing across chips
  let scrubbing = false
  let scrubCommitted = false
  // Nearest chip to the pointer, so scrubbing past either end (or a gap) still lands on one.
  const chipIndexAt = (clientX: number, clientY: number): number => {
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < buttons.length; i++) {
      const rect = buttons[i]!.getBoundingClientRect()
      const dx =
        clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0
      const dy =
        clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0
      const dist = dx + dy * 4
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    return best
  }
  track.onpointerdown = (event) => {
    if (event.button !== 0 || buttons.length === 0) return
    if (saveButton && saveButton.contains(event.target as Node)) return
    event.preventDefault()
    scrubbing = true
    scrubCommitted = false
    track.setPointerCapture(event.pointerId)
    focusQuietly()
    const idx = chipIndexAt(event.clientX, event.clientY)
    if (idx >= 0 && (idx !== activeState.activeIndex || activeState.drifted)) {
      selectAt(idx)
      scrubCommitted = true
    }
  }
  track.ondblclick = (event) => {
    const idx = chipIndexAt(event.clientX, event.clientY)
    if (idx >= 0) run(() => (startName(idx) ? undefined : rename()))
  }
  track.onpointermove = (event) => {
    if (!scrubbing) return
    const idx = chipIndexAt(event.clientX, event.clientY)
    if (idx >= 0 && idx !== activeState.activeIndex) {
      selectAt(idx, scrubCommitted)
      scrubCommitted = true
      tick(track)
    }
  }
  const endScrub = () => {
    scrubbing = false
  }
  track.onpointerup = endScrub
  track.onpointercancel = endScrub

  root.onkeydown = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (arrowOf(event) === -1) {
      event.preventDefault()
      event.stopPropagation()
      cycle(-1)
    } else if (arrowOf(event) === 1) {
      event.preventDefault()
      event.stopPropagation()
      cycle(1)
    } else if (event.key === "Home" && entries.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      selectAt(0)
    } else if (event.key === "End" && entries.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      selectAt(entries.length - 1)
    } else if (event.key === "F2" || (event.key === "Enter" && !event.shiftKey)) {
      const entry = entries[activeState.activeIndex]
      // Enter names a saved variant; on a built-in preset it's left to the panel.
      if (event.key === "Enter" && entry?.kind !== "variant") return
      event.preventDefault()
      event.stopPropagation()
      run(() => rename())
    } else if ((event.key === "Backspace" || event.key === "Delete") && showVariants) {
      event.preventDefault()
      event.stopPropagation()
      run(() => deleteActive() ?? "Only saved variants can be deleted.")
    } else if (/^[1-9]$/.test(event.key)) {
      const idx = Number(event.key) - 1
      if (idx < entries.length) {
        event.preventDefault()
        event.stopPropagation()
        selectAt(idx)
      }
    }
  }

  // A sideways pan drags the pill across the chips, as one undo step, stopping at the ends.
  panOptions(root, {
    box: track,
    pill,
    buttons: () => buttons,
    selected: () => resolve().activeIndex,
    select: (i, coalesce) => selectAt(i, coalesce),
    rest: () => measurePill(),
    wake,
    minWidth: 20,
    rows: true,
  })

  void doc.fonts?.ready.then(fitColumns)
  const ro = new ResizeObserver(() => measurePill(performance.now() >= slideUntil))
  ro.observe(track)

  return {
    element: root,
    track,
    pill,
    saveButton,
    pillEdges,
    pillY,
    pillAlpha,
    getEntries: () => entries,
    getButtons: () => buttons,
    getActiveState: () => activeState,
    cycle,
    selectById,
    save: () => {
      let message = ""
      run(() => (message = save()))
      return message
    },
    deleteActive,
    rename,
    nameField: () => naming?.input ?? null,
    update,
    dispose: () => {
      finishName(false)
      ro.disconnect()
    },
  }
}
