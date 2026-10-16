import {
  actionShortcut,
  hasValue,
  isReadout,
  same,
  toolbarShortcut,
  type ActionField,
  type Choice,
  type Field,
  type Knob,
  type Schema,
  type ToolbarField,
  type ToolbarItem,
  type Value,
  type Values,
} from "../core/schema.js"
import { REFRESHES } from "../core/internal.js"
import { comboLabel, letterOf, matchesCombo } from "../core/keys.js"
import type { SpringValue } from "../core/spring.js"
import type {
  ControlAction,
  Controls,
  GroupPresetDisplay,
  HeaderButton,
  MountPanelOptions,
  PanelCommand,
  PanelKeys,
  SectionFolded,
} from "../core/store.js"
import {
  getGpuOverlayManager,
  resolveRendererMode,
  stackingAncestor,
  type GpuGroupBinding,
  type GpuPanelBinding,
  type GpuRowBinding,
} from "./gpu/renderer.js"
import {
  colorRow,
  easingRow,
  pointRow,
  springRow,
  type EditorRow,
  type RowOptions,
  type SubTrack,
} from "./editors.js"
import { curveRow, gradientRow } from "./ramps.js"
import {
  angleRow,
  keyCap,
  keybindRow,
  rangeRow,
  seedRow,
  toolbarRow,
  vecRow,
  type ToolbarRow,
} from "./inspector.js"
import { spin, spinning } from "./spin.js"
import { createSearch, markLabel, matchSpan, type SearchBar } from "./search.js"
import { READOUT, type ReadoutPort } from "../core/readout.js"
import { readoutRow, type ReadoutRow } from "./readout-row.js"
import { toast } from "../ui/toast.js"
import { createTabStrip, type TabSpec } from "./tabs.js"
import { createChoice, type ChoiceControl } from "./choice.js"
import { createOptionKeys } from "./optkeys.js"
import {
  commandScope,
  digitOption,
  escapeTo,
  scopeLabel,
  type CommandScope,
  type FocusLevel,
} from "./scope.js"
import { trackHas } from "./has.js"
import { createHintController, type HintTarget } from "./hints.js"
import { pageHints } from "./page-hints.js"
import { createHeaderDie, GROUP_DIE, type HeaderDie } from "./die.js"
import { CHECK_PATH, iconSvg, type IconName } from "./icons.js"
import { batchMeasures } from "./measure.js"
import { Edges } from "./motion.js"
import { morphFromChip, type PanelMorph } from "./morph.js"
import { openMenu, type Menu } from "./menu.js"
import {
  caretIcon,
  cardTitle,
  createCustomCard,
  createPageLayout,
  matchesFilter,
  type CustomCardFold,
  type FoldSummaryInfo,
  type MountPageOptions,
  type Page,
  type PageCardOptions,
  type PageFoldOptions,
  type PageFoldSource,
  type PageGroupInfo,
  type PageHighlight,
  type PageLayout,
  type PageSectionInfo,
} from "./page.js"
import { foldMemory, type FoldMemory } from "./folds.js"
import { positionPanel } from "./position.js"
import { reveal } from "./reveal.js"
import { createPresetStrip, type PresetStrip } from "./presets.js"
import { placeSegPill, primeSegPill } from "./seg.js"
import { smearPill } from "./smear.js"
import { tapTick, tick } from "./haptics.js"
import { changed, cue, resolveSound, sound, SOUND_PREF, soundPanel } from "./sound.js"
import { panSwitch } from "./thumb.js"
import { createSlider, type Slider, stepValue } from "./slider.js"
import { readSession, writeSession } from "./session.js"
import {
  arrowOf,
  DEFAULT_PREFS,
  type KeyPrefs,
  keyLabel,
  resolveKeys,
  setKeyPrefs,
} from "./prefs.js"
import { DELAYED, injectPreset, injectStyles } from "./styles.js"

export interface Panel {
  element: HTMLElement
  presetStrip: PresetStrip
  focus(): void
  /** Collapses the panel into its chip (or fades it out), then disposes it. */
  dismiss(): void
  /** Reverses a collapse still in flight; false once there's none to reverse. */
  reopen(): boolean
  /** Asks `rowAccessory` again for every row, e.g. after a pin changed elsewhere. */
  updateAccessories(): void
  /** Folds (`true`) or opens a foldable group's card; toggles without `folded`. */
  fold(group: string, folded?: boolean): void
  /** Shows tab `id` (when given) and returns the tab shown, if the panel has tabs. */
  tab(id?: string): string | undefined
  /**
   * Searches for `query` (when given) with exactly `chips` on (when given), as typing and clicking
   * would, and returns what the search holds now; undefined without `search`.
   */
  search(query?: string, chips?: readonly string[]): PanelSearch | undefined
  dispose(): void
}
/** A panel's search: the query as typed and the chips that are on. */
export interface PanelSearch {
  readonly query: string
  readonly chips: readonly string[]
}
let layer = 2147480001
/** How long Copy holds its check (drawn by about 0.2 s) before turning back. */
const COPIED_MS = 1000
/** The tab each panel last showed, by controls id, so a panel mounted again opens on it. */
const lastTab = new Map<string, string>()
/** A highlight's reveal waits this long (ms) after the user last scrolled, typed or touched. */
const REVEAL_QUIET_MS = 2000
/** Arrow keys pressed again within this long (ms) of the last one coming up are one gesture. */
const NUDGE_BURST_MS = 300

/** "synth-voice" → "Synth voice", "knobsTokens" → "Knobs tokens"; titles with spaces are kept. */
export function readableTitle(id: string): string {
  if (/\s/.test(id)) return id
  const words = id
    .replace(/([a-z0-9])([A-Z][a-z])/g, "$1-$2")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z][a-z0-9]*$/.test(word) ? word.toLowerCase() : word))
  const first = words[0] ?? ""
  if (/^[a-z0-9]+$/.test(first)) words[0] = first.charAt(0).toUpperCase() + first.slice(1)
  return words.join(" ")
}

interface InternalPanelOptions extends MountPanelOptions {
  readonly inline?: boolean
  readonly anchor?: HTMLElement
  readonly close?: () => void
  /** Reopened after a reload: no entrance, and focus returns where it was. */
  readonly restored?: boolean
  /** The chip a floating panel grows out of and collapses back into. */
  readonly chip?: HTMLElement
  /** A full page: sections of group cards under a sticky header (see `mountPage`). */
  readonly page?: MountPageOptions
}

const ariaKeys = (keys: readonly string[]) =>
  keys.map((k) => (/^[A-Z]$/.test(k) ? `Shift+${k.toLowerCase()}` : k)).join(" ")

function buildPanel<S extends Schema>(
  controls: Controls<S>,
  host: HTMLElement,
  options: InternalPanelOptions,
): Panel {
  if (!controls.enabled) throw new Error("Controls are disabled.")
  const doc = host.ownerDocument
  injectStyles(doc)
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag)
    if (text) node.textContent = text
    return node
  }
  const inline = Boolean(options.inline)
  const page = options.page
  const close = options.close ?? options.onClose
  const root: HTMLElement = el(page ? "div" : "aside")
  root.className = page
    ? "knobs-panel knobs-inline knobs-page"
    : inline
      ? "knobs-panel knobs-inline"
      : "knobs-panel"
  root.dataset.controls = controls.id
  const untrackHas = trackHas(root)
  root.dataset.theme = options.theme ?? controls.theme
  root.dataset.density = options.density ?? controls.density
  if (options.preset) {
    injectPreset(doc, options.preset)
    root.dataset.preset = options.preset.name
  }
  const titleText = options.title === undefined ? controls.id : options.title
  if (options.restored) root.dataset.restored = ""
  if (options.haptics === false) root.dataset.haptics = "off"
  const soundOptions = resolveSound(options.sound)
  if (soundOptions) {
    soundPanel(root, soundOptions)
    // The user's own choice (the ? popover's Sounds), kept in the store's storage.
    try {
      const kept = controls.storage?.getItem(SOUND_PREF)
      if (kept === "on" || kept === "off") sound.enable(kept === "on")
    } catch {}
  }
  root.setAttribute("role", inline ? "region" : "dialog")
  root.setAttribute("aria-label", `${titleText || controls.id} controls`)
  host.append(root)

  let wakeGpu = () => {}

  const status = el("p")
  status.className = "knobs-status"
  status.setAttribute("role", "status")
  status.hidden = true
  // Messages glide in, linger, then fold away so the panel returns to its resting height.
  let statusTimer: ReturnType<typeof setTimeout> | undefined
  const say = (message: string, linger = 3200) => {
    // A page says it in a toast, as the workspace's overlays do.
    if (page) {
      toast(message, { within: root, linger, ...(linger > 3200 ? { tone: "error" as const } : {}) })
      return
    }
    clearTimeout(statusTimer)
    status.textContent = message
    reveal(status, true)
    statusTimer = setTimeout(() => reveal(status, false), linger)
  }
  // What's shown in place (the copy check) is still said to assistive tech.
  const live = el("span")
  live.className = "knobs-sr"
  live.setAttribute("aria-live", "polite")
  const announce = (message: string) => {
    live.textContent = ""
    queueMicrotask(() => (live.textContent = message))
  }
  const run = (action: () => unknown) => {
    try {
      const result = action()
      if (typeof result === "string") say(result)
      else if (result instanceof Promise)
        void result
          .then((msg) => {
            if (typeof msg === "string") say(msg)
            wakeGpu()
          })
          .catch((cause) => {
            say(cause instanceof Error ? cause.message : String(cause), 6000)
            wakeGpu()
          })
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause), 6000)
    }
    wakeGpu()
  }
  const button = (label: string, action: () => unknown) => {
    const node = el("button", label)
    node.type = "button"
    node.onclick = () => run(action)
    return node
  }

  const showVariants = options.variants !== false
  const showHistory = options.history !== false
  const showFooter = options.footer !== false
  const given = options.keys ?? controls.keys
  const marks = (options.marks ?? controls.marks) !== false
  const keys = resolveKeys(given, Boolean(page))
  // Locks and group dice only mean something while something can roll.
  if (!keys.random.length && !keys.mutate.length) keys.lock = keys.group = []
  // A row menu with nothing in it doesn't open.
  if (![keys.lock, keys.random, keys.reset, keys.copy].some((k) => k.length)) keys.menu = []
  const prefs: KeyPrefs = {
    vim: given?.vim !== false,
    edit: given?.edit !== false,
    bigStep:
      typeof given?.bigStep === "number" && given.bigStep > 0
        ? given.bigStep
        : DEFAULT_PREFS.bigStep,
    wrap: given?.wrap !== false,
  }
  setKeyPrefs(root, prefs)
  /** Whether a command is on (it has a key, or its button stays). */
  const bound = (command: PanelCommand) => keys[command].length > 0
  const pressed = (command: PanelCommand, event: KeyboardEvent) => keys[command].includes(event.key)
  /** ⌥ commands match by the layout's letter: ⌥ changes the typed character on macOS. */
  const pressedAlt = (command: PanelCommand, event: KeyboardEvent) =>
    keys[command].some((k) => k.length === 1 && letterOf(event) === k.toUpperCase())

  const header = el("header")
  const headerOptions = typeof options.header === "object" ? options.header : undefined
  /**
   * Whether a header button shows (`header.buttons`; all but help without a list, since `?` opens
   * the shortcuts and the title's tooltip says so). Its key works either way.
   */
  const shows = (button: HeaderButton) =>
    headerOptions?.buttons ? headerOptions.buttons.includes(button) : button !== "help"
  const headerButtons: { button: HTMLButtonElement; icon: IconName }[] = []
  const headActions = el("div")
  headActions.className = "knobs-head-actions"
  const iconButton = (icon: IconName, label: string, shortcut: string, action: () => unknown) => {
    const node = button("", action)
    node.append(iconSvg(doc, icon))
    node.setAttribute("aria-label", label)
    if (shortcut) node.setAttribute("aria-keyshortcuts", shortcut)
    return node
  }
  /**
   * A button that's there only when it's useful (a group's or the panel's reset, undo, redo): it
   * keeps its slot either way and blooms in and out of it (see `[data-shown]` in the styles).
   */
  const bloom = (node: HTMLButtonElement, on: boolean) => {
    const shown = String(on)
    if (node.disabled !== !on) node.disabled = !on
    if (node.dataset.shown === shown) return false
    node.dataset.shown = shown
    return true
  }
  const place = (node: HTMLButtonElement, icon: IconName) => {
    headActions.append(node)
    headerButtons.push({ button: node, icon })
    return node
  }
  const headButton = (icon: IconName, label: string, shortcut: string, action: () => unknown) =>
    place(iconButton(icon, label, shortcut, action), icon)

  const popover = el("div")
  popover.className = "knobs-popover"
  popover.hidden = true
  popover.setAttribute("role", "note")
  popover.setAttribute("aria-label", "Keyboard shortcuts")
  const popGrid = el("div")
  popGrid.className = "knobs-popover-grid"
  const SCOPED = {
    both: "Random / Reset all",
    random: "Random all",
    reset: "Reset all",
    mutate: "Mutate all: small changes",
  }
  const scopedDescs: [HTMLElement, string][] = []
  const show = (command: PanelCommand, alt = false) =>
    keys[command].map((k) => keyLabel(k, alt)).join(" / ")
  const pair = (a: PanelCommand, b: PanelCommand, what: string) =>
    bound(a) && bound(b) ? [[`${show(a)} / ${show(b)}`, what]] : []
  for (const [k, desc] of [
    [prefs.vim ? "↑↓ / j k" : "↑↓", "Move between rows"],
    ...((page
      ? [
          ["Tab / ⇧Tab", "Next / previous group"],
          ["⌥↑ / ⌥↓", "Previous / next section"],
          ["1–9", "Row's option, else group preset"],
          ...(page.filter !== false ? [["/", "Filter rows"]] : []),
        ]
      : [
          ["Tab", "Next control"],
          ...(options.tabs?.length ||
          Object.values(controls.schema as Record<string, Field>).some((f) => f.tab)
            ? [["⌥1–9", "Switch tab"]]
            : []),
          ...(options.search ? [["/", "Search"]] : []),
          ["1–9", "Pick the row's option"],
        ]) as [string, string][]),
    [prefs.vim ? "←→ / h l" : "←→", `Adjust value (⇧ ×${prefs.bigStep})`],
    ["⌥ drag", "Fine adjust"],
    ...(bound("presets") ? [[show("presets"), "Cycle presets"]] : []),
    ...(bound("hint") ? [[show("hint"), "Jump to anything by code"]] : []),
    ...(prefs.edit ? [[page ? "Enter" : "0–9 / Enter", "Edit number inline"]] : []),
    ...(bound("reset") ? [[keyLabel(keys.reset[0]!), "Reset row · delete saved preset"]] : []),
    // What R, ⇧R and ⌥R act on follows focus; these read it when the popover shows.
    ...(bound("random") && bound("resetAll")
      ? [[`${show("random")} / ${show("resetAll")}`, SCOPED.both]]
      : bound("random")
        ? [[show("random"), SCOPED.random]]
        : bound("resetAll")
          ? [[show("resetAll"), SCOPED.reset]]
          : []),
    ...(bound("mutate") ? [[show("mutate", true), SCOPED.mutate]] : []),
    ...(bound("group") && (bound("random") || bound("mutate"))
      ? [[`${show("group")} / ${show("group", true)}`, "Random / Mutate group"]]
      : []),
    ...(bound("lock") ? [[show("lock"), "Lock from Random"]] : []),
    ["⇧ click / ⇧↑↓", "Select rows (⌘ adds)"],
    ...(bound("menu") ? [["⇧F10", "Row menu"]] : []),
    ...(bound("compare") ? [[`hold ${show("compare")}`, "Compare with before"]] : []),
    ...(bound("copy") ? [[show("copy"), "Copy values"]] : []),
    ...(showVariants && bound("save") ? [[show("save"), "Save and name a preset"]] : []),
    ...(pair("undo", "redo", "Undo / Redo") as [string, string][]),
    ...(bound("undo") && !bound("redo") ? [[show("undo"), "Undo"]] : []),
    ...(close
      ? [["Esc", "Up a level: row, card, panel, close"]]
      : page || (inline && keys.leave.includes("Escape"))
        ? [["Esc", "Up a level: row, card, panel, out"]]
        : inline && bound("leave")
          ? [
              ["Esc", "Up a level: row, card, panel"],
              [show("leave"), "Leave the panel"],
            ]
          : []),
  ] as [string, string][]) {
    const span = el("span", desc)
    popGrid.append(el("kbd", k), span)
    if (Object.values(SCOPED).includes(desc)) scopedDescs.push([span, desc])
  }
  popover.append(popGrid)
  /**
   * The active preset over what a command at `scope` acts on: the group's own preset for a row or
   * card in a group that has one, else the panel's. Its name, and whether those keys are off it.
   */
  const baseAt = (scope: CommandScope, from: Node | null) => {
    const group =
      scope === "row"
        ? rows[rowAt(from)]?.group
        : scope === "group"
          ? (cardOf(from)?.dataset.group ?? undefined)
          : undefined
    const keys =
      scope === "row"
        ? (rows[rowAt(from)]?.keys ?? [])
        : scope === "group"
          ? cardKeys(cardOf(from)!)
          : scope === "selection"
            ? (selectionKeys() ?? [])
            : undefined
    const index = group === undefined ? -1 : controls.activeGroupPreset(group)
    const ref = controls.activePreset()
    const name =
      index >= 0
        ? controls.groupPresets[group!]?.[index]?.name
        : ref?.kind === "preset"
          ? presetLabel(ref.id)
          : ref
            ? presetStrip.getEntries().find((e) => e.id === `v:${ref.id}`)?.label
            : undefined
    if (!name) return null
    const off = keys
      ? keys.some((k) => controls.isModified(k as keyof S & string))
      : controls.isModified()
    return { name, off }
  }
  /** Rewrites the popover's R, ⇧R and ⌥R lines for where focus is (or was, before it opened). */
  const describeScope = (from: Node | null = doc.activeElement) => {
    const scope = scopeAt(from)
    // With an active preset, Random explores around it and Reset goes back to it first.
    const base = baseAt(scope, from)
    const lead = (verb: string) => (scope === "all" ? verb : scopeLabel(verb, scope))
    const random = base ? `${lead("Random")} around ${base.name}` : scopeLabel("Random", scope)
    const reset = !base
      ? scopeLabel("Reset", scope)
      : base.off
        ? `${scope === "all" ? "Back" : `${scopeLabel("Reset", scope)} back`} to ${base.name}`
        : `${scopeLabel("Reset", scope)} to defaults`
    for (const [span, which] of scopedDescs) {
      const text =
        which === SCOPED.both
          ? `${random} / ${reset}`
          : which === SCOPED.random
            ? random
            : which === SCOPED.reset
              ? reset
              : `${scopeLabel("Mutate", scope)}: small changes`
      if (span.textContent !== text) span.textContent = text
    }
  }

  let positioned: { constrain(): void; dispose(): void } | undefined
  let helpButton: HTMLButtonElement | undefined
  const togglePopover = (open?: boolean) => {
    const next = open ?? (popover.hidden || popover.dataset.leaving === "true")
    if (next) describeScope()
    reveal(popover, next)
    helpButton?.setAttribute("aria-expanded", String(next))
    positioned?.constrain()
    wakeGpu()
  }

  const copyValues = () => void copy(options.copy ? options.copy() : controls.code())
  // Random, Reset and Copy are reachable from hint mode; history, help and close have keys.
  const command = (icon: IconName, label: string, shortcut: string, action: () => unknown) => {
    const node = headButton(icon, label, shortcut, action)
    node.classList.add("knobs-head-cmd")
    return node
  }
  // Random rolls a die in place of the dice icon (see die.ts).
  const die = createHeaderDie(doc, () => wakeGpu())
  // Random re-rolls, Mutate (⌥) nudges; both skip locked fields and roll `roller` only when
  // something can change. A selection narrows `r` and ⌥R to its rows.
  const reroll = (keys: readonly string[] | undefined, nudge: boolean, roller: HeaderDie = die) => {
    const pool = (keys ?? rows.flatMap((r) => r.keys)).filter((k) =>
      controls.canRoll(k as keyof S & string),
    ) as (keyof S & string)[]
    if (pool.length === 0) return
    roller.roll(nudge)
    if (nudge) controls.mutate(keys ? pool : undefined)
    else controls.randomize(keys ? pool : undefined)
  }
  const randomButton = command("random", "Random", "r", () => {})
  randomButton.setAttribute(
    "aria-keyshortcuts",
    [...keys.random, ...keys.mutate.map((k) => `Alt+${k}`)].join(" "),
  )
  if ((!bound("random") && !bound("mutate")) || !shows("random")) randomButton.hidden = true
  randomButton.onclick = (event) => run(() => reroll(undefined, event.altKey))
  randomButton.querySelector(".knobs-icon")?.replaceWith(die.node)
  // Resetting everything turns the header's ↺ once (spin.ts), from the button or ⇧R alike. It
  // stays while it turns, so another press adds a turn, and leaves once it has stopped.
  const resetAll = () => {
    if (!resetBtn.hidden && resetBtn.dataset.shown === "true" && !header.hidden)
      spin(resetBtn, wakeGpu, syncResets)
    cue(root, "reset")
    controls.reset()
  }
  const resetBtn = command("reset", "Reset", ariaKeys(keys.resetAll), resetAll)
  if (!bound("resetAll") || !marks || !shows("reset")) resetBtn.hidden = true
  bloom(resetBtn, false)
  const copyButton = command("copy", "Copy", ariaKeys(keys.copy), copyValues)
  if (!bound("copy") || !shows("copy")) copyButton.hidden = true
  copyButton.classList.add("knobs-copy")
  // Copying turns the glyph into a check that draws itself, held a moment (see .knobs-copied).
  const check = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  check.setAttribute("viewBox", "0 0 256 256")
  check.setAttribute("aria-hidden", "true")
  check.setAttribute("class", "knobs-icon knobs-check")
  const checkPath = doc.createElementNS("http://www.w3.org/2000/svg", "path")
  checkPath.setAttribute("d", CHECK_PATH)
  checkPath.setAttribute("pathLength", "1")
  check.append(checkPath)
  copyButton.append(check)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  const copied = () => {
    clearTimeout(copiedTimer)
    copyButton.dataset.copied = ""
    cue(root, "copy")
    announce("Copied")
    copiedTimer = setTimeout(() => {
      delete copyButton.dataset.copied
      wakeGpu()
    }, COPIED_MS)
  }
  const undo = () => {
    if (controls.canUndo) cue(root, "undo")
    controls.undo()
  }
  const redo = () => {
    if (controls.canRedo) cue(root, "redo")
    controls.redo()
  }
  const undoButton = iconButton("undo", "Undo", ariaKeys(keys.undo), undo)
  const redoButton = iconButton("redo", "Redo", ariaKeys(keys.redo), redo)
  // Undo shows while there's history and Redo while there's a future, each in its own slot.
  const history = el("span")
  history.className = "knobs-head-history"
  bloom(undoButton, false)
  bloom(redoButton, false)
  if (showHistory && (bound("undo") || bound("redo"))) {
    place(undoButton, "undo")
    place(redoButton, "redo")
    history.append(undoButton, redoButton)
    headActions.append(history)
    if (!bound("undo") || !shows("undo")) undoButton.hidden = true
    if (!bound("redo") || !shows("redo")) redoButton.hidden = true
    if (undoButton.hidden && redoButton.hidden) history.hidden = true
  }
  if (showFooter && bound("help")) {
    helpButton = headButton("help", "Keyboard shortcuts", "?", () => togglePopover())
    helpButton.setAttribute("aria-expanded", "false")
    helpButton.classList.add("knobs-head-split")
    if (!shows("help")) helpButton.hidden = true
  }
  const dismiss = close ? headButton("close", `Close ${controls.id}`, "", close) : undefined
  dismiss?.classList.add("knobs-close")
  if (dismiss && (!helpButton || helpButton.hidden)) dismiss.classList.add("knobs-head-split")
  if (dismiss && !shows("close")) dismiss.hidden = true
  // Fixed slots, left to right: Undo · Redo, Reset, Copy, then Random in the corner (and ? · ✕
  // past it). Undo, Redo and Reset come and go in place (bloom), so nothing else ever moves.
  for (const node of [history, resetBtn, copyButton, randomButton, helpButton, dismiss])
    if (node && (node !== history || history.parentNode)) headActions.append(node)
  const titleEl = el(
    "strong",
    titleText && headerOptions?.title !== false ? readableTitle(titleText) : "",
  )
  // Without the ? button, the title's tooltip keeps the shortcuts discoverable.
  if (helpButton?.hidden)
    titleEl.title = `${titleEl.textContent ? `${titleEl.textContent}\n` : ""}Press ${show("help")} for keyboard shortcuts`
  const presetLabel = (id: string) =>
    options.presetLabels?.[id] ??
    (id === "default" ? options.defaultLabel : undefined) ??
    controls.presetLabel(id)
  const presetStrip = createPresetStrip(
    doc,
    controls,
    showVariants,
    run,
    () => wakeGpu(),
    presetLabel,
  )
  // Tabs: a strip under the header once any field names one (or `tabs` lists some). A panel
  // remembers the one it showed, for the next mount and (with `session`) a reload.
  const tabStrip = createTabStrip(doc, (id) => selectTab(id))
  let activeTab: string | undefined
  // Search: a field that filters rows as you type, with chips that narrow them further.
  const searchOptions = typeof options.search === "object" ? options.search : {}
  const chipTests = new Map<string, (key: string) => boolean>()
  const search: SearchBar | undefined =
    options.search && !page
      ? createSearch(doc, {
          placeholder: searchOptions.placeholder ?? "Search",
          chips: (searchOptions.chips ?? ["modified"]).map((chip) => {
            if (chip === "modified") {
              chipTests.set("modified", (k) => controls.isModified(k as keyof S & string))
              return { id: "modified", label: "Modified", count: true }
            }
            chipTests.set(chip.id, (k) => chip.test(k, controls))
            return { id: chip.id, label: chip.label, count: Boolean(chip.count) }
          }),
          change: () => applyVisibility("reveal"),
        })
      : undefined
  // A page's header is one sticky bar: title, then the presets, then the tools.
  const tools = el("div")
  tools.className = "knobs-page-tools"
  const filterEl = el("input")
  if (page) {
    if (page.filter !== false) {
      filterEl.type = "search"
      filterEl.className = "knobs-filter"
      filterEl.placeholder = "Filter"
      filterEl.spellcheck = false
      filterEl.setAttribute("aria-label", "Filter rows")
      filterEl.setAttribute("aria-keyshortcuts", "/")
      filterEl.tabIndex = -1
      tools.append(filterEl)
    }
    tools.append(headActions)
    header.append(titleEl, presetStrip.element, tools)
  } else header.append(titleEl, headActions)
  if (options.header === false && !page) header.hidden = true
  const allActions: readonly ControlAction<Values<S>>[] = [
    ...(controls.actions ?? []),
    ...((options.actions as readonly ControlAction<Values<S>>[]) ?? []),
  ]
  const body = el("div")
  // Rows share one inset-grouped card per group (and per run of ungrouped rows): a block. A
  // descriptor swap (`RemoteControls.update`) keeps blocks and rows whose keys persist.
  interface Block {
    group: string | undefined
    head?: HTMLElement
    card: HTMLElement
    gpuGroup?: GpuGroupBinding
    leaving?: boolean
  }
  const blocks: Block[] = []
  const cards: HTMLElement[] = []
  const groupResetButtons = new Map<string, HTMLButtonElement>()
  const groupDice = new Map<string, { button: HTMLButtonElement; die: HeaderDie }>()
  const gpuGroups: GpuGroupBinding[] = []
  const gpuRows: GpuRowBinding[] = []
  // A page gives each group its own card (a tile) in its section's columns.
  let layout: PageLayout | undefined
  let layoutTick = 0
  /** What folded or opened something since `onSections` listeners last heard (a user's wins). */
  let foldSource: PageFoldSource | null = null
  /** Set while a click or key of the user's folds or opens something. */
  let userFolding = false
  const noteFold = (source: PageFoldSource) => {
    if (foldSource !== "user") foldSource = source
  }
  /** Runs `act` as the user's own fold. */
  const byUser = (act: () => void) => {
    userFolding = true
    try {
      act()
    } finally {
      userFolding = false
    }
  }
  /** Set once the page is built: its motion settling then tells `onSections` listeners. */
  let built = false
  const tiles = new Map<string, HTMLElement>()
  const gpuTiles: HTMLElement[] = []
  if (page) {
    body.className = "knobs-sections"
    layout = createPageLayout(doc, body, {
      order: page.sections ?? [],
      columnWidth: page.columnWidth ?? 300,
      sectionLabel: (name) => sectionTitle(name),
      sectionDescription: (name) =>
        options.sectionDescriptions?.[name] ?? controls.sectionDescription(name),
      sectionFold: (name) => sectionStart(name),
      onLayout: () => {
        layoutTick++
        syncNav()
        // Rows follow the page: down each column, then on to the next.
        rows.sort((a, b) =>
          a.row.compareDocumentPosition(b.row) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        )
        clearSelection()
        wakeGpu()
      },
      wake: () => {
        layoutTick++
        wakeGpu()
        // Cards that finished folding away take their section with them; ones arriving bring it
        // back.
        if (built) announceSections()
      },
    })
  }
  const tileFor = (group: string | undefined, section?: string) => {
    const id = group ?? `\u0000${section ?? ""}`
    const known = tiles.get(id)
    if (known) return known
    const tile = el("div")
    tile.className = "knobs-tile"
    // A card takes focus (a click on its empty area or heading, Esc from a row), for R and ⇧R.
    tile.tabIndex = -1
    tile.setAttribute("role", "group")
    if (group) {
      tile.dataset.group = group
      tile.setAttribute("aria-label", groupTitle(group, section))
      tile.append(groupHead(group, section))
      const desc = groupDescs.get(group)
      if (desc) tile.append(desc)
    }
    const inner = el("div")
    inner.className = "knobs-card"
    tile.append(inner)
    if (group !== undefined && folds.has(group)) {
      tile.dataset.foldable = ""
      inner.dataset.drift = ""
      inner.hidden = folds.get(group)!
      tile.toggleAttribute("data-folded", folds.get(group)!)
    }
    cards.push(inner)
    gpuTiles.push(tile)
    layout!.add(tile, section ?? "")
    tiles.set(id, inner)
    return inner
  }
  const newBlock = (group: string | undefined): Block => {
    const card = el("div")
    card.className = "knobs-card"
    if (group) card.dataset.group = group
    // A card takes focus (a click on its empty area or heading, Esc from a row), for R and ⇧R.
    card.tabIndex = -1
    card.setAttribute("role", "group")
    if (group) card.setAttribute("aria-label", groupTitle(group))
    const block: Block = { group, card }
    if (group) {
      block.head = groupHead(group)
      block.gpuGroup = gpuGroups.at(-1)
      // A click on a heading that doesn't fold focuses its card.
      const head = block.head
      head.addEventListener("click", (event) => {
        if (head.hasAttribute("data-foldable") || (event.target as Element).closest("button"))
          return
        card.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
      })
    }
    cards.push(card)
    return block
  }

  /** A section's heading: its label, else its id. */
  const sectionTitle = (section: string) =>
    options.sectionLabels?.[section] ?? controls.sectionLabel(section) ?? section
  /** The muted line under a page card's title, if it has one. */
  const groupDescription = (group: string) =>
    options.groupDescriptions?.[group] ?? controls.groupDescription(group)
  const sectionDescription = (section: string) =>
    options.sectionDescriptions?.[section] ?? controls.sectionDescription(section)
  /** Each page card's description line (hidden while it has none). */
  const groupDescs = new Map<string, HTMLElement>()
  /** Each foldable page card's summary, shown in its header while it's folded. */
  const groupSummaries = new Map<string, HTMLElement>()
  const describeGroup = (group: string) => {
    const node = groupDescs.get(group)
    if (!node) return
    const text = groupDescription(group) ?? ""
    if (node.textContent !== text) {
      node.textContent = text
      node.title = text
    }
    if (node.hidden !== !text) node.hidden = !text
  }
  /**
   * A group's title: its label, verbatim; else on a page its id without the section's name
   * repeated in front ("Transcript · Arrivals" under Transcript reads "Arrivals").
   */
  const groupTitle = (group: string, section?: string) =>
    options.groupLabels?.[group] ??
    controls.groupLabel(group) ??
    (page && section ? cardTitle(group, [section, sectionTitle(section)]) : group)
  const presetDisplay: GroupPresetDisplay =
    options.groupPresetDisplay ?? controls.groupPresetDisplay

  /** Each foldable group's state: folded or open. */
  const folds = new Map<string, boolean>()
  const foldMotions = new Map<HTMLElement, ReturnType<typeof setTimeout>>()
  /**
   * What a highlight's `expand` opened (sections, groups, custom cards), to fold again when the
   * highlight moves on; whatever the user works in meanwhile is dropped from here (it's theirs).
   */
  const auto = {
    sections: new Set<string>(),
    groups: new Set<string>(),
    cards: new Set<CustomCardFold>(),
  }
  /** Nodes folding open or shut right now (the GPU follows their reveal). */
  const shifting = new Set<HTMLElement>()
  /**
   * How a group starts: `groupFolded` (the mount's, then the store's), else its first field that
   * says; undefined: it doesn't fold.
   */
  const foldDefault = (group: string): boolean | undefined => {
    const given = options.groupFolded?.[group] ?? controls.groupFolded?.[group]
    if (given !== undefined) return given
    for (const f of Object.values(controls.schema as Record<string, Field>))
      if (f.group === group && f.folded !== undefined) return f.folded
    return undefined
  }
  /**
   * How a page's section starts: what the user last chose, else `sectionFolded` (the mount's,
   * then the store's), else its first field that says; undefined: it doesn't fold.
   */
  const sectionStart = (section: string): boolean | undefined => {
    const pick = (v: SectionFolded | undefined) =>
      v === undefined ? undefined : typeof v === "boolean" ? v : v[section]
    let given = pick(page?.sectionFolded) ?? pick(controls.sectionFolded)
    if (given === undefined)
      for (const f of Object.values(controls.schema as Record<string, Field>))
        if (f.section === section && f.sectionFolded !== undefined) {
          given = f.sectionFolded
          break
        }
    if (given === undefined) return undefined
    return foldsKept?.get("sections", section) ?? given
  }
  /**
   * Folds or opens a foldable group's card (toggles without `next`). `remember: false` leaves
   * what's remembered alone (a highlight opened or closed it).
   */
  function fold(group: string, next = !folds.get(group), animate = true, remember = true) {
    if (!folds.has(group)) return
    if (userFolding && folds.get(group) !== next) cue(root, next ? "close" : "open")
    if (page && folds.get(group) !== next) noteFold(userFolding ? "user" : "code")
    if (remember) auto.groups.delete(group)
    if (folds.get(group) === next && page) return
    folds.set(group, next)
    const block = blocks.find((b) => b.group === group && !b.leaving)
    const card = page ? tiles.get(group) : block?.card
    if (!card) return
    const head = page
      ? card.parentElement!.querySelector<HTMLElement>(":scope > .knobs-group-head")
      : block!.head
    head?.setAttribute("aria-expanded", String(!next))
    // Focus inside a card folding away stays with the group, on its header.
    if (next && card.contains(doc.activeElement))
      head?.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    // A page's tile folds to its header; the cards below in its column follow.
    if (page) foldTile(card, next && !filterEl.value.trim(), animate)
    else applyVisibility(animate ? "reveal" : "instant")
    if (page) {
      const tile = card.parentElement!
      tile.toggleAttribute("data-folded", next)
      // The header's controls and its summary trade places with a fade (see styles).
      if (animate) {
        tile.setAttribute("data-fold-motion", "")
        clearTimeout(foldMotions.get(tile))
        foldMotions.set(
          tile,
          setTimeout(() => tile.removeAttribute("data-fold-motion"), 400),
        )
      }
      if (remember) foldsKept?.set("groups", group, next)
      refreshFolds()
    } else if (sessionKept)
      writeSession(controls.id, { groups: { ...readSession(controls.id).groups, [group]: next } })
    positioned?.constrain()
    wakeGpu()
  }
  function foldTile(card: HTMLElement, shut: boolean, animate: boolean) {
    const showing = !card.hidden && card.dataset.leaving !== "true"
    if (showing !== shut) return
    if (animate || shifting.has(card)) shift(card, !shut, 0)
    else card.hidden = shut
  }
  const caretSvg = () => caretIcon(doc)
  function groupHead(groupName: string, section?: string) {
    const title = groupTitle(groupName, section)
    const gHead = el("div")
    gHead.className = "knobs-group-head"
    gHead.dataset.group = groupName
    const gLabel = el("span", title)
    gLabel.className = "knobs-group-label"
    const gRight = el("span")
    const gBtns: HTMLButtonElement[] = []
    for (const act of allActions.filter((a) => a.group === groupName)) {
      const b = button(act.label, () => {
        cue(root, "press")
        return act.run(controls.get(), controls)
      })
      gBtns.push(b)
      gRight.append(b)
    }
    // Shown only while something in the group differs from its defaults.
    const gReset = iconButton("reset", `Reset ${title}`, "", () => {
      spin(gReset, wakeGpu, syncResets)
      cue(root, "reset")
      controls.resetGroup(groupName)
      if (doc.activeElement === gReset)
        rows.find((r) => r.group === groupName)?.input.focus({ preventScroll: true })
    })
    gReset.className = "knobs-group-reset"
    gReset.dataset.hint = `${title} reset`
    bloom(gReset, false)
    groupResetButtons.set(groupName, gReset)
    // The group's own die: Random for just these rows (⌥ mutates them).
    const gDie = createHeaderDie(doc, () => wakeGpu(), GROUP_DIE)
    const gRandom = iconButton("random", `Randomize ${title}`, "g Alt+g", () => {})
    gRandom.className = "knobs-group-die"
    gRandom.dataset.hint = `${title} random`
    gRandom.querySelector(".knobs-icon")?.replaceWith(gDie.node)
    gRandom.onclick = (event) => run(() => rerollGroup(groupName, event.altKey))
    // A group of readouts alone has nothing to roll.
    const rollable = (Object.values(controls.schema) as Field[]).some(
      (f) => f.group === groupName && hasValue(f),
    )
    if ((!bound("random") && !bound("mutate")) || !rollable) gRandom.hidden = true
    groupDice.set(groupName, { button: gRandom, die: gDie })
    // On a page, the group's presets sit in its header: their names as segments while they fit
    // beside the title, else a compact menu (or numbered chips, whose hovered name shows where
    // the title is). 1–9 apply them whichever way they show.
    const presets = page ? (controls.groupPresets[groupName] ?? []).slice(0, 9) : []
    let ui: GroupPresetUi | undefined
    const gPeek = el("span")
    gPeek.className = "knobs-peek"
    gPeek.setAttribute("aria-hidden", "true")
    if (presets.length && presetDisplay === "numbers") {
      const seg = el("div")
      seg.className = "knobs-seg knobs-chips"
      seg.setAttribute("role", "radiogroup")
      seg.setAttribute("aria-label", `${title} presets`)
      const pill = el("span")
      pill.className = "knobs-seg-pill"
      pill.setAttribute("aria-hidden", "true")
      smearPill(pill, 6)
      seg.append(pill)
      const buttons = presets.map((preset, i) => {
        const b = el("button", String(i + 1))
        b.type = "button"
        b.tabIndex = -1
        b.dataset.value = String(i)
        b.setAttribute("role", "radio")
        b.setAttribute("aria-label", `${i + 1} ${preset.name}`)
        b.setAttribute("aria-keyshortcuts", String(i + 1))
        b.onclick = () => run(() => applyGroupPreset(groupName, i))
        b.onpointerenter = () => peek(groupName, preset.name)
        b.onpointerleave = () => peek(groupName, null)
        seg.append(b)
        return b
      })
      const ro = new ResizeObserver(() =>
        placeSegPill(seg, buttons, String(controls.matchingGroupPreset(groupName)), true),
      )
      ro.observe(seg)
      ui = {
        head: gHead,
        seg,
        buttons,
        pill: new Edges(),
        numbers: true,
        show: (value) => placeSegPill(seg, buttons, value),
        dispose: () => ro.disconnect(),
      }
      gRight.append(seg)
    } else if (presets.length) {
      const wrap = el("span")
      wrap.className = "knobs-group-presets"
      gRight.append(wrap)
      // The title wins the room: names show only where they fit beside all of it.
      const room = () => {
        const cs = getComputedStyle(gHead)
        const inner =
          gHead.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
        const range = doc.createRange()
        range.selectNodeContents(gLabel)
        const titleW = range.getBoundingClientRect().width
        const others = gRight.getBoundingClientRect().width - wrap.getBoundingClientRect().width
        const gap = parseFloat(cs.columnGap) || 0
        return inner - titleW - others - gap * 2
      }
      const control = createChoice(doc, wrap, {
        label: `${title} presets`,
        items: presets.map((p, i) => ({ value: String(i), label: p.name })),
        display:
          presetDisplay === "menu" ? "menu" : presetDisplay === "names" ? "segmented" : "auto",
        compact: 9,
        numbered: true,
        none: "Custom",
        value: () => String(controls.matchingGroupPreset(groupName)),
        choose: (value, coalesce) =>
          run(() => applyGroupPreset(groupName, Number(value), coalesce)),
        wake: () => wakeGpu(),
        observe: gHead,
        room,
      })
      control.seg.tabIndex = -1
      control.menu.tabIndex = -1
      control.buttons.forEach((b, i) => {
        b.setAttribute("aria-label", `${i + 1} ${presets[i]!.name}`)
        b.setAttribute("aria-keyshortcuts", String(i + 1))
      })
      control.show(String(controls.matchingGroupPreset(groupName)), true)
      ui = {
        head: gHead,
        seg: control.seg,
        buttons: control.buttons,
        pill: new Edges(),
        menu: control.menu,
        menuValue: control.menuValue,
        isMenu: control.isMenu,
        show: (value) => control.show(value),
        dispose: control.dispose,
      }
    }
    if (ui) groupChips.set(groupName, ui)
    gRight.append(gReset, gRandom)
    // A panel's group folds when it says how it starts (`folded`, `groupFolded`).
    const foldAt = foldDefault(groupName)
    let caret: SVGSVGElement | undefined
    // On a page, a folded card's header trades its controls for a summary of the card.
    let ctl: HTMLElement | undefined
    let summary: HTMLElement | undefined
    if (page) {
      ctl = el("span")
      ctl.className = "knobs-group-ctl"
      ctl.append(...gRight.childNodes)
      gRight.append(ctl)
      const desc = el("div")
      desc.className = "knobs-group-desc"
      groupDescs.set(groupName, desc)
      describeGroup(groupName)
    }
    if (foldAt !== undefined) {
      if (page) {
        summary = el("span")
        summary.className = "knobs-group-summary"
        gRight.append(summary)
        groupSummaries.set(groupName, summary)
      }
      caret = caretSvg()
      gRight.append(caret)
      gHead.dataset.foldable = ""
      gHead.tabIndex = -1
      gHead.setAttribute("role", "button")
      gHead.setAttribute("aria-label", title)
      const folded =
        (page ? foldsKept?.get("groups", groupName) : session.groups?.[groupName]) ?? foldAt
      folds.set(groupName, folded)
      gHead.setAttribute("aria-expanded", String(!folded))
      gHead.addEventListener("click", (event) => {
        if ((event.target as Element).closest("button")) return
        byUser(() => fold(groupName))
      })
    }
    if (page) {
      const gTitle = el("span")
      gTitle.className = "knobs-group-title"
      gTitle.append(gLabel, gPeek)
      gHead.append(gTitle, gRight)
    } else gHead.append(gLabel, gRight)
    gpuGroups.push({
      element: gHead,
      labelEl: gLabel,
      buttons: gBtns,
      reset: gReset,
      die: { button: gRandom, die: gDie },
      ...(caret ? { fold: caret } : {}),
      ...(page ? { title: true, peek: gPeek } : {}),
      ...(ctl ? { controls: ctl } : {}),
      ...(summary ? { summary } : {}),
      ...(groupDescs.get(groupName) ? { desc: groupDescs.get(groupName)! } : {}),
      ...(ui
        ? {
            presets: {
              seg: ui.seg,
              buttons: ui.buttons,
              pill: ui.pill,
              ...(ui.menu ? { menu: ui.menu, menuValue: ui.menuValue!, isMenu: ui.isMenu! } : {}),
            },
          }
        : {}),
    })
    return gHead
  }
  interface GroupPresetUi {
    head: HTMLElement
    seg: HTMLElement
    buttons: readonly HTMLButtonElement[]
    pill: Edges
    /** Numbered chips (`groupPresetDisplay: "numbers"`): a hovered one peeks its name. */
    numbers?: boolean
    menu?: HTMLButtonElement
    menuValue?: HTMLElement
    isMenu?: () => boolean
    show(value: string): void
    dispose(): void
  }
  const groupChips = new Map<string, GroupPresetUi>()
  const peekTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Shows a preset's name in place of its group's title (null brings the title back). */
  const peek = (group: string, name: string | null, linger = 0) => {
    const ui = groupChips.get(group)
    if (!ui?.numbers) return
    const head = ui.head
    clearTimeout(peekTimers.get(group))
    const label = head.querySelector<HTMLElement>(".knobs-peek")!
    if (name !== null) {
      label.textContent = name
      head.dataset.peek = ""
    } else delete head.dataset.peek
    if (name !== null && linger)
      peekTimers.set(
        group,
        setTimeout(() => peek(group, null), linger),
      )
    wakeGpu()
  }
  const applyGroupPreset = (group: string, index: number, coalesce = false) => {
    const preset = controls.groupPresets[group]?.[index]
    if (!preset) return
    cue(root, coalesce ? "select" : "preset")
    controls.groupPreset(group, index, { coalesce })
    // Names that show already say which one it is.
    peek(group, preset.name, 1100)
  }

  // A reload (Vite's included) brings back open editors, folded groups and the focused stop,
  // per tab, unless the host keeps focus to itself (`session: false`).
  const remember = options.session ?? controls.storage !== null
  const sessionKept = remember
  const session = remember ? readSession(controls.id) : {}
  /**
   * A page's section and group folds: in `foldStorage` when given (folds only, whatever the store
   * keeps), else in the store's storage unless it persists nothing.
   */
  const foldPort =
    page?.foldStorage !== undefined
      ? page.foldStorage
      : controls.persist === "none"
        ? null
        : controls.storage
  const foldsKept: FoldMemory | null =
    page && foldPort ? foldMemory(controls.id, () => foldPort) : null

  // Every slider's track (knob rows and the parts of compound rows), for arrows and typed digits.
  const tracks = new Map<HTMLElement, SubTrack>()
  /** Toolbar rows by key, for their shortcuts. */
  const toolbars = new Map<string, ToolbarRow>()
  /** Action rows with a shortcut (declared, or able to take one), by key. */
  const keyedActions = new Map<string, { row: Row; button: HTMLButtonElement }>()
  /** Where an action's shortcut works now: the store's rebinding, else its own. */
  const actionKey = (key: string, field: ActionField) => {
    const combo = controls.shortcut(key as keyof S & string)
    return combo ? { key: combo, scope: actionShortcut(field)?.scope ?? "panel" } : undefined
  }
  /** Readout rows by key, told when the store pushes to them. */
  const readouts = new Map<string, ReadoutRow>()
  const readoutPort = (controls as unknown as { [READOUT]?: ReadoutPort })[READOUT]
  interface Row {
    /** The row's identity: its key, or `spring:<id>` for a flat spring's pair of keys. */
    id: string
    /** The value keys it shows (two for a flat spring, none for an action). */
    keys: string[]
    key: string
    display: string
    field: Field
    /** What must match for a descriptor swap to keep this row's DOM. */
    shape: string
    group: string | undefined
    section: string | undefined
    wave: { at: number; until: number }
    row: HTMLElement
    labelEl: HTMLElement
    input: HTMLElement
    number?: HTMLInputElement
    slider?: Slider
    buttons?: HTMLButtonElement[]
    editor?: EditorRow
    choice?: ChoiceControl
    /** Lets go of observers and open menus when the row leaves. */
    dispose?(): void
    gpu: GpuRowBinding[]
    /** This row's value, from the store's values (a flat spring composes its two keys). */
    value(values: Record<string, unknown>): unknown
    set(value: unknown, options?: { coalesce?: boolean }): void
    /** Takes a compatible field change in place (a new range, label or unit). */
    retune(spec: RowSpec): void
    /** Set while it plays its exit, before it leaves the DOM. */
    leaving?: boolean
    /** The row accessory's slot (`rowAccessory`). */
    accessory?: HTMLElement
    /** Shown as mixed ("—") at the last update. */
    mixed?: boolean
    /** The sub-heading it sits under (a `subhead` id). */
    subhead?: string
    /** Catches up with what isn't a value (a rebound shortcut), on every store change. */
    refresh?(): void
  }
  interface RowSpec {
    id: string
    keys: string[]
    field: Field
    parts?: { duration: Knob; bounce: Knob }
    group: string | undefined
    section: string | undefined
  }
  /** A schema as rows: a flat spring's two halves become one row, at the first half's place. */
  const planRows = (schema: Schema): RowSpec[] => {
    const entries = Object.entries(schema as Record<string, Field>)
    const halves = new Map<string, { duration?: [string, Knob]; bounce?: [string, Knob] }>()
    for (const [key, field] of entries)
      if (field.kind === "knob" && field.spring) {
        const pair = halves.get(field.spring.id) ?? {}
        pair[field.spring.part] = [key, field]
        halves.set(field.spring.id, pair)
      }
    const specs: RowSpec[] = []
    const placed = new Set<string>()
    for (const [key, field] of entries) {
      const pair = field.kind === "knob" && field.spring ? halves.get(field.spring.id) : undefined
      if (pair?.duration && pair.bounce && field.kind === "knob" && field.spring) {
        if (placed.has(field.spring.id)) continue
        placed.add(field.spring.id)
        const [dk, duration] = pair.duration
        const [bk, bounce] = pair.bounce
        const label = duration.spring?.label ?? field.spring.label ?? duration.label ?? dk
        specs.push({
          id: `spring:${field.spring.id}`,
          keys: [dk, bk],
          field: {
            kind: "spring",
            value: { duration: duration.value, bounce: bounce.value },
            label,
            ...(duration.group !== undefined ? { group: duration.group } : {}),
            ...(duration.section !== undefined ? { section: duration.section } : {}),
            ...(duration.shortcut !== undefined ? { shortcut: duration.shortcut } : {}),
          },
          parts: { duration, bounce },
          group: duration.group,
          section: duration.section,
        })
        continue
      }
      specs.push({
        id: key,
        keys: hasValue(field) ? [key] : [],
        field,
        group: field.group,
        section: field.section,
      })
    }
    return gatherSubsections(specs)
  }
  /**
   * Within each run of a group's rows, rows without a sub-heading come first, then each
   * sub-heading's rows together (in the order the sub-headings first appear), so a heading never
   * splits in two.
   */
  const gatherSubsections = (specs: RowSpec[]): RowSpec[] => {
    const out: RowSpec[] = []
    for (let i = 0; i < specs.length; ) {
      let end = i
      while (end < specs.length && specs[end]!.group === specs[i]!.group) end++
      const loose: RowSpec[] = []
      const subs = new Map<string, RowSpec[]>()
      for (const spec of specs.slice(i, end)) {
        const name = spec.field.subsection
        if (name === undefined) loose.push(spec)
        else subs.set(name, [...(subs.get(name) ?? []), spec])
      }
      out.push(...loose, ...[...subs.values()].flat())
      i = end
    }
    return out
  }
  const shapeOf = (spec: RowSpec) => {
    const f = spec.field
    const where = `${spec.group ?? ""}\u0000${page ? (spec.section ?? "") : ""}`
    if (spec.parts) return `pair\u0000${spec.keys.join("\u0000")}\u0000${where}`
    if (f.kind === "action")
      return `action\u0000${f.shortcut ? 1 : 0}\u0000${f.rebind ? 1 : 0}\u0000${where}`
    if (f.kind === "knob" || f.kind === "toggle" || f.kind === "toolbar" || isReadout(f))
      return `${f.kind}\u0000${where}`
    if (f.kind === "vec")
      return `vec\u0000${f.axes}\u0000${f.axisLabels?.join(",") ?? ""}\u0000${f.link ? 1 : 0}\u0000${where}`
    if (f.kind === "range" || f.kind === "angle" || f.kind === "seed" || f.kind === "keybind")
      return `${f.kind}\u0000${where}`
    if (f.kind === "choice")
      return `choice\u0000${f.display ?? "auto"}\u0000${f.options.join("\u0000")}\u0000${where}`
    const { label: _l, shortcut: _s, ...rest } = f
    return `${f.kind}\u0000${JSON.stringify(rest)}\u0000${where}`
  }
  const choiceLabel = (field: Choice, value: string) => field.labels?.[value] ?? value

  function buildRow(spec: RowSpec): Row {
    const { id: key, field } = spec
    // When this row's current motion starts and roughly ends, for the preset cascade.
    const wave = { at: 0, until: 0 }
    const display = field.label ?? (spec.parts ? key.slice(7) : key)
    const base = {
      id: spec.id,
      keys: spec.keys,
      key,
      display,
      field,
      shape: shapeOf(spec),
      group: spec.group,
      section: spec.section,
      wave,
    }
    const set = (value: unknown, setOpts?: { coalesce?: boolean }) => {
      const before = controls.get()[key]
      if (!same(before, value)) changed(root, key, field, before, value)
      controls.set({ [key]: value } as Partial<Values<S>>, setOpts)
    }
    const plain = (values: Record<string, unknown>) => values[key]
    // No way to reset a row (`keys: { reset: false }`), no modified marks.
    const isModified = () =>
      marks && bound("reset") && spec.keys.some((k) => controls.isModified(k as keyof S & string))
    const resetRow = () => {
      if (!bound("reset")) return
      cue(root, "reset")
      run(() => controls.reset(spec.keys as (keyof S & string)[]))
    }
    let label: (text: string) => void = () => {}
    const retuneBase = (row: Row, next: RowSpec) => {
      row.field = next.field
      const text = next.field.label ?? row.display
      if (text !== row.display) {
        row.display = text
        label(text)
      }
    }
    if (field.kind === "knob") {
      const slider = createSlider(doc, key, field, set, () => wakeGpu())
      slider.element.dataset.field = key
      if (field.shortcut) slider.track.setAttribute("aria-keyshortcuts", field.shortcut)
      slider.element.ondblclick = (event) => {
        if ((event.target as HTMLElement).closest(".knobs-value,.knobs-number,.knobs-accessory"))
          return
        resetRow()
      }
      const track: SubTrack = {
        slider,
        get field() {
          return slider.field
        },
        get: () => controls.get()[key] as number,
        set: (v) => set(v),
      }
      tracks.set(slider.track, track)
      return {
        ...base,
        row: slider.element,
        labelEl: slider.label,
        input: slider.track,
        number: slider.number,
        slider,
        gpu: [{ kind: "knob", key, display, row: slider.element, slider, wave, isModified }],
        value: plain,
        set,
        retune(next) {
          this.field = next.field
          this.display = next.field.label ?? key
          slider.retune(next.field as Knob)
        },
      }
    }
    if (field.kind === "action") {
      const row = el("div")
      row.className = "knobs-row knobs-action-row"
      row.dataset.field = key
      const press = el("button", display)
      press.type = "button"
      press.className = "knobs-action"
      press.onclick = () => {
        cue(root, "press")
        run(() => controls.action(key as keyof S & string))
      }
      row.append(press)
      label = (text) => (press.textContent = text)
      // Its shortcut sits at the row's end as a key cap, one that listens for a new combination
      // when the field says `rebind`; ←/→ go between the button and the cap.
      const combo = () => controls.shortcut(key as keyof S & string) ?? ""
      let shownKey: string | undefined
      const cap = field.rebind
        ? keyCap({
            doc,
            row,
            empty: "Add key",
            name: () => `${display} shortcut`,
            set: (next) => {
              if (next) cue(root, "capture")
              controls.rebind(key as keyof S & string, next)
            },
            wake: () => wakeGpu(),
          })
        : undefined
      const chip = cap?.chip ?? (field.shortcut ? el("kbd", "knobs-keys") : undefined)
      if (chip) {
        if (!cap) chip.dataset.static = ""
        row.dataset.keyed = ""
        row.append(chip)
      }
      if (cap)
        row.addEventListener("keydown", (event) => {
          const dir = arrowOf(event)
          if (!dir || event.metaKey || event.ctrlKey || cap.capturing()) return
          const to =
            dir > 0 && event.target === press
              ? cap.chip
              : dir < 0 && event.target === cap.chip
                ? press
                : undefined
          if (!to) return
          event.preventDefault()
          event.stopPropagation()
          to.focus()
        })
      const paintKey = () => {
        const now = combo()
        if (now === shownKey) return
        shownKey = now
        const where = actionKey(key, this_.field as ActionField)
        if (where && where.scope !== "none") press.setAttribute("aria-keyshortcuts", where.key)
        else press.removeAttribute("aria-keyshortcuts")
        if (cap) cap.show(now)
        else if (chip) {
          chip.textContent = now ? comboLabel(now) : ""
          chip.hidden = !now
        }
        wakeGpu()
      }
      const this_: Row = {
        ...base,
        row,
        labelEl: press,
        input: press,
        gpu: [
          {
            kind: "action",
            key,
            display,
            row,
            button: press,
            ...(chip
              ? {
                  keys: {
                    chip,
                    text: cap?.text ?? chip,
                    capturing: cap?.capturing ?? (() => false),
                  },
                }
              : {}),
            wave,
            isModified: () => false,
          },
        ],
        value: () => undefined,
        set: () => {},
        retune(next) {
          retuneBase(this, next)
          shownKey = undefined
          paintKey()
        },
        refresh: paintKey,
        dispose: () => {
          if (keyedActions.get(key)?.row === this_) keyedActions.delete(key)
        },
      }
      if (field.shortcut || field.rebind) keyedActions.set(key, { row: this_, button: press })
      paintKey()
      return this_
    }
    if (field.kind === "toolbar") {
      const bar = toolbarRow(
        {
          doc,
          key,
          display,
          wave,
          field,
          get: () => undefined as unknown as Value,
          set: () => {},
          isModified: () => false,
          wake: () => wakeGpu(),
        },
        (item) => {
          cue(root, "press")
          run(() => controls.action(key as keyof S & string, item.id ?? item.label))
        },
        (item) => {
          const combo = controls.shortcut(key as keyof S & string, item.id ?? item.label)
          const scope = toolbarShortcut(item)?.scope ?? (item.global ? "page" : "panel")
          return combo ? { key: combo, scope } : undefined
        },
      )
      toolbars.set(key, bar)
      return {
        ...base,
        row: bar.row,
        labelEl: bar.row,
        get input() {
          return bar.input
        },
        editor: bar,
        gpu: [...bar.gpu],
        value: () => undefined,
        set: () => {},
        refresh: () => bar.refresh(),
        retune(next) {
          this.field = next.field
          this.display = next.field.label ?? key
          bar.swap(next.field as ToolbarField)
        },
        dispose: () => toolbars.delete(key),
      }
    }
    if (isReadout(field)) {
      const state = readoutPort?.state(key)
      if (!state) throw new Error(`No readout state for ${key}.`)
      const r = readoutRow({
        doc,
        key,
        display,
        field,
        state,
        wave,
        wake: () => wakeGpu(),
        gpu: () => root.dataset.gpuActive === "true",
      })
      readouts.set(key, r)
      return {
        ...base,
        row: r.row,
        labelEl: r.labelEl,
        input: r.input,
        editor: r,
        gpu: [...r.gpu],
        value: () => undefined,
        set: () => {},
        retune(next) {
          this.field = next.field
          this.display = next.field.label ?? key
          r.swap(next.field as typeof field, this.display)
        },
        dispose: () => {
          if (readouts.get(key) === r) readouts.delete(key)
        },
      }
    }
    if (field.kind !== "choice" && field.kind !== "toggle") {
      const keys = spec.keys
      const context = {
        doc,
        key,
        display,
        wave,
        get: (): Value =>
          spec.parts
            ? ({
                duration: controls.get()[keys[0]!],
                bounce: controls.get()[keys[1]!],
              } as SpringValue)
            : (controls.get()[key] as Value),
        set: (value: unknown, setOpts?: { coalesce?: boolean }) =>
          run(() =>
            spec.parts
              ? controls.set(
                  {
                    [keys[0]!]: (value as SpringValue).duration,
                    [keys[1]!]: (value as SpringValue).bounce,
                  } as Partial<Values<S>>,
                  setOpts,
                )
              : set(value, setOpts),
          ),
        isModified,
        wake: () => wakeGpu(),
        expanded: session.expanded?.includes(key),
        onExpand: (open: boolean) => {
          if (!remember) return
          const others = (readSession(controls.id).expanded ?? []).filter((k) => k !== key)
          writeSession(controls.id, { expanded: open ? [...others, key] : others })
        },
        ...(spec.parts ? { parts: spec.parts } : {}),
      }
      // Inspector rows read their field live, so a retune (a new range or step) reaches them.
      const live = { ...context, field } as typeof context & { field: typeof field }
      const editor =
        field.kind === "spring"
          ? springRow({ ...context, field })
          : field.kind === "color"
            ? colorRow({ ...context, field })
            : field.kind === "point"
              ? pointRow({ ...context, field })
              : field.kind === "easing"
                ? easingRow({ ...context, field })
                : field.kind === "gradient"
                  ? gradientRow({ ...context, field })
                  : field.kind === "curve"
                    ? curveRow({ ...context, field })
                    : field.kind === "vec"
                      ? vecRow(live as typeof live & { field: typeof field })
                      : field.kind === "range"
                        ? rangeRow(live as typeof live & { field: typeof field })
                        : field.kind === "angle"
                          ? angleRow(live as typeof live & { field: typeof field })
                          : field.kind === "seed"
                            ? seedRow(live as typeof live & { field: typeof field })
                            : keybindRow(live as typeof live & { field: typeof field })
      if (field.shortcut) editor.input.setAttribute("aria-keyshortcuts", field.shortcut)
      editor.labelEl.ondblclick = resetRow
      for (const t of editor.tracks) tracks.set(t.slider.track, t)
      if (spec.parts) editor.row.dataset.spring = spec.id.slice(7)
      return {
        ...base,
        row: editor.row,
        labelEl: editor.labelEl,
        input: editor.input,
        editor,
        gpu: [...editor.gpu],
        value: spec.parts
          ? (values) => ({ duration: values[keys[0]!], bounce: values[keys[1]!] })
          : plain,
        set: context.set,
        retune(next) {
          this.field = next.field
          ;(live as { field: Field }).field = next.field
          if (next.parts) editor.retune?.(next.parts)
        },
      }
    }
    const row = el("div")
    row.className = "knobs-row"
    row.dataset.field = key
    const rowLabel = el("span", display)
    rowLabel.ondblclick = resetRow
    row.append(rowLabel)
    label = (text) => {
      rowLabel.firstChild!.textContent = text
    }
    if (field.kind === "choice") {
      // Segments while they fit, a menu when they don't (or there are many): see choice.ts.
      const items = (f: Choice) =>
        f.options.map((value) => ({ value, label: choiceLabel(f, value) }))
      const control = createChoice(doc, row, {
        label: display,
        items: items(field),
        display: field.display,
        value: () => String(controls.get()[key]),
        choose: (value, coalesce) => run(() => set(value, { coalesce })),
        wake: () => wakeGpu(),
      })
      if (field.shortcut) {
        control.seg.setAttribute("aria-keyshortcuts", field.shortcut)
        control.menu.setAttribute("aria-keyshortcuts", field.shortcut)
      }
      const choiceRow: Row = {
        ...base,
        row,
        labelEl: rowLabel,
        get input() {
          return control.focusTarget()
        },
        buttons: [...control.buttons],
        choice: control,
        gpu: [
          {
            kind: "choice",
            key,
            display,
            row,
            labelEl: rowLabel,
            segEl: control.seg,
            buttons: control.buttons,
            pill: new Edges(),
            menu: { button: control.menu, valueEl: control.menuValue },
            wave,
            isModified,
          },
        ],
        value: plain,
        set,
        retune(next) {
          retuneBase(this, next)
          control.seg.setAttribute("aria-label", this.display)
          control.menu.setAttribute("aria-label", this.display)
          control.relabel(items(next.field as Choice))
        },
        dispose: () => control.dispose(),
      }
      return choiceRow
    }
    const toggle = el("button")
    toggle.type = "button"
    toggle.className = "knobs-toggle"
    toggle.setAttribute("role", "switch")
    toggle.setAttribute("aria-label", display)
    if (field.shortcut) toggle.setAttribute("aria-keyshortcuts", field.shortcut)
    toggle.append(el("i"))
    const tapped = options.haptics !== false && tapTick(toggle)
    toggle.onclick = () => {
      run(() => set(!controls.get()[key]))
      if (!tapped) tick(toggle)
    }
    row.append(toggle)
    // A sideways pan anywhere on the row takes the thumb in hand (see thumb.ts).
    panSwitch(row, toggle, {
      value: () =>
        toggle.getAttribute("aria-checked") === "mixed" ? "mixed" : Boolean(controls.get()[key]),
      set: (on, coalesce) => run(() => set(on, { coalesce })),
      wake: () => wakeGpu(),
    })
    return {
      ...base,
      row,
      labelEl: rowLabel,
      input: toggle,
      gpu: [
        {
          kind: "toggle",
          key,
          display,
          row,
          labelEl: rowLabel,
          toggleEl: toggle,
          thumb: new Edges(),
          wave,
          isModified,
        },
      ],
      value: plain,
      set,
      retune(next) {
        retuneBase(this, next)
        toggle.setAttribute("aria-label", this.display)
      },
    }
  }

  /** Every field row carries `knobs-row` (and `data-field`), and the accessory slot if asked. */
  function decorate(row: Row) {
    row.row.classList.add("knobs-row")
    row.row.dataset.field ??= row.keys[0] ?? row.id
    if (!options.rowAccessory) return
    const slot = el("span")
    slot.className = "knobs-accessory"
    row.accessory = slot
    row.row.dataset.accessory = ""
    if (row.slider) row.slider.slot(slot)
    else if (row.field.kind === "spring" && row.editor?.tracks[0])
      row.editor.tracks[0].slider.slot(slot)
    else if (row.field.kind === "action" || row.field.kind === "toolbar") row.row.append(slot)
    else row.labelEl.after(slot)
    fillAccessory(row)
  }
  function fillAccessory(row: Row) {
    if (!row.accessory || !options.rowAccessory) return
    const node = options.rowAccessory(row.keys[0] ?? row.id)
    const slot = row.accessory
    if (node ? slot.childNodes.length === 1 && slot.firstChild === node : !slot.firstChild) return
    slot.replaceChildren(...(node ? [node] : []))
  }
  /** A field's `disabled` or `readOnly`, static or from the values (for rows without keys). */
  const fieldFlag = (field: Field, name: "disabled" | "readOnly") => {
    const v = field[name]
    return typeof v === "function" ? Boolean(v(controls.get())) : Boolean(v)
  }
  /** Disabled and read-only marks, and their ARIA, from the store. */
  function applyState(row: Row) {
    const keys = row.keys as (keyof S & string)[]
    const disabled = keys.length
      ? keys.some((k) => controls.isDisabled(k))
      : fieldFlag(row.field, "disabled")
    const readOnly =
      !disabled &&
      (keys.length ? keys.some((k) => controls.isReadOnly(k)) : fieldFlag(row.field, "readOnly"))
    if (
      row.row.hasAttribute("data-disabled") === disabled &&
      row.row.hasAttribute("data-readonly") === readOnly
    )
      return
    row.row.toggleAttribute("data-disabled", disabled)
    row.row.toggleAttribute("data-readonly", readOnly)
    const inputs = row.choice ? [row.choice.seg, row.choice.menu] : [row.input]
    for (const input of inputs) {
      if (disabled) input.setAttribute("aria-disabled", "true")
      else input.removeAttribute("aria-disabled")
      if (readOnly) input.setAttribute("aria-readonly", "true")
      else input.removeAttribute("aria-readonly")
    }
  }

  let rows: Row[] = []
  /** Rows playing their exit; still drawn, no longer reachable. */
  const leavingRows = new Set<Row>()
  let presenceRuns = 0
  /** Shows or hides a row, card or group head with the reveal motion, after `delay` ms. */
  const present = (node: HTMLElement, show: boolean, delay: number, after?: () => void) => {
    presenceRuns++
    node.dataset.presence = show ? "in" : "out"
    if (show) node.hidden = true
    reveal(
      node,
      show,
      () => {
        presenceRuns--
        delete node.dataset.presence
        after?.()
        wakeGpu()
        // A card the store dropped has folded away (or one is back): its section goes with it.
        if (page && built) announceSections()
      },
      delay,
    )
    wakeGpu()
  }
  const dropGpu = (row: Row) => {
    row.dispose?.()
    row.slider?.dispose()
    row.editor?.dispose()
    for (const g of row.gpu) {
      const at = gpuRows.indexOf(g)
      if (at >= 0) gpuRows.splice(at, 1)
    }
    for (const t of row.editor?.tracks ?? []) tracks.delete(t.slider.track)
    if (row.slider) tracks.delete(row.slider.track)
  }
  const dropBlock = (block: Block) => {
    block.head?.remove()
    block.card.remove()
    const ci = cards.indexOf(block.card)
    if (ci >= 0) cards.splice(ci, 1)
    if (block.gpuGroup) {
      const gi = gpuGroups.indexOf(block.gpuGroup)
      if (gi >= 0) gpuGroups.splice(gi, 1)
    }
    const bi = blocks.indexOf(block)
    if (bi >= 0) blocks.splice(bi, 1)
    if (block.group && groupResetButtons.get(block.group) === block.gpuGroup?.reset) {
      groupResetButtons.delete(block.group)
      groupDice.get(block.group)?.die.dispose()
      groupDice.delete(block.group)
      groupChips.get(block.group)?.dispose()
      groupChips.delete(block.group)
    }
  }
  /** Puts `nodes` into `parent` in this order, moving only what's out of place. */
  const arrange = (parent: HTMLElement, nodes: readonly HTMLElement[]) => {
    let cursor: ChildNode | null = null
    for (const node of nodes) {
      const want: ChildNode | null = cursor ? cursor.nextSibling : parent.firstChild
      // Leaving nodes keep their place; skip past them.
      let next: ChildNode | null = want
      while (next && next !== node && (next as HTMLElement).dataset?.presence === "out")
        next = next.nextSibling
      if (next !== node) parent.insertBefore(node, want)
      cursor = node
    }
  }

  /**
   * Builds rows for the current schema, keeping those whose identity and shape persist. Rows and
   * blocks that arrive or leave reveal or fold, each starting its turn in the cascade.
   */
  function layoutRows(animate: boolean) {
    const specs = planRows(controls.schema)
    const kept = new Map(rows.map((r) => [r.id, r]))
    const next: Row[] = []
    const entering = new Set<Row>()
    const focused = doc.activeElement as HTMLElement | null
    for (const spec of specs) {
      const existing = kept.get(spec.id)
      if (existing && existing.shape === shapeOf(spec)) {
        kept.delete(spec.id)
        existing.retune(spec)
        next.push(existing)
        continue
      }
      const row = buildRow(spec)
      decorate(row)
      gpuRows.push(...row.gpu)
      entering.add(row)
      next.push(row)
    }
    const leaving = [...kept.values()]
    rows = next
    const motion: { node: HTMLElement; show: boolean; after?: () => void }[] = []
    if (page) {
      for (const r of next) {
        if (!entering.has(r)) continue
        tileFor(r.group, r.section).append(r.row)
        if (animate) motion.push({ node: r.row, show: true })
      }
      for (const r of leaving) {
        r.leaving = true
        leavingRows.add(r)
        const done = () => {
          r.row.remove()
          leavingRows.delete(r)
          dropGpu(r)
        }
        if (animate) motion.push({ node: r.row, show: false, after: done })
        else done()
      }
      // A card whose rows all left folds away with them; one that gets rows again opens.
      // The page lays them out: a section left with no cards goes (its heading too) and the
      // columns re-balance, gliding; one that gets cards back returns in its place.
      const occupied = new Set(next.map((r) => tileFor(r.group, r.section)))
      const toggled: [HTMLElement, boolean][] = []
      for (const inner of tiles.values()) {
        const tile = inner.parentElement!
        const empty = !occupied.has(inner)
        // A card still folding away counts as gone: getting rows back brings it back.
        const gone = tile.hidden || tile.dataset.leaving !== undefined
        if (empty !== gone) toggled.push([tile, empty])
      }
      // A descriptor swap may bring other descriptions and labels.
      for (const group of groupDescs.keys()) describeGroup(group)
      layout?.relabel()
      if (toggled.length && layout)
        layout.change(
          () => {
            for (const [tile, empty] of toggled) tile.hidden = empty
          },
          [],
          !animate,
        )
      else layout?.pack(true)
    } else {
      // Runs of rows sharing a group make blocks; a run reuses its group's block if there is one.
      const runs: { group: string | undefined; rows: Row[] }[] = []
      for (const r of next) {
        const last = runs.at(-1)
        if (last && last.group === r.group) last.rows.push(r)
        else runs.push({ group: r.group, rows: [r] })
      }
      const free = blocks.filter((b) => !b.leaving)
      const chosen: Block[] = []
      const usedSubheads = new Set<string>()
      for (const run of runs) {
        const at = free.findIndex((b) => b.group === run.group)
        const block = at >= 0 ? free.splice(at, 1)[0]! : newBlock(run.group)
        if (at < 0) {
          blocks.push(block)
          // A group that starts folded arrives as its header alone.
          const shut = block.group !== undefined && folds.get(block.group) === true
          if (shut) block.card.hidden = true
          if (animate) {
            if (block.head) motion.push({ node: block.head, show: true })
            if (!shut) motion.push({ node: block.card, show: true })
          }
        }
        chosen.push(block)
        // Consecutive rows sharing a `subsection` sit under one flat sub-heading in the card.
        const nodes: HTMLElement[] = []
        let under: string | undefined
        for (const r of run.rows) {
          const name = r.field.subsection
          r.subhead = name === undefined ? undefined : subId(run.group, name)
          if (name !== undefined && name !== under) {
            const known = subheads.has(r.subhead!)
            const sh = subheadFor(run.group, name)
            usedSubheads.add(sh.id)
            nodes.push(sh.el)
            if (animate && at >= 0 && !known) motion.push({ node: sh.el, show: true })
          }
          under = name
          nodes.push(r.row)
        }
        arrange(block.card, nodes)
        if (animate && at >= 0)
          for (const r of run.rows) if (entering.has(r)) motion.push({ node: r.row, show: true })
      }
      for (const [id, sh] of subheads)
        if (!usedSubheads.has(id)) {
          sh.el.remove()
          const gi = gpuRows.indexOf(sh.gpu)
          if (gi >= 0) gpuRows.splice(gi, 1)
          subheads.delete(id)
        }
      arrange(
        body,
        chosen.flatMap((b) => (b.head ? [b.head, b.card] : [b.card])),
      )
      for (const block of free) {
        block.leaving = true
        const fold = () => {
          for (const r of leaving) if (block.card.contains(r.row)) dropGpu(r)
          dropBlock(block)
        }
        if (animate) {
          if (block.head) motion.push({ node: block.head, show: false })
          motion.push({ node: block.card, show: false, after: fold })
        } else fold()
      }
      for (const r of leaving) {
        r.leaving = true
        const block = blocks.find((b) => b.card.contains(r.row))
        if (block?.leaving) continue
        leavingRows.add(r)
        const done = () => {
          r.row.remove()
          leavingRows.delete(r)
          dropGpu(r)
        }
        if (animate) motion.push({ node: r.row, show: false, after: done })
        else done()
      }
    }
    syncTabs()
    // What arrives on another tab (or outside the search, or in a folded part) arrives hidden.
    const want = wantedVisibility()
    for (let i = motion.length - 1; i >= 0; i--) {
      const m = motion[i]!
      if (m.show && want.get(m.node) === false) {
        m.node.hidden = true
        motion.splice(i, 1)
      }
    }
    if (motion.length) {
      motion.sort((a, b) =>
        a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )
      const stagger = cascade(motion.length)
      motion.forEach((m, i) => present(m.node, m.show, i * stagger, m.after))
    }
    applyVisibility(animate ? "reveal" : "instant")
    if (page) refreshFolds()
    if (focused && root.contains(focused) && doc.activeElement !== focused && focused.isConnected)
      focused.focus({ preventScroll: true })
    // Focus on a row that left goes to the nearest row that's still here, not the page.
    const gone = focused ? leaving.find((r) => r.row.contains(focused)) : undefined
    if (gone) {
      const after = rows.find(
        (r) => gone.row.compareDocumentPosition(r.row) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
      const near = after ?? rows.at(-1)
      if (near) near.input.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
      else root.focus({ preventScroll: true })
    }
    if (selected.size) {
      selected.clear()
      paintSelection()
    }
    anchor = head = -1
  }

  // ——— Sub-headings ———
  interface Subhead {
    id: string
    name: string
    el: HTMLElement
    gpu: GpuRowBinding
  }
  const subheads = new Map<string, Subhead>()
  /** Each sub-heading's state, by id: folded or open. */
  const subFolds = new Map<string, boolean>()
  const subId = (group: string | undefined, name: string) => `${group ?? ""}\u0000${name}`
  function subheadFor(group: string | undefined, name: string): Subhead {
    const id = subId(group, name)
    const known = subheads.get(id)
    if (known) return known
    const node = el("div")
    node.className = "knobs-subhead"
    node.dataset.subhead = id
    node.tabIndex = -1
    node.setAttribute("role", "button")
    node.setAttribute("aria-label", name)
    const label = el("span", name)
    label.className = "knobs-subhead-label"
    const caret = caretSvg()
    node.append(label, caret)
    if (!subFolds.has(id))
      subFolds.set(id, session.subsections?.[id] ?? options.subsectionFolded?.[name] ?? false)
    node.setAttribute("aria-expanded", String(!subFolds.get(id)))
    node.addEventListener("click", () => foldSub(id))
    const sh: Subhead = {
      id,
      name,
      el: node,
      gpu: {
        kind: "subhead",
        key: `subhead:${id}`,
        display: name,
        row: node,
        labelEl: label,
        caret,
        wave: { at: 0 },
        isModified: () => false,
      },
    }
    subheads.set(id, sh)
    gpuRows.push(sh.gpu)
    return sh
  }
  /** Folds or opens a sub-heading's rows (toggles without `next`). */
  function foldSub(id: string, next = !subFolds.get(id)) {
    const sh = subheads.get(id)
    if (!sh) return
    subFolds.set(id, next)
    sh.el.setAttribute("aria-expanded", String(!next))
    if (next && rows.some((r) => r.subhead === id && r.row.contains(doc.activeElement)))
      sh.el.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    applyVisibility("reveal")
    if (remember)
      writeSession(controls.id, {
        subsections: { ...readSession(controls.id).subsections, [id]: next },
      })
  }

  // ——— Tabs ———
  /** The tab a group sits on: its first field that names one. */
  const groupTab = (group: string) => {
    for (const f of Object.values(controls.schema as Record<string, Field>))
      if (f.group === group && f.tab !== undefined) return f.tab
    return undefined
  }
  /** A row's tab: its field's, else its group's; none shows on every tab. */
  const tabOf = (r: Row) => r.field.tab ?? (r.group !== undefined ? groupTab(r.group) : undefined)
  /** `tabs` in order, then the tabs fields name that it doesn't list. */
  const tabList = (): TabSpec[] => {
    if (page) return []
    const list: TabSpec[] = (options.tabs ?? []).map((t) =>
      typeof t === "string"
        ? { id: t, label: readableTitle(t) }
        : { id: t.id, label: t.label ?? readableTitle(t.id) },
    )
    const seen = new Set(list.map((t) => t.id))
    for (const f of Object.values(controls.schema as Record<string, Field>))
      if (f.tab !== undefined && !seen.has(f.tab)) {
        seen.add(f.tab)
        list.push({ id: f.tab, label: readableTitle(f.tab) })
      }
    return list
  }
  function syncTabs() {
    const list = tabList()
    const has = (id: string | undefined) => id !== undefined && list.some((t) => t.id === id)
    if (!has(activeTab))
      activeTab = [options.tab, lastTab.get(controls.id), session.tab, list[0]?.id].find(has)
    tabStrip.set(list, activeTab)
  }
  function selectTab(id: string, animate = true) {
    if (id === activeTab || !tabStrip.tabs.some((t) => t.id === id)) return
    activeTab = id
    lastTab.set(controls.id, id)
    if (remember) writeSession(controls.id, { tab: id })
    tabStrip.select(id, animate)
    const focused = doc.activeElement as HTMLElement | null
    applyVisibility(animate ? "tab" : "instant")
    // Focus on a row that left stays with the tabs.
    if (focused && root.contains(focused) && focused.closest("[hidden],[data-leaving]"))
      tabStrip.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    options.onTab?.(id)
    wakeGpu()
  }
  const cycleTab = (direction: -1 | 1) => {
    const list = tabStrip.tabs
    if (list.length < 2) return false
    const at = list.findIndex((t) => t.id === activeTab)
    selectTab(list[(at + direction + list.length) % list.length]!.id)
    return true
  }

  // ——— What shows ———
  // A row shows on its tab (or every tab), unless a search leaves it out or its sub-heading is
  // folded; a group shows while any of its rows does. A search spans every tab and opens folds.
  const searching = () => search?.filtering() ?? false
  const rowMatches = (r: Row) => {
    const query = search!.query()
    if (
      query &&
      !matchesFilter(
        query,
        r.display,
        r.key,
        r.group,
        r.group && groupTitle(r.group),
        r.field.subsection,
      )
    )
      return false
    for (const chip of search!.active())
      if (!r.keys.some((k) => chipTests.get(chip)?.(k))) return false
    return true
  }
  function wantedVisibility(): Map<HTMLElement, boolean> {
    const want = new Map<HTMLElement, boolean>()
    if (page) return want
    const finding = searching()
    const shown = new Map<Row, boolean>()
    for (const r of rows) {
      const tab = tabOf(r)
      shown.set(
        r,
        finding ? rowMatches(r) : tab === undefined || activeTab === undefined || tab === activeTab,
      )
    }
    for (const sh of subheads.values())
      want.set(
        sh.el,
        rows.some((r) => r.subhead === sh.id && shown.get(r)),
      )
    for (const r of rows)
      want.set(
        r.row,
        shown.get(r)! && !(r.subhead !== undefined && subFolds.get(r.subhead) && !finding),
      )
    for (const b of blocks) {
      if (b.leaving) continue
      const any = rows.some((r) => shown.get(r) && b.card.contains(r.row))
      if (b.head) want.set(b.head, any)
      want.set(b.card, any && !(b.group !== undefined && folds.get(b.group) && !finding))
    }
    return want
  }
  /** Folds `node` open or shut with the reveal motion (the GPU follows its presence). */
  const shift = (node: HTMLElement, show: boolean, delay: number) => {
    shifting.add(node)
    node.dataset.presence = show ? "in" : "out"
    reveal(
      node,
      show,
      () => {
        shifting.delete(node)
        delete node.dataset.presence
        wakeGpu()
      },
      delay,
    )
  }
  /**
   * Brings the DOM to what should show: at once (`instant`), folding (`reveal`), or as a tab
   * change, where what arrives starts just after what leaves so they cross.
   */
  function applyVisibility(mode: "instant" | "reveal" | "tab") {
    if (page) return
    const want = wantedVisibility()
    const showing = (n: HTMLElement) => !n.hidden && n.dataset.leaving !== "true"
    const set = (node: HTMLElement, show: boolean, animate: boolean) => {
      if (showing(node) === show) return
      if (animate || shifting.has(node)) shift(node, show, mode === "tab" && show ? 40 : 0)
      else node.hidden = !show
    }
    // Cards first: inside a card that's arriving (or staying shut), rows just take their state;
    // inside one that's leaving, they keep theirs until it's gone.
    const cardMotion = new Map<HTMLElement, "in" | "out" | "still" | "shut">()
    for (const b of blocks) {
      if (b.leaving) continue
      const show = want.get(b.card)!
      const was = showing(b.card)
      cardMotion.set(b.card, show === was ? (show ? "still" : "shut") : show ? "in" : "out")
      if (b.head) set(b.head, want.get(b.head)!, mode !== "instant")
      set(b.card, show, mode !== "instant")
    }
    for (const [node, show] of want) {
      const card = node.parentElement
      if (!card || !cardMotion.has(card)) continue
      const motion = cardMotion.get(card)!
      if (motion === "out") continue
      set(node, show, mode !== "instant" && motion === "still")
    }
    const finding = searching()
    if (root.hasAttribute("data-searching") !== finding)
      root.toggleAttribute("data-searching", finding)
    if (search) {
      // A match shows in its label by colour alone, so labels keep their width.
      const query = search.query()
      for (const r of rows) {
        const label = r.slider?.label ?? r.labelEl
        if (label !== r.row)
          markLabel(label, r.display, finding ? matchSpan(r.display, query) : undefined)
      }
    }
    positioned?.constrain()
    wakeGpu()
  }

  // A locked row carries a small lock just left of its readout (see .knobs-lock): inside a slider's
  // value, at the head of an editor's summary, or before a row's control. It's added the first time
  // the row is locked; the GPU finds it by label.
  const lockIcons = new Map<HTMLElement, HTMLElement>()
  const lockIcon = (label: HTMLElement, animate: boolean) => {
    let lock = lockIcons.get(label)
    if (!lock) {
      lock = el("span")
      lock.className = "knobs-lock"
      lock.setAttribute("aria-hidden", "true")
      lock.append(iconSvg(doc, "lock"))
      const readout =
        label.parentElement?.querySelector<HTMLElement>(":scope > .knobs-value") ??
        label.parentElement?.querySelector<HTMLElement>(":scope > .knobs-x-sum")
      if (readout) readout.prepend(lock)
      else label.after(lock)
      lockIcons.set(label, lock)
      // Styled unlocked first, so it scales in (data-enter tells the GPU to do the same).
      if (animate) {
        lock.dataset.enter = ""
        lock.getBoundingClientRect()
      }
    }
    return lock
  }
  const keysOf = (indices: readonly number[]) =>
    indices.flatMap((i) => rows[i]?.keys ?? []) as (keyof S & string)[]
  const groupKeys = (group: string) => rows.filter((r) => r.group === group).flatMap((r) => r.keys)
  const rerollGroup = (group: string, nudge: boolean) => {
    const roller = groupDice.get(group)?.die
    if (!roller) return
    // The host may roll the group itself (its own seeded "Randomize <group>"): the die still tumbles.
    if (options.groupRandom?.(group, nudge ? "mutate" : "random") === true) roller.roll(nudge)
    else reroll(groupKeys(group), nudge, roller)
  }

  // Selection: ⇧-click selects a range, ⌘-click toggles a row, ⇧↑↓ extends from the focused row.
  // Commands (r, ⌥R, ⌫, ⇧L, ⇧C and the menu) act on the selection when there is one.
  const selected = new Set<number>()
  let anchor = -1
  let head = -1
  const rowAt = (node: Node | null) => (node ? rows.findIndex((r) => r.row.contains(node)) : -1)
  const paintSelection = () => {
    rows.forEach((r, i) => {
      const on = selected.has(i)
      if (r.row.classList.contains("knobs-selected") !== on)
        r.row.classList.toggle("knobs-selected", on)
    })
    wakeGpu()
  }
  const selectRange = (from: number, to: number) => {
    selected.clear()
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) selected.add(i)
    paintSelection()
  }
  const clearSelection = () => {
    anchor = head = -1
    if (selected.size === 0) return
    selected.clear()
    paintSelection()
  }
  /** What a command acts on: the selection, else the focused row. */
  const targets = () => {
    if (selected.size) return [...selected].sort((a, b) => a - b)
    const at = rowAt(doc.activeElement)
    return at >= 0 ? [at] : []
  }
  const selectionKeys = () =>
    selected.size ? keysOf([...selected].sort((a, b) => a - b)) : undefined
  const toggleLock = (indices = targets()) => {
    const keys = keysOf(indices)
    if (keys.length)
      controls.lock(
        keys,
        keys.some((k) => !controls.isLocked(k)),
      )
  }
  const copyKeys = (keys: readonly string[]) => {
    const values = controls.get() as Record<string, unknown>
    void copy(controls.code("ts", Object.fromEntries(keys.map((k) => [k, values[k]])) as Values<S>))
  }
  const focusRow = (i: number) =>
    rows[i]?.input.focus({ preventScroll: Boolean(page), focusVisible: false } as FocusOptions)

  let menu: Menu | undefined
  const showMenu = (at: { x: number; y: number }, keyboard: boolean, from?: number) => {
    const indices = targets()
    if (!indices.length) return
    // The menu's rows stay selected, so its shortcuts mean the same thing after it closes.
    if (!selected.size) {
      anchor = head = indices[0]!
      selectRange(anchor, head)
    }
    const chosen = keysOf(indices)
    if (!chosen.length) return
    const locked = chosen.every((k) => controls.isLocked(k))
    const active = doc.activeElement as HTMLElement | null
    const returnTo = active && root.contains(active) ? active : rows[from ?? indices[0]!]!.input
    menu?.close(false)
    menu = openMenu(
      doc,
      root,
      [
        ...(bound("lock")
          ? [
              {
                label: locked ? "Unlock" : "Lock from Random",
                shortcut: show("lock"),
                run: () => toggleLock(indices),
              },
            ]
          : []),
        ...(bound("random")
          ? [
              {
                label: "Randomize",
                shortcut: show("random"),
                disabled: locked,
                run: () => run(() => reroll(chosen, false)),
              },
            ]
          : []),
        ...(bound("reset")
          ? [
              {
                label: "Reset",
                shortcut: keyLabel(keys.reset[0]!),
                disabled: !controls.canReset(chosen),
                run: () => {
                  cue(root, "reset")
                  run(() => controls.reset(chosen))
                },
              },
            ]
          : []),
        ...(bound("copy")
          ? [
              {
                label: "Copy",
                shortcut: show("copy"),
                separated: true,
                run: () => copyKeys(chosen),
              },
            ]
          : []),
      ],
      at,
      { keyboard, returnTo, onClose: () => (menu = undefined) },
    )
  }
  const menuFromKeyboard = () => {
    const at = targets()[0]
    const row = at === undefined ? undefined : rows[at]
    if (!row) return
    const r = row.labelEl.getBoundingClientRect()
    showMenu({ x: r.left, y: r.bottom + 4 }, true)
  }

  const text = el("textarea")
  text.hidden = true
  text.name = "variant-json"
  text.spellcheck = false
  text.setAttribute("aria-label", "Import or copy text")

  const apply = button("Apply import", () => {
    controls.variants.import(text.value)
    say("Presets imported.")
    reveal(text, false)
    reveal(apply, false)
    positioned?.constrain()
  })
  apply.className = "knobs-apply-btn"
  apply.setAttribute("aria-label", "Import JSON")
  apply.hidden = true

  /** Copies `value`; the header's Copy turns into a check (`inPlace`, while it shows) or says so. */
  const copy = async (value: string, inPlace = true) => {
    try {
      await doc.defaultView!.navigator.clipboard.writeText(value)
      if (inPlace && !copyButton.hidden && !header.hidden) copied()
      else say("Copied.")
    } catch {
      text.value = value
      if (page) togglePopover(true)
      reveal(text, true)
      apply.hidden = true
      positioned?.constrain()
      text.focus()
      text.select()
      say("Clipboard unavailable. Copy the selected text.", 6000)
    }
    wakeGpu()
  }

  const gpuActionButtons: HTMLButtonElement[] = []
  const panelActions = allActions.filter((a) => !a.group)
  const customActions = el("div")
  customActions.className = "knobs-custom-actions"
  for (const act of panelActions) {
    const b = button(act.label, () => {
      cue(root, "press")
      return act.run(controls.get(), controls)
    })
    if (act.shortcut) b.setAttribute("aria-keyshortcuts", act.shortcut)
    customActions.append(b)
    gpuActionButtons.push(b)
  }

  // Saved presets live in the strip; moving them between machines lives with the shortcuts.
  if (showVariants && showFooter) {
    const transfer = el("div")
    transfer.className = "knobs-transfer"
    transfer.append(
      button("Export presets", () => void copy(controls.variants.export(), false)),
      button("Import presets", () => {
        reveal(text, true)
        reveal(apply, true)
        text.value = ""
        positioned?.constrain()
        text.focus()
      }),
    )
    popover.append(transfer)
  }
  // A panel with sound offers the user's own switch with the shortcuts, kept like other prefs.
  let unsubscribeSound = () => {}
  if (soundOptions && showFooter) {
    const pref = el("div")
    pref.className = "knobs-transfer knobs-sound-pref"
    const soundButton = button("", () => {
      sound.enable(!sound.enabled)
      try {
        controls.storage?.setItem(SOUND_PREF, sound.enabled ? "on" : "off")
      } catch {}
      cue(root, "toggle", { direction: 1 })
    })
    const paintSound = () => {
      soundButton.textContent = sound.enabled ? "Sounds on" : "Sounds off"
      soundButton.setAttribute("aria-pressed", String(sound.enabled))
    }
    paintSound()
    unsubscribeSound = sound.subscribe(paintSound)
    pref.append(soundButton)
    popover.append(pref)
  }

  if (page) {
    // The shortcuts float under the header's tools; the clipboard fallback and imports open in them.
    if (panelActions.length > 0) tools.insertBefore(customActions, headActions)
    popover.append(text, apply)
    root.append(header, body, popover, status, live)
  } else {
    root.append(header)
    if (showFooter) root.append(popover)
    root.append(tabStrip.element)
    if (search) root.append(search.element)
    root.append(presetStrip.element, body)
    if (panelActions.length > 0) root.append(customActions)
    root.append(text, apply, status, live)
  }

  // Changes that move several rows at once (presets, reset, random, undo) ripple down the panel:
  // each changed row starts --k-cascade ms after the one above. A row already in motion retargets
  // at once instead of pausing, so switching again mid-wave stays smooth.
  let shown = controls.get()
  let initialized = false
  const cascade = (changedCount: number) => {
    if (changedCount < 2) return 0
    const win = doc.defaultView
    if (!win || win.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0
    const raw =
      root.style.getPropertyValue("--k-cascade") ||
      getComputedStyle(root).getPropertyValue("--k-cascade")
    const ms = parseFloat(raw)
    const base = Number.isFinite(ms) ? Math.max(0, ms) : 12
    return changedCount > 8 ? Math.min(base, Math.floor(96 / (changedCount - 1))) : base
  }
  let shape = controls.schema
  let landTimer = 0
  /** A different item arrived: transitions are off until the values have painted. */
  const land = () => {
    root.dataset.landing = ""
    const win = doc.defaultView
    if (!win) return
    win.cancelAnimationFrame(landTimer)
    landTimer = win.requestAnimationFrame(() => {
      landTimer = win.requestAnimationFrame(() => {
        delete root.dataset.landing
        wakeGpu()
      })
    })
  }
  const isMixed = (r: Row) => r.keys.some((k) => controls.isMixed(k as keyof S & string))
  let lastRefresh = (controls as unknown as { [REFRESHES]?: number })[REFRESHES] ?? 0
  /**
   * Each reset shows while it has somewhere to go (back to the active preset, else to the
   * defaults), for the scope ⇧R would reset from there (its group's ↺, the header's ↺ for
   * everything), and stays while it turns.
   */
  function syncResets() {
    let changed = false
    for (const [groupName, gReset] of groupResetButtons) {
      const groupMod = controls.canReset(groupKeys(groupName) as (keyof S & string)[])
      // A group's reset is a coarse reset, so it follows `resetAll`.
      if (bloom(gReset, (marks && groupMod && bound("resetAll")) || spinning(gReset)))
        changed = true
    }
    if (bloom(resetBtn, controls.canReset() || spinning(resetBtn))) changed = true
    if (changed) wakeGpu()
  }
  /** The active presets as last shown, so a change of base alone still updates the resets. */
  let shownBase = ""
  const baseSignature = () =>
    JSON.stringify([
      controls.activePreset(),
      Object.keys(controls.groupPresets).map((g) => controls.activeGroupPreset(g)),
    ])
  function update() {
    if (!controls.enabled) {
      close?.()
      return
    }
    const landing = controls.landing
    if (landing) land()
    if (controls.schema !== shape) {
      shape = controls.schema
      layoutRows(initialized && !landing)
    }
    const values = controls.get() as Record<string, unknown>
    const before = shown as Record<string, unknown>
    // A row with nothing shown yet (it just arrived) places its value without motion.
    const fresh = (r: Row) => r.row.dataset.shown === undefined
    const changed = (r: Row) =>
      fresh(r) || Boolean(r.mixed) !== isMixed(r) || r.keys.some((k) => !same(values[k], before[k]))
    let changedCount = 0
    if (initialized && !landing) for (const r of rows) if (!fresh(r) && changed(r)) changedCount++
    const stagger = initialized ? cascade(changedCount) : 0
    const moving = initialized ? rows.filter(changed) : rows
    // The preset strip first: its chip's weight moves the chips, so it reads after its own writes
    // and before the rows dirty everything else.
    presetStrip.update()
    // Reads before writes: every row about to move reads its tokens, and every segmented pill its
    // options, before any row writes (see measure.ts).
    batchMeasures(() => {
      for (const row of moving) {
        row.slider?.prime()
        row.editor?.prime?.()
        if (row.choice) primeSegPill(row.choice.seg, row.choice.buttons)
      }
      for (const chips of groupChips.values()) primeSegPill(chips.seg, chips.buttons)
      showValues(values, moving, stagger, landing)
    })
    if (moving.length || !initialized) refreshFolds()
    shown = values as Values<S>
    initialized = true

    wakeGpu()
  }
  function markRow(row: Row, values: Record<string, unknown>, baseline: Record<string, unknown>) {
    const modified = marks && bound("reset") && row.keys.some((k) => !same(values[k], baseline[k]))
    if (row.row.classList.contains("knobs-modified") !== modified)
      row.row.classList.toggle("knobs-modified", modified)
  }
  /** Sets a row's turn on what it times (see `DELAYED`), each only when it differs. */
  function delayRow(row: HTMLElement, wait: string) {
    for (const el of row.querySelectorAll<HTMLElement>(DELAYED)) {
      if (el.style.getPropertyValue("--k-delay") === wait) continue
      if (wait) el.style.setProperty("--k-delay", wait)
      else el.style.removeProperty("--k-delay")
    }
  }
  function showValues(
    values: Record<string, unknown>,
    moving: readonly Row[],
    stagger: number,
    landing: boolean,
  ) {
    // Marks say what differs from the active preset (the defaults without one).
    const baseline = controls.baseValues() as Record<string, unknown>
    const fresh = (r: Row) => r.row.dataset.shown === undefined
    const now = performance.now()
    let turn = 0
    const based = baseSignature()
    const rebased = based !== shownBase
    shownBase = based
    for (const row of moving) {
      const instant = !initialized || landing || fresh(row)
      row.row.dataset.shown = ""
      const value = row.value(values)
      let delay = 0
      if (!instant) {
        const inMotion = row.wave.at <= now && now < row.wave.until
        delay = inMotion ? 0 : turn * stagger
        turn++
        row.wave.at = now + delay
        row.wave.until = row.wave.at + 280
        delayRow(row.row, `${delay}ms`)
      } else {
        row.wave.at = row.wave.until = 0
        delayRow(row.row, "")
      }
      markRow(row, values, baseline)
      const mixed = isMixed(row)
      row.mixed = mixed
      if (row.row.classList.contains("knobs-mixed") !== mixed)
        row.row.classList.toggle("knobs-mixed", mixed)
      if (row.slider) {
        row.slider.update(Number(value), delay, instant)
        if (mixed) row.slider.track.setAttribute("aria-valuetext", "Mixed")
      } else if (row.choice) row.choice.show(String(value), instant, mixed)
      else if (row.editor) {
        row.editor.update(value as Value, delay, instant, mixed)
        if (mixed)
          for (const read of row.row.querySelectorAll<HTMLElement>(".knobs-x-read"))
            if ((read.dataset.text ?? read.textContent) !== "—") read.textContent = "—"
      } else if (row.field.kind === "toggle")
        row.input.setAttribute("aria-checked", mixed ? "mixed" : String(Boolean(value)))
    }
    for (const row of rows) {
      // A new base moves the marks of rows whose values stayed put.
      if (rebased) markRow(row, values, baseline)
      applyState(row)
      row.refresh?.()
    }
    // controls.refresh(): the accessories are asked again too.
    const refreshes = (controls as unknown as { [REFRESHES]?: number })[REFRESHES] ?? 0
    if (refreshes !== lastRefresh) {
      lastRefresh = refreshes
      for (const r of rows) fillAccessory(r)
    }
    if (!initialized || moving.length > 0 || landing || turn > 0 || rebased || rows.some(fresh))
      syncResets()
    let unlocked = 0
    for (const row of rows) {
      if (!row.keys.length) continue
      const locked = row.keys.every((k) => controls.isLocked(k as keyof S & string))
      if (row.keys.some((k) => controls.canRoll(k as keyof S & string))) unlocked++
      if (row.row.classList.contains("knobs-locked") === locked) continue
      lockIcon(row.labelEl, initialized).dataset.on = String(locked)
      row.row.classList.toggle("knobs-locked", locked)
    }
    if (randomButton.disabled !== (unlocked === 0)) randomButton.disabled = unlocked === 0
    for (const [group, { button }] of groupDice) {
      const off =
        !options.groupRandom &&
        !groupKeys(group).some((k) => controls.canRoll(k as keyof S & string))
      if (button.disabled !== off) button.disabled = off
    }
    if (root.hasAttribute("data-comparing") !== controls.comparing)
      root.toggleAttribute("data-comparing", controls.comparing)
    const undoMoved = bloom(undoButton, controls.canUndo)
    if (bloom(redoButton, controls.canRedo) || undoMoved) wakeGpu()
    if (controls.error && status.textContent !== controls.error) say(controls.error, 8000)
    for (const [group, c] of groupChips) c.show(String(controls.matchingGroupPreset(group)))
    if (search) {
      const counts = new Map<string, number>()
      for (const [chip, test] of chipTests)
        counts.set(chip, rows.filter((r) => r.keys.some((k) => test(k))).length)
      search.counts(counts)
      // A chip's rows change with the values ("Modified" loses a row that's reset).
      if (search.active().size && initialized) applyVisibility("reveal")
    }
  }

  const visible = (node: HTMLElement) =>
    node.isConnected && !node.closest("[hidden],[data-leaving]") && node.getClientRects().length > 0
  const hintCtrl = createHintController(doc, root, () => wakeGpu())

  /** On a page, hints go to what's on screen below the header (and the header itself). */
  const onScreen = (node: HTMLElement) => {
    if (!page || header.contains(node)) return true
    const r = node.getBoundingClientRect()
    return (
      r.bottom > header.getBoundingClientRect().bottom + 4 && r.top < (win?.innerHeight ?? 0) - 4
    )
  }
  const win = doc.defaultView
  const collectHintTargets = (): HintTarget[] => {
    const targets: HintTarget[] = []
    const add = (node: HTMLElement, label: string, activate: () => void, labelEl?: HTMLElement) => {
      if (!label || !visible(node) || (node as HTMLButtonElement).disabled || !onScreen(node))
        return
      targets.push({ key: label, display: label, el: node, labelEl, activate })
    }
    tabStrip.buttons.forEach((b) => add(b, b.textContent ?? "", () => b.click()))
    nav?.buttons.forEach((b) =>
      add(b, b.firstChild?.textContent ?? "", () => jumpTo(b.dataset.tab!, true)),
    )
    for (const r of rows) {
      const bar = toolbars.get(r.id)
      if (bar && r.editor === bar)
        // A toolbar's buttons each take a code of their own; it presses them.
        for (const b of r.row.querySelectorAll<HTMLButtonElement>(".knobs-tool"))
          add(b, b.querySelector(".knobs-tool-label")?.textContent ?? "", () => {
            b.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
            b.click()
          })
      else add(r.row, r.display, () => r.input.focus(), r.labelEl)
    }
    for (const sh of subheads.values()) add(sh.el, sh.name, () => sh.el.focus())
    if (layout)
      for (const s of layout.sectionList())
        if (s.label?.hasAttribute("data-foldable"))
          add(
            s.label,
            sectionTitle(s.name),
            () => s.label!.focus(),
            s.label.firstElementChild as HTMLElement,
          )
    presetStrip.getEntries().forEach((entry, i) => {
      const chip = presetStrip.getButtons()[i]
      if (chip)
        add(chip, entry.label, () => {
          presetStrip.selectById(entry.id)
          presetStrip.element.focus({ preventScroll: true })
        })
    })
    // A page's group dice, resets and numbered presets have keys (g, ⌫, 1–9) instead.
    for (const b of root.querySelectorAll<HTMLButtonElement>(
      page
        ? ".knobs-head-cmd, .knobs-group-head button:not(.knobs-group-die,.knobs-group-reset,.knobs-chips button), .knobs-custom-actions button, .knobs-preset-save"
        : ".knobs-head-cmd, .knobs-group-head button, .knobs-custom-actions button, .knobs-preset-save, .knobs-popover button",
    )) {
      add(b, b.dataset.hint ?? b.getAttribute("aria-label") ?? b.textContent ?? "", () => b.focus())
    }
    // The focused card's presets, by number and name ("1 Native"), or its preset menu.
    const focusedHead = page
      ? (doc.activeElement as HTMLElement | null)
          ?.closest(".knobs-tile")
          ?.querySelector<HTMLElement>(":scope > .knobs-group-head")
      : null
    const presetUi = focusedHead ? groupChips.get(focusedHead.dataset.group ?? "") : undefined
    if (presetUi?.isMenu?.() && presetUi.menu) {
      const menuButton = presetUi.menu
      add(menuButton, menuButton.getAttribute("aria-label") ?? "Presets", () => menuButton.click())
    } else if (presetUi)
      for (const b of presetUi.buttons) add(b, b.getAttribute("aria-label") ?? "", () => b.click())
    // Controls in custom cards, by their label (or their card's title).
    if (page)
      for (const stop of body.querySelectorAll<HTMLElement>(
        ".knobs-live [data-knobs-stop]:not(.knobs-custom-actions)",
      )) {
        const label =
          stop.getAttribute("aria-label") ??
          stop.closest(".knobs-row")?.querySelector(":scope > span")?.textContent ??
          stop.closest<HTMLElement>(".knobs-live")?.dataset.card ??
          ""
        add(stop, label, () => stop.focus())
      }
    return targets
  }
  // Page-wide hint mode: this panel's targets join every other panel's and piece's on the page,
  // and draws its own badges (both renderers) with the codes the page chose.
  const unregisterHints =
    (options.hints ?? "page") === "page" && bound("hint")
      ? pageHints(doc).register(
          root,
          () =>
            collectHintTargets().map((t) => ({
              el: t.el,
              label: t.display,
              ...(t.labelEl ? { labelEl: t.labelEl } : {}),
              activate: t.activate,
            })),
          {
            rank: 0,
            paint: {
              show: (spots, codes) => hintCtrl.show(spots, codes),
              narrow: (query) => hintCtrl.narrow(query),
              clear: () => hintCtrl.stop(),
            },
          },
        )
      : undefined
  const stopHints = () => {
    if (unregisterHints) pageHints(doc).stop()
    hintCtrl.stop()
  }
  /** A page's ↑↓ stops: every row and custom control, down each column, then the next. */
  const pageStops = () => {
    const nodes: HTMLElement[] = []
    for (const r of rows) nodes.push(...(r.editor?.stops() ?? [r.input]))
    nodes.push(
      ...body.querySelectorAll<HTMLElement>(
        "[data-knobs-stop],.knobs-tile>[data-foldable],.knobs-section-head[data-foldable]",
      ),
    )
    return nodes
      .filter(visible)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  }

  const actionBarButtons = () =>
    [...customActions.querySelectorAll("button")].filter((b) => visible(b) && !b.disabled)
  let lastActionButton: HTMLButtonElement | undefined
  const stops = () => {
    const list: { contains(node: Node): boolean; focus(options?: FocusOptions): void }[] = []
    if (visible(tabStrip.element))
      list.push({
        contains: (n) => tabStrip.element.contains(n),
        focus: (o) => tabStrip.focus(o),
      })
    if (visible(presetStrip.element))
      list.push({
        contains: (n) => presetStrip.element.contains(n),
        focus: (o) => presetStrip.element.focus(o),
      })
    if (page) {
      for (const stop of pageStops())
        list.push({ contains: (n) => stop.contains(n), focus: (o) => stop.focus(o) })
      return list
    }
    // Rows keep their editor's own stop order; a foldable group's header is a stop of its own,
    // placed among them by document order, and rows in a folded card aren't stops.
    const runs: { at: HTMLElement; stops: HTMLElement[] }[] = rows.map((r) => ({
      at: r.row,
      stops: r.editor?.stops() ?? [r.input],
    }))
    for (const b of blocks)
      if (b.head?.hasAttribute("data-foldable") && !b.leaving)
        runs.push({ at: b.head, stops: [b.head] })
    for (const sh of subheads.values()) runs.push({ at: sh.el, stops: [sh.el] })
    runs.sort((a, b) =>
      a.at.compareDocumentPosition(b.at) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    for (const run of runs)
      for (const stop of run.stops.filter((s) => !s.closest('[hidden],[data-presence="out"]')))
        list.push({ contains: (n) => stop.contains(n), focus: (o) => stop.focus(o) })
    const bar = actionBarButtons()
    if (bar.length)
      list.push({
        contains: (n) => bar.some((b) => b === n),
        focus: (o) =>
          (lastActionButton && bar.includes(lastActionButton) ? lastActionButton : bar[0])?.focus(
            o,
          ),
      })
    return list
  }
  const focusables = () =>
    [
      ...root.querySelectorAll<HTMLElement>(
        "button,input:not([type=hidden]),textarea,select,[tabindex]:not([tabindex='-1'])",
      ),
    ].filter((n) => n.tabIndex >= 0 && visible(n) && !(n as HTMLButtonElement).disabled)

  // `/` filters a page's rows live: a group (or section) that matches keeps all its rows, cards
  // with nothing left fold away, and the columns re-balance.
  let filterReturn: HTMLElement | null = null
  /** The query the filter last applied, so starting, changing or clearing it can be told apart. */
  let filtered = ""
  function applyFilter() {
    if (!layout) return
    const query = filterEl.value.trim()
    if (query !== filtered) noteFold(query ? "search" : "restore")
    filtered = query
    root.toggleAttribute("data-filtering", Boolean(query))
    layout.change(() => {
      // Folded sections open while the filter runs, so their matches show.
      layout!.openFolds(Boolean(query))
      for (const r of rows) {
        const show =
          !query ||
          matchesFilter(
            query,
            r.display,
            r.key,
            r.group,
            r.group && groupTitle(r.group, r.section),
            r.group && groupDescription(r.group),
            r.section,
            r.section && sectionTitle(r.section),
            r.section && sectionDescription(r.section),
          )
        if (r.row.hidden === show) r.row.hidden = !show
      }
      for (const inner of tiles.values()) {
        const tile = inner.parentElement!
        // Rows folding away (a reshape dropped them) don't count.
        const empty = ![...inner.children].some(
          (c) => !(c as HTMLElement).hidden && (c as HTMLElement).dataset.presence !== "out",
        )
        if (tile.hidden !== empty) tile.hidden = empty
        // A folded tile opens while the filter runs, so its matches show.
        const group = tile.dataset.group
        if (group !== undefined && folds.has(group)) {
          const shut = folds.get(group)! && !query
          if (inner.hidden !== shut && !shifting.has(inner)) inner.hidden = shut
        }
      }
      for (const tile of body.querySelectorAll<HTMLElement>(".knobs-live")) {
        const hide =
          Boolean(query) &&
          !matchesFilter(
            query,
            tile.dataset.card,
            tile.querySelector(".knobs-group-label")?.textContent ?? undefined,
            tile.querySelector(":scope > .knobs-group-desc")?.textContent ?? undefined,
          )
        if (tile.hidden !== hide) tile.hidden = hide
      }
    }, [...rows.map((r) => r.row), ...[...tiles.values()].filter((c) => !shifting.has(c))])
  }
  // ——— A page's folds: summaries, sections and the jump strip ———
  const putSummary = (node: HTMLElement, content: string | Node | null) => {
    if (content === null || typeof content === "string") {
      const text = content ?? ""
      if (node.childElementCount || node.textContent !== text) node.textContent = text
    } else if (node.childNodes.length !== 1 || node.firstChild !== content)
      node.replaceChildren(content)
    const title = node.textContent ?? ""
    if (node.title !== title) node.title = title
  }
  const changedRows = (pick: (r: Row) => boolean) =>
    rows.filter((r) => pick(r) && r.keys.some((k) => controls.isModified(k as keyof S & string)))
      .length
  const groupInfo = (group: string): FoldSummaryInfo => {
    const presets = controls.groupPresets[group] ?? []
    return {
      preset: presets.length
        ? (presets[controls.matchingGroupPreset(group)]?.name ?? "Custom")
        : null,
      changed: changedRows((r) => r.group === group),
      keys: groupKeys(group),
    }
  }
  const sectionInfo = (section: string): FoldSummaryInfo => ({
    preset: null,
    changed: changedRows((r) => r.section === section),
    keys: rows.filter((r) => r.section === section).flatMap((r) => r.keys),
  })
  const changedText = (n: number) => (n && marks ? `${n} changed` : "")
  /** Brings folded cards' and sections' summaries, and the jump strip's counts, up to date. */
  function refreshFolds() {
    if (!layout || !page) return
    for (const [group, node] of groupSummaries) {
      if (!folds.get(group)) continue
      const info = groupInfo(group)
      putSummary(
        node,
        page.groupSummary
          ? page.groupSummary(group, info)
          : [info.preset, changedText(info.changed)].filter(Boolean).join(" · ") || null,
      )
    }
    for (const s of layout.sectionList()) {
      const node = s.label?.querySelector<HTMLElement>(":scope > .knobs-section-summary")
      if (!node || !s.folded) continue
      const info = sectionInfo(s.name)
      const n = s.tiles.filter((t) => !t.hidden).length
      putSummary(
        node,
        page.sectionSummary
          ? page.sectionSummary(s.name, info)
          : [changedText(info.changed), `${n} ${n === 1 ? "card" : "cards"}`]
              .filter(Boolean)
              .join(" · "),
      )
    }
    if (nav)
      for (const b of nav.buttons) {
        const n = changedRows((r) => r.section === b.dataset.tab)
        nav.count(b.dataset.tab!, marks && n ? String(n) : "", n ? `${n} changed` : "")
      }
    announceSections()
    trackSection()
  }
  /**
   * Folds a page's section to its heading or opens it. `remember: false` leaves what's
   * remembered alone (a highlight opened or closed it).
   */
  function foldSection(
    section: string,
    next: boolean,
    how: { readonly remember?: boolean; readonly animate?: boolean } = {},
  ) {
    if (!layout) return
    if (sectionState(section) !== next) noteFold(userFolding ? "user" : "code")
    const keep = how.remember ?? true
    if (keep) auto.sections.delete(section)
    layout.foldSection(section, next, how.animate ?? true)
    if (keep) foldsKept?.set("sections", section, next)
    refreshFolds()
    wakeGpu()
  }
  /** Work inside an opened section or card makes it the user's: a highlight won't fold it again. */
  const claim = (event: Event) => {
    if (!layout || !(event.target instanceof Element)) return
    const tile = event.target.closest<HTMLElement>(".knobs-tile")
    const head = event.target.closest<HTMLElement>(".knobs-section-head")
    const section = tile ? layout.sectionOf(tile) : head?.dataset.section
    if (section !== undefined) auto.sections.delete(section)
    if (!tile) return
    if (tile.dataset.group !== undefined) auto.groups.delete(tile.dataset.group)
    for (const card of auto.cards) if (card.tile === tile) auto.cards.delete(card)
  }
  /** Custom cards' folds, for a highlight's `expand`. */
  const customFolds = new Set<CustomCardFold>()

  // The jump strip: a chip per section in the header, the one in view marked as the page scrolls.
  const nav = page?.nav ? createTabStrip(doc, (id) => byUser(() => jumpTo(id))) : undefined
  if (nav) {
    nav.element.classList.add("knobs-nav")
    nav.element.setAttribute("aria-label", "Sections")
    header.append(nav.element)
    root.dataset.nav = ""
  }
  /** Set by a jump until the user scrolls: the section it went to stays marked. */
  let navForced: string | undefined
  let navFrame = 0
  // What a navigation of the host's own reads: `page.sections()`, `page.activeSection()`.
  const sectionListeners = new Set<
    (sections: readonly PageSectionInfo[], source: PageFoldSource | null) => void
  >()
  const activeListeners = new Set<(section: string | undefined) => void>()
  let lastSections = ""
  let sectionsQueued = false
  /** The section last found in view, while something tracks it (the strip or a listener). */
  let activeSectionId: string | undefined
  /** A section's own fold, apart from a running filter's opening. */
  const sectionState = (section: string) =>
    layout?.sectionList().find((s) => s.name === section)?.folded ??
    layout?.isFolded(section) ??
    false
  function describeSections(): PageSectionInfo[] {
    if (!layout) return []
    return layout
      .sectionList()
      .filter((s) => s.label)
      .map((s) => {
        const groups: PageGroupInfo[] = []
        for (const tile of s.tiles) {
          const id = tile.dataset.group
          if (id === undefined || tile.hidden || !tiles.has(id)) continue
          const info = groupInfo(id)
          groups.push({
            id,
            label: groupTitle(id, s.name),
            folded: folds.get(id) ?? false,
            changed: info.changed,
            preset: info.preset,
          })
        }
        const description = sectionDescription(s.name)
        return {
          id: s.name,
          label: sectionTitle(s.name),
          ...(description ? { description } : {}),
          folded: s.folded,
          changed: sectionInfo(s.name).changed,
          groups,
        }
      })
  }
  /** Tells `onSections` listeners, once per microtask, when what they'd read has changed. */
  function announceSections() {
    if (!sectionListeners.size || sectionsQueued) return
    sectionsQueued = true
    queueMicrotask(() => {
      sectionsQueued = false
      const list = describeSections()
      const key = JSON.stringify(list)
      const source = foldSource
      foldSource = null
      if (key === lastSections) return
      lastSections = key
      for (const listener of [...sectionListeners]) listener(list, source)
    })
  }
  function syncNav() {
    if (!layout) return
    if (!nav) {
      // Sections that came, went or moved: listeners of the page's own hear of it.
      announceSections()
      trackSection()
      return
    }
    const list = layout
      .sectionList()
      .filter((s) => s.label)
      .map((s) => ({ id: s.name, label: sectionTitle(s.name) }))
    const keep = list.some((t) => t.id === nav.active) ? nav.active : list[0]?.id
    nav.set(list, nav.active === keep ? undefined : keep)
    refreshFolds()
    trackSection()
  }
  /**
   * The section in view: the one showing the most of itself between the header and the bottom
   * of the window (the first, in reading order, of equals). Columns can set sections side by side,
   * so it's what most of the view is, not what's at the top.
   */
  const sectionInView = () => {
    if (!layout || !win) return undefined
    const top = header.getBoundingClientRect().bottom
    const bottom = win.innerHeight
    let best: string | undefined
    let most = -1
    for (const s of layout.sectionList()) {
      if (!s.label) continue
      let area = 0
      for (const node of [s.label, ...s.tiles]) {
        if (node.hidden || node.hasAttribute("data-away")) continue
        const r = node.getBoundingClientRect()
        area += Math.max(0, Math.min(bottom, r.bottom) - Math.max(top, r.top)) * r.width
      }
      if (area > most + 0.5) {
        most = area
        best = s.name
      }
    }
    return best
  }
  function trackSection() {
    if ((!nav && !activeListeners.size) || !win || navFrame) return
    navFrame = win.requestAnimationFrame(() => {
      navFrame = 0
      const id = navForced ?? sectionInView()
      if (id !== activeSectionId) {
        activeSectionId = id
        for (const listener of [...activeListeners]) listener(id)
      }
      if (id === undefined || !nav) return
      if (id !== nav.active) {
        nav.select(id, true)
        wakeGpu()
      }
      // On a narrow page the strip scrolls sideways: the marked chip stays in it.
      const on = nav.buttons.find((b) => b.dataset.tab === id)
      const strip = nav.element
      if (on && strip.scrollWidth > strip.clientWidth + 1) {
        const left = on.offsetLeft - 16
        const right = on.offsetLeft + on.offsetWidth + 16 - strip.clientWidth
        const goal =
          strip.scrollLeft > left ? left : strip.scrollLeft < right ? right : strip.scrollLeft
        if (Math.abs(goal - strip.scrollLeft) > 1)
          strip.scrollTo({ left: Math.max(0, goal), behavior: reducedMotion() ? "auto" : "smooth" })
      }
    })
  }
  /** Set while a jump moves focus, which then mustn't scroll the page on its own. */
  let jumping = false
  /** Glides the page so `node` sits just under the header, following it while it settles. */
  function glideTo(node: HTMLElement, tries = 0, since = performance.now()) {
    if (!win || !layout || !node.isConnected || touchedAt > since) return
    const headBottom = header.getBoundingClientRect().bottom
    const goal = Math.max(
      0,
      Math.min(
        layout.settled(node).top + win.scrollY - headBottom - 12,
        doc.documentElement.scrollHeight - win.innerHeight,
      ),
    )
    if (Math.abs(goal - win.scrollY) < 1) return
    scrollGoal = goal
    win.scrollTo({ top: goal, behavior: reducedMotion() ? "auto" : "smooth" })
    if (tries < 3)
      win.addEventListener("scrollend", () => glideTo(node, tries + 1, since), { once: true })
  }
  /** Glides to a section (opening it if it's folded); `focus` takes focus there too. */
  function jumpTo(section: string, focus = false) {
    if (!layout) return
    const s = layout.sectionList().find((x) => x.name === section)
    if (!s?.label) return
    if (layout.isFolded(section)) foldSection(section, false)
    navForced = section
    if (nav && nav.active !== section) nav.select(section, true)
    if (focus) {
      const head = s.label.hasAttribute("data-foldable") ? s.label : undefined
      const target = head ?? pageStops().find((n) => s.tiles.some((t) => t.contains(n)))
      jumping = true
      target?.focus({ preventScroll: true })
      jumping = false
    }
    glideTo(s.label)
    wakeGpu()
  }
  /** ⌥↑ / ⌥↓: the section before or after the one focused (or in view). */
  function stepSection(direction: -1 | 1) {
    if (!layout) return
    const list = layout.sectionList().filter((s) => s.label)
    if (!list.length) return
    const active = doc.activeElement as HTMLElement | null
    const tile = active?.closest<HTMLElement>(".knobs-tile")
    const current =
      (tile && layout.sectionOf(tile)) ??
      active?.closest<HTMLElement>(".knobs-section-head")?.dataset.section ??
      nav?.active ??
      sectionInView()
    const at = list.findIndex((s) => s.name === current)
    const next =
      at < 0
        ? direction > 0
          ? 0
          : list.length - 1
        : Math.max(0, Math.min(list.length - 1, at + direction))
    jumpTo(list[next]!.name, true)
  }

  function openFilter() {
    if (!(doc.activeElement === filterEl)) filterReturn = doc.activeElement as HTMLElement | null
    filterEl.dataset.open = ""
    filterEl.tabIndex = 0
    filterEl.focus({ preventScroll: true })
    filterEl.select()
    wakeGpu()
  }
  function closeFilter(clear: boolean) {
    if (clear && filterEl.value) {
      filterEl.value = ""
      applyFilter()
    }
    if (filterEl.value) return
    delete filterEl.dataset.open
    filterEl.tabIndex = -1
    if (doc.activeElement === filterEl) {
      const back = filterReturn?.isConnected && visible(filterReturn) ? filterReturn : null
      if (back) back.focus({ preventScroll: true })
      else filterEl.blur()
    }
    wakeGpu()
  }
  if (page && page.filter !== false) {
    filterEl.addEventListener("input", applyFilter)
    filterEl.addEventListener("keydown", (event) => {
      if (event.isComposing) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        closeFilter(true)
      } else if (event.key === "Enter" || event.key === "ArrowDown") {
        // On to the first row that's left.
        event.preventDefault()
        event.stopPropagation()
        pageStops()[0]?.focus({ preventScroll: true })
      }
    })
    filterEl.addEventListener("blur", () => setTimeout(() => closeFilter(false)))
  }

  // `/` focuses the search; Esc clears it, then hands focus back; ↓ and Enter go to the rows left.
  let searchReturn: HTMLElement | null = null
  search?.input.addEventListener("keydown", (event) => {
    if (event.isComposing) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (search.filtering()) return search.clear()
      const back = searchReturn?.isConnected && visible(searchReturn) ? searchReturn : null
      if (back) back.focus({ preventScroll: true })
      else search.input.blur()
    } else if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault()
      event.stopPropagation()
      rows.find((r) => visible(r.input))?.input.focus({ preventScroll: true })
    }
  })

  /** The group of the focused row, group header or card. */
  const focusedGroup = (target: HTMLElement) =>
    rows[rowAt(target)]?.group ??
    target.closest<HTMLElement>(".knobs-group-head,.knobs-tile,.knobs-card")?.dataset.group

  // ——— Focus scope: a row, its card, or the panel (see scope.ts) ———
  /** The card `node` sits in (a page's tile, a panel's card); a group's heading stands for its card. */
  const cardOf = (node: Node | null): HTMLElement | null => {
    if (!(node instanceof Element) || !root.contains(node)) return null
    if (page) return node.closest<HTMLElement>(".knobs-tile")
    const head = node.closest<HTMLElement>(".knobs-group-head")
    if (head) return blocks.find((b) => b.head === head)?.card ?? null
    return node.closest<HTMLElement>(".knobs-card")
  }
  const focusLevel = (node: Node | null): FocusLevel => {
    if (!node || !root.contains(node)) return "none"
    if (rowAt(node) >= 0) return "row"
    return cardOf(node) ? "card" : "panel"
  }
  const scopeAt = (node: Node | null) => commandScope(focusLevel(node), selected.size > 0)
  /** Random (or Mutate, `nudge`) for what focus is on: its row, its card, else everything. */
  const rollFrom = (target: Node | null, nudge: boolean) => {
    const scope = scopeAt(target)
    if (scope === "selection") return reroll(selectionKeys(), nudge)
    if (scope === "all") return reroll(undefined, nudge)
    if (scope === "row") {
      const r = rows[rowAt(target)]!
      // The row's group die tumbles for it, if it has one: the header's means everything.
      return reroll(r.keys, nudge, (r.group && groupDice.get(r.group)?.die) || die)
    }
    const card = cardOf(target)!
    const group = card.dataset.group
    if (group && groupDice.has(group)) return rerollGroup(group, nudge)
    reroll(cardKeys(card), nudge)
  }
  /** ⇧R for what focus is on, as R picks it. */
  const resetFrom = (target: Node | null) => {
    const scope = scopeAt(target)
    if (scope === "all") return resetAll()
    cue(root, "reset")
    if (scope === "selection") return controls.reset(selectionKeys())
    if (scope === "row") return controls.reset(keysOf([rowAt(target)]))
    const card = cardOf(target)!
    const keys = cardKeys(card) as (keyof S & string)[]
    // A group's card turns the group's ↺, as its click would, and resets as it does.
    const gReset = card.dataset.group ? groupResetButtons.get(card.dataset.group) : undefined
    if (gReset?.dataset.shown === "true") spin(gReset, wakeGpu, syncResets)
    if (gReset && card.dataset.group) controls.resetGroup(card.dataset.group)
    else if (keys.length) controls.reset(keys)
  }
  const cardKeys = (card: HTMLElement) =>
    rows.filter((r) => card.contains(r.row)).flatMap((r) => r.keys)
  /** Esc from a row or card: up a level, to the card and then the panel itself. */
  const climb = (target: Node | null) => {
    const level = focusLevel(target)
    const card = level === "row" ? cardOf(target) : null
    const next = escapeTo(level, card !== null)
    const quiet = { preventScroll: true } as FocusOptions
    if (next === "card") card!.focus(quiet)
    else if (next === "panel") root.focus(quiet)
  }
  const optionKeys = createOptionKeys(doc, root, () => wakeGpu())
  root.tabIndex = -1
  // The card focus is on wears a soft wash (data-k-scope), both renderers; a row's own focus
  // wash is the card children's (see styles).
  let scoped: HTMLElement | null = null
  const syncScope = () => {
    const active = doc.activeElement
    const card = focusLevel(active) === "card" ? cardOf(active) : null
    if (card !== scoped) {
      scoped?.removeAttribute("data-k-scope")
      card?.setAttribute("data-k-scope", "")
      scoped = card
      wakeGpu()
    }
    if (!popover.hidden) describeScope()
    optionKeys.show(optionsAt(active))
  }
  let scopeQueued = false
  const queueScope = () => {
    if (scopeQueued) return
    scopeQueued = true
    queueMicrotask(() => {
      scopeQueued = false
      syncScope()
    })
  }
  root.addEventListener("focusin", queueScope)
  root.addEventListener("focusout", queueScope)
  root.addEventListener("click", queueScope)
  root.addEventListener("keyup", queueScope)
  // The digits ride along when the rows scroll under them.
  root.addEventListener("scroll", queueScope, { capture: true, passive: true })
  // A row's options as the digits pick them: a choice's, or an editor's presets.
  const choiceOptions = new WeakMap<Row, RowOptions>()
  const optionsOf = (r: Row): RowOptions | undefined => {
    if (r.editor?.options) return r.editor.options
    const control = r.choice
    if (!control || r.field.kind !== "choice") return undefined
    let o = choiceOptions.get(r)
    if (!o) {
      const values = r.field.options
      o = {
        count: values.length,
        choose: (i) => run(() => r.set(values[i])),
        shown: () => (control.isMenu() ? [] : control.buttons),
        anchor: control.menu,
      }
      choiceOptions.set(r, o)
    }
    return o
  }
  const optionsAt = (node: Element | null) => {
    if (hintCtrl.isActive || !node || !root.contains(node)) return undefined
    const r = rows[rowAt(node)]
    if (!r || r.row.closest("[data-disabled],[data-readonly]")) return undefined
    return optionsOf(r)
  }
  /** 1–9 on a row with options pick the nth; the row takes the digits even past its last. */
  const pickOption = (event: KeyboardEvent) => {
    if (!/^[1-9]$/.test(event.key) || event.altKey || event.shiftKey) return false
    const target = event.target as HTMLElement
    const r = rows[rowAt(target)]
    const o = r && optionsOf(r)
    if (!o) return false
    event.preventDefault()
    event.stopPropagation()
    const i = digitOption(event.key, o.count)
    if (i !== undefined && !r.row.closest("[data-disabled],[data-readonly]")) o.choose(i)
    return true
  }
  // A read-only field takes no typing, so the page's shortcuts still reach past it.
  const isTyping = (target: EventTarget | null) =>
    (target instanceof HTMLTextAreaElement && !target.readOnly) ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable) ||
    (target instanceof HTMLInputElement &&
      !target.readOnly &&
      !["range", "checkbox", "radio", "button"].includes(target.type))
  /**
   * Presses the toolbar button whose shortcut this is: any of them while the panel has focus,
   * only page-scoped ones (`global`) from elsewhere on the page, and never a chip-only one
   * (`scope: "none"`). A disabled toolbar row takes none.
   */
  const pressTool = (event: KeyboardEvent, inPanel: boolean) => {
    if (event.repeat) return false
    // Enter and Space still press the focused button (or toggle, or tab) itself.
    if (
      (event.key === "Enter" || event.key === " ") &&
      (event.target as Element | null)?.closest?.("button,[role=button],[role=switch],[role=tab]")
    )
      return false
    for (const bar of toolbars.values()) {
      if (bar.row.hasAttribute("data-disabled") || bar.row.hasAttribute("data-readonly")) continue
      const item: ToolbarItem | undefined =
        (inPanel ? bar.match(event, false) : undefined) ?? bar.match(event, true)
      if (!item) continue
      event.preventDefault()
      bar.press(item)
      return true
    }
    for (const [key, { row, button }] of keyedActions) {
      if (row.row.hasAttribute("data-disabled") || row.row.hasAttribute("data-readonly")) continue
      const where = actionKey(key, row.field as ActionField)
      if (!where || where.scope === "none" || (where.scope === "panel" && !inPanel)) continue
      if (!matchesCombo(where.key, event)) continue
      event.preventDefault()
      if (!reducedMotion()) {
        button.classList.add("knobs-pressed")
        setTimeout(() => button.classList.remove("knobs-pressed"), 140)
      }
      cue(root, "press")
      run(() => controls.action(key as keyof S & string))
      wakeGpu()
      return true
    }
    return false
  }
  const onGlobalKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || (!toolbars.size && !keyedActions.size))
      return
    const target = event.target as Node | null
    if (target && root.contains(target)) return
    if (isTyping(target)) return
    pressTool(event, false)
  }
  doc.addEventListener("keydown", onGlobalKey)
  // Keys the panel handles stop here, so a host's own window-level shortcuts don't see them too.
  root.onkeydown = (event) => {
    onKey(event)
    if (event.defaultPrevented) event.stopPropagation()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.isComposing) return
    const target = event.target as HTMLElement
    const typing = isTyping(target)
    // A focused row's options take the digits; then a toolbar's shortcuts, ⌘ combinations included.
    if (!typing && !hintCtrl.isActive && !event.metaKey && !event.ctrlKey && pickOption(event))
      return
    if (!typing && !hintCtrl.isActive && pressTool(event, true)) return
    if (event.metaKey || event.ctrlKey) return
    if (event.altKey) {
      // ⌥R and ⌥G mutate (by code: ⌥ changes the character on macOS).
      if (typing || hintCtrl.isActive) return
      // ⌥↑ / ⌥↓ go to the section before or after.
      if (layout && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault()
        byUser(() => stepSection(event.key === "ArrowUp" ? -1 : 1))
        return
      }
      // ⌥1–9 show a tab.
      const digit = /^Digit([1-9])$/.exec(event.code)
      if (digit && tabStrip.tabs.length > 1) {
        const tab = tabStrip.tabs[Number(digit[1]) - 1]
        if (tab) {
          event.preventDefault()
          selectTab(tab.id)
        }
        return
      }
      const all = pressedAlt("mutate", event)
      const group =
        !all && bound("mutate") && pressedAlt("group", event) ? focusedGroup(target) : undefined
      if (!all && !group) return
      event.preventDefault()
      if (all) run(() => rollFrom(target, true))
      else if (group) run(() => rerollGroup(group, true))
      return
    }
    if (hintCtrl.handleKey(event)) return
    if (event.key === "Escape") {
      if (!popover.hidden) {
        event.preventDefault()
        event.stopPropagation()
        togglePopover(false)
        helpButton?.focus({ preventScroll: true })
        return
      }
      if (selected.size && !typing) {
        event.preventDefault()
        event.stopPropagation()
        clearSelection()
        return
      }
      if (page && filterEl.value && !typing) {
        event.preventDefault()
        event.stopPropagation()
        closeFilter(true)
        return
      }
      // Up a level a press: a row to its card, the card to the panel; from there, out.
      const level = typing ? "none" : focusLevel(target)
      if (level === "row" || level === "card") {
        event.preventDefault()
        event.stopPropagation()
        climb(target)
        return
      }
      if (page && level === "panel") {
        event.preventDefault()
        ;(doc.activeElement as HTMLElement | null)?.blur()
        return
      }
      if (close) {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
    }
    // An inline panel's Esc hands focus back to the page (Tab or the host's own key brings it back).
    if (!close && !page && !typing && pressed("leave", event)) {
      const active = doc.activeElement as HTMLElement | null
      if (active && root.contains(active)) {
        event.preventDefault()
        active.blur()
      }
      return
    }
    if (event.key === "Tab" && page && !typing) {
      // Tab and ⇧Tab go from group to group.
      event.preventDefault()
      const cardsNow = [
        ...body.querySelectorAll<HTMLElement>(".knobs-tile,.knobs-section-head[data-folded]"),
      ].filter(visible)
      const nodes = pageStops()
      const step = event.shiftKey ? -1 : 1
      let at = cardsNow.indexOf(
        target.closest<HTMLElement>(".knobs-tile,.knobs-section-head[data-folded]")!,
      )
      // From the header, Tab lands on what's on screen first (the highlighted cards).
      const lit = cardsNow.findIndex((c) => c.classList.contains("knobs-highlighted"))
      if (at < 0 && step > 0 && lit >= 0) at = lit - 1
      for (let n = 0; n < cardsNow.length; n++) {
        at =
          at < 0
            ? step > 0
              ? 0
              : cardsNow.length - 1
            : (at + step + cardsNow.length) % cardsNow.length
        const first = nodes.find((node) => cardsNow[at]!.contains(node))
        if (first) {
          wholeCard = true
          first.focus({ preventScroll: true })
          wholeCard = false
          break
        }
      }
      return
    }
    if (event.key === "Tab" && !inline) {
      const list = focusables()
      const at = list.indexOf(target)
      // From the panel or a card, Tab goes on from there as the browser takes it.
      const between = target === root || cardOf(target) === target
      if (list.length && ((at < 0 && !between) || at === (event.shiftKey ? 0 : list.length - 1))) {
        event.preventDefault()
        list[event.shiftKey ? list.length - 1 : 0]!.focus()
      }
      return
    }
    if (typing) return
    const key = event.key
    if (target.dataset.subhead !== undefined) {
      // A sub-heading folds as a group's header does.
      const id = target.dataset.subhead
      const toggle = key === "Enter" || key === " "
      const shut = key === "ArrowLeft" || (prefs.vim && key === "h")
      const open = key === "ArrowRight" || (prefs.vim && key === "l")
      if (toggle || shut || open) {
        event.preventDefault()
        foldSub(id, toggle ? !subFolds.get(id) : shut)
        return
      }
    }
    if (target.hasAttribute("data-foldable") && target.dataset.section !== undefined && layout) {
      // A section's heading folds its cards as a group's header does.
      const section = target.dataset.section
      const toggle = key === "Enter" || key === " "
      const shut = key === "ArrowLeft" || (prefs.vim && key === "h")
      const open = key === "ArrowRight" || (prefs.vim && key === "l")
      if (toggle || shut || open) {
        event.preventDefault()
        byUser(() => foldSection(section, toggle ? !layout!.isFolded(section) : shut))
        return
      }
    }
    if (target.hasAttribute("data-foldable") && target.dataset.group !== undefined) {
      // Enter or Space toggles a group's card; ← folds it and → opens it.
      const group = target.dataset.group
      const toggle = key === "Enter" || key === " "
      const shut = key === "ArrowLeft" || (prefs.vim && key === "h")
      const open = key === "ArrowRight" || (prefs.vim && key === "l")
      if (toggle || shut || open) {
        event.preventDefault()
        byUser(() => fold(group, toggle ? !folds.get(group) : shut))
        return
      }
    }
    if (bound("menu") && (key === "ContextMenu" || (key === "F10" && event.shiftKey))) {
      event.preventDefault()
      event.stopPropagation()
      menuFromKeyboard()
      return
    }
    if (pressed("compare", event)) {
      // Held: the values from before the last change; released on keyup or blur.
      event.preventDefault()
      if (!event.repeat) controls.compare(true)
      return
    }
    if (pressed("help", event) && showFooter) {
      event.preventDefault()
      event.stopPropagation()
      togglePopover()
      return
    }
    if (pressed("presets", event)) {
      // [ and ] cycle the presets while there are some to cycle; otherwise the tabs.
      const direction = key === keys.presets[0] ? -1 : 1
      const presetsShown = visible(presetStrip.element) && presetStrip.getEntries().length > 1
      if (presetsShown) presetStrip.cycle(direction)
      else if (!cycleTab(direction)) return
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (pressed("redo", event)) {
      event.preventDefault()
      redo()
      return
    }
    if (pressed("undo", event)) {
      event.preventDefault()
      undo()
      return
    }
    if (pressed("first", event)) {
      event.preventDefault()
      rows.find((r) => visible(r.input))?.input.focus(page ? { preventScroll: true } : undefined)
      return
    }
    if (key === "/" && page && page.filter !== false) {
      event.preventDefault()
      openFilter()
      return
    }
    if (key === "/" && search) {
      event.preventDefault()
      searchReturn = target
      search.focus()
      return
    }
    if (page && /^[1-9]$/.test(key)) {
      // A page's digits pick the focused group's numbered preset (where it has them).
      const group = focusedGroup(target)
      if (group && groupChips.has(group)) {
        event.preventDefault()
        run(() => applyGroupPreset(group, Number(key) - 1))
        return
      }
    }
    if (pressed("hint", event)) {
      event.preventDefault()
      hintScrollY = win?.scrollY ?? 0
      if (!unregisterHints || !pageHints(doc).start()) hintCtrl.start(collectHintTargets())
      return
    }
    if (pressed("resetAll", event)) {
      event.preventDefault()
      run(() => resetFrom(target))
      return
    }
    if (pressed("random", event)) {
      event.preventDefault()
      run(() => rollFrom(target, false))
      return
    }
    if (pressed("group", event) && bound("random")) {
      const group = focusedGroup(target)
      if (group) {
        event.preventDefault()
        run(() => rerollGroup(group, false))
      }
      return
    }
    if (pressed("lock", event)) {
      event.preventDefault()
      toggleLock()
      return
    }
    if (pressed("copy", event)) {
      event.preventDefault()
      const keys = selectionKeys()
      if (keys) copyKeys(keys)
      else copyValues()
      return
    }
    if (pressed("save", event) && showVariants) {
      event.preventDefault()
      presetStrip.save()
      return
    }
    const index = rowAt(target)
    if (pressed("reset", event) && !(target instanceof HTMLInputElement)) {
      const chosen = selectionKeys() ?? (index >= 0 ? keysOf([index]) : undefined)
      if (chosen?.length) {
        event.preventDefault()
        cue(root, "reset")
        run(() => controls.reset(chosen))
      }
      return
    }
    if ((key === "ArrowDown" || key === "ArrowUp") && event.shiftKey && index >= 0) {
      event.preventDefault()
      event.stopPropagation()
      if (!selected.size || anchor < 0) anchor = head = index
      head = Math.max(0, Math.min(rows.length - 1, head + (key === "ArrowDown" ? 1 : -1)))
      selectRange(anchor, head)
      focusRow(head)
      return
    }
    const down = key === "ArrowDown" || (prefs.vim && key === "j")
    const up = key === "ArrowUp" || (prefs.vim && key === "k")
    const right = key === "ArrowRight" || (prefs.vim && key === "l")
    const left = key === "ArrowLeft" || (prefs.vim && key === "h")
    const bar = actionBarButtons()
    const barIndex = bar.indexOf(target as HTMLButtonElement)
    if (barIndex >= 0) lastActionButton = bar[barIndex]
    if (up || down) {
      event.preventDefault()
      event.stopPropagation()
      const list = stops()
      const at = list.findIndex((stop) => stop.contains(target))
      // From a card, into its first row (or, going up, its last).
      if (at < 0 && cardOf(target) === target) {
        const inside = rows.filter((r) => target.contains(r.row) && visible(r.input))
        const r = down ? inside[0] : inside.at(-1)
        if (r) return void r.input.focus(page ? { preventScroll: true } : undefined)
      }
      const step = at + (down ? 1 : -1)
      const next =
        at < 0
          ? down
            ? 0
            : list.length - 1
          : prefs.wrap
            ? (step + list.length) % list.length
            : Math.max(0, Math.min(list.length - 1, step))
      list[next]?.focus(page ? { preventScroll: true } : undefined)
    } else if ((left || right) && barIndex >= 0) {
      event.preventDefault()
      event.stopPropagation()
      bar[(barIndex + (right ? 1 : -1) + bar.length) % bar.length]?.focus()
    } else if ((left || right) && tracks.has(target)) {
      event.preventDefault()
      event.stopPropagation()
      const t = tracks.get(target)!
      const next = stepValue(
        t.field,
        t.get(),
        (right ? 1 : -1) * (event.shiftKey ? prefs.bigStep : 1),
      )
      // An arrow against an end meets it, as a pan's give does.
      if (next === t.get()) cue(root, "limit")
      t.set(next)
    } else if (
      (left || right) &&
      index >= 0 &&
      target === rows[index]!.input &&
      rows[index]!.keys.length
    ) {
      event.preventDefault()
      event.stopPropagation()
      const row = rows[index]!,
        field = row.field,
        value = controls.get()[row.key]
      const direction = right ? 1 : -1
      if (field.kind === "choice")
        row.set(
          field.options[
            (field.options.indexOf(String(value)) + direction + field.options.length) %
              field.options.length
          ],
        )
      else if (field.kind === "toggle") row.set(!value)
    } else if (prefs.edit && tracks.has(target) && /^[0-9.\-]$/.test(event.key)) {
      event.preventDefault()
      const { slider } = tracks.get(target)!
      slider.edit(event.key)
    }
  }

  // Disabled and read-only rows take no edits: pointer presses, clicks, wheel pans and edit keys
  // stop at the panel (a press still focuses the row, to read it). Navigation, commands that
  // skip them on their own (Random, Reset) and the row's accessory work as ever.
  const blockedAt = (node: EventTarget | null) => {
    const at = node instanceof Element ? node : null
    if (!at || at.closest(".knobs-accessory")) return false
    const row = at.closest<HTMLElement>("[data-disabled],[data-readonly]")
    return Boolean(row && root.contains(row))
  }
  root.addEventListener(
    "pointerdown",
    (event) => {
      if (!blockedAt(event.target) || event.shiftKey || event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      const at = rowAt(event.target as Node)
      rows[at]?.input.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    },
    true,
  )
  for (const type of ["click", "dblclick"])
    root.addEventListener(
      type,
      (event) => {
        if (!blockedAt(event.target)) return
        event.preventDefault()
        event.stopPropagation()
      },
      true,
    )
  root.addEventListener(
    "wheel",
    (event) => {
      if (blockedAt(event.target)) event.stopPropagation()
    },
    { capture: true, passive: true },
  )
  root.addEventListener(
    "keydown",
    (event) => {
      if (!blockedAt(event.target) || event.metaKey || event.ctrlKey || event.isComposing) return
      const k = event.key
      const edit =
        ["ArrowLeft", "ArrowRight", "Enter", " ", "Home", "End", "PageUp", "PageDown"].includes(
          k,
        ) ||
        (prefs.vim && (k === "h" || k === "l")) ||
        (!event.altKey && /^[0-9.\-]$/.test(k)) ||
        pressed("reset", event)
      if (!edit) return
      event.preventDefault()
      event.stopPropagation()
    },
    true,
  )

  // Keys take over from the pointer: until it moves again, the row it rests on shows no hover wash
  // (see keyboardQuietsHover in styles.ts), so the only wash is the keyboard's focus.
  let pointerAt = ""
  const quieted: Element[] = []
  const quiet = (from: Element | null) => {
    // Up to the first one already quiet: its ancestors are too.
    for (let at = from; at && root.contains(at); at = at === root ? null : at.parentElement) {
      if (at.hasAttribute("data-k-quiet")) break
      at.setAttribute("data-k-quiet", "")
      quieted.push(at)
    }
  }
  const keyboardOn = (on: boolean) => {
    if ("keyboard" in root.dataset === on) return
    if (on) {
      root.dataset.keyboard = ""
      quiet(root)
      for (const el of root.querySelectorAll(":hover")) quiet(el)
    } else {
      delete root.dataset.keyboard
      for (const el of quieted.splice(0)) el.removeAttribute("data-k-quiet")
    }
    wakeGpu()
  }
  // Scrolling under the still pointer moves the hover; what it reaches stays quiet too.
  root.addEventListener("pointerover", (event) => {
    if ("keyboard" in root.dataset) quiet(event.target as Element)
  })
  root.addEventListener(
    "keydown",
    (event) => {
      if (!["Shift", "Alt", "Meta", "Control", "CapsLock"].includes(event.key)) keyboardOn(true)
    },
    true,
  )
  root.addEventListener("pointermove", (event) => {
    // Scrolling under a still pointer sends moves too; only a real move hands back to the pointer.
    const at = `${event.screenX},${event.screenY}`
    if (at === pointerAt) return
    pointerAt = at
    keyboardOn(false)
  })
  root.addEventListener("pointerdown", () => keyboardOn(false), true)

  const raise = () => {
    if (!inline) {
      root.style.zIndex = String(++layer)
      wakeGpu()
    }
  }
  root.onpointerdown = raise
  // ⇧ and ⌘ clicks select instead of reaching the control, so a slider never jumps; a plain
  // click anywhere clears the selection.
  let swallowClick = false
  root.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return
      const at = rowAt(event.target as Node)
      if (at < 0 || !(event.shiftKey || event.metaKey)) {
        if (!event.shiftKey && !event.metaKey) clearSelection()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      swallowClick = true
      if (event.metaKey) {
        if (selected.has(at)) selected.delete(at)
        else {
          // ⌘ on a lone focused row keeps it and adds this one.
          const focused = rowAt(doc.activeElement)
          if (!selected.size && focused >= 0 && focused !== at) selected.add(focused)
          selected.add(at)
        }
        anchor = head = at
        paintSelection()
      } else {
        if (anchor < 0 || !selected.size) {
          const focused = rowAt(doc.activeElement)
          anchor = focused >= 0 ? focused : at
        }
        head = at
        selectRange(anchor, head)
      }
      focusRow(at)
    },
    true,
  )
  root.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) return
      swallowClick = false
      event.preventDefault()
      event.stopPropagation()
    },
    true,
  )
  root.addEventListener("contextmenu", (event) => {
    const at = rowAt(event.target as Node)
    if (at < 0 || !bound("menu") || !rows[at]!.keys.length) return
    event.preventDefault()
    if (!selected.has(at)) {
      anchor = head = at
      selectRange(at, at)
    }
    showMenu({ x: event.clientX, y: event.clientY }, false, at)
  })
  const endCompare = (event: Event) => {
    if (event.type === "blur" || (event as KeyboardEvent).key === "\\") controls.compare(false)
  }
  doc.addEventListener("keyup", endCompare, true)
  doc.defaultView?.addEventListener("blur", endCompare)
  if (remember) {
    root.addEventListener("focusin", (event) => {
      const stop = stops().findIndex((s) => s.contains(event.target as Node))
      if (stop >= 0) writeSession(controls.id, { focus: { inline, stop } })
    })
    // Focus leaving for somewhere else on the page is forgotten; the window losing it isn't.
    root.addEventListener("focusout", () =>
      setTimeout(() => {
        if (!root.isConnected || !doc.hasFocus() || root.contains(doc.activeElement)) return
        if (readSession(controls.id).focus?.inline === inline)
          writeSession(controls.id, { focus: undefined })
      }),
    )
  }
  // While a control is dragged, token transitions shorten (see --k-token-t) so a slider that
  // tunes the panel itself still tracks the pointer. Releasing restores the spring first.
  const html = doc.documentElement
  let pressAt: [number, number] | undefined
  const endScrub = () => {
    pressAt = undefined
    if (html.hasAttribute("data-knobs-scrub")) html.removeAttribute("data-knobs-scrub")
    setTimeout(letGo)
  }
  root.addEventListener("pointerdown", (e) => (pressAt = [e.clientX, e.clientY]), true)
  root.addEventListener(
    "pointermove",
    (e) => {
      if (!pressAt || !(e.buttons & 1) || html.hasAttribute("data-knobs-scrub")) return
      if (Math.abs(e.clientX - pressAt[0]) + Math.abs(e.clientY - pressAt[1]) < 3) return
      html.setAttribute("data-knobs-scrub", "")
    },
    true,
  )
  root.addEventListener("lostpointercapture", endScrub, true)
  // A drag that starts in the panel can end anywhere (over the page, outside the window), so the
  // release is heard on the document; otherwise the flag would outlive the drag and every later
  // token change would skip its glide.
  for (const type of ["pointerup", "pointercancel"]) doc.addEventListener(type, endScrub, true)
  doc.defaultView?.addEventListener("blur", endScrub)
  root.addEventListener("focusin", raise)

  // A page scrolls the window: focus that lands out of view (or under the header) glides into it,
  // retargeting from where the last glide was headed so held keys don't fall behind.
  let scrollGoal: number | undefined
  /** Set while Tab moves to a group, which brings the whole card into view where it fits. */
  let wholeCard = false
  let hintScrollY = 0
  // When the user last scrolled, pressed a key or touched the page (a highlight's reveal waits).
  let touchedAt = -Infinity
  let pointersDown = 0
  const touched = () => {
    touchedAt = performance.now()
    navForced = undefined
  }
  const onPointerDown = () => {
    pointersDown++
    touched()
  }
  const onPointerUp = () => (pointersDown = Math.max(0, pointersDown - 1))
  const onScroll = () => {
    if (!win) return
    // Scrolls the page makes itself (focus gliding into view, a reveal) have a goal.
    if (scrollGoal === undefined) touched()
    const scrolled = body.getBoundingClientRect().top < header.getBoundingClientRect().bottom - 1
    if (header.hasAttribute("data-scrolled") !== scrolled)
      header.toggleAttribute("data-scrolled", scrolled)
    if (hintCtrl.isActive && Math.abs(win.scrollY - hintScrollY) > 24) stopHints()
    trackSection()
  }
  const onScrollEnd = () => (scrollGoal = undefined)
  const bringIntoView = (top: HTMLElement, bottom: HTMLElement) => {
    if (!win) return
    const margin = 12
    const headBottom = header.getBoundingClientRect().bottom
    const base = scrollGoal ?? win.scrollY
    const docTop = top.getBoundingClientRect().top + win.scrollY
    const docBottom = bottom.getBoundingClientRect().bottom + win.scrollY
    let goal = base
    if (docTop < base + headBottom + margin) goal = docTop - headBottom - margin
    else if (docBottom > base + win.innerHeight - margin)
      goal = Math.min(docTop - headBottom - margin, docBottom - win.innerHeight + margin)
    goal = Math.max(0, Math.min(goal, doc.documentElement.scrollHeight - win.innerHeight))
    if (Math.abs(goal - base) < 1) return
    scrollGoal = goal
    const still = win.matchMedia("(prefers-reduced-motion: reduce)").matches
    win.scrollTo({ top: goal, behavior: still ? "auto" : "smooth" })
  }
  const headSize = new ResizeObserver(() => {
    header.toggleAttribute("data-narrow", header.clientWidth > 0 && header.clientWidth < 560)
    root.style.setProperty("--k-head-h", `${Math.round(header.getBoundingClientRect().height)}px`)
  })
  // Cards that change size (an editor opening, a custom card's content) move the ones below.
  const tileSizes = new ResizeObserver(() => {
    layoutTick++
    wakeGpu()
  })
  if (page) {
    win?.addEventListener("scroll", onScroll, { passive: true })
    win?.addEventListener("scrollend", onScrollEnd)
    for (const type of ["wheel", "touchstart", "keydown"])
      doc.addEventListener(type, touched, { capture: true, passive: true })
    doc.addEventListener("pointerdown", onPointerDown, true)
    for (const type of ["pointerup", "pointercancel"]) doc.addEventListener(type, onPointerUp, true)
    root.addEventListener("focusin", (event) => {
      const t = event.target as HTMLElement
      if (jumping || header.contains(t) || popover.contains(t) || !body.contains(t)) return
      // A card taking focus (a click in it, Esc from a row) is already where the eye is.
      if (t.classList.contains("knobs-tile")) return
      const item =
        t.closest<HTMLElement>(".knobs-card > *") ??
        t.closest<HTMLElement>("[data-knobs-stop]") ??
        t
      // A card's first row brings the card's header along.
      const tile = t.closest<HTMLElement>(".knobs-tile")
      const firstRow = tile?.querySelector(".knobs-card > :not([hidden])")
      const fits =
        tile &&
        tile.getBoundingClientRect().height <
          (win?.innerHeight ?? 0) - header.getBoundingClientRect().bottom - 24
      bringIntoView(
        tile && (firstRow === item || (wholeCard && fits)) ? tile : item,
        wholeCard && fits ? tile! : item,
      )
    })
    for (const tile of body.querySelectorAll<HTMLElement>(".knobs-tile")) tileSizes.observe(tile)
    // The floating shortcuts sit just under the header, however tall it is.
    headSize.observe(header)
    // A section's heading folds it; work inside what a highlight opened makes it the user's.
    body.addEventListener("click", (event) => {
      const head = (event.target as Element).closest<HTMLElement>(
        ".knobs-section-head[data-foldable]",
      )
      if (!head || !layout || (event.target as Element).closest("button,a,input")) return
      const section = head.dataset.section!
      byUser(() => foldSection(section, !layout!.isFolded(section)))
    })
    body.addEventListener("pointerdown", claim, true)
    body.addEventListener("keydown", claim, true)
    layout?.pack(true)
  }
  // Rows in hand (a drag, an inline edit) hold their key against incoming values until let go.
  const inHand = new Set<string>()
  const grab = (target: EventTarget | null) => {
    if (blockedAt(target) || (target instanceof Element && target.closest(".knobs-accessory")))
      return
    const at = rowAt(target as Node | null)
    for (const k of rows[at]?.keys ?? []) {
      inHand.add(k)
      controls.hold(k)
    }
  }
  let pressing = false
  const letGo = () => {
    if (
      !inHand.size ||
      pressing ||
      root.querySelector(":is(.knobs-number,.knobs-cell-edit):not([hidden])")
    )
      return
    const held = [...inHand]
    inHand.clear()
    for (const k of held) controls.hold(k, false)
  }
  root.addEventListener(
    "pointerdown",
    (event) => {
      pressing = true
      grab(event.target)
    },
    true,
  )
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    root.addEventListener(type, () => setTimeout(letGo))
  // Wherever the press ends (a drag let go outside the panel too).
  const pressEnded = () => {
    if (!pressing) return
    pressing = false
    setTimeout(letGo)
  }
  for (const type of ["pointerup", "pointercancel"]) doc.addEventListener(type, pressEnded, true)
  // A burst of arrow keys on a row (held down, or pressed again and again) is one gesture too:
  // its key is in hand from the first press until the keys have been up for a moment.
  const NUDGE_KEYS = new Set(["ArrowLeft", "ArrowRight", "PageUp", "PageDown"])
  let nudgeEnd: ReturnType<typeof setTimeout> | undefined
  root.addEventListener(
    "keydown",
    (event) => {
      if (!NUDGE_KEYS.has(event.key) || event.metaKey || event.ctrlKey) return
      clearTimeout(nudgeEnd)
      grab(event.target)
    },
    true,
  )
  root.addEventListener("keyup", (event) => {
    if (!NUDGE_KEYS.has(event.key)) return
    clearTimeout(nudgeEnd)
    nudgeEnd = setTimeout(letGo, NUDGE_BURST_MS)
  })
  root.addEventListener("focusout", () => {
    clearTimeout(nudgeEnd)
    setTimeout(letGo)
  })
  const isEditField = (node: EventTarget | null) =>
    node instanceof HTMLElement &&
    (node.classList.contains("knobs-number") || node.classList.contains("knobs-cell-edit"))
  root.addEventListener("focusin", (event) => {
    if (isEditField(event.target)) grab(event.target)
  })
  root.addEventListener("focusout", (event) => {
    if (isEditField(event.target)) setTimeout(letGo)
  })
  // --k-row-gap above 0 draws each row as its own bar (see .knobs-panel[data-rows]), and
  // --k-frame: flat draws groups as plain sections (see .knobs-panel[data-frame]).
  const syncRows = () => {
    const cs = getComputedStyle(root)
    const gap = parseFloat(cs.getPropertyValue("--k-row-gap")) || 0
    const want = gap > 0 ? "separate" : undefined
    if (root.dataset.rows !== want) {
      if (want) root.dataset.rows = want
      else delete root.dataset.rows
    }
    const frame = cs.getPropertyValue("--k-frame").trim() === "flat" ? "flat" : undefined
    if (root.dataset.frame !== frame) {
      if (frame) root.dataset.frame = frame
      else delete root.dataset.frame
      wakeGpu()
    }
    // A button fill or outline makes action rows and preset chips buttons (see [data-buttons]).
    const boxed =
      cs.getPropertyValue("--k-button-bg").trim() || cs.getPropertyValue("--k-button-line").trim()
    if (root.hasAttribute("data-buttons") !== Boolean(boxed)) {
      root.toggleAttribute("data-buttons", Boolean(boxed))
      wakeGpu()
    }
  }
  const rowsObserver = new MutationObserver(syncRows)
  rowsObserver.observe(root, {
    attributes: true,
    attributeFilter: ["style", "class", "data-theme", "data-preset", "data-density"],
  })
  // The frame and button looks are known before the first row is built, so nothing glides in.
  syncRows()
  layoutRows(false)
  const unsubscribe = controls.subscribe(update)
  const unlisten = readoutPort?.listen((key) => readouts.get(key)?.notify())
  // Readout canvases stay blank while the GPU overlay draws them, and repaint when it lets go.
  const gpuObserver = new MutationObserver(() => {
    for (const r of readouts.values()) r.view.refresh()
  })
  gpuObserver.observe(root, { attributes: true, attributeFilter: ["data-gpu-active"] })
  update()
  syncRows()
  positioned =
    !inline && options.anchor
      ? positionPanel(root, header, options.anchor, controls.id, () =>
          controls.persist === "all" ? controls.storage : null,
        )
      : undefined
  const restoreFocus = () => {
    const at = session.focus
    if (at && at.inline === inline) stops()[at.stop]?.focus({ preventScroll: true })
  }
  if (inline || options.restored) restoreFocus()

  const reducedMotion = () =>
    doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false
  let morph: PanelMorph | undefined
  if (!inline && options.chip) {
    const reduced = reducedMotion()
    morph = morphFromChip(options.chip, root, () => wakeGpu(), Boolean(options.restored || reduced))
    if (!options.restored) {
      if (reduced)
        root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease-out" })
      else morph.open()
    }
  }

  const gpuBinding: GpuPanelBinding = {
    id: controls.id,
    root,
    body,
    inline,
    header,
    titleEl,
    headerButtons,
    headerDie: { button: randomButton, die },
    locks: lockIcons,
    presetStrip,
    tabs: tabStrip,
    groups: gpuGroups,
    cards,
    rows: gpuRows,
    actionButtons: gpuActionButtons,
    isPopoverOpen: () => !popover.hidden,
    morph: morph?.frame,
    presence: () => presenceRuns > 0 || shifting.size > 0,
    landing: () => "landing" in root.dataset,
    ...(layout
      ? {
          page: {
            tiles: gpuTiles,
            sections: () => layout!.sections,
            layoutKey: () => layoutTick,
            moving: () => layout!.moving,
            frame: (now: number) => layout!.frame(now),
            emphasis: (node: HTMLElement) => layout!.emphasis(node),
            ...(nav ? { nav } : {}),
          },
        }
      : {}),
  }
  let unregisterGpu: (() => void) | undefined
  const requestedMode = options.renderer ?? controls.renderer ?? "auto"
  // Inside an ancestor that makes a stacking context, an inline panel's DOM overlays (search,
  // inline editors) would stack under the page-level canvas: such a panel draws with the DOM
  // renderer, which looks the same.
  let trapped: HTMLElement | null | undefined
  const syncRendererMode = () => {
    let mode = resolveRendererMode(requestedMode, doc)
    if (mode === "gpu" && inline) {
      trapped ??= stackingAncestor(root)
      if (trapped) {
        mode = "dom"
        root.dataset.gpuTrapped = ""
      }
    }
    if (mode === "gpu") {
      if (!unregisterGpu) {
        const manager = getGpuOverlayManager(doc)
        wakeGpu = manager.wake
        unregisterGpu = manager.register(gpuBinding)
      }
    } else if (unregisterGpu) {
      unregisterGpu()
      unregisterGpu = undefined
      wakeGpu = () => {}
      root.dataset.renderer = "dom"
      const cur = controls.get()
      for (const r of rows) {
        const value = r.value(cur as Record<string, unknown>)
        if (r.slider) r.slider.update(Number(value), 0, true)
        else if (r.editor) r.editor.update(value as Value, 0, true)
      }
    } else {
      root.dataset.renderer = "dom"
    }
  }
  syncRendererMode()

  const modeObserver = new MutationObserver(() => {
    syncRendererMode()
    syncRows()
  })
  modeObserver.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["data-knobs-renderer", "data-theme", "style"],
  })

  const panel: Panel = {
    element: root,
    presetStrip,
    focus() {
      raise()
      ;(rows.find((r) => visible(r.input))?.input ?? dismiss ?? root).focus({ preventScroll: true })
    },
    dismiss() {
      if (root.dataset.leaving || morph?.closing) return
      root.style.pointerEvents = "none"
      const reduced = reducedMotion()
      if (morph && !reduced) {
        menu?.close(false)
        morph.close(() => panel.dispose())
        return
      }
      root.dataset.leaving = "true"
      root
        .animate(
          reduced
            ? [{ opacity: 1 }, { opacity: 0 }]
            : [
                { opacity: 1, transform: "none" },
                { opacity: 0, transform: "translateY(3px) scale(.985)" },
              ],
          { duration: 120, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" },
        )
        .finished.then(
          () => panel.dispose(),
          () => panel.dispose(),
        )
    },
    updateAccessories() {
      for (const r of rows) fillAccessory(r)
    },
    fold(group, folded) {
      fold(group, folded ?? !folds.get(group))
    },
    tab(id) {
      if (id !== undefined) selectTab(id)
      return activeTab
    },
    search(query, chips) {
      if (!search) return undefined
      search.set(query, chips)
      return { query: search.input.value, chips: [...search.active()] }
    },
    reopen() {
      if (!morph?.closing || !root.isConnected) return false
      root.style.pointerEvents = ""
      morph.open()
      return true
    },
    dispose() {
      for (const type of ["pointerup", "pointercancel"])
        doc.removeEventListener(type, pressEnded, true)
      clearTimeout(statusTimer)
      clearTimeout(nudgeEnd)
      for (const k of inHand) controls.hold(k, false)
      inHand.clear()
      clearTimeout(copiedTimer)
      for (const t of peekTimers.values()) clearTimeout(t)
      for (const r of [...rows, ...leavingRows]) dropGpu(r)
      for (const c of groupChips.values()) c.dispose()
      presetStrip.dispose()
      tabStrip.dispose()
      doc.removeEventListener("keydown", onGlobalKey)
      layout?.dispose()
      tileSizes.disconnect()
      headSize.disconnect()
      win?.removeEventListener("scroll", onScroll)
      win?.removeEventListener("scrollend", onScrollEnd)
      for (const type of ["wheel", "touchstart", "keydown"])
        doc.removeEventListener(type, touched, true)
      doc.removeEventListener("pointerdown", onPointerDown, true)
      for (const type of ["pointerup", "pointercancel"])
        doc.removeEventListener(type, onPointerUp, true)
      for (const type of ["pointerup", "pointercancel"])
        doc.removeEventListener(type, endScrub, true)
      doc.defaultView?.removeEventListener("blur", endScrub)
      endScrub()
      unregisterHints?.()
      hintCtrl.stop()
      modeObserver.disconnect()
      unregisterGpu?.()
      unsubscribe()
      unlisten?.()
      rowsObserver.disconnect()
      gpuObserver.disconnect()
      doc.defaultView?.cancelAnimationFrame(landTimer)
      for (const k of inHand) controls.hold(k, false)
      inHand.clear()
      positioned?.dispose()
      die.dispose()
      for (const g of groupDice.values()) g.die.dispose()
      menu?.close(false)
      doc.removeEventListener("keyup", endCompare, true)
      doc.defaultView?.removeEventListener("blur", endCompare)
      controls.compare(false)
      morph?.dispose()
      untrackHas()
      unsubscribeSound()
      optionKeys.dispose()
      root.remove()
    },
  }
  if (!layout) return panel
  const pageLayout = layout
  built = true
  const pageApi: Page = Object.assign(panel, {
    card(cardOptions: PageCardOptions) {
      const section = cardOptions.section ?? ""
      const card = createCustomCard(doc, cardOptions, {
        wake: () => wakeGpu(),
        resize: (tile, from) => pageLayout.resize(tile, from),
        title: (title) =>
          options.groupLabels?.[title] ??
          (section ? cardTitle(title, [section, sectionTitle(section)]) : title),
        folded: {
          // Custom cards keep their folds per tab, with the rest of the session.
          get: (title: string) => (remember ? readSession(controls.id).folded?.[title] : undefined),
          set: (title: string, folded: boolean) => {
            if (remember)
              writeSession(controls.id, {
                folded: { ...readSession(controls.id).folded, [title]: folded },
              })
            for (const c of auto.cards) if (c.tile.dataset.card === title) auto.cards.delete(c)
          },
        },
        register: (fold) => customFolds.add(fold),
        remove: (tile) => {
          tileSizes.unobserve(tile)
          for (const c of customFolds) if (c.tile === tile) customFolds.delete(c)
          pageLayout.remove(tile)
          pageLayout.pack(true)
          refreshFolds()
        },
      })
      pageLayout.add(card.element, cardOptions.section ?? "")
      tileSizes.observe(card.element)
      if (filterEl.value) applyFilter()
      else pageLayout.pack(true)
      refreshFolds()
      return card
    },
    highlight(
      target: PageHighlight | null,
      highlightOptions?: { readonly reveal?: boolean; readonly expand?: boolean },
    ) {
      const groups = new Set(target?.groups ?? [])
      const named = new Set(target?.sections ?? [])
      const tileLit = (tile: HTMLElement) =>
        groups.has(tile.dataset.group ?? tile.dataset.card ?? "\u0000") ||
        named.has(pageLayout.sectionOf(tile) ?? "\u0000")
      const sectionLit = (name: string) =>
        named.has(name) ||
        Boolean(
          pageLayout
            .sectionList()
            .find((s) => s.name === name)
            ?.tiles.some(tileLit),
        )
      // The context moved on: what the last highlight opened folds again, unless it's theirs.
      for (const name of [...auto.sections])
        if (!sectionLit(name)) {
          auto.sections.delete(name)
          foldSection(name, true, { remember: false })
        }
      for (const group of [...auto.groups]) {
        const tile = tiles.get(group)?.parentElement
        if (tile && tileLit(tile)) continue
        auto.groups.delete(group)
        fold(group, true, true, false)
      }
      for (const card of [...auto.cards])
        if (!tileLit(card.tile)) {
          auto.cards.delete(card)
          card.fold(true, false)
        }
      pageLayout.highlight(target)
      if (target && highlightOptions?.expand) {
        for (const s of pageLayout.sectionList())
          if (s.folded && pageLayout.isFoldable(s.name) && sectionLit(s.name)) {
            foldSection(s.name, false, { remember: false })
            auto.sections.add(s.name)
          }
        for (const [group, shut] of folds) {
          const tile = tiles.get(group)?.parentElement
          if (!shut || !tile || !tileLit(tile)) continue
          fold(group, false, true, false)
          auto.groups.add(group)
        }
        for (const card of customFolds)
          if (card.collapsible && card.folded && tileLit(card.tile)) {
            card.fold(false, false)
            auto.cards.add(card)
          }
      }
      if (target && highlightOptions?.reveal) revealHighlight()
    },
    fold(group: string, folded?: boolean, foldOptions?: PageFoldOptions) {
      const next = folded ?? !folds.get(group)
      fold(group, next, true, foldOptions?.remember ?? true)
      const tile = tiles.get(group)?.parentElement
      if (foldOptions?.reveal && tile) glideTo(tile)
    },
    foldSection(section: string, folded?: boolean, foldOptions?: PageFoldOptions) {
      const next = folded ?? !sectionState(section)
      foldSection(section, next, { remember: foldOptions?.remember ?? true })
      const head = pageLayout.sectionList().find((s) => s.name === section)?.label
      if (foldOptions?.reveal && head) glideTo(head)
    },
    sectionFolded(section: string) {
      return sectionState(section)
    },
    reveal(
      target: { readonly section: string } | { readonly group: string },
      revealOptions?: { readonly remember?: boolean },
    ) {
      revealTarget(target, revealOptions?.remember ?? false)
    },
    sections: () => describeSections(),
    activeSection() {
      return navForced ?? sectionInView()
    },
    onSections(
      listener: (sections: readonly PageSectionInfo[], source: PageFoldSource | null) => void,
    ) {
      sectionListeners.add(listener)
      // The first call says what's there now; later ones, what changed.
      queueMicrotask(() => {
        if (!sectionListeners.has(listener)) return
        const list = describeSections()
        if (sectionListeners.size === 1) lastSections = JSON.stringify(list)
        listener(list, null)
      })
      return () => void sectionListeners.delete(listener)
    },
    onActiveSection(listener: (section: string | undefined) => void) {
      if (!activeListeners.size && !nav) activeSectionId = undefined
      activeListeners.add(listener)
      trackSection()
      return () => void activeListeners.delete(listener)
    },
  })
  /** Opens a section (or a group and its section) and glides it into view. */
  function revealTarget(
    target: { readonly section: string } | { readonly group: string },
    remember: boolean,
  ) {
    const tile = ("group" in target && tiles.get(target.group)?.parentElement) || undefined
    const section = "section" in target ? target.section : tile && pageLayout.sectionOf(tile)
    if (section !== undefined && pageLayout.isFoldable(section) && pageLayout.isFolded(section))
      foldSection(section, false, { remember })
    if ("group" in target && folds.get(target.group)) fold(target.group, false, true, remember)
    const node =
      tile ?? pageLayout.sectionList().find((s) => s.name === section)?.label ?? undefined
    if (!node) return
    if (section !== undefined) {
      navForced = section
      trackSection()
    }
    glideTo(node)
    wakeGpu()
  }
  /** Glides the first highlighted card (or heading) into view, unless the user is busy here. */
  function revealHighlight(again?: HTMLElement, tries = 0) {
    if (!win) return
    const recent = performance.now() - touchedAt < REVEAL_QUIET_MS
    if (recent || pointersDown > 0 || html.hasAttribute("data-knobs-scrub")) return
    const first = again ?? pageLayout.highlighted()[0]
    if (!first?.isConnected) return
    const headBottom = header.getBoundingClientRect().bottom
    const r = pageLayout.settled(first)
    const margin = 12
    // Already in view (its top showing with room below it): leave the page where it is. After a
    // glide, only a target that moved meanwhile (content above it settling) is followed.
    if (
      again
        ? Math.abs(r.top - headBottom - margin) < 1.5
        : r.top >= headBottom && r.top <= win.innerHeight - Math.min(160, win.innerHeight / 3)
    )
      return
    const goal = Math.max(
      0,
      Math.min(
        r.top + win.scrollY - headBottom - margin,
        doc.documentElement.scrollHeight - win.innerHeight,
      ),
    )
    if (Math.abs(goal - win.scrollY) < 1) return
    scrollGoal = goal
    const still = win.matchMedia("(prefers-reduced-motion: reduce)").matches
    win.scrollTo({ top: goal, behavior: still ? "auto" : "smooth" })
    if (tries < 2)
      win.addEventListener("scrollend", () => revealHighlight(first, tries + 1), { once: true })
  }
  return pageApi
}

export function createPanel<S extends Schema>(
  controls: Controls<S>,
  anchor: HTMLElement,
  close: () => void,
  options?: MountPanelOptions & { readonly restored?: boolean; readonly chip?: HTMLElement },
): Panel {
  return buildPanel(controls, anchor.ownerDocument.body, {
    ...options,
    inline: false,
    anchor,
    close,
  })
}

export function mountPanel<S extends Schema>(
  controls: Controls<S>,
  container: HTMLElement,
  options?: MountPanelOptions,
): Panel {
  return buildPanel(controls, container, {
    ...options,
    inline: true,
  })
}

/**
 * A full page of controls: sections of group cards in balanced columns under a sticky header
 * (title, presets, Random, Reset, Copy, undo and redo). Groups show their numbered presets;
 * `page.card()` adds cards of your own.
 */
export function mountPage<S extends Schema>(
  controls: Controls<S>,
  container: HTMLElement,
  options: MountPageOptions = {},
): Page {
  return buildPanel(controls, container, { ...options, inline: true, page: options }) as Page
}
